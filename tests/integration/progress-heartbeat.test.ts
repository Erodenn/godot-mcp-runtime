// Clients may impose a per-request timeout and reset it on `notifications/progress`; without server heartbeats, long tools die with `MCP error -32001 Request timed out`.
// Wires the real `Server` and the production CallToolRequest handler shape to a real `Client` over an in-memory transport.
import { describe, it, expect, vi } from 'vitest';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { startProgressHeartbeat } from '../../src/utils/progress-heartbeat.js';
import type { ToolResponse } from '../../src/mcp.types.js';

const TICK = 25;

function makeServer(handler: (args: Record<string, unknown>) => Promise<unknown>) {
  const server = new Server(
    { name: 'heartbeat-test-server', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const stop = startProgressHeartbeat(extra, request, TICK);
    try {
      const result = await handler(request.params.arguments || {});
      return result as ToolResponse;
    } finally {
      stop();
    }
  });
  return server;
}

async function link(server: Server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'heartbeat-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('progress heartbeat keeps long tool calls alive (issue: -32001 on run_script >60s)', () => {
  it('completes a tool slower than the client timeout when the client resets on progress', async () => {
    const server = makeServer(async () => {
      await sleep(TICK * 4);
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const client = await link(server);
    const onprogress = vi.fn();

    try {
      const result = await client.callTool(
        { name: 'slow_tool', arguments: {} },
        CallToolResultSchema,
        {
          timeout: TICK * 2,
          resetTimeoutOnProgress: true,
          onprogress,
        },
      );
      expect(JSON.stringify(result)).toContain('done');
      expect(onprogress).toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('still times out when the client supplied no progress token (control case)', async () => {
    // Control case: without onprogress the SDK attaches no progress token, so no heartbeats are sent and the client's own timeout fires untouched.
    const server = makeServer(async () => {
      await sleep(TICK * 6);
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const client = await link(server);

    await expect(
      client.callTool({ name: 'slow_tool', arguments: {} }, CallToolResultSchema, {
        timeout: TICK * 2,
      }),
    ).rejects.toThrow(/timed out/i);

    await client.close();
    await server.close();
  });

  it('sends no progress notifications when the client supplied no progress token', async () => {
    const server = makeServer(async () => {
      await sleep(TICK * 4);
      return { content: [{ type: 'text', text: 'done' }] };
    });
    // Without onprogress no token exists, so the server must send zero notifications; a stray one surfaces as a client onerror ("unknown token").
    const client = await link(server);
    const onprogress = vi.fn();
    const onError = vi.fn();
    client.onerror = onError;
    try {
      await client.callTool({ name: 'slow_tool', arguments: {} }, CallToolResultSchema, {
        timeout: TICK * 10,
      });
      expect(onprogress).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('heartbeat stopper is idempotent and inert without a token', async () => {
    // Calling stop twice is safe, and a heartbeat that never started (no token) yields a no-op stopper.
    const stopNoop = startProgressHeartbeat(fakeExtra(), {
      method: 'tools/call',
      params: { name: 'x', arguments: {} },
    } as Parameters<typeof startProgressHeartbeat>[1]);
    expect(() => stopNoop()).not.toThrow();
    expect(() => stopNoop()).not.toThrow();

    const server = makeServer(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const client = await link(server);
    try {
      const result = await client.callTool(
        { name: 'fast_tool', arguments: {} },
        CallToolResultSchema,
        { timeout: 1000 },
      );
      expect(JSON.stringify(result)).toContain('ok');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

const fakeExtra = (): Parameters<typeof startProgressHeartbeat>[0] =>
  ({
    sendNotification: () => {
      throw new Error('unexpected notification: no token means no heartbeat');
    },
  }) as Parameters<typeof startProgressHeartbeat>[0];
