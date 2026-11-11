import { describe, it, expect } from 'vitest';
import { declaredParameters, unknownParameterError } from '../../src/utils/unknown-params.js';
import { projectToolDefinitions } from '../../src/tools/project-tools.js';
import { errorText } from '../helpers/assertions.js';

const ALLOWED = ['projectPath', 'pattern', 'fileTypes', 'caseSensitive', 'maxResults'];

describe('unknownParameterError', () => {
  it('returns null when every key is declared', () => {
    expect(unknownParameterError({ projectPath: 'p', pattern: 'x' }, ALLOWED)).toBeNull();
  });

  it('names the unknown key and every declared key', () => {
    const text = errorText(unknownParameterError({ zzz: 1 }, ALLOWED));
    expect(text).toContain('Unknown parameter "zzz"');
    for (const key of ALLOWED) expect(text).toContain(key);
    expect(text).not.toContain('did you mean');
  });

  it('suggests the declared key a near misspelling or other casing meant', () => {
    expect(errorText(unknownParameterError({ patern: 'x' }, ALLOWED))).toContain(
      'did you mean "pattern"',
    );
    expect(errorText(unknownParameterError({ Pattern: 'x' }, ALLOWED))).toContain(
      'did you mean "pattern"',
    );
    expect(errorText(unknownParameterError({ filetypes: [] }, ALLOWED))).toContain(
      'did you mean "fileTypes"',
    );
  });

  it('names every unknown key in one refusal, with the key each one meant', () => {
    const error = unknownParameterError({ patern: 'x', zzz: 1, projectPath: 'p' }, ALLOWED);
    expect(errorText(error)).toContain('Unknown parameters "patern", "zzz" (allowed:');
    expect(errorText(error)).toContain('did you mean "pattern" for "patern"?');
    expect(error?.content[1]?.text).toContain('Check the spelling of "zzz"');
  });

  it('prefers a tool alias over edit distance', () => {
    const error = unknownParameterError({ query: 'x' }, ALLOWED, { aliases: { query: 'pattern' } });
    expect(errorText(error)).toContain('did you mean "pattern"');
  });

  it('reads the declared keys from a tool definition', () => {
    const search = projectToolDefinitions.find((d) => d.name === 'search_project')!;
    expect(declaredParameters(search)).toEqual(ALLOWED);
  });
});
