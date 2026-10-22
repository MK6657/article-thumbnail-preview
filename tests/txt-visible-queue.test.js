'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const origin = 'https://www.sehuatang.org';
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const magnet = number => 'magnet:?xt=urn:btih:' + number.toString(16).padStart(40, '0');

// Run the production renderer and fetcher together. Only browser I/O, cache
// storage, the pacer's admission boundary and time are controlled by the test.
function createRun(options = {}) {
  let now = 1000000, timerId = 0, threadId = 0, resourceId = 100;
  const timers = new Map(), listeners = new Set(), textCache = new Map();
  const waiters = [], requests = [], grants = [], events = [], failWrites = [], articleWrites = [];
  let contextWindow, throwYieldOnce = false;
  const sandbox = {
    URL, Promise, Math, TextEncoder, TextDecoder, Uint8Array, AbortController,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, at: now + (Number(delay) || 0) }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    location: { href: origin + '/forum-95-1.html', origin },
    navigator: { onLine: true },
    innerHeight: 800,
    document: { visibilityState: 'visible', documentElement: { clientHeight: 800 }, contains: node => !node.detached },
    ATPState: { generation: 1, settings: {}, threads: {} },
    ATPArticleWork: { isBusy: () => false },
    ATPResourcePanel: { updateThread() {} },
    Logger: {
      isEnabled: () => true,
      debug() {},
      warn(...args) { events.push({ level: 'WARN', name: 'warn', args }); },
      sanitizeUrl: url => String(url).replace(/[?#].*$/, ''),
      event(name, fields, level) {
        events.push({ name, fields: Object.assign({}, fields), level });
        if (throwYieldOnce && name === 'txt_result' && fields.outcome === 'yielded') {
          throwYieldOnce = false;
          throw new Error('simulated late diagnostic failure');
        }
      }
    },
    ATPCache: {
      getCachedTextResources: async url => textCache.get(url) || null,
      getTextFailCache: async () => false,
      setCachedTextResources(url, resources) { textCache.set(url, sandbox.SharedUtils.normalizeResources(resources)); },
      clearTextFailCache() {},
      setTextFailCache(...args) { failWrites.push(args); },
      setCachedArticleData(url, data) { articleWrites.push({ url, data }); },
      normalizeArticleData: data => data || {}
    },
    chrome: { runtime: { lastError: null, sendMessage(message, callback) {
      requests.push({ kind: 'background', url: message.url || message.attachments[0].url, message, callback });
    } } },
    fetch: (url, fetchOptions) => new Promise(resolve => {
      requests.push({ kind: 'fetch', url, fetchOptions, resolve });
    })
  };
  if (options.bridge !== false) {
    sandbox.addEventListener = (type, listener) => { if (type === 'message') listeners.add(listener); };
    sandbox.removeEventListener = (type, listener) => { if (type === 'message') listeners.delete(listener); };
    sandbox.postMessage = (message, targetOrigin) => {
      assert.strictEqual(targetOrigin, origin);
      requests.push({ kind: 'bridge', url: message.url, message });
    };
  }
  function ticket(waiter) {
    const grant = { options: waiter.options, outcome: null };
    grants.push(grant);
    return { startedAt: now, waitMs: now - waiter.at, done(outcome) {
      if (grant.outcome === null) grant.outcome = outcome || '';
    } };
  }
  sandbox.ATPForumPacer = {
    PRIORITY_VISIBLE: 0,
    PRIORITY_ARTICLE: 1,
    acquire(paceOptions) {
      const waiter = { options: paceOptions, at: now };
      if (paceOptions.manual) return Promise.resolve(ticket(waiter));
      return new Promise(resolve => { waiter.resolve = resolve; waiters.push(waiter); });
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('shared-utils.js') + '\nthis.SharedUtils = SharedUtils;', sandbox, { filename: 'shared-utils.js' });
  for (const filename of ['loading-policy.js', 'fetcher.js', 'renderer.js']) {
    vm.runInContext(read(filename), sandbox, { filename });
  }
  contextWindow = vm.runInContext('window', sandbox);

  async function microtasks() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
  async function flush() {
    for (let step = 0; step < 100; step++) {
      await microtasks();
      const due = Array.from(timers.entries()).find(([, timer]) => timer.at <= now);
      if (!due) return;
      timers.delete(due[0]);
      due[1].fn();
      assert(sandbox.ATPRenderer.getAutomaticTextResourceQueueState().active <= 2,
        'automatic TXT work must retain its two-run concurrency cap');
    }
    assert.fail('immediate timers must settle without a requeue loop');
  }
  function poll() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if ((waiter.options.deadline && waiter.options.deadline <= now) ||
          (waiter.options.isCancelled && waiter.options.isCancelled())) {
        waiters.splice(i, 1);
        waiter.resolve(null);
      }
    }
  }
  async function grantNext() {
    poll();
    await flush();
    assert(waiters.length, 'a network request must acquire a forum turn');
    const priority = waiter => waiter.options.getPriority ? waiter.options.getPriority() : waiter.options.priority;
    let index = 0;
    for (let i = 1; i < waiters.length; i++) if (priority(waiters[i]) < priority(waiters[index])) index = i;
    const waiter = waiters.splice(index, 1)[0];
    waiter.resolve(ticket(waiter));
    await flush();
  }
  function attachment(name) {
    return { url: origin + '/files/' + name + '.txt', name: name + '.txt', pageUrl: origin + '/thread-100-1-1.html' };
  }
  function thread(name, options = {}) {
    const id = 't_' + now + '_' + (++threadId);
    const state = {
      id, registeredInState: true, generation: sandbox.ATPState.generation,
      link: origin + '/thread-' + (100 + threadId) + '-1-1.html',
      candidates: [], resources: sandbox.SharedUtils.emptyResources(),
      textAttachments: options.fresh ? [] : (options.attachments || [attachment(name)]),
      textAttachmentCount: options.fresh ? 1 : (options.attachments ? options.attachments.length : 1),
      hasTextAttachments: !!options.fresh,
      textResourcesAutoQueued: false, textResourcesAutoActive: false, textResourcesAutoAttempted: false,
      textResourcesLoading: false, textResourcesImporting: false, textResourcesDone: false,
      textResourcesRetryable: false, visible: !!options.visible, statusEl: { textContent: '' }
    };
    state.panel = { getBoundingClientRect: () => state.visible ? { top: 20, bottom: 200 } : { top: 3000, bottom: 3200 } };
    sandbox.ATPState.threads[id] = state;
    return state;
  }
  function resources(number) { return sandbox.SharedUtils.extractResources(magnet(number), origin, 'txt'); }
  function respond(request, body) {
    assert(!request.settled, 'each fake response must settle only once');
    request.settled = true;
    const fresh = /\/thread-/.test(request.url);
    body = body || (fresh
      ? '<html><body><div id="postmessage_1"><a href="' + attachment('fresh-' + (++resourceId)).url + '">resource.txt</a></div></body></html>'
      : magnet(++resourceId));
    if (request.kind === 'bridge') {
      for (const listener of Array.from(listeners)) listener({
        source: contextWindow, origin,
        data: { type: 'ATP_PAGE_TEXT_FETCH_RESPONSE_V1', id: request.message.id, ok: true,
          status: 200, finalUrl: request.url, contentType: 'text/plain; charset=utf-8',
          base64: Buffer.from(body).toString('base64') }
      });
    } else if (request.kind === 'fetch') {
      const bytes = Uint8Array.from(Buffer.from(body));
      const response = {
        ok: true, status: 200, url: request.url, bodyUsed: false,
        headers: { get: name => name.toLowerCase() === 'content-type' ? (fresh ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8') : null },
        async arrayBuffer() { response.bodyUsed = true; return bytes.buffer; }
      };
      request.resolve(response);
    } else {
      request.callback({ resources: resources(++resourceId), attemptedCount: 1, unresolvedCount: 0, retryableCount: 0 });
    }
  }
  async function drain() {
    for (let turn = 0; turn < 80; turn++) {
      await flush();
      const pending = requests.find(request => !request.settled);
      if (pending) respond(pending);
      else if (waiters.length) await grantNext();
      else {
        const state = sandbox.ATPRenderer.getAutomaticTextResourceQueueState();
        assert.strictEqual(state.active, 0, 'settled runs must release their automatic slots');
        assert.strictEqual(state.queued, 0, 'all eligible automatic runs must finish');
        return;
      }
    }
    assert.fail('TXT integration run failed to drain');
  }
  return {
    sandbox, waiters, requests, grants, events, failWrites, articleWrites, textCache, timers,
    thread, attachment, resources, flush, microtasks, poll, grantNext, respond, drain,
    queue: state => { assert.strictEqual(sandbox.ATPRenderer.queueAutomaticTextResourceLoad(state), true); },
    state: () => sandbox.ATPRenderer.getAutomaticTextResourceQueueState(),
    count: state => sandbox.SharedUtils.countResources(state.resources),
    throwYieldDiagnosticOnce: () => { throwYieldOnce = true; }
  };
}

function assertNoFailure(run) {
  assert.strictEqual(run.failWrites.length, 0, 'yielding must never write a TXT failure cache');
  assert.deepStrictEqual(run.events.filter(event => event.level === 'WARN'), [],
    'normal scheduling yields must not become user-visible failures');
}

async function checkWaitingPriorityAndResume() {
  const run = createRun();
  const a = run.thread('offscreen-a'), b = run.thread('offscreen-b'), visible = run.thread('visible', { visible: true });
  run.queue(a); run.queue(b); await run.flush();
  assert.strictEqual(run.waiters.length, 2);
  assert.strictEqual(run.requests.length, 0);
  run.queue(visible); await run.flush();
  assert.strictEqual(run.state().active, 2, 'enqueueing visible work alone must not release unsettled runs');
  run.poll(); await run.flush();
  assert.strictEqual(run.events.filter(event => event.name === 'txt_result' && event.fields.outcome === 'yielded').length, 2);
  assert.strictEqual(visible.textResourcesAutoActive, true);
  assert(a.textResourcesAutoQueued || b.textResourcesAutoQueued, 'yielded work must retain automatic eligibility');
  assert.strictEqual(run.requests.length, 0, 'yielding at the pacer must send no network request');
  await run.grantNext();
  assert.strictEqual(run.requests[0].url, visible.textAttachments[0].url,
    'the newly visible TXT must send before both earlier offscreen runs');
  await run.drain();
  assert([a, b, visible].every(state => state.textResourcesDone), 'yielded runs must resume and finish automatically');
  assert.strictEqual(run.requests.length, 3, 'yielding must not duplicate a request');
  assertNoFailure(run);
}

async function checkInflightSlots() {
  // With no page bridge, the actual direct-fetch path exposes AbortSignals.
  const run = createRun({ bridge: false });
  const a = run.thread('inflight-a'), b = run.thread('inflight-b'), visible = run.thread('after-inflight', { visible: true });
  run.queue(a); run.queue(b); await run.flush();
  while (run.requests.length < 2) await run.grantNext();
  run.queue(visible); run.poll(); await run.flush();
  assert.strictEqual(run.state().active, 2);
  assert.strictEqual(run.state().queued, 1);
  assert.strictEqual(visible.textResourcesAutoActive, false, 'inflight runs must keep their real slots');
  assert(run.requests.every(request => !request.fetchOptions.signal.aborted), 'visible work must not abort existing requests');
  assert.strictEqual(run.events.filter(event => event.name === 'txt_result' && event.fields.outcome === 'yielded').length, 0);
  run.respond(run.requests[0]); await run.flush();
  assert.strictEqual(visible.textResourcesAutoActive, true, 'a completed request may release a slot for visible work');
  assert.strictEqual(run.requests[1].fetchOptions.signal.aborted, false);
  await run.drain();
  assert([a, b, visible].every(state => state.textResourcesDone));
  assertNoFailure(run);
}

async function checkPartialResourceRetention() {
  const run = createRun();
  const first = run.attachment('partial-first'), second = run.attachment('partial-second');
  const a = run.thread('partial', { attachments: [first, second] });
  a.resources = run.resources(1);
  const b = run.thread('partial-other'), visible = run.thread('partial-visible', { visible: true });
  run.queue(a); run.queue(b); await run.flush();
  await run.grantNext();
  assert.strictEqual(run.requests[0].url, first.url);
  run.respond(run.requests[0], magnet(2)); await run.flush();
  run.queue(visible); run.poll(); await run.flush();
  assert.strictEqual(run.count(a), 2, 'yielded status must merge completed attachments and keep existing resources');
  assert.strictEqual(a.textResourcesDone, false);
  assert.strictEqual(a.textResourcesRetryable, false, 'yielded work is queued, not a failure requiring manual retry');
  assert.strictEqual(run.articleWrites.length, 0, 'yield must not write a complete or failed article cache result');
  await run.grantNext();
  assert.strictEqual(run.requests[1].url, visible.textAttachments[0].url);
  await run.drain();
  assert.strictEqual(run.count(a), 3);
  assert.strictEqual(run.requests.filter(request => request.url === first.url).length, 1,
    'the completed attachment cache must avoid downloading it again after a yield');
  assertNoFailure(run);
}

async function checkFreshExtractionYield() {
  const run = createRun();
  const a = run.thread('fresh-a', { fresh: true }), b = run.thread('fresh-b', { fresh: true });
  const visible = run.thread('before-fresh', { visible: true });
  run.queue(a); run.queue(b); await run.flush();
  assert.strictEqual(run.waiters.length, 2);
  run.queue(visible); run.poll(); await run.flush();
  assert.strictEqual(run.requests.length, 0, 'fresh extraction must also yield before reading the thread');
  assert.strictEqual(run.events.filter(event => event.name === 'txt_result' && event.fields.outcome === 'yielded').length, 2);
  assert.strictEqual(a.hasTextAttachments, true, 'fresh yielding must preserve attachment markers');
  await run.grantNext();
  assert.strictEqual(run.requests[0].url, visible.textAttachments[0].url);
  await run.drain();
  assert([a, b, visible].every(state => state.textResourcesDone));
  assert.strictEqual(run.requests.filter(request => request.url === a.link).length, 1);
  assert.strictEqual(run.requests.filter(request => request.url === b.link).length, 1);
  assertNoFailure(run);
}

async function checkImportAndGeneration() {
  const imported = createRun();
  const state = imported.thread('imported');
  imported.queue(state); await imported.flush();
  await imported.grantNext();
  const oldRequest = imported.requests[0];
  assert.strictEqual(imported.sandbox.ATPRenderer.importTextResources(state,
    [{ name: 'imported.txt', resources: imported.resources(3) }]), true);
  const savedMessage = state.textResourceMessage;
  assert.strictEqual(imported.state().active, 1, 'local import must not release the old network slot early');
  imported.respond(oldRequest, magnet(4)); await imported.flush();
  assert.strictEqual(state.textResourceMessage, savedMessage);
  assert.strictEqual(imported.count(state), 1, 'late old results must not overwrite or merge into a local import');
  assert.strictEqual(state.textResourcesDone, true);
  assert.strictEqual(imported.articleWrites.length, 1, 'only local import may write this article result');
  assert.strictEqual(imported.state().active, 0);
  assertNoFailure(imported);

  const generation = createRun();
  const oldA = generation.thread('old-generation-a'), oldB = generation.thread('old-generation-b');
  generation.queue(oldA); generation.queue(oldB); await generation.flush();
  await generation.grantNext();
  generation.sandbox.ATPState.generation++;
  const next = generation.thread('new-generation', { visible: true });
  next.resources = generation.resources(5);
  generation.queue(next);
  generation.poll(); await generation.flush();
  assert.strictEqual(next.textResourcesAutoActive, true, 'the cancelled old waiter must free a slot for the new generation');
  generation.respond(generation.requests[0], magnet(6)); await generation.flush();
  assert.strictEqual(generation.count(oldA), 0, 'a stale generation must ignore old network results');
  assert.strictEqual(generation.count(next), 1, 'an old callback must not mutate the new generation');
  assert.strictEqual(next.textResourcesLoading, true);
  await generation.drain();
  assert.strictEqual(next.textResourcesDone, true);
  assert.strictEqual(generation.articleWrites.length, 1);
  assertNoFailure(generation);
}

async function checkLateCallbackKeepsRequeuedWork() {
  const run = createRun();
  const a = run.thread('late-a'), b = run.thread('late-b'), visible = run.thread('late-visible', { visible: true });
  run.queue(a); run.queue(b); await run.flush();
  run.queue(visible);
  // The yielding continuation queues its replacement before logging. A late
  // rejected continuation must not clear that queue flag or release twice.
  run.throwYieldDiagnosticOnce();
  run.poll(); await run.microtasks();
  assert.strictEqual(a.textResourcesAutoQueued, true);
  assert.strictEqual(b.textResourcesAutoQueued, true);
  assert.strictEqual(run.state().active, 0);
  await run.flush(); await run.grantNext();
  assert.strictEqual(run.requests[0].url, visible.textAttachments[0].url);
  await run.drain();
  assert([a, b, visible].every(state => state.textResourcesDone));
  assertNoFailure(run);
}

async function main() {
  await checkWaitingPriorityAndResume();
  await checkInflightSlots();
  await checkPartialResourceRetention();
  await checkFreshExtractionYield();
  await checkImportAndGeneration();
  await checkLateCallbackKeepsRequeuedWork();
  console.log('TXT visible queue integration tests ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
