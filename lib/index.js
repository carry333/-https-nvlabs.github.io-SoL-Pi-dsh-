/**
 * dsh-solpack - SoL-Pi style observation economy for DeepSeek Harness.
 *
 * SoL-Pi ("Scaling Auto-Research Loops for Efficient Agent Harnesses", NVlabs)
 * discovered four reusable efficiency mechanisms. Two of them are portable to
 * dsh without touching its core, and those two are what this plugin ships:
 *
 *  1. ObservationPack  -> `tools/post-execute` replaces an oversized plain-text
 *     result with a bounded preview plus a stable `obs-` handle; the full text is
 *     archived byte-exactly and recall is exact and paged (`solpack` tool).
 *     Identical results reuse the identical handle instead of re-entering context.
 *
 *  2. Evidence-Preserving Reducer -> very large results become a deterministic
 *     "receipt" (head + tail + every signal line) whose retained lines are
 *     re-read from the archive and compared byte-for-byte before it is allowed
 *     to replace the original. Verification failure falls back to a plain
 *     preview; a storage failure falls back to the untouched original.
 *
 * Deliberately different from upstream: the reducer here never calls a model, so
 * no tool output leaves the machine and the projection is reproducible.
 *
 * Out of scope (and why): Action Fusion needs to own the edit/verify pipeline,
 * which in dsh already composes through `run_code`/parallel calls; Online Context
 * Compact hooks Pi's native compaction, whereas dsh owns compaction in
 * `@deepseek-ai/dsh-compaction` and a result-level pruner already exists.
 *
 * Contract: opt-in (a row in the profile patch), bounded (byte caps everywhere),
 * evidence-preserving (nothing is deleted, archives outlive the session), and
 * fail-open (no plugin failure may ever turn a good tool call into a bad one).
 *
 * @module dsh-solpack
 */
import { normalizeConfig } from './config.js';
import { createStore } from './store.js';
import { PACK_MARKER, buildPackNotice, buildReceipt, flattenPlainText, verifyReceipt } from './preview.js';
import { createRecallTool } from './tool.js';
import { createFusionTool } from './fusion.js';
import { createCompactPolicy } from './compact.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'solpack';

/** Require the tool registry: its `tools/post-execute` waterfall is our seam. */
export const inject = ['tools'];

/** A foreign compaction notice; if present the result is already a projection. */
const FOREIGN_NOTICE = 'Full formatted result stored at:';

/**
 * Register the recall tool and the result transformer.
 * @param ctx - cordis context with the `tools` service injected.
 * @param config - this plugin's row config from cordis.patch.yml.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const logger = ctx.logger;
  if (!cfg.enabled) {
    logger?.info?.('solpack: disabled by config; no mechanism registered');
    return;
  }
  const store = createStore(cfg, logger);

  // The recall tool is the only new model-facing surface of the packing mechanism.
  ctx.effect(() => ctx.tools.register(createRecallTool({ store, cfg, logger })), 'solpack: recall tool');

  // Action Fusion: a second tool, off by default because it mutates and runs.
  if (cfg.enableFusion) {
    const fusion = createFusionTool({ ctx, cfg, logger });
    if (fusion) ctx.effect(() => ctx.tools.register(fusion), 'solpack: fused edit+verify tool');
  }

  // Online Context Compact: a policy over the compaction service, off by default.
  const compact = cfg.enableCompact ? createCompactPolicy({ ctx, cfg, logger }) : null;

  /** A completed tool result that counts as a plan-step boundary. */
  const isBoundary = (exec) => {
    const toolName = typeof exec?.name === 'string' ? exec.name : '';
    if (toolName === cfg.recallToolName || toolName === cfg.fusionToolName) return false;
    if (cfg.compactBoundaryTools.length > 0) return cfg.compactBoundaryTools.includes(toolName);
    return true;
  };

  /**
   * Decide whether this result must be packed.
   * @returns replacement content blocks, or `undefined` to accept unchanged.
   */
  async function pack(decision, exec, result) {
    if (!decision || decision.kind !== 'accept') return undefined;
    // Value and content replacements are mutually exclusive in dsh; never fight one.
    if (Object.hasOwn(decision, 'value')) return undefined;
    // Nested composite calls stay untouched (their own results are logged separately).
    if (exec?.parent !== undefined) return undefined;
    const toolName = typeof exec?.name === 'string' ? exec.name : '';
    if (cfg.denyTools.includes(toolName)) return undefined;
    if (cfg.allowTools.length > 0 && !cfg.allowTools.includes(toolName)) return undefined;

    const source = decision.content ?? result?.content;
    const plain = flattenPlainText(source);
    if (typeof plain !== 'string' || plain.length === 0) return undefined;
    const bytes = Buffer.byteLength(plain, 'utf8');
    if (bytes <= cfg.maxInlineBytes) return undefined;
    // Never re-pack our own or another plugin's compaction notice.
    if (plain.includes(PACK_MARKER) || plain.includes(FOREIGN_NOTICE)) return undefined;

    const session = exec?.agent?.session?.header?.id ?? '_unknown';
    const record = await store.put({
      session,
      text: plain,
      toolName,
      callId: exec?.callId,
      label: 'result',
    });
    if (record === null) return undefined; // archive budget reached: keep the original

    let replacement;
    if (bytes >= cfg.reduceAboveBytes) {
      const receipt = buildReceipt({ handle: record.handle, toolName, text: plain, bytes, cfg });
      if (await verifyReceipt(receipt, store, session)) {
        if (Buffer.byteLength(receipt.text, 'utf8') < bytes) replacement = receipt.text;
      } else {
        logger?.warn?.('solpack: receipt verification failed; falling back to a plain preview');
      }
    }
    if (replacement === undefined) {
      const notice = buildPackNotice({ handle: record.handle, toolName, text: plain, bytes, lines: record.lines, cfg });
      if (Buffer.byteLength(notice.text, 'utf8') < bytes) replacement = notice.text;
    }
    // A "compaction" that does not actually shrink the result is not accepted.
    if (replacement === undefined) return undefined;

    logger?.info?.(
      `solpack: packed ${toolName} ${record.lines} lines / ${bytes} B as ${record.handle}` +
        (record.reused ? ' (deduplicated)' : ''),
    );
    return {
      kind: 'accept',
      content: [{ type: 'text', text: replacement }],
      ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
    };
  }

  ctx.on(
    'tools/post-execute',
    async (exec, result, next) => {
      const decision = await next();
      // Compaction is asked for off the critical path: the tool result must not
      // wait on a summarisation request. The service owns its own session lock.
      if (compact && isBoundary(exec)) {
        Promise.resolve()
          .then(() => compact.afterStep(exec?.agent, exec?.signal))
          .catch(() => {});
      }
      try {
        return (await pack(decision, exec, result)) ?? decision;
      } catch (error) {
        // Fail-open: a packing bug must never hide a tool result or mark it an error.
        logger?.warn?.(`solpack: packing skipped: ${String(error?.message ?? error)}`);
        return decision;
      }
    },
    { prepend: true },
  );
}