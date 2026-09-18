/**
 * End-to-end smoke test for dsh-solpack.
 *
 * It drives the plugin through the same seam dsh uses (`tools/post-execute`)
 * with a stub cordis context, and asserts the invariants that matter:
 * evidence is byte-exact, recall is exact and paged, identical results are
 * deduplicated, and every failure path keeps the original result.
 *
 * Run: node test/smoke.mjs   (uses a throwaway DSH_HOME)
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await mkdtemp(path.join(os.tmpdir(), 'solpack-'));
process.env.DSH_HOME = home;

const { apply } = await import('../lib/index.js');

const warnings = [];
const handlers = new Map();
const tools = [];
const ctx = {
  logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
  on: (event, fn) => void handlers.set(event, fn),
  effect: (fn) => fn(),
  tools: { register: (definition) => (tools.push(definition), () => {}) },
};

apply(ctx, { maxInlineBytes: 512, reduceAboveBytes: 4096, previewBytes: 300, maxReadBytes: 2048 });

assert.equal(tools.length, 1, 'exactly one tool is registered');
const tool = tools[0];
assert.equal(tool.name, 'solpack');
assert.ok(handlers.has('tools/post-execute'), 'post-execute hook registered');

const session = 'sess-test';
const exec = { name: 'pwsh', callId: 'call-1', agent: { session: { header: { id: session } } } };
const hook = handlers.get('tools/post-execute');

/** Drive one tool result through the hook, exactly like the registry does. */
async function feed(content, execOverride = exec) {
  const result = { content, isError: false };
  const next = async () => ({ kind: 'accept', content });
  return hook(execOverride, result, next);
}
const asText = (decision) => decision.content.map((block) => block.text).join('');
const handleOf = (text) => (text.match(/obs-[0-9a-f]{10}/) ?? [])[0];
const archivePath = (handle) => path.join(home, 'solpack', session, 'objects', handle.slice(4, 6), `${handle}.txt`);

// ---------------------------------------------------------------- fixtures
const noise = (n) => `2026-09-18T10:00:0${n % 10}Z INFO worker step ${n} completed in ${n % 97}ms`;
const bigLines = [];
for (let n = 1; n <= 2000; n++) {
  if (n === 500) bigLines.push('2026-09-18T10:08:20Z ERROR upstream refused connection: ECONNREFUSED 10.0.0.7:5432');
  else if (n === 1500) bigLines.push('ERROR retry budget exhausted');
  else if (n === 2000) bigLines.push('process finished with exit code 1');
  else bigLines.push(noise(n));
}
const bigText = bigLines.join('\n');

// ---------------------------------------------------------------- 1. passthrough
{
  const decision = await feed([{ type: 'text', text: 'tiny result' }]);
  assert.equal(asText(decision), 'tiny result', 'small results pass through untouched');
  const image = await feed([{ type: 'image', data: 'x' }]);
  assert.equal(image.content[0].type, 'image', 'non-text results pass through untouched');
  const mixed = await feed([{ type: 'text', text: bigText }, { type: 'image', data: 'x' }]);
  assert.equal(mixed.content.length, 2, 'mixed content is never packed');
  const denied = await feed([{ type: 'text', text: bigText }], { ...exec, name: 'solpack' });
  assert.ok(asText(denied).startsWith('2026-09-18'), 'the recall tool is never packed');
}

// ---------------------------------------------------------------- 2. packing
let handle;
{
  const decision = await feed([{ type: 'text', text: bigText }]);
  const text = asText(decision);
  assert.ok(text.includes('[solpack'), 'packed result carries the solpack marker');
  assert.ok(Buffer.byteLength(text, 'utf8') < Buffer.byteLength(bigText, 'utf8') / 8, 'replacement is much smaller');
  handle = handleOf(text);
  assert.ok(handle, 'packed result exposes a stable handle');
  assert.equal(await readFile(archivePath(handle), 'utf8'), bigText, 'archive holds the byte-exact original');
  assert.equal(warnings.length, 0, `no warnings during packing (${warnings.join('; ')})`);
}

// ---------------------------------------------------------------- 3. exact paged recall
{
  const read = await tool.execute({ op: 'read', handle, from: 499, to: 501 }, exec);
  assert.ok(read.text.includes(`L500| ${bigLines[499]}`), 'recall returns the exact archived line');
  assert.equal(read.from, 499);
  assert.equal(read.total, 2000);
  const page = await tool.execute({ op: 'read', handle, from: 1999 }, exec);
  assert.ok(page.text.includes('L2000| process finished with exit code 1'), 'tail page is exact');
  const bounded = await tool.execute({ op: 'read', handle, from: 1, to: 2000 }, exec);
  assert.ok(Buffer.byteLength(bounded.text, 'utf8') < 4096, 'recall is byte-bounded');
  assert.equal(bounded.more, true, 'byte-bounded recall advertises the next offset');
}

// ---------------------------------------------------------------- 4. grep / stat / list
{
  const grep = await tool.execute({ op: 'grep', handle, pattern: 'ERROR' }, exec);
  assert.ok(grep.text.includes(`L500| ${bigLines[499]}`), 'grep reports exact line 500');
  assert.ok(grep.text.includes(`L1500| ${bigLines[1499]}`), 'grep reports exact line 1500');
  assert.equal(grep.matches.length, 2);
  const missing = await tool.execute({ op: 'grep', handle, pattern: 'zzz-not-here' }, exec);
  assert.ok(missing.text.includes('no line in'), 'empty grep is reported, not thrown');
  const stat = await tool.execute({ op: 'stat', handle }, exec);
  assert.ok(stat.text.includes('lines=2000'), 'stat reports the archived line count');
  const list = await tool.execute({ op: 'list' }, exec);
  assert.ok(list.text.includes(handle), 'list exposes the session handle');
  const bad = await tool.execute({ op: 'read', handle: 'not-a-handle' }, exec);
  assert.ok(bad.text.includes('is not a handle'), 'invalid handles are rejected with guidance');
  const gone = await tool.execute({ op: 'read', handle: 'obs-0000000000' }, exec);
  assert.ok(gone.text.includes('no archived object'), 'unknown handles degrade gracefully');
}

// ---------------------------------------------------------------- 5. dedupe by content
{
  const before = (await readdir(path.join(home, 'solpack', session, 'objects', handle.slice(4, 6)))).length;
  const decision = await feed([{ type: 'text', text: bigText }]);
  assert.equal(handleOf(asText(decision)), handle, 'identical content reuses the identical handle');
  const after = (await readdir(path.join(home, 'solpack', session, 'objects', handle.slice(4, 6)))).length;
  assert.equal(before, after, 'deduplication stores the bytes once');
}

// ---------------------------------------------------------------- 6. evidence receipt
{
  const receipt = await feed([{ type: 'text', text: bigText }], { ...exec, callId: 'call-2' });
  const text = asText(receipt);
  assert.ok(text.includes('receipt:'), 'very large results become a receipt');
  assert.ok(text.includes('byte-identical to the archived original'), 'the receipt states its invariant');
  assert.ok(text.includes('L500| '), 'signal lines survive into the receipt');
  assert.ok(text.includes('L2000| process finished with exit code 1'), 'the tail survives into the receipt');
  const receiptHandle = handleOf(text);
  const reread = await tool.execute({ op: 'read', handle: receiptHandle, from: 500, to: 500 }, exec);
  assert.ok(reread.text.includes(`L500| ${bigLines[499]}`), 'receipt anchors resolve to the same bytes');
}

// ---------------------------------------------------------------- 7. failure paths stay open
{
  const broken = await feed([{ type: 'text', text: bigText }], { ...exec, callId: 'call-3' });
  assert.equal(handleOf(asText(broken)), handle, 'repeated packing keeps pointing at the same archive');
}

await rm(home, { recursive: true, force: true });
console.log('solpack smoke test: OK');