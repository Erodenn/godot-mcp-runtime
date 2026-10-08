import { readFileSync } from 'fs';
import { writeFileAtomicSync } from './atomic-write.js';
import {
  describeNonCanonical,
  scanProjectFile,
  type ProjectFileScan,
  type ProjectStatement,
} from './project-godot.js';

/** Parsing and editing primitives for project.godot autoloads. An autoload is the setting `autoload/<Name>` under any spelling, found via `scanProjectFile` and matched by setting path; a name assigned more than once has one entry, the last, which the engine keeps.
 * An entry is a canonical statement whose value is exactly one quoted string; anything else that assigns an autoload is `unparsed` and never read, rewritten or removed, as what the engine loads from it is unknown. Writers edit whole lines and leave every other line byte for byte. */

export interface AutoloadEntry {
  name: string;
  path: string;
  singleton: boolean;
}

export interface ParsedAutoloads {
  /** One entry per name, in the order the engine initialises them. */
  entries: AutoloadEntry[];
  /** Trimmed source lines that register something the reader could not turn into an entry. */
  unparsed: string[];
  /** Assignments a later line overrides, worded for a warning. They are not in `entries`. */
  shadowed: string[];
  /** Set when any line of the file is not in the form Godot writes: the sentence naming them. The engine may register an autoload from such a line that `entries` does not hold, so callers listing or scanning autoloads must pass it on. */
  nonCanonical: string | null;
}

/** The name rule applied to an entry's key; enforced on writes so a name with newlines or INI delimiters cannot corrupt project.godot. */
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

/** A quote or line break in a path would end the quoted value early or split the entry, so it can never be written. */
export const AUTOLOAD_PATH_FORBIDDEN_REGEX = /["\r\n]/;

function assertValidAutoloadPath(path: string): void {
  if (AUTOLOAD_PATH_FORBIDDEN_REGEX.test(path)) {
    throw new Error('Invalid autoload path: must not contain a double quote or a line break');
  }
}

export function normalizeAutoloadPath(p: string): string {
  return p.startsWith('res://') ? p : `res://${p}`;
}

function autoloadSettingPath(name: string): string {
  return AUTOLOAD_PATH_PREFIX + name;
}

function isAutoloadStatement(statement: ProjectStatement): boolean {
  return statement.path.startsWith(AUTOLOAD_PATH_PREFIX);
}

function statementsForName(scan: ProjectFileScan, name: string): ProjectStatement[] {
  const path = autoloadSettingPath(name);
  return scan.statements.filter((statement) => statement.path === path);
}

/** An autoload statement that reads as an entry: valid name, canonical form, exactly one quoted string value. */
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

/** The file as lines that each keep their own ending; element `i` is scan line `i`, and joining them gives the file back byte for byte. */
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

/** Escapes a value so writing it back inside quotes reads to the same value on one line. */
function escapeQuotedValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function sourceLineOf(lines: readonly string[], statement: ProjectStatement): string {
  return (lines[statement.startLine] ?? '').trim();
}

/** Reads the project's autoloads. `entries` holds the last assignment of each name at the position of the first (the value and order the engine uses); earlier ones go to `shadowed` so a caller cannot pick the wrong one.
 * An `unparsed` line is registered in the file but absent from `entries` (bare value, `&"..."` StringName, second statement on the line), so callers must say so rather than present `entries` as everything; `nonCanonical` covers the whole file, as a line outside `[autoload]` may still register one. */
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

export function parseAutoloads(projectFilePath: string, existingContent?: string): AutoloadEntry[] {
  return parseAutoloadSection(projectFilePath, existingContent).entries;
}

/** Adds an entry after the last statement of the last `[autoload]` section (or its header); with no such section, creates one at the end of the file after one blank line. */
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

/** Every assignment of this autoload that reads as an entry, overridden ones included, for a caller that must see the others before removing some. */
export function parseAutoloadAssignments(projectFilePath: string, name: string): AutoloadEntry[] {
  const scan = scanProjectFile(readFileSync(projectFilePath, 'utf8'));
  return statementsForName(scan, name).filter(isEntryStatement).map(toEntry);
}

/** Removes every assignment of this autoload under every spelling and `[autoload]` section, so no earlier line takes over. With `shouldRemove`, only entry-reading assignments whose path satisfies it go; the last one left is what the engine then loads.
 * An `[autoload]` section left empty is dropped with its header unless the header carries a comment; at end of file the blank lines before it go too. Returns true when the file was mutated. */
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

/** Rewrites the assignment the engine keeps (the last) as one line, in place and under the key it was written with, keeping the last line's ending; an omitted `newPath` or `singleton` keeps the old one, a trailing comment is dropped, earlier overridden assignments are left.
 * Returns false, file untouched, when there is no assignment or the last does not read as an entry. */
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
