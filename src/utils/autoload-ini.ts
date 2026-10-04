import { readFileSync } from 'fs';
import { writeFileAtomicSync } from './atomic-write.js';
import { scanProjectFile, type ProjectFileScan, type ProjectStatement } from './project-godot.js';

/**
 * Parsing and editing primitives for the `[autoload]` section of project.godot.
 *
 * Used by:
 *  - tools/autoload-tools.ts — list/add/remove/update_autoload handlers
 *  - utils/bridge-manager.ts — McpBridge inject/cleanup/repair
 *
 * Pure functions: each takes the absolute path to project.godot and returns
 * either parsed data or a boolean indicating whether the file was mutated.
 *
 * The section is located with the project.godot grammar (`scanProjectFile` in
 * `project-godot.ts`), so a header or entry followed by a `; comment`, a value
 * that spans lines and a second `[autoload]` section are all read the way the
 * engine reads them. The writers edit whole lines of `content.split('\n')` and
 * leave every line they do not touch byte for byte as it was, line ending
 * included.
 */

export interface AutoloadEntry {
  name: string;
  path: string;
  singleton: boolean;
}

/**
 * The name rule the parser applies to an entry's key. Enforced on write paths
 * to prevent a name with newlines or INI section delimiters from corrupting
 * project.godot.
 */
export const VALID_AUTOLOAD_NAME_REGEX = /^\w+$/;

const AUTOLOAD_SECTION = 'autoload';
const AUTOLOAD_HEADER = '[autoload]';
/** Leads an entry's value when the autoload is a singleton. */
const SINGLETON_MARKER = '*';
const LF = '\n';
const CRLF = '\r\n';
const CARRIAGE_RETURN = '\r';

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

/** An `[autoload]` statement that reads as an entry: a valid name and one whole string value. */
type EntryStatement = ProjectStatement & { value: string };

function isEntryStatement(statement: ProjectStatement): statement is EntryStatement {
  return (
    VALID_AUTOLOAD_NAME_REGEX.test(statement.key) &&
    typeof statement.value === 'string' &&
    !statement.unterminated
  );
}

function autoloadStatements(scan: ProjectFileScan): ProjectStatement[] {
  return scan.statements.filter((statement) => statement.section === AUTOLOAD_SECTION);
}

function toEntry(statement: EntryStatement): AutoloadEntry {
  const singleton = statement.value.startsWith(SINGLETON_MARKER);
  return {
    name: statement.key,
    singleton,
    path: singleton ? statement.value.slice(SINGLETON_MARKER.length) : statement.value,
  };
}

/** The line ending new lines are written with: CRLF when the file uses it anywhere. */
function eolOf(content: string): string {
  return content.includes(CRLF) ? CRLF : LF;
}

/**
 * One element of `content.split('\n')` for a new line. The `\n` comes from the
 * join, so only the carriage return of a CRLF ending is carried here.
 */
function asLineElement(text: string, eol: string): string {
  return eol === CRLF ? text + CARRIAGE_RETURN : text;
}

function formatEntryLine(name: string, singleton: boolean, writtenPath: string): string {
  return `${name}="${singleton ? SINGLETON_MARKER : ''}${writtenPath}"`;
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

/**
 * Parse every `[autoload]` section, keeping the data lines it could not read.
 * A line in `unparsed` is registered in the file but absent from `entries`, so
 * a caller that lists or scans autoloads must say so rather than present
 * `entries` as the whole section.
 *
 * An entry is a statement whose key is a valid name and whose value is one
 * string: quotes are what Godot writes, and a bare value in a hand-edited file
 * is tolerated. A name written twice is listed twice. `unparsed` holds the
 * trimmed source line, the first one for a statement that spans several.
 */
export function parseAutoloadSection(
  projectFilePath: string,
  existingContent?: string,
): { entries: AutoloadEntry[]; unparsed: string[] } {
  const content = existingContent ?? readFileSync(projectFilePath, 'utf8');
  const scan = scanProjectFile(content);
  const lines = content.split(LF);
  const entries: AutoloadEntry[] = [];
  const unparsedAt: Array<{ line: number; text: string }> = [];

  for (const statement of autoloadStatements(scan)) {
    if (isEntryStatement(statement)) {
      entries.push(toEntry(statement));
    } else {
      unparsedAt.push({
        line: statement.startLine,
        text: (lines[statement.startLine] ?? '').trim(),
      });
    }
  }
  for (const skipped of scan.unparsed) {
    if (skipped.section === AUTOLOAD_SECTION) unparsedAt.push(skipped);
  }
  unparsedAt.sort((a, b) => a.line - b.line);
  return { entries, unparsed: unparsedAt.map((item) => item.text) };
}

export function parseAutoloads(projectFilePath: string, existingContent?: string): AutoloadEntry[] {
  return parseAutoloadSection(projectFilePath, existingContent).entries;
}

/**
 * Add an entry to the last `[autoload]` section, directly after its last
 * statement (or after the header when it has none). With no such section, one
 * is created at the end of the file.
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
  const entry = formatEntryLine(name, singleton, normalizeAutoloadPath(path));
  const scan = scanProjectFile(content);

  const section = scan.sections.filter((s) => s.name === AUTOLOAD_SECTION).at(-1);
  if (section === undefined) {
    writeFileAtomicSync(
      projectFilePath,
      content.trimEnd() + eol + eol + AUTOLOAD_HEADER + eol + entry + eol,
    );
    return;
  }

  const lastStatement = scan.statements
    .filter((s) => s.startLine > section.headerLine && s.startLine < section.endLine)
    .at(-1);
  const insertAt = (lastStatement?.endLine ?? section.headerLine) + 1;
  const lines = content.split(LF);
  if (insertAt >= lines.length) {
    // The file ends on the line the entry follows, with no line break after
    // it: give that line its ending, then end the file with one too.
    const lastIdx = lines.length - 1;
    const last = lines[lastIdx] ?? '';
    if (eol === CRLF && !last.endsWith(CARRIAGE_RETURN)) lines[lastIdx] = last + CARRIAGE_RETURN;
    lines.push(asLineElement(entry, eol), '');
  } else {
    lines.splice(insertAt, 0, asLineElement(entry, eol));
  }
  writeFileAtomicSync(projectFilePath, lines.join(LF));
}

/**
 * Remove every entry with this name, from every `[autoload]` section. A section
 * left with no statements and nothing but blank lines is dropped with its
 * header, unless the header carries a comment. Returns true when the file was
 * mutated.
 */
export function removeAutoloadEntry(projectFilePath: string, name: string): boolean {
  const content = readFileSync(projectFilePath, 'utf8');
  const scan = scanProjectFile(content);
  const targets = autoloadStatements(scan).filter((statement) => statement.key === name);
  if (targets.length === 0) return false;

  const lines = content.split(LF);
  const dropped = new Set<number>();
  for (const target of targets) {
    for (let i = target.startLine; i <= target.endLine; i++) dropped.add(i);
  }

  for (const section of scan.sections) {
    if (section.name !== AUTOLOAD_SECTION || section.headerHasComment) continue;
    const bodyEnd = Math.min(section.endLine, lines.length);
    let empty = true;
    for (let i = section.headerLine + 1; i < bodyEnd && empty; i++) {
      empty = dropped.has(i) || (lines[i] ?? '').trim() === '';
    }
    if (!empty) continue;
    for (let i = section.headerLine; i < bodyEnd; i++) dropped.add(i);
  }

  const kept = lines.filter((_, index) => !dropped.has(index));
  writeFileAtomicSync(projectFilePath, kept.join(LF).trimEnd() + eolOf(content));
  return true;
}

/**
 * Rewrite every entry with this name as one line `Name="[*]path"`, replacing
 * the lines the statement covered. An omitted `newPath` or `singleton` keeps
 * what the entry had. A comment that followed the entry on its line is dropped.
 * Returns true when the file was mutated.
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
  const eol = eolOf(content);
  const targets = autoloadStatements(scanProjectFile(content))
    .filter(isEntryStatement)
    .filter((statement) => statement.key === name);
  if (targets.length === 0) return false;

  const lines = content.split(LF);
  // Last statement first, so replacing a span never shifts one still to come.
  for (const target of targets.reverse()) {
    const existing = toEntry(target);
    const writtenPath =
      newPath !== undefined ? normalizeAutoloadPath(newPath) : escapeQuotedValue(existing.path);
    const line = formatEntryLine(name, singleton ?? existing.singleton, writtenPath);
    // The file's last line has no line break after it, so it carries no ending.
    const endsFile = target.endLine >= lines.length - 1;
    lines.splice(
      target.startLine,
      target.endLine - target.startLine + 1,
      endsFile ? line : asLineElement(line, eol),
    );
  }
  writeFileAtomicSync(projectFilePath, lines.join(LF));
  return true;
}
