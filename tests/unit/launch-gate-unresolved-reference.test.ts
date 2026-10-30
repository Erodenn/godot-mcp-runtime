import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { runLaunchGate } from '../../src/utils/launch-gate.js';
import { makeContext } from '../helpers/runtime-fakes.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { expectErrorMatching } from '../helpers/assertions.js';

const tmp = useTmpDirs();

function projectInstancing(reference: string): string {
  const dir = tmp.makeProject(
    'gate-unresolved-ref-',
    'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n',
  );
  writeFileSync(
    join(dir, 'main.tscn'),
    `[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="${reference}" id="1"]\n\n[node name="Main" type="Node"]\n`,
    'utf8',
  );
  return dir;
}

function gate(dir: string, strict: boolean) {
  return runLaunchGate(
    { projectPath: dir, confirm: false, launchedByServer: true, toolName: 'run_project' },
    makeContext({ strict }),
  );
}

describe('an instanced scene whose path could not be resolved', () => {
  it('is a warning outside strict mode', async () => {
    const result = await gate(projectInstancing('res://../outside.tscn'), false);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.warnings.join('\n')).toMatch(
      /^Not scanned: main\.tscn: reference res:\/\/\.\.\/outside\.tscn could not be resolved to a file inside the project and was not followed$/m,
    );
  });

  it('makes strict mode refuse', async () => {
    const result = await gate(projectInstancing('res://../outside.tscn'), true);
    expectErrorMatching(result, /could not read or resolve scripts or scenes/);
    expectErrorMatching(result, /Not scanned: main\.tscn: reference res:\/\/\.\.\/outside\.tscn/);
  });

  it('does not refuse on a resolvable reference whose file is of a kind the scan does not read', async () => {
    const dir = projectInstancing('res://level.scn');
    writeFileSync(join(dir, 'level.scn'), 'RSCC binary', 'utf8');
    const result = await gate(dir, true);
    expect(result.ok).toBe(true);
  });
});
