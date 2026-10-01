import { join } from 'path';

/**
 * Single source of truth for every path this server writes inside a target
 * Godot project. Nothing outside this module joins `.mcp` with a literal
 * subdirectory name.
 *
 * Layout:
 *
 *     <project>/.mcp/.gdignore                              (importer suppression, never deleted)
 *     <project>/.mcp/godot-runtime/bridge/mcp_bridge.gd     (session-scoped, removed by the last leaver)
 *     <project>/.mcp/godot-runtime/bridge/owners/<pid>-<instanceId>.json
 *                                                            (one file per live session on this project,
 *                                                             removed on that session's own cleanup)
 *     <project>/.mcp/godot-runtime/screenshots/             (persists across sessions)
 *     <project>/.mcp/godot-runtime/scripts/                 (run_script audit pairs, persists)
 *     <project>/.mcp/godot-runtime/validate/                (temp files, deleted per call)
 *     <project>/.mcp/godot-runtime/movies/<run id>/         (kept for `frames` and `video` runs, removed per call for `check`)
 *
 * `.gdignore` stays at the `.mcp/` level and covers the whole subtree; the
 * autoload under it still loads, because autoload resolution goes through
 * `load()` rather than the importer.
 *
 * Pure path composition — no filesystem access. Each writer creates its own
 * directory with `mkdirSync(..., { recursive: true })`.
 */

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

/** Basename given to --write-movie for a PNG sequence; Godot inserts the frame index before the extension. */
export const MOVIE_FRAME_BASENAME = 'frame' as const;
const MOVIE_VIDEO_BASENAME = 'movie' as const;
const MOVIE_AUDIO_EXTENSION = 'wav' as const;

/** Output extensions `--write-movie` is given: a PNG sequence or one video file. */
export type MovieOutputExtension = 'png' | 'avi' | 'ogv';

/** Basename of the bridge autoload script, at both the new and legacy location. */
const BRIDGE_SCRIPT_FILENAME = 'mcp_bridge.gd' as const;

/**
 * Pre-namespace location of the bridge script: the project root. Read by
 * `BridgeManager.removeBridgeArtifacts` (migration cleanup) and
 * `BridgeManager.repairOrphaned` (stranded-artifact detection).
 */
export const LEGACY_BRIDGE_SCRIPT_FILENAME = BRIDGE_SCRIPT_FILENAME;

/** Project-relative namespace root, in POSIX form for `res://` composition. */
const NAMESPACE_RES_DIR = `${MCP_DIR_NAME}/${ARTIFACT_NAMESPACE_DIR_NAME}` as const;

/** `res://` path registered as the `McpBridge` autoload in project.godot. */
export const BRIDGE_SCRIPT_RES_PATH =
  `res://${NAMESPACE_RES_DIR}/${BRIDGE_DIR_NAME}/${BRIDGE_SCRIPT_FILENAME}` as const;

/**
 * Project-relative directory for validate temp scripts. Handed to
 * `godot_operations.gd` as the prefix of a `script_path` parameter, so it must
 * stay POSIX-separated regardless of host platform.
 */
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

/**
 * `<project>/.mcp/godot-runtime/bridge/owners` — one JSON file per live
 * session on this project (registered by `BridgeManager.inject`, removed by
 * that session's own `BridgeManager.cleanup`). Read by every session to
 * decide whether it is the last leaver before removing the shared script and
 * autoload entry.
 */
export function bridgeOwnersDir(projectPath: string): string {
  return join(bridgeDir(projectPath), BRIDGE_OWNERS_DIR_NAME);
}

/**
 * `<project>/.mcp/godot-runtime/screenshots` — where the bridge saves PNGs and
 * the only directory `take_screenshot` will read one back from.
 *
 * KEEP IN SYNC: `src/scripts/mcp_bridge.gd` builds the same directory from its
 * own `SCREENSHOT_DIR_RES_PATH` const (it cannot import TypeScript), and
 * `handleTakeScreenshot` in `src/tools/runtime-tools.ts` uses this function as
 * the containment root for what the bridge hands back. All three move together.
 */
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

/**
 * The path handed to `--write-movie`: `frame.png` for a PNG sequence (Godot
 * writes `frame<index>.png` next to it), `movie.avi` or `movie.ogv` for one video.
 */
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

/**
 * True when an `[autoload]` path registered under the reserved `McpBridge`
 * name points at a location this server owns, and is therefore safe to rewrite
 * (migration) or delete (cleanup).
 *
 * Server-owned means exactly two shapes, after normalizing separators and
 * stripping a `res://` scheme and any `./` prefix:
 *
 *   - `mcp_bridge.gd` at the project root — the pre-namespace location.
 *   - anything at all under `.mcp/` — the current namespace and any older
 *     `.mcp/`-relative layout.
 *
 * WIDEST INPUT: this accepts every path beneath `.mcp/`, not just the bridge
 * script — `.mcp/anything.gd`, `.mcp/godot-runtime/scripts/x.gd`, a directory
 * path, a path with backslash separators. It also accepts a bare
 * `mcp_bridge.gd` written without the `res://` scheme. It does NOT accept:
 * a `uid://` form (an entry Godot rewrote to a UID reads as user-owned and
 * blocks inject rather than being silently clobbered), `addons/.mcp/...` or
 * any other path with `.mcp` below the root, `sub/mcp_bridge.gd`, or an
 * absolute filesystem path. Everything it rejects is treated as a user's own
 * autoload that happens to share the `McpBridge` name: left untouched, with
 * `inject` failing loudly instead of overwriting it.
 */
export function isServerOwnedBridgePath(autoloadPath: string): boolean {
  const stripped = autoloadPath
    .replace(/\\/g, '/')
    .replace(/^res:\/\//i, '')
    .replace(/^\.\//, '');
  return stripped === BRIDGE_SCRIPT_FILENAME || stripped.startsWith(`${MCP_DIR_NAME}/`);
}
