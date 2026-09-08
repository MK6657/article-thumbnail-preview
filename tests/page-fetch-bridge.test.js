const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'page-fetch-bridge.js'), 'utf8');

function makeHeaders(values) {
  const normalized = {};
  Object.keys(values || {}).forEach(function(key) {
    normalized[key.toLowerCase()] = String(values[key]);
  });
  return {
    get: function(name) { return normalized[String(name).toLowerCase()] || null; }
  };
}

function makeReadable(bytes) {
  let sent = false;
  return {
    getReader: function() {
      return {
        read: async function() {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: Uint8Array.from(bytes) };
        },
        cancel: async function() {},
        releaseLock: function() {}
      };
    }
  };
}

async function runFetcherBridgeIntegration(text) {
  const listeners = [];
  let contextWindow = null;
  let fetchCalls = 0;
  let cachedResources = null;
  let backgroundCalls = 0;
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  const sandbox = {
    URL: URL,
    AbortController: AbortController,
    Uint8Array: Uint8Array,
    TextDecoder: TextDecoder,
    TextEncoder: TextEncoder,
    Object: Object,
    Math: Math,
    Promise: Promise,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    btoa: function(binary) { return Buffer.from(binary, 'binary').toString('base64'); },
    atob: function(base64) { return Buffer.from(base64, 'base64').toString('binary'); },
    location: {
      origin: 'https://www.sehuatang.org',
      href: 'https://www.sehuatang.org/forum-95-2.html'
    },
    document: { visibilityState: 'visible' },
    navigator: { onLine: true },
    addEventListener: function(type, callback) {
      if (type === 'message') listeners.push(callback);
    },
    removeEventListener: function(type, callback) {
      if (type !== 'message') return;
      const index = listeners.indexOf(callback);
      if (index !== -1) listeners.splice(index, 1);
    },
    postMessage: function(message, targetOrigin) {
      if (targetOrigin !== sandbox.location.origin) return;
      const snapshot = listeners.slice();
      setTimeout(function() {
        snapshot.forEach(function(callback) {
          callback({ source: contextWindow, origin: sandbox.location.origin, data: message });
        });
      }, 0);
    },
    fetch: async function(url, options) {
      fetchCalls++;
      assert.strictEqual(options.credentials, 'include');
      assert.strictEqual(options.mode, 'same-origin', 'page bridge must reject cross-origin redirects at the network boundary');
      return {
        ok: true,
        status: 200,
        redirected: false,
        url: url,
        headers: makeHeaders({ 'content-length': bytes.length, 'content-type': 'application/octet-stream' }),
        body: makeReadable(bytes)
      };
    },
    Logger: {
      debug: function() {},
      warn: function() {},
      sanitizeUrl: function(url) { return String(url || '').replace(/[?#].*$/, ''); }
    },
    ATPCache: {
      getSettings: function() { return { cacheTTL: 30 }; },
      normalizeArticleData: function(data) { return data || {}; },
      getCachedTextResources: function() { return Promise.resolve(null); },
      getTextFailCache: function() { return Promise.resolve(false); },
      setCachedTextResources: function(url, resources) { cachedResources = sandbox.SharedUtils.normalizeResources(resources); },
      clearTextFailCache: function() {},
      setTextFailCache: function() {}
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: function(message, callback) {
          backgroundCalls++;
          if (callback) callback({ resources: sandbox.SharedUtils.emptyResources() });
        }
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'shared-utils.js'), 'utf8') + '\nthis.SharedUtils = SharedUtils;', sandbox, { filename: 'shared-utils.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'loading-policy.js'), 'utf8'), sandbox, { filename: 'loading-policy.js' });
  vm.runInContext(source, sandbox, { filename: 'page-fetch-bridge.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'fetcher.js'), 'utf8'), sandbox, { filename: 'fetcher.js' });
  contextWindow = vm.runInContext('window', sandbox);

  const resources = await sandbox.ATPFetcher.fetchTextAttachmentResource({
    url: 'https://www.sehuatang.org/forum.php?mod=attachment&aid=signed',
    pageUrl: 'https://www.sehuatang.org/thread-3632512-1-2.html',
    name: 'www.98T.la@评分的兄弟吊二次增大.txt'
  }, 0, {}, { manualRetry: true, deadline: Date.now() + 5000 });
  assert.strictEqual(fetchCalls, 1, 'fetcher integration must satisfy same-origin TXT through the page bridge');
  assert.strictEqual(backgroundCalls, 0, 'successful page bridge fetch must not reach background fallback');
  assert.strictEqual(resources.groups.ed2k.length, 1, 'fetcher integration must parse the bridged ED2K resource');
  assert(cachedResources && cachedResources.groups.ed2k.length === 1, 'fetcher integration must seed the positive TXT cache');
}

async function run() {
  const posted = [];
  let listener = null;
  let fetchCalls = 0;
  const text = 'ed2k://|file|www.98T.la@妃妃宝贝.zip|2945409455|43B5B13B95A9187A3BF041CC0A94FFC2|/';
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  assert.strictEqual(bytes.length, 86, 'page bridge must exercise the original 86-byte ED2K TXT payload');
  assert.strictEqual(crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'), '63b22500d849fc53787470a1a5a5e4503131ad0658af88fe739392a0ecf8fead', 'page bridge ED2K TXT fixture hash changed unexpectedly');
  const sandbox = {
    URL: URL,
    AbortController: AbortController,
    Uint8Array: Uint8Array,
    Object: Object,
    Math: Math,
    Promise: Promise,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    btoa: function(binary) { return Buffer.from(binary, 'binary').toString('base64'); },
    location: {
      origin: 'https://www.sehuatang.org',
      href: 'https://www.sehuatang.org/forum-95-2.html'
    },
    addEventListener: function(type, callback) {
      if (type === 'message') listener = callback;
    },
    postMessage: function(message, targetOrigin) {
      posted.push({ message: message, targetOrigin: targetOrigin });
    },
    fetch: async function(url, options) {
      fetchCalls++;
      assert.strictEqual(url, 'https://www.sehuatang.org/forum.php?mod=attachment&aid=signed');
      assert.strictEqual(options.credentials, 'include');
      assert.strictEqual(options.mode, 'same-origin');
      assert.strictEqual(options.referrer, 'https://www.sehuatang.org/thread-3632512-1-2.html');
      return {
        ok: true,
        status: 200,
        url: url,
        headers: makeHeaders({ 'content-length': bytes.length, 'content-type': 'application/octet-stream' }),
        body: makeReadable(bytes)
      };
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'page-fetch-bridge.js' });
  const contextWindow = vm.runInContext('window', sandbox);
  assert.strictEqual(typeof listener, 'function', 'page bridge must register one message listener');

  await listener({
    source: contextWindow,
    origin: sandbox.location.origin,
    data: {
      type: 'ATP_PAGE_TEXT_FETCH_REQUEST_V1',
      id: 'request_12345678',
      url: 'https://www.sehuatang.org/forum.php?mod=attachment&aid=signed',
      referrer: 'https://www.sehuatang.org/thread-3632512-1-2.html?secret=drop#hash',
      maxBytes: 512 * 1024,
      timeoutMs: 1000
    }
  });
  assert.strictEqual(fetchCalls, 1, 'allowed same-origin attachment must use the page fetch context');
  assert.strictEqual(posted.length, 1, 'successful page fetch must post one response');
  assert.strictEqual(posted[0].targetOrigin, sandbox.location.origin, 'page bridge response must stay on the current origin');
  assert.strictEqual(posted[0].message.ok, true, 'page bridge must return a successful payload');
  assert.strictEqual(Buffer.from(posted[0].message.base64, 'base64').toString('utf8'), text, 'page bridge must preserve TXT bytes');

  posted.length = 0;
  await listener({
    source: contextWindow,
    origin: sandbox.location.origin,
    data: {
      type: 'ATP_PAGE_TEXT_FETCH_REQUEST_V1',
      id: 'request_87654321',
      url: 'https://evil.example/private.txt'
    }
  });
  assert.strictEqual(fetchCalls, 1, 'cross-origin page bridge requests must be rejected before fetch');
  assert.strictEqual(posted[0].message.error, 'url_not_allowed', 'cross-origin rejection must be explicit');

  let limitedSignal = null;
  let bodyRead = false;
  sandbox.fetch = async function(url, options) {
    limitedSignal = options.signal;
    return {
      ok: true, status: 200, url: url,
      headers: makeHeaders({ 'content-length': 1024 * 1024 }),
      arrayBuffer: async function() { bodyRead = true; return new ArrayBuffer(0); }
    };
  };
  posted.length = 0;
  await listener({ source: contextWindow, origin: sandbox.location.origin, data: {
    type: 'ATP_PAGE_TEXT_FETCH_REQUEST_V1', id: 'request_large_body',
    url: sandbox.location.origin + '/oversized.txt', timeoutMs: 1000
  } });
  assert.strictEqual(posted[0].message.error, 'response_too_large');
  assert.strictEqual(bodyRead, false, 'oversized declared body must not be buffered');
  assert.strictEqual(limitedSignal.aborted, true, 'rejected response must cancel the unread network body');

  await runFetcherBridgeIntegration(text);

  console.log('page fetch bridge tests ok: standalone + fetcher integration');
}

run().catch(function(error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
