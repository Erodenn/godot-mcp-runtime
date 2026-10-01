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

/** Scene path *relative to the project root*: matches the MCP tool contract. */
export const fixtureScenePath = 'main.tscn';

/** Absolute path to the fixture's main.tscn. */
export const fixtureSceneAbsPath = join(fixtureProjectPath, fixtureScenePath);

/** Probe scene for the simulate_input integration tests (sibling of main.tscn). */
export const inputProbeScenePath = 'input_probe.tscn';

/** Absolute path to the fixture's input_probe.tscn. */
export const inputProbeSceneAbsPath = join(fixtureProjectPath, inputProbeScenePath);

/** Blank scene (empty Node root, renders only the clear color) for the pixel-statistics tests. */
export const blankScenePath = 'blank.tscn';

/** Absolute path to the fixture's blank.tscn. */
export const blankSceneAbsPath = join(fixtureProjectPath, blankScenePath);

/** Scene whose ColorRect moves every process frame, for the render_movie motion tests. */
export const motionAnimatedScenePath = 'motion_animated.tscn';

/** The same ColorRect with no script, so every frame of a movie run is identical. */
export const motionStaticScenePath = 'motion_static.tscn';
