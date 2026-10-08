import { join } from 'path';

/** Single source of truth for every path this server writes inside a target project under `.mcp/`; pure composition, each writer creates its own directory.
 * `.gdignore` sits at `.mcp/` and covers the subtree; the bridge autoload still loads because autoload resolution goes through `load()`, not the importer. */

/** Container for every artifact this server writes into a target project. */
const MCP_DIR_NAME = '.mcp' as const;

/** Namespace directory inside `.mcp/`, so other MCP servers can coexist. */
const ARTIFACT_NAMESPACE_DIR_NAME = 'godot-runtime' as const;

const BRIDGE_DIR_NAME = 'bridge' as const;
const BRIDGE_OWNERS_DIR_NAME = 'owners' as const;
const SCREENSHOTS_DIR_NAME = 'screenshots' as const;
const AUDIT_SCRIPTS_DIR_NAME = 'scripts' as const;
const VALIDATE_DIR_NAME = 'validate' as const;
const MOVIES_DIR_NAME = 'movies' as const;
const SCENE_BACKUPS_DIR_NAME = 'scene-backups' as const;

/** Basename given to --write-movie for a PNG sequence; Godot inserts the frame index before the extension. */
export const MOVIE_FRAME_BASENAME = 'frame' as const;
const MOVIE_VIDEO_BASENAME = 'movie' as const;
const MOVIE_AUDIO_EXTENSION = 'wav' as const;

/** Output extensions `--write-movie` is given: a PNG sequence or one video file. */
export type MovieOutputExtension = 'png' | 'avi' | 'ogv';

/** Basename of the bridge autoload script, at both the new and legacy location. */
const BRIDGE_SCRIPT_FILENAME = 'mcp_bridge.gd' as const;

/** Pre-namespace location of the bridge script (the project root), read by `BridgeManager`'s migration cleanup and orphan repair. */
export const LEGACY_BRIDGE_SCRIPT_FILENAME = BRIDGE_SCRIPT_FILENAME;

/** Project-relative namespace root, in POSIX form for `res://` composition. */
const NAMESPACE_RES_DIR = `${MCP_DIR_NAME}/${ARTIFACT_NAMESPACE_DIR_NAME}` as const;

/** `res://` path registered as the `McpBridge` autoload in project.godot. */
export const BRIDGE_SCRIPT_RES_PATH =
  `res://${NAMESPACE_RES_DIR}/${BRIDGE_DIR_NAME}/${BRIDGE_SCRIPT_FILENAME}` as const;

/** Project-relative directory for validate temp scripts; handed to godot_operations.gd as a `script_path` prefix, so it must stay POSIX-separated on every host. */
export const VALIDATE_RES_DIR = `${NAMESPACE_RES_DIR}/${VALIDATE_DIR_NAME}` as const;

/** `<project>/.mcp` — home of the `.gdignore` marker. */
export function mcpDir(projectPath: string): string {
  return join(projectPath, MCP_DIR_NAME);
}

/** `<project>/.mcp/godot-runtime/bridge` — removed wholesale on session cleanup. */
export function bridgeDir(projectPath: string): string {
  return join(mcpDir(projectPath), ARTIFACT_NAMESPACE_DIR_NAME, BRIDGE_DIR_NAME);
}

/** Absolute path of the injected bridge autoload script. */
export function bridgeScriptAbsPath(projectPath: string): string {
  return join(bridgeDir(projectPath), BRIDGE_SCRIPT_FILENAME);
}

/** `.../bridge/owners`: one JSON file per live session, read by every session to decide whether it is the last leaver before removing the shared script and autoload entry. */
export function bridgeOwnersDir(projectPath: string): string {
  return join(bridgeDir(projectPath), BRIDGE_OWNERS_DIR_NAME);
}

/** `<project>/.mcp/godot-runtime/screenshots`: where the bridge saves PNGs and the only directory `take_screenshot` reads one back from.
 * KEEP IN SYNC: `SCREENSHOT_DIR_RES_PATH` in `src/scripts/mcp_bridge.gd` builds the same directory, and `handleTakeScreenshot` in `src/tools/runtime-tools.ts` uses this as its containment root. */
export function screenshotsDir(projectPath: string): string {
  return join(mcpDir(projectPath), ARTIFACT_NAMESPACE_DIR_NAME, SCREENSHOTS_DIR_NAME);
}

/** `<project>/.mcp/godot-runtime/scripts` — run_script audit pairs, never cleaned. */
export function auditScriptsDir(projectPath: string): string {
  return join(mcpDir(projectPath), ARTIFACT_NAMESPACE_DIR_NAME, AUDIT_SCRIPTS_DIR_NAME);
}

/** `<project>/.mcp/godot-runtime/validate` — temp scripts, deleted per call. */
export function validateTempDir(projectPath: string): string {
  return join(mcpDir(projectPath), ARTIFACT_NAMESPACE_DIR_NAME, VALIDATE_DIR_NAME);
}

/** `<project>/.mcp/godot-runtime/movies` — one subdirectory per `render_movie` run. */
export function moviesDir(projectPath: string): string {
  return join(mcpDir(projectPath), ARTIFACT_NAMESPACE_DIR_NAME, MOVIES_DIR_NAME);
}

/** `<project>/.mcp/godot-runtime/movies/<run id>` — the output directory of one run. */
export function movieRunDir(projectPath: string, runId: string): string {
  return join(moviesDir(projectPath), runId);
}

/** The path handed to `--write-movie`: `frame.png` for a PNG sequence (Godot inserts the frame index), `movie.avi` or `movie.ogv` for one video. */
export function movieOutputPath(
  projectPath: string,
  runId: string,
  extension: MovieOutputExtension,
): string {
  const basename = extension === 'png' ? MOVIE_FRAME_BASENAME : MOVIE_VIDEO_BASENAME;
  return join(movieRunDir(projectPath, runId), `${basename}.${extension}`);
}

/** The audio track the movie writer emits next to a PNG sequence (`frame.wav`). */
export function movieAudioPath(projectPath: string, runId: string): string {
  const fileName = `${MOVIE_FRAME_BASENAME}.${MOVIE_AUDIO_EXTENSION}`;
  return join(movieRunDir(projectPath, runId), fileName);
}

/** `.../scene-backups`: one subdirectory per headless save that dropped content; never cleaned by the server. */
export function sceneBackupsDir(projectPath: string): string {
  return join(mcpDir(projectPath), ARTIFACT_NAMESPACE_DIR_NAME, SCENE_BACKUPS_DIR_NAME);
}

/** Where the pre-save text of one scene is kept: the run directory plus the scene's project-relative segments, so two scenes with one basename never collide. `sceneRelPath` is a resolved `relPath`, never a raw user string. */
export function sceneBackupPath(projectPath: string, runId: string, sceneRelPath: string): string {
  return join(sceneBackupsDir(projectPath), runId, ...sceneRelPath.split('/'));
}

/** The same location in project-relative POSIX form for warning text, identical on every host. */
export function sceneBackupRelPath(runId: string, sceneRelPath: string): string {
  return `${NAMESPACE_RES_DIR}/${SCENE_BACKUPS_DIR_NAME}/${runId}/${sceneRelPath}`;
}

/** True when an `[autoload]` path under the reserved `McpBridge` name points at a location this server owns, so it is safe to rewrite or delete.
 * WIDEST INPUT: every path beneath `.mcp/` (not just the bridge script; directories and backslashes included) plus `mcp_bridge.gd` at the root with or without `res://`. Rejected: `uid://` forms (a Godot-rewritten entry reads as user-owned and blocks inject rather than being clobbered), `addons/.mcp/...`, `sub/mcp_bridge.gd`, absolute paths; those are a user's own autoload, left untouched with `inject` failing loudly. */
export function isServerOwnedBridgePath(autoloadPath: string): boolean {
  const stripped = autoloadPath
    .replace(/\\/g, '/')
    .replace(/^res:\/\//i, '')
    .replace(/^\.\//, '');
  return stripped === BRIDGE_SCRIPT_FILENAME || stripped.startsWith(`${MCP_DIR_NAME}/`);
}
