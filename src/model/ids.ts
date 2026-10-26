// Unit ID resolution (spec §7.3).

import { Refusal } from '../errors.js';
import type { FileOutline, ProjectOutline, Unit } from './outline.js';

export function isPathId(id: string): boolean {
  return id.includes('/') && /\/(§[\d.]+|¶\d+|env\d+|preamble)(\/|$)/.test(id);
}

/** "sections/a.tex/§2/¶3" → "sections/a.tex". */
export function fileOfPathId(id: string): string | undefined {
  const parts = id.split('/');
  const k = parts.findIndex((p) => /^(§[\d.]+|¶\d+|env\d+|preamble)$/.test(p));
  return k > 0 ? parts.slice(0, k).join('/') : undefined;
}

/** Compact description of a unit for refusal payloads. */
export function describeUnit(f: FileOutline | undefined, u: Unit) {
  return {
    id: u.id,
    kind: u.kind,
    file: u.file,
    lines: `${u.startLine}-${u.endLine}`,
    hash: u.hash,
    ...(u.title ? { title: u.title } : {}),
    ...(u.envName ? { envName: u.envName } : {}),
    ...(f && u.kind !== 'section' && u.kind !== 'file' ? { text: f.text.slice(u.start, u.end) } : {}),
  };
}

export function fileSummary(f: FileOutline) {
  return {
    file: f.path,
    parse: f.parse,
    units: f.units.map((u) => ({ id: u.id, kind: u.kind, lines: `${u.startLine}-${u.endLine}`, hash: u.hash, ...(u.title ? { title: u.title } : {}) })),
  };
}

/**
 * Resolves a unit ID. With `ifHash`, a path ID whose unit has a different hash is looked up by
 * hash in the same file (the unit moved). Label IDs with a stale hash are a guard mismatch.
 */
export function resolveUnit(outline: ProjectOutline, id: string, opts: { ifHash?: string; file?: string } = {}): Unit {
  const u = outline.byId.get(id);
  const fileOf = (p: string) => outline.files.get(p);
  const fileFromId = opts.file ?? (u ? u.file : fileOfPathId(id));

  const searchByHash = (file: string | undefined): Unit | null => {
    if (!opts.ifHash || !file) return null;
    const f = fileOf(file);
    if (!f) return null;
    const hits = [f.root, ...f.units].filter((x) => x.hash === opts.ifHash);
    return hits.length === 1 ? hits[0] : null;
  };

  if (u) {
    if (opts.file && u.file !== opts.file) {
      throw new Refusal('unit_not_found', `Unit ${id} is in ${u.file}, not ${opts.file}.`, describeUnit(fileOf(u.file), u));
    }
    if (!opts.ifHash || u.hash === opts.ifHash) return u;
    if (isPathId(id)) {
      const moved = searchByHash(u.file);
      if (moved) return moved;
      const f = fileOf(u.file)!;
      throw new Refusal(
        'unit_not_found',
        `No unit in ${u.file} has hash ${opts.ifHash}; the unit at ${id} changed or moved. Re-read the file outline and the unit, then retry.`,
        { unitAtPath: describeUnit(f, u), outline: fileSummary(f) },
      );
    }
    throw new Refusal(
      'guard_mismatch',
      `Unit ${id} has hash ${u.hash}, not ${opts.ifHash}: it changed since you read it. Re-read it with read kind "unit" and rebuild the edit.`,
      describeUnit(fileOf(u.file), u),
    );
  }
  const moved = searchByHash(fileFromId);
  if (moved) return moved;
  const f = fileFromId ? fileOf(fileFromId) : undefined;
  throw new Refusal(
    'unit_not_found',
    `No unit with ID ${id}. Read the outline to get current IDs.`,
    f ? { outline: fileSummary(f) } : undefined,
  );
}
