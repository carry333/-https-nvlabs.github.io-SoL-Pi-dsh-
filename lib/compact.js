/**
 * Online Context Compact for dsh: pick the compaction *moment* by economics and
 * plan-step boundaries instead of only by the backend's own pressure threshold.
 *
 * Upstream (SoL-Pi) compacts "when a completed plan step makes the retained
 * surface worthless enough", guarded by economic and window-pressure checks, and
 * keeps working in a fresh turn afterwards. dsh owns compaction itself
 * (`ctx.compaction`, loaded by `@deepseek-ai/dsh-compaction-basic`), so this
 * plugin does not summarise anything: it only decides WHEN to ask.
 *
 * Every gate must pass before a single ask is made:
 *   surface pressure above `compactMinTokens` (from `ctx.tokenMeter`), enough
 *   completed steps since the last attempt, the cooldown expired, and a projected
 *   saving above `compactMinSavingTokens`. `ctx.compaction.compactIfNeeded` still
 *   decides whether a safe range exists, so a declined ask costs one call and
 *   changes nothing.
 *
 * Disabled by default: this is a policy over another subsystem's transaction, and
 * it is the one mechanism here that cannot be validated without a live loop.
 *
 * @module dsh-solpack/compact
 */
export function createCompactPolicy({ ctx, cfg, logger }) {
  /** @type {Map<string, {lastAttempt: number, steps: number, lastProjected: number}>} */
  const state = new Map();

  const sessionIdOf = (agent) => String(agent?.session?.header?.id ?? '_unknown');

  /** Surface pressure in tokens, or `undefined` when no meter is loaded. */
  function measure(agent) {
    const meter = ctx.get?.('tokenMeter');
    if (!meter || typeof meter.measure !== 'function') return undefined;
    try {
      const measured = meter.measure(agent.session);
      return Number.isFinite(measured?.totalTokens) ? measured.totalTokens : undefined;
    } catch (error) {
      logger?.warn?.(`solpack: token measurement failed: ${String(error?.message ?? error)}`);
      return undefined;
    }
  }

  /**
   * Count one completed step and ask for compaction when every gate passes.
   * @param agent - the agent whose session may be compacted.
   * @param signal - cancellation signal (falls back to a plug-in-owned timeout).
   * @returns the compaction result, or `null` when nothing was asked or the backend declined.
   */
  async function afterStep(agent, signal) {
    const compaction = ctx.get?.('compaction');
    if (!compaction || typeof compaction.compactIfNeeded !== 'function') return null;
    if (!agent?.session) return null;

    const id = sessionIdOf(agent);
    const now = Date.now();
    const entry = state.get(id) ?? { lastAttempt: 0, steps: 0, lastProjected: 0 };
    state.set(id, entry);
    entry.steps += 1;

    if (entry.steps < cfg.compactMinSteps) return null;
    if (now - entry.lastAttempt < cfg.compactCooldownMs) return null;

    const pressure = measure(agent);
    if (pressure === undefined) return null;
    if (pressure < cfg.compactMinTokens) return null;

    // Projected saving: a summary keeps a fraction of the surface and costs one
    // model request to build. Ask only when the difference is worth having.
    const projected = Math.round(pressure * (1 - cfg.compactKeepRatio) - cfg.compactSummaryCostTokens);
    entry.lastProjected = projected;
    if (projected < cfg.compactMinSavingTokens) return null;

    entry.lastAttempt = now;
    entry.steps = 0;
    const abort = signal ?? AbortSignal.timeout(cfg.compactTimeoutMs);
    try {
      const result = await compaction.compactIfNeeded(agent, 'pressure', abort);
      logger?.info?.(
        result
          ? `solpack: online compaction ran (surface ~${pressure} tokens, projected saving ~${projected})`
          : `solpack: online compaction considered and declined (surface ~${pressure} tokens)`,
      );
      return result ?? null;
    } catch (error) {
      // A failed ask is a failed ask: the loop keeps running on the full surface.
      logger?.warn?.(`solpack: compaction ask failed: ${String(error?.message ?? error)}`);
      return null;
    }
  }

  return { afterStep, state };
}