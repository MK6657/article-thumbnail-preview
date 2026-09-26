/**
 * Background Service Worker
 */

importScripts('settings-schema.js');
importScripts('defaults.js');
importScripts('shared-utils.js');
importScripts('loading-policy.js');

if (typeof SharedUtils !== 'undefined' && SharedUtils.cacheIndex) {
  SharedUtils.cacheIndex._backgroundOwner = true;
}

const BGLOG = (function() {
  'use strict';
  var LOG_KEY = 'atp_logs_bg', MAX = 500, buf = [], flushQueue = [], retryBatch = null, flushing = false, flushTimer = null;
  var LOG_CLEARED_AT_KEY = 'atp_logs_cleared_at';
  var MAX_BYTES = (typeof SharedUtils !== 'undefined' && SharedUtils.BACKGROUND_LOG_BYTES) || (512 * 1024);
  var flushErrorCount = 0, MAX_FLUSH_RETRIES = 3, timezoneNameCache = null;
  var debugEnabled = false;
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
      return shortUrl(raw) + trailing;
    }
    return String(text === null || text === undefined ? '' : text)
      .replace(/(?:https?:)?\/\/[^\s"'<>]+/gi, replaceLogUrl)
      .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'<>]*)?[?#][^\s"'<>]+/gi, replaceLogUrl);
  }
  function sanitizeLogKey(key, existing) {
    var base = sanitizeLogText(key).substring(0, 120) || '[empty]';
    var safe = base;
    var n = 2;
    while (existing && Object.prototype.hasOwnProperty.call(existing, safe)) {
      var suffix = '_' + n++;
      safe = base.substring(0, Math.max(1, 120 - suffix.length)) + suffix;
    }
    return safe;
  }
  function sanitizeLogValue(value, key, seenObjects) {
    if (value === null || value === undefined) return value;
    if (isSensitiveLogFieldKey(key)) return '[redacted]';
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      if (seenObjects && seenObjects.has(value)) return '[Circular]';
      if (seenObjects) seenObjects.add(value);
      var arr = [];
      var arrayLimit = Math.min(value.length, 12);
      for (var ai = 0; ai < arrayLimit; ai++) {
        arr.push(sanitizeLogValue(value[ai], key, seenObjects));
      }
      if (seenObjects) seenObjects.delete(value);
      return arr;
    }
    if (typeof value === 'object') {
      seenObjects = seenObjects || (typeof WeakSet !== 'undefined' ? new WeakSet() : null);
      if (seenObjects && seenObjects.has(value)) return '[Circular]';
      if (seenObjects) seenObjects.add(value);
      var out = {};
      var childCount = 0;
      for (var childKey in value) {
        if (!Object.prototype.hasOwnProperty.call(value, childKey)) continue;
        if (childCount++ >= 40) break;
        var outputKey = sanitizeLogKey(childKey, out);
        try {
          out[outputKey] = sanitizeLogValue(value[childKey], childKey, seenObjects);
        } catch (e) {
          out[outputKey] = '[Unserializable]';
        }
      }
      if (seenObjects) seenObjects.delete(value);
      return out;
    }
    return (isUrlFieldKey(key) ? shortUrl(value) : sanitizeLogText(value)).substring(0, 500);
  }
  function stringifyLogData(d) {
    if (d === undefined) return '';
    if (typeof d === 'object') {
      try { return JSON.stringify(sanitizeLogValue(d, '')).substring(0, 500); } catch (ex) { return sanitizeLogText(d).substring(0, 500); }
    }
    return sanitizeLogText(d).substring(0, 500);
  }
  function formatConsoleData(d) {
    return stringifyLogData(d);
  }
  function estimateLogBytes(value) {
    try { return JSON.stringify(value || []).length; } catch (e) { return String(value || '').length; }
  }
  function trimLogEntries(entries, maxEntries, maxBytes) {
    if (!Array.isArray(entries) || !entries.length) return [];
    return trimLogEntriesFrom(entries, Math.max(0, entries.length - maxEntries), maxBytes);
  }
  function trimLogEntriesFrom(entries, start, maxBytes) {
    start = Math.max(0, Number(start) || 0);
    while (start < entries.length && estimateLogBytesFrom(entries, start) > maxBytes) {
      var remaining = entries.length - start;
      start += Math.max(1, Math.ceil(remaining * 0.1));
    }
    return copyLogEntriesFrom(entries, start);
  }
  function estimateLogBytesFrom(entries, start) {
    return estimateLogBytes(copyLogEntriesFrom(entries, start));
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
    if (buf.length || retryBatch || flushQueue.length) flush();
  }
  function writeLogs(entries, batch, retried) {
    chrome.storage.local.get(LOG_CLEARED_AT_KEY, function(clearResult) {
      if (chrome.runtime.lastError) {
        console.warn('[BGLOG] 清空标记读取失败:', chrome.runtime.lastError.message);
        requeueBatch(batch, chrome.runtime.lastError.message);
        finishLogWrite(false);
        return;
      }
      var clearedAtMs = getLogClearedAtMs(clearResult && clearResult[LOG_CLEARED_AT_KEY]);
      var filteredBatch = filterLogsAfterClearedAt(batch, clearedAtMs);
      var m = trimLogEntries(filterLogsAfterClearedAt(entries, clearedAtMs), MAX, MAX_BYTES);
      if (!m.length) {
        chrome.storage.local.remove(LOG_KEY, function() {
          if (chrome.runtime.lastError) {
            console.warn('[BGLOG] 清空前日志移除失败:', chrome.runtime.lastError.message);
          }
          finishLogWrite(true);
        });
        return;
      }
      var d = {}; d[LOG_KEY] = m;
      chrome.storage.local.set(d, function() {
        if (chrome.runtime.lastError) {
          console.warn('[BGLOG] storage写入失败:', chrome.runtime.lastError.message);
          if (!retried) {
            writeLogs(trimLogEntriesFrom(m, Math.ceil(m.length / 2), MAX_BYTES), filteredBatch, true);
            return;
          }
          requeueBatch(filteredBatch, chrome.runtime.lastError.message);
        }
        finishLogWrite(!chrome.runtime.lastError);
      });
    });
  }
  function add(lv, msg, d) {
    if (!isEnabled(lv)) return;
    var timestampDate = new Date();
    var safeMsg = sanitizeLogText(msg).substring(0, 160);
    var e = {
      ts: formatLocalTimestamp(timestampDate),
      tsUtc: timestampDate.toISOString(),
      timezoneOffsetMinutes: getTimezoneOffsetMinutes(timestampDate),
      timezone: getTimezoneName(),
      lv: lv,
      src: 'BACKGROUND',
      msg: safeMsg
    };
    if (d !== undefined) { try { e.data = stringifyLogData(d); } catch (ex) { /* circular ref or serialization error, skip */ } }
    buf.push(e);
    var consoleData = formatConsoleData(d);
    var consoleLine = '[BG:' + lv + '] ' + safeMsg + (consoleData ? ' ' + consoleData : '');
    if (lv === 'ERROR') console.error(consoleLine);
    else if (lv === 'WARN') console.warn(consoleLine);
    else console.log(consoleLine);
    if (lv === 'WARN' || lv === 'ERROR' || buf.length >= 10) flush();
    else flushSoon();
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
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (buf.length) flushQueue.push(buf.splice(0));
    if (flushing || (!retryBatch && !flushQueue.length)) return;
    flushing = true;
    var b = drainFlushQueue();
    chrome.storage.local.get(LOG_KEY, function(r) {
      if (chrome.runtime.lastError) {
        console.warn('[BGLOG] storage读取失败:', chrome.runtime.lastError.message);
        requeueBatch(b, chrome.runtime.lastError.message);
        flushing = false;
        if (buf.length || retryBatch || flushQueue.length) flush();
        return;
      }
      writeLogs(mergeLogEntries(r[LOG_KEY], b), b, false);
    });
  }
  function flushSoon(delay) {
    if (flushTimer) return;
    flushTimer = setTimeout(function() {
      flushTimer = null;
      flush();
    }, Math.max(0, Number(delay) || 250));
  }
  function requeueBatch(batch, reason) {
    if (!batch || !batch.length) return;
    flushErrorCount++;
    if (flushErrorCount > MAX_FLUSH_RETRIES) {
      console.warn('[BGLOG] storage连续失败，丢弃日志批次:', reason || '');
      flushErrorCount = 0;
      return;
    }
    retryBatch = batch;
  }
  return {
    debug: function(m, d) { add('DEBUG', m, d); },
    info: function(m, d) { add('INFO', m, d); },
    warn: function(m, d) { add('WARN', m, d); },
    error: function(m, d) { add('ERROR', m, d); },
    isEnabled: isEnabled,
    setDebugEnabled: setDebugEnabled,
    flush: flush,
    flushSoon: flushSoon
  };
})();

var bgCacheTtlMs = 30 * 60 * 1000;

function syncBackgroundDebugLogging(rawSettings) {
  var normalized = ATPNormalizeSettings(rawSettings);
  BGLOG.setDebugEnabled(normalized.debugLogging === true);
  bgCacheTtlMs = (Number(normalized.cacheTTL) || 30) * 60 * 1000;
}

// Entries past the cache TTL go first (oldest first): they can never be read
// again, yet type priority alone evicted every live article before them.
function compareEvictionOrder(a, b, expiredBefore) {
  var aExpired = a.ts < expiredBefore;
  var bExpired = b.ts < expiredBefore;
  if (aExpired !== bExpired) return aExpired ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.ts - b.ts;
}

try {
  chrome.storage.local.get('settings', function(result) {
    if (chrome.runtime.lastError) {
      BGLOG.setDebugEnabled(false);
      return;
    }
    syncBackgroundDebugLogging(result && result.settings);
  });
} catch (e) {
  BGLOG.setDebugEnabled(false);
}

if (chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
  chrome.storage.onChanged.addListener(function(changes, areaName) {
    if (areaName !== 'local') return;
    if (changes.settings) {
      syncBackgroundDebugLogging(changes.settings.newValue);
    }
    var generationKey = (typeof SharedUtils !== 'undefined' && SharedUtils.CACHE_GENERATION_KEY) || 'atp_cache_generation_v1';
    if (changes[generationKey]) {
      cachedCacheGeneration = getCacheGeneration(changes[generationKey].newValue);
    }
  });
}

function isAllowedOriginHost(host) {
  return SharedUtils.isSupportedForumHost(host);
}

function originAllowed(url) {
  try {
    var u = new URL(url);
    return u.protocol === 'https:' && isAllowedOriginHost(u.hostname);
  } catch (e) { return false; }
}

function textAttachmentAllowed(url) {
  return SharedUtils.isAllowedTextAttachmentUrl(url);
}

function textAttachmentAllowedInZone(url, zone) {
  return SharedUtils.isTextAttachmentUrlAllowedInZone(url, zone);
}

// The zone of the forum page that sent a message; '' for anything else.
function getSenderForumZone(sender) {
  var url = (sender && sender.url) || '';
  return originAllowed(url) ? SharedUtils.getForumUrlZone(url) : '';
}

function forumUrlAllowedInZone(url, zone) {
  return !!zone && originAllowed(url) && SharedUtils.getForumUrlZone(url) === zone;
}

// ---- Forum mirror sites ----
// Mirrors are optional host permissions granted from the popup prompt or the
// browser's site-access settings. Chrome's grant list is the only source of
// truth: the worker mirrors it into SharedUtils for host checks, stores it
// for content scripts, and registers the manifest content scripts on it.
const MIRROR_CONTENT_SCRIPT_ID_PREFIX = 'atp-mirror-';
var mirrorSitesLoaded = !canManageMirrorSites();
var mirrorSitesChain = Promise.resolve();
var mirrorSitesReady = Promise.resolve();

function canManageMirrorSites() {
  return !!(chrome.permissions && typeof chrome.permissions.getAll === 'function');
}

function getGrantedPermissionOrigins() {
  return new Promise(function(resolve, reject) {
    chrome.permissions.getAll(function(result) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result && Array.isArray(result.origins) ? result.origins : []);
    });
  });
}

function readStoredMirrorSites() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(SharedUtils.MIRROR_SITES_STORAGE_KEY, function(result) {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      var stored = result && result[SharedUtils.MIRROR_SITES_STORAGE_KEY];
      resolve(stored && Array.isArray(stored.sites) ? SharedUtils.normalizeMirrorSites(stored.sites) : null);
    });
  });
}

function storeMirrorSites(sites) {
  return new Promise(function(resolve) {
    var items = {};
    items[SharedUtils.MIRROR_SITES_STORAGE_KEY] = { sites: sites, updatedAt: Date.now() };
    chrome.storage.local.set(items, function() {
      consumeStorageError('镜像站点保存失败');
      resolve();
    });
  });
}

function getMirrorSitePatternKey(sites) {
  return sites.map(function(site) { return site.pattern; }).join('\n');
}

// One dynamic script per manifest content_scripts entry, so mirrors always
// get the exact files, order, world and timing the built-in sites get.
function buildMirrorContentScripts(patterns) {
  var manifest = chrome.runtime.getManifest();
  return (manifest.content_scripts || []).map(function(script, index) {
    var registration = {
      id: MIRROR_CONTENT_SCRIPT_ID_PREFIX + index,
      matches: patterns.slice(),
      js: (script.js || []).slice(),
      runAt: script.run_at || 'document_idle',
      allFrames: script.all_frames === true,
      persistAcrossSessions: true
    };
    if (script.css && script.css.length) registration.css = script.css.slice();
    if (script.world) registration.world = script.world;
    return registration;
  });
}

async function syncMirrorContentScripts(sites) {
  if (!chrome.scripting || typeof chrome.scripting.getRegisteredContentScripts !== 'function') return false;
  var wanted = sites.length ? buildMirrorContentScripts(sites.map(function(site) { return site.pattern; })) : [];
  var wantedIds = {};
  wanted.forEach(function(script) { wantedIds[script.id] = true; });
  var existing = {};
  var stale = [];
  (await chrome.scripting.getRegisteredContentScripts() || []).forEach(function(script) {
    if (!script || typeof script.id !== 'string' || script.id.indexOf(MIRROR_CONTENT_SCRIPT_ID_PREFIX) !== 0) return;
    existing[script.id] = true;
    if (!wantedIds[script.id]) stale.push(script.id);
  });
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  var updates = wanted.filter(function(script) { return existing[script.id]; });
  var additions = wanted.filter(function(script) { return !existing[script.id]; });
  if (updates.length) await chrome.scripting.updateContentScripts(updates);
  if (additions.length) await chrome.scripting.registerContentScripts(additions);
  return true;
}

// force: re-apply registrations even when the grant list is unchanged
// (install, update, browser start, permission events). A plain worker wake
// only compares against the stored list, so it stays cheap.
function refreshMirrorSites(reason, force) {
  var run = mirrorSitesChain.then(async function() {
    var sites = SharedUtils.getMirrorSitesFromOrigins(await getGrantedPermissionOrigins());
    SharedUtils.setMirrorSites(sites);
    mirrorSitesLoaded = true;
    var stored = await readStoredMirrorSites();
    var changed = !stored || getMirrorSitePatternKey(stored) !== getMirrorSitePatternKey(sites);
    if (changed) await storeMirrorSites(sites);
    var registered = true;
    if (changed || force) {
      try {
        registered = await syncMirrorContentScripts(sites);
      } catch (e) {
        registered = false;
        BGLOG.warn('镜像站点脚本注册失败', e && e.message ? e.message : String(e));
      }
      if (changed) BGLOG.info('镜像站点', reason + ' ' + sites.length + '个');
    }
    return { sites: sites, registered: registered };
  });
  mirrorSitesChain = run.catch(function() {});
  return run;
}

function refreshMirrorSitesInBackground(reason, force) {
  if (!canManageMirrorSites()) return;
  refreshMirrorSites(reason, force).catch(function(e) {
    mirrorSitesLoaded = true;
    BGLOG.warn('镜像站点读取失败', e && e.message ? e.message : String(e));
  });
}

if (canManageMirrorSites()) {
  mirrorSitesReady = refreshMirrorSites('worker_start', false).catch(function(e) {
    mirrorSitesLoaded = true;
    BGLOG.warn('镜像站点读取失败', e && e.message ? e.message : String(e));
  });
  if (chrome.permissions.onAdded && typeof chrome.permissions.onAdded.addListener === 'function') {
    chrome.permissions.onAdded.addListener(function() { refreshMirrorSitesInBackground('permission_added', true); });
    chrome.permissions.onRemoved.addListener(function() { refreshMirrorSitesInBackground('permission_removed', true); });
  }
  if (chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === 'function') {
    chrome.runtime.onStartup.addListener(function() { refreshMirrorSitesInBackground('browser_start', true); });
  }
}

function isExtensionPageSender(sender) {
  if (!sender || sender.tab || typeof sender.url !== 'string') return false;
  try {
    return sender.url.indexOf(chrome.runtime.getURL('')) === 0;
  } catch (e) {
    return false;
  }
}

var floatingPanelCssPromise = null;

// Mirror pages cannot load the web-accessible stylesheet (its matches stay
// limited to the built-in sites), so the panel asks the worker for the text.
function getFloatingPanelCss() {
  if (!floatingPanelCssPromise) {
    floatingPanelCssPromise = fetch(chrome.runtime.getURL('floating-panel.css')).then(function(resp) {
      if (!resp || !resp.ok) throw new Error('floating-panel.css HTTP ' + (resp && resp.status));
      return resp.text();
    }).catch(function(e) {
      floatingPanelCssPromise = null;
      throw e;
    });
  }
  return floatingPanelCssPromise;
}

function makeTextResourceFetchStatus(resources, attemptedCount, unresolvedCount, retryableCount) {
  var normalized = SharedUtils.normalizeResources(resources);
  var attempted = Math.max(0, Number(attemptedCount) || 0);
  var unresolved = Math.max(0, Number(unresolvedCount) || 0);
  if (unresolved > attempted) unresolved = attempted;
  var retryable = Math.max(0, Number(retryableCount) || 0);
  if (retryable > unresolved) retryable = unresolved;
  return {
    resources: normalized,
    attemptedCount: attempted,
    unresolvedCount: unresolved,
    retryableCount: retryable
  };
}

function getSafeAttachmentReferrer(attachment) {
  if (!attachment || !attachment.pageUrl || !attachment.url) return '';
  try {
    var referrerUrl = new URL(attachment.pageUrl);
    var targetUrl = new URL(attachment.url);
    if (referrerUrl.protocol !== 'https:' || targetUrl.protocol !== 'https:') return '';
    if (referrerUrl.origin !== targetUrl.origin) return '';
    referrerUrl.search = '';
    referrerUrl.hash = '';
    return referrerUrl.href;
  } catch (e) {
    return '';
  }
}

function shortUrl(url) {
  try {
    var u = new URL(String(url || ''));
    return (u.protocol + '//' + u.host + u.pathname).substring(0, 120);
  } catch (e) {
    return String(url || '').replace(/[?#].*$/, '').substring(0, 120);
  }
}

const TEXT_ATTACHMENT_MAX_COUNT = SharedUtils.TEXT_ATTACHMENT_MAX_COUNT;
const TEXT_ATTACHMENT_MAX_BYTES = SharedUtils.TEXT_ATTACHMENT_MAX_BYTES;
const TEXT_ATTACHMENT_TIMEOUT = SharedUtils.TEXT_ATTACHMENT_TIMEOUT;
const TEXT_RESOURCE_CACHE_PREFIX = SharedUtils.CACHE_PREFIXES.TEXT_RESOURCE;
const TEXT_FAIL_CACHE_PREFIX = SharedUtils.CACHE_PREFIXES.TEXT_FAIL;
const CACHE_GENERATION_KEY = SharedUtils.CACHE_GENERATION_KEY || 'atp_cache_generation_v1';
const TEXT_FAIL_TTL_MS = 5 * 60 * 1000;
const TEXT_RESOURCE_MESSAGE_CONCURRENCY = 2;
const TEXT_RESOURCE_QUEUE_LIMIT = 32;
const TEXT_RESOURCE_QUEUE_PER_OWNER = 4;
const TEXT_RESOURCE_QUEUE_MAX_WAIT_MS = 30000;
var SETTINGS_WRITE_CHAIN = Promise.resolve();
var ARTICLE_FETCH_IN_FLIGHT = {};
var textResourceMessageQueue = [];
var textResourceMessageActive = 0;

function makeQueuedTextResourceStatus(attachments, reason) {
  var count = attachments.length;
  var status = makeTextResourceFetchStatus(SharedUtils.emptyResources(), count, count, count);
  status.queueStatus = reason;
  return status;
}

function expireQueuedTextResourceJob(job) {
  var index = textResourceMessageQueue.indexOf(job);
  if (index === -1) return;
  textResourceMessageQueue.splice(index, 1);
  clearTimeout(job.timer);
  job.resolve(makeQueuedTextResourceStatus(job.attachments, 'expired'));
}

function drainTextResourceMessageQueue() {
  while (textResourceMessageActive < TEXT_RESOURCE_MESSAGE_CONCURRENCY && textResourceMessageQueue.length) {
    (function(job) {
      clearTimeout(job.timer);
      if (job.expiresAt <= Date.now()) {
        job.resolve(makeQueuedTextResourceStatus(job.attachments, 'expired'));
        return;
      }
      textResourceMessageActive++;
      Promise.resolve().then(function() {
        return fetchTextAttachmentResourcesWithStatus(job.attachments, job.deadline, job.options);
      }).then(function(status) {
        textResourceMessageActive = Math.max(0, textResourceMessageActive - 1);
        job.resolve(status);
        drainTextResourceMessageQueue();
      }, function(error) {
        textResourceMessageActive = Math.max(0, textResourceMessageActive - 1);
        job.reject(error);
        drainTextResourceMessageQueue();
      });
    })(textResourceMessageQueue.shift());
  }
}

function enqueueTextResourceMessage(attachments, deadline, options) {
  return new Promise(function(resolve, reject) {
    options = options || {};
    var now = Date.now();
    // Evict expired jobs before admission; do not wait for a throttled timer.
    textResourceMessageQueue.slice().forEach(function(job) {
      if (job.expiresAt <= now) expireQueuedTextResourceJob(job);
    });
    var owner = options.owner === undefined ? 'extension' : String(options.owner);
    var ownPending = textResourceMessageQueue.filter(function(job) { return job.owner === owner; }).length;
    if (textResourceMessageQueue.length >= TEXT_RESOURCE_QUEUE_LIMIT || ownPending >= TEXT_RESOURCE_QUEUE_PER_OWNER) {
      resolve(makeQueuedTextResourceStatus(attachments, 'busy'));
      return;
    }
    var expiresAt = Math.min(Number.isFinite(deadline) ? deadline : Infinity, now + TEXT_RESOURCE_QUEUE_MAX_WAIT_MS);
    if (expiresAt <= now || !attachments.length) {
      resolve(makeQueuedTextResourceStatus(attachments, expiresAt <= now ? 'expired' : 'empty'));
      return;
    }
    var job = { attachments: attachments, deadline: deadline, options: options, owner: owner,
      expiresAt: expiresAt, resolve: resolve, reject: reject, timer: null };
    textResourceMessageQueue.push(job);
    job.timer = setTimeout(function() { expireQueuedTextResourceJob(job); }, expiresAt - now);
    drainTextResourceMessageQueue();
  });
}

function getRemainingDeadlineMs(deadline) {
  if (!deadline) return Infinity;
  var remaining = Number(deadline) - Date.now();
  return isFinite(remaining) ? remaining : Infinity;
}

function getDeadlineFetchTimeout(deadline, fallbackMs) {
  var remaining = getRemainingDeadlineMs(deadline);
  if (remaining !== Infinity && remaining <= 0) return 0;
  return Math.max(0, Math.min(fallbackMs, remaining === Infinity ? fallbackMs : remaining));
}

function getArticleFetchAbortAt(deadline, articleSettings) {
  return Date.now() + getDeadlineFetchTimeout(deadline, ATPLoadPolicy.getArticleTimeout(articleSettings || {}));
}

function scheduleArticleFetchAbort(control) {
  if (!control) return 0;
  if (control.timer) {
    clearTimeout(control.timer);
    control.timer = 0;
  }
  var remaining = Math.max(0, control.abortAt - Date.now());
  if (remaining <= 0) {
    control.controller.abort();
    return 0;
  }
  control.timer = setTimeout(function() { control.controller.abort(); }, remaining);
  return remaining;
}

function createArticleFetchControl(deadline, articleSettings) {
  var control = {
    abortAt: getArticleFetchAbortAt(deadline, articleSettings),
    controller: new AbortController(),
    timer: 0
  };
  scheduleArticleFetchAbort(control);
  return control;
}

function extendArticleFetchControl(control, deadline, articleSettings) {
  if (!control) return;
  var abortAt = getArticleFetchAbortAt(deadline, articleSettings);
  if (abortAt > control.abortAt && !control.controller.signal.aborted) {
    control.abortAt = abortAt;
    scheduleArticleFetchAbort(control);
  }
}

function clearArticleFetchControl(control) {
  if (control && control.timer) {
    clearTimeout(control.timer);
    control.timer = 0;
  }
}

// storage.local is 10 MB from Chrome 114 but 5 MB on 111-113.
const BG_QUOTA_BYTES = (chrome.storage && chrome.storage.local && chrome.storage.local.QUOTA_BYTES) || 10485760;
const BG_HIGH_WATERMARK = Math.floor(BG_QUOTA_BYTES * 0.85);
const BG_TARGET_WATERMARK = Math.floor(BG_QUOTA_BYTES * 0.75);
var bgEvictionCheckTimer = null;
var bgCacheIndexRepairInFlight = false;

function consumeStorageError(action) {
  if (!chrome.runtime.lastError) return false;
  BGLOG.warn(action, chrome.runtime.lastError.message);
  return true;
}

function isValidSiteConfigHost(host) {
  return typeof host === 'string' &&
    host.length > 0 &&
    host.length <= 253 &&
    /^[a-z0-9.-]+$/i.test(host) &&
    host.indexOf('..') === -1 &&
    host.charAt(0) !== '.' &&
    host.charAt(host.length - 1) !== '.';
}

function normalizeBooleanSetting(value, fallback) {
  if (value === false || value === 'false' || value === 0) return false;
  if (value === true || value === 'true' || value === 1) return true;
  return fallback;
}

function isAllowedSettingsPatchKey(key) {
  if (key === 'enabled' || key === 'siteConfigs') return true;
  var schema = typeof SETTINGS_SCHEMA !== 'undefined' ? SETTINGS_SCHEMA : [];
  for (var i = 0; i < schema.length; i++) {
    if (schema[i] && schema[i].key === key) return true;
  }
  return false;
}

function cloneSettingsPatch(patch) {
  var source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  var out = {};
  for (var key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (!isAllowedSettingsPatchKey(key)) continue;
    if (key === 'siteConfigs') {
      var rawSiteConfigs = source.siteConfigs;
      var siteConfigs = {};
      if (rawSiteConfigs && typeof rawSiteConfigs === 'object' && !Array.isArray(rawSiteConfigs)) {
        for (var host in rawSiteConfigs) {
          if (!Object.prototype.hasOwnProperty.call(rawSiteConfigs, host) || !isValidSiteConfigHost(host)) continue;
          var siteConfig = rawSiteConfigs[host];
          if (!siteConfig || typeof siteConfig !== 'object' || Array.isArray(siteConfig)) continue;
          if (!Object.prototype.hasOwnProperty.call(siteConfig, 'disabled')) continue;
          siteConfigs[host] = { disabled: normalizeBooleanSetting(siteConfig.disabled, false) };
        }
      }
      out.siteConfigs = siteConfigs;
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

function applySettingsPatch(patch) {
  var stablePatch = cloneSettingsPatch(patch);
  return new Promise(function(resolve, reject) {
    chrome.storage.local.get('settings', function(result) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      var current = result.settings && typeof result.settings === 'object' && !Array.isArray(result.settings)
        ? result.settings
        : {};
      current = ATPNormalizeSettings(current);
      var merged = Object.assign({}, current, stablePatch);
      if (Object.prototype.hasOwnProperty.call(stablePatch, 'siteConfigs')) {
        var mergedSiteConfigs = {};
        var currentSiteConfigs = current.siteConfigs;
        if (currentSiteConfigs && typeof currentSiteConfigs === 'object' && !Array.isArray(currentSiteConfigs)) {
          for (var currentHost in currentSiteConfigs) {
            if (!Object.prototype.hasOwnProperty.call(currentSiteConfigs, currentHost)) continue;
            var currentConfig = currentSiteConfigs[currentHost];
            mergedSiteConfigs[currentHost] = currentConfig && typeof currentConfig === 'object' && !Array.isArray(currentConfig)
              ? Object.assign({}, currentConfig)
              : currentConfig;
          }
        }
        var patchSiteConfigs = stablePatch.siteConfigs;
        for (var patchHost in patchSiteConfigs) {
          if (!Object.prototype.hasOwnProperty.call(patchSiteConfigs, patchHost)) continue;
          var patchConfig = patchSiteConfigs[patchHost];
          if (patchConfig && typeof patchConfig === 'object' && !Array.isArray(patchConfig)) {
            var baseConfig = mergedSiteConfigs[patchHost];
            mergedSiteConfigs[patchHost] = Object.assign(
              {},
              baseConfig && typeof baseConfig === 'object' && !Array.isArray(baseConfig) ? baseConfig : {},
              patchConfig
            );
          } else {
            mergedSiteConfigs[patchHost] = patchConfig;
          }
        }
        merged.siteConfigs = mergedSiteConfigs;
      }
      var next = ATPNormalizeSettings(merged);
      chrome.storage.local.set({ settings: next }, function() {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(next);
      });
    });
  });
}

function queueSettingsPatch(patch) {
  SETTINGS_WRITE_CHAIN = SETTINGS_WRITE_CHAIN.catch(function() {}).then(function() {
    return applySettingsPatch(patch);
  });
  return SETTINGS_WRITE_CHAIN;
}

function removeCacheIndexEntriesAfterStorageRemove(keys, action, callback) {
  SharedUtils.cacheIndex.removeEntries(keys, function(success) {
    if (success === false) {
      BGLOG.warn(action, '索引删除失败，尝试重建');
      SharedUtils.cacheIndex.rebuild(function(entries) {
        if (!entries) BGLOG.warn(action, '索引重建失败');
        if (callback) callback(!!entries, true);
      });
      return;
    }
    if (callback) callback(true, false);
  });
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

function getCachedTextResources(url) {
  var readStartedAt = Date.now();
  return new Promise(function(resolve) {
    var keys = getTextCacheKeys(TEXT_RESOURCE_CACHE_PREFIX, url);
    if (!keys.length) { resolve(null); return; }
    var primaryKey = keys[0];
    var readKeys = keys.slice();
    readKeys.push('settings');
    chrome.storage.local.get(readKeys, function(result) {
      if (consumeStorageError('TXT缓存读取失败')) {
        resolve(null);
        return;
      }
      var settings = result.settings || {};
      var ttlMs = ((settings && settings.cacheTTL) || 30) * 60 * 1000;
      var entry = getValidTextResourceEntry(result, keys, ttlMs, Date.now());
      if (entry && entry.key) {
        if (entry.key !== primaryKey) {
          var d = {};
          d[primaryKey] = entry.value;
          stampCacheWrite(d, readStartedAt);
          setStorageWithEviction(d, 'TXT缓存迁移写入失败', function() {
            cleanupLegacyTextCacheKeys(keys, primaryKey, '旧TXT资源缓存');
          });
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
}

function estimateWriteBatchBytes(d) {
  return SharedUtils.utf8ByteLength(JSON.stringify(d));
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

// 代数值仅在用户手动清缓存时变化：写前用内存缓存值快速判断，写后仍做权威读取兜底
var cachedCacheGeneration = null;

function checkCacheWriteFreshFast(writeStartedAt, callback) {
  if (cachedCacheGeneration !== null) {
    callback(!isCacheWriteStale(writeStartedAt, cachedCacheGeneration));
    return;
  }
  checkCacheWriteFresh(writeStartedAt, callback);
}

function checkCacheWriteFresh(writeStartedAt, callback) {
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
  if (bgCacheIndexRepairInFlight) return;
  bgCacheIndexRepairInFlight = true;
  try {
    SharedUtils.cacheIndex.rebuild(function(entries) {
      bgCacheIndexRepairInFlight = false;
      if (!entries) BGLOG.warn('缓存索引自愈失败', 'cacheIndex rebuild failed');
    });
  } catch (e) {
    bgCacheIndexRepairInFlight = false;
    BGLOG.warn('缓存索引自愈异常', e && e.message ? e.message : String(e));
  }
}

function updateIndexForWrite(d) {
  var _P = SharedUtils.CACHE_PREFIXES;
  var updates = {};
  var hasUpdates = false;
  for (var dk in d) {
    if (!Object.prototype.hasOwnProperty.call(d, dk)) continue;
    var type;
    if (dk.indexOf(_P.IMAGE) === 0) type = 0;
    else if (SharedUtils.isHashedTextAttachmentCacheKey(dk, _P.TEXT_RESOURCE)) type = 1;
    else if (SharedUtils.isHashedTextAttachmentCacheKey(dk, _P.TEXT_FAIL)) type = 4;
    else if (dk.indexOf(_P.ARTICLE) === 0) type = 2;
    else if (dk.indexOf(_P.NEGATIVE) === 0) type = 3;
    else continue;
    var val = d[dk];
    var ts = (typeof val === 'object' && val !== null) ? (val.ts || Date.now()) : Date.now();
    var valLen = SharedUtils.utf8ByteLength(
      (typeof val === 'object' && val !== null) ? JSON.stringify(val) : String(val)
    );
    updates[dk] = { t: type, ts: ts, b: dk.length + valLen };
    hasUpdates = true;
  }
  if (hasUpdates) {
    SharedUtils.cacheIndex.updateEntries(updates, function(success) {
      if (success === false) repairCacheIndexAfterWriteFailure();
    });
  }
}

function setStorageWithEviction(d, warnMsg, onSuccess, writeStartedAt) {
  if (writeStartedAt === undefined && d && d.__atpWriteStartedAt) {
    writeStartedAt = d.__atpWriteStartedAt;
  }
  writeStartedAt = getCacheWriteStartedAt(writeStartedAt);
  function finishSuccessfulSet() {
    checkCacheWriteFresh(writeStartedAt, function(fresh) {
      if (!fresh) {
        removeStaleCacheWrite(d);
        return;
      }
      updateIndexForWrite(d);
      scheduleBgEvictionCheck();
      if (onSuccess) onSuccess();
    });
  }
  function attemptSet() {
    checkCacheWriteFreshFast(writeStartedAt, function(fresh) {
      if (!fresh) return;
  chrome.storage.local.set(d, function() {
    if (chrome.runtime.lastError) {
      console.warn('[BGLOG] ' + warnMsg + '，尝试淘汰后重试:', chrome.runtime.lastError.message);
      chrome.storage.local.getBytesInUse(null, function(bytesUsed) {
        if (consumeStorageError('storage用量读取失败')) return;
        var baseline = bytesUsed + estimateWriteBatchBytes(d);
        checkAndEvict(function() {
          checkCacheWriteFreshFast(writeStartedAt, function(retryFresh) {
            if (!retryFresh) return;
          chrome.storage.local.set(d, function() {
            if (chrome.runtime.lastError) {
              console.warn('[BGLOG] 淘汰后重试仍失败:', chrome.runtime.lastError.message);
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
  attemptSet();
}

function scheduleBgEvictionCheck() {
  if (bgEvictionCheckTimer) return;
  bgEvictionCheckTimer = setTimeout(function() {
    bgEvictionCheckTimer = null;
    checkAndEvict();
  }, 500);
}

// Discuz attachment URLs carry a per-render aid token, so an entry keyed by one
// is never read again; the article cache keeps those threads' TXT results.
function setCachedTextResources(url, resources, writeStartedAt) {
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
  setStorageWithEviction(d, 'TXT缓存写入失败', function() {
    cleanupLegacyTextCacheKeys(keys, primaryKey, '旧TXT资源缓存');
  });
}

function getTextFailCache(url) {
  var readStartedAt = Date.now();
  return new Promise(function(resolve) {
    var keys = getTextCacheKeys(TEXT_FAIL_CACHE_PREFIX, url);
    if (!keys.length) { resolve(false); return; }
    var primaryKey = keys[0];
    chrome.storage.local.get(keys, function(result) {
      if (consumeStorageError('TXT失败缓存读取失败')) {
        resolve(false);
        return;
      }
      var entry = getValidTextFailEntry(result, keys, TEXT_FAIL_TTL_MS, Date.now());
      if (entry && entry.key) {
        if (entry.key !== primaryKey) {
          var d = {};
          d[primaryKey] = entry.value;
          stampCacheWrite(d, readStartedAt);
          setStorageWithEviction(d, 'TXT失败缓存迁移写入失败', function() {
            cleanupLegacyTextCacheKeys(keys, primaryKey, '旧TXT失败缓存');
          });
        } else {
          cleanupStoredLegacyTextCacheKeys(result, keys, primaryKey, '旧TXT失败缓存');
        }
        resolve(true);
        return;
      }
      if (entry.invalidKeys.length) cleanupInvalidTextCacheKeys(entry.invalidKeys, '无效TXT失败缓存');
      resolve(false);
    });
  });
}

function setTextFailCache(url, writeStartedAt) {
  if (SharedUtils.isDiscuzAttachmentUrl(url, url)) return;
  var keys = getTextCacheKeys(TEXT_FAIL_CACHE_PREFIX, url);
  if (!keys.length) return;
  var primaryKey = keys[0];
  var d = {};
  d[primaryKey] = Date.now();
  stampCacheWrite(d, writeStartedAt);
  setStorageWithEviction(d, 'TXT失败缓存写入失败', function() {
    cleanupLegacyTextCacheKeys(keys, primaryKey, '旧TXT失败缓存');
  });
}

function clearTextFailCache(url) {
  var keys = getTextCacheKeys(TEXT_FAIL_CACHE_PREFIX, url);
  if (!keys.length) return;
  chrome.storage.local.remove(keys, function() {
    if (consumeStorageError('TXT失败缓存清除失败')) return;
    removeCacheIndexEntriesAfterStorageRemove(keys, 'TXT失败缓存索引清理');
  });
}

function checkAndEvict(callback, baselineBytes) {
  if (typeof baselineBytes === 'number' && baselineBytes > 0) {
    runBackgroundEviction(callback, baselineBytes);
    return;
  }
  chrome.storage.local.getBytesInUse(null, function(bytesUsed) {
    if (consumeStorageError('storage用量读取失败')) {
      if (callback) callback();
      return;
    }
    runBackgroundEviction(callback, bytesUsed);
  });
}

function runBackgroundEviction(callback, triggerBytes) {
  if (triggerBytes < BG_HIGH_WATERMARK) {
    if (callback) callback();
    return;
  }
  SharedUtils.cacheIndex.rebuild(function(entries) {
    if (!entries) {
      BGLOG.warn('LRU淘汰跳过', '缓存索引重建失败');
      if (callback) callback();
      return;
    }
    _bgEvictFromEntries(entries, callback, triggerBytes);
  });
}

function _bgEvictFromEntries(entries, callback, baseline) {
  var cacheEntries = [];
  for (var key in entries) {
    var e = entries[key];
    cacheEntries.push({ key: key, ts: e.ts, priority: e.t, estimatedBytes: e.b });
  }
  if (baseline <= BG_TARGET_WATERMARK) {
    if (callback) callback();
    return;
  }
  var expiredBefore = Date.now() - bgCacheTtlMs;
  cacheEntries.sort(function(a, b) {
    return compareEvictionOrder(a, b, expiredBefore);
  });
  var removeKeys = [];
  var freed = 0;
  for (var i = 0; i < cacheEntries.length; i++) {
    if (baseline - freed <= BG_TARGET_WATERMARK) break;
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
          BGLOG.info('LRU淘汰', removeKeys.length + '条缓存');
        } else {
          BGLOG.warn('LRU淘汰索引清理失败', removeKeys.length + '条缓存已删除，索引未确认');
        }
        if (callback) callback();
      });
    });
  } else {
    if (callback) callback();
  }
}

async function fetchTextAttachmentResource(attachment, depth, deadline, options) {
  options = options || {};
  var writeStartedAt = Date.now();
  var manualRetry = !!(options.manualRetry || options.force);
  depth = depth || 0;
  try {
    if (!textAttachmentAllowedInZone(attachment.url, options.zone)) return SharedUtils.emptyResources();

    var cached = await getCachedTextResources(attachment.url);
    if (cached) {
      clearTextFailCache(attachment.url);
      BGLOG.debug('TXT附件缓存命中', (attachment.name || shortUrl(attachment.url)) + ' 资源' + SharedUtils.countResources(cached));
      return cached;
    }

    if (!manualRetry) {
      var failCached = await getTextFailCache(attachment.url);
      if (failCached) {
        BGLOG.debug('TXT附件失败缓存命中，跳过', shortUrl(attachment.url));
        return SharedUtils.emptyResources();
      }
    }

    var fetchTimeout = getDeadlineFetchTimeout(deadline, TEXT_ATTACHMENT_TIMEOUT);
    if (fetchTimeout <= 0) {
      BGLOG.debug('TXT附件deadline耗尽', attachment && attachment.url ? shortUrl(attachment.url) : '');
      return SharedUtils.emptyResources();
    }

    var ctrl = new AbortController();
    var t = setTimeout(function() { ctrl.abort(); }, fetchTimeout);
    try {
      var fetchOptions = {
        signal: ctrl.signal,
        credentials: 'include',
        headers: { 'Accept': 'text/plain, application/octet-stream;q=0.9, */*;q=0.5' }
      };
      var safeReferrer = getSafeAttachmentReferrer(attachment);
      if (safeReferrer) {
        fetchOptions.referrer = safeReferrer;
        fetchOptions.referrerPolicy = 'strict-origin-when-cross-origin';
      }
      var resp = await fetch(attachment.url, fetchOptions);
      var finalAttachmentUrl = resp.url || attachment.url;
      if (!textAttachmentAllowedInZone(finalAttachmentUrl, options.zone)) {
        BGLOG.debug('TXT附件重定向已拒绝', shortUrl(finalAttachmentUrl));
        return SharedUtils.emptyResources();
      }

      if (!resp.ok) {
        var status = resp.status;
        if (status === 401 || status === 403) {
          BGLOG.debug('TXT附件站点拒绝', 'HTTP' + status + ' ' + shortUrl(attachment.url));
          setTextFailCache(attachment.url, writeStartedAt);
          return SharedUtils.emptyResources();
        }
        if (status === 429) {
          BGLOG.debug('TXT附件限流', shortUrl(attachment.url));
          return SharedUtils.emptyResources();
        }
        BGLOG.debug('TXT附件跳过', 'HTTP' + status + ' ' + shortUrl(attachment.url));
        return SharedUtils.emptyResources();
      }
      if (resp.redirected && /\/login|\/signin|\/member|\/register/.test(resp.url)) {
        BGLOG.debug('TXT附件登录页', shortUrl(resp.url));
        return SharedUtils.emptyResources();
      }

      var len = parseInt(resp.headers.get('content-length') || '0', 10);
      if (len > TEXT_ATTACHMENT_MAX_BYTES) {
        BGLOG.debug('TXT附件过大', attachment.name + ' ' + len + '字节');
        return SharedUtils.emptyResources();
      }

      var contentType = resp.headers.get('content-type') || '';
      var buffer;
      try {
        buffer = await SharedUtils.readResponseArrayBufferLimited(resp, TEXT_ATTACHMENT_MAX_BYTES);
      } catch (readError) {
        if (readError && readError.name === 'ResponseTooLargeError') {
          BGLOG.debug('TXT附件过大', attachment.name + ' 超过' + TEXT_ATTACHMENT_MAX_BYTES + '字节');
          return SharedUtils.emptyResources();
        }
        throw readError;
      }

      var text = SharedUtils.decodeTextBuffer(buffer, contentType);
      var htmlLike = SharedUtils.looksLikeHtmlDocument(text);
      var downloadLike = SharedUtils.looksLikeDownloadIntermediary(text);
      if ((htmlLike || downloadLike) && depth < 2) {
        var downloadUrls = SharedUtils.extractTextDownloadUrls(text, resp.url || attachment.url, TEXT_ATTACHMENT_MAX_COUNT);
        for (var d = 0; d < downloadUrls.length; d++) {
          if (!textAttachmentAllowedInZone(downloadUrls[d], options.zone) || downloadUrls[d] === attachment.url) continue;
          var redirectedResources = await fetchTextAttachmentResource({
            url: downloadUrls[d],
            name: attachment.name,
            source: 'txt-download-url',
            pageUrl: attachment.pageUrl || resp.url || attachment.url
          }, depth + 1, deadline, options);
          if (SharedUtils.hasResourcePayload(redirectedResources)) {
            setCachedTextResources(attachment.url, redirectedResources, writeStartedAt);
            clearTextFailCache(attachment.url);
            return redirectedResources;
          }
        }
      }

      if (!text || SharedUtils.isUnavailableTextDocument(text) || htmlLike) {
        BGLOG.debug('TXT附件不可解析', attachment.name || shortUrl(attachment.url));
        return SharedUtils.emptyResources();
      }

      var resources = SharedUtils.extractResources(text, resp.url || attachment.url, 'txt');
      var normalizedResources = SharedUtils.normalizeResources(resources);
      if (SharedUtils.hasResourcePayload(normalizedResources)) {
        setCachedTextResources(attachment.url, normalizedResources, writeStartedAt);
        clearTextFailCache(attachment.url);
      }
      BGLOG.debug('TXT附件资源', (attachment.name || shortUrl(attachment.url)) + ' 资源' + SharedUtils.countResources(normalizedResources));
      return normalizedResources;
    } finally {
      clearTimeout(t);
      // Early exits leave the body unread; abort so it stops downloading.
      if (resp && !resp.bodyUsed) ctrl.abort();
    }
  } catch (e) {
    var isTransient = e.name === 'AbortError' || e.name === 'TypeError';
    if (isTransient) {
      BGLOG.debug('TXT附件临时异常，不写失败缓存', (attachment && attachment.url ? shortUrl(attachment.url) : '') + ' ' + e.message);
    } else {
      BGLOG.debug('TXT附件异常，不写失败缓存', (attachment && attachment.url ? shortUrl(attachment.url) : '') + ' ' + e.message);
    }
    return SharedUtils.emptyResources();
  }
}

async function fetchTextAttachmentResources(attachments, deadline, options) {
  var status = await fetchTextAttachmentResourcesWithStatus(attachments, deadline, options);
  return status.resources;
}

async function fetchTextAttachmentResourcesWithStatus(attachments, deadline, options) {
  options = options || {};
  var sourceAttachments = attachments || [];
  attachments = [];
  var seenAttachments = {};
  for (var ai = 0; ai < sourceAttachments.length && attachments.length < TEXT_ATTACHMENT_MAX_COUNT; ai++) {
    var attachment = sourceAttachments[ai];
    if (!attachment || !attachment.url) continue;
    var attachmentKey = SharedUtils.normalizeTextAttachmentUrl(attachment.url);
    if (!attachmentKey || seenAttachments[attachmentKey]) continue;
    seenAttachments[attachmentKey] = true;
    attachments.push(attachment);
  }
  if (!attachments.length) return makeTextResourceFetchStatus(SharedUtils.emptyResources(), 0, 0, 0);
  var results = [];
  for (var pi = 0; pi < attachments.length; pi++) {
    results.push(await fetchTextAttachmentResource(attachments[pi], 0, deadline, options));
  }
  var merged = SharedUtils.emptyResources();
  var unresolvedCount = 0;
  for (var i = 0; i < results.length; i++) {
    if (SharedUtils.hasResourcePayload(results[i])) {
      merged = SharedUtils.mergeResources(merged, results[i]);
    } else {
      unresolvedCount++;
    }
  }
  return makeTextResourceFetchStatus(merged, attachments.length, unresolvedCount, unresolvedCount);
}

function normalizeImageExtractionSettings(input) {
  input = input || {};
  var fetchLimit = input.maxImagesPerPost || input.maxImages || 100;
  var displayLimit = input.maxDisplayPerPost || input.displayImages || fetchLimit;
  return {
    maxImagesPerPost: fetchLimit,
    maxDisplayPerPost: displayLimit,
    heavyImageOptimization: input.heavyImageOptimization !== false,
    articleTimeout: ATPLoadPolicy.getArticleTimeout(input),
    articleFetchConcurrency: ATPLoadPolicy.getArticleFetchConcurrency(input)
  };
}

function getArticleFetchKey(url, imageSettings) {
  imageSettings = normalizeImageExtractionSettings(imageSettings);
  var normalizedUrl = SharedUtils.normalizeArticleUrl ? SharedUtils.normalizeArticleUrl(url) : url;
  return [
    normalizedUrl || url,
    imageSettings.maxImagesPerPost,
    imageSettings.maxDisplayPerPost,
    imageSettings.heavyImageOptimization ? 1 : 0
  ].join('|');
}

function makeDeadlineArticleResult(reason) {
  return { ok: false, reason: reason || 'deadline_exhausted', images: [], retryableEmpty: true };
}

function normalizeBackgroundTextAttachments(item) {
  item = item || {};
  var rawAttachments = Array.isArray(item.textAttachments) ? item.textAttachments : [];
  var filteredAttachments = [];
  var hasTransientAttachment = false;
  for (var i = 0; i < rawAttachments.length; i++) {
    var attachment = rawAttachments[i];
    if (!attachment || !attachment.url) continue;
    if (SharedUtils.isTransientTextAttachmentUrl(attachment.url, attachment.pageUrl || item.pageUrl || item.url || '')) {
      hasTransientAttachment = true;
    } else {
      filteredAttachments.push(attachment);
    }
  }
  var markerCount = Math.max(0, Number(item.textAttachmentCount || 0) || 0);
  if (rawAttachments.length > markerCount) markerCount = rawAttachments.length;
  var hasTextAttachments = !!item.hasTextAttachments || hasTransientAttachment || filteredAttachments.length > 0;
  return {
    textAttachments: filteredAttachments,
    hasTextAttachments: hasTextAttachments,
    textAttachmentCount: hasTextAttachments ? (markerCount || 1) : 0
  };
}

function makeBackgroundArticleResponse(item) {
  item = item || {};
  var images = item.images || [];
  var resources = SharedUtils.normalizeResources(item.resources);
  var textState = normalizeBackgroundTextAttachments(item);
  return {
    images: images,
    resources: resources,
    textAttachments: textState.textAttachments,
    hasTextAttachments: textState.hasTextAttachments,
    textAttachmentCount: textState.textAttachmentCount,
    textResourcesComplete: item.textResourcesComplete === true,
    textResourcesAttemptedCount: Math.max(0, Number(item.textResourcesAttemptedCount || 0) || 0),
    textResourcesUnresolvedCount: Math.max(0, Number(item.textResourcesUnresolvedCount || 0) || 0),
    textResourcesRetryableCount: Math.max(0, Number(item.textResourcesRetryableCount || 0) || 0),
    partial: !!item.partial,
    retryableEmpty: !!item.retryableEmpty,
    emptyReason: item.emptyReason || item.reason || '',
    reason: item.reason || '',
    retryAfter: Math.max(0, Number(item.retryAfter || 0) || 0)
  };
}

function makeOriginDisallowedArticleResponse() {
  return makeBackgroundArticleResponse({
    ok: false,
    reason: 'origin_disallowed',
    images: [],
    retryableEmpty: false
  });
}

function waitForArticleDeadline(promise, deadline) {
  var remaining = getRemainingDeadlineMs(deadline);
  if (remaining === Infinity) return promise;
  if (remaining <= 0) return Promise.resolve(makeDeadlineArticleResult());
  return new Promise(function(resolve) {
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      resolve(makeDeadlineArticleResult());
    }, remaining);
    promise.then(function(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }).catch(function(e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: e && e.message ? e.message : String(e), images: [], retryableEmpty: true });
    });
  });
}

function fetchArticleWithInflight(url, imageSettings, deadline) {
  var key = getArticleFetchKey(url, imageSettings);
  var existing = ARTICLE_FETCH_IN_FLIGHT[key];
  if (existing) {
    if (existing.control && existing.control.controller && existing.control.controller.signal.aborted) {
      clearArticleFetchControl(existing.control);
      delete ARTICLE_FETCH_IN_FLIGHT[key];
    } else {
      extendArticleFetchControl(existing.control, deadline, imageSettings);
      return waitForArticleDeadline(existing.promise, deadline);
    }
  }
  var control = createArticleFetchControl(deadline, imageSettings);
  if (control.controller.signal.aborted) return Promise.resolve(makeDeadlineArticleResult());
  var promise = fetchArticle(url, imageSettings, deadline, control);
  ARTICLE_FETCH_IN_FLIGHT[key] = { promise: promise, control: control };
  promise.then(function() {
    clearArticleFetchControl(control);
    if (ARTICLE_FETCH_IN_FLIGHT[key] && ARTICLE_FETCH_IN_FLIGHT[key].promise === promise) delete ARTICLE_FETCH_IN_FLIGHT[key];
  }).catch(function() {
    clearArticleFetchControl(control);
    if (ARTICLE_FETCH_IN_FLIGHT[key] && ARTICLE_FETCH_IN_FLIGHT[key].promise === promise) delete ARTICLE_FETCH_IN_FLIGHT[key];
  });
  return waitForArticleDeadline(promise, deadline);
}

async function fetchArticle(url, imageSettings, deadline, control) {
  imageSettings = normalizeImageExtractionSettings(imageSettings);
  try {
    var ownsControl = !control;
    control = control || createArticleFetchControl(deadline, imageSettings);
    if (control.controller.signal.aborted) return makeDeadlineArticleResult();
    try {
      var resp = await fetch(url, { signal: control.controller.signal, credentials: 'include', headers: { 'Accept': 'text/html' } });
      var finalUrl = resp.url || url;
      if (!originAllowed(finalUrl) || !SharedUtils.isSameForumZoneUrl(finalUrl, url)) {
        BGLOG.warn('文章重定向已拒绝', shortUrl(finalUrl));
        return { ok: false, reason: 'redirect_disallowed', images: [], retryableEmpty: false };
      }
      if (SharedUtils.isCloudflareChallengeResponse(resp)) {
        BGLOG.warn('文章返回 Cloudflare 验证', 'HTTP' + resp.status + ' ' + shortUrl(url));
        return { ok: false, reason: 'cloudflare', images: [], retryableEmpty: true, retryAfter: SharedUtils.parseRetryAfterHeader(resp.headers) };
      }
      if (!resp.ok) {
        var retryableHttp = resp.status === 401 || resp.status === 403 || resp.status === 429 || (resp.status >= 500 && resp.status <= 599);
        var retryAfter = retryableHttp ? SharedUtils.parseRetryAfterHeader(resp.headers) : 0;
        return { ok: false, reason: 'http_' + resp.status, images: [], retryableEmpty: retryableHttp, retryAfter: retryAfter };
      }
      var ct = resp.headers.get('content-type') || '';
      if (ct.indexOf('text/html') === -1) return { ok: false, reason: 'non_html', images: [], retryableEmpty: false };
      if (resp.redirected && /\/login|\/signin|\/member|\/register/.test(resp.url)) {
        return { ok: false, reason: 'login_redirect', images: [], retryableEmpty: true };
      }
      if (SharedUtils.isOversizedArticleResponse(resp)) {
        BGLOG.warn('HTML过大', shortUrl(url));
        return { ok: false, reason: 'html_too_large', images: [], retryableEmpty: false };
      }
      var rawHtml;
      try {
        rawHtml = await SharedUtils.readResponseTextLimited(resp, SharedUtils.ARTICLE_HTML_MAX_BYTES);
      } catch (readError) {
        if (readError && readError.name === 'ResponseTooLargeError') {
          BGLOG.warn('HTML过大', shortUrl(url));
          return { ok: false, reason: 'html_too_large', images: [], retryableEmpty: false };
        }
        throw readError;
      }
      var html = SharedUtils.limitArticleHtml(rawHtml);
      var htmlTruncated = html.length !== rawHtml.length;
      if (htmlTruncated) {
        BGLOG.warn('HTML截断', rawHtml.length + ' -> ' + html.length);
      }
      var blocked = SharedUtils.isBlockedPage(html);
      if (blocked) return { ok: false, reason: blocked, images: [], retryableEmpty: true };
      var images = SharedUtils.extractImagesForSettings(html, finalUrl, imageSettings);
      // 整文派生串只算一次，供资源与 TXT 附件两个提取器共用
      var extractionContext = SharedUtils.prepareArticleExtractionContext(html);
      var resources = SharedUtils.extractResources(html, finalUrl, 'html', extractionContext);
      var textAttachments = SharedUtils.extractTextAttachments(html, finalUrl, TEXT_ATTACHMENT_MAX_COUNT, extractionContext);
      if (!images.length && !SharedUtils.hasResourcePayload(resources) && !textAttachments.length) {
        var emptyPage = SharedUtils.classifyEmptyArticlePage(html);
        if (emptyPage && emptyPage.retryable) {
          BGLOG.warn('正文返回非帖子页', emptyPage.reason + ' title="' + SharedUtils.getHtmlPageTitle(html) + '" ' + html.length + '字符 ' + shortUrl(url));
          return { ok: false, reason: emptyPage.reason, images: [], retryableEmpty: true };
        }
      }
      return { ok: true, images: images, resources: resources, textAttachments: textAttachments, partial: htmlTruncated };
    } finally {
      if (ownsControl) clearArticleFetchControl(control);
      // Early exits leave the body unread; abort so it stops downloading.
      if (resp && !resp.bodyUsed) control.controller.abort();
    }
  } catch (e) {
    var retryableError = e.name === 'AbortError' || e.name === 'TypeError';
    var reason = e.name === 'AbortError' && deadline ? 'deadline_exhausted' : e.message;
    // 超时/中止属正常控制流（本就返回 retryableEmpty），不应以 ERROR 级触发全量日志落盘
    if (e.name === 'AbortError') {
      BGLOG.debug('抓取中止', shortUrl(url) + ' ' + reason);
    } else {
      BGLOG.error('异常', shortUrl(url) + ' ' + e.message);
    }
    return { ok: false, reason: reason, images: [], retryableEmpty: retryableError };
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCacheIndexKey(key) {
  if (typeof key !== 'string') return false;
  var _P = SharedUtils.CACHE_PREFIXES;
  return key.indexOf(_P.IMAGE) === 0 ||
    SharedUtils.isHashedTextAttachmentCacheKey(key, _P.TEXT_RESOURCE) ||
    SharedUtils.isHashedTextAttachmentCacheKey(key, _P.TEXT_FAIL) ||
    key.indexOf(_P.ARTICLE) === 0 ||
    key.indexOf(_P.NEGATIVE) === 0;
}

function isCacheIndexRemoveKey(key) {
  if (isCacheIndexKey(key)) return true;
  if (typeof key !== 'string') return false;
  var _P = SharedUtils.CACHE_PREFIXES;
  return key.indexOf(_P.IMAGE_BASE) === 0 ||
    SharedUtils.isUnsafeTextAttachmentCacheKey(key, _P.TEXT_RESOURCE) ||
    SharedUtils.isUnsafeTextAttachmentCacheKey(key, _P.TEXT_FAIL) ||
    key.indexOf(_P.TEXT_RESOURCE_BASE) === 0 ||
    key.indexOf(_P.TEXT_FAIL_BASE) === 0 ||
    key.indexOf(_P.ARTICLE_BASE) === 0 ||
    key.indexOf(_P.NEGATIVE_BASE) === 0;
}

function isCacheIndexType(type) {
  var T = SharedUtils.cacheIndex.TYPE;
  return type === T.IMAGE ||
    type === T.TEXT_RESOURCE ||
    type === T.ARTICLE ||
    type === T.NEGATIVE ||
    type === T.TEXT_FAIL;
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && isFinite(value) && value >= 0;
}

function sanitizeCacheIndexUpdates(updates) {
  if (!isPlainObject(updates)) return null;
  var clean = {};
  var count = 0;
  for (var key in updates) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    var entry = updates[key];
    if (!isCacheIndexKey(key) || !isPlainObject(entry)) return null;
    if (!isCacheIndexType(entry.t) || !isFiniteNonNegativeNumber(entry.ts) || !isFiniteNonNegativeNumber(entry.b)) return null;
    clean[key] = { t: entry.t, ts: entry.ts, b: entry.b };
    count++;
  }
  return count ? clean : {};
}

function sanitizeCacheIndexRemoveKeys(keys) {
  if (!Array.isArray(keys)) return null;
  var clean = [];
  var seen = {};
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (!isCacheIndexRemoveKey(key)) return null;
    if (seen[key]) continue;
    seen[key] = true;
    clean.push(key);
  }
  return clean;
}

function handleCacheIndexMutationMessage(msg, sendResponse) {
  if (typeof SharedUtils === 'undefined' || !SharedUtils.cacheIndex) {
    sendResponse({ ok: false });
    return;
  }
  var action = msg && msg.action;
  if (action === 'updateEntries') {
    var updates = sanitizeCacheIndexUpdates(msg.updates);
    if (!updates) { sendResponse({ ok: false }); return; }
    SharedUtils.cacheIndex.updateEntries(updates, function(success) {
      sendResponse({ ok: success === true });
    });
    return;
  }
  if (action === 'removeEntries') {
    var keys = sanitizeCacheIndexRemoveKeys(msg.keys);
    if (!keys) { sendResponse({ ok: false }); return; }
    SharedUtils.cacheIndex.removeEntries(keys, function(success) {
      sendResponse({ ok: success === true });
    });
    return;
  }
  if (action === 'rebuild') {
    SharedUtils.cacheIndex.rebuild(function(entries) {
      sendResponse({ ok: !!entries, entries: entries || null });
    });
    return;
  }
  sendResponse({ ok: false });
}

// Host checks for these messages depend on the mirror grant list, which a
// freshly woken worker is still reading; hold them instead of denying.
var MIRROR_GATED_MESSAGE_TYPES = {};
MIRROR_GATED_MESSAGE_TYPES[SharedUtils.MESSAGE_TYPES.FETCH_IMAGES] = true;
MIRROR_GATED_MESSAGE_TYPES[SharedUtils.MESSAGE_TYPES.FETCH_TEXT_ATTACHMENTS_FRESH] = true;
MIRROR_GATED_MESSAGE_TYPES[SharedUtils.MESSAGE_TYPES.FETCH_TEXT_RESOURCES] = true;
MIRROR_GATED_MESSAGE_TYPES[SharedUtils.MESSAGE_TYPES.GET_FLOATING_PANEL_CSS] = true;

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object') return false;
  if (!mirrorSitesLoaded && MIRROR_GATED_MESSAGE_TYPES[msg.type] === true) {
    mirrorSitesReady.then(function() {
      handleRuntimeMessage(msg, sender, sendResponse);
    });
    return true;
  }
  return handleRuntimeMessage(msg, sender, sendResponse);
});

function handleRuntimeMessage(msg, sender, sendResponse) {
  if (msg.type === SharedUtils.MESSAGE_TYPES.MIRROR_SITES_SYNC) {
    if (!isExtensionPageSender(sender) || !canManageMirrorSites()) {
      sendResponse({ ok: false, error: 'mirror_sync_not_allowed' });
      return true;
    }
    refreshMirrorSites('popup', true).then(function(result) {
      sendResponse({ ok: true, sites: result.sites, registered: result.registered });
    }).catch(function(e) {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    });
    return true;
  }
  if (msg.type === SharedUtils.MESSAGE_TYPES.GET_FLOATING_PANEL_CSS) {
    if (!getSenderForumZone(sender)) {
      sendResponse({ ok: false });
      return true;
    }
    getFloatingPanelCss().then(function(css) {
      sendResponse({ ok: true, css: css });
    }).catch(function(e) {
      BGLOG.warn('浮窗样式读取失败', e && e.message ? e.message : String(e));
      sendResponse({ ok: false });
    });
    return true;
  }
  if (msg.type === SharedUtils.MESSAGE_TYPES.CACHE_INDEX_MUTATION) {
    handleCacheIndexMutationMessage(msg, sendResponse);
    return true;
  }
  if (msg.type === SharedUtils.MESSAGE_TYPES.SAVE_SETTINGS_PATCH) {
    queueSettingsPatch(msg.settingsPatch || {}).then(function(settings) {
      sendResponse({ ok: true, settings: settings });
    }).catch(function(e) {
      BGLOG.error('SAVE_SETTINGS_PATCH', e.message);
      sendResponse({ ok: false, error: e.message || String(e) });
    });
    return true;
  }
  if (msg.type === SharedUtils.MESSAGE_TYPES.FETCH_IMAGES) {
    if (!originAllowed((sender && sender.url) || '')) { sendResponse({}); return true; }
    var imageSenderZone = getSenderForumZone(sender);
    var sourceUrls = Array.isArray(msg.urls) ? msg.urls : [];
    var maxSourceUrls = Math.max(0, Number(SharedUtils.BG_FETCH_MAX_URLS) || 60);
    var urls = [];
    var deniedImageResponses = {};
    for (var ui = 0; ui < sourceUrls.length && ui < maxSourceUrls; ui++) {
      if (forumUrlAllowedInZone(sourceUrls[ui], imageSenderZone)) urls.push(sourceUrls[ui]);
      else if (sourceUrls[ui]) deniedImageResponses[sourceUrls[ui]] = makeOriginDisallowedArticleResponse();
    }
    if (!urls.length) { sendResponse(deniedImageResponses); return true; }
    handleFetch(urls, {
      maxImagesPerPost: msg.maxImages || 100,
      maxDisplayPerPost: msg.displayImages || msg.maxImages || 100,
      heavyImageOptimization: msg.heavyImageOptimization !== false,
      articleTimeout: msg.articleTimeout,
      articleFetchConcurrency: msg.articleFetchConcurrency
    }, Number(msg.deadline) || 0).then(function(r) { sendResponse(Object.assign(deniedImageResponses, r || {})); BGLOG.flushSoon(); }).catch(function(e) { BGLOG.error('handleFetch', e.message); sendResponse(deniedImageResponses); });
    return true;
  }
  if (msg.type === SharedUtils.MESSAGE_TYPES.FETCH_TEXT_ATTACHMENTS_FRESH) {
    var freshUrl = typeof msg.url === 'string' ? msg.url : '';
    if (!originAllowed((sender && sender.url) || '') || !forumUrlAllowedInZone(freshUrl, getSenderForumZone(sender))) {
      sendResponse({ ok: false, textAttachments: [] });
      return true;
    }
    var freshDeadline = Number(msg.deadline) || (Date.now() + SharedUtils.getBackgroundFetchTimeout(1));
    fetchArticleWithInflight(freshUrl, {
      maxImagesPerPost: msg.maxImages || 100,
      maxDisplayPerPost: msg.displayImages || msg.maxImages || 100,
      heavyImageOptimization: msg.heavyImageOptimization !== false,
      articleTimeout: msg.articleTimeout
    }, freshDeadline).then(function(item) {
      if (!item || !item.ok) {
        sendResponse({ ok: false, textAttachments: [], reason: item && (item.reason || item.emptyReason) || '' });
        return;
      }
      sendResponse({
        ok: true,
        textAttachments: Array.isArray(item.textAttachments) ? item.textAttachments : [],
        partial: !!item.partial
      });
      BGLOG.flushSoon();
    }).catch(function(e) {
      BGLOG.error('FETCH_TEXT_ATTACHMENTS_FRESH', e.message);
      sendResponse({ ok: false, textAttachments: [] });
    });
    return true;
  }
  if (msg.type === SharedUtils.MESSAGE_TYPES.FETCH_TEXT_RESOURCES) {
    if (!originAllowed((sender && sender.url) || '')) {
      var deniedTextAttempted = Math.min(TEXT_ATTACHMENT_MAX_COUNT, Array.isArray(msg.attachments) ? msg.attachments.length : 0);
      sendResponse(makeTextResourceFetchStatus(SharedUtils.emptyResources(), deniedTextAttempted, deniedTextAttempted, deniedTextAttempted));
      return true;
    }
    var textSenderZone = getSenderForumZone(sender);
    var sourceAttachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    var maxSourceAttachments = Math.max(0, Number(SharedUtils.BG_FETCH_MAX_TEXT_ATTACHMENTS) || 30);
    var attachments = [];
    var seenAttachments = {};
    for (var ai = 0; ai < sourceAttachments.length && ai < maxSourceAttachments && attachments.length < TEXT_ATTACHMENT_MAX_COUNT; ai++) {
      var attachment = sourceAttachments[ai];
      if (!attachment || !attachment.url || !textAttachmentAllowedInZone(attachment.url, textSenderZone)) continue;
      var attachmentKey = SharedUtils.normalizeTextAttachmentUrl(attachment.url);
      if (!attachmentKey || seenAttachments[attachmentKey]) continue;
      seenAttachments[attachmentKey] = true;
      attachments.push(attachment);
    }
    var textDeadline = Number(msg.deadline) || (Date.now() + SharedUtils.getTextAttachmentBackgroundTimeout(attachments.length));
    var manualRetry = !!msg.manualRetry;
    enqueueTextResourceMessage(attachments, textDeadline, { manualRetry: manualRetry, owner: sender && sender.tab && sender.tab.id, zone: textSenderZone }).then(function(status) {
      sendResponse({
        resources: SharedUtils.normalizeResources(status.resources),
        attemptedCount: status.attemptedCount,
        unresolvedCount: status.unresolvedCount,
        retryableCount: status.retryableCount,
        queueStatus: status.queueStatus || 'completed'
      });
      BGLOG.flushSoon();
    }).catch(function(e) {
      BGLOG.error('FETCH_TEXT_RESOURCES', e.message);
      sendResponse({
        resources: SharedUtils.emptyResources(),
        attemptedCount: attachments.length,
        unresolvedCount: attachments.length,
        retryableCount: attachments.length
      });
    });
    return true;
  }
  sendResponse({});
  return false;
}

async function handleFetch(urls, imageSettings, deadline) {
  imageSettings = normalizeImageExtractionSettings(imageSettings);
  var results = {};
  var nextIndex = 0;
  var okCount = 0;
  var retryableCount = 0;
  var partialCount = 0;
  var imageTotal = 0;
  var resourceTotal = 0;
  var textAttachmentTotal = 0;
  var workerCount = Math.min(urls.length, ATPLoadPolicy.getArticleFetchConcurrency(imageSettings));

  async function worker() {
    while (true) {
      var index = nextIndex++;
      if (index >= urls.length) return;
      var url = urls[index];
      var item;
      if (getRemainingDeadlineMs(deadline) <= 0) {
        item = makeDeadlineArticleResult();
      } else {
        item = await fetchArticleWithInflight(url, imageSettings, deadline);
      }
      item = item || {};
      var images = item.images || [];
      var resources = SharedUtils.normalizeResources(item.resources);
      var textAttachments = item.textAttachments || [];
      if (item.ok) okCount++;
      if (item.retryableEmpty) retryableCount++;
      if (item.partial) partialCount++;
      imageTotal += images.length;
      resourceTotal += SharedUtils.countResources(resources);
      textAttachmentTotal += textAttachments.length;
      results[url] = makeBackgroundArticleResponse(item);
    }
  }

  var workers = new Array(workerCount);
  for (var i = 0; i < workerCount; i++) workers[i] = worker();
  await Promise.all(workers);
  // 每次批量抓取的常规摘要归入 DEBUG，避免非调试状态下高频落盘（WARN/ERROR 仍始终持久化）
  BGLOG.debug('文章批量提取', 'total' + urls.length + ' ok' + okCount + ' empty' + (urls.length - okCount) + ' retryable' + retryableCount + ' partial' + partialCount + ' 图片' + imageTotal + ' 资源' + resourceTotal + ' TXT' + textAttachmentTotal);
  return results;
}

chrome.runtime.onInstalled.addListener(function(details) {
  if (details.reason === 'update' || details.reason === 'install') {
    chrome.storage.local.get(null, function(items) {
      if (consumeStorageError('旧缓存扫描失败')) return;
      var keysToRemove = [];
      var _BASE = SharedUtils.CACHE_PREFIXES;
      for (var key in items) {
        if (key.indexOf(_BASE.IMAGE_BASE) === 0) {
          // thumb_cache_*（含 v2）已无任何读写方，属历史遗留死数据，升级时一并清掉，
          // 避免占用配额且在 LRU 淘汰排序中被当成最高优先级保留
          keysToRemove.push(key);
        } else if (key.indexOf(_BASE.ARTICLE_BASE) === 0 && key.indexOf(_BASE.ARTICLE) !== 0) {
          keysToRemove.push(key);
        } else if (SharedUtils.isUnsafeTextAttachmentCacheKey(key, _BASE.TEXT_RESOURCE)) {
          keysToRemove.push(key);
        } else if (SharedUtils.isUnsafeTextAttachmentCacheKey(key, _BASE.TEXT_FAIL)) {
          keysToRemove.push(key);
        } else if (key.indexOf(_BASE.TEXT_RESOURCE_BASE) === 0 && key.indexOf(_BASE.TEXT_RESOURCE) !== 0) {
          keysToRemove.push(key);
        } else if (key.indexOf(_BASE.TEXT_FAIL_BASE) === 0 && key.indexOf(_BASE.TEXT_FAIL) !== 0) {
          keysToRemove.push(key);
        } else if (key.indexOf(_BASE.NEGATIVE_BASE) === 0 && key.indexOf(_BASE.NEGATIVE) !== 0) {
          keysToRemove.push(key);
        }
      }
      if (keysToRemove.length) {
        chrome.storage.local.remove(keysToRemove, function() {
          if (consumeStorageError('旧缓存清理失败')) return;
          removeCacheIndexEntriesAfterStorageRemove(keysToRemove, '旧缓存索引清理', function(success, rebuilt) {
            function finish(ok) {
              if (ok) BGLOG.info('onInstalled', '清理旧缓存' + keysToRemove.length + '条');
              else BGLOG.warn('onInstalled', '旧缓存已删除但索引重建失败');
            }
            if (rebuilt) {
              finish(success);
              return;
            }
            SharedUtils.cacheIndex.rebuild(function(entries) {
              finish(!!entries);
            });
          });
        });
      } else {
        SharedUtils.cacheIndex.rebuild();
      }
    });
  }
});
