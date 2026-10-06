import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));
const { createDeepSeekProviderWriteGate, isDeepSeekRateLimitError } = require('./extensions/shuncode-webmcp/deepseek-provider-write-gate.js');

let now = 1_000;
const sleeps = [];
const starts = [];
const cooldowns = [];
const gate = createDeepSeekProviderWriteGate({
  minIntervalMs: 6_000,
  rateLimitCooldownMs: 30_000,
  now: () => now,
  sleep: async ms => { sleeps.push(ms); now += ms; },
  onWriteStarted: async at => { starts.push(at); },
  onCooldown: async until => { cooldowns.push(until); },
});

let executions = 0;
assert.equal(await gate.execute(async () => { executions += 1; now += 1_000; return 'first'; }), 'first');
assert.equal(executions, 1);
assert.deepEqual(starts, [1_000]);

assert.equal(await gate.execute(async () => { executions += 1; return 'second'; }), 'second');
assert.equal(executions, 2);
assert.deepEqual(sleeps, [5_000], 'second distinct write must wait until the six-second global spacing boundary');
assert.deepEqual(starts, [1_000, 7_000]);

let rateLimitedAttempts = 0;
await assert.rejects(() => gate.execute(async () => {
  rateLimitedAttempts += 1;
  throw new Error('DeepSeek provider reported: 消息发送过于频繁，请稍后重试');
}), /消息发送过于频繁/);
assert.equal(rateLimitedAttempts, 1, 'rate-limited provider write must never be retried by the gate');
assert.equal(cooldowns.length, 1);
const cooldownUntil = cooldowns[0];

let postCooldownExecutions = 0;
await gate.execute(async () => { postCooldownExecutions += 1; return 'after-cooldown'; });
assert.equal(postCooldownExecutions, 1);
assert.ok(starts.at(-1) >= cooldownUntil, 'future independently-authorized write must wait through the recorded cooldown');

let provenPreAdmissionAttempts = 0;
const retryStartsBefore = starts.length;
assert.equal(await gate.execute(async () => {
  provenPreAdmissionAttempts += 1;
  if (provenPreAdmissionAttempts === 1) {
    throw new Error('DeepSeek provider reported a send failure before exact user-message admission: 消息发送过于频繁，请稍后重试');
  }
  return 'safe-retry';
}, {
  retryIf: error => /before exact user-message admission/.test(String(error?.message || error)),
}), 'safe-retry');
assert.equal(provenPreAdmissionAttempts, 2, 'proven pre-admission rate limit gets exactly one bounded retry');
assert.equal(starts.length, retryStartsBefore + 2);
assert.ok(starts.at(-1) - starts.at(-2) >= 30_000, 'safe retry must wait through the global rate-limit cooldown');

assert.equal(isDeepSeekRateLimitError(new Error('Too many requests, try again later')), true);
assert.equal(isDeepSeekRateLimitError(new Error('ordinary provider failure')), false);

// A rejected queued operation must not poison FIFO progress for later distinct work.
await assert.rejects(() => gate.execute(async () => { throw new Error('ordinary provider failure'); }), /ordinary provider failure/);
assert.equal(await gate.execute(async () => 'still-runs'), 'still-runs');

console.log('PASS DeepSeek provider write gate: global spacing, FIFO recovery, explicit rate-limit cooldown, and zero automatic replay');
