import { expect, test, mock } from 'bun:test';
import { keepOrigin } from '../../src/ui/screens/keepScreens';
import { quotaBillingUrl, requestQuotaUpgrade } from '../../src/ui/quotaUpgrade';
import { runWithInteraction, type InteractionQuestion } from '../../src/ui/interaction';
const quota = { kind: 'project', error: 'Upgrade required', upgrade_url: `${keepOrigin()}/billing?organization=org-one` };

test('only actual subscription limits receive a canonical billing link', () => {
  expect(quotaBillingUrl(quota)).toBe(quota.upgrade_url);
  expect(quotaBillingUrl({ ...quota, kind: 'organization' })).toBeNull();
  expect(quotaBillingUrl({ ...quota, upgrade_url: 'https://untrusted.invalid/billing?organization=org-one' })).toBeNull();
  expect(quotaBillingUrl({ ...quota, upgrade_url: `${keepOrigin()}/billing` })).toBeNull();
});

test('payment stays a question in the current operation, not a terminal outcome', async () => {
  const terminal = mock(() => undefined);
  const question = mock(async <T>(value: InteractionQuestion<T>) => {
    expect(value.view).toMatchObject({ billingUrl: quota.upgrade_url, input: { kind: 'confirm', approveLabel: 'Check payment and continue' } });
    const answer = value.decide({ value: true });
    return 'value' in answer ? answer.value : null;
  });
  expect(await runWithInteraction({ output: () => undefined, progress: () => undefined, goal: terminal, prompt: question }, () => requestQuotaUpgrade(quota))).toBe(true);
  expect(terminal).not.toHaveBeenCalled();
});

test('cancel and noninteractive callers do not retry', async () => {
  expect(await requestQuotaUpgrade(quota)).toBe(false);
  expect(await runWithInteraction({ output: () => undefined, progress: () => undefined, goal: () => undefined, prompt: async () => null }, () => requestQuotaUpgrade(quota))).toBe(false);
});
