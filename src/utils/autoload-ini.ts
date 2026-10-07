import { readFileSync } from 'fs';
import { writeFileAtomicSync } from './atomic-write.js';
import {
  describeNonCanonical,
  scanProjectFile,
  type ProjectFileScan,
  type ProjectStatement,
} from './project-godot.js';

/**
 * Parsing and editing primitives for the autoloads of project.godot.
 *
 * Used by:
 *  - tools/autoload-tools.ts — list/add/remove/update_autoload handlers
 *  - utils/bridge-manager.ts — McpBridge inject/cleanup/repair
 *
 * Pure functions: each takes the absolute path to project.godot and returns
 * either parsed data or a boolean indicating whether the file was mutated.
 *
 * An autoload is the setting `autoload/<Name>`, however the file spells it:
 * `Name=` under `[autoload]`, or a top-level `autoload/Name=` line. The
 * statements are found with the one project.godot reader (`scanProjectFile` in
 * `project-godot.ts`) and matched by setting path, so a header or entry
 * followed by a `; comment`, a second `[autoload]` section and a top-level
 * spelling are all found. A name assigned more than once has one entry, the
 * last assignment, which is the one the engine keeps.
 *
 * An entry is a statement in the form Godot writes whose value is exactly one
 * quoted string. Anything else that assigns an autoload is reported as
 * unparsed and is never read, rewritten or removed as an entry: what the
 * engine loads from such a line is not known here.
 *
 * The writers edit whole lines and leave every line they do not touch byte for
 * byte as it was, line ending included.
 */

export interface AutoloadEntry {
  name: string;
  path: string;
  singleton: boolean;
}

/** What `parseAutoloadSection` read. */
export interface ParsedAutoloads {
  /** One entry per name, in the order the engine initialises them. */
  entries: AutoloadEntry[];
  /** Trimmed source lines that register something the reader could not turn into an entry. */
  unparsed: string[];
  /** Assignments a later line overrides, worded for a warning. They are not in `entries`. */
  shadowed: string[];
  /**
   * Set when any line of the file, in any section, is not in the form Godot
   * writes: the sentence that names those lines. The engine may register an
   * autoload from such a line that `entries` does not hold, so a caller that
   * lists or scans autoloads must pass it on.
   */
  nonCanonical: string | null;
}

/**
 * The name rule the parser applies to an entry's key. Enforced on write paths
 * to prevent a name with newlines or INI section delimiters from corrupting
 * project.godot.
 */
export const VALID_AUTOLOAD_NAME_REGEX = /^\w+$/;

const AUTOLOAD_SECTION = 'autoload';
const AUTOLOAD_HEADER = '[autoload]';
/** Leads the setting path of every autoload: `autoload/<Name>`. */
const AUTOLOAD_PATH_PREFIX = 'autoload/';
/** Leads an entry's value when the autoload is a singleton. */
const SINGLETON_MARKER = '*';
const LF = '\n';
const CRLF = '\r\n';
/** One line with its line ending, or the last line of a file that has none. */
const LINE_WITH_ENDING_REGEX = /[^\n]*\n|[^\n]+$/g;
/** The line ending a line carries, empty for a last line without one. */
const LINE_ENDING_REGEX = /\r?\n$/;

function assertValidName(name: string): void {
  if (!VALID_AUTOLOAD_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid autoload name '${name}': must contain only word characters (letters, digits, underscore)`,
    );
  }
}

/**
 * A quote or line break in a path would end the quoted value early or split the
 * entry across lines, so it can never be written.
 */
export const AUTOLOAD_PATH_FORBIDDEN_REGEX = /["\r\n]/;

function assertValidAutoloadPath(path: string): void {
  if (AUTOLOAD_PATH_FORBIDDEN_REGEX.test(path)) {
    throw new Error('Invalid autoload path: must not contain a double quote or a line break');
  }
}

export function normalizeAutoloadPath(p: string): string {
  return p.startsWith('res://') ? p : `res://${p}`;
}

/** The setting path of the autoload called `name`. */
function autoloadSettingPath(name: string): string {
  return AUTOLOAD_PATH_PREFIX + name;
}

/** A statement that assigns an `autoload/...` setting, under any spelling. */
function isAutoloadStatement(statement: ProjectStatement): boolean {
  return statement.path.startsWith(AUTOLOAD_PATH_PREFIX);
}

/** Every statement that assigns the autoload called `name`, in file order. */
function statementsForName(scan: ProjectFileScan, name: string): ProjectStatement[] {
  const path = autoloadSettingPath(name);
  return scan.statements.filter((statement) => statement.path === path);
}

/**
 * An autoload statement that reads as an entry: a valid name, written in the
 * form Godot writes, with a value that is exactly one quoted string.
 */
type EntryStatement = ProjectStatement & { value: string };

function isEntryStatement(statement: ProjectStatement): statement is EntryStatement {
  return (
    VALID_AUTOLOAD_NAME_REGEX.test(statement.path.slice(AUTOLOAD_PATH_PREFIX.length)) &&
    statement.canonical &&
    statement.quotedString &&
    typeof statement.value === 'string'
  );
}

function toEntry(statement: EntryStatement): AutoloadEntry {
  const singleton = statement.value.startsWith(SINGLETON_MARKER);
  return {
    name: statement.path.slice(AUTOLOAD_PATH_PREFIX.length),
    singleton,
    path: singleton ? statement.value.slice(SINGLETON_MARKER.length) : statement.value,
  };
}

/** The line ending new lines are written with: CRLF when the file uses it anywhere. */
function eolOf(content: string): string {
  return content.includes(CRLF) ? CRLF : LF;
}

/**
 * The file as lines that each keep their own line ending. Element `i` is line
 * `i` of the scan (`startLine`, `endLine`, `headerLine`); joining the elements
 * unchanged gives the file back byte for byte.
 */
function splitKeepingEndings(content: string): string[] {
  return content.match(LINE_WITH_ENDING_REGEX) ?? [];
}

function lineEndingOf(line: string): string {
  return LINE_ENDING_REGEX.exec(line)?.[0] ?? '';
}

function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

/** Give the file's last line a line ending when it has none, so a line can follow it. */
function terminateLastLine(lines: string[], eol: string): void {
  const lastIdx = lines.length - 1;
  if (lastIdx >= 0 && lineEndingOf(lines[lastIdx]!) === '') lines[lastIdx] += eol;
}

/** The entry as the statement at `key` spells it: `Name` under `[autoload]`, `autoload/Name` at the top level. */
function formatEntryLine(key: string, singleton: boolean, writtenPath: string): string {
  return `${key}="${singleton ? SINGLETON_MARKER : ''}${writtenPath}"`;
}

/**
 * Escape a value read out of the file so that writing it back inside quotes
 * reads to the same value, on one line.
 */
function escapeQuotedValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/** The first source line of a statement, trimmed, for a message. */
function sourceLineOf(lines: readonly string[], statement: ProjectStatement): string {
  return (lines[statement.startLine] ?? '').trim();
}

/**
 * Read the project's autoloads. `entries` holds one entry per name: the last
 * assignment of `autoload/<Name>` in the file, listed at the position of the
 * first, which is the value and the order the engine uses. An earlier
 * assignment of the same name is in `shadowed`, never in `entries`, so a
 * caller cannot pick the wrong one.
 *
 * A line in `unparsed` is registered in the file but absent from `entries`, so
 * a caller that lists or scans autoloads must say so rather than present
 * `entries` as everything. An entry is a statement whose name is valid and
 * whose value is exactly one quoted string with nothing after it: a bare
 * value, a `&"..."` StringName and a line that carries a second statement are
 * all unparsed. `unparsed` holds the trimmed source line, the first one for a
 * statement that spans several. `nonCanonical` covers the whole file, since a
 * line outside `[autoload]` that Godot did not write may still register one.
 */
export function parseAutoloadSection(
  projectFilePath: string,
  existingContent?: string,
): ParsedAutoloads {
  const content = existingContent ?? readFileSync(projectFilePath, 'utf8');
  const scan = scanProjectFile(content);
  const lines = content.split(LF);
  const statements = scan.statements.filter(isAutoloadStatement);

  const winners = new Map<string, ProjectStatement>();
  for (const statement of statements) winners.set(statement.path, statement);

  const entries: AutoloadEntry[] = [];
  const unparsedAt: Array<{ line: number; text: string }> = [];
  const shadowed: string[] = [];
  const listed = new Set<string>();
  for (const statement of statements) {
    const winner = winners.get(statement.path)!;
    if (statement !== winner) {
      shadowed.push(
        `${sourceLineOf(lines, statement)} (line ${statement.startLine + 1}, overridden by line ${winner.startLine + 1})`,
      );
    }
    if (listed.has(statement.path)) continue;
    listed.add(statement.path);
    if (isEntryStatement(winner)) {
      entries.push(toEntry(winner));
    } else {
      unparsedAt.push({ line: winner.startLine, text: sourceLineOf(lines, winner) });
    }
  }
  for (const skipped of scan.nonCanonical) {
    if (!skipped.isStatement && skipped.section === AUTOLOAD_SECTION) unparsedAt.push(skipped);
  }
  unparsedAt.sort((a, b) => a.line - b.line);
  return {
    entries,
    unparsed: unparsedAt.map((item) => item.text),
    shadowed,
    nonCanonical: describeNonCanonical(scan),
  };
}

/** The project's autoloads, one entry per name; see `parseAutoloadSection`. */
export function parseAutoloads(projectFilePath: string, existingContent?: string): AutoloadEntry[] {
  return parseAutoloadSection(projectFilePath, existingContent).entries;
}

/**
 * Add an entry to the last `[autoload]` section, directly after its last
 * statement (or after the header when it has none). With no such section, one
 * is created at the end of the file, after one blank line.
 */
export function addAutoloadEntry(
  projectFilePath: string,
  name: string,
  path: string,
  singleton: boolean,
  existingContent?: string,
): void {
  assertValidName(name);
  assertValidAutoloadPath(path);
  const content = existingContent ?? readFileSync(projectFilePath, 'utf8');
  const eol = eolOf(content);
  const entry = formatEntryLine(name, singleton, normalizeAutoloadPath(path)) + eol;
  const scan = scanProjectFile(content);
  const lines = splitKeepingEndings(content);

  const section = scan.sections.filter((s) => s.name === AUTOLOAD_SECTION).at(-1);
  if (section === undefined) {
    terminateLastLine(lines, eol);
    const last = lines.at(-1);
    if (last !== undefined && !isBlankLine(last)) lines.push(eol);
    lines.push(AUTOLOAD_HEADER + eol, entry);
    writeFileAtomicSync(projectFilePath, lines.join(''));
    return;
  }

  const lastStatement = scan.statements
    .filter((s) => s.startLine > section.headerLine && s.startLine < section.endLine)
    .at(-1);
  const insertAt = (lastStatement?.endLine ?? section.headerLine) + 1;
  if (insertAt >= lines.length) {
    terminateLastLine(lines, eol);
    lines.push(entry);
  } else {
    lines.splice(insertAt, 0, entry);
  }
  writeFileAtomicSync(projectFilePath, lines.join(''));
}

/**
 * Every assignment of this autoload that reads as an entry, overridden ones
 * included, in file order. `parseAutoloads` gives the one the engine keeps;
 * this is for a caller that must look at the others too before removing some.
 */
export function parseAutoloadAssignments(projectFilePath: string, name: string): AutoloadEntry[] {
  const scan = scanProjectFile(readFileSync(projectFilePath, 'utf8'));
  return statementsForName(scan, name).filter(isEntryStatement).map(toEntry);
}

/**
 * Remove every assignment of this autoload, under every spelling and in every
 * `[autoload]` section, so no earlier line takes over once the last is gone.
 * With `shouldRemove`, only the assignments that read as an entry whose path
 * satisfies it are removed: an assignment it rejects, or one that does not
 * read as an entry, stays, and the last one left is what the engine then
 * loads. An `[autoload]` section left with no statements and nothing but blank
 * lines is dropped with its header, unless the header carries a comment; when
 * that section ended the file, the blank lines that separated it from what
 * precedes go with it. Every other line is kept as it was. Returns true when
 * the file was mutated.
 */
export function removeAutoloadEntry(
  projectFilePath: string,
  name: string,
  shouldRemove?: (entryPath: string) => boolean,
): boolean {
  const content = readFileSync(projectFilePath, 'utf8');
  const scan = scanProjectFile(content);
  const targets = statementsForName(scan, name).filter(
    (statement) =>
      shouldRemove === undefined ||
      (isEntryStatement(statement) && shouldRemove(toEntry(statement).path)),
  );
  if (targets.length === 0) return false;

  const lines = splitKeepingEndings(content);
  const dropped = new Set<number>();
  for (const target of targets) {
    for (let i = target.startLine; i <= target.endLine; i++) dropped.add(i);
  }

  for (const section of scan.sections) {
    if (section.name !== AUTOLOAD_SECTION || section.headerHasComment) continue;
    const bodyEnd = Math.min(section.endLine, lines.length);
    let empty = true;
    for (let i = section.headerLine + 1; i < bodyEnd && empty; i++) {
      empty = dropped.has(i) || isBlankLine(lines[i]!);
    }
    if (!empty) continue;
    for (let i = section.headerLine; i < bodyEnd; i++) dropped.add(i);
    if (bodyEnd === lines.length) {
      for (let i = section.headerLine - 1; i >= 0 && isBlankLine(lines[i]!); i--) dropped.add(i);
    }
  }

  writeFileAtomicSync(projectFilePath, lines.filter((_, index) => !dropped.has(index)).join(''));
  return true;
}

/**
 * Rewrite the assignment the engine keeps for this autoload (the last one) as
 * a single line, where it is and under the key it is written with, replacing
 * the lines the statement covered and keeping the line ending of its last
 * line. An omitted `newPath` or `singleton` keeps what the entry had. A
 * comment that followed the entry on its line is dropped. Earlier assignments
 * of the same name are overridden already and are left as they are. Returns
 * false, with the file untouched, when the name has no assignment or its last
 * one does not read as an entry.
 */
export function updateAutoloadEntry(
  projectFilePath: string,
  name: string,
  newPath?: string,
  singleton?: boolean,
): boolean {
  assertValidName(name);
  if (newPath !== undefined) assertValidAutoloadPath(newPath);
  const content = readFileSync(projectFilePath, 'utf8');
  const target = statementsForName(scanProjectFile(content), name).at(-1);
  if (target === undefined || !isEntryStatement(target)) return false;

  const lines = splitKeepingEndings(content);
  const existing = toEntry(target);
  const writtenPath =
    newPath !== undefined ? normalizeAutoloadPath(newPath) : escapeQuotedValue(existing.path);
  const line = formatEntryLine(target.key, singleton ?? existing.singleton, writtenPath);
  lines.splice(
    target.startLine,
    target.endLine - target.startLine + 1,
    line + lineEndingOf(lines[target.endLine] ?? ''),
  );
  writeFileAtomicSync(projectFilePath, lines.join(''));
  return true;
}
