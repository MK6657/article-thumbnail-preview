// Marked resources and the daily backup of everything exported or copied.
// Pure helpers shared by the forum page (what a thread holds), the worker (the
// only writer of the stored marks and backups) and the popup (export files).
//
// Integrity rules:
// - A thread is its site plus thread number: 'builtin' for the built-in forum
//   domains, 'mirror:<root>' for each mirror. Two sites never share a mark.
// - A mark is a copy of what the thread held when it was marked, updated only
//   by adding: a later read never drops a link already captured; a link a
//   complete later read no longer shows is listed as such, not dropped.
// - A share code stays with its own link; decompression passwords stay with
//   their own thread and are listed as that thread's candidates.
// - Links that expire within minutes (forum attachments, signed downloads)
//   are left out and counted; other links with signing parameters are kept
//   and labelled as possibly expired.
var ATPMarks = (function() {
  'use strict';

  var KEYS = SharedUtils.MARKS_STORAGE;
  var LIMITS = {
    MARKS: 300,
    MARKS_BYTES: 2 * 1024 * 1024,
    LINKS_PER_THREAD: 200,
    PASSWORDS: 20,
    TITLE_CHARS: 200,
    EVENTS_PER_THREAD_DAY: 50
  };
  var SITE_RE = /^(?:builtin|mirror:[a-z0-9.-]{1,253})$/;
  var TID_RE = /^\d{1,12}$/;
  var TITLE_FALLBACK = '（未读取到标题）';
  // Characters that would start a new line of the export file.
  var LINE_BREAKING_RE = new RegExp('[\\u0000-\\u001f\\u007f' + String.fromCharCode(0x85, 0x2028, 0x2029) + ']');

  function pad(value) {
    return (value < 10 ? '0' : '') + value;
  }

  function formatDate(ms) {
    var d = new Date(Number(ms) || 0);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function formatDateTime(ms, withSeconds) {
    var d = new Date(Number(ms) || 0);
    return formatDate(ms) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + (withSeconds ? ':' + pad(d.getSeconds()) : '');
  }

  function formatTime(ms) {
    var d = new Date(Number(ms) || 0);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function formatOffset(ms) {
    var minutes = -new Date(Number(ms) || 0).getTimezoneOffset();
    var sign = minutes >= 0 ? '+' : '-';
    var abs = Math.abs(minutes);
    return 'UTC' + sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
  }

  // Page text as one clean line: no line breaks, control, zero-width or
  // text-direction characters, so a title cannot fake a line of the file.
  function sanitizeText(value, maxChars) {
    var text = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (maxChars && text.length > maxChars) text = text.slice(0, maxChars) + '…';
    return text;
  }

  function parseThreadUrl(url) {
    var u;
    try {
      u = new URL(String(url || ''));
    } catch (e) {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    var rewrite = /\/thread-(\d{1,12})-\d{1,6}-\d{1,6}\.html$/i.exec(u.pathname);
    if (rewrite) return { url: u, tid: rewrite[1] };
    if (/\/forum\.php$/i.test(u.pathname) && u.searchParams.get('mod') === 'viewthread') {
      var tid = u.searchParams.get('tid') || '';
      if (TID_RE.test(tid)) return { url: u, tid: tid };
    }
    return null;
  }

  function getSiteLabel(site) {
    if (site === 'builtin') return 'sehuatang';
    return String(site || '').indexOf('mirror:') === 0 ? String(site).slice(7) : String(site || '');
  }

  function makeThreadUrl(host, tid) {
    return 'https://' + host + '/forum.php?mod=viewthread&tid=' + tid;
  }

  // Which thread a list row is. Refused (with a reason) rather than guessed:
  // the thread number must come from the link and match the row's own id.
  function getThreadIdentity(linkUrl, containerId) {
    var parsed = parseThreadUrl(linkUrl);
    if (!parsed) return { ok: false, reason: 'no_thread_id' };
    if (parsed.url.protocol !== 'https:') return { ok: false, reason: 'insecure' };
    var host = parsed.url.hostname.toLowerCase();
    var site = SharedUtils.getForumSiteZone(host);
    if (!site || !SITE_RE.test(site)) return { ok: false, reason: 'unsupported_site' };
    var rowId = /^(?:normalthread|stickthread|thread)_(\d{1,12})$/.exec(String(containerId || ''));
    if (rowId && rowId[1] !== parsed.tid) return { ok: false, reason: 'row_mismatch' };
    return {
      ok: true,
      id: site + '|' + parsed.tid,
      site: site,
      tid: parsed.tid,
      host: host,
      url: makeThreadUrl(host, parsed.tid)
    };
  }

  // The title the list shows for this thread: its title link, else the
  // longest link text in the row that points at the same thread.
  function findThreadTitle(container, linkEl, tid) {
    var best = '';
    function consider(el) {
      if (!el) return;
      var text = sanitizeText(el.textContent || el.getAttribute && el.getAttribute('title') || '', 0);
      if (text.length > best.length && !/^(?:new|\d+)$/i.test(text)) best = text;
    }
    try {
      var titleEl = container && container.querySelector ? container.querySelector('a.xst') : null;
      if (titleEl) consider(titleEl);
      if (!best && container && container.querySelectorAll) {
        var anchors = container.querySelectorAll('a[href]');
        for (var i = 0; i < anchors.length; i++) {
          var parsed = parseThreadUrl(anchors[i].href);
          if (parsed && (!tid || parsed.tid === tid)) consider(anchors[i]);
        }
      }
      if (!best) consider(linkEl);
    } catch (e) {}
    return sanitizeText(best, LIMITS.TITLE_CHARS);
  }

  function getTextAttachmentCount(threadState) {
    var count = (threadState.textAttachments && threadState.textAttachments.length) || Number(threadState.textAttachmentCount) || 0;
    if (!count && (threadState.hasTextAttachments || threadState.textResourcesRetryable)) count = 1;
    return count;
  }

  function isExpiringLink(url, threadUrl) {
    return SharedUtils.isDiscuzAttachmentUrl(url, threadUrl) || SharedUtils.isSignedTextDownloadUrl(url, threadUrl);
  }

  function cleanPasswords(passwords) {
    var out = [];
    passwords = SharedUtils.normalizePasswords(passwords);
    for (var i = 0; i < passwords.length && out.length < LIMITS.PASSWORDS; i++) {
      var password = passwords[i];
      if (!password || SharedUtils.isInvalidPasswordValue(password) || SharedUtils.isProtectedEmailPlaceholder(password)) continue;
      out.push(password);
    }
    return out;
  }

  // Resources -> link list, in the copy buttons' group order. scope limits it
  // to what a copy button copied, before anything is counted or capped.
  function linksFromResources(resources, threadUrl, scope) {
    var normalized = SharedUtils.normalizeResources(resources);
    var links = [];
    var excluded = 0;
    var overCap = 0;
    var onlyType = scope && scope.indexOf('type:') === 0 ? scope.slice(5) : '';
    var noLinks = scope === 'passwords';
    for (var g = 0; g < SharedUtils.RESOURCE_GROUP_ORDER.length; g++) {
      var type = SharedUtils.RESOURCE_GROUP_ORDER[g];
      if (noLinks || (onlyType && type !== onlyType)) continue;
      var items = normalized.groups[type] || [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (type === 'other' && isExpiringLink(item.url, threadUrl)) {
          excluded++;
          continue;
        }
        if (links.length >= LIMITS.LINKS_PER_THREAD) {
          overCap++;
          continue;
        }
        var link = { type: type, url: item.url };
        if (item.code) link.code = item.code;
        if (Array.isArray(item.altCodes) && item.altCodes.length) link.altCodes = item.altCodes.slice(0, 3);
        if (item.source && SharedUtils.hasResourceSource(item.source, 'txt')) link.txt = true;
        if (item.source && SharedUtils.hasResourceSource(item.source, 'import')) link.imported = true;
        if (type === 'other' && SharedUtils.hasTransientTextAttachmentParams(item.url, threadUrl)) link.temporary = true;
        links.push(link);
      }
    }
    return { links: links, excluded: excluded, overCap: overCap, passwords: cleanPasswords(normalized.passwords) };
  }

  // What a thread on the list page holds right now, ready to be marked,
  // updated or backed up. scope: 'all' (default), 'type:<group>' or
  // 'passwords' — a copy button's own part of the thread.
  function buildSnapshot(threadState, identity, scope, now) {
    if (!threadState || !identity || !identity.ok) return null;
    now = Number(now) || Date.now();
    var extracted = linksFromResources(threadState.resources, identity.url, scope && scope !== 'all' ? scope : '');
    var links = extracted.links;
    var attachments = getTextAttachmentCount(threadState);
    var textDone = !!threadState.textResourcesDone && !threadState.textResourcesRetryable;
    var textLimited = !!threadState.textAttachmentsLimited || attachments > SharedUtils.TEXT_ATTACHMENT_MAX_COUNT;
    var textPending = attachments > 0 && !textDone;
    var unresolved = textPending
      ? Math.max(1, Number(threadState.textResourcesUnresolvedCount) || 0, attachments - (Number(threadState.textResourcesAttemptedCount) || 0))
      : 0;
    return {
      v: 1,
      id: identity.id,
      site: identity.site,
      tid: identity.tid,
      host: identity.host,
      url: identity.url,
      title: sanitizeText(threadState.title, LIMITS.TITLE_CHARS),
      readAt: Number(threadState.contentReadAt) || Number(threadState.cacheWriteStartedAt) || now,
      links: links,
      passwords: extracted.passwords,
      excludedLinks: extracted.excluded,
      overCapLinks: extracted.overCap,
      textAttachments: attachments,
      textUnresolved: Math.min(attachments || unresolved, unresolved),
      textLimited: textLimited,
      partial: !!threadState.partial,
      importedText: !!threadState.textResourcesImported || links.some(function(link) { return link.imported; }),
      complete: !threadState.partial && !textPending && !textLimited && (!scope || scope === 'all')
    };
  }

  function toCount(value, max) {
    value = Math.floor(Number(value) || 0);
    return Math.max(0, Math.min(max || 1000000, value));
  }

  // The worker re-checks everything a page sends: the thread identity is
  // rebuilt from the host and number, every link goes through the resource
  // normalizer again, and text is cleaned and capped.
  function sanitizeSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var site = String(raw.site || '');
    var tid = String(raw.tid || '');
    var host = String(raw.host || '').toLowerCase();
    if (!SITE_RE.test(site) || !TID_RE.test(tid) || !/^[a-z0-9.-]{1,253}$/.test(host)) return null;
    if (SharedUtils.getForumSiteZone(host) !== site) return null;
    if (raw.id !== site + '|' + tid) return null;
    var url = makeThreadUrl(host, tid);
    var groups = SharedUtils.emptyResources().groups;
    var allLinks = Array.isArray(raw.links) ? raw.links : [];
    var rawLinks = allLinks.slice(0, LIMITS.LINKS_PER_THREAD);
    var flags = {};
    for (var i = 0; i < rawLinks.length; i++) {
      var link = rawLinks[i];
      if (!link || typeof link !== 'object' || !Object.prototype.hasOwnProperty.call(groups, link.type)) continue;
      if (typeof link.url !== 'string' || LINE_BREAKING_RE.test(link.url) || link.url.length > 4096) continue;
      var item = { url: link.url, source: link.txt ? 'txt' : 'html' };
      if (link.imported) item.source = SharedUtils.mergeResourceSource(item.source, 'import');
      if (typeof link.code === 'string') item.code = link.code;
      if (Array.isArray(link.altCodes)) item.altCodes = link.altCodes.filter(function(code) { return typeof code === 'string'; }).slice(0, 3);
      groups[link.type].push(item);
      flags[link.type + '|' + link.url] = !!link.temporary;
    }
    var extracted = linksFromResources({ groups: groups, passwords: Array.isArray(raw.passwords) ? raw.passwords.filter(function(p) { return typeof p === 'string'; }) : [] }, url);
    extracted.links.forEach(function(link) {
      if (flags[link.type + '|' + link.url]) link.temporary = true;
    });
    var dropped = Math.max(0, rawLinks.length - extracted.links.length - extracted.excluded - extracted.overCap);
    return {
      v: 1,
      id: site + '|' + tid,
      site: site,
      tid: tid,
      host: host,
      url: url,
      title: sanitizeText(raw.title, LIMITS.TITLE_CHARS),
      readAt: toCount(raw.readAt, 8640000000000000),
      links: extracted.links,
      passwords: extracted.passwords,
      excludedLinks: toCount(raw.excludedLinks, 10000) + extracted.excluded,
      overCapLinks: toCount(raw.overCapLinks, 100000) + extracted.overCap + Math.max(0, allLinks.length - rawLinks.length),
      droppedLinks: dropped,
      textAttachments: toCount(raw.textAttachments, 1000),
      textUnresolved: toCount(raw.textUnresolved, 1000),
      textLimited: !!raw.textLimited,
      partial: !!raw.partial,
      importedText: !!raw.importedText || extracted.links.some(function(link) { return link.imported; }),
      complete: !!raw.complete && !dropped
    };
  }

  function linkKey(link) {
    return SharedUtils.getResourceDedupKey(link.type, link.url);
  }

  function mergeLinkInto(target, link) {
    var changed = false;
    if (link.code && !target.code) {
      target.code = link.code;
      changed = true;
    }
    var codes = (link.code ? [link.code] : []).concat(link.altCodes || []);
    for (var c = 0; c < codes.length; c++) {
      var before = (target.altCodes || []).length;
      SharedUtils.addAltAccessCode(target, codes[c]);
      if ((target.altCodes || []).length !== before) changed = true;
    }
    if (link.txt && !target.txt) {
      target.txt = true;
      changed = true;
    }
    if (link.temporary && !target.temporary) {
      target.temporary = true;
      changed = true;
    }
    if (link.imported && !target.imported) {
      target.imported = true;
      changed = true;
    }
    return changed;
  }

  function mergePasswords(existing, incoming) {
    var out = (existing || []).slice();
    var changed = false;
    for (var i = 0; i < (incoming || []).length && out.length < LIMITS.PASSWORDS; i++) {
      if (out.indexOf(incoming[i]) === -1) {
        out.push(incoming[i]);
        changed = true;
      }
    }
    return { passwords: out, changed: changed };
  }

  // What the reader sees in the file. Read times are left out: reading the
  // same thread again changes nothing worth another export.
  function recordContentSignature(record) {
    return JSON.stringify([
      record.title,
      (record.links || []).map(function(link) {
        return [link.type, link.url, link.code || '', link.altCodes || [], !!link.txt, !!link.temporary, !!link.imported, !!link.missing];
      }),
      record.passwords, record.excludedLinks, record.overCapLinks || 0, record.droppedLinks || 0, record.textAttachments,
      record.textUnresolved, record.textLimited, record.partial, record.importedText
    ]);
  }

  function recordTimesSignature(record) {
    return JSON.stringify([record.readAt, (record.links || []).map(function(link) { return [link.firstSeenAt, link.lastSeenAt]; })]);
  }

  // A mark from a snapshot, or an existing mark updated by one. Only adds.
  function mergeRecord(existing, snapshot, now) {
    now = Number(now) || Date.now();
    if (!existing) {
      var created = Object.assign({}, snapshot);
      delete created.complete;
      created.links = snapshot.links.map(function(link) {
        return Object.assign({}, link, { firstSeenAt: snapshot.readAt, lastSeenAt: snapshot.readAt });
      });
      created.markedAt = now;
      created.updatedAt = now;
      created.exportedAt = 0;
      return { record: created, changed: true, contentChanged: true };
    }
    var record = JSON.parse(JSON.stringify(existing));
    var before = recordContentSignature(record);
    var beforeTimes = recordTimesSignature(record);
    var rejectedForCap = 0;
    if (snapshot.title && snapshot.title !== record.title) {
      var previous = Array.isArray(record.previousTitles) ? record.previousTitles : [];
      if (record.title && previous.indexOf(record.title) === -1) previous = previous.concat([record.title]).slice(-3);
      record.previousTitles = previous;
      record.title = snapshot.title;
    }
    var byKey = {};
    record.links.forEach(function(link) { byKey[linkKey(link)] = link; });
    var seen = {};
    snapshot.links.forEach(function(link) {
      var key = linkKey(link);
      seen[key] = true;
      var target = byKey[key];
      if (!target) {
        if (record.links.length >= LIMITS.LINKS_PER_THREAD) {
          rejectedForCap++;
          return;
        }
        target = Object.assign({}, link, { firstSeenAt: snapshot.readAt, lastSeenAt: snapshot.readAt });
        record.links.push(target);
        byKey[key] = target;
        return;
      }
      mergeLinkInto(target, link);
      if (snapshot.readAt > (Number(target.lastSeenAt) || 0)) target.lastSeenAt = snapshot.readAt;
      if (target.missing) delete target.missing;
    });
    // A complete read (thread and every TXT attachment, nothing left out for
    // the cap) that no longer shows a link: kept, listed apart.
    if (snapshot.complete && !snapshot.overCapLinks && !rejectedForCap && snapshot.readAt >= (Number(record.readAt) || 0)) {
      record.links.forEach(function(link) {
        if (!seen[linkKey(link)] && !link.missing) link.missing = true;
      });
    }
    var passwords = mergePasswords(record.passwords, snapshot.passwords);
    record.passwords = passwords.passwords;
    if (snapshot.readAt >= (Number(record.readAt) || 0)) {
      record.readAt = snapshot.readAt;
      record.excludedLinks = snapshot.excludedLinks;
      record.overCapLinks = Math.max(Number(snapshot.overCapLinks) || 0, rejectedForCap);
      record.droppedLinks = Number(snapshot.droppedLinks) || 0;
      record.textAttachments = snapshot.textAttachments;
      record.textUnresolved = snapshot.textUnresolved;
      record.textLimited = snapshot.textLimited;
      record.partial = snapshot.partial;
    }
    record.importedText = !!(record.importedText || snapshot.importedText);
    record.host = record.host || snapshot.host;
    record.url = record.url || snapshot.url;
    var contentChanged = recordContentSignature(record) !== before;
    var changed = contentChanged || recordTimesSignature(record) !== beforeTimes;
    if (contentChanged) record.updatedAt = now;
    return { record: changed ? record : existing, changed: changed, contentChanged: contentChanged };
  }

  function isExported(entry) {
    return !!entry && Number(entry.exportedAt) > 0 && Number(entry.exportedAt) >= Number(entry.updatedAt);
  }

  function makeIndexEntry(record) {
    return {
      id: record.id,
      title: sanitizeText(record.title, 80),
      links: record.links.filter(function(link) { return !link.missing; }).length,
      passwords: record.passwords.length,
      attention: needsAttention(record),
      markedAt: record.markedAt,
      updatedAt: record.updatedAt,
      exportedAt: Number(record.exportedAt) || 0
    };
  }

  function needsAttention(record) {
    return !!(record.textUnresolved || record.textLimited || record.partial || record.excludedLinks || record.overCapLinks || record.droppedLinks || record.importedText ||
      record.links.some(function(link) { return link.missing || link.temporary; }));
  }

  function emptyIndex() {
    return { v: 1, rev: 0, items: [] };
  }

  function readIndex(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return emptyIndex();
    return {
      v: 1,
      rev: Math.max(0, Number(value.rev) || 0),
      items: value.items.filter(function(item) { return item && typeof item.id === 'string'; })
    };
  }

  function itemKey(id) {
    return KEYS.ITEM_PREFIX + encodeURIComponent(id);
  }

  function dayKey(date) {
    return KEYS.DAY_PREFIX + date;
  }

  function countUnexported(index) {
    var count = 0;
    readIndex(index).items.forEach(function(item) {
      if (!isExported(item)) count++;
    });
    return count;
  }

  // ---- Daily backup: every export and copy, one unit per local day ----

  function emptyDay(date) {
    return { v: 1, date: date, threads: [] };
  }

  function readDay(value, date) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.threads)) return emptyDay(date);
    return { v: 1, date: value.date || date, threads: value.threads.filter(function(thread) { return thread && typeof thread.id === 'string'; }) };
  }

  // kind: 'export' | 'copy'; scope: what was copied ('all', 'type:<group>',
  // 'passwords', 'marks').
  function addToDay(day, snapshot, event) {
    var thread = null;
    for (var i = 0; i < day.threads.length; i++) {
      if (day.threads[i].id === snapshot.id) {
        thread = day.threads[i];
        break;
      }
    }
    if (!thread) {
      thread = {
        id: snapshot.id,
        site: snapshot.site,
        tid: snapshot.tid,
        host: snapshot.host,
        url: snapshot.url,
        title: snapshot.title,
        firstAt: event.at,
        lastAt: event.at,
        events: [],
        links: [],
        passwords: []
      };
      day.threads.push(thread);
    }
    if (snapshot.title && snapshot.title !== thread.title) {
      var previous = Array.isArray(thread.previousTitles) ? thread.previousTitles : [];
      if (thread.title && previous.indexOf(thread.title) === -1) thread.previousTitles = previous.concat([thread.title]).slice(-3);
      thread.title = snapshot.title;
    }
    thread.lastAt = Math.max(Number(thread.lastAt) || 0, event.at);
    if (thread.events.length < LIMITS.EVENTS_PER_THREAD_DAY) thread.events.push({ at: event.at, kind: event.kind, scope: event.scope || 'all' });
    var byKey = {};
    thread.links.forEach(function(link) { byKey[linkKey(link)] = link; });
    snapshot.links.forEach(function(link) {
      var target = byKey[linkKey(link)];
      if (target) {
        mergeLinkInto(target, link);
        if (!link.missing && target.missing) delete target.missing;
        return;
      }
      if (thread.links.length >= LIMITS.LINKS_PER_THREAD) {
        thread.overCapLinks = (Number(thread.overCapLinks) || 0) + 1;
        return;
      }
      var copy = { type: link.type, url: link.url };
      if (link.code) copy.code = link.code;
      if (link.altCodes && link.altCodes.length) copy.altCodes = link.altCodes.slice();
      if (link.temporary) copy.temporary = true;
      if (link.imported) copy.imported = true;
      if (link.missing) copy.missing = true;
      thread.links.push(copy);
      byKey[linkKey(copy)] = copy;
    });
    if (snapshot.overCapLinks) thread.overCapLinks = Math.max(Number(thread.overCapLinks) || 0, snapshot.overCapLinks);
    thread.passwords = mergePasswords(thread.passwords, snapshot.passwords).passwords;
    return day;
  }

  // A stored mark as the snapshot that goes into a backup.
  function recordToSnapshot(record) {
    return {
      id: record.id,
      site: record.site,
      tid: record.tid,
      host: record.host,
      url: record.url,
      title: record.title,
      links: record.links.slice(),
      passwords: record.passwords || [],
      overCapLinks: Number(record.overCapLinks) || 0
    };
  }

  function readDays(value) {
    var days = value && typeof value === 'object' && value.days && typeof value.days === 'object' ? value.days : {};
    return { v: 1, days: days };
  }

  function summarizeDay(day) {
    var links = 0;
    day.threads.forEach(function(thread) {
      links += thread.links.filter(function(link) { return !link.missing; }).length;
    });
    return { threads: day.threads.length, links: links };
  }

  // ---- Files ----

  function pushLinks(lines, links, missingOnly) {
    for (var g = 0; g < SharedUtils.RESOURCE_GROUP_ORDER.length; g++) {
      var type = SharedUtils.RESOURCE_GROUP_ORDER[g];
      var group = links.filter(function(link) { return link.type === type && !!link.missing === !!missingOnly; });
      if (!group.length) continue;
      lines.push('[' + SharedUtils.RESOURCE_GROUP_LABELS[type] + ']');
      group.forEach(function(link) {
        lines.push(link.url);
        if (link.code) lines.push('提取码: ' + link.code);
        else if (SharedUtils.isPanResourceType(type)) lines.push('提取码: （帖内未找到）');
        if (link.altCodes && link.altCodes.length) lines.push('帖内另见提取码: ' + link.altCodes.join('、'));
        if (link.temporary) lines.push('（临时链接，可能已失效）');
        if (link.imported) lines.push('（来自本地导入的 TXT，未核对是否属于本帖）');
      });
    }
  }

  function pushPasswords(lines, passwords) {
    lines.push('[解压密码]（本帖候选）');
    if (passwords && passwords.length) passwords.forEach(function(password) { lines.push(password); });
    else lines.push('（未识别到）');
  }

  function noteLines(record) {
    var notes = [];
    if (record.textUnresolved) notes.push('注意: TXT 附件 ' + record.textUnresolved + '/' + (record.textAttachments || record.textUnresolved) + ' 个未解析，回到列表页等解析完成后重新导出，或回原帖下载');
    if (record.textLimited) notes.push('注意: 本帖 TXT 附件超过 ' + SharedUtils.TEXT_ATTACHMENT_MAX_COUNT + ' 个，只读取了前 ' + SharedUtils.TEXT_ATTACHMENT_MAX_COUNT + ' 个');
    if (record.partial) notes.push('注意: 帖子内容读取不完整，可能缺少链接');
    if (record.excludedLinks) notes.push('注意: 已排除 ' + record.excludedLinks + ' 条论坛附件或临时下载链接（几分钟内失效），请回原帖下载');
    if (record.overCapLinks) notes.push('注意: 本帖链接超过 ' + LIMITS.LINKS_PER_THREAD + ' 条，另有 ' + record.overCapLinks + ' 条未保存，请回原帖查看');
    if (record.droppedLinks) notes.push('注意: ' + record.droppedLinks + ' 条链接格式异常，未能保存，请回原帖查看');
    if (record.importedText) notes.push('注意: 含本地导入的 TXT，未核对是否属于本帖');
    return notes;
  }

  function describeEvent(event) {
    var what = event.scope === 'passwords' ? '密码'
      : event.scope && event.scope.indexOf('type:') === 0 ? (SharedUtils.RESOURCE_GROUP_LABELS[event.scope.slice(5)] || event.scope.slice(5))
        : event.scope === 'marks' ? '已标记列表' : '全部';
    return formatTime(event.at) + ' ' + (event.kind === 'export' ? '导出' : '复制' + what);
  }

  function groupBySite(list) {
    var order = [];
    var bySite = {};
    list.forEach(function(item) {
      if (!bySite[item.site]) {
        bySite[item.site] = [];
        order.push(item.site);
      }
      bySite[item.site].push(item);
    });
    return order.map(function(site) { return { site: site, items: bySite[site] }; });
  }

  function finishFile(lines) {
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  function formatExport(records, meta) {
    meta = meta || {};
    var now = Number(meta.now) || Date.now();
    var linkCount = 0;
    var attention = 0;
    records.forEach(function(record) {
      linkCount += record.links.filter(function(link) { return !link.missing; }).length;
      if (needsAttention(record)) attention++;
    });
    var lines = [
      '# 文章缩略图预览 · 已标记资源',
      '# 导出时间 ' + formatDateTime(now, true) + ' (' + formatOffset(now) + ')' + (meta.version ? ' · 插件 v' + meta.version : ''),
      '# 共 ' + records.length + ' 帖 · 链接 ' + linkCount + ' 条' + (attention ? ' · 需注意 ' + attention + ' 帖' : ''),
      '# 说明：提取码写在所属网盘链接的下一行；解压密码按帖列出，是在该帖第一页（含回复）识别到的候选，未逐条对应到链接。'
    ];
    var number = 0;
    groupBySite(records).forEach(function(section) {
      lines.push('', '======== 站点: ' + getSiteLabel(section.site) + ' ========');
      section.items.forEach(function(record) {
        number++;
        lines.push('', '#' + number + ' 标题: ' + (record.title || TITLE_FALLBACK));
        if (record.previousTitles && record.previousTitles.length) lines.push('曾用标题: ' + record.previousTitles.join(' / '));
        lines.push('帖子: ' + record.url);
        lines.push('标记: ' + formatDateTime(record.markedAt) + ' · 内容读取: ' + formatDateTime(record.readAt || record.markedAt));
        var notes = noteLines(record);
        if (notes.length) notes.forEach(function(note) { lines.push(note); });
        else lines.push('状态: 完整');
        var current = record.links.filter(function(link) { return !link.missing; });
        if (current.length) pushLinks(lines, current, false);
        else lines.push('（未识别到资源链接）');
        pushPasswords(lines, record.passwords);
        if (record.links.some(function(link) { return link.missing; })) {
          lines.push('[最近一次读取帖子时已不存在]');
          pushLinks(lines, record.links, true);
        }
      });
    });
    lines.push('', '# 结束 · ' + records.length + ' 帖 / ' + linkCount + ' 条链接');
    return finishFile(lines);
  }

  function formatDayBackup(days, meta) {
    meta = meta || {};
    var now = Number(meta.now) || Date.now();
    var lines = [
      '# 文章缩略图预览 · 每日备份（导出和复制过的资源）',
      '# 生成时间 ' + formatDateTime(now, true) + ' (' + formatOffset(now) + ')' + (meta.version ? ' · 插件 v' + meta.version : ''),
      '# 说明：同一天内同一帖子的多次导出/复制合并为一条；提取码写在所属链接下一行；解压密码为该帖候选。'
    ];
    days.forEach(function(day) {
      var summary = summarizeDay(day);
      lines.push('', '################ ' + day.date + ' · ' + summary.threads + ' 帖 · ' + summary.links + ' 条链接 ################');
      var number = 0;
      groupBySite(day.threads).forEach(function(section) {
        lines.push('', '======== 站点: ' + getSiteLabel(section.site) + ' ========');
        section.items.forEach(function(thread) {
          number++;
          lines.push('', '#' + number + ' 标题: ' + (thread.title || TITLE_FALLBACK));
          if (thread.previousTitles && thread.previousTitles.length) lines.push('曾用标题: ' + thread.previousTitles.join(' / '));
          lines.push('帖子: ' + thread.url);
          lines.push('记录: ' + (thread.events || []).map(describeEvent).join('，'));
          if (thread.overCapLinks) lines.push('注意: 本帖链接超过 ' + LIMITS.LINKS_PER_THREAD + ' 条，另有 ' + thread.overCapLinks + ' 条未备份，请回原帖查看');
          if (thread.links.some(function(link) { return !link.missing; })) pushLinks(lines, thread.links, false);
          else lines.push('（未复制链接）');
          pushPasswords(lines, thread.passwords);
          if (thread.links.some(function(link) { return link.missing; })) {
            lines.push('[导出/复制时帖内已不存在]');
            pushLinks(lines, thread.links, true);
          }
        });
      });
    });
    return finishFile(lines);
  }

  return {
    KEYS: KEYS,
    LIMITS: LIMITS,
    sanitizeText: sanitizeText,
    parseThreadUrl: parseThreadUrl,
    getThreadIdentity: getThreadIdentity,
    findThreadTitle: findThreadTitle,
    getSiteLabel: getSiteLabel,
    buildSnapshot: buildSnapshot,
    sanitizeSnapshot: sanitizeSnapshot,
    mergeRecord: mergeRecord,
    recordToSnapshot: recordToSnapshot,
    isExported: isExported,
    needsAttention: needsAttention,
    makeIndexEntry: makeIndexEntry,
    emptyIndex: emptyIndex,
    readIndex: readIndex,
    itemKey: itemKey,
    dayKey: dayKey,
    countUnexported: countUnexported,
    emptyDay: emptyDay,
    readDay: readDay,
    readDays: readDays,
    addToDay: addToDay,
    summarizeDay: summarizeDay,
    formatDate: formatDate,
    formatExport: formatExport,
    formatDayBackup: formatDayBackup
  };
})();
