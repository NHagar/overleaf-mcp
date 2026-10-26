// Small, tolerant LaTeX scanning helpers. Nothing here tries to understand macros;
// it only finds comments, braces, environments and the handful of commands we check.

export const VERBATIM_ENVS = new Set([
  'verbatim',
  'verbatim*',
  'Verbatim',
  'BVerbatim',
  'LVerbatim',
  'lstlisting',
  'minted',
  'comment',
  'filecontents',
  'filecontents*',
  'alltt',
  'spverbatim',
  'pythoncode',
  'tcblisting',
]);

export const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

/** Replaces `%` comments with spaces, keeping offsets and newlines. `\%` is not a comment. */
export function maskComments(text: string): string {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '%') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Masks comments and the bodies of verbatim-like environments. */
export function maskForScan(text: string): string {
  let masked = maskComments(text);
  const re = /\\begin\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (!VERBATIM_ENVS.has(m[1])) continue;
    const endTag = `\\end{${m[1]}}`;
    const bodyStart = m.index + m[0].length;
    // Search the raw text: comments inside verbatim are not comments.
    const endIdx = text.indexOf(endTag, bodyStart);
    const stop = endIdx === -1 ? text.length : endIdx;
    masked = masked.slice(0, bodyStart) + text.slice(bodyStart, stop).replace(/[^\n]/g, ' ') + masked.slice(stop);
    re.lastIndex = stop;
  }
  return masked;
}

/** Net `{` minus `}` in a comment-masked string, ignoring escaped braces. */
export function braceDelta(s: string): number {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') d++;
    else if (c === '}') d--;
  }
  return d;
}

/** Reads a balanced `{…}` group starting at `pos` (which must be `{`). Returns content and end index. */
export function readGroup(s: string, pos: number): { content: string; end: number } | null {
  if (s[pos] !== '{') return null;
  let depth = 0;
  for (let i = pos; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { content: s.slice(pos + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Skips whitespace and `[...]` optional arguments. */
function skipOptionals(s: string, pos: number): number {
  let i = pos;
  for (;;) {
    while (i < s.length && /[ \t\n]/.test(s[i])) i++;
    if (s[i] !== '[') return i;
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === '[') depth++;
      else if (s[i] === ']') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
  }
}

export interface MacroHit {
  name: string;
  index: number;
  args: string[];
  end: number;
}

/**
 * Finds `\name*?[opt]{arg}` occurrences for the given names in already-masked text.
 * `nargs` mandatory arguments are read; optional arguments are skipped anywhere before them.
 */
export function findMacros(masked: string, names: string[], nargs = 1): MacroHit[] {
  const hits: MacroHit[] = [];
  const re = new RegExp(`\\\\(${names.map(escapeRe).join('|')})\\*?(?![A-Za-z@])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    let pos = m.index + m[0].length;
    const args: string[] = [];
    let ok = true;
    for (let k = 0; k < nargs; k++) {
      pos = skipOptionals(masked, pos);
      const g = readGroup(masked, pos);
      if (!g) {
        ok = false;
        break;
      }
      args.push(g.content);
      pos = g.end;
    }
    if (ok) hits.push({ name: m[1], index: m.index, args, end: pos });
  }
  return hits;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const REF_COMMANDS = [
  'ref',
  'Ref',
  'cref',
  'Cref',
  'autoref',
  'Autoref',
  'eqref',
  'pageref',
  'cpageref',
  'Cpageref',
  'nameref',
  'Nameref',
  'vref',
  'Vref',
  'labelcref',
  'namecref',
  'nameCref',
];
export const REF_RANGE_COMMANDS = ['crefrange', 'Crefrange', 'cpagerefrange', 'Cpagerefrange'];

export const CITE_COMMANDS = [
  'cite',
  'Cite',
  'citep',
  'Citep',
  'citet',
  'Citet',
  'citealp',
  'Citealp',
  'citealt',
  'Citealt',
  'citeauthor',
  'Citeauthor',
  'citeyear',
  'citeyearpar',
  'parencite',
  'Parencite',
  'textcite',
  'Textcite',
  'autocite',
  'Autocite',
  'footcite',
  'footcitetext',
  'smartcite',
  'Smartcite',
  'supercite',
  'fullcite',
  'nocite',
];

function splitKeys(arg: string): string[] {
  return arg
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k !== '*');
}

export interface Extracted {
  labels: string[];
  refs: string[];
  cites: string[];
}

/** Labels, references and citation keys in a masked string. */
export function extractRefs(masked: string): Extracted {
  const labels = findMacros(masked, ['label']).map((h) => h.args[0].trim());
  const refs = findMacros(masked, REF_COMMANDS).flatMap((h) => splitKeys(h.args[0]));
  for (const h of findMacros(masked, REF_RANGE_COMMANDS, 2)) refs.push(...h.args.map((a) => a.trim()));
  const cites = findMacros(masked, CITE_COMMANDS).flatMap((h) => splitKeys(h.args[0]));
  // \cites{a}{b}… (biblatex multicite)
  const multi = /\\[Cc]ites\*?((?:\s*(?:\[[^\]]*\])*\s*\{[^}]*\})+)/g;
  let m: RegExpExecArray | null;
  while ((m = multi.exec(masked))) {
    for (const g of m[1].matchAll(/\{([^}]*)\}/g)) cites.push(...splitKeys(g[1]));
  }
  return { labels, refs, cites };
}

/** Files pulled in by \input, \include, \subfile, \import, \subimport, in source order. */
export function findIncludes(masked: string): { cmd: string; path: string }[] {
  const out: { cmd: string; path: string; index: number }[] = [];
  for (const h of findMacros(masked, ['input', 'include', 'subfile', 'InputIfFileExists'])) {
    out.push({ cmd: h.name, path: h.args[0].trim(), index: h.index });
  }
  for (const h of findMacros(masked, ['import', 'subimport', 'inputfrom', 'includefrom', 'subinputfrom', 'subincludefrom'], 2)) {
    const dir = h.args[0].trim().replace(/\/?$/, '/');
    out.push({ cmd: h.name, path: dir + h.args[1].trim(), index: h.index });
  }
  // TeX primitive form: \input file (no braces)
  const bare = /\\input\s+([A-Za-z0-9_./-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = bare.exec(masked))) out.push({ cmd: 'input', path: m[1], index: m.index });
  return out.sort((a, b) => a.index - b.index).map(({ cmd, path }) => ({ cmd, path }));
}

/** Bibliography files named by \bibliography / \addbibresource. */
export function findBibResources(masked: string): string[] {
  const out: string[] = [];
  for (const h of findMacros(masked, ['bibliography'])) out.push(...splitKeys(h.args[0]));
  for (const h of findMacros(masked, ['addbibresource', 'addglobalbib', 'addsectionbib'])) out.push(h.args[0].trim());
  return out.map((p) => (p.endsWith('.bib') ? p : `${p}.bib`));
}

export interface LineInfo {
  start: number; // offset of first char
  end: number; // offset of the newline (or text length)
  text: string;
}

export function splitLines(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      lines.push({ start, end: text.length, text: text.slice(start) });
      break;
    }
    lines.push({ start, end: nl, text: text.slice(start, nl) });
    start = nl + 1;
  }
  return lines;
}

/** 1-based line number of an offset. */
export function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
