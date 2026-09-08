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

fixtures.attachmentCases.forEach(function(testCase) {
  const attachments = SharedUtils.extractTextAttachments(testCase.html, baseUrl, 3);
  assert.deepStrictEqual(
    plain(attachments.map(function(item) { return item.url; })),
    testCase.expectedUrls,
    testCase.name + ': TXT attachment URLs'
  );
});

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
