import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, it, expect } from 'vitest';
import {
  MAX_COMMENT_RUN_LINES,
  MAX_COMMENT_SHARE,
  MIN_COMMENT_LINES_FOR_SHARE,
  measureDiff,
  reportStagedComments,
  warningsFor,
} from '../../scripts/comment-share.js';

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'comment-share.js');
const CODE_LINES_WITH_HAZARDS = 30;
const HAZARD_COMMENTS = 3;
const SPREAD_STRIDE = 10;

/** One added hunk of `lines` for `path`, in `git diff --unified=0` shape. */
function hunk(startLine: number, lines: string[]): string {
  return `@@ -0,0 +${startLine},${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
}

function fileDiff(path: string, hunks: string[]): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.join('')}`;
}

function warningsOf(diff: string): string[] {
  return warningsFor(measureDiff(diff));
}

const codeLines = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `const v${i} = ${i};`);
const commentLines = (n: number): string[] => Array.from({ length: n }, (_, i) => `// note ${i}`);

describe('comment-share', () => {
  it('warns on a comment-heavy added block in src', () => {
    const lines: string[] = [];
    for (let i = 0; i < MIN_COMMENT_LINES_FOR_SHARE * 2; i++) {
      lines.push(`// why ${i}`, `const v${i} = ${i};`);
    }
    const warnings = warningsOf(fileDiff('src/utils/a.ts', [hunk(1, lines)]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('src/utils/a.ts');
    expect(warnings[0]).toContain('50%');
  });

  it('stays silent on a code-only diff', () => {
    expect(warningsOf(fileDiff('src/utils/a.ts', [hunk(1, codeLines(40))]))).toEqual([]);
  });

  it('warns on a three-line comment run and not on a two-line run', () => {
    const three = [...codeLines(40), ...commentLines(MAX_COMMENT_RUN_LINES + 1), 'run();'];
    const two = [...codeLines(40), ...commentLines(MAX_COMMENT_RUN_LINES), 'run();'];
    const warned = warningsOf(fileDiff('src/a.ts', [hunk(1, three)]));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('3-line comment run');
    expect(warningsOf(fileDiff('src/a.ts', [hunk(1, two)]))).toEqual([]);
  });

  it('does not join comment lines from separate hunks into one run', () => {
    const diff = fileDiff('src/a.ts', [
      hunk(1, [...codeLines(40), '// one', '// two']),
      hunk(200, ['// three', '// four', ...codeLines(40)]),
    ]);
    expect(warningsOf(diff)).toEqual([]);
  });

  it('stays silent on thirty code lines with three one-line hazard comments', () => {
    const lines = codeLines(CODE_LINES_WITH_HAZARDS).flatMap((line, i) =>
      i % SPREAD_STRIDE === 0 ? ['// hazard', line] : [line],
    );
    expect(lines.filter((l) => l.startsWith('//'))).toHaveLength(HAZARD_COMMENTS);
    expect(warningsOf(fileDiff('src/a.ts', [hunk(1, lines)]))).toEqual([]);
  });

  it('warns on a comment-heavy added block in a tests file', () => {
    const lines = Array.from({ length: MIN_COMMENT_LINES_FOR_SHARE * 2 }, (_, i) =>
      i % 2 === 0 ? `// why ${i}` : `expect(${i}).toBe(${i});`,
    );
    const warnings = warningsOf(fileDiff('tests/unit/a.test.ts', [hunk(1, lines)]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('tests/unit/a.test.ts');
  });

  it('ignores files outside src and tests', () => {
    const noisy = commentLines(20);
    const diff =
      fileDiff('scripts/a.js', [hunk(1, noisy)]) +
      fileDiff('docs/a.ts', [hunk(1, noisy)]) +
      fileDiff('src/readme.md', [hunk(1, noisy)]);
    expect(measureDiff(diff)).toEqual([]);
    expect(warningsOf(diff)).toEqual([]);
  });

  it('reads GDScript hash comments and block-comment continuation lines', () => {
    const gd = warningsOf(
      fileDiff('src/scripts/a.gd', [hunk(1, ['x = 1', '# a', '## b', '# c', 'y = 2'])]),
    );
    expect(gd).toHaveLength(1);
    expect(gd[0]).toContain('3-line comment run');
    const block = warningsOf(
      fileDiff('src/a.ts', [hunk(1, ['/**', ' * a', ' */', 'export const x = 1;'])]),
    );
    expect(block).toHaveLength(1);
  });

  it('keeps the share threshold below the comment-heavy case and above the hazard case', () => {
    const hazardShare = HAZARD_COMMENTS / (CODE_LINES_WITH_HAZARDS + HAZARD_COMMENTS);
    expect(hazardShare).toBeLessThan(MAX_COMMENT_SHARE);
  });

  it('reports a read failure on stderr and counts no warnings', () => {
    const written: string[] = [];
    const count = reportStagedComments(
      () => {
        throw new Error('git exploded');
      },
      (msg: string) => written.push(msg),
    );
    expect(count).toBe(0);
    expect(written.join('\n')).toContain('skipped: git exploded');
  });

  it('exits 0 from the command line when git fails', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, GIT_DIR: join(tmpdir(), 'comment-share-no-such-git-dir') },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[comment-share] skipped');
  });
});
