import { describe, it, expect } from 'bun:test';
import { commandLine, confirmFromTerminalMessage, needsHumanYes, prFlagWords, rerunWith } from '../../src/commands/agentConfirm';

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
});
