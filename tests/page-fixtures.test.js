'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const context = { URL, TextEncoder, TextDecoder };
vm.runInNewContext(fs.readFileSync(path.join(root, 'shared-utils.js'), 'utf8') + '\nthis.shared = SharedUtils;', context);
const shared = context.shared;
const fixtures = path.join(__dirname, 'fixtures', 'pages');
const cases = JSON.parse(fs.readFileSync(path.join(fixtures, 'cases.json'), 'utf8')).cases;
for (const item of cases) {
  assert(/^[a-z-]+\.html$/.test(item.file), 'fixture path must be a plain HTML filename');
  const html = fs.readFileSync(path.join(fixtures, item.file), 'utf8');
  const base = 'https://www.sehuatang.org/thread-100-1-1.html';
  const images = shared.extractImagesByRegex(html, base, 100);
  assert.deepStrictEqual(Array.from(images, image => image.src), item.images, item.file + ': images');
  if (item.previews) assert.deepStrictEqual(Array.from(images, image => image.previewSrc), item.previews);
  const resources = shared.extractResources(html, base, 'html');
  assert.strictEqual(shared.countResources(resources), item.resourceType ? 1 : 0, item.file + ': resources');
  if (item.resourceType) assert.strictEqual(resources.groups[item.resourceType][0].code, item.code);
  assert.deepStrictEqual(Array.from(resources.passwords), item.passwords);
  assert.strictEqual(shared.extractTextAttachments(html, base, 8).length, item.attachments);
  if (item.unavailable) assert(shared.isUnavailableTextDocument(html));
}
console.log('page fixtures ok: ' + cases.length + ' synthetic detail/error cases');
