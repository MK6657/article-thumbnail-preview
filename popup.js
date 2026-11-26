(function () {
  'use strict';

  var els = {};
  (function() {
    var ids = [
      'toggleEnabled', 'versionBadge', 'currentSiteDot', 'currentSite', 'firstScreenInfo',
      'jumpToMirrorBtn', 'currentForumPace', 'popupStatus',
      'popupTabList', 'tabBtnOverview', 'tabBtnMarks', 'tabBtnSettings', 'tabBtnLogs',
      'tabMarksCount', 'tabLogCount',
      'tabPanelOverview', 'tabPanelMarks', 'tabPanelSettings', 'tabPanelLogs',
      'presetCardsContainer', 'quickSettingsContainer', 'settingsContainer',
      'cacheStatsSummary',
      'clearImageCache', 'clearFailCache', 'clearAllCache', 'clearTestCache',
      'resetSettings', 'resetForumPacer', 'forumPacerInfo',
      'toggleLogs', 'logPanel', 'logViewer', 'logCount', 'logFilter', 'logSearch', 'exportLogs', 'clearLogs',
      'toggleHelp', 'helpPanel',
      'marksSection', 'marksHeading', 'marksCount', 'marksSummary', 'marksSearchWrap', 'marksSearch',
      'marksList', 'exportMarks', 'copyMarks', 'clearExportedMarks', 'clearAllMarks',
      'backupSection', 'backupCount', 'backupList', 'downloadAllBackups',
      'mirrorSection', 'addCurrentMirror'
    ];
    for (var i = 0; i < ids.length; i++) { els[ids[i]] = document.getElementById(ids[i]); }
  })();

  var DEFAULTS = ATP_DEFAULTS;
  var CACHE_GENERATION_KEY = (typeof SharedUtils !== 'undefined' && SharedUtils.CACHE_GENERATION_KEY) || 'atp_cache_generation_v1';
  var popupStatusTimer = null;
  var saveStatusSeq = 0;
  var saveWriteChain = Promise.resolve();
  var pendingSettingsWrites = new Map();
  var dirtySettingInputByKey = {};
  var settingsLoadFailed = false;
  var DESTRUCTIVE_CONFIRM_MS = 3000;
  var pendingDestructiveButton = null;
  var CACHE_PREFIXES = (typeof SharedUtils !== 'undefined' && SharedUtils.CACHE_PREFIXES) || {
    IMAGE: 'thumb_cache_v2_',
    ARTICLE: 'article_cache_v12_',
    TEXT_RESOURCE: 'txt_resource_cache_v3_',
    TEXT_FAIL: 'atp_text_fail_v1_',
    NEGATIVE: 'atp_empty_v9_',
    IMAGE_BASE: 'thumb_cache_',
    ARTICLE_BASE: 'article_cache_',
    TEXT_RESOURCE_BASE: 'txt_resource_cache_',
    TEXT_FAIL_BASE: 'atp_text_fail_',
    NEGATIVE_BASE: 'atp_empty_'
  };
  var HEAVY_ORIGINAL_PRESET = ATPGetSettingsPreset('heavyOriginal', SETTINGS_SCHEMA);

  var confirmedSettings = null;
  var settings = null;
  var currentSiteHost = '';
  var currentForumPaceHost = '';
  var activeTabName = 'overview';

  function esc(s) {
    if (typeof SharedUtils !== 'undefined' && SharedUtils && typeof SharedUtils.escapeHtml === 'function') {
      return SharedUtils.escapeHtml(s);
    }
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function(ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

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

  function clearInputError(el) {
    if (!el || typeof el.removeAttribute !== 'function') return;
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
    var error = el.id && document.getElementById(el.id + '-error');
    if (error) error.textContent = '';
  }

  function reportNumberInputError(el, item) {
    if (!el || !item) return;
    el.setAttribute('aria-invalid', 'true');
    var errorId = item.key + '-error';
    var error = document.getElementById(errorId);
    el.setAttribute('aria-describedby', errorId);
    if (error) error.textContent = ATPGetNumberSettingError(item);
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

  // ---- Logs subsystem wired from popup-logs.js ----
  var popupLogs = typeof ATPPopupLogs !== 'undefined' && ATPPopupLogs && typeof ATPPopupLogs.create === 'function'
    ? ATPPopupLogs.create({
        els: els,
        storageGet: storageGet,
        storageGetKeys: storageGetKeys,
        storageSet: storageSet,
        storageRemove: storageRemove,
        setPopupStatus: setPopupStatus,
        setDisclosureState: setDisclosureState,
        runButtonAction: runButtonAction,
        esc: esc,
        errorMessage: errorMessage,
        formatLocalTimestamp: formatLocalTimestamp,
        formatLocalFilenameTimestamp: formatLocalFilenameTimestamp,
        appendUniqueKeys: appendUniqueKeys,
        collectUniqueKeys: collectUniqueKeys
      })
    : null;

  // ---- Segmented 4-Tab Navigation ----
  var TAB_ORDER = ['overview', 'marks', 'settings', 'logs'];

  function switchPopupTab(tabName, focusTabBtn) {
    if (TAB_ORDER.indexOf(tabName) === -1) tabName = 'overview';
    activeTabName = tabName;
    var tabButtons = [
      ['overview', els.tabBtnOverview, els.tabPanelOverview],
      ['marks', els.tabBtnMarks, els.tabPanelMarks],
      ['settings', els.tabBtnSettings, els.tabPanelSettings],
      ['logs', els.tabBtnLogs, els.tabPanelLogs]
    ];
    for (var i = 0; i < tabButtons.length; i++) {
      var name = tabButtons[i][0];
      var btn = tabButtons[i][1];
      var panel = tabButtons[i][2];
      var selected = name === tabName;
      if (btn) {
        if (btn.classList) btn.classList.toggle('is-active', selected);
        btn.setAttribute('aria-selected', selected ? 'true' : 'false');
        btn.setAttribute('tabindex', selected ? '0' : '-1');
        if (selected && focusTabBtn && typeof btn.focus === 'function') btn.focus();
      }
      if (panel) {
        if (panel.classList) panel.classList.toggle('hidden', !selected);
        panel.hidden = !selected;
      }
    }
    if (tabName === 'settings') {
      refreshCacheStatsDisplay();
    } else if (tabName === 'logs' && popupLogs) {
      popupLogs.onTabActivated();
    }
  }

  function bindTabNavigation() {
    if (!els.popupTabList) return;
    els.popupTabList.addEventListener('click', function(e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-tab]') : null;
      if (!btn) return;
      switchPopupTab(btn.getAttribute('data-tab'), false);
    });
    els.popupTabList.addEventListener('keydown', function(e) {
      var idx = TAB_ORDER.indexOf(activeTabName);
      if (idx === -1) idx = 0;
      var nextIdx = -1;
      if (e.key === 'ArrowRight') nextIdx = (idx + 1) % TAB_ORDER.length;
      else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = TAB_ORDER.length - 1;
      if (nextIdx !== -1) {
        e.preventDefault();
        switchPopupTab(TAB_ORDER[nextIdx], true);
      }
    });
    if (els.jumpToMirrorBtn) {
      els.jumpToMirrorBtn.addEventListener('click', function() {
        switchPopupTab('settings', false);
        if (els.mirrorSection) els.mirrorSection.open = true;
        if (els.addCurrentMirror && !els.addCurrentMirror.classList.contains('hidden') && typeof els.addCurrentMirror.focus === 'function') {
          els.addCurrentMirror.focus();
        }
      });
    }
  }

  // ---- Cache stats & maintenance ----
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

  function formatBytesSize(bytes) {
    var n = Math.max(0, Number(bytes) || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (Math.round((n / 1024) * 10) / 10) + ' KB';
    return (Math.round((n / (1024 * 1024)) * 100) / 100) + ' MB';
  }

  function readCacheBytesUsed() {
    return new Promise(function(resolve) {
      if (typeof SharedUtils === 'undefined' || typeof SharedUtils.getCacheBytesInUse !== 'function') {
        resolve(null);
        return;
      }
      if (!chrome || !chrome.storage || !chrome.storage.local || typeof chrome.storage.local.getBytesInUse !== 'function') {
        resolve(null);
        return;
      }
      try {
        SharedUtils.getCacheBytesInUse(function(bytes) {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(typeof bytes === 'number' && isFinite(bytes) ? Math.max(0, bytes) : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function refreshCacheStatsDisplay() {
    if (!els.cacheStatsSummary) return;
    try {
      var pair = await Promise.all([
        readCacheIndex({ rebuild: false }),
        readCacheBytesUsed()
      ]);
      var entries = pair[0];
      var bytes = pair[1];
      var T = SharedUtils && SharedUtils.cacheIndex && SharedUtils.cacheIndex.TYPE;
      var articleCount = 0;
      var totalCount = 0;
      if (entries && typeof entries === 'object') {
        for (var key in entries) {
          if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
          totalCount++;
          var entry = entries[key];
          if (entry && T && entry.t === T.ARTICLE) articleCount++;
        }
      }
      var parts = [];
      if (entries && typeof entries === 'object') {
        parts.push('已缓存 ' + articleCount + ' 篇帖子');
        if (totalCount > articleCount) parts.push('共 ' + totalCount + ' 项');
      }
      if (bytes !== null) {
        parts.push('占用 ' + formatBytesSize(bytes));
      }
      els.cacheStatsSummary.textContent = parts.length ? parts.join(' · ') : '暂无缓存统计';
    } catch (e) {
      els.cacheStatsSummary.textContent = '暂无缓存统计';
    }
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
    var res = await removeCacheKeys(keys);
    refreshCacheStatsDisplay();
    return res;
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
    var logKeys = popupLogs ? popupLogs.getLogKeysFromNames(storageNames) : [];
    var logIndexKey = popupLogs ? popupLogs.LOG_KEY_INDEX : 'atp_logs_content_keys';
    var keys = collectUniqueKeys([cacheKeys, logKeys], logIndexKey);
    var removedCount = countExistingKeysFromNames(keys, storageNames);
    if (popupLogs) {
      await popupLogs.removeKeysWithLogClearMarker(keys, '一键清空缓存');
      popupLogs.resetAfterMaintenanceClear();
    } else {
      await storageRemove(keys, '一键清空缓存');
    }
    await markCacheGeneration();
    var cacheIndexStatus = await removeCacheIndexEntries(cacheKeys);
    refreshCacheStatsDisplay();
    return { count: removedCount, cacheIndexStatus: cacheIndexStatus };
  }

  // ---- Settings Save & Live/HotReload/PageReload ----
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

  function settingsWithPatches(base, patches) {
    var next = Object.assign({}, base, { siteConfigs: cloneSiteConfigsForSave(base.siteConfigs) });
    patches.forEach(function(patch) {
      Object.keys(patch).forEach(function(key) {
        if (key !== 'siteConfigs') next[key] = patch[key];
      });
      Object.keys(patch.siteConfigs || {}).forEach(function(host) {
        next.siteConfigs[host] = Object.assign({}, next.siteConfigs[host], patch.siteConfigs[host]);
      });
    });
    return next;
  }

  function applySavedSettings(savedSettings) {
    confirmedSettings = ATPNormalizeSettings(savedSettings);
    settings = settingsWithPatches(confirmedSettings, pendingSettingsWrites);
    renderSettingsFields(getAllSettingsPatchKeys().concat('siteConfigs'));
  }

  function renderSettingsFields(keys) {
    keys.forEach(function(key) {
      if (key === 'enabled') {
        if (els.toggleEnabled) els.toggleEnabled.checked = settings.enabled;
      } else if (key === 'siteConfigs') {
        var disableEl = getSettingEl('disableSite');
        if (disableEl && disableEl.__atpHostname) {
          disableEl.checked = !!((settings.siteConfigs[disableEl.__atpHostname] || {}).disabled);
        }
        syncSiteDot();
      } else {
        setUIValue(key);
      }
    });
    if (
      keys.indexOf('gridCols') !== -1 ||
      keys.indexOf('visibleRows') !== -1 ||
      keys.indexOf('heavyImageOptimization') !== -1 ||
      keys.indexOf('heavyThumbnailClarity') !== -1
    ) {
      updateFirstScreen();
    }
    updateDependentControls();
  }

  function getRevertedSettingsKeys(snapshot, previous) {
    return Object.keys(snapshot).filter(function(key) {
      if (key !== 'siteConfigs') return settings[key] !== previous[key];
      return Object.keys(snapshot.siteConfigs || {}).some(function(host) {
        var before = previous.siteConfigs[host] || {};
        var after = settings.siteConfigs[host] || {};
        return !!before.disabled !== !!after.disabled;
      });
    });
  }

  function formatRefreshFailureStatus(refreshResult, prefix) {
    var message = refreshResult && refreshResult.error ? refreshResult.error : '未知错误';
    return (prefix || '已保存') + '，但刷新当前页失败：' + message;
  }

  function getSettingsApplyMode(changedKeys) {
    return ATPGetSettingsApplyMode(changedKeys, typeof SETTINGS_SCHEMA !== 'undefined' ? SETTINGS_SCHEMA : []);
  }

  async function saveSettings(applyMode, changedKeys, patchOverride, errorControl) {
    if (settingsLoadFailed || !settings) throw new Error('settings not loaded');
    var seq = ++saveStatusSeq;
    var snapshot = patchOverride || cloneSettingsForSave(settings, changedKeys);
    pendingSettingsWrites.set(seq, snapshot);
    applyMode = applyMode || getSettingsApplyMode(changedKeys);
    setPopupStatus('保存中...', 'info', true);
    var savedSettings;
    try {
      savedSettings = await queueSettingsWrite(snapshot);
    } catch (e) {
      var previous = settings;
      pendingSettingsWrites.delete(seq);
      settings = settingsWithPatches(confirmedSettings, pendingSettingsWrites);
      var revertedKeys = getRevertedSettingsKeys(snapshot, previous);
      if (revertedKeys.length) {
        renderSettingsFields(revertedKeys);
        if (errorControl) flashError(errorControl);
      }
      if (seq === saveStatusSeq) {
        setPopupStatus('保存失败：' + errorMessage(e), 'err', true);
      }
      throw e;
    }
    pendingSettingsWrites.delete(seq);
    applySavedSettings(savedSettings || settingsWithPatches(confirmedSettings, [snapshot]));
    if (seq !== saveStatusSeq) return;
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
      if (refreshResult.liveApplied) {
        setPopupStatus('已保存，当前页已即时生效', 'ok');
        return { ok: true, refresh: refreshResult };
      }
      setPopupStatus('已保存，刷新后生效', 'ok');
      return { ok: true, refresh: refreshResult };
    }
    setPopupStatus(applyMode === 'hotReload' ? '已保存，缩略图已自动重新加载' : '已保存', 'ok');
    return { ok: true };
  }

  function pingContentScriptInTab(tabId) {
    return new Promise(function(resolve) {
      if (!chrome.tabs || typeof chrome.tabs.sendMessage !== 'function') {
        resolve(false);
        return;
      }
      var settled = false;
      var timer = setTimeout(function() {
        if (settled) return;
        settled = true;
        resolve(false);
      }, 240);
      try {
        chrome.tabs.sendMessage(tabId, { type: 'ATP_FLUSH_CONTENT_LOGS' }, function(response) {
          var runtimeError = chrome.runtime.lastError;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(!runtimeError && !!(response && response.ok === true));
        });
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      }
    });
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
          var tabHost = getTabHostname(tab.url);
          if (!tabHost || !SharedUtils.isSupportedForumHost(tabHost)) {
            resolve({ ok: true, skipped: true });
            return;
          }
          pingContentScriptInTab(tab.id).then(function(alive) {
            if (alive) {
              resolve({ ok: true, liveApplied: true });
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
        });
      } catch (e) {
        resolve({ ok: false, error: errorMessage(e) });
      }
    });
  }

  function updateFirstScreen() {
    if (!els.firstScreenInfo || !settings) return;
    var cols = settings.gridCols || 5;
    var rows = settings.visibleRows || 2;
    var n = cols * rows;
    if (settings.heavyImageOptimization && settings.heavyThumbnailClarity !== 'lightweight') {
      els.firstScreenInfo.textContent = n + ' 张 · 重图首行 ' + cols + ' 张';
    } else {
      els.firstScreenInfo.textContent = n + ' 张';
    }
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

  function flashError(el) {
    if (!el || !el.classList) return;
    el.classList.add('input-error');
    setTimeout(function() { el.classList.remove('input-error'); }, 800);
  }

  function getSettingEl(key) { return document.getElementById(key); }

  function getSettingsRoots() {
    var roots = [];
    if (els.presetCardsContainer) roots.push(els.presetCardsContainer);
    if (els.quickSettingsContainer) roots.push(els.quickSettingsContainer);
    if (els.settingsContainer) roots.push(els.settingsContainer);
    return roots;
  }

  function queryInSettingsRoots(selector) {
    var roots = getSettingsRoots();
    for (var i = 0; i < roots.length; i++) {
      if (roots[i] && typeof roots[i].querySelector === 'function') {
        var found = roots[i].querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }

  function markSettingInputDirty(el) {
    if (!el || !el.id) return;
    dirtySettingInputByKey[el.id] = true;
  }

  function clearSettingInputDirty(key) {
    if (!key) return;
    delete dirtySettingInputByKey[key];
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
      var reset = queryInSettingsRoots('.btn-reset[data-key="' + item.key + '"]');
      if (reset) {
        reset.disabled = !enabled;
        if (settings && typeof ATPSettingsUI !== 'undefined' && ATPSettingsUI.syncResetButtonState) {
          ATPSettingsUI.syncResetButtonState(reset, item, settings);
        }
      }
    });
    var heavyPreset = queryInSettingsRoots('.btn-heavy-preset');
    if (heavyPreset && settings) heavyPreset.disabled = !settings.heavyImageOptimization;
    if (typeof ATPSettingsUI !== 'undefined' && ATPSettingsUI.syncPresetButtons) {
      var roots = getSettingsRoots();
      for (var ri = 0; ri < roots.length; ri++) {
        ATPSettingsUI.syncPresetButtons(roots[ri], settings, SETTINGS_SCHEMA);
      }
    }
  }

  function setSettingsControlsDisabled(disabled) {
    if (els.toggleEnabled) els.toggleEnabled.disabled = !!disabled;
    if (els.resetSettings) els.resetSettings.disabled = !!disabled;
    var disableSite = getSettingEl('disableSite');
    if (disabled && disableSite) disableSite.disabled = true;
    if (els.settingsContainer) els.settingsContainer.setAttribute('aria-busy', disabled && !settings ? 'true' : 'false');
    var roots = getSettingsRoots();
    for (var r = 0; r < roots.length; r++) {
      var root = roots[r];
      if (!root || !root.querySelectorAll) continue;
      var controls = root.querySelectorAll('input, select, button');
      for (var i = 0; i < controls.length; i++) {
        controls[i].disabled = !!disabled;
        if (disabled && controls[i].matches && controls[i].matches('input[type="number"]')) {
          clearInputError(controls[i]);
        }
      }
    }
    if (!disabled && settings) {
      updateDependentControls();
      setDisableSiteHost(currentSiteHost);
    }
  }

  function getTabHostname(url, preserveSubdomain) {
    try {
      var parsed = new URL(url || '');
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      var host = parsed.hostname.replace(/\.$/, '');
      return preserveSubdomain ? host : host.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  function getSupportedTabHostname(url) {
    var host = getTabHostname(url);
    return host && SharedUtils.isSupportedForumHost(host) ? host : '';
  }

  async function waitForMirrorSites() {
    var mirrors = window.ATPPopupMirrors;
    if (!mirrors || !mirrors.ready || typeof mirrors.ready.then !== 'function') return;
    try {
      await mirrors.ready;
    } catch (e) {}
    syncMirrorOfferShortcut();
  }

  function syncMirrorOfferShortcut() {
    if (!els.jumpToMirrorBtn || !els.addCurrentMirror) return;
    var hasOffer = !els.addCurrentMirror.classList.contains('hidden');
    els.jumpToMirrorBtn.classList.toggle('hidden', !hasOffer);
  }

  function syncSiteDot() {
    if (!els.currentSiteDot || !els.currentSiteDot.classList) return;
    els.currentSiteDot.classList.remove('is-supported', 'is-disabled');
    if (!currentSiteHost) return;
    var siteDisabled = !!(settings && (!settings.enabled || (settings.siteConfigs && settings.siteConfigs[currentSiteHost] && settings.siteConfigs[currentSiteHost].disabled)));
    els.currentSiteDot.classList.add(siteDisabled ? 'is-disabled' : 'is-supported');
  }

  function setDisableSiteHost(hostname, paceHost) {
    currentSiteHost = hostname || '';
    if (!currentSiteHost || paceHost !== undefined) {
      currentForumPaceHost = paceHost || '';
      renderForumPacerInfo();
    }
    var disableEl = getSettingEl('disableSite');
    var hintEl = document.getElementById('disableSiteHint');
    if (els.currentSite) els.currentSite.textContent = currentSiteHost || '--';
    syncSiteDot();
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
    disableEl.checked = !!((settings && settings.siteConfigs && settings.siteConfigs[currentSiteHost] || {}).disabled);
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
    for (var i = 0; i < presetKeys.length; i++) {
      var presetKey = presetKeys[i];
      settings[presetKey] = preset[presetKey];
      setUIValue(presetKey);
    }
    updateDependentControls();
    setButtonBusy(presetBtn, true);
    saveSettings(getSettingsApplyMode(presetKeys), presetKeys, null, presetBtn).catch(function(err) {
      console.warn('[popup] 应用加载预设失败:', errorMessage(err));
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

  async function loadUI() {
    var stored = await storageGet('settings', '读取设置');
    settingsLoadFailed = false;
    applySavedSettings(stored.settings);
    setSettingsControlsDisabled(false);
    setDisableSiteHost('');

    clearPopupStatusIfText('正在读取设置...');
    await waitForMirrorSites();
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
        var tabUrl = tabs[0] && tabs[0].url;
        var host = getSupportedTabHostname(tabUrl);
        setDisableSiteHost(host, host ? getTabHostname(tabUrl, true) : '');
      });
    } catch (e) {
      setDisableSiteHost('');
      setPopupStatus('读取当前标签页失败：' + errorMessage(e), 'warn', true);
    }
  }

  function bind(id, key) {
    if (!els[id]) {
      console.warn('[popup] Element not found:', id);
      return;
    }
    els[id].addEventListener('change', function() {
      if (!ensureSettingsReady(els[id])) return;
      if (els[id].type === 'checkbox') {
        settings[key] = els[id].checked;
      } else {
        settings[key] = els[id].value;
      }
      syncSiteDot();
      saveSettings(getSettingsApplyMode([key]), [key], null, els[id]).catch(function(e) {
        console.warn('[popup] 保存设置失败:', errorMessage(e));
      });
    });
  }

  bind('toggleEnabled', 'enabled');

  if (els.clearImageCache) {
    els.clearImageCache.addEventListener('click', function() {
      runDestructiveButtonAction(els.clearImageCache, '再次点击清除', '再次点击确认清除文章与资源缓存', '清除中...', formatCacheCleanupSuccess, '清除文章与资源缓存', async function() {
        var T = SharedUtils.cacheIndex.TYPE;
        return clearCacheTypes([T.IMAGE, T.ARTICLE]);
      });
    });
  }

  if (els.clearFailCache) {
    els.clearFailCache.addEventListener('click', function() {
      runDestructiveButtonAction(els.clearFailCache, '再次点击清除', '再次点击确认清除失败缓存', '清除中...', formatCacheCleanupSuccess, '清除失败缓存', async function() {
        var T = SharedUtils.cacheIndex.TYPE;
        return clearCacheTypes([T.NEGATIVE, T.TEXT_FAIL]);
      });
    });
  }

  if (els.clearAllCache) {
    els.clearAllCache.addEventListener('click', function() {
      runDestructiveButtonAction(els.clearAllCache, '再次点击清除', '再次点击确认清除全部缓存', '清除中...', formatCacheCleanupSuccess, '清除全部缓存', async function() {
        var T = SharedUtils.cacheIndex.TYPE;
        return clearCacheTypes([T.IMAGE, T.ARTICLE, T.TEXT_RESOURCE, T.NEGATIVE, T.TEXT_FAIL]);
      });
    });
  }

  if (els.clearTestCache) {
    els.clearTestCache.addEventListener('click', function() {
      runDestructiveButtonAction(els.clearTestCache, '再次点击清空', '再次点击确认清空缓存和日志', '清空中...', formatFullCleanupSuccess, '一键清空缓存和日志', async function() {
        return clearTestCacheAndLogs();
      });
    });
  }

  if (els.resetSettings) {
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
        setSettingsControlsDisabled(true);
        try {
          var resetKeys = getAllSettingsPatchKeys();
          var snapshot = cloneSettingsForSave(DEFAULTS, resetKeys);
          var saveResult = await saveSettings(getSettingsApplyMode(resetKeys), resetKeys, snapshot);
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
  }

  if (els.toggleHelp) {
    els.toggleHelp.addEventListener('click', function() {
      var expanded = els.helpPanel.classList.contains('hidden');
      setDisclosureState(els.toggleHelp, els.helpPanel, expanded);
    });
  }

  if (popupLogs) {
    popupLogs.bindUI();
  }

  if (els.clearLogs) {
    els.clearLogs.addEventListener('click', function() {
      runDestructiveButtonAction(els.clearLogs, '再次点击清空', '再次点击确认清空诊断日志', '清空中...', '已清空!', '清空日志', async function() {
        if (popupLogs) return popupLogs.clearLogsAction();
      });
    });
  }

  // ---- Forum pacing ----
  var FORUM_PACER_RESET_KEY = 'atp_forum_pacer_reset_at';
  var FORUM_PACER_STATUS_KEY = 'atp_forum_pacer_status_v1';
  var FORUM_PACER_NORMAL_BURST = 10;
  var FORUM_PACER_NORMAL_REFILL_MS = 2000;
  var FORUM_PACER_LIMIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  var FORUM_PACER_IDLE_MAX_AGE_MS = 5 * 60 * 1000;
  var forumPaceReports = {};
  var forumPaceStatusRevision = 0;
  var forumPaceTimer = null;

  function getForumPaceNow(entry, now) {
    if (!entry || typeof entry !== 'object') return null;
    var at = Number(entry.at) || 0;
    var retryAfterUntil = Number(entry.retryAfterUntil) || 0;
    var pauseUntil = Math.max(Number(entry.pauseUntil) || 0, retryAfterUntil);
    var limitsUntil = Number(entry.limitsUntil) || (at ? at + FORUM_PACER_LIMIT_MAX_AGE_MS : 0);
    var idleUntil = Number(entry.idleUntil) || (Math.max(at, pauseUntil) + FORUM_PACER_IDLE_MAX_AGE_MS);
    var learnedBurst = Number(entry.learnedBurst) || FORUM_PACER_NORMAL_BURST;
    var learnedRefillMs = Number(entry.learnedRefillMs) || FORUM_PACER_NORMAL_REFILL_MS;
    if (limitsUntil && now >= limitsUntil) {
      learnedBurst = FORUM_PACER_NORMAL_BURST;
      learnedRefillMs = FORUM_PACER_NORMAL_REFILL_MS;
    }
    var idle = now >= idleUntil;
    var nextAt = limitsUntil > now ? limitsUntil : Infinity;
    if (!idle) nextAt = Math.min(nextAt, idleUntil);
    if (pauseUntil > now) nextAt = Math.min(nextAt, now + ((pauseUntil - now) % 1000 || 1000));
    return {
      burst: (!idle && Number(entry.burst)) || learnedBurst,
      refillMs: (!idle && Number(entry.refillMs)) || learnedRefillMs,
      level: idle ? 0 : Number(entry.level) || 0,
      pauseUntil: pauseUntil,
      retryAfterUntil: retryAfterUntil,
      nextAt: nextAt
    };
  }

  function isForumPaceSlowed(pace, now) {
    return !!pace && (
      pace.burst < FORUM_PACER_NORMAL_BURST ||
      pace.refillMs > FORUM_PACER_NORMAL_REFILL_MS ||
      pace.level > 0 ||
      pace.pauseUntil > now
    );
  }

  function describePace(pace, now) {
    var text = '突发 ' + pace.burst + '，之后每 ' + (Math.round(pace.refillMs / 100) / 10) + ' 秒 1 个';
    if (pace.pauseUntil > now) {
      text += (pace.retryAfterUntil > now ? '，论坛要求等待' : '，暂停中') +
        '（约 ' + Math.ceil((pace.pauseUntil - now) / 1000) + ' 秒）';
    } else if (pace.level > 0) {
      text += '，限流后单路恢复中';
    }
    return text;
  }

  function renderForumPacerInfo() {
    if (forumPaceTimer !== null) {
      clearTimeout(forumPaceTimer);
      forumPaceTimer = null;
    }
    var now = Date.now();
    var hosts = Object.keys(forumPaceReports);
    var slowed = [];
    var currentPace = null;
    var nextAt = Infinity;
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      var pace = getForumPaceNow(forumPaceReports[host], now);
      if (!pace) continue;
      nextAt = Math.min(nextAt, pace.nextAt);
      if (host === currentForumPaceHost) currentPace = pace;
      if (isForumPaceSlowed(pace, now)) slowed.push(host + '：' + describePace(pace, now));
    }
    if (els.currentForumPace) {
      els.currentForumPace.hidden = !currentForumPaceHost;
      var currentText = !currentPace ? '此站点暂无论坛节流记录。' :
        (isForumPaceSlowed(currentPace, now) ? '论坛节流 · ' : '论坛节流正常 · ') + describePace(currentPace, now) + '。';
      if (els.currentForumPace.textContent !== currentText) els.currentForumPace.textContent = currentText;
    }
    if (els.forumPacerInfo) {
      var summary = !hosts.length ? '尚无论坛节流记录，打开论坛页面后会显示当前速度。' :
        (slowed.length ? '论坛节流已放慢。' + slowed.join('；') + '。' : '论坛节流为正常速度（突发 10，之后每 2 秒 1 个）。');
      if (els.forumPacerInfo.textContent !== summary) els.forumPacerInfo.textContent = summary;
    }
    if (Number.isFinite(nextAt)) forumPaceTimer = setTimeout(renderForumPacerInfo, Math.min(nextAt - now, 2147483647));
  }

  function refreshForumPacerInfo() {
    if (!chrome.storage || !chrome.storage.local) return;
    var revision = forumPaceStatusRevision;
    try {
      chrome.storage.local.get(FORUM_PACER_STATUS_KEY, function(result) {
        if (chrome.runtime.lastError || revision !== forumPaceStatusRevision) return;
        forumPaceReports = result && result[FORUM_PACER_STATUS_KEY] || {};
        renderForumPacerInfo();
      });
    } catch (e) {}
  }

  async function resetForumPacing() {
    await chrome.storage.local.set({ [FORUM_PACER_RESET_KEY]: Date.now() });
    return true;
  }

  if (els.resetForumPacer) {
    els.resetForumPacer.addEventListener('click', function() {
      runButtonAction(els.resetForumPacer, '重置中...', '已重置节流速度', '重置论坛节流速度', resetForumPacing);
    });
  }
  if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
    chrome.storage.onChanged.addListener(function(changes, areaName) {
      if (areaName === 'local' && changes && changes[FORUM_PACER_STATUS_KEY]) {
        forumPaceStatusRevision++;
        forumPaceReports = changes[FORUM_PACER_STATUS_KEY].newValue || {};
        renderForumPacerInfo();
      }
    });
  }
  refreshForumPacerInfo();

  // ---- Marked resources and daily backup ----
  var MARKS = typeof ATPMarks !== 'undefined' ? ATPMarks : null;
  var MARKS_LIST_LIMIT = 50;
  var MARKS_ERROR_TEXT = {
    stale: '标记刚刚有变化，请确认列表后再清空',
    not_allowed: '操作被拒绝',
    storage_write_failed: '存储写入失败',
    storage_read_failed: '存储读取失败',
    invalid_snapshot: '导出或复制的资源快照无效'
  };
  var marksIndex = null;
  var backupListSignature = null;
  var marksRefreshTimer = null;
  var marksClearConfirmRev = null;

  function setMarksCountDisplay(count) {
    var num = Number(count) || 0;
    if (els.marksCount) els.marksCount.textContent = num;
    if (els.tabMarksCount) {
      els.tabMarksCount.textContent = num;
      if (els.tabMarksCount.classList) els.tabMarksCount.classList.toggle('has-count', num > 0);
    }
  }

  function cancelChangedMarksConfirmation(index) {
    if (!els.clearAllMarks || !els.clearAllMarks.__atpConfirmArmed || index.rev === marksClearConfirmRev) return;
    clearDestructiveConfirm(els.clearAllMarks, true);
    marksClearConfirmRev = null;
    setPopupStatus('标记刚刚有变化，已取消清空确认，请确认列表后重试', 'warn', true);
  }

  function marksErrorText(code) {
    return MARKS_ERROR_TEXT[code] || '操作失败';
  }

  function sendMarksMutation(payload) {
    return new Promise(function(resolve, reject) {
      try {
        chrome.runtime.sendMessage(Object.assign({ type: SharedUtils.MESSAGE_TYPES.MARKS_MUTATION }, payload), function(response) {
          if (chrome.runtime.lastError) {
            reject(new Error('后台未响应'));
            return;
          }
          if (!response || !response.ok) {
            reject(new Error(marksErrorText(response && response.error)));
            return;
          }
          resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function describeMarksSummary(index) {
    var items = index.items;
    if (!items.length) return '尚未标记帖子。在论坛列表页帖子缩略图上方点「标记」即可保存标题、链接和密码。';
    var unexported = 0;
    var attention = 0;
    items.forEach(function(item) {
      if (!MARKS.isExported(item)) unexported++;
      if (item.attention) attention++;
    });
    return '共 ' + items.length + ' 帖' + (unexported ? '，未导出 ' + unexported + ' 帖' : '，均已导出') +
      (attention ? '，' + attention + ' 帖需注意（导出文件中有说明）' : '') + '。';
  }

  function getListFocusRestorer(list, actionAttribute, fallback) {
    var active = document.activeElement;
    var key = active && active.getAttribute && active.getAttribute(actionAttribute);
    if (!key) return null;
    var selector = '[' + actionAttribute + ']';
    var index = Array.from(list.querySelectorAll(selector)).indexOf(active);
    if (index === -1) return null;
    return function() {
      var buttons = Array.from(list.querySelectorAll(selector));
      var original = buttons.find(function(button) { return button.getAttribute(actionAttribute) === key; });
      var target = original || buttons[Math.min(index, buttons.length - 1)] || fallback;
      if (target) target.focus();
    };
  }

  function renderMarksList(index) {
    if (!els.marksList || !index) return;
    var restoreFocus = getListFocusRestorer(els.marksList, 'data-mark-remove', els.marksHeading);
    els.marksList.textContent = '';
    var query = els.marksSearch ? String(els.marksSearch.value || '').trim().toLowerCase() : '';
    var allItems = index.items.slice().reverse();
    if (els.marksSearchWrap && els.marksSearchWrap.classList) {
      els.marksSearchWrap.classList.toggle('hidden', allItems.length === 0);
    }
    var items = query
      ? allItems.filter(function(item) { return String(item.title || '').toLowerCase().indexOf(query) !== -1; })
      : allItems;
    if (allItems.length > 0 && items.length === 0) {
      var emptyMatch = document.createElement('li');
      emptyMatch.className = 'marks-item marks-item-more';
      emptyMatch.textContent = '未找到匹配的已标记帖子';
      els.marksList.appendChild(emptyMatch);
      return;
    }
    items.slice(0, MARKS_LIST_LIMIT).forEach(function(item) {
      var li = document.createElement('li');
      li.className = 'marks-item';
      var title = document.createElement('span');
      title.className = 'marks-item-title';
      title.textContent = item.title || '（未读取到标题）';
      title.title = item.title || '';
      var meta = document.createElement('span');
      meta.className = 'marks-item-meta';
      meta.textContent = '链接 ' + (item.links || 0) + (item.passwords ? ' · 密码 ' + item.passwords : '') +
        ' · ' + (MARKS.isExported(item) ? '已导出' : (item.exportedAt ? '导出后有更新' : '未导出')) + (item.attention ? ' · 需注意' : '');
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-link marks-item-remove';
      remove.setAttribute('data-mark-remove', item.id);
      remove.setAttribute('aria-label', '取消标记：' + (item.title || item.id));
      remove.textContent = '移除';
      li.appendChild(title);
      li.appendChild(meta);
      li.appendChild(remove);
      els.marksList.appendChild(li);
    });
    if (items.length > MARKS_LIST_LIMIT) {
      var more = document.createElement('li');
      more.className = 'marks-item marks-item-more';
      more.textContent = '…另有 ' + (items.length - MARKS_LIST_LIMIT) + ' 帖（导出文件中完整列出）';
      els.marksList.appendChild(more);
    }
    if (restoreFocus) restoreFocus();
  }

  function renderBackupDays(days) {
    if (!els.backupList) return;
    var rows = Object.keys(days.days).sort().reverse().map(function(date) {
      var info = days.days[date] || {};
      return { date: date, threads: info.threads || 0, links: info.links || 0 };
    });
    var signature = JSON.stringify(rows);
    if (signature === backupListSignature) return;
    backupListSignature = signature;
    var summary = els.backupSection && els.backupSection.querySelector('summary');
    var restoreFocus = getListFocusRestorer(els.backupList, 'data-backup-day', summary);
    if (els.backupCount) els.backupCount.textContent = rows.length;
    els.backupList.textContent = '';
    rows.forEach(function(row) {
      var li = document.createElement('li');
      li.className = 'marks-item';
      var label = document.createElement('span');
      label.className = 'marks-item-title';
      label.textContent = row.date + ' · ' + row.threads + ' 帖 · ' + row.links + ' 条链接';
      var download = document.createElement('button');
      download.type = 'button';
      download.className = 'btn-link';
      download.setAttribute('data-backup-day', row.date);
      download.setAttribute('aria-label', '下载 ' + row.date + ' 的备份');
      download.textContent = '下载';
      li.appendChild(label);
      li.appendChild(download);
      els.backupList.appendChild(li);
    });
    if (els.downloadAllBackups) els.downloadAllBackups.disabled = !rows.length;
    if (restoreFocus) restoreFocus();
  }

  async function refreshMarks() {
    if (!MARKS || !els.marksSection) return null;
    var items = await storageGet([MARKS.KEYS.INDEX, MARKS.KEYS.DAYS], '读取标记');
    var previous = marksIndex;
    marksIndex = MARKS.readIndex(items && items[MARKS.KEYS.INDEX]);
    cancelChangedMarksConfirmation(marksIndex);
    if (!previous || previous.rev !== marksIndex.rev) {
      setMarksCountDisplay(marksIndex.items.length);
      if (els.marksSummary) els.marksSummary.textContent = describeMarksSummary(marksIndex);
      renderMarksList(marksIndex);
      var hasMarks = marksIndex.items.length > 0;
      [els.exportMarks, els.copyMarks, els.clearAllMarks].forEach(function(btn) {
        if (btn) btn.disabled = !hasMarks;
      });
      if (els.clearExportedMarks) els.clearExportedMarks.disabled = !marksIndex.items.some(MARKS.isExported);
    }
    renderBackupDays(MARKS.readDays(items && items[MARKS.KEYS.DAYS]));
    return marksIndex;
  }

  function scheduleMarksRefresh() {
    if (marksRefreshTimer) clearTimeout(marksRefreshTimer);
    marksRefreshTimer = setTimeout(function() {
      marksRefreshTimer = null;
      refreshMarks().catch(function() {});
    }, 150);
  }

  async function readMarkRecords(index) {
    var keys = index.items.map(function(item) { return MARKS.itemKey(item.id); });
    var stored = keys.length ? await storageGet(keys, '读取标记') : {};
    var records = [];
    index.items.forEach(function(item) {
      var record = stored && stored[MARKS.itemKey(item.id)];
      if (record && typeof record === 'object' && Array.isArray(record.links)) records.push(record);
    });
    return records;
  }

  function downloadTextFile(text, filename) {
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(function() { URL.revokeObjectURL(url); }, 10000);
  }

  function handedOut(records) {
    return records.map(function(record) { return { id: record.id, updatedAt: record.updatedAt, snapshot: MARKS.recordToSnapshot(record) }; });
  }

  async function completeMarksHandOut(records, op) {
    var result = { count: records.length, warning: '' };
    try {
      var response = await sendMarksMutation({ op: op, marks: handedOut(records) });
      if (response.backedUp !== records.length) result.warning = '仅确认备份 ' + (Number(response.backedUp) || 0) + '/' + records.length + ' 帖';
    } catch (e) {
      result.warning = '未能确认备份：' + errorMessage(e);
    }
    try {
      await refreshMarks();
    } catch (e) {
      result.warning = result.warning || '未能刷新标记列表：' + errorMessage(e);
    }
    return result;
  }

  async function exportMarks() {
    var index = await refreshMarks();
    if (!index || !index.items.length) return { count: 0 };
    var records = await readMarkRecords(index);
    if (!records.length) return { count: 0 };
    var now = new Date();
    var text = MARKS.formatExport(records, { version: chrome.runtime.getManifest().version, now: now.getTime() });
    downloadTextFile(text, 'thumbnail-preview-marked-' + formatLocalFilenameTimestamp(now) + '.txt');
    return completeMarksHandOut(records, 'exported');
  }

  async function copyMarks() {
    var index = await refreshMarks();
    if (!index || !index.items.length) return { count: 0 };
    var records = await readMarkRecords(index);
    if (!records.length) return { count: 0 };
    var text = MARKS.formatExport(records, { version: chrome.runtime.getManifest().version, now: Date.now() }).replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
    await navigator.clipboard.writeText(text);
    return completeMarksHandOut(records, 'copiedMarks');
  }

  async function readBackupDays(dates) {
    var keys = dates.map(MARKS.dayKey);
    var stored = keys.length ? await storageGet(keys, '读取备份') : {};
    var days = [];
    dates.forEach(function(date) {
      var value = stored && stored[MARKS.dayKey(date)];
      if (value) days.push(MARKS.readDay(value, date));
    });
    return days;
  }

  async function downloadBackups(dates, filename) {
    var days = await readBackupDays(dates);
    if (!days.length) throw new Error('没有可下载的备份');
    var text = MARKS.formatDayBackup(days, { version: chrome.runtime.getManifest().version, now: Date.now() });
    downloadTextFile(text, filename);
    return days.length;
  }

  function countSuccess(verb) {
    return function(result) {
      var count = result && result.count;
      if (count && result.warning) return { text: '已' + verb + ' ' + count + ' 帖，但' + result.warning, type: 'warn', persist: true };
      return count ? { text: '已' + verb + ' ' + count + ' 帖', type: 'ok' } : { text: '没有标记', type: 'info' };
    };
  }

  if (MARKS && els.marksSection) {
    if (els.marksSearch) {
      els.marksSearch.addEventListener('input', function() {
        if (marksIndex) renderMarksList(marksIndex);
      });
    }
    if (els.exportMarks) {
      els.exportMarks.addEventListener('click', function() {
        runButtonAction(els.exportMarks, '导出中...', countSuccess('导出'), '导出 TXT', exportMarks);
      });
    }
    if (els.copyMarks) {
      els.copyMarks.addEventListener('click', function() {
        runButtonAction(els.copyMarks, '复制中...', countSuccess('复制'), '复制全部', copyMarks);
      });
    }
    if (els.clearExportedMarks) {
      els.clearExportedMarks.addEventListener('click', function() {
        runDestructiveButtonAction(els.clearExportedMarks, '再次点击清空', '再次点击确认：移除已导出且之后没有更新的标记（备份保留）', '清空中...', function(result) {
          return { text: '已移除 ' + ((result && result.removed) || 0) + ' 帖', type: 'ok' };
        }, '清空已导出', async function() {
          var result = await sendMarksMutation({ op: 'clearExported' });
          await refreshMarks();
          return result;
        });
      });
    }
    if (els.clearAllMarks) {
      els.clearAllMarks.addEventListener('click', function() {
        if (els.clearAllMarks.__atpBusy || !marksIndex) return;
        if (!els.clearAllMarks.__atpConfirmArmed) marksClearConfirmRev = marksIndex.rev;
        var confirmedRev = marksClearConfirmRev;
        var unexported = marksIndex ? MARKS.countUnexported(marksIndex) : 0;
        runDestructiveButtonAction(els.clearAllMarks, '再次点击清空', '再次点击确认清空全部标记' + (unexported ? '（其中 ' + unexported + ' 帖未导出）' : '') + '；每日备份保留', '清空中...', function(result) {
          return { text: '已移除 ' + ((result && result.removed) || 0) + ' 帖', type: 'ok' };
        }, '清空全部标记', async function() {
          try {
            return await sendMarksMutation({ op: 'clearAll', rev: confirmedRev });
          } finally {
            await refreshMarks();
          }
        });
      });
    }
    if (els.marksList) {
      els.marksList.addEventListener('click', function(e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-mark-remove]') : null;
        if (!btn) return;
        var id = btn.getAttribute('data-mark-remove');
        runButtonAction(btn, '移除中...', '已移除', '移除', async function() {
          await sendMarksMutation({ op: 'remove', ids: [id] });
          await refreshMarks();
        });
      });
    }
    if (els.backupList) {
      els.backupList.addEventListener('click', function(e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-backup-day]') : null;
        if (!btn) return;
        var date = btn.getAttribute('data-backup-day');
        runButtonAction(btn, '下载中...', '已下载', '下载', function() {
          return downloadBackups([date], 'thumbnail-preview-backup-' + date + '.txt');
        });
      });
    }
    if (els.downloadAllBackups) {
      els.downloadAllBackups.addEventListener('click', function() {
        runButtonAction(els.downloadAllBackups, '下载中...', function(count) {
          return { text: '已下载 ' + count + ' 天的备份', type: 'ok' };
        }, '下载全部备份', async function() {
          var stored = await storageGet(MARKS.KEYS.DAYS, '读取备份');
          var dates = Object.keys(MARKS.readDays(stored && stored[MARKS.KEYS.DAYS]).days).sort();
          return downloadBackups(dates, 'thumbnail-preview-backup-all-' + formatLocalFilenameTimestamp(new Date()) + '.txt');
        });
      });
    }
    if (els.toggleEnabled) {
      els.toggleEnabled.addEventListener('change', function() {
        if (els.toggleEnabled.checked || !marksIndex) return;
        var unexported = MARKS.countUnexported(marksIndex);
        if (unexported) setPopupStatus('还有 ' + unexported + ' 个已标记的帖子未导出，可在「收藏」标签页中导出。', 'info', true);
      });
    }
    if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
      chrome.storage.onChanged.addListener(function(changes, areaName) {
        if (areaName !== 'local' || !changes) return;
        if (changes[MARKS.KEYS.INDEX]) cancelChangedMarksConfirmation(MARKS.readIndex(changes[MARKS.KEYS.INDEX].newValue));
        if (changes[MARKS.KEYS.INDEX] || changes[MARKS.KEYS.DAYS]) scheduleMarksRefresh();
      });
    }
    refreshMarks().catch(function(e) {
      if (els.marksSummary) els.marksSummary.textContent = '读取标记失败：' + errorMessage(e);
    });
  }

  // ---- Schema UI rendering & event binding ----
  function renderSettingsGroupFallback(groupName, items) {
    var groupMeta = typeof ATPGetSettingsGroupMeta === 'function' ? ATPGetSettingsGroupMeta(groupName) : {};
    var collapsible = !!groupMeta.collapsible;
    var html = collapsible
      ? '<details class="settings-section settings-section-collapsible"' + (groupMeta.collapsed === false ? ' open' : '') + '><summary class="settings-section-summary">' + esc(groupName) + '</summary><div class="settings-section-body">'
      : '<section class="settings-section"><h2>' + esc(groupName) + '</h2>';
    if (groupName === '加载') {
      html += '<div class="setting-row setting-row-presets"><span class="setting-preset-label">加载速度预设</span><span class="setting-preset-actions">' +
        '<button class="btn-ordinary-preset" type="button" data-preset="ordinaryGentle">温和</button>' +
        '<button class="btn-ordinary-preset" type="button" data-preset="ordinaryBalanced">均衡·推荐</button>' +
        '<button class="btn-ordinary-preset" type="button" data-preset="ordinaryFast">极速</button>' +
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
        html += '<div class="setting-row setting-row-number"><label for="' + esc(item.key) + '">' + esc(item.label) + range + '</label><span class="input-wrap"><input type="number" id="' + esc(item.key) + '" min="' + (item.min !== undefined ? esc(item.min) : '') + '" max="' + (item.max !== undefined ? esc(item.max) : '') + '" step="' + esc(item.step || 1) + '"><button class="btn-reset" type="button" data-key="' + esc(item.key) + '" title="恢复默认" aria-label="恢复' + esc(item.label) + '默认值">↺</button></span>';
        html += '<span id="' + esc(item.key) + '-error" class="setting-number-error" role="alert"></span></div>';
      }
    }
    html += collapsible ? '</div></details>' : '</section>';
    return html;
  }

  function renderSettingsUI() {
    if (typeof SETTINGS_SCHEMA === 'undefined') return;
    if (typeof ATPSettingsUI !== 'undefined' && ATPSettingsUI) {
      if (els.presetCardsContainer) {
        els.presetCardsContainer.innerHTML = ATPSettingsUI.renderPresetCards(settings || DEFAULTS, SETTINGS_SCHEMA);
      }
      if (els.quickSettingsContainer) {
        els.quickSettingsContainer.innerHTML = ATPSettingsUI.renderSettingsGroups(SETTINGS_SCHEMA, settings || DEFAULTS, {
          variant: 'popup',
          onlyGroups: ['常用'],
          forceExpanded: true
        });
        if (els.settingsContainer) {
          els.settingsContainer.innerHTML = ATPSettingsUI.renderSettingsGroups(SETTINGS_SCHEMA, settings || DEFAULTS, {
            variant: 'popup',
            excludeGroups: ['常用']
          });
        }
        return;
      }
      if (els.settingsContainer) {
        els.settingsContainer.innerHTML = ATPSettingsUI.renderSettingsGroups(SETTINGS_SCHEMA, settings || DEFAULTS, {
          variant: 'popup'
        });
      }
      return;
    }
    if (els.settingsContainer) {
      els.settingsContainer.innerHTML = ATPGetSettingsViewGroups(SETTINGS_SCHEMA).map(function(group) {
        return renderSettingsGroupFallback(group[0], group[1]);
      }).join('');
    }
  }

  function bindSchemaControls() {
    if (typeof SETTINGS_SCHEMA === 'undefined') return;
    SETTINGS_SCHEMA.forEach(function(item) {
      var el = document.getElementById(item.key);
      if (!el || el.__atpSchemaBound) return;
      el.__atpSchemaBound = true;
      el.addEventListener('input', function() {
        if (item.type === 'number' || el.tagName === 'SELECT') markSettingInputDirty(el);
      });
      el.addEventListener('focusout', function() {
        clearSettingInputDirty(item.key);
      });
      el.addEventListener('change', function() {
        if (!ensureSettingsReady(el)) return;
        if (item.type === 'number') {
          var val = ATPReadNumberSetting(el.value, item);
          if (val === null) {
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
        if (['gridCols', 'visibleRows', 'heavyImageOptimization', 'heavyThumbnailClarity'].indexOf(item.key) !== -1) {
          updateFirstScreen();
        }
        updateDependentControls();
        saveSettings(getSettingsApplyMode([item.key]), [item.key], null, el).catch(function(e) {
          console.warn('[popup] 保存设置失败:', errorMessage(e));
        });
      });
    });
  }

  function handleSettingsRootClick(e) {
    var target = e && e.target;
    if (!target || typeof target.closest !== 'function') return;
    var ordinaryPresetBtn = target.closest('.btn-ordinary-preset');
    if (ordinaryPresetBtn) {
      applyOrdinaryPresetButton(ordinaryPresetBtn);
      return;
    }
    var presetBtn = target.closest('.btn-heavy-preset');
    if (presetBtn) {
      if (!ensureSettingsReady(presetBtn)) return;
      if (presetBtn.__atpBusy) return;
      if (!settings.heavyImageOptimization) return;
      var presetKeys = [];
      forEachHeavyOriginalPreset(function(key) {
        presetKeys.push(key);
        settings[key] = HEAVY_ORIGINAL_PRESET[key];
        setUIValue(key);
      });
      updateDependentControls();
      setButtonBusy(presetBtn, true);
      saveSettings(getSettingsApplyMode(presetKeys), presetKeys, null, presetBtn).catch(function(err) {
        console.warn('[popup] 恢复重图预设失败:', errorMessage(err));
      }).finally(function() {
        setButtonBusy(presetBtn, false);
        updateDependentControls();
      });
      return;
    }
    var btn = target.closest('.btn-reset');
    if (!btn) return;
    if (!ensureSettingsReady(btn)) return;
    var key = btn.getAttribute('data-key');
    if (!(key in DEFAULTS)) return;
    settings[key] = DEFAULTS[key];
    var el = document.getElementById(key);
    if (el) {
      if (el.type === 'checkbox') el.checked = DEFAULTS[key];
      else el.value = DEFAULTS[key];
      clearInputError(el);
    }
    if (['gridCols', 'visibleRows'].indexOf(key) !== -1) updateFirstScreen();
    updateDependentControls();
    saveSettings(getSettingsApplyMode([key]), [key], null, el).catch(function(e) {
      console.warn('[popup] 保存设置失败:', errorMessage(e));
    });
  }

  function bindResetButtons() {
    var roots = getSettingsRoots();
    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];
      if (!root || root.__atpResetBound) continue;
      root.__atpResetBound = true;
      root.addEventListener('click', handleSettingsRootClick);
    }
  }

  function bindDisableSite() {
    var el = document.getElementById('disableSite');
    if (!el || el.__atpDisableBound) return;
    el.__atpDisableBound = true;
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
      settings.siteConfigs[hostname].disabled = el.checked;
      syncSiteDot();
      var sitePatch = { siteConfigs: {} };
      sitePatch.siteConfigs[hostname] = { disabled: el.checked };
      saveSettings(getSettingsApplyMode(['siteConfigs']), ['siteConfigs'], sitePatch, el).catch(function(e) {
        console.warn('[popup] 保存站点设置失败:', errorMessage(e));
      });
    });
  }

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

  function renderHelpFromSchema() {
    if (typeof SETTINGS_SCHEMA === 'undefined' || !els.helpPanel) return;
    var staticHelp = {
      '维护': [
        { label: '↺ 按钮', desc: '点击将该项恢复为默认值，其他项不变。' },
        { label: '清除文章与资源缓存', desc: '删除文章提取结果和已缓存图片，下次访问重新抓取；不清除 TXT 资源缓存与收藏。' },
        { label: '清除失败缓存', desc: '删除“无图”标记和 TXT 解析失败标记，让之前被误判的帖子或附件可立即重试。' },
        { label: '清除全部缓存', desc: '同时清除文章/图片缓存、TXT 资源缓存和失败缓存（不会删除已标记资源与每日备份）。' },
        { label: '恢复默认设置', desc: '重置所有设置为推荐默认值（保留站点禁用列表与镜像授权）。' }
      ],
      '高级': [
        { label: '仅在此站点禁用', desc: '勾选后当前站点停止缩略图预览。' }
      ]
    };
    if (typeof ATPSettingsUI !== 'undefined' && ATPSettingsUI && typeof ATPSettingsUI.buildHelpHtml === 'function') {
      els.helpPanel.innerHTML = ATPSettingsUI.buildHelpHtml(SETTINGS_SCHEMA, {
        variant: 'popup',
        staticHelp: staticHelp
      });
      return;
    }
    var groups = {};
    SETTINGS_SCHEMA.forEach(function(item) {
      if (!groups[item.group]) groups[item.group] = [];
      groups[item.group].push(item);
    });
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

  if (typeof window !== 'undefined' && window.__ATP_VERIFY_POPUP__) {
    if (popupLogs) {
      window.__ATPLogExportTest = popupLogs.getTestHooks();
    }
    window.__ATPPopupTest = {
      applySavedSettings: applySavedSettings,
      bindSchemaControls: bindSchemaControls,
      bindDisableSite: bindDisableSite,
      bindResetButtons: bindResetButtons,
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
    if (els.versionBadge) els.versionBadge.textContent = 'v' + version;
    var footer = document.getElementById('versionFooter');
    if (footer) footer.textContent = 'v' + version + ' · 技术学习交流';
    bindTabNavigation();
    renderSettingsUI();
    bindSchemaControls();
    bindResetButtons();
    bindDisableSite();
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
      if (els.toggleEnabled) els.toggleEnabled.checked = false;
      setSettingsControlsDisabled(true);
      setPopupStatus('设置读取失败：' + errorMessage(e), 'err', true);
      console.warn('[popup] 加载设置失败:', errorMessage(e));
    });
    if (popupLogs) popupLogs.refreshLogCount();
    refreshCacheStatsDisplay();
    renderHelpFromSchema();
  });
})();
