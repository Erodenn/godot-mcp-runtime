import type { GodotRunner } from './utils/godot-runner.js';
import type { Result } from './utils/result.js';
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

/**
 * Success payload returned by a handler's ok-branch. Carries the same `content`
 * shape as the wire-level `ToolResponse` but without the `isError` flag — the
 * Result discriminator makes that flag redundant. `dispatchToolCall` is the
 * sole edge that re-projects this into the wire shape the MCP client expects.
 */
export interface ToolSuccessPayload {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export type HandlerResult = Result<ToolSuccessPayload, ToolResponse>;

export type ToolHandler = (
  runner: GodotRunner,
  args: OperationParams,
) => Promise<HandlerResult> | HandlerResult;

export type ToolName = (
  | typeof autoloadToolDefinitions
  | typeof nodeToolDefinitions
  | typeof projectToolDefinitions
  | typeof runtimeToolDefinitions
  | typeof sceneToolDefinitions
  | typeof validateToolDefinitions
)[number]['name'];
