/** The temp copy gains an autoload whose _init prints a bracketed tag, a printed dictionary and a JSON-looking line; the payload extraction must still pick the operation's own result. */

import { describe, beforeAll, afterAll, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { appendFileSync, cpSync, writeFileSync } from 'fs';
import { removeTmpDir } from '../helpers/tmp.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
import { hasError, unwrap } from '../helpers/assertions.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';
import { handleGetSceneTree, handleSetNodeProperties } from '../../src/tools/node-tools.js';
import { OPERATION_RESULT_SENTINEL } from '../../src/utils/output-parsing.js';
import { expectMatchesOutputSchema } from '../helpers/schema-assert.js';

const NOISY_AUTOLOAD_NAME = 'NoisyAutoload';
const NOISY_AUTOLOAD_FILE = 'noisy_autoload.gd';
const NOISY_AUTOLOAD_SOURCE = [
  'extends Node',
  '',
  'func _init() -> void:',
  '\tprint("[Audio] ready")',
  '\tprint({"unrelated": true, "list": [1, 2]})',
  '\tprint("{\\"looks_like\\": [\\"a payload\\"]}")',
  '',
].join('\n');
const SET_TEXT_TIMEOUT_MS = 60000;
const NOISE_PROBE_TIMEOUT_MS = 30000;
// The probe bounds itself; the test budget sits above it so the probe's own timeout reports.
const NOISE_PROBE_TEST_MARGIN_MS = 15000;
const NOISE_PROBE_TEST_TIMEOUT_MS = NOISE_PROBE_TIMEOUT_MS + NOISE_PROBE_TEST_MARGIN_MS;
const NOISE_PROBE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

let runner: GodotRunner;
let tmpProject: string;

beforeAll(async () => {
  runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
  await runner.detectGodotPath();
  tmpProject = join(tmpdir(), `godot-mcp-test-${randomBytes(6).toString('hex')}`);
  cpSync(fixtureProjectPath, tmpProject, { recursive: true });
  writeFileSync(join(tmpProject, NOISY_AUTOLOAD_FILE), NOISY_AUTOLOAD_SOURCE);
  appendFileSync(
    join(tmpProject, 'project.godot'),
    `\n[autoload]\n\n${NOISY_AUTOLOAD_NAME}="*res://${NOISY_AUTOLOAD_FILE}"\n`,
  );
});

afterAll(() => {
  try {
    removeTmpDir(tmpProject);
  } catch {}
});

describe('headless operation payload with a noisy autoload', () => {
  itGodot(
    'the autoload really prints bracketed and JSON-object lines on headless stdout',
    () => {
      // Guards against passing vacuously: boots the same project headless and reads the raw stdout the parser has to survive.
      const probe = spawnSync(
        process.env.GODOT_PATH as string,
        ['--headless', '--path', tmpProject, '--quit'],
        {
          encoding: 'utf8',
          timeout: NOISE_PROBE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: NOISE_PROBE_MAX_BUFFER_BYTES,
        },
      );
      // A spawn failure or timeout reports here by name, not as a mismatch on empty stdout.
      expect(probe.error).toBeUndefined();
      expect(probe.stdout).toContain('[Audio] ready');
      expect(probe.stdout).toContain('{"looks_like": ["a payload"]}');
      // A printed Dictionary renders differently by version, so the line is found by its key and only needs an opening brace.
      const dictionaryLine = probe.stdout.split('\n').find((line) => line.includes('unrelated'));
      expect(dictionaryLine).toBeDefined();
      expect(dictionaryLine).toContain('{');
    },
    NOISE_PROBE_TEST_TIMEOUT_MS,
  );

  itGodot(
    'set_node_properties returns its own payload despite bracketed autoload output',
    async () => {
      const result = await handleSetNodeProperties(runner, {
        projectPath: tmpProject,
        scenePath: 'main.tscn',
        updates: [{ nodePath: 'root/Label', property: 'text', value: 'noise survived' }],
      });
      expect(hasError(result)).toBe(false);
      const payload = unwrap(result).structuredContent as {
        results: Array<{ success?: boolean; nodePath?: string }>;
      };
      expect(payload.results).toHaveLength(1);
      expect(payload.results[0]?.success).toBe(true);
      expect(payload.results[0]?.nodePath).toBe('root/Label');
    },
    SET_TEXT_TIMEOUT_MS,
  );
});

const FORGER_AUTOLOAD_NAME = 'ForgerAutoload';
const FORGER_AUTOLOAD_FILE = 'forger_autoload.gd';
const FORGED_MARKER = 'forged-by-exit-tree';
const FORGED_PAYLOAD = JSON.stringify({ results: [{ nodePath: FORGED_MARKER, success: true }] });
const EARLY_FORGED_MARKER = 'forged-by-init';
const EARLY_FORGED_PAYLOAD = JSON.stringify({
  results: [{ nodePath: EARLY_FORGED_MARKER, success: true }],
});
const forgingPrint = (payload: string): string =>
  `\tprint("${OPERATION_RESULT_SENTINEL}${payload.replace(/"/g, '\\"')}")`;
// One forged line on each side of the real one, so neither the first nor the last sentinel line is the operation's.
const FORGER_AUTOLOAD_SOURCE = [
  'extends Node',
  '',
  'func _init() -> void:',
  forgingPrint(EARLY_FORGED_PAYLOAD),
  '',
  'func _exit_tree() -> void:',
  forgingPrint(FORGED_PAYLOAD),
  '',
].join('\n');

describe('headless operation payload with an autoload that prints a forged result line at exit', () => {
  let forgedProject: string;

  beforeAll(() => {
    forgedProject = join(tmpdir(), `godot-mcp-forged-${randomBytes(6).toString('hex')}`);
    cpSync(fixtureProjectPath, forgedProject, { recursive: true });
    writeFileSync(join(forgedProject, FORGER_AUTOLOAD_FILE), FORGER_AUTOLOAD_SOURCE);
    appendFileSync(
      join(forgedProject, 'project.godot'),
      `\n[autoload]\n\n${FORGER_AUTOLOAD_NAME}="*res://${FORGER_AUTOLOAD_FILE}"\n`,
    );
  });

  afterAll(() => {
    try {
      removeTmpDir(forgedProject);
    } catch {}
  });

  itGodot(
    'the autoload really prints the forged line on headless stdout',
    () => {
      // Guards against passing vacuously: if the engine never runs _exit_tree, nothing was forged.
      const probe = spawnSync(
        process.env.GODOT_PATH as string,
        ['--headless', '--path', forgedProject, '--quit'],
        {
          encoding: 'utf8',
          timeout: NOISE_PROBE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: NOISE_PROBE_MAX_BUFFER_BYTES,
        },
      );
      expect(probe.error).toBeUndefined();
      expect(probe.stdout).toContain(FORGED_MARKER);
      expect(probe.stdout).toContain(EARLY_FORGED_MARKER);
    },
    NOISE_PROBE_TEST_TIMEOUT_MS,
  );

  itGodot(
    'get_scene_tree returns the scene tree, not the line the autoload printed at exit',
    async () => {
      // A schema error or a tree without "Main" here means a forged line was taken for the result.
      const result = await handleGetSceneTree(runner, {
        projectPath: forgedProject,
        scenePath: 'main.tscn',
      });
      const tree = expectMatchesOutputSchema('get_scene_tree', result);
      expect(tree.name).toBe('Main');
      expect(JSON.stringify(tree)).not.toContain(FORGED_MARKER);
      expect(JSON.stringify(tree)).not.toContain(EARLY_FORGED_MARKER);
    },
    SET_TEXT_TIMEOUT_MS,
  );
});
