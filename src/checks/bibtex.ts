// A tolerant BibTeX reader: enough to list keys and fields and to find where an entry sits.

export interface BibEntry {
  type: string;
  key: string;
  fields: Record<string, string>;
  start: number;
  end: number;
  raw: string;
}

export interface BibParseResult {
  entries: BibEntry[];
  errors: string[];
}

const SKIP_TYPES = new Set(['comment', 'string', 'preamble']);

function readValue(s: string, i: number): { value: string; end: number } | null {
  while (/\s/.test(s[i] ?? '')) i++;
  const c = s[i];
  if (c === '{') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '\\') {
        j++;
        continue;
      }
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return { value: s.slice(i + 1, j), end: j + 1 };
    }
    return null;
  }
  if (c === '"') {
    let depth = 0;
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') {
        j++;
        continue;
      }
      if (s[j] === '{') depth++;
      else if (s[j] === '}') depth--;
      else if (s[j] === '"' && depth === 0) return { value: s.slice(i + 1, j), end: j + 1 };
    }
    return null;
  }
  const m = /^[^,}\s#]+/.exec(s.slice(i));
  if (!m) return null;
  return { value: m[0], end: i + m[0].length };
}

export function parseBib(src: string): BibParseResult {
  const entries: BibEntry[] = [];
  const errors: string[] = [];
  const re = /@\s*([A-Za-z]+)\s*([{(])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const type = m[1].toLowerCase();
    const open = m[2];
    const bodyStart = m.index + m[0].length;
    const end = matchEntryEnd(src, bodyStart - 1, open);
    if (end === -1) {
      errors.push(`Unclosed @${type} at offset ${m.index}`);
      break;
    }
    re.lastIndex = end;
    if (SKIP_TYPES.has(type)) continue;
    const body = src.slice(bodyStart, end - 1);
    const comma = body.indexOf(',');
    const key = (comma === -1 ? body : body.slice(0, comma)).trim();
    if (!key || /[\s{}"]/.test(key)) {
      errors.push(`@${type} at offset ${m.index} has no valid key`);
      continue;
    }
    const fields: Record<string, string> = {};
    let i = comma === -1 ? body.length : comma + 1;
    while (i < body.length) {
      const fm = /^\s*([A-Za-z][\w:.-]*)\s*=\s*/.exec(body.slice(i));
      if (!fm) {
        if (body.slice(i).trim().replace(/^,/, '').trim() !== '') errors.push(`@${type}{${key}: cannot read field near "${body.slice(i, i + 30).trim()}"`);
        break;
      }
      i += fm[0].length;
      let value = '';
      for (;;) {
        const v = readValue(body, i);
        if (!v) {
          errors.push(`@${type}{${key}: bad value for ${fm[1]}`);
          i = body.length;
          break;
        }
        value += v.value;
        i = v.end;
        const hash = /^\s*#\s*/.exec(body.slice(i));
        if (!hash) break;
        i += hash[0].length;
      }
      fields[fm[1].toLowerCase()] = value;
      const sep = /^\s*,?/.exec(body.slice(i));
      i += sep ? sep[0].length : 0;
    }
    entries.push({ type, key, fields, start: m.index, end, raw: src.slice(m.index, end) });
  }
  return { entries, errors };
}

function matchEntryEnd(src: string, openIdx: number, open: string): number {
  if (open === '(') {
    let depth = 0;
    for (let j = openIdx; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')' && --depth === 0) return j + 1;
    }
    return -1;
  }
  let depth = 0;
  for (let j = openIdx; j < src.length; j++) {
    if (src[j] === '\\') {
      j++;
      continue;
    }
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return j + 1;
  }
  return -1;
}
