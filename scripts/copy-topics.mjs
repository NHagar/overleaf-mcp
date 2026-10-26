// Copies guide topics next to the compiled server so `guide` can find them.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/guide/topics', { recursive: true });
cpSync('src/guide/topics', 'dist/guide/topics', { recursive: true });
