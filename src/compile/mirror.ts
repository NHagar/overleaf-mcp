// Per-project local mirror of every file, kept current from change events.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class Mirror {
  readonly lock = new Mutex();
  /** Bumped whenever file content changes; the gate compares it with the baseline's. */
  generation = 0;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private full(path: string): string {
    const p = resolve(this.dir, path);
    if (p !== this.dir && !p.startsWith(this.dir + sep)) throw new Error(`Path escapes mirror: ${path}`);
    return p;
  }

  write(path: string, content: string | Buffer): void {
    const p = this.full(path);
    mkdirSync(dirname(p), { recursive: true });
    if (existsSync(p)) {
      const cur = readFileSync(p);
      if (Buffer.isBuffer(content) ? cur.equals(content) : cur.toString('utf8') === content) return;
    }
    writeFileSync(p, content);
    this.generation++;
  }

  read(path: string): string | null {
    const p = this.full(path);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  remove(path: string): void {
    const p = this.full(path);
    if (existsSync(p)) {
      rmSync(p);
      this.generation++;
    }
  }

  path(path: string): string {
    return this.full(path);
  }

  static forProject(root: string, projectId: string): Mirror {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error(`Bad project id: ${projectId}`);
    return new Mirror(join(root, projectId));
  }
}
