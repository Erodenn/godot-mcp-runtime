import { dirname, join } from 'path';
import { writeFileSync, renameSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';

/** Random hex bytes appended to a temp-file name beside the pid, so concurrent writers to one target from one process do not collide without a lock. */
const TEMP_SUFFIX_RANDOM_BYTES = 4;

/** Writes `content` to `path` atomically: a same-directory temp file renamed over the target (atomic on POSIX and NTFS), so a reader never sees a partial file.
 * Windows can refuse the replace with `EPERM`/`EBUSY`/`EACCES` while another process (antivirus, indexer) holds the target open without `FILE_SHARE_DELETE`; it then falls back to a direct non-atomic write. The temp file is always cleaned up. */
export function writeFileAtomicSync(path: string, content: string): void {
  const dir = dirname(path);
  const tempPath = join(
    dir,
    `.${process.pid}.${randomBytes(TEMP_SUFFIX_RANDOM_BYTES).toString('hex')}.tmp`,
  );

  writeFileSync(tempPath, content, 'utf8');
  try {
    renameSync(tempPath, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      try {
        writeFileSync(path, content, 'utf8');
      } finally {
        unlinkTempQuietly(tempPath);
      }
      return;
    }
    unlinkTempQuietly(tempPath);
    throw err;
  }
}

function unlinkTempQuietly(tempPath: string): void {
  try {
    unlinkSync(tempPath);
  } catch {
    // Already gone (rename consumed it) or never created — either way, nothing
    // to clean up.
  }
}
