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
