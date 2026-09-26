const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(read('settings-schema.js') + '\nthis.SETTINGS_SCHEMA = SETTINGS_SCHEMA;', sandbox, {
  filename: 'settings-schema.js'
});
vm.runInContext(read('defaults.js'), sandbox, { filename: 'defaults.js' });
vm.runInContext(read('loading-policy.js'), sandbox, { filename: 'loading-policy.js' });

const normalize = sandbox.ATPNormalizeSettings;
const policy = sandbox.ATPLoadPolicy;
const heavyPreset = sandbox.ATPGetSettingsPreset('heavyOriginal', sandbox.SETTINGS_SCHEMA);
const gentleOrdinaryPreset = sandbox.ATPGetSettingsPreset('ordinaryGentle', sandbox.SETTINGS_SCHEMA);
const balancedOrdinaryPreset = sandbox.ATPGetSettingsPreset('ordinaryBalanced', sandbox.SETTINGS_SCHEMA);
const fastOrdinaryPreset = sandbox.ATPGetSettingsPreset('ordinaryFast', sandbox.SETTINGS_SCHEMA);

assert.strictEqual(typeof normalize, 'function');
assert.strictEqual(typeof policy, 'object');
assert.strictEqual(heavyPreset.heavyImageConcurrency, sandbox.ATP_DEFAULTS.heavyImageConcurrency, 'heavy preset must be generated from schema defaults');
assert.strictEqual(heavyPreset.heavyDecodedBudgetMP, sandbox.ATP_DEFAULTS.heavyDecodedBudgetMP, 'heavy preset must include expert render budgets');
assert.strictEqual(heavyPreset.heavyFailureThreshold, sandbox.ATP_DEFAULTS.heavyFailureThreshold, 'heavy preset must include host state settings');
assert(!Object.prototype.hasOwnProperty.call(heavyPreset, 'backgroundConcurrency'), 'heavy preset must not reset unrelated ordinary background settings');
assert.strictEqual(gentleOrdinaryPreset.firstScreenConcurrency, 6, '100M ordinary preset must keep useful visible concurrency');
assert.strictEqual(balancedOrdinaryPreset.firstScreenConcurrency, 8, '200M ordinary preset must speed up visible weak images');
assert.strictEqual(fastOrdinaryPreset.firstScreenConcurrency, 12, 'fast ordinary preset must expose a higher visible weak-image ceiling');
assert.strictEqual(balancedOrdinaryPreset.viewportPriorityReservedSlots, 5, '200M ordinary preset must reserve capacity for visible images');
assert.strictEqual(fastOrdinaryPreset.ordinaryHostConcurrency, 10, 'fast ordinary preset must coordinate host concurrency with visible concurrency');
assert.strictEqual(fastOrdinaryPreset.backgroundConcurrency, 2, 'fast ordinary preset must keep offscreen work subordinate to visible images');
assert.strictEqual(fastOrdinaryPreset.globalImageConcurrency, 0, 'ordinary presets must reset stale explicit global ceilings to automatic mode');
assert.strictEqual(fastOrdinaryPreset.viewportPendingLimit, 24, 'ordinary presets must bound viewport pending work');
assert.strictEqual(fastOrdinaryPreset.imageTaskDeadline, 16000, 'fast ordinary preset must share a finite deadline across retries');
assert.strictEqual(fastOrdinaryPreset.ordinaryHostHardLimit, 2, 'fast ordinary preset must keep a non-blocking hard host lane');
assert.strictEqual(fastOrdinaryPreset.backgroundDelayMs, -1, 'ordinary presets must reactivate their public background speed choice');
assert(!Object.prototype.hasOwnProperty.call(fastOrdinaryPreset, 'heavyImageConcurrency'), 'ordinary presets must not modify independent heavy-image settings');

const configured = normalize({
  firstScreenConcurrency: 48,
  backgroundConcurrency: 36,
  globalImageConcurrency: 72,
  ordinaryHostConcurrency: 28,
  ordinaryHostRecoverySuccesses: 11,
  heavyImageConcurrency: 40,
  heavySchedulingMode: 'fixed',
  heavyCircuitBreaker: false,
  imageTimeout: 44000,
  heavyImageTimeout: 0,
  heavyWarmupConcurrency: 19,
  heavyProbeConcurrency: 7,
  ordinaryReservedSlots: 9,
  viewportPriorityReservedSlots: 13,
  ordinaryFallbackLimit: 37,
  heavyFallbackLimit: 17,
  imageTaskDeadline: 180000,
  heavyDecodedBudgetMP: 0,
  heavyVisibleBudgetMP: 0,
  heavyDecodedImageLimit: 0,
  articleFetchConcurrency: 18,
  articleQueueHighWatermark: 60,
  articleTimeout: 75000,
  viewportPendingLimit: 240,
  backgroundDelayMs: 0
});

assert.strictEqual(policy.getHeavyConcurrencyCeiling(configured), 40, 'heavy ceiling must preserve a valid user value above the old cap');
assert.strictEqual(policy.getGlobalImageConcurrency(configured, 48, 40), 72, 'explicit global image concurrency must be authoritative');
assert.strictEqual(policy.getOrdinaryHostConcurrency(configured), 28, 'ordinary host concurrency must preserve a valid user value above the old cap');
assert.strictEqual(policy.getOrdinaryHostRecoverySuccesses(configured), 11, 'ordinary host recovery threshold must come from settings');
assert.strictEqual(policy.getHeavyImageTimeout(configured), 44000, 'heavy timeout=0 must inherit the full image timeout without an 8s clamp');
assert.strictEqual(policy.getHeavyWarmupConcurrency(configured), 19, 'warmup concurrency must come from settings');
assert.strictEqual(policy.getHeavyProbeConcurrency(configured), 7, 'probe concurrency must come from settings');
assert.strictEqual(policy.getOrdinaryReservedSlots(configured), 9, 'ordinary reserved slots must come from settings');
assert.strictEqual(policy.getViewportPriorityReservedSlots(configured), 13, 'viewport priority reserve must come from its independent public setting');
assert.strictEqual(policy.getOrdinaryFallbackLimit(configured), 37, 'ordinary fallback count must preserve a valid user value above the old cap');
assert.strictEqual(policy.getHeavyFallbackLimit(configured), 17, 'heavy fallback count must come from settings');
assert.strictEqual(policy.getImageTaskDeadline(configured), 180000, 'task deadline must come from settings');
assert.strictEqual(policy.getHeavyDecodedBudgetMP(configured), 0, 'zero decoded MP budget must remain unlimited');
assert.strictEqual(policy.getHeavyVisibleBudgetMP(configured), 0, 'zero visible MP budget must remain unlimited');
assert.strictEqual(policy.getHeavyDecodedImageLimit(configured), 0, 'zero decoded image count must remain unlimited');
assert.strictEqual(policy.getArticleFetchConcurrency(configured), 18, 'article concurrency must preserve a valid user value');
assert.strictEqual(policy.getArticleQueueHighWatermark(configured), 60, 'article queue watermark must preserve a valid user value');
assert.strictEqual(policy.getArticleTimeout(configured), 75000, 'article timeout must preserve a valid user value');
assert.strictEqual(policy.getViewportPendingLimit(configured, 36), 240, 'explicit viewport pending limit must be authoritative');
assert.strictEqual(policy.getBackgroundDelay(configured), 0, 'zero background delay must be supported');
assert.strictEqual(policy.getHeavySchedulingMode(configured), 'fixed');
assert.strictEqual(policy.isHeavyCircuitBreakerEnabled(configured), false);

const auto = normalize({
  firstScreenConcurrency: 14,
  backgroundConcurrency: 11,
  globalImageConcurrency: 0,
  heavyImageConcurrency: 20,
  viewportPendingLimit: 0
});

assert.strictEqual(policy.getGlobalImageConcurrency(auto, 14, 20), 34, 'automatic global concurrency must preserve both ordinary and heavy channel ceilings');
assert(policy.getViewportPendingLimit(auto, 11) >= 88, 'automatic pending limit must scale with the public background setting');

assert.strictEqual(policy.getLargeImageTaskDeadline({ imageTaskDeadline: 16000 }), 48000, 'GIFs must get three times the task deadline');
assert.strictEqual(policy.getLargeImageTaskDeadline({ imageTaskDeadline: 8000 }), 45000, 'the GIF task deadline must not drop below 45s');
assert.strictEqual(policy.getLargeImageTaskDeadline({ imageTaskDeadline: 0 }), 0, 'GIFs must have no task deadline when none is configured');
assert.strictEqual(policy.getLargeImageTimeout({ imageTimeout: 8000 }), 30000, 'the GIF per-attempt timeout must not drop below 30s');
assert.strictEqual(policy.getLargeImageTimeout({ imageTimeout: 15000 }), 45000, 'GIFs must get three times the per-attempt timeout');
assert.strictEqual(policy.getLargeImageTimeout({ imageTimeout: 0 }), 45000, 'a zero image timeout must fall back to the default before scaling');
assert.strictEqual(policy.getLargeImageHostConcurrency({}), 2, 'the GIF lane must start at two GIFs per ordinary host');
assert.strictEqual(policy.getLargeImageFastMs({ imageTimeout: 8000 }), 3200, 'a GIF within 40% of the image timeout counts as fast');
assert.strictEqual(policy.getLargeImageFastMs({ imageTimeout: 3000 }), 2000, 'the fast GIF threshold must not drop below 2s');
assert.strictEqual(policy.getLargeImageFastMs({ imageTimeout: 60000 }), 5000, 'the fast GIF threshold must not exceed 5s');
assert.strictEqual(policy.getLargeImageSlowMs({ imageTimeout: 8000 }), 8000, 'a GIF slower than the image timeout counts as slow');
assert.strictEqual(policy.getLargeImageSlowMs({ imageTimeout: 3000 }), 6000, 'the slow GIF threshold must not drop below 6s');
assert.strictEqual(policy.getLargeImageSlowMs({ imageTimeout: 60000 }), 15000, 'the slow GIF threshold must not exceed 15s');
const snapshotWithLane = policy.getPublicSnapshot({ imageTimeout: 8000, imageTaskDeadline: 16000 });
assert(snapshotWithLane.largeImageTimeout === 30000 && snapshotWithLane.largeImageTaskDeadline === 48000 &&
  snapshotWithLane.largeImageHostConcurrency === 2, 'the public policy snapshot must report the GIF lane settings');

console.log('loading policy tests passed');
