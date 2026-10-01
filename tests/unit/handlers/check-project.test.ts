import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'path';
import { handleCheckProject } from '../../../src/tools/project-tools.js';
import { GodotRunner, type GodotProcess } from '../../../src/utils/godot-runner.js';
import { createRuntimeFake } from '../../helpers/runtime-fakes.js';
import { liveSessionInfo } from '../../helpers/fake-sessions.js';
import { installSession } from '../../helpers/session-install.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';
import { unwrap, hasError } from '../../helpers/assertions.js';

const OTHER_PROJECT_PATH = '/fake/other';
const OTHER_BRIDGE_PORT = 6100;
const EXIT_CODE = 3;

/**
 * Coverage for check_project's always-present `runtime` block. Argument
 * validation and the projectPath-present payload shape (name/path/structure)
 * live in project-handlers.test.ts; this file exercises only the runtime
 * probe branches, via the bridge-command fake in runtime-fakes.ts.
 */
describe('handleCheckProject runtime block', () => {
  it('reports { activeSession: false } exactly when there is no session', async () => {
    const fake = createRuntimeFake();
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime).toEqual({ activeSession: false, projectPath: null, liveSessions: [] });
  });

  it('reports activeSession:true and bridgeResponsive:true when the bridge answers pong', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setBridgeResponse({ status: 'pong' });
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.activeSession).toBe(true);
    expect(data.runtime.sessionMode).toBe('spawned');
    expect(data.runtime.bridgeResponsive).toBe(true);
    expect(fake.bridgeCalls[0]!.command).toBe('ping');
  });

  it('reports processExited:true after a spawned game exited on its own', async () => {
    // The state the real runner lands in: handleSpawnedProcessExit nulls the
    // session fields and keeps the process, so a report gated on the session
    // fields alone would call this "no session" and withhold the one thing
    // worth saying about it.
    const fake = createRuntimeFake();
    fake.setSession({ mode: null, projectPath: null, hasExited: true });
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.activeSession).toBe(false);
    expect(data.runtime.processExited).toBe(true);
    expect(data.runtime.diagnostics.join('; ')).toContain('stop_project');
    expect(data.runtime.diagnostics.join('; ')).toContain('get_debug_output');
    // No bridge ping on a dead process.
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('reports activeSession:false and processExited:true when a spawn never produced a live process', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: true });
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.activeSession).toBe(false);
    expect(data.runtime.processExited).toBe(true);
    expect(Array.isArray(data.runtime.diagnostics)).toBe(true);
    expect(data.runtime.diagnostics.length).toBeGreaterThan(0);
  });

  it('reports bridgeResponsive:false without failing the call when the ping throws', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setSendCommandError(new Error('Connection refused'));
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    expect(unwrap(result)).not.toHaveProperty('isError', true);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.bridgeResponsive).toBe(false);
    expect(data.runtime.diagnostics.join('; ')).toContain('Connection refused');
  });

  it('returns only { godotVersion, runtime } when projectPath is omitted', async () => {
    const fake = createRuntimeFake();
    const result = await handleCheckProject(fake.asRunner, {});
    expect(hasError(result)).toBe(false);
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(Object.keys(data).sort()).toEqual(['godotVersion', 'runtime']);
  });
});

describe('handleCheckProject multi-project runtime block', () => {
  it('names the current project and lists every live session', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setOtherSessions([liveSessionInfo(OTHER_PROJECT_PATH, { bridgePort: OTHER_BRIDGE_PORT })]);
    fake.setBridgeResponse({ status: 'pong' });
    const result = await handleCheckProject(fake.asRunner, {});
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.projectPath).toBe('/fake/project');
    expect(data.runtime.liveSessions).toEqual([
      { projectPath: '/fake/project', sessionMode: 'spawned', current: true, bridgePort: null },
      {
        projectPath: OTHER_PROJECT_PATH,
        sessionMode: 'spawned',
        current: false,
        bridgePort: OTHER_BRIDGE_PORT,
      },
    ]);
  });

  it("reports the asked project's own session when it is not the current one", async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setOtherSessions([liveSessionInfo(resolve(fixtureProjectPath))]);
    fake.setBridgeResponse({ status: 'pong' });
    const result = await handleCheckProject(fake.asRunner, { projectPath: fixtureProjectPath });
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.project).toEqual({
      projectPath: resolve(fixtureProjectPath),
      session: 'live',
      current: false,
      sessionMode: 'spawned',
    });
  });

  it('reports session none for a project this server is not running', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setBridgeResponse({ status: 'pong' });
    const result = await handleCheckProject(fake.asRunner, { projectPath: fixtureProjectPath });
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.project).toEqual({
      projectPath: resolve(fixtureProjectPath),
      session: 'none',
      current: false,
    });
  });

  it('reports an exited session on the asked project with its exit code', async () => {
    const fake = createRuntimeFake();
    fake.setSession({ mode: 'spawned', projectPath: '/fake/project', hasExited: false });
    fake.setOtherSessions([
      liveSessionInfo(resolve(fixtureProjectPath), {
        live: false,
        mode: null,
        processExited: true,
        exitCode: EXIT_CODE,
      }),
    ]);
    fake.setBridgeResponse({ status: 'pong' });
    const result = await handleCheckProject(fake.asRunner, { projectPath: fixtureProjectPath });
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.project).toEqual({
      projectPath: resolve(fixtureProjectPath),
      session: 'exited',
      current: false,
      exitCode: EXIT_CODE,
    });
    const livePaths = data.runtime.liveSessions.map((s: { projectPath: string }) => s.projectPath);
    expect(livePaths).toEqual(['/fake/project']);
  });

  it('flags live sessions when the runtime tools point at none', async () => {
    const fake = createRuntimeFake();
    fake.setOtherSessions([liveSessionInfo(OTHER_PROJECT_PATH, { bridgePort: OTHER_BRIDGE_PORT })]);
    const result = await handleCheckProject(fake.asRunner, {});
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.activeSession).toBe(false);
    expect(data.runtime.projectPath).toBeNull();
    expect(data.runtime.liveSessions).toHaveLength(1);
    expect(data.runtime.diagnostics.join('; ')).toContain('switch_project');
    expect(fake.bridgeCalls).toHaveLength(0);
  });

  it('names the project of a current session whose game exited', async () => {
    const runner = new GodotRunner();
    vi.spyOn(runner, 'getVersion').mockResolvedValue('4.7.2.stable.official');
    const exited: GodotProcess = {
      process: undefined as never,
      output: [],
      errors: [],
      totalErrorsWritten: 0,
      exitCode: EXIT_CODE,
      hasExited: true,
      sessionToken: 'tok',
    };
    installSession(runner, { projectPath: '/fake/exited-project', mode: null, process: exited });
    const result = await handleCheckProject(runner, {});
    const data = JSON.parse(unwrap(result).content[0]!.text!);
    expect(data.runtime.activeSession).toBe(false);
    expect(data.runtime.projectPath).toBe('/fake/exited-project');
    expect(data.runtime.exitCode).toBe(EXIT_CODE);
  });
});
