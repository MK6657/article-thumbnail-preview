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
  var SESSION_STARTED_AT_MS = Date.now();
  var FIELD_VALUE_LIMIT = 240;
  var DATA_VALUE_LIMIT = 800;
  var MAX_FIELD_KEYS = 80;
  var UNSERIALIZABLE_FIELD = {};
  var RETENTION_TYPE = 'log_retention';
  var RETENTION_RESERVED_BYTES = 12288;
  var RETENTION_RECENT_INCIDENTS = 6;
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
  // Each waiter resolves once every entry logged before its flush request has
  // been written or dropped, so continuous logging cannot starve it.
  var flushWaiters = [];
  var enqueuedLogCount = 0;
  var settledLogCount = 0;
  var inFlightLogCount = 0;
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
    var values = [];
    // 每个值只读取一次（可能是 getter）；值为 undefined 的键序列化后本就不存在，不占字段上限
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

  function incrementRetentionCount(counts, value) {
    var key = String(value || 'unknown').substring(0, 80);
    if (!Object.prototype.hasOwnProperty.call(counts, key) && Object.keys(counts).length >= 12) key = 'other';
    counts[key] = (counts[key] || 0) + 1;
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
    return compact;
  }

  function isImageFailureEntry(entry) {
    return !!(entry && (entry.type === 'image_failure' ||
      (entry.type === 'image_done' && entry.fields && entry.fields.ok === false)));
  }

  function isIncidentEntry(entry) {
    return !!(entry && (isImageFailureEntry(entry) || entry.lv === 'WARN' || entry.lv === 'ERROR'));
  }

  function rememberIncident(entry) {
    if (!entry || entry.type === RETENTION_TYPE) return;
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

  function markObservedEntry() {
    retention.observedEntries++;
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
      // Structured fields are already sanitized; storing their JSON string a
      // second time consumes the per-session byte budget without adding facts.
      if (typeof data !== 'object') entry.data = stringifyData(data);
    }
    buffer.push(entry);
    enqueuedLogCount++;
    markObservedEntry();
    rememberIncident(entry);

    var prefix = '[' + source + ':' + level + ']';
    var consoleData = data === undefined ? '' :
      (typeof data === 'object' ? stringifyData(data, normalizedFields) : entry.data);
    var consoleLine = prefix + ' ' + safeMsg + (consoleData ? ' ' + consoleData : '');
    if (level === 'ERROR') {
      console.error(consoleLine);
    } else if (level === 'WARN') {
      console.warn(consoleLine);
    } else {
      console.log(consoleLine);
    }

    if (buffer.length >= 20 || (level === 'WARN' && type !== 'image_failure') || level === 'ERROR') {
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
    if (estimateLogEntryBytes(entry) <= RETENTION_RESERVED_BYTES) return entry;
    entry.fields.recentIncidents = (entry.fields.recentIncidents || []).slice(-3);
    if (estimateLogEntryBytes(entry) <= RETENTION_RESERVED_BYTES) return entry;
    entry.fields.incidentHosts = {};
    entry.fields.incidentTypes = {};
    if (estimateLogEntryBytes(entry) <= RETENTION_RESERVED_BYTES) return entry;
    entry.fields.recentIncidents = [];
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


  function planLogKeyPrune(keys, items, forceDropOldest) {
    keys = collectSortedContentLogKeys(keys);
    var stale = [];
    var kept = [];
    // The live session's shard is never pruned by its own writer: with 20+
    // newer tabs it ranked past MAX_LOG_KEYS and was deleted right after each
    // write. It takes its slot and bytes first, then the newest others fill in.
    var ownShard = keys.indexOf(LOG_KEY) !== -1;
    var keptCount = ownShard ? 1 : 0;
    var totalBytes = ownShard ? estimateLogBytes(items && items[LOG_KEY]) : 0;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === LOG_KEY) {
        kept.push(key);
        continue;
      }
      var bytes = keptCount < MAX_LOG_KEYS ? estimateLogBytes(items && items[key]) : 0;
      if (keptCount < MAX_LOG_KEYS && totalBytes + bytes <= MAX_LOG_TOTAL_BYTES) {
        kept.push(key);
        keptCount++;
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
      var filtered = filterLogsAfterClearedAt(merged, clearedAtMs);
      var previousRetention = null;
      var ordinary = [];
      for (var fi = 0; fi < filtered.length; fi++) {
        if (!filtered[fi]) continue;
        if (filtered[fi].type === RETENTION_TYPE) previousRetention = filtered[fi].fields || null;
        else ordinary.push(filtered[fi]);
      }
      if (clearedAtMs > lastClearedAtMs) {
        // Only a clear made while this page was open resets the session
        // counters; an older marker merely filters entries logged before it.
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
      // Count actual trims: entries still buffered while this write runs are
      // not dropped and must not inflate the "已裁剪" summary.
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
                // merged[0] is the retention entry; the halving drops the rest.
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
      console.warn('[Logger] storage连续失败，丢弃日志批次:', reason || '');
      retention.droppedBatches++;
      retention.droppedEntries += batch.length;
      if (!retention.firstDroppedAt && batch[0]) retention.firstDroppedAt = batch[0].tsUtc || batch[0].ts || '';
      if (batch.length) retention.lastDroppedAt = batch[batch.length - 1].tsUtc || batch[batch.length - 1].ts || '';
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
    if (typeof callback === 'function') flushWaiters.push({ target: enqueuedLogCount, callback: callback });
    if (buffer.length) {
      flushQueue.push(buffer.splice(0, buffer.length));
      // 防止 flushing 卡死或存储长期不可用时积压无上界：超限丢最旧批次
      while (flushQueue.length > MAX_FLUSH_QUEUE_BATCHES) {
        var droppedBatch = flushQueue.shift();
        settledLogCount += droppedBatch.length;
        retention.droppedBatches++;
        retention.droppedEntries += droppedBatch.length;
        if (!retention.firstDroppedAt && droppedBatch[0]) retention.firstDroppedAt = droppedBatch[0].tsUtc || droppedBatch[0].ts || '';
        if (droppedBatch.length) retention.lastDroppedAt = droppedBatch[droppedBatch.length - 1].tsUtc || droppedBatch[droppedBatch.length - 1].ts || '';
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
            console.warn('[Logger] storage读取失败:', chrome.runtime.lastError.message);
            requeueBatch(batch, chrome.runtime.lastError.message);
            inFlightLogCount = 0;
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
        inFlightLogCount = 0;
        flushing = false;
      }
    } else {
      requeueBatch(batch, 'storage不可用');
      inFlightLogCount = 0;
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
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage && chrome.runtime.onMessage.addListener) {
    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
      if (!message || message.type !== 'ATP_FLUSH_CONTENT_LOGS') return false;
      flush(function(ok) { sendResponse({ ok: ok === true, sessionId: SESSION_ID, logKey: LOG_KEY }); });
      return true;
    });
  }

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
