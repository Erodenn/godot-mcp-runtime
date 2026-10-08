import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

export const fixtureProjectPath = join(here, '..', 'fixtures', 'godot-project');

/** Files shaped the way the Godot editor writes them; copy it before mutating. */
export const authoredFixtureProjectPath = join(here, '..', 'fixtures', 'godot-authored-project');

export const profilingFixtureProjectPath = join(here, '..', 'fixtures', 'godot-profiling-project');

export const fixtureScenePath = 'main.tscn';

export const fixtureSceneAbsPath = join(fixtureProjectPath, fixtureScenePath);

export const inputProbeScenePath = 'input_probe.tscn';

export const inputProbeSceneAbsPath = join(fixtureProjectPath, inputProbeScenePath);

export const blankScenePath = 'blank.tscn';

export const blankSceneAbsPath = join(fixtureProjectPath, blankScenePath);

export const motionAnimatedScenePath = 'motion_animated.tscn';

export const motionStaticScenePath = 'motion_static.tscn';
