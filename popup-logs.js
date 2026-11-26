(function () {
  'use strict';

  function createPopupLogs(deps) {
    deps = deps || {};
    var els = deps.els || {};
    var storageGet = deps.storageGet;
    var storageGetKeys = deps.storageGetKeys;
    var storageSet = deps.storageSet;
    var storageRemove = deps.storageRemove;
    var setPopupStatus = deps.setPopupStatus;
    var setDisclosureState = deps.setDisclosureState;
    var runButtonAction = deps.runButtonAction;
    var esc = deps.esc;
    var errorMessage = deps.errorMessage;
    var formatLocalTimestamp = deps.formatLocalTimestamp;
    var formatLocalFilenameTimestamp = deps.formatLocalFilenameTimestamp;
    var appendUniqueKeys = deps.appendUniqueKeys;
    var collectUniqueKeys = deps.collectUniqueKeys;

    var LOG_KEYS = ['atp_logs', 'atp_logs_content', 'atp_logs_bg'];
    var LOG_KEY_PREFIXES = ['atp_logs_content_'];
    var LOG_KEY_INDEX = (typeof SharedUtils !== 'undefined' && SharedUtils.CONTENT_LOG_INDEX_KEY) || 'atp_logs_content_keys';
    var LOG_CLEARED_AT_KEY = 'atp_logs_cleared_at';
    var LOG_RETENTION_TYPE = 'log_retention';
    var MAX_CONTENT_LOG_KEYS = (typeof SharedUtils !== 'undefined' && SharedUtils.MAX_CONTENT_LOG_KEYS) || 20;
    var LOG_VIEW_LIMIT = 1000;
    var LOG_RENDER_LIMIT = 150;
    var LOG_SEARCH_DEBOUNCE_MS = 180;
    var logReloadTimer = null;
    var liveStorageTimer = null;
    var logLoadSeq = 0;
    var logCountSeq = 0;
    var loadedLogEntries = null;
    var logLoadInFlight = false;

    function padNumber(value, width) {
      value = String(value);
      while (value.length < width) value = '0' + value;
      return value;
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

    function setLogCountDisplay(value) {
      if (els.logCount) els.logCount.textContent = value;
      if (els.tabLogCount) {
        var tabText = String(value === null || value === undefined ? '0' : value);
        var slashIdx = tabText.indexOf('/');
        if (slashIdx !== -1) tabText = tabText.slice(slashIdx + 1);
        els.tabLogCount.textContent = tabText;
        if (els.tabLogCount.classList) {
          els.tabLogCount.classList.toggle('has-count', tabText === '!' || (Number(tabText) || 0) > 0);
        }
      }
    }

    function setLogViewerBusy(busy, text) {
      if (!els.logViewer) return;
      els.logViewer.setAttribute('aria-busy', busy ? 'true' : 'false');
      if (text) {
        els.logViewer.innerHTML = '<div class="log-entry" style="color:#94a3b8">' + esc(text) + '</div>';
      }
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

    function getContentLogKeyTimestamp(key) {
      var prefix = LOG_KEY_PREFIXES[0];
      if (!isContentLogKey(key)) return 0;
      var ts = parseInt(key.slice(prefix.length), 10);
      return isNaN(ts) ? 0 : ts;
    }

    function insertNewestContentLogKey(keys, key) {
      var ts = getContentLogKeyTimestamp(key);
      var insertAt = keys.length;
      while (insertAt > 0 && ts > getContentLogKeyTimestamp(keys[insertAt - 1])) insertAt--;
      if (insertAt >= MAX_CONTENT_LOG_KEYS) return;
      keys.splice(insertAt, 0, key);
      if (keys.length > MAX_CONTENT_LOG_KEYS) keys.length = MAX_CONTENT_LOG_KEYS;
    }

    function getPrunableContentLogKeys(keys, protectedKeys) {
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
      for (var pk = 0; protectedKeys && pk < protectedKeys.length; pk++) keepMap[protectedKeys[pk]] = true;
      var stale = [];
      for (var si = 0; si < keys.length; si++) {
        var staleKey = keys[si];
        if (isContentLogKey(staleKey) && !keepMap[staleKey]) stale.push(staleKey);
      }
      return stale;
    }

    async function writeLogIndex(keys, prunedKeys) {
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
      } catch (e) {}
      var d = {};
      d[LOG_KEY_INDEX] = merged;
      await storageSet(d, '写入日志索引');
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

    async function discoverLogKeysFromNames(names, previous) {
      var keys = getLogKeysFromNames(names);
      var indexed = appendUniqueKeys([], keys, isContentLogKey);
      var present = new Set(names);
      var stale = (previous || []).filter(function(key) { return isContentLogKey(key) && !present.has(key); });
      await writeLogIndexBestEffort(indexed, stale);
      return keys;
    }

    async function discoverLogKeysFromStorage() {
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

    async function getLogKeysForRead(allowDiscovery) {
      if (allowDiscovery) return await discoverLogKeysFromStorage();
      var result = await storageGet(LOG_KEY_INDEX, '读取日志索引');
      var indexed = Array.isArray(result[LOG_KEY_INDEX]) ? result[LOG_KEY_INDEX] : [];
      var keys = appendUniqueKeys([], LOG_KEYS);
      appendUniqueKeys(keys, indexed, isLogKey);
      return keys;
    }

    async function pruneContentLogKeys(logKeys, protectedKeys) {
      var stale = getPrunableContentLogKeys(logKeys, protectedKeys);
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

    async function refreshLogCount() {
      var seq = ++logCountSeq;
      try {
        var logs = await loadLogEntries({ allowDiscovery: false, prune: false });
        if (seq !== logCountSeq) return;
        if (!logs.length) {
          logs = await loadLogEntries({ allowDiscovery: true, prune: false });
          if (seq !== logCountSeq) return;
        }
        setLogCountDisplay(logs.length);
      } catch (e) {
        if (seq !== logCountSeq) return;
        setLogCountDisplay('!');
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
      if (liveStorageTimer) {
        clearTimeout(liveStorageTimer);
        liveStorageTimer = null;
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
        } catch (e) {}
      }
      return sanitizeLogExportText(text);
    }

    function hasLogFields(fields) {
      for (var key in fields || {}) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) return true;
      }
      return false;
    }

    function getLogDataText(e) {
      if (!e) return '';
      var fields = getLogFields(e);
      if (hasLogFields(fields)) {
        try {
          return JSON.stringify(sanitizeLogExportFields(fields));
        } catch (ex) {}
      }
      if (e.data) return sanitizeLegacyLogDataText(e.data);
      return '';
    }

    function isImageLog(e) {
      var type = getLogType(e);
      if (/^(content_start|image_|render_|first_screen_timing|diagnostic_summary|schedule_state|thread_registered|scan_complete|fallback_|log_retention)/.test(type)) return true;
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
      setLogCountDisplay(filtered.length === logs.length ? logs.length : filtered.length + '/' + logs.length);
      if (!filtered.length) {
        if (els.logViewer) els.logViewer.innerHTML = '<div class="log-entry" style="color:#94a3b8">暂无日志</div>';
        return;
      }
      var renderStart = Math.max(0, filtered.length - LOG_RENDER_LIMIT);
      if (els.logViewer) {
        els.logViewer.innerHTML = renderLogEntries(filtered, renderStart);
        if (followTail) els.logViewer.scrollTop = els.logViewer.scrollHeight;
      }
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
        setLogCountDisplay('!');
        var message = '读取日志失败：' + errorMessage(e);
        if (els.logViewer) els.logViewer.innerHTML = '<div class="log-entry lv-ERROR">' + esc(message) + '</div>';
        setPopupStatus(message, 'err', true);
      } finally {
        if (seq === logLoadSeq) logLoadInFlight = false;
      }
    }

    async function loadLogEntries(options) {
      options = options || {};
      var logKeys = await getLogKeysForRead(!!options.allowDiscovery);
      if (options.prune) {
        var staleLogKeys = await pruneContentLogKeys(logKeys, options.protectedLogKeys);
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
      var retentionEntries = [];
      for (var re = 0; re < logs.length; re++) {
        if (logs[re].type === LOG_RETENTION_TYPE) retentionEntries.push(logs[re]);
      }
      logs.sort(function(a, b) {
        var at = getLogSortTimestamp(a);
        var bt = getLogSortTimestamp(b);
        if (at !== bt) return at - bt;
        return String(a.ts || '').localeCompare(String(b.ts || ''));
      });
      if (logs.length > LOG_VIEW_LIMIT) {
        logs.splice(0, logs.length - LOG_VIEW_LIMIT);
        var retainedSessions = {};
        for (var rli = 0; rli < logs.length; rli++) {
          if (logs[rli].sessionId) retainedSessions[logs[rli].sessionId] = true;
        }
        for (var ri = 0; ri < retentionEntries.length; ri++) {
          var retentionEntry = retentionEntries[ri];
          if (!retainedSessions[retentionEntry.sessionId] || logs.indexOf(retentionEntry) !== -1) continue;
          logs.splice(0, 1);
          logs.push(retentionEntry);
        }
        logs.sort(function(a, b) { return getLogSortTimestamp(a) - getLogSortTimestamp(b); });
      }
      return logs;
    }

    function addLogSummaryCount(counts, value) {
      var key = sanitizeLogExportLabel(value);
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
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

    function formatLogSummaryCounts(counts, limit) {
      var keys = collectTopCountKeys(counts, limit || 10);
      var parts = [];
      for (var i = 0; i < keys.length; i++) {
        parts.push(keys[i] + '=' + counts[keys[i]]);
      }
      return parts.join(', ');
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
      var retentionLines = [];
      var seenSessions = {};
      for (var ri = 0; ri < logs.length; ri++) {
        var entry = logs[ri];
        if (!entry || entry.type !== LOG_RETENTION_TYPE) continue;
        var fields = getLogFields(entry);
        var session = sanitizeLogExportLabel(entry.sessionId || '-');
        if (seenSessions[session]) continue;
        seenSessions[session] = true;
        retentionLines.push('会话 ' + session + ': 已裁剪' + (Number(fields.droppedEntries) || 0) +
          '条，异常累计' + (Number(fields.incidentCount) || 0) +
          (fields.firstDroppedAt ? '，最早裁剪于' + sanitizeLogExportLabel(fields.firstDroppedAt) : ''));
      }
      return [
        '最近会话: ' + latestSessionId,
        '级别统计: ' + levelSummary,
        '事件统计: ' + typeSummary,
        'Host统计: ' + hostSummary
      ].concat(retentionLines).join('\n');
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

    async function flushLiveContentLogsBeforeExport(liveSession) {
      return new Promise(function(resolve) {
        if (!chrome.tabs || !chrome.tabs.query || !chrome.tabs.sendMessage) { resolve(false); return; }
        var done = false;
        var timer = setTimeout(function() { finish(false); }, 1500);
        function finish(ok) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(ok === true);
        }
        try {
          chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            if (chrome.runtime.lastError || !tabs || !tabs[0] || typeof tabs[0].id !== 'number') { finish(false); return; }
            try {
              chrome.tabs.sendMessage(tabs[0].id, { type: 'ATP_FLUSH_CONTENT_LOGS' }, function(response) {
                var ok = !chrome.runtime.lastError && response && response.ok === true;
                if (ok && liveSession && typeof response.logKey === 'string') liveSession.logKey = response.logKey;
                finish(ok);
              });
            } catch (e) { finish(false); }
          });
        } catch (e) { finish(false); }
      });
    }

    function triggerNonBlockingLiveFlush() {
      var liveSession = {};
      flushLiveContentLogsBeforeExport(liveSession).then(function(flushed) {
        if (!flushed) return;
        if (els.logPanel && !els.logPanel.classList.contains('hidden') && !logLoadInFlight) {
          loadLogs({
            allowDiscovery: true,
            prune: false,
            protectedLogKeys: liveSession.logKey ? [liveSession.logKey] : []
          });
        } else {
          refreshLogCount();
        }
      }).catch(function() {});
    }

    function openPanelWithLiveFlush() {
      if (els.logPanel && els.logPanel.classList.contains('hidden')) {
        setDisclosureState(els.toggleLogs, els.logPanel, true);
      }
      loadLogs({ allowDiscovery: true, prune: true });
      triggerNonBlockingLiveFlush();
    }

    async function exportLogsAction() {
      var liveSession = {};
      var refreshed = await flushLiveContentLogsBeforeExport(liveSession);
      var logs = await loadLogEntries({
        allowDiscovery: true,
        prune: true,
        protectedLogKeys: liveSession.logKey ? [liveSession.logKey] : []
      });
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
      if (!refreshed) text = text.replace('================================\n\n',
        '实时刷新: 未收到当前页面确认，最后几秒日志可能尚未写入\n================================\n\n');
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'thumbnail-preview-logs-' + formatLocalFilenameTimestamp(exportDate) + '.txt';
      a.click();
      URL.revokeObjectURL(url);
      if (!els.logPanel || els.logPanel.classList.contains('hidden')) {
        setLogCountDisplay(logs.length);
      }
      return 'exported';
    }

    async function clearLogsAction() {
      var names = await storageGetKeys('发现日志键');
      var logKeys = getLogKeysFromNames(names);
      await removeKeysWithLogClearMarker(collectUniqueKeys([logKeys], LOG_KEY_INDEX), '清空日志');
      invalidateLogLoadState();
      loadedLogEntries = [];
      renderLoadedLogs(loadedLogEntries);
    }

    function resetAfterMaintenanceClear() {
      invalidateLogLoadState();
      loadedLogEntries = [];
      if (!els.logPanel || els.logPanel.classList.contains('hidden')) {
        setLogCountDisplay(0);
      } else {
        renderLoadedLogs(loadedLogEntries);
      }
    }

    function bindUI() {
      if (els.toggleLogs) {
        els.toggleLogs.addEventListener('click', function() {
          var expanded = els.logPanel.classList.contains('hidden');
          setDisclosureState(els.toggleLogs, els.logPanel, expanded);
          if (expanded) {
            loadLogs({ allowDiscovery: true, prune: true });
            triggerNonBlockingLiveFlush();
          } else {
            logLoadSeq++;
            loadedLogEntries = null;
            logLoadInFlight = false;
            setLogViewerBusy(false);
          }
        });
      }
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
      if (els.exportLogs) {
        els.exportLogs.addEventListener('click', function() {
          runButtonAction(els.exportLogs, '导出中...', function(result) {
            return result === 'empty' ? '无日志' : '已导出!';
          }, '导出日志', exportLogsAction);
        });
      }
      if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
        chrome.storage.onChanged.addListener(function(changes, areaName) {
          if (areaName !== 'local' || !changes) return;
          var hasLogChange = false;
          for (var key in changes) {
            if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
            if (isLogKey(key) || key === LOG_KEY_INDEX || key === LOG_CLEARED_AT_KEY) {
              hasLogChange = true;
              break;
            }
          }
          if (!hasLogChange) return;
          if (liveStorageTimer) clearTimeout(liveStorageTimer);
          liveStorageTimer = setTimeout(function() {
            liveStorageTimer = null;
            if (els.logPanel && !els.logPanel.classList.contains('hidden')) {
              if (!logLoadInFlight) loadLogs({ allowDiscovery: false, prune: false });
            } else {
              refreshLogCount();
            }
          }, 220);
        });
      }
    }

    function getTestHooks() {
      return {
        getLogDataText: getLogDataText,
        buildLogSummaryText: buildLogSummaryText,
        formatLogLine: formatLogLine,
        renderLogEntry: renderLogEntry,
        isLogKey: isLogKey,
        getLogKeysForRead: getLogKeysForRead,
        discoverLogKeysFromStorage: discoverLogKeysFromStorage,
        refreshLogCount: refreshLogCount,
        loadLogEntries: loadLogEntries,
        flushLiveContentLogsBeforeExport: flushLiveContentLogsBeforeExport,
        loadLogs: loadLogs,
        scheduleLogReload: scheduleLogReload,
        renderLoadedLogs: renderLoadedLogs,
        getLoadedLogEntries: function() { return loadedLogEntries; },
        isLogLoadInFlight: function() { return logLoadInFlight; }
      };
    }

    return {
      LOG_KEY_INDEX: LOG_KEY_INDEX,
      LOG_CLEARED_AT_KEY: LOG_CLEARED_AT_KEY,
      bindUI: bindUI,
      onTabActivated: openPanelWithLiveFlush,
      refreshLogCount: refreshLogCount,
      getLogKeysFromNames: getLogKeysFromNames,
       getLogKeysFromItems: getLogKeysFromItems,
      removeKeysWithLogClearMarker: removeKeysWithLogClearMarker,
      invalidateLogLoadState: invalidateLogLoadState,
      resetAfterMaintenanceClear: resetAfterMaintenanceClear,
      clearLogsAction: clearLogsAction,
      exportLogsAction: exportLogsAction,
      getTestHooks: getTestHooks
    };
  }

  globalThis.ATPPopupLogs = {
    create: createPopupLogs
  };
})();
