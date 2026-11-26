(function () {
  'use strict';

  // sessionStorage follows the native navigation in this tab and origin.
  var ATTEMPT_KEY = 'atp_age_entry_attempt_v1';
  var ATTEMPT_TTL = 60000;
  var FORUM_MARKERS = '#threadlist, #postlist, #wp #ct, #hd #nv';
  var CHALLENGE_MARKERS = '#challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, .g-recaptcha, .h-captcha, iframe[src*="challenges.cloudflare.com"], iframe[src*="/recaptcha/"], iframe[src*="hcaptcha.com/"]';
  var navigationStarted = false;
  var observer = null;
  var watchTimer = null;

  function isEntryDocument() {
    if (!SharedUtils.isForumAgeGateTitle(document.title)) return false;
    var brand = document.querySelector('body > .domain');
    var warning = document.querySelector('.down-content h3');
    return !!(brand && brand.textContent.trim().toLowerCase() === document.title.trim().toLowerCase() &&
      warning && /^警告\s*\/\s*warning$/i.test(warning.textContent.trim()) &&
      !document.querySelector(FORUM_MARKERS + ', form, ' + CHALLENGE_MARKERS));
  }

  function isVisibleEntry(link) {
    if (link.closest('[inert], [hidden], [aria-hidden="true"], [aria-disabled="true"]')) return false;
    if (link.checkVisibility && !link.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    var box = link.getBoundingClientRect();
    var style = getComputedStyle(link);
    return box.width > 0 && box.height > 0 && style.pointerEvents !== 'none' &&
      style.visibility === 'visible' && style.opacity !== '0';
  }

  function getEntryLink() {
    var links = document.querySelectorAll('body > a.enter-btn[href]');
    if (links.length !== 2) return null;
    var base = document.querySelector('base[target]');
    var chinese = null;
    var english = null;
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var target = link.target || (base && base.target) || '_self';
      if (link.href !== location.origin + '/' || target.toLowerCase() !== '_self' || link.hasAttribute('download') || !isVisibleEntry(link)) return null;
      if (SharedUtils.isForumAgeGateLabel(link.textContent, 'zh')) chinese = link;
      if (SharedUtils.isForumAgeGateLabel(link.textContent, 'en')) english = link;
    }
    return english && chinese;
  }

  // Only read-only Discuz routes can be resumed. The stored value is a path,
  // and is validated again on the destination before it can navigate a tab.
  function getReadPath(path) {
    if (typeof path !== 'string' || path.length > 512 || path.charAt(0) !== '/') return '';
    var url = new URL(path, location.origin);
    if (url.href !== location.origin + path) return '';
    var query = '';
    if (url.pathname === '/forum.php') {
      var mode = url.searchParams.get('mod');
      var id = mode === 'forumdisplay' ? 'fid' : mode === 'viewthread' ? 'tid' : '';
      if (!id || url.searchParams.getAll('mod').length !== 1 || url.searchParams.getAll(id).length !== 1) return '';
      var number = url.searchParams.get(id);
      var page = url.searchParams.get('page');
      if (!/^\d+$/.test(number) || (page !== null && (url.searchParams.getAll('page').length !== 1 || !/^\d+$/.test(page)))) return '';
      // Rebuild the read route so unrelated context or actions are dropped.
      query = '?mod=' + mode + '&' + id + '=' + number + (page === null ? '' : '&page=' + page);
      if (mode === 'forumdisplay' && url.searchParams.getAll('filter').length === 1) {
        var filter = url.searchParams.get('filter');
        if ((filter === 'typeid' || filter === 'sortid') && url.searchParams.getAll(filter).length === 1) {
          var filterId = url.searchParams.get(filter);
          if (/^\d+$/.test(filterId)) query += '&filter=' + filter + '&' + filter + '=' + filterId;
        }
      }
    } else if (!/^\/(?:forum-\d+-\d+|thread-\d+-\d+-\d+)\.html$/.test(url.pathname)) {
      return '';
    }
    return url.pathname + query + (/^#(?:pid\d+|post_\d+|lastpost)$/i.test(url.hash) ? url.hash : '');
  }

  function readAttempt() {
    var value = sessionStorage.getItem(ATTEMPT_KEY);
    if (!value) return null;
    var record;
    try { record = value.length <= 1024 && JSON.parse(value); } catch (e) {}
    var age = record && Date.now() - record.at;
    if (record && Number.isFinite(record.at) && age >= 0 && age < ATTEMPT_TTL && typeof record.path === 'string') return record;
    sessionStorage.removeItem(ATTEMPT_KEY);
    return null;
  }

  function stopWatching() {
    if (observer) observer.disconnect();
    if (watchTimer !== null) clearTimeout(watchTimer);
    observer = null;
    watchTimer = null;
  }

  function waitForEntryLink() {
    if (observer) return;
    // Only this small, branded entry document can install the observer.
    observer = new MutationObserver(function() {
      if (!ATPConfig.isEnabled() || !ATPConfig.settings.autoEnterAgeGate || !handlePage(true)) stopWatching();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['href', 'class', 'style', 'hidden', 'inert', 'aria-hidden', 'aria-disabled'] });
    watchTimer = setTimeout(stopWatching, 5000);
  }

  function cancel() {
    stopWatching();
    try { sessionStorage.removeItem(ATTEMPT_KEY); } catch (e) {}
  }

  // True while this document is serving the entry or navigating away. The
  // list scanner then starts only on the final, ordinary forum page.
  function handlePage(enabled) {
    if (window !== window.top || location.protocol !== 'https:' || !SharedUtils.isSupportedForumHost(location.hostname)) return false;
    var gate = isEntryDocument();
    if (!enabled) {
      cancel();
      return gate;
    }
    if (navigationStarted) return true;
    try {
      var attempt = readAttempt();
      if (!gate && !attempt) return false;
      var navigation = performance.getEntriesByType('navigation')[0];
      if (navigation && navigation.responseStatus >= 400) return true;
      if (navigation && navigation.type === 'back_forward') {
        if (gate) stopWatching();
        else cancel();
        return gate;
      }
      if (gate) {
        if (attempt) return true;
        var link = getEntryLink();
        if (!link) {
          waitForEntryLink();
          return true;
        }
        stopWatching();
        var notice = (document.body.textContent || '').slice(0, 8192);
        if (SharedUtils.isForumRateLimitText(notice) || SharedUtils.hasForumVerificationMarkers('', notice)) return true;
        var path = getReadPath(location.pathname + location.search + location.hash);
        sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ at: Date.now(), path: path }));
        navigationStarted = true;
        Logger.info('论坛入口', '点击本站年龄声明入口');
        link.click();
        return true;
      }
      if (document.querySelector(CHALLENGE_MARKERS)) return true;
      if (!document.querySelector(FORUM_MARKERS)) return false;
      var target = getReadPath(attempt.path);
      if (target && (location.pathname === '/' || location.pathname === '/forum.php') && !location.search && !location.hash) {
        // Discuz also wraps maintenance, permission and frequency notices in
        // its normal home layout, sometimes with an HTTP 200 response.
        if (document.querySelector('#messagetext, #main_message, .showmessage, .alert_error, .alert_info')) return true;
        // Consume the destination first; retain the timestamp in case the
        // original URL immediately serves the entry page again.
        sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ at: attempt.at, path: '' }));
        navigationStarted = true;
        Logger.info('论坛入口', '返回原版块或帖子');
        location.replace(target);
        return true;
      }
      cancel();
    } catch (e) {
      // Without a working per-tab guard, leave the site's button usable.
      Logger.debug('论坛入口', '此页保留手动操作');
    }
    return gate;
  }

  window.ATPForumEntry = { handlePage: handlePage, cancel: cancel, stopWatching: stopWatching };
})();
