// Per-project change log for `read changes sinceVersion` (spec §7.5, §8.2).

export interface ChangeEntry {
  ver: number;
  file: string;
  changed: string[]; // unit IDs added or whose hash changed
  deleted: string[]; // unit IDs that no longer exist
  by: string[]; // user IDs, or "agent" for this server's edits
  ts: string;
}

export class ChangeLog {
  private entries: ChangeEntry[] = [];
  /** Lowest version the log can answer from (entries with ver > floor are all present). */
  private floor = 0;
  ver = 0;

  constructor(private capacity = 2000) {}

  record(file: string, changed: string[], deleted: string[], by: string[]): number {
    this.ver++;
    this.entries.push({ ver: this.ver, file, changed, deleted, by, ts: new Date().toISOString() });
    while (this.entries.length > this.capacity) this.floor = this.entries.shift()!.ver;
    return this.ver;
  }

  /** Entries after `since`, or null if the log no longer reaches back that far. */
  since(since: number): ChangeEntry[] | null {
    if (since < this.floor) return null;
    return this.entries.filter((e) => e.ver > since);
  }
}

/** Unit ID → hash maps of a file before and after a change. */
export function diffUnitMaps(before: Map<string, string>, after: Map<string, string>): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [id, h] of after) if (before.get(id) !== h) changed.push(id);
  for (const id of before.keys()) if (!after.has(id)) deleted.push(id);
  return { changed, deleted };
}
