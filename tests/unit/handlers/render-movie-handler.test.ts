import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { dirname, extname, join, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import {
  MOVIE_RUNTIME_WARNINGS_MAX,
  MOVIE_TIMEOUT_BASE_MS,
  MOVIE_TIMEOUT_PER_FRAME_MS,
  buildMovieArgs,
  computeMovieTimeoutMs,
  createRenderMovieHandler,
  measuredFramePositions,
  pickEvenly,
  renderToolDefinitions,
} from '../../../src/tools/render-tools.js';
import { moviesDir } from '../../../src/utils/artifact-paths.js';
import { BridgeRegistryUnreadableError } from '../../../src/utils/bridge-manager.js';
import { normalizeProjectKey } from '../../../src/utils/mcp-context.js';
import type { GodotRunner } from '../../../src/utils/godot-runner.js';
import type { MovieProcessResult, RunMovieProcess } from '../../../src/utils/movie-process.js';
import { decodePng } from '../../../src/utils/png-decoder.js';
import { createFakeRunner, type FakeRunnerOptions } from '../../helpers/fake-runner.js';
import { makeContext } from '../../helpers/runtime-fakes.js';
import { encodePng, invalidPng, solidRgba } from '../../helpers/png-fixtures.js';
import { useTmpDirs } from '../../helpers/tmp.js';
import { expectErrorMatching, hasError, unwrap, errorText } from '../../helpers/assertions.js';

const tmp = useTmpDirs();

const FRAME_SIZE = 64;
const SMALL_FRAME_SIZE = 8;
const BLOCK_SIZE = 16;
const BLOCK_STEP_PX = 4;
const BLOCK_Y = 24;
const BLOCK_X_WRAP = 48;
const FRAME_INDEX_DIGITS = 8;
const OPAQUE = 255;
const DARK: readonly [number, number, number, number] = [16, 16, 16, OPAQUE];
const RED: readonly [number, number, number, number] = [OPAQUE, 0, 0, OPAQUE];
const TEST_FRAMES = 12;
const LAST_TEST_FRAME = TEST_FRAMES - 1;
const INVALID_SAMPLED_FRAME = 8;
const FRAMES_ABOVE_LISTING_CAP = 61;
const STDERR_LINES = 40;
const RUNTIME_ERROR_FLOOD_EXTRA = 70;
const OTHER_SESSION_PID = 4242;
const DEFAULT_FRAMES_ARG = '30';
const DEFAULT_FPS_ARG = '30';
const MAX_INLINE_WIDTH = 960;
const MAX_INLINE_HEIGHT = 540;

const outputValidator = new Ajv({ strict: false }).compile(
  renderToolDefinitions[0].outputSchema as object,
);

interface SampleStats {
  width: number;
  height: number;
  chromatic: number;
  dominant: number;
  distinct: number;
  likelyBlank: boolean;
}

interface Payload {
  warnings?: string[];
  mode: string;
  projectPath: string;
  scene?: string;
  fps: number;
  framesRequested: number;
  statsAvailable: boolean;
  statsNote?: string;
  frameCount?: number;
  measuredFrames?: number;
  likelyBlank?: boolean | null;
  motion?: number | null;
  anyMotion?: boolean | null;
  motionPairs?: Array<{ from: number; to: number; difference: number | null }>;
  samples?: Array<{ index: number; path?: string; stats: SampleStats | null }>;
  inlineFrames?: Array<{ index: number; width: number; height: number }>;
  framesKept?: boolean;
  directory?: string;
  framePattern?: string;
  framePaths?: string[];
  audioPath?: string;
  format?: string;
  path?: string;
  byteSize?: number;
}

// --- Frame builders ---

function frameRgba(
  blockX: number | null,
  background: readonly [number, number, number, number] = DARK,
): Uint8Array {
  const data = solidRgba(FRAME_SIZE, FRAME_SIZE, background);
  if (blockX === null) return data;
  for (let y = BLOCK_Y; y < BLOCK_Y + BLOCK_SIZE; y++) {
    for (let x = blockX; x < blockX + BLOCK_SIZE; x++) {
      data.set(RED, (y * FRAME_SIZE + x) * RED.length);
    }
  }
  return data;
}

/** A dark frame with a red block whose x offset grows with the frame index. */
function movingFrame(index: number): Buffer {
  return encodePng(FRAME_SIZE, FRAME_SIZE, frameRgba((index * BLOCK_STEP_PX) % BLOCK_X_WRAP));
}

function blankFrame(): Buffer {
  return encodePng(FRAME_SIZE, FRAME_SIZE, frameRgba(null));
}

function stillFrame(): Buffer {
  return encodePng(FRAME_SIZE, FRAME_SIZE, frameRgba(0));
}

function tinyFrame(): Buffer {
  return encodePng(
    SMALL_FRAME_SIZE,
    SMALL_FRAME_SIZE,
    solidRgba(SMALL_FRAME_SIZE, SMALL_FRAME_SIZE, RED),
  );
}

// --- Stub process runner ---

interface StubRunInfo {
  dir: string;
  outputPath: string;
  args: string[];
}

interface StubConfig {
  /** Frames to write; default is the --quit-after value. */
  frameCount?: number;
  makeFrame?: (index: number) => Buffer;
  writeAudio?: boolean;
  writeNothing?: boolean;
  videoBytes?: Buffer;
  result?: Partial<MovieProcessResult>;
  onRun?: (info: StubRunInfo) => void;
}

interface StubCall {
  godotPath: string;
  args: string[];
  timeoutMs: number;
}

function createStub(config: StubConfig = {}): { runProcess: RunMovieProcess; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const runProcess: RunMovieProcess = async (godotPath, args, timeoutMs) => {
    calls.push({ godotPath, args, timeoutMs });
    const outputPath = args[args.indexOf('--write-movie') + 1]!;
    const dir = dirname(outputPath);
    config.onRun?.({ dir, outputPath, args });
    if (config.writeNothing !== true) {
      if (extname(outputPath) === '.png') {
        const quitAfter = Number(args[args.indexOf('--quit-after') + 1]);
        const count = config.frameCount ?? quitAfter;
        const makeFrame = config.makeFrame ?? movingFrame;
        for (let i = 0; i < count; i++) {
          const name = `frame${String(i).padStart(FRAME_INDEX_DIGITS, '0')}.png`;
          writeFileSync(join(dir, name), makeFrame(i));
        }
        if (config.writeAudio !== false) writeFileSync(join(dir, 'frame.wav'), 'RIFF');
      } else {
        writeFileSync(outputPath, config.videoBytes ?? Buffer.from('video bytes'));
      }
    }
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...config.result };
  };
  return { runProcess, calls };
}

interface SetupOptions {
  runner?: FakeRunnerOptions;
  stub?: StubConfig;
  display?: boolean;
  projectGodot?: string;
}

function setup(options: SetupOptions = {}) {
  const dir = tmp.makeProject('render-movie-', options.projectGodot);
  const fake = createFakeRunner(options.runner);
  const stub = createStub(options.stub);
  const handler = createRenderMovieHandler({
    runProcess: stub.runProcess,
    displayAvailable: () => options.display ?? true,
  });
  return { dir, runner: fake.asRunner, fake, stub, handler };
}

const NO_GATE = makeContext({ disableSecurity: true });

function payloadOf(result: unknown): Payload {
  expect(hasError(result), String(errorText(result))).toBe(false);
  const payload = unwrap(result).structuredContent as Payload | undefined;
  expect(payload).toBeDefined();
  expect(outputValidator(payload), JSON.stringify(outputValidator.errors)).toBe(true);
  return payload!;
}

function imageBlocks(result: unknown): Array<{ type: string; data?: string; mimeType?: string }> {
  return unwrap(result).content.filter((c) => c.type === 'image') as Array<{
    type: string;
    data?: string;
    mimeType?: string;
  }>;
}

function movieRunDirs(projectDir: string): string[] {
  const root = moviesDir(resolve(projectDir));
  return existsSync(root) ? readdirSync(root) : [];
}

function flagValue(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1]!;
}

const EVIL_SCRIPT = 'extends Node\n\nfunc _ready():\n\tOS.execute("echo", [])\n';
const EVIL_AUTOLOAD_PROJECT = 'config_version=5\n\n[autoload]\n\nEvil="*res://evil.gd"\n';

function writeEvilAutoload(dir: string): void {
  writeFileSync(join(dir, 'evil.gd'), EVIL_SCRIPT);
}

describe('render_movie arguments', () => {
  it('check builds --path, --write-movie <run dir>/frame.png, --fixed-fps, --disable-vsync, --quit-after in order', async () => {
    const { dir, runner, stub, handler } = setup();
    const result = await handler(
      runner,
      { projectPath: dir, frames: TEST_FRAMES, fps: 24 },
      NO_GATE,
    );
    payloadOf(result);

    const args = stub.calls[0]!.args;
    const output = args[3]!;
    const moviesPrefix = moviesDir(resolve(dir)).replace(/\\/g, '/');
    expect(output.startsWith(`${moviesPrefix}/`)).toBe(true);
    expect(output.endsWith('/frame.png')).toBe(true);
    expect(output).not.toContain('\\');
    expect(args).toEqual([
      '--path',
      resolve(dir),
      '--write-movie',
      output,
      '--fixed-fps',
      '24',
      '--disable-vsync',
      '--quit-after',
      String(TEST_FRAMES),
    ]);
    expect(args).toEqual(
      buildMovieArgs({ projectPath: dir, outputPath: output, fps: 24, frames: TEST_FRAMES }),
    );
  });

  it('frames mode passes the same argument shape as check', async () => {
    const { dir, runner, stub, handler } = setup();
    payloadOf(
      await handler(runner, { projectPath: dir, mode: 'frames', frames: TEST_FRAMES }, NO_GATE),
    );
    const args = stub.calls[0]!.args;
    expect(args.filter((a) => a.startsWith('--'))).toEqual([
      '--path',
      '--write-movie',
      '--fixed-fps',
      '--disable-vsync',
      '--quit-after',
    ]);
    expect(flagValue(args, '--write-movie').endsWith('/frame.png')).toBe(true);
  });

  it('video mode writes movie.avi by default and movie.ogv on request', async () => {
    const avi = setup();
    payloadOf(await avi.handler(avi.runner, { projectPath: avi.dir, mode: 'video' }, NO_GATE));
    expect(flagValue(avi.stub.calls[0]!.args, '--write-movie').endsWith('/movie.avi')).toBe(true);

    const ogv = setup();
    payloadOf(
      await ogv.handler(
        ogv.runner,
        { projectPath: ogv.dir, mode: 'video', format: 'ogv' },
        NO_GATE,
      ),
    );
    expect(flagValue(ogv.stub.calls[0]!.args, '--write-movie').endsWith('/movie.ogv')).toBe(true);
  });

  it('appends the scene as a res:// path', async () => {
    const { dir, runner, stub, handler } = setup();
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'level.tscn'), '[gd_scene format=3]\n');
    payloadOf(await handler(runner, { projectPath: dir, scene: 'sub/level.tscn' }, NO_GATE));
    const args = stub.calls[0]!.args;
    expect(args[args.length - 1]).toBe('res://sub/level.tscn');
  });

  it('never passes --headless or --resolution', async () => {
    const { dir, runner, stub, handler } = setup();
    payloadOf(await handler(runner, { projectPath: dir }, NO_GATE));
    const args = stub.calls[0]!.args;
    expect(args).not.toContain('--headless');
    expect(args).not.toContain('--resolution');
  });

  it('uses the default frames and fps when omitted', async () => {
    const { dir, runner, stub, handler } = setup();
    payloadOf(await handler(runner, { projectPath: dir }, NO_GATE));
    const args = stub.calls[0]!.args;
    expect(flagValue(args, '--fixed-fps')).toBe(DEFAULT_FPS_ARG);
    expect(flagValue(args, '--quit-after')).toBe(DEFAULT_FRAMES_ARG);
  });

  it('passes computeMovieTimeoutMs(frames) as the timeout', async () => {
    const { dir, runner, stub, handler } = setup();
    payloadOf(await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE));
    expect(stub.calls[0]!.timeoutMs).toBe(computeMovieTimeoutMs(TEST_FRAMES));
  });

  it('computeMovieTimeoutMs is base plus per-frame', () => {
    const FRAMES = 10;
    expect(computeMovieTimeoutMs(FRAMES)).toBe(
      MOVIE_TIMEOUT_BASE_MS + FRAMES * MOVIE_TIMEOUT_PER_FRAME_MS,
    );
  });

  it.each([
    ['frames', 601],
    ['frames', 1],
    ['frames', 2.5],
    ['fps', 121],
    ['fps', 0],
    ['fps', 2.5],
    ['inlineFrames', 7],
    ['inlineFrames', -1],
    ['inlineFrames', 2.5],
  ])('rejects %s = %s', async (key, value) => {
    const { dir, runner, stub, handler } = setup();
    const result = await handler(runner, { projectPath: dir, [key]: value }, NO_GATE);
    expectErrorMatching(result, new RegExp(`Invalid ${key}: must be an integer in \\[`));
    expect(stub.calls.length).toBe(0);
  });

  it('rejects an unknown mode', async () => {
    const { dir, runner, stub, handler } = setup();
    const result = await handler(runner, { projectPath: dir, mode: 'bogus' }, NO_GATE);
    expectErrorMatching(result, /Invalid mode for render_movie: "bogus"/);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects an unknown format', async () => {
    const { dir, runner, stub, handler } = setup();
    const result = await handler(
      runner,
      { projectPath: dir, mode: 'video', format: 'mkv' },
      NO_GATE,
    );
    expectErrorMatching(result, /Invalid format for render_movie: "mkv"/);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects format outside video mode', async () => {
    const { dir, runner, stub, handler } = setup();
    const result = await handler(runner, { projectPath: dir, format: 'avi' }, NO_GATE);
    expectErrorMatching(
      result,
      /"format" applies only to mode "video" and cannot be combined with mode "check"/,
    );
    expect(stub.calls.length).toBe(0);
  });

  it('rejects inlineFrames outside check mode', async () => {
    const { dir, runner, stub, handler } = setup();
    const result = await handler(
      runner,
      { projectPath: dir, mode: 'frames', inlineFrames: 2 },
      NO_GATE,
    );
    expectErrorMatching(
      result,
      /"inlineFrames" applies only to mode "check" and cannot be combined with mode "frames"/,
    );
    expect(stub.calls.length).toBe(0);
  });

  it('rejects a scene that escapes the project', async () => {
    const { dir, runner, stub, handler } = setup();
    const result = await handler(runner, { projectPath: dir, scene: '../outside.tscn' }, NO_GATE);
    expectErrorMatching(result, /Invalid scene path/);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects a scene that does not exist', async () => {
    const { dir, runner, stub, handler } = setup();
    const result = await handler(runner, { projectPath: dir, scene: 'missing.tscn' }, NO_GATE);
    expectErrorMatching(result, /Scene file does not exist: missing\.tscn/);
    expect(stub.calls.length).toBe(0);
  });

  it('accepts inline_frames and project_path snake_case aliases', async () => {
    const { dir, runner, handler } = setup();
    const payload = payloadOf(
      await handler(runner, { project_path: dir, inline_frames: 1, frames: TEST_FRAMES }, NO_GATE),
    );
    expect(payload.inlineFrames).toHaveLength(1);
  });
});

describe('render_movie sampling helpers', () => {
  it.each([
    [8, 3, [0, 4, 7]],
    [3, 8, [0, 1, 2]],
    [5, 1, [4]],
    [5, 0, []],
    [0, 3, []],
  ])('pickEvenly(%s, %s) is %j', (total, want, expected) => {
    expect(pickEvenly(total, want)).toEqual(expected);
  });

  it('measuredFramePositions covers two frames', () => {
    expect(measuredFramePositions(2)).toEqual([0, 1]);
  });

  it('measuredFramePositions skips the warm-up and ends at the last of thirty frames', () => {
    const positions = measuredFramePositions(30);
    expect(positions).toHaveLength(8);
    expect(positions[0]).toBe(5);
    expect(positions[positions.length - 1]).toBe(29);
  });

  it('measuredFramePositions starts at 4 and ends at 9 for ten frames', () => {
    const positions = measuredFramePositions(10);
    expect(positions[0]).toBe(4);
    expect(positions[positions.length - 1]).toBe(9);
  });
});

describe('render_movie refusals before any spawn', () => {
  it('refuses without a display', async () => {
    const { dir, runner, stub, handler } = setup({ display: false });
    const result = await handler(runner, { projectPath: dir }, NO_GATE);
    expectErrorMatching(result, /needs a display server/);
    expect(stub.calls.length).toBe(0);
    expect(existsSync(moviesDir(resolve(dir)))).toBe(false);
  });

  it('refuses while this server has a live session on the project', async () => {
    const { dir, runner, stub, handler } = setup();
    Object.assign(runner as unknown as Record<string, unknown>, {
      activeSessionMode: 'spawned',
      activeProjectPath: dir,
      activeProcess: { hasExited: false },
    });
    const result = await handler(runner, { projectPath: dir }, NO_GATE);
    expectErrorMatching(result, /runtime session is active on this project/);
    expect(stub.calls.length).toBe(0);
    expect(existsSync(moviesDir(resolve(dir)))).toBe(false);
  });

  it('tells the caller to switch first when the live session is not the current one', async () => {
    const { dir, runner, stub, handler } = setup();
    (runner as GodotRunner & { extraLiveSessionPaths: string[] }).extraLiveSessionPaths = [dir];
    const result = await handler(runner, { projectPath: dir }, NO_GATE);
    expectErrorMatching(result, /not the current one/);
    expect(JSON.stringify(unwrap(result).content)).toContain('switch_project');
    expect(stub.calls.length).toBe(0);
  });

  it('refuses while another MCP session owns the project, naming its pid and telling the caller to wait', async () => {
    const { dir, runner, stub, handler } = setup();
    (runner as GodotRunner & { otherLiveSessions: unknown[] }).otherLiveSessions = [
      {
        pid: OTHER_SESSION_PID,
        instanceId: 'abc123',
        hostname: 'some-host',
        mode: 'spawned',
        startedAt: new Date().toISOString(),
        port: 9900,
      },
    ];
    const result = await handler(runner, { projectPath: dir }, NO_GATE);
    expectErrorMatching(result, new RegExp(`server pid ${OTHER_SESSION_PID}`));
    expectErrorMatching(result, /Wait for the other session to finish/);
    expect(stub.calls.length).toBe(0);
    expect(existsSync(moviesDir(resolve(dir)))).toBe(false);
  });

  // "Is another session running this project" has no answer when the owner
  // registry cannot be read, and no answer must not be taken as no.
  it('refuses when the owner registry cannot be read, giving the reason', async () => {
    const { dir, runner, stub, handler } = setup();
    const unreadable = runner as GodotRunner & { otherLiveSessionsOnProject: () => never };
    unreadable.otherLiveSessionsOnProject = () => {
      throw new BridgeRegistryUnreadableError('cannot list the owners directory: EACCES');
    };
    const result = await handler(runner, { projectPath: dir }, NO_GATE);
    expectErrorMatching(result, /Could not read this project's bridge owner registry/);
    expectErrorMatching(result, /cannot list the owners directory: EACCES/);
    expectErrorMatching(result, /Refusing to start a movie run/);
    expect(stub.calls.length).toBe(0);
    expect(existsSync(moviesDir(resolve(dir)))).toBe(false);
  });

  it('refuses a stranded server-owned McpBridge autoload', async () => {
    const { dir, runner, stub, handler } = setup({
      projectGodot:
        'config_version=5\n\n[autoload]\n\nMcpBridge="*res://.mcp/godot-runtime/bridge/mcp_bridge.gd"\n',
    });
    const before = readFileSync(join(dir, 'project.godot'));
    const result = await handler(runner, { projectPath: dir }, NO_GATE);
    expectErrorMatching(result, /registers the McpBridge autoload/);
    expect(stub.calls.length).toBe(0);
    expect(existsSync(moviesDir(resolve(dir)))).toBe(false);
    expect(readFileSync(join(dir, 'project.godot')).equals(before)).toBe(true);
  });

  it('runs with a user-owned McpBridge autoload', async () => {
    const { dir, runner, stub, handler } = setup({
      projectGodot: 'config_version=5\n\n[autoload]\n\nMcpBridge="*res://game/my_bridge.gd"\n',
    });
    payloadOf(await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE));
    expect(stub.calls.length).toBe(1);
  });

  it('errors when no Godot executable is found', async () => {
    const { dir, runner, stub, handler } = setup({ runner: { godotPath: null } });
    const result = await handler(runner, { projectPath: dir }, NO_GATE);
    expectErrorMatching(result, /Could not find a valid Godot executable path/);
    expect(stub.calls.length).toBe(0);
  });
});

describe('render_movie launch gate', () => {
  it('calls the launch gate before the spawn and a declined confirmation prevents it', async () => {
    const declined = setup();
    const result = await declined.handler(
      declined.runner,
      { projectPath: declined.dir },
      makeContext({ elicit: async () => ({ action: 'decline' }) }),
    );
    expectErrorMatching(result, /User declined render_movie/);
    expect(declined.stub.calls.length).toBe(0);

    const events: string[] = [];
    const accepted = setup({ stub: { onRun: () => events.push('spawn') } });
    payloadOf(
      await accepted.handler(
        accepted.runner,
        { projectPath: accepted.dir, frames: TEST_FRAMES },
        makeContext({
          elicit: async () => {
            events.push('elicit');
            return { action: 'accept', content: { confirm: true } };
          },
        }),
      ),
    );
    expect(events).toEqual(['elicit', 'spawn']);
  });

  it('shares the confirmed-project set with run_project', async () => {
    let elicitCalls = 0;
    const countingElicit = async () => {
      elicitCalls++;
      return { action: 'accept' as const, content: { confirm: true } };
    };
    const { dir, runner, handler } = setup();
    const key = normalizeProjectKey(resolve(dir));

    const preConfirmed = makeContext({ elicit: countingElicit });
    preConfirmed.sessionState.runProjectConfirmed.add(key);
    payloadOf(await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, preConfirmed));
    expect(elicitCalls).toBe(0);

    const fresh = makeContext({ elicit: countingElicit });
    payloadOf(await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, fresh));
    expect(elicitCalls).toBe(1);
    expect(fresh.sessionState.runProjectConfirmed.has(key)).toBe(true);
  });

  it('strict mode refuses a Tier 1 autoload before the spawn', async () => {
    const { dir, runner, stub, handler } = setup({ projectGodot: EVIL_AUTOLOAD_PROJECT });
    writeEvilAutoload(dir);
    const result = await handler(runner, { projectPath: dir }, makeContext({ strict: true }));
    expectErrorMatching(result, /Strict mode: refusing to launch project/);
    expect(stub.calls.length).toBe(0);
  });

  it('disableSecurity skips the gate', async () => {
    const { dir, runner, stub, handler } = setup({ projectGodot: EVIL_AUTOLOAD_PROJECT });
    writeEvilAutoload(dir);
    const ctx = makeContext({
      disableSecurity: true,
      elicit: async () => {
        throw new Error('the gate must not be consulted');
      },
    });
    const payload = payloadOf(
      await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, ctx),
    );
    expect(stub.calls.length).toBe(1);
    expect(payload.warnings).toBeUndefined();
  });

  it('gate findings arrive in warnings on success', async () => {
    const { dir, runner, handler } = setup({ projectGodot: EVIL_AUTOLOAD_PROJECT });
    writeEvilAutoload(dir);
    const payload = payloadOf(
      await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, makeContext()),
    );
    expect(payload.warnings?.some((w) => w.includes('evil.gd'))).toBe(true);
  });

  it('gate findings survive a flood of runtime error lines', async () => {
    const floodLines = MOVIE_RUNTIME_WARNINGS_MAX + RUNTIME_ERROR_FLOOD_EXTRA;
    const stderr = Array.from({ length: floodLines }, (_, i) => `SCRIPT ERROR: flood ${i}`).join(
      '\n',
    );
    const { dir, runner, handler } = setup({
      projectGodot: EVIL_AUTOLOAD_PROJECT,
      stub: { result: { stderr } },
    });
    writeEvilAutoload(dir);
    const payload = payloadOf(
      await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, makeContext()),
    );
    const warnings = payload.warnings!;
    expect(warnings.some((w) => w.includes('evil.gd'))).toBe(true);
    expect(warnings).toContain(`+${RUNTIME_ERROR_FLOOD_EXTRA} more runtime error lines`);
    expect(warnings.filter((w) => w.startsWith('SCRIPT ERROR: flood'))).toHaveLength(
      MOVIE_RUNTIME_WARNINGS_MAX,
    );
  });
});

describe('render_movie run outcomes', () => {
  it('creates .mcp/.gdignore and the run directory before the spawn', async () => {
    const seen: { gdignore: boolean; runDir: boolean }[] = [];
    const { dir, runner, handler } = setup({
      stub: {
        onRun: ({ dir: runDir }) => {
          seen.push({
            gdignore: existsSync(join(resolve(dir), '.mcp', '.gdignore')),
            runDir: existsSync(runDir),
          });
        },
      },
    });
    payloadOf(await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE));
    expect(seen).toEqual([{ gdignore: true, runDir: true }]);
  });

  it('leaves project.godot byte-identical', async () => {
    const { dir, runner, handler } = setup();
    const before = readFileSync(join(dir, 'project.godot'));
    payloadOf(await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE));
    payloadOf(
      await handler(runner, { projectPath: dir, mode: 'frames', frames: TEST_FRAMES }, NO_GATE),
    );
    expect(readFileSync(join(dir, 'project.godot')).equals(before)).toBe(true);
    expect(readFileSync(join(dir, 'project.godot'), 'utf8')).not.toContain('McpBridge');
  });

  it('a timeout is an error naming the kill, and the run directory is removed', async () => {
    const { dir, runner, handler } = setup({
      stub: { result: { timedOut: true, exitCode: null } },
    });
    const result = await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE);
    expectErrorMatching(
      result,
      /render_movie timed out after \d+ ms and the Godot process tree was killed/,
    );
    expect(movieRunDirs(dir)).toEqual([]);
  });

  it('a timeout whose kill was not confirmed says a process may still be running', async () => {
    const { dir, runner, handler } = setup({
      stub: { result: { timedOut: true, exitCode: null, killUnconfirmed: true } },
    });
    const result = await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE);
    expectErrorMatching(result, /did not report exiting within \d+ ms/);
    expectErrorMatching(result, /a Godot process may still be running/);
    expect(errorText(result)).not.toMatch(/process tree was killed/);
  });

  it('a non-zero exit returns the stderr tail', async () => {
    const stderr = Array.from({ length: STDERR_LINES }, (_, i) => `err-${i + 1}-end`).join('\n');
    const { dir, runner, handler } = setup({ stub: { result: { exitCode: 1, stderr } } });
    const result = await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE);
    expectErrorMatching(result, /Godot exited with code 1 before finishing the movie run/);
    const text = errorText(result)!;
    expect(text).toContain(`err-${STDERR_LINES}-end`);
    expect(text).not.toContain('err-1-end');
  });

  it('a spawn failure is an error', async () => {
    const { dir, runner, handler } = setup({
      stub: { writeNothing: true, result: { exitCode: null, spawnError: 'spawn ENOENT' } },
    });
    const result = await handler(runner, { projectPath: dir }, NO_GATE);
    expectErrorMatching(result, /render_movie could not start Godot: spawn ENOENT/);
  });

  it('exit 0 with no frames is an error, not an empty success', async () => {
    const { dir, runner, handler } = setup({ stub: { writeNothing: true } });
    const result = await handler(runner, { projectPath: dir }, NO_GATE);
    expectErrorMatching(result, /the movie writer exited cleanly but wrote no frames/);
    expect(movieRunDirs(dir)).toEqual([]);
  });
});

describe('render_movie check mode', () => {
  it('returns likelyBlank, motion, samples and inline images', async () => {
    const { dir, runner, handler } = setup();
    const result = await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE);
    const payload = payloadOf(result);

    expect(payload.mode).toBe('check');
    expect(payload.statsAvailable).toBe(true);
    expect(payload.likelyBlank).toBe(false);
    expect(payload.anyMotion).toBe(true);
    expect(payload.motion).toBeGreaterThan(0);
    expect(payload.frameCount).toBe(TEST_FRAMES);
    expect(payload.framesKept).toBe(false);

    const content = unwrap(result).content;
    expect(content.slice(0, 3).map((c) => c.type)).toEqual(['image', 'image', 'image']);
    for (const block of imageBlocks(result)) {
      expect(block.mimeType).toBe('image/png');
      const decoded = decodePng(Buffer.from(block.data!, 'base64'));
      expect(decoded.width).toBeLessThanOrEqual(MAX_INLINE_WIDTH);
      expect(decoded.height).toBeLessThanOrEqual(MAX_INLINE_HEIGHT);
    }
    expect(payload.inlineFrames).toHaveLength(3);
    expect(payload.inlineFrames![2]!.index).toBe(LAST_TEST_FRAME);
  });

  it('judges likelyBlank on the last frame', async () => {
    const contentLast = setup({
      stub: { makeFrame: (i) => (i === LAST_TEST_FRAME ? stillFrame() : blankFrame()) },
    });
    const notBlank = payloadOf(
      await contentLast.handler(
        contentLast.runner,
        { projectPath: contentLast.dir, frames: TEST_FRAMES },
        NO_GATE,
      ),
    );
    expect(notBlank.likelyBlank).toBe(false);

    const blankLast = setup({
      stub: { makeFrame: (i) => (i === LAST_TEST_FRAME ? blankFrame() : stillFrame()) },
    });
    const blank = payloadOf(
      await blankLast.handler(
        blankLast.runner,
        { projectPath: blankLast.dir, frames: TEST_FRAMES },
        NO_GATE,
      ),
    );
    expect(blank.likelyBlank).toBe(true);
  });

  it('reports anyMotion false for identical frames', async () => {
    const { dir, runner, handler } = setup({ stub: { makeFrame: () => stillFrame() } });
    const payload = payloadOf(
      await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE),
    );
    expect(payload.anyMotion).toBe(false);
    expect(payload.motion).toBe(0);
  });

  it('deletes its frames and the wav', async () => {
    const { dir, runner, handler } = setup();
    payloadOf(await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE));
    expect(movieRunDirs(dir)).toEqual([]);
  });

  it('inlineFrames: 0 returns no image blocks', async () => {
    const { dir, runner, handler } = setup();
    const result = await handler(
      runner,
      { projectPath: dir, frames: TEST_FRAMES, inlineFrames: 0 },
      NO_GATE,
    );
    const payload = payloadOf(result);
    expect(imageBlocks(result)).toHaveLength(0);
    expect(payload.inlineFrames).toEqual([]);
  });

  it('an undecodable sampled frame is null stats plus a warning, and the call succeeds', async () => {
    const moving = setup({
      stub: { makeFrame: (i) => (i === INVALID_SAMPLED_FRAME ? invalidPng() : movingFrame(i)) },
    });
    const payload = payloadOf(
      await moving.handler(
        moving.runner,
        { projectPath: moving.dir, frames: TEST_FRAMES },
        NO_GATE,
      ),
    );
    const bad = payload.samples!.find((s) => s.index === INVALID_SAMPLED_FRAME)!;
    expect(bad.stats).toBeNull();
    expect(
      payload.warnings!.some((w) => w.includes(`Frame ${INVALID_SAMPLED_FRAME} was not measured`)),
    ).toBe(true);
    const touching = payload.motionPairs!.filter(
      (p) => p.from === INVALID_SAMPLED_FRAME || p.to === INVALID_SAMPLED_FRAME,
    );
    expect(touching.length).toBeGreaterThan(0);
    for (const pair of touching) expect(pair.difference).toBeNull();
    expect(payload.anyMotion).toBe(true);
    expect(payload.measuredFrames).toBe(payload.samples!.length - 1);

    const still = setup({
      stub: { makeFrame: (i) => (i === INVALID_SAMPLED_FRAME ? invalidPng() : stillFrame()) },
    });
    const unknown = payloadOf(
      await still.handler(still.runner, { projectPath: still.dir, frames: TEST_FRAMES }, NO_GATE),
    );
    expect(unknown.anyMotion).toBeNull();
  });

  it('a single written frame leaves motion and anyMotion null with a warning', async () => {
    const { dir, runner, handler } = setup({ stub: { frameCount: 1 } });
    const payload = payloadOf(
      await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE),
    );
    expect(payload.frameCount).toBe(1);
    expect(payload.measuredFrames).toBe(1);
    expect(payload.motionPairs).toEqual([]);
    expect(payload.motion).toBeNull();
    expect(payload.anyMotion).toBeNull();
    expect(payload.likelyBlank).toBe(false);
    expect(payload.warnings).toContain(
      'Motion was not measured: fewer than two frames were sampled.',
    );
  });

  it('an undecodable last frame leaves likelyBlank null and leads warnings with it', async () => {
    const { dir, runner, handler } = setup({
      stub: { makeFrame: (i) => (i === LAST_TEST_FRAME ? invalidPng() : movingFrame(i)) },
    });
    const payload = payloadOf(
      await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE),
    );
    expect(payload.likelyBlank).toBeNull();
    expect(payload.warnings![0]).toMatch(
      new RegExp(`likelyBlank was not determined: the last frame \\(${LAST_TEST_FRAME}\\)`),
    );
  });

  it('a frame count that differs from the request is a warning', async () => {
    const WRITTEN = TEST_FRAMES - 2;
    const { dir, runner, handler } = setup({ stub: { frameCount: WRITTEN } });
    const payload = payloadOf(
      await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE),
    );
    expect(payload.frameCount).toBe(WRITTEN);
    expect(payload.warnings).toContain(
      `The movie writer wrote ${WRITTEN} frames, not the ${TEST_FRAMES} requested.`,
    );
  });

  it('SCRIPT ERROR lines on a clean exit surface as warnings', async () => {
    const { dir, runner, handler } = setup({
      stub: {
        result: { stderr: 'noise line\nSCRIPT ERROR: Parse Error: bad thing\n   at: res://a.gd:3' },
      },
    });
    const payload = payloadOf(
      await handler(runner, { projectPath: dir, frames: TEST_FRAMES }, NO_GATE),
    );
    expect(payload.warnings).toContain('SCRIPT ERROR: Parse Error: bad thing');
  });
});

describe('render_movie frames mode', () => {
  it('keeps the files and returns directory, framePattern, framePaths, audioPath and sample paths', async () => {
    const { dir, runner, handler } = setup();
    const result = await handler(
      runner,
      { projectPath: dir, mode: 'frames', frames: TEST_FRAMES },
      NO_GATE,
    );
    const payload = payloadOf(result);

    expect(payload.framesKept).toBe(true);
    expect(imageBlocks(result)).toHaveLength(0);
    expect(payload.inlineFrames).toBeUndefined();
    expect(payload.frameCount).toBe(TEST_FRAMES);
    expect(payload.measuredFrames).toBeLessThanOrEqual(8);
    expect(payload.directory!.startsWith(moviesDir(resolve(dir)))).toBe(true);
    expect(payload.framePattern).toBe(join(payload.directory!, 'frame%08d.png'));
    expect(payload.framePaths).toHaveLength(TEST_FRAMES);
    for (const path of payload.framePaths!) expect(existsSync(path)).toBe(true);
    for (const sample of payload.samples!) expect(existsSync(sample.path!)).toBe(true);
    expect(existsSync(payload.audioPath!)).toBe(true);
  });

  it('omits framePaths above the listing cap', async () => {
    const { dir, runner, handler } = setup({ stub: { makeFrame: () => tinyFrame() } });
    const payload = payloadOf(
      await handler(
        runner,
        { projectPath: dir, mode: 'frames', frames: FRAMES_ABOVE_LISTING_CAP },
        NO_GATE,
      ),
    );
    expect(payload.frameCount).toBe(FRAMES_ABOVE_LISTING_CAP);
    expect(payload.framePaths).toBeUndefined();
    expect(payload.framePattern).toBeDefined();
  });

  it('omits audioPath when no wav was written', async () => {
    const { dir, runner, handler } = setup({ stub: { writeAudio: false } });
    const payload = payloadOf(
      await handler(runner, { projectPath: dir, mode: 'frames', frames: TEST_FRAMES }, NO_GATE),
    );
    expect(payload.audioPath).toBeUndefined();
  });

  it('removes the run directory when the run fails', async () => {
    const { dir, runner, handler } = setup({ stub: { result: { exitCode: 1 } } });
    const result = await handler(
      runner,
      { projectPath: dir, mode: 'frames', frames: TEST_FRAMES },
      NO_GATE,
    );
    expect(hasError(result)).toBe(true);
    expect(movieRunDirs(dir)).toEqual([]);
  });
});

describe('render_movie video mode', () => {
  it('returns path, byteSize, format and states that stats are not available', async () => {
    const { dir, runner, handler } = setup();
    const payload = payloadOf(await handler(runner, { projectPath: dir, mode: 'video' }, NO_GATE));
    expect(payload.statsAvailable).toBe(false);
    expect(payload.statsNote).toMatch(/PNG frames/);
    expect(payload).not.toHaveProperty('likelyBlank');
    expect(payload.format).toBe('avi');
    expect(payload.path!.endsWith('movie.avi')).toBe(true);
    expect(payload.byteSize).toBe(statSync(payload.path!).size);
    expect(payload.byteSize).toBeGreaterThan(0);
  });

  it('with no output file is an error naming the format and the engine version', async () => {
    const ogv = setup({ runner: { godotVersion: '4.5.1.stable' }, stub: { writeNothing: true } });
    const ogvResult = await ogv.handler(
      ogv.runner,
      { projectPath: ogv.dir, mode: 'video', format: 'ogv' },
      NO_GATE,
    );
    expectErrorMatching(
      ogvResult,
      /Godot 4\.5\.1\.stable did not write an ogv movie \(no output file\)/,
    );
    expectErrorMatching(ogvResult, /may not support the ogv/);
    expect(movieRunDirs(ogv.dir)).toEqual([]);

    const avi = setup({ runner: { godotVersion: '4.5.1.stable' }, stub: { writeNothing: true } });
    const aviResult = await avi.handler(
      avi.runner,
      { projectPath: avi.dir, mode: 'video' },
      NO_GATE,
    );
    expectErrorMatching(aviResult, /did not write an avi movie \(no output file\)/);
    expect(errorText(aviResult)).not.toMatch(/may not support the ogv/);
  });

  it('with an empty output file is an error', async () => {
    const { dir, runner, handler } = setup({ stub: { videoBytes: Buffer.alloc(0) } });
    const result = await handler(runner, { projectPath: dir, mode: 'video' }, NO_GATE);
    expectErrorMatching(result, /\(empty output file\)/);
  });
});
