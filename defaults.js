(function () {
  'use strict';

  var FALLBACK_DEFAULTS = {
    enabled: true,
    siteConfigs: {},
    gridCols: 5,
    visibleRows: 2,
    showFloatingLauncher: true,
    showResourcePanel: true,
    copyPasswordsWithLinks: true,
    autoEnterAgeGate: true,
    thumbWidth: 110,
    thumbHeight: 82,
    gridGap: 6,
    animatedThumbnailMode: 'still',
    maxImagesPerPost: 100,
    maxDisplayPerPost: 100,
    autoLoadOffscreenFirstRowsEnabled: false,
    firstScreenConcurrency: 8,
    viewportPriorityReservedSlots: 4,
    backgroundConcurrency: 2,
    backgroundSpeed: 'fast',
    imageTimeout: 12000,
    pauseWhenHidden: true,
    skipServiceThreads: true,
    heavyImageOptimization: true,
    heavyImageConcurrency: 3,
    heavyThumbnailClarity: 'balanced',
    heavyPreviewStarvationWait: 3,
    heavyPreviewStarvationMP: 820,
    heavyRestoreFastBatchSize: 2,
    heavyRestorePressureBatchSize: 1,
    maxRetryPerImage: 0,
    cacheTTL: 30,
    debugLogging: false,
    articleFetchConcurrency: 4,
    articleQueueHighWatermark: 8,
    articleTimeout: 15000,
    articlePrefetchDistance: 2000,
    articleCommitBatchSize: 2,
    globalImageConcurrency: 0,
    ordinaryHostConcurrency: 8,
    ordinaryHostAdaptive: true,
    ordinaryHostSoftLimit: 2,
    ordinaryHostHardLimit: 1,
    ordinaryHostSoftFailures: 3,
    ordinaryHostHardFailures: 6,
    ordinaryHostCooldownMs: 30000,
    ordinaryHostRecoverySuccesses: 3,
    viewportPendingLimit: 0,
    backgroundDelayMs: -1,
    heavySchedulingMode: 'adaptive',
    heavyCircuitBreaker: true,
    heavyWarmupConcurrency: 2,
    heavyProbeConcurrency: 1,
    ordinaryReservedSlots: 2,
    ordinaryFallbackLimit: 2,
    heavyImageTimeout: 0,
    heavyFailureThreshold: 6,
    heavyFailureWindowMs: 60000,
    heavyCooldownBaseMs: 20000,
    heavyCooldownMaxMs: 60000,
    heavyRampSuccesses: 2,
    heavyRecoverySuccesses: 2,
    heavyFallbackLimit: 2,
    imageTaskDeadline: 20000,
    heavyDecodedBudgetMP: 160,
    heavyVisibleBudgetMP: 180,
    heavyDecodedImageLimit: 8,
    heavyLightweightPreviewEdge: 160
  };

  function getDefaultsFromSchema(schema) {
    const d = {};
    schema.forEach(function(item) {
      if (item && item.key) d[item.key] = item.default;
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

  const hasSchema = typeof SETTINGS_SCHEMA !== 'undefined' && Array.isArray(SETTINGS_SCHEMA) && SETTINGS_SCHEMA.length > 0;
  const ATP_DEFAULTS = Object.assign(
    hasSchema ? { enabled: true, siteConfigs: {} } : Object.assign({}, FALLBACK_DEFAULTS, { siteConfigs: {} }),
    hasSchema ? getDefaultsFromSchema(SETTINGS_SCHEMA) : {}
  );

  function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const settings = Object.assign({}, ATP_DEFAULTS);
    const schema = typeof SETTINGS_SCHEMA !== 'undefined' && Array.isArray(SETTINGS_SCHEMA) ? SETTINGS_SCHEMA : [];

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
