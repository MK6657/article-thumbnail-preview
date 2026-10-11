(function () {
  'use strict';

  var REQUEST_TYPE = 'ATP_PAGE_TEXT_FETCH_REQUEST_V1';
  var RESPONSE_TYPE = 'ATP_PAGE_TEXT_FETCH_RESPONSE_V1';
  var MAX_BYTES = 512 * 1024;
  var MAX_TIMEOUT_MS = 10000;

  function postResponse(id, payload) {
    var message = Object.assign({
      type: RESPONSE_TYPE,
      id: id
    }, payload || {});
    window.postMessage(message, location.origin);
  }

  function isAllowedAttachmentUrl(rawUrl) {
    try {
      var url = new URL(rawUrl, location.href);
      if (url.protocol !== 'https:' || url.origin !== location.origin) return false;
      if (/\.txt$/i.test(url.pathname)) return true;
      if (/\/attachment\.php$/i.test(url.pathname)) return true;
      if (/\/misc\.php$/i.test(url.pathname) && /(?:^|&)(?:mod|action)=attach(?:ment)?(?:&|$)/i.test(url.search.slice(1))) return true;
      return /\/forum\.php$/i.test(url.pathname) && /(?:^|&)mod=attachment(?:&|$)/i.test(url.search.slice(1));
    } catch (e) {
      return false;
    }
  }

  function getSafeReferrer(rawReferrer) {
    try {
      var referrer = new URL(rawReferrer || location.href, location.href);
      if (referrer.protocol !== 'https:' || referrer.origin !== location.origin) return location.href;
      referrer.search = '';
      referrer.hash = '';
      return referrer.href;
    } catch (e) {
      return location.href;
    }
  }

  async function readResponseLimited(response, maxBytes) {
    var declaredLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (declaredLength > maxBytes) throw new Error('response_too_large');
    if (!response.body || typeof response.body.getReader !== 'function') {
      var fallback = await response.arrayBuffer();
      if (fallback.byteLength > maxBytes) throw new Error('response_too_large');
      return new Uint8Array(fallback);
    }

    var reader = response.body.getReader();
    var chunks = [];
    var total = 0;
    try {
      while (true) {
        var result = await reader.read();
        if (result.done) break;
        var value = result.value || new Uint8Array(0);
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch (e) {}
          throw new Error('response_too_large');
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch (e) {}
    }

    var merged = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      merged.set(chunks[i], offset);
      offset += chunks[i].byteLength;
    }
    return merged;
  }

  function bytesToBase64(bytes) {
    var parts = [];
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      var chars = '';
      for (var j = 0; j < chunk.length; j++) chars += String.fromCharCode(chunk[j]);
      parts.push(chars);
    }
    return btoa(parts.join(''));
  }

  window.addEventListener('message', async function (event) {
    if (event.source !== window || event.origin !== location.origin) return;
    var request = event.data;
    if (!request || request.type !== REQUEST_TYPE || typeof request.id !== 'string') return;
    if (!/^[A-Za-z0-9_-]{8,96}$/.test(request.id)) return;
    if (!isAllowedAttachmentUrl(request.url)) {
      postResponse(request.id, { ok: false, error: 'url_not_allowed' });
      return;
    }

    var maxBytes = Math.max(1, Math.min(MAX_BYTES, Number(request.maxBytes) || MAX_BYTES));
    var timeoutMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(request.timeoutMs) || MAX_TIMEOUT_MS));
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    try {
      var response = await fetch(request.url, {
        signal: controller.signal,
        mode: 'same-origin',
        credentials: 'include',
        headers: { 'Accept': 'text/plain, application/octet-stream;q=0.9, */*;q=0.5' },
        referrer: getSafeReferrer(request.referrer),
        referrerPolicy: 'strict-origin-when-cross-origin'
      });
      if (!isAllowedAttachmentUrl(response.url || request.url)) {
        postResponse(request.id, { ok: false, error: 'redirect_not_allowed', status: response.status });
        return;
      }
      if (!response.ok) {
        postResponse(request.id, { ok: false, error: 'http_' + response.status, status: response.status });
        return;
      }
      var bytes = await readResponseLimited(response, maxBytes);
      postResponse(request.id, {
        ok: true,
        status: response.status,
        finalUrl: response.url || request.url,
        contentType: response.headers.get('content-type') || '',
        base64: bytesToBase64(bytes)
      });
    } catch (e) {
      postResponse(request.id, {
        ok: false,
        error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message ? e.message : 'fetch_failed')
      });
    } finally {
      clearTimeout(timer);
      // Also stop unread bodies on header-size, HTTP, or redirect rejection.
      controller.abort();
    }
  });
})();
