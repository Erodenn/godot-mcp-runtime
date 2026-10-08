/** .tscn parsing for the run-script security pipeline: one scanner following Godot's own statement grammar, and a transitive collection of the scripts a scene brings with it, reporting what it cannot read rather than skipping it.
 * Not read (see `docs/security.md`): binary `.res`/`.scn` and `uid://`-only references (each reported); an `ext_resource` with both `uid` and `path` is read by `path` while the engine prefers `uid`, so a stale `path` goes unreported. */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { resolveProjectPath } from './path-validation.js';

/** Longest slice of a source line kept in a header's `raw` text and in problem reports. */
const TSCN_RAW_SNIPPET_MAX = 200;
const TSCN_RES_PREFIX = 'res://';
const GDSCRIPT_EXTENSION = '.gd';
/** Path extensions an `ext_resource` is walked as a scene for, whatever its `type` says: `.tres` and `.escn` share the statement grammar; a binary `.scn` is walked and reported as not text. */
const SCENE_FILE_EXTENSIONS: readonly string[] = ['.tscn', '.scn', '.escn', '.tres'];
/** Path extensions of binary resource files, which can carry a script the scan cannot read. */
const RESOURCE_FILE_EXTENSIONS: readonly string[] = ['.res'];
/** `type` values that mark an `ext_resource` as a script: Godot's loaders take the base or concrete class, so a hand-edited `type="GDScript"` loads as `Script` does. */
const SCRIPT_TYPE_HINTS: ReadonlySet<string> = new Set(['Script', 'GDScript', 'CSharpScript']);
const UNICODE_SHORT_ESCAPE_DIGITS = 4;
const UNICODE_LONG_ESCAPE_DIGITS = 6;
const HEX_BASE = 16;
const UNICODE_MAX_CODE_POINT = 0x10ffff;
const INLINE_SCRIPT_SOURCE_KEY = 'script/source';
const GDSCRIPT_RESOURCE_TYPE = 'GDScript';
/** The section holding the properties of a `.tres` file's own resource. */
const MAIN_RESOURCE_TAG = 'resource';
/** Names a `.tres` file's own resource where an inline script's sub-resource id would stand. */
const MAIN_RESOURCE_SCRIPT_ID = 'resource';
const SCENE_HEADER_TAGS: ReadonlySet<string> = new Set(['gd_scene', 'gd_resource']);
const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['b', '\b'],
  ['f', '\f'],
]);
/** A UTF-8 byte order mark, as it reads once the file is decoded. */
const BYTE_ORDER_MARK = '\uFEFF';
const UNTERMINATED_VALUE_REASON = 'value has an unclosed bracket';
const UNTERMINATED_STRING_REASON = 'unterminated string';
const NO_VALUE_REASON = 'statement has no value';
const NOT_A_VALUE_REASON = 'value is not one Godot reads';
const NO_ASSIGNMENT_REASON = 'line has no = and is not a statement';
const TEXT_AFTER_VALUE_REASON = 'text after the value on the same line';
const TEXT_AFTER_HEADER_REASON = 'text after the header on the same line';
/** Section tags of Godot's text formats; a line opening one ends a value still open above it (see `readGroup`). */
const KNOWN_SECTION_TAGS: ReadonlySet<string> = new Set([
  'gd_scene',
  'gd_resource',
  'ext_resource',
  'sub_resource',
  'node',
  'connection',
  'editable',
  'resource',
]);
/** Words that are a whole value. Any other word is a constructor and needs its brackets. */
const BARE_WORD_VALUES: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
  'nil',
  'inf',
  'inf_neg',
  'nan',
]);
/** Words that are a value behind a minus sign. */
const NEGATIVE_WORD_VALUES: ReadonlySet<string> = new Set(['inf', 'nan']);
/** Characters that mark a quoted string as a StringName (`&`, and `@` in older files) or a NodePath (`^`). */
const STRING_PREFIXES = '&^@';
/** Malformed statements listed per scene before the rest are folded into one count. */
const MAX_MALFORMED_REPORTED_PER_SCENE = 20;
const NOT_TEXT_SCENE_REASON =
  'not a text scene (no [gd_scene] header); binary scenes cannot be scanned';

function isFileNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Reads a scene file's content, null when missing: a stale ext_resource reference must not crash the pre-flight. */
function readSceneFileSafe(scenePath: string): string | null {
  try {
    return readFileSync(scenePath, 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) return null;
    throw err;
  }
}

export interface TscnHeader {
  tag: string;
  attrs: Map<string, string>;
  line: number;
  /** The header line, trimmed and capped at `TSCN_RAW_SNIPPET_MAX` characters. */
  raw: string;
  stringProps: Map<string, string>;
  /** Every other property by key: the whole trimmed value, comments removed. A value whose brackets never close is reported in `malformed` and cut at its first line. A key is in at most one map, and in neither when its last assignment could not be read. */
  rawProps: Map<string, string>;
}

export interface TscnScan {
  isTextResource: boolean;
  headers: TscnHeader[];
  /** What the scanner could not read as Godot's writer lays it out: unparsed headers (none is in `headers`), unterminated strings, and statements that move a statement boundary. */
  malformed: Array<{ line: number; reason: string; raw: string }>;
}

export interface QuotedString {
  value: string;
  end: number;
}

function snippet(text: string): string {
  return text.trimEnd().slice(0, TSCN_RAW_SNIPPET_MAX);
}

function countNewlines(content: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i++) {
    if (content[i] === '\n') count++;
  }
  return count;
}

function isBlank(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

/** Reads the quoted string opening at `start`, unescaped; null when no closing quote precedes `limit`. */
export function readQuoted(content: string, start: number, limit: number): QuotedString | null {
  let out = '';
  let i = start + 1;
  while (i < limit) {
    const ch = content[i]!;
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    const escaped = content[i + 1];
    if (escaped === undefined || i + 1 >= limit) return null;
    if (escaped === 'u' || escaped === 'U') {
      const digits = escaped === 'u' ? UNICODE_SHORT_ESCAPE_DIGITS : UNICODE_LONG_ESCAPE_DIGITS;
      const hex = content.slice(i + 2, i + 2 + digits);
      if (hex.length === digits && /^[0-9a-fA-F]+$/.test(hex)) {
        const code = parseInt(hex, HEX_BASE);
        if (code <= UNICODE_MAX_CODE_POINT) {
          out += String.fromCodePoint(code);
          i += 2 + digits;
          continue;
        }
      }
    }
    out += SIMPLE_ESCAPES.get(escaped) ?? escaped;
    i += 2;
  }
  return null;
}

interface ValueRead {
  start: number;
  end: number;
  /** Index just past the text kept as the value: `end`, or the end of the first line of a value that never closes. */
  textEnd: number;
  quoted: QuotedString | null;
  plainString: boolean;
  comments: Array<[number, number]>;
  /** Why the text is not a value Godot reads, and where, or null when it is one. */
  problem: { reason: string; at: number } | null;
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_]/.test(ch);
}

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function lineEndFrom(content: string, from: number, limit: number): number {
  const newlineAt = content.indexOf('\n', from);
  return newlineAt === -1 || newlineAt > limit ? limit : newlineAt;
}

/** Index of the next token character, past blanks, line breaks and `;` comments (which Godot's tokenizer skips between any two tokens); comment ranges go to `comments` when given. */
function skipToToken(
  content: string,
  from: number,
  limit: number,
  comments?: Array<[number, number]>,
): number {
  let i = from;
  while (i < limit) {
    const c = content[i]!;
    if (c === ';') {
      const commentEnd = lineEndFrom(content, i, limit);
      comments?.push([i, commentEnd]);
      i = commentEnd;
    } else if (c === '\n' || isBlank(c)) i++;
    else break;
  }
  return i;
}

function startsKnownSection(content: string, from: number, limit: number): boolean {
  let i = from;
  while (i < limit && isBlank(content[i])) i++;
  if (content[i] !== '[') return false;
  i++;
  while (i < limit && isBlank(content[i])) i++;
  const tagStart = i;
  while (i < limit && isIdentifierChar(content[i])) i++;
  return KNOWN_SECTION_TAGS.has(content.slice(tagStart, i));
}

/** Reads the bracketed group opened at `openAt` into `read`; strings and comments inside open and close nothing. Returns false with `read.problem` set when it does not close before `limit`, an unterminated string, or a line opening a known section:
 * Godot's writer never puts one inside a value, so a value reaching it is cut there and the section is read. Every character is read once. */
function readGroup(content: string, openAt: number, limit: number, read: ValueRead): boolean {
  let depth = 0;
  let firstNewlineAt = -1;
  let j = openAt;
  const cut = (end: number, reason: string, at: number): boolean => {
    read.end = end;
    read.textEnd = firstNewlineAt === -1 ? end : firstNewlineAt;
    read.problem = { reason, at };
    return false;
  };
  while (j < limit) {
    const c = content[j]!;
    if (c === '"') {
      const quoted = readQuoted(content, j, limit);
      if (quoted === null) return cut(limit, UNTERMINATED_STRING_REASON, j);
      j = quoted.end;
      continue;
    }
    if (c === ';') {
      const commentEnd = lineEndFrom(content, j, limit);
      read.comments.push([j, commentEnd]);
      j = commentEnd;
      continue;
    }
    if (c === '\n') {
      if (firstNewlineAt === -1) firstNewlineAt = j;
      if (startsKnownSection(content, j + 1, limit)) return cut(j, UNTERMINATED_VALUE_REASON, j);
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        read.end = j + 1;
        read.textEnd = j + 1;
        return true;
      }
    }
    j++;
  }
  return cut(limit, UNTERMINATED_VALUE_REASON, limit);
}

/** Index just past the number at `from`, by Godot's tokenizer states: digits, one fraction, one exponent with one sign. */
function numberEnd(content: string, from: number, limit: number): number {
  let i = content[from] === '-' ? from + 1 : from;
  while (i < limit && isDigit(content[i])) i++;
  if (content[i] === '.' && i < limit) {
    i++;
    while (i < limit && isDigit(content[i])) i++;
  }
  if (content[i] === 'e' && i < limit) {
    i++;
    if ((content[i] === '-' || content[i] === '+') && i < limit) i++;
    while (i < limit && isDigit(content[i])) i++;
  }
  return i;
}

/** Reads the value after an `=` the way Godot's parser does, by its first token: string, number, `#` color and `BARE_WORD_VALUES` are complete alone, `{`/`[` open a group, any other word is a constructor complete at its closing bracket.
 * Counting brackets from the `=` would read less than the engine: after `a = 1 (` the engine has its value at `1` and reads the next lines as statements, headers included. */
function readValue(content: string, from: number, limit: number): ValueRead {
  const read: ValueRead = {
    start: limit,
    end: limit,
    textEnd: limit,
    quoted: null,
    plainString: false,
    comments: [],
    problem: null,
  };
  const start = skipToToken(content, from, limit);
  if (start >= limit) {
    read.problem = { reason: NO_VALUE_REASON, at: from };
    return read;
  }
  read.start = start;
  const endAt = (end: number): ValueRead => {
    read.end = end;
    read.textEnd = end;
    return read;
  };
  const notAValue = (end: number): ValueRead => {
    read.problem = { reason: NOT_A_VALUE_REASON, at: start };
    return endAt(end);
  };
  const c = content[start]!;
  const prefixed = STRING_PREFIXES.includes(c) && content[start + 1] === '"';
  if (c === '"' || prefixed) {
    const quoteAt = prefixed ? start + 1 : start;
    const quoted = readQuoted(content, quoteAt, limit);
    if (quoted === null) {
      read.problem = { reason: UNTERMINATED_STRING_REASON, at: quoteAt };
      return read;
    }
    read.quoted = quoted;
    read.plainString = !prefixed;
    return endAt(quoted.end);
  }
  if (c === '{' || c === '[') {
    readGroup(content, start, limit, read);
    return read;
  }
  if (c === '#') {
    let i = start + 1;
    while (i < limit && /[0-9a-fA-F]/.test(content[i]!)) i++;
    return endAt(i);
  }
  if (c === '-' && isIdentifierStart(content[start + 1])) {
    // `-inf` and `-nan`, which newer engines write; any other word after a minus sign is no value on any engine.
    let i = start + 1;
    while (i < limit && isIdentifierChar(content[i])) i++;
    if (NEGATIVE_WORD_VALUES.has(content.slice(start + 1, i))) return endAt(i);
    return notAValue(start + 1);
  }
  if (c === '-' || isDigit(c)) return endAt(numberEnd(content, start, limit));
  if (!isIdentifierStart(c)) return notAValue(start);

  let wordEnd = start + 1;
  while (wordEnd < limit && isIdentifierChar(content[wordEnd])) wordEnd++;
  if (BARE_WORD_VALUES.has(content.slice(start, wordEnd))) return endAt(wordEnd);
  // A constructor: the word, then its arguments in brackets. A typed
  // container has two groups, the type and then the elements.
  const openAt = skipToToken(content, wordEnd, limit, read.comments);
  const opener = openAt < limit ? content[openAt] : undefined;
  if (opener !== '(' && opener !== '[') return notAValue(wordEnd);
  if (!readGroup(content, openAt, limit, read) || opener === '(') return read;
  const elementsAt = skipToToken(content, read.end, limit, read.comments);
  if (elementsAt >= limit || content[elementsAt] !== '(') {
    read.problem = { reason: NOT_A_VALUE_REASON, at: start };
    return read;
  }
  readGroup(content, elementsAt, limit, read);
  return read;
}

type HeaderParse =
  | { ok: true; tag: string; attrs: Map<string, string>; end: number }
  | { ok: false; reason: string };

/** Parses the header starting at `start` (a `[`) that must end before `lineEnd`; values go through `readValue`, so a quoted string may hold `]`. A `&`, `^` or `@` prefixed string is returned unescaped, as the engine converts it to the same text for `type` and `path`. `end` is just past the `]`. */
function parseHeader(content: string, start: number, lineEnd: number): HeaderParse {
  let i = start + 1;
  // Godot skips blanks between the bracket and the tag: `[ ext_resource ...]`.
  while (i < lineEnd && isBlank(content[i])) i++;
  const tagStart = i;
  while (i < lineEnd && isIdentifierChar(content[i])) i++;
  const tag = content.slice(tagStart, i);
  if (tag === '') return { ok: false, reason: 'header has no tag' };
  const attrs = new Map<string, string>();
  for (;;) {
    while (i < lineEnd && isBlank(content[i])) i++;
    if (i >= lineEnd) return { ok: false, reason: 'header has no closing bracket' };
    if (content[i] === ']') return { ok: true, tag, attrs, end: i + 1 };
    const keyStart = i;
    while (i < lineEnd && content[i] !== '=' && content[i] !== ']' && !isBlank(content[i])) i++;
    const key = content.slice(keyStart, i);
    // Blanks on either side of the `=` belong to neither the key nor the value.
    // Godot's own writer leaves one after it: `binds= [7]` on a connection.
    while (i < lineEnd && isBlank(content[i])) i++;
    if (key === '' || content[i] !== '=') {
      return { ok: false, reason: `attribute ${key === '' ? '' : key + ' '}has no value` };
    }
    const value = readValue(content, i + 1, lineEnd);
    if (value.problem !== null) {
      const { reason } = value.problem;
      if (reason === UNTERMINATED_STRING_REASON) {
        return { ok: false, reason: 'unterminated string in header' };
      }
      if (reason === NO_VALUE_REASON) return { ok: false, reason: `attribute ${key} has no value` };
      return { ok: false, reason: `attribute ${key}: ${reason}` };
    }
    attrs.set(
      key,
      value.quoted !== null ? value.quoted.value : content.slice(value.start, value.end),
    );
    i = value.end;
  }
}

/** `content` from `from` to `to`, without the comment ranges inside it. */
function sliceWithoutComments(
  content: string,
  from: number,
  to: number,
  comments: Array<[number, number]>,
): string {
  let out = '';
  let at = from;
  for (const [commentStart, commentEnd] of comments) {
    if (commentEnd <= at || commentStart >= to) continue;
    out += content.slice(at, Math.max(at, commentStart));
    at = Math.min(commentEnd, to);
  }
  return out + content.slice(at, to);
}

/** True when nothing but blanks and a comment lies between `from` and the end of its line. */
function restOfLineIsEmpty(content: string, from: number): boolean {
  let i = from;
  while (i < content.length && isBlank(content[i])) i++;
  return i >= content.length || content[i] === '\n' || content[i] === ';';
}

/** The 1-based line of an index; lines count from the last index asked, so ascending queries count each once. */
function lineCounter(content: string): (index: number) => number {
  let countedTo = 0;
  let line = 1;
  return (index) => {
    if (index < countedTo) {
      countedTo = 0;
      line = 1;
    }
    line += countNewlines(content, countedTo, index);
    countedTo = index;
    return line;
  };
}

/** Reads a .tscn / .tres in one pass by the statement grammar of Godot's own reader, which is not bound to lines: blanks, breaks and `;` comments only separate tokens, a `[` opens a header only where a statement starts, and a string runs across newlines.
 * Every layout Godot's writer does not produce that moves a statement boundary is reported in `malformed`; a key assigned twice keeps the last, and an unreadable assignment removes the key. Two departures, both toward reading more: a line-leading `[` opens a header even after a line with no `=`, and scanning continues past a statement where the engine stops. */
export function scanTscn(content: string): TscnScan {
  const headers: TscnHeader[] = [];
  const malformed: TscnScan['malformed'] = [];
  const length = content.length;
  const lineOf = lineCounter(content);
  const report = (at: number, reason: string, raw?: string): void => {
    malformed.push({
      line: lineOf(at),
      reason,
      raw: raw ?? snippet(content.slice(at, lineEndFrom(content, at, length))),
    });
  };
  let i = content.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
  let current: TscnHeader | null = null;
  // The key of the statement being read: its text so far, where it started,
  // and whether a line break inside it has been reported.
  let key = '';
  let keyAt = -1;
  let keyReported = false;
  let atLineStart = true;
  const resetKey = (): void => {
    key = '';
    keyAt = -1;
    keyReported = false;
  };

  while (i < length) {
    const c = content[i]!;
    if (c === '\n') {
      if (key !== '' && !keyReported) {
        report(keyAt, NO_ASSIGNMENT_REASON);
        keyReported = true;
      }
      atLineStart = true;
      i++;
      continue;
    }
    if (c <= ' ') {
      i++;
      continue;
    }
    if (c === ';') {
      i = lineEndFrom(content, i, length);
      continue;
    }
    if (c === '[' && (key === '' || atLineStart)) {
      resetKey();
      atLineStart = false;
      const lineEnd = lineEndFrom(content, i, length);
      const parsed = parseHeader(content, i, lineEnd);
      const raw = snippet(content.slice(i, lineEnd));
      if (!parsed.ok) {
        current = null;
        malformed.push({ line: lineOf(i), reason: parsed.reason, raw });
        i = lineEnd;
        continue;
      }
      current = {
        tag: parsed.tag,
        attrs: parsed.attrs,
        line: lineOf(i),
        raw,
        stringProps: new Map(),
        rawProps: new Map(),
      };
      headers.push(current);
      if (!restOfLineIsEmpty(content, parsed.end)) report(i, TEXT_AFTER_HEADER_REASON, raw);
      i = parsed.end;
      continue;
    }
    atLineStart = false;
    if (c === '"') {
      const quoted = readQuoted(content, i, length);
      if (quoted === null) {
        report(i, UNTERMINATED_STRING_REASON, snippet(content.slice(i)));
        break;
      }
      if (keyAt === -1) keyAt = i;
      key = quoted.value;
      i = quoted.end;
      continue;
    }
    if (c !== '=') {
      if (keyAt === -1) keyAt = i;
      key += c;
      i++;
      continue;
    }

    const statementAt = keyAt === -1 ? i : keyAt;
    const value = readValue(content, i + 1, length);
    const statementKey = key;
    resetKey();
    i = value.end;
    let readable = value.problem === null;
    if (value.problem !== null) {
      const { reason, at } = value.problem;
      if (reason === UNTERMINATED_STRING_REASON) report(at, reason, snippet(content.slice(at)));
      else report(statementAt, reason);
    } else if (!restOfLineIsEmpty(content, value.end)) {
      report(statementAt, TEXT_AFTER_VALUE_REASON);
      readable = false;
    }
    if (current === null || statementKey === '') continue;
    current.stringProps.delete(statementKey);
    current.rawProps.delete(statementKey);
    if (readable && value.quoted !== null && value.plainString) {
      current.stringProps.set(statementKey, value.quoted.value);
      continue;
    }
    // A value whose brackets never close keeps its first line, so a reader of
    // `rawProps` still sees what kind of value it was.
    const keepsText = readable || value.problem?.reason === UNTERMINATED_VALUE_REASON;
    if (!keepsText || value.start >= value.textEnd) continue;
    const rawValue = sliceWithoutComments(
      content,
      value.start,
      value.textEnd,
      value.comments,
    ).trim();
    if (rawValue !== '') current.rawProps.set(statementKey, rawValue);
  }

  return { isTextResource: SCENE_HEADER_TAGS.has(headers[0]?.tag ?? ''), headers, malformed };
}

/** Absolute path of a reference read out of a scene file; the input is file content, not a user string, so no containment check applies. */
function resReferenceToAbs(projectDir: string, resPath: string): string {
  const rel = resPath.startsWith(TSCN_RES_PREFIX) ? resPath.slice(TSCN_RES_PREFIX.length) : resPath;
  return join(projectDir, rel);
}

/** An inline `[sub_resource type="GDScript"]`, or a `.tres` that is itself a GDScript, and its source. */
export interface InlineSceneScript {
  scenePath: string;
  id: string;
  source: string;
}

export interface UnscannedSceneItem {
  scenePath: string;
  reason: string;
  /** True when `scenePath` exists and reading it failed (permission error, a directory in its place): unlike files of a kind the scan does not read, the scan set out to read it. */
  readFailed?: true;
  /** True for a scene reference that did not resolve to a file inside the project; like `readFailed`, the scan set out to follow it. */
  unresolved?: true;
  /** True for a statement the scan read but could not take as written (a `TscnScan.malformed` entry, or a script source that is not one plain string): the engine may load something from it the scan did not see, so callers treat it like `readFailed`. */
  malformed?: true;
}

export interface SceneScriptCollection {
  scripts: string[];
  inlineScripts: InlineSceneScript[];
  unscanned: UnscannedSceneItem[];
}

function resPathOf(attrs: Map<string, string>): string | null {
  const path = attrs.get('path');
  return path !== undefined && path.startsWith(TSCN_RES_PREFIX) ? path : null;
}

/** Transitively walks the scenes `scenePath` references, collecting the `.gd` files their ext_resources name and the source of inline GDScript: a hostile script in an instanced PackedScene is invisible to a single-scene scan.
 * References are classified by path, not `type`, which a hand-edited scene can set to anything; what the walk cannot follow but could bring a script in is listed in `unscanned`, never dropped. Cycle-safe by resolved path; nothing throws on a stale or unreadable reference. */
export function collectSceneScripts(scenePath: string, projectDir: string): SceneScriptCollection {
  const visited = new Set<string>();
  const scripts = new Set<string>();
  const inlineScripts: InlineSceneScript[] = [];
  const unscanned: UnscannedSceneItem[] = [];
  // One notice per resource file, however many scenes reference it.
  const reportedResources = new Set<string>();

  function walk(currentScenePath: string): void {
    const absScenePath = resolve(currentScenePath);
    if (visited.has(absScenePath)) return;
    visited.add(absScenePath);
    const skip = (reason: string): void => {
      unscanned.push({ scenePath: absScenePath, reason });
    };
    // A scene reference is followed only when it stays inside the project, so
    // a `res://../x.tscn` the engine would refuse is never read off the disk.
    const followScene = (path: string): void => {
      const resolved = resolveProjectPath(projectDir, path, 'read');
      if (resolved === null) {
        unscanned.push({
          scenePath: absScenePath,
          reason: `reference ${path} could not be resolved to a file inside the project and was not followed`,
          unresolved: true,
        });
      } else walk(resolved.absPath);
    };

    let content: string | null;
    try {
      content = readSceneFileSafe(currentScenePath);
    } catch (err) {
      // The file is there and could not be read: one entry, and the walk goes on, since a throw would abandon every scene and autoload not yet reached, with nothing naming them.
      const detail = err instanceof Error ? err.message : String(err);
      unscanned.push({
        scenePath: absScenePath,
        reason: `scene file could not be read (${detail})`,
        readFailed: true,
      });
      return;
    }
    if (content === null) {
      skip('scene file not found');
      return;
    }
    const scan = scanTscn(content);
    if (!scan.isTextResource) {
      skip(NOT_TEXT_SCENE_REASON);
      return;
    }

    // A `.tres` whose own type is GDScript carries its source under `[resource]`.
    const fileIsScript = scan.headers[0]?.attrs.get('type') === GDSCRIPT_RESOURCE_TYPE;
    const hasSourceProperty = (header: TscnHeader): boolean =>
      header.stringProps.has(INLINE_SCRIPT_SOURCE_KEY) ||
      header.rawProps.has(INLINE_SCRIPT_SOURCE_KEY);
    const collectInlineScript = (header: TscnHeader, id: string): void => {
      const source = header.stringProps.get(INLINE_SCRIPT_SOURCE_KEY);
      if (source !== undefined) {
        inlineScripts.push({ scenePath: absScenePath, id, source });
      } else if (header.rawProps.has(INLINE_SCRIPT_SOURCE_KEY)) {
        // The engine converts any value to source text (`&"..."`), so it compiles what was not read.
        unscanned.push({
          scenePath: absScenePath,
          reason: `inline GDScript ${id} has no readable script/source (the value is not one plain string)`,
          malformed: true,
        });
      } else skip(`inline GDScript ${id} has no readable script/source`);
    };

    for (const header of scan.headers) {
      if (header.tag === 'ext_resource') {
        const type = header.attrs.get('type') ?? '';
        const path = resPathOf(header.attrs);
        const lowered = path === null ? '' : path.toLowerCase();
        if (path !== null && lowered.endsWith(GDSCRIPT_EXTENSION)) {
          scripts.add(resReferenceToAbs(projectDir, path));
        } else if (path !== null && SCENE_FILE_EXTENSIONS.some((ext) => lowered.endsWith(ext))) {
          followScene(path);
        } else if (type === 'PackedScene') {
          if (path === null) skip(`PackedScene ext_resource has no res:// path: ${header.raw}`);
          else followScene(path);
        } else if (SCRIPT_TYPE_HINTS.has(type)) {
          if (path === null) skip(`Script ext_resource has no res:// path: ${header.raw}`);
          else skip(`script ${path} is not GDScript and is not scanned`);
        } else if (path === null) {
          skip(`ext_resource has no res:// path and was not followed: ${header.raw}`);
        } else if (RESOURCE_FILE_EXTENSIONS.some((ext) => lowered.endsWith(ext))) {
          if (!reportedResources.has(lowered)) {
            reportedResources.add(lowered);
            skip(`resource ${path} is not scanned (a binary .res file can carry a script)`);
          }
        }
      } else if (
        header.tag === 'sub_resource' &&
        header.attrs.get('type') === GDSCRIPT_RESOURCE_TYPE
      ) {
        collectInlineScript(header, header.attrs.get('id') ?? '?');
      } else if (header.tag === MAIN_RESOURCE_TAG && (fileIsScript || hasSourceProperty(header))) {
        collectInlineScript(header, MAIN_RESOURCE_SCRIPT_ID);
      }
    }
    // A malformed header loses the properties under it whatever its tag, and a malformed statement may hold something the engine loads, so each is reported up to a cap: a file of broken lines says so once, not per line.
    const reportMalformed = (reason: string): void => {
      unscanned.push({ scenePath: absScenePath, reason, malformed: true });
    };
    for (const problem of scan.malformed.slice(0, MAX_MALFORMED_REPORTED_PER_SCENE)) {
      reportMalformed(`${problem.reason} at line ${problem.line}: ${problem.raw}`);
    }
    if (scan.malformed.length > MAX_MALFORMED_REPORTED_PER_SCENE) {
      reportMalformed(
        `${scan.malformed.length - MAX_MALFORMED_REPORTED_PER_SCENE} more malformed statements`,
      );
    }
  }

  walk(scenePath);
  return { scripts: Array.from(scripts), inlineScripts, unscanned };
}

/** The `[ext_resource path="res://....gd"]` references of one scene as absolute paths, whatever their `type` says. Not transitive and ignores inline sources; paths are returned even if the file is missing (the caller checks), and a missing scene yields `[]`. */
export function extractSceneScripts(scenePath: string, projectDir: string): string[] {
  const content = readSceneFileSafe(scenePath);
  if (content === null) return [];
  const result: string[] = [];
  for (const header of scanTscn(content).headers) {
    if (header.tag !== 'ext_resource') continue;
    const path = resPathOf(header.attrs);
    if (path === null || !path.toLowerCase().endsWith(GDSCRIPT_EXTENSION)) continue;
    result.push(resReferenceToAbs(projectDir, path));
  }
  return result;
}
