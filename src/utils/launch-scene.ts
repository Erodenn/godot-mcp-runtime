/**
 * The scene a launch runs when the caller names none: `run/main_scene` under
 * `[application]` in project.godot, read with the project.godot grammar.
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync } from 'fs';
import { join } from 'path';
import { projectGodotPath, resolveProjectPath } from './path-validation.js';
import { findSetting, scanProjectFile } from './project-godot.js';
import { scanTscn } from './scene-parsing.js';

const APPLICATION_SECTION = 'application';
const MAIN_SCENE_KEY = 'run/main_scene';
const UID_SCHEME = 'uid://';
const UID_ATTRIBUTE = 'uid';
const SCENE_EXTENSION = '.tscn';
const UID_SIDECAR_EXTENSION = '.uid';
const DOT_ENTRY_PREFIX = '.';
const LINE_FEED = '\n';

/** Files `findFilesByUid` opens before it gives up and reports an incomplete search. */
export const UID_SCAN_MAX_FILES = 5000;
/** Bytes read from the start of a `.tscn`: the first line carries the scene's `uid`. */
export const UID_HEADER_READ_BYTES = 1024;

function isFileNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Read `run/main_scene` from `[application]` in project.godot. Returns the
 * value when it is a non-empty string (`res://...` as Godot writes it; a bare
 * value in a hand-edited file is tolerated), else null. With the key written
 * more than once the last one is read, the one the engine keeps. Does NOT
 * verify the file exists.
 */
export function readMainSceneFromProject(projectDir: string): string | null {
  let content: string;
  try {
    content = readFileSync(projectGodotPath(projectDir), 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) return null;
    throw err;
  }
  const statement = findSetting(scanProjectFile(content), APPLICATION_SECTION, MAIN_SCENE_KEY);
  if (statement === undefined || statement.unterminated) return null;
  return typeof statement.value === 'string' && statement.value !== '' ? statement.value : null;
}

export function isUidReference(value: string): boolean {
  return value.startsWith(UID_SCHEME);
}

/** The first line of a file's first `UID_HEADER_READ_BYTES` bytes, or null when it cannot be read. */
function readFirstLine(absPath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(absPath, 'r');
    const buffer = Buffer.alloc(UID_HEADER_READ_BYTES);
    const read = readSync(fd, buffer, 0, UID_HEADER_READ_BYTES, 0);
    const text = buffer.toString('utf8', 0, read);
    const newlineAt = text.indexOf(LINE_FEED);
    return newlineAt === -1 ? text : text.slice(0, newlineAt);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Every file in the project that carries this `uid://`: a `.tscn` whose header
 * names it, or the target of a `*.uid` sidecar whose content is it. The lookup
 * reads the text the engine writes, not `.godot/uid_cache.bin`, so it needs no
 * import to have run. Dot-directories (`.godot`, `.mcp`) and symbolic links
 * are not entered. After `maxFiles` opens it stops and says the search is
 * incomplete; an unreadable directory makes it incomplete too.
 */
export function findFilesByUid(
  projectDir: string,
  uid: string,
  maxFiles: number = UID_SCAN_MAX_FILES,
): { paths: string[]; complete: boolean } {
  const paths: string[] = [];
  let opened = 0;
  let complete = true;
  let capped = false;

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (capped) return;
      if (entry.name.startsWith(DOT_ENTRY_PREFIX) || entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const isScene = entry.name.endsWith(SCENE_EXTENSION);
      const isSidecar = entry.name.endsWith(UID_SIDECAR_EXTENSION);
      if (!isScene && !isSidecar) continue;
      if (opened >= maxFiles) {
        capped = true;
        complete = false;
        return;
      }
      opened++;
      if (isScene) {
        const line = readFirstLine(abs);
        if (line !== null && scanTscn(line).headers[0]?.attrs.get(UID_ATTRIBUTE) === uid) {
          paths.push(abs);
        }
      } else {
        let text: string;
        try {
          text = readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        if (text.trim() === uid) paths.push(abs.slice(0, -UID_SIDECAR_EXTENSION.length));
      }
    }
  };

  walk(projectDir);
  return { paths, complete };
}

/**
 * What a launch with no explicit `scene` argument runs. `none`: the project
 * configures no main scene. `unresolved`: it configures one that cannot be
 * turned into a file (a `uid://` nothing in the project carries, or a value
 * that is not a path inside the project). `scenes`: the files to scan, with
 * notes for the caller to surface; more than one file when several carry the
 * same uid, since the engine may load any of them.
 */
export type LaunchScene =
  | { kind: 'scenes'; absPaths: string[]; notes: string[] }
  | { kind: 'none' }
  | { kind: 'unresolved'; value: string; reason: string };

/**
 * The scene a launch with no explicit `scene` argument runs: `run/main_scene`
 * from project.godot. A path is resolved under the project root (`res://x`, or
 * `x` when a hand-edited value omits the prefix); a `uid://` is looked up with
 * `findFilesByUid`, which is what the editor writes. A launch that names a
 * scene resolves it with `resolveProjectPath` itself and never comes through
 * here.
 *
 * Does NOT verify a path exists; the caller's `existsSync` check produces the
 * warning if the path is stale.
 */
export function resolveLaunchScene(projectDir: string): LaunchScene {
  const main = readMainSceneFromProject(projectDir);
  if (main === null) return { kind: 'none' };

  if (isUidReference(main)) {
    const { paths, complete } = findFilesByUid(projectDir, main);
    if (paths.length === 0) {
      const reason = complete
        ? `no scene or .uid file in the project carries ${main}`
        : `the search was cut short (a limit of ${UID_SCAN_MAX_FILES} files, or an unreadable folder) before a file carrying ${main} was found`;
      return { kind: 'unresolved', value: main, reason };
    }
    const notes =
      paths.length > 1
        ? [`${paths.length} files carry ${main}; all of them were scanned: ${paths.join(', ')}`]
        : [];
    return { kind: 'scenes', absPaths: paths, notes };
  }

  const resolved = resolveProjectPath(projectDir, main);
  if (resolved === null) {
    return {
      kind: 'unresolved',
      value: main,
      reason: 'the value is not a path inside the project',
    };
  }
  return { kind: 'scenes', absPaths: [resolved.absPath], notes: [] };
}
