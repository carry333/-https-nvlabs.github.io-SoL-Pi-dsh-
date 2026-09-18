/**
 * Session-scoped, content-addressed archive for oversized tool results.
 *
 * Layout (under the dsh home, never inside the user's project):
 *   <dsh-home>/solpack/<session>/objects/<ab>/obs-<10hex>.txt   archived text, byte-exact
 *   <dsh-home>/solpack/<session>/index.jsonl                    append-only ledger
 *
 * A handle is derived from the content digest, so identical results reuse the
 * same handle (SoL-Pi's "repeated large text results become stable handles")
 * and the archive never grows twice for the same bytes.
 */
import { createHash } from 'node:crypto';
import { promises as fsp, createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';

/** Model-facing handle shape. */
export const HANDLE_RE = /^obs-[0-9a-f]{8,64}$/;

/** Digest one text exactly as it will be archived (UTF-8). */
export function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable handle for a content digest. */
export function handleFor(hash) {
  return `obs-${hash.slice(0, 10)}`;
}

/** Resolve the dsh home the same way the harness does (`$DSH_HOME`, else `~/.dsh`). */
export function resolveHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (!configured) return path.join(os.homedir(), '.dsh');
  return path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()));
}

/** One safe path segment for a session id that may contain separator characters. */
export function safeSegment(value) {
  const cleaned = String(value ?? '_unknown').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : '_unknown';
}

/** Strip a trailing CR/LF from one raw line (display form used everywhere). */
export function displayLine(raw) {
  return raw.replace(/\r?\n$/, '').replace(/\r$/, '');
}

/** Count lines the same way `readLines` pages them. */
export function countLines(text) {
  if (text.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.endsWith('\n') ? lines : lines + 1;
}

/**
 * Create the archive store.
 * @param cfg - normalized solpack config.
 * @param logger - optional `ctx.logger`-shaped sink.
 */
export function createStore(cfg, logger) {
  const root = path.join(resolveHome(), 'solpack');
  /** @type {Map<string, object>} handle metadata, keyed `${session}|${handle}` */
  const meta = new Map();
  /** @type {Map<string, {size: number, offsets: number[]}>} lazily built line index */
  const lineIndex = new Map();
  /** @type {Set<string>} sessions whose ledger has been loaded */
  const loaded = new Set();
  /** @type {number|null} cached archive size for the session budget */
  let archiveBytes = null;

  const sessionRoot = (session) => path.join(root, safeSegment(session));
  const objectFile = (session, handle) =>
    path.join(sessionRoot(session), 'objects', handle.slice(4, 6), `${handle}.txt`);
  const ledgerFile = (session) => path.join(sessionRoot(session), 'index.jsonl');
  const key = (session, handle) => `${safeSegment(session)}|${handle}`;

  async function appendLedger(session, record) {
    try {
      await fsp.mkdir(sessionRoot(session), { recursive: true });
      await fsp.appendFile(ledgerFile(session), `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      // The ledger is an index, not the evidence: never fail a call over it.
      logger?.warn?.(`solpack: ledger append failed: ${String(error)}`);
    }
  }

  async function loadLedger(session) {
    const sk = safeSegment(session);
    if (loaded.has(sk)) return;
    loaded.add(sk);
    let raw;
    try {
      raw = await fsp.readFile(ledgerFile(session), 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || typeof record.handle !== 'string') continue;
      const k = key(session, record.handle);
      const previous = meta.get(k);
      if (!previous || (record.kind === 'put' && previous.kind !== 'put')) meta.set(k, record);
      else if (previous) previous.hits = (previous.hits ?? 0) + 1;
    }
  }

  async function sessionBytes(session) {
    let total = 0;
    const stack = [sessionRoot(session)];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          try {
            total += (await fsp.stat(full)).size;
          } catch {
            /* raced away */
          }
        }
      }
    }
    return total;
  }

  /**
   * Archive `text` and return its handle.
   * @returns the handle record, or `null` when the archive budget is exhausted
   *   (the caller then keeps the original inline result untouched).
   */
  async function put({ session, text, toolName, callId, label }) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (archiveBytes === null) archiveBytes = await sessionBytes(session);
    const hash = digest(text);
    const handle = handleFor(hash);
    const file = objectFile(session, handle);
    const lines = countLines(text);
    const record = {
      kind: 'put',
      handle,
      hash,
      bytes,
      lines,
      toolName: typeof toolName === 'string' ? toolName : 'unknown',
      callId: typeof callId === 'string' ? callId : undefined,
      label: typeof label === 'string' ? label : 'result',
      created: new Date().toISOString(),
    };
    let reused = true;
    try {
      await fsp.stat(file);
    } catch {
      reused = false;
    }
    if (!reused) {
      if (archiveBytes + bytes > cfg.maxArchiveBytes) {
        logger?.warn?.(`solpack: archive budget reached for session ${session}; keeping the inline result`);
        return null;
      }
      const dir = path.dirname(file);
      await fsp.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${process.pid}.${Date.now()}.tmp`);
      await fsp.writeFile(tmp, text, 'utf8');
      await fsp.rename(tmp, file);
      archiveBytes += bytes;
      lineIndex.delete(key(session, handle));
    }
    await loadLedger(session);
    const k = key(session, handle);
    if (reused) {
      const previous = meta.get(k);
      meta.set(k, { ...(previous ?? record), hits: (previous?.hits ?? 0) + 1 });
    } else {
      meta.set(k, record);
    }
    await appendLedger(session, reused ? { ...record, kind: 'hit' } : record);
    return { ...record, reused, file };
  }

  /** Byte offsets of every line start; cached per archived object. */
  async function offsetsOf(session, handle) {
    const file = objectFile(session, handle);
    const stat = await fsp.stat(file);
    const k = key(session, handle);
    const cached = lineIndex.get(k);
    if (cached && cached.size === stat.size) return cached.offsets;
    const offsets = [0];
    const handleFh = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(1 << 20);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handleFh.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) break;
        for (let i = 0; i < bytesRead; i++) {
          if (buffer[i] === 10) offsets.push(position + i + 1);
        }
        position += bytesRead;
      }
    } finally {
      await handleFh.close();
    }
    if (offsets.length > 1 && offsets[offsets.length - 1] === stat.size) offsets.pop();
    lineIndex.set(k, { size: stat.size, offsets });
    return offsets;
  }

  /** Read an exact line window (`from`/`to` are 1-based and inclusive). */
  async function readLines(session, handle, from, to) {
    const file = objectFile(session, handle);
    const stat = await fsp.stat(file);
    const offsets = await offsetsOf(session, handle);
    const total = offsets.length;
    const start = Math.max(1, Math.min(total, Number.isFinite(from) ? Math.trunc(from) : 1));
    const end = Math.max(start, Math.min(total, Number.isFinite(to) ? Math.trunc(to) : total));
    const byteStart = offsets[start - 1];
    const byteEnd = end < total ? offsets[end] : stat.size;
    const length = Math.max(0, byteEnd - byteStart);
    const buffer = Buffer.allocUnsafe(length);
    const fh = await fsp.open(file, 'r');
    let read = 0;
    try {
      while (read < length) {
        const { bytesRead } = await fh.read(buffer, read, length - read, byteStart + read);
        if (bytesRead <= 0) break;
        read += bytesRead;
      }
    } finally {
      await fh.close();
    }
    const text = buffer.subarray(0, read).toString('utf8');
    const lines = text.length === 0 ? [] : text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return { lines: lines.map(displayLine), start, end, total };
  }

  /** Grep archived text; matches are exact archived lines plus their line numbers. */
  async function grepLines(session, handle, pattern, { limit = 50, context = 0 } = {}) {
    const file = objectFile(session, handle);
    let test;
    try {
      const re = new RegExp(pattern, 'i');
      test = (line) => re.test(line);
    } catch {
      const needle = String(pattern).toLowerCase();
      test = (line) => line.toLowerCase().includes(needle);
    }
    const matches = [];
    const before = [];
    let lineNo = 0;
    let truncated = false;
    const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    try {
      for await (const raw of rl) {
        lineNo += 1;
        const line = displayLine(raw);
        if (test(line)) {
          if (matches.length >= limit) {
            truncated = true;
            break;
          }
          const entry = { line: lineNo, text: line, before: context > 0 ? before.slice(-context) : undefined, after: [] };
          matches.push(entry);
        } else if (context > 0) {
          before.push({ line: lineNo, text: line });
          if (before.length > context) before.shift();
          const last = matches[matches.length - 1];
          if (last && lineNo - last.line <= context) last.after.push({ line: lineNo, text: line });
        }
      }
    } finally {
      rl.close();
    }
    return { matches, truncated, total: lineNo };
  }

  /** Metadata for one handle (ledger first, filesystem as the fallback). */
  async function stat(session, handle) {
    await loadLedger(session);
    const k = key(session, handle);
    const record = meta.get(k);
    if (record) return record;
    const file = objectFile(session, handle);
    const info = await fsp.stat(file);
    return {
      kind: 'put',
      handle,
      bytes: info.size,
      lines: (await offsetsOf(session, handle)).length,
      toolName: 'unknown',
      created: info.mtime.toISOString(),
      recovered: true,
    };
  }

  /** Newest handles of one session (this is what `op: "list"` returns). */
  async function list(session, limit = 20) {
    await loadLedger(session);
    const prefix = `${safeSegment(session)}|`;
    const records = [...meta.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v)
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
    return records.slice(0, Math.max(1, limit));
  }

  return {
    root,
    objectFile,
    put,
    readLines,
    grepLines,
    stat,
    list,
    countLines,
  };
}