# Changelog

All notable changes to Waypoint are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-28

First public release.

### Added

- Checkpoints: save a hidden snapshot of your whole working tree (including untracked files, respecting `.gitignore`) without commits, without touching your branch, staging area or history. Create one with `Cmd+Alt+K` / `Ctrl+Alt+K`, the sidebar **+** button, or the status bar.
- Sidebar view listing checkpoints, with the files each one changed compared with the previous checkpoint and a side-by-side diff for each file.
- **Working changes** node showing everything changed since the latest checkpoint, with an editable right-hand side.
- Compare any two checkpoints, and compare a checkpoint with your working changes.
- Filter by file path, which also hides checkpoints that never touched a matching file.
- Restore a checkpoint, with a hidden safety copy of your current files and an **Undo** button afterwards.
- One checkpoint list per branch, with the current branch shown in the sidebar header.
- Guard checkpoints: automatic checkpoints saved *before* a pull, checkout, reset, rebase or bulk file change, so you can get back to where you were. Also available manually as **Waypoint: Checkpoint Before Agent**.
- Optional timed auto-checkpoints, saved only when something changed.
- Offer to clear a branch's checkpoints after you commit (`ask`, `clear` or `keep`).
- Support for repositories with no commits yet, and an **Initialize Repository** button for folders that aren't git repositories.
- Settings: `waypoint.autoIntervalMinutes`, `waypoint.autoKeep`, `waypoint.onCommit`, `waypoint.safety.enabled`, `waypoint.safety.bulkChangeThreshold`, `waypoint.safety.keep`.

### Notes

- Checkpoints are stored locally under `refs/checkpoints/` and are not pushed by a normal `git push`.
- Restore safety copies are stored under `refs/checkpoints-trash/` (newest 20 kept).