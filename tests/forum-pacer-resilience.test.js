'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'forum-pacer.js'), 'utf8');
const listRow = '#threadlist tbody[id^="normalthread"]';

function createForum(savedState) {
  const store = new Map();
  if (savedState) store.set('atp.forumPacer.v2', JSON.stringify(savedState));
  let now = 1000000;
  function open({ status = 200, selectors = [] } = {}) {
    const sandbox = {
      document: {
        querySelector(query) {
          return query.split(',').some(item => selectors.includes(item.trim())) ? {} : null;
        }
      },
      performance: { getEntriesByType: () => [{ responseStatus: status }] },
      localStorage: {
        getItem: key => store.get(key) || null,
        setItem: (key, value) => store.set(key, value),
        removeItem: key => store.delete(key)
      },
      Date: { now: () => now },
      setTimeout: () => 1,
      clearTimeout() {},
      Logger: { warn() {}, info() {} },
      SharedUtils: { FORUM_BASE_PAUSE_MS: 20000 }
    };
    sandbox.window = sandbox;
    vm.runInNewContext(source, sandbox, { filename: 'forum-pacer.js' });
    return sandbox.ATPForumPacer;
  }
  return { open, advance: milliseconds => { now += milliseconds; }, now: () => now };
}

async function run() {
  const heuristic = createForum();
  const first = heuristic.open();
  (await first.acquire()).done('flood');
  heuristic.advance(4000);
  for (const failure of [
    { status: 503, selectors: ['#wp', listRow] },
    { status: 429, selectors: ['#wp', listRow] },
    { selectors: ['#wp', '#messagetext', listRow] },
    { selectors: ['#wp'] }
  ]) {
    assert.equal(heuristic.open(failure).getState().pausedMs, 16000, 'a failed navigation must preserve learned backoff');
  }
  const returned = heuristic.open({ selectors: [listRow] });
  assert.equal(returned.getState().pausedMs, 0, 'successful navigation may lift learned backoff');
  assert.equal(returned.getState().level, 1, 'the next requests must still use single-probe recovery');

  const explicit = createForum();
  const prefetch = explicit.open();
  const firstInFlight = await prefetch.acquire();
  const shorter = await prefetch.acquire();
  shorter.done('flood', explicit.now() + 120000);
  firstInFlight.done('flood', explicit.now() + 3600000);
  explicit.advance(4000);
  const reader = explicit.open({ selectors: [listRow] });
  assert.equal(reader.getState().pausedMs, 3596000, 'successful navigation must preserve the longer server deadline');
  assert.equal(reader.getState().level, 1, 'one in-flight burst must count as a single refusal');
  assert.equal(await reader.acquire({ manual: true }), null, 'an explicit click waits for the server deadline too');
  assert.equal(reader.reset().pausedMs, 3596000, 'manual pace reset must preserve the server deadline');
  explicit.advance(301000);
  assert.equal(explicit.open().getState().pausedMs, 3295000, 'the server deadline survives the normal idle limit');
  explicit.advance(3295000);
  assert.equal(explicit.open().getState().pausedMs, 0, 'the recorded deadline expires normally');
  assert.equal(prefetch.getState().level, 1, 'the first automatic request after expiry must still be a probe');

  for (const isProbe of [false, true]) {
    const inFlight = createForum();
    const sender = inFlight.open();
    const resetter = inFlight.open();
    const kind = isProbe ? 'probe' : 'ordinary request';
    if (isProbe) {
      (await sender.acquire()).done('flood');
      inFlight.advance(20000);
    }
    const pending = await sender.acquire();
    resetter.reset();
    inFlight.advance(1000);
    const recent = await Promise.all([resetter.acquire(), resetter.acquire(), resetter.acquire()]);
    const serverDeadline = inFlight.now() + 120000;
    pending.done('flood', serverDeadline);
    recent.forEach(ticket => ticket.done('ok'));
    const resetState = resetter.getState();
    assert.equal(resetState.retryAfterUntil, serverDeadline, 'a late ' + kind + ' can supply a server deadline after another tab resets');
    assert.equal(resetState.learnedBurst, 10, 'a late ' + kind + ' must preserve the reset allowance');
    assert.equal(resetState.learnedRefillMs, 2000, 'a late ' + kind + ' must preserve the reset refill rate');
    assert.equal(resetState.level, 1, 'successful requests already in flight cannot settle recovery for a new server deadline');
    assert.equal(await resetter.acquire({ manual: true }), null);
    inFlight.advance(120000);
    const nextProbe = await resetter.acquire();
    assert.equal(sender.canStartNow(sender.PRIORITY_VISIBLE), false, 'only the new probe may run after the server deadline');
    nextProbe.done('ok');
  }

  const expired = createForum();
  const owner = expired.open();
  const replacement = expired.open();
  (await owner.acquire()).done('flood');
  expired.advance(20000);
  const expiredProbe = await owner.acquire();
  expired.advance(90001);
  const currentProbe = await replacement.acquire();
  const learnedBefore = replacement.getState().learnedBurst;
  const lateDeadline = expired.now() + 120000;
  expiredProbe.done('flood', lateDeadline);
  assert.equal(replacement.getState().retryAfterUntil, lateDeadline, 'an expired probe can supply a still-active server deadline');
  assert.equal(replacement.getState().learnedBurst, learnedBefore, 'an expired probe leaves the replacement pace intact');
  currentProbe.done('ok');
  assert.equal(replacement.getState().calm, 0, 'a replacement probe sent before the server deadline cannot count toward recovery');

  const serverRecovery = createForum();
  const recoveryFirst = serverRecovery.open();
  const recoveryReset = serverRecovery.open();
  (await recoveryFirst.acquire()).done('flood', serverRecovery.now() + 120000);
  serverRecovery.advance(120000);
  const firstRecoveryProbe = await recoveryFirst.acquire();
  assert.equal(recoveryReset.reset().level, 1, 'a server recovery in progress must survive the reset of the learned pace');
  assert.equal(recoveryReset.canStartNow(recoveryReset.PRIORITY_VISIBLE), false, 'reset must keep the active server recovery lease');
  firstRecoveryProbe.done('ok');
  assert.equal(recoveryReset.canStartNow(recoveryReset.PRIORITY_VISIBLE), true, 'releasing the original probe allows the reset tab to recover');

  const upgraded = createForum({
    at: 999000, lastFloodAt: 999000, clearedAt: 0, level: 1, pauseUntil: 1119000
  }).open({ selectors: [listRow] });
  assert.equal(upgraded.getState().pausedMs, 119000, 'an extended wait from the older format must survive migration');

  const relay = createForum().open();
  relay.noteExternalCooldown(1120000, 1000000);
  assert.equal(relay.getState().pausedMs, 120000, 'TXT redirects can report a wait without holding a ticket');
  assert.equal(relay.getState().level, 1);
  console.log('forum navigation and Retry-After tests ok');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
