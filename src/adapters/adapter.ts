// Backend interface (spec §6). Everything protocol-specific lives behind it.

export interface ProjectSummary {
  projectId: string;
  name: string;
  lastUpdated: string | null;
  accessLevel: string;
}

export interface ProjectSettings {
  name: string;
  rootDoc: string | null; // path
  compiler: 'pdflatex' | 'xelatex' | 'lualatex' | 'latex';
  texliveYear: string | null;
  trackChangesAvailable: boolean;
  permissionsLevel: string;
  userId: string | null;
}

export interface FileEntry {
  path: string; // no leading slash, e.g. "sections/intro.tex"
  kind: 'doc' | 'binary';
  id: string;
}

export interface TrackedChangeRange {
  id: string;
  kind: 'insert' | 'delete';
  /** Offset in the current text. A delete has zero width at `pos`. */
  pos: number;
  text: string;
  userId: string | null;
  ts: string | null;
}

export interface CommentRange {
  threadId: string;
  pos: number;
  text: string;
}

export interface Ranges {
  changes: TrackedChangeRange[];
  comments: CommentRange[];
}

export interface DocState {
  path: string;
  text: string;
  version: number;
  ranges: Ranges;
  /** 'sharejs-text-ot' docs are writable; 'history-ot' docs are read-only in v1. */
  otType: string;
}

/** One contiguous change in the coordinates of the base text. */
export interface Splice {
  start: number;
  end: number;
  text: string;
}

export interface TextEdit {
  splices: Splice[]; // non-overlapping, any order, base-text coordinates
  /** The doc text at `baseVersion`, so deletes can quote what they remove. */
  baseText: string;
}

export interface EditReceipt {
  path: string;
  /** Version at which the server applied the update. */
  appliedAt: number;
  tracked: boolean;
  trackedChangeIds: string[];
  /** What we did, in post-edit coordinates, so the edit can be undone. */
  inserted: { pos: number; text: string }[];
  deleted: { pos: number; text: string }[];
}

export interface CommentMessage {
  id: string;
  content: string;
  authorId: string | null;
  authorName: string;
  timestamp: number | null;
}

export interface CommentThread {
  threadId: string;
  path: string | null;
  anchor: CommentRange | null;
  resolved: boolean;
  messages: CommentMessage[];
}

export interface CommentApi {
  list(): Promise<CommentThread[]>;
  create(path: string, pos: number, anchorText: string, body: string): Promise<{ threadId: string }>;
  reply(threadId: string, body: string): Promise<void>;
  resolve(path: string, threadId: string): Promise<void>;
  acceptChange(path: string, changeIds: string[]): Promise<void>;
  rejectChange(path: string, changeIds: string[]): Promise<void>;
}

export interface IncomingChange {
  path: string;
  version: number;
  userIds: string[];
  /** 'self' for our own acknowledged edits, 'remote' for others, 'resync' after a gap or reconnect. */
  source: 'self' | 'remote' | 'resync' | 'tree';
}

export type Unsubscribe = () => void;

export interface ProjectHandle {
  projectId: string;
  settings(): ProjectSettings;
  tree(): FileEntry[];
  readDoc(path: string): Promise<DocState>;
  readBinary(path: string): Promise<Buffer>;
  applyEdit(path: string, edit: TextEdit, opts: { baseVersion: number; tracked: boolean }): Promise<EditReceipt>;
  revertEdit(path: string, receipt: EditReceipt): Promise<void>;
  comments: CommentApi;
  onChange(listener: (change: IncomingChange) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface Backend {
  listProjects(): Promise<ProjectSummary[]>;
  openProject(projectId: string): Promise<ProjectHandle>;
}

export class BackendError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
