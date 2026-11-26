(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;

  // Kept in closure scope for compatibility with verify.js hooks
  var GLOBAL_ACTIVE = 0;
  var GLOBAL_PAUSED = false;
  var GLOBAL_SCHEDULING = false;
  var BG_TASKS = [];
  var BG_TASKS_VERSION = 0;
  var BG_TASKS_CACHE_VER = -1;
  var BG_TASKS_CACHE_LEN = -1;
  var BG_TASKS_CACHE_COUNTS = { ordinary: 0, heavy: 0 };

  // Coalesced scheduler & P3 background pacing timers
  var scheduleRequested = false;
  var schedulePendingReason = '';
  var scheduleCancelFn = null;
  var viewportSlotWakeTimer = null;
  var p3PacingTimer = null;
  var lastP3DispatchAt = 0;
  var preemptWakeTimer = null;
  var preemptWakeDueAt = 0;

  // 4-Tier Priority Scheduler State
  // P0: Manual retries & hovered/focused thread priority boost
  // P1: Visible (band === 0) first-screen & user-expanded thumbnails (round-robin across visible threads)
  // P2: Near-viewport (band === 1, <= 480px) prefetch thumbnails
  // P3: Prefetch/offscreen (band >= 2, <= 1500px or autoLoadOffscreenFirstRowsEnabled) background thumbnails
  var MANUAL_IMAGE_RETRIES = [];
  var MANUAL_IMAGE_RETRY_LIMIT = 32;
  var HOVERED_THREAD_ID = '';
  var FOCUSED_THREAD_ID = '';
  var p1CursorThreadId = '';
  var p2CursorThreadId = '';
  var p3CursorThreadId = '';
  var fallbackInitialVisibleCount = 3;

  // Deferred heavy threads when heavy host circuit breaker is 'open'
  var DEFERRED_HEAVY_THREADS = Object.create(null);
  var DEFERRED_HEAVY_THREAD_TIMERS = Object.create(null);

  // Event delegation & DOM tracking
  var WRAPPER_TASK_MAP = typeof WeakMap === 'function' ? new WeakMap() : new Map();
  var FAILED_WRAPPERS = new Set();
  var GIF_WRAPPERS = new Set();
  var STILL_FRAME_QUEUE = [];
  var STILL_FRAME_TIMER = null;

  var GLOBAL_VIS_LISTENER = null;
  var HIDDEN_PAUSE_CANCEL_REASON = 'hidden_pause';

  // Thread status batching
  var pendingThreadStatuses = new Set();
  var threadStatusFrame = null;
  var threadStatusTimer = null;

  // Diagnostics (strictly gated behind debugLogging === true)
  var LOG_THROTTLE = Object.create(null);
  var DIAGNOSTIC_SUMMARY = null;
  var DIAGNOSTIC_SUMMARY_TIMER = null;
  var DIAGNOSTIC_SUMMARY_INTERVAL_MS = 2000;

  function syncLegacyActiveCounter() {
    GLOBAL_ACTIVE = root.ATPHostHealth ? ATPHostHealth.getGlobalActive() : 0;
    return GLOBAL_ACTIVE;
  }

  function getCurrentSettings() {
    return (root.ATPState && root.ATPState.settings) || {};
  }

  function getThreadState(threadId) {
    var threads = root.ATPState && root.ATPState.threads;
    return threads && threadId ? threads[threadId] : null;
  }

  function isThreadCurrent(ts) {
    if (!ts) return false;
    var currentGen = root.ATPState && typeof root.ATPState.generation === 'number'
      ? root.ATPState.generation
      : ts.generation;
    if (typeof ts.generation === 'number' && typeof currentGen === 'number' && ts.generation !== currentGen) {
      return false;
    }
    if (typeof document !== 'undefined' && document.contains) {
      if (ts.panel && !document.contains(ts.panel)) return false;
      if (ts.container && !document.contains(ts.container)) return false;
    }
    return true;
  }

  function isTaskCurrent(task) {
    if (!task || !task.threadId) return false;
    var ts = getThreadState(task.threadId);
    if (!isThreadCurrent(ts)) return false;
    if (typeof task.generation === 'number' && typeof ts.generation === 'number' && task.generation !== ts.generation) {
      return false;
    }
    return true;
  }

  // --- Candidate & URL Helpers ---

  function getCandidateDisplaySrc(imgData) {
    if (!imgData) return '';
    if (typeof SharedUtils !== 'undefined' && SharedUtils && SharedUtils.getImageDisplaySrc) {
      return SharedUtils.getImageDisplaySrc(imgData) || '';
    }
    return imgData.displaySrc || imgData.src || '';
  }

  function getCandidatePreviewSrc(imgData) {
    if (!imgData) return '';
    if (typeof SharedUtils !== 'undefined' && SharedUtils && SharedUtils.getImagePreviewSrc) {
      return SharedUtils.getImagePreviewSrc(imgData) || '';
    }
    return imgData.previewSrc || imgData.src || '';
  }

  function getTaskImageData(task) {
    return task && task.candidates ? task.candidates[task.idx] : null;
  }

  function getTaskImageSrc(task) {
    return getCandidateDisplaySrc(getTaskImageData(task));
  }

  function getTaskPreviewSrc(task) {
    return getCandidatePreviewSrc(getTaskImageData(task));
  }

  function getTaskPreviewIndex(task) {
    var imgData = getTaskImageData(task);
    var ts = imgData && typeof imgData.previewIndex === 'number' ? getThreadState(task.threadId) : null;
    return ts && ts.heavyMode && ts.sourceCandidates ? imgData.previewIndex : (task ? task.idx : 0);
  }

  function buildPreviewUrls(candidates) {
    var urls = [];
    candidates = candidates || [];
    for (var i = 0; i < candidates.length; i++) {
      urls.push(getCandidatePreviewSrc(candidates[i]));
    }
    return urls;
  }

  function withSiblingHostPreviews(ts, list) {
    var shown = ts && ts.candidates;
    if (!shown || !list || shown === list) return list;
    var out = null;
    for (var i = 0; i < shown.length; i++) {
      var candidate = shown[i];
      if (!candidate || !candidate.siblingHostFrom) continue;
      var at = typeof candidate.previewIndex === 'number' ? candidate.previewIndex : i;
      if (at < 0 || at >= list.length || list[at] === candidate) continue;
      if (!out) out = list.slice();
      out[at] = candidate;
    }
    return out || list;
  }

  function getBasePreviewCandidates(ts) {
    if (!ts) return [];
    return ts.heavyMode && ts.sourceCandidates ? ts.sourceCandidates : (ts.candidates || []);
  }

  function getPreviewCandidates(ts) {
    return withSiblingHostPreviews(ts, getBasePreviewCandidates(ts));
  }

  function getPreviewActivationLabel(task) {
    var ts = getThreadState(task && task.threadId);
    var previewCandidates = getBasePreviewCandidates(ts);
    var total = previewCandidates.length || (ts && ts.total) || 0;
    var index = task ? getTaskPreviewIndex(task) : -1;
    if (typeof index !== 'number' || !isFinite(index) || index < 0) return '打开图片预览';
    if (total > 0) return '打开第 ' + Math.min(index + 1, total) + ' 张图片预览，共 ' + total + ' 张';
    return '打开第 ' + (index + 1) + ' 张图片预览';
  }

  function shortUrl(url) {
    return String(url || '').substring(0, 180);
  }

  function getUrlHost(url) {
    return root.ATPHostHealth ? ATPHostHealth.getUrlHost(url) : '';
  }

  function isHeavyChannelTask(task, settings) {
    return root.ATPHostHealth ? ATPHostHealth.isHeavyChannelTask(task, settings || getCurrentSettings()) : false;
  }

  function isHeavyChannelSrc(src, settings) {
    return root.ATPHostHealth ? ATPHostHealth.isHeavyChannelSrc(src, settings || getCurrentSettings()) : false;
  }

  function isLargeLaneTask(task) {
    return root.ATPHostHealth ? ATPHostHealth.isLargeLaneTask(task) : false;
  }

  function getOrdinaryHostStats(host, create) {
    return root.ATPHostHealth ? ATPHostHealth.getOrdinaryHostStats(host, create) : null;
  }

  function noteLargeLaneOutcome(task, url, elapsedMs, timedOut, ordinaryConc) {
    return root.ATPHostHealth
      ? ATPHostHealth.noteLargeLaneOutcome(task, url, elapsedMs, timedOut, ordinaryConc || ATPLoader.getConc())
      : false;
  }

  function getOrdinaryHostHealthSnapshot(src, totalLimit, task) {
    return root.ATPHostHealth
      ? ATPHostHealth.getOrdinaryHostHealthSnapshot(src, totalLimit || ATPLoader.getConc(), task)
      : null;
  }

  function isHighFanoutImageHost(url) {
    return root.ATPHostHealth ? ATPHostHealth.isHighFanoutImageHost(url) : false;
  }

  function isPriorityImageTask(task) {
    return !!(task && (
      task.manualRetry ||
      task.currentlyVisible === true ||
      (task.currentlyVisible === undefined && task.viewportPriority === true)
    ));
  }

  // --- Debug-Gated Diagnostics (Zero Ring Buffer / Summary Overhead When debugLogging !== true) ---

  function isDebugTelemetryEnabled() {
    var settings = getCurrentSettings();
    if (typeof Logger === 'undefined' || !Logger) return false;
    if (typeof Logger.isEnabled === 'function') return Logger.isEnabled('DEBUG');
    return settings ? settings.debugLogging !== false : true;
  }

  function isDiagnosticLoggingEnabled(level) {
    level = level || 'DEBUG';
    if (level === 'DEBUG') return isDebugTelemetryEnabled();
    if (typeof Logger === 'undefined' || !Logger) return false;
    return typeof Logger.isEnabled === 'function' ? Logger.isEnabled(level) : true;
  }

  function createDiagnosticSummary() {
    return {
      startedAt: Date.now(),
      counts: {},
      reasons: {},
      hosts: {},
      channels: {},
      hostStats: {},
      visibleWaitStats: { done: 0, totalMs: 0, maxMs: 0, samples: [], sampleOffset: 0 },
      unloadReasons: {},
      maxActive: 0,
      maxOrdinaryActive: 0,
      maxHeavyActive: 0,
      maxOrdinaryHostLargeActive: 0
    };
  }

  function recordDiagnosticEvent(type, fields) {
    if (!isDebugTelemetryEnabled()) return;
    var summary = DIAGNOSTIC_SUMMARY || (DIAGNOSTIC_SUMMARY = createDiagnosticSummary());
    fields = fields || {};
    summary.counts[type] = (summary.counts[type] || 0) + 1;
    var reason = fields.reason || type;
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
    if (fields.host) summary.hosts[fields.host] = (summary.hosts[fields.host] || 0) + 1;
    if (fields.channel) summary.channels[fields.channel] = (summary.channels[fields.channel] || 0) + 1;
    summary.maxActive = Math.max(summary.maxActive, Number(fields.active) || 0);
    summary.maxOrdinaryActive = Math.max(summary.maxOrdinaryActive, Number(fields.ordinaryActive) || 0);
    summary.maxHeavyActive = Math.max(summary.maxHeavyActive, Number(fields.heavyActive) || 0);
    var hostLargePeak = root.ATPHostHealth && ATPHostHealth.getMaxHostLargeActive ? ATPHostHealth.getMaxHostLargeActive() : 0;
    summary.maxOrdinaryHostLargeActive = Math.max(
      summary.maxOrdinaryHostLargeActive,
      Number(fields.ordinaryHostLargeActive) || 0,
      hostLargePeak
    );
    if (type === 'image_done' && fields.ms !== undefined) {
      var hKey = (fields.largeImage ? 'gif:' : '') + (fields.host || 'unknown');
      var hs = summary.hostStats[hKey] || (summary.hostStats[hKey] = { done: 0, fail: 0, totalMs: 0, maxMs: 0, samples: [], sampleOffset: 0 });
      var ms = Number(fields.ms) || 0;
      hs.done++;
      if (fields.ok === false) hs.fail++;
      hs.totalMs += ms;
      if (ms > hs.maxMs) hs.maxMs = ms;
      if (hs.samples.length < 80) hs.samples.push(ms);
      else {
        hs.samples[hs.sampleOffset] = ms;
        hs.sampleOffset = (hs.sampleOffset + 1) % 80;
      }
    }
    if (!DIAGNOSTIC_SUMMARY_TIMER) {
      DIAGNOSTIC_SUMMARY_TIMER = setTimeout(function () {
        DIAGNOSTIC_SUMMARY_TIMER = null;
        flushDiagnosticSummary('interval');
      }, DIAGNOSTIC_SUMMARY_INTERVAL_MS);
    }
  }

  function flushDiagnosticSummary(reason) {
    if (DIAGNOSTIC_SUMMARY_TIMER) {
      clearTimeout(DIAGNOSTIC_SUMMARY_TIMER);
      DIAGNOSTIC_SUMMARY_TIMER = null;
    }
    var summary = DIAGNOSTIC_SUMMARY;
    DIAGNOSTIC_SUMMARY = null;
    var hostLargePeak = root.ATPHostHealth && ATPHostHealth.getMaxHostLargeActive ? ATPHostHealth.getMaxHostLargeActive() : 0;
    if (root.ATPHostHealth && ATPHostHealth.resetMaxHostLargeActive) ATPHostHealth.resetMaxHostLargeActive();
    if (!summary || !isDebugTelemetryEnabled() || typeof Logger === 'undefined' || !Logger.event) return;
    Logger.event('diagnostic_summary', {
      reason: reason || 'manual',
      windowMs: Math.max(0, Date.now() - summary.startedAt),
      counts: summary.counts,
      reasons: summary.reasons,
      hosts: summary.hosts,
      channels: summary.channels,
      hostTiming: summary.hostStats,
      maxActive: summary.maxActive,
      maxOrdinaryActive: summary.maxOrdinaryActive,
      maxHeavyActive: summary.maxHeavyActive,
      maxOrdinaryHostLargeActive: Math.max(summary.maxOrdinaryHostLargeActive || 0, hostLargePeak)
    });
  }

  function logEventThrottled(key, type, fields, intervalMs, level) {
    level = level || 'DEBUG';
    if (!isDiagnosticLoggingEnabled(level)) return;
    intervalMs = intervalMs || 3000;
    var now = Date.now();
    var state = LOG_THROTTLE[key] || { last: 0, suppressed: 0 };
    if (now - state.last < intervalMs) {
      state.suppressed++;
      LOG_THROTTLE[key] = state;
      return;
    }
    var payload = typeof fields === 'function' ? fields() : Object.assign({}, fields || {});
    if (!payload) return;
    if (state.suppressed) payload.suppressed = state.suppressed;
    state.last = now;
    state.suppressed = 0;
    LOG_THROTTLE[key] = state;
    recordDiagnosticEvent(type, payload);
    if (typeof Logger !== 'undefined' && Logger && Logger.event) {
      Logger.event(type, payload, level);
    }
  }

  function logImageEvent(type, task, fields, level) {
    level = level || 'DEBUG';
    if (!isDiagnosticLoggingEnabled(level)) return;
    var src = getTaskImageSrc(task);
    var active = syncLegacyActiveCounter();
    var heavyActive = root.ATPHostHealth ? ATPHostHealth.getGlobalHeavyActive() : 0;
    var payload = Object.assign({
      threadId: task && task.threadId,
      idx: task && task.idx,
      host: getUrlHost(src),
      channel: isHeavyChannelTask(task) ? 'heavy' : 'ordinary',
      url: shortUrl(src),
      active: active,
      ordinaryActive: Math.max(0, active - heavyActive),
      heavyActive: heavyActive
    }, fields || {});
    recordDiagnosticEvent(type, payload);
    if (typeof Logger !== 'undefined' && Logger && Logger.event) {
      Logger.event(type, payload, level);
    }
  }

  function logImageDone(task, ok, reason, extra) {
    var ms = task && task.loadStartAt ? Math.max(0, Date.now() - task.loadStartAt) : undefined;
    if (!isDebugTelemetryEnabled()) {
      if (!ok && typeof Logger !== 'undefined' && Logger && Logger.event) {
        var src = getTaskImageSrc(task);
        Logger.event('image_failure', {
          reason: reason || 'failed',
          host: getUrlHost(src),
          url: shortUrl(src),
          threadId: task && task.threadId,
          idx: task && task.idx,
          queueKind: task && task.queueKind,
          ms: ms
        }, 'WARN');
      }
      return;
    }
    var afterRelease = root.ATPHostHealth ? ATPHostHealth.getActiveAfterReleaseFields(task) : {};
    logImageEvent('image_done', task, Object.assign({
      ok: !!ok,
      reason: reason || (ok ? 'loaded' : 'failed'),
      ms: ms,
      largeImage: isLargeLaneTask(task) || undefined
    }, afterRelease, extra || {}));
  }

  function getImageMetrics(img) {
    var nw = (img && img.naturalWidth) || 0;
    var nh = (img && img.naturalHeight) || 0;
    return {
      naturalWidth: nw,
      naturalHeight: nh,
      decodedMP: nw && nh ? Math.round((nw * nh) / 100000) / 10 : 0,
      displayWidth: 0,
      displayHeight: 0
    };
  }

  // --- First-Screen Timing Accounting ---

  function isFirstScreenHiddenPause() {
    var settings = getCurrentSettings();
    return typeof document !== 'undefined' &&
      document.visibilityState !== 'visible' &&
      settings.pauseWhenHidden !== false;
  }

  function advanceFirstScreenTaskTiming(timing, now) {
    if (!timing || timing.settledAt !== null) return;
    now = Math.max(timing.lastAt, now);
    var elapsed = now - timing.lastAt;
    if (timing.paused) timing.hiddenPauseMs += elapsed;
    else if (timing.phase === 'request') timing.requestMs += elapsed;
    else {
      timing.queueWaitMs += elapsed;
      if (timing.viewportWaiting) timing.viewportWaitMs += elapsed;
    }
    timing.lastAt = now;
  }

  function ensureFirstScreenTaskTiming(task, ts) {
    if (!task || !task.isFirstScreen || task.firstScreenSettled) return null;
    if (task.firstScreenTiming) return task.firstScreenTiming;
    ts = ts || getThreadState(task.threadId);
    if (!ts || ts.firstScreenDone) return null;
    var now = Date.now();
    var createdAt = typeof task.createdAt === 'number' && isFinite(task.createdAt)
      ? Math.min(now, task.createdAt) : now;
    var timing = task.firstScreenTiming = {
      startedAt: createdAt, lastAt: createdAt, settledAt: null,
      phase: 'queue', paused: isFirstScreenHiddenPause(), viewportWaiting: false,
      queueWaitMs: 0, hiddenPauseMs: 0, requestMs: 0, viewportWaitMs: 0,
      requestCount: 0, hiddenInterruptions: 0, usedViewport: false
    };
    var summary = ts.firstScreenTiming;
    if (!summary) {
      summary = ts.firstScreenTiming = {
        startedAt: createdAt, tasks: [], settledTasks: 0,
        queueWaitTotalMs: 0, hiddenPauseTotalMs: 0, requestTotalMs: 0,
        viewportWaitTotalMs: 0, taskElapsedTotalMs: 0,
        maxQueueWaitMs: 0, maxViewportWaitMs: 0, maxQueueWaitExcludingViewportMs: 0,
        maxHiddenPauseMs: 0, maxRequestMs: 0,
        requestCount: 0, hiddenInterruptions: 0, viewportParkedTasks: 0,
        logged: false
      };
    }
    summary.startedAt = Math.min(summary.startedAt, createdAt);
    summary.tasks.push(task);
    return timing;
  }

  function registerFirstScreenTiming(ts) {
    if (!ts || ts.firstScreenDone) return;
    var firstTasks = ts.firstTasks || [];
    for (var i = 0; i < firstTasks.length; i++) {
      ensureFirstScreenTaskTiming(firstTasks[i], ts);
    }
  }

  function setFirstScreenTimingHiddenPause(paused) {
    var threads = (root.ATPState && root.ATPState.threads) || {};
    var now = Date.now();
    for (var tid in threads) {
      if (!Object.prototype.hasOwnProperty.call(threads, tid)) continue;
      var ts = threads[tid];
      if (!ts || ts.firstScreenDone) continue;
      registerFirstScreenTiming(ts);
      var tasks = (ts.firstScreenTiming && ts.firstScreenTiming.tasks) || [];
      for (var i = 0; i < tasks.length; i++) {
        var timing = tasks[i].firstScreenTiming;
        if (!timing || timing.settledAt !== null || timing.paused === paused) continue;
        advanceFirstScreenTaskTiming(timing, now);
        if (paused && timing.phase === 'request') timing.hiddenInterruptions++;
        timing.paused = paused;
      }
    }
  }

  function noteFirstScreenViewportWait(task) {
    var timing = ensureFirstScreenTaskTiming(task);
    if (!timing) return;
    advanceFirstScreenTaskTiming(timing, Date.now());
    timing.viewportWaiting = true;
    timing.usedViewport = true;
  }

  function noteFirstScreenRequestStart(task) {
    if (task) task.loadStartAt = Date.now();
    var timing = ensureFirstScreenTaskTiming(task);
    if (!timing) return;
    advanceFirstScreenTaskTiming(timing, Date.now());
    timing.phase = 'request';
    timing.viewportWaiting = false;
    timing.requestCount++;
  }

  function noteFirstScreenRequestEnd(task) {
    var timing = task && task.firstScreenTiming;
    if (!timing || timing.settledAt !== null) return;
    advanceFirstScreenTaskTiming(timing, Date.now());
    timing.phase = 'queue';
  }

  function settleFirstScreenTaskTiming(task, ts) {
    var timing = ensureFirstScreenTaskTiming(task, ts);
    if (!timing || timing.settledAt !== null) return;
    advanceFirstScreenTaskTiming(timing, Date.now());
    timing.settledAt = timing.lastAt;
    var summary = ts.firstScreenTiming;
    summary.settledTasks++;
    summary.taskElapsedTotalMs += timing.settledAt - timing.startedAt;
    summary.queueWaitTotalMs += timing.queueWaitMs;
    summary.hiddenPauseTotalMs += timing.hiddenPauseMs;
    summary.requestTotalMs += timing.requestMs;
    summary.viewportWaitTotalMs += timing.viewportWaitMs;
    summary.maxQueueWaitMs = Math.max(summary.maxQueueWaitMs, timing.queueWaitMs);
    summary.maxViewportWaitMs = Math.max(summary.maxViewportWaitMs, timing.viewportWaitMs);
    summary.maxQueueWaitExcludingViewportMs = Math.max(
      summary.maxQueueWaitExcludingViewportMs,
      timing.queueWaitMs - timing.viewportWaitMs
    );
    summary.maxHiddenPauseMs = Math.max(summary.maxHiddenPauseMs, timing.hiddenPauseMs);
    summary.maxRequestMs = Math.max(summary.maxRequestMs, timing.requestMs);
    summary.requestCount += timing.requestCount;
    summary.hiddenInterruptions += timing.hiddenInterruptions;
    if (timing.usedViewport) summary.viewportParkedTasks++;
    summary.lastTaskIdx = task.idx;
    summary.lastTaskElapsedMs = timing.settledAt - timing.startedAt;
    summary.lastTaskStartAt = timing.startedAt;
    summary.lastTaskQueueWaitMs = timing.queueWaitMs;
    summary.lastTaskViewportWaitMs = timing.viewportWaitMs;
    summary.lastTaskHiddenPauseMs = timing.hiddenPauseMs;
    summary.lastTaskRequestMs = timing.requestMs;
  }

  function logFirstScreenTiming(ts, threadId) {
    var summary = ts && ts.firstScreenTiming;
    if (!summary || summary.logged) return null;
    summary.logged = true;
    var fields = {
      threadId: threadId,
      firstScreenTotal: ts.firstScreenTotal,
      settledTasks: summary.settledTasks,
      ok: ts.firstScreenOk,
      failed: ts.firstScreenFailed,
      wallClockMs: Math.max(0, Date.now() - summary.startedAt),
      taskElapsedTotalMs: summary.taskElapsedTotalMs,
      queueWaitTotalMs: summary.queueWaitTotalMs,
      hiddenPauseTotalMs: summary.hiddenPauseTotalMs,
      requestTotalMs: summary.requestTotalMs,
      viewportWaitTotalMs: summary.viewportWaitTotalMs,
      maxQueueWaitMs: summary.maxQueueWaitMs,
      maxViewportWaitMs: summary.maxViewportWaitMs,
      maxQueueWaitExcludingViewportMs: summary.maxQueueWaitExcludingViewportMs,
      maxHiddenPauseMs: summary.maxHiddenPauseMs,
      maxRequestMs: summary.maxRequestMs,
      requestCount: summary.requestCount,
      hiddenInterruptions: summary.hiddenInterruptions,
      viewportParkedTasks: summary.viewportParkedTasks,
      lastTaskIdx: summary.lastTaskIdx,
      lastTaskStartOffsetMs: summary.lastTaskStartAt - summary.startedAt,
      lastTaskElapsedMs: summary.lastTaskElapsedMs,
      lastTaskQueueWaitMs: summary.lastTaskQueueWaitMs,
      lastTaskViewportWaitMs: summary.lastTaskViewportWaitMs,
      lastTaskHiddenPauseMs: summary.lastTaskHiddenPauseMs,
      lastTaskRequestMs: summary.lastTaskRequestMs,
      totalsBasis: 'parallel_task_sum',
      queueIncludes: 'scheduler_slot_host_offscreen_and_request_dispatch_wait',
      requestMeasurement: 'src_to_load_error_cancel_including_browser_queue_decode'
    };
    summary.tasks = null;
    summary.result = fields;
    if (isDiagnosticLoggingEnabled('INFO') && typeof Logger !== 'undefined' && Logger && Logger.event) {
      Logger.event('first_screen_timing', fields, 'INFO');
    }
    return fields;
  }

  // --- Candidate Fallback Selection (Ordinary & Heavy + Deep Heavy Rescue) ---

  function getCandidateFallbackLimit(ts) {
    var settings = getCurrentSettings();
    if (ts && ts.heavyMode) return ATPLoadPolicy.getHeavyFallbackLimit(settings);
    return ATPLoadPolicy.getOrdinaryFallbackLimit(settings);
  }

  function getActiveCandidateKeySet(ts) {
    var list = ts.candidates || [];
    if (!ts.__activeCandidateKeys || ts.__activeCandidateKeysLen !== list.length) {
      var set = new Set();
      for (var i = 0; i < list.length; i++) {
        var active = getCandidatePreviewSrc(list[i]);
        if (active && typeof SharedUtils !== 'undefined' && SharedUtils.normalizeImageUrl) {
          set.add(SharedUtils.normalizeImageUrl(active));
        } else if (active) {
          set.add(active);
        }
      }
      ts.__activeCandidateKeys = set;
      ts.__activeCandidateKeysLen = list.length;
    }
    return ts.__activeCandidateKeys;
  }

  function normalizeCandidateKey(src) {
    if (!src) return '';
    return typeof SharedUtils !== 'undefined' && SharedUtils && SharedUtils.normalizeImageUrl
      ? SharedUtils.normalizeImageUrl(src)
      : String(src);
  }

  function candidateAlreadyActive(ts, src) {
    return getActiveCandidateKeySet(ts).has(normalizeCandidateKey(src));
  }

  function markThreadFallbackCandidateUsed(ts, candidate, index) {
    if (!ts || !candidate) return;
    if (!ts.fallbackUsedIndexes) ts.fallbackUsedIndexes = Object.create(null);
    if (!ts.fallbackUsedUrls) ts.fallbackUsedUrls = Object.create(null);
    if (typeof index === 'number') ts.fallbackUsedIndexes[index] = true;
    var key = normalizeCandidateKey(getCandidatePreviewSrc(candidate));
    if (key) ts.fallbackUsedUrls[key] = true;
  }

  function markTaskFallbackCandidateTried(task, candidate, index) {
    if (!task || !candidate) return;
    if (!task.fallbackTriedIndexes) task.fallbackTriedIndexes = Object.create(null);
    if (!task.fallbackTriedUrls) task.fallbackTriedUrls = Object.create(null);
    if (typeof index === 'number') task.fallbackTriedIndexes[index] = true;
    var key = normalizeCandidateKey(getCandidatePreviewSrc(candidate));
    if (key) task.fallbackTriedUrls[key] = true;
  }

  function candidateAlreadyTried(ts, task, candidate, index) {
    var key = normalizeCandidateKey(getCandidatePreviewSrc(candidate));
    if (ts && ts.fallbackUsedIndexes && ts.fallbackUsedIndexes[index]) return true;
    if (key && ts && ts.fallbackUsedUrls && ts.fallbackUsedUrls[key]) return true;
    if (task && task.fallbackTriedIndexes && task.fallbackTriedIndexes[index]) return true;
    if (key && task && task.fallbackTriedUrls && task.fallbackTriedUrls[key]) return true;
    return false;
  }

  function getFallbackStartIndex(ts) {
    if (!ts) return 0;
    return typeof ts.fallbackIdx === 'number'
      ? ts.fallbackIdx
      : (typeof ts.heavyFallbackIdx === 'number' ? ts.heavyFallbackIdx : (ts.candidates ? ts.candidates.length : 0));
  }

  function setFallbackIndex(ts, idx) {
    ts.fallbackIdx = idx;
    ts.heavyFallbackIdx = idx;
  }

  function findFallbackCandidate(ts, startIdx, preferNonHighFanout, requireNonHighFanout) {
    var source = ts.sourceCandidates || [];
    function scan(from, ordinaryOnly) {
      for (var i = from; i < source.length; i++) {
        var c = source[i];
        var pSrc = getCandidatePreviewSrc(c);
        if (!c || !c.src || !pSrc || candidateAlreadyActive(ts, pSrc) || candidateAlreadyTried(ts, null, c, i)) continue;
        if (ordinaryOnly && isHighFanoutImageHost(pSrc)) continue;
        return { candidate: c, index: i };
      }
      return null;
    }
    if (preferNonHighFanout) {
      var ord = scan(startIdx, true) || scan(0, true);
      if (ord || requireNonHighFanout) return ord;
    }
    return scan(startIdx, false);
  }

  function findDeepHeavyRescueCandidate(ts, task, fallbackIdx, fallbackLimit) {
    var source = ts.sourceCandidates || [];
    var sourceTotal = source.length;
    var renderedTotal = Math.max(0, (ts.candidates || []).length);
    var span = sourceTotal - renderedTotal;
    if (span <= 0) return null;

    var slotCount = Math.max(1, Math.min(ts.firstScreenTotal || renderedTotal || 1, renderedTotal || 1));
    var slotIdx = Math.max(0, typeof task.idx === 'number' ? task.idx % slotCount : 0);
    var attempt = Math.max(1, (task.inlineFallbacks || 0) + 1);
    var steps = Math.max(1, (Number(fallbackLimit) || 1) - 1);
    var baseIndex = Math.max(renderedTotal, Math.min(fallbackIdx || renderedTotal, sourceTotal - 1));
    var deep = attempt > 1;
    var preferredIndex = baseIndex;
    if (deep) {
      var bandOffset = Math.floor((span - 1) * Math.min(steps, attempt - 1) / steps);
      preferredIndex = renderedTotal + bandOffset + slotIdx;
      if (preferredIndex >= sourceTotal) preferredIndex = Math.max(renderedTotal, sourceTotal - 1 - slotIdx);
    }

    var checked = Object.create(null);
    function tryIdx(idx) {
      idx = Math.floor(Number(idx));
      if (isNaN(idx) || idx < renderedTotal || idx >= sourceTotal || checked[idx]) return null;
      checked[idx] = true;
      var c = source[idx];
      var pSrc = getCandidatePreviewSrc(c);
      if (!c || !c.src || !pSrc || candidateAlreadyActive(ts, pSrc) || candidateAlreadyTried(ts, task, c, idx)) return null;
      return { candidate: c, index: idx, heavyDeepRescue: deep, sequentialFallbackIdx: fallbackIdx };
    }

    var probes = deep
      ? [preferredIndex, preferredIndex + slotCount, preferredIndex - slotCount, sourceTotal - 1 - slotIdx, renderedTotal + slotIdx, baseIndex]
      : [baseIndex];
    for (var p = 0; p < probes.length; p++) {
      var hit = tryIdx(probes[p]);
      if (hit) return hit;
    }
    for (var dist = slotCount; dist < span + slotCount; dist += slotCount) {
      var fwd = tryIdx(preferredIndex + dist);
      if (fwd) return fwd;
      var bwd = tryIdx(preferredIndex - dist);
      if (bwd) return bwd;
    }
    for (var s = renderedTotal; s < sourceTotal; s++) {
      var seq = tryIdx(s);
      if (seq) return seq;
    }
    return null;
  }

  function selectReplacementCandidateForTask(task) {
    if (!isTaskCurrent(task)) return null;
    var ts = getThreadState(task.threadId);
    if (!ts || !ts.sourceCandidates || !ts.candidates || ts.sourceCandidates.length <= ts.candidates.length) {
      return null;
    }
    var fallbackLimit = getCandidateFallbackLimit(ts);
    if ((task.inlineFallbacks || 0) >= fallbackLimit) return null;

    var fallbackIdx = getFallbackStartIndex(ts);
    var preferOrdinary = !!(ts.heavyMode && isHighFanoutImageHost(getTaskPreviewSrc(task)));
    var ordinaryAvailable = preferOrdinary && !!findFallbackCandidate(ts, fallbackIdx, true, true);
    var healthFields = (preferOrdinary && root.ATPHostHealth)
      ? ATPHostHealth.getHeavyHostHealthLogFields(task)
      : {};
    var heavyHostOpen = healthFields.heavyHostState === 'open';
    var allowHeavyRescue = preferOrdinary && !ordinaryAvailable && !heavyHostOpen;
    var requireOrdinary = preferOrdinary && !allowHeavyRescue;

    markTaskFallbackCandidateTried(task, getTaskImageData(task), getTaskPreviewIndex(task));

    var deepEligible = !!(allowHeavyRescue && fallbackLimit > 1 && ts.heavyMode && ts.lightweightHeavyMode &&
      (task.isFirstScreen || task.manualRetry));
    var picked = deepEligible ? findDeepHeavyRescueCandidate(ts, task, fallbackIdx, fallbackLimit) : null;
    if (!picked) picked = findFallbackCandidate(ts, fallbackIdx, preferOrdinary, requireOrdinary);
    if (!picked) {
      if (!heavyHostOpen || !preferOrdinary || ordinaryAvailable) {
        setFallbackIndex(ts, ts.sourceCandidates.length);
      }
      return null;
    }

    if (picked.heavyDeepRescue) {
      setFallbackIndex(ts, Math.min(ts.sourceCandidates.length, Math.max(fallbackIdx, (picked.sequentialFallbackIdx || fallbackIdx) + 1)));
    } else {
      setFallbackIndex(ts, picked.index + 1);
    }

    var replacement = Object.assign({}, picked.candidate, { previewIndex: picked.index });
    task.attachmentOriginalCandidate = null;
    if (ts.cacheImages && ts.cacheImages === ts.candidates) ts.cacheImages = ts.cacheImages.slice();
    ts.candidates[task.idx] = replacement;
    ts.__activeCandidateKeys = null;
    markThreadFallbackCandidateUsed(ts, replacement, picked.index);
    task.noReferrerFallbackTried = false;
    task.retries = 0;
    task.inlineFallbacks = (task.inlineFallbacks || 0) + 1;
    return getCandidateDisplaySrc(replacement);
  }

  function onBeforeAttachmentSwap(task, originalImgData) {
    var ts = getThreadState(task && task.threadId);
    if (!ts) return;
    markThreadFallbackCandidateUsed(ts, originalImgData, getTaskPreviewIndex(task));
    if (ts.cacheImages && ts.cacheImages === task.candidates) {
      ts.cacheImages = ts.cacheImages.slice();
    }
    ts.__activeCandidateKeys = null;
  }

  function onRestoreAttachment(task) {
    var ts = getThreadState(task && task.threadId);
    if (ts) ts.__activeCandidateKeys = null;
  }

  // --- Memory-Saving GIF Still-Frame Freezer ---

  function flushStillFrameQueue(deadline) {
    var drawn = 0;
    while (STILL_FRAME_QUEUE.length) {
      if (drawn > 0 && (!deadline || typeof deadline.timeRemaining !== 'function' || deadline.timeRemaining() < 4)) {
        break;
      }
      var job = STILL_FRAME_QUEUE.shift();
      job();
      drawn++;
    }
    if (STILL_FRAME_QUEUE.length) scheduleStillFrameQueue();
  }

  function scheduleStillFrameQueue() {
    if (STILL_FRAME_TIMER !== null) return;
    if (typeof requestIdleCallback === 'function') {
      STILL_FRAME_TIMER = requestIdleCallback(function (deadline) {
        STILL_FRAME_TIMER = null;
        flushStillFrameQueue(deadline);
      }, { timeout: 500 });
    } else {
      STILL_FRAME_TIMER = setTimeout(function () {
        STILL_FRAME_TIMER = null;
        flushStillFrameQueue(null);
      }, 16);
    }
  }

  function restoreGifPlaybackOnHover(wrapper) {
    if (!wrapper || !wrapper.classList || !wrapper.classList.contains('atp-gif-frozen')) return;
    wrapper.__atpGifActive = true;
  }

  function clearGifPlaybackOnLeave(wrapper) {
    if (!wrapper) return;
    wrapper.__atpGifActive = false;
  }

  function freezeAnimatedThumbnail(wrapper, img, task) {
    if (!wrapper || !img || !task || !isLargeLaneTask(task)) return false;
    var src = (img.currentSrc || img.src) || (wrapper.dataset && wrapper.dataset.atpGifSrc) || getTaskImageSrc(task);
    if (!src) return false;
    if (wrapper.dataset) wrapper.dataset.atpGifSrc = src;
    GIF_WRAPPERS.add(wrapper);

    var settings = getCurrentSettings();
    if (settings.animatedThumbnailMode === 'play') {
      if (wrapper.classList) wrapper.classList.remove('atp-gif-frozen');
      return false;
    }
    if (wrapper.classList && wrapper.classList.contains('atp-gif-frozen') &&
        wrapper.querySelector && wrapper.querySelector('.atp-gif-still')) {
      return true;
    }

    var expectedSrc = src;
    var drawStill = function () {
      if (!img.naturalWidth || !img.naturalHeight) return;
      var curImgSrc = img.currentSrc || img.src || '';
      if (curImgSrc && curImgSrc !== expectedSrc) return;
      if (img.parentNode !== wrapper || (typeof document !== 'undefined' && document.contains && !document.contains(wrapper))) {
        GIF_WRAPPERS.delete(wrapper);
        return;
      }
      var curSettings = getCurrentSettings();
      var tileWidth = Math.max(1, Number(curSettings.thumbWidth) || 110);
      var tileHeight = Math.max(1, Number(curSettings.thumbHeight) || 82);
      var dpr = Math.min(2, Math.max(1, Number(root.devicePixelRatio) || 1));
      var scale = Math.min(tileWidth / img.naturalWidth, tileHeight / img.naturalHeight, 1) * dpr;
      var canvasW = Math.max(1, Math.round(img.naturalWidth * scale));
      var canvasH = Math.max(1, Math.round(img.naturalHeight * scale));
      var canvas = document.createElement('canvas');
      canvas.className = 'atp-gif-still';
      if (canvas.classList && canvas.classList.add) canvas.classList.add('atp-gif-still');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.width = canvasW;
      canvas.height = canvasH;
      var ctx = canvas.getContext && canvas.getContext('2d', { alpha: true, willReadFrequently: true });
      if (!ctx) return;
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(img, 0, 0, canvasW, canvasH);
      } catch (e) {
        return;
      }
      var old = wrapper.querySelector ? wrapper.querySelector('.atp-gif-still') : null;
      if (old && old.parentNode) old.parentNode.removeChild(old);
      wrapper.appendChild(canvas);
      if (wrapper.dataset) wrapper.dataset.atpGifSrc = src;

      if (curSettings.animatedThumbnailMode === 'play') return;
      // .atp-gif-frozen sets display:none on .atp-thumbnail-img, detaching its Blink LayoutImage
      // so GIF frame timers & decoding stop completely while preserving naturalWidth & hover cache!
      if (wrapper.classList) wrapper.classList.add('atp-gif-frozen');
    };

    if (typeof img.decode === 'function') {
      img.decode().then(function () {
        STILL_FRAME_QUEUE.push(drawStill);
        scheduleStillFrameQueue();
      }, function () {});
    } else {
      STILL_FRAME_QUEUE.push(drawStill);
      scheduleStillFrameQueue();
    }
    return true;
  }

  function applyAnimatedMode(mode) {
    var targetMode = mode === 'play' ? 'play' : 'still';
    var settings = getCurrentSettings();
    settings.animatedThumbnailMode = targetMode;

    if (typeof document !== 'undefined' && document.querySelectorAll) {
      var domGifNodes = document.querySelectorAll('.atp-gif-frozen, .atp-thumbnail-wrapper[data-atp-gif-src]');
      for (var d = 0; d < domGifNodes.length; d++) GIF_WRAPPERS.add(domGifNodes[d]);
    }

    var toDelete = [];
    GIF_WRAPPERS.forEach(function (wrapper) {
      if (!wrapper || (typeof document !== 'undefined' && document.contains && !document.contains(wrapper))) {
        toDelete.push(wrapper);
        return;
      }
      var img = wrapper.querySelector ? wrapper.querySelector('.atp-thumbnail-img') : null;
      var gifSrc = (wrapper.dataset && wrapper.dataset.atpGifSrc) || '';
      if (!img || !gifSrc) return;

      if (targetMode === 'play') {
        if (wrapper.classList) wrapper.classList.remove('atp-gif-frozen');
        if (!(img.getAttribute && img.getAttribute('src')) && !img.src) {
          img.decoding = 'async';
          if (root.ATPHostHealth && ATPHostHealth.shouldUseNoReferrerByDefault(gifSrc)) {
            img.referrerPolicy = 'no-referrer';
          }
          img.src = gifSrc;
        }
      } else {
        var stillCanvas = wrapper.querySelector ? wrapper.querySelector('.atp-gif-still') : null;
        if (stillCanvas) {
          if (wrapper.classList) wrapper.classList.add('atp-gif-frozen');
          if (!wrapper.__atpGifActive) img.removeAttribute('src');
        } else {
          var task = WRAPPER_TASK_MAP.get(wrapper) || wrapper.__atpLoadTask;
          if (!(img.getAttribute && img.getAttribute('src')) && !img.src) {
            img.src = gifSrc;
          }
          if (task) freezeAnimatedThumbnail(wrapper, img, task);
        }
      }
    });
    for (var i = 0; i < toDelete.length; i++) GIF_WRAPPERS.delete(toDelete[i]);
  }

  // --- Container-Level Event Delegation + CSS-Class Failed State ---

  function findWrapperFromEvent(evt, grid) {
    var target = evt && evt.target;
    if (!target) return null;
    if (target.classList && target.classList.contains('atp-thumbnail-wrapper')) return target;
    if (typeof target.closest === 'function') {
      var found = target.closest('.atp-thumbnail-wrapper');
      if (found && (!grid || !grid.contains || grid.contains(found))) return found;
    }
    var cur = target.parentNode;
    while (cur && cur !== grid) {
      if (cur.classList && cur.classList.contains('atp-thumbnail-wrapper')) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  function resolveTaskForWrapper(wrapper) {
    if (!wrapper) return null;
    var mapped = WRAPPER_TASK_MAP.get(wrapper) || wrapper.__atpLoadTask;
    if (mapped) return mapped;
    var ds = wrapper.dataset;
    if (!ds || !ds.atpThreadId) return null;
    var ts = getThreadState(ds.atpThreadId);
    if (!ts || !ts.candidates) return null;
    var idx = parseInt(ds.atpIdx, 10);
    if (isNaN(idx) || idx < 0 || idx >= ts.candidates.length) return null;
    return {
      candidates: ts.candidates,
      idx: idx,
      threadId: ts.id,
      generation: ts.generation,
      grid: ts.grid,
      isFirstScreen: idx < ts.firstScreenTotal
    };
  }

  function setFailedStatusText(wrapper, statusText, titleText, ariaLabel) {
    var statusEl = (wrapper && wrapper.__atpFailedStatusEl) ||
      (wrapper && wrapper.querySelector ? wrapper.querySelector('.atp-thumbnail-failed-status') : null);
    if (statusEl) statusEl.textContent = statusText;
    if (wrapper) {
      wrapper.title = titleText;
      if (wrapper.setAttribute) wrapper.setAttribute('aria-label', ariaLabel);
    }
  }

  function enqueueManualRetryFromWrapper(wrapper, bypassLimit) {
    if (!wrapper) return false;
    if (wrapper.__atpRetryQueued || (wrapper.dataset && wrapper.dataset.atpRetryQueued === '1')) return false;
    var task = resolveTaskForWrapper(wrapper);
    if (!task || !isTaskCurrent(task)) {
      removeWrapper(wrapper);
      return false;
    }
    if (!bypassLimit && MANUAL_IMAGE_RETRIES.length >= MANUAL_IMAGE_RETRY_LIMIT) {
      setFailedStatusText(wrapper, '重试队列已满', '重试队列已满，稍后可再试', '重试队列已满，稍后可再试');
      return false;
    }
    var ts = getThreadState(task.threadId);
    if (root.ATPHostHealth) ATPHostHealth.restoreOriginalAttachment(task, onRestoreAttachment);
    var now = Date.now();
    var retryTask = {
      candidates: task.candidates,
      idx: typeof task.idx === 'number' ? task.idx : 0,
      threadId: task.threadId,
      generation: ts && ts.generation,
      grid: task.grid || (ts && ts.grid) || null,
      isFirstScreen: false,
      retries: 0,
      inlineFallbacks: 0,
      siblingHostTried: false,
      manualRetry: true,
      readyImageQueue: task.readyImageQueue === true,
      wasCountedFailed: true,
      createdAt: now,
      queuedAt: now,
      tier: 0,
      queueKind: 'manual_retry'
    };
    wrapper.__atpRetryQueued = true;
    if (wrapper.dataset) wrapper.dataset.atpRetryQueued = '1';
    WRAPPER_TASK_MAP.set(wrapper, retryTask);
    wrapper.__atpLoadTask = retryTask;
    setFailedStatusText(wrapper, '已排队，等待空槽', '已排队，等待图床空槽后自动重试', '缩略图已排队，等待空槽后自动重试');
    MANUAL_IMAGE_RETRIES.push({ task: retryTask, wrapper: wrapper });
    return true;
  }

  function openPreviewFromWrapper(wrapper, preferOpenerFocus) {
    var task = resolveTaskForWrapper(wrapper);
    if (!task) return;
    var ts = getThreadState(task.threadId);
    if (!ts || !ts.candidates || !root.ATPPreviewer || typeof ATPPreviewer.open !== 'function') return;
    var previewCandidates = getPreviewCandidates(ts);
    var allUrls = buildPreviewUrls(previewCandidates);
    var clickIndex = getTaskPreviewIndex(task);
    ATPPreviewer.open(allUrls, clickIndex, {
      opener: wrapper,
      threadId: task.threadId,
      previewIndex: clickIndex,
      preferOpenerFocus: preferOpenerFocus === true
    });
  }

  function activateWrapperInteraction(wrapper, evt) {
    if (!wrapper) return;
    var isFailed = !!(wrapper.classList && wrapper.classList.contains('atp-thumbnail-failed'));
    if (isFailed) {
      if (evt && evt.stopPropagation) evt.stopPropagation();
      if (enqueueManualRetryFromWrapper(wrapper, false)) {
        ATPLoader.globalSchedule('manual_retry');
      }
      return;
    }
    var state = wrapper.dataset && wrapper.dataset.atpState;
    var hasLoadedImg = state === 'loaded' || !!(wrapper.getAttribute && wrapper.getAttribute('data-atp-preview-index') !== null);
    if (hasLoadedImg) {
      if (evt && evt.stopPropagation) evt.stopPropagation();
      openPreviewFromWrapper(wrapper, true);
    }
  }

  function onDelegatedGridClick(evt) {
    var wrapper = findWrapperFromEvent(evt, evt && evt.currentTarget);
    if (wrapper) activateWrapperInteraction(wrapper, evt);
  }

  function onDelegatedGridKeydown(evt) {
    var key = evt && evt.key;
    if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
    var wrapper = findWrapperFromEvent(evt, evt && evt.currentTarget);
    if (!wrapper) return;
    if (evt.preventDefault) evt.preventDefault();
    activateWrapperInteraction(wrapper, evt);
  }

  function onDelegatedGridPointerEnter(evt) {
    var target = evt && evt.target;
    if (target && target.classList && target.classList.contains('atp-gif-frozen')) {
      restoreGifPlaybackOnHover(target);
    }
  }

  function onDelegatedGridPointerLeave(evt) {
    var target = evt && evt.target;
    if (target && target.classList && target.classList.contains('atp-gif-frozen')) {
      clearGifPlaybackOnLeave(target);
    }
  }

  function onDelegatedGridFocusIn(evt) {
    var wrapper = findWrapperFromEvent(evt, evt && evt.currentTarget);
    if (wrapper && wrapper.classList && wrapper.classList.contains('atp-gif-frozen')) {
      restoreGifPlaybackOnHover(wrapper);
    }
  }

  function onDelegatedGridFocusOut(evt) {
    var wrapper = findWrapperFromEvent(evt, evt && evt.currentTarget);
    if (wrapper && wrapper.classList && wrapper.classList.contains('atp-gif-frozen')) {
      if (evt && evt.relatedTarget && wrapper.contains && wrapper.contains(evt.relatedTarget)) return;
      clearGifPlaybackOnLeave(wrapper);
    }
  }

  // Static shared handlers (zero per-thumbnail closure allocation!)
  function onThumbnailImgClick(evt) {
    if (evt && evt.stopPropagation) evt.stopPropagation();
    var wrapper = this && this.parentNode;
    if (wrapper) openPreviewFromWrapper(wrapper, true);
  }

  function onStandaloneWrapperClick(evt) {
    activateWrapperInteraction(this, evt);
  }

  function onStandaloneWrapperKeydown(evt) {
    var key = evt && evt.key;
    if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
    if (evt && evt.preventDefault) evt.preventDefault();
    if (evt && evt.stopPropagation) evt.stopPropagation();
    activateWrapperInteraction(this, evt);
  }

  // Binds ONE delegated click, keydown, and GIF hover/focus listener set per .atp-thumbnail-container!
  function ensureGridDelegation(grid) {
    if (!grid || grid.__atpDelegated || typeof grid.addEventListener !== 'function') return;
    grid.__atpDelegated = true;
    grid.addEventListener('click', onDelegatedGridClick);
    grid.addEventListener('keydown', onDelegatedGridKeydown);
    grid.addEventListener('pointerenter', onDelegatedGridPointerEnter, true);
    grid.addEventListener('pointerleave', onDelegatedGridPointerLeave, true);
    grid.addEventListener('focusin', onDelegatedGridFocusIn);
    grid.addEventListener('focusout', onDelegatedGridFocusOut);
  }

  function attachPanelHoverBoost(panel, threadId) {
    if (!panel || panel.__atpHoverBound || typeof panel.addEventListener !== 'function') return;
    panel.__atpHoverBound = true;
    panel.addEventListener('pointerenter', function () {
      if (HOVERED_THREAD_ID !== threadId) {
        HOVERED_THREAD_ID = threadId;
        requestSchedule('thread_hover_boost');
      }
    }, { passive: true });
    panel.addEventListener('pointerleave', function () {
      if (HOVERED_THREAD_ID === threadId) HOVERED_THREAD_ID = '';
    }, { passive: true });
    panel.addEventListener('focusin', function () {
      if (FOCUSED_THREAD_ID !== threadId) {
        FOCUSED_THREAD_ID = threadId;
        requestSchedule('thread_focus_boost');
      }
    });
    panel.addEventListener('focusout', function (evt) {
      if (FOCUSED_THREAD_ID === threadId) {
        if (evt && evt.relatedTarget && panel.contains && panel.contains(evt.relatedTarget)) return;
        FOCUSED_THREAD_ID = '';
      }
    });
  }

  function clearHeavyWrapperVisualState(wrapper) {
    if (!wrapper || !wrapper.classList) return;
    wrapper.classList.remove('atp-heavy-preview-active');
    wrapper.classList.remove('atp-heavy-preview-pending');
    wrapper.classList.remove('atp-heavy-unloaded');
  }

  function clearPreviewActivation(wrapper) {
    if (!wrapper) return;
    if (wrapper.removeAttribute) {
      wrapper.removeAttribute('tabindex');
      wrapper.removeAttribute('role');
      wrapper.removeAttribute('aria-label');
      wrapper.removeAttribute('data-atp-preview-index');
    }
    if (wrapper.dataset) delete wrapper.dataset.atpState;
    wrapper.onclick = null;
    wrapper.onkeydown = null;
  }

  function bindPreviewActivation(wrapper, openPreview, task) {
    if (!wrapper) return;
    var previewIdx = task ? getTaskPreviewIndex(task) : 0;
    wrapper.tabIndex = 0;
    if (wrapper.setAttribute) {
      wrapper.setAttribute('role', 'button');
      wrapper.setAttribute('aria-label', getPreviewActivationLabel(task));
      wrapper.setAttribute('data-atp-thread-id', (task && task.threadId) || '');
      wrapper.setAttribute('data-atp-preview-index', String(previewIdx));
    }
    wrapper.__atpRetryQueued = false;
    if (wrapper.dataset) {
      wrapper.dataset.atpState = 'loaded';
      wrapper.dataset.atpThreadId = (task && task.threadId) || '';
      if (task && typeof task.idx === 'number') wrapper.dataset.atpIdx = String(task.idx);
      wrapper.dataset.atpPreviewIndex = String(previewIdx);
      delete wrapper.dataset.atpRetryQueued;
    }
    if (task) {
      WRAPPER_TASK_MAP.set(wrapper, task);
      wrapper.__atpLoadTask = task;
    }
    var grid = (task && task.grid) || (wrapper.closest && wrapper.closest('.atp-thumbnail-container'));
    if (grid && typeof grid.addEventListener === 'function') {
      ensureGridDelegation(grid);
    }
    wrapper.onclick = onStandaloneWrapperClick;
    wrapper.onkeydown = onStandaloneWrapperKeydown;
  }

  function removeWrapper(wrapper) {
    if (!wrapper) return;
    FAILED_WRAPPERS.delete(wrapper);
    GIF_WRAPPERS.delete(wrapper);
    if (root.ATPViewport && ATPViewport.unobserve) {
      ATPViewport.unobserve(wrapper);
    } else if (root.ATPViewport && ATPViewport.unobserveLoadingAnimation) {
      ATPViewport.unobserveLoadingAnimation(wrapper);
    }
    if (wrapper.parentNode) wrapper.remove();
  }

  // --- Thread Status Text Formatting & rAF Batching ---

  function getThreadCandidateCount(ts) {
    return ts && ts.candidates ? ts.candidates.length : 0;
  }

  function getThreadSettledCount(ts) {
    return ((ts && ts.loaded) || 0) + ((ts && ts.failedCount) || 0);
  }

  function isThreadComplete(ts) {
    var total = getThreadCandidateCount(ts);
    return !!ts && getThreadSettledCount(ts) >= total;
  }

  function getReadyDemandLimit(ts) {
    if (!ts) return 0;
    var total = getThreadCandidateCount(ts);
    if (!ts.readyImageQueue) {
      return ts.bgQueued || ts.bgQueueActive || ts.nextIdx > ts.firstScreenTotal ? total : Math.min(total, ts.firstScreenTotal);
    }
    return Math.min(total, ts.readyImageLimit || ts.firstScreenTotal || total);
  }

  function getThreadStatusTotal(ts) {
    if (!ts) return 0;
    if (ts.readyImageQueue) {
      var requested = getReadyDemandLimit(ts);
      var settledBeyond = 0;
      if (ts.readyImageSettled) {
        ts.readyImageSettled.forEach(function (idx) {
          if (idx >= requested) settledBeyond++;
        });
      }
      return Math.min(getThreadCandidateCount(ts), requested + settledBeyond);
    }
    return ts.bgQueued || ts.bgQueueActive || ts.nextIdx > ts.firstScreenTotal
      ? ts.total
      : ts.firstScreenTotal;
  }

  function formatThreadStatusText(ts, done) {
    if (ts.heavyMode) {
      var heavyText = (done ? '重图优化 完成 ' : '重图优化 ') + ts.loaded + '/' + ts.total + '（原' + ts.heavyOriginalTotal + '）';
      if (ts.failedCount > 0) heavyText += ' 失败' + ts.failedCount;
      return heavyText;
    }
    var total = done ? ts.total : Math.min(getThreadCandidateCount(ts), getThreadStatusTotal(ts));
    if (done || (ts.readyImageQueue && getThreadSettledCount(ts) >= total)) {
      var completeText = (done ? '完成 ' : '已预览 ') + ts.loaded + '/' + total;
      if (ts.failedCount > 0) completeText += ' (失败' + ts.failedCount + ')';
      return completeText;
    }
    return '加载中 ' + ts.loaded + '/' + total +
      (ts.readyImageQueue && ts.failedCount > 0 ? ' (失败' + ts.failedCount + ')' : '');
  }

  function writeThreadStatus(ts) {
    if (!isThreadCurrent(ts) || (ts.id && getThreadState(ts.id) !== ts)) return;
    if (!ts.statusEl || ts.statusEl.isConnected === false) return;
    var text = formatThreadStatusText(ts, isThreadComplete(ts));
    if (ts.statusEl.textContent !== text) ts.statusEl.textContent = text;
  }

  function flushThreadStatuses() {
    if (threadStatusFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(threadStatusFrame);
    if (threadStatusTimer !== null) clearTimeout(threadStatusTimer);
    threadStatusFrame = null;
    threadStatusTimer = null;
    pendingThreadStatuses.forEach(writeThreadStatus);
    pendingThreadStatuses.clear();
  }

  function queueThreadStatus(ts) {
    if (!ts || !ts.statusEl) return;
    if (typeof requestAnimationFrame !== 'function' || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
      pendingThreadStatuses.delete(ts);
      writeThreadStatus(ts);
      return;
    }
    pendingThreadStatuses.add(ts);
    if (threadStatusFrame !== null || threadStatusTimer !== null) return;
    threadStatusFrame = requestAnimationFrame(flushThreadStatuses);
    threadStatusTimer = setTimeout(flushThreadStatuses, 100);
  }

  // --- Deferred Heavy Thread Recovery ---

  function isLightweightHeavyThread(ts) {
    return !!(ts && ts.heavyMode && ts.lightweightHeavyMode);
  }

  function getBackgroundRemaining(ts) {
    if (!ts) return 0;
    return Math.max(0, getThreadCandidateCount(ts) - (ts.nextIdx || 0));
  }

  function getLightweightHeavyBackgroundBatchSize(settings) {
    settings = settings || getCurrentSettings();
    var cols = parseInt(settings.gridCols, 10);
    if (isNaN(cols)) cols = 5;
    var heavyLimit = ATPLoadPolicy.isHeavyImageOptimizationEnabled(settings)
      ? ATPLoadPolicy.getHeavyConcurrencyCeiling(settings)
      : cols;
    return Math.max(1, Math.min(cols, heavyLimit || cols));
  }

  function getBackgroundEnqueueCount(ts, settings) {
    var maxPerPost = typeof SharedUtils !== 'undefined' && SharedUtils.effectiveImageLimit
      ? SharedUtils.effectiveImageLimit(settings)
      : getThreadCandidateCount(ts);
    var remaining = getBackgroundRemaining(ts);
    var maxAllowed = Math.max(0, Math.min(remaining, maxPerPost - ts.firstScreenTotal));
    var count = maxAllowed;
    if (isLightweightHeavyThread(ts)) {
      count = Math.min(count, getLightweightHeavyBackgroundBatchSize(settings));
      if (count < maxAllowed && ATPLoadPolicy.isHeavyImageOptimizationEnabled(settings) && root.ATPHostHealth) {
        var baseIdx = ts.nextIdx || 0;
        var allLeadingOpen = true;
        for (var k = 0; k < maxAllowed; k++) {
          var cand = ts.candidates[baseIdx + k];
          var pSrc = getCandidatePreviewSrc(cand);
          var isOpenHeavy = false;
          if (pSrc && isHighFanoutImageHost(pSrc)) {
            var hFields = ATPHostHealth.getHeavyHostHealthLogFields(pSrc, settings, false);
            isOpenHeavy = hFields && hFields.heavyHostState === 'open';
          }
          if (!isOpenHeavy) {
            if (allLeadingOpen && k >= count) {
              count = Math.min(maxAllowed, k + 1);
            }
            break;
          }
        }
      }
    } else {
      var bgConc = Math.max(1, Number(settings && settings.backgroundConcurrency) || 1);
      count = Math.min(count, Math.max(4, Math.min(8, bgConc * 2)));
    }
    return count;
  }

  function getHeavyBackgroundDeferredInfo(ts) {
    if (!isLightweightHeavyThread(ts) || !ts.firstScreenDone) return false;
    var settings = getCurrentSettings();
    if (!ATPLoadPolicy.isHeavyImageOptimizationEnabled(settings)) return false;
    var remaining = getBackgroundRemaining(ts);
    if (remaining <= 0) return false;
    var deferredHost = '';
    var sampleHealth = null;
    var healthByHost = Object.create(null);
    for (var offset = 0; offset < remaining; offset++) {
      var c = ts.candidates[(ts.nextIdx || 0) + offset];
      var pSrc = getCandidatePreviewSrc(c);
      if (!pSrc || !isHighFanoutImageHost(pSrc)) return false;
      var host = getUrlHost(pSrc);
      if (!host || (deferredHost && host !== deferredHost)) return false;
      var h = healthByHost[host] || (healthByHost[host] = ATPHostHealth.getHeavyHostHealthLogFields(pSrc, settings, false));
      if (h.heavyHostState !== 'open') return false;
      if (!sampleHealth) {
        sampleHealth = h;
        deferredHost = host;
      }
    }
    return sampleHealth ? { healthFields: sampleHealth } : false;
  }

  function clearDeferredHeavyThreadTimer(threadId) {
    var t = DEFERRED_HEAVY_THREAD_TIMERS[threadId];
    if (t) clearTimeout(t);
    delete DEFERRED_HEAVY_THREAD_TIMERS[threadId];
  }

  function clearDeferredHeavyThreadWakeTimers() {
    for (var tid in DEFERRED_HEAVY_THREAD_TIMERS) {
      clearTimeout(DEFERRED_HEAVY_THREAD_TIMERS[tid]);
    }
    DEFERRED_HEAVY_THREAD_TIMERS = Object.create(null);
  }

  function clearDeferredHeavyThreads() {
    for (var tid in DEFERRED_HEAVY_THREADS) {
      var ts = getThreadState(tid);
      if (ts) {
        ts.bgHostDeferred = false;
        ts.bgHostDeferredUntil = 0;
      }
    }
    clearDeferredHeavyThreadWakeTimers();
    DEFERRED_HEAVY_THREADS = Object.create(null);
  }

  function wakeDeferredHeavyThread(threadId, skipSchedule) {
    clearDeferredHeavyThreadTimer(threadId);
    if (GLOBAL_PAUSED) return false;
    var ts = getThreadState(threadId);
    if (!isThreadCurrent(ts)) {
      delete DEFERRED_HEAVY_THREADS[threadId];
      return false;
    }
    var deferInfo = getHeavyBackgroundDeferredInfo(ts);
    if (deferInfo) {
      var rem = Math.max(50, Number(deferInfo.healthFields.heavyHostCooldownRemainingMs) || 0) + 10;
      DEFERRED_HEAVY_THREAD_TIMERS[threadId] = setTimeout(function () {
        wakeDeferredHeavyThread(threadId, false);
      }, rem);
      return false;
    }
    delete DEFERRED_HEAVY_THREADS[threadId];
    ts.bgHostDeferred = false;
    ts.bgHostDeferredUntil = 0;
    ATPLoader.enqueueBgForThread(threadId);
    if (!skipSchedule) requestSchedule('deferred_heavy_wake');
    return true;
  }

  function resumeDeferredHeavyThreads() {
    var woke = false;
    for (var tid in DEFERRED_HEAVY_THREADS) {
      if (wakeDeferredHeavyThread(tid, true)) woke = true;
    }
    if (woke) requestSchedule('deferred_heavy_resume');
  }

  // Connect ATPHostHealth wake callback so recovered heavy hosts immediately resume deferred work
  if (root.ATPHostHealth && ATPHostHealth.setWakeCallback) {
    ATPHostHealth.setWakeCallback(function () {
      if (GLOBAL_PAUSED) return;
      resumeDeferredHeavyThreads();
      requestSchedule('heavy_host_wake');
    });
  }

  // --- Unified 4-Tier Thread Queue Management ---

  function ensureThreadQueue(ts) {
    if (!ts) return null;
    var q = ts.__schedQueue;
    if (!q) {
      q = ts.__schedQueue = {
        requeued: [],
        tasks: [],
        offset: 0,
        stagedIdx: 0
      };
    }
    if (ts.panel) {
      if (root.ATPViewport && ATPViewport.trackThreadPanel && !ts.__atpPanelTracked) {
        ts.__atpPanelTracked = true;
        ATPViewport.trackThreadPanel(ts.panel, ts);
      }
      attachPanelHoverBoost(ts.panel, ts.id);
    }
    if (ts.grid) ensureGridDelegation(ts.grid);

    // Absorb any unconsumed firstTasks created by renderer.js
    var firstOffset = Math.max(0, ts.firstTaskOffset || 0);
    if (ts.firstTasks && firstOffset < ts.firstTasks.length) {
      for (var i = firstOffset; i < ts.firstTasks.length; i++) {
        var ft = ts.firstTasks[i];
        if (ft) {
          if (ts.readyImageQueue) ft.readyImageQueue = true;
          q.tasks.push(ft);
          if (typeof ft.idx === 'number' && ft.idx + 1 > q.stagedIdx) {
            q.stagedIdx = ft.idx + 1;
          }
        }
      }
      ts.firstTaskOffset = ts.firstTasks.length;
    }
    if (ts.readyImageQueue) {
      ts.readyImageIndexed = Math.max(ts.readyImageIndexed || 0, q.stagedIdx || 0);
    }

    return q;
  }

  function getThreadQueuedCount(ts) {
    var q = ts && ts.__schedQueue;
    if (ts && ts.readyImageQueue) {
      var demand = getReadyDemandLimit(ts);
      var activeQueued = 0;
      if (q) {
        for (var r = 0; r < q.requeued.length; r++) {
          if (q.requeued[r] && q.requeued[r].idx < demand) activeQueued++;
        }
        for (var t = q.offset; t < q.tasks.length; t++) {
          if (q.tasks[t] && q.tasks[t].idx < demand) activeQueued++;
        }
      }
      var unabsorbed = ts.firstTasks ? Math.max(0, Math.min(ts.firstTasks.length, demand) - (ts.firstTaskOffset || 0)) : 0;
      var unindexed = Math.max(0, demand - Math.max(ts.nextIdx || 0, ts.firstScreenTotal || 0));
      return activeQueued + unabsorbed + unindexed;
    }
    var base = q ? (q.requeued.length + Math.max(0, q.tasks.length - q.offset)) : 0;
    var unabsorbedFirst = ts && ts.firstTasks ? Math.max(0, ts.firstTasks.length - (ts.firstTaskOffset || 0)) : 0;
    return base + unabsorbedFirst;
  }

  function requeueTaskToThread(task, reason) {
    if (!task || !isTaskCurrent(task)) return false;
    var ts = getThreadState(task.threadId);
    var q = ensureThreadQueue(ts);
    if (!q) return false;
    var now = Date.now();
    task.queuedAt = now;
    task.queueWaitMs = 0;
    task.loadStartAt = 0;
    task.currentlyVisible = undefined;
    task.forceEager = false;
    task.forcePreload = false;
    if (reason) task.requeueReason = reason;
    if (reason === 'auto_retry') {
      q.tasks.push(task);
    } else {
      q.requeued.unshift(task);
    }
    return true;
  }

  function computePanelRectBandFallback(panel) {
    if (!panel || typeof panel.getBoundingClientRect !== 'function') return null;
    var rect = panel.getBoundingClientRect();
    if (!rect || typeof rect.top !== 'number' || typeof rect.bottom !== 'number') return null;
    var winH = (typeof root.innerHeight === 'number' && root.innerHeight > 0)
      ? root.innerHeight
      : ((typeof document !== 'undefined' && document.documentElement && document.documentElement.clientHeight) || 800);
    if (rect.bottom > 0 && rect.top < winH) return 0;
    if (rect.bottom > -240 && rect.top < winH + 240) return 1;
    if (rect.bottom > -1000 && rect.top < winH + 1000) return 2;
    return 3;
  }

  function getThreadBand(ts, threadOrdinal, anyThreadHasIO) {
    if (!ts) return 3;
    var hiddenDoc = typeof document !== 'undefined' && document.visibilityState !== 'visible';
    if (hiddenDoc && ts.readyImageVisible === false) return 3;
    if (!anyThreadHasIO) {
      var rectBand = computePanelRectBandFallback(ts.panel);
      if (rectBand !== null) return rectBand;
    }
    if (typeof ts.viewportBand === 'number') {
      if (!anyThreadHasIO && ts.viewportBand === 3 && ts.readyImageVisible !== false && threadOrdinal < fallbackInitialVisibleCount) {
        return 0;
      }
      return ts.viewportBand;
    }
    if (ts.readyImageVisible === true) return 0;
    if (!anyThreadHasIO && ts.readyImageVisible !== false && threadOrdinal < fallbackInitialVisibleCount) return 0;
    return 3;
  }

  function shouldBypassViewportLazyLoad(settings) {
    return !!(settings && settings.pauseWhenHidden === false &&
      typeof document !== 'undefined' && document.visibilityState !== 'visible');
  }

  function isBackgroundImageLocked(task) {
    if (!task || task.isFirstScreen || task.manualRetry) return false;
    var ts = getThreadState(task.threadId);
    return !!(ts && ts.backgroundUnlocked === false && task.idx >= ts.firstScreenTotal);
  }

  function releaseBackgroundBatchTask(task, ts) {
    if (!task || !task.backgroundBatch || task.backgroundBatchReleased || !ts) return false;
    task.backgroundBatchReleased = true;
    ts.bgBatchPending = Math.max(0, (ts.bgBatchPending || 0) - 1);
    if (ts.bgBatchPending > 0) return false;
    ts.bgBatchPending = 0;
    ts.bgQueueActive = false;
    return true;
  }

  // --- Fast Preemption (250ms): P3 -> P0 / P1 ---

  function schedulePreemptWake(delayMs) {
    var delay = Math.max(16, Math.ceil(delayMs));
    var dueAt = Date.now() + delay;
    if (preemptWakeTimer !== null && preemptWakeDueAt <= dueAt) return;
    if (preemptWakeTimer !== null) clearTimeout(preemptWakeTimer);
    preemptWakeDueAt = dueAt;
    preemptWakeTimer = setTimeout(function () {
      preemptWakeTimer = null;
      preemptWakeDueAt = 0;
      if (!GLOBAL_PAUSED) requestSchedule('preempt_age_ready');
    }, delay);
  }

  function clearPreemptWakeTimer() {
    if (preemptWakeTimer !== null) {
      clearTimeout(preemptWakeTimer);
      preemptWakeTimer = null;
      preemptWakeDueAt = 0;
    }
  }

  function isRunnerCurrentlyVisible(runner) {
    if (!runner) return false;
    if (runner.tier === 0 || (runner.task && runner.task.manualRetry)) return true;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    var task = runner.task;
    var ts = task && getThreadState(task.threadId);
    if (ts) {
      if (ts.id === HOVERED_THREAD_ID || ts.id === FOCUSED_THREAD_ID) return true;
      var anyIO = !!(root.ATPViewport && ATPViewport.hasDeliveredIntersections && ATPViewport.hasDeliveredIntersections());
      var threadBand = typeof ts.__liveScheduleBand === 'number'
        ? ts.__liveScheduleBand
        : getThreadBand(ts, 0, anyIO);
      if (threadBand > 0) return false;
      var w = runner.wrapper;
      if (w && typeof w.__atpViewportBand === 'number') {
        return w.__atpViewportBand === 0;
      }
      return true;
    }
    var wrapper = runner.wrapper;
    if (wrapper && typeof wrapper.__atpViewportBand === 'number') {
      return wrapper.__atpViewportBand === 0;
    }
    return isPriorityImageTask(task);
  }

  function tryPreemptP3ForUrgentTask(urgentTask, admissionResult, now, pendingBatch) {
    if (!root.ATPImageRunner || !admissionResult || admissionResult.hostOpen) return false;
    if (admissionResult.reason === 'manual_host_limit' || admissionResult.reason === 'scrolling') return false;

    var minAgeMs = ATPLoadPolicy.getPreemptionMinAgeMs ? ATPLoadPolicy.getPreemptionMinAgeMs() : 250;
    var runners = ATPImageRunner.getActiveRunners();
    if (!runners || !runners.size) return false;

    var targetHost = admissionResult.host || getUrlHost(getTaskImageSrc(urgentTask));
    var needSameHost = admissionResult.reason === 'ordinary_host_limit' ||
      admissionResult.reason === 'ordinary_host_cooling' ||
      admissionResult.reason === 'ordinary_large_lane';
    var needGif = admissionResult.reason === 'ordinary_large_lane';
    var needHeavy = admissionResult.reason === 'heavy_limit';
    var needOrdinary = admissionResult.reason === 'ordinary_limit';

    var hasVisibleActive = false;
    runners.forEach(function (r) {
      if (hasVisibleActive || !r || r.isRestore) return;
      if (!isRunnerCurrentlyVisible(r)) return;
      var rh = r.getHost();
      if (needSameHost && rh !== targetHost) return;
      if (needGif && !r.isLarge()) return;
      if (needHeavy && !r.isHeavy()) return;
      if (needOrdinary && r.isHeavy()) return;
      hasVisibleActive = true;
    });
    if (!hasVisibleActive && Array.isArray(pendingBatch)) {
      var curSettings = getCurrentSettings();
      for (var pbi = 0; pbi < pendingBatch.length; pbi++) {
        var pbTask = pendingBatch[pbi] && pendingBatch[pbi].task;
        if (!pbTask || !pbTask.currentlyVisible) continue;
        var pbHost = getUrlHost(getTaskImageSrc(pbTask));
        var pbHeavy = isHeavyChannelTask(pbTask, curSettings);
        if (needSameHost && pbHost !== targetHost) continue;
        if (needGif && !isLargeLaneTask(pbTask)) continue;
        if (needHeavy && !pbHeavy) continue;
        if (needOrdinary && pbHeavy) continue;
        hasVisibleActive = true;
        break;
      }
    }

    var bestVictim = null;
    var shortestWaitMs = Infinity;

    runners.forEach(function (runner) {
      if (!runner || runner.isRestore || runner.tier === 0 || (runner.task && runner.task.manualRetry)) return;
      if (isRunnerCurrentlyVisible(runner)) return;
      if (runner.tier < 3 && hasVisibleActive) return;
      if (runner.isNearlyComplete(now)) return;

      var rHost = runner.getHost();
      if (needSameHost && rHost !== targetHost) return;
      if (needGif && !runner.isLarge()) return;
      if (needHeavy && !runner.isHeavy()) return;
      if (needOrdinary && runner.isHeavy()) return;

      var age = now - runner.startedAt;
      if (age < minAgeMs) {
        shortestWaitMs = Math.min(shortestWaitMs, minAgeMs - age);
        return;
      }

      if (!bestVictim) {
        bestVictim = runner;
        return;
      }
      // Prefer P3 background prefetch over scrolled-away visible transfers, then same-host, then youngest / highest idx
      var curIsP3 = runner.tier >= 3;
      var bestIsP3 = bestVictim.tier >= 3;
      if (curIsP3 !== bestIsP3) {
        if (curIsP3) bestVictim = runner;
        return;
      }
      var curSameHost = rHost === targetHost;
      var bestSameHost = bestVictim.getHost() === targetHost;
      if (curSameHost !== bestSameHost) {
        if (curSameHost) bestVictim = runner;
        return;
      }
      var curIsLarge = runner.isLarge();
      var bestIsLarge = bestVictim.isLarge();
      if (curIsLarge !== bestIsLarge) {
        if (curIsLarge) bestVictim = runner;
        return;
      }
      if (runner.startedAt > bestVictim.startedAt) {
        bestVictim = runner;
      }
    });

    if (bestVictim && bestVictim.preempt('visible_priority')) {
      if (urgentTask) urgentTask.__preemptedSlot = true;
      syncLegacyActiveCounter();
      return true;
    }
    if (!bestVictim && isFinite(shortestWaitMs)) {
      schedulePreemptWake(shortestWaitMs);
    }
    return false;
  }

  // --- Frame-Friendly Coalesced Scheduling + Batched DOM Write ---

  function cancelPendingScheduleRequest() {
    if (scheduleCancelFn) {
      var cancel = scheduleCancelFn;
      scheduleCancelFn = null;
      try { cancel(); } catch (e) { /* ignore */ }
    }
    scheduleRequested = false;
    schedulePendingReason = '';
  }

  function requestSchedule(reason) {
    if (GLOBAL_PAUSED) return;
    schedulePendingReason = reason || schedulePendingReason || 'schedule';
    if (scheduleRequested) return;
    scheduleRequested = true;

    var runScheduled = function () {
      scheduleRequested = false;
      scheduleCancelFn = null;
      var r = schedulePendingReason;
      schedulePendingReason = '';
      if (!GLOBAL_PAUSED) ATPLoader.globalSchedule(r);
    };

    if (globalThis.scheduler && typeof globalThis.scheduler.postTask === 'function' &&
        typeof AbortController === 'function') {
      var ac = new AbortController();
      scheduleCancelFn = function () { ac.abort(); };
      globalThis.scheduler.postTask(runScheduled, {
        priority: 'user-visible',
        signal: ac.signal
      }).catch(function () {});
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState === 'visible' &&
        typeof requestAnimationFrame === 'function') {
      var rafId = requestAnimationFrame(runScheduled);
      scheduleCancelFn = function () {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      };
      return;
    }

    var tid = setTimeout(runScheduled, 0);
    scheduleCancelFn = function () { clearTimeout(tid); };
  }

  function clearP3Timer() {
    if (p3PacingTimer !== null) {
      clearTimeout(p3PacingTimer);
      p3PacingTimer = null;
    }
  }

  function scheduleP3Timer(delayMs) {
    if (p3PacingTimer !== null || GLOBAL_PAUSED) return;
    var delay = Math.max(0, Math.floor(delayMs));
    p3PacingTimer = setTimeout(function () {
      p3PacingTimer = null;
      if (!GLOBAL_PAUSED) requestSchedule('p3_pacing');
    }, delay);
  }

  function pickAdmittedTaskFromThread(ts, tier, ordinaryLimit, hasOrdinaryWaiting, allowPreempt, now, settings, pendingBatch) {
    var q = ts.__schedQueue;
    if (!q) return null;
    var demandLimit = ts.readyImageQueue ? getReadyDemandLimit(ts) : Infinity;
    var visible = tier <= 1 && (typeof document === 'undefined' || document.visibilityState === 'visible');
    var offscreenAuto = tier >= 3 && ATPLoadPolicy.isAutoLoadOffscreenFirstRowsEnabled(settings);
    var heavyScrolling = !!(root.ATPViewport && ATPViewport.isScrolling && ATPViewport.isScrolling());

    var admissionOpts = {
      settings: settings,
      heavyScrollDeferred: heavyScrolling && visible === false,
      onBeforeAttachmentSwap: onBeforeAttachmentSwap,
      onRestoreAttachment: onRestoreAttachment
    };

    function tryList(list, startIdx, isOffsetList) {
      var blockedHosts = null;
      var checks = 0;
      for (var i = startIdx; i < list.length && checks < 24; i++) {
        var task = list[i];
        if (!task || !isTaskCurrent(task)) {
          if (!isOffsetList) { list.splice(i, 1); i--; }
          else if (i === q.offset) q.offset++;
          continue;
        }
        if (task.idx >= demandLimit || isBackgroundImageLocked(task)) continue;

        var src = getTaskImageSrc(task);
        var host = getUrlHost(src);
        var hostKey = host + (isLargeLaneTask(task) ? '|gif' : '|img');
        if (blockedHosts && blockedHosts[hostKey]) continue;
        checks++;

        task.tier = tier;
        task.currentlyVisible = visible;
        task.viewportPriority = visible;
        task.offscreenAutoLoad = offscreenAuto;

        var check = ATPHostHealth.checkTaskAdmission(task, ordinaryLimit, hasOrdinaryWaiting, admissionOpts);
        if (!check.admit && allowPreempt && tryPreemptP3ForUrgentTask(task, check, now, pendingBatch)) {
          check = ATPHostHealth.checkTaskAdmission(task, ordinaryLimit, hasOrdinaryWaiting, admissionOpts);
        }
        if (!check.admit) {
          if (check.reason === 'ordinary_large_lane' && !task.ordinaryHostDeferredLogged) {
            task.ordinaryHostDeferredLogged = true;
            logImageEvent('image_defer', task, {
              reason: 'ordinary_large_lane',
              ordinaryHostLargeActive: check.snapshot && check.snapshot.ordinaryHostLargeActive
            });
          }
          if (!blockedHosts) blockedHosts = Object.create(null);
          blockedHosts[hostKey] = true;
          continue;
        }

        if (isOffsetList && i === q.offset) {
          q.offset++;
          if (q.offset > 32 && q.offset * 2 >= q.tasks.length) {
            q.tasks.splice(0, q.offset);
            q.offset = 0;
          }
        } else {
          list.splice(i, 1);
        }
        return {
          task: task,
          expiredSibling: !!check.expiredSibling,
          expiredReplacement: !!check.expiredReplacement
        };
      }
      return null;
    }

    if (q.requeued.length) {
      var fromRequeued = tryList(q.requeued, 0, false);
      if (fromRequeued) return fromRequeued;
    }
    if (q.offset < q.tasks.length) {
      var fromTasks = tryList(q.tasks, q.offset, true);
      if (fromTasks) return fromTasks;
    }
    if (ts.readyImageQueue && (ts.nextIdx || 0) < demandLimit) {
      var baseReadyIdx = ts.nextIdx || 0;
      var maxReadyProbe = Math.min(demandLimit, baseReadyIdx + 64);
      var readyBlockedHosts = null;
      for (var probeIdx = baseReadyIdx; probeIdx < maxReadyProbe; probeIdx++) {
        var probeCand = ts.candidates[probeIdx];
        var probeSrc = getCandidateDisplaySrc(probeCand);
        var probeHostKey = getUrlHost(probeSrc) + (SharedUtils && SharedUtils.isAnimatedGifUrl && SharedUtils.isAnimatedGifUrl(probeSrc) ? '|gif' : '|img');
        if (readyBlockedHosts && readyBlockedHosts[probeHostKey]) continue;
        var readyTask = {
          candidates: ts.candidates,
          idx: probeIdx,
          threadId: ts.id,
          generation: ts.generation,
          grid: ts.grid,
          isFirstScreen: probeIdx < ts.firstScreenTotal,
          readyImageQueue: true,
          tier: tier,
          currentlyVisible: visible,
          viewportPriority: visible,
          offscreenAutoLoad: offscreenAuto,
          createdAt: now,
          queuedAt: now,
          queueKind: probeIdx < ts.firstScreenTotal ? 'ready_first' : 'ready_next'
        };
        var rCheck = ATPHostHealth.checkTaskAdmission(readyTask, ordinaryLimit, hasOrdinaryWaiting, admissionOpts);
        if (!rCheck.admit && allowPreempt && tryPreemptP3ForUrgentTask(readyTask, rCheck, now, pendingBatch)) {
          rCheck = ATPHostHealth.checkTaskAdmission(readyTask, ordinaryLimit, hasOrdinaryWaiting, admissionOpts);
        }
        if (rCheck.admit) {
          for (var stageIdx = baseReadyIdx; stageIdx < probeIdx; stageIdx++) {
            q.tasks.push({
              candidates: ts.candidates,
              idx: stageIdx,
              threadId: ts.id,
              generation: ts.generation,
              grid: ts.grid,
              isFirstScreen: stageIdx < ts.firstScreenTotal,
              readyImageQueue: true,
              createdAt: now,
              queuedAt: now,
              queueKind: stageIdx < ts.firstScreenTotal ? 'ready_first' : 'ready_next'
            });
          }
          ts.nextIdx = probeIdx + 1;
          q.stagedIdx = Math.max(q.stagedIdx || 0, ts.nextIdx);
          ts.readyImageIndexed = q.stagedIdx;
          return {
            task: readyTask,
            expiredSibling: !!rCheck.expiredSibling,
            expiredReplacement: !!rCheck.expiredReplacement
          };
        }
        if (rCheck.reason === 'global_limit' || rCheck.reason === 'ordinary_limit' || rCheck.reason === 'scrolling') {
          break;
        }
        if (!readyBlockedHosts) readyBlockedHosts = Object.create(null);
        readyBlockedHosts[probeHostKey] = true;
      }
    }
    return null;
  }

  function dispatchRoundRobinTier(threadsList, cursorThreadId, tier, ordinaryLimit, hasOrdinaryWaiting, allowPreempt, maxCount, now, settings, outBatch) {
    if (!threadsList.length || maxCount <= 0) return { count: 0, cursor: cursorThreadId };
    var start = 0;
    if (cursorThreadId) {
      for (var c = 0; c < threadsList.length; c++) {
        if (threadsList[c].id === cursorThreadId) {
          start = (c + 1) % threadsList.length;
          break;
        }
      }
    }
    var idx = start;
    var missed = 0;
    var dispatched = 0;
    var lastId = cursorThreadId;
    var totalLimit = ATPHostHealth.getTotalImageSlotLimit(settings);

    while (missed < threadsList.length && dispatched < maxCount) {
      if (!allowPreempt && ATPHostHealth.getGlobalActive() >= totalLimit) break;
      var ts = threadsList[idx % threadsList.length];
      idx++;
      var picked = pickAdmittedTaskFromThread(ts, tier, ordinaryLimit, hasOrdinaryWaiting, allowPreempt, now, settings, outBatch);
      if (picked) {
        ATPHostHealth.claimSlot(picked.task, settings);
        syncLegacyActiveCounter();
        outBatch.push({
          task: picked.task,
          tier: tier,
          expiredSibling: picked.expiredSibling,
          expiredReplacement: picked.expiredReplacement
        });
        lastId = ts.id;
        dispatched++;
        missed = 0;
      } else {
        missed++;
      }
    }
    return { count: dispatched, cursor: lastId };
  }

  function prepareWrapperForBatchItem(item, settings) {
    var task = item.task;
    var w = (settings && settings.thumbWidth) || 110;
    var h = (settings && settings.thumbHeight) || 82;
    var cols = (settings && settings.gridCols) || 5;
    var src = getTaskImageSrc(task);

    var wrapper = item.manualWrapper || task.pausedWrapper || null;
    var loadingEl = item.manualLoadingEl || task.pausedLoadingEl || null;
    var isExisting = !!(wrapper && (typeof document === 'undefined' || !document.contains || document.contains(wrapper)));
    task.pausedWrapper = null;
    task.pausedLoadingEl = null;

    if (!isExisting) {
      wrapper = document.createElement('div');
      wrapper.className = 'atp-thumbnail-wrapper';
      if (wrapper.classList && wrapper.classList.add) wrapper.classList.add('atp-thumbnail-wrapper');
    } else {
      FAILED_WRAPPERS.delete(wrapper);
      clearPreviewActivation(wrapper);
      clearHeavyWrapperVisualState(wrapper);
      if (wrapper.classList) {
        wrapper.classList.remove('atp-thumbnail-failed');
        wrapper.classList.remove('atp-heavy-thumbnail');
        wrapper.classList.remove('atp-gif-frozen');
      }
      if (item.isManualRetry && (!loadingEl || loadingEl.parentNode !== wrapper)) {
        wrapper.innerHTML = '';
        if (Array.isArray(wrapper.children)) wrapper.children.length = 0;
        loadingEl = null;
      } else {
        var oldImg = wrapper.querySelector && wrapper.querySelector('.atp-thumbnail-img');
        if (oldImg && oldImg.parentNode) oldImg.parentNode.removeChild(oldImg);
      }
    }

    if (task.grid && typeof task.idx === 'number') {
      wrapper.style.gridColumnStart = (task.idx % cols) + 1;
      wrapper.style.gridRowStart = Math.floor(task.idx / cols) + 1;
    }
    wrapper.style.width = w + 'px';
    wrapper.style.height = h + 'px';

    wrapper.__atpRetryQueued = false;
    if (wrapper.dataset) {
      wrapper.dataset.atpState = 'loading';
      wrapper.dataset.atpThreadId = task.threadId || '';
      if (typeof task.idx === 'number') wrapper.dataset.atpIdx = String(task.idx);
      delete wrapper.dataset.atpRetryQueued;
    }
    WRAPPER_TASK_MAP.set(wrapper, task);
    wrapper.__atpLoadTask = task;

    if (isHeavyChannelSrc(src, settings)) {
      if (wrapper.classList) {
        wrapper.classList.add('atp-heavy-thumbnail');
        wrapper.classList.add('atp-heavy-preview-pending');
      }
    }

    if (!loadingEl || !loadingEl.parentNode) {
      loadingEl = document.createElement('div');
      loadingEl.className = 'atp-thumbnail-loading';
      if (loadingEl.classList && loadingEl.classList.add) loadingEl.classList.add('atp-thumbnail-loading');
      loadingEl.style.width = w + 'px';
      loadingEl.style.height = h + 'px';
      wrapper.appendChild(loadingEl);
    }

    item.wrapper = wrapper;
    item.loadingEl = loadingEl;
    item.needsAppend = !isExisting && !!task.grid;
  }

  function finalizeLoadedThumbnail(wrapper, loadingEl, img, task, loadReason) {
    if (root.ATPViewport && ATPViewport.unobserveLoadingAnimation) {
      ATPViewport.unobserveLoadingAnimation(wrapper);
    }
    logImageDone(task, true, loadReason, isDebugTelemetryEnabled() ? getImageMetrics(img) : null);
    syncLegacyActiveCounter();

    if (!isTaskCurrent(task)) {
      removeWrapper(wrapper);
      requestSchedule('stale_done');
      return;
    }

    var src = img.currentSrc || img.src || getTaskImageSrc(task);
    var elapsed = task.currentSrcStartedAt ? Math.max(0, Date.now() - task.currentSrcStartedAt) : 0;
    if (root.ATPHostHealth) {
      ATPHostHealth.recordDomainSuccess(src, task, elapsed, ATPLoader.getConc());
    }

    FAILED_WRAPPERS.delete(wrapper);
    if (wrapper.classList) wrapper.classList.remove('atp-thumbnail-failed');

    var heavyTask = isHeavyChannelTask(task);
    if (heavyTask && root.ATPViewport && ATPViewport.monitorLoadedHeavyImage) {
      ATPViewport.monitorLoadedHeavyImage(wrapper, img, task);
    } else {
      clearHeavyWrapperVisualState(wrapper);
      freezeAnimatedThumbnail(wrapper, img, task);
    }

    if (loadingEl && loadingEl.parentNode) loadingEl.remove();
    if (!wrapper.classList || !wrapper.classList.contains('atp-heavy-unloaded')) {
      img.style.display = 'block';
    }
    img.style.cursor = 'pointer';
    img.onclick = onThumbnailImgClick;

    bindPreviewActivation(wrapper, function (preferOpenerFocus) {
      openPreviewFromWrapper(wrapper, preferOpenerFocus);
    }, task);

    if (task.manualRetry) {
      var ts = getThreadState(task.threadId);
      if (ts) {
        if (task.wasCountedFailed && ts.failedCount > 0) ts.failedCount--;
        ts.consecutiveFails = 0;
      }
    }
    ATPLoader.threadImageDone(task, true);
  }

  function finalizeFailedThumbnail(wrapper, loadingEl, task, failReason, src) {
    if (root.ATPViewport && ATPViewport.unobserveLoadingAnimation) {
      ATPViewport.unobserveLoadingAnimation(wrapper);
    }
    logImageDone(task, false, failReason);
    syncLegacyActiveCounter();

    if (!isTaskCurrent(task)) {
      removeWrapper(wrapper);
      requestSchedule('stale_fail');
      return;
    }

    if (task.manualRetry) {
      ATPLoader.showFailedPlaceholder(wrapper, loadingEl, task, src);
      requestSchedule('manual_retry_failed');
      return;
    }

    task.pausedWrapper = wrapper;
    task.pausedLoadingEl = loadingEl;
    if (!ATPLoader.handleFail(task)) {
      task.pausedWrapper = null;
      task.pausedLoadingEl = null;
      ATPLoader.showFailedPlaceholder(wrapper, loadingEl, task, src);
    }
  }

  function launchAdmittedItem(item, settings) {
    var task = item.task;
    var wrapper = item.wrapper;
    var loadingEl = item.loadingEl;
    var src = getTaskImageSrc(task);

    if (!src || item.expiredSibling || item.expiredReplacement) {
      if (root.ATPHostHealth) ATPHostHealth.releaseSlot(task, task.activeSlotToken);
      syncLegacyActiveCounter();
      if (!src) {
        ATPLoader.threadImageDone(task, false);
      } else {
        finalizeFailedThumbnail(wrapper, loadingEl, task, item.expiredReplacement ? 'deadline_exhausted' : 'sibling_unavailable', src);
      }
      return;
    }

    if (root.ATPViewport && ATPViewport.observeLoadingAnimation) {
      ATPViewport.observeLoadingAnimation(wrapper);
    }

    var preemptedSlot = !!(task && task.__preemptedSlot);
    if (task) task.__preemptedSlot = false;

    ATPImageRunner.run(task, {
      wrapper: wrapper,
      loadingEl: loadingEl,
      existingImg: item.existingImg || null,
      slotToken: task.activeSlotToken,
      tier: item.tier,
      preemptedSlot: preemptedSlot,
      settings: settings,
      ordinaryConc: ATPLoader.getConc(),
      isTaskCurrent: isTaskCurrent,
      tryCandidateFallback: selectReplacementCandidateForTask,
      onBeforeAttachmentSwap: onBeforeAttachmentSwap,
      onEvent: logImageEvent,
      onRequestStart: noteFirstScreenRequestStart,
      onRequestEnd: noteFirstScreenRequestEnd,
      onSiblingFailover: function () {
        syncLegacyActiveCounter();
        task.pausedWrapper = wrapper;
        task.pausedLoadingEl = loadingEl;
        if (!requeueTaskToThread(task, 'sibling_host')) {
          removeWrapper(wrapper);
          return;
        }
        ATPLoader.globalSchedule('sibling_host');
      },
      shouldRequeueCandidateFallback: function (t) {
        return !!(t && t.readyImageQueue && getThreadState(t.threadId));
      },
      onCandidateRequeue: function () {
        syncLegacyActiveCounter();
        task.pausedWrapper = wrapper;
        task.pausedLoadingEl = loadingEl;
        if (!requeueTaskToThread(task, 'candidate_fallback')) {
          removeWrapper(wrapper);
          return;
        }
        ATPLoader.globalSchedule('candidate_fallback');
      },
      onSuccess: function (img, loadedSrc) {
        finalizeLoadedThumbnail(wrapper, loadingEl, img, task, item.isManualRetry ? 'retry_load' : 'direct_load');
      },
      onFailure: function (reason, failedSrc) {
        var finalReason = reason;
        if (item.viewportWrapperData && reason !== 'deadline_exhausted') {
          finalReason = 'viewport_fail';
        }
        finalizeFailedThumbnail(wrapper, loadingEl, task, finalReason, failedSrc || src);
      },
      onPreempt: function (reason) {
        syncLegacyActiveCounter();
        if (task) task.loadStartAt = 0;
        noteFirstScreenViewportWait(task);
        if (item.viewportWrapperData) {
          item.viewportWrapperData.loaded = false;
          if (root.ATPViewport && ATPViewport.observe) {
            ATPViewport.observe(wrapper, task, item.viewportWrapperData.imgData, item.viewportWrapperData);
          }
          return;
        }
        task.pausedWrapper = wrapper;
        task.pausedLoadingEl = loadingEl;
        if (item.isManualRetry) {
          MANUAL_IMAGE_RETRIES.unshift({ task: task, wrapper: wrapper, loadingEl: loadingEl });
        } else if (reason === HIDDEN_PAUSE_CANCEL_REASON && !task.isFirstScreen && !task.readyImageQueue) {
          if (isTaskCurrent(task)) {
            BG_TASKS.unshift(task);
            BG_TASKS_VERSION++;
          } else {
            removeWrapper(wrapper);
          }
        } else if (!requeueTaskToThread(task, reason)) {
          removeWrapper(wrapper);
        }
      }
    });
  }

  function drainLegacyBgTasksIntoThreads() {
    if (!BG_TASKS.length) return;
    var remaining = [];
    for (var i = 0; i < BG_TASKS.length; i++) {
      var task = BG_TASKS[i];
      if (!isTaskCurrent(task)) continue;
      var ts = getThreadState(task.threadId);
      var q = ensureThreadQueue(ts);
      if (q) q.tasks.push(task);
      else remaining.push(task);
    }
    BG_TASKS.length = 0;
    for (var r = 0; r < remaining.length; r++) BG_TASKS.push(remaining[r]);
    BG_TASKS_VERSION++;
  }

  function runSchedulePass(reason) {
    if (GLOBAL_PAUSED || GLOBAL_SCHEDULING) return;
    GLOBAL_SCHEDULING = true;

    try {
      var settings = getCurrentSettings();
      var now = Date.now();
      var bypassHidden = shouldBypassViewportLazyLoad(settings);
      var pauseHidden = ATPLoadPolicy.isPauseWhenHiddenEnabled(settings) &&
        typeof document !== 'undefined' && document.visibilityState !== 'visible';
      if (pauseHidden) return;

      drainLegacyBgTasksIntoThreads();

      // Phase 1: Pure JS state & cached band classification (ZERO DOM writes, ZERO getBoundingClientRect!)
      var threads = (root.ATPState && root.ATPState.threads) || {};
      var anyIO = !!(root.ATPViewport && ATPViewport.hasDeliveredIntersections && ATPViewport.hasDeliveredIntersections());
      var p0Threads = [];
      var p1Threads = [];
      var p2Threads = [];
      var p3Threads = [];
      var hasOrdinaryWaiting = false;
      var hasRemainingP3Work = false;
      var autoOffscreen = ATPLoadPolicy.isAutoLoadOffscreenFirstRowsEnabled(settings);
      var ordinal = 0;

      for (var tid in threads) {
        if (!Object.prototype.hasOwnProperty.call(threads, tid)) continue;
        var ts = threads[tid];
        if (ts && !ts.id) ts.id = tid;
        if (!isThreadCurrent(ts)) continue;
        var q = ensureThreadQueue(ts);
        var hasQueued = getThreadQueuedCount(ts) > 0;
        var band = getThreadBand(ts, ordinal++, anyIO);
        ts.__liveScheduleBand = band;
        if (!hasQueued) continue;

        if (!ts.heavyMode) hasOrdinaryWaiting = true;

        if (tid === HOVERED_THREAD_ID || tid === FOCUSED_THREAD_ID) {
          p0Threads.push(ts);
        } else if (band === 0) {
          p1Threads.push(ts);
        } else if (band === 1) {
          p2Threads.push(ts);
        } else if ((band === 2 && !ts.readyImageQueue) || autoOffscreen || (bypassHidden && !(ts.readyImageQueue && ts.readyImageVisible === false))) {
          p3Threads.push(ts);
        }
      }

      var hiddenTab = typeof document !== 'undefined' && document.visibilityState !== 'visible';
      var bgConc = ATPLoader.getBgConc();
      var maxOrdinary = hiddenTab ? bgConc : ATPLoader.getConc();
      var admittedBatch = [];

      // 1. Dispatch P0: Manual retries + hovered/focused thread boost
      for (var mi = 0; mi < MANUAL_IMAGE_RETRIES.length;) {
        var retryEntry = MANUAL_IMAGE_RETRIES[mi];
        var rTask = retryEntry && retryEntry.task;
        if (!rTask || !isTaskCurrent(rTask) ||
            (typeof document !== 'undefined' && document.contains && retryEntry.wrapper && !document.contains(retryEntry.wrapper))) {
          MANUAL_IMAGE_RETRIES.splice(mi, 1);
          continue;
        }
        rTask.tier = 0;
        rTask.currentlyVisible = true;
        rTask.viewportPriority = true;
        var mCheck = ATPHostHealth.checkTaskAdmission(rTask, maxOrdinary, true, {
          settings: settings,
          onBeforeAttachmentSwap: onBeforeAttachmentSwap,
          onRestoreAttachment: onRestoreAttachment
        });
        if (!mCheck.admit && tryPreemptP3ForUrgentTask(rTask, mCheck, now, admittedBatch)) {
          mCheck = ATPHostHealth.checkTaskAdmission(rTask, maxOrdinary, true, {
            settings: settings,
            onBeforeAttachmentSwap: onBeforeAttachmentSwap,
            onRestoreAttachment: onRestoreAttachment
          });
        }
        if (mCheck.admit) {
          MANUAL_IMAGE_RETRIES.splice(mi, 1);
          ATPHostHealth.claimSlot(rTask, settings);
          syncLegacyActiveCounter();
          admittedBatch.push({
            task: rTask,
            tier: 0,
            isManualRetry: true,
            manualWrapper: retryEntry.wrapper,
            manualLoadingEl: retryEntry.loadingEl || null,
            expiredSibling: !!mCheck.expiredSibling
          });
        } else {
          mi++;
        }
      }

      if (p0Threads.length) {
        dispatchRoundRobinTier(p0Threads, '', 0, maxOrdinary, hasOrdinaryWaiting, true, Infinity, now, settings, admittedBatch);
      }

      // Also wake any parked wrappers in ATPViewport at band 0 / 1
      if (root.ATPViewport && ATPViewport.retryActualVisiblePending) {
        ATPViewport.retryActualVisiblePending();
      }

      // 2. Dispatch P1: Visible (band === 0) round-robin across visible threads (with 250ms P3 preemption!)
      if (p1Threads.length) {
        var p1Res = dispatchRoundRobinTier(p1Threads, p1CursorThreadId, 1, maxOrdinary, hasOrdinaryWaiting, true, Infinity, now, settings, admittedBatch);
        p1CursorThreadId = p1Res.cursor;
      }

      // 3. Dispatch P2: Near-viewport (band === 1, <= 480px) prefetch
      if (p2Threads.length) {
        var p2Res = dispatchRoundRobinTier(p2Threads, p2CursorThreadId, 2, maxOrdinary, hasOrdinaryWaiting, false, Infinity, now, settings, admittedBatch);
        p2CursorThreadId = p2Res.cursor;
      }
      if (root.ATPViewport && ATPViewport.retryVisiblePending) {
        ATPViewport.retryVisiblePending(false);
      }
      if (bypassHidden && root.ATPViewport && ATPViewport.loadPendingWhenHidden) {
        ATPViewport.loadPendingWhenHidden(bgConc);
      }

      // 4. Dispatch P3: Prefetch/offscreen (band >= 2) paced by getBackgroundDelay & paused during fast scroll
      var fastScrolling = !!(root.ATPViewport && ATPViewport.isFastScrolling && ATPViewport.isFastScrolling());
      if (p3Threads.length && !fastScrolling) {
        var bgDelay = ATPLoadPolicy.getBackgroundDelay(settings);
        var elapsedSinceP3 = now - lastP3DispatchAt;
        if (bgDelay > 0 && lastP3DispatchAt > 0 && elapsedSinceP3 < bgDelay) {
          scheduleP3Timer(bgDelay - elapsedSinceP3);
        } else {
          var p3Limit = autoOffscreen
            ? Math.min(maxOrdinary, Math.max(bgConc, ATPLoadPolicy.getOffscreenFirstRowOrdinaryLimit(settings)))
            : bgConc;
          var p3Cap = bgDelay > 0 ? Math.max(1, p3Limit) : Infinity;
          var p3Res = dispatchRoundRobinTier(p3Threads, p3CursorThreadId, 3, p3Limit, hasOrdinaryWaiting, false, p3Cap, now, settings, admittedBatch);
          p3CursorThreadId = p3Res.cursor;
          if (p3Res.count > 0) lastP3DispatchAt = now;

          for (var p3i = 0; p3i < p3Threads.length; p3i++) {
            if (getThreadQueuedCount(p3Threads[p3i]) > 0) {
              hasRemainingP3Work = true;
              break;
            }
          }
          if (hasRemainingP3Work && bgDelay > 0) {
            scheduleP3Timer(bgDelay);
          }
        }
      }

      // Phase 2: Batched DOM Write Phase using DocumentFragment per grid (ZERO layout reads!)
      if (admittedBatch.length) {
        var fragmentsByGrid = new Map();
        for (var bi = 0; bi < admittedBatch.length; bi++) {
          var batchItem = admittedBatch[bi];
          prepareWrapperForBatchItem(batchItem, settings);
          if (batchItem.needsAppend && batchItem.task.grid) {
            var grid = batchItem.task.grid;
            ensureGridDelegation(grid);
            var frag = fragmentsByGrid.get(grid);
            if (!frag) {
              frag = (typeof document !== 'undefined' && typeof document.createDocumentFragment === 'function')
                ? document.createDocumentFragment()
                : [];
              fragmentsByGrid.set(grid, frag);
            }
            if (Array.isArray(frag)) frag.push(batchItem.wrapper);
            else frag.appendChild(batchItem.wrapper);
          }
        }

        fragmentsByGrid.forEach(function (frag, grid) {
          if (Array.isArray(frag)) {
            for (var fi = 0; fi < frag.length; fi++) grid.appendChild(frag[fi]);
          } else {
            grid.appendChild(frag);
          }
        });

        for (var li = 0; li < admittedBatch.length; li++) {
          launchAdmittedItem(admittedBatch[li], settings);
        }
      }

      if (isDebugTelemetryEnabled()) {
        logEventThrottled('schedule_state', 'schedule_state', function () {
          return Object.assign({ reason: reason || 'schedule' }, getQueueSnapshotFields());
        }, 2000);
      }
    } finally {
      GLOBAL_SCHEDULING = false;
      syncLegacyActiveCounter();
    }
  }

  // --- Visibility Lifecycle ---

  function syncVisibilityPauseState(settings, shouldSchedule) {
    settings = settings || getCurrentSettings();
    var hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
    var pauseEnabled = ATPLoadPolicy.isPauseWhenHiddenEnabled(settings);

    setFirstScreenTimingHiddenPause(hidden && pauseEnabled);
    if (root.ATPViewport && ATPViewport.syncLoadingAnimationVisibility) {
      ATPViewport.syncLoadingAnimationVisibility();
    }

    if (!pauseEnabled || !hidden) {
      GLOBAL_PAUSED = false;
      resumeDeferredHeavyThreads();
      if (root.ATPViewport) {
        if (!hidden && ATPViewport.clearHiddenLoadFlags) ATPViewport.clearHiddenLoadFlags();
        if (!hidden && shouldSchedule && ATPViewport.retryPendingSlotLoads) ATPViewport.retryPendingSlotLoads();
        if (ATPViewport.resumeHeavyRestores) ATPViewport.resumeHeavyRestores('visibility_resume');
      }
      if (shouldSchedule) ATPLoader.globalSchedule('visibility_resume');
      return;
    }

    GLOBAL_PAUSED = true;
    cancelPendingScheduleRequest();
    clearViewportSlotWakeTimer();
    clearP3Timer();
    clearPreemptWakeTimer();
    if (root.ATPImageRunner) ATPImageRunner.cancelAll(HIDDEN_PAUSE_CANCEL_REASON);
    syncLegacyActiveCounter();
    if (root.ATPHostHealth) ATPHostHealth.clearWakeTimers();
    clearDeferredHeavyThreadWakeTimers();
    if (root.ATPViewport) {
      if (ATPViewport.clearHiddenLoadFlags) ATPViewport.clearHiddenLoadFlags();
      if (ATPViewport.clearPendingRetryTimers) ATPViewport.clearPendingRetryTimers();
      if (ATPViewport.pauseHeavyRestores) ATPViewport.pauseHeavyRestores();
    }
  }

  function reconfigureLoader(settings) {
    settings = settings || getCurrentSettings();
    clearP3Timer();
    clearPreemptWakeTimer();
    clearDeferredHeavyThreadWakeTimers();
    if (root.ATPHostHealth) ATPHostHealth.reconfigure(settings);
    if (settings.animatedThumbnailMode) applyAnimatedMode(settings.animatedThumbnailMode);
    if (!GLOBAL_PAUSED) {
      resumeDeferredHeavyThreads();
      if (root.ATPViewport && ATPViewport.reconfigure) {
        ATPViewport.reconfigure('loader_reconfigure');
      }
      requestSchedule('reconfigure');
    }
    return ATPLoadPolicy.getPublicSnapshot(settings);
  }

  function discardThreadImages(threadIds) {
    if (!threadIds) return;
    function belongs(task) {
      return !!(task && threadIds.has(task.threadId));
    }
    if (root.ATPImageRunner) {
      ATPImageRunner.cancelWhere(belongs, 'thread_removed');
    }
    if (root.ATPHostHealth) {
      ATPHostHealth.releaseSlotsWhere(belongs);
    }
    syncLegacyActiveCounter();
    BG_TASKS = BG_TASKS.filter(function (t) { return !belongs(t); });
    BG_TASKS_VERSION++;
    MANUAL_IMAGE_RETRIES = MANUAL_IMAGE_RETRIES.filter(function (r) { return !belongs(r && r.task); });
    FAILED_WRAPPERS.forEach(function (wrapper) {
      var task = WRAPPER_TASK_MAP.get(wrapper) || wrapper.__atpLoadTask;
      if (belongs(task)) FAILED_WRAPPERS.delete(wrapper);
    });
    GIF_WRAPPERS.forEach(function (wrapper) {
      var task = WRAPPER_TASK_MAP.get(wrapper) || wrapper.__atpLoadTask;
      if (belongs(task)) GIF_WRAPPERS.delete(wrapper);
    });
    threadIds.forEach(function (id) {
      if (HOVERED_THREAD_ID === id) HOVERED_THREAD_ID = '';
      if (FOCUSED_THREAD_ID === id) FOCUSED_THREAD_ID = '';
      clearDeferredHeavyThreadTimer(id);
      delete DEFERRED_HEAVY_THREADS[id];
    });
    if (root.ATPViewport && ATPViewport.discardThreadImages) {
      ATPViewport.discardThreadImages(threadIds);
    }
    requestSchedule('threads_discarded');
  }

  function clearViewportSlotWakeTimer() {
    if (viewportSlotWakeTimer !== null) {
      clearTimeout(viewportSlotWakeTimer);
      viewportSlotWakeTimer = null;
    }
  }

  function scheduleViewportSlotWake() {
    if (GLOBAL_PAUSED || viewportSlotWakeTimer !== null) return;
    viewportSlotWakeTimer = setTimeout(function () {
      viewportSlotWakeTimer = null;
      if (GLOBAL_PAUSED) return;
      var settings = getCurrentSettings();
      if (root.ATPViewport && !shouldBypassViewportLazyLoad(settings)) {
        if (ATPViewport.retryPendingSlotLoads) ATPViewport.retryPendingSlotLoads();
      }
      runSchedulePass('slot_released');
    }, 0);
  }

  function hasOrdinaryWorkWaiting() {
    var threads = (root.ATPState && root.ATPState.threads) || {};
    for (var tid in threads) {
      if (!Object.prototype.hasOwnProperty.call(threads, tid)) continue;
      var ts = threads[tid];
      if (!isThreadCurrent(ts) || ts.heavyMode) continue;
      if (getThreadQueuedCount(ts) > 0) return true;
    }
    if (BG_TASKS.length > 0) {
      var bg = getBgTasksCachedCounts();
      if (bg.ordinary > 0) return true;
    }
    return false;
  }

  function getBgTasksCachedCounts() {
    if (!BG_TASKS.length) return { ordinary: 0, heavy: 0 };
    if (BG_TASKS_CACHE_VER === BG_TASKS_VERSION && BG_TASKS_CACHE_LEN === BG_TASKS.length) {
      return BG_TASKS_CACHE_COUNTS;
    }
    var ord = 0;
    var heavy = 0;
    var settings = getCurrentSettings();
    for (var i = 0; i < BG_TASKS.length; i++) {
      var t = BG_TASKS[i];
      if (!t) continue;
      if (isHeavyChannelTask(t, settings)) heavy++;
      else ord++;
    }
    BG_TASKS_CACHE_VER = BG_TASKS_VERSION;
    BG_TASKS_CACHE_LEN = BG_TASKS.length;
    BG_TASKS_CACHE_COUNTS = { ordinary: ord, heavy: heavy };
    return BG_TASKS_CACHE_COUNTS;
  }

  function getQueueSnapshotFields() {
    var threads = (root.ATPState && root.ATPState.threads) || {};
    var ordQueued = 0;
    var heavyQueued = 0;
    var readyQueued = 0;
    for (var tid in threads) {
      if (!Object.prototype.hasOwnProperty.call(threads, tid)) continue;
      var ts = threads[tid];
      if (!isThreadCurrent(ts)) continue;
      var count = getThreadQueuedCount(ts);
      if (ts.readyImageQueue) readyQueued += count;
      if (ts.heavyMode) heavyQueued += count;
      else ordQueued += count;
    }
    var bgCounts = getBgTasksCachedCounts();
    var active = syncLegacyActiveCounter();
    var heavyActive = root.ATPHostHealth ? ATPHostHealth.getGlobalHeavyActive() : 0;
    return Object.assign({
      active: active,
      ordinaryActive: Math.max(0, active - heavyActive),
      heavyActive: heavyActive,
      ordinaryQueue: ordQueued + bgCounts.ordinary,
      heavyQueue: heavyQueued + bgCounts.heavy,
      readyImageQueued: readyQueued,
      bgOrdinaryQueue: bgCounts.ordinary,
      bgHeavyQueue: bgCounts.heavy,
      bgQueueLength: BG_TASKS.length + ordQueued + heavyQueued,
      manualImageQueued: MANUAL_IMAGE_RETRIES.length,
      viewportPending: root.ATPViewport && ATPViewport.getPendingCount ? ATPViewport.getPendingCount() : 0,
      heavyRestoreQueued: root.ATPViewport && ATPViewport.getHeavyRestoreQueueCount ? ATPViewport.getHeavyRestoreQueueCount() : 0,
      paused: !!GLOBAL_PAUSED
    }, root.ATPHostHealth ? ATPHostHealth.getOrdinaryHostActiveTopFields() : {});
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', function () {
      flushDiagnosticSummary('pagehide');
    });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') flushDiagnosticSummary('hidden');
    });
  }

  // --- Public ATPLoader API ---

  var ATPLoader = {
    isPaused: function () { return GLOBAL_PAUSED; },
    getSettings: getCurrentSettings,
    getConc: function () {
      var s = getCurrentSettings();
      return (s && s.firstScreenConcurrency) || 3;
    },
    getBgConc: function () {
      var s = getCurrentSettings();
      return (s && s.backgroundConcurrency) || 1;
    },
    getActive: function () { return syncLegacyActiveCounter(); },
    getHeavyActive: function () {
      return root.ATPHostHealth ? ATPHostHealth.getGlobalHeavyActive() : 0;
    },
    getBgTasks: function () { return BG_TASKS; },
    _getQueueSnapshotForVerify: getQueueSnapshotFields,

    // Frame-friendly coalesced scheduler entry point
    requestSchedule: requestSchedule,

    // Direct synchronous scheduler entry point
    globalSchedule: function (reason) {
      if (GLOBAL_PAUSED || GLOBAL_SCHEDULING) return;
      cancelPendingScheduleRequest();
      GLOBAL_SCHEDULING = true;
      try {
        if (root.ATPViewport && ATPViewport.retryActualVisiblePending) {
          ATPViewport.retryActualVisiblePending();
        }
      } finally {
        GLOBAL_SCHEDULING = false;
      }
      ATPLoader.roundRobinSchedule(reason || 'global_schedule');
    },
    roundRobinSchedule: function (reason) {
      runSchedulePass(reason || 'round_robin');
    },
    processBgTasks: function () {
      runSchedulePass('process_bg');
    },
    scheduleBgQueue: function () {
      if (GLOBAL_PAUSED) return;
      var settings = getCurrentSettings();
      var delay = ATPLoadPolicy.getBackgroundDelay(settings);
      clearP3Timer();
      if (delay > 0) {
        scheduleP3Timer(delay);
      } else {
        requestSchedule('bg_queue');
      }
    },

    // Live control & O(threads) telemetry for FloatingPanel quick console
    retryAllFailedImages: function () {
      if (typeof document !== 'undefined' && document.querySelectorAll) {
        var domFailed = document.querySelectorAll('.atp-thumbnail-failed');
        for (var i = 0; i < domFailed.length; i++) FAILED_WRAPPERS.add(domFailed[i]);
      }
      var retried = 0;
      var list = Array.from(FAILED_WRAPPERS);
      for (var j = 0; j < list.length; j++) {
        var wrapper = list[j];
        if (!wrapper || (typeof document !== 'undefined' && document.contains && !document.contains(wrapper))) {
          FAILED_WRAPPERS.delete(wrapper);
          continue;
        }
        if (wrapper.classList && !wrapper.classList.contains('atp-thumbnail-failed')) {
          FAILED_WRAPPERS.delete(wrapper);
          continue;
        }
        if (enqueueManualRetryFromWrapper(wrapper, true)) {
          retried++;
        }
      }
      if (retried > 0 && !GLOBAL_PAUSED) {
        requestSchedule('retry_all_failed');
      }
      return retried;
    },

    getLivePageStats: function () {
      var threads = (root.ATPState && root.ATPState.threads) || {};
      var queuedImages = MANUAL_IMAGE_RETRIES.length;
      var loadedThreads = 0;
      var totalThreads = 0;
      var failedImages = 0;

      for (var tid in threads) {
        if (!Object.prototype.hasOwnProperty.call(threads, tid)) continue;
        var ts = threads[tid];
        if (ts && !ts.id) ts.id = tid;
        if (!isThreadCurrent(ts)) continue;
        totalThreads++;
        var tQueued = getThreadQueuedCount(ts);
        queuedImages += tQueued;
        failedImages += ts.failedCount || 0;
        var candTotal = getThreadCandidateCount(ts);
        if (candTotal === 0 || (ts.firstScreenDone && tQueued === 0 && getThreadSettledCount(ts) >= getThreadStatusTotal(ts))) {
          loadedThreads++;
        }
      }

      return {
        paused: !!GLOBAL_PAUSED,
        activeLoads: syncLegacyActiveCounter(),
        queuedImages: queuedImages,
        loadedThreads: loadedThreads,
        totalThreads: totalThreads,
        failedImages: failedImages
      };
    },

    applyAnimatedMode: applyAnimatedMode,

    // Slot & Host Health delegation
    acquireSlot: function (task) {
      var settings = getCurrentSettings();
      var limit = task && (task.isFirstScreen || isPriorityImageTask(task))
        ? ATPLoader.getConc()
        : ATPLoader.getBgConc();
      var check = ATPHostHealth.checkTaskAdmission(task, limit, hasOrdinaryWorkWaiting(), {
        settings: settings,
        heavyScrollDeferred: !!(root.ATPViewport && ATPViewport.isScrolling && ATPViewport.isScrolling() &&
          !(task && task.manualRetry) && isHeavyChannelTask(task, settings)),
        onBeforeAttachmentSwap: onBeforeAttachmentSwap,
        onRestoreAttachment: onRestoreAttachment
      });
      if (!check.admit) {
        if (check.reason === 'ordinary_large_lane' && task && !task.ordinaryHostDeferredLogged) {
          task.ordinaryHostDeferredLogged = true;
          logImageEvent('image_defer', task, {
            reason: 'ordinary_large_lane',
            ordinaryHostLargeActive: check.snapshot && check.snapshot.ordinaryHostLargeActive
          });
        }
        return false;
      }
      ATPHostHealth.claimSlot(task, settings);
      syncLegacyActiveCounter();
      return true;
    },

    releaseSlot: function (task, slotToken) {
      var released = root.ATPHostHealth ? ATPHostHealth.releaseSlot(task, slotToken) : false;
      syncLegacyActiveCounter();
      if (released && !GLOBAL_PAUSED) scheduleViewportSlotWake();
      return released;
    },

    getAvailableSlots: function () {
      var settings = getCurrentSettings();
      var total = ATPHostHealth.getTotalImageSlotLimit(settings);
      return Math.max(0, total - syncLegacyActiveCounter());
    },

    getActiveSlotToken: function (task) {
      return task ? task.activeSlotToken : null;
    },

    isImageSlotCurrent: function (task, slotToken) {
      return root.ATPHostHealth ? ATPHostHealth.isSlotCurrent(task, slotToken) : true;
    },

    resetActiveImageSlots: function (reason) {
      clearPreemptWakeTimer();
      if (root.ATPImageRunner) ATPImageRunner.cancelAll(reason || 'reset');
      if (root.ATPHostHealth) ATPHostHealth.resetSlots();
      syncLegacyActiveCounter();
    },

    suspendActiveImageSlotsForBfcache: function () {
      clearPreemptWakeTimer();
      if (root.ATPImageRunner) ATPImageRunner.suspendForBfcache();
      if (root.ATPHostHealth) ATPHostHealth.suspendSlotsForBfcache();
      syncLegacyActiveCounter();
    },

    recoverActiveImageLoads: function (reason) {
      if (root.ATPHostHealth) ATPHostHealth.restoreSlotsFromBfcache(getCurrentSettings());
      syncLegacyActiveCounter();
      if (root.ATPImageRunner) ATPImageRunner.recoverFromBfcache(reason || 'bfcache_pageshow');
      syncLegacyActiveCounter();
    },

    teardownActiveSlots: function (reason) {
      ATPLoader.resetActiveImageSlots(reason || 'teardown');
      cancelPendingScheduleRequest();
    },

    // Direct / Viewport / Retry Execution (all unified onto ATPImageRunner.run!)
    globalLoadImage: function (task) {
      if (!isTaskCurrent(task)) {
        requestSchedule('stale_task');
        return;
      }
      var src = getTaskImageSrc(task);
      if (!src) {
        ATPLoader.threadImageDone(task, false);
        return;
      }
      var settings = getCurrentSettings();
      var item = { task: task, tier: typeof task.tier === 'number' ? task.tier : 1 };
      prepareWrapperForBatchItem(item, settings);
      if (item.needsAppend && task.grid) {
        ensureGridDelegation(task.grid);
        task.grid.appendChild(item.wrapper);
      }
      if (task.viewportRegistration && root.ATPViewport && !shouldBypassViewportLazyLoad(settings)) {
        noteFirstScreenViewportWait(task);
        ATPViewport.observe(item.wrapper, task, getTaskImageData(task));
        return;
      }
      ATPLoader.loadImageDirect(item.wrapper, item.loadingEl, task);
    },

    loadImageDirect: function (wrapper, lel, task) {
      var settings = getCurrentSettings();
      if (!task.slotActive && root.ATPHostHealth) {
        ATPHostHealth.claimSlot(task, settings);
        syncLegacyActiveCounter();
      }
      WRAPPER_TASK_MAP.set(wrapper, task);
      wrapper.__atpLoadTask = task;
      launchAdmittedItem({
        task: task,
        wrapper: wrapper,
        loadingEl: lel,
        tier: typeof task.tier === 'number' ? task.tier : (isPriorityImageTask(task) ? 1 : 3)
      }, settings);
    },

    retryLoadImage: function (task, img, loadingEl, wrapper) {
      var settings = getCurrentSettings();
      if (task && !task.slotActive && root.ATPHostHealth) {
        ATPHostHealth.claimSlot(task, settings);
        syncLegacyActiveCounter();
      }
      WRAPPER_TASK_MAP.set(wrapper, task);
      wrapper.__atpLoadTask = task;
      launchAdmittedItem({
        task: task,
        wrapper: wrapper,
        loadingEl: loadingEl,
        existingImg: img,
        isManualRetry: !!(task && task.manualRetry),
        tier: 0
      }, settings);
    },

    startViewportWrapperLoad: function (wrapper, wrapperData, forceLoad) {
      var task = wrapperData && wrapperData.task;
      if (!task || !ATPLoader.acquireSlot(task)) return false;
      var loadingEl = wrapper.querySelector ? wrapper.querySelector('.atp-thumbnail-loading') : null;
      WRAPPER_TASK_MAP.set(wrapper, task);
      wrapper.__atpLoadTask = task;
      launchAdmittedItem({
        task: task,
        wrapper: wrapper,
        loadingEl: loadingEl,
        viewportWrapperData: wrapperData,
        tier: forceLoad ? 2 : (isPriorityImageTask(task) ? 1 : 2)
      }, getCurrentSettings());
      return true;
    },

    // CSS-Class Failed State (zero 10-property inline style mutations!)
    showFailedPlaceholder: function (wrapper, loadingEl, task, src) {
      if (!wrapper) return;
      if (root.ATPViewport && ATPViewport.unobserveLoadingAnimation) {
        ATPViewport.unobserveLoadingAnimation(wrapper);
      }
      clearHeavyWrapperVisualState(wrapper);
      clearPreviewActivation(wrapper);
      if (loadingEl && loadingEl.parentNode) loadingEl.remove();
      var existingImg = wrapper.querySelector && wrapper.querySelector('.atp-thumbnail-img');
      if (existingImg) {
        existingImg.onclick = null;
        if (existingImg.parentNode) existingImg.remove();
      }
      wrapper.innerHTML = '';
      if (Array.isArray(wrapper.children)) wrapper.children.length = 0;

      if (wrapper.classList) {
        wrapper.classList.remove('atp-gif-frozen');
        wrapper.classList.add('atp-thumbnail-failed');
      }
      var settings = getCurrentSettings();
      if (!wrapper.style.width) wrapper.style.width = (settings.thumbWidth || 110) + 'px';
      if (!wrapper.style.height) wrapper.style.height = (settings.thumbHeight || 82) + 'px';

      var safeTask = task || { candidates: [{ src: src || '' }], idx: 0 };
      wrapper.__atpRetryQueued = false;
      if (wrapper.dataset) {
        wrapper.dataset.atpState = 'failed';
        wrapper.dataset.atpThreadId = safeTask.threadId || '';
        wrapper.dataset.atpIdx = String(typeof safeTask.idx === 'number' ? safeTask.idx : 0);
        delete wrapper.dataset.atpRetryQueued;
      }
      WRAPPER_TASK_MAP.set(wrapper, safeTask);
      wrapper.__atpLoadTask = safeTask;
      FAILED_WRAPPERS.add(wrapper);

      wrapper.tabIndex = 0;
      if (wrapper.setAttribute) wrapper.setAttribute('role', 'button');

      var icon = document.createElement('span');
      icon.className = 'atp-thumbnail-failed-icon';
      if (icon.classList && icon.classList.add) icon.classList.add('atp-thumbnail-failed-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '⚠';
      wrapper.appendChild(icon);

      var retryStatus = document.createElement('span');
      retryStatus.className = 'atp-thumbnail-failed-status';
      if (retryStatus.classList && retryStatus.classList.add) retryStatus.classList.add('atp-thumbnail-failed-status');
      wrapper.__atpFailedStatusEl = retryStatus;
      wrapper.appendChild(retryStatus);
      setFailedStatusText(wrapper, '加载失败，点击重试', '加载失败，点击重试', '缩略图加载失败，按 Enter 重试');

      var grid = (safeTask && safeTask.grid) || (wrapper.closest && wrapper.closest('.atp-thumbnail-container'));
      if (grid && typeof grid.addEventListener === 'function') {
        ensureGridDelegation(grid);
      }
      wrapper.onclick = onStandaloneWrapperClick;
      wrapper.onkeydown = onStandaloneWrapperKeydown;
    },

    handleFail: function (task) {
      if (!isTaskCurrent(task)) return true;
      var maxRetry = ATPLoadPolicy.getMaxRetryPerImage(getCurrentSettings());
      task.retries = (task.retries || 0) + 1;
      if (task.retries <= maxRetry) {
        task.taskDeadlineAt = 0;
        task.queueKind = task.isFirstScreen ? 'first_retry' : 'background_retry';
        requeueTaskToThread(task, 'auto_retry');
        ATPLoader.globalSchedule('auto_retry');
        return true;
      }
      ATPLoader.threadImageDone(task, false);
      return false;
    },

    threadImageDone: function (task, ok) {
      if (!isTaskCurrent(task)) return;
      var ts = getThreadState(task.threadId);
      if (!ts) return;

      if (task.readyImageQueue) {
        if (!ts.readyImageSettled) ts.readyImageSettled = new Set();
        ts.readyImageSettled.add(task.idx);
      }
      if (ok) {
        ts.loaded++;
        ts.consecutiveFails = 0;
        var loadedUrl = getTaskPreviewSrc(task);
        var loadedKey = normalizeCandidateKey(loadedUrl);
        if (loadedKey && ts.loadedUrlMap && !ts.loadedUrlMap[loadedKey]) {
          ts.loadedUrlMap[loadedKey] = true;
          ts.loadedUrls.push(loadedUrl);
          if (root.ATPCache && ATPCache.scheduleCacheFlush) {
            ATPCache.scheduleCacheFlush(task.threadId, ts.cacheWriteStartedAt);
          }
        }
      } else {
        ts.failedCount = (ts.failedCount || 0) + 1;
        ts.consecutiveFails = (ts.consecutiveFails || 0) + 1;
        if (ts.consecutiveFails === 3 && typeof Logger !== 'undefined' && Logger && Logger.warn) {
          Logger.warn('帖子连续失败', task.threadId + ' 连续失败3次，继续加载剩余候选');
        }
      }

      var flushFirstScreen = false;
      if (task.isFirstScreen && !task.firstScreenSettled) {
        settleFirstScreenTaskTiming(task, ts);
        task.firstScreenSettled = true;
        if (ok) ts.firstScreenOk++;
        else ts.firstScreenFailed++;

        if (ts.firstScreenOk + ts.firstScreenFailed >= ts.firstScreenTotal) {
          ts.firstScreenDone = true;
          var fsTiming = logFirstScreenTiming(ts, task.threadId);
          if (ts.container && ts.container.classList) ts.container.classList.add('atp-processed');
          if (ts.loaded > 0 || (typeof SharedUtils !== 'undefined' && SharedUtils.hasResourcePayload && SharedUtils.hasResourcePayload(ts.resources))) {
            flushFirstScreen = true;
            if (typeof Logger !== 'undefined' && Logger && Logger.info) {
              Logger.info('首屏完成', '已加载' + ts.loaded + ' 失败' + ts.failedCount + '/' + ts.total +
                ' 用时' + (fsTiming ? fsTiming.wallClockMs : 0) + 'ms');
            }
          }
          if (!task.readyImageQueue) ATPLoader.enqueueBgForThread(task.threadId);
        }
      }

      if (!task.readyImageQueue) {
        if (!task.isFirstScreen) releaseBackgroundBatchTask(task, ts);
        if (ts.nextIdx < getThreadCandidateCount(ts) && !ts.bgQueued && !ts.bgQueueActive) {
          ATPLoader.enqueueBgForThread(task.threadId);
        }
      }

      var complete = isThreadComplete(ts);
      if ((flushFirstScreen || (complete && (ts.loaded > 0 || (typeof SharedUtils !== 'undefined' && SharedUtils.hasResourcePayload && SharedUtils.hasResourcePayload(ts.resources))))) &&
          root.ATPCache && ATPCache.flushCacheNow) {
        ATPCache.flushCacheNow(task.threadId, complete);
      }
      queueThreadStatus(ts);
      ATPLoader.globalSchedule('image_done');
    },

    enqueueBgForThread: function (threadId) {
      var ts = getThreadState(threadId);
      if (ts && !ts.id) ts.id = threadId;
      if (!isThreadCurrent(ts)) return;
      if (ts.readyImageQueue) {
        ensureThreadQueue(ts);
        queueThreadStatus(ts);
        ATPLoader.globalSchedule('ready_demand_changed');
        return;
      }
      if (ts.bgQueued || ts.bgQueueActive || ts.backgroundUnlocked === false || !ts.firstScreenDone) return;
      var settings = getCurrentSettings();
      var deferInfo = getHeavyBackgroundDeferredInfo(ts);
      if (deferInfo) {
        ts.bgHostDeferred = true;
        var cdMs = Math.max(0, (deferInfo.healthFields && deferInfo.healthFields.heavyHostCooldownRemainingMs) || 0);
        ts.bgHostDeferredUntil = Date.now() + cdMs;
        DEFERRED_HEAVY_THREADS[threadId] = true;
        clearDeferredHeavyThreadTimer(threadId);
        DEFERRED_HEAVY_THREAD_TIMERS[threadId] = setTimeout(function () {
          wakeDeferredHeavyThread(threadId, false);
        }, Math.max(50, cdMs) + 10);
        queueThreadStatus(ts);
        return;
      }

      delete DEFERRED_HEAVY_THREADS[threadId];
      clearDeferredHeavyThreadTimer(threadId);
      ts.bgHostDeferred = false;
      ts.bgHostDeferredUntil = 0;

      var toEnqueue = getBackgroundEnqueueCount(ts, settings);
      if (toEnqueue <= 0) {
        ts.bgQueued = ts.nextIdx >= getThreadCandidateCount(ts);
        return;
      }
      var q = ensureThreadQueue(ts);
      var stagedLightweight = isLightweightHeavyThread(ts);
      ts.bgQueueActive = true;
      ts.bgBatchPending = (ts.bgBatchPending || 0) + toEnqueue;
      var now = Date.now();
      for (var i = 0; i < toEnqueue; i++) {
        BG_TASKS.push({
          candidates: ts.candidates,
          idx: ts.nextIdx++,
          threadId: threadId,
          generation: ts.generation,
          grid: ts.grid,
          isFirstScreen: false,
          backgroundBatch: true,
          createdAt: now,
          queuedAt: now,
          queueKind: stagedLightweight ? 'lightweight_background' : 'background'
        });
      }
      BG_TASKS_VERSION++;
      if (q) q.stagedIdx = Math.max(q.stagedIdx, ts.nextIdx);
      ts.bgQueued = ts.nextIdx >= getThreadCandidateCount(ts);
      ATPLoader.scheduleBgQueue();
    },

    unlockThreadBackground: function (threadId) {
      var ts = getThreadState(threadId);
      if (ts && !ts.id) ts.id = threadId;
      if (!isThreadCurrent(ts) || ts.backgroundUnlocked) return false;
      ts.backgroundUnlocked = true;
      if (ts.firstScreenDone) {
        ATPLoader.enqueueBgForThread(threadId);
      }
      if (root.ATPViewport && ATPViewport.retryVisiblePending) {
        ATPViewport.retryVisiblePending();
      }
      queueThreadStatus(ts);
      ATPLoader.globalSchedule('unlock_background');
      return true;
    },

    handleDetachedViewportTask: function (task) {
      if (!task || !isTaskCurrent(task) || task.detachedPendingRecoveryScheduled) return false;
      task.detachedPendingRecoveryScheduled = true;
      setTimeout(function () {
        task.detachedPendingRecoveryScheduled = false;
        if (!isTaskCurrent(task)) return;
        var gridConnected = !!(task.grid && (typeof document === 'undefined' || !document.contains || document.contains(task.grid)));
        if (!gridConnected) {
          ATPLoader.threadImageDone(task, false);
          return;
        }
        requeueTaskToThread(task, 'detached_pending_requeue');
        requestSchedule('detached_requeue');
      }, 0);
      return true;
    },

    // Shared helpers preserved for external modules (previewer.js, viewport-observer.js, heavy-budget.js, content.js)
    registerFirstScreenTiming: registerFirstScreenTiming,
    noteFirstScreenViewportWait: noteFirstScreenViewportWait,
    recordDomainSuccess: function (url, task) {
      if (root.ATPHostHealth) ATPHostHealth.recordDomainSuccess(url, task, undefined, ATPLoader.getConc());
    },
    recordDomainFailure: function (url, reason, task) {
      if (root.ATPHostHealth) ATPHostHealth.recordDomainFailure(url, reason, task);
    },
    recordTaskImageFailure: function (task, url, reason, finalFailure) {
      if (root.ATPHostHealth) ATPHostHealth.recordTaskImageFailure(task, url, reason, finalFailure, ATPLoader.getConc());
    },
    getPreviewCandidates: getPreviewCandidates,
    buildPreviewUrls: buildPreviewUrls,
    getCandidatePreviewSrc: getCandidatePreviewSrc,
    getCandidateDisplaySrc: getCandidateDisplaySrc,
    getTaskImageSrc: getTaskImageSrc,
    getTaskPreviewSrc: getTaskPreviewSrc,
    getTaskPreviewIndex: getTaskPreviewIndex,
    getImageLoadTimeout: function (settings, task) {
      return root.ATPHostHealth
        ? ATPHostHealth.getTaskAttemptTimeout(task, settings || getCurrentSettings())
        : ((settings && settings.imageTimeout) || 15000);
    },
    getImageMetrics: getImageMetrics,
    isDiagnosticLoggingEnabled: isDiagnosticLoggingEnabled,
    logImageDone: logImageDone,
    logRenderEvent: function (type, task, fields, level) {
      logImageEvent(type, task, fields, level);
    },
    isTaskCurrent: isTaskCurrent,
    isBackgroundImageLocked: isBackgroundImageLocked,
    isWrapperVisible: function (wrapper) {
      if (!wrapper) return false;
      if (typeof wrapper.__atpViewportBand === 'number') return wrapper.__atpViewportBand === 0;
      if (typeof wrapper.getBoundingClientRect !== 'function') {
        return !!(root.ATPViewport && ATPViewport.getBand(wrapper) === 0);
      }
      var rect = wrapper.getBoundingClientRect();
      if (!rect) return false;
      var winH = (typeof root.innerHeight === 'number' && root.innerHeight > 0)
        ? root.innerHeight
        : ((typeof document !== 'undefined' && document.documentElement && document.documentElement.clientHeight) || 800);
      var winW = (typeof root.innerWidth === 'number' && root.innerWidth > 0)
        ? root.innerWidth
        : ((typeof document !== 'undefined' && document.documentElement && document.documentElement.clientWidth) || 1280);
      if (rect.bottom <= 0 || rect.top >= winH || (typeof rect.right === 'number' && rect.right <= 0) || (typeof rect.left === 'number' && rect.left >= winW)) {
        return false;
      }
      var ancestor = wrapper.parentElement;
      while (ancestor && ancestor !== (typeof document !== 'undefined' && document.body) && ancestor !== (typeof document !== 'undefined' && document.documentElement)) {
        if (typeof root.getComputedStyle === 'function' && typeof ancestor.getBoundingClientRect === 'function') {
          var cs = root.getComputedStyle(ancestor);
          var ox = cs && cs.overflowX;
          var oy = cs && cs.overflowY;
          if ((oy && oy !== 'visible') || (ox && ox !== 'visible')) {
            var aRect = ancestor.getBoundingClientRect();
            if (aRect && (rect.bottom <= aRect.top || rect.top >= aRect.bottom ||
                (typeof aRect.right === 'number' && typeof rect.left === 'number' && rect.left >= aRect.right) ||
                (typeof aRect.left === 'number' && typeof rect.right === 'number' && rect.right <= aRect.left))) {
              return false;
            }
          }
        }
        ancestor = ancestor.parentElement;
      }
      return true;
    },
    isHeavyScrollActive: function () {
      return !!(root.ATPViewport && ATPViewport.isScrolling && ATPViewport.isScrolling());
    },
    isTaskHostCoolingDown: function (task) {
      return !!(root.ATPHostHealth && ATPHostHealth.isTaskHostCoolingDown(task));
    },
    isHeavyChannelTask: function (task) {
      return isHeavyChannelTask(task, getCurrentSettings());
    },
    isHeavyChannelSrc: function (src) {
      return isHeavyChannelSrc(src, getCurrentSettings());
    },
    isLargeImageTask: isLargeLaneTask,
    isLargeLaneBlocked: function (task) {
      var lim = task && (task.isFirstScreen || isPriorityImageTask(task))
        ? ATPLoader.getConc()
        : ATPLoader.getBgConc();
      return !!(root.ATPHostHealth && ATPHostHealth.isLargeLaneBlocked(task, lim));
    },
    isImageTaskDeadlineSpent: function (task) {
      return !!(root.ATPImageRunner && ATPImageRunner.isTaskDeadlineSpent(task));
    },
    freezeAnimatedThumbnail: freezeAnimatedThumbnail,
    setImageSource: function (img, src, noReferrer, shouldApply) {
      if (root.ATPImageRunner && ATPImageRunner.applyImageSource) {
        ATPImageRunner.applyImageSource(img, src, noReferrer, shouldApply, img && img.__atpTimingTask, noteFirstScreenRequestStart, noteFirstScreenRequestEnd);
      } else if (!shouldApply || shouldApply()) {
        img.decoding = 'async';
        if (noReferrer) img.referrerPolicy = 'no-referrer';
        else img.removeAttribute('referrerpolicy');
        img.src = src;
      }
    },
    prepareThumbnailImage: function (img, task, w, h) {
      if (root.ATPImageRunner && ATPImageRunner.prepareImageElement) {
        ATPImageRunner.prepareImageElement(img, task, { thumbWidth: w, thumbHeight: h });
      }
    },
    updateTaskViewportPriority: function (task, wrapper, visible) {
      if (!task) return false;
      visible = visible === true;
      var changed = task.currentlyVisible !== visible;
      task.currentlyVisible = visible;
      task.viewportPriority = visible;
      if (changed && task.slotActive && root.ATPHostHealth) {
        ATPHostHealth.updateSlotTask(task, undefined, getCurrentSettings());
      }
      var img = wrapper && wrapper.querySelector ? wrapper.querySelector('.atp-thumbnail-img') : null;
      if (img) {
        img.loading = (visible || task.manualRetry || task.slotActive) ? 'eager' : 'lazy';
        img.fetchPriority = (visible || task.manualRetry) ? 'high' : 'low';
      }
      return visible;
    },
    syncThreadVisibility: function (ts, visible, nextBand) {
      if (!ts) return;
      if (typeof nextBand === 'number') ts.__liveScheduleBand = nextBand;
      if (!root.ATPImageRunner || !ATPImageRunner.getActiveRunners) return;
      var vis = visible === true;
      ATPImageRunner.getActiveRunners().forEach(function (runner) {
        if (!runner || runner.isRestore || !runner.task || runner.task.threadId !== ts.id) return;
        if (runner.wrapper && typeof runner.wrapper.__atpViewportBand === 'number') return;
        ATPLoader.updateTaskViewportPriority(runner.task, runner.wrapper, vis);
      });
    },
    bindPreviewActivation: bindPreviewActivation,
    clearPreviewActivation: clearPreviewActivation,
    cancelImageLoadElement: function (img) {
      if (root.ATPImageRunner) ATPImageRunner.cancelImageElement(img);
    },
    registerActiveImageLoad: function (control) {
      return root.ATPImageRunner ? ATPImageRunner.registerExternalLoad(control) : function () {};
    },
    tryHeavyCandidateFallback: function (task, img, restartTimer, shouldApply) {
      var nextSrc = selectReplacementCandidateForTask(task);
      if (!nextSrc) return false;
      if (root.ATPHostHealth && task && task.slotActive) {
        ATPHostHealth.updateSlotTask(task, nextSrc, getCurrentSettings());
      }
      if (typeof restartTimer === 'function') restartTimer();
      if (img) {
        var useNoRef = root.ATPHostHealth
          ? ATPHostHealth.shouldUseNoReferrerByDefault(nextSrc)
          : isHighFanoutImageHost(nextSrc);
        ATPLoader.setImageSource(img, nextSrc, useNoRef, shouldApply);
      }
      return true;
    },
    getViewportPendingCount: function () {
      return root.ATPViewport && ATPViewport.getPendingCount ? ATPViewport.getPendingCount() : 0;
    },
    formatThreadStatus: formatThreadStatusText,

    // Global lifecycle controls
    ensureGlobalVisListener: function () {
      if (GLOBAL_VIS_LISTENER || typeof document === 'undefined' || !document.addEventListener) return;
      GLOBAL_VIS_LISTENER = function () {
        syncVisibilityPauseState(getCurrentSettings(), true);
      };
      document.addEventListener('visibilitychange', GLOBAL_VIS_LISTENER);
      syncVisibilityPauseState(getCurrentSettings(), false);
    },

    syncVisibilityPauseState: function () {
      syncVisibilityPauseState(getCurrentSettings(), true);
    },

    reconfigure: reconfigureLoader,

    removeGlobalVisListener: function () {
      if (GLOBAL_VIS_LISTENER && typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('visibilitychange', GLOBAL_VIS_LISTENER);
        GLOBAL_VIS_LISTENER = null;
      }
      cancelPendingScheduleRequest();
      clearViewportSlotWakeTimer();
      clearP3Timer();
      clearPreemptWakeTimer();
      if (root.ATPHostHealth) ATPHostHealth.clearWakeTimers();
      clearDeferredHeavyThreadWakeTimers();
    },

    pause: function () {
      GLOBAL_PAUSED = true;
      cancelPendingScheduleRequest();
      clearViewportSlotWakeTimer();
      clearP3Timer();
      clearPreemptWakeTimer();
      if (root.ATPHostHealth) ATPHostHealth.clearWakeTimers();
      clearDeferredHeavyThreadWakeTimers();
      if (root.ATPViewport) {
        if (ATPViewport.clearPendingRetryTimers) ATPViewport.clearPendingRetryTimers();
        if (ATPViewport.pauseHeavyRestores) ATPViewport.pauseHeavyRestores();
      }
    },

    resume: function () {
      GLOBAL_PAUSED = false;
      resumeDeferredHeavyThreads();
      if (root.ATPViewport && ATPViewport.resumeHeavyRestores) {
        ATPViewport.resumeHeavyRestores('loader_resume');
      }
      requestSchedule('loader_resume');
    },

    discardThreadImages: discardThreadImages,

    clearBgTimer: function () {
      clearP3Timer();
      clearViewportSlotWakeTimer();
    },

    clearBgTasks: function () {
      flushDiagnosticSummary('clear_bg_tasks');
      cancelPendingScheduleRequest();
      clearViewportSlotWakeTimer();
      clearP3Timer();
      clearPreemptWakeTimer();
      MANUAL_IMAGE_RETRIES = [];
      BG_TASKS = [];
      BG_TASKS_VERSION++;
      FAILED_WRAPPERS.clear();
      GIF_WRAPPERS.clear();
      HOVERED_THREAD_ID = '';
      FOCUSED_THREAD_ID = '';
      p1CursorThreadId = '';
      p2CursorThreadId = '';
      p3CursorThreadId = '';
      if (root.ATPHostHealth) ATPHostHealth.clearWakeTimers();
      clearDeferredHeavyThreads();
    }
  };

  window.ATPLoader = ATPLoader;
})();
