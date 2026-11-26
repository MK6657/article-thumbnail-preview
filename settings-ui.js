(function () {
  'use strict';

  var ORDINARY_PRESETS = [
    {
      key: 'ordinaryGentle',
      shortLabel: '温和',
      cardTitle: '省流温和',
      badge: '',
      metrics: '可见 6 · 后台 1 · 同域 6',
      desc: '低占用、弱网友好，减轻图床与解码负载',
      toast: '已切换至「省流温和」模式'
    },
    {
      key: 'ordinaryBalanced',
      shortLabel: '均衡',
      cardTitle: '均衡丝滑',
      badge: '推荐',
      metrics: '可见 8 · 后台 2 · 同域 8',
      desc: '开箱默认，兼顾首屏响应与列表顺滑滚动',
      toast: '已切换至「均衡丝滑」推荐模式'
    },
    {
      key: 'ordinaryFast',
      shortLabel: '极速',
      cardTitle: '极速宽带',
      badge: '',
      metrics: '可见 16 · 后台 2 · 同域 10',
      desc: '高并发极速铺开，适合高速网络环境',
      toast: '已切换至「极速宽带」模式'
    }
  ];

  function escapeHtml(value) {
    if (typeof SharedUtils !== 'undefined' && SharedUtils && typeof SharedUtils.escapeHtml === 'function') {
      return SharedUtils.escapeHtml(value);
    }
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function(ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function formatDefaultValue(item) {
    if (!item) return '';
    if (item.type === 'boolean') return item.default ? '开启' : '关闭';
    if (item.type === 'select') {
      var options = item.options || [];
      for (var oi = 0; oi < options.length; oi++) {
        if (options[oi].value === item.default) return options[oi].label;
      }
    }
    return String(item.default) + (item.unit || '');
  }

  function getApplyMode(item, schema) {
    if (typeof ATPGetSettingApplyMode === 'function') {
      return ATPGetSettingApplyMode(item, schema);
    }
    if (!item) return 'pageReload';
    if (item.applyMode) return item.applyMode;
    return item.immediate === false ? 'hotReload' : 'live';
  }

  function getApplyModeLabel(item, schema) {
    var mode = getApplyMode(item, schema);
    if (mode === 'pageReload') return '需刷新页面';
    if (mode === 'hotReload') return '自动重新加载缩略图';
    return '立即生效';
  }

  function buildTooltipText(item, schema) {
    if (!item) return '';
    var parts = [];
    if (item.description) parts.push(item.description);
    if (item.recommend) parts.push('推荐：' + item.recommend);
    if (item.min !== undefined && item.max !== undefined) {
      parts.push('范围：' + item.min + '–' + item.max + (item.unit ? item.unit : ''));
    }
    parts.push('默认：' + formatDefaultValue(item) + ' · ' + getApplyModeLabel(item, schema));
    return parts.join('\n');
  }

  function renderTooltipBadge(item, options) {
    options = options || {};
    var tip = buildTooltipText(item, options.schema);
    if (!tip) return '';
    var cls = options.variant === 'floating' ? 'bfp-tip-badge' : 'setting-tip-badge';
    var safeTip = escapeHtml(tip);
    var safeAria = escapeHtml((item.label || '参数') + '说明：' + tip.replace(/\n/g, '；'));
    return '<span class="' + cls + '" tabindex="0" role="note" title="' + safeTip + '" data-tip="' + safeTip + '" aria-label="' + safeAria + '">?</span>';
  }

  function isFieldEnabled(item, settings, loadFailed) {
    if (loadFailed) return false;
    if (!item || !item.enabledWhen) return true;
    return !!(settings && settings[item.enabledWhen.key] === item.enabledWhen.value);
  }

  function isValueDefault(item, settings) {
    if (!item || !settings || !Object.prototype.hasOwnProperty.call(settings, item.key)) return true;
    return settings[item.key] === item.default;
  }

  function detectActivePreset(settings, schema) {
    if (typeof ATPDetectActiveOrdinaryPreset === 'function') {
      return ATPDetectActiveOrdinaryPreset(settings, schema);
    }
    return null;
  }

  function getPresetToast(presetName) {
    for (var i = 0; i < ORDINARY_PRESETS.length; i++) {
      if (ORDINARY_PRESETS[i].key === presetName) return ORDINARY_PRESETS[i].toast;
    }
    return '已应用加载预设';
  }

  function renderPresetBar(options) {
    options = options || {};
    var variant = options.variant === 'floating' ? 'floating' : 'popup';
    var active = detectActivePreset(options.settings, options.schema);
    var rowCls = variant === 'floating' ? 'bfp-preset-row' : 'setting-row setting-row-presets';
    var labelCls = variant === 'floating' ? 'bfp-preset-label' : 'setting-preset-label';
    var actionsCls = variant === 'floating' ? 'bfp-preset-actions' : 'setting-preset-actions';
    var btnCls = variant === 'floating' ? 'bfp-ordinary-preset' : 'btn-ordinary-preset';
    var labelText = options.label || '加载速度预设';
    var html = '<div class="' + rowCls + '"><span class="' + labelCls + '">' + escapeHtml(labelText) + '</span><span class="' + actionsCls + '">';
    for (var i = 0; i < ORDINARY_PRESETS.length; i++) {
      var p = ORDINARY_PRESETS[i];
      var pressed = active === p.key;
      var buttonText = p.badge ? p.shortLabel + '·' + p.badge : p.shortLabel;
      html += '<button class="' + btnCls + (pressed ? ' is-active' : '') + '" type="button" data-preset="' + escapeHtml(p.key) + '" aria-pressed="' + (pressed ? 'true' : 'false') + '" title="' + escapeHtml(p.cardTitle + '：' + p.metrics) + '">' + escapeHtml(buttonText) + '</button>';
    }
    html += '</span></div>';
    return html;
  }

  function renderPresetCards(settings, schema) {
    var active = detectActivePreset(settings, schema);
    var isCustom = settings && active === null;
    var html = '<div class="mode-cards-header">' +
      '<div class="mode-cards-heading"><span class="mode-cards-title">加载模式</span><span class="mode-cards-sub">' + (isCustom ? '当前为自定义参数' : '点击即刻切换并发策略') + '</span></div>' +
      '<button type="button" id="restoreRecommendedPreset" class="btn-restore-preset btn-ordinary-preset' + (isCustom ? '' : ' hidden') + '" data-preset="ordinaryBalanced" data-custom-preset-hint="1" title="恢复为均衡丝滑默认推荐并发">↺ 恢复默认推荐</button>' +
      '</div>' +
      '<div class="mode-cards-grid" role="group" aria-label="加载速度模式预设">';
    for (var i = 0; i < ORDINARY_PRESETS.length; i++) {
      var p = ORDINARY_PRESETS[i];
      var pressed = active === p.key;
      html += '<button type="button" class="mode-card btn-ordinary-preset' + (pressed ? ' is-active' : '') + '" data-preset="' + escapeHtml(p.key) + '" aria-pressed="' + (pressed ? 'true' : 'false') + '">' +
        '<span class="mode-card-top">' +
          '<span class="mode-card-name">' + escapeHtml(p.cardTitle) + (p.badge ? ' <span class="mode-card-rec">' + escapeHtml(p.badge) + '</span>' : '') + '</span>' +
          '<span class="mode-card-check" aria-hidden="true">' + (pressed ? '✓' : '') + '</span>' +
        '</span>' +
        '<span class="mode-card-metrics">' + escapeHtml(p.metrics) + '</span>' +
        '<span class="mode-card-desc">' + escapeHtml(p.desc) + '</span>' +
      '</button>';
    }
    html += '</div>';
    return html;
  }

  function syncPresetButtons(root, settings, schema) {
    if (!root || !root.querySelectorAll) return;
    var active = detectActivePreset(settings, schema);
    var isCustom = !!(settings && active === null);
    var buttons = root.querySelectorAll('[data-preset]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.getAttribute('data-custom-preset-hint') === '1') {
        if (btn.classList) btn.classList.toggle('hidden', !isCustom);
        continue;
      }
      var key = btn.getAttribute('data-preset');
      var pressed = active === key;
      btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      if (btn.classList) btn.classList.toggle('is-active', pressed);
      var check = btn.querySelector ? btn.querySelector('.mode-card-check') : null;
      if (check) check.textContent = pressed ? '✓' : '';
    }
    var sub = root.querySelector ? root.querySelector('.mode-cards-sub') : null;
    if (sub && settings) {
      sub.textContent = isCustom ? '当前为自定义参数' : '点击即刻切换并发策略';
    }
  }

  function syncResetButtonState(resetBtn, item, settings) {
    if (!resetBtn || !item) return;
    var atDefault = isValueDefault(item, settings);
    resetBtn.setAttribute('data-is-default', atDefault ? 'true' : 'false');
    if (resetBtn.classList) {
      resetBtn.classList.toggle('is-default', atDefault);
      resetBtn.classList.toggle('is-modified', !atDefault);
    }
  }

  function renderFieldRow(item, settings, options) {
    options = options || {};
    var variant = options.variant === 'floating' ? 'floating' : 'popup';
    var enabled = isFieldEnabled(item, settings, !!options.loadFailed);
    var disabledAttr = enabled ? '' : ' disabled';
    var currentVal = settings && Object.prototype.hasOwnProperty.call(settings, item.key) ? settings[item.key] : item.default;
    var tipBadge = renderTooltipBadge(item, { variant: variant, schema: options.schema });
    var atDefault = isValueDefault(item, settings);
    var resetStateCls = atDefault ? ' is-default' : ' is-modified';

    if (variant === 'floating') {
      if (item.type === 'boolean') {
        var checked = currentVal ? 'checked' : '';
        var preset = item.key === 'heavyImageOptimization'
          ? '<button class="bfp-heavy-preset" type="button" title="恢复重图原始预设"' + (currentVal ? '' : ' disabled') + '>恢复原始预设</button>'
          : '';
        var actionClass = preset ? ' bfp-check-row-action' : '';
        return '<div class="bfp-check-row' + actionClass + '"><label><input type="checkbox" data-key="' + escapeHtml(item.key) + '" ' + checked + disabledAttr + '> <span class="bfp-check-text">' + escapeHtml(item.label) + '</span></label>' + tipBadge + preset + '</div>';
      }
      var bfpFieldId = 'bfp-field-' + escapeHtml(item.key);
      if (item.type === 'select') {
        var bfpOpts = (item.options || []).map(function(o) {
          return '<option value="' + escapeHtml(o.value) + '"' + (currentVal === o.value ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>';
        }).join('');
        return '<div class="bfp-row"><label class="bfp-row-label" for="' + bfpFieldId + '"><span>' + escapeHtml(item.label) + '</span>' + tipBadge + '</label><select id="' + bfpFieldId + '" data-key="' + escapeHtml(item.key) + '"' + disabledAttr + '>' + bfpOpts + '</select></div>';
      }
      var bfpHint = (item.min !== undefined && item.max !== undefined)
        ? ' <span class="bfp-row-hint">' + escapeHtml(item.min) + '–' + escapeHtml(item.max) + (item.unit ? escapeHtml(item.unit) : '') + '</span>'
        : '';
      return '<div class="bfp-row"><label class="bfp-row-label" for="' + bfpFieldId + '"><span>' + escapeHtml(item.label) + '</span>' + bfpHint + tipBadge + '</label><span class="bfp-row-input-wrap"><input id="' + bfpFieldId + '" type="number" data-key="' + escapeHtml(item.key) + '" value="' + escapeHtml(currentVal) + '" min="' + (item.min !== undefined ? escapeHtml(item.min) : '') + '" max="' + (item.max !== undefined ? escapeHtml(item.max) : '') + '" step="' + escapeHtml(item.step || 1) + '"' + disabledAttr + '><button class="bfp-reset' + resetStateCls + '" type="button" data-key="' + escapeHtml(item.key) + '" data-is-default="' + (atDefault ? 'true' : 'false') + '" title="恢复默认 (' + escapeHtml(formatDefaultValue(item)) + ')" aria-label="恢复' + escapeHtml(item.label) + '默认值"' + disabledAttr + '>&#x21BA;</button></span>' +
        '<span id="' + bfpFieldId + '-error" class="bfp-number-error" role="alert"></span></div>';
    }

    // Popup variant
    if (item.type === 'boolean') {
      var pChecked = currentVal ? ' checked' : '';
      var html = '<div class="setting-row setting-row-boolean"><label><input type="checkbox" id="' + escapeHtml(item.key) + '"' + pChecked + disabledAttr + '> <span class="setting-label-text">' + escapeHtml(item.label) + '</span></label>' + tipBadge;
      if (item.key === 'heavyImageOptimization') {
        html += '<button class="btn-heavy-preset" type="button"' + (currentVal ? '' : ' disabled') + '>恢复原始预设</button>';
      }
      html += '</div>';
      return html;
    }
    if (item.type === 'select') {
      var selectHtml = '<div class="setting-row"><label for="' + escapeHtml(item.key) + '"><span class="setting-label-text">' + escapeHtml(item.label) + '</span>' + tipBadge + '</label><span class="input-wrap"><select id="' + escapeHtml(item.key) + '"' + disabledAttr + '>';
      (item.options || []).forEach(function(o) {
        selectHtml += '<option value="' + escapeHtml(o.value) + '"' + (currentVal === o.value ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>';
      });
      selectHtml += '</select></span></div>';
      return selectHtml;
    }
    var range = (item.min !== undefined && item.max !== undefined)
      ? ' <small>' + escapeHtml(item.min) + '–' + escapeHtml(item.max) + (item.unit ? escapeHtml(item.unit) : '') + '</small>'
      : '';
    return '<div class="setting-row setting-row-number"><label for="' + escapeHtml(item.key) + '"><span class="setting-label-text">' + escapeHtml(item.label) + '</span>' + range + tipBadge + '</label><span class="input-wrap"><input type="number" id="' + escapeHtml(item.key) + '" value="' + escapeHtml(currentVal) + '" min="' + (item.min !== undefined ? escapeHtml(item.min) : '') + '" max="' + (item.max !== undefined ? escapeHtml(item.max) : '') + '" step="' + escapeHtml(item.step || 1) + '"' + disabledAttr + '><button class="btn-reset' + resetStateCls + '" type="button" data-key="' + escapeHtml(item.key) + '" data-is-default="' + (atDefault ? 'true' : 'false') + '" title="恢复默认 (' + escapeHtml(formatDefaultValue(item)) + ')" aria-label="恢复' + escapeHtml(item.label) + '默认值"' + disabledAttr + '>↺</button></span>' +
      '<span id="' + escapeHtml(item.key) + '-error" class="setting-number-error" role="alert"></span></div>';
  }

  function renderSettingsGroup(groupName, items, settings, options) {
    options = options || {};
    var variant = options.variant === 'floating' ? 'floating' : 'popup';
    var groupMeta = typeof ATPGetSettingsGroupMeta === 'function' ? ATPGetSettingsGroupMeta(groupName) : {};
    var collapsible = options.forceExpanded ? false : !!groupMeta.collapsible;
    var isOpen = options.openGroups && options.openGroups.indexOf(groupName) !== -1
      ? true
      : groupMeta.collapsed === false;
    var countBadge = items.length ? ' <span class="' + (variant === 'floating' ? 'bfp-group-count' : 'settings-group-count') + '">' + items.length + '</span>' : '';
    var html = '';

    if (variant === 'floating') {
      html += collapsible
        ? '<details class="bfp-section bfp-section-collapsible"' + (isOpen ? ' open' : '') + '><summary class="bfp-section-title bfp-section-summary"><span>' + escapeHtml(groupName) + '</span>' + countBadge + '</summary><div class="bfp-section-body">'
        : '<div class="bfp-section"><div class="bfp-section-title"><span>' + escapeHtml(groupName) + '</span>' + countBadge + '</div>';
      if (groupName === '加载') {
        html += renderPresetBar({ variant: 'floating', settings: settings, schema: options.schema });
      }
      for (var fi = 0; fi < items.length; fi++) {
        html += renderFieldRow(items[fi], settings, options);
      }
      html += collapsible ? '</div></details>' : '</div>';
      return html;
    }

    html += collapsible
      ? '<details class="settings-section settings-section-collapsible"' + (isOpen ? ' open' : '') + '><summary class="settings-section-summary"><span>' + escapeHtml(groupName) + '</span>' + countBadge + '</summary><div class="settings-section-body">'
      : '<section class="settings-section"><h2>' + escapeHtml(groupName) + '</h2>';
    if (groupName === '加载') {
      html += renderPresetBar({ variant: 'popup', settings: settings, schema: options.schema });
    }
    for (var pi = 0; pi < items.length; pi++) {
      html += renderFieldRow(items[pi], settings, options);
    }
    html += collapsible ? '</div></details>' : '</section>';
    return html;
  }

  function renderSettingsGroups(schema, settings, options) {
    options = options || {};
    var viewGroups = typeof ATPGetSettingsViewGroups === 'function'
      ? ATPGetSettingsViewGroups(schema)
      : [];
    var onlyGroups = Array.isArray(options.onlyGroups) ? options.onlyGroups : null;
    var excludeGroups = Array.isArray(options.excludeGroups) ? options.excludeGroups : null;
    var parts = [];
    for (var i = 0; i < viewGroups.length; i++) {
      var groupName = viewGroups[i][0];
      var items = viewGroups[i][1];
      if (onlyGroups && onlyGroups.indexOf(groupName) === -1) continue;
      if (excludeGroups && excludeGroups.indexOf(groupName) !== -1) continue;
      parts.push(renderSettingsGroup(groupName, items, settings, Object.assign({}, options, { schema: schema })));
    }
    return parts.join('');
  }

  function buildHelpHtml(schema, options) {
    options = options || {};
    var variant = options.variant === 'floating' ? 'floating' : 'popup';
    var source = Array.isArray(schema) ? schema : (typeof SETTINGS_SCHEMA !== 'undefined' ? SETTINGS_SCHEMA : []);
    var groups = Object.create(null);
    var groupOrder = ['常用', '显示', '加载', '高级', '专家调优'];
    for (var i = 0; i < source.length; i++) {
      var item = source[i];
      if (!item || !item.key) continue;
      var groupName = item.quickAccess ? '常用' : (item.group || '其他');
      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(item);
    }
    var orderedNames = groupOrder.concat(Object.keys(groups).filter(function(n) {
      return groupOrder.indexOf(n) === -1;
    })).filter(function(n) {
      return groups[n] && groups[n].length > 0;
    });

    var staticHelp = options.staticHelp || null;
    var sectionCls = variant === 'floating' ? 'bfp-help-section' : 'help-section';
    var catCls = variant === 'floating' ? 'bfp-help-section-title' : 'help-cat';
    var itemCls = variant === 'floating' ? 'bfp-help-item' : 'help-item';
    var badgeCls = variant === 'floating' ? 'bfp-apply-badge' : 'help-apply-badge';
    var html = '';

    for (var gi = 0; gi < orderedNames.length; gi++) {
      var gName = orderedNames[gi];
      html += variant === 'floating' ? '<div class="' + sectionCls + '">' : '';
      html += '<div class="' + catCls + '">' + escapeHtml(gName) + '</div>';
      var list = groups[gName];
      for (var li = 0; li < list.length; li++) {
        var entry = list[li];
        var mode = getApplyMode(entry, source);
        var modeText = getApplyModeLabel(entry, source);
        html += '<div class="' + itemCls + '"><b>' + escapeHtml(entry.label) + '</b> ' +
          '<span class="' + badgeCls + ' is-' + escapeHtml(mode) + '">' + escapeHtml(modeText) + '</span>' +
          ' — ' + escapeHtml(entry.description || '');
        if (entry.recommend) html += '<br><span class="help-meta">推荐：' + escapeHtml(entry.recommend) + '</span>';
        if (entry.lowImpact) html += '<br><span class="help-meta">过低：' + escapeHtml(entry.lowImpact) + '</span>';
        if (entry.highImpact) html += '<br><span class="help-meta">过高：' + escapeHtml(entry.highImpact) + '</span>';
        var rangeBit = (entry.min !== undefined && entry.max !== undefined)
          ? '范围 ' + escapeHtml(entry.min) + '–' + escapeHtml(entry.max) + (entry.unit ? escapeHtml(entry.unit) : '') + ' · '
          : '';
        html += '<br><span class="help-meta">' + rangeBit + '默认：' + escapeHtml(formatDefaultValue(entry)) + '</span>';
        html += '</div>';
      }
      if (staticHelp && staticHelp[gName]) {
        for (var si = 0; si < staticHelp[gName].length; si++) {
          var sh = staticHelp[gName][si];
          html += '<div class="' + itemCls + '"><b>' + escapeHtml(sh.label) + '</b> — ' + escapeHtml(sh.desc) + '</div>';
        }
      }
      html += variant === 'floating' ? '</div>' : '';
    }

    if (staticHelp) {
      for (var sName in staticHelp) {
        if (!Object.prototype.hasOwnProperty.call(staticHelp, sName) || groups[sName]) continue;
        html += variant === 'floating' ? '<div class="' + sectionCls + '">' : '';
        html += '<div class="' + catCls + '">' + escapeHtml(sName) + '</div>';
        for (var sj = 0; sj < staticHelp[sName].length; sj++) {
          var sItem = staticHelp[sName][sj];
          html += '<div class="' + itemCls + '"><b>' + escapeHtml(sItem.label) + '</b> — ' + escapeHtml(sItem.desc) + '</div>';
        }
        html += variant === 'floating' ? '</div>' : '';
      }
    }

    return html;
  }

  var ATPSettingsUI = {
    ORDINARY_PRESETS: ORDINARY_PRESETS,
    escapeHtml: escapeHtml,
    formatDefaultValue: formatDefaultValue,
    getApplyMode: getApplyMode,
    getApplyModeLabel: getApplyModeLabel,
    buildTooltipText: buildTooltipText,
    renderTooltipBadge: renderTooltipBadge,
    isFieldEnabled: isFieldEnabled,
    isValueDefault: isValueDefault,
    detectActivePreset: detectActivePreset,
    getPresetToast: getPresetToast,
    renderPresetBar: renderPresetBar,
    renderPresetCards: renderPresetCards,
    syncPresetButtons: syncPresetButtons,
    syncResetButtonState: syncResetButtonState,
    renderFieldRow: renderFieldRow,
    renderSettingsGroup: renderSettingsGroup,
    renderSettingsGroups: renderSettingsGroups,
    buildHelpHtml: buildHelpHtml
  };

  globalThis.ATPSettingsUI = ATPSettingsUI;
})();
