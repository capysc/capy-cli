import { describe, it, expect, spyOn } from 'bun:test';
import { answerLine, commandLine, folderWords, refusePick, confirmFromTerminalMessage, needsHumanYes, prFlagWords, rerunWith } from '../../src/commands/agentConfirm';

describe('agentConfirm (CAP-909)', () => {
  it('rerunWith repeats the typed command, sets each flag once, and ends with --json', () => {
    expect(rerunWith(false, [['--yes']], ['connect', 'vercel', '--overwrite', '--json'])).toBe('capy connect vercel --overwrite --yes --json');
    expect(rerunWith(true, [['--yes']], ['connect', 'dokploy', '--discover', '--yes', '--non-tty'])).toBe('capy-dev connect dokploy --discover --yes --json');
    expect(rerunWith(false, [['--confirm', 'p2']], ['secrets', 'set', 'X', '--confirm', 'p1'])).toBe('capy secrets set X --confirm p2 --json');
  });

  it('commandLine quotes words the shell would split', () => {
    expect(commandLine(false, ['remove', 'A B', "it's"])).toBe("capy remove 'A B' 'it'\\''s'");
  });

  it('confirmFromTerminalMessage: the first line is the question, each other line one row', () => {
    const e = confirmFromTerminalMessage('Overwrite local vars to match Vercel exactly?\n  Import (1): A\n  Clear (1): B', false, { import: ['A'], clear: ['B'] });
    expect(e.question).toBe('Overwrite local vars to match Vercel exactly?');
    expect(e.display).toContain('| 1 | Import (1): A |');
    expect(e.display).toContain('| 2 | Clear (1): B |');
    expect(e.answer.yes.endsWith('--yes --json')).toBe(true);
  });

  it('the message never names the flag that answers it', () => {
    expect(needsHumanYes('capy remove')).not.toContain('--yes');
  });

  it('prFlagWords repeats the keep.lock PR flags as typed', () => {
    expect(prFlagWords({ noPr: true })).toEqual(['--no-pr']);
    expect(prFlagWords({ pr: true, prBase: 'main' })).toEqual(['--pr', '--pr-base', 'main']);
    expect(prFlagWords(undefined)).toEqual([]);
  });

  it('answerLine repeats the typed --folder, so the yes acts on the same project', () => {
    expect(answerLine(false, ['branch', '-D', 'staging', '--yes', '--json'], ['--folder', 'apps/api', 'branch', '-D', 'staging'])).toBe('capy --folder apps/api branch -D staging --yes --json');
    expect(answerLine(true, ['system', 'rm', 'K', '--yes', '--json'], ['system', 'rm', 'K', '--folder=projA'])).toBe('capy-dev --folder projA system rm K --yes --json');
    expect(answerLine(false, ['remove', 'X', '--yes', '--json'], ['remove', 'X'])).toBe('capy remove X --yes --json');
    expect(folderWords(['remove', 'X', '--folder'])).toEqual([]);
  });

  it('refusePick prints a coded JSON refusal with a one-field form and exits 3; unsafe choices are left out', () => {
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation(((l: unknown) => { lines.push(String(l)); }) as never);
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
    const argv = process.argv;
    process.argv = ['node', 'capy', '--folder', 'apps/api', 'rotate', '--non-tty'];
    try {
      expect(() => refusePick({
        code: 'ROTATE_VARIABLE_REQUIRED',
        command: 'capy rotate',
        lead: 'No variable was named.',
        field: { name: 'variable', question: 'Which variable to rotate:', options: [{ value: 'A_KEY', label: 'A_KEY' }, { value: 'B; rm', label: 'B; rm' }] },
        rows: [['Branch', 'development']],
        details: { branch: 'development' },
        add: '<variable>',
        devMode: false,
        tail: '--non-tty',
      })).toThrow('exit 3');
    } finally {
      process.argv = argv;
      log.mockRestore();
      exit.mockRestore();
    }
    const body = JSON.parse(lines[0]);
    expect(body.code).toBe('ROTATE_VARIABLE_REQUIRED');
    expect(body.error).not.toContain('--');
    expect(body.elicitation.fields[0].question).toBe('Which variable to rotate:');
    expect(body.elicitation.fields[0].options).toEqual([{ value: 'A_KEY', label: 'A_KEY' }]);
    expect(body.elicitation.answer.rerun).toBe('capy --folder apps/api rotate <variable> --non-tty');
  });
});
