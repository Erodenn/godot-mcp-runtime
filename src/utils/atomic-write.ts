import { dirname, join } from 'path';
import { writeFileSync, renameSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';

/**
 * Number of random hex bytes appended to a temp-file name, alongside the
 * writing process's pid, to make concurrent writers to the same target from
 * the same process collide-free without a lock.
 */
const TEMP_SUFFIX_RANDOM_BYTES = 4;

/**
 * Write `content` to `path` atomically: write to a same-directory temp file,
 * then rename it over the target. A rename onto an existing file is atomic on
 * POSIX and on Windows (NTFS `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`,
 * which `fs.renameSync` requests), so a reader never observes a partially
 * written target.
 *
 * Windows can refuse the replace with `EPERM`/`EBUSY`/`EACCES` while another
 * process has the target file open without `FILE_SHARE_DELETE` (uncommon for
 * plain text files, but not impossible for a file an antivirus or indexer has
 * briefly opened). On that failure, falls back to a direct non-atomic
 * `writeFileSync`, which was the prior behavior everywhere this replaces a
 * plain `writeFileSync` call.
 *
 * The temp file is always cleaned up, on both the success and fallback paths.
 */
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
