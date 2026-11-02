/**
 * The location and repo pickers of the `capy secrets` edit flow drawn as tables
 * with headings (ui/pickerTable.ts): the columns line up, no line is wider than
 * the terminal at any width, narrow terminals cut REPO / PROJECTS (or PROJECT /
 * BRANCH) with `…`, the change counts, the filter, and the not-linked line.
 */
import { describe, test, expect } from 'bun:test';
import {
  SecretsScreenState,
  applyRepos,
  handleKey,
  initialSecretsScreenState,
  render,
  tokenizeKeys,
} from '../../src/ui/secretsScreen';
import { CHECKBOX_CURSOR, CHECKBOX_THEME } from '../../src/ui/promptStyle';
import { readFileSync } from 'node:fs';
import { checkboxCell, clipLine, columnWidths, shrinkWidths, truncateCell } from '../../src/ui/pickerTable';
import { changesIn } from '../../src/ui/secretsEditFlow';
import type { OrgRepoLink, SecretIndexRow } from '../../src/service/serviceClient';
import type { RepoTarget, SetLocation } from '../../src/commands/secretsSet';

const ESC = '\x1b';
/** The standard checkbox icons (ui/promptStyle.ts `CHECKBOX_THEME`): ticked and unticked. */
const ON = '◉';
const OFF = '◯';
const isRow = (l: string): boolean => l.includes(ON) || l.includes(OFF);
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const press = (s: SecretsScreenState, ...keys: readonly string[]): SecretsScreenState => keys.reduce((a, k) => handleKey(a, k).state, s);
const type = (s: SecretsScreenState, text: string): SecretsScreenState => press(s, ...tokenizeKeys(text));
const frameAt = (s: SecretsScreenState, width: number): readonly string[] => strip(render(s, width, 30)).split('\n');
const lineWith = (lines: readonly string[], text: string): string => lines.find((l) => l.includes(text)) ?? '';

const loc = (project_id: string, project_name: string, branch: string, isProtected = false) => ({
  project_id,
  project_name,
  branch,
  protected: isProtected,
  service: null,
});

const row: SecretIndexRow = {
  name: 'ANTHROPIC_API_KEY',
  value_hash: 'h',
  locations: [
    loc('p1', 'backend', 'production', true),
    loc('p1', 'backend', 'staging'),
    loc('p2', 'worker', 'production', true),
    loc('p3', 'swot', 'development'),
    loc('p4', 'pdf-to-docx', 'development'),
    loc('p5', 'scraper', 'development'),
  ],
  users: [],
};

const link = (project_id: string, project_name: string, name: string, over: Partial<OrgRepoLink> = {}): OrgRepoLink => ({
  project_id,
  project_name,
  host: 'github.com',
  owner: 'SlideSpeak',
  name,
  path: '.',
  github_repo_id: 1,
  last_seen_at: '',
  ...over,
});

const LINKS: readonly OrgRepoLink[] = [
  link('p1', 'backend', 'slidespeak-monorepo', { path: 'backend' }),
  link('p2', 'worker', 'slidespeak-monorepo', { path: 'worker' }),
  link('p3', 'swot', 'swot-analysis-generator-server'),
  link('p4', 'pdf-to-docx', 'pdf-to-docx-server'),
];
const BASES = {
  'github.com/slidespeak/slidespeak-monorepo': 'main',
  'github.com/slidespeak/swot-analysis-generator-server': 'main',
  'github.com/slidespeak/pdf-to-docx-server': 'main',
};

const atLocations = (): SecretsScreenState => press(type(press(initialSecretsScreenState([row]), '\x05'), 'v'), '\r');
const atRepos = (): SecretsScreenState => applyRepos(handleKey(atLocations(), '\r').state, { ok: true, links: LINKS, bases: BASES });

/** Where the first heading word starts, per column heading, on the heading line. */
const columnsOf = (heading: string, words: readonly string[]): readonly number[] => words.map((w) => heading.indexOf(w));

describe('the repo step as a table', () => {
  test('headings REPO / PROJECTS / BASE, checkbox column first, rows with the change counts, BASE from the plan', () => {
    const lines = frameAt(atRepos(), 120);
    expect(lines).toContain('  Create a PR with these changes?');
    const heading = lineWith(lines, 'REPO');
    expect(heading).toMatch(/^ {5}\s*REPO\s+PROJECTS\s+BASE$/);
    expect(lineWith(lines, 'slidespeak-monorepo')).toMatch(/^ {2}[❯ ] ◉ {2}SlideSpeak\/slidespeak-monorepo\s+backend, worker \(3 changes\)\s+main$/);
    expect(lineWith(lines, 'swot-analysis')).toMatch(/swot \(1 change\)\s+main$/);
    expect(lineWith(lines, 'pdf-to-docx-server')).toMatch(/pdf-to-docx \(1 change\)\s+main$/);
    expect(lines.join('\n')).toContain('No linked repo, so no PR: scraper');
    expect(lines.join('\n')).not.toContain('Not linked');
  });

  test('the headings line up with the cells at widths 60, 80 and 120, and no line is wider than the terminal', () => {
    [60, 80, 120].forEach((width) => {
      const lines = frameAt(atRepos(), width);
      lines.forEach((l) => expect({ width, len: Array.from(l).length <= width }).toEqual({ width, len: true }));
      const [r, p, b] = columnsOf(lineWith(lines, 'REPO'), ['REPO', 'PROJECTS', 'BASE']);
      const rowsOf = lines.filter((l) => isRow(l));
      expect(rowsOf).toHaveLength(3);
      rowsOf.forEach((l) => {
        expect(l.indexOf('SlideSpeak/')).toBe(r);
        expect(l.indexOf('main')).toBe(b);
        expect(l[p - 1]).toBe(' '); // the PROJECTS cell starts exactly under its heading, after a gap
        expect(l[p]).not.toBe(' ');
      });
    });
  });

  test('a narrow terminal cuts REPO and PROJECTS with …, keeps BASE whole, and no line exceeds the width', () => {
    const lines = frameAt(atRepos(), 60);
    const rows = lines.filter((l) => l.includes(ON));
    expect(rows.some((l) => l.includes('…'))).toBe(true);
    rows.forEach((l) => expect(l.endsWith('main')).toBe(true));
    expect(Math.max(...lines.map((l) => Array.from(l).length))).toBeLessThanOrEqual(60);
  });

  test('change counts are keep.lock entries (project x branch) of the chosen locations, singular and plural', () => {
    const monorepo: RepoTarget = {
      host: 'github.com',
      owner: 'SlideSpeak',
      name: 'm',
      files: [
        { project_id: 'p1', project_name: 'backend', path: 'backend' },
        { project_id: 'p2', project_name: 'worker', path: 'worker' },
      ],
    };
    const chosen: readonly SetLocation[] = [
      { project_id: 'p1', project_name: 'backend', branch: 'production', protected: true },
      { project_id: 'p1', project_name: 'backend', branch: 'staging', protected: false },
      { project_id: 'p3', project_name: 'swot', branch: 'development', protected: false },
    ];
    expect(changesIn(monorepo, chosen)).toBe(2);
    expect(changesIn(monorepo, chosen.slice(0, 1))).toBe(1);
    expect(changesIn(monorepo, [])).toBe(0);
  });

  test('deselecting locations changes the counts and the projects shown', () => {
    // untick backend/production (cursor starts on row 0), then go on
    const fewer = applyRepos(handleKey(press(atLocations(), ' '), '\r').state, { ok: true, links: LINKS, bases: BASES });
    const lines = frameAt(fewer, 120);
    expect(lineWith(lines, 'slidespeak-monorepo')).toMatch(/backend, worker \(2 changes\)/);
  });

  test('a ticked and an unticked row show the standard ticked and unticked icons', () => {
    const lines = frameAt(press(atRepos(), ' '), 120);
    expect(lineWith(lines, 'slidespeak-monorepo')).toContain(OFF);
    expect(lineWith(lines, 'swot-analysis')).toContain(ON);
  });

  test('a repo whose base could not be read shows —', () => {
    const noBases = applyRepos(handleKey(atLocations(), '\r').state, { ok: true, links: LINKS, bases: {} });
    expect(lineWith(frameAt(noBases, 120), 'swot-analysis')).toMatch(/swot \(1 change\)\s+—$/);
  });

  test('filtering matches REPO and PROJECTS text: a project name finds its repo, `/` starts it, Esc ends it', () => {
    const filtering = type(press(atRepos(), '/'), 'pdf');
    const lines = frameAt(filtering, 120);
    expect(lines.filter((l) => isRow(l))).toHaveLength(1);
    expect(lineWith(lines, 'pdf-to-docx-server')).toContain(ON);
    expect(lines.join('\n')).toContain('search: pdf');
    // a project inside the monorepo finds the monorepo
    const byProject = frameAt(type(press(atRepos(), '/'), 'worker'), 120);
    expect(byProject.filter((l) => l.includes(ON))).toHaveLength(1);
    expect(lineWith(byProject, 'slidespeak-monorepo')).toContain(ON);
    // nothing matches
    expect(frameAt(type(press(atRepos(), '/'), 'zzz'), 120).join('\n')).toContain('No matches.');
    // Esc ends the filter and brings every row back
    expect(frameAt(press(filtering, ESC), 120).filter((l) => l.includes(ON))).toHaveLength(3);
  });

  test('no linked repo at all: the not-linked line alone, no table', () => {
    const none = applyRepos(handleKey(atLocations(), '\r').state, { ok: true, links: [], bases: {} });
    const text = frameAt(none, 100).join('\n');
    expect(text).toContain('No linked repos.');
    expect(text).toContain('No linked repo, so no PR: backend, pdf-to-docx, scraper, swot, worker');
    expect(text).not.toContain('REPO');
  });
});

describe('the location step as a table', () => {
  test('headings PROJECT / BRANCH / PROTECTED; protected is `yes` or blank; header line shows the count', () => {
    const lines = frameAt(atLocations(), 100);
    expect(lines).toContain('  ANTHROPIC_API_KEY · 6 of 6 locations');
    expect(lineWith(lines, 'PROJECT')).toMatch(/^ {5}\s*PROJECT\s+BRANCH\s+PROTECTED$/);
    expect(lines.find((l) => l.includes('backend') && l.includes('production')) ?? '').toMatch(/^ {2}[❯ ] ◉ {2}backend\s+production\s+yes$/);
    expect(lines.filter((l) => /\bstaging\b/.test(l) && l.includes(ON))[0]).toMatch(/staging$/);
    expect(lines.join('\n')).not.toContain(' · production'); // the old inline label is gone
  });

  test('the headings line up with the cells, and no line is wider than the terminal, at 60, 80 and 120', () => {
    [60, 80, 120].forEach((width) => {
      const lines = frameAt(atLocations(), width);
      lines.forEach((l) => expect(Array.from(l).length).toBeLessThanOrEqual(width));
      const [p, b, pr] = columnsOf(lineWith(lines, 'PROJECT'), ['PROJECT', 'BRANCH', 'PROTECTED']);
      const rows = lines.filter((l) => l.includes(ON));
      expect(rows).toHaveLength(6);
      rows.forEach((l) => {
        expect(l[p]).not.toBe(' ');
        expect(l[p - 1]).toBe(' ');
        expect(l[b]).not.toBe(' ');
        expect(l[b - 1]).toBe(' ');
      });
      const protectedRows = rows.filter((l) => l.endsWith('yes'));
      expect(protectedRows).toHaveLength(2);
      protectedRows.forEach((l) => expect(l.indexOf('yes')).toBe(pr));
    });
  });

  test('a long project name is cut with … on a narrow terminal while PROTECTED stays whole', () => {
    const long: SecretIndexRow = { ...row, locations: [loc('p1', 'a-very-long-project-name-indeed', 'a-long-branch-name-too', true)] };
    const at = press(type(press(initialSecretsScreenState([long]), '\x05'), 'v'), '\r');
    const lines = frameAt(at, 40);
    lines.forEach((l) => expect(Array.from(l).length).toBeLessThanOrEqual(40));
    expect(lineWith(lines, ON)).toContain('…');
    expect(lineWith(lines, ON).endsWith('yes')).toBe(true);
  });

  test('the same keys as the deploy picker still work in the table: space, a, i, /, enter, esc', () => {
    const checked = (s: SecretsScreenState) => frameAt(s, 100).filter((l) => l.includes(ON)).length;
    const s = atLocations();
    expect(checked(s)).toBe(6);
    expect(checked(press(s, 'a'))).toBe(0);
    expect(checked(press(s, ' '))).toBe(5);
    expect(checked(press(s, ' ', 'i'))).toBe(1);
    const filtered = frameAt(type(press(s, '/'), 'worker'), 100);
    expect(filtered.filter((l) => l.includes(ON))).toHaveLength(1);
    // filtering also matches the branch and the word protected
    expect(frameAt(type(press(s, '/'), 'protected'), 100).filter((l) => l.includes(ON))).toHaveLength(2);
    expect(frameAt(type(press(s, '/'), 'staging'), 100).filter((l) => l.includes(ON))).toHaveLength(1);
  });

  test('while the repos load, the table stays and the loading note shows', () => {
    const loading = handleKey(atLocations(), '\r').state;
    const text = frameAt(loading, 100).join('\n');
    expect(text).toContain('PROTECTED');
    expect(text).toContain('Loading repos…');
  });
});

describe('every other step of the edit flow is clipped to the terminal too', () => {
  test('the value dialog, the running note and the confirmation never exceed a narrow terminal', () => {
    const value = press(initialSecretsScreenState([row]), '\x05');
    expect(Math.max(...frameAt(type(value, 'x'.repeat(200)), 50).map((l) => Array.from(l).length))).toBeLessThanOrEqual(50);
  });
});

describe('table helpers', () => {
  test('truncateCell: whole when it fits, otherwise ends in …', () => {
    expect(truncateCell('abc', 5)).toBe('abc');
    expect(truncateCell('abcdef', 4)).toBe('abc…');
    expect(Array.from(truncateCell('abcdefghij', 6)).length).toBe(6);
  });

  test('clipLine: counts visible characters only, keeps colour codes and their reset', () => {
    expect(clipLine('hello', 10)).toBe('hello');
    expect(strip(clipLine('hello world', 6))).toBe('hello…');
    const coloured = `${ESC}[90mhello world${ESC}[0m`;
    const clipped = clipLine(coloured, 6);
    expect(strip(clipped)).toBe('hello…');
    expect(clipped).toContain(`${ESC}[0m`);
    expect(Array.from(strip(clipLine(`${ESC}[7mabc${ESC}[0m`, 3))).length).toBe(3);
  });

  test('columnWidths and shrinkWidths: fit the content, then only shrinkable columns give way, never below 8', () => {
    const columns = [
      { heading: 'REPO', shrink: true },
      { heading: 'PROJECTS', shrink: true },
      { heading: 'BASE', shrink: false },
    ];
    const rows = [['a'.repeat(40), 'b'.repeat(30), 'main']];
    expect(columnWidths(columns, rows, 200)).toEqual([40, 30, 4]);
    const narrow = columnWidths(columns, rows, 60);
    expect(narrow[2]).toBe(4);
    expect(5 + narrow.reduce((a, b) => a + b, 0) + 4).toBeLessThanOrEqual(60);
    expect(shrinkWidths([40, 30, 4], [true, true, false], 1000)).toEqual([8, 8, 4]);
  });
});

describe('the checkbox column is the CLI standard (promptStyle CHECKBOX_THEME), not its own', () => {
  test('the glyphs the tests assert are the theme\'s icons and cursor', () => {
    expect(CHECKBOX_THEME.icon.checked.trim()).toBe(ON);
    expect(CHECKBOX_THEME.icon.unchecked.trim()).toBe(OFF);
    expect(CHECKBOX_CURSOR).toBe('❯');
  });

  test('every row is cursor-or-space plus the theme icon; the active row has the cursor; headings are indented by exactly that cell', () => {
    const lines = frameAt(press(atRepos(), ' '), 120); // first row active and unticked
    const cell = (active: boolean, on: boolean) => `${active ? CHECKBOX_CURSOR : ' '}${on ? CHECKBOX_THEME.icon.checked : CHECKBOX_THEME.icon.unchecked}`;
    expect(checkboxCell(true, false)).toBe(cell(true, false));
    expect(checkboxCell(false, true)).toBe(cell(false, true));
    expect(lineWith(lines, 'slidespeak-monorepo').startsWith(`  ${cell(true, false)}  SlideSpeak/`)).toBe(true);
    expect(lineWith(lines, 'swot-analysis').startsWith(`  ${cell(false, true)}  SlideSpeak/`)).toBe(true);
    // The heading starts its first column exactly where the rows do.
    expect(lineWith(lines, 'REPO').indexOf('REPO')).toBe(lineWith(lines, 'slidespeak-monorepo').indexOf('SlideSpeak/'));
    // The location table uses the same cell.
    const loc = frameAt(atLocations(), 100);
    expect(loc.find((l) => l.includes('backend') && l.includes('production'))?.startsWith(`  ${cell(true, true)}  backend`)).toBe(true);
    expect(loc.find((l) => l.includes('swot'))?.startsWith(`  ${cell(false, true)}  swot`)).toBe(true);
  });

  test('pickerTable.ts draws no checkbox glyph of its own (only through the theme)', () => {
    const code = readFileSync(`${import.meta.dir}/../../src/ui/pickerTable.ts`, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)) // not the comments
      .join('\n');
    ['◉', '◯', '❯', '[x]', '[ ]'].forEach((glyph) => expect({ glyph, found: code.includes(glyph) }).toEqual({ glyph, found: false }));
  });
});
