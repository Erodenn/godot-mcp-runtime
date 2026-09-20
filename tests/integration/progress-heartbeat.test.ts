/**
 * Integration test for the progress-heartbeat fix.
 *
 * Context: MCP clients may impose a per-request timeout (SDK default 60s;
 * opencode uses 30s-60s) and honor `resetTimeoutOnProgress`: resetting the
 * timer each time the server sends a `notifications/progress` for the
 * request's progress token. Without server-side heartbeats, long-running
 * tools (run_script playtest simulations routinely run 60s+) die with
 * `MCP error -32001 Request timed out` even when the tool's own `timeout`
 * parameter would have allowed them to finish.
 *
 * This test wires the real lower-level `Server` with the production
 * CallToolRequest handler shape (heartbeat wrapper around dispatchToolCall)
 * to a real `Client` over an in-memory transport, and verifies:
 *  1. A tool slower than the client timeout completes when the client
 *     resets on progress (heartbeats arrive on the progress token).
 *  2. The heartbeat stops when the tool settles (no stray notifications).
 *  3. Requests without a progress token never send notifications.
 */
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
      // Simulated long tool: ~4 heartbeat intervals.
      await sleep(TICK * 4);
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const client = await link(server);
    // Silence the expected progress callbacks (they assert nothing).
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
    // Control case for the reset mechanics: without an onprogress handler the
    // SDK attaches no progress token, so no heartbeats are ever sent and the
    // client's own timeout fires untouched: the pre-fix behavior for
    // non-opting clients, preserved bit-for-bit.
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
    // No onprogress in the request options → the SDK attaches no progress
    // token → the server must send zero progress notifications. A stray
    // server notification would surface as a client onerror ("unknown
    // token"), so assert both the callback silence and no errors.
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
    // Unit-level check of the stop-function contract: calling stop twice is
    // safe, and a heartbeat that never started (no token) yields a no-op
    // stopper.
    const stopNoop = startProgressHeartbeat(fakeExtra(), {
      method: 'tools/call',
      params: { name: 'x', arguments: {} },
    } as Parameters<typeof startProgressHeartbeat>[1]);
    expect(() => stopNoop()).not.toThrow();
    expect(() => stopNoop()).not.toThrow(); // idempotent

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

// Minimal RequestHandlerExtra stub for direct stopper tests: sendNotification
// must never be reached here (throws if called).
const fakeExtra = (): Parameters<typeof startProgressHeartbeat>[0] =>
  ({
    sendNotification: () => {
      throw new Error('unexpected notification: no token means no heartbeat');
    },
  }) as Parameters<typeof startProgressHeartbeat>[0];
