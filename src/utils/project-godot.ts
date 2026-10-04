/**
 * The one reader of `project.godot`. Text parsing, no Godot process.
 *
 * Two layers:
 *  - `scanProjectFile` reads the file into statements (`key=value` under a
 *    section), section headers and the lines it could not read, each with the
 *    line indexes it covers, so a caller that edits the file can find the exact
 *    lines a statement occupies.
 *  - `readProjectSettings` folds that scan into the `{ section: { key: value } }`
 *    shape `get_project_settings` returns.
 *
 * The grammar is Godot's: `;` outside a string starts a comment, a value may
 * span lines inside a string or brackets, and a comment may follow a section
 * header. This file may import from `scene-parsing.ts`; that file must never
 * import this one back.
 */

import { readQuoted } from './scene-parsing.js';

export type SettingsValue = string | number | boolean | null;

export interface ParsedSettings {
  settings: Record<string, Record<string, SettingsValue>>;
  warnings: string[];
}

/** One `key=value` statement and the lines it occupies. */
export interface ProjectStatement {
  section: string;
  key: string;
  /** The value text as written, trimmed, with comments left out. */
  raw: string;
  /** The converted value; null when the value is empty. */
  value: SettingsValue;
  unterminated: boolean;
  /** 0-based index into `content.split('\n')`. */
  startLine: number;
  /** 0-based index into `content.split('\n')`, inclusive. */
  endLine: number;
}

/** One section header and the lines that belong to it. */
export interface ProjectSection {
  name: string;
  /** 0-based index into `content.split('\n')`. */
  headerLine: number;
  /** Index of the next header line, or the line count; exclusive. */
  endLine: number;
  /** True when a comment follows the closing bracket on the header line. */
  headerHasComment: boolean;
}

export interface ProjectFileScan {
  statements: ProjectStatement[];
  sections: ProjectSection[];
  /** Lines that are neither blank, a comment, a header nor a statement; `text` is trimmed. */
  unparsed: Array<{ section: string; line: number; text: string }>;
}

/** Settings keys that precede every section header are reported under this name. */
export const GLOBAL_SECTION = '__global__';

/** Longest slice of an unparsed line quoted in a warning. */
const UNPARSED_LINE_SNIPPET_MAX = 120;

// Godot section headers are a bare identifier-ish name in brackets on its own
// line (e.g. "[input]"), never containing commas or spaces the way a
// multi-line array/dict literal's closing lines can. Used only to cap a runaway
// multi-line value at the next real section boundary.
const SECTION_HEADER_REGEX = /^\[[A-Za-z0-9_/.]+\]$/;

/** A statement-level header: any bracketed line. */
const SECTION_LINE_REGEX = /^\[.*\]$/;

const NUMBER_VALUE_REGEX = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Outside a string, starts a comment that runs to the end of the line. */
const COMMENT_START = ';';

/**
 * The section a statement line opens, or null when the line is not a header.
 * A comment may follow the closing bracket, as Godot's own parser allows.
 */
function sectionNameOf(line: string): string | null {
  const commentAt = line.indexOf(COMMENT_START);
  if (commentAt !== -1) {
    const statement = line.slice(0, commentAt).trimEnd();
    if (SECTION_LINE_REGEX.test(statement)) return statement.slice(1, -1);
  }
  return SECTION_LINE_REGEX.test(line) ? line.slice(1, -1) : null;
}

interface RawValue {
  raw: string;
  /** Index of the line break that ended the value, or the content length. */
  end: number;
  unterminated: boolean;
}

/**
 * Read one value starting at `start` (just after the `=`). Quoted strings keep
 * their backslash escapes and may span lines; `{ [ (` depth is tracked outside
 * strings, and the value ends at the first line break at depth zero outside a
 * string. While inside brackets, a following line that is a section header ends
 * the value as unterminated, so a malformed file cannot swallow the rest of it.
 * A `;` outside a string starts a comment that runs to the end of its line, as
 * it does for Godot's own parser: the comment is left out of the value, and a
 * quote or bracket inside it opens nothing.
 */
function readRawValue(content: string, start: number): RawValue {
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
      if (SECTION_HEADER_REGEX.test(nextLine)) {
        return { raw: valueUpTo(i), end: i, unterminated: true };
      }
    }
    i++;
  }
  return { raw: valueUpTo(length), end: length, unterminated: inString || depth > 0 };
}

/**
 * Convert a trimmed, non-empty raw value. A lone quoted string is unescaped;
 * `true`, `false` and plain numbers are typed; everything else (constructors
 * such as `PackedStringArray(...)`, arrays, dictionaries) stays its raw text.
 */
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

/**
 * Read `project.godot` text into statements, sections and unparsed lines. Line
 * indexes are counted in `\n` as the read position advances, so they index
 * `content.split('\n')` whatever the file's line endings are, and a value that
 * spans lines reports every line it covers.
 */
export function scanProjectFile(content: string): ProjectFileScan {
  const statements: ProjectStatement[] = [];
  const sections: ProjectSection[] = [];
  const unparsed: ProjectFileScan['unparsed'] = [];
  let currentSection = GLOBAL_SECTION;
  let openSection: ProjectSection | null = null;

  let pos = 0;
  let lineIndex = 0;
  while (pos < content.length) {
    const newlineAt = content.indexOf('\n', pos);
    const lineEnd = newlineAt === -1 ? content.length : newlineAt;
    const rawLine = content.slice(pos, lineEnd);
    const line = rawLine.trim();
    if (line === '' || line.startsWith(COMMENT_START) || line.startsWith('#')) {
      pos = lineEnd + 1;
      lineIndex++;
      continue;
    }
    const sectionName = sectionNameOf(line);
    if (sectionName !== null) {
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
    const equalsAt = rawLine.indexOf('=');
    const key = equalsAt === -1 ? '' : rawLine.slice(0, equalsAt).trim();
    if (key === '') {
      unparsed.push({ section: currentSection, line: lineIndex, text: line });
      pos = lineEnd + 1;
      lineIndex++;
      continue;
    }

    const value = readRawValue(content, pos + equalsAt + 1);
    const endLine = lineIndex + countLineBreaks(content, pos, value.end);
    statements.push({
      section: currentSection,
      key,
      raw: value.raw,
      value: value.raw === '' ? null : convertSettingsValue(value.raw),
      unterminated: value.unterminated,
      startLine: lineIndex,
      endLine,
    });
    pos = value.end + 1;
    lineIndex = endLine + 1;
  }

  if (openSection !== null) openSection.endLine = countLineBreaks(content, 0, content.length) + 1;
  return { statements, sections, unparsed };
}

/**
 * Parse `project.godot` text into `{ [section]: { [key]: value } }`, with the
 * warnings a reader needs to trust it: unterminated and empty values, and the
 * lines that were skipped. Sections and keys are held on prototype-free
 * objects, so a `[__proto__]` section is an ordinary entry.
 */
export function readProjectSettings(content: string): ParsedSettings {
  const scan = scanProjectFile(content);
  const settings: ParsedSettings['settings'] = Object.create(null);
  const warnings: string[] = [];

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
    const section = (settings[statement.section] ??= Object.create(null));
    section[statement.key] = statement.value;
  }

  if (scan.unparsed.length > 0) {
    warnings.push(
      `${scan.unparsed.length} line(s) could not be parsed and were skipped; first: ${scan.unparsed[0]!.text.slice(0, UNPARSED_LINE_SNIPPET_MAX)}`,
    );
  }
  return { settings, warnings };
}

/**
 * The statement that sets `key` in `section`, or undefined. With the key
 * written more than once the LAST statement is returned, the one the engine
 * keeps.
 */
export function findSetting(
  scan: ProjectFileScan,
  section: string,
  key: string,
): ProjectStatement | undefined {
  for (let i = scan.statements.length - 1; i >= 0; i--) {
    const statement = scan.statements[i]!;
    if (statement.section === section && statement.key === key) return statement;
  }
  return undefined;
}
