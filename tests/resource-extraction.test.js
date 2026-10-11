const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixtures', 'resource-extraction.json');
const sandbox = { URL: URL, TextDecoder: TextDecoder, console: console };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(root, 'shared-utils.js'), 'utf8') + '\nthis.SharedUtils = SharedUtils;',
  sandbox,
  { filename: 'shared-utils.js' }
);

const SharedUtils = sandbox.SharedUtils;
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const baseUrl = 'https://www.sehuatang.org/thread-1-1-1.html';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactGroups(resources) {
  const out = {};
  let total = 0;
  SharedUtils.RESOURCE_GROUP_ORDER.forEach(function(type) {
    const items = resources.groups[type] || [];
    if (!items.length) return;
    out[type] = items.map(function(item) {
      const compact = { url: item.url };
      if (item.code) compact.code = item.code;
      return compact;
    });
    total += items.length;
  });
  return { groups: out, total: total };
}

fixtures.resourceCases.forEach(function(testCase) {
  const resources = SharedUtils.extractResources(testCase.html, baseUrl, 'html');
  const actual = compactGroups(resources);
  const expectedTotal = Object.keys(testCase.expected).reduce(function(total, type) {
    return total + testCase.expected[type].length;
  }, 0);
  assert.deepStrictEqual(plain(actual.groups), testCase.expected, testCase.name + ': resource groups');
  assert.strictEqual(actual.total, expectedTotal, testCase.name + ': unexpected resource link');
  assert.deepStrictEqual(plain(resources.passwords), testCase.passwords || [], testCase.name + ': passwords');
});

// Share codes in TXT files: CR/LF and blank lines are one break, other
// drives keep their own codes, a code opening a link's own line is that link's.
[
  ['链接：https://pan.baidu.com/s/1txta\r\n\r\n提取码：aaaa', { 'https://pan.baidu.com/s/1txta': 'aaaa' }],
  ['链接：https://pan.baidu.com/s/1txta\r\n解压密码：xyz\r\n提取码：aaaa', { 'https://pan.baidu.com/s/1txta': 'aaaa' }],
  ['123云盘：https://www.123pan.com/s/abcd-xyz 提取码：abcd\n百度网盘：https://pan.baidu.com/s/1txtb\n提取码：bbbb', { 'https://pan.baidu.com/s/1txtb': 'bbbb' }],
  ['链接：https://pan.baidu.com/s/1txtc\n提取码：cccc 备用链接：https://pan.baidu.com/s/1txtd', { 'https://pan.baidu.com/s/1txtc': '', 'https://pan.baidu.com/s/1txtd': 'cccc' }],
  ['链接：https://pan.baidu.com/s/1txte \n提取码：ee12 \n--来自百度网盘超级会员V5的分享', { 'https://pan.baidu.com/s/1txte': 'ee12' }],
  ['123云盘：www.123pan.com/s/abc-xyz.html 提取码：z999\n百度网盘：https://pan.baidu.com/s/1txtf\n提取码：f111\n夸克网盘：https://pan.quark.cn/s/txtg\n提取码：g222\n', { 'https://pan.baidu.com/s/1txtf': 'f111' }],
  ['蓝奏云：wwa.lanzoux.com/iabc 密码：lz12\r\n百度网盘：https://pan.baidu.com/s/1txth\r\n提取码：h111\r\n', { 'https://pan.baidu.com/s/1txth': 'h111' }],
  ['链接：https://pan.baidu.com/s/1txti\n提取码：cccc 蓝奏云：https://wwi.lanzoup.com/abc', { 'https://pan.baidu.com/s/1txti': '' }],
  ['链接：https://pan.baidu.com/s/1txtj\r\n名称：ABC\r\n大小：1G\r\n格式：MP4\r\n时长：2h\r\n提取码：jjjj\r\n链接：https://pan.baidu.com/s/1txtk\r\n名称：DEF\r\n大小：1G\r\n格式：MP4\r\n时长：2h\r\n提取码：kkkk\r\n夸克备用：https://pan.quark.cn/s/txtl',
    { 'https://pan.baidu.com/s/1txtj': 'jjjj', 'https://pan.baidu.com/s/1txtk': 'kkkk' }]
].forEach(function(testCase) {
  const resources = SharedUtils.extractResources(testCase[0], baseUrl, 'txt');
  Object.keys(testCase[1]).forEach(function(url) {
    const item = resources.groups.baidu.find(function(entry) { return entry.url === url; });
    assert(item && (item.code || '') === testCase[1][url], 'TXT share code for ' + url + ': ' + JSON.stringify(resources.groups.baidu));
  });
});

// TXT files are literal text. Autolink brackets and entity-looking password
// characters must survive the same extraction used by downloaded/local TXT.
const bracketedTxt = SharedUtils.extractResources(
  '链接：<https://pan.baidu.com/s/1literal>\n提取码：ab12\n' +
  '<magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567>\n' +
  '解压密码：abc<123>def&amp;end', baseUrl, 'txt');
assert.strictEqual(bracketedTxt.groups.baidu[0].url, 'https://pan.baidu.com/s/1literal');
assert.strictEqual(bracketedTxt.groups.baidu[0].code, 'ab12', 'TXT autolinks must retain their own access codes');
assert.strictEqual(bracketedTxt.groups.magnet.length, 1, 'TXT autolink brackets must not hide magnet resources');
assert.deepStrictEqual(plain(bracketedTxt.passwords), ['abc<123>def&amp;end'], 'TXT passwords must preserve literal markup and entities');
const htmlLiteralPassword = SharedUtils.extractResources('<p>解压密码：abc&lt;123&gt;def&amp;amp;end</p>', baseUrl, 'html');
assert.deepStrictEqual(plain(htmlLiteralPassword.passwords), ['abc<123>def&amp;end'], 'HTML must strip actual tags before decoding displayed password text');
const displayedAnchorExample = '&lt;a href="https://pan.baidu.com/s/1fake?pwd=zzzz"&gt;百度网盘&lt;/a&gt;';
for (const context of [undefined, SharedUtils.prepareArticleExtractionContext(displayedAnchorExample)]) {
  assert.strictEqual(SharedUtils.extractResources(displayedAnchorExample, baseUrl, 'html', context).groups.baidu.length, 0,
    'HTML examples displayed as escaped text must not contribute href resources');
}
const realLinkAfterExample = SharedUtils.extractResources(displayedAnchorExample + '<br>' +
  '<a href="https://pan.baidu.com/s/1real">真实下载</a> 提取码：ab12', baseUrl, 'html');
assert.strictEqual(realLinkAfterExample.groups.baidu.length, 1, 'an escaped HTML example must not add a phantom resource');
assert.strictEqual(realLinkAfterExample.groups.baidu[0].code, 'ab12', 'escaped markup must not steal a real link\'s access code');
const manyPasswords = Array.from({ length: 12 }, function(_, index) { return '解压密码：secret' + index; });
for (const source of ['html', 'txt']) {
  const passwordInput = source === 'html' ? manyPasswords.map(function(line) { return '<p>' + line + '</p>'; }).join('') : manyPasswords.join('\n');
  assert.deepStrictEqual(plain(SharedUtils.extractResources(passwordInput, baseUrl, source).passwords),
    ['secret0', 'secret1', 'secret2', 'secret3', 'secret4'], source + ' extraction must keep the first five distinct passwords');
}

// Decode an HTML URL once at extraction; normalization/merging and TXT input
// consume URL values and must not decode literal query fragments again.
const literalResourceUrl = 'https://files.example/bundle.zip?sig=a&amp;b;tail';
const literalHtmlUrl = literalResourceUrl.replace(/&/g, '&amp;');
for (const resources of [
  SharedUtils.extractResources('<a href="' + literalHtmlUrl + '">download</a>', baseUrl, 'html'),
  SharedUtils.extractResources(literalHtmlUrl, baseUrl, 'html'),
  SharedUtils.extractResources(literalResourceUrl, baseUrl, 'txt')
]) {
  assert.strictEqual(resources.groups.other[0].url, literalResourceUrl, 'resource extraction must respect its input encoding');
  assert.strictEqual(SharedUtils.normalizeResources(resources).groups.other[0].url, literalResourceUrl, 'resource normalization must preserve URL values');
  assert.strictEqual(SharedUtils.mergeResources(resources, resources).groups.other[0].url, literalResourceUrl, 'resource merging must be idempotent for literal entities');
}
const literalAttachmentUrl = 'https://dl.ldkms.la/resources.txt?sig=a&amp;b;tail';
const literalAttachmentHtml = '<a href="' + literalAttachmentUrl.replace(/&/g, '&amp;') + '">resources.txt</a>';
assert.strictEqual(SharedUtils.extractTextAttachments(literalAttachmentHtml, baseUrl, 3)[0].url, literalAttachmentUrl, 'TXT attachment URLs must be entity-decoded once');
assert.strictEqual(SharedUtils.extractTextDownloadUrls(literalAttachmentHtml, baseUrl, 3)[0], literalAttachmentUrl, 'TXT intermediary download URLs must be entity-decoded once');

// Nearby images cannot borrow a TXT filename and occupy all three fetch slots.
const imagesBesideTxt = [1, 2, 3].map(function(id) {
  return '<div class="attach"><a href="forum.php?mod=attachment&amp;aid=' + id + '">preview' + id + '.jpg</a></div>';
}).join('') + '<div class="attach">resources.txt <a href="forum.php?mod=attachment&amp;aid=4">下载附件</a></div>';
const actualTextAttachment = SharedUtils.extractTextAttachments(imagesBesideTxt, baseUrl, 3);
assert.deepStrictEqual(plain(actualTextAttachment.map(function(item) { return item.url; })), ['https://www.sehuatang.org/forum.php?mod=attachment&aid=4']);
assert.strictEqual(actualTextAttachment[0].name, 'resources.txt');
assert(!actualTextAttachment.limited, 'image attachments must not make a single TXT look truncated');
const genericImagesBesideTxt = '<div class="attach"><strong>preview.jpg</strong><a href="forum.php?mod=attachment&amp;aid=5">下载附件</a></div>' +
  '<div class="attach">resources.txt <a href="forum.php?mod=attachment&amp;aid=6">下载附件</a></div>';
assert.deepStrictEqual(plain(SharedUtils.extractTextAttachments(genericImagesBesideTxt, baseUrl, 3).map(function(item) { return item.url; })), ['https://www.sehuatang.org/forum.php?mod=attachment&aid=6'], 'generic download buttons must use their own attachment block');
const rawImagesBesideTxt = '<div>preview.jpg forum.php?mod=attachment&amp;aid=7</div>' +
  '<div>resources.txt forum.php?mod=attachment&amp;aid=8</div>';
assert.deepStrictEqual(plain(SharedUtils.extractTextAttachments(rawImagesBesideTxt, baseUrl, 3).map(function(item) { return item.url; })), ['https://www.sehuatang.org/forum.php?mod=attachment&aid=8'], 'raw URL fallback must obey attachment block boundaries too');

// More TXT attachments than are read are reported, not dropped quietly.
const fiveTxt = SharedUtils.extractTextAttachments(
  [1, 2, 3, 4, 5].map(function(i) { return '<a href="https://dl.ldkms.la/part' + i + '.txt">part' + i + '.txt</a>'; }).join(''),
  baseUrl, 3);
assert(fiveTxt.length === 3 && fiveTxt.limited === true, 'a thread with more TXT attachments than are read must say so');
const threeTxt = SharedUtils.extractTextAttachments(
  [1, 2, 3].map(function(i) { return '<a href="https://dl.ldkms.la/part' + i + '.txt">part' + i + '.txt</a>'; }).join(''),
  baseUrl, 3);
assert(threeTxt.length === 3 && !threeTxt.limited, 'exactly as many TXT attachments as are read is not over the limit');

fixtures.attachmentCases.forEach(function(testCase) {
  const attachments = SharedUtils.extractTextAttachments(testCase.html, baseUrl, 3);
  assert.deepStrictEqual(
    plain(attachments.map(function(item) { return item.url; })),
    testCase.expectedUrls,
    testCase.name + ': TXT attachment URLs'
  );
});

const threadBase = 'https://www.sehuatang.org/forum.php?mod=viewthread&tid=77&page=1';
const threadBaseKey = SharedUtils.normalizeArticleUrl(threadBase);
for (const [param, value] of Object.entries({ authorid: '7', cp: '2', viewpid: '99', ordertype: '1', stand: '1', checkrush: '1', action: 'printable' })) {
  assert.notStrictEqual(SharedUtils.normalizeArticleUrl(threadBase + '&' + param + '=' + value), threadBaseKey, param + ' must keep distinct article content out of the same cache key');
}
assert.notStrictEqual(SharedUtils.normalizeArticleUrl(threadBase + '&from=album'), threadBaseKey, 'album view must have its own article key');
assert.strictEqual(SharedUtils.normalizeArticleUrl(threadBase + '&from=list#top'), SharedUtils.normalizeArticleUrl(threadBase + '&from=next'), 'navigation-only query and hash must still dedupe');
assert(SharedUtils.isAllowedTextAttachmentUrl('https://www.sehuatang.org/misc.php?mod=attach&aid=7'), 'valid misc.php attachment must remain fetchable');

const zoomAtLimit = SharedUtils.extractImagesByRegex(
  '<img class="zoom" file="https://image.imx.to/full.jpg" src="https://cdn.example/thumb.jpg">',
  baseUrl,
  1
);
assert.strictEqual(zoomAtLimit.length, 1, 'one-image limit must still keep the zoom candidate');
assert.strictEqual(zoomAtLimit[0].src, 'https://image.imx.to/full.jpg', 'one-image limit must keep the Discuz file URL as the load source');
const zoomBelowLimit = SharedUtils.extractImagesByRegex(
  '<img class="zoom" file="https://image.imx.to/full.jpg" src="https://cdn.example/thumb.jpg">',
  baseUrl,
  100
);
assert.strictEqual(zoomBelowLimit[0].src, 'https://image.imx.to/full.jpg', 'later img scanning must not replace the Discuz file URL with an unverified src');
const domZoomImage = {
  tagName: 'IMG',
  getAttribute: function(name) {
    return ({ class: 'zoom', file: 'https://image.imx.to/full.jpg', src: 'https://cdn.example/thumb.jpg' })[name] || null;
  }
};
sandbox.DOMParser = function() {};
sandbox.DOMParser.prototype.parseFromString = function() {
  return {
    querySelectorAll: function(selector) {
      if (selector.indexOf('.zoom[file]') === 0 || selector === 'img') return [domZoomImage];
      return [];
    }
  };
};
const domZoomAtLimit = SharedUtils.extractImagesByDom('<img class="zoom" file="https://image.imx.to/full.jpg" src="https://cdn.example/thumb.jpg">', baseUrl, 1);
assert.strictEqual(domZoomAtLimit[0].src, 'https://image.imx.to/full.jpg', 'DOM one-image limit must keep the Discuz file URL as the load source');
const domZoomBelowLimit = SharedUtils.extractImagesByDom('<img class="zoom" file="https://image.imx.to/full.jpg" src="https://cdn.example/thumb.jpg">', baseUrl, 100);
assert.strictEqual(domZoomBelowLimit[0].src, 'https://image.imx.to/full.jpg', 'DOM later img scanning must not replace the Discuz file URL');
const pagedImages = SharedUtils.extractImagesByRegex(
  '<img src="https://cdn.example/image.php?page=1"><img src="https://cdn.example/image.php?page=2">',
  baseUrl,
  100
);
assert.strictEqual(pagedImages.length, 2, 'image page query must not collapse different image links');

const downloadedTxt = 'ed2k://|file|www.98T.la@妃妃宝贝.zip|2945409455|43B5B13B95A9187A3BF041CC0A94FFC2|/';
const downloadedTxtBytes = Buffer.from(downloadedTxt, 'utf8');
assert.strictEqual(downloadedTxtBytes.length, 86, 'real downloaded TXT fixture must stay byte-for-byte representative');
assert.strictEqual(crypto.createHash('sha256').update(downloadedTxtBytes).digest('hex'), '63b22500d849fc53787470a1a5a5e4503131ad0658af88fe739392a0ecf8fead', 'real downloaded TXT fixture hash changed unexpectedly');
const downloadedResources = SharedUtils.extractResources(downloadedTxt, baseUrl, 'txt');
assert.strictEqual(downloadedResources.groups.ed2k.length, 1, 'downloaded TXT must expose its ED2K resource');
assert.strictEqual(downloadedResources.groups.ed2k[0].url, downloadedTxt, 'downloaded TXT must preserve the complete ED2K URL');

let bulkHtml = '';
for (let i = 0; i < 600; i++) {
  bulkHtml += '<a href="https://pan.baidu.com/s/1bulk' + i + '?pwd=' + String(i).padStart(4, '0') + '">item</a> ';
}
const bulkStartedAt = Date.now();
const bulkResources = SharedUtils.extractResources(bulkHtml, baseUrl, 'html');
const bulkDurationMs = Date.now() - bulkStartedAt;
assert.strictEqual(bulkResources.groups.baidu.length, 600, 'bulk extraction must keep all unique links');
assert.strictEqual(bulkResources.groups.baidu[0].code, '0000', 'bulk extraction must preserve the first access code');
assert.strictEqual(bulkResources.groups.baidu[599].code, '0599', 'bulk extraction must preserve the last access code');
assert(bulkDurationMs < 3000, 'bulk extraction exceeded the 3000ms safety budget: ' + bulkDurationMs + 'ms');

console.log('resource extraction tests ok:', fixtures.resourceCases.length + fixtures.attachmentCases.length + 2);
