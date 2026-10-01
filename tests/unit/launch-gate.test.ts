/**
 * Unit tests for the launch gate: the pre-flight script scan and the
 * once-per-project session confirmation, exercised directly rather than
 * through a handler. No Godot and no runner: the gate reads project files and
 * the request context, nothing else.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { runLaunchGate, MAX_SCAN_WARNINGS_SHOWN } from '../../src/utils/launch-gate.js';
import type { Elicitor, ElicitorResult } from '../../src/utils/mcp-context.js';
import { makeContext } from '../helpers/runtime-fakes.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { expectErrorMatching, unwrap } from '../helpers/assertions.js';

const tmp = useTmpDirs();

const TIER1_AUTOLOAD = 'extends Node\nfunc _ready():\n\tOS.execute("rm", ["-rf"])\n';
const TIER2_AUTOLOAD = 'extends Node\nfunc _ready():\n\tvar h = HTTPRequest.new()\n';
const SCRIPTLESS_SCENE = '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n';
const MAIN_SCENE_SETTING = 'run/main_scene="res://main.tscn"\n';

function makeProjectWithAutoload(
  prefix: string,
  autoloadGd: string,
  applicationLines = '',
): string {
  const dir = tmp.makeProject(
    prefix,
    `config_version=5\n\n[application]\n${applicationLines}[autoload]\nMyAuto="res://auto.gd"\n`,
  );
  writeFileSync(join(dir, 'auto.gd'), autoloadGd, 'utf8');
  return dir;
}

/** An elicitor that records how often it was consulted and answers `answer`. */
function countingElicitor(answer: ElicitorResult): { elicit: Elicitor; calls: () => number } {
  let calls = 0;
  return {
    elicit: async () => {
      calls++;
      return answer;
    },
    calls: () => calls,
  };
}

function warningsOf(result: Awaited<ReturnType<typeof runLaunchGate>>): string[] {
  if (!result.ok) throw new Error(`expected an ok outcome, got: ${JSON.stringify(result.error)}`);
  return result.value.warnings;
}

describe('runLaunchGate session confirmation', () => {
  it.each<[string, ElicitorResult]>([
    ['decline', { action: 'decline' }],
    ['cancel', { action: 'cancel' }],
    ['accept carrying confirm: false', { action: 'accept', content: { confirm: false } }],
  ])('refuses on %s', async (_label, answer) => {
    const dir = tmp.makeProject('launch-gate-refuse-');
    const result = await runLaunchGate(
      { projectPath: dir, confirm: true, toolName: 'run_project' },
      makeContext({ elicit: async () => answer }),
    );
    expect(result.ok).toBe(false);
  });

  it('names the calling tool in the decline message', async () => {
    const dir = tmp.makeProject('launch-gate-toolname-');
    const result = await runLaunchGate(
      { projectPath: dir, confirm: true, toolName: 'render_movie' },
      makeContext({ elicit: async () => ({ action: 'decline' }) }),
    );
    expectErrorMatching(result, /User declined render_movie/);
    expect(unwrap(result).content[1]?.text ?? '').toMatch(/Retry render_movie/);
  });

  it('elicits once per project across repeated calls on one context', async () => {
    const dir = tmp.makeProject('launch-gate-once-');
    const counting = countingElicitor({ action: 'accept', content: { confirm: true } });
    const ctx = makeContext({ elicit: counting.elicit });
    const request = { projectPath: dir, confirm: true, toolName: 'run_project' };
    expect((await runLaunchGate(request, ctx)).ok).toBe(true);
    expect((await runLaunchGate(request, ctx)).ok).toBe(true);
    expect(counting.calls()).toBe(1);
  });

  it('skips the confirmation when told to, while still scanning', async () => {
    const dir = makeProjectWithAutoload('launch-gate-noconfirm-', TIER1_AUTOLOAD);
    const counting = countingElicitor({ action: 'decline' });
    const ctx = makeContext({ elicit: counting.elicit });
    const result = await runLaunchGate(
      { projectPath: dir, confirm: false, toolName: 'run_project' },
      ctx,
    );
    expect(warningsOf(result).some((w) => /OS\.execute/.test(w))).toBe(true);
    expect(counting.calls()).toBe(0);
    expect(ctx.sessionState.runProjectConfirmed.size).toBe(0);
  });
});

describe('runLaunchGate pre-flight scan', () => {
  it('returns a Tier 1 autoload finding as a warning outside strict mode', async () => {
    const dir = makeProjectWithAutoload('launch-gate-tier1-', TIER1_AUTOLOAD);
    const result = await runLaunchGate(
      { projectPath: dir, confirm: true, toolName: 'run_project' },
      makeContext(),
    );
    expect(warningsOf(result).some((w) => /OS\.execute/.test(w))).toBe(true);
  });

  it('warns on a Tier 2 autoload finding outside strict mode', async () => {
    const dir = makeProjectWithAutoload('launch-gate-tier2-warn-', TIER2_AUTOLOAD);
    const result = await runLaunchGate(
      { projectPath: dir, confirm: true, toolName: 'run_project' },
      makeContext(),
    );
    expect(warningsOf(result).some((w) => /HTTPRequest/.test(w))).toBe(true);
  });

  it('strict mode promotes a Tier 2 autoload finding to a refusal without eliciting', async () => {
    const dir = makeProjectWithAutoload('launch-gate-tier2-strict-', TIER2_AUTOLOAD);
    const counting = countingElicitor({ action: 'accept', content: { confirm: true } });
    const result = await runLaunchGate(
      { projectPath: dir, confirm: true, toolName: 'run_project' },
      makeContext({ elicit: counting.elicit, strict: true }),
    );
    expectErrorMatching(result, /Strict mode: refusing to launch/);
    expect(counting.calls()).toBe(0);
  });

  it('disableSecurity skips the scan and the confirmation, strict mode included', async () => {
    const dir = makeProjectWithAutoload('launch-gate-disable-security-', TIER1_AUTOLOAD);
    const counting = countingElicitor({ action: 'decline' });
    const result = await runLaunchGate(
      { projectPath: dir, confirm: true, toolName: 'run_project' },
      makeContext({ elicit: counting.elicit, strict: true, disableSecurity: true }),
    );
    expect(warningsOf(result)).toEqual([]);
    expect(counting.calls()).toBe(0);
  });

  it('caps the warnings and ends them with a count of the rest', async () => {
    const findingCount = MAX_SCAN_WARNINGS_SHOWN + 2;
    const autoload = 'extends Node\nfunc _ready():\n' + '\tOS.execute("x")\n'.repeat(findingCount);
    const dir = makeProjectWithAutoload('launch-gate-cap-', autoload, MAIN_SCENE_SETTING);
    writeFileSync(join(dir, 'main.tscn'), SCRIPTLESS_SCENE, 'utf8');
    const result = await runLaunchGate(
      { projectPath: dir, confirm: false, toolName: 'run_project' },
      makeContext(),
    );
    const warnings = warningsOf(result);
    expect(warnings).toHaveLength(MAX_SCAN_WARNINGS_SHOWN + 1);
    expect(warnings[warnings.length - 1]).toBe('+2 more');
  });

  it('scans an explicit scene instead of run/main_scene', async () => {
    const dir = tmp.makeProject(
      'launch-gate-explicit-scene-',
      `config_version=5\n\n[application]\n${MAIN_SCENE_SETTING}`,
    );
    writeFileSync(join(dir, 'main_only.gd'), 'extends Node\n\tOS.execute("x")\n', 'utf8');
    writeFileSync(
      join(dir, 'other_only.gd'),
      'extends Node\nfunc _ready():\n\tvar h = HTTPRequest.new()\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'main.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://main_only.gd" id="1"]\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'other.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://other_only.gd" id="1"]\n',
      'utf8',
    );
    const result = await runLaunchGate(
      { projectPath: dir, scene: 'other.tscn', confirm: false, toolName: 'run_project' },
      makeContext(),
    );
    const warnings = warningsOf(result).join('\n');
    expect(warnings).toMatch(/other_only\.gd.*HTTPRequest/);
    expect(warnings).not.toMatch(/OS\.execute/);
  });
});
