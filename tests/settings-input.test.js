'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'settings-schema.js'), 'utf8');
const settings = vm.runInNewContext(source + '\n' +
  '({schema: SETTINGS_SCHEMA, groups: ATPGetSettingsViewGroups(), readNumber: ATPReadNumberSetting, describeError: ATPGetNumberSettingError})');

const columns = settings.schema.find(item => item.key === 'gridCols');
const imageTimeout = settings.schema.find(item => item.key === 'imageTimeout');
for (const input of ['', ' ', '1e2', '1e-2', '5.9', '3foo', '0x5', 'Infinity', '1e1000', '0', '33']) {
  assert.equal(settings.readNumber(input, columns), null, 'columns must reject ' + JSON.stringify(input));
}
for (const [input, expected] of [['1', 1], ['32', 32], ['1e1', 10], ['5.0', 5], ['0009', 9]]) {
  assert.equal(settings.readNumber(input, columns), expected, 'columns must preserve the value of ' + JSON.stringify(input));
}
assert.equal(settings.readNumber('1e3', imageTimeout), 1000);
assert.equal(settings.readNumber('180001', imageTimeout), null);
assert.match(settings.describeError(columns), /1 至 32/);
assert.match(settings.describeError(imageTimeout), /1000 至 180000/);

assert.equal(settings.groups[0][0], '常用');
const quickKeys = Array.from(settings.groups[0][1], item => item.key);
assert.deepEqual(quickKeys, ['gridCols', 'visibleRows', 'showFloatingLauncher', 'showResourcePanel', 'copyPasswordsWithLinks', 'autoEnterAgeGate']);
const displayedKeys = Array.from(settings.groups, ([, items]) => Array.from(items, item => item.key)).flat();
assert.deepEqual(displayedKeys.sort(), Array.from(settings.schema, item => item.key).sort(),
  'common settings must be moved into their first group once, alongside every specialist setting');
