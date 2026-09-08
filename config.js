(function () {
  'use strict';

  const ATPConfig = {
    settings: null,
    loaded: false,

    getSettings: function() {
      return new Promise(function(resolve) {
        chrome.storage.local.get('settings', function(result) {
          if (chrome.runtime.lastError) {
            console.warn('[config] 设置读取失败，已安全停用:', chrome.runtime.lastError.message);
            ATPConfig.settings = ATPNormalizeSettings({ enabled: false });
            if (!window.ATPState) window.ATPState = {};
            window.ATPState.settings = ATPConfig.settings;
            ATPConfig.loaded = true;
            resolve(ATPConfig.settings);
            return;
          }
          ATPConfig.settings = ATPNormalizeSettings(result.settings);
          if (!window.ATPState) window.ATPState = {};
          window.ATPState.settings = ATPConfig.settings;
          ATPConfig.loaded = true;
          resolve(ATPConfig.settings);
        });
      });
    },

    getSiteKey: function() {
      return location.hostname.replace(/^www\./, '');
    },

    isEnabled: function() {
      if (!ATPConfig.loaded) return false;
      if (!ATPConfig.settings.enabled) return false;
      var sc = (ATPConfig.settings.siteConfigs || {})[ATPConfig.getSiteKey()];
      return !(sc && sc.disabled);
    }
  };

  window.ATPConfig = ATPConfig;
})();
