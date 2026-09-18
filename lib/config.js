/**
 * dsh-solpack configuration.
 *
 * Mirrors SoL-Pi's stance: every mechanism is opt-in, bounded, and fail-open.
 * Note dsh's JSON-Schema subset has no `minimum`/`maximum`, so every bound here
 * is clamped in code instead of being declared to the model.
 */

/** @typedef {ReturnType<typeof normalizeConfig>} SolpackConfig */

export const CONFIG_DEFAULTS = Object.freeze({
  /** Master switch; `false` makes the plugin a true no-op. */
  enabled: true,
  /** A plain-text tool result larger than this (UTF-8 bytes) gets packed. */
  maxInlineBytes: 6000,
  /** At or above this size we build an evidence receipt instead of a head/tail preview. */
  reduceAboveBytes: 48000,
  /** Total preview budget (head+tail) kept inline for a packed result. */
  previewBytes: 2000,
  /** Lines injected from the head / tail of an oversized result. */
  receiptHeadLines: 40,
  receiptTailLines: 20,
  /** Signal lines (errors, failures, exit codes ...) kept by the receipt. */
  receiptSignalLines: 120,
  /** Hard cap for one `solpack read` reply. */
  maxReadBytes: 16000,
  /** Default page size for `solpack read` when `to` is omitted. */
  defaultReadLines: 200,
  /** Archive budget per session; above it packing is skipped (inline result kept). */
  maxArchiveBytes: 256 * 1024 * 1024,
  /** Tool name registered for recall. */
  recallToolName: 'solpack',
  /** Tools whose results are never packed. */
  denyTools: ['solpack'],
  /** When non-empty, only these tools are packed. */
  allowTools: [],
  /**
   * Action Fusion (one call = edit + verify). OFF by default: it is the only
   * mechanism that mutates files and runs commands.
   */
  enableFusion: false,
  /** Tool name registered for the fused edit+verify action. */
  fusionToolName: 'edit_verify',
  /** Require an explicit `allowed-once` approval grant before anything runs. */
  fusionRequireApproval: true,
  /** Timeout for the fused verify command, in milliseconds. */
  fusionTimeoutMs: 120000,
  /** Inline stdout/stderr budget for the fused result (solpack packs anything larger). */
  fusionMaxOutputBytes: 8000,
  /**
   * Online Context Compact. OFF by default: it is a policy over another
   * subsystem's transaction and cannot be validated without a live loop.
   */
  enableCompact: false,
  /** Completed tool results required since the last attempt. */
  compactMinSteps: 1,
  /** Minimum gap between two compaction asks, in milliseconds. */
  compactCooldownMs: 300000,
  /** Surface pressure (tokens) below which compaction is never worth asking for. */
  compactMinTokens: 24000,
  /** Fraction of the surface a summary is expected to keep. */
  compactKeepRatio: 0.5,
  /** Tokens the summarisation request itself is expected to cost. */
  compactSummaryCostTokens: 4000,
  /** Projected saving (tokens) required before asking. */
  compactMinSavingTokens: 8000,
  /** Cancellation deadline for one ask, in milliseconds. */
  compactTimeoutMs: 120000,
  /** When non-empty, only these tools count as a plan-step boundary. */
  compactBoundaryTools: [],
  /** Lines matching this regex survive into a receipt as evidence anchors. */
  signalPattern:
    'error|exception|traceback|fail|fatal|panic|denied|refused|timeout|timed out|not found|unsupported|cannot|assert|stderr|exit code|exit status|exit=|\\bFAIL\\b|✗|✘|×|^\\s+at\\s',
});

const clampInt = (value, fallback, min, max) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;

const stringList = (value, fallback) =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.length > 0) : fallback;

/**
 * Merge user config over the defaults and clamp every numeric bound.
 * @param raw - the config object handed to `apply` by the cordis loader.
 * @returns a fully populated, clamped config.
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const d = CONFIG_DEFAULTS;
  const cfg = {
    enabled: input.enabled !== false,
    maxInlineBytes: clampInt(input.maxInlineBytes, d.maxInlineBytes, 0, 64 * 1024 * 1024),
    reduceAboveBytes: clampInt(input.reduceAboveBytes, d.reduceAboveBytes, 0, 512 * 1024 * 1024),
    previewBytes: clampInt(input.previewBytes, d.previewBytes, 0, 1024 * 1024),
    receiptHeadLines: clampInt(input.receiptHeadLines, d.receiptHeadLines, 0, 5000),
    receiptTailLines: clampInt(input.receiptTailLines, d.receiptTailLines, 0, 5000),
    receiptSignalLines: clampInt(input.receiptSignalLines, d.receiptSignalLines, 0, 5000),
    maxReadBytes: clampInt(input.maxReadBytes, d.maxReadBytes, 256, 8 * 1024 * 1024),
    defaultReadLines: clampInt(input.defaultReadLines, d.defaultReadLines, 1, 100000),
    maxArchiveBytes: clampInt(input.maxArchiveBytes, d.maxArchiveBytes, 1024 * 1024, 8 * 1024 * 1024 * 1024),
    recallToolName: typeof input.recallToolName === 'string' && input.recallToolName.trim()
      ? input.recallToolName.trim()
      : d.recallToolName,
    denyTools: stringList(input.denyTools, d.denyTools),
    allowTools: stringList(input.allowTools, d.allowTools),
    enableFusion: input.enableFusion === true,
    fusionToolName: typeof input.fusionToolName === 'string' && input.fusionToolName.trim()
      ? input.fusionToolName.trim()
      : d.fusionToolName,
    fusionRequireApproval: input.fusionRequireApproval !== false,
    fusionTimeoutMs: clampInt(input.fusionTimeoutMs, d.fusionTimeoutMs, 1000, 3600000),
    fusionMaxOutputBytes: clampInt(input.fusionMaxOutputBytes, d.fusionMaxOutputBytes, 256, 1024 * 1024),
    enableCompact: input.enableCompact === true,
    compactMinSteps: clampInt(input.compactMinSteps, d.compactMinSteps, 1, 10000),
    compactCooldownMs: clampInt(input.compactCooldownMs, d.compactCooldownMs, 0, 86400000),
    compactMinTokens: clampInt(input.compactMinTokens, d.compactMinTokens, 0, 100000000),
    compactKeepRatio: Number.isFinite(input.compactKeepRatio)
      ? Math.max(0, Math.min(0.95, Number(input.compactKeepRatio)))
      : d.compactKeepRatio,
    compactSummaryCostTokens: clampInt(input.compactSummaryCostTokens, d.compactSummaryCostTokens, 0, 100000000),
    compactMinSavingTokens: clampInt(input.compactMinSavingTokens, d.compactMinSavingTokens, 0, 100000000),
    compactTimeoutMs: clampInt(input.compactTimeoutMs, d.compactTimeoutMs, 1000, 3600000),
    compactBoundaryTools: stringList(input.compactBoundaryTools, d.compactBoundaryTools),
    signalPattern: typeof input.signalPattern === 'string' && input.signalPattern ? input.signalPattern : d.signalPattern,
  };
  // A receipt only makes sense below the packing threshold.
  if (cfg.reduceAboveBytes < cfg.maxInlineBytes) cfg.reduceAboveBytes = cfg.maxInlineBytes;
  cfg.denyTools = [...new Set([...cfg.denyTools, cfg.recallToolName])];
  return cfg;
}