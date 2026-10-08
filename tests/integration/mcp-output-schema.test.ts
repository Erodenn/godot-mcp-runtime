// The MCP spec requires tools declaring `outputSchema` to return matching `structuredContent`; strict clients reject responses that omit it.
// Wires the real `Server` to a real `Client` over an in-memory transport and calls filesystem-only tools through the dispatch table.
import { describe, it, expect } from 'vitest';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { dispatchToolCall } from '../../src/dispatch.js';
import { runtimeToolDefinitions } from '../../src/tools/runtime-tools.js';
import { autoloadToolDefinitions } from '../../src/tools/autoload-tools.js';
import { projectToolDefinitions } from '../../src/tools/project-tools.js';
import { sceneToolDefinitions } from '../../src/tools/scene-tools.js';
import { nodeToolDefinitions } from '../../src/tools/node-tools.js';
import { validateToolDefinitions } from '../../src/tools/validate-tools.js';

import { GodotRunner } from '../../src/utils/godot-runner.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';

const allToolDefinitions = [
  ...runtimeToolDefinitions,
  ...autoloadToolDefinitions,
  ...projectToolDefinitions,
  ...sceneToolDefinitions,
  ...nodeToolDefinitions,
  ...validateToolDefinitions,
];

async function makeLinkedPair() {
  const runner = new GodotRunner();
  const server = new Server(
    { name: 'godot-mcp-test', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allToolDefinitions,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await dispatchToolCall(runner, request.params.name, request.params.arguments || {});
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // The client's strict outputSchema check runs only for tools whose schemas it has seen, so listTools() must precede callTool().
  await client.listTools();

  return { client, server };
}

describe('MCP outputSchema contract (issue #18)', () => {
  it('search_project: returns structuredContent matching outputSchema', async () => {
    const { client, server } = await makeLinkedPair();

    try {
      const result = (await client.callTool({
        name: 'search_project',
        arguments: {
          projectPath: fixtureProjectPath,
          // Guaranteed to match content in main.tscn (default fileTypes excludes the .godot extension).
          pattern: 'Sprite2D',
        },
      })) as { structuredContent?: { matches?: unknown[]; truncated?: boolean } };

      expect(result.structuredContent).toBeDefined();
      expect(Array.isArray(result.structuredContent?.matches)).toBe(true);
      expect(typeof result.structuredContent?.truncated).toBe('boolean');
      expect(result.structuredContent!.matches!.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('get_scene_dependencies: returns structuredContent matching outputSchema', async () => {
    const { client, server } = await makeLinkedPair();

    try {
      const result = (await client.callTool({
        name: 'get_scene_dependencies',
        arguments: {
          projectPath: fixtureProjectPath,
          scenePath: 'main.tscn',
        },
      })) as { structuredContent?: { scenePath?: string; dependencies?: unknown[] } };

      expect(result.structuredContent).toBeDefined();
      expect(typeof result.structuredContent?.scenePath).toBe('string');
      expect(Array.isArray(result.structuredContent?.dependencies)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('list_projects: returns an object with a projects array, never a bare array', async () => {
    const { client, server } = await makeLinkedPair();

    try {
      const result = (await client.callTool({
        name: 'list_projects',
        arguments: { directory: fixtureProjectPath },
      })) as { structuredContent?: { projects?: Array<{ projectPath?: unknown }> } };

      expect(result.structuredContent).toBeDefined();
      expect(Array.isArray(result.structuredContent?.projects)).toBe(true);
      expect(typeof result.structuredContent?.projects?.[0]?.projectPath).toBe('string');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('list_autoloads: returns structuredContent with an autoloads array', async () => {
    const { client, server } = await makeLinkedPair();

    try {
      const result = (await client.callTool({
        name: 'list_autoloads',
        arguments: { projectPath: fixtureProjectPath },
      })) as { structuredContent?: { autoloads?: unknown[] } };

      expect(result.structuredContent).toBeDefined();
      expect(Array.isArray(result.structuredContent?.autoloads)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
