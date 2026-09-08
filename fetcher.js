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

  function getParseClock() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function waitForArticleParseFrame() {
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
    await yieldArticleParseSlice();
    var stageStartedAt = getParseClock();
    // 整文派生串（还原邮箱/解实体/纯文本）只算一次，供资源与 TXT 附件两个提取器共用
    var extractionContext = SharedUtils.prepareArticleExtractionContext(job.html);
    var resources = SharedUtils.extractResources(job.html, job.finalUrl, 'html', extractionContext);
    parseMs += Math.max(0, getParseClock() - stageStartedAt);

    await yieldArticleParseSlice();
    stageStartedAt = getParseClock();
    var textAttachments = SharedUtils.extractTextAttachments(job.html, job.finalUrl, TEXT_ATTACHMENT_MAX_COUNT, extractionContext);
    parseMs += Math.max(0, getParseClock() - stageStartedAt);

    await yieldArticleParseSlice();
    stageStartedAt = getParseClock();
    var images = SharedUtils.extractImagesForSettings(job.html, job.finalUrl, job.settings);
    parseMs += Math.max(0, getParseClock() - stageStartedAt);

    if (Logger.event && (!Logger.isEnabled || Logger.isEnabled('DEBUG'))) {
      Logger.event('article_parse', {
        url: logUrl(job.url),
        queueWaitMs: Math.max(0, startedAt - job.queuedAt),
        parseMs: Math.round(parseMs),
        elapsedMs: Math.max(0, Date.now() - startedAt),
        images: images.length,
        resources: SharedUtils.countResources(resources),
        textAttachments: textAttachments.length
      }, 'DEBUG');
    }
    return {
      resources: resources,
      textAttachments: textAttachments,
      images: images
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

  function enqueueArticleParse(html, finalUrl, settings, url) {
    return new Promise(function(resolve, reject) {
      articleParseQueue.push({
        html: html,
        finalUrl: finalUrl,
        settings: settings,
        url: url,
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

  function makeTextResourceFetchStatus(resources, attemptedCount, unresolvedCount, retryableCount) {
    var normalized = SharedUtils.normalizeResources(resources);
    var attempted = Math.max(0, Number(attemptedCount) || 0);
    var unresolved = Math.max(0, Number(unresolvedCount) || 0);
    if (unresolved > attempted) unresolved = attempted;
    var retryable = Math.max(0, Number(retryableCount) || 0);
    if (retryable > unresolved) retryable = unresolved;
    return {
      resources: normalized,
      attemptedCount: attempted,
      unresolvedCount: unresolved,
      retryableCount: retryable
    };
  }

  function normalizeTextResourceFetchStatus(result, fallbackAttemptedCount) {
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'resources')) {
      var attempted = Number(result.attemptedCount);
      if (!isFinite(attempted) || attempted < 0) attempted = Number(fallbackAttemptedCount) || 0;
      var unresolved = Number(result.unresolvedCount);
      if (!isFinite(unresolved) || unresolved < 0) {
        unresolved = hasResourcePayload(result.resources) ? Math.max(0, attempted - 1) : attempted;
      }
      var retryable = Number(result.retryableCount);
      if (!isFinite(retryable) || retryable < 0) retryable = unresolved;
      return makeTextResourceFetchStatus(result.resources, attempted, unresolved, retryable);
    }
    var resources = SharedUtils.normalizeResources(result);
    var fallbackAttempted = Math.max(0, Number(fallbackAttemptedCount) || 0);
    var fallbackUnresolved = hasResourcePayload(resources) ? 0 : fallbackAttempted;
    return makeTextResourceFetchStatus(resources, fallbackAttempted, fallbackUnresolved, fallbackUnresolved);
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

  function isAllowedArticleFinalUrl(url) {
    try {
      var u = new URL(url);
      var h = u.hostname;
      return u.protocol === 'https:' && (h === 'sehuatang.org' || h === 'sehuatang.net' || h.endsWith('.sehuatang.org') || h.endsWith('.sehuatang.net'));
    } catch (e) {
      return false;
    }
  }

  function isAllowedTextAttachmentFinalUrl(url) {
    return SharedUtils.isAllowedTextAttachmentUrl(url, location.href);
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

  function requestTextAttachmentFromPage(attachment, timeoutMs) {
    if (!attachment || !isSameOriginUrl(attachment.url)) return Promise.resolve(null);
    if (!window || typeof window.addEventListener !== 'function' || typeof window.removeEventListener !== 'function' || typeof window.postMessage !== 'function') {
      return Promise.resolve(null);
    }
    timeoutMs = Math.max(1, Math.min(TEXT_ATTACHMENT_TIMEOUT, Number(timeoutMs) || TEXT_ATTACHMENT_TIMEOUT));
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
        finish(data);
      }
      window.addEventListener('message', onMessage);
      timer = setTimeout(function() { finish(null); }, timeoutMs + 250);
      try {
        window.postMessage({
          type: PAGE_TEXT_FETCH_REQUEST,
          id: requestId,
          url: attachment.url,
          referrer: getSafeAttachmentReferrer(attachment),
          maxBytes: TEXT_ATTACHMENT_MAX_BYTES,
          timeoutMs: timeoutMs
        }, location.origin);
      } catch (e) {
        finish(null);
      }
    });
  }

  async function fetchTextAttachmentResourceViaPage(attachment, timeoutMs, writeStartedAt) {
    var response = await requestTextAttachmentFromPage(attachment, timeoutMs);
    if (!response || response.ok !== true) return { handled: false, resources: SharedUtils.emptyResources() };
    var finalUrl = response.finalUrl || attachment.url;
    if (!isAllowedTextAttachmentFinalUrl(finalUrl)) return { handled: false, resources: SharedUtils.emptyResources() };
    var buffer = decodeBase64Buffer(response.base64);
    if (!buffer) return { handled: false, resources: SharedUtils.emptyResources() };
    var text = SharedUtils.decodeTextBuffer(buffer, response.contentType || '');
    var htmlLike = SharedUtils.looksLikeHtmlDocument(text);
    if (htmlLike || SharedUtils.looksLikeDownloadIntermediary(text)) {
      Logger.debug('TXT页面会话读取返回中转页', attachment.name || logUrl(attachment.url));
      return { handled: false, resources: SharedUtils.emptyResources() };
    }
    if (!text || SharedUtils.isUnavailableTextDocument(text)) {
      return { handled: true, resources: SharedUtils.emptyResources() };
    }
    var resources = SharedUtils.normalizeResources(SharedUtils.extractResources(text, finalUrl, 'txt'));
    if (hasResourcePayload(resources)) {
      ATPCache.setCachedTextResources(attachment.url, resources, writeStartedAt);
      ATPCache.clearTextFailCache(attachment.url);
    }
    Logger.debug('TXT页面会话读取', (attachment.name || logUrl(attachment.url)) + ' 资源' + SharedUtils.countResources(resources));
    return { handled: true, resources: resources };
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
      return status.resources;
    },

    fetchTextAttachmentResourcesWithStatus: async function(attachments, options) {
      options = options || {};
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
        attachments.push(attachment);
      }
      if (!attachments.length) return makeTextResourceFetchStatus(SharedUtils.emptyResources(), 0, 0, 0);
      var deadline = getTextResourceDeadline(options, attachments.length);
      options = withTextResourceDeadline(options, deadline);

      var hardFailSet = {};
      var unresolvedCount = 0;
      var retryableCount = 0;

      var same = [];
      var cross = [];
      for (var a = 0; a < attachments.length; a++) {
        if (isSameOriginUrl(attachments[a].url)) same.push(attachments[a]);
        else cross.push(attachments[a]);
      }

      var results = [];
      var backgroundFallbackAttempted = false;

      if (same.length) {
        var directResults = [];
        for (var dp = 0; dp < same.length; dp++) {
          directResults.push(await ATPFetcher.fetchTextAttachmentResource(same[dp], 0, hardFailSet, options));
        }
        var sameMerged = SharedUtils.emptyResources();
        var hardFailsInSame = 0;
        var sameFallback = [];
        for (var s = 0; s < directResults.length; s++) {
          if (hasResourcePayload(directResults[s])) {
            sameMerged = SharedUtils.mergeResources(sameMerged, directResults[s]);
          } else if (hardFailSet[same[s].url]) {
            hardFailsInSame++;
            unresolvedCount++;
            retryableCount++;
          } else {
            sameFallback.push(same[s]);
          }
        }
        if (hasResourcePayload(sameMerged)) {
          results.push(sameMerged);
        }
        if (sameFallback.length) {
          Logger.debug('TXT附件同源部分无结果', '回退到后台代理 ' + sameFallback.length + ' 个（跳过硬失败' + hardFailsInSame + '个）');
          backgroundFallbackAttempted = true;
          var bgFallback = await ATPFetcher.fetchTextAttachmentResourcesByBackgroundWithStatus(sameFallback, options);
          unresolvedCount += bgFallback.unresolvedCount;
          retryableCount += bgFallback.retryableCount;
          if (hasResourcePayload(bgFallback.resources)) results.push(bgFallback.resources);
        } else if (!hasResourcePayload(sameMerged) && hardFailsInSame) {
          Logger.debug('TXT附件同源全部硬失败，跳过后台回退', same.length + '个');
        }
      }

      if (cross.length) {
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
            results.push(crossCacheChecks[cf].cached);
          } else if (crossCacheChecks[cf].fail) {
            Logger.debug('TXT附件跨域失败缓存命中，跳过', logUrl(crossCacheChecks[cf].attachment.url));
            hardFailSet[crossCacheChecks[cf].attachment.url] = true;
            unresolvedCount++;
            retryableCount++;
          } else {
            crossFiltered.push(crossCacheChecks[cf].attachment);
          }
        }
        if (crossFiltered.length) {
          backgroundFallbackAttempted = true;
          var bgCross = await ATPFetcher.fetchTextAttachmentResourcesByBackgroundWithStatus(crossFiltered, options);
          unresolvedCount += bgCross.unresolvedCount;
          retryableCount += bgCross.retryableCount;
          if (hasResourcePayload(bgCross.resources)) results.push(bgCross.resources);
        }
      }

      if (!results.length && !backgroundFallbackAttempted) {
        var remainingAll = [];
        for (var ra = 0; ra < attachments.length; ra++) {
          if (!hardFailSet[attachments[ra].url]) remainingAll.push(attachments[ra]);
        }
        if (remainingAll.length) {
          var bgAll = await ATPFetcher.fetchTextAttachmentResourcesByBackgroundWithStatus(remainingAll, options);
          unresolvedCount += bgAll.unresolvedCount;
          retryableCount += bgAll.retryableCount;
          if (hasResourcePayload(bgAll.resources)) results.push(bgAll.resources);
        }
      }

      var merged = SharedUtils.emptyResources();
      for (var i = 0; i < results.length; i++) {
        merged = SharedUtils.mergeResources(merged, results[i]);
      }
      var resolvedCount = attachments.length - unresolvedCount;
      if (resolvedCount < 0) unresolvedCount = attachments.length;
      if (unresolvedCount === 0 && !hasResourcePayload(merged)) {
        unresolvedCount = attachments.length;
        retryableCount = attachments.length;
      }
      return makeTextResourceFetchStatus(merged, attachments.length, unresolvedCount, retryableCount);
    },

    fetchTextAttachmentResourcesByBackground: function(attachments, options) {
      return ATPFetcher.fetchTextAttachmentResourcesByBackgroundWithStatus(attachments, options).then(function(status) {
        return status.resources;
      });
    },

    fetchTextAttachmentResourcesByBackgroundWithStatus: function(attachments, options) {
      options = options || {};
      var manualRetry = !!(options.manualRetry || options.force);
      attachments = attachments || [];
      var deadline = getTextResourceDeadline(options, attachments.length);
      if (isTextResourceDeadlineExhausted(deadline)) {
        return Promise.resolve(makeTextResourceFetchStatus(SharedUtils.emptyResources(), attachments.length, attachments.length, attachments.length));
      }
      return new Promise(function(resolve) {
        var done = false;
        var timeoutMs = Math.max(1, deadline - Date.now());
        var timer = setTimeout(function() {
          if (!done) {
            done = true;
            timer = null;
            resolve(makeTextResourceFetchStatus(SharedUtils.emptyResources(), attachments.length, attachments.length, attachments.length));
          }
        }, timeoutMs);
        try {
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
              Logger.debug('TXT附件后台消息失败', runtimeError.message);
              resolve(makeTextResourceFetchStatus(SharedUtils.emptyResources(), attachments.length, attachments.length, attachments.length));
              return;
            }
            resolve(normalizeTextResourceFetchStatus(resp, attachments.length));
          });
        } catch (e) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            Logger.debug('TXT附件后台消息异常', e.message);
            resolve(makeTextResourceFetchStatus(SharedUtils.emptyResources(), attachments.length, attachments.length, attachments.length));
          }
        }
      });
    },

    fetchTextAttachmentResource: async function(attachment, depth, hardFailSet, options) {
      options = options || {};
      var writeStartedAt = Date.now();
      var manualRetry = !!(options.manualRetry || options.force);
      depth = depth || 0;
      try {
        if (!SharedUtils.isAllowedTextAttachmentUrl(attachment.url, location.href)) {
          Logger.debug('TXT attachment URL blocked', logUrl(attachment.url));
          return SharedUtils.emptyResources();
        }

        var cached = await ATPCache.getCachedTextResources(attachment.url);
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

        var fetchTimeout = getTextAttachmentFetchTimeout(options.deadline);
        if (fetchTimeout <= 0) {
          Logger.debug('TXT附件deadline耗尽', attachment && attachment.url ? logUrl(attachment.url) : '');
          return SharedUtils.emptyResources();
        }

        if (isSameOriginUrl(attachment.url)) {
          var pageResult = await fetchTextAttachmentResourceViaPage(attachment, fetchTimeout, writeStartedAt);
          if (pageResult.handled) return pageResult.resources;
          fetchTimeout = getTextAttachmentFetchTimeout(options.deadline);
          if (fetchTimeout <= 0) return SharedUtils.emptyResources();
        }

        var ctrl = new AbortController();
        var t = setTimeout(function() { ctrl.abort(); }, fetchTimeout);
        try {
          var fetchOptions = {
            signal: ctrl.signal,
            credentials: 'include',
            headers: { 'Accept': 'text/plain, application/octet-stream;q=0.9, */*;q=0.5' }
          };
          var referrer = getSafeAttachmentReferrer(attachment);
          if (referrer) {
            fetchOptions.referrer = referrer;
            fetchOptions.referrerPolicy = 'strict-origin-when-cross-origin';
          }
          var resp = await fetch(attachment.url, fetchOptions);
          var finalAttachmentUrl = resp.url || attachment.url;
          if (!isAllowedTextAttachmentFinalUrl(finalAttachmentUrl)) {
            Logger.debug('TXT附件重定向已拒绝', logUrl(finalAttachmentUrl));
            return SharedUtils.emptyResources();
          }

          if (!resp.ok) {
            var status = resp.status;
            var isHardFail = status === 401 || status === 403;
            if (isHardFail) {
              Logger.debug('TXT附件站点拒绝', 'HTTP' + status + ' ' + logUrl(attachment.url));
              ATPCache.setTextFailCache(attachment.url, writeStartedAt);
              if (hardFailSet) hardFailSet[attachment.url] = true;
              return SharedUtils.emptyResources();
            }
            if (status === 429) {
              Logger.debug('TXT附件限流', logUrl(attachment.url));
              return SharedUtils.emptyResources();
            }
            Logger.debug('TXT附件跳过 HTTP' + status, logUrl(attachment.url));
            return SharedUtils.emptyResources();
          }
          if (resp.redirected && /\/login|\/signin|\/member|\/register/.test(resp.url)) {
            Logger.debug('TXT附件重定向登录页', logUrl(resp.url));
            return SharedUtils.emptyResources();
          }

          var len = parseInt(resp.headers.get('content-length') || '0', 10);
          if (len > TEXT_ATTACHMENT_MAX_BYTES) {
            Logger.debug('TXT附件过大', attachment.name + ' ' + len + '字节');
            return SharedUtils.emptyResources();
          }

          var contentType = resp.headers.get('content-type') || '';
          var buffer;
          try {
            buffer = await SharedUtils.readResponseArrayBufferLimited(resp, TEXT_ATTACHMENT_MAX_BYTES);
          } catch (readError) {
            if (readError && readError.name === 'ResponseTooLargeError') {
              Logger.debug('TXT附件过大', attachment.name + ' 超过' + TEXT_ATTACHMENT_MAX_BYTES + '字节');
              return SharedUtils.emptyResources();
            }
            throw readError;
          }

          var text = SharedUtils.decodeTextBuffer(buffer, contentType);
          var htmlLike = SharedUtils.looksLikeHtmlDocument(text);
          var downloadLike = SharedUtils.looksLikeDownloadIntermediary(text);
          if ((htmlLike || downloadLike) && depth < 2) {
            var downloadUrls = SharedUtils.extractTextDownloadUrls(text, resp.url || attachment.url, TEXT_ATTACHMENT_MAX_COUNT);
            for (var d = 0; d < downloadUrls.length; d++) {
              if (downloadUrls[d] === attachment.url) continue;
              var nextAttachment = {
                url: downloadUrls[d],
                name: attachment.name,
                source: 'txt-download-url',
                pageUrl: attachment.pageUrl || resp.url || attachment.url
              };
              var redirectedResources;
              try {
                if (isSameOriginUrl(downloadUrls[d])) {
                  redirectedResources = await ATPFetcher.fetchTextAttachmentResource(nextAttachment, depth + 1, hardFailSet, options);
                } else {
                  redirectedResources = await ATPFetcher.fetchTextAttachmentResourcesByBackground([nextAttachment], options);
                }
              } catch (e) {
                redirectedResources = await ATPFetcher.fetchTextAttachmentResourcesByBackground([nextAttachment], options);
              }
              if (hasResourcePayload(redirectedResources)) {
                ATPCache.setCachedTextResources(attachment.url, redirectedResources, writeStartedAt);
                ATPCache.clearTextFailCache(attachment.url);
                return redirectedResources;
              }
            }
            Logger.debug('TXT附件HTML中转无结果', attachment.name || logUrl(attachment.url));
          }

          if (!text || SharedUtils.isUnavailableTextDocument(text) || htmlLike) {
            Logger.debug('TXT附件不可解析', attachment.name || logUrl(attachment.url));
            return SharedUtils.emptyResources();
          }

          var resources = SharedUtils.extractResources(text, resp.url || attachment.url, 'txt');
          var normalizedResources = SharedUtils.normalizeResources(resources);
          if (hasResourcePayload(normalizedResources)) {
            ATPCache.setCachedTextResources(attachment.url, normalizedResources, writeStartedAt);
            ATPCache.clearTextFailCache(attachment.url);
          }
          Logger.debug('TXT附件资源', (attachment.name || logUrl(attachment.url)) + ' 资源' + SharedUtils.countResources(resources));
          return normalizedResources;
        } finally {
          clearTimeout(t);
        }
      } catch (e) {
        var isTransient = e.name === 'AbortError' || e.name === 'TypeError' || !navigator.onLine;
        if (isTransient) {
          Logger.debug('TXT附件临时异常，不写失败缓存', (attachment && attachment.url ? logUrl(attachment.url) : '') + ' ' + e.message);
        } else {
          Logger.debug('TXT附件异常', (attachment && attachment.url ? logUrl(attachment.url) : '') + ' ' + e.message);
        }
        return SharedUtils.emptyResources();
      }
    },

    fetchArticleData: function(url, baseUrl) {
      var inflightKey = (SharedUtils.normalizeArticleUrl ? SharedUtils.normalizeArticleUrl(url) : url) || String(url || '');
      var existing = ARTICLE_FETCH_IN_FLIGHT[inflightKey];
      if (existing) return existing;
      var promise = ATPFetcher._fetchArticleDataImpl(url, baseUrl);
      ARTICLE_FETCH_IN_FLIGHT[inflightKey] = promise;
      var release = function() {
        if (ARTICLE_FETCH_IN_FLIGHT[inflightKey] === promise) delete ARTICLE_FETCH_IN_FLIGHT[inflightKey];
      };
      promise.then(release, release);
      return promise;
    },

    _fetchArticleDataImpl: async function(url, baseUrl) {
      var writeStartedAt = Date.now();
      var cacheState = await ATPCache.getArticleCacheState(url);
      var cached = cacheState.cached;
      if (cached) {
        if (Logger.isEnabled('DEBUG')) {
          Logger.debug('缓存命中', logUrl(url) + ' 图片' + cached.images.length + ' 资源' + SharedUtils.countResources(cached.resources));
        }
        // 兼容老缓存：清理其中可能过期的临时 TXT 附件 URL
        if (cached.textAttachments.length) {
          var hasTransientAttachment = false;
          var keptAttachments = [];
          for (var ca = 0; ca < cached.textAttachments.length; ca++) {
            if (SharedUtils.isTransientTextAttachmentUrl(cached.textAttachments[ca].url, url)) {
              hasTransientAttachment = true;
            } else {
              keptAttachments.push(cached.textAttachments[ca]);
            }
          }
          if (hasTransientAttachment) {
            cached.hasTextAttachments = true;
            cached.textAttachmentCount = cached.textAttachments.length;
            cached.textAttachments = keptAttachments;
            Logger.debug('老缓存含临时TXT附件URL，已标记需重新提取', logUrl(url));
          }
        }
        if (cached.hasTextAttachments && !cached.textAttachments.length) {
          Logger.debug('缓存含TXT附件标记，需按需重新提取', logUrl(url));
        }
        return cached;
      }
      if (cacheState.negative) {
        Logger.debug('负缓存命中', logUrl(url));
        return emptyArticleData(true, 'negative_cache', cacheState.negativeExpiresAt);
      }

      try {
        var settings = ATPFetcher.getSettings();
        var articleTimeout = ATPLoadPolicy.getArticleTimeout(settings);
        var ctrl = new AbortController();
        var t = setTimeout(function() { ctrl.abort(); }, articleTimeout);
        try {
          var resp = await fetch(url, {
            signal: ctrl.signal,
            credentials: 'include',
            headers: { 'Accept': 'text/html' }
          });
          var finalUrl = resp.url || url;
          if (!isAllowedArticleFinalUrl(finalUrl)) {
            Logger.warn('文章重定向已拒绝', logUrl(finalUrl));
            return emptyArticleData(false, 'redirect_disallowed');
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
            return emptyArticleData(true, 'blocked');
          }

          var parsedArticle = await enqueueArticleParse(html, finalUrl, settings, url);
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
          var data = ATPCache.normalizeArticleData({
            images: parsedArticle.images,
            resources: resources,
            textAttachments: filteredAttachments,
            hasTextAttachments: hasTransientAttachment || !!filteredAttachments.length,
            textAttachmentCount: rawTextAttachments.length,
            partial: htmlTruncated
          });
          if (!data.images.length && !SharedUtils.hasResourcePayload(data.resources) && !data.textAttachments.length && !data.hasTextAttachments) {
            if (htmlTruncated) {
              Logger.warn('文章HTML截断且无结果，不写负缓存', logUrl(url));
            } else {
              ATPCache.setNegativeCache(url, writeStartedAt);
            }
          } else {
            ATPCache.setCachedArticleData(url, data, !htmlTruncated, writeStartedAt);
          }
          if (Logger.isEnabled('DEBUG')) {
            Logger.debug('提取完成', logUrl(url) + ' 图片' + data.images.length + ' 资源' + SharedUtils.countResources(data.resources) + ' TXT' + data.textAttachments.length + (data.hasTextAttachments ? '(含Discuz附件' + data.textAttachmentCount + '个)' : ''));
          }
          return data;
        } finally {
          clearTimeout(t);
        }
      } catch (e) {
        var isTransient = e.name === 'AbortError' || e.name === 'TypeError' || !navigator.onLine;
        if (isTransient) {
          Logger.warn('抓取临时异常（不写负缓存）', logUrl(url) + ' ' + e.message);
        } else {
          Logger.warn('抓取异常', logUrl(url) + ' ' + e.message);
          ATPCache.setNegativeCache(url, writeStartedAt);
        }
        return emptyArticleData(isTransient, isTransient ? 'transient_exception' : 'exception');
      }
    },

    fetchArticleDataByBackground: function(url) {
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
            resolve(resp && resp[url] ? ATPCache.normalizeArticleData(resp[url]) : null);
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

    fetchTextAttachmentsFreshByBackground: async function(url) {
      return await new Promise(function(resolve) {
        var settings = ATPFetcher.getSettings();
        var articleTimeout = ATPLoadPolicy.getArticleTimeout(settings);
        var done = false;
        var timeoutMs = articleTimeout + 1000;
        var deadline = Date.now() + articleTimeout;
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
            if (runtimeError || !resp || resp.ok !== true || !Array.isArray(resp.textAttachments)) {
              if (runtimeError) Logger.debug('后台TXT附件消息失败', runtimeError.message);
              resolve(null);
              return;
            }
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

    fetchTextAttachmentsFresh: async function(url) {
      if (!isSameOriginUrl(url)) {
        return await ATPFetcher.fetchTextAttachmentsFreshByBackground(url);
      }
      try {
        var settings = ATPFetcher.getSettings();
        var ctrl = new AbortController();
        var t = setTimeout(function() { ctrl.abort(); }, ATPLoadPolicy.getArticleTimeout(settings));
        try {
          var resp = await fetch(url, {
            signal: ctrl.signal,
            credentials: 'include',
            headers: { 'Accept': 'text/html' }
          });
          var finalUrl = resp.url || url;
          if (!isAllowedArticleFinalUrl(finalUrl)) {
            Logger.debug('按需TXT提取重定向已拒绝', logUrl(finalUrl));
            return null;
          }

          if (!resp.ok) {
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
          if (SharedUtils.isBlockedPage(html)) {
            return null;
          }

          // 不过滤临时 TXT 附件 URL，全部保留给按需解析
          var attachments = SharedUtils.extractTextAttachments(html, finalUrl, TEXT_ATTACHMENT_MAX_COUNT);
          Logger.debug('按需TXT提取', logUrl(url) + ' 原始附件' + attachments.length + '个');
          return attachments;
        } finally {
          clearTimeout(t);
        }
      } catch (e) {
        Logger.debug('按需TXT提取异常', logUrl(url) + ' ' + e.message);
        return null;
      }
    }
  };

  window.ATPFetcher = ATPFetcher;
})();
