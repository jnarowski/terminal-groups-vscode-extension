const test = require('node:test');
const assert = require('node:assert');
const { classify, applyOrder, reorder } = require('./lib');

const R = '/Users/jp/metarepo';
const folders = [
  { name: 'sourceborn-metarepo (root)', path: R },
  { name: 'habitherd', path: `${R}/repos/habitherd` },
  { name: 'obsidian', path: `${R}/repos/obsidian` },
  { name: 'jpuncompiled-com', path: `${R}/repos/jpuncompiled-com` },
];

test('task terminal groups by folder suffix and strips it', () => {
  const r = classify('pnpm dev (habitherd)', undefined, folders);
  assert.strictEqual(r.folder.name, 'habitherd');
  assert.strictEqual(r.label, 'pnpm dev');
});

test('unknown suffix falls back to cwd (workspace-level task)', () => {
  const r = classify('obsidian terminal (sourceborn-metarepo)', `${R}/repos/obsidian`, folders);
  assert.strictEqual(r.folder.name, 'obsidian');
  assert.strictEqual(r.label, 'obsidian terminal (sourceborn-metarepo)');
});

test('cwd picks the deepest folder, subdirs included', () => {
  assert.strictEqual(classify('zsh', `${R}/repos/habitherd/apps/app`, folders).folder.name, 'habitherd');
  assert.strictEqual(classify('zsh', R, folders).folder.name, 'sourceborn-metarepo (root)');
  assert.strictEqual(classify('zsh', `${R}/repos/habitherd-x`, folders).folder.name, 'sourceborn-metarepo (root)');
});

test('no suffix match and no cwd goes to the first folder', () => {
  assert.strictEqual(classify('zsh', undefined, folders).folder.name, 'sourceborn-metarepo (root)');
  assert.strictEqual(classify('claude - worker (jpuncompiled-com)', undefined, folders).label, 'claude - worker');
});

test('applyOrder sorts by saved keys, unknowns keep order at end', () => {
  const out = applyOrder(['a', 'b', 'c', 'd'], (x) => x, ['c', 'a']);
  assert.deepStrictEqual(out, ['c', 'a', 'b', 'd']);
});

test('reorder moves keys before target or to end', () => {
  assert.deepStrictEqual(reorder(['a', 'b', 'c', 'd'], ['d'], 'b'), ['a', 'd', 'b', 'c']);
  assert.deepStrictEqual(reorder(['a', 'b', 'c', 'd'], ['a'], undefined), ['b', 'c', 'd', 'a']);
  assert.deepStrictEqual(reorder(['a', 'b', 'c', 'd'], ['a'], 'd'), ['b', 'c', 'a', 'd']);
});
