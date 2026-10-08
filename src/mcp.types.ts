import type { GodotRunner } from './utils/godot-runner.js';
import type { McpContext } from './utils/mcp-context.js';
import type { Result } from './utils/result.js';
import type { autoloadToolDefinitions } from './tools/autoload-tools.js';
import type { nodeToolDefinitions } from './tools/node-tools.js';
import type { profilerToolDefinitions } from './tools/profiler-tools.js';
import type { projectToolDefinitions } from './tools/project-tools.js';
import type { renderToolDefinitions } from './tools/render-tools.js';
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
  structuredContent?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Like `ToolResponse` without `isError`; `dispatchToolCall` is the only edge that re-projects it to the wire shape. */
export interface ToolSuccessPayload {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  [k: string]: unknown;
}

export type HandlerResult = Result<ToolSuccessPayload, ToolResponse>;

/** `ctx` is optional for handlers that do not need it; `dispatchToolCall` always supplies one. */
export type ToolHandler = (
  runner: GodotRunner,
  args: OperationParams,
  ctx?: McpContext,
) => Promise<HandlerResult> | HandlerResult;

export type ToolName = (
  | typeof autoloadToolDefinitions
  | typeof nodeToolDefinitions
  | typeof profilerToolDefinitions
  | typeof projectToolDefinitions
  | typeof renderToolDefinitions
  | typeof runtimeToolDefinitions
  | typeof sceneToolDefinitions
  | typeof validateToolDefinitions
)[number]['name'];
