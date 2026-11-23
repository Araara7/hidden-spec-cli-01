// main.ts is mend, the CLI SPEC.md specifies (version 1). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 of SPEC.md (the command line, the output and exit codes, safe paths,
// format detection, JSON edits and the all-or-nothing write) follow the kit starter; sections 5 to 8
// (three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches) are implemented
// here, as is the `R old -> new` output line for a move edit.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that survived, as (origin, final) pairs, chained so a file moved twice lists once. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(oldP: string, newP: string): void {
    let origin = oldP;
    for (const [o, n] of this.moves) if (n === oldP) origin = o;
    for (let i = this.moves.length - 1; i >= 0; i--) if (this.moves[i]![1] === oldP) this.moves.splice(i, 1);
    if (origin !== newP) this.moves.push([origin, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 3: a file as lines, its line break, and whether it ends with one.
// ---------------------------------------------------------------------------

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { br, lines, final };
}

function serializeFile(fs: FileState): string {
  if (fs.lines.length === 0) return '';
  return fs.lines.join(fs.br) + (fs.final ? fs.br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Every 0-based position where O occurs in lines (O non-empty), at one tier, at or after `from`. */
function occurrencesAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function findTier(lines: string[], O: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(lines, O, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

interface NLine {
  text: string;
  /** Index into O when this line is a context line, else null. */
  ctx: number | null;
}

/**
 * The lines that replace a matched occurrence: a context line is written as the file's own matched
 * line; at tier 2 every other line is re-indented from O's first line's leading whitespace to the
 * file's first matched line's; at tiers 0 and 1 lines are written as they are.
 */
function buildReplacement(fileLines: string[], O: string[], N: NLine[], tier: number, at: number): string[] {
  const out: string[] = [];
  const F = O.length > 0 ? leadWs(fileLines[at] ?? '') : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  for (const n of N) {
    if (n.ctx !== null) {
      out.push(fileLines[at + n.ctx]!);
      continue;
    }
    if (tier === 2 && O.length > 0 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(P)) {
      out.push(F + n.text.slice(P.length));
    } else {
      out.push(n.text);
    }
  }
  return out;
}

/** Split hunk/chunk body entries into O (context + old) and N (context + new, with context mapping). */
function splitON(entries: Array<{ kind: string; text: string }>): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const e of entries) {
    if (e.kind === 'ctx') {
      N.push({ text: e.text, ctx: O.length });
      O.push(e.text);
    } else if (e.kind === 'old') {
      O.push(e.text);
    } else if (e.kind === 'new') {
      N.push({ text: e.text, ctx: null });
    }
  }
  return { O, N };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits (one JSON array, or JSON Lines).
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  /** Old start line number A from the header (1-based). */
  a: number;
  body: Array<{ kind: 'ctx' | 'old' | 'new' | 'bs'; text: string }>;
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinalBreak: boolean;
}

interface UniSection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  creation: boolean;
  deletion: boolean;
  /** The header already consumed its `--- `/`+++ ` pair; another pair starts a new section. */
  hasPair: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: text after four chars, up to the first tab, trimmed; a/ or b/ removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(m[1]!, 10);
  const raw: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const L = lines[j]!;
    if (L.startsWith('diff --git ')) break;
    if (L.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (L.startsWith('@@')) break;
    if (L === '' || L[0] === ' ' || L[0] === '-' || L[0] === '+' || L[0] === '\\') {
      raw.push(L);
      j++;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const body: Hunk['body'] = raw.map((L) => {
    if (L === '') return { kind: 'ctx' as const, text: '' };
    if (L[0] === ' ') return { kind: 'ctx' as const, text: L.slice(1) };
    if (L[0] === '-') return { kind: 'old' as const, text: L.slice(1) };
    if (L[0] === '+') return { kind: 'new' as const, text: L.slice(1) };
    return { kind: 'bs' as const, text: L };
  });
  let noFinalBreak = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
      noFinalBreak = body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { hunk: { a, body, noFinalBreak }, next: j };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, creation: false, deletion: false, hasPair: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (L.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (L.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.hasPair) {
            cur = { oldPath: undefined, newPath: undefined, creation: false, deletion: false, hasPair: false, hunks: [] };
            sections.push(cur);
            continue;
          }
          cur.oldPath = headerPath(L);
          cur.newPath = headerPath(lines[i + 1]!);
          cur.hasPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (L.startsWith('+++ ')) {
        cur.newPath = headerPath(L);
        i++;
        continue;
      }
      if (L.startsWith('rename from ')) {
        cur.oldPath = L.slice(12).trim();
        i++;
        continue;
      }
      if (L.startsWith('rename to ')) {
        cur.newPath = L.slice(10).trim();
        i++;
        continue;
      }
      if (L.startsWith('new file mode')) {
        cur.creation = true;
        i++;
        continue;
      }
      if (L.startsWith('deleted file mode')) {
        cur.deletion = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (L.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = { oldPath: undefined, newPath: undefined, creation: false, deletion: false, hasPair: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one section's hunks to a file's lines; returns the new text. Throws Fail on a bad hunk. */
function applyHunks(fs: FileState, hunks: Hunk[], strict: boolean, path: string): string {
  const lines = [...fs.lines];
  let final = fs.final;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitON(h.body);
    if (O.length > 0) {
      const found = findTier(lines, O, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let at = found.positions[0]!;
      let best = Math.abs(at - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          at = p;
        }
      }
      const runsToEnd = at + O.length === lines.length;
      const repl = buildReplacement(lines, O, N, found.tier, at);
      lines.splice(at, O.length, ...repl);
      if (runsToEnd) final = !h.noFinalBreak;
    } else {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...N.map((n) => n.text));
      if (atEnd) final = !h.noFinalBreak;
    }
    d += N.length - O.length;
  }
  return serializeFile({ br: fs.br, lines, final });
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  let oldPath = s.oldPath;
  let newPath = s.newPath;
  if (oldPath === undefined) oldPath = newPath;
  if (newPath === undefined) newPath = oldPath;
  return (tree) => {
    if (oldPath === null && newPath === null) return;
    // A creation is an old path of /dev/null, or `new file mode`; a deletion a new path of
    // /dev/null, or `deleted file mode`. Creation is tried first.
    const creation = s.creation || oldPath === null;
    const deletion = s.deletion || newPath === null;
    if (creation) {
      if (newPath === null) return;
      const newP = newPath;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noFinalBreak = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const e = h.body[k]!;
          if (e.kind === 'new') {
            plus.push(e.text);
            noFinalBreak = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === 'bs';
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noFinalBreak ? '' : '\n'));
      return;
    }
    if (deletion) {
      if (oldPath === null) return;
      const oldP = oldPath;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const oldP = oldPath as string;
    const newP = newPath as string;
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(parseFile(cur), s.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.recordMove(oldP, newP);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(parseFile(cur), s.hunks, strict, oldP));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevEnd; k--) {
      const L = lines[k]!;
      if (blank(L)) continue;
      if (L.trim().startsWith('```')) continue;
      path = L.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let j = searchLine + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine + 1}`);
      j++;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    const sep = j;
    let k = sep + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine + 1}`);
      k++;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, k);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const fs = parseFile(cur);
    const found = findTier(fs.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const at = found.positions[0]!;
    const repl = buildReplacement(fs.lines, oldLines, newLines.map((t) => ({ text: t, ctx: null })), found.tier, at);
    fs.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(path, serializeFile(fs));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: Array<{ kind: 'ctx' | 'old' | 'new'; text: string }>;
}

interface V4ASection {
  type: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  chunks: V4AChunk[];
  addLines: string[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const raw: Array<{ type: 'add' | 'delete' | 'update'; path: string; line: number; content: Array<{ line: string; idx: number }> }> = [];
  let cur: (typeof raw)[number] | null = null;
  for (let i = first + 1; i < last; i++) {
    const L = lines[i]!;
    if (L.startsWith('*** Add File: ')) {
      cur = { type: 'add', path: L.slice(13).trim(), line: i, content: [] };
      raw.push(cur);
    } else if (L.startsWith('*** Delete File: ')) {
      cur = { type: 'delete', path: L.slice(16).trim(), line: i, content: [] };
      raw.push(cur);
    } else if (L.startsWith('*** Update File: ')) {
      cur = { type: 'update', path: L.slice(16).trim(), line: i, content: [] };
      raw.push(cur);
    } else if (cur === null) {
      if (blank(L)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      cur.content.push({ line: L, idx: i });
    }
  }
  if (raw.length === 0) throw new Exit2('error: parse 1');
  const sections: V4ASection[] = raw.map((r) => {
    const content = [...r.content];
    // Blank lines at the end of a section (empty or only whitespace, section 4) are not part of it.
    while (content.length > 0 && blank(content[content.length - 1]!.line)) content.pop();
    if (r.type === 'add') {
      const addLines: string[] = [];
      for (const c of content) {
        if (c.line === '') addLines.push('');
        else if (c.line.startsWith('+')) addLines.push(c.line.slice(1));
        else throw new Exit2(`error: parse ${c.idx + 1}`);
      }
      return { type: 'add', path: r.path, line: r.line, moveTo: null, chunks: [], addLines };
    }
    if (r.type === 'delete') {
      for (const c of content) {
        if (c.line !== '') throw new Exit2(`error: parse ${c.idx + 1}`);
      }
      return { type: 'delete', path: r.path, line: r.line, moveTo: null, chunks: [], addLines: [] };
    }
    let moveTo: string | null = null;
    let at = 0;
    if (content.length > 0 && content[0]!.line.startsWith('*** Move to: ')) {
      moveTo = content[0]!.line.slice(12).trim();
      at = 1;
    }
    const chunks: V4AChunk[] = [];
    let chunk: V4AChunk | null = null;
    let afterEof = false;
    for (let j = at; j < content.length; j++) {
      const c = content[j]!;
      const L = c.line;
      if (L.startsWith('@@')) {
        if (chunk !== null) chunks.push(chunk);
        chunk = { anchor: L.slice(2).trim(), eof: false, body: [] };
        afterEof = false;
      } else if (L.trim() === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${c.idx + 1}`);
        chunk.eof = true;
        chunks.push(chunk);
        chunk = null;
        afterEof = true;
      } else if (L === '' || L[0] === ' ' || L[0] === '-' || L[0] === '+') {
        if (chunk === null) {
          if (chunks.length === 0 && !afterEof) {
            chunk = { anchor: null, eof: false, body: [] };
          } else {
            throw new Exit2(`error: parse ${c.idx + 1}`);
          }
        }
        if (L === '') chunk.body.push({ kind: 'ctx', text: '' });
        else if (L[0] === ' ') chunk.body.push({ kind: 'ctx', text: L.slice(1) });
        else if (L[0] === '-') chunk.body.push({ kind: 'old', text: L.slice(1) });
        else chunk.body.push({ kind: 'new', text: L.slice(1) });
      } else {
        throw new Exit2(`error: parse ${c.idx + 1}`);
      }
    }
    if (chunk !== null) chunks.push(chunk);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${r.line + 1}`);
    return { type: 'update', path: r.path, line: r.line, moveTo, chunks, addLines: [] };
  });
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: V4ASection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    // Section 10: every path an edit names is checked for safety before anything else about it.
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.type === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.type === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null) {
      if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    }
    const fs = parseFile(cur);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const tiers = strict ? [0] : [0, 1, 2];
        let foundPos = -1;
        for (const t of tiers) {
          for (let k = cursor; k < fs.lines.length; k++) {
            if (tierEq(fs.lines[k]!, chunk.anchor, t)) {
              foundPos = k;
              break;
            }
          }
          if (foundPos >= 0) break;
        }
        if (foundPos < 0) throw new Fail('no-match', s.path);
        cursor = foundPos + 1;
      }
      const { O, N } = splitON(chunk.body);
      if (O.length === 0) {
        const at = chunk.eof ? fs.lines.length : cursor;
        fs.lines.splice(at, 0, ...N.map((n) => n.text));
        cursor = at + N.length;
      } else {
        const found = findTier(fs.lines, O, strict, cursor);
        if (found === null) throw new Fail('no-match', s.path);
        let positions = found.positions;
        if (chunk.eof) positions = positions.filter((p) => p + O.length === fs.lines.length);
        if (positions.length === 0) throw new Fail('no-match', s.path);
        const at = positions[0]!;
        const repl = buildReplacement(fs.lines, O, N, found.tier, at);
        fs.lines.splice(at, O.length, ...repl);
        cursor = at + repl.length;
      }
    }
    const out = serializeFile(fs);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.recordMove(s.path, s.moveTo);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 1 and 2: the command line, the output and exit codes.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of movesBefore) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const suppressedD = new Set<string>();
  const suppressedA = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      suppressedD.add(oldP);
      suppressedA.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was !== null && now === null && suppressedD.has(p)) continue;
    if (was === null && now !== null && suppressedA.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
