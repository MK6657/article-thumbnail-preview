(function () {
  'use strict';

  var CONTAINER_CLASS = 'atp-processed';
  var THUMB_CLASS = 'atp-thumbnail-container';
  var AUTO_TEXT_RESOURCE_QUEUE = [];
  var AUTO_TEXT_RESOURCE_ACTIVE = 0;
  var AUTO_TEXT_RESOURCE_CONCURRENCY = 2;
  var AUTO_TEXT_RESOURCE_DRAIN_SCHEDULED = false;

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
      retryableCount: retryable
    };
  }

  function mergeTextAttachments(existingAttachments, freshAttachments, pageUrl) {
    var out = [];
    var seen = {};
    var maxCount = SharedUtils.TEXT_ATTACHMENT_MAX_COUNT || 3;

    function append(attachments) {
      attachments = Array.isArray(attachments) ? attachments : [];
      for (var i = 0; i < attachments.length && out.length < maxCount; i++) {
        var attachment = attachments[i];
        if (!attachment || !attachment.url) continue;
        var key = SharedUtils.normalizeTextAttachmentUrl(attachment.url);
        if (!key || seen[key]) continue;
        seen[key] = true;
        out.push(attachment.pageUrl ? attachment : Object.assign({}, attachment, { pageUrl: pageUrl }));
      }
    }

    append(existingAttachments);
    append(freshAttachments);
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
    threadState.textResourcesAutoQueued = false;
    if (run) {
      if (run.released) return;
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

  function drainAutomaticTextResourceQueue() {
    while (AUTO_TEXT_RESOURCE_ACTIVE < AUTO_TEXT_RESOURCE_CONCURRENCY && AUTO_TEXT_RESOURCE_QUEUE.length) {
      var threadState = AUTO_TEXT_RESOURCE_QUEUE.shift();
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

  function summarizeImageHosts(candidates) {
    var counts = {};
    var topHosts = [];
    var heavyHosts = 0;
    candidates = candidates || [];
    for (var i = 0; i < candidates.length; i++) {
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
      if (!settings || settings.heavyImageOptimization === false) {
        return { enabled: false, limit: candidates.length };
      }
      var heavyCount = 0;
      for (var i = 0; i < candidates.length; i++) {
        if (ATPRenderer.isHeavyImage(candidates[i])) heavyCount++;
      }
      // 阈值与 SharedUtils.isHeavyImageCandidateSet 完全一致（heavyCount>=3 且占比>=0.5），
      // 上面已把整表扫过一遍（且全轻图时那一遍的结果原本被直接丢弃），不必再扫第二遍
      var enabled = candidates.length > 0 && heavyCount >= 3 && heavyCount / candidates.length >= 0.5;
      if (!enabled) return { enabled: false, limit: candidates.length };
      var lightweight = ATPRenderer.isLightweightHeavyThumbnailMode(settings);
      return {
        enabled: true,
        lightweight: lightweight,
        limit: lightweight
          ? Math.min(candidates.length, displayLimit || candidates.length)
          : Math.min(candidates.length, Math.max(3, Math.min(cols || 5, 6))),
        heavyCount: heavyCount
      };
    },

    prioritizeLoadedCandidates: function(candidates, loadedUrls) {
      candidates = Array.isArray(candidates) ? candidates : [];
      loadedUrls = Array.isArray(loadedUrls) ? loadedUrls : [];
      if (!candidates.length || !loadedUrls.length) return candidates;

      var indexByNormalized = {};
      var previewKeys = new Array(candidates.length);
      var displayKeys = new Array(candidates.length);
      for (var i = 0; i < candidates.length; i++) {
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
        var key = previewKeys[j] || '';
        if (!key || used[key]) continue;
        used[key] = true;
        out.push(candidates[j]);
      }
      return out;
    },

    injectThumbnails: function(container, articleData, link, cacheWriteStartedAt) {
      if (container.tagName === 'TH' || container.tagName === 'TD') {
        container = container.parentElement;
        if (!container || (container.tagName !== 'TR' && container.tagName !== 'TBODY')) return;
      }
      if (isDecoratedArticleContainer(container)) return;

      var data = ATPCache.normalizeArticleData(articleData);
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
      var fetchLimit = SharedUtils.effectiveFetchLimit(settings);
      var displayLimit = SharedUtils.effectiveDisplayLimit(settings);
      var candidatePool = copyCandidatePrefix(images, fetchLimit);
      var heavyPlan = ATPRenderer.getHeavyImagePlan(candidatePool, settings, cols, displayLimit);
      if (heavyPlan.enabled) {
        candidatePool = ATPRenderer.prioritizeLoadedCandidates(candidatePool, data.loadedUrls);
      }
      var sourceCandidates = candidatePool;
      var renderLimit = heavyPlan.enabled ? heavyPlan.limit : displayLimit;
      var allCandidates = copyCandidatePrefix(candidatePool, renderLimit);
      var visibleRowsForRender = heavyPlan.enabled && !heavyPlan.lightweight ? 1 : visRows;
      var visibleCount = cols * visibleRowsForRender;
      var gridWidth = cols * w + (cols - 1) * gap;
      var viewportContentH = visibleRowsForRender * h + (visibleRowsForRender - 1) * gap;
      var viewportH = viewportContentH + 12;
      var isTableMode = container.tagName === 'TR' || container.tagName === 'TBODY';

      var panel = document.createElement('div');
      panel.className = 'atp-thread-panel';
      var viewportId = 'atp-scroll-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
      var intrinsicH = (allCandidates.length ? viewportH : 0) + 30;
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
      if (allCandidates.length > visibleCount) {
        var expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'atp-thumbnail-expand';
        expandBtn.textContent = '展开';
        expandBtn.setAttribute('aria-expanded', 'false');
        expandBtn.setAttribute('aria-label', '展开缩略图列表');
        expandBtn.setAttribute('aria-controls', viewportId);
        expandBtn.onclick = function() {
          var vp = document.getElementById(viewportId) || panel.querySelector('.atp-scroll-viewport');
          if (!vp) return;
          var expanded = vp.style.maxHeight !== 'none';
          vp.style.maxHeight = expanded ? 'none' : viewportH + 'px';
          expandBtn.textContent = expanded ? '收起' : '展开';
          expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          expandBtn.setAttribute('aria-label', expanded ? '收起缩略图列表' : '展开缩略图列表');
        };
        toolbar.appendChild(expandBtn);
      }
      panel.appendChild(toolbar);

      var grid = null;
      if (allCandidates.length) {
        var viewport = document.createElement('div');
        viewport.className = 'atp-scroll-viewport';
        viewport.id = viewportId;
        // 预留最终高度（行数在渲染时已知，封顶为可视高度）：
        // 否则 wrapper 逐个插入时面板逐行长高，每长一行下方整页内容跟着位移
        var rowsNeeded = Math.ceil(allCandidates.length / cols);
        var reservedH = Math.min(viewportH, rowsNeeded * h + Math.max(0, rowsNeeded - 1) * gap + 12);
        // 预留区画上静态骨架格（两向条纹交叠成格子），避免「大片空白等待」的观感；
        // wrapper 逐个装填时会自然盖住对应格子，纯静态背景无逐帧成本
        var cellStripes = 'repeating-linear-gradient(90deg, rgba(0,0,0,0.045) 0, rgba(0,0,0,0.045) ' + w + 'px, transparent ' + w + 'px, transparent ' + (w + gap) + 'px), ' +
          'repeating-linear-gradient(180deg, rgba(0,0,0,0.045) 0, rgba(0,0,0,0.045) ' + h + 'px, transparent ' + h + 'px, transparent ' + (h + gap) + 'px)';
        // 只画「整行」的格子：末行通常不满，按满列宽画会在装填完成后留下永久的幽灵格；
        // background-attachment:local 让骨架随视口内容滚动（默认 scroll 锚定 padding box 会错位）
        var fullRows = Math.floor(allCandidates.length / cols);
        var lastRowCols = allCandidates.length - fullRows * cols;
        var skeletonW = fullRows > 0 ? gridWidth : (lastRowCols * w + Math.max(0, lastRowCols - 1) * gap);
        var skeletonRows = fullRows > 0 ? fullRows : 1;
        var skeletonH = skeletonRows * h + Math.max(0, skeletonRows - 1) * gap;
        // background-origin:content-box 抵消 .atp-scroll-viewport 的 6px padding，
        // 否则骨架相对真实 grid 恒偏移一个 padding
        viewport.style.cssText = 'width:100%;max-height:' + viewportH + 'px;min-height:' + reservedH + 'px;overflow-y:auto;overflow-x:auto;box-sizing:border-box;background-image:' + cellStripes + ';background-size:' + skeletonW + 'px ' + skeletonH + 'px;background-repeat:no-repeat;background-attachment:local;background-origin:content-box;background-clip:content-box;';
        panel.appendChild(viewport);

        grid = document.createElement('div');
        grid.className = THUMB_CLASS;
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(' + cols + ',' + w + 'px);grid-auto-rows:' + h + 'px;gap:' + gap + 'px;width:' + gridWidth + 'px;max-width:none;box-sizing:border-box;';
        viewport.appendChild(grid);
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

      var threadState = ATPRenderer.registerThread(allCandidates, resources, grid, statusEl, container, link.href, outerRow, panel, textAttachments, sourceCandidates, heavyPlan, data.hasTextAttachments, data.textAttachmentCount, data.partial, cacheWriteStartedAt, data.textResourcesComplete, data.textResourcesAttemptedCount, data.textResourcesUnresolvedCount, data.textResourcesRetryableCount);
      queueAutomaticTextResourceLoad(threadState);
      if (window.ATPResourcePanel) {
        ATPResourcePanel.attachThread(panel, threadState);
      }
    },

    registerThread: function(allCandidates, resources, grid, statusEl, container, linkUrl, outerRow, panel, textAttachments, sourceCandidates, heavyPlan, hasTextAttachments, textAttachmentCount, partial, cacheWriteStartedAt, textResourcesComplete, textResourcesAttemptedCount, textResourcesUnresolvedCount, textResourcesRetryableCount) {
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
      var normalizedResources = SharedUtils.normalizeResources(resources);
      var hasCachedTextResources = textResourcesComplete === true;
      var threadState = {
        id: threadId,
        registeredInState: true,
        generation: generation,
        candidates: allCandidates,
        sourceCandidates: sourceCandidates || allCandidates,
        heavyMode: !!(heavyPlan && heavyPlan.enabled),
        lightweightHeavyMode: lightweightHeavyMode,
        heavyOriginalTotal: sourceCandidates ? sourceCandidates.length : allCandidates.length,
        nextIdx: 0,
        loaded: 0,
        failedCount: 0,
        loadedUrls: [],
        loadedUrlMap: {},
        firstScreenTotal: firstScreenTotal,
        firstScreenOk: 0,
        firstScreenFailed: 0,
        firstScreenDone: false,
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

      if (typeof Logger !== 'undefined' && Logger.event && (!Logger.isEnabled || Logger.isEnabled('DEBUG'))) {
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
          hostMix: summarizeImageHosts(threadState.sourceCandidates),
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

      if (!threadState.firstScreenTotal) {
        container.classList.add(CONTAINER_CLASS);
        ATPCache.setCachedArticleData(linkUrl, {
          images: threadState.sourceCandidates || [],
          resources: threadState.resources,
          textAttachments: threadState.textAttachments,
          hasTextAttachments: threadState.hasTextAttachments,
          textAttachmentCount: threadState.textAttachmentCount,
          textResourcesComplete: threadState.textResourcesDone && !threadState.textResourcesRetryable,
          textResourcesAttemptedCount: threadState.textResourcesAttemptedCount,
          textResourcesUnresolvedCount: threadState.textResourcesUnresolvedCount,
          textResourcesRetryableCount: threadState.textResourcesRetryableCount,
          partial: threadState.partial
        }, !threadState.partial, threadState.cacheWriteStartedAt);
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
        if (!threadState.candidates.length && threadState.statusEl) threadState.statusEl.textContent = '无资源';
        if (window.ATPResourcePanel) {
          ATPResourcePanel.updateThread(threadState);
        }
        Logger.debug(message, threadState.link + ' ' + (e && e.message ? e.message : e || 'unknown error'));
      };

      var hasCachedAttachments = threadState.textAttachments && threadState.textAttachments.length;
      var doFetch = function(attachments) {
        if (!isRunCurrent()) {
          releaseAutomaticTextResourceSlot(threadState, run);
          return;
        }
        var fetchPromise;
        try {
          fetchPromise = ATPFetcher.fetchTextAttachmentResourcesWithStatus
            ? ATPFetcher.fetchTextAttachmentResourcesWithStatus(attachments, { manualRetry: !!manualRetry })
            : ATPFetcher.fetchTextAttachmentResources(attachments, { manualRetry: !!manualRetry });
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
          threadState.textResourcesLoading = false;
          var textStatus = normalizeTextResourceLoadResult(result, attachments.length);
          var resources = textStatus.resources;
          var hasFetchedResources = SharedUtils.hasResourcePayload(resources);
          threadState.textResourcesDone = hasFetchedResources && textStatus.unresolvedCount === 0;
          threadState.textResourcesRetryable = textStatus.retryableCount > 0 || !hasFetchedResources;
          threadState.textResourcesAttemptedCount = textStatus.attemptedCount;
          threadState.textResourcesUnresolvedCount = textStatus.unresolvedCount;
          threadState.textResourcesRetryableCount = textStatus.retryableCount;
          threadState.resources = SharedUtils.mergeResources(threadState.resources, resources);
          if (textStatus.unresolvedCount > 0 && hasFetchedResources) {
            threadState.textResourceMessage = '已解析部分 TXT 资源，仍有 ' + textStatus.unresolvedCount + ' 个附件待重试';
          } else {
            threadState.textResourceMessage = hasFetchedResources
              ? ''
              : '识别到 TXT 附件 ' + attachments.length + ' 个，但未解析到资源链接';
          }
          releaseAutomaticTextResourceSlot(threadState, run);

          if (!threadState.candidates.length && threadState.statusEl) {
            threadState.statusEl.textContent = SharedUtils.hasResourcePayload(threadState.resources) ? '资源链接' : '无资源';
          }

          if (window.ATPResourcePanel) {
            ATPResourcePanel.updateThread(threadState);
          }

          var imageDone = !threadState.candidates.length || (threadState.nextIdx >= threadState.candidates.length && threadState.loaded + threadState.failedCount >= threadState.candidates.length);
          // 写回缓存前过滤临时 TXT 附件 URL，避免不稳定入口长期缓存
          var cachedAttachments = [];
          var hasTransientUrl = false;
          for (var ta = 0; ta < threadState.textAttachments.length; ta++) {
            if (SharedUtils.isTransientTextAttachmentUrl(threadState.textAttachments[ta].url, threadState.link)) {
              hasTransientUrl = true;
            } else {
              cachedAttachments.push(threadState.textAttachments[ta]);
            }
          }
          ATPCache.setCachedArticleData(threadState.link, {
            images: threadState.sourceCandidates || threadState.candidates || [],
            resources: threadState.resources,
            textAttachments: cachedAttachments,
            loadedUrls: threadState.loadedUrls || [],
            hasTextAttachments: hasTransientUrl || !!cachedAttachments.length,
            textAttachmentCount: threadState.textAttachmentCount || threadState.textAttachments.length,
            textResourcesComplete: threadState.textResourcesDone && !threadState.textResourcesRetryable,
            textResourcesAttemptedCount: threadState.textResourcesAttemptedCount,
            textResourcesUnresolvedCount: threadState.textResourcesUnresolvedCount,
            textResourcesRetryableCount: threadState.textResourcesRetryableCount,
            partial: threadState.partial
          }, imageDone && !threadState.partial, writeStartedAt);
          Logger.debug('TXT资源补齐', threadState.link + ' 资源' + SharedUtils.countResources(threadState.resources));
        }, function(e) {
          failTextResourceLoad('TXT 资源解析失败', e);
        }).catch(function(e) {
          failTextResourceLoad('TXT 资源解析失败', e);
        });
      };

      var fallbackToCachedAttachmentsAfterFreshFailure = function(message, e) {
        if (hasCachedAttachments && isRunCurrent()) {
          threadState.textResourceMessage = 'TXT 附件重新提取失败，解析已缓存附件';
          if (window.ATPResourcePanel) {
            ATPResourcePanel.updateThread(threadState);
          }
          Logger.debug(message + '，改用已缓存TXT附件', threadState.link + ' ' + (e && e.message ? e.message : e || 'unknown error'));
          doFetch(threadState.textAttachments);
          return;
        }
        failTextResourceLoad(message, e);
      };

      var needsFreshExtraction = !!(
        threadState.hasTextAttachments &&
        Number(threadState.textAttachmentCount || 0) > (hasCachedAttachments ? threadState.textAttachments.length : 0)
      );
      if (hasCachedAttachments && !needsFreshExtraction) {
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
        try {
          freshPromise = ATPFetcher.fetchTextAttachmentsFresh(threadState.link);
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
          var attachments = mergeTextAttachments(threadState.textAttachments, freshAttachments, threadState.link);
          threadState.textAttachments = attachments;
          threadState.hasTextAttachments = false;
          threadState.textAttachmentCount = Math.max(Number(threadState.textAttachmentCount || 0) || 0, attachments.length);
          if (!attachments.length) {
            threadState.textResourcesLoading = false;
            threadState.textResourcesDone = false;
            threadState.textResourcesRetryable = true;
            threadState.textResourceMessage = '未能自动读取 TXT 附件，请手动重试或导入已下载 TXT';
            releaseAutomaticTextResourceSlot(threadState, run);
            if (window.ATPResourcePanel) {
              ATPResourcePanel.updateThread(threadState);
            }
            return;
          }
          doFetch(attachments);
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
        usable.push({ name: String(imports[i].name || ''), resources: normalized });
        merged = SharedUtils.mergeResources(merged, normalized);
      }
      if (!SharedUtils.hasResourcePayload(merged)) return false;

      var writeStartedAt = Date.now();
      var expectedImportCount = Math.max(
        1,
        Number(threadState.textAttachmentCount || 0) || 0,
        (threadState.textAttachments && threadState.textAttachments.length) || 0
      );
      var importUnresolvedCount = Math.max(0, expectedImportCount - usable.length);
      threadState.textResourcesRunId = Math.max(0, Number(threadState.textResourcesRunId || 0) || 0) + 1;
      threadState.textResourcesRun = null;
      threadState.textResourcesAutoQueued = false;
      threadState.textResourcesAutoActive = false;
      threadState.resources = SharedUtils.mergeResources(threadState.resources, merged);
      threadState.textResourcesLoading = false;
      threadState.textResourcesImporting = false;
      threadState.textResourcesDone = importUnresolvedCount === 0;
      threadState.textResourcesRetryable = importUnresolvedCount > 0;
      threadState.textResourcesAttemptedCount = usable.length;
      threadState.textResourcesUnresolvedCount = importUnresolvedCount;
      threadState.textResourcesRetryableCount = importUnresolvedCount;
      threadState.textResourceMessage = '已从本地 TXT 导入 ' + SharedUtils.countResources(merged) + ' 条资源' + (
        importUnresolvedCount ? '，仍有 ' + importUnresolvedCount + ' 个附件待补齐' : ''
      );
      threadState.textResourcesAutoAttempted = true;
      if (!threadState.candidates.length && threadState.statusEl) threadState.statusEl.textContent = '资源链接';

      function normalizeFileName(name) {
        name = String(name || '').replace(/\\/g, '/');
        var slash = name.lastIndexOf('/');
        if (slash !== -1) name = name.slice(slash + 1);
        return name.trim().toLowerCase();
      }

      var attachments = threadState.textAttachments || [];
      for (var ui = 0; ui < usable.length; ui++) {
        var importName = normalizeFileName(usable[ui].name);
        for (var ai = 0; ai < attachments.length; ai++) {
          var attachment = attachments[ai];
          var namesMatch = importName && importName === normalizeFileName(attachment && attachment.name);
          if (!namesMatch && !(usable.length === 1 && attachments.length === 1)) continue;
          ATPCache.setCachedTextResources(attachment.url, usable[ui].resources, writeStartedAt);
          ATPCache.clearTextFailCache(attachment.url);
        }
      }

      var cachedAttachments = [];
      var hasTransientUrl = false;
      for (var ta = 0; ta < attachments.length; ta++) {
        if (SharedUtils.isTransientTextAttachmentUrl(attachments[ta].url, threadState.link)) hasTransientUrl = true;
        else cachedAttachments.push(attachments[ta]);
      }
      var imageDone = !threadState.candidates.length || (threadState.nextIdx >= threadState.candidates.length && threadState.loaded + threadState.failedCount >= threadState.candidates.length);
      ATPCache.setCachedArticleData(threadState.link, {
        images: threadState.sourceCandidates || threadState.candidates || [],
        resources: threadState.resources,
        textAttachments: cachedAttachments,
        loadedUrls: threadState.loadedUrls || [],
        hasTextAttachments: hasTransientUrl || !!cachedAttachments.length,
        textAttachmentCount: threadState.textAttachmentCount || attachments.length,
        textResourcesComplete: threadState.textResourcesDone,
        textResourcesAttemptedCount: threadState.textResourcesAttemptedCount,
        textResourcesUnresolvedCount: threadState.textResourcesUnresolvedCount,
        textResourcesRetryableCount: threadState.textResourcesRetryableCount,
        partial: threadState.partial
      }, imageDone && !threadState.partial, writeStartedAt);
      if (window.ATPResourcePanel) ATPResourcePanel.updateThread(threadState);
      Logger.debug('本地TXT资源导入', threadState.link + ' 资源' + SharedUtils.countResources(merged));
      return true;
    },

    queueAutomaticTextResourceLoad: queueAutomaticTextResourceLoad,

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
