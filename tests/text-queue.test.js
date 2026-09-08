'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
function createQueue() {
  let now = 1000, id = 0;
  const timers = new Map(), requests = [];
  const sandbox = {
    Date: { now: () => now },
    setTimeout: fn => { timers.set(++id, fn); return id; },
    clearTimeout: key => timers.delete(key),
    SharedUtils: { emptyResources: () => ({ groups: {}, passwords: [] }) },
    makeTextResourceFetchStatus: (resources, attemptedCount, unresolvedCount, retryableCount) =>
      ({ resources, attemptedCount, unresolvedCount, retryableCount }),
    fetchTextAttachmentResourcesWithStatus: (attachments, deadline, options) =>
      new Promise((resolve, reject) => requests.push({ attachments, options, resolve, reject }))
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('const TEXT_RESOURCE_MESSAGE_CONCURRENCY'),
    source.indexOf('function getRemainingDeadlineMs')), sandbox);
  return { sandbox, timers, requests, advance: ms => { now += ms; },
    enqueue: (owner, deadline = 60000) => sandbox.enqueueTextResourceMessage([{ url: 'https://example.test/fixture.txt' }], deadline, { owner, manualRetry: true }) };
}
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function run() {
  const q = createQueue();
  const jobs = [q.enqueue('a'), q.enqueue('a')];
  for (let i = 0; i < 4; i++) jobs.push(q.enqueue('a'));
  const busy = await q.enqueue('a');
  assert.strictEqual(busy.queueStatus, 'busy');
  assert.strictEqual(busy.retryableCount, 1);
  await tick();
  assert.strictEqual(q.requests.length, 2);
  assert.strictEqual(q.sandbox.textResourceMessageQueue.length, 4);
  for (let i = 0; i < 28; i++) jobs.push(q.enqueue('other-' + i));
  assert.strictEqual((await q.enqueue('overflow')).queueStatus, 'busy');
  assert.strictEqual(q.sandbox.textResourceMessageQueue.length, 32);
  assert.strictEqual(q.timers.size, 32);
  q.advance(30001);
  // Admission must clean expired jobs even if their timers have not fired.
  const fresh = q.enqueue('fresh');
  assert.strictEqual(q.sandbox.textResourceMessageQueue.length, 1);
  const expired = await Promise.all(jobs.slice(2));
  assert(expired.every(s => s.queueStatus === 'expired' && s.retryableCount === 1));
  q.requests[0].resolve({ ok: true }); q.requests[1].resolve({ ok: true });
  await tick();
  assert.strictEqual(q.requests.length, 3, 'expired jobs must never start a request');
  assert.strictEqual(q.requests[2].options.manualRetry, true);
  q.requests[2].resolve({ ok: true });
  await Promise.all([jobs[0], jobs[1], fresh]); await tick();
  assert.strictEqual(q.sandbox.textResourceMessageActive, 0);
  assert.strictEqual(q.timers.size, 0);

  const timed = createQueue();
  const first = timed.enqueue(1), second = timed.enqueue(2), pending = timed.enqueue(3, 1100);
  await tick(); timed.advance(101);
  Array.from(timed.timers.values())[0]();
  assert.strictEqual((await pending).queueStatus, 'expired');
  assert.strictEqual(timed.sandbox.textResourceMessageQueue.length, 0);
  timed.requests.forEach(r => r.resolve({ ok: true })); await Promise.all([first, second]);

  const thrown = createQueue();
  thrown.sandbox.fetchTextAttachmentResourcesWithStatus = () => { throw new Error('sync failure'); };
  await assert.rejects(thrown.enqueue(1), /sync failure/); await tick();
  assert.strictEqual(thrown.sandbox.textResourceMessageActive, 0);
  console.log('TXT queue backpressure tests ok');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
