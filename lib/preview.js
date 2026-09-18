/**
 * Bounded previews and evidence receipts.
 *
 * Two mechanisms live here, both pure (no I/O):
 *  - `headTailPreview`: the lean replacement for an oversized result.
 *  - `buildReceipt`: a deterministic "receipt" that keeps the head, the tail and
 *    every signal line (errors, exit codes, ...) while dropping the middle.
 *
 * Unlike SoL-Pi's reducer, this one never calls a model: no log content leaves
 * the machine, and the result is reproducible. `verifyReceipt` is the evidence
 * invariant — every retained line is re-read from the archive and compared
 * byte-for-byte before the receipt is allowed to replace the original.
 */
import { displayLine } from './store.js';

/** Footer marker of a receipt, used to skip re-packing our own output. */
export const PACK_MARKER = '[solpack';

/** Human byte count. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/** Flatten tool content to one string, or `undefined` when any block is not text. */
export function flattenPlainText(content) {
  if (!Array.isArray(content)) return undefined;
  let text = '';
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return undefined;
    text += block.text;
  }
  return text;
}

/** Cut `bytes` down to a UTF-8 boundary: back off from a prefix, advance into a suffix. */
function prefixBoundary(buffer, end) {
  let cut = end;
  while (cut > 0 && cut < buffer.length && (buffer[cut] & 0xc0) === 0x80) cut -= 1;
  return cut;
}
function suffixBoundary(buffer, start) {
  let cut = start;
  while (cut < buffer.length && (buffer[cut] & 0xc0) === 0x80) cut += 1;
  return cut;
}

/**
 * Byte-budgeted head/tail preview that never splits a codepoint.
 * @returns `{ text, omittedBytes }`; `text` is the raw result when it already fits.
 */
export function headTailPreview(text, headBytes, tailBytes) {
  const buffer = Buffer.from(text, 'utf8');
  const total = buffer.length;
  const head = prefixBoundary(buffer, Math.max(0, Math.min(headBytes, total)));
  let tailStart = Math.max(head, total - Math.max(0, tailBytes));
  tailStart = suffixBoundary(buffer, tailStart);
  const kept = head + (total - tailStart);
  if (kept >= total) return { text, omittedBytes: 0 };
  const headText = buffer.subarray(0, head).toString('utf8');
  const tailText = buffer.subarray(tailStart).toString('utf8');
  const omittedBytes = total - kept;
  const parts = [];
  if (headText.length > 0) parts.push(headText);
  parts.push(`\u2026 [${formatBytes(omittedBytes)} omitted] \u2026`);
  if (tailText.length > 0) parts.push(tailText);
  return { text: parts.join('\n\n'), omittedBytes };
}

/** The compact recall hint spliced into every packed result. */
export function recallHint(handle, toolName, cfg) {
  return [
    `${PACK_MARKER}] oversized ${toolName} result archived verbatim - only a bounded slice is inlined.`,
    `handle: ${handle}`,
    `recall: {"op":"read","handle":"${handle}","from":1,"to":${cfg.defaultReadLines}}`,
    `        {"op":"grep","handle":"${handle}","pattern":"error|fail","context":2}`,
    `        {"op":"stat","handle":"${handle}"}   {"op":"list"}`,
  ].join('\n');
}

/**
 * Replacement content for one packed result (head/tail preview + handle).
 * @returns the notice text and the preview it embedded.
 */
export function buildPackNotice({ handle, toolName, bytes, lines, text, cfg }) {
  const head = Math.ceil(cfg.previewBytes / 2);
  const tail = Math.floor(cfg.previewBytes / 2);
  const preview = headTailPreview(text, head, tail);
  const header = `${recallHint(handle, toolName, cfg)}\nsize: ${lines} lines / ${formatBytes(bytes)}${
    preview.omittedBytes > 0 ? ` (${formatBytes(preview.omittedBytes)} omitted)` : ''
  }`;
  return { text: `${header}\n--- preview ---\n${preview.text}`, preview };
}

/** Parse the signal pattern, tolerating a bad user pattern. */
export function signalRegex(pattern) {
  try {
    return new RegExp(pattern, 'im');
  } catch {
    return null;
  }
}

/**
 * Build the deterministic evidence receipt for a very large result.
 * @returns `{ text, anchors, stats }`; `anchors` is every retained line, which
 *   `verifyReceipt` must find byte-identical in the archive.
 */
export function buildReceipt({ handle, toolName, bytes, text, cfg }) {
  const rawLines = text.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map(displayLine);
  const total = lines.length;
  const headCount = Math.min(cfg.receiptHeadLines, total);
  const tailCount = Math.min(cfg.receiptTailLines, Math.max(0, total - headCount));
  const headEnd = headCount;
  const tailStart = total - tailCount + 1;
  const taken = new Set();
  const anchors = [];
  const sections = [];

  const push = (section, number, value) => {
    if (taken.has(number)) return false;
    taken.add(number);
    anchors.push({ line: number, text: value });
    section.push(`L${number}| ${value}`);
    return true;
  };

  const headLines = [];
  for (let n = 1; n <= headEnd; n++) push(headLines, n, lines[n - 1]);
  if (headLines.length > 0) sections.push({ title: `head L1-L${headEnd}`, body: headLines });

  const re = signalRegex(cfg.signalPattern);
  const signalLines = [];
  let signalSeen = 0;
  if (re && cfg.receiptSignalLines > 0) {
    for (let n = headEnd + 1; n < tailStart; n++) {
      if (!re.test(lines[n - 1])) continue;
      if (signalSeen >= cfg.receiptSignalLines) break;
      if (push(signalLines, n, lines[n - 1])) signalSeen += 1;
    }
  }
  if (signalLines.length > 0) {
    sections.push({ title: `signals (${signalLines.length} exact anchors)`, body: signalLines });
  }

  const tailLines = [];
  for (let n = Math.max(1, tailStart); n <= total; n++) push(tailLines, n, lines[n - 1]);
  if (tailLines.length > 0) sections.push({ title: `tail L${Math.max(1, tailStart)}-L${total}`, body: tailLines });

  const stats = {
    total,
    kept: anchors.length,
    droppedLines: total - anchors.length,
    droppedBytes: 0,
    signals: signalLines.length,
  };
  const keptText = anchors.map((a) => a.text).join('\n');
  stats.droppedBytes = Math.max(0, bytes - Buffer.byteLength(keptText, 'utf8'));

  const header = [
    recallHint(handle, toolName, cfg),
    `receipt: ${total} lines / ${formatBytes(bytes)} - kept ${stats.kept} lines (${formatBytes(
      Buffer.byteLength(keptText, 'utf8'),
    )}), dropped ${formatBytes(stats.droppedBytes)}, ${stats.signals} signal anchors`,
    'every line below is byte-identical to the archived original (verified before use)',
  ].join('\n');
  const body = sections.map((s) => `--- ${s.title} ---\n${s.body.join('\n')}`).join('\n');
  // `handle` rides along so `verifyReceipt` can re-read the archive it must match.
  return { handle, text: `${header}\n${body}`, anchors, stats };
}

/** Merge anchor line numbers into the fewest contiguous reads. */
export function anchorRanges(anchors, gap = 8) {
  const numbers = [...new Set(anchors.map((a) => a.line))].sort((a, b) => a - b);
  const ranges = [];
  for (const n of numbers) {
    const last = ranges[ranges.length - 1];
    if (last && n - last.to <= gap) last.to = n;
    else ranges.push({ from: n, to: n });
  }
  return ranges;
}

/**
 * Evidence invariant: re-read every retained line from the archive and require
 * an exact match. Any mismatch (or read error) means the receipt must NOT be used.
 */
export async function verifyReceipt(receipt, store, session) {
  const byNumber = new Map(receipt.anchors.map((a) => [a.line, a.text]));
  for (const range of anchorRanges(receipt.anchors)) {
    let chunk;
    try {
      chunk = await store.readLines(session, receipt.handle, range.from, range.to);
    } catch {
      return false;
    }
    for (let i = 0; i < chunk.lines.length; i++) {
      const number = range.from + i;
      if (byNumber.get(number) !== chunk.lines[i]) return false;
    }
  }
  return true;
}