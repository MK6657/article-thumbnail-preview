const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sandbox = { URL: URL, TextDecoder: TextDecoder, console: console };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(root, 'shared-utils.js'), 'utf8') + '\nthis.SharedUtils = SharedUtils;\n' +
  fs.readFileSync(path.join(root, 'resource-marks.js'), 'utf8') + '\nthis.ATPMarks = ATPMarks;',
  sandbox,
  { filename: 'resource-marks.js' }
);
const SharedUtils = sandbox.SharedUtils;
const ATPMarks = sandbox.ATPMarks;
SharedUtils.setMirrorSites([SharedUtils.makeMirrorSite('mirror.example', true)]);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---- Identity: site + thread number, refused rather than guessed ----
const byRewrite = ATPMarks.getThreadIdentity('https://www.sehuatang.org/thread-123-1-2.html', 'normalthread_123');
const byQuery = ATPMarks.getThreadIdentity('https://www.sehuatang.net/forum.php?mod=viewthread&tid=123&extra=page%3D1', '');
const pageTwo = ATPMarks.getThreadIdentity('https://www.sehuatang.org/thread-123-2-1.html', '');
assert.strictEqual(byRewrite.ok, true);
assert.strictEqual(byRewrite.id, 'builtin|123');
assert.strictEqual(byQuery.id, 'builtin|123', 'the two built-in domains are one site, whatever the link form');
assert.strictEqual(pageTwo.id, 'builtin|123', 'the page a link points at does not change which thread it is');
assert.strictEqual(byRewrite.url, 'https://www.sehuatang.org/forum.php?mod=viewthread&tid=123');
const onMirror = ATPMarks.getThreadIdentity('https://mirror.example/thread-123-1-1.html', '');
assert.strictEqual(onMirror.id, 'mirror:mirror.example|123', 'a mirror is its own site: the same number there is another thread');
assert.strictEqual(ATPMarks.getThreadIdentity('https://www.sehuatang.org/thread-123-1-1.html', 'normalthread_124').reason, 'row_mismatch');
assert.strictEqual(ATPMarks.getThreadIdentity('http://www.sehuatang.org/thread-123-1-1.html', '').reason, 'insecure');
assert.strictEqual(ATPMarks.getThreadIdentity('https://other.example/thread-123-1-1.html', '').reason, 'unsupported_site');
assert.strictEqual(ATPMarks.getThreadIdentity('https://www.sehuatang.org/forum-2-1.html', '').reason, 'no_thread_id');

// ---- Titles: one clean line ----
assert.strictEqual(ATPMarks.sanitizeText('第一行\r\n解压密码: fake\u202e\u200b 标题', 0), '第一行 解压密码: fake 标题');
function fakeAnchor(text, href) {
  return { textContent: text, href: href, getAttribute: function() { return ''; } };
}
const row = {
  querySelector: function(selector) { return selector === 'a.xst' ? fakeAnchor('  某某合集\n4K  ', 'https://www.sehuatang.org/thread-123-1-1.html') : null; },
  querySelectorAll: function() { return []; }
};
assert.strictEqual(ATPMarks.findThreadTitle(row, null, '123'), '某某合集 4K');
const rowWithoutTitleClass = {
  querySelector: function() { return null; },
  querySelectorAll: function() {
    return [
      fakeAnchor('New', 'https://www.sehuatang.org/thread-123-1-1.html'),
      fakeAnchor('另一个帖子', 'https://www.sehuatang.org/thread-999-1-1.html'),
      fakeAnchor('本帖标题', 'https://www.sehuatang.org/forum.php?mod=viewthread&tid=123')
    ];
  }
};
assert.strictEqual(ATPMarks.findThreadTitle(rowWithoutTitleClass, null, '123'), '本帖标题', 'only links to the same thread may give its title');

// ---- Snapshots ----
const B = 'https://pan.baidu.com/s/1AAAA';
const Q = 'https://pan.quark.cn/s/bbbb';
const M = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
function threadState(overrides) {
  return Object.assign({
    title: '某某合集 4K',
    resources: {
      groups: {
        baidu: [{ url: B, code: 'aaaa', altCodes: ['cccc'] }],
        quark: [{ url: Q }],
        magnet: [{ url: M }],
        other: [
          { url: 'https://www.sehuatang.org/forum.php?mod=attachment&aid=MTIzfDU2Nzg5&file=a.torrent' },
          { url: 'https://files.example/pack.zip?token=abc&expires=1' },
          { url: 'https://files.example/plain.rar' }
        ]
      },
      passwords: ['Pass123', 'pass123']
    },
    textAttachments: [],
    textAttachmentCount: 0,
    textResourcesDone: false,
    textResourcesRetryable: false,
    partial: false,
    contentReadAt: 1000,
    cacheWriteStartedAt: 2000
  }, overrides || {});
}
const snapshot = ATPMarks.buildSnapshot(threadState(), byRewrite, 'all', 5000);
assert.strictEqual(snapshot.title, '某某合集 4K');
assert.strictEqual(snapshot.readAt, 1000, 'a snapshot keeps when the thread was actually read');
assert.deepStrictEqual(plain(snapshot.links.map(function(link) { return link.type + ':' + (link.code || '') + ':' + (link.temporary ? 't' : ''); })),
  ['magnet::', 'baidu:aaaa:', 'quark::', 'other::t', 'other::']);
assert.deepStrictEqual(plain(snapshot.links[1].altCodes), ['cccc'], 'a second code the thread gave stays with its link');
assert.strictEqual(snapshot.excludedLinks, 1, 'a forum attachment link expires within minutes and is left out, counted');
assert.deepStrictEqual(plain(snapshot.passwords), ['Pass123', 'pass123'], 'passwords differing only in case are both kept');
assert.strictEqual(snapshot.complete, true);
const pendingText = ATPMarks.buildSnapshot(threadState({ textAttachmentCount: 2, hasTextAttachments: true }), byRewrite, 'all');
assert.strictEqual(pendingText.complete, false, 'a thread whose TXT is still unread is not complete');
assert.strictEqual(pendingText.textUnresolved, 2);
const baiduOnly = ATPMarks.buildSnapshot(threadState(), byRewrite, 'type:baidu');
assert.deepStrictEqual(plain(baiduOnly.links.map(function(link) { return link.type; })), ['baidu'], 'a copy of one group backs up that group');
assert.deepStrictEqual(plain(baiduOnly.passwords), ['Pass123', 'pass123'], 'a backup always carries the thread passwords');
assert.strictEqual(ATPMarks.buildSnapshot(threadState(), byRewrite, 'passwords').links.length, 0);

// ---- The worker re-checks what a page sends ----
const clean = ATPMarks.sanitizeSnapshot(plain(snapshot));
assert.strictEqual(clean.url, 'https://www.sehuatang.org/forum.php?mod=viewthread&tid=123');
assert.strictEqual(clean.links.length, 5);
assert.strictEqual(clean.links[3].temporary, true);
const offSite = plain(snapshot);
offSite.host = 'evil.example';
assert.strictEqual(ATPMarks.sanitizeSnapshot(offSite), null, 'the host must belong to the snapshot site');
const forged = plain(snapshot);
forged.site = 'mirror:mirror.example';
assert.strictEqual(ATPMarks.sanitizeSnapshot(forged), null, 'the id, site and host must agree');
const hostile = plain(snapshot);
hostile.title = '标题\r\n#2 标题: 伪造';
hostile.links = hostile.links.concat([
  { type: 'baidu', url: 'javascript:alert(1)' },
  { type: 'magnet', url: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111\r\n解压密码: fake' },
  { type: 'nope', url: 'https://x.example/a.zip' }
]);
const cleaned = ATPMarks.sanitizeSnapshot(hostile);
assert.strictEqual(cleaned.title, '标题 #2 标题: 伪造', 'a title cannot start a new line of the file');
assert.strictEqual(cleaned.links.length, 5, 'links that are not real resources are dropped');

// ---- Merging only adds ----
const first = ATPMarks.mergeRecord(null, clean, 10000).record;
assert.strictEqual(first.markedAt, 10000);
assert.strictEqual(first.exportedAt, 0);
const later = plain(clean);
later.readAt = 20000;
later.title = '某某合集 4K（更新）';
later.links = later.links.filter(function(link) { return link.type !== 'quark'; });
later.links.push({ type: 'quark', url: 'https://pan.quark.cn/s/newone', code: 'nnnn' });
later.passwords = ['pw-new'];
const merged = ATPMarks.mergeRecord(first, later, 30000);
assert.strictEqual(merged.changed, true);
assert.strictEqual(merged.record.updatedAt, 30000);
assert.strictEqual(merged.record.title, '某某合集 4K（更新）');
assert.deepStrictEqual(plain(merged.record.previousTitles), ['某某合集 4K']);
const quarkOld = merged.record.links.find(function(link) { return link.url === Q; });
assert(quarkOld && quarkOld.missing === true, 'a link a complete later read no longer shows is kept and listed apart');
assert(merged.record.links.some(function(link) { return link.code === 'nnnn'; }), 'new links are added');
assert.deepStrictEqual(plain(merged.record.passwords), ['Pass123', 'pass123', 'pw-new']);
const partialRead = plain(later);
partialRead.links = [];
partialRead.complete = false;
partialRead.readAt = 40000;
const afterPartial = ATPMarks.mergeRecord(merged.record, partialRead, 50000).record;
assert.strictEqual(afterPartial.links.filter(function(link) { return link.missing; }).length, 1, 'an incomplete read never marks links as gone');
const again = ATPMarks.mergeRecord(merged.record, later, 60000);
assert.strictEqual(again.changed, false, 'the same content again is no change');
const codeLater = plain(later);
codeLater.links = codeLater.links.map(function(link) { return link.url === B ? Object.assign({}, link, { code: 'zzzz' }) : link; });
const withAlt = ATPMarks.mergeRecord(merged.record, codeLater, 70000).record;
const baidu = withAlt.links.find(function(link) { return link.url === B; });
assert.strictEqual(baidu.code, 'aaaa', 'the first code stays the link code');
assert.deepStrictEqual(plain(baidu.altCodes), ['cccc', 'zzzz']);

// ---- Index ----
const entry = ATPMarks.makeIndexEntry(merged.record);
assert.strictEqual(entry.links, 5);
assert.strictEqual(ATPMarks.isExported(entry), false);
assert.strictEqual(ATPMarks.isExported(Object.assign({}, entry, { exportedAt: entry.updatedAt })), true);
assert.strictEqual(ATPMarks.isExported(Object.assign({}, entry, { exportedAt: entry.updatedAt - 1 })), false, 'a change after the export needs another export');
assert.strictEqual(ATPMarks.countUnexported({ items: [entry, Object.assign({}, entry, { id: 'x', exportedAt: entry.updatedAt })] }), 1);
assert.strictEqual(ATPMarks.itemKey('builtin|123'), 'atp_marks_v1_item_builtin%7C123');
assert.deepStrictEqual(plain(SharedUtils.getMarksStorageKeys({
  atp_marks_v1_index: { items: [{ id: 'builtin|123' }] },
  atp_marks_v1_days: { days: { '2026-09-26': {} } }
})), ['atp_marks_v1_index', 'atp_marks_v1_days', 'atp_marks_v1_item_builtin%7C123', 'atp_marks_v1_day_2026-09-26']);

// ---- Daily backup: one unit per day, threads kept apart ----
const other = ATPMarks.sanitizeSnapshot(plain(ATPMarks.buildSnapshot(threadState({
  title: '另一个帖子',
  resources: { groups: { magnet: [{ url: M }] }, passwords: ['other-pw'] }
}), ATPMarks.getThreadIdentity('https://www.sehuatang.org/thread-456-1-1.html', ''), 'all')));
let day = ATPMarks.emptyDay('2026-09-26');
day = ATPMarks.addToDay(day, clean, { at: 100000, kind: 'copy', scope: 'type:baidu' });
day = ATPMarks.addToDay(day, other, { at: 110000, kind: 'copy', scope: 'all' });
day = ATPMarks.addToDay(day, clean, { at: 120000, kind: 'export', scope: 'all' });
assert.strictEqual(day.threads.length, 2, 'the same thread copied and exported on one day is one entry');
assert.strictEqual(day.threads[0].events.length, 2);
assert(day.threads[1].links.some(function(link) { return link.url === M; }) && day.threads[0].links.some(function(link) { return link.url === M; }),
  'a link two threads share stays with each of them');
assert.deepStrictEqual(plain(day.threads[1].passwords), ['other-pw'], 'passwords never move to another thread');
assert.deepStrictEqual(plain(ATPMarks.summarizeDay(day)), { threads: 2, links: 6 });
for (let i = 0; i < 80; i++) ATPMarks.addToDay(day, other, { at: 130000 + i, kind: 'copy', scope: 'all' });
assert.strictEqual(day.threads[1].events.length, ATPMarks.LIMITS.EVENTS_PER_THREAD_DAY);

// ---- Files ----
const exportText = ATPMarks.formatExport([merged.record, ATPMarks.mergeRecord(null, other, 11000).record], { version: '9.9.9', now: 200000 });
assert(exportText.charCodeAt(0) === 0xfeff && /\r\n/.test(exportText) && !/[^\r]\n/.test(exportText), 'the file is UTF-8 with BOM and CRLF lines');
const lines = exportText.slice(1).split('\r\n');
assert(lines.indexOf('#1 标题: 某某合集 4K（更新）') !== -1 && lines.indexOf('#2 标题: 另一个帖子') !== -1, 'every thread is listed with its title');
assert(lines.indexOf('帖子: https://www.sehuatang.org/forum.php?mod=viewthread&tid=123') !== -1);
const baiduAt = lines.indexOf(B);
assert.strictEqual(lines[baiduAt + 1], '提取码: aaaa', 'a share code is on the line under its own link');
assert.strictEqual(lines[baiduAt + 2], '帖内另见提取码: cccc');
assert.strictEqual(lines[lines.indexOf('https://pan.quark.cn/s/newone') + 1], '提取码: nnnn');
assert(lines.indexOf('[最近一次读取帖子时已不存在]') !== -1 && lines.indexOf(Q) > lines.indexOf('[最近一次读取帖子时已不存在]'));
assert(lines.some(function(line) { return /^注意: 已排除 1 条论坛附件或临时下载链接/.test(line); }));
assert(lines.indexOf('（临时链接，可能已失效）') !== -1);
const passwordsAt = lines.indexOf('[解压密码]（本帖候选）');
assert.deepStrictEqual(lines.slice(passwordsAt + 1, passwordsAt + 4), ['Pass123', 'pass123', 'pw-new']);
assert(lines.indexOf('======== 站点: sehuatang ========') !== -1);
assert(/^# 共 2 帖 · 链接 6 条/.test(lines[2]));
const noCode = ATPMarks.formatExport([ATPMarks.mergeRecord(null, ATPMarks.sanitizeSnapshot(plain(ATPMarks.buildSnapshot(threadState({
  resources: { groups: { quark: [{ url: Q }] }, passwords: [] }
}), byRewrite, 'all'))), 1).record], { now: 1 }).split('\r\n');
assert.strictEqual(noCode[noCode.indexOf(Q) + 1], '提取码: （帖内未找到）', 'a share link without a code says so');
assert(noCode.indexOf('（未识别到）') !== -1);
const untitled = ATPMarks.formatExport([ATPMarks.mergeRecord(null, Object.assign(plain(clean), { title: '' }), 1).record], { now: 1 });
assert(untitled.indexOf('#1 标题: （未读取到标题）') !== -1);

const backupText = ATPMarks.formatDayBackup([day], { version: '9.9.9', now: 300000 }).slice(1).split('\r\n');
assert(backupText.some(function(line) { return /^################ 2026-09-26 · 2 帖 · 6 条链接/.test(line); }));
assert(backupText.indexOf('#1 标题: 某某合集 4K') !== -1 && backupText.indexOf('#2 标题: 另一个帖子') !== -1, 'a backup lists every thread with its title');
assert(backupText.some(function(line) { return /^记录: \d\d:\d\d 复制百度网盘，\d\d:\d\d 导出$/.test(line); }));

// ---- Review regressions ----
// ed2k names may hold spaces: the worker keeps them, and anything it cannot
// keep is counted and makes the mark incomplete.
const spaced = ATPMarks.buildSnapshot(threadState({
  resources: { groups: { ed2k: [
    { url: 'ed2k://|file|The Movie 2020 1080p.mkv|123456789|' + 'A'.repeat(32) + '|/' },
    { url: 'ed2k://|file|电影\u00a0合集.mkv|223456789|' + 'B'.repeat(32) + '|/' },
    { url: 'ed2k://|file|电影\u3000合集.mkv|323456789|' + 'C'.repeat(32) + '|/' }
  ] }, passwords: [] }
}), byRewrite, 'all');
const spacedClean = ATPMarks.sanitizeSnapshot(plain(spaced));
assert.strictEqual(spacedClean.links.length, 3, 'ed2k links whose names hold spaces must be kept');
assert.strictEqual(spacedClean.complete, true);
assert(ATPMarks.formatExport([ATPMarks.mergeRecord(null, spacedClean, 1).record], { now: 1 }).indexOf('The Movie 2020 1080p.mkv') !== -1);
const brokenLink = plain(spaced);
brokenLink.links.push({ type: 'baidu', url: 'https://pan.baidu.com/s/1x' + String.fromCharCode(10) + '解压密码: fake' });
const brokenClean = ATPMarks.sanitizeSnapshot(brokenLink);
assert(brokenClean.droppedLinks === 1 && brokenClean.complete === false, 'a link the worker cannot keep must be counted and make the mark incomplete');
assert(ATPMarks.formatExport([ATPMarks.mergeRecord(null, brokenClean, 1).record], { now: 1 }).indexOf('注意: 1 条链接格式异常') !== -1);

// Past 200 links: counted apart, not called expiring, not growing on every
// update, never flagged as gone.
const many = { magnet: [] };
for (let i = 0; i < 250; i++) many.magnet.push({ url: 'magnet:?xt=urn:btih:' + (1000000000 + i) + 'a'.repeat(30) });
const capped = ATPMarks.sanitizeSnapshot(plain(ATPMarks.buildSnapshot(threadState({ resources: { groups: many, passwords: [] } }), byRewrite, 'all')));
assert(capped.links.length === 200 && capped.overCapLinks === 50 && capped.excludedLinks === 0, 'links past the cap are counted apart: ' + capped.overCapLinks + '/' + capped.excludedLinks);
let cappedRecord = ATPMarks.mergeRecord(null, capped, 1).record;
const cappedAgain = plain(capped);
cappedAgain.readAt = 5000;
cappedAgain.links = cappedAgain.links.slice(10).concat([{ type: 'ed2k', url: 'ed2k://|file|new.mkv|1|' + 'D'.repeat(32) + '|/' }]);
for (let i = 0; i < 3; i++) cappedRecord = ATPMarks.mergeRecord(cappedRecord, cappedAgain, 10 + i).record;
assert(cappedRecord.overCapLinks === 50 && !cappedRecord.excludedLinks, 'the cap count comes from the latest read, not a running total');
assert(!cappedRecord.links.some(function(link) { return link.missing; }), 'a read cut by the cap must not mark links as gone');
const cappedText = ATPMarks.formatExport([cappedRecord], { now: 1 });
assert(cappedText.indexOf('注意: 本帖链接超过 200 条，另有 50 条未保存') !== -1 && cappedText.indexOf('论坛附件或临时下载链接') === -1);

// Reading the same thread again leaves an exported mark exported.
const exportedRecord = Object.assign({}, merged.record, { exportedAt: merged.record.updatedAt });
const reread = plain(later);
reread.readAt = later.readAt + 3600000;
const rereadMerge = ATPMarks.mergeRecord(exportedRecord, reread, 90000);
assert(rereadMerge.changed && !rereadMerge.contentChanged, 'a re-read of the same content only moves the read times');
assert(rereadMerge.record.updatedAt === exportedRecord.updatedAt && ATPMarks.isExported(rereadMerge.record) && rereadMerge.record.readAt === reread.readAt,
  'an exported mark must stay exported when its thread is read again unchanged');

// A link no longer in the thread is kept in the backup too.
let goneDay = ATPMarks.addToDay(ATPMarks.emptyDay('2026-09-27'), ATPMarks.recordToSnapshot(merged.record), { at: 1, kind: 'export', scope: 'all' });
const goneLink = goneDay.threads[0].links.find(function(link) { return link.url === Q; });
assert(goneLink && goneLink.missing === true, 'the backup must keep a link the export lists as gone');
const goneText = ATPMarks.formatDayBackup([goneDay], { now: 1 }).split('\r\n');
assert(goneText.indexOf('[导出/复制时帖内已不存在]') !== -1 && goneText.indexOf(Q) > goneText.indexOf('[导出/复制时帖内已不存在]'));
assert.strictEqual(ATPMarks.summarizeDay(goneDay).links, 5, 'gone links are not counted as current ones');

// Links from a local TXT stay labelled through the worker and in the file.
const imported = ATPMarks.buildSnapshot(threadState({
  resources: { groups: { baidu: [{ url: B, code: 'aaaa', source: 'txt+import' }] }, passwords: [] }
}), byRewrite, 'all');
assert(imported.importedText && imported.links[0].imported, 'a link from a local TXT must be labelled');
const importedClean = ATPMarks.sanitizeSnapshot(plain(imported));
assert(importedClean.importedText && importedClean.links[0].imported, 'the label must survive the worker');
const importedText = ATPMarks.formatExport([ATPMarks.mergeRecord(null, importedClean, 1).record], { now: 1 });
assert(importedText.indexOf('（来自本地导入的 TXT，未核对是否属于本帖）') !== -1 && importedText.indexOf('注意: 含本地导入的 TXT') !== -1);

// A copy of one group backs up that group, whatever the thread's size.
const bigThread = { magnet: [], baidu: [{ url: 'https://pan.baidu.com/s/1big1', code: 'ab12' }, { url: 'https://pan.baidu.com/s/1big2', code: 'cd34' }, { url: 'https://pan.baidu.com/s/1big3', code: 'ef56' }] };
for (let i = 0; i < 210; i++) bigThread.magnet.push({ url: 'magnet:?xt=urn:btih:' + (2000000000 + i) + 'b'.repeat(30) });
const bigCopy = ATPMarks.buildSnapshot(threadState({ resources: { groups: bigThread, passwords: ['pw'] } }), byRewrite, 'type:baidu');
assert(bigCopy.links.length === 3 && bigCopy.overCapLinks === 0 && bigCopy.links.every(function(link) { return link.code; }),
  'a copy of one group must back up that whole group: ' + bigCopy.links.length + '/' + bigCopy.overCapLinks);
const pwCopy = ATPMarks.buildSnapshot(threadState({ resources: { groups: bigThread, passwords: ['pw'] } }), byRewrite, 'passwords');
assert(pwCopy.links.length === 0 && pwCopy.overCapLinks === 0 && pwCopy.passwords[0] === 'pw');

// More TXT attachments than are read: never a complete mark.
const manyTxt = ATPMarks.buildSnapshot(threadState({ textAttachmentCount: 3, textAttachmentsLimited: true, textResourcesDone: true }), byRewrite, 'all');
assert(manyTxt.textLimited === true && manyTxt.complete === false, 'a thread with unread TXT attachments must not be complete');
const manyTxtRecord = ATPMarks.mergeRecord(null, ATPMarks.sanitizeSnapshot(plain(manyTxt)), 1).record;
const manyTxtText = ATPMarks.formatExport([manyTxtRecord], { now: 1 });
assert(manyTxtText.indexOf('本帖 TXT 附件超过 3 个') !== -1 && manyTxtText.indexOf('需注意 1 帖') !== -1 && ATPMarks.makeIndexEntry(manyTxtRecord).attention === true,
  'unread TXT attachments must count as needing attention');

console.log('resource marks tests ok');
