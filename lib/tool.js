/**
 * The `solpack` recall tool: the only new model-facing surface the plugin adds.
 *
 * One tool with an `op` discriminator instead of four tools, so the schema cost
 * stays flat (SoL-Pi's "design the core surface around a few actions"). Every
 * read is served from the archived original, so recall is exact rather than a
 * re-summary, and every reply is byte-bounded so recall cannot re-flood context.
 */
import { HANDLE_RE } from './store.js';
import { formatBytes } from './preview.js';

const OPERATIONS = ['read', 'grep', 'list', 'stat'];

const DESCRIPTION = [
  'Recall the exact archived text of an oversized tool result that was replaced by a "[solpack]" notice.',
  'read: byte-exact line window of one handle (from/to are 1-based, inclusive).',
  'grep: exact archived lines matching a regular expression, with line numbers.',
  'stat: size/line/tool metadata for one handle. list: newest handles in this session.',
  'Prefer this over re-running the original command: the archive holds the full original output verbatim.',
].join(' ');

const text = (value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }];

/**
 * @param store - archive store from `createStore`.
 * @param cfg - normalized solpack config.
 * @param logger - optional `ctx.logger`-shaped sink.
 * @returns a registry-ready `ToolDefinition` (hand-built: no dsh import required).
 */
export function createRecallTool({ store, cfg, logger }) {
  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      op: { type: 'string', enum: OPERATIONS, description: 'Operation to perform.' },
      handle: { type: 'string', description: 'Handle from a "[solpack]" notice, e.g. obs-1a2b3c4d5e.' },
      from: { type: 'integer', description: 'First line for op=read (1-based).' },
      to: { type: 'integer', description: 'Last line for op=read (1-based, inclusive).' },
      pattern: { type: 'string', description: 'Regular expression for op=grep (case-insensitive).' },
      context: { type: 'integer', description: 'Context lines around each grep match (default 0).' },
      limit: { type: 'integer', description: 'Max grep matches (default 50) or max list rows (default 20).' },
    },
    required: ['op'],
  };

  const clamp = (value, fallback, min, max) =>
    Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;

  const sessionOf = (exec) => exec?.agent?.session?.header?.id ?? '_unknown';

  async function read(session, handle, from, to) {
    const start = clamp(from, 1, 1, Number.MAX_SAFE_INTEGER);
    const wantLast = clamp(to, start + cfg.defaultReadLines - 1, start, Number.MAX_SAFE_INTEGER);
    const collected = [];
    let bytes = 0;
    let cursor = start;
    let last = start - 1;
    let total = 0;
    while (cursor <= wantLast) {
      const chunk = await store.readLines(session, handle, cursor, Math.min(wantLast, cursor + 199));
      total = chunk.total;
      if (chunk.lines.length === 0) break;
      for (let i = 0; i < chunk.lines.length; i++) {
        const line = chunk.lines[i];
        const size = Buffer.byteLength(line, 'utf8') + 1;
        if (bytes + size > cfg.maxReadBytes) {
          return finish(collected, bytes, start, last, total, 'byte budget reached', true);
        }
        collected.push(line);
        bytes += size;
        last = chunk.start + i;
      }
      cursor = chunk.end + 1;
      if (chunk.end >= chunk.total) break;
    }
    return finish(collected, bytes, start, last, total, '', last < total);
  }

  function finish(lines, bytes, start, last, total, note, more) {
    const head = [
      `lines ${start}-${last} of ${total}`,
      `${formatBytes(bytes)}`,
      note,
      more ? `more: use from=${last + 1}` : 'end of archive',
    ]
      .filter(Boolean)
      .join(' | ');
    const body = lines.map((line, i) => `L${start + i}| ${line}`).join('\n');
    return { text: `${head}\n${body}`, from: start, to: last, total, bytes, more };
  }

  async function execute(args, exec) {
    const session = sessionOf(exec);
    const op = typeof args?.op === 'string' ? args.op : 'read';
    const handle = typeof args?.handle === 'string' ? args.handle.trim() : '';
    try {
      if (op === 'list') {
        const rows = await store.list(session, clamp(args?.limit, 20, 1, 200));
        if (rows.length === 0) return { text: 'solpack: no archived results in this session yet.', rows: [] };
        const body = rows
          .map((r) => `${r.handle}  ${String(r.lines ?? '?').padStart(8)} lines  ${formatBytes(r.bytes ?? 0).padStart(10)}  ${r.toolName ?? '?'}  ${r.created ?? ''}`)
          .join('\n');
        return { text: `solpack archive (${rows.length} of this session)\n${body}`, rows };
      }
      if (!HANDLE_RE.test(handle)) {
        return { text: `solpack: "${handle || '(missing)'}" is not a handle. Copy the handle from a "[solpack]" notice, or run {"op":"list"}.` };
      }
      if (op === 'stat') {
        const info = await store.stat(session, handle);
        return {
          text: `handle=${info.handle} tool=${info.toolName ?? '?'} lines=${info.lines ?? '?'} bytes=${info.bytes ?? '?'} (${formatBytes(info.bytes ?? 0)}) created=${info.created ?? '?'} hits=${info.hits ?? 0}`,
          info,
        };
      }
      if (op === 'grep') {
        const pattern = typeof args?.pattern === 'string' && args.pattern ? args.pattern : '';
        if (!pattern) return { text: 'solpack: op=grep needs "pattern".' };
        const found = await store.grepLines(session, handle, pattern, {
          limit: clamp(args?.limit, 50, 1, 200),
          context: clamp(args?.context, 0, 0, 20),
        });
        if (found.matches.length === 0) {
          return { text: `solpack: no line in ${handle} matches /${pattern}/i (scanned ${found.total} lines).` };
        }
        const body = found.matches
          .map((m) => {
            const before = (m.before ?? []).map((b) => `L${b.line}| ${b.text}`);
            const after = (m.after ?? []).map((a) => `L${a.line}| ${a.text}`);
            return [...before, `L${m.line}| ${m.text}`, ...after].join('\n');
          })
          .join('\n--\n');
        const note = found.truncated ? ' | more matches: narrow the pattern or raise limit' : '';
        return { text: `handle=${handle} matches=${found.matches.length}${note}\n${body}`, matches: found.matches };
      }
      if (op !== 'read') return { text: `solpack: unknown op "${op}" (expected ${OPERATIONS.join('/')}).` };
      const result = await read(session, handle, args?.from, args?.to);
      return { text: `handle=${handle} | ${result.text}`, ...result };
    } catch (error) {
      logger?.warn?.(`solpack: recall failed: ${String(error)}`);
      const missing = error && (error.code === 'ENOENT' || error.code === 'EISDIR');
      return {
        text: missing
          ? `solpack: no archived object for ${handle} in this session (the archive is session-scoped). Use {"op":"list"}.`
          : `solpack: recall failed: ${String(error?.message ?? error)}`,
      };
    }
  }

  return {
    name: cfg.recallToolName,
    description: DESCRIPTION,
    parameters,
    output: { schema: {}, render: (args, value) => text(value) },
    isConcurrencySafe: () => true,
    execute,
  };
}