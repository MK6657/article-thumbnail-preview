(function () {
  'use strict';

  function esc(s) { return SharedUtils.escapeHtml(s); }

  var sidebar = null;
  var currentThread = null;
  var pinnedThread = null;
  var hoverThread = null;
  var hoverClearTimer = null;
  var sidebarHovering = false;
  var sidebarFocused = false;
  var sidebarRenderSignature = '';
  var HOVER_CLEAR_DELAY = 800;
  var RESOURCE_SIDEBAR_ID = 'atp-resource-sidebar';
  var RESOURCE_NARROW_QUERY = '(max-width: 1024px)';
  var resourceLayoutMedia = null;
  var resourceLayoutListenerBound = false;
  // Marked threads (site|tid ids) as the worker last stored them.
  var markedIds = Object.create(null);
  var marksListenerBound = false;
  var MARK_UPDATE_DELAY_MS = 800;
  var MARK_ERROR_TEXT = {
    limit_count: '已达 300 帖上限，请先导出并清空',
    limit_bytes: '标记内容已满，请先导出并清空',
    storage_write_failed: '保存失败：存储空间不足',
    storage_read_failed: '保存失败：无法读取标记',
    invalid_thread: '无法识别本帖，未标记',
    site_mismatch: '无法识别本帖，未标记',
    context_invalidated: '扩展已更新，请刷新页面',
    no_response: '保存失败，请重试'
  };

  function isEnabled() {
    if (!window.ATPConfig || !ATPConfig.loaded || !ATPConfig.isEnabled()) return false;
    var settings = window.ATPState && window.ATPState.settings;
    return !settings || settings.showResourcePanel !== false;
  }

  function shouldCopyPasswords() {
    var settings = window.ATPState && window.ATPState.settings;
    return !settings || settings.copyPasswordsWithLinks !== false;
  }

  function ensureSidebar() {
    if (sidebar) return sidebar;
    // 扩展重载/更新后旧上下文的侧栏可能残留在页面上（监听器已随旧上下文失效）：
    // 先移除同 id 的孤儿节点，避免出现两个固定定位侧栏叠在一起
    var staleSidebar = document.getElementById(RESOURCE_SIDEBAR_ID);
    if (staleSidebar && staleSidebar.parentNode) staleSidebar.remove();
    sidebar = document.createElement('div');
    sidebar.className = 'atp-resource-sidebar';
    sidebar.id = RESOURCE_SIDEBAR_ID;
    sidebar.tabIndex = -1;
    sidebar.setAttribute('role', 'region');
    sidebar.setAttribute('aria-label', '本帖资源');
    sidebar.addEventListener('mouseenter', function() {
      sidebarHovering = true;
      clearHoverClearTimer();
    });
    sidebar.addEventListener('mouseleave', function() {
      sidebarHovering = false;
      if (hoverThread && hoverThread !== pinnedThread) scheduleHoverClear(hoverThread, 120);
    });
    sidebar.addEventListener('focusin', function() {
      sidebarFocused = true;
      clearHoverClearTimer();
    });
    sidebar.addEventListener('focusout', function(e) {
      if (e.relatedTarget && sidebar.contains(e.relatedTarget)) return;
      sidebarFocused = false;
      if (hoverThread && hoverThread !== pinnedThread) scheduleHoverClear(hoverThread, 120);
    });
    sidebar.addEventListener('keydown', function(e) {
      if (!e || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeTemporarySidebar(true);
    });
    sidebar.addEventListener('click', handleSidebarClick);
    document.body.appendChild(sidebar);
    return sidebar;
  }

  function handleSidebarClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn || !sidebar || !sidebar.contains(btn)) return;
    var state = currentThread;
    e.stopPropagation();
    if (btn.getAttribute && btn.getAttribute('aria-disabled') === 'true') return;
    if (btn.hasAttribute('data-sidebar-pin-toggle')) {
      togglePinnedThread(state);
      return;
    }
    if (btn.hasAttribute('data-copy-type')) {
      copyType(btn.getAttribute('data-copy-type'), sidebar);
      return;
    }
    if (btn.hasAttribute('data-copy-all')) {
      copyAllLinks(sidebar);
      return;
    }
    if (btn.hasAttribute('data-copy-passwords')) {
      copyPasswordsOnly(sidebar);
      return;
    }
    if (btn.hasAttribute('data-parse-txt')) {
      var sidebarResult = requestTextResourceManualLoad(state);
      if (state) renderThread(state);
      if (sidebarResult.message) showMessage(sidebarResult.message, sidebar, !!sidebarResult.error);
      return;
    }
    if (btn.hasAttribute('data-import-txt')) {
      requestTextResourceLocalImport(state, sidebar);
    }
  }

  function clearHoverClearTimer() {
    if (hoverClearTimer) {
      clearTimeout(hoverClearTimer);
      hoverClearTimer = null;
    }
  }

  function scheduleHoverClear(threadState, delay) {
    clearHoverClearTimer();
    hoverClearTimer = setTimeout(function() {
      hoverClearTimer = null;
      if (sidebarHovering || sidebarFocused || (sidebar && sidebar.contains(document.activeElement))) return;
      if (!threadState || hoverThread === threadState) {
        hoverThread = null;
        renderThread(pinnedThread || null);
      }
    }, delay || HOVER_CLEAR_DELAY);
  }

  function getResourceActionKey(btn) {
    if (!btn || !btn.hasAttribute) return null;
    var attrs = [
      'data-sidebar-pin-toggle',
      'data-pin-toggle',
      'data-copy-type',
      'data-copy-all',
      'data-copy-passwords',
      'data-parse-txt',
      'data-import-txt'
    ];
    for (var i = 0; i < attrs.length; i++) {
      if (btn.hasAttribute(attrs[i])) {
        return { attr: attrs[i], value: btn.getAttribute(attrs[i]) || '' };
      }
    }
    return null;
  }

  function getFocusedResourceAction(root) {
    var active = document.activeElement;
    if (!root || !active || !root.contains || !root.contains(active)) return null;
    var btn = active.closest ? active.closest('button') : null;
    if (!btn || !root.contains(btn)) return null;
    return getResourceActionKey(btn);
  }

  function restoreResourceActionFocus(root, actionKey) {
    if (!root || !actionKey || !root.querySelectorAll) return false;
    var buttons = root.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (!btn.hasAttribute || !btn.hasAttribute(actionKey.attr)) continue;
      if ((btn.getAttribute(actionKey.attr) || '') !== actionKey.value) continue;
      if (typeof btn.focus === 'function') {
        btn.focus();
        return document.activeElement === btn;
      }
    }
    return false;
  }

  function focusFirstResourceAction(root) {
    if (!root || !root.querySelector) return false;
    var target = root.querySelector('button, [tabindex]:not([tabindex="-1"])');
    if (!target) target = root;
    if (target && typeof target.focus === 'function') {
      target.focus();
      return document.activeElement === target;
    }
    return false;
  }

  function restoreDesktopResourceActionFocus(root, actionKey) {
    if (restoreResourceActionFocus(root, actionKey)) return true;
    if (actionKey && actionKey.attr === 'data-pin-toggle') {
      return restoreResourceActionFocus(root, { attr: 'data-sidebar-pin-toggle', value: actionKey.value });
    }
    return false;
  }

  function restoreInlineResourceActionFocus(panel, actionKey) {
    var inline = panel && panel.querySelector ? panel.querySelector('.atp-resource-inline') : null;
    if (!inline) return false;
    if (restoreResourceActionFocus(inline, actionKey)) return true;
    if (actionKey && actionKey.attr === 'data-sidebar-pin-toggle') {
      return restoreResourceActionFocus(inline, { attr: 'data-pin-toggle', value: actionKey.value });
    }
    return false;
  }

  function updateThreadExpandedState(threadState, expanded) {
    if (!threadState || !threadState.panel) return;
    var trigger = getResourceTrigger(threadState.panel);
    if (trigger) trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function updateDisplayedThreadExpandedState(expanded) {
    updateThreadExpandedState(currentThread, expanded);
    updateThreadExpandedState(pinnedThread, expanded);
    updateThreadExpandedState(hoverThread, expanded);
  }

  function getResourceTrigger(panel) {
    return panel && panel.querySelector ? panel.querySelector('[data-resource-trigger]') : null;
  }

  function ensureResourceTrigger(panel, threadState) {
    if (!panel || !threadState || !panel.querySelector) return null;
    var toolbar = panel.querySelector('.atp-toolbar');
    if (!toolbar) return null;
    var trigger = getResourceTrigger(panel);
    if (!trigger) {
      trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'atp-resource-trigger';
      trigger.setAttribute('data-resource-trigger', '1');
      trigger.textContent = '资源';
      toolbar.appendChild(trigger);
    }
    trigger.setAttribute('aria-label', '查看本帖资源');
    trigger.setAttribute('aria-controls', RESOURCE_SIDEBAR_ID);
    trigger.setAttribute('aria-expanded', currentThread === threadState && isSidebarVisible() ? 'true' : 'false');
    if (!trigger.__atpResourceTriggerBound) {
      trigger.__atpResourceTriggerBound = true;
      trigger.addEventListener('click', function(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        openSidebarFromTrigger(panel);
      });
      trigger.addEventListener('keydown', function(e) {
        if (!e || e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        closeTemporarySidebar(false);
      });
    }
    return trigger;
  }

  function removeResourceTrigger(panel) {
    var trigger = getResourceTrigger(panel);
    if (!trigger) return;
    if (trigger.parentNode && trigger.parentNode.removeChild) {
      trigger.parentNode.removeChild(trigger);
    } else if (trigger.remove) {
      trigger.remove();
    }
  }

  function syncResourceTrigger(panel, threadState) {
    if (isEnabled()) return ensureResourceTrigger(panel, threadState);
    removeResourceTrigger(panel);
    return null;
  }

  // ---- Marking ----

  function isMarkingEnabled() {
    return !!(window.ATPConfig && ATPConfig.loaded && ATPConfig.isEnabled() && window.ATPMarks);
  }

  function isThreadMarked(threadState) {
    return !!(threadState && threadState.markIdentity && markedIds[threadState.markIdentity.id]);
  }

  function readMarkedIds(index) {
    var next = Object.create(null);
    var items = index && Array.isArray(index.items) ? index.items : [];
    for (var i = 0; i < items.length; i++) {
      if (items[i] && typeof items[i].id === 'string') next[items[i].id] = true;
    }
    markedIds = next;
  }

  function loadMarkedIds() {
    if (!window.ATPMarks || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
      chrome.storage.local.get(ATPMarks.KEYS.INDEX, function(items) {
        if (chrome.runtime.lastError) return;
        readMarkedIds(items && items[ATPMarks.KEYS.INDEX]);
        refreshMarkToggles();
      });
    } catch (e) {}
  }

  function handleMarksStorageChange(changes, areaName) {
    if (areaName !== 'local' || !changes || !window.ATPMarks || !changes[ATPMarks.KEYS.INDEX]) return;
    readMarkedIds(changes[ATPMarks.KEYS.INDEX].newValue);
    refreshMarkToggles();
  }

  function handleMarksPageShow(e) {
    if (e && e.persisted) loadMarkedIds();
  }

  function bindMarksListener() {
    if (marksListenerBound || !window.ATPMarks) return;
    marksListenerBound = true;
    try {
      if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(handleMarksStorageChange);
    } catch (e) {}
    // Marks made in other tabs while this page sat in the back/forward cache.
    if (window.addEventListener) window.addEventListener('pageshow', handleMarksPageShow);
    loadMarkedIds();
  }

  function sendMarksMessage(payload) {
    return new Promise(function(resolve) {
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          resolve({ ok: false, error: 'context_invalidated' });
          return;
        }
        chrome.runtime.sendMessage(Object.assign({ type: SharedUtils.MESSAGE_TYPES.MARKS_MUTATION }, payload), function(response) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: 'no_response' });
            return;
          }
          resolve(response && typeof response === 'object' ? response : { ok: false, error: 'no_response' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'context_invalidated' });
      }
    });
  }

  function getMarkToggle(panel) {
    return panel && panel.querySelector ? panel.querySelector('[data-mark-toggle]') : null;
  }

  function updateMarkToggle(btn, threadState) {
    if (!btn || btn.__atpMarkBusy || btn.__atpMarkMessageTimer) return;
    var marked = isThreadMarked(threadState);
    var title = (threadState && threadState.title) || '本帖';
    btn.textContent = marked ? '已标记' : '标记';
    btn.setAttribute('aria-pressed', marked ? 'true' : 'false');
    btn.setAttribute('aria-label', (marked ? '取消标记：' : '标记资源：') + title);
    btn.title = marked
      ? '已保存本帖标题、链接和密码；再次点击取消标记'
      : '保存本帖标题、链接和密码，稍后在扩展弹窗中导出';
  }

  function refreshMarkToggles() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    var buttons = document.querySelectorAll('[data-mark-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      var panel = buttons[i].closest ? buttons[i].closest('.atp-thread-panel') : null;
      var threadState = panel && panel.__atpResourceThread;
      updateMarkToggle(buttons[i], threadState);
      // A marked thread on this page brings its mark up to date once.
      if (threadState) scheduleMarkUpdate(threadState);
    }
    if (currentThread) renderThread(currentThread);
  }

  function showMarkError(btn, threadState, code) {
    if (!btn) return;
    if (btn.__atpMarkMessageTimer) clearTimeout(btn.__atpMarkMessageTimer);
    var text = MARK_ERROR_TEXT[code] || '保存失败，请重试';
    btn.textContent = text;
    btn.setAttribute('role', 'alert');
    btn.__atpMarkMessageTimer = setTimeout(function() {
      btn.__atpMarkMessageTimer = null;
      btn.removeAttribute('role');
      updateMarkToggle(btn, threadState);
    }, 2500);
  }

  function toggleThreadMark(panel, btn) {
    // The panel's own thread at the moment of the click, never the sidebar's.
    var threadState = panel && panel.__atpResourceThread;
    if (!threadState || !threadState.markIdentity || !btn || btn.__atpMarkBusy || !isMarkingEnabled()) return;
    var marking = !isThreadMarked(threadState);
    var identity = threadState.markIdentity;
    var payload;
    if (marking) {
      var snapshot = ATPMarks.buildSnapshot(threadState, identity, 'all');
      if (!snapshot) {
        showMarkError(btn, threadState, 'invalid_thread');
        return;
      }
      payload = { op: 'mark', snapshot: snapshot };
      threadState.__atpMarkSentSignature = markSnapshotSignature(snapshot);
    } else {
      payload = { op: 'unmark', id: identity.id };
    }
    if (btn.__atpMarkMessageTimer) {
      clearTimeout(btn.__atpMarkMessageTimer);
      btn.__atpMarkMessageTimer = null;
      btn.removeAttribute('role');
    }
    btn.__atpMarkBusy = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.textContent = marking ? '保存中…' : '取消中…';
    sendMarksMessage(payload).then(function(result) {
      btn.__atpMarkBusy = false;
      btn.removeAttribute('aria-disabled');
      if (result && result.ok) {
        if (marking) markedIds[identity.id] = true;
        else delete markedIds[identity.id];
        updateMarkToggle(btn, threadState);
        if (currentThread === threadState) renderThread(threadState);
        return;
      }
      threadState.__atpMarkSentSignature = '';
      showMarkError(btn, threadState, result && result.error);
    });
  }

  function syncMarkToggle(panel, threadState) {
    var btn = getMarkToggle(panel);
    if (!isMarkingEnabled() || !threadState || !threadState.markIdentity) {
      if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      return null;
    }
    bindMarksListener();
    var toolbar = panel.querySelector ? panel.querySelector('.atp-toolbar') : null;
    if (!toolbar) return null;
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'atp-mark-toggle';
      btn.setAttribute('data-mark-toggle', '1');
      toolbar.appendChild(btn);
      btn.addEventListener('click', function(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        toggleThreadMark(panel, btn);
      });
    }
    updateMarkToggle(btn, threadState);
    return btn;
  }

  // What a marked thread holds, minus the read time: a new read of the same
  // content is not a change worth sending.
  function markSnapshotSignature(snapshot) {
    return JSON.stringify([snapshot.title, snapshot.links, snapshot.passwords, snapshot.excludedLinks,
      snapshot.textAttachments, snapshot.textUnresolved, snapshot.partial, snapshot.importedText, snapshot.complete]);
  }

  // A marked thread shown again or grown by its TXT attachments: the worker
  // adds what is new to the mark (it never removes anything).
  function scheduleMarkUpdate(threadState) {
    if (!isThreadMarked(threadState) || threadState.__atpMarkUpdateTimer) return;
    threadState.__atpMarkUpdateTimer = setTimeout(function() {
      threadState.__atpMarkUpdateTimer = null;
      if (!isThreadMarked(threadState) || !isThreadAttached(threadState) || !isMarkingEnabled()) return;
      var snapshot = ATPMarks.buildSnapshot(threadState, threadState.markIdentity, 'all');
      if (!snapshot) return;
      var signature = markSnapshotSignature(snapshot);
      if (signature === threadState.__atpMarkSentSignature) return;
      threadState.__atpMarkSentSignature = signature;
      sendMarksMessage({ op: 'update', snapshot: snapshot }).then(function(result) {
        if (!result || !result.ok) threadState.__atpMarkSentSignature = '';
      });
    }, MARK_UPDATE_DELAY_MS);
  }

  // Everything copied goes into today's backup with the thread's title.
  function recordCopy(threadState, scope) {
    if (!isMarkingEnabled()) return Promise.resolve({ ok: true, skipped: true });
    if (!threadState || !threadState.markIdentity) return Promise.resolve({ ok: false, error: 'invalid_thread' });
    var snapshot = ATPMarks.buildSnapshot(threadState, threadState.markIdentity, scope);
    if (!snapshot) return Promise.resolve({ ok: false, error: 'invalid_thread' });
    return sendMarksMessage({ op: 'copied', scope: scope, snapshot: snapshot });
  }

  function focusFirstSidebarAction() {
    var el = ensureSidebar();
    var target = el.querySelector('button, [tabindex]:not([tabindex="-1"])');
    if (!target) target = el;
    if (target && typeof target.focus === 'function') target.focus();
  }

  function isSidebarVisible() {
    var el = sidebar;
    if (!el) {
      if (resourceLayoutMedia) return !resourceLayoutMedia.matches;
      return !window.matchMedia || !window.matchMedia(RESOURCE_NARROW_QUERY).matches;
    }
    if (!window.getComputedStyle) return true;
    var style = window.getComputedStyle(el);
    return !(style && (style.display === 'none' || style.visibility === 'hidden'));
  }

  function isNarrowResourceLayout() {
    if (resourceLayoutMedia) return !!resourceLayoutMedia.matches;
    return !isSidebarVisible();
  }

  function focusFirstInlineAction(panel) {
    var target = panel && panel.querySelector && panel.querySelector('.atp-resource-inline button, .atp-resource-inline [tabindex]:not([tabindex="-1"])');
    if (!target && !isNarrowResourceLayout()) target = getResourceTrigger(panel);
    if (target && typeof target.focus === 'function') {
      target.focus();
      return document.activeElement === target;
    }
    return false;
  }

  function focusInlineResourceAction(panel, actionKey) {
    if (restoreInlineResourceActionFocus(panel, actionKey)) return true;
    return focusFirstInlineAction(panel);
  }

  function releaseRemovedInlineFocus(panel) {
    var target = panel && panel.querySelector && panel.querySelector('.atp-thumbnail-wrapper[role="button"], .atp-thumbnail-wrapper button, .atp-thumbnail-container [tabindex]:not([tabindex="-1"])');
    if (target && typeof target.focus === 'function') {
      target.focus();
      if (document.activeElement === target) return true;
    }
    var active = document.activeElement;
    if (active && typeof active.blur === 'function') {
      active.blur();
      return document.activeElement !== active;
    }
    return false;
  }

  function releaseHiddenDesktopResourceFocus(threadState) {
    var active = document.activeElement;
    if (!active) return;
    var trigger = threadState && threadState.panel ? getResourceTrigger(threadState.panel) : null;
    if (!((sidebar && sidebar.contains(active)) || (trigger && (trigger === active || (trigger.contains && trigger.contains(active)))))) return;
    if (active.blur) {
      try { active.blur(); } catch (e) {}
    }
  }

  function releaseHiddenInlineResourceFocus(focusThread) {
    var active = document.activeElement;
    var inline = focusThread && focusThread.inline;
    if (!inline || !active || !inline.contains(active)) return;
    if (active.blur) {
      try { active.blur(); } catch (e) {}
    }
  }

  function focusDesktopResourceAction(panel, actionKey) {
    if (!panel) return false;
    showThreadResources(panel);
    var el = ensureSidebar();
    if (restoreDesktopResourceActionFocus(el, actionKey)) return true;
    var trigger = getResourceTrigger(panel);
    if (trigger && typeof trigger.focus === 'function') {
      trigger.focus();
      return document.activeElement === trigger;
    }
    return false;
  }

  function openSidebarFromTrigger(panel) {
    if (isSidebarVisible()) {
      showThreadResources(panel);
      focusFirstSidebarAction();
      return;
    }
    updateThreadExpandedState(panel && panel.__atpResourceThread, false);
    focusFirstInlineAction(panel);
  }

  function getDesktopFocusedThread() {
    var active = document.activeElement;
    if (!active) return null;
    var state;
    if (sidebar && sidebar.contains(active)) {
      state = currentThread || pinnedThread || hoverThread;
      return state ? { panel: state.panel, thread: state, actionKey: getFocusedResourceAction(sidebar) } : null;
    }
    var refs = [currentThread, pinnedThread, hoverThread];
    for (var i = 0; i < refs.length; i++) {
      state = refs[i];
      var trigger = state && state.panel ? getResourceTrigger(state.panel) : null;
      if (trigger && (trigger === active || (trigger.contains && trigger.contains(active)))) {
        return { panel: state.panel, thread: state, actionKey: null };
      }
    }
    return null;
  }

  function getInlineFocusedThread() {
    var active = document.activeElement;
    if (!active || !active.closest) return null;
    var inline = active.closest('.atp-resource-inline');
    if (!inline || !inline.contains(active)) return null;
    var panel = inline.closest ? inline.closest('.atp-thread-panel') : null;
    var state = panel && panel.__atpResourceThread;
    if (!state) return null;
    return {
      panel: panel,
      thread: state,
      inline: inline,
      actionKey: getFocusedResourceAction(inline)
    };
  }

  function syncResourceLayoutForViewport() {
    if (!isNarrowResourceLayout()) {
      var inlineFocusThread = getInlineFocusedThread();
      if (currentThread) updateThreadExpandedState(currentThread, isSidebarVisible());
      if (inlineFocusThread && inlineFocusThread.panel && !focusDesktopResourceAction(inlineFocusThread.panel, inlineFocusThread.actionKey)) {
        releaseHiddenInlineResourceFocus(inlineFocusThread);
      }
      return;
    }
    var focusThread = getDesktopFocusedThread();
    updateDisplayedThreadExpandedState(false);
    sidebarHovering = false;
    sidebarFocused = false;
    if (focusThread && focusThread.panel && !focusInlineResourceAction(focusThread.panel, focusThread.actionKey)) {
      releaseHiddenDesktopResourceFocus(focusThread);
    }
  }

  function bindResourceLayoutListener() {
    if (resourceLayoutListenerBound || typeof window === 'undefined') return;
    resourceLayoutListenerBound = true;
    if (window.matchMedia) {
      resourceLayoutMedia = window.matchMedia(RESOURCE_NARROW_QUERY);
      if (resourceLayoutMedia.addEventListener) {
        resourceLayoutMedia.addEventListener('change', syncResourceLayoutForViewport);
      } else if (resourceLayoutMedia.addListener) {
        resourceLayoutMedia.addListener(syncResourceLayoutForViewport);
      }
    }
    if (window.addEventListener) window.addEventListener('resize', syncResourceLayoutForViewport);
    syncResourceLayoutForViewport();
  }

  function unbindResourceLayoutListener() {
    if (!resourceLayoutListenerBound) return;
    if (resourceLayoutMedia) {
      if (resourceLayoutMedia.removeEventListener) {
        resourceLayoutMedia.removeEventListener('change', syncResourceLayoutForViewport);
      } else if (resourceLayoutMedia.removeListener) {
        resourceLayoutMedia.removeListener(syncResourceLayoutForViewport);
      }
    }
    if (window.removeEventListener) window.removeEventListener('resize', syncResourceLayoutForViewport);
    resourceLayoutMedia = null;
    resourceLayoutListenerBound = false;
  }

  function closeTemporarySidebar(restoreFocus) {
    var closingThread = hoverThread || currentThread;
    clearHoverClearTimer();
    sidebarHovering = false;
    sidebarFocused = false;
    hoverThread = null;
    renderThread(pinnedThread || null);
    var trigger = closingThread && closingThread.panel ? getResourceTrigger(closingThread.panel) : null;
    if (restoreFocus && trigger && typeof trigger.focus === 'function') {
      trigger.focus();
    }
  }

  function getGroupsFromNormalized(resources) {
    var groups = [];
    for (var i = 0; i < SharedUtils.RESOURCE_GROUP_ORDER.length; i++) {
      var type = SharedUtils.RESOURCE_GROUP_ORDER[i];
      var items = resources.groups[type] || [];
      if (items.length) groups.push({ type: type, label: SharedUtils.RESOURCE_GROUP_LABELS[type], items: items });
    }
    return groups;
  }

  function hasTxtSource(items) {
    for (var i = 0; i < (items || []).length; i++) {
      if (SharedUtils.hasResourceSource(items[i].source, 'txt')) return true;
    }
    return false;
  }

  function resourcesHaveTxtFromNormalized(resources) {
    for (var i = 0; i < SharedUtils.RESOURCE_GROUP_ORDER.length; i++) {
      if (hasTxtSource(resources.groups[SharedUtils.RESOURCE_GROUP_ORDER[i]])) return true;
    }
    return false;
  }

  function hasResourcePayload(resources) {
    return SharedUtils.hasResourcePayload
      ? SharedUtils.hasResourcePayload(resources)
      : (SharedUtils.hasResources(resources) || !!SharedUtils.normalizeResources(resources).passwords.length);
  }

  function getTextAttachmentCount(threadState) {
    if (!threadState) return 0;
    var count = (threadState.textAttachments && threadState.textAttachments.length) || threadState.textAttachmentCount || 0;
    if (count) return count;
    return (threadState.hasTextAttachments || threadState.textResourcesRetryable) ? 1 : 0;
  }

  function canParseTextResources(threadState) {
    if (!threadState) return false;
    var hasTextWork = !!((threadState.textAttachments && threadState.textAttachments.length) || threadState.hasTextAttachments || threadState.textResourcesRetryable);
    if (!hasTextWork && threadState.textResourcesLoading) hasTextWork = !!getTextAttachmentCount(threadState);
    if (!hasTextWork) return false;
    if (threadState.textResourcesLoading) return true;
    if (threadState.textResourcesDone && !threadState.textResourcesRetryable) return false;
    return true;
  }

  function shouldShowTextFallbackActions(threadState) {
    return !!(
      canParseTextResources(threadState) &&
      !threadState.textResourcesLoading &&
      !threadState.textResourcesImporting &&
      !threadState.textResourcesAutoQueued &&
      !threadState.textResourcesAutoActive &&
      threadState.textResourcesRetryable
    );
  }

  function markTextResourceManualScheduleFailed(threadState, message) {
    if (!threadState) return;
    threadState.textResourcesLoading = false;
    threadState.textResourcesDone = false;
    threadState.textResourcesRetryable = true;
    threadState.textResourceMessage = message || 'TXT 资源解析启动失败';
  }

  function requestTextResourceManualLoad(threadState) {
    if (!threadState) {
      return { scheduled: false, error: true, message: 'TXT 资源解析启动失败' };
    }
    if (threadState.textResourcesImporting) {
      return { scheduled: false, loading: true, message: '正在导入本地 TXT' };
    }
    if (threadState.textResourcesLoading) {
      return { scheduled: false, loading: true, message: getTextResourceStatusMessage(threadState, false) || 'TXT 资源解析中' };
    }
    if (threadState.textResourcesDone && !threadState.textResourcesRetryable) {
      return { scheduled: false, done: true, message: getTextResourceStatusMessage(threadState, false) || 'TXT 资源已解析完成' };
    }
    if (!canParseTextResources(threadState)) {
      markTextResourceManualScheduleFailed(threadState, '没有可解析的 TXT 附件');
      return { scheduled: false, error: true, message: threadState.textResourceMessage };
    }
    if (!window.ATPRenderer || typeof window.ATPRenderer.scheduleTextResourceLoad !== 'function') {
      markTextResourceManualScheduleFailed(threadState, 'TXT 资源解析暂不可用');
      return { scheduled: false, error: true, message: threadState.textResourceMessage };
    }
    try {
      var scheduled = window.ATPRenderer.scheduleTextResourceLoad(threadState, true);
      if (scheduled !== true && !threadState.textResourcesLoading) {
        markTextResourceManualScheduleFailed(threadState, 'TXT 资源解析启动失败');
        return { scheduled: false, error: true, message: threadState.textResourceMessage };
      }
      return { scheduled: true, message: getTextResourceStatusMessage(threadState, false) || 'TXT 资源解析中' };
    } catch (e) {
      markTextResourceManualScheduleFailed(threadState, 'TXT 资源解析启动失败');
      return { scheduled: false, error: true, message: threadState.textResourceMessage };
    }
  }

  function normalizeLocalTextFileName(name) {
    name = String(name || '').replace(/\\/g, '/');
    var slash = name.lastIndexOf('/');
    if (slash !== -1) name = name.slice(slash + 1);
    return name.trim().toLowerCase();
  }

  function readLocalTextFile(file) {
    return new Promise(function(resolve, reject) {
      if (!file || typeof FileReader !== 'function') {
        reject(new Error('file_reader_unavailable'));
        return;
      }
      if (file.size > SharedUtils.TEXT_ATTACHMENT_MAX_BYTES) {
        reject(new Error('file_too_large'));
        return;
      }
      var name = normalizeLocalTextFileName(file.name);
      if (!/\.txt$/i.test(name) && !/^text\//i.test(file.type || '')) {
        reject(new Error('file_type_not_supported'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function() {
        var buffer = reader.result;
        if (!buffer || typeof buffer.byteLength !== 'number' || buffer.byteLength > SharedUtils.TEXT_ATTACHMENT_MAX_BYTES) {
          reject(new Error('file_too_large'));
          return;
        }
        var text = SharedUtils.decodeTextBuffer(buffer, file.type || 'text/plain');
        if (!text || SharedUtils.looksLikeHtmlDocument(text) || SharedUtils.isUnavailableTextDocument(text)) {
          reject(new Error('file_not_text_resource'));
          return;
        }
        resolve({
          name: file.name || '',
          resources: SharedUtils.normalizeResources(SharedUtils.extractResources(text, location.href, 'txt'))
        });
      };
      reader.onerror = function() { reject(reader.error || new Error('file_read_failed')); };
      reader.onabort = function() { reject(new Error('file_read_aborted')); };
      reader.readAsArrayBuffer(file);
    });
  }

  function finishLocalTextImport(threadState, imports, sourceEl) {
    if (!threadState || !isThreadAttached(threadState)) return;
    threadState.textResourcesImporting = false;
    var usable = [];
    for (var i = 0; i < imports.length; i++) {
      if (imports[i] && SharedUtils.hasResourcePayload(imports[i].resources)) usable.push(imports[i]);
    }
    if (!usable.length) {
      threadState.textResourcesDone = false;
      threadState.textResourcesRetryable = true;
      threadState.textResourceMessage = '本地 TXT 未识别到资源链接';
      renderThread(threadState);
      var emptyMessageRoot = threadState.panel && threadState.panel.querySelector('.atp-resource-inline');
      showMessage(threadState.textResourceMessage, emptyMessageRoot || sidebar || sourceEl, true);
      return;
    }
    if (!window.ATPRenderer || typeof window.ATPRenderer.importTextResources !== 'function' || ATPRenderer.importTextResources(threadState, usable) !== true) {
      threadState.textResourcesDone = false;
      threadState.textResourcesRetryable = true;
      threadState.textResourceMessage = '本地 TXT 导入失败';
      renderThread(threadState);
      var failureMessageRoot = threadState.panel && threadState.panel.querySelector('.atp-resource-inline');
      showMessage(threadState.textResourceMessage, failureMessageRoot || sidebar || sourceEl, true);
      return;
    }
    renderThread(threadState);
    var messageRoot = threadState.panel && threadState.panel.querySelector('.atp-resource-inline');
    showMessage(threadState.textResourceMessage || '本地 TXT 已导入', messageRoot || sidebar, false);
  }

  function requestTextResourceLocalImport(threadState, sourceEl) {
    if (!threadState || threadState.textResourcesImporting) return false;
    if (!getTextAttachmentCount(threadState)) {
      showMessage('没有可导入的 TXT 附件', sourceEl || sidebar, true);
      return false;
    }
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,text/plain';
    input.multiple = getTextAttachmentCount(threadState) > 1;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.width = '1px';
    input.style.height = '1px';
    var cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (input.parentNode) input.remove();
    }
    input.addEventListener('change', function() {
      var files = Array.prototype.slice.call(input.files || [], 0, SharedUtils.TEXT_ATTACHMENT_MAX_COUNT);
      if (!files.length) {
        cleanup();
        return;
      }
      threadState.textResourcesImporting = true;
      threadState.textResourceMessage = '正在导入本地 TXT';
      ATPResourcePanel.updateThread(threadState);
      var reads = [];
      for (var i = 0; i < files.length; i++) {
        reads.push(readLocalTextFile(files[i]).catch(function() { return null; }));
      }
      Promise.all(reads).then(function(imports) {
        cleanup();
        finishLocalTextImport(threadState, imports, sourceEl);
      }, function() {
        cleanup();
        finishLocalTextImport(threadState, [], sourceEl);
      });
    });
    document.body.appendChild(input);
    input.click();
    window.addEventListener('focus', function handlePickerFocus() {
      window.removeEventListener('focus', handlePickerFocus);
      setTimeout(function() {
        if (!input.files || !input.files.length) cleanup();
      }, 1000);
    });
    return true;
  }

  function isThreadAttached(threadState) {
    if (!threadState) return false;
    if (threadState.panel && !document.contains(threadState.panel)) return false;
    if (threadState.container && !document.contains(threadState.container)) return false;
    return true;
  }

  function clearThreadRefs(threadState) {
    updateThreadExpandedState(threadState, false);
    if (currentThread === threadState) currentThread = null;
    if (pinnedThread === threadState) pinnedThread = null;
    if (hoverThread === threadState) hoverThread = null;
  }

  function getTextResourceStatusMessage(threadState, emptyFallback) {
    if (!threadState) return '';
    var attachmentCount = getTextAttachmentCount(threadState);
    if (threadState.textResourceMessage) return threadState.textResourceMessage;
    if (threadState.textResourcesAutoQueued) return 'TXT 资源自动解析排队中';
    if (threadState.textResourcesLoading) {
      var loadingText = threadState.textResourcesAutoActive ? 'TXT 资源自动解析中' : 'TXT 资源解析中';
      return attachmentCount ? loadingText + '（' + attachmentCount + ' 个附件）' : loadingText;
    }
    if (!threadState.textResourcesDone && attachmentCount) {
      return '识别到 TXT 附件 ' + attachmentCount + ' 个';
    }
    if (emptyFallback && !threadState.textResourcesDone && !attachmentCount) {
      return '未提取到资源链接';
    }
    return '';
  }

  function getCopyLabel(group) {
    return '复制' + group.label + '资源（' + group.items.length + '条）';
  }

  function getLiveRegionHtml(className) {
    return '<div class="' + className + '" role="status" aria-live="polite" aria-atomic="true"></div>';
  }

  function getStatusRegionHtml(tagName, className, text) {
    return '<' + tagName + ' class="' + className + '" role="status" aria-live="polite" aria-atomic="true">' + esc(text) + '</' + tagName + '>';
  }

  function getPlainStatusHtml(tagName, className, text) {
    return '<' + tagName + ' class="' + className + '">' + esc(text) + '</' + tagName + '>';
  }

  function getPinToggleHtml(threadState, extraClass, dataAttr) {
    var isPinned = pinnedThread === threadState;
    return '<button type="button" class="atp-resource-pin-toggle ' + esc(extraClass || '') + '" ' + dataAttr + '="1" aria-pressed="' + (isPinned ? 'true' : 'false') + '" aria-label="' + (isPinned ? '取消固定本帖资源' : '固定本帖资源') + '">' + (isPinned ? '取消固定' : '固定') + '</button>';
  }

  function getTextParseButtonHtml(threadState, compact) {
    var attachmentCount = getTextAttachmentCount(threadState);
    var loading = !!(threadState && threadState.textResourcesLoading);
    var label = loading ? 'TXT 资源解析中' : '解析TXT';
    var text = loading ? '解析中' : '解析TXT';
    if (attachmentCount) {
      label += '（' + attachmentCount + '个附件）';
      if (!compact) text += ' (' + attachmentCount + '个附件)';
    }
    return '<button type="button" class="atp-resource-parse-btn" data-parse-txt="1" aria-label="' + esc(label) + '"' + (loading ? ' aria-disabled="true"' : '') + '>' + esc(text) + '</button>';
  }

  function getTextImportButtonHtml(threadState, compact) {
    var attachmentCount = getTextAttachmentCount(threadState);
    if (!attachmentCount) return '';
    var importing = !!(threadState && threadState.textResourcesImporting);
    var label = importing ? '本地 TXT 导入中' : '导入已下载 TXT';
    var text = importing ? '导入中' : (compact ? '导入TXT' : '导入已下载TXT');
    return '<button type="button" class="atp-resource-import-btn" data-import-txt="1" aria-label="' + esc(label) + '"' + (importing ? ' aria-disabled="true"' : '') + '>' + esc(text) + '</button>';
  }

  function getSidebarRenderSignature(threadState, resources, groups, emptyMessage, statusMessage, hasPendingAttachments, showTextFallbackActions) {
    if (!threadState) return 'empty';
    var parts = [
      threadState.id || threadState.link || '',
      threadState.title || '',
      isThreadMarked(threadState) ? 'm1' : 'm0',
      pinnedThread === threadState ? 'p1' : 'p0',
      resourcesHaveTxtFromNormalized(resources) ? 'txt1' : 'txt0',
      resources.passwords.length,
      getTextAttachmentCount(threadState),
      hasPendingAttachments ? 'a1' : 'a0',
      showTextFallbackActions ? 'f1' : 'f0',
      threadState.textResourcesLoading ? 'l1' : 'l0',
      threadState.textResourcesAutoQueued ? 'q1' : 'q0',
      threadState.textResourcesAutoActive ? 'aa1' : 'aa0',
      threadState.textResourcesDone ? 'd1' : 'd0',
      threadState.textResourcesRetryable ? 'r1' : 'r0',
      threadState.textResourcesImporting ? 'i1' : 'i0',
      emptyMessage || '',
      statusMessage || ''
    ];
    for (var pi = 0; pi < resources.passwords.length; pi++) {
      parts.push('pw:' + resources.passwords[pi]);
    }
    for (var i = 0; i < groups.length; i++) {
      parts.push(groups[i].type + ':' + groups[i].items.length + ':' + (hasTxtSource(groups[i].items) ? 'txt' : 'html'));
      for (var gi = 0; gi < groups[i].items.length; gi++) {
        var item = groups[i].items[gi] || {};
        parts.push((item.url || '') + ':' + (item.code || '') + ':' + (item.source || ''));
      }
    }
    return parts.join('|');
  }

  function getInlineRenderSignature(threadState, resources, groups, statusMessage, hasPendingAttachments, showTextFallbackActions) {
    return 'inline|' + getSidebarRenderSignature(threadState, resources, groups, '', statusMessage, hasPendingAttachments, showTextFallbackActions);
  }

  function setSidebarHtml(el, signature, html) {
    if (sidebarRenderSignature === signature) return false;
    var actionKey = getFocusedResourceAction(el);
    clearMessageTimers(el);
    el.innerHTML = html;
    sidebarRenderSignature = signature;
    if (actionKey && !restoreResourceActionFocus(el, actionKey)) {
      focusFirstResourceAction(el);
    }
    return true;
  }

  function showThreadResources(panel) {
    var state = panel && panel.__atpResourceThread;
    if (!state) return;
    clearHoverClearTimer();
    hoverThread = state;
    renderThread(state);
  }

  function scheduleThreadResourceClear(panel) {
    var state = panel && panel.__atpResourceThread;
    if (state) scheduleHoverClear(state);
  }

  function handleInlineClick(e, panel, threadState, box) {
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn || !box || !box.contains(btn)) return;
    e.stopPropagation();
    if (btn.hasAttribute('data-pin-toggle')) {
      togglePinnedThread(threadState);
      return;
    }
    if (btn.hasAttribute('data-copy-type')) {
      renderThread(threadState);
      copyType(btn.getAttribute('data-copy-type'), box);
      return;
    }
    if (btn.hasAttribute('data-copy-all')) {
      renderThread(threadState);
      copyAllLinks(box);
      return;
    }
    if (btn.hasAttribute('data-copy-passwords')) {
      renderThread(threadState);
      copyPasswordsOnly(box);
      return;
    }
    if (btn.hasAttribute('data-parse-txt')) {
      if (btn.getAttribute && btn.getAttribute('aria-disabled') === 'true') return;
      var inlineResult = requestTextResourceManualLoad(threadState);
      renderThread(threadState);
      if (inlineResult.message) showMessage(inlineResult.message, panel.querySelector('.atp-resource-inline') || box, !!inlineResult.error);
      return;
    }
    if (btn.hasAttribute('data-import-txt')) {
      if (btn.getAttribute && btn.getAttribute('aria-disabled') === 'true') return;
      requestTextResourceLocalImport(threadState, box);
    }
  }

  function updatePanelToggleState(panel, threadState) {
    if (!panel || !threadState) return;
    var btn = panel.querySelector('[data-pin-toggle]');
    if (!btn) return;
    var isPinned = pinnedThread === threadState;
    btn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
    btn.setAttribute('aria-label', isPinned ? '取消固定本帖资源' : '固定本帖资源');
    btn.textContent = isPinned ? '取消固定' : '固定';
  }

  function togglePinnedThread(state) {
    if (!state) return;
    clearHoverClearTimer();
    var previousPinned = pinnedThread;
    if (pinnedThread === state) {
      pinnedThread = null;
      renderThread(hoverThread || null);
    } else {
      pinnedThread = state;
      renderThread(state);
    }
    if (previousPinned && previousPinned.panel) updatePanelToggleState(previousPinned.panel, previousPinned);
    if (state.panel) updatePanelToggleState(state.panel, state);
  }

  function renderThread(threadState) {
    if (!isEnabled()) {
      ATPResourcePanel.destroy();
      return;
    }
    if (threadState && !isThreadAttached(threadState)) {
      clearThreadRefs(threadState);
      threadState = null;
    }
    var previousThread = currentThread;
    currentThread = threadState || null;
    if (previousThread && previousThread !== currentThread) updateThreadExpandedState(previousThread, false);
    if (currentThread) updateThreadExpandedState(currentThread, isSidebarVisible());
    var el = ensureSidebar();
    if (!threadState) {
      if (previousThread) updateThreadExpandedState(previousThread, false);
      setSidebarHtml(el, 'empty', '<div class="atp-resource-title">本帖资源</div><div class="atp-resource-empty" role="status" aria-live="polite" aria-atomic="true">聚焦或移到帖子缩略图区域查看资源链接</div>');
      return;
    }

    var resources = SharedUtils.normalizeResources(threadState.resources);
    var groups = getGroupsFromNormalized(resources);
    var hasPendingAttachments = canParseTextResources(threadState);
    var showTextFallbackActions = shouldShowTextFallbackActions(threadState);
    var emptyMessage = getTextResourceStatusMessage(threadState, true);
    var statusMessage = getTextResourceStatusMessage(threadState, false);
    var renderSignature = getSidebarRenderSignature(threadState, resources, groups, emptyMessage, statusMessage, hasPendingAttachments, showTextFallbackActions);
    var html = '<div class="atp-resource-title">本帖资源';
    if (threadState === pinnedThread) html += '<span class="atp-resource-pin-badge">已固定</span>';
    if (resourcesHaveTxtFromNormalized(resources)) html += '<span class="atp-resource-source-badge">含 TXT 提取</span>';
    html += getPinToggleHtml(threadState, 'atp-resource-sidebar-pin', 'data-sidebar-pin-toggle');
    html += '</div>';
    if (threadState.title) {
      html += '<div class="atp-resource-thread-title" title="' + esc(threadState.title) + '">' + esc(threadState.title);
      if (isThreadMarked(threadState)) html += '<span class="atp-resource-mark-badge">已标记</span>';
      html += '</div>';
    }
    if (!groups.length) {
      if (resources.passwords.length) {
        html += '<div class="atp-resource-passwords">附带密码 ' + esc(resources.passwords.length) + ' 个</div>';
        html += '<button type="button" class="atp-resource-copy-all" data-copy-passwords="1">复制密码</button>';
        if (statusMessage) {
          html += getStatusRegionHtml('div', 'atp-resource-status', statusMessage);
        }
        if (showTextFallbackActions) {
          html += getTextParseButtonHtml(threadState, false);
          html += getTextImportButtonHtml(threadState, false);
        }
        html += getLiveRegionHtml('atp-resource-msg');
        setSidebarHtml(el, renderSignature, html);
        return;
      }
      html += '<div class="atp-resource-empty" role="status" aria-live="polite" aria-atomic="true">' + esc(emptyMessage) + '</div>';
      if (showTextFallbackActions) {
        html += getTextParseButtonHtml(threadState, false);
        html += getTextImportButtonHtml(threadState, false);
      }
      html += getLiveRegionHtml('atp-resource-msg');
      setSidebarHtml(el, renderSignature, html);
      return;
    }

    for (var i = 0; i < groups.length; i++) {
      html += '<div class="atp-resource-row" data-type="' + esc(groups[i].type) + '">';
      html += '<span class="atp-resource-kind">' + esc(groups[i].label) + '</span>';
      html += '<span class="atp-resource-count">共 ' + esc(groups[i].items.length) + ' 条' + (hasTxtSource(groups[i].items) ? ' · TXT' : '') + '</span>';
      html += '<button type="button" class="atp-resource-copy" data-copy-type="' + esc(groups[i].type) + '" aria-label="' + esc(getCopyLabel(groups[i])) + '">复制</button>';
      html += '</div>';
    }
    if (resources.passwords.length) {
      html += '<div class="atp-resource-passwords">附带密码 ' + esc(resources.passwords.length) + ' 个</div>';
    }
    if (statusMessage) {
      html += getStatusRegionHtml('div', 'atp-resource-status', statusMessage);
    }
    if (showTextFallbackActions) {
      html += getTextParseButtonHtml(threadState, false);
      html += getTextImportButtonHtml(threadState, false);
    }
    html += '<button type="button" class="atp-resource-copy-all" data-copy-all="1">复制所有链接</button>';
    html += getLiveRegionHtml('atp-resource-msg');
    setSidebarHtml(el, renderSignature, html);
  }

  function renderInline(panel, threadState) {
    var old = panel.querySelector('.atp-resource-inline');
    var inlineFocusKey = getFocusedResourceAction(old);
    var hasPendingAttachments = canParseTextResources(threadState);
    var showTextFallbackActions = shouldShowTextFallbackActions(threadState);
    var statusMessage = getTextResourceStatusMessage(threadState, false);
    if (!isEnabled() || (!hasResourcePayload(threadState.resources) && !hasPendingAttachments && !statusMessage)) {
      if (old) {
        clearMessageTimers(old);
        old.remove();
      }
      if (inlineFocusKey && !focusFirstInlineAction(panel)) releaseRemovedInlineFocus(panel);
      panel.__atpResourceInlineSignature = '';
      panel.__atpResourceInlineThread = null;
      return;
    }

    var resources = SharedUtils.normalizeResources(threadState.resources);
    var groups = getGroupsFromNormalized(resources);
    var renderSignature = getInlineRenderSignature(threadState, resources, groups, statusMessage, hasPendingAttachments, showTextFallbackActions);
    if (
      old &&
      panel.__atpResourceInlineThread === threadState &&
      panel.__atpResourceInlineSignature === renderSignature
    ) {
      return;
    }
    if (old) {
      clearMessageTimers(old);
      old.remove();
    }
    var box = document.createElement('div');
    box.className = 'atp-resource-inline';
    var html = '<span class="atp-resource-inline-title">资源</span>';
    html += getPinToggleHtml(threadState, '', 'data-pin-toggle');
    for (var i = 0; i < groups.length; i++) {
      html += '<button type="button" data-copy-type="' + esc(groups[i].type) + '" aria-label="' + esc(getCopyLabel(groups[i])) + '">' + esc(groups[i].label) + ' ' + esc(groups[i].items.length) + (hasTxtSource(groups[i].items) ? ' TXT' : '') + '</button>';
    }
    if (groups.length) {
      html += '<button type="button" data-copy-all="1">复制全部</button>';
    } else if (resources.passwords.length) {
      html += '<button type="button" data-copy-passwords="1">复制密码</button>';
    }
    if (showTextFallbackActions) {
      html += getTextParseButtonHtml(threadState, true);
      html += getTextImportButtonHtml(threadState, true);
    }
    html += statusMessage
      ? getStatusRegionHtml('span', 'atp-resource-inline-status', statusMessage)
      : getPlainStatusHtml('span', 'atp-resource-inline-status', '');
    html += '<span class="atp-resource-inline-msg" role="status" aria-live="polite" aria-atomic="true"></span>';
    box.innerHTML = html;
    panel.insertBefore(box, panel.firstChild.nextSibling);
    panel.__atpResourceInlineSignature = renderSignature;
    panel.__atpResourceInlineThread = threadState;
    box.addEventListener('click', function(e) {
      handleInlineClick(e, panel, threadState, box);
    });

    var pinToggle = box.querySelector('[data-pin-toggle]');
    if (pinToggle) updatePanelToggleState(panel, threadState);
    if (inlineFocusKey && !restoreResourceActionFocus(box, inlineFocusKey)) {
      focusFirstInlineAction(panel);
    }
  }

  function formatGroupFromNormalized(resources, type) {
    var items = resources.groups[type] || [];
    if (!items.length) return '';
    var lines = ['[' + SharedUtils.RESOURCE_GROUP_LABELS[type] + ']'];
    for (var i = 0; i < items.length; i++) {
      lines.push(items[i].url);
      if (items[i].code) lines.push('提取码: ' + items[i].code);
      if (items[i].altCodes && items[i].altCodes.length) lines.push('帖内另见提取码: ' + items[i].altCodes.join('、'));
      if (i < items.length - 1) lines.push('');
    }
    return lines.join('\n');
  }

  function formatPasswords(resources, force) {
    return formatPasswordsFromNormalized(SharedUtils.normalizeResources(resources), force);
  }

  function formatPasswordsFromNormalized(resources, force) {
    if ((!force && !shouldCopyPasswords()) || !resources.passwords.length) return '';
    var lines = ['[通用信息]', '解压密码:'];
    for (var i = 0; i < resources.passwords.length; i++) {
      var password = resources.passwords[i];
      if (!password || SharedUtils.isInvalidPasswordValue(password) || SharedUtils.isProtectedEmailPlaceholder(password)) continue;
      lines.push(password);
    }
    return lines.length > 2 ? lines.join('\n') : '';
  }

  function formatPasswordsOnly(resources) {
    return formatPasswords(resources, true);
  }

  function formatTypeText(resources, type) {
    resources = SharedUtils.normalizeResources(resources);
    var group = formatGroupFromNormalized(resources, type);
    var passwords = formatPasswordsFromNormalized(resources);
    if (group && passwords) return group + '\n\n' + passwords;
    return group || passwords;
  }

  function formatAllText(resources) {
    resources = SharedUtils.normalizeResources(resources);
    var parts = [];
    for (var i = 0; i < SharedUtils.RESOURCE_GROUP_ORDER.length; i++) {
      var type = SharedUtils.RESOURCE_GROUP_ORDER[i];
      var section = formatGroupFromNormalized(resources, type);
      if (section) parts.push(section);
    }
    var passwords = formatPasswordsFromNormalized(resources);
    if (passwords) parts.push(passwords);
    return parts.join('\n\n');
  }

  // The copy happens either way; a copy that could not be backed up says so.
  function copyAndRecord(threadState, text, sourceEl, scope) {
    return copyText(text, sourceEl).then(function(copied) {
      if (!copied) return false;
      return recordCopy(threadState, scope).then(function(result) {
        if (!result || !result.ok) {
          var why = result && result.error === 'invalid_thread' ? '无法识别本帖' : ((result && MARK_ERROR_TEXT[result.error]) || '请重试');
          showMessage('已复制，但未能备份：' + why, sourceEl, true);
        }
        return copied;
      });
    });
  }

  function copyType(type, sourceEl) {
    if (!currentThread) return;
    copyAndRecord(currentThread, formatTypeText(currentThread.resources, type), sourceEl, 'type:' + type);
  }

  function copyAllLinks(sourceEl) {
    if (!currentThread) return;
    copyAndRecord(currentThread, formatAllText(currentThread.resources), sourceEl, 'all');
  }

  function copyPasswordsOnly(sourceEl) {
    if (!currentThread) return;
    copyAndRecord(currentThread, formatPasswordsOnly(currentThread.resources), sourceEl, 'passwords');
  }

  function copyText(text, sourceEl) {
    if (!text) {
      showMessage('无可复制内容', sourceEl, true);
      return Promise.resolve(false);
    }
    return writeTextWithFallback(text)
      .then(function() {
        showMessage('已复制', sourceEl, false);
        return true;
      })
      .catch(function() {
        showMessage('复制失败', sourceEl, true);
        return false;
      });
  }

  function writeTextWithFallback(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        var p = navigator.clipboard.writeText(text);
        if (p && typeof p.then === 'function') {
          return p.catch(function() { return fallbackCopy(text); });
        }
      } catch (e) {}
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    return new Promise(function(resolve, reject) {
      var previousFocus = document.activeElement;
      var ta = null;
      function restoreFocus() {
        if (previousFocus && previousFocus !== ta && typeof previousFocus.focus === 'function') {
          try { previousFocus.focus(); } catch (e) {}
        }
      }
      try {
        ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        if (ta.parentNode) ta.remove();
        restoreFocus();
        if (ok) resolve();
        else reject(new Error('copy command returned false'));
      } catch (e) {
        if (ta && ta.parentNode) ta.remove();
        restoreFocus();
        reject(e);
      }
    });
  }

  function clearMessageTimer(el) {
    if (!el) return;
    if (el.__atpMessageAnnounceTimer) {
      clearTimeout(el.__atpMessageAnnounceTimer);
      el.__atpMessageAnnounceTimer = null;
    }
    if (el.__atpMessageTimer) {
      clearTimeout(el.__atpMessageTimer);
      el.__atpMessageTimer = null;
    }
  }

  function clearMessageTimers(root) {
    if (!root || !root.querySelectorAll) return;
    var messages = root.querySelectorAll('.atp-resource-msg, .atp-resource-inline-msg');
    for (var i = 0; i < messages.length; i++) {
      clearMessageTimer(messages[i]);
    }
  }

  function showMessage(text, sourceEl, isError) {
    var root = sourceEl || sidebar;
    var el = root ? root.querySelector('.atp-resource-msg, .atp-resource-inline-msg') : null;
    if (!el && sidebar) el = sidebar.querySelector('.atp-resource-msg');
    if (!el) return;
    el.className = el.className.replace(/\s*atp-resource-msg-error/g, '');
    el.setAttribute('role', isError ? 'alert' : 'status');
    el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    el.setAttribute('aria-atomic', 'true');
    if (isError) el.className += ' atp-resource-msg-error';
    clearMessageTimer(el);
    el.textContent = '';
    el.__atpMessageAnnounceTimer = setTimeout(function() {
      el.__atpMessageAnnounceTimer = null;
      el.textContent = text;
      el.__atpMessageTimer = setTimeout(function() {
        el.__atpMessageTimer = null;
        el.textContent = '';
      }, 1500);
    }, 0);
  }

  var ATPResourcePanel = {
    attachThread: function(panel, threadState) {
      if (!panel || !threadState) return;
      bindResourceLayoutListener();
      var previousThread = panel.__atpResourceThread;
      panel.__atpResourceThread = threadState;
      if (currentThread === previousThread) currentThread = threadState;
      if (pinnedThread === previousThread) pinnedThread = threadState;
      if (hoverThread === previousThread) hoverThread = threadState;
      panel.removeAttribute('aria-label');
      panel.removeAttribute('aria-controls');
      panel.removeAttribute('aria-expanded');
      if (panel.getAttribute('tabindex') === '0') panel.removeAttribute('tabindex');
      syncResourceTrigger(panel, threadState);
      syncMarkToggle(panel, threadState);
      scheduleMarkUpdate(threadState);
      renderInline(panel, threadState);
      if (!panel.__atpResourcePanelBound) {
        panel.__atpResourcePanelBound = true;
        panel.addEventListener('mouseenter', function() {
          showThreadResources(panel);
        });
        panel.addEventListener('mouseleave', function() {
          scheduleThreadResourceClear(panel);
        });
        panel.addEventListener('focusin', function() {
          showThreadResources(panel);
        });
        panel.addEventListener('focusout', function(e) {
          if (e.relatedTarget && panel.contains(e.relatedTarget)) return;
          if (e.relatedTarget && sidebar && sidebar.contains(e.relatedTarget)) return;
          scheduleThreadResourceClear(panel);
        });
      }
      // 用户正悬停/聚焦在侧栏上时不自动切换内容，防止复制按钮在点击瞬间指向另一个帖子
      if (!pinnedThread && !hoverThread && !sidebarHovering && !sidebarFocused && hasResourcePayload(threadState.resources)) renderThread(threadState);
    },

    updateThread: function(threadState) {
      if (!threadState) return;
      if (!isThreadAttached(threadState)) {
        var wasDisplayed = currentThread === threadState || pinnedThread === threadState || hoverThread === threadState;
        clearThreadRefs(threadState);
        if (wasDisplayed) renderThread(pinnedThread || hoverThread || null);
        return;
      }
      if (threadState.panel) {
        syncResourceTrigger(threadState.panel, threadState);
        syncMarkToggle(threadState.panel, threadState);
        renderInline(threadState.panel, threadState);
      }
      scheduleMarkUpdate(threadState);
      if (currentThread === threadState || pinnedThread === threadState || hoverThread === threadState) {
        renderThread(threadState);
      }
    },

    destroy: function() {
      updateThreadExpandedState(currentThread, false);
      updateThreadExpandedState(pinnedThread, false);
      updateThreadExpandedState(hoverThread, false);
      currentThread = null;
      pinnedThread = null;
      hoverThread = null;
      sidebarHovering = false;
      sidebarFocused = false;
      sidebarRenderSignature = '';
      clearHoverClearTimer();
      clearMessageTimers(sidebar);
      if (sidebar && sidebar.parentNode) sidebar.remove();
      sidebar = null;
      unbindResourceLayoutListener();
    }
  };
  if (window.__ATP_VERIFY_RESOURCE_PANEL__) {
    ATPResourcePanel._verifyRequestTextResourceManualLoad = requestTextResourceManualLoad;
    ATPResourcePanel._verifyShouldShowTextFallbackActions = shouldShowTextFallbackActions;
    ATPResourcePanel._verifyCopyText = copyText;
    ATPResourcePanel._verifyToggleThreadMark = toggleThreadMark;
    ATPResourcePanel._verifyReadMarkedIds = readMarkedIds;
    ATPResourcePanel._verifyIsThreadMarked = isThreadMarked;
    ATPResourcePanel._verifyCopyAndRecord = copyAndRecord;
    ATPResourcePanel._verifySetCurrentThread = function(threadState) { currentThread = threadState; };
  }

  window.ATPResourcePanel = ATPResourcePanel;
})();
