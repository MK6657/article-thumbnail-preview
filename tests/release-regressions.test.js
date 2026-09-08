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
