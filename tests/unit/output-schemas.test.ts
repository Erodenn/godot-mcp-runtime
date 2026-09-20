import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { allToolDefinitions } from '../../src/index.js';
import type { ToolDefinition } from '../../src/mcp.types.js';
import { handleCheckProject } from '../../src/tools/project-tools.js';
import { createRuntimeFake } from '../helpers/runtime-fakes.js';
import { unwrap } from '../helpers/assertions.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';

const ajv = new Ajv({ strict: false });

const toolsWithOutputSchema: Array<[string, ToolDefinition]> = allToolDefinitions
  .filter(
    (t): t is ToolDefinition & { outputSchema: NonNullable<ToolDefinition['outputSchema']> } =>
      Boolean(t.outputSchema),
  )
  .map((t) => [t.name, t] as [string, ToolDefinition]);

describe('outputSchema — every declared schema is valid', () => {
  it.each(toolsWithOutputSchema)('%s outputSchema compiles under ajv', (_name, tool) => {
    const compile = () => ajv.compile(tool.outputSchema as object);
    expect(compile).not.toThrow();
  });

  it.each(toolsWithOutputSchema)('%s outputSchema.type is "object"', (_name, tool) => {
    expect(tool.outputSchema!.type).toBe('object');
  });
});

describe('outputSchema and Returns: prose are complementary, not exclusive', () => {
  // Per docs/tool-authoring.md §3, when a tool has an outputSchema it must also
  // carry a Returns: sentence in its description — the schema is invisible to
  // the agent, so the prose is the only return-shape signal the LLM ever sees.
  it.each(toolsWithOutputSchema)(
    '%s description has a Returns: sentence alongside its outputSchema',
    (_name, tool) => {
      expect(tool.description).toMatch(/\bReturns:/);
    },
  );
});

describe('outputSchema — expected coverage', () => {
  // Exact allowlist so adding/removing a tool from the structuredContent
  // contract is a deliberate one-line edit, not a silent drift. Update this
  // list whenever a tool grows or loses an outputSchema.
  const TOOLS_WITH_OUTPUT_SCHEMA: readonly string[] = [
    'attach_script',
    'batch_scene_operations',
    'check_project',
    'create_scene',
    'delete_nodes',
    'detach_project',
    'duplicate_node',
    'get_debug_output',
    'get_node_signals',
    'get_scene_dependencies',
    'get_ui_elements',
    'profile_project',
    'run_script',
    'search_project',
    'start_profiler',
    'set_node_properties',
    'simulate_input',
    'stop_profiler',
    'stop_project',
    'take_screenshot',
  ];

  it('every tool with outputSchema is on the explicit allowlist', () => {
    expect(toolsWithOutputSchema.map(([name]) => name).sort()).toEqual(
      [...TOOLS_WITH_OUTPUT_SCHEMA].sort(),
    );
  });
});

describe('simulate_input — every declared entry shape validates', () => {
  // The per-action entry is the widest shape this server returns: keys differ by
  // action type, a skipped entry carries almost nothing, and a failed batch
  // still comes back success-shaped. Validate the payloads directly, since the
  // interesting variety lives in the bridge's output rather than the handler's.
  const simulateInputDef = toolsWithOutputSchema.find(([name]) => name === 'simulate_input')?.[1];
  if (!simulateInputDef) throw new Error('simulate_input outputSchema not found');
  const validate = ajv.compile(simulateInputDef.outputSchema as object);

  function expectValid(payload: Record<string, unknown>): void {
    const valid = validate(payload);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  }

  it('validates a success: false payload carrying a failure and a skipped entry', () => {
    expectValid({
      success: false,
      results: [
        {
          index: 0,
          type: 'click_element',
          ok: true,
          frame: 1,
          elapsed_ms: 7,
          hit: '/root/HUD/SkillsBtn',
          signals: ['pressed'],
          changes: {
            appeared: ['/root/HUD/SkillTree'],
            focus: '/root/HUD/SkillTree/Close',
          },
          watch: { '/root/Main/Player:position': { x: 10, y: 4 } },
        },
        { index: 1, type: 'wait', ok: true, frame: 31, elapsed_ms: 510 },
        {
          index: 2,
          type: 'click_element',
          ok: false,
          frame: 32,
          elapsed_ms: 527,
          hit: '/root/HUD/Modal',
          error: 'occluded by /root/HUD/Modal',
        },
        { index: 3, type: 'key', skipped: true },
      ],
      still_held: ['key:W'],
    });
  });

  it.each([
    ['key', { index: 0, type: 'key', ok: true, frame: 1, elapsed_ms: 3, focus: '/root/HUD/Name' }],
    [
      'mouse_button',
      { index: 0, type: 'mouse_button', ok: true, frame: 1, elapsed_ms: 3, hit: '/root/HUD/Btn' },
    ],
    [
      'mouse_motion',
      {
        index: 0,
        type: 'mouse_motion',
        ok: true,
        frame: 1,
        elapsed_ms: 2,
        position: { x: 4, y: 9 },
      },
    ],
    ['action', { index: 0, type: 'action', ok: true, frame: 1, elapsed_ms: 2, pressed: false }],
    [
      'text',
      {
        index: 0,
        type: 'text',
        ok: true,
        frame: 1,
        elapsed_ms: 5,
        focus: '/root/HUD/Name',
        value: 'hello',
      },
    ],
    [
      'errors plus a truncated delta',
      {
        index: 0,
        type: 'click_element',
        ok: true,
        frame: 1,
        elapsed_ms: 4,
        errors: ['SCRIPT ERROR: in _on_pressed'],
        changes: {
          changed: [{ path: '/root/HUD/Score', text: 'Score: 2' }],
          disappeared: ['/root/HUD/Splash'],
          scene: '/root/Level2',
          truncated: 3,
        },
      },
    ],
    [
      'watch sampling as null',
      { index: 0, type: 'key', ok: true, watch: { '/root/Gone:x': null } },
    ],
  ])('validates a %s entry', (_label, entry) => {
    expectValid({ success: true, results: [entry] });
  });
});

describe('check_project — every declared response shape validates and carries structuredContent', () => {
  const checkProjectDef = toolsWithOutputSchema.find(([name]) => name === 'check_project')?.[1];
  if (!checkProjectDef) throw new Error('check_project outputSchema not found');
  const validate = ajv.compile(checkProjectDef.outputSchema as object);

  async function checkAndValidate(
    fake: ReturnType<typeof createRuntimeFake>,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await handleCheckProject(fake.asRunner, args);
    const envelope = unwrap(result);
    expect(envelope.structuredContent).toBeDefined();
    const payload = envelope.structuredContent as Record<string, unknown>;
    const valid = validate(payload);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
    return payload;
  }

  it('validates { godotVersion, runtime: { activeSession: false } } with no projectPath and no session', async () => {
    const fake = createRuntimeFake();
    const payload = await checkAndValidate(fake, {});
    expect(payload.runtime).toEqual({ activeSession: false });
  });

  it('validates the projectPath-present shape (name/path/structure/godotVersion/runtime)', async () => {
    const fake = createRuntimeFake();
    const payload = await checkAndValidate(fake, { projectPath: fixtureProjectPath });
    expect(payload).toHaveProperty('name');
    expect(payload).toHaveProperty('path', fixtureProjectPath);
    expect(payload).toHaveProperty('structure');
    expect(payload.runtime).toEqual({ activeSession: false });
  });

  it('validates the active-session, bridge-responsive runtime shape', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setBridgeResponse({ status: 'pong' });
    const payload = await checkAndValidate(fake, {});
    expect(payload.runtime).toMatchObject({
      activeSession: true,
      sessionMode: 'spawned',
      bridgeResponsive: true,
    });
  });

  it('validates the exited-process runtime shape (activeSession:false, processExited:true, diagnostics)', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: true });
    const payload = await checkAndValidate(fake, {});
    expect(payload.runtime).toMatchObject({ activeSession: false, processExited: true });
  });
});
