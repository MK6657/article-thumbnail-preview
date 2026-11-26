(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;

  var heavyRenderItems = new Map();
  var heavyRestoreQueue = [];
  var heavyRestoreTimer = null;
  var heavyRestoreTimerFireAt = 0;
  var heavyBudgetTimer = null;
  var heavyBudgetTimerFireAt = 0;
  var heavyExitUnloadTimer = null;
  var heavyExitUnloadPending = new Set();
  var heavySlotFreeVisibleRestores = 0;
  var reconcilingHeavyBudget = false;
  var lastRenderStateLogAt = 0;

  var HEAVY_RESTORE_BATCH_SIZE = 1;
  var HEAVY_RESTORE_FAST_BATCH_SIZE = 2;
  var HEAVY_RESTORE_PRESSURE_BATCH_SIZE = 1;
  var HEAVY_RESTORE_BATCH_DELAY = 220;
  var HEAVY_RESTORE_IDLE_KICK_DELAY = 50;
  var HEAVY_RESTORE_VISIBLE_NEXT_DELAY = 160;
  var HEAVY_RESTORE_FAST_DELAY = 90;
  var HEAVY_RESTORE_FAST_MP = 80;
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
  var HEAVY_VISIBLE_PREVIEW_MAX_WAIT_MS = 600;
  var HEAVY_VISIBLE_RESTORE_GRACE_MS = 900;
  var HEAVY_VISIBLE_PRESSURE_RELEASE_MIN_MS = 6000;
  var HEAVY_VISIBLE_LOCK_DELAY_MS = 1200;
  var HEAVY_VISIBLE_RESTORE_SETTLE_MS = 1400;
  var HEAVY_ULTRA_MP = 80;
  var HEAVY_UNLOAD_BATCH_SIZE = 4;
  var HEAVY_BUDGET_RECONCILE_DELAY = 120;
  var HEAVY_EXIT_UNLOAD_GRACE_MS = 300;
  var HEAVY_PREVIEW_BLUR_DISPLAY_PX = 5;
  var RENDER_STATE_LOG_THROTTLE_MS = 1000;

  function getSettings() {
    return (root.ATPState && root.ATPState.settings) || {};
  }

  function isLoaderPaused() {
    return !!(root.ATPLoader && ATPLoader.isPaused && ATPLoader.isPaused());
  }

  function isScrollingActive() {
    if (root.ATPViewport && typeof ATPViewport.isScrolling === 'function') {
      return ATPViewport.isScrolling();
    }
    return !!(root.ATPLoader && ATPLoader.isHeavyScrollActive && ATPLoader.isHeavyScrollActive());
  }

  function shouldMonitorHeavyImage(task) {
    if (root.ATPHostHealth && ATPHostHealth.isHeavyChannelTask) {
      return ATPHostHealth.isHeavyChannelTask(task, getSettings());
    }
    return !!(root.ATPLoader && ATPLoader.isHeavyChannelTask && ATPLoader.isHeavyChannelTask(task));
  }

  function getHeavyThumbnailClarity() {
    var settings = getSettings();
    return ATPLoadPolicy.getHeavyThumbnailClarity
      ? ATPLoadPolicy.getHeavyThumbnailClarity(settings)
      : ((settings.heavyImageOptimization !== false &&
         (settings.heavyThumbnailClarity === 'lightweight' || settings.heavyThumbnailClarity === 'blurred'))
         ? 'lightweight' : 'balanced');
  }

  function isLightweightClarityMode() {
    return getHeavyThumbnailClarity() === 'lightweight';
  }

  function getHeavyDecodedImageLimit() {
    return ATPLoadPolicy.getHeavyDecodedImageLimit(getSettings());
  }

  function getHeavyRenderMinKeep() {
    var configured = getHeavyDecodedImageLimit();
    return configured > 0 ? Math.min(HEAVY_RENDER_MIN_KEEP, configured) : HEAVY_RENDER_MIN_KEEP;
  }

  function getHeavyDecodedBudgetMP() {
    return ATPLoadPolicy.getHeavyDecodedBudgetMP(getSettings());
  }

  function getHeavyVisibleBudgetMP() {
    return ATPLoadPolicy.getHeavyVisibleBudgetMP(getSettings());
  }

  function getHeavyLightweightPreviewMaxEdge() {
    return ATPLoadPolicy.getHeavyLightweightPreviewEdge(getSettings());
  }

  function roundMP(value) {
    return Math.round((Number(value) || 0) * 10) / 10;
  }

  function deriveMPBudget(base, multiplier) {
    base = Math.max(0, Number(base) || 0);
    return base > 0 ? roundMP(base * multiplier) : 0;
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

  function getVisiblePreviewStarvationWaitMS() {
    var settings = getSettings();
    var seconds = parseInt(settings.heavyPreviewStarvationWait, 10);
    if (isNaN(seconds)) seconds = 3;
    return Math.max(0, seconds * 1000);
  }

  function getVisiblePreviewStarvationMP() {
    var settings = getSettings();
    var mp = parseInt(settings.heavyPreviewStarvationMP, 10);
    if (isNaN(mp)) mp = 820;
    return Math.max(0, mp);
  }

  function getConfiguredInt(key, fallback, min) {
    var settings = getSettings();
    var value = parseInt(settings[key], 10);
    if (isNaN(value)) value = fallback;
    return Math.max(min, value);
  }

  function getHeavyRestoreFastBatchSize() {
    return getConfiguredInt('heavyRestoreFastBatchSize', HEAVY_RESTORE_FAST_BATCH_SIZE, HEAVY_RESTORE_BATCH_SIZE);
  }

  function getHeavyRestorePressureBatchSize() {
    return getConfiguredInt('heavyRestorePressureBatchSize', HEAVY_RESTORE_PRESSURE_BATCH_SIZE, HEAVY_RESTORE_BATCH_SIZE);
  }

  // Zero-reflow cached band lookup from ATPViewport's 3 persistent IntersectionObservers
  function getWrapperBand(wrapper) {
    if (!wrapper) return 3;
    if (root.ATPViewport && typeof ATPViewport.getBand === 'function') {
      return ATPViewport.getBand(wrapper);
    }
    return typeof wrapper.__atpViewportBand === 'number' ? wrapper.__atpViewportBand : 3;
  }

  function getDataDecodedMP(data) {
    if (!data) return 0;
    var nw = (data.img && data.img.naturalWidth) || 0;
    var nh = (data.img && data.img.naturalHeight) || 0;
    if (nw) data.naturalWidth = nw;
    if (nh) data.naturalHeight = nh;
    var naturalWidth = data.naturalWidth || nw;
    var naturalHeight = data.naturalHeight || nh;
    return naturalWidth && naturalHeight ? roundMP((naturalWidth * naturalHeight) / 1000000) : 0;
  }

  function isVisibleStable(data, now) {
    return !!(data && data.visibleSeenAt && (now - data.visibleSeenAt >= HEAVY_VISIBLE_LOCK_DELAY_MS));
  }

  function isVisibleRestoreSettling(data, now) {
    return !!(data && data.visibleRestoreHoldUntil && now < data.visibleRestoreHoldUntil);
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

  function isVisiblePreviewWaiting(wrapper, data, visible) {
    if (!wrapper || !data || (!data.unloaded && !data.restoreLoading) || !visible) return false;
    if (data.lightweightModeHold && isLightweightClarityMode()) return false;
    return !!(
      data.previewReady ||
      (wrapper.classList && (wrapper.classList.contains('atp-heavy-preview-active') ||
       wrapper.classList.contains('atp-heavy-preview-pending')))
    );
  }

  function markVisiblePreviewWaiting(wrapper, data, now, visible) {
    if (!data) return 0;
    now = now || Date.now();
    if (visible === undefined) visible = getWrapperBand(wrapper) === 0;
    if (!isVisiblePreviewWaiting(wrapper, data, visible)) {
      if (!visible) clearVisiblePreviewWaiting(data);
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

  function getVisiblePreviewGraceInfo(wrapper, data, stats, mp, now) {
    now = now || Date.now();
    mp = Number(mp) || 0;
    var waitMS = markVisiblePreviewWaiting(wrapper, data, now, true);
    var projectedVisibleMP = roundMP(((stats && stats.heavyVisibleMP) || 0) + mp);
    var visibleRestoreBudgetMP = getHeavyVisibleRestoreBudgetMP();
    var graceBudgetMP = visibleRestoreBudgetMP > 0 ? visibleRestoreBudgetMP + getHeavyVisiblePreviewGraceMP() : 0;
    var minWaitMS = getVisiblePreviewMinWaitMS(data);
    var stableWaitMS = Math.max(minWaitMS, Math.round(getVisiblePreviewStarvationWaitMS() * 0.35));
    var lateWaitMS = Math.max(stableWaitMS, getVisiblePreviewStarvationWaitMS());
    var lastChanceWaitMS = Math.max(lateWaitMS, getVisiblePreviewStarvationWaitMS() * 2);

    var normalAllowed = !!(data && data.unloaded && waitMS >= minWaitMS && isWithinMPBudget(projectedVisibleMP, graceBudgetMP));
    var stableAllowed = !!(data && data.unloaded && !normalAllowed && waitMS >= stableWaitMS &&
      isWithinMPBudget(projectedVisibleMP, getHeavyVisibleStableGraceMP()));
    var lateAllowed = !!(data && data.unloaded && !normalAllowed && !stableAllowed && waitMS >= lateWaitMS &&
      isWithinMPBudget(projectedVisibleMP, getHeavyVisibleLateGraceMP()));
    var lastChanceAllowed = !!(data && data.unloaded && !normalAllowed && !stableAllowed && !lateAllowed &&
      waitMS >= lastChanceWaitMS && isWithinMPBudget(projectedVisibleMP, getHeavyVisibleLastChanceMP()));
    var starvationAllowed = !!(data && data.unloaded && !normalAllowed && !stableAllowed && !lateAllowed &&
      !lastChanceAllowed && waitMS >= lateWaitMS &&
      isWithinMPBudget(projectedVisibleMP, getVisiblePreviewStarvationMP()) &&
      (!stats || !stats.heavyVisibleRestoring));

    var mode = normalAllowed ? 'normal'
      : (stableAllowed ? 'stable'
      : (lateAllowed ? 'late'
      : (lastChanceAllowed ? 'last_chance'
      : (starvationAllowed ? 'starvation' : ''))));
    return {
      allowed: !!mode,
      mode: mode,
      waitMS: waitMS,
      projectedVisibleMP: projectedVisibleMP
    };
  }

  // When img is restored and sharp, detach/hide previewCanvas cleanly;
  // when unloaded or restoring, re-attach cached previewCanvas.
  function setHeavyPreviewActive(data, active) {
    if (!data || !data.wrapper || !data.wrapper.classList) return;
    var wrapper = data.wrapper;
    var lightweight = isLightweightClarityMode();
    wrapper.classList.toggle('atp-heavy-preview-lightweight', !!(active && lightweight));
    if (active && data.previewReady && data.previewCanvas) {
      if (data.previewCanvas.parentNode !== wrapper) {
        wrapper.appendChild(data.previewCanvas);
      }
      wrapper.classList.add('atp-heavy-preview-active');
      wrapper.classList.remove('atp-heavy-preview-pending');
    } else if (active) {
      wrapper.classList.remove('atp-heavy-preview-active');
      wrapper.classList.add('atp-heavy-preview-pending');
    } else {
      wrapper.classList.remove('atp-heavy-preview-active');
      wrapper.classList.remove('atp-heavy-preview-pending');
      wrapper.classList.remove('atp-heavy-preview-lightweight');
      if (data.previewCanvas && data.previewCanvas.parentNode) {
        data.previewCanvas.parentNode.removeChild(data.previewCanvas);
      }
    }
    if (active) {
      markVisiblePreviewWaiting(wrapper, data, Date.now(), getWrapperBand(wrapper) === 0);
    } else {
      clearVisiblePreviewWaiting(data);
    }
  }

  function destroyHeavyPreview(data) {
    if (!data) return;
    data.previewCaptureId = (data.previewCaptureId || 0) + 1;
    data.previewCapturePromise = null;
    if (data.previewIdleHandle) {
      if (data.previewIdleKind === 'ric' && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(data.previewIdleHandle);
      } else {
        clearTimeout(data.previewIdleHandle);
      }
      data.previewIdleHandle = null;
      data.previewIdleKind = '';
    }
    setHeavyPreviewActive(data, false);
    if (data.previewCanvas && data.previewCanvas.parentNode) {
      data.previewCanvas.parentNode.removeChild(data.previewCanvas);
    }
    data.previewCanvas = null;
    data.previewReady = false;
    data.previewSrc = '';
  }

  function computePreviewLayout(naturalWidth, naturalHeight, lightweightPreview) {
    var settings = getSettings();
    var displayWidth = Math.max(1, Number(settings.thumbWidth) || 110);
    var displayHeight = Math.max(1, Number(settings.thumbHeight) || 82);
    var previewMaxEdge = lightweightPreview ? getHeavyLightweightPreviewMaxEdge() : 40;
    var targetW = previewMaxEdge;
    var targetH = Math.max(lightweightPreview ? 48 : 24, Math.round(targetW * displayHeight / displayWidth));
    if (displayHeight > displayWidth) {
      targetH = previewMaxEdge;
      targetW = Math.max(lightweightPreview ? 48 : 24, Math.round(targetH * displayWidth / displayHeight));
    }

    var sourceRatio = naturalWidth / naturalHeight;
    var targetRatio = targetW / targetH;
    var sx = 0;
    var sy = 0;
    var sw = naturalWidth;
    var sh = naturalHeight;
    if (sourceRatio > targetRatio) {
      sw = Math.max(1, Math.round(naturalHeight * targetRatio));
      sx = Math.floor((naturalWidth - sw) / 2);
    } else if (sourceRatio < targetRatio) {
      sh = Math.max(1, Math.round(naturalWidth / targetRatio));
      sy = Math.floor((naturalHeight - sh) / 2);
    }

    var scaleX = displayWidth / Math.max(1, targetW);
    var scaleY = displayHeight / Math.max(1, targetH);
    var skew = Math.max(scaleX, scaleY) / Math.max(0.01, Math.min(scaleX, scaleY));
    return {
      targetW: targetW,
      targetH: targetH,
      sx: sx,
      sy: sy,
      sw: sw,
      sh: sh,
      scaleX: scaleX,
      scaleY: scaleY,
      skew: skew,
      lightweight: lightweightPreview
    };
  }

  function drawSourceToPreviewCanvas(data, source, layout, src, isPreCroppedAndScaled) {
    var canvas = data.previewCanvas;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'atp-heavy-preview-canvas';
      if (canvas.classList && canvas.classList.add) canvas.classList.add('atp-heavy-preview-canvas');
      canvas.setAttribute('aria-hidden', 'true');
      data.previewCanvas = canvas;
    }
    if (canvas.width !== layout.targetW) canvas.width = layout.targetW;
    if (canvas.height !== layout.targetH) canvas.height = layout.targetH;

    var ctx = canvas.getContext && canvas.getContext('2d', { alpha: true });
    if (!ctx) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = layout.lightweight ? 'medium' : 'low';

    var canBakeFilter = ('filter' in ctx) && (layout.lightweight || layout.skew <= 1.25);
    if (canvas.classList) {
      canvas.classList.toggle('atp-heavy-preview-canvas-cssblur', !canBakeFilter);
    }
    ctx.filter = 'none';
    ctx.clearRect(0, 0, layout.targetW, layout.targetH);
    if (canBakeFilter) {
      if (layout.lightweight) {
        ctx.filter = 'saturate(0.98)';
      } else {
        var previewScale = Math.max(layout.scaleX, layout.scaleY);
        var blurSigma = Math.max(0.6, Math.round(HEAVY_PREVIEW_BLUR_DISPLAY_PX / Math.max(1, previewScale) * 100) / 100);
        ctx.filter = 'blur(' + blurSigma + 'px) saturate(0.95)';
      }
    }

    if (isPreCroppedAndScaled) {
      ctx.drawImage(source, 0, 0, layout.targetW, layout.targetH);
    } else {
      ctx.drawImage(source, layout.sx, layout.sy, layout.sw, layout.sh, 0, 0, layout.targetW, layout.targetH);
    }
    ctx.filter = 'none';
    data.previewReady = true;
    data.previewSrc = src;
    data.previewLightweight = layout.lightweight;
    return true;
  }

  function runInIdleFallback(data, fn) {
    return new Promise(function (resolve) {
      if (data.previewIdleHandle) {
        if (data.previewIdleKind === 'ric' && typeof cancelIdleCallback === 'function') {
          cancelIdleCallback(data.previewIdleHandle);
        } else {
          clearTimeout(data.previewIdleHandle);
        }
      }
      var invoke = function () {
        data.previewIdleHandle = null;
        data.previewIdleKind = '';
        try {
          resolve(!!fn());
        } catch (e) {
          resolve(false);
        }
      };
      if (typeof requestIdleCallback === 'function') {
        data.previewIdleKind = 'ric';
        data.previewIdleHandle = requestIdleCallback(invoke, { timeout: 200 });
      } else {
        data.previewIdleKind = 'timer';
        data.previewIdleHandle = setTimeout(invoke, 16);
      }
    });
  }

  // Off-main-thread async downscaling via createImageBitmap with resizeWidth/resizeHeight;
  // falls back to requestIdleCallback ctx.drawImage — NEVER runs synchronous full-MP drawImage in img.onload!
  function captureHeavyPreview(wrapper, data, force) {
    if (!wrapper || !data) return Promise.resolve(false);
    var lightweightPreview = isLightweightClarityMode();
    var src = (data.img && (data.img.currentSrc || data.img.src)) || data.src || '';
    if (!force && data.previewReady && data.previewCanvas && data.previewSrc === src &&
        data.previewLightweight === lightweightPreview) {
      return Promise.resolve(true);
    }
    if (data.previewCapturePromise && !force) {
      return data.previewCapturePromise;
    }
    var img = data.img;
    if (!img || !img.complete || !(img.naturalWidth || data.naturalWidth)) {
      return Promise.resolve(!!(data.previewReady && data.previewCanvas));
    }
    var naturalWidth = img.naturalWidth || data.naturalWidth || 0;
    var naturalHeight = img.naturalHeight || data.naturalHeight || 0;
    if (!naturalWidth || !naturalHeight || !src) {
      return Promise.resolve(!!(data.previewReady && data.previewCanvas));
    }
    data.naturalWidth = naturalWidth;
    data.naturalHeight = naturalHeight;

    var layout = computePreviewLayout(naturalWidth, naturalHeight, lightweightPreview);
    var captureId = (data.previewCaptureId || 0) + 1;
    data.previewCaptureId = captureId;

    function isCaptureStillValid() {
      return heavyRenderItems.get(wrapper) === data && data.previewCaptureId === captureId;
    }

    var promise;
    if (typeof createImageBitmap === 'function') {
      var bitmapOpts = {
        resizeWidth: layout.targetW,
        resizeHeight: layout.targetH,
        resizeQuality: 'low'
      };
      var bitmapPromise;
      try {
        bitmapPromise = createImageBitmap(img, layout.sx, layout.sy, layout.sw, layout.sh, bitmapOpts)
          .then(function (bmp) {
            return { bmp: bmp, cropped: true };
          }, function () {
            return createImageBitmap(img, bitmapOpts).then(function (bmp) {
              return { bmp: bmp, cropped: false };
            });
          });
      } catch (syncErr) {
        try {
          bitmapPromise = createImageBitmap(img, bitmapOpts).then(function (bmp) {
            return { bmp: bmp, cropped: false };
          });
        } catch (err2) {
          bitmapPromise = Promise.reject(err2);
        }
      }

      promise = bitmapPromise.then(function (res) {
        var bmp = res && res.bmp;
        if (!bmp) return false;
        try {
          if (!isCaptureStillValid()) return false;
          if (res.cropped) {
            return drawSourceToPreviewCanvas(data, bmp, layout, src, true);
          }
          var bmpLayout = computePreviewLayout(bmp.width || layout.targetW, bmp.height || layout.targetH, lightweightPreview);
          bmpLayout.targetW = layout.targetW;
          bmpLayout.targetH = layout.targetH;
          bmpLayout.scaleX = layout.scaleX;
          bmpLayout.scaleY = layout.scaleY;
          bmpLayout.skew = layout.skew;
          return drawSourceToPreviewCanvas(data, bmp, bmpLayout, src, false);
        } finally {
          if (typeof bmp.close === 'function') {
            try { bmp.close(); } catch (closeErr) { /* ignore */ }
          }
        }
      }).catch(function () {
        if (!isCaptureStillValid()) return false;
        return runInIdleFallback(data, function () {
          if (!isCaptureStillValid() || !data.img || !data.img.naturalWidth) return !!data.previewReady;
          return drawSourceToPreviewCanvas(data, data.img, layout, src, false);
        });
      });
    } else {
      promise = runInIdleFallback(data, function () {
        if (!isCaptureStillValid() || !data.img || !data.img.naturalWidth) return !!data.previewReady;
        return drawSourceToPreviewCanvas(data, data.img, layout, src, false);
      });
    }

    var tracked = promise.then(function (ok) {
      if (data.previewCapturePromise === tracked) data.previewCapturePromise = null;
      return ok;
    }, function () {
      if (data.previewCapturePromise === tracked) data.previewCapturePromise = null;
      return false;
    });
    data.previewCapturePromise = tracked;
    return tracked;
  }

  function logHeavyRender(type, data, extra, statsOverride) {
    if (!root.ATPLoader || !ATPLoader.logRenderEvent || !data) return;
    if (ATPLoader.isDiagnosticLoggingEnabled && !ATPLoader.isDiagnosticLoggingEnabled('DEBUG')) return;
    var stats = statsOverride || collectSinglePassBudgetState().stats;
    ATPLoader.logRenderEvent(type, data.task, Object.assign({
      reason: type,
      unloadedCount: stats.heavyUnloaded,
      restoreQueue: heavyRestoreQueue.length,
      naturalWidth: data.naturalWidth || 0,
      naturalHeight: data.naturalHeight || 0,
      decodedMP: getDataDecodedMP(data),
      previewReady: !!data.previewReady,
      previewActive: !!(data.wrapper && data.wrapper.classList && data.wrapper.classList.contains('atp-heavy-preview-active')),
      unloaded: !!data.unloaded,
      restoreLoading: !!data.restoreLoading,
      heavyThumbnailClarity: getHeavyThumbnailClarity(),
      visiblePreviewWaitMS: getVisiblePreviewWaitMS(data)
    }, stats, extra || {}));
  }

  function logRenderStateThrottled(data, reason, extra, statsOverride) {
    var now = Date.now();
    if (now - lastRenderStateLogAt < RENDER_STATE_LOG_THROTTLE_MS) return;
    lastRenderStateLogAt = now;
    logHeavyRender('render_state', data, Object.assign({
      reason: reason,
      restoreQueue: heavyRestoreQueue.length
    }, extra || {}), statsOverride);
  }

  function releaseHeavyRestoreSlot(data) {
    if (!data) return;
    if (data.restoreSlotFree) {
      data.restoreSlotFree = false;
      if (heavySlotFreeVisibleRestores > 0) heavySlotFreeVisibleRestores--;
    }
    if (data.restoreSlotToken !== undefined && data.restoreSlotToken !== null) {
      var token = data.restoreSlotToken;
      data.restoreSlotToken = null;
      if (root.ATPLoader && ATPLoader.releaseSlot) ATPLoader.releaseSlot(data.task, token);
    }
  }

  function cancelHeavyRestoreLoad(data, reason) {
    if (!data) return;
    data.restoreDecodeToken = (data.restoreDecodeToken || 0) + 1;
    if (data.restoreRunner) {
      var runner = data.restoreRunner;
      data.restoreRunner = null;
      runner.cancel(reason || 'restore_cancel');
    }
    releaseHeavyRestoreSlot(data);
    if (!data.restoreLoading) return;
    data.restoreLoading = false;
    data.restoreQueued = false;
    data.visibleRestoreHoldUntil = 0;
    if (data.img) {
      data.img.onload = null;
      data.img.onerror = null;
      data.img.removeAttribute('src');
      data.img.removeAttribute('srcset');
      data.img.style.visibility = 'hidden';
    }
    data.unloaded = true;
    if (data.wrapper && data.wrapper.classList) {
      data.wrapper.classList.add('atp-heavy-unloaded');
      setHeavyPreviewActive(data, true);
    }
    logHeavyRender('render_restore_cancel', data, { reason: reason || 'restore_cancel' });
  }

  function removeQueuedHeavyRestore(wrapper, data) {
    data = data || heavyRenderItems.get(wrapper);
    if (data) data.restoreQueued = false;
    if (!heavyRestoreQueue.length) return;
    var idx = heavyRestoreQueue.indexOf(wrapper);
    if (idx !== -1) heavyRestoreQueue.splice(idx, 1);
  }

  function cleanupHeavyRenderItem(wrapper, skipQueueRemove) {
    var data = heavyRenderItems.get(wrapper);
    if (!data) return;
    cancelHeavyRestoreLoad(data, 'cleanup');
    destroyHeavyPreview(data);
    if (!skipQueueRemove) removeQueuedHeavyRestore(wrapper, data);
    heavyRenderItems.delete(wrapper);
    heavyExitUnloadPending.delete(wrapper);
    if (root.ATPViewport) {
      if (ATPViewport.unobserveBand && data.bandListener) {
        ATPViewport.unobserveBand(wrapper, data.bandListener);
      }
      if (ATPViewport.unobserveLoadingAnimation) {
        ATPViewport.unobserveLoadingAnimation(wrapper);
      }
    }
  }

  function performUnloadWithReadyPreview(wrapper, data, extra, statsOverride) {
    if (!data || data.unloaded || !data.img) return false;
    if (typeof document !== 'undefined' && document.contains && !document.contains(wrapper)) return false;
    if (!data.previewReady || !data.previewCanvas) return false;

    data.src = data.img.currentSrc || data.img.src || data.src;
    if (!data.src) return false;
    data.naturalWidth = data.img.naturalWidth || data.naturalWidth || 0;
    data.naturalHeight = data.img.naturalHeight || data.naturalHeight || 0;
    data.noReferrer = data.img.referrerPolicy === 'no-referrer';
    data.restoreDecodeToken = (data.restoreDecodeToken || 0) + 1;

    if (data.restoreRunner) {
      var runner = data.restoreRunner;
      data.restoreRunner = null;
      runner.cancel('unload');
    }
    data.restoreLoading = false;
    data.visibleRestoreHoldUntil = 0;
    data.visibleSeenAt = 0;
    data.visibleLocked = false;
    releaseHeavyRestoreSlot(data);
    removeQueuedHeavyRestore(wrapper, data);

    data.img.onload = null;
    data.img.onerror = null;
    data.img.style.visibility = 'hidden';
    data.img.removeAttribute('src');
    data.unloaded = true;
    if (wrapper.classList) wrapper.classList.add('atp-heavy-unloaded');
    setHeavyPreviewActive(data, true);
    logHeavyRender('render_unload', data, Object.assign({
      srcReleased: true,
      previewKept: true
    }, extra || {}), statsOverride);
    return true;
  }

  function unloadHeavyImage(wrapper, data, extra, statsOverride) {
    if (!data || data.unloaded || !data.img) return false;
    if (typeof document !== 'undefined' && document.contains && !document.contains(wrapper)) return false;
    var lightweight = isLightweightClarityMode();
    var src = data.img.currentSrc || data.img.src || data.src;
    if (!src) return false;
    data.src = src;

    if (data.previewReady && data.previewCanvas && data.previewLightweight === lightweight) {
      return performUnloadWithReadyPreview(wrapper, data, extra, statsOverride);
    }

    // Preview not baked yet — bake asynchronously off-main-thread via createImageBitmap,
    // then complete unload without blocking the main thread!
    if (data.pendingAsyncUnload) return false;
    data.pendingAsyncUnload = true;
    captureHeavyPreview(wrapper, data, false).then(function (ready) {
      data.pendingAsyncUnload = false;
      if (!ready || heavyRenderItems.get(wrapper) !== data || data.unloaded) return;
      if (isLoaderPaused() && !lightweight) {
        performUnloadWithReadyPreview(wrapper, data, extra);
        return;
      }
      if (lightweight) {
        data.lightweightModeHold = true;
        performUnloadWithReadyPreview(wrapper, data, extra);
        return;
      }
      scheduleHeavyBudgetReconcile('preview_baked_reconcile', 0);
    });
    return false;
  }

  function scheduleHeavyBudgetReconcile(reason, delay) {
    if (isLoaderPaused()) return;
    var now = Date.now();
    var effectiveDelay = Math.max(0, delay === undefined ? HEAVY_BUDGET_RECONCILE_DELAY : delay);
    var fireAt = now + effectiveDelay;
    if (heavyBudgetTimer) {
      if (heavyBudgetTimerFireAt >= now && fireAt >= heavyBudgetTimerFireAt) return;
      clearTimeout(heavyBudgetTimer);
      heavyBudgetTimer = null;
    }
    heavyBudgetTimerFireAt = fireAt;
    heavyBudgetTimer = setTimeout(function () {
      heavyBudgetTimer = null;
      heavyBudgetTimerFireAt = 0;
      if (!isLoaderPaused()) reconcileHeavyRenderBudget(reason || 'budget_reconcile_followup');
    }, effectiveDelay);
  }

  function scheduleHeavyRestore(delay) {
    if (!heavyRestoreQueue.length || isLoaderPaused()) return;
    var now = Date.now();
    var effectiveDelay = Math.max(0, delay || 0);
    var fireAt = now + effectiveDelay;
    if (heavyRestoreTimer) {
      if (heavyRestoreTimerFireAt >= now && fireAt >= heavyRestoreTimerFireAt) return;
      clearTimeout(heavyRestoreTimer);
      heavyRestoreTimer = null;
    }
    heavyRestoreTimerFireAt = fireAt;
    heavyRestoreTimer = setTimeout(function () {
      heavyRestoreTimer = null;
      heavyRestoreTimerFireAt = 0;
      processHeavyRestoreQueue();
    }, effectiveDelay);
  }

  function clearHeavyTimers() {
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

  function isHeavyRestoreRetryDeferred(data, visible, now) {
    return data.restoreRetryAt > now || (!visible && data.restoreRetryCount > HEAVY_RESTORE_RETRY_MAX);
  }

  function scheduleHeavyRestoreRetry(wrapper, data, reason) {
    wrapper = wrapper || (data && data.wrapper);
    if (!wrapper || !data || !data.unloaded) return;
    if ((typeof document !== 'undefined' && document.contains && !document.contains(wrapper)) ||
        heavyRenderItems.get(wrapper) !== data) return;
    var band = getWrapperBand(wrapper);
    var visible = band === 0;
    var attempts = (Number(data.restoreRetryCount) || 0) + 1;
    data.restoreRetryCount = attempts;
    if (attempts > HEAVY_RESTORE_RETRY_MAX) {
      data.restoreRetryAt = Date.now() + HEAVY_RESTORE_WATCHDOG_DELAY;
      if (visible) scheduleHeavyBudgetReconcile('restore_retry_watchdog', HEAVY_RESTORE_WATCHDOG_DELAY);
      return;
    }
    var delay = Math.min(
      HEAVY_RESTORE_RETRY_MAX_DELAY,
      HEAVY_RESTORE_DEFER_RETRY_DELAY * Math.pow(2, attempts - 1)
    );
    data.restoreRetryAt = Date.now() + delay;
    if (band <= 1) scheduleHeavyBudgetReconcile(reason || 'restore_retry', delay);
  }

  // --- Single-Pass Budget Snapshot & Reconcile (Zero getBoundingClientRect!) ---

  function collectSinglePassBudgetState() {
    var now = Date.now();
    var inRangeItems = [];
    var offscreenLoadedItems = [];
    var totalLoadedCount = 0;
    var totalLoadedMP = 0;

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
      heavyTotalDecodedCount: 0,
      heavyTotalDecodedMP: 0,
      heavyMaxVisibleMP: 0,
      heavyMaxRangeMP: 0,
      heavyVisibleBudgetMP: getHeavyVisibleBudgetMP(),
      heavyVisibleMinKeep: HEAVY_VISIBLE_MIN_KEEP,
      heavyVisibleRestoreBudgetMP: getHeavyVisibleRestoreBudgetMP(),
      heavyVisibleRestoreSoftBudgetMP: getHeavyVisibleRestoreSoftBudgetMP(),
      heavyVisibleRestoreMinKeep: HEAVY_VISIBLE_RESTORE_MIN_KEEP,
      heavyVisiblePreviewWaiting: 0,
      heavyVisiblePreviewWaitMS: 0,
      heavyBudgetCount: getHeavyDecodedImageLimit(),
      heavyRestoreSoftBudgetMP: getHeavyRangeRestoreSoftBudgetMP(),
      heavyBudgetMP: getHeavyDecodedBudgetMP(),
      heavyUnloadBatchSize: HEAVY_UNLOAD_BATCH_SIZE,
      heavyThumbnailClarity: getHeavyThumbnailClarity(),
      heavyLightweightPreviewMaxEdge: getHeavyLightweightPreviewMaxEdge()
    };

    var detachedWrappers = null;
    heavyRenderItems.forEach(function (data, wrapper) {
      if (!data || !data.img) return;
      if (typeof document !== 'undefined' && document.contains && !document.contains(wrapper)) {
        if (!detachedWrappers) detachedWrappers = [];
        detachedWrappers.push(wrapper);
        return;
      }
      if (data.unloaded) stats.heavyUnloaded++;
      stats.heavyTracked++;

      var band = getWrapperBand(wrapper);
      var visible = band === 0;
      var inRange = band <= 1;
      var restoring = !!data.restoreLoading;
      var loaded = !data.unloaded && !restoring;

      if (band >= 2) {
        if (!data.offscreenSince) data.offscreenSince = now;
      } else {
        data.offscreenSince = 0;
      }

      var renderedVisible = loaded && visible;
      var settling = renderedVisible && isVisibleRestoreSettling(data, now);
      if (data.visibleRestoreHoldUntil && !settling) data.visibleRestoreHoldUntil = 0;
      if (renderedVisible) {
        if (!data.visibleSeenAt) data.visibleSeenAt = now;
        if (isVisibleStable(data, now)) data.visibleLocked = true;
      } else {
        data.visibleSeenAt = 0;
        data.visibleLocked = false;
      }

      var mp = (loaded || inRange || visible) ? getDataDecodedMP(data) : 0;
      if (loaded) {
        totalLoadedCount++;
        totalLoadedMP += mp;
      }
      if (inRange) stats.heavyInRange++;
      if (loaded && inRange) {
        stats.heavyLoadedInRange++;
        stats.heavyRangeMP += mp;
        if (mp > stats.heavyMaxRangeMP) stats.heavyMaxRangeMP = mp;
      }
      if (restoring && inRange) stats.heavyRangeRestoringMP += mp;
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
        var waitMS = markVisiblePreviewWaiting(wrapper, data, now, visible);
        stats.heavyVisiblePreviewWaiting++;
        if (waitMS > stats.heavyVisiblePreviewWaitMS) stats.heavyVisiblePreviewWaitMS = waitMS;
      } else if (data.visiblePreviewSince && !visible) {
        clearVisiblePreviewWaiting(data);
      }

      var record = {
        wrapper: wrapper,
        data: data,
        band: band,
        inRange: inRange,
        visible: visible,
        loaded: loaded,
        restoring: restoring,
        mp: mp
      };
      if (inRange) {
        inRangeItems.push(record);
      } else if (loaded && data.offscreenSince && (now - data.offscreenSince >= HEAVY_EXIT_UNLOAD_GRACE_MS)) {
        offscreenLoadedItems.push(record);
      }
    });

    if (detachedWrappers) {
      for (var d = 0; d < detachedWrappers.length; d++) {
        cleanupHeavyRenderItem(detachedWrappers[d]);
      }
    }

    stats.heavyVisibleMP = roundMP(stats.heavyVisibleMP);
    stats.heavyVisibleRestoringMP = roundMP(stats.heavyVisibleRestoringMP);
    stats.heavyVisibleRestoreSettlingMP = roundMP(stats.heavyVisibleRestoreSettlingMP);
    stats.heavyRangeMP = roundMP(stats.heavyRangeMP);
    stats.heavyRangeRestoringMP = roundMP(stats.heavyRangeRestoringMP);
    stats.heavyTotalDecodedCount = totalLoadedCount;
    stats.heavyTotalDecodedMP = roundMP(totalLoadedMP);
    return {
      now: now,
      inRangeItems: inRangeItems,
      offscreenLoadedItems: offscreenLoadedItems,
      stats: stats
    };
  }

  function getVisibleRenderPressureBudgetMP(stats) {
    if (getHeavyVisibleBudgetMP() <= 0) return 0;
    if (!stats || !stats.heavyVisiblePreviewWaiting) {
      return Math.max(
        getHeavyVisibleBudgetMP(),
        getHeavyVisibleRestoreBudgetMP() + getHeavyVisiblePreviewGraceMP()
      );
    }
    var pressureWaitMS = Math.max(getVisiblePreviewStarvationWaitMS(), HEAVY_VISIBLE_PRESSURE_RELEASE_MIN_MS);
    if (stats.heavyVisiblePreviewWaitMS >= pressureWaitMS) {
      return Math.max(getVisiblePreviewStarvationMP(), getHeavyVisibleLastChanceMP());
    }
    return getHeavyVisibleStableGraceMP();
  }

  function isVisibleRestoreAllowed(wrapper, data, stats) {
    if (!wrapper || !data) return false;
    var mp = getDataDecodedMP(data);
    if (stats.heavyVisibleLoaded < HEAVY_VISIBLE_RESTORE_MIN_KEEP || !mp ||
        isWithinMPBudget(stats.heavyVisibleMP + mp, getHeavyVisibleRestoreBudgetMP())) {
      data.visiblePreviewGraceActive = false;
      data.visiblePreviewGraceMode = '';
      return true;
    }
    var grace = getVisiblePreviewGraceInfo(wrapper, data, stats, mp);
    data.visiblePreviewGraceActive = grace.allowed;
    data.visiblePreviewGraceMode = grace.mode;
    return grace.allowed;
  }

  function reconcileHeavyRenderBudget(reason) {
    if (reconcilingHeavyBudget || !heavyRenderItems.size) return;
    if (heavyBudgetTimer) {
      clearTimeout(heavyBudgetTimer);
      heavyBudgetTimer = null;
      heavyBudgetTimerFireAt = 0;
    }
    reconcilingHeavyBudget = true;
    var needsFollowup = false;
    var needsPreviewRetry = false;
    var nextRetryDelay = Infinity;

    try {
      var pass = collectSinglePassBudgetState();
      var now = pass.now;
      var stats = pass.stats;
      var budgetCount = getHeavyDecodedImageLimit();
      var budgetMP = getHeavyDecodedBudgetMP();
      var remainingUnloads = HEAVY_UNLOAD_BATCH_SIZE;
      var lightweight = isLightweightClarityMode();

      // 1. Evict offscreen (band >= 2 after 300ms exit grace) when over MP/count budget
      if (pass.offscreenLoadedItems.length && (budgetCount > 0 || budgetMP > 0 || lightweight)) {
        pass.offscreenLoadedItems.sort(function (a, b) {
          if (b.band !== a.band) return b.band - a.band;
          return (a.data.offscreenSince || 0) - (b.data.offscreenSince || 0);
        });
        for (var oi = 0; oi < pass.offscreenLoadedItems.length; oi++) {
          var offItem = pass.offscreenLoadedItems[oi];
          var overCount = budgetCount > 0 && stats.heavyTotalDecodedCount > budgetCount;
          var overMP = budgetMP > 0 && stats.heavyTotalDecodedMP > budgetMP;
          if (!lightweight && !overCount && !overMP) break;
          if (remainingUnloads <= 0) {
            needsFollowup = true;
            break;
          }
          if (unloadHeavyImage(offItem.wrapper, offItem.data, { reason: 'offscreen_budget_unload' }, stats)) {
            stats.heavyTotalDecodedCount = Math.max(0, stats.heavyTotalDecodedCount - 1);
            stats.heavyTotalDecodedMP = roundMP(Math.max(0, stats.heavyTotalDecodedMP - offItem.mp));
            remainingUnloads--;
          }
        }
      }

      // 2. Select in-range (band 0 first, then band 1) items within decoded budget
      var orderedInRange = pass.inRangeItems.slice().sort(function (a, b) {
        if (a.band !== b.band) return a.band - b.band;
        return (a.data.task && a.data.task.idx || 0) - (b.data.task && b.data.task.idx || 0);
      });
      var selectedSet = new Set();
      var selCount = 0;
      var selMP = 0;
      for (var si = 0; si < orderedInRange.length; si++) {
        var cand = orderedInRange[si];
        if (cand.data.unloaded && isHeavyRestoreRetryDeferred(cand.data, cand.visible, now)) {
          if (!lightweight && cand.data.restoreRetryAt > now &&
              (cand.visible || cand.data.restoreRetryCount <= HEAVY_RESTORE_RETRY_MAX)) {
            var retryRem = cand.data.restoreRetryAt - now;
            if (retryRem < nextRetryDelay) nextRetryDelay = retryRem;
          }
          continue;
        }
        var keepMin = selCount < getHeavyRenderMinKeep();
        var withinBudget = (budgetCount <= 0 || selCount < budgetCount) &&
          (!cand.mp || isWithinMPBudget(selMP + cand.mp, budgetMP));
        if (!keepMin && !withinBudget) continue;
        selectedSet.add(cand.wrapper);
        selCount++;
        selMP += cand.mp;
      }

      // 3. Visible render pressure check
      var pressureBudgetMP = getVisibleRenderPressureBudgetMP(stats);
      if (!isWithinMPBudget(stats.heavyVisibleMP, pressureBudgetMP)) {
        var visEvictCandidates = [];
        for (var vi = 0; vi < orderedInRange.length; vi++) {
          var vItem = orderedInRange[vi];
          if (!vItem.loaded || !vItem.visible) continue;
          if (!vItem.data.visibleLocked && !isVisibleRestoreSettling(vItem.data, now)) {
            visEvictCandidates.push(vItem);
          }
        }
        visEvictCandidates.sort(function (a, b) { return b.mp - a.mp; });
        for (var vei = 0; vei < visEvictCandidates.length; vei++) {
          if (isWithinMPBudget(stats.heavyVisibleMP, pressureBudgetMP) ||
              stats.heavyVisibleLoaded <= HEAVY_VISIBLE_MIN_KEEP) break;
          if (remainingUnloads <= 0) {
            needsFollowup = true;
            break;
          }
          var ev = visEvictCandidates[vei];
          if (unloadHeavyImage(ev.wrapper, ev.data, { reason: 'visible_budget_unload' }, stats)) {
            stats.heavyVisibleMP = roundMP(Math.max(0, stats.heavyVisibleMP - ev.mp));
            stats.heavyVisibleLoaded--;
            remainingUnloads--;
          }
        }
      }

      // 4. Evict non-visible band 1 items not selected by budget
      for (var bi = 0; bi < orderedInRange.length; bi++) {
        var bItem = orderedInRange[bi];
        if (!bItem.loaded || bItem.visible || selectedSet.has(bItem.wrapper)) continue;
        if (remainingUnloads <= 0) {
          needsFollowup = true;
          break;
        }
        if (unloadHeavyImage(bItem.wrapper, bItem.data, { reason: 'budget_unload' }, stats)) {
          remainingUnloads--;
        }
      }

      // 5. Enqueue eligible unloaded in-range items for restore (unless lightweight clarity mode)
      if (!lightweight) {
        for (var qi = 0; qi < orderedInRange.length; qi++) {
          var qItem = orderedInRange[qi];
          var qData = qItem.data;
          if (!qData.unloaded || qData.restoreQueued) continue;
          if (isHeavyRestoreRetryDeferred(qData, qItem.visible, now)) continue;
          if (!qItem.visible && !selectedSet.has(qItem.wrapper)) continue;
          if (qItem.visible && !isVisibleRestoreAllowed(qItem.wrapper, qData, stats)) {
            setHeavyPreviewActive(qData, true);
            needsPreviewRetry = true;
            continue;
          }
          qData.lightweightModeHold = false;
          qData.restoreQueued = true;
          qData.restoreQueuedAt = now;
          var wasEmptyQueue = heavyRestoreQueue.length === 0;
          heavyRestoreQueue.push(qItem.wrapper);
          scheduleHeavyRestore(isScrollingActive()
            ? HEAVY_RESTORE_SCROLL_DELAY
            : (qItem.visible
              ? (wasEmptyQueue ? HEAVY_RESTORE_IDLE_KICK_DELAY : HEAVY_RESTORE_VISIBLE_NEXT_DELAY)
              : HEAVY_RESTORE_BATCH_DELAY));
        }
      }
    } finally {
      reconcilingHeavyBudget = false;
    }

    if (needsFollowup) {
      scheduleHeavyBudgetReconcile(reason || 'budget_reconcile_followup', HEAVY_BUDGET_RECONCILE_DELAY);
    } else if (needsPreviewRetry) {
      scheduleHeavyBudgetReconcile('visible_preview_defer_retry', HEAVY_RESTORE_DEFER_RETRY_DELAY);
    }
    if (nextRetryDelay < Infinity) {
      scheduleHeavyBudgetReconcile('restore_retry_pending', nextRetryDelay);
    }
  }

  function flushHeavyExitUnloads() {
    heavyExitUnloadTimer = null;
    if (!heavyExitUnloadPending.size) return;
    heavyExitUnloadPending.clear();
    reconcileHeavyRenderBudget('exit_unload_flush');
  }

  function scheduleHeavyExitUnload(wrapper) {
    heavyExitUnloadPending.add(wrapper);
    if (!heavyExitUnloadTimer) {
      heavyExitUnloadTimer = setTimeout(flushHeavyExitUnloads, HEAVY_EXIT_UNLOAD_GRACE_MS);
    }
  }

  function getHeavyRestoreDelayInfo(mp, stats, restoredVisibleMP, restoredRangeMP) {
    mp = Number(mp) || 0;
    var projectedVisibleMP = roundMP(stats.heavyVisibleMP + restoredVisibleMP + mp);
    var projectedRangeMP = roundMP(stats.heavyRangeMP + restoredRangeMP + mp);
    if (isMPBudgetReached(projectedVisibleMP, getHeavyVisibleRestoreBudgetMP()) ||
        isMPBudgetReached(projectedRangeMP, getHeavyDecodedBudgetMP())) {
      return { delay: HEAVY_RESTORE_PRESSURE_DELAY, pressure: 'hard', projectedVisibleMP: projectedVisibleMP, projectedRangeMP: projectedRangeMP };
    }
    if (isMPBudgetReached(projectedVisibleMP, getHeavyVisibleRestoreSoftBudgetMP()) ||
        isMPBudgetReached(projectedRangeMP, getHeavyRangeRestoreSoftBudgetMP())) {
      return { delay: HEAVY_RESTORE_SOFT_PRESSURE_DELAY, pressure: 'soft', projectedVisibleMP: projectedVisibleMP, projectedRangeMP: projectedRangeMP };
    }
    if (mp <= HEAVY_RESTORE_FAST_MP) {
      return { delay: HEAVY_RESTORE_FAST_DELAY, pressure: 'fast', projectedVisibleMP: projectedVisibleMP, projectedRangeMP: projectedRangeMP };
    }
    if (mp >= HEAVY_ULTRA_MP) {
      return { delay: HEAVY_RESTORE_ULTRA_DELAY, pressure: 'ultra', projectedVisibleMP: projectedVisibleMP, projectedRangeMP: projectedRangeMP };
    }
    return { delay: HEAVY_RESTORE_BATCH_DELAY, pressure: 'normal', projectedVisibleMP: projectedVisibleMP, projectedRangeMP: projectedRangeMP };
  }

  // Async img.decode() before hiding previewCanvas and revealing img — eliminates raster freezes!
  function restoreHeavyImage(wrapper, data) {
    if (!data || !data.unloaded || !data.img || !data.src) return false;
    if (typeof document !== 'undefined' && document.contains && !document.contains(wrapper)) return false;

    var band = getWrapperBand(wrapper);
    var restoreVisible = band === 0 && (typeof document === 'undefined' || document.visibilityState === 'visible');
    if (isHeavyRestoreRetryDeferred(data, restoreVisible, Date.now())) return false;

    if (data.task) {
      if (root.ATPLoader && ATPLoader.updateTaskViewportPriority) {
        ATPLoader.updateTaskViewportPriority(data.task, wrapper, restoreVisible);
      } else {
        data.task.currentlyVisible = restoreVisible;
        data.task.viewportPriority = restoreVisible;
      }
    }

    if (data.task && root.ATPLoader && ATPLoader.acquireSlot) {
      data.task.taskDeadlineAt = 0;
      if (!ATPLoader.acquireSlot(data.task)) {
        var hostCooling = !!(ATPLoader.isTaskHostCoolingDown && ATPLoader.isTaskHostCoolingDown(data.task));
        if (!restoreVisible || hostCooling || heavySlotFreeVisibleRestores > 0) {
          logRenderStateThrottled(data, 'restore_slot_wait', { actualVisible: restoreVisible });
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
    clearVisiblePreviewWaiting(data);
    data.unloaded = false;
    data.restoreLoading = true;
    data.restoreQueued = false;
    data.visibleSeenAt = 0;
    data.visibleLocked = false;
    if (wrapper.classList) wrapper.classList.remove('atp-heavy-unloaded');
    setHeavyPreviewActive(data, true);
    data.img.style.visibility = 'hidden';

    var decodeToken = (data.restoreDecodeToken || 0) + 1;
    data.restoreDecodeToken = decodeToken;

    var completeRestoreSuccess = function () {
      if (heavyRenderItems.get(wrapper) !== data || data.restoreDecodeToken !== decodeToken) return;
      data.restoreRunner = null;
      releaseHeavyRestoreSlot(data);
      data.naturalWidth = data.img.naturalWidth || data.naturalWidth || 0;
      data.naturalHeight = data.img.naturalHeight || data.naturalHeight || 0;

      // Decode asynchronously off-main-thread BEFORE hiding previewCanvas and revealing sharp img!
      var decodeStep = typeof data.img.decode === 'function'
        ? data.img.decode().catch(function () {})
        : Promise.resolve();

      decodeStep.then(function () {
        if (heavyRenderItems.get(wrapper) !== data || data.restoreDecodeToken !== decodeToken) return;
        if (typeof document !== 'undefined' && document.contains && !document.contains(wrapper)) {
          cleanupHeavyRenderItem(wrapper);
          return;
        }
        data.restoreLoading = false;
        data.restoreRetryCount = 0;
        data.restoreRetryAt = 0;

        if (isLightweightClarityMode()) {
          data.lightweightModeHold = true;
          captureHeavyPreview(wrapper, data, true).then(function (ok) {
            if (ok && heavyRenderItems.get(wrapper) === data && isLightweightClarityMode()) {
              performUnloadWithReadyPreview(wrapper, data, { reason: 'lightweight_mode_unload' });
            }
          });
          return;
        }

        data.lightweightModeHold = false;
        data.img.style.visibility = '';
        data.img.style.display = 'block';
        setHeavyPreviewActive(data, false);
        var now = Date.now();
        var visNow = getWrapperBand(wrapper) === 0;
        data.visibleSeenAt = visNow ? now : 0;
        data.visibleRestoreHoldUntil = visNow ? now + HEAVY_VISIBLE_RESTORE_SETTLE_MS : 0;
        data.visibleLocked = false;
        scheduleHeavyBudgetReconcile('restore_loaded', HEAVY_BUDGET_RECONCILE_DELAY);
        if (!data.previewReady) captureHeavyPreview(wrapper, data, false);
      });
    };

    var completeRestoreFailure = function (failReason) {
      if (heavyRenderItems.get(wrapper) !== data || data.restoreDecodeToken !== decodeToken) return;
      data.restoreRunner = null;
      releaseHeavyRestoreSlot(data);
      data.restoreLoading = false;
      data.unloaded = true;
      data.img.style.visibility = 'hidden';
      data.img.removeAttribute('src');
      if (wrapper.classList) wrapper.classList.add('atp-heavy-unloaded');
      setHeavyPreviewActive(data, true);
      logHeavyRender('render_restore_error', data, { reason: failReason || 'restore_error', previewKept: !!data.previewReady });
      scheduleHeavyRestoreRetry(wrapper, data, 'restore_error_retry');
    };

    if (root.ATPImageRunner && typeof ATPImageRunner.run === 'function') {
      data.restoreRunner = ATPImageRunner.run(data.task || { candidates: [{ src: data.src }], idx: 0 }, {
        wrapper: wrapper,
        existingImg: data.img,
        srcOverride: data.src,
        forceNoReferrer: data.noReferrer,
        skipFallbacks: true,
        keepImgOnPreempt: true,
        slotToken: data.restoreSlotToken,
        isRestore: true,
        onSuccess: function () {
          completeRestoreSuccess();
        },
        onFailure: function (reason) {
          completeRestoreFailure(reason);
        },
        onPreempt: function (reason) {
          cancelHeavyRestoreLoad(data, reason || 'restore_preempt');
        }
      });
    } else {
      data.img.onload = function () {
        data.img.onload = data.img.onerror = null;
        completeRestoreSuccess();
      };
      data.img.onerror = function () {
        data.img.onload = data.img.onerror = null;
        completeRestoreFailure('restore_error');
      };
      data.img.decoding = 'async';
      if (data.noReferrer) data.img.referrerPolicy = 'no-referrer';
      else data.img.removeAttribute('referrerpolicy');
      data.img.src = data.src;
    }

    logHeavyRender('render_restore', data, {
      srcRestored: true,
      visiblePreviewWaitMS: visiblePreviewWaitMS
    });
    return true;
  }

  function processHeavyRestoreQueue() {
    heavyRestoreTimer = null;
    if (isLoaderPaused() || !heavyRestoreQueue.length) return;
    if (isScrollingActive()) {
      scheduleHeavyRestore(HEAVY_RESTORE_SCROLL_DELAY);
      return;
    }

    var pass = collectSinglePassBudgetState();
    var now = pass.now;
    var stats = pass.stats;
    var lightweight = isLightweightClarityMode();

    // Filter queue in-place using cached bands (zero getBoundingClientRect!)
    var writeIdx = 0;
    for (var i = 0; i < heavyRestoreQueue.length; i++) {
      var wrapper = heavyRestoreQueue[i];
      var data = heavyRenderItems.get(wrapper);
      if (!data) continue;
      if ((typeof document !== 'undefined' && document.contains && !document.contains(wrapper)) ||
          (root.ATPLoader && ATPLoader.isTaskCurrent && data.task && !ATPLoader.isTaskCurrent(data.task))) {
        cleanupHeavyRenderItem(wrapper, true);
        continue;
      }
      if (!data.unloaded) {
        data.restoreQueued = false;
        continue;
      }
      if (lightweight) {
        data.restoreQueued = false;
        data.lightweightModeHold = true;
        setHeavyPreviewActive(data, true);
        continue;
      }
      var band = getWrapperBand(wrapper);
      if (band > 1) {
        data.restoreQueued = false;
        continue;
      }
      var visible = band === 0;
      if (isHeavyRestoreRetryDeferred(data, visible, now)) {
        data.restoreQueued = false;
        continue;
      }
      if (visible && !isVisibleRestoreAllowed(wrapper, data, stats)) {
        data.restoreQueued = false;
        setHeavyPreviewActive(data, true);
        scheduleHeavyBudgetReconcile('visible_preview_defer_retry', HEAVY_RESTORE_DEFER_RETRY_DELAY);
        continue;
      }
      heavyRestoreQueue[writeIdx++] = wrapper;
    }
    heavyRestoreQueue.length = writeIdx;
    if (!heavyRestoreQueue.length) return;

    heavyRestoreQueue.sort(function (a, b) {
      var bandA = getWrapperBand(a);
      var bandB = getWrapperBand(b);
      if (bandA !== bandB) return bandA - bandB;
      var mpA = getDataDecodedMP(heavyRenderItems.get(a));
      var mpB = getDataDecodedMP(heavyRenderItems.get(b));
      return mpA - mpB;
    });

    var fastBatchLimit = getHeavyRestoreFastBatchSize();
    var pressureBatchLimit = getHeavyRestorePressureBatchSize();
    var batchLimit = Math.max(fastBatchLimit, pressureBatchLimit);
    var restored = 0;
    var fastRestored = 0;
    var pressureRestored = 0;
    var restoredVisibleMP = 0;
    var restoredRangeMP = 0;
    var nextDelay = HEAVY_RESTORE_FAST_DELAY;
    var consumeIdx = 0;

    while (consumeIdx < heavyRestoreQueue.length && restored < batchLimit) {
      var targetWrapper = heavyRestoreQueue[consumeIdx];
      var targetData = heavyRenderItems.get(targetWrapper);
      if (!targetData || !targetData.unloaded) {
        consumeIdx++;
        continue;
      }
      var targetBand = getWrapperBand(targetWrapper);
      var mp = getDataDecodedMP(targetData);
      var delayInfo = getHeavyRestoreDelayInfo(mp, stats, restoredVisibleMP, restoredRangeMP);
      if (restored > 0 && (
        isMPBudgetReached(delayInfo.projectedVisibleMP, getHeavyVisibleRestoreBudgetMP()) ||
        isMPBudgetReached(delayInfo.projectedRangeMP, getHeavyDecodedBudgetMP())
      )) {
        targetData.restoreQueued = true;
        break;
      }
      var fastLane = delayInfo.pressure === 'fast';
      if ((fastLane ? fastRestored : pressureRestored) >= (fastLane ? fastBatchLimit : pressureBatchLimit)) {
        targetData.restoreQueued = true;
        break;
      }
      targetData.restoreQueued = false;
      if (!restoreHeavyImage(targetWrapper, targetData)) {
        targetData.restoreQueued = true;
        break;
      }
      if (targetBand === 0) restoredVisibleMP += mp;
      if (targetBand <= 1) restoredRangeMP += mp;
      nextDelay = Math.max(nextDelay, delayInfo.delay);
      restored++;
      if (fastLane) fastRestored++;
      else pressureRestored++;
      consumeIdx++;
    }

    if (consumeIdx > 0) heavyRestoreQueue.splice(0, consumeIdx);
    // Removed duplicate reconcileHeavyRenderBudget('after_restore_batch') scan here;
    // each restored image schedules reconcile cleanly after async img.decode() completes!
    if (heavyRestoreQueue.length) {
      var continueDelay = restored > 0 ? nextDelay : HEAVY_RESTORE_DEFER_RETRY_DELAY;
      if (restored > 0 && getWrapperBand(heavyRestoreQueue[0]) === 0) {
        continueDelay = Math.min(continueDelay, HEAVY_RESTORE_VISIBLE_NEXT_DELAY);
      }
      scheduleHeavyRestore(continueDelay);
    }
  }

  function onWrapperBandChange(wrapper, nextBand, prevBand) {
    var data = heavyRenderItems.get(wrapper);
    if (!data) return;
    if ((typeof document !== 'undefined' && document.contains && !document.contains(wrapper)) ||
        (root.ATPLoader && ATPLoader.isTaskCurrent && data.task && !ATPLoader.isTaskCurrent(data.task))) {
      cleanupHeavyRenderItem(wrapper);
      return;
    }
    var now = Date.now();
    if (nextBand <= 1) {
      data.offscreenSince = 0;
      heavyExitUnloadPending.delete(wrapper);
      if (data.unloaded && !isLightweightClarityMode()) {
        scheduleHeavyBudgetReconcile('band_enter', isScrollingActive() ? HEAVY_RESTORE_SCROLL_DELAY : 0);
      }
    } else if (!data.unloaded) {
      if (!data.offscreenSince) data.offscreenSince = now;
      scheduleHeavyExitUnload(wrapper);
    }
  }

  // --- Public ATPHeavyBudget API ---

  var ATPHeavyBudget = {
    monitorLoadedHeavyImage: function (wrapper, img, task) {
      if (!wrapper || !img || !shouldMonitorHeavyImage(task)) return;
      cleanupHeavyRenderItem(wrapper);
      var now = Date.now();
      var initialBand = task && task.currentlyVisible === true ? 0 : getWrapperBand(wrapper);
      var bandListener = function (el, nextBand, prevBand) {
        onWrapperBandChange(el, nextBand, prevBand);
      };
      if (root.ATPViewport && ATPViewport.observeBand) {
        initialBand = ATPViewport.observeBand(wrapper, bandListener, initialBand);
      }
      if (root.ATPViewport && ATPViewport.observeLoadingAnimation) {
        ATPViewport.observeLoadingAnimation(wrapper);
      }
      var visible = initialBand === 0;
      var data = {
        wrapper: wrapper,
        img: img,
        task: task,
        src: img.currentSrc || img.src || (root.ATPLoader && ATPLoader.getTaskImageSrc ? ATPLoader.getTaskImageSrc(task) : ''),
        noReferrer: img.referrerPolicy === 'no-referrer',
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
        visibleSeenAt: visible ? now : 0,
        visibleLocked: false,
        visibleRestoreHoldUntil: visible ? now + HEAVY_VISIBLE_RESTORE_SETTLE_MS : 0,
        offscreenSince: initialBand >= 2 ? now : 0,
        visiblePreviewSince: 0,
        visiblePreviewGraceActive: false,
        visiblePreviewGraceMode: '',
        previewCanvas: null,
        previewReady: false,
        previewSrc: '',
        previewLightweight: false,
        previewCaptureId: 0,
        previewCapturePromise: null,
        previewIdleHandle: null,
        previewIdleKind: '',
        lightweightModeHold: false,
        restoreRetryCount: 0,
        restoreRetryAt: 0,
        restoreLoading: false,
        restoreQueued: false,
        restoreRunner: null,
        restoreDecodeToken: 0,
        unloaded: false,
        bandListener: bandListener
      };
      heavyRenderItems.set(wrapper, data);

      if (wrapper.classList) {
        wrapper.classList.add('atp-heavy-thumbnail');
        wrapper.classList.remove('atp-heavy-preview-active');
        wrapper.classList.remove('atp-heavy-preview-pending');
        wrapper.classList.remove('atp-heavy-unloaded');
      }

      if (isLightweightClarityMode()) {
        // Never run synchronous full-MP drawImage inside img.onload!
        // Downscale off-main-thread via createImageBitmap, then activate 160px sharp preview & unload img.src.
        data.lightweightModeHold = true;
        if (wrapper.classList) wrapper.classList.add('atp-heavy-preview-pending');
        captureHeavyPreview(wrapper, data, false).then(function (ready) {
          if (heavyRenderItems.get(wrapper) !== data) return;
          if (ready && isLightweightClarityMode()) {
            performUnloadWithReadyPreview(wrapper, data, {
              reason: 'lightweight_mode_unload',
              heavyThumbnailClarity: 'lightweight'
            });
          } else {
            data.lightweightModeHold = false;
            data.img.style.visibility = '';
            setHeavyPreviewActive(data, false);
          }
        });
        return;
      }

      // Balanced mode: prewarm tiny 40px blurred preview off-main-thread & reconcile budget
      captureHeavyPreview(wrapper, data, false).then(function () {
        if (heavyRenderItems.get(wrapper) !== data) return;
        scheduleHeavyBudgetReconcile('monitor_prewarm_ready', HEAVY_BUDGET_RECONCILE_DELAY);
      });
      scheduleHeavyBudgetReconcile('monitor_loaded', HEAVY_BUDGET_RECONCILE_DELAY);
    },

    captureHeavyPreview: captureHeavyPreview,
    reconcileHeavyRenderBudget: reconcileHeavyRenderBudget,
    onWrapperBandChange: onWrapperBandChange,

    pauseHeavyRestores: function () {
      if (heavyExitUnloadTimer) {
        clearTimeout(heavyExitUnloadTimer);
        heavyExitUnloadTimer = null;
        flushHeavyExitUnloads();
      }
      clearHeavyTimers();
      heavyRenderItems.forEach(function (data) {
        if (data && data.restoreRunner && data.restoreRunner.pauseTimer) {
          data.restoreRunner.pauseTimer();
        }
      });
    },

    cancelHeavyRestores: function (reason) {
      clearHeavyTimers();
      heavyRenderItems.forEach(function (data) {
        cancelHeavyRestoreLoad(data, reason || 'cancel_heavy_restores');
      });
    },

    resumeHeavyRestores: function (reason) {
      clearHeavyTimers();
      if (isLoaderPaused()) return;
      heavyRenderItems.forEach(function (data, wrapper) {
        if (data && data.restoreRunner && data.restoreRunner.resumeTimer) {
          data.restoreRunner.resumeTimer();
        } else if (data && !data.previewReady && !data.unloaded) {
          captureHeavyPreview(wrapper, data, false);
        }
      });
      reconcileHeavyRenderBudget(reason || 'scroll_idle_budget');
      scheduleHeavyRestore(HEAVY_RESTORE_IDLE_KICK_DELAY);
    },

    discardThreadImages: function (threadIds) {
      if (!threadIds || !heavyRenderItems.size) return;
      var removed = false;
      var toCleanup = [];
      heavyRenderItems.forEach(function (data, wrapper) {
        if (data && data.task && threadIds.has(data.task.threadId)) {
          toCleanup.push(wrapper);
        }
      });
      for (var i = 0; i < toCleanup.length; i++) {
        cleanupHeavyRenderItem(toCleanup[i], true);
        removed = true;
      }
      if (removed) {
        var writeIdx = 0;
        for (var r = 0; r < heavyRestoreQueue.length; r++) {
          if (heavyRenderItems.has(heavyRestoreQueue[r])) {
            heavyRestoreQueue[writeIdx++] = heavyRestoreQueue[r];
          }
        }
        heavyRestoreQueue.length = writeIdx;
        if (heavyRenderItems.size) scheduleHeavyBudgetReconcile('thread_removed', 0);
        else clearHeavyTimers();
      }
    },

    reconfigure: function (reason) {
      clearHeavyTimers();
      if (!isLoaderPaused() && heavyRenderItems.size) {
        if (isLightweightClarityMode()) {
          heavyRenderItems.forEach(function (data, wrapper) {
            if (!data || data.unloaded) return;
            data.lightweightModeHold = true;
            unloadHeavyImage(wrapper, data, { reason: 'reconfigure_lightweight' });
          });
        } else {
          heavyRenderItems.forEach(function (data) {
            if (data) data.lightweightModeHold = false;
          });
        }
        reconcileHeavyRenderBudget(reason || 'settings_reconfigure');
        scheduleHeavyRestore(0);
      }
      return {
        heavyDecodedImageLimit: getHeavyDecodedImageLimit(),
        heavyDecodedBudgetMP: getHeavyDecodedBudgetMP(),
        heavyVisibleBudgetMP: getHeavyVisibleBudgetMP(),
        heavyLightweightPreviewEdge: getHeavyLightweightPreviewMaxEdge()
      };
    },

    destroy: function () {
      clearHeavyTimers();
      if (heavyExitUnloadTimer) {
        clearTimeout(heavyExitUnloadTimer);
        heavyExitUnloadTimer = null;
      }
      heavyExitUnloadPending.clear();
      heavySlotFreeVisibleRestores = 0;
      heavyRestoreQueue = [];
      var wrappers = Array.from(heavyRenderItems.keys());
      for (var i = 0; i < wrappers.length; i++) {
        cleanupHeavyRenderItem(wrappers[i], true);
      }
      heavyRenderItems.clear();
    },

    getHeavyUnloadedCount: function () {
      var count = 0;
      heavyRenderItems.forEach(function (data) {
        if (data && data.unloaded) count++;
      });
      return count;
    },

    getHeavyRestoreQueueCount: function () {
      return heavyRestoreQueue.length;
    },

    getHeavyRenderStats: function () {
      return collectSinglePassBudgetState().stats;
    }
  };

  root.ATPHeavyBudget = ATPHeavyBudget;
  globalThis.ATPHeavyBudget = ATPHeavyBudget;
})();
