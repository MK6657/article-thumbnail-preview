'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const dispatchSource = source.slice(source.indexOf('  async function processContainers('),
  source.indexOf('  function cacheFetchedArticleData('));
assert(dispatchSource.includes('var gateWaiters = [];'), 'article dispatch test must load the real worker pool');

function createDispatch() {
  let timerId = 0;
  const timers = new Map(), requests = [];
  const sandbox = {
    Promise, Date,
    scanGeneration: 0,
    articleVisibleBoostRequested: false,
    articleDispatchWake: null,
    window: {},
    document: {},
    Logger: { info() {}, warn() {} },
    ATPConfig: { isEnabled: () => true },
    ATPScanner: { shouldExcludeUrl: () => false, isArticlePageUrl: () => true },
    ATPCache: { getArticleCacheState: async () => ({ cached: null, negative: false }) },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    pauseScanningForHiddenPage: () => false,
    isArticleUrlInPageZone: () => true,
    isSameOriginUrl: () => true,
    getArticleGroupKey: url => url,
    getArticleFetchConcurrency: () => 2,
    getArticleQueueHighWatermark: () => 5,
    hasMoreProcessCandidates: () => false,
    getForumPacer: () => ({ PRIORITY_ARTICLE: 1, canStartNow: () => false }),
    getArticleJobViewportDistance: job => job.entries[0].visible ? 0 : 3000,
    isArticleJobVisible: job => job.entries[0].visible,
    fetchArticleJob: job => new Promise(resolve => requests.push({ job, resolve })),
    enqueueArticleCommit: () => Promise.resolve()
  };
  vm.createContext(sandbox);
  vm.runInContext(dispatchSource.replace('var gateWaiters = [];',
    'var gateWaiters = [];\n    window.gateSize = function() { return gateWaiters.length; };'), sandbox);
  return {
    sandbox, timers, requests,
    start(entries) { return sandbox.processContainers(entries, 0); },
    fireGateTimer() {
      const pending = Array.from(timers.entries()).find(([, timer]) => timer.delay === 1000);
      assert(pending, 'an idle worker must have a one-second gate timer');
      timers.delete(pending[0]);
      pending[1].fn();
    }
  };
}

function entry(id) {
  return { link: { href: 'https://forum.example/thread-' + id }, container: {}, visible: false };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function cancel(run, promise) {
  run.sandbox.scanGeneration++;
  for (const request of run.requests) request.resolve(null);
  // Generation changes also let idle workers finish on their next gate tick.
  if (run.timers.size) run.fireGateTimer();
  await settle();
  await promise;
  assert.strictEqual(run.sandbox.window.gateSize(), 0, 'cancelled scans must retain no gate waiters');
  assert.strictEqual(run.timers.size, 0, 'cancelled scans must retain no gate timers');
}

async function run() {
  // A paced offscreen fetch keeps one worker busy. Each second, the other
  // worker retries admission and parks again; finished waiters must not pile up.
  const repeated = createDispatch();
  const repeatedScan = repeated.start([entry('a'), entry('b')]);
  await settle();
  for (let tick = 0; tick < 5; tick++) {
    assert.strictEqual(repeated.sandbox.window.gateSize(), 1);
    repeated.fireGateTimer();
    assert.strictEqual(repeated.sandbox.window.gateSize(), 0,
      'a timed-out waiter must leave the gate before its worker resumes');
    await settle();
    assert.strictEqual(repeated.requests.length, 1, 'a gate recheck must not bypass forum pacing');
  }
  await cancel(repeated, repeatedScan);

  // A normal wake clears the timer, and an already-dispatched timeout callback
  // stays harmless even if it is delivered after the wake.
  const woken = createDispatch();
  const wokenScan = woken.start([entry('wake-a'), entry('wake-b')]);
  await settle();
  const lateTimer = Array.from(woken.timers.values())[0].fn;
  woken.sandbox.articleDispatchWake();
  assert.strictEqual(woken.sandbox.window.gateSize(), 0);
  assert.strictEqual(woken.timers.size, 0);
  lateTimer();
  await settle();
  assert.strictEqual(woken.sandbox.window.gateSize(), 1, 'the resumed worker must park only once');
  assert.strictEqual(woken.timers.size, 1);
  await cancel(woken, wokenScan);

  // Resizing or a layout change can reveal rows without a scroll wake. After
  // the idle worker takes one visible row on its timed recheck, the remaining
  // offscreen waiter must give its worker to the other visible row.
  const priority = createDispatch();
  const rows = [entry('old-offscreen'), entry('visible-b'), entry('visible-c')];
  const priorityScan = priority.start(rows);
  await settle();
  rows[1].visible = rows[2].visible = true;
  priority.fireGateTimer();
  await settle();
  assert.deepStrictEqual(priority.requests.map(request => request.job.url),
    [rows[0].link.href, rows[1].link.href]);
  const oldRequest = priority.requests[0];
  assert.strictEqual(oldRequest.job.shouldHandBack(oldRequest.job), true,
    'an expired gate waiter must not make a busy worker look idle and block visible work');
  oldRequest.job.handedBack = true;
  oldRequest.resolve(null);
  await settle();
  assert.strictEqual(priority.requests[2].job.url, rows[2].link.href,
    'the remaining visible row must take the handed-back worker');
  await cancel(priority, priorityScan);
  console.log('Article queue gate lifecycle tests ok');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
