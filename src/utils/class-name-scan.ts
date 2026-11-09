import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tokenize } from './gdscript-scanner.js';

/** Most `.gd` files one scan reads before it stops and reports itself incomplete. */
export const MAX_CLASS_SCAN_FILES = 20_000;
/** A script larger than this is not read; it is reported unread. */
export const MAX_CLASS_SCAN_FILE_BYTES = 2 * 1024 * 1024;

const CLASS_NAME_KEYWORD = 'class_name';

/**
 * The global class name a GDScript source declares with `class_name`, or null.
 * Read from tokens, so a mention in a comment or a string is not a declaration. The name is the identifier after the keyword; `class_name Foo extends Bar` and `@icon("x.svg") class_name Foo` both give `Foo`.
 * A class a script inherits is not read here: the script that declares it is a project script and is found by its own `class_name`.
 */
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

export interface ClassNameScan {
  /** Project-relative paths of the scripts that declare the class, in walk order. */
  declaredIn: string[];
  /** False when the scan stopped at the file cap, skipped an oversize script, or could not read a directory or file: a script it did not reach could still declare the class. */
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

/**
 * Finds the project scripts that declare `class_name <name>`. Walks `.gd` files under `projectDir`, skipping dot-prefixed entries (`.godot`, `.mcp`) and links; `extraScripts` are absolute paths read in addition (a script reached through a link). Bounded by `MAX_CLASS_SCAN_FILES`.
 */
export function findClassNameDeclarations(
  projectDir: string,
  name: string,
  extraScripts: readonly string[] = [],
): ClassNameScan {
  const declaredIn: string[] = [];
  const seen = new Set<string>();
  let complete = true;
  let filesScanned = 0;

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
      if (mentionsWord(source, name) && declaredClassName(source) === name) {
        declaredIn.push(relPath);
      }
    } catch {
      complete = false;
    }
  };

  const walk = (dir: string, relBase: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relPath);
      } else if (entry.isFile() && entry.name.endsWith('.gd')) {
        if (filesScanned >= MAX_CLASS_SCAN_FILES) {
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
    if (absPath.endsWith('.gd') && existsSync(absPath)) readScript(absPath, absPath);
  }
  return { declaredIn, complete, filesScanned };
}
