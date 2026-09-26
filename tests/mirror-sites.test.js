'use strict';

// Forum mirror / reverse-proxy ("sub-proxy") support: the shared site
// registry, the background permission-to-content-script sync, the cross-site
// zone boundary, and the popup add/remove flow.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const MIRROR_ROOT = 'mirror.example';
const MIRROR_PATTERN = 'https://*.' + MIRROR_ROOT + '/*';
const MIRROR_PAGE = 'https://www.mirror.example/forum.php?mod=forumdisplay&fid=2';
const BUILTIN_PAGE = 'https://www.sehuatang.org/forum.php?mod=forumdisplay&fid=2';

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function loadShared() {
  const sandbox = { URL, TextEncoder, TextDecoder, console };
  vm.createContext(sandbox);
  vm.runInContext(read('shared-utils.js') + '\nthis.SharedUtils = SharedUtils;', sandbox, { filename: 'shared-utils.js' });
  return sandbox.SharedUtils;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function flush(rounds) {
  for (let i = 0; i < (rounds || 20); i++) await new Promise(function(resolve) { setImmediate(resolve); });
}

function htmlResponse(html, url) {
  const bytes = new TextEncoder().encode(html);
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: url,
    headers: {
      get: function(name) {
        name = String(name || '').toLowerCase();
        if (name === 'content-length') return String(bytes.byteLength);
        if (name === 'content-type') return 'text/html; charset=utf-8';
        return '';
      }
    },
    arrayBuffer: async function() { return bytes.buffer.slice(0); }
  };
}

function textResponse(text, url) {
  const response = htmlResponse(text, url);
  const get = response.headers.get;
  response.headers.get = function(name) {
    return String(name || '').toLowerCase() === 'content-type' ? 'text/plain; charset=utf-8' : get(name);
  };
  return response;
}

// ---- Shared site registry -------------------------------------------------

(function checkRegistry() {
  const shared = loadShared();

  const accepted = {
    'mirror.example': 'mirror.example',
    'WWW.Mirror.Example': 'mirror.example',
    'https://www.mirror.example/forum.php?mod=viewthread&tid=1#top': 'mirror.example',
    'mirror.example:8443': 'mirror.example',
    'https://bbs.mirror.example./': 'bbs.mirror.example',
    'https://例子.测试/': 'xn--fsqu00a.xn--0zwm56d'
  };
  Object.keys(accepted).forEach(function(input) {
    const parsed = shared.parseMirrorSiteInput(input);
    assert.strictEqual(parsed.ok, true, 'mirror input must be accepted: ' + input);
    assert.strictEqual(parsed.site.root, accepted[input], 'mirror root for ' + input);
    assert.strictEqual(parsed.site.pattern, 'https://*.' + accepted[input] + '/*', 'mirror pattern for ' + input);
    assert.strictEqual(parsed.site.subdomains, true);
  });

  const rejected = {
    '': 'empty',
    '   ': 'empty',
    'http://mirror.example/': 'not_https',
    'ftp://mirror.example/': 'not_https',
    'javascript:alert(1)': 'not_https',
    'https://user:pass@mirror.example/': 'invalid',
    'localhost': 'invalid',
    'app.localhost': 'reserved',
    '192.168.1.8': 'reserved',
    'https://[::1]/': 'reserved',
    'mirror': 'invalid',
    'bad_label.example': 'invalid',
    '-bad.example': 'invalid',
    'www.sehuatang.org': 'builtin',
    'sehuatang.net': 'builtin',
    'bbs.sehuatang.org': 'builtin',
    'dl.ldkms.la': 'reserved',
    'ldkms.la': 'reserved',
    'a.xia.ewrewej.la': 'reserved',
    'https://*.mirror.example/': 'invalid'
  };
  Object.keys(rejected).forEach(function(input) {
    const parsed = shared.parseMirrorSiteInput(input);
    assert.strictEqual(parsed.ok, false, 'mirror input must be rejected: ' + JSON.stringify(input));
    assert.strictEqual(parsed.reason, rejected[input], 'mirror rejection reason for ' + JSON.stringify(input));
  });

  assert.deepStrictEqual(plain(shared.getMirrorSiteFromPattern('https://*.mirror.example/*')),
    { root: 'mirror.example', pattern: 'https://*.mirror.example/*', subdomains: true });
  assert.deepStrictEqual(plain(shared.getMirrorSiteFromPattern('https://solo.example/*')),
    { root: 'solo.example', pattern: 'https://solo.example/*', subdomains: false });
  ['https://*/*', '<all_urls>', 'http://*.mirror.example/*', '*://*.mirror.example/*', 'https://*.sehuatang.org/*',
    'https://dl.ldkms.la/*', 'https://*.mirror.example/path/*', 'https://*.com/*', 42, null].forEach(function(pattern) {
    assert.strictEqual(shared.getMirrorSiteFromPattern(pattern), null, 'pattern must not become a mirror: ' + pattern);
  });

  const manyOrigins = MANIFEST.host_permissions.slice();
  for (let i = 30; i >= 1; i--) manyOrigins.push('https://*.m' + String(i).padStart(2, '0') + '.example/*');
  manyOrigins.push('https://*.m01.example/*', 'https://*/*');
  const fromOrigins = shared.getMirrorSitesFromOrigins(manyOrigins);
  assert.strictEqual(fromOrigins.length, shared.MIRROR_SITE_MAX_COUNT, 'mirror list must be capped');
  assert.strictEqual(fromOrigins[0].root, 'm01.example', 'mirror list must be sorted and deduplicated');
  assert.strictEqual(fromOrigins[19].root, 'm20.example', 'mirror cap must be deterministic');
  assert.deepStrictEqual(plain(shared.getMirrorSitesFromOrigins(MANIFEST.host_permissions)), [],
    'manifest host permissions must never be treated as mirrors');
  assert.deepStrictEqual(plain(shared.normalizeMirrorSites([{ root: 'Stored.Example', subdomains: true }, { root: 'x' }, 'junk'])),
    [{ root: 'stored.example', pattern: 'https://*.stored.example/*', subdomains: true }]);

  // Built-in behavior is unchanged without mirrors.
  assert.strictEqual(shared.isSupportedForumHost('www.sehuatang.org'), true);
  assert.strictEqual(shared.isSupportedForumHost('sehuatang.org.attacker.example'), false);
  assert.strictEqual(shared.isSupportedForumHost('www.mirror.example'), false);
  assert.strictEqual(shared.getForumSiteZone('www.sehuatang.net'), 'builtin');
  assert.strictEqual(shared.getForumSiteZone('www.mirror.example'), '');

  shared.setMirrorSites(['https://*.mirror.example/*', 'https://*.bbs.mirror.example/*', 'https://solo.example/*']);
  assert.strictEqual(shared.isSupportedForumHost('mirror.example'), true);
  assert.strictEqual(shared.isSupportedForumHost('www.MIRROR.example'), true);
  assert.strictEqual(shared.isSupportedForumHost('evilmirror.example'), false);
  assert.strictEqual(shared.isSupportedForumHost('mirror.example.attacker.example'), false);
  assert.strictEqual(shared.isSupportedForumHost('solo.example'), true);
  assert.strictEqual(shared.isSupportedForumHost('www.solo.example'), false, 'exact-host grants must not cover subdomains');
  assert.strictEqual(shared.getMirrorForumRoot('x.bbs.mirror.example'), 'mirror.example', 'broadest granted mirror must define the zone');
  assert.strictEqual(shared.getForumSiteZone('bbs.mirror.example'), 'mirror:mirror.example');
  assert.strictEqual(shared.isBuiltinForumHost('www.mirror.example'), false);
  assert.strictEqual(shared.isSameSupportedSiteHost('mirror.example', 'www.mirror.example'), true);
  assert.strictEqual(shared.isSameSupportedSiteHost('www.sehuatang.org', 'www.mirror.example'), false);
  assert.strictEqual(shared.isSameForumZoneUrl('https://www.mirror.example/thread-1-1-1.html', MIRROR_PAGE), true);
  assert.strictEqual(shared.isSameForumZoneUrl('https://www.sehuatang.org/thread-1-1-1.html', MIRROR_PAGE), false);
  assert.strictEqual(shared.isSameForumZoneUrl('https://www.sehuatang.net/thread-1-1-1.html', BUILTIN_PAGE), true,
    'built-in roots share one zone');
  assert.strictEqual(shared.isSameForumZoneUrl('http://www.mirror.example/thread-1-1-1.html', MIRROR_PAGE), false);
  assert.strictEqual(shared.getForumUrlZone('https://solo.example/thread-1-1-1.html'), 'mirror:solo.example');

  // TXT allowlist follows the registry and the requesting page's zone.
  assert.strictEqual(shared.isAllowedTextAttachmentUrl('https://www.mirror.example/forum.php?mod=attachment&aid=7'), true);
  assert.strictEqual(shared.isAllowedTextAttachmentUrl('https://www.mirror.example/data/a.txt'), true);
  assert.strictEqual(shared.isAllowedTextAttachmentUrl('https://www.mirror.example/admin.php?aid=7'), false);
  assert.strictEqual(shared.isAllowedTextAttachmentUrl('https://www.unknown.example/a.txt'), false);
  assert.strictEqual(shared.isAllowedTextAttachmentUrl('https://dl.ldkms.la/a.txt'), true);
  assert.strictEqual(shared.isAllowedTextAttachmentUrl('https://xia.ewrewej.la/download?id=1&sign=x'), true);
  assert.strictEqual(shared.isDiscuzAttachmentUrl('https://mirror.example/forum.php?mod=attachment&aid=1', MIRROR_PAGE), true);
  assert.strictEqual(shared.isDiscuzAttachmentUrl('https://www.sehuatang.org/forum.php?mod=attachment&aid=1', MIRROR_PAGE), false);
  const mirrorZone = shared.getForumUrlZone(MIRROR_PAGE);
  assert.strictEqual(shared.isTextAttachmentUrlAllowedInZone('https://www.mirror.example/forum.php?mod=attachment&aid=7', mirrorZone), true);
  assert.strictEqual(shared.isTextAttachmentUrlAllowedInZone('https://dl.ldkms.la/a.txt', mirrorZone), true, 'download relays serve every zone');
  assert.strictEqual(shared.isTextAttachmentUrlAllowedInZone('https://www.sehuatang.org/forum.php?mod=attachment&aid=7', mirrorZone), false,
    'a mirror page must not have built-in attachments fetched with that session');
  assert.strictEqual(shared.isTextAttachmentUrlAllowedInZone('https://www.mirror.example/forum.php?mod=attachment&aid=7', 'builtin'), false);

  shared.setMirrorSites([]);
  assert.strictEqual(shared.isSupportedForumHost('www.mirror.example'), false, 'clearing mirrors must revoke support');
  shared.ensureCurrentForumSite('www.pagehost.example');
  assert.strictEqual(shared.getForumSiteZone('pagehost.example'), 'mirror:pagehost.example',
    'content scripts must trust the page they run on while the stored list lags');
  shared.ensureCurrentForumSite('www.sehuatang.org');
  shared.ensureCurrentForumSite('127.0.0.1');
  assert.deepStrictEqual(plain(shared.getMirrorSites().map(function(site) { return site.root; })), ['pagehost.example']);
})();

// ---- Background: permissions -> registered content scripts -----------------

function loadBackground(options) {
  options = options || {};
  const storage = Object.assign({}, options.storage || {});
  const granted = (options.origins || []).slice();
  const registered = {};
  const scriptingCalls = [];
  const listeners = {};
  let deferGetAll = !!options.deferGetAll;
  let pendingGetAll = [];

  function addListenerSlot(name) {
    return { addListener: function(listener) { listeners[name] = listener; } };
  }

  const sandbox = {
    console: { log: function() {}, warn: function() {}, error: function() {} },
    URL, Intl, TextEncoder, TextDecoder, AbortController,
    setTimeout, clearTimeout,
    setInterval: function() { return 0; },
    clearInterval: function() {},
    fetch: async function() { throw new Error('unexpected fetch'); },
    chrome: {
      runtime: {
        lastError: null,
        id: 'atpextensionid',
        getManifest: function() { return JSON.parse(JSON.stringify(MANIFEST)); },
        getURL: function(file) { return 'chrome-extension://atpextensionid/' + file; },
        onMessage: addListenerSlot('message'),
        onInstalled: addListenerSlot('installed'),
        onStartup: addListenerSlot('startup')
      },
      permissions: {
        getAll: function(callback) {
          const respond = function() { callback({ permissions: ['storage', 'scripting', 'activeTab'], origins: granted.slice() }); };
          if (deferGetAll) pendingGetAll.push(respond);
          else respond();
        },
        onAdded: addListenerSlot('permissionAdded'),
        onRemoved: addListenerSlot('permissionRemoved')
      },
      scripting: {
        getRegisteredContentScripts: async function() {
          return Object.keys(registered).map(function(id) { return JSON.parse(JSON.stringify(registered[id])); });
        },
        registerContentScripts: async function(scripts) {
          scriptingCalls.push(['register', scripts.map(function(s) { return s.id; })]);
          scripts.forEach(function(script) {
            if (registered[script.id]) throw new Error('Duplicate script ID ' + script.id);
            registered[script.id] = JSON.parse(JSON.stringify(script));
          });
        },
        updateContentScripts: async function(scripts) {
          scriptingCalls.push(['update', scripts.map(function(s) { return s.id; })]);
          scripts.forEach(function(script) {
            if (!registered[script.id]) throw new Error('Missing script ID ' + script.id);
            registered[script.id] = JSON.parse(JSON.stringify(script));
          });
        },
        unregisterContentScripts: async function(filter) {
          scriptingCalls.push(['unregister', filter.ids.slice()]);
          filter.ids.forEach(function(id) { delete registered[id]; });
        }
      },
      storage: {
        onChanged: addListenerSlot('storageChanged'),
        local: {
          get: function(keys, callback) {
            const result = {};
            if (keys === null || keys === undefined) Object.assign(result, storage);
            else (Array.isArray(keys) ? keys : [keys]).forEach(function(key) {
              if (Object.prototype.hasOwnProperty.call(storage, key)) result[key] = storage[key];
            });
            callback(JSON.parse(JSON.stringify(result)));
          },
          set: function(items, callback) {
            Object.assign(storage, JSON.parse(JSON.stringify(items || {})));
            if (callback) callback();
          },
          remove: function(keys, callback) {
            (Array.isArray(keys) ? keys : [keys]).forEach(function(key) { delete storage[key]; });
            if (callback) callback();
          },
          getBytesInUse: function(keys, callback) { callback(JSON.stringify(storage).length); }
        }
      }
    }
  };
  vm.createContext(sandbox);
  sandbox.importScripts = function() {
    Array.prototype.slice.call(arguments).forEach(function(file) {
      vm.runInContext(read(file), sandbox, { filename: file });
    });
  };
  vm.runInContext(read('background.js') + '\nthis.SharedUtils = SharedUtils;', sandbox, { filename: 'background.js' });
  return {
    sandbox, storage, granted, registered, scriptingCalls, listeners,
    releaseGetAll: function() {
      deferGetAll = false;
      const pending = pendingGetAll;
      pendingGetAll = [];
      pending.forEach(function(respond) { respond(); });
    },
    send: function(message, sender) {
      return new Promise(function(resolve) {
        const keepOpen = listeners.message(message, sender, resolve);
        assert.strictEqual(keepOpen, true, 'background must keep async message channels open for ' + message.type);
      });
    }
  };
}

async function checkBackgroundRegistration() {
  const bg = loadBackground({ origins: MANIFEST.host_permissions.concat([MIRROR_PATTERN, 'https://*/*']) });
  await flush();

  ['permissionAdded', 'permissionRemoved', 'startup', 'installed', 'message'].forEach(function(name) {
    assert.strictEqual(typeof bg.listeners[name], 'function', 'background must register ' + name + ' at top level');
  });

  const ids = Object.keys(bg.registered).sort();
  assert.deepStrictEqual(ids, ['atp-mirror-0', 'atp-mirror-1'], 'one dynamic script per manifest content script entry');
  MANIFEST.content_scripts.forEach(function(script, index) {
    const actual = bg.registered['atp-mirror-' + index];
    assert.deepStrictEqual(actual.matches, [MIRROR_PATTERN], 'mirror scripts must only match granted mirror patterns');
    assert.deepStrictEqual(actual.js, script.js, 'mirror scripts must reuse the manifest script list and order');
    assert.deepStrictEqual(actual.css || [], script.css || []);
    assert.strictEqual(actual.runAt, script.run_at);
    assert.strictEqual(actual.world || 'ISOLATED', script.world || 'ISOLATED');
    assert.strictEqual(actual.allFrames, false);
    assert.strictEqual(actual.persistAcrossSessions, true);
  });
  const persisted = bg.storage[bg.sandbox.SharedUtils.MIRROR_SITES_STORAGE_KEY];
  assert.deepStrictEqual(persisted.sites, [{ root: MIRROR_ROOT, pattern: MIRROR_PATTERN, subdomains: true }],
    'background must persist the granted mirror list for content scripts');

  // A worker restart with an unchanged grant list must not rewrite registrations.
  const restarted = loadBackground({ origins: bg.granted, storage: bg.storage });
  Object.assign(restarted.registered, JSON.parse(JSON.stringify(bg.registered)));
  await flush();
  assert.deepStrictEqual(plain(restarted.scriptingCalls), [], 'unchanged mirrors must not re-register on every worker wake');

  // Browser start re-applies registrations even when unchanged.
  restarted.listeners.startup();
  await flush();
  assert.deepStrictEqual(plain(restarted.scriptingCalls), [['update', ['atp-mirror-0', 'atp-mirror-1']]]);

  // Adding a second mirror updates both entries in place.
  bg.granted.push('https://*.second.example/*');
  bg.scriptingCalls.length = 0;
  bg.listeners.permissionAdded({ origins: ['https://*.second.example/*'] });
  await flush();
  assert.deepStrictEqual(plain(bg.scriptingCalls), [['update', ['atp-mirror-0', 'atp-mirror-1']]]);
  assert.deepStrictEqual(bg.registered['atp-mirror-1'].matches, [MIRROR_PATTERN, 'https://*.second.example/*']);

  // Revoking every mirror (popup or chrome://extensions) unregisters the scripts.
  bg.granted.length = 0;
  Array.prototype.push.apply(bg.granted, MANIFEST.host_permissions);
  bg.scriptingCalls.length = 0;
  bg.listeners.permissionRemoved({ origins: [MIRROR_PATTERN, 'https://*.second.example/*'] });
  await flush();
  assert.deepStrictEqual(plain(bg.scriptingCalls), [['unregister', ['atp-mirror-0', 'atp-mirror-1']]]);
  assert.deepStrictEqual(plain(Object.keys(bg.registered)), []);
  assert.deepStrictEqual(bg.storage[bg.sandbox.SharedUtils.MIRROR_SITES_STORAGE_KEY].sites, []);
  assert.strictEqual(bg.sandbox.SharedUtils.isSupportedForumHost('www.mirror.example'), false);

  // Popup-triggered sync reports the live list and registration result.
  bg.granted.push(MIRROR_PATTERN);
  const sync = await bg.send({ type: 'MIRROR_SITES_SYNC' }, { url: 'chrome-extension://atpextensionid/popup.html' });
  assert.strictEqual(sync.ok, true);
  assert.strictEqual(sync.registered, true);
  assert.deepStrictEqual(plain(sync.sites.map(function(site) { return site.root; })), [MIRROR_ROOT]);
  assert.deepStrictEqual(plain(Object.keys(bg.registered).sort()), ['atp-mirror-0', 'atp-mirror-1']);

  const denied = await bg.send({ type: 'MIRROR_SITES_SYNC' }, { url: MIRROR_PAGE, tab: { id: 3 } });
  assert.strictEqual(denied.ok, false, 'content scripts must not drive mirror registration');
}

async function checkBackgroundZoneBoundary() {
  const bg = loadBackground({ origins: MANIFEST.host_permissions.concat([MIRROR_PATTERN]), deferGetAll: true });
  const fetched = [];
  bg.sandbox.fetch = async function(url) {
    fetched.push(url);
    if (url.indexOf('/thread-redirect-') !== -1) {
      return htmlResponse('<html><body><img src="https://img.example/leak.jpg"></body></html>', 'https://www.sehuatang.org/thread-9-1-1.html');
    }
    if (/attachment|\.txt/.test(url)) return textResponse('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', url);
    return htmlResponse('<html><body><img src="https://img.example/a.jpg"></body></html>', url);
  };

  // Messages that arrive before the grant list loads wait instead of being denied.
  const ownUrl = 'https://www.mirror.example/thread-1-1-1.html';
  const early = bg.send({ type: 'FETCH_IMAGES', urls: [ownUrl], maxImages: 10, displayImages: 10 }, { url: MIRROR_PAGE, tab: { id: 5 } });
  await flush();
  assert.deepStrictEqual(fetched, [], 'mirror messages must wait for the grant list');
  bg.releaseGetAll();
  const earlyResponse = await early;
  assert.strictEqual(earlyResponse[ownUrl].images.length, 1, 'mirror pages must get their own articles fetched');

  const builtinUrl = 'https://www.sehuatang.org/thread-2-1-1.html';
  fetched.length = 0;
  const crossZone = await bg.send({ type: 'FETCH_IMAGES', urls: [builtinUrl, ownUrl], maxImages: 10, displayImages: 10 },
    { url: MIRROR_PAGE, tab: { id: 5 } });
  assert.deepStrictEqual(fetched, [ownUrl], 'a mirror page must not have built-in articles fetched with that session');
  assert.strictEqual(crossZone[builtinUrl].reason, 'origin_disallowed');
  assert.strictEqual(crossZone[builtinUrl].retryableEmpty, false);

  fetched.length = 0;
  const reverse = await bg.send({ type: 'FETCH_IMAGES', urls: [ownUrl], maxImages: 10, displayImages: 10 },
    { url: BUILTIN_PAGE, tab: { id: 6 } });
  assert.deepStrictEqual(fetched, [], 'built-in pages must not pull mirror content into their DOM');
  assert.strictEqual(reverse[ownUrl].reason, 'origin_disallowed');

  const redirectUrl = 'https://www.mirror.example/thread-redirect-1-1.html';
  const redirected = await bg.send({ type: 'FETCH_IMAGES', urls: [redirectUrl], maxImages: 10, displayImages: 10 },
    { url: MIRROR_PAGE, tab: { id: 5 } });
  assert.strictEqual(redirected[redirectUrl].reason, 'redirect_disallowed', 'cross-zone redirects must be rejected');
  assert.strictEqual(redirected[redirectUrl].images.length, 0);

  const freshDenied = await bg.send({ type: 'FETCH_TEXT_ATTACHMENTS_FRESH', url: builtinUrl }, { url: MIRROR_PAGE, tab: { id: 5 } });
  assert.strictEqual(freshDenied.ok, false);

  fetched.length = 0;
  const text = await bg.send({
    type: 'FETCH_TEXT_RESOURCES',
    attachments: [
      { url: 'https://www.sehuatang.org/forum.php?mod=attachment&aid=1', name: 'builtin.txt', pageUrl: builtinUrl },
      { url: 'https://www.mirror.example/forum.php?mod=attachment&aid=2', name: 'own.txt', pageUrl: ownUrl }
    ]
  }, { url: MIRROR_PAGE, tab: { id: 5 } });
  assert.deepStrictEqual(fetched, ['https://www.mirror.example/forum.php?mod=attachment&aid=2'],
    'TXT attachments from another zone must be dropped before fetch');
  assert.strictEqual(text.attemptedCount, 1);
  assert.strictEqual(text.resources.groups.magnet.length, 1);

  const unsupported = await bg.send({ type: 'FETCH_IMAGES', urls: [ownUrl] }, { url: 'https://www.unknown.example/', tab: { id: 7 } });
  assert.deepStrictEqual(plain(unsupported), {}, 'unsupported senders stay denied');

  bg.sandbox.fetch = async function(url) {
    assert.strictEqual(url, 'chrome-extension://atpextensionid/floating-panel.css');
    return { ok: true, status: 200, text: async function() { return '.bfp-panel{}'; } };
  };
  const css = await bg.send({ type: 'GET_FLOATING_PANEL_CSS' }, { url: MIRROR_PAGE, tab: { id: 5 } });
  assert.deepStrictEqual(plain(css), { ok: true, css: '.bfp-panel{}' });
  const cssDenied = await bg.send({ type: 'GET_FLOATING_PANEL_CSS' }, { url: 'https://www.unknown.example/', tab: { id: 7 } });
  assert.strictEqual(cssDenied.ok, false);
}

// ---- Popup add / remove flow ----------------------------------------------

function makeElement(tag, id) {
  const element = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    value: '',
    disabled: false,
    textContent: '',
    className: '',
    children: [],
    attributes: {},
    listeners: {},
    classList: {
      set: {},
      add: function(name) { this.set[name] = true; },
      remove: function(name) { delete this.set[name]; },
      contains: function(name) { return !!this.set[name]; },
      toggle: function(name, force) {
        const on = force === undefined ? !this.set[name] : !!force;
        if (on) this.set[name] = true; else delete this.set[name];
        return on;
      }
    },
    get firstChild() { return element.children[0] || null; },
    appendChild: function(child) { element.children.push(child); return child; },
    removeChild: function(child) { element.children.splice(element.children.indexOf(child), 1); return child; },
    setAttribute: function(name, value) { element.attributes[name] = String(value); },
    getAttribute: function(name) { return Object.prototype.hasOwnProperty.call(element.attributes, name) ? element.attributes[name] : null; },
    removeAttribute: function(name) { delete element.attributes[name]; },
    addEventListener: function(type, listener) { (element.listeners[type] = element.listeners[type] || []).push(listener); },
    dispatch: function(type, event) {
      (element.listeners[type] || []).forEach(function(listener) { listener(Object.assign({ preventDefault: function() {} }, event || {})); });
    },
    querySelectorAll: function(selector) {
      const out = [];
      (function walk(node) {
        node.children.forEach(function(child) {
          if (selector === 'button' && child.tagName === 'BUTTON') out.push(child);
          walk(child);
        });
      })(element);
      return out;
    }
  };
  return element;
}

function loadPopupMirrors(options) {
  const elements = {};
  ['mirrorSection', 'mirrorCount', 'mirrorStatus', 'mirrorInput', 'addMirror', 'addCurrentMirror', 'mirrorList', 'mirrorEmpty'].forEach(function(id) {
    elements[id] = makeElement(id === 'mirrorList' ? 'ul' : 'div', id);
  });
  elements.mirrorSection.open = false;
  const granted = MANIFEST.host_permissions.slice().concat(options.origins || []);
  const calls = { request: [], remove: [], messages: [], reloads: [] };
  const sandbox = {
    URL, console,
    setTimeout, clearTimeout,
    document: {
      getElementById: function(id) { return elements[id] || null; },
      createElement: function(tag) { return makeElement(tag); }
    },
    window: {},
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: function(message, callback) {
          calls.messages.push(message.type);
          setImmediate(function() { callback({ ok: true, registered: true, sites: [] }); });
        }
      },
      tabs: {
        query: function(query, callback) { callback(options.activeTab ? [options.activeTab] : []); },
        reload: function(tabId, callback) { calls.reloads.push(tabId); callback(); }
      },
      permissions: {
        getAll: function(callback) { setImmediate(function() { callback({ origins: granted.slice() }); }); },
        request: function(request, callback) {
          calls.request.push(request.origins.slice());
          const allow = options.grant !== false;
          if (allow) Array.prototype.push.apply(granted, request.origins);
          setImmediate(function() { callback(allow); });
        },
        remove: function(request, callback) {
          calls.remove.push(request.origins.slice());
          request.origins.forEach(function(origin) {
            const index = granted.indexOf(origin);
            if (index !== -1) granted.splice(index, 1);
          });
          setImmediate(function() { callback(true); });
        },
        onAdded: { addListener: function() {} },
        onRemoved: { addListener: function() {} }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(read('settings-schema.js'), sandbox, { filename: 'settings-schema.js' });
  vm.runInContext(read('defaults.js'), sandbox, { filename: 'defaults.js' });
  vm.runInContext(read('shared-utils.js') + '\nthis.SharedUtils = SharedUtils;', sandbox, { filename: 'shared-utils.js' });
  vm.runInContext(read('popup-mirrors.js'), sandbox, { filename: 'popup-mirrors.js' });
  return { sandbox, elements, calls, granted };
}

async function checkPopupFlow() {
  const popup = loadPopupMirrors({ activeTab: { id: 9, url: 'https://www.mirror.example/forum.php?mod=forumdisplay&fid=2' } });
  const sites = await popup.sandbox.window.ATPPopupMirrors.ready;
  assert.deepStrictEqual(plain(sites), []);
  assert.strictEqual(popup.elements.addCurrentMirror.classList.contains('hidden'), false, 'current https tab must be offered as a mirror');
  assert.strictEqual(popup.elements.addCurrentMirror.textContent, '添加当前站点：mirror.example');
  assert.strictEqual(popup.elements.mirrorSection.open, true, 'the collapsed section must open when the current tab can be added');

  popup.elements.addCurrentMirror.dispatch('click');
  assert.deepStrictEqual(plain(popup.calls.request), [[MIRROR_PATTERN]], 'permission must be requested synchronously in the click');
  assert.strictEqual(popup.elements.addMirror.disabled, true, 'controls must be busy while Chrome prompts');
  await flush();
  assert.deepStrictEqual(plain(popup.calls.messages), ['MIRROR_SITES_SYNC']);
  assert.deepStrictEqual(plain(popup.calls.reloads), [9], 'the matching active tab must reload so scripts inject');
  assert.strictEqual(popup.elements.mirrorList.children.length, 1);
  assert.strictEqual(popup.elements.mirrorList.children[0].children[0].textContent, 'mirror.example');
  assert.strictEqual(popup.elements.addCurrentMirror.classList.contains('hidden'), true);
  assert.strictEqual(popup.elements.addMirror.disabled, false);
  assert.strictEqual(popup.sandbox.SharedUtils.isSupportedForumHost('www.mirror.example'), true,
    'popup registry must include granted mirrors so page refreshes target them');

  popup.elements.mirrorInput.value = 'http://plain.example/';
  popup.elements.addMirror.dispatch('click');
  assert.strictEqual(popup.calls.request.length, 1, 'invalid input must not prompt');
  assert.strictEqual(popup.elements.mirrorStatus.getAttribute('role'), 'alert');
  assert.strictEqual(popup.elements.mirrorStatus.textContent, '仅支持 HTTPS 镜像站点');

  popup.elements.mirrorInput.value = 'other.example';
  popup.elements.mirrorInput.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.deepStrictEqual(plain(popup.calls.request[1]), ['https://*.other.example/*']);
  assert.deepStrictEqual(plain(popup.calls.reloads), [9], 'adding a different site must not reload the active tab');
  assert.strictEqual(popup.elements.mirrorInput.value, '');
  assert.strictEqual(popup.elements.mirrorList.children.length, 2);
  assert.strictEqual(popup.elements.mirrorCount.textContent, '2');

  const removeButton = popup.elements.mirrorList.children[0].children[1];
  removeButton.dispatch('click');
  assert.deepStrictEqual(plain(popup.calls.remove), [], 'removal needs a confirming second click');
  assert.strictEqual(removeButton.textContent, '确认移除');
  removeButton.dispatch('click');
  await flush();
  assert.deepStrictEqual(plain(popup.calls.remove), [[MIRROR_PATTERN]]);
  assert.strictEqual(popup.elements.mirrorList.children.length, 1);
  assert.strictEqual(popup.elements.mirrorList.children[0].children[0].textContent, 'other.example');

  const declined = loadPopupMirrors({ grant: false, activeTab: { id: 4, url: 'https://www.mirror.example/' } });
  await declined.sandbox.window.ATPPopupMirrors.ready;
  declined.elements.addCurrentMirror.dispatch('click');
  await flush();
  assert.deepStrictEqual(plain(declined.calls.messages), [], 'declined prompts must not sync or reload');
  assert.deepStrictEqual(plain(declined.calls.reloads), []);
  assert.strictEqual(declined.elements.addMirror.disabled, false);

  const builtinTab = loadPopupMirrors({ activeTab: { id: 2, url: 'https://www.sehuatang.org/forum.php' } });
  await builtinTab.sandbox.window.ATPPopupMirrors.ready;
  assert.strictEqual(builtinTab.elements.addCurrentMirror.classList.contains('hidden'), true, 'built-in tabs need no mirror entry');
  assert.strictEqual(builtinTab.elements.mirrorSection.open, false, 'the section stays collapsed on supported forum tabs');
  assert.strictEqual(builtinTab.elements.mirrorCount.textContent, '0');
}

(async function main() {
  await checkBackgroundRegistration();
  await checkBackgroundZoneBoundary();
  await checkPopupFlow();
  console.log('mirror-sites tests passed');
})().catch(function(error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
