// Scene script parsing for role-based text revision (Memory tab).
// Pure module — no imports, no DOM.
//
// Block grammar (everything between < and > is one block):
//   <SPEAKER: ...> or <SPEAKER. ...>  → dialogue block, may span lines
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
const SPEAKER_RE = /^([A-ZÀ-Þ][A-ZÀ-Þ0-9'’\- ]+?)\s*[:.]\s*/i;

// Speaker identity for matching focus_role etc. Null-safe.
export function sceneSpeakersEqual(a, b) {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
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
    const body = m[1].trim();
    if (body.length > 4 && body.startsWith('**') && body.endsWith('**')) {
      // Direction block — the ** wrapper is mandatory so that a direction
      // containing "SOME_NOUN:" is never read as a dialogue block.
      for (const ln of body.slice(2, -2).split('\n')) {
        lines.push({ speaker: null, segments: parseInlineDirs(ln), unparsed: false });
      }
      continue;
    }
    const sp = body.match(SPEAKER_RE);
    if (sp) {
      const speaker = sp[1].trim();
      const key = speaker.toLowerCase();
      if (!seen.has(key)) { seen.add(key); speakers.push(speaker); }
      for (const ln of body.slice(sp[0].length).split('\n')) {
        lines.push({ speaker, segments: parseInlineDirs(ln), unparsed: false });
      }
    } else {
      unparsedBlocks++;
      for (const ln of body.split('\n')) {
        lines.push({ speaker: null, segments: parseInlineDirs(ln), unparsed: true });
      }
    }
  }
  return { lines, speakers, unparsedBlocks, blockCount: seen.size };
}

// Plain text of a parsed line (markers stripped), for bullets/context.
export function sceneLineText(line) {
  return line.segments.map(s => s.text).join('');
}

// Chunk parsed scene lines, mirroring splitTextIntoChunks: only non-empty
// content lines count toward the chunk size.
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
