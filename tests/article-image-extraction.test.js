'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const origin = 'https://www.sehuatang.org';
const url = origin + '/thread-175-1-1.html';
const gallery = '<html><body><div id="postlist">' + Array.from({ length: 60 }, (_, index) =>
  '<img src="https://img.example/frame-' + (index + 1) + '.jpg">').join('\n') + '</div>' + ' '.repeat(300001) + '</body></html>';
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function makeRun(options = {}) {
  let now = 10000;
  let frames = 0;
  const settings = { maxImagesPerPost: 100, maxDisplayPerPost: 100, articleTimeout: options.timeout || 3000 };
  const logger = { isEnabled: () => false, debug() {}, info() {}, warn() {}, error() {} };
  const sandbox = vm.createContext({
    URL, TextEncoder, TextDecoder, AbortController, Response, console, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now; } },
    performance: { now() { return now; } },
    requestAnimationFrame(callback) { frames++; queueMicrotask(callback); },
    document: { visibilityState: 'visible' },
    location: new URL(url),
    navigator: { onLine: true },
    chrome: {},
    ATPState: { settings },
    Logger: logger,
    BGLOG: logger,
    fetch: async () => new Response(gallery, { headers: { 'content-type': 'text/html' } }),
    originAllowed: () => true,
    shortUrl: () => '',
    clearArticleFetchControl() {}
  });
  sandbox.window = sandbox;
  for (const filename of ['shared-utils.js', 'html-extractors.js', 'loading-policy.js', 'cache.js']) {
    vm.runInContext(read(filename), sandbox, { filename });
  }
  const utils = vm.runInContext('SharedUtils', sandbox);
  const normalize = utils.normalizeImageUrl;
  utils.normalizeImageUrl = function(value) {
    if (/frame-\d+\.jpg/.test(value)) now += 8;
    return normalize.call(this, value);
  };

  const writes = [];
  const cache = sandbox.ATPCache;
  cache.setCachedArticleData = (key, data, complete) => writes.push({ key, data, complete });
  cache.setNegativeCache = () => assert.fail('a complete or deadline-limited image result must avoid a negative cache');
  vm.runInContext(read('fetcher.js'), sandbox, { filename: 'fetcher.js' });
  const background = read('background.js');
  const start = background.indexOf('function waitForArticleDeadline(promise, deadline)');
  const end = background.indexOf('function isPlainObject(', start);
  assert(start !== -1 && end > start);
  vm.runInContext(`
    const TEXT_ATTACHMENT_MAX_COUNT = SharedUtils.TEXT_ATTACHMENT_MAX_COUNT;
    function normalizeImageExtractionSettings(settings) { return settings; }
    function getRemainingDeadlineMs(deadline) { return deadline - Date.now(); }
    function makeDeadlineArticleResult() { return { reason: 'deadline_exhausted', retryableEmpty: true, images: [] }; }
    ${background.slice(start, end)}
  `, sandbox);

  return {
    sandbox, utils, writes, settings, frames: () => frames,
    advance(ms) { now += ms; },
    content() { return sandbox.ATPFetcher._fetchArticleNetwork(url, now); },
    worker(timeout) {
      const deadline = now + timeout;
      const request = sandbox.fetchArticle(url, settings, deadline, {
        abortAt: deadline,
        controller: new AbortController()
      });
      return sandbox.waitForArticleDeadline(request, deadline);
    }
  };
}

function sources(images) {
  return Array.from(images, image => image.src);
}

function checkImageDecorationFilter() {
  const { utils } = makeRun();
  const kept = [
    'https://icon-cdn.example/gallery/01.jpg',
    'https://img.example/gallery/02.jpg?sig=contains-logo',
    'https://img.example/gallery/03.jpg#avatar',
    origin + '/forum.php?mod=attachment&aid=4&file=logo.jpg'
  ];
  const filtered = [
    'https://img.example/static/image/common/pin_1.gif',
    'https://img.example/gallery/avatar.png',
    'https://img.example/gallery/a.svg?token=example',
    'https://img.example/gallery/logo.png?note=aid=4'
  ];
  const html = kept.concat(filtered).map(src => `<img src="${src.replaceAll('&', '&amp;')}">`).join('');
  assert.deepEqual(sources(utils.extractImagesByRegex(html, url, 10)), kept,
    'hostnames, signatures and fragments must not turn gallery images into decorations');
}

async function checkSlicesAndBoundaries() {
  const run = makeRun();
  let tokenizations = 0;
  let frame = 0;
  let longestSlice = 0;
  const original = run.utils.iterateImageExtractionByRegex;
  run.utils.iterateImageExtractionByRegex = function(...args) {
    tokenizations++;
    return original.apply(this, args);
  };
  const expected = run.utils.extractImagesForSettings(gallery, url, run.settings);
  const startedAt = run.sandbox.performance.now();
  let sliceStartedAt = startedAt;
  const result = await run.utils.extractImagesForSettingsInSlices(gallery, url, run.settings, {
    clock: run.sandbox.performance.now,
    deadline: () => startedAt + 3000,
    sliceMs: 12,
    async yieldSlice() {
      const now = run.sandbox.performance.now();
      longestSlice = Math.max(longestSlice, now - sliceStartedAt);
      sliceStartedAt = now;
      frame++;
    }
  });
  assert(run.sandbox.performance.now() - startedAt > 250, 'the fixture must cross the former total extraction cap');
  assert(frame > 1, 'a slow image set must let multiple frames run');
  assert(longestSlice <= 16, 'a slice may finish its current image before yielding');
  assert.equal(tokenizations, 2, 'each extraction starts exactly one tokenizer');
  assert.equal(result.partial, false);
  assert.deepEqual(sources(result.images), sources(expected));
  assert.equal(result.images.length, 60);

  const cutoff = run.sandbox.performance.now() + 240;
  const partial = await run.utils.extractImagesForSettingsInSlices(gallery, url, run.settings, {
    clock: run.sandbox.performance.now,
    deadline: () => cutoff,
    sliceMs: 12,
    async yieldSlice() {}
  });
  assert(partial.images.length > 0 && partial.images.length < 60);
  assert.equal(partial.partial, true, 'a real caller deadline must mark the usable prefix partial');

  const limit = { maxImagesPerPost: 10, maxDisplayPerPost: 10 };
  const hardLimit = await run.utils.extractImagesForSettingsInSlices(gallery, url, limit, {
    clock: run.sandbox.performance.now, deadline: () => Infinity, sliceMs: 12, async yieldSlice() {}
  });
  assert.equal(hardLimit.images.length, 10);
  assert.equal(hardLimit.partial, false, 'reaching the configured count is a complete extraction');
}

async function main() {
  checkImageDecorationFilter();
  await checkSlicesAndBoundaries();

  const full = makeRun();
  const contentFull = await full.content();
  assert.equal(contentFull.images.length, 60);
  assert.equal(contentFull.partial, false);
  assert(full.frames() > 1, 'the production content parser must yield between image slices');
  assert.equal(full.writes[0].complete, true);

  const timed = makeRun({ timeout: 240 });
  const contentPartial = await timed.content();
  assert(contentPartial.images.length > 0 && contentPartial.images.length < 60);
  assert.equal(contentPartial.partial, true);
  assert.equal(timed.writes[0].complete, false, 'the same-origin cache request must retain partial status');

  const empty = makeRun({ timeout: 240 });
  empty.utils.extractResources = () => {
    empty.advance(240);
    return empty.utils.emptyResources();
  };
  const contentEmpty = await empty.content();
  assert.equal(contentEmpty.images.length, 0);
  assert.equal(contentEmpty.partial, true, 'expiry in an earlier parse stage must leave the image scan incomplete');
  assert.equal(empty.writes.length, 0, 'an empty deadline-limited result must avoid a positive cache write');

  const worker = makeRun();
  const workerFull = await worker.worker(3000);
  assert.deepEqual(sources(workerFull.images), sources(contentFull.images));
  assert.equal(workerFull.partial, false);
  assert.equal(workerFull.imageExtractionVersion, worker.utils.ARTICLE_IMAGE_EXTRACTION_VERSION);
  const workerPartial = await worker.worker(240);
  assert(workerPartial.images.length > 0 && workerPartial.images.length < 60);
  assert.equal(workerPartial.partial, true);
  console.log('article image extraction tests ok: real deadlines, complete caps, resumable slices and content/worker results');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
