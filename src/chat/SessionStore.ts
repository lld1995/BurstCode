import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ChatMessage } from '../llm/OpenAIClient';
import { PlanStep } from '../agent/tools/plan';

/**
 * High-level lifecycle state of an agent session. Drives the status badge
 * rendered in the chat history list and gates whether the user can resume /
 * cancel the run from the panel.
 */
export type SessionStatus =
  | 'idle'        // never run, or run finished and we forgot the exact reason
  | 'running'     // an AgentLoop is currently driving this session
  | 'completed'   // last run finished normally (stop / tool_calls / proposed_edit_done)
  | 'stopped'     // last run was cancelled by the user / hit max iters / stuck
  | 'error';      // last run threw / surfaced an error event

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status?: SessionStatus;
  scope?: 'workspace' | 'global';
  workspaceId?: string;
  originWorkspace?: string;
  /**
   * Machine whose disk holds the session body (see `SessionOwner`). Absent on
   * entries written by 0.1.161 and earlier, whose bodies still live in the
   * memento until the owning host migrates them.
   */
  owner?: string;
}

/**
 * A rollback point captured at the start of a user prompt. The agent run
 * that follows this user message can be rolled back to this snapshot — even
 * after the user has accepted the proposed edits.
 */
export interface SessionCheckpoint {
  /** Index in `Session.messages` of the user message this checkpoint belongs to. */
  messageIndex: number;
  /** Checkpoint ref — `file:<ts>` for file-based checkpoints (current), or legacy `refs/burstcode/checkpoints/<ts>` for old git-based ones. */
  ref: string;
  /** Object name the ref points at. */
  sha: string;
  /** ms since epoch */
  createdAt: number;
  /** Short label captured at creation time (typically the user prompt). */
  label: string;
  /** Original user prompt text for rebasing this checkpoint after context compression. */
  messageText?: string;
  /**
   * Workspace-relative POSIX paths the agent run following this checkpoint
   * actually WROTE (propose_edit / write_file). Rollback restricts its
   * restore/delete to these files so it never clobbers files changed by
   * another chat tab or by hand. Persisted so the scope survives an extension
   * reload (the in-memory tracker in HunkApplier is rebuilt empty on restart).
   */
  touchedFiles?: string[];
  workspaceId?: string;
}

export interface SessionLLMState {
  /** Per-session chat model snapshot. Global settings remain the default for future sessions. */
  model?: string;
}

/**
 * Snapshot of an agent turn that was still streaming when the extension host
 * went away (crash, window reload, lost remote connection). Persisted with the
 * messages while the run is in flight and turned back into a real transcript
 * entry by `finalizeInterruptedTurn`. Absent once a run has finished normally.
 */
export interface SessionPendingTurn {
  assistantText: string;
  reasoningText: string;
  /** ms since epoch */
  savedAt: number;
}

export interface Session extends SessionMeta {
  messages: ChatMessage[];
  plan?: PlanStep[];
  checkpoints?: SessionCheckpoint[];
  llm?: SessionLLMState;
  pending?: SessionPendingTurn;
}

export function isTerminalStatus(s: SessionStatus | undefined): boolean {
  return s === 'completed' || s === 'stopped' || s === 'error' || s === 'idle' || !s;
}

const KEY_INDEX = 'burstcode.sessions.index';
const KEY_SESSION_PREFIX = 'burstcode.session.';
/** Index shared by every window of a client. Entries without `owner` still keep their body in the memento. */
const KEY_SHARED_INDEX = 'burstcode.sessions.shared.index';
const SESSION_FILE_SUFFIX = '.json';
const SESSION_ID_PATTERN = /^s_[a-z0-9_]+$/i;
/** Approximate budget of decoded, otherwise unreferenced session bodies kept in memory. */
const IDLE_CACHE_BYTES = 48 * 1024 * 1024;
/** Write-ahead files at least this old belong to an interrupted save and are removed on activation. */
const STALE_TMP_MS = 24 * 60 * 60 * 1000;

/**
 * The machine an extension host runs on. Session bodies live in that machine's
 * `globalStorageUri`, which for a Remote-SSH / WSL / container window is the
 * REMOTE disk — unlike the memento, which is always stored client-side.
 */
export interface SessionOwner {
  /**
   * `'local'`, or `remote:<id>` with an id kept on the remote machine's own
   * disk. The extension host API cannot name the remote it runs on — its
   * workspace URIs are plain `file:` URIs — so each machine names itself.
   */
  id: string;
  /** True when the extension host itself runs on a remote machine. */
  remote: boolean;
  /** Ids of the folders and of the workspace file open in this window, as recorded in `SessionMeta.workspaceId`. */
  workspaces: string[];
}

const LOCAL_SESSION_OWNER: SessionOwner = { id: 'local', remote: false, workspaces: [] };
const OWNER_ID_FILE = 'session-owner-id';

/**
 * Stable random id of the machine that stores `storageDir`. Created on first
 * use; the windows of one machine share it and two machines never do.
 */
function hostOwnerId(storageDir: string): string {
  const file = path.join(storageDir, OWNER_ID_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const id = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f-]{36}$/i.test(id)) return id;
    } catch {
      // First activation on this machine, or another window is just creating the file.
    }
    try {
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(file, randomUUID(), { flag: 'wx' });
    } catch {
      // Another window got there first; read what it wrote.
    }
  }
  // The storage is not writable: identify this machine for this session only.
  return randomUUID();
}

/** Work out which machine this extension host stores sessions for. */
export function detectSessionOwner(storageDir: string): SessionOwner {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()).sort();
  const workspaceFile = vscode.workspace.workspaceFile?.toString();
  const workspaces = [...new Set([workspaceFile, folders.join('|'), ...folders].filter((id): id is string => !!id))];
  if (!vscode.env.remoteName) return { ...LOCAL_SESSION_OWNER, workspaces };
  return { id: `remote:${hostOwnerId(storageDir)}`, remote: true, workspaces };
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

/**
 * Rename `from` over `to`. On Windows the replace fails while another process
 * (antivirus, search indexer) briefly holds the target open, so those errors are
 * retried a few times before giving up.
 */
async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

/**
 * Persist sessions as one JSON file per session on the extension host's disk,
 * with only a KB-sized index in the memento.
 *
 * Why the memento must not hold bodies: VS Code keeps a memento as ONE value
 * per extension. Every `update()` deep-copies its argument, ships the whole
 * value to the renderer over RPC, and the renderer re-serializes all of it into
 * state.vscdb. The same value is transferred back on every extension host start
 * or reconnect. Histories that grew to tens of MB froze the extension host on
 * each save and, over Remote-SSH, exhausted the local renderer's heap.
 *
 * Bodies are per machine, so the shared client-side index tags every entry with
 * the machine holding its file and a window lists only what it can read.
 * 0.1.161 and earlier stored bodies in the memento; on first activation each
 * machine moves the entries whose workspace lives on it to disk.
 *
 * Workspace/global ownership follows the previous scheme: histories are never
 * evicted because another workspace saved.
 */
export class SessionStore {
  /**
   * Settles once legacy memento bodies have been moved to disk. Saves wait for
   * it so no storage write can go out while the old bodies are still resident.
   * Never rejects: a failed migration simply leaves the legacy fallback in use.
   */
  readonly ready: Promise<void>;

  private readonly workspaceName: string;
  private readonly directory: string;
  private readonly owner: SessionOwner;
  /**
   * Every session object handed out, tracked weakly. A session that is still
   * referenced elsewhere (current tab, running agent) must keep resolving to
   * the SAME object after it drops out of the idle cache, otherwise a later
   * `get()` would return a stale disk copy of a session with unsaved changes.
   */
  private readonly live = new Map<string, WeakRef<Session>>();
  /**
   * Insertion-ordered LRU of session ids → serialized size. Listing an id here
   * is what keeps its otherwise unreferenced body alive and decoded, so repeat
   * reads (history search, tab switches) do not hit the disk.
   */
  private readonly idle = new Map<string, number>();
  private idleBytes = 0;
  private readonly sizes = new Map<string, number>();
  /** Tail of the per-session write chain. */
  private readonly writes = new Map<string, Promise<void>>();
  /** Sessions whose in-flight write has to be followed by one more pass. */
  private readonly dirty = new Set<string>();
  /** Legacy entries whose bodies this activation moved to disk, awaiting their release from the memento. */
  private legacyMoved: SessionMeta[] = [];
  /** Workspaces of legacy entries already probed for / being probed for living on this machine. */
  private readonly originKnown = new Map<string, boolean>();
  private readonly originProbes = new Map<string, Promise<boolean>>();

  constructor(
    private readonly state: vscode.Memento,
    private readonly globalState: vscode.Memento | undefined,
    directory: string,
    readonly workspaceId = '',
    workspaceName = '',
    owner: SessionOwner = LOCAL_SESSION_OWNER,
    private readonly onError?: (message: string, err: unknown) => void
  ) {
    this.directory = directory;
    this.workspaceName = workspaceName;
    this.owner = owner;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      // Content first. The memento clean-up is issued right after and not
      // awaited: whether the renderer has flushed it must never hold back
      // writing a session to disk.
      await this.moveLegacyBodiesToDisk();
      this.releaseLegacyBodies();
      await this.reconcileWithDisk();
    } catch (err) {
      this.onError?.('Session storage initialization failed', err);
    }
  }

  /**
   * Apply a memento change. The new value is visible to this host at once; the
   * flush to storage is only tracked, never awaited, so a slow or struggling
   * renderer cannot hold back work that does not depend on it.
   */
  private setIndex(memento: vscode.Memento, key: string, value: unknown): void {
    Promise.resolve(memento.update(key, value)).catch((err) => {
      this.onError?.(`Failed to store ${key}`, err);
    });
  }

  private get storage(): vscode.Memento { return this.globalState ?? this.state; }
  private get indexKey(): string { return this.globalState ? KEY_SHARED_INDEX : KEY_INDEX; }

  private acceptsOwner(owner: string): boolean {
    return owner === this.owner.id;
  }

  /** `workspaceId` is the one this window records, or was never recorded. */
  private isThisWindow(workspaceId: string | undefined): boolean {
    return !workspaceId || this.owner.workspaces.includes(workspaceId);
  }

  /**
   * Whether a not-yet-migrated entry belongs on this machine. Until its
   * workspace has been probed it is listed as before, so nothing flickers
   * while the probe is in flight.
   */
  private originListed(meta: SessionMeta): boolean {
    if (this.isThisWindow(meta.workspaceId)) return true;
    const known = this.originKnown.get(meta.workspaceId ?? '');
    return known === undefined ? true : known;
  }

  private probeWorkspace(workspaceId: string | undefined): Promise<boolean> {
    if (this.isThisWindow(workspaceId)) return Promise.resolve(true);
    const key = workspaceId ?? '';
    let probe = this.originProbes.get(key);
    if (!probe) {
      probe = this.workspaceIsHere(key).then((here) => {
        this.originKnown.set(key, here);
        return here;
      });
      this.originProbes.set(key, probe);
    }
    return probe;
  }

  /**
   * A legacy session belongs to the machine that holds its workspace: that is
   * where the chat was held and where the folder can be opened again. The
   * extension host sees remote folders as `file:` URIs too, so the scheme says
   * nothing about the machine — the path does.
   */
  private async workspaceIsHere(workspaceId: string): Promise<boolean> {
    for (const part of workspaceId.split('|')) {
      if (!/^file:\/\//i.test(part)) {
        // A folder on a remote that shows its own scheme belongs to a remote machine;
        // an untitled workspace goes to the first window that starts.
        if (/^vscode-remote:/i.test(part) && !this.owner.remote) return false;
        continue;
      }
      // A path of another operating system (no drive letter on Windows, ...) is
      // simply not here; it must never break the whole migration.
      let location: string;
      try {
        location = vscode.Uri.parse(part).fsPath;
      } catch {
        return false;
      }
      const exists = await fs.promises.stat(location).then(() => true, () => false);
      if (!exists) return false;
    }
    return true;
  }

  private all(): SessionMeta[] {
    const shared: SessionMeta[] = this.storage.get<SessionMeta[]>(this.indexKey) ?? [];
    if (!this.globalState) return shared;
    const ids = new Set(shared.map(s => s.id));
    const legacy: SessionMeta[] = this.state.get<SessionMeta[]>(KEY_INDEX) ?? [];
    return [...shared, ...legacy.filter(s => !ids.has(s.id)).map(s => ({
      ...s, scope: 'workspace' as const, workspaceId: this.workspaceId, originWorkspace: this.workspaceName
    }))];
  }

  private isListed(id: string): boolean {
    return SESSION_ID_PATTERN.test(id) && this.list().some((s) => s.id === id);
  }

  async move(id: string, scope: 'workspace' | 'global'): Promise<void> {
    const session = this.get(id);
    if (!session) return;
    session.scope = scope;
    session.workspaceId = this.workspaceId;
    await this.save(session);
  }

  /**
   * Sessions this window may open. Besides the workspace/global visibility rule
   * an entry must have its body on this machine: disk-backed entries by owner,
   * and not-yet-migrated ones by the workspace they were held in.
   */
  list(): SessionMeta[] {
    return this.all()
      .filter((s) => (s.scope === 'global' || !s.workspaceId || s.workspaceId === this.workspaceId)
        && (s.owner !== undefined ? this.acceptsOwner(s.owner) : this.originListed(s)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Session by id, or undefined when it is not listed here. The first read of a
   * session that is neither cached nor referenced elsewhere loads its file
   * synchronously; prefer `load()` on user-initiated paths to keep the host
   * responsive for very large histories.
   */
  get(id: string): Session | undefined {
    if (!this.isListed(id)) return undefined;
    const cached = this.cached(id);
    if (cached) return cached;
    let session: Session | undefined;
    try {
      const text = fs.readFileSync(this.fileOf(id), 'utf8');
      session = this.parseSession(id, text);
      if (session) this.sizes.set(id, Buffer.byteLength(text));
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) this.onError?.(`Failed to read session ${id}`, err);
    }
    session ??= this.legacyBody(id);
    if (session) this.remember(session);
    return session;
  }

  /** Async flavour of `get()` for callers that can await. */
  async load(id: string): Promise<Session | undefined> {
    if (!this.isListed(id)) return undefined;
    const cached = this.cached(id);
    if (cached) return cached;
    let session: Session | undefined;
    try {
      const text = await fs.promises.readFile(this.fileOf(id), 'utf8');
      session = this.parseSession(id, text);
      if (session) this.sizes.set(id, Buffer.byteLength(text));
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) this.onError?.(`Failed to read session ${id}`, err);
    }
    session ??= this.legacyBody(id);
    if (session) this.remember(session);
    return session;
  }

  /** Serialized size observed at the last write or read of `id`, or 0 when unknown. */
  sizeOf(id: string): number {
    return this.sizes.get(id) ?? 0;
  }

  async save(session: Session): Promise<void> {
    session.scope ??= 'workspace';
    session.workspaceId ??= this.workspaceId;
    session.originWorkspace ??= this.workspaceName;
    session.owner ??= this.owner.id;
    this.remember(session);
    await this.queueWrite(session);
  }

  async delete(id: string): Promise<void> {
    await this.deleteMany([id]);
  }

  async clear(): Promise<void> {
    await this.deleteMany(this.list().map((s) => s.id));
  }

  // ---------------------------------------------------------------- storage

  private fileOf(id: string): string {
    return path.join(this.directory, id + SESSION_FILE_SUFFIX);
  }

  private metaOf(session: Session): SessionMeta {
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: session.status,
      scope: session.scope,
      workspaceId: session.workspaceId,
      originWorkspace: session.originWorkspace,
      owner: session.owner
    };
  }

  private cached(id: string): Session | undefined {
    const session = this.live.get(id)?.deref();
    if (!session) {
      this.live.delete(id);
      this.idleBytes -= this.idle.get(id) ?? 0;
      this.idle.delete(id);
      return undefined;
    }
    const bytes = this.idle.get(id);
    if (bytes !== undefined) {
      this.idle.delete(id);
      this.idle.set(id, bytes);
    }
    return session;
  }

  private remember(session: Session): void {
    this.live.set(session.id, new WeakRef(session));
    this.idleBytes -= this.idle.get(session.id) ?? 0;
    this.idle.delete(session.id);
    this.idle.set(session.id, this.sizes.get(session.id) ?? 0);
    this.trimIdle();
  }

  /** Record the serialized size of `id` and evict least-recently-used idle bodies over budget. */
  private trackSize(id: string, bytes: number): void {
    const previous = this.idle.get(id);
    this.sizes.set(id, bytes);
    if (previous === undefined) return;
    this.idle.set(id, bytes);
    this.idleBytes += bytes - previous;
    this.trimIdle();
  }

  private trimIdle(): void {
    // Always keep the two most recent bodies: tab switches and the context
    // gauge re-read the current session constantly.
    while (this.idleBytes > IDLE_CACHE_BYTES && this.idle.size > 2) {
      const [id, bytes] = this.idle.entries().next().value as [string, number];
      this.idle.delete(id);
      this.idleBytes -= bytes;
    }
  }

  private parseSession(id: string, text: string): Session | undefined {
    try {
      const session = JSON.parse(text) as unknown;
      if (session && typeof session === 'object' && typeof (session as Session).id === 'string'
        && Array.isArray((session as Session).messages)) {
        return session as Session;
      }
    } catch (err) {
      this.onError?.(`Session file for ${id} is not valid JSON`, err);
    }
    return undefined;
  }

  /**
   * Body of a session that has not been migrated to disk yet. Returns a shallow
   * copy: callers append to `messages` and replace `checkpoints`, and must not
   * write back into the memento's live value.
   */
  private legacyBody(id: string): Session | undefined {
    const shared = this.globalState?.get<Session>(KEY_SESSION_PREFIX + id);
    if (shared) {
      return { ...shared, messages: shared.messages.slice(), checkpoints: shared.checkpoints?.map((cp) => ({ ...cp, workspaceId: cp.workspaceId ?? shared.workspaceId })) };
    }
    const legacy = this.state.get<Session>(KEY_SESSION_PREFIX + id);
    if (!legacy) return undefined;
    return {
      ...legacy, messages: legacy.messages.slice(), scope: 'workspace', workspaceId: this.workspaceId,
      originWorkspace: this.workspaceName,
      checkpoints: legacy.checkpoints?.map((cp: SessionCheckpoint) => ({ ...cp, workspaceId: this.workspaceId }))
    };
  }

  /** Serialize the current state of `id` to its file atomically. */
  private async writeBodyFile(id: string, fallback: Session): Promise<void> {
    const session = this.live.get(id)?.deref() ?? fallback;
    const json = JSON.stringify(session);
    await fs.promises.mkdir(this.directory, { recursive: true });
    const target = this.fileOf(id);
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(tmp, json);
      // Rename replaces the target in one step, so a crash can never leave a half-written session behind.
      await replaceFile(tmp, target);
    } catch (err) {
      void fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    this.trackSize(id, Buffer.byteLength(json));
  }

  /**
   * Write the body, then publish its index entry. Content always precedes its
   * index entry so a crash between the two leaves an unindexed file (which
   * `reconcileWithDisk` adopts) rather than an index entry without a body.
   */
  private async writeSession(id: string, fallback: Session): Promise<void> {
    await this.ready;
    try {
      await this.writeBodyFile(id, fallback);
    } catch (err) {
      this.onError?.(`Failed to persist session ${id}`, err);
      throw err;
    }
    this.upsertMetas([this.metaOf(this.live.get(id)?.deref() ?? fallback)]);
    this.dropLegacyCopy(id);
  }

  /**
   * Remove a session's legacy (0.1.161 and earlier) memento copy once its file
   * is stored. The migration handles the copies present at activation; this
   * also covers ones that reach the memento later, and keeps a session from
   * living in both places with the file going stale.
   */
  private dropLegacyCopy(id: string): void {
    if (this.globalState && this.globalState.get(KEY_SESSION_PREFIX + id) !== undefined) {
      this.setIndex(this.globalState, KEY_SESSION_PREFIX + id, undefined);
    }
    if (this.state.get(KEY_SESSION_PREFIX + id) !== undefined) {
      this.setIndex(this.state, KEY_SESSION_PREFIX + id, undefined);
    }
    const legacyIndex = this.state.get<SessionMeta[]>(KEY_INDEX) ?? [];
    if (this.globalState && legacyIndex.some((m) => m.id === id)) {
      this.setIndex(this.state, KEY_INDEX, legacyIndex.filter((m) => m.id !== id));
    }
  }

  /**
   * Queue one write for a session. While a write is in flight further saves
   * only mark the session dirty, so a fast stream of saves costs one follow-up
   * serialization of the newest state instead of one snapshot per save.
   */
  private queueWrite(session: Session): Promise<void> {
    const id = session.id;
    const running = this.writes.get(id);
    if (running) {
      this.dirty.add(id);
      return running;
    }
    const write = (async () => {
      do {
        this.dirty.delete(id);
        await this.writeSession(id, session);
      } while (this.dirty.has(id));
    })();
    const tracked = write.finally(() => {
      if (this.writes.get(id) === tracked) this.writes.delete(id);
    });
    this.writes.set(id, tracked);
    return tracked;
  }

  private upsertMetas(metas: SessionMeta[]): void {
    const index = this.storage.get<SessionMeta[]>(this.indexKey) ?? [];
    const incoming = new Set(metas.map((m) => m.id));
    this.setIndex(this.storage, this.indexKey, [...metas, ...index.filter((m) => !incoming.has(m.id))]);
  }

  private async deleteMany(ids: string[]): Promise<void> {
    const doomed = ids.filter((id) => this.list().some((s) => s.id === id));
    if (doomed.length === 0) return;
    await this.ready;
    // Let an in-flight write finish first, otherwise it would recreate the file after the delete.
    await Promise.all(doomed.map((id) => this.writes.get(id)?.catch(() => undefined)));
    const removed = new Set(doomed);
    for (const id of doomed) {
      this.live.delete(id);
      this.idleBytes -= this.idle.get(id) ?? 0;
      this.idle.delete(id);
      this.sizes.delete(id);
      try {
        await fs.promises.rm(this.fileOf(id), { force: true });
      } catch (err) {
        this.onError?.(`Failed to delete session file ${id}`, err);
      }
    }
    // Issue every memento change in the same tick: VS Code coalesces same-tick
    // updates to one memento into a single storage write.
    this.setIndex(this.storage, this.indexKey,
      (this.storage.get<SessionMeta[]>(this.indexKey) ?? []).filter((m) => !removed.has(m.id)));
    const legacyIndex = this.state.get<SessionMeta[]>(KEY_INDEX) ?? [];
    if (this.globalState && legacyIndex.some((m) => removed.has(m.id))) {
      this.setIndex(this.state, KEY_INDEX, legacyIndex.filter((m) => !removed.has(m.id)));
    }
    for (const id of doomed) {
      this.setIndex(this.storage, KEY_SESSION_PREFIX + id, undefined);
      if (this.globalState) this.setIndex(this.state, KEY_SESSION_PREFIX + id, undefined);
    }
  }

  // -------------------------------------------------------------- migration

  /**
   * Move the legacy (0.1.161 and earlier) memento bodies that originate on this
   * machine to disk.
   * Content first: a body is only dropped from the memento once its file is on
   * disk. Idempotent — a run interrupted between writing a file and dropping
   * its key simply finds the file on the next activation.
   */
  private async moveLegacyBodiesToDisk(): Promise<void> {
    const legacy: SessionMeta[] = [];
    for (const meta of this.all()) {
      if (meta.owner === undefined && SESSION_ID_PATTERN.test(meta.id) && await this.probeWorkspace(meta.workspaceId)) {
        legacy.push(meta);
      }
    }
    const moved: SessionMeta[] = [];
    for (const meta of legacy) {
      // One unwritable session must not hold back the others; it stays in the
      // memento and is tried again on the next activation.
      try {
        if (!(await fs.promises.stat(this.fileOf(meta.id)).then(() => true, () => false))) {
          const body = this.legacyBody(meta.id);
          if (body) {
            const session: Session = { ...body, owner: this.owner.id };
            await this.writeBodyFile(meta.id, session);
            // A window that already opened this session keeps its own (possibly newer) object.
            if (!this.live.get(meta.id)?.deref()) this.remember(session);
          }
          // Without a body there was never anything to open. Letting the entry
          // through gets it dropped from the index during reconciliation.
        }
        moved.push(meta);
      } catch (err) {
        this.onError?.(`Failed to move session ${meta.id} to disk`, err);
      }
    }
    this.legacyMoved = moved;
  }

  /**
   * Publish the migrated entries as disk-backed and drop the old memento keys,
   * all in one tick. Each memento update re-sends the whole extension state, so
   * removing the keys one await at a time would ship the still-large state once
   * per session.
   */
  private releaseLegacyBodies(): void {
    const legacy = this.legacyMoved;
    this.legacyMoved = [];
    if (legacy.length === 0) return;
    const claimed = new Set(legacy.map((m) => m.id));
    const index = this.storage.get<SessionMeta[]>(this.indexKey) ?? [];
    this.setIndex(this.storage, this.indexKey, [
      ...legacy.map((m) => ({ ...m, owner: this.owner.id })),
      ...index.filter((m) => !claimed.has(m.id))
    ]);
    const legacyIndex = this.state.get<SessionMeta[]>(KEY_INDEX) ?? [];
    if (this.globalState && legacyIndex.some((m) => claimed.has(m.id))) {
      this.setIndex(this.state, KEY_INDEX, legacyIndex.filter((m) => !claimed.has(m.id)));
    }
    for (const id of claimed) {
      this.setIndex(this.storage, KEY_SESSION_PREFIX + id, undefined);
      if (this.globalState) this.setIndex(this.state, KEY_SESSION_PREFIX + id, undefined);
    }
  }

  /**
   * Line the index up with the session files on this machine. Windows of one
   * machine share the directory but hold separate copies of the memento, so a
   * concurrent index write from another window can drop an entry: files without
   * an entry are adopted, entries whose file is gone are dropped.
   */
  private async reconcileWithDisk(): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.directory);
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) this.onError?.('Failed to list session files', err);
      return;
    }
    for (const name of names.filter((n) => n.endsWith('.tmp'))) {
      const file = path.join(this.directory, name);
      const age = await fs.promises.stat(file).then((s) => Date.now() - s.mtimeMs, () => -1);
      if (age >= STALE_TMP_MS) void fs.promises.rm(file, { force: true }).catch(() => undefined);
    }
    const onDisk = new Set(
      names.filter((n) => n.endsWith(SESSION_FILE_SUFFIX))
        .map((n) => n.slice(0, -SESSION_FILE_SUFFIX.length))
        .filter((id) => SESSION_ID_PATTERN.test(id))
    );
    const index = this.storage.get<SessionMeta[]>(this.indexKey) ?? [];
    const known = new Set(this.all().map((m) => m.id));
    const adopted: SessionMeta[] = [];
    for (const id of onDisk) {
      if (known.has(id)) continue;
      const session = await fs.promises.readFile(this.fileOf(id), 'utf8')
        .then((text) => this.parseSession(id, text), () => undefined);
      // The file is on this machine, so this machine owns it whatever it says.
      if (session) adopted.push(this.metaOf({ ...session, owner: this.owner.id }));
    }
    const owned = index.filter((m): m is SessionMeta & { owner: string } => m.owner !== undefined);
    // Same for an entry indexed under another owner: a machine's id only ever
    // changes when its storage was recreated, and then it is this one.
    const reowned = owned
      .filter((m) => !this.acceptsOwner(m.owner) && onDisk.has(m.id))
      .map((m) => ({ ...m, owner: this.owner.id }));
    const replaced = new Set(reowned.map((m) => m.id));
    const dropped = new Set(owned.filter((m) => this.acceptsOwner(m.owner) && !onDisk.has(m.id)).map((m) => m.id));
    if (adopted.length === 0 && reowned.length === 0 && dropped.size === 0) return;
    this.setIndex(this.storage, this.indexKey, [
      ...adopted, ...reowned, ...index.filter((m) => !dropped.has(m.id) && !replaced.has(m.id))
    ]);
  }
}

/**
 * Turn the persisted leftovers of a run that never finished — the extension
 * host crashed, the window was reloaded or a remote connection dropped — into a
 * complete, readable transcript:
 *   - the partially streamed answer becomes a real assistant message, flagged
 *     as interrupted, instead of being lost;
 *   - tool calls that never reported back get a placeholder result so the
 *     transcript and the next request stay well-formed.
 *
 * Returns true when the session changed.
 */
export function finalizeInterruptedTurn(session: Session): boolean {
  let changed = false;
  // Only the tail of the transcript can belong to the interrupted run: a run
  // cut short earlier in its history was already finalized by this same pass.
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i];
    if (message.role === 'tool') continue;
    if (message.role !== 'assistant') break;
    const calls = (message as ChatMessage & { tool_calls?: Array<{ id?: string }> }).tool_calls ?? [];
    const answered = new Set(
      session.messages.slice(i + 1).flatMap((m) => (m.role === 'tool' ? [(m as ChatMessage & { tool_call_id?: string }).tool_call_id] : []))
    );
    for (const call of calls) {
      if (!call.id || answered.has(call.id)) continue;
      session.messages.push({ role: 'tool', tool_call_id: call.id, content: INTERRUPTED_TOOL_NOTE } as ChatMessage);
      changed = true;
    }
    break;
  }
  const pending = session.pending;
  if (pending) {
    delete session.pending;
    changed = true;
    if (pending.assistantText.trim()) {
      session.messages.push({
        role: 'assistant',
        content: pending.assistantText + INTERRUPTED_TURN_NOTE,
        ...(pending.reasoningText.trim() ? { reasoning_content: pending.reasoningText } : {})
      } as ChatMessage);
    }
  }
  return changed;
}

/** Appended to an answer that was cut off when the extension host went away. */
const INTERRUPTED_TURN_NOTE =
  '\n\n> ⚠️ **Answer interrupted** — VS Code or the extension host stopped while this turn was being generated. The text above is everything that had been produced.';

/** Result recorded for a tool call whose run died before it could report back. */
const INTERRUPTED_TOOL_NOTE =
  '[interrupted] The extension host stopped before this tool call reported a result. Its outcome is unknown — check the affected files or state before relying on or repeating it.';

export function createSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function deriveTitle(text: string): string {
  const first = text.replace(/\s+/g, ' ').trim();
  if (!first) return 'New chat';
  return first.length > 60 ? first.slice(0, 57) + '...' : first;
}

/** Compact rendered transcript used for replaying a saved session into the webview. */
export interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'reasoning' | 'tool';
  text: string;
  name?: string;
  isError?: boolean;
  /** For tool entries: the parsed call arguments, so the webview can rebuild
   *  the rich diff / read / collect cards (propose_edit, write_file, read_file,
   *  collect_context) when replaying a session from history. */
  args?: unknown;
  /** For user entries: index in the original messages array. */
  messageIndex?: number;
  /** Number of image attachments on a multimodal user message. */
  imageCount?: number;
  /** Data URLs for user image attachments so history can render thumbnails. */
  imageUrls?: string[];
  /** For user entries: rollback ref captured before this prompt was processed. */
  checkpointRef?: string;
}

function userContentSummary(content: unknown): { text: string; imageCount: number; imageUrls: string[] } {
  if (typeof content === 'string') return { text: content, imageCount: 0, imageUrls: [] };
  if (!Array.isArray(content)) return { text: '', imageCount: 0, imageUrls: [] };
  const textParts: string[] = [];
  const imageUrls: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: unknown; text?: unknown; image_url?: { url?: unknown } };
    if (p.type === 'text' && typeof p.text === 'string') textParts.push(p.text);
    if (p.type === 'image_url') {
      const url = p.image_url && typeof p.image_url.url === 'string' ? p.image_url.url : '';
      if (url) imageUrls.push(url);
    }
  }
  const imageCount = imageUrls.length;
  return { text: textParts.join('\n').trim(), imageCount, imageUrls };
}

export function buildTranscript(
  messages: ChatMessage[],
  checkpoints?: SessionCheckpoint[]
): TranscriptEntry[] {
  return buildTranscriptRange(messages, checkpoints, 0, Number.POSITIVE_INFINITY).entries;
}

/**
 * Build only one logical transcript window. Session messages can contain very
 * large tool arguments/results, so callers that render one page must not first
 * materialize and JSON-parse the entire transcript and slice it afterwards.
 *
 * The first pass counts cheap logical entries without parsing tool arguments;
 * the second pass materializes only entries inside [start, end). Tool results
 * still update the preceding tool-call entry, matching buildTranscript().
 */
export function buildTranscriptRange(
  messages: ChatMessage[],
  checkpoints: SessionCheckpoint[] | undefined,
  requestedStart: number,
  requestedEnd: number,
  textOnly = false
): { entries: TranscriptEntry[]; total: number } {
  const start = Math.max(0, Math.floor(requestedStart));
  const end = Number.isFinite(requestedEnd)
    ? Math.max(start, Math.floor(requestedEnd))
    : Number.POSITIVE_INFINITY;
  let logicalIndex = 0;
  let lastEntry: TranscriptEntry | undefined;
  const entries: TranscriptEntry[] = [];
  const refByIndex = new Map<number, string>();
  for (const c of checkpoints ?? []) {
    const idx =
      messages[c.messageIndex]?.role === 'system' && messages[c.messageIndex + 1]?.role === 'user'
        ? c.messageIndex + 1
        : c.messageIndex;
    refByIndex.set(idx, c.ref);
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const summary = userContentSummary(m.content);
      const text = summary.text;
      // Skip internal messages injected by the agent loop that were never
      // shown to the user as real input: system notes, auto-continue nudges,
      // stuck-detector corrections, length-truncation continue prompts,
      // decision-buffer feedback, and context-offload hints.
      const isInternal =
        (summary.imageCount === 0 && !text) ||
        text.startsWith('(System note)') ||
        text.startsWith('[auto-continue]') ||
        text.startsWith('[stuck-detector]') ||
        text.startsWith('[user-decision]') ||
        text.startsWith('[context-offload hint]') ||
        text.startsWith('[interrupted-generation]') ||
        text.startsWith('Your previous response was cut off');
      if (!isInternal) {
        const entry: TranscriptEntry = {
          kind: 'user',
          text,
          messageIndex: i,
          checkpointRef: refByIndex.get(i),
          imageCount: summary.imageCount,
          imageUrls: summary.imageUrls
        };
        if (logicalIndex >= start && logicalIndex < end) entries.push(entry);
        lastEntry = entry;
        logicalIndex++;
      }
    } else if (m.role === 'assistant') {
      // Internal interrupted-draft assistant messages are fed back to the model
      // for continuation, but they are not final chat content and should not
      // render as user-visible history bubbles.
      const text = typeof m.content === 'string' ? m.content : '';
      const isInterruptedDraft =
        text.startsWith('Interrupted partial assistant output before ') ||
        text.startsWith('Interrupted partial tool call #') ||
        text.includes('IN-MEMORY DRAFT PREFIX');
      if (isInterruptedDraft) continue;
      // Render reasoning_content (DeepSeek V4 field, or chain-of-thought
      // we extracted from <think>...</think> tags in Qwen3 / GLM / Kimi
      // output) as a separate collapsible entry that precedes the answer.
      const reasoning = (m as unknown as { reasoning_content?: unknown }).reasoning_content;
      if (typeof reasoning === 'string' && reasoning.trim().length > 0) {
        const entry: TranscriptEntry = { kind: 'reasoning', text: reasoning };
        if (logicalIndex >= start && logicalIndex < end) entries.push(entry);
        lastEntry = entry;
        logicalIndex++;
      }
      if (text) {
        const entry: TranscriptEntry = { kind: 'assistant', text };
        if (logicalIndex >= start && logicalIndex < end) entries.push(entry);
        lastEntry = entry;
        logicalIndex++;
      }
      const calls =
        (m as unknown as { tool_calls?: Array<{ id?: string; function: { name: string; arguments: string } }> })
          .tool_calls ?? [];
      for (const c of calls) {
        const retained = logicalIndex >= start && logicalIndex < end;
        // Parsing giant propose_edit/write_file arguments dominates session
        // switching. Parse only calls that are actually part of this page.
        let parsedArgs: unknown;
        if (retained && !textOnly) {
          try { parsedArgs = JSON.parse(c.function.arguments); } catch { parsedArgs = undefined; }
        }
        const entry: TranscriptEntry = {
          kind: 'tool',
          name: c.function.name,
          text: retained ? '(call) ' + c.function.arguments : '(call)',
          args: parsedArgs
        };
        if (retained) entries.push(entry);
        lastEntry = entry;
        logicalIndex++;
      }
    } else if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : '';
      // Attach to the preceding logical tool-call even when that call is just
      // outside the requested page. A standalone result creates its own entry.
      if (lastEntry?.kind === 'tool' && lastEntry.text.startsWith('(call)')) {
        lastEntry.text = text;
      } else {
        const entry: TranscriptEntry = { kind: 'tool', name: 'tool', text };
        if (logicalIndex >= start && logicalIndex < end) entries.push(entry);
        lastEntry = entry;
        logicalIndex++;
      }
    }
  }
  return { entries, total: logicalIndex };
}

/**
 * Context compression can remove historical assistant/tool messages while keeping
 * user prompts. Checkpoint entries store message indexes into the live messages
 * array, so any compaction pass must rebase them before rollback buttons are
 * replayed or persisted. Match by the checkpoint's user-message text occurrence
 * (not by old index), which also preserves duplicate prompts in order.
 */
export function rebaseCheckpointsAfterMessageCompaction(
  messages: ChatMessage[],
  checkpoints?: SessionCheckpoint[]
): SessionCheckpoint[] {
  if (!checkpoints?.length) return [];

  const userOccurrences = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const summary = userContentSummary(m.content);
    const text = summary.text;
    const arr = userOccurrences.get(text) ?? [];
    arr.push(i);
    userOccurrences.set(text, arr);
  }

  const usedByText = new Map<string, number>();
  const rebased: SessionCheckpoint[] = [];
  for (const cp of checkpoints.slice().sort((a, b) => a.createdAt - b.createdAt)) {
    const oldMessage = messages[cp.messageIndex];
      const oldText = cp.messageText ?? (
        oldMessage?.role === 'user'
          ? userContentSummary(oldMessage.content).text
          : undefined
      );
    if (!oldText) continue;

    const candidates = userOccurrences.get(oldText) ?? [];
    const used = usedByText.get(oldText) ?? 0;
    const nextIndex = candidates[used];
    if (nextIndex === undefined) continue;

    usedByText.set(oldText, used + 1);
    rebased.push({ ...cp, messageIndex: nextIndex, messageText: oldText });
  }

  return rebased.sort((a, b) => a.messageIndex - b.messageIndex || a.createdAt - b.createdAt);
}
