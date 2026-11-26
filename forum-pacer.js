(function () {
  'use strict';

  // Paces requests to the forum itself: thread pages, on-demand TXT
  // re-extraction and attachment downloads. Images and download relays are
  // other hosts and are not paced here.
  //
  // Observed on the live forum (September 2026): after about thirty such
  // requests within a few seconds it answers further ones with a ~1 KB
  // challenge page instead of the content, and keeps doing so until the
  // browser loads a forum page normally. A steady 1 request/s after a burst of
  // 16 still tripped it within ~20 s, so the default is a burst of 10 and then
  // one request every 2 s. A challenge page or HTTP 429/503 pauses everything,
  // then single requests probe with growing gaps until real pages come back.
  // The challenge itself is never executed or answered.
  var BURST = 10;
  var REFILL_MS = 2000;
  var MIN_BURST = 4;
  var MAX_REFILL_MS = 4000;
  var BASE_PAUSE_MS = SharedUtils.FORUM_BASE_PAUSE_MS;
  var MAX_PAUSE_MS = 300000;
  var MAX_LEVEL = 5;
  var RECOVERY_SUCCESSES = 3;
  // After this many requests in a row that the forum served normally, an
  // allowance slowed down by a challenge steps back toward the default.
  var RELAX_AFTER_SUCCESSES = 8;
  var WAIT_POLL_MS = 500;
  // A caller that never settles its ticket must not hold probe mode forever.
  var TICKET_MAX_AGE_MS = 90000;
  // A one-click retry may leave this much of its TXT budget waiting for a probe.
  var MANUAL_PROBE_WAIT_MS = SharedUtils.TEXT_ATTACHMENT_TIMEOUT || 10000;
  // The forum limits the browser, not the tab: the allowance and any pause are
  // shared by every tab of this forum origin, and forgotten after five idle
  // minutes.
  var STORE_KEY = 'atp.forumPacer.v2';
  var STORE_MAX_AGE_MS = 300000;
  // Keep an explicit Retry-After separate from the learned state and normal
  // allowance writes. Successful navigation and local resets cannot erase it.
  var RETRY_AFTER_KEY = 'atp.forumPacer.retryAfter.v1';
  var retryAfterUntil = 0;
  var PROBE_KEY = 'atp.forumPacer.probe.v1';
  var PROBE_LOCK = 'atp.forumPacer.probe.v1';
  var probeOwner = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  var probeSeq = 0;
  var probeGrantPending = false;
  var probeLocksUnavailable = false;
  // What a challenge taught about this forum: the pace never relaxes back to
  // the one that tripped it, for a day after the last challenge.
  var LIMIT_KEY = 'atp.forumPacer.limits.v1';
  var LIMIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  // Visible articles and visible TXT handoffs can use the reserved tokens.
  // Waiters of the same priority keep their original order.
  var PRIORITY_VISIBLE = 0;
  var PRIORITY_ARTICLE = 1;

  // Shared with the popup through chrome.storage.local (the pacer's own store
  // is this forum origin's localStorage, which the popup cannot reach): the
  // reader's last manual reset, applied by every forum page and domain, and
  // each forum host's current pace for the popup to show on any page.
  var RESET_MARKER_KEY = 'atp_forum_pacer_reset_at';
  var STATUS_KEY = 'atp_forum_pacer_status_v1';
  var SERVER_WAIT_KEY = 'atp_forum_server_wait_v1';
  var backgroundRetryAfterUntil = 0;
  var initialExtensionState = null;
  var initialExtensionStateResolve = null;
  var needsInitialHydration = false;
  var receivedResetChange = false;
  // A tab still at work republishes at least this often, so the popup can
  // tell when a host nobody uses any more has gone back to its normal pace.
  var STATUS_REFRESH_MS = 60000;
  // The last popup reset this forum origin applied. Each reset clears what
  // came before it exactly once, so a clock that later steps back cannot
  // make it swallow a newer challenge.
  var RESET_APPLIED_KEY = 'atp.forumPacer.resetApplied.v1';
  var appliedMarker = 0;
  var publishedSignature = '';
  var publishedAt = 0;
  var limits = { burst: BURST, refillMs: REFILL_MS, at: 0 };
  var state = makeDefaultState(Date.now());
  // Set once a write to localStorage fails: from then on this tab paces from
  // its own memory, or re-reading the last good record would undo every
  // grant and pause it records.
  var storeReadOnly = false;
  var active = [];
  var waiters = [];
  var waiterSeq = 0;
  var pumpTimer = null;

  function makeDefaultState(now) {
    return {
      at: now,
      tokens: limits.burst,
      tokensAt: now,
      burst: limits.burst,
      refillMs: limits.refillMs,
      level: 0,
      pauseUntil: 0,
      separatesRetryAfter: true,
      lastFloodAt: 0,
      // Last time a tab loaded a normal forum page; a pause from before that
      // gives way to single probes.
      clearedAt: 0,
      // Successful probes since the last challenge, counted across tabs.
      calm: 0,
      relax: 0,
      resetId: ''
    };
  }

  function safeCall(fn, fallback) {
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  }

  function clampNumber(value, min, max, fallback) {
    value = Number(value);
    return isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }

  function getStore() {
    return safeCall(function() { return window.localStorage || null; }, null);
  }

  function getProbeLocks() {
    if (probeLocksUnavailable) return null;
    return safeCall(function() {
      return typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function'
        ? navigator.locks : null;
    }, null);
  }

  function readProbeLease(now) {
    var store = getStore();
    if (!store) return null;
    var lease = safeCall(function() { return JSON.parse(store.getItem(PROBE_KEY) || 'null'); }, null);
    if (!lease || typeof lease.id !== 'string' || !(lease.at <= now) ||
        !(lease.until > now) || lease.until > lease.at + TICKET_MAX_AGE_MS) return null;
    return lease;
  }

  function clearProbeLease(id) {
    var clear = function() {
      var store = getStore();
      if (!store) return;
      var lease = safeCall(function() { return JSON.parse(store.getItem(PROBE_KEY) || 'null'); }, null);
      if (lease && lease.id === id) {
        if (!safeCall(function() { store.removeItem(PROBE_KEY); return true; }, false)) {
          safeCall(function() { store.setItem(PROBE_KEY, 'null'); }, null);
        }
      }
    };
    var locks = getProbeLocks();
    if (!locks) { clear(); schedulePump(0); return; }
    // The lock covers only the storage transaction, never the network wait:
    // a page can enter BFCache, and a crashed/frozen owner expires in 90 s.
    try {
      Promise.resolve(locks.request(PROBE_LOCK, clear)).then(function() {
        schedulePump(0);
      }, function() {
        probeLocksUnavailable = true;
        clear();
        schedulePump(0);
      });
    } catch (e) {
      probeLocksUnavailable = true;
      clear();
      schedulePump(0);
    }
  }

  function loadLimits(now, store) {
    var saved = safeCall(function() { return JSON.parse(store.getItem(LIMIT_KEY) || 'null'); }, null);
    var at = saved && Number(saved.at);
    if (!saved || !isFinite(at) || at > now || now - at > LIMIT_MAX_AGE_MS) {
      limits = { burst: BURST, refillMs: REFILL_MS, at: 0 };
      return;
    }
    limits = {
      burst: Math.round(clampNumber(saved.burst, MIN_BURST, BURST, BURST)),
      refillMs: Math.round(clampNumber(saved.refillMs, REFILL_MS, MAX_REFILL_MS, REFILL_MS)),
      at: at
    };
  }

  // A challenge came at this pace: never go back to it (for a day).
  function learnFromChallenge(now, burstAtTrip, refillAtTrip) {
    limits = {
      burst: Math.min(limits.burst, Math.max(MIN_BURST, Math.floor(burstAtTrip * 0.75))),
      refillMs: Math.max(limits.refillMs, Math.min(MAX_REFILL_MS, Math.round(refillAtTrip * 1.25))),
      at: now
    };
    var store = getStore();
    if (!store) return;
    safeCall(function() { store.setItem(LIMIT_KEY, JSON.stringify(limits)); }, null);
  }

  // Adopts the state other tabs (or earlier pages) left behind.
  function load(now) {
    var store = getStore();
    if (!store) return;
    var savedRetryAfter = safeCall(function() { return Number(store.getItem(RETRY_AFTER_KEY)); }, 0);
    if (Number.isFinite(savedRetryAfter)) retryAfterUntil = Math.max(retryAfterUntil, savedRetryAfter);
    if (storeReadOnly) return;
    loadLimits(now, store);
    state.burst = Math.min(state.burst, limits.burst);
    state.refillMs = Math.max(state.refillMs, limits.refillMs);
    state.tokens = Math.min(state.tokens, state.burst);
    var saved = safeCall(function() { return JSON.parse(store.getItem(STORE_KEY) || 'null'); }, null);
    if (!saved || typeof saved !== 'object') return;
    var at = Number(saved.at);
    // Idle time counts from the end of a pause, so the longest pause does not
    // expire the very state that says to probe afterwards.
    var idleSince = Math.max(at, Math.min(Math.max(Number(saved.pauseUntil) || 0, retryAfterUntil), now));
    if (!isFinite(at) || now - idleSince > STORE_MAX_AGE_MS) {
      var cleared = Math.min(state.clearedAt, now);
      state = makeDefaultState(now);
      state.clearedAt = cleared;
      return;
    }
    var future = now + MAX_PAUSE_MS;
    // Times written under a clock that has since stepped backwards are
    // clamped and written back, or every load would freeze them again.
    var skewed = Number(saved.tokensAt) > now || Number(saved.lastFloodAt) > now || Number(saved.clearedAt) > now;
    state.at = at;
    state.burst = Math.round(clampNumber(saved.burst, MIN_BURST, limits.burst, limits.burst));
    state.refillMs = Math.round(clampNumber(saved.refillMs, limits.refillMs, MAX_REFILL_MS, limits.refillMs));
    state.tokens = clampNumber(saved.tokens, 0, state.burst, state.burst);
    state.tokensAt = clampNumber(saved.tokensAt, 0, now, now);
    state.level = Math.round(clampNumber(saved.level, 0, MAX_LEVEL, 0));
    state.pauseUntil = clampNumber(saved.pauseUntil, 0, future, 0);
    state.lastFloodAt = clampNumber(saved.lastFloodAt, 0, now, 0);
    state.clearedAt = Math.min(now, Math.max(state.clearedAt, clampNumber(saved.clearedAt, 0, now, 0)));
    state.calm = Math.round(clampNumber(saved.calm, 0, RECOVERY_SUCCESSES, 0));
    state.relax = Math.round(clampNumber(saved.relax, 0, RELAX_AFTER_SUCCESSES, 0));
    state.resetId = typeof saved.resetId === 'string' ? saved.resetId.slice(0, 120) : '';
    // Old records combined both waits. A longer-than-learned pause still
    // applies after an upgrade or while another tab is using the old format.
    if (!saved.separatesRetryAfter && !skewed && state.lastFloodAt > state.clearedAt &&
        state.pauseUntil > state.lastFloodAt + learnedPauseDuration(state.level)) {
      noteRetryAfter(now, state.pauseUntil);
    }
    if (skewed) save(now);
  }

  var savingLocalStorage = false;

  function save(now) {
    var store = getStore();
    if (!store) return;
    state.at = now;
    savingLocalStorage = true;
    try {
      storeReadOnly = !safeCall(function() {
        store.setItem(STORE_KEY, JSON.stringify(state));
        return true;
      }, false);
    } finally {
      savingLocalStorage = false;
    }
  }

  function refill(now) {
    // A clock that stepped backwards must not freeze the allowance.
    if (state.tokensAt > now) state.tokensAt = now;
    if (now > state.tokensAt) {
      state.tokens = Math.min(state.burst, state.tokens + (now - state.tokensAt) / state.refillMs);
      state.tokensAt = now;
    }
  }

  function getLearnedPauseUntil(now) {
    if (state.lastFloodAt <= state.clearedAt) return 0;
    return Math.min(state.pauseUntil, now + MAX_PAUSE_MS);
  }

  function learnedPauseDuration(level) {
    return Math.min(MAX_PAUSE_MS, BASE_PAUSE_MS * Math.pow(2, Math.max(0, level - 1)));
  }

  function getPauseUntil(now) {
    return Math.max(getLearnedPauseUntil(now), retryAfterUntil > now ? retryAfterUntil : 0);
  }

  function noteRetryAfter(now, value) {
    var until = Number(value);
    if (!Number.isFinite(until) || until <= Math.max(now, retryAfterUntil)) return false;
    saveRetryAfter(until);
    return true;
  }

  function saveRetryAfter(until) {
    retryAfterUntil = until;
    var store = getStore();
    if (store) safeCall(function() {
      var saved = Number(store.getItem(RETRY_AFTER_KEY));
      if (Number.isFinite(saved)) retryAfterUntil = Math.max(saved, until);
      store.setItem(RETRY_AFTER_KEY, String(retryAfterUntil));
    }, null);
  }

  // An explicit server deadline may have been observed in another origin's
  // background request. Carry it into this origin's normal admission and probe
  // state without teaching the local allowance from an imported report.
  function applyBackgroundServerWait(waits) {
    var origin = safeCall(function() { return location.origin; }, '');
    var wait = waits && waits[origin];
    var now = Date.now();
    if (!wait || !Number.isFinite(wait.at) || !Number.isFinite(wait.until) || wait.until + STORE_MAX_AGE_MS <= now) return;
    backgroundRetryAfterUntil = Math.max(backgroundRetryAfterUntil, wait.until);
    load(now);
    if (wait.until <= retryAfterUntil) return;
    saveRetryAfter(wait.until);
    state.lastFloodAt = Math.max(state.lastFloodAt, Math.min(wait.at, now));
    state.level = Math.max(1, state.level);
    state.calm = 0;
    save(now);
    if (waiters.length) schedulePump(0);
  }

  function countActive(now) {
    for (var i = active.length - 1; i >= 0; i--) {
      if (now - active[i].startedAt > TICKET_MAX_AGE_MS) active.splice(i, 1);
    }
    return active.length;
  }

  function isHolding(now) {
    return now < getPauseUntil(now) || state.level > 0;
  }

  // Allowance kept back for threads on screen. Anything else (offscreen
  // prefetch, automatic TXT) may only start while more than this many
  // requests remain, so a scroll or a newly opened page (the store is shared
  // by every page and tab of the forum) still finds requests for what the
  // reader is looking at. The rate is unchanged: offscreen work gets every
  // request above the reserve. None in probe mode, which sends one at a time.
  var VISIBLE_RESERVE = 4;

  function getReserve(priority, cost) {
    if (!(priority > PRIORITY_VISIBLE) || state.level > 0) return 0;
    return Math.max(0, Math.min(VISIBLE_RESERVE, Math.floor(state.burst * 0.4), state.burst - Math.min(cost, state.burst)));
  }

  // 0: a request of this cost may start now; >0: ms until it may; -1: only
  // after the request in flight settles (one probe at a time after a flood).
  function getStartDelay(now, cost, reserve, manual) {
    var pauseUntil = manual ? retryAfterUntil : getPauseUntil(now);
    if (now < pauseUntil) return pauseUntil - now;
    if (state.level > 0 && (countActive(now) > 0 || readProbeLease(now))) return -1;
    if (manual) return 0;
    // The allowance may have shrunk since this request queued.
    var need = Math.min(cost, state.burst) + (reserve || 0);
    refill(now);
    if (state.tokens + 1e-9 >= need) return 0;
    return Math.max(1, Math.ceil((need - state.tokens) * state.refillMs));
  }

  function noteOutcome(outcome, startedAt, retryAfter) {
    var now = Date.now();
    load(now);
    if (outcome === 'flood') {
      // Requests already in flight when the forum first pushed back belong to
      // that same burst; only a request sent after it escalates the pause.
      var escalate = startedAt > state.lastFloodAt;
      if (escalate) {
        learnFromChallenge(now, state.burst, state.refillMs);
        state.level = Math.min(state.level + 1, MAX_LEVEL);
        state.lastFloodAt = now;
        if (state.clearedAt >= now) state.clearedAt = now - 1;
        state.pauseUntil = Math.max(state.pauseUntil, now + learnedPauseDuration(state.level));
        state.burst = Math.max(MIN_BURST, Math.floor(state.burst / 2));
        state.refillMs = Math.min(MAX_REFILL_MS, Math.round(state.refillMs * 1.5));
      }
      noteRetryAfter(now, retryAfter);
      state.calm = 0;
      state.relax = 0;
      state.tokens = 0;
      state.tokensAt = now;
      save(now);
      if (escalate) {
        Logger.warn('论坛限流，暂停论坛请求', Math.max(0, getPauseUntil(now) - now) + 'ms 级别' + state.level + ' 突发' + state.burst + ' 间隔' + state.refillMs + 'ms');
      }
      return;
    }
    if (outcome !== 'ok' || startedAt <= state.lastFloodAt || startedAt < retryAfterUntil) return;
    if (state.level > 0) {
      state.calm++;
      if (state.calm < RECOVERY_SUCCESSES) {
        save(now);
        return;
      }
      state.level = 0;
      state.relax = 0;
      state.calm = 0;
      save(now);
      Logger.info('论坛限流解除', '恢复论坛请求（突发' + state.burst + ' 间隔' + state.refillMs + 'ms）');
      return;
    }
    if (state.burst >= limits.burst && state.refillMs <= limits.refillMs) return;
    state.relax++;
    if (state.relax >= RELAX_AFTER_SUCCESSES) {
      state.relax = 0;
      state.burst = Math.min(limits.burst, state.burst + 4);
      state.refillMs = Math.max(limits.refillMs, Math.round(state.refillMs / 1.5));
    }
    save(now);
  }

  // A TXT relay can reach the forum without requesting a local ticket first.
  function noteExternalCooldown(retryAfter, observedAt) {
    var now = Date.now();
    var at = Number(observedAt);
    noteOutcome('flood', at > 0 && at <= now ? at : now, retryAfter);
    publishStatus();
    schedulePump(0);
  }

  function grant(cost, waitStartedAt, probeId) {
    var now = Date.now();
    cost = Math.min(cost, state.burst);
    refill(now);
    state.tokens = Math.max(0, state.tokens - cost);
    save(now);
    var entry = { startedAt: now, resetId: state.resetId };
    active.push(entry);
    var settled = false;
    var expired = false;
    var probeTimer = probeId ? setTimeout(function() {
      expired = true;
      var index = active.indexOf(entry);
      if (index !== -1) active.splice(index, 1);
      clearProbeLease(probeId);
    }, TICKET_MAX_AGE_MS) : null;
    return {
      startedAt: now,
      waitMs: Math.max(0, now - (waitStartedAt || now)),
      // outcome: 'ok' when the forum served real content, 'flood' for a
      // challenge / rate-limit answer, 'unused' when no request was sent after
      // all (returns the allowance); anything else says nothing about the forum.
      done: function(outcome, retryAfter, observedAt) {
        if (settled) return;
        settled = true;
        if (probeTimer) clearTimeout(probeTimer);
        var index = active.indexOf(entry);
        if (index !== -1) active.splice(index, 1);
        if (probeId) clearProbeLease(probeId);
        var at = Date.now();
        load(at);
        var stale = expired || (probeId && at - entry.startedAt >= TICKET_MAX_AGE_MS) || entry.resetId !== state.resetId;
        if (stale) {
          // A late refusal can carry a new server deadline across a reset or
          // an expired lease. Preserve the current allowance and learn no rate from it.
          if (outcome !== 'flood' || !noteRetryAfter(at, retryAfter)) return;
          state.level = Math.max(1, state.level);
          state.calm = 0;
          save(at);
        } else if (outcome === 'unused') {
          refill(at);
          state.tokens = Math.min(state.burst, state.tokens + cost);
          save(at);
        } else {
          // Two worker batches can report the same 429. Only a new request
          // that actually reached the forum can escalate the backoff again.
          var startedAt = observedAt > 0 ? Math.min(entry.startedAt, observedAt) : entry.startedAt;
          noteOutcome(outcome, startedAt, retryAfter);
        }
        publishStatus();
        schedulePump(0);
      }
    };
  }

  function getWaiterPriority(waiter) {
    if (!waiter.getPriority) return waiter.priority;
    var value = Number(safeCall(waiter.getPriority, waiter.priority));
    return isFinite(value) ? value : waiter.priority;
  }

  function pickNextWaiter() {
    if (waiters[0].manual) {
      waiters[0].rankedPriority = PRIORITY_VISIBLE;
      return 0;
    }
    var best = 0;
    var bestPriority = getWaiterPriority(waiters[0]);
    for (var i = 1; i < waiters.length; i++) {
      var priority = getWaiterPriority(waiters[i]);
      if (priority < bestPriority) {
        best = i;
        bestPriority = priority;
      }
    }
    waiters[best].rankedPriority = bestPriority;
    return best;
  }

  function releaseDroppedWaiters(now) {
    for (var i = waiters.length - 1; i >= 0; i--) {
      var waiter = waiters[i];
      var dropped = (waiter.manual && retryAfterUntil > now) ||
        (waiter.deadline && now >= waiter.deadline) ||
        (waiter.isCancelled && safeCall(waiter.isCancelled, false));
      if (!dropped) continue;
      waiters.splice(i, 1);
      waiter.resolve(null);
    }
  }

  function notifyHeldWaiters() {
    for (var i = 0; i < waiters.length; i++) {
      var waiter = waiters[i];
      if (!waiter.onHeld || waiter.heldNotified) continue;
      waiter.heldNotified = true;
      safeCall(waiter.onHeld, null);
    }
  }

  function schedulePump(delay) {
    if (pumpTimer) clearTimeout(pumpTimer);
    pumpTimer = setTimeout(pump, Math.max(0, delay));
  }

  function grantNextProbe() {
    var now = Date.now();
    load(now);
    releaseDroppedWaiters(now);
    if (!waiters.length) return false;
    var index = pickNextWaiter();
    var waiter = waiters[index];
    if (getStartDelay(now, waiter.cost, getReserve(waiter.rankedPriority, waiter.cost), waiter.manual) !== 0) return false;
    var probeId = '';
    if (state.level > 0) {
      probeId = probeOwner + '-' + (++probeSeq);
      var store = getStore();
      if (store) safeCall(function() {
        store.setItem(PROBE_KEY, JSON.stringify({ id: probeId, at: now, until: now + TICKET_MAX_AGE_MS }));
      }, null);
    }
    waiters.splice(index, 1);
    waiter.resolve(grant(waiter.cost, waiter.queuedAt, probeId));
    return true;
  }

  function requestProbeGrant() {
    if (probeGrantPending) return;
    var locks = getProbeLocks();
    if (!locks) {
      // Older/restricted contexts retain a shared expiring lease. Only Web
      // Locks can make its read-and-claim atomic across renderer processes.
      grantNextProbe();
      if (waiters.length) schedulePump(WAIT_POLL_MS);
      return;
    }
    probeGrantPending = true;
    function finish(granted) {
      probeGrantPending = false;
      if (waiters.length) schedulePump(granted ? 0 : WAIT_POLL_MS);
    }
    function failed() {
      probeLocksUnavailable = true;
      probeGrantPending = false;
      schedulePump(0);
    }
    try {
      // Do not queue a Web Lock while hidden: retry polls retain the normal
      // cancellation/deadline rules, then recheck them inside the lock.
      Promise.resolve(locks.request(PROBE_LOCK, { ifAvailable: true }, function(lock) {
        return lock ? grantNextProbe() : false;
      })).then(finish, failed);
    } catch (e) { failed(); }
  }

  function pump() {
    if (pumpTimer) {
      clearTimeout(pumpTimer);
      pumpTimer = null;
    }
    var now = Date.now();
    load(now);
    releaseDroppedWaiters(now);
    while (waiters.length) {
      var delay = getStartDelay(now, 1, 0, waiters[0].manual);
      var index = -1;
      if (delay === 0) {
        // Pick the current viewport priority when a request is ready to go.
        index = pickNextWaiter();
        var next = waiters[index];
        delay = getStartDelay(now, next.cost, getReserve(next.rankedPriority, next.cost), next.manual);
      }
      if (delay !== 0) {
        if (isHolding(now)) notifyHeldWaiters();
        // Keep polling so cancelled waiters (page hidden, rescan) let go
        // promptly and other tabs' changes are picked up.
        schedulePump(delay < 0 ? WAIT_POLL_MS : Math.min(delay, WAIT_POLL_MS));
        return;
      }
      if (state.level > 0) {
        requestProbeGrant();
        return;
      }
      var waiter = waiters.splice(index, 1)[0];
      waiter.resolve(grant(waiter.cost, waiter.queuedAt));
      now = Date.now();
    }
  }

  // Resolves with a ticket once the request may start, or null when the
  // caller cancelled or its deadline passed first. Every ticket must be
  // settled with ticket.done(outcome) after the request.
  function acquire(options) {
    if (needsInitialHydration && !initialExtensionState) {
      startInitialExtensionStateRead();
    }
    if (initialExtensionState) {
      return initialExtensionState.then(function() { return acquire(options); });
    }
    options = options || {};
    var now = Date.now();
    load(now);
    var cost = Math.max(1, Math.min(state.burst, Math.floor(Number(options.cost) || 1)));
    var deadline = Number(options.deadline) || 0;
    if (options.manual) {
      if (retryAfterUntil > now || (deadline && now >= deadline) ||
          (typeof options.isCancelled === 'function' && safeCall(options.isCancelled, false))) return Promise.resolve(null);
      if (state.level === 0) return Promise.resolve(grant(cost, 0));
      // An explicit click may try during a learned pause. In recovery it uses
      // the same shared probe as automatic work, with a bounded wait.
      deadline = Math.min(deadline || Infinity, now + MANUAL_PROBE_WAIT_MS);
    }
    return new Promise(function(resolve) {
      var waiter = {
        seq: ++waiterSeq,
        cost: cost,
        manual: !!options.manual,
        priority: typeof options.priority === 'number' ? options.priority : PRIORITY_ARTICLE,
        getPriority: typeof options.getPriority === 'function' ? options.getPriority : null,
        isCancelled: typeof options.isCancelled === 'function' ? options.isCancelled : null,
        onHeld: typeof options.onHeld === 'function' ? options.onHeld : null,
        heldNotified: false,
        deadline: deadline,
        queuedAt: Date.now(),
        resolve: resolve
      };
      // Keep explicit retries ahead of automatic work while preserving FIFO
      // between clicks. The pump can check this group without measuring rows.
      var index = waiters.length;
      if (waiter.manual) {
        index = waiters.findIndex(function(queued) { return !queued.manual; });
        if (index === -1) index = waiters.length;
      }
      waiters.splice(index, 0, waiter);
      pump();
    });
  }

  function getState() {
    var now = Date.now();
    load(now);
    refill(now);
    var pauseUntil = getPauseUntil(now);
    return {
      tokens: Math.floor(state.tokens * 100) / 100,
      burst: state.burst,
      refillMs: state.refillMs,
      learnedBurst: limits.burst,
      learnedRefillMs: limits.refillMs,
      pauseUntil: pauseUntil,
      retryAfterUntil: retryAfterUntil > now ? retryAfterUntil : 0,
      pausedMs: Math.max(0, pauseUntil - now),
      level: state.level,
      calm: state.calm,
      relax: state.relax,
      active: countActive(now),
      waiting: waiters.length,
      reserve: getReserve(PRIORITY_ARTICLE, 1)
    };
  }

  // Reports this host's pace to the popup when it changes (not on every
  // request: tokens are left out of the signature).
  function publishStatus() {
    if (needsInitialHydration || initialExtensionState || typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') return;
    var now = Date.now();
    load(now);
    var host = safeCall(function() { return location.hostname; }, '');
    if (!host) return;
    var pauseUntil = getPauseUntil(now);
    var entry = {
      burst: state.burst,
      refillMs: state.refillMs,
      learnedBurst: limits.burst,
      learnedRefillMs: limits.refillMs,
      level: state.level,
      pauseUntil: pauseUntil,
      // The worker already published an imported deadline to the popup.
      // Reporting it back would make the same signal look like a new refusal.
      retryAfterUntil: retryAfterUntil > Math.max(now, backgroundRetryAfterUntil) ? retryAfterUntil : 0,
      // When the learned pace lapses, and when this state is forgotten unless
      // a tab of this host does more work first: the popup applies both.
      limitsUntil: limits.at ? limits.at + LIMIT_MAX_AGE_MS : 0,
      idleUntil: Math.max(now, pauseUntil) + STORE_MAX_AGE_MS,
      at: now
    };
    var signature = host + '|' + [entry.burst, entry.refillMs, entry.learnedBurst, entry.learnedRefillMs, entry.level,
      entry.pauseUntil, entry.retryAfterUntil, entry.limitsUntil, appliedMarker].join('|');
    if (signature === publishedSignature && now - publishedAt < STATUS_REFRESH_MS) return;
    publishedSignature = signature;
    publishedAt = now;
    function allowRetry() {
      if (publishedSignature === signature && publishedAt === now) publishedSignature = '';
    }
    try {
      chrome.runtime.sendMessage({ type: SharedUtils.MESSAGE_TYPES.REPORT_FORUM_PACER_STATUS, entry: entry,
        resetMarker: appliedMarker }, function(response) {
        if (chrome.runtime.lastError || !response || !response.ok) allowRetry();
      });
    } catch (e) {
      allowRetry();
    }
  }

  function describePace(now) {
    return [state.burst, state.refillMs, state.level, getPauseUntil(now), limits.burst, limits.refillMs].join('|');
  }

  // Restore the default allowance across this origin. An active server
  // deadline still governs when those requests may start.
  function clearLearnedPace(now) {
    load(now);
    // A pending recovery after an explicit server pause survives a reset of
    // the learned pace, including when that pause has just expired.
    var keepRecovery = retryAfterUntil > now ||
      (state.level > 0 && retryAfterUntil > 0 && retryAfterUntil >= state.lastFloodAt);
    var store = getStore();
    storeReadOnly = false;
    limits = { burst: BURST, refillMs: REFILL_MS, at: 0 };
    if (store) {
      safeCall(function() { store.removeItem(LIMIT_KEY); }, null);
      safeCall(function() { store.removeItem(STORE_KEY); }, null);
      // A store that could not remove the entry gets the normal pace written
      // over the learned one instead.
      if (safeCall(function() { return store.getItem(LIMIT_KEY); }, null) !== null) {
        safeCall(function() { store.setItem(LIMIT_KEY, JSON.stringify({ burst: BURST, refillMs: REFILL_MS, at: now })); }, null);
      }
    }
    var clearedAt = Math.min(state.clearedAt, now);
    var oldProbe = readProbeLease(now);
    if (oldProbe && !keepRecovery) clearProbeLease(oldProbe.id);
    state = makeDefaultState(now);
    if (keepRecovery) state.level = 1;
    state.resetId = probeOwner + '-reset-' + (++probeSeq);
    state.clearedAt = clearedAt;
    save(now);
  }

  // Apply the popup reset once per origin. Other tabs read the updated
  // allowance and server deadline from the shared store.
  function applyResetMarker(value) {
    value = Number(value) || 0;
    if (!(value > 0) || value === appliedMarker) return;
    appliedMarker = value;
    var now = Date.now();
    var before = describePace(now);
    var store = storeReadOnly ? null : getStore();
    var appliedHere = store ? safeCall(function() { return Number(store.getItem(RESET_APPLIED_KEY)) || 0; }, 0) : 0;
    if (appliedHere !== value) {
      clearLearnedPace(now);
      if (store) safeCall(function() { store.setItem(RESET_APPLIED_KEY, String(value)); }, null);
    } else {
      load(now);
    }
    var after = describePace(now);
    schedulePump(0);
    publishStatus();
    if (before !== after) {
      Logger.info('论坛节流已按弹窗重置', '恢复突发' + state.burst + ' 间隔' + state.refillMs + 'ms');
      safeCall(function() {
        if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent('atp-forum-pacer-reset'));
        }
      }, null);
    }
  }

  // Explicit reset for this forum origin, with the same server deadline
  // handling as a popup reset.
  function reset() {
    var now = Date.now();
    clearLearnedPace(now);
    Logger.info('论坛节流已手动重置', '恢复突发' + state.burst + ' 间隔' + state.refillMs + 'ms');
    schedulePump(0);
    publishStatus();
    safeCall(function() {
      if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('atp-forum-pacer-reset'));
      }
    }, null);
    return getState();
  }

  // Whether a request of this priority would be granted right now, before
  // anything else queued in this tab.
  function canStartNow(priority, cost) {
    if (needsInitialHydration || initialExtensionState) return false;
    var now = Date.now();
    load(now);
    if (waiters.length) return false;
    cost = Math.max(1, Math.floor(Number(cost) || 1));
    return getStartDelay(now, cost, getReserve(typeof priority === 'number' ? priority : PRIORITY_ARTICLE, cost)) === 0;
  }

  // A real thread or list loaded in the browser is a recovery signal. Discuz
  // can render a failure using its usual header or return the notice as 200.
  function noteForumPageLoaded() {
    var doc = typeof document !== 'undefined' ? document : null;
    if (!doc || typeof doc.querySelector !== 'function') return;
    var now = Date.now();
    if (now >= getLearnedPauseUntil(now)) return;
    var navigation = safeCall(function() { return performance.getEntriesByType('navigation')[0]; }, null);
    if (navigation && navigation.responseStatus >= 400) return;
    var normal = safeCall(function() {
      return !doc.querySelector('#messagetext, #main_message, .showmessage, .alert_error, .alert_info, #challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, .g-recaptcha, .h-captcha, iframe[src*="challenges.cloudflare.com"]') &&
        doc.querySelector('#threadlist tbody[id^="normalthread"], #threadlist tbody[id^="stickthread"], #threadlist a.xst[href], #postlist [id^="postmessage_"]');
    }, false);
    if (!normal) return;
    state.clearedAt = now;
    save(now);
  }

  function hydrateInitialServerWait(raw, resetMarker) {
    needsInitialHydration = false;
    if (raw) applyBackgroundServerWait(raw);
    if (resetMarker !== undefined && !receivedResetChange) applyResetMarker(resetMarker);
    var pendingResolve = initialExtensionStateResolve;
    initialExtensionStateResolve = null;
    initialExtensionState = null;
    if (pendingResolve) pendingResolve();
    publishStatus();
    if (waiters.length) schedulePump(0);
  }

  function startInitialExtensionStateRead() {
    needsInitialHydration = false;
    if (initialExtensionState || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    initialExtensionState = new Promise(function(resolve) {
      initialExtensionStateResolve = resolve;
      try {
        chrome.storage.local.get([RESET_MARKER_KEY, SERVER_WAIT_KEY], function(result) {
          if (!initialExtensionStateResolve) {
            resolve();
            return;
          }
          initialExtensionStateResolve = null;
          if (result && !(chrome.runtime && chrome.runtime.lastError)) {
            applyBackgroundServerWait(result[SERVER_WAIT_KEY]);
            if (!receivedResetChange) applyResetMarker(result[RESET_MARKER_KEY]);
          }
          resolve();
        });
      } catch (e) {
        initialExtensionStateResolve = null;
        resolve();
      }
    }).then(function() {
      initialExtensionState = null;
      publishStatus();
    });
  }

  function handleCrossTabStorage(event) {
    if (savingLocalStorage) return;
    if (event && event.key && event.key !== STORE_KEY && event.key !== PROBE_KEY &&
        event.key !== RETRY_AFTER_KEY && event.key !== LIMIT_KEY && event.key !== RESET_APPLIED_KEY) {
      return;
    }
    var now = Date.now();
    load(now);
    if (waiters.length && getStartDelay(now, 1, 0, waiters[0].manual) === 0) {
      schedulePump(0);
    }
  }

  load(Date.now());
  noteForumPageLoaded();

  if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
    safeCall(function() { window.addEventListener('storage', handleCrossTabStorage); }, null);
  }

  // Read the shared state before sending the first request, then follow updates.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    if (chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
      chrome.storage.onChanged.addListener(function(changes, areaName) {
        if (areaName !== 'local' || !changes) return;
        if (changes[SERVER_WAIT_KEY]) applyBackgroundServerWait(changes[SERVER_WAIT_KEY].newValue);
        if (changes[RESET_MARKER_KEY]) {
          receivedResetChange = true;
          applyResetMarker(changes[RESET_MARKER_KEY].newValue);
        }
      });
    }
    if (typeof window !== 'undefined' && window && window.ATPConfig && window.ATPConfig._hydratesForumPacer === true) {
      needsInitialHydration = true;
    } else {
      startInitialExtensionStateRead();
    }
  }

  window.ATPForumPacer = {
    PRIORITY_VISIBLE: PRIORITY_VISIBLE,
    PRIORITY_ARTICLE: PRIORITY_ARTICLE,
    STORE_KEY: STORE_KEY,
    RESET_MARKER_KEY: RESET_MARKER_KEY,
    STATUS_KEY: STATUS_KEY,
    hydrateInitialServerWait: hydrateInitialServerWait,
    acquire: acquire,
    canStartNow: canStartNow,
    noteExternalCooldown: noteExternalCooldown,
    reset: reset,
    getState: getState,
    getPauseUntil: function() {
      var now = Date.now();
      load(now);
      return getPauseUntil(now);
    },
    isHolding: function() {
      var now = Date.now();
      load(now);
      return isHolding(now);
    }
  };
})();
