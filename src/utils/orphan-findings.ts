import { readFileSync } from 'fs';
import { classifyHandlerUseAcross } from './handler-references.js';
import { resolveProjectPath } from './path-validation.js';

export interface SignalFinding {
  check?: string;
  message: string;
  [key: string]: unknown;
}

export const ORPHANED_HANDLER_PROBLEM = 'orphaned_handler';
export const WARNING_SEVERITY = 'warning';
export const MAY_BE_CONNECTED_MESSAGE =
  'orphaned_handler: may be connected in code (a script in this scene builds a Callable the check cannot resolve)';

const SCENE_EXTENSION = '.tscn';
/** One `[ext_resource ...]` header per line in a text scene; attribute order varies, so type and path are read independently. */
const EXT_RESOURCE_LINE_RE = /^\[ext_resource\b[^\]]*\]/gm;
const SCRIPT_TYPE_RE = /\btype="Script"/;
const RES_PATH_RE = /\bpath="(res:\/\/[^"]+)"/;

function readProjectFile(projectPath: string, userPath: string): string | null {
  const resolved = resolveProjectPath(projectPath, userPath, 'read');
  if (!resolved) return null;
  try {
    return readFileSync(resolved.absPath, 'utf8');
  } catch {
    return null;
  }
}

/** The scripts a text scene attaches (or inherits through an instanced scene's own resources), as res:// paths. A binary scene yields none. */
function sceneScriptPaths(projectPath: string, scenePath: string): string[] {
  if (!scenePath.toLowerCase().endsWith(SCENE_EXTENSION)) return [];
  const text = readProjectFile(projectPath, scenePath);
  if (text === null) return [];
  const paths: string[] = [];
  for (const header of text.match(EXT_RESOURCE_LINE_RE) ?? []) {
    if (!SCRIPT_TYPE_RE.test(header)) continue;
    const path = RES_PATH_RE.exec(header)?.[1];
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * Re-judges each `orphaned_handler` finding against the scripts' tokens. The engine sees only scene-saved connections, so a handler wired in code looks orphaned.
 * Connected or referenced as a Callable in the node's script or any script the scene attaches: dropped. A Callable built from something unresolvable: kept, severity `warning`.
 * Every other finding passes through; the internal `script` field never leaves.
 */
export function refineOrphanFindings(
  findings: readonly SignalFinding[],
  projectPath: string,
  scenePath: string,
): SignalFinding[] {
  const sourceCache = new Map<string, string | null>();
  const sourceOf = (resPath: string): string | null => {
    if (!sourceCache.has(resPath)) sourceCache.set(resPath, readProjectFile(projectPath, resPath));
    return sourceCache.get(resPath) ?? null;
  };
  let sceneScripts: string[] | undefined;

  const refined: SignalFinding[] = [];
  for (const finding of findings) {
    const { script, ...rest } = finding;
    if (finding.problem !== ORPHANED_HANDLER_PROBLEM || typeof finding.method !== 'string') {
      refined.push(finding.problem === ORPHANED_HANDLER_PROBLEM ? rest : finding);
      continue;
    }
    sceneScripts ??= sceneScriptPaths(projectPath, scenePath);
    const scriptPaths = new Set(sceneScripts);
    if (typeof script === 'string' && script !== '') scriptPaths.add(script);
    const sources: string[] = [];
    for (const path of scriptPaths) {
      const source = sourceOf(path);
      if (source !== null) sources.push(source);
    }
    const use = classifyHandlerUseAcross(sources, finding.method);
    if (use === 'connected' || use === 'referenced') continue;
    if (use === 'maybe') {
      refined.push({ ...rest, severity: WARNING_SEVERITY, message: MAY_BE_CONNECTED_MESSAGE });
    } else {
      refined.push(rest);
    }
  }
  return refined;
}

export function isWarningFinding(finding: SignalFinding): boolean {
  return finding.severity === WARNING_SEVERITY;
}
