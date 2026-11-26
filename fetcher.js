(function () {
  'use strict';

  var TEXT_ATTACHMENT_MAX_COUNT = SharedUtils.TEXT_ATTACHMENT_MAX_COUNT;
  var TEXT_ATTACHMENT_MAX_BYTES = SharedUtils.TEXT_ATTACHMENT_MAX_BYTES;
  var TEXT_ATTACHMENT_TIMEOUT = SharedUtils.TEXT_ATTACHMENT_TIMEOUT;
  var PAGE_TEXT_FETCH_REQUEST = 'ATP_PAGE_TEXT_FETCH_REQUEST_V1';
  var PAGE_TEXT_FETCH_RESPONSE = 'ATP_PAGE_TEXT_FETCH_RESPONSE_V1';
  var articleParseQueue = [];
  var articleParseRunning = false;
  // 同一帖子并发抓取去重（如 AJAX 换页触发的新旧 scan 交叠时），与后台侧的 in-flight 去重对应
  var ARTICLE_FETCH_IN_FLIGHT = {};
  var textDiagnosticSequence = 0;

  function withTextDiagnosticId(attachment, options) {
    if (!attachment || !attachment.url) return attachment;
    var next = Object.assign({}, attachment);
    if (!/^txt_[a-z0-9_]{1,64}$/.test(next.diagnosticId || '')) {
      next.diagnosticId = 'txt_' + Date.now().toString(36) + '_' + (++textDiagnosticSequence).toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }
    var threadId = options && options.diagnosticThreadId !== undefined ? options.diagnosticThreadId : next.diagnosticThreadId;
    var runId = options && options.diagnosticRunId !== undefined ? options.diagnosticRunId : next.diagnosticRunId;
    delete next.diagnosticThreadId;
    delete next.diagnosticRunId;
    if (/^t_[0-9]{1,20}_[A-Za-z0-9]{1,24}$/.test(threadId || '') && Number.isSafeInteger(runId) && runId > 0) {
      next.diagnosticThreadId = threadId;
      next.diagnosticRunId = runId;
    }
    return next;
  }

  // Only fixed categories and bounded numeric fields leave this boundary.
  // In particular, never log attachment URLs, filenames or exception messages.
  function logTextDiagnostic(attachment, stage, outcome, failureClass, deadline, details) {
    if (!attachment || !/^txt_[a-z0-9_]{1,64}$/.test(attachment.diagnosticId || '')) return;
    if (Logger.isEnabled && !Logger.isEnabled('DEBUG')) return;
    var fields = { attachmentId: attachment.diagnosticId, stage: stage, outcome: outcome,
      failureClass: failureClass || '', remainingMs: Number.isFinite(Number(deadline)) && Number(deadline) > 0
        ? Math.max(0, Math.min(100000000, Math.round(deadline - Date.now()))) : null };
    if (/^t_[0-9]{1,20}_[A-Za-z0-9]{1,24}$/.test(attachment.diagnosticThreadId || '') &&
        Number.isSafeInteger(attachment.diagnosticRunId) && attachment.diagnosticRunId > 0) {
      fields.threadId = attachment.diagnosticThreadId;
      fields.runId = attachment.diagnosticRunId;
    }
    details = details || {};
    ['status', 'resources', 'elapsedMs', 'depth', 'paceWaitMs'].forEach(function(key) {
      if (Number.isFinite(details[key])) fields[key] = Math.max(0, Math.min(100000000, Math.round(details[key])));
    });
    try {
      if (Logger.event) Logger.event('txt_request', fields, 'DEBUG');
      else Logger.debug('txt_request', fields);
    } catch (e) {}
  }

  function textFailureClass(error, status) {
    if (status === 401 || status === 403) return 'auth_or_forbidden';
    if (status === 429 || status === 503) return 'throttle_or_unavailable';
    if (status >= 400) return 'http_error';
    var reason = typeof error === 'string' ? error : (error && error.name) || '';
    if (reason === 'AbortError' || reason === 'timeout') return 'timeout';
    if (reason === 'TypeError' || reason === 'Failed to fetch') return 'transport';
    if (reason === 'url_not_allowed' || reason === 'redirect_not_allowed' || reason === 'response_too_large') return reason;
    return reason ? 'request_error' : 'bridge_no_response';
  }

  function getParseClock() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function waitForArticleParseFrame() {
    var taskScheduler = (typeof scheduler !== 'undefined' && scheduler) ||
      (typeof window !== 'undefined' && window && window.scheduler) || null;
    if (taskScheduler && typeof taskScheduler.postTask === 'function') {
      return taskScheduler.postTask(function() {}, { priority: 'user-visible' }).catch(function() {});
    }
    return new Promise(function(resolve) {
      var fired = false;
      var fallbackTimer = null;
      function finish() {
        if (fired) return;
        fired = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        resolve();
      }
      if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') {
        fallbackTimer = setTimeout(finish, 50);
        requestAnimationFrame(finish);
      } else {
        setTimeout(finish, 0);
      }
    });
  }

  // 时间片让帧：只在本片已连续占用主线程超过预算时才等一帧。
  // 原实现每帖固定让 3 次帧（且第一次是在一点活都没干之前），
  // 叠加全局串行队列后吞吐被硬顶在 1 帖 / 3 帧 ≈ 50ms，18 帖光等帧就 ~900ms。
  var ARTICLE_PARSE_SLICE_MS = 12;
  var articleParseSliceStartedAt = 0;

  function yieldArticleParseSlice() {
    if (articleParseSliceStartedAt && getParseClock() - articleParseSliceStartedAt < ARTICLE_PARSE_SLICE_MS) {
      return Promise.resolve();
    }
    return waitForArticleParseFrame().then(function() {
      articleParseSliceStartedAt = getParseClock();
    });
  }

  async function runArticleParseJob(job) {
    var startedAt = Date.now();
    var parseMs = 0;
    var resources = SharedUtils.emptyResources();
    var textAttachments = [];
    await yieldArticleParseSlice();
    var stageStartedAt = getParseClock();
    // 整文派生串（还原邮箱/解实体/纯文本）只算一次，供资源与 TXT 附件两个提取器共用
    var extractionContext;
    if (Date.now() < job.deadline) {
      extractionContext = SharedUtils.prepareArticleExtractionContext(job.html);
      resources = SharedUtils.extractResources(job.html, job.finalUrl, 'html', extractionContext);
    }
    parseMs += Math.max(0, getParseClock() - stageStartedAt);

    await yieldArticleParseSlice();
    stageStartedAt = getParseClock();
    if (extractionContext && Date.now() < job.deadline) {
      textAttachments = SharedUtils.extractTextAttachments(job.html, job.finalUrl, TEXT_ATTACHMENT_MAX_COUNT, extractionContext);
    }
    parseMs += Math.max(0, getParseClock() - stageStartedAt);

    await yieldArticleParseSlice();
    stageStartedAt = getParseClock();
    var imageResult = await SharedUtils.extractImagesForSettingsInSlices(job.html, job.finalUrl, job.settings, {
      clock: getParseClock,
      deadline: function() { return job.deadline; },
      sliceMs: ARTICLE_PARSE_SLICE_MS,
      sliceStartedAt: articleParseSliceStartedAt,
      yieldSlice: async function() {
        parseMs += Math.max(0, getParseClock() - stageStartedAt);
        await yieldArticleParseSlice();
        stageStartedAt = getParseClock();
      }
    });
    parseMs += Math.max(0, getParseClock() - stageStartedAt);

    if (Logger.event && (!Logger.isEnabled || Logger.isEnabled('DEBUG'))) {
      Logger.event('article_parse', {
        url: logUrl(job.url),
        queueWaitMs: Math.max(0, startedAt - job.queuedAt),
        parseMs: Math.round(parseMs),
        elapsedMs: Math.max(0, Date.now() - startedAt),
        images: imageResult.images.length,
        imageParsePartial: imageResult.partial,
        resources: SharedUtils.countResources(resources),
        textAttachments: textAttachments.length
      }, 'DEBUG');
    }
    return {
      resources: resources,
      textAttachments: textAttachments,
      images: imageResult.images,
      imagesPartial: imageResult.partial
    };
  }

  function drainArticleParseQueue(continued) {
    if (articleParseRunning || !articleParseQueue.length) return;
    articleParseRunning = true;
    // 队列从空闲被唤醒：主线程刚让出过，本片预算重新计时；
    // 同一轮连续排干时沿用当前片，避免小帖之间也被拆帧
    if (!continued) articleParseSliceStartedAt = getParseClock();
    var job = articleParseQueue.shift();
    runArticleParseJob(job).then(job.resolve, job.reject).finally(function() {
      articleParseRunning = false;
      drainArticleParseQueue(true);
    });
  }

  function enqueueArticleParse(html, finalUrl, settings, url, deadline) {
    return new Promise(function(resolve, reject) {
      articleParseQueue.push({
        html: html,
        finalUrl: finalUrl,
        settings: settings,
        url: url,
        deadline: deadline || Infinity,
        queuedAt: Date.now(),
        resolve: resolve,
        reject: reject
      });
      drainArticleParseQueue();
    });
  }

  function hasResourcePayload(resources) {
    return SharedUtils.hasResourcePayload(resources);
  }

  function makeTextResourceFetchStatus(resources, attemptedCount, unresolvedCount, retryableCount, yielded, accessDeniedCount) {
    var normalized = SharedUtils.normalizeResources(resources);
    var attempted = Math.max(0, Number(attemptedCount) || 0);
    var unresolved = Math.max(0, Number(unresolvedCount) || 0);
    if (unresolved > attempted) unresolved = attempted;
    var retryable = Math.max(0, Number(retryableCount) || 0);
    if (retryable > unresolved) retryable = unresolved;
    var status = {
      resources: normalized,
      attemptedCount: attempted,
      unresolvedCount: unresolved,
      retryableCount: retryable
    };
    if (yielded) status.yielded = true;
    var denied = Math.min(unresolved, Math.max(0, Number(accessDeniedCount) || 0));
    if (denied) status.accessDeniedCount = denied;
    return status;
  }

  function normalizeTextResourceFetchStatus(result, attachments) {
    var fallbackAttemptedCount = attachments.length;
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'resources')) {
      var attempted = Number(result.attemptedCount);
      if (!isFinite(attempted) || attempted < 0) attempted = Number(fallbackAttemptedCount) || 0;
      var unresolved = Number(result.unresolvedCount);
      if (!isFinite(unresolved) || unresolved < 0) {
        unresolved = hasResourcePayload(result.resources) ? Math.max(0, attempted - 1) : attempted;
      }
      var retryable = Number(result.retryableCount);
      if (!isFinite(retryable) || retryable < 0) retryable = unresolved;
      var status = makeTextResourceFetchStatus(result.resources, attempted, unresolved, retryable,
        result.yielded === true, result.accessDeniedCount);
      if (Array.isArray(result.resolvedIndexes)) {
        var indexes = new Set(result.resolvedIndexes);
        status.resolvedAttachments = attachments.filter(function(item, index) { return indexes.has(index); });
      } else if (!unresolved && hasResourcePayload(status.resources)) {
        status.resolvedAttachments = attachments.slice();
      }
      var limit = result.forumCooldown;
      if (limit && Number.isFinite(limit.at) && Number.isFinite(limit.until) && limit.at > 0 && limit.until > limit.at) {
        status.forumCooldown = limit;
      }
      if (Array.isArray(result.observedForumCooldowns)) status.observedForumCooldowns = result.observedForumCooldowns;
      return status;
    }
    var resources = SharedUtils.normalizeResources(result);
    var fallbackAttempted = Math.max(0, Number(fallbackAttemptedCount) || 0);
    var fallbackUnresolved = hasResourcePayload(resources) ? 0 : fallbackAttempted;
    var legacy = makeTextResourceFetchStatus(resources, fallbackAttempted, fallbackUnresolved, fallbackUnresolved);
    if (!fallbackUnresolved && attachments.length === 1) legacy.resolvedAttachments = attachments.slice();
    return legacy;
  }

  function getTextResourceDeadline(options, count) {
    options = options || {};
    var deadline = Math.max(0, Number(options.deadline || 0) || 0);
    if (deadline) return deadline;
    count = Math.max(1, Math.min(TEXT_ATTACHMENT_MAX_COUNT, Number(count) || 1));
    return Date.now() + SharedUtils.getTextAttachmentBackgroundTimeout(count);
  }

  function withTextResourceDeadline(options, deadline) {
    var next = {};
    options = options || {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) next[key] = options[key];
    }
    next.deadline = deadline;
    return next;
  }

  function withTextRequestControl(options) {
    options = options || {};
    if (options._textRequestControl) return options;
    var next = Object.assign({}, options);
    // One run shares this latch through bridge/direct/worker fallbacks. A
    // transient cancellation seen by the pacer must still reach the caller.
    next._textRequestControl = { yielded: false };
    return next;
  }

  function shouldYieldTextRequest(options) {
    if (!options) return false;
    var control = options._textRequestControl;
    if (control && control.yielded) return true;
    var cancelled = false;
    try {
      // A manual retry keeps its place while scrolling, but a replaced thread
      // no longer owns the unsent work.
      cancelled = (typeof options.isStale === 'function' && !!options.isStale()) ||
        (!options.manualRetry && !options.force && typeof options.isCancelled === 'function' && !!options.isCancelled());
    } catch (e) {}
    if (cancelled && control) control.yielded = true;
    return cancelled;
  }

  function yieldedTextResources() {
    var resources = SharedUtils.emptyResources();
    resources.yielded = true;
    return resources;
  }

  function yieldedTextStatus(attachments, deadline) {
    attachments.forEach(function(attachment) {
      logTextDiagnostic(attachment, 'background_dispatch', 'yielded', '', deadline);
    });
    return makeTextResourceFetchStatus(SharedUtils.emptyResources(), attachments.length,
      attachments.length, attachments.length, true);
  }

  function isTextResourceDeadlineExhausted(deadline) {
    deadline = Math.max(0, Number(deadline || 0) || 0);
    return !!deadline && deadline <= Date.now();
  }

  function getTextAttachmentFetchTimeout(deadline) {
    deadline = Math.max(0, Number(deadline || 0) || 0);
    if (!deadline) return TEXT_ATTACHMENT_TIMEOUT;
    if (deadline <= Date.now()) return 0;
    return Math.max(1, Math.min(TEXT_ATTACHMENT_TIMEOUT, deadline - Date.now()));
  }

  function emptyArticleData(retryable, reason, retryAfter) {
    return ATPCache.normalizeArticleData({
      retryableEmpty: !!retryable,
      emptyReason: reason || '',
      retryAfter: retryAfter || 0
    });
  }

  // Requests to the forum itself queue in the page's pacer (forum-pacer.js);
  // contexts without one fetch straight away.
  var UNPACED_TICKET = { startedAt: 0, waitMs: 0, done: function() {} };

  function acquireForumTurn(options) {
    var pacer = typeof window !== 'undefined' && window ? window.ATPForumPacer : null;
    if (!pacer || typeof pacer.acquire !== 'function') return Promise.resolve(UNPACED_TICKET);
    return pacer.acquire(options);
  }

  function getForumPriority(name) {
    var pacer = typeof window !== 'undefined' && window ? window.ATPForumPacer : null;
    return pacer && typeof pacer[name] === 'number' ? pacer[name] : 0;
  }

  // Automatic and manual TXT work share the caller's deadline. Drops from
  // the pacer become unresolved attachments the reader can retry.
  function getTextPaceOptions(options, cost, stage) {
    options = options || {};
    return {
      manual: !!(options.manualRetry || options.force),
      priority: getForumPriority('PRIORITY_ARTICLE'),
      getPriority: typeof options.getPriority === 'function' ? function() { return options.getPriority(stage); } : null,
      isCancelled: function() { return shouldYieldTextRequest(options); },
      deadline: options.deadline || 0,
      cost: cost || 1
    };
  }

  function withFreshTextDeadline(options) {
    options = options || {};
    if (options.deadline) return options;
    return withTextResourceDeadline(options, Date.now() + SharedUtils.getTextAttachmentBackgroundTimeout(1));
  }

  // What an article answer says about the forum's request budget.
  function getArticleForumOutcome(data) {
    if (!data) return '';
    if (data.aborted) return data.notSent ? 'unused' : '';
    if (data.emptyReason === 'forum_cooldown') return 'unused';
    if (data.retryableEmpty) return SharedUtils.isForumFloodReason(data.emptyReason) ? 'flood' : '';
    return data.emptyReason === 'exception' || data.emptyReason === 'redirect_disallowed' ? '' : 'ok';
  }

  // The forum zone of the page this content script runs on: 'builtin' for
  // the manifest sites, 'mirror:<root>' for an approved mirror.
  function getPageForumZone() {
    return typeof location !== 'undefined' ? SharedUtils.getForumUrlZone(location.href) : '';
  }

  // Redirects must stay on a supported forum in this page's own zone, so a
  // mirror page never receives content fetched from another site.
  function isAllowedArticleFinalUrl(url) {
    var zone = SharedUtils.getForumUrlZone(url);
    if (!zone) return false;
    var pageZone = getPageForumZone();
    return !pageZone || zone === pageZone;
  }

  function isAllowedTextAttachmentFinalUrl(url) {
    return SharedUtils.isTextAttachmentUrlAllowedInZone(url, getPageForumZone(), location.href);
  }

  function getSafeAttachmentReferrer(attachment) {
    if (!attachment || !attachment.url) return '';
    var pageUrl = attachment.pageUrl || (typeof location !== 'undefined' ? location.href : '');
    if (!pageUrl) return '';
    try {
      var referrerUrl = new URL(pageUrl);
      var targetUrl = new URL(attachment.url);
      if (referrerUrl.protocol !== 'https:' || targetUrl.protocol !== 'https:') return '';
      if (referrerUrl.origin !== targetUrl.origin) return '';
      referrerUrl.search = '';
      referrerUrl.hash = '';
      return referrerUrl.href;
    } catch (e) {
      return '';
    }
  }

  function isSameOriginUrl(url) {
    try {
      return new URL(url).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  function settleForumResponse(ticket, outcome, responseUrl, retryAfter) {
    // A response from another origin spends the allowance used to send it.
    // Only the forum on this page can teach its pacer when to pause or recover.
    ticket.done(outcome === 'unused' || isSameOriginUrl(responseUrl) ? outcome : '', retryAfter);
  }

  function decodeBase64Buffer(value) {
    value = String(value || '');
    if (!value || value.length > Math.ceil(TEXT_ATTACHMENT_MAX_BYTES * 4 / 3) + 16) return null;
    try {
      var binary = atob(value);
      if (binary.length > TEXT_ATTACHMENT_MAX_BYTES) return null;
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    } catch (e) {
      return null;
    }
  }

  function extractBridgePayloadBuffer(response) {
    if (!response) return null;
    var raw = response.buffer || response.bytes;
    if (raw && typeof raw.byteLength === 'number') {
      if (raw.byteLength > TEXT_ATTACHMENT_MAX_BYTES) return null;
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(raw)) {
        if (!raw.buffer) return null;
        return raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
          ? raw.buffer
          : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      }
      if (typeof raw.slice === 'function') {
        return raw;
      }
    }
    return decodeBase64Buffer(response.base64);
  }

  function requestTextAttachmentFromPage(attachment, timeoutMs, deadline) {
    if (!attachment || !isSameOriginUrl(attachment.url)) return Promise.resolve(null);
    if (!window || typeof window.addEventListener !== 'function' || typeof window.removeEventListener !== 'function' || typeof window.postMessage !== 'function') {
      return Promise.resolve(null);
    }
    timeoutMs = Math.max(1, Math.min(TEXT_ATTACHMENT_TIMEOUT, Number(timeoutMs) || TEXT_ATTACHMENT_TIMEOUT));
    var now = Date.now();
    var runDeadline = Number.isFinite(deadline) && deadline > 0 ? deadline : Infinity;
    var remainingMs = runDeadline - now;
    if (remainingMs <= 0) return Promise.resolve({ ok: false, error: 'timeout' });
    // The page receives this asynchronously. Start the attempt's budget here.
    var requestDeadline = Math.min(now + timeoutMs, runDeadline);
    return new Promise(function(resolve) {
      var requestId = 'atp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
      var done = false;
      var timer = null;
      function finish(result) {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMessage);
        if (timer) clearTimeout(timer);
        resolve(result || null);
      }
      function onMessage(event) {
        if (event.source !== window || event.origin !== location.origin) return;
        var data = event.data;
        if (!data || data.type !== PAGE_TEXT_FETCH_RESPONSE || data.id !== requestId) return;
        finish(Date.now() < runDeadline ? data : { ok: false, error: 'timeout' });
      }
      window.addEventListener('message', onMessage);
      timer = setTimeout(function() {
        finish(Date.now() >= runDeadline ? { ok: false, error: 'timeout' } : null);
      }, Math.min(timeoutMs + 250, remainingMs));
      try {
        window.postMessage({
          type: PAGE_TEXT_FETCH_REQUEST,
          id: requestId,
          url: attachment.url,
          referrer: getSafeAttachmentReferrer(attachment),
          maxBytes: TEXT_ATTACHMENT_MAX_BYTES,
          timeoutMs: timeoutMs,
          deadline: requestDeadline
        }, location.origin);
      } catch (e) {
        finish(null);
      }
    });
  }

  async function fetchTextAttachmentResourceViaPage(attachment, timeoutMs, writeStartedAt, options) {
    if (shouldYieldTextRequest(options)) {
      logTextDiagnostic(attachment, 'page_bridge', 'yielded', '', options.deadline);
      return { handled: true, resources: yieldedTextResources(), yielded: true };
    }
    var ticket = await acquireForumTurn(getTextPaceOptions(options, 1));
    if (shouldYieldTextRequest(options)) {
      if (ticket) ticket.done('unused');
      logTextDiagnostic(attachment, 'page_bridge', 'yielded', '', options.deadline);
      return { handled: true, resources: yieldedTextResources(), yielded: true };
    }
    // The worker would wait on the same forum allowance. Leave this
    // attachment unresolved for the next retry.
    timeoutMs = getTextAttachmentFetchTimeout(options.deadline);
    if (!ticket || timeoutMs <= 0) {
      if (ticket) ticket.done('unused');
      logTextDiagnostic(attachment, 'page_bridge', 'skipped', 'pace_deadline', options.deadline);
      return { handled: true, resources: SharedUtils.emptyResources(), finalFailure: 'pace_deadline' };
    }
    var report = { outcome: '', retryAfter: 0 };
    try {
      return await readTextAttachmentViaPage(attachment, timeoutMs, writeStartedAt, report, options.deadline);
    } finally {
      ticket.done(report.outcome, report.retryAfter);
    }
  }

  async function readTextAttachmentViaPage(attachment, timeoutMs, writeStartedAt, report, deadline) {
    var startedAt = Date.now();
    var response = await requestTextAttachmentFromPage(attachment, timeoutMs, deadline);
    if (!response || response.ok !== true) {
      // The forum's HTTP answer is final for this attempt: repeating it through
      // the content script and then the worker tripled requests to a server
      // that was already refusing or throttling. Only transport failures and
      // cross-origin redirects (which the worker can follow) fall back.
      var httpStatus = response ? Number(response.status) || 0 : 0;
      var error = response && response.error;
      var challenge = error === 'forum_challenge';
      if ((challenge || httpStatus === 429 || httpStatus === 503) && error !== 'redirect_not_allowed' &&
          isSameOriginUrl(response.finalUrl || attachment.url)) {
        report.outcome = 'flood';
        if (typeof response.retryAfter === 'string') report.retryAfter = SharedUtils.parseRetryAfterHeader(response.retryAfter);
      }
      if (challenge || httpStatus >= 400 || error === 'response_too_large' || error === 'timeout') {
        var failureClass = challenge ? 'forum_challenge' : textFailureClass(error, httpStatus);
        logTextDiagnostic(attachment, 'page_bridge', 'failed', failureClass, deadline,
          { status: httpStatus, elapsedMs: Date.now() - startedAt });
        return { handled: true, resources: SharedUtils.emptyResources(), finalFailure: failureClass };
      }
      // Once the page's own request reached the forum and failed in transport
      // (typically the forum redirecting to a download host), the isolated
      // world's fetch fails the same way under the page's CORS; only the
      // worker can follow, so go there directly instead of asking again.
      var sentRequest = !!response && response.error !== 'url_not_allowed';
      logTextDiagnostic(attachment, 'page_bridge', 'fallback', textFailureClass(response && response.error, httpStatus), deadline,
        { status: httpStatus, elapsedMs: Date.now() - startedAt });
      return { handled: false, resources: SharedUtils.emptyResources(), skipDirect: sentRequest };
    }
    var finalUrl = response.finalUrl || attachment.url;
    if (!isAllowedTextAttachmentFinalUrl(finalUrl)) {
      logTextDiagnostic(attachment, 'page_bridge', 'fallback', 'redirect_not_allowed', deadline);
      return { handled: false, resources: SharedUtils.emptyResources(), skipDirect: true };
    }
    var buffer = extractBridgePayloadBuffer(response);
    if (!buffer) {
      logTextDiagnostic(attachment, 'page_bridge', 'fallback', 'invalid_bridge_payload', deadline);
      return { handled: false, resources: SharedUtils.emptyResources() };
    }
    var text = SharedUtils.decodeTextBuffer(buffer, response.contentType || '');
    var htmlLike = SharedUtils.looksLikeHtmlDocument(text);
    var sameOrigin = isSameOriginUrl(finalUrl);
    if (sameOrigin && htmlLike && SharedUtils.isTextForumRefusal(text)) {
      // Every other route would get the same challenge page.
      report.outcome = 'flood';
      if (typeof response.retryAfter === 'string') report.retryAfter = SharedUtils.parseRetryAfterHeader(response.retryAfter);
      logTextDiagnostic(attachment, 'page_bridge', 'failed', 'forum_challenge', deadline);
      return { handled: true, resources: SharedUtils.emptyResources(), finalFailure: 'forum_challenge' };
    }
    var downloadUrls = htmlLike || SharedUtils.looksLikeDownloadIntermediary(text)
      ? SharedUtils.extractTextDownloadUrls(text, finalUrl, TEXT_ATTACHMENT_MAX_COUNT)
      : [];
    if (htmlLike) {
      logTextDiagnostic(attachment, 'page_bridge', 'fallback', 'download_intermediary', deadline);
      return { handled: false, resources: SharedUtils.emptyResources(), downloadUrls: downloadUrls, finalUrl: finalUrl, skipDirect: true };
    }
    if (!text || SharedUtils.isUnavailableTextDocument(text)) {
      logTextDiagnostic(attachment, 'page_bridge', 'empty', 'unavailable_document', deadline);
      return { handled: true, resources: SharedUtils.emptyResources(), finalFailure: true };
    }
    if (sameOrigin) report.outcome = 'ok';
    var resources = SharedUtils.normalizeResources(SharedUtils.extractResources(text, finalUrl, 'txt'));
    if (downloadUrls.length) {
      logTextDiagnostic(attachment, 'page_bridge', 'fallback', 'download_intermediary', deadline);
      return { handled: false, resources: resources, downloadUrls: downloadUrls, finalUrl: finalUrl };
    }
    if (hasResourcePayload(resources)) {
      ATPCache.setCachedTextResources(attachment.url, resources, writeStartedAt);
      ATPCache.clearTextFailCache(attachment.url);
    }
    logTextDiagnostic(attachment, 'page_bridge', hasResourcePayload(resources) ? 'success' : 'empty',
      hasResourcePayload(resources) ? '' : 'no_resource_links', deadline,
      { resources: SharedUtils.countResources(resources), elapsedMs: Date.now() - startedAt });
    return { handled: true, resources: resources, finalFailure: !hasResourcePayload(resources) };
  }

  async function followTextDownloadUrls(attachment, finalUrl, downloadUrls, depth, hardFailSet, options) {
    var ancestors = (options._textDownloadAncestors || []).concat(attachment.url, finalUrl);
    var nextOptions = Object.assign({}, options, { _textDownloadAncestors: ancestors });
    var accessDenied = false;
    for (var d = 0; d < downloadUrls.length; d++) {
      if (shouldYieldTextRequest(options)) return yieldedTextResources();
      if (isTextResourceDeadlineExhausted(options.deadline)) break;
      var url = downloadUrls[d];
      if (ancestors.indexOf(url) !== -1 || !isAllowedTextAttachmentFinalUrl(url)) continue;
      var nextAttachment = {
        url: url,
        name: attachment.name,
        source: 'txt-download-url',
        pageUrl: attachment.pageUrl || finalUrl,
        diagnosticId: attachment.diagnosticId,
        diagnosticThreadId: attachment.diagnosticThreadId,
        diagnosticRunId: attachment.diagnosticRunId
      };
      var resources = null;
      if (isSameOriginUrl(url)) {
        resources = await ATPFetcher.fetchTextAttachmentResource(nextAttachment, depth + 1, hardFailSet, nextOptions);
        if ((resources && resources.yielded) || hasResourcePayload(resources)) return resources;
        if (hardFailSet[url]) {
          if (hardFailSet[url] === 'auth_or_forbidden') accessDenied = true;
          continue;
        }
      }
      var status = await ATPFetcher.fetchTextAttachmentResourcesByBackgroundWithStatus([nextAttachment], nextOptions, 'background_fallback');
      if (status.yielded) return yieldedTextResources();
      if (hasResourcePayload(status.resources)) return status.resources;
      if (status.accessDeniedCount) accessDenied = true;
    }
    if (accessDenied) hardFailSet[attachment.url] = 'auth_or_forbidden';
    return SharedUtils.emptyResources();
  }

  function logUrl(url) {
    return Logger.sanitizeUrl ? Logger.sanitizeUrl(url) : String(url || '').replace(/[?#].*$/, '').substring(0, 240);
  }

  var ATPFetcher = {
    getSettings: function() {
      return window.ATPState && window.ATPState.settings;
    },

    extractImages: function(html, baseUrl, maxCount) {
      return SharedUtils.extractImages(html, baseUrl, maxCount);
    },

    fetchArticleImages: async function(url, baseUrl) {
      var data = await ATPFetcher.fetchArticleData(url, baseUrl);
      return data.images;
    },

    fetchTextAttachmentResources: async function(attachments, options) {
      var status = await ATPFetcher.fetchTextAttachmentResourcesWithStatus(attachments, options);
      if (status.yielded) status.resources.yielded = true;
      return status.resources;
    },

    fetchTextAttachmentResourcesWithStatus: async function(attachments, options) {
      options = withTextRequestControl(options);
      var manualRetry = !!(options.manualRetry || options.force);
      var sourceAttachments = attachments || [];
      attachments = [];
      var seenAttachments = {};
      for (var ai = 0; ai < sourceAttachments.length && attachments.length < TEXT_ATTACHMENT_MAX_COUNT; ai++) {
        var attachment = sourceAttachments[ai];
        if (!attachment || !attachment.url) continue;
        var attachmentKey = SharedUtils.normalizeTextAttachmentUrl(attachment.url);
        if (!attachmentKey || seenAttachments[attachmentKey]) continue;
        seenAttachments[attachmentKey] = true;
        attachments.push(withTextDiagnosticId(attachment, options));
      }
      if (!attachments.length) return makeTextResourceFetchStatus(SharedUtils.emptyResources(), 0, 0, 0);
      var deadline = getTextResourceDeadline(options, attachments.length);
      options = withTextResourceDeadline(options, deadline);

      var hardFailSet = {};
      var unresolvedCount = 0;
      var retryableCount = 0;
      var accessDeniedCount = 0;

      var same = [], otherForum = [], downloads = [];
      for (var a = 0; a < attachments.length; a++) {
        if (isSameOriginUrl(attachments[a].url)) same.push(attachments[a]);
        else if (SharedUtils.getForumUrlZone(attachments[a].url)) otherForum.push(attachments[a]);
        else downloads.push(attachments[a]);
      }

      var merged = SharedUtils.emptyResources();
      var resolvedAttachments = [];
      function recordResources(resources, confirmed) {
        if (!hasResourcePayload(resources)) return;
        merged = SharedUtils.mergeResources(merged, resources);
        if (confirmed) resolvedAttachments.push.apply(resolvedAttachments, confirmed);
        if (attachments.length > 1 && typeof options.onResources === 'function') options.onResources(resources, confirmed);
      }

      function recordBackgroundResult(status) {
        unresolvedCount += status.unresolvedCount;
        retryableCount += status.retryableCount;
        accessDeniedCount += status.accessDeniedCount || 0;
        recordResources(status.resources, status.resolvedAttachments);
      }

      async function readCrossOrigin(cross) {
        if (!cross.length) return;
        // 跨域附件发 background 前先查正缓存，避免陈旧失败缓存遮蔽有效资源。
        var crossCachePromises = [];
        for (var cp = 0; cp < cross.length; cp++) {
          crossCachePromises.push((function(attachment) {
            return ATPCache.getCachedTextResources(attachment.url).then(function(cached) {
              if (cached && hasResourcePayload(cached)) {
                ATPCache.clearTextFailCache(attachment.url);
                Logger.debug('TXT附件缓存命中', (attachment.name || logUrl(attachment.url)) + ' 资源' + SharedUtils.countResources(cached));
                return { attachment: attachment, cached: cached, fail: false };
              }
              if (manualRetry) return { attachment: attachment, cached: null, fail: false };
              return ATPCache.getTextFailCache(attachment.url).then(function(fail) {
                return { attachment: attachment, cached: null, fail: fail };
              });
            });
          })(cross[cp]));
        }
        var crossCacheChecks = await Promise.all(crossCachePromises);
        var crossFiltered = [];
        for (var cf = 0; cf < crossCacheChecks.length; cf++) {
          if (crossCacheChecks[cf].cached) {
            recordResources(crossCacheChecks[cf].cached, [crossCacheChecks[cf].attachment]);
          } else if (crossCacheChecks[cf].fail) {
            Logger.debug('TXT附件跨域失败缓存命中，跳过', logUrl(crossCacheChecks[cf].attachment.url));
            hardFailSet[crossCacheChecks[cf].attachment.url] = true;
            unresolvedCount++;
            retryableCount++;
          } else {
            crossFiltered.push(crossCacheChecks[cf].attachment);
          }
        }
        // Hand over one attachment at a time so a replaced thread can
        // release the unsent work and display every completed result early.
        for (var pendingIndex = 0; pendingIndex < crossFiltered.length; pendingIndex++) {
          if (shouldYieldTextRequest(options)) {
            recordBackgroundResult(yieldedTextStatus(crossFiltered.slice(pendingIndex), deadline));
            break;
          }
          recordBackgroundResult(await ATPFetcher.fetchTextAttachmentResourcesByBackgroundWithStatus(
            [crossFiltered[pendingIndex]], options));
        }
      }

      // Publish positive cache hits before starting the serial forum requests.
      // A slow first attachment should only delay the other network misses.
      async function readForumAttachments() {
        var cachedSame = await Promise.all(same.map(async function(attachment) {
          if (!SharedUtils.isTextAttachmentUrlAllowedInZone(attachment.url, getPageForumZone(), location.href)) return false;
          var cached;
          try { cached = await ATPCache.getCachedTextResources(attachment.url); } catch (e) { return false; }
          if (!hasResourcePayload(cached)) return false;
          ATPCache.clearTextFailCache(attachment.url);
          Logger.debug('TXT附件缓存命中', (attachment.name || logUrl(attachment.url)) + ' 资源' + SharedUtils.countResources(cached));
          recordResources(cached, [attachment]);
          return true;
        }));
        var pending = same.filter(function(attachment, index) { return !cachedSame[index]; });
        for (var s = 0; s < pending.length; s++) {
          var current = pending[s];
          var direct = await ATPFetcher.fetchTextAttachmentResource(current, 0, hardFailSet, options, true);
          if (hasResourcePayload(direct)) {
            recordResources(direct, [current]);
          } else if (hardFailSet[current.url] || options._textRequestControl.yielded) {
            unresolvedCount++;
            retryableCount++;
            if (hardFailSet[current.url] === 'auth_or_forbidden') accessDeniedCount++;
          } else {
            recordBackgroundResult(await ATPFetcher.fetchTextAttachmentResourcesByBackgroundWithStatus([current], options, 'background_fallback'));
          }
          if (options._textRequestControl.yielded) {
            unresolvedCount += pending.length - s - 1;
            retryableCount += pending.length - s - 1;
            break;
          }
        }
        await readCrossOrigin(otherForum);
      }

      // Downloads use a separate, serial worker batch. Keep the thread slot until both groups settle.
      var groups = await Promise.allSettled([readForumAttachments(), readCrossOrigin(downloads)]);
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].status === 'rejected') throw groups[i].reason;
      }
      var resolvedCount = attachments.length - unresolvedCount;
      if (resolvedCount < 0) unresolvedCount = attachments.length;
      if (unresolvedCount === 0 && !hasResourcePayload(merged)) {
        unresolvedCount = attachments.length;
        retryableCount = attachments.length;
      }
      var status = makeTextResourceFetchStatus(merged, attachments.length, unresolvedCount, retryableCount,
        options._textRequestControl.yielded, accessDeniedCount);
      status.resolvedAttachments = resolvedAttachments;
      return status;
    },

    fetchTextAttachmentResourcesByBackground: function(attachments, options, stage) {
      return ATPFetcher.fetchTextAttachmentResourcesByBackgroundWithStatus(attachments, options, stage).then(function(status) {
        if (status.yielded) status.resources.yielded = true;
        return status.resources;
      });
    },

    fetchTextAttachmentResourcesByBackgroundWithStatus: async function(attachments, options, stage) {
      options = withTextRequestControl(options);
      attachments = (attachments || []).map(function(attachment) { return withTextDiagnosticId(attachment, options); });
      var deadline = getTextResourceDeadline(options, attachments.length);
      if (shouldYieldTextRequest(options)) return yieldedTextStatus(attachments, deadline);
      if (isTextResourceDeadlineExhausted(deadline)) {
        attachments.forEach(function(attachment) { logTextDiagnostic(attachment, 'background_dispatch', 'skipped', 'deadline', deadline); });
        return makeTextResourceFetchStatus(SharedUtils.emptyResources(), attachments.length, attachments.length, attachments.length);
      }
      // The worker's requests reach the forum from the same browser, so the
      // forum-hosted attachments in the batch spend this page's allowance.
      var forumCount = 0;
      for (var fi = 0; fi < attachments.length; fi++) {
        if (attachments[fi] && SharedUtils.getForumUrlZone(attachments[fi].url)) forumCount++;
      }
      if (forumCount && !options.manualRetry && !options.force) {
        attachments.forEach(function(attachment) { logTextDiagnostic(attachment, 'background_pace', 'queued', '', deadline); });
      }
      var ticket = forumCount
        ? await acquireForumTurn(getTextPaceOptions(withTextResourceDeadline(options, deadline), forumCount, stage))
        : UNPACED_TICKET;
      if (shouldYieldTextRequest(options)) {
        if (ticket) ticket.done('unused');
        return yieldedTextStatus(attachments, deadline);
      }
      if (!ticket || isTextResourceDeadlineExhausted(deadline)) {
        if (ticket) ticket.done('unused');
        attachments.forEach(function(attachment) { logTextDiagnostic(attachment, 'background_dispatch', 'skipped', 'pace_deadline', deadline); });
        return makeTextResourceFetchStatus(SharedUtils.emptyResources(), attachments.length, attachments.length, attachments.length);
      }
      var status;
      try {
        status = await ATPFetcher._requestTextResourcesFromBackground(attachments, options, deadline, forumCount ? ticket.waitMs : undefined);
        return status;
      } finally {
        var cooldown = status && status.forumCooldown;
        var refusal = status && status.observedForumCooldowns && status.observedForumCooldowns.find(function(limit) {
          return limit && isSameOriginUrl(limit.origin);
        });
        var unused = status && (status.yielded || (cooldown && cooldown.deferredWithoutRequest));
        if (forumCount) {
          if (refusal) ticket.done('flood', refusal.retryAfter, refusal.at);
          else ticket.done(unused ? 'unused' : '');
        } else if (refusal && window.ATPForumPacer && typeof window.ATPForumPacer.noteExternalCooldown === 'function') {
          // A download relay can reach the forum without a content-script ticket.
          window.ATPForumPacer.noteExternalCooldown(refusal.retryAfter, refusal.at);
        }
      }
    },

    _requestTextResourcesFromBackground: function(attachments, options, deadline, paceWaitMs) {
      var manualRetry = !!(options.manualRetry || options.force);
      return new Promise(function(resolve) {
        if (shouldYieldTextRequest(options)) {
          resolve(yieldedTextStatus(attachments, deadline));
          return;
        }
        var done = false;
        var timeoutMs = Math.max(1, deadline - Date.now());
        var timer = setTimeout(function() {
          if (!done) {
            done = true;
            timer = null;
            attachments.forEach(function(attachment) { logTextDiagnostic(attachment, 'background_dispatch', 'failed', 'message_deadline', deadline); });
            resolve(makeTextResourceFetchStatus(SharedUtils.emptyResources(), attachments.length, attachments.length, attachments.length));
          }
        }, timeoutMs);
        try {
          attachments.forEach(function(attachment) {
            logTextDiagnostic(attachment, 'background_dispatch', 'sent', '', deadline, { paceWaitMs: paceWaitMs });
          });
          chrome.runtime.sendMessage({
            type: SharedUtils.MESSAGE_TYPES.FETCH_TEXT_RESOURCES,
            attachments: attachments,
            deadline: deadline,
            manualRetry: manualRetry
          }, function(resp) {
            var runtimeError = chrome.runtime.lastError;
            if (done) return;
            done = true;
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            if (runtimeError) {
              attachments.forEach(function(attachment) { logTextDiagnostic(attachment, 'background_dispatch', 'failed', 'extension_message', deadline); });
              resolve(makeTextResourceFetchStatus(SharedUtils.emptyResources(), attachments.length, attachments.length, attachments.length));
              return;
            }
            if (resp && (resp.queueStatus === 'busy' || resp.queueStatus === 'expired')) {
              attachments.forEach(function(attachment) { logTextDiagnostic(attachment, 'background_dispatch', 'skipped', 'queue_' + resp.queueStatus, deadline); });
            } else if (!resp) {
              attachments.forEach(function(attachment) { logTextDiagnostic(attachment, 'background_dispatch', 'failed', 'no_response', deadline); });
            }
            resolve(normalizeTextResourceFetchStatus(resp, attachments));
          });
        } catch (e) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            attachments.forEach(function(attachment) { logTextDiagnostic(attachment, 'background_dispatch', 'failed', 'extension_message', deadline); });
            resolve(makeTextResourceFetchStatus(SharedUtils.emptyResources(), attachments.length, attachments.length, attachments.length));
          }
        }
      });
    },

    fetchTextAttachmentResource: async function(attachment, depth, hardFailSet, options, positiveCacheChecked) {
      options = withTextRequestControl(options);
      hardFailSet = hardFailSet || {};
      attachment = withTextDiagnosticId(attachment, options);
      var writeStartedAt = Date.now();
      var manualRetry = !!(options.manualRetry || options.force);
      depth = depth || 0;
      try {
        if (!SharedUtils.isTextAttachmentUrlAllowedInZone(attachment.url, getPageForumZone(), location.href)) {
          Logger.debug('TXT attachment URL blocked', logUrl(attachment.url));
          return SharedUtils.emptyResources();
        }

        var cached = positiveCacheChecked ? null : await ATPCache.getCachedTextResources(attachment.url);
        if (cached) {
          ATPCache.clearTextFailCache(attachment.url);
          Logger.debug('TXT附件缓存命中', (attachment.name || logUrl(attachment.url)) + ' 资源' + SharedUtils.countResources(cached));
          return cached;
        }

        if (!manualRetry) {
          var failCached = await ATPCache.getTextFailCache(attachment.url);
          if (failCached) {
            Logger.debug('TXT附件失败缓存命中，跳过', logUrl(attachment.url));
            if (hardFailSet) hardFailSet[attachment.url] = true;
            return SharedUtils.emptyResources();
          }
        }

        if (shouldYieldTextRequest(options)) {
          logTextDiagnostic(attachment, 'direct', 'yielded', '', options.deadline);
          return yieldedTextResources();
        }
        var fetchTimeout = getTextAttachmentFetchTimeout(options.deadline);
        if (fetchTimeout <= 0) {
          logTextDiagnostic(attachment, 'direct', 'skipped', 'deadline', options.deadline);
          return SharedUtils.emptyResources();
        }

        var sameOrigin = isSameOriginUrl(attachment.url);
        if (sameOrigin) {
          var pageResult = await fetchTextAttachmentResourceViaPage(attachment, fetchTimeout, writeStartedAt, options);
          if (pageResult.handled) {
            if (pageResult.finalFailure && hardFailSet) hardFailSet[attachment.url] = pageResult.finalFailure;
            return pageResult.resources;
          }
          if (pageResult.downloadUrls && pageResult.downloadUrls.length) {
            var followed = depth < 2
              ? await followTextDownloadUrls(attachment, pageResult.finalUrl, pageResult.downloadUrls, depth, hardFailSet, options)
              : SharedUtils.emptyResources();
            if (followed.yielded) return hasResourcePayload(pageResult.resources) ? pageResult.resources : followed;
            var pageResources = hasResourcePayload(followed) ? followed : pageResult.resources;
            if (hasResourcePayload(pageResources)) {
              ATPCache.setCachedTextResources(attachment.url, pageResources, writeStartedAt);
              ATPCache.clearTextFailCache(attachment.url);
            } else if (!hardFailSet[attachment.url]) {
              hardFailSet[attachment.url] = true;
            }
            return pageResources;
          }
          if (pageResult.skipDirect) return SharedUtils.emptyResources();
          fetchTimeout = getTextAttachmentFetchTimeout(options.deadline);
          if (fetchTimeout <= 0) return SharedUtils.emptyResources();
        }

        var ticket = sameOrigin ? await acquireForumTurn(getTextPaceOptions(options, 1)) : UNPACED_TICKET;
        if (shouldYieldTextRequest(options)) {
          if (ticket) ticket.done('unused');
          logTextDiagnostic(attachment, 'direct', 'yielded', '', options.deadline);
          return yieldedTextResources();
        }
        fetchTimeout = getTextAttachmentFetchTimeout(options.deadline);
        if (!ticket || fetchTimeout <= 0) {
          if (ticket) ticket.done('unused');
          logTextDiagnostic(attachment, 'direct', 'skipped', 'pace_deadline', options.deadline);
          hardFailSet[attachment.url] = 'pace_deadline';
          return SharedUtils.emptyResources();
        }
        var report = { outcome: '', retryAfter: 0, ticket: ticket };
        try {
          return await ATPFetcher._readTextAttachmentDirect(attachment, depth, hardFailSet, options, fetchTimeout, writeStartedAt, report);
        } finally {
          ticket.done(report.outcome, report.retryAfter);
        }
      } catch (e) {
        logTextDiagnostic(attachment, 'direct', 'failed', textFailureClass(e), options.deadline);
        return SharedUtils.emptyResources();
      }
    },

    _readTextAttachmentDirect: async function(attachment, depth, hardFailSet, options, fetchTimeout, writeStartedAt, report) {
      report = report || {};
      var diagnosticStartedAt = Date.now();
      var diagnosticOutcome = 'failed';
      var diagnosticFailure = 'request_error';
      var diagnosticStatus = 0;
      var diagnosticResources = 0;
      try {
        var ctrl = new AbortController();
        var t = setTimeout(function() { ctrl.abort(); }, fetchTimeout);
        try {
          var fetchOptions = {
            signal: ctrl.signal,
            credentials: 'include',
            headers: { 'Accept': 'text/plain, application/octet-stream;q=0.9, */*;q=0.5' }
          };
          if (isSameOriginUrl(attachment.url)) fetchOptions.mode = 'same-origin';
          var referrer = getSafeAttachmentReferrer(attachment);
          if (referrer) {
            fetchOptions.referrer = referrer;
            fetchOptions.referrerPolicy = 'strict-origin-when-cross-origin';
          }
          var resp = await fetch(attachment.url, fetchOptions);
          diagnosticStatus = resp.status;
          var finalAttachmentUrl = resp.url || attachment.url;
          if (!isAllowedTextAttachmentFinalUrl(finalAttachmentUrl)) {
            diagnosticFailure = 'redirect_not_allowed';
            return SharedUtils.emptyResources();
          }

          if (isSameOriginUrl(finalAttachmentUrl) && SharedUtils.isCloudflareChallengeResponse(resp)) {
            report.outcome = 'flood';
            report.retryAfter = SharedUtils.parseRetryAfterHeader(resp.headers);
            if (hardFailSet) hardFailSet[attachment.url] = true;
            diagnosticFailure = 'forum_challenge';
            return SharedUtils.emptyResources();
          }
          if (!resp.ok) {
            var status = resp.status;
            diagnosticFailure = textFailureClass('', status);
            var isHardFail = status === 401 || status === 403;
            if (isHardFail) {
              ATPCache.setTextFailCache(attachment.url, writeStartedAt);
              if (hardFailSet) hardFailSet[attachment.url] = diagnosticFailure;
              return SharedUtils.emptyResources();
            }
            if (status === 429 || status >= 500) {
              if ((status === 429 || status === 503) && isSameOriginUrl(finalAttachmentUrl)) {
                report.outcome = 'flood';
                report.retryAfter = SharedUtils.parseRetryAfterHeader(resp.headers);
              }
              // Retrying the same request through the worker right away only
              // adds load; it stays retryable for the next attempt.
              if (hardFailSet) hardFailSet[attachment.url] = true;
              return SharedUtils.emptyResources();
            }
            return SharedUtils.emptyResources();
          }
          if (resp.redirected && /\/login|\/signin|\/member|\/register/.test(resp.url)) {
            diagnosticFailure = 'login_redirect';
            return SharedUtils.emptyResources();
          }

          var len = parseInt(resp.headers.get('content-length') || '0', 10);
          if (len > TEXT_ATTACHMENT_MAX_BYTES) {
            diagnosticFailure = 'response_too_large';
            return SharedUtils.emptyResources();
          }

          var contentType = resp.headers.get('content-type') || '';
          var buffer;
          try {
            buffer = await SharedUtils.readResponseArrayBufferLimited(resp, TEXT_ATTACHMENT_MAX_BYTES);
          } catch (readError) {
            if (readError && readError.name === 'ResponseTooLargeError') {
              diagnosticFailure = 'response_too_large';
              return SharedUtils.emptyResources();
            }
            throw readError;
          }

          var text = SharedUtils.decodeTextBuffer(buffer, contentType);
          var htmlLike = SharedUtils.looksLikeHtmlDocument(text);
          var sameOrigin = isSameOriginUrl(finalAttachmentUrl);
          if (sameOrigin && htmlLike && SharedUtils.isTextForumRefusal(text)) {
            // The worker would be handed the same challenge page.
            report.outcome = 'flood';
            report.retryAfter = SharedUtils.parseRetryAfterHeader(resp.headers);
            if (hardFailSet) hardFailSet[attachment.url] = 'forum_challenge';
            diagnosticFailure = 'forum_challenge';
            return SharedUtils.emptyResources();
          }
          var unavailable = !text || htmlLike || SharedUtils.isUnavailableTextDocument(text);
          if (sameOrigin && !unavailable) report.outcome = 'ok';
          // This request is finished; following a download link below asks
          // the pacer again, which must not wait on this one (one request at a
          // time after a challenge).
          if (report.ticket) report.ticket.done(report.outcome, report.retryAfter);
          var downloadLike = SharedUtils.looksLikeDownloadIntermediary(text);
          if ((htmlLike || downloadLike) && depth < 2) {
            var downloadUrls = SharedUtils.extractTextDownloadUrls(text, finalAttachmentUrl, TEXT_ATTACHMENT_MAX_COUNT);
            var redirectedResources = await followTextDownloadUrls(attachment, finalAttachmentUrl, downloadUrls, depth, hardFailSet, options);
            if (redirectedResources.yielded) {
              diagnosticOutcome = 'yielded';
              diagnosticFailure = '';
              return redirectedResources;
            }
            if (hasResourcePayload(redirectedResources)) {
              diagnosticOutcome = 'success';
              diagnosticFailure = '';
              diagnosticResources = SharedUtils.countResources(redirectedResources);
              ATPCache.setCachedTextResources(attachment.url, redirectedResources, writeStartedAt);
              ATPCache.clearTextFailCache(attachment.url);
              return redirectedResources;
            }
            if (downloadUrls.length && hardFailSet && !hardFailSet[attachment.url]) hardFailSet[attachment.url] = true;
            diagnosticFailure = 'intermediary_unresolved';
          }

          if (unavailable) {
            if (diagnosticFailure !== 'intermediary_unresolved') diagnosticFailure = 'unavailable_document';
            return SharedUtils.emptyResources();
          }

          var resources = SharedUtils.extractResources(text, resp.url || attachment.url, 'txt');
          var normalizedResources = SharedUtils.normalizeResources(resources);
          if (hasResourcePayload(normalizedResources)) {
            ATPCache.setCachedTextResources(attachment.url, normalizedResources, writeStartedAt);
            ATPCache.clearTextFailCache(attachment.url);
          } else if (hardFailSet && !hardFailSet[attachment.url]) {
            hardFailSet[attachment.url] = true;
          }
          diagnosticResources = SharedUtils.countResources(normalizedResources);
          diagnosticOutcome = hasResourcePayload(normalizedResources) ? 'success' : 'empty';
          diagnosticFailure = hasResourcePayload(normalizedResources) ? '' : 'no_resource_links';
          return normalizedResources;
        } finally {
          clearTimeout(t);
          // Early exits (redirect, status, type, size) leave the body unread;
          // abort so a rejected response stops downloading.
          if (resp && !resp.bodyUsed) ctrl.abort();
        }
      } catch (e) {
        diagnosticFailure = !navigator.onLine ? 'offline' : textFailureClass(e);
        return SharedUtils.emptyResources();
      } finally {
        logTextDiagnostic(attachment, 'direct', diagnosticOutcome, diagnosticFailure, options.deadline,
          { status: diagnosticStatus, resources: diagnosticResources, elapsedMs: Date.now() - diagnosticStartedAt, depth: depth });
      }
    },

    fetchArticle: function(url, baseUrl, requestOptions) {
      return ATPFetcher.fetchArticleData(url, baseUrl, requestOptions);
    },

    // requestOptions (optional) tune the wait for the forum pacer:
    // getPriority, isCancelled, onHeld, onGranted(waitMs), abortSignal.
    fetchArticleData: function(url, baseUrl, requestOptions) {
      requestOptions = requestOptions || {};
      var callerSignal = requestOptions.abortSignal || null;
      if (callerSignal && callerSignal.aborted) {
        return Promise.resolve(Object.assign(emptyArticleData(true, 'aborted'), { aborted: true, notSent: true }));
      }
      var inflightKey = (SharedUtils.normalizeArticleUrl ? SharedUtils.normalizeArticleUrl(url) : url) || String(url || '');
      var existing = ARTICLE_FETCH_IN_FLIGHT[inflightKey];
      if (existing) {
        existing.addReader(requestOptions.isCurrent, callerSignal);
        return existing.promise.then(function(data) {
          if (callerSignal && callerSignal.aborted) {
            return Object.assign(emptyArticleData(true, 'aborted'), { aborted: true });
          }
          // The first caller gave up its place in the pacer queue; this one
          // may still need the page. Read the cache anew on that dispatch.
          if (data && (data.emptyReason === 'pace_cancelled' || data.aborted) &&
              (typeof requestOptions.isCurrent !== 'function' || requestOptions.isCurrent())) {
            return ATPFetcher.fetchArticleData(url, baseUrl, Object.assign({}, requestOptions, { cacheState: null }));
          }
          return data;
        });
      }
      var sharedAbortCtrl = typeof AbortController === 'function' ? new AbortController() : null;
      var signalCleanups = [];
      var entry = {
        readers: [],
        signals: [],
        promise: null,
        addReader: function(isCurrentFn, sig) {
          entry.readers.push(isCurrentFn);
          entry.signals.push(sig || null);
          if (sig && sharedAbortCtrl && typeof sig.addEventListener === 'function') {
            var onSigAbort = function() { syncSharedAbort(); };
            sig.addEventListener('abort', onSigAbort, { once: true });
            signalCleanups.push(function() {
              if (typeof sig.removeEventListener === 'function') sig.removeEventListener('abort', onSigAbort);
            });
          }
        }
      };
      function syncSharedAbort() {
        if (!sharedAbortCtrl || sharedAbortCtrl.signal.aborted || !entry.signals.length) return;
        for (var i = 0; i < entry.signals.length; i++) {
          if (!entry.signals[i] || !entry.signals[i].aborted) return;
        }
        sharedAbortCtrl.abort();
      }
      entry.addReader(requestOptions.isCurrent, callerSignal);
      function hasCurrentReader() {
        return entry.readers.some(function(isCurrent, idx) {
          var sig = entry.signals[idx];
          if (sig && sig.aborted) return false;
          return typeof isCurrent !== 'function' || isCurrent();
        });
      }
      var promise = ATPFetcher._fetchArticleDataImpl(
        url,
        baseUrl,
        requestOptions,
        hasCurrentReader,
        sharedAbortCtrl ? sharedAbortCtrl.signal : callerSignal
      );
      entry.promise = promise;
      ARTICLE_FETCH_IN_FLIGHT[inflightKey] = entry;
      var release = function() {
        for (var i = 0; i < signalCleanups.length; i++) signalCleanups[i]();
        signalCleanups.length = 0;
        if (ARTICLE_FETCH_IN_FLIGHT[inflightKey] === entry) delete ARTICLE_FETCH_IN_FLIGHT[inflightKey];
      };
      promise.then(release, release);
      return promise;
    },

    _fetchArticleDataImpl: async function(url, baseUrl, requestOptions, hasCurrentReader, abortSignal) {
      requestOptions = requestOptions || {};
      abortSignal = abortSignal || requestOptions.abortSignal || null;
      if (abortSignal && abortSignal.aborted) {
        return Object.assign(emptyArticleData(true, 'aborted'), { aborted: true, notSent: true });
      }
      var cacheState = requestOptions.cacheState;
      if (!cacheState || !ATPCache.isArticleCacheReadCurrent(cacheState)) cacheState = await ATPCache.getArticleCacheState(url);
      if (abortSignal && abortSignal.aborted) {
        return Object.assign(emptyArticleData(true, 'aborted'), { aborted: true, notSent: true });
      }
      var validCacheState = cacheState && ATPCache.isArticleCacheReadCurrent(cacheState);
      var cached = validCacheState && cacheState.cached;
      if (cached) {
        if (Logger.isEnabled('DEBUG')) {
          Logger.debug('缓存命中', logUrl(url) + ' 图片' + cached.images.length + ' 资源' + SharedUtils.countResources(cached.resources));
        }
        if (cached.hasTextAttachments && !cached.textAttachments.length) {
          Logger.debug('缓存含TXT附件标记，需按需重新提取', logUrl(url));
        }
        return cached;
      }
      if (validCacheState && cacheState.negative && cacheState.negativeExpiresAt > Date.now()) {
        Logger.debug('负缓存命中', logUrl(url));
        var negative = emptyArticleData(true, 'negative_cache', cacheState.negativeExpiresAt);
        negative.cacheState = cacheState;
        return negative;
      }

      var callerIsCancelled = requestOptions.isCancelled;
      var paceCancelledFn = abortSignal ? function() {
        if (abortSignal.aborted) return true;
        return typeof callerIsCancelled === 'function' ? callerIsCancelled() : false;
      } : callerIsCancelled;
      var ticket = await acquireForumTurn({
        priority: getForumPriority('PRIORITY_ARTICLE'),
        getPriority: requestOptions.getPriority,
        isCancelled: paceCancelledFn,
        onHeld: requestOptions.onHeld
      });
      if (!ticket) {
        if (abortSignal && abortSignal.aborted) {
          return Object.assign(emptyArticleData(true, 'aborted'), { aborted: true, notSent: true });
        }
        return emptyArticleData(true, 'pace_cancelled');
      }
      if (abortSignal && abortSignal.aborted) {
        ticket.done('unused');
        return Object.assign(emptyArticleData(true, 'aborted'), { aborted: true, notSent: true });
      }
      if (hasCurrentReader && !hasCurrentReader()) {
        ticket.done('unused');
        return emptyArticleData(true, 'pace_cancelled');
      }
      var result = null;
      var report = { url: url };
      try {
        if (typeof requestOptions.onGranted === 'function') requestOptions.onGranted(ticket.waitMs);
        result = await ATPFetcher._fetchArticleNetwork(url, Date.now(), report, hasCurrentReader, abortSignal);
        return result;
      } finally {
        settleForumResponse(ticket, getArticleForumOutcome(result), report.url, result && result.retryAfter);
      }
    },

    _fetchArticleNetwork: async function(url, writeStartedAt, report, isCurrent, abortSignal) {
      var abortedByCaller = false;
      var sentNetworkRequest = false;
      var onCallerAbort = null;
      if (abortSignal && abortSignal.aborted) {
        return Object.assign(emptyArticleData(true, 'aborted'), { aborted: true, notSent: true });
      }
      try {
        var settings = ATPFetcher.getSettings();
        var articleTimeout = ATPLoadPolicy.getArticleTimeout(settings);
        var ctrl = new AbortController();
        if (abortSignal) {
          onCallerAbort = function() {
            abortedByCaller = true;
            ctrl.abort();
          };
          if (abortSignal.aborted) {
            abortedByCaller = true;
            ctrl.abort();
          } else if (typeof abortSignal.addEventListener === 'function') {
            abortSignal.addEventListener('abort', onCallerAbort, { once: true });
          }
        }
        var t = setTimeout(function() { ctrl.abort(); }, articleTimeout);
        try {
          sentNetworkRequest = true;
          var resp = await fetch(url, {
            signal: ctrl.signal,
            credentials: 'include',
            headers: { 'Accept': 'text/html' }
          });
          var finalUrl = resp.url || url;
          if (report) report.url = finalUrl;
          if (!isAllowedArticleFinalUrl(finalUrl)) {
            Logger.warn('文章重定向已拒绝', logUrl(finalUrl));
            return emptyArticleData(false, 'redirect_disallowed');
          }

          if (SharedUtils.isCloudflareChallengeResponse(resp)) {
            Logger.warn('文章返回 Cloudflare 验证（不写负缓存）', 'HTTP' + resp.status + ' ' + logUrl(url));
            return emptyArticleData(true, 'cloudflare', SharedUtils.parseRetryAfterHeader(resp.headers));
          }
          if (!resp.ok) {
            var status = resp.status;
            var isTransientHttp = status === 401 || status === 403 || status === 429 || (status >= 500 && status <= 599);
            var retryAfter = isTransientHttp ? SharedUtils.parseRetryAfterHeader(resp.headers) : 0;
            if (isTransientHttp) {
              Logger.warn('抓取临时失败 HTTP' + status + '（不写负缓存）', logUrl(url));
            } else {
              Logger.warn('抓取失败 HTTP' + status, logUrl(url));
              ATPCache.setNegativeCache(url, writeStartedAt);
            }
            return emptyArticleData(isTransientHttp, 'http_' + status, retryAfter);
          }
          if ((resp.headers.get('content-type') || '').indexOf('text/html') === -1) {
            Logger.warn('非HTML', logUrl(url));
            ATPCache.setNegativeCache(url, writeStartedAt);
            return emptyArticleData(false, 'non_html');
          }
          if (resp.redirected && /\/login|\/signin|\/member|\/register/.test(resp.url)) {
            Logger.warn('重定向登录页', logUrl(resp.url));
            return emptyArticleData(true, 'login_redirect');
          }
          if (SharedUtils.isOversizedArticleResponse(resp)) {
            Logger.warn('文章HTML过大，跳过解析', logUrl(url));
            return emptyArticleData(false, 'html_too_large');
          }

          var rawHtml;
          try {
            rawHtml = await SharedUtils.readResponseTextLimited(resp, SharedUtils.ARTICLE_HTML_MAX_BYTES);
          } catch (readError) {
            if (readError && readError.name === 'ResponseTooLargeError') {
              Logger.warn('文章HTML过大，跳过解析', logUrl(url));
              return emptyArticleData(false, 'html_too_large');
            }
            throw readError;
          }
          var html = SharedUtils.limitArticleHtml(rawHtml);
          var htmlTruncated = html.length !== rawHtml.length;
          if (htmlTruncated) {
            Logger.warn('文章HTML截断解析', rawHtml.length + ' -> ' + html.length + ' ' + logUrl(url));
          }
          var blockedReason = SharedUtils.isBlockedPage(html);
          if (blockedReason) {
            Logger.warn('文章不可用页（不写负缓存）', blockedReason + ' ' + logUrl(url));
            return emptyArticleData(true, SharedUtils.isForumFloodReason(blockedReason) ||
              blockedReason === 'login_page' || blockedReason === 'permission_page' ? blockedReason : 'blocked');
          }

          // The fetch timeout governs downloading the body. Give the parser
          // its own bounded wall time so arriving near that timeout does not
          // turn a full response into an immediate parse failure.
          clearTimeout(t);
          t = null;
          var parsedArticle = await enqueueArticleParse(html, finalUrl, settings, url, Date.now() + articleTimeout);
          var partial = htmlTruncated || parsedArticle.imagesPartial;
          var resources = parsedArticle.resources;
          var rawTextAttachments = parsedArticle.textAttachments;
          var hasTransientAttachment = false;
          var filteredAttachments = [];
          for (var a = 0; a < rawTextAttachments.length; a++) {
            if (SharedUtils.isTransientTextAttachmentUrl(rawTextAttachments[a].url, finalUrl)) {
              hasTransientAttachment = true;
            } else {
              filteredAttachments.push(rawTextAttachments[a]);
            }
          }
          var freshAttachmentsAt = hasTransientAttachment ? Date.now() : 0;
          var data = await ATPCache.prepareArticleData({
            images: parsedArticle.images,
            resources: resources,
            textAttachments: filteredAttachments,
            textAttachmentHints: SharedUtils.getTextAttachmentHints(rawTextAttachments),
            hasTextAttachments: hasTransientAttachment || !!filteredAttachments.length,
            textAttachmentCount: rawTextAttachments.length,
            textAttachmentsLimited: !!rawTextAttachments.limited,
            imageExtractionVersion: SharedUtils.ARTICLE_IMAGE_EXTRACTION_VERSION,
            partial: partial
          }, isCurrent);
          if (!data) {
            // A dispatched request can reveal forum pushback even after the
            // last reader leaves. Preserve that signal without saving a row.
            var refusal = !parsedArticle.imagesPartial && !parsedArticle.images.length && !rawTextAttachments.length &&
              !hasResourcePayload(resources) && SharedUtils.classifyEmptyArticlePage(html);
            return emptyArticleData(true, refusal && SharedUtils.isForumFloodReason(refusal.reason) ? refusal.reason : 'pace_cancelled');
          }
          if (!data.images.length && !SharedUtils.hasResourcePayload(data.resources) && !data.textAttachments.length && !data.hasTextAttachments) {
            var emptyPage = !parsedArticle.imagesPartial && SharedUtils.classifyEmptyArticlePage(html);
            if (emptyPage && emptyPage.retryable) {
              Logger.warn('正文返回非帖子页（不写负缓存）', emptyPage.reason + ' title="' + SharedUtils.getHtmlPageTitle(html) + '" ' + html.length + '字符 ' + logUrl(url));
              return emptyArticleData(true, emptyPage.reason);
            }
            if (partial) {
              Logger.warn('正文解析未完成且无结果，不写负缓存', logUrl(url));
            } else {
              ATPCache.setNegativeCache(url, writeStartedAt);
            }
          } else {
            ATPCache.setCachedArticleData(url, data, !partial, writeStartedAt);
          }
          // Keep recently extracted signed links for the current tab's
          // automatic TXT work, outside the article cache message.
          if (hasTransientAttachment) {
            data.freshTextAttachments = rawTextAttachments.slice();
            data.freshTextAttachmentsAt = freshAttachmentsAt;
          }
          if (Logger.isEnabled('DEBUG')) {
            Logger.debug('提取完成', logUrl(url) + ' 图片' + data.images.length + ' 资源' + SharedUtils.countResources(data.resources) + ' TXT' + data.textAttachments.length + (data.hasTextAttachments ? '(含Discuz附件' + data.textAttachmentCount + '个)' : ''));
          }
          return data;
        } finally {
          if (t) clearTimeout(t);
          if (onCallerAbort && abortSignal && typeof abortSignal.removeEventListener === 'function') {
            abortSignal.removeEventListener('abort', onCallerAbort);
          }
          // Early exits (redirect, status, type, size) leave the body unread;
          // abort so a rejected response stops downloading.
          if (resp && !resp.bodyUsed) ctrl.abort();
        }
      } catch (e) {
        if (abortedByCaller || (abortSignal && abortSignal.aborted)) {
          return Object.assign(emptyArticleData(true, 'aborted'), { aborted: true, notSent: !sentNetworkRequest });
        }
        var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        var isTransient = offline || e.name === 'AbortError' || e.name === 'TypeError';
        if (isTransient) {
          Logger.warn('抓取临时异常（不写负缓存）', logUrl(url) + ' ' + e.message);
        } else {
          Logger.warn('抓取异常', logUrl(url) + ' ' + e.message);
          ATPCache.setNegativeCache(url, writeStartedAt);
        }
        return emptyArticleData(isTransient, offline ? 'offline' : isTransient ? 'transient_exception' : 'exception');
      }
    },

    fetchArticleDataByBackground: async function(url, requestOptions) {
      requestOptions = requestOptions || {};
      var abortSignal = requestOptions.abortSignal || null;
      if (abortSignal && abortSignal.aborted) {
        return Object.assign(emptyArticleData(true, 'aborted'), { aborted: true, notSent: true });
      }
      var callerIsCancelled = requestOptions.isCancelled;
      var paceCancelledFn = abortSignal ? function() {
        if (abortSignal.aborted) return true;
        return typeof callerIsCancelled === 'function' ? callerIsCancelled() : false;
      } : callerIsCancelled;
      var ticket = await acquireForumTurn({
        priority: getForumPriority('PRIORITY_ARTICLE'),
        getPriority: requestOptions.getPriority,
        isCancelled: paceCancelledFn,
        onHeld: requestOptions.onHeld
      });
      if (!ticket) {
        if (abortSignal && abortSignal.aborted) {
          return Object.assign(emptyArticleData(true, 'aborted'), { aborted: true, notSent: true });
        }
        return null;
      }
      if (abortSignal && abortSignal.aborted) {
        ticket.done('unused');
        return Object.assign(emptyArticleData(true, 'aborted'), { aborted: true, notSent: true });
      }
      if (requestOptions.isCurrent && !requestOptions.isCurrent()) {
        ticket.done('unused');
        return null;
      }
      var data = null;
      var report = { url: url };
      try {
        if (typeof requestOptions.onGranted === 'function') requestOptions.onGranted(ticket.waitMs);
        data = await ATPFetcher._requestArticleDataFromBackground(url, report);
      } finally {
        settleForumResponse(ticket, getArticleForumOutcome(data), report.url, data && data.retryAfter);
      }
      if (!data) return null;
      var cachedByBg = data.cachedByBackground === true;
      var prepared = await ATPCache.prepareArticleData(data, requestOptions.isCurrent);
      if (prepared && cachedByBg) prepared.cachedByBackground = true;
      return prepared;
    },

    _requestArticleDataFromBackground: function(url, report) {
      return new Promise(function(resolve) {
        var settings = ATPFetcher.getSettings();
        var articleTimeout = ATPLoadPolicy.getArticleTimeout(settings);
        var done = false;
        var timeoutMs = articleTimeout + 1000;
        var deadline = Date.now() + articleTimeout;
        var timer = setTimeout(function() {
          if (!done) {
            done = true;
            timer = null;
            resolve(null);
          }
        }, timeoutMs);
        try {
          chrome.runtime.sendMessage({
            type: SharedUtils.MESSAGE_TYPES.FETCH_IMAGES,
            urls: [url],
            maxImages: SharedUtils.effectiveFetchLimit(settings),
            displayImages: SharedUtils.effectiveDisplayLimit(settings),
            heavyImageOptimization: settings && settings.heavyImageOptimization !== false,
            articleTimeout: articleTimeout,
            articleFetchConcurrency: ATPLoadPolicy.getArticleFetchConcurrency(settings),
            deadline: deadline
          }, function(resp) {
            var runtimeError = chrome.runtime.lastError;
            if (done) return;
            done = true;
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            if (runtimeError) {
              Logger.debug('后台文章消息失败', runtimeError.message);
              resolve(null);
              return;
            }
            var article = resp && resp[url];
            if (article && article.forumOrigin && report) report.url = article.forumOrigin;
            resolve(article || null);
          });
        } catch (e) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            Logger.debug('后台文章消息异常', e.message);
            resolve(null);
          }
        }
      });
    },

    fetchTextAttachmentsFreshByBackground: async function(url, options) {
      options = withFreshTextDeadline(withTextRequestControl(options));
      if (shouldYieldTextRequest(options)) return { yielded: true, textAttachments: null };
      var ticket = await acquireForumTurn(getTextPaceOptions(options, 1));
      if (shouldYieldTextRequest(options)) {
        if (ticket) ticket.done('unused');
        return { yielded: true, textAttachments: null };
      }
      if (!ticket || isTextResourceDeadlineExhausted(options.deadline)) {
        if (ticket) ticket.done('unused');
        return null;
      }
      var report = { outcome: '', retryAfter: 0, url: url };
      try {
        var attachments = await ATPFetcher._requestFreshTextAttachmentsFromBackground(url, report, options);
        if (attachments && attachments.yielded) report.outcome = 'unused';
        return attachments;
      } finally {
        settleForumResponse(ticket, report.outcome, report.url, report.retryAfter);
      }
    },

    _requestFreshTextAttachmentsFromBackground: function(url, report, options) {
      return new Promise(function(resolve) {
        if (shouldYieldTextRequest(options)) {
          resolve({ yielded: true, textAttachments: null });
          return;
        }
        var settings = ATPFetcher.getSettings();
        var articleTimeout = ATPLoadPolicy.getArticleTimeout(settings);
        var done = false;
        var now = Date.now();
        var runDeadline = Number(options && options.deadline) || Infinity;
        var deadline = Math.min(now + articleTimeout, runDeadline);
        var timeoutMs = Math.min(articleTimeout + 1000, runDeadline - now);
        if (timeoutMs <= 0) { resolve(null); return; }
        var timer = setTimeout(function() {
          if (done) return;
          done = true;
          timer = null;
          resolve(null);
        }, timeoutMs);
        try {
          chrome.runtime.sendMessage({
            type: SharedUtils.MESSAGE_TYPES.FETCH_TEXT_ATTACHMENTS_FRESH,
            url: url,
            maxImages: SharedUtils.effectiveFetchLimit(settings),
            displayImages: SharedUtils.effectiveDisplayLimit(settings),
            heavyImageOptimization: settings && settings.heavyImageOptimization !== false,
            articleTimeout: articleTimeout,
            deadline: deadline
          }, function(resp) {
            var runtimeError = chrome.runtime.lastError;
            if (done) return;
            done = true;
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            if (resp && resp.forumOrigin) report.url = resp.forumOrigin;
            if (runtimeError || !resp || resp.ok !== true || !Array.isArray(resp.textAttachments)) {
              if (runtimeError) Logger.debug('后台TXT附件消息失败', runtimeError.message);
              if (resp && resp.reason === 'forum_cooldown') {
                report.outcome = 'unused';
              } else if (resp && SharedUtils.isForumFloodReason(resp.reason)) {
                report.outcome = 'flood';
                if (Number.isFinite(resp.retryAfter)) report.retryAfter = resp.retryAfter;
              }
              resolve(null);
              return;
            }
            report.outcome = 'ok';
            resolve(resp.textAttachments);
          });
        } catch (e) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            Logger.debug('后台TXT附件消息异常', e.message);
            resolve(null);
          }
        }
      });
    },

    // Re-reads the thread for current attachment links. null means the links
    // could not be read this time (retryable); [] means the thread has none.
    // { yielded: true } means an automatic run gave way before its request.
    fetchTextAttachmentsFresh: async function(url, options) {
      options = withFreshTextDeadline(withTextRequestControl(options));
      if (!isSameOriginUrl(url)) {
        return await ATPFetcher.fetchTextAttachmentsFreshByBackground(url, options);
      }
      if (shouldYieldTextRequest(options)) return { yielded: true, textAttachments: null };
      var ticket = await acquireForumTurn(getTextPaceOptions(options, 1));
      if (shouldYieldTextRequest(options)) {
        if (ticket) ticket.done('unused');
        return { yielded: true, textAttachments: null };
      }
      if (!ticket || isTextResourceDeadlineExhausted(options.deadline)) {
        if (ticket) ticket.done('unused');
        return null;
      }
      var report = { outcome: '', retryAfter: 0, url: url };
      try {
        return await ATPFetcher._fetchTextAttachmentsFreshNetwork(url, report, options.deadline);
      } finally {
        settleForumResponse(ticket, report.outcome, report.url, report.retryAfter);
      }
    },

    _fetchTextAttachmentsFreshNetwork: async function(url, report, deadline) {
      try {
        var settings = ATPFetcher.getSettings();
        var ctrl = new AbortController();
        var timeoutMs = Math.min(ATPLoadPolicy.getArticleTimeout(settings), (deadline || Infinity) - Date.now());
        if (timeoutMs <= 0) { report.outcome = 'unused'; return null; }
        var t = setTimeout(function() { ctrl.abort(); }, timeoutMs);
        try {
          var resp = await fetch(url, {
            signal: ctrl.signal,
            credentials: 'include',
            cache: 'no-store',
            headers: { 'Accept': 'text/html' }
          });
          var finalUrl = resp.url || url;
          report.url = finalUrl;
          if (!isAllowedArticleFinalUrl(finalUrl)) {
            Logger.debug('按需TXT提取重定向已拒绝', logUrl(finalUrl));
            return null;
          }

          if (SharedUtils.isCloudflareChallengeResponse(resp)) {
            report.outcome = 'flood';
            report.retryAfter = SharedUtils.parseRetryAfterHeader(resp.headers);
            Logger.debug('按需TXT提取返回 Cloudflare 验证', logUrl(url));
            return null;
          }
          if (!resp.ok) {
            if (resp.status === 429 || resp.status === 503) {
              report.outcome = 'flood';
              report.retryAfter = SharedUtils.parseRetryAfterHeader(resp.headers);
            }
            Logger.debug('按需TXT提取失败 HTTP' + resp.status, logUrl(url));
            return null;
          }
          if ((resp.headers.get('content-type') || '').indexOf('text/html') === -1) {
            return null;
          }
          if (SharedUtils.isOversizedArticleResponse(resp)) {
            Logger.debug('按需TXT提取HTML过大，跳过', logUrl(url));
            return null;
          }

          var rawHtml;
          try {
            rawHtml = await SharedUtils.readResponseTextLimited(resp, SharedUtils.ARTICLE_HTML_MAX_BYTES);
          } catch (readError) {
            if (readError && readError.name === 'ResponseTooLargeError') {
              Logger.debug('按需TXT提取HTML过大，跳过', logUrl(url));
              return null;
            }
            throw readError;
          }
          var html = SharedUtils.limitArticleHtml(rawHtml);
          if (html.length !== rawHtml.length) {
            Logger.debug('按需TXT提取HTML截断', rawHtml.length + ' -> ' + html.length + ' ' + logUrl(url));
          }
          var blockedReason = SharedUtils.isBlockedPage(html);
          if (blockedReason) {
            if (SharedUtils.isForumFloodReason(blockedReason)) report.outcome = 'flood';
            return null;
          }

          // 不过滤临时 TXT 附件 URL，全部保留给按需解析
          var attachments = SharedUtils.extractTextAttachments(html, finalUrl, TEXT_ATTACHMENT_MAX_COUNT);
          if (!attachments.length) {
            // A challenge or maintenance notice has no attachments either;
            // [] is only safe after a successful read of the actual thread.
            var emptyPage = SharedUtils.classifyEmptyArticlePage(html);
            if (emptyPage && emptyPage.retryable) {
              if (SharedUtils.isForumFloodReason(emptyPage.reason)) report.outcome = 'flood';
              Logger.warn('按需TXT提取返回非帖子页', emptyPage.reason + ' title="' + SharedUtils.getHtmlPageTitle(html) + '" ' + html.length + '字符 ' + logUrl(url));
              return null;
            }
          }
          report.outcome = 'ok';
          Logger.debug('按需TXT提取', logUrl(url) + ' 原始附件' + attachments.length + '个');
          return attachments;
        } finally {
          clearTimeout(t);
          // Early exits (redirect, status, type, size) leave the body unread;
          // abort so a rejected response stops downloading.
          if (resp && !resp.bodyUsed) ctrl.abort();
        }
      } catch (e) {
        Logger.debug('按需TXT提取异常', logUrl(url) + ' ' + e.message);
        return null;
      }
    }
  };

  window.ATPFetcher = ATPFetcher;
})();
