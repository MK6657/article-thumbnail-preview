(function () {
  'use strict';

  var GLOBAL_ACTIVE = 0;
  var GLOBAL_PAUSED = false;
  var GLOBAL_SCHEDULING = false;
  var GLOBAL_BG_TIMER = null;
  var GLOBAL_BG_TIMER_KIND = '';
  var GLOBAL_BG_RETRY_TIMER = null;
  var GLOBAL_BG_RETRY_DELAY_MS = 0;
  var GLOBAL_VIEWPORT_SLOT_WAKE_TIMER = null;
  var GLOBAL_HIGH_FANOUT_ACTIVE = 0;
  var IMAGE_SLOT_EPOCH = 0;
  var ACTIVE_IMAGE_LOADS = [];
  var GLOBAL_ACTIVE_SLOTS = {};
  var IMAGE_SLOT_TOKEN = 0;
  var GLOBAL_VIS_LISTENER = null;
  var GLOBAL_SCROLL_LISTENER = null;
  var GLOBAL_SCROLL_TIMER = null;
  var GLOBAL_SCROLL_ROOT = null;
  var GLOBAL_SCROLL_CAPTURE_OPTIONS = { passive: true, capture: true };
  var HEAVY_SCROLLING = false;
  var BG_TASKS = [];
  var BG_TASKS_VERSION = 0;
  var BG_ORDINARY_CACHE_VERSION = -1;
  var BG_SNAPSHOT_CACHE = null;
  var BG_SNAPSHOT_CACHE_VERSION = -1;
  var BG_HAS_ORDINARY_TASK = false;
  var HEAVY_HOST_WAKE_TIMERS = {};
  var DEFERRED_HEAVY_THREADS = {};
  var DEFERRED_HEAVY_THREAD_TIMERS = {};
  var HIDDEN_PAUSE_CANCEL_REASON = 'hidden_pause';
  // 滚停判定：重图恢复流水线的公共前缀（这段时间内恢复队列直接 bail）。
  // 240→180ms：每次滚停省 60ms，同时给触控板惯性尾段和主线程忙时的事件延迟留余量
  // （压到 140ms 会在用户还在滚的时候提前开闸解码）
  var HEAVY_SCROLL_IDLE_MS = 180;
  var BACKGROUND_SCHEDULER_TIME_SLICE_MS = 8;
  var FIRST_TASK_VIEWPORT_MARGIN_PX = 200;
  var FIRST_TASK_NEAREST_FALLBACK_COUNT = 3;
  var DIAGNOSTIC_SUMMARY_INTERVAL_MS = 2000;
  var BG_PENDING_FULL_RETRY_MIN_MS = 500;
  var BG_PENDING_FULL_RETRY_MAX_MS = 4000;
  var LOG_THROTTLE = {};
  var DIAGNOSTIC_SUMMARY = null;
  var DIAGNOSTIC_SUMMARY_TIMER = null;

  var HEAVY_HOST_HEALTH = {
    stats: {}
  };

  var ORDINARY_HOST_HEALTH = {
    stats: {}
  };

  function isHighFanoutImageHost(url) {
    var host = getUrlHost(url);
    return !!(host && SharedUtils.isHeavyImageHost(host));
  }

  // 动图单独限流（宽度见 ATPLoadPolicy.getLargeImageHostConcurrency）：用户日志中慢图床上的
  // 失败几乎全是动图，十几张并发把带宽占满、同时卡到任务截止，同屏的静态缩略图也等不到槽位。
  function isLargeImageSrc(src) {
    return !!(src && SharedUtils.isAnimatedGifUrl && SharedUtils.isAnimatedGifUrl(src));
  }

  function isLargeLaneTask(task) {
    return !!task && !isHighFanoutTask(task) && isLargeImageSrc(getTaskImageSrc(task));
  }

  function shouldUseNoReferrerByDefault(url) {
    return isHighFanoutImageHost(url);
  }

  function getCurrentSettings() {
    return window.ATPState && window.ATPState.settings;
  }

  function isHeavyImageOptimizationEnabled(settings) {
    settings = settings || getCurrentSettings();
    return !settings || settings.heavyImageOptimization !== false;
  }

  function getHeavyImageConcurrency(settings) {
    if (!isHeavyImageOptimizationEnabled(settings)) return 0;
    return ATPLoadPolicy.getHeavyConcurrencyCeiling(settings || getCurrentSettings());
  }

  function getHighFanoutSlotLimit(settings, hasOrdinaryWork) {
    return getHighFanoutSlotLimitForTask(settings, hasOrdinaryWork, null);
  }

  function getHighFanoutSlotLimitForTask(settings, hasOrdinaryWork, task) {
    var maxSlots = getHeavyImageConcurrency(settings);
    if (maxSlots <= 0) return 0;
    if (!hasOrdinaryWork) return maxSlots;
    var ordinaryLimit = getOrdinaryImageSlotLimit(settings && settings.firstScreenConcurrency);
    var totalLimit = ATPLoadPolicy.getGlobalImageConcurrency(settings, ordinaryLimit, maxSlots);
    var remainingReserved = Math.max(
      0,
      ATPLoadPolicy.getOrdinaryReservedSlots(settings) - getActiveOrdinaryCount()
    );
    return Math.max(0, Math.min(maxSlots, totalLimit - remainingReserved));
  }

  function getOrdinaryImageSlotLimit(ordinaryLimit) {
    return Math.max(1, Number(ordinaryLimit) || 1);
  }

  function getTotalImageSlotLimit() {
    var settings = getCurrentSettings() || {};
    return ATPLoadPolicy.getGlobalImageConcurrency(
      settings,
      getOrdinaryImageSlotLimit(settings.firstScreenConcurrency),
      getHeavyImageConcurrency(settings)
    );
  }

  function getViewportPriorityReservedSlots(totalLimit) {
    totalLimit = Math.max(1, Number(totalLimit) || 1);
    return Math.max(0, Math.min(
      totalLimit - 1,
      ATPLoadPolicy.getViewportPriorityReservedSlots(getCurrentSettings() || {})
    ));
  }

  function getGlobalSlotAdmissionLimit(task, totalLimit) {
    totalLimit = Math.max(1, Number(totalLimit) || 1);
    if (!task || isPriorityImageTask(task) || isHeavyChannelTask(task, getCurrentSettings())) return totalLimit;
    return Math.max(1, totalLimit - getViewportPriorityReservedSlots(totalLimit));
  }

  function getBackgroundGlobalAdmissionLimit(totalLimit) {
    totalLimit = Math.max(1, Number(totalLimit) || 1);
    return Math.max(1, totalLimit - getViewportPriorityReservedSlots(totalLimit));
  }

  function getImageLoadTimeoutInfo(settings, task) {
    var baseTimeout = (settings && settings.imageTimeout) || 15000;
    var timeout = baseTimeout;
    var coolingTimeoutMode = '';
    var taskDeadlineRemaining;

    if (task && isHighFanoutTask(task)) {
      timeout = ATPLoadPolicy.getHeavyImageTimeout(settings);
      var health = getHeavyHostHealthLogFields(task, settings, getActiveOrdinaryCount() > 0);
      coolingTimeoutMode = health.heavyHostState;
    } else if (task && isLargeLaneTask(task)) {
      timeout = ATPLoadPolicy.getLargeImageTimeout(settings);
    }
    if (task && task.taskDeadlineAt) {
      taskDeadlineRemaining = Math.max(1, task.taskDeadlineAt - Date.now());
      timeout = Math.min(timeout, taskDeadlineRemaining);
    }

    return {
      timeoutMs: timeout,
      baseTimeoutMs: baseTimeout,
      coolingTimeoutMode: coolingTimeoutMode || undefined,
      taskDeadlineRemainingMs: taskDeadlineRemaining
    };
  }

  function getImageLoadTimeout(settings, task) {
    return getImageLoadTimeoutInfo(settings, task).timeoutMs;
  }

  function getImageUrlKey(url) {
    return SharedUtils && SharedUtils.normalizeImageUrl
      ? SharedUtils.normalizeImageUrl(url)
      : String(url || '');
  }

  function getNoReferrerFallbackRetryTimeout(task) {
    var settings = getCurrentSettings();
    return Math.max(1, Number(getImageLoadTimeout(settings, task)) || 1);
  }

  function isImageTaskDeadlineSpent(task) {
    return !!(task && task.taskDeadlineAt && Date.now() + 25 >= task.taskDeadlineAt);
  }

  function tryContinueTimedImageLoad(task, img, restartTimer) {
    if (img && img.complete && img.naturalWidth && typeof img.onload === 'function') {
      img.onload();
      return true;
    }
    if (!task || !task.taskDeadlineAt || task.timeoutGraceTried ||
        !img || img.referrerPolicy === 'no-referrer' ||
        !isTaskCurrent(task) ||
        isHeavyChannelTask(task, getCurrentSettings())) return false;
    var remaining = task.taskDeadlineAt - Date.now();
    if (remaining < 500) return false;
    task.timeoutGraceTried = true;
    noteLargeLaneOutcome(task, getTaskImageSrc(task), getTaskCurrentSrcAgeMs(task), true);
    if (restartTimer) restartTimer(remaining);
    logImageEvent('image_wait', task, { reason: 'inflight_timeout_grace', remainingMs: remaining });
    return true;
  }

  function markTaskCurrentSourceStart(task, src, noReferrer, startedAt) {
    if (!task) return;
    var now = startedAt || Date.now();
    var key = getImageUrlKey(src);
    if (task.currentSrcKey !== key) {
      task.currentSrcNoReferrerTried = false;
      task.timeoutGraceTried = false;
    }
    task.currentSrcKey = key;
    task.currentSrcStartedAt = now;
    if (noReferrer) {
      task.currentSrcNoReferrerTried = true;
      task.noReferrerFallbackTried = true;
      task.noReferrerFallbackSrcKey = key;
    } else {
      task.currentSrcNoReferrerTried = false;
      task.noReferrerFallbackTried = false;
      task.noReferrerFallbackSrcKey = '';
    }
    stampTaskHostHealthEpoch(task, src);
  }

  function resetNoReferrerFallbackWindow(task, startedAt) {
    if (!task) return;
    task.currentSrcStartedAt = startedAt || Date.now();
    task.currentSrcKey = getImageUrlKey(getTaskImageSrc(task));
    task.currentSrcNoReferrerTried = false;
    task.noReferrerFallbackTried = false;
    task.noReferrerFallbackSrcKey = '';
    stampTaskHostHealthEpoch(task, getTaskImageSrc(task));
  }

  function getTaskCurrentSrcAgeMs(task) {
    return task && task.currentSrcStartedAt ? Math.max(0, Date.now() - task.currentSrcStartedAt) : 0;
  }

  function getImageTimeoutLogFields(settings, task) {
    if (!task || !isHighFanoutTask(task)) return {};
    var info = getImageLoadTimeoutInfo(settings, task);
    return {
      timeoutMs: info.timeoutMs,
      baseTimeoutMs: info.baseTimeoutMs,
      coolingTimeoutMode: info.coolingTimeoutMode,
      taskDeadlineRemainingMs: info.taskDeadlineRemainingMs
    };
  }

  function isDiagnosticLoggingEnabled(level) {
    if (typeof Logger === 'undefined') return false;
    if (typeof Logger.isEnabled === 'function') return Logger.isEnabled(level || 'DEBUG');
    return true;
  }

  function logDebugThrottled(key, msg, data, intervalMs) {
    if (!isDiagnosticLoggingEnabled('DEBUG')) return;
    intervalMs = intervalMs || 3000;
    var now = Date.now();
    var state = LOG_THROTTLE[key] || { last: 0, suppressed: 0 };
    if (now - state.last < intervalMs) {
      state.suppressed++;
      LOG_THROTTLE[key] = state;
      return;
    }
    var suffix = state.suppressed ? ' (+' + state.suppressed + ' similar)' : '';
    state.last = now;
    state.suppressed = 0;
    LOG_THROTTLE[key] = state;
    Logger.debug(msg, String(data || '').substring(0, 120) + suffix);
  }

  function logEventThrottled(key, type, fields, intervalMs, level) {
    if (!isDiagnosticLoggingEnabled(level || 'DEBUG')) return;
    intervalMs = intervalMs || 3000;
    var now = Date.now();
    var state = LOG_THROTTLE[key] || { last: 0, suppressed: 0 };
    if (now - state.last < intervalMs) {
      state.suppressed++;
      LOG_THROTTLE[key] = state;
      return;
    }
    var nextFields = typeof fields === 'function' ? fields() : Object.assign({}, fields || {});
    if (!nextFields) {
      state.last = now;
      state.suppressed = 0;
      LOG_THROTTLE[key] = state;
      return;
    }
    nextFields = Object.assign({}, nextFields || {});
    if (state.suppressed) nextFields.suppressed = state.suppressed;
    state.last = now;
    state.suppressed = 0;
    LOG_THROTTLE[key] = state;
    recordDiagnosticEvent(type, nextFields);
    if (typeof Logger !== 'undefined' && Logger.event) Logger.event(type, nextFields, level || 'DEBUG');
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
      previewKept: 0,
      previewMissing: 0,
      previewDropped: 0,
      restoreErrors: 0,
      budgetFollowups: 0,
      maxActive: 0,
      maxOrdinaryActive: 0,
      maxOrdinaryHostLargeActive: 0,
      maxHeavyActive: 0,
      maxHeavyVisibleMP: 0,
      maxHeavyVisibleRestoringMP: 0,
      maxHeavyVisibleRestoreSettlingMP: 0,
      maxHeavyVisibleRestoreSettling: 0,
      maxHeavyRangeMP: 0,
      maxHeavyRangeRestoringMP: 0,
      maxHeavyMaxVisibleMP: 0,
      maxHeavyMaxRangeMP: 0,
      maxUnloaded: 0,
      maxRestoreQueue: 0,
      maxVisiblePreviewWaitMS: 0,
      maxVisiblePreviewWaiting: 0,
      visiblePreviewGrace: 0,
      visiblePreviewStableGrace: 0,
      visiblePreviewLateGrace: 0,
      visiblePreviewLastChance: 0,
      visiblePreviewStarvation: 0,
      visiblePreviewDeferred: 0,
      visiblePreviewStuck: 0,
      heavyUnloadBatchSize: 0,
      heavyLightweightPreviewMaxEdge: 0,
      previewFallbackActive: 0,
      heavyHostLimited: 0,
      heavyHostCooling: 0,
      heavyDeepRescue: 0,
      maxHeavyDeepRescueSpan: 0,
      maxHeavyDeepRescuePickedIndex: 0,
      maxHeavyHostCooldownRemainingMs: 0,
      maxViewportPending: 0,
      maxActualVisiblePending: 0,
      maxOldestVisiblePendingAgeMs: 0,
      maxPendingAgeMs: 0,
      maxStalePendingCount: 0,
      maxLightweightPreloadPending: 0,
      maxLightweightPreloadInRange: 0,
      maxLightweightPreloadTriggered: 0,
      maxLightweightPreloadObservedTotal: 0,
      maxLightweightPreloadTriggeredTotal: 0,
      maxLightweightPreloadMarginPx: 0,
      lightweightPreloadLoads: 0,
      maxPendingCreatedDistancePx: 0,
      maxPendingCurrentDistancePx: 0,
      maxLightweightPreloadCreatedDistancePx: 0,
      preloadMissReasons: {},
      maxPendingAgeByQueueKind: {},
      heavyOrdinaryPressureSoftened: 0,
      maxFirstHeavyQueue: 0,
      maxBgHeavyQueue: 0,
      maxHeavyQueue: 0,
      maxOrdinaryQueue: 0,
      maxBgQueueLength: 0
    };
  }

  function incrementCount(map, key) {
    if (!key) return;
    map[key] = (map[key] || 0) + 1;
  }

  function getNumber(value) {
    value = Number(value);
    return isNaN(value) ? 0 : value;
  }

  function roundNumber(value) {
    return Math.round(getNumber(value) * 10) / 10;
  }

  function topCountObject(map, limit) {
    var out = {};
    var topKeys = collectTopKeys(map, limit || 8, function(key) {
      return map[key];
    });
    for (var i = 0; i < topKeys.length; i++) {
      var key = topKeys[i];
      out[key] = map[key];
    }
    return out;
  }

  function collectTopKeys(map, limit, getCount) {
    var topKeys = [];
    map = map || {};
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      var count = getNumber(getCount(key));
      var insertAt = topKeys.length;
      while (insertAt > 0 && count > getNumber(getCount(topKeys[insertAt - 1]))) insertAt--;
      if (insertAt >= limit) continue;
      topKeys.splice(insertAt, 0, key);
      if (topKeys.length > limit) topKeys.length = limit;
    }
    return topKeys;
  }

  function mergeMaxCountObject(target, source) {
    source = source || {};
    for (var key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      target[key] = Math.max(target[key] || 0, getNumber(source[key]));
    }
  }

  function mergePendingAgeByQueueKind(summary, source) {
    source = source || {};
    for (var queueKind in source) {
      if (!Object.prototype.hasOwnProperty.call(source, queueKind)) continue;
      var incoming = source[queueKind] || {};
      var current = summary.maxPendingAgeByQueueKind[queueKind] || { count: 0, maxAgeMs: 0 };
      current.count = Math.max(current.count || 0, getNumber(incoming.count));
      current.maxAgeMs = Math.max(current.maxAgeMs || 0, getNumber(incoming.maxAgeMs));
      summary.maxPendingAgeByQueueKind[queueKind] = current;
    }
  }

  function percentile(values, p) {
    if (!values || !values.length) return 0;
    var index = Math.min(values.length - 1, Math.floor((values.length - 1) * p));
    var smallest = [];
    var limit = index + 1;
    for (var i = 0; i < values.length; i++) {
      var value = values[i];
      if (smallest.length >= limit && value >= smallest[smallest.length - 1]) continue;
      var insertAt = smallest.length;
      while (insertAt > 0 && value < smallest[insertAt - 1]) insertAt--;
      if (insertAt >= limit) continue;
      smallest.splice(insertAt, 0, value);
      if (smallest.length > limit) smallest.length = limit;
    }
    return smallest[index] || 0;
  }

  function recordHostTiming(summary, fields) {
    if (!summary || !fields || fields.ms === undefined) return;
    var host = (fields.largeImage ? 'gif:' : '') + (fields.host || 'unknown');
    var stats = summary.hostStats[host];
    if (!stats) {
      stats = summary.hostStats[host] = { done: 0, fail: 0, totalMs: 0, maxMs: 0, samples: [], sampleOffset: 0 };
    }
    var ms = getNumber(fields.ms);
    stats.done++;
    if (fields.ok === false) stats.fail++;
    stats.totalMs += ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
    if (stats.samples.length < 80) {
      stats.samples.push(ms);
    } else {
      stats.samples[stats.sampleOffset] = ms;
      stats.sampleOffset = (stats.sampleOffset + 1) % 80;
    }
  }

  function buildHostTimingSummary(summary) {
    var out = {};
    var hostKeys = collectTopKeys(summary.hostStats || {}, 6, function(host) {
      return summary.hostStats[host].done;
    });
    for (var i = 0; i < hostKeys.length; i++) {
      var host = hostKeys[i];
      var stats = summary.hostStats[host];
      out[host] = {
        done: stats.done,
        fail: stats.fail,
        avgMs: stats.done ? Math.round(stats.totalMs / stats.done) : 0,
        p90Ms: percentile(stats.samples, 0.9),
        maxMs: stats.maxMs
      };
    }
    return out;
  }

  function recordVisibleWaitTiming(summary, fields) {
    if (!summary || !fields || fields.visibleBeforeLoadMs === undefined) return;
    var stats = summary.visibleWaitStats;
    var ms = getNumber(fields.visibleBeforeLoadMs);
    stats.done++;
    stats.totalMs += ms;
    stats.maxMs = Math.max(stats.maxMs, ms);
    if (stats.samples.length < 80) {
      stats.samples.push(ms);
    } else {
      stats.samples[stats.sampleOffset] = ms;
      stats.sampleOffset = (stats.sampleOffset + 1) % 80;
    }
  }

  function buildVisibleWaitTimingSummary(summary) {
    var stats = summary.visibleWaitStats;
    return {
      done: stats.done,
      avgMs: stats.done ? Math.round(stats.totalMs / stats.done) : 0,
      p90Ms: percentile(stats.samples, 0.9),
      maxMs: stats.maxMs
    };
  }

  function isSummaryDiagnosticType(type) {
    return /^(image_start|image_done|image_defer|fallback_pick|fallback_miss|fallback_skip|render_unload|render_restore|render_restore_error|render_state|schedule_state)$/.test(type);
  }

  function scheduleDiagnosticSummaryFlush() {
    if (DIAGNOSTIC_SUMMARY_TIMER) return;
    DIAGNOSTIC_SUMMARY_TIMER = setTimeout(function() {
      DIAGNOSTIC_SUMMARY_TIMER = null;
      flushDiagnosticSummary('interval');
    }, DIAGNOSTIC_SUMMARY_INTERVAL_MS);
  }

  function recordDiagnosticEvent(type, fields) {
    if (!isDiagnosticLoggingEnabled('DEBUG')) return;
    if (!isSummaryDiagnosticType(type)) return;
    var summary = DIAGNOSTIC_SUMMARY || createDiagnosticSummary();
    DIAGNOSTIC_SUMMARY = summary;
    fields = fields || {};
    incrementCount(summary.counts, type);
    incrementCount(summary.reasons, fields.reason || type);
    incrementCount(summary.hosts, fields.host || '');
    incrementCount(summary.channels, fields.channel || '');
    summary.maxActive = Math.max(summary.maxActive, getNumber(fields.active));
    summary.maxOrdinaryActive = Math.max(summary.maxOrdinaryActive, getNumber(fields.ordinaryActive));
    summary.maxOrdinaryHostLargeActive = Math.max(summary.maxOrdinaryHostLargeActive, getNumber(fields.ordinaryHostLargeActive));
    summary.maxHeavyActive = Math.max(summary.maxHeavyActive, getNumber(fields.heavyActive));
    summary.maxHeavyVisibleMP = Math.max(summary.maxHeavyVisibleMP, getNumber(fields.heavyVisibleMP));
    summary.maxHeavyVisibleRestoringMP = Math.max(summary.maxHeavyVisibleRestoringMP, getNumber(fields.heavyVisibleRestoringMP));
    summary.maxHeavyVisibleRestoreSettlingMP = Math.max(summary.maxHeavyVisibleRestoreSettlingMP, getNumber(fields.heavyVisibleRestoreSettlingMP));
    summary.maxHeavyVisibleRestoreSettling = Math.max(summary.maxHeavyVisibleRestoreSettling, getNumber(fields.heavyVisibleRestoreSettling));
    summary.maxHeavyRangeMP = Math.max(summary.maxHeavyRangeMP, getNumber(fields.heavyRangeMP));
    summary.maxHeavyRangeRestoringMP = Math.max(summary.maxHeavyRangeRestoringMP, getNumber(fields.heavyRangeRestoringMP));
    summary.maxHeavyMaxVisibleMP = Math.max(summary.maxHeavyMaxVisibleMP, getNumber(fields.heavyMaxVisibleMP));
    summary.maxHeavyMaxRangeMP = Math.max(summary.maxHeavyMaxRangeMP, getNumber(fields.heavyMaxRangeMP));
    summary.maxUnloaded = Math.max(summary.maxUnloaded, getNumber(fields.unloadedCount));
    summary.maxRestoreQueue = Math.max(summary.maxRestoreQueue, getNumber(fields.restoreQueue));
    summary.maxVisiblePreviewWaitMS = Math.max(
      summary.maxVisiblePreviewWaitMS,
      getNumber(fields.visiblePreviewWaitMS),
      getNumber(fields.heavyVisiblePreviewWaitMS)
    );
    summary.maxVisiblePreviewWaiting = Math.max(
      summary.maxVisiblePreviewWaiting,
      getNumber(fields.heavyVisiblePreviewWaiting)
    );
    summary.heavyUnloadBatchSize = Math.max(summary.heavyUnloadBatchSize, getNumber(fields.heavyUnloadBatchSize));
    summary.heavyLightweightPreviewMaxEdge = Math.max(
      summary.heavyLightweightPreviewMaxEdge,
      getNumber(fields.heavyLightweightPreviewMaxEdge)
    );
    summary.maxViewportPending = Math.max(
      summary.maxViewportPending,
      getNumber(fields.viewportPending),
      getNumber(fields.pendingCount),
      getNumber(fields.pendingCountAtLoad)
    );
    summary.maxActualVisiblePending = Math.max(
      summary.maxActualVisiblePending,
      getNumber(fields.actualVisiblePendingCount)
    );
    summary.maxOldestVisiblePendingAgeMs = Math.max(
      summary.maxOldestVisiblePendingAgeMs,
      getNumber(fields.oldestVisiblePendingAgeMs)
    );
    summary.maxPendingAgeMs = Math.max(
      summary.maxPendingAgeMs,
      getNumber(fields.maxPendingAgeMs),
      getNumber(fields.pendingAgeMs)
    );
    summary.maxStalePendingCount = Math.max(summary.maxStalePendingCount, getNumber(fields.stalePendingCount));
    summary.maxLightweightPreloadPending = Math.max(
      summary.maxLightweightPreloadPending,
      getNumber(fields.lightweightPreloadPending)
    );
    summary.maxLightweightPreloadInRange = Math.max(
      summary.maxLightweightPreloadInRange,
      getNumber(fields.lightweightPreloadInRange)
    );
    summary.maxLightweightPreloadTriggered = Math.max(
      summary.maxLightweightPreloadTriggered,
      getNumber(fields.lightweightPreloadTriggered)
    );
    summary.maxLightweightPreloadObservedTotal = Math.max(
      summary.maxLightweightPreloadObservedTotal,
      getNumber(fields.lightweightPreloadObservedTotal)
    );
    summary.maxLightweightPreloadTriggeredTotal = Math.max(
      summary.maxLightweightPreloadTriggeredTotal,
      getNumber(fields.lightweightPreloadTriggeredTotal)
    );
    summary.maxLightweightPreloadMarginPx = Math.max(
      summary.maxLightweightPreloadMarginPx,
      getNumber(fields.lightweightPreloadMarginPx)
    );
    summary.maxPendingCreatedDistancePx = Math.max(
      summary.maxPendingCreatedDistancePx,
      getNumber(fields.pendingCreatedDistancePx),
      getNumber(fields.maxPendingCreatedDistancePx)
    );
    summary.maxPendingCurrentDistancePx = Math.max(
      summary.maxPendingCurrentDistancePx,
      getNumber(fields.pendingCurrentDistancePx),
      getNumber(fields.maxPendingCurrentDistancePx)
    );
    summary.maxLightweightPreloadCreatedDistancePx = Math.max(
      summary.maxLightweightPreloadCreatedDistancePx,
      getNumber(fields.maxLightweightPreloadCreatedDistancePx)
    );
    if (fields.preloadMissReason) incrementCount(summary.preloadMissReasons, fields.preloadMissReason);
    mergeMaxCountObject(summary.preloadMissReasons, fields.preloadMissReasons);
    mergePendingAgeByQueueKind(summary, fields.pendingAgeByQueueKind);
    if (fields.forcePreload === true || fields.forceLoadReason === 'lightweight_preload') summary.lightweightPreloadLoads++;
    if (fields.heavyOrdinaryPressureSoftened === true) summary.heavyOrdinaryPressureSoftened++;
    summary.maxFirstHeavyQueue = Math.max(summary.maxFirstHeavyQueue, getNumber(fields.firstHeavyQueue));
    summary.maxBgHeavyQueue = Math.max(summary.maxBgHeavyQueue, getNumber(fields.bgHeavyQueue));
    summary.maxHeavyQueue = Math.max(summary.maxHeavyQueue, getNumber(fields.heavyQueue));
    summary.maxOrdinaryQueue = Math.max(summary.maxOrdinaryQueue, getNumber(fields.ordinaryQueue));
    summary.maxBgQueueLength = Math.max(
      summary.maxBgQueueLength,
      getNumber(fields.bgQueueLength),
      getNumber(fields.bgQueueBefore),
      getNumber(fields.bgQueueAfter)
    );
    if (fields.budgetFollowup === true) summary.budgetFollowups++;
    if (
      fields.visiblePreviewGrace === true ||
      fields.reason === 'visible_preview_grace' ||
      fields.reason === 'visible_preview_stable_grace' ||
      fields.reason === 'visible_preview_late_grace' ||
      fields.reason === 'visible_preview_last_chance' ||
      fields.reason === 'visible_preview_starvation_grace'
    ) {
      summary.visiblePreviewGrace++;
    }
    if (fields.visiblePreviewGraceMode === 'stable' || fields.reason === 'visible_preview_stable_grace') {
      summary.visiblePreviewStableGrace++;
    }
    if (fields.visiblePreviewGraceMode === 'late' || fields.reason === 'visible_preview_late_grace') {
      summary.visiblePreviewLateGrace++;
    }
    if (fields.visiblePreviewGraceMode === 'last_chance' || fields.reason === 'visible_preview_last_chance') {
      summary.visiblePreviewLastChance++;
    }
    if (fields.visiblePreviewGraceMode === 'starvation' || fields.reason === 'visible_preview_starvation_grace') {
      summary.visiblePreviewStarvation++;
    }
    if (fields.reason === 'visible_preview_defer') summary.visiblePreviewDeferred++;
    if (fields.visiblePreviewDeferred !== undefined) {
      summary.visiblePreviewDeferred += getNumber(fields.visiblePreviewDeferred);
    }
    if (fields.visiblePreviewStuck !== undefined) {
      summary.visiblePreviewStuck = Math.max(summary.visiblePreviewStuck, getNumber(fields.visiblePreviewStuck));
    }
    if (fields.previewFallbackActive === true) summary.previewFallbackActive++;
    if (fields.heavyHostLimited === true) summary.heavyHostLimited++;
    if (fields.heavyHostCooling === true) summary.heavyHostCooling++;
    if (fields.heavyDeepRescue === true) summary.heavyDeepRescue++;
    summary.maxHeavyDeepRescueSpan = Math.max(
      summary.maxHeavyDeepRescueSpan,
      getNumber(fields.rescueSpan)
    );
    summary.maxHeavyDeepRescuePickedIndex = Math.max(
      summary.maxHeavyDeepRescuePickedIndex,
      getNumber(fields.pickedIndex)
    );
    summary.maxHeavyHostCooldownRemainingMs = Math.max(
      summary.maxHeavyHostCooldownRemainingMs,
      getNumber(fields.heavyHostCooldownRemainingMs)
    );
    if (type === 'image_done') {
      recordHostTiming(summary, fields);
      recordVisibleWaitTiming(summary, fields);
    }
    if (type === 'render_unload') {
      incrementCount(summary.unloadReasons, fields.reason || 'render_unload');
      if (fields.previewKept === true) summary.previewKept++;
      else if (fields.previewKept === false) summary.previewDropped++;
      else summary.previewMissing++;
    }
    if (type === 'render_restore_error') summary.restoreErrors++;
    scheduleDiagnosticSummaryFlush();
  }

  function flushDiagnosticSummary(reason) {
    if (DIAGNOSTIC_SUMMARY_TIMER) {
      clearTimeout(DIAGNOSTIC_SUMMARY_TIMER);
      DIAGNOSTIC_SUMMARY_TIMER = null;
    }
    var summary = DIAGNOSTIC_SUMMARY;
    DIAGNOSTIC_SUMMARY = null;
    if (!isDiagnosticLoggingEnabled('DEBUG')) return;
    if (!summary || typeof Logger === 'undefined' || !Logger.event) return;
    Logger.event('diagnostic_summary', {
      reason: reason || 'manual',
      windowMs: Math.max(0, Date.now() - summary.startedAt),
      counts: topCountObject(summary.counts, 10),
      reasons: topCountObject(summary.reasons, 10),
      hosts: topCountObject(summary.hosts, 8),
      channels: topCountObject(summary.channels, 4),
      hostTiming: buildHostTimingSummary(summary),
      visibleWaitTiming: buildVisibleWaitTimingSummary(summary),
      unloadReasons: topCountObject(summary.unloadReasons, 8),
      previewKept: summary.previewKept,
      previewDropped: summary.previewDropped,
      previewMissing: summary.previewMissing,
      restoreErrors: summary.restoreErrors,
      budgetFollowups: summary.budgetFollowups,
      maxActive: summary.maxActive,
      maxOrdinaryActive: summary.maxOrdinaryActive,
      maxOrdinaryHostLargeActive: summary.maxOrdinaryHostLargeActive || undefined,
      maxHeavyActive: summary.maxHeavyActive,
      maxHeavyVisibleMP: roundNumber(summary.maxHeavyVisibleMP),
      maxHeavyVisibleRestoringMP: roundNumber(summary.maxHeavyVisibleRestoringMP),
      maxHeavyVisibleRestoreSettlingMP: roundNumber(summary.maxHeavyVisibleRestoreSettlingMP),
      maxHeavyVisibleRestoreSettling: summary.maxHeavyVisibleRestoreSettling,
      maxHeavyRangeMP: roundNumber(summary.maxHeavyRangeMP),
      maxHeavyRangeRestoringMP: roundNumber(summary.maxHeavyRangeRestoringMP),
      maxHeavyMaxVisibleMP: roundNumber(summary.maxHeavyMaxVisibleMP),
      maxHeavyMaxRangeMP: roundNumber(summary.maxHeavyMaxRangeMP),
      maxUnloaded: summary.maxUnloaded,
      maxRestoreQueue: summary.maxRestoreQueue,
      maxVisiblePreviewWaitMS: Math.round(summary.maxVisiblePreviewWaitMS),
      maxVisiblePreviewWaiting: summary.maxVisiblePreviewWaiting,
      visiblePreviewGrace: summary.visiblePreviewGrace,
      visiblePreviewStableGrace: summary.visiblePreviewStableGrace,
      visiblePreviewLateGrace: summary.visiblePreviewLateGrace,
      visiblePreviewLastChance: summary.visiblePreviewLastChance,
      visiblePreviewStarvation: summary.visiblePreviewStarvation,
      visiblePreviewDeferred: summary.visiblePreviewDeferred,
      visiblePreviewStuck: summary.visiblePreviewStuck,
      heavyUnloadBatchSize: summary.heavyUnloadBatchSize,
      heavyLightweightPreviewMaxEdge: summary.heavyLightweightPreviewMaxEdge,
      previewFallbackActive: summary.previewFallbackActive,
      heavyHostLimited: summary.heavyHostLimited,
      heavyHostCooling: summary.heavyHostCooling,
      heavyDeepRescue: summary.heavyDeepRescue,
      maxHeavyDeepRescueSpan: summary.maxHeavyDeepRescueSpan,
      maxHeavyDeepRescuePickedIndex: summary.maxHeavyDeepRescuePickedIndex,
      maxHeavyHostCooldownRemainingMs: Math.round(summary.maxHeavyHostCooldownRemainingMs),
      maxViewportPending: summary.maxViewportPending,
      maxActualVisiblePending: summary.maxActualVisiblePending,
      maxOldestVisiblePendingAgeMs: Math.round(summary.maxOldestVisiblePendingAgeMs),
      maxPendingAgeMs: Math.round(summary.maxPendingAgeMs),
      maxStalePendingCount: summary.maxStalePendingCount,
      maxLightweightPreloadPending: summary.maxLightweightPreloadPending,
      maxLightweightPreloadInRange: summary.maxLightweightPreloadInRange,
      maxLightweightPreloadTriggered: summary.maxLightweightPreloadTriggered,
      maxLightweightPreloadObservedTotal: summary.maxLightweightPreloadObservedTotal,
      maxLightweightPreloadTriggeredTotal: summary.maxLightweightPreloadTriggeredTotal,
      maxLightweightPreloadMarginPx: summary.maxLightweightPreloadMarginPx,
      lightweightPreloadLoads: summary.lightweightPreloadLoads,
      maxPendingCreatedDistancePx: summary.maxPendingCreatedDistancePx,
      maxPendingCurrentDistancePx: summary.maxPendingCurrentDistancePx,
      maxLightweightPreloadCreatedDistancePx: summary.maxLightweightPreloadCreatedDistancePx,
      preloadMissReasons: topCountObject(summary.preloadMissReasons, 8),
      maxPendingAgeByQueueKind: summary.maxPendingAgeByQueueKind,
      heavyOrdinaryPressureSoftened: summary.heavyOrdinaryPressureSoftened,
      maxFirstHeavyQueue: summary.maxFirstHeavyQueue,
      maxBgHeavyQueue: summary.maxBgHeavyQueue,
      maxHeavyQueue: summary.maxHeavyQueue,
      maxOrdinaryQueue: summary.maxOrdinaryQueue,
      maxBgQueueLength: summary.maxBgQueueLength
    });
  }

  function shouldSuppressDiagnosticDetail(type, fields) {
    if (!isSummaryDiagnosticType(type)) return false;
    if (type === 'image_done' && fields && fields.ok === false) return false;
    if (/^fallback_/.test(type)) return false;
    if (type === 'render_restore_error') return false;
    return true;
  }

  window.addEventListener('pagehide', function() {
    flushDiagnosticSummary('pagehide');
  });
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState !== 'visible') flushDiagnosticSummary('hidden');
  });

  // 排程快照等热路径对同一 URL 反复取主机名，做有界 memo 化避免重复 new URL 解析
  var URL_HOST_CACHE = null;

  function getUrlHost(url) {
    var key = String(url || '');
    if (!key) return '';
    if (!URL_HOST_CACHE) URL_HOST_CACHE = new Map();
    var hit = URL_HOST_CACHE.get(key);
    if (hit !== undefined) return hit;
    var host;
    try {
      host = new URL(key).hostname;
    } catch (e) {
      host = '';
    }
    // FIFO 逐条淘汰：典型页面 URL 工作集约 3000，整表 clear 会造成反复重解析
    if (URL_HOST_CACHE.size >= 8000) URL_HOST_CACHE.delete(URL_HOST_CACHE.keys().next().value);
    URL_HOST_CACHE.set(key, host);
    return host;
  }

  function shortUrl(url) {
    return String(url || '').substring(0, 180);
  }

  function getHostHealthEpochForUrl(url) {
    var host = getUrlHost(url);
    if (!host) return 0;
    var heavy = isHighFanoutImageHost(url);
    var stats = heavy ? getHeavyHostStats(host, true) : getOrdinaryHostStats(host, true);
    // A request starting after a cooldown ran out belongs to the recovered
    // epoch even if no health snapshot has run since the expiry.
    if (!heavy) recoverExpiredOrdinaryHostCooldown(stats, Date.now(), getCurrentSettings() || {});
    return stats ? (stats.failureEpoch || 0) : 0;
  }

  function stampTaskHostHealthEpoch(task, url) {
    if (!task) return;
    task.currentHostHealthHost = String(getUrlHost(url) || '').toLowerCase();
    task.currentHostHealthEpoch = getHostHealthEpochForUrl(url);
    var laneStats = isHighFanoutImageHost(url) ? null : getOrdinaryHostStats(task.currentHostHealthHost, false);
    task.largeLaneEpoch = laneStats ? (laneStats.largeLaneEpoch || 0) : 0;
  }

  function advanceHostHealthEpoch(stats) {
    if (!stats) return 0;
    stats.failureEpoch = (stats.failureEpoch || 0) + 1;
    return stats.failureEpoch;
  }

  function getTaskStampedHostHealthEpoch(task, url) {
    if (!task) return null;
    var host = String(getUrlHost(url) || '').toLowerCase();
    if (!host || task.currentHostHealthHost !== host) return null;
    var epoch = Number(task.currentHostHealthEpoch);
    return isFinite(epoch) ? epoch : null;
  }

  function isStaleHostFailure(task, url, stats) {
    if (!task || !stats) return false;
    var stampedEpoch = getTaskStampedHostHealthEpoch(task, url);
    return stampedEpoch !== null && stampedEpoch < Number(stats.failureEpoch || 0);
  }

  function getHeavyHostStats(host, create) {
    if (!host) return null;
    host = String(host).toLowerCase();
    if (!HEAVY_HOST_HEALTH.stats[host] && create) {
      HEAVY_HOST_HEALTH.stats[host] = {
        failures: 0,
        totalFailures: 0,
        successes: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        failureTimes: [],
        failureEpoch: 0,
        state: 'warmup',
        stateEpoch: 0,
        adaptiveLimit: 0,
        cooldownUntil: 0,
        cooldownCount: 0,
        lastFailureAt: 0,
        lastSuccessAt: 0,
        lastReason: '',
        recentOutcomes: []
      };
    }
    return HEAVY_HOST_HEALTH.stats[host] || null;
  }

  function getHeavyHostCooldownRemaining(stats, now) {
    if (!stats || !stats.cooldownUntil) return 0;
    now = now || Date.now();
    return Math.max(0, stats.cooldownUntil - now);
  }

  function getHeavyHostActiveCount(host, priorityOnly) {
    if (!host) return 0;
    host = String(host).toLowerCase();
    var count = 0;
    for (var slotToken in GLOBAL_ACTIVE_SLOTS) {
      if (!Object.prototype.hasOwnProperty.call(GLOBAL_ACTIVE_SLOTS, slotToken)) continue;
      var task = GLOBAL_ACTIVE_SLOTS[slotToken];
      if (!task || task.slotCounted === false) continue;
      if (priorityOnly && !isCurrentlyVisibleImageTask(task)) continue;
      if (String(getUrlHost(getTaskImageSrc(task))).toLowerCase() === host && isHighFanoutTask(task)) count++;
    }
    return count;
  }

  function pruneHeavyHostFailures(stats, settings, now) {
    if (!stats) return 0;
    var times = stats.failureTimes || [];
    // 健康路径快出：无失败记录时跳过时间窗计算与数组重建
    if (!times.length && !stats.failures) return 0;
    now = now || Date.now();
    var cutoff = now - ATPLoadPolicy.getHeavyFailureWindow(settings);
    var kept = [];
    for (var i = 0; i < times.length; i++) {
      if (times[i] >= cutoff) kept.push(times[i]);
    }
    stats.failureTimes = kept;
    stats.failures = kept.length;
    if (!kept.length && stats.lastFailureAt < cutoff) stats.consecutiveFailures = 0;
    return kept.length;
  }

  function setHeavyHostState(host, stats, nextState, reason, settings) {
    if (!stats || stats.state === nextState) return false;
    var previousState = stats.state || 'warmup';
    stats.state = nextState;
    stats.stateEpoch = (stats.stateEpoch || 0) + 1;
    if (typeof Logger !== 'undefined' && Logger.event) {
      Logger.event('heavy_host_state', {
        host: host,
        previousState: previousState,
        state: nextState,
        reason: reason || 'state_change',
        stateEpoch: stats.stateEpoch,
        configuredLimit: ATPLoadPolicy.getHeavyConcurrencyCeiling(settings),
        adaptiveLimit: stats.adaptiveLimit || 0,
        failureStreak: stats.consecutiveFailures || 0,
        failureWindowCount: stats.failures || 0,
        cooldownCount: stats.cooldownCount || 0,
        cooldownRemainingMs: getHeavyHostCooldownRemaining(stats)
      }, nextState === 'open' ? 'WARN' : 'INFO');
    }
    return true;
  }

  function refreshHeavyHostState(host, stats, settings, now) {
    now = now || Date.now();
    var ceiling = ATPLoadPolicy.getHeavyConcurrencyCeiling(settings);
    if (!stats.adaptiveLimit) stats.adaptiveLimit = ATPLoadPolicy.getHeavyWarmupConcurrency(settings);
    stats.adaptiveLimit = Math.max(1, Math.min(ceiling, stats.adaptiveLimit));
    pruneHeavyHostFailures(stats, settings, now);

    if (!ATPLoadPolicy.isHeavyCircuitBreakerEnabled(settings)) {
      stats.cooldownUntil = 0;
      stats.adaptiveLimit = ceiling;
      setHeavyHostState(host, stats, 'fixed', 'circuit_disabled', settings);
      return;
    }

    if (stats.state === 'open' && getHeavyHostCooldownRemaining(stats, now) <= 0) {
      stats.cooldownUntil = 0;
      stats.consecutiveSuccesses = 0;
      advanceHostHealthEpoch(stats);
      setHeavyHostState(host, stats, 'half_open', 'cooldown_elapsed', settings);
      return;
    }
    if (stats.state === 'open' || stats.state === 'half_open') return;

    if (ATPLoadPolicy.getHeavySchedulingMode(settings) === 'fixed') {
      stats.adaptiveLimit = ceiling;
      setHeavyHostState(host, stats, 'fixed', 'configured_fixed', settings);
    } else if (stats.state === 'fixed') {
      stats.adaptiveLimit = ATPLoadPolicy.getHeavyWarmupConcurrency(settings);
      setHeavyHostState(host, stats, 'warmup', 'adaptive_enabled', settings);
    }
  }

  function getHeavyHostAdaptiveLimit(host, stats, settings) {
    refreshHeavyHostState(host, stats, settings);
    if (stats.state === 'open') return 0;
    if (stats.state === 'half_open') return ATPLoadPolicy.getHeavyProbeConcurrency(settings);
    if (stats.state === 'fixed') return ATPLoadPolicy.getHeavyConcurrencyCeiling(settings);
    return Math.max(1, Math.min(
      ATPLoadPolicy.getHeavyConcurrencyCeiling(settings),
      stats.adaptiveLimit || ATPLoadPolicy.getHeavyWarmupConcurrency(settings)
    ));
  }

  function getHeavyHostHealthSnapshot(src, settings, hasOrdinaryWork, task) {
    if (!src || !isHighFanoutImageHost(src)) return null;
    var host = getUrlHost(src);
    settings = settings || getCurrentSettings() || {};
    var stats = getHeavyHostStats(host, true);
    var now = Date.now();
    var baseLimit = getHighFanoutSlotLimitForTask(settings, hasOrdinaryWork, task);
    var adaptiveLimit = getHeavyHostAdaptiveLimit(host, stats, settings);
    var visibleProbe = !!(task && isPriorityImageTask(task) && stats.state === 'open');
    if (visibleProbe) {
      adaptiveLimit = Math.max(adaptiveLimit, ATPLoadPolicy.getHeavyProbeConcurrency(settings));
    }
    var cooldownRemaining = getHeavyHostCooldownRemaining(stats, now);
    var effectiveLimit = Math.max(0, Math.min(baseLimit, adaptiveLimit));
    var hostActive = getHeavyHostActiveCount(host);
    var hostPriorityActive = getHeavyHostActiveCount(host, true);
    return {
      heavyHost: host,
      heavyHostFailures: stats.failures || 0,
      heavyHostTotalFailures: stats.totalFailures || 0,
      heavyHostFailureStreak: stats.consecutiveFailures || 0,
      heavyHostSuccesses: stats.successes || 0,
      heavyHostState: stats.state || 'warmup',
      heavyHostStateEpoch: stats.stateEpoch || 0,
      heavyHostActive: hostActive,
      heavyHostPriorityActive: hostPriorityActive,
      heavyHostVisibleProbe: visibleProbe,
      heavyHostCooling: stats.state === 'open' && cooldownRemaining > 0,
      heavyHostHalfOpen: stats.state === 'half_open',
      heavyHostLimited: effectiveLimit < baseLimit,
      heavyHostLimit: effectiveLimit,
      heavyHostBaseLimit: baseLimit,
      heavyHostConfiguredLimit: ATPLoadPolicy.getHeavyConcurrencyCeiling(settings),
      heavyHostAdaptiveLimit: adaptiveLimit,
      heavyOrdinaryReservedSlots: hasOrdinaryWork ? ATPLoadPolicy.getOrdinaryReservedSlots(settings) : 0,
      heavyHostCooldownRemainingMs: Math.round(cooldownRemaining),
      heavyHostCooldownCount: stats.cooldownCount || 0,
      heavyHostLastReason: stats.lastReason || undefined,
      heavyHostLastFailureAgeMs: stats.lastFailureAt ? Math.max(0, now - stats.lastFailureAt) : undefined
    };
  }

  function getHeavyHostHealthLogFields(taskOrSrc, settings, hasOrdinaryWork) {
    var task = typeof taskOrSrc === 'string' ? null : taskOrSrc;
    var src = typeof taskOrSrc === 'string' ? taskOrSrc : getTaskImageSrc(taskOrSrc);
    var snapshot = getHeavyHostHealthSnapshot(src, settings, hasOrdinaryWork, task);
    return snapshot || {};
  }

  function getEffectiveHighFanoutSlotLimit(task, settings, hasOrdinaryWork) {
    var snapshot = getHeavyHostHealthSnapshot(getTaskImageSrc(task), settings, hasOrdinaryWork, task);
    return snapshot ? snapshot.heavyHostLimit : getHighFanoutSlotLimit(settings, hasOrdinaryWork);
  }

  function getHeavyHostHealthSummaryFields(settings, hasOrdinaryWork) {
    var now = Date.now();
    var bestHost = '';
    var bestScore = -1;
    var hostStats = HEAVY_HOST_HEALTH.stats || {};
    for (var host in hostStats) {
      if (!Object.prototype.hasOwnProperty.call(hostStats, host)) continue;
      var stats = hostStats[host];
      var cooldownRemaining = getHeavyHostCooldownRemaining(stats, now);
      var score = cooldownRemaining * 1000 + (stats.failures || 0);
      if (score > bestScore) {
        bestScore = score;
        bestHost = host;
      }
    }
    if (!bestHost) return {};
    return getHeavyHostHealthLogFields('https://' + bestHost + '/', settings, hasOrdinaryWork);
  }

  function recordHeavyHostFailure(url, reason, task) {
    if (!isHighFanoutImageHost(url)) return false;
    var host = getUrlHost(url);
    var stats = getHeavyHostStats(host, true);
    var settings = getCurrentSettings() || {};
    var now = Date.now();
    refreshHeavyHostState(host, stats, settings, now);
    if (isStaleHostFailure(task, url, stats)) return true;
    stats.totalFailures = (stats.totalFailures || 0) + 1;
    stats.failureTimes = stats.failureTimes || [];
    stats.failureTimes.push(now);
    pruneHeavyHostFailures(stats, settings, now);
    stats.consecutiveFailures = (stats.consecutiveFailures || 0) + 1;
    stats.consecutiveSuccesses = 0;
    stats.lastFailureAt = now;
    stats.lastReason = reason || 'image_fail';

    if (!ATPLoadPolicy.isHeavyCircuitBreakerEnabled(settings)) {
      stats.adaptiveLimit = ATPLoadPolicy.getHeavyConcurrencyCeiling(settings);
      setHeavyHostState(host, stats, 'fixed', 'failure_observed', settings);
      return true;
    }

    if (stats.state === 'open' && getHeavyHostCooldownRemaining(stats, now) > 0) return true;

    var wasHalfOpen = stats.state === 'half_open';
    var adaptiveMode = ATPLoadPolicy.getHeavySchedulingMode(settings) !== 'fixed';
    if (adaptiveMode && stats.consecutiveFailures === 1 && !wasHalfOpen) {
      stats.adaptiveLimit = Math.max(
        ATPLoadPolicy.getHeavyProbeConcurrency(settings),
        Math.ceil((stats.adaptiveLimit || ATPLoadPolicy.getHeavyWarmupConcurrency(settings)) / 2)
      );
      setHeavyHostState(host, stats, 'degraded', 'failure_wave', settings);
    }

    if (
      wasHalfOpen ||
      stats.failures >= ATPLoadPolicy.getHeavyFailureThreshold(settings)
    ) {
      stats.cooldownCount = (stats.cooldownCount || 0) + 1;
      var baseCooldown = ATPLoadPolicy.getHeavyCooldownBase(settings);
      var maxCooldown = ATPLoadPolicy.getHeavyCooldownMax(settings);
      var multiplier = Math.pow(2, Math.max(0, stats.cooldownCount - 1));
      var cooldownMs = Math.min(maxCooldown, baseCooldown * multiplier);
      stats.cooldownUntil = now + cooldownMs;
      stats.adaptiveLimit = ATPLoadPolicy.getHeavyProbeConcurrency(settings);
      setHeavyHostState(host, stats, 'open', wasHalfOpen ? 'probe_failed' : 'failure_threshold', settings);
      var coolingFields = getHeavyHostHealthSnapshot(url, getCurrentSettings(), getActiveOrdinaryCount() > 0) || {};
      logEventThrottled('heavyHostCooling:' + host, 'image_defer', Object.assign({
        reason: 'heavy_host_open',
        host: host,
        channel: 'heavy'
      }, coolingFields), 2000, 'WARN');
    }
    return true;
  }

  function recordHeavyHostSuccess(url) {
    if (!isHighFanoutImageHost(url)) return false;
    var host = getUrlHost(url);
    var stats = getHeavyHostStats(host, true);
    var settings = getCurrentSettings() || {};
    refreshHeavyHostState(host, stats, settings);
    stats.successes = (stats.successes || 0) + 1;
    stats.consecutiveSuccesses = (stats.consecutiveSuccesses || 0) + 1;
    stats.lastSuccessAt = Date.now();
    stats.consecutiveFailures = 0;
    if (stats.failureTimes && stats.failureTimes.length) {
      stats.failureTimes.shift();
      stats.failures = stats.failureTimes.length;
    }

    if (
      (stats.state === 'half_open' || stats.state === 'open') &&
      stats.consecutiveSuccesses >= ATPLoadPolicy.getHeavyRecoverySuccesses(settings)
    ) {
      stats.cooldownUntil = 0;
      stats.failureTimes = [];
      stats.failures = 0;
      stats.cooldownCount = 0;
      advanceHostHealthEpoch(stats);
      var fixedMode = ATPLoadPolicy.getHeavySchedulingMode(settings) === 'fixed';
      stats.adaptiveLimit = fixedMode
        ? ATPLoadPolicy.getHeavyConcurrencyCeiling(settings)
        : ATPLoadPolicy.getHeavyWarmupConcurrency(settings);
      setHeavyHostState(host, stats, fixedMode ? 'fixed' : 'warmup', 'probe_recovered', settings);
      return true;
    }

    if (ATPLoadPolicy.getHeavySchedulingMode(settings) === 'fixed') {
      stats.adaptiveLimit = ATPLoadPolicy.getHeavyConcurrencyCeiling(settings);
      setHeavyHostState(host, stats, 'fixed', 'fixed_success', settings);
      return true;
    }

    if (stats.state === 'degraded') {
      advanceHostHealthEpoch(stats);
      setHeavyHostState(host, stats, 'warmup', 'success_after_degrade', settings);
    }
    if (stats.consecutiveSuccesses >= ATPLoadPolicy.getHeavyRampSuccesses(settings)) {
      stats.consecutiveSuccesses = 0;
      stats.adaptiveLimit = Math.min(
        ATPLoadPolicy.getHeavyConcurrencyCeiling(settings),
        (stats.adaptiveLimit || ATPLoadPolicy.getHeavyWarmupConcurrency(settings)) + 1
      );
      setHeavyHostState(
        host,
        stats,
        stats.adaptiveLimit >= ATPLoadPolicy.getHeavyConcurrencyCeiling(settings) ? 'healthy' : 'warmup',
        'success_ramp',
        settings
      );
    }
    return true;
  }

  function getOrdinaryHostStats(host, create) {
    if (!host) return null;
    host = String(host).toLowerCase();
    if (!ORDINARY_HOST_HEALTH.stats[host] && create) {
      ORDINARY_HOST_HEALTH.stats[host] = {
        failures: 0,
        successes: 0,
        consecutiveSuccesses: 0,
        failureEpoch: 0,
        cooldownUntil: 0,
        cooldownCount: 0,
        lastFailureAt: 0,
        lastSuccessAt: 0,
        lastReason: ''
      };
    }
    return ORDINARY_HOST_HEALTH.stats[host] || null;
  }

  // Counted live, not kept as counters: a fallback can change a task's src
  // (and so its host or GIF status) while it holds a slot.
  function getOrdinaryHostActiveCounts(host) {
    var counts = { active: 0, priorityActive: 0, largeActive: 0, largePriorityActive: 0 };
    if (!host) return counts;
    host = String(host).toLowerCase();
    for (var slotToken in GLOBAL_ACTIVE_SLOTS) {
      if (!Object.prototype.hasOwnProperty.call(GLOBAL_ACTIVE_SLOTS, slotToken)) continue;
      var task = GLOBAL_ACTIVE_SLOTS[slotToken];
      if (!task || task.slotCounted === false) continue;
      var src = getTaskImageSrc(task);
      if (isHighFanoutImageHost(src)) continue;
      if (String(getUrlHost(src)).toLowerCase() !== host) continue;
      var visible = isCurrentlyVisibleImageTask(task);
      var large = isLargeImageSrc(src);
      counts.active++;
      if (visible) counts.priorityActive++;
      if (large) {
        counts.largeActive++;
        if (visible) counts.largePriorityActive++;
      }
    }
    return counts;
  }

  function getOrdinaryHostActiveCount(host, priorityOnly) {
    var counts = getOrdinaryHostActiveCounts(host);
    return priorityOnly ? counts.priorityActive : counts.active;
  }

  // GIF lane width per ordinary host. It starts at, and never drops below,
  // getLargeImageHostConcurrency: the width that stopped the user's GIF
  // timeouts on a saturated host. A narrower lane only holds back each
  // post's first screen, and with it the post's later rows. When GIFs finish
  // within the fast threshold while the lane is full (the user's healthy
  // host: about 2 s each with two in flight), it widens by one, up to half
  // the host limit: browsers queue HTTP/1.1 requests beyond 6 per host, so a
  // wider lane makes static thumbnails wait behind GIFs. Any image on the
  // host, GIF or static, slower than the slow threshold or timing out halves
  // it back toward the start. Only images started after the last narrowing
  // count, so one slow batch narrows it once.
  function getLargeLaneCeiling(settings, base) {
    var hostLimit = Math.min(
      ATPLoadPolicy.getOrdinaryHostConcurrency(settings),
      getOrdinaryImageSlotLimit(ATPLoader.getConc())
    );
    return Math.max(base, Math.min(Math.floor(ATPLoadPolicy.getOrdinaryHostConcurrency(settings) / 2), hostLimit - 1));
  }

  function getAdaptiveLargeLaneLimit(stats, settings) {
    var base = Math.max(1, ATPLoadPolicy.getLargeImageHostConcurrency(settings));
    if (!ATPLoadPolicy.isOrdinaryHostAdaptive(settings)) return base;
    if (!stats || !(stats.largeLaneLimit > base)) return base;
    return Math.min(stats.largeLaneLimit, getLargeLaneCeiling(settings, base));
  }

  function noteLargeLaneOutcome(task, url, elapsedMs, timedOut) {
    if (!task || task.manualRetry || !url || isHighFanoutImageHost(url)) return false;
    var settings = getCurrentSettings() || {};
    if (!ATPLoadPolicy.isOrdinaryHostAdaptive(settings)) return false;
    var host = String(getUrlHost(url) || '').toLowerCase();
    if (!host) return false;
    var stats = getOrdinaryHostStats(host, true);
    if ((task.largeLaneEpoch || 0) !== (stats.largeLaneEpoch || 0)) return false;
    var base = Math.max(1, ATPLoadPolicy.getLargeImageHostConcurrency(settings));
    var current = getAdaptiveLargeLaneLimit(stats, settings);
    var next = current;
    var reason = '';
    if (timedOut || elapsedMs > ATPLoadPolicy.getLargeImageSlowMs(settings)) {
      if (current <= base) return false;
      next = Math.max(base, Math.floor(current / 2));
      reason = (isLargeLaneTask(task) ? '' : 'static_') + (timedOut ? 'timeout' : 'slow');
      stats.largeLaneEpoch = (stats.largeLaneEpoch || 0) + 1;
    } else if (isLargeLaneTask(task) && elapsedMs <= ATPLoadPolicy.getLargeImageFastMs(settings)) {
      // Only a lane that was in use can show there is room for more; the
      // finishing GIF has already released its slot.
      if (current < getLargeLaneCeiling(settings, base) && getOrdinaryHostActiveCounts(host).largeActive + 1 >= current) {
        next = current + 1;
        reason = 'fast';
      }
    }
    if (next === current) return false;
    stats.largeLaneLimit = next;
    logEventThrottled('ordinaryLargeLane:' + host, 'ordinary_large_lane_window', {
      host: host, from: current, to: next, reason: reason, ms: Math.round(elapsedMs || 0),
      largeLaneEpoch: stats.largeLaneEpoch || 0
    }, 500, 'INFO');
    return true;
  }

  function getOrdinaryHostOutcomeLimit(settings) {
    return Math.max(12, Math.min(100, ATPLoadPolicy.getOrdinaryHostHardFailures(settings) * 4));
  }

  function recordOrdinaryHostOutcome(stats, failed, settings) {
    if (!stats) return;
    if (!Array.isArray(stats.recentOutcomes)) stats.recentOutcomes = [];
    stats.recentOutcomes.push(failed ? 1 : 0);
    var limit = getOrdinaryHostOutcomeLimit(settings);
    if (stats.recentOutcomes.length > limit) {
      stats.recentOutcomes.splice(0, stats.recentOutcomes.length - limit);
    }
  }

  function getOrdinaryHostFailurePressure(stats, settings) {
    var outcomes = stats && Array.isArray(stats.recentOutcomes) ? stats.recentOutcomes : [];
    var recentFailures = 0;
    for (var i = 0; i < outcomes.length; i++) recentFailures += outcomes[i] ? 1 : 0;
    var samples = outcomes.length;
    var failureRate = samples ? recentFailures / samples : 0;
    var failures = stats && stats.failures || 0;
    var softThreshold = ATPLoadPolicy.getOrdinaryHostSoftFailures(settings);
    var hardThreshold = ATPLoadPolicy.getOrdinaryHostHardFailures(settings);
    return {
      samples: samples,
      recentFailures: recentFailures,
      failureRate: failureRate,
      soft: failures >= softThreshold && recentFailures >= softThreshold && failureRate >= 0.5,
      hard: failures >= hardThreshold && recentFailures >= hardThreshold && failureRate >= 0.7
    };
  }

  function recoverExpiredOrdinaryHostCooldown(stats, now, settings) {
    if (!stats || !stats.cooldownUntil || stats.cooldownUntil > now) return false;
    stats.cooldownUntil = 0;
    stats.failures = Math.min(
      stats.failures || 0,
      ATPLoadPolicy.getOrdinaryHostSoftFailures(settings || {})
    );
    stats.consecutiveSuccesses = 0;
    stats.lastReason = 'cooldown_expired';
    advanceHostHealthEpoch(stats);
    return true;
  }

  function getOrdinaryHostCooldownRemaining(stats, now) {
    if (!stats || !stats.cooldownUntil) return 0;
    now = now || Date.now();
    return Math.max(0, stats.cooldownUntil - now);
  }

  function getOrdinaryHostHealthSnapshot(src, totalLimit) {
    if (!src || isHighFanoutImageHost(src)) return null;
    var host = getUrlHost(src);
    if (!host) return null;
    var settings = getCurrentSettings() || {};
    var stats = getOrdinaryHostStats(host, false) || {};
    var now = Date.now();
    recoverExpiredOrdinaryHostCooldown(stats, now, settings);
    var baseLimit = Math.max(1, Math.min(
      Math.max(1, Number(totalLimit) || ATPLoadPolicy.getOrdinaryHostConcurrency(settings)),
      ATPLoadPolicy.getOrdinaryHostConcurrency(settings)
    ));
    var cooldownRemaining = getOrdinaryHostCooldownRemaining(stats, now);
    var failures = stats.failures || 0;
    var pressure = getOrdinaryHostFailurePressure(stats, settings);
    var effectiveLimit = baseLimit;
    if (ATPLoadPolicy.isOrdinaryHostAdaptive(settings)) {
      if (pressure.hard || cooldownRemaining > 0) {
        effectiveLimit = Math.min(effectiveLimit, ATPLoadPolicy.getOrdinaryHostHardLimit(settings));
      } else if (pressure.soft) {
        effectiveLimit = Math.min(effectiveLimit, ATPLoadPolicy.getOrdinaryHostSoftLimit(settings));
      }
    }
    if (settings.autoLoadOffscreenFirstRowsEnabled === true) {
      effectiveLimit = Math.min(effectiveLimit, 6);
    }
    var counts = getOrdinaryHostActiveCounts(host);
    return {
      ordinaryHost: host,
      ordinaryHostActive: counts.active,
      ordinaryHostPriorityActive: counts.priorityActive,
      ordinaryHostLimit: effectiveLimit,
      ordinaryHostBaseLimit: baseLimit,
      ordinaryHostFailures: failures,
      ordinaryHostRecentSamples: pressure.samples,
      ordinaryHostRecentFailures: pressure.recentFailures,
      ordinaryHostFailureRate: Math.round(pressure.failureRate * 1000) / 1000,
      ordinaryHostCooling: cooldownRemaining > 0,
      ordinaryHostLimited: effectiveLimit < baseLimit,
      ordinaryHostCooldownRemainingMs: Math.round(cooldownRemaining),
      ordinaryHostCooldownCount: stats.cooldownCount || 0,
      ordinaryHostLastReason: stats.lastReason || undefined,
      ordinaryHostLastFailureAgeMs: stats.lastFailureAt ? Math.max(0, now - stats.lastFailureAt) : undefined,
      ordinaryHostLargeActive: counts.largeActive,
      ordinaryHostLargePriorityActive: counts.largePriorityActive,
      ordinaryHostLargeLimit: Math.max(1, Math.min(getAdaptiveLargeLaneLimit(stats, settings), effectiveLimit - 1))
    };
  }

  function getOrdinaryHostHealthLogFields(taskOrSrc, totalLimit) {
    var src = typeof taskOrSrc === 'string' ? taskOrSrc : getTaskImageSrc(taskOrSrc);
    return getOrdinaryHostHealthSnapshot(src, totalLimit) || {};
  }

  function getOrdinaryHostActiveTopFields() {
    var counts = {};
    var topHost = '';
    var topCount = 0;
    for (var slotToken in GLOBAL_ACTIVE_SLOTS) {
      if (!Object.prototype.hasOwnProperty.call(GLOBAL_ACTIVE_SLOTS, slotToken)) continue;
      var task = GLOBAL_ACTIVE_SLOTS[slotToken];
      if (!task || task.slotCounted === false) continue;
      var src = getTaskImageSrc(task);
      if (isHighFanoutImageHost(src)) continue;
      var host = getUrlHost(src);
      if (!host) continue;
      counts[host] = (counts[host] || 0) + 1;
      if (counts[host] > topCount) {
        topHost = host;
        topCount = counts[host];
      }
    }
    if (!topHost) return {};
    return {
      ordinaryHostActiveTop: topHost,
      ordinaryHostActiveTopCount: topCount
    };
  }

  function recordOrdinaryHostFailure(url, reason, task) {
    if (!url || isHighFanoutImageHost(url)) return false;
    var host = getUrlHost(url);
    if (!host) return false;
    var stats = getOrdinaryHostStats(host, true);
    var now = Date.now();
    // Recover an expired cooldown first (as the heavy path does), so a late
    // failure from the cooling window is judged stale instead of re-arming a
    // fresh cooldown depending on whether a snapshot happened to run.
    recoverExpiredOrdinaryHostCooldown(stats, now, getCurrentSettings() || {});
    if (isStaleHostFailure(task, url, stats)) return true;
    var wasCooling = getOrdinaryHostCooldownRemaining(stats, now) > 0;
    stats.failures = (stats.failures || 0) + 1;
    stats.consecutiveSuccesses = 0;
    stats.lastFailureAt = now;
    stats.lastReason = reason || 'image_fail';
    var settings = getCurrentSettings() || {};
    recordOrdinaryHostOutcome(stats, true, settings);
    var pressure = getOrdinaryHostFailurePressure(stats, settings);
    if (
      ATPLoadPolicy.isOrdinaryHostAdaptive(settings) &&
      pressure.hard &&
      !wasCooling
    ) {
      var cooldownMs = ATPLoadPolicy.getOrdinaryHostCooldown(settings);
      if (cooldownMs > 0) {
        stats.cooldownUntil = now + cooldownMs;
        stats.cooldownCount = (stats.cooldownCount || 0) + 1;
        logEventThrottled('ordinaryHostCooling:' + host, 'image_defer', Object.assign({
          reason: 'ordinary_host_cooling',
          host: host,
          channel: 'ordinary'
        }, getOrdinaryHostHealthSnapshot(url, getOrdinaryImageSlotLimit(ATPLoader.getConc ? ATPLoader.getConc() : 1)) || {}), 2000, 'WARN');
      }
    }
    return true;
  }

  function recordOrdinaryHostSuccess(url) {
    if (!url || isHighFanoutImageHost(url)) return false;
    var host = getUrlHost(url);
    if (!host) return false;
    var stats = getOrdinaryHostStats(host, true);
    var settings = getCurrentSettings() || {};
    recordOrdinaryHostOutcome(stats, false, settings);
    stats.successes = (stats.successes || 0) + 1;
    stats.consecutiveSuccesses = (stats.consecutiveSuccesses || 0) + 1;
    stats.lastSuccessAt = Date.now();
    if (stats.failures > 0) stats.failures--;
    var recoverySuccesses = typeof ATPLoadPolicy.getOrdinaryHostRecoverySuccesses === 'function'
      ? ATPLoadPolicy.getOrdinaryHostRecoverySuccesses(settings)
      : ATPLoadPolicy.getOrdinaryHostSoftFailures(settings);
    if (stats.cooldownUntil && stats.consecutiveSuccesses >= recoverySuccesses) {
      stats.cooldownUntil = 0;
      stats.failures = 0;
      stats.recentOutcomes = [];
      stats.lastReason = 'success_recovery';
      advanceHostHealthEpoch(stats);
    }
    if (stats.failures === 0 && stats.cooldownUntil) {
      stats.cooldownUntil = 0;
      stats.recentOutcomes = [];
      advanceHostHealthEpoch(stats);
    }
    return true;
  }

  function getTaskChannel(task) {
    return isHeavyChannelTask(task) ? 'heavy' : 'ordinary';
  }

  function getTaskElapsedMs(task) {
    return task && task.loadStartAt ? Math.max(0, Date.now() - task.loadStartAt) : undefined;
  }

  function getTaskBaseTime(task) {
    if (!task) return 0;
    return task.createdAt || task.queuedAt || task.viewportObservedAt || task.loadStartAt || 0;
  }

  function getTaskAgeMs(task) {
    var base = getTaskBaseTime(task);
    return base ? Math.max(0, Date.now() - base) : undefined;
  }

  function getTaskQueueWaitMs(task) {
    if (!task) return undefined;
    if (typeof task.queueWaitMs === 'number') return Math.max(0, task.queueWaitMs);
    if (task.queuedAt && task.loadStartAt) return Math.max(0, task.loadStartAt - task.queuedAt);
    return undefined;
  }

  function getTaskThreadState(task) {
    return getThreadState(task && task.threadId);
  }

  function getViewportPendingStatsFields() {
    return window.ATPViewport && ATPViewport.getPendingStats ? ATPViewport.getPendingStats() : {};
  }

  function getViewportPendingCountFromStats(stats) {
    if (stats && typeof stats.pendingCount === 'number') return stats.pendingCount;
    return ATPLoader.getViewportPendingCount ? ATPLoader.getViewportPendingCount() : 0;
  }

  function getActiveOrdinaryCount() {
    return Math.max(0, GLOBAL_ACTIVE - GLOBAL_HIGH_FANOUT_ACTIVE);
  }

  function getThreadTaskLogFields(task) {
    var ts = getThreadState(task && task.threadId);
    if (!ts) return {};
    return {
      heavyMode: !!ts.heavyMode,
      lightweightHeavyMode: !!ts.lightweightHeavyMode,
      backgroundBatch: !!(task && task.backgroundBatch),
      forceEager: !!(task && task.forceEager),
      forcePreload: !!(task && task.forcePreload),
      queueKind: task && task.queueKind,
      fallbackCount: (task && task.inlineFallbacks) || 0,
      fallbackLimit: getCandidateFallbackLimit(ts, task),
      heavyHostDeferred: !!ts.bgHostDeferred,
      retries: (task && task.retries) || 0,
      loaded: ts.loaded || 0,
      failedCount: ts.failedCount || 0,
      firstScreenOk: ts.firstScreenOk || 0,
      firstScreenFailed: ts.firstScreenFailed || 0,
      firstScreenTotal: ts.firstScreenTotal || 0,
      bgBatchPending: ts.bgBatchPending || 0,
      bgQueueActive: !!ts.bgQueueActive,
      nextIdx: ts.nextIdx || 0,
      candidateTotal: getThreadCandidateCount(ts),
      sourceCandidateTotal: ts.sourceCandidates ? ts.sourceCandidates.length : undefined
    };
  }

  function getQueueSnapshotFields(existingBgSnapshot) {
    var threads = window.ATPState && window.ATPState.threads;
    var activeThreadIds = getActiveFirstThreadIds(threads);
    var firstCounts = getFirstTaskChannelSnapshot(activeThreadIds, threads || {});
    var bgCounts = existingBgSnapshot || getCachedBgSnapshot();
    var settings = getCurrentSettings();
    var ordinaryActive = getActiveOrdinaryCount();
    var firstHasOrdinaryWork = firstCounts.ordinary > 0 || ordinaryActive > 0;
    var bgHasOrdinaryWork = bgCounts.ordinary > 0 || ordinaryActive > 0;
    var firstHeavyTask = firstCounts.firstHeavyTask;
    var bgHeavyTask = bgCounts.firstHeavyTask;
    var healthTask = firstHeavyTask || bgHeavyTask;
    var viewportPendingStats = getViewportPendingStatsFields();
    return Object.assign({
      firstOrdinaryQueue: firstCounts.ordinary,
      firstHeavyQueue: firstCounts.heavy,
      bgOrdinaryQueue: bgCounts.ordinary,
      bgHeavyQueue: bgCounts.heavy,
      ordinaryQueue: firstCounts.ordinary + bgCounts.ordinary,
      heavyQueue: firstCounts.heavy + bgCounts.heavy,
      bgQueueLength: BG_TASKS.length,
      viewportPending: getViewportPendingCountFromStats(viewportPendingStats),
      heavyScrollDeferred: !!HEAVY_SCROLLING,
      highFanoutFirstLimit: firstHeavyTask
        ? getEffectiveHighFanoutSlotLimit(firstHeavyTask, settings, firstHasOrdinaryWork)
        : getHighFanoutSlotLimit(settings, firstHasOrdinaryWork),
      highFanoutBgLimit: bgHeavyTask
        ? getEffectiveHighFanoutSlotLimit(bgHeavyTask, settings, bgHasOrdinaryWork)
        : getHighFanoutSlotLimit(settings, bgHasOrdinaryWork)
    }, viewportPendingStats, getOrdinaryHostActiveTopFields(), healthTask
      ? getHeavyHostHealthLogFields(healthTask, settings, healthTask === firstHeavyTask ? firstHasOrdinaryWork : bgHasOrdinaryWork)
      : getHeavyHostHealthSummaryFields(settings, firstHasOrdinaryWork || bgHasOrdinaryWork)
    );
  }

  function isWrapperInViewport(wrapper) {
    if (!wrapper || !document.contains(wrapper) || !wrapper.getBoundingClientRect) return false;
    var rect = wrapper.getBoundingClientRect();
    var width = window.innerWidth || document.documentElement.clientWidth || 0;
    var height = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!(rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width)) return false;
    var ancestor = wrapper.parentElement;
    while (ancestor && ancestor !== document.documentElement && ancestor !== document.body) {
      var style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(ancestor) : null;
      var overflowX = style ? style.overflowX || style.overflow : '';
      var overflowY = style ? style.overflowY || style.overflow : '';
      var clipsX = /^(?:auto|scroll|hidden|clip)$/.test(overflowX);
      var clipsY = /^(?:auto|scroll|hidden|clip)$/.test(overflowY);
      if ((clipsX || clipsY) && ancestor.getBoundingClientRect) {
        var ancestorRect = ancestor.getBoundingClientRect();
        if (clipsX && !(rect.right > ancestorRect.left && rect.left < ancestorRect.right)) return false;
        if (clipsY && !(rect.bottom > ancestorRect.top && rect.top < ancestorRect.bottom)) return false;
      }
      ancestor = ancestor.parentElement;
    }
    return true;
  }

  function getWrapperLogFields(wrapper) {
    return {
      wrapperConnected: !!(wrapper && document.contains(wrapper)),
      inViewport: isWrapperInViewport(wrapper),
      documentVisibility: document.visibilityState
    };
  }

  function getTaskLifecycleLogFields(task) {
    return {
      taskAgeMs: getTaskAgeMs(task),
      queueWaitMs: getTaskQueueWaitMs(task),
      queuedAtDeltaMs: task && task.queuedAt ? Math.max(0, Date.now() - task.queuedAt) : undefined,
      pendingCreatedDistancePx: task && task.pendingCreatedDistancePx,
      lightweightPreloadMarginPx: task && task.lightweightPreloadMarginPx,
      slotActive: !!(task && task.slotActive)
    };
  }

  function getTaskFailureLogFields(task) {
    return Object.assign(
      getTaskLifecycleLogFields(task),
      getQueueSnapshotFields()
    );
  }

  function getTaskLogFields(task, extra) {
    var src = getTaskImageSrc(task);
    var previewSrc = getTaskPreviewSrc(task);
    var extraFields = extra || {};
    var settings = getCurrentSettings();
    var ordinaryLimit = settings && settings.firstScreenConcurrency ? settings.firstScreenConcurrency : 3;
    var fields = {
      threadId: task && task.threadId,
      idx: task && task.idx,
      previewIndex: task ? getTaskPreviewIndex(task) : undefined,
      host: getUrlHost(src),
      channel: getTaskChannel(task),
      url: shortUrl(src),
      previewHost: previewSrc && previewSrc !== src ? getUrlHost(previewSrc) : undefined,
      previewUrl: previewSrc && previewSrc !== src ? shortUrl(previewSrc) : undefined,
      firstScreen: !!(task && task.isFirstScreen),
      manualRetry: !!(task && task.manualRetry),
      active: GLOBAL_ACTIVE,
      ordinaryActive: getActiveOrdinaryCount(),
      heavyActive: GLOBAL_HIGH_FANOUT_ACTIVE
    };
    if (isLargeLaneTask(task)) fields.largeImage = true;
    if (task && task.taskDeadlineAt && task.taskDeadlineMs) fields.taskDeadlineMs = task.taskDeadlineMs;
    return Object.assign(
      fields,
      extraFields,
      getImageTimeoutLogFields(settings, task),
      getHeavyHostHealthLogFields(task, settings, getActiveOrdinaryCount() > 0),
      getOrdinaryHostHealthLogFields(task, getOrdinaryImageSlotLimit(ordinaryLimit)),
      getThreadTaskLogFields(task),
      getTaskLifecycleLogFields(task)
    );
  }

  function logImageEvent(type, task, fields, level) {
    if (!isDiagnosticLoggingEnabled(level || 'DEBUG')) return;
    var logFields = getTaskLogFields(task, fields);
    recordDiagnosticEvent(type, logFields);
    if (shouldSuppressDiagnosticDetail(type, logFields)) return;
    if (typeof Logger !== 'undefined' && Logger.event) Logger.event(type, logFields, level || 'DEBUG');
  }

  function getActiveAfterReleaseLogFields(task, slotToken) {
    var activeReleaseDelta = 0;
    var heavyReleaseDelta = 0;
    if (task && task.slotActive) {
      var currentSlotToken = getTaskActiveSlotToken(task);
      var matchesToken = slotToken === undefined || slotToken === null || currentSlotToken === slotToken;
      if (
        matchesToken &&
        task.slotEpoch === IMAGE_SLOT_EPOCH &&
        isRegisteredActiveSlot(task) &&
        task.slotCounted !== false
      ) {
        activeReleaseDelta = 1;
        heavyReleaseDelta = task.highFanoutSlot ? 1 : 0;
      }
    }
    var activeAfterRelease = Math.max(0, GLOBAL_ACTIVE - activeReleaseDelta);
    var heavyAfterRelease = Math.max(0, GLOBAL_HIGH_FANOUT_ACTIVE - heavyReleaseDelta);
    return {
      activeAfterRelease: activeAfterRelease,
      ordinaryActiveAfterRelease: Math.max(0, activeAfterRelease - heavyAfterRelease),
      heavyActiveAfterRelease: heavyAfterRelease
    };
  }

  function logImageDone(task, ok, reason, extra) {
    var detailed = isDiagnosticLoggingEnabled('DEBUG');
    if (!detailed && ok) return;
    if (!detailed && !ok) {
      if (typeof Logger !== 'undefined' && Logger.event) {
        Logger.event('image_failure', {
          reason: reason || 'failed',
          host: getUrlHost(getTaskImageSrc(task)),
          url: shortUrl(getTaskImageSrc(task)),
          threadId: task && task.threadId,
          idx: task && task.idx,
          queueKind: task && task.queueKind,
          ms: getTaskElapsedMs(task)
        }, 'WARN');
      }
      return;
    }
    var fields = Object.assign({
      ok: !!ok,
      reason: reason || (ok ? 'loaded' : 'failed'),
      ms: getTaskElapsedMs(task)
    }, ok ? getTaskLifecycleLogFields(task) : getTaskFailureLogFields(task), getActiveAfterReleaseLogFields(task), extra || {});
    logImageEvent('image_done', task, fields);
  }

  function getImageMetrics(img) {
    var naturalWidth = img && img.naturalWidth ? img.naturalWidth : 0;
    var naturalHeight = img && img.naturalHeight ? img.naturalHeight : 0;
    var decodedMP = naturalWidth && naturalHeight
      ? Math.round((naturalWidth * naturalHeight) / 100000) / 10
      : 0;
    return {
      naturalWidth: naturalWidth,
      naturalHeight: naturalHeight,
      decodedMP: decodedMP,
      displayWidth: img && img.clientWidth ? img.clientWidth : 0,
      displayHeight: img && img.clientHeight ? img.clientHeight : 0
    };
  }

  function getTaskImageData(task) {
    return task && task.candidates ? task.candidates[task.idx] : null;
  }

  function getCandidateDisplaySrc(imgData) {
    return SharedUtils.getImageDisplaySrc ? SharedUtils.getImageDisplaySrc(imgData) : (imgData && imgData.src);
  }

  function getCandidatePreviewSrc(imgData) {
    return SharedUtils.getImagePreviewSrc ? SharedUtils.getImagePreviewSrc(imgData) : (imgData && imgData.src);
  }

  function buildPreviewUrls(candidates) {
    var urls = [];
    candidates = candidates || [];
    for (var i = 0; i < candidates.length; i++) {
      urls.push(getCandidatePreviewSrc(candidates[i]));
    }
    return urls;
  }

  function getTaskImageSrc(task) {
    var imgData = getTaskImageData(task);
    return getCandidateDisplaySrc(imgData);
  }

  function getTaskPreviewSrc(task) {
    return getCandidatePreviewSrc(getTaskImageData(task));
  }

  function getTaskPreviewIndex(task) {
    var imgData = getTaskImageData(task);
    // previewIndex is a position in sourceCandidates, which is the preview
    // list only for heavy-mode threads; ordinary threads preview
    // ts.candidates, where a fallback replacement sits at task.idx.
    var ts = imgData && typeof imgData.previewIndex === 'number' ? getThreadState(task.threadId) : null;
    return ts && ts.heavyMode && ts.sourceCandidates ? imgData.previewIndex : task.idx;
  }

  function getPreviewActivationLabel(task) {
    var ts = getThreadState(task && task.threadId);
    var previewCandidates = getPreviewCandidates(ts);
    var total = previewCandidates.length || (ts && ts.total) || 0;
    var index = task ? getTaskPreviewIndex(task) : -1;
    if (typeof index !== 'number' || !isFinite(index) || index < 0) return '打开图片预览';
    if (total > 0) return '打开第 ' + Math.min(index + 1, total) + ' 张图片预览，共 ' + total + ' 张';
    return '打开第 ' + (index + 1) + ' 张图片预览';
  }

  function isHighFanoutTask(task) {
    var imgData = getTaskImageData(task);
    if (imgData && getCandidatePreviewSrc(imgData) !== getCandidateDisplaySrc(imgData)) return false;
    return isHighFanoutImageHost(getTaskImageSrc(task));
  }

  function isHighFanoutPreviewTask(task) {
    return isHighFanoutImageHost(getTaskPreviewSrc(task));
  }

  function isHeavyChannelSrc(src, settings) {
    return isHighFanoutImageHost(src) && isHeavyImageOptimizationEnabled(settings);
  }

  function isHeavyChannelTask(task, settings) {
    var imgData = getTaskImageData(task);
    if (imgData && getCandidatePreviewSrc(imgData) !== getCandidateDisplaySrc(imgData)) return false;
    return isHeavyChannelSrc(getTaskImageSrc(task), settings);
  }

  function isHeavyScrollDeferred(task, settings) {
    return !!(
      HEAVY_SCROLLING &&
      document.visibilityState === 'visible' &&
      task &&
      !task.manualRetry &&
      isHeavyChannelTask(task, settings)
    );
  }

  function logRenderEvent(type, task, fields, level) {
    logImageEvent(type, task, fields, level);
  }

  function getScrollRoot(event) {
    var target = event && event.target;
    if (!target || target === window || target === document || target === document.documentElement || target === document.body) return null;
    if (target.classList && target.classList.contains('atp-scroll-viewport')) return target;
    return target.closest ? target.closest('.atp-scroll-viewport') : null;
  }

  function getScrollOffset(root) {
    return root ? (root.scrollTop || 0) : (window.pageYOffset || document.documentElement && document.documentElement.scrollTop || 0);
  }

  function markUserScrolling(event) {
    if (document.visibilityState !== 'visible') return;
    var nextScrollRoot = getScrollRoot(event);
    if (
      HEAVY_SCROLLING &&
      GLOBAL_SCROLL_ROOT !== nextScrollRoot &&
      window.ATPViewport &&
      ATPViewport.resetScrollPreload
    ) {
      ATPViewport.resetScrollPreload(GLOBAL_SCROLL_ROOT);
    }
    GLOBAL_SCROLL_ROOT = nextScrollRoot;
    if (window.ATPViewport && ATPViewport.updateScrollPreload) {
      ATPViewport.updateScrollPreload(GLOBAL_SCROLL_ROOT, getScrollOffset(GLOBAL_SCROLL_ROOT), Date.now());
    }
    if (!HEAVY_SCROLLING) {
      HEAVY_SCROLLING = true;
      logEventThrottled('renderScrollStart', 'render_state', {
        reason: 'scroll_start',
        active: GLOBAL_ACTIVE,
        ordinaryActive: getActiveOrdinaryCount(),
        heavyActive: GLOBAL_HIGH_FANOUT_ACTIVE
      }, 1200);
    }
    if (GLOBAL_SCROLL_TIMER) clearTimeout(GLOBAL_SCROLL_TIMER);
    GLOBAL_SCROLL_TIMER = setTimeout(function() {
      HEAVY_SCROLLING = false;
      GLOBAL_SCROLL_TIMER = null;
      if (window.ATPViewport && ATPViewport.resetScrollPreload) {
        ATPViewport.resetScrollPreload(GLOBAL_SCROLL_ROOT);
      }
      GLOBAL_SCROLL_ROOT = null;
      logEventThrottled('renderScrollIdle', 'render_state', {
        reason: 'scroll_idle',
        active: GLOBAL_ACTIVE,
        ordinaryActive: getActiveOrdinaryCount(),
        heavyActive: GLOBAL_HIGH_FANOUT_ACTIVE
      }, 1200);
      if (window.ATPViewport && ATPViewport.retryVisiblePending) {
        ATPViewport.retryVisiblePending();
      }
      if (window.ATPViewport && ATPViewport.resumeHeavyRestores) {
        ATPViewport.resumeHeavyRestores();
      }
      ATPLoader.globalSchedule();
    }, HEAVY_SCROLL_IDLE_MS);
  }

  function clearScrollIdleTimer() {
    if (GLOBAL_SCROLL_TIMER) {
      clearTimeout(GLOBAL_SCROLL_TIMER);
      GLOBAL_SCROLL_TIMER = null;
    }
    if (window.ATPViewport && ATPViewport.resetScrollPreload) {
      ATPViewport.resetScrollPreload(GLOBAL_SCROLL_ROOT);
    }
    GLOBAL_SCROLL_ROOT = null;
    HEAVY_SCROLLING = false;
  }

  function ensureScrollListener() {
    if (GLOBAL_SCROLL_LISTENER) return;
    GLOBAL_SCROLL_LISTENER = markUserScrolling;
    // document 捕获阶段即可覆盖视口滚动与元素滚动；再挂 window 会让每次滚动重复触发一次
    document.addEventListener('scroll', GLOBAL_SCROLL_LISTENER, GLOBAL_SCROLL_CAPTURE_OPTIONS);
  }

  function unregisterActiveImageLoad(control) {
    if (!control || !control.active) return;
    control.active = false;
    for (var i = ACTIVE_IMAGE_LOADS.length - 1; i >= 0; i--) {
      if (ACTIVE_IMAGE_LOADS[i] === control) {
        ACTIVE_IMAGE_LOADS.splice(i, 1);
        break;
      }
    }
  }

  function registerActiveImageLoad(control) {
    if (!control || typeof control.cancel !== 'function') return function() {};
    control.active = true;
    ACTIVE_IMAGE_LOADS.push(control);
    return function() {
      unregisterActiveImageLoad(control);
    };
  }

  function cancelImageLoadElement(img) {
    if (!img) return;
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    img.removeAttribute('srcset');
  }

  function cancelActiveImageLoads(reason) {
    if (!ACTIVE_IMAGE_LOADS.length) return;
    var loads = ACTIVE_IMAGE_LOADS;
    ACTIVE_IMAGE_LOADS = [];
    for (var i = 0; i < loads.length; i++) {
      var control = loads[i];
      if (!control || !control.active) continue;
      control.active = false;
      try {
        control.cancel(reason || 'reset');
      } catch (e) {
        console.warn('[ATPLoader] active image load cancel failed:', e);
      }
    }
  }

  function recoverActiveImageLoads(reason) {
    restoreSuspendedActiveSlotCountsForBfcache(reason);
    if (!ACTIVE_IMAGE_LOADS.length) return;
    var loads = ACTIVE_IMAGE_LOADS.slice();
    for (var i = 0; i < loads.length; i++) {
      var control = loads[i];
      if (!control || !control.active) continue;
      try {
        if (typeof control.recover === 'function') {
          control.recover(reason || 'recover');
        } else {
          unregisterActiveImageLoad(control);
          control.cancel(reason || 'recover');
        }
      } catch (e) {
        console.warn('[ATPLoader] active image load recover failed:', e);
      }
    }
  }

  function getTaskActiveSlotToken(task) {
    return task ? task.activeSlotToken : null;
  }

  function isRegisteredActiveSlot(task) {
    var slotToken = getTaskActiveSlotToken(task);
    return slotToken !== undefined &&
      slotToken !== null &&
      Object.prototype.hasOwnProperty.call(GLOBAL_ACTIVE_SLOTS, slotToken) &&
      GLOBAL_ACTIVE_SLOTS[slotToken] === task;
  }

  function clearTaskActiveSlotState(task) {
    if (!task) return;
    task.highFanoutSlot = false;
    task.slotActive = false;
    task.slotCounted = false;
    task.slotEpoch = null;
    task.activeSlotToken = null;
  }

  function clearRegisteredActiveSlots() {
    for (var slotToken in GLOBAL_ACTIVE_SLOTS) {
      if (!Object.prototype.hasOwnProperty.call(GLOBAL_ACTIVE_SLOTS, slotToken)) continue;
      var task = GLOBAL_ACTIVE_SLOTS[slotToken];
      if (task && String(task.activeSlotToken) === String(slotToken)) {
        clearTaskActiveSlotState(task);
      }
    }
    GLOBAL_ACTIVE_SLOTS = {};
  }

  function hasRegisteredActiveSlots() {
    for (var slotToken in GLOBAL_ACTIVE_SLOTS) {
      if (Object.prototype.hasOwnProperty.call(GLOBAL_ACTIVE_SLOTS, slotToken)) return true;
    }
    return false;
  }

  function restoreSuspendedActiveSlotCountsForBfcache(reason) {
    var restored = 0;
    for (var slotToken in GLOBAL_ACTIVE_SLOTS) {
      if (!Object.prototype.hasOwnProperty.call(GLOBAL_ACTIVE_SLOTS, slotToken)) continue;
      var task = GLOBAL_ACTIVE_SLOTS[slotToken];
      if (
        task &&
        task.slotActive &&
        task.slotCounted === false &&
        task.slotEpoch === IMAGE_SLOT_EPOCH &&
        String(task.activeSlotToken) === String(slotToken)
      ) {
        task.slotCounted = true;
        task.highFanoutSlot = false;
        GLOBAL_ACTIVE++;
        updateActiveHighFanoutSlot(task, getTaskImageSrc(task));
        restored++;
      }
    }
    if (restored) {
      logEventThrottled('activeSlotRecover', 'image_slot_recover', function() {
        return {
          reason: reason || 'bfcache_pageshow',
          active: GLOBAL_ACTIVE,
          ordinaryActive: Math.max(0, GLOBAL_ACTIVE - GLOBAL_HIGH_FANOUT_ACTIVE),
          heavyActive: GLOBAL_HIGH_FANOUT_ACTIVE,
          restored: restored
        };
      }, 1000);
    }
  }

  function updateActiveHighFanoutSlot(task, src) {
    if (!task || !task.slotActive) return;
    if (task.slotCounted === false) return;
    if (task.slotEpoch !== IMAGE_SLOT_EPOCH) return;
    if (!isRegisteredActiveSlot(task)) return;
    // Count with the admission rule: a heavy-host thumbnail whose preview
    // differs is admitted as ordinary and must occupy an ordinary slot, or the
    // heavy counter overflows while ordinary limits see free capacity.
    var nextHighFanout = src === getTaskImageSrc(task) ? isHeavyChannelTask(task) : isHeavyChannelSrc(src);
    if (task.highFanoutSlot === nextHighFanout) return;
    if (task.highFanoutSlot && GLOBAL_HIGH_FANOUT_ACTIVE > 0) GLOBAL_HIGH_FANOUT_ACTIVE--;
    if (nextHighFanout) GLOBAL_HIGH_FANOUT_ACTIVE++;
    task.highFanoutSlot = nextHighFanout;
  }

  function claimImageSlot(task) {
    if (task && task.slotActive) releaseImageSlot(task, task.activeSlotToken);
    GLOBAL_ACTIVE++;
    if (task) {
      var now = Date.now();
      var slotToken = ++IMAGE_SLOT_TOKEN;
      if (!task.createdAt) task.createdAt = task.queuedAt || now;
      task.queueWaitMs = task.queuedAt ? Math.max(0, now - task.queuedAt) : 0;
      task.slotActive = true;
      task.slotCounted = true;
      task.slotEpoch = IMAGE_SLOT_EPOCH;
      task.activeSlotToken = slotToken;
      task.highFanoutSlot = false;
      task.loadStartAt = now;
      startOnLiveAttachmentHost(task);
      if (!task.taskDeadlineAt) {
        var deadlineSettings = getCurrentSettings() || {};
        var taskDeadlineMs = isLargeLaneTask(task)
          ? ATPLoadPolicy.getLargeImageTaskDeadline(deadlineSettings)
          : ATPLoadPolicy.getImageTaskDeadline(deadlineSettings);
        task.taskDeadlineAt = taskDeadlineMs > 0 ? now + taskDeadlineMs : 0;
        task.taskDeadlineMs = taskDeadlineMs;
        // A fresh deadline is a fresh attempt; the slow-image grace used by an
        // earlier attempt (before a requeue or retry) must be available again.
        task.timeoutGraceTried = false;
      }
      task.noReferrerFallbackTried = false;
      resetNoReferrerFallbackWindow(task, now);
      GLOBAL_ACTIVE_SLOTS[slotToken] = task;
      updateActiveHighFanoutSlot(task, getTaskImageSrc(task));
      // 字段参数会先于日志开关求值（含限速链计算），关闭日志时整体跳过
      if (isDiagnosticLoggingEnabled('DEBUG')) {
        var settings = getCurrentSettings();
        logImageEvent('image_start', task, {
          highFanoutLimit: isHeavyChannelTask(task, settings)
            ? getEffectiveHighFanoutSlotLimit(task, settings, getActiveOrdinaryCount() > 0)
            : getHighFanoutSlotLimit(settings, getActiveOrdinaryCount() > 0)
        });
      }
    }
  }

  function releaseImageSlot(task, slotToken) {
    var released = false;
    if (task && task.slotActive) {
      var currentSlotToken = getTaskActiveSlotToken(task);
      if (slotToken !== undefined && slotToken !== null && currentSlotToken !== slotToken) return;
      var sameEpoch = task.slotEpoch === IMAGE_SLOT_EPOCH;
      var registered = isRegisteredActiveSlot(task);
      var counted = task.slotCounted !== false;
      if (registered && counted && task.highFanoutSlot && GLOBAL_HIGH_FANOUT_ACTIVE > 0) GLOBAL_HIGH_FANOUT_ACTIVE--;
      if (registered) delete GLOBAL_ACTIVE_SLOTS[currentSlotToken];
      clearTaskActiveSlotState(task);
      if (!sameEpoch || !registered || !counted) return;
      if (GLOBAL_ACTIVE > 0) {
        GLOBAL_ACTIVE--;
        released = true;
      }
    } else if (!task && GLOBAL_ACTIVE > 0) {
      GLOBAL_ACTIVE--;
      released = true;
    }
    if (released) scheduleViewportPendingSlotWake();
  }

  function resetActiveImageSlots(reason) {
    var active = GLOBAL_ACTIVE;
    var heavyActive = GLOBAL_HIGH_FANOUT_ACTIVE;
    cancelActiveImageLoads(reason);
    if (!GLOBAL_ACTIVE && !GLOBAL_HIGH_FANOUT_ACTIVE && !hasRegisteredActiveSlots()) {
      IMAGE_SLOT_EPOCH++;
      GLOBAL_ACTIVE_SLOTS = {};
      return;
    }
    logEventThrottled('activeSlotReset', 'image_slot_reset', function() {
      return {
        reason: reason || 'reset',
        active: active,
        ordinaryActive: Math.max(0, active - heavyActive),
        heavyActive: heavyActive
      };
    }, 1000);
    IMAGE_SLOT_EPOCH++;
    clearRegisteredActiveSlots();
    GLOBAL_ACTIVE = 0;
    GLOBAL_HIGH_FANOUT_ACTIVE = 0;
    scheduleViewportPendingSlotWake();
  }

  function suspendActiveImageSlotsForBfcache(reason) {
    var active = GLOBAL_ACTIVE;
    var heavyActive = GLOBAL_HIGH_FANOUT_ACTIVE;
    if (!active && !heavyActive) return;
    logEventThrottled('activeSlotSuspend', 'image_slot_reset', function() {
      return {
        reason: reason || 'bfcache_pagehide',
        active: active,
        ordinaryActive: Math.max(0, active - heavyActive),
        heavyActive: heavyActive
      };
    }, 1000);
    for (var slotToken in GLOBAL_ACTIVE_SLOTS) {
      if (!Object.prototype.hasOwnProperty.call(GLOBAL_ACTIVE_SLOTS, slotToken)) continue;
      var task = GLOBAL_ACTIVE_SLOTS[slotToken];
      if (task && String(task.activeSlotToken) === String(slotToken)) {
        task.slotCounted = false;
      }
    }
    GLOBAL_ACTIVE = 0;
    GLOBAL_HIGH_FANOUT_ACTIVE = 0;
  }

  function teardownActiveSlots(reason) {
    resetActiveImageSlots(reason || 'teardown');
    clearViewportSlotWakeTimer();
  }

  function clearHeavyHostWakeTimers() {
    for (var host in HEAVY_HOST_WAKE_TIMERS) {
      if (!Object.prototype.hasOwnProperty.call(HEAVY_HOST_WAKE_TIMERS, host)) continue;
      var entry = HEAVY_HOST_WAKE_TIMERS[host];
      if (entry && entry.timer) clearTimeout(entry.timer);
    }
    HEAVY_HOST_WAKE_TIMERS = {};
  }

  function scheduleHeavyHostWake(host, delayMs) {
    if (!host || GLOBAL_PAUSED) return;
    host = String(host).toLowerCase();
    var delay = Math.max(50, Number(delayMs) || 0) + 10;
    var dueAt = Date.now() + delay;
    var existing = HEAVY_HOST_WAKE_TIMERS[host];
    if (existing && existing.dueAt <= dueAt) return;
    if (existing && existing.timer) clearTimeout(existing.timer);
    HEAVY_HOST_WAKE_TIMERS[host] = {
      dueAt: dueAt,
      timer: setTimeout(function() {
        delete HEAVY_HOST_WAKE_TIMERS[host];
        if (GLOBAL_PAUSED) return;
        // 冷却到期时若已无任何待处理工作，跳过整轮重试+排程
        if (!BG_TASKS.length && !ATPLoader.getViewportPendingCount() &&
          !getActiveFirstThreadIds(window.ATPState && window.ATPState.threads || {}).length) {
          return;
        }
        retryViewportVisiblePendingLoads();
        retryViewportPendingSlotLoads();
        ATPLoader.globalSchedule();
      }, delay)
    };
  }

  function shouldDeferHighFanoutTask(task, settings, hasNonHighFanoutWaiting) {
    if (!task || !isHeavyChannelTask(task, settings)) return false;
    if (isHeavyScrollDeferred(task, settings)) {
      if (!task.heavyScrollDeferredLogged) {
        task.heavyScrollDeferredLogged = true;
        logEventThrottled('heavyScrollDeferred', 'image_defer', function() {
          return getTaskLogFields(task, {
            reason: 'scrolling',
            limit: getEffectiveHighFanoutSlotLimit(task, settings, false),
            configuredLimit: getHeavyImageConcurrency(settings),
            scrollIdleMs: HEAVY_SCROLL_IDLE_MS
          });
        }, 1200);
      }
      return true;
    }
    task.heavyScrollDeferredLogged = false;
    var hasOrdinaryWork = !!hasNonHighFanoutWaiting || getActiveOrdinaryCount() > 0;
    var healthFields = getHeavyHostHealthLogFields(task, settings, hasOrdinaryWork);
    var limit = healthFields.heavyHostLimit !== undefined
      ? healthFields.heavyHostLimit
      : getHighFanoutSlotLimit(settings, hasOrdinaryWork);
    var configuredHeavyLimit = getHeavyImageConcurrency(settings);
    var admissionActive = healthFields.heavyHostVisibleProbe
      ? (healthFields.heavyHostPriorityActive || 0)
      : GLOBAL_HIGH_FANOUT_ACTIVE;
    var defer = GLOBAL_HIGH_FANOUT_ACTIVE >= configuredHeavyLimit || admissionActive >= limit;
    if (healthFields.heavyHostState === 'open') {
      scheduleHeavyHostWake(healthFields.heavyHost, healthFields.heavyHostCooldownRemainingMs);
    }
    if (defer && !task.highFanoutDeferredLogged) {
      task.highFanoutDeferredLogged = true;
      logDebugThrottled('highFanoutDeferred', 'High fanout slot deferred', 'active ' + admissionActive + '/' + limit + ' ' + String(getTaskImageSrc(task) || '').substring(0, 120), 3000);
      logImageEvent('image_defer', task, Object.assign({
        reason: healthFields.heavyHostState === 'open'
          ? 'heavy_host_open'
          : (healthFields.heavyHostLimited ? 'heavy_host_limited' : (hasOrdinaryWork ? 'ordinary_pressure' : 'heavy_limit')),
        limit: limit,
        configuredLimit: configuredHeavyLimit,
        admissionActive: admissionActive,
        visibleProbe: !!healthFields.heavyHostVisibleProbe,
        hasOrdinaryWaiting: !!hasNonHighFanoutWaiting
      }, healthFields));
    } else if (!defer) {
      task.highFanoutDeferredLogged = false;
    }
    return defer;
  }

  function shouldDeferForTotalSlots(task, totalLimit) {
    if (typeof totalLimit !== 'number' || !isFinite(totalLimit)) totalLimit = getTotalImageSlotLimit();
    var admissionLimit = getGlobalSlotAdmissionLimit(task, totalLimit);
    var visibleReserve = Math.max(0, totalLimit - admissionLimit);
    var reserveApplies = !!(
      task &&
      !isPriorityImageTask(task) &&
      !isHeavyChannelTask(task, getCurrentSettings())
    );
    var admissionActive = reserveApplies ? getActiveOrdinaryCount() : GLOBAL_ACTIVE;
    var defer = GLOBAL_ACTIVE >= totalLimit;
    if (!defer && reserveApplies) defer = admissionActive >= admissionLimit;
    if (defer && task && !task.globalSlotDeferredLogged) {
      task.globalSlotDeferredLogged = true;
      logImageEvent('image_defer', task, {
        reason: 'global_limit',
        limit: admissionLimit,
        configuredLimit: totalLimit,
        admissionActive: admissionActive,
        viewportPriorityReserve: visibleReserve
      });
    } else if (!defer && task) {
      task.globalSlotDeferredLogged = false;
    }
    return defer;
  }

  function getLargeLaneCap(snapshot, visible) {
    var limit = snapshot.ordinaryHostLargeLimit;
    return visible
      ? limit + (snapshot.ordinaryHostLargePriorityActive === 0 ? 1 : 0)
      : Math.max(1, Math.min(limit - 1, Math.ceil(limit / 2)));
  }

  // True when the last admission check refused this task only because of its
  // host's GIF lane, so callers can tell a lane wait from a lack of general
  // slots. Recorded by the check itself: it used the caller's limit (the
  // background or offscreen first-row limit), which a fresh snapshot here
  // would not know.
  function isLargeLaneBlocked(task) {
    return !!(task && task.largeLaneDeferred && !task.manualRetry && isLargeLaneTask(task));
  }

  function shouldDeferOrdinaryHostTask(task, ordinaryLimit) {
    var settings = getCurrentSettings() || {};
    if (!task || task.manualRetry || isHeavyChannelTask(task, settings)) return false;
    var snapshot = getOrdinaryHostHealthSnapshot(getTaskImageSrc(task), getOrdinaryImageSlotLimit(ordinaryLimit));
    if (!snapshot) return false;
    var admissionActive = snapshot.ordinaryHostActive;
    var admissionLimit = snapshot.ordinaryHostLimit;
    var usesVisibleReserve = !!task.viewportPriority;
    if (usesVisibleReserve) {
      admissionActive = snapshot.ordinaryHostPriorityActive;
      admissionLimit = Math.max(
        admissionLimit,
        Math.min(snapshot.ordinaryHostBaseLimit, ATPLoadPolicy.getOrdinaryHostSoftLimit(getCurrentSettings() || {}))
      );
    }
    // Full-list first-row loading can otherwise let visible probes bypass a
    // crowded host while many offscreen originals are already in flight. The
    // cap is the fixed safety limit, not the adaptive one: a cooling host
    // drops to 1-2 and is already covered by the visible-reserve rule above.
    var autoHostFull = settings.autoLoadOffscreenFirstRowsEnabled === true &&
      snapshot.ordinaryHostActive >= Math.min(6, snapshot.ordinaryHostBaseLimit);
    var defer = autoHostFull || admissionActive >= admissionLimit;
    // GIFs wait for the host's small GIF lane (counted over every GIF in
    // flight, visible or not) while static thumbnails keep the other slots.
    // Offscreen GIFs leave one lane free for a visible GIF. GIFs admitted as
    // visible can scroll away and hold the lane for their long deadline, so
    // a visible GIF gets one extra lane while no GIF in flight is visible.
    var largeLaneFull = false;
    var largeCap = 0;
    if (!defer && isLargeLaneTask(task)) {
      largeCap = getLargeLaneCap(snapshot, isPriorityImageTask(task));
      largeLaneFull = snapshot.ordinaryHostLargeActive >= largeCap;
      defer = largeLaneFull;
      task.largeLaneDeferred = largeLaneFull;
    }
    if (defer && !task.ordinaryHostDeferredLogged) {
      task.ordinaryHostDeferredLogged = true;
      logImageEvent('image_defer', task, {
        reason: largeLaneFull ? 'ordinary_large_lane' : snapshot.ordinaryHostCooling ? 'ordinary_host_cooling' :
          (autoHostFull ? 'ordinary_host_auto_limit' : 'ordinary_host_limit'),
        largeActive: largeLaneFull ? snapshot.ordinaryHostLargeActive : undefined,
        largePriorityActive: largeLaneFull ? snapshot.ordinaryHostLargePriorityActive : undefined,
        largeLimit: largeLaneFull ? snapshot.ordinaryHostLargeLimit : undefined,
        largeCap: largeLaneFull ? largeCap : undefined,
        hostActive: admissionActive,
        hostLimit: admissionLimit,
        hostTotalActive: snapshot.ordinaryHostActive,
        hostPriorityActive: snapshot.ordinaryHostPriorityActive,
        visibleReserve: usesVisibleReserve,
        hostBaseLimit: snapshot.ordinaryHostBaseLimit,
        hostFailures: snapshot.ordinaryHostFailures,
        hostCooldownRemainingMs: snapshot.ordinaryHostCooldownRemainingMs
      });
    } else if (!defer) {
      task.ordinaryHostDeferredLogged = false;
    }
    return defer;
  }

  function shouldDeferTaskForSlots(task, ordinaryLimit, hasNonHighFanoutWaiting) {
    if (task) task.largeLaneDeferred = false;
    // A task for a host known to be down moves first, so the host snapshot,
    // GIF lane and per-host limits below are the sibling's.
    startOnLiveAttachmentHost(task);
    var settings = getCurrentSettings();
    var totalLimit = getTotalImageSlotLimit();
    var normalizedOrdinaryLimit = getOrdinaryImageSlotLimit(ordinaryLimit);
    if (shouldDeferForTotalSlots(task, totalLimit)) return true;
    if (isHeavyChannelTask(task, settings)) {
      return shouldDeferHighFanoutTask(task, settings, hasNonHighFanoutWaiting);
    }
    if (shouldDeferOrdinaryHostTask(task, normalizedOrdinaryLimit)) return true;
    var limit = normalizedOrdinaryLimit;
    if (task && task.offscreenAutoLoad && !isPriorityImageTask(task)) {
      limit = Math.min(limit, ATPLoadPolicy.getOffscreenFirstRowOrdinaryLimit(settings || {}));
    }
    var defer = getActiveOrdinaryCount() >= limit;
    if (defer && task && !task.ordinaryDeferredLogged) {
      task.ordinaryDeferredLogged = true;
      logImageEvent('image_defer', task, {
        reason: 'ordinary_limit',
        limit: limit,
        configuredLimit: limit
      });
    } else if (!defer && task) {
      task.ordinaryDeferredLogged = false;
    }
    return defer;
  }

  function getFirstTaskOffset(ts) {
    return Math.max(0, (ts && ts.firstTaskOffset) || 0);
  }

  function hasPendingFirstTasks(ts) {
    return !!(ts && ts.firstTasks && getFirstTaskOffset(ts) < ts.firstTasks.length);
  }

  function peekFirstTask(ts) {
    return hasPendingFirstTasks(ts) ? ts.firstTasks[getFirstTaskOffset(ts)] : null;
  }

  function consumeFirstTask(ts) {
    var offset = getFirstTaskOffset(ts);
    var task = ts && ts.firstTasks ? ts.firstTasks[offset] : null;
    if (!task) return null;
    ts.firstTaskOffset = offset + 1;
    if (ts.firstTaskOffset > 16 && ts.firstTaskOffset * 2 >= ts.firstTasks.length) {
      ts.firstTasks.splice(0, ts.firstTaskOffset);
      ts.firstTaskOffset = 0;
    }
    return task;
  }

  // A GIF waiting for its host's GIF lane must not hold back the thread's
  // static or heavy-host first tasks behind it (heavy threads are not
  // reordered static-first, and failed retries are appended at the end).
  // The GIF stays at the head so it starts as soon as its lane frees; a later
  // non-GIF task starts past it only when it passes the same gates now, so
  // nothing that cannot start is moved in front of the GIF.
  function startFirstTaskPastLargeLane(ts, head, distance, gates) {
    if (!head || !isLargeLaneBlocked(head)) return false;
    var offset = getFirstTaskOffset(ts);
    for (var i = offset + 1; i < ts.firstTasks.length; i++) {
      var next = ts.firstTasks[i];
      if (!next || isLargeLaneTask(next)) continue;
      next.viewportPriority = distance === 0;
      next.offscreenAutoLoad = gates.autoLoadOffscreen && distance !== 0;
      if (next.offscreenAutoLoad && (HEAVY_SCROLLING || GLOBAL_ACTIVE >= gates.offscreenAdmissionLimit)) continue;
      if (next.offscreenAutoLoad && GLOBAL_HIGH_FANOUT_ACTIVE >= gates.offscreenHeavyLimit &&
          isHeavyChannelTask(next, gates.settings)) continue;
      if (shouldDeferTaskForSlots(next, next.offscreenAutoLoad ? gates.offscreenLimit : gates.max, gates.hasOrdinaryWaiting)) continue;
      ts.firstTasks.splice(i, 1);
      next.viewportRegistration = false;
      ATPLoader.globalLoadImage(next);
      return true;
    }
    return false;
  }

  function hasNonHighFanoutFirstTask(threadIds, threads) {
    for (var i = 0; i < threadIds.length; i++) {
      var ts = threads[threadIds[i]];
      if (!isThreadCurrent(ts) || !hasPendingFirstTasks(ts) || ts.firstScreenDone) continue;
      if (!isHeavyChannelTask(peekFirstTask(ts))) return true;
    }
    return false;
  }

  function markBgTasksChanged() {
    BG_TASKS_VERSION++;
  }

  // BG 通道快照按 BG_TASKS_VERSION 复用（与 getAvailableSlots / hasNonHighFanoutBgTask 同一容忍度）：
  // 队列峰值可达上千条，而每张图完成都会同步跑一轮排程，逐轮全量重扫是纯浪费
  function getCachedBgSnapshot() {
    if (BG_SNAPSHOT_CACHE_VERSION !== BG_TASKS_VERSION) {
      BG_SNAPSHOT_CACHE = getTaskChannelSnapshot(BG_TASKS);
      BG_SNAPSHOT_CACHE_VERSION = BG_TASKS_VERSION;
    }
    return BG_SNAPSHOT_CACHE;
  }

  // 队列全量扫描内按 threadId 记忆 isThreadCurrent 结果：
  // 同一帖的几十个任务只做一次 document.contains 检查（单次同步扫描内 DOM 不会变化）
  function isTaskCurrentMemo(task, memo) {
    if (!task || !task.threadId) return false;
    var ts = memo[task.threadId];
    if (ts === undefined) {
      var state = getThreadState(task.threadId);
      ts = memo[task.threadId] = isThreadCurrent(state) ? state : null;
    }
    if (!ts) return false;
    if (typeof task.generation === 'number' && typeof ts.generation === 'number' && task.generation !== ts.generation) return false;
    return true;
  }

  function hasNonHighFanoutBgTask() {
    if (BG_ORDINARY_CACHE_VERSION === BG_TASKS_VERSION) return BG_HAS_ORDINARY_TASK;
    BG_HAS_ORDINARY_TASK = false;
    var memo = {};
    for (var i = 0; i < BG_TASKS.length; i++) {
      if (isTaskCurrentMemo(BG_TASKS[i], memo) && !isHeavyChannelTask(BG_TASKS[i])) {
        BG_HAS_ORDINARY_TASK = true;
        break;
      }
    }
    BG_ORDINARY_CACHE_VERSION = BG_TASKS_VERSION;
    return BG_HAS_ORDINARY_TASK;
  }

  function findFirstHeavyTask(tasks) {
    var memo = {};
    for (var i = 0; i < (tasks || []).length; i++) {
      var task = tasks[i];
      if (isTaskCurrentMemo(task, memo) && isHeavyChannelTask(task)) return task;
    }
    return null;
  }

  function getTaskChannelSnapshot(tasks) {
    var snapshot = { ordinary: 0, heavy: 0, firstHeavyTask: null, firstOrdinaryIndex: -1 };
    var memo = {};
    for (var i = 0; i < (tasks || []).length; i++) {
      var task = tasks[i];
      if (!isTaskCurrentMemo(task, memo)) continue;
      if (isHeavyChannelTask(task)) {
        snapshot.heavy++;
        if (!snapshot.firstHeavyTask) snapshot.firstHeavyTask = task;
      } else {
        snapshot.ordinary++;
        if (snapshot.firstOrdinaryIndex === -1) snapshot.firstOrdinaryIndex = i;
      }
    }
    return snapshot;
  }

  var BG_VISIBLE_PROMOTE_MAX = 16;
  var BG_VISIBLE_PROMOTE_INTERVAL_MS = 250;
  var lastVisiblePromoteAt = 0;

  // 把「当前在视口内的帖子」的后台任务稳定前移到队首（保持相对顺序，最多 16 个），
  // 250ms 节流；返回是否发生了重排（发生时调用方需重新取通道快照）
  function promoteVisibleThreadBgTasks() {
    if (BG_TASKS.length < 2 || document.visibilityState !== 'visible') return false;
    var now = Date.now();
    if (lastVisiblePromoteAt && now - lastVisiblePromoteAt < BG_VISIBLE_PROMOTE_INTERVAL_MS) return false;
    lastVisiblePromoteAt = now;
    var threads = window.ATPState && window.ATPState.threads;
    if (!threads) return false;
    var promoted = [];
    var rest = [];
    var memo = {};
    var distanceByTid = {};
    for (var i = 0; i < BG_TASKS.length; i++) {
      var task = BG_TASKS[i];
      if (promoted.length < BG_VISIBLE_PROMOTE_MAX && task && task.threadId && isTaskCurrentMemo(task, memo)) {
        var d = distanceByTid[task.threadId];
        if (d === undefined) {
          d = distanceByTid[task.threadId] = getThreadViewportDistance(memo[task.threadId]);
        }
        if (d === 0) {
          promoted.push(task);
          continue;
        }
      }
      rest.push(task);
    }
    if (!promoted.length) return false;
    var alreadyFront = true;
    for (var j = 0; j < promoted.length; j++) {
      if (BG_TASKS[j] !== promoted[j]) {
        alreadyFront = false;
        break;
      }
    }
    if (alreadyFront) return false;
    BG_TASKS = promoted.concat(rest);
    markBgTasksChanged();
    return true;
  }

  function promoteFirstOrdinaryBgTask(bgSnapshot) {
    if (!bgSnapshot || bgSnapshot.firstOrdinaryIndex <= 0 || bgSnapshot.firstOrdinaryIndex >= BG_TASKS.length) return bgSnapshot;
    var ordinaryTask = BG_TASKS[bgSnapshot.firstOrdinaryIndex];
    if (!isTaskCurrent(ordinaryTask) || isHeavyChannelTask(ordinaryTask)) return bgSnapshot;
    BG_TASKS.splice(bgSnapshot.firstOrdinaryIndex, 1);
    BG_TASKS.unshift(ordinaryTask);
    markBgTasksChanged();
    // 前移一个任务不改变各通道计数，只是首个普通任务到了队首——原地修正快照即可，
    // 不必为此再做一次 O(N) 全队列重扫
    bgSnapshot.firstOrdinaryIndex = 0;
    return bgSnapshot;
  }

  function getFirstTaskChannelSnapshot(threadIds, threads) {
    var snapshot = { ordinary: 0, heavy: 0, firstHeavyTask: null };
    for (var i = 0; i < (threadIds || []).length; i++) {
      var ts = threads[threadIds[i]];
      if (!isThreadCurrent(ts) || !hasPendingFirstTasks(ts) || ts.firstScreenDone) continue;
      var task = peekFirstTask(ts);
      if (isHeavyChannelTask(task)) {
        snapshot.heavy++;
        if (!snapshot.firstHeavyTask) snapshot.firstHeavyTask = task;
      } else {
        snapshot.ordinary++;
      }
    }
    return snapshot;
  }

  function isHiddenPauseCancelReason(reason) {
    return reason === HIDDEN_PAUSE_CANCEL_REASON;
  }

  function resetPausedImageTaskForRequeue(task, reason) {
    if (!task) return;
    var now = Date.now();
    task.queuedAt = now;
    task.queueWaitMs = 0;
    task.loadStartAt = 0;
    task.taskDeadlineAt = 0;
    task.noReferrerFallbackTried = false;
    resetNoReferrerFallbackWindow(task, now);
    // 上一轮加载时标记的可见性已过时，重新入队后由新一轮排程重新判定，
    // 否则已滚出视口的任务会继续占用视口优先的保留槽位
    task.currentlyVisible = undefined;
    task.forceEager = false;
    task.forcePreload = false;
    task.globalSlotDeferredLogged = false;
    task.ordinaryDeferredLogged = false;
    task.ordinaryHostDeferredLogged = false;
    task.highFanoutDeferredLogged = false;
    task.heavyScrollDeferredLogged = false;
    if (reason) task.hiddenPauseReason = reason;
  }

  function requeuePausedImageTask(task, wrapper, loadingEl, reason) {
    if (!task || task.manualRetry || !isTaskCurrent(task)) return false;
    var ts = getThreadState(task.threadId);
    resetPausedImageTaskForRequeue(task, reason || HIDDEN_PAUSE_CANCEL_REASON);
    task.pausedWrapper = wrapper || null;
    task.pausedLoadingEl = loadingEl || null;
    if (task.isFirstScreen && ts && ts.firstTasks && !ts.firstScreenDone && !task.firstScreenSettled) {
      task.queueKind = 'first_hidden_resume';
      ts.firstTasks.splice(getFirstTaskOffset(ts), 0, task);
    } else {
      task.queueKind = 'background_hidden_resume';
      BG_TASKS.unshift(task);
      markBgTasksChanged();
    }
    logImageEvent('image_defer', task, {
      reason: 'hidden_pause_requeue'
    });
    if (!GLOBAL_PAUSED) ATPLoader.globalSchedule();
    return true;
  }

  function getActiveFirstThreadIds(threads) {
    var ids = [];
    threads = threads || {};
    for (var tid in threads) {
      if (!Object.prototype.hasOwnProperty.call(threads, tid)) continue;
      var ts = threads[tid];
      if (isThreadCurrent(ts) && hasPendingFirstTasks(ts) && !ts.firstScreenDone) {
        ids.push(tid);
      }
    }
    return ids;
  }

  // 单轮排程内的距离测量缓存：同一线程一轮多处取距离时只做一次 getBoundingClientRect，
  // 由 roundRobinSchedule 以 begin/end 包裹；缓存为 null 时退化为直接测量
  var THREAD_DISTANCE_CACHE = null;

  function beginViewportDistancePass() {
    THREAD_DISTANCE_CACHE = new Map();
  }

  function endViewportDistancePass() {
    THREAD_DISTANCE_CACHE = null;
  }

  function getThreadViewportDistance(ts) {
    if (THREAD_DISTANCE_CACHE && THREAD_DISTANCE_CACHE.has(ts)) {
      return THREAD_DISTANCE_CACHE.get(ts);
    }
    var distance = measureThreadViewportDistance(ts);
    if (THREAD_DISTANCE_CACHE) THREAD_DISTANCE_CACHE.set(ts, distance);
    return distance;
  }

  function measureThreadViewportDistance(ts) {
    if (document.visibilityState !== 'visible') return null;
    var element = ts && (ts.outerRow || ts.panel || ts.container);
    if (!element || !element.getBoundingClientRect || (document.contains && !document.contains(element))) return null;
    var rect = element.getBoundingClientRect();
    var height = window.innerHeight || document.documentElement && document.documentElement.clientHeight || 0;
    if (!height || !rect) return null;
    var topEdge = -FIRST_TASK_VIEWPORT_MARGIN_PX;
    var bottomEdge = height + FIRST_TASK_VIEWPORT_MARGIN_PX;
    if (rect.bottom >= topEdge && rect.top <= bottomEdge) return 0;
    if (rect.top > bottomEdge) return Math.max(0, rect.top - bottomEdge);
    return Math.max(0, topEdge - rect.bottom);
  }

  function rankFirstThreadIdsByViewport(threadIds, threads) {
    var ranked = [];
    for (var i = 0; i < threadIds.length; i++) {
      ranked.push({
        id: threadIds[i],
        index: i,
        distance: getThreadViewportDistance(threads[threadIds[i]])
      });
    }
    ranked.sort(function(a, b) {
      var aDistance = a.distance === null ? Number.MAX_VALUE : a.distance;
      var bDistance = b.distance === null ? Number.MAX_VALUE : b.distance;
      return aDistance - bDistance || a.index - b.index;
    });
    return ranked;
  }

  function getViewportPriorityFirstThreadIds(threadIds, threads) {
    var ranked = rankFirstThreadIdsByViewport(threadIds, threads);
    var near = [];
    var hasMeasuredThread = false;
    for (var i = 0; i < ranked.length; i++) {
      if (ranked[i].distance === null) continue;
      hasMeasuredThread = true;
      if (ranked[i].distance === 0) near.push(ranked[i].id);
    }
    if (!hasMeasuredThread) return [];
    if (near.length) return near;
    var fallbackCount = Math.min(FIRST_TASK_NEAREST_FALLBACK_COUNT, ranked.length);
    var nearest = [];
    for (var j = 0; j < fallbackCount; j++) nearest.push(ranked[j].id);
    return nearest;
  }

  function shouldRegisterFirstTaskInViewport(ts, task, settings) {
    if (!window.ATPViewport || !task || shouldBypassViewportLazyLoad(settings)) return false;
    if (settings && settings.autoLoadOffscreenFirstRowsEnabled === true) return false;
    var distance = getThreadViewportDistance(ts);
    return distance !== null && distance > 0;
  }

  function scheduleFirstTasksForThreads(threadIds, threads, max) {
    var roundIdx = 0;
    var settings = getCurrentSettings();
    var maxPending = getViewportPendingLimit(settings, max);
    var autoLoadOffscreen = !!(settings && settings.autoLoadOffscreenFirstRowsEnabled === true);
    // Keep offscreen first rows progressing without letting a long listing
    // admit a full visible batch of large images from the same host, and
    // leave the visible reserve free inside both the ordinary and heavy pools.
    var offscreenLimit = Math.min(max, ATPLoadPolicy.getOffscreenFirstRowOrdinaryLimit(settings || {}));
    var offscreenHeavyLimit = ATPLoadPolicy.getOffscreenFirstRowHeavyLimit(settings || {});
    var offscreenAdmissionLimit = getBackgroundGlobalAdmissionLimit(getTotalImageSlotLimit());
    // 视口待加载计数在单轮排程内做增量维护：getViewportPendingCount 每次调用都会
    // 全量清理 pendingWrappers（每项 3 次 document.contains），不能放在内层循环里反复调
    var viewportPendingCount = ATPLoader.getViewportPendingCount();
    while (threadIds.length > 0) {
      var started = false;
      var checked = 0;
      var hasOrdinaryWaiting = hasNonHighFanoutFirstTask(threadIds, threads);
      while (checked < threadIds.length) {
        var tid = threadIds[roundIdx % threadIds.length];
        var ts = threads[tid];

        if (!isThreadCurrent(ts) || !hasPendingFirstTasks(ts) || ts.firstScreenDone) {
          threadIds.splice(roundIdx % threadIds.length, 1);
          if (threadIds.length === 0) break;
          continue;
        }

        var task = peekFirstTask(ts);
        var useViewportRegistration = shouldRegisterFirstTaskInViewport(ts, task, settings);
        var distance = getThreadViewportDistance(ts);
        task.viewportPriority = !useViewportRegistration && distance === 0;
        task.offscreenAutoLoad = autoLoadOffscreen && distance !== 0;
        if (task.offscreenAutoLoad && HEAVY_SCROLLING) {
          roundIdx++;
          checked++;
          continue;
        }
        if (useViewportRegistration && viewportPendingCount >= maxPending) {
          roundIdx++;
          checked++;
          continue;
        }
        if (!useViewportRegistration && task.offscreenAutoLoad && GLOBAL_ACTIVE >= offscreenAdmissionLimit) {
          roundIdx++;
          checked++;
          continue;
        }
        if (!useViewportRegistration && task.offscreenAutoLoad && GLOBAL_HIGH_FANOUT_ACTIVE >= offscreenHeavyLimit &&
            isHeavyChannelTask(task, settings)) {
          roundIdx++;
          checked++;
          continue;
        }
        if (!useViewportRegistration && shouldDeferTaskForSlots(task, task.offscreenAutoLoad ? offscreenLimit : max, hasOrdinaryWaiting)) {
          if (startFirstTaskPastLargeLane(ts, task, distance, {
            settings: settings, max: max, autoLoadOffscreen: autoLoadOffscreen, offscreenLimit: offscreenLimit,
            offscreenHeavyLimit: offscreenHeavyLimit, offscreenAdmissionLimit: offscreenAdmissionLimit,
            hasOrdinaryWaiting: hasOrdinaryWaiting
          })) started = true;
          roundIdx++;
          checked++;
          continue;
        }
        task.viewportRegistration = useViewportRegistration;
        // 标记该帖首屏是否走过「注册进 IO、等用户滚过来」的路径，
        // 供首屏完成日志区分「久等=没人滚到这」与「久等=被并发/主机限速吞掉」
        if (useViewportRegistration) ts.firstScreenViewportParked = true;
        consumeFirstTask(ts);
        ATPLoader.globalLoadImage(task);
        if (useViewportRegistration) viewportPendingCount++;
        started = true;
        roundIdx++;
        checked++;
      }
      if (!started) break;
    }
  }

  function logScheduleState(reason, extra) {
    logEventThrottled('schedule_state', 'schedule_state', function() {
      var threads = window.ATPState && window.ATPState.threads;
      var activeThreadIds = getActiveFirstThreadIds(threads);
      var firstCounts = getFirstTaskChannelSnapshot(activeThreadIds, threads || {});
      var bgCounts = getTaskChannelSnapshot(BG_TASKS);
      if (!GLOBAL_ACTIVE && !firstCounts.ordinary && !firstCounts.heavy && !bgCounts.ordinary && !bgCounts.heavy) return null;

      var settings = getCurrentSettings();
      var firstLimit = ATPLoader.getConc ? ATPLoader.getConc() : 0;
      var bgLimit = ATPLoader.getBgConc ? ATPLoader.getBgConc() : 0;
      var ordinaryActive = getActiveOrdinaryCount();
      var firstHasOrdinaryWork = firstCounts.ordinary > 0 || ordinaryActive > 0;
      var bgHasOrdinaryWork = bgCounts.ordinary > 0 || ordinaryActive > 0;
      var firstHeavyTask = firstCounts.firstHeavyTask;
      var bgHeavyTask = bgCounts.firstHeavyTask;
      var healthTask = firstHeavyTask || bgHeavyTask;
      var heavyRenderStats = window.ATPViewport && ATPViewport.getHeavyRenderStats ? ATPViewport.getHeavyRenderStats() : null;
      var viewportPendingStats = getViewportPendingStatsFields();
      return Object.assign({
        reason: reason || 'schedule',
        active: GLOBAL_ACTIVE,
        ordinaryActive: ordinaryActive,
        heavyActive: GLOBAL_HIGH_FANOUT_ACTIVE,
        firstLimit: firstLimit,
        bgLimit: bgLimit,
        offscreenOrdinaryLimit: Math.min(firstLimit, ATPLoadPolicy.getOffscreenFirstRowOrdinaryLimit(settings || {})),
        heavyConfiguredLimit: getHeavyImageConcurrency(settings),
        firstOrdinaryQueue: firstCounts.ordinary,
        firstHeavyQueue: firstCounts.heavy,
        bgOrdinaryQueue: bgCounts.ordinary,
        bgHeavyQueue: bgCounts.heavy,
        ordinaryQueue: firstCounts.ordinary + bgCounts.ordinary,
        heavyQueue: firstCounts.heavy + bgCounts.heavy,
        highFanoutFirstLimit: firstHeavyTask
          ? getEffectiveHighFanoutSlotLimit(firstHeavyTask, settings, firstHasOrdinaryWork)
          : getHighFanoutSlotLimit(settings, firstHasOrdinaryWork),
        highFanoutBgLimit: bgHeavyTask
          ? getEffectiveHighFanoutSlotLimit(bgHeavyTask, settings, bgHasOrdinaryWork)
          : getHighFanoutSlotLimit(settings, bgHasOrdinaryWork),
        viewportPending: getViewportPendingCountFromStats(viewportPendingStats),
        heavyScrollDeferred: !!HEAVY_SCROLLING,
        heavyUnloaded: heavyRenderStats ? heavyRenderStats.heavyUnloaded : 0,
        heavyRestoreQueued: window.ATPViewport && ATPViewport.getHeavyRestoreQueueCount ? ATPViewport.getHeavyRestoreQueueCount() : 0,
        heavyVisibleLoaded: heavyRenderStats ? heavyRenderStats.heavyVisibleLoaded : 0,
        heavyVisibleMP: heavyRenderStats ? heavyRenderStats.heavyVisibleMP : 0,
        heavyRangeMP: heavyRenderStats ? heavyRenderStats.heavyRangeMP : 0,
        heavyBudgetMP: heavyRenderStats ? heavyRenderStats.heavyBudgetMP : 0,
        paused: !!GLOBAL_PAUSED
      }, viewportPendingStats, getOrdinaryHostActiveTopFields(), healthTask
        ? getHeavyHostHealthLogFields(healthTask, settings, healthTask === firstHeavyTask ? firstHasOrdinaryWork : bgHasOrdinaryWork)
        : getHeavyHostHealthSummaryFields(settings, firstHasOrdinaryWork || bgHasOrdinaryWork),
      extra || {});
    }, 2000);
  }

  function recordDomainFailure(url, reason, task) {
    if (recordHeavyHostFailure(url, reason, task)) return;
    recordOrdinaryHostFailure(url, reason, task);
  }

  function recordDomainSuccess(url, task) {
    if (recordHeavyHostSuccess(url)) return;
    recordOrdinaryHostSuccess(url);
    noteAttachmentHostSuccess(url);
    if (task) noteLargeLaneOutcome(task, url, getTaskCurrentSrcAgeMs(task), false);
  }

  function recordTaskImageFailure(task, url, reason, finalFailure) {
    if (isHighFanoutImageHost(url)) {
      var host = String(getUrlHost(url) || '').toLowerCase();
      var stampedEpoch = getTaskStampedHostHealthEpoch(task, url);
      var epochKey = host + '@' + (stampedEpoch === null ? getHostHealthEpochForUrl(url) : stampedEpoch);
      if (task && task.lastRecordedHeavyFailureHostEpoch === epochKey) return;
      if (task) task.lastRecordedHeavyFailureHostEpoch = epochKey;
      recordDomainFailure(url, reason, task);
      return;
    }
    if (reason === 'candidate_timeout') noteLargeLaneOutcome(task, url, getTaskCurrentSrcAgeMs(task), true);
    if (finalFailure) {
      var ordinaryHost = String(getUrlHost(url) || '').toLowerCase();
      var ordinaryStampedEpoch = getTaskStampedHostHealthEpoch(task, url);
      var ordinaryEpochKey = ordinaryHost + '@' + (
        ordinaryStampedEpoch === null ? getHostHealthEpochForUrl(url) : ordinaryStampedEpoch
      );
      if (task && task.lastRecordedOrdinaryFailureHostEpoch === ordinaryEpochKey) return;
      if (task) task.lastRecordedOrdinaryFailureHostEpoch = ordinaryEpochKey;
      recordDomainFailure(url, reason, task);
    }
  }

  function getThreadCandidateCount(ts) {
    return ts && ts.candidates ? ts.candidates.length : 0;
  }

  function getThreadSettledCount(ts) {
    return (ts && ts.loaded || 0) + (ts && ts.failedCount || 0);
  }

  function isThreadComplete(ts) {
    var total = getThreadCandidateCount(ts);
    return !!ts && ts.nextIdx >= total && getThreadSettledCount(ts) >= total;
  }

  function getThreadStatusTotal(ts) {
    if (!ts) return 0;
    return ts.bgQueued || ts.bgQueueActive || ts.nextIdx > ts.firstScreenTotal
      ? ts.total
      : ts.firstScreenTotal;
  }

  function isOrdinaryBackgroundNearTail(ts, settings) {
    if (!ts || ts.nextIdx <= ts.firstScreenTotal) return true;
    var viewport = ts.grid && ts.grid.parentNode;
    if (!viewport || typeof viewport.scrollHeight !== 'number') return true;
    if (viewport.style && viewport.style.maxHeight === 'none') return true;
    var thumbHeight = Number(settings && settings.thumbHeight);
    if (!isFinite(thumbHeight) || thumbHeight <= 0) thumbHeight = 82;
    var gridGap = Number(settings && settings.gridGap);
    if (!isFinite(gridGap) || gridGap < 0) gridGap = 6;
    var rowHeight = thumbHeight + gridGap;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= rowHeight;
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

  function getBackgroundRemaining(ts) {
    if (!ts) return 0;
    return Math.max(0, getThreadCandidateCount(ts) - ts.nextIdx);
  }

  function getBackgroundEnqueueCount(ts, settings) {
    var maxPerPost = SharedUtils.effectiveImageLimit(settings);
    var remaining = getBackgroundRemaining(ts);
    var count = Math.max(0, Math.min(remaining, maxPerPost - ts.firstScreenTotal));
    if (isLightweightHeavyThread(ts)) {
      count = Math.min(count, getLightweightHeavyBackgroundBatchSize(ts, settings));
    } else {
      // Keep viewport-lazy work bounded per thread. The old code staged every
      // remaining candidate at once; a long page could leave hundreds of
      // pending tasks that were repeatedly scanned while only 24 wrappers
      // could actually wait for the viewport.
      var backgroundConcurrency = Math.max(1, Number(settings && settings.backgroundConcurrency) || 1);
      var batchLimit = Math.max(4, Math.min(8, backgroundConcurrency * 2));
      count = Math.min(count, batchLimit);
    }
    return count;
  }

  function isLightweightHeavyThread(ts) {
    return !!(ts && ts.heavyMode && ts.lightweightHeavyMode);
  }

  function getFallbackStartIndex(ts) {
    if (!ts) return 0;
    return typeof ts.fallbackIdx === 'number'
      ? ts.fallbackIdx
      : (typeof ts.heavyFallbackIdx === 'number' ? ts.heavyFallbackIdx : getThreadCandidateCount(ts));
  }

  function getHeavyBackgroundDeferredSampleTask(ts, candidateIndex) {
    if (!ts) return null;
    if (hasPendingFirstTasks(ts)) return peekFirstTask(ts);
    var total = getThreadCandidateCount(ts);
    if (!total) return null;
    var idx = candidateIndex === undefined
      ? Math.max(0, Math.min(ts.nextIdx || 0, total - 1))
      : Math.max(0, Math.min(candidateIndex, total - 1));
    return {
      candidates: ts.candidates,
      idx: idx,
      threadId: ts.id,
      generation: ts.generation,
      isFirstScreen: false,
      backgroundBatch: true,
      queueKind: 'heavy_background_deferred_sample'
    };
  }

  function getHeavyBackgroundDeferredInfo(ts) {
    if (!isLightweightHeavyThread(ts)) return false;
    if (!isHeavyImageOptimizationEnabled(getCurrentSettings())) return false;
    if (!ts.firstScreenDone) return false;
    if ((ts.nextIdx || 0) >= getThreadCandidateCount(ts)) return false;
    var settings = getCurrentSettings() || {};
    var maxPerPost = SharedUtils.effectiveImageLimit(settings);
    var scanCount = Math.max(0, Math.min(
      getBackgroundRemaining(ts),
      maxPerPost - ts.firstScreenTotal
    ));
    if (scanCount <= 0) return false;
    var sample = null;
    var healthFields = null;
    var deferredHost = '';
    // 同一主机的健康快照按主机记忆：候选几乎同源，逐候选重建 25 字段快照纯属浪费
    var healthByHost = {};
    for (var offset = 0; offset < scanCount; offset++) {
      var candidateTask = getHeavyBackgroundDeferredSampleTask(ts, (ts.nextIdx || 0) + offset);
      if (!candidateTask || !isHighFanoutPreviewTask(candidateTask)) return false;
      var candidateHost = getUrlHost(getTaskPreviewSrc(candidateTask));
      if (!candidateHost || (deferredHost && candidateHost !== deferredHost)) return false;
      var candidateHealth = healthByHost[candidateHost] ||
        (healthByHost[candidateHost] = getHeavyHostHealthLogFields(candidateTask));
      if (candidateHealth.heavyHostState !== 'open') return false;
      if (!sample) {
        sample = candidateTask;
        healthFields = candidateHealth;
        deferredHost = candidateHost;
      }
    }
    return sample ? { sample: sample, healthFields: healthFields } : false;
  }

  function getLightweightMixedRescueEnqueueCount(ts, settings, baseCount) {
    if (!isLightweightHeavyThread(ts) || baseCount <= 0) return baseCount;
    var maxPerPost = SharedUtils.effectiveImageLimit(settings);
    var scanCount = Math.max(0, Math.min(
      getBackgroundRemaining(ts),
      maxPerPost - ts.firstScreenTotal
    ));
    // 健康状态是主机级的，按主机记忆快照，避免逐候选重建
    var healthByHost = {};
    function candidateHostState(candidateTask) {
      var host = getUrlHost(getTaskPreviewSrc(candidateTask));
      if (!host) return '';
      var health = healthByHost[host] || (healthByHost[host] = getHeavyHostHealthLogFields(candidateTask));
      return health.heavyHostState;
    }
    var firstBlockedCount = Math.min(baseCount, scanCount);
    for (var initialOffset = 0; initialOffset < firstBlockedCount; initialOffset++) {
      var initialTask = getHeavyBackgroundDeferredSampleTask(ts, (ts.nextIdx || 0) + initialOffset);
      if (!initialTask || !isHighFanoutPreviewTask(initialTask)) return baseCount;
      if (candidateHostState(initialTask) !== 'open') return baseCount;
    }
    for (var offset = baseCount; offset < scanCount; offset++) {
      var candidateTask = getHeavyBackgroundDeferredSampleTask(ts, (ts.nextIdx || 0) + offset);
      if (!candidateTask || !isHighFanoutPreviewTask(candidateTask) ||
        candidateHostState(candidateTask) !== 'open') {
        return offset + 1;
      }
    }
    return baseCount;
  }

  function clearDeferredHeavyThreadTimer(threadId) {
    var timer = DEFERRED_HEAVY_THREAD_TIMERS[threadId];
    if (timer) clearTimeout(timer);
    delete DEFERRED_HEAVY_THREAD_TIMERS[threadId];
  }

  function wakeDeferredHeavyThread(threadId, skipSchedule) {
    clearDeferredHeavyThreadTimer(threadId);
    if (GLOBAL_PAUSED) return false;
    var threads = window.ATPState && window.ATPState.threads;
    var ts = threads && threads[threadId];
    if (!isThreadCurrent(ts)) {
      delete DEFERRED_HEAVY_THREADS[threadId];
      return false;
    }
    var deferInfo = getHeavyBackgroundDeferredInfo(ts);
    if (deferInfo) {
      scheduleDeferredHeavyThreadWake(threadId, deferInfo.healthFields.heavyHostCooldownRemainingMs);
      return false;
    }
    delete DEFERRED_HEAVY_THREADS[threadId];
    ts.bgHostDeferred = false;
    ts.bgHostDeferredUntil = 0;
    ATPLoader.enqueueBgForThread(threadId);
    if (!skipSchedule) ATPLoader.globalSchedule();
    return true;
  }

  function scheduleDeferredHeavyThreadWake(threadId, delayMs) {
    if (!threadId || GLOBAL_PAUSED) return;
    clearDeferredHeavyThreadTimer(threadId);
    var delay = Math.max(50, Number(delayMs) || 0);
    DEFERRED_HEAVY_THREAD_TIMERS[threadId] = setTimeout(function() {
      wakeDeferredHeavyThread(threadId);
    }, delay + 10);
  }

  function resumeDeferredHeavyThreads() {
    // 逐帖唤醒但只在最后统一跑一次全局排程，避免 K 个延迟帖恢复时跑 K 轮完整调度
    var woke = false;
    for (var threadId in DEFERRED_HEAVY_THREADS) {
      if (!Object.prototype.hasOwnProperty.call(DEFERRED_HEAVY_THREADS, threadId)) continue;
      if (wakeDeferredHeavyThread(threadId, true)) woke = true;
    }
    if (woke) ATPLoader.globalSchedule();
  }

  function clearDeferredHeavyThreadWakeTimers() {
    for (var threadId in DEFERRED_HEAVY_THREAD_TIMERS) {
      if (!Object.prototype.hasOwnProperty.call(DEFERRED_HEAVY_THREAD_TIMERS, threadId)) continue;
      clearTimeout(DEFERRED_HEAVY_THREAD_TIMERS[threadId]);
    }
    DEFERRED_HEAVY_THREAD_TIMERS = {};
  }

  function clearDeferredHeavyThreads() {
    var threads = window.ATPState && window.ATPState.threads;
    for (var threadId in DEFERRED_HEAVY_THREADS) {
      if (!Object.prototype.hasOwnProperty.call(DEFERRED_HEAVY_THREADS, threadId)) continue;
      var ts = threads && threads[threadId];
      if (ts) {
        ts.bgHostDeferred = false;
        ts.bgHostDeferredUntil = 0;
      }
    }
    clearDeferredHeavyThreadWakeTimers();
    DEFERRED_HEAVY_THREADS = {};
  }

  function getLightweightHeavyBackgroundBatchSize(ts, settings) {
    settings = settings || getCurrentSettings() || {};
    var cols = parseInt(settings.gridCols, 10);
    if (isNaN(cols)) cols = 5;
    return Math.max(1, Math.min(cols, getHeavyImageConcurrency(settings) || cols));
  }

  function applyHeavyBackgroundDeferred(ts, threadId, deferInfo) {
    if (!ts || !threadId) return false;
    deferInfo = deferInfo || getHeavyBackgroundDeferredInfo(ts);
    if (!deferInfo) return false;
    var total = getThreadCandidateCount(ts);
    var healthFields = deferInfo.healthFields || {};
    ts.bgHostDeferred = true;
    ts.bgHostDeferredUntil = Date.now() + Math.max(0, healthFields.heavyHostCooldownRemainingMs || 0);
    ts.bgQueued = false;
    ts.bgQueueActive = false;
    ts.bgBatchPending = 0;
    DEFERRED_HEAVY_THREADS[threadId] = true;
    scheduleDeferredHeavyThreadWake(threadId, healthFields.heavyHostCooldownRemainingMs);

    var fields = Object.assign({
      reason: 'heavy_bg_deferred',
      threadId: threadId,
      channel: 'heavy',
      heavyHostDeferred: true,
      loaded: ts.loaded || 0,
      failedCount: ts.failedCount || 0,
      firstScreenOk: ts.firstScreenOk || 0,
      firstScreenFailed: ts.firstScreenFailed || 0,
      firstScreenTotal: ts.firstScreenTotal || 0,
      nextIdx: ts.nextIdx || 0,
      candidateTotal: total,
      bgQueueLength: BG_TASKS.length
    }, healthFields, getQueueSnapshotFields());
    recordDiagnosticEvent('schedule_state', fields);
    if (typeof Logger !== 'undefined' && Logger.event) {
      Logger.event('schedule_state', fields, 'WARN');
    }
    return true;
  }

  function getCandidateFallbackLimit(ts, task) {
    if (ts && ts.heavyMode) {
      return ATPLoadPolicy.getHeavyFallbackLimit(getCurrentSettings() || {});
    }
    return ATPLoadPolicy.getOrdinaryFallbackLimit(getCurrentSettings() || {});
  }

  function getBackgroundDelay(settings) {
    return ATPLoadPolicy.getBackgroundDelay(settings || getCurrentSettings() || {});
  }

  function getBackgroundIdleTimeout(delay) {
    // 节奏已由前置的 setTimeout(delay) 保证；rIC 超时只需兜底主线程繁忙，
    // 用常量 100ms，避免忙时批次尾延变成 2×配置间隔
    return 100;
  }

  function getViewportPendingLimit(settings) {
    settings = settings || getCurrentSettings() || {};
    return ATPLoadPolicy.getViewportPendingLimit(settings, Math.max(1, Number(settings.backgroundConcurrency) || 1));
  }

  function getAvailableSlotsForLimits(ordinaryLimit, hasNonHighFanoutWaiting, bgSnapshot) {
    var settings = getCurrentSettings();
    var totalAvailable = Math.max(0, getTotalImageSlotLimit() - GLOBAL_ACTIVE);
    var activeOrdinary = getActiveOrdinaryCount();
    var ordinaryAvailable = Math.max(0, Math.max(1, Number(ordinaryLimit) || 1) - activeOrdinary);
    var heavyTask = bgSnapshot ? bgSnapshot.firstHeavyTask : findFirstHeavyTask(BG_TASKS);
    var heavyHasOrdinaryWork = !!hasNonHighFanoutWaiting || activeOrdinary > 0;
    var heavyLimit = heavyTask
      ? getEffectiveHighFanoutSlotLimit(heavyTask, settings, heavyHasOrdinaryWork)
      : getHighFanoutSlotLimit(settings, heavyHasOrdinaryWork);
    var heavyAvailable = Math.max(0, heavyLimit - GLOBAL_HIGH_FANOUT_ACTIVE);
    return Math.min(totalAvailable, ordinaryAvailable + heavyAvailable);
  }

  function hasBackgroundCapacity(bgSnapshot) {
    var totalLimit = getTotalImageSlotLimit();
    if (GLOBAL_ACTIVE >= getBackgroundGlobalAdmissionLimit(totalLimit)) return false;
    var counts = bgSnapshot || getTaskChannelSnapshot(BG_TASKS);
    var activeOrdinary = getActiveOrdinaryCount();
    var ordinaryAvailable = counts.ordinary > 0 && activeOrdinary < ATPLoader.getBgConc();
    var settings = getCurrentSettings();
    var heavyTask = counts.firstHeavyTask || null;
    var hasOrdinaryWork = counts.ordinary > 0 || activeOrdinary > 0;
    var heavyLimit = heavyTask
      ? getEffectiveHighFanoutSlotLimit(heavyTask, settings, hasOrdinaryWork)
      : getHighFanoutSlotLimit(settings, hasOrdinaryWork);
    var heavyAvailable = counts.heavy > 0 && !HEAVY_SCROLLING && GLOBAL_HIGH_FANOUT_ACTIVE < heavyLimit;
    return ordinaryAvailable || heavyAvailable;
  }

  function hasBackgroundDispatchCapacity(bgSnapshot) {
    var settings = getCurrentSettings();
    var maxBg = ATPLoader.getBgConc();
    if (window.ATPViewport && !shouldBypassViewportLazyLoad(settings)) {
      var maxPending = getViewportPendingLimit(settings, maxBg);
      if (ATPLoader.getViewportPendingCount() < maxPending) return true;
    }
    return hasBackgroundCapacity(bgSnapshot);
  }

  function getAvailableBackgroundSlots(bgSnapshot) {
    var snapshot = bgSnapshot || getTaskChannelSnapshot(BG_TASKS);
    var totalLimit = getTotalImageSlotLimit();
    var nonPriorityAvailable = Math.max(0, getBackgroundGlobalAdmissionLimit(totalLimit) - GLOBAL_ACTIVE);
    return Math.min(
      nonPriorityAvailable,
      getAvailableSlotsForLimits(ATPLoader.getBgConc(), snapshot.ordinary > 0, snapshot)
    );
  }

  function shouldBypassViewportLazyLoad(settings) {
    return !!(settings && settings.pauseWhenHidden === false && document.visibilityState !== 'visible');
  }

  function shouldUseViewportLazyLoad(task, settings, wrapper) {
    // 把本轮的精判结果记在任务上供直载路径复用：否则同一 tick 内会对同一 wrapper
    // 做两次祖先链测量（都紧跟样式写入，每次都是强制回流）
    if (task) task.lazyProbeVisible = undefined;
    if (!window.ATPViewport || !task) return false;
    if (isBackgroundImageLocked(task)) return true;
    if (shouldBypassViewportLazyLoad(settings)) return false;
    if (task.isFirstScreen && settings && settings.autoLoadOffscreenFirstRowsEnabled === true) return false;
    if (task.manualRetry || task.forceEager || task.forcePreload) return false;
    if (task.viewportRegistration === true) return true;
    if (wrapper && isWrapperInViewport(wrapper)) {
      task.lazyProbeVisible = true;
      return false;
    }
    task.lazyProbeVisible = false;
    return true;
  }

  function isBackgroundImageLocked(task) {
    if (!task || task.isFirstScreen || task.manualRetry) return false;
    var ts = getThreadState(task.threadId);
    return !!(ts && ts.backgroundUnlocked === false && task.idx >= ts.firstScreenTotal);
  }

  function drainHiddenViewportPending(settings, bgSnapshot) {
    if (!shouldBypassViewportLazyLoad(settings)) return;
    var available = getAvailableBackgroundSlots(bgSnapshot);
    if (available <= 0) return;
    if (window.ATPViewport && ATPViewport.loadPendingWhenHidden) {
      ATPViewport.loadPendingWhenHidden(available);
    }
  }

  function retryViewportPendingSlotLoads() {
    if (window.ATPViewport && ATPViewport.retryPendingSlotLoads) {
      ATPViewport.retryPendingSlotLoads();
    }
  }

  function retryViewportVisiblePendingLoads() {
    if (window.ATPViewport && ATPViewport.retryVisiblePending) {
      ATPViewport.retryVisiblePending();
    }
  }

  function clearViewportSlotWakeTimer() {
    if (GLOBAL_VIEWPORT_SLOT_WAKE_TIMER) {
      clearTimeout(GLOBAL_VIEWPORT_SLOT_WAKE_TIMER);
      GLOBAL_VIEWPORT_SLOT_WAKE_TIMER = null;
    }
  }

  function scheduleViewportPendingSlotWake() {
    if (GLOBAL_VIEWPORT_SLOT_WAKE_TIMER || GLOBAL_PAUSED) return;
    GLOBAL_VIEWPORT_SLOT_WAKE_TIMER = setTimeout(function() {
      GLOBAL_VIEWPORT_SLOT_WAKE_TIMER = null;
      if (GLOBAL_PAUSED) return;
      retryViewportVisiblePendingLoads();
      retryViewportPendingSlotLoads();
      ATPLoader.globalSchedule();
    }, 0);
  }

  function clearBackgroundRetryTimer() {
    if (GLOBAL_BG_RETRY_TIMER) {
      clearTimeout(GLOBAL_BG_RETRY_TIMER);
      GLOBAL_BG_RETRY_TIMER = null;
    }
    GLOBAL_BG_RETRY_DELAY_MS = 0;
  }

  function getNextBackgroundRetryDelay() {
    GLOBAL_BG_RETRY_DELAY_MS = GLOBAL_BG_RETRY_DELAY_MS
      ? Math.min(BG_PENDING_FULL_RETRY_MAX_MS, GLOBAL_BG_RETRY_DELAY_MS * 2)
      : BG_PENDING_FULL_RETRY_MIN_MS;
    return GLOBAL_BG_RETRY_DELAY_MS;
  }

  function scheduleBackgroundPendingRetry(maxPending, pendingCount) {
    if (GLOBAL_BG_RETRY_TIMER || BG_TASKS.length <= 0 || GLOBAL_PAUSED) return;
    var retryDelay = getNextBackgroundRetryDelay();
    logScheduleState('viewport_pending_full', {
      maxPending: maxPending,
      pendingCount: pendingCount,
      retryDelayMs: retryDelay
    });
    GLOBAL_BG_RETRY_TIMER = setTimeout(function() {
      GLOBAL_BG_RETRY_TIMER = null;
      if (!BG_TASKS.length || GLOBAL_PAUSED) {
        GLOBAL_BG_RETRY_DELAY_MS = 0;
        return;
      }
      ATPLoader.scheduleBgQueue();
    }, retryDelay);
  }

  function scheduleBackgroundCapacityRetry(bgSnapshot, reason) {
    if (GLOBAL_BG_RETRY_TIMER || BG_TASKS.length <= 0 || GLOBAL_PAUSED) return;
    var retryDelay = getNextBackgroundRetryDelay();
    // 队列快照字段构建不便宜（含两次限速快照），日志关闭时不做
    logScheduleState(reason || 'background_capacity_wait', isDiagnosticLoggingEnabled('DEBUG')
      ? Object.assign({ retryDelayMs: retryDelay }, getQueueSnapshotFields(bgSnapshot))
      : { retryDelayMs: retryDelay });
    GLOBAL_BG_RETRY_TIMER = setTimeout(function() {
      GLOBAL_BG_RETRY_TIMER = null;
      if (!BG_TASKS.length || GLOBAL_PAUSED) {
        GLOBAL_BG_RETRY_DELAY_MS = 0;
        return;
      }
      ATPLoader.scheduleBgQueue();
    }, retryDelay);
  }

  function clearBackgroundTimers() {
    if (GLOBAL_BG_TIMER) {
      if (GLOBAL_BG_TIMER_KIND === 'idle' && typeof cancelIdleCallback !== 'undefined') {
        cancelIdleCallback(GLOBAL_BG_TIMER);
      } else {
        clearTimeout(GLOBAL_BG_TIMER);
      }
      GLOBAL_BG_TIMER = null;
      GLOBAL_BG_TIMER_KIND = '';
    }
    clearBackgroundRetryTimer();
  }

  function reconfigureLoader(settings) {
    settings = settings || getCurrentSettings() || {};
    clearBackgroundTimers();
    clearHeavyHostWakeTimers();
    clearDeferredHeavyThreadWakeTimers();

    var heavyStats = HEAVY_HOST_HEALTH.stats || {};
    for (var host in heavyStats) {
      if (!Object.prototype.hasOwnProperty.call(heavyStats, host)) continue;
      var stats = heavyStats[host];
      refreshHeavyHostState(host, stats, settings);
      if (stats.state === 'open') {
        scheduleHeavyHostWake(host, getHeavyHostCooldownRemaining(stats));
      }
    }

    if (!ATPLoadPolicy.isOrdinaryHostAdaptive(settings)) {
      var ordinaryStats = ORDINARY_HOST_HEALTH.stats || {};
      for (var ordinaryHost in ordinaryStats) {
        if (!Object.prototype.hasOwnProperty.call(ordinaryStats, ordinaryHost)) continue;
        ordinaryStats[ordinaryHost].cooldownUntil = 0;
      }
    }

    if (!GLOBAL_PAUSED) {
      resumeDeferredHeavyThreads();
      retryViewportVisiblePendingLoads();
      retryViewportPendingSlotLoads();
      if (window.ATPViewport && ATPViewport.reconfigure) {
        ATPViewport.reconfigure('loader_reconfigure');
      }
      ATPLoader.globalSchedule();
    }
    return ATPLoadPolicy.getPublicSnapshot(settings);
  }

  function syncVisibilityPauseState(settings, shouldSchedule) {
    settings = settings || (window.ATPState && window.ATPState.settings);
    if (window.ATPViewport && ATPViewport.syncLoadingAnimationVisibility) {
      ATPViewport.syncLoadingAnimationVisibility();
    }
    if (settings && settings.pauseWhenHidden === false) {
      GLOBAL_PAUSED = false;
      resumeDeferredHeavyThreads();
      if (window.ATPViewport) {
        if (document.visibilityState === 'visible' && ATPViewport.clearHiddenLoadFlags) {
          ATPViewport.clearHiddenLoadFlags();
          retryViewportVisiblePendingLoads();
          retryViewportPendingSlotLoads();
        } else {
          drainHiddenViewportPending(settings);
        }
        if (ATPViewport.resumeHeavyRestores) {
          ATPViewport.resumeHeavyRestores('hidden_loading_allowed');
        }
      }
      if (shouldSchedule) ATPLoader.globalSchedule();
      return;
    }
    if (document.visibilityState === 'visible') {
      GLOBAL_PAUSED = false;
      resumeDeferredHeavyThreads();
      retryViewportVisiblePendingLoads();
      retryViewportPendingSlotLoads();
      if (window.ATPViewport && ATPViewport.resumeHeavyRestores) {
        ATPViewport.resumeHeavyRestores('visibility_resume');
      }
      if (shouldSchedule) ATPLoader.globalSchedule();
    } else {
      GLOBAL_PAUSED = true;
      cancelActiveImageLoads(HIDDEN_PAUSE_CANCEL_REASON);
      if (window.ATPViewport && ATPViewport.clearHiddenLoadFlags) {
        ATPViewport.clearHiddenLoadFlags();
      }
      clearScrollIdleTimer();
      clearViewportSlotWakeTimer();
      clearHeavyHostWakeTimers();
      clearDeferredHeavyThreadWakeTimers();
      clearBackgroundTimers();
      if (window.ATPViewport && ATPViewport.clearPendingRetryTimers) {
        ATPViewport.clearPendingRetryTimers();
      }
      if (window.ATPViewport && ATPViewport.pauseHeavyRestores) {
        ATPViewport.pauseHeavyRestores();
      }
    }
  }

  function formatThreadStatusText(ts, done) {
    if (ts.heavyMode) {
      var text = (done ? '重图优化 完成 ' : '重图优化 ') + ts.loaded + '/' + ts.total + '（原' + ts.heavyOriginalTotal + '）';
      if (ts.failedCount > 0) text += ' 失败' + ts.failedCount;
      return text;
    }
    if (done) {
      var completeText = '完成 ' + ts.loaded + '/' + ts.total;
      if (ts.failedCount > 0) completeText += ' (失败' + ts.failedCount + ')';
      return completeText;
    }
    return '加载中 ' + ts.loaded + '/' + Math.min(getThreadCandidateCount(ts), getThreadStatusTotal(ts));
  }

  function getThreadState(threadId) {
    var threads = window.ATPState && window.ATPState.threads;
    return threads && threads[threadId];
  }

  function isThreadCurrent(ts) {
    if (!ts) return false;
    var currentGeneration = window.ATPState && typeof window.ATPState.generation === 'number'
      ? window.ATPState.generation
      : ts.generation;
    if (typeof ts.generation === 'number' && typeof currentGeneration === 'number' && ts.generation !== currentGeneration) return false;
    if (ts.panel && !document.contains(ts.panel)) return false;
    if (ts.container && !document.contains(ts.container)) return false;
    return true;
  }

  function isTaskCurrent(task) {
    if (!task || !task.threadId) return false;
    var ts = getThreadState(task.threadId);
    if (!isThreadCurrent(ts)) return false;
    if (typeof task.generation === 'number' && typeof ts.generation === 'number' && task.generation !== ts.generation) return false;
    return true;
  }

  function removeWrapper(wrapper) {
    if (window.ATPViewport && ATPViewport.unobserveLoadingAnimation) {
      ATPViewport.unobserveLoadingAnimation(wrapper);
    }
    if (wrapper && wrapper.parentNode) wrapper.remove();
  }

  function observeLoadingAnimation(wrapper) {
    if (window.ATPViewport && ATPViewport.observeLoadingAnimation) {
      ATPViewport.observeLoadingAnimation(wrapper);
    } else if (wrapper && wrapper.classList) {
      wrapper.classList.add('atp-loading-near-viewport');
    }
  }

  function unobserveLoadingAnimation(wrapper) {
    if (window.ATPViewport && ATPViewport.unobserveLoadingAnimation) {
      ATPViewport.unobserveLoadingAnimation(wrapper);
    } else if (wrapper && wrapper.classList) {
      wrapper.classList.remove('atp-loading-near-viewport');
    }
  }

  // Animated GIF thumbnails show a still first frame; hovering plays the GIF
  // (CSS on .atp-gif-frozen). Every playing GIF re-decodes full-size frames
  // and re-rasters its tile on each frame, and a list page on the user's
  // host can show dozens at once: in the GIF bench, 30 playing GIFs cost
  // about half a core while scrolling, in decode threads and the GPU. The
  // frame is decoded asynchronously (img.decode) and drawn once into a canvas
  // at the tile's pixel size; the animated <img> stays for hover and preview.
  // Draws run in idle time, a few per callback, so a burst of GIFs finishing
  // during a scroll does not add main-thread work to scroll frames.
  var STILL_FRAME_QUEUE = [];
  var STILL_FRAME_TIMER = null;

  function flushStillFrameQueue(deadline) {
    var drawn = 0;
    while (STILL_FRAME_QUEUE.length) {
      if (drawn > 0 && (!deadline || typeof deadline.timeRemaining !== 'function' || deadline.timeRemaining() < 4)) break;
      var draw = STILL_FRAME_QUEUE.shift();
      draw();
      drawn++;
    }
    if (STILL_FRAME_QUEUE.length) scheduleStillFrameQueue();
  }

  function scheduleStillFrameQueue() {
    if (STILL_FRAME_TIMER !== null) return;
    if (typeof requestIdleCallback === 'function') {
      STILL_FRAME_TIMER = requestIdleCallback(function(deadline) {
        STILL_FRAME_TIMER = null;
        flushStillFrameQueue(deadline);
      }, { timeout: 500 });
    } else {
      STILL_FRAME_TIMER = setTimeout(function() {
        STILL_FRAME_TIMER = null;
        flushStillFrameQueue(null);
      }, 16);
    }
  }

  function queueStillFrame(draw) {
    STILL_FRAME_QUEUE.push(draw);
    scheduleStillFrameQueue();
  }

  function freezeAnimatedThumbnail(wrapper, img, task) {
    var settings = getCurrentSettings() || {};
    if (settings.animatedThumbnailMode === 'play') return false;
    if (!wrapper || !img || !task || !isLargeLaneTask(task)) return false;
    if (wrapper.classList && wrapper.classList.contains('atp-gif-frozen')) return false;
    var src = img.currentSrc || img.src;
    var draw = function() {
      if (!img.naturalWidth || !img.naturalHeight || (img.currentSrc || img.src) !== src) return;
      if (img.parentNode !== wrapper || (document.contains && !document.contains(wrapper))) return;
      var tileWidth = Math.max(1, Number(settings.thumbWidth) || 110);
      var tileHeight = Math.max(1, Number(settings.thumbHeight) || 82);
      var pixelRatio = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
      // object-fit: contain, like the <img>: the frame's aspect ratio inside the tile.
      var scale = Math.min(tileWidth / img.naturalWidth, tileHeight / img.naturalHeight, 1) * pixelRatio;
      var canvasWidth = Math.max(1, Math.round(img.naturalWidth * scale));
      var canvasHeight = Math.max(1, Math.round(img.naturalHeight * scale));
      var canvas = document.createElement('canvas');
      canvas.className = 'atp-gif-still';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      // willReadFrequently keeps the canvas CPU-backed and painted with the
      // page; an accelerated canvas (large tiles at high DPI) would be a
      // compositing layer per tile, the cost the shimmer removal took away.
      var ctx = canvas.getContext && canvas.getContext('2d', { alpha: true, willReadFrequently: true });
      if (!ctx) return;
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
      } catch (e) {
        return;
      }
      var old = wrapper.querySelector ? wrapper.querySelector('.atp-gif-still') : null;
      if (old && old.parentNode) old.parentNode.removeChild(old);
      wrapper.appendChild(canvas);
      wrapper.classList.add('atp-gif-frozen');
    };
    if (typeof img.decode === 'function') {
      img.decode().then(function() { queueStillFrame(draw); }, function() {});
    } else {
      queueStillFrame(draw);
    }
    return true;
  }

  function clearHeavyWrapperVisualState(wrapper) {
    if (!wrapper) return;
    wrapper.classList.remove('atp-heavy-preview-active');
    wrapper.classList.remove('atp-heavy-preview-pending');
    wrapper.classList.remove('atp-heavy-unloaded');
  }

  function isPriorityImageTask(task) {
    return !!(task && (
      task.manualRetry ||
      task.currentlyVisible === true ||
      (task.currentlyVisible === undefined && task.viewportPriority)
    ));
  }

  function isCurrentlyVisibleImageTask(task) {
    if (!task) return false;
    if (task.manualRetry) return true;
    if (task.currentlyVisible !== undefined) return task.currentlyVisible === true;
    return task.viewportPriority === true;
  }

  function updateTaskViewportPriority(task, wrapper, visible) {
    if (!task) return false;
    visible = visible === true;
    task.currentlyVisible = visible;
    task.viewportPriority = visible;
    var img = wrapper && wrapper.querySelector ? wrapper.querySelector('.atp-thumbnail-img') : null;
    if (img) {
      img.loading = shouldLoadImageEagerly(task) ? 'eager' : 'lazy';
      img.fetchPriority = visible || task.manualRetry ? 'high' : 'low';
    }
    return visible;
  }

  function shouldUseHighFetchPriority(task) {
    return isPriorityImageTask(task) || !!(task && task.forceEager && !task.forceEagerLowPriority);
  }

  function shouldLoadImageEagerly(task) {
    // JS admission owns concurrency and starts the timeout clock. Once a slot
    // is held, native lazy loading must not defer the actual network request.
    // Eager starts the request; fetchPriority still keeps offscreen work low.
    return shouldUseHighFetchPriority(task) || !!(task && (task.slotActive || task.forceEager || task.forcePreload));
  }

  function prepareThumbnailImage(img, task, w, h) {
    img.className = 'atp-thumbnail-img';
    img.decoding = 'async';
    img.loading = shouldLoadImageEagerly(task) ? 'eager' : 'lazy';
    img.fetchPriority = shouldUseHighFetchPriority(task) ? 'high' : 'low';
    img.alt = '';
    img.style.width = w + 'px';
    img.style.height = h + 'px';
  }

  function clearPreviewActivation(wrapper) {
    if (!wrapper) return;
    wrapper.removeAttribute('tabindex');
    wrapper.removeAttribute('role');
    wrapper.removeAttribute('aria-label');
    wrapper.removeAttribute('data-atp-thread-id');
    wrapper.removeAttribute('data-atp-preview-index');
    wrapper.onkeydown = null;
  }

  function bindPreviewActivation(wrapper, openPreview, task) {
    if (!wrapper || typeof openPreview !== 'function') return;
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'button');
    wrapper.setAttribute('aria-label', getPreviewActivationLabel(task));
    wrapper.setAttribute('data-atp-thread-id', task && task.threadId ? task.threadId : '');
    wrapper.setAttribute('data-atp-preview-index', String(task ? getTaskPreviewIndex(task) : 0));
    wrapper.onkeydown = function(evt) {
      var key = evt && evt.key;
      if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
      if (evt.preventDefault) evt.preventDefault();
      if (evt.stopPropagation) evt.stopPropagation();
      openPreview();
    };
  }

  function setImageSource(img, src, noReferrer, shouldApply) {
    function canApply() {
      return !shouldApply || shouldApply();
    }
    noReferrer = !!noReferrer || shouldUseNoReferrerByDefault(src);
    if (noReferrer) {
      img.referrerPolicy = 'no-referrer';
      img.removeAttribute('src');
      setTimeout(function() {
        if (canApply()) img.src = src;
      }, 0);
      return;
    } else {
      img.removeAttribute('referrerpolicy');
    }
    if (canApply()) img.src = src;
  }

  // The forum serves one attachment store under several rotating hosts
  // (tu.<name>/tupian/forum/YYYYMM/DD/<HHMMSS + 16 chars>.<ext>): it picks a
  // host each time it renders a thread, and the same path is on the others.
  // A host that is down fails every image at once (in the user's logs one
  // host never loaded an image while another served the same paths), so an
  // attachment that failed with and without a Referer is tried once on a
  // sibling host that has already served this page. Once a host has failed
  // like that three times without a single success, new images for it start
  // on the sibling directly.
  var ATTACHMENT_PATH_RE = /^((?:\/[^\/?#]+)*\/)forum\/\d{6}\/\d{2}\/\d{6}[a-z0-9]{16}\.(?:jpe?g|png|gif|webp|bmp)(?:\.thumb\.jpg)?$/i;
  var ATTACHMENT_SIBLING_MAX_AGE_MS = 10 * 60 * 1000;
  var ATTACHMENT_HOSTS = {};

  function getAttachmentFamily(url) {
    if (!url || isHighFanoutImageHost(url)) return null;
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== 'https:') return null;
    var match = ATTACHMENT_PATH_RE.exec(parsed.pathname);
    if (!match) return null;
    var host = parsed.hostname.toLowerCase();
    return { key: host.split('.')[0] + '|' + match[1], host: host };
  }

  function getAttachmentHostStats(family, create) {
    var hosts = ATTACHMENT_HOSTS[family.key];
    if (!hosts) {
      if (!create) return null;
      hosts = ATTACHMENT_HOSTS[family.key] = {};
    }
    if (!hosts[family.host] && create) hosts[family.host] = { ok: 0, fail: 0, lastOkAt: 0 };
    return hosts[family.host] || null;
  }

  function noteAttachmentHostSuccess(url) {
    var family = getAttachmentFamily(url);
    if (!family) return;
    var stats = getAttachmentHostStats(family, true);
    stats.ok++;
    stats.lastOkAt = Date.now();
  }

  // A family host that served at least two images recently and is not cooling.
  function pickSiblingAttachmentHost(family) {
    var hosts = ATTACHMENT_HOSTS[family.key];
    if (!hosts) return '';
    var now = Date.now();
    var best = '';
    var bestAt = 0;
    for (var host in hosts) {
      if (!Object.prototype.hasOwnProperty.call(hosts, host) || host === family.host) continue;
      var stats = hosts[host];
      if (stats.ok < 2 || now - stats.lastOkAt > ATTACHMENT_SIBLING_MAX_AGE_MS || stats.lastOkAt <= bestAt) continue;
      var health = getOrdinaryHostStats(host, false);
      if (health && health.cooldownUntil && health.cooldownUntil > now) continue;
      best = host;
      bestAt = stats.lastOkAt;
    }
    return best;
  }

  function isDeadAttachmentHost(family) {
    var stats = getAttachmentHostStats(family, false);
    return !!(stats && stats.ok === 0 && stats.fail >= 3);
  }

  function withAttachmentHost(candidate, fromHost, toHost) {
    var out = Object.assign({}, candidate);
    ['src', 'displaySrc', 'previewSrc'].forEach(function(field) {
      if (!out[field]) return;
      try {
        var parsed = new URL(out[field]);
        if (parsed.hostname.toLowerCase() !== fromHost) return;
        parsed.hostname = toHost;
        out[field] = parsed.href;
      } catch (e) {}
    });
    out.siblingHostFrom = fromHost;
    return out;
  }

  // Points the task's candidate at a sibling host (a copy: the cached
  // candidate list keeps the forum's own URLs). Returns the sibling host or ''.
  function moveTaskToSiblingHost(task, family) {
    var imgData = getTaskImageData(task);
    if (!imgData || !family) return '';
    var sibling = pickSiblingAttachmentHost(family);
    if (!sibling) return '';
    var ts = getThreadState(task.threadId);
    if (ts) {
      // The forum's own URL leaves the rendered list here: keep the ordinary
      // fallback from picking the same picture again for another slot.
      markThreadFallbackCandidateUsed(ts, imgData, getTaskPreviewIndex(task));
      // The list the cache is written from keeps the forum's URLs.
      if (ts.cacheImages && ts.cacheImages === task.candidates) ts.cacheImages = ts.cacheImages.slice();
    }
    task.candidates[task.idx] = withAttachmentHost(imgData, family.host, sibling);
    if (ts) ts.__activeCandidateKeys = null;
    task.siblingHostTried = true;
    return sibling;
  }

  // Before a task's first request: a host known to be down is skipped.
  function startOnLiveAttachmentHost(task) {
    if (!task || task.siblingHostTried) return;
    var family = getAttachmentFamily(getTaskImageSrc(task));
    if (!family || !isDeadAttachmentHost(family)) return;
    var sibling = moveTaskToSiblingHost(task, family);
    if (sibling) {
      logImageEvent('image_retry', task, { reason: 'sibling_host_start', fromHost: family.host, toHost: sibling }, 'INFO');
    }
  }

  function trySiblingHostFallback(task, img, restartTimer, shouldApply) {
    if (!task || task.siblingHostTried || !isTaskCurrent(task) || !task.currentSrcNoReferrerTried) return false;
    if (isHeavyChannelTask(task, getCurrentSettings()) || isImageTaskDeadlineSpent(task)) return false;
    var family = getAttachmentFamily(getTaskImageSrc(task));
    if (!family) return false;
    getAttachmentHostStats(family, true).fail++;
    var sibling = moveTaskToSiblingHost(task, family);
    if (!sibling) return false;
    var newSrc = getTaskImageSrc(task);
    markTaskCurrentSourceStart(task, newSrc, false);
    // One request on the sibling, which already served this page with a Referer.
    task.currentSrcNoReferrerTried = true;
    task.noReferrerFallbackTried = true;
    task.noReferrerFallbackSrcKey = getImageUrlKey(newSrc);
    if (restartTimer) restartTimer();
    logImageEvent('image_retry', task, { reason: 'sibling_host', fromHost: family.host, toHost: sibling, retryUrl: shortUrl(newSrc) }, 'INFO');
    setImageSource(img, newSrc, false, shouldApply);
    return true;
  }

  function tryNoReferrerFallback(task, img, src, restartTimer, shouldApply) {
    // A task whose thread was re-rendered is thrown away on completion; a
    // second request for it only holds a slot.
    if (!task || !isTaskCurrent(task)) return false;
    var srcKey = getImageUrlKey(src);
    if (task.currentSrcKey !== srcKey) markTaskCurrentSourceStart(task, src, false);
    if (task.currentSrcNoReferrerTried || (task.noReferrerFallbackTried && task.noReferrerFallbackSrcKey === srcKey)) return false;
    if (img && img.referrerPolicy === 'no-referrer') {
      task.currentSrcNoReferrerTried = true;
      task.noReferrerFallbackTried = true;
      task.noReferrerFallbackSrcKey = srcKey;
      return false;
    }
    var retryTimeout = getNoReferrerFallbackRetryTimeout(task);
    if (retryTimeout <= 0) {
      task.currentSrcNoReferrerTried = true;
      task.noReferrerFallbackTried = true;
      task.noReferrerFallbackSrcKey = srcKey;
      logImageEvent('image_retry', task, {
        reason: 'no_referrer_deadline',
        deadlineReason: 'invalid_retry_timeout',
        retryUrl: shortUrl(src)
      });
      return false;
    }
    var currentSrcAgeMs = getTaskCurrentSrcAgeMs(task);
    task.currentSrcNoReferrerTried = true;
    task.noReferrerFallbackTried = true;
    task.noReferrerFallbackSrcKey = srcKey;
    if (restartTimer) restartTimer(retryTimeout);
    logDebugThrottled('noReferrerFallback', '图片无Referer重试', src, 3000);
    logImageEvent('image_retry', task, {
      reason: 'no_referrer',
      retryUrl: shortUrl(src),
      retryTimeoutMs: retryTimeout,
      currentSrcAgeMs: currentSrcAgeMs,
      hostActive: getOrdinaryHostActiveCount(getUrlHost(src))
    });
    markTaskCurrentSourceStart(task, src, true);
    setImageSource(img, src, true, shouldApply);
    return true;
  }

  // 已渲染候选的归一化 URL 集合，懒构建并在候选被替换时整体失效重建：
  // 回退/深救援按索引逐个探测时从 O(候选数) 降为 O(1)，语义与逐项扫描完全一致
  function getActiveCandidateKeySet(ts) {
    var list = ts.candidates || [];
    if (!ts.__activeCandidateKeys || ts.__activeCandidateKeysLen !== list.length) {
      var set = new Set();
      for (var i = 0; i < list.length; i++) {
        var active = getCandidatePreviewSrc(list[i]);
        if (active) set.add(SharedUtils.normalizeImageUrl(active));
      }
      ts.__activeCandidateKeys = set;
      ts.__activeCandidateKeysLen = list.length;
    }
    return ts.__activeCandidateKeys;
  }

  function candidateAlreadyActive(ts, src) {
    return getActiveCandidateKeySet(ts).has(SharedUtils.normalizeImageUrl(src));
  }

  function getCandidateUrlKey(candidate) {
    var previewSrc = getCandidatePreviewSrc(candidate);
    return previewSrc ? SharedUtils.normalizeImageUrl(previewSrc) : '';
  }

  function markThreadFallbackCandidateUsed(ts, candidate, index) {
    if (!ts || !candidate) return;
    if (!ts.fallbackUsedIndexes) ts.fallbackUsedIndexes = {};
    if (!ts.fallbackUsedUrls) ts.fallbackUsedUrls = {};
    if (typeof index === 'number') ts.fallbackUsedIndexes[index] = true;
    var key = getCandidateUrlKey(candidate);
    if (key) ts.fallbackUsedUrls[key] = true;
  }

  function markTaskFallbackCandidateTried(task, candidate, index) {
    if (!task || !candidate) return;
    if (!task.fallbackTriedIndexes) task.fallbackTriedIndexes = {};
    if (!task.fallbackTriedUrls) task.fallbackTriedUrls = {};
    if (typeof index === 'number') task.fallbackTriedIndexes[index] = true;
    var key = getCandidateUrlKey(candidate);
    if (key) task.fallbackTriedUrls[key] = true;
  }

  function candidateAlreadyTried(ts, task, candidate, index) {
    var key = getCandidateUrlKey(candidate);
    if (ts && ts.fallbackUsedIndexes && ts.fallbackUsedIndexes[index]) return true;
    if (key && ts && ts.fallbackUsedUrls && ts.fallbackUsedUrls[key]) return true;
    if (task && task.fallbackTriedIndexes && task.fallbackTriedIndexes[index]) return true;
    if (key && task && task.fallbackTriedUrls && task.fallbackTriedUrls[key]) return true;
    return false;
  }

  // Heavy threads preview sourceCandidates, which a sibling-host swap of a
  // rendered slot does not touch: lay the swapped slots over it.
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

  function getPreviewCandidates(ts) {
    if (!ts) return [];
    return withSiblingHostPreviews(ts, ts.heavyMode && ts.sourceCandidates ? ts.sourceCandidates : (ts.candidates || []));
  }

  function setFallbackIndex(ts, fallbackIdx) {
    ts.fallbackIdx = fallbackIdx;
    ts.heavyFallbackIdx = fallbackIdx;
  }

  function findFallbackCandidate(ts, startIdx, preferNonHighFanout, requireNonHighFanout) {
    function findMatching(ordinaryOnly) {
      for (var i = startIdx; i < ts.sourceCandidates.length; i++) {
        var candidate = ts.sourceCandidates[i];
        var candidatePreviewSrc = getCandidatePreviewSrc(candidate);
        if (!candidate || !candidate.src || candidateAlreadyActive(ts, candidatePreviewSrc)) continue;
        if (candidateAlreadyTried(ts, null, candidate, i)) continue;
        if (ordinaryOnly && isHighFanoutImageHost(candidatePreviewSrc)) continue;
        return { candidate: candidate, index: i };
      }
      return null;
    }
    function findOrdinaryAnywhere() {
      for (var i = 0; i < ts.sourceCandidates.length; i++) {
        var candidate = ts.sourceCandidates[i];
        var candidatePreviewSrc = getCandidatePreviewSrc(candidate);
        if (!candidate || !candidate.src || candidateAlreadyActive(ts, candidatePreviewSrc)) continue;
        if (candidateAlreadyTried(ts, null, candidate, i)) continue;
        if (isHighFanoutImageHost(candidatePreviewSrc)) continue;
        return { candidate: candidate, index: i };
      }
      return null;
    }
    if (preferNonHighFanout) {
      var ordinary = findMatching(true) || findOrdinaryAnywhere();
      if (ordinary || requireNonHighFanout) return ordinary;
    }
    return findMatching(false);
  }

  function hasOrdinaryFallbackCandidate(ts, startIdx) {
    if (!ts || !ts.sourceCandidates || !ts.sourceCandidates.length) return false;
    return !!findFallbackCandidate(ts, startIdx || 0, true, true);
  }

  function isDeepHeavyRescueContext(ts, task, allowHeavyRescue, allowDeepHeavyRescue) {
    return !!(
      allowDeepHeavyRescue &&
      allowHeavyRescue &&
      ts &&
      ts.heavyMode &&
      ts.lightweightHeavyMode &&
      task &&
      (task.isFirstScreen || task.manualRetry) &&
      isHighFanoutPreviewTask(task) &&
      ts.sourceCandidates &&
      ts.candidates &&
      ts.sourceCandidates.length > ts.candidates.length
    );
  }

  function findDeepHeavyRescueCandidate(ts, task, fallbackIdx, fallbackLimit) {
    var source = ts.sourceCandidates || [];
    var sourceTotal = source.length;
    var renderedTotal = Math.max(0, (ts.candidates || []).length);
    var span = sourceTotal - renderedTotal;
    if (span <= 0) return null;

    var slotCount = Math.max(1, Math.min(ts.firstScreenTotal || renderedTotal || 1, renderedTotal || 1));
    var slotIdx = typeof task.idx === 'number' ? task.idx % slotCount : 0;
    if (slotIdx < 0) slotIdx = 0;
    var attempt = Math.max(1, (task.inlineFallbacks || 0) + 1);
    var steps = Math.max(1, (Number(fallbackLimit) || 1) - 1);
    var baseIndex = Math.max(renderedTotal, Math.min(fallbackIdx || renderedTotal, sourceTotal - 1));
    var preferredIndex = baseIndex;
    var deep = attempt > 1;

    if (deep) {
      var bandOffset = Math.floor((span - 1) * Math.min(steps, attempt - 1) / steps);
      preferredIndex = renderedTotal + bandOffset + slotIdx;
      if (preferredIndex >= sourceTotal) {
        preferredIndex = Math.max(renderedTotal, sourceTotal - 1 - slotIdx);
      }
    }

    var checked = {};
    function tryIndex(index) {
      index = Math.floor(Number(index));
      if (isNaN(index) || index < renderedTotal || index >= sourceTotal || checked[index]) return null;
      checked[index] = true;
      var candidate = source[index];
      var candidatePreviewSrc = getCandidatePreviewSrc(candidate);
      if (!candidate || !candidate.src || !candidatePreviewSrc) return null;
      if (candidateAlreadyActive(ts, candidatePreviewSrc)) return null;
      if (candidateAlreadyTried(ts, task, candidate, index)) return null;
      return {
        candidate: candidate,
        index: index,
        heavyDeepRescue: deep,
        rescueStrategy: deep ? 'stride' : 'sequential',
        rescueAttempt: attempt,
        rescueSpan: span,
        rescueStartIndex: renderedTotal,
        sequentialFallbackIdx: fallbackIdx
      };
    }

    var lane = Math.max(1, slotCount);
    var candidates = deep
      ? [
        preferredIndex,
        preferredIndex + lane,
        preferredIndex - lane,
        sourceTotal - 1 - slotIdx,
        renderedTotal + slotIdx,
        baseIndex
      ]
      : [baseIndex];
    for (var c = 0; c < candidates.length; c++) {
      var picked = tryIndex(candidates[c]);
      if (picked) return picked;
    }

    for (var distance = lane; distance < span + lane; distance += lane) {
      var forward = tryIndex(preferredIndex + distance);
      if (forward) return forward;
      var backward = tryIndex(preferredIndex - distance);
      if (backward) return backward;
    }

    for (var i = renderedTotal; i < sourceTotal; i++) {
      var sequential = tryIndex(i);
      if (sequential) return sequential;
    }
    return null;
  }

  function tryHeavyCandidateFallback(task, img, restartTimer, shouldApply) {
    if (!isTaskCurrent(task)) return false;
    var ts = getThreadState(task && task.threadId);
    if (!ts || !img || !ts.sourceCandidates || !ts.sourceCandidates.length) return false;
    if (!ts.candidates || ts.sourceCandidates.length <= ts.candidates.length) return false;
    var fallbackLimit = getCandidateFallbackLimit(ts, task);
    if ((task.inlineFallbacks || 0) >= fallbackLimit) {
      logImageEvent('fallback_skip', task, {
        reason: 'fallback_limit',
        fallbackLimit: fallbackLimit,
        fallbackCount: task.inlineFallbacks || 0,
        lightweightHeavyMode: !!ts.lightweightHeavyMode,
        backgroundBatch: !!task.backgroundBatch
      });
      return false;
    }
    var fallbackIdx = getFallbackStartIndex(ts);
    var preferOrdinary = ts.heavyMode && isHighFanoutPreviewTask(task);
    var ordinaryFallbackAvailable = preferOrdinary && hasOrdinaryFallbackCandidate(ts, fallbackIdx);
    var currentHealth = preferOrdinary ? getHeavyHostHealthLogFields(task) : {};
    var heavyHostOpen = currentHealth.heavyHostState === 'open';
    var allowHeavyRescue = preferOrdinary && !ordinaryFallbackAvailable && !heavyHostOpen;
    var requireOrdinary = preferOrdinary && !allowHeavyRescue;
    var deepRescueEligible = isDeepHeavyRescueContext(
      ts,
      task,
      allowHeavyRescue,
      fallbackLimit > 1
    );
    var previousCandidate = getTaskImageData(task);
    var previousIndex = getTaskPreviewIndex(task);
    var previousSrc = getTaskImageSrc(task);
    var previousPreviewSrc = getTaskPreviewSrc(task);
    markTaskFallbackCandidateTried(task, previousCandidate, previousIndex);
    var picked = deepRescueEligible
      ? findDeepHeavyRescueCandidate(ts, task, fallbackIdx, fallbackLimit)
      : null;
    if (!picked) picked = findFallbackCandidate(ts, fallbackIdx, preferOrdinary, requireOrdinary);
    if (!picked) {
      if (heavyHostOpen && preferOrdinary && !ordinaryFallbackAvailable) {
        logImageEvent('fallback_defer', task, Object.assign({
          reason: 'heavy_host_open',
          fallbackIdx: fallbackIdx,
          fallbackCount: task.inlineFallbacks || 0,
          fallbackLimit: fallbackLimit
        }, currentHealth));
        return false;
      }
      setFallbackIndex(ts, ts.sourceCandidates.length);
      logImageEvent('fallback_miss', task, {
        reason: 'no_candidate',
        fallbackIdx: fallbackIdx,
        preferOrdinary: !!preferOrdinary,
        requireOrdinary: !!requireOrdinary,
        allowHeavyRescue: !!allowHeavyRescue,
        heavyDeepRescueEligible: !!deepRescueEligible
      });
      return false;
    }
    var pickedPreviewSrc = getCandidatePreviewSrc(picked.candidate);
    var pickedHighFanout = isHighFanoutImageHost(pickedPreviewSrc);
    if (ts.heavyMode && isHeavyChannelTask(task) && pickedHighFanout && !allowHeavyRescue) {
      var slotLimit = getEffectiveHighFanoutSlotLimit(task, getCurrentSettings(), getActiveOrdinaryCount() > 0);
      if (GLOBAL_HIGH_FANOUT_ACTIVE > slotLimit) {
        logImageEvent('fallback_skip', task, {
          reason: 'heavy_slot_pressure',
          fallbackIdx: fallbackIdx,
          pickedIndex: picked.index,
          heavyActive: GLOBAL_HIGH_FANOUT_ACTIVE,
          slotLimit: slotLimit,
          allowHeavyRescue: false
        });
        return false;
      }
    }
    if (picked.heavyDeepRescue) {
      setFallbackIndex(ts, Math.min(ts.sourceCandidates.length, Math.max(fallbackIdx, (picked.sequentialFallbackIdx || fallbackIdx) + 1)));
    } else {
      setFallbackIndex(ts, picked.index + 1);
    }
    var replacement = Object.assign({}, picked.candidate, { previewIndex: picked.index });
    ts.candidates[task.idx] = replacement;
    ts.__activeCandidateKeys = null; // 候选被替换，失效已渲染候选集合缓存
    markThreadFallbackCandidateUsed(ts, replacement, picked.index);
    task.noReferrerFallbackTried = false;
    task.retries = 0;
    task.inlineFallbacks = (task.inlineFallbacks || 0) + 1;
    var replacementDisplaySrc = getCandidateDisplaySrc(replacement);
    var replacementPreviewSrc = getCandidatePreviewSrc(replacement);
    updateActiveHighFanoutSlot(task, replacementDisplaySrc);
    markTaskCurrentSourceStart(task, replacementDisplaySrc, shouldUseNoReferrerByDefault(replacementDisplaySrc));
    if (restartTimer) restartTimer();
    logDebugThrottled('candidateFallback', 'Image candidate fallback', replacementDisplaySrc, 3000);
    logImageEvent('fallback_pick', task, {
      fromHost: getUrlHost(previousSrc),
      toHost: getUrlHost(replacementDisplaySrc),
      fromPreviewHost: getUrlHost(previousPreviewSrc),
      toPreviewHost: getUrlHost(replacementPreviewSrc),
      fromUrl: shortUrl(previousSrc),
      toUrl: shortUrl(replacementDisplaySrc),
      fromPreviewUrl: shortUrl(previousPreviewSrc),
      toPreviewUrl: shortUrl(replacementPreviewSrc),
      pickedIndex: picked.index,
      fallbackCount: task.inlineFallbacks,
      fallbackLimit: fallbackLimit,
      heavyDeepRescue: !!picked.heavyDeepRescue,
      heavyDeepRescueEligible: !!deepRescueEligible,
      rescueStrategy: picked.rescueStrategy,
      rescueAttempt: picked.rescueAttempt,
      rescueSpan: picked.rescueSpan,
      rescueStartIndex: picked.rescueStartIndex,
      sequentialFallbackIdx: picked.sequentialFallbackIdx,
      lightweightHeavyMode: !!ts.lightweightHeavyMode,
      backgroundBatch: !!task.backgroundBatch,
      heavyHostDeferred: !!heavyHostOpen,
      preferOrdinary: !!preferOrdinary,
      ordinaryFallbackAvailable: !!ordinaryFallbackAvailable,
      allowHeavyRescue: !!allowHeavyRescue
    });
    setImageSource(img, replacementDisplaySrc, shouldUseNoReferrerByDefault(replacementDisplaySrc), shouldApply);
    return true;
  }

  var ATPLoader = {
    isPaused: function() { return GLOBAL_PAUSED; },

    recordDomainSuccess: function(url, task) { recordDomainSuccess(url, task); },
    recordDomainFailure: function(url, reason) { recordDomainFailure(url, reason); },
    recordTaskImageFailure: function(task, url, reason, finalFailure) {
      recordTaskImageFailure(task, url, reason, finalFailure);
    },
    getPreviewCandidates: function(ts) { return getPreviewCandidates(ts); },

    trySiblingHostFallback: function(task, img, restartTimer, shouldApply) {
      return trySiblingHostFallback(task, img, restartTimer, shouldApply);
    },

    tryNoReferrerFallback: function(task, img, src, restartTimer, shouldApply) {
      return tryNoReferrerFallback(task, img, src, restartTimer, shouldApply);
    },
    tryContinueTimedImageLoad: function(task, img, restartTimer) {
      return tryContinueTimedImageLoad(task, img, restartTimer);
    },
    isImageTaskDeadlineSpent: function(task) { return isImageTaskDeadlineSpent(task); },
    isLargeImageTask: function(task) { return isLargeLaneTask(task); },
    isLargeLaneBlocked: function(task) { return isLargeLaneBlocked(task); },
    freezeAnimatedThumbnail: function(wrapper, img, task) { return freezeAnimatedThumbnail(wrapper, img, task); },
    setImageSource: function(img, src, noReferrer, shouldApply) {
      setImageSource(img, src, noReferrer, shouldApply);
    },
    markTaskCurrentSourceStart: function(task, src, noReferrer) {
      markTaskCurrentSourceStart(task, src, noReferrer);
    },
    registerActiveImageLoad: function(control) {
      return registerActiveImageLoad(control);
    },
    recoverActiveImageLoads: function(reason) {
      recoverActiveImageLoads(reason);
    },
    cancelImageLoadElement: function(img) {
      cancelImageLoadElement(img);
    },
    getActiveSlotToken: function(task) {
      return getTaskActiveSlotToken(task);
    },
    getHeavyActive: function() { return GLOBAL_HIGH_FANOUT_ACTIVE; },
    isImageSlotCurrent: function(task, slotToken) {
      return !!(
        task &&
        task.slotActive &&
        task.slotEpoch === IMAGE_SLOT_EPOCH &&
        isRegisteredActiveSlot(task) &&
        (slotToken === undefined || slotToken === null || task.activeSlotToken === slotToken)
      );
    },
    prepareThumbnailImage: function(img, task, w, h) {
      prepareThumbnailImage(img, task, w, h);
    },
    updateTaskViewportPriority: function(task, wrapper, visible) {
      return updateTaskViewportPriority(task, wrapper, visible);
    },
    bindPreviewActivation: function(wrapper, openPreview, task) {
      bindPreviewActivation(wrapper, openPreview, task);
    },
    clearPreviewActivation: function(wrapper) {
      clearPreviewActivation(wrapper);
    },
    getCandidatePreviewSrc: function(imgData) { return getCandidatePreviewSrc(imgData); },
    buildPreviewUrls: function(candidates) { return buildPreviewUrls(candidates); },
    getCandidateDisplaySrc: function(imgData) { return getCandidateDisplaySrc(imgData); },
    getTaskImageSrc: function(task) { return getTaskImageSrc(task); },
    getTaskPreviewSrc: function(task) { return getTaskPreviewSrc(task); },
    getTaskPreviewIndex: function(task) { return getTaskPreviewIndex(task); },
    getImageLoadTimeout: function(settings, task) { return getImageLoadTimeout(settings, task); },
    getImageMetrics: function(img) { return getImageMetrics(img); },
    isDiagnosticLoggingEnabled: function(level) { return isDiagnosticLoggingEnabled(level); },
    logImageDone: function(task, ok, reason, extra) { logImageDone(task, ok, reason, extra); },
    logRenderEvent: function(type, task, fields, level) { logRenderEvent(type, task, fields, level); },
    isTaskCurrent: function(task) { return isTaskCurrent(task); },
    isBackgroundImageLocked: function(task) { return isBackgroundImageLocked(task); },
    isWrapperVisible: function(wrapper) { return isWrapperInViewport(wrapper); },
    isHeavyScrollActive: function() { return !!HEAVY_SCROLLING; },
    // 供视口层判断「免槽的可见恢复」是否该放行：熔断冷却期内不额外加压
    isTaskHostCoolingDown: function(task) {
      var src = task && getTaskImageSrc(task);
      if (!src) return false;
      var stats = getHeavyHostStats(getUrlHost(src), false);
      return getHeavyHostCooldownRemaining(stats) > 0;
    },
    isHeavyChannelTask: function(task) { return isHeavyChannelTask(task, ATPLoader.getSettings()); },
    isHeavyChannelSrc: function(src) { return isHeavyChannelSrc(src, ATPLoader.getSettings()); },
    tryHeavyCandidateFallback: function(task, img, restartTimer, shouldApply) {
      return tryHeavyCandidateFallback(task, img, restartTimer, shouldApply);
    },

    getSettings: function() {
      return getCurrentSettings();
    },

    getConc: function() {
      var settings = ATPLoader.getSettings();
      return (settings && settings.firstScreenConcurrency) || 3;
    },

    getBgConc: function() {
      var settings = ATPLoader.getSettings();
      return (settings && settings.backgroundConcurrency) || 1;
    },

    getAvailableSlots: function() {
      // 视口重试循环每次尝试都会调本函数（每张图完成后 10-20 次）：
      // 按 BG_TASKS_VERSION 缓存通道快照（与 hasNonHighFanoutBgTask 同一容忍度）
      if (BG_SNAPSHOT_CACHE_VERSION !== BG_TASKS_VERSION) {
        BG_SNAPSHOT_CACHE = getTaskChannelSnapshot(BG_TASKS);
        BG_SNAPSHOT_CACHE_VERSION = BG_TASKS_VERSION;
      }
      var snapshot = BG_SNAPSHOT_CACHE;
      return getAvailableSlotsForLimits(
        Math.max(ATPLoader.getConc(), ATPLoader.getBgConc()),
        snapshot.ordinary > 0,
        snapshot
      );
    },

    getViewportPendingCount: function() {
      return window.ATPViewport ? ATPViewport.getPendingCount() : 0;
    },

    roundRobinSchedule: function() {
      if (GLOBAL_PAUSED) return;
      var settings = ATPLoader.getSettings();
      var bgSnapshot = getCachedBgSnapshot();
      drainHiddenViewportPending(settings, bgSnapshot);
      var threads = window.ATPState && window.ATPState.threads;
      if (!threads) return;

      var max = ATPLoader.getConc();
      var activeThreadIds = getActiveFirstThreadIds(threads);
      logScheduleState('round_robin', { activeThreads: activeThreadIds.length });

      if (activeThreadIds.length === 0) {
        if (hasBackgroundDispatchCapacity(bgSnapshot) && BG_TASKS.length > 0) {
          ATPLoader.processBgTasks(bgSnapshot);
        }
        return;
      }

      beginViewportDistancePass();
      try {
        var viewportPriorityIds = getViewportPriorityFirstThreadIds(activeThreadIds, threads);
        if (viewportPriorityIds.length) {
          scheduleFirstTasksForThreads(viewportPriorityIds, threads, max);
        }
        activeThreadIds = getActiveFirstThreadIds(threads);
        var rankedIds = rankFirstThreadIdsByViewport(activeThreadIds, threads);
        activeThreadIds = [];
        for (var ri = 0; ri < rankedIds.length; ri++) activeThreadIds.push(rankedIds[ri].id);
        scheduleFirstTasksForThreads(activeThreadIds, threads, max);
      } finally {
        endViewportDistancePass();
      }

      if (hasBackgroundDispatchCapacity(bgSnapshot) && BG_TASKS.length > 0) {
        ATPLoader.processBgTasks(bgSnapshot);
      }
    },

    processBgTasks: function(existingBgSnapshot) {
      var maxBg = ATPLoader.getBgConc();
      var settings = ATPLoader.getSettings();
      var bypassViewportLazyLoad = shouldBypassViewportLazyLoad(settings);
      // 可见帖优先：把当前视口内帖子的后台任务稳定前移。未派发的任务还没有 DOM wrapper，
      // 可见优先加载通道帮不上它们——不前移的话，滚到页面中部要等更早入队帖的长积压
      var promotedVisible = promoteVisibleThreadBgTasks();
      var bgSnapshot = (!promotedVisible && existingBgSnapshot) || getTaskChannelSnapshot(BG_TASKS);
      if (bgSnapshot.ordinary > 0) bgSnapshot = promoteFirstOrdinaryBgTask(bgSnapshot);
      drainHiddenViewportPending(settings, bgSnapshot);
      var maxPending = getViewportPendingLimit(settings, maxBg);
      var pendingCount = ATPLoader.getViewportPendingCount();
      var viewportRegistrationEnabled = !!(window.ATPViewport && !bypassViewportLazyLoad);
      var processed = 0;
      var directProcessed = 0;
      var inspected = 0;
      var inspectBudget = BG_TASKS.length;
      var slotBudget = getAvailableBackgroundSlots(bgSnapshot);
      var registrationBudget = viewportRegistrationEnabled ? Math.max(0, maxPending - pendingCount) : 0;
      var dispatchBudget = viewportRegistrationEnabled ? registrationBudget : slotBudget;
      var timeSliceEndsAt = Date.now() + BACKGROUND_SCHEDULER_TIME_SLICE_MS;
      var bgReadIndex = 0;
      var hasNonHighFanoutWaiting = bgSnapshot.ordinary > 0;
      logScheduleState('background', {
        maxPending: maxPending,
        slotBudget: slotBudget,
        registrationBudget: registrationBudget,
        timeSliceMs: BACKGROUND_SCHEDULER_TIME_SLICE_MS,
        bypassViewportLazyLoad: !!bypassViewportLazyLoad
      });
      while (
        (viewportRegistrationEnabled ? pendingCount < maxPending : hasBackgroundCapacity(bgSnapshot)) &&
        bgReadIndex < BG_TASKS.length &&
        !GLOBAL_PAUSED &&
        processed < dispatchBudget &&
        inspected < inspectBudget &&
        Date.now() < timeSliceEndsAt
      ) {
        var task = BG_TASKS[bgReadIndex++];
        inspected++;
        if (!isTaskCurrent(task)) {
          continue;
        }
        var useViewportRegistration = viewportRegistrationEnabled && shouldUseViewportLazyLoad(task, settings);
        if (!useViewportRegistration && (directProcessed >= slotBudget || shouldDeferTaskForSlots(task, maxBg, hasNonHighFanoutWaiting))) {
          BG_TASKS.push(task);
          markBgTasksChanged();
          continue;
        }
        task.viewportRegistration = useViewportRegistration;
        ATPLoader.globalLoadImage(task);
        var dispatchedThread = getThreadState(task.threadId);
        if (dispatchedThread && !dispatchedThread.heavyMode &&
            releaseBackgroundBatchTask(task, dispatchedThread)) {
          ATPLoader.enqueueBgForThread(task.threadId);
        }
        if (useViewportRegistration) pendingCount++;
        else directProcessed++;
        processed++;
      }
      if (bgReadIndex > 0) {
        BG_TASKS.splice(0, bgReadIndex);
        markBgTasksChanged();
      }
      if (BG_TASKS.length > 0 && !GLOBAL_PAUSED) {
        // 此处 BG_TASKS 刚被 splice 过、版本必变，这一次必然重算；
        // 走带缓存的入口顺带把结果留给下一轮排程复用
        var nextBgSnapshot = getCachedBgSnapshot();
        if (viewportRegistrationEnabled && pendingCount >= maxPending) {
          scheduleBackgroundPendingRetry(maxPending, pendingCount);
        } else if (hasBackgroundDispatchCapacity(nextBgSnapshot)) {
          ATPLoader.scheduleBgQueue();
        } else {
          scheduleBackgroundCapacityRetry(nextBgSnapshot, 'background_capacity_wait');
        }
      }
    },

    globalSchedule: function() {
      if (GLOBAL_PAUSED || GLOBAL_SCHEDULING) return;
      GLOBAL_SCHEDULING = true;
      try {
        // A released slot must not be taken by queued prefetch work before the
        // asynchronous slot-wake callback can reach already-visible wrappers.
        if (window.ATPViewport && ATPViewport.retryActualVisiblePending) {
          ATPViewport.retryActualVisiblePending();
        }
        ATPLoader.roundRobinSchedule();
      } finally {
        GLOBAL_SCHEDULING = false;
      }
    },

    globalLoadImage: function(task) {
      if (!isTaskCurrent(task)) {
        ATPLoader.globalSchedule();
        return;
      }
      var imgData = getTaskImageData(task);
      var src = imgData && imgData.src;

      if (!src) {
        ATPLoader.threadImageDone(task, false);
        ATPLoader.globalSchedule();
        return;
      }

      var settings = ATPLoader.getSettings();
      var w = (settings && settings.thumbWidth) || 110;
      var h = (settings && settings.thumbHeight) || 82;

      var wrapper = task.pausedWrapper;
      var lel = task.pausedLoadingEl;
      var reusePausedWrapper = !!(wrapper && (!document.contains || document.contains(wrapper)));
      task.pausedWrapper = null;
      task.pausedLoadingEl = null;
      if (!reusePausedWrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'atp-thumbnail-wrapper';
      } else {
        clearPreviewActivation(wrapper);
        clearHeavyWrapperVisualState(wrapper);
        wrapper.classList.remove('atp-thumbnail-failed');
        wrapper.classList.remove('atp-heavy-thumbnail');
        var existingImg = wrapper.querySelector && wrapper.querySelector('.atp-thumbnail-img');
        if (existingImg && existingImg.parentNode) existingImg.parentNode.removeChild(existingImg);
      }
      if (isHeavyChannelSrc(src, settings)) {
        wrapper.classList.add('atp-heavy-thumbnail');
        wrapper.classList.add('atp-heavy-preview-pending');
      }
      wrapper.style.width = w + 'px';
      wrapper.style.height = h + 'px';
      if (!lel || !lel.parentNode) {
        lel = document.createElement('div');
        lel.className = 'atp-thumbnail-loading';
        wrapper.appendChild(lel);
      }
      lel.style.width = w + 'px';
      lel.style.height = h + 'px';
      if (!reusePausedWrapper && task.grid) task.grid.appendChild(wrapper);

      wrapper.__atpLoadTask = task;
      observeLoadingAnimation(wrapper);
      if (task.isFirstScreen === false) {
        task.forceEager = shouldBypassViewportLazyLoad(settings);
        task.forceEagerLowPriority = task.forceEager && document.visibilityState !== 'visible';
      }
      var useViewportLazyLoad = shouldUseViewportLazyLoad(task, settings, wrapper);
      if (useViewportLazyLoad) {
        // 注册路径：此时还没有 img，可见性交给 IO 首帧回调判定，不做同步测量
        updateTaskViewportPriority(task, wrapper, task.viewportPriority === true);
        ATPViewport.observe(wrapper, task, imgData);
      } else {
        // 直载路径：马上就要发起请求，可见性必须此刻准确（决定 eager/high 或 lazy/low）。
        // 精判结果由 shouldUseViewportLazyLoad 本轮算好，这里直接复用，不再重复测量；
        // 隐藏标签页（bypass 提前返回，lazyProbeVisible 为 undefined）不测量——
        // 陈旧 rect 会误判为可见，反过来废掉上面刚算好的 forceEagerLowPriority
        var directVisible = task.viewportPriority === true || task.lazyProbeVisible === true;
        updateTaskViewportPriority(task, wrapper, directVisible);
        ATPLoader.loadImageDirect(wrapper, lel, task, imgData);
      }
    },

    loadImageDirect: function(wrapper, lel, task, imgData) {
      claimImageSlot(task);
      var slotToken = getTaskActiveSlotToken(task);
      var settings = ATPLoader.getSettings();
      var w = (settings && settings.thumbWidth) || 110;
      var h = (settings && settings.thumbHeight) || 82;

      var img = document.createElement('img');
      prepareThumbnailImage(img, task, w, h);
      wrapper.appendChild(img);
      var settled = false;
      var t = null;
      var unregisterActiveLoad = null;
      function isActiveLoadCurrent() {
        return !settled && (!task || isRegisteredActiveSlot(task) && task.activeSlotToken === slotToken);
      }
      function finishActiveLoad() {
        if (unregisterActiveLoad) {
          unregisterActiveLoad();
          unregisterActiveLoad = null;
        }
      }
      function cancelActiveLoad(reason) {
        if (settled) return;
        var hiddenPause = isHiddenPauseCancelReason(reason) && isActiveLoadCurrent();
        settled = true;
        if (t) {
          clearTimeout(t);
          t = null;
        }
        img.onclick = null;
        cancelImageLoadElement(img);
        if (hiddenPause && img.parentNode) img.parentNode.removeChild(img);
        finishActiveLoad();
        if (hiddenPause) {
          releaseImageSlot(task, slotToken);
          if (!requeuePausedImageTask(task, wrapper, lel, reason)) removeWrapper(wrapper);
        }
      }
      function abandonStaleActiveLoad() {
        if (settled || isActiveLoadCurrent()) return false;
        settled = true;
        if (t) {
          clearTimeout(t);
          t = null;
        }
        img.onclick = null;
        cancelImageLoadElement(img);
        finishActiveLoad();
        return true;
      }
      function recoverActiveLoad(reason) {
        if (settled) return;
        if (!isActiveLoadCurrent()) {
          abandonStaleActiveLoad();
          return;
        }
        if (img.complete && img.naturalWidth) {
          if (typeof img.onload === 'function') img.onload();
          return;
        }
        if ((img.currentSrc || img.src) && (!document.contains || document.contains(wrapper))) {
          startTimer();
          return;
        }
        var currentSrc = getTaskImageSrc(task);
        recordTaskImageFailure(task, currentSrc, reason || 'active_recover', false);
        if (tryNoReferrerFallback(task, img, currentSrc, startTimer, isActiveLoadCurrent)) return;
        if (tryHeavyCandidateFallback(task, img, startTimer, isActiveLoadCurrent)) return;
        failFinal(reason || 'direct_recover');
      }
      unregisterActiveLoad = registerActiveImageLoad({ cancel: cancelActiveLoad, recover: recoverActiveLoad });
      function startTimer(timeoutOverride) {
        if (settled) return;
        if (!isActiveLoadCurrent()) {
          abandonStaleActiveLoad();
          return;
        }
        if (t) clearTimeout(t);
        var overrideTimeout = Number(timeoutOverride);
        var imgTimeout = !isNaN(overrideTimeout) && overrideTimeout > 0
          ? overrideTimeout
          : getImageLoadTimeout(ATPLoader.getSettings(), task);
        t = setTimeout(function() {
          if (settled) return;
          if (!isActiveLoadCurrent()) {
            abandonStaleActiveLoad();
            return;
          }
          if (tryContinueTimedImageLoad(task, img, startTimer)) return;
          var currentSrc = getTaskImageSrc(task);
          recordTaskImageFailure(task, currentSrc, 'candidate_timeout', false);
          if (isImageTaskDeadlineSpent(task)) { failFinal('deadline_exhausted'); return; }
          if (!isLargeLaneTask(task) && tryNoReferrerFallback(task, img, currentSrc, startTimer, isActiveLoadCurrent)) return;
          if (tryHeavyCandidateFallback(task, img, startTimer, isActiveLoadCurrent)) return;
          failFinal();
        }, imgTimeout);
      }
      function failFinal(reason) {
        if (settled) return;
        if (!isActiveLoadCurrent()) {
          abandonStaleActiveLoad();
          return;
        }
        settled = true;
        if (t) {
          clearTimeout(t);
          t = null;
        }
        finishActiveLoad();
        unobserveLoadingAnimation(wrapper);
        var currentSrc = getTaskImageSrc(task);
        var failReason = reason || 'direct_fail';
        recordTaskImageFailure(task, currentSrc, failReason, true);
        logImageDone(task, false, failReason, isDiagnosticLoggingEnabled('DEBUG') ? getWrapperLogFields(wrapper) : null);
        releaseImageSlot(task, slotToken);
        if (!isTaskCurrent(task)) {
          removeWrapper(wrapper);
          ATPLoader.globalSchedule();
          return;
        }
        if (ATPLoader.handleFail(task)) {
          removeWrapper(wrapper);
        } else {
          ATPLoader.showFailedPlaceholder(wrapper, lel, task, currentSrc);
        }
      }
      startTimer();

      img.onload = function() {
        if (settled) return;
        if (!isActiveLoadCurrent()) {
          abandonStaleActiveLoad();
          return;
        }
        settled = true;
        if (t) {
          clearTimeout(t);
          t = null;
        }
        finishActiveLoad();
        unobserveLoadingAnimation(wrapper);
        logImageDone(task, true, 'direct_load', isDiagnosticLoggingEnabled('DEBUG') ? getImageMetrics(img) : null);
        releaseImageSlot(task, slotToken);
        if (!isTaskCurrent(task)) {
          removeWrapper(wrapper);
          ATPLoader.globalSchedule();
          return;
        }
        recordDomainSuccess(getTaskImageSrc(task), task);
        var heavyTask = isHeavyChannelTask(task);
        if (heavyTask && window.ATPViewport && ATPViewport.monitorLoadedHeavyImage) {
          ATPViewport.monitorLoadedHeavyImage(wrapper, img, task);
        } else {
          clearHeavyWrapperVisualState(wrapper);
          freezeAnimatedThumbnail(wrapper, img, task);
        }
        if (lel && lel.parentNode) lel.remove();
        if (!wrapper.classList.contains('atp-heavy-unloaded')) img.style.display = 'block';
        img.style.cursor = 'pointer';
        var openPreview = function(preferOpenerFocus) {
          var threads = window.ATPState && window.ATPState.threads;
          var ts = threads && threads[task.threadId];
          if (ts && ts.candidates && window.ATPPreviewer) {
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
        };
        img.onclick = function(evt) {
          if (evt && evt.stopPropagation) evt.stopPropagation();
          openPreview(true);
        };
        bindPreviewActivation(wrapper, openPreview, task);
        if (heavyTask) {
          wrapper.onclick = function(evt) {
            if (evt && evt.stopPropagation) evt.stopPropagation();
            openPreview(true);
          };
          wrapper.style.cursor = 'pointer';
        }
        ATPLoader.threadImageDone(task, true);
      };
      img.onerror = function() {
        if (settled) return;
        if (!isActiveLoadCurrent()) {
          abandonStaleActiveLoad();
          return;
        }
        var currentSrc = getTaskImageSrc(task);
        if (tryNoReferrerFallback(task, img, currentSrc, startTimer, isActiveLoadCurrent)) return;
        if (trySiblingHostFallback(task, img, startTimer, isActiveLoadCurrent)) return;
        recordTaskImageFailure(task, currentSrc, 'candidate_error', false);
        if (tryHeavyCandidateFallback(task, img, startTimer, isActiveLoadCurrent)) return;
        failFinal();
      };
      var initialSrc = getTaskImageSrc(task);
      markTaskCurrentSourceStart(task, initialSrc, shouldUseNoReferrerByDefault(initialSrc));
      setImageSource(img, initialSrc, shouldUseNoReferrerByDefault(initialSrc), isActiveLoadCurrent);
    },

    showFailedPlaceholder: function(wrapper, loadingEl, task, src) {
      unobserveLoadingAnimation(wrapper);
      clearHeavyWrapperVisualState(wrapper);
      clearPreviewActivation(wrapper);
      if (loadingEl && loadingEl.parentNode) loadingEl.remove();
      var existingImg = wrapper.querySelector('.atp-thumbnail-img');
      if (existingImg && existingImg.parentNode) existingImg.remove();
      wrapper.classList.add('atp-thumbnail-failed');
      var settings = ATPLoader.getSettings() || {};
      if (!wrapper.style.width) wrapper.style.width = (settings.thumbWidth || 110) + 'px';
      if (!wrapper.style.height) wrapper.style.height = (settings.thumbHeight || 82) + 'px';
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      wrapper.style.gap = '4px';
      wrapper.style.alignItems = 'center';
      wrapper.style.justifyContent = 'center';
      wrapper.style.background = '#f0f0f0';
      wrapper.style.border = '1px dashed #ccc';
      wrapper.style.cursor = 'pointer';
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'button');
      var span = document.createElement('span');
      span.style.color = '#999';
      span.style.fontSize = '18px';
      span.style.lineHeight = '18px';
      span.textContent = '⚠';
      wrapper.appendChild(span);
      var retryStatus = document.createElement('span');
      retryStatus.className = 'atp-thumbnail-failed-status';
      retryStatus.style.color = '#777';
      retryStatus.style.fontSize = '11px';
      retryStatus.style.lineHeight = '14px';
      retryStatus.style.textAlign = 'center';
      retryStatus.textContent = '';
      wrapper.appendChild(retryStatus);
      function setFailedRetryStatus(message, title, label) {
        retryStatus.textContent = message;
        wrapper.title = title;
        wrapper.setAttribute('aria-label', label);
      }
      setFailedRetryStatus('加载失败，点击重试', '加载失败，点击重试', '缩略图加载失败，按 Enter 重试');
      function retryKeyHandler(evt) {
        var key = evt && evt.key;
        if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
        if (evt.preventDefault) evt.preventDefault();
        if (evt.stopPropagation) evt.stopPropagation();
        retryClickHandler(evt);
      }
      function setRetryActivation() {
        wrapper.onclick = retryClickHandler;
        wrapper.onkeydown = retryKeyHandler;
      }
      function retryClickHandler(evt) {
        if (evt && evt.stopPropagation) evt.stopPropagation();
        if (!isTaskCurrent(task)) {
          removeWrapper(wrapper);
          return;
        }
        wrapper.onclick = null;
        wrapper.onkeydown = null;
        var ts = getThreadState(task.threadId);
        var now = Date.now();
        var retryTask = {
          candidates: task.candidates || [{ src: src }],
          idx: typeof task.idx === 'number' ? task.idx : 0,
          threadId: task.threadId,
          generation: ts && ts.generation,
          grid: task.grid,
          isFirstScreen: false,
          retries: 0,
          manualRetry: true,
          wasCountedFailed: true,
          createdAt: now,
          queuedAt: now,
          queueKind: 'manual_retry'
        };
        if (!ATPLoader.acquireSlot(retryTask)) {
          setFailedRetryStatus('正在加载其他图片，稍后重试', '正在加载其他图片，稍后重试', '正在加载其他图片，稍后按 Enter 重试');
          setRetryActivation();
          return;
        }
        clearPreviewActivation(wrapper);
        wrapper.classList.remove('atp-thumbnail-failed');
        wrapper.innerHTML = '';
        wrapper.style.display = '';
        wrapper.style.flexDirection = '';
        wrapper.style.gap = '';
        wrapper.style.alignItems = '';
        wrapper.style.justifyContent = '';
        wrapper.style.background = '';
        wrapper.style.border = '';
        wrapper.style.cursor = '';
        if (!wrapper.style.width) wrapper.style.width = (settings.thumbWidth || 110) + 'px';
        if (!wrapper.style.height) wrapper.style.height = (settings.thumbHeight || 82) + 'px';
        if (isHeavyChannelTask(retryTask, settings)) {
          wrapper.classList.add('atp-heavy-thumbnail');
          wrapper.classList.add('atp-heavy-preview-pending');
        }
        var newLoading = document.createElement('div');
        newLoading.className = 'atp-thumbnail-loading';
        newLoading.style.width = (settings.thumbWidth || 110) + 'px';
        newLoading.style.height = (settings.thumbHeight || 82) + 'px';
        wrapper.appendChild(newLoading);
        observeLoadingAnimation(wrapper);
        var newImg = document.createElement('img');
        prepareThumbnailImage(newImg, { manualRetry: true }, settings.thumbWidth || 110, settings.thumbHeight || 82);
        wrapper.appendChild(newImg);
        ATPLoader.retryLoadImage(retryTask, newImg, newLoading, wrapper);
      }
      setRetryActivation();
    },

    retryLoadImage: function(task, img, loadingEl, wrapper) {
      var settings = ATPLoader.getSettings();
      var slotToken = getTaskActiveSlotToken(task);
      var settled = false;
      var t = null;
      var unregisterActiveLoad = null;
      function isActiveLoadCurrent() {
        return !settled && (!task || isRegisteredActiveSlot(task) && task.activeSlotToken === slotToken);
      }
      function finishActiveLoad() {
        if (unregisterActiveLoad) {
          unregisterActiveLoad();
          unregisterActiveLoad = null;
        }
      }
      function cancelActiveLoad(reason) {
        if (settled) return;
        var hiddenPause = isHiddenPauseCancelReason(reason) && isActiveLoadCurrent();
        settled = true;
        if (t) {
          clearTimeout(t);
          t = null;
        }
        img.onclick = null;
        cancelImageLoadElement(img);
        finishActiveLoad();
        if (hiddenPause) {
          releaseImageSlot(task, slotToken);
          if (isTaskCurrent(task)) {
            ATPLoader.showFailedPlaceholder(wrapper, loadingEl, task, getTaskImageSrc(task));
          } else {
            removeWrapper(wrapper);
          }
        }
      }
      function abandonStaleActiveLoad() {
        if (settled || isActiveLoadCurrent()) return false;
        settled = true;
        if (t) {
          clearTimeout(t);
          t = null;
        }
        img.onclick = null;
        cancelImageLoadElement(img);
        finishActiveLoad();
        return true;
      }
      function recoverActiveLoad(reason) {
        if (settled) return;
        if (!isActiveLoadCurrent()) {
          abandonStaleActiveLoad();
          return;
        }
        if (img.complete && img.naturalWidth) {
          if (typeof img.onload === 'function') img.onload();
          return;
        }
        if ((img.currentSrc || img.src) && (!document.contains || document.contains(wrapper))) {
          startTimer();
          return;
        }
        var src = getTaskImageSrc(task);
        recordTaskImageFailure(task, src, reason || 'active_recover', false);
        if (tryNoReferrerFallback(task, img, src, startTimer, isActiveLoadCurrent)) return;
        if (tryHeavyCandidateFallback(task, img, startTimer, isActiveLoadCurrent)) return;
        failFinal(reason || 'retry_recover');
      }
      unregisterActiveLoad = registerActiveImageLoad({ cancel: cancelActiveLoad, recover: recoverActiveLoad });
      function startTimer(timeoutOverride) {
        if (settled) return;
        if (!isActiveLoadCurrent()) {
          abandonStaleActiveLoad();
          return;
        }
        if (t) clearTimeout(t);
        var overrideTimeout = Number(timeoutOverride);
        var imgTimeout = !isNaN(overrideTimeout) && overrideTimeout > 0
          ? overrideTimeout
          : getImageLoadTimeout(ATPLoader.getSettings(), task);
        t = setTimeout(function() {
          if (settled) return;
          if (!isActiveLoadCurrent()) {
            abandonStaleActiveLoad();
            return;
          }
          if (tryContinueTimedImageLoad(task, img, startTimer)) return;
          var src = getTaskImageSrc(task);
          recordTaskImageFailure(task, src, 'candidate_timeout', false);
          if (isImageTaskDeadlineSpent(task)) { failFinal('deadline_exhausted'); return; }
          if (!isLargeLaneTask(task) && tryNoReferrerFallback(task, img, src, startTimer, isActiveLoadCurrent)) return;
          if (tryHeavyCandidateFallback(task, img, startTimer, isActiveLoadCurrent)) return;
          failFinal();
        }, imgTimeout);
      }
      function failFinal(reason) {
        if (settled) return;
        if (!isActiveLoadCurrent()) {
          abandonStaleActiveLoad();
          return;
        }
        settled = true;
        if (t) {
          clearTimeout(t);
          t = null;
        }
        finishActiveLoad();
        unobserveLoadingAnimation(wrapper);
        var src = getTaskImageSrc(task);
        var failReason = reason || 'retry_fail';
        recordTaskImageFailure(task, src, failReason, true);
        logImageDone(task, false, failReason, isDiagnosticLoggingEnabled('DEBUG') ? getWrapperLogFields(wrapper) : null);
        ATPLoader.releaseSlot(task, slotToken);
        if (!isTaskCurrent(task)) {
          removeWrapper(wrapper);
          ATPLoader.globalSchedule();
          return;
        }
        ATPLoader.showFailedPlaceholder(wrapper, loadingEl, task, src);
        ATPLoader.globalSchedule();
      }
      startTimer();
      img.onload = function() {
        if (settled) return;
        if (!isActiveLoadCurrent()) {
          abandonStaleActiveLoad();
          return;
        }
        settled = true;
        if (t) {
          clearTimeout(t);
          t = null;
        }
        finishActiveLoad();
        unobserveLoadingAnimation(wrapper);
        logImageDone(task, true, 'retry_load', isDiagnosticLoggingEnabled('DEBUG') ? getImageMetrics(img) : null);
        ATPLoader.releaseSlot(task, slotToken);
        if (!isTaskCurrent(task)) {
          removeWrapper(wrapper);
          ATPLoader.globalSchedule();
          return;
        }
        recordDomainSuccess(getTaskImageSrc(task), task);
        clearPreviewActivation(wrapper);
        var heavyTask = isHeavyChannelTask(task);
        if (heavyTask && window.ATPViewport && ATPViewport.monitorLoadedHeavyImage) {
          ATPViewport.monitorLoadedHeavyImage(wrapper, img, task);
        } else {
          clearHeavyWrapperVisualState(wrapper);
          freezeAnimatedThumbnail(wrapper, img, task);
        }
        if (loadingEl && loadingEl.parentNode) loadingEl.remove();
        if (!wrapper.classList.contains('atp-heavy-unloaded')) img.style.display = 'block';
        img.style.cursor = 'pointer';
        var openPreview = function(preferOpenerFocus) {
          var threads = window.ATPState && window.ATPState.threads;
          var ts = threads && threads[task.threadId];
          if (ts && ts.candidates && window.ATPPreviewer) {
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
        };
        img.onclick = function(evt) {
          if (evt && evt.stopPropagation) evt.stopPropagation();
          openPreview(true);
        };
        bindPreviewActivation(wrapper, openPreview, task);
        wrapper.style.cursor = 'default';
        wrapper.title = '';
        wrapper.onclick = null;
        if (heavyTask) {
          wrapper.onclick = function(evt) {
            if (evt && evt.stopPropagation) evt.stopPropagation();
            openPreview(true);
          };
          wrapper.style.cursor = 'pointer';
        }
        if (task.manualRetry) {
          var threads = window.ATPState && window.ATPState.threads;
          var ts = threads && threads[task.threadId];
          if (ts) {
            if (task.wasCountedFailed && ts.failedCount > 0) ts.failedCount--;
            ts.consecutiveFails = 0;
          }
          ATPLoader.threadImageDone(task, true);
        }
      };
      img.onerror = function() {
        if (settled) return;
        if (!isActiveLoadCurrent()) {
          abandonStaleActiveLoad();
          return;
        }
        var src = getTaskImageSrc(task);
        if (tryNoReferrerFallback(task, img, src, startTimer, isActiveLoadCurrent)) return;
        if (trySiblingHostFallback(task, img, startTimer, isActiveLoadCurrent)) return;
        recordTaskImageFailure(task, src, 'candidate_error', false);
        if (tryHeavyCandidateFallback(task, img, startTimer, isActiveLoadCurrent)) return;
        failFinal();
      };
      var initialSrc = getTaskImageSrc(task);
      markTaskCurrentSourceStart(task, initialSrc, shouldUseNoReferrerByDefault(initialSrc));
      setImageSource(img, initialSrc, shouldUseNoReferrerByDefault(initialSrc), isActiveLoadCurrent);
    },

    handleFail: function(task) {
      if (!isTaskCurrent(task)) return true;
      var settings = ATPLoader.getSettings();
      var maxRetry = (settings && settings.maxRetryPerImage) || 0;
      task.retries = (task.retries || 0) + 1;

      var threads = window.ATPState && window.ATPState.threads;
      var ts = threads && threads[task.threadId];

      if (task.retries <= maxRetry) {
        task.queuedAt = Date.now();
        // A retry gets its own deadline; reusing the spent one made every
        // retry expire after 1ms while still sending a real request.
        task.taskDeadlineAt = 0;
        task.currentlyVisible = undefined; // 重试入队时清除过期的可见性标记
        task.queueKind = task.isFirstScreen ? 'first_retry' : 'background_retry';
        if (task.isFirstScreen && ts && ts.firstTasks) {
          ts.firstTasks.push(task);
        } else {
          BG_TASKS.push(task);
          markBgTasksChanged();
        }
        ATPLoader.globalSchedule();
        return true;
      }

      // threadImageDone 末尾自己会跑一轮 globalSchedule，此处不再重复
      ATPLoader.threadImageDone(task, false);
      return false;
    },

    threadImageDone: function(task, ok) {
      if (!isTaskCurrent(task)) return;
      var threads = window.ATPState && window.ATPState.threads;
      if (!threads) return;
      var ts = threads[task.threadId];
      if (!ts) return;

      if (ok) {
        ts.loaded++;
        var loadedUrl = getTaskPreviewSrc(task);
        var loadedKey = loadedUrl ? SharedUtils.normalizeImageUrl(loadedUrl) : '';
        if (loadedKey && !ts.loadedUrlMap[loadedKey]) {
          ts.loadedUrlMap[loadedKey] = true;
          ts.loadedUrls.push(loadedUrl);
          ATPCache.scheduleCacheFlush(task.threadId, ts.cacheWriteStartedAt);
        }
      } else {
        ts.failedCount = (ts.failedCount || 0) + 1;
        ts.consecutiveFails = (ts.consecutiveFails || 0) + 1;
        if (ts.consecutiveFails === 3) {
          Logger.warn('帖子连续失败', task.threadId + ' 连续失败3次，继续加载剩余候选');
        }
      }

      if (ok) {
        ts.consecutiveFails = 0;
      }

      if (task.isFirstScreen && !task.firstScreenSettled) {
        task.firstScreenSettled = true;
        if (ok) ts.firstScreenOk++;
        else ts.firstScreenFailed++;

        if (ts.firstScreenOk + ts.firstScreenFailed >= ts.firstScreenTotal) {
          ts.firstScreenDone = true;
          ts.container.classList.add('atp-processed');
          if (ts.loaded > 0 || SharedUtils.hasResourcePayload(ts.resources)) {
            ATPCache.flushCacheNow(task.threadId, ts.nextIdx >= ts.candidates.length);
            Logger.info('首屏完成', '已加载' + ts.loaded + ' 失败' + ts.failedCount + '/' + ts.total +
              ' 用时' + Math.max(0, Date.now() - (task.createdAt || Date.now())) + 'ms' +
              (ts.firstScreenViewportParked ? ' 视口等待' : ' 直载'));
          }
          ATPLoader.enqueueBgForThread(task.threadId);
        }
      }

      if (!task.isFirstScreen) releaseBackgroundBatchTask(task, ts);

      ts.statusEl.textContent = ATPLoader.formatThreadStatus(ts, false);
      if (ts.nextIdx < ts.candidates.length && !ts.bgQueued && !ts.bgQueueActive) {
        ATPLoader.enqueueBgForThread(task.threadId);
      }
      if (isThreadComplete(ts)) {
        ts.statusEl.textContent = ATPLoader.formatThreadStatus(ts, true);
        if (ts.loaded > 0 || SharedUtils.hasResourcePayload(ts.resources)) {
          ATPCache.flushCacheNow(task.threadId, true);
        }
      }

      // 完成后同步立即派发下一张（延到 0ms 定时器在主线程忙时会逐张累积几十毫秒，
      // 串行通道下直接拖慢整体节奏）；队列扫描已 memo 化，双跑一轮排程的成本可接受
      ATPLoader.globalSchedule();
    },

    enqueueBgForThread: function(threadId) {
      var threads = window.ATPState && window.ATPState.threads;
      if (!threads) return;
      var ts = threads[threadId];
      if (!isThreadCurrent(ts) || ts.bgQueued || ts.bgQueueActive || ts.backgroundUnlocked === false || !ts.firstScreenDone) return;
      var settings = ATPLoader.getSettings();
      if (!ts.heavyMode && !isOrdinaryBackgroundNearTail(ts, settings)) return;
      var heavyDeferInfo = getHeavyBackgroundDeferredInfo(ts);
      if (heavyDeferInfo) {
        applyHeavyBackgroundDeferred(ts, threadId, heavyDeferInfo);
        if (ts.statusEl) ts.statusEl.textContent = ATPLoader.formatThreadStatus(ts, false);
        return;
      }
      delete DEFERRED_HEAVY_THREADS[threadId];
      clearDeferredHeavyThreadTimer(threadId);
      ts.bgHostDeferred = false;
      ts.bgHostDeferredUntil = 0;
      var toEnqueue = getBackgroundEnqueueCount(ts, settings);
      toEnqueue = getLightweightMixedRescueEnqueueCount(ts, settings, toEnqueue);
      if (toEnqueue <= 0) {
        ts.bgQueued = ts.nextIdx >= ts.candidates.length;
        return;
      }
      var stagedLightweight = isLightweightHeavyThread(ts);
      ts.bgQueueActive = true;
      ts.bgBatchPending = (ts.bgBatchPending || 0) + toEnqueue;
      if (stagedLightweight) {
        if (isDiagnosticLoggingEnabled('DEBUG') && typeof Logger !== 'undefined' && Logger.event) {
          Logger.event('schedule_state', Object.assign({
            reason: 'lightweight_bg_batch',
            threadId: threadId,
            batchSize: toEnqueue,
            pendingBatch: ts.bgBatchPending,
            nextIdx: ts.nextIdx,
            total: ts.candidates.length,
            firstScreenTotal: ts.firstScreenTotal,
            heavyConfiguredLimit: getHeavyImageConcurrency(settings),
            bgQueueBefore: BG_TASKS.length,
            bgQueueAfter: BG_TASKS.length + toEnqueue
          }, getQueueSnapshotFields()));
        }
      }
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
      markBgTasksChanged();
      ts.bgQueued = ts.nextIdx >= ts.candidates.length;
      ATPLoader.scheduleBgQueue();
    },

    scheduleBgQueue: function() {
      if (GLOBAL_PAUSED) return;
      if (!BG_TASKS.length) {
        clearBackgroundRetryTimer();
        return;
      }
      if (GLOBAL_BG_TIMER) return;

      var maxBg = ATPLoader.getBgConc();
      var settings = ATPLoader.getSettings();
      var bypassViewportLazyLoad = shouldBypassViewportLazyLoad(settings);
      var maxPending = getViewportPendingLimit(settings, maxBg);
      var pendingCount = ATPLoader.getViewportPendingCount();
      if (!bypassViewportLazyLoad && pendingCount >= maxPending) {
        scheduleBackgroundPendingRetry(maxPending, pendingCount);
        return;
      }
      var bgSnapshot = getTaskChannelSnapshot(BG_TASKS);
      if (!hasBackgroundDispatchCapacity(bgSnapshot)) {
        scheduleBackgroundCapacityRetry(bgSnapshot, 'background_capacity_wait');
        return;
      }
      clearBackgroundRetryTimer();

      var delay = getBackgroundDelay(settings);
      if (!bypassViewportLazyLoad && typeof requestIdleCallback !== 'undefined') {
        GLOBAL_BG_TIMER_KIND = 'timeout';
        GLOBAL_BG_TIMER = setTimeout(function() {
          GLOBAL_BG_TIMER = null;
          GLOBAL_BG_TIMER_KIND = '';
          if (!BG_TASKS.length || GLOBAL_PAUSED) return;
          GLOBAL_BG_TIMER_KIND = 'idle';
          GLOBAL_BG_TIMER = requestIdleCallback(function() {
            GLOBAL_BG_TIMER = null;
            GLOBAL_BG_TIMER_KIND = '';
            if (BG_TASKS.length > 0 && !GLOBAL_PAUSED) {
              ATPLoader.processBgTasks();
            }
          }, { timeout: getBackgroundIdleTimeout(delay) });
        }, delay);
      } else {
        GLOBAL_BG_TIMER_KIND = 'timeout';
        GLOBAL_BG_TIMER = setTimeout(function() {
          GLOBAL_BG_TIMER = null;
          GLOBAL_BG_TIMER_KIND = '';
          if (BG_TASKS.length > 0 && !GLOBAL_PAUSED) {
            ATPLoader.globalSchedule();
            if (BG_TASKS.length > 0) {
              var nextSnapshot = getTaskChannelSnapshot(BG_TASKS);
              if (hasBackgroundDispatchCapacity(nextSnapshot)) {
                ATPLoader.scheduleBgQueue();
              } else {
                scheduleBackgroundCapacityRetry(nextSnapshot, 'background_capacity_wait');
              }
            }
          }
        }, delay);
      }
    },

    ensureGlobalVisListener: function() {
      if (GLOBAL_VIS_LISTENER) return;
      GLOBAL_VIS_LISTENER = function() {
        syncVisibilityPauseState(ATPLoader.getSettings(), true);
      };
      document.addEventListener('visibilitychange', GLOBAL_VIS_LISTENER);
      ensureScrollListener();
      syncVisibilityPauseState(ATPLoader.getSettings(), false);
    },

    syncVisibilityPauseState: function() {
      syncVisibilityPauseState(ATPLoader.getSettings(), true);
    },

    reconfigure: function(settings) {
      return reconfigureLoader(settings);
    },

    removeGlobalVisListener: function() {
      if (GLOBAL_VIS_LISTENER) {
        document.removeEventListener('visibilitychange', GLOBAL_VIS_LISTENER);
        GLOBAL_VIS_LISTENER = null;
      }
      if (GLOBAL_SCROLL_LISTENER) {
        document.removeEventListener('scroll', GLOBAL_SCROLL_LISTENER, GLOBAL_SCROLL_CAPTURE_OPTIONS);
        GLOBAL_SCROLL_LISTENER = null;
      }
      clearScrollIdleTimer();
      clearViewportSlotWakeTimer();
      clearHeavyHostWakeTimers();
      clearDeferredHeavyThreadWakeTimers();
    },

    pause: function() {
      GLOBAL_PAUSED = true;
      clearScrollIdleTimer();
      clearViewportSlotWakeTimer();
      clearHeavyHostWakeTimers();
      clearDeferredHeavyThreadWakeTimers();
      clearBackgroundTimers();
      if (window.ATPViewport && ATPViewport.clearPendingRetryTimers) {
        ATPViewport.clearPendingRetryTimers();
      }
      if (window.ATPViewport && ATPViewport.pauseHeavyRestores) {
        ATPViewport.pauseHeavyRestores();
      }
    },
    resume: function() {
      GLOBAL_PAUSED = false;
      resumeDeferredHeavyThreads();
      retryViewportVisiblePendingLoads();
      retryViewportPendingSlotLoads();
      if (window.ATPViewport && ATPViewport.resumeHeavyRestores) {
        ATPViewport.resumeHeavyRestores('loader_resume');
      }
      ATPLoader.globalSchedule();
    },

    acquireSlot: function(task) {
      var admissionLimit = task && (task.isFirstScreen || isPriorityImageTask(task))
        ? ATPLoader.getConc()
        : ATPLoader.getBgConc();
      if (shouldDeferTaskForSlots(task, admissionLimit, hasNonHighFanoutBgTask())) return false;
      claimImageSlot(task);
      return true;
    },

    handleDetachedViewportTask: function(task) {
      if (!task || !isTaskCurrent(task) || task.detachedPendingRecoveryScheduled) return false;
      task.detachedPendingRecoveryScheduled = true;
      setTimeout(function() {
        task.detachedPendingRecoveryScheduled = false;
        if (!isTaskCurrent(task)) return;
        var gridConnected = !!(task.grid && (!document.contains || document.contains(task.grid)));
        if (!gridConnected) {
          ATPLoader.threadImageDone(task, false);
          return;
        }
        resetPausedImageTaskForRequeue(task, 'detached_pending_requeue');
        task.viewportRegistration = true;
        ATPLoader.globalLoadImage(task);
        ATPLoader.globalSchedule();
      }, 0);
      return true;
    },

    releaseSlot: function(task, slotToken) {
      releaseImageSlot(task, slotToken);
    },

    resetActiveImageSlots: function(reason) {
      resetActiveImageSlots(reason);
    },
    suspendActiveImageSlotsForBfcache: function(reason) {
      suspendActiveImageSlotsForBfcache(reason);
    },

    teardownActiveSlots: function(reason) {
      teardownActiveSlots(reason);
    },

    formatThreadStatus: function(ts, done) {
      return formatThreadStatusText(ts, done);
    },

    clearBgTimer: function() {
      clearBackgroundTimers();
    },

    clearBgTasks: function() {
      flushDiagnosticSummary('clear_bg_tasks');
      BG_TASKS = [];
      markBgTasksChanged();
      clearHeavyHostWakeTimers();
      clearDeferredHeavyThreads();
      clearBackgroundTimers();
    }
  };

  window.ATPLoader = ATPLoader;
})();
