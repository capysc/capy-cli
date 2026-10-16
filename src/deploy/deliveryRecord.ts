/**
 * What a `capy deploy` delivery looks like as a keep.lock record, and how it is
 * recorded on the Capy SERVER.
 *
 * `recordDeliveriesOnServer` builds the pushed keep from the SERVER's own keep,
 * never from a local keep.lock. A local copy can lag the server (another
 * target's CI record, or a record a teammate's deploy added, may not be in it
 * yet), and a keep pushed from it would erase those records. The branch's blob
 * is re-sent byte for byte, so nothing about a secret value can change here.
 *
 * Shared by `capy deploy` (CI mode) and the repo-free batch deploy
 * (`batchDeploy.ts`). Never carries a value: names, hashes and codes only.
 */
import type { DeployAdapter, TargetConfig } from './adapter';
import { TargetDeliveryDescriptor, VarDelivery, recordTargetDeliveries } from './targetsGate';
import { uploadKeepOnly } from '../sync/commit';
import type { RateInfo } from '../utils/pool';

/**
 * Adapter-specific handle for what a target actually points at, when one is
 * knowable from `target.options` alone. Only Dokploy defines this today
 * (`composeId` / `applicationId`); every other adapter gets `undefined` —
 * there is no spec'd `ref` shape for them yet.
 */
export function targetRefFor(target: TargetConfig): Record<string, string> | undefined {
  const opts = target.options as Record<string, unknown>;
  if (typeof opts.composeId === 'string') return { composeId: opts.composeId };
  if (typeof opts.applicationId === 'string') return { applicationId: opts.applicationId };
  return undefined;
}

/**
 * The delivery descriptor + delivered-values pair shared by every "record
 * this target's delivery" caller (direct mode, CI mode, the batch deploy, and
 * the PR's own keep.lock content) — same shape, same `noDeploy` →
 * `deployed: false` rule (CAP-679 follow-up, "pending"; see
 * `targetsGate.ts#upsertTargetElement`'s doc for why absent/false OMITS the
 * field instead of writing `deployed: true`).
 */
export function deliveryFor(
  target: TargetConfig,
  adapter: Pick<DeployAdapter, 'id'>,
  deployId: string | undefined,
  noDeploy: boolean,
  valueHashes: Record<string, string>,
): { delivery: TargetDeliveryDescriptor; values: readonly VarDelivery[] } {
  const delivery: TargetDeliveryDescriptor = {
    provider: adapter.id,
    target: target.name,
    ref: targetRefFor(target),
    deployId,
    ...(noDeploy ? { deployed: false } : {}),
  };
  const values = target.vars
    .filter((v) => valueHashes[v] !== undefined)
    .map((v) => ({ name: v, valueHash: valueHashes[v] }));
  return { delivery, values };
}

/** What the recorder needs from the service client. */
export interface RecordClient {
  getLatestSecrets(projectId: string, branch: string): Promise<{ env_file: string; keep_hash: string; keep_file?: string } | null>;
  pushSecrets(
    projectId: string,
    keepFile: string,
    envBlob: string,
    branch: string,
    onRateLimit?: (rate: RateInfo) => void,
    /** The branch hash of the keep this push was built from; the server refuses (SECRETS_STALE_BASE) when it is no longer the latest. */
    baseKeepHash?: string,
  ): Promise<unknown>;
}

export type RecordResult =
  | { readonly ok: true; /** `false`: every delivery was already recorded, so nothing was pushed. */ readonly pushed: boolean }
  | { readonly ok: false; readonly code: string };

type Deliveries = ReadonlyArray<{
  readonly delivery: TargetDeliveryDescriptor;
  readonly values: readonly VarDelivery[];
  /** ISO time the values reached the platform. */
  readonly deliveredAt: string;
}>;

/**
 * Fetches the server's keep for (project, branch), applies every delivery in
 * `deliveries` to it, and pushes the result back server-only with the blob
 * unchanged. Nothing is pushed when every delivery is already recorded. This is
 * the shared keep-only upload (`uploadKeepOnly`, sync/commit.ts): the push names
 * the keep it was built from (`base_keep_hash`), and if the server says it is no
 * longer the latest (`SECRETS_STALE_BASE`) the keep is read and built once more.
 * Never throws; a failure is a code.
 *
 * Two callers must not run this for the SAME (project, branch) at once: each
 * would read the same keep and the later push would drop the earlier record.
 * Put every delivery of one (project, branch) in one call instead.
 */
export async function recordDeliveriesOnServer(client: RecordClient, projectId: string, branch: string, deliveries: Deliveries): Promise<RecordResult> {
  const done = await uploadKeepOnly(client, projectId, branch, (keep) =>
    deliveries.reduce(
      (acc, d) => (d.values.length === 0 ? acc : recordTargetDeliveries(acc, branch, d.delivery, d.deliveredAt, d.values)),
      keep,
    ),
  );
  return done.ok ? { ok: true, pushed: done.pushed } : done;
}
