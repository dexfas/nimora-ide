import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const servicePath = path.join(root, 'src', 'vs', 'platform', 'browserView', 'node', 'playwrightService.ts');
const modelPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'browserView', 'common', 'browserView.ts');
const [serviceSource, modelSource] = await Promise.all([
  fs.readFile(servicePath, 'utf8'),
  fs.readFile(modelPath, 'utf8'),
]);

const startTracking = serviceSource.match(/async startTrackingPage\(viewId: string\): Promise<void> \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
assert.ok(startTracking, 'startTrackingPage implementation must remain discoverable');
assert.match(startTracking, /await session\.group\.addView\(viewId\)/, 'explicit share must await BrowserView group admission');
assert.match(startTracking, /await session\.waitForPage\(viewId\)/, 'explicit share must await exact Playwright page readiness');
assert.match(startTracking, /Promise\.allSettled\(sessions\.map\(session => session\.group\.removeView\(viewId\)\)\)/, 'failed share must roll back partially admitted group views');
assert.ok(startTracking.indexOf('this._trackedPages.add(viewId)') > startTracking.indexOf('await session.waitForPage(viewId)'), 'tracked truth must publish only after readiness');

const stopTracking = serviceSource.match(/async stopTrackingPage\(viewId: string\): Promise<void> \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
assert.ok(stopTracking, 'stopTrackingPage implementation must remain discoverable');
assert.match(stopTracking, /await session\.group\.removeView\(viewId\)/, 'explicit unshare must await BrowserView group removal');
assert.ok(stopTracking.indexOf('this._trackedPages.delete(viewId)') > stopTracking.indexOf('await session.group.removeView(viewId)'), 'untracked truth must publish only after removal');

assert.match(serviceSource, /await session\.group\.addView\(viewId\);\s*await session\.waitForPage\(viewId\);/, 'new-session replay must wait for exact page pairing');
assert.match(serviceSource, /async waitForPage\(viewId: string, timeoutMs = 10000\)/, 'PlaywrightSession must expose bounded exact-page readiness');
assert.equal(serviceSource.includes('\n\t\t\tsession.group.addView(viewId);'), false, 'startTracking must not regress to fire-and-forget addView');
assert.equal(serviceSource.includes('\n\t\t\tsession.group.removeView(viewId);'), false, 'stopTracking must not regress to fire-and-forget removeView');

assert.match(modelSource, /await this\.playwrightService\.startTrackingPage\(this\.id\);\s*this\._setSharedWithAgent\(true\);/, 'BrowserView UI must publish shared only after tracking promise resolves');
assert.match(modelSource, /await this\.playwrightService\.stopTrackingPage\(this\.id\);\s*this\._setSharedWithAgent\(false\);/, 'BrowserView UI must publish unshared only after stop promise resolves');

console.log(JSON.stringify({
  result: 'PASS',
  shareAwaitsGroupAdmission: true,
  shareAwaitsExactPagePairing: true,
  failedShareRollsBack: true,
  trackedTruthAfterReadiness: true,
  unshareAwaitsRemoval: true,
  sessionReplayAwaitsPagePairing: true,
  browserUiTruthFollowsTrackingPromise: true,
}, null, 2));
