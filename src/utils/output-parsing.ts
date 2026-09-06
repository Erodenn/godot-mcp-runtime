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

export interface StderrDiagnostic {
  message: string;
  line?: number;
  filePath?: string;
}

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
 * This is the single shared parser for that format (Phase 1 + Phase 7 of the
 * diagnostics roadmap). Behavior:
 *
 * - Recognizes `SCRIPT ERROR:` / `USER SCRIPT ERROR:` prefixes (the same
 *   marker set GodotRunner.SCRIPT_ERROR_PATTERNS gates on) plus bare
 *   `Parse Error: ... at line N` lines.
 * - Extracts the file + line from the `at:` line that follows, tolerating
 *   the `<method> (path:line)` and bare `path:line` forms. `gdscript://`
 *   URIs (runtime-compiled sources with no res:// identity) yield no
 *   filePath — the line number still applies to the submitted source.
 * - Suppresses the redundant follow-on `ERROR: Failed to load script
 *   "res://..." with error "..."` echo: it restates a SCRIPT ERROR already
 *   captured, and its own `at:` line points into Godot's engine source
 *   (e.g. gdscript_resource_format.cpp:46), which would surface as a bogus
 *   line number for the user's script.
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

      // "Failed to load script" echoes are suppressed only for the rest of
      // this block — the primary SCRIPT ERROR above them is the diagnostic.
      const next = lines[i + 1];
      if (next !== undefined) {
        // "<method> (res://path:line)" and bare "res://path:line"
        const atMatch = next.match(
          /\s*at:\s*(?:[^()\n]*\()?\(?((?:res:|gdscript:|file:)?\/\/[^):"\s]+|[a-z]:[^):"\s]+):(\d+)\)?/,
        );
        if (atMatch) {
          const [, path = '', lineStr = '0'] = atMatch;
          filePath = path.startsWith('res://') ? path : undefined;
          lineNum = parseInt(lineStr, 10);
          i++;
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
    }

    // Suppressed: "ERROR: Failed to load script ..." echoes (restating an
    // already-captured SCRIPT ERROR, with an engine-source at: line that
    // would masquerade as a line number in the user's script).
  }

  return entries;
}
