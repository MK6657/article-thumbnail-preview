/**
 * Content Script 日志模块
 *
 * 设计说明：Content Script 与 Service Worker 运行在不同上下文，
 * 无法共享日志实例，因此各自维护独立模块（logger.js / BGLOG）。
 * 两者 API 风格保持一致，但无需也不宜强行合并。
 */
const Logger = (function() {
  'use strict';

  var LOG_KEY_BASE = 'atp_logs_content';
  var LOG_KEY = LOG_KEY_BASE + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var LOG_KEY_INDEX = (typeof SharedUtils !== 'undefined' && SharedUtils.CONTENT_LOG_INDEX_KEY) || 'atp_logs_content_keys';
  var LOG_CLEARED_AT_KEY = 'atp_logs_cleared_at';
  var MAX_ENTRIES = 800;
  var MAX_LOG_KEYS = (typeof SharedUtils !== 'undefined' && SharedUtils.MAX_CONTENT_LOG_KEYS) || 20;
  var MAX_LOG_TOTAL_BYTES = (typeof SharedUtils !== 'undefined' && SharedUtils.CONTENT_LOG_TOTAL_BYTES) || (2 * 1024 * 1024);
  var MAX_LOG_KEY_BYTES = (typeof SharedUtils !== 'undefined' && SharedUtils.CONTENT_LOG_KEY_BYTES) || (160 * 1024);
  var FLUSH_INTERVAL = 5000;
  var SESSION_ID = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  var FIELD_VALUE_LIMIT = 240;
  var DATA_VALUE_LIMIT = 800;
  var MAX_FIELD_KEYS = 80;
  var PRIORITY_FIELD_KEYS = [
    'reason',
    'threadId',
    'idx',
    'previewIndex',
    'pickedIndex',
    'fallbackCount',
    'fallbackLimit',
    'timeoutMs',
    'coolingTimeoutMode',
    'heavyDeepRescue',
    'heavyDeepRescueEligible',
    'rescueStrategy',
    'rescueAttempt',
    'rescueSpan',
    'rescueStartIndex',
    'sequentialFallbackIdx',
    'sourceCandidateTotal',
    'candidateTotal',
    'previousState',
    'state',
    'stateEpoch',
    'configuredLimit',
    'adaptiveLimit',
    'effectiveLimit',
    'failureStreak',
    'failureWindowCount',
    'cooldownRemainingMs',
    'heavyHostState',
    'heavyHostStateEpoch',
    'heavyHostConfiguredLimit',
    'heavyHostAdaptiveLimit',
    'heavyHostFailureStreak',
    'heavyHostTotalFailures',
    'heavyHostHalfOpen',
    'heavyHostActive',
    'heavyHostCooling',
    'heavyHostLimited',
    'heavyHostLimit',
    'heavyHostBaseLimit',
    'heavyOrdinaryPressureSoftened',
    'heavyOrdinaryPressureLimit',
    'heavyHostFailures',
    'heavyHostCooldownRemainingMs',
    'heavyHostCooldownCount',
    'heavyHostLastReason',
    'queueKind',
    'url',
    'sameOrigin',
    'visible',
    'images',
    'resources',
    'retryable',
    'articleFetchConcurrency',
    'articleCommitBatchSize',
    'taskAgeMs',
    'queueWaitMs',
    'fetchMs',
    'parseMs',
    'commitMs',
    'globalImageConcurrency',
    'ordinaryHostConcurrency',
    'ordinaryReservedSlots',
    'ordinaryFallbackLimit',
    'viewportPendingLimit',
    'heavyFallbackLimit',
    'heavyDecodedBudgetMP',
    'heavyVisibleBudgetMP',
    'heavyDecodedImageLimit',
    'heavyLightweightPreviewEdge',
    'changedKeys',
    'pendingCreatedDistancePx',
    'pendingCurrentDistancePx',
    'preloadMissReason',
    'active',
    'ordinaryActive',
    'heavyActive',
    'firstHeavyQueue',
    'bgHeavyQueue',
    'viewportPending',
    'pendingCount',
    'maxPendingAgeMs',
    'stalePendingCount',
    'maxPendingCreatedDistancePx',
    'maxPendingCurrentDistancePx',
    'maxLightweightPreloadCreatedDistancePx',
    'lightweightPreloadEligible',
    'lightweightPreloadTriggered',
    'lightweightPreloadPending',
    'lightweightPreloadInRange',
    'lightweightPreloadObservedTotal',
    'lightweightPreloadTriggeredTotal',
    'maxLightweightPreloadObservedTotal',
    'maxLightweightPreloadTriggeredTotal',
    'lightweightPreloadLoads',
    'lightweightPreloadMarginPx',
    'maxLightweightPreloadMarginPx',
    'pendingAgeByQueueKind',
    'maxPendingAgeByQueueKind',
    'preloadMissReasons',
    'forceLoadReason',
    'forcePreload',
    'heavyQueue'
  ];

  var buffer = [];
  var source = '';
  var flushTimer = null;
  var flushQueue = [];
  var MAX_FLUSH_QUEUE_BATCHES = 50;
  var retryBatch = null;
  var flushing = false;
  var flushErrorCount = 0;
  var MAX_FLUSH_RETRIES = 3;
  var timezoneNameCache = null;
  var debugEnabled = false;

  function init(src) {
    source = src;
  }

  function isEnabled(level) {
    return String(level || 'DEBUG').toUpperCase() !== 'DEBUG' || debugEnabled;
  }

  function setDebugEnabled(enabled) {
    debugEnabled = enabled === true;
  }

  function padNumber(value, width) {
    value = String(value);
    while (value.length < width) value = '0' + value;
    return value;
  }

  function formatLocalTimestamp(date) {
    date = date || new Date();
    return date.getFullYear() + '-' +
      padNumber(date.getMonth() + 1, 2) + '-' +
      padNumber(date.getDate(), 2) + ' ' +
      padNumber(date.getHours(), 2) + ':' +
      padNumber(date.getMinutes(), 2) + ':' +
      padNumber(date.getSeconds(), 2) + '.' +
      padNumber(date.getMilliseconds(), 3);
  }

  function getTimezoneOffsetMinutes(date) {
    return -(date || new Date()).getTimezoneOffset();
  }

  function getTimezoneName() {
    if (timezoneNameCache !== null) return timezoneNameCache;
    try {
      timezoneNameCache = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      timezoneNameCache = '';
    }
    return timezoneNameCache;
  }

  function now(date) {
    return formatLocalTimestamp(date || new Date());
  }

  function getVersion() {
    try {
      return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '';
    } catch (e) {
      return '';
    }
  }

  function getPageUrl() {
    try {
      return sanitizeLogUrl(location.href);
    } catch (e) {
      return '';
    }
  }

  function sanitizeLogUrl(url) {
    if (url === null || url === undefined) return '';
    var raw = String(url).trim();
    if (!raw) return '';
    try {
      if (!/^https?:\/\//i.test(raw) && raw.indexOf('//') !== 0) {
        return raw.replace(/[?#].*$/, '').substring(0, 240);
      }
      var u = new URL(raw, location.href);
      return (u.protocol + '//' + u.host + u.pathname).substring(0, 240);
    } catch (e) {
      return raw.replace(/[?#].*$/, '').substring(0, 240);
    }
  }

  function isUrlFieldKey(key) {
    return /(?:url|urls|uri|uris|href|src|link|links|referrer|referer)$/i.test(String(key || ''));
  }

  function isLogUrlLikeKey(key) {
    var raw = String(key || '');
    return /^(?:https?:)?\/\//i.test(raw) ||
      /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|[?#]|$)/i.test(raw);
  }

  function isSensitiveLogFieldKey(key) {
    if (isLogUrlLikeKey(key)) return false;
    var compact = String(key || '').replace(/[\s_.:-]+/g, '').toLowerCase();
    return compact === 'auth' ||
      /(?:accesstoken|refreshtoken|idtoken|authtoken|authorization|setcookie|cookie|token|secret|signature|password|passwd|pwd|credential|apikey|clientsecret|csrf|xsrf|jwt|bearer)/.test(compact);
  }

  function sanitizeLogText(text) {
    function replaceLogUrl(raw) {
      var trailing = '';
      while (/[),.;，。！？!?]$/.test(raw)) {
        trailing = raw.slice(-1) + trailing;
        raw = raw.slice(0, -1);
      }
      return sanitizeLogUrl(raw) + trailing;
    }
    return String(text === null || text === undefined ? '' : text)
      .replace(/(?:https?:)?\/\/[^\s"'<>]+/gi, replaceLogUrl)
      .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'<>]*)?[?#][^\s"'<>]+/gi, replaceLogUrl);
  }

  function getPageHost() {
    try {
      return String(location.hostname || '').substring(0, 120);
    } catch (e) {
      return '';
    }
  }

  function sanitizeLogKey(key, existing) {
    var base = sanitizeLogText(key).substring(0, FIELD_VALUE_LIMIT) || '[empty]';
    var safe = base;
    var n = 2;
    while (existing && Object.prototype.hasOwnProperty.call(existing, safe)) {
      var suffix = '_' + n++;
      safe = base.substring(0, Math.max(1, FIELD_VALUE_LIMIT - suffix.length)) + suffix;
    }
    return safe;
  }

  function normalizeFieldValue(value, key, seenObjects) {
    if (value === null || value === undefined) return value;
    if (isSensitiveLogFieldKey(key)) return '[redacted]';
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      if (seenObjects && seenObjects.has(value)) return '[Circular]';
      if (seenObjects) seenObjects.add(value);
      var arr = [];
      var arrayLimit = Math.min(value.length, 12);
      for (var ai = 0; ai < arrayLimit; ai++) {
        arr.push(normalizeFieldValue(value[ai], key, seenObjects));
      }
      if (seenObjects) seenObjects.delete(value);
      return arr;
    }
    if (typeof value === 'object') {
      if (seenObjects && seenObjects.has(value)) return '[Circular]';
      return normalizeFields(value, seenObjects);
    }
    return (isUrlFieldKey(key) ? sanitizeLogUrl(value) : sanitizeLogText(value)).substring(0, FIELD_VALUE_LIMIT);
  }

  function normalizeFields(fields, seenObjects) {
    var out = {};
    if (!fields || typeof fields !== 'object') return out;
    seenObjects = seenObjects || (typeof WeakSet !== 'undefined' ? new WeakSet() : null);
    if (seenObjects) {
      if (seenObjects.has(fields)) return { circular: true };
      seenObjects.add(fields);
    }
    var seen = {};
    var keys = [];
    for (var p = 0; p < PRIORITY_FIELD_KEYS.length; p++) {
      var priorityKey = PRIORITY_FIELD_KEYS[p];
      if (Object.prototype.hasOwnProperty.call(fields, priorityKey) && !seen[priorityKey]) {
        seen[priorityKey] = true;
        keys.push(priorityKey);
      }
    }
    try {
      for (var key in fields) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
        if (seen[key]) continue;
        seen[key] = true;
        keys.push(key);
        if (keys.length >= MAX_FIELD_KEYS) break;
      }
    } catch (e) {
      if (seenObjects) seenObjects.delete(fields);
      return { error: 'unserializable' };
    }
    for (var i = 0; i < keys.length; i++) {
      var outputKey = sanitizeLogKey(keys[i], out);
      try {
        out[outputKey] = normalizeFieldValue(fields[keys[i]], keys[i], seenObjects);
      } catch (e2) {
        out[outputKey] = '[Unserializable]';
      }
    }
    if (seenObjects) seenObjects.delete(fields);
    return out;
  }

  function stringifyData(data, normalizedFields) {
    if (data === undefined) return undefined;
    if (typeof data === 'object') {
      try {
        return JSON.stringify(normalizedFields || normalizeFields(data)).substring(0, DATA_VALUE_LIMIT);
      } catch(e) {
        return sanitizeLogText(data).substring(0, DATA_VALUE_LIMIT);
      }
    }
    return sanitizeLogText(data).substring(0, DATA_VALUE_LIMIT);
  }

  function formatConsoleData(data, normalizedFields) {
    if (data === undefined) return '';
    if (typeof data === 'object') {
      try {
        return JSON.stringify(normalizedFields || normalizeFields(data)).substring(0, DATA_VALUE_LIMIT);
      } catch(e) {
        return sanitizeLogText(data).substring(0, DATA_VALUE_LIMIT);
      }
    }
    return sanitizeLogText(data).substring(0, DATA_VALUE_LIMIT);
  }

  function add(level, msg, data, type) {
    if (!isEnabled(level)) return;
    var timestampDate = new Date();
    var safeMsg = sanitizeLogText(msg).substring(0, FIELD_VALUE_LIMIT);
    var entry = {
      ts: now(timestampDate),
      tsUtc: timestampDate.toISOString(),
      timezoneOffsetMinutes: getTimezoneOffsetMinutes(timestampDate),
      timezone: getTimezoneName(),
      lv: level,
      src: source,
      msg: safeMsg,
      sessionId: SESSION_ID,
      pageUrl: getPageUrl(),
      pageHost: getPageHost(),
      version: getVersion()
    };
    if (type) entry.type = type;
    var normalizedFields;
    if (data !== undefined) {
      if (typeof data === 'object') {
        try {
          normalizedFields = normalizeFields(data);
        } catch(e) {
          normalizedFields = { error: 'unserializable' };
        }
        entry.fields = normalizedFields;
      }
      entry.data = stringifyData(data, normalizedFields);
    }
    buffer.push(entry);

    var prefix = '[' + source + ':' + level + ']';
    // entry.data 与控制台串同源（stringifyData / formatConsoleData 实现相同），
    // 复用已算好的结果，避免同一份 fields 每条日志被 JSON.stringify 两次
    var consoleData = data === undefined ? '' : entry.data;
    var consoleLine = prefix + ' ' + safeMsg + (consoleData ? ' ' + consoleData : '');
    if (level === 'ERROR') {
      console.error(consoleLine);
    } else if (level === 'WARN') {
      console.warn(consoleLine);
    } else {
      console.log(consoleLine);
    }

    if (buffer.length >= 20 || level === 'WARN' || level === 'ERROR') {
      flush();
    }
  }

  function getContentLogKeyTimestamp(key) {
    var prefix = LOG_KEY_BASE + '_';
    if (!isContentLogKey(key)) return 0;
    var ts = parseInt(key.slice(prefix.length), 10);
    return isNaN(ts) ? 0 : ts;
  }

  function isContentLogKey(key) {
    var prefix = LOG_KEY_BASE + '_';
    return typeof key === 'string' && key.indexOf(prefix) === 0 && /^\d+(?:_|$)/.test(key.slice(prefix.length));
  }

  function uniqueKeys(keys) {
    var seen = {};
    var out = [];
    for (var i = 0; i < (keys || []).length; i++) {
      var key = keys[i];
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push(key);
    }
    return out;
  }

  function appendContentLogKey(out, seen, key) {
    if (!isContentLogKey(key) || seen[key]) return;
    seen[key] = true;
    out.push(key);
  }

  function collectSortedContentLogKeys(keys, extraKey) {
    var seen = {};
    var out = [];
    for (var i = 0; i < (keys || []).length; i++) {
      appendContentLogKey(out, seen, keys[i]);
    }
    if (extraKey) appendContentLogKey(out, seen, extraKey);
    out.sort(function(a, b) {
      return getContentLogKeyTimestamp(b) - getContentLogKeyTimestamp(a);
    });
    return out;
  }

  function mergeSortedContentLogKeys(primaryKeys, extraKeys, extraKey) {
    var seen = {};
    var out = [];
    for (var i = 0; i < (primaryKeys || []).length; i++) {
      appendContentLogKey(out, seen, primaryKeys[i]);
    }
    for (var j = 0; j < (extraKeys || []).length; j++) {
      appendContentLogKey(out, seen, extraKeys[j]);
    }
    if (extraKey) appendContentLogKey(out, seen, extraKey);
    out.sort(function(a, b) {
      return getContentLogKeyTimestamp(b) - getContentLogKeyTimestamp(a);
    });
    return out;
  }

  function collectStoredContentLogKeys(callback) {
    var area = chrome && chrome.storage && chrome.storage.local;
    if (!area || typeof area.getKeys !== 'function') {
      callback([]);
      return;
    }
    var done = false;
    function finish(keys) {
      if (done) return;
      done = true;
      callback(collectSortedContentLogKeys(keys));
    }
    try {
      var maybePromise = area.getKeys(function(keys) {
        if (chrome.runtime.lastError) {
          console.warn('[Logger] log key discovery failed:', chrome.runtime.lastError.message);
          finish([]);
          return;
        }
        finish(keys || []);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(function(keys) {
          finish(keys || []);
        }).catch(function(e) {
          console.warn('[Logger] log key discovery failed:', e && e.message ? e.message : String(e));
          finish([]);
        });
      }
    } catch (e) {
      console.warn('[Logger] log key discovery failed:', e && e.message ? e.message : String(e));
      finish([]);
    }
  }

  function estimateStringBytes(str) {
    if (typeof SharedUtils !== 'undefined' && SharedUtils && SharedUtils.utf8ByteLength) {
      return SharedUtils.utf8ByteLength(str);
    }
    return String(str == null ? '' : str).length;
  }

  function estimateLogBytes(value) {
    try {
      return estimateStringBytes(JSON.stringify(value || []));
    } catch (e) {
      return estimateStringBytes(String(value || ''));
    }
  }

  function estimateLogEntryBytes(entry) {
    try {
      // +1 近似数组分隔逗号
      return estimateStringBytes(JSON.stringify(entry)) + 1;
    } catch (e) {
      return 256;
    }
  }

  function trimLogEntries(entries, maxEntries, maxBytes) {
    if (!Array.isArray(entries) || !entries.length) return [];
    return trimLogEntriesFrom(entries, Math.max(0, entries.length - maxEntries), maxBytes);
  }

  // 增量估算裁剪起点：只序列化一次并逐条递减，避免每轮循环整表 JSON.stringify
  function trimLogEntriesFrom(entries, start, maxBytes) {
    start = Math.max(0, Number(start) || 0);
    if (start >= entries.length) return [];
    var perEntryBytes = new Array(entries.length);
    var totalBytes = 2; // []
    for (var i = start; i < entries.length; i++) {
      perEntryBytes[i] = estimateLogEntryBytes(entries[i]);
      totalBytes += perEntryBytes[i];
    }
    while (start < entries.length && totalBytes > maxBytes) {
      var remaining = entries.length - start;
      var step = Math.max(1, Math.ceil(remaining * 0.1));
      for (var j = start; j < Math.min(start + step, entries.length); j++) {
        totalBytes -= perEntryBytes[j];
      }
      start += step;
    }
    return copyLogEntriesFrom(entries, start);
  }

  function copyLogEntriesFrom(entries, start) {
    var length = Math.max(0, entries.length - start);
    var out = new Array(length);
    for (var i = 0; i < length; i++) out[i] = entries[start + i];
    return out;
  }

  function mergeLogEntries(existing, batch) {
    var source = Array.isArray(existing) ? existing : [];
    var merged = new Array(source.length + batch.length);
    var writeIndex = 0;
    for (var i = 0; i < source.length; i++) merged[writeIndex++] = source[i];
    for (var j = 0; j < batch.length; j++) merged[writeIndex++] = batch[j];
    return merged;
  }

  function getLogClearedAtMs(value) {
    var ms = Date.parse(value || '');
    return isNaN(ms) ? 0 : ms;
  }

  function getLogEntryTimeMs(entry) {
    if (!entry || typeof entry !== 'object') return 0;
    var ms = Date.parse(entry.tsUtc || '');
    if (!isNaN(ms)) return ms;
    return Date.parse(entry.ts || '') || 0;
  }

  function filterLogsAfterClearedAt(entries, clearedAtMs) {
    if (!clearedAtMs || !Array.isArray(entries) || !entries.length) return entries || [];
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      if (getLogEntryTimeMs(entries[i]) > clearedAtMs) out.push(entries[i]);
    }
    return out;
  }

  function finishLogWrite(success) {
    if (success) flushErrorCount = 0;
    flushing = false;
    if (buffer.length || retryBatch || flushQueue.length) flush();
  }

  function planLogKeyPrune(keys, items, forceDropOldest) {
    keys = collectSortedContentLogKeys(keys);
    var stale = [];
    var kept = [];
    var totalBytes = 0;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (i >= MAX_LOG_KEYS) {
        stale.push(key);
        continue;
      }
      var bytes = estimateLogBytes(items && items[key]);
      if (key === LOG_KEY || totalBytes + bytes <= MAX_LOG_TOTAL_BYTES) {
        kept.push(key);
        totalBytes += bytes;
      } else {
        stale.push(key);
      }
    }
    if (forceDropOldest && !stale.length && kept.length > 1) {
      stale.push(kept.pop());
    }
    return { kept: kept, stale: stale };
  }

  function keepStaleLogKeysOnRemoveFailure(plan) {
    var keys = [];
    var seen = {};
    var source = [];
    if (plan && Array.isArray(plan.kept)) source = source.concat(plan.kept);
    if (plan && Array.isArray(plan.stale)) source = source.concat(plan.stale);
    for (var i = 0; i < source.length; i++) {
      var key = source[i];
      if (!isContentLogKey(key) || seen[key]) continue;
      seen[key] = true;
      keys.push(key);
    }
    keys.sort(function(a, b) {
      return getContentLogKeyTimestamp(b) - getContentLogKeyTimestamp(a);
    });
    return keys;
  }

  function writeLogKeyIndex(keys, callback) {
    var data = {};
    data[LOG_KEY_INDEX] = keys;
    chrome.storage.local.set(data, function() {
      if (chrome.runtime.lastError) {
        console.warn('[Logger] 日志索引写入失败:', chrome.runtime.lastError.message);
      }
      if (callback) callback(!chrome.runtime.lastError);
    });
  }

  function removeStaleLogKeysThenWriteIndex(plan, callback) {
    if (!plan || !plan.stale || !plan.stale.length) {
      writeLogKeyIndex(plan ? plan.kept : [], function() {
        if (callback) callback();
      });
      return;
    }
    chrome.storage.local.remove(plan.stale, function() {
      var keys = plan.kept;
      if (chrome.runtime.lastError) {
        console.warn('[Logger] 旧日志清理失败:', chrome.runtime.lastError.message);
        keys = keepStaleLogKeysOnRemoveFailure(plan);
      }
      writeLogKeyIndex(keys, function() {
        if (callback) callback();
      });
    });
  }

  function pruneStoredContentLogs(forceDropOldest, callback) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      if (callback) callback();
      return;
    }
    chrome.storage.local.get(LOG_KEY_INDEX, function(result) {
      if (chrome.runtime.lastError) {
        console.warn('[Logger] 日志索引读取失败:', chrome.runtime.lastError.message);
        if (callback) callback();
        return;
      }
      var indexedKeys = collectSortedContentLogKeys(result[LOG_KEY_INDEX], LOG_KEY);
      collectStoredContentLogKeys(function(discoveredKeys) {
        var keys = mergeSortedContentLogKeys(indexedKeys, discoveredKeys, LOG_KEY);
        // 与 rememberLogKey 一致地封顶：孤儿日志键堆积时，一次性把全部键（每个可达 160KB）
        // 读进内容脚本堆正好发生在配额已耗尽的时刻，会把问题放大成不可恢复
        chrome.storage.local.get(keys.slice(0, MAX_LOG_KEYS), function(items) {
        if (chrome.runtime.lastError) {
          console.warn('[Logger] 日志容量读取失败:', chrome.runtime.lastError.message);
          if (callback) callback();
          return;
        }
        var plan = planLogKeyPrune(keys, items, !!forceDropOldest);
        removeStaleLogKeysThenWriteIndex(plan, callback);
      });
      });
    });
  }

  var lastLogKeyMaintenanceAt = 0;
  var LOG_KEY_MAINTENANCE_INTERVAL_MS = 60000;

  function rememberLogKey() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    // 索引维护开销大（全量 getKeys + 读多份日志），本会话键注册一次后按分钟级节流即可；
    // 即使索引条目意外丢失，popup 侧的前缀发现兜底也能自愈
    var now = Date.now();
    if (lastLogKeyMaintenanceAt && now - lastLogKeyMaintenanceAt < LOG_KEY_MAINTENANCE_INTERVAL_MS) return;
    lastLogKeyMaintenanceAt = now;
    chrome.storage.local.get(LOG_KEY_INDEX, function(result) {
      if (chrome.runtime.lastError) {
        console.warn('[Logger] 日志索引读取失败:', chrome.runtime.lastError.message);
        lastLogKeyMaintenanceAt = 0; // 失败不消耗节流窗口，下次写日志时重试注册
        return;
      }
      var indexedKeys = collectSortedContentLogKeys(result[LOG_KEY_INDEX], LOG_KEY);
      collectStoredContentLogKeys(function(discoveredKeys) {
        var keys = mergeSortedContentLogKeys(indexedKeys, discoveredKeys, LOG_KEY);
        var readKeys = [];
        for (var ki = 0; ki < keys.length && ki < MAX_LOG_KEYS; ki++) {
          readKeys.push(keys[ki]);
        }
        chrome.storage.local.get(readKeys, function(items) {
        if (chrome.runtime.lastError) {
          console.warn('[Logger] 日志容量读取失败:', chrome.runtime.lastError.message);
          items = {};
        }
        var plan = planLogKeyPrune(keys, items, false);
        removeStaleLogKeysThenWriteIndex(plan);
      });
      });
    });
  }

  function writeMergedLogs(merged, batch, retried) {
    chrome.storage.local.get(LOG_CLEARED_AT_KEY, function(clearResult) {
      if (chrome.runtime.lastError) {
        console.warn('[Logger] 清空标记读取失败:', chrome.runtime.lastError.message);
        requeueBatch(batch, chrome.runtime.lastError.message);
        finishLogWrite(false);
        return;
      }
      var clearedAtMs = getLogClearedAtMs(clearResult && clearResult[LOG_CLEARED_AT_KEY]);
      var filteredBatch = filterLogsAfterClearedAt(batch, clearedAtMs);
      merged = trimLogEntries(filterLogsAfterClearedAt(merged, clearedAtMs), MAX_ENTRIES, MAX_LOG_KEY_BYTES);
      if (!merged.length) {
        chrome.storage.local.remove(LOG_KEY, function() {
          if (chrome.runtime.lastError) {
            console.warn('[Logger] 清空前日志移除失败:', chrome.runtime.lastError.message);
          }
          finishLogWrite(true);
        });
        return;
      }
      var data = {};
      data[LOG_KEY] = merged;
      chrome.storage.local.set(data, function() {
        if (chrome.runtime.lastError) {
          console.warn('[Logger] storage写入失败:', chrome.runtime.lastError.message);
          if (!retried) {
            pruneStoredContentLogs(true, function() {
              var retryMerged = trimLogEntriesFrom(merged, Math.ceil(merged.length / 2), MAX_LOG_KEY_BYTES);
              writeMergedLogs(retryMerged, filteredBatch, true);
            });
            return;
          }
          requeueBatch(filteredBatch, chrome.runtime.lastError.message);
        } else {
          rememberLogKey();
        }
        finishLogWrite(!chrome.runtime.lastError);
      });
    });
  }

  function requeueBatch(batch, reason) {
    if (!batch || !batch.length) return;
    flushErrorCount++;
    if (flushErrorCount > MAX_FLUSH_RETRIES) {
      console.warn('[Logger] storage连续失败，丢弃日志批次:', reason || '');
      flushErrorCount = 0;
      return;
    }
    retryBatch = batch;
  }

  function drainFlushQueue() {
    var batch = [];
    if (retryBatch) {
      for (var ri = 0; ri < retryBatch.length; ri++) {
        batch.push(retryBatch[ri]);
      }
      retryBatch = null;
    }
    for (var qi = 0; qi < flushQueue.length; qi++) {
      var queued = flushQueue[qi];
      for (var bi = 0; bi < queued.length; bi++) {
        batch.push(queued[bi]);
      }
    }
    flushQueue.length = 0;
    return batch;
  }

  function flush() {
    if (buffer.length) {
      flushQueue.push(buffer.splice(0, buffer.length));
      // 防止 flushing 卡死或存储长期不可用时积压无上界：超限丢最旧批次
      while (flushQueue.length > MAX_FLUSH_QUEUE_BATCHES) flushQueue.shift();
    }
    if (flushing || (!retryBatch && flushQueue.length === 0)) return;
    var batch = drainFlushQueue();
    flushing = true;

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        chrome.storage.local.get(LOG_KEY, function(result) {
          if (chrome.runtime.lastError) {
            console.warn('[Logger] storage读取失败:', chrome.runtime.lastError.message);
            requeueBatch(batch, chrome.runtime.lastError.message);
            flushing = false;
            if (buffer.length || retryBatch || flushQueue.length) flush();
            return;
          }
          var merged = mergeLogEntries(result[LOG_KEY], batch);
          writeMergedLogs(merged, batch, false);
        });
      } catch (e) {
        // 扩展上下文失效（重载/更新后的孤儿内容脚本）时同步抛错：必须复位 flushing 并吞掉异常
        console.warn('[Logger] storage访问异常:', e && e.message ? e.message : String(e));
        requeueBatch(batch, e && e.message);
        flushing = false;
      }
    } else {
      requeueBatch(batch, 'storage不可用');
      flushing = false;
    }
  }

  function logDebug(msg, data) { add('DEBUG', msg, data); }
  function logInfo(msg, data)  { add('INFO',  msg, data); }
  function logWarn(msg, data)  { add('WARN',  msg, data); }
  function logError(msg, data) { add('ERROR', msg, data); }
  function logEvent(type, fields, level) {
    add(level || 'DEBUG', type, fields || {}, type);
  }

  function startFlushTimer() {
    if (flushTimer) return;
    flushTimer = setInterval(flush, FLUSH_INTERVAL);
  }

  function stopFlushTimer() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }

  function handlePageHide() {
    flush();
  }

  function handleVisibilityFlush() {
    if (document.visibilityState === 'hidden') flush();
  }

  window.addEventListener('pagehide', handlePageHide);
  document.addEventListener('visibilitychange', handleVisibilityFlush);

  return {
    init: init,
    debug: logDebug,
    info: logInfo,
    warn: logWarn,
    error: logError,
    event: logEvent,
    isEnabled: isEnabled,
    setDebugEnabled: setDebugEnabled,
    getSessionId: function() { return SESSION_ID; },
    sanitizeUrl: sanitizeLogUrl,
    flush: flush,
    startFlushTimer: startFlushTimer,
    stopFlushTimer: stopFlushTimer
  };
})();
