/** Some engine builds print RID-leak warnings on stdout at exit when a headless op quits early (seen on 4.7.2), depending on what was allocated; strip only this exact line shape (see STDOUT_NOISE_LINE_PATTERN in src/utils/headless-op.ts). */

const RID_LEAK_LINE = /^ERROR: \d+ RID allocations of type '[^']*' were leaked at exit\.$/;

export function stripExitLeakNoise(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) => !RID_LEAK_LINE.test(line.trim()))
    .join('\n')
    .trim();
}
