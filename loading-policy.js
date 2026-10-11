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

    // Offscreen first rows share the ordinary pool with visible images. The
    // visible reserve must hold inside that pool, not only in the global
    // total, or offscreen loads can take every ordinary slot (3 of 3 with
    // defaults). Capped at 3 lanes; at least 1 so offscreen work progresses.
    getOffscreenFirstRowOrdinaryLimit: function(settings) {
      var pool = positiveInteger(settings, 'firstScreenConcurrency', 3);
      var reserve = Math.min(pool - 1, ATPLoadPolicy.getViewportPriorityReservedSlots(settings));
      return Math.max(1, Math.min(3, pool - Math.max(0, reserve)));
    },

    // Heavy slots keep one for visible heavy threads the same way.
    getOffscreenFirstRowHeavyLimit: function(settings) {
      return Math.max(1, positiveInteger(settings, 'heavyImageConcurrency', 2) - 1);
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

    // 动图（几 MB 起）在限流的单独通道里下载，给更长的单次超时和任务截止，
    // 免得下载到一大半就被判失败、字节白费。无任务截止时仍不设截止。
    getLargeImageTimeout: function(settings) {
      var base = nonNegativeInteger(settings, 'imageTimeout', 15000) || 15000;
      return Math.max(base * 3, 30000);
    },

    getLargeImageTaskDeadline: function(settings) {
      var base = nonNegativeInteger(settings, 'imageTaskDeadline', 0);
      return base > 0 ? Math.max(base * 3, 45000) : 0;
    },

    // 同一普通图床同时下载动图的起始宽度；之后按动图实际完成速度自适应放宽或收窄。
    getLargeImageHostConcurrency: function() {
      return 2;
    },

    // 动图在此时间内完成算“快”，动图通道可放宽一条；超过“慢”阈值或超时则减半。
    getLargeImageFastMs: function(settings) {
      var base = nonNegativeInteger(settings, 'imageTimeout', 15000) || 15000;
      return Math.max(2000, Math.min(5000, Math.round(base * 0.4)));
    },

    getLargeImageSlowMs: function(settings) {
      var base = nonNegativeInteger(settings, 'imageTimeout', 15000) || 15000;
      return Math.max(6000, Math.min(15000, base));
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
        largeImageTimeout: ATPLoadPolicy.getLargeImageTimeout(settings),
        largeImageTaskDeadline: ATPLoadPolicy.getLargeImageTaskDeadline(settings),
        largeImageHostConcurrency: ATPLoadPolicy.getLargeImageHostConcurrency(settings),
        largeImageFastMs: ATPLoadPolicy.getLargeImageFastMs(settings),
        largeImageSlowMs: ATPLoadPolicy.getLargeImageSlowMs(settings),
        heavyDecodedBudgetMP: ATPLoadPolicy.getHeavyDecodedBudgetMP(settings),
        heavyVisibleBudgetMP: ATPLoadPolicy.getHeavyVisibleBudgetMP(settings),
        heavyDecodedImageLimit: ATPLoadPolicy.getHeavyDecodedImageLimit(settings),
        heavyLightweightPreviewEdge: ATPLoadPolicy.getHeavyLightweightPreviewEdge(settings)
      };
    }
  };

  globalThis.ATPLoadPolicy = ATPLoadPolicy;
})();
