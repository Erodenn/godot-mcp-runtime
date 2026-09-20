/**
 * Relationship tests for the bridge readiness budgets. The behavior these
 * constants govern (how long a cold Godot start is given before a genuine
 * failure is reported) is unobservable without a real cold launch, so these
 * assert the invariants a future edit would break rather than simulate a
 * timeline with fake timers.
 */

import { describe, it, expect } from 'vitest';
import { BRIDGE_WAIT_SPAWNED_TIMEOUT_MS } from '../../src/utils/bridge-protocol.js';
import {
  GodotRunner,
  BRIDGE_WAIT_ATTACHED_TIMEOUT_MS,
  BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS,
  BRIDGE_WAIT_BACKOFF_AFTER_MS,
  BRIDGE_WAIT_MAX_INTERVAL_MS,
  BRIDGE_WAIT_ATTACHED_INTERVAL_MS,
} from '../../src/utils/godot-runner.js';

describe('bridge readiness budget', () => {
  it('reports the spawned bridge timeout in seconds from the shared constant', () => {
    expect(BRIDGE_WAIT_SPAWNED_TIMEOUT_MS).toBeGreaterThanOrEqual(20000);
    expect(BRIDGE_WAIT_SPAWNED_TIMEOUT_MS % 1000).toBe(0);
  });

  it('gives a connected-but-silent bridge a longer ceiling than an absent one', () => {
    expect(BRIDGE_WAIT_ATTACHED_CONNECTED_TIMEOUT_MS).toBeGreaterThan(
      BRIDGE_WAIT_ATTACHED_TIMEOUT_MS,
    );
  });

  it('backs off the poll interval below the longest attached ceiling', () => {
    expect(BRIDGE_WAIT_BACKOFF_AFTER_MS).toBeLessThan(BRIDGE_WAIT_ATTACHED_TIMEOUT_MS);
    expect(BRIDGE_WAIT_MAX_INTERVAL_MS).toBeGreaterThan(BRIDGE_WAIT_ATTACHED_INTERVAL_MS);
  });

  it('returns a timeout error without an active spawned process instead of waiting', async () => {
    const runner = new GodotRunner();
    const started = Date.now();
    const result = await runner.waitForBridge();
    expect(result).toEqual({
      ready: false,
      error: 'No active spawned Godot process to verify',
    });
    expect(Date.now() - started).toBeLessThan(100);
  });
});
