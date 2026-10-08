import { randomBytes } from 'crypto';
import { normalize, resolve } from 'path';

// A force-killed process can report its exit code as the unsigned 32-bit
// representation of a negative signal-kill status (e.g. 4294967295 for -1).
// Godot's own exits are small non-negative integers, so any observed code at
// or above 2^31 is reinterpreted as its signed 32-bit equivalent.
const INT32_SIGN_BOUNDARY = 2147483648; // 2^31
const UINT32_MODULUS = 4294967296; // 2^32

/**
 * Normalize a raw process exit code to a signed 32-bit value, so a
 * force-killed process (e.g. `4294967295`) reports as `-1` instead of an
 * unsigned value that reads like a real Godot exit status.
 */
export function normalizeExitCode(code: number | null): number | null {
  if (code === null || code < INT32_SIGN_BOUNDARY) {
    return code;
  }
  return code - UINT32_MODULUS;
}

/**
 * Normalize a path for cross-platform comparison.
 * Folds Windows backslashes to forward slashes and strips trailing slashes,
 * so Node's `path.normalize` output matches Godot's `globalize_path("res://")`.
 */
export function normalizeForCompare(p: string): string {
  return normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * One key per project directory, whichever way its path was spelled: resolved
 * to absolute, separators and trailing slash folded, case folded. The session
 * map (`sessionKey`) and the bridge's orphan-repair cache both key on it, so a
 * path given with forward slashes and the same path resolved by Node land on
 * the same entry.
 */
export function projectPathKey(projectPath: string): string {
  return normalizeForCompare(resolve(projectPath)).toLowerCase();
}

/**
 * Prefix of the one stdout line that carries a headless operation's JSON
 * result. stdout is shared with the engine banner and with any print() an
 * autoload or scene script makes, so the payload is whatever follows this
 * marker on its line and nothing else. KEEP IN SYNC with
 * OPERATION_RESULT_SENTINEL in src/scripts/godot_operations.gd.
 */
export const OPERATION_RESULT_SENTINEL = 'MCP_OPERATION_RESULT:';

/**
 * Environment variable that carries one run's result token to
 * godot_operations.gd. KEEP IN SYNC with OPERATION_RESULT_TOKEN_ENV there.
 */
export const OPERATION_RESULT_TOKEN_ENV = 'MCP_OPERATION_RESULT_TOKEN';

/**
 * Closes the token in a result line: sentinel, token, this, then the JSON.
 * KEEP IN SYNC with OPERATION_RESULT_TOKEN_END in godot_operations.gd.
 */
export const OPERATION_RESULT_TOKEN_END = ':';

const OPERATION_RESULT_TOKEN_BYTES = 16;

/**
 * A fresh result token for one headless run. The sentinel is a constant any
 * project script can print, before the operation or after it (an autoload's
 * `_exit_tree` runs after the result is written), so the position of a
 * sentinel line says nothing about who wrote it. The token does: it is drawn
 * per run and the script echoes it in its frame.
 */
export function newOperationResultToken(): string {
  return randomBytes(OPERATION_RESULT_TOKEN_BYTES).toString('hex');
}

/**
 * Return the text after `marker` on the last line that carries it, or null
 * when no line does. Never falls back to scanning for brackets: text that was
 * not taken from a marked line is not a payload.
 *
 * The emitter writes the marker once, at the start of the payload. The text
 * can still occur more than once on that line: inside the payload itself (a
 * Label whose text quotes it, a requested node name echoed in a warning), or
 * in front of it (an unterminated `printraw` from a project script). So the
 * occurrences are tried left to right and the first one followed by valid
 * JSON is the payload. Taking the last one would start inside a string value
 * of a payload that quotes the marker, and report a finished operation as
 * invalid JSON. When none parses, the text after the first is returned so the
 * caller reports the parse failure against what the operation emitted.
 */
function payloadAfterMarker(output: string, marker: string): string | null {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    let at = line.indexOf(marker);
    if (at === -1) continue;
    const first = line.substring(at + marker.length).trim();
    while (at !== -1) {
      const candidate = line.substring(at + marker.length).trim();
      if (isJsonText(candidate)) return candidate;
      at = line.indexOf(marker, at + marker.length);
    }
    return first;
  }
  return null;
}

/**
 * The payload of the result line in the stdout `GodotRunner.executeOperation`
 * returns, or null when it holds none. That stdout has already been through
 * `cleanStdout`, which is where a result line is told from a forged one: do
 * not call this on a process's raw stdout, where any script can print the
 * sentinel. Raw stdout is read with `extractTokenFramedPayload`.
 */
export function extractOperationPayload(output: string): string | null {
  return payloadAfterMarker(output, OPERATION_RESULT_SENTINEL);
}

/**
 * The payload of the result line a headless run wrote to its raw stdout: the
 * line framed with the sentinel and `resultToken`, the token this run was
 * handed. A sentinel line with another token, or with none, is not a result.
 */
export function extractTokenFramedPayload(rawStdout: string, resultToken: string): string | null {
  return payloadAfterMarker(
    rawStdout,
    OPERATION_RESULT_SENTINEL + resultToken + OPERATION_RESULT_TOKEN_END,
  );
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the sentinel prefix from any stdout that is about to be shown to a
 * user, so the framing never leaks into a response or error message.
 */
export function stripOperationSentinel(output: string): string {
  return output.split(OPERATION_RESULT_SENTINEL).join('');
}

/**
 * Pull an operation's JSON payload out of its stdout. Returns the sentinel
 * line's payload, or the input unchanged when no sentinel line exists.
 * Production code that must tell "no payload" apart from a payload uses
 * `extractOperationPayload`; this form exists for callers (tests) that parse
 * the result of `GodotRunner.executeOperation` directly.
 */
export function extractJson(output: string): string {
  return extractOperationPayload(output) ?? output;
}

/**
 * Strip Godot banner and debug lines from output, keeping only meaningful content.
 */
export function cleanOutput(output: string): string {
  const lines = output.split('\n');
  const cleanedLines = lines.filter((line) => {
    const trimmed = line.trim();
    // Skip empty lines
    if (!trimmed) return false;
    // Skip Godot version banner
    if (trimmed.startsWith('Godot Engine v')) return false;
    // Skip debug lines
    if (trimmed.startsWith('[DEBUG]')) return false;
    // Skip info lines that are just status updates
    if (trimmed.startsWith('[INFO] Operation:')) return false;
    if (trimmed.startsWith('[INFO] Executing operation:')) return false;
    return true;
  });
  return cleanedLines.join('\n');
}

/**
 * Reduce a headless operation's raw stdout to what the handlers need. When the
 * run wrote a result line framed with `resultToken`, only that payload
 * survives, behind the bare sentinel, so downstream code can tell a payload
 * from noise with `extractOperationPayload`. Without one, banner and status
 * lines are filtered and the rest passes through as a non-payload message,
 * with the sentinel text removed: what leaves here carries the sentinel only
 * where this function put it, so a line a project script printed with it is
 * never read as a result further down.
 */
export function cleanStdout(stdout: string, resultToken: string): string {
  const payload = extractTokenFramedPayload(stdout, resultToken);
  if (payload !== null) {
    return OPERATION_RESULT_SENTINEL + payload;
  }
  return stripOperationSentinel(cleanOutput(stdout));
}

/**
 * Renderer/device startup banner and engine URL — printed once per process
 * launch and carrying no diagnostic value on their own. Anchored on the
 * actual Godot banner shape (renderer name + version + " - " + the
 * "- Using Device #" marker) rather than a bare word prefix, so a genuine
 * runtime line like "OpenGL context lost" or "Vulkan device removed" is
 * never mistaken for the banner.
 */
const PROCESS_TAIL_BANNER_NOISE =
  /^(https:\/\/godotengine\.org|(?:Metal|Vulkan|OpenGL)\s+[\d.]+\s+-\s+.*-\s+Using Device #\d+:)/i;

/**
 * Condense a process's stdout/stderr tail to its diagnostically relevant
 * lines, capped to the last `maxLines`. Reuses `cleanOutput`'s blank-line /
 * version-banner / debug-log rules and additionally drops the
 * renderer/device banner and engine URL. If nothing survives filtering,
 * falls back to the last non-empty original line so the caller sees
 * something of the process tail rather than an unexplained empty array.
 */
export function condenseProcessTail(lines: string[], maxLines: number): string[] {
  const cleaned = cleanOutput(lines.join('\n'));
  const bannerFiltered = (cleaned === '' ? [] : cleaned.split('\n')).filter(
    (line) => !PROCESS_TAIL_BANNER_NOISE.test(line.trim()),
  );
  if (bannerFiltered.length > 0) {
    return bannerFiltered.slice(-maxLines);
  }
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim() !== '');
  return lastNonEmpty !== undefined ? [lastNonEmpty] : [];
}

export interface StderrDiagnostic {
  message: string;
  line?: number;
  filePath?: string;
}

/**
 * How far past a parse/compile error to scan for the `Failed to load script`
 * echo that names the offending file. Wide enough to clear a full GDScript
 * backtrace between the two lines.
 */
const LOAD_FAILURE_LOOKAHEAD_LINES = 10;

/**
 * Parse Godot script-compiler diagnostics from a raw stderr stream.
 *
 * Both the headless `validate` path and the live-bridge `run_script` path hit
 * the same underlying failure: GDScript compile errors are not returned by
 * the API call that triggers them (`load()` hands back a placeholder
 * resource; `GDScript.reload()` returns a bare error code) — the message,
 * line number, and location are printed to stderr in Godot's canonical
 * format:
 *
 *   SCRIPT ERROR: Parse Error: Identifier "x" not declared in the current scope.
 *             at: GDScript::reload (res://scripts/foo.gd:3)
 *
 * This is the single shared parser for that format. Behavior:
 *
 * - Recognizes `SCRIPT ERROR:` / `USER SCRIPT ERROR:` prefixes (the same
 *   marker set GodotRunner.SCRIPT_ERROR_PATTERNS gates on) plus bare
 *   `Parse Error: ... at line N` lines.
 * - Extracts the file + line from the `at:` line that follows, tolerating
 *   the `<method> (path:line)` and bare `path:line` forms. `gdscript://`
 *   URIs (runtime-compiled sources with no res:// identity) yield no
 *   filePath — the line number still applies to the submitted source.
 * - When a parse/compile error's `at:` line names no path at all, adopts the
 *   path (never the line) from a nearby `Failed to load script "res://..."`
 *   echo, so batch attribution in `validate` can still place the error. A
 *   `gdscript://` URI counts as a path, so a runtime-compiled source is never
 *   relabelled with an unrelated file from surrounding stderr.
 * - Captures bare `ERROR:` lines (non-script failures — notably scene file
 *   parse errors carrying an inline `[Resource file res://x:N]` location),
 *   while suppressing the redundant `Failed to load/load` echo lines whose
 *   `at:` lines point into Godot's engine source (e.g.
 *   gdscript_resource_format.cpp:46) and would surface as bogus line
 *   numbers for the user's file.
 */
export function parseScriptDiagnostics(stderr: string): StderrDiagnostic[] {
  const entries: StderrDiagnostic[] = [];
  if (!stderr) return entries;

  const lines = stderr.split('\n');
  const reportedFailures = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    // Pattern: "SCRIPT ERROR: Parse Error: MESSAGE" (or without "Parse Error:")
    const scriptErrorMatch = line.match(
      /(?:SCRIPT ERROR|USER SCRIPT ERROR):\s*(?:Parse Error:\s*)?(.+)/,
    );
    if (scriptErrorMatch) {
      const [, rawMessage = ''] = scriptErrorMatch;
      const message = rawMessage.trim();
      let lineNum: number | undefined;
      let filePath: string | undefined;
      // Whether the `at:` line named a path of any scheme. A `gdscript://`
      // URI counts: it has no res:// identity but it is still a definite one.
      let atNamedAPath = false;

      // "Failed to load script" echoes are suppressed only for the rest of
      // this block — the primary SCRIPT ERROR above them is the diagnostic.
      const next = lines[i + 1];
      if (next !== undefined) {
        // "<method> (res://path:line)" and bare "res://path:line"
        const atMatch = next.match(
          /\s*at:\s*(?:[^()\n]*\()?\(?((?:res:|gdscript:|file:)?\/\/[^):"\s]+):(\d+)\)?/,
        );
        if (atMatch) {
          const [, path = '', lineStr = '0'] = atMatch;
          filePath = path.startsWith('res://') ? path : undefined;
          lineNum = parseInt(lineStr, 10);
          atNamedAPath = true;
          i++;
        }
      }

      // The `at:` line of a parse/compile error names a synthetic
      // `gdscript://` URI (runtime-compiled source) or points into Godot's
      // own C++ source, leaving the entry with no res:// identity. Batch
      // attribution in `validate` drops filePath-less entries, so recover the
      // path from the `Failed to load script "res://..."` echo that follows
      // within a full GDScript backtrace. Only the path is adopted -- the
      // echo's own `at:` line points at engine source and would surface as a
      // bogus line number in the user's file.
      if (!filePath && !atNamedAPath && /Parse Error|Compile Error/i.test(line)) {
        const lookaheadLimit = Math.min(i + LOAD_FAILURE_LOOKAHEAD_LINES + 1, lines.length);
        for (let j = i + 1; j < lookaheadLimit; j++) {
          const lookLine = lines[j];
          if (lookLine === undefined) continue;
          const failMatch = lookLine.match(
            /Failed to load (?:script|resource):?\s*"?(res:\/\/[^":\s]+)/,
          );
          if (failMatch) {
            filePath = failMatch[1];
            break;
          }
        }
      }

      // De-duplicate: Godot re-emits the same parse error once per load
      // attempt of the same script (e.g. `load()` in validate + the engine's
      // own retry). Keep the first occurrence.
      const key = `${filePath ?? ''}:${lineNum ?? 0}:${message}`;
      if (reportedFailures.has(key)) continue;
      reportedFailures.add(key);

      const entry: StderrDiagnostic = { message };
      if (lineNum !== undefined) entry.line = lineNum;
      if (filePath !== undefined) entry.filePath = filePath;
      entries.push(entry);
      continue;
    }

    // Pattern: "Parse Error: MESSAGE at line LINE" (older headless format)
    const parseErrorMatch = line.match(/Parse Error:\s*(.+?)\s+at line\s+(\d+)/);
    if (parseErrorMatch) {
      const [, parseMsg = '', parseLine = '0'] = parseErrorMatch;
      const message = parseMsg.trim();
      const key = `:${parseInt(parseLine, 10)}:${message}`;
      if (reportedFailures.has(key)) continue;
      reportedFailures.add(key);
      entries.push({ line: parseInt(parseLine, 10), message });
      continue;
    }

    // Pattern: bare "ERROR: ..." lines — non-script failures, most importantly
    // scene/resource file parse errors emitted during scene validation:
    //   ERROR: Parse Error: Parse error. [Resource file res://main.tscn:4]
    // These carry no SCRIPT ERROR prefix, so the blocks above miss them.
    // Guard rails:
    // - "Failed to load script/resource" echoes merely restate an error
    //   already captured (with an engine-source at: line that would
    //   masquerade as a line number in the user's file).
    // - "Failed loading resource:" is the same echo class for scene loads.
    // - The at: line below a bare ERROR points into Godot's C++ engine
    //   source (e.g. resource_format_text.cpp:293), never into the user's
    //   file, so line/location info is taken only from the inline
    //   [Resource file res://x:N] suffix when present.
    const bareErrorMatch = line.match(/^ERROR:\s*(.+)/);
    if (bareErrorMatch) {
      const [, rawMessage = ''] = bareErrorMatch;
      let message = rawMessage.trim();
      if (
        /^Failed to load (script|resource)/i.test(message) ||
        /^Failed loading resource/i.test(message)
      ) {
        continue;
      }
      let lineNum: number | undefined;
      let filePath: string | undefined;
      const resFileMatch = message.match(/\[Resource file (res:\/\/[^:\]]+):(\d+)\]/);
      if (resFileMatch) {
        filePath = resFileMatch[1];
        lineNum = parseInt(resFileMatch[2] ?? '0', 10);
        message = message.replace(/\s*\[Resource file res:\/\/[^:\]]+:\d+\]/, '').trim();
      }
      const key = `bare:${filePath ?? ''}:${lineNum ?? 0}:${message}`;
      if (reportedFailures.has(key)) continue;
      reportedFailures.add(key);
      const entry: StderrDiagnostic = { message };
      if (lineNum !== undefined) entry.line = lineNum;
      if (filePath !== undefined) entry.filePath = filePath;
      entries.push(entry);
      continue;
    }
  }

  return entries;
}
