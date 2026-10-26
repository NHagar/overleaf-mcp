import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingChange } from '../src/adapters/adapter.js';
import { RealtimeBackend, RealtimeProject, applyShareOps, splicesToOps } from '../src/adapters/realtime/backend.js';
import { decodePacket, encodePacket, PacketType } from '../src/adapters/realtime/socketio.js';
import { FakeOverleaf } from './fake-overleaf.js';

const DOC = 'dddddddddddddddddddddddd';
const SUB = 'eeeeeeeeeeeeeeeeeeeeeeee';

describe('socket.io 0.9 framing', () => {
  it('round-trips events and acks', () => {
    const ev = encodePacket({ type: PacketType.event, id: '7', ack: true, data: { name: 'joinDoc', args: ['x', -1, { a: 'b:c' }] } });
    expect(ev).toBe('5:7+::{"name":"joinDoc","args":["x",-1,{"a":"b:c"}]}');
    expect(decodePacket(ev)).toMatchObject({ type: 5, id: '7', ack: true, data: { name: 'joinDoc' } });
    expect(decodePacket('6:::7+[null,["a:b"],3]')).toMatchObject({ type: 6, id: '7', data: [null, ['a:b'], 3] });
    expect(decodePacket('2::')).toMatchObject({ type: 2 });
    expect(decodePacket('1::')).toMatchObject({ type: 1 });
  });

  it('builds ShareJS ops right to left', () => {
    const base = 'abcdef';
    const ops = splicesToOps(base, { baseText: base, splices: [{ start: 1, end: 2, text: 'X' }, { start: 4, end: 4, text: 'Y' }] });
    expect(ops).toEqual([{ p: 4, i: 'Y' }, { p: 1, d: 'b' }, { p: 1, i: 'X' }]);
    expect(applyShareOps(base, ops)).toBe('aXcdYef');
  });
});

describe('realtime adapter against a fake Overleaf', () => {
  let srv: FakeOverleaf;
  let project: RealtimeProject;
  const events: IncomingChange[] = [];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await wait(20);
  };

  beforeEach(async () => {
    srv = new FakeOverleaf();
    srv.addDoc(DOC, 'main.tex', '\\begin{document}\nCafé 日本 text.\n\nSecond para.\n\\end{document}');
    srv.addDoc(SUB, 'sections/intro.tex', 'Intro.');
    await srv.start();
    events.length = 0;
    const backend = new RealtimeBackend(srv.url, 'good');
    project = (await backend.openProject(srv.projectId)) as RealtimeProject;
    project.onChange((c) => events.push(c));
  });

  afterEach(async () => {
    await project.close();
    await srv.stop();
  });

  it('lists projects, reads the tree and settings', async () => {
    const backend = new RealtimeBackend(srv.url, 'overleaf.sid=good');
    expect(await backend.listProjects()).toEqual([{ projectId: srv.projectId, name: 'Paper', lastUpdated: '2026-10-01', accessLevel: 'owner' }]);
    expect(project.tree().map((e) => `${e.path}:${e.kind}`)).toEqual(['fig.png:binary', 'main.tex:doc', 'sections/intro.tex:doc']);
    expect(project.settings()).toMatchObject({ rootDoc: 'main.tex', compiler: 'xelatex', texliveYear: '2024', trackChangesAvailable: true, userId: srv.userId });
    expect(await project.readBinary('fig.png')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('decodes UTF-8 lines from joinDoc', async () => {
    const d = await project.readDoc('main.tex');
    expect(d.text).toContain('Café 日本 text.');
    expect(d.version).toBe(5);
  });

  it('sends a tracked edit with meta.tc and picks up its change id', async () => {
    const d = await project.readDoc('main.tex');
    const at = d.text.indexOf('Second');
    const r = await project.applyEdit('main.tex', { baseText: d.text, splices: [{ start: at, end: at, text: 'Ünïcode ' }] }, { baseVersion: d.version, tracked: true });
    const sent = srv.received.find((m) => m.name === 'applyOtUpdate')!;
    const update = sent.args[1] as { meta: { tc: string }; v: number; op: unknown[] };
    expect(update.meta.tc).toMatch(/^[0-9a-f]{18}$/);
    expect(update.v).toBe(5);
    expect(srv.docs.get(DOC)!.text).toContain('Ünïcode Second');
    expect(r.trackedChangeIds).toEqual([`${update.meta.tc}000001`]);
    const after = await project.readDoc('main.tex');
    expect(after.version).toBe(6);
    expect(after.text).toBe(srv.docs.get(DOC)!.text);
    expect(after.ranges.changes[0]).toMatchObject({ kind: 'insert', text: 'Ünïcode ' });
  });

  it('sends untracked edits without meta', async () => {
    const d = await project.readDoc('main.tex');
    await project.applyEdit('main.tex', { baseText: d.text, splices: [{ start: 0, end: 0, text: '% x\n' }] }, { baseVersion: d.version, tracked: false });
    expect((srv.received.find((m) => m.name === 'applyOtUpdate')!.args[1] as Record<string, unknown>).meta).toBeUndefined();
  });

  it('applies coauthor updates and reports them', async () => {
    await project.readDoc('main.tex');
    srv.remoteEdit(DOC, [{ p: 0, i: '% hello\n' }]);
    await until(() => events.length > 0);
    expect(events[0]).toMatchObject({ path: 'main.tex', source: 'remote', userIds: ['cccccccccccccccccccccccc'] });
    expect((await project.readDoc('main.tex')).text.startsWith('% hello\n')).toBe(true);
  });

  it('resyncs after a gap in versions', async () => {
    await project.readDoc('main.tex');
    srv.remoteEdit(DOC, [{ p: 0, i: 'A' }], { silent: true }); // client never sees v5
    srv.remoteEdit(DOC, [{ p: 0, i: 'B' }]); // v6 arrives: gap
    await until(() => events.some((e) => e.source === 'resync'));
    const d = await project.readDoc('main.tex');
    expect(d.text).toBe(srv.docs.get(DOC)!.text);
    expect(d.version).toBe(7);
  });

  it('survives a concurrent edit landing before ours', async () => {
    const d = await project.readDoc('main.tex');
    srv.beforeApply = () => srv.remoteEdit(DOC, [{ p: 0, i: 'COAUTHOR ' }]);
    const at = d.text.indexOf('Second');
    await project.applyEdit('main.tex', { baseText: d.text, splices: [{ start: at, end: at + 6, text: 'Next' }] }, { baseVersion: d.version, tracked: false });
    const after = await project.readDoc('main.tex');
    expect(after.text).toBe(srv.docs.get(DOC)!.text);
    expect(after.text.startsWith('COAUTHOR ')).toBe(true);
    expect(after.text).toContain('Next para.');
  });

  it('reverts its own edit', async () => {
    const d = await project.readDoc('main.tex');
    const at = d.text.indexOf('Second');
    const r = await project.applyEdit('main.tex', { baseText: d.text, splices: [{ start: at, end: at + 6, text: 'Third' }] }, { baseVersion: d.version, tracked: false });
    await project.revertEdit('main.tex', r);
    expect(srv.docs.get(DOC)!.text).toBe(d.text);
  });

  it('creates a comment via HTTP plus a comment op', async () => {
    const d = await project.readDoc('main.tex');
    const at = d.text.indexOf('Second para.');
    const { threadId } = await project.comments.create('main.tex', at, 'Second para.', 'Why?');
    expect(srv.threads[threadId].messages).toHaveLength(1);
    expect(srv.docs.get(DOC)!.comments[0].op).toEqual({ c: 'Second para.', p: at, t: threadId });
    const threads = await project.comments.list();
    expect(threads[0]).toMatchObject({ threadId, path: 'main.tex', messages: [{ content: 'Why?', authorName: 'Agent User' }] });
  });

  it('reports an expired cookie as auth_expired', async () => {
    const backend = new RealtimeBackend(srv.url, 'overleaf.sid=expired');
    await expect(backend.openProject(srv.projectId)).rejects.toMatchObject({ code: 'auth_expired' });
  });
});
