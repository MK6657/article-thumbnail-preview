(function () {
  'use strict';

  var MIRROR_SITES_KEY = SharedUtils.MIRROR_SITES_STORAGE_KEY;

  // The worker stores the approved mirror list; this page is itself a
  // supported site (the scripts only run there), so register it even if the
  // stored list is missing or older than the grant that injected us.
  function applyMirrorSites(stored) {
    SharedUtils.setMirrorSites(stored && Array.isArray(stored.sites) ? stored.sites : []);
    SharedUtils.ensureCurrentForumSite(location.hostname);
  }

  var ATPConfig = {
    settings: null,
    loaded: false,

    getSettings: function() {
      return new Promise(function(resolve) {
        chrome.storage.local.get(['settings', MIRROR_SITES_KEY], function(result) {
          if (chrome.runtime.lastError) {
            console.warn('[config] 设置读取失败，已安全停用:', chrome.runtime.lastError.message);
            applyMirrorSites(null);
            ATPConfig.settings = ATPNormalizeSettings({ enabled: false });
            if (!window.ATPState) window.ATPState = {};
            window.ATPState.settings = ATPConfig.settings;
            ATPConfig.loaded = true;
            resolve(ATPConfig.settings);
            return;
          }
          applyMirrorSites(result && result[MIRROR_SITES_KEY]);
          ATPConfig.settings = ATPNormalizeSettings(result.settings);
          if (!window.ATPState) window.ATPState = {};
          window.ATPState.settings = ATPConfig.settings;
          ATPConfig.loaded = true;
          resolve(ATPConfig.settings);
        });
      });
    },

    getSiteKey: function() {
      return location.hostname.replace(/\.$/, '').replace(/^www\./, '');
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
