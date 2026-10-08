import { lstatSync, realpathSync } from 'fs';
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

/** The path segment that names the parent directory. */
const PARENT_SEGMENT = '..';
/** Either separator: a backslash separates segments in every spelling this server accepts. */
const ANY_SEPARATOR_REGEX = /[\\/]/;

/**
 * Shape check for a directory path that has no root to be contained in (a
 * project directory, a directory to search). Rejects an empty path and a `..`
 * segment. A name that merely contains two dots (`my..game`) is a legal name
 * and passes. Paths inside a project go through `resolveProjectPath`, where
 * containment decides instead.
 */
export function validatePath(path: string): boolean {
  return !!path && !path.split(ANY_SEPARATOR_REGEX).includes(PARENT_SEGMENT);
}

/** Godot's project-root URI scheme. */
const RES_PREFIX = 'res://';
/** Any URI scheme separator; a second one in a path is a smuggled scheme (`uid://`, `res://res://`). */
const URI_SCHEME_SEPARATOR = '://';
/**
 * Ends a drive prefix, and on NTFS opens an alternate data stream
 * (`a.tscn:x`). Allowed only inside the prefix of an absolute path.
 */
const DRIVE_OR_STREAM_SEPARATOR = ':';
/** Win32 strips these from the end of a name, so `main.tscn.` opens `main.tscn`. */
const WIN32_STRIPPED_NAME_END_REGEX = /[. ]$/;
/** The port numbers Win32 reserves after `COM` and `LPT`: 1 to 9, and superscript 1 to 3. */
const WIN32_PORT_DIGITS: readonly string[] = [...'123456789', '¹', '²', '³'];
/**
 * Names Win32 gives to devices. A file whose name before its first dot is one
 * of them (`NUL`, `con.txt`, `COM1.gd`) opens the device, not a file, in every
 * directory.
 */
const WIN32_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CONIN$',
  'CONOUT$',
  ...['COM', 'LPT'].flatMap((port) => WIN32_PORT_DIGITS.map((digit) => port + digit)),
]);
/** Ends the part of a file name Win32 compares with its device names. */
const NAME_STEM_END = '.';
/** `lstat` on a path that runs through a file: nothing exists at that depth. */
const NOT_A_DIRECTORY_ERROR_CODE = 'ENOTDIR';

/**
 * `child` relative to `parent` when it is `parent` itself (the empty string)
 * or lies beneath it, else null. This is the one containment rule: separators
 * are normalised by `path.relative`, and case is compared the way the platform
 * compares paths (folded on Windows, drive letter included; exact elsewhere).
 * `resolveProjectPath` and `isUnderDir` both answer from it.
 */
function relativeWithin(parent: string, child: string): string | null {
  const rel = relative(parent, child);
  if (rel === PARENT_SEGMENT || rel.startsWith(PARENT_SEGMENT + sep) || isAbsolute(rel)) {
    return null;
  }
  return rel;
}

/**
 * True when a segment's stem, the text before its first dot with trailing
 * blanks dropped, is a Win32 device name in any letter case.
 */
function isWin32DeviceName(segment: string): boolean {
  const stemEnd = segment.indexOf(NAME_STEM_END);
  const stem = (stemEnd === -1 ? segment : segment.slice(0, stemEnd)).trimEnd();
  return WIN32_DEVICE_NAMES.has(stem.toUpperCase());
}

/**
 * True when a path segment names the same file on every platform: not blank,
 * no trailing dot or space (Win32 drops them, so the name written is not the
 * name opened), no colon (an NTFS alternate data stream), and not a Win32
 * device name.
 */
function isPortableSegment(segment: string): boolean {
  return (
    segment.trim() !== '' &&
    !WIN32_STRIPPED_NAME_END_REGEX.test(segment) &&
    !segment.includes(DRIVE_OR_STREAM_SEPARATOR) &&
    !isWin32DeviceName(segment)
  );
}

/**
 * True when following links keeps the path inside the project. The deepest
 * ancestor of the path that exists below `root` is resolved to its real path
 * and compared with the real path of `root`, so a junction or symlink inside
 * the project that points outside it is refused while a project that is itself
 * reached through a link is not. A path with no existing ancestor below `root`
 * crosses no link. Never throws: an ancestor that exists and cannot be
 * resolved (a dangling link, a permission error) is a refusal.
 */
function staysInsideRealRoot(root: string, segments: readonly string[]): boolean {
  for (let depth = segments.length; depth > 0; depth--) {
    const ancestor = join(root, ...segments.slice(0, depth));
    try {
      if (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === NOT_A_DIRECTORY_ERROR_CODE) continue;
      return false;
    }
    try {
      return relativeWithin(realpathSync.native(root), realpathSync.native(ancestor)) !== null;
    } catch {
      return false;
    }
  }
  return true;
}

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
 * What the caller will do with a resolved path, which decides how links are
 * treated. Reads follow links; writes do not leave the project.
 *  - `'write'`: the server, or the Godot process it starts, creates or
 *    modifies the file. The deepest existing ancestor must really be inside
 *    the project, so a junction or symlink that points outside is refused.
 *  - `'read'`: the file is only read, or only referenced by value. A path
 *    whose spelling is inside the project is accepted even when a link on the
 *    way points outside (an `addons/<plugin>` folder linked to a shared
 *    checkout), and is returned as given: Godot reads through the link the
 *    same way.
 */
export type PathAccess = 'read' | 'write';

/**
 * Resolve a user-supplied path that must stay inside `projectPath`. Accepts a
 * bare relative path, `./x`, `res://x`, an absolute path inside the project,
 * and backslash separators. `..` segments are resolved and the result decides:
 * `a/../b.gd` is `b.gd`, `../x` is outside.
 *
 * Returns null for anything else: empty or non-string input, a second URI
 * scheme, the project root itself, a path that resolves outside the root
 * (`path.join('/project', '/etc/passwd')` is `/etc/passwd`), a segment that is
 * blank, ends in a dot or a space or is a Win32 device name, a colon after the
 * drive or scheme prefix, and, for `access: 'write'`, a path that leaves the
 * project through a junction or symlink. The name rules apply on every
 * platform, so a project stays portable.
 */
export function resolveProjectPath(
  projectPath: string,
  userPath: string,
  access: PathAccess,
): ResolvedProjectPath | null {
  if (typeof userPath !== 'string' || userPath === '') return null;
  const candidate = (
    userPath.startsWith(RES_PREFIX) ? userPath.slice(RES_PREFIX.length) : userPath
  ).replace(/\\/g, '/');
  if (candidate === '' || candidate.includes(URI_SCHEME_SEPARATOR)) return null;
  // Only an absolute path has a prefix a colon can belong to. `c:x.gd` is
  // drive-relative: where it lands depends on the working directory.
  if (!isAbsolute(candidate) && candidate.includes(DRIVE_OR_STREAM_SEPARATOR)) return null;

  const root = resolve(projectPath);
  const absPath = resolve(root, candidate);
  const rel = relativeWithin(root, absPath);
  if (rel === null || rel === '') return null;

  const segments = rel.split(sep);
  if (!segments.every(isPortableSegment)) return null;
  if (access === 'write' && !staysInsideRealRoot(root, segments)) return null;

  const relPath = segments.join('/');
  return { input: userPath, relPath, absPath, resPath: RES_PREFIX + relPath };
}

/**
 * File extensions a `scene` argument of a launch (`run_project`,
 * `render_movie`) may end in. Godot treats a positional argument as the scene
 * to run only when it ends in a scene or resource extension, compared case
 * sensitively; any other argument is ignored and the project's main scene runs
 * instead. So a `scene` outside these lists would have the launch gate scan one
 * file while the engine runs another. The gate reads `.tscn` and reports `.scn`
 * as not scanned.
 */
export const LAUNCH_SCENE_EXTENSIONS: readonly string[] = ['.tscn', '.scn'];

/**
 * Extensions the engine also runs as a command-line scene but the launch gate
 * does not read: it launches with a `Not scanned` warning, and strict mode
 * refuses it.
 */
export const UNSCANNED_LAUNCH_SCENE_EXTENSIONS: readonly string[] = ['.escn', '.tres', '.res'];

/**
 * Scene-file suffixes `add_node` accepts as a `nodeType` in place of a Godot
 * class name. Mirrored by `_SCENE_SUFFIXES` in
 * `src/scripts/godot_operations.gd` -- KEEP IN SYNC.
 */
const NODE_TYPE_SCENE_SUFFIXES: readonly string[] = ['.tscn', '.scn'];

/** True when a `nodeType` names a scene file to instance, not a class. */
export function isSceneFileNodeType(nodeType: string): boolean {
  const lowered = nodeType.toLowerCase();
  return NODE_TYPE_SCENE_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
}

/** True when `scene` ends, case-sensitively, in an extension a launch accepts. */
export function isLaunchScenePath(scene: string): boolean {
  return (
    LAUNCH_SCENE_EXTENSIONS.some((extension) => scene.endsWith(extension)) ||
    isUnscannedLaunchScenePath(scene)
  );
}

/** True when `scene` ends, case-sensitively, in an extension the launch gate does not read. */
export function isUnscannedLaunchScenePath(scene: string): boolean {
  return UNSCANNED_LAUNCH_SCENE_EXTENSIONS.some((extension) => scene.endsWith(extension));
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
 * True when `child` resolves to `parent` or a path beneath it, by the same
 * rule `resolveProjectPath` contains a path with: case folded on Windows, so
 * a path a game reports with another drive-letter or directory case is still
 * inside. Used by defense-in-depth checks on bridge-returned paths (e.g.
 * screenshot files that must live under `.mcp/godot-runtime/screenshots/`).
 */
export function isUnderDir(parent: string, child: string): boolean {
  return relativeWithin(resolve(parent), resolve(child)) !== null;
}

/** Platforms whose usual file system treats names that differ only in case as one file. */
const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);

/**
 * One key per file, whichever way its path was spelled: resolved to absolute,
 * separators written as '/', and case folded only on a platform where two
 * names that differ in case are the same file. On Linux `Main.tscn` and
 * `main.tscn` are two files and get two keys. For keying per-file state;
 * project directories are keyed by `projectPathKey`, which folds everywhere.
 */
export function fileIdentityKey(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = resolve(absPath).split(sep).join('/');
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? normalized.toLowerCase() : normalized;
}

/**
 * The lines an error response gives for a path `resolveProjectPath` refused.
 * One wording for every tool, so the accepted spellings are stated the same
 * way everywhere.
 */
export const PROJECT_SUB_PATH_SOLUTIONS: readonly string[] = [
  'Pass a path inside the project. A bare path ("scenes/main.tscn"), "./", "res://", backslashes and an absolute path inside the project are all accepted',
  'A file or folder name must not end in a dot or a space or be a Windows device name (NUL, CON, COM1, ...), and a colon is allowed only in a drive prefix',
  'A path this call writes must not pass through a junction or symlink that leaves the project. A path that is only read may',
];

/** The message for a path `resolveProjectPath` refused; `field` names the parameter. */
export function projectSubPathError(field: string, rawPath: string): string {
  return `Invalid ${field}: "${rawPath}" resolves outside the project or is not a valid file name`;
}

/**
 * Build the absolute path to a project's `project.godot` manifest. Use this
 * instead of `join(dir, 'project.godot')` ad hoc.
 */
export function projectGodotPath(projectDir: string): string {
  return join(projectDir, 'project.godot');
}
