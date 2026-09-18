/**
 * Tests for the two mechanisms that need dsh services: Action Fusion
 * (`ctx.fs` + `ctx.shell` + `ctx.approval`) and Online Context Compact
 * (`ctx.compaction` + `ctx.tokenMeter`).
 *
 * The dsh services are stubbed: what is under test is this plugin's own logic —
 * above all, that a fused call fails CLOSED (no approval => nothing written,
 * nothing run) and that the compaction gates hold.
 *
 * Run: node test/fusion-compact.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await mkdtemp(path.join(os.tmpdir(), 'solpack-fc-'));
process.env.DSH_HOME = home;
const { apply } = await import('../lib/index.js');

const warnings = [];
const handlers = new Map();
const tools = [];
const calls = { writes: [], edits: [], execs: [], approvals: 0, compactions: 0, triggers: [] };
let approvalOutcome = 'allowed-once';
let pressure = 0;
let hasFsShell = true;
let failEdit = false;
let exitCode = 0;

const ctx = {
  logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
  on: (event, fn) => void handlers.set(event, fn),
  effect: (fn) => fn(),
  tools: { register: (definition) => (tools.push(definition), () => {}) },
  get(name) {
    if (name === 'fs' || name === 'shell') {
      if (!hasFsShell) return undefined;
    }
    switch (name) {
      case 'fs':
        return {
          resolve: async (p) => ({ path: p }),
          writeText: async (target, content) => {
            calls.writes.push({ path: target.path, content });
            return { operation: 'update', after: content };
          },
          editText: async (target, edit) => {
            if (failEdit) throw new Error('FS_STALE_VERSION');
            calls.edits.push({ path: target.path, ...edit });
            return { after: edit.newString };
          },
        };
      case 'shell':
        return {
          resolve: (request) => request,
          run: async (spec) => {
            calls.execs.push(spec);
            return { exitCode, stdout: 'checked ok', stderr: '', timedOut: false, aborted: false };
          },
        };
      case 'approval':
        return { request: async () => (calls.approvals += 1, approvalOutcome) };
      case 'compaction':
        return {
          compactIfNeeded: async (agent, trigger) => {
            calls.compactions += 1;
            calls.triggers.push(trigger);
            return { ok: true };
          },
        };
      case 'tokenMeter':
        return { measure: () => ({ totalTokens: pressure }) };
      default:
        return undefined;
    }
  },
};

apply(ctx, {
  maxInlineBytes: 512,
  enableFusion: true,
  fusionToolName: 'edit_verify',
  enableCompact: true,
  compactCooldownMs: 0,
  compactMinTokens: 1000,
  compactMinSavingTokens: 10,
  compactSummaryCostTokens: 10,
  compactMinSteps: 1,
});

const fusion = tools.find((t) => t.name === 'edit_verify');
assert.ok(fusion, 'fusion tool registered when enabled');
assert.equal(tools.length, 2, 'recall + fusion');
const exec = { name: 'edit_verify', callId: 'call-1', agent: { session: { header: { id: 'sess-1' } } }, signal: undefined };

// ---------------------------------------------------------------- fusion: fail closed
{
  hasFsShell = false;
  const out = await fusion.execute({ path: 'a.ts', old_string: 'a', new_string: 'b', verify: 'npx tsc' }, exec);
  assert.equal(out.ok, false, 'no capability => refusal');
  assert.match(out.text, /unavailable/);
  hasFsShell = true;
}
{
  approvalOutcome = 'rejected';
  const before = calls.writes.length + calls.edits.length + calls.execs.length;
  const out = await fusion.execute({ path: 'a.ts', old_string: 'a', new_string: 'b', verify: 'npx tsc' }, exec);
  assert.equal(out.ok, false, 'rejected approval => refusal');
  assert.match(out.text, /refused by approval/);
  assert.equal(calls.writes.length + calls.edits.length + calls.execs.length, before, 'nothing written, nothing run');
}

// ---------------------------------------------------------------- fusion: happy paths
{
  approvalOutcome = 'allowed-once';
  const out = await fusion.execute(
    { path: 'src/a.ts', write: true, new_string: 'export const x = 1;\n', verify: 'npx tsc --noEmit' },
    exec,
  );
  assert.equal(out.ok, true);
  assert.equal(calls.writes.at(-1).content, 'export const x = 1;\n', 'write reached ctx.fs');
  assert.equal(calls.execs.at(-1).command, 'npx tsc --noEmit', 'verify ran through ctx.shell');
  assert.match(out.text, /PASS/);
  assert.match(out.text, /exit: 0/);
  assert.match(out.text, /checked ok/, 'captured stdout is surfaced');
}
{
  const out = await fusion.execute(
    { path: 'src/a.ts', old_string: 'x = 1', new_string: 'x = 2', replace_all: false, verify: 'npx tsc --noEmit' },
    exec,
  );
  assert.equal(out.ok, true);
  assert.deepEqual(calls.edits.at(-1), { path: 'src/a.ts', oldString: 'x = 1', newString: 'x = 2', replaceAll: false });
}
{
  const out = await fusion.execute({ path: 'src/a.ts', verify: 'npx tsc' }, exec);
  assert.equal(out.ok, false, 'missing old_string without write=true is refused');
}
{
  exitCode = 1;
  const out = await fusion.execute({ path: 'src/a.ts', old_string: 'x = 2', new_string: 'x = 3', verify: 'npx tsc' }, exec);
  assert.equal(out.ok, false, 'non-zero exit => FAIL');
  assert.match(out.text, /FAIL/);
  assert.match(out.text, /exit: 1/);
  exitCode = 0;
}
{
  failEdit = true;
  const runs = calls.execs.length;
  const out = await fusion.execute({ path: 'src/a.ts', old_string: 'a', new_string: 'b', verify: 'npx tsc' }, exec);
  assert.equal(out.ok, false, 'failed edit => refusal');
  assert.match(out.text, /NOT run/);
  assert.equal(calls.execs.length, runs, 'a failed edit never reaches the command');
  failEdit = false;
}

// ---------------------------------------------------------------- compaction gates
{
  const hook = handlers.get('tools/post-execute');
  // Any ordinary tool result is a plan-step boundary; the fusion tool itself is
  // deliberately excluded, so a normal tool name is used here.
  const stepExec = { ...exec, name: 'pwsh' };
  const step = async () => {
    const content = [{ type: 'text', text: 'small result' }];
    await hook(stepExec, { content, isError: false }, async () => ({ kind: 'accept', content }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  pressure = 0;
  await step();
  assert.equal(calls.compactions, 0, 'no pressure => no ask');
  pressure = 50000;
  await step();
  assert.equal(calls.compactions, 1, 'high pressure => one ask');
  assert.deepEqual(calls.triggers, ['pressure'], 'the ask uses the pressure trigger');
  await step();
  assert.equal(calls.compactions, 2, 'cooldown 0 allows a later ask');
  assert.equal(warnings.length, 0, `no warnings (${warnings.join('; ')})`);
}

await rm(home, { recursive: true, force: true });
console.log('solpack fusion + compact test: OK');