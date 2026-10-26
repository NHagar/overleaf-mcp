// Phase 0 acceptance spike (spec §5). Against a real Overleaf server, this:
//   1. joins a project and reads a doc,
//   2. inserts one sentence as a tracked change,
//   3. adds a comment on it,
//   4. prints edits made from a browser for 60 seconds,
// and writes every Socket.IO frame to spike-capture.jsonl for docs/PROTOCOL.md.
//
// It changes the project, so it only runs with --yes. Use a scratch project.
//
//   OVERLEAF_COOKIE='overleaf_session2=…' npx tsx scripts/phase0-spike.ts <projectId> [doc.tex] --yes [--base-url https://www.overleaf.com] [--watch 60]
//
// --force-tracked sends meta.tc even if the project reports no track-changes feature
// (Community Edition), to check whether the server still records the change.

import { appendFileSync, writeFileSync } from 'node:fs';
import { RealtimeBackend } from '../src/adapters/realtime/backend.js';

const args = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith('--') && !['--base-url', '--watch'].includes(args[i - 1]));
const [projectId, docArg] = positional;
const baseUrl = flag('--base-url', process.env.OVERLEAF_BASE_URL ?? 'https://www.overleaf.com')!;
const watchSeconds = Number(flag('--watch', '60'));
const cookie = process.env.OVERLEAF_COOKIE;

if (!projectId || !cookie) {
  console.error('usage: OVERLEAF_COOKIE=… npx tsx scripts/phase0-spike.ts <projectId> [doc.tex] --yes');
  process.exit(2);
}
if (!args.includes('--yes')) {
  console.error(`This inserts a tracked sentence and a comment into project ${projectId} on ${baseUrl}. Re-run with --yes to proceed.`);
  process.exit(2);
}

const CAPTURE = 'spike-capture.jsonl';
writeFileSync(CAPTURE, '');
const trace = (dir: 'in' | 'out', raw: string) => {
  if (raw === '2::') return; // heartbeats
  appendFileSync(CAPTURE, JSON.stringify({ t: new Date().toISOString(), dir, raw }) + '\n');
};

const step = (s: string) => console.log(`\n== ${s}`);

async function main() {
  const backend = new RealtimeBackend(baseUrl, cookie!, trace, args.includes('--force-tracked'));
  step('list projects');
  const projects = await backend.listProjects();
  console.log(`${projects.length} projects; target present: ${projects.some((p) => p.projectId === projectId)}`);

  step('join project');
  const project = await backend.openProject(projectId);
  const settings = project.settings();
  console.log(JSON.stringify(settings, null, 2));
  console.log(project.tree().map((e) => `  ${e.kind.padEnd(6)} ${e.path}`).join('\n'));
  if (!settings.trackChangesAvailable) {
    console.log('\n!! features.trackChanges is false for this project. Per-update tracking (meta.tc) may still be stored by the server');
    console.log('!! but will not be visible in the review panel. Spec D2 depends on this: report back before Phase 1.');
  }

  const path = docArg ?? settings.rootDoc;
  if (!path) throw new Error('No doc given and the project has no root doc.');
  step(`read ${path}`);
  const doc = await project.readDoc(path);
  console.log(`version ${doc.version}, ${doc.text.length} chars, type ${doc.otType}, ${doc.ranges.changes.length} tracked changes, ${doc.ranges.comments.length} comments`);

  step('insert a tracked sentence');
  const sentence = 'This sentence was inserted by the overleaf-mcp Phase 0 spike as a tracked change.';
  const endDoc = doc.text.indexOf('\\end{document}');
  const at = endDoc === -1 ? doc.text.length : endDoc;
  const receipt = await project.applyEdit(path, { baseText: doc.text, splices: [{ start: at, end: at, text: `${sentence}\n\n` }] }, { baseVersion: doc.version, tracked: true });
  console.log(`applied at v${receipt.appliedAt}; tracked change ids: ${receipt.trackedChangeIds.join(', ') || '(none found — tracking may not be honoured)'}`);

  step('comment on it');
  const after = await project.readDoc(path);
  console.log(`tracked changes after insert: ${JSON.stringify(after.ranges.changes)}`);
  const anchor = 'Phase 0 spike';
  const pos = after.text.indexOf(anchor);
  try {
    const { threadId } = await project.comments.create(path, pos, anchor, 'Comment created by the overleaf-mcp Phase 0 spike.');
    console.log(`thread ${threadId}`);
  } catch (err) {
    console.log(`!! comment failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  step(`watching for browser edits for ${watchSeconds}s — type in ${path} now`);
  project.onChange((c) => console.log(`  ${new Date().toISOString()} ${c.source} ${c.path} v${c.version} by ${c.userIds.join(',') || '?'}`));
  await new Promise((r) => setTimeout(r, watchSeconds * 1000));
  const final = await project.readDoc(path);
  // Show text and timestamp: an untracked edit typed inside our tracked insert splits it, and
  // the split-off piece gets a new id but keeps our timestamp.
  console.log(`final version ${final.version}; tracked changes now:`);
  for (const c of final.ranges.changes) console.log(`  ${c.id} ${c.kind} at ${c.pos} by ${c.userId} ${c.ts}: ${JSON.stringify(c.text)}`);

  await project.close();
  console.log(`\nWire capture: ${CAPTURE}. Check the browser: the sentence should show as a tracked insertion with the comment in the review panel.`);
}

main().catch((err) => {
  console.error(`\nspike failed: ${err instanceof Error ? `${(err as { code?: string }).code ?? ''} ${err.message}` : String(err)}`);
  process.exit(1);
});
