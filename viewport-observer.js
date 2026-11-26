(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;

  // 3 persistent, static IntersectionObserver instances — NEVER disconnected or rebuilt during scroll.
  var BAND0_MARGIN = '0px';
  var BAND1_MARGIN = '240px 0px 240px 0px';
  var BAND2_MARGIN = '1000px 0px 1000px 0px';

  var band0Observer = null;
  var band1Observer = null;
  var band2Observer = null;
  var hasDeliveredIO = false;

  var trackedElements = new Map();
  var pendingWrappers = new Map();
  var visiblePendingWrappers = new Set();
  var loadingAnimationWrappers = new Set();
  var observedScrollRoots = new Map();

  // Passive scroll velocity state (1 window.scrollY read per rAF max, zero element layout reads)
  var SCROLL_IDLE_MS = 180;
  var FAST_SCROLL_MIN_DELTA_PX = 40;
  var FAST_SCROLL_THRESHOLD_PX_MS = 1.1;
  var SLOW_SCROLL_THRESHOLD_PX_MS = 0.35;

  var scrollMode = 'idle';
  var scrollListenerAttached = false;
  var scrollRafId = null;
  var scrollIdleTimer = null;
  var lastScrollY = null;
  var lastScrollSampleAt = 0;
  var slowScrollSampleCount = 0;
  var pendingRetryTimer = null;

  function nowPerf() {
    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function getSettings() { return (root.ATPState && root.ATPState.settings) || {}; }
  function isLoaderPaused() { return !!(root.ATPLoader && ATPLoader.isPaused && ATPLoader.isPaused()); }

  function notifySchedule(reason) {
    if (isLoaderPaused() || !root.ATPLoader) return;
    if (typeof ATPLoader.requestSchedule === 'function') ATPLoader.requestSchedule(reason || 'viewport_band_change');
    else if (typeof ATPLoader.globalSchedule === 'function') ATPLoader.globalSchedule();
  }

  function computeBandFromMask(mask) {
    return (mask & 1) ? 0 : ((mask & 2) ? 1 : ((mask & 4) ? 2 : 3));
  }

  function computeInitialRectBand(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    var rect = el.getBoundingClientRect();
    if (!rect || typeof rect.top !== 'number' || typeof rect.bottom !== 'number') return null;
    var winH = (typeof root.innerHeight === 'number' && root.innerHeight > 0)
      ? root.innerHeight
      : ((typeof document !== 'undefined' && document.documentElement && document.documentElement.clientHeight) || 800);
    var sr = el.closest && el.closest('.atp-scroll-viewport');
    if (sr && typeof sr.getBoundingClientRect === 'function') {
      var srRect = sr.getBoundingClientRect();
      if (srRect && (srRect.bottom <= -1000 || srRect.top >= winH + 1000)) return 3;
      if (srRect && (rect.bottom <= srRect.top || rect.top >= srRect.bottom)) return 3;
    }
    if (rect.bottom > 0 && rect.top < winH) return 0;
    if (rect.bottom > -240 && rect.top < winH + 240) return 1;
    if (rect.bottom > -1000 && rect.top < winH + 1000) return 2;
    return 3;
  }

  function setLoadingAnimationClass(wrapper, active) {
    if (!wrapper || !wrapper.classList) return;
    if (active) wrapper.classList.add('atp-loading-near-viewport');
    else wrapper.classList.remove('atp-loading-near-viewport');
  }

  function applyElementBand(el, rec, nextBand) {
    var prevBand = rec.band;
    rec.band = nextBand;
    rec.ioSeen = true;
    el.__atpViewportBand = nextBand;

    var docVisible = typeof document === 'undefined' || document.visibilityState === 'visible';
    var isVisibleNow = docVisible && nextBand === 0;
    if (rec.isLoadingAnim) setLoadingAnimationClass(el, isVisibleNow);

    if (rec.threadStates && rec.threadStates.size) {
      rec.threadStates.forEach(function (ts) {
        if (!ts) return;
        ts.viewportBand = nextBand;
        ts.readyImageVisible = isVisibleNow;
        if (root.ATPLoader && typeof ATPLoader.syncThreadVisibility === 'function') {
          ATPLoader.syncThreadVisibility(ts, isVisibleNow, nextBand);
        }
      });
    }

    var pData = pendingWrappers.get(el);
    var task = (pData && pData.task) || el.__atpLoadTask;
    if (task) {
      task.viewportBand = nextBand;
      if (root.ATPLoader && typeof ATPLoader.updateTaskViewportPriority === 'function') {
        ATPLoader.updateTaskViewportPriority(task, el, isVisibleNow);
      } else {
        task.currentlyVisible = isVisibleNow;
        task.viewportPriority = isVisibleNow;
      }
    }

    if (pData && !pData.loaded) {
      pData.inViewport = nextBand <= 2;
      pData.actualInViewport = isVisibleNow;
      if (isVisibleNow) {
        if (!pData.actualInViewportAt) pData.actualInViewportAt = Date.now();
        if (!pData.inViewportAt) pData.inViewportAt = pData.actualInViewportAt;
        visiblePendingWrappers.add(el);
      } else {
        visiblePendingWrappers.delete(el);
        pData.actualInViewportAt = 0;
        if (nextBand > 2) pData.inViewportAt = 0;
      }
    } else {
      visiblePendingWrappers.delete(el);
    }

    if (rec.bandListeners && rec.bandListeners.size) {
      rec.bandListeners.forEach(function (fn) {
        try { fn(el, nextBand, prevBand); } catch (e) { /* ignore */ }
      });
    }
    return nextBand !== prevBand;
  }

  function makeBandCallback(bit) {
    return function (entries) {
      hasDeliveredIO = true;
      var shouldWakeLoader = false;
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var el = entry.target;
        var rec = trackedElements.get(el);
        if (!rec) continue;
        if (entry.isIntersecting) rec.mask |= bit;
        else rec.mask &= ~bit;
        var nextBand = computeBandFromMask(rec.mask);
        var prevBand = rec.band;
        if (applyElementBand(el, rec, nextBand) && nextBand <= 2 && nextBand < prevBand) {
          shouldWakeLoader = true;
        } else if (prevBand === 0 && nextBand > 0 && rec.threadStates && rec.threadStates.size > 0) {
          shouldWakeLoader = true;
        } else if (nextBand === 0 && pendingWrappers.has(el)) {
          shouldWakeLoader = true;
        }
      }
      if (shouldWakeLoader) notifySchedule('viewport_band_change');
    };
  }

  function ensureBandObservers() {
    if (typeof IntersectionObserver !== 'function') return false;
    if (!band0Observer) band0Observer = new IntersectionObserver(makeBandCallback(1), { root: null, rootMargin: BAND0_MARGIN, threshold: 0 });
    if (!band1Observer) band1Observer = new IntersectionObserver(makeBandCallback(2), { root: null, rootMargin: BAND1_MARGIN, threshold: 0 });
    if (!band2Observer) band2Observer = new IntersectionObserver(makeBandCallback(4), { root: null, rootMargin: BAND2_MARGIN, threshold: 0 });
    ensureScrollTracking();
    return true;
  }

  function ensureElementRecord(el, initialBand) {
    if (!el) return null;
    var rec = trackedElements.get(el);
    if (!rec) {
      var rectBand = (!hasDeliveredIO && typeof initialBand !== 'number') ? computeInitialRectBand(el) : null;
      var seedBand = typeof initialBand === 'number'
        ? initialBand
        : (rectBand !== null ? rectBand : (typeof el.__atpViewportBand === 'number' ? el.__atpViewportBand : 3));
      rec = {
        mask: seedBand === 0 ? 7 : (seedBand === 1 ? 6 : (seedBand === 2 ? 4 : 0)),
        band: seedBand, ioSeen: false, threadStates: null, bandListeners: null, isLoadingAnim: false
      };
      el.__atpViewportBand = seedBand;
      trackedElements.set(el, rec);
      if (ensureBandObservers()) {
        band0Observer.observe(el); band1Observer.observe(el); band2Observer.observe(el);
      }
    }
    return rec;
  }

  function maybeReleaseElementRecord(el) {
    var rec = trackedElements.get(el);
    if (!rec) return;
    if ((rec.threadStates && rec.threadStates.size > 0) || (rec.bandListeners && rec.bandListeners.size > 0) ||
        pendingWrappers.has(el) || rec.isLoadingAnim) return;
    if (!rec.ioSeen) delete el.__atpViewportBand;
    trackedElements.delete(el);
    visiblePendingWrappers.delete(el);
    if (band0Observer) band0Observer.unobserve(el);
    if (band1Observer) band1Observer.unobserve(el);
    if (band2Observer) band2Observer.unobserve(el);
  }

  function sampleScrollVelocityFrame() {
    scrollRafId = null;
    var now = nowPerf();
    var y = typeof window !== 'undefined' && typeof window.scrollY === 'number'
      ? window.scrollY : (typeof window !== 'undefined' && typeof window.pageYOffset === 'number' ? window.pageYOffset : 0);
    if (lastScrollY !== null && lastScrollSampleAt > 0) {
      var dy = Math.abs(y - lastScrollY);
      var speed = dy / Math.max(1, now - lastScrollSampleAt);
      if (dy >= FAST_SCROLL_MIN_DELTA_PX && speed >= FAST_SCROLL_THRESHOLD_PX_MS) {
        slowScrollSampleCount = 0; scrollMode = 'fast';
      } else if (scrollMode === 'fast' && speed < SLOW_SCROLL_THRESHOLD_PX_MS && ++slowScrollSampleCount >= 2) {
        scrollMode = 'normal'; slowScrollSampleCount = 0;
      }
    }
    lastScrollY = y; lastScrollSampleAt = now;
  }

  function onScrollSettled() {
    scrollIdleTimer = null;
    if (scrollRafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
    var wasScrolling = scrollMode !== 'idle';
    scrollMode = 'idle'; slowScrollSampleCount = 0; lastScrollY = null; lastScrollSampleAt = 0;
    if (!wasScrolling || isLoaderPaused()) return;
    if (root.ATPHeavyBudget && ATPHeavyBudget.resumeHeavyRestores) ATPHeavyBudget.resumeHeavyRestores('scroll_idle');
    notifySchedule('viewport_band_change');
  }

  function handlePassiveScroll() {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (scrollMode === 'idle') scrollMode = 'normal';
    if (scrollRafId === null) {
      if (typeof requestAnimationFrame === 'function') scrollRafId = requestAnimationFrame(sampleScrollVelocityFrame);
      else sampleScrollVelocityFrame();
    }
    if (scrollIdleTimer !== null) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(onScrollSettled, SCROLL_IDLE_MS);
  }

  function ensureScrollTracking() {
    if (scrollListenerAttached || typeof document === 'undefined' || !document.addEventListener) return;
    scrollListenerAttached = true;
    document.addEventListener('scroll', handlePassiveScroll, { passive: true, capture: true });
  }

  function stopScrollTracking() {
    if (scrollListenerAttached && typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('scroll', handlePassiveScroll, { passive: true, capture: true });
      scrollListenerAttached = false;
    }
    if (scrollRafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
    if (scrollIdleTimer !== null) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = null;
    scrollMode = 'idle'; lastScrollY = null; lastScrollSampleAt = 0; slowScrollSampleCount = 0;
  }

  function pruneDetachedPending() {
    if (!pendingWrappers.size) return;
    var toRemove = null;
    pendingWrappers.forEach(function (data, wrapper) {
      var detached = typeof document !== 'undefined' && document.contains && !document.contains(wrapper);
      var stale = root.ATPLoader && ATPLoader.isTaskCurrent && data.task && !ATPLoader.isTaskCurrent(data.task);
      if (data.loaded || detached || stale) {
        if (!toRemove) toRemove = [];
        toRemove.push([wrapper, data, detached && !stale]);
      }
    });
    if (!toRemove) return;
    for (var i = 0; i < toRemove.length; i++) {
      pendingWrappers.delete(toRemove[i][0]);
      visiblePendingWrappers.delete(toRemove[i][0]);
      maybeReleaseElementRecord(toRemove[i][0]);
      if (toRemove[i][2] && toRemove[i][1] && toRemove[i][1].task && root.ATPLoader && ATPLoader.handleDetachedViewportTask) {
        ATPLoader.handleDetachedViewportTask(toRemove[i][1].task);
      }
    }
  }

  function clearPendingRetryTimers() {
    if (pendingRetryTimer !== null) { clearTimeout(pendingRetryTimer); pendingRetryTimer = null; }
  }

  var ATPViewport = {
    trackThreadPanel: function (panel, threadState) {
      if (!panel) return;
      var seed = threadState && threadState.readyImageVisible === true ? 0 : (threadState && typeof threadState.viewportBand === 'number' ? threadState.viewportBand : 3);
      var rec = ensureElementRecord(panel, seed);
      if (!rec) return;
      if (!rec.threadStates) rec.threadStates = new Set();
      if (threadState) { rec.threadStates.add(threadState); threadState.viewportBand = rec.band; }
    },
    untrackThreadPanel: function (panel, threadState) {
      var rec = panel && trackedElements.get(panel);
      if (!rec) return;
      if (rec.threadStates) { if (threadState) rec.threadStates.delete(threadState); else rec.threadStates.clear(); }
      maybeReleaseElementRecord(panel);
    },
    observeBand: function (el, listener, initialBand) {
      if (!el) return 3;
      var rec = ensureElementRecord(el, initialBand);
      if (rec && typeof listener === 'function') {
        if (!rec.bandListeners) rec.bandListeners = new Set();
        rec.bandListeners.add(listener);
      }
      return rec ? rec.band : 3;
    },
    unobserveBand: function (el, listener) {
      var rec = el && trackedElements.get(el);
      if (!rec) return;
      if (rec.bandListeners) { if (listener) rec.bandListeners.delete(listener); else rec.bandListeners.clear(); }
      maybeReleaseElementRecord(el);
    },
    getBand: function (el) {
      if (!el) return 3;
      var rec = trackedElements.get(el);
      if ((!rec || !rec.ioSeen) && !hasDeliveredIO) {
        var rBand = computeInitialRectBand(el);
        if (rBand !== null) {
          el.__atpViewportBand = rBand;
          if (rec) rec.band = rBand;
          return rBand;
        }
      }
      if (typeof el.__atpViewportBand === 'number') return el.__atpViewportBand;
      return rec ? rec.band : 3;
    },
    hasDeliveredIntersections: function () { return hasDeliveredIO; },
    getScrollMode: function () { return scrollMode; },
    isScrolling: function () { return scrollMode !== 'idle'; },
    isFastScrolling: function () { return scrollMode === 'fast'; },
    observeScrollRoot: function (scrollRoot, threadState) {
      if (!scrollRoot) return;
      ensureScrollTracking();
      if (!observedScrollRoots.has(scrollRoot)) {
        var onRootScroll = function () { handlePassiveScroll(); notifySchedule('scroll_root'); };
        observedScrollRoots.set(scrollRoot, { listener: onRootScroll, threadState: threadState || null });
        if (scrollRoot.addEventListener) scrollRoot.addEventListener('scroll', onRootScroll, { passive: true });
      }
      var panel = (threadState && threadState.panel) || (scrollRoot.closest && scrollRoot.closest('.atp-thread-panel'));
      if (panel) ATPViewport.trackThreadPanel(panel, threadState || null);
    },
    unobserveScrollRoot: function (scrollRoot) {
      var state = scrollRoot && observedScrollRoots.get(scrollRoot);
      if (!state) return;
      observedScrollRoots.delete(scrollRoot);
      if (scrollRoot.removeEventListener && state.listener) scrollRoot.removeEventListener('scroll', state.listener, { passive: true });
    },

    observe: function (wrapper, task, imgData, existingData) {
      if (!wrapper) return;
      var now = Date.now();
      if (task && !task.viewportObservedAt) task.viewportObservedAt = now;
      var ts = task && root.ATPState && root.ATPState.threads && root.ATPState.threads[task.threadId];
      var seedBand = task && task.currentlyVisible === true
        ? 0
        : ((!hasDeliveredIO && computeInitialRectBand(wrapper) !== null)
          ? computeInitialRectBand(wrapper)
          : (ts && typeof ts.viewportBand === 'number' ? ts.viewportBand : undefined));
      var rec = ensureElementRecord(wrapper, seedBand);
      var band = rec ? rec.band : seedBand;
      var isVis = (typeof document === 'undefined' || document.visibilityState === 'visible') && band === 0;
      var recordData = existingData && typeof existingData === 'object' ? existingData : {};
      recordData.task = task;
      recordData.imgData = imgData || recordData.imgData || (task && task.candidates && task.candidates[task.idx]) || null;
      recordData.loaded = false;
      recordData.inViewport = band <= 2;
      recordData.actualInViewport = isVis;
      if (!recordData.observedAt) recordData.observedAt = now;
      recordData.inViewportAt = band <= 2 ? (recordData.inViewportAt || now) : 0;
      recordData.actualInViewportAt = isVis ? (recordData.actualInViewportAt || now) : 0;
      recordData.forceLoadWhenHidden = !!recordData.forceLoadWhenHidden;
      pendingWrappers.set(wrapper, recordData);
      wrapper.__atpLoadTask = task;
      if (task) task.viewportBand = band;
      if (isVis) visiblePendingWrappers.add(wrapper);
      ATPViewport.observeLoadingAnimation(wrapper);
      if (band <= 2) notifySchedule('viewport_band_change');
    },

    unobserve: function (wrapper) {
      if (!wrapper) return;
      pendingWrappers.delete(wrapper);
      visiblePendingWrappers.delete(wrapper);
      ATPViewport.unobserveLoadingAnimation(wrapper);
      maybeReleaseElementRecord(wrapper);
    },

    observeLoadingAnimation: function (wrapper) {
      if (!wrapper) return;
      var task = wrapper.__atpLoadTask;
      var seed = typeof wrapper.__atpViewportBand === 'number'
        ? wrapper.__atpViewportBand
        : (task && task.currentlyVisible === true ? 0 : undefined);
      var rec = ensureElementRecord(wrapper, seed);
      if (!rec) return;
      rec.isLoadingAnim = true;
      loadingAnimationWrappers.add(wrapper);
      setLoadingAnimationClass(wrapper, (typeof document === 'undefined' || document.visibilityState === 'visible') && rec.band === 0);
    },

    unobserveLoadingAnimation: function (wrapper) {
      if (!wrapper) return;
      loadingAnimationWrappers.delete(wrapper);
      setLoadingAnimationClass(wrapper, false);
      var rec = trackedElements.get(wrapper);
      if (rec) {
        rec.isLoadingAnim = false;
        maybeReleaseElementRecord(wrapper);
      }
    },

    syncLoadingAnimationVisibility: function () {
      var docVisible = typeof document === 'undefined' || document.visibilityState === 'visible';
      loadingAnimationWrappers.forEach(function (wrapper) {
        setLoadingAnimationClass(wrapper, docVisible && ATPViewport.getBand(wrapper) === 0);
      });
    },

    loadWrapper: function (wrapper, wrapperData, forceLoad) {
      wrapperData = wrapperData || pendingWrappers.get(wrapper);
      if (!wrapper || !wrapperData || wrapperData.loaded) {
        pendingWrappers.delete(wrapper);
        visiblePendingWrappers.delete(wrapper);
        maybeReleaseElementRecord(wrapper);
        return false;
      }
      if (typeof document !== 'undefined' && document.contains && !document.contains(wrapper)) {
        ATPViewport.unobserve(wrapper);
        return false;
      }
      var task = wrapperData.task;
      if (root.ATPLoader && ATPLoader.isTaskCurrent && !ATPLoader.isTaskCurrent(task)) {
        ATPViewport.unobserve(wrapper);
        if (wrapper.parentNode) wrapper.remove();
        return false;
      }
      if (isLoaderPaused()) {
        wrapperData.slotRetryPending = true;
        return false;
      }
      if (root.ATPLoader && ATPLoader.isBackgroundImageLocked && ATPLoader.isBackgroundImageLocked(task)) return false;

      var band = ATPViewport.getBand(wrapper);
      if (!forceLoad && !wrapperData.inViewport && !wrapperData.actualInViewport && band > 2) return false;

      var loadVisible = (typeof document === 'undefined' || document.visibilityState === 'visible') &&
        (wrapperData.actualInViewport === true || band === 0);
      if (task) {
        task.viewportBand = loadVisible ? 0 : band;
        if (root.ATPLoader && ATPLoader.updateTaskViewportPriority) ATPLoader.updateTaskViewportPriority(task, wrapper, loadVisible);
        else { task.currentlyVisible = loadVisible; task.viewportPriority = loadVisible; }
      }
      if (!root.ATPLoader || !ATPLoader.startViewportWrapperLoad) return false;
      var started = ATPLoader.startViewportWrapperLoad(wrapper, wrapperData, forceLoad);
      if (started) {
        wrapperData.loaded = true;
        pendingWrappers.delete(wrapper);
        visiblePendingWrappers.delete(wrapper);
        maybeReleaseElementRecord(wrapper);
      }
      return started;
    },

    getEligiblePendingWrappers: function (maxBand) {
      pruneDetachedPending();
      var out = [];
      var cap = typeof maxBand === 'number' ? maxBand : 2;
      pendingWrappers.forEach(function (data, wrapper) {
        if (!data || data.loaded) return;
        var band = data.actualInViewport ? 0 : ATPViewport.getBand(wrapper);
        if (band <= cap || data.forceLoadWhenHidden) out.push({ wrapper: wrapper, data: data, band: band });
      });
      return out;
    },

    retryActualVisiblePending: function () { return ATPViewport.retryVisiblePending(true); },
    retryPendingSlotLoads: function () { return ATPViewport.retryVisiblePending(false); },
    retryVisiblePending: function (actualOnly) {
      if (isLoaderPaused()) return 0;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible' && getSettings().pauseWhenHidden !== false) return 0;
      var list = ATPViewport.getEligiblePendingWrappers(actualOnly ? 0 : 2);
      var started = 0;
      for (var i = 0; i < list.length; i++) {
        if (ATPViewport.loadWrapper(list[i].wrapper, list[i].data, false)) started++;
      }
      return started;
    },

    loadPendingWhenHidden: function (maxLoads) {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') return 0;
      pruneDetachedPending();
      var limit = Math.max(0, Number(maxLoads) || 0);
      var started = 0;
      var entries = Array.from(pendingWrappers.entries());
      for (var i = 0; i < entries.length; i++) {
        if (limit > 0 && started >= limit) break;
        var data = entries[i][1];
        if (!data || data.loaded) continue;
        data.forceLoadWhenHidden = true;
        if (ATPViewport.loadWrapper(entries[i][0], data, true)) started++;
      }
      return started;
    },

    clearHiddenLoadFlags: function () { pendingWrappers.forEach(function (d) { if (d) d.forceLoadWhenHidden = false; }); },
    clearPendingRetryTimers: clearPendingRetryTimers,
    updateScrollPreload: function () { handlePassiveScroll(); return scrollMode; },
    resetScrollPreload: function () { scrollMode = 'idle'; lastScrollY = null; lastScrollSampleAt = 0; slowScrollSampleCount = 0; return scrollMode; },

    discardThreadImages: function (threadIds) {
      if (!threadIds) return;
      function matches(task) { return !!(task && threadIds.has(task.threadId)); }
      pendingWrappers.forEach(function (data, wrapper) { if (matches(data && data.task)) ATPViewport.unobserve(wrapper); });
      loadingAnimationWrappers.forEach(function (wrapper) { if (matches(wrapper.__atpLoadTask)) ATPViewport.unobserveLoadingAnimation(wrapper); });
      trackedElements.forEach(function (rec, el) {
        if (!rec.threadStates) return;
        rec.threadStates.forEach(function (ts) { if (ts && threadIds.has(ts.id)) rec.threadStates.delete(ts); });
        if (!rec.threadStates.size) maybeReleaseElementRecord(el);
      });
      if (root.ATPHeavyBudget && ATPHeavyBudget.discardThreadImages) ATPHeavyBudget.discardThreadImages(threadIds);
    },

    reconfigure: function (reason) {
      if (!isLoaderPaused()) notifySchedule(reason || 'viewport_reconfigure');
      if (root.ATPHeavyBudget && ATPHeavyBudget.reconfigure) return ATPHeavyBudget.reconfigure(reason);
      var s = getSettings();
      return {
        heavyDecodedImageLimit: ATPLoadPolicy.getHeavyDecodedImageLimit(s),
        heavyDecodedBudgetMP: ATPLoadPolicy.getHeavyDecodedBudgetMP(s),
        heavyVisibleBudgetMP: ATPLoadPolicy.getHeavyVisibleBudgetMP(s),
        heavyLightweightPreviewEdge: ATPLoadPolicy.getHeavyLightweightPreviewEdge(s)
      };
    },

    destroy: function () {
      if (band0Observer) { band0Observer.disconnect(); band0Observer = null; }
      if (band1Observer) { band1Observer.disconnect(); band1Observer = null; }
      if (band2Observer) { band2Observer.disconnect(); band2Observer = null; }
      hasDeliveredIO = false;
      loadingAnimationWrappers.forEach(function (w) { setLoadingAnimationClass(w, false); });
      loadingAnimationWrappers.clear();
      observedScrollRoots.forEach(function (state, sr) {
        if (sr && sr.removeEventListener && state.listener) sr.removeEventListener('scroll', state.listener, { passive: true });
      });
      observedScrollRoots.clear();
      stopScrollTracking();
      clearPendingRetryTimers();
      visiblePendingWrappers.clear();
      pendingWrappers.clear();
      trackedElements.clear();
      if (root.ATPHeavyBudget && ATPHeavyBudget.destroy) ATPHeavyBudget.destroy();
    },

    getPendingCount: function () { pruneDetachedPending(); return pendingWrappers.size; },
    getPendingStats: function () {
      pruneDetachedPending();
      var now = Date.now();
      var stats = {
        pendingCount: pendingWrappers.size,
        actualVisiblePendingCount: visiblePendingWrappers.size,
        oldestVisiblePendingAgeMs: 0,
        maxPendingAgeMs: 0,
        stalePendingCount: 0,
        lazyViewportMode: scrollMode,
        adaptiveScrollRootCount: observedScrollRoots.size,
        pendingAgeByQueueKind: {}
      };
      pendingWrappers.forEach(function (data) {
        if (!data) return;
        if (data.actualInViewportAt) stats.oldestVisiblePendingAgeMs = Math.max(stats.oldestVisiblePendingAgeMs, Math.max(0, now - data.actualInViewportAt));
        var age = data.observedAt ? Math.max(0, now - data.observedAt) : 0;
        var kind = (data.task && data.task.queueKind) || 'unknown';
        var entry = stats.pendingAgeByQueueKind[kind] || { count: 0, maxAgeMs: 0 };
        entry.count++;
        entry.maxAgeMs = Math.max(entry.maxAgeMs, age);
        stats.pendingAgeByQueueKind[kind] = entry;
        stats.maxPendingAgeMs = Math.max(stats.maxPendingAgeMs, age);
        if (age >= 60000) stats.stalePendingCount++;
      });
      return stats;
    },

    monitorLoadedHeavyImage: function (w, img, t) { return root.ATPHeavyBudget ? ATPHeavyBudget.monitorLoadedHeavyImage(w, img, t) : undefined; },
    reconcileHeavyRenderBudget: function (r) { return root.ATPHeavyBudget ? ATPHeavyBudget.reconcileHeavyRenderBudget(r) : undefined; },
    pauseHeavyRestores: function () { return root.ATPHeavyBudget ? ATPHeavyBudget.pauseHeavyRestores() : undefined; },
    cancelHeavyRestores: function (r) { return root.ATPHeavyBudget ? ATPHeavyBudget.cancelHeavyRestores(r) : undefined; },
    resumeHeavyRestores: function (r) { return root.ATPHeavyBudget ? ATPHeavyBudget.resumeHeavyRestores(r) : undefined; },
    getHeavyUnloadedCount: function () { return root.ATPHeavyBudget ? ATPHeavyBudget.getHeavyUnloadedCount() : 0; },
    getHeavyRestoreQueueCount: function () { return root.ATPHeavyBudget ? ATPHeavyBudget.getHeavyRestoreQueueCount() : 0; },
    getHeavyRenderStats: function () { return root.ATPHeavyBudget ? ATPHeavyBudget.getHeavyRenderStats() : {}; }
  };

  root.ATPViewport = ATPViewport;
  globalThis.ATPViewport = ATPViewport;
})();
