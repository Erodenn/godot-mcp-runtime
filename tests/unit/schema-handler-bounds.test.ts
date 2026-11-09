import { describe, it, expect } from 'vitest';
import {
  findInputCapViolation,
  handleGetDebugOutput,
  parseBridgePortArg,
  parseTimeoutMsArg,
  runtimeToolDefinitions,
} from '../../src/tools/runtime-tools.js';
import { handleSearchProject, projectToolDefinitions } from '../../src/tools/project-tools.js';
import { parseRenderOptions, renderToolDefinitions } from '../../src/tools/render-tools.js';
import { autoloadToolDefinitions } from '../../src/tools/autoload-tools.js';
import { sceneToolDefinitions } from '../../src/tools/scene-tools.js';
import { nodeToolDefinitions } from '../../src/tools/node-tools.js';
import { profilerToolDefinitions } from '../../src/tools/profiler-tools.js';
import { validateToolDefinitions } from '../../src/tools/validate-tools.js';
import type { ToolDefinition } from '../../src/mcp.types.js';
import { createFakeRunner } from '../helpers/fake-runner.js';
import { unwrap } from '../helpers/assertions.js';
import { collectBoundedInputs, probesFor } from '../helpers/schema-bounds.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

// The profiler tools are probed in handlers/profiler-handlers.test.ts, which owns the fake profiler they need.
const handlerProbedElsewhere = new Set(profilerToolDefinitions.map((t) => t.name));

const allDefinitions: ToolDefinition[] = [
  ...runtimeToolDefinitions,
  ...renderToolDefinitions,
  ...autoloadToolDefinitions,
  ...projectToolDefinitions,
  ...sceneToolDefinitions,
  ...nodeToolDefinitions,
  ...profilerToolDefinitions,
  ...validateToolDefinitions,
];

const tmp = useTmpDirs();

/** No scene argument is given, so the project root is never read. */
const RENDER_ROOT = '';

/** Whether the handler lets a value through: true accepted, false refused. */
type Probe = (value: number) => boolean | Promise<boolean>;

function refusalMentions(result: unknown, text: string): boolean {
  return unwrap(result)
    .content.map((entry) => entry.text ?? '')
    .join(' ')
    .includes(text);
}

const timeoutProbe: Probe = (ms) => parseTimeoutMsArg({ timeout: ms }, 'timeout', 1).ok;

const inputActionProbe =
  (action: (value: number) => Record<string, unknown>): Probe =>
  (value) =>
    findInputCapViolation([action(value)], []) === null;

const PROBES: Record<string, Probe> = {
  'get_debug_output.limit': (limit) =>
    !refusalMentions(handleGetDebugOutput(createFakeRunner().asRunner, { limit }), 'limit must'),
  'take_screenshot.timeout': timeoutProbe,
  'run_script.timeout': timeoutProbe,
  'run_project.bridgePort': (bridgePort) => parseBridgePortArg({ bridgePort }).ok,
  'search_project.maxResults': async (maxResults) => {
    const dir = tmp.makeProject('schema-bounds-');
    writeFileSync(join(dir, 'a.gd'), 'needle\n', 'utf8');
    const result = await handleSearchProject({ projectPath: dir, pattern: 'needle', maxResults });
    return !refusalMentions(result, 'maxResults must');
  },
  'simulate_input.actions[].hold_ms': inputActionProbe((hold_ms) => ({
    type: 'key',
    key: 'W',
    hold_ms,
  })),
  'render_movie.frames': (frames) => parseRenderOptions({ frames }, RENDER_ROOT).ok,
  'render_movie.fps': (fps) => parseRenderOptions({ fps }, RENDER_ROOT).ok,
  'render_movie.inlineFrames': (inlineFrames) =>
    parseRenderOptions({ inlineFrames }, RENDER_ROOT).ok,
  'simulate_input.actions[].ms': inputActionProbe((ms) => ({ type: 'wait', ms })),
  'simulate_input.actions[].frames': inputActionProbe((frames) => ({ type: 'wait', frames })),
};

const bounded = collectBoundedInputs(allDefinitions).filter(
  (b) => !handlerProbedElsewhere.has(b.tool),
);

describe('input schema bounds against the handlers', () => {
  // Red when a numeric input gains a bound with no probe here, so a new bound cannot go unchecked.
  it('probes every bounded numeric input outside the profiler tools', () => {
    expect(bounded.map((b) => b.id).sort()).toEqual(Object.keys(PROBES).sort());
  });

  // Red when a schema bound drifts from what its handler accepts: a value just inside must pass and one just outside must be refused.
  it.each(bounded.map((b) => [b.id, b] as const))(
    '%s: handler range equals schema range',
    async (id, b) => {
      const probe = PROBES[id]!;
      const { inside, outside } = probesFor(b.schema);
      for (const value of inside)
        expect(await probe(value), `${id} = ${value} accepted`).toBe(true);
      for (const value of outside)
        expect(await probe(value), `${id} = ${value} refused`).toBe(false);
    },
  );

  // Red when an input declared `integer` accepts a fraction in its handler.
  it.each(bounded.filter((b) => b.schema.type === 'integer').map((b) => [b.id, b] as const))(
    '%s: an integer input refuses a fraction',
    async (id, b) => {
      const { fraction } = probesFor(b.schema);
      expect(fraction).not.toBeNull();
      expect(await PROBES[id]!(fraction!), `${id} = ${fraction} refused`).toBe(false);
    },
  );
});
