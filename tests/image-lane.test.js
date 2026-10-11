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

// The user's measured configuration: configured host width 10, effective
// automatic width 6. Even a previously learned GIF width 5 must now use 3.
const automatic = createRun();
automatic.setLearnedWidth(5);
assert.strictEqual(automatic.snapshot().ordinaryHostLimit, 6);
assert.strictEqual(automatic.snapshot().ordinaryHostLargeLimit, 3);
for (let i = 0; i < 3; i++) assert(automatic.loader.acquireSlot(automatic.task('gif')));
const fourthGif = automatic.task('gif');
assert.strictEqual(automatic.loader.acquireSlot(fourthGif), false, 'a fourth visible GIF must wait for its lane');
assert.strictEqual(automatic.loader.isLargeLaneBlocked(fourthGif), true);
for (let i = 0; i < 3; i++) assert(automatic.loader.acquireSlot(automatic.task('jpg')), 'static thumbnails must retain the other three host slots');
assert.strictEqual(automatic.loader.acquireSlot(automatic.task('jpg')), false, 'the total host safety cap must remain six');

// Fast successful downloads still widen the starting lane from two to three,
// then stop widening. This exercises feedback through the same live slots
// that the production scheduler counts, rather than just checking a formula.
const feedback = createRun();
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
const scrolled = createRun();
scrolled.setLearnedWidth(5);
const oldVisible = [scrolled.task('gif'), scrolled.task('gif'), scrolled.task('gif')];
oldVisible.forEach(function(task) { assert(scrolled.loader.acquireSlot(task)); });
oldVisible.forEach(function(task) { task.currentlyVisible = false; task.viewportPriority = false; });
assert(scrolled.loader.acquireSlot(scrolled.task('gif')), 'one currently visible GIF must still escape an entirely offscreen lane');
assert.strictEqual(scrolled.loader.acquireSlot(scrolled.task('gif')), false, 'visible compensation must remain bounded');
assert(scrolled.loader.acquireSlot(scrolled.task('jpg')) && scrolled.loader.acquireSlot(scrolled.task('jpg')));
assert.strictEqual(scrolled.loader.acquireSlot(scrolled.task('jpg')), false);

// Non-automatic mode and explicit manual retries retain their prior behavior.
const nonAutomatic = createRun({ autoLoadOffscreenFirstRowsEnabled: false });
nonAutomatic.setLearnedWidth(5);
assert.strictEqual(nonAutomatic.snapshot().ordinaryHostLimit, 10);
assert.strictEqual(nonAutomatic.snapshot().ordinaryHostLargeLimit, 5);
for (let i = 0; i < 5; i++) assert(nonAutomatic.loader.acquireSlot(nonAutomatic.task('gif')));
assert.strictEqual(nonAutomatic.loader.acquireSlot(nonAutomatic.task('gif')), false);
const manual = createRun();
manual.setLearnedWidth(5);
for (let i = 0; i < 3; i++) assert(manual.loader.acquireSlot(manual.task('gif')));
assert(manual.loader.acquireSlot(manual.task('gif', { manualRetry: true })), 'explicit retries must keep their existing lane bypass');
const fixed = createRun({ ordinaryHostAdaptive: false });
fixed.setLearnedWidth(5);
assert.strictEqual(fixed.snapshot().ordinaryHostLargeLimit, 2, 'fixed mode must retain its starting width');

console.log('image lane tests ok');
