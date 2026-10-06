/**
 * Recording a delivery on the Capy server (src/deploy/deliveryRecord.ts): the pushed keep is the
 * SERVER's keep with the delivery applied, the blob is re-sent unchanged, and a delivery that is
 * already recorded pushes nothing. Fakes only.
 */
import { describe, test, expect, mock } from 'bun:test';
import { recordDeliveriesOnServer, deliveryFor } from '../../src/deploy/deliveryRecord';
import { CapyError, ERROR_CODES, KeepFile } from '../../src/types/index';
import { dokployTarget, hashOf, serverKeepFor } from '../helpers/batchDeployWorld';

const AT = '2026-10-04T10:00:00.000Z';
const { delivery, values } = deliveryFor(dokployTarget('api', { vars: ['API_KEY'] }), { id: 'dokploy' }, undefined, false, { API_KEY: hashOf('API_KEY') });

function client(keepFile: string | undefined, opts: { pushFails?: boolean; none?: boolean } = {}) {
  const getLatestSecrets = mock(async () => (opts.none ? null : { env_file: 'BLOB-AS-STORED', keep_hash: 'h', ...(keepFile === undefined ? {} : { keep_file: keepFile }) }));
  const pushSecrets = mock(async (..._a: unknown[]) => {
    if (opts.pushFails) throw new CapyError('no', ERROR_CODES.SERVICE_ERROR);
    return {};
  });
  return { getLatestSecrets, pushSecrets };
}

describe('recordDeliveriesOnServer', () => {
  test('builds from the server keep (another target\'s record is kept) and re-sends the stored blob unchanged', async () => {
    const c = client(JSON.stringify(serverKeepFor('pA', 'production')));
    const out = await recordDeliveriesOnServer(c, 'pA', 'production', [{ delivery, values, deliveredAt: AT }]);
    expect(out).toEqual({ ok: true, pushed: true });
    const [project, keepJson, blob, branch] = c.pushSecrets.mock.calls[0];
    expect([project, blob, branch]).toEqual(['pA', 'BLOB-AS-STORED', 'production']);
    const targets = (JSON.parse(String(keepJson)) as KeepFile).variables.API_KEY[0].targets as Array<{ target: string }>;
    expect(targets.map((t) => t.target).toSorted()).toEqual(['api', 'legacy']);
  });

  test('a delivery that is already recorded pushes nothing', async () => {
    const first = client(JSON.stringify(serverKeepFor('pA', 'staging')));
    await recordDeliveriesOnServer(first, 'pA', 'staging', [{ delivery, values, deliveredAt: AT }]);
    const recorded = String(first.pushSecrets.mock.calls[0][1]);
    const again = client(recorded);
    expect(await recordDeliveriesOnServer(again, 'pA', 'staging', [{ delivery, values, deliveredAt: '2027-01-01T00:00:00.000Z' }])).toEqual({ ok: true, pushed: false });
    expect(again.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('no server keep is a code, and nothing is pushed', async () => {
    for (const c of [client(undefined), client('not json'), client(undefined, { none: true })]) {
      expect(await recordDeliveriesOnServer(c, 'pA', 'production', [{ delivery, values, deliveredAt: AT }])).toEqual({ ok: false, code: ERROR_CODES.NO_KEEP_FILE });
      expect(c.pushSecrets.mock.calls).toHaveLength(0);
    }
  });

  test('a refused push is a code, never a throw', async () => {
    const c = client(JSON.stringify(serverKeepFor('pA', 'production')), { pushFails: true });
    expect(await recordDeliveriesOnServer(c, 'pA', 'production', [{ delivery, values, deliveredAt: AT }])).toEqual({ ok: false, code: ERROR_CODES.SERVICE_ERROR });
  });
});
