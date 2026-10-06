'use strict';

const DEFAULT_MIN_INTERVAL_MS = 6000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30000;

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function isDeepSeekRateLimitError(error) {
  const message = String(error?.message || error || '');
  return /消息发送过于频繁|too\s+many\s+requests|too\s+frequent|rate[ -]?limit|try\s+again\s+later/i.test(message);
}

/**
 * Extension-host-wide FIFO for provider writes across all DeepSeek pages.
 *
 * This gate never retries by default. Callers may opt into exactly one retry
 * only when they can prove the failed write was rejected before provider
 * admission. A proven rate-limit failure always moves the earliest admission
 * time forward before any retry or future distinct write.
 */
function createDeepSeekProviderWriteGate(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : ms => new Promise(resolve => setTimeout(resolve, ms));
  const minIntervalMs = positiveMs(options.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  const rateLimitCooldownMs = positiveMs(options.rateLimitCooldownMs, DEFAULT_RATE_LIMIT_COOLDOWN_MS);
  const onWriteStarted = typeof options.onWriteStarted === 'function' ? options.onWriteStarted : async () => {};
  const onCooldown = typeof options.onCooldown === 'function' ? options.onCooldown : async () => {};
  let lastWriteStartedAt = positiveMs(options.initialLastWriteStartedAt, 0);
  let cooldownUntil = positiveMs(options.initialCooldownUntil, 0);
  let tail = Promise.resolve();

  async function execute(operation, executionOptions = {}) {
    if (typeof operation !== 'function') throw new Error('DeepSeek provider write gate requires an operation function.');
    const retryIf = typeof executionOptions.retryIf === 'function' ? executionOptions.retryIf : null;
    const previous = tail;
    const current = (async () => {
      await previous;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const currentNow = now();
        const earliest = Math.max(
          cooldownUntil,
          lastWriteStartedAt > 0 ? lastWriteStartedAt + minIntervalMs : 0,
        );
        const delayMs = Math.max(0, earliest - currentNow);
        if (delayMs > 0) await sleep(delayMs);
        const startedAt = now();
        lastWriteStartedAt = startedAt;
        await onWriteStarted(startedAt);
        try {
          return await operation();
        } catch (error) {
          const rateLimited = isDeepSeekRateLimitError(error);
          if (rateLimited) {
            cooldownUntil = Math.max(cooldownUntil, now() + rateLimitCooldownMs);
            await onCooldown(cooldownUntil, error);
          }
          if (attempt === 0 && rateLimited && retryIf?.(error) === true) continue;
          throw error;
        }
      }
      throw new Error('DeepSeek provider write gate exhausted its bounded retry path.');
    })();
    // A rejected write must not poison the FIFO for future distinct turns.
    tail = current.then(() => undefined, () => undefined);
    return current;
  }

  return {
    execute,
    status: () => ({ lastWriteStartedAt, cooldownUntil, minIntervalMs, rateLimitCooldownMs }),
  };
}

module.exports = {
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  createDeepSeekProviderWriteGate,
  isDeepSeekRateLimitError,
};
