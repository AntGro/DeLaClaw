// Scene script parsing for role-based text revision (Memory tab).
// Pure module — no imports, no DOM.
//
// Block grammar (everything between < and > is one block):
//   <SPEAKER: ...> or <SPEAKER. ...>  → dialogue block; one block is one
//     unit, inner newlines are rendered inside it. For several units,
//     write several <SPEAKER:> entries.
//   <**...**>                          → direction block (checked FIRST, so a
//                                        direction containing "NAME:" is never
//                                        mistaken for a dialogue block)
// Inline **...** inside dialogue → direction span (rendered dimmed, part of
// the learned line, never scored separately).
// Lines outside <...> blocks are ignored here; callers treat them as
// directions or flag them in the parse preview.

// Speaker cues are matched case-insensitively (accents, digits, spaces,
// hyphens, apostrophes). The angle-bracket block format already marks the
// line as structured, so uppercase is a convention, not a requirement.
// Display keeps the name as written; identity compares case-insensitively.
const SPEAKER_RE = /^([A-ZÀ-Þ][A-ZÀ-Þ0-9'’\- ]*?)\s*[:.]\s*/i;

// Speaker identity for matching focus_role etc. Null-safe, trimmed,
// Unicode-normalized (NFC) and case-insensitive, so names pasted from
// different sources still match.
export function sceneSpeakersEqual(a, b) {
  const norm = s => (s || '').trim().normalize('NFC').toLowerCase();
  return norm(a) === norm(b);
}

// text_line_progress is valid only for an unchanged
// (content, blocks_per_chunk, focus_role) tuple: any change to the chunking
// inputs orphans the stored FSRS state, so progress must be dropped and
// regenerated. Pure — unit-tested.
export function isTextChunkingStale(tx, { content, blocks_per_chunk, focus_role }) {
  if (!tx) return false;
  if ((tx.content || '') !== (content || '')) return true;
  if ((tx.blocks_per_chunk || 4) !== (blocks_per_chunk || 4)) return true;
  return !sceneSpeakersEqual(tx.focus_role, focus_role);
}

// Revert every updated field to its pre-edit value. Never throws: a
// failed rollback is reported, not propagated.
async function rollbackTextEdit(db, id, tx, updates) {
  try {
    const rollback = {};
    for (const k of Object.keys(updates)) rollback[k] = tx[k];
    const { error } = await db.from('texts').update(rollback).eq('id', id);
    return !error;
  } catch {
    return false;
  }
}

// Persist a text edit: update the row, then drop chunk progress when any
// chunking input changed so auto-repair regenerates it. Checks both
// mutations for adapter errors ({ data, error } shape) and converts thrown
// errors into { ok: false }: a failed text update never triggers progress
// deletion, and a failed deletion — whether returned as { error } or
// thrown — rolls the text back to its pre-edit values so progress still
// matches content (a failed delete must not leave the tuple split).
// Takes db as a parameter for testability.
export async function persistTextEdit(db, id, tx, updates, newChunking) {
  try {
    const { error: updateError } = await db.from('texts').update(updates).eq('id', id);
    if (updateError) return { ok: false, error: updateError, rolledBack: false };
    if (isTextChunkingStale(tx, newChunking)) {
      let deleteError = null;
      try {
        ({ error: deleteError } = await db.from('text_line_progress').delete().eq('text_id', id));
      } catch (error) {
        deleteError = error;
      }
      if (deleteError) {
        const rolledBack = await rollbackTextEdit(db, id, tx, updates);
        return { ok: false, error: deleteError, rolledBack };
      }
    }
    return { ok: true, error: null, rolledBack: false };
  } catch (error) {
    return { ok: false, error, rolledBack: false };
  }
}

// Role → color class map for the revision overlay. The revised role keeps a
// reserved class; other roles cycle through the palette in first-appearance
// order (colors repeat when roles outnumber palette entries). Keys are
// lowercase speaker names; classes color the name header only, never the lines.
export const ROLE_PALETTE_SIZE = 6;
export function buildRoleColorMap(speakers, focusRole) {
  const map = new Map();
  let ci = 0;
  for (const sp of speakers || []) {
    const key = (sp || '').toLowerCase();
    if (!key || map.has(key)) continue;
    map.set(key, sceneSpeakersEqual(sp, focusRole) ? 'tr-role-mine' : `tr-role-c${ci++ % ROLE_PALETTE_SIZE}`);
  }
  return map;
}

// Leading auto-reveal count: the number of lines before the first line of
// the revised role. Leading cues/directions are revealed automatically so
// the rehearsal starts at the first line to recall. 0 when the chunk opens
// with the role's line (or has none).
export function leadingRevealCount(kinds) {
  const idx = kinds.findIndex(k => k === 'mine');
  return idx > 0 ? idx : 0;
}

// Trailing auto-reveal count: the number of consecutive lines after index
// `idx` that are NOT the revised role's ('cue' / 'dir'). When the user
// reveals one of their own lines, these following lines are revealed
// automatically with it — they are never practised, so making the user tap
// through them one by one only slows the rehearsal. The run stops at the
// next own line (which stays masked, to be recalled) — consecutive blocks
// of other roles, even the same role several blocks in a row, all count.
export function trailingRevealCount(kinds, idx) {
  let n = 0;
  for (let i = idx + 1; i < kinds.length && kinds[i] !== 'mine'; i++) n++;
  return n;
}

// Group consecutive lines by speaker (case-insensitive) for book-like layout:
// the speaker's name is shown once above the group, outside the line boxes,
// instead of repeated on every line. Direction lines (speaker null) group
// together. Returns [{ speaker, lines }]; callers keep their own line index.
export function groupLinesBySpeaker(lines) {
  const groups = [];
  for (const ln of lines) {
    const last = groups[groups.length - 1];
    if (last && sceneSpeakersEqual(last.speaker, ln.speaker)) {
      last.lines.push(ln);
    } else {
      groups.push({ speaker: ln.speaker, lines: [ln] });
    }
  }
  return groups;
}
const BLOCK_RE = /<([\s\S]*?)>/g;
const INLINE_DIR_RE = /\*\*([\s\S]*?)\*\*/g;

// Split a line's text into plain/direction segments.
export function parseInlineDirs(text) {
  const segs = [];
  let last = 0;
  INLINE_DIR_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_DIR_RE.exec(text)) !== null) {
    if (m.index > last) segs.push({ kind: 'text', text: text.slice(last, m.index) });
    segs.push({ kind: 'dir', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ kind: 'text', text: text.slice(last) });
  if (segs.length === 0) segs.push({ kind: 'text', text });
  return segs;
}

// Parse scene content into flat content lines:
//   { speaker: string|null, segments: [{kind, text}], unparsed: bool }
// plus the speaker list (first-appearance order) and unparsed-block warnings.
export function parseSceneContent(content) {
  const lines = [];
  const speakers = [];
  const seen = new Set();
  let unparsedBlocks = 0;
  BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_RE.exec(content)) !== null) {
    const body = m[1].trim().normalize('NFC');
    const edgeNewlines = t => t.replace(/^\n+/, '').replace(/\n+$/, '');
    if (body.length > 4 && body.startsWith('**') && body.endsWith('**')) {
      // Direction block — the ** wrapper is mandatory so that a direction
      // containing "SOME_NOUN:" is never read as a dialogue block.
      lines.push({ speaker: null, segments: parseInlineDirs(edgeNewlines(body.slice(2, -2))), unparsed: false });
      continue;
    }
    const sp = body.match(SPEAKER_RE);
    if (sp) {
      const speaker = sp[1].trim();
      const key = speaker.toLowerCase();
      if (!seen.has(key)) { seen.add(key); speakers.push(speaker); }
      // One block is one unit: inner newlines stay inside it. Splitting
      // into several units is done with several <SPEAKER:> entries.
      lines.push({ speaker, segments: parseInlineDirs(edgeNewlines(body.slice(sp[0].length))), unparsed: false });
    } else {
      unparsedBlocks++;
      lines.push({ speaker: null, segments: parseInlineDirs(edgeNewlines(body)), unparsed: true });
    }
  }
  return { lines, speakers, unparsedBlocks, blockCount: seen.size };
}

// Plain text of a parsed line (markers stripped), for bullets/context.
export function sceneLineText(line) {
  return line.segments.map(s => s.text).join('');
}

// Block text of a parsed line, with inline directions re-wrapped in
// **...** so it round-trips through parseSceneContent: editing a scene
// chunk edits this text per block, never the speaker or the block wrapper.
export function sceneBlockText(line) {
  return line.segments.map(s => (s.kind === 'dir' ? `**${s.text}**` : s.text)).join('');
}

// Rebuild one raw <...> block from a parsed line and its edited text.
// Speaker and direction wrappers are preserved, so an edit can reword a
// block but never change which block it is.
export function sceneBlockRaw(line, text) {
  if (line.unparsed) return `<${text}>`;
  if (line.speaker) return `<${line.speaker}: ${text}>`;
  return `<**${text}**>`;
}

// Plain-text chunking, mirroring splitSceneIntoChunks: only non-empty
// lines count toward the chunk size. Single source of truth for both
// modes — flashcards.js imports this instead of keeping its own copy.
export function splitTextIntoChunks(content, linesPerChunk) {
  const lines = (content || '').split('\n');
  const chunks = [];
  let currentChunk = [];
  let nonEmptyCount = 0;
  for (let i = 0; i < lines.length; i++) {
    currentChunk.push(lines[i]);
    if (lines[i].trim() !== '') nonEmptyCount++;
    if (nonEmptyCount >= linesPerChunk) {
      chunks.push(currentChunk.join('\n'));
      currentChunk = [];
      nonEmptyCount = 0;
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk.join('\n'));
  return chunks;
}

// Unified chunk access: scene texts (focus_role set) chunk parsed content
// lines; plain texts chunk raw lines as before. Chunk indexes stay aligned
// with text_line_progress rows in both modes.
export function getTextChunks(tx) {
  const perChunk = tx.blocks_per_chunk || 4;
  if (tx.focus_role) {
    return splitSceneIntoChunks(parseSceneContent(tx.content || '').lines, perChunk);
  }
  return splitTextIntoChunks(tx.content || '', perChunk);
}

// Same calendar day in the viewer's local timezone (not the UTC date of
// the stored ISO timestamp): a review at 00:30 London time is still
// "today" even though its UTC date may already be tomorrow, and vice
// versa in summer time.
export function isSameLocalDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

// Due in the same sense as every picker and the progress bar: never
// reviewed, or no next review, or the next review is now or past.
export function isChunkDue(chunk, now = new Date()) {
  if (!chunk) return false;
  if (!chunk.last_review) return true;
  if (!chunk.next_review) return true;
  return new Date(chunk.next_review) <= now;
}

// Revise mode for a targeted chunk: due/new chunks get the normal FSRS
// update on submit; anything not due (including a chunk already revised
// today) revises in practice mode — no FSRS write, no DB write.
export function chunkReviseMode(chunk, now = new Date()) {
  return isChunkDue(chunk, now) ? 'fsrs' : 'practice';
}

function chunkLinesEqual(a, b) {
  return a.speaker === b.speaker && a.unparsed === b.unparsed
    && JSON.stringify(a.segments) === JSON.stringify(b.segments);
}

// Line ranges (start inclusive, end exclusive) of each plain-text chunk,
// using the same grouping as splitTextIntoChunks.
function plainChunkRanges(lines, linesPerChunk) {
  const ranges = [];
  let start = 0;
  let nonEmptyCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') nonEmptyCount++;
    if (nonEmptyCount >= linesPerChunk) {
      ranges.push({ start, end: i + 1 });
      start = i + 1;
      nonEmptyCount = 0;
    }
  }
  if (start < lines.length) ranges.push({ start, end: lines.length });
  return ranges;
}

// Apply a chunk edit without touching any other chunk's alignment.
// Plain texts: `edited` is the chunk's new text (one textarea).
// Scene texts: `edited` is one string per block in the chunk (one textarea
// per block), spliced block-by-block so text between blocks is preserved.
// The edit is refused ({ ok: false }) when re-chunking would move any
// other chunk — e.g. adding/removing a line, or blanking a counted line —
// because that would orphan the other chunks' FSRS rows. A no-op edit
// returns changed: false so the caller can skip the reset entirely.
export function applyChunkEdit(tx, chunkIndex, edited) {
  if (!tx || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return { ok: false, reason: 'out_of_range' };
  }
  const perChunk = tx.blocks_per_chunk || 4;
  const oldChunks = getTextChunks(tx);
  if (chunkIndex >= oldChunks.length) return { ok: false, reason: 'out_of_range' };

  if (!tx.focus_role) {
    const lines = (tx.content || '').split('\n');
    const range = plainChunkRanges(lines, perChunk)[chunkIndex];
    if (!range) return { ok: false, reason: 'out_of_range' };
    const editedLines = String(edited).split('\n');
    const newContent = [...lines.slice(0, range.start), ...editedLines, ...lines.slice(range.end)].join('\n');
    const newChunks = splitTextIntoChunks(newContent, perChunk);
    if (newChunks.length !== oldChunks.length) return { ok: false, reason: 'boundary_shift' };
    for (let i = 0; i < newChunks.length; i++) {
      if (i !== chunkIndex && newChunks[i] !== oldChunks[i]) return { ok: false, reason: 'boundary_shift' };
    }
    return { ok: true, content: newContent, changed: newContent !== (tx.content || '') };
  }

  const parsed = parseSceneContent(tx.content || '');
  const oldSceneChunks = splitSceneIntoChunks(parsed.lines, perChunk);
  const chunkLines = oldSceneChunks[chunkIndex];
  if (!chunkLines) return { ok: false, reason: 'out_of_range' };
  if (!Array.isArray(edited) || edited.length !== chunkLines.length) {
    return { ok: false, reason: 'block_count' };
  }
  BLOCK_RE.lastIndex = 0;
  const matches = [];
  let m;
  while ((m = BLOCK_RE.exec(tx.content || '')) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  if (matches.length !== parsed.lines.length) return { ok: false, reason: 'parse_mismatch' };
  const offset = oldSceneChunks.slice(0, chunkIndex).reduce((n, c) => n + c.length, 0);
  let newContent = tx.content || '';
  for (let i = chunkLines.length - 1; i >= 0; i--) {
    const match = matches[offset + i];
    const raw = sceneBlockRaw(chunkLines[i], edited[i]);
    newContent = newContent.slice(0, match.start) + raw + newContent.slice(match.end);
  }
  const newParsed = parseSceneContent(newContent);
  const newSceneChunks = splitSceneIntoChunks(newParsed.lines, perChunk);
  if (newSceneChunks.length !== oldSceneChunks.length) return { ok: false, reason: 'boundary_shift' };
  for (let i = 0; i < newSceneChunks.length; i++) {
    if (i === chunkIndex) continue;
    if (newSceneChunks[i].length !== oldSceneChunks[i].length) return { ok: false, reason: 'boundary_shift' };
    for (let j = 0; j < newSceneChunks[i].length; j++) {
      if (!chunkLinesEqual(newSceneChunks[i][j], oldSceneChunks[i][j])) {
        return { ok: false, reason: 'boundary_shift' };
      }
    }
  }
  return { ok: true, content: newContent, changed: newContent !== (tx.content || '') };
}

// Chunk parsed scene lines (one block = one line), mirroring
// splitTextIntoChunks: only non-empty content lines count toward the chunk size.
export function splitSceneIntoChunks(lines, linesPerChunk) {
  const chunks = [];
  let currentChunk = [];
  let nonEmptyCount = 0;
  for (const line of lines) {
    currentChunk.push(line);
    if (sceneLineText(line).trim() !== '') nonEmptyCount++;
    if (nonEmptyCount >= linesPerChunk) {
      chunks.push(currentChunk);
      currentChunk = [];
      nonEmptyCount = 0;
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}
