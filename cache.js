const ATPArticleCacheData = (function() {
  'use strict';

  function mergeLoadedUrls(existingUrls, newUrls) {
    var seen = {};
    var merged = [];
    existingUrls = Array.isArray(existingUrls) ? existingUrls : [];
    newUrls = Array.isArray(newUrls) ? newUrls : [];
    for (var i = 0; i < existingUrls.length; i++) {
      if (existingUrls[i] && !seen[existingUrls[i]]) {
        seen[existingUrls[i]] = true;
        merged.push(existingUrls[i]);
      }
    }
    for (var j = 0; j < newUrls.length; j++) {
      if (newUrls[j] && !seen[newUrls[j]]) {
        seen[newUrls[j]] = true;
        merged.push(newUrls[j]);
      }
    }
    return merged;
  }

  function normalizeCachedImage(image) {
    var item = typeof image === 'string' ? { src: image } : Object.assign({}, image || {});
    if (!item.src) return null;
    item.src = String(item.src).trim().replace(/\\\//g, '/');
    if (!SharedUtils.isMeaningfulImage(item.src)) return null;
    if (item.previewSrc) {
      item.previewSrc = String(item.previewSrc).trim().replace(/\\\//g, '/');
      if (!SharedUtils.isMeaningfulImage(item.previewSrc)) delete item.previewSrc;
    }
    if (item.displaySrc) {
      item.displaySrc = String(item.displaySrc).trim().replace(/\\\//g, '/');
      if (!SharedUtils.isMeaningfulImage(item.displaySrc)) delete item.displaySrc;
    }
    return item;
  }

  function* normalizeCachedImages(images) {
    var out = [];
    var seen = {};
    images = Array.isArray(images) ? images : [];
    for (var i = 0; i < images.length; i++) {
      var item = normalizeCachedImage(images[i]);
      if (item) {
        var key = SharedUtils.normalizeImageUrl(SharedUtils.getImagePreviewSrc(item));
        if (!seen[key]) {
          seen[key] = true;
          out.push(item);
        }
      }
      yield;
    }
    return out;
  }

  function* normalizeCachedUrls(urls) {
    var out = [];
    var seen = {};
    urls = Array.isArray(urls) ? urls : [];
    for (var i = 0; i < urls.length; i++) {
      var url = String(urls[i] || '').trim().replace(/\\\//g, '/');
      if (url && !seen[url]) {
        seen[url] = true;
        out.push(url);
      }
      yield;
    }
    return out;
  }

  function finishNormalization(steps) {
    var step;
    do { step = steps.next(); } while (!step.done);
    return step.value;
  }

  function normalizeCachedTextAttachments(attachments) {
    var out = [];
    var seen = {};
    var maxCount = SharedUtils.TEXT_ATTACHMENT_MAX_COUNT || 3;
    attachments = Array.isArray(attachments) ? attachments : [];
    for (var i = 0; i < attachments.length && out.length < maxCount; i++) {
      var raw = typeof attachments[i] === 'string' ? { url: attachments[i] } : Object.assign({}, attachments[i] || {});
      var url = String(raw.url || '').trim().replace(/\\\//g, '/');
      if (!SharedUtils.isPersistableTextAttachmentUrl(url, raw.pageUrl || '')) continue;
      var key = SharedUtils.normalizeTextAttachmentUrl(url);
      if (!key || seen[key]) continue;
      seen[key] = true;
      var item = {
        url: url,
        name: SharedUtils.cleanAttachmentName ? SharedUtils.cleanAttachmentName(raw.name || '') : String(raw.name || '').trim().slice(0, 120),
        source: String(raw.source || 'txt-attachment')
      };
      var pageUrl = SharedUtils.sanitizeTextAttachmentPageUrl(raw.pageUrl || '');
      if (pageUrl) item.pageUrl = pageUrl;
      out.push(item);
    }
    return out;
  }

  function countTransientCachedTextAttachments(attachments) {
    var count = 0;
    attachments = Array.isArray(attachments) ? attachments : [];
    for (var i = 0; i < attachments.length; i++) {
      var raw = typeof attachments[i] === 'string' ? { url: attachments[i] } : (attachments[i] || {});
      var url = String(raw.url || '').trim().replace(/\\\//g, '/');
      if (SharedUtils.isAllowedTextAttachmentUrl(url, raw.pageUrl || '') && SharedUtils.isTransientTextAttachmentUrl(url, raw.pageUrl || '')) count++;
    }
    return count;
  }

  function mergeCachedTextAttachments(existingAttachments, newAttachments) {
    var out = [];
    var seen = {};
    var maxCount = SharedUtils.TEXT_ATTACHMENT_MAX_COUNT || 3;

    function append(attachments) {
      attachments = Array.isArray(attachments) ? attachments : [];
      for (var i = 0; i < attachments.length && out.length < maxCount; i++) {
        var item = attachments[i] || {};
        var key = SharedUtils.normalizeTextAttachmentUrl(item.url);
        if (!SharedUtils.isPersistableTextAttachmentUrl(item.url, item.pageUrl || '')) continue;
        if (!key || seen[key]) continue;
        seen[key] = true;
        var pageUrl = SharedUtils.sanitizeTextAttachmentPageUrl(item.pageUrl || '');
        out.push({
          url: item.url,
          name: item.name || '',
          source: item.source || 'txt-attachment',
          pageUrl: pageUrl
        });
        if (!out[out.length - 1].pageUrl) delete out[out.length - 1].pageUrl;
      }
    }

    append(existingAttachments);
    append(newAttachments);
    return out;
  }

  function deriveTextAttachmentCount(textAttachments, hasTextAttachments, markerCount) {
    if (!hasTextAttachments) return 0;
    markerCount = Math.max(0, parseInt(markerCount || 0, 10) || 0);
    var cachedCount = textAttachments && textAttachments.length ? textAttachments.length : 0;
    if (!cachedCount) return markerCount || 1;
    var maxCount = SharedUtils.TEXT_ATTACHMENT_MAX_COUNT || 3;
    if (markerCount > cachedCount && markerCount <= maxCount) return markerCount;
    return cachedCount;
  }

  function normalizeArticleFields(data, images, loadedUrls) {
    var textAttachments = normalizeCachedTextAttachments(data.textAttachments);
    var hints = SharedUtils.mergeTextAttachmentHints(SharedUtils.getTextAttachmentHints(data.textAttachments), data.textAttachmentHints);
    var transientAttachmentCount = countTransientCachedTextAttachments(data.textAttachments);
    var markerCount = Math.max(hints.length, transientAttachmentCount, parseInt(data.textAttachmentCount || 0, 10) || 0);
    var hasTextAttachments = textAttachments.length > 0 || !!data.hasTextAttachments || transientAttachmentCount > 0 || hints.length > 0;
    var textAttachmentCount = deriveTextAttachmentCount(textAttachments, hasTextAttachments, markerCount);
    var normalized = {
      images: images,
      resources: SharedUtils.normalizeResources(data.resources),
      textAttachments: textAttachments,
      loadedUrls: loadedUrls,
      hasTextAttachments: hasTextAttachments,
      textAttachmentCount: textAttachmentCount,
      textAttachmentHints: hints,
      textResolvedAttachmentIds: SharedUtils.mergeResolvedTextIds(hints, data.textResolvedAttachmentIds),
      textResourcesComplete: data.textResourcesComplete === true,
      textResourcesAttemptedCount: Math.max(0, Number(data.textResourcesAttemptedCount || 0) || 0),
      textResourcesUnresolvedCount: Math.max(0, Number(data.textResourcesUnresolvedCount || 0) || 0),
      textResourcesRetryableCount: Math.max(0, Number(data.textResourcesRetryableCount || 0) || 0),
      partial: !!data.partial,
      retryableEmpty: !!data.retryableEmpty,
      emptyReason: data.emptyReason || '',
      retryAfter: Math.max(0, Number(data.retryAfter || 0) || 0)
    };
    var readAt = Number(data.readAt) || 0;
    if (readAt > 0) normalized.readAt = readAt;
    if (Number.isSafeInteger(data.imageExtractionVersion) && data.imageExtractionVersion > 0) {
      normalized.imageExtractionVersion = data.imageExtractionVersion;
    }
    if (data.textResourcesImported === true) normalized.textResourcesImported = true;
    if (data.textAttachmentsLimited === true) normalized.textAttachmentsLimited = true;
    return normalized;
  }

  function* iterateArticleData(data) {
    if (Array.isArray(data)) data = { images: data };
    data = data || {};
    var images = yield* normalizeCachedImages(data.images);
    var loadedUrls = yield* normalizeCachedUrls(data.loadedUrls);
    return normalizeArticleFields(data, images, loadedUrls);
  }

  function normalizeArticleData(data) {
    return finishNormalization(iterateArticleData(data));
  }

  function mergeArticleProgress(previous, incoming, body) {
    var attachments = mergeCachedTextAttachments(body.textAttachments, body === previous ? incoming.textAttachments : previous.textAttachments);
    var hints = SharedUtils.mergeTextAttachmentHints(body.textAttachmentHints, body === previous ? incoming.textAttachmentHints : previous.textAttachmentHints);
    var ids = SharedUtils.mergeResolvedTextIds(hints, previous.textResolvedAttachmentIds, incoming.textResolvedAttachmentIds);
    var hasAttachments = previous.hasTextAttachments || incoming.hasTextAttachments;
    var count = deriveTextAttachmentCount(attachments, hasAttachments, Math.max(hints.length, previous.textAttachmentCount, incoming.textAttachmentCount));

    function remaining(data) {
      if (data.textResourcesComplete) return Math.max(0, count - data.textAttachmentCount);
      if (data.textResourcesUnresolvedCount) return data.textResourcesUnresolvedCount + Math.max(0, count - data.textAttachmentCount);
      return count;
    }
    var attempted = Math.max(ids.length, previous.textResourcesAttemptedCount, incoming.textResourcesAttemptedCount);
    var done = (count > 0 && ids.length >= count) ||
      (previous.textResourcesComplete && previous.textAttachmentCount >= count) ||
      (incoming.textResourcesComplete && incoming.textAttachmentCount >= count);
    var unresolved = (attempted || previous.textResourcesComplete || incoming.textResourcesComplete ||
      previous.textResourcesUnresolvedCount || incoming.textResourcesUnresolvedCount)
      ? Math.min(count - ids.length, remaining(previous), remaining(incoming)) : 0;
    var retryable = Math.max(previous.textResourcesRetryableCount, incoming.textResourcesRetryableCount,
      previous.textResourcesComplete ? count - previous.textAttachmentCount : 0,
      incoming.textResourcesComplete ? count - incoming.textAttachmentCount : 0);

    body.loadedUrls = mergeLoadedUrls(previous.loadedUrls, incoming.loadedUrls);
    body.resources = SharedUtils.mergeResources(previous.resources, incoming.resources);
    body.textAttachments = attachments;
    body.hasTextAttachments = hasAttachments;
    body.textAttachmentCount = count;
    body.textAttachmentHints = hints;
    body.textResolvedAttachmentIds = ids;
    body.textResourcesAttemptedCount = attempted;
    body.textResourcesComplete = done;
    body.textResourcesUnresolvedCount = done ? 0 : Math.max(0, unresolved);
    body.textResourcesRetryableCount = done ? 0 : Math.min(body.textResourcesUnresolvedCount, retryable);
    if (previous.textResourcesImported || incoming.textResourcesImported) body.textResourcesImported = true;
    if (previous.textAttachmentsLimited || incoming.textAttachmentsLimited) body.textAttachmentsLimited = true;
  }

  function applyMutation(existing, request, ttl, now) {
    if (request.operation === 'loadedUrls') {
      if (!existing || !existing.data) return null;
      var current = existing.data;
      var loaded = Array.isArray(current.loadedUrls) ? current.loadedUrls : [];
      var seen = new Set(loaded);
      var added = finishNormalization(normalizeCachedUrls(request.loadedUrls)).filter(function(url) { return !seen.has(url); });
      var complete = !current.partial && (!!request.complete || !!existing.complete);
      if (!added.length && complete === existing.complete) return existing;
      var body = Array.isArray(current) ? normalizeArticleData(current) : current;
      return { data: Object.assign({}, body, { loadedUrls: loaded.concat(added) }), ts: existing.ts, complete: complete };
    }

    if (request.operation === 'textProgress' && (!existing || !existing.data)) return null;
    var incoming = normalizeArticleData(request.data);
    incoming.readAt = incoming.readAt || request.writeStartedAt;
    var rendererUpdate = request.operation !== 'article';
    var freshRecord = { data: incoming, ts: rendererUpdate ? incoming.readAt : now, complete: !incoming.partial && !!request.complete };
    if (!existing || !existing.data) return freshRecord;
    var previous = normalizeArticleData(existing.data);
    previous.readAt = previous.readAt || existing.ts;
    if (!rendererUpdate && now - existing.ts >= ttl && incoming.readAt >= previous.readAt) return freshRecord;
    if (request.operation === 'preview') {
      return { data: previous, ts: existing.ts, complete: !previous.partial && (!!existing.complete || !!request.complete) };
    }

    var keepBody = rendererUpdate || (existing.complete && !previous.partial && incoming.partial) ||
      (incoming.readAt <= previous.readAt && (!previous.partial || incoming.partial));
    var inputBody = keepBody ? previous : incoming;
    mergeArticleProgress(previous, incoming, inputBody);
    return { data: inputBody, ts: keepBody ? existing.ts : now, complete: !inputBody.partial && (!!request.complete || !!existing.complete) };
  }

  return {
    normalize: normalizeArticleData,
    iterate: iterateArticleData,
    normalizeFields: normalizeArticleFields,
    applyMutation: applyMutation
  };
})();

if (typeof globalThis !== 'undefined') {
  globalThis.ATPArticleCacheData = ATPArticleCacheData;
}

(function(root) {
  'use strict';
  if (!root || typeof SharedUtils === 'undefined') return;

  var IMAGE_CACHE_PREFIX = SharedUtils.CACHE_PREFIXES.IMAGE;
  var ARTICLE_CACHE_PREFIX = SharedUtils.CACHE_PREFIXES.ARTICLE;
  var TEXT_RESOURCE_CACHE_PREFIX = SharedUtils.CACHE_PREFIXES.TEXT_RESOURCE;
  var TEXT_FAIL_CACHE_PREFIX = SharedUtils.CACHE_PREFIXES.TEXT_FAIL;
  var NEGATIVE_CACHE_KEY = SharedUtils.CACHE_PREFIXES.NEGATIVE;
  var CACHE_GENERATION_KEY = SharedUtils.CACHE_GENERATION_KEY || 'atp_cache_generation_v1';

  // 32MB soft cap leveraging "unlimitedStorage" while keeping storage bounded
  var QUOTA_BYTES = SharedUtils.DEFAULT_CACHE_QUOTA_BYTES || (32 * 1024 * 1024);
  var HIGH_WATERMARK = Math.floor(QUOTA_BYTES * 0.85);
  var TARGET_WATERMARK = Math.floor(QUOTA_BYTES * 0.75);
  var NEGATIVE_TTL_MS = 5 * 60 * 1000;
  var TEXT_FAIL_TTL_MS = 5 * 60 * 1000;
  var LEGACY_IMAGE_ARTICLE_TTL_MS = 15 * 60 * 1000;
  var CACHE_FLUSH_DEBOUNCE_MS = 3000;

  // Per-context bounded in-memory article read LRU + loadedUrls write coalescer
  var MAX_MEMORY_ARTICLES = 250;
  var MISS_MEMORY_TTL_MS = 2000;
  var MAX_LOADED_URL_SIGNATURES = 500;
  var memoryArticleCache = new Map();
  var lastPersistedLoadedUrls = new Map();

  var CACHE_FLUSH_TIMER = null;
  var CACHE_FLUSH_PENDING = {};
  var evictionInProgress = false;
  var pendingEvictCallbacks = [];
  var pendingEvictBaseline = 0;
  var CACHE_WRITE_CHECK_INTERVAL_MS = 5000;
  var CACHE_WRITE_CHECK_BATCH = 12;
  var ARTICLE_INLINE_ITEMS = 128;
  var ARTICLE_PREPARATION_SLICE_MS = 6;
  var ARTICLE_PREPARATION_SLICE_ITEMS = 1024;
  var ARTICLE_PREPARATION_TURN_ITEMS = 256;
  var preparedArticles = new WeakSet();
  var pendingArticleReads = new Map();
  var articleCacheReadStarts = new WeakMap();
  var articlePreparationQueue = [];
  var articlePreparationScheduled = false;
  var CACHE_INDEX_REPAIR_IN_FLIGHT = false;
  var cacheWriteCheckTimer = null;
  var lastCacheWriteCheckAt = 0;
  var cacheWritesSinceCheck = 0;
  var cacheWriteCheckInProgress = false;

  // In-memory cacheClearGeneration synchronized via chrome.storage.onChanged
  var cachedCacheGeneration = null;
  var cacheGenerationInitCallbacks = null;
  var cacheGenerationWatcherInstalled = false;

  function getActiveLogger() {
    if (typeof BGLOG !== 'undefined' && BGLOG) return BGLOG;
    if (root && root.BGLOG) return root.BGLOG;
    if (typeof Logger !== 'undefined' && Logger) return Logger;
    if (root && root.Logger) return root.Logger;
    return null;
  }

  function logWarn(action, detail) {
    var log = getActiveLogger();
    if (log && typeof log.warn === 'function') {
      log.warn(action, detail);
    } else if (typeof console !== 'undefined' && console.warn) {
      console.warn('[ATPCache] ' + action + (detail ? ': ' + detail : ''));
    }
  }

  function logDebug(action, detail) {
    var log = getActiveLogger();
    if (log && typeof log.debug === 'function') {
      log.debug(action, detail);
    }
  }

  function consumeStorageError(action) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.lastError) return false;
    logWarn(action, chrome.runtime.lastError.message);
    return true;
  }

  function getHostAppState() {
    if (typeof window !== 'undefined' && window && window.ATPState) return window.ATPState;
    if (root && root.ATPState) return root.ATPState;
    return null;
  }

  function getCacheWriteStartedAt(value) {
    return (typeof value === 'number' && isFinite(value) && value > 0) ? value : Date.now();
  }

  function getCacheGeneration(value) {
    var n = Number(value || 0);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function isCacheWriteStale(writeStartedAt, generation) {
    return !!(generation && writeStartedAt <= generation);
  }

  function rememberCacheGeneration(value, authoritative) {
    var incoming = getCacheGeneration(value);
    if (cachedCacheGeneration === null) {
      cachedCacheGeneration = incoming;
    } else if (authoritative ? incoming !== cachedCacheGeneration : incoming > cachedCacheGeneration) {
      cachedCacheGeneration = incoming;
      memoryArticleCache.clear();
      lastPersistedLoadedUrls.clear();
    }
  }

  function ensureCacheGenerationWatcher() {
    if (cacheGenerationWatcherInstalled) return;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged ||
        typeof chrome.storage.onChanged.addListener !== 'function') {
      return;
    }
    cacheGenerationWatcherInstalled = true;
    try {
      chrome.storage.onChanged.addListener(function(changes, area) {
        if (area !== 'local' || !changes) return;
        if (changes[CACHE_GENERATION_KEY]) {
          rememberCacheGeneration(changes[CACHE_GENERATION_KEY].newValue, true);
        }
        for (var key in changes) {
          if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
          if (key.indexOf(ARTICLE_CACHE_PREFIX) === 0) {
            var normUrl = key.slice(ARTICLE_CACHE_PREFIX.length);
            var nextVal = changes[key].newValue;
            if (!nextVal) {
              memoryArticleCache.delete(normUrl);
              lastPersistedLoadedUrls.delete(normUrl);
            } else {
              var mem = memoryArticleCache.get(normUrl);
              if (!mem || mem.kind !== 'positive' || mem.ts !== nextVal.ts) {
                memoryArticleCache.delete(normUrl);
              }
            }
          } else if (key.indexOf(NEGATIVE_CACHE_KEY) === 0) {
            var negUrl = key.slice(NEGATIVE_CACHE_KEY.length);
            var negVal = changes[key].newValue;
            var curMem = memoryArticleCache.get(negUrl);
            if (!negVal) {
              if (curMem && curMem.kind === 'negative') memoryArticleCache.delete(negUrl);
            } else if (typeof negVal === 'number' && (!curMem || curMem.kind !== 'positive')) {
              setMemoryArticleEntry(negUrl, {
                kind: 'negative',
                data: null,
                ts: negVal,
                complete: false,
                readStartedAt: Math.max(negVal, Date.now()),
                expiresAt: negVal + NEGATIVE_TTL_MS
              });
            }
          }
        }
      });
    } catch (e) {
      cacheGenerationWatcherInstalled = false;
    }
  }

  function ensureGenerationLoaded(callback) {
    ensureCacheGenerationWatcher();
    if (cachedCacheGeneration !== null) {
      callback(true);
      return;
    }
    if (cacheGenerationInitCallbacks) {
      cacheGenerationInitCallbacks.push(callback);
      return;
    }
    cacheGenerationInitCallbacks = [callback];
    chrome.storage.local.get(CACHE_GENERATION_KEY, function(result) {
      var cbs = cacheGenerationInitCallbacks || [];
      cacheGenerationInitCallbacks = null;
      if (consumeStorageError('cache generation read failed')) {
        for (var i = 0; i < cbs.length; i++) cbs[i](false);
        return;
      }
      rememberCacheGeneration(result && result[CACHE_GENERATION_KEY]);
      for (var j = 0; j < cbs.length; j++) cbs[j](true);
    });
  }

  function checkCacheWriteFreshFast(writeStartedAt, callback) {
    ensureGenerationLoaded(function(ok) {
      if (!ok) {
        callback(false);
        return;
      }
      callback(!isCacheWriteStale(writeStartedAt, cachedCacheGeneration));
    });
  }

  function setMemoryArticleEntry(normalizedUrl, entry) {
    if (!normalizedUrl || !entry) return;
    if (isCacheWriteStale(entry.readStartedAt, cachedCacheGeneration)) return;
    if (memoryArticleCache.has(normalizedUrl)) {
      memoryArticleCache.delete(normalizedUrl);
    }
    while (memoryArticleCache.size >= MAX_MEMORY_ARTICLES) {
      memoryArticleCache.delete(memoryArticleCache.keys().next().value);
    }
    memoryArticleCache.set(normalizedUrl, entry);
  }

  function buildStampedState(state, startedAt) {
    articleCacheReadStarts.set(state, startedAt);
    if (state.cached) articleCacheReadStarts.set(state.cached, startedAt);
    return state;
  }

  function getMemoryArticleState(normalizedUrl, now) {
    if (!normalizedUrl) return null;
    var entry = memoryArticleCache.get(normalizedUrl);
    if (!entry) return null;
    if (isCacheWriteStale(entry.readStartedAt, cachedCacheGeneration)) {
      memoryArticleCache.delete(normalizedUrl);
      return null;
    }
    if (entry.kind === 'positive') {
      if (!isFreshArticleRecord({ data: entry.data, ts: entry.ts, complete: entry.complete }, now)) {
        memoryArticleCache.delete(normalizedUrl);
        return null;
      }
      memoryArticleCache.delete(normalizedUrl);
      memoryArticleCache.set(normalizedUrl, entry);
      return buildStampedState({ cached: entry.data, negative: false }, entry.readStartedAt);
    }
    if (entry.kind === 'negative') {
      if (!entry.ts || now - entry.ts >= NEGATIVE_TTL_MS) {
        memoryArticleCache.delete(normalizedUrl);
        return null;
      }
      memoryArticleCache.delete(normalizedUrl);
      memoryArticleCache.set(normalizedUrl, entry);
      return buildStampedState({
        cached: null,
        negative: true,
        negativeTs: entry.ts,
        negativeExpiresAt: entry.ts + NEGATIVE_TTL_MS,
        negativeRemainingMs: Math.max(0, entry.ts + NEGATIVE_TTL_MS - now)
      }, entry.readStartedAt);
    }
    if (entry.kind === 'miss') {
      if (now >= entry.expiresAt) {
        memoryArticleCache.delete(normalizedUrl);
        return null;
      }
      memoryArticleCache.delete(normalizedUrl);
      memoryArticleCache.set(normalizedUrl, entry);
      return buildStampedState({ cached: null, negative: false }, entry.readStartedAt);
    }
    memoryArticleCache.delete(normalizedUrl);
    return null;
  }

  function rememberPersistedLoadedUrls(normalizedUrl, urls, complete) {
    if (!normalizedUrl) return;
    var existing = lastPersistedLoadedUrls.get(normalizedUrl);
    var set = existing ? existing.set : new Set();
    if (Array.isArray(urls)) {
      for (var i = 0; i < urls.length; i++) {
        var u = String(urls[i] || '').trim().replace(/\\\//g, '/');
        if (u) set.add(u);
      }
    }
    var next = { set: set, complete: !!(complete || (existing && existing.complete)) };
    if (lastPersistedLoadedUrls.has(normalizedUrl)) lastPersistedLoadedUrls.delete(normalizedUrl);
    while (lastPersistedLoadedUrls.size >= MAX_LOADED_URL_SIGNATURES) {
      lastPersistedLoadedUrls.delete(lastPersistedLoadedUrls.keys().next().value);
    }
    lastPersistedLoadedUrls.set(normalizedUrl, next);
  }

  function sendArticleCacheMutation(url, operation, fields, writeStartedAt, restoreMissingArticle) {
    var normalizedUrl = SharedUtils.normalizeArticleUrl(url);
    var message = Object.assign({
      type: SharedUtils.MESSAGE_TYPES.ARTICLE_CACHE_MUTATION,
      url: normalizedUrl,
      operation: operation,
      writeStartedAt: getCacheWriteStartedAt(writeStartedAt)
    }, fields);
    return new Promise(function(resolve) {
      try {
        chrome.runtime.sendMessage(message, function(response) {
          var failed = chrome.runtime.lastError;
          if (failed) logWarn('文章缓存后台通信失败', failed.message);
          if (!failed && response && response.articleMissing && restoreMissingArticle) {
            resolve(restoreMissingArticle());
            return;
          }
          resolve(!failed && !!(response && response.ok));
        });
      } catch (e) {
        logWarn('文章缓存后台通信失败', e.message);
        resolve(false);
      }
    });
  }

  function removeCacheIndexEntriesAfterStorageRemove(keys, action, callback) {
    SharedUtils.cacheIndex.removeEntries(keys, function(success) {
      if (success === false) {
        logWarn(action, '索引删除失败，尝试重建');
        SharedUtils.cacheIndex.rebuild(function(entries) {
          if (!entries) logWarn(action, '索引重建失败');
          if (callback) callback(!!entries, true);
        });
        return;
      }
      if (callback) callback(true, false);
    });
  }

  function getArticleCacheTTLMS() {
    var settings = ATPCache.getSettings();
    return ((settings && settings.cacheTTL) || 30) * 60 * 1000;
  }

  function isFreshArticleRecord(article, now) {
    if (!article || !article.complete || !article.data) return false;
    var ttl = getArticleCacheTTLMS();
    var cachedImages = Array.isArray(article.data) ? article.data : article.data.images;
    var extractionVersion = Number(article.data.imageExtractionVersion) || 0;
    if (extractionVersion < SharedUtils.ARTICLE_IMAGE_EXTRACTION_VERSION &&
        (extractionVersion > 0 || (cachedImages && cachedImages.length))) {
      ttl = Math.min(ttl, LEGACY_IMAGE_ARTICLE_TTL_MS);
    }
    return now - article.ts < ttl;
  }

  function articlePreparationClock() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function scheduleArticlePreparation() {
    if (articlePreparationScheduled || !articlePreparationQueue.length) return;
    articlePreparationScheduled = true;
    if (typeof requestAnimationFrame !== 'function' ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
      setTimeout(runArticlePreparationSlice, 0);
      return;
    }
    var resumed = false;
    var fallback = setTimeout(resume, 50);
    requestAnimationFrame(resume);
    function resume() {
      if (resumed) return;
      resumed = true;
      clearTimeout(fallback);
      runArticlePreparationSlice();
    }
  }

  function runArticlePreparationSlice() {
    articlePreparationScheduled = false;
    var deadline = articlePreparationClock() + ARTICLE_PREPARATION_SLICE_MS;
    var visited = 0;
    while (articlePreparationQueue.length && visited < ARTICLE_PREPARATION_SLICE_ITEMS &&
        (!visited || articlePreparationClock() < deadline)) {
      var work = articlePreparationQueue.shift();
      try {
        if (work.isCurrent && !work.isCurrent()) {
          visited++;
          work.resolve(null);
          continue;
        }
        var turnLimit = articlePreparationQueue.length
          ? Math.min(ARTICLE_PREPARATION_SLICE_ITEMS, visited + ARTICLE_PREPARATION_TURN_ITEMS)
          : ARTICLE_PREPARATION_SLICE_ITEMS;
        var step;
        do {
          step = work.iterator.next();
          visited++;
        } while (!step.done && visited < turnLimit && articlePreparationClock() < deadline);
        if (step.done) {
          work.resolve(step.value);
        } else {
          articlePreparationQueue.push(work);
        }
      } catch (error) {
        visited++;
        work.reject(error);
      }
    }
    scheduleArticlePreparation();
  }

  function runArticlePreparation(iterator, isCurrent) {
    return new Promise(function(resolve, reject) {
      articlePreparationQueue.push({ iterator: iterator, isCurrent: isCurrent, resolve: resolve, reject: reject });
      scheduleArticlePreparation();
    });
  }

  async function prepareArticleData(data, isCurrent) {
    if (isCurrent && !isCurrent()) return null;
    if (data && typeof data === 'object' && preparedArticles.has(data)) return data;
    var images = Array.isArray(data) ? data : data && data.images;
    var loadedUrls = data && data.loadedUrls;
    var entries = (Array.isArray(images) ? images.length : 0) + (Array.isArray(loadedUrls) ? loadedUrls.length : 0);
    var normalized = entries <= ARTICLE_INLINE_ITEMS
      ? ATPArticleCacheData.normalize(data)
      : await runArticlePreparation(ATPArticleCacheData.iterate(data), isCurrent);
    if (isCurrent && !isCurrent()) return null;
    if (normalized) preparedArticles.add(normalized);
    return normalized;
  }

  function isArticleCacheReadCurrent(value) {
    if (!value || typeof value !== 'object') return false;
    return !isCacheWriteStale(articleCacheReadStarts.get(value), cachedCacheGeneration);
  }

  function readNegativeCache(result, fullKey, now) {
    var v = result && result[fullKey];
    if (!v || now - v >= NEGATIVE_TTL_MS) return null;
    return {
      hit: true,
      ts: v,
      expiresAt: v + NEGATIVE_TTL_MS,
      remainingMs: Math.max(0, v + NEGATIVE_TTL_MS - now)
    };
  }

  async function evaluateStoredArticleState(normalizedUrl, result, startedAt, isCurrent) {
    if (!result || !isCurrent()) {
      return buildStampedState({ cached: null, negative: false }, startedAt);
    }
    var articleKey = ARTICLE_CACHE_PREFIX + normalizedUrl;
    var negativeKey = NEGATIVE_CACHE_KEY + normalizedUrl;
    var article = result[articleKey];
    var now = Date.now();
    if (isFreshArticleRecord(article, now)) {
      var cached = await prepareArticleData(article.data, isCurrent);
      if (!isCurrent()) {
        return buildStampedState({ cached: null, negative: false }, startedAt);
      }
      if (cached && isFreshArticleRecord(article, Date.now())) {
        if (!cached.readAt && Number(article.ts) > 0) cached.readAt = Number(article.ts);
        if (cacheGenerationWatcherInstalled) {
          setMemoryArticleEntry(normalizedUrl, {
            kind: 'positive',
            data: cached,
            ts: Number(article.ts) || now,
            complete: !!article.complete,
            readStartedAt: startedAt,
            expiresAt: 0
          });
        }
        rememberPersistedLoadedUrls(normalizedUrl, cached.loadedUrls, !!article.complete && !cached.partial);
        return buildStampedState({ cached: cached, negative: false }, startedAt);
      }
    }
    var evalNow = Date.now();
    var negativeState = readNegativeCache(result, negativeKey, evalNow);
    if (negativeState) {
      if (cacheGenerationWatcherInstalled) {
        setMemoryArticleEntry(normalizedUrl, {
          kind: 'negative',
          data: null,
          ts: negativeState.ts,
          complete: false,
          readStartedAt: startedAt,
          expiresAt: negativeState.expiresAt
        });
      }
      return buildStampedState({
        cached: null,
        negative: true,
        negativeTs: negativeState.ts,
        negativeExpiresAt: negativeState.expiresAt,
        negativeRemainingMs: negativeState.remainingMs
      }, startedAt);
    }
    if (cacheGenerationWatcherInstalled) {
      setMemoryArticleEntry(normalizedUrl, {
        kind: 'miss',
        data: null,
        ts: evalNow,
        complete: false,
        readStartedAt: startedAt,
        expiresAt: evalNow + MISS_MEMORY_TTL_MS
      });
    }
    return buildStampedState({ cached: null, negative: false }, startedAt);
  }

  function readArticleCacheState(normalizedUrl) {
    ensureCacheGenerationWatcher();
    if (!normalizedUrl) {
      return Promise.resolve(buildStampedState({ cached: null, negative: false }, Date.now()));
    }

    var pending = pendingArticleReads.get(normalizedUrl);
    if (pending && !isCacheWriteStale(pending.startedAt, cachedCacheGeneration)) return pending.promise;

    var articleKey = ARTICLE_CACHE_PREFIX + normalizedUrl;
    var negativeKey = NEGATIVE_CACHE_KEY + normalizedUrl;
    var startedAt = Date.now();
    function isCurrent() {
      return !isCacheWriteStale(startedAt, cachedCacheGeneration);
    }
    var queryKeys = [articleKey, negativeKey, CACHE_GENERATION_KEY];
    var promise = new Promise(function(resolve) {
      chrome.storage.local.get(queryKeys, function(result) {
        resolve(consumeStorageError('文章/失败缓存读取失败') ? null : result);
      });
    }).then(function(result) {
      if (result && Object.prototype.hasOwnProperty.call(result, CACHE_GENERATION_KEY)) {
        rememberCacheGeneration(result[CACHE_GENERATION_KEY]);
      } else if (result && cachedCacheGeneration === null) {
        rememberCacheGeneration(0);
      }
      return evaluateStoredArticleState(normalizedUrl, result, startedAt, isCurrent);
    });

    pending = { startedAt: startedAt, promise: promise };
    pendingArticleReads.set(normalizedUrl, pending);
    function release() {
      if (pendingArticleReads.get(normalizedUrl) === pending) pendingArticleReads.delete(normalizedUrl);
    }
    promise.then(release, release);
    return promise;
  }

  function getCachedArticlesBatch(urls, callback) {
    ensureCacheGenerationWatcher();
    var rawUrls = Array.isArray(urls) ? urls : [];
    var uniqueUrls = [];
    var seen = Object.create(null);
    for (var i = 0; i < rawUrls.length; i++) {
      var norm = SharedUtils.normalizeArticleUrl(rawUrls[i]);
      if (norm && !seen[norm]) {
        seen[norm] = true;
        uniqueUrls.push(norm);
      }
    }

    var out = {};
    if (!uniqueUrls.length) {
      if (typeof callback === 'function') callback(out);
      return Promise.resolve(out);
    }

    var now = Date.now();
    var missingUrls = [];
    var waitList = [];

    for (var u = 0; u < uniqueUrls.length; u++) {
      var targetUrl = uniqueUrls[u];
      if (cacheGenerationWatcherInstalled) {
        var memHit = getMemoryArticleState(targetUrl, now);
        if (memHit) {
          out[targetUrl] = memHit;
          continue;
        }
      }
      var inflight = pendingArticleReads.get(targetUrl);
      if (inflight && !isCacheWriteStale(inflight.startedAt, cachedCacheGeneration)) {
        (function(urlKey, p) {
          waitList.push(p.then(function(st) { out[urlKey] = st; }));
        })(targetUrl, inflight.promise);
        continue;
      }
      missingUrls.push(targetUrl);
    }

    if (!missingUrls.length) {
      return Promise.all(waitList).then(function() {
        if (typeof callback === 'function') callback(out);
        return out;
      });
    }

    var startedAt = Date.now();
    function isCurrent() {
      return !isCacheWriteStale(startedAt, cachedCacheGeneration);
    }

    var batchKeys = [];
    for (var m = 0; m < missingUrls.length; m++) {
      batchKeys.push(ARTICLE_CACHE_PREFIX + missingUrls[m]);
      batchKeys.push(NEGATIVE_CACHE_KEY + missingUrls[m]);
    }
    if (cachedCacheGeneration === null || !cacheGenerationWatcherInstalled) {
      batchKeys.push(CACHE_GENERATION_KEY);
    }

    var storageSnapshotPromise = new Promise(function(resolve) {
      chrome.storage.local.get(batchKeys, function(result) {
        resolve(consumeStorageError('批量文章缓存读取失败') ? null : result);
      });
    }).then(function(result) {
      if (result && Object.prototype.hasOwnProperty.call(result, CACHE_GENERATION_KEY)) {
        rememberCacheGeneration(result[CACHE_GENERATION_KEY]);
      } else if (result && cachedCacheGeneration === null) {
        rememberCacheGeneration(0);
      }
      return result;
    });

    for (var mi = 0; mi < missingUrls.length; mi++) {
      (function(normUrl) {
        var itemPromise = storageSnapshotPromise.then(function(result) {
          return evaluateStoredArticleState(normUrl, result, startedAt, isCurrent);
        }).then(function(state) {
          out[normUrl] = state;
          return state;
        });
        var pendingItem = { startedAt: startedAt, promise: itemPromise };
        pendingArticleReads.set(normUrl, pendingItem);
        function releaseItem() {
          if (pendingArticleReads.get(normUrl) === pendingItem) pendingArticleReads.delete(normUrl);
        }
        itemPromise.then(releaseItem, releaseItem);
        waitList.push(itemPromise);
      })(missingUrls[mi]);
    }

    return Promise.all(waitList).then(function() {
      if (typeof callback === 'function') callback(out);
      return out;
    });
  }

  function hasPendingCacheFlush() {
    for (var tid in CACHE_FLUSH_PENDING) {
      if (Object.prototype.hasOwnProperty.call(CACHE_FLUSH_PENDING, tid)) return true;
    }
    return false;
  }

  function flushLoadedUrlBatch(threadId, complete) {
    var pendingStartedAt = CACHE_FLUSH_PENDING[threadId];
    delete CACHE_FLUSH_PENDING[threadId];
    var appState = getHostAppState();
    var thread = appState && appState.threads && appState.threads[threadId];
    if (!thread || !thread.loadedUrls || !thread.loadedUrls.length) return;
    var added = thread.loadedUrls.slice(thread.loadedUrlWriteOffset || 0);
    var finish = !!complete && !thread.loadedUrlCompletionWritten;
    if (!added.length && !finish) return;
    var url = thread.link;
    var writeStartedAt = getCacheWriteStartedAt(pendingStartedAt || thread.cacheWriteStartedAt);
    thread.loadedUrlWriteOffset = thread.loadedUrls.length;
    if (finish) thread.loadedUrlCompletionWritten = true;
    ATPCache.updateArticleLoadedUrls(url, added, finish, writeStartedAt).then(function(success) {
      if (!success) setTimeout(function() {
        ATPCache.updateArticleLoadedUrls(url, added, finish, writeStartedAt);
      }, 500);
    });
  }

  function runCacheWriteCheck() {
    if (cacheWriteCheckTimer) {
      clearTimeout(cacheWriteCheckTimer);
      cacheWriteCheckTimer = null;
    }
    if (cacheWriteCheckInProgress) return;
    cacheWriteCheckInProgress = true;
    cacheWritesSinceCheck = 0;
    lastCacheWriteCheckAt = Date.now();
    SharedUtils.getCacheBytesInUse(function(bytesUsed) {
      cacheWriteCheckInProgress = false;
      if (consumeStorageError('storage用量读取失败')) return;
      if (bytesUsed >= HIGH_WATERMARK) {
        ATPCache.evictLRU(null, bytesUsed);
      }
      if (cacheWritesSinceCheck > 0 && !cacheWriteCheckTimer) {
        cacheWriteCheckTimer = setTimeout(runCacheWriteCheck, CACHE_WRITE_CHECK_INTERVAL_MS);
      }
    });
  }

  function bumpCacheWrite() {
    if (SharedUtils.cacheIndex && SharedUtils.cacheIndex._backgroundOwner) {
      if (!cacheWriteCheckTimer) {
        cacheWriteCheckTimer = setTimeout(function() {
          cacheWriteCheckTimer = null;
          SharedUtils.getCacheBytesInUse(function(bytesUsed) {
            if (consumeStorageError('storage用量读取失败')) return;
            if (bytesUsed >= HIGH_WATERMARK) ATPCache.evictLRU(null, bytesUsed);
          });
        }, 500);
      }
      return;
    }
    cacheWritesSinceCheck++;
    var now = Date.now();
    var elapsed = lastCacheWriteCheckAt ? now - lastCacheWriteCheckAt : CACHE_WRITE_CHECK_INTERVAL_MS;
    if (elapsed >= CACHE_WRITE_CHECK_INTERVAL_MS || cacheWritesSinceCheck >= CACHE_WRITE_CHECK_BATCH) {
      runCacheWriteCheck();
      return;
    }
    if (!cacheWriteCheckTimer) {
      cacheWriteCheckTimer = setTimeout(runCacheWriteCheck, CACHE_WRITE_CHECK_INTERVAL_MS - elapsed);
    }
  }

  function estimateCacheEntryBytes(key, value) {
    var valLen = SharedUtils.utf8ByteLength(
      (typeof value === 'object' && value !== null) ? JSON.stringify(value) : String(value)
    );
    return key.length + valLen;
  }

  function estimateWriteBatchBytes(d) {
    return SharedUtils.utf8ByteLength(JSON.stringify(d));
  }

  function getTextCacheKeys(prefix, url) {
    return SharedUtils.getTextAttachmentCacheKeys(prefix, url);
  }

  function cleanupInvalidTextCacheKeys(keys, action) {
    if (!keys || !keys.length) return;
    chrome.storage.local.remove(keys, function() {
      if (consumeStorageError(action + '清除失败')) return;
      removeCacheIndexEntriesAfterStorageRemove(keys, action + '索引清理');
    });
  }

  function cleanupLegacyTextCacheKeys(keys, keepKey, action) {
    var removeKeys = [];
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] && keys[i] !== keepKey) removeKeys.push(keys[i]);
    }
    if (!removeKeys.length) return;
    chrome.storage.local.remove(removeKeys, function() {
      if (consumeStorageError(action + '清除失败')) return;
      removeCacheIndexEntriesAfterStorageRemove(removeKeys, action + '索引清理');
    });
  }

  function cleanupStoredLegacyTextCacheKeys(result, keys, keepKey, action) {
    var removeKeys = [];
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] && keys[i] !== keepKey && Object.prototype.hasOwnProperty.call(result || {}, keys[i]) && result[keys[i]] !== undefined) {
        removeKeys.push(keys[i]);
      }
    }
    if (!removeKeys.length) return;
    chrome.storage.local.remove(removeKeys, function() {
      if (consumeStorageError(action + '清除失败')) return;
      removeCacheIndexEntriesAfterStorageRemove(removeKeys, action + '索引清理');
    });
  }

  function getValidTextResourceEntry(result, keys, ttlMs, now) {
    var invalidKeys = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!Object.prototype.hasOwnProperty.call(result || {}, key) || result[key] === undefined) continue;
      var cached = result[key];
      var ts = cached && typeof cached === 'object' ? Number(cached.ts) : NaN;
      if (cached && isFinite(ts) && now - ts < ttlMs && cached.resources) {
        var normalizedResources = SharedUtils.normalizeResources(cached.resources);
        if (SharedUtils.hasResourcePayload(normalizedResources)) {
          return { key: key, value: cached, resources: normalizedResources, invalidKeys: invalidKeys };
        }
      }
      invalidKeys.push(key);
    }
    return { key: '', value: null, resources: null, invalidKeys: invalidKeys };
  }

  function getValidTextFailEntry(result, keys, ttlMs, now) {
    var invalidKeys = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!Object.prototype.hasOwnProperty.call(result || {}, key) || result[key] === undefined) continue;
      var ts = result[key];
      if (typeof ts === 'number' && isFinite(ts) && now - ts < ttlMs) {
        return { key: key, value: ts, invalidKeys: invalidKeys };
      }
      invalidKeys.push(key);
    }
    return { key: '', value: 0, invalidKeys: invalidKeys };
  }

  function getIndexType(key) {
    if (key.indexOf(IMAGE_CACHE_PREFIX) === 0) return SharedUtils.cacheIndex.TYPE.IMAGE;
    if (SharedUtils.isHashedTextAttachmentCacheKey(key, TEXT_RESOURCE_CACHE_PREFIX)) return SharedUtils.cacheIndex.TYPE.TEXT_RESOURCE;
    if (SharedUtils.isHashedTextAttachmentCacheKey(key, TEXT_FAIL_CACHE_PREFIX)) return SharedUtils.cacheIndex.TYPE.TEXT_FAIL;
    if (key.indexOf(ARTICLE_CACHE_PREFIX) === 0) return SharedUtils.cacheIndex.TYPE.ARTICLE;
    if (key.indexOf(NEGATIVE_CACHE_KEY) === 0) return SharedUtils.cacheIndex.TYPE.NEGATIVE;
    return -1;
  }

  function getWriteKeys(d) {
    var keys = [];
    for (var dk in d) {
      if (Object.prototype.hasOwnProperty.call(d, dk)) keys.push(dk);
    }
    return keys;
  }

  function stampCacheWrite(d, writeStartedAt) {
    Object.defineProperty(d, '__atpWriteStartedAt', {
      value: getCacheWriteStartedAt(writeStartedAt),
      enumerable: false,
      configurable: true
    });
    return d;
  }

  function cacheWriteValueMatches(currentValue, writtenValue) {
    if (currentValue === writtenValue) return true;
    if (!currentValue || !writtenValue || typeof currentValue !== 'object' || typeof writtenValue !== 'object') return false;
    try {
      return JSON.stringify(currentValue) === JSON.stringify(writtenValue);
    } catch (e) {
      return false;
    }
  }

  function removeStaleCacheWrite(d, callback) {
    var keys = getWriteKeys(d);
    if (!keys.length) {
      if (callback) callback();
      return;
    }
    chrome.storage.local.get(keys, function(result) {
      if (consumeStorageError('stale cache write cleanup read failed')) {
        if (callback) callback();
        return;
      }
      var ownedKeys = [];
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (
          Object.prototype.hasOwnProperty.call(result, key) &&
          cacheWriteValueMatches(result[key], d[key])
        ) {
          ownedKeys.push(key);
        }
      }
      if (!ownedKeys.length) {
        if (callback) callback();
        return;
      }
      chrome.storage.local.remove(ownedKeys, function() {
        consumeStorageError('stale cache write cleanup failed');
        if (callback) callback();
      });
    });
  }

  function repairCacheIndexAfterWriteFailure() {
    if (CACHE_INDEX_REPAIR_IN_FLIGHT) return;
    CACHE_INDEX_REPAIR_IN_FLIGHT = true;
    try {
      SharedUtils.cacheIndex.rebuild(function(entries) {
        CACHE_INDEX_REPAIR_IN_FLIGHT = false;
        if (!entries) logWarn('缓存索引自愈失败', 'cacheIndex rebuild failed');
      });
    } catch (e) {
      CACHE_INDEX_REPAIR_IN_FLIGHT = false;
      logWarn('缓存索引自愈异常', e && e.message ? e.message : String(e));
    }
  }

  function updateIndexForWrite(d) {
    var updates = {};
    var hasUpdates = false;
    for (var dk in d) {
      if (Object.prototype.hasOwnProperty.call(d, dk)) {
        var type = getIndexType(dk);
        if (type < 0) continue;
        var val = d[dk];
        var ts = (typeof val === 'object' && val !== null) ? (val.ts || Date.now()) : Date.now();
        updates[dk] = { t: type, ts: ts, b: estimateCacheEntryBytes(dk, val) };
        hasUpdates = true;
      }
    }
    if (hasUpdates) {
      SharedUtils.cacheIndex.updateEntries(updates, function(success) {
        if (success === false) repairCacheIndexAfterWriteFailure();
      });
    }
  }

  function verifyPostWriteGenerationFresh(writeStartedAt, callback) {
    chrome.storage.local.get(CACHE_GENERATION_KEY, function(result) {
      if (consumeStorageError('cache generation read failed')) {
        callback(false);
        return;
      }
      rememberCacheGeneration(result && result[CACHE_GENERATION_KEY]);
      callback(!isCacheWriteStale(writeStartedAt, cachedCacheGeneration));
    });
  }

  function safeSetWithRetry(d, onDone, warnMsg, writeStartedAt) {
    if (writeStartedAt === undefined && d && d.__atpWriteStartedAt) {
      writeStartedAt = d.__atpWriteStartedAt;
    }
    writeStartedAt = getCacheWriteStartedAt(writeStartedAt);
    function finish(success) {
      if (onDone) onDone(!!success);
    }
    function finishSuccessfulSet() {
      verifyPostWriteGenerationFresh(writeStartedAt, function(fresh) {
        if (!fresh) {
          removeStaleCacheWrite(d, function() {
            finish(false);
          });
          return;
        }
        updateIndexForWrite(d);
        bumpCacheWrite();
        finish(true);
      });
    }
    function attemptSet(canEvict) {
      checkCacheWriteFreshFast(writeStartedAt, function(fresh) {
        if (!fresh) {
          finish(false);
          return;
        }
        chrome.storage.local.set(d, function() {
          if (chrome.runtime.lastError) {
            logWarn(warnMsg || '缓存写入失败', chrome.runtime.lastError.message);
            if (!canEvict) {
              finish(false);
              return;
            }
            SharedUtils.getCacheBytesInUse(function(bytesUsed) {
              if (consumeStorageError('storage用量读取失败')) {
                finish(false);
                return;
              }
              var baseline = bytesUsed + estimateWriteBatchBytes(d);
              ATPCache.evictLRU(function() {
                attemptSet(false);
              }, baseline);
            });
            return;
          }
          finishSuccessfulSet();
        });
      });
    }
    attemptSet(true);
  }

  var ATPCache = {
    IMAGE_CACHE_PREFIX: IMAGE_CACHE_PREFIX,
    ARTICLE_CACHE_PREFIX: ARTICLE_CACHE_PREFIX,
    TEXT_RESOURCE_CACHE_PREFIX: TEXT_RESOURCE_CACHE_PREFIX,
    NEGATIVE_CACHE_KEY: NEGATIVE_CACHE_KEY,
    QUOTA_BYTES: QUOTA_BYTES,
    HIGH_WATERMARK: HIGH_WATERMARK,
    TARGET_WATERMARK: TARGET_WATERMARK,
    MAX_MEMORY_ARTICLES: MAX_MEMORY_ARTICLES,

    getSettings: function() {
      var appState = getHostAppState();
      if (appState && appState.settings) return appState.settings;
      if (root && root.ATPBackgroundSettings) return root.ATPBackgroundSettings;
      return null;
    },

    getCachedImages: function(url) {
      return ATPCache.getCachedArticleData(url).then(function(data) {
        return data ? data.images : null;
      });
    },

    getCachedArticleData: function(url, callback) {
      return ATPCache.getArticleCacheState(url).then(function(state) {
        var cached = state ? state.cached : null;
        if (typeof callback === 'function') callback(cached);
        return cached;
      });
    },

    getArticleCacheState: function(url, callback) {
      return readArticleCacheState(SharedUtils.normalizeArticleUrl(url)).then(function(state) {
        if (typeof callback === 'function') callback(state);
        return state;
      });
    },

    getCachedArticlesBatch: getCachedArticlesBatch,

    setCachedArticleData: function(url, data, complete, writeStartedAt, operation) {
      writeStartedAt = getCacheWriteStartedAt(writeStartedAt);
      var normalizedUrl = SharedUtils.normalizeArticleUrl(url);
      var op = operation || 'article';

      function updateLocalMemoryAfterWrite(snapshot) {
        if (!normalizedUrl || isCacheWriteStale(writeStartedAt, cachedCacheGeneration)) return;
        memoryArticleCache.delete(normalizedUrl);
        if (snapshot && Array.isArray(snapshot.loadedUrls)) {
          rememberPersistedLoadedUrls(normalizedUrl, snapshot.loadedUrls, !!complete && !snapshot.partial);
        }
      }

      function writeSnapshot() {
        var snapshot = (data && typeof data === 'object' && preparedArticles.has(data))
          ? ATPArticleCacheData.normalizeFields(data, data.images, data.loadedUrls)
          : ATPArticleCacheData.normalize(data);
        return sendArticleCacheMutation(url, op, {
          data: snapshot,
          complete: !!complete
        }, writeStartedAt).then(function(ok) {
          if (ok) updateLocalMemoryAfterWrite(snapshot);
          return ok;
        });
      }

      if (op !== 'text' || !data || !Array.isArray(data.images) || !data.images.length) {
        return writeSnapshot();
      }
      var slimSnapshot = ATPArticleCacheData.normalize(Object.assign({}, data, { images: [] }));
      return sendArticleCacheMutation(url, 'textProgress', {
        data: slimSnapshot,
        complete: !!complete
      }, writeStartedAt, writeSnapshot).then(function(ok) {
        if (ok && normalizedUrl) {
          memoryArticleCache.delete(normalizedUrl);
        }
        return ok;
      });
    },

    updateArticleLoadedUrls: function(url, loadedUrls, complete, writeStartedAt) {
      var normalizedUrl = SharedUtils.normalizeArticleUrl(url);
      writeStartedAt = getCacheWriteStartedAt(writeStartedAt);
      var rawList = Array.isArray(loadedUrls) ? loadedUrls : [];
      var cleanUrls = [];
      var batchSeen = Object.create(null);
      for (var i = 0; i < rawList.length; i++) {
        var cleaned = String(rawList[i] || '').trim().replace(/\\\//g, '/');
        if (cleaned && !batchSeen[cleaned]) {
          batchSeen[cleaned] = true;
          cleanUrls.push(cleaned);
        }
      }

      var last = normalizedUrl ? lastPersistedLoadedUrls.get(normalizedUrl) : null;
      var delta = cleanUrls;
      if (last) {
        delta = [];
        for (var d = 0; d < cleanUrls.length; d++) {
          if (!last.set.has(cleanUrls[d])) delta.push(cleanUrls[d]);
        }
        if (!delta.length && (!complete || last.complete)) {
          return Promise.resolve(true);
        }
      }

      return sendArticleCacheMutation(normalizedUrl || url, 'loadedUrls', {
        loadedUrls: delta,
        complete: !!complete
      }, writeStartedAt).then(function(ok) {
        if (ok && normalizedUrl && !isCacheWriteStale(writeStartedAt, cachedCacheGeneration)) {
          rememberPersistedLoadedUrls(normalizedUrl, delta, !!complete);
          var memEntry = memoryArticleCache.get(normalizedUrl);
          if (memEntry && memEntry.kind === 'positive' && memEntry.data) {
            var updatedRec = ATPArticleCacheData.applyMutation(
              { data: memEntry.data, ts: memEntry.ts, complete: memEntry.complete },
              { operation: 'loadedUrls', loadedUrls: delta, complete: !!complete, writeStartedAt: writeStartedAt },
              getArticleCacheTTLMS(),
              Date.now()
            );
            if (updatedRec && updatedRec.data) {
              preparedArticles.add(updatedRec.data);
              memEntry.data = updatedRec.data;
              memEntry.complete = updatedRec.complete;
            }
          }
        }
        return ok;
      });
    },

    getCachedTextResources: async function(url) {
      if (root && root.ATPSettingsReady) {
        try { await root.ATPSettingsReady; } catch (e) {}
      }
      var readStartedAt = Date.now();
      var keys = getTextCacheKeys(TEXT_RESOURCE_CACHE_PREFIX, url);
      if (!keys.length) return null;
      var primaryKey = keys[0];
      var needSettingsRead = !ATPCache.getSettings();
      var readKeys = needSettingsRead ? keys.concat(['settings']) : keys;
      return new Promise(function(resolve) {
        chrome.storage.local.get(readKeys, function(result) {
          if (consumeStorageError('TXT缓存读取失败')) {
            resolve(null);
            return;
          }
          var settings = ATPCache.getSettings() || (result && result.settings) || {};
          var ttlMs = ((settings && settings.cacheTTL) || 30) * 60 * 1000;
          var entry = getValidTextResourceEntry(result, keys, ttlMs, Date.now());
          if (entry && entry.key) {
            if (entry.key !== primaryKey) {
              var d = {};
              d[primaryKey] = entry.value;
              stampCacheWrite(d, readStartedAt);
              safeSetWithRetry(d, function(success) {
                if (success) cleanupLegacyTextCacheKeys(keys, primaryKey, '旧TXT资源缓存');
              }, 'TXT缓存迁移写入失败');
            } else {
              cleanupStoredLegacyTextCacheKeys(result, keys, primaryKey, '旧TXT资源缓存');
            }
            resolve(entry.resources);
            return;
          }
          if (entry.invalidKeys.length) cleanupInvalidTextCacheKeys(entry.invalidKeys, '无效TXT资源缓存');
          resolve(null);
        });
      });
    },

    setCachedTextResources: function(url, resources, writeStartedAt) {
      if (SharedUtils.isDiscuzAttachmentUrl(url, url)) return;
      var keys = getTextCacheKeys(TEXT_RESOURCE_CACHE_PREFIX, url);
      if (!keys.length) return;
      var primaryKey = keys[0];
      var normalizedResources = SharedUtils.normalizeResources(resources);
      var d = {};
      d[primaryKey] = {
        resources: normalizedResources,
        ts: Date.now()
      };
      stampCacheWrite(d, writeStartedAt);
      safeSetWithRetry(d, function(success) {
        if (success) cleanupLegacyTextCacheKeys(keys, primaryKey, '旧TXT资源缓存');
      }, 'TXT缓存写入失败');
    },

    evictLRU: function(callback, baselineBytes) {
      if (callback) pendingEvictCallbacks.push(callback);
      if (typeof baselineBytes === 'number' && baselineBytes > pendingEvictBaseline) {
        pendingEvictBaseline = baselineBytes;
      }
      if (evictionInProgress) return;
      evictionInProgress = true;
      var useBaseline = pendingEvictBaseline || baselineBytes;
      pendingEvictBaseline = 0;

      function finishAllCallbacks() {
        evictionInProgress = false;
        if (pendingEvictBaseline > 0) {
          var retryBaseline = pendingEvictBaseline;
          pendingEvictBaseline = 0;
          ATPCache.evictLRU(null, retryBaseline);
          return;
        }
        var cbs = pendingEvictCallbacks;
        pendingEvictCallbacks = [];
        for (var i = 0; i < cbs.length; i++) cbs[i]();
      }

      function proceedAfterSettings() {
        var fetchEntries = SharedUtils.cacheIndex.getEntriesForEviction
          ? SharedUtils.cacheIndex.getEntriesForEviction
          : SharedUtils.cacheIndex.rebuild;
        fetchEntries(function(entries) {
          if (!entries) {
            logWarn('LRU淘汰跳过', '缓存索引重建失败');
            pendingEvictBaseline = 0;
            finishAllCallbacks();
            return;
          }
          ATPCache._evictFromEntries(entries, finishAllCallbacks, useBaseline);
        });
      }

      if (root && root.ATPSettingsReady) {
        root.ATPSettingsReady.then(proceedAfterSettings, proceedAfterSettings);
      } else {
        proceedAfterSettings();
      }
    },

    _evictFromEntries: function(entries, callback, baselineBytes) {
      var cacheEntries = [];
      var totalEstimated = 0;
      for (var key in entries) {
        if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
        var e = entries[key];
        if (!e) continue;
        cacheEntries.push({ key: key, ts: e.ts, priority: e.t, estimatedBytes: e.b });
        totalEstimated += e.b;
      }

      var baseline = (typeof baselineBytes === 'number' && baselineBytes > 0)
        ? baselineBytes
        : totalEstimated;
      if (baseline <= TARGET_WATERMARK) {
        if (callback) callback();
        return;
      }

      var expiredBefore = Date.now() - getArticleCacheTTLMS();
      cacheEntries.sort(function(a, b) {
        var aExpired = a.ts < expiredBefore;
        var bExpired = b.ts < expiredBefore;
        if (aExpired !== bExpired) return aExpired ? -1 : 1;
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.ts - b.ts;
      });

      var removeKeys = [];
      var freed = 0;
      for (var i = 0; i < cacheEntries.length; i++) {
        if (baseline - freed <= TARGET_WATERMARK) break;
        removeKeys.push(cacheEntries[i].key);
        freed += cacheEntries[i].estimatedBytes;
      }

      if (removeKeys.length > 0) {
        chrome.storage.local.remove(removeKeys, function() {
          if (consumeStorageError('LRU淘汰失败')) {
            if (callback) callback();
            return;
          }
          for (var ri = 0; ri < removeKeys.length; ri++) {
            var rk = removeKeys[ri];
            if (rk.indexOf(ARTICLE_CACHE_PREFIX) === 0) {
              var evictedUrl = rk.slice(ARTICLE_CACHE_PREFIX.length);
              memoryArticleCache.delete(evictedUrl);
              lastPersistedLoadedUrls.delete(evictedUrl);
            } else if (rk.indexOf(NEGATIVE_CACHE_KEY) === 0) {
              memoryArticleCache.delete(rk.slice(NEGATIVE_CACHE_KEY.length));
            }
          }
          removeCacheIndexEntriesAfterStorageRemove(removeKeys, 'LRU淘汰索引清理', function(indexOk) {
            if (indexOk) {
              logDebug('LRU淘汰', removeKeys.length + '条缓存，释放约' + freed + '字节');
            } else {
              logWarn('LRU淘汰索引清理失败', removeKeys.length + '条缓存已删除，索引未确认');
            }
            if (callback) callback();
          });
        });
      } else {
        if (callback) callback();
      }
    },

    getCacheStats: function(callback) {
      SharedUtils.getCacheBytesInUse(function(totalBytes) {
        if (consumeStorageError('storage用量读取失败')) {
          callback({ count: 0, bytesUsed: 0, quotaBytes: QUOTA_BYTES });
          return;
        }
        SharedUtils.cacheIndex.getStats(function(stats) {
          callback({ count: stats.count, bytesUsed: totalBytes, quotaBytes: QUOTA_BYTES });
        });
      });
    },

    getNegativeCache: function(url) {
      var normalizedUrl = SharedUtils.normalizeArticleUrl(url);
      if (cacheGenerationWatcherInstalled) {
        var mem = getMemoryArticleState(normalizedUrl, Date.now());
        if (mem) return Promise.resolve(!!mem.negative);
      }
      var fullKey = NEGATIVE_CACHE_KEY + normalizedUrl;
      return new Promise(function(resolve) {
        chrome.storage.local.get(fullKey, function(r) {
          if (consumeStorageError('失败缓存读取失败')) {
            resolve(false);
            return;
          }
          resolve(!!readNegativeCache(r, fullKey, Date.now()));
        });
      });
    },

    setNegativeCache: function(url, writeStartedAt) {
      var normalizedUrl = SharedUtils.normalizeArticleUrl(url);
      var now = Date.now();
      var started = getCacheWriteStartedAt(writeStartedAt);
      var d = {};
      d[NEGATIVE_CACHE_KEY + normalizedUrl] = now;
      stampCacheWrite(d, started);
      safeSetWithRetry(d, function(ok) {
        if (ok && cacheGenerationWatcherInstalled && !isCacheWriteStale(started, cachedCacheGeneration)) {
          var existing = memoryArticleCache.get(normalizedUrl);
          if (!existing || existing.kind !== 'positive') {
            setMemoryArticleEntry(normalizedUrl, {
              kind: 'negative',
              data: null,
              ts: now,
              complete: false,
              readStartedAt: Math.max(started, now),
              expiresAt: now + NEGATIVE_TTL_MS
            });
          }
        }
      }, '负缓存写入失败');
    },

    getTextFailCache: function(url) {
      var readStartedAt = Date.now();
      var keys = getTextCacheKeys(TEXT_FAIL_CACHE_PREFIX, url);
      if (!keys.length) return Promise.resolve(false);
      var primaryKey = keys[0];
      return new Promise(function(resolve) {
        chrome.storage.local.get(keys, function(r) {
          if (consumeStorageError('TXT失败缓存读取失败')) {
            resolve(false);
            return;
          }
          var entry = getValidTextFailEntry(r, keys, TEXT_FAIL_TTL_MS, Date.now());
          if (entry && entry.key) {
            if (entry.key !== primaryKey) {
              var d = {};
              d[primaryKey] = entry.value;
              stampCacheWrite(d, readStartedAt);
              safeSetWithRetry(d, function(success) {
                if (success) cleanupLegacyTextCacheKeys(keys, primaryKey, '旧TXT失败缓存');
              }, 'TXT失败缓存迁移写入失败');
            } else {
              cleanupStoredLegacyTextCacheKeys(r, keys, primaryKey, '旧TXT失败缓存');
            }
            resolve(true);
            return;
          }
          if (entry.invalidKeys.length) cleanupInvalidTextCacheKeys(entry.invalidKeys, '无效TXT失败缓存');
          resolve(false);
        });
      });
    },

    setTextFailCache: function(url, writeStartedAt) {
      if (SharedUtils.isDiscuzAttachmentUrl(url, url)) return;
      var keys = getTextCacheKeys(TEXT_FAIL_CACHE_PREFIX, url);
      if (!keys.length) return;
      var primaryKey = keys[0];
      var d = {};
      d[primaryKey] = Date.now();
      stampCacheWrite(d, writeStartedAt);
      safeSetWithRetry(d, function(success) {
        if (success) cleanupLegacyTextCacheKeys(keys, primaryKey, '旧TXT失败缓存');
      }, 'TXT失败缓存写入失败');
    },

    clearTextFailCache: function(url) {
      var keys = getTextCacheKeys(TEXT_FAIL_CACHE_PREFIX, url);
      if (!keys.length) return;
      chrome.storage.local.remove(keys, function() {
        if (consumeStorageError('TXT失败缓存清除失败')) return;
        removeCacheIndexEntriesAfterStorageRemove(keys, 'TXT失败缓存索引清理');
      });
    },

    scheduleCacheFlush: function(threadId, writeStartedAt) {
      if (CACHE_FLUSH_PENDING[threadId]) return;
      CACHE_FLUSH_PENDING[threadId] = getCacheWriteStartedAt(writeStartedAt);
      if (CACHE_FLUSH_TIMER) return;
      CACHE_FLUSH_TIMER = setTimeout(function() {
        CACHE_FLUSH_TIMER = null;
        ATPCache.flushCacheNow();
      }, CACHE_FLUSH_DEBOUNCE_MS);
    },

    flushCacheNow: function(threadId, complete) {
      if (threadId) {
        flushLoadedUrlBatch(threadId, complete);
      } else {
        for (var tid in CACHE_FLUSH_PENDING) {
          if (Object.prototype.hasOwnProperty.call(CACHE_FLUSH_PENDING, tid)) {
            flushLoadedUrlBatch(tid, false);
          }
        }
      }
      if (!hasPendingCacheFlush() && CACHE_FLUSH_TIMER) {
        clearTimeout(CACHE_FLUSH_TIMER);
        CACHE_FLUSH_TIMER = null;
      }
    },

    getPendingFlush: function() {
      return CACHE_FLUSH_PENDING;
    },

    prepareArticleData: prepareArticleData,
    runArticlePreparation: runArticlePreparation,
    isArticleCacheReadCurrent: isArticleCacheReadCurrent,

    normalizeArticleData: function(data) {
      return (data && typeof data === 'object' && preparedArticles.has(data))
        ? data
        : ATPArticleCacheData.normalize(data);
    },

    clearFlushTimer: function() {
      if (CACHE_FLUSH_TIMER) {
        clearTimeout(CACHE_FLUSH_TIMER);
        CACHE_FLUSH_TIMER = null;
      }
    },

    clearMemoryCache: function() {
      memoryArticleCache.clear();
      lastPersistedLoadedUrls.clear();
    },

    // Shared internal backend hooks for background.js so Service Worker reuses
    // cache.js storage/eviction/generation/index logic without duplicating it.
    _setStorageWithEviction: function(d, warnMsg, onDone, writeStartedAt) {
      safeSetWithRetry(d, onDone, warnMsg, writeStartedAt);
    },
    _updateIndexForWrite: updateIndexForWrite,
    _removeCacheIndexEntriesAfterStorageRemove: removeCacheIndexEntriesAfterStorageRemove,
    _rememberCacheGeneration: rememberCacheGeneration
  };

  root.ATPCache = ATPCache;
  if (typeof window !== 'undefined' && window) {
    window.ATPCache = ATPCache;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
