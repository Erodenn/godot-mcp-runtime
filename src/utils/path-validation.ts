import { join, resolve, sep } from 'path';

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

/**
 * Stricter check for paths that must stay inside `projectPath`. Rejects `..`
 * (via `validatePath`) and absolute paths that escape the project root.
 * `path.join('/project', '/etc/passwd')` resolves to `/etc/passwd`, so the
 * basic `..`-substring check alone permits absolute-path traversal.
 *
 * Tolerates a leading `res://` (Godot's project-root URI) by stripping it
 * before resolving — autoload entries and resource paths use this prefix.
 */
export function validateSubPath(projectPath: string, userPath: string): boolean {
  if (!validatePath(userPath)) return false;
  const stripped = userPath.startsWith('res://') ? userPath.slice('res://'.length) : userPath;
  if (!stripped) return false;
  const projectRoot = resolve(projectPath);
  const resolved = resolve(projectRoot, stripped);
  const tail = projectRoot === sep ? sep : projectRoot + sep;
  return resolved === projectRoot || resolved.startsWith(tail);
}

/**
 * Validate a Godot scene-tree path (NodePath). Scene-tree paths are a
 * separate namespace from filesystem paths — they address nodes inside
 * a scene, not files on disk, so the project-root containment check
 * in `validateSubPath` does not apply.
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
 * that must live under `.mcp/screenshots/`).
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
