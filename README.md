# Waypoint – Git Snapshots

> [!WARNING]
> **Temporary notice:** Waypoint is currently experiencing a bug in version `0.1.1`. Please avoid using this version until a fix is released.
>
> A patched version will be published as soon as possible. If you have already installed the extension, you can temporarily disable it from the Extensions panel in your IDE.

**Save hidden snapshots of your work between steps, with no commits, and diff any step against the last.**

You finish step 1 and don't want to commit yet. Staging it works until step 2, when everything lands in one pile again. Waypoint gives you checkpoints between steps without touching your branch, your staging area, or your commit history.

<!-- Add a screenshot or GIF here, using an https:// URL, e.g.
![Waypoint sidebar and diff](https://raw.githubusercontent.com/nksharmaexe/waypoint/main/media/demo.gif)
-->
## Features

- **Checkpoints in one click.** Press `Cmd+Alt+K` (`Ctrl+Alt+K` on Windows/Linux), use the **+** button in the sidebar, or click **Checkpoint** in the status bar.
- **See what each step changed.** Expand a checkpoint to see only the files it changed compared with the previous one. Click a file for a side-by-side diff.
- **Working changes.** A live node shows everything you've changed since the latest checkpoint, including files you edited after staging them. The right side of the diff is your real, editable file.
- **Compare any two checkpoints.** Right-click one → *Select for Compare*, then right-click another → *Compare with Selected*.
- **Compare a checkpoint with your current work.** Right-click → *Compare with Working Changes*.
- **Filter.** Click the search icon to show only files whose path contains some text. Checkpoints that never touched a matching file are hidden.
- **Restore with undo.** Right-click → *Restore Checkpoint*. Waypoint first saves a hidden copy of your current files, then shows an **Undo** button after the restore.
- **One list per branch.** Each branch has its own checkpoints. Switching branches swaps the list, and the current branch is shown in the sidebar header.
- **Guard checkpoints (automatic safety net).** Waypoint saves a checkpoint *before* a pull, checkout, reset, rebase, or a bulk change to your files, so you can get back to where you were. See [Guard checkpoints](#guard-checkpoints).
- **Timed auto-checkpoints (optional).** Save a checkpoint every N minutes, only when something changed. Older automatic ones are pruned.
- **Clean up after commits.** When you commit, Waypoint can offer to clear that branch's checkpoints, since you no longer need them.
- **Works in new repositories.** No commits yet? Checkpoints still work. Not a git repository? The sidebar offers to initialize one.

Checkpoints include untracked files and respect `.gitignore`.

## Usage

1. Open a folder that is a git repository.
2. Click the Waypoint icon in the activity bar.
3. Finish a step, then press `Cmd+Alt+K` and name your checkpoint.
4. Keep working. **Working changes** always shows the difference from your last checkpoint.
5. Create the next checkpoint when the next step is done, then expand it to review just that step.

## Guard checkpoints

Guard checkpoints are created automatically and are marked with a shield icon. They are named after what triggered them, for example `Guard · before reset: moving to HEAD~1` or `Guard · before bulk change (8 files)`.

Waypoint keeps a quiet baseline snapshot of your files. A Guard checkpoint stores that baseline, meaning your files **as they were just before** the change, when one of these happens:

- **HEAD moves** because of a pull, checkout, reset or rebase, and files change as a result. Plain commits don't count.
- **A bulk change** is made outside the editor: `waypoint.safety.bulkChangeThreshold` or more files change on disk without being saved from VS Code. This catches *Discard All Changes*, `git stash`, code generators and AI agents that write files directly.

If the change wasn't what you wanted, right-click the Guard checkpoint → *Restore Checkpoint*. Because it holds your state from before the operation, it can bring back uncommitted work that a `git reset --hard` would have erased.

Before running an AI agent, you can also run **Waypoint: Checkpoint Before Agent** from the command palette.

Turn Guard checkpoints off with `waypoint.safety.enabled`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `waypoint.autoIntervalMinutes` | `0` | Create an automatic checkpoint every N minutes if files changed. `0` turns it off. |
| `waypoint.autoKeep` | `20` | How many timed automatic checkpoints to keep. |
| `waypoint.onCommit` | `ask` | What to do with this branch's checkpoints after you commit: `ask`, `clear`, or `keep`. |
| `waypoint.safety.enabled` | `true` | Create Guard checkpoints before pulls, checkouts, resets, rebases and bulk changes. |
| `waypoint.safety.bulkChangeThreshold` | `6` | How many files changed outside the editor count as a bulk change. |
| `waypoint.safety.keep` | `10` | How many Guard checkpoints to keep. |

## Commands

| Command | Where |
|---|---|
| Create Checkpoint (`Cmd+Alt+K`) | Command palette, sidebar **+**, status bar |
| Checkpoint Before Agent | Command palette |
| Initialize Repository | Sidebar, when the folder isn't a git repository |
| Restore, Delete, Select for Compare, Compare with Selected, Compare with Working Changes | Right-click a checkpoint |
| Filter, Clear Filter, Refresh, Clear All | Sidebar toolbar |

## How it works

Waypoint stores each snapshot as a git commit under a private ref, `refs/checkpoints/<branch>/<time>`. To capture your whole working tree, it uses a temporary copy of the index, so your real staging area is never touched. Nothing is added to your branches, history, or stash. The hidden commits use their own author identity (`Waypoint`), so your git configuration isn't needed or changed.

Before a restore, a safety copy of your files is kept under `refs/checkpoints-trash/` (the newest 20), separate from your checkpoint list so it never appears as a new step.

Everything runs through your local `git` command. Waypoint makes no network requests and sends no data anywhere.

## Limitations

- **Local only.** Checkpoints live in your local repository. A normal `git push` doesn't send them, and they're gone if you delete or re-clone the repo.
- **Restore and new files.** Restore rewrites your files to match the checkpoint. Files that git tracks but that didn't exist at the checkpoint are removed, while brand-new untracked files are left in place. The undo copy covers both cases. Your staging area is left as it is.
- **Guard timing.** The baseline updates about 2.5 seconds after your last file change, so an edit made in the same moment as a destructive command may not be in the Guard checkpoint. A change to fewer files than the threshold, without a HEAD move, isn't caught.
- **First workspace folder only.** In a multi-root workspace, Waypoint uses the first folder. Open the repository's root folder.
- **Large repositories.** Refreshing *Working changes* and the Guard baseline snapshot the working tree, which may feel slow in very large repos. If so, turn off Guard checkpoints and avoid short auto-checkpoint intervals.
- **Deleted or renamed branches** leave their checkpoints behind. They're invisible but harmless, and can be removed with the command below.
- **Requires `git`** on your PATH.

## Removing checkpoints manually

Use **Clear All** in the sidebar for the current branch, or run this in your repository to remove checkpoints for every branch:

```bash
git for-each-ref --format='%(refname)' refs/checkpoints | xargs -n1 git update-ref -d
```

To remove the restore safety copies:

```bash
git for-each-ref --format='%(refname)' refs/checkpoints-trash | xargs -n1 git update-ref -d
```

Uninstalling the extension does not delete your checkpoints.

## Feedback

Found a bug or have an idea? Please open an issue: https://github.com/nksharmaexe/waypoint/issues

## License

MIT