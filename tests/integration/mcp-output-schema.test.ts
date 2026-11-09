// The MCP spec requires tools declaring `outputSchema` to return matching `structuredContent`; strict clients reject responses that omit it.
// Wires the real `Server` to a real `Client` over an in-memory transport and calls filesystem-only tools through the dispatch table.
import { describe, it, expect } from 'vitest';
import { cpSync } from 'fs';
import { join } from 'path';

import { Server, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { dispatchToolCall } from '../../src/dispatch.js';
import { allToolDefinitions } from '../../src/server.js';

import { GodotRunner } from '../../src/utils/godot-runner.js';
import { authoredFixtureProjectPath, fixtureProjectPath } from '../helpers/fixture-paths.js';
import { itGodot } from '../helpers/godot-skip.js';
import { dropProjectFeatureVersion, useTmpDirs } from '../helpers/tmp.js';

const RESOURCE_CASE_TIMEOUT_MS = 120_000;

const tmp = useTmpDirs();

async function makeLinkedPair() {
  const runner = new GodotRunner();
  const server = new Server(
    { name: 'godot-mcp-test', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: allToolDefinitions as unknown as ListToolsResult['tools'],
  }));
  server.setRequestHandler('tools/call', async (request) => {
    return (await dispatchToolCall(
      runner,
      request.params.name,
      request.params.arguments || {},
    )) as CallToolResult;
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

  it('set_project_setting: returns structuredContent matching outputSchema', async () => {
    const project = tmp.makeProject('godot-mcp-schema-setting-');
    const { client, server } = await makeLinkedPair();

    try {
      const result = (await client.callTool({
        name: 'set_project_setting',
        arguments: { projectPath: project, section: 'display', key: 'window/size/width', value: 8 },
      })) as { structuredContent?: { value?: unknown; created?: boolean }; isError?: boolean };

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent?.value).toBe(8);
      expect(result.structuredContent?.created).toBe(true);
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

  itGodot(
    'create_resource and set_resource_properties: return structuredContent matching outputSchema',
    async () => {
      const project = join(tmp.make('godot-mcp-schema-resource-'), 'project');
      cpSync(authoredFixtureProjectPath, project, { recursive: true });
      dropProjectFeatureVersion(project);
      const { client, server } = await makeLinkedPair();

      try {
        const created = (await client.callTool({
          name: 'create_resource',
          arguments: { projectPath: project, resourcePath: 'blank.tres', type: 'Resource' },
        })) as { structuredContent?: unknown; isError?: boolean };
        expect(created.isError).not.toBe(true);
        expect(created.structuredContent).toBeDefined();

        const edited = (await client.callTool({
          name: 'set_resource_properties',
          arguments: {
            projectPath: project,
            resourcePath: 'blank.tres',
            properties: { resource_name: 'n' },
          },
        })) as { structuredContent?: unknown; isError?: boolean };
        expect(edited.isError).not.toBe(true);
        expect(edited.structuredContent).toBeDefined();
      } finally {
        await client.close();
        await server.close();
      }
    },
    RESOURCE_CASE_TIMEOUT_MS,
  );

  itGodot(
    'move_nodes: returns structuredContent matching outputSchema',
    async () => {
      const project = join(tmp.make('godot-mcp-schema-move-'), 'project');
      cpSync(authoredFixtureProjectPath, project, { recursive: true });
      dropProjectFeatureVersion(project);
      const { client, server } = await makeLinkedPair();

      try {
        const moved = (await client.callTool({
          name: 'move_nodes',
          arguments: {
            projectPath: project,
            scenePath: 'host.tscn',
            moves: [{ nodePath: 'root/Unit', index: 0 }],
          },
        })) as { structuredContent?: unknown; isError?: boolean };
        expect(moved.isError).not.toBe(true);
        expect(moved.structuredContent).toBeDefined();
      } finally {
        await client.close();
        await server.close();
      }
    },
    RESOURCE_CASE_TIMEOUT_MS,
  );
});
