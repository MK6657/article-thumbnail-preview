(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;

  // O(1) incremental active slot counters — eliminates Object.keys(GLOBAL_ACTIVE_SLOTS)
  // linear scans and repeated getUrlHost() calls on every schedule tick.
  var globalActive = 0;
  var globalHighFanoutActive = 0;
  var perHostActive = Object.create(null);
  var perHostPriorityActive = Object.create(null);
  var perHostLargeActive = Object.create(null);
  var perHostLargePriorityActive = Object.create(null);
  var maxPerHostLargeActive = 0;
  var perHostProbeActive = Object.create(null);
  var perHostManualRetryActive = Object.create(null);
  var perHostSlotSets = Object.create(null);
  var activeSlotRecords = new Map();
  var slotEpoch = 0;
  var nextSlotToken = 0;

  var heavyHostStatsMap = Object.create(null);
  var ordinaryHostStatsMap = Object.create(null);
  var heavyHostWakeTimers = Object.create(null);
  var wakeCallback = null;

  var ORDINARY_TIMEOUT_WINDOW_MS = 45000;
  var ATTACHMENT_PATH_RE = /^((?:\/[^\/?#]+)*\/)forum\/\d{6}\/\d{2}\/\d{6}[a-z0-9]{16}\.(?:jpe?g|png|gif|webp|bmp)(?:\.thumb\.jpg)?$/i;
  var FORUM_ATTACHMENT_HOSTS = new Set(['tu.djhdhs.us', 'tu.ewrewej.la', 'tu.w4kmzkm.com']);
  var ATTACHMENT_SIBLING_MAX_AGE_MS = 10 * 60 * 1000;
  var ATTACHMENT_DEAD_THRESHOLD = 3;
  var ATTACHMENT_HOSTS = Object.create(null);

  var URL_HOST_CACHE = new Map();
  var URL_HOST_CACHE_MAX = 8000;

  function getSettings(override) {
    if (override) return override;
    return (root.ATPState && root.ATPState.settings) || {};
  }

  function getUrlHost(url) {
    var key = String(url || '');
    if (!key) return '';
    var cached = URL_HOST_CACHE.get(key);
    if (cached !== undefined) return cached;
    var host = '';
    try {
      host = new URL(key).hostname.toLowerCase();
    } catch (e) {
      host = '';
    }
    if (URL_HOST_CACHE.size >= URL_HOST_CACHE_MAX) {
      URL_HOST_CACHE.delete(URL_HOST_CACHE.keys().next().value);
    }
    URL_HOST_CACHE.set(key, host);
    return host;
  }

  function getImageUrlKey(url) {
    return typeof SharedUtils !== 'undefined' && SharedUtils && SharedUtils.normalizeImageUrl
      ? SharedUtils.normalizeImageUrl(url)
      : String(url || '');
  }

  function isHighFanoutImageHost(url) {
    var host = getUrlHost(url);
    return !!(host && typeof SharedUtils !== 'undefined' && SharedUtils && SharedUtils.isHeavyImageHost && SharedUtils.isHeavyImageHost(host));
  }

  function isLargeImageSrc(src) {
    return !!(src && typeof SharedUtils !== 'undefined' && SharedUtils && SharedUtils.isAnimatedGifUrl && SharedUtils.isAnimatedGifUrl(src));
  }

  function shouldUseNoReferrerByDefault(url) {
    return isHighFanoutImageHost(url);
  }

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
    if (task && typeof task.srcOverride === 'string' && task.srcOverride) return task.srcOverride;
    return getCandidateDisplaySrc(getTaskImageData(task));
  }

  function getTaskPreviewSrc(task) {
    return getCandidatePreviewSrc(getTaskImageData(task));
  }

  function isHighFanoutTask(task) {
    var imgData = getTaskImageData(task);
    if (imgData && getCandidatePreviewSrc(imgData) !== getCandidateDisplaySrc(imgData)) return false;
    return isHighFanoutImageHost(getTaskImageSrc(task));
  }

  function isHeavyImageOptimizationEnabled(settings) {
    settings = getSettings(settings);
    return ATPLoadPolicy.isHeavyImageOptimizationEnabled
      ? ATPLoadPolicy.isHeavyImageOptimizationEnabled(settings)
      : settings.heavyImageOptimization !== false;
  }

  function isHeavyChannelSrc(src, settings) {
    return isHighFanoutImageHost(src) && isHeavyImageOptimizationEnabled(settings);
  }

  function isHeavyChannelTask(task, settings) {
    var imgData = getTaskImageData(task);
    if (imgData && getCandidatePreviewSrc(imgData) !== getCandidateDisplaySrc(imgData)) return false;
    return isHeavyChannelSrc(getTaskImageSrc(task), settings);
  }

  function isLargeLaneTask(task) {
    return !!task && !isHighFanoutTask(task) && isLargeImageSrc(getTaskImageSrc(task));
  }

  function isTaskPriority(task) {
    return !!(task && (
      task.manualRetry ||
      task.currentlyVisible === true ||
      (task.currentlyVisible === undefined && task.viewportPriority === true)
    ));
  }

  function adjustCounter(map, key, delta) {
    if (!key || !delta) return;
    var next = (map[key] || 0) + delta;
    if (next <= 0) delete map[key];
    else map[key] = next;
  }

  function addSlotRecordCounts(rec) {
    if (!rec || rec.counted) return;
    rec.counted = true;
    globalActive++;
    if (rec.isHeavyChannel) globalHighFanoutActive++;
    if (rec.host) {
      adjustCounter(perHostActive, rec.host, 1);
      if (rec.isPriority) adjustCounter(perHostPriorityActive, rec.host, 1);
      if (rec.isLarge) {
        adjustCounter(perHostLargeActive, rec.host, 1);
        if ((perHostLargeActive[rec.host] || 0) > maxPerHostLargeActive) {
          maxPerHostLargeActive = perHostLargeActive[rec.host];
        }
        if (rec.isPriority) adjustCounter(perHostLargePriorityActive, rec.host, 1);
      }
      if (rec.isProbe) adjustCounter(perHostProbeActive, rec.host, 1);
      if (rec.isManualRetry) adjustCounter(perHostManualRetryActive, rec.host, 1);
      var set = perHostSlotSets[rec.host];
      if (!set) set = perHostSlotSets[rec.host] = new Set();
      set.add(rec);
    }
  }

  function removeSlotRecordCounts(rec) {
    if (!rec || !rec.counted) return;
    rec.counted = false;
    if (globalActive > 0) globalActive--;
    if (rec.isHeavyChannel && globalHighFanoutActive > 0) globalHighFanoutActive--;
    if (rec.host) {
      adjustCounter(perHostActive, rec.host, -1);
      if (rec.isPriority) adjustCounter(perHostPriorityActive, rec.host, -1);
      if (rec.isLarge) {
        adjustCounter(perHostLargeActive, rec.host, -1);
        if (rec.isPriority) adjustCounter(perHostLargePriorityActive, rec.host, -1);
      }
      if (rec.isProbe) adjustCounter(perHostProbeActive, rec.host, -1);
      if (rec.isManualRetry) adjustCounter(perHostManualRetryActive, rec.host, -1);
      var set = perHostSlotSets[rec.host];
      if (set) {
        set.delete(rec);
        if (!set.size) delete perHostSlotSets[rec.host];
      }
    }
  }

  // Sync priority flag on active records for a single host (at most hostConcurrency
  // items, e.g. 2-6 pointers, zero URL parsing) in case a caller mutated
  // task.currentlyVisible / task.viewportPriority directly on the task object.
  function syncHostPriorityIfMutated(host) {
    var set = host && perHostSlotSets[host];
    if (!set || !set.size) return;
    set.forEach(function (rec) {
      if (!rec.counted) return;
      var nextPriority = isTaskPriority(rec.task);
      if (nextPriority === rec.isPriority) return;
      adjustCounter(perHostPriorityActive, host, nextPriority ? 1 : -1);
      if (rec.isLarge) {
        adjustCounter(perHostLargePriorityActive, host, nextPriority ? 1 : -1);
      }
      rec.isPriority = nextPriority;
    });
  }

  function computeSlotAttributes(task, src, settings) {
    src = src !== undefined ? src : getTaskImageSrc(task);
    var host = getUrlHost(src);
    var heavyChannel = src === getTaskImageSrc(task)
      ? isHeavyChannelTask(task, settings)
      : isHeavyChannelSrc(src, settings);
    var priority = isTaskPriority(task);
    var large = !heavyChannel && !isHighFanoutImageHost(src) && isLargeImageSrc(src);
    var probe = false;
    if (heavyChannel && host) {
      var hStats = getHeavyHostStats(host, false);
      if (hStats && (hStats.state === 'open' || hStats.state === 'half_open')) {
        probe = true;
      }
    }
    return {
      host: host,
      isHeavyChannel: heavyChannel,
      isLarge: large,
      isPriority: priority,
      isProbe: probe,
      isManualRetry: !!(task && task.manualRetry)
    };
  }

  function computeTaskDeadlineMs(task, settings) {
    settings = getSettings(settings);
    var isLarge = !!(task && !task.readyImageQueue && isLargeLaneTask(task));
    var deadlineMs = isLarge
      ? ATPLoadPolicy.getLargeImageTaskDeadline(settings)
      : ATPLoadPolicy.getImageTaskDeadline(settings);
    if (!deadlineMs && task && task.manualRetry) {
      deadlineMs = getTaskAttemptTimeout(task, settings);
    }
    if (task && task.imageResumeRemainingMs > 0) {
      deadlineMs = deadlineMs > 0 ? Math.min(deadlineMs, task.imageResumeRemainingMs) : task.imageResumeRemainingMs;
      task.imageResumeRemainingMs = 0;
    }
    if (task && task.siblingTimeoutRemainingMs > 0) {
      deadlineMs = deadlineMs > 0 ? Math.min(deadlineMs, task.siblingTimeoutRemainingMs) : task.siblingTimeoutRemainingMs;
      task.siblingTimeoutRemainingMs = 0;
    }
    if (task && task.replacementDeadlineAt > 0) {
      var repRem = Math.max(1, task.replacementDeadlineAt - Date.now());
      task.replacementDeadlineAt = 0;
      deadlineMs = deadlineMs > 0 ? Math.min(deadlineMs, repRem) : repRem;
    }
    return deadlineMs;
  }

  function getTaskAttemptTimeout(task, settings) {
    settings = getSettings(settings);
    var timeout = (settings && settings.imageTimeout) || 15000;
    if (task && isHighFanoutTask(task)) {
      timeout = ATPLoadPolicy.getHeavyImageTimeout(settings);
    } else if (task && !task.readyImageQueue && isLargeLaneTask(task)) {
      timeout = ATPLoadPolicy.getLargeImageTimeout(settings);
    } else {
      timeout = ATPLoadPolicy.getReadyImageAttemptTimeout(settings);
    }
    if (task && task.taskDeadlineAt) {
      var remaining = Math.max(1, task.taskDeadlineAt - Date.now());
      timeout = Math.min(timeout, remaining);
    }
    return timeout;
  }

  function claimSlot(task, settings) {
    settings = getSettings(settings);
    if (task && task.slotActive) {
      releaseSlot(task, task.activeSlotToken);
    }
    var token = ++nextSlotToken;
    var now = Date.now();
    var attrs = computeSlotAttributes(task, undefined, settings);
    var rec = {
      slotToken: token,
      epoch: slotEpoch,
      task: task || null,
      host: attrs.host,
      isHeavyChannel: attrs.isHeavyChannel,
      isLarge: attrs.isLarge,
      isPriority: attrs.isPriority,
      isProbe: attrs.isProbe,
      isManualRetry: attrs.isManualRetry,
      counted: false
    };
    activeSlotRecords.set(token, rec);
    addSlotRecordCounts(rec);

    if (task) {
      if (!task.createdAt) task.createdAt = task.queuedAt || now;
      task.queueWaitMs = task.queuedAt ? Math.max(0, now - task.queuedAt) : 0;
      task.slotActive = true;
      task.slotCounted = true;
      task.slotEpoch = slotEpoch;
      task.activeSlotToken = token;
      task.highFanoutSlot = rec.isHeavyChannel;
      task.loadStartAt = now;
      if (task.attachmentOriginalCandidate && !task.siblingHostTried) {
        task.siblingHostTried = true;
      }
      if (!task.taskDeadlineAt) {
        var deadlineMs = computeTaskDeadlineMs(task, settings);
        task.taskDeadlineAt = deadlineMs > 0 ? now + deadlineMs : 0;
        task.taskDeadlineMs = deadlineMs;
        task.timeoutGraceTried = false;
      }
      var currentSrc = getTaskImageSrc(task);
      task.noReferrerFallbackTried = false;
      task.currentSrcStartedAt = now;
      task.currentSrcKey = getImageUrlKey(currentSrc);
      task.currentSrcNoReferrerTried = false;
      task.noReferrerFallbackSrcKey = '';
      stampTaskHostHealthEpoch(task, currentSrc);
    }
    return token;
  }

  function updateSlotTask(task, nextSrc, settings) {
    if (!task || !task.slotActive) return;
    var rec = activeSlotRecords.get(task.activeSlotToken);
    if (!rec || rec.task !== task || rec.epoch !== slotEpoch) return;
    var wasCounted = rec.counted;
    if (wasCounted) removeSlotRecordCounts(rec);
    var attrs = computeSlotAttributes(task, nextSrc, getSettings(settings));
    rec.host = attrs.host;
    rec.isHeavyChannel = attrs.isHeavyChannel;
    rec.isLarge = attrs.isLarge;
    rec.isPriority = attrs.isPriority;
    rec.isProbe = attrs.isProbe;
    rec.isManualRetry = attrs.isManualRetry;
    task.highFanoutSlot = rec.isHeavyChannel;
    if (wasCounted && task.slotCounted !== false) addSlotRecordCounts(rec);
  }

  function clearTaskSlotFields(task) {
    if (!task) return;
    task.highFanoutSlot = false;
    task.slotActive = false;
    task.slotCounted = false;
    task.slotEpoch = null;
    task.activeSlotToken = null;
  }

  function releaseSlot(task, slotToken) {
    if (task && task.slotActive) {
      var currentToken = task.activeSlotToken;
      if (slotToken !== undefined && slotToken !== null && currentToken !== slotToken) return false;
      var rec = activeSlotRecords.get(currentToken);
      var sameEpoch = task.slotEpoch === slotEpoch;
      var wasCounted = !!(rec && rec.counted && task.slotCounted !== false);
      if (rec) {
        removeSlotRecordCounts(rec);
        activeSlotRecords.delete(currentToken);
      }
      clearTaskSlotFields(task);
      return sameEpoch && wasCounted;
    }
    if (!task && slotToken !== undefined && slotToken !== null) {
      var tokenRec = activeSlotRecords.get(slotToken);
      if (tokenRec) {
        var tokenCounted = tokenRec.counted;
        removeSlotRecordCounts(tokenRec);
        activeSlotRecords.delete(slotToken);
        if (tokenRec.task) clearTaskSlotFields(tokenRec.task);
        return tokenCounted;
      }
    }
    if (!task && globalActive > 0) {
      globalActive--;
      return true;
    }
    return false;
  }

  function isSlotCurrent(task, slotToken) {
    if (!task || !task.slotActive || task.slotEpoch !== slotEpoch) return false;
    var token = task.activeSlotToken;
    if (slotToken !== undefined && slotToken !== null && token !== slotToken) return false;
    var rec = activeSlotRecords.get(token);
    return !!(rec && rec.task === task);
  }

  function resetAllCounters() {
    globalActive = 0;
    globalHighFanoutActive = 0;
    perHostActive = Object.create(null);
    perHostPriorityActive = Object.create(null);
    perHostLargeActive = Object.create(null);
    perHostLargePriorityActive = Object.create(null);
    perHostProbeActive = Object.create(null);
    perHostManualRetryActive = Object.create(null);
    perHostSlotSets = Object.create(null);
  }

  function resetSlots() {
    slotEpoch++;
    activeSlotRecords.forEach(function (rec) {
      rec.counted = false;
      if (rec.task && rec.task.activeSlotToken === rec.slotToken) {
        clearTaskSlotFields(rec.task);
      }
    });
    activeSlotRecords.clear();
    resetAllCounters();
  }

  function suspendSlotsForBfcache() {
    if (!globalActive && !globalHighFanoutActive && !activeSlotRecords.size) return 0;
    var suspended = 0;
    activeSlotRecords.forEach(function (rec) {
      if (rec.counted) suspended++;
      rec.counted = false;
      if (rec.task && rec.task.activeSlotToken === rec.slotToken) {
        rec.task.slotCounted = false;
      }
    });
    resetAllCounters();
    return suspended;
  }

  function restoreSlotsFromBfcache(settings) {
    var restored = 0;
    settings = getSettings(settings);
    activeSlotRecords.forEach(function (rec) {
      var task = rec.task;
      if (
        task &&
        task.slotActive &&
        task.slotCounted === false &&
        task.slotEpoch === slotEpoch &&
        task.activeSlotToken === rec.slotToken
      ) {
        task.slotCounted = true;
        var attrs = computeSlotAttributes(task, undefined, settings);
        rec.host = attrs.host;
        rec.isHeavyChannel = attrs.isHeavyChannel;
        rec.isLarge = attrs.isLarge;
        rec.isPriority = attrs.isPriority;
        rec.isProbe = attrs.isProbe;
        rec.isManualRetry = attrs.isManualRetry;
        task.highFanoutSlot = rec.isHeavyChannel;
        addSlotRecordCounts(rec);
        restored++;
      }
    });
    return restored;
  }

  function releaseSlotsWhere(predicate) {
    var released = 0;
    var tokens = [];
    activeSlotRecords.forEach(function (rec, token) {
      if (predicate(rec.task, token)) tokens.push(token);
    });
    for (var i = 0; i < tokens.length; i++) {
      var rec = activeSlotRecords.get(tokens[i]);
      if (rec && releaseSlot(rec.task, tokens[i])) released++;
    }
    return released;
  }

  function getActiveAfterReleaseFields(task, slotToken) {
    var activeDelta = 0;
    var heavyDelta = 0;
    if (task && isSlotCurrent(task, slotToken) && task.slotCounted !== false) {
      var rec = activeSlotRecords.get(task.activeSlotToken);
      if (rec && rec.counted) {
        activeDelta = 1;
        heavyDelta = rec.isHeavyChannel ? 1 : 0;
      }
    }
    var nextActive = Math.max(0, globalActive - activeDelta);
    var nextHeavy = Math.max(0, globalHighFanoutActive - heavyDelta);
    return {
      activeAfterRelease: nextActive,
      ordinaryActiveAfterRelease: Math.max(0, nextActive - nextHeavy),
      heavyActiveAfterRelease: nextHeavy
    };
  }

  function getOrdinaryHostActiveTopFields() {
    var topHost = '';
    var topCount = 0;
    for (var host in perHostActive) {
      if (SharedUtils && SharedUtils.isHeavyImageHost && SharedUtils.isHeavyImageHost(host)) continue;
      var count = perHostActive[host] || 0;
      if (count > topCount) {
        topCount = count;
        topHost = host;
      }
    }
    if (!topHost) return {};
    return {
      ordinaryHostActiveTop: topHost,
      ordinaryHostActiveTopCount: topCount
    };
  }

  // --- Host Health Epoch Tracking ---

  function advanceHostHealthEpoch(stats) {
    if (!stats) return 0;
    stats.failureEpoch = (stats.failureEpoch || 0) + 1;
    return stats.failureEpoch;
  }

  function getHostHealthEpochForUrl(url) {
    var host = getUrlHost(url);
    if (!host) return 0;
    var heavy = isHighFanoutImageHost(url);
    var stats = heavy ? getHeavyHostStats(host, true) : getOrdinaryHostStats(host, true);
    if (!heavy) recoverExpiredOrdinaryHostCooldown(stats, Date.now(), getSettings());
    return stats ? (stats.failureEpoch || 0) : 0;
  }

  function stampTaskHostHealthEpoch(task, url) {
    if (!task) return;
    var host = getUrlHost(url);
    task.currentHostHealthHost = host;
    task.currentHostHealthEpoch = getHostHealthEpochForUrl(url);
    var laneStats = isHighFanoutImageHost(url) ? null : getOrdinaryHostStats(host, false);
    task.largeLaneEpoch = laneStats ? (laneStats.largeLaneEpoch || 0) : 0;
  }

  function getTaskStampedHostHealthEpoch(task, url) {
    if (!task) return null;
    var host = getUrlHost(url);
    if (!host || task.currentHostHealthHost !== host) return null;
    var epoch = Number(task.currentHostHealthEpoch);
    return isFinite(epoch) ? epoch : null;
  }

  function isStaleHostFailure(task, url, stats) {
    if (!task || !stats) return false;
    var stamped = getTaskStampedHostHealthEpoch(task, url);
    return stamped !== null && stamped < Number(stats.failureEpoch || 0);
  }

  // --- Heavy Host Circuit Breaker ---

  function getHeavyHostStats(host, create) {
    if (!host) return null;
    host = String(host).toLowerCase();
    var stats = heavyHostStatsMap[host];
    if (!stats && create) {
      stats = heavyHostStatsMap[host] = {
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
    return stats || null;
  }

  function getHeavyHostCooldownRemaining(stats, now) {
    if (!stats || !stats.cooldownUntil) return 0;
    return Math.max(0, stats.cooldownUntil - (now || Date.now()));
  }

  function pruneHeavyHostFailures(stats, settings, now) {
    if (!stats) return 0;
    var times = stats.failureTimes || [];
    if (!times.length && !stats.failures) return 0;
    now = now || Date.now();
    var cutoff = now - ATPLoadPolicy.getHeavyFailureWindow(settings);
    var writeIdx = 0;
    for (var i = 0; i < times.length; i++) {
      if (times[i] >= cutoff) times[writeIdx++] = times[i];
    }
    times.length = writeIdx;
    stats.failures = writeIdx;
    if (!writeIdx && stats.lastFailureAt < cutoff) stats.consecutiveFailures = 0;
    return writeIdx;
  }

  function setHeavyHostState(host, stats, nextState, reason, settings) {
    if (!stats || stats.state === nextState) return false;
    var previousState = stats.state || 'warmup';
    stats.state = nextState;
    stats.stateEpoch = (stats.stateEpoch || 0) + 1;
    if (typeof Logger !== 'undefined' && Logger && Logger.event) {
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
    settings = getSettings(settings);
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

  function getHeavyImageConcurrency(settings) {
    settings = getSettings(settings);
    if (!isHeavyImageOptimizationEnabled(settings)) return 0;
    return ATPLoadPolicy.getHeavyConcurrencyCeiling(settings);
  }

  function getOrdinaryImageSlotLimit(ordinaryLimit) {
    return Math.max(1, Number(ordinaryLimit) || 1);
  }

  function getHighFanoutSlotLimit(settings, hasOrdinaryWork) {
    settings = getSettings(settings);
    var maxSlots = getHeavyImageConcurrency(settings);
    if (maxSlots <= 0) return 0;
    if (!hasOrdinaryWork) return maxSlots;
    var ordinaryLimit = getOrdinaryImageSlotLimit(settings.firstScreenConcurrency || 3);
    var totalLimit = ATPLoadPolicy.getGlobalImageConcurrency(settings, ordinaryLimit, maxSlots);
    var activeOrdinary = Math.max(0, globalActive - globalHighFanoutActive);
    var remainingReserved = Math.max(0, ATPLoadPolicy.getOrdinaryReservedSlots(settings) - activeOrdinary);
    return Math.max(0, Math.min(maxSlots, totalLimit - remainingReserved));
  }

  function getHeavyHostHealthSnapshot(src, settings, hasOrdinaryWork, task) {
    if (!src || !isHighFanoutImageHost(src)) return null;
    var host = getUrlHost(src);
    settings = getSettings(settings);
    var stats = getHeavyHostStats(host, true);
    var now = Date.now();
    var baseLimit = getHighFanoutSlotLimit(settings, hasOrdinaryWork);
    var adaptiveLimit = getHeavyHostAdaptiveLimit(host, stats, settings);
    var visibleProbe = !!(task && isTaskPriority(task) && stats.state === 'open');
    if (visibleProbe) {
      adaptiveLimit = Math.max(adaptiveLimit, ATPLoadPolicy.getHeavyProbeConcurrency(settings));
    }
    var cooldownRemaining = getHeavyHostCooldownRemaining(stats, now);
    var effectiveLimit = Math.max(0, Math.min(baseLimit, adaptiveLimit));
    syncHostPriorityIfMutated(host);
    var hostActive = perHostActive[host] || 0;
    var hostPriorityActive = perHostPriorityActive[host] || 0;
    var hostProbeActive = perHostProbeActive[host] || 0;
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
      heavyHostProbeActive: hostProbeActive,
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
    return getHeavyHostHealthSnapshot(src, settings, hasOrdinaryWork, task) || {};
  }

  function getEffectiveHighFanoutSlotLimit(task, settings, hasOrdinaryWork) {
    var snapshot = getHeavyHostHealthSnapshot(getTaskImageSrc(task), settings, hasOrdinaryWork, task);
    return snapshot ? snapshot.heavyHostLimit : getHighFanoutSlotLimit(settings, hasOrdinaryWork);
  }

  function getHeavyHostHealthSummaryFields(settings, hasOrdinaryWork) {
    var now = Date.now();
    var bestHost = '';
    var bestScore = -1;
    for (var host in heavyHostStatsMap) {
      var stats = heavyHostStatsMap[host];
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

  function clearWakeTimers() {
    for (var host in heavyHostWakeTimers) {
      var entry = heavyHostWakeTimers[host];
      if (entry && entry.timer) clearTimeout(entry.timer);
    }
    heavyHostWakeTimers = Object.create(null);
  }

  function scheduleHeavyHostWake(host, delayMs) {
    if (!host) return;
    host = String(host).toLowerCase();
    var delay = Math.max(50, Number(delayMs) || 0) + 10;
    var dueAt = Date.now() + delay;
    var existing = heavyHostWakeTimers[host];
    if (existing && existing.dueAt <= dueAt) return;
    if (existing && existing.timer) clearTimeout(existing.timer);
    heavyHostWakeTimers[host] = {
      dueAt: dueAt,
      timer: setTimeout(function () {
        delete heavyHostWakeTimers[host];
        var stats = getHeavyHostStats(host, false);
        if (stats) refreshHeavyHostState(host, stats, getSettings());
        if (typeof wakeCallback === 'function') wakeCallback(host, 'cooldown_elapsed');
      }, delay)
    };
  }

  function recordHeavyHostFailure(url, reason, task) {
    if (!isHighFanoutImageHost(url)) return false;
    var host = getUrlHost(url);
    var stats = getHeavyHostStats(host, true);
    var settings = getSettings();
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

    if (wasHalfOpen || stats.failures >= ATPLoadPolicy.getHeavyFailureThreshold(settings)) {
      stats.cooldownCount = (stats.cooldownCount || 0) + 1;
      var baseCooldown = ATPLoadPolicy.getHeavyCooldownBase(settings);
      var maxCooldown = ATPLoadPolicy.getHeavyCooldownMax(settings);
      var multiplier = Math.pow(2, Math.max(0, stats.cooldownCount - 1));
      var cooldownMs = Math.min(maxCooldown, baseCooldown * multiplier);
      stats.cooldownUntil = now + cooldownMs;
      stats.adaptiveLimit = ATPLoadPolicy.getHeavyProbeConcurrency(settings);
      setHeavyHostState(host, stats, 'open', wasHalfOpen ? 'probe_failed' : 'failure_threshold', settings);
      scheduleHeavyHostWake(host, cooldownMs);
    }
    return true;
  }

  function recordHeavyHostSuccess(url) {
    if (!isHighFanoutImageHost(url)) return false;
    var host = getUrlHost(url);
    var stats = getHeavyHostStats(host, true);
    var settings = getSettings();
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
      stats.consecutiveSuccesses = 0;
      advanceHostHealthEpoch(stats);
      var fixedMode = ATPLoadPolicy.getHeavySchedulingMode(settings) === 'fixed';
      stats.adaptiveLimit = fixedMode
        ? ATPLoadPolicy.getHeavyConcurrencyCeiling(settings)
        : ATPLoadPolicy.getHeavyWarmupConcurrency(settings);
      setHeavyHostState(host, stats, fixedMode ? 'fixed' : 'warmup', 'probe_recovered', settings);
      if (typeof wakeCallback === 'function') wakeCallback(host, 'probe_recovered');
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

  // --- Ordinary Host Adaptive Health & Animated GIF Large-Lane ---

  function getOrdinaryHostStats(host, create) {
    if (!host) return null;
    host = String(host).toLowerCase();
    var stats = ordinaryHostStatsMap[host];
    if (!stats && create) {
      stats = ordinaryHostStatsMap[host] = {
        failures: 0,
        successes: 0,
        consecutiveSuccesses: 0,
        failureEpoch: 0,
        cooldownUntil: 0,
        cooldownCount: 0,
        lastFailureAt: 0,
        lastSuccessAt: 0,
        lastReason: '',
        largeLaneLimit: 0,
        largeLaneEpoch: 0
      };
    }
    return stats || null;
  }

  function getOrdinaryHostActiveCounts(host) {
    if (!host) return { active: 0, priorityActive: 0, largeActive: 0, largePriorityActive: 0 };
    host = String(host).toLowerCase();
    syncHostPriorityIfMutated(host);
    return {
      active: perHostActive[host] || 0,
      priorityActive: perHostPriorityActive[host] || 0,
      largeActive: perHostLargeActive[host] || 0,
      largePriorityActive: perHostLargePriorityActive[host] || 0
    };
  }

  function getLargeLaneCeiling(settings, base, ordinaryConc) {
    var laneHostLimit = ATPLoadPolicy.getOrdinaryHostConcurrency(settings);
    var conc = ordinaryConc || (settings && settings.firstScreenConcurrency) || 3;
    var hostLimit = Math.min(laneHostLimit, getOrdinaryImageSlotLimit(conc));
    return Math.max(base, Math.min(Math.floor(laneHostLimit / 2), hostLimit - 1));
  }

  function getAdaptiveLargeLaneLimit(stats, settings, ordinaryConc) {
    var base = Math.max(1, ATPLoadPolicy.getLargeImageHostConcurrency(settings));
    if (!ATPLoadPolicy.isOrdinaryHostAdaptive(settings)) return base;
    if (!stats || !(stats.largeLaneLimit > base)) return base;
    return Math.min(stats.largeLaneLimit, getLargeLaneCeiling(settings, base, ordinaryConc));
  }

  function noteLargeLaneOutcome(task, url, elapsedMs, timedOut, ordinaryConc) {
    if (!task || task.readyImageQueue || task.manualRetry || !url || isHighFanoutImageHost(url)) return false;
    var settings = getSettings();
    if (!ATPLoadPolicy.isOrdinaryHostAdaptive(settings)) return false;
    var host = getUrlHost(url);
    if (!host) return false;
    var stats = getOrdinaryHostStats(host, true);
    if ((task.largeLaneEpoch || 0) !== (stats.largeLaneEpoch || 0)) return false;
    var base = Math.max(1, ATPLoadPolicy.getLargeImageHostConcurrency(settings));
    var current = getAdaptiveLargeLaneLimit(stats, settings, ordinaryConc);
    var next = current;
    if (timedOut || elapsedMs > ATPLoadPolicy.getLargeImageSlowMs(settings)) {
      if (current <= base) return false;
      next = Math.max(base, Math.floor(current / 2));
      stats.largeLaneEpoch = (stats.largeLaneEpoch || 0) + 1;
    } else if (isLargeLaneTask(task) && elapsedMs <= ATPLoadPolicy.getLargeImageFastMs(settings)) {
      var ceiling = getLargeLaneCeiling(settings, base, ordinaryConc);
      if (current < ceiling && (perHostLargeActive[host] || 0) + 1 >= current) {
        next = current + 1;
      }
    }
    if (next === current) return false;
    stats.largeLaneLimit = next;
    if (typeof Logger !== 'undefined' && Logger && Logger.event) {
      Logger.event('ordinary_large_lane_window', {
        host: host,
        from: current,
        to: next,
        reason: next > current ? 'fast' : (timedOut ? 'timeout' : 'slow')
      });
    }
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
    var failures = (stats && stats.failures) || 0;
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

  function noteOrdinaryHostTimeout(stats, url, now, settings) {
    var key = getImageUrlKey(url);
    if (!key) return;
    var recent = (stats.recentTimeouts || []).filter(function (entry) {
      return now - entry.at < ORDINARY_TIMEOUT_WINDOW_MS && entry.key !== key;
    });
    recent.push({ key: key, at: now });
    stats.recentTimeouts = recent.slice(-2);
    if (recent.length >= 2) {
      stats.timeoutLimit = Math.min(2, ATPLoadPolicy.getOrdinaryHostSoftLimit(settings));
    }
  }

  function recoverOrdinaryTimeoutLimit(stats, ceiling, settings, elapsedMs) {
    if (!stats.timeoutLimit || (elapsedMs !== undefined && elapsedMs < 50)) return;
    stats.timeoutRecoverySuccesses = (stats.timeoutRecoverySuccesses || 0) + 1;
    if (stats.timeoutRecoverySuccesses < ATPLoadPolicy.getOrdinaryHostRecoverySuccesses(settings)) return;
    stats.timeoutLimit++;
    if (stats.timeoutLimit >= ceiling) stats.timeoutLimit = 0;
    stats.timeoutRecoverySuccesses = 0;
    stats.recentTimeouts = [];
  }

  function recordReadyGifOutcome(stats, url, elapsedMs, settings, failure) {
    if (!ATPLoadPolicy.isOrdinaryHostAdaptive(settings)) return;
    var gif = stats.readyGif || (stats.readyGif = { failures: 0 });
    recordOrdinaryHostOutcome(gif, !!failure, settings);
    if (!failure) {
      gif.failures = Math.max(0, gif.failures - 1);
      recoverOrdinaryTimeoutLimit(gif, Math.ceil(ATPLoadPolicy.getOrdinaryHostConcurrency(settings) / 2), settings, elapsedMs);
      return;
    }
    gif.failures++;
    gif.timeoutRecoverySuccesses = 0;
    if (failure === 'deadline_exhausted' || failure === 'candidate_timeout') {
      noteOrdinaryHostTimeout(gif, url, Date.now(), settings);
    }
    if (getOrdinaryHostFailurePressure(gif, settings).soft) {
      gif.timeoutLimit = Math.min(gif.timeoutLimit || 2, 2, ATPLoadPolicy.getOrdinaryHostSoftLimit(settings));
    }
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
    return Math.max(0, stats.cooldownUntil - (now || Date.now()));
  }

  function getOrdinaryHostHealthSnapshot(src, totalLimit) {
    if (!src || isHighFanoutImageHost(src)) return null;
    var host = getUrlHost(src);
    if (!host) return null;
    var settings = getSettings();
    var stats = getOrdinaryHostStats(host, false) || {};
    var now = Date.now();
    recoverExpiredOrdinaryHostCooldown(stats, now, settings);
    var configuredLimit = ATPLoadPolicy.getOrdinaryHostConcurrency(settings);
    var baseLimit = Math.max(1, Math.min(Number(totalLimit) || configuredLimit, configuredLimit));
    var adaptive = ATPLoadPolicy.isOrdinaryHostAdaptive(settings);
    var cooldownRemaining = adaptive ? getOrdinaryHostCooldownRemaining(stats, now) : 0;
    var failures = stats.failures || 0;
    var pressure = getOrdinaryHostFailurePressure(stats, settings);
    var pageHost = '';
    try {
      pageHost = (root.location && root.location.hostname ? String(root.location.hostname).toLowerCase() : '');
    } catch (e) {}
    var sameOriginArticleBusy = !!(pageHost && host === pageHost &&
      root.ATPArticleWork && typeof root.ATPArticleWork.isBusy === 'function' && root.ATPArticleWork.isBusy());
    var ceiling = sameOriginArticleBusy ? Math.min(configuredLimit, 4) : configuredLimit;
    var effectiveLimit = Math.min(baseLimit, ceiling);
    var timeoutLimit = 0;
    if (adaptive) {
      if (pressure.hard || cooldownRemaining > 0) {
        effectiveLimit = Math.min(effectiveLimit, ATPLoadPolicy.getOrdinaryHostHardLimit(settings));
      } else if (pressure.soft) {
        effectiveLimit = Math.min(effectiveLimit, ATPLoadPolicy.getOrdinaryHostSoftLimit(settings));
      }
      timeoutLimit = stats.timeoutLimit || 0;
      if (timeoutLimit) effectiveLimit = Math.min(effectiveLimit, timeoutLimit);
    }
    var counts = getOrdinaryHostActiveCounts(host);
    return {
      ordinaryHost: host,
      ordinaryHostActive: counts.active,
      ordinaryHostPriorityActive: counts.priorityActive,
      ordinaryHostLimit: effectiveLimit,
      ordinaryHostTimeoutLimit: timeoutLimit || undefined,
      ordinaryHostGifLimit: adaptive && stats.readyGif ? stats.readyGif.timeoutLimit || undefined : undefined,
      ordinaryHostBaseLimit: baseLimit,
      ordinaryHostCeiling: ceiling,
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
      ordinaryHostLargeLimit: Math.max(1, Math.min(getAdaptiveLargeLaneLimit(stats, settings, totalLimit), effectiveLimit - 1))
    };
  }

  function recordOrdinaryHostFailure(url, reason, task) {
    if (!url || isHighFanoutImageHost(url)) return false;
    var host = getUrlHost(url);
    if (!host) return false;
    var stats = getOrdinaryHostStats(host, true);
    var now = Date.now();
    var settings = getSettings();
    recoverExpiredOrdinaryHostCooldown(stats, now, settings);
    if (isStaleHostFailure(task, url, stats)) return true;

    if (task && task.readyImageQueue && isLargeLaneTask(task)) {
      recordReadyGifOutcome(stats, url, 0, settings, reason || 'image_fail');
      return true;
    }

    var wasCooling = getOrdinaryHostCooldownRemaining(stats, now) > 0;
    stats.failures = (stats.failures || 0) + 1;
    stats.consecutiveSuccesses = 0;
    stats.timeoutRecoverySuccesses = 0;
    stats.lastFailureAt = now;
    stats.lastReason = reason || 'image_fail';
    recordOrdinaryHostOutcome(stats, true, settings);

    // When ordinaryHostAdaptive === false, zero hidden circuit breaker or degradation!
    if (!ATPLoadPolicy.isOrdinaryHostAdaptive(settings)) return true;

    if (reason === 'deadline_exhausted' || reason === 'candidate_timeout') {
      noteOrdinaryHostTimeout(stats, url, now, settings);
    }
    var pressure = getOrdinaryHostFailurePressure(stats, settings);
    if (pressure.hard && !wasCooling) {
      var cooldownMs = ATPLoadPolicy.getOrdinaryHostCooldown(settings);
      if (cooldownMs > 0) {
        stats.cooldownUntil = now + cooldownMs;
        stats.cooldownCount = (stats.cooldownCount || 0) + 1;
      }
    }
    return true;
  }

  function recordOrdinaryHostSuccess(url, task, elapsedMs) {
    if (!url || isHighFanoutImageHost(url)) return false;
    var host = getUrlHost(url);
    if (!host) return false;
    var stats = getOrdinaryHostStats(host, true);
    var settings = getSettings();
    var ageMs = elapsedMs !== undefined
      ? elapsedMs
      : (task && task.currentSrcStartedAt ? Math.max(0, Date.now() - task.currentSrcStartedAt) : 100);
    if (task && task.readyImageQueue && isLargeLaneTask(task)) {
      recordReadyGifOutcome(stats, url, ageMs, settings, '');
      return true;
    }
    recordOrdinaryHostOutcome(stats, false, settings);
    stats.successes = (stats.successes || 0) + 1;
    stats.consecutiveSuccesses = (stats.consecutiveSuccesses || 0) + 1;
    stats.lastSuccessAt = Date.now();
    if (stats.failures > 0) stats.failures--;
    var recoverySuccesses = ATPLoadPolicy.getOrdinaryHostRecoverySuccesses(settings);
    if (ATPLoadPolicy.isOrdinaryHostAdaptive(settings)) {
      recoverOrdinaryTimeoutLimit(stats, ATPLoadPolicy.getOrdinaryHostConcurrency(settings), settings, ageMs);
    }
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

  // --- Attachment Sibling-Host Failover (ATTACHMENT_HOSTS) ---

  function getAttachmentFamily(url) {
    if (!url || isHighFanoutImageHost(url)) return null;
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    var match = ATTACHMENT_PATH_RE.exec(parsed.pathname);
    if (!match) return null;
    var host = parsed.hostname.toLowerCase();
    var store = FORUM_ATTACHMENT_HOSTS.has(host) ? 'forum-attachments' : '';
    if (!store && typeof SharedUtils !== 'undefined' && SharedUtils && SharedUtils.getForumSiteZone) {
      var zone = SharedUtils.getForumSiteZone(host);
      if (zone && SharedUtils.getSupportedForumRoot) {
        store = zone + '|' + host.slice(0, -SharedUtils.getSupportedForumRoot(host).length);
      }
    }
    if (!store) return null;
    return { key: store + '|' + parsed.port + '|' + match[1], host: host };
  }

  function getAttachmentHostStats(family, create) {
    if (!family) return null;
    var hosts = ATTACHMENT_HOSTS[family.key];
    if (!hosts) {
      if (!create) return null;
      hosts = ATTACHMENT_HOSTS[family.key] = Object.create(null);
    }
    if (!hosts[family.host] && create) {
      hosts[family.host] = { ok: 0, lastOkAt: 0, unavailableAt: null, failures: null };
    }
    return hosts[family.host] || null;
  }

  function isDeadAttachmentHost(family) {
    var stats = getAttachmentHostStats(family, false);
    var now = Date.now();
    return !!(stats && stats.unavailableAt !== null && now >= stats.unavailableAt &&
      now - stats.unavailableAt < ATTACHMENT_SIBLING_MAX_AGE_MS);
  }

  function noteAttachmentHostSuccess(url) {
    if (!url || url.indexOf('?') !== -1) return;
    var family = getAttachmentFamily(url);
    if (!family) return;
    var stats = getAttachmentHostStats(family, true);
    var now = Date.now();
    if (now - stats.lastOkAt > ATTACHMENT_SIBLING_MAX_AGE_MS || now < stats.lastOkAt) stats.ok = 0;
    stats.ok = Math.min(2, stats.ok + 1);
    stats.lastOkAt = now;
    stats.unavailableAt = null;
    stats.failures = null;
  }

  function noteAttachmentHostFailure(url) {
    if (!url || url.indexOf('?') !== -1 || url.indexOf('/forum/') === -1) return;
    var family = getAttachmentFamily(url);
    if (!family) return;
    var stats = getAttachmentHostStats(family, true);
    var now = Date.now();
    if (isDeadAttachmentHost(family)) return;
    if (!stats.failures) stats.failures = new Map();
    stats.failures.forEach(function (at, key) {
      if (now < at || now - at > ORDINARY_TIMEOUT_WINDOW_MS) stats.failures.delete(key);
    });
    stats.failures.set(getImageUrlKey(url), now);
    if (stats.failures.size >= ATTACHMENT_DEAD_THRESHOLD) {
      stats.unavailableAt = now;
      stats.failures = null;
    }
  }

  function getCandidateAttachmentFamily(candidate) {
    if (!candidate) return null;
    var src = getCandidateDisplaySrc(candidate);
    if (!src || src.indexOf('/forum/') === -1) return null;
    var urls = [candidate.src, candidate.displaySrc, candidate.previewSrc];
    for (var i = 0; i < urls.length; i++) {
      if (urls[i] && urls[i].indexOf('?') !== -1) return null;
    }
    return getAttachmentFamily(src);
  }

  function pickSiblingAttachmentHost(family, preferredHost) {
    if (!family) return '';
    var hosts = ATTACHMENT_HOSTS[family.key];
    if (!hosts) return '';
    var now = Date.now();
    var best = '';
    var bestAt = 0;
    for (var host in hosts) {
      if (host === family.host) continue;
      var stats = hosts[host];
      if (stats.ok < 2 || now < stats.lastOkAt || now - stats.lastOkAt > ATTACHMENT_SIBLING_MAX_AGE_MS ||
          isDeadAttachmentHost({ key: family.key, host: host })) continue;
      var health = getOrdinaryHostStats(host, false);
      if (health && health.cooldownUntil && health.cooldownUntil > now) continue;
      if (host === preferredHost) return host;
      if (best && stats.lastOkAt <= bestAt) continue;
      best = host;
      bestAt = stats.lastOkAt;
    }
    return best;
  }

  function withAttachmentHost(candidate, family, toHost) {
    var out = Object.assign({}, candidate);
    var fields = ['src', 'displaySrc', 'previewSrc'];
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var fieldFamily = getAttachmentFamily(out[field]);
      if (!fieldFamily || fieldFamily.host !== family.host || fieldFamily.key !== family.key) continue;
      var parsed = new URL(out[field]);
      parsed.hostname = toHost;
      out[field] = parsed.href;
    }
    out.siblingHostFrom = family.host;
    return out;
  }

  function moveTaskToSiblingHost(task, family, sibling, onBeforeFirstSwap) {
    var imgData = task.attachmentOriginalCandidate || getTaskImageData(task);
    if (!imgData || !task.candidates) return false;
    if (!task.attachmentOriginalCandidate && typeof onBeforeFirstSwap === 'function') {
      onBeforeFirstSwap(task, imgData);
    }
    task.attachmentOriginalCandidate = imgData;
    task.candidates[task.idx] = withAttachmentHost(imgData, family, sibling);
    return true;
  }

  function restoreOriginalAttachment(task, onRestore) {
    if (!task || !task.attachmentOriginalCandidate || !task.candidates) return false;
    task.candidates[task.idx] = task.attachmentOriginalCandidate;
    task.attachmentOriginalCandidate = null;
    if (typeof onRestore === 'function') onRestore(task);
    return true;
  }

  function prepareAttachmentHost(task, onBeforeFirstSwap, onRestore) {
    if (!task || task.manualRetry || task.siblingHostTried) return true;
    var original = task.attachmentOriginalCandidate;
    var family = getCandidateAttachmentFamily(original || getTaskImageData(task));
    var retry = task.siblingTimeoutRemainingMs > 0;
    var previousHost = original && getUrlHost(getTaskImageSrc(task));
    var sibling = family && (retry || isDeadAttachmentHost(family)) && pickSiblingAttachmentHost(family, previousHost);
    if (!sibling) {
      if (original) restoreOriginalAttachment(task, onRestore);
      return !retry;
    }
    if (sibling !== previousHost) {
      var wasFirstSkip = !original && !retry;
      moveTaskToSiblingHost(task, family, sibling, onBeforeFirstSwap);
      if (wasFirstSkip && typeof Logger !== 'undefined' && Logger && Logger.event) {
        Logger.event('image_retry', {
          host: family.host,
          siblingHost: sibling,
          reason: 'sibling_host_start'
        });
      }
    }
    return true;
  }

  // --- Unified Slot Admission Check ---

  function getTotalImageSlotLimit(settings) {
    settings = getSettings(settings);
    var ordinaryLimit = getOrdinaryImageSlotLimit(settings.firstScreenConcurrency || 3);
    var heavyLimit = getHeavyImageConcurrency(settings);
    return ATPLoadPolicy.getGlobalImageConcurrency(settings, ordinaryLimit, heavyLimit);
  }

  function getViewportPriorityReservedSlots(totalLimit, settings) {
    totalLimit = Math.max(1, Number(totalLimit) || 1);
    return Math.max(0, Math.min(
      totalLimit - 1,
      ATPLoadPolicy.getViewportPriorityReservedSlots(getSettings(settings))
    ));
  }

  function getGlobalSlotAdmissionLimit(task, totalLimit, settings) {
    totalLimit = Math.max(1, Number(totalLimit) || 1);
    settings = getSettings(settings);
    if (!task || (task.readyImageQueue && !task.offscreenAutoLoad && isTaskPriority(task)) ||
        isTaskPriority(task) || isHeavyChannelTask(task, settings)) {
      return totalLimit;
    }
    return Math.max(1, totalLimit - getViewportPriorityReservedSlots(totalLimit, settings));
  }

  function getLargeLaneCap(snapshot, visible) {
    var limit = snapshot.ordinaryHostLargeLimit;
    return visible
      ? limit + (snapshot.ordinaryHostLargePriorityActive === 0 ? 1 : 0)
      : Math.max(1, Math.min(limit - 1, Math.ceil(limit / 2)));
  }

  function getReadyGifCap(snapshot) {
    return Math.min(Math.ceil(snapshot.ordinaryHostLimit / 2), snapshot.ordinaryHostGifLimit || Infinity);
  }

  function checkTaskAdmission(task, ordinaryLimit, hasNonHighFanoutWaiting, options) {
    options = options || {};
    if (task) task.largeLaneDeferred = false;
    if (!prepareAttachmentHost(task, options.onBeforeAttachmentSwap, options.onRestoreAttachment)) {
      return { admit: true, expiredSibling: true };
    }
    if (task && task.replacementDeadlineAt > 0 && Date.now() >= task.replacementDeadlineAt) {
      task.replacementDeadlineAt = 0;
      return { admit: true, expiredReplacement: true };
    }
    var settings = getSettings(options.settings);
    var totalLimit = getTotalImageSlotLimit(settings);
    var normalizedOrdinaryLimit = getOrdinaryImageSlotLimit(ordinaryLimit);
    var src = getTaskImageSrc(task);
    var host = getUrlHost(src);

    // 1. Global slot ceiling & viewport priority reserve
    var globalAdmissionLimit = getGlobalSlotAdmissionLimit(task, totalLimit, settings);
    var visibleReserve = Math.max(0, totalLimit - globalAdmissionLimit);
    var activeOrdinary = Math.max(0, globalActive - globalHighFanoutActive);
    if (globalActive >= totalLimit || (visibleReserve > 0 && activeOrdinary >= globalAdmissionLimit)) {
      return { admit: false, reason: 'global_limit', host: host };
    }

    // 2. Manual retry per-host limit (at most 1 concurrent manual retry per host)
    if (task && task.manualRetry && host && (perHostManualRetryActive[host] || 0) > 0) {
      return { admit: false, reason: 'manual_host_limit', host: host };
    }

    // 3. Heavy channel admission & circuit breaker
    if (isHeavyChannelTask(task, settings)) {
      if (options.heavyScrollDeferred) {
        return { admit: false, reason: 'scrolling', host: host, heavy: true };
      }
      var hasOrdinaryWork = !!hasNonHighFanoutWaiting || activeOrdinary > 0;
      var healthFields = getHeavyHostHealthSnapshot(src, settings, hasOrdinaryWork, task) || {};
      var limit = healthFields.heavyHostLimit !== undefined
        ? healthFields.heavyHostLimit
        : getHighFanoutSlotLimit(settings, hasOrdinaryWork);
      var configuredHeavyLimit = getHeavyImageConcurrency(settings);
      var admissionActive = healthFields.heavyHostVisibleProbe
        ? (healthFields.heavyHostPriorityActive || 0)
        : globalHighFanoutActive;
      if (healthFields.heavyHostState === 'open') {
        scheduleHeavyHostWake(healthFields.heavyHost, healthFields.heavyHostCooldownRemainingMs);
      }
      if (globalHighFanoutActive >= configuredHeavyLimit || admissionActive >= limit) {
        return {
          admit: false,
          reason: healthFields.heavyHostState === 'open' ? 'heavy_host_open' : 'heavy_limit',
          host: host,
          heavy: true,
          hostOpen: healthFields.heavyHostState === 'open',
          snapshot: healthFields
        };
      }
      return { admit: true, host: host, heavy: true };
    }

    // 4. Ordinary host concurrency & GIF large-lane
    var snapshot = getOrdinaryHostHealthSnapshot(src, normalizedOrdinaryLimit);
    if (snapshot) {
      var hostActive = snapshot.ordinaryHostActive;
      var ceiling = snapshot.ordinaryHostCeiling;
      var hostFull = hostActive >= ceiling;
      var visible = isTaskPriority(task);
      var readyVisible = !!(task && task.readyImageQueue && !task.offscreenAutoLoad && visible);
      var reserved = (visible || readyVisible)
        ? 0
        : Math.min(Math.floor(ceiling / 2), getViewportPriorityReservedSlots(ceiling, settings));
      var ordAdmissionActive = hostActive;
      var ordAdmissionLimit = Math.min(snapshot.ordinaryHostLimit, ceiling - reserved);
      if (visible && !(task && task.readyImageQueue) && !(task && task.manualRetry) &&
          !snapshot.ordinaryHostTimeoutLimit && !hostFull && ordAdmissionLimit < ceiling) {
        ordAdmissionActive = snapshot.ordinaryHostPriorityActive;
        ordAdmissionLimit = Math.max(ordAdmissionLimit,
          Math.min(snapshot.ordinaryHostBaseLimit, ceiling, ATPLoadPolicy.getOrdinaryHostSoftLimit(settings)));
      }
      if (hostFull || ordAdmissionActive >= ordAdmissionLimit) {
        return {
          admit: false,
          reason: snapshot.ordinaryHostCooling ? 'ordinary_host_cooling' : 'ordinary_host_limit',
          host: host,
          hostFull: true,
          snapshot: snapshot
        };
      }
      if (isLargeLaneTask(task)) {
        var largeCap = (task && task.readyImageQueue)
          ? getReadyGifCap(snapshot)
          : Math.min(getLargeLaneCap(snapshot, visible), snapshot.ordinaryHostGifLimit || Infinity);
        if (snapshot.ordinaryHostLargeActive >= largeCap) {
          if (task) task.largeLaneDeferred = true;
          return {
            admit: false,
            reason: 'ordinary_large_lane',
            host: host,
            gifFull: true,
            snapshot: snapshot
          };
        }
      }
    }

    // 5. Ordinary channel concurrency limit
    var channelLimit = normalizedOrdinaryLimit;
    if (task && task.offscreenAutoLoad && !isTaskPriority(task)) {
      channelLimit = Math.min(channelLimit, ATPLoadPolicy.getOffscreenFirstRowOrdinaryLimit(settings));
    }
    if (activeOrdinary >= channelLimit) {
      return { admit: false, reason: 'ordinary_limit', host: host };
    }

    return { admit: true, host: host };
  }

  function recordDomainFailure(url, reason, task) {
    if (recordHeavyHostFailure(url, reason, task)) return;
    recordOrdinaryHostFailure(url, reason, task);
  }

  function recordDomainSuccess(url, task, elapsedMs, ordinaryConc) {
    if (recordHeavyHostSuccess(url)) return;
    recordOrdinaryHostSuccess(url, task, elapsedMs);
    noteAttachmentHostSuccess(url);
    if (task) {
      var ageMs = elapsedMs !== undefined
        ? elapsedMs
        : (task.currentSrcStartedAt ? Math.max(0, Date.now() - task.currentSrcStartedAt) : 0);
      noteLargeLaneOutcome(task, url, ageMs, false, ordinaryConc);
    }
  }

  function recordTaskImageFailure(task, url, reason, finalFailure, ordinaryConc) {
    if (isHighFanoutImageHost(url)) {
      var host = getUrlHost(url);
      var stampedEpoch = getTaskStampedHostHealthEpoch(task, url);
      var epochKey = host + '@' + (stampedEpoch === null ? getHostHealthEpochForUrl(url) : stampedEpoch);
      if (task && task.lastRecordedHeavyFailureHostEpoch === epochKey) return;
      if (task) task.lastRecordedHeavyFailureHostEpoch = epochKey;
      recordDomainFailure(url, reason, task);
      return;
    }
    if (reason === 'candidate_timeout') {
      var ageMs = task && task.currentSrcStartedAt ? Math.max(0, Date.now() - task.currentSrcStartedAt) : 0;
      noteLargeLaneOutcome(task, url, ageMs, true, ordinaryConc);
    }
    if (finalFailure) {
      var ordHost = getUrlHost(url);
      var ordStamped = getTaskStampedHostHealthEpoch(task, url);
      var ordEpochKey = ordHost + '@' + (ordStamped === null ? getHostHealthEpochForUrl(url) : ordStamped);
      if (task && task.lastRecordedOrdinaryFailureHostEpoch === ordEpochKey) return;
      if (task) task.lastRecordedOrdinaryFailureHostEpoch = ordEpochKey;
      if (task && getCandidateAttachmentFamily(getTaskImageData(task))) {
        noteAttachmentHostFailure(url);
      }
      recordDomainFailure(url, reason, task);
    }
  }

  function reconfigure(settings) {
    settings = getSettings(settings);
    clearWakeTimers();
    for (var host in heavyHostStatsMap) {
      var stats = heavyHostStatsMap[host];
      refreshHeavyHostState(host, stats, settings);
      if (stats.state === 'open') {
        scheduleHeavyHostWake(host, getHeavyHostCooldownRemaining(stats));
      }
    }
    if (!ATPLoadPolicy.isOrdinaryHostAdaptive(settings)) {
      for (var ordHost in ordinaryHostStatsMap) {
        var oStats = ordinaryHostStatsMap[ordHost];
        oStats.cooldownUntil = 0;
        oStats.timeoutLimit = 0;
        oStats.recentTimeouts = [];
        oStats.timeoutRecoverySuccesses = 0;
        oStats.readyGif = null;
      }
    }
  }

  var ATPHostHealth = {
    getUrlHost: getUrlHost,
    getImageUrlKey: getImageUrlKey,
    isHighFanoutImageHost: isHighFanoutImageHost,
    isHighFanoutTask: isHighFanoutTask,
    isHeavyChannelSrc: isHeavyChannelSrc,
    isHeavyChannelTask: isHeavyChannelTask,
    isLargeImageSrc: isLargeImageSrc,
    isLargeLaneTask: isLargeLaneTask,
    isLargeLaneBlocked: function (task, ordinaryLimit) {
      if (!task || task.manualRetry || !isLargeLaneTask(task)) return false;
      if (task.largeLaneDeferred) return true;
      var src = getTaskImageSrc(task);
      var snapshot = getOrdinaryHostHealthSnapshot(src, ordinaryLimit);
      if (!snapshot) return false;
      var visible = isTaskPriority(task);
      var cap = task.readyImageQueue
        ? getReadyGifCap(snapshot)
        : Math.min(getLargeLaneCap(snapshot, visible), snapshot.ordinaryHostGifLimit || Infinity);
      return snapshot.ordinaryHostLargeActive >= cap;
    },
    getMaxHostLargeActive: function () { return maxPerHostLargeActive; },
    resetMaxHostLargeActive: function () { maxPerHostLargeActive = 0; },
    shouldUseNoReferrerByDefault: shouldUseNoReferrerByDefault,

    // O(1) incremental active counters
    getGlobalActive: function () { return globalActive; },
    getGlobalHeavyActive: function () { return globalHighFanoutActive; },
    getGlobalOrdinaryActive: function () { return Math.max(0, globalActive - globalHighFanoutActive); },
    getHostActive: function (host) { return (host && perHostActive[String(host).toLowerCase()]) || 0; },
    getHostLargeActive: function (host) { return (host && perHostLargeActive[String(host).toLowerCase()]) || 0; },
    getHostProbeActive: function (host) { return (host && perHostProbeActive[String(host).toLowerCase()]) || 0; },
    hasManualRetryOnHost: function (host) { return !!host && (perHostManualRetryActive[String(host).toLowerCase()] || 0) > 0; },
    getOrdinaryHostActiveCounts: getOrdinaryHostActiveCounts,
    getOrdinaryHostActiveTopFields: getOrdinaryHostActiveTopFields,
    getActiveAfterReleaseFields: getActiveAfterReleaseFields,

    // Slot lifecycle
    claimSlot: claimSlot,
    releaseSlot: releaseSlot,
    updateSlotTask: updateSlotTask,
    isSlotCurrent: isSlotCurrent,
    getSlotEpoch: function () { return slotEpoch; },
    resetSlots: resetSlots,
    suspendSlotsForBfcache: suspendSlotsForBfcache,
    restoreSlotsFromBfcache: restoreSlotsFromBfcache,
    releaseSlotsWhere: releaseSlotsWhere,
    hasActiveSlots: function () { return activeSlotRecords.size > 0; },

    // Admission & timeouts
    getTotalImageSlotLimit: getTotalImageSlotLimit,
    getViewportPriorityReservedSlots: getViewportPriorityReservedSlots,
    getGlobalSlotAdmissionLimit: getGlobalSlotAdmissionLimit,
    getHighFanoutSlotLimit: getHighFanoutSlotLimit,
    getEffectiveHighFanoutSlotLimit: getEffectiveHighFanoutSlotLimit,
    getTaskAttemptTimeout: getTaskAttemptTimeout,
    computeTaskDeadlineMs: computeTaskDeadlineMs,
    checkTaskAdmission: checkTaskAdmission,

    // Health state & feedback
    stampTaskHostHealthEpoch: stampTaskHostHealthEpoch,
    getHeavyHostStats: getHeavyHostStats,
    getOrdinaryHostStats: getOrdinaryHostStats,
    getHeavyHostHealthSnapshot: getHeavyHostHealthSnapshot,
    getHeavyHostHealthLogFields: getHeavyHostHealthLogFields,
    getHeavyHostHealthSummaryFields: getHeavyHostHealthSummaryFields,
    getOrdinaryHostHealthSnapshot: getOrdinaryHostHealthSnapshot,
    getOrdinaryHostHealthLogFields: function (taskOrSrc, totalLimit) {
      var src = typeof taskOrSrc === 'string' ? taskOrSrc : getTaskImageSrc(taskOrSrc);
      return getOrdinaryHostHealthSnapshot(src, totalLimit) || {};
    },
    isTaskHostCoolingDown: function (task) {
      var src = task && getTaskImageSrc(task);
      if (!src) return false;
      var stats = getHeavyHostStats(getUrlHost(src), false);
      return getHeavyHostCooldownRemaining(stats) > 0;
    },
    noteLargeLaneOutcome: noteLargeLaneOutcome,
    recordDomainFailure: recordDomainFailure,
    recordDomainSuccess: recordDomainSuccess,
    recordTaskImageFailure: recordTaskImageFailure,
    setWakeCallback: function (fn) { wakeCallback = fn; },
    scheduleHeavyHostWake: scheduleHeavyHostWake,
    clearWakeTimers: clearWakeTimers,
    reconfigure: reconfigure,

    // Attachment sibling-host failover
    getAttachmentFamily: getAttachmentFamily,
    getCandidateAttachmentFamily: getCandidateAttachmentFamily,
    isDeadAttachmentHost: isDeadAttachmentHost,
    pickSiblingAttachmentHost: pickSiblingAttachmentHost,
    noteAttachmentHostSuccess: noteAttachmentHostSuccess,
    noteAttachmentHostFailure: noteAttachmentHostFailure,
    withAttachmentHost: withAttachmentHost,
    moveTaskToSiblingHost: moveTaskToSiblingHost,
    restoreOriginalAttachment: restoreOriginalAttachment,
    prepareAttachmentHost: prepareAttachmentHost
  };

  root.ATPHostHealth = ATPHostHealth;
  globalThis.ATPHostHealth = ATPHostHealth;
})();
