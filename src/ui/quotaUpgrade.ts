import { askInteraction } from './interaction';
import { keepOrigin } from './screens/keepScreens';

type Quota = Readonly<Record<string, unknown>>;

/** Only actual subscription limits can offer checkout. The organization cap cannot. */
export function quotaBillingUrl(quota: Quota): string | null {
  if (quota.kind !== 'project' && quota.kind !== 'member') return null;
  if (typeof quota.upgrade_url !== 'string') return null;
  try {
    const url = new URL(quota.upgrade_url);
    return url.protocol === 'https:' && url.origin === new URL(keepOrigin()).origin
      && url.pathname === '/billing' && !url.username && !url.password
      && !!url.searchParams.get('organization') ? url.href : null;
  } catch { return null; }
}

/** Pause the existing operation. A click retries the service's authoritative quota check. */
export async function requestQuotaUpgrade(quota: Quota): Promise<boolean> {
  const billingUrl = quotaBillingUrl(quota);
  if (!billingUrl) return false;
  const answer = askInteraction<boolean>({
    view: {
      text: `${typeof quota.error === 'string' ? quota.error : 'An upgrade is required.'} Complete payment in the new tab, then check payment to continue here.`,
      billingUrl,
      input: { kind: 'confirm', default: true, approveLabel: 'Check payment and continue', declineLabel: 'Cancel' },
    },
    decide: payload => typeof payload.value === 'boolean'
      ? { value: payload.value } : { error: 'Choose whether to check payment and continue.' },
  });
  return answer ? (await answer) === true : false;
}
