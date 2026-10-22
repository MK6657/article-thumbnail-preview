'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function element(tag) {
  const classes = new Set();
  return {
    tagName: tag, style: {}, children: [], parentNode: null, connected: true,
    classList: { add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); }, contains(name) { return classes.has(name); } },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 82, right: 110 }; },
    querySelector(selector) { return this.children.find(child =>
      selector === '.atp-thumbnail-img' && child.tagName === 'img' ||
      selector === '.atp-thumbnail-loading' && child.className === 'atp-thumbnail-loading') || null; }
  };
}

function createRun(extraSettings) {
  let now = 10000, sequence = 0, timerId = 0;
  const events = [], infos = [], timers = new Map();
  class ClockDate extends Date { static now() { return now; } }
  const sandbox = {
    Date: ClockDate, URL, TextDecoder, console,
    innerWidth: 1000, innerHeight: 800,
    addEventListener() {}, removeEventListener() {},
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    document: {
      visibilityState: 'visible', documentElement: {},
      addEventListener() {}, removeEventListener() {},
      contains(node) { return !!node && node.connected !== false; },
      createElement: element
    },
    Logger: {
      // All success measurements must work with DEBUG disabled.
      isEnabled: level => level !== 'DEBUG',
      event(type, fields, level) { events.push({ type, fields, level }); },
      info(label, message) { infos.push({ label, message }); },
      debug() {}, warn() {}, error() {}
    },
    ATPCache: { scheduleCacheFlush() {}, flushCacheNow() {} },
    ATPState: { generation: 0, threads: {}, settings: Object.assign({
      firstScreenConcurrency: 8, backgroundConcurrency: 2,
      globalImageConcurrency: 12, ordinaryHostAdaptive: false,
      ordinaryHostConcurrency: 8, heavyImageOptimization: false,
      pauseWhenHidden: true, imageTimeout: 10000, imageTaskDeadline: 16000,
      maxRetryPerImage: 0, thumbWidth: 110, thumbHeight: 82
    }, extraSettings || {}) }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const name of ['shared-utils.js', 'loading-policy.js', 'loader.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), sandbox, { filename: name });
  }
  const loader = sandbox.ATPLoader;
  // Keep dispatch deterministic; all starts still use production direct
  // request/slot/cancellation/retry/success handlers below.
  loader.globalSchedule = function() {};
  return {
    loader, sandbox, events, infos,
    advance(ms) { now += ms; },
    register(count, urls) {
      const id = 'timing-' + (++sequence);
      const candidates = Array.from({ length: count }, (_, idx) => ({ src: urls && urls[idx] !== undefined ? urls[idx] : 'https://img.example/' + id + '-' + idx + '.jpg' }));
      const ts = {
        id, generation: 0, candidates, sourceCandidates: candidates,
        firstScreenTotal: count, firstScreenOk: 0, firstScreenFailed: 0,
        firstScreenDone: false, firstTasks: [], firstTaskOffset: 0,
        nextIdx: count, total: count, loaded: 0, failedCount: 0,
        loadedUrls: [], loadedUrlMap: {}, resources: {},
        grid: element('div'), container: element('div'), statusEl: {},
        backgroundUnlocked: false
      };
      ts.firstTasks = candidates.map((_, idx) => ({
        threadId: id, generation: 0, idx, candidates, grid: ts.grid,
        isFirstScreen: true, createdAt: now, queuedAt: now
      }));
      sandbox.ATPState.threads[id] = ts;
      loader.registerFirstScreenTiming(ts);
      return ts;
    },
    start(task) {
      const wrapper = element('div'), loading = element('div');
      wrapper.appendChild(loading);
      task.grid.appendChild(wrapper);
      loader.loadImageDirect(wrapper, loading, task, task.candidates[task.idx]);
      return wrapper.children.find(child => child.tagName === 'img');
    },
    viewportStart(task) {
      if (!sandbox.ATPViewport) {
        vm.runInContext(fs.readFileSync(path.join(root, 'viewport-observer.js'), 'utf8'), sandbox, { filename: 'viewport-observer.js' });
      }
      const wrapper = element('div'), loading = element('div');
      loading.className = 'atp-thumbnail-loading';
      wrapper.appendChild(loading);
      task.grid.appendChild(wrapper);
      const data = { task, imgData: task.candidates[task.idx], loaded: false, inViewport: true, actualInViewport: true, observerRoot: null };
      assert(sandbox.ATPViewport.loadWrapper(wrapper, data, false));
      return { wrapper, data, image() { return wrapper.children.find(child => child.tagName === 'img'); } };
    },
    visibility(value) {
      sandbox.document.visibilityState = value;
      loader.syncVisibilityPauseState();
    },
    flushZeroTimers() {
      for (const [id, timer] of Array.from(timers)) {
        if (timer.delay !== 0 || !timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    summary() {
      const records = events.filter(event => event.type === 'first_screen_timing');
      assert.strictEqual(records.length, 1, 'emit exactly one INFO aggregate for this first screen');
      assert.strictEqual(records[0].level, 'INFO');
      return records[0].fields;
    }
  };
}

function checkPartition(fields) {
  assert.strictEqual(fields.queueWaitTotalMs + fields.hiddenPauseTotalMs + fields.requestTotalMs,
    fields.taskElapsedTotalMs, 'task sums partition lifetime without overlap');
  assert.strictEqual(fields.lastTaskQueueWaitMs + fields.lastTaskHiddenPauseMs + fields.lastTaskRequestMs,
    fields.lastTaskElapsedMs, 'last completed task has an additive lifetime breakdown');
  assert.strictEqual(fields.lastTaskStartOffsetMs + fields.lastTaskElapsedMs, fields.wallClockMs);
  assert.strictEqual(fields.totalsBasis, 'parallel_task_sum');
}

// Two parallel 500ms requests take 650ms including admission, not 1250ms.
const parallel = createRun();
const parallelThread = parallel.register(2);
const [a, b] = parallelThread.firstTasks;
parallel.advance(100);
const aImg = parallel.start(a);
parallel.advance(50);
const bImg = parallel.start(b);
parallel.advance(450);
aImg.onload();
parallel.advance(50);
bImg.onload();
const parallelFields = parallel.summary();
assert.strictEqual(parallelFields.wallClockMs, 650);
assert.strictEqual(parallelFields.queueWaitTotalMs, 250);
assert.strictEqual(parallelFields.requestTotalMs, 1000);
assert.strictEqual(parallelFields.taskElapsedTotalMs, 1250);
assert.strictEqual(parallelFields.lastTaskQueueWaitMs, 150);
assert.strictEqual(parallelFields.maxQueueWaitMs, 150);
assert.strictEqual(parallelFields.requestCount, 2);
checkPartition(parallelFields);
assert(!parallel.infos.some(record => record.message.includes('直载')), 'a direct request can still have long queue/offscreen wait');
parallel.loader.threadImageDone(b, true);
assert.strictEqual(parallel.events.filter(event => event.type === 'first_screen_timing').length, 1);

// Hidden interruption cancels and requeues a real request. The old queuedAt
// and loadStartAt are reset in production; the aggregate must survive both.
const hidden = createRun();
const hiddenThread = hidden.register(1);
const hiddenTask = hiddenThread.firstTasks[0];
hidden.advance(100);
const cancelledImg = hidden.start(hiddenTask);
hidden.advance(250);
hidden.visibility('hidden');
assert.strictEqual(cancelledImg.onload, null);
assert.strictEqual(hiddenTask.loadStartAt, 0);
hidden.advance(1000);
hidden.visibility('visible');
hidden.advance(100);
const resumedImg = hidden.start(hiddenTask);
hidden.advance(200);
resumedImg.onload();
const hiddenFields = hidden.summary();
assert.strictEqual(hiddenFields.wallClockMs, 1650);
assert.strictEqual(hiddenFields.queueWaitTotalMs, 200);
assert.strictEqual(hiddenFields.hiddenPauseTotalMs, 1000);
assert.strictEqual(hiddenFields.requestTotalMs, 450);
assert.strictEqual(hiddenFields.hiddenInterruptions, 1);
assert.strictEqual(hiddenFields.requestCount, 2);
checkPartition(hiddenFields);

// A pending viewport task stays queued, including its relay wait; hidden
// time is excluded from both queue and the viewport subset. Repeated hidden
// synchronization must not count a single pause twice.
const viewport = createRun();
const viewportThread = viewport.register(1);
const viewportTask = viewportThread.firstTasks[0];
viewport.advance(100);
viewport.loader.noteFirstScreenViewportWait(viewportTask);
viewport.advance(200);
viewport.visibility('hidden');
viewport.advance(400);
viewport.visibility('hidden');
viewport.advance(600);
viewport.visibility('visible');
viewport.advance(300);
const viewportImg = viewport.start(viewportTask);
viewport.advance(100);
viewportImg.onload();
const viewportFields = viewport.summary();
assert.strictEqual(viewportFields.queueWaitTotalMs, 600);
assert.strictEqual(viewportFields.viewportWaitTotalMs, 500);
assert.strictEqual(viewportFields.hiddenPauseTotalMs, 1000);
assert.strictEqual(viewportFields.requestTotalMs, 100);
assert.strictEqual(viewportFields.viewportParkedTasks, 1);
checkPartition(viewportFields);

// Exercise the real viewport relay's cancellation and observer requeue as
// well as the direct loader path. Successful viewport loads skip DEBUG
// logImageDone entirely, so slot/source hooks must still capture this case.
const relay = createRun();
const relayThread = relay.register(1);
const relayTask = relayThread.firstTasks[0];
relay.loader.noteFirstScreenViewportWait(relayTask);
relay.advance(200);
const relayLoad = relay.viewportStart(relayTask);
relay.advance(100);
relay.visibility('hidden');
assert.strictEqual(relayLoad.data.loaded, false);
relay.advance(500);
relay.visibility('visible');
if (!relayLoad.data.loaded) {
  relayLoad.data.inViewport = true;
  assert(relay.sandbox.ATPViewport.loadWrapper(relayLoad.wrapper, relayLoad.data, false));
}
relay.advance(150);
relayLoad.image().onload();
const relayFields = relay.summary();
assert.strictEqual(relayFields.wallClockMs, 950);
assert.strictEqual(relayFields.queueWaitTotalMs, 200);
assert.strictEqual(relayFields.viewportWaitTotalMs, 200);
assert.strictEqual(relayFields.hiddenPauseTotalMs, 500);
assert.strictEqual(relayFields.requestTotalMs, 250);
assert.strictEqual(relayFields.requestCount, 2);
checkPartition(relayFields);

// An automatic retry includes both failed request attempts and the retry's
// fresh queue gap; referrer fallback is an additional actual src assignment.
const retry = createRun({ maxRetryPerImage: 1 });
const retryThread = retry.register(1);
const retryTask = retryThread.firstTasks[0];
retry.advance(100);
const failedImg = retry.start(retryTask);
retry.advance(50);
failedImg.onerror();
retry.flushZeroTimers();
retry.advance(50);
failedImg.onerror();
assert.strictEqual(retryTask.retries, 1);
assert.strictEqual(retryThread.firstScreenDone, false);
retry.advance(75);
const retriedImg = retry.start(retryTask);
retry.advance(125);
retriedImg.onload();
const retryFields = retry.summary();
assert.strictEqual(retryFields.wallClockMs, 400);
assert.strictEqual(retryFields.queueWaitTotalMs, 175);
assert.strictEqual(retryFields.requestTotalMs, 225);
assert.strictEqual(retryFields.requestCount, 3);
checkPartition(retryFields);

// The no-referrer path deliberately defers src assignment. Slot admission
// alone is not a download and must remain in queue until that timer runs.
const deferred = createRun();
const deferredThread = deferred.register(1, ['https://image.imx.to/deferred.jpg']);
deferred.advance(100);
const deferredImg = deferred.start(deferredThread.firstTasks[0]);
deferred.advance(80);
deferred.flushZeroTimers();
deferred.advance(120);
deferredImg.onload();
const deferredFields = deferred.summary();
assert.strictEqual(deferredFields.queueWaitTotalMs, 180);
assert.strictEqual(deferredFields.requestTotalMs, 120);
checkPartition(deferredFields);

// A hidden cancellation before the deferred src timer prevents the request;
// its late timer must not create phantom request time/count after cancellation.
const cancelled = createRun();
const cancelledThread = cancelled.register(1, ['https://image.imx.to/cancelled.jpg']);
const cancelledTask = cancelledThread.firstTasks[0];
cancelled.advance(100);
cancelled.start(cancelledTask);
cancelled.visibility('hidden');
cancelled.advance(500);
cancelled.flushZeroTimers();
cancelled.visibility('visible');
cancelled.advance(50);
const freshImg = cancelled.start(cancelledTask);
cancelled.flushZeroTimers();
cancelled.advance(100);
freshImg.onload();
const cancelledFields = cancelled.summary();
assert.strictEqual(cancelledFields.requestCount, 1);
assert.strictEqual(cancelledFields.queueWaitTotalMs, 150);
assert.strictEqual(cancelledFields.hiddenPauseTotalMs, 500);
assert.strictEqual(cancelledFields.requestTotalMs, 100);
checkPartition(cancelledFields);

// Disabling pauseWhenHidden really continues downloading in the background.
const allowed = createRun({ pauseWhenHidden: false });
const allowedThread = allowed.register(1);
allowed.advance(100);
const allowedImg = allowed.start(allowedThread.firstTasks[0]);
allowed.advance(100);
allowed.visibility('hidden');
allowed.advance(800);
allowedImg.onload();
const allowedFields = allowed.summary();
assert.strictEqual(allowedFields.hiddenPauseTotalMs, 0);
assert.strictEqual(allowedFields.requestTotalMs, 900);
checkPartition(allowedFields);

// Tasks created while already hidden must start their pause at creation,
// including tasks that never have a viable source and all-failed screens.
const empty = createRun();
empty.visibility('hidden');
empty.advance(300);
const emptyThread = empty.register(1, ['']);
empty.advance(600);
empty.visibility('visible');
empty.advance(100);
empty.loader.globalLoadImage(emptyThread.firstTasks[0]);
const emptyFields = empty.summary();
assert.strictEqual(emptyFields.failed, 1);
assert.strictEqual(emptyFields.wallClockMs, 700);
assert.strictEqual(emptyFields.queueWaitTotalMs, 100);
assert.strictEqual(emptyFields.hiddenPauseTotalMs, 600);
assert.strictEqual(emptyFields.requestCount, 0);
checkPartition(emptyFields);

console.log('First screen timing lifecycle tests ok');
