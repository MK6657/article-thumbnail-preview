const SharedUtils = {
  TEXT_ATTACHMENT_MAX_COUNT: 3,
  TEXT_ATTACHMENT_MAX_BYTES: 512 * 1024,
  TEXT_ATTACHMENT_TIMEOUT: 10000,
  ARTICLE_HTML_MAX_BYTES: 2 * 1024 * 1024,
  ARTICLE_HTML_MAX_CHARS: 1000000,
  DOM_IMAGE_EXTRACT_HTML_MAX_CHARS: 300000,
  BG_FETCH_MAX_URLS: 60,
  BG_FETCH_MAX_TEXT_ATTACHMENTS: 30,
  BG_FETCH_CHUNK_SIZE: 3,
  BG_FETCH_TIMEOUT_MS: 15000,
  BG_FETCH_TIMEOUT_BUFFER_MS: 3000,
  CONTENT_LOG_INDEX_KEY: 'atp_logs_content_keys',
  MAX_CONTENT_LOG_KEYS: 20,
  CONTENT_LOG_TOTAL_BYTES: 2 * 1024 * 1024,
  CONTENT_LOG_KEY_BYTES: 160 * 1024,
  BACKGROUND_LOG_BYTES: 512 * 1024,
  MESSAGE_TYPES: Object.freeze({
    CACHE_INDEX_MUTATION: 'CACHE_INDEX_MUTATION',
    SAVE_SETTINGS_PATCH: 'SAVE_SETTINGS_PATCH',
    FETCH_IMAGES: 'FETCH_IMAGES',
    FETCH_TEXT_RESOURCES: 'FETCH_TEXT_RESOURCES',
    FETCH_TEXT_ATTACHMENTS_FRESH: 'FETCH_TEXT_ATTACHMENTS_FRESH'
  }),

  effectiveImageLimit: function(settings) {
    return SharedUtils.effectiveDisplayLimit(settings);
  },

  effectiveFetchLimit: function(settings) {
    settings = settings || {};
    var fetchLimit = settings.maxImagesPerPost || 100;
    return fetchLimit;
  },

  effectiveDisplayLimit: function(settings) {
    settings = settings || {};
    var fetchLimit = SharedUtils.effectiveFetchLimit(settings);
    var displayLimit = settings.maxDisplayPerPost || 100;
    return Math.min(fetchLimit, displayLimit);
  },

  effectiveFallbackLimit: function(settings) {
    settings = settings || {};
    var fetchLimit = SharedUtils.effectiveFetchLimit(settings);
    var displayLimit = SharedUtils.effectiveDisplayLimit(settings);
    if (fetchLimit <= displayLimit) return displayLimit;
    var fallbackExtra = Math.max(5, Math.min(displayLimit, 20));
    return Math.min(fetchLimit, displayLimit + fallbackExtra);
  },

  // 重图主机判定的唯一出处，其他文件不要再复制该正则
  isHeavyImageHost: function(host) {
    return /(^|\.)image\.imx\.to$/i.test(String(host || ''));
  },

  _isHeavyImageUrlCache: null,

  // 重图判定按 URL 反复调用（heavyPlan 每帖两遍 × 每候选一次），memo 化省去重复 new URL
  isHeavyImageUrl: function(url) {
    if (!url) return false;
    var cache = SharedUtils._isHeavyImageUrlCache;
    if (!cache) cache = SharedUtils._isHeavyImageUrlCache = new Map();
    var hit = cache.get(url);
    if (hit !== undefined) return hit;
    var result;
    try {
      result = SharedUtils.isHeavyImageHost(new URL(url).hostname);
    } catch (e) {
      result = false;
    }
    if (cache.size >= 8000) cache.delete(cache.keys().next().value);
    cache.set(url, result);
    return result;
  },

  // chrome.storage 配额按 UTF-8 字节计，.length 是 UTF-16 码元数，中文内容会低估约 3 倍
  utf8ByteLength: function(str) {
    str = String(str == null ? '' : str);
    try {
      if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(str).length;
      }
    } catch (e) {}
    var bytes = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var next = str.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          bytes += 4;
          i++;
          continue;
        }
      }
      bytes += c < 0x80 ? 1 : (c < 0x800 ? 2 : 3);
    }
    return bytes;
  },

  isHeavyImageCandidate: function(imgData) {
    return SharedUtils.isHeavyImageUrl(SharedUtils.getImagePreviewSrc(imgData));
  },

  isHeavyImageCandidateSet: function(candidates, settings) {
    if (!settings || settings.heavyImageOptimization === false) return false;
    candidates = Array.isArray(candidates) ? candidates : [];
    var heavyCount = 0;
    for (var i = 0; i < candidates.length; i++) {
      if (SharedUtils.isHeavyImageCandidate(candidates[i])) heavyCount++;
    }
    return heavyCount >= 3 && heavyCount / candidates.length >= 0.5;
  },

  isHeavyImageCandidatePrefix: function(candidates, settings, limit) {
    if (!settings || settings.heavyImageOptimization === false) return false;
    candidates = Array.isArray(candidates) ? candidates : [];
    var count = Math.min(candidates.length, Math.max(0, Math.floor(Number(limit) || 0)));
    if (!count) return false;
    var heavyCount = 0;
    for (var i = 0; i < count; i++) {
      if (SharedUtils.isHeavyImageCandidate(candidates[i])) heavyCount++;
    }
    return heavyCount >= 3 && heavyCount / count >= 0.5;
  },

  getImagePreviewSrc: function(imgData) {
    if (!imgData) return '';
    return imgData.previewSrc || imgData.src || '';
  },

  getImageDisplaySrc: function(imgData) {
    if (!imgData) return '';
    return imgData.displaySrc || imgData.src || '';
  },

  extractImagesForSettings: function(html, baseUrl, settings) {
    settings = settings || {};
    var displayLimit = SharedUtils.effectiveDisplayLimit(settings);
    var fetchLimit = SharedUtils.effectiveFetchLimit(settings);
    var fallbackLimit = SharedUtils.effectiveFallbackLimit(settings);
    var initialLimit = fetchLimit <= displayLimit ? displayLimit : fallbackLimit;
    if (fetchLimit <= initialLimit) return SharedUtils.extractImages(html, baseUrl, initialLimit);
    return SharedUtils.extractImages(html, baseUrl, fetchLimit, {
      softLimit: initialLimit,
      shouldExpand: function(images) {
        return SharedUtils.isHeavyImageCandidatePrefix(images, settings, displayLimit);
      }
    });
  },

  createImageCollectionGuard: function(images, maxCount, options, maxMs) {
    var startedAt = Date.now();
    var limit = Math.max(0, Math.floor(Number(maxCount) || 0));
    var softLimit = options && options.softLimit > 0
      ? Math.min(limit, Math.floor(Number(options.softLimit) || 0))
      : 0;
    var expanded = !softLimit || softLimit >= limit;
    return function() {
      if (!Array.isArray(images) || images.length >= limit) return false;
      if (maxMs && Date.now() - startedAt >= maxMs) return false;
      if (!expanded && images.length >= softLimit) {
        expanded = !options || typeof options.shouldExpand !== 'function' ? true : !!options.shouldExpand(images);
        if (!expanded) return false;
      }
      return true;
    };
  },

  isOversizedArticleResponse: function(resp) {
    if (!resp || !resp.headers || !resp.headers.get) return false;
    var len = parseInt(resp.headers.get('content-length') || '0', 10);
    return len > SharedUtils.ARTICLE_HTML_MAX_BYTES;
  },

  parseRetryAfterHeader: function(headers, now) {
    if (!headers) return 0;
    var value = '';
    if (typeof headers === 'string') {
      value = headers;
    } else if (headers.get) {
      value = headers.get('retry-after') || headers.get('Retry-After') || '';
    }
    value = String(value || '').trim();
    if (!value) return 0;
    now = Math.max(0, Number(now || Date.now()) || 0);
    if (/^\d+(?:\.\d+)?$/.test(value)) {
      var seconds = Math.max(0, Number(value) || 0);
      return now + Math.ceil(seconds * 1000);
    }
    var parsed = Date.parse(value);
    return isFinite(parsed) && parsed > now ? parsed : 0;
  },

  limitArticleHtml: function(html) {
    html = String(html || '');
    if (html.length > SharedUtils.ARTICLE_HTML_MAX_CHARS) {
      return html.slice(0, SharedUtils.ARTICLE_HTML_MAX_CHARS);
    }
    return html;
  },

  createResponseTooLargeError: function(limitBytes) {
    var e = new Error('response_too_large_' + limitBytes);
    e.name = 'ResponseTooLargeError';
    e.limitBytes = limitBytes;
    return e;
  },

  readResponseArrayBufferLimited: async function(resp, maxBytes) {
    maxBytes = Number(maxBytes) || 0;
    if (!resp || !resp.body || !resp.body.getReader) {
      var fallbackBuffer = await resp.arrayBuffer();
      if (maxBytes > 0 && fallbackBuffer.byteLength > maxBytes) {
        throw SharedUtils.createResponseTooLargeError(maxBytes);
      }
      return fallbackBuffer;
    }

    var reader = resp.body.getReader();
    var chunks = [];
    var total = 0;
    try {
      while (true) {
        var next = await reader.read();
        if (next.done) break;
        var value = next.value || new Uint8Array(0);
        total += value.byteLength;
        if (maxBytes > 0 && total > maxBytes) {
          try { await reader.cancel(); } catch (e) {}
          throw SharedUtils.createResponseTooLargeError(maxBytes);
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch (e) {}
    }

    var out = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].byteLength;
    }
    return out.buffer;
  },

  readResponseTextLimited: async function(resp, maxBytes, contentType) {
    var buffer = await SharedUtils.readResponseArrayBufferLimited(resp, maxBytes);
    return SharedUtils.decodeTextBuffer(buffer, contentType || (resp && resp.headers && resp.headers.get ? resp.headers.get('content-type') : ''));
  },

  getBackgroundFetchTimeout: function(count) {
    count = Math.max(1, Number(count) || 1);
    return Math.ceil(count / SharedUtils.BG_FETCH_CHUNK_SIZE) * SharedUtils.BG_FETCH_TIMEOUT_MS + SharedUtils.BG_FETCH_TIMEOUT_BUFFER_MS;
  },

  getTextAttachmentBackgroundTimeout: function(count) {
    count = Math.max(1, Math.min(SharedUtils.TEXT_ATTACHMENT_MAX_COUNT, Number(count) || 1));
    return SharedUtils.TEXT_ATTACHMENT_TIMEOUT * (count * 2 + 1) + SharedUtils.BG_FETCH_TIMEOUT_BUFFER_MS;
  },

  CACHE_PREFIXES: {
    IMAGE: 'thumb_cache_v2_',
    ARTICLE: 'article_cache_v9_',
    TEXT_RESOURCE: 'txt_resource_cache_v2_',
    TEXT_FAIL: 'atp_text_fail_v1_',
    TEXT_FAIL_BASE: 'atp_text_fail_',
    NEGATIVE: 'atp_empty_v8_',
    IMAGE_BASE: 'thumb_cache_',
    ARTICLE_BASE: 'article_cache_',
    TEXT_RESOURCE_BASE: 'txt_resource_cache_',
    NEGATIVE_BASE: 'atp_empty_'
  },

  RESOURCE_GROUP_ORDER: ['ed2k', 'magnet', 'baidu', 'quark', 'aliyun', 'pan115', 'uc', 'xunlei', 'other'],

  RESOURCE_GROUP_LABELS: {
    ed2k: 'ED2K',
    magnet: '磁力链接',
    baidu: '百度网盘',
    quark: '夸克网盘',
    aliyun: '阿里云盘',
    pan115: '115网盘',
    uc: 'UC网盘',
    xunlei: '迅雷云盘',
    other: '其他链接'
  },

  IMAGE_KEEP_PARAM_MAP: {
    id: true,
    name: true,
    filename: true,
    aid: true,
    n: true,
    file: true,
    url: true,
    src: true,
    img: true,
    image: true,
    pic: true,
    path: true,
    token: true,
    sign: true,
    signature: true,
    sig: true,
    expires: true,
    expire: true,
    exp: true,
    auth: true,
    key: true,
    policy: true,
    'key-pair-id': true,
    md5: true,
    hash: true,
    hmac: true,
    st: true,
    e: true,
    se: true,
    sp: true,
    sv: true,
    sr: true,
    skoid: true,
    sktid: true,
    skt: true,
    ske: true,
    sks: true,
    skv: true,
    awsaccesskeyid: true,
    googleaccessid: true,
    'x-amz-algorithm': true,
    'x-amz-credential': true,
    'x-amz-date': true,
    'x-amz-expires': true,
    'x-amz-security-token': true,
    'x-amz-signature': true,
    'x-amz-signedheaders': true,
    'x-goog-algorithm': true,
    'x-goog-credential': true,
    'x-goog-date': true,
    'x-goog-expires': true,
    'x-goog-signature': true,
    'x-goog-signedheaders': true
  },

  TEXT_TRANSIENT_PARAM_MAP: {
    token: true,
    sign: true,
    signature: true,
    sig: true,
    expires: true,
    expire: true,
    exp: true,
    auth: true,
    key: true,
    policy: true,
    'key-pair-id': true,
    awsaccesskeyid: true,
    googleaccessid: true,
    'x-amz-algorithm': true,
    'x-amz-credential': true,
    'x-amz-date': true,
    'x-amz-expires': true,
    'x-amz-security-token': true,
    'x-amz-signature': true,
    'x-amz-signedheaders': true,
    'x-goog-algorithm': true,
    'x-goog-credential': true,
    'x-goog-date': true,
    'x-goog-expires': true,
    'x-goog-signature': true,
    'x-goog-signedheaders': true
  },

  ARTICLE_KEEP_PARAM_MAP: {
    mod: true,
    tid: true,
    page: true
  },

  IMAGE_DIRECT_PARAM_NAMES: ['url', 'src', 'img', 'image', 'pic', 'path', 'file'],

  resolveUrl: function(baseUrl, relativeUrl) {
    if (!relativeUrl) return null;
    relativeUrl = SharedUtils.decodeHtmlEntities(String(relativeUrl)).trim().replace(/\\\//g, '/');
    if (/^(?:data|blob|javascript|mailto|tel):/i.test(relativeUrl)) return null;
    try { return new URL(relativeUrl, baseUrl).href; } catch(e) { return null; }
  },

  isHttpLikeUrl: function(url, baseUrl) {
    try {
      var u = new URL(url, baseUrl || 'https://example.invalid/');
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
      return false;
    }
  },

  isDirectImageUrl: function(url) {
    var cleaned = SharedUtils.cleanResourceUrl(SharedUtils.decodeHtmlEntities(url));
    if (/\.(?:jpg|jpeg|png|gif|webp)(?:[?#].*)?$/i.test(cleaned)) return true;
    try {
      var u = new URL(cleaned, 'https://example.invalid/');
      var imageParamNames = SharedUtils.IMAGE_DIRECT_PARAM_NAMES;
      for (var i = 0; i < imageParamNames.length; i++) {
        var value = u.searchParams.get(imageParamNames[i]);
        if (value && /\.(?:jpg|jpeg|png|gif|webp)(?:[?#].*)?$/i.test(value)) return true;
      }
    } catch (e) {}
    return false;
  },

  scoreSrcsetDescriptor: function(descriptor) {
    var w = String(descriptor || '').match(/^(\d+)w$/i);
    if (w) return parseInt(w[1], 10);
    var x = String(descriptor || '').match(/^(\d+(?:\.\d+)?)x$/i);
    if (x) return Math.round(parseFloat(x[1]) * 1000);
    return 1;
  },

  // 按 HTML 规范做候选切分：URL 本身可以含逗号（如 CDN 变换参数 c_fill,w_300），
  // 只有空白才能分隔 URL 与描述符，候选之间以「URL 尾部的逗号」或「描述符后的逗号」终结
  getSrcsetUrls: function(srcset) {
    var text = String(srcset || '');
    var bestUrl = '';
    var bestScore = -Infinity;
    var smallestUrl = '';
    var smallestScore = Infinity;
    var pos = 0;
    var len = text.length;

    function skipWsAndCommas() {
      while (pos < len && (/\s/.test(text.charAt(pos)) || text.charAt(pos) === ',')) pos++;
    }

    while (pos < len) {
      skipWsAndCommas();
      if (pos >= len) break;
      var urlStart = pos;
      while (pos < len && !/\s/.test(text.charAt(pos))) pos++;
      var url = text.substring(urlStart, pos);
      var descriptor = '';
      var trailingComma = /,+$/.test(url);
      url = url.replace(/,+$/, '');
      if (!trailingComma) {
        // URL 后允许有描述符，读到下一个逗号（候选结束）为止
        while (pos < len && /\s/.test(text.charAt(pos))) pos++;
        var descStart = pos;
        while (pos < len && text.charAt(pos) !== ',') pos++;
        descriptor = text.substring(descStart, pos).trim();
        if (pos < len) pos++; // 跳过候选结束的逗号
      }
      if (url) {
        var score = SharedUtils.scoreSrcsetDescriptor(descriptor);
        if (score > bestScore) {
          bestScore = score;
          bestUrl = url;
        }
        if (score < smallestScore) {
          smallestScore = score;
          smallestUrl = url;
        }
      }
    }

    return { best: bestUrl, smallest: smallestUrl };
  },

  _normalizeImageUrlCache: null,

  // 热路径高频调用（候选去重、回退查找），做有界 memo 化避免反复 new URL 解析。
  // 淘汰用 FIFO 逐条剔除而非整表 clear：典型页面工作集 ~3000 URL，整表清空会反复失效重解析
  normalizeImageUrl: function(url) {
    if (!url) return url;
    var cache = SharedUtils._normalizeImageUrlCache;
    if (!cache) cache = SharedUtils._normalizeImageUrlCache = new Map();
    var hit = cache.get(url);
    if (hit !== undefined) return hit;
    var result = SharedUtils._normalizeImageUrlUncached(url);
    if (cache.size >= 8000) cache.delete(cache.keys().next().value);
    cache.set(url, result);
    return result;
  },

  _normalizeImageUrlUncached: function(url) {
    try {
      var u = new URL(url);
      var keepParamMap = SharedUtils.IMAGE_KEEP_PARAM_MAP;
      var params = u.searchParams;
      var newParams = [];
      params.forEach(function(v, k) {
        var lowerKey = String(k).toLowerCase();
        if (keepParamMap[lowerKey] || lowerKey.indexOf('x-amz-') === 0 || lowerKey.indexOf('x-goog-') === 0) {
          newParams.push(encodeURIComponent(lowerKey) + '=' + encodeURIComponent(v));
        }
      });
      newParams.sort();
      u.search = newParams.length ? '?' + newParams.join('&') : '';
      u.hash = '';
      return u.toString();
    } catch(e) {
      return url;
    }
  },

  normalizeArticleUrl: function(url) {
    if (!url) return url;
    try {
      var u = new URL(url);
      var keepParamMap = SharedUtils.ARTICLE_KEEP_PARAM_MAP;
      var params = u.searchParams;
      var newParams = [];
      params.forEach(function(v, k) {
        if (keepParamMap[k]) newParams.push(k + '=' + encodeURIComponent(v));
      });
      newParams.sort();
      u.search = newParams.length ? '?' + newParams.join('&') : '';
      u.hash = '';
      return u.toString();
    } catch(e) {
      return url;
    }
  },

  normalizeTextAttachmentUrl: function(url) {
    if (!url) return url;
    try {
      var u = new URL(url);
      var params = [];
      u.searchParams.forEach(function(v, k) {
        params.push([k, v]);
      });
      params.sort(function(a, b) {
        if (a[0] === b[0]) return a[1] < b[1] ? -1 : (a[1] > b[1] ? 1 : 0);
        return a[0] < b[0] ? -1 : 1;
      });
      u.search = '';
      for (var i = 0; i < params.length; i++) {
        u.searchParams.append(params[i][0], params[i][1]);
      }
      u.hash = '';
      return u.toString();
    } catch(e) {
      return url;
    }
  },

  getTextAttachmentCacheKeySuffix: function(url) {
    var normalized = SharedUtils.normalizeTextAttachmentUrl(url);
    if (!normalized) return '';
    var hashA = 0x811c9dc5;
    var hashB = 0x9e3779b9;
    for (var i = 0; i < normalized.length; i++) {
      var code = normalized.charCodeAt(i);
      hashA = Math.imul(hashA ^ code, 16777619) >>> 0;
      hashB = Math.imul(hashB ^ code, 2246822519) >>> 0;
    }
    return 'h_' + hashA.toString(36) + '_' + hashB.toString(36) + '_' + normalized.length.toString(36);
  },

  getTextAttachmentCacheKey: function(prefix, url) {
    var suffix = SharedUtils.getTextAttachmentCacheKeySuffix(url);
    return suffix ? String(prefix || '') + suffix : '';
  },

  getLegacyTextAttachmentCacheKey: function(prefix, url) {
    var normalized = SharedUtils.normalizeTextAttachmentUrl(url);
    return normalized ? String(prefix || '') + normalized : '';
  },

  getTextAttachmentCacheKeys: function(prefix, url) {
    var currentKey = SharedUtils.getTextAttachmentCacheKey(prefix, url);
    var legacyKey = SharedUtils.getLegacyTextAttachmentCacheKey(prefix, url);
    var keys = [];
    if (currentKey) keys.push(currentKey);
    if (legacyKey && legacyKey !== currentKey) keys.push(legacyKey);
    return keys;
  },

  isHashedTextAttachmentCacheKey: function(key, prefix) {
    return typeof key === 'string' && key.indexOf(String(prefix || '') + 'h_') === 0;
  },

  isUnsafeTextAttachmentCacheKey: function(key, prefix) {
    return typeof key === 'string' &&
      key.indexOf(String(prefix || '')) === 0 &&
      !SharedUtils.isHashedTextAttachmentCacheKey(key, prefix);
  },

  isSignedTextDownloadUrl: function(url, baseUrl) {
    try {
      var u = new URL(url, baseUrl || 'https://example.invalid/');
      var host = u.hostname;
      return u.protocol === 'https:' && host === 'xia.ewrewej.la';
    } catch (e) {
      return false;
    }
  },

  isAllowedTextAttachmentUrl: function(url, baseUrl) {
    try {
      var u = new URL(url, baseUrl || undefined);
      if (u.protocol !== 'https:') return false;
      var host = u.hostname;
      if (host === 'sehuatang.org' || host === 'sehuatang.net' || host.endsWith('.sehuatang.org') || host.endsWith('.sehuatang.net')) return true;
      if (SharedUtils.isSignedTextDownloadUrl(url, baseUrl)) return true;
      return host === 'dl.ldkms.la' && /\.txt$/i.test(u.pathname);
    } catch (e) {
      return false;
    }
  },

  hasTransientTextAttachmentParams: function(url, baseUrl) {
    try {
      var u = new URL(url, baseUrl || undefined);
      var transientParamMap = SharedUtils.TEXT_TRANSIENT_PARAM_MAP;
      var found = false;
      u.searchParams.forEach(function(_, key) {
        var lowerKey = String(key || '').toLowerCase();
        if (transientParamMap[lowerKey] || lowerKey.indexOf('x-amz-') === 0 || lowerKey.indexOf('x-goog-') === 0) {
          found = true;
        }
      });
      return found;
    } catch (e) {
      return false;
    }
  },

  isTransientTextAttachmentUrl: function(url, baseUrl) {
    return SharedUtils.isDiscuzAttachmentUrl(url, baseUrl) ||
      SharedUtils.isSignedTextDownloadUrl(url, baseUrl) ||
      SharedUtils.hasTransientTextAttachmentParams(url, baseUrl);
  },

  isPersistableTextAttachmentUrl: function(url, baseUrl) {
    return SharedUtils.isAllowedTextAttachmentUrl(url, baseUrl) &&
      !SharedUtils.isTransientTextAttachmentUrl(url, baseUrl);
  },

  sanitizeTextAttachmentPageUrl: function(url) {
    if (!SharedUtils.isHttpLikeUrl(url)) return '';
    try {
      var u = new URL(url);
      u.search = '';
      u.hash = '';
      return u.href;
    } catch (e) {
      return '';
    }
  },

  getSupportedForumRoot: function(host) {
    host = String(host || '').toLowerCase();
    if (host === 'sehuatang.org' || host.endsWith('.sehuatang.org')) return 'sehuatang.org';
    if (host === 'sehuatang.net' || host.endsWith('.sehuatang.net')) return 'sehuatang.net';
    return '';
  },

  isSupportedForumHost: function(host) {
    return !!SharedUtils.getSupportedForumRoot(host);
  },

  isSameSupportedSiteHost: function(host, baseHost) {
    host = String(host || '').toLowerCase();
    baseHost = String(baseHost || '').toLowerCase();
    if (!baseHost) return true;
    if (host === baseHost) return true;
    var root = SharedUtils.getSupportedForumRoot(host);
    return !!root && root === SharedUtils.getSupportedForumRoot(baseHost);
  },

  isDiscuzAttachmentUrl: function(url, baseUrl) {
    try {
      var u = new URL(url, baseUrl || undefined);
      var baseHost = '';
      if (baseUrl) {
        try { baseHost = new URL(baseUrl).hostname; } catch (e) {}
      } else if (typeof location !== 'undefined') {
        baseHost = location.hostname;
      }
      if (baseHost && !SharedUtils.isSameSupportedSiteHost(u.hostname, baseHost)) return false;
      return /(?:mod=attachment|attachment\.php|attach(?:ment)?id=|[?&]aid=|misc\.php\?(?:.*&)?(?:mod=attach|action=attach))/.test((u.pathname + u.search).toLowerCase());
    } catch (e) { return false; }
  },

  isMeaningfulImage: function(src) {
    if (!src) return false;
    if (!SharedUtils.isHttpLikeUrl(src)) return false;
    var L = src.toLowerCase();
    // Discuz 附件图（aid=/mod=attachment）优先放行：文件名恰好含 logo/icon 等词不应误杀
    if (/aid=|mod=attachment/.test(L)) return true;
    if (/avatar|icon|logo|1x1|pixel|blank/.test(L)) return false;
    if (/\.svg(?:[?#]|$)/.test(L)) return false;
    if (/\/static\/image\//.test(L)) return false;
    if (/pn_post\.|print\.png|thread-prev|thread-next|userinfo\.|online\.|offline\.|folder_|agree\.gif|digest_|pin_|hot_|recommend_|lock\.|collapsed_/.test(L)) return false;
    return true;
  },

  isBlockedPage: function(html) {
    var h = String(html || '').substring(0, 20000);
    if (/cf-mitigated|cf-chl|challenge-platform|Just a moment/i.test(h)) return 'cloudflare';

    var messagePage = /id=["']messagetext["']|class=["'][^"']*(?:alert_error|showmessage)[^"']*["']|<title[^>]*>[^<]*(?:提示信息|错误信息|访问受限)[^<]*<\/title>/i.test(h);
    var text = h
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(?:nbsp|#160);/gi, ' ')
      .replace(/\s+/g, ' ');

    if (messagePage) {
      if (/请先登录|尚未登录|需要登录|必须登录|登录后(?:才|方|可)|not logged in|sign in to continue/i.test(text)) return 'login_page';
      if (/没有权限|无权访问|权限不足|用户组.{0,16}(?:无权|无法|不能)|access denied|forbidden/i.test(text)) return 'permission_page';
      if (/(?:下载|附件).{0,24}(?:无权|权限不足|需要登录|请先登录|需要购买)/i.test(text)) return 'download_blocked';
    }

    var purchaseAction = /(?:action|href)=["'][^"']*(?:buythread|pay(?:thread|topic)|action=buy)[^"']*["']/i.test(h);
    if (purchaseAction && /购买(?:主题|帖子)|付费(?:主题|帖子)|支付.{0,20}(?:金币|金钱)|售价.{0,20}(?:金币|金钱)/i.test(text)) return 'purchase_page';
    return null;
  },

  extractOgImage: function(html, baseUrl) {
    var og = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*\/?>/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*\/?>/i);
    if (og) return this.resolveUrl(baseUrl, og[1]);
    return null;
  },

  emptyResources: function() {
    return {
      groups: {
        ed2k: [],
        magnet: [],
        baidu: [],
        quark: [],
        aliyun: [],
        pan115: [],
        uc: [],
        xunlei: [],
        other: []
      },
      passwords: []
    };
  },

  isPanResourceType: function(type) {
    return type === 'baidu' || type === 'quark' || type === 'aliyun' || type === 'pan115' ||
      type === 'uc' || type === 'xunlei';
  },

  // 去重键：magnet 按 infohash（大小写/附加 dn=/tr= 参数不影响同一资源）、
  // ed2k 按 大小|哈希（文件名变体与尾部 h= 校验段不影响），其余按清洗后的完整 URL
  getResourceDedupKey: function(type, url) {
    url = String(url || '');
    if (type === 'magnet') {
      var m = url.match(/xt=urn:(btih|btmh):([A-Za-z0-9]+)/i);
      if (m) return 'magnet|' + m[1].toLowerCase() + ':' + m[2].toLowerCase();
    } else if (type === 'ed2k') {
      var e = url.match(/^ed2k:\/\/\|file\|.*\|(\d+)\|([A-Fa-f0-9]{32})\|/i);
      if (e) return 'ed2k|' + e[1] + '|' + e[2].toLowerCase();
    }
    return type + '|' + url;
  },

  preparePanResourceUrlForParse: function(url) {
    var parseUrl = String(url || '');
    if (/^\/\//.test(parseUrl)) {
      return 'https:' + parseUrl;
    }
    if (/^(?:(?:www\.)?pan\.baidu\.com|(?:www\.)?yun\.baidu\.com|(?:www\.)?pan\.quark\.cn|(?:www\.)?115\.com|(?:www\.)?(?:aliyundrive|alipan)\.com|(?:www\.)?drive\.uc\.cn|(?:www\.)?pan\.xunlei\.com)\//i.test(parseUrl)) {
      return 'https://' + parseUrl;
    }
    return parseUrl;
  },

  getPanResourceTypeFromParsedUrl: function(parsedUrl) {
    if (!parsedUrl) return null;
    var host = String(parsedUrl.hostname || '').toLowerCase();
    var path = String(parsedUrl.pathname || '').toLowerCase();
    if ((host === 'pan.baidu.com' || host === 'www.pan.baidu.com' || host === 'yun.baidu.com' || host === 'www.yun.baidu.com') && /^(?:\/s\/|\/share\/)/.test(path)) return 'baidu';
    if ((host === 'pan.quark.cn' || host === 'www.pan.quark.cn') && /^\/s\//.test(path)) return 'quark';
    if ((host === '115.com' || host === 'www.115.com') && /^\/s\//.test(path)) return 'pan115';
    if ((host === 'aliyundrive.com' || host === 'www.aliyundrive.com' || host === 'alipan.com' || host === 'www.alipan.com') && /^\/s\//.test(path)) return 'aliyun';
    if ((host === 'drive.uc.cn' || host === 'www.drive.uc.cn') && /^\/s\//.test(path)) return 'uc';
    if ((host === 'pan.xunlei.com' || host === 'www.pan.xunlei.com') && /^\/s\//.test(path)) return 'xunlei';
    return null;
  },

  canonicalPanHost: function(host) {
    host = String(host || '').toLowerCase();
    if (host === 'www.pan.baidu.com') return 'pan.baidu.com';
    if (host === 'yun.baidu.com' || host === 'www.yun.baidu.com') return 'pan.baidu.com';
    if (host === 'www.pan.quark.cn') return 'pan.quark.cn';
    if (host === 'www.115.com') return '115.com';
    if (host === 'www.aliyundrive.com') return 'aliyundrive.com';
    if (host === 'www.alipan.com') return 'alipan.com';
    if (host === 'www.drive.uc.cn') return 'drive.uc.cn';
    if (host === 'www.pan.xunlei.com') return 'pan.xunlei.com';
    return host;
  },

  extractAccessCodeFromUrlQuery: function(parsedUrl) {
    var code = '';
    parsedUrl.searchParams.forEach(function(value, key) {
      if (code) return;
      var lowerKey = String(key || '').toLowerCase();
      if ((lowerKey === 'pwd' || lowerKey === 'password' || lowerKey === 'code') && value) {
        code = SharedUtils.cleanPasswordValue(value);
      }
    });
    return code;
  },

  normalizePanResourceUrlCode: function(type, url, code) {
    var result = { url: url, code: this.cleanPasswordValue(code || '') };
    if (!this.isPanResourceType(type) || !url) return result;
    var parseUrl = this.preparePanResourceUrlForParse(url);
    try {
      var parsedUrl = new URL(parseUrl);
      var parsedType = SharedUtils.getPanResourceTypeFromParsedUrl(parsedUrl);
      if (!parsedType || parsedType !== type) {
        result.url = '';
        result.code = '';
        return result;
      }
      var urlCode = SharedUtils.extractAccessCodeFromUrlQuery(parsedUrl);
      if (urlCode) result.code = urlCode;
      parsedUrl.hostname = SharedUtils.canonicalPanHost(parsedUrl.hostname);
      parsedUrl.pathname = (parsedUrl.pathname || '/').replace(/\/+$/, '') || '/';
      parsedUrl.hash = '';
      var keepParams = [];
      parsedUrl.searchParams.forEach(function(value, key) {
        var lowerKey = String(key || '').toLowerCase();
        if (lowerKey === 'pwd' || lowerKey === 'password' || lowerKey === 'code') return;
        keepParams.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
      });
      keepParams.sort();
      parsedUrl.search = keepParams.length ? '?' + keepParams.join('&') : '';
      result.url = parsedUrl.toString();
    } catch (e) {}
    return result;
  },

  normalizeResources: function(resources) {
    var normalized = this.emptyResources();
    if (!resources) return normalized;
    var groups = resources.groups || {};
    for (var i = 0; i < this.RESOURCE_GROUP_ORDER.length; i++) {
      var type = this.RESOURCE_GROUP_ORDER[i];
      var items = Array.isArray(groups[type]) ? groups[type] : [];
      var seen = {};
      for (var j = 0; j < items.length; j++) {
        var item = typeof items[j] === 'string' ? { type: type, url: items[j] } : Object.assign({}, items[j]);
        item.type = item.type || type;
        item.url = this.cleanResourceUrl(this.decodeHtmlEntities(this.restoreProtectedEmails(item.url || '')));
        var normalizedPan = this.normalizePanResourceUrlCode(type, item.url, item.code);
        item.url = normalizedPan.url;
        if (normalizedPan.code) item.code = normalizedPan.code;
        if (!item.source) item.source = 'html';
        if (!item.url) continue;
        var dedupKey = this.getResourceDedupKey(type, item.url);
        if (seen[dedupKey]) {
          var existing = seen[dedupKey];
          existing.source = this.mergeResourceSource(existing.source, item.source);
          if (!existing.code && item.code) existing.code = item.code;
          continue;
        }
        seen[dedupKey] = item;
        normalized.groups[type].push(item);
      }
    }
    normalized.passwords = this.normalizePasswords(resources.passwords);
    return normalized;
  },

  normalizePasswords: function(passwords) {
    var out = [];
    var seen = {};
    passwords = Array.isArray(passwords) ? passwords : [];
    for (var i = 0; i < passwords.length; i++) {
      var value = this.cleanPasswordValue(passwords[i]);
      if (!value || seen[value]) continue;
      seen[value] = true;
      out.push(value);
    }
    return out;
  },

  forEachResourceSourcePart: function(value, callback) {
    var source = String(value || 'html');
    var start = 0;
    while (start <= source.length) {
      var next = source.indexOf('+', start);
      var end = next === -1 ? source.length : next;
      var part = source.substring(start, end);
      if (part && callback(part) === false) return false;
      if (next === -1) break;
      start = next + 1;
    }
    return true;
  },

  hasResourceSource: function(value, sourceName) {
    var found = false;
    this.forEachResourceSourcePart(value, function(part) {
      if (part === sourceName) {
        found = true;
        return false;
      }
    });
    return found;
  },

  mergeResourceSource: function(a, b) {
    var parts = {};
    function add(value) {
      SharedUtils.forEachResourceSourcePart(value, function(part) {
        parts[part] = true;
      });
    }
    add(a);
    add(b);
    var order = ['html', 'txt'];
    var result = [];
    for (var i = 0; i < order.length; i++) {
      if (parts[order[i]]) result.push(order[i]);
      delete parts[order[i]];
    }
    for (var key in parts) result.push(key);
    return result.join('+');
  },

  countResources: function(resources) {
    // 快路径：已是规范形状时直接计数，避免日志等高频调用触发 normalizeResources 深拷贝
    if (resources && resources.groups && typeof resources.groups === 'object') {
      var total = 0;
      for (var i = 0; i < this.RESOURCE_GROUP_ORDER.length; i++) {
        var group = resources.groups[this.RESOURCE_GROUP_ORDER[i]];
        if (Array.isArray(group)) total += group.length;
      }
      return total;
    }
    var r = this.normalizeResources(resources);
    var slowTotal = 0;
    for (var j = 0; j < this.RESOURCE_GROUP_ORDER.length; j++) {
      slowTotal += r.groups[this.RESOURCE_GROUP_ORDER[j]].length;
    }
    return slowTotal;
  },

  hasResources: function(resources) {
    return this.countResources(resources) > 0;
  },

  hasResourcePayload: function(resources) {
    // 快路径：已是规范形状时直接判断，避免高频调用触发深拷贝
    if (resources && resources.groups && typeof resources.groups === 'object' && Array.isArray(resources.passwords)) {
      for (var fi = 0; fi < this.RESOURCE_GROUP_ORDER.length; fi++) {
        var group = resources.groups[this.RESOURCE_GROUP_ORDER[fi]];
        if (Array.isArray(group) && group.length > 0) return true;
      }
      return resources.passwords.length > 0;
    }
    var r = this.normalizeResources(resources);
    for (var i = 0; i < this.RESOURCE_GROUP_ORDER.length; i++) {
      if (r.groups[this.RESOURCE_GROUP_ORDER[i]].length > 0) return true;
    }
    return r.passwords.length > 0;
  },

  mergeResources: function() {
    var merged = this.emptyResources();
    for (var a = 0; a < arguments.length; a++) {
      var resources = this.normalizeResources(arguments[a]);
      for (var i = 0; i < this.RESOURCE_GROUP_ORDER.length; i++) {
        var type = this.RESOURCE_GROUP_ORDER[i];
        var group = resources.groups[type] || [];
        for (var g = 0; g < group.length; g++) {
          merged.groups[type].push(group[g]);
        }
      }
      merged.passwords = this.mergeUnique(merged.passwords, resources.passwords || []);
    }
    return this.normalizeResources(merged);
  },

  extractTextAttachments: function(html, baseUrl, maxCount, context) {
    maxCount = maxCount || 3;
    var MAX_HTML_LENGTH = 1000000;
    var MAX_SCAN_MS = 250;
    var decoded = (context && typeof context.decoded === 'string')
      ? context.decoded
      : SharedUtils.decodeHtmlEntities(SharedUtils.restoreProtectedEmails(SharedUtils.limitArticleHtml(html)));
    if (decoded.length > MAX_HTML_LENGTH) decoded = decoded.slice(0, MAX_HTML_LENGTH);
    var startedAt = Date.now();

    function makeCandidate(href, name, source) {
      var cleanedHref = SharedUtils.cleanResourceUrl(String(href || '').replace(/\\\//g, '/'));
      if (!cleanedHref) return null;
      var url = SharedUtils.resolveUrl(baseUrl, cleanedHref);
      if (!url) return null;
      if (!SharedUtils.isAllowedTextAttachmentUrl(url, baseUrl)) return null;
      var key = SharedUtils.normalizeTextAttachmentUrl(url);
      if (!key) return null;
      return {
        url: url,
        key: key,
        name: SharedUtils.cleanAttachmentName(name || url),
        source: source,
        pageUrl: baseUrl
      };
    }

    function isAttachmentHref(href) {
      return /(?:mod=attachment|attachment\.php|attach(?:ment)?id=|[?&]aid=)/i.test(href);
    }

    function isBlockedProtocol(href) {
      return /^(?:javascript|mailto|ed2k|magnet):/i.test(href);
    }

    // Single pass: collect direct and context candidates in DOM order
    var directCandidates = [];
    var contextCandidates = [];
    var m;
    SharedUtils.forEachAnchorTag(decoded, function(attrs, body, openIndex, endIndex) {
      if (Date.now() - startedAt > MAX_SCAN_MS) return false;
      var href = SharedUtils.extractHtmlAttr(attrs, 'href');
      if (!href || isBlockedProtocol(href)) return;

      var label = SharedUtils.htmlToText(body).trim();
      var title = SharedUtils.extractHtmlAttr(attrs, 'title');
      var download = SharedUtils.extractHtmlAttr(attrs, 'download');

      // Direct check: high-confidence .txt links
      var probe = [href, label, title, download].join(' ');
      var looksLikeTextFile = /\.txt/i.test(probe);
      var looksLikeAttachment = isAttachmentHref(href);
      var directTextUrl = /\.txt(?:[?#].*)?$/i.test(href);
      var looksLikeSignedDownload = SharedUtils.isSignedTextDownloadUrl(href, baseUrl);
      if ((looksLikeTextFile && (looksLikeAttachment || directTextUrl)) || looksLikeSignedDownload) {
        var cand = makeCandidate(href, download || title || label || href, 'txt-attachment');
        if (cand) directCandidates.push(cand);
        return;
      }

      // Context check: attachment links with nearby .txt indicators
      if (!isAttachmentHref(href)) return;

      var ctxStart = Math.max(0, openIndex - 1500);
      var ctxEnd = Math.min(decoded.length, endIndex + 1500);
      var contextSlice = decoded.slice(ctxStart, ctxEnd);
      if (!/\.txt/i.test(contextSlice) && !/(?:filetype|attach(?:ment)?)[^>]{0,160}(?:txt|text)/i.test(contextSlice)) return;

      // Context name: prefer tag attributes, then narrow window, then block, then fallback
      var ctxName = download || title || label || '';
      if (!/\.txt/i.test(ctxName)) {
        // Narrow window ±200 chars around anchor
        var narrowStart = Math.max(0, openIndex - 200);
        var narrowEnd = Math.min(decoded.length, endIndex + 200);
        var narrowText = SharedUtils.htmlToText(decoded.slice(narrowStart, narrowEnd)).trim();
        var narrowMatch = narrowText.match(/[^\s<>"'：:，,。；;（）()【】\[\]]{1,120}\.txt/i);
        if (narrowMatch) {
          ctxName = narrowMatch[0];
        } else {
          // Same attachment block: nearest enclosing dl/li/tr/div
          var blockStart = Math.max(0, openIndex - 800);
          var blockEnd = Math.min(decoded.length, endIndex + 800);
          var blockText = SharedUtils.htmlToText(decoded.slice(blockStart, blockEnd)).trim();
          var blockMatch = blockText.match(/[^\s<>"'：:，,。；;（）()【】\[\]]{1,120}\.txt/i);
          if (blockMatch) {
            ctxName = blockMatch[0];
          } else {
            // Full window fallback
            var contextText = SharedUtils.htmlToText(contextSlice).trim();
            var fallbackMatch = contextText.match(/[^\s<>"'：:，,。；;（）()【】\[\]]{1,120}\.txt/i);
            ctxName = (fallbackMatch && fallbackMatch[0]) || '';
          }
        }
      }
      var ctxCand = makeCandidate(href, ctxName || label || href, 'txt-attachment-context');
      if (ctxCand) contextCandidates.push(ctxCand);
    });

    // Merge: direct first, then context, then raw URL — same seen across all phases
    var attachments = [];
    var seen = {};

    function addCandidate(cand) {
      if (attachments.length >= maxCount) return false;
      if (seen[cand.key]) return false;
      seen[cand.key] = true;
      attachments.push({ url: cand.url, name: cand.name, source: cand.source, pageUrl: cand.pageUrl });
      return true;
    }

    for (var d = 0; d < directCandidates.length && attachments.length < maxCount; d++) {
      addCandidate(directCandidates[d]);
    }
    for (var c = 0; c < contextCandidates.length && attachments.length < maxCount; c++) {
      addCandidate(contextCandidates[c]);
    }

    var rawSignedDownloadRegex = /https:\/\/xia\.ewrewej\.la\/[^"'<>\s]+/gi;
    while (attachments.length < maxCount && (m = rawSignedDownloadRegex.exec(decoded)) !== null) {
      if (Date.now() - startedAt > MAX_SCAN_MS) break;
      var rawSignedUrl = m[0].replace(/\\\//g, '/');
      var signedCand = makeCandidate(rawSignedUrl, rawSignedUrl, 'txt-attachment-signed');
      if (signedCand) addCandidate(signedCand);
    }

    // Raw URL fallback: standalone attachment URLs in text
    var rawUrlRegex = /(?:https?:\/\/[^"'<>\s]+)?(?:forum\.php\?[^"'<>\s]*mod=attachment[^"'<>\s]*|attachment\.php\?[^"'<>\s]*|misc\.php\?[^"'<>\s]*(?:mod=attach|action=attach)[^"'<>\s]*)/gi;
    while (attachments.length < maxCount && (m = rawUrlRegex.exec(decoded)) !== null) {
      if (Date.now() - startedAt > MAX_SCAN_MS) break;
      var rawUrl = m[0].replace(/\\\//g, '/');
      var rawCtxStart = Math.max(0, m.index - 1500);
      var rawCtxEnd = Math.min(decoded.length, rawUrlRegex.lastIndex + 1500);
      var rawSlice = decoded.slice(rawCtxStart, rawCtxEnd);
      if (!/\.txt/i.test(rawSlice) && !/(?:filetype|attach(?:ment)?)[^>]{0,160}(?:txt|text)/i.test(rawSlice)) continue;

      // Raw name: narrow window first, then block, then full window (same as context)
      var rawNarrowStart = Math.max(0, m.index - 200);
      var rawNarrowEnd = Math.min(decoded.length, rawUrlRegex.lastIndex + 200);
      var rawNarrowText = SharedUtils.htmlToText(decoded.slice(rawNarrowStart, rawNarrowEnd)).trim();
      var rawNameMatch = rawNarrowText.match(/[^\s<>"'：:，,。；;（）()【】\[\]]{1,120}\.txt/i);
      if (!rawNameMatch) {
        var rawBlockStart = Math.max(0, m.index - 800);
        var rawBlockEnd = Math.min(decoded.length, rawUrlRegex.lastIndex + 800);
        var rawBlockText = SharedUtils.htmlToText(decoded.slice(rawBlockStart, rawBlockEnd)).trim();
        rawNameMatch = rawBlockText.match(/[^\s<>"'：:，,。；;（）()【】\[\]]{1,120}\.txt/i);
      }
      if (!rawNameMatch) {
        var rawText = SharedUtils.htmlToText(rawSlice).trim();
        rawNameMatch = rawText.match(/[^\s<>"'：:，,。；;（）()【】\[\]]{1,120}\.txt/i);
      }
      var rawCand = makeCandidate(rawUrl, (rawNameMatch && rawNameMatch[0]) || rawUrl, 'txt-attachment-raw');
      if (rawCand) addCandidate(rawCand);
    }

    return attachments;
  },

  cleanAttachmentName: function(name) {
    var text = this.htmlToText(this.decodeHtmlEntities(String(name || ''))).trim();
    text = text.replace(/\s+/g, ' ');
    return text.slice(0, 120);
  },

  extractTextDownloadUrls: function(html, baseUrl, maxCount) {
    maxCount = maxCount || 3;
    var urls = [];
    var seen = {};
    var decoded = this.decodeHtmlEntities(this.restoreProtectedEmails(String(html || '')));
    var baseKey = '';
    var baseResolved = SharedUtils.resolveUrl(baseUrl, baseUrl);
    if (baseResolved) baseKey = SharedUtils.normalizeTextAttachmentUrl(baseResolved);

    function looksLikeTextUrl(raw) {
      return /\.txt(?:[?#].*)?$/i.test(raw) || /\.txt[?#]/i.test(raw);
    }

    function looksLikeAttachmentUrl(raw) {
      return /(?:mod=attachment|attachment\.php|attach(?:ment)?id=|[?&]aid=|misc\.php\?[^"'<>\s]*(?:mod=attach|action=attach))/i.test(raw);
    }

    function looksLikeSignedTextDownloadUrl(raw) {
      return SharedUtils.isSignedTextDownloadUrl(raw, baseUrl);
    }

    function add(raw) {
      if (!raw || urls.length >= maxCount) return;
      raw = SharedUtils.cleanResourceUrl(String(raw).replace(/\\\//g, '/'));
      if (!looksLikeTextUrl(raw) && !looksLikeAttachmentUrl(raw) && !looksLikeSignedTextDownloadUrl(raw)) return;
      var url = SharedUtils.resolveUrl(baseUrl, raw);
      if (!url) return;
      var key = SharedUtils.normalizeTextAttachmentUrl(url);
      if (!key) return;
      if (baseKey && key === baseKey) return;
      if (seen[key]) return;
      seen[key] = true;
      urls.push(url);
    }

    this.forEachHrefValue(decoded, function(href) {
      add(href);
      if (urls.length >= maxCount) return false;
    });

    var rawRegex = /https?:\/\/[^"'<>\s]+?\.txt(?:[?#][^"'<>\s]*)?/gi;
    var m;
    while (urls.length < maxCount && (m = rawRegex.exec(decoded)) !== null) {
      add(m[0]);
    }

    var signedDownloadRegex = /https:\/\/xia\.ewrewej\.la\/[^"'<>\s]+/gi;
    while (urls.length < maxCount && (m = signedDownloadRegex.exec(decoded)) !== null) {
      add(m[0]);
    }

    var rawAttachmentRegex = /(?:https?:\/\/[^"'<>\s]+)?(?:forum\.php\?[^"'<>\s]*mod=attachment[^"'<>\s]*|attachment\.php\?[^"'<>\s]*|misc\.php\?[^"'<>\s]*(?:mod=attach|action=attach)[^"'<>\s]*)/gi;
    while (urls.length < maxCount && (m = rawAttachmentRegex.exec(decoded)) !== null) {
      add(m[0]);
    }

    return urls;
  },

  decodeTextBuffer: function(buffer, contentType) {
    if (typeof TextDecoder === 'undefined') return '';
    var labels = [];
    var charset = String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i);
    if (charset && charset[1]) labels.push(charset[1]);
    labels.push('utf-8', 'gb18030', 'gbk');

    var best = '';
    var bestScore = Infinity;
    var tried = {};
    for (var i = 0; i < labels.length; i++) {
      var label = String(labels[i] || '').toLowerCase();
      if (!label || tried[label]) continue;
      tried[label] = true;
      try {
        var text = new TextDecoder(label).decode(buffer);
        var bad = (text.match(/\ufffd/g) || []).length;
        if (bad < bestScore) {
          best = text;
          bestScore = bad;
        }
        if (bad === 0) return text;
      } catch (e) {}
    }
    return best;
  },

  looksLikeHtmlDocument: function(text) {
    return /<(?:!doctype|html|head|body|title|form)\b/i.test(String(text || '').slice(0, 2000));
  },

  looksLikeDownloadIntermediary: function(text) {
    var head = String(text || '').slice(0, 10000);
    if (!/(?:mod=attachment|attachment\.php|misc\.php\?[^"'<>\s]*(?:mod=attach|action=attach)|\.txt(?:[?#]|\b)|xia\.ewrewej\.la\/)/i.test(head)) {
      return false;
    }
    return /(?:href\s*=|location\.href|window\.location|下载|附件|download)/i.test(head);
  },

  isUnavailableTextDocument: function(text) {
    var head = String(text || '').slice(0, 5000);
    if (this.isBlockedPage(head)) return true;
    if (this.looksLikeHtmlDocument(head)) {
      return /登录|登入|权限|无权|沒有權限|没有权限|购买|金钱|金币|售价|抱歉|请先登录|access denied|forbidden/i.test(head);
    }
    return false;
  },

  // 一次性生成三个提取器共用的整文派生串（原始→还原邮箱→解实体→纯文本），
  // 供 extractResources / extractTextAttachments 复用，避免同一篇 1MB 文章重复整文解码
  prepareArticleExtractionContext: function(html) {
    var rawHtml = this.restoreProtectedEmails(this.limitArticleHtml(html));
    var decoded = this.decodeHtmlEntities(rawHtml);
    return {
      rawHtml: rawHtml,
      decoded: decoded,
      text: this.htmlToText(decoded)
    };
  },

  extractResources: function(html, baseUrl, source, context) {
    source = source || 'html';
    var resources = this.emptyResources();
    var seen = {};
    var rawHtml, decoded, text;
    if (context && typeof context.rawHtml === 'string' && typeof context.decoded === 'string' && typeof context.text === 'string') {
      rawHtml = context.rawHtml;
      decoded = context.decoded;
      text = context.text;
    } else {
      rawHtml = this.restoreProtectedEmails(this.limitArticleHtml(html));
      decoded = this.decodeHtmlEntities(rawHtml);
      text = this.htmlToText(decoded);
    }

    function add(type, url, meta) {
      if (!url) return;
      url = SharedUtils.cleanResourceUrl(url);
      if (!url) return;
      meta = meta ? Object.assign({}, meta) : {};
      var normalizedPan = SharedUtils.normalizePanResourceUrlCode(type, url, meta.code);
      url = normalizedPan.url;
      if (normalizedPan.code) meta.code = normalizedPan.code;
      var key = SharedUtils.getResourceDedupKey(type, url);
      if (seen[key]) {
        var existing = seen[key];
        existing.source = SharedUtils.mergeResourceSource(existing.source, source);
        if (!existing.code && meta && meta.code) existing.code = meta.code;
        return;
      }
      var item = { type: type, url: url, source: source };
      if (meta && meta.code) item.code = meta.code;
      seen[key] = item;
      resources.groups[type].push(item);
    }

    function normalizeResourceCandidate(raw) {
      raw = SharedUtils.cleanResourceUrl(raw);
      if (!raw) return '';
      if (/^\/\//.test(raw)) return 'https:' + raw;
      if (/^(?:(?:www\.)?pan\.baidu\.com|(?:www\.)?yun\.baidu\.com|(?:www\.)?pan\.quark\.cn|(?:www\.)?115\.com|(?:www\.)?(?:aliyundrive|alipan)\.com|(?:www\.)?drive\.uc\.cn|(?:www\.)?pan\.xunlei\.com)\//i.test(raw)) {
        return 'https://' + raw;
      }
      return SharedUtils.resolveUrl(baseUrl, raw) || raw;
    }

    function addResourceCandidateWithText(raw, contextText, linkIndex) {
      raw = SharedUtils.cleanResourceUrl(raw);
      var type = SharedUtils.classifyResourceUrl(raw);
      if (!type) return;
      var url = normalizeResourceCandidate(raw);
      contextText = contextText || text;
      var code = '';
      if (SharedUtils.isPanResourceType(type)) {
        code = SharedUtils.extractAccessCode(url, contextText, linkIndex);
        if (!code && url !== raw) code = SharedUtils.extractAccessCode(raw, contextText, linkIndex);
      }
      add(type, url, code ? { code: code } : null);
    }

    function scanResourceText(scanText, contextText, offset) {
      scanText = String(scanText || '');
      if (!scanText) return;
      contextText = contextText || scanText;
      offset = offset || 0;

      // 文件名段禁止跨行：换行开放会让恶意文件名把伪造的「解压密码：xxx」行注入复制内容
      var ed2kMatches = scanText.match(/ed2k:\/\/\|file\|[^\r\n]*?\|\//gi) || [];
      for (var e = 0; e < ed2kMatches.length; e++) {
        add('ed2k', ed2kMatches[e], null);
      }

      var magnets = SharedUtils.extractProtocolLinks(scanText, 'magnet:?');
      for (var m = 0; m < magnets.length; m++) {
        add('magnet', magnets[m], null);
      }

      var httpRegex = /https?:\/\/[^\s<>"']+/gi;
      var match;
      while ((match = httpRegex.exec(scanText)) !== null) {
        addResourceCandidateWithText(match[0], contextText, offset + match.index);
      }

      var protocolRelativeRegex = /\/\/(?:(?:www\.)?pan\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?pan\.quark\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?115\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?(?:aliyundrive|alipan)\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?yun\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?drive\.uc\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?pan\.xunlei\.com\/s\/[^\s<>"'）)】\]]+)/gi;
      while ((match = protocolRelativeRegex.exec(scanText)) !== null) {
        addResourceCandidateWithText(match[0], contextText, offset + match.index);
      }

      var barePanRegex = /(?:^|[\s<>"'（(【\[])((?:www\.)?pan\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?pan\.quark\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?115\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?(?:aliyundrive|alipan)\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?yun\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?drive\.uc\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?pan\.xunlei\.com\/s\/[^\s<>"'）)】\]]+)/gi;
      while ((match = barePanRegex.exec(scanText)) !== null) {
        addResourceCandidateWithText(match[1], contextText, offset + match.index + match[0].indexOf(match[1]));
      }
    }

    scanResourceText(text, text, 0);
    var hrefTagRegex = /<(?:a|area)\b([^>]*)>/gi;
    var hrefTagMatch;
    while ((hrefTagMatch = hrefTagRegex.exec(rawHtml)) !== null) {
      var tagHref = SharedUtils.extractHtmlAttr(hrefTagMatch[1] || '', 'href');
      if (tagHref) {
        var decodedHref = SharedUtils.decodeHtmlEntities(tagHref);
        scanResourceText(decodedHref, decodedHref, 0);
      }
    }

    SharedUtils.forEachAnchorTag(rawHtml, function(attrs, body, openIndex, endIndex) {
      var href = SharedUtils.decodeHtmlEntities(SharedUtils.extractHtmlAttr(attrs, 'href'));
      if (!href || !SharedUtils.classifyResourceUrl(href)) return;
      var ctxStart = Math.max(0, openIndex - 220);
      var ctxEnd = Math.min(rawHtml.length, endIndex + 220);
      var contextText = SharedUtils.htmlToText(SharedUtils.decodeHtmlEntities(rawHtml.slice(ctxStart, ctxEnd)));
      var contextIndex = SharedUtils.htmlToText(SharedUtils.decodeHtmlEntities(rawHtml.slice(ctxStart, openIndex))).length;
      addResourceCandidateWithText(href, contextText, Math.max(0, contextIndex));
    });

    resources.passwords = this.mergeUniqueLimited(
      this.extractArchivePasswordsFromHtml(decoded),
      this.extractArchivePasswords(text),
      5
    );
    return this.normalizeResources(resources);
  },

  // 线性扫描 <a ...>正文</a>：与惰性正则 /<a\b([^>]*)>([\s\S]*?)<\/a>/ 同语义
  // （正文取到最近的 </a>，匹配后从闭合标签之后继续），但对含大量未闭合 <a 的
  // 病理输入保持 O(n) —— 正则版会对每个未闭合位置反复扫尾部，实测 1MB 可拖到分钟级
  forEachAnchorTag: function(html, callback) {
    html = String(html || '');
    var lower = html.toLowerCase();
    var openRegex = /<a\b([^>]*)>/gi;
    var m;
    while ((m = openRegex.exec(html)) !== null) {
      var bodyStart = openRegex.lastIndex;
      var close = lower.indexOf('</a>', bodyStart);
      if (close === -1) return; // 其后再无闭合标签，不可能有完整锚点
      var proceed = callback(m[1] || '', html.slice(bodyStart, close), m.index, close + 4);
      openRegex.lastIndex = close + 4;
      if (proceed === false) return;
    }
  },

  decodeHtmlEntities: function(text) {
    // 注意：&amp; 必须最后解码，否则 &amp;lt; 会被二次解码成 <（既是正确性问题也是注入面）
    return String(text || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&commat;/gi, '@')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, function(_, n) {
        var cp = parseInt(n, 10);
        if (!isFinite(cp) || cp < 0 || cp > 0x10FFFF) return _;
        try { return String.fromCodePoint ? String.fromCodePoint(cp) : String.fromCharCode(cp); } catch (e) { return _; }
      })
      .replace(/&#x([0-9a-f]+);/gi, function(_, n) {
        var cp = parseInt(n, 16);
        if (!isFinite(cp) || cp < 0 || cp > 0x10FFFF) return _;
        try { return String.fromCodePoint ? String.fromCodePoint(cp) : String.fromCharCode(cp); } catch (e) { return _; }
      })
      .replace(/&amp;/gi, '&');
  },

  htmlToText: function(html) {
    return String(html || '')
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|td|th|table|section)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n');
  },

  escapeHtml: function(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  restoreProtectedEmails: function(html) {
    return String(html || '').replace(/<[^>]*class\s*=\s*["'][^"']*__cf_email__[^"']*["'][^>]*data-cfemail\s*=\s*["']([0-9a-f]+)["'][^>]*>[\s\S]*?<\/[^>]+>/gi, function(match, hex) {
      return SharedUtils.decodeCloudflareEmail(hex) || match;
    }).replace(/<[^>]*data-cfemail\s*=\s*["']([0-9a-f]+)["'][^>]*class\s*=\s*["'][^"']*__cf_email__[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, function(match, hex) {
      return SharedUtils.decodeCloudflareEmail(hex) || match;
    });
  },

  decodeCloudflareEmail: function(hex) {
    if (!hex || hex.length < 4 || hex.length % 2 !== 0) return '';
    var key = parseInt(hex.slice(0, 2), 16);
    if (isNaN(key)) return '';
    var out = '';
    for (var i = 2; i < hex.length; i += 2) {
      var code = parseInt(hex.slice(i, i + 2), 16);
      if (isNaN(code)) return '';
      out += String.fromCharCode(code ^ key);
    }
    return out;
  },

  forEachHrefValue: function(html, callback) {
    var re = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    var m;
    while ((m = re.exec(String(html || ''))) !== null) {
      if (callback(m[1] || m[2] || m[3] || '', m.index) === false) return;
    }
  },

  extractProtocolLinks: function(text, marker) {
    var lower = text.toLowerCase();
    var markerLower = marker.toLowerCase();
    var links = [];
    var start = lower.indexOf(markerLower);
    while (start !== -1) {
      var next = lower.indexOf(markerLower, start + marker.length);
      if (next === -1) next = text.length;
      var part = text.slice(start, next);
      var end = part.search(/[\s<>"']/);
      if (end !== -1) part = part.slice(0, end);
      var cleaned = this.cleanResourceUrl(part);
      if (cleaned) links.push(cleaned);
      start = next < text.length ? next : -1;
    }
    return links;
  },

  classifyResourceUrl: function(url) {
    var raw = String(url || '');
    try {
      var panUrl = new URL(SharedUtils.preparePanResourceUrlForParse(raw));
      var panType = SharedUtils.getPanResourceTypeFromParsedUrl(panUrl);
      if (panType) return panType;
    } catch (e) {}
    var L = raw.toLowerCase();
    if (/\.(?:zip|rar|7z|torrent)(?:[?#].*)?$/i.test(L)) return 'other';
    return null;
  },

  cleanResourceUrl: function(url) {
    var cleaned = String(url || '')
      .trim()
      .replace(/^[「『“”"'(\[【（《〈]+/, '');
    var trailingPunctuation = /[」』“”"'\])】）》〉>。；;，,、？！…]+$/g;
    if (/^ed2k:\/\//i.test(cleaned)) {
      // 深度防御：无论来源如何，最终链接内不允许残留换行（防复制内容注入伪造行）
      cleaned = cleaned.replace(/[\r\n]+/g, ' ');
      var ed2kEnd = cleaned.indexOf('|/');
      if (ed2kEnd !== -1) cleaned = cleaned.slice(0, ed2kEnd + 2);
      return cleaned.replace(trailingPunctuation, '');
    }
    if (/^magnet:\?/i.test(cleaned)) {
      cleaned = cleaned.replace(/(btih:[A-Fa-f0-9]{32,40})(?:[。；;，,、\s]*)?(?:提取码|提取密码|访问码|取件码|解压密码|压缩密码|解压码|解压口令|解壓密碼|解壓碼|密码)\s*[:：=]?.*$/i, '$1');
      cleaned = cleaned.replace(/[。；;，,、\s]+(?:(?:提取码|提取密码|访问码|取件码|解压密码|压缩密码|解压码|解压口令|解壓密碼|解壓碼)\s*[:：=]?|密码\s*[:：=]).*$/i, '');
      return cleaned.replace(trailingPunctuation, '');
    }
    if (/(?:pan\.baidu\.com|yun\.baidu\.com|pan\.quark\.cn|115\.com\/s\/|(?:aliyundrive|alipan)\.com\/s\/|drive\.uc\.cn\/s\/|pan\.xunlei\.com\/s\/)/i.test(cleaned)) {
      cleaned = cleaned.replace(/(?:[。；;，,、\s]*)?(?:提取码|提取密码|访问码|取件码|解压密码|压缩密码|密码)\s*[:：=]?.*$/i, '');
      return cleaned.replace(/[」』“”"'\])】）》〉>。；;，,、？！…][\s\S]*$/g, '');
    }
    if (/^(?:https?:)?\/\/xia\.ewrewej\.la\//i.test(cleaned) || /(?:forum\.php\?|attachment\.php\?|misc\.php\?)/i.test(cleaned)) {
      cleaned = cleaned.replace(/[」』“”"'\])】）》〉>。；;，,、？！…][\s\S]*$/g, '');
      return cleaned;
    }
    cleaned = cleaned.replace(/(\.(?:jpg|jpeg|png|gif|webp|txt|zip|rar|7z|torrent)(?:[?#][^」』“”"'\])】）》〉>。；;，,、？！…\s<]*)?)[」』“”"'\])】）》〉>。；;，,、？！…][\s\S]*$/i, '$1');
    return cleaned.replace(trailingPunctuation, '');
  },

  extractAccessCode: function(url, text, linkIndex) {
    try {
      var u = new URL(url);
      var pwd = this.extractAccessCodeFromUrlQuery(u);
      if (pwd) return pwd;
    } catch (e) {}

    text = String(text || '');
    var start = typeof linkIndex === 'number' ? linkIndex : Math.max(0, text.indexOf(url));
    if (start > text.length) {
      var urlIndex = text.indexOf(url);
      start = urlIndex >= 0 ? urlIndex : text.length;
    }
    if (start < 0) start = 0;
    var nearbyStart = Math.max(0, start - 100);
    var nearbyEnd = Math.min(text.length, start + 220);
    var currentLinkEnd = start + 1;
    if (url && text.slice(start, start + String(url).length) === String(url)) {
      currentLinkEnd = start + String(url).length;
    }

    function hasResourceMarker(segment) {
      return /(?:https?:\/\/|\/\/)?(?:www\.)?(?:pan\.baidu\.com\/(?:s\/|share\/)|yun\.baidu\.com\/(?:s\/|share\/)|pan\.quark\.cn\/s\/|115\.com\/s\/|(?:aliyundrive|alipan)\.com\/s\/|drive\.uc\.cn\/s\/|pan\.xunlei\.com\/s\/)/i.test(segment);
    }

    function crossesAnotherResource(candidateStart, candidateEnd) {
      if (candidateStart >= start) {
        return hasResourceMarker(text.slice(currentLinkEnd, candidateStart));
      }
      return hasResourceMarker(text.slice(candidateEnd, start));
    }

    var bestCandidate = null;

    function collect(regex, skipArchivePassword) {
      var nearby = text.slice(nearbyStart, nearbyEnd);
      var m;
      regex.lastIndex = 0;
      while ((m = regex.exec(nearby)) !== null) {
        var absolute = nearbyStart + m.index;
        // 「密码/提取码」标签后直接跟裸链接时，会把 URL 自身的 scheme 误捕为提取码
        if (/^(?:https?|www|ftp|com|net|org|ed2k|magnet|thunder)$/i.test(m[1])) continue;
        if (skipArchivePassword && /解压密码|压缩密码/.test(text.slice(Math.max(0, absolute - 2), absolute + 4))) continue;
        if (crossesAnotherResource(absolute, absolute + m[0].length)) continue;
        var score;
        if (absolute >= start) {
          score = absolute - start;
        } else {
          score = (start - absolute) + 240;
        }
        if (!bestCandidate || score < bestCandidate.score) {
          bestCandidate = { code: m[1], score: score };
        }
      }
    }

    collect(/(?:提取码|提取密码|访问码|取件码|提取)\s*[:：=]?\s*([A-Za-z0-9]{3,12})/gi, false);
    collect(/密码\s*[:：=]?\s*([A-Za-z0-9]{3,12})/gi, true);
    return bestCandidate ? bestCandidate.code : '';
  },

  extractArchivePasswords: function(text) {
    var result = [];
    var seen = {};
    var regex = /[【\[\(（「『]?\s*(?:解压密码|压缩密码|解压码|解压口令|解壓密碼|解壓碼)\s*[】\]\)）」』]?\s*[:：=]?\s*/gi;
    var m;
    while ((m = regex.exec(text)) !== null) {
      var rest = text.slice(regex.lastIndex).replace(/^[\s\u00a0]+/, '');
      var stop = rest.search(/\n|(?:链接|下载链接|提取码|提取密码|访问码|ed2k:\/\/|magnet:\?|https?:\/\/)\s*/i);
      var raw = stop === -1 ? rest : rest.slice(0, stop);
      var val = this.cleanPasswordValue(raw);
      if (!val || seen[val]) continue;
      seen[val] = true;
      result.push(val);
      if (result.length >= 5) break;
    }
    return result;
  },

  extractArchivePasswordsFromHtml: function(html) {
    var result = [];
    var seen = {};
    var fieldRegex = /[【\[\(（「『]?\s*(?:解压密码|压缩密码|解压码|解压口令|解壓密碼|解壓碼)\s*[】\]\)）」』]?\s*[:：=]?\s*/gi;
    var m;
    while ((m = fieldRegex.exec(html)) !== null) {
      var rest = html.slice(fieldRegex.lastIndex, fieldRegex.lastIndex + 500);
      var boundary = rest.search(/(?:<\s*br\s*\/?\s*>|<\/(?:p|div|li|tr|td|th)>|\n|(?:链接|下载链接|提取码|提取密码|访问码|ed2k:\/\/|magnet:\?|https?:\/\/))/i);
      var raw = boundary === -1 ? rest : rest.slice(0, boundary);
      var restored = this.restoreMailtoPassword(raw);
      var val = this.cleanPasswordValue(restored || this.htmlToText(this.decodeHtmlEntities(raw)));
      if (!val || seen[val]) continue;
      seen[val] = true;
      result.push(val);
      if (result.length >= 5) break;
    }
    return result;
  },

  restoreMailtoPassword: function(html) {
    var decoded = this.decodeHtmlEntities(String(html || ''));
    var mailtoRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    var match;
    while ((match = mailtoRegex.exec(decoded)) !== null) {
      var attrs = match[1] || '';
      var href = this.extractHtmlAttr(attrs, 'href');
      var label = this.htmlToText(this.decodeHtmlEntities(match[2])).trim();
      var values = [href, this.extractHtmlAttr(attrs, 'title'), label];
      var dataValues = this.extractDataAttrValues(attrs);
      for (var di = 0; di < dataValues.length; di++) {
        values.push(dataValues[di]);
      }
      var before = decoded.slice(0, match.index);
      var after = decoded.slice(mailtoRegex.lastIndex, mailtoRegex.lastIndex + 12);
      var prefix = this.extractAdjacentPasswordPrefix(before);
      var suffix = this.extractAdjacentPasswordSuffix(after);
      for (var i = 0; i < values.length; i++) {
        var mail = this.normalizeMailValue(values[i]);
        if (!mail || this.isProtectedEmailPlaceholder(mail)) continue;
        if (mail.indexOf('@') !== -1) return mail;
        if (suffix) return mail.replace(/@+$/, '') + suffix;
        if (prefix && href && values[i] === href) return prefix + '@' + mail.replace(/^@+/, '');
      }
    }
    return '';
  },

  extractAdjacentPasswordPrefix: function(beforeHtml) {
    var text = this.htmlToText(this.decodeHtmlEntities(String(beforeHtml || '')));
    text = text.replace(/[\s:：=】\]\)）」』>》]+$/g, '').trim();
    var m = text.match(/([A-Za-z0-9]{1,12})$/);
    if (!m) return '';
    var prefix = m[1];
    if (/^(?:www|http|https|com|net|org)$/i.test(prefix)) return '';
    return prefix;
  },

  extractAdjacentPasswordSuffix: function(afterHtml) {
    var text = this.htmlToText(this.decodeHtmlEntities(String(afterHtml || '')));
    text = text.replace(/^[\s:：=]+/, '');
    if (text.charAt(0) === '@') return '@';
    return '';
  },

  extractHtmlAttr: function(attrs, name) {
    var re = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", 'i');
    var m = re.exec(String(attrs || ''));
    return m ? (m[1] || m[2] || m[3] || '') : '';
  },

  extractDataAttrValues: function(attrs) {
    var values = [];
    var re = /(?:^|\s)data-[\w-]+\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    var m;
    while ((m = re.exec(String(attrs || ''))) !== null) {
      values.push(m[1] || m[2] || m[3] || '');
    }
    return values;
  },

  normalizeMailValue: function(value) {
    var v = this.decodeHtmlEntities(String(value || '')).trim();
    if (!v) return '';
    v = this.decodeUriComponentSafe(v);
    v = this.decodeHtmlEntities(v).trim();
    v = v.replace(/^mailto\s*:/i, '').trim();
    v = v.replace(/\?.*$/, '').trim();
    v = this.decodeUriComponentSafe(v);
    return v.replace(/^[\s:：=]+/, '').replace(/[。；;，,、\s]+$/g, '');
  },

  decodeUriComponentSafe: function(value) {
    try {
      return decodeURIComponent(String(value || '').replace(/\+/g, '%20'));
    } catch (e) {
      return String(value || '');
    }
  },

  isProtectedEmailPlaceholder: function(value) {
    var v = String(value || '').replace(/\s+/g, '').toLowerCase();
    return v.indexOf('[emailprotected]') !== -1 || v.indexOf('[email\u00a0protected]') !== -1;
  },

  mergeUnique: function(primary, secondary) {
    var result = [];
    var seen = {};
    var primaryList = primary || [];
    function conflictsPrimary(v) {
      for (var j = 0; j < primaryList.length; j++) {
        if (SharedUtils.passwordLooksSame(primaryList[j], v)) return true;
      }
      return false;
    }
    function addAll(items) {
      for (var i = 0; i < (items || []).length; i++) {
        var v = items[i];
        if (!v || seen[v]) continue;
        if (SharedUtils.isProtectedEmailPlaceholder(v)) continue;
        if (items !== primaryList && conflictsPrimary(v)) continue;
        seen[v] = true;
        result.push(v);
      }
    }
    addAll(primaryList);
    addAll(secondary || []);
    return result;
  },

  mergeUniqueLimited: function(primary, secondary, limit) {
    var result = [];
    var seen = {};
    var primaryList = primary || [];
    limit = Math.max(0, limit || 0);
    function conflictsPrimary(v) {
      for (var j = 0; j < primaryList.length; j++) {
        if (SharedUtils.passwordLooksSame(primaryList[j], v)) return true;
      }
      return false;
    }
    function addAll(items) {
      for (var i = 0; i < (items || []).length && result.length < limit; i++) {
        var v = items[i];
        if (!v || seen[v]) continue;
        if (SharedUtils.isProtectedEmailPlaceholder(v)) continue;
        if (items !== primaryList && conflictsPrimary(v)) continue;
        seen[v] = true;
        result.push(v);
      }
    }
    if (!limit) return result;
    addAll(primaryList);
    addAll(secondary || []);
    return result;
  },

  passwordLooksSame: function(a, b) {
    a = String(a || '');
    b = String(b || '');
    if (!a || !b) return false;
    var compactA = a.replace(/[\s@]+/g, '').toLowerCase();
    var compactB = b.replace(/[\s@]+/g, '').toLowerCase();
    return compactA && compactA === compactB;
  },

  cleanPasswordValue: function(value) {
    var v = String(value || '').trim();
    if (!v) return '';
    v = v.replace(/^[\s:：=】\]\)）」』>》]+/, '').trim();
    v = v.replace(/[。；;，,、\s]+$/g, '');
    if (!v) return '';
    if (this.isInvalidPasswordValue(v)) return '';
    if (this.isProtectedEmailPlaceholder(v)) return '';
    var separator = /\s+/.exec(v);
    if (separator && /[\u4e00-\u9fa5]/.test(v.substring(separator.index + separator[0].length))) {
      v = v.substring(0, separator.index);
    }
    return v.slice(0, 80);
  },

  // 线性剔除注释/textarea/noscript/title 区域（这些内容不会被渲染，DOM 提取路径天然不含它们）。
  // 不用惰性正则做剔除：大量未闭合 <!-- 会让每次匹配尝试扫到串尾，退化为 O(n²)
  stripNonRenderedHtmlRegions: function(html) {
    html = String(html || '');
    var lower = html.toLowerCase();
    var markers = [
      { open: '<!--', close: '-->' },
      { open: '<textarea', close: '</textarea>' },
      { open: '<noscript', close: '</noscript>' },
      { open: '<title', close: '</title>' }
    ];
    var out = '';
    var pos = 0;
    while (pos < html.length) {
      var nextIdx = -1;
      var nextMarker = null;
      for (var i = 0; i < markers.length; i++) {
        var idx = lower.indexOf(markers[i].open, pos);
        if (idx !== -1 && (nextIdx === -1 || idx < nextIdx)) {
          nextIdx = idx;
          nextMarker = markers[i];
        }
      }
      if (nextIdx === -1) {
        out += pos === 0 ? html : html.slice(pos);
        break;
      }
      out += html.slice(pos, nextIdx) + ' ';
      var closeIdx = lower.indexOf(nextMarker.close, nextIdx + nextMarker.open.length);
      if (closeIdx === -1) break; // 未闭合：其后内容按非渲染处理（与 DOM 解析吞并行为一致）
      pos = closeIdx + nextMarker.close.length;
    }
    return out || html.slice(0, 0);
  },

  extractImagesByRegex: function(html, baseUrl, maxCount, options) {
    maxCount = maxCount || 100;
    html = String(html || '');
    if (html.length > 1000000) html = html.slice(0, 1000000);
    // 对齐 DOM 提取路径：跳过注释/textarea 等非渲染区域中的「图片」
    html = SharedUtils.stripNonRenderedHtmlRegions(html);
    var images = [], seen = {};
    var canContinue = SharedUtils.createImageCollectionGuard(images, maxCount, options, 250);
    function resolveImageUrl(url) {
      url = SharedUtils.cleanResourceUrl(SharedUtils.decodeHtmlEntities(url));
      var r = SharedUtils.resolveUrl(baseUrl, url);
      if (!r || !SharedUtils.isMeaningfulImage(r)) return '';
      return r;
    }
    function firstResolved(candidates) {
      for (var i = 0; i < (candidates || []).length; i++) {
        var item = candidates[i];
        var url = resolveImageUrl(item && item.url);
        if (url) return { url: url, source: item.source || 'unknown' };
      }
      return null;
    }
    function shouldPreferDisplay(next, existing) {
      if (!next || !existing) return false;
      var existingPreview = SharedUtils.getImagePreviewSrc(existing);
      var nextPreview = SharedUtils.getImagePreviewSrc(next);
      if (SharedUtils.normalizeImageUrl(existingPreview) !== SharedUtils.normalizeImageUrl(nextPreview)) return false;
      var existingDisplay = SharedUtils.getImageDisplaySrc(existing);
      var nextDisplay = SharedUtils.getImageDisplaySrc(next);
      if (!nextDisplay || SharedUtils.normalizeImageUrl(existingDisplay) === SharedUtils.normalizeImageUrl(nextDisplay)) return false;
      if (SharedUtils.normalizeImageUrl(existingDisplay) === SharedUtils.normalizeImageUrl(existingPreview)) return true;
      if (SharedUtils.isHeavyImageUrl(existingDisplay) && !SharedUtils.isHeavyImageUrl(nextDisplay)) return true;
      return false;
    }
    function addCandidate(displayCandidates, previewCandidates, source) {
      var preview = firstResolved(previewCandidates);
      var display = firstResolved(displayCandidates);
      if (!preview && display) preview = display;
      if (!display && preview) display = preview;
      if (!preview || !display) return false;
      var normalized = SharedUtils.normalizeImageUrl(preview.url);
      var candidate = {
        src: display.url,
        source: source || preview.source,
        displaySource: display.source,
        previewSource: preview.source
      };
      if (SharedUtils.normalizeImageUrl(display.url) !== normalized) {
        candidate.previewSrc = preview.url;
      }
      if (seen[normalized] !== undefined) {
        if (shouldPreferDisplay(candidate, images[seen[normalized]])) {
          images[seen[normalized]].src = candidate.src;
          images[seen[normalized]].displaySource = candidate.displaySource;
          if (candidate.previewSrc) images[seen[normalized]].previewSrc = candidate.previewSrc;
        }
        return true;
      }
      seen[normalized] = images.length;
      images.push(candidate);
      return true;
    }
    function add(url, source) {
      return addCandidate([{ url: url, source: source }], [{ url: url, source: source }], source);
    }
    function addBestFromImgTag(tag) {
      var attrs = String(tag || '');
      var srcset = SharedUtils.extractHtmlAttr(attrs, 'srcset');
      var src = SharedUtils.extractHtmlAttr(attrs, 'src');
      var srcsetUrls = SharedUtils.getSrcsetUrls(srcset);
      var smallSrcset = srcsetUrls.smallest;
      var bestSrcset = srcsetUrls.best;
      var candidates = [
        { url: SharedUtils.extractHtmlAttr(attrs, 'file') || SharedUtils.extractHtmlAttr(attrs, 'zoomfile'), source: 'file/regex' },
        { url: SharedUtils.extractHtmlAttr(attrs, 'data-original'), source: 'data-original' },
        { url: SharedUtils.extractHtmlAttr(attrs, 'data-src'), source: 'data-src' },
        { url: bestSrcset, source: 'srcset' },
        { url: src, source: 'img-src' }
      ];
      var displayCandidates = [
        { url: SharedUtils.extractHtmlAttr(attrs, 'data-thumb'), source: 'data-thumb' },
        { url: SharedUtils.extractHtmlAttr(attrs, 'data-thumbnail'), source: 'data-thumbnail' },
        { url: SharedUtils.extractHtmlAttr(attrs, 'thumb'), source: 'thumb' },
        { url: src, source: 'img-src' },
        { url: smallSrcset, source: 'srcset-small' },
        { url: bestSrcset, source: 'srcset' }
      ];
      addCandidate(displayCandidates, candidates, 'img/regex');
    }

    // class 按空白分隔的完整 token 匹配 zoom（对齐 DOM 的 .zoom 选择器；子串匹配会误中 zoombie 等）
    var zoomRegex = /<(?:img|a|span|ignore_js_op)[^>]*class\s*=\s*["'](?:[^"']*\s)?zoom(?:\s[^"']*)?["'][^>]*(?:file|zoomfile)\s*=\s*["']([^"']+)["'][^>]*>/gi;
    var zoomRevRegex = /<(?:img|a|span|ignore_js_op)[^>]*(?:file|zoomfile)\s*=\s*["']([^"']+)["'][^>]*class\s*=\s*["'](?:[^"']*\s)?zoom(?:\s[^"']*)?["'][^>]*>/gi;
    var zoomFileOnlyRegex = /<[^>]*\szoomfile\s*=\s*["']([^"']+)["'][^>]*>/gi;
    var m;
    while (canContinue() && (m = zoomRegex.exec(html)) !== null) { add(m[1], 'zoom/regex'); }
    while (canContinue() && (m = zoomRevRegex.exec(html)) !== null) { add(m[1], 'zoomfile/regex'); }
    while (canContinue() && (m = zoomFileOnlyRegex.exec(html)) !== null) { add(m[1], 'zoomfile/standalone'); }

    var fileRegex = /<(?:img|a)[^>]*\sfile\s*=\s*["']([^"']+)["'][^>]*>/gi;
    while (canContinue() && (m = fileRegex.exec(html)) !== null) { add(m[1], 'file/regex'); }

    var imgTagRegex = /<img\b[^>]*>/gi;
    while (canContinue() && (m = imgTagRegex.exec(html)) !== null) {
      addBestFromImgTag(m[0]);
    }

    SharedUtils.forEachHrefValue(html, function(href) {
      if (SharedUtils.isDirectImageUrl(href)) add(href, 'link-href');
      if (!canContinue()) return false;
    });

    var linkRegex = /<a[^>]+href\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|gif|webp)(?:[?#][^"']*)?)["'][^>]*>/gi;
    while (canContinue() && (m = linkRegex.exec(html)) !== null) { add(m[1], 'link'); }

    var og = SharedUtils.extractOgImage(html, baseUrl);
    if (og && canContinue()) { add(og, 'og:image'); }

    return SharedUtils.limitImageResults(images, maxCount);
  },

  limitImageResults: function(images, maxCount) {
    if (!Array.isArray(images)) return [];
    var limit = Math.max(0, Math.floor(Number(maxCount) || 0));
    if (images.length > limit) images.length = limit;
    return images;
  },

  extractImagesByDom: function(html, baseUrl, maxCount, options) {
    maxCount = maxCount || 100;
    html = SharedUtils.limitArticleHtml(html);
    if (html.length > SharedUtils.DOM_IMAGE_EXTRACT_HTML_MAX_CHARS) {
      return SharedUtils.extractImagesByRegex(html, baseUrl, maxCount, options);
    }
    var images = [], seen = {};
    var canContinue = SharedUtils.createImageCollectionGuard(images, maxCount, options, 250);

    function resolveImageUrl(src) {
      if (!src) return false;
      src = SharedUtils.cleanResourceUrl(SharedUtils.decodeHtmlEntities(src));
      var url = SharedUtils.resolveUrl(baseUrl, src);
      if (!url) return false;
      if (!SharedUtils.isMeaningfulImage(url)) return false;
      return url;
    }
    function firstResolved(candidates) {
      for (var i = 0; i < (candidates || []).length; i++) {
        var item = candidates[i];
        var url = resolveImageUrl(item && item.url);
        if (url) return { url: url, source: item.source || 'unknown' };
      }
      return null;
    }
    function shouldPreferDisplay(next, existing) {
      if (!next || !existing) return false;
      var existingPreview = SharedUtils.getImagePreviewSrc(existing);
      var nextPreview = SharedUtils.getImagePreviewSrc(next);
      if (SharedUtils.normalizeImageUrl(existingPreview) !== SharedUtils.normalizeImageUrl(nextPreview)) return false;
      var existingDisplay = SharedUtils.getImageDisplaySrc(existing);
      var nextDisplay = SharedUtils.getImageDisplaySrc(next);
      if (!nextDisplay || SharedUtils.normalizeImageUrl(existingDisplay) === SharedUtils.normalizeImageUrl(nextDisplay)) return false;
      if (SharedUtils.normalizeImageUrl(existingDisplay) === SharedUtils.normalizeImageUrl(existingPreview)) return true;
      if (SharedUtils.isHeavyImageUrl(existingDisplay) && !SharedUtils.isHeavyImageUrl(nextDisplay)) return true;
      return false;
    }
    function addCandidate(displayCandidates, previewCandidates, source) {
      var preview = firstResolved(previewCandidates);
      var display = firstResolved(displayCandidates);
      if (!preview && display) preview = display;
      if (!display && preview) display = preview;
      if (!preview || !display) return false;
      var normalized = SharedUtils.normalizeImageUrl(preview.url);
      var candidate = {
        src: display.url,
        source: source || preview.source,
        displaySource: display.source,
        previewSource: preview.source
      };
      if (SharedUtils.normalizeImageUrl(display.url) !== normalized) {
        candidate.previewSrc = preview.url;
      }
      if (seen[normalized] !== undefined) {
        if (shouldPreferDisplay(candidate, images[seen[normalized]])) {
          images[seen[normalized]].src = candidate.src;
          images[seen[normalized]].displaySource = candidate.displaySource;
          if (candidate.previewSrc) images[seen[normalized]].previewSrc = candidate.previewSrc;
        }
        return true;
      }
      seen[normalized] = images.length;
      images.push(candidate);
      return true;
    }
    function addImage(src, source) {
      return addCandidate([{ url: src, source: source }], [{ url: src, source: source }], source);
    }

    var doc = new DOMParser().parseFromString(html, 'text/html');

    var zooms = doc.querySelectorAll('.zoom[file], .zoom[zoomfile], img.zoom[file], img.zoom[zoomfile], img[file], img[zoomfile]');
    for (var z = 0; z < zooms.length && canContinue(); z++) {
      var fv = zooms[z].getAttribute('file') || zooms[z].getAttribute('zoomfile');
      if (!fv) continue;
      addImage(fv, 'zoom/file');
    }

    var imgs = doc.querySelectorAll('img');
    for (var i = 0; i < imgs.length && canContinue(); i++) {
      var img = imgs[i];
      var srcset = img.getAttribute('srcset') || img.srcset;
      var srcsetUrls = SharedUtils.getSrcsetUrls(srcset);
      var bestSrcset = srcsetUrls.best;
      var smallSrcset = srcsetUrls.smallest;
      addCandidate([
        { url: img.getAttribute('data-thumb'), source: 'data-thumb' },
        { url: img.getAttribute('data-thumbnail'), source: 'data-thumbnail' },
        { url: img.getAttribute('thumb'), source: 'thumb' },
        { url: img.getAttribute('src'), source: 'img-src' },
        { url: smallSrcset, source: 'srcset-small' },
        { url: bestSrcset, source: 'srcset' }
      ], [
        { url: img.getAttribute('file') || img.getAttribute('zoomfile'), source: 'file' },
        { url: img.getAttribute('data-original'), source: 'data-original' },
        { url: img.getAttribute('data-src'), source: 'data-src' },
        { url: bestSrcset, source: 'srcset' },
        { url: img.getAttribute('src'), source: 'img-src' }
      ], 'img');
    }

    var links = doc.querySelectorAll('a[href]');
    for (var l = 0; l < links.length && canContinue(); l++) {
      var href = links[l].getAttribute('href');
      if (href && SharedUtils.isDirectImageUrl(href)) {
        addImage(href, 'link');
      }
    }

    var ogImage = SharedUtils.extractOgImage(html, baseUrl);
    if (ogImage && canContinue()) {
      addImage(ogImage, 'og:image');
    }

    return SharedUtils.limitImageResults(images, maxCount);
  },

  extractImages: function(html, baseUrl, maxCount, options) {
    if (typeof DOMParser !== 'undefined') {
      try {
        return SharedUtils.extractImagesByDom(html, baseUrl, maxCount, options);
      } catch (e) {
        // DOMParser unavailable or parse failed, fall back to regex
      }
    }
    return SharedUtils.extractImagesByRegex(html, baseUrl, maxCount, options);
  },

  isInvalidPasswordValue: function(value) {
    var v = String(value || '')
      .replace(/<[^>]+>/g, '')
      .replace(/[\s\u00a0\u200b-\u200d\ufeff]/g, '')
      .replace(/[。；;，,、:：=]/g, '')
      .toLowerCase();
    if (!v) return true;
    var explicitPlaceholders = {
      '\u65e0': true,
      '\u65e0\u5bc6\u7801': true,
      '\u6682\u65e0': true,
      '\u89c1\u56fe': true,
      '\u770b\u56fe': true,
      '\u89c1\u622a\u56fe': true,
      '[emailprotected]': true,
      '[email protected]': true,
      '...': true,
      '\u2026': true,
      '\u2026\u2026': true
    };
    if (explicitPlaceholders[v]) return true;
    return /^(?:\.{1,}|…+|-+|暂无|无|无密码|見圖|见图|看图|见截图|\[emailprotected\])$/.test(v);
  },

  CACHE_GENERATION_KEY: 'atp_cache_generation_v1',

  CACHE_INDEX_KEY: 'atp_cache_index_v1',

  cacheIndex: {
    TYPE: { IMAGE: 0, TEXT_RESOURCE: 1, ARTICLE: 2, NEGATIVE: 3, TEXT_FAIL: 4 },

    _queue: [],
    _queueOffset: 0,
    _writing: false,
    _backgroundOwner: false,

    _storageError: function(action) {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.lastError) return false;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[cacheIndex] ' + action + ':', chrome.runtime.lastError.message);
      }
      return true;
    },

    _warn: function(action, error) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[cacheIndex] ' + action + (error ? ': ' + (error.message || error) : ''));
      }
    },

    _invokeCallback: function(callback, args) {
      if (!callback) return;
      try {
        callback.apply(null, args || []);
      } catch (e) {
        SharedUtils.cacheIndex._warn('callback failed', e);
      }
    },

    _shouldProxyMutation: function() {
      return !SharedUtils.cacheIndex._backgroundOwner &&
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.sendMessage === 'function';
    },

    _failUnavailableMutation: function(action, resultType, callback) {
      SharedUtils.cacheIndex._warn('background ' + action + ' unavailable');
      SharedUtils.cacheIndex._invokeCallback(callback, [resultType === 'entries' ? null : false]);
    },

    _finishProxyMutation: function(action, resultType, callback, response) {
      if (SharedUtils.cacheIndex._storageError('background ' + action + ' failed')) {
        SharedUtils.cacheIndex._invokeCallback(callback, [resultType === 'entries' ? null : false]);
        return;
      }
      if (!response || response.ok !== true) {
        SharedUtils.cacheIndex._invokeCallback(callback, [resultType === 'entries' ? null : false]);
        return;
      }
      SharedUtils.cacheIndex._invokeCallback(callback, [resultType === 'entries' ? (response.entries || {}) : true]);
    },

    _proxyMutation: function(action, payload, resultType, callback) {
      if (!SharedUtils.cacheIndex._shouldProxyMutation()) return false;
      var message = { type: SharedUtils.MESSAGE_TYPES.CACHE_INDEX_MUTATION, action: action };
      payload = payload || {};
      for (var key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) message[key] = payload[key];
      }
      try {
        chrome.runtime.sendMessage(message, function(response) {
          SharedUtils.cacheIndex._finishProxyMutation(action, resultType, callback, response);
        });
      } catch (e) {
        SharedUtils.cacheIndex._warn('background ' + action + ' failed', e);
        SharedUtils.cacheIndex._invokeCallback(callback, [resultType === 'entries' ? null : false]);
      }
      return true;
    },

    _enqueue: function(item) {
      SharedUtils.cacheIndex._queue.push(item);
      SharedUtils.cacheIndex._drain();
    },

    _copyUpdateQueueItem: function(updates, callbacks, item) {
      if (!item || !item.updates) return;
      for (var key in item.updates) {
        if (Object.prototype.hasOwnProperty.call(item.updates, key)) {
          updates[key] = item.updates[key];
        }
      }
      if (item.callback) callbacks.push(item.callback);
    },

    _takeMergedUpdateQueueItem: function(first) {
      var updates = {};
      var callbacks = [];
      SharedUtils.cacheIndex._copyUpdateQueueItem(updates, callbacks, first);
      while (SharedUtils.cacheIndex._queueOffset < SharedUtils.cacheIndex._queue.length) {
        var next = SharedUtils.cacheIndex._queue[SharedUtils.cacheIndex._queueOffset];
        if (!next || next.kind !== 'updateEntries') break;
        SharedUtils.cacheIndex._queueOffset++;
        SharedUtils.cacheIndex._copyUpdateQueueItem(updates, callbacks, next);
      }
      return {
        kind: 'mergedUpdateEntries',
        run: function(done) {
          SharedUtils.cacheIndex._runUpdateEntries(updates, callbacks, done);
        }
      };
    },

    _finishUpdateEntries: function(callbacks, success, done) {
      try {
        for (var i = 0; i < callbacks.length; i++) {
          SharedUtils.cacheIndex._invokeCallback(callbacks[i], [success]);
        }
      } finally {
        done();
      }
    },

    _finishQueueCallback: function(callback, args, done) {
      try {
        SharedUtils.cacheIndex._invokeCallback(callback, args || []);
      } finally {
        done();
      }
    },

    _runUpdateEntries: function(updates, callbacks, done) {
      SharedUtils.cacheIndex.read(function(entries, readFailed) {
        if (readFailed) {
          SharedUtils.cacheIndex._finishUpdateEntries(callbacks, false, done);
          return;
        }
        function writeEntries(targetEntries) {
          for (var updateKey in updates) {
            if (Object.prototype.hasOwnProperty.call(updates, updateKey)) {
              targetEntries[updateKey] = updates[updateKey];
            }
          }
          SharedUtils.cacheIndex._writeNow(targetEntries, function(success) {
            SharedUtils.cacheIndex._finishUpdateEntries(callbacks, success, done);
          });
        }
        if (!entries) {
          SharedUtils.cacheIndex._scanEntriesNow(function(newEntries) {
            if (newEntries) writeEntries(newEntries);
            else SharedUtils.cacheIndex._finishUpdateEntries(callbacks, false, done);
          });
          return;
        }
        writeEntries(entries);
      });
    },

    _drain: function() {
      if (SharedUtils.cacheIndex._writing) return;
      if (SharedUtils.cacheIndex._queueOffset >= SharedUtils.cacheIndex._queue.length) {
        SharedUtils.cacheIndex._queue = [];
        SharedUtils.cacheIndex._queueOffset = 0;
        return;
      }
      var next = SharedUtils.cacheIndex._queue[SharedUtils.cacheIndex._queueOffset++];
      if (!next) return;
      if (next.kind === 'updateEntries') {
        next = SharedUtils.cacheIndex._takeMergedUpdateQueueItem(next);
      }
      SharedUtils.cacheIndex._writing = true;
      try {
        var run = next.run || next;
        run(function done() {
          SharedUtils.cacheIndex._writing = false;
          SharedUtils.cacheIndex._drain();
        });
      } catch (e) {
        SharedUtils.cacheIndex._writing = false;
        SharedUtils.cacheIndex._drain();
      }
    },

    read: function(callback) {
      chrome.storage.local.get(SharedUtils.CACHE_INDEX_KEY, function(result) {
        if (SharedUtils.cacheIndex._storageError('storage读取失败')) {
          callback(null, true);
          return;
        }
        var raw = result[SharedUtils.CACHE_INDEX_KEY];
        if (!raw || !raw.entries || typeof raw.entries !== 'object') {
          callback(null, false);
          return;
        }
        callback(raw.entries, false);
      });
    },

    _writeNow: function(entries, callback) {
      var d = {};
      d[SharedUtils.CACHE_INDEX_KEY] = { entries: entries };
      chrome.storage.local.set(d, function() {
        SharedUtils.cacheIndex._storageError('storage写入失败');
        if (callback) callback(!chrome.runtime.lastError);
      });
    },

    _invalidateNow: function(callback) {
      if (
        typeof chrome === 'undefined' ||
        !chrome.storage ||
        !chrome.storage.local ||
        typeof chrome.storage.local.remove !== 'function'
      ) {
        SharedUtils.cacheIndex._warn('storage索引失效不可用');
        if (callback) callback(false);
        return;
      }
      chrome.storage.local.remove(SharedUtils.CACHE_INDEX_KEY, function() {
        SharedUtils.cacheIndex._storageError('storage索引失效失败');
        if (callback) callback(!chrome.runtime.lastError);
      });
    },

    updateEntries: function(updates, callback) {
      var hasUpdates = false;
      for (var key in (updates || {})) {
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
          hasUpdates = true;
          break;
        }
      }
      if (!hasUpdates) {
        if (callback) callback(true);
        return;
      }
      if (SharedUtils.cacheIndex._proxyMutation('updateEntries', { updates: updates }, 'boolean', callback)) return;
      if (!SharedUtils.cacheIndex._backgroundOwner) {
        SharedUtils.cacheIndex._failUnavailableMutation('updateEntries', 'boolean', callback);
        return;
      }
      SharedUtils.cacheIndex._enqueue({
        kind: 'updateEntries',
        updates: updates,
        callback: callback
      });
    },

    removeEntries: function(keys, callback) {
      keys = keys || [];
      if (!keys.length) {
        if (callback) callback(true);
        return;
      }
      if (SharedUtils.cacheIndex._proxyMutation('removeEntries', { keys: keys }, 'boolean', callback)) return;
      if (!SharedUtils.cacheIndex._backgroundOwner) {
        SharedUtils.cacheIndex._failUnavailableMutation('removeEntries', 'boolean', callback);
        return;
      }
      SharedUtils.cacheIndex._enqueue({ kind: 'removeEntries', run: function(done) {
        SharedUtils.cacheIndex.read(function(entries, readFailed) {
          if (readFailed) {
            SharedUtils.cacheIndex._finishQueueCallback(callback, [false], done);
            return;
          }
          if (!entries) {
            SharedUtils.cacheIndex._finishQueueCallback(callback, [true], done);
            return;
          }
          var removedAny = false;
          for (var i = 0; i < keys.length; i++) {
            if (Object.prototype.hasOwnProperty.call(entries, keys[i])) {
              delete entries[keys[i]];
              removedAny = true;
            }
          }
          // 目标键都不在索引里时跳过整份索引重写（正向缓存命中清理 fail-key 的高频路径）
          if (!removedAny) {
            SharedUtils.cacheIndex._finishQueueCallback(callback, [true], done);
            return;
          }
          SharedUtils.cacheIndex._writeNow(entries, function(success) {
            SharedUtils.cacheIndex._finishQueueCallback(callback, [success], done);
          });
        });
      } });
    },

    _scanEntriesNow: function(callback) {
      chrome.storage.local.get(null, function(items) {
        if (SharedUtils.cacheIndex._storageError('storage重建扫描失败')) {
          callback(null);
          return;
        }
        var entries = {};
        var _P = SharedUtils.CACHE_PREFIXES;
        for (var key in items) {
          if (key === SharedUtils.CACHE_INDEX_KEY) continue;
          var type;
          if (key.indexOf(_P.IMAGE) === 0) {
            type = SharedUtils.cacheIndex.TYPE.IMAGE;
          } else if (SharedUtils.isHashedTextAttachmentCacheKey(key, _P.TEXT_RESOURCE)) {
            type = SharedUtils.cacheIndex.TYPE.TEXT_RESOURCE;
          } else if (SharedUtils.isHashedTextAttachmentCacheKey(key, _P.TEXT_FAIL)) {
            type = SharedUtils.cacheIndex.TYPE.TEXT_FAIL;
          } else if (key.indexOf(_P.ARTICLE) === 0) {
            type = SharedUtils.cacheIndex.TYPE.ARTICLE;
          } else if (key.indexOf(_P.NEGATIVE) === 0) {
            type = SharedUtils.cacheIndex.TYPE.NEGATIVE;
          } else {
            continue;
          }
          var val = items[key];
          var ts = (typeof val === 'object' && val !== null) ? (val.ts || 0) : (typeof val === 'number' ? val : 0);
          var valLen = SharedUtils.utf8ByteLength(
            (typeof val === 'object' && val !== null) ? JSON.stringify(val) : String(val)
          );
          entries[key] = { t: type, ts: ts, b: key.length + valLen };
        }
        callback(entries);
      });
    },

    _rebuildNow: function(callback) {
      SharedUtils.cacheIndex._scanEntriesNow(function(entries) {
        if (!entries) {
          callback(null);
          return;
        }
        SharedUtils.cacheIndex._writeNow(entries, function(success) {
          if (success) {
            callback(entries);
            return;
          }
          SharedUtils.cacheIndex._invalidateNow(function() {
            callback(null);
          });
        });
      });
    },

    rebuild: function(callback) {
      if (SharedUtils.cacheIndex._proxyMutation('rebuild', {}, 'entries', callback)) return;
      if (!SharedUtils.cacheIndex._backgroundOwner) {
        SharedUtils.cacheIndex._failUnavailableMutation('rebuild', 'entries', callback);
        return;
      }
      SharedUtils.cacheIndex._enqueue({ kind: 'rebuild', run: function(done) {
        SharedUtils.cacheIndex._rebuildNow(function(entries) {
          SharedUtils.cacheIndex._finishQueueCallback(callback, [entries], done);
        });
      } });
    },

    getStats: function(callback) {
      SharedUtils.cacheIndex.read(function(entries, readFailed) {
        if (readFailed) {
          SharedUtils.cacheIndex._statsFromEntries({}, callback);
          return;
        }
        if (!entries) {
          SharedUtils.cacheIndex.rebuild(function(newEntries) {
            SharedUtils.cacheIndex._statsFromEntries(newEntries || {}, callback);
          });
          return;
        }
        SharedUtils.cacheIndex._statsFromEntries(entries, callback);
      });
    },

    _statsFromEntries: function(entries, callback) {
      var count = 0;
      for (var key in entries) { count++; }
      callback({ count: count });
    }
  }
};
