import { describe, it, expect, vi } from 'vitest';

const stdioTransportCtor = vi.hoisted(() => vi.fn());
vi.mock('@modelcontextprotocol/server/stdio', () => ({ StdioServerTransport: stdioTransportCtor }));

describe('importing the server module', () => {
  // Red when the module constructs a GodotMcpServer or calls run() at import again.
  it('starts nothing: no transport is built and the tool list is available', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mod = await import('../../src/server.js');
    expect(mod.allToolDefinitions.length).toBeGreaterThan(0);
    expect(typeof mod.GodotMcpServer).toBe('function');
    expect(stdioTransportCtor).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
