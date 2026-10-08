import { randomBytes } from 'crypto';
import { normalize, resolve } from 'path';

// A force-killed process can report a negative signal-kill status as unsigned 32-bit (4294967295 for -1); Godot's own exits are small, so codes at or above 2^31 are reinterpreted as signed.
const INT32_SIGN_BOUNDARY = 2147483648; // 2^31
const UINT32_MODULUS = 4294967296; // 2^32

export function normalizeExitCode(code: number | null): number | null {
  if (code === null || code < INT32_SIGN_BOUNDARY) {
    return code;
  }
  return code - UINT32_MODULUS;
}

/** Folds backslashes and trailing slashes so Node's `path.normalize` output matches Godot's `globalize_path("res://")`. */
export function normalizeForCompare(p: string): string {
  return normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** One key per project directory whichever way its path was spelled (absolute, separators, trailing slash and case folded); the session map and the bridge's orphan-repair cache both key on it. */
export function projectPathKey(projectPath: string): string {
  return normalizeForCompare(resolve(projectPath)).toLowerCase();
}

/** Prefix of the one stdout line carrying a headless operation's JSON result; stdout is shared with the engine banner and project prints, so the payload is whatever follows it on its line.
 * KEEP IN SYNC with OPERATION_RESULT_SENTINEL in src/scripts/godot_operations.gd. */
export const OPERATION_RESULT_SENTINEL = 'MCP_OPERATION_RESULT:';

/** Environment variable carrying one run's result token to godot_operations.gd. KEEP IN SYNC with OPERATION_RESULT_TOKEN_ENV there. */
export const OPERATION_RESULT_TOKEN_ENV = 'MCP_OPERATION_RESULT_TOKEN';

/** Closes the token in a result line: sentinel, token, this, then the JSON.
 * KEEP IN SYNC with OPERATION_RESULT_TOKEN_END in godot_operations.gd. */
export const OPERATION_RESULT_TOKEN_END = ':';

const OPERATION_RESULT_TOKEN_BYTES = 16;

/** A fresh result token per headless run: the sentinel is a constant any project script can print (an autoload's `_exit_tree` runs after the result), so its position says nothing about who wrote it; the per-run token does. */
export function newOperationResultToken(): string {
  return randomBytes(OPERATION_RESULT_TOKEN_BYTES).toString('hex');
}

/** Text after `marker` on the last line carrying it, or null; never falls back to scanning for brackets. The marker can occur more than once on that line (quoted inside the payload, or an unterminated `printraw` before it),
 * so occurrences are tried left to right and the first followed by valid JSON wins: the last would start inside a string value. When none parses, the text after the first is returned so the failure is reported against what was emitted. */
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

/** The payload of the result line in `GodotRunner.executeOperation`'s stdout, null if none. Only for stdout already through `cleanStdout`, where forged result lines are told apart; raw stdout goes through `extractTokenFramedPayload`. */
export function extractOperationPayload(output: string): string | null {
  return payloadAfterMarker(output, OPERATION_RESULT_SENTINEL);
}

/** The payload of the line a run wrote to raw stdout framed with the sentinel and `resultToken`; a line with another token, or none, is not a result. */
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

export function stripOperationSentinel(output: string): string {
  return output.split(OPERATION_RESULT_SENTINEL).join('');
}

/** An operation's payload from its stdout, or the input unchanged; production code that must tell 'no payload' apart uses `extractOperationPayload`. */
export function extractJson(output: string): string {
  return extractOperationPayload(output) ?? output;
}

export function cleanOutput(output: string): string {
  const lines = output.split('\n');
  const cleanedLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('Godot Engine v')) return false;
    if (trimmed.startsWith('[DEBUG]')) return false;
    if (trimmed.startsWith('[INFO] Operation:')) return false;
    if (trimmed.startsWith('[INFO] Executing operation:')) return false;
    return true;
  });
  return cleanedLines.join('\n');
}

/** Reduces a headless operation's raw stdout to what handlers need: a result line framed with `resultToken` survives alone behind the bare sentinel; otherwise banner and status lines are filtered and the rest passes with the sentinel text removed, so a project script's line carrying it is never read as a result downstream. */
export function cleanStdout(stdout: string, resultToken: string): string {
  const payload = extractTokenFramedPayload(stdout, resultToken);
  if (payload !== null) {
    return OPERATION_RESULT_SENTINEL + payload;
  }
  return stripOperationSentinel(cleanOutput(stdout));
}

/** Renderer/device startup banner and engine URL, anchored on the banner shape (name + version + ' - ' + '- Using Device #') so a real line like 'OpenGL context lost' is never mistaken for it. */
const PROCESS_TAIL_BANNER_NOISE =
  /^(https:\/\/godotengine\.org|(?:Metal|Vulkan|OpenGL)\s+[\d.]+\s+-\s+.*-\s+Using Device #\d+:)/i;

/** Condenses a stdout/stderr tail to its diagnostic lines, capped to the last `maxLines`; if nothing survives, the last non-empty original line is kept so the caller sees something rather than an empty array. */
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

/** How far past a parse/compile error to scan for the `Failed to load script` echo naming the file: wide enough to clear a full GDScript backtrace. */
const LOAD_FAILURE_LOOKAHEAD_LINES = 10;

/** Parses Godot script-compiler diagnostics from stderr, the one parser for the headless `validate` and live-bridge `run_script` paths: compile errors are not returned by the triggering API (`load()` hands back a placeholder), only printed to stderr.
 * Recognizes `SCRIPT ERROR:`/`USER SCRIPT ERROR:` (the set GodotRunner.SCRIPT_ERROR_PATTERNS gates on) and bare `Parse Error: ... at line N`; bare `ERROR:` lines are captured but `Failed to load` echoes suppressed, as their `at:` points into engine source. */
export function parseScriptDiagnostics(stderr: string): StderrDiagnostic[] {
  const entries: StderrDiagnostic[] = [];
  if (!stderr) return entries;

  const lines = stderr.split('\n');
  const reportedFailures = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    const scriptErrorMatch = line.match(
      /(?:SCRIPT ERROR|USER SCRIPT ERROR):\s*(?:Parse Error:\s*)?(.+)/,
    );
    if (scriptErrorMatch) {
      const [, rawMessage = ''] = scriptErrorMatch;
      const message = rawMessage.trim();
      let lineNum: number | undefined;
      let filePath: string | undefined;
      // Whether the `at:` line named a path of any scheme; a `gdscript://` URI counts, having no res:// identity but a definite one.
      let atNamedAPath = false;

      // 'Failed to load script' echoes are suppressed only for the rest of this block; the primary SCRIPT ERROR above is the diagnostic.
      const next = lines[i + 1];
      if (next !== undefined) {
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

      // The `at:` line names a synthetic `gdscript://` URI or Godot's C++ source, leaving no res:// identity, and `validate` drops filePath-less entries:
      // adopt only the path from the following `Failed to load script` echo, never its line (it points at engine source).
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

      // Godot re-emits the same parse error once per load attempt of a script; keep the first.
      const key = `${filePath ?? ''}:${lineNum ?? 0}:${message}`;
      if (reportedFailures.has(key)) continue;
      reportedFailures.add(key);

      const entry: StderrDiagnostic = { message };
      if (lineNum !== undefined) entry.line = lineNum;
      if (filePath !== undefined) entry.filePath = filePath;
      entries.push(entry);
      continue;
    }

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

    // Bare `ERROR:` lines: non-script failures, mainly scene parse errors with an inline `[Resource file res://x:N]` location, which the blocks above miss.
    // `Failed to load script/resource` and `Failed loading resource:` echoes only restate a captured error with an engine-source `at:` line, so location comes only from the inline suffix.
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
