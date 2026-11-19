const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classify, applyOrder, reorder, claudeEntryFor, isUnread } = require('./lib');

const VIEW_ID = 'terminalGroups.tree';
// Written by the optional hooks/claude-state.sh Claude Code hook. Absent dir = feature off.
const CLAUDE_STATE_DIR = path.join(os.homedir(), '.cache', 'terminal-groups', 'claude');
const DECO_SCHEME = 'terminal-groups';
// Bright yellow: the most visible built-in color across dark and light themes.
const ATTENTION_COLOR = 'terminal.ansiBrightYellow';
const MIME ='application/vnd.code.tree.terminalgroups.tree';
const ORDER_KEY = 'terminalGroups.order';
const FOLDER_ORDER_KEY = 'terminalGroups.folderOrder';
const SORT_KEY = 'terminalGroups.folderSort'; // 'workspace' | 'alpha' | 'manual'

/** @typedef {{type: 'group', id: string, name: string, path: string, children: TermNode[]}} GroupNode */
/** @typedef {{type: 'terminal', id: string, terminal: vscode.Terminal, label: string, parent: GroupNode}} TermNode */

function activate(context) {
  const ids = new WeakMap();
  let nextId = 1;
  const termId = (t) => {
    if (!ids.has(t)) ids.set(t, `t${nextId++}`);
    return ids.get(t);
  };

  /** Task exit codes keyed by terminal; cleared when the task restarts. */
  const exitCodes = new WeakMap();

  /** @type {GroupNode[]} */
  let groups = [];
  /** @type {Map<vscode.Terminal, TermNode>} */
  let byTerminal = new Map();
  /** @type {Map<string, TermNode>} */
  let byId = new Map();

  const emitter = new vscode.EventEmitter();
  const decoEmitter = new vscode.EventEmitter();

  const folders = () =>
    (vscode.workspace.workspaceFolders || []).map((f) => ({ name: f.name, path: f.uri.fsPath }));

  const cwdOf = (t) => {
    const si = t.shellIntegration && t.shellIntegration.cwd;
    if (si) return si.fsPath;
    const c = t.creationOptions && t.creationOptions.cwd;
    if (!c) return undefined;
    return typeof c === 'string' ? c : c.fsPath;
  };

  /** Task configs keyed by the terminal title VS Code gives them: "label (folder)". */
  let taskInfo = new Map();
  function loadTaskInfo() {
    const fs = folders();
    taskInfo = new Map();
    for (const wf of vscode.workspace.workspaceFolders || []) {
      for (const t of readTasks(vscode.workspace.getConfiguration('tasks', wf.uri).inspect('tasks')?.workspaceFolderValue, wf)) {
        taskInfo.set(`${t.label} (${wf.name})`, { label: t.label, icon: t.icon, folder: fs.find((f) => f.name === wf.name) });
      }
    }
    // Workspace-file tasks are titled "label (<workspace name>)"; group them by their cwd's ${workspaceFolder:X}.
    for (const t of readWorkspaceTasks(vscode.workspace.getConfiguration('tasks').inspect('tasks')?.workspaceValue)) {
      const m = /\$\{workspaceFolder:([^}]+)\}/.exec((t.options && t.options.cwd) || '');
      taskInfo.set(`ws:${t.label}`, { label: t.label, icon: t.icon, folder: m ? fs.find((f) => f.name === m[1]) : undefined });
    }
  }

  function infoFor(t) {
    if (taskInfo.has(t.name)) return taskInfo.get(t.name);
    // Workspace-file tasks: "label (<workspace name>)", where the name may itself contain parens.
    for (const [key, info] of taskInfo) {
      if (key.startsWith('ws:') && t.name.startsWith(`${info.label} (`)) return info;
    }
    return undefined;
  }

  /** Shell PIDs, filled asynchronously; Claude states from the optional hook. */
  const termPids = new Map();
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

  /** When each terminal was last viewed; a 'needs' state newer than this is unread. */
  const seenMs = new Map();
  const unread = (t) => isUnread(entryFor(t), seenMs.get(t));
  /** Viewing a terminal (it's active while the window has focus) marks it read. */
  function markActiveSeen() {
    const t = vscode.window.activeTerminal;
    if (t && vscode.window.state.focused && unread(t)) {
      seenMs.set(t, Date.now());
      return true;
    }
    return false;
  }

  function build() {
    const fs = folders();
    const order = context.workspaceState.get(ORDER_KEY, {});
    for (const t of vscode.window.terminals) {
      if (!termPids.has(t)) {
        termPids.set(t, undefined);
        Promise.resolve(t.processId).then((pid) => {
          termPids.set(t, pid);
          if (pid && claudeStates.length) refresh();
        });
      }
    }
    const map = new Map();
    for (const t of vscode.window.terminals) {
      const info = infoFor(t);
      const { folder, label } = info && info.folder ? { folder: info.folder, label: info.label } : classify(t.name, cwdOf(t), fs);
      const name = folder ? folder.name : 'Terminals';
      if (!map.has(name)) {
        map.set(name, { type: 'group', id: `g:${name}`, name, path: folder ? folder.path : '', children: [] });
      }
      const g = map.get(name);
      g.children.push({ type: 'terminal', id: termId(t), terminal: t, label, parent: g });
    }
    const folderRank = new Map(fs.map((f, i) => [f.name, i]));
    groups = [...map.values()].sort((a, b) => (folderRank.get(a.name) ?? 1e9) - (folderRank.get(b.name) ?? 1e9));
    const sort = context.workspaceState.get(SORT_KEY, 'workspace');
    if (sort === 'alpha') groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (sort === 'manual') groups = applyOrder(groups, (g) => g.name, context.workspaceState.get(FOLDER_ORDER_KEY));
    // The workspace root (first folder) is the catch-all for ad-hoc terminals: always pinned on top.
    const root = fs[0] && groups.findIndex((g) => g.name === fs[0].name);
    if (root > 0) groups.unshift(...groups.splice(root, 1));
    byTerminal = new Map();
    byId = new Map();
    for (const g of groups) {
      g.children = applyOrder(g.children, (n) => n.terminal.name, order[g.name]);
      for (const n of g.children) {
        byTerminal.set(n.terminal, n);
        byId.set(n.id, n);
      }
    }
    for (const g of groups) g.unread = g.children.filter((n) => unread(n.terminal)).length;
    totalUnread = groups.reduce((sum, g) => sum + g.unread, 0);
    const keep = FILTERS[filter].keep;
    if (keep) {
      // The terminal you're on always stays, so clicking a row never makes it vanish.
      const active = vscode.window.activeTerminal;
      for (const g of groups) g.children = g.children.filter((n) => keep(n.terminal) || n.terminal === active);
      groups = groups.filter((g) => g.children.length);
    }
  }

  /** Claude session: hook reported it, or its name/title says so (task label or Claude's ✳ title). */
  const isClaude = (t) => !!entryFor(t) || /claude/i.test(t.name) || t.name.startsWith('✳');

  const FILTERS = {
    all: { label: 'All terminals' },
    needs: { label: 'Needs you', keep: (t) => unread(t), empty: 'Nothing needs you right now.' },
    claude: { label: 'Claude sessions', keep: (t) => isClaude(t), empty: 'No Claude sessions open.' },
    other: { label: 'Other terminals', keep: (t) => !isClaude(t), empty: 'No other terminals open.' },
  };
  let filter = 'all';
  let totalUnread = 0;

  function iconFor(t) {
    const claude = stateFor(t);
    if (unread(t)) return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor(ATTENTION_COLOR));
    if (claude === 'working') return new vscode.ThemeIcon('loading~spin');
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
    const color = opts.color;
    if (opts.iconPath instanceof vscode.ThemeIcon) return new vscode.ThemeIcon(opts.iconPath.id, color);
    if (opts.iconPath) return opts.iconPath;
    return new vscode.ThemeIcon('terminal', color);
  }

  /** @type {vscode.TreeDataProvider<GroupNode | TermNode>} */
  const provider = {
    onDidChangeTreeData: emitter.event,
    getChildren: (node) => (node ? (node.type === 'group' ? node.children : []) : groups),
    getParent: (node) => (node.type === 'terminal' ? node.parent : undefined),
    getTreeItem(node) {
      if (node.type === 'group') {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.contextValue = 'group';
        item.resourceUri = vscode.Uri.from({ scheme: DECO_SCHEME, path: `/${node.id}` });
        // An image icon (not a ThemeIcon) stops the tree from pulling child rows left into the
        // twistie column, so terminals line up under the folder icon instead of its arrow.
        item.iconPath = {
          light: vscode.Uri.joinPath(context.extensionUri, 'media', 'folder-light.svg'),
          dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'folder-dark.svg'),
        };
        item.description = `${node.children.length}` + (node.unread ? ` · ${node.unread} need${node.unread === 1 ? 's' : ''} you` : '');
        return item;
      }
      const t = node.terminal;
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.contextValue = 'terminal';
      // Lets the decoration provider color the label orange while unread.
      item.resourceUri = vscode.Uri.from({ scheme: DECO_SCHEME, path: `/${node.id}` });
      item.iconPath = iconFor(t);
      const code = exitCodes.get(t);
      if (code !== undefined) item.description = code === 0 ? 'done' : `exit ${code}`;
      else if (t.exitStatus) item.description = `exit ${t.exitStatus.code ?? ''}`.trim();
      if (stateFor(t) === 'working') item.description = 'working';
      else if (unread(t)) item.description = 'needs you';
      item.command = { command: 'terminalGroups.show', title: 'Show', arguments: [node] };
      return item;
    },
    async resolveTreeItem(item, node) {
      if (node.type !== 'terminal') return item;
      const t = node.terminal;
      const pid = await t.processId;
      const lines = [t.name, `Folder: ${node.parent.name}`];
      const cwd = cwdOf(t);
      if (cwd) lines.push(`Cwd: ${cwd}`);
      if (pid) lines.push(`PID: ${pid}`);
      item.tooltip = lines.join('\n');
      return item;
    },
  };

  /** @type {vscode.TreeDragAndDropController<GroupNode | TermNode>} */
  const dnd = {
    dragMimeTypes: [MIME],
    dropMimeTypes: [MIME],
    handleDrag(source, dataTransfer) {
      // Folders and terminals don't mix in one drag; folders win.
      const folderIds = source.filter((n) => n.type === 'group').map((n) => n.id);
      const ids = folderIds.length ? folderIds : source.filter((n) => n.type === 'terminal').map((n) => n.id);
      if (ids.length) dataTransfer.set(MIME, new vscode.DataTransferItem(ids));
    },
    async handleDrop(target, dataTransfer) {
      const item = dataTransfer.get(MIME);
      if (!item || !target) return;
      const group = target.type === 'group' ? target : target.parent;
      if (filter !== 'all') return; // order is only meaningful on the full list
      if (item.value.some((id) => id.startsWith('g:'))) {
        // Folder drag: reorder folders and switch to manual sort.
        const names = groups.map((g) => g.name);
        const movingNames = item.value.map((id) => id.slice(2)).filter((n) => n !== group.name || item.value.length > 1);
        if (!movingNames.length) return;
        const from = names.indexOf(movingNames[0]);
        const to = names.indexOf(group.name);
        const beforeKey = movingNames.includes(group.name) ? undefined : from < to ? names[to + 1] : group.name;
        await context.workspaceState.update(FOLDER_ORDER_KEY, reorder(names, movingNames, beforeKey));
        await context.workspaceState.update(SORT_KEY, 'manual');
        refresh();
        return;
      }
      const moving = item.value.map((id) => byId.get(id)).filter((n) => n && n.parent === group);
      if (!moving.length) return;
      const current = group.children.map((n) => n.terminal.name);
      const movingNames = moving.map((n) => n.terminal.name);
      let beforeKey;
      if (target.type === 'terminal' && !moving.includes(target)) {
        const from = group.children.indexOf(moving[0]);
        const to = group.children.indexOf(target);
        // Dragging down drops after the target, dragging up drops before it.
        beforeKey = from < to ? (group.children[to + 1] || {}).terminal?.name : target.terminal.name;
      }
      const order = { ...context.workspaceState.get(ORDER_KEY, {}) };
      order[group.name] = reorder(current, movingNames, beforeKey);
      await context.workspaceState.update(ORDER_KEY, order);
      refresh();
    },
  };

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

  const lastUnread = new Map();
  async function pickFilter() {
    const items = Object.entries(FILTERS).map(([key, f]) => ({ key, label: f.label, description: key === filter ? 'current' : '' }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Show which terminals?' });
    if (!pick) return;
    filter = pick.key;
    vscode.commands.executeCommand('setContext', 'terminalGroups.filtered', filter !== 'all');
    view.description = filter === 'all' ? undefined : FILTERS[filter].label;
    refresh();
  }

  let pending;
  function refresh() {
    clearTimeout(pending);
    pending = setTimeout(() => {
      markActiveSeen(); // the terminal you're looking at is never unread
      build();
      emitter.fire();
      decoEmitter.fire(undefined);
      const waiting = totalUnread;
      // Expand a project when a session in it newly needs you.
      for (const g of groups) {
        if (g.unread > (lastUnread.get(g.name) || 0)) view.reveal(g, { expand: true, select: false, focus: false }).then(undefined, () => {});
        lastUnread.set(g.name, g.unread);
      }
      const f = FILTERS[filter];
      const shown = groups.reduce((sum, g) => sum + g.children.filter((n) => !f.keep || f.keep(n.terminal)).length, 0);
      view.message = f.keep && !shown ? f.empty : undefined;
      view.badge =waiting ? { value: waiting, tooltip: `${waiting} Claude session${waiting === 1 ? ' needs' : 's need'} you` } : undefined;
      setTimeout(revealActive, 50);
    }, 50);
  }

  /** Make `node`'s terminal active, then run a built-in command that acts on the active terminal. */
  async function onTerminal(node, command) {
    if (!node || node.type !== 'terminal') return;
    node.terminal.show(true);
    await new Promise((r) => setTimeout(r, 50));
    await vscode.commands.executeCommand(command);
    refresh();
    setTimeout(refresh, 500);
  }

  function taskTerminals(task) {
    const prefix = `${task.name} (`;
    const scope = task.scope && typeof task.scope === 'object' ? task.scope.name : undefined;
    const exact = scope && vscode.window.terminals.filter((t) => t.name === `${task.name} (${scope})`);
    if (exact && exact.length) return exact;
    return vscode.window.terminals.filter((t) => t.name === task.name || t.name.startsWith(prefix));
  }

  context.subscriptions.push(
    view,
    emitter,
    vscode.commands.registerCommand('terminalGroups.show', (node) => node && node.terminal.show()),
    vscode.commands.registerCommand('terminalGroups.kill', (node, selected) => {
      const nodes = selected && selected.length ? selected : [node];
      for (const n of nodes) if (n && n.type === 'terminal') n.terminal.dispose();
    }),
    vscode.commands.registerCommand('terminalGroups.rename', (n) => onTerminal(n, 'workbench.action.terminal.rename')),
    vscode.commands.registerCommand('terminalGroups.changeColor', (n) => onTerminal(n, 'workbench.action.terminal.changeColor')),
    vscode.commands.registerCommand('terminalGroups.changeIcon', (n) => onTerminal(n, 'workbench.action.terminal.changeIcon')),
    vscode.commands.registerCommand('terminalGroups.moveToEditor', (n) => onTerminal(n, 'workbench.action.terminal.moveToEditor')),
    vscode.commands.registerCommand('terminalGroups.split', (n) => onTerminal(n, 'workbench.action.terminal.split')),
    vscode.commands.registerCommand('terminalGroups.newInFolder', (group) => {
      if (!group || group.type !== 'group') return;
      vscode.window.createTerminal({ cwd: group.path || undefined }).show();
    }),
    vscode.commands.registerCommand('terminalGroups.sortFolders', async () => {
      const current = context.workspaceState.get(SORT_KEY, 'workspace');
      const items = [
        { key: 'workspace', label: 'Workspace order', detail: 'Order of folders in the .code-workspace file' },
        { key: 'alpha', label: 'Alphabetical' },
        { key: 'manual', label: 'Manual', detail: 'Drag folder rows to reorder' },
      ].map((i) => ({ ...i, description: i.key === current ? 'current' : '' }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Sort folders' });
      if (!pick) return;
      await context.workspaceState.update(SORT_KEY, pick.key);
      refresh();
    }),
    vscode.commands.registerCommand('terminalGroups.filter', pickFilter),
    vscode.commands.registerCommand('terminalGroups.filterActive', pickFilter),
    vscode.commands.registerCommand('terminalGroups.find', async () => {
      const items = groups.flatMap((g) =>
          g.children.map((n) => {
            const icon = iconFor(n.terminal);
            const state = unread(n.terminal) ? ' · needs you' : stateFor(n.terminal) === 'working' ? ' · working' : '';
            return {
              label: `${icon instanceof vscode.ThemeIcon ? `$(${icon.id}) ` : ''}${n.label}`,
              description: g.name + state,
              terminal: n.terminal,
            };
          }),
        );
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Find terminal', matchOnDescription: true });
      if (pick) pick.terminal.show();
    }),
    { dispose: (() => { const h = setInterval(pollClaudeStates, 2000); return () => clearInterval(h); })() },
    vscode.commands.registerCommand('terminalGroups.expandAll', async () => {
      for (const g of groups) await view.reveal(g, { expand: true, select: false, focus: false }).then(undefined, () => {});
    }),
    vscode.window.onDidOpenTerminal(refresh),
    vscode.window.onDidCloseTerminal(refresh),
    vscode.window.onDidChangeActiveTerminal(() => (markActiveSeen() || filter !== 'all' ? refresh() : revealActive())),
    vscode.window.onDidChangeWindowState((s) => s.focused && markActiveSeen() && refresh()),
    decoEmitter,
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: decoEmitter.event,
      provideFileDecoration(uri) {
        if (uri.scheme !== DECO_SCHEME) return undefined;
        const id = uri.path.slice(1);
        const orange = new vscode.ThemeColor(ATTENTION_COLOR);
        if (id.startsWith('g:')) {
          const g = groups.find((x) => x.id === id);
          return g && g.unread ? { color: orange, badge: String(Math.min(g.unread, 99)), tooltip: 'Claude needs you' } : undefined;
        }
        const node = byId.get(id);
        if (!node || !unread(node.terminal)) return undefined;
        return { color: orange, badge: '●', tooltip: 'Claude needs you' };
      },
    }),
    vscode.window.onDidChangeTerminalState(refresh),
    vscode.window.onDidChangeTerminalShellIntegration(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(() => (loadTaskInfo(), refresh())),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('tasks') && (loadTaskInfo(), refresh())),
    view.onDidChangeVisibility(() => view.visible && revealActive()),
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

/** Workspace-file tasks from config; falls back to reading the .code-workspace file's "tasks" block. */
function readWorkspaceTasks(fromConfig) {
  if (Array.isArray(fromConfig) && fromConfig.length) return fromConfig;
  const file = vscode.workspace.workspaceFile;
  if (!file || file.scheme !== 'file') return [];
  try {
    const ws = JSON.parse(require('fs').readFileSync(file.fsPath, 'utf8'));
    return (ws.tasks && ws.tasks.tasks) || [];
  } catch {
    return [];
  }
}

/** Tasks from config; falls back to reading the folder's .vscode/tasks.json if config returns nothing. */
function readTasks(fromConfig, wf) {
  if (Array.isArray(fromConfig) && fromConfig.length) return fromConfig;
  if (!wf) return [];
  try {
    const raw = require('fs').readFileSync(require('path').join(wf.uri.fsPath, '.vscode', 'tasks.json'), 'utf8');
    return JSON.parse(raw).tasks || [];
  } catch {
    return [];
  }
}

/** Move the view into the Terminal panel once, so it sits where the built-in tab list was. */
async function dockBesideTerminal(context) {
  const KEY = 'terminalGroups.docked';
  if (context.globalState.get(KEY)) return;
  try {
    await vscode.commands.executeCommand('vscode.moveViews', { viewIds: [VIEW_ID], destinationId: 'terminal' });
    await context.globalState.update(KEY, true);
  } catch (err) {
    console.error('terminal-groups: could not dock beside terminal', err);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
