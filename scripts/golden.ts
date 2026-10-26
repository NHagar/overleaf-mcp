// Regenerates test/fixtures/*/expected-outline.xml. Review the diff before committing:
// the golden files are the spec for the parser's output.
//   npx tsx scripts/golden.ts

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProjectOutline } from '../src/model/outline.js';
import { renderOutline } from '../src/tools/render.js';
import { FIXTURES, loadFixture } from '../test/helpers.js';

export function goldenFor(name: string): string {
  const files = loadFixture(name);
  const outline = buildProjectOutline(Object.entries(files).map(([path, text]) => ({ path, text })), 'main.tex');
  const docs = new Map(Object.entries(files).map(([path, text]) => [path, { path, text, version: 0, ranges: { changes: [], comments: [] }, otType: 'sharejs-text-ot' }]));
  return renderOutline(outline, docs, { projectId: name, ver: 0, compiler: 'pdflatex', texlive: '2025', full: true }) + '\n';
}

if (process.argv[1]?.endsWith('golden.ts')) {
  for (const name of ['article', 'thesis', 'journal', 'generated', 'review']) {
    writeFileSync(join(FIXTURES, name, 'expected-outline.xml'), goldenFor(name));
    console.log(`wrote ${name}/expected-outline.xml`);
  }
}
