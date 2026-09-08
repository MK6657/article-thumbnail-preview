(function () {
  'use strict';

  function getDefaultsFromSchema(schema) {
    const d = {};
    schema.forEach(function(item) {
      d[item.key] = item.default;
    });
    return d;
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

  function normalizeBoolean(value, fallback) {
    if (value === false || value === 'false' || value === 0) return false;
    if (value === true || value === 'true' || value === 1) return true;
    return fallback;
  }

  function normalizeSiteConfigs(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const host in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, host) || !isValidSiteConfigHost(host)) continue;
      const siteConfig = raw[host];
      if (!siteConfig || typeof siteConfig !== 'object' || Array.isArray(siteConfig)) continue;
      if (!Object.prototype.hasOwnProperty.call(siteConfig, 'disabled')) continue;
      out[host] = { disabled: normalizeBoolean(siteConfig.disabled, false) };
    }
    return out;
  }

  const ATP_DEFAULTS = Object.assign(
    { enabled: true, siteConfigs: {} },
    typeof SETTINGS_SCHEMA !== 'undefined' ? getDefaultsFromSchema(SETTINGS_SCHEMA) : {}
  );

  function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const settings = Object.assign({}, ATP_DEFAULTS);
    const schema = typeof SETTINGS_SCHEMA !== 'undefined' ? SETTINGS_SCHEMA : [];

    settings.enabled = normalizeBoolean(source.enabled, ATP_DEFAULTS.enabled);
    settings.siteConfigs = normalizeSiteConfigs(source.siteConfigs);

    schema.forEach(function(item) {
      var value = Object.prototype.hasOwnProperty.call(source, item.key) ? source[item.key] : ATP_DEFAULTS[item.key];
      if (item.type === 'boolean') {
        if (value === false || value === 'false' || value === 0) {
          settings[item.key] = false;
        } else if (value === true || value === 'true' || value === 1) {
          settings[item.key] = true;
        } else {
          settings[item.key] = item.default;
        }
        return;
      }
      if (item.type === 'number') {
        var num = parseInt(value, 10);
        if (isNaN(num)) num = item.default;
        if (item.min !== undefined && num < item.min) num = item.min;
        if (item.max !== undefined && num > item.max) num = item.max;
        settings[item.key] = num;
        return;
      }
      if (item.type === 'select') {
        var options = item.options || [];
        if (item.key === 'heavyThumbnailClarity' && value === 'blurred') {
          value = 'lightweight';
        }
        var allowed = options.some(function(option) {
          return option.value === value;
        });
        settings[item.key] = allowed ? value : item.default;
      }
    });

    return settings;
  }

  globalThis.ATP_DEFAULTS = ATP_DEFAULTS;
  globalThis.ATPNormalizeSettings = normalizeSettings;
})();
