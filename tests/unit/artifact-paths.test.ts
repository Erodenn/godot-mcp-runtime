import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  isServerOwnedBridgePath,
  movieAudioPath,
  movieOutputPath,
  movieRunDir,
  moviesDir,
} from '../../src/utils/artifact-paths.js';

describe('isServerOwnedBridgePath', () => {
  it('accepts the legacy root script with a lowercase res:// scheme', () => {
    expect(isServerOwnedBridgePath('res://mcp_bridge.gd')).toBe(true);
  });

  it('accepts anything under .mcp/', () => {
    expect(isServerOwnedBridgePath('res://.mcp/godot-runtime/bridge/mcp_bridge.gd')).toBe(true);
  });

  it('accepts an uppercase RES:// scheme', () => {
    expect(isServerOwnedBridgePath('RES://.mcp/godot-runtime/bridge/mcp_bridge.gd')).toBe(true);
  });

  it('accepts a mixed-case scheme on the legacy root script', () => {
    expect(isServerOwnedBridgePath('Res://mcp_bridge.gd')).toBe(true);
  });

  it('still rejects a path with .mcp below the root', () => {
    expect(isServerOwnedBridgePath('res://addons/.mcp/mcp_bridge.gd')).toBe(false);
  });

  it('still rejects a uid:// form', () => {
    expect(isServerOwnedBridgePath('uid://abc123')).toBe(false);
  });

  it('still rejects a user script sharing the name outside .mcp/', () => {
    expect(isServerOwnedBridgePath('res://game/my_own_bridge.gd')).toBe(false);
  });
});

describe('movie paths', () => {
  const PROJECT = join('proj', 'dir');
  const RUN_ID = '1700000000000-abc';
  const MOVIES = join(PROJECT, '.mcp', 'godot-runtime', 'movies');

  it('moviesDir is .mcp/godot-runtime/movies under the project', () => {
    expect(moviesDir(PROJECT)).toBe(MOVIES);
  });

  it('movieRunDir is one level under moviesDir', () => {
    expect(movieRunDir(PROJECT, RUN_ID)).toBe(join(MOVIES, RUN_ID));
  });

  it('movieOutputPath names frame.png, movie.avi and movie.ogv', () => {
    const runDir = movieRunDir(PROJECT, RUN_ID);
    expect(movieOutputPath(PROJECT, RUN_ID, 'png')).toBe(join(runDir, 'frame.png'));
    expect(movieOutputPath(PROJECT, RUN_ID, 'avi')).toBe(join(runDir, 'movie.avi'));
    expect(movieOutputPath(PROJECT, RUN_ID, 'ogv')).toBe(join(runDir, 'movie.ogv'));
  });

  it('movieAudioPath names frame.wav', () => {
    expect(movieAudioPath(PROJECT, RUN_ID)).toBe(join(movieRunDir(PROJECT, RUN_ID), 'frame.wav'));
  });
});
