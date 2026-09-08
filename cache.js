(function () {
  'use strict';

  var IMAGE_CACHE_PREFIX = SharedUtils.CACHE_PREFIXES.IMAGE;
  var ARTICLE_CACHE_PREFIX = SharedUtils.CACHE_PREFIXES.ARTICLE;
  var TEXT_RESOURCE_CACHE_PREFIX = SharedUtils.CACHE_PREFIXES.TEXT_RESOURCE;
  var TEXT_FAIL_CACHE_PREFIX = SharedUtils.CACHE_PREFIXES.TEXT_FAIL;
  var NEGATIVE_CACHE_KEY = SharedUtils.CACHE_PREFIXES.NEGATIVE;
  var CACHE_GENERATION_KEY = SharedUtils.CACHE_GENERATION_KEY || 'atp_cache_generation_v1';
  var CACHE_FLUSH_TIMER = null;
  var CACHE_FLUSH_PENDING = {};
  var QUOTA_BYTES = 10485760;
  var HIGH_WATERMARK = Math.floor(QUOTA_BYTES * 0.85);
  var TARGET_WATERMARK = Math.floor(QUOTA_BYTES * 0.75);
  var ARTICLE_WRITE_QUEUES = {};
  var NEGATIVE_TTL_MS = 5 * 60 * 1000;
  var evictionInProgress = false;
  var pendingEvictCallbacks = [];
  var pendingEvictBaseline = 0;
  var lastRebuildEntries = null;
  var lastRebuildAt = 0;
  var REBUILD_CACHE_TTL = 30000;
  var CACHE_WRITE_CHECK_INTERVAL_MS = 5000;
  var CACHE_WRITE_CHECK_BATCH = 12;
  var CACHE_INDEX_REPAIR_IN_FLIGHT = false;
  var cacheWriteCheckTimer = null;
  var lastCacheWriteCheckAt = 0;
  var cacheWritesSinceCheck = 0;
  var cacheWriteCheckInProgress = false;

  function consumeStorageError(action) {
    if (!chrome.runtime.lastError) return false;
    Logger.warn(action, chrome.runtime.lastError.message);
    return true;
  }

  function warnCacheIndexCleanup(action, message) {
    if (typeof Logger !== 'undefined' && Logger.warn) {
      Logger.warn(action, message);
    } else if (typeof console !== 'undefined' && console.warn) {
      console.warn('[cacheIndex] ' + action + ': ' + message);
    }
  }

  function removeCacheIndexEntriesAfterStorageRemove(keys, action, callback) {
    SharedUtils.cacheIndex.removeEntries(keys, function(success) {
      if (success === false) {
        warnCacheIndexCleanup(action, '索引删除失败，尝试重建');
        SharedUtils.cacheIndex.rebuild(function(entries) {
          if (!entries) warnCacheIndexCleanup(action, '索引重建失败');
          if (callback) callback(!!entries);
        });
        return;
      }
      if (callback) callback(true);
    });
  }

  function getArticleCacheTTLMS() {
    var settings = ATPCache.getSettings();
    return ((settings && settings.cacheTTL) || 30) * 60 * 1000;
  }

  function readCachedArticle(result, articleKey, now) {
    var article = result && result[articleKey];
    if (article && now - article.ts < getArticleCacheTTLMS() && article.complete && article.data) {
      return ATPCache.normalizeArticleData(article.data);
    }
    return null;
  }

  function clearExpiredNegativeCache(fullKey) {
    chrome.storage.local.remove(fullKey, function() {
      if (consumeStorageError('过期失败缓存清除失败')) return;
      removeCacheIndexEntriesAfterStorageRemove([fullKey], '过期失败缓存索引清理');
    });
  }

  function clearNegativeCacheForNormalizedUrl(normalizedUrl) {
    var fullKey = NEGATIVE_CACHE_KEY + normalizedUrl;
    chrome.storage.local.remove(fullKey, function() {
      if (consumeStorageError('负缓存清理失败')) return;
      removeCacheIndexEntriesAfterStorageRemove([fullKey], '负缓存索引清理');
    });
  }

  function readNegativeCache(result, fullKey, now) {
    var v = result && result[fullKey];
    if (!v) return null;
    if (now - v >= NEGATIVE_TTL_MS) {
      clearExpiredNegativeCache(fullKey);
      return null;
    }
    return {
      hit: true,
      ts: v,
      expiresAt: v + NEGATIVE_TTL_MS,
      remainingMs: Math.max(0, v + NEGATIVE_TTL_MS - now)
    };
  }

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
    item.src = SharedUtils.decodeHtmlEntities(String(item.src)).trim().replace(/\\\//g, '/');
    if (!SharedUtils.isMeaningfulImage(item.src)) return null;
    if (item.previewSrc) {
      item.previewSrc = SharedUtils.decodeHtmlEntities(String(item.previewSrc)).trim().replace(/\\\//g, '/');
      if (!SharedUtils.isMeaningfulImage(item.previewSrc)) delete item.previewSrc;
    }
    if (item.displaySrc) {
      item.displaySrc = SharedUtils.decodeHtmlEntities(String(item.displaySrc)).trim().replace(/\\\//g, '/');
      if (!SharedUtils.isMeaningfulImage(item.displaySrc)) delete item.displaySrc;
    }
    return item;
  }

  function normalizeCachedImages(images) {
    var out = [];
    var seen = {};
    images = Array.isArray(images) ? images : [];
    for (var i = 0; i < images.length; i++) {
      var item = normalizeCachedImage(images[i]);
      if (!item) continue;
      var key = SharedUtils.normalizeImageUrl(SharedUtils.getImagePreviewSrc(item));
      if (seen[key]) continue;
      seen[key] = true;
      out.push(item);
    }
    return out;
  }

  function normalizeCachedUrls(urls) {
    var out = [];
    var seen = {};
    urls = Array.isArray(urls) ? urls : [];
    for (var i = 0; i < urls.length; i++) {
      var url = SharedUtils.decodeHtmlEntities(String(urls[i] || '')).trim().replace(/\\\//g, '/');
      if (!url || seen[url]) continue;
      seen[url] = true;
      out.push(url);
    }
    return out;
  }

  function hasPendingCacheFlush() {
    for (var tid in CACHE_FLUSH_PENDING) return true;
    return false;
  }

  function normalizeCachedTextAttachments(attachments) {
    var out = [];
    var seen = {};
    var maxCount = SharedUtils.TEXT_ATTACHMENT_MAX_COUNT || 3;
    attachments = Array.isArray(attachments) ? attachments : [];
    for (var i = 0; i < attachments.length && out.length < maxCount; i++) {
      var raw = typeof attachments[i] === 'string' ? { url: attachments[i] } : Object.assign({}, attachments[i] || {});
      var url = SharedUtils.decodeHtmlEntities(String(raw.url || '')).trim().replace(/\\\//g, '/');
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
      var url = SharedUtils.decodeHtmlEntities(String(raw.url || '')).trim().replace(/\\\//g, '/');
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

  function runCacheWriteCheck() {
    if (cacheWriteCheckTimer) {
      clearTimeout(cacheWriteCheckTimer);
      cacheWriteCheckTimer = null;
    }
    if (cacheWriteCheckInProgress) return;
    cacheWriteCheckInProgress = true;
    cacheWritesSinceCheck = 0;
    lastCacheWriteCheckAt = Date.now();
    chrome.storage.local.getBytesInUse(null, function(bytesUsed) {
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

  function getPrimaryTextCacheKey(prefix, url) {
    var keys = getTextCacheKeys(prefix, url);
    return keys.length ? keys[0] : '';
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

  // 代数值仅在用户手动清缓存时变化，用内存缓存 + onChanged 同步，省去写前的存储读取
  var cachedCacheGeneration = null;
  var cacheGenerationWatcherInstalled = false;

  function ensureCacheGenerationWatcher() {
    if (cacheGenerationWatcherInstalled) return;
    cacheGenerationWatcherInstalled = true;
    try {
      chrome.storage.onChanged.addListener(function(changes, area) {
        if (area === 'local' && changes && changes[CACHE_GENERATION_KEY]) {
          cachedCacheGeneration = getCacheGeneration(changes[CACHE_GENERATION_KEY].newValue);
        }
      });
    } catch (e) {
      cacheGenerationWatcherInstalled = false;
    }
  }

  // 写前快速检查：优先用内存缓存的代数值；写后仍走权威读取兜底正确性
  function checkCacheWriteFreshFast(writeStartedAt, callback) {
    ensureCacheGenerationWatcher();
    if (cachedCacheGeneration !== null) {
      callback(!isCacheWriteStale(writeStartedAt, cachedCacheGeneration));
      return;
    }
    checkCacheWriteFresh(writeStartedAt, callback);
  }

  function checkCacheWriteFresh(writeStartedAt, callback) {
    ensureCacheGenerationWatcher();
    chrome.storage.local.get(CACHE_GENERATION_KEY, function(result) {
      if (consumeStorageError('cache generation read failed')) {
        callback(false);
        return;
      }
      var generation = getCacheGeneration(result[CACHE_GENERATION_KEY]);
      cachedCacheGeneration = generation;
      callback(!isCacheWriteStale(writeStartedAt, generation));
    });
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
    lastRebuildEntries = null;
    lastRebuildAt = 0;
    try {
      SharedUtils.cacheIndex.rebuild(function(entries) {
        CACHE_INDEX_REPAIR_IN_FLIGHT = false;
        if (!entries) Logger.warn('缓存索引自愈失败', 'cacheIndex rebuild failed');
      });
    } catch (e) {
      CACHE_INDEX_REPAIR_IN_FLIGHT = false;
      Logger.warn('缓存索引自愈异常', e && e.message ? e.message : String(e));
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

  function safeSetWithRetry(d, onDone, warnMsg, writeStartedAt) {
    if (writeStartedAt === undefined && d && d.__atpWriteStartedAt) {
      writeStartedAt = d.__atpWriteStartedAt;
    }
    writeStartedAt = getCacheWriteStartedAt(writeStartedAt);
    function finish(success) {
      if (onDone) onDone(!!success);
    }
    function finishSuccessfulSet() {
      checkCacheWriteFresh(writeStartedAt, function(fresh) {
        if (!fresh) {
          removeStaleCacheWrite(d, function() {
            finish(false);
          });
          return;
        }
        updateIndexForWrite(d);
        bumpCacheWrite();
        lastRebuildEntries = null;
        lastRebuildAt = 0;
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
        Logger.warn(warnMsg || '缓存写入失败', chrome.runtime.lastError.message);
        if (!canEvict) {
          finish(false);
          return;
        }
        chrome.storage.local.getBytesInUse(null, function(bytesUsed) {
          if (consumeStorageError('storage用量读取失败')) {
            finish(false);
            return;
          }
          var baseline = bytesUsed + estimateWriteBatchBytes(d);
          ATPCache.evictLRU(function() {
            checkCacheWriteFreshFast(writeStartedAt, function(retryFresh) {
              if (!retryFresh) {
                finish(false);
                return;
              }
            chrome.storage.local.set(d, function() {
              if (chrome.runtime.lastError) {
                Logger.warn('淘汰后重试仍失败', chrome.runtime.lastError.message);
                finish(false);
              } else {
                finishSuccessfulSet();
              }
            });
            });
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

  function enqueueArticleWrite(key, updater, onSuccess, writeStartedAt) {
    writeStartedAt = getCacheWriteStartedAt(writeStartedAt);
    var previous = ARTICLE_WRITE_QUEUES[key] || Promise.resolve();
    var next = previous.catch(function() {}).then(function() {
      return new Promise(function(resolve) {
        chrome.storage.local.get(key, function(result) {
          if (consumeStorageError('文章缓存读取失败')) {
            resolve(false);
            return;
          }
          var current = result[key] || null;
          var updated;
          try {
            updated = updater(current);
          } catch (e) {
            // updater 抛错时必须落定 Promise，否则该 key 的写入队列会永久卡死
            Logger.warn('文章缓存更新器异常', key + ' ' + (e && e.message ? e.message : String(e)));
            resolve(false);
            return;
          }
          if (!updated) {
            resolve();
            return;
          }
          var d = {};
          d[key] = updated;
          stampCacheWrite(d, writeStartedAt);
          safeSetWithRetry(d, function(success) {
            if (!success) Logger.warn('文章缓存写入放弃', key);
            if (success && onSuccess) onSuccess();
            resolve(success);
          }, '文章缓存写入失败');
        });
      });
    });
    ARTICLE_WRITE_QUEUES[key] = next;
    next.then(function() {
      if (ARTICLE_WRITE_QUEUES[key] === next) delete ARTICLE_WRITE_QUEUES[key];
    }, function() {
      if (ARTICLE_WRITE_QUEUES[key] === next) delete ARTICLE_WRITE_QUEUES[key];
    });
  }

  var ATPCache = {
    IMAGE_CACHE_PREFIX: IMAGE_CACHE_PREFIX,
    ARTICLE_CACHE_PREFIX: ARTICLE_CACHE_PREFIX,
    TEXT_RESOURCE_CACHE_PREFIX: TEXT_RESOURCE_CACHE_PREFIX,
    NEGATIVE_CACHE_KEY: NEGATIVE_CACHE_KEY,

    getSettings: function() {
      return window.ATPState && window.ATPState.settings;
    },

    getCachedImages: function(url) {
      return ATPCache.getCachedArticleData(url).then(function(data) {
        return data ? data.images : null;
      });
    },

    getCachedArticleData: function(url) {
      var normalizedUrl = SharedUtils.normalizeArticleUrl(url);
      return new Promise(function(resolve) {
        var articleKey = ARTICLE_CACHE_PREFIX + normalizedUrl;
        chrome.storage.local.get(articleKey, function(result) {
          if (consumeStorageError('文章缓存读取失败')) {
            resolve(null);
            return;
          }
          resolve(readCachedArticle(result, articleKey, Date.now()));
        });
      });
    },

    getArticleCacheState: function(url) {
      var normalizedUrl = SharedUtils.normalizeArticleUrl(url);
      return new Promise(function(resolve) {
        var articleKey = ARTICLE_CACHE_PREFIX + normalizedUrl;
        var negativeKey = NEGATIVE_CACHE_KEY + normalizedUrl;
        chrome.storage.local.get([articleKey, negativeKey], function(result) {
          if (consumeStorageError('文章/失败缓存读取失败')) {
            resolve({ cached: null, negative: false });
            return;
          }
          var now = Date.now();
          var cached = readCachedArticle(result, articleKey, now);
          if (cached) {
            resolve({ cached: cached, negative: false });
            return;
          }
          var negativeState = readNegativeCache(result, negativeKey, now);
          resolve({
            cached: null,
            negative: !!negativeState,
            negativeTs: negativeState ? negativeState.ts : 0,
            negativeExpiresAt: negativeState ? negativeState.expiresAt : 0,
            negativeRemainingMs: negativeState ? negativeState.remainingMs : 0
          });
        });
      });
    },

    setCachedArticleData: function(url, data, complete, writeStartedAt) {
      var normalizedUrl = SharedUtils.normalizeArticleUrl(url);
      var key = ARTICLE_CACHE_PREFIX + normalizedUrl;
      var hasExplicitTextResourceState = !!(
        data &&
        !Array.isArray(data) &&
        Object.prototype.hasOwnProperty.call(data, 'textResourcesComplete')
      );
      var nextData = ATPCache.normalizeArticleData(data);
      enqueueArticleWrite(key, function(existing) {
        var now = Date.now();
        var existingData = existing && existing.data ? ATPCache.normalizeArticleData(existing.data) : ATPCache.normalizeArticleData(null);
        if (!hasExplicitTextResourceState && existing && existing.data) {
          nextData.textResourcesComplete = existingData.textResourcesComplete;
          nextData.textResourcesAttemptedCount = existingData.textResourcesAttemptedCount;
          nextData.textResourcesUnresolvedCount = existingData.textResourcesUnresolvedCount;
          nextData.textResourcesRetryableCount = existingData.textResourcesRetryableCount;
        }
        nextData.loadedUrls = mergeLoadedUrls(existingData.loadedUrls, nextData.loadedUrls);
        if (
          nextData.partial &&
          existing &&
          existing.complete &&
          existing.data &&
          now - (existing.ts || 0) < getArticleCacheTTLMS()
        ) {
          var previousTextAttachmentCount = existingData.textAttachmentCount || existingData.textAttachments.length || 0;
          var discoveredAdditionalTextWork = nextData.hasTextAttachments && nextData.textAttachmentCount > previousTextAttachmentCount;
          var explicitUnresolvedTextWork = hasExplicitTextResourceState && !nextData.textResourcesComplete && (
            nextData.textResourcesUnresolvedCount > 0 || nextData.textResourcesRetryableCount > 0
          );
          existingData.loadedUrls = nextData.loadedUrls;
          existingData.resources = SharedUtils.mergeResources(existingData.resources, nextData.resources);
          existingData.textAttachments = mergeCachedTextAttachments(existingData.textAttachments, nextData.textAttachments);
          existingData.hasTextAttachments = existingData.hasTextAttachments || nextData.hasTextAttachments || existingData.textAttachments.length > 0;
          existingData.textResourcesComplete = (discoveredAdditionalTextWork || explicitUnresolvedTextWork)
            ? false
            : (existingData.textResourcesComplete || nextData.textResourcesComplete);
          existingData.textResourcesAttemptedCount = Math.max(existingData.textResourcesAttemptedCount, nextData.textResourcesAttemptedCount);
          existingData.textResourcesUnresolvedCount = existingData.textResourcesComplete ? 0 : Math.max(
            existingData.textResourcesUnresolvedCount,
            nextData.textResourcesUnresolvedCount,
            discoveredAdditionalTextWork ? nextData.textAttachmentCount - previousTextAttachmentCount : 0
          );
          existingData.textResourcesRetryableCount = existingData.textResourcesComplete ? 0 : Math.max(
            existingData.textResourcesRetryableCount,
            nextData.textResourcesRetryableCount,
            discoveredAdditionalTextWork ? nextData.textAttachmentCount - previousTextAttachmentCount : 0
          );
          existingData.textAttachmentCount = deriveTextAttachmentCount(
            existingData.textAttachments,
            existingData.hasTextAttachments,
            Math.max(existingData.textAttachmentCount || 0, nextData.textAttachmentCount || 0)
          );
          return {
            data: existingData,
            ts: existing.ts || now,
            complete: true
          };
        }
        return {
          data: nextData,
          ts: now,
          complete: nextData.partial ? false : (!!complete || !!(existing && existing.complete))
        };
      }, function() {
        clearNegativeCacheForNormalizedUrl(normalizedUrl);
      }, writeStartedAt);
    },

    updateArticleLoadedUrls: function(url, loadedUrls, complete, writeStartedAt) {
      var normalizedUrl = SharedUtils.normalizeArticleUrl(url);
      var key = ARTICLE_CACHE_PREFIX + normalizedUrl;
      enqueueArticleWrite(key, function(existing) {
        if (!existing || !existing.data) return;
        var currentData = ATPCache.normalizeArticleData(existing.data);
        currentData.loadedUrls = mergeLoadedUrls(currentData.loadedUrls, loadedUrls);
        return {
          data: currentData,
          // 保留原写入时间：loadedUrls 更新不应刷新 TTL，否则常看的帖子缓存永不过期
          ts: existing.ts || Date.now(),
          complete: currentData.partial ? false : (!!complete || !!existing.complete)
        };
      }, null, writeStartedAt);
    },

    getCachedTextResources: function(url) {
      var readStartedAt = Date.now();
      var keys = getTextCacheKeys(TEXT_RESOURCE_CACHE_PREFIX, url);
      if (!keys.length) return Promise.resolve(null);
      var primaryKey = keys[0];
      return new Promise(function(resolve) {
        chrome.storage.local.get(keys, function(result) {
          if (consumeStorageError('TXT缓存读取失败')) {
            resolve(null);
            return;
          }
          var settings = ATPCache.getSettings();
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
      var doEvict = function(entries) {
        lastRebuildEntries = entries;
        lastRebuildAt = Date.now();
        ATPCache._evictFromEntries(entries, function() {
          evictionInProgress = false;
          // If a higher baseline arrived during eviction, run again
          if (pendingEvictBaseline > 0) {
            var retryBaseline = pendingEvictBaseline;
            pendingEvictBaseline = 0;
            ATPCache.evictLRU(null, retryBaseline);
            return;
          }
          var cbs = pendingEvictCallbacks;
          pendingEvictCallbacks = [];
          for (var i = 0; i < cbs.length; i++) cbs[i]();
        }, useBaseline);
      };
      if (lastRebuildEntries && Date.now() - lastRebuildAt < REBUILD_CACHE_TTL) {
        doEvict(lastRebuildEntries);
        return;
      }
      SharedUtils.cacheIndex.rebuild(function(entries) {
        if (!entries) {
          Logger.warn('LRU淘汰跳过', 'cacheIndex rebuild failed');
          pendingEvictBaseline = 0;
          evictionInProgress = false;
          var cbs = pendingEvictCallbacks;
          pendingEvictCallbacks = [];
          for (var i = 0; i < cbs.length; i++) cbs[i]();
          return;
        }
        doEvict(entries);
      });
    },

    _evictFromEntries: function(entries, callback, baselineBytes) {
      var cacheEntries = [];
      var totalEstimated = 0;
      for (var key in entries) {
        var e = entries[key];
        cacheEntries.push({ key: key, ts: e.ts, priority: e.t, estimatedBytes: e.b });
        totalEstimated += e.b;
      }

      var baseline = (typeof baselineBytes === 'number' && baselineBytes > 0)
        ? baselineBytes : totalEstimated;
      if (baseline <= TARGET_WATERMARK) {
        if (callback) callback();
        return;
      }

      cacheEntries.sort(function(a, b) {
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
          removeCacheIndexEntriesAfterStorageRemove(removeKeys, 'LRU淘汰索引清理', function(indexOk) {
            if (indexOk) {
              Logger.debug('LRU淘汰', removeKeys.length + '条缓存，释放约' + freed + '字节');
            } else {
              Logger.warn('LRU淘汰索引清理失败', removeKeys.length + '条缓存已删除，索引未确认');
            }
            // Invalidate cached rebuild entries so next eviction sees current state
            lastRebuildEntries = null;
            lastRebuildAt = 0;
            if (callback) callback();
          });
        });
      } else {
        if (callback) callback();
      }
    },

    getCacheStats: function(callback) {
      chrome.storage.local.getBytesInUse(null, function(totalBytes) {
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
      var d = {};
      d[NEGATIVE_CACHE_KEY + normalizedUrl] = Date.now();
      stampCacheWrite(d, writeStartedAt);
      safeSetWithRetry(d, null, '负缓存写入失败');
    },

    getTextFailCache: function(url) {
      var readStartedAt = Date.now();
      var keys = getTextCacheKeys(TEXT_FAIL_CACHE_PREFIX, url);
      if (!keys.length) return Promise.resolve(false);
      var primaryKey = keys[0];
      var TEXT_FAIL_TTL_MS = 5 * 60 * 1000;
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
      }, 1000);
    },

    flushCacheNow: function(threadId, complete) {
      if (threadId) {
        var pendingStartedAt = CACHE_FLUSH_PENDING[threadId];
        var ts = window.ATPState && window.ATPState.threads && window.ATPState.threads[threadId];
        if (ts && ts.loadedUrls && ts.loadedUrls.length) {
          ATPCache.updateArticleLoadedUrls(ts.link, ts.loadedUrls, !!complete, pendingStartedAt);
        }
        delete CACHE_FLUSH_PENDING[threadId];
        if (!hasPendingCacheFlush() && CACHE_FLUSH_TIMER) {
          clearTimeout(CACHE_FLUSH_TIMER);
          CACHE_FLUSH_TIMER = null;
        }
      } else {
        for (var tid in CACHE_FLUSH_PENDING) {
          var pendingStartedAt2 = CACHE_FLUSH_PENDING[tid];
          var ts2 = window.ATPState && window.ATPState.threads && window.ATPState.threads[tid];
          if (ts2 && ts2.loadedUrls && ts2.loadedUrls.length) {
            ATPCache.updateArticleLoadedUrls(ts2.link, ts2.loadedUrls, false, pendingStartedAt2);
          }
        }
        CACHE_FLUSH_PENDING = {};
      }
    },

    getPendingFlush: function() {
      return CACHE_FLUSH_PENDING;
    },

    normalizeArticleData: function(data) {
      if (Array.isArray(data)) {
        return { images: normalizeCachedImages(data), resources: SharedUtils.emptyResources(), textAttachments: [], loadedUrls: [], hasTextAttachments: false, textAttachmentCount: 0, textResourcesComplete: false, textResourcesAttemptedCount: 0, textResourcesUnresolvedCount: 0, textResourcesRetryableCount: 0, partial: false, retryableEmpty: false, emptyReason: '', retryAfter: 0 };
      }
      data = data || {};
      var textAttachments = normalizeCachedTextAttachments(data.textAttachments);
      var transientAttachmentCount = countTransientCachedTextAttachments(data.textAttachments);
      var markerCount = Math.max(transientAttachmentCount, parseInt(data.textAttachmentCount || 0, 10) || 0);
      var hasTextAttachments = textAttachments.length > 0 || !!data.hasTextAttachments || transientAttachmentCount > 0;
      var textAttachmentCount = deriveTextAttachmentCount(textAttachments, hasTextAttachments, markerCount);
      return {
        images: normalizeCachedImages(data.images),
        resources: SharedUtils.normalizeResources(data.resources),
        textAttachments: textAttachments,
        loadedUrls: normalizeCachedUrls(data.loadedUrls),
        hasTextAttachments: hasTextAttachments,
        textAttachmentCount: textAttachmentCount,
        textResourcesComplete: data.textResourcesComplete === true,
        textResourcesAttemptedCount: Math.max(0, Number(data.textResourcesAttemptedCount || 0) || 0),
        textResourcesUnresolvedCount: Math.max(0, Number(data.textResourcesUnresolvedCount || 0) || 0),
        textResourcesRetryableCount: Math.max(0, Number(data.textResourcesRetryableCount || 0) || 0),
        partial: !!data.partial,
        retryableEmpty: !!data.retryableEmpty,
        emptyReason: data.emptyReason || '',
        retryAfter: Math.max(0, Number(data.retryAfter || 0) || 0)
      };
    },

    clearFlushTimer: function() {
      if (CACHE_FLUSH_TIMER) {
        clearTimeout(CACHE_FLUSH_TIMER);
        CACHE_FLUSH_TIMER = null;
      }
    }
  };

  window.ATPCache = ATPCache;
})();
