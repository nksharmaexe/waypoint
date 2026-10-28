import * as vscode from "vscode";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let root = "";
const AUTO_PREFIX = "Auto · ";
const GUARD_PREFIX = "Guard · ";

// ---------- git helpers ----------

async function lastHeadOp(): Promise<
  { text: string; ageSec: number } | undefined
> {
  try {
    const out = (
      await git([
        "log",
        "-g",
        "-1",
        "--date=unix",
        "--format=%gd%x09%gs",
        "HEAD",
      ])
    ).trim();
    const [sel, text] = out.split("\t");
    const ts = Number(/\{(\d+)\}/.exec(sel ?? "")?.[1]);
    return { text: text ?? "", ageSec: ts ? Date.now() / 1000 - ts : 0 };
  } catch {
    return undefined;
  }
}

function git(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: root,
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) =>
        err ? reject(new Error(stderr || err.message)) : resolve(stdout),
    );
  });
}

async function snapshotTree(): Promise<string> {
  const gitDir = (await git(["rev-parse", "--absolute-git-dir"])).trim();
  const tmp = path.join(
    os.tmpdir(),
    `cp-index-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    try {
      fs.copyFileSync(path.join(gitDir, "index"), tmp);
    } catch {
      /* no index yet */
    }
    const env = { GIT_INDEX_FILE: tmp };
    await git(["add", "-A"], env);
    return (await git(["write-tree"], env)).trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
async function fileExistsAt(ref: string, file: string): Promise<boolean> {
  return git(["cat-file", "-e", `${ref}:${file}`]).then(
    () => true,
    () => false,
  );
}

/** Make one file on disk match its state at `ref` (delete it if it didn't exist there). */
async function applyFileState(ref: string, file: string): Promise<void> {
  if (await fileExistsAt(ref, file)) {
    await git(["restore", `--source=${ref}`, "--worktree", "--", file]);
  } else {
    fs.rmSync(path.join(root, file), { force: true });
  }
}

/** Hidden safety snapshot of the whole working tree; not shown in the checkpoint list. */
async function saveToTrash(label: string): Promise<string> {
  const snap = await snapshotTree();
  const parent = await headSha();
  const args = ["commit-tree", snap, "-m", label];
  if (parent) args.push("-p", parent);
  const commit = (await git(args, IDENT)).trim();
  const ref = `refs/checkpoints-trash/${Date.now()}`;
  await git(["update-ref", ref, commit]);

  // keep only the newest 20
  const all = (
    await git([
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname)",
      "refs/checkpoints-trash",
    ])
  )
    .split("\n")
    .filter(Boolean);
  for (const old of all.slice(0, Math.max(0, all.length - 20)))
    await git(["update-ref", "-d", old]);
  return ref;
}

interface CP {
  ref: string;
  label: string;
  date: Date;
}

async function listCheckpoints(): Promise<CP[]> {
  const key = await currentKey();
  const out = await git([
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%09%(creatordate:iso-strict)%09%(contents:subject)",
    `refs/checkpoints/${key}`,
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, date, ...rest] = line.split("\t");
      return { ref, date: new Date(date), label: rest.join("\t") };
    });
}

async function createCheckpoint(
  label: string,
  knownTree?: string,
): Promise<void> {
  const tree = knownTree ?? (await snapshotTree());
  const list = await listCheckpoints();
  const parent = list.length ? list[list.length - 1].ref : await headSha(); // "" if no commits yet
  const args = ["commit-tree", tree, "-m", label];
  if (parent) args.push("-p", parent);
  const commit = (await git(args, IDENT)).trim();
  const key = await currentKey();
  await git(["update-ref", `refs/checkpoints/${key}/${Date.now()}`, commit]);
}

async function clearAll(): Promise<void> {
  for (const cp of await listCheckpoints())
    await git(["update-ref", "-d", cp.ref]);
}

async function headSha(): Promise<string> {
  try {
    return (await git(["rev-parse", "HEAD"])).trim();
  } catch {
    return "";
  }
}

interface Change {
  status: string;
  file: string;
}

async function changedFiles(a: string, b: string): Promise<Change[]> {
  const out = await git(["diff", "--name-status", "--no-renames", "-z", a, b]);
  const parts = out.split("\0").filter(Boolean);
  const res: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2)
    res.push({ status: parts[i], file: parts[i + 1] });
  return res;
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's built-in empty tree

const IDENT = {
  GIT_AUTHOR_NAME: "Waypoint",
  GIT_AUTHOR_EMAIL: "waypoint@localhost",
  GIT_COMMITTER_NAME: "Waypoint",
  GIT_COMMITTER_EMAIL: "waypoint@localhost",
};

type RepoState = "ok" | "norepo" | "nogit";

async function repoState(): Promise<RepoState> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"]);
    return "ok";
  } catch (e: any) {
    return /ENOENT/.test(String(e?.message)) ? "nogit" : "norepo";
  }
}

/** HEAD, or the empty tree when the repo has no commits yet. */
async function baseRef(): Promise<string> {
  return (await headSha()) ? "HEAD" : EMPTY_TREE;
}

async function requireRepo(): Promise<boolean> {
  if ((await repoState()) === "ok") return true;
  vscode.window.showInformationMessage(
    "Waypoint needs a git repository. Open the Waypoint sidebar to set one up.",
  );
  return false;
}

async function branchName(): Promise<string> {
  try {
    return (await git(["symbolic-ref", "--short", "-q", "HEAD"])).trim(); // "" if detached
  } catch {
    return "";
  }
}

/** Ref-safe key for the current branch. */
async function currentKey(): Promise<string> {
  const b = await branchName();
  return b ? "br-" + encodeURIComponent(b) : "detached";
}

/** One-time move of old flat refs (refs/checkpoints/<time>) into the current branch. */
async function migrateLegacy(): Promise<void> {
  const out = await git([
    "for-each-ref",
    "--format=%(refname)",
    "refs/checkpoints",
  ]);
  const flat = out
    .split("\n")
    .filter((r) => /^refs\/checkpoints\/\d+$/.test(r));
  if (!flat.length) return;
  const key = await currentKey();
  for (const ref of flat) {
    const id = ref.split("/").pop()!;
    await git(["update-ref", `refs/checkpoints/${key}/${id}`, ref]);
    await git(["update-ref", "-d", ref]);
  }
}

// ---------- virtual documents ----------

const SCHEME = "checkpoint";

class CheckpointContent implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { ref } = JSON.parse(uri.query);
    try {
      return await git(["show", `${ref}:${uri.path.slice(1)}`]);
    } catch {
      return "";
    }
  }
}

function cpUri(ref: string, file: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: "/" + file,
    query: JSON.stringify({ ref }),
  });
}

// ---------- tree ----------

type Target = CP | "working";

type Node =
  | { kind: "cp"; cp: CP; prev: string }
  | { kind: "live"; latest: string }
  | { kind: "compare"; a: CP; b: Target }
  | {
      kind: "file";
      change: Change;
      left: vscode.Uri;
      right: vscode.Uri;
      title: string;
      restoreRef?: string;
    };

const ICONS: Record<string, string> = {
  A: "diff-added",
  D: "diff-removed",
  M: "diff-modified",
};
const COLORS: Record<string, string> = {
  A: "gitDecoration.addedResourceForeground",
  D: "gitDecoration.deletedResourceForeground",
  M: "gitDecoration.modifiedResourceForeground",
};

class CheckpointTree implements vscode.TreeDataProvider<Node> {
  private _change = new vscode.EventEmitter<void>();
  onDidChangeTreeData = this._change.event;
  private comparison?: { a: CP; b: Target };
  private filter = "";
  onFilterChange?: (f: string) => void;
  onBranch?: (b: string) => void;
  refresh() {
    this._change.fire();
  }
  setComparison(c?: { a: CP; b: Target }) {
    this.comparison = c;
    this.refresh();
  }
  setFilter(f: string) {
    this.filter = f.trim().toLowerCase();
    this.onFilterChange?.(this.filter);
    this.refresh();
  }

  private keep(changes: Change[]): Change[] {
    return this.filter
      ? changes.filter((c) => c.file.toLowerCase().includes(this.filter))
      : changes;
  }

  private fileNodes(
    changes: Change[],
    baseRef: string,
    rightRef: string,
    title: (f: string) => string,
    restoreRef?: string,
  ): Node[] {
    return changes.map((change) => ({
      kind: "file" as const,
      change,
      left: cpUri(baseRef, change.file),
      right: cpUri(rightRef, change.file),
      title: title(change.file),
      restoreRef,
    }));
  }

  /** base checkpoint/HEAD  ↔  real files on disk (right side stays editable) */
  private async workingNodes(
    baseRef: string,
    baseLabel: string,
  ): Promise<Node[]> {
    const tree = await snapshotTree();
    const changes = this.keep(await changedFiles(baseRef, tree));
    return changes.map((change) => ({
      kind: "file" as const,
      change,
      left: cpUri(baseRef, change.file),
      right:
        change.status === "D"
          ? cpUri(tree, change.file)
          : vscode.Uri.file(path.join(root, change.file)),
      title: `${path.basename(change.file)} (${baseLabel} ↔ working)`,
      restoreRef: baseRef,
    }));
  }
  async getChildren(node?: Node): Promise<Node[]> {
    try {
      return await this.load(node);
    } catch (e) {
      console.error("Waypoint:", e);
      return [];
    }
  }

  private async load(node?: Node): Promise<Node[]> {
    if (!node) {
      const state = root ? await repoState() : "nofolder";
      vscode.commands.executeCommand("setContext", "waypoint.state", state);
      if (state !== "ok") return [];
      this.onBranch?.((await branchName()) || "detached HEAD");
      const base = await baseRef();
      const list = await listCheckpoints();
      let entries = list.map((cp, i) => ({
        cp,
        prev: i === 0 ? base : list[i - 1].ref,
      }));

      // ...the filter block stays exactly as it was...

      const nodes: Node[] = [];
      if (this.comparison) nodes.push({ kind: "compare", ...this.comparison });
      entries.forEach((e) =>
        nodes.push({ kind: "cp", cp: e.cp, prev: e.prev }),
      );
      nodes.push({
        kind: "live",
        latest: list.length ? list[list.length - 1].ref : base,
      });
      return nodes;
    }

    if (node.kind === "cp") {
      const changes = this.keep(await changedFiles(node.prev, node.cp.ref));
      return this.fileNodes(
        changes,
        node.prev,
        node.cp.ref,
        (f) => `${path.basename(f)} (before ↔ ${node.cp.label})`,
        node.cp.ref, // restore = "how this file was at this checkpoint"
      );
    }

    if (node.kind === "compare") {
      if (node.b === "working")
        return this.workingNodes(node.a.ref, node.a.label);
      const b = node.b;
      const changes = this.keep(await changedFiles(node.a.ref, b.ref));
      return this.fileNodes(
        changes,
        node.a.ref,
        b.ref,
        (f) => `${path.basename(f)} (${node.a.label} ↔ ${b.label})`,
      );
    }

    if (node.kind === "live")
      return this.workingNodes(node.latest, "last checkpoint");

    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "cp") {
      const item = new vscode.TreeItem(
        node.cp.label,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = node.cp.date.toLocaleTimeString();
      item.tooltip = node.cp.date.toLocaleString();
      item.contextValue = "checkpoint";
      const l = node.cp.label;
      item.iconPath = new vscode.ThemeIcon(
        l.startsWith(GUARD_PREFIX)
          ? "shield"
          : l.startsWith(AUTO_PREFIX)
            ? "clock"
            : "bookmark",
      );
      item.id = node.cp.ref;
      return item;
    }
    if (node.kind === "compare") {
      const right = node.b === "working" ? "Working changes" : node.b.label;
      const item = new vscode.TreeItem(
        `Compare: ${node.a.label} ↔ ${right}`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = "comparison";
      item.iconPath = new vscode.ThemeIcon("git-compare");
      item.id = "compare";
      return item;
    }
    if (node.kind === "live") {
      const item = new vscode.TreeItem(
        "Working changes",
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = "since last checkpoint";
      item.iconPath = new vscode.ThemeIcon("edit");
      item.id = "live";
      return item;
    }
    const { status, file } = node.change;
    const dir = path.dirname(file);
    const item = new vscode.TreeItem(
      path.basename(file),
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${status}  ${dir === "." ? "" : dir}`;
    const color = COLORS[status];
    item.iconPath = new vscode.ThemeIcon(
      ICONS[status] ?? "diff",
      color ? new vscode.ThemeColor(color) : undefined,
    );
    item.contextValue = node.restoreRef ? "restorableFile" : "file";
    item.command = {
      command: "vscode.diff",
      title: "Open diff",
      arguments: [node.left, node.right, node.title],
    };
    return item;
  }
}

// ---------- auto checkpoints ----------

const cfg = () => vscode.workspace.getConfiguration("waypoint");

async function autoCheckpoint(tree: CheckpointTree) {
  const list = await listCheckpoints();
  const snap = await snapshotTree();
  const base = list.length ? list[list.length - 1].ref : "HEAD";
  const baseTree = (await git(["rev-parse", `${base}^{tree}`])).trim();
  if (snap === baseTree) return; // nothing changed

  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  await createCheckpoint(`${AUTO_PREFIX}${time}`, snap);

  const keep = Math.max(1, cfg().get<number>("autoKeep", 20));
  const autos = (await listCheckpoints()).filter((c) =>
    c.label.startsWith(AUTO_PREFIX),
  );
  for (const old of autos.slice(0, Math.max(0, autos.length - keep))) {
    await git(["update-ref", "-d", old.ref]);
  }
  tree.refresh();
}

// ---------- commit detection ----------

async function watchCommits(
  context: vscode.ExtensionContext,
  tree: CheckpointTree,
) {
  let gitDir: string;
  try {
    gitDir = (await git(["rev-parse", "--absolute-git-dir"])).trim();
  } catch {
    return;
  }
  let lastHead = await headSha();
  let lastKey = await currentKey();
  let timer: NodeJS.Timeout | undefined;

  const check = async () => {
    // branch switched (even between two branches on the same commit)
    const key = await currentKey();
    if (key !== lastKey) {
      lastKey = key;
      tree.setComparison(undefined); // also refreshes the tree
    }

    const head = await headSha();
    if (!head || head === lastHead) return;
    const old = lastHead;
    lastHead = head;
    if (!old) return;

    // only a real commit offers to clear; checkout, pull and reset leave checkpoints alone
    const op = await lastHeadOp();
    if (!op || !op.text.startsWith("commit")) return;

    const list = await listCheckpoints();
    if (!list.length) return;

    const mode = cfg().get<string>("onCommit", "ask");
    if (mode === "keep") return;
    if (mode === "ask") {
      const pick = await vscode.window.showInformationMessage(
        `New commit detected. Clear ${list.length} checkpoint(s) on this branch?`,
        "Clear",
        "Keep",
      );
      if (pick !== "Clear") return;
    }
    await clearAll();
    tree.setComparison(undefined);
  };

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(gitDir, "logs/HEAD"),
  );
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => check().catch(() => {}), 500);
  };
  watcher.onDidChange(schedule);
  watcher.onDidCreate(schedule);
  context.subscriptions.push(watcher);
}

// ---------- safety net: checkpoint before risky moments ----------

class SafetyNet {
  private base = ""; // snapshot of the last "quiet" moment
  private baseHead = "";
  private pending = new Set<string>(); // files changed outside the editor
  private pendingSince = 0;
  private saves = new Map<string, number>(); // files the editor itself is saving
  private timer?: NodeJS.Timeout;
  private running = false;
  private suppressUntil = 0;

  constructor(private tree: CheckpointTree) {}

  async start(context: vscode.ExtensionContext) {
    this.base = await snapshotTree().catch(() => "");
    this.baseHead = await headSha();

    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, "**/*"),
    );
    const onEvent = (uri: vscode.Uri) => this.onFile(uri);
    context.subscriptions.push(
      w,
      w.onDidChange(onEvent),
      w.onDidCreate(onEvent),
      w.onDidDelete(onEvent),
      // fires before the write, so editor saves are never mistaken for outside changes
      vscode.workspace.onWillSaveTextDocument((e) => {
        this.saves.set(e.document.uri.fsPath, Date.now());
      }),
      { dispose: () => clearTimeout(this.timer) },
    );
  }

  /** Called by Waypoint's own file-rewriting commands so they aren't mistaken for outside changes. */
  quiet(ms = 6000) {
    this.suppressUntil = Date.now() + ms;
    this.pending.clear();
  }
  private onFile(uri: vscode.Uri) {
    if (!cfg().get<boolean>("safety.enabled", true)) return;
    const p = uri.fsPath;
    if (
      p.includes(`${path.sep}.git${path.sep}`) ||
      p.includes(`${path.sep}node_modules${path.sep}`)
    )
      return;

    const savedAt = this.saves.get(p);
    const quiet = Date.now() < this.suppressUntil;
    if (!quiet && (!savedAt || Date.now() - savedAt > 3000)) {
      if (this.pending.size === 0) this.pendingSince = Date.now();
      this.pending.add(p);
    }
    this.schedule(2500);
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.settle().catch(() => {}), ms);
  }

  private advance(treeSha: string, head: string) {
    this.base = treeSha;
    this.baseHead = head;
    this.pending.clear();
    this.pendingSince = 0;
  }

  private async settle() {
    if ((await repoState()) !== "ok") {
      this.base = "";
      return;
    }
    if (this.running) return this.schedule(2500);
    this.running = true;
    try {
      const now = await snapshotTree();
      const head = await headSha();
      const threshold = Math.max(
        2,
        cfg().get<number>("safety.bulkChangeThreshold", 6),
      );

      let reason = "";
      if (this.pending.size > 0) {
        const op = await lastHeadOp();
        if (
          head !== this.baseHead &&
          op &&
          op.ageSec < 60 &&
          !op.text.startsWith("commit")
        ) {
          reason = `before ${op.text.slice(0, 50)}`; // e.g. "before reset: moving to HEAD~1"
        } else if (this.pending.size >= threshold) {
          reason = `before bulk change (${this.pending.size} files)`;
        }
      }

      if (reason) {
        if (
          this.base &&
          this.base !== now &&
          !(await this.isLatestCheckpoint(this.base))
        ) {
          await createCheckpoint(GUARD_PREFIX + reason, this.base);
          await this.prune();
          vscode.window.setStatusBarMessage(
            `Waypoint: saved "${GUARD_PREFIX}${reason}"`,
            6000,
          );
          this.tree.refresh();
        }
        this.advance(now, head);
      } else if (
        this.pending.size === 0 ||
        Date.now() - this.pendingSince > 30_000
      ) {
        // only normal editing (or a small change that has aged out): move the baseline forward
        this.advance(now, head);
      }
    } finally {
      this.running = false;
    }
  }

  private async isLatestCheckpoint(treeSha: string): Promise<boolean> {
    const list = await listCheckpoints();
    if (!list.length) return false;
    const last = (
      await git(["rev-parse", `${list[list.length - 1].ref}^{tree}`])
    ).trim();
    return last === treeSha;
  }

  private async prune() {
    const keep = Math.max(1, cfg().get<number>("safety.keep", 10));
    const guards = (await listCheckpoints()).filter((c) =>
      c.label.startsWith(GUARD_PREFIX),
    );
    for (const old of guards.slice(0, Math.max(0, guards.length - keep))) {
      await git(["update-ref", "-d", old.ref]);
    }
  }
}
// ---------- activate ----------

export function activate(context: vscode.ExtensionContext) {
  root = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? "";

  const tree = new CheckpointTree();
  const view = vscode.window.createTreeView("waypointView", {
    treeDataProvider: tree,
  });
  let branchLabel = "";
  let filterText = "";
  // ...updateDescription, tree.onFilterChange, tree.onBranch: keep as they are...
  context.subscriptions.push(view);

  if (!root) return; // no folder open: the sidebar shows the "open a folder" message

  migrateLegacy()
    .then(() => tree.refresh())
    .catch(() => {});

  const safety = new SafetyNet(tree);
  void safety.start(context);

  let selected: CP | undefined;

  // status bar button
  const sb = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  sb.text = "$(bookmark) Checkpoint";
  sb.tooltip = "Waypoint: create checkpoint (Ctrl/Cmd+Alt+K)";
  sb.command = "waypoint.create";
  sb.show();
  tree.onFilterChange = (f) => {
    view.description = f ? `filter: ${f}` : undefined;
    vscode.commands.executeCommand(
      "setContext",
      "waypoint.filterActive",
      !!f,
    );
  };
  context.subscriptions.push(
    sb,
    vscode.workspace.registerTextDocumentContentProvider(
      SCHEME,
      new CheckpointContent(),
    ),
    view,
  );

  // refresh "Working changes" after saves
  let saveTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => tree.refresh(), 800);
    }),
  );

  // auto checkpoints
  let autoTimer: NodeJS.Timeout | undefined;
  const setupAuto = () => {
    clearInterval(autoTimer);
    const mins = cfg().get<number>("autoIntervalMinutes", 0);
    if (mins > 0)
      autoTimer = setInterval(
        () => autoCheckpoint(tree).catch(() => {}),
        mins * 60_000,
      );
  };
  setupAuto();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("waypoint.autoIntervalMinutes"))
        setupAuto();
    }),
    { dispose: () => clearInterval(autoTimer) },
  );

  watchCommits(context, tree);

  context.subscriptions.push(
    vscode.commands.registerCommand("waypoint.refresh", () =>
      tree.refresh(),
    ),

    vscode.commands.registerCommand("waypoint.create", async () => {
      if (!(await requireRepo())) return;
      const n = (await listCheckpoints()).length + 1;
      const label = await vscode.window.showInputBox({
        prompt: "Checkpoint name",
        value: `Checkpoint ${n}`,
      });
      if (!label) return;
      try {
        await createCheckpoint(label);
        tree.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(
          `Waypoint: checkpoint failed: ${e.message}`,
        );
      }
    }),

    vscode.commands.registerCommand("waypoint.initRepo", async () => {
      try {
        await git(["init"]);
      } catch (e: any) {
        vscode.window.showErrorMessage(`git init failed: ${e.message}`);
      }
      tree.refresh();
    }),

    vscode.commands.registerCommand("waypoint.restore", async (node: Node) => {
      if (node?.kind !== "cp") return;
      const ok = await vscode.window.showWarningMessage(
        `Restore "${node.cp.label}"? Your current files will be overwritten. You can undo this right after.`,
        { modal: true },
        "Restore",
      );
      if (ok !== "Restore") return;

      const trash = await saveToTrash(`Before restoring ${node.cp.label}`);
      safety.quiet();
      await git([
        "restore",
        `--source=${node.cp.ref}`,
        "--worktree",
        "--",
        ".",
      ]);
      tree.refresh();

      const pick = await vscode.window.showInformationMessage(
        `Restored "${node.cp.label}"`,
        "Undo",
      );
      if (pick === "Undo") {
        safety.quiet();
        await git(["restore", `--source=${trash}`, "--worktree", "--", "."]);
        tree.refresh();
      }
    }),

    vscode.commands.registerCommand(
      "waypoint.restore",
      async (node: Node) => {
        if (node?.kind !== "cp") return;
        const ok = await vscode.window.showWarningMessage(
          `Restore "${node.cp.label}"? Current files will be overwritten (a safety checkpoint is saved first).`,
          { modal: true },
          "Restore",
        );
        if (ok !== "Restore") return;
        await createCheckpoint("Safety · before restore");
        await git([
          "restore",
          `--source=${node.cp.ref}`,
          "--worktree",
          "--",
          ".",
        ]);
        tree.refresh();
      },
    ),
    vscode.commands.registerCommand("waypoint.beforeAgent", async () => {
      const time = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      await createCheckpoint(`Before agent · ${time}`);
      tree.refresh();
    }),

    vscode.commands.registerCommand(
      "waypoint.delete",
      async (node: Node) => {
        if (node?.kind !== "cp") return;
        await git(["update-ref", "-d", node.cp.ref]);
        tree.refresh();
      },
    ),

    vscode.commands.registerCommand("waypoint.clear", async () => {
      const count = (await listCheckpoints()).length;
      if (!count) return;
      const ok = await vscode.window.showWarningMessage(
        `Delete all ${count} checkpoints?`,
        { modal: true },
        "Delete",
      );
      if (ok !== "Delete") return;
      await clearAll();
      tree.setComparison(undefined);
    }),

    vscode.commands.registerCommand(
      "waypoint.selectForCompare",
      (node: Node) => {
        if (node?.kind !== "cp") return;
        selected = node.cp;
        vscode.window.setStatusBarMessage(
          `Selected "${node.cp.label}" for compare`,
          3000,
        );
      },
    ),

    vscode.commands.registerCommand(
      "waypoint.compareWithSelected",
      (node: Node) => {
        if (node?.kind !== "cp") return;
        if (!selected) {
          vscode.window.showInformationMessage(
            'Right-click a checkpoint → "Select for Compare" first.',
          );
          return;
        }
        if (selected.ref === node.cp.ref) return;
        const [a, b] = [selected, node.cp].sort((x, y) =>
          x.ref < y.ref ? -1 : 1,
        ); // older first
        tree.setComparison({ a, b });
      },
    ),

    vscode.commands.registerCommand("waypoint.clearComparison", () =>
      tree.setComparison(undefined),
    ),
    vscode.commands.registerCommand(
      "waypoint.compareWithWorking",
      (node: Node) => {
        if (node?.kind !== "cp") return;
        tree.setComparison({ a: node.cp, b: "working" });
      },
    ),

    vscode.commands.registerCommand("waypoint.filter", async () => {
      const f = await vscode.window.showInputBox({
        prompt: "Show only files whose path contains…",
        placeHolder: "e.g. TargetAndIncentive, Item.tsx, .css",
      });
      if (f !== undefined) tree.setFilter(f);
    }),

    vscode.commands.registerCommand("waypoint.clearFilter", () =>
      tree.setFilter(""),
    ),
  );
}

export function deactivate() {}
