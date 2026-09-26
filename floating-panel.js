class FloatingPanel {
  constructor(opts) {
    this.title = opts.title || '面板';
    this.schema = opts.settingsSchema || [];
    this.storage = opts.storage || this.defaultStorage();
    this.business = opts.business || {};
    this.settings = Object.assign({}, this.getDefaults());
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
    this._flashTimers = [];
    this._destroyed = false;
    this._settingsEventsBound = false;
    this._settingsReady = false;
    this._settingsRendered = false;
    this._helpRendered = false;
    this._createDOM();
    this._createLauncher();
    this._createPanel();
    this._createHelpView();
    this._setSettingsLoading(true);
    this._bindLauncher();
    this._bindKeyboard();
    this._bindDrag();
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
    target.addEventListener(type, handler, options);
    this._listeners.push({ target, type, handler, options });
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._msgTimer);
    this._msgTimer = null;
    for (const timer of this._flashTimers) clearTimeout(timer);
    this._flashTimers = [];
    for (const l of this._listeners) {
      l.target.removeEventListener(l.type, l.handler, l.options);
    }
    this._listeners = [];
    if (this._dragFrame && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._dragFrame);
    }
    this._dragFrame = null;
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
    const saved = typeof ATPNormalizeSettings === 'function'
      ? ATPNormalizeSettings(rawSaved)
      : (rawSaved || {});
    const merged = {};
    for (const item of this.schema) {
      merged[item.key] = saved[item.key] !== undefined ? saved[item.key] : item.default;
    }
    this.settings = merged;
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

  _ensureHelpRendered() {
    if (this._helpRendered) return;
    this._renderHelp();
  }

  setSettings(rawSettings) {
    const saved = typeof ATPNormalizeSettings === 'function'
      ? ATPNormalizeSettings(rawSettings)
      : (rawSettings || {});
    this._settingsReady = true;
    this._settingsLoadFailed = false;
    for (const item of this.schema) {
      const incomingValue = saved[item.key] !== undefined ? saved[item.key] : item.default;
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
    this._refreshDependentFields();
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
  }

  _reportNumberInputError(el, item) {
    if (!el || !item) return;
    el.setAttribute('aria-invalid', 'true');
    el.setAttribute('aria-describedby', 'bfp-msg');
    const range = item.min !== undefined && item.max !== undefined
      ? item.min + '-' + item.max
      : '有效';
    this.showMessage('请输入' + item.label + '的' + range + '范围内数值', 'err');
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
    btn.innerHTML = '<span class="bfp-launcher-icon">&#x1F5BC;</span><span class="bfp-launcher-dot"></span>';
    this._shadow.appendChild(btn);
    this._launcher = btn;
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
        <span>${this._esc(this.title)}</span>
        <span style="flex:1"></span>
        <button class="bfp-header-btn bfp-header-btn-help" id="bfp-help-toggle" type="button" aria-label="打开参数说明" aria-expanded="false" aria-controls="bfp-help-panel">?</button>
        <button class="bfp-header-btn" id="bfp-close" type="button" aria-label="关闭设置面板">&#x2715;</button>
      </div>
      <div class="bfp-body" id="bfp-body">
        <div class="bfp-view bfp-active" id="bfp-settings-view" data-view="settings"></div>
      </div>
      <div class="bfp-message bfp-msg-empty" id="bfp-msg" role="status" aria-live="polite" aria-atomic="true"></div>
    `;

    this._shadow.appendChild(panel);
    this._panel = panel;
    this._headerEl = panel.querySelector('#bfp-header');
    this._bodyEl = panel.querySelector('#bfp-body');
    this._settingsViewEl = panel.querySelector('#bfp-settings-view');
    this._msgEl = panel.querySelector('#bfp-msg');
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

  _renderSettings() {
    if (!this._settingsViewEl) return;
    this._settingsRendered = true;
    this._setSettingsLoading(false);
    const groups = {};
    for (const item of this.schema) {
      if (!groups[item.group]) groups[item.group] = [];
      groups[item.group].push(item);
    }

    let html = '';
    for (const [groupName, items] of Object.entries(groups)) {
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
    return '<div class="bfp-preset-row"><span class="bfp-preset-label">弱图加载预设</span><span class="bfp-preset-actions">' +
      '<button class="bfp-ordinary-preset" type="button" data-preset="ordinaryGentle" title="100M：可见 6 / 后台 1 / 同域 6">100M</button>' +
      '<button class="bfp-ordinary-preset" type="button" data-preset="ordinaryBalanced" title="200M：可见 8 / 后台 2 / 同域 8">200M</button>' +
      '<button class="bfp-ordinary-preset" type="button" data-preset="ordinaryFast" title="推荐：可见 12 / 后台 2 / 同域 10">高速（推荐）</button>' +
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
    const hint = (item.min !== undefined && item.max !== undefined) ? ' <span class="bfp-row-hint">' + this._esc(item.min) + '-' + this._esc(item.max) + '</span>' : '';
    return '<div class="bfp-row"><label class="bfp-row-label" for="' + fieldId + '">' + this._esc(item.label) + hint + '</label><span class="bfp-row-input-wrap"><input id="' + fieldId + '" type="number" data-key="' + this._esc(item.key) + '" value="' + this._esc(this.settings[item.key]) + '" min="' + (item.min !== undefined ? this._esc(item.min) : '') + '" max="' + (item.max !== undefined ? this._esc(item.max) : '') + '" step="' + this._esc(item.step || 1) + '"' + disabled + '><button class="bfp-reset" type="button" data-key="' + this._esc(item.key) + '" title="恢复默认" aria-label="恢复' + this._esc(item.label) + '默认值"' + disabled + '>&#x21BA;</button></span></div>';
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
      if (reset) reset.disabled = !enabled;
    }
    const preset = this._settingsViewEl.querySelector('.bfp-heavy-preset');
    if (preset) preset.disabled = !this.settings.heavyImageOptimization;
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
    const groups = {};
    for (const item of this.schema) {
      if (!groups[item.group]) groups[item.group] = [];
      groups[item.group].push(item);
    }

    let html = '';
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

    const previous = this.settings[key];
    let val;
    if (el.type === 'checkbox') {
      val = el.checked;
    } else if (el.tagName === 'SELECT') {
      val = el.value;
    } else {
      val = parseInt(el.value, 10);
      if (isNaN(val)) { el.value = this.settings[key]; this._clearInputDirty(key); this._reportNumberInputError(el, schema); return; }
      if (schema.min !== undefined && val < schema.min) { el.value = this.settings[key]; this._clearInputDirty(key); this._reportNumberInputError(el, schema); return; }
      if (schema.max !== undefined && val > schema.max) { el.value = this.settings[key]; this._clearInputDirty(key); this._reportNumberInputError(el, schema); return; }
      this._clearInputError(el);
    }

    this._clearInputDirty(key);
    this.settings[key] = val;
    this._refreshDependentFields();
    const attempt = this._markSaveAttempt(key, val);
    const saved = await this._saveSettings(null, key, [key]);
    if (!saved) {
      if (this._isSaveAttemptCurrent(attempt)) {
        this._clearPendingSaveAttempt(attempt);
        this.settings[key] = previous;
        if (el.type === 'checkbox') el.checked = previous;
        else el.value = previous;
        this._clearInputDirty(key);
        this._clearInputError(el);
        this._refreshDependentFields();
        this.flashError(el);
      }
    }
  }

  async _onReset(el) {
    const key = el.dataset.key;
    if (!key) return;
    const schema = this.schema.find(s => s.key === key);
    if (!schema) return;
    if (!this._isFieldEnabled(schema)) return;
    const previous = this.settings[key];
    this.settings[key] = schema.default;
    const input = this._settingsViewEl.querySelector('[data-key="' + key + '"]');
      if (input) {
        if (input.type === 'checkbox') input.checked = schema.default;
        else input.value = schema.default;
        this._clearInputDirty(key);
        this._clearInputError(input);
      }
    this._refreshDependentFields();
    const attempt = this._markSaveAttempt(key, schema.default);
    const saved = await this._saveSettings('已恢复 ' + schema.label + ' 的默认值', key, [key]);
    if (!saved) {
      if (this._isSaveAttemptCurrent(attempt)) {
        this._clearPendingSaveAttempt(attempt);
        this.settings[key] = previous;
        if (input) {
          if (input.type === 'checkbox') input.checked = previous;
          else input.value = previous;
          this._clearInputDirty(key);
          this._clearInputError(input);
          this.flashError(input);
        }
        this._refreshDependentFields();
      }
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
      ordinaryGentle: '已应用弱图 100M 预设',
      ordinaryBalanced: '已应用弱图 200M 预设',
      ordinaryFast: '已应用弱图高速预设'
    };
    const preset = ATPGetSettingsPreset(presetName, this.schema);
    return this._applySettingsPreset(el, preset, messages[presetName] || '已应用弱图预设', 'firstScreenConcurrency');
  }

  async _applySettingsPreset(el, preset, message, changedKey) {
    if (!el || el.__bfpBusy) return;
    const previous = Object.assign({}, this.settings);
    const knownKeys = this.schema.map(s => s.key);
    const presetKeys = Object.keys(preset);
    if (!presetKeys.length) {
      this.flashError(el);
      return;
    }
    presetKeys.forEach((key) => {
      if (knownKeys.indexOf(key) === -1) return;
      this.settings[key] = preset[key];
      const input = this._settingsViewEl.querySelector('[data-key="' + key + '"]');
          if (input) {
            if (input.type === 'checkbox') input.checked = preset[key];
            else input.value = preset[key];
            this._clearInputDirty(key);
            this._clearInputError(input);
          }
    });
    this._refreshDependentFields();
    this._setButtonBusy(el, true);
    const attempts = this._markSaveAttempts(presetKeys);
    try {
      const saved = await this._saveSettings(message, changedKey, presetKeys);
      if (!saved) {
        if (this._areSaveAttemptsCurrent(attempts)) {
          this._clearPendingSaveAttempts(attempts);
          this.settings = previous;
          presetKeys.forEach((key) => {
          const input = this._settingsViewEl.querySelector('[data-key="' + key + '"]');
          if (input) {
            if (input.type === 'checkbox') input.checked = previous[key];
            else input.value = previous[key];
            this._clearInputDirty(key);
            this._clearInputError(input);
          }
        });
          this._refreshDependentFields();
          this.flashError(el);
        }
        return;
      }
      this._refreshDependentFields();
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

  _areSaveAttemptsCurrent(attempts) {
    for (const key in attempts) {
      if (Object.prototype.hasOwnProperty.call(attempts, key) && !this._isSaveAttemptCurrent(attempts[key])) {
        return false;
      }
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
      // 仅当 Esc 发生在面板自身内时拦截事件；在页面其他位置（回帖框、论坛弹层）按 Esc
      // 也关闭面板，但不阻断页面自身的 Esc 行为（面板是非模态的）
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
    const panelW = panelSize && panelSize.width ? panelSize.width : (this._panel.offsetWidth || 280);
    const panelH = panelSize && panelSize.height ? panelSize.height : (this._panel.offsetHeight || 320);
    return {
      x: Math.max(8, Math.min(Number(x) || 8, window.innerWidth - panelW - 8)),
      y: Math.max(8, Math.min(Number(y) || 8, window.innerHeight - panelH - 8)),
    };
  }

  _setHelpDocked(docked) {
    if (!this._helpPanel || !this._helpPanel.classList) return;
    if (docked) this._helpPanel.classList.add('bfp-help-docked');
    else this._helpPanel.classList.remove('bfp-help-docked');

    if (this._panel && this._panel.classList) {
      if (docked) this._panel.classList.add('bfp-help-docked-open');
      else this._panel.classList.remove('bfp-help-docked-open');
    }

    const hiddenTargets = [this._headerEl, this._bodyEl, this._msgEl];
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
    this._settingsViewEl.classList.add('bfp-active');
    // 用 offsetLeft/offsetTop 读取布局位置：隐藏态 transform(translateY 10px) 的过渡
    // 会让 getBoundingClientRect 带上偏移，每次开合累计下移
    this._applyPosition(this._panel.offsetLeft, this._panel.offsetTop);
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
          width: this._panel.offsetWidth || 280,
          height: this._panel.offsetHeight || 320,
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
      if (this._destroyed || !this._panel || this._panel.classList.contains('bfp-hidden')) return;
      // offsetLeft/offsetTop 不受打开/关闭过渡的 transform 影响
      this._applyPosition(this._panel.offsetLeft, this._panel.offsetTop);
    });
  }

  async _loadPosition() {
    try {
      // 等 CSS 注入完成再定位：无样式时面板宽度是整行，clamp 会把保存的位置错误地压到左边缘
      if (this._cssReady) await this._cssReady;
      const pos = await this.storage.getPosition(location.hostname);
      if (this._destroyed) return;
      if (pos) {
        this._applyPosition(pos.x, pos.y);
      }
    } catch {}
  }

  async _savePosition() {
    try {
      await this.storage.setPosition(location.hostname, { x: this._panel.offsetLeft, y: this._panel.offsetTop });
    } catch {}
  }
}
