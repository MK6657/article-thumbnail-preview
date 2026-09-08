(function () {
  'use strict';

  var viewportObserver = null;
  var viewportRootStates = new Map();
  var loadingAnimationObserver = null;
  var loadingAnimationWrappers = new Set();
  var lightweightHeavyPreloadObserver = null;
  var heavyRenderObserver = null;
  var pendingWrappers = new Map();
  var heavyRenderItems = new Map();
  var heavyRestoreQueue = [];
  var heavyRestoreTimer = null;
  var heavyBudgetTimer = null;
  var actualVisiblePendingWrappers = new Set();
  var HEAVY_RENDER_MARGIN_PX = 900;
  var HEAVY_RENDER_MARGIN = HEAVY_RENDER_MARGIN_PX + 'px 0px';
  var HEAVY_LIGHTWEIGHT_PRELOAD_MARGIN_PX = 2400;
  var HEAVY_LIGHTWEIGHT_PRELOAD_VIEWPORT_MULTIPLIER = 4;
  var lightweightHeavyPreloadMarginPx = 0;
  var lightweightHeavyPreloadMargin = '';
  var lightweightPreloadObservedTotal = 0;
  var lightweightPreloadTriggeredTotal = 0;
  var pendingSlotRetryTimer = null;
  var pendingVisibleRetryTimer = null;
  var pendingBgWakeTimer = null;
  var pendingVisibleRetryCursor = 0;
  var pendingVisibleRetryEmptyScanCount = 0;
  var pendingVisibleRetryEmptyScanSize = 0;
  var pendingSlotRetryCursor = 0;
  var pendingHiddenLoadCursor = 0;
  var pendingSlotRetryCount = 0;
  var LAZY_VIEWPORT_MARGIN_PX = 200;
  var LAZY_VIEWPORT_FAST_MARGIN_PX = 1000;
  var LAZY_SCROLL_FAST_THRESHOLD_PX_MS = 0.65;
  var LAZY_SCROLL_MIN_DELTA_PX = 40;
  var lazyViewportTopMarginPx = LAZY_VIEWPORT_MARGIN_PX;
  var lazyViewportBottomMarginPx = LAZY_VIEWPORT_MARGIN_PX;
  var lazyViewportMode = 'idle';
  var lazyScrollLastY = null;
  var lazyScrollLastAt = 0;
  var lazyScrollSlowSamples = 0;
  var lazyScrollLastModeChangeAt = 0;
  var PENDING_SLOT_RETRY_SCAN_LIMIT = 12;
  var HEAVY_RESTORE_BATCH_SIZE = 1;
  var HEAVY_RESTORE_FAST_BATCH_SIZE = 2;
  var HEAVY_RESTORE_PRESSURE_BATCH_SIZE = 1;
  var HEAVY_RESTORE_BATCH_DELAY = 220; // 批间隔 320→220：毛玻璃转清晰更跟手，批大小不变故解码峰值不升
  var HEAVY_RESTORE_IDLE_KICK_DELAY = 50; // 滚动停止后首批恢复的启动延迟（原复用 420ms 滚动节奏，用户正盯着毛玻璃看）
  var HEAVY_RESTORE_VISIBLE_NEXT_DELAY = 160; // 队首仍是可见毛玻璃时的续批间隔上限
  var HEAVY_RESTORE_FAST_DELAY = 90;
  var HEAVY_RESTORE_FAST_MP = 80; // 快车道体积门槛 50→80MP：多数 imx 原图可走 90ms 快节奏
  var HEAVY_RESTORE_DEFER_RETRY_DELAY = 420;
  var HEAVY_RESTORE_RETRY_MAX = 3;
  var HEAVY_RESTORE_RETRY_MAX_DELAY = 5000;
  var HEAVY_RESTORE_WATCHDOG_DELAY = 15000;
  var HEAVY_RESTORE_ULTRA_DELAY = 900;
  var HEAVY_RESTORE_SCROLL_DELAY = 420;
  var HEAVY_RESTORE_PRESSURE_DELAY = 900;
  var HEAVY_RESTORE_SOFT_PRESSURE_DELAY = 650;
  var HEAVY_RENDER_MIN_KEEP = 2;
  var HEAVY_VISIBLE_MIN_KEEP = 1;
  var HEAVY_VISIBLE_RESTORE_MIN_KEEP = 1;
  // 可见毛玻璃进入宽限通道的最小等待：这是纯时间门槛（解码量另由 graceBudgetMP 兜住），
  // 1800/2200 会让满屏重图的第 4~5 张固定多停留近 2 秒 —— 恢复延迟的最大单项
  var HEAVY_VISIBLE_PREVIEW_MAX_WAIT_MS = 600;
  var HEAVY_VISIBLE_RESTORE_GRACE_MS = 900;
  // 「可见项基本停止卸载」的压力阀最早开启时间，与用户可调的兜底等待解耦
  var HEAVY_VISIBLE_PRESSURE_RELEASE_MIN_MS = 6000;
  var HEAVY_VISIBLE_LOCK_DELAY_MS = 1200;
  var HEAVY_VISIBLE_RESTORE_SETTLE_MS = 1400;
  var HEAVY_ULTRA_MP = 80;
  var HEAVY_UNLOAD_BATCH_SIZE = 4;
  var HEAVY_BUDGET_RECONCILE_DELAY = 120;
  var HEAVY_PREVIEW_PREWARM_ENABLED = true;
  // 毛玻璃烘焙：目标是「显示尺寸上等效 5px 高斯」，即旧的 CSS blur(5px)。
  // σ 必须按实际显示缩放比反推（不能按画布宽取固定比例——竖版缩略图时画布宽是短边，
  // 极端宽高比还会命中最小边钳位，导致强度偏离甚至各向异性）
  var HEAVY_PREVIEW_BLUR_DISPLAY_PX = 5;
  var RENDER_STATE_LOG_THROTTLE_MS = 1000;
  var lastRenderStateLogAt = 0;
  var reconcilingHeavyBudget = false;

  function clearPendingSlotRetry(data) {
    if (!data || !data.slotRetryPending) return;
    data.slotRetryPending = false;
    if (pendingSlotRetryCount > 0) pendingSlotRetryCount--;
    if (!pendingSlotRetryCount && pendingSlotRetryTimer) {
      clearTimeout(pendingSlotRetryTimer);
      pendingSlotRetryTimer = null;
    }
  }

  function markPendingSlotRetry(data) {
    if (!data || data.slotRetryPending) return;
    data.slotRetryPending = true;
    pendingSlotRetryCount++;
  }

  function getAvailableSlotCount() {
    if (!window.ATPLoader || !ATPLoader.getAvailableSlots) return 1;
    return Math.max(0, Number(ATPLoader.getAvailableSlots()) || 0);
  }

  function hasPendingSlotRetry() {
    return pendingSlotRetryCount > 0;
  }

  function scheduleVisiblePendingRetry(delay) {
    if (pendingVisibleRetryTimer) return;
    pendingVisibleRetryTimer = setTimeout(function() {
      pendingVisibleRetryTimer = null;
      if (isLoaderPaused() || shouldPausePendingRetryWhenHidden()) return;
      if (window.ATPViewport && ATPViewport.retryVisiblePending) {
        ATPViewport.retryVisiblePending();
      }
    }, Math.max(50, delay || 100));
  }

  function schedulePendingSlotRetry(delay) {
    if (pendingSlotRetryTimer) return;
    pendingSlotRetryTimer = setTimeout(function() {
      pendingSlotRetryTimer = null;
      if (!hasPendingSlotRetry()) return;
      if (isLoaderPaused()) return;
      if (window.ATPViewport && ATPViewport.retryVisiblePending) {
        ATPViewport.retryVisiblePending();
      }
      if (window.ATPViewport && ATPViewport.retryPendingSlotLoads) {
        ATPViewport.retryPendingSlotLoads();
      }
    }, Math.max(50, delay || 100));
  }

  function scheduleBgQueueWake() {
    if (pendingBgWakeTimer) return;
    pendingBgWakeTimer = setTimeout(function() {
      pendingBgWakeTimer = null;
      if (!window.ATPLoader || !ATPLoader.globalSchedule) return;
      if (ATPLoader.isPaused && ATPLoader.isPaused()) return;
      ATPLoader.globalSchedule();
    }, 0);
  }

  function isLoaderPaused() {
    return !!(window.ATPLoader && ATPLoader.isPaused && ATPLoader.isPaused());
  }

  function setLoadingAnimationState(wrapper, active) {
    if (!wrapper || !wrapper.classList) return;
    if (active) wrapper.classList.add('atp-loading-near-viewport');
    else wrapper.classList.remove('atp-loading-near-viewport');
  }

  function isActuallyVisibleForRequest(wrapper) {
    if (window.ATPLoader && ATPLoader.isWrapperVisible) return ATPLoader.isWrapperVisible(wrapper);
    return isInViewport(wrapper);
  }

  function initLoadingAnimationObserver() {
    if (loadingAnimationObserver) return;
    loadingAnimationObserver = new IntersectionObserver(function(entries) {
      for (var i = 0; i < entries.length; i++) {
        var wrapper = entries[i].target;
        var visible = document.visibilityState === 'visible' && !!entries[i].isIntersecting;
        setLoadingAnimationState(wrapper, visible);
        var wrapperData = pendingWrappers.get(wrapper);
        var task = wrapperData && wrapperData.task || wrapper.__atpLoadTask;
        if (task && window.ATPLoader && ATPLoader.updateTaskViewportPriority) {
          ATPLoader.updateTaskViewportPriority(task, wrapper, visible);
        }
        if (visible && wrapperData && !wrapperData.loaded) {
          wrapperData.actualInViewport = true;
          if (!wrapperData.actualInViewportAt) wrapperData.actualInViewportAt = Date.now();
          wrapperData.inViewport = true;
          if (!wrapperData.inViewportAt) wrapperData.inViewportAt = wrapperData.actualInViewportAt;
          actualVisiblePendingWrappers.add(wrapper);
          if (window.ATPViewport && ATPViewport.loadWrapper) ATPViewport.loadWrapper(wrapper, wrapperData, false);
        } else {
          actualVisiblePendingWrappers.delete(wrapper);
          if (wrapperData) {
            wrapperData.actualInViewport = false;
            wrapperData.actualInViewportAt = 0;
          }
        }
      }
    }, {
      root: null,
      rootMargin: '0px',
      threshold: 0
    });
  }

  function observeLoadingAnimation(wrapper) {
    if (!wrapper) return;
    initLoadingAnimationObserver();
    loadingAnimationWrappers.add(wrapper);
    // 初始动画态交给 IO 首帧回调判定（threshold 0 注册后一帧内必回调），
    // 避免在批量插入 DOM 的同一 tick 里做写后读的可见性精判（强制回流）
    setLoadingAnimationState(wrapper, false);
    loadingAnimationObserver.observe(wrapper);
  }

  function unobserveLoadingAnimation(wrapper) {
    if (!wrapper) return;
    actualVisiblePendingWrappers.delete(wrapper);
    loadingAnimationWrappers.delete(wrapper);
    if (loadingAnimationObserver) loadingAnimationObserver.unobserve(wrapper);
    setLoadingAnimationState(wrapper, false);
  }

  function syncLoadingAnimationVisibility() {
    var wrappers = loadingAnimationWrappers.values();
    var wrapper = wrappers.next();
    while (!wrapper.done) {
      setLoadingAnimationState(wrapper.value, document.visibilityState === 'visible' && isActuallyVisibleForRequest(wrapper.value));
      wrapper = wrappers.next();
    }
  }

  function resetPendingVisibleRetryEmptyScan() {
    pendingVisibleRetryEmptyScanCount = 0;
    pendingVisibleRetryEmptyScanSize = 0;
  }

  function clearPendingRetryTimers() {
    if (pendingVisibleRetryTimer) {
      clearTimeout(pendingVisibleRetryTimer);
      pendingVisibleRetryTimer = null;
    }
    if (pendingSlotRetryTimer) {
      clearTimeout(pendingSlotRetryTimer);
      pendingSlotRetryTimer = null;
    }
    if (pendingBgWakeTimer) {
      clearTimeout(pendingBgWakeTimer);
      pendingBgWakeTimer = null;
    }
    resetPendingVisibleRetryEmptyScan();
  }

  function clearHeavyRestoreTimers() {
    if (heavyRestoreTimer) {
      clearTimeout(heavyRestoreTimer);
      heavyRestoreTimer = null;
    }
    heavyRestoreTimerFireAt = 0;
    if (heavyBudgetTimer) {
      clearTimeout(heavyBudgetTimer);
      heavyBudgetTimer = null;
    }
    heavyBudgetTimerFireAt = 0;
  }

  function shouldMonitorHeavyImage(task) {
    return !!(
      window.ATPLoader &&
      ATPLoader.isHeavyChannelTask &&
      ATPLoader.isHeavyChannelTask(task)
    );
  }

  function logHeavyRender(type, data, extra, renderContext) {
    if (!window.ATPLoader || !ATPLoader.logRenderEvent || !data) return;
    if (ATPLoader.isDiagnosticLoggingEnabled && !ATPLoader.isDiagnosticLoggingEnabled('DEBUG')) return;
    var metrics = getImageMetrics(data.img);
    var naturalWidth = data.naturalWidth || metrics.naturalWidth;
    var naturalHeight = data.naturalHeight || metrics.naturalHeight;
    var renderFields = getHeavyRenderLogFields(renderContext);
    ATPLoader.logRenderEvent(type, data.task, Object.assign({
      reason: type,
      unloadedCount: renderFields.heavyUnloaded,
      restoreQueue: ATPViewport.getHeavyRestoreQueueCount(),
      naturalWidth: naturalWidth,
      naturalHeight: naturalHeight,
      decodedMP: naturalWidth && naturalHeight ? Math.round((naturalWidth * naturalHeight) / 100000) / 10 : metrics.decodedMP,
      displayWidth: metrics.displayWidth,
      displayHeight: metrics.displayHeight,
      previewReady: !!data.previewReady,
      previewActive: !!(data.wrapper && data.wrapper.classList.contains('atp-heavy-preview-active')),
      previewFallbackActive: !!(data.wrapper && data.wrapper.classList.contains('atp-heavy-preview-pending')),
      unloaded: !!data.unloaded,
      restoreLoading: !!data.restoreLoading,
      heavyThumbnailClarity: getHeavyThumbnailClarity(),
      visiblePreviewWaitMS: getVisiblePreviewWaitMS(data),
      visiblePreviewGrace: !!data.visiblePreviewGraceActive,
      visiblePreviewGraceMode: data.visiblePreviewGraceMode || ''
    }, renderFields, extra || {}));
  }

  function getImageMetrics(img) {
    if (window.ATPLoader && ATPLoader.getImageMetrics) return ATPLoader.getImageMetrics(img);
    var naturalWidth = img && img.naturalWidth ? img.naturalWidth : 0;
    var naturalHeight = img && img.naturalHeight ? img.naturalHeight : 0;
    return {
      naturalWidth: naturalWidth,
      naturalHeight: naturalHeight,
      decodedMP: naturalWidth && naturalHeight ? Math.round((naturalWidth * naturalHeight) / 100000) / 10 : 0,
      displayWidth: img && img.clientWidth ? img.clientWidth : 0,
      displayHeight: img && img.clientHeight ? img.clientHeight : 0
    };
  }

  function isHeavyScrollActive() {
    return !!(window.ATPLoader && ATPLoader.isHeavyScrollActive && ATPLoader.isHeavyScrollActive());
  }

  function getCurrentSettings() {
    return window.ATPState && window.ATPState.settings;
  }

  function getHeavyDecodedImageLimit() {
    return ATPLoadPolicy.getHeavyDecodedImageLimit(getCurrentSettings() || {});
  }

  function getHeavyRenderMinKeep() {
    var configured = getHeavyDecodedImageLimit();
    return configured > 0 ? Math.min(HEAVY_RENDER_MIN_KEEP, configured) : HEAVY_RENDER_MIN_KEEP;
  }

  function getHeavyDecodedBudgetMP() {
    return ATPLoadPolicy.getHeavyDecodedBudgetMP(getCurrentSettings() || {});
  }

  function getHeavyVisibleBudgetMP() {
    return ATPLoadPolicy.getHeavyVisibleBudgetMP(getCurrentSettings() || {});
  }

  function getHeavyLightweightPreviewMaxEdge() {
    return ATPLoadPolicy.getHeavyLightweightPreviewEdge(getCurrentSettings() || {});
  }

  function deriveMPBudget(base, multiplier) {
    base = Math.max(0, Number(base) || 0);
    return base > 0 ? Math.round(base * multiplier * 10) / 10 : 0;
  }

  function isWithinMPBudget(value, budget) {
    budget = Math.max(0, Number(budget) || 0);
    return budget <= 0 || Number(value) <= budget;
  }

  function isMPBudgetReached(value, budget) {
    budget = Math.max(0, Number(budget) || 0);
    return budget > 0 && Number(value) >= budget;
  }

  function getHeavyRangeRestoreSoftBudgetMP() {
    return deriveMPBudget(getHeavyDecodedBudgetMP(), 0.75);
  }

  function getHeavyVisibleRestoreBudgetMP() {
    return deriveMPBudget(getHeavyVisibleBudgetMP(), 5 / 6);
  }

  function getHeavyVisibleRestoreSoftBudgetMP() {
    return deriveMPBudget(getHeavyVisibleBudgetMP(), 11 / 18);
  }

  function getHeavyVisiblePreviewGraceMP() {
    return deriveMPBudget(getHeavyVisibleBudgetMP(), 0.25);
  }

  function getHeavyVisibleStableGraceMP() {
    return deriveMPBudget(getHeavyVisibleBudgetMP(), 16 / 9);
  }

  function getHeavyVisibleLateGraceMP() {
    return deriveMPBudget(getHeavyVisibleBudgetMP(), 28 / 9);
  }

  function getHeavyVisibleLastChanceMP() {
    return deriveMPBudget(getHeavyVisibleBudgetMP(), 34 / 9);
  }

  function shouldPausePendingRetryWhenHidden() {
    var settings = getCurrentSettings() || {};
    return document.visibilityState !== 'visible' && settings.pauseWhenHidden !== false;
  }

  function normalizePendingRetryCursor(cursor) {
    var size = pendingWrappers.size;
    if (!size) return 0;
    cursor = Number(cursor) || 0;
    if (cursor < 0) cursor = 0;
    return cursor % size;
  }

  function getTaskThreadState(task) {
    var threads = window.ATPState && window.ATPState.threads;
    return threads && task ? threads[task.threadId] : null;
  }

  function isLightweightHeavyPreloadTask(task) {
    var ts = getTaskThreadState(task);
    return !!(
      task &&
      task.isFirstScreen === false &&
      ts &&
      ts.heavyMode &&
      ts.lightweightHeavyMode &&
      window.ATPLoader &&
      ATPLoader.isHeavyChannelTask &&
      ATPLoader.isHeavyChannelTask(task)
    );
  }

  function getViewportObserverForRoot(root) {
    if (!root) return viewportObserver;
    var state = viewportRootStates.get(root);
    return state && state.observer;
  }

  function retainViewportRoot(root) {
    if (!root) return;
    getLazyRootState(root, true).pendingCount++;
  }

  function releaseViewportRoot(root) {
    if (!root) return;
    var state = getLazyRootState(root, false);
    if (!state) return;
    state.pendingCount = Math.max(0, state.pendingCount - 1);
    if (state.pendingCount > 0) return;
    if (state.observer) state.observer.disconnect();
    viewportRootStates.delete(root);
  }

  function unobservePendingWrapper(wrapper, data) {
    var observerForRoot = getViewportObserverForRoot(data && data.observerRoot);
    if (observerForRoot) observerForRoot.unobserve(wrapper);
    if (lightweightHeavyPreloadObserver) lightweightHeavyPreloadObserver.unobserve(wrapper);
  }

  function removePendingWrapper(wrapper, data, wakeBgQueue, keepLoadingAnimation) {
    clearPendingSlotRetry(data);
    actualVisiblePendingWrappers.delete(wrapper);
    var removed = pendingWrappers.delete(wrapper);
    unobservePendingWrapper(wrapper, data);
    if (removed && data) releaseViewportRoot(data.observerRoot);
    if (!keepLoadingAnimation) unobserveLoadingAnimation(wrapper);
    if (removed && wakeBgQueue) scheduleBgQueueWake();
    return removed;
  }

  function isPendingWrapperStale(wrapper, data) {
    if (!data || data.loaded || !wrapper) return true;
    if (document.contains && !document.contains(wrapper)) return true;
    return !!(window.ATPLoader && ATPLoader.isTaskCurrent && !ATPLoader.isTaskCurrent(data.task));
  }

  var lastPendingPruneAt = 0;
  var PENDING_PRUNE_MIN_INTERVAL_MS = 200;

  function prunePendingWrappers(wakeBgQueue, force) {
    if (!pendingWrappers.size) return 0;
    // 全量清理每项要做 3 次 document.contains，且被 getPendingCount 等高频入口反复触发；
    // 200ms 内的重复调用直接跳过（过期项只是暂时多计数，下一次清理即回收）
    var now = Date.now();
    if (!force && lastPendingPruneAt && now - lastPendingPruneAt < PENDING_PRUNE_MIN_INTERVAL_MS) return 0;
    lastPendingPruneAt = now;
    var removed = 0;
    var pendingEntries = pendingWrappers.entries();
    var pendingEntry = pendingEntries.next();
    while (!pendingEntry.done) {
      var wrapper = pendingEntry.value[0];
      var data = pendingEntry.value[1];
      pendingEntry = pendingEntries.next();
      if (!isPendingWrapperStale(wrapper, data)) continue;
      if (
        data &&
        wrapper &&
        document.contains &&
        !document.contains(wrapper) &&
        window.ATPLoader &&
        ATPLoader.isTaskCurrent &&
        ATPLoader.isTaskCurrent(data.task) &&
        ATPLoader.handleDetachedViewportTask
      ) {
        ATPLoader.handleDetachedViewportTask(data.task);
      }
      if (removePendingWrapper(wrapper, data, wakeBgQueue !== false)) removed++;
    }
    if (removed) {
      pendingVisibleRetryCursor = normalizePendingRetryCursor(pendingVisibleRetryCursor);
      pendingSlotRetryCursor = normalizePendingRetryCursor(pendingSlotRetryCursor);
      pendingHiddenLoadCursor = normalizePendingRetryCursor(pendingHiddenLoadCursor);
      resetPendingVisibleRetryEmptyScan();
    }
    return removed;
  }

  function releaseViewportSlot(task, slotToken) {
    ATPLoader.releaseSlot(task, slotToken);
    scheduleBgQueueWake();
  }

  function getViewportHeight() {
    return Math.max(
      window.innerHeight || 0,
      document.documentElement ? document.documentElement.clientHeight || 0 : 0,
      0
    );
  }

  function getLightweightHeavyPreloadMarginPx() {
    var adaptiveMargin = Math.round(getViewportHeight() * HEAVY_LIGHTWEIGHT_PRELOAD_VIEWPORT_MULTIPLIER);
    return Math.max(HEAVY_LIGHTWEIGHT_PRELOAD_MARGIN_PX, adaptiveMargin || 0);
  }

  function getVerticalDistanceFromViewportPx(wrapper) {
    if (!wrapper || !wrapper.getBoundingClientRect) return undefined;
    var rect = wrapper.getBoundingClientRect();
    var height = getViewportHeight();
    if (rect.bottom < 0) return Math.round(0 - rect.bottom);
    if (rect.top > height) return Math.round(rect.top - height);
    return 0;
  }

  function getLightweightPreloadMissReason(wrapperData, forceLoad) {
    if (!wrapperData || !wrapperData.lightweightPreloadEligible || wrapperData.lightweightPreloadTriggered) return undefined;
    if (wrapperData.inViewport || wrapperData.forceLoadReason === 'viewport') return 'viewport_before_preload';
    if (wrapperData.forceLoadReason === 'hidden') return 'hidden_force_load';
    if (wrapperData.forceLoadReason === 'force') return 'forced_before_preload';
    if (wrapperData.lightweightPreloadInRange && wrapperData.slotRetries) return 'preload_slot_wait';
    if (wrapperData.lightweightPreloadInRange) return 'preload_in_range_not_started';
    if (forceLoad) return 'forced_outside_preload_margin';
    return 'outside_preload_margin';
  }

  function getHeavyThumbnailClarity() {
    var settings = getCurrentSettings() || {};
    if (settings.heavyImageOptimization === false) return 'balanced';
    if (settings.heavyThumbnailClarity === 'lightweight' || settings.heavyThumbnailClarity === 'blurred') {
      return 'lightweight';
    }
    return 'balanced';
  }

  function isHeavyThumbnailLightweightMode() {
    return getHeavyThumbnailClarity() === 'lightweight';
  }

  function getVisiblePreviewStarvationWaitMS() {
    var settings = getCurrentSettings() || {};
    var seconds = parseInt(settings.heavyPreviewStarvationWait, 10);
    if (isNaN(seconds)) seconds = 3;
    return Math.max(0, seconds * 1000);
  }

  function getVisiblePreviewStarvationMP() {
    var settings = getCurrentSettings() || {};
    var mp = parseInt(settings.heavyPreviewStarvationMP, 10);
    if (isNaN(mp)) mp = 820;
    return Math.max(0, mp);
  }

  function getVisiblePreviewStableGraceWaitMS() {
    return Math.round(getVisiblePreviewStarvationWaitMS() * 0.35);
  }

  function getVisiblePreviewLateGraceWaitMS() {
    return getVisiblePreviewStarvationWaitMS();
  }

  function getVisiblePreviewLastChanceWaitMS() {
    return getVisiblePreviewStarvationWaitMS() * 2;
  }

  function getConfiguredInt(key, fallback, min, max) {
    var settings = getCurrentSettings() || {};
    var value = parseInt(settings[key], 10);
    if (isNaN(value)) value = fallback;
    value = Math.max(min, value);
    return max === undefined ? value : Math.min(max, value);
  }

  function getHeavyRestoreFastBatchSize() {
    return getConfiguredInt(
      'heavyRestoreFastBatchSize',
      HEAVY_RESTORE_FAST_BATCH_SIZE,
      HEAVY_RESTORE_BATCH_SIZE
    );
  }

  function getHeavyRestorePressureBatchSize() {
    return getConfiguredInt(
      'heavyRestorePressureBatchSize',
      HEAVY_RESTORE_PRESSURE_BATCH_SIZE,
      HEAVY_RESTORE_BATCH_SIZE
    );
  }

  function getViewportRectState(wrapper) {
    if (!wrapper || !wrapper.getBoundingClientRect) {
      return {
        visible: false,
        inHeavyRestoreRange: false,
        centerDistance: Infinity
      };
    }
    var rect = wrapper.getBoundingClientRect();
    // 零尺寸 = display:none 或未渲染：正常 wrapper 恒有内联宽高。
    // 不加此判定时零点矩形会恒命中 inHeavyRestoreRange，隐藏元素可能被白白恢复/下载
    if (!rect.width && !rect.height) {
      return {
        visible: false,
        inHeavyRestoreRange: false,
        centerDistance: Infinity
      };
    }
    var viewportHeight = window.innerHeight;
    var viewportWidth = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
    var effectiveTop = 0;
    var effectiveBottom = viewportHeight;
    var effectiveLeft = 0;
    var effectiveRight = viewportWidth;
    var scrollRoot = getWrapperScrollRoot(wrapper);
    if (scrollRoot && scrollRoot.getBoundingClientRect) {
      var rootRect = scrollRoot.getBoundingClientRect();
      effectiveTop = Math.max(effectiveTop, rootRect.top);
      effectiveBottom = Math.min(effectiveBottom, rootRect.bottom);
      if (typeof rootRect.left === 'number') effectiveLeft = Math.max(effectiveLeft, rootRect.left);
      if (typeof rootRect.right === 'number') effectiveRight = Math.min(effectiveRight, rootRect.right);
    }
    var center = rect.top + rect.height / 2;
    var effectiveCenter = effectiveTop + Math.max(0, effectiveBottom - effectiveTop) / 2;
    var intersectsHorizontal = rect.right === undefined || rect.left === undefined ||
      (rect.right >= effectiveLeft && rect.left <= effectiveRight);
    // 先用已到手的 rect 做零成本粗判：几何上不可见就不必再走 loader 的祖先链
    // getComputedStyle 精判（loader 判定为可见 ⊆ 几何相交，快照场景 80%+ 条目在此短路）
    var basicVisible = effectiveBottom > effectiveTop && intersectsHorizontal &&
      rect.bottom >= effectiveTop && rect.top <= effectiveBottom;
    var visible = basicVisible && (
      !window.ATPLoader || !ATPLoader.isWrapperVisible || ATPLoader.isWrapperVisible(wrapper)
    );
    var restoreMargin = scrollRoot ? 0 : HEAVY_RENDER_MARGIN_PX;
    return {
      visible: visible,
      inHeavyRestoreRange: effectiveBottom > effectiveTop && intersectsHorizontal &&
        rect.bottom >= effectiveTop - restoreMargin &&
        rect.top <= effectiveBottom + restoreMargin,
      centerDistance: Math.abs(center - effectiveCenter)
    };
  }

  function isInViewport(wrapper) {
    return getViewportRectState(wrapper).visible;
  }

  function getWrapperScrollRoot(wrapper) {
    if (!wrapper || !wrapper.closest) return null;
    var root = wrapper.closest('.atp-scroll-viewport');
    return root && root !== wrapper ? root : null;
  }

  function getLazyRootState(root, create) {
    if (!root) return null;
    var state = viewportRootStates.get(root);
    if (!state && create) {
      state = {
        root: root,
        observer: null,
        topMarginPx: LAZY_VIEWPORT_MARGIN_PX,
        bottomMarginPx: LAZY_VIEWPORT_MARGIN_PX,
        mode: 'idle',
        lastScrollY: null,
        lastScrollAt: 0,
        slowSamples: 0,
        lastModeChangeAt: 0,
        pendingCount: 0
      };
      viewportRootStates.set(root, state);
    }
    return state;
  }

  function getLazyMargins(root) {
    var state = getLazyRootState(root, false);
    return state ? {
      top: state.topMarginPx,
      bottom: state.bottomMarginPx
    } : {
      top: lazyViewportTopMarginPx,
      bottom: lazyViewportBottomMarginPx
    };
  }

  function getLazyViewportBounds(root) {
    if (root && root.getBoundingClientRect) {
      var rootRect = root.getBoundingClientRect();
      return { top: rootRect.top, bottom: rootRect.bottom };
    }
    return { top: 0, bottom: window.innerHeight };
  }

  function refreshPendingViewportVisibility(wrapper, data) {
    if (!data) return false;
    if (!wrapper || !wrapper.getBoundingClientRect) return false;
    var rect = wrapper.getBoundingClientRect();
    var root = data.observerRoot || getWrapperScrollRoot(wrapper);
    var margins = getLazyMargins(root);
    var bounds = getLazyViewportBounds(root);
    var visible = rect.bottom >= bounds.top - margins.top && rect.top <= bounds.bottom + margins.bottom;
    if (data.inViewport !== visible) {
      data.inViewport = visible;
      data.inViewportAt = visible ? Date.now() : 0;
      if (!visible && !data.forceLoadWhenHidden) data.forceLoadReason = '';
    }
    return visible;
  }

  function markVisiblePendingSlotRetries(maxAttempts) {
    // 唯一调用方 retryVisiblePending 在紧邻的上一行已做过强制 prune，
    // 其间只有纯读的 getAvailableSlotCount()，此处再强制扫一遍恒返回 0
    prunePendingWrappers(true);
    var marked = 0;
    var actualWrappers = actualVisiblePendingWrappers.values();
    var actualWrapper = actualWrappers.next();
    while (!actualWrapper.done) {
      var actualData = pendingWrappers.get(actualWrapper.value);
      if (!actualData || actualData.loaded || !actualData.actualInViewport) {
        actualVisiblePendingWrappers.delete(actualWrapper.value);
      } else {
        markPendingSlotRetry(actualData);
        marked++;
      }
      actualWrapper = actualWrappers.next();
    }
    if (marked) return marked;
    var attemptLimit = Math.max(1, Math.min(
      Number(maxAttempts) || PENDING_SLOT_RETRY_SCAN_LIMIT,
      pendingWrappers.size,
      PENDING_SLOT_RETRY_SCAN_LIMIT
    ));
    var startIndex = normalizePendingRetryCursor(pendingVisibleRetryCursor);
    var scanned = 0;
    var index = 0;
    var nextCursor = startIndex;
    var pendingEntries = pendingWrappers.entries();
    var pendingEntry = pendingEntries.next();
    while (!pendingEntry.done) {
      var wrapper = pendingEntry.value[0];
      var data = pendingEntry.value[1];
      pendingEntry = pendingEntries.next();
      if (index++ < startIndex) continue;
      // 达到扫描上限时，游标停在当前未处理的条目上，避免每轮固定漏扫一个
      if (scanned >= attemptLimit) {
        nextCursor = (index - 1) >= pendingWrappers.size ? 0 : (index - 1);
        break;
      }
      scanned++;
      nextCursor = index >= pendingWrappers.size ? 0 : index;
      if (!data || data.loaded || !refreshPendingViewportVisibility(wrapper, data)) continue;
      markPendingSlotRetry(data);
      marked++;
    }
    if (scanned < attemptLimit && startIndex > 0) {
      pendingEntries = pendingWrappers.entries();
      pendingEntry = pendingEntries.next();
      index = 0;
      while (!pendingEntry.done && index < startIndex) {
        var wrappedWrapper = pendingEntry.value[0];
        var wrappedData = pendingEntry.value[1];
        pendingEntry = pendingEntries.next();
        index++;
        if (scanned >= attemptLimit) {
          nextCursor = (index - 1) >= pendingWrappers.size ? 0 : (index - 1);
          break;
        }
        scanned++;
        nextCursor = index >= pendingWrappers.size ? 0 : index;
        if (!wrappedData || wrappedData.loaded || !refreshPendingViewportVisibility(wrappedWrapper, wrappedData)) continue;
        markPendingSlotRetry(wrappedData);
        marked++;
      }
    }
    pendingVisibleRetryCursor = normalizePendingRetryCursor(nextCursor);
    return marked;
  }

  function roundMP(value) {
    return Math.round((Number(value) || 0) * 10) / 10;
  }

  function isVisibleStable(data, now) {
    if (!data || !data.visibleSeenAt) return false;
    return (now || Date.now()) - data.visibleSeenAt >= HEAVY_VISIBLE_LOCK_DELAY_MS;
  }

  function isVisibleRestoreSettling(data, now) {
    if (!data || !data.visibleRestoreHoldUntil) return false;
    return (now || Date.now()) < data.visibleRestoreHoldUntil;
  }

  function getVisiblePreviewWaitMS(data, now) {
    if (!data || !data.visiblePreviewSince) return 0;
    return Math.max(0, (now || Date.now()) - data.visiblePreviewSince);
  }

  function clearVisiblePreviewWaiting(data) {
    if (!data) return;
    data.visiblePreviewSince = 0;
    data.visiblePreviewGraceActive = false;
    data.visiblePreviewGraceMode = '';
  }

  // visibleKnown：调用方已算好可见性时传入，省去重复的 rect+祖先链测量（快照循环等场景）
  function isVisiblePreviewWaiting(wrapper, data, visibleKnown) {
    if (!wrapper || !data || (!data.unloaded && !data.restoreLoading)) return false;
    var visible = visibleKnown === undefined ? isInViewport(wrapper) : !!visibleKnown;
    if (!visible) return false;
    if (data.lightweightModeHold && isHeavyThumbnailLightweightMode()) return false;
    return !!(
      data.previewReady ||
      wrapper.classList.contains('atp-heavy-preview-active') ||
      wrapper.classList.contains('atp-heavy-preview-pending')
    );
  }

  function markVisiblePreviewWaiting(wrapper, data, now, visibleKnown) {
    if (!data) return 0;
    now = now || Date.now();
    var visible = wrapper
      ? (visibleKnown === undefined ? isInViewport(wrapper) : !!visibleKnown)
      : false;
    if (!isVisiblePreviewWaiting(wrapper, data, visible)) {
      if (wrapper && !visible) clearVisiblePreviewWaiting(data);
      return getVisiblePreviewWaitMS(data, now);
    }
    if (!data.visiblePreviewSince) data.visiblePreviewSince = now;
    return getVisiblePreviewWaitMS(data, now);
  }

  function getVisiblePreviewMinWaitMS(data) {
    return getDataDecodedMP(data) >= HEAVY_ULTRA_MP
      ? HEAVY_VISIBLE_RESTORE_GRACE_MS
      : HEAVY_VISIBLE_PREVIEW_MAX_WAIT_MS;
  }

  function isVisiblePreviewStuck(wrapper, data, now) {
    if (!isVisiblePreviewWaiting(wrapper, data)) return false;
    return getVisiblePreviewWaitMS(data, now) >= Math.max(
      getVisiblePreviewMinWaitMS(data),
      getVisiblePreviewStableGraceWaitMS()
    );
  }

  function getVisiblePreviewGraceInfo(wrapper, data, stats, mp, now) {
    now = now || Date.now();
    mp = Number(mp) || 0;
    var waitMS = markVisiblePreviewWaiting(wrapper, data, now);
    var projectedVisibleMP = roundMP(((stats && stats.heavyVisibleMP) || 0) + mp);
    var visibleRestoreBudgetMP = getHeavyVisibleRestoreBudgetMP();
    var graceBudgetMP = visibleRestoreBudgetMP > 0
      ? visibleRestoreBudgetMP + getHeavyVisiblePreviewGraceMP()
      : 0;
    var minWaitMS = getVisiblePreviewMinWaitMS(data);
    var stableGraceMinWaitMS = Math.max(minWaitMS, getVisiblePreviewStableGraceWaitMS());
    var lateGraceMinWaitMS = Math.max(stableGraceMinWaitMS, getVisiblePreviewLateGraceWaitMS());
    var lastChanceMinWaitMS = Math.max(lateGraceMinWaitMS, getVisiblePreviewLastChanceWaitMS());
    var starvationMinWaitMS = Math.max(stableGraceMinWaitMS, getVisiblePreviewStarvationWaitMS());
    var starvationBudgetMP = getVisiblePreviewStarvationMP();
    var stableGraceBudgetMP = getHeavyVisibleStableGraceMP();
    var lateGraceBudgetMP = getHeavyVisibleLateGraceMP();
    var lastChanceBudgetMP = getHeavyVisibleLastChanceMP();
    var normalAllowed = !!(data && data.unloaded && waitMS >= minWaitMS && isWithinMPBudget(projectedVisibleMP, graceBudgetMP));
    var stableAllowed = !!(
      data &&
      data.unloaded &&
      !normalAllowed &&
      waitMS >= stableGraceMinWaitMS &&
      isWithinMPBudget(projectedVisibleMP, stableGraceBudgetMP)
    );
    var lateAllowed = !!(
      data &&
      data.unloaded &&
      !normalAllowed &&
      !stableAllowed &&
      waitMS >= lateGraceMinWaitMS &&
      isWithinMPBudget(projectedVisibleMP, lateGraceBudgetMP)
    );
    var lastChanceAllowed = !!(
      data &&
      data.unloaded &&
      !normalAllowed &&
      !stableAllowed &&
      !lateAllowed &&
      waitMS >= lastChanceMinWaitMS &&
      isWithinMPBudget(projectedVisibleMP, lastChanceBudgetMP)
    );
    var starvationAllowed = !!(
      data &&
      data.unloaded &&
      !normalAllowed &&
      !stableAllowed &&
      !lateAllowed &&
      !lastChanceAllowed &&
      waitMS >= starvationMinWaitMS &&
      isWithinMPBudget(projectedVisibleMP, starvationBudgetMP) &&
      (!stats || !stats.heavyVisibleRestoring)
    );
    return {
      allowed: normalAllowed || stableAllowed || lateAllowed || lastChanceAllowed || starvationAllowed,
      mode: normalAllowed ? 'normal' : (stableAllowed ? 'stable' : (lateAllowed ? 'late' : (lastChanceAllowed ? 'last_chance' : (starvationAllowed ? 'starvation' : '')))),
      waitMS: waitMS,
      minWaitMS: minWaitMS,
      stableGraceMinWaitMS: stableGraceMinWaitMS,
      lateGraceMinWaitMS: lateGraceMinWaitMS,
      lastChanceMinWaitMS: lastChanceMinWaitMS,
      starvationMinWaitMS: starvationMinWaitMS,
      projectedVisibleMP: projectedVisibleMP,
      graceBudgetMP: graceBudgetMP,
      stableGraceBudgetMP: stableGraceBudgetMP,
      lateGraceBudgetMP: lateGraceBudgetMP,
      lastChanceBudgetMP: lastChanceBudgetMP,
      starvationBudgetMP: starvationBudgetMP
    };
  }

  function getVisiblePreviewGraceReason(data) {
    if (data && data.visiblePreviewGraceMode === 'starvation') return 'visible_preview_starvation_grace';
    if (data && data.visiblePreviewGraceMode === 'last_chance') return 'visible_preview_last_chance';
    if (data && data.visiblePreviewGraceMode === 'late') return 'visible_preview_late_grace';
    if (data && data.visiblePreviewGraceMode === 'stable') return 'visible_preview_stable_grace';
    return 'visible_preview_grace';
  }

  function getVisiblePreviewLogFields(data) {
    return {
      visiblePreviewWaitMS: getVisiblePreviewWaitMS(data),
      visiblePreviewGrace: !!(data && data.visiblePreviewGraceActive),
      visiblePreviewGraceMode: (data && data.visiblePreviewGraceMode) || '',
      visiblePreviewMaxWaitMS: HEAVY_VISIBLE_PREVIEW_MAX_WAIT_MS,
      visiblePreviewGraceMP: getHeavyVisiblePreviewGraceMP(),
      visibleRestoreGraceMS: HEAVY_VISIBLE_RESTORE_GRACE_MS,
      visiblePreviewStableGraceWaitMS: getVisiblePreviewStableGraceWaitMS(),
      visiblePreviewStableGraceMP: getHeavyVisibleStableGraceMP(),
      visiblePreviewLateGraceWaitMS: getVisiblePreviewLateGraceWaitMS(),
      visiblePreviewLateGraceMP: getHeavyVisibleLateGraceMP(),
      visiblePreviewLastChanceWaitMS: getVisiblePreviewLastChanceWaitMS(),
      visiblePreviewLastChanceMP: getHeavyVisibleLastChanceMP(),
      visiblePreviewStarvationWaitMS: getVisiblePreviewStarvationWaitMS(),
      visiblePreviewStarvationMP: getVisiblePreviewStarvationMP(),
      heavyRestoreDeferRetryMS: HEAVY_RESTORE_DEFER_RETRY_DELAY
    };
  }

  function getDataDecodedMP(data) {
    if (!data || !data.img) return 0;
    // 只读 naturalWidth/Height（不触发布局）；getImageMetrics 会附带读 clientWidth/Height，
    // 在预算/排序等高频路径上会造成强制回流
    var nw = data.img.naturalWidth || 0;
    var nh = data.img.naturalHeight || 0;
    if (nw) data.naturalWidth = nw;
    if (nh) data.naturalHeight = nh;
    var naturalWidth = data.naturalWidth || nw;
    var naturalHeight = data.naturalHeight || nh;
    return naturalWidth && naturalHeight ? roundMP((naturalWidth * naturalHeight) / 1000000) : 0;
  }

  function getHeavyRenderSnapshot() {
    var now = Date.now();
    var items = [];
    var stats = {
      heavyTracked: 0,
      heavyUnloaded: 0,
      heavyInRange: 0,
      heavyLoadedInRange: 0,
      heavyVisibleLoaded: 0,
      heavyVisibleRestoring: 0,
      heavyVisibleRestoreSettling: 0,
      heavyVisibleMP: 0,
      heavyVisibleRestoringMP: 0,
      heavyVisibleRestoreSettlingMP: 0,
      heavyRangeMP: 0,
      heavyRangeRestoringMP: 0,
      heavyMaxVisibleMP: 0,
      heavyMaxRangeMP: 0,
      heavyVisibleBudgetMP: getHeavyVisibleBudgetMP(),
      heavyVisibleMinKeep: HEAVY_VISIBLE_MIN_KEEP,
      heavyVisibleRestoreBudgetMP: getHeavyVisibleRestoreBudgetMP(),
      heavyVisibleRestoreSoftBudgetMP: getHeavyVisibleRestoreSoftBudgetMP(),
      heavyVisibleRestoreMinKeep: HEAVY_VISIBLE_RESTORE_MIN_KEEP,
      heavyVisibleLockDelayMS: HEAVY_VISIBLE_LOCK_DELAY_MS,
      heavyVisibleRestoreSettleMS: HEAVY_VISIBLE_RESTORE_SETTLE_MS,
      heavyVisiblePreviewWaiting: 0,
      heavyVisiblePreviewWaitMS: 0,
      heavyVisiblePreviewMaxWaitMS: HEAVY_VISIBLE_PREVIEW_MAX_WAIT_MS,
      heavyVisiblePreviewGraceMP: getHeavyVisiblePreviewGraceMP(),
      heavyVisibleRestoreGraceMS: HEAVY_VISIBLE_RESTORE_GRACE_MS,
      heavyVisiblePreviewStableGraceWaitMS: getVisiblePreviewStableGraceWaitMS(),
      heavyVisiblePreviewStableGraceMP: getHeavyVisibleStableGraceMP(),
      heavyVisiblePreviewLateGraceWaitMS: getVisiblePreviewLateGraceWaitMS(),
      heavyVisiblePreviewLateGraceMP: getHeavyVisibleLateGraceMP(),
      heavyVisiblePreviewLastChanceWaitMS: getVisiblePreviewLastChanceWaitMS(),
      heavyVisiblePreviewLastChanceMP: getHeavyVisibleLastChanceMP(),
      heavyVisiblePreviewStarvationWaitMS: getVisiblePreviewStarvationWaitMS(),
      heavyVisiblePreviewStarvationMP: getVisiblePreviewStarvationMP(),
      heavyRestoreDeferRetryMS: HEAVY_RESTORE_DEFER_RETRY_DELAY,
      heavyBudgetCount: getHeavyDecodedImageLimit(),
      heavyRestoreSoftBudgetMP: getHeavyRangeRestoreSoftBudgetMP(),
      heavyBudgetMP: getHeavyDecodedBudgetMP(),
      heavyUnloadBatchSize: HEAVY_UNLOAD_BATCH_SIZE,
      heavyPreviewPrewarm: HEAVY_PREVIEW_PREWARM_ENABLED
    };

    var renderEntries = heavyRenderItems.entries();
    var renderEntry = renderEntries.next();
    while (!renderEntry.done) {
      var wrapper = renderEntry.value[0];
      var data = renderEntry.value[1];
      renderEntry = renderEntries.next();
      if (data && data.unloaded) stats.heavyUnloaded++;
      if (!data || !data.img) continue;
      if (!document.contains(wrapper)) {
        // 节点已脱离文档（论坛整块替换列表等）：就地清理，避免 Map 长期钉住脱离的 DOM 树
        cleanupHeavyRenderItem(wrapper);
        continue;
      }
      var viewportState = getViewportRectState(wrapper);
      var inRange = viewportState.inHeavyRestoreRange;
      var visible = viewportState.visible;
      var restoring = !!data.restoreLoading;
      var loaded = !data.unloaded && !restoring;
      var renderedVisible = loaded && visible && !data.restoreLoading;
      var settling = renderedVisible && isVisibleRestoreSettling(data, now);
      if (data.visibleRestoreHoldUntil && !settling) data.visibleRestoreHoldUntil = 0;
      if (renderedVisible) {
        if (!data.visibleSeenAt) data.visibleSeenAt = now;
        if (isVisibleStable(data, now)) data.visibleLocked = true;
      } else {
        data.visibleSeenAt = 0;
        data.visibleLocked = false;
      }
      var mp = getDataDecodedMP(data);
      stats.heavyTracked++;
      if (inRange) stats.heavyInRange++;
      if (loaded && inRange) {
        stats.heavyLoadedInRange++;
        stats.heavyRangeMP += mp;
        if (mp > stats.heavyMaxRangeMP) stats.heavyMaxRangeMP = mp;
      }
      if (restoring && inRange) {
        stats.heavyRangeRestoringMP += mp;
      }
      if (loaded && visible) {
        stats.heavyVisibleLoaded++;
        stats.heavyVisibleMP += mp;
        if (mp > stats.heavyMaxVisibleMP) stats.heavyMaxVisibleMP = mp;
      }
      if (restoring && visible) {
        stats.heavyVisibleRestoring++;
        stats.heavyVisibleRestoringMP += mp;
      }
      if (settling) {
        stats.heavyVisibleRestoreSettling++;
        stats.heavyVisibleRestoreSettlingMP += mp;
      }
      if (isVisiblePreviewWaiting(wrapper, data, visible)) {
        var previewWaitMS = markVisiblePreviewWaiting(wrapper, data, now, visible);
        stats.heavyVisiblePreviewWaiting++;
        if (previewWaitMS > stats.heavyVisiblePreviewWaitMS) {
          stats.heavyVisiblePreviewWaitMS = previewWaitMS;
        }
      } else if (data.visiblePreviewSince && !visible) {
        clearVisiblePreviewWaiting(data);
      }
      items.push({
        wrapper: wrapper,
        data: data,
        inRange: inRange,
        visible: visible,
        loaded: loaded,
        restoring: restoring,
        mp: mp,
        distance: viewportState.centerDistance
      });
    }

    stats.heavyVisibleMP = roundMP(stats.heavyVisibleMP);
    stats.heavyVisibleRestoringMP = roundMP(stats.heavyVisibleRestoringMP);
    stats.heavyVisibleRestoreSettlingMP = roundMP(stats.heavyVisibleRestoreSettlingMP);
    stats.heavyRangeMP = roundMP(stats.heavyRangeMP);
    stats.heavyRangeRestoringMP = roundMP(stats.heavyRangeRestoringMP);
    stats.heavyMaxVisibleMP = roundMP(stats.heavyMaxVisibleMP);
    stats.heavyMaxRangeMP = roundMP(stats.heavyMaxRangeMP);
    return { items: items, stats: stats };
  }

  function getHeavyRenderLogFields(renderContext) {
    var stats = renderContext && renderContext.stats ? renderContext.stats : renderContext;
    stats = stats || getHeavyRenderSnapshot().stats;
    return {
      heavyVisibleLoaded: stats.heavyVisibleLoaded,
      heavyUnloaded: stats.heavyUnloaded,
      heavyVisibleRestoring: stats.heavyVisibleRestoring,
      heavyVisibleRestoreSettling: stats.heavyVisibleRestoreSettling,
      heavyVisibleMP: stats.heavyVisibleMP,
      heavyVisibleRestoringMP: stats.heavyVisibleRestoringMP,
      heavyVisibleRestoreSettlingMP: stats.heavyVisibleRestoreSettlingMP,
      heavyRangeMP: stats.heavyRangeMP,
      heavyRangeRestoringMP: stats.heavyRangeRestoringMP,
      heavyMaxVisibleMP: stats.heavyMaxVisibleMP,
      heavyMaxRangeMP: stats.heavyMaxRangeMP,
      heavyVisibleBudgetMP: stats.heavyVisibleBudgetMP,
      heavyVisibleMinKeep: stats.heavyVisibleMinKeep,
      heavyVisibleRestoreBudgetMP: stats.heavyVisibleRestoreBudgetMP,
      heavyVisibleRestoreSoftBudgetMP: stats.heavyVisibleRestoreSoftBudgetMP,
      heavyVisibleRestoreMinKeep: stats.heavyVisibleRestoreMinKeep,
      heavyVisibleLockDelayMS: stats.heavyVisibleLockDelayMS,
      heavyVisibleRestoreSettleMS: stats.heavyVisibleRestoreSettleMS,
      heavyVisiblePreviewWaiting: stats.heavyVisiblePreviewWaiting,
      heavyVisiblePreviewWaitMS: stats.heavyVisiblePreviewWaitMS,
      heavyVisiblePreviewStableGraceWaitMS: stats.heavyVisiblePreviewStableGraceWaitMS,
      heavyVisiblePreviewStableGraceMP: stats.heavyVisiblePreviewStableGraceMP,
      heavyVisiblePreviewLateGraceWaitMS: stats.heavyVisiblePreviewLateGraceWaitMS,
      heavyVisiblePreviewLateGraceMP: stats.heavyVisiblePreviewLateGraceMP,
      heavyVisiblePreviewLastChanceWaitMS: stats.heavyVisiblePreviewLastChanceWaitMS,
      heavyVisiblePreviewLastChanceMP: stats.heavyVisiblePreviewLastChanceMP,
      heavyVisiblePreviewStarvationWaitMS: stats.heavyVisiblePreviewStarvationWaitMS,
      heavyVisiblePreviewStarvationMP: stats.heavyVisiblePreviewStarvationMP,
      heavyThumbnailClarity: getHeavyThumbnailClarity(),
      heavyLightweightPreviewMaxEdge: getHeavyLightweightPreviewMaxEdge(),
      heavyBudgetCount: stats.heavyBudgetCount,
      heavyRestoreSoftBudgetMP: stats.heavyRestoreSoftBudgetMP,
      heavyBudgetMP: stats.heavyBudgetMP,
      heavyUnloadBatchSize: stats.heavyUnloadBatchSize,
      heavyPreviewPrewarm: stats.heavyPreviewPrewarm
    };
  }

  function selectHeavyBudgetItems(items) {
    var selected = new Map();
    var selectedCount = 0;
    var selectedMP = 0;
    var candidates = [];
    var sourceItems = items || [];
    for (var candidateIndex = 0; candidateIndex < sourceItems.length; candidateIndex++) {
      var candidate = sourceItems[candidateIndex];
      if (candidate && candidate.inRange) candidates.push(candidate);
    }
    candidates.sort(function(a, b) {
      return a.distance - b.distance;
    });

    var budgetCount = getHeavyDecodedImageLimit();
    var budgetMP = getHeavyDecodedBudgetMP();
    for (var i = 0; i < candidates.length; i++) {
      var item = candidates[i];
      var mp = Number(item.mp) || 0;
      var keepForMinimum = selectedCount < getHeavyRenderMinKeep();
      var keepWithinBudget = (budgetCount <= 0 || selectedCount < budgetCount) &&
        (!mp || isWithinMPBudget(selectedMP + mp, budgetMP));
      if (!keepForMinimum && !keepWithinBudget) continue;
      selected.set(item.wrapper, true);
      selectedCount++;
      selectedMP += mp;
    }

    return {
      has: function(wrapper) {
        if (!wrapper) return false;
        return selected.get(wrapper);
      },
      count: selectedCount,
      mp: roundMP(selectedMP)
    };
  }

  function getBudgetSelection() {
    var snapshot = getHeavyRenderSnapshot();
    var selected = selectHeavyBudgetItems(snapshot.items);
    return {
      snapshot: snapshot,
      selected: selected
    };
  }

  function isVisibleRestoreBudgetAllowed(wrapper, data, viewportState, snapshot) {
    viewportState = viewportState || getViewportRectState(wrapper);
    if (!wrapper || !data || !viewportState.visible) return true;
    var stats = (snapshot && snapshot.stats) || getHeavyRenderSnapshot().stats;
    var mp = getDataDecodedMP(data);
    if (stats.heavyVisibleLoaded < HEAVY_VISIBLE_RESTORE_MIN_KEEP) {
      data.visiblePreviewGraceActive = false;
      data.visiblePreviewGraceMode = '';
      return true;
    }
    if (!mp) {
      data.visiblePreviewGraceActive = false;
      data.visiblePreviewGraceMode = '';
      return true;
    }
    if (isWithinMPBudget(stats.heavyVisibleMP + mp, getHeavyVisibleRestoreBudgetMP())) {
      data.visiblePreviewGraceActive = false;
      data.visiblePreviewGraceMode = '';
      return true;
    }
    var graceInfo = getVisiblePreviewGraceInfo(wrapper, data, stats, mp);
    data.visiblePreviewGraceActive = graceInfo.allowed;
    data.visiblePreviewGraceMode = graceInfo.mode;
    return graceInfo.allowed;
  }

  function getRestoreBudgetBlockReason(wrapper, data, viewportState, budget) {
    viewportState = viewportState || getViewportRectState(wrapper);
    if (wrapper && viewportState.visible && !isVisibleRestoreBudgetAllowed(wrapper, data, viewportState, budget && budget.snapshot)) {
      return data && data.visiblePreviewSince ? 'visible_preview_defer' : 'visible_mp_defer';
    }
    return 'budget_defer';
  }

  function isHeavyRestoreBudgetAllowed(wrapper, data, viewportState, budget) {
    if (!wrapper) return false;
    viewportState = viewportState || getViewportRectState(wrapper);
    if (viewportState.visible) return isVisibleRestoreBudgetAllowed(wrapper, data, viewportState, budget && budget.snapshot);
    return (budget || getBudgetSelection()).selected.has(wrapper);
  }

  function getHeavyRestoreDelayInfo(mp, stats, restoredVisibleMP, restoredRangeMP) {
    stats = stats || getHeavyRenderSnapshot().stats;
    mp = Number(mp) || 0;
    restoredVisibleMP = Number(restoredVisibleMP) || 0;
    restoredRangeMP = Number(restoredRangeMP) || 0;
    var projectedVisibleMP = roundMP(stats.heavyVisibleMP + restoredVisibleMP + mp);
    var projectedRangeMP = roundMP(stats.heavyRangeMP + restoredRangeMP + mp);
    if (
      isMPBudgetReached(projectedVisibleMP, getHeavyVisibleRestoreBudgetMP()) ||
      isMPBudgetReached(projectedRangeMP, getHeavyDecodedBudgetMP())
    ) {
      return {
        delay: HEAVY_RESTORE_PRESSURE_DELAY,
        pressure: 'hard',
        projectedVisibleMP: projectedVisibleMP,
        projectedRangeMP: projectedRangeMP
      };
    }
    if (
      isMPBudgetReached(projectedVisibleMP, getHeavyVisibleRestoreSoftBudgetMP()) ||
      isMPBudgetReached(projectedRangeMP, getHeavyRangeRestoreSoftBudgetMP())
    ) {
      return {
        delay: HEAVY_RESTORE_SOFT_PRESSURE_DELAY,
        pressure: 'soft',
        projectedVisibleMP: projectedVisibleMP,
        projectedRangeMP: projectedRangeMP
      };
    }
    if (
      mp <= HEAVY_RESTORE_FAST_MP &&
      !isMPBudgetReached(projectedVisibleMP, getHeavyVisibleRestoreSoftBudgetMP()) &&
      !isMPBudgetReached(projectedRangeMP, getHeavyRangeRestoreSoftBudgetMP())
    ) {
      return {
        delay: HEAVY_RESTORE_FAST_DELAY,
        pressure: 'fast',
        projectedVisibleMP: projectedVisibleMP,
        projectedRangeMP: projectedRangeMP
      };
    }
    if (mp >= HEAVY_ULTRA_MP) {
      return {
        delay: HEAVY_RESTORE_ULTRA_DELAY,
        pressure: 'ultra',
        projectedVisibleMP: projectedVisibleMP,
        projectedRangeMP: projectedRangeMP
      };
    }
    return {
      delay: HEAVY_RESTORE_BATCH_DELAY,
      pressure: 'normal',
      projectedVisibleMP: projectedVisibleMP,
      projectedRangeMP: projectedRangeMP
    };
  }

  var heavyBudgetTimerFireAt = 0;

  // 最早者胜：已有更晚的挂起定时器时改期提前，避免 420ms 重试请求被
  // 长退避/看门狗定时器吞掉导致可见毛玻璃恢复停滞数秒
  function scheduleHeavyBudgetReconcile(reason, delay) {
    if (isLoaderPaused()) return;
    var effectiveDelay = Math.max(0, delay === undefined ? HEAVY_BUDGET_RECONCILE_DELAY : delay);
    var fireAt = Date.now() + effectiveDelay;
    if (heavyBudgetTimer) {
      if (heavyBudgetTimerFireAt && fireAt >= heavyBudgetTimerFireAt) return;
      clearTimeout(heavyBudgetTimer);
      heavyBudgetTimer = null;
    }
    heavyBudgetTimerFireAt = fireAt;
    heavyBudgetTimer = setTimeout(function() {
      heavyBudgetTimer = null;
      heavyBudgetTimerFireAt = 0;
      if (isLoaderPaused()) return;
      reconcileHeavyRenderBudget(reason || 'budget_reconcile_followup');
    }, effectiveDelay);
  }

  function scheduleHeavyRestoreRetry(wrapper, data, reason) {
    wrapper = wrapper || (data && data.wrapper);
    if (!wrapper || !data || !data.unloaded || isLoaderPaused()) return;
    if (!document.contains(wrapper) || heavyRenderItems.get(wrapper) !== data) return;
    if (!getViewportRectState(wrapper).inHeavyRestoreRange) return;
    var attempts = (Number(data.restoreRetryCount) || 0) + 1;
    data.restoreRetryCount = attempts;
    if (attempts > HEAVY_RESTORE_RETRY_MAX) {
      var viewportState = getViewportRectState(wrapper);
      logRenderStateThrottled(data, 'restore_retry_giveup', {
        reason: reason || 'restore_retry_giveup',
        restoreRetryCount: attempts,
        restoreRetryMax: HEAVY_RESTORE_RETRY_MAX,
        restoreWatchdogScheduled: !!viewportState.visible,
        restoreWatchdogDelayMS: viewportState.visible ? HEAVY_RESTORE_WATCHDOG_DELAY : undefined
      });
      if (viewportState.visible) {
        scheduleHeavyBudgetReconcile('restore_retry_watchdog', HEAVY_RESTORE_WATCHDOG_DELAY);
      }
      return;
    }
    var delay = Math.min(
      HEAVY_RESTORE_RETRY_MAX_DELAY,
      HEAVY_RESTORE_DEFER_RETRY_DELAY * Math.pow(2, attempts - 1)
    );
    logRenderStateThrottled(data, reason || 'restore_retry', {
      restoreRetryCount: attempts,
      restoreRetryDelayMS: delay,
      restoreRetryMax: HEAVY_RESTORE_RETRY_MAX
    });
    scheduleHeavyBudgetReconcile(reason || 'restore_retry', delay);
  }

  // 历史上的「轮换卸载」实验只剩宽限标记这一个副作用：所有卡住项都会被处理，
  // 排序与中间数组没有可观察效果，收敛为单遍循环
  function reconcileVisiblePreviewRoom(snapshot) {
    var now = Date.now();
    snapshot = snapshot || getHeavyRenderSnapshot();
    var items = snapshot.items || [];
    var stuck = 0;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || !item.visible || !item.data || !item.data.unloaded) continue;
      if (!isVisiblePreviewStuck(item.wrapper, item.data, now)) continue;
      stuck++;
      var mp = Number(item.mp) || getDataDecodedMP(item.data);
      var graceInfo = getVisiblePreviewGraceInfo(item.wrapper, item.data, snapshot.stats, mp, now);
      if (graceInfo.allowed) {
        item.data.visiblePreviewGraceActive = true;
        item.data.visiblePreviewGraceMode = graceInfo.mode;
      }
    }
    return { stuck: stuck };
  }

  function getVisibleRenderPressureBudgetMP(stats) {
    if (getHeavyVisibleBudgetMP() <= 0) return 0;
    if (!stats || !stats.heavyVisiblePreviewWaiting) {
      // 迟滞：无人等待时的压力预算不能低于「普通宽限」的准入线，否则刚被宽限放行的那张
      // 会在下一次对账（120ms）里被立刻踢回毛玻璃，再等一整轮最小等待（清晰→模糊→清晰的往返）
      return Math.max(
        getHeavyVisibleBudgetMP(),
        getHeavyVisibleRestoreBudgetMP() + getHeavyVisiblePreviewGraceMP()
      );
    }
    // lateGraceWait 恒等于 starvationWait，lastChanceWait = 2×，原判定顺序让这两档永不可达；
    // 这里显式收敛成单调的三态，避免调参时被假档位误导。
    // 压力阀（820MP≈"可见项基本不再卸载"）另设 6s 下限：把「重图兜底等待」调小
    // 只应加快恢复准入，不该让这道内存闸门变得日常可达
    var pressureWaitMS = Math.max(getVisiblePreviewStarvationWaitMS(), HEAVY_VISIBLE_PRESSURE_RELEASE_MIN_MS);
    if (stats.heavyVisiblePreviewWaitMS >= pressureWaitMS) {
      return Math.max(getVisiblePreviewStarvationMP(), getHeavyVisibleLastChanceMP());
    }
    return getHeavyVisibleStableGraceMP();
  }

  function reconcileVisibleRenderPressure(snapshot, selected, maxUnloads) {
    if (!snapshot || !snapshot.stats) {
      return { unloaded: 0, limited: false };
    }
    var pressureBudgetMP = getVisibleRenderPressureBudgetMP(snapshot.stats);
    if (isWithinMPBudget(snapshot.stats.heavyVisibleMP, pressureBudgetMP)) {
      return { unloaded: 0, limited: false };
    }
    var now = Date.now();
    var candidates = [];
    var items = snapshot.items || [];
    for (var vi = 0; vi < items.length; vi++) {
      var visibleItem = items[vi];
      if (!visibleItem || !visibleItem.loaded || !visibleItem.visible || !visibleItem.data) continue;
      if (!visibleItem.data.unloaded && isVisibleStable(visibleItem.data, now)) {
        visibleItem.data.visibleLocked = true;
      }
      if (!visibleItem.data.visibleLocked && !isVisibleRestoreSettling(visibleItem.data, now)) {
        candidates.push(visibleItem);
      }
    }
    candidates.sort(function(a, b) {
      var mpDiff = (Number(b.mp) || 0) - (Number(a.mp) || 0);
      if (mpDiff) return mpDiff;
      return b.distance - a.distance;
    });
    var currentMP = snapshot.stats.heavyVisibleMP;
    var currentCount = snapshot.stats.heavyVisibleLoaded;
    var unloaded = 0;
    maxUnloads = Math.max(1, Number(maxUnloads) || HEAVY_UNLOAD_BATCH_SIZE);
    for (var i = 0; i < candidates.length; i++) {
      if (isWithinMPBudget(currentMP, pressureBudgetMP) || currentCount <= HEAVY_VISIBLE_MIN_KEEP) break;
      if (unloaded >= maxUnloads) break;
      var item = candidates[i];
      var mp = Number(item.mp) || 0;
      unloadHeavyImage(item.wrapper, item.data, {
        reason: 'visible_budget_unload',
        heavyVisibleBudgetMP: getHeavyVisibleBudgetMP(),
        heavyVisiblePressureBudgetMP: pressureBudgetMP,
        heavyVisibleMinKeep: HEAVY_VISIBLE_MIN_KEEP,
        heavyUnloadBatchSize: HEAVY_UNLOAD_BATCH_SIZE,
        selectedCount: selected && selected.count,
        selectedMP: selected && selected.mp
      }, snapshot);
      currentMP = roundMP(currentMP - mp);
      currentCount--;
      unloaded++;
    }
    return {
      unloaded: unloaded,
      limited: !isWithinMPBudget(currentMP, pressureBudgetMP) && currentCount > HEAVY_VISIBLE_MIN_KEEP && i < candidates.length
    };
  }

  function clearRestoreReveal(data) {
    if (!data || !data.restoreReveal || !data.img) return;
    data.img.removeEventListener('load', data.restoreReveal);
    data.img.removeEventListener('error', data.restoreReveal);
    data.restoreReveal = null;
  }

  function unregisterHeavyRestoreLoad(data) {
    if (!data || !data.restoreActiveUnregister) return;
    var unregister = data.restoreActiveUnregister;
    data.restoreActiveUnregister = null;
    unregister();
  }

  var heavySlotFreeVisibleRestores = 0;

  function releaseHeavyRestoreSlot(data) {
    if (!data) return;
    if (data.restoreSlotFree) {
      data.restoreSlotFree = false;
      if (heavySlotFreeVisibleRestores > 0) heavySlotFreeVisibleRestores--;
    }
    if (data.restoreSlotToken === undefined || data.restoreSlotToken === null) return;
    var token = data.restoreSlotToken;
    data.restoreSlotToken = null;
    if (window.ATPLoader && ATPLoader.releaseSlot) ATPLoader.releaseSlot(data.task, token);
  }

  function clearHeavyRestoreLoadTimer(data) {
    if (!data || !data.restoreTimer) return;
    clearTimeout(data.restoreTimer);
    data.restoreTimer = null;
  }

  function cancelHeavyRestoreLoad(data, reason) {
    if (!data) return;
    clearHeavyRestoreLoadTimer(data);
    clearRestoreReveal(data);
    unregisterHeavyRestoreLoad(data);
    releaseHeavyRestoreSlot(data);
    if (!data.restoreLoading) return;
    data.restoreLoading = false;
    data.restoreQueued = false;
    data.visibleRestoreHoldUntil = 0;
    if (data.img) {
      if (window.ATPLoader && ATPLoader.cancelImageLoadElement) {
        ATPLoader.cancelImageLoadElement(data.img);
      } else {
        data.img.onload = null;
        data.img.onerror = null;
        data.img.removeAttribute('src');
        data.img.removeAttribute('srcset');
      }
      data.img.style.visibility = 'hidden';
    }
    data.unloaded = true;
    if (data.wrapper) {
      data.wrapper.classList.add('atp-heavy-unloaded');
      setHeavyPreviewActive(data, true);
    }
    logHeavyRender('render_restore_cancel', data, { reason: reason || 'restore_cancel' });
  }

  function startHeavyRestoreLoadTimer(wrapper, data) {
    clearHeavyRestoreLoadTimer(data);
    var settings = window.ATPState && window.ATPState.settings;
    var restoreTimeout = ATPLoader.getImageLoadTimeout
      ? ATPLoader.getImageLoadTimeout(settings, data.task)
      : ((settings && settings.imageTimeout) || 15000);
    data.restoreTimer = setTimeout(function() {
      if (!data.restoreLoading || heavyRenderItems.get(wrapper) !== data) return;
      cancelHeavyRestoreLoad(data, 'restore_timeout');
      scheduleHeavyRestoreRetry(wrapper, data, 'restore_timeout_retry');
    }, Math.max(1000, Number(restoreTimeout) || 15000));
  }

  function pauseActiveHeavyRestoreLoadTimers() {
    var entries = heavyRenderItems.entries();
    var entry = entries.next();
    while (!entry.done) {
      var data = entry.value[1];
      entry = entries.next();
      if (data && data.restoreLoading) clearHeavyRestoreLoadTimer(data);
    }
  }

  function resumeActiveHeavyRestoreLoadTimers(reason) {
    var entries = heavyRenderItems.entries();
    var entry = entries.next();
    while (!entry.done) {
      var wrapper = entry.value[0];
      var data = entry.value[1];
      entry = entries.next();
      if (!data || !data.restoreLoading || heavyRenderItems.get(wrapper) !== data) continue;
      if (data.img && data.restoreReveal && (data.img.currentSrc || data.img.src) && document.contains(wrapper)) {
        startHeavyRestoreLoadTimer(wrapper, data);
        logHeavyRender('render_restore_resume_wait', data, { reason: reason || 'resume_heavy_restores' });
      }
    }
  }

  function setHeavyPreviewActive(data, active) {
    if (!data || !data.wrapper) return;
    data.wrapper.classList.toggle('atp-heavy-preview-lightweight', !!(active && isHeavyThumbnailLightweightMode()));
    if (active && data.previewReady) {
      data.wrapper.classList.add('atp-heavy-preview-active');
      data.wrapper.classList.remove('atp-heavy-preview-pending');
    } else if (active) {
      data.wrapper.classList.remove('atp-heavy-preview-active');
      data.wrapper.classList.add('atp-heavy-preview-pending');
    } else {
      data.wrapper.classList.remove('atp-heavy-preview-active');
      data.wrapper.classList.remove('atp-heavy-preview-pending');
      data.wrapper.classList.remove('atp-heavy-preview-lightweight');
    }
    if (active) {
      markVisiblePreviewWaiting(data.wrapper, data);
    } else {
      clearVisiblePreviewWaiting(data);
    }
  }

  function clearHeavyPreview(data) {
    if (!data) return;
    clearDeferredHeavyPreviewPrewarm(data);
    setHeavyPreviewActive(data, false);
    if (data.previewCanvas && data.previewCanvas.parentNode) {
      data.previewCanvas.parentNode.removeChild(data.previewCanvas);
    }
    data.previewCanvas = null;
    data.previewReady = false;
    data.previewSrc = '';
  }

  function captureHeavyPreview(wrapper, data) {
    if (!wrapper || !data || !data.img || !data.img.complete || !data.img.naturalWidth) {
      return !!(data && data.previewReady && data.previewCanvas);
    }
    var src = data.img.currentSrc || data.img.src || data.src || '';
    if (!src && !data.previewReady) return false;
    // 同源同模式的预览已就绪则直接复用：预热后每次卸载都重画多百万像素源图
    // 且附带 clientWidth/Height 布局读取，纯属重复劳动
    if (data.previewReady && data.previewCanvas && data.previewSrc === src &&
      data.previewLightweight === isHeavyThumbnailLightweightMode()) {
      return true;
    }

    try {
      // 尺寸恒等于设置里的缩略图宽高（构建时内联写死），直接取设置值，
      // 避免在卸载批次里做 clientWidth/Height 布局读（写后读强制回流）
      var dimSettings = getCurrentSettings();
      var displayWidth = (dimSettings && dimSettings.thumbWidth) || data.img.clientWidth || 110;
      var displayHeight = (dimSettings && dimSettings.thumbHeight) || data.img.clientHeight || 82;
      var lightweightPreview = isHeavyThumbnailLightweightMode();
      var previewMaxEdge = lightweightPreview ? getHeavyLightweightPreviewMaxEdge() : 40;
      var canvasWidth = previewMaxEdge;
      var canvasHeight = Math.max(lightweightPreview ? 48 : 24, Math.round(canvasWidth * displayHeight / Math.max(1, displayWidth)));
      if (displayHeight > displayWidth) {
        canvasHeight = previewMaxEdge;
        canvasWidth = Math.max(lightweightPreview ? 48 : 24, Math.round(canvasHeight * displayWidth / Math.max(1, displayHeight)));
      }
      var naturalWidth = data.img.naturalWidth || data.naturalWidth || 0;
      var naturalHeight = data.img.naturalHeight || data.naturalHeight || 0;
      if (!naturalWidth || !naturalHeight) return !!data.previewReady;

      var canvas = data.previewCanvas;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.className = 'atp-heavy-preview-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        data.previewCanvas = canvas;
        wrapper.appendChild(canvas);
      }
      if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
      if (canvas.height !== canvasHeight) canvas.height = canvasHeight;

      // alpha:true：高斯边缘保留旧 CSS filter 的透明渐隐（落到 wrapper 底色上），
      // alpha:false 会在边缘拉出黑边
      var ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) return !!data.previewReady;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = lightweightPreview ? 'medium' : 'low';
      // 画布是被拉伸到显示尺寸的：只有两轴缩放比接近时，画布内的各向同性高斯
      // 在屏幕上才仍然各向同性。极端宽高比（画布短边被最小值钳位）退回 CSS filter，
      // 与 v1.16.7 行为一致
      var previewScaleX = displayWidth / Math.max(1, canvasWidth);
      var previewScaleY = displayHeight / Math.max(1, canvasHeight);
      var previewAspectSkew = Math.max(previewScaleX, previewScaleY) / Math.max(0.01, Math.min(previewScaleX, previewScaleY));
      var canBakeFilter = ('filter' in ctx) && (lightweightPreview || previewAspectSkew <= 1.25);
      canvas.classList.toggle('atp-heavy-preview-canvas-cssblur', !canBakeFilter);
      ctx.filter = 'none';
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      if (canBakeFilter) {
        if (lightweightPreview) {
          ctx.filter = 'saturate(0.98)';
        } else {
          var previewScale = Math.max(previewScaleX, previewScaleY);
          var blurSigma = Math.max(0.6, Math.round(HEAVY_PREVIEW_BLUR_DISPLAY_PX / Math.max(1, previewScale) * 100) / 100);
          ctx.filter = 'blur(' + blurSigma + 'px) saturate(0.95)';
        }
      }

      var sourceRatio = naturalWidth / naturalHeight;
      var targetRatio = canvasWidth / canvasHeight;
      var sx = 0;
      var sy = 0;
      var sw = naturalWidth;
      var sh = naturalHeight;
      if (sourceRatio > targetRatio) {
        sw = naturalHeight * targetRatio;
        sx = (naturalWidth - sw) / 2;
      } else if (sourceRatio < targetRatio) {
        sh = naturalWidth / targetRatio;
        sy = (naturalHeight - sh) / 2;
      }
      ctx.drawImage(data.img, sx, sy, sw, sh, 0, 0, canvasWidth, canvasHeight);
      ctx.filter = 'none';
      data.previewReady = true;
      data.previewSrc = src;
      data.previewLightweight = lightweightPreview;
      return true;
    } catch (e) {
      return !!data.previewReady;
    }
  }

  function clearDeferredHeavyPreviewPrewarm(data) {
    if (!data || !data.previewPrewarmTimer) return;
    if (data.previewPrewarmIdle && typeof cancelIdleCallback !== 'undefined') {
      cancelIdleCallback(data.previewPrewarmTimer);
    } else {
      clearTimeout(data.previewPrewarmTimer);
    }
    data.previewPrewarmTimer = null;
    data.previewPrewarmIdle = false;
  }

  function clearDeferredHeavyPreviewPrewarms() {
    var values = heavyRenderItems.values();
    var value = values.next();
    while (!value.done) {
      clearDeferredHeavyPreviewPrewarm(value.value);
      value = values.next();
    }
  }

  function prewarmHeavyPreview(wrapper, data, force) {
    if (!HEAVY_PREVIEW_PREWARM_ENABLED || !wrapper || !data || (data.previewReady && !force)) return false;
    var ready = captureHeavyPreview(wrapper, data);
    if (ready) setHeavyPreviewActive(data, false);
    return ready;
  }

  function scheduleDeferredHeavyPreviewPrewarm(wrapper, data) {
    if (!HEAVY_PREVIEW_PREWARM_ENABLED || !wrapper || !data || data.previewReady || data.previewPrewarmTimer) return;
    if (data.unloaded || data.restoreLoading || isLoaderPaused()) return;
    var run = function() {
      data.previewPrewarmTimer = null;
      data.previewPrewarmIdle = false;
      if (!wrapper || !data || heavyRenderItems.get(wrapper) !== data) return;
      if (data.previewReady || data.unloaded || data.restoreLoading || isLoaderPaused()) return;
      if (!document.contains(wrapper)) return;
      if (prewarmHeavyPreview(wrapper, data)) {
        logRenderStateThrottled(data, 'preview_prewarm');
      }
    };
    if (typeof requestIdleCallback !== 'undefined') {
      data.previewPrewarmIdle = true;
      // 800→200：这个窗口内若元素出界，卸载批次要现场把多百万像素源图缩到 40px（成串掉帧）
      data.previewPrewarmTimer = requestIdleCallback(run, { timeout: 200 });
    } else {
      data.previewPrewarmIdle = false;
      data.previewPrewarmTimer = setTimeout(run, 80);
    }
  }

  function removeQueuedHeavyRestore(wrapper, data) {
    data = data || heavyRenderItems.get(wrapper);
    if (data) data.restoreQueued = false;
    if (!heavyRestoreQueue.length) return;
    var queuedIndex = heavyRestoreQueue.indexOf(wrapper);
    if (queuedIndex !== -1) heavyRestoreQueue.splice(queuedIndex, 1);
  }

  function logRenderStateThrottled(data, reason, extra, renderContext) {
    var now = Date.now();
    if (now - lastRenderStateLogAt < RENDER_STATE_LOG_THROTTLE_MS) return;
    lastRenderStateLogAt = now;
    logHeavyRender('render_state', data, Object.assign({
      reason: reason,
      restoreQueue: heavyRestoreQueue.length
    }, extra || {}), renderContext);
  }

  var heavyRestoreTimerFireAt = 0;

  // 最早者胜：可见毛玻璃的快节奏请求不被挂起的慢节奏（如 420ms 滚动等待）吞掉
  function scheduleHeavyRestore(delay) {
    if (!heavyRestoreQueue.length || isLoaderPaused()) return;
    var effectiveDelay = Math.max(0, delay || 0);
    var fireAt = Date.now() + effectiveDelay;
    if (heavyRestoreTimer) {
      if (heavyRestoreTimerFireAt && fireAt >= heavyRestoreTimerFireAt) return;
      clearTimeout(heavyRestoreTimer);
      heavyRestoreTimer = null;
    }
    heavyRestoreTimerFireAt = fireAt;
    heavyRestoreTimer = setTimeout(function() {
      heavyRestoreTimerFireAt = 0;
      processHeavyRestoreQueue();
    }, effectiveDelay);
  }

  function deferHeavyRestore(wrapper, data, reason, extra, viewportState) {
    setHeavyPreviewActive(data, true);
    var waitMS = markVisiblePreviewWaiting(wrapper, data);
    logRenderStateThrottled(data, reason || getRestoreBudgetBlockReason(wrapper, data), Object.assign({
      budgetCount: getHeavyDecodedImageLimit(),
      budgetMP: getHeavyDecodedBudgetMP(),
      visibleRestoreBudgetMP: getHeavyVisibleRestoreBudgetMP(),
      visibleRestoreMinKeep: HEAVY_VISIBLE_RESTORE_MIN_KEEP,
      visiblePreviewWaitMS: waitMS,
      visiblePreviewMaxWaitMS: HEAVY_VISIBLE_PREVIEW_MAX_WAIT_MS,
      visiblePreviewGraceMP: getHeavyVisiblePreviewGraceMP(),
      visibleRestoreGraceMS: HEAVY_VISIBLE_RESTORE_GRACE_MS,
      visiblePreviewStableGraceWaitMS: getVisiblePreviewStableGraceWaitMS(),
      visiblePreviewStableGraceMP: getHeavyVisibleStableGraceMP(),
      visiblePreviewLateGraceWaitMS: getVisiblePreviewLateGraceWaitMS(),
      visiblePreviewLateGraceMP: getHeavyVisibleLateGraceMP(),
      visiblePreviewLastChanceWaitMS: getVisiblePreviewLastChanceWaitMS(),
      visiblePreviewLastChanceMP: getHeavyVisibleLastChanceMP(),
      visiblePreviewStarvationWaitMS: getVisiblePreviewStarvationWaitMS(),
      visiblePreviewStarvationMP: getVisiblePreviewStarvationMP(),
      heavyThumbnailClarity: getHeavyThumbnailClarity(),
      heavyLightweightPreviewMaxEdge: getHeavyLightweightPreviewMaxEdge(),
      heavyRestoreDeferRetryMS: HEAVY_RESTORE_DEFER_RETRY_DELAY
    }, extra || {}));
    viewportState = viewportState || getViewportRectState(wrapper);
    if (wrapper && viewportState.visible) {
      scheduleHeavyBudgetReconcile('visible_preview_defer_retry', HEAVY_RESTORE_DEFER_RETRY_DELAY);
    }
  }

  function queueHeavyRestore(wrapper, data, reason, skipBudgetCheck, budget) {
    if (!data || !data.unloaded || data.restoreQueued) return;
    var viewportState = getViewportRectState(wrapper);
    if (!document.contains(wrapper) || !viewportState.inHeavyRestoreRange) return;
    if (isHeavyThumbnailLightweightMode()) {
      data.lightweightModeHold = true;
      setHeavyPreviewActive(data, true);
      logRenderStateThrottled(data, 'lightweight_mode_hold', {
        reason: reason || 'lightweight_mode_hold',
        heavyThumbnailClarity: getHeavyThumbnailClarity()
      });
      return;
    }
    data.lightweightModeHold = false;
    var allowed = skipBudgetCheck && !viewportState.visible
      ? true
      : isHeavyRestoreBudgetAllowed(wrapper, data, viewportState, budget);
    if (!allowed && (!skipBudgetCheck || viewportState.visible)) {
      deferHeavyRestore(wrapper, data, getRestoreBudgetBlockReason(wrapper, data, viewportState, budget), null, viewportState);
      return;
    }
    data.restoreQueued = true;
    data.restoreQueuedAt = Date.now();
    heavyRestoreQueue.push(wrapper);
    logRenderStateThrottled(
      data,
      data.visiblePreviewGraceActive ? getVisiblePreviewGraceReason(data) : (reason || 'restore_queued'),
      getVisiblePreviewLogFields(data)
    );
    // 非滚动状态下，可见毛玻璃入队立即用快节奏启动恢复（用户正看着它）
    scheduleHeavyRestore(isHeavyScrollActive()
      ? HEAVY_RESTORE_SCROLL_DELAY
      : (viewportState.visible ? HEAVY_RESTORE_VISIBLE_NEXT_DELAY : HEAVY_RESTORE_BATCH_DELAY));
  }

  function processHeavyRestoreQueue() {
    heavyRestoreTimer = null;
    if (isLoaderPaused()) return;
    if (!heavyRestoreQueue.length) return;

    var sampleData = null;
    if (isHeavyScrollActive()) {
      sampleData = heavyRenderItems.get(heavyRestoreQueue[0]);
      if (sampleData) setHeavyPreviewActive(sampleData, true);
      logRenderStateThrottled(sampleData, 'restore_defer_scroll', getVisiblePreviewLogFields(sampleData));
      scheduleHeavyRestore(HEAVY_RESTORE_SCROLL_DELAY);
      return;
    }

    var restoreQueueViewportState = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    var restoreQueueBudget = null;
    function getRestoreQueueViewportState(wrapper) {
      if (!restoreQueueViewportState) return getViewportRectState(wrapper);
      var state = restoreQueueViewportState.get(wrapper);
      if (!state) {
        state = getViewportRectState(wrapper);
        restoreQueueViewportState.set(wrapper, state);
      }
      return state;
    }
    function getRestoreQueueBudget() {
      if (!restoreQueueBudget) restoreQueueBudget = getBudgetSelection();
      return restoreQueueBudget;
    }

    var writeIndex = 0;
    for (var readIndex = 0; readIndex < heavyRestoreQueue.length; readIndex++) {
      var wrapper = heavyRestoreQueue[readIndex];
      var data = heavyRenderItems.get(wrapper);
      if (!data) continue;
      if (!document.contains(wrapper) || (ATPLoader.isTaskCurrent && !ATPLoader.isTaskCurrent(data.task))) {
        cleanupHeavyRenderItem(wrapper, true);
        restoreQueueBudget = null;
        continue;
      }
      if (!data.unloaded) {
        data.restoreQueued = false;
        continue;
      }
      if (isHeavyThumbnailLightweightMode()) {
        data.restoreQueued = false;
        data.lightweightModeHold = true;
        setHeavyPreviewActive(data, true);
        logRenderStateThrottled(data, 'lightweight_mode_hold', {
          reason: 'restore_queue_lightweight_mode',
          heavyThumbnailClarity: getHeavyThumbnailClarity()
        });
        continue;
      }
      var viewportState = getRestoreQueueViewportState(wrapper);
      if (!viewportState.inHeavyRestoreRange) {
        data.restoreQueued = false;
        continue;
      }
      if (!isHeavyRestoreBudgetAllowed(wrapper, data, viewportState, getRestoreQueueBudget())) {
        data.restoreQueued = false;
        deferHeavyRestore(wrapper, data, getRestoreBudgetBlockReason(wrapper, data, viewportState, getRestoreQueueBudget()), null, viewportState);
        continue;
      }
      heavyRestoreQueue[writeIndex++] = wrapper;
    }
    heavyRestoreQueue.length = writeIndex;
    // 排序前一次性算好 MP，比较器内做布局读取会放大成 O(n log n) 次强制回流
    var restoreQueueMP = new Map();
    for (var mpIndex = 0; mpIndex < heavyRestoreQueue.length; mpIndex++) {
      var mpWrapper = heavyRestoreQueue[mpIndex];
      restoreQueueMP.set(mpWrapper, getDataDecodedMP(heavyRenderItems.get(mpWrapper)));
    }
    heavyRestoreQueue.sort(function(a, b) {
      var aState = getRestoreQueueViewportState(a);
      var bState = getRestoreQueueViewportState(b);
      var aVisible = aState.visible;
      var bVisible = bState.visible;
      if (aVisible !== bVisible) return aVisible ? -1 : 1;
      if (aVisible && bVisible) {
        var mpDiff = (restoreQueueMP.get(a) || 0) - (restoreQueueMP.get(b) || 0);
        if (mpDiff) return mpDiff;
      }
      return aState.centerDistance - bState.centerDistance;
    });

    var restored = 0;
    var restoredMP = 0;
    var nextDelay = HEAVY_RESTORE_FAST_DELAY;
    var restorePressure = 'none';
    var projectedVisibleMP = 0;
    var projectedRangeMP = 0;
    var restoredVisibleMP = 0;
    var restoredRangeMP = 0;
    var fastBatchLimit = getHeavyRestoreFastBatchSize();
    var pressureBatchLimit = getHeavyRestorePressureBatchSize();
    var batchLimit = Math.max(fastBatchLimit, pressureBatchLimit);
    var fastRestored = 0;
    var pressureRestored = 0;
    var consumeIndex = 0;
    while (consumeIndex < heavyRestoreQueue.length && restored < batchLimit) {
      var wrapper = heavyRestoreQueue[consumeIndex];
      var data = heavyRenderItems.get(wrapper);
      if (!data || !data.unloaded) {
        consumeIndex++;
        continue;
      }
      var viewportState = getRestoreQueueViewportState(wrapper);
      var mp = getDataDecodedMP(data);
      var delayInfo = getHeavyRestoreDelayInfo(mp, getRestoreQueueBudget().snapshot.stats, restoredVisibleMP, restoredRangeMP);
      if (restored > 0 && (
        isMPBudgetReached(delayInfo.projectedVisibleMP, getHeavyVisibleRestoreBudgetMP()) ||
        isMPBudgetReached(delayInfo.projectedRangeMP, getHeavyDecodedBudgetMP())
      )) {
        data.restoreQueued = true;
        break;
      }
      var fastLane = delayInfo.pressure === 'fast';
      var laneCount = fastLane ? fastRestored : pressureRestored;
      var laneLimit = fastLane ? fastBatchLimit : pressureBatchLimit;
      if (laneCount >= laneLimit) {
        data.restoreQueued = true;
        break;
      }
      data.restoreQueued = false;
      if (!restoreHeavyImage(wrapper, data)) {
        data.restoreQueued = true;
        break;
      }
      sampleData = data;
      restoredMP += mp;
      if (viewportState.visible) restoredVisibleMP += mp;
      if (viewportState.inHeavyRestoreRange) restoredRangeMP += mp;
      nextDelay = Math.max(nextDelay, delayInfo.delay);
      restorePressure = delayInfo.pressure;
      projectedVisibleMP = delayInfo.projectedVisibleMP;
      projectedRangeMP = delayInfo.projectedRangeMP;
      restored++;
      if (fastLane) fastRestored++;
      else pressureRestored++;
      consumeIndex++;
    }
    if (consumeIndex > 0) heavyRestoreQueue.splice(0, consumeIndex);
    if (sampleData) {
      logRenderStateThrottled(sampleData, 'restore_batch', {
        restored: restored,
        batchMP: roundMP(restoredMP),
        nextDelay: nextDelay,
        restorePressure: restorePressure,
        projectedVisibleMP: projectedVisibleMP,
        projectedRangeMP: projectedRangeMP,
        visibleRestoreSoftBudgetMP: getHeavyVisibleRestoreSoftBudgetMP(),
        rangeRestoreSoftBudgetMP: getHeavyRangeRestoreSoftBudgetMP(),
        restoreFastBatchSize: fastBatchLimit,
        restorePressureBatchSize: pressureBatchLimit,
        restoreFastMP: HEAVY_RESTORE_FAST_MP
      }, restoreQueueBudget && restoreQueueBudget.snapshot);
    }
    reconcileHeavyRenderBudget('after_restore_batch');
    if (heavyRestoreQueue.length) {
      // 本轮一张都没恢复 = 队头被槽位占用挡住：按延后重试节奏轮询（420ms）而不是
      // 90ms 快速节奏——快速节奏下每次空转都要重跑整队过滤 + 全量快照
      var continueDelay;
      if (restored > 0) {
        continueDelay = nextDelay;
        // 队首下一个仍是可见毛玻璃时压缩续批间隔：用户正看着它一格一格变清晰
        var nextHead = heavyRestoreQueue[0];
        var nextHeadData = heavyRenderItems.get(nextHead);
        if (nextHeadData && nextHeadData.unloaded && getRestoreQueueViewportState(nextHead).visible) {
          continueDelay = Math.min(continueDelay, HEAVY_RESTORE_VISIBLE_NEXT_DELAY);
        }
      } else {
        continueDelay = HEAVY_RESTORE_DEFER_RETRY_DELAY;
      }
      scheduleHeavyRestore(continueDelay);
    }
  }

  function cleanupHeavyRenderItem(wrapper, skipQueueRemove) {
    var data = heavyRenderItems.get(wrapper);
    if (!data) return;
    cancelHeavyRestoreLoad(data, 'cleanup');
    clearHeavyPreview(data);
    if (!skipQueueRemove) removeQueuedHeavyRestore(wrapper, data);
    heavyRenderItems.delete(wrapper);
    if (heavyRenderObserver) heavyRenderObserver.unobserve(wrapper);
    unobserveLoadingAnimation(wrapper);
  }

  function unloadHeavyImage(wrapper, data, extra, renderContext) {
    if (!data || data.unloaded || !data.img || !document.contains(wrapper)) return false;
    if ((!data.img.complete || !data.img.naturalWidth) && !data.restoreLoading) return false;
    data.src = data.img.currentSrc || data.img.src || data.src;
    if (!data.src) return false;
    data.naturalWidth = data.img.naturalWidth || data.naturalWidth || 0;
    data.naturalHeight = data.img.naturalHeight || data.naturalHeight || 0;
    data.noReferrer = data.img.referrerPolicy === 'no-referrer';
    var wasRestoreLoading = !!data.restoreLoading;
    var previousVisibility = data.img.style.visibility;
    data.restoreLoading = false;
    data.visibleRestoreHoldUntil = 0;
    data.visibleSeenAt = 0;
    data.visibleLocked = false;
    clearDeferredHeavyPreviewPrewarm(data);
    var previewReady = captureHeavyPreview(wrapper, data);
    if (!previewReady) {
      data.restoreLoading = wasRestoreLoading;
      data.lightweightModeHold = false;
      data.img.style.visibility = wasRestoreLoading ? previousVisibility : '';
      wrapper.classList.remove('atp-heavy-unloaded');
      clearHeavyPreview(data);
      logHeavyRender('preview_capture_failed_keep_loaded', data, Object.assign({
        srcReleased: false,
        previewKept: false
      }, extra || {}), renderContext);
      return false;
    }
    clearHeavyRestoreLoadTimer(data);
    clearRestoreReveal(data);
    unregisterHeavyRestoreLoad(data);
    releaseHeavyRestoreSlot(data);
    removeQueuedHeavyRestore(wrapper, data);
    data.img.style.visibility = 'hidden';
    data.img.removeAttribute('src');
    data.unloaded = true;
    data.restoreRetryCount = 0;
    wrapper.classList.add('atp-heavy-unloaded');
    setHeavyPreviewActive(data, true);
    logHeavyRender('render_unload', data, Object.assign({
      srcReleased: true,
      previewKept: previewReady
    }, extra || {}), renderContext);
    return true;
  }

  function restoreHeavyImage(wrapper, data) {
    if (!data || !data.unloaded || !data.img || !document.contains(wrapper)) return false;
    if (!data.src) return false;
    var restoreVisible = isActuallyVisibleForRequest(wrapper);
    if (data.task && ATPLoader.updateTaskViewportPriority) {
      ATPLoader.updateTaskViewportPriority(data.task, wrapper, restoreVisible);
    } else if (data.task) {
      data.task.currentlyVisible = restoreVisible;
      data.task.viewportPriority = restoreVisible;
    }
    if (data.task && ATPLoader.acquireSlot) {
      data.task.taskDeadlineAt = 0;
      if (!ATPLoader.acquireSlot(data.task)) {
        // 可见毛玻璃的恢复大概率命中 HTTP 缓存（原图刚下过），却要和屏外首载抢同一批全局槽；
        // 抢不到就退化成 420ms 空转轮询，用户正盯着的那张白等。
        // 这里放行「同时至多 1 张」免槽的可见恢复，屏外恢复行为不变
        var hostCooling = !!(ATPLoader.isTaskHostCoolingDown && ATPLoader.isTaskHostCoolingDown(data.task));
        if (!restoreVisible || hostCooling || heavySlotFreeVisibleRestores > 0) {
          logRenderStateThrottled(data, 'restore_slot_wait', {
            actualVisible: restoreVisible,
            restoreUsesGlobalSlot: true
          });
          return false;
        }
        heavySlotFreeVisibleRestores++;
        data.restoreSlotFree = true;
      } else {
        data.restoreSlotToken = ATPLoader.getActiveSlotToken
          ? ATPLoader.getActiveSlotToken(data.task)
          : data.task.activeSlotToken;
      }
    }
    var visiblePreviewWaitMS = getVisiblePreviewWaitMS(data);
    var visiblePreviewGrace = !!data.visiblePreviewGraceActive;
    var visiblePreviewGraceMode = data.visiblePreviewGraceMode || '';
    clearVisiblePreviewWaiting(data);
    data.unloaded = false;
    data.restoreLoading = true;
    data.restoreQueued = false;
    data.visibleSeenAt = 0;
    data.visibleLocked = false;
    wrapper.classList.remove('atp-heavy-unloaded');
    setHeavyPreviewActive(data, true);
    data.img.style.visibility = 'hidden';
    clearRestoreReveal(data);
    unregisterHeavyRestoreLoad(data);
    var reveal = function(evt) {
      var didLoad = !evt || evt.type === 'load';
      clearHeavyRestoreLoadTimer(data);
      unregisterHeavyRestoreLoad(data);
      releaseHeavyRestoreSlot(data);
      data.restoreLoading = false;
      data.naturalWidth = data.img.naturalWidth || data.naturalWidth || 0;
      data.naturalHeight = data.img.naturalHeight || data.naturalHeight || 0;
      clearRestoreReveal(data);
      if (didLoad) {
        data.restoreRetryCount = 0;
        if (isHeavyThumbnailLightweightMode()) {
          var restoredPreviewReady = prewarmHeavyPreview(wrapper, data, true);
          data.lightweightModeHold = true;
          data.img.style.visibility = 'hidden';
          if (unloadHeavyImage(wrapper, data, {
            reason: 'lightweight_mode_unload',
            heavyThumbnailClarity: getHeavyThumbnailClarity(),
            restoredThenLightweight: true,
            previewPrewarmed: restoredPreviewReady
          })) return;
        }
        data.lightweightModeHold = false;
        data.img.style.visibility = '';
        setHeavyPreviewActive(data, false);
        var now = Date.now();
        var visible = isInViewport(wrapper);
        data.visibleSeenAt = visible ? now : 0;
        data.visibleRestoreHoldUntil = visible ? now + HEAVY_VISIBLE_RESTORE_SETTLE_MS : 0;
        data.visibleLocked = false;
        reconcileHeavyRenderBudget('restore_loaded');
        scheduleDeferredHeavyPreviewPrewarm(wrapper, data);
        return;
      }
      data.unloaded = true;
      data.img.style.visibility = 'hidden';
      data.img.removeAttribute('src');
      wrapper.classList.add('atp-heavy-unloaded');
      setHeavyPreviewActive(data, true);
      data.visibleSeenAt = 0;
      data.visibleLocked = false;
      logHeavyRender('render_restore_error', data, { previewKept: !!data.previewReady });
      scheduleHeavyRestoreRetry(wrapper, data, 'restore_error_retry');
    };
    data.restoreReveal = reveal;
    data.img.addEventListener('load', data.restoreReveal);
    data.img.addEventListener('error', data.restoreReveal);
    if (ATPLoader.registerActiveImageLoad) {
      data.restoreActiveUnregister = ATPLoader.registerActiveImageLoad({
        cancel: function(reason) {
          cancelHeavyRestoreLoad(data, reason || 'active_restore_cancel');
        },
        recover: function(reason) {
          if (data.img && data.img.complete && data.img.naturalWidth && data.restoreReveal) {
            data.restoreReveal({ type: 'load' });
            return;
          }
          if (
            data.restoreLoading &&
            data.img &&
            data.restoreReveal &&
            (data.img.currentSrc || data.img.src) &&
            document.contains(wrapper) &&
            heavyRenderItems.get(wrapper) === data
          ) {
            startHeavyRestoreLoadTimer(wrapper, data);
            logHeavyRender('render_restore_recover_wait', data, { reason: reason || 'active_restore_recover' });
            return;
          }
          cancelHeavyRestoreLoad(data, reason || 'active_restore_recover');
          scheduleHeavyRestoreRetry(wrapper, data, 'active_restore_recover_retry');
        }
      });
    }
    if (data.task && ATPLoader.prepareThumbnailImage) {
      var restoreSettings = getCurrentSettings() || {};
      data.task.viewportPriority = isActuallyVisibleForRequest(wrapper);
      data.task.forceEager = false;
      data.task.forceEagerLowPriority = false;
      data.task.forcePreload = !data.task.viewportPriority;
      ATPLoader.prepareThumbnailImage(
        data.img,
        data.task,
        restoreSettings.thumbWidth || 110,
        restoreSettings.thumbHeight || 82
      );
    }
    startHeavyRestoreLoadTimer(wrapper, data);
    ATPLoader.setImageSource(data.img, data.src, data.noReferrer, function() {
      return heavyRenderItems.get(wrapper) === data && document.contains(wrapper) && !data.unloaded;
    });
    logHeavyRender('render_restore', data, {
      srcRestored: true,
      restoreUsesGlobalSlot: true,
      visiblePreviewWaitMS: visiblePreviewWaitMS,
      visiblePreviewGrace: visiblePreviewGrace,
      visiblePreviewGraceMode: visiblePreviewGraceMode
    });
    return true;
  }

  function reconcileHeavyRenderBudget(reason) {
    if (reconcilingHeavyBudget || !heavyRenderItems.size) return;
    reconcilingHeavyBudget = true;
    var sampleData = null;
    var unloaded = 0;
    var visibleUnloaded = 0;
    var queued = 0;
    var needsFollowup = false;
    var visiblePreviewDeferred = 0;
    var visiblePreviewStuck = 0;
    var needsPreviewRetry = false;
    var budgetSnapshot = null;

    try {
      var budget = getBudgetSelection();
      budgetSnapshot = budget.snapshot;
      var selected = budget.selected;
      var visibleResult = reconcileVisibleRenderPressure(budget.snapshot, selected, HEAVY_UNLOAD_BATCH_SIZE);
      visibleUnloaded = visibleResult.unloaded;
      if (visibleUnloaded) unloaded += visibleUnloaded;
      needsFollowup = !!visibleResult.limited;
      var remainingUnloads = Math.max(0, HEAVY_UNLOAD_BATCH_SIZE - visibleUnloaded);
      visiblePreviewStuck = reconcileVisiblePreviewRoom(budget.snapshot).stuck;
      var budgetItems = budget.snapshot.items || [];
      for (var bi = 0; bi < budgetItems.length; bi++) {
        var item = budgetItems[bi];
        if (!item || !item.inRange) continue;
        sampleData = sampleData || item.data;
        if (item.loaded && !item.visible && !selected.has(item.wrapper)) {
          if (remainingUnloads <= 0) {
            needsFollowup = true;
            continue;
          }
          unloadHeavyImage(item.wrapper, item.data, {
            reason: 'budget_unload',
            budgetCount: getHeavyDecodedImageLimit(),
            budgetMP: getHeavyDecodedBudgetMP(),
            heavyUnloadBatchSize: HEAVY_UNLOAD_BATCH_SIZE,
            selectedCount: selected.count,
            selectedMP: selected.mp
          }, budgetSnapshot);
          unloaded++;
          remainingUnloads--;
        }
      }

      for (var qi = 0; qi < budgetItems.length; qi++) {
        var queueItem = budgetItems[qi];
        if (!queueItem || !queueItem.inRange || !queueItem.data || !queueItem.data.unloaded) continue;
        if (!queueItem.visible && !selected.has(queueItem.wrapper)) continue;
        sampleData = sampleData || queueItem.data;
        queueHeavyRestore(queueItem.wrapper, queueItem.data, 'budget_queue', true, budget);
        if (queueItem.data.restoreQueued) queued++;
        if (queueItem.visible && queueItem.data.unloaded && queueItem.data.visiblePreviewSince && !queueItem.data.restoreQueued) {
          visiblePreviewDeferred++;
          needsPreviewRetry = true;
        }
      }
    } finally {
      reconcilingHeavyBudget = false;
    }

    if (sampleData && (unloaded || queued || visiblePreviewDeferred || visiblePreviewStuck)) {
      logRenderStateThrottled(sampleData, reason || 'budget_reconcile', {
        budgetUnloaded: unloaded,
        visibleBudgetUnloaded: visibleUnloaded,
        visiblePreviewStuck: visiblePreviewStuck,
        budgetQueued: queued,
        visiblePreviewDeferred: visiblePreviewDeferred,
        budgetFollowup: needsFollowup,
        visiblePreviewRetry: needsPreviewRetry,
        heavyUnloadBatchSize: HEAVY_UNLOAD_BATCH_SIZE
      }, budgetSnapshot);
    }
    if (needsFollowup) {
      scheduleHeavyBudgetReconcile('budget_reconcile_followup', HEAVY_BUDGET_RECONCILE_DELAY);
    } else if (needsPreviewRetry) {
      scheduleHeavyBudgetReconcile('visible_preview_defer_retry', HEAVY_RESTORE_DEFER_RETRY_DELAY);
    }
  }

  // 出界卸载去抖：边界附近的轻微滚动抖动会让同一元素反复 卸载→重下→重解码。
  // 出界事件先入集合，短暂延迟后复核几何位置，仍在界外才真正卸载
  var HEAVY_EXIT_UNLOAD_DEBOUNCE_MS = 300;
  var heavyExitUnloadPending = new Set();
  var heavyExitUnloadTimer = null;

  function clearHeavyExitUnloads() {
    if (heavyExitUnloadTimer) {
      clearTimeout(heavyExitUnloadTimer);
      heavyExitUnloadTimer = null;
    }
    heavyExitUnloadPending.clear();
  }

  function flushHeavyExitUnloads() {
    heavyExitUnloadTimer = null;
    if (!heavyExitUnloadPending.size) return;
    var pending = heavyExitUnloadPending;
    heavyExitUnloadPending = new Set();
    var unloadedAny = false;
    pending.forEach(function(wrapper) {
      var data = heavyRenderItems.get(wrapper);
      if (!data || data.unloaded || !data.img) return;
      if (!document.contains(wrapper)) {
        cleanupHeavyRenderItem(wrapper);
        return;
      }
      // 以此刻的真实几何复核：去抖窗口内折返的元素不卸载（原地免去一次重下载+重解码）
      var state = getViewportRectState(wrapper);
      if (state.visible || state.inHeavyRestoreRange) return;
      if (unloadHeavyImage(wrapper, data)) unloadedAny = true;
    });
    if (unloadedAny) scheduleHeavyBudgetReconcile('exit_unload_flush', 0);
  }

  function scheduleHeavyExitUnload(wrapper) {
    heavyExitUnloadPending.add(wrapper);
    if (!heavyExitUnloadTimer) {
      heavyExitUnloadTimer = setTimeout(flushHeavyExitUnloads, HEAVY_EXIT_UNLOAD_DEBOUNCE_MS);
    }
  }

  function initHeavyRenderObserver() {
    if (heavyRenderObserver) return;
    heavyRenderObserver = new IntersectionObserver(function(entries) {
      var observerBudget = null;
      for (var ei = 0; ei < entries.length; ei++) {
        var entry = entries[ei];
        var wrapper = entry.target;
        var data = heavyRenderItems.get(wrapper);
        if (!data) continue;
        if (!document.contains(wrapper) || (ATPLoader.isTaskCurrent && !ATPLoader.isTaskCurrent(data.task))) {
          cleanupHeavyRenderItem(wrapper);
          continue;
        }
        if (entry.isIntersecting) {
          heavyExitUnloadPending.delete(wrapper);
          if (data.unloaded && !observerBudget) observerBudget = getBudgetSelection();
          queueHeavyRestore(wrapper, data, 'observer', false, observerBudget);
        } else {
          scheduleHeavyExitUnload(wrapper);
        }
      }
      // 滚动中不立刻做全量预算对账（加载与恢复本就在滚动中延迟，可见/附近 MP 不会增长；
      // 滚动停止时 resumeHeavyRestores 会立即对账一次），避免快速滚动时每帧两次全量快照
      scheduleHeavyBudgetReconcile('observer', isHeavyScrollActive() ? HEAVY_RESTORE_SCROLL_DELAY : 0);
    }, {
      root: null,
      rootMargin: HEAVY_RENDER_MARGIN,
      threshold: 0
    });
  }

  function getViewportPendingLogFields(wrapper, wrapperData, forceLoad) {
    var now = Date.now();
    return {
      viewportLazy: true,
      viewportPending: pendingWrappers.size,
      pendingCountAtLoad: wrapperData && wrapperData.pendingCountAtLoad,
      pendingAgeMs: wrapperData && wrapperData.observedAt ? Math.max(0, now - wrapperData.observedAt) : undefined,
      loadStartedAgeMs: wrapperData && wrapperData.loadStartedAt ? Math.max(0, now - wrapperData.loadStartedAt) : undefined,
      pendingBeforeLoadMs: wrapperData && wrapperData.observedAt && wrapperData.loadStartedAt
        ? Math.max(0, wrapperData.loadStartedAt - wrapperData.observedAt)
        : undefined,
      pendingCreatedDistancePx: wrapperData && wrapperData.pendingCreatedDistancePx,
      pendingCurrentDistancePx: getVerticalDistanceFromViewportPx(wrapper),
      lightweightPreloadEligible: !!(wrapperData && wrapperData.lightweightPreloadEligible),
      lightweightPreloadTriggered: !!(wrapperData && wrapperData.lightweightPreloadTriggered),
      lightweightPreloadMarginPx: wrapperData && wrapperData.lightweightPreloadEligible
        ? (wrapperData.lightweightPreloadMarginPx || getLightweightHeavyPreloadMarginPx())
        : undefined,
      preloadMissReason: getLightweightPreloadMissReason(wrapperData, forceLoad),
      lightweightPreloadAgeMs: wrapperData && wrapperData.lightweightPreloadObservedAt
        ? Math.max(0, now - wrapperData.lightweightPreloadObservedAt)
        : undefined,
      lightweightPreloadBeforeLoadMs: wrapperData && wrapperData.lightweightPreloadTriggeredAt && wrapperData.loadStartedAt
        ? Math.max(0, wrapperData.loadStartedAt - wrapperData.lightweightPreloadTriggeredAt)
        : undefined,
      forceLoadReason: wrapperData && wrapperData.forceLoadReason,
      inViewport: !!(wrapperData && wrapperData.inViewport),
      inViewportAgeMs: wrapperData && wrapperData.inViewportAt ? Math.max(0, now - wrapperData.inViewportAt) : undefined,
      actualInViewport: !!(wrapperData && wrapperData.actualInViewport),
      visibleBeforeLoadMs: wrapperData && wrapperData.visibleBeforeLoadMs !== undefined
        ? wrapperData.visibleBeforeLoadMs
        : undefined,
      forceLoad: !!forceLoad,
      forceLoadWhenHidden: !!(wrapperData && wrapperData.forceLoadWhenHidden),
      slotRetries: (wrapperData && wrapperData.slotRetries) || 0,
      wrapperConnected: !!(wrapper && document.contains(wrapper)),
      documentVisibility: document.visibilityState
    };
  }

  function initLightweightHeavyPreloadObserver() {
    prunePendingWrappers(true);
    var marginPx = getLightweightHeavyPreloadMarginPx();
    var margin = marginPx + 'px 0px';
    if (lightweightHeavyPreloadObserver && lightweightHeavyPreloadMargin === margin) return;
    if (lightweightHeavyPreloadObserver) {
      lightweightHeavyPreloadObserver.disconnect();
    }
    lightweightHeavyPreloadMarginPx = marginPx;
    lightweightHeavyPreloadMargin = margin;
    lightweightHeavyPreloadObserver = new IntersectionObserver(function(entries) {
      for (var ei = 0; ei < entries.length; ei++) {
        var entry = entries[ei];
        var wrapper = entry.target;
        var wrapperData = pendingWrappers.get(wrapper);
        if (!wrapperData || wrapperData.loaded || !wrapperData.lightweightPreloadEligible) continue;
        wrapperData.lightweightPreloadInRange = !!entry.isIntersecting;
        if (!entry.isIntersecting) {
          if (!wrapperData.inViewport && !wrapperData.forceLoadWhenHidden) clearPendingSlotRetry(wrapperData);
          continue;
        }
        var now = Date.now();
        if (!wrapperData.lightweightPreloadTriggered) lightweightPreloadTriggeredTotal++;
        wrapperData.lightweightPreloadTriggered = true;
        if (!wrapperData.lightweightPreloadTriggeredAt) wrapperData.lightweightPreloadTriggeredAt = now;
        wrapperData.forceLoadReason = 'lightweight_preload';
        ATPViewport.loadWrapper(wrapper, wrapperData, true);
      }
    }, {
      root: null,
      rootMargin: margin,
      threshold: 0
    });
    var pendingEntries = pendingWrappers.entries();
    var pendingEntry = pendingEntries.next();
    while (!pendingEntry.done) {
      var wrapper = pendingEntry.value[0];
      var data = pendingEntry.value[1];
      pendingEntry = pendingEntries.next();
      if (data && !data.loaded && data.lightweightPreloadEligible) {
        data.lightweightPreloadMarginPx = marginPx;
        lightweightHeavyPreloadObserver.observe(wrapper);
      }
    }
  }

  function getLazyViewportRootMargin(root) {
    var margins = getLazyMargins(root);
    return margins.top + 'px 0px ' + margins.bottom + 'px 0px';
  }

  function handleViewportIntersections(entries) {
    for (var ei = 0; ei < entries.length; ei++) {
      var entry = entries[ei];
      var wrapper = entry.target;
      var wrapperData = pendingWrappers.get(wrapper);
      if (!wrapperData) continue;
      wrapperData.inViewport = !!entry.isIntersecting;
      wrapperData.lastIntersectionAt = Date.now();

      if (entry.isIntersecting) {
        if (!wrapperData.inViewportAt) wrapperData.inViewportAt = wrapperData.lastIntersectionAt;
        ATPViewport.loadWrapper(wrapper, wrapperData, false);
      } else if (wrapperData.slotRetryPending && !wrapperData.forceLoadWhenHidden && !wrapperData.lightweightPreloadInRange) {
        wrapperData.inViewportAt = 0;
        clearPendingSlotRetry(wrapperData);
      } else {
        wrapperData.inViewportAt = 0;
      }
    }
  }

  function createViewportObserver(root) {
    return new IntersectionObserver(handleViewportIntersections, {
      root: root || null,
      rootMargin: getLazyViewportRootMargin(root),
      threshold: 0.01
    });
  }

  var nullRootObserverMarginStale = false;

  function ensureViewportObserver(root) {
    if (!root) {
      // 空目标期错过的边距变更在此惰性补建（见 rebuildViewportObserver 的跳过分支）
      if (!viewportObserver) {
        viewportObserver = createViewportObserver(null);
      } else if (nullRootObserverMarginStale) {
        viewportObserver.disconnect();
        viewportObserver = createViewportObserver(null);
      }
      nullRootObserverMarginStale = false;
      initLoadingAnimationObserver();
      return viewportObserver;
    }
    var state = getLazyRootState(root, true);
    if (!state.observer) state.observer = createViewportObserver(root);
    initLoadingAnimationObserver();
    return state.observer;
  }

  function rebuildViewportObserver(root) {
    // 先数一下该 root 下有没有被观察对象：零目标时跳过 断开/新建 churn，
    // 只标记边距过期，等下一个 wrapper 注册时（ensureViewportObserver）惰性重建
    var targets = [];
    var pendingEntries = pendingWrappers.entries();
    var pendingEntry = pendingEntries.next();
    while (!pendingEntry.done) {
      var wrapper = pendingEntry.value[0];
      var data = pendingEntry.value[1];
      pendingEntry = pendingEntries.next();
      if ((data && data.observerRoot || null) === (root || null)) targets.push(wrapper);
    }
    if (!targets.length) {
      if (!root) nullRootObserverMarginStale = true;
      return;
    }
    var current = getViewportObserverForRoot(root);
    if (current) current.disconnect();
    var next = createViewportObserver(root);
    if (root) getLazyRootState(root, true).observer = next;
    else viewportObserver = next;
    if (!root) nullRootObserverMarginStale = false;
    initLoadingAnimationObserver();
    for (var i = 0; i < targets.length; i++) next.observe(targets[i]);
  }

  function getLazyMode(root) {
    var state = getLazyRootState(root, false);
    return state ? state.mode : lazyViewportMode;
  }

  function applyLazyViewportMode(root, mode, now) {
    var state = getLazyRootState(root, false);
    if (root && (!state || state.pendingCount <= 0)) return false;
    var currentMode = state ? state.mode : lazyViewportMode;
    if (mode === currentMode) return false;
    if (state) {
      state.mode = mode;
      state.topMarginPx = mode === 'fast_up' ? LAZY_VIEWPORT_FAST_MARGIN_PX : LAZY_VIEWPORT_MARGIN_PX;
      state.bottomMarginPx = mode === 'fast_down' ? LAZY_VIEWPORT_FAST_MARGIN_PX : LAZY_VIEWPORT_MARGIN_PX;
      state.lastModeChangeAt = now || Date.now();
    } else {
      lazyViewportMode = mode;
      lazyViewportTopMarginPx = mode === 'fast_up' ? LAZY_VIEWPORT_FAST_MARGIN_PX : LAZY_VIEWPORT_MARGIN_PX;
      lazyViewportBottomMarginPx = mode === 'fast_down' ? LAZY_VIEWPORT_FAST_MARGIN_PX : LAZY_VIEWPORT_MARGIN_PX;
      lazyScrollLastModeChangeAt = now || Date.now();
    }
    rebuildViewportObserver(root);
    return true;
  }

  function updateScrollPreload(root, scrollY, now) {
    if (typeof root === 'number') {
      now = scrollY;
      scrollY = root;
      root = null;
    }
    root = root && root.classList && root.classList.contains('atp-scroll-viewport') ? root : null;
    scrollY = Number(scrollY) || 0;
    now = Number(now) || Date.now();
    var state = getLazyRootState(root, false);
    if (root && (!state || state.pendingCount <= 0)) {
      if (state) {
        if (state.observer) state.observer.disconnect();
        viewportRootStates.delete(root);
      }
      return 'idle';
    }
    var lastY = state ? state.lastScrollY : lazyScrollLastY;
    var lastAt = state ? state.lastScrollAt : lazyScrollLastAt;
    if (lastY === null || !lastAt) {
      if (state) {
        state.lastScrollY = scrollY;
        state.lastScrollAt = now;
      } else {
        lazyScrollLastY = scrollY;
        lazyScrollLastAt = now;
      }
      return getLazyMode(root);
    }
    var delta = scrollY - lastY;
    // 同一滚动位置的重复采样（如同一事件被多处转发）不参与测速，
    // 否则 delta=0 的假样本会立刻触发 slowSamples 判定，造成观察器反复重建
    if (delta === 0) return getLazyMode(root);
    var elapsed = Math.max(1, now - lastAt);
    if (state) {
      state.lastScrollY = scrollY;
      state.lastScrollAt = now;
    } else {
      lazyScrollLastY = scrollY;
      lazyScrollLastAt = now;
    }
    var speed = Math.abs(delta) / elapsed;
    if (speed < 0.25) {
      if (state) state.slowSamples++;
      else lazyScrollSlowSamples++;
      if ((state ? state.slowSamples : lazyScrollSlowSamples) >= 2) applyLazyViewportMode(root, 'idle', now);
      return getLazyMode(root);
    }
    if (state) state.slowSamples = 0;
    else lazyScrollSlowSamples = 0;
    if (Math.abs(delta) < LAZY_SCROLL_MIN_DELTA_PX || speed < LAZY_SCROLL_FAST_THRESHOLD_PX_MS) return getLazyMode(root);
    var nextMode = delta > 0 ? 'fast_down' : 'fast_up';
    var lastModeChangeAt = state ? state.lastModeChangeAt : lazyScrollLastModeChangeAt;
    if (getLazyMode(root) === 'idle' || now - lastModeChangeAt >= 120) {
      applyLazyViewportMode(root, nextMode, now);
    }
    return getLazyMode(root);
  }

  function resetScrollPreload(root) {
    root = root && root.classList && root.classList.contains('atp-scroll-viewport') ? root : null;
    var state = getLazyRootState(root, false);
    var now = Date.now();
    if (state) {
      state.lastScrollY = root.scrollTop || 0;
      state.lastScrollAt = now;
      state.slowSamples = 0;
    } else {
      lazyScrollLastY = window.pageYOffset || document.documentElement.scrollTop || 0;
      lazyScrollLastAt = now;
      lazyScrollSlowSamples = 0;
    }
    applyLazyViewportMode(root, 'idle', now);
    return getLazyMode(root);
  }

  var ATPViewport = {
    observe: function(wrapper, task, imgData) {
      var observerRoot = getWrapperScrollRoot(wrapper);
      var now = Date.now();
      if (task && !task.viewportObservedAt) task.viewportObservedAt = now;
      var lightweightPreloadEligible = isLightweightHeavyPreloadTask(task);
      // 该距离只进诊断日志/统计：日志关闭时跳过（每次注册省一次布局读）
      var pendingCreatedDistancePx = (window.ATPLoader && ATPLoader.isDiagnosticLoggingEnabled && ATPLoader.isDiagnosticLoggingEnabled('DEBUG'))
        ? getVerticalDistanceFromViewportPx(wrapper)
        : undefined;
      var lightweightPreloadMarginPx = lightweightPreloadEligible ? getLightweightHeavyPreloadMarginPx() : 0;
      if (task && pendingCreatedDistancePx !== undefined && task.pendingCreatedDistancePx === undefined) {
        task.pendingCreatedDistancePx = pendingCreatedDistancePx;
      }
      if (task && lightweightPreloadEligible) task.lightweightPreloadMarginPx = lightweightPreloadMarginPx;
      var wrapperData = {
        task: task,
        imgData: imgData,
        loaded: false,
        inViewport: false,
        observedAt: now,
        pendingCreatedDistancePx: pendingCreatedDistancePx,
        inViewportAt: 0,
        actualInViewport: false,
        actualInViewportAt: 0,
        lastIntersectionAt: 0,
        lightweightPreloadEligible: lightweightPreloadEligible,
        lightweightPreloadMarginPx: lightweightPreloadMarginPx,
        lightweightPreloadObservedAt: lightweightPreloadEligible ? now : 0,
        lightweightPreloadTriggered: false,
        lightweightPreloadTriggeredAt: 0,
        lightweightPreloadInRange: false,
        forceLoadReason: '',
        slotRetryPending: false,
        observerRoot: observerRoot
      };
      wrapper.__atpLoadTask = task;
      var previousWrapperData = pendingWrappers.get(wrapper);
      clearPendingSlotRetry(previousWrapperData);
      if (previousWrapperData) {
        unobservePendingWrapper(wrapper, previousWrapperData);
        releaseViewportRoot(previousWrapperData.observerRoot);
      }
      pendingWrappers.set(wrapper, wrapperData);
      retainViewportRoot(observerRoot);
      var requestObserver = ensureViewportObserver(observerRoot);
      observeLoadingAnimation(wrapper);
      requestObserver.observe(wrapper);
      if (lightweightPreloadEligible) {
        lightweightPreloadObservedTotal++;
        initLightweightHeavyPreloadObserver();
        lightweightHeavyPreloadObserver.observe(wrapper);
      }
    },

    observeLoadingAnimation: function(wrapper) {
      observeLoadingAnimation(wrapper);
    },

    unobserveLoadingAnimation: function(wrapper) {
      unobserveLoadingAnimation(wrapper);
    },

    syncLoadingAnimationVisibility: function() {
      syncLoadingAnimationVisibility();
    },

    monitorLoadedHeavyImage: function(wrapper, img, task) {
      if (!wrapper || !img || !shouldMonitorHeavyImage(task)) return;
      initHeavyRenderObserver();
      cleanupHeavyRenderItem(wrapper);
      var now = Date.now();
      // 用 0px IO 持续维护的可见性标记，避免在 onload 的 DOM 写之后立刻做布局读
      // （每张重图完成一次强制回流）；一帧内的误差只影响 visibleSeenAt 起点，无碍
      var visible = !!(task && task.currentlyVisible === true);
      heavyRenderItems.set(wrapper, {
        wrapper: wrapper,
        img: img,
        task: task,
        src: img.currentSrc || img.src || (ATPLoader.getTaskImageSrc ? ATPLoader.getTaskImageSrc(task) : ''),
        noReferrer: img.referrerPolicy === 'no-referrer',
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
        visibleSeenAt: visible ? now : 0,
        visibleLocked: false,
        visibleRestoreHoldUntil: visible ? now + HEAVY_VISIBLE_RESTORE_SETTLE_MS : 0,
        visiblePreviewSince: 0,
        visiblePreviewGraceActive: false,
        visiblePreviewGraceMode: '',
        previewCanvas: null,
        previewReady: false,
        previewSrc: '',
        previewPrewarmTimer: null,
        previewPrewarmIdle: false,
        lightweightModeHold: false,
        restoreRetryCount: 0,
        unloaded: false
      });
      heavyRenderObserver.observe(wrapper);
      observeLoadingAnimation(wrapper);
      wrapper.classList.add('atp-heavy-thumbnail');
      wrapper.classList.remove('atp-heavy-preview-active');
      wrapper.classList.remove('atp-heavy-preview-pending');
      wrapper.classList.remove('atp-heavy-unloaded');
      var data = heavyRenderItems.get(wrapper);
      if (isHeavyThumbnailLightweightMode()) {
        var previewReady = prewarmHeavyPreview(wrapper, data);
        data.lightweightModeHold = true;
        var lightweightUnloaded = unloadHeavyImage(wrapper, data, {
          reason: 'lightweight_mode_unload',
          heavyThumbnailClarity: getHeavyThumbnailClarity(),
          previewPrewarmed: previewReady
        });
        if (!lightweightUnloaded) {
          data.lightweightModeHold = false;
          data.img.style.visibility = '';
          setHeavyPreviewActive(data, false);
          scheduleDeferredHeavyPreviewPrewarm(wrapper, data);
          return;
        }
        logRenderStateThrottled(data, 'lightweight_mode_hold', {
          heavyThumbnailClarity: getHeavyThumbnailClarity()
        });
        return;
      }
      reconcileHeavyRenderBudget('monitor_loaded');
      scheduleDeferredHeavyPreviewPrewarm(wrapper, data);
    },

    loadWrapper: function(wrapper, wrapperData, forceLoad) {
      if (!wrapperData || wrapperData.loaded) {
        removePendingWrapper(wrapper, wrapperData, true, !!(wrapperData && wrapperData.loaded));
        return false;
      }
      if (!document.contains(wrapper)) {
        removePendingWrapper(wrapper, wrapperData, true);
        return false;
      }

      var task = wrapperData.task;
      var imgData = wrapperData.imgData;
      if (ATPLoader.isTaskCurrent && !ATPLoader.isTaskCurrent(task)) {
        removePendingWrapper(wrapper, wrapperData, true);
        if (wrapper && wrapper.parentNode) wrapper.remove();
        return false;
      }
      forceLoad = !!forceLoad;
      if (isLoaderPaused()) {
        if (forceLoad || wrapperData.inViewport || wrapperData.lightweightPreloadInRange) {
          markPendingSlotRetry(wrapperData);
        }
        return false;
      }
      if (!forceLoad) wrapperData.forceLoadReason = wrapperData.inViewport ? 'viewport' : '';
      if (!forceLoad && !wrapperData.inViewport) return false;
      if (forceLoad && !wrapperData.forceLoadReason) {
        wrapperData.forceLoadReason = wrapperData.forceLoadWhenHidden ? 'hidden' : 'force';
      }
      // 0px IO 已持续维护 actualInViewport：为真时免去一次祖先链精判（每次加载尝试一次）
      var loadVisible = wrapperData.actualInViewport === true || isActuallyVisibleForRequest(wrapper);
      if (task && ATPLoader.updateTaskViewportPriority) {
        ATPLoader.updateTaskViewportPriority(task, wrapper, loadVisible);
      } else if (task) {
        task.currentlyVisible = loadVisible;
        task.viewportPriority = task.currentlyVisible;
      }
      if (task && task.isFirstScreen === false) {
        task.forcePreload = forceLoad && wrapperData.forceLoadReason === 'lightweight_preload';
        task.forceEager = forceLoad && !task.forcePreload;
        task.forceEagerLowPriority = task.forceEager && wrapperData.forceLoadReason === 'hidden';
      }

      if (!ATPLoader.acquireSlot(task)) {
        if (wrapperData.slotRetryPending) return false;
        wrapperData.slotRetries = (wrapperData.slotRetries || 0) + 1;
        var retryDelay = Math.min(2000, 100 * Math.pow(2, Math.min(wrapperData.slotRetries - 1, 5)));
        markPendingSlotRetry(wrapperData);
        schedulePendingSlotRetry(retryDelay);
        return false;
      }

      clearPendingSlotRetry(wrapperData);
      wrapperData.slotRetries = 0;
      wrapperData.loaded = true;
      var slotToken = ATPLoader.getActiveSlotToken ? ATPLoader.getActiveSlotToken(task) : (task && task.activeSlotToken);
      wrapperData.activeSlotToken = slotToken;
      wrapperData.loadStartedAt = Date.now();
      wrapperData.visibleBeforeLoadMs = wrapperData.actualInViewportAt
        ? Math.max(0, wrapperData.loadStartedAt - wrapperData.actualInViewportAt)
        : undefined;
      wrapperData.pendingCountAtLoad = pendingWrappers.size;

      var settings = window.ATPState && window.ATPState.settings;
      var w = (settings && settings.thumbWidth) || 110;
      var h = (settings && settings.thumbHeight) || 82;

      var loadingEl = wrapper.querySelector('.atp-thumbnail-loading');

      var img = document.createElement('img');
      if (ATPLoader.prepareThumbnailImage) {
        ATPLoader.prepareThumbnailImage(img, task, w, h);
      } else {
        img.className = 'atp-thumbnail-img';
        img.decoding = 'async';
        img.style.width = w + 'px';
        img.style.height = h + 'px';
      }
      wrapper.appendChild(img);

      var settled = false;
      var t = null;
      var unregisterActiveLoad = null;
      function isActiveLoadCurrent() {
        return !settled && (!ATPLoader.isImageSlotCurrent || ATPLoader.isImageSlotCurrent(task, slotToken));
      }
      function finishActiveLoad() {
        if (unregisterActiveLoad) {
          unregisterActiveLoad();
          unregisterActiveLoad = null;
        }
      }
      function requeueHiddenPausedWrapper() {
        if (!document.contains(wrapper)) return false;
        if (ATPLoader.isTaskCurrent && !ATPLoader.isTaskCurrent(task)) return false;
        wrapperData.loaded = false;
        wrapperData.forceLoadWhenHidden = false;
        wrapperData.forceLoadReason = '';
        wrapperData.activeSlotToken = null;
        wrapperData.loadStartedAt = 0;
        wrapperData.pendingCountAtLoad = 0;
        wrapperData.inViewport = refreshPendingViewportVisibility(wrapper, wrapperData);
        clearPendingSlotRetry(wrapperData);
        pendingWrappers.set(wrapper, wrapperData);
        retainViewportRoot(wrapperData.observerRoot);
        ensureViewportObserver(wrapperData.observerRoot).observe(wrapper);
        observeLoadingAnimation(wrapper);
        if (wrapperData.lightweightPreloadEligible) {
          initLightweightHeavyPreloadObserver();
          if (lightweightHeavyPreloadObserver) lightweightHeavyPreloadObserver.observe(wrapper);
        }
        return true;
      }
      function cancelActiveLoad(reason) {
        if (settled) return;
        var hiddenPause = reason === 'hidden_pause' && isActiveLoadCurrent();
        settled = true;
        if (t) {
          clearTimeout(t);
          t = null;
        }
        img.onclick = null;
        if (ATPLoader.cancelImageLoadElement) {
          ATPLoader.cancelImageLoadElement(img);
        } else {
          img.onload = null;
          img.onerror = null;
          img.removeAttribute('src');
        }
        if (hiddenPause && img.parentNode) img.parentNode.removeChild(img);
        if (wrapperData.activeSlotToken === slotToken) wrapperData.activeSlotToken = null;
        finishActiveLoad();
        if (hiddenPause) {
          releaseViewportSlot(task, slotToken);
          if (!requeueHiddenPausedWrapper()) {
            // 与 loader 的 removeWrapper 对齐：裸 remove 会把 wrapper 永久留在
            // loadingAnimationWrappers 里（只有 destroy 才清），软翻页下无人回收，
            // 之后每次 visibilitychange 都要遍历这些分离节点做矩形读
            unobserveLoadingAnimation(wrapper);
            if (ATPLoader.handleDetachedViewportTask) ATPLoader.handleDetachedViewportTask(task);
            if (wrapper.parentNode) wrapper.remove();
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
        if (ATPLoader.cancelImageLoadElement) {
          ATPLoader.cancelImageLoadElement(img);
        } else {
          img.onload = null;
          img.onerror = null;
          img.removeAttribute('src');
        }
        if (wrapperData.activeSlotToken === slotToken) wrapperData.activeSlotToken = null;
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
        var currentSrc = ATPLoader.getTaskImageSrc(task);
        if (ATPLoader.recordTaskImageFailure) {
          ATPLoader.recordTaskImageFailure(task, currentSrc, reason || 'active_recover', false);
        }
        if (ATPLoader.tryNoReferrerFallback(task, img, currentSrc, startTimer, isActiveLoadCurrent)) return;
        if (ATPLoader.tryHeavyCandidateFallback(task, img, startTimer, isActiveLoadCurrent)) return;
        failFinal(reason || 'viewport_recover');
      }
      if (ATPLoader.registerActiveImageLoad) {
        unregisterActiveLoad = ATPLoader.registerActiveImageLoad({ cancel: cancelActiveLoad, recover: recoverActiveLoad });
      }
      function startTimer(timeoutOverride) {
        if (settled) return;
        if (!isActiveLoadCurrent()) {
          abandonStaleActiveLoad();
          return;
        }
        if (t) clearTimeout(t);
        var currentSettings = window.ATPState && window.ATPState.settings;
        var overrideTimeout = Number(timeoutOverride);
        var imgTimeout = !isNaN(overrideTimeout) && overrideTimeout > 0
          ? overrideTimeout
          : ATPLoader.getImageLoadTimeout
          ? ATPLoader.getImageLoadTimeout(currentSettings, task)
          : ((currentSettings && currentSettings.imageTimeout) || 15000);
        t = setTimeout(function() {
          if (settled) return;
          if (!isActiveLoadCurrent()) {
            abandonStaleActiveLoad();
            return;
          }
          var currentSrc = ATPLoader.getTaskImageSrc(task);
          if (ATPLoader.tryNoReferrerFallback(task, img, currentSrc, startTimer, isActiveLoadCurrent)) return;
          if (ATPLoader.recordTaskImageFailure) {
            ATPLoader.recordTaskImageFailure(task, currentSrc, 'candidate_timeout', false);
          }
          if (ATPLoader.tryHeavyCandidateFallback(task, img, startTimer, isActiveLoadCurrent)) return;
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
        var currentSrc = ATPLoader.getTaskImageSrc(task);
        var failReason = reason || 'viewport_fail';
        if (ATPLoader.recordTaskImageFailure) {
          ATPLoader.recordTaskImageFailure(task, currentSrc, failReason, true);
        } else {
          ATPLoader.recordDomainFailure(currentSrc, failReason);
        }
        if (ATPLoader.logImageDone && (!ATPLoader.isDiagnosticLoggingEnabled || ATPLoader.isDiagnosticLoggingEnabled('DEBUG'))) {
          ATPLoader.logImageDone(task, false, failReason, getViewportPendingLogFields(wrapper, wrapperData, forceLoad));
        }
        releaseViewportSlot(task, slotToken);
        if (wrapperData.activeSlotToken === slotToken) wrapperData.activeSlotToken = null;
        if (ATPLoader.isTaskCurrent && !ATPLoader.isTaskCurrent(task)) {
          if (wrapper && wrapper.parentNode) wrapper.remove();
          ATPLoader.globalSchedule();
          return;
        }
        if (ATPLoader.handleFail(task)) {
          if (wrapper && wrapper.parentNode) wrapper.remove();
        } else {
          ATPLoader.showFailedPlaceholder(wrapper, loadingEl, task, currentSrc);
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
        if (ATPLoader.logImageDone && (!ATPLoader.isDiagnosticLoggingEnabled || ATPLoader.isDiagnosticLoggingEnabled('DEBUG'))) {
          ATPLoader.logImageDone(task, true, 'viewport_load', Object.assign(
            ATPLoader.getImageMetrics ? ATPLoader.getImageMetrics(img) : getImageMetrics(img),
            getViewportPendingLogFields(wrapper, wrapperData, forceLoad)
          ));
        }
        releaseViewportSlot(task, slotToken);
        if (wrapperData.activeSlotToken === slotToken) wrapperData.activeSlotToken = null;
        if (ATPLoader.isTaskCurrent && !ATPLoader.isTaskCurrent(task)) {
          if (wrapper && wrapper.parentNode) wrapper.remove();
          ATPLoader.globalSchedule();
          return;
        }
        ATPLoader.recordDomainSuccess(ATPLoader.getTaskImageSrc(task));
        var heavyTask = !!(ATPLoader.isHeavyChannelTask && ATPLoader.isHeavyChannelTask(task));
        if (heavyTask && ATPViewport.monitorLoadedHeavyImage) {
          ATPViewport.monitorLoadedHeavyImage(wrapper, img, task);
        } else {
          wrapper.classList.remove('atp-heavy-preview-active');
          wrapper.classList.remove('atp-heavy-preview-pending');
          wrapper.classList.remove('atp-heavy-unloaded');
        }
        if (loadingEl && loadingEl.parentNode) loadingEl.remove();
        if (!wrapper.classList.contains('atp-heavy-unloaded')) img.style.display = 'block';
        img.style.cursor = 'pointer';
        var openPreview = function(preferOpenerFocus) {
          var threads = window.ATPState && window.ATPState.threads;
          var ts = threads && threads[task.threadId];
          if (ts && ts.candidates && window.ATPPreviewer) {
            var previewCandidates = ts.heavyMode && ts.sourceCandidates ? ts.sourceCandidates : ts.candidates;
            var allUrls = ATPLoader.buildPreviewUrls ? ATPLoader.buildPreviewUrls(previewCandidates) : [];
            if (!ATPLoader.buildPreviewUrls) {
              for (var pui = 0; pui < previewCandidates.length; pui++) {
                var candidate = previewCandidates[pui];
                allUrls.push(ATPLoader.getCandidatePreviewSrc ? ATPLoader.getCandidatePreviewSrc(candidate) : candidate.src);
              }
            }
            var clickIndex = ATPLoader.getTaskPreviewIndex(wrapperData.task);
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
        ATPLoader.bindPreviewActivation(wrapper, openPreview, task);
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
        var currentSrc = ATPLoader.getTaskImageSrc(task);
        if (ATPLoader.tryNoReferrerFallback(task, img, currentSrc, startTimer, isActiveLoadCurrent)) return;
        if (ATPLoader.recordTaskImageFailure) {
          ATPLoader.recordTaskImageFailure(task, currentSrc, 'candidate_error', false);
        }
        if (ATPLoader.tryHeavyCandidateFallback(task, img, startTimer, isActiveLoadCurrent)) return;
        failFinal();
      };
      var initialSrc = ATPLoader.getTaskImageSrc(task);
      if (ATPLoader.markTaskCurrentSourceStart) {
        ATPLoader.markTaskCurrentSourceStart(task, initialSrc, false);
      }
      ATPLoader.setImageSource(img, initialSrc, false, isActiveLoadCurrent);

      removePendingWrapper(wrapper, wrapperData, true, true);
      return true;
    },

    loadPendingWhenHidden: function(maxLoads) {
      if (document.visibilityState === 'visible') return 0;
      prunePendingWrappers(true, true);
      var limit = Math.max(0, Number(maxLoads) || 0);
      var started = 0;
      var attempted = 0;
      var attemptLimit = limit > 0
        ? Math.max(1, Math.min(pendingWrappers.size, limit * 2 + 2))
        : Math.min(pendingWrappers.size, PENDING_SLOT_RETRY_SCAN_LIMIT);
      var startIndex = normalizePendingRetryCursor(pendingHiddenLoadCursor);
      var index = 0;
      var nextCursor = startIndex;
      var pendingEntries = pendingWrappers.entries();
      var pendingEntry = pendingEntries.next();
      while (!pendingEntry.done) {
        var wrapper = pendingEntry.value[0];
        var data = pendingEntry.value[1];
        pendingEntry = pendingEntries.next();
        if (index++ < startIndex) continue;
        // 命中上限即中断时，游标停在当前未处理条目上，避免每轮固定漏扫一个
        if ((limit > 0 && started >= limit) || attempted >= attemptLimit) {
          nextCursor = (index - 1) >= pendingWrappers.size ? 0 : (index - 1);
          break;
        }
        nextCursor = index >= pendingWrappers.size ? 0 : index;
        if (!data || data.loaded) continue;
        if (getAvailableSlotCount() <= 0) {
          nextCursor = (index - 1) >= pendingWrappers.size ? 0 : (index - 1);
          break;
        }
        data.forceLoadWhenHidden = true;
        attempted++;
        if (ATPViewport.loadWrapper(wrapper, data, true)) started++;
      }
      if ((limit <= 0 || started < limit) && attempted < attemptLimit && startIndex > 0) {
        pendingEntries = pendingWrappers.entries();
        pendingEntry = pendingEntries.next();
        index = 0;
        while (!pendingEntry.done && index < startIndex) {
          var wrappedWrapper = pendingEntry.value[0];
          var wrappedData = pendingEntry.value[1];
          pendingEntry = pendingEntries.next();
          index++;
          if ((limit > 0 && started >= limit) || attempted >= attemptLimit) {
            nextCursor = (index - 1) >= pendingWrappers.size ? 0 : (index - 1);
            break;
          }
          nextCursor = index >= pendingWrappers.size ? 0 : index;
          if (!wrappedData || wrappedData.loaded) continue;
          if (getAvailableSlotCount() <= 0) {
            nextCursor = (index - 1) >= pendingWrappers.size ? 0 : (index - 1);
            break;
          }
          wrappedData.forceLoadWhenHidden = true;
          attempted++;
          if (ATPViewport.loadWrapper(wrappedWrapper, wrappedData, true)) started++;
        }
      }
      pendingHiddenLoadCursor = normalizePendingRetryCursor(nextCursor);
      return started;
    },

    clearHiddenLoadFlags: function() {
      prunePendingWrappers(true, true);
      var pendingValues = pendingWrappers.values();
      var pendingValue = pendingValues.next();
      while (!pendingValue.done) {
        var data = pendingValue.value;
        pendingValue = pendingValues.next();
        if (!data) continue;
        data.forceLoadWhenHidden = false;
        if (!data.inViewport && !data.lightweightPreloadInRange) clearPendingSlotRetry(data);
      }
    },

    clearPendingRetryTimers: function() {
      clearPendingRetryTimers();
    },

    updateScrollPreload: function(root, scrollY, now) {
      return updateScrollPreload(root, scrollY, now);
    },

    resetScrollPreload: function(root) {
      return resetScrollPreload(root);
    },

    retryActualVisiblePending: function() {
      return ATPViewport.retryVisiblePending(true);
    },

    retryVisiblePending: function(actualOnly) {
      var totalStarted = 0;
      if (isLoaderPaused() || shouldPausePendingRetryWhenHidden()) return totalStarted;
      if (actualOnly && !actualVisiblePendingWrappers.size) return totalStarted;
      prunePendingWrappers(true, true);
      var available = getAvailableSlotCount();
      if (available <= 0) {
        markVisiblePendingSlotRetries(PENDING_SLOT_RETRY_SCAN_LIMIT);
        return totalStarted;
      }

      var actualWrappers = actualVisiblePendingWrappers.values();
      var actualWrapper = actualWrappers.next();
      while (!actualWrapper.done && totalStarted < available) {
        var visibleWrapper = actualWrapper.value;
        var visibleData = pendingWrappers.get(visibleWrapper);
        actualWrapper = actualWrappers.next();
        if (!visibleData || visibleData.loaded || !visibleData.actualInViewport) {
          actualVisiblePendingWrappers.delete(visibleWrapper);
          continue;
        }
        visibleData.inViewport = true;
        if (!visibleData.inViewportAt) visibleData.inViewportAt = visibleData.actualInViewportAt || Date.now();
        if (ATPViewport.loadWrapper(visibleWrapper, visibleData, false)) totalStarted++;
      }

      if (actualOnly) return totalStarted;

      available = getAvailableSlotCount();
      if (available <= 0) return totalStarted;
      var started = 0;
      var attempted = 0;
      var attemptLimit = Math.max(1, Math.min(pendingWrappers.size, available * 2 + 2));
      var scanLimit = Math.max(1, Math.min(pendingWrappers.size, PENDING_SLOT_RETRY_SCAN_LIMIT));
      var scanned = 0;
      var startIndex = normalizePendingRetryCursor(pendingVisibleRetryCursor);
      var index = 0;
      var nextCursor = startIndex;
      var pendingEntries = pendingWrappers.entries();
      var pendingEntry = pendingEntries.next();
      while (!pendingEntry.done) {
        var wrapper = pendingEntry.value[0];
        var data = pendingEntry.value[1];
        pendingEntry = pendingEntries.next();
        if (index++ < startIndex) continue;
        // 命中上限即中断时，游标停在当前未处理条目上，避免每轮固定漏扫一个
        if (started >= available || attempted >= attemptLimit || scanned >= scanLimit) {
          nextCursor = (index - 1) >= pendingWrappers.size ? 0 : (index - 1);
          break;
        }
        nextCursor = index >= pendingWrappers.size ? 0 : index;
        scanned++;
        if (!data || data.loaded || !refreshPendingViewportVisibility(wrapper, data)) continue;
        attempted++;
        if (ATPViewport.loadWrapper(wrapper, data, false)) started++;
      }
      if (started < available && attempted < attemptLimit && scanned < scanLimit && startIndex > 0) {
        pendingEntries = pendingWrappers.entries();
        pendingEntry = pendingEntries.next();
        index = 0;
        while (!pendingEntry.done && index < startIndex) {
          var wrappedWrapper = pendingEntry.value[0];
          var wrappedData = pendingEntry.value[1];
          pendingEntry = pendingEntries.next();
          index++;
          if (started >= available || attempted >= attemptLimit || scanned >= scanLimit) {
            nextCursor = (index - 1) >= pendingWrappers.size ? 0 : (index - 1);
            break;
          }
          nextCursor = index >= pendingWrappers.size ? 0 : index;
          scanned++;
          if (!wrappedData || wrappedData.loaded || !refreshPendingViewportVisibility(wrappedWrapper, wrappedData)) continue;
          attempted++;
          if (ATPViewport.loadWrapper(wrappedWrapper, wrappedData, false)) started++;
        }
      }
      pendingVisibleRetryCursor = normalizePendingRetryCursor(nextCursor);
      var completedEmptyScan = false;
      if (started > 0 || attempted > 0 || scanned <= 0) {
        pendingVisibleRetryEmptyScanCount = 0;
        pendingVisibleRetryEmptyScanSize = pendingWrappers.size;
      } else {
        if (pendingVisibleRetryEmptyScanSize !== pendingWrappers.size) {
          pendingVisibleRetryEmptyScanCount = 0;
          pendingVisibleRetryEmptyScanSize = pendingWrappers.size;
        }
        pendingVisibleRetryEmptyScanCount += scanned;
        completedEmptyScan = pendingVisibleRetryEmptyScanCount >= pendingWrappers.size;
        if (completedEmptyScan) pendingVisibleRetryEmptyScanCount = 0;
      }
      if (!completedEmptyScan && started < available && (attempted >= attemptLimit || scanned >= scanLimit) && pendingWrappers.size > scanLimit) {
        scheduleVisiblePendingRetry(80);
      }
      return totalStarted + started;
    },

    retryPendingSlotLoads: function(maxAttempts) {
      var started = 0;
      if (isLoaderPaused() || shouldPausePendingRetryWhenHidden()) return started;
      prunePendingWrappers(true, true);
      var available = getAvailableSlotCount();
      if (available <= 0) return started;
      var attempted = 0;
      var attemptLimit = Math.max(1, Math.min(Number(maxAttempts) || PENDING_SLOT_RETRY_SCAN_LIMIT, PENDING_SLOT_RETRY_SCAN_LIMIT));
      var scanLimit = Math.max(1, Math.min(pendingWrappers.size, attemptLimit));
      var scanned = 0;
      var startIndex = normalizePendingRetryCursor(pendingSlotRetryCursor);
      var index = 0;
      var nextCursor = startIndex;
      var pendingEntries = pendingWrappers.entries();
      var pendingEntry = pendingEntries.next();
      while (!pendingEntry.done) {
        var wrapper = pendingEntry.value[0];
        var data = pendingEntry.value[1];
        pendingEntry = pendingEntries.next();
        if (index++ < startIndex) continue;
        // 命中上限即中断时，游标停在当前未处理条目上，避免每轮固定漏扫一个
        if (started >= available || attempted >= attemptLimit || scanned >= scanLimit) {
          nextCursor = (index - 1) >= pendingWrappers.size ? 0 : (index - 1);
          break;
        }
        nextCursor = index >= pendingWrappers.size ? 0 : index;
        scanned++;
        if (!data || data.loaded || !data.slotRetryPending) continue;
        var stillHiddenForced = !!(data.forceLoadWhenHidden && document.visibilityState !== 'visible');
        var stillPreloadForced = !!(data.lightweightPreloadEligible && data.lightweightPreloadInRange);
        if (!stillHiddenForced && !stillPreloadForced && !refreshPendingViewportVisibility(wrapper, data)) {
          clearPendingSlotRetry(data);
          continue;
        }
        clearPendingSlotRetry(data);
        if (stillPreloadForced) data.forceLoadReason = 'lightweight_preload';
        else if (stillHiddenForced) data.forceLoadReason = 'hidden';
        else data.forceLoadReason = '';
        attempted++;
        if (getAvailableSlotCount() <= 0) {
          markPendingSlotRetry(data);
          break;
        }
        if (ATPViewport.loadWrapper(wrapper, data, stillHiddenForced || stillPreloadForced)) started++;
      }
      if (started < available && attempted < attemptLimit && scanned < scanLimit && startIndex > 0) {
        pendingEntries = pendingWrappers.entries();
        pendingEntry = pendingEntries.next();
        index = 0;
        while (!pendingEntry.done && index < startIndex) {
          var wrappedWrapper = pendingEntry.value[0];
          var wrappedData = pendingEntry.value[1];
          pendingEntry = pendingEntries.next();
          index++;
          if (started >= available || attempted >= attemptLimit || scanned >= scanLimit) {
            nextCursor = (index - 1) >= pendingWrappers.size ? 0 : (index - 1);
            break;
          }
          nextCursor = index >= pendingWrappers.size ? 0 : index;
          scanned++;
          if (!wrappedData || wrappedData.loaded || !wrappedData.slotRetryPending) continue;
          var wrappedHiddenForced = !!(wrappedData.forceLoadWhenHidden && document.visibilityState !== 'visible');
          var wrappedPreloadForced = !!(wrappedData.lightweightPreloadEligible && wrappedData.lightweightPreloadInRange);
          if (!wrappedHiddenForced && !wrappedPreloadForced && !refreshPendingViewportVisibility(wrappedWrapper, wrappedData)) {
            clearPendingSlotRetry(wrappedData);
            continue;
          }
          clearPendingSlotRetry(wrappedData);
          if (wrappedPreloadForced) wrappedData.forceLoadReason = 'lightweight_preload';
          else if (wrappedHiddenForced) wrappedData.forceLoadReason = 'hidden';
          else wrappedData.forceLoadReason = '';
          attempted++;
          if (getAvailableSlotCount() <= 0) {
            markPendingSlotRetry(wrappedData);
            break;
          }
          if (ATPViewport.loadWrapper(wrappedWrapper, wrappedData, wrappedHiddenForced || wrappedPreloadForced)) started++;
        }
      }
      pendingSlotRetryCursor = normalizePendingRetryCursor(nextCursor);
      if (hasPendingSlotRetry() && !isLoaderPaused() && getAvailableSlotCount() > 0) schedulePendingSlotRetry(100);
      return started;
    },

    pauseHeavyRestores: function() {
      // 暂停（页面隐藏）前把去抖中的出界卸载立即落地，尽快释放解码内存
      flushHeavyExitUnloads();
      clearHeavyRestoreTimers();
      clearDeferredHeavyPreviewPrewarms();
      pauseActiveHeavyRestoreLoadTimers();
    },

    cancelHeavyRestores: function(reason) {
      clearHeavyRestoreTimers();
      var cancelValues = heavyRenderItems.values();
      var cancelValue = cancelValues.next();
      while (!cancelValue.done) {
        clearDeferredHeavyPreviewPrewarm(cancelValue.value);
        cancelHeavyRestoreLoad(cancelValue.value, reason || 'cancel_heavy_restores');
        cancelValue = cancelValues.next();
      }
    },

    resumeHeavyRestores: function(reason) {
      clearHeavyRestoreTimers();
      if (isLoaderPaused()) return;
      resumeActiveHeavyRestoreLoadTimers(reason || 'resume_heavy_restores');
      // pauseHeavyRestores 清掉过所有待办预热，而 scheduleDeferredHeavyPreviewPrewarm 有
      // 重入保护不会自愈：这里补排，否则卸载时要现场从多百万像素源图缩图（成批掉帧）
      var prewarmEntries = heavyRenderItems.entries();
      var prewarmEntry = prewarmEntries.next();
      while (!prewarmEntry.done) {
        var prewarmWrapper = prewarmEntry.value[0];
        var prewarmData = prewarmEntry.value[1];
        prewarmEntry = prewarmEntries.next();
        if (prewarmData && !prewarmData.previewReady && !prewarmData.unloaded) {
          scheduleDeferredHeavyPreviewPrewarm(prewarmWrapper, prewarmData);
        }
      }
      reconcileHeavyRenderBudget(reason || 'scroll_idle_budget');
      // 滚动刚停是用户盯着毛玻璃的时刻：立刻起批（原沿用 420ms 滚动节奏，白等近半秒）
      scheduleHeavyRestore(HEAVY_RESTORE_IDLE_KICK_DELAY);
    },

    reconfigure: function(reason) {
      reason = reason || 'settings_reconfigure';
      clearHeavyRestoreTimers();
      if (!isLoaderPaused()) {
        reconcileHeavyRenderBudget(reason);
        scheduleHeavyRestore(0);
        ATPViewport.retryVisiblePending();
        ATPViewport.retryPendingSlotLoads();
      }
      return {
        heavyDecodedImageLimit: getHeavyDecodedImageLimit(),
        heavyDecodedBudgetMP: getHeavyDecodedBudgetMP(),
        heavyVisibleBudgetMP: getHeavyVisibleBudgetMP(),
        heavyLightweightPreviewEdge: getHeavyLightweightPreviewMaxEdge()
      };
    },

    destroy: function() {
      if (viewportObserver) {
        viewportObserver.disconnect();
        viewportObserver = null;
      }
      var rootStates = viewportRootStates.values();
      var rootState = rootStates.next();
      while (!rootState.done) {
        if (rootState.value && rootState.value.observer) rootState.value.observer.disconnect();
        rootState = rootStates.next();
      }
      viewportRootStates.clear();
      if (loadingAnimationObserver) {
        loadingAnimationObserver.disconnect();
        loadingAnimationObserver = null;
      }
      var loadingWrappers = loadingAnimationWrappers.values();
      var loadingWrapper = loadingWrappers.next();
      while (!loadingWrapper.done) {
        setLoadingAnimationState(loadingWrapper.value, false);
        loadingWrapper = loadingWrappers.next();
      }
      loadingAnimationWrappers.clear();
      lazyViewportTopMarginPx = LAZY_VIEWPORT_MARGIN_PX;
      lazyViewportBottomMarginPx = LAZY_VIEWPORT_MARGIN_PX;
      lazyViewportMode = 'idle';
      lazyScrollLastY = null;
      lazyScrollLastAt = 0;
      lazyScrollSlowSamples = 0;
      lazyScrollLastModeChangeAt = 0;
      if (lightweightHeavyPreloadObserver) {
        lightweightHeavyPreloadObserver.disconnect();
        lightweightHeavyPreloadObserver = null;
      }
      lightweightHeavyPreloadMarginPx = 0;
      lightweightHeavyPreloadMargin = '';
      lightweightPreloadObservedTotal = 0;
      lightweightPreloadTriggeredTotal = 0;
      if (heavyRenderObserver) {
        heavyRenderObserver.disconnect();
        heavyRenderObserver = null;
      }
      clearPendingRetryTimers();
      pendingVisibleRetryCursor = 0;
      pendingSlotRetryCursor = 0;
      pendingHiddenLoadCursor = 0;
      pendingSlotRetryCount = 0;
      actualVisiblePendingWrappers.clear();
      pendingWrappers.clear();
      if (heavyRestoreTimer) {
        clearTimeout(heavyRestoreTimer);
        heavyRestoreTimer = null;
      }
      heavyRestoreTimerFireAt = 0;
      if (heavyBudgetTimer) {
        clearTimeout(heavyBudgetTimer);
        heavyBudgetTimer = null;
      }
      heavyBudgetTimerFireAt = 0;
      heavySlotFreeVisibleRestores = 0;
      clearHeavyExitUnloads();
      heavyRestoreQueue = [];
      var renderValues = heavyRenderItems.values();
      var renderValue = renderValues.next();
      while (!renderValue.done) {
        var renderData = renderValue.value;
        renderValue = renderValues.next();
        clearRestoreReveal(renderData);
        clearDeferredHeavyPreviewPrewarm(renderData);
        cancelHeavyRestoreLoad(renderData, 'destroy');
      }
      heavyRenderItems.clear();
    },

    getPendingCount: function() {
      prunePendingWrappers(true);
      return pendingWrappers.size;
    },

    getPendingStats: function() {
      prunePendingWrappers(true);
      var now = Date.now();
      var stats = {
        pendingCount: pendingWrappers.size,
        actualVisiblePendingCount: actualVisiblePendingWrappers.size,
        oldestVisiblePendingAgeMs: 0,
        maxPendingAgeMs: 0,
        stalePendingCount: 0,
        lightweightPreloadPending: 0,
        lightweightPreloadInRange: 0,
        lightweightPreloadTriggered: 0,
        lightweightPreloadObservedTotal: lightweightPreloadObservedTotal,
        lightweightPreloadTriggeredTotal: lightweightPreloadTriggeredTotal,
        lightweightPreloadMarginPx: getLightweightHeavyPreloadMarginPx(),
        lazyViewportMode: lazyViewportMode,
        lazyViewportTopMarginPx: lazyViewportTopMarginPx,
        lazyViewportBottomMarginPx: lazyViewportBottomMarginPx,
        adaptiveScrollRootCount: viewportRootStates.size,
        maxPendingCreatedDistancePx: 0,
        maxPendingCurrentDistancePx: 0,
        maxLightweightPreloadCreatedDistancePx: 0,
        preloadMissReasons: {},
        pendingAgeByQueueKind: {}
      };
      var pendingEntries = pendingWrappers.entries();
      var pendingEntry = pendingEntries.next();
      while (!pendingEntry.done) {
        var wrapper = pendingEntry.value[0];
        var data = pendingEntry.value[1];
        pendingEntry = pendingEntries.next();
        if (!data) continue;
        if (data.actualInViewportAt) {
          stats.oldestVisiblePendingAgeMs = Math.max(
            stats.oldestVisiblePendingAgeMs,
            Math.max(0, now - data.actualInViewportAt)
          );
        }
        var age = data.observedAt ? Math.max(0, now - data.observedAt) : 0;
        var queueKind = data.task && data.task.queueKind ? data.task.queueKind : 'unknown';
        var queueStats = stats.pendingAgeByQueueKind[queueKind] || { count: 0, maxAgeMs: 0 };
        queueStats.count++;
        queueStats.maxAgeMs = Math.max(queueStats.maxAgeMs, age);
        stats.pendingAgeByQueueKind[queueKind] = queueStats;
        stats.maxPendingAgeMs = Math.max(stats.maxPendingAgeMs, age);
        if (age >= 60000) stats.stalePendingCount++;
        stats.maxPendingCreatedDistancePx = Math.max(stats.maxPendingCreatedDistancePx, Number(data.pendingCreatedDistancePx) || 0);
        stats.maxPendingCurrentDistancePx = Math.max(stats.maxPendingCurrentDistancePx, getVerticalDistanceFromViewportPx(wrapper) || 0);
        if (data.lightweightPreloadEligible) {
          stats.lightweightPreloadPending++;
          stats.maxLightweightPreloadCreatedDistancePx = Math.max(
            stats.maxLightweightPreloadCreatedDistancePx,
            Number(data.pendingCreatedDistancePx) || 0
          );
          var missReason = getLightweightPreloadMissReason(data, false);
          if (missReason) stats.preloadMissReasons[missReason] = (stats.preloadMissReasons[missReason] || 0) + 1;
        }
        if (data.lightweightPreloadInRange) stats.lightweightPreloadInRange++;
        if (data.lightweightPreloadTriggered) stats.lightweightPreloadTriggered++;
      }
      return stats;
    },

    getHeavyUnloadedCount: function() {
      var count = 0;
      var renderValues = heavyRenderItems.values();
      var renderValue = renderValues.next();
      while (!renderValue.done) {
        var data = renderValue.value;
        renderValue = renderValues.next();
        if (data && data.unloaded) count++;
      }
      return count;
    },

    getHeavyRestoreQueueCount: function() {
      return heavyRestoreQueue.length;
    },

    getHeavyRenderStats: function() {
      return getHeavyRenderLogFields();
    }
  };

  window.ATPViewport = ATPViewport;
})();
