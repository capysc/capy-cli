import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { buildCliHelpDoc, DRY_RUN_COMMANDS } from '../../src/core/cliHelpDoc';
import { PROJECT_RENAME_PATTERN_SOURCE, renameNameProblem } from '../../src/core/projectRenameRule';
import { projectNameProblem } from '../../src/core/projectNameRule';
import { DISCOVERY_PROJECT_NAME_MAX_LENGTH } from '../../src/commands/connectors/dokployDiscovery';

describe('renameNameProblem', () => {
  it('accepts every name the hand-typed rule accepts', () => {
    for (const name of ['web', 'My_App-2', 'a', '0']) {
      expect(projectNameProblem(name)).toBeNull();
      expect(renameNameProblem(name)).toBeNull();
    }
  });

  it('accepts the monorepo form, one or more segments', () => {
    for (const name of ['slidespeak-monorepo/backend', 'slidespeak-monorepo/backend/deployment', 'repo/my_folder-2']) {
      expect(renameNameProblem(name)).toBeNull();
    }
  });

  it('the hand-typed rule itself still refuses `/` (it is unchanged)', () => {
    expect(projectNameProblem('slidespeak-monorepo/backend')?.code).toBe('PROJECT_NAME_INVALID');
  });

  it('refuses a bad segment with the segment rule\'s code', () => {
    expect(renameNameProblem('repo/bad segment')?.code).toBe('PROJECT_NAME_INVALID');
    expect(renameNameProblem('repo/back.end')?.code).toBe('PROJECT_NAME_INVALID');
    expect(renameNameProblem('repo//x')?.code).toBe('PROJECT_NAME_INVALID');
    expect(renameNameProblem('/x')?.code).toBe('PROJECT_NAME_INVALID');
    expect(renameNameProblem('x/')?.code).toBe('PROJECT_NAME_INVALID');
    expect(renameNameProblem('')?.code).toBe('PROJECT_NAME_INVALID');
  });

  it('refuses the reserved name, alone or as a segment', () => {
    expect(renameNameProblem('_system')?.code).toBe('PROJECT_NAME_RESERVED');
    expect(renameNameProblem('repo/_system')?.code).toBe('PROJECT_NAME_RESERVED');
  });

  it('refuses a name over the discovery cap, and accepts one exactly at it', () => {
    expect(renameNameProblem('a'.repeat(DISCOVERY_PROJECT_NAME_MAX_LENGTH + 1))?.code).toBe('PROJECT_NAME_INVALID');
    expect(renameNameProblem(`repo/${'a'.repeat(DISCOVERY_PROJECT_NAME_MAX_LENGTH - 5)}`)).toBeNull();
    expect(renameNameProblem(`repo/${'a'.repeat(DISCOVERY_PROJECT_NAME_MAX_LENGTH - 4)}`)?.code).toBe('PROJECT_NAME_INVALID');
  });

  it('the pattern for JSON matches the allowed forms and nothing else of the kinds above', () => {
    const re = new RegExp(PROJECT_RENAME_PATTERN_SOURCE);
    expect(['web', 'a/b', 'a/b/c', 'a_b/c-d'].every((n) => re.test(n))).toBe(true);
    expect(['', '/a', 'a/', 'a//b', 'a b', 'a/b c'].some((n) => re.test(n))).toBe(false);
  });
});

describe('`capy projects rename` in the help document', () => {
  const flatten = (commands: ReadonlyArray<{ readonly subcommands?: unknown }>): ReadonlyArray<any> =>
    commands.flatMap((c) => [c, ...flatten((c.subcommands ?? []) as ReadonlyArray<{ readonly subcommands?: unknown }>)]);

  it('is listed as honoring --dry-run, and `projects` itself is not', () => {
    const program = new Command();
    program.name('capy');
    const projects = program.command('projects').description('List projects');
    projects.command('rename [new-name]').description('Rename');

    const commands = flatten(buildCliHelpDoc(program).commands as ReadonlyArray<{ readonly subcommands?: unknown }>);

    expect(commands.find((c) => c.path === 'projects rename')?.supportsDryRun).toBe(true);
    expect(commands.find((c) => c.path === 'projects')?.supportsDryRun).toBe(false);
    expect(DRY_RUN_COMMANDS.has('projects rename')).toBe(true);
  });

  it('the generated reference says rename has a dry run', () => {
    const reference = readFileSync(join(import.meta.dir, '../../docs/cli-reference.md'), 'utf-8');
    const section = reference.split('### `capy projects rename`')[1]?.split('\n## ')[0] ?? '';

    expect(section).toContain('Dry run: yes (`--dry-run`)');
  });
});
