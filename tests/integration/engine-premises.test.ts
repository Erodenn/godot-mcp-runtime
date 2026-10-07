/**
 * Engine-premise probes.
 *
 * Each probe settles a review claim that was reasoned from memory of the
 * engine and could not be executed when it was written. A probe states the
 * CORRECT behaviour as its final assertion, so it is red exactly when the
 * claimed defect exists and green when the defect cannot be reproduced. Before
 * that assertion it checks, with its own message, that the operation really
 * ran (a control call of the same shape succeeded, a file exists, a payload
 * parsed), so a probe cannot pass because the engine did nothing and a probe
 * that fails at a precondition is an authoring error, not a reproduction.
 *
 * The title of each probe starts with the id of the finding it settles
 * ("R6-1a: ..."), so a run's output is greppable by id.
 *
 * Guarded by GODOT_MCP_TEST_ENGINE_PREMISES=1 on top of GODOT_PATH, because a
 * probe is allowed to be red. A probe that is green before its fix stays as a
 * plain `itGodot` pin; a red one gets its fix and then loses the guard.
 *
 * Break conditions are given per probe: the change to the code under test that
 * turns the probe red (the defect named in the title's id).
 */

import { describe, it, beforeAll, afterEach, expect } from 'vitest';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import net from 'net';
import { hasGodot } from '../helpers/godot-skip.js';
import { dropProjectFeatureVersion, useTmpDirs } from '../helpers/tmp.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { authoredFixtureProjectPath, fixtureProjectPath } from '../helpers/fixture-paths.js';
import { unwrap } from '../helpers/assertions.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import type { HandlerResult } from '../../src/mcp.types.js';
import { handleAddNode, handleBatchSceneOperations } from '../../src/tools/scene-tools.js';
import {
  handleConnectSignal,
  handleGetNodeProperties,
  handleGetSceneTree,
  handleSetNodeProperties,
} from '../../src/tools/node-tools.js';
import {
  handleGetDebugOutput,
  handleGetUiElements,
  handleRunScript,
  handleSimulateInput,
} from '../../src/tools/runtime-tools.js';
import { scanProjectFile } from '../../src/utils/project-godot.js';

const PREMISE_ENV_VAR = 'GODOT_MCP_TEST_ENGINE_PREMISES';
const itPremise = hasGodot && process.env[PREMISE_ENV_VAR] === '1' ? it : it.skip;

const CASE_TIMEOUT_MS = 120_000;
const RUNTIME_CASE_TIMEOUT_MS = 90_000;
const BRIDGE_CMD_TIMEOUT_MS = 15_000;
const LOCALHOST = '127.0.0.1';
const PROJECT_DIR = 'project';
const DEBUG_LINE_LIMIT = 2000;
const STDERR_SETTLE_MS = 600;
const SCRIPT_ERROR_BUDGET_MS = 5_000;
const SCRIPT_ERROR_CLIENT_TIMEOUT_MS = 12_000;
const BATCH_WAIT_MS = 1_500;
const CONNECT_DELAY_MS = 400;
const TIME_SCALE_TAP_BUDGET_MS = 10_000;
const PROBE_ROOT = '/root/InputProbe';
const SIGNAL_PROBE_ROOT = '/root/SigProbe';
const INPUT_PROBE_SCENE = 'input_probe.tscn';
const SIGNAL_PROBE_SCENE = 'sig_probe.tscn';

const tmp = useTmpDirs();

let runner: GodotRunner;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
});

afterEach(async () => {
  await runner.stopProject().catch(() => undefined);
});

// ---------------------------------------------------------------- helpers

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A parent directory holding a copy of the authored fixture at `parent/project`. */
function authoredCopy(): { parent: string; project: string } {
  const parent = tmp.make('godot-mcp-premise-');
  const project = join(parent, PROJECT_DIR);
  cpSync(authoredFixtureProjectPath, project, { recursive: true });
  dropProjectFeatureVersion(project);
  return { parent, project };
}

/**
 * A copy of the minimal fixture that launches `mainScene`, with `extraFiles`
 * (path relative to the project -> text) written beside it.
 */
function runtimeCopy(mainScene: string, extraFiles: Record<string, string> = {}): string {
  const project = tmp.make('godot-mcp-premise-rt-');
  cpSync(fixtureProjectPath, project, { recursive: true });
  const projectFile = join(project, 'project.godot');
  const original = readFileSync(projectFile, 'utf8');
  const rewritten = original.replace('res://main.tscn', `res://${mainScene}`);
  expect(rewritten, 'precondition: project.godot names main.tscn as its main scene').not.toBe(
    original,
  );
  writeFileSync(projectFile, rewritten, 'utf8');
  for (const [relPath, text] of Object.entries(extraFiles)) {
    writeFileSync(join(project, relPath), text, 'utf8');
  }
  return project;
}

function describeResult(result: HandlerResult): string {
  return JSON.stringify(unwrap(result).content);
}

/** The success payload; throws with the error text when the call failed. */
function payloadOf(result: HandlerResult, what: string): Record<string, unknown> {
  if (!result.ok) throw new Error(`precondition: ${what} failed: ${describeResult(result)}`);
  const payload = result.value.structuredContent;
  if (payload === undefined) throw new Error(`precondition: ${what} carried no structuredContent`);
  return payload;
}

interface UpdateEntry {
  success?: boolean;
  error?: string;
}

/** Whether the call, or any of its per-update entries, reported a failure. */
function wasRejected(result: HandlerResult): boolean {
  if (!result.ok) return true;
  const results = result.value.structuredContent?.results as UpdateEntry[] | undefined;
  return (results ?? []).some((entry) => entry.success === false || entry.error !== undefined);
}

function updateEntries(result: HandlerResult, what: string): UpdateEntry[] {
  return payloadOf(result, what).results as UpdateEntry[];
}

function text(project: string, scene: string): string {
  return readFileSync(join(project, scene), 'utf8');
}

function forwardSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

/** A script whose `_init` writes `markerPath`: proof the engine instantiated it. */
function markerScript(markerPath: string): string {
  return [
    'extends Node',
    '',
    'func _init() -> void:',
    `\tvar file := FileAccess.open("${forwardSlashes(markerPath)}", FileAccess.WRITE)`,
    '\tif file != null:',
    '\t\tfile.store_string("ran")',
    '\t\tfile.close()',
    '',
  ].join('\n');
}

/** Run GDScript in the live game through the bridge directly, bypassing the policy gate. */
async function bridgeScript(
  bodyLines: string[],
  timeoutMs: number = BRIDGE_CMD_TIMEOUT_MS,
): Promise<{ error?: string; result?: unknown }> {
  const source =
    'extends RefCounted\n' +
    'func execute(scene_tree: SceneTree) -> Variant:\n' +
    `${bodyLines.map((line) => `\t${line}`).join('\n')}\n`;
  const raw = await runner.sendCommand('run_script', { source }, timeoutMs);
  return JSON.parse(raw) as { error?: string; result?: unknown };
}

interface InputEntry {
  index?: number;
  type?: string;
  ok?: boolean;
  skipped?: boolean;
  errors?: string[];
  signals?: string[];
}

interface InputPayload {
  success?: boolean;
  results: InputEntry[];
}

async function simulate(actions: Array<Record<string, unknown>>): Promise<InputPayload> {
  const result = await handleSimulateInput(runner, { actions });
  return payloadOf(result, 'simulate_input') as unknown as InputPayload;
}

// ----------------------------------------------------------------- probes

describe('engine premises: scene path containment', () => {
  itPremise(
    'R6-1a: add_node refuses a node type that names a script outside the project via a leading slash',
    async () => {
      // Red when normalize_scene_path lets "res:///../outside.gd" through: the
      // outside script is loaded and its _init runs.
      const { parent, project } = authoredCopy();
      const insideMarker = join(parent, 'marker-inside.txt');
      const outsideMarker = join(parent, 'marker-outside.txt');
      writeFileSync(join(project, 'inside.gd'), markerScript(insideMarker));
      writeFileSync(join(parent, 'outside.gd'), markerScript(outsideMarker));

      const control = await handleAddNode(runner, {
        projectPath: project,
        scenePath: 'base_unit.tscn',
        nodeType: 'inside.gd',
        nodeName: 'Inside',
      });
      payloadOf(control, 'add_node with an in-project script as nodeType');
      expect(
        existsSync(insideMarker),
        'precondition: the in-project script was instantiated (its _init wrote the marker)',
      ).toBe(true);

      const escape = await handleAddNode(runner, {
        projectPath: project,
        scenePath: 'base_unit.tscn',
        nodeType: '/../outside.gd',
        nodeName: 'Outside',
      });
      expect(
        existsSync(outsideMarker),
        `the script outside the project ran; response=${describeResult(escape)}`,
      ).toBe(false);
      expect(escape.ok, `the call must be an error; response=${describeResult(escape)}`).toBe(
        false,
      );
      expect(text(project, 'base_unit.tscn')).not.toContain('outside.gd');
    },
    CASE_TIMEOUT_MS,
  );

  itPremise(
    'R6-1b: set_node_properties refuses a script property value that leaves the project via a leading slash',
    async () => {
      // Red when "res:///../outside.gd" is accepted on an Object-typed property.
      const { parent, project } = authoredCopy();
      const outsideMarker = join(parent, 'marker-outside.txt');
      writeFileSync(join(project, 'inside.gd'), markerScript(join(parent, 'marker-inside.txt')));
      writeFileSync(join(parent, 'outside.gd'), markerScript(outsideMarker));

      const control = await handleSetNodeProperties(runner, {
        projectPath: project,
        scenePath: 'base_unit.tscn',
        updates: [{ nodePath: 'root/Arm', property: 'script', value: 'res://inside.gd' }],
      });
      expect(
        updateEntries(control, 'script property set to an in-project script')[0]?.success,
      ).toBe(true);
      expect(
        text(project, 'base_unit.tscn'),
        'precondition: the in-project script was saved as an ext_resource',
      ).toContain('inside.gd');

      const escape = await handleSetNodeProperties(runner, {
        projectPath: project,
        scenePath: 'base_unit.tscn',
        updates: [{ nodePath: 'root/Leg', property: 'script', value: 'res:///../outside.gd' }],
      });
      expect(existsSync(outsideMarker), 'the script outside the project ran').toBe(false);
      expect(wasRejected(escape), `the update must be an error; ${describeResult(escape)}`).toBe(
        true,
      );
      expect(text(project, 'base_unit.tscn')).not.toContain('outside.gd');
    },
    CASE_TIMEOUT_MS,
  );
});

describe('engine premises: headless scene saves', () => {
  itPremise(
    'R6-2: a batch that edits a base scene then adds to a derived scene does not pin the old base value',
    async () => {
      // Red when the closing save order lets derived_unit.tscn write the
      // pre-batch Leg text as an override.
      const { project } = authoredCopy();
      expect(
        text(project, 'derived_unit.tscn'),
        'precondition: the derived scene starts with no Leg text override',
      ).not.toContain('text = "leg"');

      const result = await handleBatchSceneOperations(runner, {
        projectPath: project,
        operations: [
          {
            operation: 'set_node_properties',
            scenePath: 'base_unit.tscn',
            updates: [{ nodePath: 'root/Leg', property: 'text', value: 'new' }],
          },
          {
            operation: 'add_node',
            scenePath: 'derived_unit.tscn',
            nodeType: 'Node2D',
            nodeName: 'Added',
          },
        ],
      });
      const entries = updateEntries(result, 'batch of set_node_properties then add_node');
      expect(entries.map((entry) => entry.success)).toEqual([true, true]);
      expect(text(project, 'base_unit.tscn'), 'precondition: base saved the new text').toContain(
        'text = "new"',
      );
      expect(text(project, 'derived_unit.tscn'), 'precondition: derived saved the add').toContain(
        'name="Added"',
      );

      expect(
        text(project, 'derived_unit.tscn'),
        'derived_unit.tscn pinned the old base value as an override',
      ).not.toContain('text = "leg"');
    },
    CASE_TIMEOUT_MS,
  );

  itPremise(
    'R6-3: assigning a scene path to a Node-typed export is an error, not a silent no-op',
    async () => {
      // Red when set() stores nothing and the update still reports success.
      const { project } = authoredCopy();
      writeFileSync(
        join(project, 'target_holder.gd'),
        'extends Node\n\n@export var target: Node\n@export var note: String = ""\n',
      );
      writeFileSync(
        join(project, 'target_holder.tscn'),
        [
          '[gd_scene load_steps=2 format=3]',
          '',
          '[ext_resource type="Script" path="res://target_holder.gd" id="1_th"]',
          '',
          '[node name="TargetHolder" type="Node"]',
          'script = ExtResource("1_th")',
          '',
        ].join('\n'),
      );

      const control = await handleSetNodeProperties(runner, {
        projectPath: project,
        scenePath: 'target_holder.tscn',
        updates: [{ nodePath: 'root', property: 'note', value: 'hello' }],
      });
      expect(updateEntries(control, 'String export on the holder script')[0]?.success).toBe(true);
      expect(
        text(project, 'target_holder.tscn'),
        'precondition: the script is attached and the control value saved',
      ).toContain('note = "hello"');
      const before = text(project, 'target_holder.tscn');

      const claim = await handleSetNodeProperties(runner, {
        projectPath: project,
        scenePath: 'target_holder.tscn',
        updates: [{ nodePath: 'root', property: 'target', value: 'res://base_unit.tscn' }],
      });
      expect(
        wasRejected(claim),
        `the update reported success but stores nothing; ${describeResult(claim)}`,
      ).toBe(true);
      expect(text(project, 'target_holder.tscn')).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  itPremise(
    'R6-4: a custom Resource class export accepts a .tres of that class and still refuses a plain Resource',
    async () => {
      // Red when _check_resource_hint_class knows native classes only.
      const { project } = authoredCopy();
      writeFileSync(
        join(project, 'enemy_stats.gd'),
        'class_name EnemyStats\nextends Resource\n\n@export var hp: int = 1\n',
      );
      writeFileSync(
        join(project, 'goblin.tres'),
        [
          '[gd_resource type="Resource" script_class="EnemyStats" load_steps=2 format=3]',
          '',
          '[ext_resource type="Script" path="res://enemy_stats.gd" id="1_es"]',
          '',
          '[resource]',
          'script = ExtResource("1_es")',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(project, 'plain.tres'),
        '[gd_resource type="Resource" format=3]\n\n[resource]\n',
      );
      writeFileSync(
        join(project, 'stats_holder.gd'),
        'extends Node\n\n@export var stats: EnemyStats\n',
      );
      writeFileSync(
        join(project, 'stats_holder.tscn'),
        [
          '[gd_scene load_steps=2 format=3]',
          '',
          '[ext_resource type="Script" path="res://stats_holder.gd" id="1_sh"]',
          '',
          '[node name="StatsHolder" type="Node"]',
          'script = ExtResource("1_sh")',
          '',
        ].join('\n'),
      );
      // class_name is only known to the engine after a scan builds the class cache.
      await runner.importAssets(project);
      const cacheFile = join(project, '.godot', 'global_script_class_cache.cfg');
      expect(existsSync(cacheFile), 'precondition: the import wrote the class cache').toBe(true);
      expect(
        readFileSync(cacheFile, 'utf8'),
        'precondition: EnemyStats is a registered global class',
      ).toContain('EnemyStats');

      const plain = await handleSetNodeProperties(runner, {
        projectPath: project,
        scenePath: 'stats_holder.tscn',
        updates: [{ nodePath: 'root', property: 'stats', value: 'res://plain.tres' }],
      });
      expect(
        wasRejected(plain),
        `precondition: a plain Resource must be refused; ${describeResult(plain)}`,
      ).toBe(true);

      const goblin = await handleSetNodeProperties(runner, {
        projectPath: project,
        scenePath: 'stats_holder.tscn',
        updates: [{ nodePath: 'root', property: 'stats', value: 'res://goblin.tres' }],
      });
      expect(
        wasRejected(goblin),
        `a correct EnemyStats .tres was refused; ${describeResult(goblin)}`,
      ).toBe(false);
      expect(text(project, 'stats_holder.tscn')).toContain('goblin.tres');
    },
    CASE_TIMEOUT_MS,
  );

  itPremise(
    'R6-5: a batch item whose script cannot be instantiated reports its own error and keeps the payload',
    async () => {
      // Red when script.new() raising inside add_node aborts the whole batch
      // with no results after an earlier save already landed.
      const { project } = authoredCopy();
      writeFileSync(join(project, 'bad_init.gd'), 'extends Node\n\nfunc _init(hp):\n\tpass\n');

      const result = await handleBatchSceneOperations(runner, {
        projectPath: project,
        operations: [
          { operation: 'add_node', scenePath: 'base_unit.tscn', nodeType: 'Node2D', nodeName: 'A' },
          { operation: 'save', scenePath: 'base_unit.tscn' },
          {
            operation: 'add_node',
            scenePath: 'base_unit.tscn',
            nodeType: 'bad_init.gd',
            nodeName: 'B',
          },
        ],
      });
      expect(
        text(project, 'base_unit.tscn'),
        'precondition: the first two items ran and A is on disk',
      ).toContain('name="A"');

      expect(
        result.ok,
        `the batch returned no payload after a save landed; ${describeResult(result)}`,
      ).toBe(true);
      const entries = updateEntries(result, 'batch with a failing last item') as Array<
        UpdateEntry & { operation?: string }
      >;
      expect(entries).toHaveLength(3);
      expect(entries[0]?.success).toBe(true);
      expect(entries[1]?.success).toBe(true);
      expect(typeof entries[2]?.error).toBe('string');
      const nodeAs = text(project, 'base_unit.tscn').match(/name="A"/g) ?? [];
      expect(nodeAs).toHaveLength(1);
    },
    CASE_TIMEOUT_MS,
  );

  itPremise(
    'R6-12: connect_signal from a node inside an instanced child saves the connection',
    async () => {
      // Red when connect_signal never claims the instanced ancestors, so the
      // saved scene has no [connection] and the read-back fails.
      const { project } = authoredCopy();
      writeFileSync(
        join(project, 'conn_host.gd'),
        'extends Node2D\n\nfunc on_changed() -> void:\n\tpass\n',
      );
      writeFileSync(
        join(project, 'conn_host.tscn'),
        [
          '[gd_scene load_steps=3 format=3]',
          '',
          '[ext_resource type="Script" path="res://conn_host.gd" id="1_ch"]',
          '[ext_resource type="PackedScene" path="res://base_unit.tscn" id="2_bu"]',
          '',
          '[node name="ConnHost" type="Node2D"]',
          'script = ExtResource("1_ch")',
          '',
          '[node name="Unit" parent="." instance=ExtResource("2_bu")]',
          '',
        ].join('\n'),
      );

      const control = await handleConnectSignal(runner, {
        projectPath: project,
        scenePath: 'conn_host.tscn',
        nodePath: 'root/Unit',
        signal: 'visibility_changed',
        targetNodePath: 'root',
        method: 'on_changed',
      });
      payloadOf(control, 'connect_signal from the instance root');
      expect(
        text(project, 'conn_host.tscn'),
        'precondition: a connection from the instance root was saved',
      ).toMatch(/^\[connection /m);

      const claim = await handleConnectSignal(runner, {
        projectPath: project,
        scenePath: 'conn_host.tscn',
        nodePath: 'root/Unit/Leg',
        signal: 'visibility_changed',
        targetNodePath: 'root',
        method: 'on_changed',
      });
      expect(claim.ok, `connect_signal failed; ${describeResult(claim)}`).toBe(true);
      expect(text(project, 'conn_host.tscn')).toMatch(/^\[connection [^\n]*Unit\/Leg/m);
    },
    CASE_TIMEOUT_MS,
  );

  itPremise(
    'R8-2: a stale ext_resource path with a valid uid is not reported as lost content',
    async () => {
      // Red when the loss guard compares references by path only and the
      // engine re-resolves the uid to the current path on save.
      const { project } = authoredCopy();
      writeFileSync(
        join(project, 'stale_host.tscn'),
        [
          '[gd_scene load_steps=2 format=3]',
          '',
          '[ext_resource type="PackedScene" uid="uid://76owar7af2bj" path="res://old/base_unit.tscn" id="1_bu"]',
          '',
          '[node name="StaleHost" type="Node2D"]',
          '',
          '[node name="Unit" parent="." instance=ExtResource("1_bu")]',
          '',
        ].join('\n'),
      );
      // The uid cache has to know base_unit.tscn for the uid to resolve.
      await runner.importAssets(project);

      const result = await handleAddNode(runner, {
        projectPath: project,
        scenePath: 'stale_host.tscn',
        nodeType: 'Node2D',
        nodeName: 'Extra',
      });
      const payload = payloadOf(result, 'add_node on the stale-path scene');
      const saved = text(project, 'stale_host.tscn');
      expect(saved, 'precondition: the add landed in the saved scene').toContain('name="Extra"');

      const warnings = (payload.warnings as string[] | undefined) ?? [];
      const lossWarnings = warnings.filter((line) => /lost|no longer|did not ask/i.test(line));
      expect(
        lossWarnings,
        `canonicalization was reported as loss; saved scene header lines: ${saved
          .split('\n')
          .filter((line) => line.startsWith('[ext_resource'))
          .join(' | ')}`,
      ).toEqual([]);
      const backups = join(project, '.mcp', 'godot-runtime', 'scene-backups');
      expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  itPremise(
    'R4-6: a section name with a blank, as the engine writes it, scans as canonical',
    async () => {
      // Red when CANONICAL_HEADER_REGEX refuses "[My Addon]".
      const { project } = authoredCopy();
      writeFileSync(
        join(project, 'saver.gd'),
        [
          'extends Node',
          '',
          'func _init() -> void:',
          '\tProjectSettings.set_setting("My Addon/enabled", true)',
          '\tProjectSettings.set_initial_value("My Addon/enabled", false)',
          '\tProjectSettings.save()',
          '',
        ].join('\n'),
      );
      const projectFile = join(project, 'project.godot');
      const original = readFileSync(projectFile, 'utf8');
      const withSaver = original.replace(
        'GameState="*res://game_state.gd"',
        'GameState="*res://game_state.gd"\nSaver="*res://saver.gd"',
      );
      expect(withSaver, 'precondition: the Saver autoload line was inserted').not.toBe(original);
      writeFileSync(projectFile, withSaver, 'utf8');

      // Any headless operation loads the autoload, whose _init saves the setting.
      const tree = await handleGetSceneTree(runner, {
        projectPath: project,
        scenePath: 'player.tscn',
      });
      payloadOf(tree, 'get_scene_tree on player.tscn');
      const saved = readFileSync(projectFile, 'utf8');
      expect(saved, 'precondition: the engine wrote a [My Addon] section to project.godot').toMatch(
        /^\[My Addon\]/m,
      );

      const scan = scanProjectFile(saved);
      const blamed = scan.nonCanonical.filter((entry) => entry.text.includes('My Addon'));
      expect(blamed, JSON.stringify(blamed)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  itPremise(
    'R6-10a: run_script returning an infinite float still returns a parsed payload',
    async (ctx) => {
      // Red when JSON.stringify writes inf and the frame is not valid JSON.
      const project = runtimeCopy('main.tscn');
      await runProjectOrSkip(runner, ctx, project);

      const control = await handleRunScript(runner, {
        script:
          'extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n\treturn 1.5\n',
      });
      expect(payloadOf(control, 'run_script returning 1.5').result).toBe(1.5);

      const claim = await handleRunScript(runner, {
        script:
          'extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n\tvar zero := 0.0\n\treturn 1.0 / zero\n',
      });
      expect(claim.ok, `an infinite float broke the response; ${describeResult(claim)}`).toBe(true);
    },
    RUNTIME_CASE_TIMEOUT_MS,
  );

  itPremise(
    'R6-10b: get_node_properties on a script variable holding INF still returns a parsed payload',
    async () => {
      // Red when a non-finite float in a read-back makes the result line invalid JSON.
      const { project } = authoredCopy();
      writeFileSync(join(project, 'inf_holder.gd'), 'extends Node\n\n@export var x := INF\n');
      writeFileSync(
        join(project, 'inf_holder.tscn'),
        [
          '[gd_scene load_steps=2 format=3]',
          '',
          '[ext_resource type="Script" path="res://inf_holder.gd" id="1_ih"]',
          '',
          '[node name="InfHolder" type="Node"]',
          'script = ExtResource("1_ih")',
          '',
        ].join('\n'),
      );

      const control = await handleGetNodeProperties(runner, {
        projectPath: project,
        scenePath: 'player.tscn',
        nodes: [{ nodePath: 'root' }],
      });
      payloadOf(control, 'get_node_properties on player.tscn');

      const claim = await handleGetNodeProperties(runner, {
        projectPath: project,
        scenePath: 'inf_holder.tscn',
        nodes: [{ nodePath: 'root' }],
      });
      expect(claim.ok, `an INF read-back broke the response; ${describeResult(claim)}`).toBe(true);
      const entries = payloadOf(claim, 'get_node_properties on inf_holder.tscn')
        .results as UpdateEntry[];
      expect(entries[0]?.error).toBeUndefined();
    },
    CASE_TIMEOUT_MS,
  );
});

describe('engine premises: bridge and runtime', () => {
  itPremise(
    'R6-6: run_script whose execute takes no parameter answers with an error quickly',
    async (ctx) => {
      // Red when the bridge raises in the handler and never answers, so the
      // client sits out the command timeout.
      const project = runtimeCopy('main.tscn');
      await runProjectOrSkip(runner, ctx, project);

      const control = await bridgeScript(['return 7']);
      expect(control.result, 'precondition: a well-formed script runs over the bridge').toBe(7);

      const source = 'extends RefCounted\nfunc execute():\n\treturn 1\n';
      const started = Date.now();
      let outcome: string;
      try {
        outcome = await runner.sendCommand(
          'run_script',
          { source },
          SCRIPT_ERROR_CLIENT_TIMEOUT_MS,
        );
      } catch (error) {
        outcome = `client error: ${error instanceof Error ? error.message : String(error)}`;
      }
      const elapsed = Date.now() - started;
      expect(elapsed, `no answer within the budget; outcome=${outcome}`).toBeLessThan(
        SCRIPT_ERROR_BUDGET_MS,
      );
      const parsed = JSON.parse(outcome) as { error?: string };
      expect(parsed.error, `outcome=${outcome}`).toMatch(/execute|argument|signature|parameter/i);
    },
    RUNTIME_CASE_TIMEOUT_MS,
  );

  itPremise(
    'R6-7: an unauthenticated connection to the bridge port does not cancel a running input batch',
    async (ctx) => {
      // Red when the cancellation generation moves at accept: the batch loses
      // the settled action and reports success false with the rest skipped.
      const project = runtimeCopy(INPUT_PROBE_SCENE);
      await runProjectOrSkip(runner, ctx, project);
      const port = runner.activeBridgePort;
      expect(port, 'precondition: the session has a bridge port').not.toBeNull();

      const batch = simulate([
        { type: 'wait', ms: BATCH_WAIT_MS },
        { type: 'wait', frames: 1 },
        { type: 'click_element', element: `${PROBE_ROOT}/PlainBtn` },
      ]);
      await sleep(CONNECT_DELAY_MS);
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ port: port!, host: LOCALHOST }, () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
      });
      const payload = await batch;

      expect(payload.results, 'precondition: one entry per requested action').toHaveLength(3);
      expect(payload.results[0]?.type).toBe('wait');
      expect(
        payload.success,
        `the batch was cancelled by a bare connect; results=${JSON.stringify(payload.results)}`,
      ).toBe(true);
      expect(payload.results.some((entry) => entry.skipped === true)).toBe(false);
    },
    RUNTIME_CASE_TIMEOUT_MS,
  );

  itPremise(
    'R6-8: click_element on a Control declaring signal pressed(index) reports no bridge-caused errors',
    async (ctx) => {
      // Red when the observer is built for the table's arity regardless of the
      // signal's declared arity, so the emit logs a call-arity error.
      const project = runtimeCopy(SIGNAL_PROBE_SCENE, {
        'sig_probe.gd': [
          'extends Control',
          '',
          'signal pressed(index)',
          '',
          'var clicks := 0',
          '',
          'func _gui_input(event: InputEvent) -> void:',
          '\tif event is InputEventMouseButton and event.pressed:',
          '\t\tclicks += 1',
          '\t\tpressed.emit(1)',
          '',
        ].join('\n'),
        [SIGNAL_PROBE_SCENE]: [
          '[gd_scene load_steps=2 format=3]',
          '',
          '[ext_resource type="Script" path="res://sig_probe.gd" id="1_sp"]',
          '',
          '[node name="SigProbe" type="Control"]',
          'offset_right = 200.0',
          'offset_bottom = 100.0',
          'script = ExtResource("1_sp")',
          '',
        ].join('\n'),
      });
      await runProjectOrSkip(runner, ctx, project);

      const payload = await simulate([{ type: 'click_element', element: SIGNAL_PROBE_ROOT }]);
      const entry = payload.results[0];
      expect(entry?.ok, `precondition: the click ran; entry=${JSON.stringify(entry)}`).toBe(true);
      const clicks = await bridgeScript([`return scene_tree.root.get_node("SigProbe").clicks`]);
      expect(clicks.result, 'precondition: the Control received the click').toBe(1);

      expect(
        entry?.errors,
        `the bridge blamed the game for its own observer; entry=${JSON.stringify(entry)}`,
      ).toBeUndefined();
    },
    RUNTIME_CASE_TIMEOUT_MS,
  );

  itPremise(
    'R5-3: get_ui_elements with an ancestor-of-Control filter returns what no filter returns',
    async (ctx) => {
      // Red when only Control and its subclasses are accepted as a filter.
      const project = runtimeCopy(INPUT_PROBE_SCENE);
      await runProjectOrSkip(runner, ctx, project);

      const all = payloadOf(await handleGetUiElements(runner, {}), 'get_ui_elements, no filter');
      const allPaths = (all.elements as Array<{ path: string }>).map((e) => e.path).sort();
      expect(allPaths, 'precondition: the probe scene lists its buttons').toContain(
        `${PROBE_ROOT}/PlainBtn`,
      );

      const ancestor = await handleGetUiElements(runner, { filter: 'CanvasItem' });
      expect(ancestor.ok, `filter CanvasItem was refused; ${describeResult(ancestor)}`).toBe(true);
      const ancestorPaths = (
        payloadOf(ancestor, 'filter CanvasItem').elements as Array<{
          path: string;
        }>
      )
        .map((e) => e.path)
        .sort();
      expect(ancestorPaths).toEqual(allPaths);

      const unrelated = await handleGetUiElements(runner, { filter: 'Node2D' });
      expect(unrelated.ok, 'a class that is not a Control stays an error').toBe(false);
    },
    RUNTIME_CASE_TIMEOUT_MS,
  );

  itPremise(
    'E5: run_script returning a Node outside the tree adds no engine error line',
    async (ctx) => {
      // Red when serializing a detached node calls get_path() and the engine
      // prints an error that get_debug_output then shows.
      const project = runtimeCopy('main.tscn');
      await runProjectOrSkip(runner, ctx, project);
      await sleep(STDERR_SETTLE_MS);
      const errorsBefore = (
        payloadOf(handleGetDebugOutput(runner, { limit: DEBUG_LINE_LIMIT }), 'get_debug_output')
          .errors as string[]
      ).length;

      const outcome = await bridgeScript([
        'var detached := Node.new()',
        'detached.name = "DetachedProbe"',
        'return detached',
      ]);
      expect(
        outcome.error,
        `precondition: the script ran; outcome=${JSON.stringify(outcome)}`,
      ).toBeUndefined();
      await sleep(STDERR_SETTLE_MS);

      const errorsAfter = payloadOf(
        handleGetDebugOutput(runner, { limit: DEBUG_LINE_LIMIT }),
        'get_debug_output',
      ).errors as string[];
      expect(errorsAfter.slice(errorsBefore)).toEqual([]);
    },
    RUNTIME_CASE_TIMEOUT_MS,
  );

  itPremise(
    'R6-13: a default key tap returns within its budget while Engine.time_scale is 0',
    async (ctx) => {
      // Red when the tap awaits physics_frame, which does not arrive at time_scale 0.
      const project = runtimeCopy(INPUT_PROBE_SCENE);
      await runProjectOrSkip(runner, ctx, project);

      const normal = await simulate([{ type: 'key', key: 'W' }]);
      expect(normal.success, 'precondition: a tap works at normal speed').toBe(true);

      const frozen = await bridgeScript(['Engine.time_scale = 0.0', 'return Engine.time_scale']);
      expect(frozen.result, 'precondition: time_scale is 0 in the game').toBe(0);
      const started = Date.now();
      try {
        const payload = await simulate([{ type: 'key', key: 'W' }]);
        expect(payload.success).toBe(true);
        expect(Date.now() - started).toBeLessThan(TIME_SCALE_TAP_BUDGET_MS);
      } finally {
        await bridgeScript(['Engine.time_scale = 1.0', 'return 1']).catch(() => undefined);
      }
    },
    RUNTIME_CASE_TIMEOUT_MS,
  );
});
