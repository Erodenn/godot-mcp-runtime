/**
 * Unit tests for the import_assets handler.
 *
 * The handler is a thin wrapper: validate the project, delegate to
 * runner.importAssets(), surface a confirmation string. These tests pin
 * the boundary contract without a Godot binary — the real import run is
 * covered by the integration test (tests/integration/import-assets.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { handleImportAssets } from '../../../src/tools/project-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, expectErrorMatching, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';
import { useTmpDirs } from '../../helpers/tmp.js';

const tmp = useTmpDirs();

function parseText(result: unknown): string {
  return unwrap(result).content[0]?.text ?? '';
}

/** FakeRunner with an importAssets spy surface. */
function makeRunner(opts: { throws?: Error } = {}) {
  const importCalls: string[] = [];
  const fake = createFakeRunner();
  const asRunner = Object.assign(fake.asRunner, {
    importAssets: async (projectPath: string) => {
      importCalls.push(projectPath);
      if (opts.throws) throw opts.throws;
    },
  });
  return { asRunner, importCalls };
}

describe('handleImportAssets', () => {
  it('rejects missing projectPath', async () => {
    const { asRunner } = makeRunner();
    const result = await handleImportAssets(asRunner, {});
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const { asRunner } = makeRunner();
    const result = await handleImportAssets(asRunner, { projectPath: '../evil' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const { asRunner } = makeRunner();
    const result = await handleImportAssets(asRunner, { projectPath: '/ghost' });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects a directory without project.godot', async () => {
    const { asRunner } = makeRunner();
    const emptyDir = tmp.make('mcp-empty-');
    const result = await handleImportAssets(asRunner, { projectPath: emptyDir });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('imports a valid project and confirms', async () => {
    const { asRunner, importCalls } = makeRunner();
    const result = await handleImportAssets(asRunner, { projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(false);
    expect(importCalls).toEqual([fixtureProjectPath]);
    expect(parseText(result)).toContain('Asset import completed');
  });

  it('rejects a res:// projectPath with the not-a-project error', async () => {
    // Unlike autoloadPath, projectPath takes a filesystem path; a res:// form
    // never resolves to a directory containing project.godot.
    const { asRunner, importCalls } = makeRunner();
    const result = await handleImportAssets(asRunner, {
      projectPath: `res://${join('x', 'y')}`,
    });
    expectErrorMatching(result, /not a valid godot project/i);
    expect(importCalls).toEqual([]);
  });

  it('returns a structured error when the import run fails', async () => {
    const { asRunner } = makeRunner({
      throws: new Error('Asset import failed (exit 1).\nStderr:\nboom'),
    });
    const result = await handleImportAssets(asRunner, { projectPath: fixtureProjectPath });
    expectErrorMatching(result, /failed to import assets/i);
  });
});
