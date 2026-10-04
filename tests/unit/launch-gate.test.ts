/**
 * Unit tests for the launch gate: the pre-flight script scan and the
 * once-per-project session confirmation, exercised directly rather than
 * through a handler. No Godot and no runner: the gate reads project files and
 * the request context, nothing else.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath } from '../../src/utils/path-validation.js';
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
      {
        projectPath: dir,
        scene: resolveProjectPath(dir, 'other.tscn')!,
        confirm: false,
        toolName: 'run_project',
      },
      makeContext(),
    );
    const warnings = warningsOf(result).join('\n');
    expect(warnings).toMatch(/other_only\.gd.*HTTPRequest/);
    expect(warnings).not.toMatch(/OS\.execute/);
  });

  it('scans the scene named by an absolute scene argument', async () => {
    const dir = tmp.makeProject(
      'gate-abs-scene-',
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
      {
        projectPath: dir,
        scene: resolveProjectPath(dir, join(dir, 'other.tscn'))!,
        confirm: false,
        toolName: 'run_project',
      },
      makeContext(),
    );
    const warnings = warningsOf(result).join('\n');
    expect(warnings).toMatch(/other_only\.gd.*HTTPRequest/);
    expect(warnings).not.toMatch(/OS\.execute/);
  });
});

describe('runLaunchGate uid:// resolution', () => {
  const SCENE_UID = 'uid://scenemain00001';
  const SCRIPT_UID = 'uid://scriptauto0001';
  const TIER1_SCRIPT = 'extends Node\nfunc _ready():\n\tOS.execute("x")\n';
  const gate = (dir: string) =>
    runLaunchGate({ projectPath: dir, confirm: false, toolName: 'run_project' }, makeContext());

  function writeUidScene(dir: string, name: string, uid: string, scriptName: string): void {
    writeFileSync(
      join(dir, name),
      `[gd_scene load_steps=2 format=3 uid="${uid}"]\n\n[ext_resource type="Script" path="res://${scriptName}" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n`,
      'utf8',
    );
  }

  it('scans the scripts of a uid main scene and reports a Tier 1 primitive', async () => {
    const dir = tmp.makeProject(
      'gate-uid-main-',
      `config_version=5\n\n[application]\nrun/main_scene="${SCENE_UID}"\n`,
    );
    writeUidScene(dir, 'menu.tscn', SCENE_UID, 'menu.gd');
    writeFileSync(join(dir, 'menu.gd'), TIER1_SCRIPT, 'utf8');
    const warnings = warningsOf(await gate(dir)).join('\n');
    expect(warnings).toMatch(/menu\.gd.*OS\.execute/);
    expect(warnings).not.toMatch(/could not be resolved/);
  });

  it('warns that an unknown uid could not be resolved', async () => {
    const dir = tmp.makeProject(
      'gate-uid-unknown-',
      `config_version=5\n\n[application]\nrun/main_scene="${SCENE_UID}"\n`,
    );
    const warnings = warningsOf(await gate(dir));
    expect(warnings).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `Launch scene ${SCENE_UID} could not be resolved to a file \\(.*\\); scene-script scan skipped\\.`,
        ),
      ),
    );
  });

  it('scans both files that carry one uid and notes it', async () => {
    const dir = tmp.makeProject(
      'gate-uid-twice-',
      `config_version=5\n\n[application]\nrun/main_scene="${SCENE_UID}"\n`,
    );
    writeUidScene(dir, 'one.tscn', SCENE_UID, 'one.gd');
    writeUidScene(dir, 'two.tscn', SCENE_UID, 'two.gd');
    writeFileSync(join(dir, 'one.gd'), TIER1_SCRIPT, 'utf8');
    writeFileSync(join(dir, 'two.gd'), TIER1_SCRIPT, 'utf8');
    const warnings = warningsOf(await gate(dir)).join('\n');
    expect(warnings).toMatch(/one\.gd.*OS\.execute/);
    expect(warnings).toMatch(/two\.gd.*OS\.execute/);
    expect(warnings).toMatch(/2 files carry/);
  });

  it('resolves a uid autoload through its .gd.uid sidecar', async () => {
    const dir = tmp.makeProject(
      'gate-uid-autoload-',
      `config_version=5\n\n[autoload]\nMyAuto="*${SCRIPT_UID}"\n`,
    );
    writeFileSync(join(dir, 'auto.gd'), TIER1_SCRIPT, 'utf8');
    writeFileSync(join(dir, 'auto.gd.uid'), `${SCRIPT_UID}\n`, 'utf8');
    const warnings = warningsOf(await gate(dir)).join('\n');
    expect(warnings).toMatch(/auto\.gd.*OS\.execute/);
  });

  it('warns that a uid autoload nothing carries was not scanned', async () => {
    const dir = tmp.makeProject(
      'gate-uid-autoload-missing-',
      `config_version=5\n\n[autoload]\nMyAuto="*${SCRIPT_UID}"\n`,
    );
    const warnings = warningsOf(await gate(dir));
    expect(warnings).toContainEqual(
      expect.stringMatching(/Autoload MyAuto \(uid:\/\/scriptauto0001\) was not scanned/),
    );
  });
});
