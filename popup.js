(function () {
  'use strict';

  var els = {};
  (function() {
    var ids = ['toggleEnabled','settingsContainer',
      'clearImageCache','clearFailCache','clearAllCache','clearTestCache','resetSettings',
      'toggleLogs','logPanel','logViewer','logCount','logFilter','logSearch','exportLogs','clearLogs',
      'currentSite','firstScreenInfo','popupStatus','toggleHelp','helpPanel'];
    for (var i = 0; i < ids.length; i++) { els[ids[i]] = document.getElementById(ids[i]); }
  })();

  var DEFAULTS = ATP_DEFAULTS;
  var LOG_KEYS = ['atp_logs', 'atp_logs_content', 'atp_logs_bg'];
  var LOG_KEY_PREFIXES = ['atp_logs_content_'];
  var LOG_KEY_INDEX = (typeof SharedUtils !== 'undefined' && SharedUtils.CONTENT_LOG_INDEX_KEY) || 'atp_logs_content_keys';
  var LOG_CLEARED_AT_KEY = 'atp_logs_cleared_at';
  var CACHE_GENERATION_KEY = (typeof SharedUtils !== 'undefined' && SharedUtils.CACHE_GENERATION_KEY) || 'atp_cache_generation_v1';
  var MAX_CONTENT_LOG_KEYS = (typeof SharedUtils !== 'undefined' && SharedUtils.MAX_CONTENT_LOG_KEYS) || 20;
  var LOG_VIEW_LIMIT = 1000;
  var LOG_RENDER_LIMIT = 150;
  var LOG_SEARCH_DEBOUNCE_MS = 180;
  var logReloadTimer = null;
  var logLoadSeq = 0;
  var logCountSeq = 0;
  var loadedLogEntries = null;
  var logLoadInFlight = false;
  var popupStatusTimer = null;
  var saveStatusSeq = 0;
  var saveWriteChain = Promise.resolve();
  var settingSaveSeqByKey = {};
  var siteSaveSeqByHost = {};
  var dirtySettingInputByKey = {};
  var settingsLoadFailed = false;
  var DESTRUCTIVE_CONFIRM_MS = 3000;
  var pendingDestructiveButton = null;
  var CACHE_PREFIXES = (typeof SharedUtils !== 'undefined' && SharedUtils.CACHE_PREFIXES) || { IMAGE: 'thumb_cache_v2_', ARTICLE: 'article_cache_v9_', TEXT_RESOURCE: 'txt_resource_cache_v2_', TEXT_FAIL: 'atp_text_fail_v1_', NEGATIVE: 'atp_empty_v8_', IMAGE_BASE: 'thumb_cache_', ARTICLE_BASE: 'article_cache_', TEXT_RESOURCE_BASE: 'txt_resource_cache_', TEXT_FAIL_BASE: 'atp_text_fail_', NEGATIVE_BASE: 'atp_empty_' };
  var HEAVY_ORIGINAL_PRESET = ATPGetSettingsPreset('heavyOriginal', SETTINGS_SCHEMA);

  var settings = null;
  var currentSiteHost = '';

  function errorMessage(e) {
    return e && e.message ? e.message : String(e || '未知错误');
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

  function formatLocalFilenameTimestamp(date) {
    date = date || new Date();
    return date.getFullYear() + '-' +
      padNumber(date.getMonth() + 1, 2) + '-' +
      padNumber(date.getDate(), 2) + 'T' +
      padNumber(date.getHours(), 2) + '-' +
      padNumber(date.getMinutes(), 2) + '-' +
      padNumber(date.getSeconds(), 2);
  }

  function formatTimezoneOffset(minutes) {
    if (typeof minutes !== 'number' || isNaN(minutes)) return '';
    var sign = minutes >= 0 ? '+' : '-';
    var abs = Math.abs(minutes);
    return sign + padNumber(Math.floor(abs / 60), 2) + ':' + padNumber(abs % 60, 2);
  }

  function getTimezoneName() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      return '';
    }
  }

  function parseLogTimestamp(value) {
    if (!value) return 0;
    var text = String(value);
    var m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
    var hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    if (m && !hasTimezone) {
      var milliseconds = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
      return new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
        milliseconds
      ).getTime();
    }
    var parsed = Date.parse(text);
    return isNaN(parsed) ? 0 : parsed;
  }

  function getLogSortTimestamp(entry) {
    return parseLogTimestamp(entry && (entry.tsUtc || entry.ts));
  }

  function warnStorage(action, e) {
    console.warn('[popup] ' + action + '失败:', errorMessage(e));
  }

  async function storageGet(keys, action) {
    try {
      return await chrome.storage.local.get(keys);
    } catch (e) {
      warnStorage(action || '读取 storage', e);
      throw e;
    }
  }

  async function storageGetKeys(action) {
    var area = chrome && chrome.storage && chrome.storage.local;
    if (area && typeof area.getKeys === 'function') {
      try {
        return await area.getKeys();
      } catch (e) {
        warnStorage(action || '读取 storage 键', e);
      }
    }
    var all = await storageGet(null, action || '读取 storage 键');
    var keys = [];
    all = all || {};
    for (var key in all) {
      if (Object.prototype.hasOwnProperty.call(all, key)) keys.push(key);
    }
    return keys;
  }

  async function storageSet(items, action) {
    try {
      await chrome.storage.local.set(items);
    } catch (e) {
      warnStorage(action || '写入 storage', e);
      throw e;
    }
  }

  async function storageRemove(keys, action) {
    try {
      await chrome.storage.local.remove(keys);
    } catch (e) {
      warnStorage(action || '删除 storage', e);
      throw e;
    }
  }

  function clearButtonTextTimer(btn) {
    if (!btn) return;
    if (btn.__atpTextRestoreTimer) {
      clearTimeout(btn.__atpTextRestoreTimer);
      btn.__atpTextRestoreTimer = null;
    }
  }

  function setButtonTextLater(btn, text, delay) {
    if (!btn) return;
    clearButtonTextTimer(btn);
    btn.__atpTextRestoreTimer = setTimeout(function() {
      btn.__atpTextRestoreTimer = null;
      btn.textContent = text;
    }, delay || 1500);
  }

  function setButtonBusy(btn, busy) {
    if (!btn) return;
    btn.__atpBusy = !!busy;
    if (busy) {
      btn.setAttribute('aria-disabled', 'true');
    } else {
      btn.removeAttribute('aria-disabled');
    }
  }

  function setPopupStatus(text, type, persist) {
    if (!els.popupStatus) return;
    if (popupStatusTimer) {
      clearTimeout(popupStatusTimer);
      popupStatusTimer = null;
    }
    if (!text) {
      els.popupStatus.textContent = '';
      els.popupStatus.className = 'popup-status popup-status-empty';
      els.popupStatus.setAttribute('role', 'status');
      els.popupStatus.setAttribute('aria-live', 'polite');
      return;
    }
    els.popupStatus.setAttribute('role', type === 'err' ? 'alert' : 'status');
    els.popupStatus.setAttribute('aria-live', type === 'err' ? 'assertive' : 'polite');
    els.popupStatus.textContent = text;
    els.popupStatus.className = 'popup-status popup-status-' + (type || 'info');
    if (!persist) {
      popupStatusTimer = setTimeout(function() {
        setPopupStatus('');
      }, 1800);
    }
  }

  function clearPopupStatusIfText(text) {
    if (els.popupStatus && els.popupStatus.textContent === text) setPopupStatus('');
  }

  function setDisclosureState(button, panel, expanded) {
    var shouldRestoreFocus = !!(
      !expanded &&
      button &&
      panel &&
      document.activeElement &&
      panel.contains &&
      panel.contains(document.activeElement) &&
      typeof button.focus === 'function'
    );
    if (button) {
      button.textContent = expanded ? '收起' : '展开';
      button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      var controls = button.getAttribute('aria-controls');
      var labelTarget = controls === 'helpPanel' ? '使用说明' : (controls === 'logPanel' ? '诊断日志' : '');
      if (labelTarget) {
        button.setAttribute('aria-label', (expanded ? '收起' : '展开') + labelTarget);
      }
    }
    if (panel) {
      panel.classList.toggle('hidden', !expanded);
      panel.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    }
    if (shouldRestoreFocus) button.focus();
  }

  function setLogViewerBusy(busy, text) {
    if (!els.logViewer) return;
    els.logViewer.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (text) {
      els.logViewer.innerHTML = '<div class="log-entry" style="color:#808080">' + esc(text) + '</div>';
    }
  }

  function clearInputError(el) {
    if (!el || typeof el.removeAttribute !== 'function') return;
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
  }

  function reportNumberInputError(el, item) {
    if (!el || !item) return;
    el.setAttribute('aria-invalid', 'true');
    el.setAttribute('aria-describedby', 'popupStatus');
    var range = item.min !== undefined && item.max !== undefined
      ? item.min + '-' + item.max
      : '有效';
    setPopupStatus('请输入' + item.label + '的' + range + '范围内数值', 'err', true);
    flashError(el);
  }

  function ensureSettingsReady(el) {
    if (settings && !settingsLoadFailed) return true;
    setPopupStatus('设置仍在读取，请稍后再试', 'err', true);
    if (el) flashError(el);
    return false;
  }

  function clearDestructiveConfirm(btn, restoreText) {
    if (!btn || !btn.__atpConfirmArmed) return;
    if (btn.__atpConfirmTimer) {
      clearTimeout(btn.__atpConfirmTimer);
      btn.__atpConfirmTimer = null;
    }
    btn.__atpConfirmArmed = false;
    btn.removeAttribute('data-confirming');
    btn.removeAttribute('aria-describedby');
    if (restoreText !== false) btn.textContent = btn.__atpConfirmRestoreText || btn.textContent;
    btn.__atpConfirmRestoreText = null;
    if (pendingDestructiveButton === btn) pendingDestructiveButton = null;
  }

  function clearPendingDestructiveConfirm(exceptBtn) {
    if (pendingDestructiveButton && pendingDestructiveButton !== exceptBtn) {
      clearDestructiveConfirm(pendingDestructiveButton, true);
    }
  }

  function armDestructiveConfirm(btn, confirmText, statusText, restoreText) {
    if (!btn) return true;
    if (btn.__atpBusy) return false;
    var resolvedStatusText = statusText || '再次点击确认此操作';
    if (btn.__atpConfirmArmed) {
      clearDestructiveConfirm(btn, false);
      return true;
    }
    clearPendingDestructiveConfirm(btn);
    clearButtonTextTimer(btn);
    btn.__atpConfirmArmed = true;
    btn.__atpConfirmRestoreText = restoreText || btn.textContent || '';
    btn.setAttribute('data-confirming', 'true');
    btn.setAttribute('aria-describedby', 'popupStatus');
    btn.textContent = confirmText || '再次点击确认';
    setPopupStatus(resolvedStatusText, 'warn', true);
    pendingDestructiveButton = btn;
    btn.__atpConfirmTimer = setTimeout(function() {
      var shouldClearStatus = els.popupStatus && els.popupStatus.textContent === resolvedStatusText;
      clearDestructiveConfirm(btn, true);
      if (shouldClearStatus) setPopupStatus('');
    }, DESTRUCTIVE_CONFIRM_MS);
    return false;
  }

  function handlePopupKeydown(e) {
    if (!pendingDestructiveButton || !e || e.key !== 'Escape') return;
    clearDestructiveConfirm(pendingDestructiveButton, true);
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    setPopupStatus('已取消确认', 'info', false);
  }

  document.addEventListener('keydown', handlePopupKeydown);

  async function runButtonAction(btn, workingText, successText, restoreText, action) {
    if (btn && btn.__atpBusy) return null;
    var originalText = restoreText || (btn && btn.textContent) || '';
    if (btn) {
      clearButtonTextTimer(btn);
      setButtonBusy(btn, true);
      if (workingText) btn.textContent = workingText;
    }
    if (workingText) setPopupStatus(workingText, 'info', true);
    try {
      var result = await action();
      if (btn && successText) {
        var successResult = typeof successText === 'function' ? successText(result) : successText;
        var successMessage = successResult;
        var successType = 'ok';
        var successPersist = false;
        if (successResult && typeof successResult === 'object') {
          successMessage = successResult.text || '';
          successType = successResult.type || successType;
          successPersist = !!successResult.persist;
        }
        btn.textContent = successMessage;
        setPopupStatus(successMessage, successType, successPersist);
        setButtonTextLater(btn, originalText);
      }
      return result;
    } catch (e) {
      console.warn('[popup] 操作失败:', errorMessage(e));
      setPopupStatus('操作失败：' + errorMessage(e), 'err', true);
      if (btn) {
        btn.textContent = '操作失败';
        setButtonTextLater(btn, originalText, 1800);
      }
    } finally {
      setButtonBusy(btn, false);
    }
    return null;
  }

  async function runDestructiveButtonAction(btn, confirmText, confirmStatus, workingText, successText, restoreText, action) {
    if (!armDestructiveConfirm(btn, confirmText, confirmStatus, restoreText)) return null;
    return runButtonAction(btn, workingText, successText, restoreText, action);
  }

  function isLogKey(key) {
    if (typeof key !== 'string') return false;
    if (key === LOG_KEY_INDEX) return false;
    if (LOG_KEYS.indexOf(key) !== -1) return true;
    for (var i = 0; i < LOG_KEY_PREFIXES.length; i++) {
      if (key.indexOf(LOG_KEY_PREFIXES[i]) === 0) {
        var suffix = key.slice(LOG_KEY_PREFIXES[i].length);
        return /^\d+(?:_|$)/.test(suffix);
      }
    }
    return false;
  }

  function isContentLogKey(key) {
    if (typeof key !== 'string') return false;
    return isLogKey(key) && key.indexOf(LOG_KEY_PREFIXES[0]) === 0;
  }

  function isLogEntry(entry) {
    return entry && typeof entry === 'object' && !Array.isArray(entry);
  }

  function getLogKeysFromItems(items) {
    var itemKeys = [];
    items = items || {};
    for (var key in items) {
      if (Object.prototype.hasOwnProperty.call(items, key)) itemKeys.push(key);
    }
    return getLogKeysFromNames(itemKeys);
  }

  function getLogKeysFromNames(names) {
    var keys = [];
    var seen = {};
    for (var i = 0; i < LOG_KEYS.length; i++) {
      keys.push(LOG_KEYS[i]);
      seen[LOG_KEYS[i]] = true;
    }
    for (var ni = 0; ni < (names || []).length; ni++) {
      var key = names[ni];
      if (isLogKey(key) && !seen[key]) {
        seen[key] = true;
        keys.push(key);
      }
    }
    return keys;
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

  function collectUniqueKeys(groups, extraKey, predicate) {
    var seen = {};
    var out = [];
    for (var gi = 0; gi < (groups || []).length; gi++) {
      var group = groups[gi] || [];
      for (var i = 0; i < group.length; i++) {
        var key = group[i];
        if (!key || seen[key]) continue;
        if (predicate && !predicate(key)) continue;
        seen[key] = true;
        out.push(key);
      }
    }
    if (extraKey && !seen[extraKey] && (!predicate || predicate(extraKey))) out.push(extraKey);
    return out;
  }

  async function countExistingKeys(keys, action) {
    var names = await storageGetKeys(action || '统计存在 storage 键');
    return countExistingKeysFromNames(keys, names);
  }

  function countExistingKeysFromNames(keys, names) {
    keys = uniqueKeys(keys);
    if (!keys.length) return 0;
    var exists = {};
    for (var i = 0; i < (names || []).length; i++) exists[names[i]] = true;
    var count = 0;
    for (var ki = 0; ki < keys.length; ki++) {
      if (exists[keys[ki]]) count++;
    }
    return count;
  }

  function appendUniqueKeys(out, keys, predicate) {
    var seen = {};
    for (var oi = 0; oi < out.length; oi++) seen[out[oi]] = true;
    for (var i = 0; i < (keys || []).length; i++) {
      var key = keys[i];
      if (!key || seen[key]) continue;
      if (predicate && !predicate(key)) continue;
      seen[key] = true;
      out.push(key);
    }
    return out;
  }

  function getContentLogKeyTimestamp(key) {
    var prefix = LOG_KEY_PREFIXES[0];
    if (!isContentLogKey(key)) return 0;
    var ts = parseInt(key.slice(prefix.length), 10);
    return isNaN(ts) ? 0 : ts;
  }

  function getPrunableContentLogKeys(keys) {
    var newest = [];
    var contentCount = 0;
    keys = keys || [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!isContentLogKey(key)) continue;
      contentCount++;
      insertNewestContentLogKey(newest, key);
    }
    if (contentCount <= MAX_CONTENT_LOG_KEYS) return [];
    var keepMap = {};
    for (var ki = 0; ki < newest.length; ki++) keepMap[newest[ki]] = true;
    var stale = [];
    for (var si = 0; si < keys.length; si++) {
      var staleKey = keys[si];
      if (isContentLogKey(staleKey) && !keepMap[staleKey]) stale.push(staleKey);
    }
    return stale;
  }

  function insertNewestContentLogKey(keys, key) {
    var ts = getContentLogKeyTimestamp(key);
    var insertAt = keys.length;
    while (insertAt > 0 && ts > getContentLogKeyTimestamp(keys[insertAt - 1])) insertAt--;
    if (insertAt >= MAX_CONTENT_LOG_KEYS) return;
    keys.splice(insertAt, 0, key);
    if (keys.length > MAX_CONTENT_LOG_KEYS) keys.length = MAX_CONTENT_LOG_KEYS;
  }

  function readCacheIndex(options) {
    options = options || {};
    return new Promise(function(resolve) {
      if (typeof SharedUtils === 'undefined' || !SharedUtils.cacheIndex) {
        resolve(null);
        return;
      }
      SharedUtils.cacheIndex.read(function(entries, readFailed) {
        if (readFailed) {
          resolve(null);
          return;
        }
        if (entries) {
          resolve(entries);
          return;
        }
        if (options.rebuild === false) {
          resolve(null);
          return;
        }
        SharedUtils.cacheIndex.rebuild(function(newEntries) {
          resolve(newEntries);
        });
      });
    });
  }

  function cacheKeysFromEntries(entries, types) {
    var typeMap = {};
    for (var i = 0; i < types.length; i++) typeMap[types[i]] = true;
    var keys = [];
    entries = entries || {};
    for (var key in entries) {
      if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
      var entry = entries[key];
      if (entry && typeMap[entry.t] && isCacheKeyOfTypes(key, types)) keys.push(key);
    }
    return keys;
  }

  function isCacheKeyOfTypes(k, types) {
    var _P = CACHE_PREFIXES;
    if (types.indexOf(0) !== -1 && k.startsWith(_P.IMAGE_BASE)) return true;
    if (types.indexOf(2) !== -1 && k.startsWith(_P.ARTICLE_BASE)) return true;
    if (types.indexOf(1) !== -1 && k.startsWith(_P.TEXT_RESOURCE_BASE)) return true;
    if (types.indexOf(3) !== -1 && k.startsWith(_P.NEGATIVE_BASE)) return true;
    if (types.indexOf(4) !== -1 && k.startsWith(_P.TEXT_FAIL_BASE)) return true;
    return false;
  }

  async function discoverCacheKeysByTypes(types) {
    var names = await storageGetKeys('发现缓存键');
    return cacheKeysFromNames(names, types);
  }

  function cacheKeysFromNames(names, types) {
    var keys = [];
    for (var i = 0; i < (names || []).length; i++) {
      var k = names[i];
      if (isCacheKeyOfTypes(k, types)) keys.push(k);
    }
    return keys;
  }

  async function getCacheKeysByTypes(types) {
    var entries = await readCacheIndex({ rebuild: false });
    var indexedKeys = entries ? cacheKeysFromEntries(entries, types) : [];
    var discoveredKeys = await discoverCacheKeysByTypes(types);
    return collectUniqueKeys([indexedKeys, discoveredKeys]);
  }

  function getCacheGeneration(value) {
    var n = Number(value || 0);
    return isFinite(n) && n > 0 ? n : 0;
  }

  async function markCacheGeneration() {
    var current = await storageGet(CACHE_GENERATION_KEY, '读取缓存清理代际');
    var previous = getCacheGeneration(current && current[CACHE_GENERATION_KEY]);
    var d = {};
    d[CACHE_GENERATION_KEY] = Math.max(Date.now(), previous + 1);
    await storageSet(d, '标记缓存清理代际');
  }

  async function clearCacheTypes(types) {
    await markCacheGeneration();
    var keys = await getCacheKeysByTypes(types);
    return removeCacheKeys(keys);
  }

  async function removeCacheKeys(keys) {
    keys = uniqueKeys(keys);
    if (!keys.length) return 0;
    await markCacheGeneration();
    var removedCount = await countExistingKeys(keys, '统计缓存清理项');
    await storageRemove(keys, '清除缓存');
    await markCacheGeneration();
    var cacheIndexStatus = await removeCacheIndexEntries(keys);
    return { count: removedCount, cacheIndexStatus: cacheIndexStatus };
  }

  function rebuildCacheIndexAfterRemoveFailure() {
    if (typeof SharedUtils === 'undefined' || !SharedUtils.cacheIndex || !SharedUtils.cacheIndex.rebuild) {
      return Promise.resolve(null);
    }
    return new Promise(function(resolve) {
      SharedUtils.cacheIndex.rebuild(function(entries) {
        resolve(entries || null);
      });
    });
  }

  function removeCacheIndexEntries(keys) {
    if (typeof SharedUtils === 'undefined' || !SharedUtils.cacheIndex || !SharedUtils.cacheIndex.removeEntries) {
      return Promise.resolve({ ok: true, rebuilt: false });
    }
    return new Promise(function(resolve) {
      SharedUtils.cacheIndex.removeEntries(keys, function(success) {
        if (success === false) {
          rebuildCacheIndexAfterRemoveFailure().then(function(entries) {
            resolve({ ok: false, rebuilt: !!entries });
          });
          return;
        }
        resolve({ ok: true, rebuilt: false });
      });
    });
  }

  function getMaintenanceResultCount(result) {
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'count')) {
      return result.count;
    }
    return result;
  }

  function getCacheIndexStatusSuffix(result) {
    var status = result && result.cacheIndexStatus;
    if (!status || status.ok !== false) return '';
    return status.rebuilt ? '（缓存索引已重建）' : '（缓存索引更新失败）';
  }

  function formatMaintenanceSuccess(message, result) {
    var status = result && result.cacheIndexStatus;
    if (status && status.ok === false) {
      return { text: message + getCacheIndexStatusSuffix(result), type: 'warn', persist: true };
    }
    return message;
  }

  function formatCacheCleanupSuccess(result) {
    return formatMaintenanceSuccess('已清除', result);
  }

  function formatFullCleanupSuccess(result) {
    return formatMaintenanceSuccess('已清空 ' + getMaintenanceResultCount(result) + ' 项', result);
  }

  async function clearTestCacheAndLogs() {
    await markCacheGeneration();
    var T = SharedUtils.cacheIndex.TYPE;
    var types = [T.IMAGE, T.ARTICLE, T.TEXT_RESOURCE, T.NEGATIVE, T.TEXT_FAIL];
    var storageNames = await storageGetKeys('发现一键清空键');
    var entries = await readCacheIndex({ rebuild: false });
    var indexedKeys = entries ? cacheKeysFromEntries(entries, types) : [];
    var discoveredKeys = cacheKeysFromNames(storageNames, types);
    var cacheKeys = collectUniqueKeys([indexedKeys, discoveredKeys]);
    var logKeys = getLogKeysFromNames(storageNames);
    var keys = collectUniqueKeys([cacheKeys, logKeys], LOG_KEY_INDEX);
    var removedCount = countExistingKeysFromNames(keys, storageNames);
    await removeKeysWithLogClearMarker(keys, '一键清空缓存');
    await markCacheGeneration();
    invalidateLogLoadState();
    loadedLogEntries = [];
    if (els.logPanel.classList.contains('hidden')) {
      els.logCount.textContent = 0;
    } else {
      renderLoadedLogs(loadedLogEntries);
    }
    var cacheIndexStatus = await removeCacheIndexEntries(cacheKeys);
    return { count: removedCount, cacheIndexStatus: cacheIndexStatus };
  }

  async function writeLogIndex(keys, prunedKeys) {
    // 与内容脚本的 rememberLogKey 并发写同一索引键：写前重读合并，
    // 避免用本地快照整体覆盖导致刚注册的会话键被丢（丢了也能靠前缀发现自愈，但没必要）
    var merged = appendUniqueKeys([], keys, isContentLogKey);
    try {
      var current = await storageGet(LOG_KEY_INDEX, '合并日志索引');
      var stored = Array.isArray(current[LOG_KEY_INDEX]) ? current[LOG_KEY_INDEX] : [];
      var prunedMap = {};
      for (var pi = 0; pi < (prunedKeys || []).length; pi++) prunedMap[prunedKeys[pi]] = true;
      var extras = [];
      for (var si = 0; si < stored.length; si++) {
        if (!prunedMap[stored[si]]) extras.push(stored[si]);
      }
      appendUniqueKeys(merged, extras, isContentLogKey);
    } catch (e) {
      // 合并读失败时退回本地快照写入
    }
    var d = {};
    d[LOG_KEY_INDEX] = merged;
    await storageSet(d, '写入日志索引');
  }

  async function markLogsCleared() {
    var data = {};
    data[LOG_CLEARED_AT_KEY] = new Date().toISOString();
    await storageSet(data, '标记日志清空时间');
  }

  async function removeKeysWithLogClearMarker(keys, action) {
    await markLogsCleared();
    try {
      await storageRemove(keys, action);
      await markLogsCleared();
    } catch (e) {
      try {
        await storageRemove(LOG_CLEARED_AT_KEY, '回滚日志清空标记');
      } catch (rollbackError) {
        console.warn('[popup] 日志清空标记回滚失败:', errorMessage(rollbackError));
      }
      throw e;
    }
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

  function filterLogsAfterClearedAt(logs, clearedAtMs) {
    if (!clearedAtMs || !Array.isArray(logs) || !logs.length) return logs || [];
    var out = [];
    for (var i = 0; i < logs.length; i++) {
      if (getLogEntryTimeMs(logs[i]) > clearedAtMs) out.push(logs[i]);
    }
    return out;
  }

  async function writeLogIndexBestEffort(keys, prunedKeys) {
    try {
      await writeLogIndex(keys, prunedKeys);
      return true;
    } catch (e) {
      console.warn('[popup] 日志索引写回失败:', errorMessage(e));
      return false;
    }
  }

  async function discoverLogKeysFromStorage() {
    // Capture the old index before discovery so stale keys can be removed without
    // dropping a new content-script session registered while discovery is running.
    var previous = [];
    try {
      var snapshot = await storageGet(LOG_KEY_INDEX, '读取待校验日志索引');
      previous = Array.isArray(snapshot[LOG_KEY_INDEX]) ? snapshot[LOG_KEY_INDEX] : [];
    } catch (e) {
      console.warn('[popup] 日志索引预读失败:', errorMessage(e));
    }
    var names = await storageGetKeys('发现日志键');
    return await discoverLogKeysFromNames(names, previous);
  }

  async function discoverLogKeysFromNames(names, previous) {
    var keys = getLogKeysFromNames(names);
    var indexed = appendUniqueKeys([], keys, isContentLogKey);
    var present = new Set(names);
    var stale = (previous || []).filter(function(key) { return isContentLogKey(key) && !present.has(key); });
    await writeLogIndexBestEffort(indexed, stale);
    return keys;
  }

  async function getLogKeysForRead(allowDiscovery) {
    if (allowDiscovery) return await discoverLogKeysFromStorage();
    var result = await storageGet(LOG_KEY_INDEX, '读取日志索引');
    var indexed = Array.isArray(result[LOG_KEY_INDEX]) ? result[LOG_KEY_INDEX] : [];
    var keys = appendUniqueKeys([], LOG_KEYS);
    appendUniqueKeys(keys, indexed, isLogKey);
    return keys;
  }

  async function pruneContentLogKeys(logKeys) {
    var stale = getPrunableContentLogKeys(logKeys);
    if (!stale.length) return stale;
    try {
      await storageRemove(stale, '裁剪旧日志');
    } catch (e) {
      console.warn('[popup] 旧日志裁剪失败:', errorMessage(e));
      return [];
    }
    var staleMap = {};
    for (var si = 0; si < stale.length; si++) staleMap[stale[si]] = true;
    var kept = [];
    for (var ki = 0; ki < (logKeys || []).length; ki++) {
      var key = logKeys[ki];
      if (isContentLogKey(key) && !staleMap[key]) kept.push(key);
    }
    await writeLogIndexBestEffort(kept, stale);
    return stale;
  }

  async function getSettings() {
    var stored = await storageGet('settings', '读取设置');
    settings = ATPNormalizeSettings(stored.settings);
    return settings;
  }

  function cloneSiteConfigsForSave(siteConfigs) {
    var out = {};
    if (siteConfigs && typeof siteConfigs === 'object' && !Array.isArray(siteConfigs)) {
      for (var host in siteConfigs) {
        if (!Object.prototype.hasOwnProperty.call(siteConfigs, host)) continue;
        var siteConfig = siteConfigs[host];
        out[host] = siteConfig && typeof siteConfig === 'object' && !Array.isArray(siteConfig)
          ? Object.assign({}, siteConfig)
          : siteConfig;
      }
    }
    return out;
  }

  function cloneSettingsForSave(source, changedKeys) {
    source = source || {};
    var snapshot = {};
    var keys = Array.isArray(changedKeys) ? changedKeys : [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      if (key === 'siteConfigs') snapshot.siteConfigs = cloneSiteConfigsForSave(source.siteConfigs);
      else snapshot[key] = source[key];
    }
    return snapshot;
  }

  function queueSettingsWrite(snapshot) {
    saveWriteChain = saveWriteChain.catch(function() {}).then(function() {
      return new Promise(function(resolve, reject) {
        chrome.runtime.sendMessage({
          type: SharedUtils.MESSAGE_TYPES.SAVE_SETTINGS_PATCH,
          settingsPatch: snapshot,
        }, function(response) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response || !response.ok) {
            reject(new Error((response && response.error) || 'settings save failed'));
            return;
          }
          resolve(response.settings);
        });
      });
    });
    return saveWriteChain;
  }

  function applySavedSettings(savedSettings) {
    if (!savedSettings) return;
    settings = ATPNormalizeSettings(savedSettings);
    els.toggleEnabled.checked = settings.enabled;
    if (typeof SETTINGS_SCHEMA !== 'undefined') {
      SETTINGS_SCHEMA.forEach(function(item) { setUIValue(item.key); });
    }
    var disableEl = getSettingEl('disableSite');
    if (disableEl && disableEl.__atpHostname) {
      disableEl.checked = !!((settings.siteConfigs[disableEl.__atpHostname] || {}).disabled);
    }
    updateFirstScreen();
    updateDependentControls();
  }

  function formatRefreshFailureStatus(refreshResult, prefix) {
    var message = refreshResult && refreshResult.error ? refreshResult.error : '未知错误';
    return (prefix || '已保存') + '，但刷新当前页失败：' + message;
  }

  function getSettingsApplyMode(changedKeys) {
    // settings-schema.js 在 popup.html 中先于本文件加载，ATPGetSettingsApplyMode 必定存在
    return ATPGetSettingsApplyMode(changedKeys, typeof SETTINGS_SCHEMA !== 'undefined' ? SETTINGS_SCHEMA : []);
  }

  async function saveSettings(applyMode, changedKeys, patchOverride) {
    if (settingsLoadFailed || !settings) throw new Error('settings not loaded');
    var seq = ++saveStatusSeq;
    var snapshot = patchOverride || cloneSettingsForSave(settings, changedKeys);
    applyMode = applyMode || getSettingsApplyMode(changedKeys);
    setPopupStatus('保存中...', 'info', true);
    try {
      var savedSettings = await queueSettingsWrite(snapshot);
      if (seq !== saveStatusSeq) return;
      applySavedSettings(savedSettings);
      if (applyMode === 'pageReload') {
        var refreshResult = await refreshCurrentPage();
        if (seq !== saveStatusSeq) return;
        if (!refreshResult.ok) {
          setPopupStatus(formatRefreshFailureStatus(refreshResult, '已保存'), 'warn', true);
          return { ok: true, refresh: refreshResult };
        }
        if (refreshResult.skipped) {
          setPopupStatus('已保存，打开论坛页面后生效', 'ok');
          return { ok: true, refresh: refreshResult };
        }
        setPopupStatus('已保存，刷新后生效', 'ok');
        return { ok: true, refresh: refreshResult };
      }
      setPopupStatus(applyMode === 'hotReload' ? '已保存，缩略图已自动重新加载' : '已保存', 'ok');
      return { ok: true };
    } catch (e) {
      if (seq === saveStatusSeq) {
        setPopupStatus('保存失败：' + errorMessage(e), 'err', true);
      }
      throw e;
    }
  }

  function refreshCurrentPage() {
    return new Promise(function(resolve) {
      if (!chrome.tabs || typeof chrome.tabs.query !== 'function') {
        resolve({ ok: false, error: 'tabs.query 不可用' });
        return;
      }
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: errorMessage(chrome.runtime.lastError) });
            return;
          }
          var tab = tabs && tabs[0];
          if (!tab || tab.id === undefined || tab.id === null) {
            resolve({ ok: false, error: '未找到可刷新的当前标签页' });
            return;
          }
          // 只刷新扩展实际生效的论坛页面：避免误刷新用户正在其他站点填写的表单或 chrome:// 页
          var tabHost = getTabHostname(tab.url);
          if (!tabHost || !SharedUtils.isSupportedForumHost(tabHost)) {
            resolve({ ok: true, skipped: true });
            return;
          }
          if (!chrome.tabs || typeof chrome.tabs.reload !== 'function') {
            resolve({ ok: false, error: 'tabs.reload 不可用' });
            return;
          }
          try {
            chrome.tabs.reload(tab.id, function() {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, error: errorMessage(chrome.runtime.lastError) });
                return;
              }
              resolve({ ok: true });
            });
          } catch (e) {
            resolve({ ok: false, error: errorMessage(e) });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: errorMessage(e) });
      }
    });
  }

  function updateFirstScreen() {
    var n = (settings.gridCols || 5) * (settings.visibleRows || 2);
    els.firstScreenInfo.textContent = n + ' 张';
  }

  function markSettingSaveAttempt(key, value) {
    settingSaveSeqByKey[key] = (settingSaveSeqByKey[key] || 0) + 1;
    return { key: key, value: value, seq: settingSaveSeqByKey[key] };
  }

  function markSettingsSaveAttempt(keys) {
    var attempts = {};
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      attempts[key] = markSettingSaveAttempt(key, settings[key]);
    }
    return attempts;
  }

  function isSettingSaveAttemptCurrent(attempt) {
    return attempt &&
      settingSaveSeqByKey[attempt.key] === attempt.seq &&
      settings[attempt.key] === attempt.value;
  }

  function areSettingSaveAttemptsCurrent(attempts) {
    for (var key in attempts) {
      if (Object.prototype.hasOwnProperty.call(attempts, key) && !isSettingSaveAttemptCurrent(attempts[key])) {
        return false;
      }
    }
    return true;
  }

  function getAllSettingsPatchKeys() {
    var keys = ['enabled'];
    if (typeof SETTINGS_SCHEMA !== 'undefined') {
      for (var i = 0; i < SETTINGS_SCHEMA.length; i++) {
        if (SETTINGS_SCHEMA[i] && SETTINGS_SCHEMA[i].key) keys.push(SETTINGS_SCHEMA[i].key);
      }
    }
    return keys;
  }

  function markSiteSaveAttempt(hostname, value) {
    siteSaveSeqByHost[hostname] = (siteSaveSeqByHost[hostname] || 0) + 1;
    return { hostname: hostname, value: value, seq: siteSaveSeqByHost[hostname] };
  }

  function isSiteSaveAttemptCurrent(attempt) {
    var current = settings.siteConfigs[attempt.hostname] || {};
    return siteSaveSeqByHost[attempt.hostname] === attempt.seq && !!current.disabled === !!attempt.value;
  }

  function flashError(el) {
    el.classList.add('input-error');
    setTimeout(function() { el.classList.remove('input-error'); }, 800);
  }

  function getSettingEl(key) { return document.getElementById(key); }

  function markSettingInputDirty(el) {
    if (!el || !el.id) return;
    dirtySettingInputByKey[el.id] = true;
  }

  function clearSettingInputDirty(key) {
    if (!key) return;
    delete dirtySettingInputByKey[key];
  }

  function setControlValue(el, value) {
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
  }

  function isSettingInputProtected(key, el) {
    return !!(key && el && dirtySettingInputByKey[key] && document.activeElement === el);
  }

  function isSettingItemEnabled(item) {
    if (!item || !item.enabledWhen) return true;
    return settings && settings[item.enabledWhen.key] === item.enabledWhen.value;
  }

  function updateDependentControls() {
    if (typeof SETTINGS_SCHEMA === 'undefined') return;
    SETTINGS_SCHEMA.forEach(function(item) {
      var el = getSettingEl(item.key);
      if (!el) return;
      var enabled = isSettingItemEnabled(item);
      el.disabled = !enabled;
      if (!enabled) clearInputError(el);
      var reset = els.settingsContainer.querySelector('.btn-reset[data-key="' + item.key + '"]');
      if (reset) reset.disabled = !enabled;
    });
    var heavyPreset = els.settingsContainer.querySelector('.btn-heavy-preset');
    if (heavyPreset) heavyPreset.disabled = !settings.heavyImageOptimization;
  }

  function setSettingsControlsDisabled(disabled) {
    if (els.toggleEnabled) els.toggleEnabled.disabled = !!disabled;
    if (els.resetSettings) els.resetSettings.disabled = !!disabled;
    if (els.settingsContainer) els.settingsContainer.setAttribute('aria-busy', disabled && !settings ? 'true' : 'false');
    if (!els.settingsContainer || !els.settingsContainer.querySelectorAll) return;
    var controls = els.settingsContainer.querySelectorAll('input, select, button');
    for (var i = 0; i < controls.length; i++) {
      controls[i].disabled = !!disabled;
      if (disabled && controls[i].matches && controls[i].matches('input[type="number"]')) {
        clearInputError(controls[i]);
      }
    }
    // 解除禁用后恢复 enabledWhen 依赖态与站点开关可用性，避免整片控件被无差别启用
    if (!disabled && settings) {
      updateDependentControls();
      setDisableSiteHost(currentSiteHost);
    }
  }

  function getTabHostname(url) {
    try {
      var parsed = new URL(url || '');
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.hostname.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  function setDisableSiteHost(hostname) {
    currentSiteHost = hostname || '';
    var disableEl = getSettingEl('disableSite');
    var hintEl = document.getElementById('disableSiteHint');
    if (els.currentSite) els.currentSite.textContent = currentSiteHost || '--';
    if (!disableEl) return;
    disableEl.__atpHostname = currentSiteHost;
    if (!currentSiteHost) {
      disableEl.checked = false;
      disableEl.disabled = true;
      disableEl.setAttribute('aria-describedby', 'disableSiteHint');
      if (hintEl) {
        hintEl.textContent = '当前页面不支持站点禁用';
        hintEl.classList.remove('site-disable-hint-empty');
      }
      return;
    }
    disableEl.disabled = false;
    disableEl.removeAttribute('aria-describedby');
    if (hintEl) {
      hintEl.textContent = '';
      hintEl.classList.add('site-disable-hint-empty');
    }
    disableEl.checked = !!((settings.siteConfigs[currentSiteHost] || {}).disabled);
  }

  function forEachHeavyOriginalPreset(callback) {
    for (var key in HEAVY_ORIGINAL_PRESET) {
      if (Object.prototype.hasOwnProperty.call(HEAVY_ORIGINAL_PRESET, key)) callback(key);
    }
  }

  function applyOrdinaryPresetButton(presetBtn) {
    if (!ensureSettingsReady(presetBtn) || presetBtn.__atpBusy) return;
    var presetName = presetBtn.getAttribute('data-preset') || '';
    var preset = ATPGetSettingsPreset(presetName, SETTINGS_SCHEMA);
    var presetKeys = [];
    for (var key in preset) {
      if (!Object.prototype.hasOwnProperty.call(preset, key) || !(key in settings)) continue;
      presetKeys.push(key);
    }
    if (!presetKeys.length) {
      flashError(presetBtn);
      return;
    }
    var previousPreset = Object.assign({}, settings);
    for (var i = 0; i < presetKeys.length; i++) {
      var presetKey = presetKeys[i];
      settings[presetKey] = preset[presetKey];
      setUIValue(presetKey);
    }
    updateDependentControls();
    setButtonBusy(presetBtn, true);
    var attempts = markSettingsSaveAttempt(presetKeys);
    saveSettings(getSettingsApplyMode(presetKeys), presetKeys).catch(function(err) {
      if (areSettingSaveAttemptsCurrent(attempts)) {
        settings = previousPreset;
        for (var rollbackIndex = 0; rollbackIndex < presetKeys.length; rollbackIndex++) {
          setUIValue(presetKeys[rollbackIndex]);
        }
        updateDependentControls();
        flashError(presetBtn);
      }
      console.warn('[popup] 应用弱图预设失败:', errorMessage(err));
    }).finally(function() {
      setButtonBusy(presetBtn, false);
      updateDependentControls();
    });
  }

  function setUIValue(key) {
    var el = getSettingEl(key);
    if (!el) return;
    if (isSettingInputProtected(key, el)) return;
    if (el.type === 'checkbox') el.checked = settings[key];
    else el.value = settings[key];
    clearSettingInputDirty(key);
    clearInputError(el);
  }

  function rollbackSettingValue(key, previous, el) {
    settings[key] = previous;
    setUIValue(key);
    setControlValue(el, previous);
    if (['gridCols','visibleRows'].indexOf(key) !== -1) updateFirstScreen();
    updateDependentControls();
    if (el) flashError(el);
  }

  async function loadUI() {
    await getSettings();
    settingsLoadFailed = false;
    setSettingsControlsDisabled(false);
    els.toggleEnabled.checked = settings.enabled;
    if (typeof SETTINGS_SCHEMA !== 'undefined') {
      SETTINGS_SCHEMA.forEach(function(item) { setUIValue(item.key); });
    }
    setDisableSiteHost('');
    updateFirstScreen();
    updateDependentControls();

    clearPopupStatusIfText('正在读取设置...');
    if (!chrome.tabs || typeof chrome.tabs.query !== 'function') {
      setDisableSiteHost('');
      setPopupStatus('读取当前标签页失败：tabs.query 不可用', 'warn', true);
      return;
    }
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (chrome.runtime.lastError) {
          setDisableSiteHost('');
          setPopupStatus('读取当前标签页失败：' + errorMessage(chrome.runtime.lastError), 'warn', true);
          return;
        }
        setDisableSiteHost(tabs[0] ? getTabHostname(tabs[0].url) : '');
      });
    } catch (e) {
      setDisableSiteHost('');
      setPopupStatus('读取当前标签页失败：' + errorMessage(e), 'warn', true);
    }
  }

  // 仅用于 header 的总开关；schema 字段由 bindSchemaControls 统一绑定
  function bind(id, key) {
    if (!els[id]) {
      console.warn('[popup] Element not found:', id);
      return;
    }
    els[id].addEventListener('change', function() {
      if (!ensureSettingsReady(els[id])) return;
      var previous = settings[key];
      if (els[id].type === 'checkbox') {
        settings[key] = els[id].checked;
      } else {
        settings[key] = els[id].value;
      }
      var attempt = markSettingSaveAttempt(key, settings[key]);
      saveSettings(getSettingsApplyMode([key]), [key]).catch(function(e) {
        if (isSettingSaveAttemptCurrent(attempt)) {
          rollbackSettingValue(key, previous, els[id]);
        }
        console.warn('[popup] 保存设置失败:', errorMessage(e));
      });
    });
  }

  bind('toggleEnabled', 'enabled');

  els.clearImageCache.addEventListener('click', function() {
    runDestructiveButtonAction(els.clearImageCache, '再次点击清除', '再次点击确认清除文章/图片缓存', '清除中...', formatCacheCleanupSuccess, '清除文章/图片缓存', async function() {
      var T = SharedUtils.cacheIndex.TYPE;
      return clearCacheTypes([T.IMAGE, T.ARTICLE]);
    });
  });

  els.clearFailCache.addEventListener('click', function() {
    runDestructiveButtonAction(els.clearFailCache, '再次点击清除', '再次点击确认清除失败缓存', '清除中...', formatCacheCleanupSuccess, '清除失败缓存', async function() {
      var T = SharedUtils.cacheIndex.TYPE;
      return clearCacheTypes([T.NEGATIVE, T.TEXT_FAIL]);
    });
  });

  els.clearAllCache.addEventListener('click', function() {
    runDestructiveButtonAction(els.clearAllCache, '再次点击清除', '再次点击确认清除全部缓存', '清除中...', formatCacheCleanupSuccess, '清除全部缓存', async function() {
      var T = SharedUtils.cacheIndex.TYPE;
      return clearCacheTypes([T.IMAGE, T.ARTICLE, T.TEXT_RESOURCE, T.NEGATIVE, T.TEXT_FAIL]);
    });
  });

  els.clearTestCache.addEventListener('click', function() {
    runDestructiveButtonAction(els.clearTestCache, '再次点击清空', '再次点击确认清空缓存和日志', '清空中...', formatFullCleanupSuccess, '一键清空缓存和日志', async function() {
      return clearTestCacheAndLogs();
    });
  });

  els.resetSettings.addEventListener('click', function() {
    if (!ensureSettingsReady(els.resetSettings)) return;
    runDestructiveButtonAction(els.resetSettings, '再次点击恢复', '再次点击确认恢复默认设置', '恢复中...', function(result) {
      if (result && result.refresh && !result.refresh.ok) {
        return { text: formatRefreshFailureStatus(result.refresh, '已恢复'), type: 'warn', persist: true };
      }
      if (result && result.reload && !result.reload.ok) {
        return { text: '已恢复，但重新读取设置失败：' + (result.reload.error || '未知错误'), type: 'warn', persist: true };
      }
      return '已恢复';
    }, '恢复默认设置', async function() {
      var previousSettings = Object.assign({}, settings, { siteConfigs: cloneSiteConfigsForSave(settings.siteConfigs) });
      settings = ATPNormalizeSettings({ siteConfigs: settings.siteConfigs });
      setSettingsControlsDisabled(true);
      try {
        try {
          var resetKeys = getAllSettingsPatchKeys();
          var saveResult = await saveSettings(getSettingsApplyMode(resetKeys), resetKeys);
        } catch (e) {
          settings = previousSettings;
          applySavedSettings(previousSettings);
          throw e;
        }
        try {
          await loadUI();
        } catch (e) {
          console.warn('[popup] 恢复默认设置后刷新 UI 失败:', errorMessage(e));
          return Object.assign({}, saveResult || { ok: true }, { reload: { ok: false, error: errorMessage(e) } });
        }
        return saveResult;
      } finally {
        setSettingsControlsDisabled(false);
      }
    });
  });

  els.toggleHelp.addEventListener('click', function() {
    var expanded = els.helpPanel.classList.contains('hidden');
    setDisclosureState(els.toggleHelp, els.helpPanel, expanded);
  });

  els.toggleLogs.addEventListener('click', function() {
    var expanded = els.logPanel.classList.contains('hidden');
    setDisclosureState(els.toggleLogs, els.logPanel, expanded);
    if (expanded) {
      loadLogs({ allowDiscovery: true, prune: true });
    } else {
      logLoadSeq++;
      loadedLogEntries = null;
      logLoadInFlight = false;
      setLogViewerBusy(false);
    }
  });

  if (els.logFilter) {
    els.logFilter.addEventListener('change', function() {
      scheduleLogReload(0);
    });
  }

  if (els.logSearch) {
    els.logSearch.addEventListener('input', function() {
      scheduleLogReload(LOG_SEARCH_DEBOUNCE_MS);
    });
  }

  async function refreshLogCount() {
    var seq = ++logCountSeq;
    try {
      var logs = await loadLogEntries({ allowDiscovery: false, prune: false });
      if (seq !== logCountSeq) return;
      if (!logs.length) {
        logs = await loadLogEntries({ allowDiscovery: true, prune: false });
        if (seq !== logCountSeq) return;
      }
      els.logCount.textContent = logs.length;
    } catch (e) {
      if (seq !== logCountSeq) return;
      els.logCount.textContent = '!';
      setPopupStatus('读取日志计数失败：' + errorMessage(e), 'err', true);
    }
  }

  function getLogFields(e) {
    return e && e.fields && typeof e.fields === 'object' ? e.fields : {};
  }

  function scheduleLogReload(delay) {
    if (!els.logPanel || els.logPanel.classList.contains('hidden')) return;
    if (logReloadTimer) {
      clearTimeout(logReloadTimer);
      logReloadTimer = null;
    }
    logReloadTimer = setTimeout(function() {
      logReloadTimer = null;
      if (!els.logPanel || els.logPanel.classList.contains('hidden')) return;
      if (loadedLogEntries) {
        renderLoadedLogs(loadedLogEntries);
      } else if (!logLoadInFlight) {
        loadLogs({ allowDiscovery: false, prune: false });
      }
    }, Math.max(0, delay || 0));
  }

  function invalidateLogLoadState() {
    logLoadSeq++;
    logCountSeq++;
    logLoadInFlight = false;
    if (logReloadTimer) {
      clearTimeout(logReloadTimer);
      logReloadTimer = null;
    }
  }

  function getLogType(e) {
    return (e && e.type) || '';
  }

  function isLogUrlFieldKey(key) {
    return /(?:url|urls|uri|uris|href|src|link|links|referrer|referer)$/i.test(String(key || ''));
  }

  function isLogUrlLikeKey(key) {
    var raw = String(key || '');
    return /^(?:https?:)?\/\//i.test(raw) ||
      /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|[?#]|$)/i.test(raw);
  }

  function isSensitiveLogExportKey(key) {
    if (isLogUrlLikeKey(key)) return false;
    var compact = String(key || '').replace(/[\s_.:-]+/g, '').toLowerCase();
    return compact === 'auth' ||
      /(?:accesstoken|refreshtoken|idtoken|authtoken|authorization|setcookie|cookie|token|secret|signature|password|passwd|pwd|credential|apikey|clientsecret|csrf|xsrf|jwt|bearer)/.test(compact);
  }

  function sanitizeLogExportUrl(url) {
    if (url === null || url === undefined) return '';
    var raw = String(url).trim();
    if (!raw) return '';
    try {
      if (!/^https?:\/\//i.test(raw) && raw.indexOf('//') !== 0) {
        return raw.replace(/[?#].*$/, '').substring(0, 240);
      }
      var u = new URL(raw, 'https://example.invalid/');
      return (u.protocol + '//' + u.host + u.pathname).substring(0, 240);
    } catch (e) {
      return raw.replace(/[?#].*$/, '').substring(0, 240);
    }
  }

  function sanitizeLogExportText(text) {
    return String(text === null || text === undefined ? '' : text).replace(/(?:https?:)?\/\/[^\s"'<>]+/gi, function(raw) {
      var trailing = '';
      while (/[),.;，。！？!?]$/.test(raw)) {
        trailing = raw.slice(-1) + trailing;
        raw = raw.slice(0, -1);
      }
      return sanitizeLogExportUrl(raw) + trailing;
    }).replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'<>]*)?[?#][^\s"'<>]+/gi, function(raw) {
      var trailing = '';
      while (/[),.;，。！？!?]$/.test(raw)) {
        trailing = raw.slice(-1) + trailing;
        raw = raw.slice(0, -1);
      }
      return sanitizeLogExportUrl(raw) + trailing;
    });
  }

  function sanitizeLogExportLabel(value) {
    return sanitizeLogExportText(value).substring(0, 240);
  }

  function sanitizeLogExportKey(key, existing) {
    var base = sanitizeLogExportLabel(key) || '[empty]';
    var safe = base;
    var n = 2;
    while (existing && Object.prototype.hasOwnProperty.call(existing, safe)) {
      var suffix = '_' + n++;
      safe = base.substring(0, Math.max(1, 240 - suffix.length)) + suffix;
    }
    return safe;
  }

  function sanitizeLogExportValue(value, key, seenObjects) {
    if (value === null || value === undefined) return value;
    if (isSensitiveLogExportKey(key)) return '[redacted]';
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      if (seenObjects && seenObjects.has(value)) return '[Circular]';
      if (seenObjects) seenObjects.add(value);
      var arr = [];
      var arrayLimit = Math.min(value.length, 50);
      for (var i = 0; i < arrayLimit; i++) {
        arr.push(sanitizeLogExportValue(value[i], key, seenObjects));
      }
      if (seenObjects) seenObjects.delete(value);
      return arr;
    }
    if (typeof value === 'object') {
      if (seenObjects && seenObjects.has(value)) return '[Circular]';
      return sanitizeLogExportFields(value, seenObjects);
    }
    return isLogUrlFieldKey(key) ? sanitizeLogExportUrl(value) : sanitizeLogExportText(value);
  }

  function sanitizeLogExportFields(fields, seenObjects) {
    var out = {};
    if (!fields || typeof fields !== 'object') return out;
    seenObjects = seenObjects || (typeof WeakSet !== 'undefined' ? new WeakSet() : null);
    if (seenObjects) {
      if (seenObjects.has(fields)) return { circular: true };
      seenObjects.add(fields);
    }
    var fieldCount = 0;
    for (var key in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      if (fieldCount++ >= 120) break;
      var outputKey = sanitizeLogExportKey(key, out);
      try {
        out[outputKey] = sanitizeLogExportValue(fields[key], key, seenObjects);
      } catch (e) {
        out[outputKey] = '[Unserializable]';
      }
    }
    if (seenObjects) seenObjects.delete(fields);
    return out;
  }

  function sanitizeLegacyLogDataText(data) {
    var text = String(data);
    var trimmed = text.trim();
    if (trimmed && /^[\[{]/.test(trimmed)) {
      try {
        return JSON.stringify(sanitizeLogExportValue(JSON.parse(trimmed), ''));
      } catch (e) {
        // Fall through to text sanitization for truncated or legacy non-JSON data.
      }
    }
    return sanitizeLogExportText(text);
  }

  function getLogDataText(e) {
    if (!e) return '';
    var fields = getLogFields(e);
    if (hasLogFields(fields)) {
      try {
        return JSON.stringify(sanitizeLogExportFields(fields));
      } catch (ex) {
        // Fall back to the stored compact string if a legacy entry contains non-serializable fields.
      }
    }
    if (e.data) return sanitizeLegacyLogDataText(e.data);
    return '';
  }

  function hasLogFields(fields) {
    for (var key in fields || {}) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) return true;
    }
    return false;
  }

  function isImageLog(e) {
    var type = getLogType(e);
    if (/^(content_start|image_|render_|diagnostic_summary|schedule_state|thread_registered|scan_complete|fallback_)/.test(type)) return true;
    return /High fanout|Image candidate fallback|图片无Referer|首屏完成|重图/.test(String((e && e.msg) || '') + ' ' + getLogDataText(e));
  }

  function isHeavyLog(e) {
    var fields = getLogFields(e);
    var text = [getLogType(e), e && e.msg, getLogDataText(e), fields.host, fields.channel].join(' ');
    return /image\.imx\.to|high fanout|heavy|重图/i.test(text);
  }

  function getLatestSessionId(logs) {
    for (var i = logs.length - 1; i >= 0; i--) {
      if (logs[i] && logs[i].sessionId) return logs[i].sessionId;
    }
    return '';
  }

  function getLogHaystack(e) {
    var fields = getLogFields(e);
    return [
      e && e.src,
      e && e.lv,
      e && e.msg,
      getLogType(e),
      e && e.pageHost,
      fields.host,
      fields.channel,
      fields.reason,
      fields.threadId,
      getLogDataText(e)
    ].join(' ').toLowerCase();
  }

  function filterLogEntries(logs) {
    var filter = els.logFilter ? els.logFilter.value : 'all';
    var query = els.logSearch ? String(els.logSearch.value || '').trim().toLowerCase() : '';
    if (filter === 'all' && !query) return logs;
    var latestSessionId = filter === 'session' ? getLatestSessionId(logs) : '';
    var filtered = [];
    for (var i = 0; i < logs.length; i++) {
      var e = logs[i];
      if (filter === 'session' && latestSessionId && e.sessionId !== latestSessionId) continue;
      if (filter === 'warn' && ['WARN', 'ERROR'].indexOf(e.lv) === -1) continue;
      if (filter === 'image' && !isImageLog(e)) continue;
      if (filter === 'heavy' && !isHeavyLog(e)) continue;
      if (query && getLogHaystack(e).indexOf(query) === -1) continue;
      filtered.push(e);
    }
    return filtered;
  }

  function renderLogEntry(e) {
    var cls = 'log-entry lv-' + esc(sanitizeLogExportLabel(e.lv || ''));
    var ts = e.ts ? esc(sanitizeLogExportLabel(e.ts).substring(11, 19)) : '';
    var rawType = getLogType(e);
    var type = sanitizeLogExportLabel(rawType);
    var typeHtml = type ? '<span class="type">' + esc(type) + '</span>' : '';
    var msg = rawType && e.msg === rawType ? '' : sanitizeLogExportText(e.msg || '');
    var d = getLogDataText(e);
    var dataHtml = d ? ' <span class="data">' + esc(d) + '</span>' : '';
    return '<div class="' + cls + '"><span class="ts">' + ts + '</span><span class="src">[' + esc(sanitizeLogExportLabel(e.src || '?')) + ']</span>' + typeHtml + esc(msg) + dataHtml + '</div>';
  }

  function renderLogEntries(entries, startIndex) {
    var html = '';
    startIndex = startIndex || 0;
    for (var i = startIndex; i < entries.length; i++) {
      html += renderLogEntry(entries[i]) + '\n';
    }
    return html;
  }

  function shouldFollowLogTail(viewer) {
    if (!viewer) return false;
    if (!viewer.innerHTML) return true;
    var scrollHeight = Number(viewer.scrollHeight) || 0;
    var clientHeight = Number(viewer.clientHeight) || 0;
    var scrollTop = Number(viewer.scrollTop) || 0;
    if (scrollHeight <= clientHeight) return true;
    return scrollHeight - scrollTop - clientHeight <= 8;
  }

  function renderLoadedLogs(logs) {
    logs = logs || [];
    setLogViewerBusy(false);
    var followTail = shouldFollowLogTail(els.logViewer);
    var filtered = filterLogEntries(logs);
    els.logCount.textContent = filtered.length === logs.length ? logs.length : filtered.length + '/' + logs.length;
    if (!filtered.length) {
      els.logViewer.innerHTML = '<div class="log-entry" style="color:#808080">暂无日志</div>';
      return;
    }
    var renderStart = Math.max(0, filtered.length - LOG_RENDER_LIMIT);
    els.logViewer.innerHTML = renderLogEntries(filtered, renderStart);
    if (followTail) els.logViewer.scrollTop = els.logViewer.scrollHeight;
  }

  async function loadLogs(options) {
    var seq = ++logLoadSeq;
    logLoadInFlight = true;
    setLogViewerBusy(true, '读取中...');
    try {
      var logs = await loadLogEntries(options || {});
      if (seq !== logLoadSeq) return;
      loadedLogEntries = logs;
      renderLoadedLogs(loadedLogEntries);
    } catch (e) {
      if (seq !== logLoadSeq) return;
      loadedLogEntries = null;
      setLogViewerBusy(false);
      els.logCount.textContent = '!';
      var message = '读取日志失败：' + errorMessage(e);
      els.logViewer.innerHTML = '<div class="log-entry lv-ERROR">' + esc(message) + '</div>';
      setPopupStatus(message, 'err', true);
    } finally {
      if (seq === logLoadSeq) logLoadInFlight = false;
    }
  }

  async function loadLogEntries(options) {
    options = options || {};
    var logKeys = await getLogKeysForRead(!!options.allowDiscovery);
    if (options.prune) {
      var staleLogKeys = await pruneContentLogKeys(logKeys);
      if (staleLogKeys.length) {
        var prunedLogKeyMap = {};
        for (var pi = 0; pi < staleLogKeys.length; pi++) prunedLogKeyMap[staleLogKeys[pi]] = true;
        var liveLogKeys = [];
        for (var li = 0; li < logKeys.length; li++) {
          if (!prunedLogKeyMap[logKeys[li]]) liveLogKeys.push(logKeys[li]);
        }
        logKeys = liveLogKeys;
      }
    }
    var readKeys = appendUniqueKeys([], logKeys);
    appendUniqueKeys(readKeys, [LOG_CLEARED_AT_KEY]);
    var result = await storageGet(readKeys, '读取日志内容');
    var clearedAtMs = getLogClearedAtMs(result[LOG_CLEARED_AT_KEY]);
    var logs = [];
    for (var i = 0; i < logKeys.length; i++) {
      if (Array.isArray(result[logKeys[i]])) {
        for (var j = 0; j < result[logKeys[i]].length; j++) {
          if (isLogEntry(result[logKeys[i]][j])) logs.push(result[logKeys[i]][j]);
        }
      }
    }
    logs = filterLogsAfterClearedAt(logs, clearedAtMs);
    logs.sort(function(a, b) {
      var at = getLogSortTimestamp(a);
      var bt = getLogSortTimestamp(b);
      if (at !== bt) return at - bt;
      return String(a.ts || '').localeCompare(String(b.ts || ''));
    });
    if (logs.length > LOG_VIEW_LIMIT) logs.splice(0, logs.length - LOG_VIEW_LIMIT);
    return logs;
  }

  function esc(s) { return SharedUtils.escapeHtml(s); }

  function addLogSummaryCount(counts, value) {
    var key = sanitizeLogExportLabel(value);
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
  }

  function formatLogSummaryCounts(counts, limit) {
    var keys = collectTopCountKeys(counts, limit || 10);
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      parts.push(keys[i] + '=' + counts[keys[i]]);
    }
    return parts.join(', ');
  }

  function collectTopCountKeys(counts, limit) {
    var topKeys = [];
    counts = counts || {};
    for (var key in counts) {
      if (!Object.prototype.hasOwnProperty.call(counts, key)) continue;
      var count = counts[key] || 0;
      var insertAt = topKeys.length;
      while (insertAt > 0 && count > (counts[topKeys[insertAt - 1]] || 0)) insertAt--;
      if (insertAt >= limit) continue;
      topKeys.splice(insertAt, 0, key);
      if (topKeys.length > limit) topKeys.length = limit;
    }
    return topKeys;
  }

  function buildLogSummaryStats(logs) {
    var stats = { types: {}, hosts: {}, levels: {} };
    for (var i = 0; i < logs.length; i++) {
      var e = logs[i];
      var fields = getLogFields(e);
      addLogSummaryCount(stats.types, getLogType(e) || e.msg || e.src);
      addLogSummaryCount(stats.hosts, fields.host || e.pageHost || '');
      addLogSummaryCount(stats.levels, e.lv || '?');
    }
    return stats;
  }

  function buildLogSummaryText(logs) {
    var latestSessionId = sanitizeLogExportLabel(getLatestSessionId(logs) || '-') || '-';
    var stats = buildLogSummaryStats(logs);
    var typeSummary = formatLogSummaryCounts(stats.types, 12) || '-';
    var hostSummary = formatLogSummaryCounts(stats.hosts, 12) || '-';
    var levelSummary = formatLogSummaryCounts(stats.levels, 6) || '-';
    return [
      '最近会话: ' + latestSessionId,
      '级别统计: ' + levelSummary,
      '事件统计: ' + typeSummary,
      'Host统计: ' + hostSummary
    ].join('\n');
  }

  function formatLogLine(e) {
    var rawType = getLogType(e);
    var type = sanitizeLogExportLabel(rawType);
    var line = '[' + sanitizeLogExportLabel(e.ts || '') + '] [' + sanitizeLogExportLabel(e.src || '?') + ':' + sanitizeLogExportLabel(e.lv || '?') + '] ';
    if (type) line += '[' + type + '] ';
    if (!rawType || e.msg !== rawType) line += sanitizeLogExportText(e.msg || '');
    if (e.tsUtc) line += ' | utc=' + sanitizeLogExportLabel(e.tsUtc);
    var timezoneOffset = formatTimezoneOffset(e.timezoneOffsetMinutes);
    if (timezoneOffset) line += ' | tz=' + timezoneOffset;
    if (e.timezone) line += ' | timezone=' + sanitizeLogExportLabel(e.timezone);
    if (e.sessionId) line += ' | session=' + sanitizeLogExportLabel(e.sessionId);
    if (e.pageHost) line += ' | pageHost=' + sanitizeLogExportLabel(e.pageHost);
    var data = getLogDataText(e);
    if (data) line += ' | ' + data;
    return line;
  }

  function buildLogExportText(logs, version, exportDate, exportOffsetMinutes, exportTimezone) {
    var parts = [
      '=== 文章缩略图预览 v' + version + ' 诊断日志 ===\n',
      '导出时间: ' + formatLocalTimestamp(exportDate) + '\n',
      '导出UTC: ' + exportDate.toISOString() + '\n',
      '导出时区: ' + formatTimezoneOffset(exportOffsetMinutes) + (exportTimezone ? ' ' + exportTimezone : '') + '\n',
      '日志条数: ' + logs.length + '\n',
      buildLogSummaryText(logs) + '\n',
      '================================\n\n'
    ];
    for (var i = 0; i < logs.length; i++) {
      parts.push(formatLogLine(logs[i]), '\n');
    }
    return parts.join('');
  }

  els.exportLogs.addEventListener('click', function() {
    runButtonAction(els.exportLogs, '导出中...', function(result) {
      return result === 'empty' ? '无日志' : '已导出!';
    }, '导出日志', async function() {
      var logs = await loadLogEntries({ allowDiscovery: true, prune: true });
      if (els.logPanel && !els.logPanel.classList.contains('hidden')) {
        loadedLogEntries = logs;
        renderLoadedLogs(loadedLogEntries);
      }
      if (!logs.length) {
        return 'empty';
      }
      var version = chrome.runtime.getManifest().version;
      var exportDate = new Date();
      var exportOffsetMinutes = -exportDate.getTimezoneOffset();
      var exportTimezone = getTimezoneName();
      var text = buildLogExportText(logs, version, exportDate, exportOffsetMinutes, exportTimezone);
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'thumbnail-preview-logs-' + formatLocalFilenameTimestamp(exportDate) + '.txt';
      a.click();
      URL.revokeObjectURL(url);
      if (!els.logPanel || els.logPanel.classList.contains('hidden')) {
        els.logCount.textContent = logs.length;
      }
    });
  });

  els.clearLogs.addEventListener('click', function() {
    runDestructiveButtonAction(els.clearLogs, '再次点击清空', '再次点击确认清空诊断日志', '清空中...', '已清空!', '清空日志', async function() {
      var names = await storageGetKeys('发现日志键');
      var logKeys = getLogKeysFromNames(names);
      await removeKeysWithLogClearMarker(collectUniqueKeys([logKeys], LOG_KEY_INDEX), '清空日志');
      invalidateLogLoadState();
      loadedLogEntries = [];
      renderLoadedLogs(loadedLogEntries);
    });
  });

  function renderSettingsGroup(groupName, items) {
    var groupMeta = typeof ATPGetSettingsGroupMeta === 'function' ? ATPGetSettingsGroupMeta(groupName) : {};
    var collapsible = !!groupMeta.collapsible;
    var html = collapsible
      ? '<details class="settings-section settings-section-collapsible"' + (groupMeta.collapsed === false ? ' open' : '') + '><summary class="settings-section-summary">' + esc(groupName) + '</summary><div class="settings-section-body">'
      : '<section class="settings-section"><h2>' + esc(groupName) + '</h2>';
    if (groupName === '加载') {
      html += '<div class="setting-row setting-row-presets"><span class="setting-preset-label">弱图加载预设</span><span class="setting-preset-actions">' +
        '<button class="btn-ordinary-preset" type="button" data-preset="ordinaryGentle" title="100M：可见 6 / 后台 1 / 同域 6">100M</button>' +
        '<button class="btn-ordinary-preset" type="button" data-preset="ordinaryBalanced" title="200M：可见 8 / 后台 2 / 同域 8">200M</button>' +
        '<button class="btn-ordinary-preset" type="button" data-preset="ordinaryFast" title="推荐：可见 12 / 后台 2 / 同域 10">高速（推荐）</button>' +
        '</span></div>';
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.type === 'boolean') {
        html += '<div class="setting-row"><label><input type="checkbox" id="' + esc(item.key) + '"> ' + esc(item.label) + '</label>';
        if (item.key === 'heavyImageOptimization') {
          html += '<button class="btn-heavy-preset" type="button">恢复原始预设</button>';
        }
        html += '</div>';
      } else if (item.type === 'select') {
        html += '<div class="setting-row"><label for="' + esc(item.key) + '">' + esc(item.label) + '</label><span class="input-wrap"><select id="' + esc(item.key) + '">';
        (item.options || []).forEach(function(o) {
          html += '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>';
        });
        html += '</select></span></div>';
      } else {
        var range = (item.min !== undefined && item.max !== undefined) ? ' <small>' + esc(item.min) + '-' + esc(item.max) + '</small>' : '';
        html += '<div class="setting-row"><label for="' + esc(item.key) + '">' + esc(item.label) + range + '</label><span class="input-wrap"><input type="number" id="' + esc(item.key) + '" min="' + (item.min !== undefined ? esc(item.min) : '') + '" max="' + (item.max !== undefined ? esc(item.max) : '') + '" step="' + esc(item.step || 1) + '"><button class="btn-reset" type="button" data-key="' + esc(item.key) + '" title="恢复默认" aria-label="恢复' + esc(item.label) + '默认值">↺</button></span></div>';
      }
    }
    if (groupName === '高级') {
      html += '<div class="setting-row setting-row-site-disable"><label><input type="checkbox" id="disableSite"> 仅在此站点禁用</label><span id="disableSiteHint" class="site-disable-hint site-disable-hint-empty" role="status" aria-live="polite"></span></div>';
    }
    html += collapsible ? '</div></details>' : '</section>';
    return html;
  }

  function renderSettingsUI() {
    if (typeof SETTINGS_SCHEMA === 'undefined') return;
    var groups = {};
    SETTINGS_SCHEMA.forEach(function(item) {
      if (!groups[item.group]) groups[item.group] = [];
      groups[item.group].push(item);
    });

    var html = '';
    var rendered = {};
    var groupOrder = ['显示', '加载', '高级', '专家调优', '资源'];
    for (var g = 0; g < groupOrder.length; g++) {
      var groupName = groupOrder[g];
      var items = groups[groupName];
      if (!items || !items.length) continue;
      rendered[groupName] = true;
      html += renderSettingsGroup(groupName, items);
    }
    for (var gn in groups) {
      if (rendered[gn]) continue;
      html += renderSettingsGroup(gn, groups[gn]);
    }

    els.settingsContainer.innerHTML = html;
  }

  function bindSchemaControls() {
    if (typeof SETTINGS_SCHEMA === 'undefined') return;
    SETTINGS_SCHEMA.forEach(function(item) {
      var el = document.getElementById(item.key);
      if (!el) return;
      el.addEventListener('input', function() {
        if (item.type === 'number' || el.tagName === 'SELECT') markSettingInputDirty(el);
      });
      el.addEventListener('focusout', function() {
        clearSettingInputDirty(item.key);
      });
      el.addEventListener('change', function() {
        if (!ensureSettingsReady(el)) return;
        var previous = settings[item.key];
        if (item.type === 'number' && item.min !== undefined && item.max !== undefined) {
          var val = parseInt(el.value, 10);
          if (isNaN(val) || val < item.min || val > item.max) {
            el.value = settings[item.key];
            reportNumberInputError(el, item);
            return;
          }
          clearInputError(el);
          settings[item.key] = val;
          clearSettingInputDirty(item.key);
        } else if (el.type === 'checkbox') {
          settings[item.key] = el.checked;
        } else {
          settings[item.key] = el.value;
          clearSettingInputDirty(item.key);
        }
        if (['gridCols','visibleRows'].indexOf(item.key) !== -1) updateFirstScreen();
        updateDependentControls();
        var attempt = markSettingSaveAttempt(item.key, settings[item.key]);
        saveSettings(getSettingsApplyMode([item.key]), [item.key]).catch(function(e) {
          if (isSettingSaveAttemptCurrent(attempt)) {
            rollbackSettingValue(item.key, previous, el);
          }
          console.warn('[popup] 保存设置失败:', errorMessage(e));
        });
      });
    });
  }

  function bindResetButtons() {
    els.settingsContainer.addEventListener('click', function(e) {
      var ordinaryPresetBtn = e.target.closest('.btn-ordinary-preset');
      if (ordinaryPresetBtn) {
        applyOrdinaryPresetButton(ordinaryPresetBtn);
        return;
      }
      var presetBtn = e.target.closest('.btn-heavy-preset');
      if (presetBtn) {
        if (!ensureSettingsReady(presetBtn)) return;
        if (presetBtn.__atpBusy) return;
        if (!settings.heavyImageOptimization) return;
        var previousPreset = Object.assign({}, settings);
        forEachHeavyOriginalPreset(function(key) {
          settings[key] = HEAVY_ORIGINAL_PRESET[key];
          setUIValue(key);
        });
        updateDependentControls();
        setButtonBusy(presetBtn, true);
        var presetKeys = [];
        forEachHeavyOriginalPreset(function(key) { presetKeys.push(key); });
        var attempts = markSettingsSaveAttempt(presetKeys);
        saveSettings(getSettingsApplyMode(presetKeys), presetKeys).catch(function(err) {
          if (areSettingSaveAttemptsCurrent(attempts)) {
            settings = previousPreset;
            forEachHeavyOriginalPreset(function(key) { setUIValue(key); });
            updateFirstScreen();
            updateDependentControls();
            flashError(presetBtn);
          }
          console.warn('[popup] 恢复重图预设失败:', errorMessage(err));
        }).finally(function() {
          setButtonBusy(presetBtn, false);
          updateDependentControls();
        });
        return;
      }
      var btn = e.target.closest('.btn-reset');
      if (!btn) return;
      if (!ensureSettingsReady(btn)) return;
      var key = btn.getAttribute('data-key');
      if (!(key in DEFAULTS)) return;
      var previous = settings[key];
      settings[key] = DEFAULTS[key];
      var el = document.getElementById(key);
      if (el) {
        if (el.type === 'checkbox') el.checked = DEFAULTS[key];
        else el.value = DEFAULTS[key];
        clearInputError(el);
      }
      if (['gridCols','visibleRows'].indexOf(key) !== -1) updateFirstScreen();
      updateDependentControls();
      var attempt = markSettingSaveAttempt(key, settings[key]);
      saveSettings(getSettingsApplyMode([key]), [key]).catch(function(e) {
        if (isSettingSaveAttemptCurrent(attempt)) {
          rollbackSettingValue(key, previous, el);
        }
        console.warn('[popup] 保存设置失败:', errorMessage(e));
      });
    });
  }

  function bindDisableSite() {
    var el = document.getElementById('disableSite');
    if (!el) return;
    el.addEventListener('change', function() {
      if (!ensureSettingsReady(el)) return;
      var hostname = currentSiteHost;
      if (!hostname) {
        el.checked = false;
        el.disabled = true;
        setPopupStatus('当前页面不支持站点禁用', 'err', true);
        flashError(el);
        return;
      }
      if (!settings.siteConfigs[hostname]) settings.siteConfigs[hostname] = {};
      var previous = settings.siteConfigs[hostname].disabled;
      settings.siteConfigs[hostname].disabled = el.checked;
      var attempt = markSiteSaveAttempt(hostname, el.checked);
      var sitePatch = { siteConfigs: {} };
      sitePatch.siteConfigs[hostname] = { disabled: el.checked };
      saveSettings(getSettingsApplyMode(['siteConfigs']), ['siteConfigs'], sitePatch).catch(function(e) {
        if (isSiteSaveAttemptCurrent(attempt)) {
          settings.siteConfigs[hostname].disabled = previous;
          el.checked = !!previous;
          flashError(el);
        }
        console.warn('[popup] 保存站点设置失败:', errorMessage(e));
      });
    });
  }

  if (typeof window !== 'undefined' && window.__ATP_VERIFY_POPUP__) {
    window.__ATPLogExportTest = {
      getLogDataText: getLogDataText,
      buildLogSummaryText: buildLogSummaryText,
      formatLogLine: formatLogLine,
      renderLogEntry: renderLogEntry,
      isLogKey: isLogKey,
      getLogKeysForRead: getLogKeysForRead,
      discoverLogKeysFromStorage: discoverLogKeysFromStorage,
      refreshLogCount: refreshLogCount,
      loadLogEntries: loadLogEntries,
      loadLogs: loadLogs,
      scheduleLogReload: scheduleLogReload,
      renderLoadedLogs: renderLoadedLogs,
      getLoadedLogEntries: function() { return loadedLogEntries; },
      isLogLoadInFlight: function() { return logLoadInFlight; }
    };
    window.__ATPPopupTest = {
      applySavedSettings: applySavedSettings,
      bindSchemaControls: bindSchemaControls,
      bindDisableSite: bindDisableSite,
      renderHelpFromSchema: renderHelpFromSchema,
      runButtonAction: runButtonAction,
      runDestructiveButtonAction: runDestructiveButtonAction,
      armDestructiveConfirm: armDestructiveConfirm,
      handlePopupKeydown: handlePopupKeydown,
      countExistingKeys: countExistingKeys,
      getCacheKeysByTypes: getCacheKeysByTypes,
      clearCacheTypes: clearCacheTypes,
      markCacheGeneration: markCacheGeneration,
      removeCacheKeys: removeCacheKeys,
      removeCacheIndexEntries: removeCacheIndexEntries,
      clearTestCacheAndLogs: clearTestCacheAndLogs,
      formatCacheCleanupSuccess: formatCacheCleanupSuccess,
      formatFullCleanupSuccess: formatFullCleanupSuccess,
      setDisableSiteHost: setDisableSiteHost,
      setSettingsControlsDisabled: setSettingsControlsDisabled,
      saveSettings: saveSettings,
      refreshCurrentPage: refreshCurrentPage,
      loadUI: loadUI,
      getSettings: function() { return settings; }
    };
  }

  document.addEventListener('DOMContentLoaded', function() {
    var version = chrome.runtime.getManifest().version;
    var footer = document.getElementById('versionFooter');
    if (footer) footer.textContent = 'v' + version + ' | 技术学习交流';
    renderSettingsUI();
    bindSchemaControls();
    bindResetButtons();
    bindDisableSite();
    // 弹窗打开期间设置被外部修改（悬浮面板/另一窗口）时同步 UI；
    // setUIValue 内部已保护正在编辑的输入框不被覆盖
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function(changes, area) {
        if (area !== 'local' || !changes.settings) return;
        if (settingsLoadFailed || !settings) return;
        applySavedSettings(changes.settings.newValue);
      });
    }
    setSettingsControlsDisabled(true);
    setPopupStatus('正在读取设置...', 'info', true);
    loadUI().catch(function(e) {
      settingsLoadFailed = true;
      settings = ATPNormalizeSettings({ enabled: false });
      // 同步头部开关显示，避免读取失败时仍显示「已启用」的误导状态
      if (els.toggleEnabled) els.toggleEnabled.checked = false;
      setSettingsControlsDisabled(true);
      setPopupStatus('设置读取失败：' + errorMessage(e), 'err', true);
      console.warn('[popup] 加载设置失败:', errorMessage(e));
    });
    refreshLogCount();
    renderHelpFromSchema();
  });

  function renderHelpFromSchema() {
    if (typeof SETTINGS_SCHEMA === 'undefined') return;
    var groups = {};
    SETTINGS_SCHEMA.forEach(function(item) {
      if (!groups[item.group]) groups[item.group] = [];
      groups[item.group].push(item);
    });
    var staticHelp = {
      '维护': [
        { label: '↺ 按钮', desc: '点击将该项恢复为默认值，其他项不变。' },
        { label: '清除文章/图片缓存', desc: '删除文章提取结果和已缓存图片，刷新后重新抓取；不清除 TXT 资源缓存。' },
        { label: '清除失败缓存', desc: '删除"无图"标记和 TXT 解析失败标记，让之前被误判的帖子或附件可立即重试。' },
        { label: '清除全部缓存', desc: '同时清除文章/图片缓存、TXT 资源缓存和失败缓存。' },
        { label: '恢复默认设置', desc: '重置所有设置为出厂默认值（保留站点禁用列表）。' }
      ],
      '高级': [
        { label: '仅在此站点禁用', desc: '勾选后当前站点停止缩略图预览。' }
      ]
    };
    function formatDefaultValue(item) {
      if (item.type === 'boolean') return item.default ? '开启' : '关闭';
      if (item.type === 'select') {
        var options = item.options || [];
        for (var oi = 0; oi < options.length; oi++) {
          if (options[oi].value === item.default) return options[oi].label;
        }
      }
      return String(item.default) + (item.unit || '');
    }
    var html = '';
    for (var groupName in groups) {
      html += '<div class="help-cat">' + esc(groupName) + '</div>';
      groups[groupName].forEach(function(item) {
        html += '<div class="help-item"><b>' + esc(item.label) + '</b> — ' + esc(item.description);
        if (item.min !== undefined && item.max !== undefined) {
          html += ' [' + esc(item.min) + '-' + esc(item.max) + ']';
        }
        html += ' 默认' + esc(formatDefaultValue(item)) + '。</div>';
      });
      if (staticHelp[groupName]) {
        staticHelp[groupName].forEach(function(h) {
          html += '<div class="help-item"><b>' + esc(h.label) + '</b> — ' + esc(h.desc) + '</div>';
        });
      }
    }
    for (var sn in staticHelp) {
      if (groups[sn]) continue;
      html += '<div class="help-cat">' + esc(sn) + '</div>';
      staticHelp[sn].forEach(function(h) {
        html += '<div class="help-item"><b>' + esc(h.label) + '</b> — ' + esc(h.desc) + '</div>';
      });
    }
    els.helpPanel.innerHTML = html;
  }
})();
