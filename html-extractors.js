/**
 * HTML, Text, Image, Resource, Password & Access-Code Extractors
 *
 * Loaded after shared-utils.js in Content Scripts and Service Worker
 * (not loaded in popup.html). Attaches all extraction methods onto SharedUtils.
 */
(function(root) {
  'use strict';

  var S = (typeof SharedUtils !== 'undefined' && SharedUtils) || (root && root.SharedUtils);
  if (!S) return;

  // Precompiled closing-tag regexes for non-rendered region skipping
  var CLOSING_TAG_REGEXES = {
    script: /<\/script[\t\n\f\r ]*>/gi,
    style: /<\/style[\t\n\f\r ]*>/gi,
    title: /<\/title[\t\n\f\r ]*>/gi,
    noscript: /<\/noscript[\t\n\f\r ]*>/gi,
    textarea: /<\/textarea[\t\n\f\r ]*>/gi
  };

  var NON_RENDERED_OPEN_RE = /<!--|<(\/?)([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/gi;
  var HTML_TAG_OPEN_RE = /<(\/?)([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/gi;
  var DATA_ATTR_RE = /(?:^|\s)data-[\w-]+\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  var IMAGE_CANDIDATE_ATTR_RE = /(?:^|\s)(?:zoomfile|file|href)\s*=/i;
  var LINE_BREAK_BLOCK_RE = /^(?:p|div|li|tr|td|th|table|section)$/;
  var INLINE_JOIN_TAG_RE = /^(?:b|em|font|i|s|small|span|strong|sub|sup|u|wbr)$/;

  // Precompiled protocol guard regexes to avoid allocating 200KB lowercased copies
  var PROTOCOL_GUARDS = {
    'magnet:?': /magnet:\?/i,
    'magnet:': /magnet:/i,
    'ed2k://': /ed2k:\/\//i,
    'ed2k:': /ed2k:/i,
    'thunder://': /thunder:\/\//i,
    'thunder:': /thunder:/i
  };

  // Precompiled markers & regexes for collectAccessCodePairs
  var MARK_OPEN = '\uE000';
  var MARK_CLOSE = '\uE001';
  var PARA = '\uE002';
  var PICTURE = '\uE003';
  var PARA_CODE = 0xE002;
  var OWN_MARKS_RE = /[\uE000-\uE003]/g;
  var ANCHOR_MARKS_RE = /[\uE000\uE001]/g;
  var MARK_TOKEN_RE = /\uE000(\d+)\uE001/g;
  var PAN_LINK_RE = /(?:https?:\/\/|\/\/)?(?:www\.)?(?:pan\.baidu\.com\/(?:s\/|share\/)|yun\.baidu\.com\/(?:s\/|share\/)|pan\.quark\.cn\/s\/|115\.com\/s\/|(?:aliyundrive|alipan)\.com\/s\/|drive\.uc\.cn\/s\/|pan\.xunlei\.com\/s\/)[A-Za-z0-9\-._~:\/?#@!$&*+,;=%]*/gi;
  var BLOCK_LINK_RE = /(?:magnet:\?|ed2k:\/\/|thunder:\/\/)[^\s<>"']*/gi;
  var WEB_LINK_RE = /(?:https?:)?\/\/[A-Za-z0-9\-._~:\/?#@!$&*+,;=%]+/gi;
  var BARE_LINK_RE = /(^|[^A-Za-z0-9\-._~\/@:%])((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?\/[A-Za-z0-9\-._~:\/?#@!$&*+,;=%]+)/g;
  var ACCESS_CODE_RE_1 = /(?:提取[码碼]|提取密码|访问码|取件码)\s*[:：=]?\s*([A-Za-z0-9]{3,12})(?![A-Za-z0-9])/gi;
  var ACCESS_CODE_RE_2 = /提取[ \t]*[:：=][ \t]*([A-Za-z0-9]{3,12})(?![A-Za-z0-9])/gi;
  var ACCESS_CODE_RE_3 = /密码\s*[:：=]?\s*([A-Za-z0-9]{3,12})(?![A-Za-z0-9])/gi;
  var NONE_CODE_RE = /(?:[无無](?:需|[须須])?|免|不需要?|不用|没有)[ \t]*(?:提取[码碼]|提取密码|访问码|取件码|密码)|(?:提取[码碼]|提取密码|访问码|取件码|密码)[ \t]*[:：]?[ \t]*(?:[无無]|没有|不需要|不用)(?![一-龥A-Za-z0-9])/g;
  var NONE_CELL_RE = /(^|\n)[ \t]*(无|没有|无需|不需要)[ \t]*(?=\n|$)/g;

  // 2-slot recent article context cache so callers (e.g. fetcher.js) that pass
  // the same html string across prepareArticleExtractionContext, extractResources,
  // extractTextAttachments, and extractImagesForSettingsInSlices reuse stripped
  // HTML and parsed tag tables without re-scanning raw HTML.
  var recentContexts = [null, null];
  var recentContextSlot = 0;

  function findCachedContext(html) {
    if (typeof html !== 'string' || !html) return null;
    for (var i = 0; i < recentContexts.length; i++) {
      var entry = recentContexts[i];
      if (entry && (entry.sourceHtml === html || entry.limitedHtml === html)) {
        return entry.context;
      }
    }
    return null;
  }

  function rememberCachedContext(sourceHtml, limitedHtml, context) {
    recentContexts[recentContextSlot] = {
      sourceHtml: sourceHtml,
      limitedHtml: limitedHtml,
      context: context
    };
    recentContextSlot = (recentContextSlot + 1) & 1;
  }

  // Single-pass linear HTML attribute parser: parses all attributes of a tag
  // in O(len) charCode arithmetic without running per-attribute regexes.
  function parseHtmlAttributesOnce(attrs) {
    var map = Object.create(null);
    if (!attrs) return map;
    var input = String(attrs);
    var len = input.length;
    var i = 0;
    while (i < len) {
      while (i < len) {
        var ch = input.charCodeAt(i);
        if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12 || ch === 47) i++;
        else break;
      }
      if (i >= len) break;
      var nameStart = i;
      while (i < len) {
        var nc = input.charCodeAt(i);
        if (nc === 32 || nc === 9 || nc === 10 || nc === 13 || nc === 12 ||
            nc === 61 || nc === 47 || nc === 60 || nc === 62 || nc === 34 || nc === 39) break;
        i++;
      }
      if (i === nameStart) {
        i++;
        continue;
      }
      var attrName = input.slice(nameStart, i).toLowerCase();
      while (i < len) {
        var wc = input.charCodeAt(i);
        if (wc === 32 || wc === 9 || wc === 10 || wc === 13 || wc === 12) i++;
        else break;
      }
      var val = '';
      if (i < len && input.charCodeAt(i) === 61) {
        i++;
        while (i < len) {
          var vc = input.charCodeAt(i);
          if (vc === 32 || vc === 9 || vc === 10 || vc === 13 || vc === 12) i++;
          else break;
        }
        if (i < len) {
          var quote = input.charCodeAt(i);
          if (quote === 34 || quote === 39) {
            i++;
            var qEnd = input.indexOf(quote === 34 ? '"' : "'", i);
            if (qEnd === -1) {
              val = input.slice(i);
              i = len;
            } else {
              val = input.slice(i, qEnd);
              i = qEnd + 1;
            }
          } else {
            var uStart = i;
            while (i < len) {
              var uc = input.charCodeAt(i);
              if (uc === 32 || uc === 9 || uc === 10 || uc === 13 || uc === 12 || uc === 62) break;
              i++;
            }
            val = input.slice(uStart, i);
          }
        }
      }
      if (map[attrName] === undefined) {
        map[attrName] = val;
      }
    }
    return map;
  }

  function finishPostTagTextNormalize(text) {
    return text
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|td|th|table|section)>/gi, '\n')
      .replace(/<[^<>]+>/g, ' ')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n');
  }

  Object.assign(S, {
    parseHtmlAttributesOnce: parseHtmlAttributesOnce,

    findHtmlTagEnd: function(html, start) {
      var quote = '';
      var len = html.length;
      for (var end = start; end < len; end++) {
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

    forEachHtmlTag: function(html, callback, includeClosing) {
      var opening = new RegExp(HTML_TAG_OPEN_RE.source, 'gi');
      var match;
      while ((match = opening.exec(html)) !== null) {
        var attrsStart = opening.lastIndex;
        var end = S.findHtmlTagEnd(html, attrsStart);
        if (end === -1) return;
        opening.lastIndex = end + 1;
        var closing = match[1] === '/';
        if ((!closing || includeClosing) &&
            callback(match[2].toLowerCase(), html.slice(attrsStart, end), match.index, end + 1, closing) === false) {
          return;
        }
      }
    },

    replaceHtmlTags: function(html, replacement) {
      var parts = [];
      var offset = 0;
      this.forEachHtmlTag(html, function(name, attrs, start, end, closing) {
        parts.push(html.slice(offset, start), replacement(name, attrs, closing));
        offset = end;
      }, true);
      if (!offset) return html;
      parts.push(html.slice(offset));
      return parts.join('');
    },

    forEachAnchorTag: function(html, callback) {
      html = String(html || '');
      var anchor = null;
      this.forEachHtmlTag(html, function(name, attrs, start, end, closing) {
        if (name !== 'a') return;
        if (anchor && callback(anchor.attrs, html.slice(anchor.bodyStart, start), anchor.start, closing ? end : start) === false) {
          return false;
        }
        anchor = closing ? null : { attrs: attrs, start: start, bodyStart: end };
      }, true);
    },

    extractHtmlAttr: function(attrs, name) {
      if (!attrs || !name) return '';
      var target = String(name).toLowerCase();
      var input = String(attrs);
      if (input.toLowerCase().indexOf(target) === -1) return '';
      var parsed = parseHtmlAttributesOnce(input);
      return parsed[target] || '';
    },

    extractDataAttrValues: function(attrs) {
      var values = [];
      var input = String(attrs || '');
      if (input.indexOf('data-') === -1 && !/data-/i.test(input)) return values;
      DATA_ATTR_RE.lastIndex = 0;
      var m;
      while ((m = DATA_ATTR_RE.exec(input)) !== null) {
        values.push(m[1] || m[2] || m[3] || '');
      }
      return values;
    },

    stripNonRenderedHtmlRegions: function(html) {
      html = String(html || '');
      if (html.indexOf('<') === -1) return html;
      var opening = new RegExp(NON_RENDERED_OPEN_RE.source, 'gi');
      var out = [];
      var pos = 0;
      var match;
      while ((match = opening.exec(html)) !== null) {
        var end;
        if (!match[2]) {
          var commentEnd = html.indexOf('-->', opening.lastIndex);
          end = commentEnd === -1 ? html.length : commentEnd + 3;
        } else {
          var tagEnd = S.findHtmlTagEnd(html, opening.lastIndex);
          if (tagEnd === -1) break;
          opening.lastIndex = tagEnd + 1;
          if (match[1] === '/') continue;
          var lowerTag = match[2].toLowerCase();
          var closing = CLOSING_TAG_REGEXES[lowerTag];
          if (!closing) continue;
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

    htmlToText: function(html, tagAware, joinInline) {
      var text = String(html || '');
      if (text.indexOf('<') === -1 && text.indexOf('\r') === -1 && text.indexOf('  ') === -1 && text.indexOf('\t') === -1) {
        return text;
      }
      if (tagAware === true && text.indexOf('<') !== -1) {
        text = this.replaceHtmlTags(text, function(name, attrs, closing) {
          var lineBreak = closing ? LINE_BREAK_BLOCK_RE.test(name) : name === 'br';
          if (lineBreak) return '\n';
          if (joinInline && INLINE_JOIN_TAG_RE.test(name)) return '';
          return ' ';
        });
      }
      return finishPostTagTextNormalize(text);
    },

    restoreProtectedEmails: function(html) {
      html = String(html || '');
      if (html.indexOf('data-cfemail') === -1 && !/data-cfemail/i.test(html)) return html;
      return html.replace(/<[^<>]*class\s*=\s*["'][^"']*__cf_email__[^"']*["'][^<>]*data-cfemail\s*=\s*["']([0-9a-f]+)["'][^<>]*>[\s\S]{0,300}?<\/[^<>]+>/gi, function(match, hex) {
        return S.decodeCloudflareEmail(hex) || match;
      }).replace(/<[^<>]*data-cfemail\s*=\s*["']([0-9a-f]+)["'][^<>]*class\s*=\s*["'][^"']*__cf_email__[^"']*["'][^<>]*>[\s\S]{0,300}?<\/[^<>]+>/gi, function(match, hex) {
        return S.decodeCloudflareEmail(hex) || match;
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

    // Prepare stripped HTML, decoded text, and single-pass tag tables once
    // for extractResources, extractTextAttachments, and regex image extraction.
    prepareArticleExtractionContext: function(html) {
      var sourceHtml = String(html || '');
      var cached = findCachedContext(sourceHtml);
      if (cached) return cached;

      var limited = this.limitArticleHtml(sourceHtml);
      var restored = this.restoreProtectedEmails(limited);
      var rawHtml = this.stripNonRenderedHtmlRegions(restored);

      var textParts = [];
      var offset = 0;
      var openAnchor = null;
      var anchors = [];
      var linkTags = [];
      var metaTags = [];
      var imageTags = [];

      this.forEachHtmlTag(rawHtml, function(name, attrs, start, end, closing) {
        var lineBreak = closing ? LINE_BREAK_BLOCK_RE.test(name) : name === 'br';
        var replacement = lineBreak ? '\n' : (INLINE_JOIN_TAG_RE.test(name) ? '' : ' ');
        textParts.push(rawHtml.slice(offset, start), replacement);
        offset = end;

        if (name === 'a') {
          if (openAnchor) {
            anchors.push({
              attrs: openAnchor.attrs,
              attrMap: openAnchor.attrMap,
              body: rawHtml.slice(openAnchor.bodyStart, start),
              openIndex: openAnchor.start,
              endIndex: closing ? end : start
            });
          }
          if (closing) {
            openAnchor = null;
          } else {
            var aMap = parseHtmlAttributesOnce(attrs);
            openAnchor = { attrs: attrs, attrMap: aMap, start: start, bodyStart: end };
            linkTags.push({ tag: 'a', attrs: attrs, attrMap: aMap });
            if (aMap.zoomfile !== undefined || aMap.file !== undefined || aMap.href !== undefined) {
              imageTags.push({
                name: 'a',
                attrs: attrs,
                attrMap: aMap,
                zoomfile: aMap.zoomfile || '',
                file: aMap.file || ''
              });
            }
          }
          return;
        }

        if (closing) return;

        if (name === 'area') {
          var areaMap = parseHtmlAttributesOnce(attrs);
          linkTags.push({ tag: 'area', attrs: attrs, attrMap: areaMap });
          if (areaMap.zoomfile !== undefined || areaMap.file !== undefined || areaMap.href !== undefined) {
            imageTags.push({
              name: 'area',
              attrs: attrs,
              attrMap: areaMap,
              zoomfile: areaMap.zoomfile || '',
              file: areaMap.file || ''
            });
          }
          return;
        }

        if (name === 'img') {
          var imgMap = parseHtmlAttributesOnce(attrs);
          imageTags.push({
            name: 'img',
            attrs: attrs,
            attrMap: imgMap,
            zoomfile: imgMap.zoomfile || '',
            file: imgMap.file || ''
          });
          return;
        }

        if (name === 'meta') {
          var metaMap = parseHtmlAttributesOnce(attrs);
          var metaEntry = {
            name: 'meta',
            attrs: attrs,
            attrMap: metaMap,
            zoomfile: metaMap.zoomfile || '',
            file: metaMap.file || ''
          };
          metaTags.push(metaEntry);
          imageTags.push(metaEntry);
          return;
        }

        if (attrs && IMAGE_CANDIDATE_ATTR_RE.test(attrs)) {
          var candMap = parseHtmlAttributesOnce(attrs);
          imageTags.push({
            name: name,
            attrs: attrs,
            attrMap: candMap,
            zoomfile: candMap.zoomfile || '',
            file: candMap.file || ''
          });
        }
      }, true);

      var textBeforeFinish = offset ? (textParts.push(rawHtml.slice(offset)), textParts.join('')) : rawHtml;
      var decodedText = this.decodeHtmlEntities(finishPostTagTextNormalize(textBeforeFinish));

      var context = {
        rawHtml: rawHtml,
        text: decodedText
      };
      Object.defineProperties(context, {
        _anchors: { value: anchors, enumerable: false },
        _linkTags: { value: linkTags, enumerable: false },
        _metaTags: { value: metaTags, enumerable: false },
        _imageTags: { value: imageTags, enumerable: false },
        _canReuseImageTags: { value: restored === limited, enumerable: false }
      });

      rememberCachedContext(sourceHtml, limited, context);
      return context;
    },

    forEachUrlToken: function(text, callback) {
      var tokenRegex = /[^"'<>\s]+/g;
      var match;
      text = String(text || '');
      while ((match = tokenRegex.exec(text)) !== null) {
        if (match[0].length > 4096) continue;
        if (callback(match[0], match.index) === false) return;
      }
    },

    // Fast guard: skip full-HTML whitespace tokenizing unless .php? or aid= exists
    forEachRawAttachmentUrl: function(text, callback) {
      text = String(text || '');
      if (!text || text.indexOf('?') === -1) return;
      if (!/\.php\?/i.test(text) && !/aid=/i.test(text)) return;
      S.forEachUrlToken(text, function(token, tokenIndex) {
        if (token.indexOf('?') === -1) return;
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

    forEachRawTextFileUrl: function(text, callback) {
      text = String(text || '');
      if (!text || text.indexOf('.') === -1 || !/\.txt/i.test(text) || !/https?:\/\//i.test(text)) return;
      S.forEachUrlToken(text, function(token, tokenIndex) {
        if (token.indexOf('.') === -1) return;
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

    extractProtocolLinks: function(text, marker) {
      text = String(text || '');
      marker = String(marker || '');
      if (!text || !marker || text.length < marker.length) return [];
      if (marker.indexOf(':') !== -1 && text.indexOf(':') === -1) return [];
      var markerLower = marker.toLowerCase();
      var guard = PROTOCOL_GUARDS[markerLower];
      if (guard && !guard.test(text)) return [];
      var lower = text.toLowerCase();
      var start = lower.indexOf(markerLower);
      if (start === -1) return [];
      var links = [];
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
      var prepared = S.preparePanResourceUrlForParse(raw);
      if (prepared.indexOf(':') !== -1) {
        try {
          var panType = S.getPanResourceTypeFromParsedUrl(new URL(prepared));
          if (panType) return panType;
        } catch (e) {}
      }
      if (/\.(?:zip|rar|7z|torrent)(?:[?#].*)?$/i.test(raw)) return 'other';
      return null;
    },

    isBlockedPage: function(html) {
      var h = String(html || '').substring(0, 20000);
      if (!S.looksLikeThreadPage(h) && S.hasCloudflareChallengeMarkup(h)) return 'cloudflare';

      var messagePage = /id=["']messagetext["']|class=["'][^"']*(?:alert_error|showmessage)[^"']*["']|<title[^>]*>[^<]*(?:提示信息|错误信息|访问受限)[^<]*<\/title>/i.test(h);
      var purchaseAction = /(?:action|href)=["'][^"']*(?:buythread|pay(?:thread|topic)|action=buy)[^"']*["']/i.test(h);

      if (messagePage || purchaseAction) {
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

        if (purchaseAction && /购买(?:主题|帖子)|付费(?:主题|帖子)|支付.{0,20}(?:金币|金钱)|售价.{0,20}(?:金币|金钱)/i.test(text)) return 'purchase_page';
      }
      return S.getForumAgeGateReason(html);
    },

    isBlockedOrChallengeHtml: function(html) {
      return !!(S.isBlockedPage(html) || S.isForumChallengePage(html));
    },

    looksLikeThreadPage: function(html) {
      return /\bid=["'](?:postlist|thread_subject)["']|\bid=["']post(?:message)?_\d+["']|\bclass=["'][^"'<>]*\bt_f\b/i.test(String(html || ''));
    },

    getHtmlPageTitle: function(html) {
      var match = /<title[^<>]*>([^<]{0,200})/i.exec(String(html || '').slice(0, 20000));
      return match ? S.decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    },

    isForumAgeGateTitle: function(title) {
      return /^sehuatang\.(?:org|net)$/i.test(String(title || '').trim());
    },

    isForumAgeGateLabel: function(text, language) {
      text = String(text || '').replace(/\s+/g, ' ').trim();
      if (language === 'zh') return /^满\s*18\s*岁\s*[,，]\s*请点此进入$/.test(text);
      return language === 'en' && /^if you are over 18\s*[,，]\s*please click here$/i.test(text);
    },

    getForumAgeGateReason: function(html) {
      if (!S.isForumAgeGateTitle(S.getHtmlPageTitle(html))) return null;
      var rendered = S.stripNonRenderedHtmlRegions(html);
      if (S.looksLikeThreadPage(rendered) || /\bid\s*=\s*["'](?:threadlist|wp|hd)["']/i.test(rendered)) return null;
      var text = S.decodeHtmlEntities(S.htmlToText(rendered, true, true)).replace(/\s+/g, ' ');
      if (!/警告\s*\/\s*warning/i.test(text)) return null;
      var chinese = false, english = false;
      S.forEachAnchorTag(rendered, function(attrs, body) {
        var attrMap = parseHtmlAttributesOnce(attrs);
        if (!/(?:^|\s)enter-btn(?:\s|$)/.test(attrMap.class || '')) return;
        var href = (attrMap.href || '').trim();
        if (href !== '/' && !(/^https:\/\/[^/?#\s]+\/?$/i.test(href) && S.getForumUrlZone(href))) return;
        var label = S.decodeHtmlEntities(S.htmlToText(body, true, true));
        if (S.isForumAgeGateLabel(label, 'zh')) chinese = true;
        if (S.isForumAgeGateLabel(label, 'en')) english = true;
        if (chinese && english) return false;
      });
      if (!chinese || !english) return null;
      if (S.hasCloudflareChallengeMarkup(html)) return 'cloudflare';
      if (S.hasForumVerificationMarkers(html, text)) return 'challenge_page';
      if (S.isForumRateLimitText(text)) return 'rate_limited';
      return /<form\b/i.test(rendered) ? null : 'blocked';
    },

    isForumRateLimitText: function(text) {
      return /(?:过于|太|访问|请求|刷新|操作)频繁|访问频率|(?:刷新|访问|请求|速度)过快|(?:访问|请求)(?:次数)?过多|too many requests|rate limit|slow down/i.test(text);
    },

    hasCloudflareChallengeMarkup: function(html) {
      return /cf-chl|_cf_chl_opt|<title[^<>]*>\s*(?:Just a moment|Attention Required)/i.test(html);
    },

    hasForumVerificationMarkers: function(html, text) {
      return /\bchallenge-(?:form|running|stage)\b|\bcf-turnstile\b|\bg-recaptcha\b|\bh-captcha\b|challenges\.cloudflare\.com|\/recaptcha\/|hcaptcha\.com\//i.test(html) ||
        /访问验证|人机验证|安全验证|输入验证码|\bcaptcha\b|verif(?:y|ying) (?:that )?you are (?:a )?human|checking your browser/i.test(text);
    },

    classifyEmptyArticlePage: function(html) {
      html = String(html || '');
      if (S.looksLikeThreadPage(html)) return null;
      var text = S.htmlToText(S.stripNonRenderedHtmlRegions(html.slice(0, 20000))).replace(/\s+/g, ' ');
      if (/主题不存在|帖子不存在|已被删除|已删除|正在被审核|does not exist|has been deleted/i.test(text)) {
        return { reason: 'thread_missing', retryable: false };
      }
      if (S.isForumRateLimitText(text)) {
        return { reason: 'rate_limited', retryable: true };
      }
      if (S.isDiscuzMessagePage(html)) return { reason: 'forum_message', retryable: true };
      var gateReason = S.getForumAgeGateReason(html);
      if (gateReason) return { reason: gateReason, retryable: true };
      if (S.isForumChallengePage(html)) return { reason: 'challenge_page', retryable: true };
      return { reason: 'unrecognized_page', retryable: true };
    },

    isDiscuzMessagePage: function(html) {
      return /\bid=["']messagetext["']|\bclass=["'][^"'<>]*\balert_(?:error|info|right)\b/i.test(String(html || '').slice(0, 60000));
    },

    isTextForumRefusal: function(html) {
      if (S.looksLikeThreadPage(html)) return false;
      var blocked = S.isBlockedPage(html);
      if (blocked) return S.isForumFloodReason(blocked);
      if (S.isForumChallengePage(html)) return true;
      if (!S.isDiscuzMessagePage(html)) return false;
      var notice = S.classifyEmptyArticlePage(html);
      return !!notice && notice.reason === 'rate_limited';
    },

    isForumChallengePage: function(html) {
      html = String(html || '');
      if (!html || html.length > 6144 || S.looksLikeThreadPage(html)) return false;
      if (/\bid=["'](?:wp|hd|ft|toptb|messagetext)["']|Powered by Discuz|discuz_uid|STYLEID|\balert_(?:error|info|right)\b/i.test(html)) return false;
      var gateReason = S.getForumAgeGateReason(html);
      if (gateReason) return S.isForumFloodReason(gateReason);
      if (/<meta[^<>]*http-equiv=["']?refresh/i.test(html)) return true;
      if (!/<script\b/i.test(html)) return false;
      var text = S.htmlToText(S.stripNonRenderedHtmlRegions(html));
      if (!/稍[后後候]再[试試]|try again later/i.test(text)) return true;
      return S.hasCloudflareChallengeMarkup(html) || S.hasForumVerificationMarkers(html, text) ||
        /\blocation\s*\.\s*(?:reload|replace|assign)\s*\(|\bdocument\.cookie\s*=/i.test(html);
    },

    extractOgImage: function(html, baseUrl, context) {
      var ctx = context || findCachedContext(html);
      if (ctx && ctx._metaTags) {
        for (var i = 0; i < ctx._metaTags.length; i++) {
          var metaMap = ctx._metaTags[i].attrMap;
          var prop = (metaMap.property || metaMap.name || '').toLowerCase();
          if (prop !== 'og:image') continue;
          var resolved = S.resolveUrl(baseUrl, metaMap.content || '');
          if (resolved) return resolved;
        }
        return null;
      }
      var strHtml = String(html || '');
      if (!/og:image/i.test(strHtml)) return null;
      var image = null;
      S.forEachHtmlTag(S.stripNonRenderedHtmlRegions(strHtml), function(name, attrs) {
        if (name !== 'meta') return;
        var attrMap = parseHtmlAttributesOnce(attrs);
        var propName = (attrMap.property || attrMap.name || '').toLowerCase();
        if (propName !== 'og:image') return;
        image = S.resolveUrl(baseUrl, attrMap.content || '');
        if (image) return false;
      });
      return image;
    },

    extractTextAttachments: function(html, baseUrl, maxCount, context) {
      maxCount = maxCount || 3;
      var MAX_HTML_LENGTH = 1000000;
      var MAX_SCAN_MS = 250;
      var ctx = context || findCachedContext(html);
      var rawHtml = (ctx && typeof ctx.rawHtml === 'string')
        ? ctx.rawHtml
        : S.stripNonRenderedHtmlRegions(S.restoreProtectedEmails(S.limitArticleHtml(html)));
      var canUseContextAnchors = !!(ctx && ctx._anchors && rawHtml.length <= MAX_HTML_LENGTH);
      if (rawHtml.length > MAX_HTML_LENGTH) rawHtml = rawHtml.slice(0, MAX_HTML_LENGTH);
      var startedAt = Date.now();

      function makeCandidate(href, name, source) {
        var cleanedHref = S.cleanResourceUrl(String(href || '').replace(/\\\//g, '/'));
        if (!cleanedHref) return null;
        var url = S.resolveUrl(baseUrl, cleanedHref, true);
        if (!url) return null;
        if (!S.isAllowedTextAttachmentUrl(url, baseUrl)) return null;
        var key = S.normalizeTextAttachmentUrl(url);
        if (!key) return null;
        return {
          url: url,
          key: key,
          name: S.cleanAttachmentName(name || url),
          source: source,
          pageUrl: baseUrl
        };
      }

      function isAttachmentHref(href) {
        return S.isDiscuzAttachmentUrl(href, baseUrl);
      }

      function isBlockedProtocol(href) {
        return /^(?:javascript|mailto|ed2k|magnet):/i.test(href);
      }

      function hasNonTextFileName(value) {
        return /\.(?:jpe?g|png|gif|webp|bmp|svg|ico|zip|rar|7z|torrent|pdf|mp4|mkv|avi|webm|mp3|flac|docx?|xlsx?|pptx?)(?:$|[^A-Za-z0-9.])/i.test(value);
      }

      function getAttachmentContext(start, end) {
        var from = Math.max(0, start - 1500);
        var to = Math.min(rawHtml.length, end + 1500);
        var before = rawHtml.slice(from, start);
        var boundary = /<\/?(?:dl|li|tr|div|ignore_js_op)\b[^<>]*>/gi;
        var edge;
        while ((edge = boundary.exec(before)) !== null) from = Math.max(0, start - 1500) + boundary.lastIndex;
        var after = rawHtml.slice(end, to);
        boundary.lastIndex = 0;
        edge = boundary.exec(after);
        if (edge) to = end + edge.index;
        return rawHtml.slice(from, to);
      }

      function getContextTextFileName(start, end) {
        var slice = getAttachmentContext(start, end);
        var attachmentLinks = 0;
        S.forEachAnchorTag(slice, function(attrs) {
          var aMap = parseHtmlAttributesOnce(attrs);
          if (isAttachmentHref(S.decodeHtmlEntities(aMap.href || ''))) attachmentLinks++;
        });
        if (attachmentLinks > 1) return '';
        var text = S.decodeHtmlEntities(S.htmlToText(slice, true, true)).trim();
        if (hasNonTextFileName(text)) return '';
        var name = text.match(/[^\s<>"'：:，,。；;（）()【】\[\]]{1,120}\.txt(?![A-Za-z0-9.])/i);
        if (name) return name[0];
        return /(?:filetype|attach(?:ment)?)[^>]{0,160}(?:txt|text)/i.test(slice) ? 'attachment.txt' : '';
      }

      var directCandidates = [];
      var contextCandidates = [];
      var anchorRanges = [];

      function inspectAnchor(attrMap, body, openIndex, endIndex) {
        if (Date.now() - startedAt > MAX_SCAN_MS) return false;
        anchorRanges.push([openIndex, endIndex]);
        var href = S.decodeHtmlEntities(attrMap.href || '');
        if (!href || isBlockedProtocol(href)) return true;
        var looksLikeAttachment = isAttachmentHref(href);
        var directTextUrl = /\.txt(?:[?#].*)?$/i.test(href);
        var looksLikeSignedDownload = S.isSignedTextDownloadUrl(href, baseUrl);
        if (!looksLikeAttachment && !directTextUrl && !looksLikeSignedDownload) return true;

        var label = S.decodeHtmlEntities(S.htmlToText(body, true, true)).trim();
        var title = S.decodeHtmlEntities(attrMap.title || '');
        var download = S.decodeHtmlEntities(attrMap.download || '');

        var probe = [href, label, title, download].join(' ');
        var looksLikeTextFile = /\.txt(?![A-Za-z0-9.])/i.test(probe);
        if ((looksLikeTextFile && (looksLikeAttachment || directTextUrl)) || looksLikeSignedDownload) {
          var cand = makeCandidate(href, download || title || label || href, 'txt-attachment');
          if (cand) directCandidates.push(cand);
          return true;
        }

        if (!looksLikeAttachment) return true;
        if (hasNonTextFileName([label, title, download].join(' '))) return true;
        var ctxName = getContextTextFileName(openIndex, endIndex);
        if (!ctxName) return true;
        var ctxCand = makeCandidate(href, ctxName || label || href, 'txt-attachment-context');
        if (ctxCand) contextCandidates.push(ctxCand);
        return true;
      }

      if (canUseContextAnchors) {
        var preAnchors = ctx._anchors;
        for (var ai = 0; ai < preAnchors.length; ai++) {
          var pa = preAnchors[ai];
          if (inspectAnchor(pa.attrMap, pa.body, pa.openIndex, pa.endIndex) === false) break;
        }
      } else {
        S.forEachAnchorTag(rawHtml, function(attrs, body, openIndex, endIndex) {
          return inspectAnchor(parseHtmlAttributesOnce(attrs), body, openIndex, endIndex);
        });
      }

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
      var moreCandidates = directCandidates.concat(contextCandidates);
      for (var mc = 0; mc < moreCandidates.length && attachments.length >= maxCount; mc++) {
        if (!seen[moreCandidates[mc].key]) {
          attachments.limited = true;
          break;
        }
      }

      if (attachments.length < maxCount && (rawHtml.indexOf('xia.') !== -1 || /xia\./i.test(rawHtml))) {
        var rawSignedDownloadRegex = /https:\/\/xia\.(?:ewrewej\.la|djhdhs\.us)\/[^"'<>\s]+/gi;
        var m;
        while (attachments.length < maxCount && (m = rawSignedDownloadRegex.exec(rawHtml)) !== null) {
          if (Date.now() - startedAt > MAX_SCAN_MS) break;
          var rawSignedUrl = S.decodeHtmlEntities(m[0]).replace(/\\\//g, '/');
          var signedCand = makeCandidate(rawSignedUrl, rawSignedUrl, 'txt-attachment-signed');
          if (signedCand) addCandidate(signedCand);
        }
      }

      if (attachments.length < maxCount) {
        var anchorRangeIndex = 0;
        var rawScanCursor = 0;
        var rawInsideTag = false;
        S.forEachRawAttachmentUrl(rawHtml, function(matchedUrl, matchStart, matchEnd) {
          if (attachments.length >= maxCount || Date.now() - startedAt > MAX_SCAN_MS) return false;
          while (anchorRangeIndex < anchorRanges.length && anchorRanges[anchorRangeIndex][1] <= matchStart) anchorRangeIndex++;
          if (anchorRangeIndex < anchorRanges.length && anchorRanges[anchorRangeIndex][0] <= matchStart) return;
          for (; rawScanCursor < matchStart; rawScanCursor++) {
            if (rawHtml.charAt(rawScanCursor) === '<') rawInsideTag = true;
            else if (rawHtml.charAt(rawScanCursor) === '>') rawInsideTag = false;
          }
          if (rawInsideTag) return;
          var rawUrl = S.decodeHtmlEntities(matchedUrl).replace(/\\\//g, '/');
          var rawName = getContextTextFileName(matchStart, matchEnd);
          if (!rawName) return;
          var rawCand = makeCandidate(rawUrl, rawName, 'txt-attachment-raw');
          if (rawCand) addCandidate(rawCand);
        });
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
      var rawHtml = this.restoreProtectedEmails(String(html || ''));
      var baseKey = '';
      var baseResolved = S.resolveUrl(baseUrl, baseUrl, true);
      if (baseResolved) baseKey = S.normalizeTextAttachmentUrl(baseResolved);

      function looksLikeTextUrl(raw) {
        return /\.txt(?:[?#].*)?$/i.test(raw) || /\.txt[?#]/i.test(raw);
      }

      function looksLikeAttachmentUrl(raw) {
        return S.isDiscuzAttachmentUrl(raw, baseUrl);
      }

      function looksLikeSignedTextDownloadUrl(raw) {
        return S.isSignedTextDownloadUrl(raw, baseUrl);
      }

      function add(raw) {
        if (!raw || urls.length >= maxCount) return;
        raw = S.cleanResourceUrl(String(raw).replace(/\\\//g, '/'));
        if (!looksLikeTextUrl(raw) && !looksLikeAttachmentUrl(raw) && !looksLikeSignedTextDownloadUrl(raw)) return;
        var url = S.resolveUrl(baseUrl, raw, true);
        if (!url) return;
        if (!S.isAllowedTextAttachmentUrl(url, baseUrl)) return;
        var key = S.normalizeTextAttachmentUrl(url);
        if (!key) return;
        if (baseKey && key === baseKey) return;
        if (seen[key]) return;
        seen[key] = true;
        urls.push(url);
      }

      var rawText = this.replaceHtmlTags(rawHtml, function(name, attrs, closing) {
        if (!closing && (name === 'a' || name === 'area')) {
          var attrMap = parseHtmlAttributesOnce(attrs);
          add(S.decodeHtmlEntities(attrMap.href || ''));
        }
        return ' ';
      });
      if (urls.length >= maxCount) return urls;
      var decoded = this.decodeHtmlEntities(rawText);

      S.forEachRawTextFileUrl(decoded, function(url) {
        if (urls.length >= maxCount) return false;
        add(url);
      });

      if (urls.length < maxCount && (decoded.indexOf('xia.') !== -1 || /xia\./i.test(decoded))) {
        var signedDownloadRegex = /https:\/\/xia\.(?:ewrewej\.la|djhdhs\.us)\/[^"'<>\s]+/gi;
        var m;
        while (urls.length < maxCount && (m = signedDownloadRegex.exec(decoded)) !== null) {
          add(m[0]);
        }
      }

      if (urls.length < maxCount) {
        S.forEachRawAttachmentUrl(decoded, function(url) {
          if (urls.length >= maxCount) return false;
          add(url);
        });
      }

      return urls;
    },

    decodeTextBuffer: function(buffer, contentType) {
      if (typeof TextDecoder === 'undefined' || !buffer || !buffer.byteLength) return '';
      var bytes = ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, Math.min(3, buffer.byteLength))
        : new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength));
      var bom = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' :
        bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' :
        bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8' : '';
      if (bom) {
        try { return new TextDecoder(bom).decode(buffer); } catch (e) {}
      }
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
          var bad = 0;
          var badIdx = text.indexOf('\ufffd');
          while (badIdx !== -1) {
            bad++;
            badIdx = text.indexOf('\ufffd', badIdx + 1);
          }
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
      var head = String(text || '').slice(0, 2000);
      return /<(?:!doctype|html|head|body|title|form)\b/i.test(head) ||
        (/^\s*</.test(head) && S.isDiscuzMessagePage(head));
    },

    looksLikeDownloadIntermediary: function(text) {
      var head = String(text || '').slice(0, 10000);
      if (!/(?:mod=attachment|attachment\.php|misc\.php\?[^"'<>\s]*(?:mod=attach|action=attach)|\.txt(?:[?#]|\b)|xia\.(?:ewrewej\.la|djhdhs\.us)\/)/i.test(head)) {
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

    extractResources: function(html, baseUrl, source, context) {
      source = source || 'html';
      var resources = this.emptyResources();
      var seen = {};
      var rawHtml, text, ctx;
      if (source === 'txt') {
        rawHtml = this.limitArticleHtml(html);
        text = rawHtml;
      } else {
        ctx = (context && typeof context.rawHtml === 'string' && typeof context.text === 'string')
          ? context
          : (findCachedContext(html) || this.prepareArticleExtractionContext(html));
        rawHtml = ctx.rawHtml;
        text = ctx.text;
      }

      function add(type, url, meta) {
        if (!url) return;
        url = S.cleanResourceUrl(url);
        if (!url) return;
        var normalizedPan = S.normalizePanResourceUrlCode(type, url, meta && meta.code);
        url = normalizedPan.url;
        var item = { type: type, url: url, source: source };
        if (normalizedPan.code) {
          item.code = normalizedPan.code;
          item.codeOrigin = 'url';
        }
        var key = S.getResourceDedupKey(type, url);
        if (seen[key]) {
          var existing = seen[key];
          existing.source = S.mergeResourceSource(existing.source, source);
          S.mergeAccessCode(existing, item);
          return;
        }
        seen[key] = item;
        resources.groups[type].push(item);
      }

      function normalizeResourceCandidate(raw) {
        raw = S.cleanResourceUrl(raw);
        if (!raw) return '';
        if (/^\/\//.test(raw)) return 'https:' + raw;
        if (/^(?:(?:www\.)?pan\.baidu\.com|(?:www\.)?yun\.baidu\.com|(?:www\.)?pan\.quark\.cn|(?:www\.)?115\.com|(?:www\.)?(?:aliyundrive|alipan)\.com|(?:www\.)?drive\.uc\.cn|(?:www\.)?pan\.xunlei\.com)\//i.test(raw)) {
          return 'https://' + raw;
        }
        return S.resolveUrl(baseUrl, raw, true) || raw;
      }

      function addResourceCandidate(raw) {
        raw = S.cleanResourceUrl(raw);
        var type = S.classifyResourceUrl(raw);
        if (!type) return;
        var url = normalizeResourceCandidate(raw);
        if (!S.isCopyableResourceUrl(type, url)) return;
        var code = '';
        if (S.isPanResourceType(type)) {
          code = S.extractAccessCode(url);
          if (!code && url !== raw) code = S.extractAccessCode(S.preparePanResourceUrlForParse(raw));
        }
        add(type, url, code ? { code: code } : null);
      }

      function scanResourceText(scanText) {
        scanText = String(scanText || '');
        if (!scanText) return;

        if (scanText.indexOf(':') !== -1 && PROTOCOL_GUARDS['ed2k://'].test(scanText)) {
          var ed2kMatches = scanText.match(/ed2k:\/\/\|file\|[^\r\n]*?\|\//gi) || [];
          for (var e = 0; e < ed2kMatches.length; e++) {
            add('ed2k', ed2kMatches[e], null);
          }
        }

        var magnets = S.extractProtocolLinks(scanText, 'magnet:?');
        for (var m = 0; m < magnets.length; m++) {
          add('magnet', magnets[m], null);
        }

        var match;
        if (scanText.indexOf('://') !== -1) {
          var httpRegex = /https?:\/\/[^\s<>"']+/gi;
          while ((match = httpRegex.exec(scanText)) !== null) {
            addResourceCandidate(match[0]);
          }
        }

        if (scanText.indexOf('//') !== -1) {
          var protocolRelativeRegex = /\/\/(?:(?:www\.)?pan\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?pan\.quark\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?115\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?(?:aliyundrive|alipan)\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?yun\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?drive\.uc\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?pan\.xunlei\.com\/s\/[^\s<>"'）)】\]]+)/gi;
          while ((match = protocolRelativeRegex.exec(scanText)) !== null) {
            addResourceCandidate(match[0]);
          }
        }

        if (scanText.indexOf('/s/') !== -1 || scanText.indexOf('/share/') !== -1) {
          var barePanRegex = /(?:^|[\s<>"'（(【\[])((?:www\.)?pan\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?pan\.quark\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?115\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?(?:aliyundrive|alipan)\.com\/s\/[^\s<>"'）)】\]]+|(?:www\.)?yun\.baidu\.com\/(?:s\/|share\/)[^\s<>"'）)】\]]+|(?:www\.)?drive\.uc\.cn\/s\/[^\s<>"'）)】\]]+|(?:www\.)?pan\.xunlei\.com\/s\/[^\s<>"'）)】\]]+)/gi;
          while ((match = barePanRegex.exec(scanText)) !== null) {
            addResourceCandidate(match[1]);
          }
        }
      }

      scanResourceText(source === 'txt' ? text : this.htmlToText(text, true, true));

      if (source !== 'txt') {
        if (ctx && ctx._linkTags) {
          var preLinks = ctx._linkTags;
          for (var li = 0; li < preLinks.length; li++) {
            var rawHref = preLinks[li].attrMap.href;
            if (!rawHref) continue;
            var decodedHref = S.decodeHtmlEntities(rawHref);
            if (!decodedHref) continue;
            if (/^(?:ed2k:\/\/|magnet:\?)/i.test(decodedHref.trim())) scanResourceText(decodedHref);
            else addResourceCandidate(decodedHref);
          }
        } else {
          S.forEachHtmlTag(rawHtml, function(tag, attrs) {
            if (tag !== 'a' && tag !== 'area') return;
            var aMap = parseHtmlAttributesOnce(attrs);
            var href = S.decodeHtmlEntities(aMap.href || '');
            if (!href) return;
            if (/^(?:ed2k:\/\/|magnet:\?)/i.test(href.trim())) scanResourceText(href);
            else addResourceCandidate(href);
          });
        }
      }

      resources.passwords = source === 'txt' ? this.extractArchivePasswords(text) : this.mergeUniqueLimited(
        this.extractArchivePasswordsFromHtml(rawHtml),
        this.extractArchivePasswords(text),
        5
      );

      var panItems = [];
      for (var pt = 0; pt < this.RESOURCE_GROUP_ORDER.length; pt++) {
        var panType = this.RESOURCE_GROUP_ORDER[pt];
        if (this.isPanResourceType(panType) && resources.groups[panType].length) {
          panItems = panItems.concat(resources.groups[panType]);
        }
      }
      if (panItems.length) {
        var pairedCodes = this.collectAccessCodePairs(rawHtml, baseUrl, source);
        for (var pi = 0; pi < panItems.length; pi++) {
          var itemCodes = pairedCodes[this.getResourceDedupKey(panItems[pi].type, panItems[pi].url)] || [];
          for (var ci = 0; ci < itemCodes.length; ci++) {
            this.mergeAccessCode(panItems[pi], { code: itemCodes[ci], codeOrigin: source === 'txt' ? 'txt' : 'html' });
          }
        }
      }
      return this.normalizeResources(resources);
    },

    ACCESS_CODE_PAIR_MAX_GAP: 220,
    ACCESS_CODE_PAIR_MAX_LINES: 3,
    ACCESS_CODE_BLOCK_GAP: 600,
    ACCESS_CODE_BLOCK_LINES: 8,
    ACCESS_CODE_LABEL_REACH: 600,
    ACCESS_CODE_UNPAIRED_COST: 4,
    ACCESS_CODE_UNPAIRED_FOREIGN_COST: 2,
    ACCESS_CODE_AFTER_COST: [0, 1.5, 3, 4],
    ACCESS_CODE_BEFORE_COST: [1, 4.5, 6, 7.5],
    ACCESS_CODE_FAR_AFTER_COST: 4.4,
    IMAGE_HOST_RE: /(?:^|\.)(?:imgbox\.com|postimg\.cc|postimages\.org|imgur\.com|pixhost\.to|ibb\.co|imgbb\.com|sm\.ms|imgchr\.com|jpg\.church)$/i,
    FILE_DRIVE_HOST_RE: /(?:^|\.)(?:lanzou[a-z]*\.com|ilanzou\.com|lanzn\.com|ctfile\.com|474b\.com|123pan\.com|123pan\.cn|123684\.com|123865\.com|123912\.com|cloud\.189\.cn|caiyun\.139\.com|yun\.139\.com|feiji[a-z]*\.com|rosefile\.net|mega\.nz|pikpak\.com|mypikpak\.com|weiyun\.com|jianguoyun\.com)$/i,

    getAccessCodeLabelDrive: function(before) {
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

    isNonShareCodePasswordLabel: function(lineBefore) {
      lineBefore = String(lineBefore || '');
      lineBefore = lineBefore.slice(lineBefore.lastIndexOf('\n') + 1);
      if (/(?:账号|帐号|用户名|登录|登陆)/.test(lineBefore.slice(-20))) return true;
      return /(?:解压|压缩|解压缩|文件|资源|包|rar|zip|7z)[ \t【】\[\]()（）]*$/i.test(lineBefore);
    },

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
      if (baseHost && S.isSameSupportedSiteHost(u.hostname, baseHost)) return false;
      if (S.IMAGE_HOST_RE.test(u.hostname)) return false;
      return !/\.(?:jpe?g|png|gif|webp|bmp|svg|ico|css|js)$/i.test(u.pathname);
    },

    isFileDriveLink: function(url) {
      try {
        return S.FILE_DRIVE_HOST_RE.test(new URL(/^\/\//.test(url) ? 'https:' + url : (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url)).hostname);
      } catch (e) {
        return false;
      }
    },

    getPanShareKey: function(raw, baseUrl) {
      var cleaned = S.cleanResourceUrl(String(raw || ''));
      if (!cleaned) return '';
      var prepared = S.preparePanResourceUrlForParse(cleaned);
      var type = S.classifyResourceUrl(prepared);
      if (!type || !S.isPanResourceType(type)) return '';
      if (!/^https?:\/\//i.test(prepared)) prepared = S.resolveUrl(baseUrl, prepared, true) || prepared;
      var url = S.normalizePanResourceUrlCode(type, prepared, '').url;
      return url ? { type: type, key: S.getResourceDedupKey(type, url) } : '';
    },

    collectAccessCodePairs: function(rawHtml, baseUrl, source) {
      OWN_MARKS_RE.lastIndex = 0;
      rawHtml = String(rawHtml || '').replace(OWN_MARKS_RE, ' ');
      if (source === 'txt') {
        rawHtml = rawHtml.replace(/\r\n?/g, '\n');
      } else {
        rawHtml = S.replaceHtmlTags(rawHtml, function(name, attrs, closing) {
          if (name === 'a' && !closing) {
            var aMap = parseHtmlAttributesOnce(attrs);
            if (aMap.href) return '<a href="' + S.escapeHtml(S.decodeHtmlEntities(aMap.href)) + '">';
          }
          return '<' + (closing ? '/' : '') + name + '>';
        });
        rawHtml = rawHtml
          .replace(/[\r\n]+/g, ' ')
          .replace(/<ignore_js_op\b[^<>]*>[\s\S]*?<\/ignore_js_op>/gi, PICTURE)
          .replace(/<img\b[^<>]*>/gi, PICTURE)
          .replace(/(?:\s|<br\s*\/?>|<hr\b[^<>]*>|<\/?(?:p|div|li|tr|td|th|ol|ul|dl|dd|dt|tbody|thead|table|blockquote|h[1-6])\b[^<>]*>)+/gi, function(run) {
            if (run.indexOf('<') === -1) return run;
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
        var visible = source === 'txt' ? slice : S.htmlToText(S.decodeHtmlEntities(slice), true, true);
        ANCHOR_MARKS_RE.lastIndex = 0;
        parts.push(visible.replace(ANCHOR_MARKS_RE, ' '));
      }
      if (source !== 'txt') S.forEachAnchorTag(rawHtml, function(attrs, body, openIndex) {
        var attrMap = parseHtmlAttributesOnce(attrs);
        var href = S.decodeHtmlEntities(attrMap.href || '').trim();
        if (!href) return;
        var pan = S.getPanShareKey(href, baseUrl);
        var blocking = !pan && /^(?:magnet:|ed2k:|thunder:)/i.test(href);
        var fileDrive = !pan && !blocking && S.isForeignShareLink(href, baseUrl) && S.isFileDriveLink(href);
        OWN_MARKS_RE.lastIndex = 0;
        var foreign = !pan && !blocking && (fileDrive || (S.isForeignShareLink(href, baseUrl) &&
          !!S.htmlToText(S.decodeHtmlEntities(body)).replace(OWN_MARKS_RE, '').trim()));
        if (!pan && !blocking && !foreign) return;
        var tagEnd = S.findHtmlTagEnd(rawHtml, openIndex + 2);
        if (tagEnd === -1) return;
        pushText(rawHtml.slice(last, openIndex));
        parts.push(' ' + MARK_OPEN + anchors.length + MARK_CLOSE + ' ');
        anchors.push({
          pan: pan || null,
          blocking: blocking,
          fileDrive: fileDrive,
          urlCode: pan ? S.extractAccessCode(S.preparePanResourceUrlForParse(href)) : ''
        });
        last = tagEnd + 1;
      });
      pushText(rawHtml.slice(last));
      var text = parts.join('');

      var tokens = [];
      var m;
      MARK_TOKEN_RE.lastIndex = 0;
      while ((m = MARK_TOKEN_RE.exec(text)) !== null) {
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
      var linkMask = new Uint8Array(text.length + 1);
      var visibleMask = new Uint8Array(text.length + 1);
      function markRange(mask, start, end) {
        for (var p = start; p < end; p++) mask[p] = 1;
      }
      for (var ti = 0; ti < tokens.length; ti++) markRange(linkMask, tokens[ti].start, tokens[ti].end);
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
      PAN_LINK_RE.lastIndex = 0;
      while ((m = PAN_LINK_RE.exec(text)) !== null) {
        var pan = S.getPanShareKey(m[0], baseUrl);
        if (pan) {
          addVisible(m.index, m.index + m[0].length, pan.type, pan.key, 'L', false,
            S.extractAccessCode(S.preparePanResourceUrlForParse(S.cleanResourceUrl(m[0]))));
        }
      }
      if (text.indexOf(':') !== -1) {
        BLOCK_LINK_RE.lastIndex = 0;
        while ((m = BLOCK_LINK_RE.exec(text)) !== null) {
          if (!isCovered(m.index, m.index + m[0].length)) addVisible(m.index, m.index + m[0].length, '', '', 'X');
        }
      }
      if (text.indexOf('//') !== -1) {
        WEB_LINK_RE.lastIndex = 0;
        while ((m = WEB_LINK_RE.exec(text)) !== null) {
          if (isCovered(m.index, m.index + m[0].length)) continue;
          var webUrl = /^\/\//.test(m[0]) ? 'https:' + m[0] : m[0];
          if (!S.isForeignShareLink(webUrl, baseUrl)) continue;
          addVisible(m.index, m.index + m[0].length, '', '', 'L', S.isFileDriveLink(webUrl));
        }
      }
      if (text.indexOf('/') !== -1) {
        BARE_LINK_RE.lastIndex = 0;
        while ((m = BARE_LINK_RE.exec(text)) !== null) {
          var bareStart = m.index + m[1].length;
          var bareEnd = bareStart + m[2].length;
          if (isCovered(bareStart, bareEnd)) continue;
          if (!S.isForeignShareLink('https://' + m[2], baseUrl)) continue;
          addVisible(bareStart, bareEnd, '', '', 'L', S.isFileDriveLink(m[2]));
        }
      }
      tokens = tokens.concat(visible);

      var codes = [];
      var codeMask = new Uint8Array(text.length + 1);
      function collect(regex, passwordLabel) {
        var cm;
        regex.lastIndex = 0;
        while ((cm = regex.exec(text)) !== null) {
          if (/^(?:https?|www|ftp|com|net|org|ed2k|magnet|thunder)$/i.test(cm[1])) continue;
          var start = cm.index;
          var end = cm.index + cm[0].length;
          var valueStart = end - cm[1].length;
          if (linkMask[start]) continue;
          if (/(?:[无無](?:需|[须須])?|免|不需要?|不用|没有)[ \t]*$/.test(text.slice(Math.max(0, start - 3), start))) continue;
          var lineBefore = text.slice(Math.max(0, start - 40), start);
          if (passwordLabel && S.isNonShareCodePasswordLabel(lineBefore)) continue;
          var inLink = false;
          for (var v = valueStart; v < end && !inLink; v++) inLink = linkMask[v] === 1;
          if (inLink) continue;
          if (/\n/.test(text.slice(start, valueStart)) && !/^[ \t\u3000]*(?:\n|$)/.test(text.slice(end, end + 40))) continue;
          var overlaps = false;
          for (var p = start; p < end && !overlaps; p++) overlaps = codeMask[p] === 1;
          if (overlaps) continue;
          markRange(codeMask, start, end);
          var labelFrom = Math.max(0, start - 10);
          for (var q = start - 1; q >= labelFrom; q--) {
            if (linkMask[q]) {
              labelFrom = q + 1;
              break;
            }
          }
          codes.push({ kind: 'C', start: start, end: end, code: cm[1], drive: S.getAccessCodeLabelDrive(text.slice(labelFrom, start)) });
        }
      }
      collect(ACCESS_CODE_RE_1, false);
      collect(ACCESS_CODE_RE_2, false);
      collect(ACCESS_CODE_RE_3, true);
      if (!codes.length) return {};

      NONE_CODE_RE.lastIndex = 0;
      while ((m = NONE_CODE_RE.exec(text)) !== null) {
        var noneStart = m.index;
        var noneEnd = noneStart + m[0].length;
        var taken = false;
        for (var nm = noneStart; nm < noneEnd && !taken; nm++) taken = linkMask[nm] === 1 || codeMask[nm] === 1;
        if (taken) continue;
        var passwordAt = m[0].indexOf('密码');
        if (passwordAt !== -1 && !/(?:提取|访问)密码/.test(m[0]) &&
          S.isNonShareCodePasswordLabel(text.slice(Math.max(0, noneStart - 40), noneStart + passwordAt))) continue;
        codes.push({ kind: 'C', start: noneStart, end: noneEnd, code: '', none: true, drive: '' });
      }
      NONE_CELL_RE.lastIndex = 0;
      while ((m = NONE_CELL_RE.exec(text)) !== null) {
        var cellStart = m.index + m[1].length + m[0].slice(m[1].length).indexOf(m[2]);
        if (linkMask[cellStart] || codeMask[cellStart]) continue;
        codes.push({ kind: 'C', start: cellStart, end: cellStart + m[2].length, code: '', none: true, drive: '' });
      }
      tokens = tokens.concat(codes);
      tokens.sort(function(a, b) { return a.start - b.start || (a.kind === 'C' ? 1 : b.kind === 'C' ? -1 : 0); });
      if (!tokens.some(function(token) { return token.kind === 'L' && token.pan; })) return {};

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

      function isDriveLink(token) {
        return !!token && token.kind === 'L' && (!!token.pan || !!token.fileDrive);
      }
      function near(a, b) {
        return !!a && !!b && b.start - a.end <= S.ACCESS_CODE_BLOCK_GAP && b.line - a.line <= S.ACCESS_CODE_BLOCK_LINES;
      }
      function driveFits(code, link) {
        return !code.drive || (code.drive === 'foreign' ? !link.pan : link.pan === code.drive);
      }
      function pairGroup(first, second, links, groupCodesList) {
        for (var g = 0; g < links.length; g++) {
          links[g].code = groupCodesList[g].none ? '' : groupCodesList[g].code;
          if (groupCodesList[g].none) links[g].noCode = true;
          links[g].kind = 'G';
          groupCodesList[g].kind = 'G';
          groupCodesList[g].used = true;
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
        if (token.none || token.urlCode) return 0;
        if (token.kind === 'L' && !token.pan) {
          var next = tokens[index + 1];
          var ownLineCode = next && next.kind === 'C' && next.line === token.line;
          return token.fileDrive || ownLineCode ? S.ACCESS_CODE_UNPAIRED_COST : S.ACCESS_CODE_UNPAIRED_FOREIGN_COST;
        }
        return S.ACCESS_CODE_UNPAIRED_COST;
      }
      function pairCost(a, b, regime) {
        if (a.kind === 'X' || b.kind === 'X' || a.kind === 'G' || b.kind === 'G' || a.kind === b.kind) return Infinity;
        var link = a.kind === 'L' ? a : b;
        var code = a.kind === 'C' ? a : b;
        var lines = b.line - a.line;
        var gap = b.start - a.end;
        if (code.none) return lines === 0 && gap <= S.ACCESS_CODE_PAIR_MAX_GAP ? -1 : Infinity;
        if (code.drive && (code.drive === 'foreign' ? !!link.pan : link.pan !== code.drive)) return Infinity;
        if (link.urlCode && lines > 0) {
          return code.code.toLowerCase() === link.urlCode.toLowerCase() && lines <= S.ACCESS_CODE_PAIR_MAX_LINES &&
            gap <= S.ACCESS_CODE_PAIR_MAX_GAP ? -0.5 : Infinity;
        }
        var codeAfter = a.kind === 'L';
        if (lines === 0) return gap > S.ACCESS_CODE_PAIR_MAX_GAP ? Infinity : (codeAfter ? S.ACCESS_CODE_AFTER_COST[0] : S.ACCESS_CODE_BEFORE_COST[0]);
        if (regime !== (codeAfter ? 'after' : 'before')) return Infinity;
        if (code.drive && code.drive !== 'foreign') return Infinity;
        if (lines <= S.ACCESS_CODE_PAIR_MAX_LINES && gap <= S.ACCESS_CODE_PAIR_MAX_GAP) {
          return (codeAfter ? S.ACCESS_CODE_AFTER_COST : S.ACCESS_CODE_BEFORE_COST)[lines];
        }
        if (codeAfter && lines <= S.ACCESS_CODE_BLOCK_LINES && gap <= S.ACCESS_CODE_BLOCK_GAP) return S.ACCESS_CODE_FAR_AFTER_COST;
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
          tokens[bi].start - tokens[bi - 1].end > S.ACCESS_CODE_BLOCK_GAP ||
          tokens[bi].line - tokens[bi - 1].line > S.ACCESS_CODE_BLOCK_LINES;
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
      tokens.forEach(function(code) {
        if (code.kind !== 'C' || code.used || !code.drive || code.drive === 'foreign') return;
        var bestLink = null;
        var bestRank = null;
        for (var k = 0; k < tokens.length; k++) {
          var link = tokens[k];
          if (link.kind !== 'L' || link.pan !== code.drive || link.code || link.noCode || link.urlCode) continue;
          var distance = link.start < code.start ? code.start - link.end : link.start - code.end;
          if (distance > S.ACCESS_CODE_LABEL_REACH || Math.abs(link.line - code.line) > S.ACCESS_CODE_BLOCK_LINES) continue;
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

    extractArchivePasswords: function(text) {
      var result = [];
      text = String(text || '');
      if (text.indexOf('密码') === -1 && text.indexOf('码') === -1 && text.indexOf('口令') === -1 &&
          text.indexOf('密碼') === -1 && text.indexOf('碼') === -1) {
        return result;
      }
      var seen = Object.create(null);
      var regex = /(?:解压密码|压缩密码|压缩包密码|解压包密码|(?:rar|zip|7z)\s*密码|解压码|解压口令|解壓密碼|解壓碼)\s*[】\]\)）」』]?\s*[:：=]?\s*/gi;
      var m;
      while ((m = regex.exec(text)) !== null) {
        var rest = text.slice(regex.lastIndex, regex.lastIndex + 500).replace(/^[\s\u00a0]+/, '');
        if (/[\r\n]/.test(m[0]) && /^(?:说明|說明|备注|備註)[ \t]*[:：]/.test(rest)) continue;
        var stop = rest.search(/\n|(?:链接|下载链接|提取[码碼]|提取密码|访问码|ed2k:\/\/|magnet:\?|https?:\/\/)\s*/i);
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
      html = String(html || '');
      if (html.indexOf('密码') === -1 && html.indexOf('码') === -1 && html.indexOf('口令') === -1 &&
          html.indexOf('密碼') === -1 && html.indexOf('碼') === -1) {
        return result;
      }
      var seen = Object.create(null);
      var fieldRegex = /(?:解压密码|压缩密码|压缩包密码|解压包密码|(?:rar|zip|7z)\s*密码|解压码|解压口令|解壓密碼|解壓碼)\s*[】\]\)）」』]?\s*[:：=]?\s*/gi;
      var match = fieldRegex.exec(html);
      if (!match) return result;
      function readVisibleFields(limit) {
        while (match && match.index < limit && result.length < 5) {
          var label = match[0];
          var rest = html.slice(fieldRegex.lastIndex, fieldRegex.lastIndex + 500);
          match = fieldRegex.exec(html);
          if (/[\r\n]/.test(label) && /^(?:说明|說明|备注|備註)[ \t]*[:：]/.test(rest)) continue;
          var boundary = rest.search(/(?:<\s*br\s*\/?\s*>|<\/(?:p|div|li|tr|td|th)>|\n|(?:链接|下载链接|提取[码碼]|提取密码|访问码|ed2k:\/\/|magnet:\?|https?:\/\/))/i);
          var raw = boundary === -1 ? rest : rest.slice(0, boundary);
          var restored = S.restoreMailtoPassword(raw);
          var val = S.cleanPasswordValue(restored || S.decodeHtmlEntities(S.htmlToText(raw, true)));
          if (!val || seen[val]) continue;
          seen[val] = true;
          result.push(val);
        }
      }
      this.forEachHtmlTag(html, function(name, attrs, start, end) {
        readVisibleFields(start);
        if (!match || result.length >= 5) return false;
        if (match.index < end) {
          fieldRegex.lastIndex = end;
          match = fieldRegex.exec(html);
        }
      }, true);
      readVisibleFields(html.length);
      return result;
    },

    restoreMailtoPassword: function(html) {
      html = String(html || '');
      if (html.indexOf('<a') === -1 && !/<a\b/i.test(html) && html.indexOf('&lt;a') === -1) return '';
      var decoded = this.decodeHtmlEntities(html);
      var mailtoRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
      var match;
      while ((match = mailtoRegex.exec(decoded)) !== null) {
        var attrs = match[1] || '';
        var attrMap = parseHtmlAttributesOnce(attrs);
        var href = attrMap.href || '';
        var label = this.htmlToText(this.decodeHtmlEntities(match[2])).trim();
        var values = [href, attrMap.title || '', label];
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

    extractImagesForSettings: function(html, baseUrl, settings, context) {
      var plan = S.getImageExtractionPlan(settings);
      return S.extractImages(html, baseUrl, plan.limit, plan.options, context);
    },

    extractImagesForSettingsInSlices: async function(html, baseUrl, settings, scheduling, context) {
      var plan = S.getImageExtractionPlan(settings);
      var images = [];
      var steps = S.iterateImageExtraction(html, baseUrl, plan.limit, plan.options, images, context);
      var sliceStartedAt = scheduling.sliceStartedAt ?? scheduling.clock();
      while (Date.now() < scheduling.deadline()) {
        if (scheduling.clock() - sliceStartedAt >= scheduling.sliceMs) {
          await scheduling.yieldSlice();
          sliceStartedAt = scheduling.clock();
          continue;
        }
        if (steps.next().done) return { images: images, partial: false };
      }
      steps.return();
      var reachedLimit = !S.createImageCollectionGuard(images, plan.limit, plan.options)();
      return { images: images, partial: !reachedLimit };
    },

    extractImagesByRegex: function(html, baseUrl, maxCount, options, context) {
      maxCount = maxCount || 100;
      var images = [];
      var steps = S.iterateImageExtractionByRegex(html, baseUrl, maxCount, options, images, context);
      while (!steps.next().done) {}
      return images;
    },

    iterateImageExtractionByRegex: function*(html, baseUrl, maxCount, options, images, context) {
      html = S.limitArticleHtml(html);
      var seen = {};
      var canContinue = S.createImageCollectionGuard(images, maxCount, options);

      function resolveImageUrl(url) {
        if (!url) return '';
        url = S.cleanResourceUrl(S.decodeHtmlEntities(url));
        var r = S.resolveUrl(baseUrl, url, true);
        if (!r || !S.isMeaningfulImage(r)) return '';
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
        var existingPreview = S.getImagePreviewSrc(existing);
        var nextPreview = S.getImagePreviewSrc(next);
        if (S.normalizeImageUrl(existingPreview) !== S.normalizeImageUrl(nextPreview)) return false;
        var existingDisplay = S.getImageDisplaySrc(existing);
        var nextDisplay = S.getImageDisplaySrc(next);
        if (!nextDisplay || S.normalizeImageUrl(existingDisplay) === S.normalizeImageUrl(nextDisplay)) return false;
        if (S.normalizeImageUrl(existingDisplay) === S.normalizeImageUrl(existingPreview)) return true;
        if (S.isHeavyImageUrl(existingDisplay) && !S.isHeavyImageUrl(nextDisplay)) return true;
        return false;
      }
      function addCandidate(displayCandidates, previewCandidates, source) {
        var preview = firstResolved(previewCandidates);
        var display = firstResolved(displayCandidates);
        if (!preview && display) preview = display;
        if (!display && preview) display = preview;
        if (!preview || !display) return false;
        var normalized = S.normalizeImageUrl(preview.url);
        var candidate = {
          src: display.url,
          source: source || preview.source,
          displaySource: display.source,
          previewSource: preview.source
        };
        if (display.url !== preview.url && S.normalizeImageUrl(display.url) !== normalized) {
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
        var attrMap = tag.attrMap;
        var srcset = attrMap.srcset || '';
        var src = attrMap.src || '';
        var srcsetUrls = srcset ? S.getSrcsetUrls(srcset) : { best: '', smallest: '' };
        var smallSrcset = srcsetUrls.smallest;
        var bestSrcset = srcsetUrls.best;
        var candidates = [
          { url: tag.file || tag.zoomfile, source: 'file/regex' },
          { url: attrMap['data-original'], source: 'data-original' },
          { url: attrMap['data-src'], source: 'data-src' },
          { url: bestSrcset, source: 'srcset' },
          { url: src, source: 'img-src' }
        ];
        var displayCandidates = [
          { url: attrMap['data-thumb'], source: 'data-thumb' },
          { url: attrMap['data-thumbnail'], source: 'data-thumbnail' },
          { url: attrMap.thumb, source: 'thumb' },
          { url: src, source: 'img-src' },
          { url: smallSrcset, source: 'srcset-small' },
          { url: bestSrcset, source: 'srcset' }
        ];
        addCandidate(displayCandidates, candidates, 'img/regex');
      }

      var ctx = context || findCachedContext(html);
      var tags;
      if (ctx && ctx._imageTags && ctx._canReuseImageTags) {
        tags = ctx._imageTags;
        yield;
      } else {
        tags = [];
        var opening = new RegExp(NON_RENDERED_OPEN_RE.source, 'gi');
        var match;
        while ((match = opening.exec(html)) !== null) {
          if (!match[2]) {
            var commentEnd = html.indexOf('-->', opening.lastIndex);
            opening.lastIndex = commentEnd === -1 ? html.length : commentEnd + 3;
          } else {
            var attrsStart = opening.lastIndex;
            var tagEnd = S.findHtmlTagEnd(html, attrsStart);
            if (tagEnd === -1) break;
            opening.lastIndex = tagEnd + 1;
            var name = match[2].toLowerCase();
            if (!match[1] && CLOSING_TAG_REGEXES[name]) {
              var closing = CLOSING_TAG_REGEXES[name];
              closing.lastIndex = opening.lastIndex;
              opening.lastIndex = closing.exec(html) ? closing.lastIndex : html.length;
            } else if (!match[1]) {
              var attrs = html.slice(attrsStart, tagEnd);
              if (name === 'img' || name === 'meta' || IMAGE_CANDIDATE_ATTR_RE.test(attrs)) {
                var attrMap = parseHtmlAttributesOnce(attrs);
                tags.push({
                  name: name,
                  attrs: attrs,
                  attrMap: attrMap,
                  zoomfile: attrMap.zoomfile || '',
                  file: attrMap.file || ''
                });
              }
            }
          }
          yield;
        }
      }

      for (var zi = 0; zi < tags.length && canContinue(); zi++) {
        var zoomTag = tags[zi];
        if ((zoomTag.file || zoomTag.zoomfile) && /^(?:img|a|span|ignore_js_op)$/.test(zoomTag.name) &&
            /(?:^|\s)zoom(?:\s|$)/.test(zoomTag.attrMap.class || '')) {
          add(zoomTag.file || zoomTag.zoomfile, 'zoom/regex');
        }
        yield;
      }
      for (var zfi = 0; zfi < tags.length && canContinue(); zfi++) {
        if (tags[zfi].zoomfile) add(tags[zfi].zoomfile, 'zoomfile/standalone');
        yield;
      }
      for (var fi = 0; fi < tags.length && canContinue(); fi++) {
        if (/^(?:img|a)$/.test(tags[fi].name) && tags[fi].file) add(tags[fi].file, 'file/regex');
        yield;
      }
      for (var ii = 0; ii < tags.length && canContinue(); ii++) {
        if (tags[ii].name === 'img') addBestFromImgTag(tags[ii]);
        yield;
      }
      for (var hi = 0; hi < tags.length && canContinue(); hi++) {
        var href = tags[hi].attrMap.href;
        if (href && S.isDirectImageUrl(href)) add(href, 'link-href');
        yield;
      }
      for (var oi = 0; oi < tags.length && canContinue(); oi++) {
        if (tags[oi].name === 'meta') {
          var metaProp = (tags[oi].attrMap.property || tags[oi].attrMap.name || '').toLowerCase();
          if (metaProp === 'og:image') {
            add(tags[oi].attrMap.content || '', 'og:image');
            break;
          }
        }
        yield;
      }
    },

    extractImagesByDom: function(html, baseUrl, maxCount, options) {
      maxCount = maxCount || 100;
      html = S.limitArticleHtml(html);
      if (html.length > S.DOM_IMAGE_EXTRACT_HTML_MAX_CHARS) {
        return S.extractImagesByRegex(html, baseUrl, maxCount, options);
      }
      var images = [];
      var steps = S.iterateImageExtractionByDom(html, baseUrl, maxCount, options, images);
      while (!steps.next().done) {}
      return images;
    },

    iterateImageExtractionByDom: function*(html, baseUrl, maxCount, options, images) {
      var seen = {};
      var canContinue = S.createImageCollectionGuard(images, maxCount, options);

      function resolveImageUrl(src) {
        if (!src) return false;
        src = S.cleanResourceUrl(src);
        var url = S.resolveUrl(baseUrl, src, true);
        if (!url) return false;
        if (!S.isMeaningfulImage(url)) return false;
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
        var existingPreview = S.getImagePreviewSrc(existing);
        var nextPreview = S.getImagePreviewSrc(next);
        if (S.normalizeImageUrl(existingPreview) !== S.normalizeImageUrl(nextPreview)) return false;
        var existingDisplay = S.getImageDisplaySrc(existing);
        var nextDisplay = S.getImageDisplaySrc(next);
        if (!nextDisplay || S.normalizeImageUrl(existingDisplay) === S.normalizeImageUrl(nextDisplay)) return false;
        if (S.normalizeImageUrl(existingDisplay) === S.normalizeImageUrl(existingPreview)) return true;
        if (S.isHeavyImageUrl(existingDisplay) && !S.isHeavyImageUrl(nextDisplay)) return true;
        return false;
      }
      function addCandidate(displayCandidates, previewCandidates, source) {
        var preview = firstResolved(previewCandidates);
        var display = firstResolved(displayCandidates);
        if (!preview && display) preview = display;
        if (!display && preview) display = preview;
        if (!preview || !display) return false;
        var normalized = S.normalizeImageUrl(preview.url);
        var candidate = {
          src: display.url,
          source: source || preview.source,
          displaySource: display.source,
          previewSource: preview.source
        };
        if (display.url !== preview.url && S.normalizeImageUrl(display.url) !== normalized) {
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
      yield;

      var zooms = doc.querySelectorAll('.zoom[file], .zoom[zoomfile], img.zoom[file], img.zoom[zoomfile], img[file], img[zoomfile]');
      for (var z = 0; z < zooms.length && canContinue(); z++) {
        var fv = zooms[z].getAttribute('file') || zooms[z].getAttribute('zoomfile');
        if (fv) addImage(fv, 'zoom/file');
        yield;
      }

      var imgs = canContinue() ? doc.querySelectorAll('img') : [];
      for (var i = 0; i < imgs.length && canContinue(); i++) {
        var img = imgs[i];
        var srcset = img.getAttribute('srcset') || img.srcset;
        var srcsetUrls = srcset ? S.getSrcsetUrls(srcset) : { best: '', smallest: '' };
        var bestSrcset = srcsetUrls.best;
        var smallSrcset = srcsetUrls.smallest;
        var imgSrc = img.getAttribute('src');
        addCandidate([
          { url: img.getAttribute('data-thumb'), source: 'data-thumb' },
          { url: img.getAttribute('data-thumbnail'), source: 'data-thumbnail' },
          { url: img.getAttribute('thumb'), source: 'thumb' },
          { url: imgSrc, source: 'img-src' },
          { url: smallSrcset, source: 'srcset-small' },
          { url: bestSrcset, source: 'srcset' }
        ], [
          { url: img.getAttribute('file') || img.getAttribute('zoomfile'), source: 'file' },
          { url: img.getAttribute('data-original'), source: 'data-original' },
          { url: img.getAttribute('data-src'), source: 'data-src' },
          { url: bestSrcset, source: 'srcset' },
          { url: imgSrc, source: 'img-src' }
        ], 'img');
        yield;
      }

      var links = canContinue() ? doc.querySelectorAll('a[href]') : [];
      for (var l = 0; l < links.length && canContinue(); l++) {
        var href = links[l].getAttribute('href');
        if (href && S.isDirectImageUrl(href)) {
          addImage(href, 'link');
        }
        yield;
      }

      // Extract og:image directly from the already-parsed DOM Document
      // instead of re-stripping and re-scanning raw HTML!
      if (canContinue()) {
        if (typeof doc.querySelector === 'function') {
          var ogMeta = doc.querySelector('meta[property="og:image"], meta[name="og:image"], meta[property="OG:IMAGE"], meta[name="OG:IMAGE"]');
          if (!ogMeta && typeof doc.querySelectorAll === 'function') {
            var metas = doc.querySelectorAll('meta[property], meta[name]');
            for (var mi = 0; mi < metas.length; mi++) {
              var mProp = (metas[mi].getAttribute('property') || metas[mi].getAttribute('name') || '').toLowerCase();
              if (mProp === 'og:image') {
                ogMeta = metas[mi];
                break;
              }
            }
          }
          if (ogMeta) {
            var ogContent = ogMeta.getAttribute('content');
            var ogResolved = ogContent ? S.resolveUrl(baseUrl, ogContent, true) : null;
            if (ogResolved) addImage(ogResolved, 'og:image');
          }
        } else {
          var fallbackOg = S.extractOgImage(html, baseUrl);
          if (fallbackOg) addImage(fallbackOg, 'og:image');
        }
      }
    },

    iterateImageExtraction: function*(html, baseUrl, maxCount, options, images, context) {
      html = S.limitArticleHtml(html);
      if (typeof DOMParser !== 'undefined' && html.length <= S.DOM_IMAGE_EXTRACT_HTML_MAX_CHARS) {
        try {
          yield* S.iterateImageExtractionByDom(html, baseUrl, maxCount, options, images);
          return;
        } catch (e) {
          images.length = 0;
        }
      }
      yield* S.iterateImageExtractionByRegex(html, baseUrl, maxCount, options, images, context);
    },

    extractImages: function(html, baseUrl, maxCount, options, context) {
      var images = [];
      var steps = S.iterateImageExtraction(html, baseUrl, maxCount || 100, options, images, context);
      while (!steps.next().done) {}
      return images;
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
