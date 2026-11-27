import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseLine,
  completeTyped,
  diskFolders,
  fitLine,
  initialFolderState,
  rowText,
  stepFolderKey,
  visibleRows,
  windowFor,
  type FolderInfo,
  type FolderKey,
  type FolderSource,
  type FolderState,
} from '../../src/ui/folderTree';

const key = (name: string, sequence?: string): FolderKey => ({ name, ctrl: false, sequence });
const typed = (ch: string): FolderKey => key(ch, ch);
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const pressWith = (source: FolderSource) => (state: FolderState, ...keys: FolderKey[]): FolderState => keys.reduce((s, k) => {
  const step = stepFolderKey(s, k, source);
  if (step.kind !== 'state') throw new Error(`chose ${step.path}`);
  return step.state;
}, state);
const labels = (state: FolderState) => visibleRows(state).map((r) => r.label);
const activeLabel = (state: FolderState) => visibleRows(state)[state.active]?.label;

describe('folder tree on disk', () => {
  let root: string;
  const press = pressWith(diskFolders);
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'capy-folder-tree-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const make = (path: string, ...files: string[]) => {
    mkdirSync(join(root, path), { recursive: true });
    for (const f of files) writeFileSync(join(root, path, f), '', 'utf-8');
  };

  test('lists every folder with no cap: .env first, then marked (Git counts), then the rest, by name ignoring case; hidden, dependency folders and symlinks skipped', () => {
    make('zeta', '.env');
    make('alpha', 'package.json');
    make('Repo');
    mkdirSync(join(root, 'Repo', '.git'));
    make('beta');
    make('Bravo');
    make('.hidden', '.env');
    for (const dep of ['node_modules/x', 'vendor', 'venv', '__pycache__', 'target', 'Pods', 'bower_components']) make(dep);
    for (let i = 0; i < 30; i++) make(`many-${String(i).padStart(2, '0')}`);
    symlinkSync(join(root, 'zeta'), join(root, 'linked'));
    const rows = visibleRows(initialFolderState(root, diskFolders));
    expect(rows[0]?.depth).toBe(0);
    expect(rows.slice(1, 6).map((r) => r.label)).toEqual(['zeta/', 'alpha/', 'Repo/', 'beta/', 'Bravo/']);
    expect(rows).toHaveLength(1 + 5 + 30);
    for (const hidden of ['.hidden/', 'node_modules/', 'vendor/', 'venv/', '__pycache__/', 'target/', 'Pods/', 'bower_components/', 'linked/']) {
      expect(rows.map((r) => r.label)).not.toContain(hidden);
    }
  });

  test('markers: .env, the first package file, keep.lock and Git, shown in one dim run', () => {
    make('app', '.env', 'package.json', 'go.mod', 'keep.lock');
    mkdirSync(join(root, 'app', '.git'));
    const info = diskFolders.info(join(root, 'app'));
    expect(info.markers).toEqual(['.env', 'package.json', 'keep.lock', 'git']);
    const text = rowText({ info, depth: 1, expanded: false, label: 'app/', children: undefined, isStart: false });
    expect(text).toContain('\x1b[90m.env · package.json · keep.lock · Git\x1b[0m');
  });

  test('→ opens and loads; → again goes to the first child; ← goes to the parent, then closes', () => {
    make('apps/web', '.env');
    make('apps/api');
    let s = press(initialFolderState(root, diskFolders), key('down'), key('right'));
    expect(labels(s).slice(1)).toEqual(['apps/', 'web/', 'api/']);
    s = press(s, key('right'));
    expect(activeLabel(s)).toBe('web/');
    s = press(s, key('left'));
    expect(activeLabel(s)).toBe('apps/');
    s = press(s, key('left'));
    expect(labels(s).slice(1)).toEqual(['apps/']);
  });

  test('→ on an open folder with nothing inside stays put, and the row says so', () => {
    make('empty');
    make('zz-next');
    let s = press(initialFolderState(root, diskFolders), key('down'), key('right'));
    expect(activeLabel(s)).toBe('empty/');
    s = press(s, key('right'));
    expect(activeLabel(s)).toBe('empty/');
    expect(plain(rowText(visibleRows(s)[1]!))).toContain('no folders inside');
  });

  test('Enter chooses the highlighted folder; the top row is the folder itself', () => {
    make('api', '.env');
    const s = initialFolderState(root, diskFolders);
    expect(stepFolderKey(s, key('return'), diskFolders)).toEqual({ kind: 'choose', path: root });
    expect(stepFolderKey(press(s, key('down')), key('return'), diskFolders)).toEqual({ kind: 'choose', path: join(root, 'api') });
  });

  test('← on the top row goes up one folder, cursor on where it came from; the top row then names the folder, not "this folder"', () => {
    make('outer/inner');
    let s = initialFolderState(join(root, 'outer', 'inner'), diskFolders);
    expect(plain(chooseLine(visibleRows(s)[0], s.base))).toBe('enter sets up Capy in this folder');
    s = press(s, key('left'));
    expect(s.base).toBe(join(root, 'outer'));
    expect(activeLabel(s)).toBe('inner/');
    s = press(s, key('up'));
    expect(visibleRows(s)[0]?.isStart).toBe(false);
    expect(plain(rowText(visibleRows(s)[0]!))).not.toContain('this folder');
    expect(plain(chooseLine(visibleRows(s)[0], s.base))).toContain(join(root, 'outer'));
  });

  test('never above the root: ← on the top row stops there, and a typed path outside it is refused', () => {
    make('inside/deeper');
    let s = initialFolderState(join(root, 'inside'), diskFolders, join(root, 'inside'));
    s = press(s, key('left'));
    expect(s.base).toBe(join(root, 'inside'));
    s = press({ ...s, typing: root }, key('return'));
    expect(s.error).toContain('outside where Capy can set up');
  });

  test('a typed symlink is resolved to its real folder, which must be inside the root', () => {
    make('real/child');
    make('box');
    symlinkSync(join(root, 'real'), join(root, 'box', 'lnk'));
    const boxed = press({ ...initialFolderState(join(root, 'box'), diskFolders, join(root, 'box')), typing: join(root, 'box', 'lnk') }, key('return'));
    expect(boxed.error).toContain('outside where Capy can set up');
    const open = press({ ...initialFolderState(root, diskFolders), typing: join(root, 'box', 'lnk') }, key('return'));
    expect(open.base).toBe(join(root, 'real'));
  });

  test('typing filters loaded folders by name; Esc clears it and keeps the cursor on that folder', () => {
    make('apps/search-indexer');
    make('billing');
    let s = press(initialFolderState(root, diskFolders), key('down'), key('right'), ...'sea'.split('').map(typed));
    expect(labels(s)).toEqual(['apps/search-indexer/']);
    expect(stepFolderKey(s, key('return'), diskFolders)).toEqual({ kind: 'choose', path: join(root, 'apps', 'search-indexer') });
    s = press(s, key('escape'));
    expect(s.query).toBe('');
    expect(activeLabel(s)).toBe('search-indexer/');
  });

  test('Esc and Backspace with no filter leave the cursor where it is', () => {
    make('a');
    make('b');
    const s = press(initialFolderState(root, diskFolders), key('down'), key('down'));
    expect(press(s, key('escape')).active).toBe(2);
    expect(press(s, key('backspace')).active).toBe(2);
  });

  test('~ or / starts typing a path; Tab completes; Enter browses there; a missing folder says what to do', () => {
    make('projects/web-app');
    let s = press(initialFolderState(root, diskFolders), typed('/'));
    expect(s.typing).toBe('/');
    s = press({ ...s, typing: `${root}/proj` }, key('tab'));
    expect(s.typing).toBe(`${root}/projects/`);
    s = press(s, key('return'));
    expect(s.base).toBe(join(root, 'projects'));
    expect(s.typing).toBeNull();
    s = press(s, typed('/'), ...'nope'.split('').map(typed), key('return'));
    expect(s.error).toContain('No folder at that path');
    expect(press(s, key('escape')).typing).toBeNull();
  });

  test('Tab completes a literal last segment only: the common start of several, never ~, . or .. or a trailing space', () => {
    make('web-app');
    make('web-api');
    make('a');
    expect(completeTyped('we', root, diskFolders)).toBe('web-ap');
    expect(completeTyped('~', root, diskFolders)).toBe('~');
    expect(completeTyped('..', join(root, 'a'), diskFolders)).toBe('..');
    expect(completeTyped('.', root, diskFolders)).toBe('.');
    expect(completeTyped(`${root}/we `, root, diskFolders)).toBe(`${root}/we `);
  });
});

describe('folder tree with a fake source', () => {
  const folder = (path: string, markers: string[] = [], readable = true): FolderInfo => ({ name: path.split('/').pop()!, path, markers, readable });
  const tree: Record<string, readonly FolderInfo[] | null> = {
    '/r': [folder('/r/locked', [], false), folder('/r/broken'), folder('/r/ok', ['.env'])],
    '/r/broken': null,
    '/r/ok': [],
  };
  const fake: FolderSource = {
    info: (path) => folder(path),
    list: (path) => (path in tree ? tree[path]! : []),
    realFolder: (path) => (path in tree ? path : null),
  };
  const press = pressWith(fake);

  test("a folder that can't be opened is shown, can't be opened or chosen, and says what to do", () => {
    let s = press(initialFolderState('/r', fake, '/r'), key('down'));
    expect(visibleRows(s)[1]?.info.readable).toBe(false);
    expect(plain(rowText(visibleRows(s)[1]!))).toContain("can't open");
    s = press(s, key('right'));
    expect(s.error).toContain("Can't open this folder. Check its permissions");
    expect(stepFolderKey(s, key('return'), fake).kind).toBe('state');
  });

  test("a folder that opens but can't be listed says so on its row", () => {
    const s = press(initialFolderState('/r', fake, '/r'), key('down'), key('down'), key('right'));
    expect(plain(rowText(visibleRows(s)[2]!))).toContain("can't open this folder");
  });

  test('the Enter line names a nested folder from the folder being browsed', () => {
    const row = { info: folder('/r/web-app/packages'), depth: 2, expanded: false, label: 'packages/', children: undefined, isStart: false };
    expect(plain(chooseLine(row, '/r'))).toBe('enter sets up Capy in web-app/packages/');
  });

  test('a long line is cut to the terminal width', () => {
    expect(plain(fitLine(`\x1b[36m${'x'.repeat(30)}\x1b[0m`, 10))).toBe(`${'x'.repeat(9)}…`);
  });

  test('a long level scrolls with the cursor kept on screen', () => {
    expect(windowFor(40, 0, 12)).toEqual({ start: 0, end: 12 });
    expect(windowFor(40, 20, 12)).toEqual({ start: 14, end: 26 });
    expect(windowFor(40, 39, 12)).toEqual({ start: 28, end: 40 });
    expect(windowFor(5, 4, 12)).toEqual({ start: 0, end: 5 });
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
