(function () {
  'use strict';

  function defaultValue(key, fallback) {
    return typeof ATP_DEFAULTS !== 'undefined' && ATP_DEFAULTS[key] !== undefined
      ? ATP_DEFAULTS[key]
      : fallback;
  }

  function numberValue(settings, key, fallback) {
    var value = Number(settings && settings[key]);
    if (!isFinite(value)) value = Number(defaultValue(key, fallback));
    return isFinite(value) ? value : Number(fallback) || 0;
  }

  function integerValue(settings, key, fallback) {
    return Math.floor(numberValue(settings, key, fallback));
  }

  function positiveInteger(settings, key, fallback) {
    return Math.max(1, integerValue(settings, key, fallback));
  }

  function nonNegativeInteger(settings, key, fallback) {
    return Math.max(0, integerValue(settings, key, fallback));
  }

  function getBackgroundPresetDelay(settings) {
    var speed = settings && settings.backgroundSpeed || defaultValue('backgroundSpeed', 'normal');
    if (speed === 'extreme') return 20;
    if (speed === 'veryfast') return 50;
    if (speed === 'fast') return 100;
    if (speed === 'slow') return 800;
    return 300;
  }

  var ATPLoadPolicy = {
    getArticleFetchConcurrency: function(settings) {
      return positiveInteger(settings, 'articleFetchConcurrency', 3);
    },

    getArticleQueueHighWatermark: function(settings) {
      return positiveInteger(settings, 'articleQueueHighWatermark', 5);
    },

    getArticleTimeout: function(settings) {
      return positiveInteger(settings, 'articleTimeout', 15000);
    },

    getArticlePrefetchDistance: function(settings) {
      return nonNegativeInteger(settings, 'articlePrefetchDistance', 2000);
    },

    getArticleCommitBatchSize: function(settings) {
      return positiveInteger(settings, 'articleCommitBatchSize', 2);
    },

    getOrdinaryHostConcurrency: function(settings) {
      return positiveInteger(settings, 'ordinaryHostConcurrency', 6);
    },

    isOrdinaryHostAdaptive: function(settings) {
      return !settings || settings.ordinaryHostAdaptive !== false;
    },

    getOrdinaryHostSoftLimit: function(settings) {
      return Math.min(
        ATPLoadPolicy.getOrdinaryHostConcurrency(settings),
        positiveInteger(settings, 'ordinaryHostSoftLimit', 2)
      );
    },

    getOrdinaryHostHardLimit: function(settings) {
      // 硬限制对应更严重的失败压力，不允许配置反转成比软限制更宽
      return Math.min(
        ATPLoadPolicy.getOrdinaryHostSoftLimit(settings),
        positiveInteger(settings, 'ordinaryHostHardLimit', 1)
      );
    },

    getOrdinaryHostSoftFailures: function(settings) {
      return positiveInteger(settings, 'ordinaryHostSoftFailures', 3);
    },

    getOrdinaryHostHardFailures: function(settings) {
      return positiveInteger(settings, 'ordinaryHostHardFailures', 6);
    },

    getOrdinaryHostCooldown: function(settings) {
      return nonNegativeInteger(settings, 'ordinaryHostCooldownMs', 30000);
    },

    getOrdinaryHostRecoverySuccesses: function(settings) {
      return positiveInteger(settings, 'ordinaryHostRecoverySuccesses', 3);
    },

    getGlobalImageConcurrency: function(settings, ordinaryLimit, heavyLimit) {
      var configured = nonNegativeInteger(settings, 'globalImageConcurrency', 0);
      if (configured > 0) return configured;
      return Math.max(1, Number(ordinaryLimit) || 1) + Math.max(0, Number(heavyLimit) || 0);
    },

    getViewportPendingLimit: function(settings, backgroundLimit) {
      var configured = nonNegativeInteger(settings, 'viewportPendingLimit', 0);
      if (configured > 0) return configured;
      var cols = positiveInteger(settings, 'gridCols', 5);
      var rows = positiveInteger(settings, 'visibleRows', 2);
      return Math.max(1, (Number(backgroundLimit) || 1) * 8, cols * rows * 3, 24);
    },

    getBackgroundDelay: function(settings) {
      var custom = integerValue(settings, 'backgroundDelayMs', -1);
      return custom >= 0 ? custom : getBackgroundPresetDelay(settings);
    },

    getHeavySchedulingMode: function(settings) {
      return settings && settings.heavySchedulingMode === 'fixed' ? 'fixed' : 'adaptive';
    },

    isHeavyCircuitBreakerEnabled: function(settings) {
      return !settings || settings.heavyCircuitBreaker !== false;
    },

    getHeavyConcurrencyCeiling: function(settings) {
      return positiveInteger(settings, 'heavyImageConcurrency', 2);
    },

    getHeavyWarmupConcurrency: function(settings) {
      return Math.min(
        ATPLoadPolicy.getHeavyConcurrencyCeiling(settings),
        positiveInteger(settings, 'heavyWarmupConcurrency', 2)
      );
    },

    getHeavyProbeConcurrency: function(settings) {
      return Math.min(
        ATPLoadPolicy.getHeavyConcurrencyCeiling(settings),
        positiveInteger(settings, 'heavyProbeConcurrency', 1)
      );
    },

    getOrdinaryReservedSlots: function(settings) {
      return nonNegativeInteger(settings, 'ordinaryReservedSlots', 2);
    },

    getViewportPriorityReservedSlots: function(settings) {
      return nonNegativeInteger(settings, 'viewportPriorityReservedSlots', 2);
    },

    getOrdinaryFallbackLimit: function(settings) {
      return nonNegativeInteger(settings, 'ordinaryFallbackLimit', 2);
    },

    getHeavyImageTimeout: function(settings) {
      var configured = nonNegativeInteger(settings, 'heavyImageTimeout', 0);
      return configured > 0 ? configured : positiveInteger(settings, 'imageTimeout', 15000);
    },

    getHeavyFailureThreshold: function(settings) {
      return positiveInteger(settings, 'heavyFailureThreshold', 6);
    },

    getHeavyFailureWindow: function(settings) {
      return positiveInteger(settings, 'heavyFailureWindowMs', 60000);
    },

    getHeavyCooldownBase: function(settings) {
      return nonNegativeInteger(settings, 'heavyCooldownBaseMs', 20000);
    },

    getHeavyCooldownMax: function(settings) {
      return Math.max(
        ATPLoadPolicy.getHeavyCooldownBase(settings),
        nonNegativeInteger(settings, 'heavyCooldownMaxMs', 60000)
      );
    },

    getHeavyRampSuccesses: function(settings) {
      return positiveInteger(settings, 'heavyRampSuccesses', 2);
    },

    getHeavyRecoverySuccesses: function(settings) {
      return positiveInteger(settings, 'heavyRecoverySuccesses', 2);
    },

    getHeavyFallbackLimit: function(settings) {
      return nonNegativeInteger(settings, 'heavyFallbackLimit', 2);
    },

    getImageTaskDeadline: function(settings) {
      return nonNegativeInteger(settings, 'imageTaskDeadline', 0);
    },

    getHeavyDecodedBudgetMP: function(settings) {
      return nonNegativeInteger(settings, 'heavyDecodedBudgetMP', 160);
    },

    getHeavyVisibleBudgetMP: function(settings) {
      return nonNegativeInteger(settings, 'heavyVisibleBudgetMP', 180);
    },

    getHeavyDecodedImageLimit: function(settings) {
      return nonNegativeInteger(settings, 'heavyDecodedImageLimit', 8);
    },

    getHeavyLightweightPreviewEdge: function(settings) {
      return positiveInteger(settings, 'heavyLightweightPreviewEdge', 160);
    },

    getPublicSnapshot: function(settings) {
      var ordinary = positiveInteger(settings, 'firstScreenConcurrency', 3);
      var heavy = ATPLoadPolicy.getHeavyConcurrencyCeiling(settings);
      var globalConfigured = nonNegativeInteger(settings, 'globalImageConcurrency', 0);
      var globalEffective = ATPLoadPolicy.getGlobalImageConcurrency(settings, ordinary, heavy);
      return {
        articleFetchConcurrency: ATPLoadPolicy.getArticleFetchConcurrency(settings),
        articleQueueHighWatermark: ATPLoadPolicy.getArticleQueueHighWatermark(settings),
        articleTimeout: ATPLoadPolicy.getArticleTimeout(settings),
        articlePrefetchDistance: ATPLoadPolicy.getArticlePrefetchDistance(settings),
        articleCommitBatchSize: ATPLoadPolicy.getArticleCommitBatchSize(settings),
        ordinaryHostConcurrency: ATPLoadPolicy.getOrdinaryHostConcurrency(settings),
        ordinaryHostAdaptive: ATPLoadPolicy.isOrdinaryHostAdaptive(settings),
        globalImageConcurrencyConfigured: globalConfigured,
        globalImageConcurrency: globalEffective,
        backgroundDelayMs: ATPLoadPolicy.getBackgroundDelay(settings),
        viewportPendingLimit: ATPLoadPolicy.getViewportPendingLimit(settings, positiveInteger(settings, 'backgroundConcurrency', 1)),
        heavySchedulingMode: ATPLoadPolicy.getHeavySchedulingMode(settings),
        heavyCircuitBreaker: ATPLoadPolicy.isHeavyCircuitBreakerEnabled(settings),
        heavyConcurrencyCeiling: heavy,
        heavyWarmupConcurrency: ATPLoadPolicy.getHeavyWarmupConcurrency(settings),
        heavyProbeConcurrency: ATPLoadPolicy.getHeavyProbeConcurrency(settings),
        ordinaryReservedSlots: ATPLoadPolicy.getOrdinaryReservedSlots(settings),
        viewportPriorityReservedSlots: ATPLoadPolicy.getViewportPriorityReservedSlots(settings),
        ordinaryFallbackLimit: ATPLoadPolicy.getOrdinaryFallbackLimit(settings),
        heavyImageTimeout: ATPLoadPolicy.getHeavyImageTimeout(settings),
        heavyFallbackLimit: ATPLoadPolicy.getHeavyFallbackLimit(settings),
        imageTaskDeadline: ATPLoadPolicy.getImageTaskDeadline(settings),
        heavyDecodedBudgetMP: ATPLoadPolicy.getHeavyDecodedBudgetMP(settings),
        heavyVisibleBudgetMP: ATPLoadPolicy.getHeavyVisibleBudgetMP(settings),
        heavyDecodedImageLimit: ATPLoadPolicy.getHeavyDecodedImageLimit(settings),
        heavyLightweightPreviewEdge: ATPLoadPolicy.getHeavyLightweightPreviewEdge(settings)
      };
    }
  };

  globalThis.ATPLoadPolicy = ATPLoadPolicy;
})();
