/**
 * Regression tests for GitHub issue #62: attaching a script that cannot be
 * instantiated reported `success: true` while the script never reached the
 * saved scene.
 *
 * Root cause: `load()` succeeds and returns a Script resource even when the
 * script is unusable (a GDScript parse error, or a C# class missing from the
 * compiled game assembly), and `Object.set_script()` on an unusable script
 * fails SILENTLY -- it prints an ERROR to stderr and leaves `get_script()`
 * null, with nothing for the caller to check. `godot_operations.gd` now
 * gates every "script" assignment (`attach_script`, `set_node_properties`,
 * `add_node`) on `_check_script_attachable` (can_instantiate() / is_abstract())
 * before the assignment, and backstops with `_verify_script_attached` after
 * it, in case some case slips past the gate.
 *
 * Requires GODOT_PATH. Skipped locally when it is unset; CI sets it in the
 * godot-integration job and runs this file on Godot 4.5.1 and 4.6.2 (both
 * standard, non-.NET builds -- the C#-specific case is skipped there, and
 * the opt-in C# test below never runs in CI).
 */

import { describe, beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { extractJson } from '../../src/utils/output-parsing.js';

const PARSE_ERROR_SCRIPT = 'extends Node2D\nfunc _ready(:\n';
const VALID_SCRIPT = 'extends Node2D\nfunc _ready():\n\tpass\n';

function makeTmpProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-test-${id}`);
  cpSync(fixtureProjectPath, dst, { recursive: true });
  return dst;
}

function hasDotnet(): boolean {
  try {
    execFileSync('dotnet', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const tmpDirs: string[] = [];

let runner: GodotRunner;
let isMonoBuild = false;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
  if (runner.getGodotPath()) {
    try {
      isMonoBuild = (await runner.getVersion()).toLowerCase().includes('mono');
    } catch {
      isMonoBuild = false;
    }
  }
});

beforeEach(() => {
  tmpDirs.push(makeTmpProject());
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('attach_script rejects a script that cannot be instantiated', () => {
  itGodot(
    'errors on a GDScript with a parse error and leaves the scene unchanged',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');
      const originalTscn = readFileSync(scenePath, 'utf-8');
      writeFileSync(join(tmpProject, 'bad.gd'), PARSE_ERROR_SCRIPT, 'utf-8');

      const { stdout, stderr } = await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: '.', scriptPath: 'bad.gd' },
        tmpProject,
        30000,
      );

      // attach_script quits(1) before printing its success payload, so
      // stdout carries no success JSON -- the error is on stderr. Not
      // asserting stdout is empty outright: on some engine builds a stray
      // RID-leak warning at process exit lands on stdout instead of stderr
      // (see STDOUT_NOISE_LINE_PATTERN in src/utils/headless-op.ts), which
      // is exit noise, not a payload.
      expect(stdout).not.toMatch(/"success"\s*:\s*true/);
      expect(stderr).toMatch(/cannot be instantiated/i);
      expect(stderr).toMatch(/parse error/i);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toBe(originalTscn);
    },
    60000,
  );

  itGodot(
    'still attaches a valid GDScript and writes the ext_resource (no regression)',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');
      writeFileSync(join(tmpProject, 'good.gd'), VALID_SCRIPT, 'utf-8');

      const { stdout } = await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: '.', scriptPath: 'good.gd' },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.success).toBe(true);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toMatch(/ext_resource type="Script" path="res:\/\/good\.gd"/);
      expect(sceneText).toMatch(/script = ExtResource\(/);
    },
    60000,
  );

  itGodot(
    'errors with the no-C#-support message when GODOT_PATH is a standard (non-.NET) build',
    async (ctx) => {
      if (isMonoBuild) {
        ctx.skip();
      }
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');
      const originalTscn = readFileSync(scenePath, 'utf-8');
      writeFileSync(
        join(tmpProject, 'Player.cs'),
        'using Godot;\n\npublic partial class Player : Node2D\n{\n}\n',
        'utf-8',
      );

      const { stdout, stderr } = await runner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: '.', scriptPath: 'Player.cs' },
        tmpProject,
        30000,
      );

      expect(stdout).not.toMatch(/"success"\s*:\s*true/);
      expect(stderr).toMatch(/no c# support/i);
      expect(stderr).toMatch(/GODOT_PATH/);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toBe(originalTscn);
    },
    60000,
  );
});

describe('set_node_properties rejects a "script" property that cannot be instantiated', () => {
  itGodot(
    'reports a per-update error for a parse-error .gd and does not persist it',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');
      const originalTscn = readFileSync(scenePath, 'utf-8');
      writeFileSync(join(tmpProject, 'bad.gd'), PARSE_ERROR_SCRIPT, 'utf-8');

      const { stdout } = await runner.executeOperation(
        'set_node_properties',
        {
          scenePath: 'main.tscn',
          updates: [{ nodePath: '.', property: 'script', value: 'res://bad.gd' }],
        },
        tmpProject,
        30000,
      );

      const parsed = JSON.parse(extractJson(stdout));
      expect(parsed.results[0].success).toBeUndefined();
      expect(parsed.results[0].error).toMatch(/cannot be instantiated/i);
      const sceneText = readFileSync(scenePath, 'utf-8');
      expect(sceneText).toBe(originalTscn);
    },
    60000,
  );
});

describe('add_node rejects a properties.script that cannot be instantiated', () => {
  itGodot(
    'errors and does not add the node when properties.script cannot be instantiated',
    async () => {
      const tmpProject = tmpDirs[tmpDirs.length - 1];
      const scenePath = join(tmpProject, 'main.tscn');
      const originalTscn = readFileSync(scenePath, 'utf-8');
      writeFileSync(join(tmpProject, 'bad.gd'), PARSE_ERROR_SCRIPT, 'utf-8');

      const { stdout, stderr } = await runner.executeOperation(
        'add_node',
        {
          scenePath: 'main.tscn',
          nodeType: 'Node2D',
          nodeName: 'BadScripted',
          parentNodePath: '.',
          properties: { script: 'res://bad.gd' },
        },
        tmpProject,
        30000,
      );

      expect(stdout).not.toContain('added successfully');
      expect(stderr).toMatch(/cannot be instantiated/i);
      const tscnAfter = readFileSync(scenePath, 'utf-8');
      expect(tscnAfter).not.toMatch(/\[node name="BadScripted"/);
      expect(tscnAfter).toBe(originalTscn);
    },
    60000,
  );
});

// --- Opt-in C# coverage ---
//
// Gated on GODOT_MONO_PATH (a Godot .NET build) and a `dotnet` on PATH,
// neither of which CI provides. Set both locally to run this suite:
//
//   GODOT_MONO_PATH=/path/to/Godot_mono npx vitest run tests/integration/script-attach-validation.test.ts
//
// Builds a minimal C# project fixture from scratch in a tmp dir (mirroring
// the manual repro template): a Player.cs class, a matching .csproj using
// the Godot.NET.Sdk, and a scene with a node to attach it to.
const monoGodotPath = process.env.GODOT_MONO_PATH;
const itMono = it.skipIf(!monoGodotPath || !hasDotnet());

const CSPROJ = `<Project Sdk="Godot.NET.Sdk/4.7.2">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <EnableDynamicLoading>true</EnableDynamicLoading>
  </PropertyGroup>
</Project>
`;

const PROJECT_GODOT = `config_version=5

[application]
config/name="ScriptAttachMono"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.7", "C#")

[dotnet]
project/assembly_name="ScriptAttachMono"
`;

const PLAYER_CS = `using Godot;

public partial class Player : Node2D
{
}
`;

const MAIN_TSCN = `[gd_scene format=3]

[node name="Main" type="Node2D"]

[node name="Player" type="Node2D" parent="."]
`;

function makeMonoProject(): string {
  const id = randomBytes(6).toString('hex');
  const dst = join(tmpdir(), `godot-mcp-mono-test-${id}`);
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'project.godot'), PROJECT_GODOT, 'utf-8');
  writeFileSync(join(dst, 'ScriptAttachMono.csproj'), CSPROJ, 'utf-8');
  writeFileSync(join(dst, 'Player.cs'), PLAYER_CS, 'utf-8');
  writeFileSync(join(dst, 'main.tscn'), MAIN_TSCN, 'utf-8');
  return dst;
}

describe('C# script attachment against a Godot .NET build', () => {
  itMono(
    'errors with the build instruction before the project is built, then succeeds and writes the ext_resource after dotnet build',
    async () => {
      const monoProject = makeMonoProject();
      tmpDirs.push(monoProject);
      const monoRunner = new GodotRunner({ godotPath: monoGodotPath });
      await monoRunner.detectGodotPath();
      const scenePath = join(monoProject, 'main.tscn');
      const originalTscn = readFileSync(scenePath, 'utf-8');

      // Before dotnet build: the compiled assembly has no Player class yet.
      const before = await monoRunner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root/Player', scriptPath: 'Player.cs' },
        monoProject,
        30000,
      );
      expect(before.stdout).not.toMatch(/"success"\s*:\s*true/);
      expect(before.stderr).toMatch(/cannot be instantiated/i);
      expect(before.stderr).toMatch(/dotnet build/i);
      expect(readFileSync(scenePath, 'utf-8')).toBe(originalTscn);

      execFileSync('dotnet', ['build'], { cwd: monoProject, timeout: 120000, stdio: 'ignore' });

      // After dotnet build: the class is in the compiled assembly.
      const after = await monoRunner.executeOperation(
        'attach_script',
        { scenePath: 'main.tscn', nodePath: 'root/Player', scriptPath: 'Player.cs' },
        monoProject,
        30000,
      );
      const parsed = JSON.parse(extractJson(after.stdout));
      expect(parsed.success).toBe(true);
      const sceneAfter = readFileSync(scenePath, 'utf-8');
      expect(sceneAfter).toMatch(/ext_resource type="Script" path="res:\/\/Player\.cs"/);
      expect(sceneAfter).toMatch(/script = ExtResource\(/);
    },
    180000,
  );
});
