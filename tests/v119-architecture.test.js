'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function testZeroAllocUtf8AndSinglePassExtractors() {
  const sandbox = { console, URL, URLSearchParams, TextDecoder, TextEncoder };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('shared-utils.js') + '\n' + read('html-extractors.js') + '\nthis.SharedUtils = SharedUtils;', sandbox);
  const { SharedUtils } = sandbox;

  // Verify exact UTF-8 byte lengths including ASCII, CJK, and astral emoji surrogate pairs
  for (const sample of ['', 'hello', '文章缩略图预览', '🔥🚀🎉 test 中文 123']) {
    assert.equal(SharedUtils.utf8ByteLength(sample), Buffer.byteLength(sample, 'utf8'));
  }

  // Single-pass attribute parser
  const attrs = SharedUtils.parseHtmlAttributesOnce('src="https://img.example/a.jpg" data-original=\'https://img.example/hd.jpg\' loading=lazy');
  assert.equal(attrs.src, 'https://img.example/a.jpg');
  assert.equal(attrs['data-original'], 'https://img.example/hd.jpg');
  assert.equal(attrs.loading, 'lazy');

  // Extraction context reuse across images, resources, and TXT attachments
  const html = `
    <html><head><meta property="og:image" content="https://img.example/og.jpg"></head>
    <body><div id="postlist"><div id="postmessage_1">
      <img file="https://image.imx.to/i/2026/11/25/sample.jpg">
      <a href="forum.php?mod=attachment&aid=abc123">资源合集.txt</a>
      百度网盘：https://pan.baidu.com/s/1testLink 提取码：8899
      解压密码：pass2026
    </div></div></body></html>`;
  const ctx = SharedUtils.prepareArticleExtractionContext(html);
  const res = SharedUtils.extractResources(html, 'https://www.sehuatang.org/thread-1-1-1.html', 'html', ctx);
  assert.equal(res.groups.baidu.length, 1);
  assert.equal(res.groups.baidu[0].code, '8899');
  assert(res.passwords.includes('pass2026'));

  const txts = SharedUtils.extractTextAttachments(html, 'https://www.sehuatang.org/thread-1-1-1.html', 3, ctx);
  assert.equal(txts.length, 1);
  assert.equal(txts[0].name, '资源合集.txt');
}

async function testBatchMemoryCacheAndDebouncedLogger() {
  const storageData = {
    'article_cache_v13_https://www.sehuatang.org/thread-10-1-1.html': {
      data: { images: [{ src: 'https://img.example/10.jpg' }], resources: { groups: {}, passwords: [] }, loadedUrls: [] },
      ts: Date.now(),
      complete: true
    }
  };
  let storageGetCalls = 0;
  let intervalCalls = 0;
  const timers = [];

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL, URLSearchParams, TextDecoder, TextEncoder, Promise, Map, Set, Date, Math, JSON, Object,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    setInterval() { intervalCalls++; return 1; },
    clearInterval() {},
    location: { href: 'https://www.sehuatang.org/forum-2-1.html', hostname: 'www.sehuatang.org' },
    ATPState: { settings: { cacheTTL: 30, debugLogging: false } },
    chrome: {
      runtime: { lastError: null, sendMessage(msg, cb) { if (cb) cb({ ok: true }); } },
      storage: {
        onChanged: { addListener() {}, removeListener() {} },
        local: {
          QUOTA_BYTES: 10485760,
          get(keys, cb) {
            storageGetCalls++;
            const out = {};
            for (const k of (Array.isArray(keys) ? keys : [keys])) {
              if (Object.prototype.hasOwnProperty.call(storageData, k)) out[k] = storageData[k];
            }
            cb(out);
          },
          set(obj, cb) { Object.assign(storageData, obj); if (cb) cb(); },
          remove(keys, cb) { if (cb) cb(); },
          getBytesInUse(keys, cb) { cb(1024); }
        }
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['settings-schema.js', 'defaults.js', 'shared-utils.js', 'html-extractors.js', 'logger.js', 'cache.js']) {
    vm.runInContext(read(f), sandbox, { filename: f });
  }

  // Logger must NEVER register a permanent 5s setInterval
  sandbox.Logger.startFlushTimer();
  assert.equal(intervalCalls, 0, 'Logger must use on-demand debounced setTimeout instead of permanent setInterval');

  // Batch cache read uses 1 IPC for multiple URLs and populates in-memory LRU
  const urls = [
    'https://www.sehuatang.org/thread-10-1-1.html',
    'https://www.sehuatang.org/thread-11-1-1.html'
  ];
  const beforeGets = storageGetCalls;
  const batchResult = await sandbox.ATPCache.getCachedArticlesBatch(urls);
  assert.equal(storageGetCalls - beforeGets, 1, 'Batch article read must issue a single storage.local.get IPC');
  assert(batchResult['https://www.sehuatang.org/thread-10-1-1.html'].cached);

  // Subsequent batch read hits memory LRU with 0 extra storage IPCs
  const secondBatch = await sandbox.ATPCache.getCachedArticlesBatch(['https://www.sehuatang.org/thread-10-1-1.html']);
  assert.equal(storageGetCalls - beforeGets, 1, 'Memory LRU hit on batch read must avoid redundant storage IPC');
  assert.equal(secondBatch['https://www.sehuatang.org/thread-10-1-1.html'].cached.images[0].src, 'https://img.example/10.jpg');
}

async function testUnifiedPriorityQueuePreemptionAndLiveControls() {
  let now = 50000;
  let timerSeq = 0;
  const timers = new Map();
  const createdImgs = [];

  function makeEl(tag) {
    const classes = new Set();
    return {
      tagName: tag,
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      isConnected: true,
      classList: {
        add(...ns) { ns.forEach(n => classes.add(n)); },
        remove(...ns) { ns.forEach(n => classes.delete(n)); },
        toggle(n, f) { if (f === undefined) f = !classes.has(n); if (f) classes.add(n); else classes.delete(n); return f; },
        contains(n) { return classes.has(n); }
      },
      appendChild(c) {
        if (c.tagName === 'FRAGMENT') {
          c.children.forEach(k => this.appendChild(k));
          c.children = [];
          return c;
        }
        c.parentNode = this;
        this.children.push(c);
        return c;
      },
      removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k] || null; },
      removeAttribute(k) { delete this[k]; if (k === 'src') this.src = ''; },
      addEventListener() {},
      removeEventListener() {},
      querySelector(sel) {
        if (sel === '.atp-thumbnail-img') return this.children.find(c => c.tagName === 'img') || null;
        if (sel === '.atp-thumbnail-loading') return this.children.find(c => c.classList && c.classList.contains('atp-thumbnail-loading')) || null;
        return null;
      },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { top: 20, bottom: 102, left: 0, right: 110, width: 110, height: 82 }; }
    };
  }

  const sandbox = {
    console, URL, URLSearchParams, TextDecoder, TextEncoder, Promise, Map, Set, WeakMap, WeakSet, Math, JSON, Object,
    Date: class extends Date { static now() { return now; } },
    performance: { now: () => now },
    innerHeight: 900, innerWidth: 1440, scrollY: 0,
    setTimeout(fn, delay) { const id = ++timerSeq; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { const id = ++timerSeq; timers.set(id, { fn, delay: 16 }); return id; },
    cancelAnimationFrame(id) { timers.delete(id); },
    addEventListener() {}, removeEventListener() {},
    IntersectionObserver: function() { this.observe = () => {}; this.unobserve = () => {}; this.disconnect = () => {}; },
    Logger: { isEnabled: () => false, debug() {}, info() {}, warn() {}, error() {}, event() {} },
    ATPCache: { scheduleCacheFlush() {}, flushCacheNow() {} },
    document: {
      visibilityState: 'visible', hidden: false,
      documentElement: makeEl('html'),
      addEventListener() {}, removeEventListener() {},
      contains: node => !!node,
      createDocumentFragment() { return makeEl('FRAGMENT'); },
      createElement(tag) {
        const el = makeEl(tag);
        if (tag === 'img') createdImgs.push(el);
        return el;
      },
      querySelectorAll() { return []; }
    },
    ATPState: {
      generation: 1,
      threads: {},
      settings: {
        firstScreenConcurrency: 1,
        backgroundConcurrency: 1,
        globalImageConcurrency: 1,
        ordinaryHostConcurrency: 4,
        viewportPriorityReservedSlots: 0,
        autoLoadOffscreenFirstRows: true,
        heavyImageOptimization: true,
        heavyImageConcurrency: 1,
        imageTimeout: 12000,
        imageTaskDeadline: 20000,
        thumbWidth: 110,
        thumbHeight: 82,
        gridCols: 5
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['settings-schema.js', 'defaults.js', 'shared-utils.js', 'loading-policy.js', 'host-health.js', 'viewport-observer.js', 'heavy-budget.js', 'image-runner.js', 'loader.js']) {
    vm.runInContext(read(f), sandbox, { filename: f });
  }

  // Register an offscreen P3 thread occupying the single global slot
  const offGrid = makeEl('div');
  const offPanel = makeEl('div');
  offPanel.getBoundingClientRect = () => ({ top: 3500, bottom: 3600, left: 0, right: 110, width: 110, height: 100 });
  offPanel.__atpViewportBand = 3;
  sandbox.ATPState.threads.off = {
    id: 'off', generation: 1, viewportBand: 3, readyImageVisible: false, panel: offPanel, grid: offGrid, container: offPanel, statusEl: makeEl('span'),
    candidates: [{ src: 'https://cdn.example/off-1.jpg' }], sourceCandidates: [{ src: 'https://cdn.example/off-1.jpg' }],
    total: 1, firstScreenTotal: 1, firstScreenOk: 0, firstScreenFailed: 0, loaded: 0, failedCount: 0,
    loadedUrls: [], loadedUrlMap: {}, readyImageQueue: true,
    firstTasks: [{ threadId: 'off', generation: 1, idx: 0, candidates: [{ src: 'https://cdn.example/off-1.jpg' }], grid: offGrid, isFirstScreen: true, readyImageQueue: true, viewportBand: 3, currentlyVisible: false, viewportPriority: false }]
  };
  sandbox.ATPLoader.globalSchedule('start_offscreen');
  assert.equal(createdImgs.length, 1);
  assert.equal(createdImgs[0].src, 'https://cdn.example/off-1.jpg');

  // Advance >250ms and introduce a visible P1 thread: P1 must preempt P3 immediately!
  now += 300;
  const visGrid = makeEl('div');
  const visPanel = makeEl('div');
  visPanel.__atpViewportBand = 0;
  sandbox.ATPState.threads.vis = {
    id: 'vis', generation: 1, viewportBand: 0, panel: visPanel, grid: visGrid, container: visPanel, statusEl: makeEl('span'),
    candidates: [{ src: 'https://cdn.example/vis-1.jpg' }], sourceCandidates: [{ src: 'https://cdn.example/vis-1.jpg' }],
    total: 1, firstScreenTotal: 1, firstScreenOk: 0, firstScreenFailed: 0, loaded: 0, failedCount: 0,
    loadedUrls: [], loadedUrlMap: {}, readyImageQueue: true,
    firstTasks: [{ threadId: 'vis', generation: 1, idx: 0, candidates: [{ src: 'https://cdn.example/vis-1.jpg' }], grid: visGrid, isFirstScreen: true, readyImageQueue: true, viewportBand: 0, currentlyVisible: true, viewportPriority: true }]
  };
  sandbox.ATPLoader.globalSchedule('visible_arrived');
  assert.equal(createdImgs[0].src, '', 'Preempted P3 offscreen image must release network request');
  assert.equal(sandbox.ATPState.threads.off.failedCount, 0, 'Preemption must never count as a failure');
  assert.equal(createdImgs[1].src, 'https://cdn.example/vis-1.jpg', 'Visible P1 image must claim freed slot immediately');

  const liveStats = sandbox.ATPLoader.getLivePageStats();
  assert.equal(liveStats.activeLoads, 1);
  assert.equal(liveStats.totalThreads, 2);
}

async function main() {
  testZeroAllocUtf8AndSinglePassExtractors();
  await testBatchMemoryCacheAndDebouncedLogger();
  await testUnifiedPriorityQueuePreemptionAndLiveControls();
  console.log('v1.19.0 architecture, zero-alloc extractors, batch LRU cache, and P3->P1 preemption tests ok');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
