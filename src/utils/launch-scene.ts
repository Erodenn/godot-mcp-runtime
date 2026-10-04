/**
 * The scene a launch runs when the caller names none: `run/main_scene` under
 * `[application]` in project.godot, read with the project.godot grammar.
 */

import { readFileSync } from 'fs';
import { projectGodotPath, resolveProjectPath } from './path-validation.js';
import { findSetting, scanProjectFile } from './project-godot.js';

const APPLICATION_SECTION = 'application';
const MAIN_SCENE_KEY = 'run/main_scene';

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

/**
 * The scene a launch with no explicit `scene` argument runs: `run/main_scene`
 * from project.godot, resolved under the project root (`res://x`, or `x` when a
 * hand-edited value omits the prefix). A launch that names a scene resolves it
 * with `resolveProjectPath` itself and never comes through here.
 *
 * Returns an absolute filesystem path, or null when the project has no main
 * scene or names one that is not a path inside the project (the caller logs a
 * warning and skips the scene-script scan; the autoload scan still runs). Does
 * NOT verify the file exists; the caller's `existsSync` check produces the
 * warning if the path is stale.
 */
export function resolveLaunchScene(projectDir: string): string | null {
  const main = readMainSceneFromProject(projectDir);
  if (main === null) return null;
  return resolveProjectPath(projectDir, main)?.absPath ?? null;
}
