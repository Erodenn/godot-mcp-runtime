/** The one reader of `project.godot`: accepts the canonical form Godot writes and lists anything else in `nonCanonical`; a caller deciding from the file must treat a non-empty list as 'not read reliably'. A setting's identity is its full path (`section/key`), the last assignment wins, and lookups go by path.
 * May import from `scene-parsing.ts`; that file must never import this one back. */

import { readQuoted } from './scene-parsing.js';

export type SettingsValue = string | number | boolean | null;

export interface ParsedSettings {
  settings: Record<string, Record<string, SettingsValue>>;
  warnings: string[];
}

export interface ProjectStatement {
  section: string;
  key: string;
  /** The setting the engine assigns: `section/key`, or `key` alone before any header. */
  path: string;
  raw: string;
  /** The converted value; null when the value is empty. */
  value: SettingsValue;
  unterminated: boolean;
  /** True when the value is exactly one quoted string (`"..."`), which `value` then holds unescaped. */
  quotedString: boolean;
  /** False when the statement is not in the form Godot writes; it is then also in `nonCanonical`. */
  canonical: boolean;
  /** 0-based index into `content.split('\n')`. */
  startLine: number;
  /** 0-based index into `content.split('\n')`, inclusive. */
  endLine: number;
}

export interface ProjectSection {
  name: string;
  /** 0-based index into `content.split('\n')`. */
  headerLine: number;
  /** Index of the next header line, or the line count; exclusive. */
  endLine: number;
  headerHasComment: boolean;
}

export interface NonCanonicalStatement {
  section: string;
  /** 0-based index into `content.split('\n')`; the first line of a statement that spans several. */
  line: number;
  text: string;
  /** What is not canonical about it, worded to stand in parentheses after the line number. */
  reason: string;
  /** True when the line was still read as a statement, which is then in `statements` with `canonical: false`. */
  isStatement: boolean;
}

export interface ProjectFileScan {
  statements: ProjectStatement[];
  sections: ProjectSection[];
  unparsed: Array<{ section: string; line: number; text: string }>;
  /** Every line not in canonical form, in file order; empty for a file Godot wrote. */
  nonCanonical: NonCanonicalStatement[];
}

/** Settings keys that precede every section header are reported under this name. */
export const GLOBAL_SECTION = '__global__';

/** Non-canonical lines named one by one in a warning before the `+N more` tail. */
const NON_CANONICAL_LINES_SHOWN_MAX = 5;

const REASON_HASH_LINE = "'#' does not start a comment in project.godot, only ';' does";
const REASON_HEADER = 'a section header must be alone on its line, written as [name]';
const REASON_NO_ASSIGNMENT = 'not a key=value statement';
const REASON_KEY = 'the key is not written the way Godot writes one';
const REASON_NO_VALUE = 'no value follows the = on its line';
const REASON_VALUE = 'the value is not one complete value with nothing after it';

/** A header as Godot writes it: `[name]`, then only blanks or a comment; the name may hold a blank (`[My Addon]`) but not start with one. */
const CANONICAL_HEADER_REGEX = /^\[(?=[^\s[\]"=;#\\])[^\r\n[\]"=;#\\]+\][ \t\r]*(?:;.*)?$/;
/** Characters that make Godot quote a key when it writes one; so does a blank or control character. */
const KEY_QUOTING_CHARACTERS: ReadonlySet<string> = new Set(['=', '"', ';', '[', ']']);
/** The highest character code Godot treats as blank in a key. */
const KEY_BLANK_MAX_CODE = 32;
const KEY_DELETE_CODE = 127;
/** The two escapes Godot writes inside a quoted key are `\\` and `\"`; any other is not canonical. */
const NON_CANONICAL_KEY_ESCAPE_REGEX = /\\[^\\"]/;
const HASH = '#';
const QUOTE = '"';
/** Leads a StringName (`&"x"`) or NodePath (`^"x"`, `@"x"`) string value. */
const STRING_PREFIX_CHARACTERS: ReadonlySet<string> = new Set(['&', '^', '@']);
/** A number as Godot writes one, matched at a position. */
const NUMBER_AT_REGEX = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
/** Negative infinity as engines from 4.4 write it. */
const NEGATIVE_INFINITY = '-inf';

/** The characters of a section name as Godot writes one (`[input]`, `[rendering/quality]`). */
const SECTION_NAME_REGEX = /^[A-Za-z0-9_/.-]+$/;

/** Bare words that are complete values, so `[true]` is an array and never a header. */
const VALUE_BARE_WORDS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
  'nil',
  'inf',
  'inf_neg',
  'nan',
]);

const IDENTIFIER_START_REGEX = /[A-Za-z_]/;
const IDENTIFIER_PART_REGEX = /[A-Za-z0-9_]/;
/** A string in any of its forms (`"x"`, `&"name"`, `^"path"`, `@"path"`), or a dictionary. */
const QUOTED_OR_DICTIONARY_START_REGEX = /^(?:[&^@]?"|\{)/;
/** The leading run of characters a number can be made of. */
const NUMBER_TOKEN_REGEX = /^[0-9.+-][0-9.eE+-]*/;
const ARRAY_OPEN = '[';
const CONSTRUCTOR_OPEN = '(';

/** A statement-level header: any bracketed line. */
const SECTION_LINE_REGEX = /^\[.*\]$/;

const NUMBER_VALUE_REGEX = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Outside a string, starts a comment that runs to the end of the line. */
const COMMENT_START = ';';

/** The section a statement line opens, or null; a comment may follow the bracket, as Godot's parser allows. */
function sectionNameOf(line: string): string | null {
  const commentAt = line.indexOf(COMMENT_START);
  if (commentAt !== -1) {
    const statement = line.slice(0, commentAt).trimEnd();
    if (SECTION_LINE_REGEX.test(statement)) return statement.slice(1, -1).trim();
  }
  return SECTION_LINE_REGEX.test(line) ? line.slice(1, -1).trim() : null;
}

/** True when a bracketed line can only be a section header: `[2]`, `[1.5]` and `[true]` are one-element arrays and part of a multi-line value, while `[autoload]` is not a value in any position. */
function isSectionOnlyHeader(line: string): boolean {
  const name = sectionNameOf(line);
  return (
    name !== null &&
    SECTION_NAME_REGEX.test(name) &&
    !NUMBER_VALUE_REGEX.test(name) &&
    !VALUE_BARE_WORDS.has(name)
  );
}

export function settingPath(section: string, key: string): string {
  return section === GLOBAL_SECTION ? key : `${section}/${key}`;
}

interface RawValue {
  raw: string;
  end: number;
  unterminated: boolean;
}

/** Reads one value starting just after the `=`: quoted strings keep escapes and may span lines, `{ [ (` depth is tracked outside strings, and the value ends at the first depth-zero line break. Inside brackets a following line that can only be a section header ends the value as unterminated, so a malformed file cannot swallow the rest.
 * A `;` outside a string starts a comment, left out of the value. `stopAtHeaders: false` is for a value already known balanced (`canonicalValueEnd`). */
function readRawValue(content: string, start: number, stopAtHeaders = true): RawValue {
  const length = content.length;
  let depth = 0;
  let inString = false;
  let kept = '';
  let keptFrom = start;
  let i = start;
  const valueUpTo = (end: number): string => (kept + content.slice(keptFrom, end)).trim();
  while (i < length) {
    const ch = content[i]!;
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === COMMENT_START) {
      kept += content.slice(keptFrom, i);
      const commentEnd = content.indexOf('\n', i);
      i = commentEnd === -1 ? length : commentEnd;
      keptFrom = i;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
    } else if ((ch === '}' || ch === ']' || ch === ')') && depth > 0) {
      depth--;
    } else if (ch === '\n') {
      if (depth === 0) return { raw: valueUpTo(i), end: i, unterminated: false };
      const nextEnd = content.indexOf('\n', i + 1);
      const nextLine = content.slice(i + 1, nextEnd === -1 ? length : nextEnd).trim();
      if (stopAtHeaders && isSectionOnlyHeader(nextLine)) {
        return { raw: valueUpTo(i), end: i, unterminated: true };
      }
    }
    i++;
  }
  return { raw: valueUpTo(length), end: length, unterminated: inString || depth > 0 };
}

/** Where the value of a statement whose `=` ends its line starts, or -1: Godot skips blanks, breaks and comments before a value, so `Key=` with the value on a later line is one statement, but the next statement, a header or end of file is not a value. */
function findDeferredValueStart(content: string, from: number): number {
  const length = content.length;
  let i = from;
  while (i < length) {
    const ch = content[i]!;
    if (ch === COMMENT_START) {
      const lineEnd = content.indexOf('\n', i);
      if (lineEnd === -1) return -1;
      i = lineEnd + 1;
      continue;
    }
    if (ch.trim() === '') {
      i++;
      continue;
    }
    break;
  }
  if (i >= length) return -1;

  const lineEnd = content.indexOf('\n', i);
  const rest = content.slice(i, lineEnd === -1 ? length : lineEnd);
  const endsToken = (tokenLength: number): boolean => {
    const after = rest.slice(tokenLength).trim();
    return after === '' || after.startsWith(COMMENT_START);
  };

  if (rest[0] === ARRAY_OPEN) return isSectionOnlyHeader(rest.trim()) ? -1 : i;
  if (QUOTED_OR_DICTIONARY_START_REGEX.test(rest)) return i;
  const numberToken = NUMBER_TOKEN_REGEX.exec(rest)?.[0];
  if (numberToken !== undefined) {
    return NUMBER_VALUE_REGEX.test(numberToken) && endsToken(numberToken.length) ? i : -1;
  }
  if (!IDENTIFIER_START_REGEX.test(rest[0]!)) return -1;

  let wordEnd = 0;
  while (wordEnd < rest.length && IDENTIFIER_PART_REGEX.test(rest[wordEnd]!)) wordEnd++;
  const follower = rest.slice(wordEnd).trimStart()[0] ?? '';
  if (follower === CONSTRUCTOR_OPEN || follower === ARRAY_OPEN) return i;
  return endsToken(wordEnd) && VALUE_BARE_WORDS.has(rest.slice(0, wordEnd)) ? i : -1;
}

/** True when `ch` is a blank or control character, which Godot never writes in an unquoted key. */
function isKeyBlank(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code <= KEY_BLANK_MAX_CODE || code === KEY_DELETE_CODE;
}

/** True when Godot writes this key inside quotes: it holds a blank, a control character or one of `= " ; [ ]`. */
function keyNeedsQuoting(key: string): boolean {
  for (const ch of key) {
    if (isKeyBlank(ch) || KEY_QUOTING_CHARACTERS.has(ch)) return true;
  }
  return false;
}

function isCanonicalUnquotedKey(text: string): boolean {
  return text !== '' && !text.startsWith(HASH) && !keyNeedsQuoting(text);
}

/** Index just past the closing quote of the string whose opening quote is at `quoteAt`, or -1. */
function stringEnd(content: string, quoteAt: number): number {
  for (let i = quoteAt + 1; i < content.length; i++) {
    const ch = content[i];
    if (ch === '\\') i++;
    else if (ch === QUOTE) return i + 1;
  }
  return -1;
}

/** Index just past the bracket closing the one at `openAt`, or -1; strings and `;` comments inside are skipped as `readRawValue` skips them. */
function balancedEnd(content: string, openAt: number): number {
  let depth = 0;
  let i = openAt;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === QUOTE) {
      i = stringEnd(content, i);
      if (i === -1) return -1;
      continue;
    }
    if (ch === COMMENT_START) {
      i = content.indexOf('\n', i);
      if (i === -1) return -1;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/** Index just past the one value at `start`, or -1 when it is not a form Godot writes; the inside of brackets is only balanced, not checked. */
function oneValueEnd(content: string, start: number): number {
  const ch = content[start];
  if (ch === undefined) return -1;
  if (ch === QUOTE) return stringEnd(content, start);
  if (STRING_PREFIX_CHARACTERS.has(ch)) {
    return content[start + 1] === QUOTE ? stringEnd(content, start + 1) : -1;
  }
  if (ch === '{' || ch === ARRAY_OPEN) return balancedEnd(content, start);

  let wordEnd = start;
  if (content.startsWith(NEGATIVE_INFINITY, start)) wordEnd = start + NEGATIVE_INFINITY.length;
  else if (IDENTIFIER_START_REGEX.test(ch)) wordEnd = start + 1;
  if (wordEnd > start) {
    while (wordEnd < content.length && IDENTIFIER_PART_REGEX.test(content[wordEnd]!)) wordEnd++;
    const follower = content[wordEnd];
    if (follower === CONSTRUCTOR_OPEN) return balancedEnd(content, wordEnd);
    if (follower === ARRAY_OPEN) {
      const typeEnd = balancedEnd(content, wordEnd);
      return typeEnd !== -1 && content[typeEnd] === CONSTRUCTOR_OPEN
        ? balancedEnd(content, typeEnd)
        : -1;
    }
    const word = content.slice(start, wordEnd);
    return VALUE_BARE_WORDS.has(word) || word === NEGATIVE_INFINITY ? wordEnd : -1;
  }

  NUMBER_AT_REGEX.lastIndex = start;
  const number = NUMBER_AT_REGEX.exec(content);
  return number === null ? -1 : start + number[0].length;
}

/** Where a canonical value after the `=` ends (the line break after it), or -1 unless it is exactly one value starting on this line followed only by blanks or a `;` comment. */
function canonicalValueEnd(content: string, start: number): number {
  let i = start;
  while (content[i] === ' ' || content[i] === '\t') i++;
  i = oneValueEnd(content, i);
  if (i === -1) return -1;
  while (content[i] === ' ' || content[i] === '\t' || content[i] === '\r') i++;
  if (i >= content.length) return content.length;
  if (content[i] === '\n') return i;
  if (content[i] !== COMMENT_START) return -1;
  const lineEnd = content.indexOf('\n', i);
  return lineEnd === -1 ? content.length : lineEnd;
}

interface StatementKey {
  key: string;
  equalsAt: number;
  canonical: boolean;
}

/** Reads the key of a statement line, or null. A quoted key directly followed by `=` is read as the engine reads it and is canonical only if Godot would have quoted it; any other line splits at its first `=`. */
function readStatementKey(rawLine: string): StatementKey | null {
  const keyStart = rawLine.length - rawLine.trimStart().length;
  if (rawLine[keyStart] === QUOTE) {
    const quoted = readQuoted(rawLine, keyStart, rawLine.length);
    if (quoted !== null && rawLine[quoted.end] === '=' && quoted.value !== '') {
      const written = rawLine.slice(keyStart + 1, quoted.end - 1);
      return {
        key: quoted.value,
        equalsAt: quoted.end,
        canonical: keyNeedsQuoting(quoted.value) && !NON_CANONICAL_KEY_ESCAPE_REGEX.test(written),
      };
    }
  }
  const equalsAt = rawLine.indexOf('=');
  if (equalsAt === -1) return null;
  const key = rawLine.slice(0, equalsAt).trim();
  if (key === '') return null;
  return { key, equalsAt, canonical: isCanonicalUnquotedKey(key) };
}

/** Converts a trimmed raw value: a lone quoted string is unescaped, `true`/`false`/numbers are typed, everything else stays raw text. */
function convertSettingsValue(raw: string): SettingsValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('"')) {
    const quoted = readQuoted(raw, 0, raw.length);
    return quoted !== null && quoted.end === raw.length ? quoted.value : raw;
  }
  return NUMBER_VALUE_REGEX.test(raw) ? Number(raw) : raw;
}

function countLineBreaks(content: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i++) {
    if (content[i] === '\n') count++;
  }
  return count;
}

/** Reads `project.godot` text into statements, sections, unparsed and non-canonical lines. Line indexes count `\n` as the read advances, so they index `content.split('\n')` whatever the line endings, and a multi-line value reports every line it covers. */
export function scanProjectFile(content: string): ProjectFileScan {
  const statements: ProjectStatement[] = [];
  const sections: ProjectSection[] = [];
  const unparsed: ProjectFileScan['unparsed'] = [];
  const nonCanonical: NonCanonicalStatement[] = [];
  let currentSection = GLOBAL_SECTION;
  let openSection: ProjectSection | null = null;

  let pos = 0;
  let lineIndex = 0;
  while (pos < content.length) {
    const newlineAt = content.indexOf('\n', pos);
    const lineEnd = newlineAt === -1 ? content.length : newlineAt;
    const rawLine = content.slice(pos, lineEnd);
    const line = rawLine.trim();
    const section = currentSection;
    const lineOfStatement = lineIndex;
    const flag = (reason: string, isStatement: boolean): void => {
      nonCanonical.push({ section, line: lineOfStatement, text: line, reason, isStatement });
    };
    if (line === '' || line.startsWith(COMMENT_START)) {
      pos = lineEnd + 1;
      lineIndex++;
      continue;
    }
    if (line.startsWith(HASH)) {
      flag(REASON_HASH_LINE, false);
      pos = lineEnd + 1;
      lineIndex++;
      continue;
    }
    const sectionName = sectionNameOf(line);
    if (sectionName !== null) {
      if (!CANONICAL_HEADER_REGEX.test(line)) flag(REASON_HEADER, false);
      currentSection = sectionName;
      if (openSection !== null) openSection.endLine = lineIndex;
      openSection = {
        name: sectionName,
        headerLine: lineIndex,
        endLine: lineIndex + 1,
        headerHasComment: line !== `[${sectionName}]`,
      };
      sections.push(openSection);
      pos = lineEnd + 1;
      lineIndex++;
      continue;
    }
    const statementKey = readStatementKey(rawLine);
    if (statementKey === null) {
      unparsed.push({ section: currentSection, line: lineIndex, text: line });
      flag(line.startsWith(ARRAY_OPEN) ? REASON_HEADER : REASON_NO_ASSIGNMENT, false);
      pos = lineEnd + 1;
      lineIndex++;
      continue;
    }

    const valueStart = pos + statementKey.equalsAt + 1;
    const canonicalEnd = statementKey.canonical ? canonicalValueEnd(content, valueStart) : -1;
    let value = readRawValue(content, valueStart, canonicalEnd === -1);
    const canonical = canonicalEnd !== -1 && value.end === canonicalEnd && !value.unterminated;
    if (!canonical) {
      const emptyOnItsLine = value.raw === '' && !value.unterminated;
      if (line.startsWith(ARRAY_OPEN)) flag(REASON_HEADER, true);
      else if (!statementKey.canonical) flag(REASON_KEY, true);
      else flag(emptyOnItsLine ? REASON_NO_VALUE : REASON_VALUE, true);
      if (emptyOnItsLine) {
        const deferredStart = findDeferredValueStart(content, value.end);
        if (deferredStart !== -1) value = readRawValue(content, deferredStart);
      }
    }
    const endLine = lineIndex + countLineBreaks(content, pos, value.end);
    const quoted = value.raw.startsWith(QUOTE) ? readQuoted(value.raw, 0, value.raw.length) : null;
    statements.push({
      section: currentSection,
      key: statementKey.key,
      path: settingPath(currentSection, statementKey.key),
      raw: value.raw,
      value: value.raw === '' ? null : convertSettingsValue(value.raw),
      unterminated: value.unterminated,
      quotedString: quoted !== null && quoted.end === value.raw.length,
      canonical,
      startLine: lineIndex,
      endLine,
    });
    pos = value.end + 1;
    lineIndex = endLine + 1;
  }

  if (openSection !== null) openSection.endLine = countLineBreaks(content, 0, content.length) + 1;
  return { statements, sections, unparsed, nonCanonical };
}

/** One sentence naming the non-canonical lines (the first `NON_CANONICAL_LINES_SHOWN_MAX`, with 1-based line numbers), or null. */
export function describeNonCanonical(scan: ProjectFileScan): string | null {
  const total = scan.nonCanonical.length;
  if (total === 0) return null;
  const shown = scan.nonCanonical
    .slice(0, NON_CANONICAL_LINES_SHOWN_MAX)
    .map((item) => `line ${item.line + 1} (${item.reason})`);
  if (total > shown.length) shown.push(`+${total - shown.length} more`);
  return `project.godot has ${total} line(s) that are not in the form Godot writes, so the engine may read them differently from what is reported here: ${shown.join('; ')}`;
}

/** The statement assigning the setting at `path`, or undefined; however the file spells it, the LAST assignment is returned, the one the engine keeps. */
export function findSettingByPath(
  scan: ProjectFileScan,
  path: string,
): ProjectStatement | undefined {
  for (let i = scan.statements.length - 1; i >= 0; i--) {
    const statement = scan.statements[i]!;
    if (statement.path === path) return statement;
  }
  return undefined;
}

/** The statement that sets `key` of `section`, or undefined; found by the setting's full path, so another section split or the top level also matches. */
export function findSetting(
  scan: ProjectFileScan,
  section: string,
  key: string,
): ProjectStatement | undefined {
  return findSettingByPath(scan, settingPath(section, key));
}

/** Parses `project.godot` text into `{ [section]: { [key]: value } }` with the warnings a reader needs to trust it (unterminated and empty values, non-canonical lines, a setting under several spellings, listing only the assignment the engine keeps).
 * Held on prototype-free objects, so a `[__proto__]` section is an ordinary entry. */
export function readProjectSettings(content: string): ParsedSettings {
  const scan = scanProjectFile(content);
  const settings: ParsedSettings['settings'] = Object.create(null);
  const warnings: string[] = [];
  const winners = new Map<string, ProjectStatement>();
  for (const statement of scan.statements) winners.set(statement.path, statement);

  for (const statement of scan.statements) {
    const location = `${statement.section}/${statement.key}`;
    if (statement.unterminated) {
      warnings.push(
        `Value of ${location} is unterminated and was returned as far as it could be read`,
      );
    }
    if (statement.raw === '' && !statement.unterminated) {
      warnings.push(`Value of ${location} is empty and is null`);
    }
    const winner = winners.get(statement.path)!;
    if (winner.section !== statement.section || winner.key !== statement.key) {
      warnings.push(
        `${location} (line ${statement.startLine + 1}) is not listed: line ${winner.startLine + 1} assigns the same setting as ${winner.section}/${winner.key}, and the engine keeps the last assignment`,
      );
      continue;
    }
    const section = (settings[statement.section] ??= Object.create(null));
    section[statement.key] = statement.value;
  }

  const nonCanonical = describeNonCanonical(scan);
  if (nonCanonical !== null) warnings.push(nonCanonical);
  return { settings, warnings };
}
