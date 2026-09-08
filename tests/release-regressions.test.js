'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadShared(encoder) {
  const sandbox = { URL, TextEncoder: encoder, TextDecoder };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'shared-utils.js'), 'utf8') +
    '\nthis.SharedUtils = SharedUtils;', sandbox);
  return sandbox.SharedUtils;
}

for (const encoder of [TextEncoder, undefined, class { encode() { throw new Error('unavailable'); } }]) {
  const shared = loadShared(encoder);
  for (const value of ['', 'ASCII', '中文', '😀', 'a😀中', '\ud800', '\udc00', '\ud800A', '\ud800\ud800\udc00']) {
    assert.strictEqual(shared.utf8ByteLength(value), Buffer.byteLength(value, 'utf8'),
      'UTF-8 quota accounting must handle supplementary and unpaired surrogates');
  }
}

const shared = loadShared(TextEncoder);
const srcset = shared.getSrcsetUrls('https://cdn.example/c_fill,w_300/a.jpg 300w, https://cdn.example/c_fill,w_900/a.jpg 900w');
assert.strictEqual(srcset.smallest, 'https://cdn.example/c_fill,w_300/a.jpg');
assert.strictEqual(srcset.best, 'https://cdn.example/c_fill,w_900/a.jpg');
assert.strictEqual(shared.decodeHtmlEntities('&amp;lt;'), '&lt;');
assert.strictEqual(shared.decodeHtmlEntities('&#38;amp;'), '&amp;');
assert.strictEqual(shared.decodeHtmlEntities('&#38;#x41;'), '&#x41;');
assert.strictEqual(shared.decodeHtmlEntities('&#x26;#65;'), '&#65;');
assert.strictEqual(shared.decodeHtmlEntities('&lt; &#65; &#x1f600; &unknown;'), '< A 😀 &unknown;');

const passwordNames = ['constructor', 'toString', '__proto__'];
assert.deepStrictEqual(Array.from(shared.normalizePasswords(passwordNames.concat(passwordNames))), passwordNames);
assert.deepStrictEqual(Array.from(shared.mergeUnique(passwordNames, passwordNames)), passwordNames);
assert.deepStrictEqual(Array.from(shared.mergeUniqueLimited(passwordNames, passwordNames, 5)), passwordNames);
for (const password of passwordNames) {
  assert.deepStrictEqual(Array.from(shared.extractArchivePasswords('解压密码: ' + password)), [password]);
  assert.deepStrictEqual(Array.from(shared.extractArchivePasswordsFromHtml('<p>解压密码: ' + password + '</p>')), [password]);
}

const visibleCustomElement = '<title-card>visible</title-card><img src=x>';
assert.strictEqual(shared.stripNonRenderedHtmlRegions(visibleCustomElement), visibleCustomElement);
assert.strictEqual(shared.stripNonRenderedHtmlRegions('<script><img src=fake></script><style>fake</style>visible'), '  visible');
assert.strictEqual(shared.stripNonRenderedHtmlRegions('<textarea>fake</textarea   >visible'), ' visible');
assert.strictEqual(shared.stripNonRenderedHtmlRegions('<textarea data-label="</textarea>">fake</textarea>visible'), ' visible');
const quotedMarker = '<div title="<script>">visible</div><img src=x>';
assert.strictEqual(shared.stripNonRenderedHtmlRegions(quotedMarker), quotedMarker);
const anchors = [];
shared.forEachAnchorTag('<a title="1 > 0" href="https://example.test/a">ok</a   >',
  function(attrs, body) { anchors.push({ attrs, body }); });
assert.strictEqual(anchors.length, 1);
assert.strictEqual(anchors[0].body, 'ok');
assert(anchors[0].attrs.includes('href="https://example.test/a"'));
shared.forEachAnchorTag('<a-card href="wrong">not a link</a-card>', function() { assert.fail('custom element is not an anchor'); });

// Deterministic upper bound with ample headroom for a linear scan; the old
// repeated suffix searches take several seconds for this 320KB fixture.
vm.runInNewContext(`
  if (shared.stripNonRenderedHtmlRegions('<!--a-->'.repeat(40000)).length !== 40000) throw Error('comment output changed');
  shared.forEachAnchorTag('<a '.repeat(40000), function() { throw Error('unclosed anchor'); });
`, { shared }, { timeout: 2000 });
assert.strictEqual(shared.isSupportedForumHost('sehuatang.org.attacker.example'), false);
assert.strictEqual(shared.isSupportedForumHost('www.sehuatang.org'), true);
assert.strictEqual(shared.isHeavyImageHost('image.imx.to.attacker.example'), false);

const images = shared.extractImagesByRegex(
  '<!-- <img src="https://cdn.example/comment.jpg"> -->' +
  '<textarea><img src="https://cdn.example/textarea.jpg"></textarea>' +
  '<img src="https://cdn.example/visible.jpg">',
  'https://www.sehuatang.org/thread-1-1-1.html', 10
);
assert.strictEqual(images.length, 1);
assert.strictEqual(images[0].src, 'https://cdn.example/visible.jpg');
console.log('release regressions ok');
