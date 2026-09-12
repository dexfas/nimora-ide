import assert from 'node:assert/strict';
import {
  NIMORA_CAPABILITY_META_KEY,
  capabilityMcpFields,
  capabilityRegistrySnapshot,
  getCapabilityMetadata,
  requireCapabilityMetadata,
} from '../src/capability-registry.ts';
import { IDE_TOOL_DEFINITIONS } from '../src/ide-tool-definitions.ts';
import {
  defineGatewayCapability,
  isAutomaticallyRetryableTool,
  readCapabilityMetadata,
  retryPolicyForTool,
} from '../tools/webmcp-gateway/capability-contract.mjs';

const bridgeNames = [
  'apply_patch',
  'find_files',
  'read_files',
  'search_files',
  ...IDE_TOOL_DEFINITIONS.map(tool => tool.name),
  'set_todos',
  'report_progress',
];

for (const name of bridgeNames) {
  assert.ok(getCapabilityMetadata(name), `capability registry must cover ${name}`);
}

assert.equal(requireCapabilityMetadata('read_files').risk, 'read');
assert.equal(requireCapabilityMetadata('read_files').retry, 'automatic');
assert.equal(requireCapabilityMetadata('apply_patch').risk, 'write');
assert.equal(requireCapabilityMetadata('apply_patch').retry, 'never');
assert.equal(requireCapabilityMetadata('run_command').risk, 'execute');
assert.equal(requireCapabilityMetadata('run_command').retry, 'never');
assert.equal(requireCapabilityMetadata('get_command_output').retry, 'automatic');
assert.equal(requireCapabilityMetadata('set_todos').idempotency, 'idempotent');
assert.equal(capabilityMcpFields('read_files').annotations.readOnlyHint, true);
assert.equal(capabilityMcpFields('run_command').annotations.readOnlyHint, false);
assert.equal(capabilityMcpFields('run_command').annotations.destructiveHint, true);
assert.equal(capabilityMcpFields('read_files')._meta[NIMORA_CAPABILITY_META_KEY].retry, 'automatic');

const ids = capabilityRegistrySnapshot().map(item => item.id);
assert.equal(ids.length, new Set(ids).size, 'capability ids must be unique');

const browserRead = defineGatewayCapability(
  { name: 'browser_test_read', description: 'test', inputSchema: { type: 'object', properties: {} } },
  {
    id: 'browser.test.read',
    version: 1,
    title: 'Browser Test Read',
    category: 'browser',
    tags: ['test'],
    environment: 'gateway',
    risk: 'read',
    idempotency: 'safe',
    retry: 'automatic',
    approval: 'none',
    destructive: false,
    openWorld: true,
  },
);
assert.equal(browserRead._meta[NIMORA_CAPABILITY_META_KEY].id, 'browser.test.read');
assert.equal(readCapabilityMetadata(browserRead)?.environment, 'gateway');
assert.equal(retryPolicyForTool(browserRead), 'automatic');
assert.equal(isAutomaticallyRetryableTool(browserRead), true);
assert.equal(retryPolicyForTool({ name: 'legacy_read', inputSchema: { type: 'object' } }), undefined, 'legacy tools without metadata must stay eligible for transport-specific compatibility fallback');

const sideEffect = defineGatewayCapability(
  { name: 'browser_test_click', description: 'test', inputSchema: { type: 'object', properties: {} } },
  {
    id: 'browser.test.click',
    version: 1,
    title: 'Browser Test Click',
    category: 'browser',
    tags: ['test'],
    environment: 'gateway',
    risk: 'external-side-effect',
    idempotency: 'non-idempotent',
    retry: 'never',
    approval: 'session',
    destructive: true,
    openWorld: true,
  },
);
assert.equal(sideEffect.annotations.readOnlyHint, false);
assert.equal(sideEffect.annotations.idempotentHint, false);
assert.equal(isAutomaticallyRetryableTool(sideEffect), false);

console.log(`[smoke] capability registry metadata ok (${capabilityRegistrySnapshot().length} core capabilities)`);
