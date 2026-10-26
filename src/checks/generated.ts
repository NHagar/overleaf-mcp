// Generated-file detection (spec §11).

export interface GeneratedInfo {
  script: string;
  data: string;
}

const HEADER_RE = /^\s*%\s*generated-by:\s*(\S+)\s+from\s+(\S+)/i;

export function generatedInfo(text: string): GeneratedInfo | null {
  for (const line of text.split('\n', 5)) {
    const m = HEADER_RE.exec(line);
    if (m) return { script: m[1], data: m[2] };
  }
  return null;
}
