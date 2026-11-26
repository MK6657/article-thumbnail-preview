(function () {
  'use strict';

  var previewOverlay = null;
  var previewContainer = null;
  var currentIndex = 0;
  var images = [];
  var previewThumbSrcs = [];
  var currentThreadId = '';
  var isOpen = false;
  var previewLoadToken = 0;
  var previewTimer = null;
  var previousBodyOverflow = null;
  var previousBodyPaddingRight = null;
  var previousFocusedElement = null;
  var previousFocusContext = null;
  var zoomScale = 1;
  var panX = 0;
  var panY = 0;
  var isDragging = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var dragOriginPanX = 0;
  var dragOriginPanY = 0;
  var suppressNextBackdropClick = false;
  var preloadPool = [];

  var MIN_ZOOM = 1;
  var MAX_ZOOM = 5;

  function clearPreviewTimer() {
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
  }

  function cancelPreviewLoad(img) {
    previewLoadToken++;
    clearPreviewTimer();
    if (!img) return;
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
  }

  function getPreviewTimeout() {
    var settings = window.ATPState && window.ATPState.settings;
    return (settings && settings.imageTimeout) || 15000;
  }

  function setPreviewImageSource(img, src, token, noReferrer) {
    function isCurrentLoad() {
      return token === previewLoadToken && isOpen;
    }
    if (window.ATPLoader && typeof ATPLoader.setImageSource === 'function') {
      ATPLoader.setImageSource(img, src, !!noReferrer, isCurrentLoad);
      return;
    }
    try {
      var host = new URL(src).hostname;
      if (noReferrer || SharedUtils.isHeavyImageHost(host)) {
        img.referrerPolicy = 'no-referrer';
        img.removeAttribute('src');
        setTimeout(function() {
          if (isCurrentLoad()) img.src = src;
        }, 0);
        return;
      }
    } catch (e) {}
    img.removeAttribute('referrerpolicy');
    if (isCurrentLoad()) img.src = src;
  }

  function focusPreviewCloseButton() {
    // 优先回退到仍可用的翻页键：焦点静默落到「关闭」时，用户下一次回车会误关整个预览层
    var navBtns = previewContainer && previewContainer.querySelectorAll
      ? previewContainer.querySelectorAll('.atp-preview-prev, .atp-preview-next')
      : null;
    for (var i = 0; navBtns && i < navBtns.length; i++) {
      if (!navBtns[i].disabled && navBtns[i].focus) {
        navBtns[i].focus();
        return;
      }
    }
    var closeBtn = previewContainer && previewContainer.querySelector('.atp-preview-close');
    if (closeBtn && closeBtn.focus) {
      closeBtn.focus();
    } else if (previewOverlay && previewOverlay.focus) {
      previewOverlay.focus();
    }
  }

  function keepPreviewFocusValid() {
    if (!isOpen || !previewContainer || !document.activeElement) return;
    var active = document.activeElement;
    if (
      previewContainer.contains(active) &&
      !active.disabled &&
      active.style.visibility !== 'hidden'
    ) {
      return;
    }
    focusPreviewCloseButton();
  }

  function isFocusTargetAvailable(el) {
    if (!el || !el.focus || !document.contains(el)) return false;
    if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hidden || el.getAttribute('hidden') !== null) return false;
    if (el.style && (el.style.visibility === 'hidden' || el.style.display === 'none')) return false;
    if (window.getComputedStyle) {
      var style = window.getComputedStyle(el);
      if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
    }
    if (el.getClientRects && !el.getClientRects().length) return false;
    return true;
  }

  function focusIfAvailable(el) {
    if (!isFocusTargetAvailable(el)) return false;
    try {
      el.focus();
      return document.activeElement === el;
    } catch (e) {
      return false;
    }
  }

  function findThreadFocusTarget(context) {
    if (!context || !context.threadId) return null;
    var threads = window.ATPState && window.ATPState.threads;
    var ts = threads && threads[context.threadId];
    var grid = ts && ts.grid;
    if (grid && grid.querySelectorAll) {
      var wrappers = grid.querySelectorAll('.atp-thumbnail-wrapper');
      var firstAvailable = null;
      for (var i = 0; i < wrappers.length; i++) {
        var wrapper = wrappers[i];
        if (!isFocusTargetAvailable(wrapper)) continue;
        if (!firstAvailable && wrapper.getAttribute('role') === 'button') firstAvailable = wrapper;
        if (
          typeof context.previewIndex === 'number' &&
          wrapper.getAttribute('data-atp-preview-index') === String(context.previewIndex)
        ) {
          return wrapper;
        }
      }
      if (firstAvailable) return firstAvailable;
    }
    var trigger = ts && ts.panel && ts.panel.querySelector ? ts.panel.querySelector('[data-resource-trigger]') : null;
    if (isFocusTargetAvailable(trigger)) return trigger;
    return ts && isFocusTargetAvailable(ts.panel) ? ts.panel : null;
  }

  function findPreviewFocusFallback(context) {
    if (!context) return null;
    if (isFocusTargetAvailable(context.opener)) return context.opener;
    return findThreadFocusTarget(context);
  }

  function buildPreviewFocusContext(options, startIndex) {
    if (options && options.nodeType === 1) {
      return {
        opener: options,
        threadId: '',
        previewIndex: startIndex,
        preferOpenerFocus: false
      };
    }
    options = options || {};
    return {
      opener: options.opener || null,
      threadId: options.threadId || '',
      previewIndex: typeof options.previewIndex === 'number' ? options.previewIndex : startIndex,
      preferOpenerFocus: !!options.preferOpenerFocus
    };
  }

  function resolveThumbnailSrc(index) {
    if (previewThumbSrcs && previewThumbSrcs[index]) return previewThumbSrcs[index];
    if (!currentThreadId) return '';
    var threads = window.ATPState && window.ATPState.threads;
    var ts = threads && threads[currentThreadId];
    var grid = ts && ts.grid;
    if (!grid || !grid.querySelectorAll) return '';
    var wrappers = grid.querySelectorAll('.atp-thumbnail-wrapper');
    for (var i = 0; i < wrappers.length; i++) {
      var wrapper = wrappers[i];
      var match = wrapper.getAttribute && wrapper.getAttribute('data-atp-preview-index') === String(index);
      if (!match && wrapper.__atpLoadTask && wrapper.__atpLoadTask.idx === index) match = true;
      if (!match) continue;
      var thumbImg = wrapper.querySelector && wrapper.querySelector('.atp-thumbnail-img');
      if (thumbImg && (thumbImg.currentSrc || thumbImg.src)) return thumbImg.currentSrc || thumbImg.src;
    }
    return '';
  }

  function cancelAdjacentPreloads() {
    for (var i = 0; i < preloadPool.length; i++) {
      try {
        preloadPool[i].onload = null;
        preloadPool[i].onerror = null;
        preloadPool[i].src = '';
      } catch (e) {}
    }
    preloadPool.length = 0;
  }

  function preloadAdjacentImages(index) {
    cancelAdjacentPreloads();
    if (typeof Image !== 'function' || !isOpen) return;
    var targets = [];
    if (index + 1 < images.length && images[index + 1]) targets.push(images[index + 1]);
    if (index - 1 >= 0 && images[index - 1] && images[index - 1] !== images[index + 1]) targets.push(images[index - 1]);
    for (var i = 0; i < targets.length; i++) {
      try {
        var pre = new Image();
        pre.decoding = 'async';
        try {
          var host = new URL(targets[i]).hostname;
          if (window.SharedUtils && SharedUtils.isHeavyImageHost && SharedUtils.isHeavyImageHost(host)) {
            pre.referrerPolicy = 'no-referrer';
          }
        } catch (e) {}
        pre.src = targets[i];
        preloadPool.push(pre);
      } catch (e) {}
    }
  }

  function applyZoomState() {
    if (!previewContainer) return;
    var imgWrapper = previewContainer.querySelector('.atp-preview-img-wrapper');
    var img = imgWrapper && imgWrapper.querySelector('.atp-preview-img');
    var thumb = imgWrapper && imgWrapper.querySelector('.atp-lightbox-thumb-placeholder');
    var zoomBtn = previewContainer.querySelector('.atp-lightbox-zoom-reset');
    if (zoomScale <= 1.02) {
      zoomScale = 1;
      panX = 0;
      panY = 0;
    }
    if (zoomBtn) {
      zoomBtn.textContent = Math.round(zoomScale * 100) + '%';
    }
    if (imgWrapper && imgWrapper.classList) {
      imgWrapper.classList.toggle('atp-lightbox-zoomed', zoomScale > 1);
      imgWrapper.classList.toggle('atp-lightbox-dragging', isDragging);
    }
    var transformValue = zoomScale > 1
      ? 'translate3d(' + Math.round(panX) + 'px, ' + Math.round(panY) + 'px, 0) scale(' + zoomScale.toFixed(3) + ')'
      : '';
    if (img && img.style) img.style.transform = transformValue;
    if (thumb && thumb.style) thumb.style.transform = transformValue;
  }

  function resetZoomState() {
    zoomScale = 1;
    panX = 0;
    panY = 0;
    isDragging = false;
    applyZoomState();
  }

  function zoomToScale(nextScale, clientX, clientY) {
    var clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextScale));
    if (clamped <= 1.03) clamped = 1;
    if (clamped === zoomScale) return;
    var imgWrapper = previewContainer && previewContainer.querySelector('.atp-preview-img-wrapper');
    if (clamped === 1) {
      zoomScale = 1;
      panX = 0;
      panY = 0;
    } else if (imgWrapper && typeof imgWrapper.getBoundingClientRect === 'function' &&
               typeof clientX === 'number' && typeof clientY === 'number') {
      var rect = imgWrapper.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var ox = clientX - cx;
      var oy = clientY - cy;
      var ratio = clamped / zoomScale;
      panX = ox - (ox - panX) * ratio;
      panY = oy - (oy - panY) * ratio;
      zoomScale = clamped;
    } else {
      var centerRatio = clamped / zoomScale;
      panX *= centerRatio;
      panY *= centerRatio;
      zoomScale = clamped;
    }
    applyZoomState();
  }

  function restorePreviousFocus() {
    var el = previousFocusedElement;
    previousFocusedElement = null;
    var context = previousFocusContext;
    previousFocusContext = null;
    var fallback = findPreviewFocusFallback(context);
    if (context && context.preferOpenerFocus && focusIfAvailable(fallback)) return true;
    if (focusIfAvailable(el)) return true;
    return focusIfAvailable(fallback);
  }

  function releaseHiddenPreviewFocus() {
    var active = document.activeElement;
    if (!previewOverlay || !active || !previewOverlay.contains(active)) return;
    if (active.blur) {
      try { active.blur(); } catch (e) {}
    }
  }

  function trapPreviewTab(e) {
    if (!previewContainer || !previewContainer.querySelectorAll) return false;
    var controls = previewContainer.querySelectorAll('button:not([disabled])');
    if (!controls.length) {
      e.preventDefault();
      if (previewOverlay && previewOverlay.focus) previewOverlay.focus();
      return true;
    }
    var first = controls[0];
    var last = controls[controls.length - 1];
    if (!previewContainer.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
    return true;
  }

  var ATPPreviewer = {
    open: function(imgList, startIndex, options, previewSrcs) {
      if (!imgList || !imgList.length) return;
      var wasOpen = isOpen;
      images = imgList;
      previewThumbSrcs = Array.isArray(previewSrcs)
        ? previewSrcs
        : (options && Array.isArray(options.previewSrcs) ? options.previewSrcs : []);
      currentThreadId = (options && typeof options === 'object' && options.threadId) ? String(options.threadId) : '';
      // An index past the list would show an empty, scroll-locked overlay.
      currentIndex = Math.max(0, Math.min(imgList.length - 1, Math.floor(Number(startIndex) || 0)));
      if (!wasOpen) {
        previousBodyOverflow = document.body.style.overflow;
        previousBodyPaddingRight = document.body.style.paddingRight;
        previousFocusedElement = document.activeElement;
        previousFocusContext = buildPreviewFocusContext(options, currentIndex);
      }
      isOpen = true;
      suppressNextBackdropClick = false;

      if (!previewOverlay) {
        ATPPreviewer.createOverlay();
      }

      if (!ATPPreviewer._keyListenerBound) {
        document.addEventListener('keydown', ATPPreviewer.handleKeydown);
        ATPPreviewer._keyListenerBound = true;
      }

      ATPPreviewer.showImage(currentIndex);
      previewOverlay.style.display = 'flex';
      if (!wasOpen) {
        // 隐藏滚动条会让视口变宽、整页重排位移一次：用等宽 padding 补偿
        var scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
        if (scrollbarWidth > 0) {
          var currentPadding = parseFloat(getComputedStyle(document.body).paddingRight) || 0;
          document.body.style.paddingRight = (currentPadding + scrollbarWidth) + 'px';
        }
      }
      document.body.style.overflow = 'hidden';
      focusPreviewCloseButton();
    },

    createOverlay: function() {
      previewOverlay = document.createElement('div');
      previewOverlay.className = 'atp-preview-overlay atp-lightbox-overlay';
      previewOverlay.setAttribute('role', 'dialog');
      previewOverlay.setAttribute('aria-modal', 'true');
      previewOverlay.setAttribute('aria-label', '图片预览');
      previewOverlay.setAttribute('tabindex', '-1');
      previewOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;z-index:2147483647;';

      previewContainer = document.createElement('div');
      previewContainer.className = 'atp-preview-container atp-lightbox-container';
      previewContainer.style.cssText = 'width:90vw;max-width:calc(100vw - 16px);height:min(90vh, calc(100vh - 16px));display:flex;flex-direction:column;align-items:stretch;box-sizing:border-box;';
      previewOverlay.appendChild(previewContainer);

      var toolbar = document.createElement('div');
      toolbar.className = 'atp-preview-toolbar atp-lightbox-hud';
      toolbar.style.cssText = 'width:100%;box-sizing:border-box;display:flex;justify-content:space-between;align-items:center;gap:12px;flex:0 0 auto;';
      previewContainer.appendChild(toolbar);

      var counter = document.createElement('span');
      counter.className = 'atp-preview-counter atp-lightbox-counter';
      counter.id = 'atp-preview-counter';
      counter.setAttribute('aria-live', 'polite');
      toolbar.appendChild(counter);

      var controls = document.createElement('div');
      controls.className = 'atp-lightbox-controls';
      toolbar.appendChild(controls);

      var zoomOutBtn = document.createElement('button');
      zoomOutBtn.type = 'button';
      zoomOutBtn.className = 'atp-lightbox-btn atp-lightbox-zoom-out';
      zoomOutBtn.textContent = '−';
      zoomOutBtn.setAttribute('aria-label', '缩小图片');
      zoomOutBtn.title = '缩小 (-)';
      zoomOutBtn.onclick = function(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        zoomToScale(zoomScale / 1.25);
      };
      controls.appendChild(zoomOutBtn);

      var zoomResetBtn = document.createElement('button');
      zoomResetBtn.type = 'button';
      zoomResetBtn.className = 'atp-lightbox-btn atp-lightbox-zoom-reset';
      zoomResetBtn.textContent = '100%';
      zoomResetBtn.setAttribute('aria-label', '适应窗口或原始比例切换');
      zoomResetBtn.title = '点击切换 100% / 200%（快捷键 0 重置）';
      zoomResetBtn.onclick = function(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        if (zoomScale > 1) resetZoomState();
        else zoomToScale(2);
      };
      controls.appendChild(zoomResetBtn);

      var zoomInBtn = document.createElement('button');
      zoomInBtn.type = 'button';
      zoomInBtn.className = 'atp-lightbox-btn atp-lightbox-zoom-in';
      zoomInBtn.textContent = '+';
      zoomInBtn.setAttribute('aria-label', '放大图片');
      zoomInBtn.title = '放大 (+)';
      zoomInBtn.onclick = function(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        zoomToScale(zoomScale * 1.25);
      };
      controls.appendChild(zoomInBtn);

      var openOrigBtn = document.createElement('button');
      openOrigBtn.type = 'button';
      openOrigBtn.className = 'atp-lightbox-btn atp-lightbox-open-original';
      openOrigBtn.textContent = '新标签页打开原图';
      openOrigBtn.setAttribute('aria-label', '新标签页打开原图');
      openOrigBtn.onclick = function(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        var targetUrl = images[currentIndex] || '';
        if (/^https?:\/\//i.test(targetUrl) && typeof window.open === 'function') {
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
        }
      };
      controls.appendChild(openOrigBtn);

      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'atp-preview-close atp-lightbox-btn atp-lightbox-close';
      closeBtn.textContent = '关闭';
      closeBtn.setAttribute('aria-label', '关闭图片预览');
      closeBtn.onclick = ATPPreviewer.close;
      controls.appendChild(closeBtn);

      var imgWrapper = document.createElement('div');
      imgWrapper.className = 'atp-preview-img-wrapper atp-lightbox-stage';
      imgWrapper.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;width:100%;flex:1 1 auto;min-height:0;max-height:100%;overflow:hidden;';
      previewContainer.appendChild(imgWrapper);

      var thumbPlaceholder = document.createElement('img');
      thumbPlaceholder.className = 'atp-lightbox-thumb-placeholder';
      thumbPlaceholder.alt = '';
      thumbPlaceholder.setAttribute('aria-hidden', 'true');
      thumbPlaceholder.style.cssText = 'position:absolute;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:none;pointer-events:none;';
      imgWrapper.appendChild(thumbPlaceholder);

      var retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'atp-preview-retry atp-lightbox-btn atp-lightbox-retry';
      retryBtn.textContent = '重新加载图片';
      retryBtn.disabled = retryBtn.hidden = true;
      retryBtn.onclick = function(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        if (retryBtn.getAttribute('aria-disabled') === 'true') return;
        ATPPreviewer.showImage(currentIndex, true);
      };
      imgWrapper.appendChild(retryBtn);

      var prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.textContent = '◀';
      prevBtn.className = 'atp-preview-prev atp-lightbox-nav atp-lightbox-prev';
      prevBtn.setAttribute('aria-label', '上一张图片');
      prevBtn.onclick = function(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        ATPPreviewer.prev();
      };
      imgWrapper.appendChild(prevBtn);

      var nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.textContent = '▶';
      nextBtn.className = 'atp-preview-next atp-lightbox-nav atp-lightbox-next';
      nextBtn.setAttribute('aria-label', '下一张图片');
      nextBtn.onclick = function(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        ATPPreviewer.next();
      };
      imgWrapper.appendChild(nextBtn);

      if (typeof imgWrapper.addEventListener === 'function') {
        imgWrapper.addEventListener('wheel', function(e) {
          if (!isOpen) return;
          e.preventDefault();
          var factor = e.deltaY < 0 ? 1.18 : (1 / 1.18);
          zoomToScale(zoomScale * factor, e.clientX, e.clientY);
        }, { passive: false });

        imgWrapper.addEventListener('dblclick', function(e) {
          var t = e && e.target;
          if (t && t.tagName === 'BUTTON') return;
          if (e && e.preventDefault) e.preventDefault();
          if (zoomScale > 1) resetZoomState();
          else zoomToScale(2, e && e.clientX, e && e.clientY);
        });

        imgWrapper.addEventListener('pointerdown', function(e) {
          if (zoomScale <= 1 || e.button !== 0) return;
          if (e.target && e.target.tagName === 'BUTTON') return;
          isDragging = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          dragOriginPanX = panX;
          dragOriginPanY = panY;
          if (imgWrapper.setPointerCapture && typeof e.pointerId === 'number') {
            try { imgWrapper.setPointerCapture(e.pointerId); } catch (err) {}
          }
          if (e.preventDefault) e.preventDefault();
          applyZoomState();
        });

        imgWrapper.addEventListener('pointermove', function(e) {
          if (!isDragging) return;
          var dx = e.clientX - dragStartX;
          var dy = e.clientY - dragStartY;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
            suppressNextBackdropClick = true;
          }
          panX = dragOriginPanX + dx;
          panY = dragOriginPanY + dy;
          applyZoomState();
        });

        var endPointerDrag = function(e) {
          if (!isDragging) return;
          isDragging = false;
          if (imgWrapper.releasePointerCapture && e && typeof e.pointerId === 'number') {
            try { imgWrapper.releasePointerCapture(e.pointerId); } catch (err) {}
          }
          applyZoomState();
        };
        imgWrapper.addEventListener('pointerup', endPointerDrag);
        imgWrapper.addEventListener('pointercancel', endPointerDrag);
      }

      previewOverlay.onclick = function(e) {
        if (suppressNextBackdropClick) {
          suppressNextBackdropClick = false;
          return;
        }
        var target = e && e.target;
        if (!target) return;
        if (
          target === previewOverlay ||
          target === previewContainer ||
          target === imgWrapper ||
          target === toolbar
        ) {
          ATPPreviewer.close();
        }
      };

      document.body.appendChild(previewOverlay);
    },

    showImage: function(index, retrying) {
      if (!images[index]) return;
      var imgWrapper = previewContainer.querySelector('.atp-preview-img-wrapper');
      var counter = previewContainer.querySelector('.atp-preview-counter');
      var retryBtn = previewContainer.querySelector('.atp-preview-retry');
      var thumbPlaceholder = imgWrapper && imgWrapper.querySelector('.atp-lightbox-thumb-placeholder');
      resetZoomState();
      retryBtn.disabled = retryBtn.hidden = !retrying;
      if (retrying) {
        retryBtn.setAttribute('aria-disabled', 'true');
        retryBtn.textContent = '重新加载中…';
      } else {
        retryBtn.removeAttribute('aria-disabled');
      }
      var position = (index + 1) + ' / ' + images.length;
      var thumbSrc = resolveThumbnailSrc(index);
      if (thumbPlaceholder) {
        if (thumbSrc && thumbSrc !== images[index]) {
          thumbPlaceholder.src = thumbSrc;
          thumbPlaceholder.style.display = '';
        } else {
          thumbPlaceholder.style.display = 'none';
          thumbPlaceholder.removeAttribute('src');
        }
      }

      function startAttempt(noReferrer) {
        var previous = imgWrapper.querySelector('.atp-preview-img');
        cancelPreviewLoad(previous);
        if (previous) previous.remove();
        var token = previewLoadToken;
        var img = document.createElement('img');
        img.className = 'atp-preview-img atp-lightbox-img';
        img.alt = '预览图片';
        img.decoding = 'async';
        img.style.cssText = 'max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;';
        img.style.display = 'none';
        imgWrapper.appendChild(img);
        counter.textContent = (retrying || noReferrer ? '重试中 (' : '加载中 (') + position + ')';

        function retryNoReferrerOrFail() {
          if (token !== previewLoadToken || !isOpen) return;
          if (!noReferrer && img.referrerPolicy !== 'no-referrer') {
            startAttempt(true);
            return;
          }
          cancelPreviewLoad(img);
          if (thumbPlaceholder) {
            thumbPlaceholder.style.display = 'none';
            thumbPlaceholder.removeAttribute('src');
          }
          counter.textContent = '加载失败 (' + position + ')';
          retryBtn.textContent = '重新加载图片';
          retryBtn.removeAttribute('aria-disabled');
          retryBtn.disabled = retryBtn.hidden = false;
        }

        function revealLoadedImage() {
          if (token !== previewLoadToken || !isOpen) return;
          previewLoadToken++;
          clearPreviewTimer();
          img.onload = img.onerror = null;
          img.style.display = '';
          if (img.classList) img.classList.add('atp-lightbox-img-ready');
          if (thumbPlaceholder) {
            thumbPlaceholder.style.display = 'none';
            thumbPlaceholder.removeAttribute('src');
          }
          applyZoomState();
          counter.textContent = position;
          if (document.activeElement === retryBtn && previewOverlay && previewOverlay.focus) previewOverlay.focus();
          retryBtn.disabled = retryBtn.hidden = true;
          preloadAdjacentImages(index);
        }

        img.onerror = retryNoReferrerOrFail;
        img.onload = function() {
          if (token !== previewLoadToken || !isOpen) return;
          clearPreviewTimer();
          if (typeof img.decode === 'function') {
            Promise.resolve(img.decode()).catch(function() {}).then(revealLoadedImage);
          } else {
            revealLoadedImage();
          }
        };
        previewTimer = setTimeout(retryNoReferrerOrFail, getPreviewTimeout());
        setPreviewImageSource(img, images[index], token, noReferrer);
      }
      startAttempt(false);

      var prevBtn = previewContainer.querySelector('.atp-preview-prev');
      var nextBtn = previewContainer.querySelector('.atp-preview-next');
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === images.length - 1;
      prevBtn.style.visibility = prevBtn.disabled ? 'hidden' : 'visible';
      nextBtn.style.visibility = nextBtn.disabled ? 'hidden' : 'visible';
      keepPreviewFocusValid();
    },

    prev: function() {
      if (currentIndex > 0) {
        currentIndex--;
        ATPPreviewer.showImage(currentIndex);
      }
    },

    next: function() {
      if (currentIndex < images.length - 1) {
        currentIndex++;
        ATPPreviewer.showImage(currentIndex);
      }
    },

    close: function() {
      var shouldRestoreOverflow = isOpen || previousBodyOverflow !== null;
      if (previewOverlay) {
        previewOverlay.style.display = 'none';
      }
      if (shouldRestoreOverflow && previousBodyOverflow !== null) {
        document.body.style.overflow = previousBodyOverflow;
        previousBodyOverflow = null;
      } else if (shouldRestoreOverflow) {
        document.body.style.overflow = '';
      }
      if (previousBodyPaddingRight !== null) {
        document.body.style.paddingRight = previousBodyPaddingRight;
        previousBodyPaddingRight = null;
      }
      isOpen = false;
      isDragging = false;
      suppressNextBackdropClick = false;
      cancelAdjacentPreloads();
      cancelPreviewLoad(previewContainer && previewContainer.querySelector('.atp-preview-img'));
      var thumbPlaceholder = previewContainer && previewContainer.querySelector('.atp-lightbox-thumb-placeholder');
      if (thumbPlaceholder) {
        thumbPlaceholder.style.display = 'none';
        thumbPlaceholder.removeAttribute('src');
      }
      images = [];
      previewThumbSrcs = [];
      currentThreadId = '';
      currentIndex = 0;
      zoomScale = 1;
      panX = 0;
      panY = 0;
      if (ATPPreviewer._keyListenerBound) {
        document.removeEventListener('keydown', ATPPreviewer.handleKeydown);
        ATPPreviewer._keyListenerBound = false;
      }
      if (!restorePreviousFocus()) releaseHiddenPreviewFocus();
    },

    handleKeydown: function(e) {
      if (!isOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ATPPreviewer.close(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); ATPPreviewer.prev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); ATPPreviewer.next(); }
      else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (zoomScale > 1) { panY += 60; applyZoomState(); }
      }
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        if (zoomScale > 1) { panY -= 60; applyZoomState(); }
      }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); e.stopPropagation(); zoomToScale(zoomScale * 1.25); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); e.stopPropagation(); zoomToScale(zoomScale / 1.25); }
      else if (e.key === '0') { e.preventDefault(); e.stopPropagation(); resetZoomState(); }
      else if (e.key === 'Tab' && trapPreviewTab(e)) { e.stopPropagation(); }
    },

    isOpen: function() { return isOpen; },

    destroy: function() {
      ATPPreviewer.close();
      document.removeEventListener('keydown', ATPPreviewer.handleKeydown);
      ATPPreviewer._keyListenerBound = false;
      if (previewOverlay) {
        previewOverlay.remove();
        previewOverlay = null;
        previewContainer = null;
      }
    }
  };

  window.ATPPreviewer = ATPPreviewer;
})();
