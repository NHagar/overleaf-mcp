import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { makeEnv, project } from './helpers.js';

async function connect() {
  const env = makeEnv([project('p1', 'article')]);
  const server = buildServer(env.ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
  };
  return { env, client, callTool };
}

describe('MCP server', () => {
  it('lists the seven tools', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['batch', 'bib', 'comments', 'compile', 'guide', 'read', 'update']);
  });

  it('runs read and update end to end, with refusals in the error shape', async () => {
    const { callTool } = await connect();
    const o = await callTool('read', { kind: 'outline', projectId: 'p1' });
    expect(o.body.outline).toContain("<section id='sec:methods'");
    const fileVer = Number(/<file path='main.tex' ver='(\d+)'/.exec(o.body.outline)![1]);
    const ok = await callTool('update', {
      projectId: 'p1',
      file: 'main.tex',
      ifVersion: fileVer,
      ops: [{ op: 'replace', target: { kind: 'find', text: 'two decades' }, with: 'twenty years' }],
    });
    expect(ok.isError).toBe(false);
    expect(ok.body.ok).toBe(true);
    const bad = await callTool('update', {
      projectId: 'p1',
      file: 'main.tex',
      ifVersion: fileVer + 1,
      ops: [{ op: 'delete', target: { kind: 'unit', id: 'fig:pipeline' } }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.body).toMatchObject({ ok: false, code: 'missing_guard' });
    const missing = await callTool('read', { kind: 'unit', projectId: 'p1' });
    expect(missing.body.code).toBe('invalid_op');
  });
});
