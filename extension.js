const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classify, applyOrder, reorder, claudeEntryFor, isUnread } = require('./lib');

const VIEW_ID = 'terminalGroups.tree';
const MIME = 'application/vnd.code.tree.terminalgroups.tree';
const DECO_SCHEME = 'terminal-groups';
// Bright yellow: the most visible built-in color across dark and light themes.
const ATTENTION_COLOR = 'terminal.ansiBrightYellow';
// Written by the optional hooks/claude-state.sh Claude Code hook. Absent dir = feature off.
const CLAUDE_STATE_DIR = path.join(os.homedir(), '.cache', 'terminal-groups', 'claude');
const CLAUDE_POLL_MS = 2000;

const ORDER_KEY = 'terminalGroups.order'; // { [folder]: terminal names }
const FOLDER_ORDER_KEY = 'terminalGroups.folderOrder'; // folder names, for manual sort
const SORT_KEY = 'terminalGroups.folderSort'; // 'workspace' | 'alpha' | 'manual'
const DOCKED_KEY = 'terminalGroups.docked';

/** @typedef {{type: 'group', id: string, name: string, path: string, unread: number, children: TermNode[]}} GroupNode */
/** @typedef {{type: 'terminal', id: string, terminal: vscode.Terminal, label: string, parent: GroupNode}} TermNode */

function activate(context) {
  const state = context.workspaceState;

  // ---- Identity -----------------------------------------------------------

  const ids = new WeakMap();
  let nextId = 1;
  const termId = (t) => {
    if (!ids.has(t)) ids.set(t, `t${nextId++}`);
    return ids.get(t);
  };

  /** Shell PIDs, filled asynchronously as terminals open. */
  const termPids = new Map();
  /** Task exit codes keyed by terminal; cleared when the task restarts. */
  const exitCodes = new WeakMap();

  const workspaceFolders = () =>
    (vscode.workspace.workspaceFolders || []).map((f) => ({ name: f.name, path: f.uri.fsPath }));

  const cwdOf = (t) => {
    const si = t.shellIntegration && t.shellIntegration.cwd;
    if (si) return si.fsPath;
    const c = t.creationOptions && t.creationOptions.cwd;
    if (!c) return undefined;
    return typeof c === 'string' ? c : c.fsPath;
  };

  // ---- Task configs (icons, colors, grouping) -----------------------------

  /** Keyed by the terminal title VS Code gives task terminals: "label (folder)", or "ws:label" for workspace-file tasks. */
  let taskInfo = new Map();

  function loadTaskInfo() {
    const folders = workspaceFolders();
    taskInfo = new Map();
    for (const wf of vscode.workspace.workspaceFolders || []) {
      const fromConfig = vscode.workspace.getConfiguration('tasks', wf.uri).inspect('tasks')?.workspaceFolderValue;
      for (const t of readFolderTasks(fromConfig, wf)) {
        taskInfo.set(`${t.label} (${wf.name})`, { label: t.label, icon: t.icon, folder: folders.find((f) => f.name === wf.name) });
      }
    }
    // Workspace-file tasks are grouped by the ${workspaceFolder:X} in their cwd.
    for (const t of readWorkspaceTasks(vscode.workspace.getConfiguration('tasks').inspect('tasks')?.workspaceValue)) {
      const m = /\$\{workspaceFolder:([^}]+)\}/.exec((t.options && t.options.cwd) || '');
      taskInfo.set(`ws:${t.label}`, { label: t.label, icon: t.icon, folder: m ? folders.find((f) => f.name === m[1]) : undefined });
    }
  }

  function infoFor(t) {
    if (taskInfo.has(t.name)) return taskInfo.get(t.name);
    // Workspace-file tasks are titled "label (<workspace name>)", and the name may itself contain parens.
    for (const [key, info] of taskInfo) {
      if (key.startsWith('ws:') && t.name.startsWith(`${info.label} (`)) return info;
    }
    return undefined;
  }

  // ---- Claude state (optional hook) ---------------------------------------

  let claudeStates = [];
  let claudeRaw = '';

  function pollClaudeStates() {
    let files = [];
    try {
      files = fs.readdirSync(CLAUDE_STATE_DIR).filter((f) => f.endsWith('.json'));
    } catch {
      // No hook installed: nothing to show.
    }
    const states = [];
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(CLAUDE_STATE_DIR, f), 'utf8'));
        process.kill(s.claude_pid, 0); // throws if that Claude process is gone
        states.push(s);
      } catch {
        // unreadable or stale
      }
    }
    const raw = JSON.stringify(states);
    if (raw !== claudeRaw) {
      claudeRaw = raw;
      claudeStates = states;
      refresh();
    }
  }

  const entryFor = (t) => claudeEntryFor(claudeStates, termPids.get(t));
  const stateFor = (t) => (entryFor(t) || {}).state;
  /** Claude session: the hook reported it, or its name/title says so (task label or Claude's ✳ title). */
  const isClaude = (t) => !!entryFor(t) || /claude/i.test(t.name) || t.name.startsWith('✳');

  /** When each terminal was last viewed; a 'needs' state newer than this is unread. */
  const seenMs = new Map();
  const unread = (t) => isUnread(entryFor(t), seenMs.get(t));

  /** Viewing a terminal (active while the window has focus) marks it read. */
  function markActiveSeen() {
    const t = vscode.window.activeTerminal;
    if (t && vscode.window.state.focused && unread(t)) {
      seenMs.set(t, Date.now());
      return true;
    }
    return false;
  }

  // ---- Filters ------------------------------------------------------------

  const FILTERS = {
    all: { label: 'All terminals' },
    needs: { label: 'Needs you', keep: (t) => unread(t), empty: 'Nothing needs you right now.' },
    claude: { label: 'Claude sessions', keep: (t) => isClaude(t), empty: 'No Claude sessions open.' },
    other: { label: 'Other terminals', keep: (t) => !isClaude(t), empty: 'No other terminals open.' },
  };
  let filter = 'all';

  // ---- Model --------------------------------------------------------------

  /** @type {GroupNode[]} groups as shown (after filter) */
  let groups = [];
  /** @type {TermNode[]} every terminal node, ignoring the filter */
  let allNodes = [];
  /** @type {Map<vscode.Terminal, TermNode>} */
  let byTerminal = new Map();
  /** @type {Map<string, TermNode>} */
  let byId = new Map();
  let totalUnread = 0;

  function build() {
    const folders = workspaceFolders();
    const map = new Map();
    for (const t of vscode.window.terminals) {
      if (!termPids.has(t)) {
        termPids.set(t, undefined);
        Promise.resolve(t.processId).then((pid) => {
          termPids.set(t, pid);
          if (pid && claudeStates.length) refresh();
        });
      }
      const info = infoFor(t);
      const { folder, label } = info && info.folder ? { folder: info.folder, label: info.label } : classify(t.name, cwdOf(t), folders);
      const name = folder ? folder.name : 'Terminals';
      if (!map.has(name)) map.set(name, { type: 'group', id: `g:${name}`, name, path: folder ? folder.path : '', unread: 0, children: [] });
      const g = map.get(name);
      g.children.push({ type: 'terminal', id: termId(t), terminal: t, label, parent: g });
    }

    // Folder order: workspace order by default, then the chosen sort; root always pinned on top.
    const rank = new Map(folders.map((f, i) => [f.name, i]));
    groups = [...map.values()].sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9));
    const sort = state.get(SORT_KEY, 'workspace');
    if (sort === 'alpha') groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (sort === 'manual') groups = applyOrder(groups, (g) => g.name, state.get(FOLDER_ORDER_KEY));
    const root = folders[0] ? groups.findIndex((g) => g.name === folders[0].name) : -1;
    if (root > 0) groups.unshift(...groups.splice(root, 1));

    const order = state.get(ORDER_KEY, {});
    byTerminal = new Map();
    byId = new Map();
    for (const g of groups) {
      g.children = applyOrder(g.children, (n) => n.terminal.name, order[g.name]);
      g.unread = g.children.filter((n) => unread(n.terminal)).length;
      for (const n of g.children) {
        byTerminal.set(n.terminal, n);
        byId.set(n.id, n);
      }
    }
    allNodes = groups.flatMap((g) => g.children);
    totalUnread = groups.reduce((sum, g) => sum + g.unread, 0);

    const keep = FILTERS[filter].keep;
    if (keep) {
      // The terminal you're on always stays, so clicking a row never makes it vanish.
      const active = vscode.window.activeTerminal;
      groups = groups
        .map((g) => ({ ...g, children: g.children.filter((n) => keep(n.terminal) || n.terminal === active) }))
        .filter((g) => g.children.length);
      for (const g of groups) for (const n of g.children) n.parent = g;
    }
  }

  // ---- Rendering ----------------------------------------------------------

  function iconFor(t) {
    if (unread(t)) return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor(ATTENTION_COLOR));
    if (stateFor(t) === 'working') return new vscode.ThemeIcon('loading~spin');
    const code = exitCodes.get(t);
    if (code !== undefined) {
      return code === 0
        ? new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'))
        : new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    }
    const info = infoFor(t);
    if (info && info.icon && info.icon.id) {
      return new vscode.ThemeIcon(info.icon.id, info.icon.color ? new vscode.ThemeColor(info.icon.color) : undefined);
    }
    const opts = t.creationOptions || {};
    if (opts.iconPath instanceof vscode.ThemeIcon) return new vscode.ThemeIcon(opts.iconPath.id, opts.color);
    return opts.iconPath || new vscode.ThemeIcon('terminal', opts.color);
  }

  function descriptionFor(t) {
    if (stateFor(t) === 'working') return 'working';
    if (unread(t)) return 'needs you';
    const code = exitCodes.get(t);
    if (code !== undefined) return code === 0 ? 'done' : `exit ${code}`;
    if (t.exitStatus) return `exit ${t.exitStatus.code ?? ''}`.trim();
    return undefined;
  }

  // Decorations color the label and add a marker; the resourceUri on each row is just a key.
  const decoUri = (id) => vscode.Uri.from({ scheme: DECO_SCHEME, path: `/${id}` });

  /** @type {vscode.TreeDataProvider<GroupNode | TermNode>} */
  const provider = {
    onDidChangeTreeData: undefined, // set below
    getChildren: (node) => (node ? (node.type === 'group' ? node.children : []) : groups),
    getParent: (node) => (node.type === 'terminal' ? node.parent : undefined),
    getTreeItem(node) {
      if (node.type === 'group') {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.contextValue = 'group';
        item.resourceUri = decoUri(node.id);
        // An image icon (not a ThemeIcon) stops the tree from pulling child rows left into the
        // twistie column, so terminals line up under the folder icon instead of its arrow.
        item.iconPath = {
          light: vscode.Uri.joinPath(context.extensionUri, 'media', 'folder-light.svg'),
          dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'folder-dark.svg'),
        };
        const count = node.children.length;
        item.description = node.unread ? `${count} · ${node.unread} need${node.unread === 1 ? 's' : ''} you` : `${count}`;
        return item;
      }
      const t = node.terminal;
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.contextValue = 'terminal';
      item.resourceUri = decoUri(node.id);
      item.iconPath = iconFor(t);
      item.description = descriptionFor(t);
      item.command = { command: 'terminalGroups.show', title: 'Show', arguments: [node] };
      return item;
    },
    async resolveTreeItem(item, node) {
      if (node.type !== 'terminal') return item;
      const t = node.terminal;
      const pid = await t.processId;
      const cwd = cwdOf(t);
      item.tooltip = [t.name, `Folder: ${node.parent.name}`, cwd && `Cwd: ${cwd}`, pid && `PID: ${pid}`].filter(Boolean).join('\n');
      return item;
    },
  };

  const treeEmitter = new vscode.EventEmitter();
  const decoEmitter = new vscode.EventEmitter();
  provider.onDidChangeTreeData = treeEmitter.event;

  const decorations = {
    onDidChangeFileDecorations: decoEmitter.event,
    provideFileDecoration(uri) {
      if (uri.scheme !== DECO_SCHEME) return undefined;
      const id = uri.path.slice(1);
      const color = new vscode.ThemeColor(ATTENTION_COLOR);
      if (id.startsWith('g:')) {
        const g = groups.find((x) => x.id === id);
        return g && g.unread ? { color, badge: String(Math.min(g.unread, 99)), tooltip: 'Claude needs you' } : undefined;
      }
      const node = byId.get(id);
      return node && unread(node.terminal) ? { color, badge: '●', tooltip: 'Claude needs you' } : undefined;
    },
  };

  // ---- Drag and drop ------------------------------------------------------

  /** Where to insert when dropping on `to`: after it when dragging down, before it when dragging up. */
  const beforeKeyFor = (list, from, to) => (from < to ? list[to + 1] : list[to]);

  /** @type {vscode.TreeDragAndDropController<GroupNode | TermNode>} */
  const dnd = {
    dragMimeTypes: [MIME],
    dropMimeTypes: [MIME],
    handleDrag(source, dataTransfer) {
      // Folders and terminals don't mix in one drag; folders win.
      const folderIds = source.filter((n) => n.type === 'group').map((n) => n.id);
      const dragged = folderIds.length ? folderIds : source.filter((n) => n.type === 'terminal').map((n) => n.id);
      if (dragged.length) dataTransfer.set(MIME, new vscode.DataTransferItem(dragged));
    },
    async handleDrop(target, dataTransfer) {
      const item = dataTransfer.get(MIME);
      if (!item || !target || filter !== 'all') return; // order is only meaningful on the full list
      const group = target.type === 'group' ? target : target.parent;

      if (item.value.some((id) => id.startsWith('g:'))) {
        // Folder drag: reorder folders and switch to manual sort.
        const names = groups.map((g) => g.name);
        const moving = item.value.map((id) => id.slice(2)).filter((n) => n !== group.name);
        if (!moving.length) return;
        const beforeKey = beforeKeyFor(names, names.indexOf(moving[0]), names.indexOf(group.name));
        await state.update(FOLDER_ORDER_KEY, reorder(names, moving, beforeKey));
        await state.update(SORT_KEY, 'manual');
        refresh();
        return;
      }

      const moving = item.value.map((id) => byId.get(id)).filter((n) => n && n.parent === group);
      if (!moving.length) return;
      const names = group.children.map((n) => n.terminal.name);
      const beforeKey =
        target.type === 'terminal' && !moving.includes(target)
          ? beforeKeyFor(names, group.children.indexOf(moving[0]), group.children.indexOf(target))
          : undefined;
      const order = { ...state.get(ORDER_KEY, {}) };
      order[group.name] = reorder(
        names,
        moving.map((n) => n.terminal.name),
        beforeKey,
      );
      await state.update(ORDER_KEY, order);
      refresh();
    },
  };

  // ---- View ---------------------------------------------------------------

  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    dragAndDropController: dnd,
    canSelectMany: true,
    showCollapseAll: true,
  });

  function revealActive() {
    const t = vscode.window.activeTerminal;
    const node = t && byTerminal.get(t);
    if (node && view.visible) view.reveal(node, { select: true, focus: false }).then(undefined, () => {});
  }

  /** Unread count per folder at the last refresh; a folder expands when its count goes up. */
  const lastUnread = new Map();
  let pending;

  function refresh() {
    clearTimeout(pending);
    pending = setTimeout(() => {
      markActiveSeen(); // the terminal you're looking at is never unread
      build();
      treeEmitter.fire();
      decoEmitter.fire(undefined);

      for (const g of groups) {
        if (g.unread > (lastUnread.get(g.name) || 0)) view.reveal(g, { expand: true, select: false, focus: false }).then(undefined, () => {});
        lastUnread.set(g.name, g.unread);
      }

      const f = FILTERS[filter];
      const shown = groups.reduce((sum, g) => sum + g.children.filter((n) => !f.keep || f.keep(n.terminal)).length, 0);
      view.message = f.keep && !shown ? f.empty : undefined;
      view.badge = totalUnread
        ? { value: totalUnread, tooltip: `${totalUnread} Claude session${totalUnread === 1 ? ' needs' : 's need'} you` }
        : undefined;
      setTimeout(revealActive, 50);
    }, 50);
  }

  // ---- Commands -----------------------------------------------------------

  /** Make `node`'s terminal active, then run a built-in command that acts on the active terminal. */
  async function onTerminal(node, command) {
    if (!node || node.type !== 'terminal') return;
    node.terminal.show(true);
    await new Promise((r) => setTimeout(r, 50));
    await vscode.commands.executeCommand(command);
    // No rename event exists, so refresh once now and once after the input box likely closed.
    refresh();
    setTimeout(refresh, 500);
  }

  async function pickFilter() {
    const items = Object.entries(FILTERS).map(([key, f]) => ({ key, label: f.label, description: key === filter ? 'current' : '' }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Show which terminals?' });
    if (!pick) return;
    filter = pick.key;
    vscode.commands.executeCommand('setContext', 'terminalGroups.filtered', filter !== 'all');
    view.description = filter === 'all' ? undefined : FILTERS[filter].label;
    refresh();
  }

  async function sortFolders() {
    const current = state.get(SORT_KEY, 'workspace');
    const items = [
      { key: 'workspace', label: 'Workspace order', detail: 'Order of folders in the .code-workspace file' },
      { key: 'alpha', label: 'Alphabetical' },
      { key: 'manual', label: 'Manual', detail: 'Drag folder rows to reorder' },
    ].map((i) => ({ ...i, description: i.key === current ? 'current' : '' }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Sort folders' });
    if (!pick) return;
    await state.update(SORT_KEY, pick.key);
    refresh();
  }

  /** Fuzzy search over every terminal, regardless of the active filter. */
  async function findTerminal() {
    const items = allNodes.map((n) => {
      const icon = iconFor(n.terminal);
      const status = unread(n.terminal) ? ' · needs you' : stateFor(n.terminal) === 'working' ? ' · working' : '';
      return {
        label: `${icon instanceof vscode.ThemeIcon ? `$(${icon.id}) ` : ''}${n.label}`,
        description: n.parent.name + status,
        terminal: n.terminal,
      };
    });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Find terminal', matchOnDescription: true });
    if (pick) pick.terminal.show();
  }

  function taskTerminals(task) {
    const scope = task.scope && typeof task.scope === 'object' ? task.scope.name : undefined;
    const exact = scope ? vscode.window.terminals.filter((t) => t.name === `${task.name} (${scope})`) : [];
    if (exact.length) return exact;
    return vscode.window.terminals.filter((t) => t.name === task.name || t.name.startsWith(`${task.name} (`));
  }

  const poll = setInterval(pollClaudeStates, CLAUDE_POLL_MS);
  const cmd = vscode.commands.registerCommand;

  context.subscriptions.push(
    view,
    treeEmitter,
    decoEmitter,
    { dispose: () => clearInterval(poll) },
    vscode.window.registerFileDecorationProvider(decorations),

    cmd('terminalGroups.show', (node) => node && node.terminal.show()),
    cmd('terminalGroups.kill', (node, selected) => {
      for (const n of selected && selected.length ? selected : [node]) if (n && n.type === 'terminal') n.terminal.dispose();
    }),
    cmd('terminalGroups.rename', (n) => onTerminal(n, 'workbench.action.terminal.rename')),
    cmd('terminalGroups.changeColor', (n) => onTerminal(n, 'workbench.action.terminal.changeColor')),
    cmd('terminalGroups.changeIcon', (n) => onTerminal(n, 'workbench.action.terminal.changeIcon')),
    cmd('terminalGroups.moveToEditor', (n) => onTerminal(n, 'workbench.action.terminal.moveToEditor')),
    cmd('terminalGroups.split', (n) => onTerminal(n, 'workbench.action.terminal.split')),
    cmd('terminalGroups.newInFolder', (group) => {
      if (group && group.type === 'group') vscode.window.createTerminal({ cwd: group.path || undefined }).show();
    }),
    cmd('terminalGroups.newInAnyFolder', async () => {
      const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'New terminal in which folder?' });
      if (folder) vscode.window.createTerminal({ cwd: folder.uri.fsPath }).show();
    }),
    cmd('terminalGroups.expandAll', async () => {
      for (const g of groups) await view.reveal(g, { expand: true, select: false, focus: false }).then(undefined, () => {});
    }),
    cmd('terminalGroups.sortFolders', sortFolders),
    cmd('terminalGroups.filter', pickFilter),
    cmd('terminalGroups.filterActive', pickFilter), // same command, filled icon while a filter is on
    cmd('terminalGroups.find', findTerminal),

    vscode.window.onDidOpenTerminal(refresh),
    vscode.window.onDidCloseTerminal(refresh),
    vscode.window.onDidChangeTerminalState(refresh),
    vscode.window.onDidChangeTerminalShellIntegration(refresh),
    vscode.window.onDidChangeActiveTerminal(() => (markActiveSeen() || filter !== 'all' ? refresh() : revealActive())),
    vscode.window.onDidChangeWindowState((s) => s.focused && markActiveSeen() && refresh()),
    view.onDidChangeVisibility(() => view.visible && revealActive()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => (loadTaskInfo(), refresh())),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('tasks') && (loadTaskInfo(), refresh())),
    vscode.tasks.onDidStartTaskProcess((e) => {
      for (const t of taskTerminals(e.execution.task)) exitCodes.delete(t);
      refresh();
    }),
    vscode.tasks.onDidEndTaskProcess((e) => {
      for (const t of taskTerminals(e.execution.task)) exitCodes.set(t, e.exitCode ?? 0);
      refresh();
    }),
  );

  loadTaskInfo();
  build();
  pollClaudeStates();
  dockBesideTerminal(context);
}

/** Tasks from config; falls back to the folder's .vscode/tasks.json if config returns nothing. */
function readFolderTasks(fromConfig, wf) {
  if (Array.isArray(fromConfig) && fromConfig.length) return fromConfig;
  return readJson(path.join(wf.uri.fsPath, '.vscode', 'tasks.json'))?.tasks || [];
}

/** Workspace-file tasks from config; falls back to the .code-workspace file's "tasks" block. */
function readWorkspaceTasks(fromConfig) {
  if (Array.isArray(fromConfig) && fromConfig.length) return fromConfig;
  const file = vscode.workspace.workspaceFile;
  if (!file || file.scheme !== 'file') return [];
  return readJson(file.fsPath)?.tasks?.tasks || [];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Move the view into the Terminal panel once, so it sits where the built-in tab list was. */
async function dockBesideTerminal(context) {
  if (context.globalState.get(DOCKED_KEY)) return;
  try {
    await vscode.commands.executeCommand('vscode.moveViews', { viewIds: [VIEW_ID], destinationId: 'terminal' });
    await context.globalState.update(DOCKED_KEY, true);
  } catch (err) {
    console.error('terminal-groups: could not dock beside terminal', err);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
