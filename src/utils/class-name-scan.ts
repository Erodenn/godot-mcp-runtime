import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { tokenize, decodeStringLiteral, type Token } from './gdscript-scanner.js';
import { resolveProjectPath } from './path-validation.js';

/** Most folders one scan enters before it stops and reports itself incomplete, counted apart from files: a tree of empty folders opens no file and would otherwise be walked without a bound. */
const MAX_CLASS_SCAN_DIRECTORIES = 5000;
/** Most `.gd` files one scan reads before it stops and reports itself incomplete. */
export const MAX_CLASS_SCAN_FILES = 20_000;
/** A script larger than this is not read; it is reported unread. */
export const MAX_CLASS_SCAN_FILE_BYTES = 2 * 1024 * 1024;
/** Most `extends` hops followed from one script before the chain is reported unresolved. */
export const MAX_EXTENDS_CHAIN_DEPTH = 32;
/** Most scripts one chain walk reads in all (a class name declared more than once fans out). */
export const MAX_EXTENDS_CHAIN_FILES = 64;

const CLASS_NAME_KEYWORD = 'class_name';
const CLASS_KEYWORD = 'class';
const EXTENDS_KEYWORD = 'extends';
const FIRST_COLUMN = 1;
const SCRIPT_EXTENSION = '.gd';

/** The global class name a source declares with `class_name`, read from tokens (a comment or string mention is not one), or null. */
export function declaredClassName(source: string): string | null {
  const tokens = tokenize(source);
  for (const [i, token] of tokens.entries()) {
    if (token.kind !== 'identifier' || token.text !== CLASS_NAME_KEYWORD) continue;
    if (token.precededByDot) continue;
    const name = tokens[i + 1];
    if (name !== undefined && name.kind === 'identifier') return name.text;
  }
  return null;
}

/** What a script's own `extends` names: a script path, a class name, or a dotted name (`Base.Inner`) whose inner class this module does not resolve. */
export type ExtendsTarget =
  | { kind: 'path'; path: string }
  | { kind: 'class'; name: string }
  | { kind: 'inner'; text: string };

/** True for an `extends` that belongs to the script itself: its line starts at column 1 and not with `class` (an indented one sits in an inner class body, and `class Foo extends Bar` is that inner class's). `class_name Foo extends Bar` and `@icon("x") extends Bar` start at column 1 with something else. */
function isScriptLevelExtends(tokens: readonly Token[], i: number): boolean {
  const line = tokens[i]!.line;
  let first = i;
  while (first > 0 && tokens[first - 1]!.line === line && tokens[first - 1]!.kind !== 'newline') {
    first--;
  }
  const lead = tokens[first]!;
  return lead.column === FIRST_COLUMN && lead.text !== CLASS_KEYWORD;
}

/** The script's own `extends` target, read from tokens, or null when it has none or the clause is not one this reads. */
export function declaredExtends(source: string): ExtendsTarget | null {
  const tokens = tokenize(source);
  for (const [i, token] of tokens.entries()) {
    if (token.kind !== 'identifier' || token.text !== EXTENDS_KEYWORD) continue;
    if (token.precededByDot) continue;
    if (!isScriptLevelExtends(tokens, i)) continue;
    const target = tokens[i + 1];
    if (target === undefined) return null;
    if (target.kind === 'string') {
      const path = decodeStringLiteral(target);
      return path === null ? null : { kind: 'path', path };
    }
    if (target.kind === 'identifier') return { kind: 'class', name: target.text };
    if (target.kind === 'memberChain') return { kind: 'inner', text: target.text };
    return null;
  }
  return null;
}

/** Every global class name the project's scripts declare, from one walk. */
export interface ClassNameMap {
  /** Class name to the project-relative paths of the scripts declaring it, in walk order (an extra script is keyed by the absolute path it was given). */
  byName: Map<string, string[]>;
  /** False when the walk hit a cap, skipped an oversize script, or could not read a folder or file: a script it did not reach could still declare the class. */
  complete: boolean;
  filesScanned: number;
}

/** Whether `source` holds `name` as a whole word, a cheap test before tokenizing. */
function mentionsWord(source: string, name: string): boolean {
  let from = source.indexOf(name);
  while (from !== -1) {
    const before = from === 0 ? '' : (source[from - 1] ?? '');
    const after = source[from + name.length] ?? '';
    if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return true;
    from = source.indexOf(name, from + 1);
  }
  return false;
}

/** Walks `.gd` files under `projectDir` once and maps each `class_name` to its scripts, skipping dot-prefixed entries and links; `extraScripts` (absolute) are read too. Stops incomplete at `MAX_CLASS_SCAN_FILES` files or `maxDirectories` folders. */
export function scanClassNames(
  projectDir: string,
  extraScripts: readonly string[] = [],
  maxDirectories: number = MAX_CLASS_SCAN_DIRECTORIES,
): ClassNameMap {
  const byName = new Map<string, string[]>();
  const seen = new Set<string>();
  let complete = true;
  let filesScanned = 0;
  let directoriesEntered = 0;
  let capped = false;

  const readScript = (absPath: string, relPath: string): void => {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    try {
      if (statSync(absPath).size > MAX_CLASS_SCAN_FILE_BYTES) {
        complete = false;
        return;
      }
      const source = readFileSync(absPath, 'utf8');
      filesScanned++;
      if (!mentionsWord(source, CLASS_NAME_KEYWORD)) return;
      const name = declaredClassName(source);
      if (name === null) return;
      const files = byName.get(name);
      if (files === undefined) byName.set(name, [relPath]);
      else files.push(relPath);
    } catch {
      complete = false;
    }
  };

  const walk = (dir: string, relBase: string): void => {
    if (capped) return;
    if (++directoriesEntered > maxDirectories) {
      capped = true;
      complete = false;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    for (const entry of entries) {
      if (capped) return;
      if (entry.name.startsWith('.')) continue;
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relPath);
      } else if (entry.isFile() && entry.name.endsWith(SCRIPT_EXTENSION)) {
        if (filesScanned >= MAX_CLASS_SCAN_FILES) {
          capped = true;
          complete = false;
          return;
        }
        readScript(join(dir, entry.name), relPath);
      }
    }
  };

  walk(projectDir, '');
  for (const absPath of extraScripts) {
    // A path that names no file (a scene, a script not written yet) holds no declaration and is not a gap in the scan.
    if (absPath.endsWith(SCRIPT_EXTENSION) && existsSync(absPath)) readScript(absPath, absPath);
  }
  return { byName, complete, filesScanned };
}

export interface InheritedClassNameScan {
  /** Project-relative paths (as spelled for a script outside the project) of scripts on the chain that declare the class. */
  declaredIn: string[];
  /** False when a link of the chain could not be followed: a path that resolves to no readable `.gd` inside the project, an oversize script, a dotted `extends Base.Inner`, a class the walk may not have reached, a cycle, or a chain past the bounds. A clash may then remain. */
  resolved: boolean;
}

function toProjectRelative(projectDir: string, absPath: string): string {
  return relative(projectDir, absPath).replace(/\\/g, '/');
}

/** Follows the `extends` chain of `startAbsPath` (by path, or by name through `classNames`) and reports the scripts on it declaring `class_name <name>`, including a base the project walk skipped as a link. Bounded by `MAX_EXTENDS_CHAIN_DEPTH` and `MAX_EXTENDS_CHAIN_FILES`; a chain it cannot follow is `resolved: false`, never a pass. */
export function findInheritedClassName(
  projectDir: string,
  startAbsPath: string,
  name: string,
  classNames: ClassNameMap,
): InheritedClassNameScan {
  const declaredIn: string[] = [];
  let resolved = true;
  const visited = new Set<string>();
  const pending: Array<{ absPath: string; relPath: string; depth: number }> = [
    { absPath: startAbsPath, relPath: toProjectRelative(projectDir, startAbsPath), depth: 0 },
  ];

  const enqueue = (absPath: string, relPath: string, depth: number): void => {
    if (visited.has(relPath)) {
      // Met again by a cycle or by a second route to one base: not followed twice, so the chain is reported unresolved.
      resolved = false;
      return;
    }
    if (depth > MAX_EXTENDS_CHAIN_DEPTH || visited.size >= MAX_EXTENDS_CHAIN_FILES) {
      resolved = false;
      return;
    }
    pending.push({ absPath, relPath, depth });
  };

  while (pending.length > 0) {
    const node = pending.shift()!;
    if (visited.has(node.relPath)) continue;
    visited.add(node.relPath);
    let source: string;
    try {
      if (statSync(node.absPath).size > MAX_CLASS_SCAN_FILE_BYTES) {
        resolved = false;
        continue;
      }
      source = readFileSync(node.absPath, 'utf8');
    } catch {
      resolved = false;
      continue;
    }
    if (node.depth > 0 && declaredClassName(source) === name) declaredIn.push(node.relPath);

    const target = declaredExtends(source);
    if (target === null) continue;
    if (target.kind === 'inner') {
      resolved = false;
    } else if (target.kind === 'class') {
      const declaring = classNames.byName.get(target.name);
      if (declaring === undefined) {
        // Not a project class as far as the walk saw: an engine class, unless the walk missed scripts.
        if (!classNames.complete) resolved = false;
        continue;
      }
      for (const file of declaring) {
        const absPath = isAbsolute(file) ? file : join(projectDir, file);
        enqueue(
          absPath,
          isAbsolute(file) ? toProjectRelative(projectDir, file) : file,
          node.depth + 1,
        );
      }
    } else {
      const spelled =
        target.path.startsWith('res://') || isAbsolute(target.path)
          ? target.path
          : `${node.relPath.split('/').slice(0, -1).join('/')}/${target.path}`.replace(/^\//, '');
      const next = target.path.endsWith(SCRIPT_EXTENSION)
        ? resolveProjectPath(projectDir, spelled, 'read')
        : null;
      if (next === null || !existsSync(next.absPath)) {
        resolved = false;
        continue;
      }
      enqueue(next.absPath, next.relPath, node.depth + 1);
    }
  }
  return { declaredIn, resolved };
}
