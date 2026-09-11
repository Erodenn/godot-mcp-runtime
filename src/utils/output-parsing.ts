import { normalize } from 'path';

/**
 * Normalize a path for cross-platform comparison.
 * Folds Windows backslashes to forward slashes and strips trailing slashes,
 * so Node's `path.normalize` output matches Godot's `globalize_path("res://")`.
 */
export function normalizeForCompare(p: string): string {
  return normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Extract JSON from Godot output by finding the first { or [ and matching to the end.
 * This strips debug logs, version banners, and other noise.
 */
export function extractJson(output: string): string {
  // Find the first occurrence of { or [
  const jsonStartBrace = output.indexOf('{');
  const jsonStartBracket = output.indexOf('[');

  let jsonStart = -1;
  if (jsonStartBrace === -1 && jsonStartBracket === -1) {
    return output; // No JSON found, return as-is
  } else if (jsonStartBrace === -1) {
    jsonStart = jsonStartBracket;
  } else if (jsonStartBracket === -1) {
    jsonStart = jsonStartBrace;
  } else {
    jsonStart = Math.min(jsonStartBrace, jsonStartBracket);
  }

  // Extract from JSON start to end
  const jsonPart = output.substring(jsonStart);

  // Try to parse to validate, if it fails return original
  try {
    JSON.parse(jsonPart.trim());
    return jsonPart.trim();
  } catch {
    // If the extracted part isn't valid JSON, try to find the last } or ]
    const lastBrace = jsonPart.lastIndexOf('}');
    const lastBracket = jsonPart.lastIndexOf(']');
    const lastEnd = Math.max(lastBrace, lastBracket);

    if (lastEnd > 0) {
      const extracted = jsonPart.substring(0, lastEnd + 1);
      try {
        JSON.parse(extracted);
        return extracted;
      } catch {
        return output; // Return original if still can't parse
      }
    }
    return output;
  }
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

export function cleanStdout(stdout: string): string {
  if (stdout.includes('{') || stdout.includes('[')) {
    return extractJson(stdout);
  }
  return cleanOutput(stdout);
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
