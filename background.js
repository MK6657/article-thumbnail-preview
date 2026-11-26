/**
 * Background Service Worker
 */

importScripts('settings-schema.js', 'defaults.js', 'shared-utils.js', 'html-extractors.js', 'logger.js', 'cache.js', 'resource-marks.js', 'loading-policy.js');

if (typeof SharedUtils !== 'undefined' && SharedUtils.cacheIndex) {
  SharedUtils.cacheIndex._backgroundOwner = true;
}

const BGLOG = ATPCreateLogger({
  storageKey: 'atp_logs_bg',
  maxEntries: 500,
  maxBytes: (typeof SharedUtils !== 'undefined' && SharedUtils.BACKGROUND_LOG_BYTES) || (512 * 1024),
  source: 'bg'
});

if (typeof globalThis !== 'undefined') {
  globalThis.BGLOG = BGLOG;
}

var bgNormalizedSettings = ATPNormalizeSettings(null);
if (typeof globalThis !== 'undefined') {
  globalThis.ATPBackgroundSettings = bgNormalizedSettings;
}
var bgCacheTtlMs = (Number(bgNormalizedSettings.cacheTTL) || 30) * 60 * 1000;
var settingsLoaded = false;

function syncBackgroundDebugLogging(rawSettings) {
  bgNormalizedSettings = ATPNormalizeSettings(rawSettings);
  if (typeof globalThis !== 'undefined') {
    globalThis.ATPBackgroundSettings = bgNormalizedSettings;
  }
  BGLOG.setDebugEnabled(bgNormalizedSettings.debugLogging === true);
  bgCacheTtlMs = (Number(bgNormalizedSettings.cacheTTL) || 30) * 60 * 1000;
}

var settingsReady = (function() {
  try {
    return new Promise(function(resolve) {
      chrome.storage.local.get('settings', function(result) {
        settingsLoaded = true;
        if (typeof globalThis !== 'undefined') {
          globalThis.ATPSettingsReady = null;
        }
        if (chrome.runtime.lastError) {
          BGLOG.setDebugEnabled(false);
          resolve(bgNormalizedSettings);
          return;
        }
        syncBackgroundDebugLogging(result && result.settings);
        resolve(bgNormalizedSettings);
      });
    });
  } catch (e) {
    settingsLoaded = true;
    BGLOG.setDebugEnabled(false);
    return Promise.resolve(bgNormalizedSettings);
  }
})();

if (!settingsLoaded && typeof globalThis !== 'undefined') {
  globalThis.ATPSettingsReady = settingsReady;
}

// Entries past the cache TTL go first (oldest first)
function compareEvictionOrder(a, b, expiredBefore) {
  var aExpired = a.ts < expiredBefore;
  var bExpired = b.ts < expiredBefore;
  if (aExpired !== bExpired) return aExpired ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.ts - b.ts;
}

if (chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
  chrome.storage.onChanged.addListener(function(changes, areaName) {
    if (areaName !== 'local' || !changes) return;
    if (changes.atp_forum_pacer_reset_at) {
      resetTextForumCooldowns();
      resetForumPacerStatuses(changes.atp_forum_pacer_reset_at.newValue).catch(function(error) {
        BGLOG.warn('重置论坛节流显示失败', error.message);
      });
    }
    if (changes.settings) {
      settingsLoaded = true;
      if (typeof globalThis !== 'undefined') {
        globalThis.ATPSettingsReady = null;
      }
      syncBackgroundDebugLogging(changes.settings.newValue);
    }
    var generationKey = SharedUtils.CACHE_GENERATION_KEY || 'atp_cache_generation_v1';
    if (changes[generationKey]) {
      ATPCache._rememberCacheGeneration(changes[generationKey].newValue);
    }
    if (changes[SharedUtils.CACHE_INDEX_KEY] && changes[SharedUtils.CACHE_INDEX_KEY].newValue === undefined) {
      SharedUtils.cacheIndex.resetMemory();
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

function isBuiltinForumSender(sender) {
  if (!sender || typeof sender.url !== 'string') return false;
  try {
    var u = new URL(sender.url);
    return u.protocol === 'https:' && SharedUtils.isBuiltinForumHost(u.hostname);
  } catch (e) {
    return false;
  }
}

function textAttachmentAllowed(url) {
  return SharedUtils.isAllowedTextAttachmentUrl(url);
}

function textAttachmentAllowedInZone(url, zone) {
  return SharedUtils.isTextAttachmentUrlAllowedInZone(url, zone);
}

function getSenderForumZone(sender) {
  var url = (sender && sender.url) || '';
  return originAllowed(url) ? SharedUtils.getForumUrlZone(url) : '';
}

function forumUrlAllowedInZone(url, zone) {
  return !!zone && originAllowed(url) && SharedUtils.getForumUrlZone(url) === zone;
}

// ---- Forum pacer shared status ----
const FORUM_PACER_STATUS_KEY = 'atp_forum_pacer_status_v1';
const FORUM_PACER_RESET_KEY = 'atp_forum_pacer_reset_at';
const FORUM_SERVER_WAIT_KEY = 'atp_forum_server_wait_v1';
var forumPacerStatusWrites = Promise.resolve();

function updateForumPacerStatuses(update, serverWait) {
  var run = forumPacerStatusWrites.then(function() {
    return new Promise(function(resolve, reject) {
      var keys = [FORUM_PACER_STATUS_KEY, FORUM_PACER_RESET_KEY];
      if (serverWait) keys.push(FORUM_SERVER_WAIT_KEY);
      chrome.storage.local.get(keys, function(items) {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        var stored = items && items[FORUM_PACER_STATUS_KEY];
        var statuses = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
        var resetMarker = Number(items && items[FORUM_PACER_RESET_KEY]) || 0;
        var changes = {};
        if (update(statuses, resetMarker)) {
          var hosts = Object.keys(statuses).sort(function(a, b) {
            return ((statuses[b] && statuses[b].at) || 0) - ((statuses[a] && statuses[a].at) || 0);
          });
          for (var i = 10; i < hosts.length; i++) delete statuses[hosts[i]];
          changes[FORUM_PACER_STATUS_KEY] = statuses;
        }
        if (serverWait) {
          var savedWaits = items && items[FORUM_SERVER_WAIT_KEY] || {};
          var currentWait = savedWaits[serverWait.origin];
          if (!currentWait || serverWait.until > currentWait.until) {
            var now = Date.now();
            var waits = {};
            Object.keys(savedWaits).forEach(function(origin) {
              var wait = savedWaits[origin];
              if (wait && wait.until + FORUM_RECOVERY_IDLE_MS > now) waits[origin] = wait;
            });
            waits[serverWait.origin] = { at: serverWait.at, until: serverWait.until };
            changes[FORUM_SERVER_WAIT_KEY] = waits;
          }
        }
        if (!Object.keys(changes).length) return resolve();
        chrome.storage.local.set(changes, function() {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve();
        });
      });
    });
  });
  forumPacerStatusWrites = run.catch(function() {});
  return run;
}

function recordForumPacerStatus(host, entry, marker) {
  return updateForumPacerStatuses(function(statuses, resetMarker) {
    if (marker !== resetMarker) return false;
    var current = statuses[host];
    if (current && current.resetMarker === marker && current.at > entry.at && current.at <= Date.now()) return false;
    var snapshot = { resetMarker: marker };
    ['at', 'burst', 'refillMs', 'learnedBurst', 'learnedRefillMs', 'level', 'pauseUntil',
      'retryAfterUntil', 'limitsUntil', 'idleUntil'].forEach(function(key) {
      snapshot[key] = Number.isFinite(entry[key]) && entry[key] >= 0 ? entry[key] : 0;
    });
    if (current && current.retryAfterUntil > Date.now() && current.retryAfterUntil > snapshot.retryAfterUntil) {
      snapshot.retryAfterUntil = current.retryAfterUntil;
      snapshot.pauseUntil = Math.max(snapshot.pauseUntil, current.retryAfterUntil);
      snapshot.idleUntil = Math.max(snapshot.idleUntil, current.retryAfterUntil + 300000);
    }
    statuses[host] = snapshot;
    return true;
  });
}

function recordBackgroundForumRetryAfter(origin, at, until) {
  var host = new URL(origin).hostname;
  return updateForumPacerStatuses(function(statuses, resetMarker) {
    var now = Date.now();
    var current = statuses[host] || {};
    if (until <= Math.max(now, Number(current.retryAfterUntil) || 0)) return false;
    statuses[host] = Object.assign({
      burst: 10, refillMs: 2000, learnedBurst: 10, learnedRefillMs: 2000, limitsUntil: 0
    }, current, {
      at: now,
      resetMarker: resetMarker,
      level: Math.max(1, Number(current.level) || 0),
      pauseUntil: Math.max(until, Number(current.pauseUntil) || 0),
      retryAfterUntil: until,
      idleUntil: Math.max(until + FORUM_RECOVERY_IDLE_MS, Number(current.idleUntil) || 0)
    });
    return true;
  }, { origin: origin, at: at, until: until });
}

function resetForumPacerStatuses(marker) {
  return updateForumPacerStatuses(function(statuses, resetMarker) {
    if (!resetMarker || marker !== resetMarker) return false;
    var now = Date.now();
    var changed = false;
    Object.keys(statuses).forEach(function(host) {
      var current = statuses[host] || {};
      if (current.resetMarker === marker) return;
      var retryAfterUntil = Number(current.retryAfterUntil) > now ? current.retryAfterUntil : 0;
      statuses[host] = {
        burst: 10, refillMs: 2000, learnedBurst: 10, learnedRefillMs: 2000, level: retryAfterUntil ? 1 : 0,
        pauseUntil: retryAfterUntil, retryAfterUntil: retryAfterUntil, limitsUntil: 0,
        idleUntil: Math.max(now, retryAfterUntil) + 300000, at: now, resetMarker: marker
      };
      changed = true;
    });
    return changed;
  });
}

// ---- Forum mirror sites ----
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
      resolve(stored && Array.isArray(stored.sites) ? {
        sites: SharedUtils.normalizeMirrorSites(stored.sites),
        scriptsRegistered: stored.scriptsRegistered === true
      } : null);
    });
  });
}

function storeMirrorSites(sites, scriptsRegistered) {
  return new Promise(function(resolve, reject) {
    var items = {};
    items[SharedUtils.MIRROR_SITES_STORAGE_KEY] = {
      sites: sites, updatedAt: Date.now(), scriptsRegistered: scriptsRegistered === true
    };
    chrome.storage.local.set(items, function() {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function getMirrorSitePatternKey(sites) {
  return sites.map(function(site) { return site.pattern; }).join('\n');
}

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

function refreshMirrorSites(reason, force) {
  var run = mirrorSitesChain.then(async function() {
    var sites = SharedUtils.getMirrorSitesFromOrigins(await getGrantedPermissionOrigins());
    SharedUtils.setMirrorSites(sites);
    mirrorSitesLoaded = true;
    var stored = await readStoredMirrorSites();
    var changed = !stored || getMirrorSitePatternKey(stored.sites) !== getMirrorSitePatternKey(sites);
    var registered = true;
    if (changed || force || !stored.scriptsRegistered) {
      await storeMirrorSites(sites, false);
      try {
        registered = await syncMirrorContentScripts(sites);
        if (registered) await storeMirrorSites(sites, true);
      } catch (e) {
        registered = false;
        BGLOG.warn('镜像站点脚本注册失败', e && e.message ? e.message : String(e));
      }
      if (changed) BGLOG.debug('镜像站点', reason + ' ' + sites.length + '个');
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

function makeTextResourceFetchStatus(resources, attemptedCount, unresolvedCount, retryableCount, accessDeniedCount) {
  var normalized = SharedUtils.normalizeResources(resources);
  var attempted = Math.max(0, Number(attemptedCount) || 0);
  var unresolved = Math.max(0, Number(unresolvedCount) || 0);
  if (unresolved > attempted) unresolved = attempted;
  var retryable = Math.max(0, Number(retryableCount) || 0);
  if (retryable > unresolved) retryable = unresolved;
  var status = {
    resources: normalized,
    attemptedCount: attempted,
    unresolvedCount: unresolved,
    retryableCount: retryable
  };
  var denied = Math.min(unresolved, Math.max(0, Number(accessDeniedCount) || 0));
  if (denied) status.accessDeniedCount = denied;
  return status;
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

var bgTextDiagnosticSequence = 0;

function withBackgroundTextDiagnosticId(attachment) {
  if (!attachment || !attachment.url) return attachment;
  if (/^txt_[a-z0-9_]{1,64}$/.test(attachment.diagnosticId || '')) return attachment;
  return Object.assign({}, attachment, {
    diagnosticId: 'txt_bg_' + Date.now().toString(36) + '_' +
      (++bgTextDiagnosticSequence).toString(36) + '_' + Math.random().toString(36).slice(2, 10)
  });
}

function logBackgroundTextDiagnostic(attachment, outcome, failureClass, deadline, details) {
  if (!attachment || !/^txt_[a-z0-9_]{1,64}$/.test(attachment.diagnosticId || '')) return;
  if (BGLOG.isEnabled && !BGLOG.isEnabled('DEBUG')) return;
  var fields = {
    attachmentId: attachment.diagnosticId,
    stage: 'background_fetch',
    outcome: outcome,
    failureClass: failureClass || '',
    remainingMs: Number.isFinite(Number(deadline)) && Number(deadline) > 0
      ? Math.max(0, Math.min(100000000, Math.round(deadline - Date.now())))
      : null
  };
  if (/^t_[0-9]{1,20}_[A-Za-z0-9]{1,24}$/.test(attachment.diagnosticThreadId || '') &&
      Number.isSafeInteger(attachment.diagnosticRunId) && attachment.diagnosticRunId > 0) {
    fields.threadId = attachment.diagnosticThreadId;
    fields.runId = attachment.diagnosticRunId;
  }
  details = details || {};
  ['status', 'resources', 'elapsedMs', 'depth'].forEach(function(key) {
    if (Number.isFinite(details[key])) fields[key] = Math.max(0, Math.min(100000000, Math.round(details[key])));
  });
  try { BGLOG.debug('txt_request', fields); } catch (e) {}
}

function backgroundTextFailureClass(error, status) {
  if (status === 401 || status === 403) return 'auth_or_forbidden';
  if (status === 429 || status === 503) return 'throttle_or_unavailable';
  if (status >= 400) return 'http_error';
  if (error && error.name === 'AbortError') return 'timeout';
  if (error && error.name === 'TypeError') return 'transport';
  return 'request_error';
}

const TEXT_ATTACHMENT_MAX_COUNT = SharedUtils.TEXT_ATTACHMENT_MAX_COUNT;
const TEXT_ATTACHMENT_MAX_BYTES = SharedUtils.TEXT_ATTACHMENT_MAX_BYTES;
const TEXT_ATTACHMENT_TIMEOUT = SharedUtils.TEXT_ATTACHMENT_TIMEOUT;
const TEXT_RESOURCE_MESSAGE_CONCURRENCY = 2;
const TEXT_RESOURCE_QUEUE_LIMIT = 32;
const TEXT_RESOURCE_QUEUE_PER_OWNER = 4;
const TEXT_RESOURCE_QUEUE_MAX_WAIT_MS = 30000;
const BG_QUOTA_BYTES = SharedUtils.DEFAULT_CACHE_QUOTA_BYTES || (32 * 1024 * 1024);
const BG_HIGH_WATERMARK = Math.floor(BG_QUOTA_BYTES * 0.85);
const BG_TARGET_WATERMARK = Math.floor(BG_QUOTA_BYTES * 0.75);
const DAILY_BACKUP_RETENTION_DAYS = 90;
const MARK_TOUCH_THROTTLE_MS = 3600000;

var SETTINGS_WRITE_CHAIN = Promise.resolve();
var ARTICLE_FETCH_IN_FLIGHT = {};
var textResourceMessageQueue = [];
var textResourceMessageActive = 0;
var TEXT_FORUM_COOLDOWNS_KEY = 'atp_text_forum_cooldowns_v1';
const FORUM_RECOVERY_IDLE_MS = 5 * 60 * 1000;
var textForumCooldowns = new Map();
var textForumCooldownsReady;
var textForumCooldownWrite = Promise.resolve();
var recoveringForumProbes = new Map();

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
    var job = {
      attachments: attachments, deadline: deadline, options: options, owner: owner,
      expiresAt: expiresAt, resolve: resolve, reject: reject, timer: null
    };
    var firstAutomatic = options.manualRetry
      ? textResourceMessageQueue.findIndex(function(queued) { return !queued.options.manualRetry; })
      : -1;
    if (firstAutomatic === -1) textResourceMessageQueue.push(job);
    else textResourceMessageQueue.splice(firstAutomatic, 0, job);
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

function scheduleAbortControl(control) {
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

function getArticleFetchAbortAt(deadline, articleSettings) {
  return Date.now() + getDeadlineFetchTimeout(deadline, ATPLoadPolicy.getArticleTimeout(articleSettings || {}));
}

function createArticleFetchControl(deadline, articleSettings) {
  var control = {
    abortAt: getArticleFetchAbortAt(deadline, articleSettings),
    controller: new AbortController(),
    timer: 0
  };
  scheduleAbortControl(control);
  return control;
}

function extendArticleFetchControl(control, deadline, articleSettings) {
  if (!control) return;
  var abortAt = getArticleFetchAbortAt(deadline, articleSettings);
  if (abortAt > control.abortAt && !control.controller.signal.aborted) {
    control.abortAt = abortAt;
    scheduleAbortControl(control);
  }
}

function clearArticleFetchControl(control) {
  if (control && control.timer) {
    clearTimeout(control.timer);
    control.timer = 0;
  }
}

function createTextFetchControl(deadline) {
  var control = {
    abortAt: Date.now() + getDeadlineFetchTimeout(deadline, TEXT_ATTACHMENT_TIMEOUT),
    controller: new AbortController(),
    timer: 0
  };
  scheduleAbortControl(control);
  return control;
}

function extendTextFetchControl(control, deadline) {
  if (!control) return;
  var abortAt = Date.now() + getDeadlineFetchTimeout(deadline, TEXT_ATTACHMENT_TIMEOUT);
  if (abortAt > control.abortAt && !control.controller.signal.aborted) {
    control.abortAt = abortAt;
    scheduleAbortControl(control);
  }
}

function consumeStorageError(action) {
  if (!chrome.runtime.lastError) return false;
  BGLOG.warn(action, chrome.runtime.lastError.message);
  return true;
}

// ---- Settings patch handling (reusing defaults.js normalization) ----
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
    if (!Object.prototype.hasOwnProperty.call(source, key) || !isAllowedSettingsPatchKey(key)) continue;
    if (key === 'siteConfigs') {
      out.siteConfigs = ATPNormalizeSettings({ siteConfigs: source.siteConfigs }).siteConfigs;
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
      var current = ATPNormalizeSettings(result && result.settings);
      var merged = Object.assign({}, current, stablePatch);
      if (Object.prototype.hasOwnProperty.call(stablePatch, 'siteConfigs')) {
        var mergedSites = {};
        var curSites = current.siteConfigs || {};
        for (var ch in curSites) {
          if (Object.prototype.hasOwnProperty.call(curSites, ch)) {
            mergedSites[ch] = Object.assign({}, curSites[ch]);
          }
        }
        var patchSites = stablePatch.siteConfigs || {};
        for (var ph in patchSites) {
          if (Object.prototype.hasOwnProperty.call(patchSites, ph)) {
            mergedSites[ph] = Object.assign({}, mergedSites[ph] || {}, patchSites[ph]);
          }
        }
        merged.siteConfigs = mergedSites;
      }
      var next = ATPNormalizeSettings(merged);
      chrome.storage.local.set({ settings: next }, function() {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        settingsLoaded = true;
        if (typeof globalThis !== 'undefined') {
          globalThis.ATPSettingsReady = null;
        }
        syncBackgroundDebugLogging(next);
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

// ---- Marked resources and daily backup ----
var MARKS_WRITE_CHAIN = Promise.resolve();
var MARKS_COPY_SCOPE_RE = /^(?:all|passwords|type:[a-z0-9]{1,16})$/;

function queueMarksWrite(task) {
  var run = MARKS_WRITE_CHAIN.catch(function() {}).then(task);
  MARKS_WRITE_CHAIN = run.catch(function() {});
  return run;
}

function marksError(code) {
  var error = new Error(code);
  error.code = code;
  return error;
}

function marksStorageGet(keys) {
  return new Promise(function(resolve, reject) {
    chrome.storage.local.get(keys, function(items) {
      if (chrome.runtime.lastError) {
        reject(marksError('storage_read_failed'));
        return;
      }
      resolve(items || {});
    });
  });
}

function marksStorageSet(items) {
  return new Promise(function(resolve, reject) {
    chrome.storage.local.set(items, function() {
      if (chrome.runtime.lastError) {
        reject(marksError('storage_write_failed'));
        return;
      }
      resolve();
    });
  });
}

function marksStorageRemove(keys) {
  return new Promise(function(resolve, reject) {
    if (!keys.length) {
      resolve();
      return;
    }
    chrome.storage.local.remove(keys, function() {
      if (chrome.runtime.lastError) {
        reject(marksError('storage_write_failed'));
        return;
      }
      resolve();
    });
  });
}

function updateMarksBadge(index) {
  if (!chrome.action || typeof chrome.action.setBadgeText !== 'function') return;
  var count = ATPMarks.countUnexported(index);
  try {
    chrome.action.setBadgeText({ text: count ? (count > 999 ? '999+' : String(count)) : '' });
    if (typeof chrome.action.setBadgeBackgroundColor === 'function') chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
  } catch (e) {}
}

function refreshMarksBadge() {
  marksStorageGet(ATPMarks.KEYS.INDEX).then(function(items) {
    updateMarksBadge(ATPMarks.readIndex(items[ATPMarks.KEYS.INDEX]));
  }).catch(function() {});
}

function putMarksIndexEntry(index, record, bytes) {
  var entry = ATPMarks.makeIndexEntry(record);
  entry.bytes = bytes;
  for (var i = 0; i < index.items.length; i++) {
    if (index.items[i].id === record.id) {
      index.items[i] = entry;
      return;
    }
  }
  index.items.push(entry);
}

async function saveMarkSnapshot(op, snapshot, now) {
  var INDEX = ATPMarks.KEYS.INDEX;
  var key = ATPMarks.itemKey(snapshot.id);
  var stored = await marksStorageGet([INDEX, key]);
  var index = ATPMarks.readIndex(stored[INDEX]);
  var listed = index.items.some(function(item) { return item.id === snapshot.id; });
  if (op === 'update' && !listed) return { ok: true, marked: false };
  if (!listed && index.items.length >= ATPMarks.LIMITS.MARKS) throw marksError('limit_count');
  var existing = listed && stored[key] && typeof stored[key] === 'object' ? stored[key] : null;
  var merged = ATPMarks.mergeRecord(existing, snapshot, now);
  if (existing && !merged.changed) return { ok: true, marked: true, unchanged: true };
  var record = merged.record;
  if (existing && !merged.contentChanged) {
    // Avoid redundant storage writes when only readAt moved within the last 1h
    var prevReadAt = Number(existing.readAt) || 0;
    var nextReadAt = Number(record.readAt) || 0;
    if (prevReadAt > 0 && nextReadAt >= prevReadAt && (nextReadAt - prevReadAt) < MARK_TOUCH_THROTTLE_MS) {
      return { ok: true, marked: true, unchanged: true };
    }
    var touched = {};
    touched[key] = record;
    await marksStorageSet(touched);
    return { ok: true, marked: true, unchanged: true };
  }
  var bytes = SharedUtils.utf8ByteLength(JSON.stringify(record));
  var totalBytes = bytes;
  index.items.forEach(function(item) {
    if (item.id !== record.id) totalBytes += Number(item.bytes) || 0;
  });
  if (totalBytes > ATPMarks.LIMITS.MARKS_BYTES) throw marksError('limit_bytes');
  putMarksIndexEntry(index, record, bytes);
  index.rev++;
  var out = {};
  out[key] = record;
  out[INDEX] = index;
  await marksStorageSet(out);
  updateMarksBadge(index);
  return { ok: true, marked: true, created: !listed, links: ATPMarks.makeIndexEntry(record).links };
}

async function removeMarks(filter, expectedRev) {
  var INDEX = ATPMarks.KEYS.INDEX;
  var stored = await marksStorageGet(INDEX);
  var index = ATPMarks.readIndex(stored[INDEX]);
  if (typeof expectedRev === 'number' && expectedRev !== index.rev) throw marksError('stale');
  var removed = [];
  index.items = index.items.filter(function(item) {
    if (!filter(item)) return true;
    removed.push(item.id);
    return false;
  });
  if (!removed.length) return { ok: true, removed: 0 };
  index.rev++;
  var out = {};
  out[INDEX] = index;
  var detailKeys = removed.map(ATPMarks.itemKey);
  detailKeys.forEach(function(key) { out[key] = null; });
  await marksStorageSet(out);
  try {
    await marksStorageRemove(detailKeys);
  } catch (error) {
    await marksStorageRemove(detailKeys).catch(function() { BGLOG.warn('清理空标记键失败', detailKeys.length); });
  }
  updateMarksBadge(index);
  return { ok: true, removed: removed.length };
}

async function addToDailyBackup(snapshots, event, extraItems) {
  if (!snapshots.length) return { ok: true, added: 0 };
  var nowMs = Number(event.at) || Date.now();
  var date = ATPMarks.formatDate(nowMs);
  var DAYS = ATPMarks.KEYS.DAYS;
  var dayKey = ATPMarks.dayKey(date);
  var stored = await marksStorageGet([DAYS, dayKey]);
  var day = ATPMarks.readDay(stored[dayKey], date);
  var days = ATPMarks.readDays(stored[DAYS]);
  snapshots.forEach(function(snapshot) { ATPMarks.addToDay(day, snapshot, event); });
  days.days[date] = Object.assign({ updatedAt: nowMs }, ATPMarks.summarizeDay(day));

  // Prune daily backups older than 90 days
  var cutoffDate = ATPMarks.formatDate(nowMs - DAILY_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  var staleDayKeys = [];
  for (var existingDate in days.days) {
    if (!Object.prototype.hasOwnProperty.call(days.days, existingDate)) continue;
    if (existingDate !== date && /^\d{4}-\d{2}-\d{2}$/.test(existingDate) && existingDate < cutoffDate) {
      delete days.days[existingDate];
      staleDayKeys.push(ATPMarks.dayKey(existingDate));
    }
  }

  var out = Object.assign({}, extraItems || {});
  out[dayKey] = day;
  out[DAYS] = days;
  await marksStorageSet(out);
  if (staleDayKeys.length) {
    await marksStorageRemove(staleDayKeys).catch(function() {
      BGLOG.warn('清理过期每日备份失败', staleDayKeys.length);
    });
  }
  return { ok: true, added: snapshots.length, date: date };
}

async function recordMarksHandedOut(seen, kind) {
  var INDEX = ATPMarks.KEYS.INDEX;
  var now = Date.now();
  var keys = [INDEX];
  var wanted = {};
  seen.forEach(function(entry) {
    if (!entry || typeof entry.id !== 'string' || wanted[entry.id]) return;
    var snapshot = ATPMarks.sanitizeBackupSnapshot(entry.snapshot);
    if (!snapshot || snapshot.id !== entry.id) throw marksError('invalid_snapshot');
    wanted[entry.id] = { updatedAt: Number(entry.updatedAt) || 0, snapshot: snapshot };
    keys.push(ATPMarks.itemKey(entry.id));
  });
  var stored = await marksStorageGet(keys);
  var index = ATPMarks.readIndex(stored[INDEX]);
  var snapshots = [];
  var out = {};
  var exported = 0;
  Object.keys(wanted).forEach(function(id) {
    snapshots.push(wanted[id].snapshot);
    var record = stored[ATPMarks.itemKey(id)];
    if (!record || typeof record !== 'object' || !Array.isArray(record.links)) return;
    var currentSnapshot = ATPMarks.sanitizeBackupSnapshot(record);
    if (kind === 'export' && Number(record.updatedAt) === wanted[id].updatedAt &&
        currentSnapshot && ATPMarks.recordContentSignature(currentSnapshot) === ATPMarks.recordContentSignature(wanted[id].snapshot) &&
        index.items.some(function(item) { return item.id === id; })) {
      record = Object.assign({}, record, { exportedAt: now });
      out[ATPMarks.itemKey(id)] = record;
      putMarksIndexEntry(index, record, SharedUtils.utf8ByteLength(JSON.stringify(record)));
      exported++;
    }
  });
  if (exported) {
    index.rev++;
    out[INDEX] = index;
  }
  var backup = await addToDailyBackup(snapshots, { at: now, kind: kind, scope: kind === 'copy' ? 'marks' : 'all' }, out);
  if (exported) updateMarksBadge(index);
  return { ok: true, exported: exported, backedUp: backup.added, date: backup.date || '' };
}

function isOwnExtensionPageSender(sender) {
  if (!sender || typeof sender.url !== 'string') return false;
  if (sender.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return false;
  try {
    return sender.url.indexOf(chrome.runtime.getURL('')) === 0;
  } catch (e) {
    return false;
  }
}

function handleMarksMutation(msg, sender) {
  var op = String(msg.op || '');
  var now = Date.now();
  if (isOwnExtensionPageSender(sender)) {
    if (op === 'exported' || op === 'copiedMarks') {
      var seen = Array.isArray(msg.marks) ? msg.marks.slice(0, ATPMarks.LIMITS.MARKS) : [];
      return queueMarksWrite(function() { return recordMarksHandedOut(seen, op === 'exported' ? 'export' : 'copy'); });
    }
    if (op === 'remove') {
      var ids = Array.isArray(msg.ids) ? msg.ids.filter(function(id) { return typeof id === 'string'; }) : [];
      return queueMarksWrite(function() { return removeMarks(function(item) { return ids.indexOf(item.id) !== -1; }); });
    }
    if (op === 'clearExported') {
      return queueMarksWrite(function() { return removeMarks(ATPMarks.isExported); });
    }
    if (op === 'clearAll') {
      var rev = Number(msg.rev);
      if (!isFinite(rev)) return Promise.reject(marksError('stale'));
      return queueMarksWrite(function() { return removeMarks(function() { return true; }, rev); });
    }
    return Promise.reject(marksError('not_allowed'));
  }
  var zone = getSenderForumZone(sender);
  if (!zone) return Promise.reject(marksError('not_allowed'));
  if (op === 'unmark') {
    var id = typeof msg.id === 'string' ? msg.id : '';
    if (id.indexOf(zone + '|') !== 0) return Promise.reject(marksError('site_mismatch'));
    return queueMarksWrite(function() { return removeMarks(function(item) { return item.id === id; }); });
  }
  if (op !== 'mark' && op !== 'update' && op !== 'copied') return Promise.reject(marksError('not_allowed'));
  var snapshot = ATPMarks.sanitizeSnapshot(msg.snapshot);
  if (!snapshot) return Promise.reject(marksError('invalid_thread'));
  if (snapshot.site !== zone) return Promise.reject(marksError('site_mismatch'));
  if (op === 'copied') {
    var scope = String(msg.scope || 'all');
    if (!MARKS_COPY_SCOPE_RE.test(scope)) return Promise.reject(marksError('invalid_scope'));
    return queueMarksWrite(function() { return addToDailyBackup([snapshot], { at: now, kind: 'copy', scope: scope }); });
  }
  return queueMarksWrite(function() { return saveMarkSnapshot(op, snapshot, now); });
}

refreshMarksBadge();

// ---- Shared Cache & Eviction wrappers (delegating to cross-context ATPCache) ----
function updateIndexForWrite(d) {
  return ATPCache._updateIndexForWrite(d);
}

function setStorageWithEviction(d, warnMsg, onDone, writeStartedAt) {
  return ATPCache._setStorageWithEviction(d, warnMsg, onDone, writeStartedAt);
}

function removeCacheIndexEntriesAfterStorageRemove(keys, action, callback) {
  return ATPCache._removeCacheIndexEntriesAfterStorageRemove(keys, action, callback);
}

function getCachedTextResources(url) {
  return ATPCache.getCachedTextResources(url);
}

function setCachedTextResources(url, resources, writeStartedAt) {
  return ATPCache.setCachedTextResources(url, resources, writeStartedAt);
}

function getTextFailCache(url) {
  return ATPCache.getTextFailCache(url);
}

function setTextFailCache(url, writeStartedAt) {
  return ATPCache.setTextFailCache(url, writeStartedAt);
}

function clearTextFailCache(url) {
  return ATPCache.clearTextFailCache(url);
}

function runBackgroundEviction(callback, triggerBytes) {
  if (triggerBytes < BG_HIGH_WATERMARK) {
    if (callback) callback();
    return;
  }
  // Evicts directly from in-memory cacheIndex entries without calling get(null),
  // falling back to rebuild() only if atp_cache_index_v1 is missing or corrupt.
  ATPCache.evictLRU(callback, triggerBytes);
}

function checkAndEvict(callback, baselineBytes) {
  if (typeof baselineBytes === 'number' && baselineBytes > 0) {
    runBackgroundEviction(callback, baselineBytes);
    return;
  }
  SharedUtils.getCacheBytesInUse(function(bytesUsed) {
    if (consumeStorageError('storage用量读取失败')) {
      if (callback) callback();
      return;
    }
    runBackgroundEviction(callback, bytesUsed);
  });
}

// ---- Forum cooldown & non-contending recovery probe queueing ----
function textForumOrigin(url) {
  return SharedUtils.getForumUrlZone(url) ? new URL(url).origin : '';
}

function restoreTextForumCooldowns() {
  if (!textForumCooldownsReady) {
    var session = chrome.storage.session;
    var sessionRead = session ? session.get(TEXT_FORUM_COOLDOWNS_KEY).catch(function(error) {
      BGLOG.warn('读取论坛限流期限失败', error.message);
      return {};
    }) : Promise.resolve({});
    var localRead = new Promise(function(resolve) {
      chrome.storage.local.get(FORUM_SERVER_WAIT_KEY, function(items) {
        if (chrome.runtime.lastError) {
          BGLOG.warn('读取论坛服务端等待时间失败', chrome.runtime.lastError.message);
          resolve({});
        } else {
          resolve(items && items[FORUM_SERVER_WAIT_KEY] || {});
        }
      });
    });
    textForumCooldownsReady = Promise.all([sessionRead, localRead]).then(function(results) {
      var saved = results[0][TEXT_FORUM_COOLDOWNS_KEY] || {};
      var now = Date.now();
      Object.keys(saved).forEach(function(origin) {
        var limit = saved[origin];
        if (limit && Number.isFinite(limit.at) && Number.isFinite(limit.until) && limit.until + FORUM_RECOVERY_IDLE_MS > now) {
          limit.retryAfter = Number.isFinite(limit.retryAfter) ? limit.retryAfter : limit.until;
          textForumCooldowns.set(origin, limit);
        }
      });
      var waits = results[1];
      Object.keys(waits).forEach(function(origin) {
        var wait = waits[origin];
        if (!wait || !Number.isFinite(wait.at) || !Number.isFinite(wait.until) || wait.until <= now) return;
        var current = textForumCooldowns.get(origin);
        if (!current || wait.until > current.retryAfter) {
          storeBackgroundForumCooldown(origin, origin, wait.at, wait.until, wait.until);
        }
      });
    });
  }
  return textForumCooldownsReady;
}

function saveTextForumCooldowns() {
  var now = Date.now();
  textForumCooldowns.forEach(function(limit, origin) {
    if (limit.until + FORUM_RECOVERY_IDLE_MS <= now && !recoveringForumProbes.has(limit.origin || origin)) {
      textForumCooldowns.delete(origin);
    }
  });
  if (!chrome.storage.session) return;
  textForumCooldownWrite = textForumCooldownWrite.then(function() {
    return chrome.storage.session.set({ [TEXT_FORUM_COOLDOWNS_KEY]: Object.fromEntries(textForumCooldowns) });
  }).catch(function(error) { BGLOG.warn('保存论坛限流期限失败', error.message); });
  return textForumCooldownWrite;
}

async function resetTextForumCooldowns() {
  await restoreTextForumCooldowns();
  var now = Date.now();
  textForumCooldowns.forEach(function(limit, origin) {
    if (limit.retryAfter && limit.retryAfter + FORUM_RECOVERY_IDLE_MS > now) {
      textForumCooldowns.set(origin, Object.assign({}, limit, { until: limit.retryAfter }));
    } else {
      textForumCooldowns.delete(origin);
    }
  });
  await saveTextForumCooldowns();
}

function reportTextForumCooldown(batch, cooldown, observed) {
  if (!batch) return;
  if (!batch.cooldown || cooldown.until > batch.cooldown.until) batch.cooldown = cooldown;
  batch.retryAfter = Math.max(batch.retryAfter || 0, cooldown.retryAfter);
  if (observed) {
    if (!batch.observedForumCooldowns) batch.observedForumCooldowns = new Map();
    batch.observedForumCooldowns.set(cooldown.origin, cooldown);
  }
}

function storeBackgroundForumCooldown(origin, finalOrigin, at, until, retryAfter) {
  var prior = textForumCooldowns.get(finalOrigin);
  var redirectedPrior = origin !== finalOrigin && textForumCooldowns.get(origin);
  retryAfter = Math.max(retryAfter, prior ? prior.retryAfter : 0, redirectedPrior ? redirectedPrior.retryAfter : 0);
  var cooldown = {
    origin: finalOrigin,
    at: at,
    until: Math.max(until, retryAfter, prior ? prior.until : 0, redirectedPrior ? redirectedPrior.until : 0),
    retryAfter: retryAfter
  };
  textForumCooldowns.set(finalOrigin, cooldown);
  if (origin && origin !== finalOrigin) textForumCooldowns.set(origin, cooldown);
  return cooldown;
}

async function noteReportedForumRetryAfter(origin, entry) {
  var retryAfter = entry.retryAfterUntil;
  if (!Number.isFinite(retryAfter) || retryAfter <= Date.now()) return;
  await restoreTextForumCooldowns();
  var current = textForumCooldowns.get(origin);
  if (current && current.retryAfter >= retryAfter) return;
  storeBackgroundForumCooldown(origin, origin, entry.at, retryAfter, retryAfter);
  await saveTextForumCooldowns();
}

async function noteBackgroundForumCooldown(origin, finalOrigin, retryAfter, batch) {
  var at = Date.now();
  retryAfter = Number.isFinite(retryAfter) && retryAfter > at ? retryAfter : 0;
  var cooldown = storeBackgroundForumCooldown(origin, finalOrigin, at, at + SharedUtils.FORUM_BASE_PAUSE_MS, retryAfter);
  reportTextForumCooldown(batch, cooldown, true);
  var saved = saveTextForumCooldowns();
  if (retryAfter) {
    await recordBackgroundForumRetryAfter(finalOrigin, at, retryAfter).catch(function(error) {
      BGLOG.warn('发布论坛服务端等待时间失败', error.message);
    });
  }
  await saved;
}

function noteTextForumCooldown(origin, finalOrigin, headers, batch) {
  return noteBackgroundForumCooldown(origin, finalOrigin, SharedUtils.parseRetryAfterHeader(headers), batch);
}

var recoveringForumOrigins = new Set();

function getBackgroundForumTurn(origin) {
  if (!origin) return null;
  var cooldown = textForumCooldowns.get(origin);
  if (!cooldown) return null;
  var now = Date.now();
  if (cooldown.until > now) return { wait: cooldown };
  var probeOrigin = cooldown.origin || origin;
  if (recoveringForumOrigins.has(probeOrigin)) {
    return { wait: Object.assign({}, cooldown, { until: now + 1000 }) };
  }
  if (cooldown.until + FORUM_RECOVERY_IDLE_MS <= now) {
    textForumCooldowns.delete(origin);
    return null;
  }
  recoveringForumOrigins.add(probeOrigin);
  return { probeOrigin: probeOrigin, cooldown: cooldown };
}

function finishBackgroundForumTurn(turn, servedOrigin) {
  if (!turn || !turn.probeOrigin) return;
  recoveringForumOrigins.delete(turn.probeOrigin);
  if (servedOrigin === turn.probeOrigin) {
    var cleared = false;
    textForumCooldowns.forEach(function(limit, origin) {
      if ((limit.origin || origin) === turn.probeOrigin && limit.at <= turn.cooldown.at && limit.until <= turn.cooldown.until) {
        textForumCooldowns.delete(origin);
        cleared = true;
      }
    });
    if (cleared) saveTextForumCooldowns();
  }
}

// ---- TXT Attachment Fetching with TEXT_FETCH_IN_FLIGHT deduplication ----
var TEXT_FETCH_IN_FLIGHT = new Map();

function getRemainingTextDeadlineMs(deadline) {
  if (!deadline) return Infinity;
  var remaining = Number(deadline) - Date.now();
  return isFinite(remaining) ? remaining : Infinity;
}

function scheduleTextAbortControl(control) {
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

function clearTextFetchControl(control) {
  if (control && control.timer) {
    clearTimeout(control.timer);
    control.timer = 0;
  }
}

function createTextFetchControl(deadline) {
  var control = {
    abortAt: Date.now() + getDeadlineFetchTimeout(deadline, TEXT_ATTACHMENT_TIMEOUT),
    controller: new AbortController(),
    timer: 0
  };
  scheduleTextAbortControl(control);
  return control;
}

function extendTextFetchControl(control, deadline) {
  if (!control) return;
  var abortAt = Date.now() + getDeadlineFetchTimeout(deadline, TEXT_ATTACHMENT_TIMEOUT);
  if (abortAt > control.abortAt && !control.controller.signal.aborted) {
    control.abortAt = abortAt;
    scheduleTextAbortControl(control);
  }
}

function getTextFetchInflightKey(url, zone, manualRetry, depth) {
  var norm = SharedUtils.normalizeTextAttachmentUrl(url);
  if (!norm) return '';
  return [zone || '', norm, manualRetry ? '1' : '0', depth || 0].join('|');
}

function waitForTextFetchDeadline(promise, deadline) {
  var remaining = getRemainingTextDeadlineMs(deadline);
  if (remaining === Infinity) return promise;
  if (remaining <= 0) {
    return Promise.resolve({
      resources: SharedUtils.emptyResources(),
      outcome: 'skipped',
      failure: 'deadline',
      status: 0,
      count: 0,
      accessDenied: false,
      forumRequestSent: false,
      cooldown: null,
      observedCooldowns: null
    });
  }
  return new Promise(function(resolve) {
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      resolve({
        resources: SharedUtils.emptyResources(),
        outcome: 'skipped',
        failure: 'deadline',
        status: 0,
        count: 0,
        accessDenied: false,
        forumRequestSent: false,
        cooldown: null,
        observedCooldowns: null
      });
    }, remaining);
    promise.then(function(res) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (getRemainingTextDeadlineMs(deadline) <= 0) {
        resolve({
          resources: SharedUtils.emptyResources(),
          outcome: 'skipped',
          failure: 'deadline',
          status: 0,
          count: 0,
          accessDenied: false,
          forumRequestSent: false,
          cooldown: null,
          observedCooldowns: null
        });
      } else {
        resolve(res);
      }
    });
  });
}

async function executeSingleTextAttachmentFetch(attachment, depth, deadline, options, control) {
  var writeStartedAt = Date.now();
  var manualRetry = !!(options.manualRetry || options.force);
  var localBatch = {};
  var localOutcome = { accessDenied: false };
  var diagnosticOutcome = 'failed';
  var diagnosticFailure = 'request_error';
  var diagnosticStatus = 0;
  var diagnosticResources = 0;
  var forumTurn = null;
  var resp = null;

  try {
    var cached = await getCachedTextResources(attachment.url);
    if (cached) {
      clearTextFailCache(attachment.url);
      return {
        resources: cached,
        outcome: 'cache_hit',
        failure: '',
        status: 0,
        count: SharedUtils.countResources(cached),
        accessDenied: false,
        forumRequestSent: false,
        cooldown: null,
        observedCooldowns: null
      };
    }

    if (!manualRetry) {
      var failCached = await getTextFailCache(attachment.url);
      if (failCached) {
        return {
          resources: SharedUtils.emptyResources(),
          outcome: 'skipped',
          failure: 'failure_cache',
          status: 0,
          count: 0,
          accessDenied: false,
          forumRequestSent: false,
          cooldown: null,
          observedCooldowns: null
        };
      }
    }

    var origin = textForumOrigin(attachment.url);
    forumTurn = await getBackgroundForumTurn(origin, control.abortAt);
    if (forumTurn && forumTurn.wait) {
      reportTextForumCooldown(localBatch, forumTurn.wait);
      return {
        resources: SharedUtils.emptyResources(),
        outcome: 'skipped',
        failure: 'forum_cooldown',
        status: 0,
        count: 0,
        accessDenied: false,
        forumRequestSent: false,
        cooldown: localBatch.cooldown || forumTurn.wait,
        retryAfter: localBatch.retryAfter || 0,
        observedCooldowns: null
      };
    }

    if (control.controller.signal.aborted || Date.now() >= control.abortAt) {
      return {
        resources: SharedUtils.emptyResources(),
        outcome: 'skipped',
        failure: 'deadline',
        status: 0,
        count: 0,
        accessDenied: false,
        forumRequestSent: false,
        cooldown: null,
        observedCooldowns: null
      };
    }

    try {
      var fetchOptions = {
        signal: control.controller.signal,
        credentials: 'include',
        headers: { 'Accept': 'text/plain, application/octet-stream;q=0.9, */*;q=0.5' }
      };
      var safeReferrer = getSafeAttachmentReferrer(attachment);
      if (safeReferrer) {
        fetchOptions.referrer = safeReferrer;
        fetchOptions.referrerPolicy = 'strict-origin-when-cross-origin';
      }
      if (origin) localBatch.forumRequestSent = true;
      resp = await fetch(attachment.url, fetchOptions);
      diagnosticStatus = resp.status;
      var finalAttachmentUrl = resp.url || attachment.url;
      if (!textAttachmentAllowedInZone(finalAttachmentUrl, options.zone)) {
        diagnosticFailure = 'redirect_not_allowed';
        return {
          resources: SharedUtils.emptyResources(),
          outcome: diagnosticOutcome,
          failure: diagnosticFailure,
          status: diagnosticStatus,
          count: 0,
          accessDenied: false,
          forumRequestSent: !!localBatch.forumRequestSent,
          cooldown: null,
          observedCooldowns: null
        };
      }

      var finalOrigin = textForumOrigin(finalAttachmentUrl);
      if (finalOrigin) localBatch.forumRequestSent = true;
      if (finalOrigin && SharedUtils.isCloudflareChallengeResponse(resp)) {
        diagnosticFailure = 'forum_challenge';
        await noteTextForumCooldown(origin, finalOrigin, resp.headers, localBatch);
        return {
          resources: SharedUtils.emptyResources(),
          outcome: diagnosticOutcome,
          failure: diagnosticFailure,
          status: diagnosticStatus,
          count: 0,
          accessDenied: false,
          forumRequestSent: true,
          cooldown: localBatch.cooldown || null,
          retryAfter: localBatch.retryAfter || 0,
          observedCooldowns: localBatch.observedForumCooldowns || null
        };
      }
      if (!resp.ok) {
        var status = resp.status;
        diagnosticFailure = backgroundTextFailureClass(null, status);
        if (status === 401 || status === 403) {
          localOutcome.accessDenied = true;
          setTextFailCache(attachment.url, writeStartedAt);
          return {
            resources: SharedUtils.emptyResources(),
            outcome: diagnosticOutcome,
            failure: diagnosticFailure,
            status: diagnosticStatus,
            count: 0,
            accessDenied: true,
            forumRequestSent: !!localBatch.forumRequestSent,
            cooldown: null,
            observedCooldowns: null
          };
        }
        if ((status === 429 || status === 503) && finalOrigin) {
          await noteTextForumCooldown(origin, finalOrigin, resp.headers, localBatch);
        }
        return {
          resources: SharedUtils.emptyResources(),
          outcome: diagnosticOutcome,
          failure: diagnosticFailure,
          status: diagnosticStatus,
          count: 0,
          accessDenied: false,
          forumRequestSent: !!localBatch.forumRequestSent,
          cooldown: localBatch.cooldown || null,
          retryAfter: localBatch.retryAfter || 0,
          observedCooldowns: localBatch.observedForumCooldowns || null
        };
      }
      if (resp.redirected && /\/login|\/signin|\/member|\/register/.test(resp.url)) {
        diagnosticFailure = 'login_redirect';
        return {
          resources: SharedUtils.emptyResources(),
          outcome: diagnosticOutcome,
          failure: diagnosticFailure,
          status: diagnosticStatus,
          count: 0,
          accessDenied: false,
          forumRequestSent: !!localBatch.forumRequestSent,
          cooldown: null,
          observedCooldowns: null
        };
      }

      var len = parseInt(resp.headers.get('content-length') || '0', 10);
      if (len > TEXT_ATTACHMENT_MAX_BYTES) {
        diagnosticFailure = 'response_too_large';
        return {
          resources: SharedUtils.emptyResources(),
          outcome: diagnosticOutcome,
          failure: diagnosticFailure,
          status: diagnosticStatus,
          count: 0,
          accessDenied: false,
          forumRequestSent: !!localBatch.forumRequestSent,
          cooldown: null,
          observedCooldowns: null
        };
      }

      var contentType = resp.headers.get('content-type') || '';
      var buffer;
      try {
        buffer = await SharedUtils.readResponseArrayBufferLimited(resp, TEXT_ATTACHMENT_MAX_BYTES);
      } catch (readError) {
        if (readError && readError.name === 'ResponseTooLargeError') {
          diagnosticFailure = 'response_too_large';
          return {
            resources: SharedUtils.emptyResources(),
            outcome: diagnosticOutcome,
            failure: diagnosticFailure,
            status: diagnosticStatus,
            count: 0,
            accessDenied: false,
            forumRequestSent: !!localBatch.forumRequestSent,
            cooldown: null,
            observedCooldowns: null
          };
        }
        throw readError;
      }

      var text = SharedUtils.decodeTextBuffer(buffer, contentType);
      var htmlLike = SharedUtils.looksLikeHtmlDocument(text);
      if (finalOrigin && htmlLike && SharedUtils.isTextForumRefusal(text)) {
        diagnosticFailure = 'forum_challenge';
        await noteTextForumCooldown(origin, finalOrigin, resp.headers, localBatch);
        return {
          resources: SharedUtils.emptyResources(),
          outcome: diagnosticOutcome,
          failure: diagnosticFailure,
          status: diagnosticStatus,
          count: 0,
          accessDenied: false,
          forumRequestSent: true,
          cooldown: localBatch.cooldown || null,
          retryAfter: localBatch.retryAfter || 0,
          observedCooldowns: localBatch.observedForumCooldowns || null
        };
      }

      var unavailable = SharedUtils.isUnavailableTextDocument(text);
      finishBackgroundForumTurn(forumTurn, text && !unavailable && !htmlLike ? finalOrigin : '');
      forumTurn = null;
      var downloadLike = SharedUtils.looksLikeDownloadIntermediary(text);
      if ((htmlLike || downloadLike) && depth < 2) {
        var downloadUrls = SharedUtils.extractTextDownloadUrls(text, resp.url || attachment.url, TEXT_ATTACHMENT_MAX_COUNT);
        for (var d = 0; d < downloadUrls.length; d++) {
          if (!textAttachmentAllowedInZone(downloadUrls[d], options.zone) || downloadUrls[d] === attachment.url) continue;
          var subBatch = {};
          var redirectedResources = await fetchTextAttachmentResource({
            url: downloadUrls[d],
            name: attachment.name,
            source: 'txt-download-url',
            pageUrl: attachment.pageUrl || resp.url || attachment.url,
            diagnosticId: attachment.diagnosticId,
            diagnosticThreadId: attachment.diagnosticThreadId,
            diagnosticRunId: attachment.diagnosticRunId
          }, depth + 1, control.abortAt, Object.assign({}, options, { batch: subBatch, attachmentOutcome: null }));
          if (subBatch.forumRequestSent) localBatch.forumRequestSent = true;
          if (subBatch.cooldown) reportTextForumCooldown(localBatch, subBatch.cooldown, false);
          if (subBatch.observedForumCooldowns) {
            subBatch.observedForumCooldowns.forEach(function(cd) { reportTextForumCooldown(localBatch, cd, true); });
          }
          if (SharedUtils.hasResourcePayload(redirectedResources)) {
            setCachedTextResources(attachment.url, redirectedResources, writeStartedAt);
            clearTextFailCache(attachment.url);
            return {
              resources: redirectedResources,
              outcome: 'success',
              failure: '',
              status: diagnosticStatus,
              count: SharedUtils.countResources(redirectedResources),
              accessDenied: false,
              forumRequestSent: !!localBatch.forumRequestSent,
              cooldown: localBatch.cooldown || null,
              retryAfter: localBatch.retryAfter || 0,
              observedCooldowns: localBatch.observedForumCooldowns || null
            };
          }
        }
        diagnosticFailure = 'intermediary_unresolved';
      }

      if (!text || unavailable || htmlLike) {
        if (diagnosticFailure !== 'intermediary_unresolved') diagnosticFailure = 'unavailable_document';
        return {
          resources: SharedUtils.emptyResources(),
          outcome: diagnosticOutcome,
          failure: diagnosticFailure,
          status: diagnosticStatus,
          count: 0,
          accessDenied: false,
          forumRequestSent: !!localBatch.forumRequestSent,
          cooldown: localBatch.cooldown || null,
          retryAfter: localBatch.retryAfter || 0,
          observedCooldowns: localBatch.observedForumCooldowns || null
        };
      }

      // extractResources already normalizes resources once
      var extractedResources = SharedUtils.extractResources(text, resp.url || attachment.url, 'txt');
      var hasPayload = SharedUtils.hasResourcePayload(extractedResources);
      if (hasPayload) {
        setCachedTextResources(attachment.url, extractedResources, writeStartedAt);
        clearTextFailCache(attachment.url);
      }
      diagnosticResources = SharedUtils.countResources(extractedResources);
      diagnosticOutcome = hasPayload ? 'success' : 'empty';
      diagnosticFailure = hasPayload ? '' : 'no_resource_links';
      return {
        resources: extractedResources,
        outcome: diagnosticOutcome,
        failure: diagnosticFailure,
        status: diagnosticStatus,
        count: diagnosticResources,
        accessDenied: false,
        forumRequestSent: !!localBatch.forumRequestSent,
        cooldown: localBatch.cooldown || null,
        retryAfter: localBatch.retryAfter || 0,
        observedCooldowns: localBatch.observedForumCooldowns || null
      };
    } finally {
      if (resp && !resp.bodyUsed) control.controller.abort();
    }
  } catch (e) {
    diagnosticFailure = backgroundTextFailureClass(e);
    return {
      resources: SharedUtils.emptyResources(),
      outcome: diagnosticOutcome,
      failure: diagnosticFailure,
      status: diagnosticStatus,
      count: 0,
      accessDenied: false,
      forumRequestSent: !!localBatch.forumRequestSent,
      cooldown: localBatch.cooldown || null,
      retryAfter: localBatch.retryAfter || 0,
      observedCooldowns: localBatch.observedForumCooldowns || null
    };
  } finally {
    finishBackgroundForumTurn(forumTurn);
  }
}

async function fetchTextAttachmentResource(attachment, depth, deadline, options) {
  options = options || {};
  attachment = withBackgroundTextDiagnosticId(attachment);
  var startedAt = Date.now();
  var manualRetry = !!(options.manualRetry || options.force);
  depth = depth || 0;

  if (!attachment || !attachment.url || !textAttachmentAllowedInZone(attachment.url, options.zone)) {
    logBackgroundTextDiagnostic(attachment, 'skipped', 'url_not_allowed', deadline,
      { status: 0, resources: 0, elapsedMs: Date.now() - startedAt, depth: depth });
    return SharedUtils.emptyResources();
  }

  var fetchTimeout = getDeadlineFetchTimeout(deadline, TEXT_ATTACHMENT_TIMEOUT);
  if (fetchTimeout <= 0) {
    logBackgroundTextDiagnostic(attachment, 'skipped', 'deadline', deadline,
      { status: 0, resources: 0, elapsedMs: Date.now() - startedAt, depth: depth });
    return SharedUtils.emptyResources();
  }

  var inflightKey = getTextFetchInflightKey(attachment.url, options.zone, manualRetry, depth);
  var existing = inflightKey ? TEXT_FETCH_IN_FLIGHT.get(inflightKey) : null;
  var sharedPromise;

  if (existing && !existing.control.controller.signal.aborted) {
    extendTextFetchControl(existing.control, deadline);
    sharedPromise = existing.promise;
  } else {
    var control = createTextFetchControl(deadline);
    sharedPromise = executeSingleTextAttachmentFetch(attachment, depth, deadline, options, control);
    var entry = { promise: sharedPromise, control: control };
    if (inflightKey) TEXT_FETCH_IN_FLIGHT.set(inflightKey, entry);
    var cleanup = function() {
      clearTextFetchControl(control);
      if (inflightKey && TEXT_FETCH_IN_FLIGHT.get(inflightKey) === entry) {
        TEXT_FETCH_IN_FLIGHT.delete(inflightKey);
      }
    };
    sharedPromise.then(cleanup, cleanup);
  }

  var res = await waitForTextFetchDeadline(sharedPromise, deadline);
  if (res.accessDenied && options.attachmentOutcome) {
    options.attachmentOutcome.accessDenied = true;
  }
  if (options.batch) {
    if (res.forumRequestSent) options.batch.forumRequestSent = true;
    if (res.cooldown) reportTextForumCooldown(options.batch, res.cooldown, false);
    if (res.observedCooldowns) {
      res.observedCooldowns.forEach(function(cd) {
        reportTextForumCooldown(options.batch, cd, true);
      });
    }
  }
  logBackgroundTextDiagnostic(attachment, res.outcome, res.failure, deadline,
    { status: res.status, resources: res.count, elapsedMs: Date.now() - startedAt, depth: depth });
  return res.resources;
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
  var merged = SharedUtils.emptyResources();
  var unresolvedCount = 0;
  var accessDeniedCount = 0;
  var batch = {};
  var resolvedIndexes = [];
  await restoreTextForumCooldowns();
  for (var i = 0; i < attachments.length; i++) {
    var attachmentOutcome = { accessDenied: false };
    var result = await fetchTextAttachmentResource(attachments[i], 0, deadline,
      Object.assign({}, options, { attachmentOutcome: attachmentOutcome, batch: batch }));
    if (SharedUtils.hasResourcePayload(result)) {
      merged = SharedUtils.mergeResources(merged, result);
      resolvedIndexes.push(i);
    } else {
      unresolvedCount++;
      if (attachmentOutcome.accessDenied) accessDeniedCount++;
    }
  }
  var status = makeTextResourceFetchStatus(merged, attachments.length, unresolvedCount, unresolvedCount, accessDeniedCount);
  status.resolvedIndexes = resolvedIndexes;
  if (batch.cooldown) status.forumCooldown = Object.assign({}, batch.cooldown, {
    retryAfter: batch.retryAfter,
    deferredWithoutRequest: !batch.forumRequestSent
  });
  if (batch.observedForumCooldowns) status.observedForumCooldowns = Array.from(batch.observedForumCooldowns.values());
  return status;
}

function normalizeImageExtractionSettings(input) {
  input = input || {};
  var fetchLimit = input.maxImagesPerPost || input.maxImages || 100;
  var displayLimit = input.maxDisplayPerPost || input.displayImages || fetchLimit;
  return {
    maxImagesPerPost: fetchLimit,
    maxDisplayPerPost: displayLimit,
    heavyImageOptimization: input.heavyImageOptimization !== false,
    freshTextLinks: input.freshTextLinks === true,
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
    imageSettings.heavyImageOptimization ? 1 : 0,
    imageSettings.freshTextLinks ? 1 : 0
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
    textAttachmentHints: SharedUtils.getTextAttachmentHints(rawAttachments),
    hasTextAttachments: hasTextAttachments,
    textAttachmentCount: hasTextAttachments ? (markerCount || 1) : 0
  };
}

function makeBackgroundArticleResponse(item) {
  item = item || {};
  var images = item.images || [];
  var resources = item._resourcesNormalized ? item.resources : SharedUtils.normalizeResources(item.resources);
  var textState = normalizeBackgroundTextAttachments(item);
  return {
    images: images,
    resources: resources,
    textAttachments: textState.textAttachments,
    textAttachmentHints: textState.textAttachmentHints,
    hasTextAttachments: textState.hasTextAttachments,
    textAttachmentCount: textState.textAttachmentCount,
    textAttachmentsLimited: item.textAttachmentsLimited === true,
    textResourcesComplete: item.textResourcesComplete === true,
    textResourcesAttemptedCount: Math.max(0, Number(item.textResourcesAttemptedCount || 0) || 0),
    textResourcesUnresolvedCount: Math.max(0, Number(item.textResourcesUnresolvedCount || 0) || 0),
    textResourcesRetryableCount: Math.max(0, Number(item.textResourcesRetryableCount || 0) || 0),
    imageExtractionVersion: item.imageExtractionVersion || 0,
    partial: !!item.partial,
    retryableEmpty: !!item.retryableEmpty,
    emptyReason: item.emptyReason || item.reason || '',
    reason: item.reason || '',
    forumOrigin: item.forumOrigin || '',
    retryAfter: Math.max(0, Number(item.retryAfter || 0) || 0)
  };
}

function hasBackgroundArticlePayload(response) {
  if (!response) return false;
  return (Array.isArray(response.images) && response.images.length > 0) ||
    SharedUtils.hasResourcePayload(response.resources) ||
    (Array.isArray(response.textAttachments) && response.textAttachments.length > 0) ||
    response.hasTextAttachments === true;
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
      resolve(getRemainingDeadlineMs(deadline) > 0 ? result : makeDeadlineArticleResult());
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
  var promise = fetchArticleForOrigin(url, imageSettings, deadline, control);
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

async function fetchArticleForOrigin(url, imageSettings, deadline, control) {
  await restoreTextForumCooldowns();
  var origin = textForumOrigin(url);
  var turn = await getBackgroundForumTurn(origin, control ? control.abortAt : deadline);
  if (turn && turn.wait) {
    return { ok: false, reason: 'forum_cooldown', images: [], retryableEmpty: true, retryAfter: turn.wait.until };
  }
  var item;
  try {
    item = await fetchArticle(url, imageSettings, deadline, control);
    if (item && SharedUtils.isForumFloodReason(item.reason)) {
      await noteBackgroundForumCooldown(origin, item.forumOrigin || origin, item.retryAfter);
    }
    return item;
  } finally {
    finishBackgroundForumTurn(turn, item && item.ok ? item.forumOrigin : '');
  }
}

async function fetchArticle(url, imageSettings, deadline, control) {
  imageSettings = normalizeImageExtractionSettings(imageSettings);
  try {
    var ownsControl = !control;
    control = control || createArticleFetchControl(deadline, imageSettings);
    if (control.controller.signal.aborted) return makeDeadlineArticleResult();
    var resp = null;
    try {
      resp = await fetch(url, {
        signal: control.controller.signal,
        credentials: 'include',
        cache: imageSettings.freshTextLinks ? 'no-store' : 'default',
        headers: { 'Accept': 'text/html' }
      });
      var finalUrl = resp.url || url;
      if (!originAllowed(finalUrl) || !SharedUtils.isSameForumZoneUrl(finalUrl, url)) {
        BGLOG.warn('文章重定向已拒绝', shortUrl(finalUrl));
        return { ok: false, reason: 'redirect_disallowed', images: [], retryableEmpty: false };
      }
      if (SharedUtils.isCloudflareChallengeResponse(resp)) {
        BGLOG.warn('文章返回 Cloudflare 验证', 'HTTP' + resp.status + ' ' + shortUrl(url));
        return {
          ok: false, reason: 'cloudflare', images: [], retryableEmpty: true,
          retryAfter: SharedUtils.parseRetryAfterHeader(resp.headers), forumOrigin: new URL(finalUrl).origin
        };
      }
      if (!resp.ok) {
        var retryableHttp = resp.status === 401 || resp.status === 403 || resp.status === 429 || (resp.status >= 500 && resp.status <= 599);
        var retryAfter = retryableHttp ? SharedUtils.parseRetryAfterHeader(resp.headers) : 0;
        return {
          ok: false, reason: 'http_' + resp.status, images: [], retryableEmpty: retryableHttp,
          retryAfter: retryAfter, forumOrigin: new URL(finalUrl).origin
        };
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
      if (blocked) return { ok: false, reason: blocked, images: [], retryableEmpty: true, forumOrigin: new URL(finalUrl).origin };
      if (Date.now() >= control.abortAt) return makeDeadlineArticleResult();

      // Single-pass stripped HTML + tag tables shared across all 3 extractors
      var extractionContext = SharedUtils.prepareArticleExtractionContext(html);
      var textAttachments = SharedUtils.extractTextAttachments(html, finalUrl, TEXT_ATTACHMENT_MAX_COUNT, extractionContext);
      var resources = SharedUtils.emptyResources();
      var imageResult = { images: [], partial: false };
      if (!imageSettings.freshTextLinks) {
        if (Date.now() < control.abortAt) resources = SharedUtils.extractResources(html, finalUrl, 'html', extractionContext);
        var parseSliceMs = 12;
        imageResult = await SharedUtils.extractImagesForSettingsInSlices(html, finalUrl, imageSettings, {
          clock: function() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); },
          deadline: function() { return control.abortAt - 2 * parseSliceMs; },
          sliceMs: parseSliceMs,
          yieldSlice: function() { return new Promise(function(resolve) { setTimeout(resolve, 0); }); }
        }, extractionContext);
      }
      var images = imageResult.images;
      if (!imageResult.partial && !images.length && !SharedUtils.hasResourcePayload(resources) && !textAttachments.length) {
        var emptyPage = SharedUtils.classifyEmptyArticlePage(html);
        if (emptyPage && emptyPage.retryable) {
          BGLOG.warn('正文返回非帖子页', emptyPage.reason + ' title="' + SharedUtils.getHtmlPageTitle(html) + '" ' + html.length + '字符 ' + shortUrl(url));
          return { ok: false, reason: emptyPage.reason, images: [], retryableEmpty: true, forumOrigin: new URL(finalUrl).origin };
        }
      }
      return {
        ok: true,
        forumOrigin: new URL(finalUrl).origin,
        images: images,
        resources: resources,
        _resourcesNormalized: true,
        textAttachments: textAttachments,
        textAttachmentsLimited: !!textAttachments.limited,
        imageExtractionVersion: imageSettings.freshTextLinks ? 0 : SharedUtils.ARTICLE_IMAGE_EXTRACTION_VERSION,
        partial: htmlTruncated || imageResult.partial
      };
    } finally {
      if (ownsControl) clearArticleFetchControl(control);
      if (resp && !resp.bodyUsed) control.controller.abort();
    }
  } catch (e) {
    var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    var retryableError = offline || e.name === 'AbortError' || e.name === 'TypeError';
    var reason = offline ? 'offline' : e.name === 'AbortError' && deadline ? 'deadline_exhausted' : e.message;
    if (e.name === 'AbortError') {
      BGLOG.debug('抓取中止', shortUrl(url) + ' ' + reason);
    } else {
      BGLOG.error('异常', shortUrl(url) + ' ' + e.message);
    }
    return { ok: false, reason: reason, images: [], retryableEmpty: retryableError };
  }
}

// ---- Cache Index & Article Cache Mutation Messages ----
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

function handleCacheIndexMutationMessage(msg, sender, sendResponse) {
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
    var flushImm = !!msg.flushImmediate || isOwnExtensionPageSender(sender);
    SharedUtils.cacheIndex.removeEntries(keys, function(success) {
      sendResponse({ ok: success === true });
    }, flushImm);
    return;
  }
  if (action === 'rebuild') {
    SharedUtils.cacheIndex.rebuild(function(entries) {
      sendResponse({ ok: !!entries, entries: entries || null });
    });
    return;
  }
  if (action === 'flush') {
    SharedUtils.cacheIndex.flushNow(function(ok, entries) {
      sendResponse({ ok: !!ok, entries: entries || null });
    });
    return;
  }
  sendResponse({ ok: false });
}

var articleWriteQueues = new Map();

function clearNegativeCacheForNormalizedUrl(normalizedUrl, done) {
  var key = SharedUtils.CACHE_PREFIXES.NEGATIVE + normalizedUrl;
  chrome.storage.local.remove(key, function() {
    if (consumeStorageError('负缓存清理失败')) { done(false); return; }
    removeCacheIndexEntriesAfterStorageRemove([key], '负缓存索引清理', function(ok) {
      done(!!ok);
    });
  });
}

function enqueueArticleCacheMutation(normalizedUrl, mutation) {
  var key = SharedUtils.CACHE_PREFIXES.ARTICLE + normalizedUrl;
  var previous = articleWriteQueues.get(key) || Promise.resolve();
  var next = previous.then(async function() {
    if (!settingsLoaded) {
      try { await settingsReady; } catch (e) {}
    }
    return new Promise(function(resolve, reject) {
      chrome.storage.local.get(key, function(result) {
        if (consumeStorageError('文章缓存读取失败')) { resolve(false); return; }
        try {
          var entry = ATPArticleCacheData.applyMutation(result[key], mutation, bgCacheTtlMs, Date.now());
          if (!entry) { resolve(mutation.operation === 'textProgress' ? 'articleMissing' : false); return; }
          if (entry === result[key]) { resolve(true); return; }
          var batch = {};
          batch[key] = entry;
          setStorageWithEviction(batch, '文章缓存写入失败', function(success) {
            if (!success || mutation.operation === 'loadedUrls') { resolve(success); return; }
            clearNegativeCacheForNormalizedUrl(normalizedUrl, resolve);
          }, mutation.writeStartedAt);
        } catch (e) { reject(e); }
      });
    });
  }).catch(function(error) {
    BGLOG.warn('文章缓存写入失败', error.message);
    return false;
  });
  articleWriteQueues.set(key, next);
  next.then(function() { if (articleWriteQueues.get(key) === next) articleWriteQueues.delete(key); });
  return next;
}

function handleArticleCacheMutation(msg, sender) {
  if (!forumUrlAllowedInZone(msg.url, getSenderForumZone(sender)) ||
      !Number.isFinite(msg.writeStartedAt) || msg.writeStartedAt <= 0 ||
      ['article', 'preview', 'text', 'textProgress', 'loadedUrls'].indexOf(msg.operation) < 0 ||
      (msg.operation === 'loadedUrls' ? !Array.isArray(msg.loadedUrls) : !msg.data || typeof msg.data !== 'object')) {
    return Promise.resolve(false);
  }
  var normalizedUrl = SharedUtils.normalizeArticleUrl(msg.url);
  return enqueueArticleCacheMutation(normalizedUrl, msg);
}

function persistFetchedArticleToCache(url, response, writeStartedAt) {
  var normalizedUrl = SharedUtils.normalizeArticleUrl(url);
  if (!normalizedUrl) return Promise.resolve(false);
  return enqueueArticleCacheMutation(normalizedUrl, {
    url: normalizedUrl,
    operation: 'article',
    data: response,
    complete: !response.partial,
    writeStartedAt: writeStartedAt
  }).then(function(res) {
    return res === true;
  });
}

// ---- Runtime Message Router (with Cold-Wake Fast Path for Built-in Hosts) ----
var MIRROR_GATED_MESSAGE_TYPES = {};
MIRROR_GATED_MESSAGE_TYPES[SharedUtils.MESSAGE_TYPES.ARTICLE_CACHE_MUTATION] = true;
MIRROR_GATED_MESSAGE_TYPES[SharedUtils.MESSAGE_TYPES.FETCH_IMAGES] = true;
MIRROR_GATED_MESSAGE_TYPES[SharedUtils.MESSAGE_TYPES.FETCH_TEXT_ATTACHMENTS_FRESH] = true;
MIRROR_GATED_MESSAGE_TYPES[SharedUtils.MESSAGE_TYPES.FETCH_TEXT_RESOURCES] = true;
MIRROR_GATED_MESSAGE_TYPES[SharedUtils.MESSAGE_TYPES.GET_FLOATING_PANEL_CSS] = true;
MIRROR_GATED_MESSAGE_TYPES[SharedUtils.MESSAGE_TYPES.MARKS_MUTATION] = true;
MIRROR_GATED_MESSAGE_TYPES[SharedUtils.MESSAGE_TYPES.REPORT_FORUM_PACER_STATUS] = true;

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object') return false;
  // Built-in forum hosts bypass mirrorSitesReady so cold wakes start immediately!
  if (!mirrorSitesLoaded && MIRROR_GATED_MESSAGE_TYPES[msg.type] === true && !isBuiltinForumSender(sender)) {
    mirrorSitesReady.then(function() {
      handleRuntimeMessage(msg, sender, sendResponse);
    });
    return true;
  }
  return handleRuntimeMessage(msg, sender, sendResponse);
});

function handleClearCacheMessage(msg, sender, sendResponse) {
  if (!isOwnExtensionPageSender(sender)) {
    sendResponse({ ok: false, error: 'not_allowed' });
    return;
  }
  var generationKey = SharedUtils.CACHE_GENERATION_KEY || 'atp_cache_generation_v1';
  var keys = Array.isArray(msg.keys) ? sanitizeCacheIndexRemoveKeys(msg.keys) : null;
  var nextGen = Date.now();
  ATPCache._rememberCacheGeneration(nextGen);
  ATPCache.clearMemoryCache();

  var genObj = {};
  genObj[generationKey] = nextGen;
  chrome.storage.local.set(genObj, function() {
    if (consumeStorageError('标记缓存清理代际失败')) {
      sendResponse({ ok: false });
      return;
    }
    if (keys && keys.length) {
      chrome.storage.local.remove(keys, function() {
        if (consumeStorageError('清除缓存失败')) {
          sendResponse({ ok: false });
          return;
        }
        SharedUtils.cacheIndex.removeEntries(keys, function(ok) {
          sendResponse({ ok: !!ok, removed: keys.length });
        }, true);
      });
      return;
    }
    if (msg.clearAll === true) {
      SharedUtils.cacheIndex.clearMemory();
      SharedUtils.cacheIndex._writeNow({}, function(ok) {
        sendResponse({ ok: !!ok, removed: 0 });
      });
      return;
    }
    SharedUtils.cacheIndex.flushNow(function(ok) {
      sendResponse({ ok: !!ok, removed: 0 });
    });
  });
}

function handleRuntimeMessage(msg, sender, sendResponse) {
  if (msg.type === SharedUtils.MESSAGE_TYPES.REPORT_FORUM_PACER_STATUS) {
    if (!getSenderForumZone(sender) || !msg.entry || !Number.isFinite(msg.entry.at)) {
      sendResponse({ ok: false });
      return false;
    }
    var pacerSender = new URL(sender.url);
    Promise.all([
      recordForumPacerStatus(pacerSender.hostname, msg.entry, Number(msg.resetMarker) || 0),
      noteReportedForumRetryAfter(pacerSender.origin, msg.entry)
    ]).then(function() {
      sendResponse({ ok: true });
    }, function(error) {
      BGLOG.warn('保存论坛节流显示失败', error.message);
      sendResponse({ ok: false });
    });
    return true;
  }
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
  if (msg.type === SharedUtils.MESSAGE_TYPES.MARKS_MUTATION) {
    handleMarksMutation(msg, sender).then(function(result) {
      sendResponse(result);
    }, function(e) {
      var code = e && e.code ? e.code : 'failed';
      if (!e || !e.code) BGLOG.warn('标记资源保存失败', e && e.message ? e.message : String(e));
      sendResponse({ ok: false, error: code });
    });
    return true;
  }
  if (msg.type === SharedUtils.MESSAGE_TYPES.GET_CACHE_INDEX) {
    SharedUtils.cacheIndex.flushNow(function(ok, entries) {
      sendResponse({ ok: !!ok, entries: entries || null });
    });
    return true;
  }
  if (msg.type === SharedUtils.MESSAGE_TYPES.CLEAR_CACHE) {
    handleClearCacheMessage(msg, sender, sendResponse);
    return true;
  }
  if (msg.type === SharedUtils.MESSAGE_TYPES.CACHE_INDEX_MUTATION) {
    handleCacheIndexMutationMessage(msg, sender, sendResponse);
    return true;
  }
  if (msg.type === SharedUtils.MESSAGE_TYPES.ARTICLE_CACHE_MUTATION) {
    handleArticleCacheMutation(msg, sender).then(function(result) {
      sendResponse({ ok: result === true, articleMissing: result === 'articleMissing' });
    });
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
      freshTextLinks: true,
      articleTimeout: msg.articleTimeout
    }, freshDeadline).then(function(item) {
      if (!item || !item.ok) {
        sendResponse({
          ok: false, textAttachments: [], reason: item && (item.reason || item.emptyReason) || '',
          forumOrigin: item && item.forumOrigin || '',
          retryAfter: item && Number.isFinite(item.retryAfter) ? item.retryAfter : 0
        });
        return;
      }
      sendResponse({
        ok: true,
        forumOrigin: item.forumOrigin || '',
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
    var sourceIndexes = [];
    var seenAttachments = {};
    for (var ai = 0; ai < sourceAttachments.length && ai < maxSourceAttachments && attachments.length < TEXT_ATTACHMENT_MAX_COUNT; ai++) {
      var attachment = sourceAttachments[ai];
      if (!attachment || !attachment.url || !textAttachmentAllowedInZone(attachment.url, textSenderZone)) continue;
      var attachmentKey = SharedUtils.normalizeTextAttachmentUrl(attachment.url);
      if (!attachmentKey || seenAttachments[attachmentKey]) continue;
      seenAttachments[attachmentKey] = true;
      attachments.push(attachment);
      sourceIndexes.push(ai);
    }
    var textDeadline = Number(msg.deadline) || (Date.now() + SharedUtils.getTextAttachmentBackgroundTimeout(attachments.length));
    var manualRetry = !!msg.manualRetry;
    enqueueTextResourceMessage(attachments, textDeadline, {
      manualRetry: manualRetry,
      owner: sender && sender.tab && sender.tab.id,
      zone: textSenderZone
    }).then(function(status) {
      sendResponse({
        resources: status.resources,
        attemptedCount: status.attemptedCount,
        unresolvedCount: status.unresolvedCount,
        retryableCount: status.retryableCount,
        accessDeniedCount: status.accessDeniedCount || 0,
        queueStatus: status.queueStatus || 'completed',
        resolvedIndexes: (status.resolvedIndexes || []).map(function(index) { return sourceIndexes[index]; }),
        forumCooldown: status.forumCooldown || null,
        observedForumCooldowns: status.observedForumCooldowns || []
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
  var persistTasks = [];
  var nextIndex = 0;
  var okCount = 0;
  var retryableCount = 0;
  var partialCount = 0;
  var imageTotal = 0;
  var resourceTotal = 0;
  var textAttachmentTotal = 0;
  var configuredWorkers = imageSettings && imageSettings.articleFetchConcurrency !== undefined
    ? ATPLoadPolicy.getArticleFetchConcurrency(imageSettings)
    : 3;
  var workerCount = Math.min(urls.length, configuredWorkers);

  async function worker() {
    while (true) {
      var index = nextIndex++;
      if (index >= urls.length) return;
      var url = urls[index];
      var fetchStartedAt = Date.now();
      var item;
      if (getRemainingDeadlineMs(deadline) <= 0) {
        item = makeDeadlineArticleResult();
      } else {
        item = await fetchArticleWithInflight(url, imageSettings, deadline);
      }
      item = item || {};
      var response = makeBackgroundArticleResponse(item);
      if (item.ok) okCount++;
      if (item.retryableEmpty) retryableCount++;
      if (item.partial) partialCount++;
      imageTotal += response.images.length;
      resourceTotal += SharedUtils.countResources(response.resources);
      textAttachmentTotal += (item.textAttachments || []).length;

      // Persist directly to article_cache_v13_* without blocking worker pool refill,
      // eliminating ping-pong ARTICLE_CACHE_MUTATION IPC from content.js!
      if (item.ok && !imageSettings.freshTextLinks && hasBackgroundArticlePayload(response)) {
        response.cachedByBackground = true;
        persistTasks.push((function(targetUrl, targetResp, startedAt) {
          return persistFetchedArticleToCache(targetUrl, targetResp, startedAt).then(function(saved) {
            if (!saved) targetResp.cachedByBackground = false;
          });
        })(url, response, fetchStartedAt));
      }
      results[url] = response;
    }
  }

  var workers = new Array(workerCount);
  for (var i = 0; i < workerCount; i++) workers[i] = worker();
  await Promise.all(workers);
  if (persistTasks.length) await Promise.all(persistTasks);
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
              if (ok) BGLOG.debug('onInstalled', '清理旧缓存' + keysToRemove.length + '条');
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
