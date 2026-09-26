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
    FETCH_TEXT_ATTACHMENTS_FRESH: 'FETCH_TEXT_ATTACHMENTS_FRESH',
    MIRROR_SITES_SYNC: 'MIRROR_SITES_SYNC',
    GET_FLOATING_PANEL_CSS: 'GET_FLOATING_PANEL_CSS',
    MARKS_MUTATION: 'MARKS_MUTATION'
  }),
  // Marked resources and the daily backup of exported/copied ones. The
  // reader's own data: no cache cleanup or eviction ever removes these keys.
  MARKS_STORAGE: Object.freeze({
    PREFIX: 'atp_marks_v1_',
    INDEX: 'atp_marks_v1_index',
    ITEM_PREFIX: 'atp_marks_v1_item_',
    DAYS: 'atp_marks_v1_days',
    DAY_PREFIX: 'atp_marks_v1_day_'
  }),

  // Storage keys of the marks and backups listed in their two indexes.
  getMarksStorageKeys: function(items) {
    var keys = [];
    var storage = SharedUtils.MARKS_STORAGE;
    var index = items && items[storage.INDEX];
    var days = items && items[storage.DAYS];
    if (index) keys.push(storage.INDEX);
    if (days) keys.push(storage.DAYS);
    if (index && Array.isArray(index.items)) {
      for (var i = 0; i < index.items.length; i++) {
        if (index.items[i] && typeof index.items[i].id === 'string') keys.push(storage.ITEM_PREFIX + encodeURIComponent(index.items[i].id));
      }
    }
    if (days && days.days && typeof days.days === 'object') {
      for (var date in days.days) {
        if (Object.prototype.hasOwnProperty.call(days.days, date)) keys.push(storage.DAY_PREFIX + date);
      }
    }
    return keys;
  },

  // Bytes the caches count against their budget. Marks and backups are
  // kept for good (the extension has unlimited storage), so they are left
  // out, or a large backup would make every cache write evict everything.
  // A storage error on the first read reaches the caller as usual.
  getCacheBytesInUse: function(callback) {
    var local = chrome.storage.local;
    local.getBytesInUse(null, function(total) {
      if (chrome.runtime.lastError) {
        callback(total);
        return;
      }
      var storage = SharedUtils.MARKS_STORAGE;
      // A failed read of the marks is not a failed usage read: answer outside
      // that callback so the caller does not see its error.
      function answer(bytes, fromFailedCall) {
        if (fromFailedCall) setTimeout(function() { callback(bytes); }, 0);
        else callback(bytes);
      }
      local.get([storage.INDEX, storage.DAYS], function(items) {
        if (chrome.runtime.lastError) {
          answer(total, true);
          return;
        }
        var keys = SharedUtils.getMarksStorageKeys(items);
        if (!keys.length) {
          answer(total, false);
          return;
        }
        local.getBytesInUse(keys, function(kept) {
          if (chrome.runtime.lastError) {
            answer(total, true);
            return;
          }
          answer(Math.max(0, (Number(total) || 0) - (Number(kept) || 0)), false);
        });
      });
    });
  },

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

  _isAnimatedGifUrlCache: null,

  // 论坛图床上的动图常有几 MB 到十几 MB：图床慢时十几张并发会把带宽占满、
  // 全部卡到任务截止被判失败，还挤掉同屏静态图的槽位。按 URL 路径识别，
  // 供加载器单独限流、放宽截止时间，以及首屏先排静态图。
  isAnimatedGifUrl: function(url) {
    if (!url) return false;
    var cache = SharedUtils._isAnimatedGifUrlCache;
    if (!cache) cache = SharedUtils._isAnimatedGifUrlCache = new Map();
    var hit = cache.get(url);
    if (hit !== undefined) return hit;
    var path = String(url);
    var cut = path.search(/[?#]/);
    if (cut !== -1) path = path.slice(0, cut);
    var result = /\.gif$/i.test(path);
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
    ARTICLE: 'article_cache_v12_',
    TEXT_RESOURCE: 'txt_resource_cache_v3_',
    TEXT_FAIL: 'atp_text_fail_v1_',
    TEXT_FAIL_BASE: 'atp_text_fail_',
    NEGATIVE: 'atp_empty_v9_',
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
    page: true,
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
    page: true,
    authorid: true,
    cp: true,
    viewpid: true,
    ordertype: true,
    stand: true,
    checkrush: true,
    action: true
  },

  IMAGE_DIRECT_PARAM_NAMES: ['url', 'src', 'img', 'image', 'pic', 'path', 'file'],

  resolveUrl: function(baseUrl, relativeUrl, alreadyDecoded) {
    if (!relativeUrl) return null;
    relativeUrl = (alreadyDecoded ? String(relativeUrl) : SharedUtils.decodeHtmlEntities(String(relativeUrl))).trim().replace(/\\\//g, '/');
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
        if (keepParamMap[k] || (k === 'from' && v === 'album')) newParams.push(k + '=' + encodeURIComponent(v));
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
      return u.protocol === 'https:' && SharedUtils.SIGNED_TEXT_DOWNLOAD_HOSTS.indexOf(u.hostname) !== -1 &&
        (/(?:^|\/)download(?:\/|$)/i.test(u.pathname) || /\.txt$/i.test(u.pathname));
    } catch (e) {
      return false;
    }
  },

  isAllowedTextAttachmentUrl: function(url, baseUrl) {
    try {
      var u = new URL(url, baseUrl || undefined);
      if (u.protocol !== 'https:') return false;
      var host = u.hostname;
      if (SharedUtils.isSupportedForumHost(host)) {
        return /\.txt$/i.test(u.pathname) || SharedUtils.isDiscuzAttachmentUrl(u.href, u.href);
      }
      if (SharedUtils.isSignedTextDownloadUrl(url, baseUrl)) return true;
      return SharedUtils.TEXT_DIRECT_DOWNLOAD_HOSTS.indexOf(host) !== -1 && /\.txt$/i.test(u.pathname);
    } catch (e) {
      return false;
    }
  },

  // Zone-aware TXT allowlist for work requested by a forum page: the
  // attachment must live on that page's own site or on a download relay.
  isTextAttachmentUrlAllowedInZone: function(url, zone, baseUrl) {
    if (!SharedUtils.isAllowedTextAttachmentUrl(url, baseUrl)) return false;
    if (!zone) return true;
    try {
      var host = new URL(url, baseUrl || undefined).hostname;
      return SharedUtils.isTextDownloadRelayHost(host) || SharedUtils.getForumSiteZone(host) === zone;
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

  // ---- Forum site registry ----
  // Built-in forum roots ship in the manifest. Mirror sites are forum mirrors
  // or reverse proxies the user approved as optional host permissions
  // (https://*.<root>/*); background.js registers content scripts for them.
  // Every forum-host decision goes through the functions below.
  BUILTIN_FORUM_ROOTS: Object.freeze(['sehuatang.org', 'sehuatang.net']),
  TEXT_DIRECT_DOWNLOAD_HOSTS: Object.freeze(['dl.ldkms.la']),
  SIGNED_TEXT_DOWNLOAD_HOSTS: Object.freeze(['xia.ewrewej.la']),
  MIRROR_SITES_STORAGE_KEY: 'atp_mirror_sites_v1',
  MIRROR_SITE_MAX_COUNT: 20,
  _mirrorSites: [],

  isHostWithinRoot: function(host, root) {
    host = String(host || '').toLowerCase();
    root = String(root || '').toLowerCase();
    if (!host || !root) return false;
    return host === root || (host.length > root.length + 1 && host.slice(-(root.length + 1)) === '.' + root);
  },

  getBuiltinForumRoot: function(host) {
    var roots = SharedUtils.BUILTIN_FORUM_ROOTS;
    for (var i = 0; i < roots.length; i++) {
      if (SharedUtils.isHostWithinRoot(host, roots[i])) return roots[i];
    }
    return '';
  },

  isBuiltinForumHost: function(host) {
    return !!SharedUtils.getBuiltinForumRoot(host);
  },

  isTextDownloadRelayHost: function(host) {
    host = String(host || '').toLowerCase();
    return SharedUtils.TEXT_DIRECT_DOWNLOAD_HOSTS.indexOf(host) !== -1 ||
      SharedUtils.SIGNED_TEXT_DOWNLOAD_HOSTS.indexOf(host) !== -1;
  },

  // '' when root may become a mirror, otherwise the rejection reason.
  getMirrorRootRejection: function(root) {
    root = String(root || '');
    if (root.length < 3 || root.length > 253) return 'invalid';
    if (/^[0-9.]+$/.test(root) || root.indexOf(':') !== -1 || root.charAt(0) === '[') return 'reserved';
    var labels = root.split('.');
    if (labels.length < 2) return 'invalid';
    for (var i = 0; i < labels.length; i++) {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(labels[i])) return 'invalid';
    }
    var tld = labels[labels.length - 1];
    if (/^[0-9]+$/.test(tld)) return 'invalid';
    if (tld === 'localhost') return 'reserved';
    if (SharedUtils.getBuiltinForumRoot(root)) return 'builtin';
    var relays = SharedUtils.TEXT_DIRECT_DOWNLOAD_HOSTS.concat(SharedUtils.SIGNED_TEXT_DOWNLOAD_HOSTS);
    for (var r = 0; r < relays.length; r++) {
      if (SharedUtils.isHostWithinRoot(relays[r], root) || SharedUtils.isHostWithinRoot(root, relays[r])) return 'reserved';
    }
    return '';
  },

  makeMirrorSite: function(root, subdomains) {
    subdomains = subdomains !== false;
    return { root: root, pattern: 'https://' + (subdomains ? '*.' : '') + root + '/*', subdomains: subdomains };
  },

  // Accepts a bare domain, host:port or a full https URL. A leading www. folds
  // into the wildcard so www.mirror.example and mirror.example both match.
  parseMirrorSiteInput: function(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return { ok: false, reason: 'empty' };
    if (raw.length > 2048) return { ok: false, reason: 'invalid' };
    var hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(?:https?|ftp|file|data|javascript|about|chrome|edge|blob):/i.test(raw);
    var url;
    try {
      url = new URL(hasScheme ? raw : 'https://' + raw);
    } catch (e) {
      return { ok: false, reason: 'invalid' };
    }
    if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
    if (url.username || url.password) return { ok: false, reason: 'invalid' };
    var host = url.hostname.toLowerCase();
    if (host.charAt(host.length - 1) === '.') host = host.slice(0, -1);
    if (host.indexOf('www.') === 0) host = host.slice(4);
    var rejection = SharedUtils.getMirrorRootRejection(host);
    if (rejection) return { ok: false, reason: rejection };
    return { ok: true, site: SharedUtils.makeMirrorSite(host, true) };
  },

  getMirrorSiteFromPattern: function(pattern) {
    var match = /^https:\/\/(\*\.)?([a-z0-9.-]+)\/\*$/.exec(String(pattern || '').toLowerCase());
    if (!match || SharedUtils.getMirrorRootRejection(match[2])) return null;
    return SharedUtils.makeMirrorSite(match[2], !!match[1]);
  },

  normalizeMirrorSites: function(list) {
    var valid = [];
    var seen = {};
    if (!Array.isArray(list)) return valid;
    for (var i = 0; i < list.length && i < 1000; i++) {
      var item = list[i];
      var site = null;
      if (typeof item === 'string') {
        site = SharedUtils.getMirrorSiteFromPattern(item);
      } else if (item && typeof item === 'object' && typeof item.root === 'string') {
        var root = item.root.toLowerCase();
        if (!SharedUtils.getMirrorRootRejection(root)) site = SharedUtils.makeMirrorSite(root, item.subdomains !== false);
      }
      if (!site || seen[site.pattern]) continue;
      seen[site.pattern] = true;
      valid.push(site);
    }
    valid.sort(function(a, b) {
      if (a.root !== b.root) return a.root < b.root ? -1 : 1;
      return a.subdomains === b.subdomains ? 0 : (a.subdomains ? -1 : 1);
    });
    return valid.slice(0, SharedUtils.MIRROR_SITE_MAX_COUNT);
  },

  getMirrorSitesFromOrigins: function(origins) {
    return SharedUtils.normalizeMirrorSites(Array.isArray(origins) ? origins : []);
  },

  setMirrorSites: function(list) {
    SharedUtils._mirrorSites = SharedUtils.normalizeMirrorSites(list);
    return SharedUtils.getMirrorSites();
  },

  getMirrorSites: function() {
    return SharedUtils._mirrorSites.map(function(site) {
      return { root: site.root, pattern: site.pattern, subdomains: site.subdomains };
    });
  },

  isHostInMirrorSite: function(host, site) {
    if (!site || !site.root) return false;
    host = String(host || '').toLowerCase();
    return site.subdomains ? SharedUtils.isHostWithinRoot(host, site.root) : host === site.root;
  },

  // The broadest matching grant defines the site, so www.* and bbs.* under
  // one wildcard share a zone even when a narrower grant also exists.
  getMirrorForumRoot: function(host) {
    var best = '';
    var mirrorSites = SharedUtils._mirrorSites;
    for (var i = 0; i < mirrorSites.length; i++) {
      if (!SharedUtils.isHostInMirrorSite(host, mirrorSites[i])) continue;
      if (!best || mirrorSites[i].root.length < best.length) best = mirrorSites[i].root;
    }
    return best;
  },

  // Content scripts only run on built-in or granted mirror hosts, so the
  // current page is trusted even while the stored mirror list lags behind.
  ensureCurrentForumSite: function(host) {
    host = String(host || '').toLowerCase();
    if (!host || SharedUtils.getSupportedForumRoot(host)) return;
    var root = host.indexOf('www.') === 0 ? host.slice(4) : host;
    if (SharedUtils.getMirrorRootRejection(root)) return;
    SharedUtils.setMirrorSites(SharedUtils._mirrorSites.concat([SharedUtils.makeMirrorSite(root, true)]));
  },

  getSupportedForumRoot: function(host) {
    return SharedUtils.getBuiltinForumRoot(host) || SharedUtils.getMirrorForumRoot(host);
  },

  isSupportedForumHost: function(host) {
    return !!SharedUtils.getSupportedForumRoot(host);
  },

  // Built-in roots share one operator and one zone; every mirror is its own
  // zone. A page may only have forum URLs from its own zone fetched, parsed
  // or served from cache, so a mirror never reads another site's session data.
  getForumSiteZone: function(host) {
    if (SharedUtils.getBuiltinForumRoot(host)) return 'builtin';
    var mirrorRoot = SharedUtils.getMirrorForumRoot(host);
    return mirrorRoot ? 'mirror:' + mirrorRoot : '';
  },

  getForumUrlZone: function(url) {
    try {
      var u = new URL(url);
      return u.protocol === 'https:' ? SharedUtils.getForumSiteZone(u.hostname) : '';
    } catch (e) {
      return '';
    }
  },

  isSameForumZoneUrl: function(url, otherUrl) {
    var zone = SharedUtils.getForumUrlZone(url);
    return !!zone && zone === SharedUtils.getForumUrlZone(otherUrl);
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
      var path = u.pathname.toLowerCase();
      var query = u.search.slice(1).toLowerCase();
      if (/\/attachment\.php$/.test(path)) return true;
      if (/\/forum\.php$/.test(path)) return /(?:^|&)mod=attachment(?:&|$)/.test(query);
      return /\/misc\.php$/.test(path) && /(?:^|&)(?:mod|action)=attach(?:ment)?(?:&|$)/.test(query);
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
    // A Cloudflare interstitial itself, not a thread that mentions the phrase
    // in its title or a page that merely loads Cloudflare's page script.
    if (!SharedUtils.looksLikeThreadPage(h) && /cf-chl|<title[^<>]*>\s*(?:Just a moment|Attention Required)/i.test(h)) return 'cloudflare';

    var messagePage = /id=["']messagetext["']|class=["'][^"']*(?:alert_error|showmessage)[^"']*["']|<title[^>]*>[^<]*(?:提示信息|错误信息|访问受限)[^<]*<\/title>/i.test(h);
    var text = h
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^<>]+>/g, ' ')
      .replace(/&(?:nbsp|#160);/gi, ' ')
      .replace(/\s+/g, ' ');

    if (messagePage) {
      if (/请先登录|尚未登录|需要登录|需要先登录|必须登录|登录后(?:才|方|可)|not logged in|sign in to continue/i.test(text)) return 'login_page';
      if (/没有权限|无权访问|权限不足|阅读权限|用户组.{0,16}(?:无权|无法|不能)|access denied|forbidden/i.test(text)) return 'permission_page';
      if (/(?:下载|附件).{0,24}(?:无权|权限不足|需要登录|请先登录|需要购买)/i.test(text)) return 'download_blocked';
    }

    var purchaseAction = /(?:action|href)=["'][^"']*(?:buythread|pay(?:thread|topic)|action=buy)[^"']*["']/i.test(h);
    if (purchaseAction && /购买(?:主题|帖子)|付费(?:主题|帖子)|支付.{0,20}(?:金币|金钱)|售价.{0,20}(?:金币|金钱)/i.test(text)) return 'purchase_page';
    return null;
  },

  // Linear scans that replace the old optional-prefix URL regexes, which
  // backtracked cubically on long unbroken runs (a post repeating
  // "https://x/forum.php?" froze every viewer's page). Tokens are maximal
  // runs without quotes, angle brackets or whitespace, like [^"'<>\s]+.
  forEachUrlToken: function(text, callback) {
    var tokenRegex = /[^"'<>\s]+/g;
    var match;
    text = String(text || '');
    while ((match = tokenRegex.exec(text)) !== null) {
      if (match[0].length > 4096) continue;
      if (callback(match[0], match.index) === false) return;
    }
  },

  // Same matches as /(?:https?:\/\/[^"'<>\s]+)?(?:forum\.php\?[^"'<>\s]*mod=attachment
  // [^"'<>\s]*|attachment\.php\?[^"'<>\s]*|misc\.php\?[^"'<>\s]*(?:mod=attach|
  // action=attach)[^"'<>\s]*)/gi: from the earliest scheme (or keyword) to
  // the end of the token. callback(url, start, end) may return false to stop.
  forEachRawAttachmentUrl: function(text, callback) {
    SharedUtils.forEachUrlToken(text, function(token, tokenIndex) {
      var lower = token.toLowerCase();
      var keyAt = -1;
      var forumAt = lower.indexOf('forum.php?');
      if (forumAt !== -1 && lower.indexOf('mod=attachment', forumAt + 10) !== -1) keyAt = forumAt;
      var attachAt = lower.indexOf('attachment.php?');
      if (attachAt !== -1 && (keyAt === -1 || attachAt < keyAt)) keyAt = attachAt;
      var miscAt = lower.indexOf('misc.php?');
      if (miscAt !== -1 && (keyAt === -1 || miscAt < keyAt) &&
          (lower.indexOf('mod=attach', miscAt + 9) !== -1 || lower.indexOf('action=attach', miscAt + 9) !== -1)) {
        keyAt = miscAt;
      }
      if (keyAt === -1) return;
      var start = keyAt;
      // The optional scheme prefix may run past earlier keywords, so the match
      // starts at the first scheme whenever any qualifying keyword begins at
      // least one character after it.
      var schemeAt = lower.search(/https?:\/\//);
      if (schemeAt !== -1 && schemeAt < keyAt) {
        var lastKeyAt = lower.lastIndexOf('attachment.php?');
        var lastModAt = lower.lastIndexOf('mod=attachment');
        if (lastModAt >= 10) lastKeyAt = Math.max(lastKeyAt, lower.lastIndexOf('forum.php?', lastModAt - 10));
        var lastParamAt = Math.max(lower.lastIndexOf('mod=attach'), lower.lastIndexOf('action=attach'));
        if (lastParamAt >= 9) lastKeyAt = Math.max(lastKeyAt, lower.lastIndexOf('misc.php?', lastParamAt - 9));
        if (lastKeyAt > schemeAt + (lower.charAt(schemeAt + 4) === 's' ? 8 : 7)) start = schemeAt;
      }
      return callback(token.slice(start), tokenIndex + start, tokenIndex + token.length);
    });
  },

  // Same matches as /https?:\/\/[^"'<>\s]+?\.txt(?:[?#][^"'<>\s]*)?/gi.
  forEachRawTextFileUrl: function(text, callback) {
    SharedUtils.forEachUrlToken(text, function(token, tokenIndex) {
      var lower = token.toLowerCase();
      var pos = 0;
      while (pos < lower.length) {
        var schemeAt = lower.indexOf('http', pos);
        if (schemeAt === -1) return;
        var afterScheme = lower.startsWith('https://', schemeAt) ? schemeAt + 8 :
          (lower.startsWith('http://', schemeAt) ? schemeAt + 7 : -1);
        if (afterScheme === -1) {
          pos = schemeAt + 4;
          continue;
        }
        var txtAt = lower.indexOf('.txt', afterScheme + 1);
        if (txtAt === -1) return;
        var end = txtAt + 4;
        if (lower.charAt(end) === '?' || lower.charAt(end) === '#') end = lower.length;
        if (callback(token.slice(schemeAt, end), tokenIndex + schemeAt, tokenIndex + end) === false) return false;
        pos = end;
      }
    });
  },

  // Every Discuz thread view renders its post list.
  looksLikeThreadPage: function(html) {
    return /\bid=["'](?:postlist|thread_subject)["']|\bid=["']post(?:message)?_\d+["']|\bclass=["'][^"'<>]*\bt_f\b/i.test(String(html || ''));
  },

  getHtmlPageTitle: function(html) {
    var match = /<title[^<>]*>([^<]{0,200})/i.exec(String(html || '').slice(0, 20000));
    return match ? SharedUtils.decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  },

  // For an HTML 200 page that produced no images, resources or TXT links.
  // null: a real thread page with nothing to show (safe to negative-cache).
  // Otherwise the page is an interstitial such as an anti-flood notice, so
  // the thread must be retried later instead of being cached as empty.
  classifyEmptyArticlePage: function(html) {
    html = String(html || '');
    if (SharedUtils.looksLikeThreadPage(html)) return null;
    var text = SharedUtils.htmlToText(SharedUtils.stripNonRenderedHtmlRegions(html.slice(0, 20000))).replace(/\s+/g, ' ');
    if (/主题不存在|帖子不存在|已被删除|已删除|正在被审核|does not exist|has been deleted/i.test(text)) {
      return { reason: 'thread_missing', retryable: false };
    }
    if (/过于频繁|太频繁|访问频率|刷新过快|访问过快|速度过快|稍后再试|稍候再试|请求过多|too many requests|rate limit|slow down/i.test(text)) {
      return { reason: 'rate_limited', retryable: true };
    }
    // Any other Discuz notice (read permission, moderation, …) is the forum
    // answering normally about this thread, not pushing back on the rate.
    if (SharedUtils.isDiscuzMessagePage(html)) return { reason: 'forum_message', retryable: true };
    if (SharedUtils.isForumChallengePage(html)) return { reason: 'challenge_page', retryable: true };
    return { reason: 'unrecognized_page', retryable: true };
  },

  // Cloudflare marks its challenge responses (usually HTTP 403) with this
  // header; the body may be in any language.
  isCloudflareChallengeResponse: function(resp) {
    var headers = resp && resp.headers;
    if (!headers || typeof headers.get !== 'function') return false;
    return String(headers.get('cf-mitigated') || '').toLowerCase() === 'challenge';
  },

  isDiscuzMessagePage: function(html) {
    return /\bid=["']messagetext["']|\bclass=["'][^"'<>]*\balert_(?:error|info|right)\b/i.test(String(html || '').slice(0, 60000));
  },

  // Empty-result reasons that mean the forum pushed back on the request rate,
  // as opposed to something about the thread itself. An unrecognized page is
  // not one: pausing the whole forum for a single odd thread costs more than
  // retrying that thread a few times.
  isForumFloodReason: function(reason) {
    return reason === 'rate_limited' ||
      reason === 'challenge_page' ||
      reason === 'cloudflare' ||
      reason === 'http_429' ||
      reason === 'http_503';
  },

  // The forum's anti-crawler answer to a burst of requests: a page of a
  // kilobyte or so, titled with a random quote author, that only carries a
  // script (or a refresh) and none of the Discuz page frame. Recognized so it
  // is waited out, never run.
  isForumChallengePage: function(html) {
    html = String(html || '');
    if (!html || html.length > 6144 || SharedUtils.looksLikeThreadPage(html)) return false;
    if (/\bid=["'](?:wp|hd|ft|toptb|messagetext)["']|Powered by Discuz|discuz_uid|STYLEID|\balert_(?:error|info|right)\b/i.test(html)) return false;
    return /<script\b|<meta[^<>]*http-equiv=["']?refresh/i.test(html);
  },

  extractOgImage: function(html, baseUrl) {
    var image = null;
    SharedUtils.forEachHtmlTag(SharedUtils.stripNonRenderedHtmlRegions(html), function(name, attrs) {
      if (name !== 'meta' || SharedUtils.extractHtmlAttr(attrs, 'property').toLowerCase() !== 'og:image') return;
      image = SharedUtils.resolveUrl(baseUrl, SharedUtils.extractHtmlAttr(attrs, 'content'));
      if (image) return false;
    });
    return image;
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

  // ed2k/magnet groups hold their own schemes; every other group is a web
  // link, so a javascript:/data: href must never become a copyable item.
  isCopyableResourceUrl: function(type, url) {
    if (type === 'ed2k') return /^ed2k:\/\//i.test(url);
    if (type === 'magnet') return /^magnet:\?/i.test(url);
    return SharedUtils.isHttpLikeUrl(url);
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
        if (!item.url || !this.isCopyableResourceUrl(type, item.url)) continue;
        var altCodes = Array.isArray(item.altCodes) ? item.altCodes : [];
        delete item.altCodes;
        var dedupKey = this.getResourceDedupKey(type, item.url);
        if (seen[dedupKey]) {
          var existing = seen[dedupKey];
          existing.source = this.mergeResourceSource(existing.source, item.source);
          // Another sighting with a different code: keep both, the first one
          // stays the link's code.
          if (!existing.code && item.code) existing.code = item.code;
          else if (item.code) this.addAltAccessCode(existing, item.code);
          for (var ea = 0; ea < altCodes.length; ea++) this.addAltAccessCode(existing, altCodes[ea]);
          continue;
        }
        for (var ia = 0; ia < altCodes.length; ia++) this.addAltAccessCode(item, altCodes[ia]);
        seen[dedupKey] = item;
        normalized.groups[type].push(item);
      }
    }
    normalized.passwords = this.normalizePasswords(resources.passwords);
    return normalized;
  },

  normalizePasswords: function(passwords) {
    var out = [];
    var seen = Object.create(null);
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
      : SharedUtils.decodeHtmlEntities(SharedUtils.stripNonRenderedHtmlRegions(SharedUtils.restoreProtectedEmails(SharedUtils.limitArticleHtml(html))));
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
      return SharedUtils.isDiscuzAttachmentUrl(href, baseUrl);
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
    // The thread has more TXT attachments than are read.
    var moreCandidates = directCandidates.concat(contextCandidates);
    for (var mc = 0; mc < moreCandidates.length && attachments.length >= maxCount; mc++) {
      if (!seen[moreCandidates[mc].key]) {
        attachments.limited = true;
        break;
      }
    }

    var rawSignedDownloadRegex = /https:\/\/xia\.ewrewej\.la\/[^"'<>\s]+/gi;
    while (attachments.length < maxCount && (m = rawSignedDownloadRegex.exec(decoded)) !== null) {
      if (Date.now() - startedAt > MAX_SCAN_MS) break;
      var rawSignedUrl = m[0].replace(/\\\//g, '/');
      var signedCand = makeCandidate(rawSignedUrl, rawSignedUrl, 'txt-attachment-signed');
      if (signedCand) addCandidate(signedCand);
    }

    // Raw URL fallback: standalone attachment URLs in text
    SharedUtils.forEachRawAttachmentUrl(decoded, function(matchedUrl, matchStart, matchEnd) {
      if (attachments.length >= maxCount || Date.now() - startedAt > MAX_SCAN_MS) return false;
      var rawUrl = matchedUrl.replace(/\\\//g, '/');
      var rawCtxStart = Math.max(0, matchStart - 1500);
      var rawCtxEnd = Math.min(decoded.length, matchEnd + 1500);
      var rawSlice = decoded.slice(rawCtxStart, rawCtxEnd);
      if (!/\.txt/i.test(rawSlice) && !/(?:filetype|attach(?:ment)?)[^>]{0,160}(?:txt|text)/i.test(rawSlice)) return;

      // Raw name: narrow window first, then block, then full window (same as context)
      var rawNarrowStart = Math.max(0, matchStart - 200);
      var rawNarrowEnd = Math.min(decoded.length, matchEnd + 200);
      var rawNarrowText = SharedUtils.htmlToText(decoded.slice(rawNarrowStart, rawNarrowEnd)).trim();
      var rawNameMatch = rawNarrowText.match(/[^\s<>"'：:，,。；;（）()【】\[\]]{1,120}\.txt/i);
      if (!rawNameMatch) {
        var rawBlockStart = Math.max(0, matchStart - 800);
        var rawBlockEnd = Math.min(decoded.length, matchEnd + 800);
        var rawBlockText = SharedUtils.htmlToText(decoded.slice(rawBlockStart, rawBlockEnd)).trim();
        rawNameMatch = rawBlockText.match(/[^\s<>"'：:，,。；;（）()【】\[\]]{1,120}\.txt/i);
      }
      if (!rawNameMatch) {
        var rawText = SharedUtils.htmlToText(rawSlice).trim();
        rawNameMatch = rawText.match(/[^\s<>"'：:，,。；;（）()【】\[\]]{1,120}\.txt/i);
      }
      var rawCand = makeCandidate(rawUrl, (rawNameMatch && rawNameMatch[0]) || rawUrl, 'txt-attachment-raw');
      if (rawCand) addCandidate(rawCand);
    });

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
      return SharedUtils.isDiscuzAttachmentUrl(raw, baseUrl);
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
      if (!SharedUtils.isAllowedTextAttachmentUrl(url, baseUrl)) return;
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

    var m;
    SharedUtils.forEachRawTextFileUrl(decoded, function(url) {
      if (urls.length >= maxCount) return false;
      add(url);
    });

    var signedDownloadRegex = /https:\/\/xia\.ewrewej\.la\/[^"'<>\s]+/gi;
    while (urls.length < maxCount && (m = signedDownloadRegex.exec(decoded)) !== null) {
      add(m[0]);
    }

    SharedUtils.forEachRawAttachmentUrl(decoded, function(url) {
      if (urls.length >= maxCount) return false;
      add(url);
    });

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
    var rawHtml = this.stripNonRenderedHtmlRegions(this.restoreProtectedEmails(this.limitArticleHtml(html)));
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
      rawHtml = source === 'txt'
        ? this.restoreProtectedEmails(this.limitArticleHtml(html))
        : this.stripNonRenderedHtmlRegions(this.restoreProtectedEmails(this.limitArticleHtml(html)));
      decoded = this.decodeHtmlEntities(rawHtml);
      text = this.htmlToText(decoded);
    }

    // Codes come from the link's own query here (?pwd=...); codes written
    // in the text are paired with their links once everything is found.
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
        else if (meta && meta.code) SharedUtils.addAltAccessCode(existing, meta.code);
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

    function addResourceCandidate(raw) {
      raw = SharedUtils.cleanResourceUrl(raw);
      var type = SharedUtils.classifyResourceUrl(raw);
      if (!type) return;
      var url = normalizeResourceCandidate(raw);
      if (!SharedUtils.isCopyableResourceUrl(type, url)) return;
      var code = '';
      if (SharedUtils.isPanResourceType(type)) {
        code = SharedUtils.extractAccessCode(url);
        if (!code && url !== raw) code = SharedUtils.extractAccessCode(SharedUtils.preparePanResourceUrlForParse(raw));
      }
      add(type, url, code ? { code: code } : null);
    }

    function scanResourceText(scanText) {
      scanText = String(scanText || '');
      if (!scanText) return;

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
        addResourceCandidate(match[0]);
      }

      var protocolRelativeRegex = /\/\/(?:(?:www\.)?pan\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?pan\.quark\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?115\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?(?:aliyundrive|alipan)\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?yun\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?drive\.uc\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?pan\.xunlei\.com\/s\/[^\s<>"'）)】\]]+)/gi;
      while ((match = protocolRelativeRegex.exec(scanText)) !== null) {
        addResourceCandidate(match[0]);
      }

      var barePanRegex = /(?:^|[\s<>"'（(【\[])((?:www\.)?pan\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?pan\.quark\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?115\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?(?:aliyundrive|alipan)\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?yun\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?drive\.uc\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?pan\.xunlei\.com\/s\/[^\s<>"'）)】\]]+)/gi;
      while ((match = barePanRegex.exec(scanText)) !== null) {
        addResourceCandidate(match[1]);
      }
    }

    scanResourceText(text);
    var hrefTagRegex = /<(?:a|area)\b([^>]*)>/gi;
    var hrefTagMatch;
    while ((hrefTagMatch = hrefTagRegex.exec(rawHtml)) !== null) {
      var tagHref = SharedUtils.extractHtmlAttr(hrefTagMatch[1] || '', 'href');
      if (tagHref) {
        var decodedHref = SharedUtils.decodeHtmlEntities(tagHref);
        scanResourceText(decodedHref);
      }
    }

    var resourceAnchors = [];
    SharedUtils.forEachAnchorTag(rawHtml, function(attrs, body, openIndex, endIndex) {
      var href = SharedUtils.decodeHtmlEntities(SharedUtils.extractHtmlAttr(attrs, 'href'));
      if (!href || !SharedUtils.classifyResourceUrl(href)) return;
      resourceAnchors.push({ href: href, openIndex: openIndex, endIndex: endIndex });
    });
    for (var ai = 0; ai < resourceAnchors.length; ai++) {
      addResourceCandidate(resourceAnchors[ai].href);
    }

    resources.passwords = this.mergeUniqueLimited(
      this.extractArchivePasswordsFromHtml(decoded),
      this.extractArchivePasswords(text),
      5
    );
    // Codes written in the text, paired with their links in one pass.
    var panItems = [];
    for (var pt = 0; pt < this.RESOURCE_GROUP_ORDER.length; pt++) {
      var panType = this.RESOURCE_GROUP_ORDER[pt];
      if (this.isPanResourceType(panType)) panItems = panItems.concat(resources.groups[panType]);
    }
    if (panItems.length) {
      var pairedCodes = this.collectAccessCodePairs(rawHtml, baseUrl, source);
      for (var pi = 0; pi < panItems.length; pi++) {
        var itemCodes = pairedCodes[this.getResourceDedupKey(panItems[pi].type, panItems[pi].url)] || [];
        for (var ci = 0; ci < itemCodes.length; ci++) {
          if (!panItems[pi].code) panItems[pi].code = itemCodes[ci];
          else this.addAltAccessCode(panItems[pi], itemCodes[ci]);
        }
      }
    }
    return this.normalizeResources(resources);
  },

  findHtmlTagEnd: function(html, start) {
    var quote = '';
    for (var end = start; end < html.length; end++) {
      var ch = html.charAt(end);
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        return end;
      }
    }
    return -1;
  },

  forEachHtmlTag: function(html, callback) {
    var opening = /<([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/gi;
    var match;
    while ((match = opening.exec(html)) !== null) {
      var attrsStart = opening.lastIndex;
      var end = SharedUtils.findHtmlTagEnd(html, attrsStart);
      if (end === -1) return;
      opening.lastIndex = end + 1;
      if (callback(match[1].toLowerCase(), html.slice(attrsStart, end)) === false) return;
    }
  },

  // 扫描锚点时每段只走一次；属性引号中的 > 不是标签结束，未闭合标签不重复扫尾。
  forEachAnchorTag: function(html, callback) {
    html = String(html || '');
    var openRegex = /<a(?=[\t\n\f\r />])/gi;
    var closeRegex = /<\/a[\t\n\f\r ]*>/gi;
    var m;
    while ((m = openRegex.exec(html)) !== null) {
      var attrsStart = openRegex.lastIndex;
      var end = SharedUtils.findHtmlTagEnd(html, attrsStart);
      if (end === -1) return;
      var bodyStart = end + 1;
      closeRegex.lastIndex = bodyStart;
      var close = closeRegex.exec(html);
      if (!close) return;
      var proceed = callback(html.slice(attrsStart, end), html.slice(bodyStart, close.index), m.index, closeRegex.lastIndex);
      openRegex.lastIndex = closeRegex.lastIndex;
      if (proceed === false) return;
    }
  },

  decodeHtmlEntities: function(text) {
    // 单次替换只读取输入实体，不再次解码刚生成的 &（包括数字形式的 &）。
    var named = { nbsp: ' ', commat: '@', quot: '"', lt: '<', gt: '>', amp: '&' };
    return String(text || '').replace(/&(?:(nbsp|commat|quot|lt|gt|amp)|#(\d+)|#x([0-9a-f]+));/gi,
      function(entity, name, decimal, hex) {
        if (name) return named[name.toLowerCase()];
        var cp = parseInt(hex || decimal, hex ? 16 : 10);
        if (!isFinite(cp) || cp < 0 || cp > 0x10FFFF) return entity;
        try { return String.fromCodePoint ? String.fromCodePoint(cp) : String.fromCharCode(cp); } catch (e) { return entity; }
      });
  },

  htmlToText: function(html) {
    // [^<>] (not [^>]) keeps a run of '<' without '>' linear instead of
    // rescanning to the end from every '<'.
    return String(html || '')
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|td|th|table|section)>/gi, '\n')
      .replace(/<[^<>]+>/g, ' ')
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
    html = String(html || '');
    if (!/data-cfemail/i.test(html)) return html;
    // Tag parts stop at '<' and the wrapped text is bounded, so crafted runs
    // of '<' or unclosed tags stay linear.
    return html.replace(/<[^<>]*class\s*=\s*["'][^"']*__cf_email__[^"']*["'][^<>]*data-cfemail\s*=\s*["']([0-9a-f]+)["'][^<>]*>[\s\S]{0,300}?<\/[^<>]+>/gi, function(match, hex) {
      return SharedUtils.decodeCloudflareEmail(hex) || match;
    }).replace(/<[^<>]*data-cfemail\s*=\s*["']([0-9a-f]+)["'][^<>]*class\s*=\s*["'][^"']*__cf_email__[^"']*["'][^<>]*>[\s\S]{0,300}?<\/[^<>]+>/gi, function(match, hex) {
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
    // The lookbehind anchors the trim at the start of the trailing run; a
    // plain [..]+$ retried from every character of a long run (quadratic).
    var trailingPunctuation = /(?<![」』“”"'\])】）》〉>。；;，,、？！…])[」』“”"'\])】）》〉>。；;，,、？！…]+$/g;
    if (/^ed2k:\/\//i.test(cleaned)) {
      // 深度防御：无论来源如何，最终链接内不允许残留换行（防复制内容注入伪造行）
      cleaned = cleaned.replace(/[\r\n]+/g, ' ');
      var ed2kEnd = cleaned.indexOf('|/');
      if (ed2kEnd !== -1) cleaned = cleaned.slice(0, ed2kEnd + 2);
      return cleaned.replace(trailingPunctuation, '');
    }
    if (/^magnet:\?/i.test(cleaned)) {
      cleaned = cleaned.replace(/(btih:[A-Fa-f0-9]{32,40})(?:[。；;，,、\s]*)?(?:提取码|提取密码|访问码|取件码|解压密码|压缩密码|解压码|解压口令|解壓密碼|解壓碼|密码)\s*[:：=]?.*$/i, '$1');
      cleaned = cleaned.replace(/(?<![。；;，,、\s])[。；;，,、\s]+(?:(?:提取码|提取密码|访问码|取件码|解压密码|压缩密码|解压码|解压口令|解壓密碼|解壓碼)\s*[:：=]?|密码\s*[:：=]).*$/i, '');
      return cleaned.replace(trailingPunctuation, '');
    }
    // ASCII punctuation is legal inside query/fragment values, including at
    // their end. Keep signed URLs byte-for-byte unless explicit prose follows.
    var queryStart = cleaned.search(/[?#]/);
    if (queryStart !== -1 && !/(?:提取码|提取密码|访问码|取件码|解压密码|压缩密码|密码)\s*[:：=]/i.test(cleaned.slice(queryStart))) {
      return cleaned.replace(/[」』“”】）》〉。；，、？！…][\s\S]*$/g, '');
    }
    if (/(?:pan\.baidu\.com|yun\.baidu\.com|pan\.quark\.cn|115\.com\/s\/|(?:aliyundrive|alipan)\.com\/s\/|drive\.uc\.cn\/s\/|pan\.xunlei\.com\/s\/)/i.test(cleaned)) {
      cleaned = cleaned.replace(/(?<![。；;，,、\s])[。；;，,、\s]*(?:提取码|提取密码|访问码|取件码|解压密码|压缩密码|密码)\s*[:：=]?.*$/i, '');
      return cleaned.replace(/[」』“”"'\])】）》〉>。；;，,、？！…][\s\S]*$/g, '');
    }
    if (/^(?:https?:)?\/\/xia\.ewrewej\.la\//i.test(cleaned) || /(?:forum\.php\?|attachment\.php\?|misc\.php\?)/i.test(cleaned)) {
      cleaned = cleaned.replace(/[」』“”"'\])】）》〉>。；;，,、？！…][\s\S]*$/g, '');
      return cleaned;
    }
    cleaned = cleaned.replace(/(\.(?:jpg|jpeg|png|gif|webp|txt|zip|rar|7z|torrent)(?:[?#][^」』“”"'\])】）》〉>。；;，,、？！…\s<]*)?)[」』“”"'\])】）》〉>。；;，,、？！…][\s\S]*$/i, '$1');
    return cleaned.replace(trailingPunctuation, '');
  },

  // A share code belongs to one cloud-drive link, and a wrong code is worse
  // than none. Codes are paired once per page, on one text in which every
  // link is a token: links written out (with or without a scheme), links
  // behind anchor text, links of other drives and plain downloads (they use
  // up their own codes and get none here), and magnet / ed2k links (they
  // take no code and nothing pairs across them). Only neighbouring tokens
  // pair, so a code never passes over another link. A code on its link's own
  // line pairs first. Across lines, each block of nearby tokens is read both
  // ways — codes below their links (share texts) and codes above them — and
  // the reading that pairs more codes wins, then the one that keeps pairs
  // inside their paragraphs, then the cheaper one, then codes below. Leaving
  // a link or code alone has a price, so a doubtful pair is left out. A code
  // labelled for a drive (百度提取码) only goes to that drive.
  ACCESS_CODE_PAIR_MAX_GAP: 220,
  ACCESS_CODE_PAIR_MAX_LINES: 3,
  ACCESS_CODE_BLOCK_GAP: 600,
  ACCESS_CODE_BLOCK_LINES: 8,
  ACCESS_CODE_LABEL_REACH: 600,
  ACCESS_CODE_UNPAIRED_COST: 4,
  ACCESS_CODE_UNPAIRED_FOREIGN_COST: 2,
  // Same line, then 1..3 lines apart. A code three lines below its link is
  // still likelier than one a line above the next link.
  ACCESS_CODE_AFTER_COST: [0, 1.5, 3, 4],
  ACCESS_CODE_BEFORE_COST: [1, 4.5, 6, 7.5],
  // A code further below its link (size, format and name lines between),
  // up to the block limits, when nothing else is between them: still likelier
  // than a code on the line above the next link.
  ACCESS_CODE_FAR_AFTER_COST: 4.4,
  IMAGE_HOST_RE: /(?:^|\.)(?:imgbox\.com|postimg\.cc|postimages\.org|imgur\.com|pixhost\.to|ibb\.co|imgbb\.com|sm\.ms|imgchr\.com|jpg\.church)$/i,
  // File drives whose links carry their own codes.
  FILE_DRIVE_HOST_RE: /(?:^|\.)(?:lanzou[a-z]*\.com|ilanzou\.com|lanzn\.com|ctfile\.com|474b\.com|123pan\.com|123pan\.cn|123684\.com|123865\.com|123912\.com|cloud\.189\.cn|caiyun\.139\.com|yun\.139\.com|feiji[a-z]*\.com|rosefile\.net|mega\.nz|pikpak\.com|mypikpak\.com|weiyun\.com|jianguoyun\.com)$/i,

  getAccessCodeLabelDrive: function(before) {
    // Only the code's own line: a drive named on the line above is another link.
    before = String(before || '');
    before = before.slice(before.lastIndexOf('\n') + 1);
    var m = /(?:^|[^A-Za-z0-9\/._\-=?&#%])(百度|度盘|夸克|阿里云?|115|UC|迅雷|蓝奏云?|天翼云?|123|城通|移动云?|和彩云)(?:网盘|云盘|盘)?[ \t]*[】\]）)]?[ \t]*$/i.exec(before);
    if (!m) return '';
    var word = m[1].toUpperCase();
    if (word === '百度' || word === '度盘') return 'baidu';
    if (word === '夸克') return 'quark';
    if (word.indexOf('阿里') === 0) return 'aliyun';
    if (word === '115') return 'pan115';
    if (word === 'UC') return 'uc';
    if (word === '迅雷') return 'xunlei';
    return 'foreign';
  },

  // A '密码' that is an archive or login password, not a share code.
  isNonShareCodePasswordLabel: function(lineBefore) {
    lineBefore = String(lineBefore || '');
    lineBefore = lineBefore.slice(lineBefore.lastIndexOf('\n') + 1);
    if (/(?:账号|帐号|用户名|登录|登陆)/.test(lineBefore.slice(-20))) return true;
    return /(?:解压|压缩|解压缩|文件|资源|包|rar|zip|7z)[ \t【】\[\]()（）]*$/i.test(lineBefore);
  },

  // A link of another drive or a plain download: not the forum's own pages,
  // not an image, not an image host.
  isForeignShareLink: function(url, baseUrl) {
    var u;
    try {
      u = new URL(url, baseUrl || undefined);
    } catch (e) {
      return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    var baseHost = '';
    try { baseHost = baseUrl ? new URL(baseUrl).hostname : ''; } catch (e) {}
    if (baseHost && SharedUtils.isSameSupportedSiteHost(u.hostname, baseHost)) return false;
    if (SharedUtils.IMAGE_HOST_RE.test(u.hostname)) return false;
    return !/\.(?:jpe?g|png|gif|webp|bmp|svg|ico|css|js)$/i.test(u.pathname);
  },

  isFileDriveLink: function(url) {
    try {
      return SharedUtils.FILE_DRIVE_HOST_RE.test(new URL(/^\/\//.test(url) ? 'https:' + url : (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url)).hostname);
    } catch (e) {
      return false;
    }
  },

  // Share-link key (as the resource groups dedupe it) of a pan link, or ''.
  getPanShareKey: function(raw, baseUrl) {
    var cleaned = SharedUtils.cleanResourceUrl(String(raw || ''));
    if (!cleaned) return '';
    var prepared = SharedUtils.preparePanResourceUrlForParse(cleaned);
    var type = SharedUtils.classifyResourceUrl(prepared);
    if (!type || !SharedUtils.isPanResourceType(type)) return '';
    if (!/^https?:\/\//i.test(prepared)) prepared = SharedUtils.resolveUrl(baseUrl, prepared) || prepared;
    var url = SharedUtils.normalizePanResourceUrlCode(type, prepared, '').url;
    return url ? { type: type, key: SharedUtils.getResourceDedupKey(type, url) } : '';
  },

  // rawHtml: the page (or TXT when source is 'txt') as extractResources reads
  // it. Returns { <share-link key>: [codes, in page order] }.
  collectAccessCodePairs: function(rawHtml, baseUrl, source) {
    var MARK_OPEN = String.fromCharCode(0xE000);
    var MARK_CLOSE = String.fromCharCode(0xE001);
    var PARA = String.fromCharCode(0xE002);
    var PICTURE = String.fromCharCode(0xE003);
    var PARA_CODE = 0xE002;
    var OWN_MARKS_RE = new RegExp('[' + MARK_OPEN + MARK_CLOSE + PARA + PICTURE + ']', 'g');
    var ANCHOR_MARKS_RE = new RegExp('[' + MARK_OPEN + MARK_CLOSE + ']', 'g');
    // Marks the page itself contains are not ours.
    rawHtml = String(rawHtml || '').replace(OWN_MARKS_RE, ' ');
    if (source === 'txt') {
      rawHtml = rawHtml.replace(/\r\n?/g, '\n');
    } else {
      // Lines are what the page shows: only tags break them. A picture (and a
      // Discuz image attachment with its file name and download tip) is a
      // line of content. A run of line breaks and block tags is one line
      // break; it is a paragraph break when a closed block is followed by a
      // new one, at a rule, or at an explicit blank line.
      rawHtml = rawHtml
        .replace(/[\r\n]+/g, ' ')
        .replace(/<ignore_js_op\b[^<>]*>[\s\S]*?<\/ignore_js_op>/gi, PICTURE)
        .replace(/<img\b[^<>]*>/gi, PICTURE)
        .replace(/(?:\s|<br\s*\/?>|<hr\b[^<>]*>|<\/?(?:p|div|li|tr|td|th|ol|ul|dl|dd|dt|tbody|thead|table|blockquote|h[1-6])\b[^<>]*>)+/gi, function(run) {
          if (!/</.test(run)) return run;
          var hardEdge = /<hr\b/i.test(run) ||
            /<\/(?:p|div|li|tr|table|blockquote|h[1-6]|ul|ol)\s*>[\s\S]*<(?:p|div|li|tr|table|blockquote|h[1-6]|ul|ol)\b/i.test(run);
          var breaks = (run.match(/<br\s*\/?>/gi) || []).length;
          return hardEdge || breaks >= 2 ? '<br>' + PARA + '<br>' : '<br>';
        });
    }
    var anchors = [];
    var parts = [];
    var last = 0;
    function pushText(slice) {
      // Nor are anchor marks written as entities (&#57344;).
      parts.push(SharedUtils.decodeHtmlEntities(slice).replace(ANCHOR_MARKS_RE, ' '));
    }
    SharedUtils.forEachAnchorTag(rawHtml, function(attrs, body, openIndex) {
      var href = SharedUtils.decodeHtmlEntities(SharedUtils.extractHtmlAttr(attrs, 'href')).trim();
      if (!href) return;
      var pan = SharedUtils.getPanShareKey(href, baseUrl);
      var blocking = !pan && /^(?:magnet:|ed2k:|thunder:)/i.test(href);
      var fileDrive = !pan && !blocking && SharedUtils.isForeignShareLink(href, baseUrl) && SharedUtils.isFileDriveLink(href);
      // A picture that links somewhere is not a share link, unless it is a
      // file drive's download button.
      var foreign = !pan && !blocking && (fileDrive || (SharedUtils.isForeignShareLink(href, baseUrl) &&
        !!SharedUtils.htmlToText(SharedUtils.decodeHtmlEntities(body)).replace(OWN_MARKS_RE, '').trim()));
      if (!pan && !blocking && !foreign) return;
      var tagEnd = SharedUtils.findHtmlTagEnd(rawHtml, openIndex + 2);
      if (tagEnd === -1) return;
      pushText(rawHtml.slice(last, openIndex));
      parts.push(' ' + MARK_OPEN + anchors.length + MARK_CLOSE + ' ');
      anchors.push({ pan: pan || null, blocking: blocking, fileDrive: fileDrive,
        urlCode: pan ? SharedUtils.extractAccessCode(SharedUtils.preparePanResourceUrlForParse(href)) : '' });
      last = tagEnd + 1;
    });
    pushText(rawHtml.slice(last));
    var text = SharedUtils.htmlToText(parts.join(''));

    var tokens = [];
    var m;
    var markRe = new RegExp(MARK_OPEN + '(\\d+)' + MARK_CLOSE, 'g');
    while ((m = markRe.exec(text)) !== null) {
      var anchor = anchors[Number(m[1])];
      if (!anchor) continue;
      tokens.push({
        kind: anchor.blocking ? 'X' : 'L',
        start: m.index,
        end: m.index + m[0].length,
        pan: anchor.pan ? anchor.pan.type : '',
        key: anchor.pan ? anchor.pan.key : '',
        fileDrive: anchor.fileDrive,
        urlCode: anchor.urlCode
      });
    }
    var anchorCount = tokens.length;
    // Which characters of the text belong to a link, and to a written-out
    // link: checks per match stay constant-time on large pages.
    var linkMask = new Uint8Array(text.length + 1);
    var visibleMask = new Uint8Array(text.length + 1);
    function markRange(mask, start, end) {
      for (var p = start; p < end; p++) mask[p] = 1;
    }
    tokens.forEach(function(token) { markRange(linkMask, token.start, token.end); });
    // A link written out right after its own anchor is that anchor.
    function isAnchorText(start, key) {
      for (var i = 0; i < anchorCount; i++) {
        var token = tokens[i];
        if (token.end <= start && start - token.end <= 3 && token.key === key) return token;
      }
      return null;
    }
    var visible = [];
    function isCovered(start, end) {
      for (var p = start; p < end; p++) {
        if (visibleMask[p]) return true;
      }
      return false;
    }
    function addVisible(start, end, pan, key, kind, fileDrive, urlCode) {
      markRange(visibleMask, start, end);
      markRange(linkMask, start, end);
      var own = kind === 'L' ? isAnchorText(start, key) : null;
      if (own) {
        markRange(linkMask, own.end, end);
        own.end = Math.max(own.end, end);
        if (!own.urlCode && urlCode) own.urlCode = urlCode;
        return;
      }
      visible.push({ kind: kind, start: start, end: end, pan: pan, key: key, fileDrive: !!fileDrive, urlCode: urlCode || '' });
    }
    var panRe = /(?:https?:\/\/|\/\/)?(?:www\.)?(?:pan\.baidu\.com\/(?:s\/|share\/)|yun\.baidu\.com\/(?:s\/|share\/)|pan\.quark\.cn\/s\/|115\.com\/s\/|(?:aliyundrive|alipan)\.com\/s\/|drive\.uc\.cn\/s\/|pan\.xunlei\.com\/s\/)[A-Za-z0-9\-._~:\/?#@!$&*+,;=%]*/gi;
    while ((m = panRe.exec(text)) !== null) {
      var pan = SharedUtils.getPanShareKey(m[0], baseUrl);
      if (pan) {
        addVisible(m.index, m.index + m[0].length, pan.type, pan.key, 'L', false,
          SharedUtils.extractAccessCode(SharedUtils.preparePanResourceUrlForParse(SharedUtils.cleanResourceUrl(m[0]))));
      }
    }
    var blockRe = /(?:magnet:\?|ed2k:\/\/|thunder:\/\/)[^\s<>"']*/gi;
    while ((m = blockRe.exec(text)) !== null) {
      if (!isCovered(m.index, m.index + m[0].length)) addVisible(m.index, m.index + m[0].length, '', '', 'X');
    }
    var webRe = /(?:https?:)?\/\/[A-Za-z0-9\-._~:\/?#@!$&*+,;=%]+/gi;
    while ((m = webRe.exec(text)) !== null) {
      if (isCovered(m.index, m.index + m[0].length)) continue;
      var webUrl = /^\/\//.test(m[0]) ? 'https:' + m[0] : m[0];
      if (!SharedUtils.isForeignShareLink(webUrl, baseUrl)) continue;
      addVisible(m.index, m.index + m[0].length, '', '', 'L', SharedUtils.isFileDriveLink(webUrl));
    }
    // Links written without a scheme (www.123pan.com/s/..., wwi.lanzoup.com/...).
    var bareRe = /(^|[^A-Za-z0-9\-._~\/@:%])((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?\/[A-Za-z0-9\-._~:\/?#@!$&*+,;=%]+)/g;
    while ((m = bareRe.exec(text)) !== null) {
      var bareStart = m.index + m[1].length;
      var bareEnd = bareStart + m[2].length;
      if (isCovered(bareStart, bareEnd)) continue;
      if (!SharedUtils.isForeignShareLink('https://' + m[2], baseUrl)) continue;
      addVisible(bareStart, bareEnd, '', '', 'L', SharedUtils.isFileDriveLink(m[2]));
    }
    tokens = tokens.concat(visible);

    var codes = [];
    var codeMask = new Uint8Array(text.length + 1);
    function collect(regex, passwordLabel) {
      var cm;
      regex.lastIndex = 0;
      while ((cm = regex.exec(text)) !== null) {
        // 「密码/提取码」标签后直接跟裸链接时，会把 URL 自身的 scheme 误捕为提取码
        if (/^(?:https?|www|ftp|com|net|org|ed2k|magnet|thunder)$/i.test(cm[1])) continue;
        var start = cm.index;
        var end = cm.index + cm[0].length;
        var valueStart = end - cm[1].length;
        if (linkMask[start]) continue;
        // 无需提取码 / 免提取码 / 无密码: a label saying there is none.
        if (/(?:无|免|无需|无须|不需要?|不用|没有)[ \t]*$/.test(text.slice(Math.max(0, start - 3), start))) continue;
        var lineBefore = text.slice(Math.max(0, start - 40), start);
        if (passwordLabel && SharedUtils.isNonShareCodePasswordLabel(lineBefore)) continue;
        // A value from inside a link, or the first word of a later line
        // (only a whole line or table cell can hold a label's value).
        var inLink = false;
        for (var v = valueStart; v < end && !inLink; v++) inLink = linkMask[v] === 1;
        if (inLink) continue;
        if (/\n/.test(text.slice(start, valueStart)) && !/^[ \t\u3000]*(?:\n|$)/.test(text.slice(end, end + 40))) continue;
        var overlaps = false;
        for (var p = start; p < end && !overlaps; p++) overlaps = codeMask[p] === 1;
        if (overlaps) continue;
        markRange(codeMask, start, end);
        // The label's own words only: never the tail of a link before it.
        var labelFrom = Math.max(0, start - 10);
        for (var q = start - 1; q >= labelFrom; q--) {
          if (linkMask[q]) {
            labelFrom = q + 1;
            break;
          }
        }
        codes.push({ kind: 'C', start: start, end: end, code: cm[1], drive: SharedUtils.getAccessCodeLabelDrive(text.slice(labelFrom, start)) });
      }
    }
    collect(/(?:提取码|提取密码|访问码|取件码)\s*[:：=]?\s*([A-Za-z0-9]{3,12})(?![A-Za-z0-9])/gi, false);
    collect(/提取[ \t]*[:：=][ \t]*([A-Za-z0-9]{3,12})(?![A-Za-z0-9])/gi, false);
    collect(/密码\s*[:：=]?\s*([A-Za-z0-9]{3,12})(?![A-Za-z0-9])/gi, true);
    if (!codes.length) return {};
    // 无需提取码 / 免提取码 / 提取码：无: the link on that line has no code,
    // so it cannot take a neighbour's.
    var noneRe = /(?:无需|无须|免|不需要?|不用|没有|无)[ \t]*(?:提取码|提取密码|访问码|取件码|密码)|(?:提取码|提取密码|访问码|取件码|密码)[ \t]*[:：]?[ \t]*(?:无|没有|不需要|不用)(?![一-龥A-Za-z0-9])/g;
    while ((m = noneRe.exec(text)) !== null) {
      var noneStart = m.index;
      var noneEnd = noneStart + m[0].length;
      var taken = false;
      for (var nm = noneStart; nm < noneEnd && !taken; nm++) taken = linkMask[nm] === 1 || codeMask[nm] === 1;
      if (taken) continue;
      var passwordAt = m[0].indexOf('密码');
      if (passwordAt !== -1 && !/(?:提取|访问)密码/.test(m[0]) &&
        SharedUtils.isNonShareCodePasswordLabel(text.slice(Math.max(0, noneStart - 40), noneStart + passwordAt))) continue;
      codes.push({ kind: 'C', start: noneStart, end: noneEnd, code: '', none: true, drive: '' });
    }
    // A line or table cell that only says 无: a "no code" entry in a column
    // of codes.
    var noneCellRe = /(^|\n)[ \t]*(无|没有|无需|不需要)[ \t]*(?=\n|$)/g;
    while ((m = noneCellRe.exec(text)) !== null) {
      var cellStart = m.index + m[1].length + m[0].slice(m[1].length).indexOf(m[2]);
      if (linkMask[cellStart] || codeMask[cellStart]) continue;
      codes.push({ kind: 'C', start: cellStart, end: cellStart + m[2].length, code: '', none: true, drive: '' });
    }
    tokens = tokens.concat(codes);
    tokens.sort(function(a, b) { return a.start - b.start || (a.kind === 'C' ? 1 : b.kind === 'C' ? -1 : 0); });
    if (!tokens.some(function(token) { return token.kind === 'L' && token.pan; })) return {};

    // Lines as the reader sees them: blank lines are one break. Paragraphs:
    // a closed block element or a blank line starts a new one.
    var line = 0;
    var para = 0;
    var scanned = 0;
    var lineHasContent = true;
    var paraCounted = false;
    for (var t = 0; t < tokens.length; t++) {
      for (; scanned < tokens[t].start && scanned < text.length; scanned++) {
        var ch = text.charCodeAt(scanned);
        if (ch === PARA_CODE) {
          if (!paraCounted) para++;
          paraCounted = true;
        } else if (ch === 10) {
          if (lineHasContent) {
            line++;
            lineHasContent = false;
          } else if (!paraCounted) {
            para++;
            paraCounted = true;
          }
        } else if (ch !== 32 && ch !== 9 && ch !== 13 && ch !== 160 && ch !== 0x3000) {
          lineHasContent = true;
          paraCounted = false;
        }
      }
      tokens[t].line = line;
      tokens[t].para = para;
    }

    // N links directly followed by N codes on later lines (or N codes then N
    // links), with nothing else around them: rows of a list or table, paired
    // by position.
    function isDriveLink(token) {
      return !!token && token.kind === 'L' && (!!token.pan || !!token.fileDrive);
    }
    function near(a, b) {
      return !!a && !!b && b.start - a.end <= SharedUtils.ACCESS_CODE_BLOCK_GAP && b.line - a.line <= SharedUtils.ACCESS_CODE_BLOCK_LINES;
    }
    function driveFits(code, link) {
      return !code.drive || (code.drive === 'foreign' ? !link.pan : link.pan === code.drive);
    }
    function pairGroup(first, second, links, codes) {
      for (var g = 0; g < links.length; g++) {
        links[g].code = codes[g].none ? '' : codes[g].code;
        if (codes[g].none) links[g].noCode = true;
        links[g].kind = 'G';
        codes[g].kind = 'G';
        codes[g].used = true;
      }
    }
    for (var gi = 0; gi < tokens.length; gi++) {
      var firstKind = tokens[gi].kind;
      if (firstKind !== 'L' && firstKind !== 'C') continue;
      var otherKind = firstKind === 'L' ? 'C' : 'L';
      var n = 0;
      while (gi + n < tokens.length && tokens[gi + n].kind === firstKind && (firstKind === 'C' || isDriveLink(tokens[gi + n]))) n++;
      if (n < 2 || gi + 2 * n > tokens.length) continue;
      var firstRun = tokens.slice(gi, gi + n);
      var secondRun = tokens.slice(gi + n, gi + 2 * n);
      var ok = secondRun.every(function(token) { return token.kind === otherKind && (otherKind === 'C' || isDriveLink(token)); }) &&
        secondRun[0].line > firstRun[n - 1].line && near(firstRun[n - 1], secondRun[0]);
      var groupLinks = firstKind === 'L' ? firstRun : secondRun;
      var groupCodes = firstKind === 'L' ? secondRun : firstRun;
      for (var gk = 0; ok && gk < n; gk++) ok = driveFits(groupCodes[gk], groupLinks[gk]);
      // Drive labels that line up with the links settle it. Otherwise a link
      // right after the codes (or right before codes that come first) could
      // be what those codes belong to, and the reading stays open.
      var labelled = groupCodes.some(function(code) { return !!code.drive; });
      var outside = firstKind === 'L' ? tokens[gi + 2 * n] : tokens[gi - 1];
      var codeEnd = firstKind === 'L' ? secondRun[n - 1] : null;
      if (ok && !labelled && outside && outside.kind === 'L' &&
        (firstKind === 'L' ? near(codeEnd, outside) : near(outside, firstRun[0]))) ok = false;
      if (!ok) continue;
      pairGroup(firstRun, secondRun, groupLinks, groupCodes);
      gi += 2 * n - 1;
    }

    function unpairedCost(token, index) {
      if (token.kind === 'X' || token.kind === 'G') return 0;
      // A "no code" statement, and a link carrying its code in its URL, lose
      // nothing when left alone.
      if (token.none || token.urlCode) return 0;
      if (token.kind === 'L' && !token.pan) {
        // A file drive's link, or any link with a code on its own line right
        // after it, keeps that code as firmly as a cloud-drive link would.
        var next = tokens[index + 1];
        var ownLineCode = next && next.kind === 'C' && next.line === token.line;
        return token.fileDrive || ownLineCode ? SharedUtils.ACCESS_CODE_UNPAIRED_COST : SharedUtils.ACCESS_CODE_UNPAIRED_FOREIGN_COST;
      }
      return SharedUtils.ACCESS_CODE_UNPAIRED_COST;
    }
    // regime 'after': cross-line codes below their links; 'before': above.
    function pairCost(a, b, regime) {
      if (a.kind === 'X' || b.kind === 'X' || a.kind === 'G' || b.kind === 'G' || a.kind === b.kind) return Infinity;
      var link = a.kind === 'L' ? a : b;
      var code = a.kind === 'C' ? a : b;
      var lines = b.line - a.line;
      var gap = b.start - a.end;
      if (code.none) return lines === 0 && gap <= SharedUtils.ACCESS_CODE_PAIR_MAX_GAP ? -1 : Infinity;
      if (code.drive && (code.drive === 'foreign' ? !!link.pan : link.pan !== code.drive)) return Infinity;
      if (link.urlCode && lines > 0) {
        // The link's own code written out again below or above it.
        return code.code.toLowerCase() === link.urlCode.toLowerCase() && lines <= SharedUtils.ACCESS_CODE_PAIR_MAX_LINES &&
          gap <= SharedUtils.ACCESS_CODE_PAIR_MAX_GAP ? -0.5 : Infinity;
      }
      var codeAfter = a.kind === 'L';
      if (lines === 0) return gap > SharedUtils.ACCESS_CODE_PAIR_MAX_GAP ? Infinity : (codeAfter ? SharedUtils.ACCESS_CODE_AFTER_COST[0] : SharedUtils.ACCESS_CODE_BEFORE_COST[0]);
      if (regime !== (codeAfter ? 'after' : 'before')) return Infinity;
      // A code labelled for a drive finds its link across lines in the
      // labelled pass below, not by position.
      if (code.drive && code.drive !== 'foreign') return Infinity;
      if (lines <= SharedUtils.ACCESS_CODE_PAIR_MAX_LINES && gap <= SharedUtils.ACCESS_CODE_PAIR_MAX_GAP) {
        return (codeAfter ? SharedUtils.ACCESS_CODE_AFTER_COST : SharedUtils.ACCESS_CODE_BEFORE_COST)[lines];
      }
      if (codeAfter && lines <= SharedUtils.ACCESS_CODE_BLOCK_LINES && gap <= SharedUtils.ACCESS_CODE_BLOCK_GAP) return SharedUtils.ACCESS_CODE_FAR_AFTER_COST;
      return Infinity;
    }
    function pairBlock(from, to, regime) {
      var n = to - from;
      var best = [0];
      var count = [0];
      var crossings = [0];
      var paired = [false];
      for (var i = 1; i <= n; i++) {
        var token = tokens[from + i - 1];
        best[i] = best[i - 1] + unpairedCost(token, from + i - 1);
        count[i] = count[i - 1];
        crossings[i] = crossings[i - 1];
        paired[i] = false;
        if (i >= 2) {
          var cost = pairCost(tokens[from + i - 2], token, regime);
          if (best[i - 2] + cost < best[i]) {
            best[i] = best[i - 2] + cost;
            count[i] = count[i - 2] + 1;
            crossings[i] = crossings[i - 2] + (tokens[from + i - 2].para !== token.para ? 1 : 0);
            paired[i] = true;
          }
        }
      }
      var pairs = [];
      for (var j = n; j > 0;) {
        if (paired[j]) {
          pairs.push([tokens[from + j - 2], tokens[from + j - 1]]);
          j -= 2;
        } else {
          j--;
        }
      }
      return { cost: best[n], count: count[n], crossings: crossings[n], pairs: pairs };
    }
    function better(x, y) {
      if (x.count !== y.count) return x.count > y.count;
      if (x.crossings !== y.crossings) return x.crossings < y.crossings;
      return x.cost < y.cost;
    }
    var blockStart = 0;
    for (var bi = 1; bi <= tokens.length; bi++) {
      var boundary = bi === tokens.length ||
        tokens[bi].start - tokens[bi - 1].end > SharedUtils.ACCESS_CODE_BLOCK_GAP ||
        tokens[bi].line - tokens[bi - 1].line > SharedUtils.ACCESS_CODE_BLOCK_LINES;
      if (!boundary) continue;
      var after = pairBlock(blockStart, bi, 'after');
      var before = pairBlock(blockStart, bi, 'before');
      blockStart = bi;
      var chosen = better(before, after) ? before : after;
      chosen.pairs.forEach(function(pair) {
        var pl = pair[0].kind === 'L' ? pair[0] : pair[1];
        var pc = pair[0].kind === 'C' ? pair[0] : pair[1];
        if (pc.none) pl.noCode = true;
        else pl.code = pc.code;
        pc.used = true;
      });
    }
    // A code labelled for a drive, left over: a link of that drive nearby
    // with no code, preferring its own paragraph, then a link above it (codes
    // follow their links), then the nearest.
    tokens.forEach(function(code) {
      if (code.kind !== 'C' || code.used || !code.drive || code.drive === 'foreign') return;
      var bestLink = null;
      var bestRank = null;
      for (var k = 0; k < tokens.length; k++) {
        var link = tokens[k];
        if (link.kind !== 'L' || link.pan !== code.drive || link.code || link.noCode || link.urlCode) continue;
        var distance = link.start < code.start ? code.start - link.end : link.start - code.end;
        if (distance > SharedUtils.ACCESS_CODE_LABEL_REACH || Math.abs(link.line - code.line) > SharedUtils.ACCESS_CODE_BLOCK_LINES) continue;
        var rank = [link.para === code.para ? 0 : 1, link.start < code.start ? 0 : 1, distance];
        if (!bestRank || rank[0] < bestRank[0] || (rank[0] === bestRank[0] && (rank[1] < bestRank[1] || (rank[1] === bestRank[1] && rank[2] < bestRank[2])))) {
          bestLink = link;
          bestRank = rank;
        }
      }
      if (bestLink) {
        bestLink.code = code.code;
        code.used = true;
      }
    });

    var byKey = {};
    tokens.forEach(function(token) {
      if (!token.key || !token.code) return;
      if (!byKey[token.key]) byKey[token.key] = [];
      if (byKey[token.key].indexOf(token.code) === -1) byKey[token.key].push(token.code);
    });
    return byKey;
  },

  addAltAccessCode: function(item, code) {
    code = SharedUtils.cleanPasswordValue(code || '');
    if (!item || !code || code === item.code) return;
    var alt = Array.isArray(item.altCodes) ? item.altCodes.slice() : [];
    if (alt.indexOf(code) !== -1 || alt.length >= 3) return;
    alt.push(code);
    item.altCodes = alt;
  },

  // The code a share link carries in its own query (?pwd=...), if any.
  extractAccessCode: function(url) {
    try {
      return this.extractAccessCodeFromUrlQuery(new URL(url));
    } catch (e) {
      return '';
    }
  },

  extractArchivePasswords: function(text) {
    var result = [];
    var seen = Object.create(null);
    var regex = /[【\[\(（「『]?\s*(?:解压密码|压缩密码|压缩包密码|解压包密码|(?:rar|zip|7z)\s*密码|解压码|解压口令|解壓密碼|解壓碼)\s*[】\]\)）」』]?\s*[:：=]?\s*/gi;
    var m;
    while ((m = regex.exec(text)) !== null) {
      // A password sits right after its label; rescanning the whole remaining
      // text for every label was quadratic on label-heavy TXT files.
      var rest = text.slice(regex.lastIndex, regex.lastIndex + 500).replace(/^[\s\u00a0]+/, '');
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
    var seen = Object.create(null);
    var fieldRegex = /[【\[\(（「『]?\s*(?:解压密码|压缩密码|压缩包密码|解压包密码|(?:rar|zip|7z)\s*密码|解压码|解压口令|解壓密碼|解壓碼)\s*[】\]\)）」』]?\s*[:：=]?\s*/gi;
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
    var seen = Object.create(null);
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
    var seen = Object.create(null);
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
    // Archive passwords are case-sensitive: 'Pass123' and 'pass123' are two
    // candidates, not one.
    var compactA = a.replace(/[\s@]+/g, '');
    var compactB = b.replace(/[\s@]+/g, '');
    return compactA && compactA === compactB;
  },

  cleanPasswordValue: function(value) {
    var v = String(value || '').trim();
    if (!v) return '';
    v = v.replace(/^[\s:：=】\]\)）」』>》]+/, '').trim();
    v = v.replace(/(?<![。；;，,、\s])[。；;，,、\s]+$/g, '');
    if (!v) return '';
    if (this.isInvalidPasswordValue(v)) return '';
    if (this.isProtectedEmailPlaceholder(v)) return '';
    var separator = /\s+/.exec(v);
    if (separator && /[\u4e00-\u9fa5]/.test(v.substring(separator.index + separator[0].length))) {
      v = v.substring(0, separator.index);
    }
    return v.slice(0, 80);
  },

  // 合并起始标记扫描，避免每个注释都为不存在的其他标签反复扫描剩余全文。
  stripNonRenderedHtmlRegions: function(html) {
    html = String(html || '');
    var opening = /<!--|<\/?([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/gi;
    var out = [];
    var pos = 0;
    var match;
    while ((match = opening.exec(html)) !== null) {
      var end;
      if (!match[1]) {
        var commentEnd = html.indexOf('-->', opening.lastIndex);
        end = commentEnd === -1 ? html.length : commentEnd + 3;
      } else {
        var tagEnd = SharedUtils.findHtmlTagEnd(html, opening.lastIndex);
        if (tagEnd === -1) break;
        opening.lastIndex = tagEnd + 1;
        if (match[0].charAt(1) === '/' || !/^(?:textarea|noscript|title|script|style)$/i.test(match[1])) continue;
        var closing = new RegExp('</' + match[1] + '[\\t\\n\\f\\r ]*>', 'gi');
        closing.lastIndex = opening.lastIndex;
        end = closing.exec(html) ? closing.lastIndex : html.length;
      }
      out.push(html.slice(pos, match.index), ' ');
      pos = opening.lastIndex = end;
    }
    if (!out.length) return html;
    out.push(html.slice(pos));
    return out.join('');
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
      var r = SharedUtils.resolveUrl(baseUrl, url, true);
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
      if (/^(?:zoom\/regex|zoomfile\/standalone|file\/regex)$/.test(existing.source || '')) return false;
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

    // Tokenize once instead of retrying whole-tail regex matches at every '<'.
    // Keep the existing priority: zoom, standalone zoomfile, file, img, href, OG.
    var tags = [];
    SharedUtils.forEachHtmlTag(html, function(name, attrs) {
      if (!canContinue()) return false;
      // Do not allocate records or repeatedly parse attributes for layout-only tags.
      if (name !== 'img' && name !== 'meta' && !/(?:^|\s)(?:zoomfile|file|href)\s*=/i.test(attrs)) return;
      tags.push({ name: name, attrs: attrs,
        zoomfile: SharedUtils.extractHtmlAttr(attrs, 'zoomfile'),
        file: SharedUtils.extractHtmlAttr(attrs, 'file') });
    });
    for (var zi = 0; zi < tags.length && canContinue(); zi++) {
      var zoomTag = tags[zi];
      if (/^(?:img|a|span|ignore_js_op)$/.test(zoomTag.name) &&
          /(?:^|\s)zoom(?:\s|$)/.test(SharedUtils.extractHtmlAttr(zoomTag.attrs, 'class'))) {
        add(zoomTag.file || zoomTag.zoomfile, 'zoom/regex');
      }
    }
    for (var zfi = 0; zfi < tags.length && canContinue(); zfi++) {
      if (tags[zfi].zoomfile) add(tags[zfi].zoomfile, 'zoomfile/standalone');
    }
    for (var fi = 0; fi < tags.length && canContinue(); fi++) {
      if (/^(?:img|a)$/.test(tags[fi].name) && tags[fi].file) add(tags[fi].file, 'file/regex');
    }
    for (var ii = 0; ii < tags.length && canContinue(); ii++) {
      if (tags[ii].name === 'img') addBestFromImgTag(tags[ii].attrs);
    }
    for (var hi = 0; hi < tags.length && canContinue(); hi++) {
      var href = SharedUtils.extractHtmlAttr(tags[hi].attrs, 'href');
      if (href && SharedUtils.isDirectImageUrl(href)) add(href, 'link-href');
    }
    for (var oi = 0; oi < tags.length && canContinue(); oi++) {
      if (tags[oi].name === 'meta' && SharedUtils.extractHtmlAttr(tags[oi].attrs, 'property').toLowerCase() === 'og:image') {
        add(SharedUtils.extractHtmlAttr(tags[oi].attrs, 'content'), 'og:image');
        break;
      }
    }

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
      // DOM attributes have already been entity-decoded by DOMParser.
      src = SharedUtils.cleanResourceUrl(src);
      var url = SharedUtils.resolveUrl(baseUrl, src, true);
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
      if (existing.source === 'zoom/file') return false;
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
      .replace(/<[^<>]+>/g, '')
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
    if (Object.prototype.hasOwnProperty.call(explicitPlaceholders, v)) return true;
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
