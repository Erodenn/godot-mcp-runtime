/**
 * Shared paths to the committed Godot fixture project.
 *
 * Tests should import these instead of redoing the
 * fileURLToPath/dirname/join dance in every spec file.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to tests/fixtures/godot-project. */
export const fixtureProjectPath = join(here, '..', 'fixtures', 'godot-project');

/** Absolute path to tests/fixtures/godot-profiling-project (hot _process loop). */
export const profilingFixtureProjectPath = join(here, '..', 'fixtures', 'godot-profiling-project');

/** Scene path *relative to the project root* — matches the MCP tool contract. */
export const fixtureScenePath = 'main.tscn';

/** Absolute path to the fixture's main.tscn. */
export const fixtureSceneAbsPath = join(fixtureProjectPath, fixtureScenePath);
