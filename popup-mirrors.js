(function () {
  'use strict';

  // Forum mirror / reverse-proxy sites. Each mirror is a Chrome optional host
  // permission (https://*.<root>/*) that the user approves in Chrome's own
  // prompt; background.js registers the content scripts for granted sites.
  // Chrome's granted permissions are the only source of truth for the list.
  var MESSAGE_TYPES = SharedUtils.MESSAGE_TYPES;
  var REMOVE_CONFIRM_MS = 3000;
  var STATUS_CLEAR_MS = 2400;
  var els = {};
  ['mirrorSection', 'mirrorCount', 'mirrorStatus', 'mirrorInput', 'addMirror', 'addCurrentMirror', 'mirrorList', 'mirrorEmpty'].forEach(function(id) {
    els[id] = document.getElementById(id);
  });

  var sites = [];
  var activeTab = null;
  var autoOpened = false;
  var busy = false;
  var statusTimer = null;
  var pendingRemove = null;

  function errorMessage(e) {
    return e && e.message ? e.message : String(e || '未知错误');
  }

  function setStatus(text, type, persist) {
    var el = els.mirrorStatus;
    if (!el) return;
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (!text) {
      el.textContent = '';
      el.className = 'popup-status popup-status-empty';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      return;
    }
    el.setAttribute('role', type === 'err' ? 'alert' : 'status');
    el.setAttribute('aria-live', type === 'err' ? 'assertive' : 'polite');
    el.textContent = text;
    el.className = 'popup-status popup-status-' + (type || 'info');
    if (!persist) {
      statusTimer = setTimeout(function() { setStatus(''); }, STATUS_CLEAR_MS);
    }
  }

  function describeRejection(reason) {
    if (reason === 'empty') return '请输入镜像站点域名';
    if (reason === 'not_https') return '仅支持 HTTPS 镜像站点';
    if (reason === 'builtin') return '该域名已内置支持，无需添加';
    if (reason === 'reserved') return '该地址不能作为论坛镜像（IP、本机或下载中转域名）';
    return '域名格式无效，请输入如 mirror.example 的域名';
  }

  function getGrantedOrigins() {
    return new Promise(function(resolve, reject) {
      if (!chrome.permissions || typeof chrome.permissions.getAll !== 'function') {
        resolve([]);
        return;
      }
      chrome.permissions.getAll(function(result) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result && Array.isArray(result.origins) ? result.origins : []);
      });
    });
  }

  function loadSites() {
    return getGrantedOrigins().then(function(origins) {
      sites = SharedUtils.setMirrorSites(SharedUtils.getMirrorSitesFromOrigins(origins));
      render();
      return sites;
    });
  }

  function queryActiveTab() {
    return new Promise(function(resolve) {
      if (!chrome.tabs || typeof chrome.tabs.query !== 'function') {
        resolve(null);
        return;
      }
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(tabs && tabs[0] ? tabs[0] : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function syncWithBackground() {
    return new Promise(function(resolve) {
      try {
        chrome.runtime.sendMessage({ type: MESSAGE_TYPES.MIRROR_SITES_SYNC }, function(response) {
          var runtimeError = chrome.runtime.lastError;
          if (runtimeError || !response || !response.ok) {
            resolve({ ok: false, error: runtimeError ? runtimeError.message : ((response && response.error) || '后台无响应') });
            return;
          }
          resolve(response);
        });
      } catch (e) {
        resolve({ ok: false, error: errorMessage(e) });
      }
    });
  }

  function reloadTab(tabId) {
    return new Promise(function(resolve) {
      if (!chrome.tabs || typeof chrome.tabs.reload !== 'function') {
        resolve(false);
        return;
      }
      try {
        chrome.tabs.reload(tabId, function() {
          resolve(!chrome.runtime.lastError);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  function getTabHost(tab) {
    try {
      var parsed = new URL(tab && tab.url || '');
      return parsed.protocol === 'https:' ? parsed.hostname : '';
    } catch (e) {
      return '';
    }
  }

  function findGrantedSite(site) {
    for (var i = 0; i < sites.length; i++) {
      if (sites[i].pattern === site.pattern) return sites[i];
    }
    return null;
  }

  function getActiveTabCandidate() {
    var host = getTabHost(activeTab);
    if (!host || SharedUtils.isSupportedForumHost(host)) return null;
    var parsed = SharedUtils.parseMirrorSiteInput(activeTab.url);
    return parsed.ok ? parsed.site : null;
  }

  function setBusy(nextBusy) {
    busy = nextBusy;
    [els.addMirror, els.addCurrentMirror, els.mirrorInput].forEach(function(el) {
      if (el) el.disabled = nextBusy;
    });
    if (els.mirrorList) {
      var buttons = els.mirrorList.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) buttons[i].disabled = nextBusy;
    }
  }

  function clearPendingRemove() {
    if (!pendingRemove) return;
    clearTimeout(pendingRemove.timer);
    if (pendingRemove.button) {
      pendingRemove.button.textContent = '移除';
      pendingRemove.button.removeAttribute('data-confirming');
    }
    pendingRemove = null;
  }

  function render() {
    clearPendingRemove();
    if (els.mirrorList) {
      while (els.mirrorList.firstChild) els.mirrorList.removeChild(els.mirrorList.firstChild);
      sites.forEach(function(site) {
        var item = document.createElement('li');
        item.className = 'mirror-item';
        var label = document.createElement('span');
        label.className = 'mirror-root';
        label.textContent = site.subdomains ? site.root : site.root + '（仅此主机）';
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn-mirror-remove';
        remove.textContent = '移除';
        remove.setAttribute('aria-label', '移除镜像站点 ' + site.root);
        remove.disabled = busy;
        remove.addEventListener('click', function() { handleRemoveClick(site, remove); });
        item.appendChild(label);
        item.appendChild(remove);
        els.mirrorList.appendChild(item);
      });
    }
    if (els.mirrorEmpty) els.mirrorEmpty.classList.toggle('hidden', sites.length > 0);
    if (els.mirrorCount) els.mirrorCount.textContent = String(sites.length);
    var candidate = getActiveTabCandidate();
    var offerCurrent = !!candidate && !findGrantedSite(candidate);
    if (els.addCurrentMirror) {
      els.addCurrentMirror.classList.toggle('hidden', !offerCurrent);
      els.addCurrentMirror.textContent = offerCurrent ? '添加当前站点：' + candidate.root : '添加当前站点';
    }
    // An unapproved https tab is the likely reason the popup was opened.
    if (offerCurrent && !autoOpened && els.mirrorSection) {
      autoOpened = true;
      els.mirrorSection.open = true;
    }
  }

  async function finishGrant(site) {
    var sync = await syncWithBackground();
    try {
      await loadSites();
    } catch (e) {
      setStatus('已授权 ' + site.root + '，但读取权限列表失败：' + errorMessage(e), 'warn', true);
      return;
    }
    if (els.mirrorInput) els.mirrorInput.value = '';
    if (!sync.ok || sync.registered === false) {
      setStatus('已授权 ' + site.root + '，但后台注册脚本失败：' + (sync.error || '未知错误') + '。请在扩展管理页重新加载扩展', 'warn', true);
      return;
    }
    var host = getTabHost(activeTab);
    if (host && SharedUtils.isHostInMirrorSite(host, site) && activeTab.id !== undefined && activeTab.id !== null) {
      var reloaded = await reloadTab(activeTab.id);
      setStatus(reloaded ? '已添加 ' + site.root + '，正在刷新当前页面' : '已添加 ' + site.root + '，请手动刷新当前页面', reloaded ? 'ok' : 'warn', !reloaded);
      return;
    }
    setStatus('已添加 ' + site.root + '，打开或刷新该站点页面后生效', 'ok', true);
  }

  // Chrome only shows the permission prompt for a live user gesture, so this
  // must run synchronously inside the click handler (no await before request).
  function requestSite(site) {
    if (busy) return;
    if (findGrantedSite(site)) {
      setStatus(site.root + ' 已在镜像列表中', 'info');
      return;
    }
    if (sites.length >= SharedUtils.MIRROR_SITE_MAX_COUNT) {
      setStatus('最多添加 ' + SharedUtils.MIRROR_SITE_MAX_COUNT + ' 个镜像站点，请先移除不用的站点', 'err', true);
      return;
    }
    if (!chrome.permissions || typeof chrome.permissions.request !== 'function') {
      setStatus('当前浏览器不支持按站点授权', 'err', true);
      return;
    }
    setBusy(true);
    setStatus('请在浏览器弹出的对话框中允许访问 ' + site.root, 'info', true);
    try {
      chrome.permissions.request({ origins: [site.pattern] }, function(granted) {
        var runtimeError = chrome.runtime.lastError;
        if (runtimeError || !granted) {
          setBusy(false);
          setStatus(runtimeError ? '授权失败：' + runtimeError.message : '未授予 ' + site.root + ' 的访问权限', runtimeError ? 'err' : 'warn', true);
          return;
        }
        finishGrant(site).catch(function(e) {
          setStatus('添加 ' + site.root + ' 后同步失败：' + errorMessage(e), 'err', true);
        }).then(function() {
          setBusy(false);
        });
      });
    } catch (e) {
      setBusy(false);
      setStatus('授权失败：' + errorMessage(e), 'err', true);
    }
  }

  function addFromInput() {
    if (busy || !els.mirrorInput) return;
    var parsed = SharedUtils.parseMirrorSiteInput(els.mirrorInput.value);
    if (!parsed.ok) {
      setStatus(describeRejection(parsed.reason), 'err', true);
      els.mirrorInput.classList.add('input-error');
      setTimeout(function() { els.mirrorInput.classList.remove('input-error'); }, 600);
      return;
    }
    requestSite(parsed.site);
  }

  function removeSite(site) {
    setBusy(true);
    try {
      chrome.permissions.remove({ origins: [site.pattern] }, function(removed) {
        var runtimeError = chrome.runtime.lastError;
        syncWithBackground().then(function() {
          return loadSites();
        }).catch(function() {}).then(function() {
          setBusy(false);
          if (runtimeError || !removed) {
            setStatus('无法移除 ' + site.root + (runtimeError ? '：' + runtimeError.message : ''), 'err', true);
            return;
          }
          setStatus('已移除 ' + site.root + '，该站点已打开的页面刷新后停用', 'ok', true);
        });
      });
    } catch (e) {
      setBusy(false);
      setStatus('无法移除 ' + site.root + '：' + errorMessage(e), 'err', true);
    }
  }

  function handleRemoveClick(site, button) {
    if (busy) return;
    if (pendingRemove && pendingRemove.button === button) {
      clearPendingRemove();
      removeSite(site);
      return;
    }
    clearPendingRemove();
    button.textContent = '确认移除';
    button.setAttribute('data-confirming', 'true');
    pendingRemove = { button: button, timer: setTimeout(clearPendingRemove, REMOVE_CONFIRM_MS) };
    setStatus('再次点击“确认移除”以撤销 ' + site.root + ' 的访问权限', 'warn');
  }

  if (els.addMirror) els.addMirror.addEventListener('click', addFromInput);
  if (els.mirrorInput) {
    els.mirrorInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        addFromInput();
      }
    });
  }
  if (els.addCurrentMirror) {
    els.addCurrentMirror.addEventListener('click', function() {
      var candidate = getActiveTabCandidate();
      if (candidate) requestSite(candidate);
    });
  }
  if (chrome.permissions && chrome.permissions.onAdded && typeof chrome.permissions.onAdded.addListener === 'function') {
    var reloadList = function() { loadSites().catch(function() {}); };
    chrome.permissions.onAdded.addListener(reloadList);
    chrome.permissions.onRemoved.addListener(reloadList);
  }

  // popup.js awaits this before resolving the active tab's site, so mirror
  // tabs are recognized as supported. It never rejects.
  var ready = Promise.all([
    loadSites(),
    queryActiveTab().then(function(tab) { activeTab = tab; })
  ]).then(function() {
    render();
    return SharedUtils.getMirrorSites();
  }).catch(function(e) {
    setStatus('读取镜像站点失败：' + errorMessage(e), 'warn', true);
    return SharedUtils.getMirrorSites();
  });

  window.ATPPopupMirrors = { ready: ready };
})();
