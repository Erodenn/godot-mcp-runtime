import { describe, it, expect } from 'vitest';
import type { GodotRunner } from '../../../src/utils/godot-runner.js';
import {
  RUN_SCRIPT_TIMED_OUT_FIELD,
  RUN_SCRIPT_TIMEOUT_FIELD,
} from '../../../src/tools/runtime-tools.js';
import { fakeSessionApi } from '../../helpers/fake-sessions.js';
import { makeContext } from '../../helpers/runtime-fakes.js';

/** Accepts every confirmation prompt, so a script goes to the bridge. */
const scriptCtx = makeContext();

const REQUESTED_TIMEOUT_MS = 12000;
const SENT_TIMEOUT_TOLERANCE_MS = 2000;

interface SentCommand {
  command: string;
  params: Record<string, unknown>;
  timeoutMs: number;
}

function makeFakeRunner(
  response: string,
  runtimeErrors: string[],
  sent: SentCommand[],
): GodotRunner {
  const projectPath = '/fake/project';
  const proc = { hasExited: false };
  const fake = {
    activeProjectPath: projectPath,
    activeSessionMode: 'spawned',
    activeProcess: proc,
    ...fakeSessionApi(() => ({ current: { mode: 'spawned', projectPath, process: proc } })),
    runExclusive: <T>(_label: string, operation: () => Promise<T>): Promise<T> => operation(),
    queueTurn: () => null,
    async sendCommandWithErrors(
      command: string,
      params: Record<string, unknown>,
      timeoutMs: number,
    ) {
      sent.push({ command, params, timeoutMs });
      return { response, runtimeErrors, stderrWindow: runtimeErrors };
    },
  };
  return fake as unknown as GodotRunner;
}

const AWAITING_SCRIPT =
  'extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n\tawait scene_tree.process_frame\n\treturn 1\n';

describe('handleRunScript with an execute that awaits', () => {
  it('sends the call timeout to the bridge so it can bound the wait', async () => {
    const { handleRunScript } = await import('../../../src/tools/runtime-tools.js');
    const sent: SentCommand[] = [];
    const fake = makeFakeRunner(JSON.stringify({ success: true, result: 1 }), [], sent);
    const result = await handleRunScript(
      fake,
      {
        script: AWAITING_SCRIPT,
        timeout: REQUESTED_TIMEOUT_MS,
      },
      scriptCtx,
    );
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const forwarded = sent[0]!.params[RUN_SCRIPT_TIMEOUT_FIELD];
    expect(typeof forwarded).toBe('number');
    expect(forwarded).toBe(sent[0]!.timeoutMs);
    expect(Math.abs((forwarded as number) - REQUESTED_TIMEOUT_MS)).toBeLessThan(
      SENT_TIMEOUT_TOLERANCE_MS,
    );
  });

  it('turns the bridge timed_out reply into a typed error that carries the runtime errors', async () => {
    const { handleRunScript } = await import('../../../src/tools/runtime-tools.js');
    const fake = makeFakeRunner(
      JSON.stringify({
        error: 'run_script timed out: execute was still awaiting after 11750 ms',
        [RUN_SCRIPT_TIMED_OUT_FIELD]: true,
      }),
      ['SCRIPT ERROR: Invalid access to property after the await'],
      [],
    );
    const result = await handleRunScript(fake, { script: AWAITING_SCRIPT }, scriptCtx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = JSON.stringify(result.error);
    expect(text).toContain('run_script timed out');
    expect(text).toContain('Invalid access to property after the await');
    expect(text).not.toContain('Check your GDScript syntax');
  });
});
