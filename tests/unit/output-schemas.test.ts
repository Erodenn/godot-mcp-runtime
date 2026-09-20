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
