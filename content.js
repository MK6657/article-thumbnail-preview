(function () {
  'use strict';

  Logger.init('CONTENT');

  var observer = null;
  var containerParentObserver = null;
  var dormantObserver = null;
  var boundContainer = null;
  var boundContainerParent = null;
  var initialized = false;
  var initInFlight = false;
  var settingsListenerInstalled = false;
  var startupCancelled = false;
  var forumEntryOnly = false;
  var processing = false;
  var scanPending = false;
  var rescanRequested = false;
  var observerRetryTimer = null;
  var observerRetryCount = 0;
  var OBSERVER_MAX_RETRIES = 4;
  var dormantRestartCount = 0;
  var DORMANT_MAX_RESTARTS = 2;
  var lastScanTime = 0;
  var scrollBound = false;
  var SCAN_THROTTLE_MS = 1200;
  var MUTATION_ARTICLE_ADD_SELECTOR = 'tbody[id^="normalthread"],tbody[id^="stickthread"],tbody[id^="thread"],tr[id^="thread"],a.xst[href],th a[href*="thread"],a[href*="thread-"]';
  // 休眠观察器挂在 body 上，判据必须比 MUTATION_ARTICLE_ADD_SELECTOR 严格：
  // 只有 Discuz 列表模板会产出这些 id 前缀的行，首页/帖内页遍地的 a[href*="thread-"] 不算
  var DORMANT_THREAD_ROW_SELECTOR = 'tbody[id^="normalthread"],tbody[id^="stickthread"],tbody[id^="thread"],tr[id^="thread"],.threadlist tbody[id],table[id*="threadlist"] tbody';
  var scrollScanTimer = null;
  var scanDelayTimer = null;
  var throttleScanTimer = null;
  var retryScanTimer = null;
  var followupScanTimer = null;
  var retryScanDueAt = 0;
  var emptyRetryAfterByUrl = {};
  var emptyRetryAttemptsByUrl = {};
  // Threads that used up their automatic retries: left alone until the page
  // (or the thumbnail list) is reloaded.
  var emptyRetryGivenUp = {};
  // Attempts per cap class ('flood' / 'page'), keyed by thread and class, so
  // failures of one kind do not use up the allowance of another.
  var emptyRetryClassAttempts = {};
  // Threads whose retry also waits for the pacer's pause: the pause is read
  // live, so a pause lifted early (a normal page load) frees them at once.
  var emptyRetryPaceBound = {};
  var offlineArticleRetries = new Set();
  var EMPTY_RETRY_DELAY = 15000;
  var EMPTY_RETRY_MAX_DELAY = 60000;
  var MAX_RETRY_TIMER_DELAY = 2147483647;
  // A page answer that is not the thread (notice, blocked or unknown page)
  // is retried this many times; retrying it forever would keep spending the
  // forum's request allowance.
  var UNRECOGNIZED_PAGE_MAX_RETRIES = 4;
  // Pacing and the pause after a forum challenge live in forum-pacer.js; a
  // thread still gives up after this many challenged attempts on this page.
  var FORUM_FLOOD_MAX_RETRIES = 6;
  // A pacer pause longer than this parks no worker: the thread is deferred to
  // the end of the pause, so cached and newly visible rows are not stuck
  // behind it.
  var PACE_DEFER_MIN_PAUSE_MS = 1000;
  var FORUM_WAIT_NOTE_CLASS = 'atp-forum-wait';
  var FORUM_WAIT_CAUSES = {
    offline: { label: '网络已断开', detail: '恢复连接后重新请求正文。' },
    forum_cooldown: { label: '目标论坛请求暂缓', detail: '正在等待目标论坛的冷却或恢复请求。' },
    http_503: { label: '论坛服务暂不可用', detail: '论坛服务暂不可用（HTTP 503）。' },
    http_429: { label: '论坛限流', detail: '论坛返回 HTTP 429（请求过多）。' },
    rate_limited: { label: '论坛限流', detail: '论坛提示请求过于频繁。' },
    challenge_page: { label: '论坛验证', detail: '论坛返回了验证页。' },
    cloudflare: { label: '论坛验证', detail: '论坛返回了 Cloudflare 验证页。' }
  };
  var ARTICLE_ACCESS_CAUSES = {
    login_redirect: '请先登录论坛',
    login_page: '请先登录论坛',
    http_401: '请先登录论坛',
    http_403: '正文访问受限',
    permission_page: '阅读权限不足'
  };
  var forumWaitJobSequence = 0;
  var clearedForumWaitJob = 0;
  var forumWaitJobByLink = new WeakMap();
  var scanGeneration = 0;
  var processCandidateQueue = [];
  var processCandidateQueueCursor = 0;
  var processCandidateQueueGeneration = 0;
  var processCandidateQueueMayHaveMore = false;
  var processCandidateScanState = null;
  var processCandidateScanAllPhase = false;
  // Near phase runs visible-first: one pass from the first on-screen row down,
  // then one pass over the prefetch band above the screen.
  var processCandidateAbovePass = false;
  var bfcacheRecoveryPending = false;
  var initialPrewarmedCandidates = null;
  var lastAppliedSettingsSignature = '';
  var manualPagePaused = false;
  var lastUserScrollAt = 0;
  var scrollStopCommitTimer = null;
  var activeVisibleArticleCheck = null;

  function getSettingsSignature(settings) {
    if (!settings || typeof settings !== 'object') return '';
    try {
      return JSON.stringify(settings);
    } catch (e) {
      return '';
    }
  }

  function logUrl(url) {
    return Logger.sanitizeUrl ? Logger.sanitizeUrl(url) : String(url || '').replace(/[?#].*$/, '').substring(0, 240);
  }

  function isSameOriginUrl(url) {
    try {
      return new URL(url).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  // Thread links into another site (a mirror page linking the built-in forum,
  // or the reverse) are skipped before any fetch or cache read, so one site's
  // session data never renders into another site's page.
  function isArticleUrlInPageZone(url) {
    if (!SharedUtils.getForumUrlZone) return true;
    var pageZone = SharedUtils.getForumUrlZone(location.href);
    return !pageZone || SharedUtils.getForumUrlZone(url) === pageZone;
  }

  function needsSettingsReload(previousSettings, nextSettings) {
    if (typeof SETTINGS_SCHEMA === 'undefined') return false;
    previousSettings = previousSettings || {};
    nextSettings = nextSettings || {};
    for (var i = 0; i < SETTINGS_SCHEMA.length; i++) {
      var item = SETTINGS_SCHEMA[i];
      var applyMode = typeof ATPGetSettingApplyMode === 'function'
        ? ATPGetSettingApplyMode(item, SETTINGS_SCHEMA)
        : (item && item.immediate === false ? 'hotReload' : 'live');
      if (item && applyMode === 'hotReload' && previousSettings[item.key] !== nextSettings[item.key]) {
        return true;
      }
    }
    return false;
  }

  function getChangedSettingsKeys(previousSettings, nextSettings) {
    previousSettings = previousSettings || {};
    nextSettings = nextSettings || {};
    var changed = [];
    if (typeof SETTINGS_SCHEMA === 'undefined') return changed;
    for (var i = 0; i < SETTINGS_SCHEMA.length; i++) {
      var key = SETTINGS_SCHEMA[i] && SETTINGS_SCHEMA[i].key;
      if (key && previousSettings[key] !== nextSettings[key]) changed.push(key);
    }
    return changed;
  }

  function applyLiveSettings(previousSettings, nextSettings) {
    var changedKeys = getChangedSettingsKeys(previousSettings, nextSettings);
    var policySnapshot = null;
    if (changedKeys.length && typeof ATPLoader !== 'undefined' && typeof ATPLoader.reconfigure === 'function') {
      policySnapshot = ATPLoader.reconfigure(nextSettings);
    }
    if (typeof ATPLoader !== 'undefined' && typeof ATPLoader.syncVisibilityPauseState === 'function') {
      ATPLoader.syncVisibilityPauseState();
    }
    if (!changedKeys.length) return;
    if (
      changedKeys.indexOf('gridCols') !== -1 ||
      changedKeys.indexOf('thumbWidth') !== -1 ||
      changedKeys.indexOf('thumbHeight') !== -1 ||
      changedKeys.indexOf('gridGap') !== -1
    ) {
      if (window.ATPRenderer && typeof ATPRenderer.relayoutAllPanels === 'function') {
        ATPRenderer.relayoutAllPanels(nextSettings);
      }
    }
    if (changedKeys.indexOf('animatedThumbnailMode') !== -1) {
      if (typeof ATPLoader !== 'undefined' && typeof ATPLoader.applyAnimatedMode === 'function') {
        ATPLoader.applyAnimatedMode(nextSettings.animatedThumbnailMode);
      }
    }
    if (changedKeys.indexOf('showResourcePanel') !== -1) {
      if (window.ATPResourcePanel && typeof ATPResourcePanel.setPanelEnabled === 'function') {
        ATPResourcePanel.setPanelEnabled(nextSettings.showResourcePanel !== false);
      }
    }
    if (changedKeys.indexOf('showFloatingLauncher') !== -1) {
      var showLauncher = nextSettings.showFloatingLauncher !== false;
      if (window.__bfpPanel && typeof window.__bfpPanel.setLauncherVisible === 'function') {
        window.__bfpPanel.setLauncherVisible(showLauncher);
      } else if (typeof document !== 'undefined' && document.getElementById) {
        var bfpRoot = document.getElementById('bfp-root');
        if (bfpRoot && bfpRoot.style) bfpRoot.style.display = showLauncher ? '' : 'none';
      }
    }
    if (Logger.event) {
      Logger.event('loading_policy', Object.assign({
        changedKeys: changedKeys.join(',')
      }, policySnapshot || ATPLoadPolicy.getPublicSnapshot(nextSettings)), 'INFO');
    }
    for (var i = 0; i < changedKeys.length; i++) {
      if (changedKeys[i].indexOf('article') === 0) {
        detectAndProcess(true);
        break;
      }
    }
  }

  async function fetchSameOriginArticle(url, paceOptions) {
    return { url: url, data: await ATPFetcher.fetchArticleData(url, location.href, paceOptions) };
  }

  function getArticleGroupKey(url) {
    return SharedUtils.normalizeArticleUrl ? SharedUtils.normalizeArticleUrl(url) : url;
  }

  function getRetryableEmptyKey(url) {
    return getArticleGroupKey(url);
  }

  function isRetryableEmptyReason(reason) {
    return reason === 'negative_cache' ||
      reason === 'pace_deferred' ||
      reason === 'offline' ||
      reason === 'forum_cooldown' ||
      PAGE_ANSWER_REASONS[reason] === true ||
      isForumFloodReason(reason);
  }

  // The forum's page answers about one thread; the background path reports
  // isBlockedPage's own names instead of 'blocked'.
  var PAGE_ANSWER_REASONS = {
    unrecognized_page: true,
    forum_message: true,
    blocked: true,
    login_redirect: true,
    login_page: true,
    http_401: true,
    http_403: true,
    permission_page: true,
    download_blocked: true,
    purchase_page: true
  };

  function getRetryCapClass(reason) {
    if (isForumFloodReason(reason)) return 'flood';
    return PAGE_ANSWER_REASONS[reason] === true ? 'page' : '';
  }

  function getRetryCapLimit(capClass) {
    if (capClass === 'flood') return FORUM_FLOOD_MAX_RETRIES;
    return capClass === 'page' ? UNRECOGNIZED_PAGE_MAX_RETRIES : Infinity;
  }

  // The forum answered with an anti-flood / interstitial page or a throttling
  // status instead of the thread.
  function isForumFloodReason(reason) {
    return !!(SharedUtils.isForumFloodReason && SharedUtils.isForumFloodReason(reason));
  }

  function getForumPacer() {
    return window.ATPForumPacer && typeof window.ATPForumPacer.acquire === 'function' ? window.ATPForumPacer : null;
  }

  // The note goes after the thread title; the scanner's own link for a row may
  // be the folder icon in its narrow first cell.
  function getForumWaitNoteAnchor(entry) {
    var container = entry && entry.container;
    var title = container && typeof container.querySelector === 'function' ? container.querySelector('a.xst') : null;
    return title || (entry && entry.link) || null;
  }

  function renderArticleAccessNote(note, text, link, entry, job) {
    if (!note.firstElementChild) {
      note.textContent = '';
      var message = document.createElement('span');
      message.setAttribute('role', 'status');
      note.appendChild(message);
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'atp-forum-retry';
      button.textContent = '重试';
      button.setAttribute('aria-label', '重试加载本帖正文');
      note.appendChild(button);
    }
    note.firstElementChild.textContent = text;
    note.lastElementChild.onclick = function(event) {
      event.stopPropagation();
      if (!ATPConfig.isEnabled() || forumWaitJobByLink.get(link) !== job.waitNoteId ||
          job.waitNoteId <= clearedForumWaitJob || link.nextElementSibling !== note ||
          !isLiveCommitEntry(entry, job.url)) return;
      clearRetryableEmpty(job.url);
      var entries = getLiveCommitEntries(job);
      updateForumWaitNotes(job, entries, 'manualRetry');
      if (articleDispatchWake && articleDispatchWake(entries)) return;
      clearProcessCandidateQueue();
      detectAndProcess(true, true);
    };
  }

  // Multiple scans can use the same title. A granted ticket or late result
  // from an older job must leave a newer pause/retry message in place.
  function updateForumWaitNotes(job, entries, state, reason) {
    job.waitNoteState = state;
    if (typeof document.createElement !== 'function' || job.waitNoteId <= clearedForumWaitJob) return;
    var text, title;
    var accessCause = state === 'retry' || state === 'gaveUp' ? ARTICLE_ACCESS_CAUSES[reason] : '';
    if (state === 'held') {
      text = '正文请求排队中';
      title = '插件正在分批请求帖子正文，轮到这篇帖子时会自动加载。';
    } else if (state === 'manualRetry') {
      text = '正在重试正文';
      title = '等待重新加载本帖。';
    } else if (accessCause) {
      text = accessCause;
      title = state === 'gaveUp' ? '本帖已停止自动重试，处理后可点击重试。' : '处理后可点击重试，插件也会稍后重试本帖。';
    } else if (state) {
      var cause = FORUM_WAIT_CAUSES[reason] || { label: '正文暂未加载', detail: '' };
      if (state === 'gaveUp') {
        text = '正文未加载，刷新页面可重试';
        title = cause.detail + '本页已停止自动重试，刷新列表页可重新请求。';
      } else {
        text = cause.label + '，稍后自动重试';
        title = cause.detail + '插件稍后会自动重试这篇帖子。';
      }
    }
    for (var i = 0; i < entries.length; i++) {
      var link = getForumWaitNoteAnchor(entries[i]);
      if (!link || !link.parentNode || typeof link.insertAdjacentElement !== 'function') continue;
      if ((forumWaitJobByLink.get(link) || 0) > job.waitNoteId) continue;
      forumWaitJobByLink.set(link, job.waitNoteId);
      var note = link.nextElementSibling;
      var hasNote = note && note.classList && note.classList.contains(FORUM_WAIT_NOTE_CLASS);
      if (!accessCause && hasNote && note.contains && note.contains(document.activeElement) && link.focus) {
        link.focus({ preventScroll: true });
      }
      if (!state) {
        if (hasNote) note.remove();
        continue;
      }
      if (!hasNote) {
        note = document.createElement('span');
        note.className = FORUM_WAIT_NOTE_CLASS;
        link.insertAdjacentElement('afterend', note);
      }
      note.title = title;
      if (accessCause) renderArticleAccessNote(note, text, link, entries[i], job);
      else note.textContent = text;
    }
  }

  function shouldNegativeCacheEmptyReason(reason) {
    return reason !== 'html_too_large' && !isRetryableEmptyReason(reason);
  }

  function makeRetryableEmptyInfo(reason, retryAfter) {
    return {
      reason: reason || 'retryable',
      retryAfter: Math.max(0, Number(retryAfter || 0) || 0)
    };
  }

  function getRetryableEmptyReason(info) {
    if (info && typeof info === 'object') return info.reason || 'retryable';
    return info || 'retryable';
  }

  function getRetryableEmptyRetryAfter(info) {
    if (!info || typeof info !== 'object') return 0;
    return Math.max(0, Number(info.retryAfter || 0) || 0);
  }

  function getLoadPolicySettings() {
    return window.ATPState && window.ATPState.settings || {};
  }

  function logDiagnosticConfig(settings, reason) {
    if (!Logger.event) return;
    settings = settings || {};
    var ordinary = Math.max(1, Number(settings.firstScreenConcurrency) || 3);
    // The loader runs no heavy channel when heavy optimization is off.
    var heavy = settings.heavyImageOptimization === false ? 0 : Math.max(0, Number(settings.heavyImageConcurrency) || 2);
    var globalLimit = ATPLoadPolicy.getGlobalImageConcurrency(settings, ordinary, heavy);
    var visibleReserve = Math.min(Math.max(0, globalLimit - 1),
      ATPLoadPolicy.getViewportPriorityReservedSlots(settings));
    var pacer = getForumPacer();
    var paceState = pacer && pacer.getState ? pacer.getState() : null;
    Logger.event('diagnostic_config', {
      reason: reason || 'startup',
      gridCols: settings.gridCols,
      visibleRows: settings.visibleRows,
      autoLoadOffscreenFirstRowsEnabled: settings.autoLoadOffscreenFirstRowsEnabled === true,
      firstScreenConcurrency: ordinary,
      backgroundConcurrency: settings.backgroundConcurrency,
      heavyImageConcurrency: heavy,
      globalImageConcurrency: globalLimit,
      viewportPriorityReservedSlots: visibleReserve,
      offscreenAdmissionLimit: Math.max(1, globalLimit - visibleReserve),
      offscreenOrdinaryLimit: Math.min(ATPLoadPolicy.getOffscreenFirstRowOrdinaryLimit(settings), Math.max(1, globalLimit - visibleReserve)),
      ordinaryHostConcurrency: settings.ordinaryHostConcurrency,
      articleFetchConcurrency: ATPLoadPolicy.getArticleFetchConcurrency(settings),
      forumRequestBurst: paceState ? paceState.burst : undefined,
      forumRequestIntervalMs: paceState ? paceState.refillMs : undefined,
      imageTimeout: settings.imageTimeout,
      imageTaskDeadline: settings.imageTaskDeadline,
      readyImageAttemptTimeout: ATPLoadPolicy.getReadyImageAttemptTimeout(settings),
      largeImageTimeout: ATPLoadPolicy.getLargeImageTimeout(settings),
      largeImageTaskDeadline: ATPLoadPolicy.getLargeImageTaskDeadline(settings),
      largeImageHostConcurrency: ATPLoadPolicy.getLargeImageHostConcurrency(settings),
      debugLogging: settings.debugLogging === true
    }, 'INFO');
  }

  function getArticleFetchConcurrency() {
    return ATPLoadPolicy.getArticleFetchConcurrency(getLoadPolicySettings());
  }

  function getArticleQueueHighWatermark() {
    return ATPLoadPolicy.getArticleQueueHighWatermark(getLoadPolicySettings());
  }

  function getArticlePrefetchDistance() {
    return ATPLoadPolicy.getArticlePrefetchDistance(getLoadPolicySettings());
  }

  function shouldAutoLoadOffscreenFirstRows() {
    var settings = getLoadPolicySettings();
    return settings.autoLoadOffscreenFirstRowsEnabled === true;
  }

  function createProcessScanContext() {
    var vh = window.innerHeight || document.documentElement.clientHeight || 800;
    var margin = getArticlePrefetchDistance();
    return {
      now: Date.now(),
      viewportTop: -margin,
      viewportBottom: vh + margin,
      reachedBelowViewport: false
    };
  }

  function isNearViewport(entry, scanContext) {
    var el = entry && entry.container;
    if (!el || !el.getBoundingClientRect) return true;
    var rect = el.getBoundingClientRect();
    scanContext = scanContext || createProcessScanContext();
    var viewportTop = typeof scanContext.viewportTop === 'number' ? scanContext.viewportTop : -getArticlePrefetchDistance();
    if (rect.top > scanContext.viewportBottom) scanContext.reachedBelowViewport = true;
    return rect.bottom >= viewportTop && rect.top <= scanContext.viewportBottom;
  }

  function isProcessCandidate(entry, scanContext) {
    var url = entry && entry.link && entry.link.href;
    if (!url || ATPScanner.shouldExcludeUrl(url) || !ATPScanner.isArticlePageUrl(url) || !isArticleUrlInPageZone(url)) return false;
    var retryKey = getRetryableEmptyKey(url);
    if (emptyRetryGivenUp[retryKey] || offlineArticleRetries.has(retryKey)) return false;
    var retryAfter = emptyRetryAfterByUrl[retryKey];
    scanContext = scanContext || createProcessScanContext();
    if (retryAfter && emptyRetryPaceBound[retryKey]) retryAfter = Math.max(retryAfter, getLivePauseUntil());
    if (retryAfter && scanContext.now < retryAfter) {
      scheduleRetryScanAt(retryAfter);
      return false;
    }
    // 重试到期：仅清除到期时间，保留尝试次数，确保再次失败时指数退避继续生效
    if (retryAfter) {
      delete emptyRetryAfterByUrl[retryKey];
      delete emptyRetryPaceBound[retryKey];
    }
    return (shouldAutoLoadOffscreenFirstRows() && processCandidateScanAllPhase) || isNearViewport(entry, scanContext);
  }

  function clearQueuedProcessCandidates() {
    processCandidateQueue = [];
    processCandidateQueueCursor = 0;
    processCandidateQueueGeneration = scanGeneration;
    processCandidateQueueMayHaveMore = false;
  }

  function keepUnconsumedQueuedProcessCandidates() {
    if (processCandidateQueueCursor > 0) {
      var writeIndex = 0;
      for (var readIndex = processCandidateQueueCursor; readIndex < processCandidateQueue.length; readIndex++) {
        processCandidateQueue[writeIndex++] = processCandidateQueue[readIndex];
      }
      processCandidateQueue.length = writeIndex;
      processCandidateQueueCursor = 0;
    }
    processCandidateQueueGeneration = scanGeneration;
    processCandidateScanState = null;
    processCandidateScanAllPhase = false;
    processCandidateAbovePass = false;
    processCandidateQueueMayHaveMore = true;
  }

  function clearProcessCandidateQueue() {
    clearQueuedProcessCandidates();
    processCandidateScanState = null;
    processCandidateScanAllPhase = false;
    processCandidateAbovePass = false;
  }

  function isLiveProcessCandidate(entry, scanContext, expectedUrl) {
    var el = entry && entry.container;
    var link = entry && entry.link;
    if (!el || !document.contains(el)) return false;
    if (!link || !document.contains(link)) return false;
    if (el.contains && !el.contains(link)) return false;
    if (expectedUrl && getArticleGroupKey(link.href) !== getArticleGroupKey(expectedUrl)) return false;
    if (ATPScanner.isDecoratedArticleContainer) {
      if (ATPScanner.isDecoratedArticleContainer(el)) return false;
    } else {
      if (el.classList && el.classList.contains('atp-processed')) return false;
      if (el.querySelector && el.querySelector('.atp-thumbnail-container')) return false;
      if (
        el.tagName === 'TR' &&
        el.nextElementSibling &&
        el.nextElementSibling.classList &&
        el.nextElementSibling.classList.contains('atp-thumb-row')
      ) return false;
    }
    return isProcessCandidate(entry, scanContext);
  }

  function isQueuedProcessCandidate(entry, scanContext) {
    return isLiveProcessCandidate(entry, scanContext, null);
  }

  function takeQueuedProcessCandidates(limit, scanContext) {
    var out = [];
    while (processCandidateQueueCursor < processCandidateQueue.length && out.length < limit) {
      var entry = processCandidateQueue[processCandidateQueueCursor++];
      if (isQueuedProcessCandidate(entry, scanContext)) out.push(entry);
    }
    if (processCandidateQueueCursor >= processCandidateQueue.length) {
      processCandidateQueue = [];
      processCandidateQueueCursor = 0;
    }
    return out;
  }

  function refillProcessCandidateQueue(limit, scanContext) {
    var settings = window.ATPState && window.ATPState.settings;
    var scanLimit = Math.max(1, Number(limit) || getArticleQueueHighWatermark());
    if (!processCandidateScanState) processCandidateScanState = {};
    processCandidateQueue = ATPScanner.detectArticleContainers({
      limit: scanLimit + 1,
      scanState: processCandidateScanState,
      seekViewportStart: !processCandidateScanAllPhase,
      // Seek to the first on-screen row, and only then to the band above:
      // seeking from the band top after a jump (End key, scroll restore)
      // queued and fetched the rows above the screen before the visible ones.
      viewportTop: processCandidateAbovePass ? (scanContext ? scanContext.viewportTop : -getArticlePrefetchDistance()) : 0,
      skipServiceThreads: !settings || settings.skipServiceThreads !== false,
      accept: function(entry) {
        return isProcessCandidate(entry, scanContext);
      }
    });
    processCandidateQueueCursor = 0;
    processCandidateQueueGeneration = scanGeneration;
    var hasSentinelCandidate = processCandidateQueue.length > scanLimit;
    var passedViewport = scanContext && scanContext.reachedBelowViewport && !processCandidateScanState.viewportOrderUncertain;
    var nearPhaseDone = shouldAutoLoadOffscreenFirstRows() && !processCandidateScanAllPhase &&
      (processCandidateScanState.exhausted || (passedViewport && !processCandidateQueue.length));
    if (nearPhaseDone) {
      processCandidateScanAllPhase = true;
      processCandidateScanState = null;
    }
    var shouldContinueScan = !!(processCandidateScanState && !processCandidateScanState.exhausted &&
      (processCandidateScanAllPhase || !passedViewport || processCandidateQueue.length > 0));
    var startAbovePass = !processCandidateScanAllPhase && !processCandidateAbovePass && !nearPhaseDone &&
      !hasSentinelCandidate && !shouldContinueScan;
    if (startAbovePass) {
      processCandidateAbovePass = true;
      // An exhausted cursor makes the scanner reset and seek again, now from
      // the band top.
      processCandidateScanState.exhausted = true;
    }
    processCandidateQueueMayHaveMore = hasSentinelCandidate || nearPhaseDone ||
      shouldContinueScan || startAbovePass;
    return startAbovePass;
  }

  function hasMoreProcessCandidates() {
    return processCandidateQueueCursor < processCandidateQueue.length || processCandidateQueueMayHaveMore;
  }

  function prewarmInitialVisibleCandidates() {
    initialPrewarmedCandidates = null;
    if (typeof document === 'undefined' || document.readyState === 'loading') return;
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    if (!window.ATPScanner || typeof ATPScanner.detectArticleContainers !== 'function') return;
    try {
      var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 800;
      var scanState = {};
      var found = ATPScanner.detectArticleContainers({
        limit: 24,
        scanState: scanState,
        seekViewportStart: true,
        viewportTop: 0,
        skipServiceThreads: true,
        accept: function(entry) {
          var url = entry && entry.link && entry.link.href;
          if (!url || ATPScanner.shouldExcludeUrl(url) || !ATPScanner.isArticlePageUrl(url) || !isArticleUrlInPageZone(url)) return false;
          var el = entry.container;
          if (!el || !el.getBoundingClientRect) return true;
          var rect = el.getBoundingClientRect();
          return rect.bottom >= 0 && rect.top <= vh + 600;
        }
      });
      if (found && found.length) {
        initialPrewarmedCandidates = {
          entries: found,
          generation: scanGeneration
        };
      }
    } catch (e) {
      initialPrewarmedCandidates = null;
    }
  }

  function detectProcessCandidates(limit) {
    limit = Math.max(1, Number(limit) || getArticleQueueHighWatermark());
    if (processCandidateQueueGeneration !== scanGeneration) clearProcessCandidateQueue();
    var scanContext = createProcessScanContext();
    if (initialPrewarmedCandidates) {
      var prewarmed = initialPrewarmedCandidates;
      initialPrewarmedCandidates = null;
      var curSettings = window.ATPState && window.ATPState.settings;
      if (prewarmed.generation === scanGeneration && (!curSettings || curSettings.skipServiceThreads !== false)) {
        var validPrewarmed = [];
        for (var pi = 0; pi < prewarmed.entries.length; pi++) {
          if (isQueuedProcessCandidate(prewarmed.entries[pi], scanContext)) {
            validPrewarmed.push(prewarmed.entries[pi]);
          }
        }
        if (validPrewarmed.length) {
          processCandidateQueueMayHaveMore = true;
          if (validPrewarmed.length > limit) {
            processCandidateQueue = validPrewarmed.slice(limit);
            processCandidateQueueCursor = 0;
            processCandidateQueueGeneration = scanGeneration;
            return validPrewarmed.slice(0, limit);
          }
          return validPrewarmed;
        }
      }
    }
    var candidates = takeQueuedProcessCandidates(limit, scanContext);
    if (candidates.length) return candidates;
    var abovePassArmed = refillProcessCandidateQueue(limit, scanContext);
    candidates = takeQueuedProcessCandidates(limit, scanContext);
    if (candidates.length || !abovePassArmed) return candidates;
    // The visible-first pass came up empty: cover the band above in this same
    // call instead of chaining another scan cycle.
    refillProcessCandidateQueue(limit, scanContext);
    return takeQueuedProcessCandidates(limit, scanContext);
  }

  function isATPAddedNode(node) {
    if (!node || node.nodeType !== 1) return false;
    var cls = node.classList;
    if (cls && (
      cls.contains('atp-thread-panel') ||
      cls.contains('atp-thumb-row') ||
      cls.contains('atp-scroll-viewport') ||
      cls.contains('atp-thumbnail-container') ||
      cls.contains('atp-thumbnail-wrapper') ||
      cls.contains('atp-thumbnail-img') ||
      cls.contains('atp-thumbnail-loading') ||
      cls.contains('atp-more-overlay-badge') ||
      cls.contains('atp-heavy-preview-canvas') ||
      cls.contains('atp-resource-sidebar') ||
      cls.contains('atp-resource-inline') ||
      cls.contains(FORUM_WAIT_NOTE_CLASS)
    )) return true;
    if (node.closest && node.closest('.atp-thread-panel,.atp-thumb-row,.atp-thumbnail-container,.atp-thumbnail-wrapper,.atp-resource-sidebar,.atp-resource-inline')) {
      return true;
    }
    return false;
  }

  function mutationHasExternalAdd(mutation) {
    for (var i = 0; i < mutation.addedNodes.length; i++) {
      var node = mutation.addedNodes[i];
      if (node.nodeType === 1 && !isATPAddedNode(node)) return true;
    }
    return false;
  }

  function isArticleMutationNode(node) {
    if (!node || node.nodeType !== 1 || isATPAddedNode(node)) return false;
    if (node.matches && node.matches(MUTATION_ARTICLE_ADD_SELECTOR)) return true;
    return !!(node.querySelector && node.querySelector(MUTATION_ARTICLE_ADD_SELECTOR));
  }

  function mutationHasArticleAdd(mutation) {
    for (var i = 0; i < mutation.addedNodes.length; i++) {
      if (isArticleMutationNode(mutation.addedNodes[i])) return true;
    }
    return false;
  }

  function mutationsHaveExternalArticleAdd(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes.length && mutationHasExternalAdd(mutations[i]) && mutationHasArticleAdd(mutations[i])) {
        return true;
      }
    }
    return false;
  }

  function mutationsRemoveThreadRows(mutations) {
    var selector = 'tbody,tr,.atp-thread-panel,.atp-processed';
    for (var i = 0; i < mutations.length; i++) {
      var mutation = mutations[i];
      if (!mutation.removedNodes || !mutation.removedNodes.length) continue;
      // Loading indicators, resource buttons and other contents of our own
      // panel change frequently. They cannot contain a registered forum row.
      if (mutation.target && mutation.target.closest && mutation.target.closest('.atp-thread-panel')) continue;
      for (var j = 0; j < mutation.removedNodes.length; j++) {
        var node = mutation.removedNodes[j];
        if (node.nodeType !== 1) continue;
        if ((node.matches && node.matches(selector)) || (node.querySelector && node.querySelector(selector))) return true;
      }
    }
    return false;
  }

  function mutationsHaveThreadRowAdd(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (!node || node.nodeType !== 1 || isATPAddedNode(node)) continue;
        if (node.matches && node.matches(DORMANT_THREAD_ROW_SELECTOR)) return true;
        if (node.querySelector && node.querySelector(DORMANT_THREAD_ROW_SELECTOR)) return true;
      }
    }
    return false;
  }

  function isATPMutationTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    var cls = target.classList;
    if (cls && (
      cls.contains('atp-thread-panel') ||
      cls.contains('atp-thumb-row') ||
      cls.contains('atp-scroll-viewport') ||
      cls.contains('atp-thumbnail-container') ||
      cls.contains('atp-thumbnail-wrapper') ||
      cls.contains('atp-resource-sidebar') ||
      cls.contains('atp-resource-inline') ||
      cls.contains(FORUM_WAIT_NOTE_CLASS)
    )) return true;
    return !!(target.closest && target.closest('.atp-thread-panel,.atp-thumb-row,.atp-resource-sidebar,.atp-resource-inline,.' + FORUM_WAIT_NOTE_CLASS));
  }

  function areAllMutationsSelfGenerated(mutations) {
    if (!mutations || !mutations.length) return true;
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (isATPMutationTarget(m.target)) continue;
      var added = m.addedNodes;
      var removed = m.removedNodes;
      for (var a = 0; added && a < added.length; a++) {
        if (added[a] && added[a].nodeType === 1 && !isATPAddedNode(added[a])) return false;
      }
      for (var r = 0; removed && r < removed.length; r++) {
        if (removed[r] && removed[r].nodeType === 1 && !isATPAddedNode(removed[r])) return false;
      }
    }
    return true;
  }

  function disconnectContainerParentObserver() {
    if (containerParentObserver) {
      containerParentObserver.disconnect();
      containerParentObserver = null;
    }
  }

  function disconnectDormantObserver() {
    if (!dormantObserver) return;
    dormantObserver.disconnect();
    dormantObserver = null;
  }

  function setupDormantObserver() {
    if (dormantObserver || !ATPConfig.isEnabled()) return;
    if (dormantRestartCount >= DORMANT_MAX_RESTARTS) return;
    var root = document.body || document.documentElement;
    if (!root) return;
    dormantObserver = new MutationObserver(function(ms) {
      if (pauseScanningForHiddenPage() || !mutationsHaveThreadRowAdd(ms)) return;
      disconnectDormantObserver();
      dormantRestartCount++;
      observerRetryCount = 0;
      setupObserver('dormant');
      detectAndProcess(true);
    });
    dormantObserver.observe(root, { childList: true, subtree: true });
  }

  function rebindThreadObserver(reason) {
    Logger.info('Observer', reason);
    // An already pending timer belongs to the old scan generation. Leave
    // the new root free to schedule its first scan immediately.
    clearScanTimers();
    bumpScanGeneration(true);
    var bound = setupObserver('rebind');
    detectAndProcess(true);
    return bound;
  }

  function setupContainerParentObserver(container) {
    disconnectContainerParentObserver();
    var parent = container && container.parentNode;
    if (!parent) return;
    var nextParentObserver = new MutationObserver(function(ms) {
      if (pauseScanningForHiddenPage()) return;
      if (!document.contains(container) || container.parentNode !== parent) {
        rebindThreadObserver('Thread container parent changed, rebinding');
        return;
      }
      if (!mutationsHaveExternalArticleAdd(ms)) return;
      if (ATPScanner.findThreadContainer(true) !== container) {
        rebindThreadObserver('Preferred thread container changed, rebinding');
        return;
      }
      clearProcessCandidateQueue();
      detectAndProcess(true);
    });
    nextParentObserver.observe(parent, { childList: true });
    containerParentObserver = nextParentObserver;
  }

  function initATPState() {
    if (!window.ATPState) window.ATPState = {};
    window.ATPState.threads = {};
    window.ATPState.generation = scanGeneration;
    emptyRetryAfterByUrl = {};
    emptyRetryAttemptsByUrl = {};
    emptyRetryGivenUp = {};
    emptyRetryClassAttempts = {};
    emptyRetryPaceBound = {};
    offlineArticleRetries.clear();
    clearProcessCandidateQueue();
  }

  function bumpScanGeneration(keepAttachedThreads) {
    scanGeneration++;
    initialPrewarmedCandidates = null;
    clearProcessCandidateQueue();
    if (articleDispatchWake) articleDispatchWake();
    var retained = reconcileThreadStates(!keepAttachedThreads);
    // A forum can move live rows into a replacement list. Their existing
    // image tasks and previews still own the same rendered generation.
    if (!retained && window.ATPState) window.ATPState.generation = scanGeneration;
    return scanGeneration;
  }

  function reconcileThreadStates(invalidateAll) {
    var threads = window.ATPState && window.ATPState.threads;
    if (!threads) return false;
    var retained = false;
    var removedThreads = null;
    // 删除前先落地该帖挂起的 loadedUrls 缓存写回（flushCacheNow 需要 ts 仍在表中），
    // 否则 1s 批量定时器稍后触发时查不到 ts，这批已加载标记会被静默丢弃
    var pendingFlush = window.ATPCache && ATPCache.getPendingFlush ? ATPCache.getPendingFlush() : null;
    for (var tid in threads) {
      var ts = threads[tid];
      if (!ts) { delete threads[tid]; continue; }
      if (!invalidateAll && (!ts.container || document.contains(ts.container))) {
        // TBODY holds its panel. With TR and non-table templates the panel
        // follows its source as a sibling, including after the forum moves it.
        if (ts.container && ts.container.tagName !== 'TBODY') {
          var sibling = ts.outerRow || ts.panel;
          if (sibling && ts.container.insertAdjacentElement && ts.container.nextElementSibling !== sibling) {
            ts.container.insertAdjacentElement('afterend', sibling);
          }
        }
        if (!ts.panel || document.contains(ts.panel)) {
          retained = true;
          continue;
        }
      }
      if (pendingFlush && pendingFlush[tid] && ATPCache.flushCacheNow) ATPCache.flushCacheNow(tid);
      delete threads[tid];
      if (!invalidateAll) {
        if (!removedThreads) removedThreads = new Set();
        removedThreads.add(tid);
        // The UI is a sibling for TR and non-table templates. Remove both
        // halves even in a detached subtree so reinsertion can redecorate it.
        if (ts.outerRow && ts.outerRow.parentNode) ts.outerRow.remove();
        if (ts.panel && ts.panel.parentNode) ts.panel.remove();
        if (ts.container && ts.container.classList) ts.container.classList.remove('atp-processed');
        if (window.ATPResourcePanel) ATPResourcePanel.updateThread(ts);
      }
    }
    if (removedThreads && window.ATPLoader && ATPLoader.discardThreadImages) {
      ATPLoader.discardThreadImages(removedThreads);
    }
    return retained;
  }

  function clearScanTimers() {
    if (scrollScanTimer) {
      clearTimeout(scrollScanTimer);
      scrollScanTimer = null;
    }
    if (scanDelayTimer) {
      clearTimeout(scanDelayTimer);
      scanDelayTimer = null;
      scanPending = false;
    }
    if (throttleScanTimer) {
      clearTimeout(throttleScanTimer);
      throttleScanTimer = null;
    }
    if (retryScanTimer) {
      clearTimeout(retryScanTimer);
      retryScanTimer = null;
      retryScanDueAt = 0;
    }
    if (followupScanTimer) {
      clearTimeout(followupScanTimer);
      followupScanTimer = null;
    }
    if (scrollStopCommitTimer) {
      clearTimeout(scrollStopCommitTimer);
      scrollStopCommitTimer = null;
    }
  }

  function clearObserverRetryTimer(resetCount) {
    if (observerRetryTimer) {
      clearTimeout(observerRetryTimer);
      observerRetryTimer = null;
    }
    if (resetCount !== false) observerRetryCount = 0;
  }

  function shouldPauseScanningWhenHidden() {
    var settings = window.ATPState && window.ATPState.settings;
    return document.visibilityState !== 'visible' && (!settings || settings.pauseWhenHidden !== false);
  }

  function pauseScanningForHiddenPage() {
    if (!shouldPauseScanningWhenHidden()) return false;
    rescanRequested = true;
    clearScanTimers();
    clearObserverRetryTimer();
    clearProcessCandidateQueue();
    if (articleDispatchWake) articleDispatchWake();
    return true;
  }

  function syncLoaderVisibilityPauseState() {
    if (typeof ATPLoader === 'undefined') return;
    if (typeof ATPLoader.syncVisibilityPauseState === 'function') {
      ATPLoader.syncVisibilityPauseState();
    } else if (!shouldPauseScanningWhenHidden() && typeof ATPLoader.resume === 'function') {
      ATPLoader.resume();
    }
  }

  function scheduleFollowupScan(delay, generation) {
    if (followupScanTimer) {
      clearTimeout(followupScanTimer);
      followupScanTimer = null;
    }
    followupScanTimer = setTimeout(function() {
      followupScanTimer = null;
      if (generation !== null && generation !== undefined && generation !== scanGeneration) return;
      if (!ATPConfig.isEnabled()) return;
      detectAndProcess(true, !delay);
    }, Math.max(0, delay || 0));
  }

  function scheduleRetryScanAt(dueAt) {
    if (pauseScanningForHiddenPage()) return;
    dueAt = Number(dueAt) || (Date.now() + EMPTY_RETRY_DELAY);
    var fireAt = dueAt + 100;
    if (retryScanTimer && retryScanDueAt && retryScanDueAt <= fireAt) return;
    if (retryScanTimer) {
      clearTimeout(retryScanTimer);
      retryScanTimer = null;
    }
    retryScanDueAt = fireAt;
    retryScanTimer = setTimeout(function() {
      retryScanTimer = null;
      retryScanDueAt = 0;
      if (pauseScanningForHiddenPage()) return;
      clearProcessCandidateQueue();
      detectAndProcess(true);
    }, Math.min(MAX_RETRY_TIMER_DELAY, Math.max(0, fireAt - Date.now())));
  }

  function scheduleThrottledScan(delay) {
    if (pauseScanningForHiddenPage()) return;
    if (throttleScanTimer) return;
    throttleScanTimer = setTimeout(function() {
      throttleScanTimer = null;
      if (pauseScanningForHiddenPage()) return;
      detectAndProcess(true);
    }, Math.max(50, delay));
  }

  // Returns false when the thread has used up its automatic retries.
  function rememberRetryableEmpty(url, info) {
    var retryKey = getRetryableEmptyKey(url);
    var reason = getRetryableEmptyReason(info);
    var explicitRetryAfter = getRetryableEmptyRetryAfter(info);
    if (reason === 'offline') {
      if (isNetworkOffline()) offlineArticleRetries.add(retryKey);
      else scheduleRetryScanAt(Date.now());
      return true;
    }
    offlineArticleRetries.delete(retryKey);
    if (reason === 'forum_cooldown') {
      var targetDueAt = Math.max(explicitRetryAfter, Date.now() + 1000);
      emptyRetryAfterByUrl[retryKey] = targetDueAt;
      delete emptyRetryPaceBound[retryKey];
      scheduleRetryScanAt(targetDueAt);
      return true;
    }
    if (reason === 'pace_deferred') {
      // Never sent: no attempt used, back when the pacer's pause ends.
      var deferredDue = Date.now() + 1000;
      emptyRetryAfterByUrl[retryKey] = deferredDue;
      emptyRetryPaceBound[retryKey] = true;
      scheduleRetryScanAt(Math.max(deferredDue, getLivePauseUntil()));
      return true;
    }
    var attempts = (emptyRetryAttemptsByUrl[retryKey] || 0) + 1;
    emptyRetryAttemptsByUrl[retryKey] = attempts;
    var capClass = getRetryCapClass(reason);
    if (capClass) {
      var classKey = retryKey + '|' + capClass;
      var classAttempts = (emptyRetryClassAttempts[classKey] || 0) + 1;
      emptyRetryClassAttempts[classKey] = classAttempts;
      if (classAttempts > getRetryCapLimit(capClass)) {
        emptyRetryGivenUp[retryKey] = true;
        delete emptyRetryAfterByUrl[retryKey];
        delete emptyRetryPaceBound[retryKey];
        Logger.debug('文章多次返回非帖子页，本页不再自动重试', reason + ' ' + logUrl(url));
        return false;
      }
    }
    var delay = Math.min(EMPTY_RETRY_MAX_DELAY, EMPTY_RETRY_DELAY * Math.pow(2, Math.min(attempts - 1, 3)));
    // Retry-After raises the backoff but never shortens it; a server answering
    // "Retry-After: 0" must not turn the retry into a tight loop.
    var dueAt = Math.max(explicitRetryAfter || 0, Date.now() + delay);
    delay = Math.max(0, dueAt - Date.now());
    emptyRetryAfterByUrl[retryKey] = dueAt;
    // A refusal by the forum also waits for the pacer's pause, read live.
    if (capClass === 'flood') emptyRetryPaceBound[retryKey] = true;
    else delete emptyRetryPaceBound[retryKey];
    Logger.debug('文章临时空结果，稍后重试', (reason || 'retryable') + ' ' + delay + 'ms ' + logUrl(url));
    scheduleRetryScanAt(capClass === 'flood' ? Math.max(dueAt, getLivePauseUntil()) : dueAt);
    return true;
  }

  function clearRetryableEmpty(url) {
    var retryKey = getRetryableEmptyKey(url);
    offlineArticleRetries.delete(retryKey);
    delete emptyRetryAfterByUrl[retryKey];
    delete emptyRetryAttemptsByUrl[retryKey];
    delete emptyRetryGivenUp[retryKey];
    delete emptyRetryPaceBound[retryKey];
    delete emptyRetryClassAttempts[retryKey + '|flood'];
    delete emptyRetryClassAttempts[retryKey + '|page'];
  }

  function isNetworkOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  function releaseOfflineArticleRetries() {
    if (!offlineArticleRetries.size || isNetworkOffline() || forumEntryOnly || !ATPConfig.isEnabled()) return false;
    offlineArticleRetries.clear();
    return true;
  }

  function handleNetworkOnline() {
    if (articleDispatchWake) articleDispatchWake();
    if (releaseOfflineArticleRetries()) scheduleRetryScanAt(Date.now());
  }

  function getLivePauseUntil() {
    var pacer = getForumPacer();
    return pacer ? pacer.getPauseUntil() : 0;
  }

  function hasPaceBoundRetries() {
    for (var key in emptyRetryPaceBound) {
      if (Object.prototype.hasOwnProperty.call(emptyRetryPaceBound, key)) return true;
    }
    return false;
  }

  // Another tab changed the shared pacer state; if that lifted the pause (a
  // normal forum page load, or the pause ran out), threads waiting on it are
  // due now rather than at the old pause end.
  function handleForumPacerStorage(event) {
    var pacer = getForumPacer();
    if (!pacer || !event || event.key !== pacer.STORE_KEY) return;
    if (articleDispatchWake) articleDispatchWake();
    if (!hasPaceBoundRetries()) return;
    if (!ATPConfig.isEnabled() || pacer.getPauseUntil() - Date.now() > PACE_DEFER_MIN_PAUSE_MS) return;
    scheduleRetryScanAt(Date.now());
  }


  // How a queued article fetch waits for the forum pacer: the thread on
  // screen goes first, the wait ends with the scan that asked for it, and a
  // real pause defers the thread instead of parking the worker.
  function makeArticlePaceOptions(job, generation) {
    var pacer = getForumPacer();
    job.paceDeferred = false;
    job.offlineDeferred = false;
    var options = {
      abortSignal: job.abortController ? job.abortController.signal : null,
      getPriority: function() {
        if (!pacer) return 0;
        return isArticleJobVisible(job) ? pacer.PRIORITY_VISIBLE : pacer.PRIORITY_ARTICLE;
      },
      isCancelled: function() {
        if (!isArticleJobCurrent(job, generation)) return true;
        if (typeof job.shouldHandBack === 'function' && job.shouldHandBack(job)) {
          job.handedBack = true;
          return true;
        }
        if (isNetworkOffline()) {
          job.offlineDeferred = true;
          return true;
        }
        if (pacer && pacer.getPauseUntil() - Date.now() > PACE_DEFER_MIN_PAUSE_MS) {
          job.paceDeferred = true;
          return true;
        }
        return false;
      },
      isCurrent: function() { return isArticleJobCurrent(job, generation); },
      onHeld: function() {
        if (job.waitingPaceOptions === options && generation === scanGeneration && ATPConfig.isEnabled()) {
          updateForumWaitNotes(job, getLiveCommitEntries(job), 'held');
        }
      },
      onGranted: function(waitMs) {
        if (job.waitingPaceOptions !== options) return;
        job.waitingPaceOptions = null;
        job.paceWaitMs = waitMs;
        if (generation === scanGeneration && ATPConfig.isEnabled()) updateForumWaitNotes(job, getLiveCommitEntries(job), null);
        if (typeof job.onPaceGranted === 'function') job.onPaceGranted();
      }
    };
    job.waitingPaceOptions = options;
    return options;
  }

  var articleCommitQueue = [];
  var articleCommitScheduled = false;

  function hasArticlePayload(data) {
    return !!(
      data && (
        data.images.length ||
        SharedUtils.hasResourcePayload(data.resources) ||
        data.textAttachments.length ||
        data.hasTextAttachments
      )
    );
  }

  function isLiveCommitEntry(entry, expectedUrl) {
    var el = entry && entry.container;
    var link = entry && entry.link;
    if (!el || !document.contains(el) || !link || !document.contains(link)) return false;
    if (el.contains && !el.contains(link)) return false;
    if (expectedUrl && getArticleGroupKey(link.href) !== getArticleGroupKey(expectedUrl)) return false;
    if (ATPScanner.isDecoratedArticleContainer) return !ATPScanner.isDecoratedArticleContainer(el);
    return !(el.classList && el.classList.contains('atp-processed'));
  }

  function getLiveCommitEntries(job) {
    var out = [];
    for (var i = 0; i < job.entries.length; i++) {
      if (isLiveCommitEntry(job.entries[i], job.url)) out.push(job.entries[i]);
    }
    return out;
  }

  function isArticleScanCurrent(generation) {
    return generation === scanGeneration && !bfcacheRecoveryPending && !startupCancelled &&
      ATPConfig.isEnabled() && !pauseScanningForHiddenPage();
  }

  function isArticleJobCurrent(job, generation) {
    return isArticleScanCurrent(generation) &&
      job.entries.some(function(entry) { return isLiveCommitEntry(entry, job.url); });
  }

  function requestArticleRescan() {
    clearProcessCandidateQueue();
    rescanRequested = true;
  }

  function isArticleCommitCacheCurrent(job) {
    if (ATPCache.isArticleCacheReadCurrent(job.cacheState || job.data)) return true;
    requestArticleRescan();
    return false;
  }

  // How far the job's row is from the viewport (0 when on screen); Infinity
  // when it cannot be measured or the page is hidden.
  function getArticleJobViewportDistance(job) {
    if (document.visibilityState && document.visibilityState !== 'visible') return Infinity;
    var entries = getLiveCommitEntries(job);
    var vh = window.innerHeight || document.documentElement.clientHeight || 800;
    var best = Infinity;
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i].container;
      if (!el || !el.getBoundingClientRect) {
        best = 0;
        continue;
      }
      var rect = el.getBoundingClientRect();
      var distance = rect.top > vh ? rect.top - vh : (rect.bottom < 0 ? -rect.bottom : 0);
      entries[i].lastViewportVisible = distance === 0;
      if (distance < best) best = distance;
    }
    return best;
  }

  function isArticleJobVisible(job) {
    return getArticleJobViewportDistance(job) === 0;
  }

  function isJobStrictlyAboveViewport(job) {
    if (document.visibilityState && document.visibilityState !== 'visible') return false;
    var entries = getLiveCommitEntries(job);
    if (!entries.length) return false;
    var anyAbove = false;
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i].container;
      if (!el || !el.getBoundingClientRect) return false;
      var rect = el.getBoundingClientRect();
      if (rect.bottom >= 0) return false;
      anyAbove = true;
    }
    return anyAbove;
  }

  function pickBestArticleEntry(entries) {
    var best = entries[0];
    for (var i = 1; i < entries.length; i++) {
      if (entries[i].container.tagName === 'TBODY') return entries[i];
      if (best.container.tagName !== 'TBODY' && entries[i].container.tagName === 'TR') best = entries[i];
    }
    return best;
  }

  function commitArticleResult(job, summary, generation, gallery) {
    if (!isArticleScanCurrent(generation)) return;
    var entries = getLiveCommitEntries(job);
    if (!entries.length) return;
    if (!isArticleCommitCacheCurrent(job)) return;
    var data = job.data || ATPCache.normalizeArticleData(null);
    if (!job.summaryCounted) {
      job.summaryCounted = true;
      if (hasArticlePayload(data)) summary.articles++;
      summary.images += data.images.length;
      summary.resources += SharedUtils.countResources(data.resources);
    }
    if (!hasArticlePayload(data)) {
      if (job.retryableEmpty) {
        var retryReason = getRetryableEmptyReason(job.retryableEmpty);
        if (!job.retryRemembered) {
          job.retryRemembered = true;
          var retryScheduled = rememberRetryableEmpty(job.url, job.retryableEmpty);
          job.waitNoteState = retryReason === 'pace_deferred' ? 'held' :
            (retryReason === 'offline' || retryReason === 'forum_cooldown' || isForumFloodReason(retryReason) ||
              ARTICLE_ACCESS_CAUSES[retryReason]) ? (retryScheduled ? 'retry' : 'gaveUp') : null;
        }
        updateForumWaitNotes(job, entries, job.waitNoteState, retryReason);
        return;
      }
      clearRetryableEmpty(job.url);
      updateForumWaitNotes(job, entries, null);
      for (var i = 0; i < entries.length; i++) entries[i].container.classList.add('atp-processed');
      return;
    }
    clearRetryableEmpty(job.url);
    updateForumWaitNotes(job, entries, null);
    var best = pickBestArticleEntry(entries);
    var docEl = document.documentElement;
    var beforeScrollY = typeof window.scrollY === 'number' ? window.scrollY : (window.pageYOffset || 0);
    var anchorCompensate = false;
    var beforeHeight = 0;
    if (beforeScrollY > 0 && docEl && typeof docEl.scrollHeight === 'number' &&
        best.container && typeof best.container.getBoundingClientRect === 'function') {
      var targetRect = best.container.getBoundingClientRect();
      if (targetRect.bottom < 0) {
        anchorCompensate = true;
        beforeHeight = docEl.scrollHeight;
      }
    }
    ATPRenderer.injectThumbnails(best.container, data, best.link, job.fetchStartedAt, best.lastViewportVisible, gallery);
    if (anchorCompensate && typeof window.scrollBy === 'function') {
      var afterHeight = docEl.scrollHeight;
      var afterScrollY = typeof window.scrollY === 'number' ? window.scrollY : (window.pageYOffset || 0);
      var deltaH = afterHeight - beforeHeight;
      var scrollAdjusted = afterScrollY - beforeScrollY;
      var uncompensated = deltaH - scrollAdjusted;
      if (deltaH > 0 && uncompensated > 1) {
        window.scrollBy(0, uncompensated);
      }
    }
  }

  function finishArticleCommit(work) {
    work.job.commitQueued = false;
    work.job.commitPromise = null;
    work.resolve();
  }

  function runArticleCommit(work) {
    var commitStartedAt = Date.now();
    // 仅在 DEBUG 日志开启时才做可见性测量，避免每次提交前强制回流
    var debugCommit = Logger.event && (!Logger.isEnabled || Logger.isEnabled('DEBUG'));
    var wasVisible = debugCommit ? isArticleJobVisible(work.job) : undefined;
    try {
      commitArticleResult(work.job, work.summary, work.generation, work.gallery);
    } catch (e) {
      Logger.error('正文提交异常', e && e.message ? e.message : String(e));
    } finally {
      if (debugCommit) {
        Logger.event('article_commit', {
          url: logUrl(work.job.url),
          commitMs: Math.max(0, Date.now() - commitStartedAt),
          queueWaitMs: Math.max(0, commitStartedAt - (work.job.fetchCompletedAt || commitStartedAt)),
          visible: wasVisible,
          images: work.job.data && work.job.data.images ? work.job.data.images.length : 0
        }, 'DEBUG');
      }
    }
    finishArticleCommit(work);
  }

  function scheduleScrollStopCommitFlush() {
    if (scrollStopCommitTimer) return;
    scrollStopCommitTimer = setTimeout(function() {
      scrollStopCommitTimer = null;
      if (articleCommitQueue.length) scheduleArticleCommitFlush();
    }, 180);
  }

  function flushArticleCommitQueue() {
    articleCommitScheduled = false;
    var batchSize = ATPLoadPolicy.getArticleCommitBatchSize(getLoadPolicySettings());
    var processed = 0;
    var activelyScrolling = lastUserScrollAt > 0 && (Date.now() - lastUserScrollAt < 160);
    var deferredAbove = null;
    while (articleCommitQueue.length && processed < batchSize) {
      var work = articleCommitQueue.shift();
      if (activelyScrolling && isJobStrictlyAboveViewport(work.job)) {
        if (!deferredAbove) deferredAbove = [];
        deferredAbove.push(work);
        continue;
      }
      runArticleCommit(work);
      processed++;
    }
    if (deferredAbove && deferredAbove.length) {
      for (var d = deferredAbove.length - 1; d >= 0; d--) {
        articleCommitQueue.unshift(deferredAbove[d]);
      }
      scheduleScrollStopCommitFlush();
    }
    if (articleCommitQueue.length && (!activelyScrolling || articleCommitQueue.length > (deferredAbove ? deferredAbove.length : 0))) {
      scheduleArticleCommitFlush();
    }
  }

  function scheduleArticleCommitFlush() {
    if (articleCommitScheduled) return;
    articleCommitScheduled = true;
    var fired = false;
    var fallbackTimer = setTimeout(run, 50);
    function run() {
      if (fired) return;
      fired = true;
      clearTimeout(fallbackTimer);
      flushArticleCommitQueue();
    }
    if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function enqueueArticleCommit(job, summary, generation) {
    if (job.commitQueued && job.commitPromise) return job.commitPromise;
    var data = job.data;
    var work = { job: job, summary: summary, generation: generation, gallery: null };
    var promise = new Promise(function(resolve) { work.resolve = resolve; });
    job.commitQueued = true;
    job.commitPromise = promise;
    function isCurrent() {
      return job.data === data && isArticleJobCurrent(job, generation) && isArticleCommitCacheCurrent(job);
    }
    function enqueuePrepared(gallery) {
      if (!isCurrent()) {
        finishArticleCommit(work);
        return;
      }
      work.gallery = gallery;
      if (isArticleJobVisible(job)) {
        runArticleCommit(work);
      } else {
        articleCommitQueue.push(work);
        scheduleArticleCommitFlush();
      }
    }
    function onPreparationError(error) {
      Logger.warn('缩略图准备失败', error && error.message ? error.message : String(error));
      finishArticleCommit(work);
    }
    try {
      var preparation = data && data.images.length && ATPRenderer.prepareArticleGallery
        ? ATPRenderer.prepareArticleGallery(data, isCurrent) : null;
      if (preparation) {
        preparation.then(function(gallery) {
          if (gallery) enqueuePrepared(gallery);
          else {
            if (isCurrent()) requestArticleRescan();
            finishArticleCommit(work);
          }
        }).catch(onPreparationError);
      } else enqueuePrepared(null);
    } catch (error) { onPreparationError(error); }
    return promise;
  }

  function makeArticleFetchOutcome(data, retryableEmpty) {
    return {
      data: data || ATPCache.normalizeArticleData(null),
      retryableEmpty: retryableEmpty || null
    };
  }

  async function readArticleCacheForJob(job, cacheState) {
    if (cacheState && ATPCache.isArticleCacheReadCurrent(cacheState)) return cacheState;
    if (job.prefetchedCacheState && ATPCache.isArticleCacheReadCurrent(job.prefetchedCacheState)) {
      return job.prefetchedCacheState;
    }
    if (job.cachePrefetchPromise) {
      var prefetched = await job.cachePrefetchPromise;
      if (prefetched && ATPCache.isArticleCacheReadCurrent(prefetched)) {
        job.prefetchedCacheState = prefetched;
        return prefetched;
      }
    }
    if (typeof ATPCache.getArticleCacheState === 'function') {
      return ATPCache.getArticleCacheState(job.url);
    }
    if (typeof ATPCache.getCachedArticleData === 'function') {
      var fallbackData = await ATPCache.getCachedArticleData(job.url);
      return fallbackData ? { cached: fallbackData, negative: false, negativeExpiresAt: 0 } : null;
    }
    return null;
  }

  function getCachedArticleOutcome(cacheState) {
    if (!cacheState || !ATPCache.isArticleCacheReadCurrent(cacheState)) return null;
    if (cacheState.cached) return makeArticleFetchOutcome(cacheState.cached, null);
    if (!cacheState.negative || cacheState.negativeExpiresAt <= Date.now()) return null;
    var outcome = makeArticleFetchOutcome(null, makeRetryableEmptyInfo('negative_cache', cacheState.negativeExpiresAt));
    outcome.cacheState = cacheState;
    return outcome;
  }

  async function fetchCrossOriginArticle(job, generation, cacheState) {
    cacheState = await readArticleCacheForJob(job, cacheState);
    if (!isArticleJobCurrent(job, generation)) return null;
    var cachedOutcome = getCachedArticleOutcome(cacheState);
    if (cachedOutcome) return cachedOutcome;
    var data = await ATPFetcher.fetchArticleDataByBackground(job.url, makeArticlePaceOptions(job, generation));
    if (data && data.aborted) return { aborted: true };
    if (!isArticleJobCurrent(job, generation)) return null;
    if (!data && isNetworkOffline()) return makeArticleFetchOutcome(null, makeRetryableEmptyInfo('offline', 0));
    if (!data) return makeArticleFetchOutcome(null, makeRetryableEmptyInfo('background_timeout', 0));
    if (hasArticlePayload(data)) {
      if (!data.cachedByBackground) {
        ATPCache.setCachedArticleData(job.url, data, !data.partial, job.fetchStartedAt);
      }
      return makeArticleFetchOutcome(data, null);
    }
    if (data.retryableEmpty) {
      return makeArticleFetchOutcome(data, makeRetryableEmptyInfo(data.emptyReason || 'background_retryable', data.retryAfter));
    }
    if (data.partial) {
      return makeArticleFetchOutcome(data, makeRetryableEmptyInfo(data.emptyReason || 'partial_empty', data.retryAfter));
    }
    if (shouldNegativeCacheEmptyReason(data.emptyReason || '')) ATPCache.setNegativeCache(job.url, job.fetchStartedAt);
    return makeArticleFetchOutcome(data, null);
  }

  async function fetchArticleJob(job, generation, cacheState) {
    if (!job.fetchStartedAt) job.fetchStartedAt = Date.now();
    if (!job.sameOrigin) return await fetchCrossOriginArticle(job, generation, cacheState);
    try {
      cacheState = await readArticleCacheForJob(job, cacheState);
      if (!isArticleJobCurrent(job, generation)) return null;
      var cachedOutcome = getCachedArticleOutcome(cacheState);
      if (cachedOutcome) return cachedOutcome;
      var paceOptions = makeArticlePaceOptions(job, generation);
      paceOptions.cacheState = cacheState;
      var result = await fetchSameOriginArticle(job.url, paceOptions);
      var data = result && result.data;
      if (data && data.aborted) return { aborted: true };
      if (!data || !isArticleJobCurrent(job, generation)) return null;
      if (!ATPCache.isArticleCacheReadCurrent(data.cacheState || data)) {
        requestArticleRescan();
        return null;
      }
      if (data.retryableEmpty) {
        var outcome = makeArticleFetchOutcome(data, makeRetryableEmptyInfo(data.emptyReason || 'same_origin_retryable', data.retryAfter));
        outcome.cacheState = data.cacheState;
        return outcome;
      }
      if (!hasArticlePayload(data) && data.partial) {
        return makeArticleFetchOutcome(data, makeRetryableEmptyInfo(data.emptyReason || 'partial_empty', data.retryAfter));
      }
      return makeArticleFetchOutcome(data, null);
    } catch (e) {
      if (job.abortedForVisible || (job.abortController && job.abortController.signal.aborted)) {
        return { aborted: true };
      }
      if (!isArticleJobCurrent(job, generation)) return null;
      Logger.warn('同源文章抓取异常', logUrl(job.url));
      return await fetchCrossOriginArticle(job, generation);
    }
  }

  async function processContainers(containers, generation) {
    if (!isArticleScanCurrent(generation)) return;
    var summary = { articles: 0, images: 0, resources: 0, sameOrigin: 0, crossOrigin: 0 };
    var jobs = [];
    var jobCursor = 0;
    var queuedCount = 0;
    var jobsByKey = {};
    var commitPromises = [];
    // Offscreen jobs waiting for the forum pacer (at most one while no request
    // could start) and the workers idling until then without a job.
    var parkedOffscreen = 0;
    // Admitted jobs whose pacer turn has not come yet (reading the cache or
    // waiting); the pacer cannot see the ones that have not queued yet.
    var awaitingTurn = 0;
    // Workers holding a job; idle workers wait at the gate while any do,
    // so a scroll can still hand them rows that came on screen.
    var busyWorkers = 0;
    var gateWaiters = [];
    var inflightJobs = new Set();
    var workerCount = getArticleFetchConcurrency();

    function queuedJobCount() {
      return queuedCount;
    }

    function normalizeBatchCacheEntry(raw) {
      if (!raw || typeof raw !== 'object') return null;
      if (Object.prototype.hasOwnProperty.call(raw, 'cached') ||
          Object.prototype.hasOwnProperty.call(raw, 'negative')) {
        return raw;
      }
      if (Array.isArray(raw.images) || raw.resources) {
        return { cached: raw, negative: false, negativeExpiresAt: 0 };
      }
      return null;
    }

    function prefetchQueuedJobsCache() {
      if (!window.ATPCache || typeof ATPCache.getCachedArticlesBatch !== 'function') return;
      var batchJobs = [];
      var batchUrls = [];
      for (var i = jobCursor; i < jobs.length; i++) {
        var candidateJob = jobs[i];
        if (candidateJob.state !== 'queued' || candidateJob.cachePrefetchPromise || candidateJob.prefetchedCacheState) continue;
        batchJobs.push(candidateJob);
        batchUrls.push(candidateJob.url);
      }
      if (!batchUrls.length) return;
      var sharedPromise = null;
      try {
        sharedPromise = Promise.resolve(ATPCache.getCachedArticlesBatch(batchUrls)).catch(function() { return null; });
      } catch (e) {
        return;
      }
      for (var j = 0; j < batchJobs.length; j++) {
        (function(targetJob) {
          targetJob.cachePrefetchPromise = sharedPromise.then(function(batchMap) {
            if (!batchMap || typeof batchMap !== 'object') return null;
            var hit = Object.prototype.hasOwnProperty.call(batchMap, targetJob.key)
              ? batchMap[targetJob.key]
              : batchMap[targetJob.url];
            var normalized = normalizeBatchCacheEntry(hit);
            if (normalized && (!ATPCache.isArticleCacheReadCurrent || ATPCache.isArticleCacheReadCurrent(normalized))) {
              targetJob.prefetchedCacheState = normalized;
              return normalized;
            }
            return null;
          });
        })(batchJobs[j]);
      }
    }

    function getArticleJobBand(job) {
      var distance = getArticleJobViewportDistance(job);
      if (distance === 0) return 0;
      var prefetchDist = getArticlePrefetchDistance();
      if (distance <= prefetchDist) return distance <= prefetchDist * 0.5 ? 1 : 2;
      return 3;
    }

    function hasActiveVisibleArticleWork() {
      if (articleVisibleBoostRequested || hasQueuedVisibleJob()) return true;
      var iter = inflightJobs.values();
      var step = iter.next();
      while (!step.done) {
        var activeJob = step.value;
        if (activeJob && isArticleJobVisible(activeJob)) return true;
        step = iter.next();
      }
      return false;
    }

    function notifyTextQueueIfVisibleArticleIdle() {
      if (!hasActiveVisibleArticleWork() && window.ATPRenderer && typeof ATPRenderer.wakeAutomaticTextResourceQueue === 'function') {
        ATPRenderer.wakeAutomaticTextResourceQueue();
      }
    }

    function preemptFarOffscreenForVisible() {
      if (busyWorkers < workerCount || gateWaiters.length) return;
      if (!articleVisibleBoostRequested && !hasQueuedVisibleJob()) return;
      var iter = inflightJobs.values();
      var step = iter.next();
      while (!step.done) {
        var runningJob = step.value;
        if (runningJob && runningJob.abortController && !runningJob.abortController.signal.aborted &&
            getArticleJobBand(runningJob) === 3) {
          runningJob.abortedForVisible = true;
          runningJob.abortController.abort();
          break;
        }
        step = iter.next();
      }
    }

    function addEntryToJob(job, entry) {
      for (var i = 0; i < job.entries.length; i++) {
        if (job.entries[i] === entry || job.entries[i].container === entry.container) return;
      }
      job.entries.push(entry);
      if (job.state === 'done') commitPromises.push(enqueueArticleCommit(job, summary, generation));
      else if (job.waitNoteState === 'held' && isLiveCommitEntry(entry, job.url)) updateForumWaitNotes(job, [entry], 'held');
    }

    function enqueueContainers(nextContainers, retry) {
      for (var i = 0; i < nextContainers.length; i++) {
        var entry = nextContainers[i];
        var url = entry && entry.link && entry.link.href;
        if (!url || ATPScanner.shouldExcludeUrl(url) || !ATPScanner.isArticlePageUrl(url) || !isArticleUrlInPageZone(url)) continue;
        var key = getArticleGroupKey(url);
        var existing = jobsByKey[key];
        if (existing && (!retry || existing.state !== 'done')) {
          addEntryToJob(existing, entry);
          if (retry && existing.state === 'queued') {
            var queuedIndex = jobs.indexOf(existing, jobCursor);
            if (queuedIndex > jobCursor) {
              jobs.splice(queuedIndex, 1);
              jobs.splice(jobCursor, 0, existing);
            }
          }
          continue;
        }
        var job = {
          key: key,
          url: url,
          waitNoteId: ++forumWaitJobSequence,
          entries: [entry],
          sameOrigin: isSameOriginUrl(url),
          state: 'queued',
          data: null,
          retryableEmpty: null,
          fetchStartedAt: 0,
          paceWaitMs: 0,
          commitQueued: false,
          commitPromise: null,
          summaryCounted: false,
          retryRemembered: false,
          createdAt: Date.now(),
          fetchCompletedAt: 0
        };
        jobsByKey[key] = job;
        if (retry) jobs.splice(jobCursor, 0, job);
        else jobs.push(job);
        queuedCount++;
      }
    }

    // Rows on screen right now, found by a short scan from the first visible
    // row; they join the queue beyond the high watermark.
    function boostVisibleJobs() {
      if (!articleVisibleBoostRequested) return;
      articleVisibleBoostRequested = false;
      if (!ATPScanner.detectArticleContainers) return;
      var settings = window.ATPState && window.ATPState.settings;
      var scanContext = createProcessScanContext();
      var vh = window.innerHeight || document.documentElement.clientHeight || 800;
      var limit = Math.max(4, getArticleFetchConcurrency() * 2);
      var found = ATPScanner.detectArticleContainers({
        limit: limit,
        nodeBudget: limit * 4,
        scanState: {},
        seekViewportStart: true,
        viewportTop: 0,
        skipServiceThreads: !settings || settings.skipServiceThreads !== false,
        accept: function(entry) {
          var el = entry && entry.container;
          if (!el || !el.getBoundingClientRect) return false;
          var rect = el.getBoundingClientRect();
          if (rect.bottom < 0 || rect.top > vh) return false;
          var known = entry.link && entry.link.href ? jobsByKey[getArticleGroupKey(entry.link.href)] : null;
          if (known && jobHasContainer(known, el)) return false;
          return isProcessCandidate(entry, scanContext);
        }
      });
      if (found.length) enqueueContainers(found);
      // A full batch may have left rows on screen unqueued: look again on the
      // next turn (rows with a job no longer count, so this ends).
      if (found.length >= limit) articleVisibleBoostRequested = true;
    }

    function jobHasContainer(job, container) {
      for (var i = 0; i < job.entries.length; i++) {
        if (job.entries[i].container === container) return true;
      }
      return false;
    }

    function notifyArticleGate() {
      var waiting = gateWaiters;
      gateWaiters = [];
      for (var i = 0; i < waiting.length; i++) waiting[i]();
    }

    function waitArticleGate() {
      if (articleVisibleBoostRequested || !isArticleScanCurrent(generation) || !busyWorkers) {
        return Promise.resolve();
      }
      return new Promise(function(resolve) {
        var finished = false;
        var timer = setTimeout(finish, 1000);
        function finish() {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          var index = gateWaiters.indexOf(finish);
          if (index !== -1) gateWaiters.splice(index, 1);
          resolve();
        }
        gateWaiters.push(finish);
      });
    }

    function releaseParkedJob(job) {
      var released = false;
      job.waitingPaceOptions = null;
      if (job.awaitingTurn) {
        job.awaitingTurn = false;
        awaitingTurn = Math.max(0, awaitingTurn - 1);
        released = true;
      }
      if (job.parkedOffscreen) {
        job.parkedOffscreen = false;
        parkedOffscreen = Math.max(0, parkedOffscreen - 1);
        released = true;
      }
      job.onPaceGranted = null;
      if (released) notifyArticleGate();
    }

    function admitJob(job, offscreen) {
      job.awaitingTurn = true;
      awaitingTurn++;
      if (offscreen) {
        job.parkedOffscreen = true;
        parkedOffscreen++;
      }
      job.onPaceGranted = function() { releaseParkedJob(job); };
    }

    // While a job waits for the pacer: one that has gone offscreen takes the
    // free offscreen slot, or gives its worker back so rows now on screen get
    // it instead of waiting behind the reserve.
    function hasQueuedVisibleJob() {
      for (var i = jobCursor; i < jobs.length; i++) {
        if (jobs[i].state === 'queued' && isArticleJobVisible(jobs[i])) return true;
      }
      return false;
    }

    function shouldHandBack(job) {
      if (isArticleJobVisible(job)) return false;
      // Rows on screen need a worker and none is idle: even the waiting
      // offscreen job gives its worker back (with one worker it would
      // otherwise hold rows on screen behind the reserve).
      if (job.parkedOffscreen) return !gateWaiters.length && (articleVisibleBoostRequested || hasQueuedVisibleJob());
      if (parkedOffscreen < 1) {
        job.parkedOffscreen = true;
        parkedOffscreen++;
        return false;
      }
      return true;
    }

    function tryAdmitArticleRequest(job) {
      var pacer = getForumPacer();
      var paced = pacer && typeof pacer.canStartNow === 'function';
      if (isArticleJobVisible(job)) {
        if (paced) admitJob(job, false);
        return true;
      }
      if (workerCount > 1 && busyWorkers >= workerCount) return false;
      if (!paced) return true;
      // canStartNow cannot see jobs still on their way to the pacer.
      if (parkedOffscreen >= 1 && (awaitingTurn || !pacer.canStartNow(pacer.PRIORITY_ARTICLE))) return false;
      admitJob(job, true);
      return true;
    }

    // Keep the last worker available for a cold row that scrolls into view.
    // Cache hits can still use it, and all workers can serve visible rows.
    async function admitArticleJob(job) {
      if (tryAdmitArticleRequest(job)) return { cacheState: job.prefetchedCacheState || null };
      var cacheState = null;
      try {
        cacheState = await readArticleCacheForJob(job, null);
      } catch (e) {
        cacheState = null;
      }
      if (cacheState && ATPCache.isArticleCacheReadCurrent(cacheState) &&
          (cacheState.cached || (cacheState.negative && cacheState.negativeExpiresAt > Date.now()))) {
        return { cacheState: cacheState };
      }
      // The row may have scrolled into view or a worker may have finished
      // during the cache read. Recheck before waiting for the next gate tick.
      return tryAdmitArticleRequest(job) ? { cacheState: cacheState } : null;
    }

    function returnJob(job) {
      job.state = 'queued';
      queuedCount++;
      var index = jobs.indexOf(job);
      if (index !== -1 && index < jobCursor) jobCursor = index;
    }

    function refillJobs() {
      var highWatermark = getArticleQueueHighWatermark();
      var scanPasses = 0;
      while (
        isArticleScanCurrent(generation) &&
        queuedJobCount() < highWatermark &&
        hasMoreProcessCandidates() &&
        scanPasses < highWatermark * 4 + 8
      ) {
        var needed = Math.max(1, highWatermark - queuedJobCount());
        var before = queuedJobCount();
        var detected = detectProcessCandidates(needed);
        if (!detected.length) break;
        enqueueContainers(detected);
        scanPasses++;
        if (queuedJobCount() === before && !hasMoreProcessCandidates()) break;
      }
    }

    // The first queued job on screen, else the queued one nearest the
    // viewport (what the reader reaches next), else page order.
    function takeJob() {
      refillJobs();
      boostVisibleJobs();
      prefetchQueuedJobsCache();
      var pick = -1;
      var bestDistance = Infinity;
      for (var i = jobCursor; i < jobs.length; i++) {
        if (jobs[i].state !== 'queued') continue;
        if (pick === -1) pick = i;
        var distance = getArticleJobViewportDistance(jobs[i]);
        if (distance === 0) {
          pick = i;
          break;
        }
        if (distance < bestDistance) {
          bestDistance = distance;
          pick = i;
        }
      }
      if (pick === -1) return null;
      var job = jobs[pick];
      job.state = 'inflight';
      queuedCount = Math.max(0, queuedCount - 1);
      while (jobCursor < jobs.length && jobs[jobCursor].state !== 'queued') jobCursor++;
      return job;
    }

    function finishArticleJob(job, outcome, cached) {
      if (job.sameOrigin) summary.sameOrigin++;
      else summary.crossOrigin++;
      job.data = outcome.data;
      job.cacheState = outcome.cacheState;
      job.retryableEmpty = outcome.retryableEmpty;
      job.state = 'done';
      job.fetchCompletedAt = Date.now();
      if (Logger.event && (!Logger.isEnabled || Logger.isEnabled('DEBUG'))) {
        Logger.event('article_fetch_done', {
          url: logUrl(job.url),
          sameOrigin: job.sameOrigin,
          queueWaitMs: Math.max(0, job.fetchStartedAt - job.createdAt),
          fetchMs: Math.max(0, job.fetchCompletedAt - job.fetchStartedAt),
          paceWaitMs: job.paceWaitMs || 0,
          cached: cached || undefined,
          images: job.data.images.length,
          resources: SharedUtils.countResources(job.data.resources),
          retryable: !!job.retryableEmpty
        }, 'DEBUG');
      }
      commitPromises.push(enqueueArticleCommit(job, summary, generation));
    }

    // A visible cached row can render while every network worker is busy.
    // A miss stays in the normal priority queue and never starts a request.
    async function checkVisibleArticleCache(job) {
      var startedAt = Date.now();
      var cached = null;
      try {
        if (job.prefetchedCacheState && ATPCache.isArticleCacheReadCurrent(job.prefetchedCacheState)) {
          cached = job.prefetchedCacheState.cached;
          if (!cached) return;
        } else if (job.cachePrefetchPromise) {
          var prefetched = await job.cachePrefetchPromise;
          if (prefetched && ATPCache.isArticleCacheReadCurrent(prefetched)) {
            if (!prefetched.cached) return;
            cached = prefetched.cached;
          }
        }
        if (!cached) cached = await ATPCache.getCachedArticleData(job.url);
      } catch (e) { return; }
      if (!cached || job.state !== 'queued' || !isArticleJobCurrent(job, generation) || !ATPCache.isArticleCacheReadCurrent(cached)) return;
      queuedCount--;
      job.fetchStartedAt = startedAt;
      finishArticleJob(job, { data: cached, retryableEmpty: null }, true);
    }

    function checkWaitingVisibleRows() {
      for (var i = jobCursor; i < jobs.length; i++) {
        var job = jobs[i];
        if (job.state !== 'queued' || job.checkedVisibleCache || !isArticleJobVisible(job)) continue;
        job.checkedVisibleCache = true;
        checkVisibleArticleCache(job);
      }
    }

    function wakeForArticleWork(retryEntries) {
      if (!isArticleScanCurrent(generation)) {
        notifyArticleGate();
        return false;
      }
      if (retryEntries) {
        enqueueContainers(retryEntries, true);
        prefetchQueuedJobsCache();
      }
      if (busyWorkers >= workerCount) {
        boostVisibleJobs();
        prefetchQueuedJobsCache();
        checkWaitingVisibleRows();
      }
      notifyArticleGate();
      return true;
    }

    async function worker() {
      while (isArticleScanCurrent(generation)) {
        var job = takeJob();
        if (!job) {
          notifyTextQueueIfVisibleArticleIdle();
          if (!busyWorkers) break;
          await waitArticleGate();
          continue;
        }
        busyWorkers++;
        if (busyWorkers >= workerCount) {
          checkWaitingVisibleRows();
        }
        var admission = await admitArticleJob(job);
        if (!admission) {
          busyWorkers--;
          if (!busyWorkers) notifyArticleGate();
          if (!isArticleScanCurrent(generation)) return;
          returnJob(job);
          await waitArticleGate();
          continue;
        }
        job.handedBack = false;
        job.abortedForVisible = false;
        job.abortController = typeof AbortController === 'function' ? new AbortController() : null;
        job.shouldHandBack = shouldHandBack;
        job.fetchStartedAt = Date.now();
        inflightJobs.add(job);
        if (Logger.event && (!Logger.isEnabled || Logger.isEnabled('DEBUG'))) {
          Logger.event('article_fetch_start', {
            url: logUrl(job.url),
            sameOrigin: job.sameOrigin,
            queueWaitMs: Math.max(0, job.fetchStartedAt - job.createdAt),
            articleFetchConcurrency: getArticleFetchConcurrency()
          }, 'DEBUG');
        }
        var outcome;
        try {
          outcome = await fetchArticleJob(job, generation, admission.cacheState);
        } catch (e) {
          Logger.warn('正文抓取异常', logUrl(job.url) + ' ' + (e && e.message ? e.message : String(e)));
          outcome = makeArticleFetchOutcome(null, makeRetryableEmptyInfo('transient_exception', 0));
        } finally {
          inflightJobs.delete(job);
          job.abortController = null;
          busyWorkers--;
          job.shouldHandBack = null;
          releaseParkedJob(job);
          notifyArticleGate();
          notifyTextQueueIfVisibleArticleIdle();
        }
        if (!isArticleScanCurrent(generation)) return;
        if (job.handedBack || (outcome && outcome.aborted) || (job.abortedForVisible && (!outcome || !hasArticlePayload(outcome.data)))) {
          job.handedBack = false;
          job.abortedForVisible = false;
          job.fetchStartedAt = 0;
          returnJob(job);
          if (!hasQueuedVisibleJob()) await waitArticleGate();
          continue;
        }
        if (job.offlineDeferred && outcome) {
          outcome = makeArticleFetchOutcome(null, makeRetryableEmptyInfo('offline', 0));
        } else if (job.paceDeferred && outcome) {
          var deferPacer = getForumPacer();
          outcome = makeArticleFetchOutcome(null, makeRetryableEmptyInfo('pace_deferred', deferPacer ? deferPacer.getPauseUntil() : 0));
        }
        if (!outcome) {
          if (jobsByKey[job.key] === job) delete jobsByKey[job.key];
          continue;
        }
        finishArticleJob(job, outcome, false);
      }
      // Idle workers see the run is over and exit too.
      notifyArticleGate();
    }

    enqueueContainers(containers);
    refillJobs();
    prefetchQueuedJobsCache();
    articleDispatchWake = wakeForArticleWork;
    activeVisibleArticleCheck = hasActiveVisibleArticleWork;
    var workers = new Array(workerCount);
    for (var i = 0; i < workerCount; i++) workers[i] = worker();
    try {
      await Promise.all(workers);
    } finally {
      if (articleDispatchWake === wakeForArticleWork) articleDispatchWake = null;
      if (activeVisibleArticleCheck === hasActiveVisibleArticleWork) activeVisibleArticleCheck = null;
      if (window.ATPRenderer && typeof ATPRenderer.wakeAutomaticTextResourceQueue === 'function') {
        ATPRenderer.wakeAutomaticTextResourceQueue();
      }
    }
    await Promise.all(commitPromises);
    if (!isArticleScanCurrent(generation)) return;
    Logger.info('扫描完成', '文章' + summary.articles + ' 图片' + summary.images + ' 资源' + summary.resources + ' (同源' + summary.sameOrigin + '+跨域' + summary.crossOrigin + ')');
    if (Logger.event && (!Logger.isEnabled || Logger.isEnabled('DEBUG'))) {
      Logger.event('scan_complete', {
        articles: summary.articles,
        images: summary.images,
        resources: summary.resources,
        sameOrigin: summary.sameOrigin,
        crossOrigin: summary.crossOrigin
      }, 'INFO');
    }
    if (!summary.images && !summary.resources) {
      Logger.warn('未提取到内容', '同源' + summary.sameOrigin + '跨域' + summary.crossOrigin);
    }
  }

  function detectAndProcess(fromMutation, immediate) {
    if (!ATPConfig.isEnabled() || bfcacheRecoveryPending || startupCancelled) return;
    if (pauseScanningForHiddenPage()) return;
    if (processing) {
      rescanRequested = true;
      return;
    }
    if (scanPending) return;
    var now = Date.now();
    if (!fromMutation && now - lastScanTime < SCAN_THROTTLE_MS) {
      scheduleThrottledScan(SCAN_THROTTLE_MS - (now - lastScanTime) + 20);
      return;
    }
    lastScanTime = now;
    scanPending = true;
    // immediate：调用方已经等过一次定时器 / 本来就没有抖动要合并，再叠一层去抖纯属推迟首图。
    // 保留一帧（16ms）而不是 0：给绘制留窗口，避免候选扫描连成一串不间断的强制布局
    var delay = immediate ? 16 : (fromMutation ? 150 : 300);
    var generation = scanGeneration;
    scanDelayTimer = setTimeout(function() {
      scanDelayTimer = null;
      scanPending = false;
      if (generation !== scanGeneration) return;
      if (!ATPConfig.isEnabled()) return;
      if (pauseScanningForHiddenPage()) return;
      if (processing) {
        rescanRequested = true;
        return;
      }
      processing = true;
      var c = detectProcessCandidates(getArticleQueueHighWatermark());
      if (c.length) {
        processContainers(c, generation).catch(function(e) {
          Logger.error('扫描处理异常', e && e.message ? e.message : String(e));
        }).finally(function() {
          processing = false;
          if (typeof ATPLoader !== 'undefined' && typeof ATPLoader.globalSchedule === 'function') {
            ATPLoader.globalSchedule();
          }
          if (generation !== scanGeneration) {
            if (rescanRequested && ATPConfig.isEnabled()) {
              rescanRequested = false;
              scheduleFollowupScan(0, null);
            }
            return;
          }
          if (rescanRequested) {
            rescanRequested = false;
            scheduleFollowupScan(100, generation);
            return;
          }
          if (hasMoreProcessCandidates()) {
            scheduleFollowupScan(0, generation);
          }
        });
      } else {
        processing = false;
        if (hasMoreProcessCandidates()) {
          scheduleFollowupScan(0, generation);
          return;
        }
        if (rescanRequested) {
          rescanRequested = false;
          scheduleFollowupScan(100, generation);
        }
      }
    }, delay);
  }

  // 隐藏期间容器观察器从未断开（pauseScanningForHiddenPage 只清定时器），
  // 恢复可见 / bfcache 回来时容器多半还是同一个元素，无需拆了重建
  function ensureObserverBound(reason) {
    if (observer && boundContainer) {
      if (!document.contains(boundContainer) || boundContainer.parentNode !== boundContainerParent ||
          ATPScanner.findThreadContainer(true) !== boundContainer) return rebindThreadObserver(reason);
      // Mutation callbacks skip scanning while hidden. Reconcile removals
      // made by the forum in the meantime before scanning the visible list.
      reconcileThreadStates();
      bindScroll();
      Logger.debug('Observer', '容器绑定仍有效，跳过重绑 (' + reason + ')');
      return true;
    }
    return setupObserver(reason);
  }

  function setupObserver(reason) {
    if (!ATPConfig.isEnabled()) return;
    if (pauseScanningForHiddenPage()) return;
    clearObserverRetryTimer(false);
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    boundContainer = null;
    boundContainerParent = null;
    disconnectContainerParentObserver();
    var container = ATPScanner.findThreadContainer(true);
    if (!container || (ATPScanner.hasArticleCandidate && !ATPScanner.hasArticleCandidate(container))) {
      unbindScroll(false);
      observerRetryCount++;
      if (observerRetryCount >= OBSERVER_MAX_RETRIES) {
        // 只在放弃后才武装休眠观察器：重试期间武装会让任意页面变动清零计数、无上限地重开整轮
        setupDormantObserver();
        Logger.warn('Observer', '未找到帖子容器，已重试 ' + OBSERVER_MAX_RETRIES + ' 次放弃 (唤醒 ' +
          dormantRestartCount + '/' + DORMANT_MAX_RESTARTS + (dormantObserver ? '，继续监听)' : '，停止监听)'));
        return false;
      }
      var delay = Math.min(500 * Math.pow(1.5, observerRetryCount - 1), 5000);
      Logger.info('Observer', '未找到帖子容器，' + Math.round(delay) + 'ms 后重试 (' + observerRetryCount + '/' + OBSERVER_MAX_RETRIES + ')');
      observerRetryTimer = setTimeout(function() {
        observerRetryTimer = null;
        // 重试成功时容器行早已在 DOM 中，容器观察器不会补发这批行，必须显式扫一次
        if (setupObserver('retry') === true) detectAndProcess(true);
      }, delay);
      return false;
    }
    disconnectDormantObserver();
    observerRetryCount = 0;
    dormantRestartCount = 0;
    observer = new MutationObserver(function(ms) {
      if (areAllMutationsSelfGenerated(ms)) return;
      if (pauseScanningForHiddenPage()) return;
      if (!document.contains(container)) {
        rebindThreadObserver('Thread container replaced, rebinding');
        return;
      }
      var removedRows = mutationsRemoveThreadRows(ms);
      if (removedRows) reconcileThreadStates();
      if (removedRows || mutationsHaveExternalArticleAdd(ms)) {
        clearProcessCandidateQueue();
        detectAndProcess(true);
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    boundContainer = container;
    boundContainerParent = container.parentNode;
    setupContainerParentObserver(container);
    bindScroll();
    Logger.info('Observer', '已绑定到 ' + (container.id || container.className || container.tagName) + ' [' + (reason || 'unknown') + ']');
    return true;
  }

  function removeNodes(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].remove();
    }
  }

  function removeClassFromNodes(nodes, className) {
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.remove(className);
    }
  }

  function clearThumbnailDom() {
    if (typeof ATPLoader !== 'undefined' && typeof ATPLoader.teardownActiveSlots === 'function') {
      ATPLoader.teardownActiveSlots('clear_dom');
    }
    var panels = document.querySelectorAll('.atp-thread-panel');
    removeNodes(panels);

    var rows = document.querySelectorAll('.atp-thumb-row');
    removeNodes(rows);

    var containers = document.querySelectorAll('.atp-processed');
    removeClassFromNodes(containers, 'atp-processed');

    removeNodes(document.querySelectorAll('.' + FORUM_WAIT_NOTE_CLASS));
    clearedForumWaitJob = forumWaitJobSequence;
    forumWaitJobByLink = new WeakMap();

    if (window.ATPState) {
      window.ATPState.threads = {};
    }
    emptyRetryAfterByUrl = {};
    emptyRetryAttemptsByUrl = {};
    emptyRetryGivenUp = {};
    emptyRetryClassAttempts = {};
    emptyRetryPaceBound = {};
    offlineArticleRetries.clear();

    if (window.ATPViewport) {
      ATPViewport.destroy();
    }
    if (window.ATPResourcePanel) {
      ATPResourcePanel.destroy();
    }
    if (window.ATPPreviewer && typeof ATPPreviewer.close === 'function') {
      ATPPreviewer.close();
    }
  }

  function bindScroll() {
    if (scrollBound) return;
    window.addEventListener('scroll', handleScrollScan, { passive: true });
    scrollBound = true;
  }

  function unbindScroll(clearAllTimers) {
    if (scrollBound) {
      window.removeEventListener('scroll', handleScrollScan);
    }
    if (clearAllTimers !== false) {
      clearScanTimers();
    } else if (scrollScanTimer) {
      clearTimeout(scrollScanTimer);
      scrollScanTimer = null;
    }
    scrollBound = false;
  }

  // The running article scan (if any) is woken after a scroll: rows that came
  // on screen join its queue ahead of offscreen ones and take the next
  // forum turn.
  var articleDispatchWake = null;
  var articleVisibleBoostRequested = false;

  // A manual pacer reset lifts any pause at once: threads held for it are due.
  window.addEventListener('atp-forum-pacer-reset', function() {
    if (!ATPConfig.isEnabled() || !hasPaceBoundRetries()) return;
    scheduleRetryScanAt(Date.now());
  });
  window.addEventListener('atp-forum-pacer-reset', function() {
    if (articleDispatchWake) articleDispatchWake();
  });

  window.ATPArticleWork = {
    isBusy: function() { return processing; },
    isVisibleBusy: function() { return !!(processing && activeVisibleArticleCheck && activeVisibleArticleCheck()); }
  };

  function requestArticleVisibleBoost() {
    articleVisibleBoostRequested = true;
    if (articleDispatchWake) articleDispatchWake();
  }

  function handleScrollScan() {
    lastUserScrollAt = Date.now();
    if (pauseScanningForHiddenPage()) return;
    if (scrollScanTimer) return;
    scrollScanTimer = setTimeout(function() {
      scrollScanTimer = null;
      if (pauseScanningForHiddenPage()) return;
      keepUnconsumedQueuedProcessCandidates();
      requestArticleVisibleBoost();
      detectAndProcess();
    }, 180);
  }

  function reloadThumbnails() {
    Logger.info('热重载', '开始清理缩略图');
    flushPendingData(); // 先落地挂起的缓存写回，再 bump 代际清理 threadStates
    bumpScanGeneration();
    rescanRequested = false;
    clearScanTimers();
    if (typeof ATPLoader !== 'undefined') {
      ATPLoader.pause();
      if (typeof ATPLoader.resetActiveImageSlots === 'function') ATPLoader.resetActiveImageSlots('reload');
      if (typeof ATPLoader.clearBgTimer === 'function') ATPLoader.clearBgTimer();
      if (typeof ATPLoader.clearBgTasks === 'function') ATPLoader.clearBgTasks();
      if (typeof ATPLoader.removeGlobalVisListener === 'function') ATPLoader.removeGlobalVisListener();
    }
    flushPendingData();
    clearThumbnailDom();

    syncLoaderVisibilityPauseState();
    Logger.info('热重载', '完成，重新扫描');
    detectAndProcess(true);
  }

  function disableCurrentPage() {
    if (window.ATPForumEntry) window.ATPForumEntry.cancel();
    forumEntryOnly = false;
    Logger.info('停用', '清理当前页');
    flushPendingData(); // 先落地挂起的缓存写回，再 bump 代际清理 threadStates
    bumpScanGeneration();
    if (typeof ATPLoader !== 'undefined') {
      ATPLoader.pause();
      if (typeof ATPLoader.resetActiveImageSlots === 'function') ATPLoader.resetActiveImageSlots('disable');
      ATPLoader.clearBgTimer();
      if (typeof ATPLoader.removeGlobalVisListener === 'function') {
        ATPLoader.removeGlobalVisListener();
      }
    }
    if (typeof ATPLoader !== 'undefined' && typeof ATPLoader.clearBgTasks === 'function') {
      ATPLoader.clearBgTasks();
    }
    flushPendingData();
    Logger.flush();
    Logger.stopFlushTimer();
    if (observerRetryTimer) {
      clearTimeout(observerRetryTimer);
      observerRetryTimer = null;
    }
    observerRetryCount = 0;
    dormantRestartCount = 0;
    clearThumbnailDom();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    boundContainer = null;
    boundContainerParent = null;
    disconnectContainerParentObserver();
    disconnectDormantObserver();
    unbindScroll();
    if (window.__bfpPanel && typeof window.__bfpPanel.destroy === 'function') {
      window.__bfpPanel.destroy();
      window.__bfpPanel = null;
    }
    if (window.ATPPreviewer && typeof ATPPreviewer.close === 'function') {
      ATPPreviewer.close();
    }
    if (window.ATPResourcePanel && typeof ATPResourcePanel.destroy === 'function') {
      ATPResourcePanel.destroy();
    }
  }

  function enableCurrentPage() {
    forumEntryOnly = !!(window.ATPForumEntry && window.ATPForumEntry.handlePage(ATPConfig.settings.autoEnterAgeGate));
    if (forumEntryOnly) {
      rescanRequested = false;
      return;
    }
    Logger.startFlushTimer();
    syncLoaderVisibilityPauseState();
    // 启用入口没有 mutation 抖动要合并，去抖只会把首图往后推 150ms
    detectAndProcess(true, true);
    setupObserver('enable');
    initFloatPanel();
  }

  function removeStaleFloatPanelRoot() {
    if (!document || typeof document.getElementById !== 'function') return true;
    var staleRoot = document.getElementById('bfp-root');
    if (!staleRoot) return true;
    try {
      if (typeof staleRoot.remove === 'function') {
        staleRoot.remove();
      } else if (staleRoot.parentNode && typeof staleRoot.parentNode.removeChild === 'function') {
        staleRoot.parentNode.removeChild(staleRoot);
      }
    } catch (e) {
      console.warn('[ATP] stale floating panel root cleanup failed:', e && e.message ? e.message : e);
      return false;
    }
    if (document.getElementById('bfp-root') === staleRoot) {
      console.warn('[ATP] stale floating panel root still attached');
      return false;
    }
    return true;
  }

  function readMarkedExportText() {
    return new Promise(function(resolve) {
      if (!window.ATPMarks || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve({ ok: false, count: 0, text: '' });
        return;
      }
      try {
        chrome.storage.local.get(ATPMarks.KEYS.INDEX, function(idxData) {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve({ ok: false, count: 0, text: '' });
            return;
          }
          var index = ATPMarks.readIndex(idxData && idxData[ATPMarks.KEYS.INDEX]);
          if (!index.items.length) {
            resolve({ ok: true, count: 0, text: '', ids: [], snapshots: [] });
            return;
          }
          var itemKeys = [];
          for (var i = 0; i < index.items.length; i++) {
            itemKeys.push(ATPMarks.itemKey(index.items[i].id));
          }
          chrome.storage.local.get(itemKeys, function(recData) {
            if (chrome.runtime && chrome.runtime.lastError) {
              resolve({ ok: false, count: 0, text: '' });
              return;
            }
            var records = [];
            var ids = [];
            var snapshots = [];
            for (var k = 0; k < index.items.length; k++) {
              var id = index.items[k].id;
              var rawRec = recData && recData[ATPMarks.itemKey(id)];
              var sanitized = ATPMarks.sanitizeSnapshot(rawRec, true);
              if (sanitized) {
                var merged = ATPMarks.mergeRecord(null, sanitized, rawRec.markedAt || Date.now()).record;
                merged.markedAt = rawRec.markedAt || merged.markedAt;
                merged.updatedAt = rawRec.updatedAt || merged.updatedAt;
                records.push(merged);
                ids.push(id);
                snapshots.push(ATPMarks.recordToSnapshot(merged));
              }
            }
            if (!records.length) {
              resolve({ ok: true, count: 0, text: '', ids: [], snapshots: [] });
              return;
            }
            var version = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '';
            var text = ATPMarks.formatExport(records, { now: Date.now(), version: version });
            resolve({ ok: true, count: records.length, text: text, ids: ids, snapshots: snapshots });
          });
        });
      } catch (e) {
        resolve({ ok: false, count: 0, text: '' });
      }
    });
  }

  function copyPlainTextInPage(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function() { return true; }).catch(function() {
        return fallbackExecCopy(text);
      });
    }
    return Promise.resolve(fallbackExecCopy(text));
  }

  function fallbackExecCopy(text) {
    var ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      if (ta.parentNode) ta.remove();
      return !!ok;
    } catch (e) {
      if (ta && ta.parentNode) ta.remove();
      return false;
    }
  }

  function notifyMarksExportEvent(op, info) {
    if (!info || !info.ids || !info.ids.length || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    try {
      chrome.runtime.sendMessage({
        type: SharedUtils.MESSAGE_TYPES.MARKS_MUTATION,
        op: op,
        ids: info.ids,
        snapshots: info.snapshots
      }, function() {});
    } catch (e) {}
  }

  function buildLivePageStatus() {
    var loaderStats = (typeof ATPLoader !== 'undefined' && typeof ATPLoader.getLivePageStats === 'function')
      ? ATPLoader.getLivePageStats()
      : null;
    var threads = window.ATPState && window.ATPState.threads;
    var fallbackTotalThreads = 0;
    var fallbackLoadedThreads = 0;
    var fallbackFailedImages = 0;
    if (!loaderStats && threads) {
      for (var tid in threads) {
        var ts = threads[tid];
        if (!ts) continue;
        fallbackTotalThreads++;
        if (ts.firstScreenDone || !ts.firstScreenTotal) fallbackLoadedThreads++;
        fallbackFailedImages += Number(ts.failedCount) || 0;
      }
    }
    var pacer = getForumPacer();
    var paceState = pacer && typeof pacer.getState === 'function' ? pacer.getState() : null;
    var now = Date.now();
    var pacerText = '正常';
    if (paceState) {
      if (paceState.pauseUntil && paceState.pauseUntil > now) {
        pacerText = '冷却 ' + Math.max(1, Math.ceil((paceState.pauseUntil - now) / 1000)) + 's';
      } else if (paceState.queued > 0) {
        pacerText = '排队 ' + paceState.queued;
      }
    }
    var markedCount = (window.ATPResourcePanel && typeof ATPResourcePanel.getMarkedCount === 'function')
      ? ATPResourcePanel.getMarkedCount()
      : 0;
    var allExpanded = !!(window.ATPRenderer && typeof ATPRenderer.areAllThreadsExpanded === 'function' && ATPRenderer.areAllThreadsExpanded());
    return {
      paused: manualPagePaused || !!(loaderStats && loaderStats.paused),
      activeLoads: loaderStats ? (Number(loaderStats.activeLoads) || 0) : 0,
      queuedImages: loaderStats ? (Number(loaderStats.queuedImages) || 0) : 0,
      loadedThreads: loaderStats ? (Number(loaderStats.loadedThreads) || 0) : fallbackLoadedThreads,
      totalThreads: loaderStats ? (Number(loaderStats.totalThreads) || 0) : fallbackTotalThreads,
      failedImages: loaderStats ? (Number(loaderStats.failedImages) || 0) : fallbackFailedImages,
      markedCount: markedCount,
      pacerText: pacerText,
      allExpanded: allExpanded
    };
  }

  function initFloatPanel() {
    if (window.__bfpPanel) return;
    if (typeof FloatingPanel === 'undefined') {
      console.error('[ATP] FloatingPanel not loaded');
      return;
    }
    if (typeof SETTINGS_SCHEMA === 'undefined') {
      console.error('[ATP] SETTINGS_SCHEMA not loaded');
      return;
    }
    if (!removeStaleFloatPanelRoot()) return;
    try {
      var panel = new FloatingPanel({
        title: '缩略图预览',
        settingsSchema: SETTINGS_SCHEMA,
        initialSettings: ATPConfig.settings,
        business: {
          onSettingsChange: function(newSettings, meta) {
            var wasEnabled = ATPConfig.isEnabled();
            var previousSettings = ATPConfig.settings || {};
            var nextSettings = ATPNormalizeSettings(Object.assign({}, ATPConfig.settings || {}, newSettings));
            var nextSig = getSettingsSignature(nextSettings);
            if (nextSig && nextSig === lastAppliedSettingsSignature && wasEnabled === (nextSettings.enabled !== false)) {
              return;
            }
            var reloadNeeded = needsSettingsReload(previousSettings, nextSettings);
            ATPConfig.settings = nextSettings;
            lastAppliedSettingsSignature = nextSig;
            if (!window.ATPState) window.ATPState = {};
            window.ATPState.settings = ATPConfig.settings;
            if (Logger.setDebugEnabled) Logger.setDebugEnabled(nextSettings.debugLogging === true);
            var nowEnabled = ATPConfig.isEnabled();
            if (!nowEnabled) {
              disableCurrentPage();
            } else if (!wasEnabled) {
              enableCurrentPage();
            } else if (reloadNeeded) {
              reloadThumbnails();
            } else {
              applyLiveSettings(previousSettings, nextSettings);
            }
          },
          getPageStatus: function() {
            return buildLivePageStatus();
          },
          onTogglePause: function() {
            manualPagePaused = !manualPagePaused;
            if (typeof ATPLoader !== 'undefined') {
              if (manualPagePaused && typeof ATPLoader.pause === 'function') {
                ATPLoader.pause();
              } else if (!manualPagePaused && typeof ATPLoader.resume === 'function') {
                ATPLoader.resume();
                if (!processing) detectAndProcess(true, true);
              }
            }
            return { paused: manualPagePaused };
          },
          onRetryFailed: function() {
            var retried = (typeof ATPLoader !== 'undefined' && typeof ATPLoader.retryAllFailedImages === 'function')
              ? ATPLoader.retryAllFailedImages()
              : 0;
            return { retried: Number(retried) || 0 };
          },
          onToggleExpandAll: function() {
            var currentExpanded = !!(window.ATPRenderer && typeof ATPRenderer.areAllThreadsExpanded === 'function' && ATPRenderer.areAllThreadsExpanded());
            var nextExpanded = !currentExpanded;
            if (window.ATPRenderer && typeof ATPRenderer.setAllThreadsExpanded === 'function') {
              return ATPRenderer.setAllThreadsExpanded(nextExpanded);
            }
            return { expanded: nextExpanded, count: 0 };
          },
          onCopyMarked: function() {
            return readMarkedExportText().then(function(info) {
              if (!info.ok || !info.count || !info.text) return { ok: false, count: 0 };
              return copyPlainTextInPage(info.text).then(function(copied) {
                if (copied) notifyMarksExportEvent('copied_marks', info);
                return { ok: !!copied, count: copied ? info.count : 0 };
              });
            });
          },
          onExportMarked: function() {
            return readMarkedExportText().then(function(info) {
              if (!info.ok || !info.count || !info.text) return { ok: false, count: 0 };
              try {
                var blob = new Blob([info.text], { type: 'text/plain;charset=utf-8' });
                var blobUrl = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = blobUrl;
                a.download = 'marked-resources-' + ATPMarks.formatDate(Date.now()) + '.txt';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 2000);
                notifyMarksExportEvent('exported', info);
                return { ok: true, count: info.count };
              } catch (e) {
                return { ok: false, count: 0 };
              }
            });
          }
        }
      });
      window.__bfpPanel = panel;
      if (ATPConfig.settings && ATPConfig.settings.showFloatingLauncher === false) {
        if (typeof panel.setLauncherVisible === 'function') {
          panel.setLauncherVisible(false);
        } else if (typeof document !== 'undefined' && document.getElementById) {
          var bfpRoot = document.getElementById('bfp-root');
          if (bfpRoot && bfpRoot.style) bfpRoot.style.display = 'none';
        }
      }
    } catch (e) {
      console.error('[ATP] initFloatPanel failed:', e);
    }
  }

  function addSettingsChangedListener() {
    if (settingsListenerInstalled) return;
    chrome.storage.onChanged.addListener(handleSettingsChanged);
    settingsListenerInstalled = true;
  }

  function removeSettingsChangedListener() {
    if (!settingsListenerInstalled) return;
    chrome.storage.onChanged.removeListener(handleSettingsChanged);
    settingsListenerInstalled = false;
  }

  function cleanupFailedStartup() {
    initialized = false;
    clearScanTimers();
    clearObserverRetryTimer();
    clearProcessCandidateQueue();
    removeSettingsChangedListener();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    disconnectContainerParentObserver();
    disconnectDormantObserver();
    unbindScroll();
    if (Logger.stopFlushTimer) Logger.stopFlushTimer();
  }

  async function init() {
    if (initialized || initInFlight) return;
    initInFlight = true;
    startupCancelled = false;
    try {
      Logger.info('插件启动', chrome.runtime.getManifest().version + ' ' + location.hostname);
      if (Logger.event) {
        Logger.event('content_start', {
          version: chrome.runtime.getManifest().version,
          host: location.hostname,
          url: Logger.sanitizeUrl ? Logger.sanitizeUrl(location.href) : location.href
        }, 'INFO');
      }
      initATPState();
      if (ATPConfig._hydratesForumPacer) ATPConfig.getSettings();
      prewarmInitialVisibleCandidates();
      await ATPConfig.getSettings();
      lastAppliedSettingsSignature = getSettingsSignature(ATPConfig.settings);
      if (Logger.setDebugEnabled) Logger.setDebugEnabled(ATPConfig.settings && ATPConfig.settings.debugLogging === true);
      logDiagnosticConfig(ATPConfig.settings, 'startup');
      if (startupCancelled) return;
      addSettingsChangedListener();
      initialized = true;
      if (ATPConfig.isEnabled()) enableCurrentPage();
      else if (window.ATPForumEntry) window.ATPForumEntry.cancel();
    } catch (e) {
      cleanupFailedStartup();
      Logger.error('插件启动失败', e && e.message ? e.message : String(e || '未知错误'));
      return;
    } finally {
      initInFlight = false;
    }
  }

  function handleSettingsChanged(changes, areaName) {
    if (areaName === 'local' && changes.settings) {
      var wasEnabled = ATPConfig.isEnabled();
      var previousSettings = ATPConfig.settings || {};
      var nextSettings = ATPNormalizeSettings(Object.assign({}, ATPConfig.settings || {}, changes.settings.newValue));
      var nextSig = getSettingsSignature(nextSettings);
      if (nextSig && nextSig === lastAppliedSettingsSignature && wasEnabled === (nextSettings.enabled !== false)) {
        if (window.__bfpPanel && typeof window.__bfpPanel.setSettings === 'function') {
          window.__bfpPanel.setSettings(ATPConfig.settings);
        }
        return;
      }
      var reloadNeeded = needsSettingsReload(previousSettings, nextSettings);
      ATPConfig.settings = nextSettings;
      lastAppliedSettingsSignature = nextSig;
      if (!window.ATPState) window.ATPState = {};
      window.ATPState.settings = ATPConfig.settings;
      if (Logger.setDebugEnabled) Logger.setDebugEnabled(nextSettings.debugLogging === true);
      logDiagnosticConfig(nextSettings, 'settings_change');
      var nowEnabled = ATPConfig.isEnabled();
      if (window.__bfpPanel && typeof window.__bfpPanel.setSettings === 'function') {
        window.__bfpPanel.setSettings(ATPConfig.settings);
      }
      Logger.info('设置变更', '外部更新');
      if (!nowEnabled) {
        disableCurrentPage();
      } else if (!wasEnabled) {
        enableCurrentPage();
      } else if (forumEntryOnly) {
        if (previousSettings.autoEnterAgeGate !== nextSettings.autoEnterAgeGate) enableCurrentPage();
      } else if (!reloadNeeded) {
        applyLiveSettings(previousSettings, nextSettings);
      }
      if (nowEnabled && wasEnabled && reloadNeeded && !forumEntryOnly) {
        reloadThumbnails();
      }
    }
  }

  var loadInitTimer = null;

  function scheduleInit() {
    if (initialized || initInFlight || loadInitTimer) return;
    loadInitTimer = setTimeout(function() {
      loadInitTimer = null;
      init();
    }, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInit, { once: true });
  } else {
    scheduleInit();
  }
  window.addEventListener('load', scheduleInit);

  function flushPendingData() {
    ATPCache.clearFlushTimer();
    ATPCache.flushCacheNow();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      flushPendingData();
      Logger.flush();
      if (!forumEntryOnly) pauseScanningForHiddenPage();
    } else if (forumEntryOnly) {
      return;
    } else if (bfcacheRecoveryPending && ATPConfig.isEnabled()) {
      resumeFromBfcache();
    } else if ((releaseOfflineArticleRetries() || rescanRequested) && ATPConfig.isEnabled()) {
      rescanRequested = false;
      ensureObserverBound('visibility');
      detectAndProcess(true);
    }
  }

  function teardownForPageExit(reason) {
    startupCancelled = true;
    if (loadInitTimer) {
      clearTimeout(loadInitTimer);
      loadInitTimer = null;
    }
    window.removeEventListener('load', scheduleInit);
    window.removeEventListener('online', handleNetworkOnline);
    document.removeEventListener('DOMContentLoaded', scheduleInit);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('pageshow', handlePageShow);
    offlineArticleRetries.clear();
    if (!initialized) {
      Logger.flush();
      return;
    }
    if (typeof ATPLoader !== 'undefined' && typeof ATPLoader.removeGlobalVisListener === 'function') {
      ATPLoader.removeGlobalVisListener();
    }
    if (window.ATPViewport && typeof ATPViewport.cancelHeavyRestores === 'function') {
      ATPViewport.cancelHeavyRestores(reason);
    }
    if (typeof ATPLoader !== 'undefined' && typeof ATPLoader.teardownActiveSlots === 'function') {
      ATPLoader.teardownActiveSlots(reason);
    }
    if (typeof ATPLoader !== 'undefined' && ATPLoader.clearBgTimer) ATPLoader.clearBgTimer();
    flushPendingData();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    boundContainer = null;
    boundContainerParent = null;
    disconnectContainerParentObserver();
    disconnectDormantObserver();
    clearObserverRetryTimer();
    unbindScroll();
    removeSettingsChangedListener();
    if (window.__bfpPanel && typeof window.__bfpPanel.destroy === 'function') {
      window.__bfpPanel.destroy();
    }
    if (window.ATPPreviewer && typeof ATPPreviewer.destroy === 'function') {
      ATPPreviewer.destroy();
    }
    if (window.ATPResourcePanel && typeof ATPResourcePanel.destroy === 'function') {
      ATPResourcePanel.destroy();
    }
    Logger.flush();
  }

  function handlePageHide(event) {
    if (window.ATPForumEntry) window.ATPForumEntry.stopWatching();
    flushPendingData();
    Logger.flush();
    if (event && event.persisted) {
      if (!initialized || !ATPConfig.isEnabled() || forumEntryOnly) {
        bfcacheRecoveryPending = false;
        rescanRequested = false;
        clearScanTimers();
        clearObserverRetryTimer();
        clearProcessCandidateQueue();
        return;
      }
      bfcacheRecoveryPending = true;
      // Retire pending article work while keeping already rendered galleries.
      scanGeneration++;
      if (articleDispatchWake) articleDispatchWake();
      clearScanTimers();
      clearObserverRetryTimer();
      clearProcessCandidateQueue();
      if (typeof ATPLoader !== 'undefined' && typeof ATPLoader.suspendActiveImageSlotsForBfcache === 'function') {
        ATPLoader.suspendActiveImageSlotsForBfcache('bfcache_pagehide');
      }
      if (typeof ATPLoader !== 'undefined' && typeof ATPLoader.pause === 'function') {
        ATPLoader.pause();
      }
      return;
    }
    teardownForPageExit('pagehide');
  }

  function resumeFromBfcache() {
    if (!initialized || !ATPConfig.isEnabled()) {
      bfcacheRecoveryPending = false;
      rescanRequested = false;
      return false;
    }
    if (typeof ATPLoader !== 'undefined') {
      if (typeof ATPLoader.ensureGlobalVisListener === 'function') {
        ATPLoader.ensureGlobalVisListener();
      }
    }
    if (shouldPauseScanningWhenHidden()) {
      syncLoaderVisibilityPauseState();
      bfcacheRecoveryPending = true;
      rescanRequested = true;
      return false;
    }
    bfcacheRecoveryPending = false;
    releaseOfflineArticleRetries();
    if (typeof ATPLoader !== 'undefined' && typeof ATPLoader.recoverActiveImageLoads === 'function') {
      ATPLoader.recoverActiveImageLoads('bfcache_pageshow');
    }
    syncLoaderVisibilityPauseState();
    rescanRequested = false;
    ensureObserverBound('bfcache');
    initFloatPanel();
    detectAndProcess(true);
    return true;
  }

  function handlePageShow(event) {
    if (!event || !event.persisted) return;
    if (!bfcacheRecoveryPending) return;
    if (!initialized || !ATPConfig.isEnabled()) {
      bfcacheRecoveryPending = false;
      rescanRequested = false;
      return;
    }
    resumeFromBfcache();
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('online', handleNetworkOnline);
  window.addEventListener('storage', handleForumPacerStorage);
  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('pageshow', handlePageShow);
})();
