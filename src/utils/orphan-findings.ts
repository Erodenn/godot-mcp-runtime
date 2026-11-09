import { readFileSync } from 'fs';
import { classifyHandlerUseAcrossDetailed, type ScriptSource } from './handler-references.js';
import { resolveProjectPath } from './path-validation.js';
import { extractSceneScripts } from './scene-parsing.js';

export interface SignalFinding {
  check?: string;
  message: string;
  [key: string]: unknown;
}

// KEEP IN SYNC: ORPHANED_HANDLER_PROBLEM in src/scripts/godot_operations.gd
export const ORPHANED_HANDLER_PROBLEM = 'orphaned_handler';
export const WARNING_SEVERITY = 'warning';
export const MAY_BE_CONNECTED_MESSAGE =
  'orphaned_handler: may be connected in code (a Callable built from a method name the check cannot resolve could reach this handler)';

const SCENE_EXTENSION = '.tscn';

function readProjectFile(projectPath: string, userPath: string): string | null {
  const resolved = resolveProjectPath(projectPath, userPath, 'read');
  if (!resolved) return null;
  try {
    return readFileSync(resolved.absPath, 'utf8');
  } catch {
    return null;
  }
}

/** The `.gd` scripts the scene's own text references, as res:// paths; none from a binary scene or an instanced scene's resources. */
function sceneScriptPaths(projectPath: string, scenePath: string): string[] {
  if (!scenePath.toLowerCase().endsWith(SCENE_EXTENSION)) return [];
  const scene = resolveProjectPath(projectPath, scenePath, 'read');
  if (!scene) return [];
  const paths: string[] = [];
  for (const abs of extractSceneScripts(scene.absPath, projectPath)) {
    const script = resolveProjectPath(projectPath, abs, 'read');
    if (script) paths.push(script.resPath);
  }
  return paths;
}

/** Re-judges each `orphaned_handler` finding against the tokens of the node's script and the scripts the scene references: a code connection or Callable drops it, a reachable dynamic Callable lowers it to a warning, anything else stays; the internal `script` field never leaves. */
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
    const scripts: ScriptSource[] = [];
    for (const path of scriptPaths) {
      const source = sourceOf(path);
      if (source !== null) scripts.push({ path, source });
    }
    const { use, site } = classifyHandlerUseAcrossDetailed(scripts, finding.method);
    if (use === 'connected' || use === 'referenced') continue;
    if (use === 'maybe') {
      const message = site
        ? `${MAY_BE_CONNECTED_MESSAGE} at ${site.path ?? 'a script'} line ${site.line}`
        : MAY_BE_CONNECTED_MESSAGE;
      refined.push({ ...rest, severity: WARNING_SEVERITY, message });
    } else {
      refined.push(rest);
    }
  }
  return refined;
}

export function isWarningFinding(finding: SignalFinding): boolean {
  return finding.severity === WARNING_SEVERITY;
}
