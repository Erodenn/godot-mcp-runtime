import type { GodotRunner } from './godot-runner.js';
import type { HandlerResult, OperationParams } from '../mcp.types.js';
import { createErrorResponse, extractGdError, getErrorMessage } from './error-response.js';
import { createStructuredResponse } from './structured-response.js';
import { extractJson, parseScriptDiagnostics, type StderrDiagnostic } from './output-parsing.js';
import { ok, err } from './result.js';

/**
 * Godot engine exit-noise line shapes: RID-leak warnings, the version
 * banner, and debug/info status lines that print on quit(1) before a
 * payload is ever emitted. Mirrors the prefixes `cleanOutput` filters
 * elsewhere in this codebase.
 */
const STDOUT_NOISE_LINE_PATTERN =
  /^(ERROR|WARNING|SCRIPT ERROR|USER SCRIPT ERROR):|^Godot Engine v|^\[DEBUG\]|^\[INFO\]/;

/** Max stderr diagnostic entries surfaced in an early-exit error message. */
const MAX_STDERR_DIAGNOSTIC_LINES = 5;

/** Trailing stdout lines surfaced when an early-exit stdout tail is shown. */
const STDOUT_TAIL_LINES = 10;

/** Trailing stderr lines surfaced when parseScriptDiagnostics finds nothing. */
const STDERR_TAIL_LINES = 5;

/**
 * Heuristic: does this non-JSON stdout look like the operation quit(1) before
 * emitting its payload? Canonical shape: a script compile error makes the
 * headless operation exit early, so stdout contains ONLY engine exit noise —
 * RID-leak warnings are the usual content. Bracket presence alone can't
 * classify this: exit noise routinely contains a stray `[` or `{` (e.g. a
 * `[Resource file res://x:4]` location suffix), and a genuinely JSON-shaped
 * but broken payload can look just as bracket-free or bracket-heavy either
 * way. Classify by line shape instead: early quit unless some line is
 * positive evidence of a payload attempt — a JSON opener on a line that
 * isn't recognized engine noise.
 *
 * The asymmetry is deliberate. A whitelist ("every line is known noise")
 * would send any unrecognized line — a stray `print()` before the script
 * died, a message shape a future Godot adds — back to the invalid-JSON
 * blame this function exists to prevent. Requiring evidence for the
 * emission-bug verdict instead means unknown output degrades to the
 * early-exit message, which carries the raw stdout tail and stays
 * self-correcting.
 */
function stdoutLooksLikeEarlyQuitNoise(stdout: string): boolean {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const looksLikePayloadAttempt = (line: string): boolean =>
    !STDOUT_NOISE_LINE_PATTERN.test(line) && (line.includes('{') || line.includes('['));
  return !lines.some(looksLikePayloadAttempt);
}

/**
 * Render one parsed stderr diagnostic, preserving the file+line location
 * `parseScriptDiagnostics` recovers — that location is the single most
 * useful part of the diagnosis, and dropping it (as a bare message-only
 * filter would) sends the caller hunting for the failing line by hand.
 */
function renderStderrDiagnostic(d: StderrDiagnostic): string {
  const location = d.filePath
    ? `${d.filePath}${d.line !== undefined ? `:${d.line}` : ''}: `
    : d.line !== undefined
      ? `line ${d.line}: `
      : '';
  return `${location}${d.message}`;
}

/**
 * Build the stderr portion of an early-exit error message. Prefers parsed
 * script/compile diagnostics for their file+line location; falls back to a
 * raw stderr tail when nothing parses — an unparseable stderr is still
 * better than dropping it entirely.
 */
function renderStderrForEarlyExit(stderr: string): string | undefined {
  const diagnostics = parseScriptDiagnostics(stderr);
  if (diagnostics.length > 0) {
    const rendered = diagnostics
      .slice(0, MAX_STDERR_DIAGNOSTIC_LINES)
      .map(renderStderrDiagnostic)
      .join('\n');
    return `stderr: ${rendered}`;
  }
  if (stderr.trim()) {
    const stderrTail = stderr.trim().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
    return `stderr (last lines): ${stderrTail}`;
  }
  return undefined;
}

/**
 * Wraps the execute + empty-stdout-check + try/catch around a headless GDScript
 * operation. Used by the 15 scene/node mutation handlers in tools/scene-tools.ts
 * and tools/node-tools.ts to eliminate identical error-handling duplication.
 *
 * Handlers retain control of: parameter normalization, project/scene validation,
 * field validation, and constructing the `params` object — those run before the
 * call. Returns the canonical `Result<ToolSuccessPayload, ToolResponse>` shape;
 * the dispatch edge maps it back to the MCP wire envelope.
 */
export async function executeSceneOp(
  runner: GodotRunner,
  operation: string,
  params: OperationParams,
  projectPath: string,
  failurePrefix: string,
  emptyStdoutSolutions: string[],
  exceptionSolutions: string[] = ['Ensure Godot is installed correctly'],
  options: { parseStdoutAsJson?: boolean } = {},
): Promise<HandlerResult> {
  try {
    const { stdout, stderr } = await runner.executeOperation(operation, params, projectPath);
    if (!stdout.trim()) {
      return err(
        createErrorResponse(`${failurePrefix}: ${extractGdError(stderr)}`, emptyStdoutSolutions),
      );
    }
    if (options.parseStdoutAsJson) {
      // extractJson already strips leading/trailing engine noise around a
      // payload (GodotRunner.executeOperation normally routes stdout through
      // cleanStdout/extractJson before handlers ever see it — this call is
      // belt-and-braces for callers that bypass that, e.g. fake runners in
      // tests). No separate leading-noise stripper needed here.
      const jsonCandidate = extractJson(stdout.trim());
      try {
        const payload = JSON.parse(jsonCandidate) as Record<string, unknown>;
        return createStructuredResponse(payload);
      } catch (parseErr) {
        if (stdoutLooksLikeEarlyQuitNoise(stdout)) {
          // The operation exited before emitting its JSON payload (early
          // quit on error): stdout contains only engine exit noise. Surface
          // the offending output instead of blaming the operation script's
          // JSON emission. stderr carries the actual failure (compile
          // errors print to stderr in Godot's canonical format).
          const parts = [
            `${failurePrefix}: no JSON payload was emitted - the operation likely exited early on an error.`,
          ];
          const stderrPart = renderStderrForEarlyExit(stderr);
          if (stderrPart) parts.push(stderrPart);
          const stdoutTail = stdout.trim().split('\n').slice(-STDOUT_TAIL_LINES).join('\n');
          if (stdoutTail) parts.push(`stdout (last lines): ${stdoutTail}`);
          return err(
            createErrorResponse(parts.join('\n'), [
              'Check the surfaced stdout/stderr above - this is the operation failing before it could emit its JSON payload, not a JSON formatting bug',
              'Check get_debug_output for the raw output',
            ]),
          );
        }
        return err(
          createErrorResponse(
            `${failurePrefix}: GDScript returned invalid JSON (${getErrorMessage(parseErr)})`,
            [
              'This indicates a bug in godot_operations.gd — the operation should emit a JSON payload matching its outputSchema',
              'Check get_debug_output for the raw stdout and stderr',
            ],
          ),
        );
      }
    }
    return ok({ content: [{ type: 'text', text: stdout }] });
  } catch (error: unknown) {
    return err(
      createErrorResponse(`${failurePrefix}: ${getErrorMessage(error)}`, exceptionSolutions),
    );
  }
}
