import type { OperationParams } from '../mcp.types.js';

// Parameter mappings between snake_case and camelCase. Covers schema keys
// only — keys under OPAQUE_VALUE_KEYS never reach this table.
// Add new entries whenever a tool surfaces a new compound parameter — the
// strict converter throws in test env on unmapped keys to catch oversights.
const parameterMappings = {
  project_path: 'projectPath',
  scene_path: 'scenePath',
  root_node_type: 'rootNodeType',
  parent_node_path: 'parentNodePath',
  parent_path: 'parentPath',
  node_type: 'nodeType',
  node_name: 'nodeName',
  texture_path: 'texturePath',
  node_path: 'nodePath',
  node_paths: 'nodePaths',
  target_node_path: 'targetNodePath',
  target_parent_path: 'targetParentPath',
  new_name: 'newName',
  output_path: 'outputPath',
  mesh_item_names: 'meshItemNames',
  new_path: 'newPath',
  file_path: 'filePath',
  script_path: 'scriptPath',
  response_mode: 'responseMode',
  preview_max_width: 'previewMaxWidth',
  preview_max_height: 'previewMaxHeight',
  bridge_port: 'bridgePort',
  abort_on_error: 'abortOnError',
  max_depth: 'maxDepth',
  changed_only: 'changedOnly',
  case_sensitive: 'caseSensitive',
  file_types: 'fileTypes',
  max_results: 'maxResults',
  capture_limit: 'captureLimit',
  inline_frames: 'inlineFrames',
  autoload_name: 'autoloadName',
  autoload_path: 'autoloadPath',
  visible_only: 'visibleOnly',
  timeline_ms: 'timelineMs',
  target_fps: 'targetFps',
  has_property: 'hasProperty', // nested in validate checks[].schema; flows through strict converter
} as const satisfies Record<string, string>;

/**
 * Keys whose VALUES are user-authored data, never schema. Both converters copy
 * the value through untouched instead of recursing: a script-exported variable,
 * a `metadata/<key>`, or a shader uniform (`shader_parameter/glowAmount`) is an
 * identifier the user chose, and rewriting its case corrupts it. The keys
 * themselves are still converted like any other key.
 *
 * `properties` - add_node property dict (standalone and batch).
 * `value`      - set_node_properties update value (standalone and batch).
 *
 * Neither name is ever a structural key in the params a handler builds, so the
 * match is safe position-independently. Adding a name here is a contract change:
 * everything under it stops being case-converted in both directions.
 */
export const OPAQUE_VALUE_KEYS: ReadonlySet<string> = new Set(['properties', 'value']);

type ForwardMap = typeof parameterMappings;
type ReverseParameterMappings = { [K in keyof ForwardMap as ForwardMap[K]]: K & string };

// Reverse mapping from camelCase to snake_case
const reverseParameterMappings = ((): ReverseParameterMappings => {
  const result: Record<string, string> = {};
  for (const [snakeCase, camelCase] of Object.entries(parameterMappings)) {
    result[camelCase] = snakeCase;
  }
  return result as ReverseParameterMappings;
})();

/**
 * The value a mapping table holds for `key`, or undefined. The key comes from
 * the caller, so only an own entry counts: a plain object also answers
 * `constructor`, `toString` and `__proto__` from its prototype.
 */
function ownMapping(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Set `key` on `target` as an own property. A plain assignment of the key
 * `__proto__` replaces the object's prototype instead, which would let a
 * caller supply inherited values for keys the handler reads.
 */
function setOwn(target: OperationParams, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function normalizeParameters(params: OperationParams): OperationParams {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const normalizedKey = ownMapping(parameterMappings, key) ?? key;

      const value = params[key];
      const nested =
        !OPAQUE_VALUE_KEYS.has(key) &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value);
      setOwn(result, normalizedKey, nested ? normalizeParameters(value as OperationParams) : value);
    }
  }

  return result;
}

function convertCamelToSnakeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => convertCamelToSnakeValue(entry));
  }
  if (typeof value === 'object' && value !== null) {
    return convertCamelToSnakeCase(value as OperationParams);
  }
  return value;
}

export function convertCamelToSnakeCase(params: OperationParams): OperationParams {
  const result: OperationParams = {};
  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const mapped = ownMapping(reverseParameterMappings, key);
      let snakeKey: string;
      if (mapped) {
        snakeKey = mapped;
      } else if (/[A-Z]/.test(key)) {
        // Unmapped camelCase key — tolerated in production via regex fallback,
        // but in tests we throw to catch missing entries in parameterMappings.
        if (isTestEnv) {
          throw new Error(
            `convertCamelToSnakeCase: unmapped camelCase key '${key}'. ` +
              `Add it to parameterMappings in src/utils/parameter-conversion.ts so snake/camel conversion stays explicit.`,
          );
        }
        snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      } else {
        snakeKey = key;
      }
      setOwn(
        result,
        snakeKey,
        OPAQUE_VALUE_KEYS.has(key) ? params[key] : convertCamelToSnakeValue(params[key]),
      );
    }
  }

  return result;
}
