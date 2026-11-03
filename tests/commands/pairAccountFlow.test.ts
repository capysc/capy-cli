import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { confirmPairAccount } from '../../src/commands/pairAccountConfirmation';
import { createJsonLineInteraction, runWithInteraction } from '../../src/ui/interaction';

test('host account confirmation requires the human answer and defaults to refusal', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  const events = lines[Symbol.asyncIterator]();
  try {
    const confirmation = runWithInteraction(createJsonLineInteraction(input, output, controller.signal),
      () => confirmPairAccount('synthetic@example.invalid', true));
    const next = await events.next();
    const prompt = JSON.parse(next.value!);
    expect(prompt.type).toBe('prompt');
    expect(prompt.question.text).toBe('Enable this location as synthetic@example.invalid?');
    expect(prompt.question.input.default).toBe(false);
    input.write(`${JSON.stringify({ type: 'answer', id: prompt.id, payload: { value: false } })}\n`);
    expect(await confirmation).toBe(false);
  } finally { controller.abort(); input.end(); output.end(); lines.close(); }
});

test('a synthetic explicit yes is delivered to the pairing command without a terminal prompt', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  const events = lines[Symbol.asyncIterator]();
  try {
    const confirmation = runWithInteraction(createJsonLineInteraction(input, output, controller.signal),
      () => confirmPairAccount('synthetic@example.invalid', true));
    const prompt = JSON.parse((await events.next()).value!);
    input.write(`${JSON.stringify({ type: 'answer', id: prompt.id, payload: { value: true } })}\n`);
    expect(await confirmation).toBe(true);
  } finally { controller.abort(); input.end(); output.end(); lines.close(); }
});
