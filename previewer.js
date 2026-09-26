(function () {
  'use strict';

  var previewOverlay = null;
  var previewContainer = null;
  var currentIndex = 0;
  var images = [];
  var isOpen = false;
  var previewLoadToken = 0;
  var previewTimer = null;
  var previousBodyOverflow = null;
  var previousBodyPaddingRight = null;
  var previousFocusedElement = null;
  var previousFocusContext = null;

  function clearPreviewTimer() {
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
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
    options = options || {};
    return {
      opener: options.opener || null,
      threadId: options.threadId || '',
      previewIndex: typeof options.previewIndex === 'number' ? options.previewIndex : startIndex,
      preferOpenerFocus: !!options.preferOpenerFocus
    };
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
    open: function(imgList, startIndex, options) {
      if (!imgList || !imgList.length) return;
      var wasOpen = isOpen;
      images = imgList;
      // An index past the list would show an empty, scroll-locked overlay.
      currentIndex = Math.max(0, Math.min(imgList.length - 1, Math.floor(Number(startIndex) || 0)));
      if (!wasOpen) {
        previousBodyOverflow = document.body.style.overflow;
        previousBodyPaddingRight = document.body.style.paddingRight;
        previousFocusedElement = document.activeElement;
        previousFocusContext = buildPreviewFocusContext(options, currentIndex);
      }
      isOpen = true;

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
      previewOverlay.className = 'atp-preview-overlay';
      previewOverlay.setAttribute('role', 'dialog');
      previewOverlay.setAttribute('aria-modal', 'true');
      previewOverlay.setAttribute('aria-label', '图片预览');
      previewOverlay.setAttribute('tabindex', '-1');
      previewOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;z-index:2147483647;';

      previewContainer = document.createElement('div');
      previewContainer.className = 'atp-preview-container';
      previewContainer.style.cssText = 'width:90vw;max-width:calc(100vw - 16px);height:min(90vh, calc(100vh - 16px));display:flex;flex-direction:column;align-items:stretch;box-sizing:border-box;';
      previewOverlay.appendChild(previewContainer);

      var toolbar = document.createElement('div');
      toolbar.className = 'atp-preview-toolbar';
      toolbar.style.cssText = 'width:100%;box-sizing:border-box;padding:10px;display:flex;justify-content:space-between;align-items:center;gap:12px;color:#fff;font-size:14px;flex:0 0 auto;';
      previewContainer.appendChild(toolbar);

      var counter = document.createElement('span');
      counter.className = 'atp-preview-counter';
      counter.id = 'atp-preview-counter';
      counter.setAttribute('aria-live', 'polite');
      toolbar.appendChild(counter);

      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'atp-preview-close';
      closeBtn.textContent = '关闭';
      closeBtn.setAttribute('aria-label', '关闭图片预览');
      closeBtn.style.cssText = 'padding:5px 15px;background:#333;color:#fff;border:none;border-radius:3px;cursor:pointer;';
      closeBtn.onclick = ATPPreviewer.close;
      toolbar.appendChild(closeBtn);

      var imgWrapper = document.createElement('div');
      imgWrapper.className = 'atp-preview-img-wrapper';
      imgWrapper.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;width:100%;flex:1 1 auto;min-height:0;max-height:100%;overflow:hidden;';
      previewContainer.appendChild(imgWrapper);

      var img = document.createElement('img');
      img.className = 'atp-preview-img';
      img.alt = '预览图片';
      img.style.cssText = 'max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;';
      imgWrapper.appendChild(img);

      var prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.textContent = '◀';
      prevBtn.className = 'atp-preview-prev';
      prevBtn.setAttribute('aria-label', '上一张图片');
      prevBtn.style.cssText = 'position:absolute;left:10px;top:50%;transform:translateY(-50%);padding:10px 15px;background:#333;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:18px;';
      prevBtn.onclick = function() { ATPPreviewer.prev(); };
      imgWrapper.appendChild(prevBtn);

      var nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.textContent = '▶';
      nextBtn.className = 'atp-preview-next';
      nextBtn.setAttribute('aria-label', '下一张图片');
      nextBtn.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);padding:10px 15px;background:#333;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:18px;';
      nextBtn.onclick = function() { ATPPreviewer.next(); };
      imgWrapper.appendChild(nextBtn);

      previewOverlay.onclick = function(e) {
        if (e.target === previewOverlay) ATPPreviewer.close();
      };

      document.body.appendChild(previewOverlay);
    },

    showImage: function(index) {
      if (!images[index]) return;
      var token = ++previewLoadToken;
      var img = previewContainer.querySelector('.atp-preview-img');
      var counter = previewContainer.querySelector('.atp-preview-counter');
      var noReferrerRetried = false;

      function isCurrentLoad() {
        return token === previewLoadToken && isOpen;
      }

      function showFailed() {
        if (!isCurrentLoad()) return;
        clearPreviewTimer();
        img.style.display = 'none';
        counter.textContent = '加载失败 (' + (index + 1) + ' / ' + images.length + ')';
      }

      function startTimer() {
        clearPreviewTimer();
        previewTimer = setTimeout(function() {
          if (!isCurrentLoad()) return;
          retryNoReferrerOrFail();
        }, getPreviewTimeout());
      }

      function retryNoReferrerOrFail() {
        if (!isCurrentLoad()) return;
        if (!noReferrerRetried && img.referrerPolicy !== 'no-referrer') {
          noReferrerRetried = true;
          counter.textContent = '重试中 (' + (index + 1) + ' / ' + images.length + ')';
          startTimer();
          setPreviewImageSource(img, images[index], token, true);
          return;
        }
        showFailed();
      }

      img.style.display = 'none';
      img.removeAttribute('src');
      counter.textContent = '加载中 (' + (index + 1) + ' / ' + images.length + ')';
      startTimer();

      img.onerror = function() {
        if (!isCurrentLoad()) return;
        retryNoReferrerOrFail();
      };
      img.onload = function() {
        if (!isCurrentLoad()) return;
        clearPreviewTimer();
        img.style.display = '';
        counter.textContent = (index + 1) + ' / ' + images.length;
      };
      setPreviewImageSource(img, images[index], token, false);

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
      previewLoadToken++;
      clearPreviewTimer();
      if (previewContainer) {
        var img = previewContainer.querySelector('.atp-preview-img');
        if (img) img.removeAttribute('src');
      }
      images = [];
      currentIndex = 0;
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
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); }
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
