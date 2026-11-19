# AGENTS.md

Instructions for coding agents working in this repo.

## What this is

A VS Code / Cursor extension: a tree view of terminals grouped by workspace folder. Plain JavaScript, no build step, no runtime dependencies. The primary target is Cursor (`cursor` CLI).

## Layout

- `extension.js`: everything that touches the `vscode` API. Tree provider, drag and drop, commands, filters, sorting, Claude state polling, file decorations.
- `lib.js`: pure helpers with no `vscode` import (`classify`, `applyOrder`, `reorder`, `claudeEntryFor`, `isUnread`). Put new logic here when it can be tested without VS Code.
- `lib.test.js`: `node --test` unit tests for `lib.js`.
- `hooks/claude-state.sh`: optional Claude Code hook. Writes `~/.cache/terminal-groups/claude/<session_id>.json` with the session state and its process ancestry.
- `media/`: view container icon and the folder icons.

## Commands

```sh
pnpm test                 # unit tests
node --check extension.js # syntax check
pnpm run install-local    # package .vsix and install into Cursor, then reload the window
```

## How grouping works

1. Task terminals are titled `label (folder name)`. Task configs are read from each folder's `tasks.json` and from the `.code-workspace` `tasks` block, which also supplies icons and colors.
2. Workspace-file tasks are titled `label (<workspace name>)`, and the name can contain parens. They're grouped by the `${workspaceFolder:X}` in their `options.cwd`.
3. Anything else is grouped by its shell cwd. The longest matching folder path wins, and the first workspace folder (root) catches the rest.

## Gotchas

- Folder rows must use an image `iconPath` (the SVGs in `media/`), not a `ThemeIcon`. With a ThemeIcon parent, VS Code's tree pulls leaf rows left into the twistie column and the indent breaks.
- VS Code has no event for terminal renames. Commands that rename refresh after a short delay.
- Unread is computed as: Claude state is `needs` and its timestamp is newer than when the terminal was last viewed. The active terminal in a focused window is marked viewed on every refresh.
- The extension must behave the same when the hook is not installed. Never require the state directory to exist.
- Keep the view id `terminalGroups.tree`. The one-time move into the Terminal panel is keyed to it.

## Conventions

- Keep it small. No new dependencies without a strong reason.
- Commits: `prefix(scope): lowercase imperative summary`, bullet body, no co-author trailers.
