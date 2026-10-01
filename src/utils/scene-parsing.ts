/**
 * .tscn / project.godot parsing helpers shared by the run-script security
 * pipeline. Parallel in style to `autoload-ini.ts`: text parsing, no Godot
 * process required.
 *
 * Responsibilities:
 *  - Resolve the scene a `run_project` call will actually launch (explicit
 *    `scene` arg > `run/main_scene` in [application] > null).
 *  - Read a text scene with one quote-aware scanner (`scanTscn`): section
 *    headers, their attributes, and the string-valued properties that follow
 *    them, so a bracketed line inside a multi-line string is never mistaken
 *    for a header and a `]` inside a quoted path never ends one early.
 *  - Collect every script a scene brings with it (`collectSceneScripts`):
 *    the `.gd` files its `[ext_resource]` lines name, the source of inline
 *    `[sub_resource type="GDScript"]` scripts, and the same for every scene
 *    it references, transitively. A reference is classified by its path as
 *    well as by its `type` attribute, which is only a hint. A script attached
 *    to an instanced node, or assigned by an instance override, is always one
 *    of those two forms, so it is covered by construction.
 *  - Report what it could not read instead of skipping it: scripts that are
 *    not GDScript, binary scenes, resource files, scene files that exist and
 *    could not be read, malformed headers, unterminated strings.
 *
 * Not read (documented limitation, see `docs/security.md`): scripts carried by
 * non-scene resources a scene references (`.tres` / `.res`), binary `.scn`
 * scenes, and references by `uid://` alone. Each of these that the walk meets
 * is reported, not dropped. One limit is not reported: an `ext_resource` that
 * carries both a `uid` and a `path` is read by its `path`, while the engine
 * prefers the `uid`, so a stale `path` names a file the engine will not load.
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { projectGodotPath, stripResPrefix } from './path-validation.js';
import { walkIniSection } from './autoload-ini.js';

/** Longest slice of a source line kept in a header's `raw` text and in problem reports. */
const TSCN_RAW_SNIPPET_MAX = 200;
const TSCN_RES_PREFIX = 'res://';
const GDSCRIPT_EXTENSION = '.gd';
/** Path extensions an `ext_resource` is walked as a scene for, whatever its `type` says. */
const SCENE_FILE_EXTENSIONS: readonly string[] = ['.tscn', '.scn'];
/** Path extensions of resource files, which can carry a script the scan does not read. */
const RESOURCE_FILE_EXTENSIONS: readonly string[] = ['.tres', '.res'];
/**
 * `type` values that say an `ext_resource` is a script. Godot's loaders take
 * the base class or the concrete one, so a hand-edited `type="GDScript"` loads
 * exactly as `type="Script"` does.
 */
const SCRIPT_TYPE_HINTS: ReadonlySet<string> = new Set(['Script', 'GDScript', 'CSharpScript']);
const UNICODE_SHORT_ESCAPE_DIGITS = 4;
const UNICODE_LONG_ESCAPE_DIGITS = 6;
const HEX_BASE = 16;
const UNICODE_MAX_CODE_POINT = 0x10ffff;
const INLINE_SCRIPT_SOURCE_KEY = 'script/source';
const SCENE_HEADER_TAGS: ReadonlySet<string> = new Set(['gd_scene', 'gd_resource']);
const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['b', '\b'],
  ['f', '\f'],
]);
const NOT_TEXT_SCENE_REASON =
  'not a text scene (no [gd_scene] header); binary scenes cannot be scanned';

function isFileNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Read a scene file's content, returning null (not throwing) when the file
 * is missing — a stale ext_resource reference must not crash the pre-flight.
 */
function readSceneFileSafe(scenePath: string): string | null {
  try {
    return readFileSync(scenePath, 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) return null;
    throw err;
  }
}

// --- Text scene scanner ---

/** One `[tag key=value ...]` section header and the string properties under it. */
export interface TscnHeader {
  tag: string;
  /** Attribute values as written: quoted strings unescaped, bare tokens verbatim. */
  attrs: Map<string, string>;
  line: number;
  /** The header line, trimmed and capped at `TSCN_RAW_SNIPPET_MAX` characters. */
  raw: string;
  /** Property lines whose value is exactly one string, unescaped, by key. */
  stringProps: Map<string, string>;
}

export interface TscnScan {
  /** True when the first header is `gd_scene` or `gd_resource`. */
  isTextResource: boolean;
  headers: TscnHeader[];
  /** Headers and strings the scanner could not read; none of them is in `headers`. */
  malformed: Array<{ line: number; reason: string; raw: string }>;
}

export interface QuotedString {
  value: string;
  /** Index just past the closing quote. */
  end: number;
}

function snippet(text: string): string {
  return text.trimEnd().slice(0, TSCN_RAW_SNIPPET_MAX);
}

function countNewlines(content: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i++) {
    if (content[i] === '\n') count++;
  }
  return count;
}

function isBlank(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

/**
 * Read the quoted string whose opening quote is at `start`, unescaping it.
 * Returns null when no closing quote is found before `limit`.
 */
export function readQuoted(content: string, start: number, limit: number): QuotedString | null {
  let out = '';
  let i = start + 1;
  while (i < limit) {
    const ch = content[i]!;
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    const escaped = content[i + 1];
    if (escaped === undefined || i + 1 >= limit) return null;
    if (escaped === 'u' || escaped === 'U') {
      const digits = escaped === 'u' ? UNICODE_SHORT_ESCAPE_DIGITS : UNICODE_LONG_ESCAPE_DIGITS;
      const hex = content.slice(i + 2, i + 2 + digits);
      if (hex.length === digits && /^[0-9a-fA-F]+$/.test(hex)) {
        const code = parseInt(hex, HEX_BASE);
        if (code <= UNICODE_MAX_CODE_POINT) {
          out += String.fromCodePoint(code);
          i += 2 + digits;
          continue;
        }
      }
    }
    out += SIMPLE_ESCAPES.get(escaped) ?? escaped;
    i += 2;
  }
  return null;
}

type HeaderParse =
  | { ok: true; tag: string; attrs: Map<string, string> }
  | { ok: false; reason: string };

/**
 * Parse the header that starts at `start` (a `[`) and must end before
 * `lineEnd`. Quoted strings may hold `]`; a bare value such as
 * `ExtResource("1_a")` or `["x", "y"]` is read through its balanced brackets.
 */
function parseHeader(content: string, start: number, lineEnd: number): HeaderParse {
  let i = start + 1;
  const tagStart = i;
  while (i < lineEnd && /[A-Za-z0-9_]/.test(content[i]!)) i++;
  const tag = content.slice(tagStart, i);
  if (tag === '') return { ok: false, reason: 'header has no tag' };
  const attrs = new Map<string, string>();
  for (;;) {
    while (i < lineEnd && isBlank(content[i])) i++;
    if (i >= lineEnd) return { ok: false, reason: 'header has no closing bracket' };
    if (content[i] === ']') return { ok: true, tag, attrs };
    const keyStart = i;
    while (i < lineEnd && content[i] !== '=' && content[i] !== ']' && !isBlank(content[i])) i++;
    const key = content.slice(keyStart, i);
    // Blanks on either side of the `=` belong to neither the key nor the value.
    // Godot's own writer leaves one after it: `binds= [7]` on a connection.
    while (i < lineEnd && isBlank(content[i])) i++;
    if (key === '' || content[i] !== '=') {
      return { ok: false, reason: `attribute ${key === '' ? '' : key + ' '}has no value` };
    }
    i++;
    while (i < lineEnd && isBlank(content[i])) i++;
    if (content[i] === '"') {
      const quoted = readQuoted(content, i, lineEnd);
      if (quoted === null) return { ok: false, reason: 'unterminated string in header' };
      attrs.set(key, quoted.value);
      i = quoted.end;
      continue;
    }
    const valueStart = i;
    let depth = 0;
    while (i < lineEnd) {
      const c = content[i]!;
      if (c === '"') {
        const quoted = readQuoted(content, i, lineEnd);
        if (quoted === null) return { ok: false, reason: 'unterminated string in header' };
        i = quoted.end;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && isBlank(c)) break;
      i++;
    }
    if (i === valueStart) return { ok: false, reason: `attribute ${key} has no value` };
    attrs.set(key, content.slice(valueStart, i));
  }
}

/**
 * Read a `.tscn` / `.tres` text in one linear pass. A line whose first
 * non-blank character is `[` opens a header; any other line is a property of
 * the most recent header, and a string in its value runs to the closing quote
 * across newlines, so nothing inside a string is ever read as structure. A `;`
 * outside a string starts a comment that runs to the end of its line, as it
 * does for Godot's own parser, so a quote inside a comment opens nothing.
 *
 * The scanner reads one statement per line, the layout Godot writes. Godot's
 * own reader is not line-bound, so a file edited by hand to put two statements
 * on one line (a header followed by another header or by a property, or a
 * property followed by a header) loads there while the second statement is not
 * read here. `docs/security.md` lists this with the scan's other limits.
 */
export function scanTscn(content: string): TscnScan {
  const headers: TscnHeader[] = [];
  const malformed: TscnScan['malformed'] = [];
  const length = content.length;
  let i = 0;
  let line = 1;
  let current: TscnHeader | null = null;

  while (i < length) {
    // Godot skips blanks before a statement, so an indented header is still one.
    let headerAt = i;
    while (headerAt < length && isBlank(content[headerAt])) headerAt++;
    if (content[headerAt] === '[') {
      const newlineAt = content.indexOf('\n', headerAt);
      const lineEnd = newlineAt === -1 ? length : newlineAt;
      const parsed = parseHeader(content, headerAt, lineEnd);
      const raw = snippet(content.slice(headerAt, lineEnd));
      if (parsed.ok) {
        current = { tag: parsed.tag, attrs: parsed.attrs, line, raw, stringProps: new Map() };
        headers.push(current);
      } else {
        current = null;
        malformed.push({ line, reason: parsed.reason, raw });
      }
      i = lineEnd + 1;
      line++;
      continue;
    }

    let j = i;
    let equalsAt = -1;
    let commentAt = -1;
    let unterminated = false;
    while (j < length && content[j] !== '\n') {
      const c = content[j]!;
      if (c === ';') {
        commentAt = j;
        const newlineAt = content.indexOf('\n', j);
        j = newlineAt === -1 ? length : newlineAt;
        break;
      }
      if (c === '"') {
        const quoted = readQuoted(content, j, length);
        if (quoted === null) {
          malformed.push({
            line: line + countNewlines(content, i, j),
            reason: 'unterminated string',
            raw: snippet(content.slice(j)),
          });
          unterminated = true;
          j = length;
          break;
        }
        j = quoted.end;
        continue;
      }
      if (c === '=' && equalsAt === -1) equalsAt = j;
      j++;
    }
    if (current !== null && equalsAt !== -1 && !unterminated) {
      const valueEnd = commentAt === -1 ? j : commentAt;
      let valueStart = equalsAt + 1;
      while (valueStart < valueEnd && isBlank(content[valueStart])) valueStart++;
      if (content[valueStart] === '"') {
        const quoted = readQuoted(content, valueStart, length);
        if (quoted !== null && content.slice(quoted.end, valueEnd).trim() === '') {
          current.stringProps.set(content.slice(i, equalsAt).trim(), quoted.value);
        }
      }
    }
    line += countNewlines(content, i, Math.min(j, length)) + 1;
    i = j + 1;
  }

  return { isTextResource: SCENE_HEADER_TAGS.has(headers[0]?.tag ?? ''), headers, malformed };
}

// --- Launch scene resolution ---

/**
 * Read `run/main_scene` from `[application]` in project.godot. Returns the
 * `res://...` string if present, else null. Does NOT verify the file exists.
 */
export function readMainSceneFromProject(projectDir: string): string | null {
  const projectFile = projectGodotPath(projectDir);
  let content: string;
  try {
    content = readFileSync(projectFile, 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) return null;
    throw err;
  }
  let mainScene: string | null = null;
  walkIniSection(content, 'application', (trimmed) => {
    // Match: run/main_scene="res://main.tscn"  (quotes are always present
    // when Godot writes; tolerate omitted quotes for hand-edited files).
    const match = trimmed.match(/^run\/main_scene\s*=\s*"?([^"]+?)"?$/);
    if (match && match[1]) {
      mainScene = match[1];
      return true;
    }
  });
  return mainScene;
}

/**
 * Pick the scene that `run_project` will actually launch.
 *
 * Resolution order:
 *  1. Explicit `sceneArg` (caller's `scene` parameter) — already validated by
 *     `validateSubPath` before being passed here. Returned as an absolute path.
 *  2. `run/main_scene` from project.godot, with `res://` stripped and joined
 *     to the project root.
 *  3. null — no scene to scan. Caller logs a warning and skips the scene-script
 *     scan; autoload scan still runs.
 *
 * Returns an absolute filesystem path. Does NOT verify the file exists; the
 * caller's `existsSync` check produces the warning if the resolved path is
 * stale.
 */
export function resolveLaunchScene(projectDir: string, sceneArg?: string | null): string | null {
  if (sceneArg) {
    return join(projectDir, stripResPrefix(sceneArg));
  }
  const main = readMainSceneFromProject(projectDir);
  if (!main) return null;
  return join(projectDir, stripResPrefix(main));
}

// --- Script collection ---

/** An inline `[sub_resource type="GDScript"]` and the source it carries. */
export interface InlineSceneScript {
  /** Absolute path of the scene file that holds the sub-resource. */
  scenePath: string;
  id: string;
  source: string;
  /** Line of the sub-resource header in the scene file. */
  line: number;
}

/** Something the walk met and could not read. */
export interface UnscannedSceneItem {
  scenePath: string;
  reason: string;
  /**
   * True when `scenePath` exists and reading it failed (a permission error, a
   * directory in its place). Different from the other entries, which are files
   * of a kind the scan does not read: this one it set out to read and could
   * not, so a caller that must not launch on an incomplete scan can tell.
   */
  readFailed?: true;
}

export interface SceneScriptCollection {
  /** Absolute paths of the `.gd` files every reachable scene attaches. */
  scripts: string[];
  inlineScripts: InlineSceneScript[];
  unscanned: UnscannedSceneItem[];
}

function resPathOf(attrs: Map<string, string>): string | null {
  const path = attrs.get('path');
  return path !== undefined && path.startsWith(TSCN_RES_PREFIX) ? path : null;
}

/**
 * Transitively walk the scenes `scenePath` references and collect, from every
 * reachable scene, the `.gd` files its ext_resources name and the source of
 * its inline GDScript sub-resources. A hostile script attached to a
 * PackedScene the launched scene instances is invisible to a single-scene scan.
 *
 * An `ext_resource` is classified by its path as well as by its `type`
 * attribute. The engine loads the file the path names, and `type` is a hint a
 * hand-edited scene can set to anything: a `.gd` path is scanned and a `.tscn`
 * or `.scn` path is walked whatever the hint says. A reference the walk does
 * not follow and that can still bring a script in (a script that is not
 * GDScript, a `.tres` or `.res` resource, a reference with no `res://` path)
 * is listed in `unscanned`, never dropped.
 *
 * Cycle-safe: scene graphs can reference each other, so a scene already walked
 * (by resolved absolute path) is never walked again. Nothing throws on a stale
 * reference or on a file that cannot be read; whatever could not be read is
 * listed in `unscanned` so the caller can say the scan was incomplete.
 */
export function collectSceneScripts(scenePath: string, projectDir: string): SceneScriptCollection {
  const visited = new Set<string>();
  const scripts = new Set<string>();
  const inlineScripts: InlineSceneScript[] = [];
  const unscanned: UnscannedSceneItem[] = [];
  // One notice per resource file, however many scenes reference it.
  const reportedResources = new Set<string>();

  function walk(currentScenePath: string): void {
    const absScenePath = resolve(currentScenePath);
    if (visited.has(absScenePath)) return;
    visited.add(absScenePath);
    const skip = (reason: string): void => {
      unscanned.push({ scenePath: absScenePath, reason });
    };

    let content: string | null;
    try {
      content = readSceneFileSafe(currentScenePath);
    } catch (err) {
      // The file is there and could not be read. One entry for it, and the
      // walk goes on: a throw here used to abandon every scene and autoload
      // the caller had not reached yet, with nothing naming them.
      const detail = err instanceof Error ? err.message : String(err);
      unscanned.push({
        scenePath: absScenePath,
        reason: `scene file could not be read (${detail})`,
        readFailed: true,
      });
      return;
    }
    if (content === null) {
      skip('scene file not found');
      return;
    }
    const scan = scanTscn(content);
    if (!scan.isTextResource) {
      skip(NOT_TEXT_SCENE_REASON);
      return;
    }

    for (const header of scan.headers) {
      if (header.tag === 'ext_resource') {
        const type = header.attrs.get('type') ?? '';
        const path = resPathOf(header.attrs);
        const lowered = path === null ? '' : path.toLowerCase();
        if (path !== null && lowered.endsWith(GDSCRIPT_EXTENSION)) {
          scripts.add(join(projectDir, stripResPrefix(path)));
        } else if (path !== null && SCENE_FILE_EXTENSIONS.some((ext) => lowered.endsWith(ext))) {
          walk(join(projectDir, stripResPrefix(path)));
        } else if (type === 'PackedScene') {
          if (path === null) skip(`PackedScene ext_resource has no res:// path: ${header.raw}`);
          else walk(join(projectDir, stripResPrefix(path)));
        } else if (SCRIPT_TYPE_HINTS.has(type)) {
          if (path === null) skip(`Script ext_resource has no res:// path: ${header.raw}`);
          else skip(`script ${path} is not GDScript and is not scanned`);
        } else if (path === null) {
          skip(`ext_resource has no res:// path and was not followed: ${header.raw}`);
        } else if (RESOURCE_FILE_EXTENSIONS.some((ext) => lowered.endsWith(ext))) {
          if (!reportedResources.has(lowered)) {
            reportedResources.add(lowered);
            skip(`resource ${path} is not scanned (a .tres or .res file can carry a script)`);
          }
        }
      } else if (header.tag === 'sub_resource' && header.attrs.get('type') === 'GDScript') {
        const id = header.attrs.get('id') ?? '?';
        const source = header.stringProps.get(INLINE_SCRIPT_SOURCE_KEY);
        if (source === undefined) skip(`inline GDScript ${id} has no readable script/source`);
        else inlineScripts.push({ scenePath: absScenePath, id, source, line: header.line });
      }
    }
    for (const problem of scan.malformed) {
      if (
        problem.reason === 'unterminated string' ||
        problem.raw.startsWith('[ext_resource') ||
        problem.raw.startsWith('[sub_resource')
      ) {
        skip(`${problem.reason} at line ${problem.line}: ${problem.raw}`);
      }
    }
  }

  walk(scenePath);
  return { scripts: Array.from(scripts), inlineScripts, unscanned };
}

/**
 * Extract the `[ext_resource path="res://....gd"]` references of one scene as
 * absolute filesystem paths under the project root, whatever their `type`
 * attribute says (see `collectSceneScripts`).
 *
 * Does not chase subscenes (use `collectSceneScripts` for the transitive walk)
 * and does not read inline `[sub_resource type="GDScript"]` source. Returns
 * paths even when the file does not exist on disk; the caller owns the
 * existence check. A missing scene yields `[]`.
 */
export function extractSceneScripts(scenePath: string, projectDir: string): string[] {
  const content = readSceneFileSafe(scenePath);
  if (content === null) return [];
  const result: string[] = [];
  for (const header of scanTscn(content).headers) {
    if (header.tag !== 'ext_resource') continue;
    const path = resPathOf(header.attrs);
    if (path === null || !path.toLowerCase().endsWith(GDSCRIPT_EXTENSION)) continue;
    result.push(join(projectDir, stripResPrefix(path)));
  }
  return result;
}

/** The `string[]` view of `collectSceneScripts`: every `.gd` path the walk reaches. */
export function collectSceneScriptsRecursive(scenePath: string, projectDir: string): string[] {
  return collectSceneScripts(scenePath, projectDir).scripts;
}
