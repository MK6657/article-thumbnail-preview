(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;

  var activeRunners = new Set();
  var externalActiveControls = [];
  var DEADLINE_EPSILON_MS = 25;

  function getSettings(override) {
    if (override) return override;
    return (root.ATPState && root.ATPState.settings) || {};
  }

  function getCandidateDisplaySrc(imgData) {
    if (!imgData) return '';
    if (typeof SharedUtils !== 'undefined' && SharedUtils && SharedUtils.getImageDisplaySrc) {
      return SharedUtils.getImageDisplaySrc(imgData) || '';
    }
    return imgData.displaySrc || imgData.src || '';
  }

  function getTaskImageData(task) {
    return task && task.candidates ? task.candidates[task.idx] : null;
  }

  function getTaskSrc(task, srcOverride) {
    if (typeof srcOverride === 'string' && srcOverride) return srcOverride;
    if (task && typeof task.srcOverride === 'string' && task.srcOverride) return task.srcOverride;
    return getCandidateDisplaySrc(getTaskImageData(task));
  }

  function cancelImageElement(img) {
    if (!img) return;
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    img.removeAttribute('srcset');
  }

  function isTaskDeadlineSpent(task) {
    return !!(task && task.taskDeadlineAt && Date.now() + DEADLINE_EPSILON_MS >= task.taskDeadlineAt);
  }

  // Synchronously sets decoding = 'async' and referrerPolicy = 'no-referrer' BEFORE img.src = url!
  // Only resets src first when reusing an existing <img> that already had a src attribute.
  function applyImageSource(img, src, useNoReferrer, shouldApply, task, onRequestStart, onRequestEnd, registerSrcTimer) {
    if (!img || !src) return false;

    var defaultNoRef = !!(root.ATPHostHealth && ATPHostHealth.shouldUseNoReferrerByDefault &&
      ATPHostHealth.shouldUseNoReferrerByDefault(src));
    var noRef = !!useNoReferrer || defaultNoRef;
    if (!noRef && typeof shouldApply === 'function' && !shouldApply()) return false;
    var hadExistingSrc = !!(img.getAttribute && img.getAttribute('src')) || !!img.src;

    if (hadExistingSrc) {
      if (typeof onRequestEnd === 'function') onRequestEnd(task);
      img.removeAttribute('src');
    }

    img.decoding = 'async';
    if (noRef) {
      img.removeAttribute('src');
      img.referrerPolicy = 'no-referrer';
      var timerId = setTimeout(function () {
        if (typeof registerSrcTimer === 'function') registerSrcTimer(null);
        if (typeof shouldApply === 'function' && !shouldApply()) return;
        if (typeof onRequestStart === 'function') onRequestStart(task);
        img.src = src;
      }, 0);
      if (typeof registerSrcTimer === 'function') registerSrcTimer(timerId);
      return true;
    }

    img.removeAttribute('referrerpolicy');
    if (typeof onRequestStart === 'function') onRequestStart(task);
    img.src = src;
    return true;
  }

  function markTaskSourceAttempt(task, src, noReferrer, now) {
    if (!task) return;
    now = now || Date.now();
    var key = root.ATPHostHealth && ATPHostHealth.getImageUrlKey
      ? ATPHostHealth.getImageUrlKey(src)
      : String(src || '');
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
    if (root.ATPHostHealth && ATPHostHealth.stampTaskHostHealthEpoch) {
      ATPHostHealth.stampTaskHostHealthEpoch(task, src);
    }
  }

  function prepareImageElement(img, task, settings) {
    var w = (settings && settings.thumbWidth) || 110;
    var h = (settings && settings.thumbHeight) || 82;
    img.__atpTimingTask = task;
    img.className = 'atp-thumbnail-img';
    if (img.classList && img.classList.add) img.classList.add('atp-thumbnail-img');
    img.decoding = 'async';
    var highPriority = !!(task && (task.manualRetry || task.currentlyVisible === true ||
      (task.currentlyVisible === undefined && task.viewportPriority === true) ||
      (task.forceEager && !task.forceEagerLowPriority)));
    img.loading = (highPriority || !!(task && (task.slotActive || task.forceEager || task.forcePreload)))
      ? 'eager'
      : 'lazy';
    img.fetchPriority = highPriority ? 'high' : 'low';
    img.alt = '';
    img.style.width = w + 'px';
    img.style.height = h + 'px';
  }

  function computeAttemptTimeoutMs(task, settings, timeoutOverride) {
    var overrideNum = Number(timeoutOverride);
    var timeout = !isNaN(overrideNum) && overrideNum > 0
      ? overrideNum
      : (root.ATPHostHealth && ATPHostHealth.getTaskAttemptTimeout
        ? ATPHostHealth.getTaskAttemptTimeout(task, settings)
        : ((settings && settings.imageTimeout) || 15000));
    if (task && task.taskDeadlineAt > 0) {
      var remaining = task.taskDeadlineAt - Date.now();
      if (remaining <= DEADLINE_EPSILON_MS) return 0;
      timeout = Math.min(timeout, remaining);
    }
    return Math.max(1, Math.floor(timeout));
  }

  // Unified <img> lifecycle runner collapsing loadImageDirect, retryLoadImage,
  // ATPViewport.loadWrapper, and heavy restore network load.
  function run(task, options) {
    options = options || {};
    var settings = getSettings(options.settings);
    var wrapper = options.wrapper || null;
    var loadingEl = options.loadingEl || null;
    var isRestore = !!options.isRestore;
    var skipFallbacks = !!options.skipFallbacks;
    var tier = typeof options.tier === 'number' ? options.tier : (task && typeof task.tier === 'number' ? task.tier : 1);
    var slotToken = options.slotToken !== undefined
      ? options.slotToken
      : (task ? task.activeSlotToken : null);
    var startedAt = Date.now();

    if (task && !isRestore && !task.taskDeadlineAt && root.ATPHostHealth && ATPHostHealth.computeTaskDeadlineMs) {
      var deadlineMs = ATPHostHealth.computeTaskDeadlineMs(task, settings);
      task.taskDeadlineAt = deadlineMs > 0 ? startedAt + deadlineMs : 0;
      task.taskDeadlineMs = deadlineMs;
    }
    var initialBudgetMs = (task && task.taskDeadlineAt > 0)
      ? Math.max(1, task.taskDeadlineAt - startedAt)
      : computeAttemptTimeoutMs(task, settings);

    var img = options.existingImg || null;
    if (!img) {
      img = document.createElement('img');
      prepareImageElement(img, task, settings);
      if (wrapper) wrapper.appendChild(img);
    } else if (!isRestore) {
      prepareImageElement(img, task, settings);
    }

    var settled = false;
    var timer = null;
    var srcTimer = null;
    var timeoutAt = 0;
    var pausedRemainingMs = 0;
    var currentSrc = getTaskSrc(task, options.srcOverride);

    function registerSrcTimer(id) {
      if (srcTimer !== null && id !== srcTimer) {
        clearTimeout(srcTimer);
      }
      srcTimer = id;
    }

    function isRunnerSlotValid() {
      if (settled) return false;
      if (isRestore) {
        return typeof options.isCurrent === 'function' ? options.isCurrent() : true;
      }
      if (typeof options.isCurrent === 'function' && !options.isCurrent()) return false;
      if (slotToken !== null && slotToken !== undefined && root.ATPHostHealth && ATPHostHealth.isSlotCurrent) {
        return ATPHostHealth.isSlotCurrent(task, slotToken);
      }
      return true;
    }

    function clearTimer() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (srcTimer !== null) {
        clearTimeout(srcTimer);
        srcTimer = null;
      }
      timeoutAt = 0;
    }

    function releaseRunnerSlot() {
      if (isRestore) return;
      if (slotToken !== null && slotToken !== undefined && root.ATPHostHealth && ATPHostHealth.releaseSlot) {
        ATPHostHealth.releaseSlot(task, slotToken);
      }
    }

    function cleanupRunner() {
      clearTimer();
      activeRunners.delete(runner);
      if (task && task.__activeRunner === runner) task.__activeRunner = null;
    }

    function abandonStale() {
      if (settled) return true;
      settled = true;
      cleanupRunner();
      img.onclick = null;
      cancelImageElement(img);
      if (typeof options.onRequestEnd === 'function') options.onRequestEnd(task);
      return true;
    }

    function tryInflightTimeoutGrace() {
      if (img && img.complete && img.naturalWidth && typeof img.onload === 'function') {
        img.onload();
        return true;
      }
      if (!task || task.readyImageQueue || task.manualRetry || isRestore || !task.taskDeadlineAt || task.timeoutGraceTried ||
          img.referrerPolicy === 'no-referrer') {
        return false;
      }
      if (typeof options.isTaskCurrent === 'function' && !options.isTaskCurrent(task)) return false;
      var remaining = task.taskDeadlineAt - Date.now();
      if (remaining < 500) return false;
      task.timeoutGraceTried = true;
      var age = task.currentSrcStartedAt ? Math.max(0, Date.now() - task.currentSrcStartedAt) : 0;
      if (root.ATPHostHealth && ATPHostHealth.noteLargeLaneOutcome) {
        ATPHostHealth.noteLargeLaneOutcome(task, currentSrc, age, true);
      }
      if (typeof options.onEvent === 'function') {
        options.onEvent('image_wait', task, { reason: 'inflight_timeout_grace' });
      }
      armAttemptTimer(remaining);
      return true;
    }

    function tryNoReferrerRetry(fromTimeout) {
      if (skipFallbacks || isRestore || !task || (!task.readyImageQueue && task.siblingHostTried)) return false;
      if (typeof options.isTaskCurrent === 'function' && !options.isTaskCurrent(task)) return false;
      if (fromTimeout && (task.readyImageQueue || (root.ATPHostHealth && ATPHostHealth.isLargeLaneTask && ATPHostHealth.isLargeLaneTask(task)))) {
        return false;
      }
      if (isTaskDeadlineSpent(task)) return false;
      if (task.currentSrcNoReferrerTried || img.referrerPolicy === 'no-referrer') {
        task.currentSrcNoReferrerTried = true;
        return false;
      }
      var retryTimeout = computeAttemptTimeoutMs(task, getSettings());
      if (retryTimeout <= 0) return false;

      markTaskSourceAttempt(task, currentSrc, true, Date.now());
      armAttemptTimer(retryTimeout);
      if (typeof options.onEvent === 'function') {
        options.onEvent('image_retry', task, { reason: 'no_referrer' });
      }
      applyImageSource(img, currentSrc, true, isRunnerSlotValid, task, options.onRequestStart, options.onRequestEnd, registerSrcTimer);
      return true;
    }

    function trySiblingFailover(reason) {
      if (skipFallbacks || isRestore || !task || task.siblingHostTried) return false;
      if (!root.ATPHostHealth) return false;
      if (typeof options.isTaskCurrent === 'function' && !options.isTaskCurrent(task)) return false;
      if (isTaskDeadlineSpent(task)) return false;

      var candidate = task.attachmentOriginalCandidate || getTaskImageData(task);
      var family = ATPHostHealth.getCandidateAttachmentFamily(candidate);
      if (!family) return false;

      ATPHostHealth.recordTaskImageFailure(task, currentSrc, reason || 'candidate_error', true, options.ordinaryConc);

      var now = Date.now();
      var remMs = (startedAt + initialBudgetMs) - now;
      if (remMs < 300) return false;
      var sibling = ATPHostHealth.pickSiblingAttachmentHost(family);
      if (!sibling) return false;

      if (typeof options.onSiblingFailover === 'function') {
        ATPHostHealth.moveTaskToSiblingHost(task, family, sibling, options.onBeforeAttachmentSwap);
        if (typeof options.onEvent === 'function') {
          options.onEvent('image_retry', task, { reason: 'sibling_host_queue', siblingHost: sibling });
        }
        settled = true;
        cleanupRunner();
        img.onclick = null;
        cancelImageElement(img);
        if (img.parentNode) img.parentNode.removeChild(img);
        if (typeof options.onRequestEnd === 'function') options.onRequestEnd(task);
        task.siblingTimeoutRemainingMs = Math.max(1, Math.floor(remMs));
        task.taskDeadlineAt = 0;
        releaseRunnerSlot();
        options.onSiblingFailover(task.siblingTimeoutRemainingMs);
        return true;
      }

      ATPHostHealth.moveTaskToSiblingHost(task, family, sibling, options.onBeforeAttachmentSwap);
      task.siblingHostTried = true;
      currentSrc = getTaskSrc(task);
      if (!currentSrc) return false;

      ATPHostHealth.updateSlotTask(task, currentSrc, getSettings());
      var nextNoRef = ATPHostHealth.shouldUseNoReferrerByDefault(currentSrc);
      markTaskSourceAttempt(task, currentSrc, nextNoRef, now);
      var nextTimeout = computeAttemptTimeoutMs(task, getSettings(), remMs);
      if (nextTimeout <= 0) return false;
      armAttemptTimer(nextTimeout);
      applyImageSource(img, currentSrc, nextNoRef, isRunnerSlotValid, task, options.onRequestStart, options.onRequestEnd, registerSrcTimer);
      return true;
    }

    function tryCandidateFallbackStep(reason) {
      if (skipFallbacks || isRestore || !task || typeof options.tryCandidateFallback !== 'function') return false;
      if (typeof options.isTaskCurrent === 'function' && !options.isTaskCurrent(task)) return false;
      if (isTaskDeadlineSpent(task)) return false;

      var now = Date.now();
      var remMs = (startedAt + initialBudgetMs) - now;
      if (remMs <= DEADLINE_EPSILON_MS) return false;

      if (root.ATPHostHealth) {
        ATPHostHealth.recordTaskImageFailure(task, currentSrc, reason || 'candidate_error', true, options.ordinaryConc);
      }
      var nextSrc = options.tryCandidateFallback(task, reason || 'candidate_error');
      if (!nextSrc) return false;

      if (typeof options.onCandidateRequeue === 'function' &&
          (!options.shouldRequeueCandidateFallback || options.shouldRequeueCandidateFallback(task, nextSrc))) {
        if (typeof options.onEvent === 'function') {
          options.onEvent('fallback_pick', task, { reason: reason || 'candidate_error' });
        }
        settled = true;
        cleanupRunner();
        img.onclick = null;
        cancelImageElement(img);
        if (img.parentNode) img.parentNode.removeChild(img);
        if (typeof options.onRequestEnd === 'function') options.onRequestEnd(task);
        task.replacementDeadlineAt = now + Math.max(1, Math.floor(remMs));
        task.taskDeadlineAt = 0;
        releaseRunnerSlot();
        options.onCandidateRequeue(nextSrc, remMs);
        return true;
      }

      currentSrc = nextSrc;
      if (root.ATPHostHealth) {
        ATPHostHealth.updateSlotTask(task, currentSrc, getSettings());
      }
      var useNoRef = !!(root.ATPHostHealth && ATPHostHealth.shouldUseNoReferrerByDefault(currentSrc));
      markTaskSourceAttempt(task, currentSrc, useNoRef, now);
      var nextTimeout = computeAttemptTimeoutMs(task, getSettings(), remMs);
      if (nextTimeout <= 0) return false;
      armAttemptTimer(nextTimeout);
      applyImageSource(img, currentSrc, useNoRef, isRunnerSlotValid, task, options.onRequestStart, options.onRequestEnd, registerSrcTimer);
      return true;
    }

    function failFinal(reason) {
      if (settled) return;
      if (!isRunnerSlotValid()) {
        abandonStale();
        return;
      }
      settled = true;
      cleanupRunner();
      var failReason = reason || 'image_fail';
      if (!isRestore && root.ATPHostHealth) {
        ATPHostHealth.recordTaskImageFailure(task, currentSrc, failReason, true, options.ordinaryConc);
      }
      cancelImageElement(img);
      if (typeof options.onRequestEnd === 'function') options.onRequestEnd(task);
      releaseRunnerSlot();
      if (typeof options.onFailure === 'function') {
        options.onFailure(failReason, currentSrc, img, runner);
      }
    }

    function armAttemptTimer(timeoutOverride) {
      if (settled) return;
      if (!isRunnerSlotValid()) {
        abandonStale();
        return;
      }
      clearTimer();
      var attemptMs = computeAttemptTimeoutMs(task, getSettings(), timeoutOverride);
      if (attemptMs <= 0) {
        failFinal('deadline_exhausted');
        return;
      }
      timeoutAt = Date.now() + attemptMs;
      var timerId = setTimeout(function () {
        clearTimeout(timerId);
        if (timer === timerId) timer = null;
        if (settled) return;
        if (!isRunnerSlotValid()) {
          abandonStale();
          return;
        }
        if (tryInflightTimeoutGrace()) return;
        if (!isRestore && root.ATPHostHealth) {
          ATPHostHealth.recordTaskImageFailure(task, currentSrc, 'candidate_timeout', false, options.ordinaryConc);
        }
        if (isTaskDeadlineSpent(task)) {
          failFinal('deadline_exhausted');
          return;
        }
        if (tryNoReferrerRetry(true)) return;
        if (trySiblingFailover('candidate_timeout')) return;
        if (tryCandidateFallbackStep('candidate_timeout')) return;
        failFinal(task && task.taskDeadlineAt ? 'deadline_exhausted' : 'candidate_timeout');
      }, attemptMs);
      timer = timerId;
    }

    img.onload = function () {
      if (settled) return;
      if (!isRunnerSlotValid()) {
        abandonStale();
        return;
      }
      settled = true;
      cleanupRunner();
      img.onload = null;
      img.onerror = null;
      if (typeof options.onRequestEnd === 'function') options.onRequestEnd(task);
      releaseRunnerSlot();
      if (typeof options.onSuccess === 'function') {
        options.onSuccess(img, currentSrc, runner);
      }
    };

    img.onerror = function () {
      if (settled) return;
      if (!isRunnerSlotValid()) {
        abandonStale();
        return;
      }
      if (tryNoReferrerRetry(false)) return;
      if (trySiblingFailover('candidate_error')) return;
      if (tryCandidateFallbackStep('candidate_error')) return;
      failFinal('candidate_error');
    };

    var runner = {
      task: task,
      img: img,
      wrapper: wrapper,
      loadingEl: loadingEl,
      tier: tier,
      slotToken: slotToken,
      startedAt: startedAt,
      isRestore: isRestore,

      getSrc: function () {
        return currentSrc;
      },

      getHost: function () {
        return root.ATPHostHealth && ATPHostHealth.getUrlHost
          ? ATPHostHealth.getUrlHost(currentSrc)
          : '';
      },

      isLarge: function () {
        return !!(root.ATPHostHealth && ATPHostHealth.isLargeLaneTask && ATPHostHealth.isLargeLaneTask(task));
      },

      isHeavy: function () {
        return !!(root.ATPHostHealth && ATPHostHealth.isHeavyChannelTask &&
          ATPHostHealth.isHeavyChannelTask(task, getSettings()));
      },

      isNearlyComplete: function (now) {
        if (settled || isRestore) return true;
        if (img && (img.complete || img.naturalWidth > 0)) return true;
        now = now || Date.now();
        if (task && task.taskDeadlineAt > 0 && task.taskDeadlineAt - now <= 500) return true;
        return false;
      },

      // Clean preemption: aborts in-flight <img>, releases slot immediately,
      // and returns task to its lane queue without incrementing failure counts or advancing candidate index!
      preempt: function (reason) {
        if (settled) return false;
        if (img && img.complete && img.naturalWidth > 0) return false;
        if (!isRunnerSlotValid()) {
          abandonStale();
          return false;
        }
        var now = Date.now();
        var remainingAttemptMs = timeoutAt > 0
          ? Math.max(1, timeoutAt - now)
          : (pausedRemainingMs > 0 ? pausedRemainingMs : 0);
        var remainingDeadlineMs = task && task.taskDeadlineAt > 0
          ? Math.max(1, task.taskDeadlineAt - now)
          : remainingAttemptMs;

        settled = true;
        cleanupRunner();
        img.onclick = null;
        cancelImageElement(img);
        if (!options.keepImgOnPreempt && img.parentNode) {
          img.parentNode.removeChild(img);
        }
        if (typeof options.onRequestEnd === 'function') options.onRequestEnd(task);

        if (task && !isRestore) {
          task.imageResumeRemainingMs = remainingDeadlineMs;
          task.pausedImageAttempt = {
            srcKey: task.currentSrcKey,
            timeoutMs: remainingAttemptMs,
            noReferrer: !!task.currentSrcNoReferrerTried,
            graceTried: !!task.timeoutGraceTried
          };
          task.taskDeadlineAt = 0;
        }

        releaseRunnerSlot();
        if (typeof options.onPreempt === 'function') {
          options.onPreempt(reason || 'visible_priority', remainingDeadlineMs, runner);
        }
        return true;
      },

      cancel: function (reason) {
        if (settled) return false;
        if (reason === 'hidden_pause' && !isRestore) {
          return runner.preempt('hidden_pause');
        }
        settled = true;
        cleanupRunner();
        img.onclick = null;
        cancelImageElement(img);
        if (!options.keepImgOnPreempt && reason === 'visible_priority' && img.parentNode) {
          img.parentNode.removeChild(img);
        }
        if (typeof options.onRequestEnd === 'function') options.onRequestEnd(task);
        releaseRunnerSlot();
        return true;
      },

      pauseTimer: function () {
        if (settled || timer === null) return;
        pausedRemainingMs = Math.max(250, timeoutAt - Date.now());
        clearTimer();
      },

      resumeTimer: function () {
        if (settled || timer !== null) return;
        var ms = pausedRemainingMs > 0 ? pausedRemainingMs : undefined;
        pausedRemainingMs = 0;
        armAttemptTimer(ms);
      },

      recover: function (reason) {
        if (settled) return;
        if (!isRunnerSlotValid()) {
          abandonStale();
          return;
        }
        if (img.complete && img.naturalWidth > 0 && typeof img.onload === 'function') {
          img.onload();
          return;
        }
        var connected = !wrapper || typeof document === 'undefined' || !document.contains || document.contains(wrapper);
        if ((img.currentSrc || img.src) && connected) {
          var nextMs = pausedRemainingMs > 0 ? pausedRemainingMs : undefined;
          pausedRemainingMs = 0;
          armAttemptTimer(nextMs);
          return;
        }
        if (tryNoReferrerRetry(false)) return;
        if (trySiblingFailover(reason || 'bfcache_recover')) return;
        if (tryCandidateFallbackStep(reason || 'bfcache_recover')) return;
        failFinal(reason || 'bfcache_recover');
      }
    };

    activeRunners.add(runner);
    if (task && !isRestore) task.__activeRunner = runner;

    // Start initial attempt synchronously (no setTimeout(..., 0) hop!)
    var paused = task && !isRestore ? task.pausedImageAttempt : null;
    if (paused) {
      task.pausedImageAttempt = null;
      var expectedKey = root.ATPHostHealth && ATPHostHealth.getImageUrlKey
        ? ATPHostHealth.getImageUrlKey(currentSrc)
        : currentSrc;
      if (paused.srcKey !== expectedKey) paused = null;
    }
    var initialNoRef = !!options.forceNoReferrer ||
      !!(paused && paused.noReferrer) ||
      !!(root.ATPHostHealth && ATPHostHealth.shouldUseNoReferrerByDefault(currentSrc));

    if (!isRestore && task) {
      markTaskSourceAttempt(task, currentSrc, initialNoRef, startedAt);
      if (paused) task.timeoutGraceTried = !!paused.graceTried;
    }

    if (isTaskDeadlineSpent(task) && !isRestore) {
      failFinal('deadline_exhausted');
      return runner;
    }

    var deferPreemptBrowserTick = !!(options.preemptedSlot && typeof HTMLImageElement === 'function' && img instanceof HTMLImageElement);
    armAttemptTimer(paused && paused.timeoutMs > 0 ? paused.timeoutMs : undefined);
    if (!settled) {
      if (deferPreemptBrowserTick) {
        registerSrcTimer(setTimeout(function () {
          registerSrcTimer(null);
          if (!isRunnerSlotValid()) return;
          applyImageSource(img, currentSrc, initialNoRef, isRunnerSlotValid, task, options.onRequestStart, options.onRequestEnd, registerSrcTimer);
        }, 20));
      } else {
        applyImageSource(img, currentSrc, initialNoRef, isRunnerSlotValid, task, options.onRequestStart, options.onRequestEnd, registerSrcTimer);
      }
    }
    return runner;
  }

  function registerExternalLoad(control) {
    if (!control || typeof control.cancel !== 'function') return function () {};
    control.active = true;
    externalActiveControls.push(control);
    return function () {
      control.active = false;
      var idx = externalActiveControls.indexOf(control);
      if (idx !== -1) externalActiveControls.splice(idx, 1);
    };
  }

  var ATPImageRunner = {
    run: run,
    applyImageSource: applyImageSource,
    prepareImageElement: prepareImageElement,
    cancelImageElement: cancelImageElement,
    isTaskDeadlineSpent: isTaskDeadlineSpent,

    getActiveRunners: function () {
      return activeRunners;
    },

    getActiveCount: function () {
      return activeRunners.size + externalActiveControls.length;
    },

    cancelAll: function (reason) {
      var list = Array.from(activeRunners);
      for (var i = 0; i < list.length; i++) {
        try {
          list[i].cancel(reason || 'reset');
        } catch (e) { /* ignore */ }
      }
      var ext = externalActiveControls.splice(0, externalActiveControls.length);
      for (var j = 0; j < ext.length; j++) {
        if (ext[j] && ext[j].active) {
          ext[j].active = false;
          try { ext[j].cancel(reason || 'reset'); } catch (e2) { /* ignore */ }
        }
      }
    },

    cancelWhere: function (predicate, reason) {
      var list = Array.from(activeRunners);
      for (var i = 0; i < list.length; i++) {
        if (predicate(list[i].task, list[i])) {
          try { list[i].cancel(reason || 'thread_removed'); } catch (e) { /* ignore */ }
        }
      }
      for (var j = externalActiveControls.length - 1; j >= 0; j--) {
        var ctrl = externalActiveControls[j];
        if (ctrl && ctrl.active && predicate(ctrl.task, ctrl)) {
          ctrl.active = false;
          externalActiveControls.splice(j, 1);
          try { ctrl.cancel(reason || 'thread_removed'); } catch (e2) { /* ignore */ }
        }
      }
    },

    suspendForBfcache: function () {
      activeRunners.forEach(function (runner) {
        runner.pauseTimer();
      });
    },

    recoverFromBfcache: function (reason) {
      var list = Array.from(activeRunners);
      for (var i = 0; i < list.length; i++) {
        try { list[i].recover(reason || 'bfcache_pageshow'); } catch (e) { /* ignore */ }
      }
      var ext = externalActiveControls.slice();
      for (var j = 0; j < ext.length; j++) {
        if (!ext[j] || !ext[j].active) continue;
        try {
          if (typeof ext[j].recover === 'function') {
            ext[j].recover(reason || 'bfcache_pageshow');
          } else {
            ext[j].active = false;
            var eIdx = externalActiveControls.indexOf(ext[j]);
            if (eIdx !== -1) externalActiveControls.splice(eIdx, 1);
            ext[j].cancel(reason || 'bfcache_pageshow');
          }
        } catch (e2) { /* ignore */ }
      }
    },

    registerExternalLoad: registerExternalLoad
  };

  root.ATPImageRunner = ATPImageRunner;
  globalThis.ATPImageRunner = ATPImageRunner;
})();
