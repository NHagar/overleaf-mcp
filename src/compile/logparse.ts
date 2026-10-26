// Parses a LaTeX log (run with -file-line-error) into errors and warnings with stable keys,
// so a new compile can be compared against a baseline even after lines shift.

export interface LogIssue {
  severity: 'error' | 'warning';
  kind: string;
  file: string | null;
  line: number | null;
  message: string;
  /** Source text at the reported line, from the log's `l.<n> …` context, if present. */
  context: string | null;
  key: string;
}

function normMessage(s: string): string {
  return s
    .replace(/on input line \d+\.?/g, '')
    .replace(/at lines? \d+(--\d+)?/g, '')
    .replace(/on page \d+/g, '')
    .replace(/\d+(\.\d+)?pt/g, '#pt')
    .replace(/badness \d+/g, 'badness #')
    .replace(/\s+/g, ' ')
    .trim();
}

function key(i: Omit<LogIssue, 'key'>): string {
  return [i.severity, i.kind, i.file ?? '', normMessage(i.message), (i.context ?? '').replace(/\s+/g, ' ').trim()].join('|');
}

export function parseLog(log: string): LogIssue[] {
  const lines = log.split(/\r?\n/);
  const issues: LogIssue[] = [];
  const push = (i: Omit<LogIssue, 'key'>) => issues.push({ ...i, key: key(i) });
  const contextAfter = (idx: number): string | null => {
    for (let k = idx + 1; k < Math.min(lines.length, idx + 12); k++) {
      const m = /^l\.\d+ (.*)$/.exec(lines[k]);
      if (m) return m[1];
    }
    return null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = /^(\.?\/?[^:\s][^:]*\.(?:tex|sty|cls|bbl|ltx|aux)):(\d+): (.*)$/.exec(l);
    if (m) {
      push({ severity: 'error', kind: 'latex', file: m[1].replace(/^\.\//, ''), line: Number(m[2]), message: m[3], context: contextAfter(i) });
      continue;
    }
    if (l.startsWith('! ')) {
      push({ severity: 'error', kind: 'latex', file: null, line: null, message: l.slice(2), context: contextAfter(i) });
      continue;
    }
    m = /^(LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/.exec(l);
    if (m) {
      let msg = m[4];
      // Continuation lines are indented with "(pkg)" or spaces.
      while (i + 1 < lines.length && /^(\(\S+\)\s+|\s{4,})\S/.test(lines[i + 1])) msg += ' ' + lines[++i].replace(/^\(\S+\)\s+/, '').trim();
      const kind = m[2] ? `package:${m[2]}` : m[3] ? `class:${m[3]}` : 'latex';
      const ln = /on input line (\d+)/.exec(msg);
      push({ severity: 'warning', kind, file: null, line: ln ? Number(ln[1]) : null, message: msg, context: null });
      continue;
    }
    m = /^(Overfull|Underfull) \\([hv]box) (.*)$/.exec(l);
    if (m) {
      const ln = /at lines? (\d+)/.exec(m[3]);
      push({ severity: 'warning', kind: `${m[1].toLowerCase()}-${m[2]}`, file: null, line: ln ? Number(ln[1]) : null, message: `${m[1]} \\${m[2]} ${m[3]}`, context: lines[i + 1]?.trim() || null });
    }
  }
  return issues;
}

export function isFatal(issues: LogIssue[], pdfProduced: boolean): boolean {
  return !pdfProduced || issues.some((i) => i.severity === 'error');
}
