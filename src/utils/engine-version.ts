/** Godot version comparison between this server's engine and the engine a project was last saved with (the first `N.N` of `application/config/features`). A newer engine saves in a format the older may not load; these helpers only compare, what to say is the caller's. */

import { readFileSync } from 'fs';
import { projectGodotPath } from './path-validation.js';
import { findSetting, scanProjectFile } from './project-godot.js';

export interface MajorMinor {
  major: number;
  minor: number;
}

const APPLICATION_SECTION = 'application';
const FEATURES_KEY = 'config/features';
const MAJOR_MINOR_REGEX = /^(\d+)\.(\d+)/;
const QUOTED_STRING_REGEX = /"([^"]*)"/g;

/** The leading `major.minor` of a version string such as `4.6.2.stable.mono.official.x`. */
export function parseMajorMinor(text: string): MajorMinor | null {
  const match = MAJOR_MINOR_REGEX.exec(text);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** The version a project was saved with: the first `application/config/features` element reading as `N.N`; null when missing or on any read failure. */
export function readProjectFeatureVersion(projectPath: string): MajorMinor | null {
  try {
    const content = readFileSync(projectGodotPath(projectPath), 'utf8');
    const statement = findSetting(scanProjectFile(content), APPLICATION_SECTION, FEATURES_KEY);
    if (statement === undefined || statement.unterminated) return null;
    for (const quoted of statement.raw.matchAll(QUOTED_STRING_REGEX)) {
      const version = parseMajorMinor(quoted[1] ?? '');
      if (version !== null) return version;
    }
    return null;
  } catch {
    return null;
  }
}

/** Both versions when the engine's `major.minor` is newer than the project's, else null. */
export function engineNewerThanProject(
  engineVersion: string,
  projectPath: string,
): { engine: MajorMinor; project: MajorMinor } | null {
  const engine = parseMajorMinor(engineVersion);
  const project = readProjectFeatureVersion(projectPath);
  if (engine === null || project === null) return null;
  const newer =
    engine.major > project.major ||
    (engine.major === project.major && engine.minor > project.minor);
  return newer ? { engine, project } : null;
}
