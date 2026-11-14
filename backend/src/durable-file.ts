import { randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';

/** Replaces `file` with `value` so that a crash leaves either the old or the new content, never a torn write. */
export function writePrivateJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, file);
  const directory = openSync(dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

const foreign = (stat: Stats) => process.getuid !== undefined && stat.uid !== process.getuid();
const unsafeDirectory = (stat: Stats) => !stat.isDirectory() || (stat.mode & 0o022) !== 0 || foreign(stat);
const unsafeFile = (stat: Stats, maxBytes: number) => !stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || foreign(stat);

/** The parsed file, or null when it does not exist. A file others could have written, swapped or deleted is refused with `unsafeCode`. */
export function readPrivateJson(file: string, maxBytes: number, unsafeCode: string): unknown {
  const directory = lstatSync(dirname(file), { throwIfNoEntry: false });
  if (!directory) return null;
  if (unsafeDirectory(directory)) throw new Error(unsafeCode);
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return null;
  if (!entry.isFile()) throw new Error(unsafeCode);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (unsafeFile(fstatSync(fd), maxBytes)) throw new Error(unsafeCode);
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
