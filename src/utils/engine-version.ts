/**
 * Godot version comparison between the engine this server drives and the
 * engine a project was last saved with.
 *
 * A project records the version it was saved with as the first `N.N` element of
 * `application/config/features`. An engine newer than that saves scenes in its
 * own format, which the older engine may not load. These helpers only read and
 * compare; what to say about the result is the caller's.
 */

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

/**
 * The version a project was saved with: the first element of
 * `application/config/features` that reads as `N.N` (`"4.4"` in
 * `PackedStringArray("4.4", "Forward Plus")`). Null when the file, the key or
 * such an element is missing, or on any read failure.
 */
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
