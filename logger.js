/**
 * Cross-Context Logger Module (Content Script & Service Worker)
 *
 * Provides ATPCreateLogger(options) factory for both sharded content-script
 * logging (Logger) and single-key Service Worker logging (BGLOG), eliminating
 * permanent setInterval churn via on-demand debounced setTimeout flushing and
 * linear cached entry.__byteSize trimming.
 */
(function(root) {
  'use strict';

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

  var UNSERIALIZABLE_FIELD = {};
  var RETENTION_TYPE = 'log_retention';
  var RETENTION_RESERVED_BYTES = 12288;
  var RETENTION_RECENT_INCIDENTS = 6;
  var NORMAL_FLUSH_DEBOUNCE_MS = 2000;
  var WARN_FLUSH_DEBOUNCE_MS = 500;
  var IMMEDIATE_FLUSH_BUFFER_SIZE = 40;
  var LOG_KEY_MAINTENANCE_INTERVAL_MS = 60000;

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

  function estimateStringBytes(str) {
    if (typeof SharedUtils !== 'undefined' && SharedUtils && SharedUtils.utf8ByteLength) {
      return SharedUtils.utf8ByteLength(str);
    }
    var s = String(str == null ? '' : str);
    var bytes = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length &&
               s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function estimateLogBytes(value) {
    try {
      return estimateStringBytes(JSON.stringify(value || []));
    } catch (e) {
      return estimateStringBytes(String(value || ''));
    }
  }

  function estimateLogEntryBytes(entry) {
    if (!entry || typeof entry !== 'object') return 2;
    if (typeof entry.__byteSize === 'number' && entry.__byteSize > 0) return entry.__byteSize;
    var size;
    try {
      size = estimateStringBytes(JSON.stringify(entry)) + 1;
    } catch (e) {
      size = 256;
    }
    try {
      Object.defineProperty(entry, '__byteSize', {
        value: size,
        enumerable: false,
        configurable: true,
        writable: true
      });
    } catch (e2) {}
    return size;
  }

  function invalidateEntryByteSize(entry) {
    if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, '__byteSize')) {
      entry.__byteSize = 0;
    }
  }

  function copyLogEntriesFrom(entries, start) {
    var length = Math.max(0, entries.length - start);
    var out = new Array(length);
    for (var i = 0; i < length; i++) out[i] = entries[start + i];
    return out;
  }

  // Linear O(N) byte accounting using cached entry.__byteSize
  function trimLogEntriesFrom(entries, start, maxBytes) {
    start = Math.max(0, Number(start) || 0);
    if (start >= entries.length) return [];
    var perEntryBytes = new Array(entries.length);
    var totalBytes = 2; // []
    for (var i = start; i < entries.length; i++) {
      var b = estimateLogEntryBytes(entries[i]);
      perEntryBytes[i] = b;
      totalBytes += b;
    }
    while (start < entries.length && totalBytes > maxBytes) {
      var remaining = entries.length - start;
      var step = Math.max(1, Math.ceil(remaining * 0.1));
      var stop = Math.min(start + step, entries.length);
      for (var j = start; j < stop; j++) {
        totalBytes -= perEntryBytes[j];
      }
      start = stop;
    }
    return copyLogEntriesFrom(entries, start);
  }

  function trimLogEntries(entries, maxEntries, maxBytes) {
    if (!Array.isArray(entries) || !entries.length) return [];
    return trimLogEntriesFrom(entries, Math.max(0, entries.length - maxEntries), maxBytes);
  }

  function mergeLogEntries(existing, batch) {
    var src = Array.isArray(existing) ? existing : [];
    var merged = new Array(src.length + batch.length);
    var writeIndex = 0;
    for (var i = 0; i < src.length; i++) merged[writeIndex++] = src[i];
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

  function createLogger(options) {
    options = options || {};
    var LOG_KEY_BASE = 'atp_logs_content';
    var isSharded = options.sharded !== undefined ? !!options.sharded : !options.storageKey;
    var LOG_KEY = options.storageKey || (LOG_KEY_BASE + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    var LOG_KEY_INDEX = (typeof SharedUtils !== 'undefined' && SharedUtils.CONTENT_LOG_INDEX_KEY) || 'atp_logs_content_keys';
    var LOG_CLEARED_AT_KEY = (typeof SharedUtils !== 'undefined' && SharedUtils.LOG_CLEARED_AT_KEY) || 'atp_logs_cleared_at';
    var MAX_ENTRIES = Number(options.maxEntries) || 800;
    var MAX_LOG_KEYS = (typeof SharedUtils !== 'undefined' && SharedUtils.MAX_CONTENT_LOG_KEYS) || 20;
    var MAX_LOG_TOTAL_BYTES = (typeof SharedUtils !== 'undefined' && SharedUtils.CONTENT_LOG_TOTAL_BYTES) || (2 * 1024 * 1024);
    var MAX_LOG_KEY_BYTES = Number(options.maxBytes) ||
      ((typeof SharedUtils !== 'undefined' && SharedUtils.CONTENT_LOG_KEY_BYTES) || (160 * 1024));
    var enableRetention = options.enableRetention !== undefined ? !!options.enableRetention : isSharded;
    var isBgMode = options.source === 'bg' || LOG_KEY === 'atp_logs_bg';
    var warnTag = isBgMode ? 'BGLOG' : 'Logger';
    var source = isBgMode ? 'BACKGROUND' : (options.source || '');
    var consoleTagSource = isBgMode ? 'BG' : '';

    var SESSION_ID = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    var SESSION_STARTED_AT_MS = Date.now();
    var FIELD_VALUE_LIMIT = isBgMode ? 500 : 240;
    var DATA_VALUE_LIMIT = 800;
    var MAX_FIELD_KEYS = 80;

    var retention = {
      observedEntries: 0,
      droppedEntries: 0,
      droppedBatches: 0,
      firstDroppedAt: '',
      lastDroppedAt: '',
      incidentCount: 0,
      config: null,
      firstIncident: null,
      firstImageFailure: null,
      recentIncidents: [],
      incidentTypes: {},
      incidentHosts: {}
    };
    var lastClearedAtMs = 0;

    var buffer = [];
    var flushTimer = null;
    var flushTimerDueAt = 0;
    var autoFlushEnabled = true;
    var flushQueue = [];
    var MAX_FLUSH_QUEUE_BATCHES = 50;
    var retryBatch = null;
    var flushing = false;
    var flushWaiters = [];
    var enqueuedLogCount = 0;
    var settledLogCount = 0;
    var inFlightLogCount = 0;
    var flushErrorCount = 0;
    var MAX_FLUSH_RETRIES = 3;
    var timezoneNameCache = null;
    var debugEnabled = false;
    var lastLogKeyMaintenanceAt = 0;

    function init(src) {
      source = src;
    }

    function isEnabled(level) {
      return String(level || 'DEBUG').toUpperCase() !== 'DEBUG' || debugEnabled;
    }

    function setDebugEnabled(enabled) {
      debugEnabled = enabled === true;
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

    function getLocationHref() {
      try {
        return typeof location !== 'undefined' && location && location.href ? String(location.href) : '';
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
        var baseHref = getLocationHref() || 'https://example.invalid/';
        var u = new URL(raw, baseHref);
        return (u.protocol + '//' + u.host + u.pathname).substring(0, 240);
      } catch (e) {
        return raw.replace(/[?#].*$/, '').substring(0, 240);
      }
    }

    function getPageUrl() {
      var href = getLocationHref();
      return href ? sanitizeLogUrl(href) : '';
    }

    function getPageHost() {
      try {
        return typeof location !== 'undefined' && location && location.hostname
          ? String(location.hostname).substring(0, 120)
          : '';
      } catch (e) {
        return '';
      }
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

    function sanitizeLogKey(key, existing) {
      var base = sanitizeLogText(key).substring(0, 240) || '[empty]';
      var safe = base;
      var n = 2;
      while (existing && Object.prototype.hasOwnProperty.call(existing, safe)) {
        var suffix = '_' + n++;
        safe = base.substring(0, Math.max(1, 240 - suffix.length)) + suffix;
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
      var values = [];
      function collect(key) {
        var value;
        try {
          value = fields[key];
        } catch (readError) {
          value = UNSERIALIZABLE_FIELD;
        }
        if (value === undefined) return;
        keys.push(key);
        values.push(value);
      }
      for (var p = 0; p < PRIORITY_FIELD_KEYS.length; p++) {
        var priorityKey = PRIORITY_FIELD_KEYS[p];
        if (Object.prototype.hasOwnProperty.call(fields, priorityKey) && !seen[priorityKey]) {
          seen[priorityKey] = true;
          collect(priorityKey);
        }
      }
      try {
        for (var key in fields) {
          if (keys.length >= MAX_FIELD_KEYS) break;
          if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
          if (seen[key]) continue;
          seen[key] = true;
          collect(key);
        }
      } catch (e) {
        if (seenObjects) seenObjects.delete(fields);
        return { error: 'unserializable' };
      }
      for (var i = 0; i < keys.length; i++) {
        var outputKey = sanitizeLogKey(keys[i], out);
        try {
          out[outputKey] = values[i] === UNSERIALIZABLE_FIELD
            ? '[Unserializable]'
            : normalizeFieldValue(values[i], keys[i], seenObjects);
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
        } catch (e) {
          return sanitizeLogText(data).substring(0, DATA_VALUE_LIMIT);
        }
      }
      return sanitizeLogText(data).substring(0, DATA_VALUE_LIMIT);
    }

    function incrementRetentionCount(counts, value) {
      var key = String(value || 'unknown').substring(0, 80);
      if (!Object.prototype.hasOwnProperty.call(counts, key) && Object.keys(counts).length >= 12) key = 'other';
      counts[key] = (counts[key] || 0) + 1;
    }

    function isImageFailureEntry(entry) {
      return !!(entry && (entry.type === 'image_failure' ||
        (entry.type === 'image_done' && entry.fields && entry.fields.ok === false)));
    }

    function isIncidentEntry(entry) {
      var fields = entry && entry.fields || {};
      var textFailure = entry && entry.type === 'txt_request' &&
        (fields.outcome === 'failed' || (fields.outcome === 'skipped' && /(?:^|_)deadline$/.test(fields.failureClass || '')));
      return !!(entry && (isImageFailureEntry(entry) || textFailure || entry.lv === 'WARN' || entry.lv === 'ERROR'));
    }

    function compactIncident(entry) {
      var fields = entry.fields || {};
      var compact = {
        at: entry.tsUtc || entry.ts || '',
        type: entry.type || entry.lv || '',
        reason: String(fields.reason || entry.msg || '').substring(0, 120),
        host: String(fields.host || '').substring(0, 120),
        threadId: String(fields.threadId || '').substring(0, 80),
        idx: typeof fields.idx === 'number' ? fields.idx : undefined,
        queueKind: String(fields.queueKind || '').substring(0, 48),
        ms: typeof fields.ms === 'number' ? fields.ms : undefined
      };
      if (isImageFailureEntry(entry) && fields.url) compact.url = sanitizeLogUrl(fields.url);
      if (entry.type === 'txt_request' || entry.type === 'txt_result') {
        ['attachmentId', 'stage', 'outcome', 'failureClass'].forEach(function(key) {
          if (typeof fields[key] === 'string') compact[key] = fields[key].substring(0, 80);
        });
        ['runId', 'remainingMs', 'attemptedCount', 'unresolvedCount', 'retryableCount', 'fetchedResources', 'addedResources', 'totalResources'].forEach(function(key) {
          if (typeof fields[key] === 'number' && isFinite(fields[key])) compact[key] = fields[key];
        });
      }
      return compact;
    }

    function rememberIncident(entry) {
      if (!enableRetention || !entry || entry.type === RETENTION_TYPE) return;
      if (entry.type === 'diagnostic_config') {
        retention.config = entry.fields || null;
        return;
      }
      var imageFailure = isImageFailureEntry(entry);
      if (!isIncidentEntry(entry)) return;
      var incident = compactIncident(entry);
      retention.incidentCount++;
      if (!retention.firstIncident) retention.firstIncident = incident;
      if (imageFailure && !retention.firstImageFailure) retention.firstImageFailure = incident;
      retention.recentIncidents.push(incident);
      if (retention.recentIncidents.length > RETENTION_RECENT_INCIDENTS) retention.recentIncidents.shift();
      incrementRetentionCount(retention.incidentTypes, incident.type);
      if (incident.host) incrementRetentionCount(retention.incidentHosts, incident.host);
    }

    function scheduleFlush(delayMs) {
      if (!autoFlushEnabled) return;
      if (!buffer.length && !retryBatch && !flushQueue.length) return;
      if (typeof setTimeout !== 'function') {
        return;
      }
      var delay = Math.max(0, Number(delayMs) || NORMAL_FLUSH_DEBOUNCE_MS);
      var dueAt = Date.now() + delay;
      if (flushTimer) {
        if (flushTimerDueAt <= dueAt) return;
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushTimerDueAt = dueAt;
      flushTimer = setTimeout(function() {
        flushTimer = null;
        flushTimerDueAt = 0;
        flush();
      }, delay);
    }

    function clearScheduledFlush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
        flushTimerDueAt = 0;
      }
    }

    function add(level, msg, data, type) {
      if (!isEnabled(level)) return;
      var timestampDate = new Date();
      var safeMsg = sanitizeLogText(msg).substring(0, 240);
      var entry = {
        ts: now(timestampDate),
        tsUtc: timestampDate.toISOString(),
        timezoneOffsetMinutes: getTimezoneOffsetMinutes(timestampDate),
        timezone: getTimezoneName(),
        lv: level,
        src: source,
        msg: safeMsg
      };
      if (!isBgMode) {
        entry.sessionId = SESSION_ID;
        entry.pageUrl = getPageUrl();
        entry.pageHost = getPageHost();
        entry.version = getVersion();
      }
      if (type) entry.type = type;

      var normalizedFields;
      if (data !== undefined) {
        if (typeof data === 'object' && data !== null) {
          try {
            normalizedFields = normalizeFields(data);
          } catch (e) {
            normalizedFields = { error: 'unserializable' };
          }
          entry.fields = normalizedFields;
        } else {
          entry.data = stringifyData(data);
        }
      }

      // Precompute and cache byte size once
      estimateLogEntryBytes(entry);

      buffer.push(entry);
      enqueuedLogCount++;
      if (enableRetention) {
        retention.observedEntries++;
        rememberIncident(entry);
      }

      var prefix = '[' + (consoleTagSource || source) + ':' + level + ']';
      var consoleData = data === undefined ? '' :
        (typeof data === 'object' && data !== null ? stringifyData(data, normalizedFields) : entry.data);
      var consoleLine = prefix + ' ' + safeMsg + (consoleData ? ' ' + consoleData : '');
      if (level === 'ERROR') {
        console.error(consoleLine);
      } else if (level === 'WARN') {
        console.warn(consoleLine);
      } else {
        console.log(consoleLine);
      }

      if (level === 'ERROR' || buffer.length >= IMMEDIATE_FLUSH_BUFFER_SIZE) {
        flush();
      } else if (level === 'WARN') {
        if (typeof setTimeout !== 'function' && (!normalizedFields || normalizedFields.type !== 'image_failure')) {
          flush();
        } else {
          scheduleFlush(WARN_FLUSH_DEBOUNCE_MS);
        }
      } else {
        scheduleFlush(NORMAL_FLUSH_DEBOUNCE_MS);
      }
    }

    function isContentLogKey(key) {
      var prefix = LOG_KEY_BASE + '_';
      return typeof key === 'string' && key.indexOf(prefix) === 0 && /^\d+(?:_|$)/.test(key.slice(prefix.length));
    }

    function getContentLogKeyTimestamp(key) {
      var prefix = LOG_KEY_BASE + '_';
      if (!isContentLogKey(key)) return 0;
      var ts = parseInt(key.slice(prefix.length), 10);
      return isNaN(ts) ? 0 : ts;
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
      var area = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
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

    function resetRetention() {
      retention.observedEntries = 0;
      retention.droppedEntries = 0;
      retention.droppedBatches = 0;
      retention.firstDroppedAt = '';
      retention.lastDroppedAt = '';
      retention.incidentCount = 0;
      retention.config = null;
      retention.firstIncident = null;
      retention.firstImageFailure = null;
      retention.recentIncidents = [];
      retention.incidentTypes = {};
      retention.incidentHosts = {};
    }

    function makeRetentionEntry() {
      var date = new Date();
      return {
        ts: now(date),
        tsUtc: date.toISOString(),
        timezoneOffsetMinutes: getTimezoneOffsetMinutes(date),
        timezone: getTimezoneName(),
        lv: 'INFO',
        src: source,
        msg: '日志留存状态',
        type: RETENTION_TYPE,
        sessionId: SESSION_ID,
        pageUrl: getPageUrl(),
        pageHost: getPageHost(),
        version: getVersion(),
        fields: {
          observedEntries: retention.observedEntries,
          droppedEntries: retention.droppedEntries,
          droppedBatches: retention.droppedBatches,
          firstDroppedAt: retention.firstDroppedAt,
          lastDroppedAt: retention.lastDroppedAt,
          incidentCount: retention.incidentCount,
          config: retention.config,
          firstIncident: retention.firstIncident,
          firstImageFailure: retention.firstImageFailure,
          recentIncidents: retention.recentIncidents,
          incidentTypes: retention.incidentTypes,
          incidentHosts: retention.incidentHosts
        }
      };
    }

    function fitRetentionEntry(entry) {
      invalidateEntryByteSize(entry);
      if (estimateLogEntryBytes(entry) <= RETENTION_RESERVED_BYTES) return entry;
      entry.fields.recentIncidents = (entry.fields.recentIncidents || []).slice(-3);
      invalidateEntryByteSize(entry);
      if (estimateLogEntryBytes(entry) <= RETENTION_RESERVED_BYTES) return entry;
      entry.fields.incidentHosts = {};
      entry.fields.incidentTypes = {};
      invalidateEntryByteSize(entry);
      if (estimateLogEntryBytes(entry) <= RETENTION_RESERVED_BYTES) return entry;
      entry.fields.recentIncidents = [];
      invalidateEntryByteSize(entry);
      estimateLogEntryBytes(entry);
      return entry;
    }

    function refreshRetainedIncidents(ordinary, previousRetention) {
      var retainedIncidentCount = 0;
      for (var i = 0; i < ordinary.length; i++) {
        if (isIncidentEntry(ordinary[i])) retainedIncidentCount++;
      }
      var priorCount = previousRetention ? Math.max(0, Number(previousRetention.incidentCount) || 0) : 0;
      if (priorCount > retainedIncidentCount && retention.observedEntries <=
          (Number(previousRetention.observedEntries) || 0)) {
        retention.incidentCount = priorCount;
        retention.firstIncident = previousRetention.firstIncident || retention.firstIncident;
        retention.firstImageFailure = previousRetention.firstImageFailure || retention.firstImageFailure;
        retention.incidentTypes = previousRetention.incidentTypes || retention.incidentTypes;
        retention.incidentHosts = previousRetention.incidentHosts || retention.incidentHosts;
      }
      if (previousRetention && previousRetention.droppedEntries > 0 &&
          (!retention.firstIncident || !retention.firstImageFailure)) {
        retention.firstIncident = retention.firstIncident || previousRetention.firstIncident || null;
        retention.firstImageFailure = retention.firstImageFailure || previousRetention.firstImageFailure || null;
      }
      if (previousRetention && Array.isArray(previousRetention.recentIncidents)) {
        var recent = previousRetention.recentIncidents.slice(-RETENTION_RECENT_INCIDENTS);
        var latest = retention.recentIncidents.slice(-RETENTION_RECENT_INCIDENTS);
        for (var ri = 0; ri < ordinary.length; ri++) {
          if (!isIncidentEntry(ordinary[ri])) continue;
          recent.push(compactIncident(ordinary[ri]));
        }
        for (var li = 0; li < latest.length; li++) {
          recent.push(latest[li]);
        }
        recent.sort(function(a, b) {
          return String(a.at || '').localeCompare(String(b.at || '')) || (Number(a.idx) || 0) - (Number(b.idx) || 0);
        });
        var deduped = [];
        for (var di = 0; di < recent.length; di++) {
          var previous = deduped.length ? deduped[deduped.length - 1] : null;
          var item = recent[di];
          if (previous && previous.at === item.at && previous.type === item.type &&
              previous.threadId === item.threadId && previous.idx === item.idx) continue;
          deduped.push(item);
        }
        retention.recentIncidents = deduped.slice(-RETENTION_RECENT_INCIDENTS);
      }
    }

    function resolveFlushWaiters(ok, all) {
      var ready = [];
      for (var i = flushWaiters.length - 1; i >= 0; i--) {
        if (all || flushWaiters[i].target <= settledLogCount) ready.unshift(flushWaiters.splice(i, 1)[0]);
      }
      for (var ri = 0; ri < ready.length; ri++) ready[ri].callback(!!ok);
    }

    function finishLogWrite(success) {
      if (success) {
        flushErrorCount = 0;
        settledLogCount += inFlightLogCount;
      }
      inFlightLogCount = 0;
      flushing = false;
      if (success) resolveFlushWaiters(true, false);
      if (buffer.length || retryBatch || flushQueue.length) {
        flush();
        return;
      }
      resolveFlushWaiters(success, true);
    }

    function readLogKeySizes(keys, callback) {
      var area = chrome.storage.local;
      var sizes = Object.create(null);
      var index = 0;

      function readNext() {
        if (index === keys.length) {
          callback(sizes);
          return;
        }
        var key = keys[index++];
        function readShard() {
          try {
            area.get(key, function(result) {
              if (chrome.runtime.lastError || !result) {
                callback(null);
                return;
              }
              sizes[key] = result[key] === undefined ? 0 : estimateLogBytes(result[key]);
              readNext();
            });
          } catch (e) {
            callback(null);
          }
        }

        if (typeof area.getBytesInUse !== 'function') {
          readShard();
          return;
        }
        try {
          area.getBytesInUse(key, function(bytes) {
            if (chrome.runtime.lastError || !Number.isFinite(bytes) || bytes < 0) {
              readShard();
              return;
            }
            sizes[key] = Math.max(0, bytes - estimateStringBytes(key));
            readNext();
          });
        } catch (e) {
          readShard();
        }
      }

      readNext();
    }

    function planLogKeyPrune(keys, sizes, forceDropOldest) {
      var stale = [];
      var kept = [];
      var totalBytes = sizes[LOG_KEY] || 0;
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === LOG_KEY) {
          kept.push(key);
          continue;
        }
        var bytes = sizes[key];
        if (bytes !== undefined && totalBytes + bytes <= MAX_LOG_TOTAL_BYTES) {
          kept.push(key);
          totalBytes += bytes;
        } else {
          stale.push(key);
        }
      }
      if (forceDropOldest && !stale.length) {
        for (var k = kept.length - 1; k >= 0; k--) {
          if (kept[k] !== LOG_KEY) {
            stale.push(kept.splice(k, 1)[0]);
            break;
          }
        }
      }
      return { kept: kept, stale: stale };
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
      var failed = [];
      var index = 0;
      function removeNext() {
        if (index === plan.stale.length) {
          var keys = failed.length ? mergeSortedContentLogKeys(plan.kept, failed) : plan.kept;
          writeLogKeyIndex(keys, callback);
          return;
        }
        var key = plan.stale[index++];
        chrome.storage.local.remove(key, function() {
          if (chrome.runtime.lastError) {
            console.warn('[Logger] 旧日志清理失败:', chrome.runtime.lastError.message);
            failed.push(key);
          }
          removeNext();
        });
      }
      removeNext();
    }

    function pruneStoredContentLogs(forceDropOldest, callback) {
      if (!isSharded || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        if (callback) callback(false);
        return;
      }
      chrome.storage.local.get(LOG_KEY_INDEX, function(result) {
        if (chrome.runtime.lastError) {
          console.warn('[Logger] 日志索引读取失败:', chrome.runtime.lastError.message);
          if (callback) callback(false);
          return;
        }
        var indexedKeys = collectSortedContentLogKeys(result[LOG_KEY_INDEX], LOG_KEY);
        collectStoredContentLogKeys(function(discoveredKeys) {
          var keys = mergeSortedContentLogKeys(indexedKeys, discoveredKeys, LOG_KEY);
          var readKeys = [LOG_KEY];
          for (var i = 0; i < keys.length && readKeys.length < MAX_LOG_KEYS; i++) {
            if (keys[i] !== LOG_KEY) readKeys.push(keys[i]);
          }
          readLogKeySizes(readKeys, function(sizes) {
            if (!sizes) {
              console.warn('[Logger] 日志容量读取失败');
              if (callback) callback(false);
              return;
            }
            removeStaleLogKeysThenWriteIndex(planLogKeyPrune(keys, sizes, !!forceDropOldest), callback);
          });
        });
      });
    }

    function rememberLogKey() {
      if (!isSharded || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      var nowMs = Date.now();
      if (lastLogKeyMaintenanceAt && nowMs - lastLogKeyMaintenanceAt < LOG_KEY_MAINTENANCE_INTERVAL_MS) return;
      lastLogKeyMaintenanceAt = nowMs;
      pruneStoredContentLogs(false, function(ok) {
        if (!ok) lastLogKeyMaintenanceAt = 0;
      });
    }

    function writeMergedLogs(merged, batch, retried) {
      chrome.storage.local.get(LOG_CLEARED_AT_KEY, function(clearResult) {
        if (chrome.runtime.lastError) {
          console.warn('[' + warnTag + '] 清空标记读取失败:', chrome.runtime.lastError.message);
          requeueBatch(batch, chrome.runtime.lastError.message);
          finishLogWrite(false);
          return;
        }
        var clearedAtMs = getLogClearedAtMs(clearResult && clearResult[LOG_CLEARED_AT_KEY]);
        var filteredBatch = filterLogsAfterClearedAt(batch, clearedAtMs);
        var filtered = filterLogsAfterClearedAt(merged, clearedAtMs);

        if (!enableRetention) {
          var bgRetained = trimLogEntries(filtered, MAX_ENTRIES, MAX_LOG_KEY_BYTES);
          if (!bgRetained.length) {
            chrome.storage.local.remove(LOG_KEY, function() {
              if (chrome.runtime.lastError) {
                console.warn('[' + warnTag + '] 清空前日志移除失败:', chrome.runtime.lastError.message);
              }
              finishLogWrite(true);
            });
            return;
          }
          var bgData = {};
          bgData[LOG_KEY] = bgRetained;
          chrome.storage.local.set(bgData, function() {
            if (chrome.runtime.lastError) {
              console.warn('[' + warnTag + '] storage写入失败:', chrome.runtime.lastError.message);
              if (!retried) {
                writeMergedLogs(trimLogEntriesFrom(bgRetained, Math.ceil(bgRetained.length / 2), MAX_LOG_KEY_BYTES), filteredBatch, true);
                return;
              }
              settledLogCount += batch.length - filteredBatch.length;
              requeueBatch(filteredBatch, chrome.runtime.lastError.message);
            }
            finishLogWrite(!chrome.runtime.lastError);
          });
          return;
        }

        var previousRetention = null;
        var ordinary = [];
        for (var fi = 0; fi < filtered.length; fi++) {
          if (!filtered[fi]) continue;
          if (filtered[fi].type === RETENTION_TYPE) previousRetention = filtered[fi].fields || null;
          else ordinary.push(filtered[fi]);
        }
        if (clearedAtMs > lastClearedAtMs) {
          var clearedDuringSession = clearedAtMs >= SESSION_STARTED_AT_MS;
          lastClearedAtMs = clearedAtMs;
          if (clearedDuringSession) {
            resetRetention();
            retention.observedEntries = ordinary.length;
            for (var ci = 0; ci < ordinary.length; ci++) rememberIncident(ordinary[ci]);
          }
        } else if (previousRetention && previousRetention.droppedEntries > retention.droppedEntries) {
          retention.droppedEntries = previousRetention.droppedEntries;
          retention.droppedBatches = previousRetention.droppedBatches || retention.droppedBatches;
          retention.firstDroppedAt = previousRetention.firstDroppedAt || '';
          retention.lastDroppedAt = previousRetention.lastDroppedAt || '';
          if (retention.observedEntries <= (Number(previousRetention.observedEntries) || 0)) {
            retention.observedEntries = Number(previousRetention.observedEntries) || 0;
            retention.incidentCount = previousRetention.incidentCount || retention.incidentCount;
            retention.incidentTypes = previousRetention.incidentTypes || retention.incidentTypes;
            retention.incidentHosts = previousRetention.incidentHosts || retention.incidentHosts;
          }
          retention.firstIncident = previousRetention.firstIncident || retention.firstIncident;
          retention.firstImageFailure = previousRetention.firstImageFailure || retention.firstImageFailure;
        }
        if (previousRetention && !retention.config) retention.config = previousRetention.config || null;
        refreshRetainedIncidents(ordinary, previousRetention);
        var retained = trimLogEntries(ordinary, MAX_ENTRIES - 1, MAX_LOG_KEY_BYTES - RETENTION_RESERVED_BYTES);
        var droppedNow = ordinary.length - retained.length;
        retention.droppedEntries += droppedNow;
        if (droppedNow > 0) {
          if (!retention.firstDroppedAt) {
            retention.firstDroppedAt = ordinary[0].tsUtc || ordinary[0].ts || '';
          }
          retention.lastDroppedAt = ordinary[droppedNow - 1].tsUtc || ordinary[droppedNow - 1].ts || '';
        }
        merged = ordinary.length ? [fitRetentionEntry(makeRetentionEntry())].concat(retained) : [];
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
                var retryStart = Math.max(1, Math.ceil(merged.length / 2));
                if (retryStart > 1) {
                  retention.droppedEntries += retryStart - 1;
                  if (!retention.firstDroppedAt) retention.firstDroppedAt = merged[1].tsUtc || merged[1].ts || '';
                  retention.lastDroppedAt = merged[retryStart - 1].tsUtc || merged[retryStart - 1].ts || '';
                }
                var retryMerged = trimLogEntriesFrom(merged, retryStart, MAX_LOG_KEY_BYTES - RETENTION_RESERVED_BYTES);
                writeMergedLogs([fitRetentionEntry(makeRetentionEntry())].concat(retryMerged), filteredBatch, true);
              });
              return;
            }
            settledLogCount += batch.length - filteredBatch.length;
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
        console.warn('[' + warnTag + '] storage连续失败，丢弃日志批次:', reason || '');
        if (enableRetention) {
          retention.droppedBatches++;
          retention.droppedEntries += batch.length;
          if (!retention.firstDroppedAt && batch[0]) retention.firstDroppedAt = batch[0].tsUtc || batch[0].ts || '';
          if (batch.length) retention.lastDroppedAt = batch[batch.length - 1].tsUtc || batch[batch.length - 1].ts || '';
        }
        flushErrorCount = 0;
        settledLogCount += batch.length;
        resolveFlushWaiters(false, true);
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

    function flush(callback) {
      clearScheduledFlush();
      if (typeof callback === 'function') flushWaiters.push({ target: enqueuedLogCount, callback: callback });
      if (buffer.length) {
        flushQueue.push(buffer.splice(0, buffer.length));
        while (flushQueue.length > MAX_FLUSH_QUEUE_BATCHES) {
          var droppedBatch = flushQueue.shift();
          settledLogCount += droppedBatch.length;
          if (enableRetention) {
            retention.droppedBatches++;
            retention.droppedEntries += droppedBatch.length;
            if (!retention.firstDroppedAt && droppedBatch[0]) retention.firstDroppedAt = droppedBatch[0].tsUtc || droppedBatch[0].ts || '';
            if (droppedBatch.length) retention.lastDroppedAt = droppedBatch[droppedBatch.length - 1].tsUtc || droppedBatch[droppedBatch.length - 1].ts || '';
          }
        }
      }
      if (flushing) return;
      if (!retryBatch && flushQueue.length === 0) {
        resolveFlushWaiters(true, true);
        return;
      }
      var batch = drainFlushQueue();
      inFlightLogCount = batch.length;
      flushing = true;

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          chrome.storage.local.get(LOG_KEY, function(result) {
            if (chrome.runtime.lastError) {
              console.warn('[' + warnTag + '] storage读取失败:', chrome.runtime.lastError.message);
              requeueBatch(batch, chrome.runtime.lastError.message);
              inFlightLogCount = 0;
              flushing = false;
              if (buffer.length || retryBatch || flushQueue.length) flush();
              return;
            }
            var merged = mergeLogEntries(result && result[LOG_KEY], batch);
            writeMergedLogs(merged, batch, false);
          });
        } catch (e) {
          console.warn('[' + warnTag + '] storage访问异常:', e && e.message ? e.message : String(e));
          requeueBatch(batch, e && e.message);
          inFlightLogCount = 0;
          flushing = false;
        }
      } else {
        requeueBatch(batch, 'storage不可用');
        inFlightLogCount = 0;
        flushing = false;
      }
    }

    function flushSoon(delay) {
      if (!buffer.length && !retryBatch && !flushQueue.length) return;
      scheduleFlush(delay !== undefined ? delay : NORMAL_FLUSH_DEBOUNCE_MS);
    }

    // Safe public methods preserved for content.js compatibility without setInterval
    function startFlushTimer() {
      autoFlushEnabled = true;
      if (buffer.length || retryBatch || flushQueue.length) {
        scheduleFlush(NORMAL_FLUSH_DEBOUNCE_MS);
      }
    }

    function stopFlushTimer() {
      autoFlushEnabled = false;
      clearScheduledFlush();
    }

    if (options.attachLifecycle) {
      if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', function() { flush(); });
      }
      if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', function() {
          if (document.visibilityState === 'hidden') flush();
        });
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage && chrome.runtime.onMessage.addListener) {
        chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
          if (!message || message.type !== 'ATP_FLUSH_CONTENT_LOGS') return false;
          flush(function(ok) { sendResponse({ ok: ok === true, sessionId: SESSION_ID, logKey: LOG_KEY }); });
          return true;
        });
      }
    }

    return {
      init: init,
      debug: function(msg, data) { add('DEBUG', msg, data); },
      info: function(msg, data) { add('INFO', msg, data); },
      warn: function(msg, data) { add('WARN', msg, data); },
      error: function(msg, data) { add('ERROR', msg, data); },
      event: function(type, fields, level) { add(level || 'DEBUG', type, fields || {}, type); },
      isEnabled: isEnabled,
      setDebugEnabled: setDebugEnabled,
      getSessionId: function() { return SESSION_ID; },
      getStorageKey: function() { return LOG_KEY; },
      sanitizeUrl: sanitizeLogUrl,
      flush: flush,
      flushSoon: flushSoon,
      startFlushTimer: startFlushTimer,
      stopFlushTimer: stopFlushTimer
    };
  }

  var hasWindowDocument = typeof window !== 'undefined' && typeof document !== 'undefined';
  var defaultLogger = createLogger({
    sharded: true,
    enableRetention: true,
    attachLifecycle: hasWindowDocument
  });

  if (root) {
    root.ATPCreateLogger = createLogger;
    root.Logger = defaultLogger;
  }
  if (typeof window !== 'undefined' && window) {
    window.ATPCreateLogger = createLogger;
    window.Logger = defaultLogger;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));

const ATPCreateLogger = globalThis.ATPCreateLogger;
const Logger = globalThis.Logger;
