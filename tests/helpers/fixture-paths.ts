import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

export const fixtureProjectPath = join(here, '..', 'fixtures', 'godot-project');

/** Files shaped the way the Godot editor writes them; copy it before mutating. */
export const authoredFixtureProjectPath = join(here, '..', 'fixtures', 'godot-authored-project');

export const profilingFixtureProjectPath = join(here, '..', 'fixtures', 'godot-profiling-project');

/** A 720x1280 viewport under `canvas_items` stretch in a 540x960 window; copy it before launching. */
export const stretchFixtureProjectPath = join(here, '..', 'fixtures', 'godot-stretch-project');

export const fixtureScenePath = 'main.tscn';

export const fixtureSceneAbsPath = join(fixtureProjectPath, fixtureScenePath);

export const inputProbeScenePath = 'input_probe.tscn';

export const inputProbeSceneAbsPath = join(fixtureProjectPath, inputProbeScenePath);

export const inputOcclusionScenePath = 'input_probe_occlusion.tscn';

export const blankScenePath = 'blank.tscn';

export const blankSceneAbsPath = join(fixtureProjectPath, blankScenePath);

export const motionAnimatedScenePath = 'motion_animated.tscn';

export const motionStaticScenePath = 'motion_static.tscn';
