# Waypoint – Git Snapshots

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
- **Restore.** Right-click → *Restore Checkpoint*. Waypoint saves a safety checkpoint first.
- **Auto-checkpoints (optional).** Save a checkpoint every N minutes, only when something changed. Older automatic ones are pruned.
- **Clean up after commits.** When you commit, Waypoint can offer to clear your checkpoints, since you no longer need them.

Checkpoints include untracked files and respect `.gitignore`.

## Usage

1. Open a folder that is a git repository.
2. Click the Waypoint icon in the activity bar.
3. Finish a step, then press `Cmd+Alt+K` and name your checkpoint.
4. Keep working. **Working changes** always shows the difference from your last checkpoint.
5. Create the next checkpoint when the next step is done, then expand it to review just that step.

## Settings

| Setting | Default | Description |
|---|---|---|
| `waypoint.autoIntervalMinutes` | `0` | Create an automatic checkpoint every N minutes if files changed. `0` turns it off. |
| `waypoint.autoKeep` | `20` | How many automatic checkpoints to keep. |
| `waypoint.onCommit` | `ask` | What to do with checkpoints after you commit: `ask`, `clear`, or `keep`. |

## How it works

Waypoint stores each snapshot as a git commit under a private ref, `refs/checkpoints/*`. To capture your whole working tree, it uses a temporary copy of the index, so your real staging area is never touched. Nothing is added to your branches, history, or stash.

Everything runs through your local `git` command. Waypoint makes no network requests and sends no data anywhere.

## Limitations

- **Local only.** Checkpoints live in your local repository. A normal `git push` doesn't send them, and they're gone if you delete or re-clone the repo.
- **Restore doesn't delete files.** It overwrites files that existed at the checkpoint, but files you created afterwards stay. Your staging area is left as it is.
- **First workspace folder only.** In a multi-root workspace, Waypoint uses the first folder.
- **Large repositories.** Refreshing *Working changes* snapshots the working tree each time, which may feel slow in very large repos. If so, avoid short auto-checkpoint intervals.
- **Requires `git`** on your PATH.

## Removing checkpoints manually

Use the **Clear All** button in the sidebar, or run this in your repository:

```bash
git for-each-ref --format='%(refname)' refs/checkpoints | xargs -n1 git update-ref -d
```

Uninstalling the extension does not delete your checkpoints.

## Feedback

Found a bug or have an idea? Please open an issue: https://github.com/nksharmaexe/waypoint/issues

## License

MIT
