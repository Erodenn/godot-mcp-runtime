import { cpSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'src', 'scripts');
const dst = join(root, 'dist', 'scripts');

mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
