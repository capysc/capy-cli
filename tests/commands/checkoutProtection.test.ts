import { describe, it, expect } from 'bun:test';
import { OPEN_FLAG, PROTECT_FLAG, protectQuestion, protectionElicitation, protectionRefusal } from '../../src/commands/checkoutProtection';

describe('capy checkout -b with nobody to ask (CAP-909)', () => {
  it('asks the terminal question as a form whose values are the two flags', () => {
    const e = protectionElicitation('feat', false);
    expect(e.kind).toBe('form');
    expect(e.question).toBe(protectQuestion('feat'));
    expect(e.fields).toHaveLength(1);
    const field = e.fields[0];
    expect(field.options?.map((o) => o.value)).toEqual([PROTECT_FLAG, OPEN_FLAG]);
    // No default: a choice with options is offered as its labels, so nobody is shown a raw flag.
    expect(field.default).toBeUndefined();
    expect(new RegExp(field.pattern).test(PROTECT_FLAG)).toBe(true);
    expect(new RegExp(field.pattern).test('yes')).toBe(false);
    expect(e.answer.rerun).toBe('capy checkout feat -b <protected> --non-tty');
  });

  it('quotes a branch name the shell would split, and names capy-dev in dev mode', () => {
    expect(protectionElicitation("it's mine", true).answer.rerun).toBe("capy-dev checkout 'it'\\''s mine' -b <protected> --non-tty");
  });

  it('the refusal keeps the route and adds the code and the elicitation', () => {
    const r = protectionRefusal('feat', false, { stops: [], unanswered: ['protection'] });
    expect(r).toMatchObject({ ok: false, code: 'BRANCH_PROTECTION_REQUIRED', stops: [], unanswered: ['protection'] });
    expect(String(r.error)).not.toContain('--yes');
  });
});

describe('the --non-tty stop', () => {
  it('points at the --json run that carries the question, not at a flag to pick', async () => {
    const { protectionNeedsFlagMessage } = await import('../../src/commands/checkoutProtection');
    const msg = protectionNeedsFlagMessage('feat');
    expect(msg).toContain('capy checkout feat -b --json');
    expect(msg).not.toContain('--no-protected');
  });
});
