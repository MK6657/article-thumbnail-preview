'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const attachment = {
  url: 'https://www.sehuatang.org/forum.php?mod=attachment&aid=private_aid&sign=private_signature',
  name: 'private_password.txt',
  pageUrl: 'https://www.sehuatang.org/thread-123-1-1.html?secret=private_referrer'
};

function loadContent(fetchResponse) {
  const events = [];
  const messages = [];
  const listeners = [];
  let requests = 0;
  let contextWindow;
  const sandbox = {
    URL, TextDecoder, TextEncoder, AbortController, Uint8Array, console, setTimeout, clearTimeout,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    location: { origin: 'https://www.sehuatang.org', href: 'https://www.sehuatang.org/forum-2-1.html' },
    navigator: { onLine: true }, document: { visibilityState: 'visible' },
    Logger: { isEnabled: () => true, event: (type, fields) => events.push({ type, fields }), debug() {}, warn() {}, sanitizeUrl: () => '' },
    ATPCache: { getCachedTextResources: async () => null, getTextFailCache: async () => false,
      clearTextFailCache() {}, setTextFailCache() {}, setCachedTextResources() {} },
    addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
    removeEventListener(type, listener) { const index = listeners.indexOf(listener); if (index !== -1) listeners.splice(index, 1); },
    postMessage(data) {
      setTimeout(() => listeners.slice().forEach(listener => listener({ source: contextWindow, origin: sandbox.location.origin, data })), 0);
    },
    fetch: async (url, options) => { requests++; return fetchResponse(url, options); },
    chrome: { runtime: { lastError: null, sendMessage(message, callback) {
      messages.push(message);
      callback({ resources: sandbox.SharedUtils.emptyResources(), attemptedCount: message.attachments.length,
        unresolvedCount: message.attachments.length, retryableCount: message.attachments.length });
    } } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('shared-utils.js') + '\nthis.SharedUtils = SharedUtils;', sandbox);
  vm.runInContext(read('page-fetch-bridge.js'), sandbox);
  vm.runInContext(read('fetcher.js'), sandbox);
  contextWindow = vm.runInContext('window', sandbox);
  return { sandbox, events, messages, requests: () => requests };
}

function loadBackground(shared, fetchResponse) {
  const events = [];
  let requests = 0;
  const sandbox = {
    SharedUtils: shared, URL, AbortController, setTimeout, clearTimeout,
    TEXT_ATTACHMENT_TIMEOUT: shared.TEXT_ATTACHMENT_TIMEOUT,
    TEXT_ATTACHMENT_MAX_BYTES: shared.TEXT_ATTACHMENT_MAX_BYTES,
    TEXT_ATTACHMENT_MAX_COUNT: shared.TEXT_ATTACHMENT_MAX_COUNT,
    BGLOG: { isEnabled: () => true, debug: (type, fields) => events.push({ type, fields }) },
    textAttachmentAllowedInZone: () => true,
    getCachedTextResources: async () => null, getTextFailCache: async () => false,
    clearTextFailCache() {}, setTextFailCache() {}, setCachedTextResources() {},
    getSafeAttachmentReferrer: () => '',
    getDeadlineFetchTimeout: (deadline, fallback) => Math.max(0, Math.min(fallback, deadline - Date.now())),
    fetch: async (url, options) => { requests++; return fetchResponse(url, options); }
  };
  vm.createContext(sandbox);
  const source = read('background.js');
  // Execute the production helper and request function with network/cache
  // boundaries stubbed; no copy of its branching logic lives in this test.
  vm.runInContext(source.slice(source.indexOf('var bgTextDiagnosticSequence ='), source.indexOf('const TEXT_ATTACHMENT_MAX_COUNT =')), sandbox);
  vm.runInContext(source.slice(source.indexOf('async function fetchTextAttachmentResource('), source.indexOf('async function fetchTextAttachmentResources(')), sandbox);
  return { sandbox, events, requests: () => requests };
}

function assertPrivate(events) {
  const text = JSON.stringify(events);
  for (const secret of ['private_aid', 'private_signature', 'private_password', 'private_referrer', 'forum.php', 'https://']) {
    assert(!text.includes(secret), 'diagnostics leaked ' + secret);
  }
  for (const event of events) {
    assert.strictEqual(event.type, 'txt_request');
    assert(/^txt_[a-z0-9_]{1,64}$/.test(event.fields.attachmentId));
    assert(JSON.stringify(event.fields).length < 600, 'diagnostic fields must remain bounded');
  }
}

async function run() {
  const failure = loadContent(async () => { throw new TypeError('Failed to fetch'); });
  const failed = await failure.sandbox.ATPFetcher.fetchTextAttachmentResourcesWithStatus([attachment], {
    deadline: Date.now() + 5000, diagnosticThreadId: 't_1791699566947_m25sxj', diagnosticRunId: 2
  });
  assert.strictEqual(failed.unresolvedCount, 1);
  assert.strictEqual(failure.requests(), 1, 'diagnostics must not add or change network attempts');
  assert.strictEqual(failure.messages.length, 1);
  const pageEvent = failure.events.find(event => event.fields.stage === 'page_bridge');
  assert.strictEqual(pageEvent.fields.outcome, 'fallback');
  assert.strictEqual(pageEvent.fields.failureClass, 'transport');
  const dispatch = failure.events.find(event => event.fields.stage === 'background_dispatch');
  assert.strictEqual(dispatch.fields.outcome, 'sent');
  assert.strictEqual(dispatch.fields.attachmentId, pageEvent.fields.attachmentId);
  assert.strictEqual(failure.messages[0].attachments[0].diagnosticId, pageEvent.fields.attachmentId);
  assert.strictEqual(pageEvent.fields.threadId, 't_1791699566947_m25sxj');
  assert.strictEqual(pageEvent.fields.runId, 2);
  assert.strictEqual(dispatch.fields.threadId, pageEvent.fields.threadId);
  assert.strictEqual(dispatch.fields.runId, pageEvent.fields.runId);
  assert.strictEqual(attachment.diagnosticId, undefined, 'diagnostic metadata must not mutate caller data');

  const background = loadBackground(failure.sandbox.SharedUtils, async () => { throw new TypeError('Failed to fetch ' + attachment.url); });
  await background.sandbox.fetchTextAttachmentResource(failure.messages[0].attachments[0], 0, Date.now() + 5000, { zone: 'builtin' });
  assert.strictEqual(background.requests(), 1);
  assert.strictEqual(background.events.length, 1, 'a background request must have one terminal diagnostic');
  assert.strictEqual(background.events[0].fields.attachmentId, pageEvent.fields.attachmentId);
  assert.strictEqual(background.events[0].fields.failureClass, 'transport');
  assert.strictEqual(background.events[0].fields.outcome, 'failed');
  assert.strictEqual(background.events[0].fields.threadId, pageEvent.fields.threadId);
  assert.strictEqual(background.events[0].fields.runId, pageEvent.fields.runId);
  assertPrivate(failure.events.concat(background.events));

  const nextRun = loadContent(async () => { throw new TypeError('Failed to fetch'); });
  await nextRun.sandbox.ATPFetcher.fetchTextAttachmentResourcesWithStatus(failure.messages[0].attachments, {
    deadline: Date.now() + 5000, diagnosticThreadId: pageEvent.fields.threadId, diagnosticRunId: 3
  });
  assert(nextRun.events.every(event => event.fields.runId === 3 && event.fields.threadId === pageEvent.fields.threadId),
    'a new run must override stale metadata while preserving stage correlation');
  assert(nextRun.events.every(event => event.fields.attachmentId === pageEvent.fields.attachmentId));
  assertPrivate(nextRun.events);

  const expired = loadContent(async () => { assert.fail('expired work must not fetch'); });
  await expired.sandbox.ATPFetcher.fetchTextAttachmentResourcesWithStatus([attachment], { deadline: Date.now() - 1 });
  assert.strictEqual(expired.requests(), 0);
  assert.strictEqual(expired.messages.length, 0);
  assert(!expired.events.some(event => event.fields.outcome === 'sent'), 'expired fallback must not claim dispatch');
  const expiredDispatch = expired.events.find(event => event.fields.stage === 'background_dispatch');
  assert.strictEqual(expiredDispatch.fields.outcome, 'skipped');
  assert.strictEqual(expiredDispatch.fields.failureClass, 'deadline');
  assert.strictEqual(expiredDispatch.fields.remainingMs, 0);
  assertPrivate(expired.events);

  const forbidden = loadContent(async url => ({ ok: false, status: 403, url, headers: { get: () => null } }));
  await forbidden.sandbox.ATPFetcher.fetchTextAttachmentResourcesWithStatus([attachment], { deadline: Date.now() + 5000 });
  assert.strictEqual(forbidden.requests(), 1);
  assert.strictEqual(forbidden.messages.length, 0, 'HTTP failures retain the existing no-fallback behavior');
  assert.strictEqual(forbidden.events[0].fields.status, 403);
  assert.strictEqual(forbidden.events[0].fields.failureClass, 'auth_or_forbidden');
  assertPrivate(forbidden.events);

  const empty = loadContent(async url => ({ ok: true, status: 200, url, headers: { get: () => 'text/plain' },
    arrayBuffer: async () => new TextEncoder().encode('No download links here.').buffer }));
  await empty.sandbox.ATPFetcher.fetchTextAttachmentResource(attachment, 0, {}, { deadline: Date.now() + 5000 });
  assert.strictEqual(empty.events.length, 1);
  assert.strictEqual(empty.events[0].fields.outcome, 'empty');
  assert.strictEqual(empty.events[0].fields.failureClass, 'no_resource_links');
  assert.strictEqual(empty.events[0].fields.resources, 0);
  assert.strictEqual(empty.events[0].fields.threadId, undefined, 'standalone API calls do not need a renderer thread id');
  assertPrivate(empty.events);

  const success = loadContent(async url => ({ ok: true, status: 200, url, headers: { get: () => 'text/plain' },
    arrayBuffer: async () => new TextEncoder().encode('https://pan.baidu.com/s/1example\n提取码：ab12').buffer }));
  const resources = await success.sandbox.ATPFetcher.fetchTextAttachmentResource(attachment, 0, {}, { deadline: Date.now() + 5000 });
  assert.strictEqual(resources.groups.baidu.length, 1);
  assert.strictEqual(success.events.length, 1);
  assert.strictEqual(success.events[0].fields.outcome, 'success');
  assert.strictEqual(success.events[0].fields.failureClass, '');
  assert.strictEqual(success.events[0].fields.resources, 1);
  assertPrivate(success.events);

  const direct = loadContent(async () => { throw new TypeError('Failed to fetch ' + attachment.url); });
  direct.sandbox.addEventListener = undefined;
  await direct.sandbox.ATPFetcher.fetchTextAttachmentResource(attachment, 0, {}, { deadline: Date.now() + 5000 });
  assert.strictEqual(direct.requests(), 1);
  const directEvent = direct.events.find(event => event.fields.stage === 'direct');
  assert.strictEqual(directEvent.fields.outcome, 'failed');
  assert.strictEqual(directEvent.fields.failureClass, 'transport');
  assert.strictEqual(directEvent.fields.attachmentId, direct.events[0].fields.attachmentId);
  assertPrivate(direct.events);

  const invalidMetadata = loadContent(async () => { assert.fail('expired work must not fetch'); });
  await invalidMetadata.sandbox.ATPFetcher.fetchTextAttachmentResourcesWithStatus([attachment], {
    deadline: Date.now() - 1, diagnosticThreadId: attachment.url, diagnosticRunId: -1
  });
  assert(invalidMetadata.events.every(event => event.fields.threadId === undefined && event.fields.runId === undefined));
  assertPrivate(invalidMetadata.events);
  console.log('TXT diagnostics tests ok: phase correlation, failure categories, deadline skip and privacy');
}

run().catch(error => { console.error(error && error.stack || error); process.exit(1); });
