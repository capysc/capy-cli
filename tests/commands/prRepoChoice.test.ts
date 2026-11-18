import { describe, expect, test } from 'bun:test';
import {
  ambiguousProjects,
  chooseRepoRows,
  parsePrRepoFlags,
  prRepoElicitation,
  prRepoLines,
  prRepoStop,
  repoRowValue,
} from '../../src/commands/prRepoChoice';
import type { OrgRepoLink } from '../../src/service/serviceClient';

/**
 * Which stored repo row a pull request goes to when a project has more than one: nothing decides for the person.
 * Pure: the rows in, the question or the chosen rows out.
 */

const link = (project: string, owner: string, name: string, path: string, host = 'github.com'): OrgRepoLink => ({
  project_id: project,
  project_name: `${project}-name`,
  host,
  owner,
  name,
  path,
  github_repo_id: null,
  last_seen_at: '',
});

const REAL = link('pA', 'Acme', 'mono', 'backend');
const TEMP = link('pA', 'Acme', 'mono', '.claude/capy-temp');
const ROOT = link('pB', 'Acme', 'solo', '.');
const GITLAB = link('pB', 'Acme', 'solo', 'x', 'gitlab.com');
const LINKS = [REAL, TEMP, ROOT, GITLAB];

describe('the rows to choose between', () => {
  test('a row is owner/name at the repo root and owner/name/folder otherwise', () => {
    expect(repoRowValue(ROOT)).toBe('Acme/solo');
    expect(repoRowValue(TEMP)).toBe('Acme/mono/.claude/capy-temp');
  });

  test('only a project with more than one GitHub row is ambiguous', () => {
    expect(ambiguousProjects(LINKS, ['pA', 'pB'])).toEqual([
      { project_id: 'pA', project_name: 'pA-name', rows: ['Acme/mono/backend', 'Acme/mono/.claude/capy-temp'] },
    ]);
  });

  test('a project that is not part of the run is never asked about', () => {
    expect(ambiguousProjects(LINKS, ['pB'])).toEqual([]);
  });

  test('the same row reported twice (owner and name in another case) is one row', () => {
    const again = link('pA', 'acme', 'MONO', 'backend');
    expect(ambiguousProjects([REAL, again], ['pA'])).toEqual([]);
  });
});

describe('--pr-repo', () => {
  test('is <project_id>=<owner/name[/folder]>, repeatable', () => {
    expect(parsePrRepoFlags(['pA=Acme/mono/backend', 'pB=Acme/solo'])).toEqual({
      ok: true,
      choices: [
        { project_id: 'pA', row: 'Acme/mono/backend' },
        { project_id: 'pB', row: 'Acme/solo' },
      ],
    });
  });

  test('anything else is named back', () => {
    expect(parsePrRepoFlags(['Acme/mono'])).toEqual({ ok: false, token: 'Acme/mono' });
    expect(parsePrRepoFlags(['pA=mono'])).toEqual({ ok: false, token: 'pA=mono' });
    expect(parsePrRepoFlags(['=Acme/mono'])).toEqual({ ok: false, token: '=Acme/mono' });
    expect(parsePrRepoFlags(['pA=Acme//x'])).toEqual({ ok: false, token: 'pA=Acme//x' });
  });
});

describe('applying the answers', () => {
  test('with no answer the project is unanswered and none of its rows is planned; every other link passes through', () => {
    const outcome = chooseRepoRows(LINKS, ['pA', 'pB'], []);
    expect(outcome.unanswered.map((p) => p.project_id)).toEqual(['pA']);
    expect(outcome.links).toEqual([ROOT, GITLAB]);
    expect(outcome.unmatched).toEqual([]);
  });

  test('the chosen row is kept and the other left out', () => {
    const outcome = chooseRepoRows(LINKS, ['pA', 'pB'], [{ project_id: 'pA', row: 'acme/MONO/backend' }]);
    expect(outcome.unanswered).toEqual([]);
    expect(outcome.links).toEqual([REAL, ROOT, GITLAB]);
  });

  test('more than one row may be chosen for a project', () => {
    const outcome = chooseRepoRows(LINKS, ['pA'], [
      { project_id: 'pA', row: 'Acme/mono/backend' },
      { project_id: 'pA', row: 'Acme/mono/.claude/capy-temp' },
    ]);
    expect(outcome.links).toEqual(LINKS);
  });

  test('an answer for a project with one row is accepted when it names that row', () => {
    const outcome = chooseRepoRows(LINKS, ['pB'], [{ project_id: 'pB', row: 'Acme/solo' }]);
    expect(outcome).toEqual({ links: LINKS, unanswered: [], unmatched: [] });
  });

  test('an answer naming no row of a project in the run is unmatched', () => {
    expect(chooseRepoRows(LINKS, ['pA'], [{ project_id: 'pA', row: 'Acme/mono' }]).unmatched).toEqual(['pA=Acme/mono']);
    expect(chooseRepoRows(LINKS, ['pA'], [{ project_id: 'pZ', row: 'Acme/mono/backend' }]).unmatched).toEqual(['pZ=Acme/mono/backend']);
    expect(chooseRepoRows(LINKS, ['pA'], [{ project_id: 'pA', row: 'Acme/mono/BACKEND' }]).unmatched).toEqual(['pA=Acme/mono/BACKEND']);
  });

  test('a project with one row is never asked about and its link is untouched', () => {
    expect(chooseRepoRows([ROOT], ['pB'], [])).toEqual({ links: [ROOT], unanswered: [], unmatched: [] });
  });
});

describe('the question, for an agent to put to the human', () => {
  const unanswered = ambiguousProjects([...LINKS, link('pC', 'Acme', 'a', '.'), link('pC', 'Acme', 'b', '.')], ['pA', 'pC']);

  test('one field per project; its options are the project\'s rows; the pattern accepts only them', () => {
    const e = prRepoElicitation(unanswered, 'capy secrets deploy X --dry-run --json');
    expect(e.kind).toBe('form');
    expect(e.fields.map((f) => f.name)).toEqual(['repo_1', 'repo_2']);
    expect(e.fields[0].options).toEqual([
      { value: 'Acme/mono/backend', label: 'Acme/mono/backend' },
      { value: 'Acme/mono/.claude/capy-temp', label: 'Acme/mono/.claude/capy-temp' },
    ]);
    const pattern = new RegExp(e.fields[0].pattern);
    expect(pattern.test('Acme/mono/backend')).toBe(true);
    expect(pattern.test('Acme/mono/.claude/capy-temp')).toBe(true);
    expect(pattern.test('Acme/mono/xclaude/capy-temp')).toBe(false);
    expect(pattern.test('Acme/mono')).toBe(false);
  });

  test('the rerun is the same command with one --pr-repo per project still to fill in', () => {
    const e = prRepoElicitation(unanswered, 'capy secrets deploy X --dry-run --json');
    expect(e.answer.rerun).toBe('capy secrets deploy X --dry-run --json --pr-repo pA=<repo_1> --pr-repo pC=<repo_2>');
  });

  test('details and display carry names, ids and rows only', () => {
    const e = prRepoElicitation(unanswered, 'x');
    expect(e.details).toEqual({
      projects: [
        { id: 'pA', name: 'pA-name', repos: ['Acme/mono/backend', 'Acme/mono/.claude/capy-temp'] },
        { id: 'pC', name: 'pC-name', repos: ['Acme/a', 'Acme/b'] },
      ],
    });
    expect(e.display.split('\n')).toHaveLength(2 + 4);
  });

  test('the unanswered stop and the terminal lines name the flag and every row', () => {
    expect(prRepoStop(unanswered)[0]).toMatchObject({ id: 'pr_repo', flag: '--pr-repo' });
    expect(prRepoLines(unanswered)).toContain('    --pr-repo pA=Acme/mono/.claude/capy-temp');
    expect(prRepoLines(unanswered)).toContain('    --pr-repo pC=Acme/b');
  });
});
