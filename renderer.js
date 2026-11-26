(function () {
  'use strict';

  var CONTAINER_CLASS = 'atp-processed';
  var THUMB_CLASS = 'atp-thumbnail-container';
  var AUTO_TEXT_RESOURCE_QUEUE = [];
  var AUTO_TEXT_RESOURCE_ACTIVE = 0;
  var AUTO_TEXT_RESOURCE_CONCURRENCY = 2;
  var AUTO_TEXT_RESOURCE_DRAIN_SCHEDULED = false;
  var AUTO_TEXT_RESOURCE_RECHECK_TIMER = null;
  var INLINE_GALLERY_ITEMS = 256;
  var GALLERY_APPEND_BATCH_ITEMS = 64;
  // Attachment links read by the article fetch stay usable this long for the
  // automatic TXT run; Discuz attachment links are short-lived.
  var FRESH_TEXT_LINK_REUSE_MS = 3 * 60 * 1000;

  function isThreadCurrent(threadState) {
    if (!threadState) return false;
    var currentGeneration = window.ATPState && typeof window.ATPState.generation === 'number'
      ? window.ATPState.generation
      : threadState.generation;
    if (typeof threadState.generation === 'number' && typeof currentGeneration === 'number' && threadState.generation !== currentGeneration) return false;
    if (
      threadState.registeredInState &&
      threadState.id &&
      window.ATPState &&
      window.ATPState.threads &&
      window.ATPState.threads[threadState.id] !== threadState
    ) return false;
    if (threadState.panel && !document.contains(threadState.panel)) return false;
    if (threadState.container && !document.contains(threadState.container)) return false;
    return true;
  }

  function normalizeTextResourceLoadResult(result, attachmentCount) {
    var hasWrappedResources = result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'resources');
    var resources = SharedUtils.normalizeResources(hasWrappedResources ? result.resources : result);
    var attempted = hasWrappedResources ? Number(result.attemptedCount) : Number(attachmentCount);
    if (!isFinite(attempted) || attempted < 0) attempted = Number(attachmentCount) || 0;
    var unresolved = hasWrappedResources ? Number(result.unresolvedCount) : NaN;
    if (!isFinite(unresolved) || unresolved < 0) {
      unresolved = SharedUtils.hasResourcePayload(resources) ? Math.max(0, attempted - 1) : attempted;
    }
    if (unresolved > attempted) unresolved = attempted;
    var retryable = hasWrappedResources ? Number(result.retryableCount) : NaN;
    if (!isFinite(retryable) || retryable < 0) retryable = unresolved;
    if (retryable > unresolved) retryable = unresolved;
    return {
      resources: resources,
      attemptedCount: attempted,
      unresolvedCount: unresolved,
      retryableCount: retryable,
      accessDeniedCount: hasWrappedResources ? Math.min(unresolved, Math.max(0, Number(result.accessDeniedCount) || 0)) : 0
    };
  }

  function getThreadAttachmentHints(thread) {
    return SharedUtils.mergeTextAttachmentHints(SharedUtils.getTextAttachmentHints(thread.textAttachments),
      SharedUtils.getTextAttachmentHints(thread.freshTextAttachments), thread.textAttachmentHints);
  }

  function rememberResolvedAttachments(thread, attachments) {
    var hints = thread.textAttachmentHints = getThreadAttachmentHints(thread);
    var ids = SharedUtils.getTextAttachmentHints(attachments).map(function(hint) {
      return SharedUtils.textAttachmentProgressId(hint, hints);
    });
    thread.textResolvedAttachmentIds = SharedUtils.mergeResolvedTextIds(hints, thread.textResolvedAttachmentIds, ids);
    return thread.textResolvedAttachmentIds.length;
  }

  function cacheThreadArticle(thread, complete, writeStartedAt, operation) {
    var attachments = thread.textAttachments || [];
    var hints = getThreadAttachmentHints(thread);
    ATPCache.setCachedArticleData(thread.link, {
      images: thread.cacheImages || thread.sourceCandidates || thread.candidates || [],
      resources: thread.resources,
      textAttachments: attachments.filter(function(item) { return item && SharedUtils.isPersistableTextAttachmentUrl(item.url, thread.link); }),
      loadedUrls: thread.loadedUrls || [],
      hasTextAttachments: !!(thread.hasTextAttachments || attachments.length || hints.length || thread.textAttachmentCount),
      textAttachmentCount: Math.max(thread.textAttachmentCount || 0, attachments.length, hints.length),
      textAttachmentHints: hints,
      textResolvedAttachmentIds: thread.textResolvedAttachmentIds || [],
      textResourcesComplete: thread.textResourcesDone && !thread.textResourcesRetryable,
      textResourcesAttemptedCount: thread.textResourcesAttemptedCount,
      textResourcesUnresolvedCount: thread.textResourcesUnresolvedCount,
      textResourcesRetryableCount: thread.textResourcesRetryableCount,
      partial: thread.partial,
      readAt: thread.contentReadAt,
      imageExtractionVersion: thread.imageExtractionVersion,
      textResourcesImported: thread.textResourcesImported,
      textAttachmentsLimited: thread.textAttachmentsLimited
    }, complete && !thread.partial, writeStartedAt, operation);
    if (complete && !thread.partial) {
      thread.cacheImages = null;
    }
  }

  function mergeTextAttachments(freshAttachments, stableAttachments, pageUrl) {
    var out = [];
    var seen = {};
    var maxCount = SharedUtils.TEXT_ATTACHMENT_MAX_COUNT || 3;
    var stableByKey = new Map();
    stableAttachments.forEach(function(attachment) {
      stableByKey.set(SharedUtils.normalizeTextAttachmentUrl(attachment.url), attachment);
    });

    function append(attachments) {
      attachments = Array.isArray(attachments) ? attachments : [];
      for (var i = 0; i < attachments.length && out.length < maxCount; i++) {
        var attachment = attachments[i];
        if (!attachment || !attachment.url) continue;
        var key = SharedUtils.normalizeTextAttachmentUrl(attachment.url);
        if (!key || seen[key]) continue;
        seen[key] = true;
        attachment = stableByKey.get(key) || attachment;
        out.push(attachment.pageUrl ? attachment : Object.assign({}, attachment, { pageUrl: pageUrl }));
      }
    }

    append(freshAttachments);
    append(stableAttachments);
    return out;
  }

  function scheduleAutomaticTextResourceDrain() {
    if (AUTO_TEXT_RESOURCE_DRAIN_SCHEDULED) return;
    AUTO_TEXT_RESOURCE_DRAIN_SCHEDULED = true;
    setTimeout(function() {
      AUTO_TEXT_RESOURCE_DRAIN_SCHEDULED = false;
      drainAutomaticTextResourceQueue();
    }, 0);
  }

  function releaseAutomaticTextResourceSlot(threadState, run) {
    if (!threadState) return;
    if (run && run.released) return;
    if (!run || threadState.textResourcesRun === run) threadState.textResourcesAutoQueued = false;
    if (run) {
      run.released = true;
      if (run.automatic) AUTO_TEXT_RESOURCE_ACTIVE = Math.max(0, AUTO_TEXT_RESOURCE_ACTIVE - 1);
      if (threadState.textResourcesRun === run) {
        threadState.textResourcesRun = null;
        threadState.textResourcesAutoActive = false;
      }
      if (!run.automatic) return;
    } else if (threadState.textResourcesAutoActive) {
      threadState.textResourcesAutoActive = false;
      AUTO_TEXT_RESOURCE_ACTIVE = Math.max(0, AUTO_TEXT_RESOURCE_ACTIVE - 1);
    }
    scheduleAutomaticTextResourceDrain();
  }

  function isThreadOnScreen(threadState) {
    var el = threadState && (threadState.panel || threadState.container);
    if (!el || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 800;
    return rect.bottom > 0 && rect.top < vh;
  }

  function hasQueuedVisibleTextResourceThread(exceptThread) {
    for (var i = 0; i < AUTO_TEXT_RESOURCE_QUEUE.length; i++) {
      var candidate = AUTO_TEXT_RESOURCE_QUEUE[i];
      if (!candidate || candidate === exceptThread || !candidate.textResourcesAutoQueued ||
          candidate.textResourcesLoading || candidate.textResourcesImporting ||
          (candidate.textResourcesDone && !candidate.textResourcesRetryable) || !isThreadCurrent(candidate)) continue;
      if (isThreadOnScreen(candidate)) return true;
    }
    return false;
  }

  function shouldDeferAutomaticTextLoad(candidate) {
    if (window.ATPArticleWork && typeof window.ATPArticleWork.isVisibleBusy === 'function' && window.ATPArticleWork.isVisibleBusy()) {
      return true;
    }
    if (candidate && isThreadOnScreen(candidate)) return false;
    return !!(window.ATPArticleWork && typeof window.ATPArticleWork.isBusy === 'function' && window.ATPArticleWork.isBusy());
  }

  function wakeAutomaticTextResourceQueue() {
    if (AUTO_TEXT_RESOURCE_RECHECK_TIMER) {
      clearTimeout(AUTO_TEXT_RESOURCE_RECHECK_TIMER);
      AUTO_TEXT_RESOURCE_RECHECK_TIMER = null;
    }
    if (AUTO_TEXT_RESOURCE_QUEUE.length) {
      scheduleAutomaticTextResourceDrain();
    }
  }

  // Automatic TXT work costs forum requests. First-screen visible article HTML
  // fetches always have token priority; once those clear, on-screen TXT threads
  // go first, and offscreen TXT threads wait until background article fetches finish.
  function takeNextAutomaticTextResourceThread() {
    for (var i = 0; i < AUTO_TEXT_RESOURCE_QUEUE.length; i++) {
      var candidate = AUTO_TEXT_RESOURCE_QUEUE[i];
      if (!candidate || !candidate.textResourcesAutoQueued) {
        return AUTO_TEXT_RESOURCE_QUEUE.splice(i, 1)[0];
      }
      if (isThreadOnScreen(candidate)) {
        if (!shouldDeferAutomaticTextLoad(candidate)) {
          return AUTO_TEXT_RESOURCE_QUEUE.splice(i, 1)[0];
        }
        break;
      }
    }
    if (!shouldDeferAutomaticTextLoad(null)) return AUTO_TEXT_RESOURCE_QUEUE.shift();
    if (!AUTO_TEXT_RESOURCE_RECHECK_TIMER) {
      AUTO_TEXT_RESOURCE_RECHECK_TIMER = setTimeout(function() {
        AUTO_TEXT_RESOURCE_RECHECK_TIMER = null;
        scheduleAutomaticTextResourceDrain();
      }, 1000);
    }
    return undefined;
  }

  function drainAutomaticTextResourceQueue() {
    while (AUTO_TEXT_RESOURCE_ACTIVE < AUTO_TEXT_RESOURCE_CONCURRENCY && AUTO_TEXT_RESOURCE_QUEUE.length) {
      var threadState = takeNextAutomaticTextResourceThread();
      if (threadState === undefined) return;
      if (!threadState || !threadState.textResourcesAutoQueued) continue;
      threadState.textResourcesAutoQueued = false;
      if (
        !isThreadCurrent(threadState) ||
        threadState.textResourcesLoading ||
        threadState.textResourcesImporting ||
        (threadState.textResourcesDone && !threadState.textResourcesRetryable)
      ) {
        continue;
      }

      threadState.textResourcesAutoActive = true;
      threadState.textResourcesAutoAttempted = true;
      AUTO_TEXT_RESOURCE_ACTIVE++;
      var scheduled = false;
      try {
        scheduled = ATPRenderer.scheduleTextResourceLoad(threadState, false) === true;
      } catch (e) {
        scheduled = false;
        Logger.debug('TXT 资源自动解析启动失败', threadState.link + ' ' + (e && e.message ? e.message : e));
      }
      if (scheduled) continue;

      if (isThreadCurrent(threadState) && !(threadState.textResourcesDone && !threadState.textResourcesRetryable)) {
        threadState.textResourcesLoading = false;
        threadState.textResourcesDone = false;
        threadState.textResourcesRetryable = true;
        threadState.textResourceMessage = 'TXT 资源自动解析启动失败，可手动重试';
      }
      releaseAutomaticTextResourceSlot(threadState);
      if (window.ATPResourcePanel) ATPResourcePanel.updateThread(threadState);
    }
  }

  function queueAutomaticTextResourceLoad(threadState) {
    if (!threadState || !isThreadCurrent(threadState)) return false;
    if (threadState.textResourcesAutoQueued || threadState.textResourcesAutoActive || threadState.textResourcesAutoAttempted) return false;
    if (threadState.textResourcesDone && !threadState.textResourcesRetryable) return false;
    var hasAttachments = (threadState.textAttachments && threadState.textAttachments.length) || threadState.hasTextAttachments;
    if (!hasAttachments) return false;
    threadState.textResourcesAutoQueued = true;
    threadState.textResourceMessage = 'TXT 资源自动解析排队中';
    AUTO_TEXT_RESOURCE_QUEUE.push(threadState);
    scheduleAutomaticTextResourceDrain();
    return true;
  }

  function getImageHost(src) {
    try {
      return new URL(src).hostname;
    } catch (e) {
      return '';
    }
  }

  function* summarizeImageHosts(candidates) {
    var counts = {};
    var topHosts = [];
    var heavyHosts = 0;
    candidates = candidates || [];
    for (var i = 0; i < candidates.length; i++) {
      if (i) yield;
      var src = SharedUtils.getImagePreviewSrc ? SharedUtils.getImagePreviewSrc(candidates[i]) : (candidates[i] && candidates[i].src);
      if (!src) continue;
      var host = getImageHost(src);
      if (!host) continue;
      counts[host] = (counts[host] || 0) + 1;
      updateTopImageHost(topHosts, counts, host);
      if (SharedUtils.isHeavyImageHost(host)) heavyHosts++;
    }
    var out = [];
    for (var oi = 0; oi < topHosts.length; oi++) {
      out.push(topHosts[oi] + ':' + counts[topHosts[oi]]);
    }
    if (heavyHosts) out.push('image.imx.to-heavy:' + heavyHosts);
    return out;
  }

  function updateTopImageHost(topHosts, counts, host) {
    var existingIndex = topHosts.indexOf(host);
    if (existingIndex !== -1) topHosts.splice(existingIndex, 1);
    var count = counts[host] || 0;
    var insertAt = topHosts.length;
    while (insertAt > 0 && count > (counts[topHosts[insertAt - 1]] || 0)) insertAt--;
    if (insertAt >= 6) return;
    topHosts.splice(insertAt, 0, host);
    if (topHosts.length > 6) topHosts.length = 6;
  }

  function copyCandidatePrefix(candidates, limit) {
    if (!Array.isArray(candidates) || typeof limit !== 'number' || !isFinite(limit) || limit >= candidates.length) return candidates;
    var length = Math.max(0, Math.floor(limit));
    var out = new Array(length);
    for (var i = 0; i < length; i++) out[i] = candidates[i];
    return out;
  }

  function getGalleryOptions(settings) {
    return {
      fetchLimit: SharedUtils.effectiveFetchLimit(settings),
      displayLimit: SharedUtils.effectiveDisplayLimit(settings),
      cols: (settings && settings.gridCols) || 5,
      optimizeHeavy: !!settings && settings.heavyImageOptimization !== false,
      lightweight: ATPRenderer.isLightweightHeavyThumbnailMode(settings)
    };
  }

  function isGalleryOptionsCurrent(options) {
    var current = getGalleryOptions(ATPRenderer.getSettings());
    return options.fetchLimit === current.fetchLimit && options.displayLimit === current.displayLimit &&
      options.cols === current.cols && options.optimizeHeavy === current.optimizeHeavy &&
      options.lightweight === current.lightweight;
  }

  function isGalleryDebugEnabled() {
    return typeof Logger !== 'undefined' && Logger.event && (!Logger.isEnabled || Logger.isEnabled('DEBUG'));
  }

  function finishGalleryPreparation(iterator) {
    var step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
  }

  function* prepareHeavyImagePlan(candidates, options) {
    if (!options.optimizeHeavy) return { enabled: false, limit: candidates.length };
    var heavyCount = 0;
    for (var i = 0; i < candidates.length; i++) {
      if (i) yield;
      if (ATPRenderer.isHeavyImage(candidates[i])) heavyCount++;
    }
    // Keep the threshold used by SharedUtils.isHeavyImageCandidateSet.
    if (heavyCount < 3 || heavyCount / candidates.length < 0.5) {
      return { enabled: false, limit: candidates.length };
    }
    return {
      enabled: true,
      lightweight: options.lightweight,
      limit: options.lightweight
        ? Math.min(candidates.length, options.displayLimit || candidates.length)
        : Math.min(candidates.length, Math.max(3, Math.min(options.cols || 5, 6))),
      heavyCount: heavyCount
    };
  }

  function* orderLoadedCandidates(candidates, loadedUrls) {
    candidates = Array.isArray(candidates) ? candidates : [];
    loadedUrls = Array.isArray(loadedUrls) ? loadedUrls : [];
    if (!candidates.length || !loadedUrls.length) return candidates;

    var indexByNormalized = {};
    var previewKeys = new Array(candidates.length);
    var displayKeys = new Array(candidates.length);
    for (var i = 0; i < candidates.length; i++) {
      if (i) yield;
      var candidate = candidates[i];
      var candidatePreviewSrc = SharedUtils.getImagePreviewSrc(candidate);
      if (!candidate || !candidatePreviewSrc) continue;
      var normalized = SharedUtils.normalizeImageUrl(candidatePreviewSrc);
      previewKeys[i] = normalized;
      if (typeof indexByNormalized[normalized] !== 'number') indexByNormalized[normalized] = i;
      var candidateDisplaySrc = SharedUtils.getImageDisplaySrc(candidate);
      var displayNormalized = SharedUtils.normalizeImageUrl(candidateDisplaySrc);
      displayKeys[i] = displayNormalized;
      if (displayNormalized && typeof indexByNormalized[displayNormalized] !== 'number') indexByNormalized[displayNormalized] = i;
    }

    var out = [];
    var used = {};
    for (var l = 0; l < loadedUrls.length; l++) {
      yield;
      var loaded = SharedUtils.normalizeImageUrl(loadedUrls[l]);
      var matchIndex = indexByNormalized[loaded];
      if (typeof matchIndex !== 'number' || used[loaded]) continue;
      var matchedPreviewKey = previewKeys[matchIndex] || '';
      var matchedDisplayKey = displayKeys[matchIndex] || '';
      if (matchedPreviewKey) used[matchedPreviewKey] = true;
      if (matchedDisplayKey) used[matchedDisplayKey] = true;
      out.push(candidates[matchIndex]);
    }
    for (var j = 0; j < candidates.length; j++) {
      // Appending works on cached keys. A short batch keeps it within the
      // time slice without spending one URL-work step per cheap lookup.
      if (j % GALLERY_APPEND_BATCH_ITEMS === 0) yield;
      var key = previewKeys[j] || '';
      if (!key || used[key]) continue;
      used[key] = true;
      out.push(candidates[j]);
    }
    return out;
  }

  function* prepareGallery(data, options) {
    var images = data.images;
    var fetchLimit = options.fetchLimit;
    var candidatePool = copyCandidatePrefix(images, fetchLimit);
    var heavyPlan = yield* prepareHeavyImagePlan(candidatePool, options);
    if (heavyPlan.enabled) candidatePool = yield* orderLoadedCandidates(candidatePool, data.loadedUrls);
    var hostMix = isGalleryDebugEnabled() ? yield* summarizeImageHosts(candidatePool) : undefined;
    return { data: data, options: options, candidatePool: candidatePool, heavyPlan: heavyPlan, hostMix: hostMix };
  }

  function countTableCells(row) {
    if (!row || !row.children) return 0;
    var count = 0;
    for (var i = 0; i < row.children.length; i++) {
      var tagName = row.children[i] && row.children[i].tagName;
      if (tagName === 'TD' || tagName === 'TH') count++;
    }
    return count;
  }

  function isDecoratedArticleContainer(container) {
    if (!container) return false;
    var scanner = window.ATPScanner;
    if (scanner && typeof scanner.isDecoratedArticleContainer === 'function') {
      return scanner.isDecoratedArticleContainer(container);
    }
    if (container.classList && container.classList.contains(CONTAINER_CLASS)) return true;
    if (container.querySelector && container.querySelector('.' + THUMB_CLASS + ',.atp-thumb-row')) return true;
    if (
      container.tagName === 'TR' &&
      container.nextElementSibling &&
      container.nextElementSibling.classList &&
      container.nextElementSibling.classList.contains('atp-thumb-row')
    ) return true;
    if (container.tagName === 'TR') {
      var parent = container.parentElement;
      if (parent && parent.tagName === 'TBODY') {
        if (parent.classList && parent.classList.contains(CONTAINER_CLASS)) return true;
        if (parent.querySelector && parent.querySelector('.' + THUMB_CLASS + ',.atp-thumb-row')) return true;
      }
    }
    return false;
  }

  var ATPRenderer = {
    CONTAINER_CLASS: CONTAINER_CLASS,
    THUMB_CLASS: THUMB_CLASS,
    isDecoratedArticleContainer: isDecoratedArticleContainer,

    getSettings: function() {
      return window.ATPState && window.ATPState.settings;
    },

    isHeavyImage: function(imgData) {
      return SharedUtils.isHeavyImageCandidate(imgData);
    },

    isLightweightHeavyThumbnailMode: function(settings) {
      return !!(settings && (
        settings.heavyThumbnailClarity === 'lightweight' ||
        settings.heavyThumbnailClarity === 'blurred'
      ));
    },

    getHeavyImagePlan: function(candidates, settings, cols, displayLimit) {
      var options = getGalleryOptions(settings);
      options.cols = cols;
      options.displayLimit = displayLimit;
      return finishGalleryPreparation(prepareHeavyImagePlan(candidates, options));
    },

    prioritizeLoadedCandidates: function(candidates, loadedUrls) {
      return finishGalleryPreparation(orderLoadedCandidates(candidates, loadedUrls));
    },

    // data is the same normalized object eventually supplied to injectThumbnails.
    // A null return uses the synchronous small-gallery path. A queued plan
    // resolves to null if the caller's article or display settings expire.
    prepareArticleGallery: function(data, isCurrent) {
      if (!data || !Array.isArray(data.images) || !ATPCache.runArticlePreparation) return null;
      var options = getGalleryOptions(ATPRenderer.getSettings());
      var candidateCount = Math.min(data.images.length, options.fetchLimit);
      var loadedCount = options.optimizeHeavy && candidateCount >= 3 && data.loadedUrls ? data.loadedUrls.length : 0;
      if (candidateCount + loadedCount <= INLINE_GALLERY_ITEMS) return null;
      return ATPCache.runArticlePreparation(prepareGallery(data, options), function() {
        return (!isCurrent || isCurrent()) && isGalleryOptionsCurrent(options);
      });
    },

    injectThumbnails: function(container, articleData, link, cacheWriteStartedAt, visibleBeforeCommit, preparedGallery) {
      if (container.tagName === 'TH' || container.tagName === 'TD') {
        container = container.parentElement;
        if (!container || (container.tagName !== 'TR' && container.tagName !== 'TBODY')) return;
      }
      if (isDecoratedArticleContainer(container)) return;

      var data = ATPCache.normalizeArticleData(articleData);
      if (preparedGallery && (preparedGallery.data !== data || !isGalleryOptionsCurrent(preparedGallery.options))) return;
      var images = data.images;
      var resources = data.resources;
      var textAttachments = data.textAttachments || [];
      if ((!images || !images.length) && !SharedUtils.hasResourcePayload(resources) && !textAttachments.length && !data.hasTextAttachments) return;

      var settings = ATPRenderer.getSettings();
      var w = settings.thumbWidth || 110;
      var h = settings.thumbHeight || 82;
      var cols = settings.gridCols || 5;
      var visRows = settings.visibleRows || 2;
      var gap = settings.gridGap === undefined || settings.gridGap === null ? 6 : settings.gridGap;
      var gallery = preparedGallery || finishGalleryPreparation(prepareGallery(data, getGalleryOptions(settings)));
      var displayLimit = gallery.options.displayLimit;
      var candidatePool = gallery.candidatePool;
      var heavyPlan = gallery.heavyPlan;
      var cacheImages = candidatePool.slice();
      var sourceCandidates = candidatePool;
      var renderLimit = heavyPlan.enabled ? heavyPlan.limit : displayLimit;
      var allCandidates = copyCandidatePrefix(candidatePool, renderLimit);
      // The loader can replace a slot with a mirror or fallback as soon as
      // it registers. Keep the trusted data and the preview source order.
      if (allCandidates === candidatePool) allCandidates = candidatePool.slice();
      var visibleRowsForRender = heavyPlan.enabled && !heavyPlan.lightweight ? 1 : visRows;
      var visibleCount = cols * visibleRowsForRender;
      var firstAutoCount = Math.min(heavyPlan.enabled && heavyPlan.lightweight ? cols : visibleCount, allCandidates.length);
      var gridWidth = cols * w + (cols - 1) * gap;
      var viewportContentH = visibleRowsForRender * h + (visibleRowsForRender - 1) * gap;
      var viewportH = viewportContentH + 12;
      var isTableMode = container.tagName === 'TR' || container.tagName === 'TBODY';

      var panel = document.createElement('div');
      panel.className = 'atp-thread-panel';
      if (panel.style && typeof panel.style.setProperty === 'function') {
        panel.style.setProperty('--atp-cols', String(cols));
        panel.style.setProperty('--atp-thumb-w', w + 'px');
        panel.style.setProperty('--atp-thumb-h', h + 'px');
        panel.style.setProperty('--atp-gap', gap + 'px');
      }
      var threadState = null;
      var isPanelExpanded = false;
      var expandBtn = null;
      var moreBadge = null;
      var viewport = null;
      var grid = null;

      function getExpandButtonLabel(expanded) {
        return expanded ? '收起' : ('展开全部 (' + allCandidates.length + ')');
      }

      function applyViewportStyles() {
        if (!viewport) return;
        var currentRowsNeeded = Math.min(visibleRowsForRender, Math.ceil(allCandidates.length / cols));
        var reservedH = isPanelExpanded
          ? (Math.ceil(allCandidates.length / cols) * h + Math.max(0, Math.ceil(allCandidates.length / cols) - 1) * gap + 12)
          : Math.min(viewportH, currentRowsNeeded * h + Math.max(0, currentRowsNeeded - 1) * gap + 12);
        var cellStripes = 'repeating-linear-gradient(90deg, rgba(15,23,42,0.04) 0, rgba(15,23,42,0.04) ' + w + 'px, transparent ' + w + 'px, transparent ' + (w + gap) + 'px), ' +
          'repeating-linear-gradient(180deg, rgba(15,23,42,0.04) 0, rgba(15,23,42,0.04) ' + h + 'px, transparent ' + h + 'px, transparent ' + (h + gap) + 'px)';
        var cappedCount = isPanelExpanded ? allCandidates.length : Math.min(allCandidates.length, visibleCount);
        var fullRows = Math.floor(cappedCount / cols);
        var lastRowCols = cappedCount - fullRows * cols;
        var skeletonW = fullRows > 0 ? gridWidth : (lastRowCols * w + Math.max(0, lastRowCols - 1) * gap);
        var skeletonRows = fullRows > 0 ? fullRows : 1;
        var skeletonH = skeletonRows * h + Math.max(0, skeletonRows - 1) * gap;
        var maxHText = isPanelExpanded ? 'none' : (viewportH + 'px');
        var overflowText = isPanelExpanded ? 'overflow-x:auto;overflow-y:visible;' : 'overflow-x:auto;overflow-y:hidden;scrollbar-width:none;';
        viewport.style.cssText = 'position:relative;width:100%;max-height:' + maxHText + ';min-height:' + reservedH + 'px;' + overflowText + 'box-sizing:border-box;background-image:' + cellStripes + ';background-size:' + skeletonW + 'px ' + skeletonH + 'px;background-repeat:no-repeat;background-attachment:local;background-origin:content-box;background-clip:content-box;';
      }

      function applyGridStyles() {
        if (!grid) return;
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(' + cols + ',' + w + 'px);grid-auto-rows:' + h + 'px;gap:' + gap + 'px;width:' + gridWidth + 'px;max-width:none;box-sizing:border-box;';
        if (isPanelExpanded) {
          var totalRows = Math.ceil(allCandidates.length / cols);
          grid.style.minHeight = (totalRows * h + Math.max(0, totalRows - 1) * gap) + 'px';
        }
      }

      function updateMoreBadge() {
        if (!viewport) return;
        var hiddenCount = allCandidates.length - firstAutoCount;
        if (hiddenCount <= 0) {
          if (moreBadge) moreBadge.hidden = true;
          return;
        }
        if (!moreBadge) {
          moreBadge = document.createElement('button');
          moreBadge.type = 'button';
          moreBadge.className = 'atp-more-overlay-badge';
          moreBadge.onclick = function(e) {
            if (e && e.stopPropagation) e.stopPropagation();
            setExpanded(true);
          };
          viewport.appendChild(moreBadge);
        }
        moreBadge.hidden = isPanelExpanded;
        moreBadge.textContent = '+' + hiddenCount;
        moreBadge.setAttribute('aria-label', '展开剩余 ' + hiddenCount + ' 张缩略图');
        moreBadge.title = '点击展开剩余 ' + hiddenCount + ' 张缩略图';
        var lastVisibleIdx = Math.max(0, firstAutoCount - 1);
        var badgeCol = lastVisibleIdx % cols;
        var badgeRow = Math.floor(lastVisibleIdx / cols);
        var slotLeft = 6 + badgeCol * (w + gap);
        var slotTop = 6 + badgeRow * (h + gap);
        moreBadge.style.left = slotLeft + 'px';
        moreBadge.style.top = slotTop + 'px';
        moreBadge.style.width = w + 'px';
        moreBadge.style.height = h + 'px';
      }

      function setReadyImageLimit(limit) {
        if (!threadState || threadState.readyImageLimit === limit) return;
        threadState.readyImageLimit = limit;
        if (isPanelExpanded && grid) {
          var rows = Math.ceil(Math.min(allCandidates.length, Math.max(limit, threadState.nextIdx)) / cols);
          grid.style.minHeight = (rows * h + Math.max(0, rows - 1) * gap) + 'px';
        }
        if (window.ATPLoader && ATPLoader.enqueueBgForThread) ATPLoader.enqueueBgForThread(threadState.id);
      }

      function unlockBackgroundImages() {
        if (!threadState || threadState.backgroundUnlocked) return;
        threadState.backgroundUnlocked = true;
        if (window.ATPLoader && ATPLoader.enqueueBgForThread && threadState.firstScreenDone) {
          ATPLoader.enqueueBgForThread(threadState.id);
        }
        if (window.ATPViewport && ATPViewport.retryVisiblePending) ATPViewport.retryVisiblePending();
        if (window.ATPLoader && ATPLoader.globalSchedule) ATPLoader.globalSchedule();
      }

      var viewportId = 'atp-scroll-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
      var displayCount = allCandidates.length;
      var toolbarH = 30;
      var rowsNeeded = allCandidates.length ? Math.min(visibleRowsForRender, Math.ceil(displayCount / cols)) : 0;
      var intrinsicH = (rowsNeeded ? (rowsNeeded * h + Math.max(0, rowsNeeded - 1) * gap + 16) : 0) + toolbarH;
      panel.style.containIntrinsicHeight = 'auto ' + intrinsicH + 'px';

      var toolbar = document.createElement('div');
      toolbar.className = 'atp-toolbar';
      var statusEl = document.createElement('span');
      statusEl.className = 'atp-thread-status';
      statusEl.setAttribute('aria-live', 'off');
      statusEl.textContent = allCandidates.length
        ? (heavyPlan.enabled ? '重图优化 0/' + allCandidates.length + '（原' + sourceCandidates.length + '）' : '加载中 0/' + Math.min(allCandidates.length, visibleCount))
        : '资源链接';
      toolbar.appendChild(statusEl);
      if (heavyPlan.enabled) {
        var heavyBadge = document.createElement('span');
        heavyBadge.className = 'atp-heavy-badge';
        heavyBadge.textContent = heavyPlan.lightweight ? '重图轻量' : '重图优化';
        heavyBadge.title = heavyPlan.lightweight
          ? '检测到高分辨率重图，使用轻量缩略图按普通显示数量展示'
          : '检测到高分辨率重图，仅加载一行代表图以降低滚动卡顿';
        toolbar.appendChild(heavyBadge);
      }

      var setExpanded = function(expanded) {
        expanded = !!expanded;
        if (allCandidates.length <= firstAutoCount) expanded = false;
        isPanelExpanded = expanded;
        if (panel.classList) panel.classList.toggle('atp-panel-expanded', expanded);
        if (viewport) {
          applyViewportStyles();
          applyGridStyles();
        }
        if (expandBtn) {
          expandBtn.hidden = allCandidates.length <= firstAutoCount;
          expandBtn.textContent = getExpandButtonLabel(expanded);
          expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          expandBtn.setAttribute('aria-label', expanded ? '收起缩略图列表' : '展开缩略图列表');
        }
        updateMoreBadge();
        if (threadState && threadState.readyImageQueue) {
          setReadyImageLimit(expanded ? allCandidates.length : Math.max(threadState.firstScreenTotal, firstAutoCount));
        } else if (expanded) {
          unlockBackgroundImages();
          if (threadState && window.ATPLoader && ATPLoader.enqueueBgForThread) {
            ATPLoader.enqueueBgForThread(threadState.id);
          }
        }
      };

      function ensureExpandButton() {
        if (allCandidates.length <= firstAutoCount) {
          if (expandBtn) expandBtn.hidden = true;
          return;
        }
        if (!expandBtn) {
          expandBtn = document.createElement('button');
          expandBtn.type = 'button';
          expandBtn.className = 'atp-thumbnail-expand';
          expandBtn.textContent = getExpandButtonLabel(false);
          expandBtn.setAttribute('aria-expanded', 'false');
          expandBtn.setAttribute('aria-label', '展开缩略图列表');
          expandBtn.setAttribute('aria-controls', viewportId);
          expandBtn.onclick = function() {
            if (!viewport) return;
            setExpanded(!isPanelExpanded);
          };
          var anchorBefore = toolbar.querySelector ? (toolbar.querySelector('[data-resource-trigger]') || toolbar.querySelector('[data-mark-toggle]')) : null;
          if (anchorBefore && toolbar.insertBefore) toolbar.insertBefore(expandBtn, anchorBefore);
          else toolbar.appendChild(expandBtn);
        } else {
          expandBtn.hidden = false;
          expandBtn.textContent = getExpandButtonLabel(isPanelExpanded);
        }
      }

      ensureExpandButton();
      panel.appendChild(toolbar);

      if (allCandidates.length) {
        viewport = document.createElement('div');
        viewport.className = 'atp-scroll-viewport';
        viewport.id = viewportId;
        applyViewportStyles();
        panel.appendChild(viewport);

        grid = document.createElement('div');
        grid.className = THUMB_CLASS;
        applyGridStyles();
        viewport.appendChild(grid);
        updateMoreBadge();
      }

      var outerRow = null;
      if (isTableMode) {
        var row = document.createElement('tr');
        row.className = 'atp-thumb-row';
        outerRow = row;
        var cell = document.createElement('td');
        var sampleTr = container.tagName === 'TBODY' ? container.querySelector('tr') : container;
        cell.setAttribute('colspan', String(countTableCells(sampleTr) || 5));
        cell.style.cssText = 'max-width:100%;overflow:hidden;box-sizing:border-box;padding:4px 0;';
        cell.appendChild(panel);
        row.appendChild(cell);
        if (container.tagName === 'TBODY') container.appendChild(row);
        else container.insertAdjacentElement('afterend', row);
      } else {
        // 非表格容器的布局无法被 isDecoratedArticleContainer 识别，
        // 必须显式打标防止后续重扫时重复注入面板
        container.insertAdjacentElement('afterend', panel);
        if (container.classList) container.classList.add(CONTAINER_CLASS);
      }

      threadState = ATPRenderer.registerThread(allCandidates, resources, grid, statusEl, container, link.href, outerRow, panel, textAttachments, sourceCandidates, heavyPlan, data.hasTextAttachments, data.textAttachmentCount, data.partial, cacheWriteStartedAt, data.textResourcesComplete, data.textResourcesAttemptedCount, data.textResourcesUnresolvedCount, data.textResourcesRetryableCount, Object.assign({}, data, { visibleBeforeCommit: visibleBeforeCommit, gallery: gallery }));
      threadState.cacheImages = cacheImages;
      threadState._setExpanded = setExpanded;
      threadState._isExpanded = function() { return isPanelExpanded; };
      threadState._canExpand = function() { return allCandidates.length > firstAutoCount; };
      threadState._relayout = function(nextSettings) {
        nextSettings = nextSettings || ATPRenderer.getSettings() || {};
        w = nextSettings.thumbWidth || 110;
        h = nextSettings.thumbHeight || 82;
        cols = nextSettings.gridCols || 5;
        gap = nextSettings.gridGap === undefined || nextSettings.gridGap === null ? 6 : nextSettings.gridGap;
        visibleCount = cols * visibleRowsForRender;
        firstAutoCount = Math.min(heavyPlan.enabled && heavyPlan.lightweight ? cols : visibleCount, allCandidates.length);
        gridWidth = cols * w + (cols - 1) * gap;
        viewportContentH = visibleRowsForRender * h + (visibleRowsForRender - 1) * gap;
        viewportH = viewportContentH + 12;
        if (panel.style && typeof panel.style.setProperty === 'function') {
          panel.style.setProperty('--atp-cols', String(cols));
          panel.style.setProperty('--atp-thumb-w', w + 'px');
          panel.style.setProperty('--atp-thumb-h', h + 'px');
          panel.style.setProperty('--atp-gap', gap + 'px');
        }
        var nextRowsNeeded = allCandidates.length ? Math.min(visibleRowsForRender, Math.ceil(allCandidates.length / cols)) : 0;
        var nextIntrinsicH = (nextRowsNeeded ? (nextRowsNeeded * h + Math.max(0, nextRowsNeeded - 1) * gap + 16) : 0) + toolbarH;
        panel.style.containIntrinsicHeight = 'auto ' + nextIntrinsicH + 'px';
        if (allCandidates.length <= firstAutoCount && isPanelExpanded) {
          isPanelExpanded = false;
          if (panel.classList) panel.classList.remove('atp-panel-expanded');
        }
        ensureExpandButton();
        applyViewportStyles();
        applyGridStyles();
        updateMoreBadge();
        if (grid && grid.children) {
          for (var wi = 0; wi < grid.children.length; wi++) {
            var childWrapper = grid.children[wi];
            if (!childWrapper || !childWrapper.style) continue;
            childWrapper.style.width = w + 'px';
            childWrapper.style.height = h + 'px';
            var task = childWrapper.__atpLoadTask;
            var slotIdx = task && typeof task.idx === 'number' ? task.idx : wi;
            if (threadState.readyImageQueue) {
              childWrapper.style.gridColumnStart = (slotIdx % cols) + 1;
              childWrapper.style.gridRowStart = Math.floor(slotIdx / cols) + 1;
            }
            var loadingChild = childWrapper.querySelector ? childWrapper.querySelector('.atp-thumbnail-loading') : null;
            if (loadingChild && loadingChild.style) {
              loadingChild.style.width = w + 'px';
              loadingChild.style.height = h + 'px';
            }
          }
        }
        if (threadState.readyImageQueue && firstAutoCount > threadState.readyImageLimit) {
          setReadyImageLimit(isPanelExpanded ? allCandidates.length : firstAutoCount);
        }
      };
      if (window.ATPViewport && typeof ATPViewport.trackThreadPanel === 'function') {
        ATPViewport.trackThreadPanel(panel, threadState);
      }
      // Which thread this is and what the list calls it, for marking and the
      // copy backup.
      if (window.ATPMarks) {
        var identity = ATPMarks.getThreadIdentity(link.href, container.id);
        threadState.markIdentity = identity.ok ? identity : null;
        threadState.title = ATPMarks.findThreadTitle(container, link, identity.ok ? identity.tid : '');
      }
      if (articleData && Array.isArray(articleData.freshTextAttachments) && articleData.freshTextAttachmentsAt) {
        threadState.freshTextAttachments = articleData.freshTextAttachments;
        threadState.freshTextAttachmentsAt = articleData.freshTextAttachmentsAt;
      }
      queueAutomaticTextResourceLoad(threadState);
      if (window.ATPResourcePanel) {
        ATPResourcePanel.attachThread(panel, threadState);
      }
    },

    registerThread: function(allCandidates, resources, grid, statusEl, container, linkUrl, outerRow, panel, textAttachments, sourceCandidates, heavyPlan, hasTextAttachments, textAttachmentCount, partial, cacheWriteStartedAt, textResourcesComplete, textResourcesAttemptedCount, textResourcesUnresolvedCount, textResourcesRetryableCount, extra) {
      var settings = ATPRenderer.getSettings();
      var cols = settings.gridCols || 5;
      var visRows = settings.visibleRows || 2;
      var firstScreenCount = cols * visRows;
      var lightweightHeavyMode = !!(heavyPlan && heavyPlan.enabled && heavyPlan.lightweight);
      var firstScreenTotal = Math.min(firstScreenCount, allCandidates.length);
      if (lightweightHeavyMode) {
        firstScreenTotal = Math.min(Math.max(1, cols || 5), allCandidates.length);
      }

      var registeredAt = Date.now();
      var threadId = 't_' + registeredAt + '_' + Math.random().toString(36).substring(2, 8);
      var generation = window.ATPState && typeof window.ATPState.generation === 'number'
        ? window.ATPState.generation
        : 0;
      var normalizedTextAttachments = [];
      for (var tai = 0; tai < (textAttachments || []).length; tai++) {
        var attachment = textAttachments[tai];
        normalizedTextAttachments.push(!attachment || attachment.pageUrl ? attachment : Object.assign({}, attachment, { pageUrl: linkUrl }));
      }
      var normalizedResources = extra && extra.gallery ? resources : SharedUtils.normalizeResources(resources);
      var hasCachedTextResources = textResourcesComplete === true;
      var threadState = {
        id: threadId,
        registeredInState: true,
        generation: generation,
        candidates: allCandidates,
        sourceCandidates: sourceCandidates || allCandidates,
        heavyMode: !!(heavyPlan && heavyPlan.enabled),
        readyImageQueue: !(heavyPlan && heavyPlan.enabled),
        lightweightHeavyMode: lightweightHeavyMode,
        heavyOriginalTotal: sourceCandidates ? sourceCandidates.length : allCandidates.length,
        nextIdx: 0,
        loaded: 0,
        failedCount: 0,
        loadedUrls: [],
        loadedUrlMap: {},
        firstScreenTotal: firstScreenTotal,
        readyImageLimit: firstScreenTotal,
        firstScreenOk: 0,
        firstScreenFailed: 0,
        firstScreenDone: false,
        backgroundUnlocked: settings.autoLoadOffscreenFirstRowsEnabled !== true,
        bgQueued: false,
        bgQueueActive: false,
        bgBatchPending: 0,
        consecutiveFails: 0,
        fallbackIdx: allCandidates.length,
        heavyFallbackIdx: allCandidates.length,
        firstTasks: new Array(firstScreenTotal),
        firstTaskOffset: 0,
        grid: grid,
        statusEl: statusEl,
        container: container,
        link: linkUrl,
        resources: normalizedResources,
        textAttachments: normalizedTextAttachments,
        hasTextAttachments: !!hasTextAttachments,
        textAttachmentCount: textAttachmentCount || 0,
        partial: !!partial,
        cacheWriteStartedAt: typeof cacheWriteStartedAt === 'number' && isFinite(cacheWriteStartedAt) && cacheWriteStartedAt > 0
          ? cacheWriteStartedAt
          : registeredAt,
        textResourcesLoading: false,
        textResourcesDone: hasCachedTextResources,
        textResourcesRetryable: false,
        textResourcesAutoQueued: false,
        textResourcesAutoActive: false,
        textResourcesAutoAttempted: hasCachedTextResources,
        textResourcesRun: null,
        textResourcesRunId: 0,
        textResourcesAttemptedCount: Math.max(0, Number(textResourcesAttemptedCount || 0) || 0),
        textResourcesUnresolvedCount: Math.max(0, Number(textResourcesUnresolvedCount || 0) || 0),
        textResourcesRetryableCount: Math.max(0, Number(textResourcesRetryableCount || 0) || 0),
        outerRow: outerRow,
        panel: panel,
        total: allCandidates.length
      };
      // When the thread's content was actually read: a cache hit is not a
      // fresh read.
      threadState.contentReadAt = Number(extra && extra.readAt) || threadState.cacheWriteStartedAt;
      threadState.imageExtractionVersion = extra && extra.imageExtractionVersion;
      threadState.textResourcesImported = !!(extra && extra.textResourcesImported);
      threadState.textAttachmentsLimited = !!(extra && extra.textAttachmentsLimited);
      threadState.textAttachmentHints = SharedUtils.mergeTextAttachmentHints(SharedUtils.getTextAttachmentHints(normalizedTextAttachments), extra && extra.textAttachmentHints);
      threadState.textResolvedAttachmentIds = SharedUtils.mergeResolvedTextIds(threadState.textAttachmentHints, extra && extra.textResolvedAttachmentIds);
      if (extra && typeof extra.visibleBeforeCommit === 'boolean') {
        threadState.readyImageVisible = extra.visibleBeforeCommit;
      }

      if (isGalleryDebugEnabled()) {
        Logger.event('thread_registered', {
          threadId: threadId,
          heavyMode: threadState.heavyMode,
          lightweightHeavyMode: threadState.lightweightHeavyMode,
          candidates: allCandidates.length,
          sourceCandidates: threadState.sourceCandidates.length,
          firstScreenTotal: threadState.firstScreenTotal,
          stagedTotal: threadState.total,
          resourceCount: SharedUtils.countResources(threadState.resources),
          textAttachments: threadState.textAttachments.length,
          hasTextAttachments: threadState.hasTextAttachments,
          partial: threadState.partial,
          hostMix: extra && extra.gallery ? extra.gallery.hostMix : finishGalleryPreparation(summarizeImageHosts(threadState.sourceCandidates)),
          link: linkUrl
        });
      }

      if (!window.ATPState) window.ATPState = { threads: {} };
      if (!window.ATPState.threads) window.ATPState.threads = {};
      window.ATPState.threads[threadId] = threadState;

      var queuedAt = registeredAt;
      for (var i = 0; i < threadState.firstScreenTotal; i++) {
        threadState.firstTasks[i] = {
          candidates: allCandidates,
          idx: i,
          threadId: threadId,
          generation: generation,
          grid: grid,
          isFirstScreen: true,
          firstScreenSettled: false,
          createdAt: queuedAt,
          queuedAt: queuedAt,
          queueKind: 'first_screen'
        };
        threadState.nextIdx++;
      }

      if (window.ATPLoader && ATPLoader.registerFirstScreenTiming) ATPLoader.registerFirstScreenTiming(threadState);

      if (!threadState.firstScreenTotal) {
        container.classList.add(CONTAINER_CLASS);
        cacheThreadArticle(threadState, true, threadState.cacheWriteStartedAt, 'preview');
        return threadState;
      }

      ATPLoader.ensureGlobalVisListener();
      ATPLoader.globalSchedule();
      return threadState;
    },

    scheduleTextResourceLoad: function(threadState, manualRetry) {
      if (!threadState) return false;
      if (!isThreadCurrent(threadState)) return false;
      if (threadState.textResourcesImporting || threadState.textResourcesLoading || (threadState.textResourcesDone && !threadState.textResourcesRetryable)) return false;
      var hasAttachments = (threadState.textAttachments && threadState.textAttachments.length) || threadState.hasTextAttachments || threadState.textResourcesRetryable;
      if (!hasAttachments) return false;
      var writeStartedAt = Date.now();
      var run = {
        id: Math.max(0, Number(threadState.textResourcesRunId || 0) || 0) + 1,
        automatic: !!threadState.textResourcesAutoActive,
        startedAt: writeStartedAt,
        released: false
      };
      threadState.textResourcesRunId = run.id;
      threadState.textResourcesRun = run;
      threadState.textResourcesLoading = true;
      threadState.textResourcesRetryable = false;
      threadState.textResourceMessage = run.automatic ? 'TXT 资源自动解析中' : 'TXT 资源解析中';
      if (!threadState.candidates.length && threadState.statusEl) {
        threadState.statusEl.textContent = '资源解析中';
      }
      if (window.ATPResourcePanel) {
        ATPResourcePanel.updateThread(threadState);
      }

      var isRunCurrent = function() {
        return threadState.textResourcesRun === run && isThreadCurrent(threadState);
      };

      var initialResourceCount = SharedUtils.countResources(threadState.resources);
      var showResolvedTextResources = function(resources, attachments) {
        if (!isRunCurrent()) return;
        threadState.resources = SharedUtils.mergeResources(threadState.resources, resources);
        if (attachments && attachments.length) rememberResolvedAttachments(threadState, attachments);
        if (!threadState.candidates.length && threadState.statusEl) threadState.statusEl.textContent = '资源链接';
        if (window.ATPResourcePanel) ATPResourcePanel.updateThread(threadState);
      };

      var shouldYieldBeforeRequest = function() {
        return run.automatic && hasQueuedVisibleTextResourceThread(threadState) && !isThreadOnScreen(threadState);
      };

      var getTextRunPriority = function(stage) {
        var pacer = window.ATPForumPacer;
        var articlePriority = pacer && typeof pacer.PRIORITY_ARTICLE === 'number' ? pacer.PRIORITY_ARTICLE : 1;
        var onScreen = document.visibilityState !== 'hidden' && isThreadOnScreen(threadState);
        if (onScreen && stage === 'background_fallback') {
          return pacer && typeof pacer.PRIORITY_VISIBLE === 'number' ? pacer.PRIORITY_VISIBLE : 0;
        }
        return articlePriority + (run.automatic && !onScreen ? 1 : 0);
      };

      var makeTextRunOptions = function() {
        return {
          manualRetry: !!manualRetry,
          diagnosticThreadId: threadState.id || '',
          diagnosticRunId: run.id,
          isStale: function() { return !isRunCurrent(); },
          isCancelled: shouldYieldBeforeRequest,
          getPriority: getTextRunPriority,
          onResources: showResolvedTextResources
        };
      };

      var logTextResourceResult = function(outcome, fields) {
        if (typeof Logger.event !== 'function') return;
        Logger.event('txt_result', Object.assign({
          threadId: threadState.id || '',
          url: threadState.link,
          runId: run.id,
          automatic: run.automatic,
          manualRetry: !!manualRetry,
          outcome: outcome,
          reason: outcome,
          ms: Math.max(0, Date.now() - run.startedAt)
        }, fields), outcome === 'complete' || outcome === 'yielded' ? 'INFO' : 'WARN');
      };

      var requeueYieldedTextResourceRun = function(result) {
        if (!isRunCurrent()) {
          releaseAutomaticTextResourceSlot(threadState, run);
          return;
        }
        var retainedResources = SharedUtils.normalizeResources(result && result.resources);
        rememberResolvedAttachments(threadState, result && result.resolvedAttachments);
        threadState.resources = SharedUtils.mergeResources(threadState.resources, retainedResources);
        threadState.textResourcesLoading = false;
        threadState.textResourcesDone = false;
        threadState.textResourcesRetryable = false;
        threadState.textResourcesAutoAttempted = false;
        // Only a settled fetcher promise may release this slot. Issued
        // requests have finished; the unissued remainder can queue again.
        releaseAutomaticTextResourceSlot(threadState, run);
        queueAutomaticTextResourceLoad(threadState);
        if (!threadState.candidates.length && threadState.statusEl) {
          threadState.statusEl.textContent = SharedUtils.hasResourcePayload(threadState.resources) ? '资源链接' : '资源解析排队中';
        }
        if (window.ATPResourcePanel) ATPResourcePanel.updateThread(threadState);
        logTextResourceResult('yielded', {
          fetchedResources: SharedUtils.countResources(retainedResources),
          addedResources: Math.max(0, SharedUtils.countResources(threadState.resources) - initialResourceCount),
          totalResources: SharedUtils.countResources(threadState.resources)
        });
      };

      var failTextResourceLoad = function(message, e) {
        if (!isRunCurrent()) {
          releaseAutomaticTextResourceSlot(threadState, run);
          return;
        }
        threadState.textResourcesLoading = false;
        threadState.textResourcesDone = false;
        threadState.textResourcesRetryable = true;
        threadState.textResourceMessage = message;
        releaseAutomaticTextResourceSlot(threadState, run);
        if (!threadState.candidates.length && threadState.statusEl) {
          threadState.statusEl.textContent = SharedUtils.hasResourcePayload(threadState.resources) ? '资源链接' : 'TXT 待重试';
        }
        if (window.ATPResourcePanel) {
          ATPResourcePanel.updateThread(threadState);
        }
        logTextResourceResult('failed', { failureClass: 'processing_error', fetchedResources: 0 });
      };

      var existingAttachments = threadState.textAttachments || [];
      var stableAttachments = existingAttachments.filter(function(attachment) {
        return attachment && attachment.url && !SharedUtils.isTransientTextAttachmentUrl(attachment.url, threadState.link);
      });
      var hasTransientLinks = stableAttachments.length < existingAttachments.length;
      var freshLinksAt = Number(threadState.freshTextAttachmentsAt) || 0;
      var canReuseFreshLinks = !manualRetry && freshLinksAt > 0 && Date.now() - freshLinksAt < FRESH_TEXT_LINK_REUSE_MS;
      var expectedAttachmentCount = Math.max(existingAttachments.length, Number(threadState.textAttachmentCount) || 0);
      // pendingCount: attachments known to exist but not in this list (their
      // fresh links could not be read); they keep the thread retryable.
      var doFetch = function(attachments, pendingCount) {
        pendingCount = Math.max(0, Number(pendingCount) || 0);
        if (!isRunCurrent()) {
          releaseAutomaticTextResourceSlot(threadState, run);
          return;
        }
        var fetchPromise;
        try {
          var fetchOptions = makeTextRunOptions();
          fetchPromise = ATPFetcher.fetchTextAttachmentResourcesWithStatus
            ? ATPFetcher.fetchTextAttachmentResourcesWithStatus(attachments, fetchOptions)
            : ATPFetcher.fetchTextAttachmentResources(attachments, fetchOptions);
        } catch (e) {
          failTextResourceLoad('TXT 资源解析失败', e);
          return;
        }
        if (!fetchPromise || typeof fetchPromise.then !== 'function') {
          failTextResourceLoad('TXT 资源解析失败', 'fetcher did not return a promise');
          return;
        }
        Promise.resolve(fetchPromise).then(function(result) {
          if (!isRunCurrent()) {
            releaseAutomaticTextResourceSlot(threadState, run);
            return;
          }
          if (result && result.yielded === true && run.automatic && !manualRetry) {
            requeueYieldedTextResourceRun(result);
            return;
          }
          threadState.textResourcesLoading = false;
          var textStatus = normalizeTextResourceLoadResult(result, attachments.length);
          var resources = textStatus.resources;
          var hasFetchedResources = SharedUtils.hasResourcePayload(resources);
          var resolvedAttachments = Array.isArray(result && result.resolvedAttachments) ? result.resolvedAttachments :
            (hasFetchedResources && !textStatus.unresolvedCount ? attachments : []);
          var confirmed = rememberResolvedAttachments(threadState, resolvedAttachments);
          var remaining = Math.max(0, Math.max(expectedAttachmentCount, attachments.length + pendingCount) - confirmed);
          var unresolvedCount = Math.min(remaining, textStatus.unresolvedCount + pendingCount);
          if (!hasFetchedResources) unresolvedCount = remaining;
          var retryableCount = Math.min(unresolvedCount, textStatus.retryableCount + pendingCount);
          threadState.textResourcesDone = unresolvedCount === 0 && (hasFetchedResources || confirmed > 0);
          threadState.textResourcesRetryable = !threadState.textResourcesDone && (retryableCount > 0 || !hasFetchedResources);
          threadState.textResourcesAttemptedCount = Math.max(threadState.textResourcesAttemptedCount || 0, textStatus.attemptedCount, confirmed);
          threadState.textResourcesUnresolvedCount = unresolvedCount;
          threadState.textResourcesRetryableCount = retryableCount;
          threadState.resources = SharedUtils.mergeResources(threadState.resources, resources);
          if (threadState.textResourcesDone) {
            threadState.textResourceMessage = '';
          } else if (textStatus.accessDeniedCount > 0 && unresolvedCount > 0) {
            threadState.textResourceMessage = '站点拒绝读取 ' + textStatus.accessDeniedCount + ' 个 TXT 附件，可在原帖下载后导入';
          } else if (unresolvedCount > 0 && hasFetchedResources) {
            threadState.textResourceMessage = '已解析部分 TXT 资源，仍有 ' + unresolvedCount + ' 个附件待重试';
          } else if (unresolvedCount > 0) {
            threadState.textResourceMessage = '有 ' + unresolvedCount + ' 个 TXT 附件待重试，可重试本帖或导入已下载 TXT';
          } else {
            threadState.textResourceMessage = hasFetchedResources
              ? ''
              : '识别到 TXT 附件 ' + attachments.length + ' 个，但未解析到资源链接';
          }
          releaseAutomaticTextResourceSlot(threadState, run);

          if (!threadState.candidates.length && threadState.statusEl) {
            threadState.statusEl.textContent = SharedUtils.hasResourcePayload(threadState.resources) ? '资源链接' :
              (threadState.textResourcesRetryable ? 'TXT 待重试' : '无资源');
          }

          if (window.ATPResourcePanel) {
            ATPResourcePanel.updateThread(threadState);
          }

          var imageDone = !threadState.candidates.length || (threadState.nextIdx >= threadState.candidates.length && threadState.loaded + threadState.failedCount >= threadState.candidates.length);
          cacheThreadArticle(threadState, imageDone, writeStartedAt, 'text');
          var totalResourceCount = SharedUtils.countResources(threadState.resources);
          logTextResourceResult(threadState.textResourcesDone ? 'complete' : (hasFetchedResources ? 'partial' : 'failed'), {
            attemptedCount: textStatus.attemptedCount,
            unresolvedCount: unresolvedCount,
            retryableCount: retryableCount,
            accessDeniedCount: textStatus.accessDeniedCount,
            fetchedResources: SharedUtils.countResources(resources),
            addedResources: Math.max(0, totalResourceCount - initialResourceCount),
            totalResources: totalResourceCount
          });
        }, function(e) {
          failTextResourceLoad('TXT 资源解析失败', e);
        }).catch(function(e) {
          failTextResourceLoad('TXT 资源解析失败', e);
        });
      };

      var fallbackToCachedAttachmentsAfterFreshFailure = function(message, e) {
        if (stableAttachments.length && isRunCurrent()) {
          threadState.textAttachments = stableAttachments;
          threadState.hasTextAttachments = expectedAttachmentCount > stableAttachments.length;
          threadState.textResourceMessage = 'TXT 附件重新提取失败，解析已缓存附件';
          if (window.ATPResourcePanel) {
            ATPResourcePanel.updateThread(threadState);
          }
          Logger.debug(message + '，改用已缓存TXT附件', threadState.link + ' ' + (e && e.message ? e.message : e || 'unknown error'));
          doFetch(stableAttachments, expectedAttachmentCount - stableAttachments.length);
          return;
        }
        failTextResourceLoad(message, e);
      };

      var needsFreshExtraction = (hasTransientLinks && !canReuseFreshLinks) ||
        (threadState.hasTextAttachments && expectedAttachmentCount > existingAttachments.length);
      if (existingAttachments.length && !needsFreshExtraction) {
        setTimeout(function() {
          if (isRunCurrent()) doFetch(threadState.textAttachments);
          else releaseAutomaticTextResourceSlot(threadState, run);
        }, 0);
        return true;
      }

      // Re-extract marker-only or mixed cached TXT states to recover unstable transient attachment URLs.
      threadState.textResourceMessage = '重新提取附件链接中';
      if (window.ATPResourcePanel) {
        ATPResourcePanel.updateThread(threadState);
      }
      setTimeout(function() {
        if (!isRunCurrent()) {
          releaseAutomaticTextResourceSlot(threadState, run);
          return;
        }
        var freshPromise;
        // Automatic work can reuse recent links from the article fetch.
        // A manual retry of transient links reads the thread again.
        var reusableLinks = canReuseFreshLinks && Array.isArray(threadState.freshTextAttachments)
          ? threadState.freshTextAttachments
          : null;
        threadState.freshTextAttachments = null;
        try {
          freshPromise = reusableLinks
            ? Promise.resolve(reusableLinks)
            : ATPFetcher.fetchTextAttachmentsFresh(threadState.link, makeTextRunOptions());
        } catch (e) {
          fallbackToCachedAttachmentsAfterFreshFailure('TXT 附件链接提取失败', e);
          return;
        }
        if (!freshPromise || typeof freshPromise.then !== 'function') {
          fallbackToCachedAttachmentsAfterFreshFailure('TXT 附件链接提取失败', 'fresh attachment fetcher did not return a promise');
          return;
        }
        Promise.resolve(freshPromise).then(function(freshAttachments) {
          if (!isRunCurrent()) {
            releaseAutomaticTextResourceSlot(threadState, run);
            return;
          }
          if (freshAttachments && freshAttachments.yielded === true && run.automatic && !manualRetry) {
            requeueYieldedTextResourceRun(freshAttachments);
            return;
          }
          // null: the thread could not be re-read this time (network, forum
          // challenge, or the wait ran past its deadline), not "no attachments".
          if (!Array.isArray(freshAttachments)) {
            fallbackToCachedAttachmentsAfterFreshFailure('TXT 附件链接提取失败', 'fresh attachment links unavailable');
            return;
          }
          var attachments = mergeTextAttachments(freshAttachments, stableAttachments, threadState.link);
          threadState.textAttachments = attachments;
          threadState.freshTextAttachmentsAt = reusableLinks ? freshLinksAt : Date.now();
          threadState.textAttachmentCount = Math.max(expectedAttachmentCount, attachments.length);
          var missingAttachmentCount = Math.max(0, threadState.textAttachmentCount - attachments.length);
          threadState.hasTextAttachments = missingAttachmentCount > 0;
          if (!attachments.length) {
            failTextResourceLoad('未读取到 TXT 附件链接，可在原帖下载后导入');
            return;
          }
          doFetch(attachments, missingAttachmentCount);
        }, function(e) {
          fallbackToCachedAttachmentsAfterFreshFailure('TXT 附件链接提取失败', e);
        }).catch(function(e) {
          fallbackToCachedAttachmentsAfterFreshFailure('TXT 附件链接提取失败', e);
        });
      }, 0);
      return true;
    },

    importTextResources: function(threadState, imports) {
      if (!threadState || !isThreadCurrent(threadState) || !Array.isArray(imports) || !imports.length) return false;
      var merged = SharedUtils.emptyResources();
      var usable = [];
      for (var i = 0; i < imports.length; i++) {
        var normalized = SharedUtils.normalizeResources(imports[i] && imports[i].resources);
        if (!SharedUtils.hasResourcePayload(normalized)) continue;
        // Links from a local file stay labelled as such wherever they are kept.
        SharedUtils.RESOURCE_GROUP_ORDER.forEach(function(type) {
          normalized.groups[type].forEach(function(item) { item.source = SharedUtils.mergeResourceSource(item.source, 'import'); });
        });
        usable.push({ nameKey: SharedUtils.textFileNameKey(imports[i].name), resources: normalized });
        merged = SharedUtils.mergeResources(merged, normalized);
      }
      if (!SharedUtils.hasResourcePayload(merged)) return false;

      var writeStartedAt = Date.now();
      var hints = threadState.textAttachmentHints = getThreadAttachmentHints(threadState);
      var ids = [];
      var filesByName = new Map();
      usable.forEach(function(file) { filesByName.set(file.nameKey, (filesByName.get(file.nameKey) || 0) + 1); });
      for (var ui = 0; ui < usable.length; ui++) {
        var file = usable[ui];
        if (!file.nameKey || filesByName.get(file.nameKey) !== 1) continue;
        var matches = hints.filter(function(hint) { return hint.nameKey === file.nameKey; });
        if (matches.length !== 1) continue;
        var match = matches[0];
        ids.push(SharedUtils.textAttachmentProgressId(match, hints));
        if (!match.urlKey) continue;
        var attachment = (threadState.textAttachments || []).find(function(item) {
          return item && SharedUtils.isPersistableTextAttachmentUrl(item.url, threadState.link) &&
            SharedUtils.getTextAttachmentCacheKeySuffix(item.url) === match.urlKey;
        });
        if (attachment) {
          ATPCache.setCachedTextResources(attachment.url, file.resources, writeStartedAt);
          ATPCache.clearTextFailCache(attachment.url);
        }
      }
      threadState.textResolvedAttachmentIds = SharedUtils.mergeResolvedTextIds(hints, threadState.textResolvedAttachmentIds, ids);
      var expectedImportCount = Math.max(
        1, hints.length,
        Number(threadState.textAttachmentCount || 0) || 0,
        (threadState.textAttachments && threadState.textAttachments.length) || 0
      );
      var importUnresolvedCount = threadState.textResourcesDone ? 0 : Math.max(0, expectedImportCount - threadState.textResolvedAttachmentIds.length);
      if (threadState.textResourcesUnresolvedCount > 0) importUnresolvedCount = Math.min(importUnresolvedCount, threadState.textResourcesUnresolvedCount);
      threadState.textResourcesRunId = Math.max(0, Number(threadState.textResourcesRunId || 0) || 0) + 1;
      threadState.textResourcesRun = null;
      threadState.textResourcesAutoQueued = false;
      threadState.textResourcesAutoActive = false;
      threadState.resources = SharedUtils.mergeResources(threadState.resources, merged);
      threadState.textResourcesLoading = false;
      threadState.textResourcesImporting = false;
      threadState.textResourcesDone = importUnresolvedCount === 0;
      threadState.textResourcesRetryable = importUnresolvedCount > 0;
      threadState.textResourcesAttemptedCount = Math.max(threadState.textResourcesAttemptedCount || 0, threadState.textResolvedAttachmentIds.length);
      threadState.textResourcesUnresolvedCount = importUnresolvedCount;
      threadState.textResourcesRetryableCount = importUnresolvedCount;
      threadState.textResourceMessage = '已从本地 TXT 导入 ' + SharedUtils.countResources(merged) + ' 条资源' +
        (ids.length < usable.length ? '，部分文件无法按名称对应到原帖附件' : '') + (
        importUnresolvedCount ? '，仍有 ' + importUnresolvedCount + ' 个附件待补齐' : ''
      );
      threadState.textResourcesAutoAttempted = true;
      threadState.textResourcesImported = true;
      if (!threadState.candidates.length && threadState.statusEl) threadState.statusEl.textContent = '资源链接';

      var imageDone = !threadState.candidates.length || (threadState.nextIdx >= threadState.candidates.length && threadState.loaded + threadState.failedCount >= threadState.candidates.length);
      cacheThreadArticle(threadState, imageDone, writeStartedAt, 'text');
      if (window.ATPResourcePanel) ATPResourcePanel.updateThread(threadState);
      Logger.debug('本地TXT资源导入', threadState.link + ' 资源' + SharedUtils.countResources(merged));
      return true;
    },

    queueAutomaticTextResourceLoad: queueAutomaticTextResourceLoad,
    wakeAutomaticTextResourceQueue: wakeAutomaticTextResourceQueue,

    relayoutAllPanels: function(settings) {
      var threads = window.ATPState && window.ATPState.threads;
      if (!threads) return 0;
      var updated = 0;
      for (var tid in threads) {
        var ts = threads[tid];
        if (!ts || !isThreadCurrent(ts) || typeof ts._relayout !== 'function') continue;
        ts._relayout(settings);
        updated++;
      }
      return updated;
    },

    setAllThreadsExpanded: function(expanded) {
      expanded = !!expanded;
      var threads = window.ATPState && window.ATPState.threads;
      var count = 0;
      if (threads) {
        for (var tid in threads) {
          var ts = threads[tid];
          if (!ts || !isThreadCurrent(ts) || typeof ts._setExpanded !== 'function') continue;
          if (typeof ts._canExpand === 'function' && !ts._canExpand()) continue;
          ts._setExpanded(expanded);
          count++;
        }
      }
      return { expanded: expanded, count: count };
    },

    areAllThreadsExpanded: function() {
      var threads = window.ATPState && window.ATPState.threads;
      if (!threads) return false;
      var expandable = 0;
      for (var tid in threads) {
        var ts = threads[tid];
        if (!ts || !isThreadCurrent(ts) || typeof ts._isExpanded !== 'function') continue;
        if (typeof ts._canExpand === 'function' && !ts._canExpand()) continue;
        expandable++;
        if (!ts._isExpanded()) return false;
      }
      return expandable > 0;
    },

    getAutomaticTextResourceQueueState: function() {
      return {
        active: AUTO_TEXT_RESOURCE_ACTIVE,
        queued: AUTO_TEXT_RESOURCE_QUEUE.length,
        concurrency: AUTO_TEXT_RESOURCE_CONCURRENCY
      };
    }
  };

  window.ATPRenderer = ATPRenderer;
})();
