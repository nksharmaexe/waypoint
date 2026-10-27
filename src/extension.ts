import * as vscode from "vscode";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let root = "";
const AUTO_PREFIX = "Auto · ";

// ---------- git helpers ----------

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

interface CP {
  ref: string;
  label: string;
  date: Date;
}

async function listCheckpoints(): Promise<CP[]> {
  const out = await git([
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%09%(creatordate:iso-strict)%09%(contents:subject)",
    "refs/checkpoints",
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
  const parent = list.length ? list[list.length - 1].ref : "HEAD";
  const commit = (
    await git(["commit-tree", tree, "-p", parent, "-m", label])
  ).trim();
  await git(["update-ref", `refs/checkpoints/${Date.now()}`, commit]);
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
  ): Node[] {
    return changes.map((change) => ({
      kind: "file" as const,
      change,
      left: cpUri(baseRef, change.file),
      right: cpUri(rightRef, change.file),
      title: title(change.file),
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
    }));
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!root) return [];

    if (!node) {
      const list = await listCheckpoints();
      let entries = list.map((cp, i) => ({
        cp,
        prev: i === 0 ? "HEAD" : list[i - 1].ref,
      }));

      // when filtering, hide checkpoints that touched no matching file
      if (this.filter) {
        const hits = await Promise.all(
          entries.map(
            async (e) =>
              this.keep(await changedFiles(e.prev, e.cp.ref)).length > 0,
          ),
        );
        entries = entries.filter((_, i) => hits[i]);
      }

      const nodes: Node[] = [];
      if (this.comparison) nodes.push({ kind: "compare", ...this.comparison });
      entries.forEach((e) =>
        nodes.push({ kind: "cp", cp: e.cp, prev: e.prev }),
      );
      nodes.push({
        kind: "live",
        latest: list.length ? list[list.length - 1].ref : "HEAD",
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
      item.iconPath = new vscode.ThemeIcon(
        node.cp.label.startsWith(AUTO_PREFIX) ? "clock" : "bookmark",
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
    item.command = {
      command: "vscode.diff",
      title: "Open diff",
      arguments: [node.left, node.right, node.title],
    };
    return item;
  }
}

// ---------- auto checkpoints ----------

const cfg = () => vscode.workspace.getConfiguration("checkpoints");

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
  let timer: NodeJS.Timeout | undefined;

  const check = async () => {
    const head = await headSha();
    if (!head || head === lastHead) return;
    const old = lastHead;
    lastHead = head;
    if (!old) return;

    // only react when the new HEAD is a descendant of the old one (commit / fast-forward)
    const forward = await git(["merge-base", "--is-ancestor", old, head]).then(
      () => true,
      () => false,
    );
    if (!forward) return;

    const list = await listCheckpoints();
    if (!list.length) return;

    const mode = cfg().get<string>("onCommit", "ask");
    if (mode === "keep") return;
    if (mode === "ask") {
      const pick = await vscode.window.showInformationMessage(
        `New commit detected. Clear ${list.length} checkpoint(s)?`,
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

// ---------- activate ----------

export function activate(context: vscode.ExtensionContext) {
  root = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? "";
  if (!root) return;

  const tree = new CheckpointTree();
  let selected: CP | undefined;

  // status bar button
  const sb = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  sb.text = "$(bookmark) Checkpoint";
  sb.tooltip = "Waypoint: create checkpoint (Ctrl/Cmd+Alt+K)";
  sb.command = "checkpoints.create";
  sb.show();
  const view = vscode.window.createTreeView("waypointView", {
    treeDataProvider: tree,
  });
  tree.onFilterChange = (f) => {
    view.description = f ? `filter: ${f}` : undefined;
    vscode.commands.executeCommand(
      "setContext",
      "checkpoints.filterActive",
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
      if (e.affectsConfiguration("checkpoints.autoIntervalMinutes"))
        setupAuto();
    }),
    { dispose: () => clearInterval(autoTimer) },
  );

  watchCommits(context, tree);

  context.subscriptions.push(
    vscode.commands.registerCommand("checkpoints.refresh", () =>
      tree.refresh(),
    ),

    vscode.commands.registerCommand("checkpoints.create", async () => {
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
        vscode.window.showErrorMessage(`Checkpoint failed: Waypoint: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand(
      "checkpoints.restore",
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

    vscode.commands.registerCommand(
      "checkpoints.delete",
      async (node: Node) => {
        if (node?.kind !== "cp") return;
        await git(["update-ref", "-d", node.cp.ref]);
        tree.refresh();
      },
    ),

    vscode.commands.registerCommand("checkpoints.clear", async () => {
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
      "checkpoints.selectForCompare",
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
      "checkpoints.compareWithSelected",
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

    vscode.commands.registerCommand("checkpoints.clearComparison", () =>
      tree.setComparison(undefined),
    ),
    vscode.commands.registerCommand(
      "checkpoints.compareWithWorking",
      (node: Node) => {
        if (node?.kind !== "cp") return;
        tree.setComparison({ a: node.cp, b: "working" });
      },
    ),

    vscode.commands.registerCommand("checkpoints.filter", async () => {
      const f = await vscode.window.showInputBox({
        prompt: "Show only files whose path contains…",
        placeHolder: "e.g. TargetAndIncentive, Item.tsx, .css",
      });
      if (f !== undefined) tree.setFilter(f);
    }),

    vscode.commands.registerCommand("checkpoints.clearFilter", () =>
      tree.setFilter(""),
    ),
  );
}

export function deactivate() {}
