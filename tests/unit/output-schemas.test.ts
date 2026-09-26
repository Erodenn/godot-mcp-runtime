import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { resolve } from 'path';
import { allToolDefinitions } from '../../src/index.js';
import type { ToolDefinition } from '../../src/mcp.types.js';
import { handleCheckProject } from '../../src/tools/project-tools.js';
import { createRuntimeFake } from '../helpers/runtime-fakes.js';
import { liveSessionInfo } from '../helpers/fake-sessions.js';
import { unwrap } from '../helpers/assertions.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';

const ajv = new Ajv({ strict: false });

const toolsWithOutputSchema: Array<[string, ToolDefinition]> = allToolDefinitions
  .filter(
    (t): t is ToolDefinition & { outputSchema: NonNullable<ToolDefinition['outputSchema']> } =>
      Boolean(t.outputSchema),
  )
  .map((t) => [t.name, t] as [string, ToolDefinition]);

describe('outputSchema: every declared schema is valid', () => {
  it.each(toolsWithOutputSchema)('%s outputSchema compiles under ajv', (_name, tool) => {
    const compile = () => ajv.compile(tool.outputSchema as object);
    expect(compile).not.toThrow();
  });

  it.each(toolsWithOutputSchema)('%s outputSchema.type is "object"', (_name, tool) => {
    expect(tool.outputSchema!.type).toBe('object');
  });
});

describe('outputSchema: fields a tool always returns are declared required', () => {
  // A schema with no required list validates {} and every older payload, so a
  // client reading it learns nothing is guaranteed. Each tool here returns the
  // listed fields on every success branch.
  const ALWAYS_RETURNED: Array<[string, string[]]> = [
    ['simulate_input', ['projectPath', 'success', 'results']],
    ['get_ui_elements', ['projectPath', 'elements', 'tip']],
    ['run_script', ['projectPath', 'success', 'result', 'tip']],
    [
      'start_profiler',
      [
        'projectPath',
        'active',
        'maxSeconds',
        'firstFrame',
        'captureLimit',
        'visual',
        'timeline',
        'timelineMs',
      ],
    ],
    [
      'profile_project',
      [
        'projectPath',
        'complete',
        'frames',
        'frame',
        'servers',
        'rows',
        'fps',
        'targetFps',
        'slowFrames',
        'monitors',
        'visual',
        'timeline',
      ],
    ],
    [
      'stop_profiler',
      [
        'projectPath',
        'complete',
        'frames',
        'frame',
        'servers',
        'rows',
        'fps',
        'targetFps',
        'slowFrames',
        'monitors',
        'visual',
        'timeline',
      ],
    ],
    ['search_project', ['matches', 'truncated', 'filesSearched', 'fileTypes']],
    ['create_scene', ['success', 'scenePath']],
    ['attach_script', ['success', 'nodePath', 'scriptPath']],
    ['delete_nodes', ['results']],
    ['set_node_properties', ['results']],
    ['get_node_signals', ['nodePath', 'nodeType', 'signals']],
  ];

  it.each(ALWAYS_RETURNED)('%s requires them and rejects an empty payload', (name, fields) => {
    const tool = toolsWithOutputSchema.find(([toolName]) => toolName === name)?.[1];
    if (!tool) throw new Error(`${name} outputSchema not found`);
    const schema = tool.outputSchema as { required?: string[] };
    expect(schema.required ?? []).toEqual(expect.arrayContaining(fields));
    expect(ajv.compile(tool.outputSchema as object)({})).toBe(false);
  });
});

describe('outputSchema and Returns: prose are complementary, not exclusive', () => {
  // Per docs/tool-authoring.md §3, when a tool has an outputSchema it must also
  // carry a Returns: sentence in its description: the schema is invisible to
  // the agent, so the prose is the only return-shape signal the LLM ever sees.
  it.each(toolsWithOutputSchema)(
    '%s description has a Returns: sentence alongside its outputSchema',
    (_name, tool) => {
      expect(tool.description).toMatch(/\bReturns:/);
    },
  );
});

describe('simulate_input: every declared entry shape validates', () => {
  // The per-action entry is the widest shape this server returns: keys differ by
  // action type, a skipped entry carries almost nothing, and a failed batch
  // still comes back success-shaped. Validate the payloads directly, since the
  // interesting variety lives in the bridge's output rather than the handler's.
  const simulateInputDef = toolsWithOutputSchema.find(([name]) => name === 'simulate_input')?.[1];
  if (!simulateInputDef) throw new Error('simulate_input outputSchema not found');
  const validate = ajv.compile(simulateInputDef.outputSchema as object);

  // The payloads below are written as the bridge sends them. The handler adds
  // the session's projectPath to every one, and the schema requires it.
  function expectValid(payload: Record<string, unknown>): void {
    const valid = validate({ projectPath: fixtureProjectPath, ...payload });
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  }

  it('rejects a payload that does not name its session', () => {
    expect(validate({ success: true, results: [] })).toBe(false);
  });

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

describe('check_project: every declared response shape validates and carries structuredContent', () => {
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
    expect(payload.runtime).toEqual({ activeSession: false, projectPath: null, liveSessions: [] });
  });

  it('validates the projectPath-present shape (name/projectPath/structure/godotVersion/runtime)', async () => {
    const fake = createRuntimeFake();
    const payload = await checkAndValidate(fake, { projectPath: fixtureProjectPath });
    expect(payload).toHaveProperty('name');
    expect(payload).toHaveProperty('projectPath', resolve(fixtureProjectPath));
    expect(payload).toHaveProperty('structure');
    expect(payload.runtime).toEqual({
      activeSession: false,
      projectPath: null,
      liveSessions: [],
      project: { projectPath: resolve(fixtureProjectPath), session: 'none', current: false },
    });
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

  it('validates the multi-session runtime shape', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setOtherSessions([liveSessionInfo(resolve(fixtureProjectPath), { bridgePort: 6100 })]);
    fake.setBridgeResponse({ status: 'pong' });
    const payload = await checkAndValidate(fake, { projectPath: fixtureProjectPath });
    expect(payload.runtime).toMatchObject({
      activeSession: true,
      projectPath: '/fake/project',
      project: { session: 'live', current: false, sessionMode: 'spawned' },
    });
    expect((payload.runtime as { liveSessions: unknown[] }).liveSessions).toHaveLength(2);
  });

  it('validates the exited-process runtime shape (activeSession:false, processExited:true, diagnostics)', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: true });
    const payload = await checkAndValidate(fake, {});
    expect(payload.runtime).toMatchObject({ activeSession: false, processExited: true });
  });

  it('validates the retained-process runtime shape after a self-exit (no sessionMode)', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: null, projectPath: null, hasExited: true });
    const payload = await checkAndValidate(fake, {});
    expect(payload.runtime).toMatchObject({ activeSession: false, processExited: true });
    expect(payload.runtime).not.toHaveProperty('sessionMode');
  });
});

describe('renamed response fields: the old names no longer satisfy the schema', () => {
  // Each payload below is what the tool returned before its fields were
  // renamed, complete except for the new name. A schema without a `required`
  // list would accept every one of them.
  const retiredPayloads: Array<[string, Record<string, unknown>]> = [
    ['duplicate_node', { success: true, originalPath: 'root/A', newPath: 'root/A2' }],
    ['get_scene_dependencies', { scene: 'main.tscn', dependencies: [] }],
    [
      'get_debug_output',
      { projectPath: '/p', output: [], errors: [], running: null, attached: true },
    ],
    [
      'stop_project',
      {
        projectPath: '/p',
        message: 'Godot project stopped',
        mode: 'spawned',
        externalProcessPreserved: false,
        alreadyExited: false,
        finalOutput: [],
        finalErrors: [],
      },
    ],
  ];

  it.each(retiredPayloads)('%s rejects its pre-rename payload', (name, payload) => {
    const definition = toolsWithOutputSchema.find(([toolName]) => toolName === name)?.[1];
    if (!definition) throw new Error(`${name} outputSchema not found`);
    expect(ajv.compile(definition.outputSchema as object)(payload)).toBe(false);
  });
});
