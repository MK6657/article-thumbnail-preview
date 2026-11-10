const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const host = 'lane.example';

function createRun(extraSettings) {
  const sandbox = {
    URL, TextDecoder, console,
    setTimeout: function() { return 1; },
    clearTimeout: function() {},
    addEventListener: function() {},
    removeEventListener: function() {},
    document: {
      visibilityState: 'visible',
      addEventListener: function() {},
      removeEventListener: function() {},
      contains: function() { return true; }
    },
    Logger: {
      isEnabled: function() { return false; },
      event: function() {}, info: function() {}, debug: function() {}, warn: function() {}, error: function() {}
    },
    ATPState: {
      generation: 0,
      threads: {},
      settings: Object.assign({
        firstScreenConcurrency: 12,
        backgroundConcurrency: 2,
        globalImageConcurrency: 14,
        ordinaryHostConcurrency: 10,
        autoLoadOffscreenFirstRowsEnabled: true,
        ordinaryHostAdaptive: true,
        heavyImageOptimization: false,
        viewportPriorityReservedSlots: 7,
        imageTimeout: 8000,
        imageTaskDeadline: 16000
      }, extraSettings || {})
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const name of ['shared-utils.js', 'loading-policy.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), sandbox, { filename: name });
  }
  // Use the production loader and its real admission path; expose only
  // adaptive feedback/state needed to simulate a warmed-up lane in memory.
  const loaderSource = fs.readFileSync(path.join(root, 'loader.js'), 'utf8').replace(
    '  window.ATPLoader = ATPLoader;',
    '  window.__laneTest = { stats: getOrdinaryHostStats, outcome: noteLargeLaneOutcome, snapshot: getOrdinaryHostHealthSnapshot };\n  window.ATPLoader = ATPLoader;'
  );
  vm.runInContext(loaderSource, sandbox, { filename: 'loader.js' });
  let sequence = 0;
  return {
    loader: sandbox.ATPLoader,
    hooks: sandbox.__laneTest,
    settings: sandbox.ATPState.settings,
    task: function(extension, options) {
      return Object.assign({
        threadId: 'lane-' + (++sequence), generation: 0, idx: 0,
        candidates: [{ src: 'https://' + host + '/' + sequence + '.' + (extension || 'gif') }],
        isFirstScreen: true, viewportPriority: true, queuedAt: Date.now()
      }, options || {});
    },
    snapshot: function() { return sandbox.__laneTest.snapshot('https://' + host + '/test.gif', 12); },
    setLearnedWidth: function(width) { sandbox.__laneTest.stats(host, true).largeLaneLimit = width; }
  };
}

// Visible images keep the configured host width when prefetch is enabled.
const automatic = createRun();
assert.strictEqual(automatic.snapshot().ordinaryHostLimit, 10);
for (let i = 0; i < 5; i++) assert(automatic.loader.acquireSlot(automatic.task('gif', { readyImageQueue: true })));
const sixthGif = automatic.task('gif', { readyImageQueue: true });
assert.strictEqual(automatic.loader.acquireSlot(sixthGif), false, 'a sixth GIF must wait for its lane');
assert.strictEqual(automatic.loader.isLargeLaneBlocked(sixthGif), true);
for (let i = 0; i < 5; i++) assert(automatic.loader.acquireSlot(automatic.task('jpg')), 'static thumbnails must retain the other five host slots');
assert.strictEqual(automatic.loader.acquireSlot(automatic.task('jpg')), false, 'the total host cap must remain ten');

// Fast successful downloads still widen the starting lane from two to three,
// then stop widening. This exercises feedback through the same live slots
// that the production scheduler counts, rather than just checking a formula.
const feedback = createRun({ ordinaryHostConcurrency: 6 });
const first = feedback.task('gif');
const second = feedback.task('gif');
assert(feedback.loader.acquireSlot(first) && feedback.loader.acquireSlot(second));
feedback.loader.releaseSlot(first);
assert(feedback.hooks.outcome(first, first.candidates[0].src, 1000, false));
assert.strictEqual(feedback.snapshot().ordinaryHostLargeLimit, 3);
assert(feedback.loader.acquireSlot(feedback.task('gif')) && feedback.loader.acquireSlot(feedback.task('gif')));
feedback.loader.releaseSlot(second);
assert.strictEqual(feedback.hooks.outcome(second, second.candidates[0].src, 1000, false), false);
assert.strictEqual(feedback.hooks.stats(host, false).largeLaneLimit, 3, 'fast completions must not train beyond the effective automatic host share');

// A scroll can move the three running GIFs offscreen. Keep the existing
// single visible compensation slot, while respecting the overall host cap.
const scrolled = createRun({ ordinaryHostConcurrency: 6 });
scrolled.setLearnedWidth(5);
const oldVisible = [scrolled.task('gif'), scrolled.task('gif'), scrolled.task('gif')];
oldVisible.forEach(function(task) { assert(scrolled.loader.acquireSlot(task)); });
oldVisible.forEach(function(task) { task.currentlyVisible = false; task.viewportPriority = false; });
assert(scrolled.loader.acquireSlot(scrolled.task('gif')), 'one currently visible GIF must still escape an entirely offscreen lane');
assert.strictEqual(scrolled.loader.acquireSlot(scrolled.task('gif')), false, 'visible compensation must remain bounded');
assert(scrolled.loader.acquireSlot(scrolled.task('jpg')) && scrolled.loader.acquireSlot(scrolled.task('jpg')));
assert.strictEqual(scrolled.loader.acquireSlot(scrolled.task('jpg')), false);

// The regular host cap includes requests that were visible when admitted.
const manualList = {
  firstScreenConcurrency: 10,
  backgroundConcurrency: 4,
  globalImageConcurrency: 12,
  ordinaryHostConcurrency: 6,
  autoLoadOffscreenFirstRowsEnabled: false,
  viewportPriorityReservedSlots: 2
};
const scrollBatch = createRun(manualList);
const inFlight = Array.from({ length: 6 }, () => scrollBatch.task('jpg'));
inFlight.forEach(task => assert(scrollBatch.loader.acquireSlot(task)));
inFlight.forEach(task => { task.currentlyVisible = false; task.viewportPriority = false; });
const newlyVisible = scrollBatch.task('jpg');
assert.strictEqual(scrollBatch.loader.acquireSlot(newlyVisible), false,
  'ordinary host cap must include visible tasks that have scrolled away');
scrollBatch.loader.releaseSlot(inFlight[0]);
assert(scrollBatch.loader.acquireSlot(newlyVisible), 'a newly visible task must use the next free host slot');
assert.strictEqual(scrollBatch.snapshot().ordinaryHostActive, 6);

const prefetchBatch = createRun(manualList);
for (let i = 0; i < 4; i++) {
  assert(prefetchBatch.loader.acquireSlot(prefetchBatch.task('jpg', { viewportPriority: false })));
}
assert.strictEqual(prefetchBatch.loader.acquireSlot(prefetchBatch.task('jpg', { viewportPriority: false })), false,
  'offscreen first-row requests must leave two real host slots available');
assert(prefetchBatch.loader.acquireSlot(prefetchBatch.task('jpg')));
assert(prefetchBatch.loader.acquireSlot(prefetchBatch.task('jpg')));
assert.strictEqual(prefetchBatch.snapshot().ordinaryHostActive, 6);

const noReserve = createRun(Object.assign({}, manualList, { viewportPriorityReservedSlots: 0 }));
for (let i = 0; i < 6; i++) assert(noReserve.loader.acquireSlot(noReserve.task('jpg', { viewportPriority: false })));
assert.strictEqual(noReserve.loader.acquireSlot(noReserve.task('jpg')), false,
  'disabling the reserve still must keep the total host cap');

// Non-automatic mode and explicit manual retries retain their prior behavior.
const nonAutomatic = createRun({ autoLoadOffscreenFirstRowsEnabled: false });
nonAutomatic.setLearnedWidth(5);
assert.strictEqual(nonAutomatic.snapshot().ordinaryHostLimit, 10);
assert.strictEqual(nonAutomatic.snapshot().ordinaryHostLargeLimit, 5);
for (let i = 0; i < 5; i++) assert(nonAutomatic.loader.acquireSlot(nonAutomatic.task('gif')));
assert.strictEqual(nonAutomatic.loader.acquireSlot(nonAutomatic.task('gif')), false);
const manual = createRun();
manual.setLearnedWidth(5);
const runningGifs = Array.from({ length: 5 }, () => manual.task('gif', { readyImageQueue: true }));
runningGifs.forEach(task => assert(manual.loader.acquireSlot(task)));
const manualGif = manual.task('gif', { manualRetry: true, readyImageQueue: true });
assert.strictEqual(manual.loader.acquireSlot(manualGif), false, 'manual retry must wait for the GIF lane');
manual.loader.releaseSlot(runningGifs[0]);
assert(manual.loader.acquireSlot(manualGif), 'manual retry can use a released GIF slot');
assert.strictEqual(manual.loader.acquireSlot(manual.task('jpg', { manualRetry: true })), false,
  'each host must run at most one manual retry');
const fixed = createRun({ ordinaryHostAdaptive: false });
fixed.setLearnedWidth(5);
assert.strictEqual(fixed.snapshot().ordinaryHostLargeLimit, 2, 'fixed mode must retain its starting width');

console.log('image lane tests ok');
