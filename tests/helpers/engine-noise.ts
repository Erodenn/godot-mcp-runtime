/**
 * Godot exit noise that can land on stdout.
 *
 * When a headless operation quits early, some engine builds print RID-leak
 * warnings at process exit on stdout rather than stderr (seen on 4.7.2:
 * "ERROR: 2 RID allocations of type '...' were leaked at exit."). Whether
 * they appear depends on what the engine allocated before quitting, e.g.
 * fonts for a Label in the fixture scene. Production code already treats
 * these lines as noise (STDOUT_NOISE_LINE_PATTERN in src/utils/headless-op.ts).
 *
 * Tests asserting "no payload was printed" should strip only this exact
 * line shape and keep the rest of the assertion strict, so any other
 * stdout output still fails them.
 */

const RID_LEAK_LINE = /^ERROR: \d+ RID allocations of type '[^']*' were leaked at exit\.$/;

export function stripExitLeakNoise(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) => !RID_LEAK_LINE.test(line.trim()))
    .join('\n')
    .trim();
}
