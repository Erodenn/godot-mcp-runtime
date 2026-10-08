import { lstatSync, realpathSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';

export function checkDisplayAvailable(): boolean {
  if (process.platform !== 'linux') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** The path segment that names the parent directory. */
const PARENT_SEGMENT = '..';
/** Either separator: a backslash separates segments in every spelling this server accepts. */
const ANY_SEPARATOR_REGEX = /[\\/]/;

/** Shape check for a directory with no root to be contained in: rejects empty and `..` segments, but `my..game` is a legal name. Paths inside a project go through `resolveProjectPath`. */
export function validatePath(path: string): boolean {
  return !!path && !path.split(ANY_SEPARATOR_REGEX).includes(PARENT_SEGMENT);
}

/** Godot's project-root URI scheme. */
const RES_PREFIX = 'res://';
/** Any URI scheme separator; a second one in a path is a smuggled scheme (`uid://`, `res://res://`). */
const URI_SCHEME_SEPARATOR = '://';
/** Ends a drive prefix, and on NTFS opens an alternate data stream (`a.tscn:x`); allowed only inside an absolute path's prefix. */
const DRIVE_OR_STREAM_SEPARATOR = ':';
/** Win32 strips these from the end of a name, so `main.tscn.` opens `main.tscn`. */
const WIN32_STRIPPED_NAME_END_REGEX = /[. ]$/;
/** The port numbers Win32 reserves after `COM` and `LPT`: 1 to 9, and superscript 1 to 3. */
const WIN32_PORT_DIGITS: readonly string[] = [...'123456789', '¹', '²', '³'];
/** Win32 device names: a file whose name before its first dot is one (`NUL`, `con.txt`, `COM1.gd`) opens the device in every directory. */
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

/** `child` relative to `parent` when it is `parent` (the empty string) or beneath it, else null; the one containment rule, case folded on Windows (drive letter included), exact elsewhere. */
function relativeWithin(parent: string, child: string): string | null {
  const rel = relative(parent, child);
  if (rel === PARENT_SEGMENT || rel.startsWith(PARENT_SEGMENT + sep) || isAbsolute(rel)) {
    return null;
  }
  return rel;
}

function isWin32DeviceName(segment: string): boolean {
  const stemEnd = segment.indexOf(NAME_STEM_END);
  const stem = (stemEnd === -1 ? segment : segment.slice(0, stemEnd)).trimEnd();
  return WIN32_DEVICE_NAMES.has(stem.toUpperCase());
}

/** True when a segment names the same file on every platform: Win32 drops a trailing dot or space (the name written is not the name opened), a colon opens an NTFS stream, and device names open devices. */
function isPortableSegment(segment: string): boolean {
  return (
    segment.trim() !== '' &&
    !WIN32_STRIPPED_NAME_END_REGEX.test(segment) &&
    !segment.includes(DRIVE_OR_STREAM_SEPARATOR) &&
    !isWin32DeviceName(segment)
  );
}

/** True when following links keeps the path inside the project: the deepest existing ancestor is resolved and compared with the real root, so an outward junction is refused while a project reached through a link is not. Never throws: an unresolvable ancestor is a refusal. */
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

/** A user-supplied project sub-path resolved once; callers pick the field matching where the value is going. */
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

/** What the caller will do with a resolved path. `'write'`: the deepest existing ancestor must really be inside the project, so an outward junction or symlink is refused.
 * `'read'`: a path spelled inside the project is accepted even through an outward link (an `addons/<plugin>` linked to a shared checkout) and returned as given, as Godot reads through it. */
export type PathAccess = 'read' | 'write';

/** Resolves a user path that must stay inside `projectPath` (bare relative, `./x`, `res://x`, absolute inside, backslashes; `..` is resolved and the result decides). Null for anything else, and for `access: 'write'` a path leaving the project through a link.
 * The segment-name rules apply on every platform so a project stays portable. */
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
  // Only an absolute path has a prefix a colon can belong to; `c:x.gd` is drive-relative, so where it lands depends on the working directory.
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

/** Extensions a `scene` argument of a launch may end in: Godot runs a positional argument as the scene only when it ends in one of these (case-sensitive), else the main scene runs, so anything outside would have the gate scan one file while the engine runs another. */
export const LAUNCH_SCENE_EXTENSIONS: readonly string[] = ['.tscn', '.scn'];

/** Extensions the engine runs as a command-line scene but the gate does not read: launched with a `Not scanned` warning, refused in strict mode. */
export const UNSCANNED_LAUNCH_SCENE_EXTENSIONS: readonly string[] = ['.escn', '.tres', '.res'];

/** Scene-file suffixes `add_node` accepts as a `nodeType` instead of a class name.
 * Mirrored by `_SCENE_SUFFIXES` in `src/scripts/godot_operations.gd` -- KEEP IN SYNC. */
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

/** Validates a scene-tree path (NodePath), a namespace separate from files so project-root containment does not apply: rejects empty and `..` segments; the relative form is the convention. */
export function validateNodePath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && !path.includes('..');
}

/** True when `child` is `parent` or beneath it by the `resolveProjectPath` rule (case folded on Windows), for defense-in-depth checks on bridge-returned paths such as screenshot files. */
export function isUnderDir(parent: string, child: string): boolean {
  return relativeWithin(resolve(parent), resolve(child)) !== null;
}

/** Platforms whose usual file system treats names that differ only in case as one file. */
const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);

/** One key per file whichever way its path was spelled; case is folded only where names differing in case are one file (on Linux `Main.tscn` and `main.tscn` get two keys). Project directories use `projectPathKey`, which folds everywhere. */
export function fileIdentityKey(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = resolve(absPath).split(sep).join('/');
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? normalized.toLowerCase() : normalized;
}

/** The lines an error gives for a path `resolveProjectPath` refused: one wording everywhere so the accepted spellings read the same. */
export const PROJECT_SUB_PATH_SOLUTIONS: readonly string[] = [
  'Pass a path inside the project. A bare path ("scenes/main.tscn"), "./", "res://", backslashes and an absolute path inside the project are all accepted',
  'A file or folder name must not end in a dot or a space or be a Windows device name (NUL, CON, COM1, ...), and a colon is allowed only in a drive prefix',
  'A path this call writes must not pass through a junction or symlink that leaves the project. A path that is only read may',
];

/** The message for a path `resolveProjectPath` refused; `field` names the parameter. */
export function projectSubPathError(field: string, rawPath: string): string {
  return `Invalid ${field}: "${rawPath}" resolves outside the project or is not a valid file name`;
}

export function projectGodotPath(projectDir: string): string {
  return join(projectDir, 'project.godot');
}
