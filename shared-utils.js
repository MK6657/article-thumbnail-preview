const SharedUtils = {
  DEFAULT_CACHE_QUOTA_BYTES: 32 * 1024 * 1024,
  TEXT_ATTACHMENT_MAX_COUNT: 3,
  TEXT_ATTACHMENT_MAX_BYTES: 512 * 1024,
  TEXT_ATTACHMENT_TIMEOUT: 10000,
  ARTICLE_HTML_MAX_BYTES: 2 * 1024 * 1024,
  ARTICLE_HTML_MAX_CHARS: 1000000,
  ARTICLE_IMAGE_EXTRACTION_VERSION: 2,
  DOM_IMAGE_EXTRACT_HTML_MAX_CHARS: 300000,
  BG_FETCH_MAX_URLS: 60,
  BG_FETCH_MAX_TEXT_ATTACHMENTS: 30,
  BG_FETCH_CHUNK_SIZE: 3,
  BG_FETCH_TIMEOUT_MS: 15000,
  BG_FETCH_TIMEOUT_BUFFER_MS: 3000,
  FORUM_BASE_PAUSE_MS: 20000,
  CONTENT_LOG_INDEX_KEY: 'atp_logs_content_keys',
  BACKGROUND_LOG_KEY: 'atp_logs_bg',
  LOG_CLEARED_AT_KEY: 'atp_logs_cleared_at',
  MAX_CONTENT_LOG_KEYS: 20,
  CONTENT_LOG_TOTAL_BYTES: 2 * 1024 * 1024,
  CONTENT_LOG_KEY_BYTES: 160 * 1024,
  BACKGROUND_LOG_BYTES: 512 * 1024,
  MESSAGE_TYPES: Object.freeze({
    CACHE_INDEX_MUTATION: 'CACHE_INDEX_MUTATION',
    GET_CACHE_INDEX: 'GET_CACHE_INDEX',
    CLEAR_CACHE: 'CLEAR_CACHE',
    ARTICLE_CACHE_MUTATION: 'ARTICLE_CACHE_MUTATION',
    SAVE_SETTINGS_PATCH: 'SAVE_SETTINGS_PATCH',
    FETCH_IMAGES: 'FETCH_IMAGES',
    FETCH_TEXT_RESOURCES: 'FETCH_TEXT_RESOURCES',
    FETCH_TEXT_ATTACHMENTS_FRESH: 'FETCH_TEXT_ATTACHMENTS_FRESH',
    MIRROR_SITES_SYNC: 'MIRROR_SITES_SYNC',
    REPORT_FORUM_PACER_STATUS: 'REPORT_FORUM_PACER_STATUS',
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
        if (index.items[i] && typeof index.items[i].id === 'string') {
          keys.push(storage.ITEM_PREFIX + encodeURIComponent(index.items[i].id));
        }
      }
    }
    if (days && days.days && typeof days.days === 'object') {
      for (var date in days.days) {
        if (Object.prototype.hasOwnProperty.call(days.days, date)) {
          keys.push(storage.DAY_PREFIX + date);
        }
      }
    }
    return keys;
  },

  // Storage keys of background & content diagnostic logs so log shards never
  // count against cache watermarks or trigger article cache eviction.
  getLogStorageKeys: function(items, discoveredKeys) {
    var seen = Object.create(null);
    var out = [];
    function pushKey(k) {
      if (typeof k === 'string' && k && !seen[k]) {
        seen[k] = true;
        out.push(k);
      }
    }
    var contentIndexKey = SharedUtils.CONTENT_LOG_INDEX_KEY;
    var bgKey = SharedUtils.BACKGROUND_LOG_KEY;
    var clearedKey = SharedUtils.LOG_CLEARED_AT_KEY;
    if (items && typeof items === 'object') {
      if (Object.prototype.hasOwnProperty.call(items, bgKey) && items[bgKey] !== undefined) pushKey(bgKey);
      if (Object.prototype.hasOwnProperty.call(items, clearedKey) && items[clearedKey] !== undefined) pushKey(clearedKey);
      if (Object.prototype.hasOwnProperty.call(items, contentIndexKey) && items[contentIndexKey] !== undefined) {
        pushKey(contentIndexKey);
        var indexed = items[contentIndexKey];
        if (Array.isArray(indexed)) {
          for (var i = 0; i < indexed.length; i++) {
            var shard = indexed[i];
            if (typeof shard === 'string' && shard.indexOf('atp_logs_content_') === 0 && shard !== contentIndexKey) {
              pushKey(shard);
            }
          }
        }
      }
      for (var prop in items) {
        if (Object.prototype.hasOwnProperty.call(items, prop) && items[prop] !== undefined && prop !== contentIndexKey && prop.indexOf('atp_logs_content_') === 0) {
          pushKey(prop);
        }
      }
    }
    if (Array.isArray(discoveredKeys)) {
      for (var d = 0; d < discoveredKeys.length; d++) {
        var dk = discoveredKeys[d];
        if (dk === bgKey || dk === clearedKey || dk === contentIndexKey ||
            (typeof dk === 'string' && dk.indexOf('atp_logs_content_') === 0)) {
          pushKey(dk);
        }
      }
    }
    return out;
  },

  // Bytes the caches count against their budget: getBytesInUse(null) minus
  // marks, backups, and diagnostic logs.
  getCacheBytesInUse: function(callback) {
    var local = chrome.storage.local;
    local.getBytesInUse(null, function(total) {
      if (chrome.runtime.lastError) {
        callback(total);
        return;
      }
      var numericTotal = Number(total) || 0;
      if (numericTotal <= 0) {
        callback(0);
        return;
      }
      var storage = SharedUtils.MARKS_STORAGE;
      function answer(bytes, fromFailedCall) {
        if (fromFailedCall) setTimeout(function() { callback(bytes); }, 0);
        else callback(bytes);
      }
      function subtractExcludedKeys(excludedKeys) {
        if (!excludedKeys.length) {
          answer(numericTotal, false);
          return;
        }
        local.getBytesInUse(excludedKeys, function(kept) {
          if (chrome.runtime.lastError) {
            answer(numericTotal, true);
            return;
          }
          answer(Math.max(0, numericTotal - (Number(kept) || 0)), false);
        });
      }
      if (typeof local.getKeys === 'function') {
        try {
          local.getKeys(function(allKeys) {
            if (chrome.runtime.lastError || !Array.isArray(allKeys)) {
              readExcludedViaMetadata();
              return;
            }
            var excluded = [];
            for (var i = 0; i < allKeys.length; i++) {
              var k = allKeys[i];
              if (typeof k !== 'string') continue;
              if (k.indexOf(storage.PREFIX) === 0 ||
                  k === SharedUtils.BACKGROUND_LOG_KEY ||
                  k === SharedUtils.LOG_CLEARED_AT_KEY ||
                  k === SharedUtils.CONTENT_LOG_INDEX_KEY ||
                  k.indexOf('atp_logs_content_') === 0) {
                excluded.push(k);
              }
            }
            subtractExcludedKeys(excluded);
          });
          return;
        } catch (e) {}
      }
      function readExcludedViaMetadata() {
        var metaKeys = [
          storage.INDEX,
          storage.DAYS,
          SharedUtils.CONTENT_LOG_INDEX_KEY,
          SharedUtils.BACKGROUND_LOG_KEY,
          SharedUtils.LOG_CLEARED_AT_KEY
        ];
        local.get(metaKeys, function(items) {
          if (chrome.runtime.lastError) {
            answer(numericTotal, true);
            return;
          }
          var marksKeys = SharedUtils.getMarksStorageKeys(items);
          var logKeys = SharedUtils.getLogStorageKeys(items);
          var inlineBytes = 0;
          var remainingKeys = marksKeys.slice();
          for (var i = 0; i < logKeys.length; i++) {
            var lk = logKeys[i];
            if ((lk === SharedUtils.BACKGROUND_LOG_KEY || lk === SharedUtils.LOG_CLEARED_AT_KEY || lk === SharedUtils.CONTENT_LOG_INDEX_KEY) &&
                items && Object.prototype.hasOwnProperty.call(items, lk) && items[lk] !== undefined) {
              inlineBytes += lk.length + SharedUtils.utf8ByteLength(JSON.stringify(items[lk]));
            } else {
              remainingKeys.push(lk);
            }
          }
          numericTotal = Math.max(0, numericTotal - inlineBytes);
          subtractExcludedKeys(remainingKeys);
        });
      }
      readExcludedViaMetadata();
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

  // Zero-allocation UTF-8 byte counter using pure UTF-16 charCode arithmetic
  // (avoids allocating a Uint8Array via TextEncoder on every cache/log entry).
  utf8ByteLength: function(str) {
    var s = typeof str === 'string' ? str : String(str == null ? '' : str);
    var len = s.length;
    var bytes = 0;
    for (var i = 0; i < len; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) {
        bytes += 1;
      } else if (c < 0x800) {
        bytes += 2;
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < len) {
        var next = s.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          bytes += 4;
          i++;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    }
    return bytes;
  },

  isHeavyImageCandidate: function(imgData) {
    return SharedUtils.isHeavyImageUrl(SharedUtils.getImagePreviewSrc(imgData));
  },

  isHeavyImageCandidateSet: function(candidates, settings) {
    if (!settings || settings.heavyImageOptimization === false) return false;
    candidates = Array.isArray(candidates) ? candidates : [];
    if (!candidates.length) return false;
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

  getImageExtractionPlan: function(settings) {
    settings = settings || {};
    var displayLimit = SharedUtils.effectiveDisplayLimit(settings);
    var fetchLimit = SharedUtils.effectiveFetchLimit(settings);
    var fallbackLimit = SharedUtils.effectiveFallbackLimit(settings);
    var initialLimit = fetchLimit <= displayLimit ? displayLimit : fallbackLimit;
    return {
      limit: Math.max(initialLimit, fetchLimit),
      options: fetchLimit <= initialLimit ? null : {
        softLimit: initialLimit,
        shouldExpand: function(images) {
          return SharedUtils.isHeavyImageCandidatePrefix(images, settings, displayLimit);
        }
      }
    };
  },

  createImageCollectionGuard: function(images, maxCount, options) {
    var limit = Math.max(0, Math.floor(Number(maxCount) || 0));
    var softLimit = options && options.softLimit > 0
      ? Math.min(limit, Math.floor(Number(options.softLimit) || 0))
      : 0;
    var expanded = !softLimit || softLimit >= limit;
    return function() {
      if (images.length >= limit) return false;
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
    var ct = contentType || (resp && resp.headers && resp.headers.get ? resp.headers.get('content-type') : '');
    if (SharedUtils.decodeTextBuffer) {
      return SharedUtils.decodeTextBuffer(buffer, ct);
    }
    return typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8').decode(buffer) : '';
  },

  getBackgroundFetchTimeout: function(count) {
    count = Math.max(1, Number(count) || 1);
    return Math.ceil(count / SharedUtils.BG_FETCH_CHUNK_SIZE) * SharedUtils.BG_FETCH_TIMEOUT_MS + SharedUtils.BG_FETCH_TIMEOUT_BUFFER_MS;
  },

  getTextAttachmentBackgroundTimeout: function(count) {
    count = Math.max(1, Math.min(SharedUtils.TEXT_ATTACHMENT_MAX_COUNT, Number(count) || 1));
    return SharedUtils.TEXT_ATTACHMENT_TIMEOUT * (count * 2 + 1) + SharedUtils.BG_FETCH_TIMEOUT_BUFFER_MS;
  },

  isCloudflareChallengeResponse: function(resp) {
    var headers = resp && resp.headers;
    if (!headers || typeof headers.get !== 'function') return false;
    return String(headers.get('cf-mitigated') || '').toLowerCase() === 'challenge';
  },

  isForumFloodReason: function(reason) {
    return reason === 'rate_limited' ||
      reason === 'challenge_page' ||
      reason === 'cloudflare' ||
      reason === 'http_429' ||
      reason === 'http_503';
  },

  CACHE_PREFIXES: {
    IMAGE: 'thumb_cache_v2_',
    ARTICLE: 'article_cache_v13_',
    TEXT_RESOURCE: 'txt_resource_cache_v4_',
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

  decodeHtmlEntities: function(text) {
    var s = String(text || '');
    if (s.indexOf('&') === -1) return s;
    var named = { nbsp: ' ', commat: '@', quot: '"', lt: '<', gt: '>', amp: '&' };
    return s.replace(/&(?:(nbsp|commat|quot|lt|gt|amp)|#(\d+)|#x([0-9a-f]+));/gi,
      function(entity, name, decimal, hex) {
        if (name) return named[name.toLowerCase()];
        var cp = parseInt(hex || decimal, hex ? 16 : 10);
        if (!isFinite(cp) || cp < 0 || cp > 0x10FFFF) return entity;
        try { return String.fromCodePoint ? String.fromCodePoint(cp) : String.fromCharCode(cp); } catch (e) { return entity; }
      });
  },

  escapeHtml: function(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  resolveUrl: function(baseUrl, relativeUrl, alreadyDecoded) {
    if (!relativeUrl) return null;
    relativeUrl = (alreadyDecoded ? String(relativeUrl) : SharedUtils.decodeHtmlEntities(String(relativeUrl))).trim().replace(/\\\//g, '/');
    if (/^(?:data|blob|javascript|mailto|tel):/i.test(relativeUrl)) return null;
    try { return new URL(relativeUrl, baseUrl).href; } catch (e) { return null; }
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
        while (pos < len && /\s/.test(text.charAt(pos))) pos++;
        var descStart = pos;
        while (pos < len && text.charAt(pos) !== ',') pos++;
        descriptor = text.substring(descStart, pos).trim();
        if (pos < len) pos++;
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
    } catch (e) {
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
    } catch (e) {
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
    } catch (e) {
      return url;
    }
  },

  getTextAttachmentCacheKeySuffix: function(url) {
    return SharedUtils.hashAttachmentKey(SharedUtils.normalizeTextAttachmentUrl(url));
  },

  hashAttachmentKey: function(normalized) {
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

  textFileNameKey: function(name) {
    var base = String(name || '').split(/[\\/]/).pop().trim().normalize('NFC').toLowerCase();
    return /\.txt$/.test(base) ? SharedUtils.hashAttachmentKey(base) : '';
  },

  getTextAttachmentHints: function(attachments) {
    var hints = [], seen = new Set();
    for (var item of Array.isArray(attachments) ? attachments : []) {
      var url = typeof item === 'string' ? item : item && item.url;
      if (!url || !SharedUtils.isAllowedTextAttachmentUrl(url, item.pageUrl)) continue;
      var key = SharedUtils.normalizeTextAttachmentUrl(url);
      if (seen.has(key)) continue;
      seen.add(key);
      var stable = SharedUtils.isPersistableTextAttachmentUrl(url, item.pageUrl);
      var nameKey = SharedUtils.textFileNameKey(item.name);
      if (!nameKey && stable) {
        try { nameKey = SharedUtils.textFileNameKey(decodeURIComponent(new URL(url).pathname)); } catch (e) {}
      }
      hints.push({ urlKey: stable ? SharedUtils.hashAttachmentKey(key) : '', nameKey: nameKey });
      if (hints.length >= SharedUtils.TEXT_ATTACHMENT_MAX_COUNT) break;
    }
    return hints;
  },

  mergeTextAttachmentHints: function() {
    var merged = [], counts = new Map();
    var valid = /^h_[a-z0-9]{1,7}_[a-z0-9]{1,7}_[a-z0-9]{1,6}$/;
    for (var hints of arguments) {
      if (!Array.isArray(hints)) continue;
      var inBatch = new Map();
      for (var hint of hints.slice(0, SharedUtils.TEXT_ATTACHMENT_MAX_COUNT)) {
        if (!hint) continue;
        var urlKey = typeof hint.urlKey === 'string' && valid.test(hint.urlKey) ? hint.urlKey : '';
        var nameKey = typeof hint.nameKey === 'string' && valid.test(hint.nameKey) ? hint.nameKey : '';
        if (!urlKey && !nameKey) continue;
        var key = urlKey || 'name_' + nameKey;
        var count = urlKey ? 1 : (inBatch.get(key) || 0) + 1;
        inBatch.set(key, count);
        if (count <= (counts.get(key) || 0)) continue;
        if (merged.length >= SharedUtils.TEXT_ATTACHMENT_MAX_COUNT) break;
        counts.set(key, count);
        merged.push({ urlKey: urlKey, nameKey: nameKey });
      }
    }
    return merged;
  },

  textAttachmentProgressId: function(hint, hints) {
    if (!hint) return '';
    if (hint.urlKey) return hint.urlKey;
    if (!hint.nameKey || hints.filter(function(item) { return item.nameKey === hint.nameKey; }).length !== 1) return '';
    return 'name_' + hint.nameKey;
  },

  mergeResolvedTextIds: function(hints, previousIds, newIds) {
    var supplied = [].concat(Array.isArray(previousIds) ? previousIds : [], Array.isArray(newIds) ? newIds : []);
    return hints.map(function(hint) { return SharedUtils.textAttachmentProgressId(hint, hints); })
      .filter(function(id) { return id && supplied.indexOf(id) !== -1; });
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
  BUILTIN_FORUM_ROOTS: Object.freeze(['sehuatang.org', 'sehuatang.net']),
  TEXT_DIRECT_DOWNLOAD_HOSTS: Object.freeze(['dl.ldkms.la']),
  SIGNED_TEXT_DOWNLOAD_HOSTS: Object.freeze(['xia.ewrewej.la', 'xia.djhdhs.us']),
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

  getMirrorForumRoot: function(host) {
    var best = '';
    var mirrorSites = SharedUtils._mirrorSites;
    for (var i = 0; i < mirrorSites.length; i++) {
      if (!SharedUtils.isHostInMirrorSite(host, mirrorSites[i])) continue;
      if (!best || mirrorSites[i].root.length < best.length) best = mirrorSites[i].root;
    }
    return best;
  },

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
    var url;
    try {
      url = new URL(src, 'https://example.invalid/');
    } catch (e) {
      return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (/[?&](?:aid=|mod=attachment(?:&|$))/i.test(url.search)) return true;
    var path = url.pathname.toLowerCase();
    if (/avatar|icon|logo|1x1|pixel|blank/.test(path)) return false;
    if (/\.svg$/.test(path)) return false;
    if (/\/static\/image\//.test(path)) return false;
    if (/pn_post\.|print\.png|thread-prev|thread-next|userinfo\.|online\.|offline\.|folder_|agree\.gif|digest_|pin_|hot_|recommend_|lock\.|collapsed_/.test(path)) return false;
    return true;
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
      if (urlCode) {
        result.code = urlCode;
        result.codeFromUrl = true;
      }
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
        item.url = this.cleanResourceUrl(item.url || '');
        var normalizedPan = this.normalizePanResourceUrlCode(type, item.url, item.code);
        item.url = normalizedPan.url;
        if (normalizedPan.code) {
          item.code = normalizedPan.code;
          if (normalizedPan.codeFromUrl) item.codeOrigin = 'url';
          else if (item.codeOrigin !== 'url' && item.codeOrigin !== 'txt' && item.codeOrigin !== 'html') delete item.codeOrigin;
        } else {
          delete item.code;
          delete item.codeOrigin;
        }
        if (!item.source) item.source = 'html';
        if (!item.url || !this.isCopyableResourceUrl(type, item.url)) continue;
        var altCodes = Array.isArray(item.altCodes) ? item.altCodes : [];
        delete item.altCodes;
        var dedupKey = this.getResourceDedupKey(type, item.url);
        if (seen[dedupKey]) {
          var existing = seen[dedupKey];
          existing.source = this.mergeResourceSource(existing.source, item.source);
          this.mergeAccessCode(existing, item);
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

  cleanResourceUrl: function(url) {
    var cleaned = String(url || '')
      .trim()
      .replace(/^[「『“”"'(\[【（《〈]+/, '');
    var trailingPunctuation = /(?<![」』“”"'\])】）》〉>。；;，,、？！…])[」』“”"'\])】）》〉>。；;，,、？！…]+$/g;
    if (/^ed2k:\/\//i.test(cleaned)) {
      cleaned = cleaned.replace(/[\r\n]+/g, ' ');
      var ed2kEnd = cleaned.indexOf('|/');
      if (ed2kEnd !== -1) cleaned = cleaned.slice(0, ed2kEnd + 2);
      return cleaned.replace(trailingPunctuation, '');
    }
    if (/^magnet:\?/i.test(cleaned)) {
      cleaned = cleaned.replace(/(btih:[A-Fa-f0-9]{32,40})(?:[。；;，,、\s]*)?(?:提取[码碼]|提取密码|访问码|取件码|解压密码|压缩密码|解压码|解压口令|解壓密碼|解壓碼|密码)\s*[:：=]?.*$/i, '$1');
      cleaned = cleaned.replace(/(?<![。；;，,、\s])[。；;，,、\s]+(?:(?:提取[码碼]|提取密码|访问码|取件码|解压密码|压缩密码|解压码|解压口令|解壓密碼|解壓碼)\s*[:：=]?|密码\s*[:：=]).*$/i, '');
      return cleaned.replace(trailingPunctuation, '');
    }
    var queryStart = cleaned.search(/[?#]/);
    if (queryStart !== -1 && !/(?:提取[码碼]|提取密码|访问码|取件码|解压密码|压缩密码|密码)\s*[:：=]/i.test(cleaned.slice(queryStart))) {
      return cleaned.replace(/[」』“”】）》〉。；，、？！…][\s\S]*$/g, '');
    }
    if (/(?:pan\.baidu\.com|yun\.baidu\.com|pan\.quark\.cn|115\.com\/s\/|(?:aliyundrive|alipan)\.com\/s\/|drive\.uc\.cn\/s\/|pan\.xunlei\.com\/s\/)/i.test(cleaned)) {
      cleaned = cleaned.replace(/(?<![。；;，,、\s])[。；;，,、\s]*(?:提取[码碼]|提取密码|访问码|取件码|解压密码|压缩密码|密码)\s*[:：=]?.*$/i, '');
      return cleaned.replace(/[」』“”"'\])】）》〉>。；;，,、？！…][\s\S]*$/g, '');
    }
    if (/^(?:https?:)?\/\/xia\.(?:ewrewej\.la|djhdhs\.us)\//i.test(cleaned) || /(?:forum\.php\?|attachment\.php\?|misc\.php\?)/i.test(cleaned)) {
      cleaned = cleaned.replace(/[」』“”"'\])】）》〉>。；;，,、？！…][\s\S]*$/g, '');
      return cleaned;
    }
    cleaned = cleaned.replace(/(\.(?:jpg|jpeg|png|gif|webp|txt|zip|rar|7z|torrent)(?:[?#][^」』“”"'\])】）》〉>。；;，,、？！…\s<]*)?)[」』“”"'\])】）》〉>。；;，,、？！…][\s\S]*$/i, '$1');
    return cleaned.replace(trailingPunctuation, '');
  },

  mergeAccessCode: function(item, incoming) {
    if (!incoming.code) return;
    var promote = !item.code ||
      (incoming.codeOrigin === 'url' && item.codeOrigin !== 'url') ||
      (incoming.codeOrigin === 'txt' && item.codeOrigin === 'html');
    if (!promote) {
      this.addAltAccessCode(item, incoming.code);
      return;
    }
    var previousCode = item.code;
    var alternatives = item.altCodes || [];
    item.code = incoming.code;
    if (incoming.codeOrigin) item.codeOrigin = incoming.codeOrigin;
    else delete item.codeOrigin;
    delete item.altCodes;
    this.addAltAccessCode(item, previousCode);
    for (var i = 0; i < alternatives.length; i++) this.addAltAccessCode(item, alternatives[i]);
  },

  addAltAccessCode: function(item, code) {
    code = SharedUtils.cleanPasswordValue(code || '');
    if (!item || !code || code === item.code) return;
    var alt = Array.isArray(item.altCodes) ? item.altCodes.slice() : [];
    if (alt.indexOf(code) !== -1 || alt.length >= 3) return;
    alt.push(code);
    item.altCodes = alt;
  },

  extractAccessCode: function(url) {
    try {
      return this.extractAccessCodeFromUrlQuery(new URL(url));
    } catch (e) {
      return '';
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
    FLUSH_DEBOUNCE_MS: 2500,

    _queue: [],
    _queueOffset: 0,
    _writing: false,
    _backgroundOwner: false,
    _memoryEntries: null,
    _totalBytes: 0,
    _dirty: false,
    _flushTimer: null,
    _mutationRev: 0,

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

    _adoptMemoryEntries: function(entries) {
      var ci = SharedUtils.cacheIndex;
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        ci._memoryEntries = null;
        ci._totalBytes = 0;
        return null;
      }
      var clean = {};
      var total = 0;
      for (var k in entries) {
        if (Object.prototype.hasOwnProperty.call(entries, k) && entries[k]) {
          clean[k] = entries[k];
          total += Number(entries[k].b) || 0;
        }
      }
      ci._memoryEntries = clean;
      ci._totalBytes = Math.max(0, total);
      return clean;
    },

    getTotalBytes: function() {
      var ci = SharedUtils.cacheIndex;
      return ci._memoryEntries !== null ? Math.max(0, ci._totalBytes) : 0;
    },

    clearMemory: function() {
      var ci = SharedUtils.cacheIndex;
      if (ci._flushTimer) {
        clearTimeout(ci._flushTimer);
        ci._flushTimer = null;
      }
      ci._memoryEntries = {};
      ci._totalBytes = 0;
      ci._dirty = false;
      ci._mutationRev++;
    },

    resetMemory: function() {
      var ci = SharedUtils.cacheIndex;
      if (ci._flushTimer) {
        clearTimeout(ci._flushTimer);
        ci._flushTimer = null;
      }
      ci._memoryEntries = null;
      ci._totalBytes = 0;
      ci._dirty = false;
      ci._mutationRev++;
    },

    _scheduleDebouncedFlush: function() {
      var ci = SharedUtils.cacheIndex;
      if (!ci._backgroundOwner || !ci._dirty || ci._flushTimer) return;
      if (typeof setTimeout !== 'function') {
        ci.flushNow();
        return;
      }
      ci._flushTimer = setTimeout(function() {
        ci._flushTimer = null;
        ci.flushNow();
      }, ci.FLUSH_DEBOUNCE_MS);
    },

    flushNow: function(callback) {
      var ci = SharedUtils.cacheIndex;
      if (ci._flushTimer) {
        clearTimeout(ci._flushTimer);
        ci._flushTimer = null;
      }
      if (ci._proxyMutation('flush', {}, 'entries', function(entries) {
        ci._invokeCallback(callback, [!!entries, entries]);
      })) {
        return;
      }
      if (!ci._backgroundOwner) {
        ci._failUnavailableMutation('flush', 'boolean', callback);
        return;
      }
      ci._enqueue({
        kind: 'flush',
        run: function(done) {
          if (!ci._dirty || !ci._memoryEntries) {
            if (ci._memoryEntries !== null) {
              ci._finishQueueCallback(callback, [true, Object.assign({}, ci._memoryEntries)], done);
              return;
            }
            ci._readFromStorage(function(entries, readFailed) {
              if (readFailed) {
                ci._finishQueueCallback(callback, [false, null], done);
                return;
              }
              var adopted = entries ? ci._adoptMemoryEntries(entries) : null;
              ci._finishQueueCallback(callback, [true, adopted ? Object.assign({}, adopted) : null], done);
            });
            return;
          }
          var targetRev = ci._mutationRev;
          var snapshot = Object.assign({}, ci._memoryEntries);
          ci._writeNow(snapshot, function(success) {
            if (success && ci._mutationRev === targetRev) {
              ci._dirty = false;
            } else if (success && ci._dirty) {
              ci._scheduleDebouncedFlush();
            }
            ci._finishQueueCallback(callback, [success, success ? snapshot : null], done);
          });
        }
      });
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

    _ensureMemoryHydrated: function(callback) {
      var ci = SharedUtils.cacheIndex;
      if (ci._memoryEntries !== null) {
        callback(ci._memoryEntries, false);
        return;
      }
      ci._readFromStorage(function(entries, readFailed) {
        if (readFailed) {
          callback(null, true);
          return;
        }
        if (entries) {
          callback(ci._adoptMemoryEntries(entries), false);
          return;
        }
        callback(null, false);
      });
    },

    _applyUpdatesInMemory: function(targetEntries, updates) {
      var ci = SharedUtils.cacheIndex;
      for (var updateKey in updates) {
        if (Object.prototype.hasOwnProperty.call(updates, updateKey)) {
          var prev = targetEntries[updateKey];
          if (prev) ci._totalBytes = Math.max(0, ci._totalBytes - (Number(prev.b) || 0));
          var next = updates[updateKey];
          targetEntries[updateKey] = next;
          ci._totalBytes += Number(next && next.b) || 0;
        }
      }
      ci._mutationRev++;
    },

    _runUpdateEntries: function(updates, callbacks, done) {
      var ci = SharedUtils.cacheIndex;
      ci._ensureMemoryHydrated(function(entries, readFailed) {
        if (readFailed) {
          ci._finishUpdateEntries(callbacks, false, done);
          return;
        }
        function commitEntries(target) {
          ci._applyUpdatesInMemory(target, updates);
          var snapshot = Object.assign({}, target);
          ci._writeNow(snapshot, function(success) {
            if (!success) ci.resetMemory();
            else ci._dirty = false;
            ci._finishUpdateEntries(callbacks, success, done);
          });
        }
        if (!entries) {
          ci._scanEntriesNow(function(newEntries) {
            if (!newEntries) {
              ci._finishUpdateEntries(callbacks, false, done);
              return;
            }
            commitEntries(ci._adoptMemoryEntries(newEntries));
          });
          return;
        }
        commitEntries(entries);
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

    _readFromStorage: function(callback) {
      chrome.storage.local.get(SharedUtils.CACHE_INDEX_KEY, function(result) {
        if (SharedUtils.cacheIndex._storageError('storage读取失败')) {
          callback(null, true);
          return;
        }
        var raw = result && result[SharedUtils.CACHE_INDEX_KEY];
        if (!raw || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) {
          callback(null, false);
          return;
        }
        callback(raw.entries, false);
      });
    },

    read: function(callback) {
      var ci = SharedUtils.cacheIndex;
      if (ci._backgroundOwner) {
        if (ci._memoryEntries !== null) {
          callback(Object.assign({}, ci._memoryEntries), false);
          return;
        }
        ci._readFromStorage(function(entries, readFailed) {
          if (readFailed) {
            callback(null, true);
            return;
          }
          if (!entries) {
            callback(null, false);
            return;
          }
          var adopted = ci._adoptMemoryEntries(entries);
          callback(Object.assign({}, adopted), false);
        });
        return;
      }
      if (ci._shouldProxyMutation()) {
        try {
          chrome.runtime.sendMessage({ type: SharedUtils.MESSAGE_TYPES.GET_CACHE_INDEX }, function(response) {
            if (!chrome.runtime.lastError && response && response.ok === true) {
              callback(response.entries || null, false);
              return;
            }
            ci._readFromStorage(callback);
          });
          return;
        } catch (e) {}
      }
      ci._readFromStorage(callback);
    },

    getEntriesForEviction: function(callback) {
      var ci = SharedUtils.cacheIndex;
      if (ci._backgroundOwner && ci._memoryEntries !== null) {
        callback(Object.assign({}, ci._memoryEntries));
        return;
      }
      ci.read(function(entries, readFailed) {
        if (!readFailed && entries) {
          callback(entries);
          return;
        }
        ci.rebuild(callback);
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
      SharedUtils.cacheIndex.resetMemory();
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

    updateEntry: function(key, entry, callback) {
      var updates = {};
      if (typeof key === 'string' && key) updates[key] = entry;
      SharedUtils.cacheIndex.updateEntries(updates, callback);
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

    removeEntries: function(keys, callback, flushImmediate) {
      var ci = SharedUtils.cacheIndex;
      keys = keys || [];
      if (!keys.length) {
        if (callback) callback(true);
        return;
      }
      if (ci._proxyMutation('removeEntries', { keys: keys, flushImmediate: !!flushImmediate }, 'boolean', callback)) return;
      if (!ci._backgroundOwner) {
        ci._failUnavailableMutation('removeEntries', 'boolean', callback);
        return;
      }
      ci._enqueue({
        kind: 'removeEntries',
        run: function(done) {
          ci._ensureMemoryHydrated(function(entries, readFailed) {
            if (readFailed) {
              ci._finishQueueCallback(callback, [false], done);
              return;
            }
            if (!entries) {
              ci._finishQueueCallback(callback, [true], done);
              return;
            }
            var removedAny = false;
            for (var i = 0; i < keys.length; i++) {
              var k = keys[i];
              if (Object.prototype.hasOwnProperty.call(entries, k)) {
                ci._totalBytes = Math.max(0, ci._totalBytes - (Number(entries[k] && entries[k].b) || 0));
                delete entries[k];
                removedAny = true;
              }
            }
            if (!removedAny) {
              ci._finishQueueCallback(callback, [true], done);
              return;
            }
            ci._mutationRev++;
            if (ci._flushTimer) {
              clearTimeout(ci._flushTimer);
              ci._flushTimer = null;
            }
            ci._writeNow(Object.assign({}, entries), function(success) {
              if (!success) ci.resetMemory();
              else ci._dirty = false;
              ci._finishQueueCallback(callback, [success], done);
            });
          });
        }
      });
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
      var ci = SharedUtils.cacheIndex;
      if (ci._flushTimer) {
        clearTimeout(ci._flushTimer);
        ci._flushTimer = null;
      }
      ci._scanEntriesNow(function(entries) {
        if (!entries) {
          callback(null);
          return;
        }
        ci._writeNow(entries, function(success) {
          if (success) {
            var adopted = ci._adoptMemoryEntries(entries);
            ci._dirty = false;
            ci._mutationRev++;
            callback(Object.assign({}, adopted));
            return;
          }
          ci._invalidateNow(function() {
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

if (typeof globalThis !== 'undefined') {
  globalThis.SharedUtils = SharedUtils;
}
