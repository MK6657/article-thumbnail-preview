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
  var EMPTY_RETRY_DELAY = 15000;
  var EMPTY_RETRY_MAX_DELAY = 60000;
  var scanGeneration = 0;
  var processCandidateQueue = [];
  var processCandidateQueueCursor = 0;
  var processCandidateQueueGeneration = 0;
  var processCandidateQueueMayHaveMore = false;
  var processCandidateScanState = null;
  var bfcacheRecoveryPending = false;

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

  async function fetchSameOriginArticle(url) {
    return { url: url, data: await ATPFetcher.fetchArticleData(url, location.href) };
  }

  function getArticleGroupKey(url) {
    return SharedUtils.normalizeArticleUrl ? SharedUtils.normalizeArticleUrl(url) : url;
  }

  function getRetryableEmptyKey(url) {
    return getArticleGroupKey(url);
  }

  function isRetryableEmptyReason(reason) {
    return reason === 'negative_cache' ||
      reason === 'login_redirect' ||
      reason === 'cloudflare' ||
      reason === 'blocked' ||
      reason === 'http_401' ||
      reason === 'http_403';
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

  function getArticleFetchConcurrency() {
    return ATPLoadPolicy.getArticleFetchConcurrency(getLoadPolicySettings());
  }

  function getArticleQueueHighWatermark() {
    return ATPLoadPolicy.getArticleQueueHighWatermark(getLoadPolicySettings());
  }

  function getArticlePrefetchDistance() {
    return ATPLoadPolicy.getArticlePrefetchDistance(getLoadPolicySettings());
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
    if (!url || ATPScanner.shouldExcludeUrl(url) || !ATPScanner.isArticlePageUrl(url)) return false;
    var retryKey = getRetryableEmptyKey(url);
    var retryAfter = emptyRetryAfterByUrl[retryKey];
    scanContext = scanContext || createProcessScanContext();
    if (retryAfter && scanContext.now < retryAfter) {
      scheduleRetryScanAt(retryAfter);
      return false;
    }
    // 重试到期：仅清除到期时间，保留尝试次数，确保再次失败时指数退避继续生效
    if (retryAfter) delete emptyRetryAfterByUrl[retryKey];
    return isNearViewport(entry, scanContext);
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
    processCandidateQueueMayHaveMore = true;
  }

  function clearProcessCandidateQueue() {
    clearQueuedProcessCandidates();
    processCandidateScanState = null;
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
      seekViewportStart: true,
      viewportTop: scanContext ? scanContext.viewportTop : -getArticlePrefetchDistance(),
      skipServiceThreads: !settings || settings.skipServiceThreads !== false,
      accept: function(entry) {
        return isProcessCandidate(entry, scanContext);
      }
    });
    processCandidateQueueCursor = 0;
    processCandidateQueueGeneration = scanGeneration;
    var hasSentinelCandidate = processCandidateQueue.length > scanLimit;
    var shouldContinueScan = !processCandidateScanState.exhausted &&
      (!scanContext || !scanContext.reachedBelowViewport || processCandidateQueue.length > 0);
    processCandidateQueueMayHaveMore = hasSentinelCandidate || shouldContinueScan;
  }

  function hasMoreProcessCandidates() {
    return processCandidateQueueCursor < processCandidateQueue.length || processCandidateQueueMayHaveMore;
  }

  function detectProcessCandidates(limit) {
    limit = Math.max(1, Number(limit) || getArticleQueueHighWatermark());
    if (processCandidateQueueGeneration !== scanGeneration) clearProcessCandidateQueue();
    var scanContext = createProcessScanContext();
    var candidates = takeQueuedProcessCandidates(limit, scanContext);
    if (candidates.length) return candidates;
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
      cls.contains('atp-heavy-preview-canvas') ||
      cls.contains('atp-resource-sidebar') ||
      cls.contains('atp-resource-inline')
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
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    disconnectContainerParentObserver();
    bumpScanGeneration();
    setupObserver('rebind');
    detectAndProcess(true);
  }

  function setupContainerParentObserver(container) {
    disconnectContainerParentObserver();
    var parent = container && container.parentNode;
    if (!parent) return;
    var nextParentObserver = new MutationObserver(function(ms) {
      if (pauseScanningForHiddenPage()) return;
      if (!document.contains(container) || mutationsHaveExternalArticleAdd(ms)) {
        rebindThreadObserver('Thread container parent changed, rebinding');
      }
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
    clearProcessCandidateQueue();
  }

  function syncScanGeneration() {
    if (window.ATPState) window.ATPState.generation = scanGeneration;
  }

  function bumpScanGeneration() {
    scanGeneration++;
    syncScanGeneration();
    clearProcessCandidateQueue();
    pruneStaleThreadStates();
    return scanGeneration;
  }

  // 清理代际过期或已脱离文档的 threadState，避免长期驻留导致内存与调度开销累积。
  // 代际过期的条目对调度器已永久不可见（isThreadCurrent 恒为 false），删除不改变行为。
  function pruneStaleThreadStates() {
    var threads = window.ATPState && window.ATPState.threads;
    if (!threads) return;
    // 删除前先落地该帖挂起的 loadedUrls 缓存写回（flushCacheNow 需要 ts 仍在表中），
    // 否则 1s 批量定时器稍后触发时查不到 ts，这批已加载标记会被静默丢弃
    var pendingFlush = window.ATPCache && ATPCache.getPendingFlush ? ATPCache.getPendingFlush() : null;
    for (var tid in threads) {
      var ts = threads[tid];
      if (!ts) { delete threads[tid]; continue; }
      var stale = typeof ts.generation === 'number' && ts.generation !== scanGeneration;
      if (!stale && ts.panel && !document.contains(ts.panel)) stale = true;
      if (stale) {
        if (pendingFlush && pendingFlush[tid] && ATPCache.flushCacheNow) {
          ATPCache.flushCacheNow(tid);
        }
        delete threads[tid];
      }
    }
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
    }, Math.max(0, fireAt - Date.now()));
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

  function rememberRetryableEmpty(url, info) {
    var retryKey = getRetryableEmptyKey(url);
    var reason = getRetryableEmptyReason(info);
    var explicitRetryAfter = getRetryableEmptyRetryAfter(info);
    var attempts = (emptyRetryAttemptsByUrl[retryKey] || 0) + 1;
    emptyRetryAttemptsByUrl[retryKey] = attempts;
    var delay = Math.min(EMPTY_RETRY_MAX_DELAY, EMPTY_RETRY_DELAY * Math.pow(2, Math.min(attempts - 1, 3)));
    var dueAt = explicitRetryAfter || (Date.now() + delay);
    if (explicitRetryAfter) delay = Math.max(0, explicitRetryAfter - Date.now());
    emptyRetryAfterByUrl[retryKey] = dueAt;
    Logger.debug('文章临时空结果，稍后重试', (reason || 'retryable') + ' ' + delay + 'ms ' + logUrl(url));
    scheduleRetryScanAt(dueAt);
  }

  function clearRetryableEmpty(url) {
    var retryKey = getRetryableEmptyKey(url);
    delete emptyRetryAfterByUrl[retryKey];
    delete emptyRetryAttemptsByUrl[retryKey];
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

  function isArticleJobVisible(job) {
    var entries = getLiveCommitEntries(job);
    var vh = window.innerHeight || document.documentElement.clientHeight || 800;
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i].container;
      if (!el || !el.getBoundingClientRect) return true;
      var rect = el.getBoundingClientRect();
      if (rect.bottom >= 0 && rect.top <= vh) return true;
    }
    return false;
  }

  function pickBestArticleEntry(entries) {
    var best = entries[0];
    for (var i = 1; i < entries.length; i++) {
      if (entries[i].container.tagName === 'TBODY') return entries[i];
      if (best.container.tagName !== 'TBODY' && entries[i].container.tagName === 'TR') best = entries[i];
    }
    return best;
  }

  function commitArticleResult(job, summary, generation) {
    if (generation !== scanGeneration || !ATPConfig.isEnabled() || pauseScanningForHiddenPage()) return;
    var entries = getLiveCommitEntries(job);
    if (!entries.length) return;
    var data = job.data || ATPCache.normalizeArticleData(null);
    if (!job.summaryCounted) {
      job.summaryCounted = true;
      if (hasArticlePayload(data)) summary.articles++;
      summary.images += data.images.length;
      summary.resources += SharedUtils.countResources(data.resources);
    }
    if (!hasArticlePayload(data)) {
      if (job.retryableEmpty) {
        if (!job.retryRemembered) {
          job.retryRemembered = true;
          rememberRetryableEmpty(job.url, job.retryableEmpty);
        }
        return;
      }
      clearRetryableEmpty(job.url);
      for (var i = 0; i < entries.length; i++) entries[i].container.classList.add('atp-processed');
      return;
    }
    clearRetryableEmpty(job.url);
    var best = pickBestArticleEntry(entries);
    ATPRenderer.injectThumbnails(best.container, data, best.link, job.fetchStartedAt);
  }

  function runArticleCommit(work) {
    var commitStartedAt = Date.now();
    // 仅在 DEBUG 日志开启时才做可见性测量，避免每次提交前强制回流
    var debugCommit = Logger.event && (!Logger.isEnabled || Logger.isEnabled('DEBUG'));
    var wasVisible = debugCommit ? isArticleJobVisible(work.job) : undefined;
    try {
      commitArticleResult(work.job, work.summary, work.generation);
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
    work.job.commitQueued = false;
    work.job.commitPromise = null;
    work.resolve();
  }

  function flushArticleCommitQueue() {
    articleCommitScheduled = false;
    var batchSize = ATPLoadPolicy.getArticleCommitBatchSize(getLoadPolicySettings());
    var processed = 0;
    while (articleCommitQueue.length && processed < batchSize) {
      runArticleCommit(articleCommitQueue.shift());
      processed++;
    }
    if (articleCommitQueue.length) scheduleArticleCommitFlush();
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
    if (isArticleJobVisible(job)) {
      return new Promise(function(resolve) {
        job.commitQueued = true;
        runArticleCommit({ job: job, summary: summary, generation: generation, resolve: resolve });
      });
    }
    job.commitQueued = true;
    job.commitPromise = new Promise(function(resolve) {
      var work = { job: job, summary: summary, generation: generation, resolve: resolve };
      articleCommitQueue.push(work);
      scheduleArticleCommitFlush();
    });
    return job.commitPromise;
  }

  function makeArticleFetchOutcome(data, retryableEmpty) {
    return {
      data: ATPCache.normalizeArticleData(data),
      retryableEmpty: retryableEmpty || null
    };
  }

  // 调用方已经持有规范化结果时走这个入口：再规范化一次要对整份候选表重跑
  // 实体解码 + URL 归一（100 条约 0.3~0.8ms），还会多造一份等价对象
  function makeNormalizedArticleFetchOutcome(data, retryableEmpty) {
    return {
      data: data,
      retryableEmpty: retryableEmpty || null
    };
  }

  async function fetchCrossOriginArticle(job, generation) {
    var cacheState = await ATPCache.getArticleCacheState(job.url);
    if (generation !== scanGeneration || pauseScanningForHiddenPage()) return null;
    if (cacheState && cacheState.cached) return makeArticleFetchOutcome(cacheState.cached, null);
    if (cacheState && cacheState.negative) {
      return makeArticleFetchOutcome(null, makeRetryableEmptyInfo('negative_cache', cacheState.negativeExpiresAt));
    }
    var data = await ATPFetcher.fetchArticleDataByBackground(job.url);
    if (generation !== scanGeneration || pauseScanningForHiddenPage()) return null;
    if (!data) return makeArticleFetchOutcome(null, makeRetryableEmptyInfo('background_timeout', 0));
    data = ATPCache.normalizeArticleData(data);
    if (hasArticlePayload(data)) {
      cacheFetchedArticleData(job.url, data, job.fetchStartedAt);
      return makeNormalizedArticleFetchOutcome(data, null);
    }
    if (data.retryableEmpty) {
      return makeNormalizedArticleFetchOutcome(data, makeRetryableEmptyInfo(data.emptyReason || 'background_retryable', data.retryAfter));
    }
    if (data.partial) {
      return makeNormalizedArticleFetchOutcome(data, makeRetryableEmptyInfo(data.emptyReason || 'partial_empty', data.retryAfter));
    }
    if (shouldNegativeCacheEmptyReason(data.emptyReason || '')) ATPCache.setNegativeCache(job.url, job.fetchStartedAt);
    return makeNormalizedArticleFetchOutcome(data, null);
  }

  async function fetchArticleJob(job, generation) {
    if (!job.fetchStartedAt) job.fetchStartedAt = Date.now();
    if (!job.sameOrigin) return await fetchCrossOriginArticle(job, generation);
    try {
      var result = await fetchSameOriginArticle(job.url);
      if (generation !== scanGeneration || pauseScanningForHiddenPage()) return null;
      var data = ATPCache.normalizeArticleData(result && result.data);
      if (data.retryableEmpty) {
        return makeNormalizedArticleFetchOutcome(data, makeRetryableEmptyInfo(data.emptyReason || 'same_origin_retryable', data.retryAfter));
      }
      if (!hasArticlePayload(data) && data.partial) {
        return makeNormalizedArticleFetchOutcome(data, makeRetryableEmptyInfo(data.emptyReason || 'partial_empty', data.retryAfter));
      }
      return makeNormalizedArticleFetchOutcome(data, null);
    } catch (e) {
      Logger.warn('同源文章抓取异常', logUrl(job.url));
      return await fetchCrossOriginArticle(job, generation);
    }
  }

  async function processContainers(containers, generation) {
    if (generation !== scanGeneration || !ATPConfig.isEnabled() || pauseScanningForHiddenPage()) return;
    var summary = { articles: 0, images: 0, resources: 0, sameOrigin: 0, crossOrigin: 0 };
    var jobs = [];
    var jobCursor = 0;
    var jobsByKey = {};
    var commitPromises = [];

    function queuedJobCount() {
      return Math.max(0, jobs.length - jobCursor);
    }

    function addEntryToJob(job, entry) {
      for (var i = 0; i < job.entries.length; i++) {
        if (job.entries[i] === entry) return;
      }
      job.entries.push(entry);
      if (job.state === 'done') commitPromises.push(enqueueArticleCommit(job, summary, generation));
    }

    function enqueueContainers(nextContainers) {
      for (var i = 0; i < nextContainers.length; i++) {
        var entry = nextContainers[i];
        var url = entry && entry.link && entry.link.href;
        if (!url || ATPScanner.shouldExcludeUrl(url) || !ATPScanner.isArticlePageUrl(url)) continue;
        var key = getArticleGroupKey(url);
        var existing = jobsByKey[key];
        if (existing) {
          addEntryToJob(existing, entry);
          continue;
        }
        var job = {
          key: key,
          url: url,
          entries: [entry],
          sameOrigin: isSameOriginUrl(url),
          state: 'queued',
          data: null,
          retryableEmpty: null,
          fetchStartedAt: 0,
          commitQueued: false,
          commitPromise: null,
          summaryCounted: false,
          retryRemembered: false,
          createdAt: Date.now(),
          fetchCompletedAt: 0
        };
        jobsByKey[key] = job;
        jobs.push(job);
      }
    }

    function refillJobs() {
      var highWatermark = getArticleQueueHighWatermark();
      var scanPasses = 0;
      while (
        generation === scanGeneration &&
        !pauseScanningForHiddenPage() &&
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

    function takeJob() {
      refillJobs();
      if (jobCursor >= jobs.length) return null;
      var job = jobs[jobCursor++];
      job.state = 'inflight';
      return job;
    }

    async function worker() {
      while (generation === scanGeneration && ATPConfig.isEnabled() && !pauseScanningForHiddenPage()) {
        var job = takeJob();
        if (!job) return;
        if (job.sameOrigin) summary.sameOrigin++;
        else summary.crossOrigin++;
        job.fetchStartedAt = Date.now();
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
          outcome = await fetchArticleJob(job, generation);
        } catch (e) {
          Logger.warn('正文抓取异常', logUrl(job.url) + ' ' + (e && e.message ? e.message : String(e)));
          outcome = makeArticleFetchOutcome(null, makeRetryableEmptyInfo('transient_exception', 0));
        }
        if (!outcome || generation !== scanGeneration || pauseScanningForHiddenPage()) return;
        job.data = outcome.data;
        job.retryableEmpty = outcome.retryableEmpty;
        job.state = 'done';
        job.fetchCompletedAt = Date.now();
        if (Logger.event && (!Logger.isEnabled || Logger.isEnabled('DEBUG'))) {
          Logger.event('article_fetch_done', {
            url: logUrl(job.url),
            sameOrigin: job.sameOrigin,
            queueWaitMs: Math.max(0, job.fetchStartedAt - job.createdAt),
            fetchMs: Math.max(0, job.fetchCompletedAt - job.fetchStartedAt),
            images: job.data.images.length,
            resources: SharedUtils.countResources(job.data.resources),
            retryable: !!job.retryableEmpty
          }, 'DEBUG');
        }
        commitPromises.push(enqueueArticleCommit(job, summary, generation));
      }
    }

    enqueueContainers(containers);
    refillJobs();
    var workerCount = getArticleFetchConcurrency();
    var workers = new Array(workerCount);
    for (var i = 0; i < workerCount; i++) workers[i] = worker();
    await Promise.all(workers);
    await Promise.all(commitPromises);
    if (generation !== scanGeneration || !ATPConfig.isEnabled() || pauseScanningForHiddenPage()) return;
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

  function cacheFetchedArticleData(url, data, writeStartedAt) {
    data = ATPCache.normalizeArticleData(data);
    var cachedAttachments = [];
    var hasTransientAttachment = !!data.hasTextAttachments;
    for (var i = 0; i < data.textAttachments.length; i++) {
      var attachment = data.textAttachments[i];
      if (attachment && SharedUtils.isTransientTextAttachmentUrl(attachment.url, url)) {
        hasTransientAttachment = true;
      } else if (attachment) {
        cachedAttachments.push(attachment);
      }
    }
    var cacheData = {
      images: data.images,
      resources: data.resources,
      textAttachments: cachedAttachments,
      loadedUrls: data.loadedUrls,
      hasTextAttachments: hasTransientAttachment || cachedAttachments.length > 0,
      textAttachmentCount: data.textAttachmentCount || data.textAttachments.length,
      textResourcesComplete: data.textResourcesComplete,
      textResourcesAttemptedCount: data.textResourcesAttemptedCount,
      textResourcesUnresolvedCount: data.textResourcesUnresolvedCount,
      textResourcesRetryableCount: data.textResourcesRetryableCount,
      partial: data.partial
    };
    ATPCache.setCachedArticleData(url, cacheData, !data.partial, writeStartedAt);
  }

  function detectAndProcess(fromMutation, immediate) {
    if (!ATPConfig.isEnabled()) return;
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
    // 父节点也要没变：containerParentObserver 挂在旧父上，容器被搬走时必须全量重绑
    if (observer && boundContainer && document.contains(boundContainer) &&
      boundContainerParent && boundContainer.parentNode === boundContainerParent) {
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
      if (pauseScanningForHiddenPage()) return;
      if (!document.contains(container)) {
        rebindThreadObserver('Thread container replaced, rebinding');
        return;
      }
      for (var i = 0; i < ms.length; i++) {
        if (ms[i].addedNodes.length && mutationHasExternalAdd(ms[i]) && mutationHasArticleAdd(ms[i])) {
          clearProcessCandidateQueue();
          detectAndProcess(true);
          break;
        }
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

    if (window.ATPState) {
      window.ATPState.threads = {};
    }
    emptyRetryAfterByUrl = {};
    emptyRetryAttemptsByUrl = {};

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

  function handleScrollScan() {
    if (pauseScanningForHiddenPage()) return;
    if (scrollScanTimer) return;
    scrollScanTimer = setTimeout(function() {
      scrollScanTimer = null;
      if (pauseScanningForHiddenPage()) return;
      keepUnconsumedQueuedProcessCandidates();
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
            var previousSettings = ATPConfig.settings || {};
            var nextSettings = ATPNormalizeSettings(Object.assign({}, ATPConfig.settings || {}, newSettings));
            var reloadNeeded = needsSettingsReload(previousSettings, nextSettings);
            ATPConfig.settings = nextSettings;
            if (!window.ATPState) window.ATPState = {};
            window.ATPState.settings = ATPConfig.settings;
            if (Logger.setDebugEnabled) Logger.setDebugEnabled(nextSettings.debugLogging === true);
            if (reloadNeeded) {
              reloadThumbnails();
            } else {
              applyLiveSettings(previousSettings, nextSettings);
            }
          }
        }
      });
      window.__bfpPanel = panel;
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
      await ATPConfig.getSettings();
      if (Logger.setDebugEnabled) Logger.setDebugEnabled(ATPConfig.settings && ATPConfig.settings.debugLogging === true);
      if (startupCancelled) return;
      addSettingsChangedListener();
      initialized = true;
      if (ATPConfig.isEnabled()) enableCurrentPage();
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
      var reloadNeeded = needsSettingsReload(previousSettings, nextSettings);
      ATPConfig.settings = nextSettings;
      if (!window.ATPState) window.ATPState = {};
      window.ATPState.settings = ATPConfig.settings;
      if (Logger.setDebugEnabled) Logger.setDebugEnabled(nextSettings.debugLogging === true);
      var nowEnabled = ATPConfig.isEnabled();
      if (window.__bfpPanel && typeof window.__bfpPanel.setSettings === 'function') {
        window.__bfpPanel.setSettings(ATPConfig.settings);
      }
      Logger.info('设置变更', '外部更新');
      if (!nowEnabled) {
        disableCurrentPage();
      } else if (!wasEnabled) {
        enableCurrentPage();
      } else if (!reloadNeeded) {
        applyLiveSettings(previousSettings, nextSettings);
      }
      if (nowEnabled && wasEnabled && reloadNeeded) {
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
      pauseScanningForHiddenPage();
    } else if (bfcacheRecoveryPending && ATPConfig.isEnabled()) {
      resumeFromBfcache();
    } else if (rescanRequested && ATPConfig.isEnabled()) {
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
    document.removeEventListener('DOMContentLoaded', scheduleInit);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('pageshow', handlePageShow);
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
    flushPendingData();
    Logger.flush();
    if (event && event.persisted) {
      if (!initialized || !ATPConfig.isEnabled()) {
        bfcacheRecoveryPending = false;
        rescanRequested = false;
        clearScanTimers();
        clearObserverRetryTimer();
        clearProcessCandidateQueue();
        return;
      }
      bfcacheRecoveryPending = true;
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
  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('pageshow', handlePageShow);
})();
