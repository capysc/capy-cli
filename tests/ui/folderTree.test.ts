import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completeTyped,
  diskFolders,
  initialFolderState,
  stepFolderKey,
  visibleRows,
  windowFor,
  type FolderKey,
  type FolderState,
} from '../../src/ui/folderTree';

const key = (name: string, sequence?: string): FolderKey => ({ name, ctrl: false, sequence });
const typed = (ch: string): FolderKey => key(ch, ch);

describe('folder tree', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'capy-folder-tree-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const make = (path: string, ...files: string[]) => {
    mkdirSync(join(root, path), { recursive: true });
    for (const f of files) writeFileSync(join(root, path, f), '', 'utf-8');
  };
  const press = (state: FolderState, ...keys: FolderKey[]): FolderState => keys.reduce((s, k) => {
    const step = stepFolderKey(s, k, diskFolders);
    if (step.kind !== 'state') throw new Error(`chose ${step.path}`);
    return step.state;
  }, state);
  const labels = (state: FolderState) => visibleRows(state, diskFolders).map((r) => r.label);

  test('lists every folder with no cap: .env first, then marked, then the rest; hidden, node_modules and symlinks skipped', () => {
    make('zeta', '.env');
    make('alpha', 'package.json');
    make('beta');
    make('.hidden', '.env');
    make('node_modules/x');
    for (let i = 0; i < 30; i++) make(`many-${String(i).padStart(2, '0')}`);
    symlinkSync(join(root, 'zeta'), join(root, 'linked'));
    const rows = visibleRows(initialFolderState(root, diskFolders), diskFolders);
    expect(rows[0]?.depth).toBe(0);
    expect(rows.slice(1, 4).map((r) => r.label)).toEqual(['zeta/', 'alpha/', 'beta/']);
    expect(rows).toHaveLength(1 + 3 + 30);
    expect(rows.map((r) => r.label)).not.toContain('.hidden/');
    expect(rows.map((r) => r.label)).not.toContain('node_modules/');
    expect(rows.map((r) => r.label)).not.toContain('linked/');
    expect(rows[1]?.info.markers).toEqual(['.env']);
  });

  test('markers: .env, the first package file, keep.lock and Git', () => {
    make('app', '.env', 'package.json', 'go.mod', 'keep.lock');
    mkdirSync(join(root, 'app', '.git'));
    expect(diskFolders.info(join(root, 'app')).markers).toEqual(['.env', 'package.json', 'keep.lock', 'git']);
  });

  test('→ opens a folder and loads it; → again goes to its first child; ← goes back to the parent, then closes', () => {
    make('apps/web', '.env');
    make('apps/api');
    let s = initialFolderState(root, diskFolders);
    s = press(s, key('down'), key('right'));
    expect(labels(s)).toEqual([expect.any(String), 'apps/', 'web/', 'api/']);
    s = press(s, key('right'));
    expect(visibleRows(s, diskFolders)[s.active]?.label).toBe('web/');
    s = press(s, key('left'));
    expect(visibleRows(s, diskFolders)[s.active]?.label).toBe('apps/');
    s = press(s, key('left'));
    expect(labels(s)).toEqual([expect.any(String), 'apps/']);
  });

  test('Enter chooses the highlighted folder, and the top row is the folder itself', () => {
    make('api', '.env');
    const s = initialFolderState(root, diskFolders);
    expect(stepFolderKey(s, key('return'), diskFolders)).toEqual({ kind: 'choose', path: root });
    const down = press(s, key('down'));
    expect(stepFolderKey(down, key('return'), diskFolders)).toEqual({ kind: 'choose', path: join(root, 'api') });
  });

  test('← on the top row goes up one folder, with the cursor on the folder it came from', () => {
    make('outer/inner');
    let s = initialFolderState(join(root, 'outer', 'inner'), diskFolders);
    s = press(s, key('left'));
    expect(s.base).toBe(join(root, 'outer'));
    expect(visibleRows(s, diskFolders)[s.active]?.label).toBe('inner/');
  });

  test('typing filters loaded folders by name; Esc clears the filter', () => {
    make('apps/search-indexer');
    make('billing');
    let s = initialFolderState(root, diskFolders);
    s = press(s, key('down'), key('right'), typed('s'), typed('e'), typed('a'));
    expect(labels(s)).toEqual(['apps/search-indexer/']);
    expect(stepFolderKey(s, key('return'), diskFolders)).toEqual({ kind: 'choose', path: join(root, 'apps', 'search-indexer') });
    s = press(s, key('escape'));
    expect(s.query).toBe('');
  });

  test('~ or / starts typing a path; Tab completes; Enter browses there; a missing folder says what to do', () => {
    make('projects/web-app');
    let s = initialFolderState(root, diskFolders);
    s = press(s, typed('/'));
    expect(s.typing).toBe('/');
    s = { ...s, typing: `${root}/proj` };
    s = press(s, key('tab'));
    expect(s.typing).toBe(`${root}/projects/`);
    s = press(s, key('return'));
    expect(s.base).toBe(join(root, 'projects'));
    expect(s.typing).toBeNull();
    s = press(s, typed('/'), ...'nope'.split('').map(typed), key('return'));
    expect(s.error).toContain('No folder at that path');
    s = press(s, key('escape'));
    expect(s.typing).toBeNull();
  });

  test('Tab completes to the common start when several folders match', () => {
    make('web-app');
    make('web-api');
    expect(completeTyped('we', root, diskFolders)).toBe('web-ap');
  });

  test("a folder that can't be opened is shown, can't be opened or chosen, and says so", () => {
    if (process.getuid?.() === 0) return; // root can open anything
    make('locked');
    chmodSync(join(root, 'locked'), 0o000);
    try {
      let s = initialFolderState(root, diskFolders);
      s = press(s, key('down'));
      expect(visibleRows(s, diskFolders)[1]?.info.readable).toBe(false);
      s = press(s, key('right'));
      expect(s.error).toContain("Can't open this folder");
      expect(stepFolderKey(s, key('return'), diskFolders).kind).toBe('state');
    } finally {
      chmodSync(join(root, 'locked'), 0o755);
    }
  });

  test('a long level scrolls with the cursor kept on screen', () => {
    expect(windowFor(40, 0, 12)).toEqual({ start: 0, end: 12 });
    expect(windowFor(40, 20, 12)).toEqual({ start: 14, end: 26 });
    expect(windowFor(40, 39, 12)).toEqual({ start: 28, end: 40 });
    expect(windowFor(5, 4, 12)).toEqual({ start: 0, end: 5 });
  });
});

describe('folder tree copy', () => {
  test('the Enter line names the folder relative to the one being browsed', async () => {
    const { chooseLine } = await import('../../src/ui/folderTree');
    const row = { info: { name: 'packages', path: '/r/web-app/packages', markers: [], readable: true }, depth: 2, expanded: false, label: 'packages/' };
    expect(chooseLine(row, '/r').replace(/\x1b\[[0-9;]*m/g, '')).toBe('enter sets up Capy in web-app/packages/');
  });
});

describe('the folder question carries no summary', () => {
  test('no org, project or branch rows and no branch line while the folder is asked (Vincent, 2026-11-27)', async () => {
    const { setupForm } = await import('../../src/commands/setupForm');
    const form = setupForm({
      answers: {} as never,
      variables: 0,
      folderChoices: { here: '/code/synthetic-projects', subfolders: [{ name: 'api-server', marker: '.env' }] },
    } as never);
    expect(form.display).toContain('/code/synthetic-projects');
    expect(form.display).not.toMatch(/branch|\| Org |\| Project /i);
  });
});
