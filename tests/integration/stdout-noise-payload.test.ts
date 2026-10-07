/**
 * Integration test: a headless operation's payload survives stdout noise.
 *
 * Regression (issue 68): the engine banner, the operation's one-line JSON
 * payload and any print() from an autoload share stdout. A noise line that
 * contained a bracket or a brace made the payload extraction pick the wrong
 * span and the call failed with "GDScript returned invalid JSON", on some
 * projects and not others. Here the temp project copy gains an autoload whose
 * _init prints a bracketed tag, a printed dictionary and a JSON-looking line;
 * a real set_node_properties call must still return its own payload.
 *
 * The autoload is added to the temp copy only; the committed fixture is never
 * touched.
 *
 * Requires GODOT_PATH. Skipped locally when it is unset; CI sets it in the
 * godot-integration job.
 */

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
// The probe is synchronous and bounds itself; the test budget only has to sit
// above it so the probe's own timeout is the one that reports.
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
  } catch {
    // best-effort cleanup
  }
});

describe('headless operation payload with a noisy autoload', () => {
  itGodot(
    'the autoload really prints bracketed and JSON-object lines on headless stdout',
    () => {
      // Guards the test below against passing vacuously: boots the same temp
      // project headless (autoloads initialize) and reads the raw stdout the
      // parser would otherwise have to survive.
      const probe = spawnSync(
        process.env.GODOT_PATH as string,
        ['--headless', '--path', tmpProject, '--quit'],
        {
          encoding: 'utf8',
          timeout: NOISE_PROBE_TIMEOUT_MS,
          // Not catchable, so a wedged engine cannot outlive the timeout.
          killSignal: 'SIGKILL',
          maxBuffer: NOISE_PROBE_MAX_BUFFER_BYTES,
        },
      );
      // A spawn failure or a timeout reports here, by name, instead of as a
      // confusing mismatch on empty stdout below.
      expect(probe.error).toBeUndefined();
      // The two string prints are literal text the engine passes through.
      expect(probe.stdout).toContain('[Audio] ready');
      expect(probe.stdout).toContain('{"looks_like": ["a payload"]}');
      // How the engine renders a printed Dictionary varies by version, so the
      // line is found by its key and only asked to carry an opening brace.
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
/** A result line no real operation emits; a payload carrying it came from the autoload. */
const FORGED_MARKER = 'forged-by-exit-tree';
const FORGED_PAYLOAD = JSON.stringify({ results: [{ nodePath: FORGED_MARKER, success: true }] });
/** The same forgery printed before the operation is dispatched. */
const EARLY_FORGED_MARKER = 'forged-by-init';
const EARLY_FORGED_PAYLOAD = JSON.stringify({
  results: [{ nodePath: EARLY_FORGED_MARKER, success: true }],
});
const forgingPrint = (payload: string): string =>
  `\tprint("${OPERATION_RESULT_SENTINEL}${payload.replace(/"/g, '\\"')}")`;
// One forged line on each side of the real one, so neither "the last sentinel
// line" nor "the first" is the operation's.
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
    } catch {
      // best-effort cleanup
    }
  });

  itGodot(
    'the autoload really prints the forged line on headless stdout',
    () => {
      // Guards the test below against passing vacuously: if the engine never
      // runs the autoload's _exit_tree, nothing was forged and the next test
      // proves nothing.
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
      // If this fails with a schema error or a tree without "Main", a forged
      // line was taken for the result: src is wrong, not this test.
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
