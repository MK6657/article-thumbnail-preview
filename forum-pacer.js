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
  var BASE_PAUSE_MS = 20000;
  var MAX_PAUSE_MS = 300000;
  var MAX_LEVEL = 5;
  var RECOVERY_SUCCESSES = 3;
  // After this many requests in a row that the forum served normally, an
  // allowance slowed down by a challenge steps back toward the default.
  var RELAX_AFTER_SUCCESSES = 8;
  var WAIT_POLL_MS = 500;
  // A caller that never settles its ticket must not hold probe mode forever.
  var TICKET_MAX_AGE_MS = 90000;
  // The forum limits the browser, not the tab: the allowance and any pause are
  // shared by every tab of this forum origin, and forgotten after five idle
  // minutes.
  var STORE_KEY = 'atp.forumPacer.v2';
  var STORE_MAX_AGE_MS = 300000;
  // What a challenge taught about this forum: the pace never relaxes back to
  // the one that tripped it, for a day after the last challenge.
  var LIMIT_KEY = 'atp.forumPacer.limits.v1';
  var LIMIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  // Requests for threads on screen go first; everything else (offscreen
  // threads, TXT work) is served in the order it asked.
  var PRIORITY_VISIBLE = 0;
  var PRIORITY_ARTICLE = 1;

  // Shared with the popup through chrome.storage.local (the pacer's own store
  // is this forum origin's localStorage, which the popup cannot reach): the
  // reader's last manual reset, applied by every forum page and domain, and
  // each forum host's current pace for the popup to show on any page.
  var RESET_MARKER_KEY = 'atp_forum_pacer_reset_at';
  var STATUS_KEY = 'atp_forum_pacer_status_v1';
  var STATUS_MAX_HOSTS = 10;
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
      lastFloodAt: 0,
      // Last time a tab loaded a normal forum page; a pause from before that
      // gives way to single probes.
      clearedAt: 0,
      // Successful probes since the last challenge, counted across tabs.
      calm: 0,
      relax: 0
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
    if (!store || storeReadOnly) return;
    loadLimits(now, store);
    state.burst = Math.min(state.burst, limits.burst);
    state.refillMs = Math.max(state.refillMs, limits.refillMs);
    state.tokens = Math.min(state.tokens, state.burst);
    var saved = safeCall(function() { return JSON.parse(store.getItem(STORE_KEY) || 'null'); }, null);
    if (!saved || typeof saved !== 'object') return;
    var at = Number(saved.at);
    // Idle time counts from the end of a pause, so the longest pause does not
    // expire the very state that says to probe afterwards.
    var idleSince = Math.max(at, Math.min(Number(saved.pauseUntil) || 0, now));
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
    if (skewed) save(now);
  }

  function save(now) {
    var store = getStore();
    if (!store) return;
    state.at = now;
    storeReadOnly = !safeCall(function() {
      store.setItem(STORE_KEY, JSON.stringify(state));
      return true;
    }, false);
  }

  function refill(now) {
    // A clock that stepped backwards must not freeze the allowance.
    if (state.tokensAt > now) state.tokensAt = now;
    if (now > state.tokensAt) {
      state.tokens = Math.min(state.burst, state.tokens + (now - state.tokensAt) / state.refillMs);
      state.tokensAt = now;
    }
  }

  // The pause in force: set by a challenge seen after the last normal page
  // load, and never longer than the maximum even if the clock moved.
  function getPauseUntil(now) {
    if (state.lastFloodAt <= state.clearedAt) return 0;
    return Math.min(state.pauseUntil, now + MAX_PAUSE_MS);
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
  function getStartDelay(now, cost, reserve) {
    var pauseUntil = getPauseUntil(now);
    if (now < pauseUntil) return pauseUntil - now;
    if (state.level > 0 && countActive(now) > 0) return -1;
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
        state.pauseUntil = Math.max(state.pauseUntil, now + Math.min(MAX_PAUSE_MS, BASE_PAUSE_MS * Math.pow(2, state.level - 1)));
        state.burst = Math.max(MIN_BURST, Math.floor(state.burst / 2));
        state.refillMs = Math.min(MAX_REFILL_MS, Math.round(state.refillMs * 1.5));
      }
      retryAfter = Number(retryAfter) || 0;
      if (retryAfter > state.pauseUntil) state.pauseUntil = Math.min(retryAfter, now + MAX_PAUSE_MS);
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
    if (outcome !== 'ok' || startedAt <= state.lastFloodAt) return;
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

  function grant(cost, waitStartedAt) {
    var now = Date.now();
    cost = Math.min(cost, state.burst);
    refill(now);
    state.tokens = Math.max(0, state.tokens - cost);
    save(now);
    var entry = { startedAt: now };
    active.push(entry);
    var settled = false;
    return {
      startedAt: now,
      waitMs: Math.max(0, now - (waitStartedAt || now)),
      // outcome: 'ok' when the forum served real content, 'flood' for a
      // challenge / rate-limit answer, 'unused' when no request was sent after
      // all (returns the allowance); anything else says nothing about the forum.
      done: function(outcome, retryAfter) {
        if (settled) return;
        settled = true;
        var index = active.indexOf(entry);
        if (index !== -1) active.splice(index, 1);
        if (outcome === 'unused') {
          var at = Date.now();
          load(at);
          refill(at);
          state.tokens = Math.min(state.burst, state.tokens + cost);
          save(at);
        } else {
          noteOutcome(outcome, entry.startedAt, retryAfter);
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
      var dropped = (waiter.deadline && now >= waiter.deadline) ||
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

  function pump() {
    if (pumpTimer) {
      clearTimeout(pumpTimer);
      pumpTimer = null;
    }
    var now = Date.now();
    load(now);
    releaseDroppedWaiters(now);
    while (waiters.length) {
      var delay = getStartDelay(now, 1);
      var index = -1;
      if (delay === 0) {
        // Rank only when a request can actually start: which thread is on
        // screen right now decides who goes first, not who asked first.
        index = pickNextWaiter();
        delay = getStartDelay(now, waiters[index].cost, getReserve(waiters[index].rankedPriority, waiters[index].cost));
      }
      if (delay !== 0) {
        if (isHolding(now)) notifyHeldWaiters();
        // Keep polling so cancelled waiters (page hidden, rescan) let go
        // promptly and other tabs' changes are picked up.
        schedulePump(delay < 0 ? WAIT_POLL_MS : Math.min(delay, WAIT_POLL_MS));
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
    options = options || {};
    load(Date.now());
    var cost = Math.max(1, Math.min(state.burst, Math.floor(Number(options.cost) || 1)));
    // A user's explicit click goes out at once; its answer still counts.
    if (options.manual) return Promise.resolve(grant(cost, 0));
    return new Promise(function(resolve) {
      waiters.push({
        seq: ++waiterSeq,
        cost: cost,
        priority: typeof options.priority === 'number' ? options.priority : PRIORITY_ARTICLE,
        getPriority: typeof options.getPriority === 'function' ? options.getPriority : null,
        isCancelled: typeof options.isCancelled === 'function' ? options.isCancelled : null,
        onHeld: typeof options.onHeld === 'function' ? options.onHeld : null,
        heldNotified: false,
        deadline: Number(options.deadline) || 0,
        queuedAt: Date.now(),
        resolve: resolve
      });
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
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
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
      // When the learned pace lapses, and when this state is forgotten unless
      // a tab of this host does more work first: the popup applies both.
      limitsUntil: limits.at ? limits.at + LIMIT_MAX_AGE_MS : 0,
      idleUntil: Math.max(now, pauseUntil) + STORE_MAX_AGE_MS,
      at: now
    };
    var signature = host + '|' + [entry.burst, entry.refillMs, entry.learnedBurst, entry.learnedRefillMs, entry.level, entry.pauseUntil, entry.limitsUntil].join('|');
    if (signature === publishedSignature && now - publishedAt < STATUS_REFRESH_MS) return;
    publishedSignature = signature;
    publishedAt = now;
    safeCall(function() {
      chrome.storage.local.get(STATUS_KEY, function(result) {
        var all = result && result[STATUS_KEY] && typeof result[STATUS_KEY] === 'object' ? result[STATUS_KEY] : {};
        all[host] = entry;
        var hosts = Object.keys(all).sort(function(a, b) { return (all[b].at || 0) - (all[a].at || 0); });
        for (var i = STATUS_MAX_HOSTS; i < hosts.length; i++) delete all[hosts[i]];
        var items = {};
        items[STATUS_KEY] = all;
        safeCall(function() { chrome.storage.local.set(items); }, null);
      });
    }, null);
  }

  function describePace(now) {
    return [state.burst, state.refillMs, state.level, getPauseUntil(now), limits.burst, limits.refillMs].join('|');
  }

  // Forgets the pace learned from challenges and any pause: the normal pace
  // and a full burst again, for every tab of this forum origin (they share
  // the store).
  function clearLearnedPace(now) {
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
    state = makeDefaultState(now);
    state.clearedAt = clearedAt;
    save(now);
  }

  // A reset the reader asked for in the popup (on any page), for every forum
  // domain: the first page of this origin to see it clears the learned pace
  // and any pause; other tabs of the origin pick that up from the store.
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

  // The reader's explicit reset (popup button): forget the pace learned from
  // earlier challenges and any pause, and start again from the normal pace
  // with a full burst. Every tab of this forum origin shares the store, so
  // they all follow. The forum's own verification page is not touched; if it
  // pushes back again, the pacer slows down again by itself.
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
    var now = Date.now();
    load(now);
    if (waiters.length) return false;
    cost = Math.max(1, Math.floor(Number(cost) || 1));
    return getStartDelay(now, cost, getReserve(typeof priority === 'number' ? priority : PRIORITY_ARTICLE, cost)) === 0;
  }

  // This document is a normal forum page (the challenge page carries none of
  // the Discuz frame), so the reader's own page load got through whatever
  // check the forum ran: pauses from before it give way to single probes.
  function noteForumPageLoaded() {
    var doc = typeof document !== 'undefined' ? document : null;
    if (!doc || typeof doc.querySelector !== 'function') return;
    if (!safeCall(function() { return doc.querySelector('#wp, #hd, #toptb, #ft, #postlist, #threadlist'); }, null)) return;
    var now = Date.now();
    load(now);
    state.clearedAt = now;
    save(now);
  }

  load(Date.now());
  noteForumPageLoaded();

  // The popup's reset marker: read once at start, then followed live.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    safeCall(function() {
      chrome.storage.local.get(RESET_MARKER_KEY, function(result) {
        applyResetMarker(result && result[RESET_MARKER_KEY]);
        publishStatus();
      });
    }, null);
    if (chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
      chrome.storage.onChanged.addListener(function(changes, areaName) {
        if (areaName !== 'local' || !changes || !changes[RESET_MARKER_KEY]) return;
        applyResetMarker(changes[RESET_MARKER_KEY].newValue);
      });
    }
  }

  window.ATPForumPacer = {
    PRIORITY_VISIBLE: PRIORITY_VISIBLE,
    PRIORITY_ARTICLE: PRIORITY_ARTICLE,
    STORE_KEY: STORE_KEY,
    RESET_MARKER_KEY: RESET_MARKER_KEY,
    STATUS_KEY: STATUS_KEY,
    acquire: acquire,
    canStartNow: canStartNow,
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
