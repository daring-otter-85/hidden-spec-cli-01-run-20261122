// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, the V4A patch
// format and text-editor tool calls as JSON), finds the lines each edit names at the first of
// three matching tiers, and changes every file or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** A file as lines: its line break, its lines, and whether it ends with a line break. */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function modelOf(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function serialize(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
  diskExists(p: string): boolean {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
  /** True when the path holds something now (a file on disk, or as an earlier edit left it). */
  present(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    return this.original(p) !== null || this.diskExists(p);
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Matching (SPEC.md section 5). */
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which O occurs at least once at or after `from`, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  if (o.length === 0) return null;
  for (const t of tiersToTry(strict)) {
    const positions = occurrences(lines, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of a replacement: a context line (its index in O) or a new-only line. */
interface NewLine {
  text: string;
  ctx: number;
}

function buildReplacement(fileLines: string[], o: string[], n: NewLine[], pos: number, tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && o.length > 0) {
    const f = leadOf(fileLines[pos]!);
    const p = leadOf(o[0]!);
    for (const l of n) {
      if (l.ctx >= 0) out.push(fileLines[pos + l.ctx]!);
      else if (l.text !== '' && l.text.trim() !== '' && l.text.startsWith(p)) out.push(f + l.text.slice(p.length));
      else out.push(l.text);
    }
    return out;
  }
  for (const l of n) out.push(l.ctx >= 0 ? fileLines[pos + l.ctx]! : l.text);
  return out;
}

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
      if (tree.present(p)) throw new Fail('exists', p);
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

/** Unified diffs (SPEC.md section 6). */
interface HunkLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  a: number;
  lines: HunkLine[];
}
interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  hasPair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(.+)$/;

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let hunk: Hunk | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const fresh = (): UniSection => ({
    pairOld: undefined,
    pairNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    diffOld: undefined,
    diffNew: undefined,
    hasPair: false,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  while (i < n) {
    const line = lines[i]!;
    if (hunk !== null) {
      // A new section or hunk ends the body first: a `--- ` line looks like an old line,
      // but followed by a `+++ ` line it starts a section instead.
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        hunk = null;
        continue;
      }
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        hunk = { a: Number(m[1]), lines: [] };
        sec!.hunks.push(hunk);
        i++;
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk.lines.push({ kind: (line === '' ? ' ' : line[0]!) as HunkLine['kind'], text: line === '' ? '' : line.slice(1) });
        i++;
        continue;
      }
      hunk = null;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = fresh();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!.trim();
      sections.push(sec);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || sec === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), lines: [] };
      sec.hunks.push(hunk);
      inHeader = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null || !inHeader || sec.hasPair) {
        sec = fresh();
        sections.push(sec);
        inHeader = true;
      }
    }
    if (sec === null) {
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        const oldRaw = headerPath(line);
        const newRaw = headerPath(lines[i + 1]!);
        sec.pairOld = oldRaw === '/dev/null' ? null : stripAB(oldRaw);
        sec.pairNew = newRaw === '/dev/null' ? null : stripAB(newRaw);
        sec.hasPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ') && sec.renameOld === undefined) {
        sec.renameOld = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ') && sec.renameNew === undefined) {
        sec.renameNew = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  for (const s of sections) {
    for (const h of s.hunks) {
      while (h.lines.length > 0) {
        const last = h.lines[h.lines.length - 1]!;
        if (last.kind === ' ' && last.text === '') h.lines.pop();
        else break;
      }
    }
  }
  return sections;
}

/** The O and N line lists of a hunk, in body order. */
function hunkON(h: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const l of h.lines) {
    if (l.kind === ' ') {
      o.push(l.text);
      n.push({ text: l.text, ctx: o.length - 1 });
    } else if (l.kind === '-') {
      o.push(l.text);
    } else if (l.kind === '+') {
      n.push({ text: l.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  for (let j = h.lines.length - 1; j >= 0; j--) {
    const k = h.lines[j]!.kind;
    if (k === ' ' || k === '+') return h.lines[j + 1]?.kind === '\\';
  }
  return false;
}

/** Apply a section's hunks in order to a file model, tracking the running offset d. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  let lines = [...model.lines];
  let final = model.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length === 0) {
      const oldLen = lines.length;
      const at = Math.min(h.a + d, oldLen);
      lines.splice(at, 0, ...n.map((l) => l.text));
      if (at === oldLen) final = !hunkNoEol(h);
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    for (const pos of found.positions) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const touchesEnd = best + o.length === lines.length;
    const rep = buildReplacement(lines, o, n, best, found.tier);
    lines.splice(best, o.length, ...rep);
    if (touchesEnd) final = !hunkNoEol(h);
    d += n.length - o.length;
  }
  return { br: model.br, lines, final };
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew;
    if (oldP === undefined && newP === undefined) return;
    if (oldP === null && newP === null) return;
    if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.newFile;
    if (isCreate) {
      if (newP === null || newP === undefined) return;
      if (tree.present(newP)) throw new Fail('exists', newP);
      const out: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.lines.length; j++) {
          if (h.lines[j]!.kind === '+') {
            out.push(h.lines[j]!.text);
            noEol = h.lines[j + 1]?.kind === '\\';
          }
        }
      }
      tree.now.set(newP, out.length === 0 ? '' : out.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    const isDelete = newP === null || sec.deletedFile;
    if (isDelete) {
      if (oldP === null || oldP === undefined) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const op = oldP === undefined ? newP! : oldP;
    const np = newP === undefined ? oldP! : newP;
    if (op !== np) {
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.present(np)) throw new Fail('exists', np);
      const result = applyHunks(modelOf(tree.get(op)!), sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, serialize(result));
      tree.moves.push([op, np]);
      return;
    }
    if (tree.get(op) === null) throw new Fail('missing', op);
    const result = applyHunks(modelOf(tree.get(op)!), sec.hunks, strict, op);
    tree.now.set(op, serialize(result));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => uniEdit(s, strict));
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
interface SRBlock {
  path: string;
  old: string[];
  neu: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let j = i + 1;
    while (j < n && lines[j]!.trimEnd() !== '=======' && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') j++;
    if (j >= n || lines[j]!.trimEnd() !== '=======') throw new Exit2(`error: parse ${searchIdx + 1}`);
    let k = j + 1;
    while (k < n && lines[k]!.trimEnd() !== '>>>>>>> REPLACE' && lines[k]!.trimEnd() !== '<<<<<<< SEARCH') k++;
    if (k >= n || lines[k]!.trimEnd() !== '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let m = searchIdx - 1; m > prevEnd; m--) {
      const l = lines[m]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    blocks.push({ path, old: lines.slice(i + 1, j), neu: lines.slice(j + 1, k) });
    prevEnd = k;
    i = k + 1;
  }
  return blocks;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.present(p)) throw new Fail('exists', p);
      tree.now.set(p, b.neu.length === 0 ? '' : b.neu.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const model = modelOf(cur);
    const found = findTier(model.lines, b.old, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const rep = buildReplacement(
      model.lines,
      b.old,
      b.neu.map((t) => ({ text: t, ctx: -1 })),
      pos,
      found.tier,
    );
    const lines = [...model.lines];
    lines.splice(pos, b.old.length, ...rep);
    tree.now.set(p, serialize({ br: model.br, lines, final: model.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  return parseSR(lines).map((b) => srEdit(b, strict));
}

/** V4A patches (SPEC.md section 8). */
interface V4AChunk {
  anchor: string | null;
  body: Array<{ kind: ' ' | '-' | '+'; text: string }>;
  eof: boolean;
}
interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | undefined;
  lines: string[];
  chunks: V4AChunk[];
  lineNo: number;
}

function isV4ASectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const sec: V4ASection = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), moveTo: undefined, lines: [], chunks: [], lineNo: i + 1 };
      i++;
      const raw: Array<{ no: number; text: string }> = [];
      while (i < end && !isV4ASectionStart(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
        raw.push({ no: i + 1, text: lines[i]! });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      for (const r of raw) {
        if (r.text === '') sec.lines.push('');
        else if (r.text.startsWith('+')) sec.lines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      sections.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim(), moveTo: undefined, lines: [], chunks: [], lineNo: i + 1 });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const sec: V4ASection = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), moveTo: undefined, lines: [], chunks: [], lineNo: i + 1 };
      i++;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const raw: Array<{ no: number; text: string }> = [];
      while (i < end && !isV4ASectionStart(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
        raw.push({ no: i + 1, text: lines[i]! });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let cur: V4AChunk | null = null;
      for (const r of raw) {
        if (r.text.startsWith('@@')) {
          const anchor = r.text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          sec.chunks.push(cur);
          continue;
        }
        if (r.text.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: true };
            sec.chunks.push(cur);
          } else {
            cur.eof = true;
          }
          continue;
        }
        if (cur === null) {
          cur = { anchor: null, body: [], eof: false };
          sec.chunks.push(cur);
        }
        if (r.text === '') cur.body.push({ kind: ' ', text: '' });
        else if (r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') cur.body.push({ kind: r.text[0] as ' ' | '-' | '+', text: r.text.slice(1) });
        else throw new Exit2(`error: parse ${r.no}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.lineNo}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

function chunkON(ch: V4AChunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const l of ch.body) {
    if (l.kind === ' ') {
      o.push(l.text);
      n.push({ text: l.text, ctx: o.length - 1 });
    } else if (l.kind === '-') {
      o.push(l.text);
    } else {
      n.push({ text: l.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  for (const t of tiersToTry(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

function v4aEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.present(p)) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const moveTo = sec.moveTo;
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (moveTo !== undefined && tree.present(moveTo)) throw new Fail('exists', moveTo);
    const model = modelOf(cur);
    let lines = [...model.lines];
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, cursor, strict);
        if (at === -1) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { o, n } = chunkON(ch);
      if (o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines.splice(at, 0, ...n.map((l) => l.text));
        cursor = at + n.length;
        continue;
      }
      const found = findTier(lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', p);
      let pos: number | undefined;
      if (ch.eof) pos = found.positions.find((x) => x + o.length === lines.length);
      else pos = found.positions[0];
      if (pos === undefined) throw new Fail('no-match', p);
      const rep = buildReplacement(lines, o, n, pos, found.tier);
      lines.splice(pos, o.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = serialize({ br: model.br, lines, final: model.final });
    if (moveTo !== undefined) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      tree.moves.push([p, moveTo]);
      return;
    }
    tree.now.set(p, out);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4A(lines).map((s) => v4aEdit(s, strict));
}

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  let rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const oi = rows.findIndex((r) => r.key === oldP && r.line.startsWith('D '));
    const ni = rows.findIndex((r) => r.key === newP && r.line.startsWith('A '));
    if (oi >= 0 && ni >= 0) {
      rows = rows.filter((_, ix) => ix !== oi && ix !== ni);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
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
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
