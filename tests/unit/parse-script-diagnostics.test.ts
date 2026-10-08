/** Fixture stderr is verbatim from Godot 4.x (macOS), error-43 class included: compile failures put message and line on stderr, not in the API result. */

import { describe, it, expect } from 'vitest';
import { parseScriptDiagnostics } from '../../src/utils/output-parsing.js';

describe('parseScriptDiagnostics', () => {
  it('returns [] for empty stderr', () => {
    expect(parseScriptDiagnostics('')).toEqual([]);
  });

  it('parses a genuine parse error with file and line', () => {
    const stderr = [
      'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org',
      'SCRIPT ERROR: Parse Error: Identifier "missing_var" not declared in the current scope.',
      '          at: GDScript::reload (res://scripts/broken.gd:3)',
      '          GDScript backtrace (most recent call first):',
      '              [0] _validate_single (res://ops.gd:1068)',
    ].join('\n');
    expect(parseScriptDiagnostics(stderr)).toEqual([
      {
        message: 'Identifier "missing_var" not declared in the current scope.',
        line: 3,
        filePath: 'res://scripts/broken.gd',
      },
    ]);
  });

  it('parses an autoload-reference compile error (error-43 class)', () => {
    const stderr = [
      'SCRIPT ERROR: Compile Error: Identifier not found: GameState',
      '          at: GDScript::reload (res://scripts/uses_autoload.gd:3)',
      'ERROR: Failed to load script "res://scripts/uses_autoload.gd" with error "Compilation failed".',
      '   at: load (modules/gdscript/gdscript_resource_format.cpp:46)',
    ].join('\n');
    expect(parseScriptDiagnostics(stderr)).toEqual([
      {
        message: 'Compile Error: Identifier not found: GameState',
        line: 3,
        filePath: 'res://scripts/uses_autoload.gd',
      },
    ]);
  });

  it('suppresses the "Failed to load script" echo and its engine-source line number', () => {
    const stderr = [
      'SCRIPT ERROR: Parse Error: Identifier "x" not declared in the current scope.',
      '          at: GDScript::reload (res://scripts/a.gd:7)',
      'ERROR: Failed to load script "res://scripts/a.gd" with error "Parse error".',
      '   at: load (modules/gdscript/gdscript_resource_format.cpp:46)',
    ].join('\n');
    const result = parseScriptDiagnostics(stderr);
    expect(result).toHaveLength(1);
    expect(result[0]?.line).toBe(7);
  });

  it('handles runtime-compiled gdscript:// URIs: line but no filePath', () => {
    const stderr = [
      'SCRIPT ERROR: Parse Error: Identifier "some_missing_thing" not declared in the current scope.',
      '          at: GDScript::reload (gdscript://-9223372010447436344.gd:4)',
    ].join('\n');
    expect(parseScriptDiagnostics(stderr)).toEqual([
      {
        message: 'Identifier "some_missing_thing" not declared in the current scope.',
        line: 4,
      },
    ]);
  });

  it('recovers filePath from the "Failed to load script" echo when at: names no res:// path', () => {
    // The at: line points into Godot's C++ source (no res:// identity): parseGodotErrorsByPath would drop it and batch validate report the file valid.
    const stderr = [
      'SCRIPT ERROR: Parse Error: Identifier "x" not declared in the current scope.',
      '   at: GDScript::reload (modules/gdscript/gdscript.cpp:2907)',
      '   GDScript backtrace (most recent call first):',
      '       [0] _validate_single (res://.mcp/ops.gd:1126)',
      'ERROR: Failed to load script "res://scripts/late.gd" with error "Parse error".',
    ].join('\n');
    expect(parseScriptDiagnostics(stderr)).toEqual([
      {
        message: 'Identifier "x" not declared in the current scope.',
        filePath: 'res://scripts/late.gd',
      },
    ]);
  });

  it('never adopts a line number from the "Failed to load script" echo', () => {
    const stderr = [
      'SCRIPT ERROR: Compile Error: Identifier not found: GameState',
      '   at: GDScript::reload (modules/gdscript/gdscript.cpp:2907)',
      'ERROR: Failed to load script "res://scripts/a.gd" with error "Compilation failed".',
      '   at: load (modules/gdscript/gdscript_resource_format.cpp:46)',
    ].join('\n');
    const result = parseScriptDiagnostics(stderr);
    expect(result).toHaveLength(1);
    expect(result[0]?.filePath).toBe('res://scripts/a.gd');
    expect(result[0]?.line).toBeUndefined();
  });

  it('does not relabel a gdscript:// source with an unrelated nearby res:// path', () => {
    // The at: line already gives the entry its identity; the load-failure echo must not overwrite it with a mismatched path and line.
    const stderr = [
      'SCRIPT ERROR: Parse Error: Identifier "x" not declared in the current scope.',
      '   at: GDScript::reload (gdscript://-9223372010447436344.gd:4)',
      'ERROR: Failed to load script "res://scripts/unrelated.gd" with error "Parse error".',
    ].join('\n');
    expect(parseScriptDiagnostics(stderr)).toEqual([
      { message: 'Identifier "x" not declared in the current scope.', line: 4 },
    ]);
  });

  it('parses USER SCRIPT ERROR markers', () => {
    const stderr = [
      'USER SCRIPT ERROR: something exploded',
      '          at: _ready (res://scripts/main.gd:12)',
    ].join('\n');
    expect(parseScriptDiagnostics(stderr)).toEqual([
      { message: 'something exploded', line: 12, filePath: 'res://scripts/main.gd' },
    ]);
  });

  it('parses legacy "Parse Error: ... at line N" format', () => {
    const stderr = 'Parse Error: Unterminated string at line 42';
    expect(parseScriptDiagnostics(stderr)).toEqual([{ message: 'Unterminated string', line: 42 }]);
  });

  it('de-duplicates identical re-emitted errors', () => {
    const block = [
      'SCRIPT ERROR: Parse Error: Identifier "x" not declared in the current scope.',
      '          at: GDScript::reload (res://scripts/a.gd:3)',
    ].join('\n');
    expect(parseScriptDiagnostics(`${block}\n${block}`)).toHaveLength(1);
  });

  it('ignores INFO lines and unrelated errors', () => {
    const stderr = [
      '[INFO] Operation: validate_resource',
      '[INFO] Executing operation: validate_resource',
      'Godot Engine v4.7.2 - https://godotengine.org',
    ].join('\n');
    expect(parseScriptDiagnostics(stderr)).toEqual([]);
  });

  it('captures bare ERROR scene-parse lines with their [Resource file] location', () => {
    // Observed on Godot 4.7.2 validating a broken .tscn - no SCRIPT ERROR
    // prefix; the user-file location rides inline in brackets.
    const stderr = [
      'ERROR: Parse Error: Parse error. [Resource file res://main.tscn:4]',
      '   at: _parse_node_tag (scene/resources/resource_format_text.cpp:293)',
      'ERROR: Failed loading resource: res://main.tscn.',
      '   at: _load (core/io/resource_loader.cpp:317)',
    ].join('\n');
    expect(parseScriptDiagnostics(stderr)).toEqual([
      {
        message: 'Parse Error: Parse error.',
        line: 4,
        filePath: 'res://main.tscn',
      },
    ]);
  });

  it('captures other bare ERROR lines without inventing a location', () => {
    const stderr = 'ERROR: Unable to open file: res://missing.png';
    expect(parseScriptDiagnostics(stderr)).toEqual([
      { message: 'Unable to open file: res://missing.png' },
    ]);
  });

  it('suppresses the bare-ERROR "Failed to load script" echo variant', () => {
    const stderr = [
      'SCRIPT ERROR: Parse Error: Unterminated string.',
      '   at: GDScript::reload (res://scripts/a.gd:7)',
      'ERROR: Failed to load script "res://scripts/a.gd" with error "Parse error".',
      '   at: load (modules/gdscript/gdscript.cpp:285)',
    ].join('\n');
    expect(parseScriptDiagnostics(stderr)).toEqual([
      { message: 'Unterminated string.', line: 7, filePath: 'res://scripts/a.gd' },
    ]);
  });
});
