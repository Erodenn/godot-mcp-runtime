import { isAbsolute, join, relative, resolve, sep } from 'path';

/**
 * Check whether a display server (X11 / Wayland) is available on the current
 * platform.  On macOS and Windows the display subsystem is always present;
 * on Linux we probe the standard environment variables.
 */
export function checkDisplayAvailable(): boolean {
  if (process.platform !== 'linux') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export function validatePath(path: string): boolean {
  if (!path || path.includes('..')) {
    return false;
  }
  return true;
}

/** Godot's project-root URI scheme. */
const RES_PREFIX = 'res://';
/** Any URI scheme separator; a second one in a path is a smuggled scheme (`uid://`, `res://res://`). */
const URI_SCHEME_SEPARATOR = '://';

/**
 * A user-supplied project sub-path, resolved once. Callers pick the field that
 * matches where the value is going instead of re-deriving it from the raw
 * string.
 */
export interface ResolvedProjectPath {
  /** Caller's spelling. Error messages and documented per-item echoes only. */
  readonly input: string;
  /** Project-relative, '/' separators, no 'res://', no './', never empty. Forwarded to GDScript. */
  readonly relPath: string;
  /** Absolute filesystem path (platform separators). Every fs call uses this. */
  readonly absPath: string;
  /** 'res://' + relPath. Written to project.godot and passed on the Godot command line. */
  readonly resPath: string;
}

/**
 * Resolve a user-supplied path that must stay inside `projectPath`. Accepts a
 * bare relative path, `./x`, `res://x`, an absolute path inside the project,
 * and backslash separators. Returns null for anything else: empty or non-string
 * input, `..` (via `validatePath`), a second URI scheme, the project root
 * itself, or an absolute path that escapes the root
 * (`path.join('/project', '/etc/passwd')` is `/etc/passwd`, so the `..`
 * substring check alone permits absolute-path traversal).
 */
export function resolveProjectPath(
  projectPath: string,
  userPath: string,
): ResolvedProjectPath | null {
  if (typeof userPath !== 'string' || userPath === '' || !validatePath(userPath)) return null;
  const candidate = (
    userPath.startsWith(RES_PREFIX) ? userPath.slice(RES_PREFIX.length) : userPath
  ).replace(/\\/g, '/');
  if (candidate === '' || candidate.includes(URI_SCHEME_SEPARATOR)) return null;

  const root = resolve(projectPath);
  const absPath = resolve(root, candidate);
  const rel = relative(root, absPath);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;

  const relPath = rel.split(sep).join('/');
  return { input: userPath, relPath, absPath, resPath: RES_PREFIX + relPath };
}

/**
 * File extensions a `scene` argument of a launch (`run_project`,
 * `render_movie`) may end in. Godot treats a positional argument as the scene
 * to run only when it ends in a scene or resource extension, compared case
 * sensitively; any other argument is ignored and the project's main scene runs
 * instead. So a `scene` outside this list would have the launch gate scan one
 * file while the engine runs another. Only the two scene formats are accepted:
 * the gate reads `.tscn`, reports `.scn` as not scanned, and has nothing to
 * say about a scene held in a `.res` or `.tres` file.
 */
export const LAUNCH_SCENE_EXTENSIONS: readonly string[] = ['.tscn', '.scn'];

/** True when `scene` ends, case-sensitively, in an extension a launch accepts. */
export function isLaunchScenePath(scene: string): boolean {
  return LAUNCH_SCENE_EXTENSIONS.some((extension) => scene.endsWith(extension));
}

/**
 * Validate a Godot scene-tree path (NodePath). Scene-tree paths are a
 * separate namespace from filesystem paths — they address nodes inside
 * a scene, not files on disk, so the project-root containment check
 * in `resolveProjectPath` does not apply.
 *
 * Rejects empty strings and `..` segments. Accepts both relative
 * (`root/Player`) and absolute (`/root/Player`) Godot forms; the
 * codebase convention is the relative form.
 */
export function validateNodePath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && !path.includes('..');
}

/**
 * True when `child` resolves to `parent` or a path beneath it. Used by
 * defense-in-depth checks on bridge-returned paths (e.g. screenshot files
 * that must live under `.mcp/godot-runtime/screenshots/`).
 */
export function isUnderDir(parent: string, child: string): boolean {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  return childResolved === parentResolved || childResolved.startsWith(parentResolved + sep);
}

/**
 * Build the absolute path to a project's `project.godot` manifest. Use this
 * instead of `join(dir, 'project.godot')` ad hoc.
 */
export function projectGodotPath(projectDir: string): string {
  return join(projectDir, 'project.godot');
}
