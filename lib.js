// Pure helpers (no vscode import) so they can be unit-tested with node --test.

/**
 * Pick the workspace folder a terminal belongs to.
 * 1. Task terminals are titled "label (folder name)": match the suffix.
 * 2. Otherwise use the terminal's cwd, longest matching folder path wins.
 * 3. Otherwise the first workspace folder (the metarepo root).
 * @param {string} name terminal title
 * @param {string | undefined} cwd absolute path, if known
 * @param {{name: string, path: string}[]} folders workspace folders in order
 * @returns {{folder: {name: string, path: string} | undefined, label: string}}
 */
function classify(name, cwd, folders) {
  const m = /^(.*) \(([^()]+)\)$/.exec(name);
  if (m) {
    const folder = folders.find((f) => f.name === m[2]);
    if (folder) return { folder, label: m[1] };
  }
  if (cwd) {
    let best;
    for (const f of folders) {
      const p = f.path.replace(/\/+$/, '');
      if ((cwd === p || cwd.startsWith(p + '/')) && (!best || p.length > best.path.length)) {
        best = { ...f, path: p };
      }
    }
    if (best) return { folder: folders.find((f) => f.name === best.name), label: name };
  }
  return { folder: folders[0], label: name };
}

/**
 * Order items by a saved list of keys; unknown keys keep their original order at the end.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} key
 * @param {string[] | undefined} saved
 * @returns {T[]}
 */
function applyOrder(items, key, saved) {
  if (!saved || !saved.length) return items;
  const rank = new Map(saved.map((k, i) => [k, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.has(key(item)) ? rank.get(key(item)) : Infinity }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}

/**
 * Move `moving` keys so they sit before `beforeKey` (or at the end when undefined).
 * @param {string[]} current full ordered key list of the group
 * @param {string[]} moving
 * @param {string | undefined} beforeKey
 * @returns {string[]}
 */
function reorder(current, moving, beforeKey) {
  const rest = current.filter((k) => !moving.includes(k));
  const at = beforeKey === undefined ? rest.length : rest.indexOf(beforeKey);
  rest.splice(at === -1 ? rest.length : at, 0, ...moving);
  return rest;
}

/**
 * Claude Code state for a terminal: the newest state file whose process ancestry includes
 * the terminal's shell PID. States come from the optional hooks/claude-state.sh hook.
 * @param {{state: string, pids: number[], ts: number}[]} states
 * @param {number | undefined} terminalPid
 * @returns {{state: string, ts: number} | undefined} state is 'working' | 'needs'; ts in seconds
 */
function claudeEntryFor(states, terminalPid) {
  if (!terminalPid) return undefined;
  let best;
  for (const s of states) {
    if (Array.isArray(s.pids) && s.pids.includes(terminalPid) && (!best || s.ts > best.ts)) best = s;
  }
  return best;
}

const claudeStateFor = (states, pid) => (claudeEntryFor(states, pid) || {}).state;

/**
 * Unread = Claude needs you and you haven't viewed the terminal since that state was written.
 * @param {{state: string, ts: number} | undefined} entry
 * @param {number | undefined} seenMs when the terminal was last viewed (ms)
 */
const isUnread = (entry, seenMs) => !!entry && entry.state === 'needs' && entry.ts * 1000 > (seenMs || 0);

module.exports = { classify, applyOrder, reorder, claudeEntryFor, claudeStateFor, isUnread };
