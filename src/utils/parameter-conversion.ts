import type { OperationParams } from '../mcp.types.js';

// Parameter mappings between snake_case and camelCase
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
} as const satisfies Record<string, string>;

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

export function normalizeParameters(params: OperationParams): OperationParams {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      let normalizedKey = key;

      if (key.includes('_') && parameterMappings[key as keyof ForwardMap]) {
        normalizedKey = parameterMappings[key as keyof ForwardMap];
      }

      const value = params[key];
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[normalizedKey] = normalizeParameters(value as OperationParams);
      } else {
        result[normalizedKey] = value;
      }
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
      const mapped = reverseParameterMappings[key as keyof ReverseParameterMappings];
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
      result[snakeKey] = convertCamelToSnakeValue(params[key]) as OperationParams[string];
    }
  }

  return result;
}
