/**
 * Action Fusion for dsh: one model call performs a mutation AND its verification.
 *
 * Upstream (SoL-Pi) adds a `thenRun` field to the existing edit/write tool. dsh
 * validates tool arguments against each tool's own schema, so a plugin cannot add
 * a field to a tool it does not own — therefore the fused action is its own tool
 * with its own schema.
 *
 * Safety is the whole design here, because this tool both writes and runs:
 *  - the write goes through `ctx.fs` (the sandbox-aware filesystem seam) and
 *    honours the same `fs/*-intent` waterfall the first-party file tool uses;
 *  - the command goes through `ctx.shell` — the same executor the pwsh/bash tools
 *    use, so the sandbox provider applies its own defaults and caps;
 *  - the call is gated by `ctx.approval` and proceeds ONLY on an explicit
 *    `'allowed-once'` grant. No approval service, a rejection, or a failure of any
 *    kind means nothing runs;
 *  - a failed edit never reaches the command, and the result always says which
 *    half ran.
 *
 * @module dsh-solpack/fusion
 */
import { formatBytes } from './preview.js';

const DESCRIPTION = [
  'Apply one file edit and immediately run its verification command in the same call, so an edit and its check cost one model round-trip.',
  'Fails closed: without an approval grant nothing is written and nothing is run.',
  'write=true creates/overwrites the file with new_string; otherwise new_string replaces the unique old_string (replace_all replaces every match).',
  'The reply reports the edit, the command, the exit code, and the captured stdout/stderr.',
].join(' ');

/** Collected output may be a bare string or a structured capture; accept both. */
function outputText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
  return '';
}

const message = (error) => String(error?.message ?? error);

/**
 * @param ctx - cordis context (needs the optional `fs`, `shell`, `approval` services).
 * @param cfg - normalized solpack config.
 * @param logger - optional `ctx.logger`-shaped sink.
 * @returns a registry-ready `ToolDefinition`, or `null` when the deployment cannot
 *   support fusion (the caller then skips registration).
 */
export function createFusionTool({ ctx, cfg, logger }) {
  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'File to mutate, relative to the session workspace.' },
      verify: { type: 'string', description: 'Shell command that checks the edit; run right after the write.' },
      old_string: { type: 'string', description: 'Exact text to replace. Required unless write=true.' },
      new_string: { type: 'string', description: 'Replacement text; empty deletes the match. Full content when write=true.' },
      replace_all: { type: 'boolean', description: 'Replace every exact match instead of requiring exactly one.' },
      write: { type: 'boolean', description: 'true = create or overwrite the whole file.' },
      cwd: { type: 'string', description: 'Working directory for the verify command.' },
      timeout_ms: { type: 'integer', description: 'Verify-command timeout in milliseconds.' },
    },
    required: ['path', 'verify'],
  };

  const supported = () => Boolean(ctx.get?.('fs')) && Boolean(ctx.get?.('shell'));

  /** Approval gate: nothing runs without an explicit once-grant. */
  async function approved(exec, path, verify) {
    if (!cfg.fusionRequireApproval) return { ok: true };
    const approval = ctx.get?.('approval');
    if (!approval) {
      return {
        ok: false,
        text: 'fused edit+verify refused: no approval service is loaded (set fusionRequireApproval=false to accept that risk).',
      };
    }
    let outcome;
    try {
      outcome = await approval.request({
        agent: exec?.agent,
        toolName: cfg.fusionToolName,
        callId: exec?.callId,
        reason: `edit ${path} and run: ${verify}`,
        signal: exec?.signal,
      });
    } catch (error) {
      return { ok: false, text: `fused edit+verify refused: the approval request failed (${message(error)}).` };
    }
    if (outcome !== 'allowed-once') {
      return { ok: false, text: `fused edit+verify refused by approval (${String(outcome)}); nothing was written and nothing was run.` };
    }
    return { ok: true };
  }

  async function applyEdit(fs, args, exec) {
    const path = String(args.path).trim();
    const target = await fs.resolve(path, { cwd: args.cwd, signal: exec?.signal });
    const intentOf = async (event) =>
      typeof ctx.waterfall === 'function' ? await ctx.waterfall(event, target, exec, () => undefined) : undefined;
    if (args.write === true) {
      const outcome = await fs.writeText(
        target,
        String(args.new_string ?? ''),
        await intentOf('fs/write-intent'),
        exec?.signal,
      );
      return { op: outcome?.operation === 'create' ? 'create' : 'overwrite', path, bytes: Buffer.byteLength(String(outcome?.after ?? ''), 'utf8') };
    }
    const oldString = String(args.old_string ?? '');
    const outcome = await fs.editText(
      target,
      { oldString, newString: String(args.new_string ?? ''), replaceAll: args.replace_all === true },
      await intentOf('fs/edit-intent'),
      exec?.signal,
    );
    return { op: 'edit', path, bytes: Buffer.byteLength(String(outcome?.after ?? ''), 'utf8') };
  }

  async function execute(args, exec) {
    const refuse = (text) => ({ ok: false, text });
    if (!supported()) {
      return refuse('fused edit+verify unavailable: this deployment has no ctx.fs/ctx.shell service; use the native edit and shell tools.');
    }
    const path = String(args?.path ?? '').trim();
    const verify = String(args?.verify ?? '').trim();
    if (path.length === 0) return refuse('fused edit+verify needs "path".');
    if (verify.length === 0) return refuse('fused edit+verify needs "verify" (the command that checks the edit).');
    if (args?.write !== true && String(args?.old_string ?? '').length === 0) {
      return refuse('fused edit+verify needs "old_string" unless write=true.');
    }

    const gate = await approved(exec, path, verify);
    if (!gate.ok) return refuse(gate.text);

    let edit;
    try {
      edit = await applyEdit(ctx.get('fs'), args, exec);
    } catch (error) {
      return refuse(`edit failed and the verify command was NOT run: ${message(error)}`);
    }

    let run;
    try {
      const shell = ctx.get('shell');
      const timeoutMs = Number.isFinite(args?.timeout_ms) ? Math.trunc(args.timeout_ms) : cfg.fusionTimeoutMs;
      run = await shell.run(shell.resolve({ command: verify, workdir: args?.cwd, timeoutMs, signal: exec?.signal }));
    } catch (error) {
      return {
        ok: false,
        text: `edit applied (${edit.op} ${edit.path}, now ${formatBytes(edit.bytes)}) but the verify command could not run: ${message(error)}`,
      };
    }

    const exitCode = Number.isFinite(run?.exitCode) ? run.exitCode : null;
    const ok = exitCode === 0 && run?.timedOut !== true;
    const head = [
      `fused edit+verify: ${ok ? 'PASS' : 'FAIL'}`,
      `edit: ${edit.op} ${edit.path} (file now ${formatBytes(edit.bytes)})`,
      `verify: ${verify}`,
      `exit: ${exitCode === null ? '(killed by signal)' : exitCode}${run?.timedOut ? ' TIMED OUT' : ''}${run?.aborted ? ' ABORTED' : ''}`,
    ].join('\n');
    const cap = cfg.fusionMaxOutputBytes;
    const out = outputText(run?.stdout);
    const err = outputText(run?.stderr);
    const clip = (text, label) => {
      if (text.length === 0) return '';
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes <= cap) return `--- ${label} ---\n${text}`;
      const sliced = Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8');
      return `--- ${label} (first ${formatBytes(cap)} of ${formatBytes(bytes)}) ---\n${sliced}`;
    };
    const body = [clip(out, 'stdout'), clip(err, 'stderr')].filter(Boolean).join('\n');
    logger?.info?.(`solpack: fused ${edit.op} ${edit.path} -> exit ${exitCode}`);
    return {
      ok,
      edit,
      command: verify,
      exitCode,
      timedOut: run?.timedOut === true,
      text: body.length > 0 ? `${head}\n${body}` : head,
    };
  }

  return {
    name: cfg.fusionToolName,
    description: DESCRIPTION,
    parameters,
    output: { schema: {}, render: (args, value) => [{ type: 'text', text: String(value?.text ?? '') }] },
    // A mutation must never overlap a sibling call.
    isConcurrencySafe: () => false,
    execute,
  };
}