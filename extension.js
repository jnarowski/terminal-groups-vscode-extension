const vscode = require('vscode');
const { classify, applyOrder, reorder } = require('./lib');

const VIEW_ID = 'terminalGroups.tree';
const MIME = 'application/vnd.code.tree.terminalgroups.tree';
const ORDER_KEY = 'terminalGroups.order';

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
    const m = /^(.*) \(([^()]+)\)$/.exec(t.name);
    if (m && !folders().some((f) => f.name === m[2])) return taskInfo.get(`ws:${m[1]}`);
    return undefined;
  }

  function build() {
    const fs = folders();
    const order = context.workspaceState.get(ORDER_KEY, {});
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
    byTerminal = new Map();
    byId = new Map();
    for (const g of groups) {
      g.children = applyOrder(g.children, (n) => n.terminal.name, order[g.name]);
      for (const n of g.children) {
        byTerminal.set(n.terminal, n);
        byId.set(n.id, n);
      }
    }
  }

  function iconFor(t) {
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
        item.iconPath = new vscode.ThemeIcon('folder');
        item.description = `${node.children.length}`;
        return item;
      }
      const t = node.terminal;
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.contextValue = 'terminal';
      item.iconPath = iconFor(t);
      const code = exitCodes.get(t);
      if (code !== undefined) item.description = code === 0 ? 'done' : `exit ${code}`;
      else if (t.exitStatus) item.description = `exit ${t.exitStatus.code ?? ''}`.trim();
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
      const termIds = source.filter((n) => n.type === 'terminal').map((n) => n.id);
      if (termIds.length) dataTransfer.set(MIME, new vscode.DataTransferItem(termIds));
    },
    async handleDrop(target, dataTransfer) {
      const item = dataTransfer.get(MIME);
      if (!item || !target) return;
      const group = target.type === 'group' ? target : target.parent;
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

  let pending;
  function refresh() {
    clearTimeout(pending);
    pending = setTimeout(() => {
      build();
      emitter.fire();
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
    vscode.commands.registerCommand('terminalGroups.expandAll', async () => {
      for (const g of groups) await view.reveal(g, { expand: true, select: false, focus: false }).then(undefined, () => {});
    }),
    vscode.window.onDidOpenTerminal(refresh),
    vscode.window.onDidCloseTerminal(refresh),
    vscode.window.onDidChangeActiveTerminal(revealActive),
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
