// Stands in for dist/sweep-stranded.js: waits, then records the project path it was given, so a test sees both the launch and that the game outlived it.
import { writeFileSync } from 'fs';
import { join } from 'path';

export const STRANDED_SWEEP_PROBE_MARKER = '.stranded-sweep-ran';
const PROBE_DELAY_MS = 1000;

const projectPath = process.argv[2];
if (projectPath) {
  setTimeout(() => {
    writeFileSync(join(projectPath, STRANDED_SWEEP_PROBE_MARKER), projectPath);
  }, PROBE_DELAY_MS);
}
