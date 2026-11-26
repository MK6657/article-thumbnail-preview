(function () {
  'use strict';

  var MIRROR_SITES_KEY = SharedUtils.MIRROR_SITES_STORAGE_KEY;
  var SERVER_WAIT_STORAGE_KEY = 'atp_forum_server_wait_v1';
  var PACER_RESET_STORAGE_KEY = 'atp_forum_pacer_reset_at';
  var inFlightSettingsPromise = null;

  // The worker stores the approved mirror list; this page is itself a
  // supported site (the scripts only run there), so register it even if the
  // stored list is missing or older than the grant that injected us.
  function applyMirrorSites(stored) {
    SharedUtils.setMirrorSites(stored && Array.isArray(stored.sites) ? stored.sites : []);
    SharedUtils.ensureCurrentForumSite(location.hostname);
  }

  function hydrateForumPacer(serverWait, resetAt) {
    if (window.ATPForumPacer && typeof window.ATPForumPacer.hydrateInitialServerWait === 'function') {
      window.ATPForumPacer.hydrateInitialServerWait(serverWait, resetAt);
    }
  }

  var ATPConfig = {
    settings: null,
    loaded: false,
    _hydratesForumPacer: true,

    getSettings: function() {
      if (inFlightSettingsPromise) return inFlightSettingsPromise;
      inFlightSettingsPromise = new Promise(function(resolve) {
        chrome.storage.local.get(['settings', MIRROR_SITES_KEY, SERVER_WAIT_STORAGE_KEY, PACER_RESET_STORAGE_KEY], function(result) {
          inFlightSettingsPromise = null;
          if (chrome.runtime.lastError) {
            console.warn('[config] 设置读取失败，已安全停用:', chrome.runtime.lastError.message);
            applyMirrorSites(null);
            hydrateForumPacer(null, undefined);
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
          hydrateForumPacer(result && result[SERVER_WAIT_STORAGE_KEY], result && result[PACER_RESET_STORAGE_KEY]);
          resolve(ATPConfig.settings);
        });
      });
      return inFlightSettingsPromise;
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
