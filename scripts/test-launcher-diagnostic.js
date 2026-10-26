#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const diagnostic = require('../docs/launcher-diagnostic.js');

const redacted = diagnostic.sanitize('TV 192.168.1.44 MAC 00:11:22:aa:bb:cc token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN012345');
assert(!redacted.includes('192.168.1.44'), 'IP addresses must be redacted');
assert(!redacted.includes('00:11:22'), 'MAC addresses must be redacted');
assert(redacted.includes('[redacted-token]'), 'long tokens must be redacted');
const jsonRedacted = diagnostic.sanitize('{"deviceId":"private-value","name":"Living room"}');
assert(!jsonRedacted.includes('private-value'), 'sensitive JSON values must be redacted');
assert(jsonRedacted.includes('Living room'), 'non-sensitive labels should remain readable');
assert(diagnostic.sanitize('abcdef', 3).includes('[truncated]'), 'long values must be bounded');

const directApps = diagnostic.appSummary(JSON.stringify([
  { appName: 'Netflix', appId: 'must-not-leak' },
  { name: 'YouTube', url: 'must-not-leak' },
  { appName: 'Netflix' }
]));
assert.deepStrictEqual(directApps, { available: true, count: 3, names: ['Netflix', 'YouTube'] });
const wrappedApps = diagnostic.appSummary({ data: { apps: [] } });
assert.strictEqual(wrappedApps.available, false, 'unknown nested shapes should not be guessed');
const appInfoApps = diagnostic.appSummary({ AppInfo: [{ AppName: 'Prime Video' }] });
assert.deepStrictEqual(appInfoApps.names, ['Prime Video']);
assert.strictEqual(diagnostic.appSummary('not json').available, false);

const dial = diagnostic.dialSummary(JSON.stringify({ enable: true, app_list: ['Netflix', { name: 'YouTube' }] }));
assert.deepStrictEqual(dial, { available: true, enabled: true, appNames: ['Netflix', 'YouTube'] });
assert.strictEqual(diagnostic.dialSummary('bad').available, false);

const shared = diagnostic.bridgeShare({
  context: { userAgent: 'test-TV' },
  bridges: {
    globals: [
      { name: 'HiUtils_createRequest', type: 'function', function: { arity: 2, source: 'function () {}' } },
      { name: 'Hisense_GetModelName', type: 'function', function: { arity: 0, source: 'function () {}' } },
      { name: 'Hisense_GetDeviceID', skipped: 'sensitive-looking name; value not read' }
    ],
    versions: { Hisense_GetOSVersion: 'test' },
    launchRelated: [],
    proprietary: { available: false, names: [] },
    oipf: { available: false, managerMethods: [] },
    dial: { available: true, enabled: true, appNames: ['Netflix'] }
  }
});
assert.strictEqual(shared.candidates.length, 1, 'QR sharing should retain generic bridge candidates');
assert.strictEqual(shared.candidates[0].name, 'HiUtils_createRequest');
assert(!JSON.stringify(shared).includes('DeviceID'), 'QR sharing should omit unrelated sensitive globals');
assert.strictEqual(diagnostic.bridgeShare({ bridges: null }), null);

for (const name of ['launchApp', 'launch_app', 'startApp', 'changeSource', 'select_source']) {
  assert(diagnostic.LAUNCH_NAME.test(name), name + ' should be launch-related');
}
for (const name of ['play', 'getVersion', 'installedApps']) {
  assert(!diagnostic.LAUNCH_NAME.test(name), name + ' should not be launch-related');
}
for (const name of ['Hisense_GetDeviceID', 'serialNumber', 'accessToken', 'mac_address']) {
  assert(diagnostic.SENSITIVE_NAME.test(name), name + ' should be treated as sensitive');
}

const source = fs.readFileSync(path.join(__dirname, '..', 'docs', 'launcher-diagnostic.js'), 'utf8');
assert(!source.includes('socket.send('), 'the CDP socket must never send commands');
assert(!source.includes('.postMessage('), 'the diagnostic must not control other applications');
assert(!source.includes('/json/new'), 'the diagnostic must not create CDP targets');

console.log('Launcher diagnostic tests passed.');
