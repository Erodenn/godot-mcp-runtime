/**
 * .tscn parsing helpers shared by the run-script security pipeline. Text
 * parsing, no Godot process required. project.godot is read by
 * `project-godot.ts`, and the launched scene is resolved by `launch-scene.ts`.
 *
 * Responsibilities:
 *  - Read a text scene with one scanner (`scanTscn`) that follows the
 *    statement grammar of Godot's own reader: section headers, their
 *    attributes, and the properties that follow them. A bracketed line inside
 *    a multi-line string is never mistaken for a header, a `]` inside a quoted
 *    path never ends one early, and a value ends where the engine ends it, so
 *    no section is hidden inside one.
 *  - Collect every script a scene brings with it (`collectSceneScripts`):
 *    the `.gd` files its `[ext_resource]` lines name, the source of inline
 *    `[sub_resource type="GDScript"]` scripts, and the same for every scene
 *    it references, transitively. A reference is classified by its path as
 *    well as by its `type` attribute, which is only a hint. A script attached
 *    to an instanced node, or assigned by an instance override, is always one
 *    of those two forms, so it is covered by construction.
 *  - Report what it could not read instead of skipping it: scripts that are
 *    not GDScript, binary scenes, resource files, scene files that exist and
 *    could not be read, malformed headers, unterminated strings, and every
 *    statement laid out in a way Godot's writer does not produce.
 *
 * Not read (documented limitation, see `docs/security.md`): scripts carried by
 * binary resources a scene references (`.res`), binary `.scn`
 * scenes, and references by `uid://` alone. Each of these that the walk meets
 * is reported, not dropped. One limit is not reported: an `ext_resource` that
 * carries both a `uid` and a `path` is read by its `path`, while the engine
 * prefers the `uid`, so a stale `path` names a file the engine will not load.
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { resolveProjectPath } from './path-validation.js';

/** Longest slice of a source line kept in a header's `raw` text and in problem reports. */
const TSCN_RAW_SNIPPET_MAX = 200;
const TSCN_RES_PREFIX = 'res://';
const GDSCRIPT_EXTENSION = '.gd';
/**
 * Path extensions an `ext_resource` is walked as a scene for, whatever its
 * `type` says. A `.tres` is a text resource with the same statement grammar
 * (`gd_resource`), so its scripts, inline GDScript and further references are
 * collected like a scene's. A binary `.scn` is walked and reported as not text.
 */
const SCENE_FILE_EXTENSIONS: readonly string[] = ['.tscn', '.scn', '.tres'];
/** Path extensions of binary resource files, which can carry a script the scan cannot read. */
const RESOURCE_FILE_EXTENSIONS: readonly string[] = ['.res'];
/**
 * `type` values that say an `ext_resource` is a script. Godot's loaders take
 * the base class or the concrete one, so a hand-edited `type="GDScript"` loads
 * exactly as `type="Script"` does.
 */
const SCRIPT_TYPE_HINTS: ReadonlySet<string> = new Set(['Script', 'GDScript', 'CSharpScript']);
const UNICODE_SHORT_ESCAPE_DIGITS = 4;
const UNICODE_LONG_ESCAPE_DIGITS = 6;
const HEX_BASE = 16;
const UNICODE_MAX_CODE_POINT = 0x10ffff;
const INLINE_SCRIPT_SOURCE_KEY = 'script/source';
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
/**
 * The section tags of Godot's text scene and resource formats. A line that
 * opens one of these ends a value still open above it (see `readGroup`).
 */
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

/**
 * Read a scene file's content, returning null (not throwing) when the file
 * is missing — a stale ext_resource reference must not crash the pre-flight.
 */
function readSceneFileSafe(scenePath: string): string | null {
  try {
    return readFileSync(scenePath, 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) return null;
    throw err;
  }
}

// --- Text scene scanner ---

/** One `[tag key=value ...]` section header and the string properties under it. */
export interface TscnHeader {
  tag: string;
  /** Attribute values as written: quoted strings unescaped, bare tokens verbatim. */
  attrs: Map<string, string>;
  line: number;
  /** The header line, trimmed and capped at `TSCN_RAW_SNIPPET_MAX` characters. */
  raw: string;
  /** Properties whose value is exactly one plain string, unescaped, by key. */
  stringProps: Map<string, string>;
  /**
   * Every other property, by key: the whole value, trimmed, comments removed
   * and otherwise as written. A value that continues on later lines (a
   * dictionary, mostly) is returned through its closing bracket, line breaks
   * included. A value whose brackets never close is reported in `malformed`
   * and cut at the end of its first line. A key is in one of the two maps at
   * most, and in neither when its last assignment could not be read.
   */
  rawProps: Map<string, string>;
}

export interface TscnScan {
  /** True when the first header is `gd_scene` or `gd_resource`. */
  isTextResource: boolean;
  headers: TscnHeader[];
  /**
   * What the scanner could not read as Godot's writer lays it out: headers
   * that do not parse (none of them is in `headers`), strings that never end,
   * and statements whose layout moves a statement boundary.
   */
  malformed: Array<{ line: number; reason: string; raw: string }>;
}

export interface QuotedString {
  value: string;
  /** Index just past the closing quote. */
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

/**
 * Read the quoted string whose opening quote is at `start`, unescaping it.
 * Returns null when no closing quote is found before `limit`.
 */
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

/** Where one value ends, and what was found on the way. */
interface ValueRead {
  /** Index of the value's first character. */
  start: number;
  /** Index just past the value, where the next statement starts. */
  end: number;
  /** Index just past the text kept as the value: `end`, or the end of the first line of a value that never closes. */
  textEnd: number;
  /** The value when it is exactly one string, with or without a `&`, `^` or `@` prefix. */
  quoted: QuotedString | null;
  /** True when `quoted` is a plain `"..."` string with no prefix. */
  plainString: boolean;
  /** `[start, end)` of each comment inside the value. */
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

/** Index of the newline that ends the line `from` is on, or `limit`. */
function lineEndFrom(content: string, from: number, limit: number): number {
  const newlineAt = content.indexOf('\n', from);
  return newlineAt === -1 || newlineAt > limit ? limit : newlineAt;
}

/**
 * Index of the next character that belongs to a token: past blanks, line
 * breaks and `;` comments, which Godot's tokenizer skips between any two
 * tokens. Comment ranges are added to `comments` when it is given.
 */
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

/** True when the line that starts at `from` opens a section Godot's scene format defines. */
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

/**
 * Read the bracketed group whose opening bracket is at `openAt`, through the
 * bracket that closes it, into `read`. Strings and comments inside it open and
 * close nothing. Returns false, with `read.problem` set, when the group does
 * not close before `limit`, before a string that never ends, or before a line
 * that opens a known section: Godot's writer never puts such a line inside a
 * value, so a value that reaches one is cut there and the section is read.
 * Every character is read once, whatever the outcome.
 */
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

/**
 * Index just past the number that starts at `from` (a digit or `-`), by the
 * states of Godot's tokenizer: digits, one fraction, one exponent with one sign.
 */
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

/**
 * Read the value that follows an `=`, the way Godot's own parser does: by its
 * first token. A string, a number, a `#` color and the bare words in
 * `BARE_WORD_VALUES` are complete by themselves. `{` and `[` open a group that
 * runs to its closing bracket across lines. Any other word is a constructor
 * (`Vector2(...)`, `ExtResource("1_a")`, `Array[int]([...])`) and is complete
 * at the bracket that closes its arguments.
 *
 * Counting brackets from the `=` instead reads less than the engine does:
 * after `a = 1 (`, the engine has its value at `1` and reads the next lines as
 * statements, section headers included, while a bracket count holds them
 * inside the value.
 */
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
    // `-inf` and `-nan`, which newer engines write. Any other word after a
    // minus sign is no value on any engine.
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

/**
 * Parse the header that starts at `start` (a `[`) and must end before
 * `lineEnd`. Each attribute value is read by `readValue`, so a quoted string
 * may hold `]` and a value such as `ExtResource("1_a")` or `["x", "y"]` runs
 * through its own brackets. A string written with a `&`, `^` or `@` prefix is
 * returned unescaped like a plain one: the engine converts it to the same text
 * where it reads `type` and `path`. `end` is the index just past the `]`.
 */
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

/**
 * The 1-based line of an index. Lines are counted from the last index asked
 * about, so a scan that asks in ascending order counts every line once.
 */
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

/**
 * Read a `.tscn` / `.tres` text in one pass, by the statement grammar of
 * Godot's own reader. That reader is not bound to lines. A statement is a
 * section header, or a key, an `=` and one value; blanks, line breaks and `;`
 * comments separate tokens and mean nothing else. A `[` opens a header only
 * where a statement starts. A key is every character up to the `=`, with
 * blanks dropped, and a quoted string there replaces what was read of the key.
 * A value is read by its first token (see `readValue`), and the next statement
 * starts right after it. A string runs to its closing quote across newlines,
 * so nothing inside one is ever read as structure. A leading byte order mark
 * is skipped.
 *
 * Reading statements the engine's way is what keeps a hand-edited file from
 * showing the scan less than the engine loads. On top of that, every layout
 * Godot's writer does not produce and that moves a statement boundary is
 * reported in `malformed`, so a caller that must not act on a partial reading
 * can tell:
 *  - text after a value or a header on the same line (the engine reads it as
 *    the next statement, and so does this scan; the property before it is
 *    dropped, never kept as if the line were ordinary);
 *  - a line of text with no `=` (the engine joins it to the key that follows);
 *  - a value that is no value, or whose brackets never close. One that never
 *    closes is cut at the next known section header, or runs to the end of the
 *    file, and keeps its first line as its text;
 *  - a header that does not close on its line, and a string that never ends.
 *
 * Two departures from the engine, both toward reading more: a `[` that starts
 * a line opens a header even after a line with no `=`, and scanning goes on
 * past a statement the engine would stop loading at.
 *
 * A key assigned twice keeps the last assignment, as the engine does, and an
 * assignment that could not be read removes the key: an earlier value is never
 * left standing in for a later one the scan did not read.
 */
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

// --- Script collection ---

/**
 * Absolute path of a reference read out of a scene file (`res://x`). The input
 * is file content, not a user string, so no containment check applies here.
 */
function resReferenceToAbs(projectDir: string, resPath: string): string {
  const rel = resPath.startsWith(TSCN_RES_PREFIX) ? resPath.slice(TSCN_RES_PREFIX.length) : resPath;
  return join(projectDir, rel);
}

/** An inline `[sub_resource type="GDScript"]` and the source it carries. */
export interface InlineSceneScript {
  /** Absolute path of the scene file that holds the sub-resource. */
  scenePath: string;
  id: string;
  source: string;
  /** Line of the sub-resource header in the scene file. */
  line: number;
}

/** Something the walk met and could not read. */
export interface UnscannedSceneItem {
  scenePath: string;
  reason: string;
  /**
   * True when `scenePath` exists and reading it failed (a permission error, a
   * directory in its place). Different from the other entries, which are files
   * of a kind the scan does not read: this one it set out to read and could
   * not, so a caller that must not launch on an incomplete scan can tell.
   */
  readFailed?: true;
  /**
   * True for a scene reference that could not be resolved to a file inside the
   * project, so nothing was read for it. Like `readFailed`, the scan set out
   * to follow it and could not.
   */
  unresolved?: true;
  /**
   * True for a statement of a scene file the scan read but could not take as
   * written (an entry of `TscnScan.malformed`). The file was read in part: the
   * engine may load something from that statement that the scan did not see,
   * so a caller that must not launch on an incomplete scan treats it like
   * `readFailed`.
   */
  malformed?: true;
}

export interface SceneScriptCollection {
  /** Absolute paths of the `.gd` files every reachable scene attaches. */
  scripts: string[];
  inlineScripts: InlineSceneScript[];
  unscanned: UnscannedSceneItem[];
}

function resPathOf(attrs: Map<string, string>): string | null {
  const path = attrs.get('path');
  return path !== undefined && path.startsWith(TSCN_RES_PREFIX) ? path : null;
}

/**
 * Transitively walk the scenes `scenePath` references and collect, from every
 * reachable scene, the `.gd` files its ext_resources name and the source of
 * its inline GDScript sub-resources. A hostile script attached to a
 * PackedScene the launched scene instances is invisible to a single-scene scan.
 *
 * An `ext_resource` is classified by its path as well as by its `type`
 * attribute. The engine loads the file the path names, and `type` is a hint a
 * hand-edited scene can set to anything: a `.gd` path is scanned and a `.tscn`
 * or `.scn` path is walked whatever the hint says, and so is a `.tres`. A reference the walk does
 * not follow and that can still bring a script in (a script that is not
 * GDScript, a binary `.res` resource, a reference with no `res://` path)
 * is listed in `unscanned`, never dropped.
 *
 * Cycle-safe: scene graphs can reference each other, so a scene already walked
 * (by resolved absolute path) is never walked again. Nothing throws on a stale
 * reference or on a file that cannot be read; whatever could not be read is
 * listed in `unscanned` so the caller can say the scan was incomplete.
 */
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
      // The file is there and could not be read. One entry for it, and the
      // walk goes on: a throw here used to abandon every scene and autoload
      // the caller had not reached yet, with nothing naming them.
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
      } else if (header.tag === 'sub_resource' && header.attrs.get('type') === 'GDScript') {
        const id = header.attrs.get('id') ?? '?';
        const source = header.stringProps.get(INLINE_SCRIPT_SOURCE_KEY);
        if (source === undefined) skip(`inline GDScript ${id} has no readable script/source`);
        else inlineScripts.push({ scenePath: absScenePath, id, source, line: header.line });
      }
    }
    // A malformed header loses the properties under it whatever its tag was,
    // and a malformed statement may hold something the engine loads, so each
    // is reported, up to a cap: a file of nothing but broken lines says so
    // once, not once per line.
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

/**
 * Extract the `[ext_resource path="res://....gd"]` references of one scene as
 * absolute filesystem paths under the project root, whatever their `type`
 * attribute says (see `collectSceneScripts`).
 *
 * Does not chase subscenes (use `collectSceneScripts` for the transitive walk)
 * and does not read inline `[sub_resource type="GDScript"]` source. Returns
 * paths even when the file does not exist on disk; the caller owns the
 * existence check. A missing scene yields `[]`.
 */
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

/** The `string[]` view of `collectSceneScripts`: every `.gd` path the walk reaches. */
export function collectSceneScriptsRecursive(scenePath: string, projectDir: string): string[] {
  return collectSceneScripts(scenePath, projectDir).scripts;
}
