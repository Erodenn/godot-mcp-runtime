import { describe, it, expect } from 'vitest';
import { confirmFirstUse, withConfirmationWarnings } from '../../src/utils/confirmation.js';
import { createErrorResponse } from '../../src/utils/error-response.js';
import { ok, err } from '../../src/utils/result.js';
import type { Elicitor } from '../../src/utils/mcp-context.js';
import { makeContext } from '../helpers/runtime-fakes.js';
import { useTmpDirs } from '../helpers/tmp.js';
import { hasError, unwrap } from '../helpers/assertions.js';

const tmp = useTmpDirs();

function countingElicitor(): { elicit: Elicitor; calls: () => number } {
  let count = 0;
  return {
    elicit: async () => {
      count++;
      return { action: 'accept', content: { confirm: true } };
    },
    calls: () => count,
  };
}

const swapCase = (path: string): string =>
  path.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

describe('confirmFirstUse confirmation key', () => {
  // Red when the key is the raw path instead of projectPathKey: Windows asks again for D:/Proj vs d:/proj.
  it('does not prompt again under another case spelling where the platform folds case', async () => {
    const dir = tmp.makeProject('confirm-key-fold-');
    const counting = countingElicitor();
    const ctx = makeContext({ elicit: counting.elicit });
    const request = (projectPath: string) => ({
      kind: 'launch' as const,
      toolName: 'run_project',
      projectPath,
    });

    await confirmFirstUse(request(dir), ctx, 'win32');
    await confirmFirstUse(request(swapCase(dir)), ctx, 'win32');

    expect(counting.calls()).toBe(1);
  });

  it('prompts again under another case spelling where the platform does not fold case', async () => {
    const dir = tmp.makeProject('confirm-key-nofold-');
    const counting = countingElicitor();
    const ctx = makeContext({ elicit: counting.elicit });
    const request = (projectPath: string) => ({
      kind: 'script' as const,
      toolName: 'run_script',
      projectPath,
    });

    await confirmFirstUse(request(dir), ctx, 'linux');
    await confirmFirstUse(request(swapCase(dir)), ctx, 'linux');

    expect(counting.calls()).toBe(2);
  });
});

describe('withConfirmationWarnings', () => {
  const WARNING = 'Elicitation disabled; running the script without user confirmation.';

  it('adds the warnings to an error and leaves a success and an empty list alone', () => {
    const failed = withConfirmationWarnings(err(createErrorResponse('boom')), [WARNING]);
    expect(hasError(failed)).toBe(true);
    const texts = unwrap(failed).content.map((c) => c.text ?? '');
    expect(texts[0]).toBe('boom');
    expect(texts.some((text) => text.includes(WARNING))).toBe(true);

    const succeeded = ok({ content: [{ type: 'text', text: 'done' }] });
    expect(withConfirmationWarnings(succeeded, [WARNING])).toEqual(succeeded);

    const quiet = withConfirmationWarnings(err(createErrorResponse('boom')), []);
    expect(unwrap(quiet).content).toHaveLength(1);
  });
});
