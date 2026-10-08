/** The scene a launch runs when the caller names none: `application/run/main_scene` from project.godot under whichever section split the file spells it. */

import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'fs';
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
/** Directories `findFilesByUid` enters before reporting an incomplete search, counted apart from files: a tree of empty folders opens no file and would otherwise be walked without a bound. */
export const UID_SCAN_MAX_DIRECTORIES = 5000;
/** Bytes read from the start of a `.tscn`: the first line carries the scene's `uid`. */
export const UID_HEADER_READ_BYTES = 1024;

function isFileNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Reads `application/run/main_scene`: the value when a non-empty string (a bare value in a hand-edited file is tolerated), else null; the last assignment under any spelling wins. Does NOT verify the file exists. */
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

/** Every file carrying this `uid://`: a `.tscn` whose header names it, or the target of a `*.uid` sidecar. Reads the text the engine writes rather than `.godot/uid_cache.bin`, so no import is needed. Dot-directories are not entered; linked directories are, once per real path so a cycle ends.
 * Incomplete (stops and says so) after `maxFiles` opens or `maxDirectories` entered, on an unresolvable link, or on an unreadable directory, header or sidecar, since any may carry the uid. */
export function findFilesByUid(
  projectDir: string,
  uid: string,
  maxFiles: number = UID_SCAN_MAX_FILES,
  maxDirectories: number = UID_SCAN_MAX_DIRECTORIES,
): { paths: string[]; complete: boolean } {
  const paths: string[] = [];
  let opened = 0;
  let complete = true;
  let capped = false;
  const walkedRealPaths = new Set<string>();

  const walk = (dir: string): void => {
    let entries;
    try {
      const realDir = realpathSync.native(dir);
      if (walkedRealPaths.has(realDir)) return;
      walkedRealPaths.add(realDir);
      if (walkedRealPaths.size > maxDirectories) {
        capped = true;
        complete = false;
        return;
      }
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (capped) return;
      if (entry.name.startsWith(DOT_ENTRY_PREFIX)) continue;
      const abs = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = statSync(abs);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          complete = false;
          continue;
        }
      }
      if (isDirectory) {
        walk(abs);
        continue;
      }
      if (!isFile) continue;
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
        if (line === null) {
          complete = false;
        } else if (scanTscn(line).headers[0]?.attrs.get(UID_ATTRIBUTE) === uid) {
          paths.push(abs);
        }
      } else {
        let text: string;
        try {
          text = readFileSync(abs, 'utf8');
        } catch {
          complete = false;
          continue;
        }
        if (text.trim() === uid) paths.push(abs.slice(0, -UID_SIDECAR_EXTENSION.length));
      }
    }
  };

  walk(projectDir);
  return { paths, complete };
}

/** Why a uid search can end before every file was read; worded to follow "the search was cut short". */
export const UID_SEARCH_CUT_SHORT_CAUSE = `a limit of ${UID_SCAN_MAX_FILES} files or ${UID_SCAN_MAX_DIRECTORIES} folders, or a folder or file that could not be read`;

/** What a launch with no `scene` argument runs. `none`: no main scene configured. `unresolved`: one that cannot become a file (a `uid://` nothing carries, or a non-project path), with `reason` when the uid search was cut short so the scene may exist unfound. `scenes`: the files to scan, several when many carry the same uid since the engine may load any, with a note when the search was cut short and another carrier may exist. */
export type LaunchScene =
  | { kind: 'scenes'; absPaths: string[]; notes: string[] }
  | { kind: 'none' }
  | { kind: 'unresolved'; value: string; reason: string };

/** The scene a launch with no `scene` argument runs: `run/main_scene`, a path resolved under the project root or a `uid://` looked up with `findFilesByUid` (at most `maxFiles` opens). A launch naming a scene resolves it with `resolveProjectPath` itself. Does NOT verify a path exists; the caller's `existsSync` produces the warning. */
export function resolveLaunchScene(
  projectDir: string,
  maxFiles: number = UID_SCAN_MAX_FILES,
): LaunchScene {
  const main = readMainSceneFromProject(projectDir);
  if (main === null) return { kind: 'none' };

  if (isUidReference(main)) {
    const { paths, complete } = findFilesByUid(projectDir, main, maxFiles);
    if (paths.length === 0) {
      const reason = complete
        ? `no scene or .uid file in the project carries ${main}`
        : `the search was cut short (${UID_SEARCH_CUT_SHORT_CAUSE}) before a file carrying ${main} was found`;
      return { kind: 'unresolved', value: main, reason };
    }
    const notes: string[] = [];
    if (paths.length > 1) {
      notes.push(
        complete
          ? `${paths.length} files carry ${main}; all of them were scanned: ${paths.join(', ')}`
          : `${paths.length} files carry ${main} and were scanned: ${paths.join(', ')}`,
      );
    }
    if (!complete) {
      notes.push(
        `The search for ${main} was cut short (${UID_SEARCH_CUT_SHORT_CAUSE}): another file may carry it, and was not scanned`,
      );
    }
    return { kind: 'scenes', absPaths: paths, notes };
  }

  const resolved = resolveProjectPath(projectDir, main, 'read');
  if (resolved === null) {
    return {
      kind: 'unresolved',
      value: main,
      reason: 'the value could not be resolved to a file inside the project',
    };
  }
  return { kind: 'scenes', absPaths: [resolved.absPath], notes: [] };
}
