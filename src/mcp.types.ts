import type { GodotRunner } from './utils/godot-runner.js';
import type { autoloadToolDefinitions } from './tools/autoload-tools.js';
import type { nodeToolDefinitions } from './tools/node-tools.js';
import type { projectToolDefinitions } from './tools/project-tools.js';
import type { runtimeToolDefinitions } from './tools/runtime-tools.js';
import type { sceneToolDefinitions } from './tools/scene-tools.js';
import type { validateToolDefinitions } from './tools/validate-tools.js';

export interface OperationParams {
  [key: string]: unknown;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: string;
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required: readonly string[];
  };
  readonly outputSchema?: {
    readonly type: string;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
  readonly annotations?: ToolAnnotations;
}

export interface ToolResponse {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

export type ToolHandler = (
  runner: GodotRunner,
  args: OperationParams,
) => Promise<ToolResponse> | ToolResponse;

export type ToolName = (
  | typeof autoloadToolDefinitions
  | typeof nodeToolDefinitions
  | typeof projectToolDefinitions
  | typeof runtimeToolDefinitions
  | typeof sceneToolDefinitions
  | typeof validateToolDefinitions
)[number]['name'];
