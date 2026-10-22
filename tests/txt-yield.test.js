'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const origin = 'https://www.sehuatang.org';
const articleUrl = origin + '/thread-123-1-1.html';
const attachment = (id, host = origin) => ({
  url: host + '/forum.php?mod=attachment&aid=' + id,
  name: id + '.txt', pageUrl: articleUrl
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function response(url, text, contentType = 'text/plain') {
  return {
    ok: true, status: 200, redirected: false, url, bodyUsed: false,
    headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : null },
    async arrayBuffer() { this.bodyUsed = true; return new TextEncoder().encode(text).buffer; },
    async text() { this.bodyUsed = true; return text; }
  };
}

function load(options = {}) {
  let clock = 1000000;
  let timerSequence = 0;
  let contextWindow;
  const timers = new Map();
  const storage = new Map();
  const cache = new Map();
  const events = [];
  const requests = [];
  const messages = [];
  const failWrites = [];
  const listeners = [];
  const sandbox = {
    URL, TextDecoder, TextEncoder, Uint8Array, AbortController, console,
    Date: class extends Date { static now() { return clock; } },
    setTimeout(fn, delay) {
      const id = ++timerSequence;
      timers.set(id, { fn, at: clock + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    location: { origin, href: origin + '/forum-2-1.html', hostname: 'www.sehuatang.org' },
    document: { visibilityState: 'visible', querySelector: () => null },
    navigator: { onLine: true },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    Logger: { isEnabled: () => true, event: (type, fields) => events.push({ type, fields }),
      debug() {}, info() {}, warn() {}, sanitizeUrl: () => '' },
    ATPState: { settings: {} },
    ATPCache: {
      getCachedTextResources: async url => cache.get(url) || null,
      getTextFailCache: async () => false,
      setCachedTextResources: (url, resources) => cache.set(url, resources),
      clearTextFailCache() {}, setTextFailCache: url => failWrites.push(url)
    },
    fetch: async (url, requestOptions) => {
      requests.push({ url, options: requestOptions });
      return options.fetch ? options.fetch(url, requestOptions, requests.length)
        : response(url, 'https://pan.baidu.com/s/1yield' + requests.length);
    },
    chrome: { runtime: { lastError: null, sendMessage(message, callback) {
      messages.push({ message, callback });
      if (options.message) return options.message(message, callback);
      callback({ resources: sandbox.SharedUtils.emptyResources(), attemptedCount: message.attachments.length,
        unresolvedCount: message.attachments.length, retryableCount: message.attachments.length });
    } } }
  };
  if (options.bridge !== false) {
    sandbox.addEventListener = (type, listener) => { if (type === 'message') listeners.push(listener); };
    sandbox.removeEventListener = (type, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
    sandbox.postMessage = data => sandbox.setTimeout(() => listeners.slice().forEach(listener => listener({
      source: contextWindow, origin, data
    })), 0);
  }
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('shared-utils.js') + '\nthis.SharedUtils = SharedUtils;', sandbox);
  vm.runInContext(read('loading-policy.js'), sandbox);
  vm.runInContext(read('forum-pacer.js'), sandbox);
  if (options.bridge !== false) vm.runInContext(read('page-fetch-bridge.js'), sandbox);
  vm.runInContext(read('fetcher.js'), sandbox);
  contextWindow = vm.runInContext('window', sandbox);

  async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
  async function advance(ms = 0) {
    await flush();
    const until = clock + ms;
    for (;;) {
      let nextId = 0;
      let next;
      for (const [id, timer] of timers) {
        if (timer.at <= until && (!next || timer.at < next.at || (timer.at === next.at && id < nextId))) {
          nextId = id;
          next = timer;
        }
      }
      if (!next) break;
      timers.delete(nextId);
      clock = Math.max(clock, next.at);
      next.fn();
      await flush();
    }
    clock = until;
    await flush();
  }
  return { sandbox, fetcher: sandbox.ATPFetcher, pacer: sandbox.ATPForumPacer,
    now: () => clock, advance, flush, requests, messages, cache, events, failWrites };
}

async function useAllowance(run, cost = 10) {
  (await run.pacer.acquire({ manual: true, cost })).done('');
  await run.advance();
}

function assertYield(status, unresolved) {
  assert.strictEqual(status.yielded, true, 'unsent work must have an explicit yield result');
  assert.strictEqual(status.unresolvedCount, unresolved);
  assert.strictEqual(status.retryableCount, unresolved);
}

function assertNoFailure(run) {
  assert.strictEqual(run.failWrites.length, 0, 'yield must not populate the failure cache');
  assert(!run.events.some(event => event.fields.outcome === 'failed'), 'yield must not log a request failure');
}

async function checkBridgeWaitCancellation() {
  const run = load();
  await useAllowance(run);
  let cancelled = false;
  const promise = run.fetcher.fetchTextAttachmentResourcesWithStatus([attachment('waiting')], {
    deadline: run.now() + 60000, isCancelled: () => cancelled
  });
  await run.advance();
  assert.strictEqual(run.pacer.getState().waiting, 1);
  assert.strictEqual(run.requests.length, 0);
  cancelled = true;
  await run.advance(500);
  assertYield(await promise, 1);
  assert.strictEqual(run.requests.length, 0);
  assert.strictEqual(run.messages.length, 0);
  assert.strictEqual(run.pacer.getState().waiting, 0);
  assert.strictEqual(run.pacer.getState().active, 0);
  assertNoFailure(run);
}

async function checkDynamicPriorityAndInflight() {
  const pending = deferred();
  const run = load({ fetch: () => pending.promise });
  await useAllowance(run, 6);
  let priority = run.pacer.PRIORITY_ARTICLE;
  let cancelled = false;
  let settled = false;
  const promise = run.fetcher.fetchTextAttachmentResourcesWithStatus([attachment('priority')], {
    deadline: run.now() + 60000, getPriority: () => priority, isCancelled: () => cancelled
  }).then(status => { settled = true; return status; });
  await run.advance();
  assert.strictEqual(run.requests.length, 0, 'offscreen TXT must preserve the visible reserve');
  assert.strictEqual(run.pacer.getState().waiting, 1);
  priority = run.pacer.PRIORITY_VISIBLE;
  await run.advance(500);
  assert.strictEqual(run.requests.length, 1, 'a newly visible waiter must use its current priority');
  assert.strictEqual(run.pacer.getState().active, 1);
  cancelled = true;
  await run.advance(500);
  assert.strictEqual(settled, false, 'yield must not settle a request already in flight');
  assert.strictEqual(run.pacer.getState().active, 1, 'inflight pacing slot must remain held');
  assert.strictEqual(run.requests[0].options.signal.aborted, false);
  pending.resolve(response(attachment('priority').url, 'https://pan.baidu.com/s/1priority'));
  await run.advance();
  const status = await promise;
  assert.strictEqual(status.yielded, undefined, 'a fully completed request has no unsent work to yield');
  assert.strictEqual(status.resources.groups.baidu.length, 1);
  assert.strictEqual(run.pacer.getState().active, 0);
}

async function checkPartialResultsAndResume() {
  const pending = deferred();
  const run = load({ fetch: (url, options, count) => count === 1 ? pending.promise
    : response(url, 'https://pan.baidu.com/s/1second') });
  const first = attachment('first');
  const second = attachment('second');
  let cancelled = false;
  const requestOptions = { deadline: run.now() + 60000, isCancelled: () => cancelled };
  const promise = run.fetcher.fetchTextAttachmentResourcesWithStatus([first, second], requestOptions);
  await run.advance();
  assert.strictEqual(run.requests.length, 1);
  cancelled = true;
  pending.resolve(response(first.url, 'https://pan.baidu.com/s/1first'));
  await run.advance();
  const status = await promise;
  assertYield(status, 1);
  assert.strictEqual(status.attemptedCount, 2);
  assert.strictEqual(status.resources.groups.baidu.length, 1, 'yield must retain the first completed attachment');
  assert(run.cache.has(first.url), 'completed resources must be cached before yielding');
  assert.strictEqual(run.requests.length, 1);
  assert.strictEqual(run.messages.length, 0);
  assert.strictEqual(requestOptions._textRequestControl, undefined, 'the yield latch must not leak into caller options');
  assertNoFailure(run);

  cancelled = false;
  const resume = run.fetcher.fetchTextAttachmentResourcesWithStatus([first, second], requestOptions);
  await run.advance();
  const completed = await resume;
  assert.strictEqual(completed.yielded, undefined);
  assert.strictEqual(completed.unresolvedCount, 0);
  assert.strictEqual(completed.resources.groups.baidu.length, 2);
  assert.strictEqual(run.requests.length, 2, 'resumption must reuse the successful cache instead of downloading again');
}

async function checkBackgroundWaitAndInflight() {
  const waiting = load();
  await useAllowance(waiting);
  let cancelled = false;
  const queued = waiting.fetcher.fetchTextAttachmentResourcesWithStatus([
    attachment('cross', 'https://www.sehuatang.net')
  ], { deadline: waiting.now() + 60000, isCancelled: () => cancelled });
  await waiting.advance();
  assert.strictEqual(waiting.pacer.getState().waiting, 1);
  cancelled = true;
  await waiting.advance(500);
  assertYield(await queued, 1);
  assert.strictEqual(waiting.messages.length, 0, 'cancelled background pace wait must not dispatch');
  assertNoFailure(waiting);

  const inflight = load({ message() {} });
  cancelled = false;
  let settled = false;
  const promise = inflight.fetcher.fetchTextAttachmentResourcesByBackgroundWithStatus([
    attachment('cross', 'https://www.sehuatang.net')
  ], { deadline: inflight.now() + 60000, isCancelled: () => cancelled }).then(status => { settled = true; return status; });
  await inflight.advance();
  assert.strictEqual(inflight.messages.length, 1);
  cancelled = true;
  await inflight.advance(500);
  assert.strictEqual(settled, false);
  assert.strictEqual(inflight.pacer.getState().active, 1);
  const resources = inflight.sandbox.SharedUtils.extractResources('https://pan.baidu.com/s/1background', articleUrl, 'txt');
  inflight.messages[0].callback({ resources, attemptedCount: 1, unresolvedCount: 0, retryableCount: 0 });
  await inflight.advance();
  const status = await promise;
  assert.strictEqual(status.yielded, undefined);
  assert.strictEqual(status.resources.groups.baidu.length, 1);
  assert.strictEqual(inflight.pacer.getState().active, 0);

  const relay = load();
  const relayStatus = await relay.fetcher.fetchTextAttachmentResourcesByBackgroundWithStatus([
    { url: 'https://dl.ldkms.la/test.txt' }
  ], { isCancelled: () => true });
  assertYield(relayStatus, 1);
  assert.strictEqual(relay.messages.length, 0, 'unpaced cross-origin dispatch still needs the cancellation guard');
}

async function checkDirectAndIntermediaryBoundaries() {
  const direct = load({ bridge: false });
  await useAllowance(direct, 5);
  let cancelled = false;
  const promise = direct.fetcher.fetchTextAttachmentResourcesWithStatus([attachment('direct')], {
    deadline: direct.now() + 60000, isCancelled: () => cancelled
  });
  await direct.advance();
  assert.strictEqual(direct.pacer.getState().waiting, 1, 'direct fallback must wait after the bridge allowance is spent');
  cancelled = true;
  await direct.advance(500);
  assertYield(await promise, 1);
  assert.strictEqual(direct.requests.length, 0);
  assert.strictEqual(direct.messages.length, 0);
  assertNoFailure(direct);

  const intermediary = load({ bridge: false, fetch: url => response(url,
    '<html><body><a href="' + origin + '/forum.php?mod=attachment&amp;aid=final.txt">下载 list.txt</a></body></html>', 'text/html') });
  await useAllowance(intermediary, 4);
  cancelled = false;
  const followed = intermediary.fetcher.fetchTextAttachmentResourcesWithStatus([attachment('relay')], {
    deadline: intermediary.now() + 60000, isCancelled: () => cancelled
  });
  await intermediary.advance();
  assert.strictEqual(intermediary.requests.length, 1, 'the intermediary response must finish before its next request waits');
  assert.strictEqual(intermediary.pacer.getState().active, 0);
  assert.strictEqual(intermediary.pacer.getState().waiting, 1);
  cancelled = true;
  await intermediary.advance(500);
  assertYield(await followed, 1);
  assert.strictEqual(intermediary.requests.length, 1, 'yielding the download link must not send it or repeat the intermediary');
  assert.strictEqual(intermediary.messages.length, 0);
  assertNoFailure(intermediary);
}

async function checkFreshAndManual() {
  for (const url of [articleUrl, 'https://www.sehuatang.net/thread-123-1-1.html']) {
    const run = load();
    await useAllowance(run);
    let cancelled = false;
    const promise = run.fetcher.fetchTextAttachmentsFresh(url, {
      deadline: run.now() + 60000, isCancelled: () => cancelled
    });
    await run.advance();
    assert.strictEqual(run.pacer.getState().waiting, 1);
    cancelled = true;
    await run.advance(500);
    const result = await promise;
    assert.strictEqual(result.yielded, true, 'fresh re-extraction must distinguish yield from missing attachment links');
    assert.strictEqual(run.requests.length, 0);
    assert.strictEqual(run.messages.length, 0);
    assert.strictEqual(run.pacer.getState().active, 0);
    assertNoFailure(run);
  }

  const pending = deferred();
  const fresh = load({ fetch: () => pending.promise });
  let cancelled = false;
  let settled = false;
  const promise = fresh.fetcher.fetchTextAttachmentsFresh(articleUrl, {
    deadline: fresh.now() + 60000, isCancelled: () => cancelled
  }).then(value => { settled = true; return value; });
  await fresh.advance();
  cancelled = true;
  await fresh.advance(500);
  assert.strictEqual(settled, false);
  assert.strictEqual(fresh.pacer.getState().active, 1);
  pending.resolve(response(articleUrl, '<html><body><div id="postlist"><div id="postmessage_123">正文没有附件</div></div></body></html>', 'text/html'));
  await fresh.advance();
  assert(Array.isArray(await promise), 'completed fresh reads must retain their real result');
  assert.strictEqual(fresh.pacer.getState().active, 0);

  const manual = load();
  await useAllowance(manual);
  const retry = manual.fetcher.fetchTextAttachmentResourcesWithStatus([attachment('manual')], {
    manualRetry: true, deadline: manual.now() + 60000, isCancelled: () => true
  });
  await manual.advance();
  assert.strictEqual((await retry).yielded, undefined);
  assert.strictEqual(manual.requests.length, 1, 'manual retry must retain its existing immediate request behavior');
}

async function checkGrantedTicketRefundAndLatch() {
  const run = load();
  const acquire = run.pacer.acquire;
  let cancelled = false;
  run.pacer.acquire = async options => {
    const ticket = await acquire(options);
    cancelled = true;
    return ticket;
  };
  const status = await run.fetcher.fetchTextAttachmentResourcesWithStatus([attachment('grant')], {
    deadline: run.now() + 60000, isCancelled: () => cancelled
  });
  assertYield(status, 1);
  assert.strictEqual(run.requests.length, 0);
  assert.strictEqual(run.messages.length, 0);
  assert.strictEqual(run.pacer.getState().tokens, 10, 'a granted but unused ticket must refund its allowance');
  assert.strictEqual(run.pacer.getState().active, 0);

  const transient = load();
  await useAllowance(transient);
  let cancelOnce = false;
  const promise = transient.fetcher.fetchTextAttachmentResourcesWithStatus([attachment('transient')], {
    deadline: transient.now() + 60000,
    isCancelled: () => { const value = cancelOnce; cancelOnce = false; return value; }
  });
  await transient.advance();
  cancelOnce = true;
  await transient.advance(500);
  assertYield(await promise, 1);
  assert.strictEqual(transient.messages.length, 0, 'cancellation observed by the pacer must remain latched across fallbacks');
  assert.strictEqual(transient.requests.length, 0);
  assertNoFailure(transient);
}

async function run() {
  await checkBridgeWaitCancellation();
  await checkDynamicPriorityAndInflight();
  await checkPartialResultsAndResume();
  await checkBackgroundWaitAndInflight();
  await checkDirectAndIntermediaryBoundaries();
  await checkFreshAndManual();
  await checkGrantedTicketRefundAndLatch();
  console.log('TXT yield tests ok: dynamic pace cancellation, priority, inflight retention, partial resources, resumption and fresh reads');
}

run().catch(error => { console.error(error && error.stack || error); process.exit(1); });
