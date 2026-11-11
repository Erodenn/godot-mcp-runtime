import { describe, it, expect } from 'vitest';
import {
  engineNewerThanProject,
  parseMajorMinor,
  readProjectFeatureVersion,
} from '../../src/utils/engine-version.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

const projectWithFeatures = (features: string): string =>
  tmp.makeProject('engine-version-', `config_version=5\n\n[application]\n${features}`);

describe('parseMajorMinor', () => {
  it.each([
    ['4.6.2.stable.mono.official.x', { major: 4, minor: 6 }],
    ['4.3.stable', { major: 4, minor: 3 }],
    ['4.10', { major: 4, minor: 10 }],
  ])('reads %s', (text, expected) => {
    expect(parseMajorMinor(text)).toEqual(expected);
  });

  it.each(['', 'garbage', 'v4.3', '4', '4.x'])('returns null for %j', (text) => {
    expect(parseMajorMinor(text)).toBeNull();
  });
});

describe('readProjectFeatureVersion', () => {
  it('reads the first N.N element of config/features', () => {
    const dir = projectWithFeatures(
      'config/features=PackedStringArray("Forward Plus", "4.4", "C#")\n',
    );
    expect(readProjectFeatureVersion(dir)).toEqual({ major: 4, minor: 4 });
  });

  it('returns null without a version element, without the key, or without a project', () => {
    expect(
      readProjectFeatureVersion(projectWithFeatures('config/features=PackedStringArray("C#")\n')),
    ).toBeNull();
    expect(readProjectFeatureVersion(projectWithFeatures(''))).toBeNull();
    expect(readProjectFeatureVersion(tmp.make('engine-version-empty-'))).toBeNull();
  });
});

describe('engineNewerThanProject', () => {
  const dir = (): string =>
    projectWithFeatures('config/features=PackedStringArray("4.4", "Forward Plus")\n');

  it('returns both versions when the engine is newer', () => {
    expect(engineNewerThanProject('4.6.2.stable', dir())).toEqual({
      engine: { major: 4, minor: 6 },
      project: { major: 4, minor: 4 },
    });
    expect(engineNewerThanProject('5.0.stable', dir())).not.toBeNull();
  });

  it('returns null when the engine is equal or older', () => {
    expect(engineNewerThanProject('4.4.1.stable', dir())).toBeNull();
    expect(engineNewerThanProject('4.3.stable', dir())).toBeNull();
  });

  it('returns null when either version cannot be read', () => {
    expect(engineNewerThanProject('garbage', dir())).toBeNull();
    expect(engineNewerThanProject('4.6.stable', projectWithFeatures(''))).toBeNull();
  });
});
