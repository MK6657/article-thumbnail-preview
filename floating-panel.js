class FloatingPanel {
  constructor(opts) {
    opts = opts || {};
    this.title = opts.title || '面板';
    this.schema = opts.settingsSchema || [];
    this.storage = opts.storage || this.defaultStorage();
    this.business = opts.business || {};
    this._confirmedSettings = this.getDefaults();
    this.settings = Object.assign({}, this._confirmedSettings);
    this._dragState = null;
    this._listeners = [];
    this._msgTimer = null;
    this._saveChain = Promise.resolve();
    this._saveStatusSeq = 0;
    this._saveSeqByKey = {};
    this._pendingSaveByKey = {};
    this._dirtyInputByKey = {};
    this._settingsLoadFailed = false;
    this._launcherTabIndexBeforeOpen = undefined;
    this._dragFrame = null;
    this._launcherDragFrame = null;
    this._flashTimers = [];
    this._destroyed = false;
    this._settingsEventsBound = false;
    this._consoleEventsBound = false;
    this._settingsReady = false;
    this._settingsRendered = false;
    this._consoleRendered = false;
    this._helpRendered = false;
    this._activeTab = 'console';
    this._launcherVisible = true;
    this._launcherPos = null;
    this._panelPos = null;
    this._suppressNextLauncherClick = false;
    this._statusPollTimer = null;
    this._lastPageStatus = null;
    this._createDOM();
    this._createLauncher();
    this._createPanel();
    this._createHelpView();
    this._setSettingsLoading(true);
    this._bindLauncher();
    this._bindKeyboard();
    this._bindDrag();
    this._bindLauncherDrag();
    this._bindOutsideClick();
    this._bindResize();
    this._loadPosition();
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'initialSettings')) {
      this.setSettings(opts.initialSettings);
      this._settingsReady = true;
      this._settingsLoadFailed = false;
      this._setSettingsLoading(false);
    } else {
      this._loadSettings().then(() => {
        if (this._destroyed) return;
        this._settingsReady = true;
        this._settingsLoadFailed = false;
        this._ensureSettingsRendered();
      }).catch((e) => {
        if (this._destroyed) return;
        console.warn('[FloatingPanel] settings load failed:', e);
        this._settingsReady = true;
        this._settingsLoadFailed = true;
        this._ensureSettingsRendered();
        this.showMessage('设置读取失败', 'err');
      });
    }
  }

  _esc(s) { return SharedUtils.escapeHtml(s); }

  _getSettingsApplyMode(keys) {
    if (typeof ATPGetSettingsApplyMode === 'function') {
      return ATPGetSettingsApplyMode(keys, this.schema);
    }
    let mode = 'live';
    for (const key of (keys || [])) {
      const item = this.schema.find((entry) => entry && entry.key === key);
      const itemMode = item && item.applyMode
        ? item.applyMode
        : (item && item.immediate === false ? 'hotReload' : 'live');
      if (itemMode === 'pageReload') return itemMode;
      if (itemMode === 'hotReload') mode = itemMode;
    }
    return mode;
  }

  _getApplyModeHelpText(item) {
    const mode = this._getSettingsApplyMode([item.key]);
    if (mode === 'pageReload') return '需刷新页面';
    if (mode === 'hotReload') return '自动重新加载缩略图';
    return '立即生效';
  }

  _addListener(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, options);
    this._listeners.push({ target, type, handler, options });
  }

  destroy() {
    this._destroyed = true;
    this._stopStatusPolling();
    if (this._msgTimer) {
      clearTimeout(this._msgTimer);
      this._msgTimer = null;
    }
    for (const timer of this._flashTimers) clearTimeout(timer);
    this._flashTimers = [];
    for (const l of this._listeners) {
      l.target.removeEventListener(l.type, l.handler, l.options);
    }
    this._listeners = [];
    if (this._dragFrame && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._dragFrame);
    }
    if (this._launcherDragFrame && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._launcherDragFrame);
    }
    this._dragFrame = null;
    this._launcherDragFrame = null;
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
  }

  defaultStorage() {
    return {
      getSettings: async () => {
        const r = await chrome.storage.local.get('settings');
        return r.settings || {};
      },
      setSettings: async (s) => {
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: SharedUtils.MESSAGE_TYPES.SAVE_SETTINGS_PATCH,
            settingsPatch: s || {},
          }, (result) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(result || {});
          });
        });
        if (!response.ok) throw new Error(response.error || 'settings save failed');
        return response.settings || null;
      },
      getPosition: async (hostname) => {
        const k = 'bfp_pos_' + hostname;
        const r = await chrome.storage.local.get(k);
        return r[k] || null;
      },
      setPosition: async (hostname, pos) => {
        await chrome.storage.local.set({ ['bfp_pos_' + hostname]: pos });
      },
    };
  }

  getDefaults() {
    const d = {};
    for (const item of this.schema) {
      d[item.key] = item.default;
    }
    return d;
  }

  async _loadSettings() {
    const rawSaved = await this.storage.getSettings();
    if (!this._destroyed) this.setSettings(rawSaved);
  }

  _isPanelOpen() {
    return !!(this._panel && !this._panel.classList.contains('bfp-hidden'));
  }

  _ensureSettingsRendered() {
    if (this._settingsRendered || !this._settingsViewEl) return;
    if (!this._settingsReady && !this._settingsLoadFailed) return;
    if (!this._isPanelOpen()) return;
    this._renderSettings();
  }

  _ensureConsoleRendered() {
    if (this._consoleRendered || !this._consoleViewEl) return;
    if (!this._isPanelOpen()) return;
    this._renderConsole();
  }

  _ensureHelpRendered() {
    if (this._helpRendered) return;
    this._renderHelp();
  }

  setLauncherVisible(visible) {
    const nextVisible = visible !== false;
    this._launcherVisible = nextVisible;
    if (!this._launcher) return;
    if (this._launcher.classList) {
      this._launcher.classList.toggle('bfp-launcher-hidden', !nextVisible);
    }
    if (!nextVisible) {
      if (this._launcher.setAttribute) this._launcher.setAttribute('aria-hidden', 'true');
      if (this._isPanelOpen()) this._closeWithoutFocusRestore();
    } else if (this._launcher.removeAttribute) {
      this._launcher.removeAttribute('aria-hidden');
    }
  }

  updatePageStatus(status) {
    if (this._destroyed) return;
    this._lastPageStatus = status && typeof status === 'object' ? Object.assign({}, status) : null;
    const info = this._normalizePageStatus(this._lastPageStatus);
    if (this._launcherDot && this._launcherDot.classList) {
      this._launcherDot.classList.remove('is-loading', 'is-warn', 'is-idle');
      this._launcherDot.classList.add('is-' + info.dotTone);
    }
    if (this._launcher && info.launcherTitle) {
      this._launcher.title = info.launcherTitle;
    }
    if (!this._consoleRendered || !this._consoleViewEl) return;
    this._renderConsoleStatusDOM(info);
  }

  _normalizePageStatus(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        dotTone: 'idle',
        headline: '就绪 · 缩略图预览运行中',
        subline: '滚动列表自动抓取图片与资源摘要',
        pacerText: '',
        paused: false,
        allExpanded: false,
        failedCount: 0,
        markedCount: 0,
        launcherTitle: this.title
      };
    }
    const activeImages = Math.max(0, Number(raw.activeImages ?? raw.loadingImages ?? raw.loading ?? 0) || 0);
    const articleFetching = Math.max(0, Number(raw.articleFetching ?? raw.fetchingArticles ?? 0) || 0);
    const loadingTotal = activeImages + articleFetching;
    const readyThreads = Math.max(0, Number(raw.readyThreads ?? raw.loadedThreads ?? raw.processedThreads ?? 0) || 0);
    const totalThreads = Math.max(0, Number(raw.totalThreads ?? raw.scannedThreads ?? readyThreads) || 0);
    const failedCount = Math.max(0, Number(raw.failedImages ?? raw.failedCount ?? 0) || 0);
    const markedCount = Math.max(0, Number(raw.markedCount ?? raw.marksCount ?? 0) || 0);
    const paused = !!raw.paused;
    const allExpanded = !!(raw.allExpanded ?? raw.expandedAll);
    const pacerPaused = !!(raw.forumPacerPaused || raw.pacerPaused);
    const pacerSlowed = !!(pacerPaused || raw.forumPacerSlowed || raw.pacerSlowed);
    const pacerText = typeof raw.forumPacerText === 'string'
      ? raw.forumPacerText
      : (pacerPaused ? '论坛节流等待恢复中' : (pacerSlowed ? '论坛自适应温和限速中' : ''));

    let dotTone = 'idle';
    if (paused || pacerPaused || pacerSlowed || raw.state === 'paused' || raw.state === 'waiting') {
      dotTone = 'warn';
    } else if (loadingTotal > 0 || raw.state === 'loading') {
      dotTone = 'loading';
    }

    let headline = '';
    if (typeof raw.statusText === 'string' && raw.statusText.trim()) {
      headline = raw.statusText.trim();
    } else if (paused) {
      headline = '已暂停加载 · 已就绪 ' + readyThreads + (totalThreads ? '/' + totalThreads : '') + ' 帖';
    } else if (loadingTotal > 0) {
      headline = '加载中 ' + loadingTotal + ' · 已就绪 ' + readyThreads + (totalThreads ? '/' + totalThreads : '') + ' 帖';
    } else if (totalThreads > 0 || readyThreads > 0) {
      headline = '已就绪 ' + readyThreads + (totalThreads ? '/' + totalThreads : '') + ' 帖 · 空闲待命';
    } else {
      headline = '就绪 · 等待扫描列表主题';
    }

    const details = [];
    if (activeImages > 0) details.push('图片并发 ' + activeImages);
    if (articleFetching > 0) details.push('正文抓取 ' + articleFetching);
    if (failedCount > 0) details.push('失败图 ' + failedCount);
    if (markedCount > 0) details.push('已标记 ' + markedCount + ' 帖');
    const subline = details.length ? details.join(' · ') : '当前页面加载平稳';

    return {
      dotTone,
      headline,
      subline,
      pacerText,
      paused,
      allExpanded,
      failedCount,
      markedCount,
      launcherTitle: this.title + ' — ' + headline
    };
  }

  _pollPageStatusOnce() {
    if (this._destroyed || !this.business || typeof this.business.getPageStatus !== 'function') return;
    try {
      const result = this.business.getPageStatus();
      if (result && typeof result.then === 'function') {
        result.then((resolved) => {
          if (!this._destroyed) this.updatePageStatus(resolved);
        }).catch(() => {});
      } else {
        this.updatePageStatus(result);
      }
    } catch (e) {}
  }

  _startStatusPolling() {
    this._stopStatusPolling();
    if (!this.business || typeof this.business.getPageStatus !== 'function') return;
    this._pollPageStatusOnce();
    if (typeof setInterval === 'function') {
      this._statusPollTimer = setInterval(() => {
        if (this._destroyed || !this._isPanelOpen()) {
          this._stopStatusPolling();
          return;
        }
        this._pollPageStatusOnce();
      }, 1000);
    }
  }

  _stopStatusPolling() {
    if (this._statusPollTimer && typeof clearInterval === 'function') {
      clearInterval(this._statusPollTimer);
    }
    this._statusPollTimer = null;
  }

  setSettings(rawSettings) {
    const saved = typeof ATPNormalizeSettings === 'function'
      ? ATPNormalizeSettings(rawSettings)
      : (rawSettings || {});
    this._settingsReady = true;
    this._settingsLoadFailed = false;
    this._confirmedSettings = {};
    for (const item of this.schema) {
      const incomingValue = saved[item.key] !== undefined ? saved[item.key] : item.default;
      this._confirmedSettings[item.key] = incomingValue;
      const pending = this._pendingSaveByKey && this._pendingSaveByKey[item.key];
      const field = this._settingsViewEl && this._settingsViewEl.querySelector('[data-key="' + item.key + '"]');
      if (pending && !this._isSameSettingValue(incomingValue, pending.value)) {
        continue;
      }
      if (this._isDirtyInputProtected(item.key, field)) {
        continue;
      }
      this.settings[item.key] = incomingValue;
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = !!this.settings[item.key];
      else field.value = this.settings[item.key];
      this._clearInputError(field);
    }
    if (Object.prototype.hasOwnProperty.call(saved, 'showFloatingLauncher') &&
        !(this._pendingSaveByKey && this._pendingSaveByKey.showFloatingLauncher)) {
      this.settings.showFloatingLauncher = saved.showFloatingLauncher !== false;
    }
    if (this.settings && Object.prototype.hasOwnProperty.call(this.settings, 'showFloatingLauncher')) {
      this.setLauncherVisible(this.settings.showFloatingLauncher !== false);
    }
    this._refreshDependentFields();
    this._syncConsoleControls();
  }

  showMessage(text, type) {
    if (this._destroyed) return;
    const el = this._msgEl;
    if (!el) return;
    if (this._msgTimer) {
      clearTimeout(this._msgTimer);
      this._msgTimer = null;
    }
    if (!text) {
      el.textContent = '';
      el.className = 'bfp-message bfp-msg-empty';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      return;
    }
    el.textContent = text;
    el.className = 'bfp-message bfp-msg-' + (type || 'ok');
    el.setAttribute('role', type === 'err' ? 'alert' : 'status');
    el.setAttribute('aria-live', type === 'err' ? 'assertive' : 'polite');
    if (type !== 'err') {
      this._msgTimer = setTimeout(() => this.showMessage(''), 2500);
    }
  }

  flashError(el) {
    if (!el || !el.classList) return;
    el.classList.add('bfp-input-err');
    const timer = setTimeout(() => {
      el.classList.remove('bfp-input-err');
      this._flashTimers = this._flashTimers.filter(t => t !== timer);
    }, 800);
    this._flashTimers.push(timer);
  }

  _clearInputError(el) {
    if (!el || typeof el.removeAttribute !== 'function') return;
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
    const error = el.id && this._shadow && this._shadow.getElementById && this._shadow.getElementById(el.id + '-error');
    if (error) error.textContent = '';
  }

  _reportNumberInputError(el, item) {
    if (!el || !item) return;
    el.setAttribute('aria-invalid', 'true');
    const errorId = 'bfp-field-' + item.key + '-error';
    el.setAttribute('aria-describedby', errorId);
    const error = this._shadow && this._shadow.getElementById ? this._shadow.getElementById(errorId) : null;
    if (error) error.textContent = ATPGetNumberSettingError(item);
    this.flashError(el);
  }

  _createDOM() {
    this._root = document.createElement('div');
    this._root.id = 'bfp-root';
    this._root.style.visibility = 'hidden';
    this._shadow = this._root.attachShadow({ mode: 'open' });
    this._cssReady = this._loadCSS();
    document.body.appendChild(this._root);
  }

  // The stylesheet is web-accessible only to the built-in forum sites, so it
  // is never exposed to arbitrary pages; on an approved mirror the worker
  // reads it and sends the text instead.
  _readCSS() {
    const onMirror = typeof SharedUtils !== 'undefined' && SharedUtils.getMirrorForumRoot &&
      !!SharedUtils.getMirrorForumRoot(location.hostname);
    if (!onMirror) {
      return fetch(chrome.runtime.getURL('floating-panel.css')).then((resp) => resp.text());
    }
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: SharedUtils.MESSAGE_TYPES.GET_FLOATING_PANEL_CSS }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError || !response || !response.ok || typeof response.css !== 'string') {
          reject(new Error(runtimeError ? runtimeError.message : 'floating panel CSS unavailable'));
          return;
        }
        resolve(response.css);
      });
    });
  }

  async _loadCSS() {
    try {
      const css = await this._readCSS();
      if (this._destroyed) return;
      const style = document.createElement('style');
      style.textContent = css;
      this._shadow.appendChild(style);
      if (this._root) this._root.style.visibility = '';
    } catch(e) {
      console.error('[FloatingPanel] CSS load failed:', e);
      if (this._root) this._root.style.display = 'none';
    }
  }

  _createLauncher() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bfp-launcher';
    btn.id = 'bfp-launcher';
    btn.title = this.title;
    btn.setAttribute('aria-label', this.title);
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'bfp-panel');
    btn.innerHTML = '<span class="bfp-launcher-icon" aria-hidden="true">&#x25EB;</span><span class="bfp-launcher-dot is-idle" id="bfp-launcher-dot"></span>';
    this._shadow.appendChild(btn);
    this._launcher = btn;
    this._launcherDot = btn.querySelector('#bfp-launcher-dot') || btn.querySelector('.bfp-launcher-dot');
  }

  _createPanel() {
    const panel = document.createElement('div');
    panel.className = 'bfp-panel bfp-hidden';
    panel.id = 'bfp-panel';
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', this.title);
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('aria-modal', 'false');

    panel.innerHTML = `
      <div class="bfp-header" id="bfp-header">
        <span class="bfp-header-title">${this._esc(this.title)}</span>
        <span style="flex:1"></span>
        <button class="bfp-header-btn bfp-header-btn-help" id="bfp-help-toggle" type="button" aria-label="打开参数说明" aria-expanded="false" aria-controls="bfp-help-panel">?</button>
        <button class="bfp-header-btn" id="bfp-close" type="button" aria-label="关闭设置面板">&#x2715;</button>
      </div>
      <div class="bfp-tabs" id="bfp-tabs" role="tablist" aria-label="悬浮面板视图">
        <button class="bfp-tab bfp-tab-active" id="bfp-tab-console" type="button" role="tab" data-tab="console" aria-selected="true" aria-controls="bfp-console-view">控制台</button>
        <button class="bfp-tab" id="bfp-tab-settings" type="button" role="tab" data-tab="settings" aria-selected="false" aria-controls="bfp-settings-view">详细设置</button>
      </div>
      <div class="bfp-body" id="bfp-body">
        <div class="bfp-view bfp-active" id="bfp-console-view" role="tabpanel" aria-labelledby="bfp-tab-console" data-view="console"></div>
        <div class="bfp-view" id="bfp-settings-view" role="tabpanel" aria-labelledby="bfp-tab-settings" data-view="settings"></div>
      </div>
      <div class="bfp-message bfp-msg-empty" id="bfp-msg" role="status" aria-live="polite" aria-atomic="true"></div>
    `;

    this._shadow.appendChild(panel);
    this._panel = panel;
    this._headerEl = panel.querySelector('#bfp-header');
    this._tabsEl = panel.querySelector('#bfp-tabs');
    this._bodyEl = panel.querySelector('#bfp-body');
    this._consoleViewEl = panel.querySelector('#bfp-console-view');
    this._settingsViewEl = panel.querySelector('#bfp-settings-view');
    this._msgEl = panel.querySelector('#bfp-msg');
    this._bindTabs();
  }

  _bindTabs() {
    if (!this._tabsEl) return;
    this._addListener(this._tabsEl, 'click', (e) => {
      const btn = e && e.target && e.target.closest ? e.target.closest('.bfp-tab') : null;
      if (!btn) return;
      e.stopPropagation();
      const tab = btn.getAttribute('data-tab');
      if (tab) this._switchTab(tab);
    });
  }

  _switchTab(tabName) {
    const nextTab = tabName === 'settings' ? 'settings' : 'console';
    this._activeTab = nextTab;
    if (this._tabsEl && this._tabsEl.querySelectorAll) {
      const buttons = this._tabsEl.querySelectorAll('.bfp-tab');
      for (const btn of buttons) {
        const active = btn.getAttribute('data-tab') === nextTab;
        btn.classList.toggle('bfp-tab-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    }
    if (this._consoleViewEl && this._consoleViewEl.classList) {
      this._consoleViewEl.classList.toggle('bfp-active', nextTab === 'console');
    }
    if (this._settingsViewEl && this._settingsViewEl.classList) {
      this._settingsViewEl.classList.toggle('bfp-active', nextTab === 'settings');
    }
    if (nextTab === 'settings') {
      this._ensureSettingsRendered();
    } else {
      this._ensureConsoleRendered();
      this._syncConsoleControls();
    }
  }

  _createHelpView() {
    const el = document.createElement('div');
    el.className = 'bfp-help-panel bfp-hidden';
    el.id = 'bfp-help-panel';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-labelledby', 'bfp-help-title');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="bfp-help-header" id="bfp-help-header">
        <span id="bfp-help-title">参数说明</span>
        <button class="bfp-header-btn" id="bfp-help-close" type="button" aria-label="关闭参数说明">&#x2715;</button>
      </div>
      <div class="bfp-help-body" id="bfp-help-body" tabindex="0" aria-label="参数说明内容"></div>
    `;
    this._panel.appendChild(el);
    this._helpPanel = el;
    this._helpBodyEl = el.querySelector('#bfp-help-body');
    const closeBtn = el.querySelector('#bfp-help-close');
    if (closeBtn) {
      this._addListener(closeBtn, 'click', (e) => {
        e.stopPropagation();
        this._hideHelp(true);
      });
    }
  }

  _setSettingsLoading(loading) {
    if (!this._settingsViewEl) return;
    this._settingsViewEl.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (loading) {
      this._settingsViewEl.innerHTML = '<div class="bfp-loading" role="status" aria-live="polite">正在读取设置...</div>';
    }
  }

  _renderConsole() {
    if (!this._consoleViewEl) return;
    this._consoleRendered = true;
    const statusInfo = this._normalizePageStatus(this._lastPageStatus);
    const activePreset = this._detectActiveOrdinaryPreset();
    const disabled = this._settingsLoadFailed ? ' disabled' : '';
    const hasPause = !!(this.business && typeof this.business.onTogglePause === 'function');
    const hasRetry = !!(this.business && typeof this.business.onRetryFailed === 'function');
    const hasExpand = !!(this.business && typeof this.business.onToggleExpandAll === 'function');
    const hasCopy = !!(this.business && typeof this.business.onCopyMarked === 'function');
    const gridCols = this.settings && this.settings.gridCols !== undefined ? this.settings.gridCols : 5;
    const visibleRows = this.settings && this.settings.visibleRows !== undefined ? this.settings.visibleRows : 2;
    const showRes = !!(this.settings && this.settings.showResourcePanel !== false);

    this._consoleViewEl.innerHTML =
      '<div class="bfp-card bfp-status-card">' +
        '<div class="bfp-status-main">' +
          '<span class="bfp-status-dot is-' + this._esc(statusInfo.dotTone) + '" id="bfp-console-dot"></span>' +
          '<span class="bfp-status-headline" id="bfp-console-headline">' + this._esc(statusInfo.headline) + '</span>' +
        '</div>' +
        '<div class="bfp-status-sub" id="bfp-console-subline">' + this._esc(statusInfo.subline) + '</div>' +
        '<div class="bfp-status-pace' + (statusInfo.pacerText ? '' : ' bfp-hidden-inline') + '" id="bfp-console-pace">' + this._esc(statusInfo.pacerText) + '</div>' +
      '</div>' +
      '<div class="bfp-card">' +
        '<div class="bfp-card-label">速度模式</div>' +
        '<div class="bfp-speed-pills" role="group" aria-label="加载速度模式">' +
          '<button class="bfp-ordinary-preset bfp-speed-pill' + (activePreset === 'ordinaryGentle' ? ' is-active' : '') + '" type="button" data-preset="ordinaryGentle" aria-pressed="' + (activePreset === 'ordinaryGentle' ? 'true' : 'false') + '" title="省流温和：可见 6 · 后台 1 · 同域 6">温和</button>' +
          '<button class="bfp-ordinary-preset bfp-speed-pill' + (activePreset === 'ordinaryBalanced' ? ' is-active' : '') + '" type="button" data-preset="ordinaryBalanced" aria-pressed="' + (activePreset === 'ordinaryBalanced' ? 'true' : 'false') + '" title="均衡丝滑（推荐）：可见 8 · 后台 2 · 同域 8">均衡</button>' +
          '<button class="bfp-ordinary-preset bfp-speed-pill' + (activePreset === 'ordinaryFast' ? ' is-active' : '') + '" type="button" data-preset="ordinaryFast" aria-pressed="' + (activePreset === 'ordinaryFast' ? 'true' : 'false') + '" title="极速宽带：可见 16 · 后台 2 · 同域 10">极速</button>' +
        '</div>' +
      '</div>' +
      '<div class="bfp-action-grid" role="group" aria-label="页面快捷操作">' +
        '<button class="bfp-action-btn" type="button" data-quick-action="togglePause"' + (hasPause ? '' : ' aria-disabled="true"') + '><span class="bfp-action-label" id="bfp-act-pause">' + (statusInfo.paused ? '▶ 继续加载' : '⏸ 暂停加载') + '</span></button>' +
        '<button class="bfp-action-btn" type="button" data-quick-action="retryFailed"' + (hasRetry ? '' : ' aria-disabled="true"') + '><span class="bfp-action-label" id="bfp-act-retry">' + (statusInfo.failedCount > 0 ? '↻ 重试失败 (' + statusInfo.failedCount + ')' : '↻ 重试失败图') + '</span></button>' +
        '<button class="bfp-action-btn" type="button" data-quick-action="toggleExpandAll"' + (hasExpand ? '' : ' aria-disabled="true"') + '><span class="bfp-action-label" id="bfp-act-expand">' + (statusInfo.allExpanded ? '⤡ 收起多图' : '⤢ 展开全部多图') + '</span></button>' +
        '<button class="bfp-action-btn" type="button" data-quick-action="copyMarked"' + (hasCopy ? '' : ' aria-disabled="true"') + '><span class="bfp-action-label" id="bfp-act-copy">' + (statusInfo.markedCount > 0 ? '📋 复制已标记 (' + statusInfo.markedCount + ')' : '📋 复制已标记') + '</span></button>' +
      '</div>' +
      '<div class="bfp-card bfp-quick-card">' +
        '<div class="bfp-row"><label class="bfp-row-label" for="bfp-quick-gridCols">每行列数 <span class="bfp-row-hint">1–32</span></label><span class="bfp-row-input-wrap"><input id="bfp-quick-gridCols" type="number" data-quick-key="gridCols" value="' + this._esc(gridCols) + '" min="1" max="32" step="1"' + disabled + '></span></div>' +
        '<div class="bfp-row"><label class="bfp-row-label" for="bfp-quick-visibleRows">可见行数 <span class="bfp-row-hint">1–20</span></label><span class="bfp-row-input-wrap"><input id="bfp-quick-visibleRows" type="number" data-quick-key="visibleRows" value="' + this._esc(visibleRows) + '" min="1" max="20" step="1"' + disabled + '></span></div>' +
        '<div class="bfp-check-row"><label><input type="checkbox" data-quick-key="showResourcePanel"' + (showRes ? ' checked' : '') + disabled + '> 显示右侧资源栏</label></div>' +
      '</div>';

    this._bindConsoleEvents();
  }

  _renderConsoleStatusDOM(info) {
    if (!this._consoleViewEl) return;
    const dot = this._consoleViewEl.querySelector('#bfp-console-dot');
    const headline = this._consoleViewEl.querySelector('#bfp-console-headline');
    const subline = this._consoleViewEl.querySelector('#bfp-console-subline');
    const pace = this._consoleViewEl.querySelector('#bfp-console-pace');
    const actPause = this._consoleViewEl.querySelector('#bfp-act-pause');
    const actRetry = this._consoleViewEl.querySelector('#bfp-act-retry');
    const actExpand = this._consoleViewEl.querySelector('#bfp-act-expand');
    const actCopy = this._consoleViewEl.querySelector('#bfp-act-copy');
    if (dot && dot.classList) {
      dot.classList.remove('is-loading', 'is-warn', 'is-idle');
      dot.classList.add('is-' + info.dotTone);
    }
    if (headline) headline.textContent = info.headline;
    if (subline) subline.textContent = info.subline;
    if (pace) {
      pace.textContent = info.pacerText || '';
      if (pace.classList) pace.classList.toggle('bfp-hidden-inline', !info.pacerText);
    }
    if (actPause) actPause.textContent = info.paused ? '▶ 继续加载' : '⏸ 暂停加载';
    if (actRetry) actRetry.textContent = info.failedCount > 0 ? '↻ 重试失败 (' + info.failedCount + ')' : '↻ 重试失败图';
    if (actExpand) actExpand.textContent = info.allExpanded ? '⤡ 收起多图' : '⤢ 展开全部多图';
    if (actCopy) actCopy.textContent = info.markedCount > 0 ? '📋 复制已标记 (' + info.markedCount + ')' : '📋 复制已标记';
  }

  _bindConsoleEvents() {
    if (!this._consoleViewEl || this._consoleEventsBound) return;
    this._consoleEventsBound = true;
    this._addListener(this._consoleViewEl, 'click', (e) => {
      if (!e || e.isTrusted !== true) return;
      const presetBtn = e.target && e.target.closest ? e.target.closest('.bfp-ordinary-preset') : null;
      if (presetBtn && this._consoleViewEl.contains(presetBtn)) {
        e.stopPropagation();
        this._onOrdinaryPreset(presetBtn);
        return;
      }
      const actionBtn = e.target && e.target.closest ? e.target.closest('[data-quick-action]') : null;
      if (actionBtn && this._consoleViewEl.contains(actionBtn)) {
        e.stopPropagation();
        this._onQuickAction(actionBtn);
      }
    });
    this._addListener(this._consoleViewEl, 'change', (e) => {
      if (!e || e.isTrusted !== true) return;
      const target = e.target;
      if (!target || !target.dataset || !target.dataset.quickKey) return;
      this._onQuickSettingChange(target);
    });
  }

  async _onQuickAction(btn) {
    if (!btn || btn.__bfpBusy) return;
    const action = btn.getAttribute('data-quick-action');
    const handlerMap = {
      togglePause: this.business && this.business.onTogglePause,
      retryFailed: this.business && this.business.onRetryFailed,
      toggleExpandAll: this.business && this.business.onToggleExpandAll,
      copyMarked: this.business && this.business.onCopyMarked,
    };
    const fn = handlerMap[action];
    if (typeof fn !== 'function') {
      this.showMessage('当前页面暂未启用该快捷操作', 'warn');
      return;
    }
    this._setButtonBusy(btn, true);
    try {
      const result = await fn();
      if (result && typeof result === 'object') {
        if (result.status) this.updatePageStatus(result.status);
        else this._pollPageStatusOnce();
        if (result.message) {
          this.showMessage(result.message, result.type || 'ok');
        }
      } else {
        this._pollPageStatusOnce();
        if (typeof result === 'string' && result) {
          this.showMessage(result, 'ok');
        }
      }
    } catch (err) {
      console.warn('[FloatingPanel] quick action failed:', err);
      this.showMessage((err && err.message) || '快捷操作执行失败', 'err');
    } finally {
      this._setButtonBusy(btn, false);
    }
  }

  async _onQuickSettingChange(el) {
    const key = el && el.dataset && el.dataset.quickKey;
    if (!key) return;
    const schema = this.schema.find(s => s.key === key);
    if (!schema || !this._isFieldEnabled(schema)) return;
    let val;
    if (el.type === 'checkbox') {
      val = el.checked;
    } else {
      val = ATPReadNumberSetting(el.value, schema);
      if (val === null) {
        this.flashError(el);
        this.showMessage(ATPGetNumberSettingError(schema), 'err');
        el.value = this.settings[key];
        return;
      }
    }
    this.settings[key] = val;
    const detailField = this._settingsViewEl && this._settingsViewEl.querySelector('[data-key="' + key + '"]');
    if (detailField) {
      if (detailField.type === 'checkbox') detailField.checked = !!val;
      else detailField.value = val;
      this._clearInputError(detailField);
    }
    this._refreshDependentFields();
    this._syncConsoleControls();
    const attempt = this._markSaveAttempt(key, val);
    const saved = await this._saveSettings(null, key, [key]);
    if (!saved && this._rollbackSaveAttempt(attempt, detailField)) {
      this._refreshDependentFields();
      this._syncConsoleControls();
      this.flashError(el);
    }
  }

  _detectActiveOrdinaryPreset() {
    if (typeof ATPDetectActiveOrdinaryPreset === 'function') {
      return ATPDetectActiveOrdinaryPreset(this.settings, this.schema);
    }
    return null;
  }

  _syncPresetButtonsInRoot(root) {
    if (!root || !root.querySelectorAll) return;
    if (typeof ATPSettingsUI !== 'undefined' && ATPSettingsUI && typeof ATPSettingsUI.syncPresetButtons === 'function') {
      ATPSettingsUI.syncPresetButtons(root, this.settings, this.schema);
      return;
    }
    const active = this._detectActiveOrdinaryPreset();
    const buttons = root.querySelectorAll('.bfp-ordinary-preset');
    for (const btn of buttons) {
      const key = btn.getAttribute('data-preset');
      const pressed = active === key;
      btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      if (btn.classList) btn.classList.toggle('is-active', pressed);
    }
  }

  _syncConsoleControls() {
    if (this._settingsViewEl) this._syncPresetButtonsInRoot(this._settingsViewEl);
    if (!this._consoleRendered || !this._consoleViewEl) return;
    this._syncPresetButtonsInRoot(this._consoleViewEl);
    const quickKeys = ['gridCols', 'visibleRows', 'showResourcePanel'];
    for (const key of quickKeys) {
      const input = this._consoleViewEl.querySelector('[data-quick-key="' + key + '"]');
      if (!input) continue;
      input.disabled = !!this._settingsLoadFailed;
      if (this._getFloatingActiveElement() === input) continue;
      if (input.type === 'checkbox') input.checked = !!this.settings[key];
      else if (this.settings[key] !== undefined) input.value = this.settings[key];
    }
  }

  _renderSettings() {
    if (!this._settingsViewEl) return;
    this._settingsRendered = true;
    this._setSettingsLoading(false);
    let html = '';
    if (typeof ATPSettingsUI !== 'undefined' && ATPSettingsUI && typeof ATPSettingsUI.renderSettingsGroups === 'function') {
      html = ATPSettingsUI.renderSettingsGroups(this.schema, this.settings, {
        variant: 'floating',
        loadFailed: this._settingsLoadFailed
      });
    } else {
      for (const [groupName, items] of ATPGetSettingsViewGroups(this.schema)) {
        const groupMeta = typeof ATPGetSettingsGroupMeta === 'function' ? ATPGetSettingsGroupMeta(groupName) : {};
        const collapsible = !!groupMeta.collapsible;
        html += collapsible
          ? '<details class="bfp-section bfp-section-collapsible"' + (groupMeta.collapsed === false ? ' open' : '') + '><summary class="bfp-section-title bfp-section-summary">' + this._esc(groupName) + '</summary><div class="bfp-section-body">'
          : '<div class="bfp-section"><div class="bfp-section-title">' + this._esc(groupName) + '</div>';
        if (groupName === '加载') html += this._renderOrdinaryPresetRow();
        for (const item of items) {
          html += this._renderField(item);
        }
        html += collapsible ? '</div></details>' : '</div>';
      }
    }
    this._settingsViewEl.innerHTML = html;
    this._bindSettingsEvents();
    this._refreshDependentFields();
  }

  _isFieldEnabled(item) {
    if (this._settingsLoadFailed) return false;
    if (!item || !item.enabledWhen) return true;
    return this.settings && this.settings[item.enabledWhen.key] === item.enabledWhen.value;
  }

  _disabledAttr(item) {
    return this._isFieldEnabled(item) ? '' : ' disabled';
  }

  _getHeavyOriginalPreset() {
    return ATPGetSettingsPreset('heavyOriginal', this.schema);
  }

  _renderOrdinaryPresetRow() {
    const active = this._detectActiveOrdinaryPreset();
    return '<div class="bfp-preset-row"><span class="bfp-preset-label">加载速度预设</span><span class="bfp-preset-actions">' +
      '<button class="bfp-ordinary-preset' + (active === 'ordinaryGentle' ? ' is-active' : '') + '" type="button" data-preset="ordinaryGentle" aria-pressed="' + (active === 'ordinaryGentle' ? 'true' : 'false') + '" title="省流温和：可见 6 / 后台 1 / 同域 6">温和</button>' +
      '<button class="bfp-ordinary-preset' + (active === 'ordinaryBalanced' ? ' is-active' : '') + '" type="button" data-preset="ordinaryBalanced" aria-pressed="' + (active === 'ordinaryBalanced' ? 'true' : 'false') + '" title="均衡丝滑（推荐）：可见 8 / 后台 2 / 同域 8">均衡·推荐</button>' +
      '<button class="bfp-ordinary-preset' + (active === 'ordinaryFast' ? ' is-active' : '') + '" type="button" data-preset="ordinaryFast" aria-pressed="' + (active === 'ordinaryFast' ? 'true' : 'false') + '" title="极速宽带：可见 16 / 后台 2 / 同域 10">极速</button>' +
      '</span></div>';
  }

  _renderField(item) {
    const disabled = this._disabledAttr(item);
    if (item.type === 'boolean') {
      const checked = this.settings[item.key] ? 'checked' : '';
      const preset = item.key === 'heavyImageOptimization'
        ? '<button class="bfp-heavy-preset" type="button" title="恢复重图原始预设">恢复原始预设</button>'
        : '';
      const actionClass = preset ? ' bfp-check-row-action' : '';
      return `<div class="bfp-check-row${actionClass}"><label><input type="checkbox" data-key="${this._esc(item.key)}" ${checked}${disabled}> ${this._esc(item.label)}</label>${preset}</div>`;
    }
    if (item.type === 'select') {
      const fieldId = 'bfp-field-' + this._esc(item.key);
      const opts = (item.options || []).map(o =>
        '<option value="' + this._esc(o.value) + '"' + (this.settings[item.key] === o.value ? ' selected' : '') + '>' + this._esc(o.label) + '</option>'
      ).join('');
      return '<div class="bfp-row"><label class="bfp-row-label" for="' + fieldId + '">' + this._esc(item.label) + '</label><select id="' + fieldId + '" data-key="' + this._esc(item.key) + '"' + disabled + '>' + opts + '</select></div>';
    }
    const fieldId = 'bfp-field-' + this._esc(item.key);
    const isDef = this.settings[item.key] === item.default;
    const hint = (item.min !== undefined && item.max !== undefined) ? ' <span class="bfp-row-hint">' + this._esc(item.min) + '-' + this._esc(item.max) + '</span>' : '';
    return '<div class="bfp-row"><label class="bfp-row-label" for="' + fieldId + '">' + this._esc(item.label) + hint + '</label><span class="bfp-row-input-wrap"><input id="' + fieldId + '" type="number" data-key="' + this._esc(item.key) + '" value="' + this._esc(this.settings[item.key]) + '" min="' + (item.min !== undefined ? this._esc(item.min) : '') + '" max="' + (item.max !== undefined ? this._esc(item.max) : '') + '" step="' + this._esc(item.step || 1) + '"' + disabled + '><button class="bfp-reset' + (isDef ? ' is-default' : ' is-modified') + '" type="button" data-key="' + this._esc(item.key) + '" title="恢复默认" aria-label="恢复' + this._esc(item.label) + '默认值"' + disabled + '>&#x21BA;</button></span>' +
      '<span id="' + fieldId + '-error" class="bfp-number-error" role="alert"></span></div>';
  }

  _refreshDependentFields() {
    if (!this._settingsViewEl) return;
    for (const item of this.schema) {
      const enabled = this._isFieldEnabled(item);
      const field = this._settingsViewEl.querySelector('[data-key="' + item.key + '"]');
      if (field) {
        field.disabled = !enabled;
        if (!enabled) {
          this._clearInputDirty(item.key);
          this._clearInputError(field);
        }
      }
      const reset = this._settingsViewEl.querySelector('.bfp-reset[data-key="' + item.key + '"]');
      if (reset) {
        reset.disabled = !enabled;
        if (reset.classList && this.settings) {
          const atDefault = this.settings[item.key] === item.default;
          reset.classList.toggle('is-default', atDefault);
          reset.classList.toggle('is-modified', !atDefault);
        }
      }
    }
    const preset = this._settingsViewEl.querySelector('.bfp-heavy-preset');
    if (preset) preset.disabled = !this.settings.heavyImageOptimization;
    this._syncPresetButtonsInRoot(this._settingsViewEl);
  }

  _setButtonBusy(el, busy) {
    if (!el) return;
    el.__bfpBusy = !!busy;
    if (busy) {
      el.setAttribute('aria-disabled', 'true');
    } else {
      el.removeAttribute('aria-disabled');
    }
  }

  _renderHelp() {
    this._helpRendered = true;
    let html = '';
    if (typeof ATPSettingsUI !== 'undefined' && ATPSettingsUI && typeof ATPSettingsUI.buildHelpHtml === 'function') {
      html = ATPSettingsUI.buildHelpHtml(this.schema, { variant: 'floating' });
    } else {
      const groups = {};
      for (const item of this.schema) {
        if (!groups[item.group]) groups[item.group] = [];
        groups[item.group].push(item);
      }
      for (const [groupName, items] of Object.entries(groups)) {
        html += '<div class="bfp-help-section"><div class="bfp-help-section-title">' + this._esc(groupName) + '</div>';
        for (const item of items) {
          html += '<div class="bfp-help-item"><b>' + this._esc(item.label) + '</b> — ' + this._esc(item.description);
          if (item.recommend) html += '<br>推荐：' + this._esc(item.recommend);
          if (item.lowImpact) html += '<br>过低：' + this._esc(item.lowImpact);
          if (item.highImpact) html += '<br>过高：' + this._esc(item.highImpact);
          if (item.unit) html += '<br>单位：' + this._esc(item.unit);
          if (item.immediate !== undefined || item.applyMode) html += '<br>保存后' + this._getApplyModeHelpText(item);
          html += '</div>';
        }
        html += '</div>';
      }
    }
    if (this._helpBodyEl) this._helpBodyEl.innerHTML = html;
  }

  _bindSettingsEvents() {
    if (!this._settingsViewEl || this._settingsEventsBound) return;
    this._settingsEventsBound = true;
    this._addListener(this._settingsViewEl, 'change', (e) => {
      if (!e || e.isTrusted !== true) return;
      const target = e && e.target;
      if (!target || !target.matches) return;
      if (!target.matches('input[type="number"], select, input[type="checkbox"]')) return;
      this._onFieldChange(target);
    });
    this._addListener(this._settingsViewEl, 'input', (e) => {
      if (!e || e.isTrusted !== true) return;
      const target = e && e.target;
      if (!target || !target.matches || !target.matches('input[type="number"], select')) return;
      this._markInputDirty(target);
    });
    this._addListener(this._settingsViewEl, 'focusout', (e) => {
      const target = e && e.target;
      if (!target || !target.matches || !target.matches('input[type="number"], select')) return;
      this._clearInputDirty(target.dataset && target.dataset.key);
    });
    this._addListener(this._settingsViewEl, 'click', (e) => {
      if (!e || e.isTrusted !== true) return;
      const target = e && e.target && e.target.closest
        ? e.target.closest('.bfp-reset, .bfp-heavy-preset, .bfp-ordinary-preset')
        : null;
      if (!target || !this._settingsViewEl.contains(target)) return;
      e.stopPropagation();
      if (target.classList.contains('bfp-reset')) {
        this._onReset(target);
      } else if (target.classList.contains('bfp-ordinary-preset')) {
        this._onOrdinaryPreset(target);
      } else {
        this._onHeavyPreset(target);
      }
    });
  }

  async _onFieldChange(el) {
    const key = el.dataset.key;
    if (!key) return;
    const schema = this.schema.find(s => s.key === key);
    if (!schema) return;
    if (!this._isFieldEnabled(schema)) return;

    let val;
    if (el.type === 'checkbox') {
      val = el.checked;
    } else if (el.tagName === 'SELECT') {
      val = el.value;
    } else {
      val = ATPReadNumberSetting(el.value, schema);
      if (val === null) {
        this._reportNumberInputError(el, schema);
        return;
      }
      this._clearInputError(el);
    }

    this._clearInputDirty(key);
    this.settings[key] = val;
    if (key === 'showFloatingLauncher') {
      this.setLauncherVisible(val !== false);
    }
    this._refreshDependentFields();
    this._syncConsoleControls();
    const attempt = this._markSaveAttempt(key, val);
    const saved = await this._saveSettings(null, key, [key]);
    if (!saved && this._rollbackSaveAttempt(attempt, el)) {
      if (key === 'showFloatingLauncher') {
        this.setLauncherVisible(this.settings.showFloatingLauncher !== false);
      }
      this._refreshDependentFields();
      this._syncConsoleControls();
      this.flashError(el);
    }
  }

  async _onReset(el) {
    const key = el.dataset.key;
    if (!key) return;
    const schema = this.schema.find(s => s.key === key);
    if (!schema) return;
    if (!this._isFieldEnabled(schema)) return;
    this.settings[key] = schema.default;
    const input = this._settingsViewEl.querySelector('[data-key="' + key + '"]');
    if (input) {
      if (input.type === 'checkbox') input.checked = schema.default;
      else input.value = schema.default;
      this._clearInputDirty(key);
      this._clearInputError(input);
    }
    this._refreshDependentFields();
    this._syncConsoleControls();
    const attempt = this._markSaveAttempt(key, schema.default);
    const saved = await this._saveSettings('已恢复 ' + schema.label + ' 的默认值', key, [key]);
    if (!saved && this._rollbackSaveAttempt(attempt, input)) {
      if (input) this.flashError(input);
      this._refreshDependentFields();
      this._syncConsoleControls();
    }
  }

  async _onHeavyPreset(el) {
    if (!this.settings.heavyImageOptimization) {
      this.flashError(el);
      return;
    }
    return this._applySettingsPreset(el, this._getHeavyOriginalPreset(), '已恢复重图原始预设', 'heavyImageConcurrency');
  }

  async _onOrdinaryPreset(el) {
    const presetName = el && el.dataset && el.dataset.preset;
    const messages = {
      ordinaryGentle: '已切换至「省流温和」模式',
      ordinaryBalanced: '已切换至「均衡丝滑」推荐模式',
      ordinaryFast: '已切换至「极速宽带」模式'
    };
    const preset = ATPGetSettingsPreset(presetName, this.schema);
    return this._applySettingsPreset(el, preset, messages[presetName] || '已应用加载预设', 'firstScreenConcurrency');
  }

  async _applySettingsPreset(el, preset, message, changedKey) {
    if (!el || el.__bfpBusy) return;
    const presetKeys = this.schema.map(item => item.key).filter(key => Object.prototype.hasOwnProperty.call(preset, key));
    if (!presetKeys.length) {
      this.flashError(el);
      return;
    }
    presetKeys.forEach((key) => {
      this.settings[key] = preset[key];
      const input = this._settingsViewEl && this._settingsViewEl.querySelector('[data-key="' + key + '"]');
      if (input) {
        if (input.type === 'checkbox') input.checked = preset[key];
        else input.value = preset[key];
        this._clearInputDirty(key);
        this._clearInputError(input);
      }
    });
    this._refreshDependentFields();
    this._syncConsoleControls();
    this._setButtonBusy(el, true);
    const attempts = this._markSaveAttempts(presetKeys);
    try {
      const saved = await this._saveSettings(message, changedKey, presetKeys);
      if (!saved) {
        let reverted = false;
        for (const key of presetKeys) {
          const input = this._settingsViewEl && this._settingsViewEl.querySelector('[data-key="' + key + '"]');
          if (this._rollbackSaveAttempt(attempts[key], input)) reverted = true;
        }
        if (reverted) this.flashError(el);
      }
      this._refreshDependentFields();
      this._syncConsoleControls();
    } finally {
      this._setButtonBusy(el, false);
    }
  }

  _markSaveAttempt(key, value) {
    this._saveSeqByKey[key] = (this._saveSeqByKey[key] || 0) + 1;
    this._pendingSaveByKey[key] = { seq: this._saveSeqByKey[key], value };
    return { key, value, seq: this._saveSeqByKey[key] };
  }

  _markSaveAttempts(keys) {
    const attempts = {};
    for (const key of keys) {
      attempts[key] = this._markSaveAttempt(key, this.settings[key]);
    }
    return attempts;
  }

  _markInputDirty(el) {
    if (!el || !el.dataset || !el.dataset.key) return;
    this._dirtyInputByKey[el.dataset.key] = true;
  }

  _clearInputDirty(key) {
    if (!key || !this._dirtyInputByKey) return;
    delete this._dirtyInputByKey[key];
  }

  _isDirtyInputProtected(key, field) {
    return !!(key && field && this._dirtyInputByKey && this._dirtyInputByKey[key] && this._getFloatingActiveElement() === field);
  }

  _isSaveAttemptCurrent(attempt) {
    return !!attempt &&
      this._saveSeqByKey[attempt.key] === attempt.seq &&
      this.settings[attempt.key] === attempt.value;
  }

  _isSameSettingValue(a, b) {
    return a === b;
  }

  _clearPendingSaveAttempt(attempt) {
    if (!attempt || !this._pendingSaveByKey) return;
    const pending = this._pendingSaveByKey[attempt.key];
    if (pending && pending.seq === attempt.seq && this._isSameSettingValue(pending.value, attempt.value)) {
      delete this._pendingSaveByKey[attempt.key];
    }
  }

  _clearPendingSaveAttempts(attempts) {
    for (const key in attempts) {
      if (Object.prototype.hasOwnProperty.call(attempts, key)) {
        this._clearPendingSaveAttempt(attempts[key]);
      }
    }
  }

  _getPendingSaveAttempts(keys) {
    const attempts = {};
    if (!this._pendingSaveByKey) return attempts;
    for (const key of keys) {
      const pending = this._pendingSaveByKey[key];
      if (pending) attempts[key] = { key, value: pending.value, seq: pending.seq };
    }
    return attempts;
  }

  _rollbackSaveAttempt(attempt, input) {
    if (!this._isSaveAttemptCurrent(attempt)) return false;
    this._clearPendingSaveAttempt(attempt);
    const key = attempt.key;
    const confirmed = this._confirmedSettings[key];
    this.settings[key] = confirmed;
    if (input && !this._isDirtyInputProtected(key, input)) {
      if (input.type === 'checkbox') input.checked = confirmed;
      else input.value = confirmed;
      this._clearInputDirty(key);
      this._clearInputError(input);
    }
    return true;
  }

  async _saveSettings(msg, changedKey, changedKeys) {
    if (this._settingsLoadFailed) {
      this.showMessage('设置读取失败，请重新打开面板后再试', 'err');
      return false;
    }
    const saveSeq = ++this._saveStatusSeq;
    const patchKeys = Array.isArray(changedKeys) ? changedKeys : (changedKey ? [changedKey] : []);
    const snapshot = this._cloneSettingsForSave(this.settings, patchKeys);
    const pendingAttempts = this._getPendingSaveAttempts(patchKeys);
    this.showMessage('保存中...', 'warn');
    try {
      const savedSettings = await this._queueSettingsSave(snapshot);
      this._clearPendingSaveAttempts(pendingAttempts);
      if (savedSettings) this.setSettings(savedSettings);
      else this._confirmedSettings = Object.assign({}, this._confirmedSettings, snapshot);
    } catch (e) {
      if (saveSeq === this._saveStatusSeq) {
        console.warn('[FloatingPanel] settings save failed:', e);
        this.showMessage('设置保存失败', 'err');
      }
      return false;
    }

    if (this.business.onSettingsChange) {
      try {
        this.business.onSettingsChange(snapshot, { changedKey, changedKeys: patchKeys.slice() });
      } catch (e) {
        console.warn('[FloatingPanel] settings apply failed:', e);
        this.showMessage('设置已保存，但页面应用失败', 'err');
        return true;
      }
    }

    if (saveSeq !== this._saveStatusSeq) return true;

    var refreshKeys = patchKeys.length ? patchKeys : (changedKey ? [changedKey] : []);
    var applyMode = this._getSettingsApplyMode(refreshKeys);
    var successMessage = msg || '设置已保存';
    if (applyMode === 'pageReload') successMessage += '，需刷新页面生效';
    else if (applyMode === 'hotReload') successMessage += '，缩略图已自动重新加载';
    this.showMessage(successMessage, 'ok');
    return true;
  }

  _cloneSettingsForSave(source, changedKeys) {
    const snapshot = {};
    source = source || {};
    const keys = Array.isArray(changedKeys) ? changedKeys : [];
    if (!keys.length) return snapshot;
    const requested = {};
    keys.forEach((key) => { requested[key] = true; });
    for (const item of this.schema) {
      if (!item || !requested[item.key] || !Object.prototype.hasOwnProperty.call(source, item.key)) continue;
      snapshot[item.key] = source[item.key];
    }
    return snapshot;
  }

  _queueSettingsSave(snapshot) {
    this._saveChain = this._saveChain.catch(() => {}).then(() => this.storage.setSettings(snapshot));
    return this._saveChain;
  }

  _bindLauncher() {
    this._addListener(this._launcher, 'click', (e) => {
      e.stopPropagation();
      if (this._suppressNextLauncherClick) {
        this._suppressNextLauncherClick = false;
        if (e.preventDefault) e.preventDefault();
        return;
      }
      this.toggle();
    });
    const closeBtn = this._panel.querySelector('#bfp-close');
    if (closeBtn) this._addListener(closeBtn, 'click', () => this.close());

    const helpBtn = this._panel.querySelector('#bfp-help-toggle');
    if (helpBtn) {
      this._addListener(helpBtn, 'click', (e) => {
        e.stopPropagation();
        this._toggleHelp();
      });
    }
  }

  _bindKeyboard() {
    const keyboardTarget = this._shadow || this._panel;
    if (keyboardTarget) {
      this._addListener(keyboardTarget, 'keydown', (e) => {
        if (this._panel.classList.contains('bfp-hidden')) return;
        if (/^Arrow(?:Up|Down|Left|Right)$/.test(e.key) && this._eventTargetsFloatingUI(e)) {
          e.stopPropagation();
        }
      });
    }
    this._addListener(document, 'keydown', (e) => {
      if (this._panel.classList.contains('bfp-hidden')) return;
      if (e.key !== 'Escape') return;
      if (this._isPreviewOverlayActive() && !this._eventTargetsFloatingUI(e)) return;
      const targetsFloatingUI = this._eventTargetsFloatingUI(e);
      if (targetsFloatingUI) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (this._eventTargetsHelpPanel(e) && this._helpPanel && !this._helpPanel.classList.contains('bfp-hidden')) {
        this._hideHelp(true);
        return;
      }
      this.close();
    }, true);
  }

  _isPreviewOverlayActive() {
    const overlay = document.querySelector('.atp-preview-overlay');
    return !!(overlay && overlay.style.display !== 'none');
  }

  _eventTargetsFloatingUI(e) {
    const path = e && e.composedPath ? e.composedPath() : [];
    return (
      path.includes(this._panel) ||
      path.includes(this._helpPanel) ||
      path.includes(this._launcher) ||
      path.includes(this._root)
    );
  }

  _eventTargetsHelpPanel(e) {
    const path = e && e.composedPath ? e.composedPath() : [];
    return !!(this._helpPanel && path.includes(this._helpPanel));
  }

  _focusPanelInitialControl() {
    const closeBtn = this._panel.querySelector('#bfp-close');
    const target = closeBtn || this._panel;
    if (target && typeof target.focus === 'function') target.focus();
  }

  _restoreLauncherFocus() {
    if (this._launcher && typeof this._launcher.focus === 'function') this._launcher.focus();
  }

  _setLauncherOpenState(open) {
    if (!this._launcher) return;
    this._launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      if (this._launcherTabIndexBeforeOpen === undefined && this._launcher.getAttribute) {
        this._launcherTabIndexBeforeOpen = this._launcher.getAttribute('tabindex');
      }
      if (this._launcher.setAttribute) this._launcher.setAttribute('tabindex', '-1');
      else this._launcher.tabIndex = -1;
      return;
    }
    if (this._launcherTabIndexBeforeOpen !== undefined) {
      if (this._launcherTabIndexBeforeOpen === null) {
        if (this._launcher.removeAttribute) this._launcher.removeAttribute('tabindex');
        else this._launcher.tabIndex = 0;
      } else if (this._launcher.setAttribute) {
        this._launcher.setAttribute('tabindex', this._launcherTabIndexBeforeOpen);
      }
      this._launcherTabIndexBeforeOpen = undefined;
    }
  }

  _getFloatingActiveElement() {
    return (this._shadow && this._shadow.activeElement) || document.activeElement || null;
  }

  _releaseHiddenPanelFocus() {
    const active = this._getFloatingActiveElement();
    if (!active) return;
    const inPanel = this._panel && this._panel.contains(active);
    const inHelp = this._helpPanel && this._helpPanel.contains(active);
    if (!inPanel && !inHelp) return;
    if (typeof active.blur === 'function') {
      try { active.blur(); } catch (e) {}
    }
  }

  _toggleHelp() {
    if (this._helpPanel.classList.contains('bfp-hidden')) {
      this._showHelp();
    } else {
      this._hideHelp();
    }
  }

  _showHelp() {
    this._ensureHelpRendered();
    this._helpPanel.classList.remove('bfp-hidden');
    this._helpPanel.setAttribute('aria-hidden', 'false');
    const helpBtn = this._panel.querySelector('#bfp-help-toggle');
    if (helpBtn) {
      helpBtn.setAttribute('aria-expanded', 'true');
      helpBtn.setAttribute('aria-label', '关闭参数说明');
    }
    this._positionHelpPanel();
    const closeBtn = this._helpPanel.querySelector('#bfp-help-close');
    if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
  }

  _hideHelp(restoreFocus) {
    this._helpPanel.classList.add('bfp-hidden');
    this._helpPanel.classList.remove('bfp-help-stacked');
    this._setHelpDocked(false);
    this._helpPanel.setAttribute('aria-hidden', 'true');
    const helpBtn = this._panel.querySelector('#bfp-help-toggle');
    if (helpBtn) {
      helpBtn.setAttribute('aria-expanded', 'false');
      helpBtn.setAttribute('aria-label', '打开参数说明');
      if (restoreFocus && typeof helpBtn.focus === 'function') helpBtn.focus();
    }
  }

  _clampPosition(x, y, panelSize) {
    const panelW = panelSize && panelSize.width ? panelSize.width : (this._panel.offsetWidth || 312);
    const panelH = panelSize && panelSize.height ? panelSize.height : (this._panel.offsetHeight || 340);
    return {
      x: Math.max(8, Math.min(Number(x) || 8, (window.innerWidth || 800) - panelW - 8)),
      y: Math.max(8, Math.min(Number(y) || 8, (window.innerHeight || 600) - panelH - 8)),
    };
  }

  _clampLauncherPosition(x, y, size) {
    const w = size && size.width ? size.width : ((this._launcher && this._launcher.offsetWidth) || 42);
    const h = size && size.height ? size.height : ((this._launcher && this._launcher.offsetHeight) || 42);
    return {
      x: Math.max(8, Math.min(Number(x) || 8, (window.innerWidth || 800) - w - 8)),
      y: Math.max(8, Math.min(Number(y) || 8, (window.innerHeight || 600) - h - 8)),
    };
  }

  _applyLauncherPosition(x, y, size) {
    if (!this._launcher || !this._launcher.style) return;
    const pos = this._clampLauncherPosition(x, y, size);
    this._launcherPos = pos;
    this._launcher.style.left = pos.x + 'px';
    this._launcher.style.top = pos.y + 'px';
    this._launcher.style.right = 'auto';
    this._launcher.style.bottom = 'auto';
  }

  _setHelpDocked(docked) {
    if (!this._helpPanel || !this._helpPanel.classList) return;
    if (docked) this._helpPanel.classList.add('bfp-help-docked');
    else this._helpPanel.classList.remove('bfp-help-docked');

    if (this._panel && this._panel.classList) {
      if (docked) this._panel.classList.add('bfp-help-docked-open');
      else this._panel.classList.remove('bfp-help-docked-open');
    }

    const hiddenTargets = [this._headerEl, this._tabsEl, this._bodyEl, this._msgEl];
    for (const target of hiddenTargets) {
      if (!target) continue;
      if (docked && target.setAttribute) target.setAttribute('aria-hidden', 'true');
      else if (!docked && target.removeAttribute) target.removeAttribute('aria-hidden');
    }
    if (docked) this._focusDockedHelpIfNeeded(hiddenTargets);
  }

  _focusDockedHelpIfNeeded(hiddenTargets) {
    const active = this._getFloatingActiveElement();
    if (!active || (this._helpPanel && this._helpPanel.contains(active))) return;
    const hiddenHasFocus = hiddenTargets.some(target => target && target.contains && target.contains(active));
    if (!hiddenHasFocus) return;
    const target = this._helpPanel.querySelector('#bfp-help-close') || this._helpBodyEl;
    if (target && typeof target.focus === 'function') target.focus();
  }

  _applyPosition(x, y, panelSize) {
    const pos = this._clampPosition(x, y, panelSize);
    this._panelPos = pos;
    this._panel.style.left = pos.x + 'px';
    this._panel.style.top = pos.y + 'px';
    this._panel.style.right = 'auto';
    this._panel.style.bottom = 'auto';
    this._positionHelpPanel();
  }

  _positionHelpPanel() {
    if (this._helpPanel.classList.contains('bfp-hidden')) return;
    const gap = 8;
    const main = this._panel.getBoundingClientRect();
    const viewportW = window.innerWidth || 0;
    const viewportH = window.innerHeight || 0;
    this._helpPanel.classList.remove('bfp-help-stacked');
    this._setHelpDocked(false);
    let helpW = this._helpPanel.offsetWidth || 300;
    const fitsLeft = main.left - gap - helpW >= 8;
    const fitsRight = main.right + gap + helpW <= viewportW - 8;
    const fitsBeside = fitsLeft || fitsRight;

    let left = Math.max(8, Math.min(main.left, viewportW - helpW - 8));
    let top;
    this._helpPanel.classList.toggle('bfp-help-stacked', !fitsBeside);
    helpW = this._helpPanel.offsetWidth || helpW;
    const helpH = this._helpPanel.offsetHeight || 400;
    left = Math.max(8, Math.min(main.left, viewportW - helpW - 8));
    const fitsBelow = main.bottom + gap + helpH <= viewportH - 8;
    const fitsAbove = main.top - gap - helpH >= 8;
    if (fitsBeside) {
      left = fitsLeft ? main.left - helpW - gap : main.right + gap;
      top = Math.max(8, Math.min(main.top, viewportH - helpH - 8));
    } else if (fitsBelow) {
      top = main.bottom + gap;
    } else if (fitsAbove) {
      top = main.top - gap - helpH;
    } else {
      this._setHelpDocked(true);
      this._helpPanel.style.left = '';
      this._helpPanel.style.top = '';
      this._helpPanel.style.right = '';
      this._helpPanel.style.bottom = '';
      return;
    }

    this._helpPanel.style.left = left + 'px';
    this._helpPanel.style.top = top + 'px';
    this._helpPanel.style.right = 'auto';
    this._helpPanel.style.bottom = 'auto';
  }

  toggle() {
    if (this._panel.classList.contains('bfp-hidden')) {
      this.open();
    } else {
      this.close();
    }
  }

  open() {
    const wasHidden = this._panel.classList.contains('bfp-hidden');
    this._panel.classList.remove('bfp-hidden');
    this._panel.setAttribute('aria-hidden', 'false');
    this._setLauncherOpenState(true);
    this._ensureSettingsRendered();
    this._ensureConsoleRendered();
    if (this._consoleViewEl) {
      this._switchTab(this._activeTab || 'console');
    } else if (this._settingsViewEl && this._settingsViewEl.classList) {
      this._settingsViewEl.classList.add('bfp-active');
    }
    this._applyPosition(this._panel.offsetLeft, this._panel.offsetTop);
    this._startStatusPolling();
    if (wasHidden) this._focusPanelInitialControl();
  }

  close() {
    this._closeWithFocusRestore(true);
  }

  _closeWithoutFocusRestore() {
    this._closeWithFocusRestore(false);
  }

  _closeWithFocusRestore(restoreFocus) {
    const wasHidden = this._panel.classList.contains('bfp-hidden');
    this._stopStatusPolling();
    this._panel.classList.add('bfp-hidden');
    this._panel.setAttribute('aria-hidden', 'true');
    this._panel.setAttribute('aria-modal', 'false');
    this._setLauncherOpenState(false);
    this._hideHelp(false);
    if (!wasHidden && restoreFocus) this._restoreLauncherFocus();
    if (!wasHidden && !restoreFocus) this._releaseHiddenPanelFocus();
  }

  _bindDrag() {
    const header = this._panel.querySelector('#bfp-header');
    if (!header) return;
    let drag = null;
    const flushDrag = () => {
      this._dragFrame = null;
      if (!drag) return;
      this._applyPosition(drag.nextX, drag.nextY, drag.panelSize);
    };

    const startDrag = (e) => {
      if (e.target && e.target.tagName === 'BUTTON') return;
      if (typeof e.button === 'number' && e.button !== 0) return;
      drag = {
        sx: e.clientX - this._panel.offsetLeft,
        sy: e.clientY - this._panel.offsetTop,
        nextX: this._panel.offsetLeft,
        nextY: this._panel.offsetTop,
        panelSize: {
          width: this._panel.offsetWidth || 312,
          height: this._panel.offsetHeight || 340,
        },
        pointerId: e.pointerId,
        pointerTarget: e.currentTarget || header,
      };
      this._panel.style.transition = 'none';
      if (drag.pointerTarget && drag.pointerId !== undefined && drag.pointerTarget.setPointerCapture) {
        try { drag.pointerTarget.setPointerCapture(drag.pointerId); } catch (captureError) {}
      }
      if (e.preventDefault) e.preventDefault();
    };

    const moveDrag = (e) => {
      if (!drag) return;
      if (drag.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
      drag.nextX = e.clientX - drag.sx;
      drag.nextY = e.clientY - drag.sy;
      if (this._dragFrame) return;
      if (typeof requestAnimationFrame === 'function') {
        this._dragFrame = requestAnimationFrame(flushDrag);
      } else {
        flushDrag();
      }
      if (e.preventDefault) e.preventDefault();
    };

    const endDrag = (e) => {
      if (!drag) return;
      if (drag.pointerId !== undefined && e && e.pointerId !== drag.pointerId) return;
      const pointerTarget = drag.pointerTarget;
      const pointerId = drag.pointerId;
      if (this._dragFrame && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this._dragFrame);
        this._dragFrame = null;
      }
      this._applyPosition(drag.nextX, drag.nextY, drag.panelSize);
      drag = null;
      this._panel.style.transition = '';
      this._savePosition();
      this._positionHelpPanel();
      if (pointerTarget && pointerId !== undefined && pointerTarget.releasePointerCapture) {
        try { pointerTarget.releasePointerCapture(pointerId); } catch (releaseError) {}
      }
    };

    if (typeof window !== 'undefined' && 'PointerEvent' in window) {
      this._addListener(header, 'pointerdown', startDrag);
      this._addListener(document, 'pointermove', moveDrag);
      this._addListener(document, 'pointerup', endDrag);
      this._addListener(document, 'pointercancel', endDrag);
    } else {
      this._addListener(header, 'mousedown', startDrag);
      this._addListener(document, 'mousemove', moveDrag);
      this._addListener(document, 'mouseup', endDrag);
    }
  }

  _bindLauncherDrag() {
    const launcher = this._launcher;
    if (!launcher) return;
    let drag = null;

    const flushLauncherDrag = () => {
      this._launcherDragFrame = null;
      if (!drag || !drag.moved) return;
      this._applyLauncherPosition(drag.nextX, drag.nextY, drag.size);
    };

    const startLauncherDrag = (e) => {
      if (typeof e.button === 'number' && e.button !== 0) return;
      const rect = launcher.getBoundingClientRect ? launcher.getBoundingClientRect() : null;
      const baseLeft = rect && typeof rect.left === 'number' ? rect.left : (launcher.offsetLeft || ((window.innerWidth || 800) - 62));
      const baseTop = rect && typeof rect.top === 'number' ? rect.top : (launcher.offsetTop || ((window.innerHeight || 600) - 126));
      drag = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        sx: e.clientX - baseLeft,
        sy: e.clientY - baseTop,
        nextX: baseLeft,
        nextY: baseTop,
        moved: false,
        size: {
          width: (rect && rect.width) || launcher.offsetWidth || 42,
          height: (rect && rect.height) || launcher.offsetHeight || 42,
        },
        pointerId: e.pointerId,
        pointerTarget: e.currentTarget || launcher,
      };
    };

    const moveLauncherDrag = (e) => {
      if (!drag) return;
      if (drag.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < 5) return;
        drag.moved = true;
        launcher.style.transition = 'none';
        if (drag.pointerTarget && drag.pointerId !== undefined && drag.pointerTarget.setPointerCapture) {
          try { drag.pointerTarget.setPointerCapture(drag.pointerId); } catch (captureError) {}
        }
      }
      drag.nextX = e.clientX - drag.sx;
      drag.nextY = e.clientY - drag.sy;
      if (!this._launcherDragFrame) {
        if (typeof requestAnimationFrame === 'function') {
          this._launcherDragFrame = requestAnimationFrame(flushLauncherDrag);
        } else {
          flushLauncherDrag();
        }
      }
      if (e.preventDefault) e.preventDefault();
    };

    const endLauncherDrag = (e) => {
      if (!drag) return;
      if (drag.pointerId !== undefined && e && e.pointerId !== drag.pointerId) return;
      const wasMoved = drag.moved;
      const pointerTarget = drag.pointerTarget;
      const pointerId = drag.pointerId;
      if (this._launcherDragFrame && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this._launcherDragFrame);
        this._launcherDragFrame = null;
      }
      if (wasMoved) {
        this._suppressNextLauncherClick = true;
        this._applyLauncherPosition(drag.nextX, drag.nextY, drag.size);
        launcher.style.transition = '';
        this._savePosition();
      }
      drag = null;
      if (wasMoved && pointerTarget && pointerId !== undefined && pointerTarget.releasePointerCapture) {
        try { pointerTarget.releasePointerCapture(pointerId); } catch (releaseError) {}
      }
    };

    if (typeof window !== 'undefined' && 'PointerEvent' in window) {
      this._addListener(launcher, 'pointerdown', startLauncherDrag);
      this._addListener(document, 'pointermove', moveLauncherDrag);
      this._addListener(document, 'pointerup', endLauncherDrag);
      this._addListener(document, 'pointercancel', endLauncherDrag);
    } else {
      this._addListener(launcher, 'mousedown', startLauncherDrag);
      this._addListener(document, 'mousemove', moveLauncherDrag);
      this._addListener(document, 'mouseup', endLauncherDrag);
    }
  }

  _bindOutsideClick() {
    const closeFromOutsidePointer = (e) => {
      if (this._panel.classList.contains('bfp-hidden')) return;
      if (this._eventTargetsFloatingUI(e)) return;
      this._closeWithoutFocusRestore();
    };
    if (typeof window !== 'undefined' && 'PointerEvent' in window) {
      this._addListener(document, 'pointerdown', closeFromOutsidePointer, true);
    } else {
      this._addListener(document, 'mousedown', closeFromOutsidePointer, true);
    }
  }

  _bindResize() {
    this._addListener(window, 'resize', () => {
      if (this._destroyed) return;
      if (this._launcherPos && this._launcher) {
        this._applyLauncherPosition(this._launcherPos.x, this._launcherPos.y);
      }
      if (!this._panel || this._panel.classList.contains('bfp-hidden')) return;
      this._applyPosition(this._panel.offsetLeft, this._panel.offsetTop);
    });
  }

  async _loadPosition() {
    try {
      if (this._cssReady) await this._cssReady;
      const pos = await this.storage.getPosition(location.hostname);
      if (this._destroyed || !pos) return;
      if (typeof pos.launcherX === 'number' && typeof pos.launcherY === 'number') {
        this._applyLauncherPosition(pos.launcherX, pos.launcherY);
      }
      if (typeof pos.x === 'number' && typeof pos.y === 'number') {
        this._applyPosition(pos.x, pos.y);
      }
    } catch {}
  }

  async _savePosition() {
    try {
      const payload = {};
      if (this._panelPos) {
        payload.x = this._panelPos.x;
        payload.y = this._panelPos.y;
      } else if (this._panel && typeof this._panel.offsetLeft === 'number') {
        payload.x = this._panel.offsetLeft;
        payload.y = this._panel.offsetTop;
      }
      if (this._launcherPos) {
        payload.launcherX = this._launcherPos.x;
        payload.launcherY = this._launcherPos.y;
      }
      await this.storage.setPosition(location.hostname, payload);
    } catch {}
  }
}
