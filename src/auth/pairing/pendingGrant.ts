/**
 * The pending `capy pair` grant of agent mode (`pairAgentCommand.ts`).
 *
 * The start run saves one of these and exits; `capy pair --wait` reads it back. It holds what the wait run needs and
 * nothing it could misuse: the device code, the one-time pair key pair (needed to open the sealed payload), the short
 * code and link, who is expected to approve, the options that shaped the run, and the grant's expiry and interval.
 * NEVER a session token. The file is mode 0600 under the global config dir (`getPairPendingPath`), so `capy-dev` and
 * `capy-staging` keep their own.
 *
 * It is removed: by `capy pair --wait` the moment an approval is seen (before the account check, so on success and on
 * mismatch alike), on expiry and on denial; by `capy pair --cancel`; by any agent-mode `capy pair` run other than
 * `--wait` once the grant has expired (`sweepExpiredPendingPairGrant`); when it is read and cannot be parsed; and when
 * a new start run replaces it. A poll error keeps it.
 *
 * The grant also names the temporary QR PNG made for its link (`qrFile`, absent in a file written before it existed).
 * That PNG is removed everywhere the grant is, and when a new start run replaces the grant. Removing it is best effort
 * (`removePairingQrImage` never throws, and only touches its own file in the OS temp directory), and the pending file is
 * deleted whether or not the PNG could be. A file that is already gone is not an error.
 *
 * Nothing here logs or prints the file's contents.
 */
import { deletePairPending, readPairPendingRaw, savePairPendingRaw } from '../../config/globalConfig';
import { exportPairKeyPair, importPairKeyPair, type PairKeyPair } from '../../crypto/pairCrypto';
import { removePairingQrImage } from '../../ui/pairingPresentation';

export interface PendingPairGrant {
  readonly deviceCode: string;
  readonly keyPair: PairKeyPair;
  readonly userCode: string;
  readonly deviceLink: string;
  /** Already trimmed and lower-cased. */
  readonly expectedEmail: string;
  readonly force: boolean;
  readonly apiUrl: string;
  /** What the human is told the pairing is for (display only). */
  readonly purpose: string;
  /** ISO time the grant expires. */
  readonly expiresAt: string;
  readonly intervalSeconds: number;
  /** Earliest time (ms since the epoch) the next poll may be sent, so a later wait run never polls before the interval is up. The start run sets it to the authorize time plus one interval. Absent in a file written by an earlier build, which polls at once. */
  readonly nextPollAt?: number;
  /** Path of the QR PNG made for `deviceLink`. Absent when none was made. It encodes the link only. */
  readonly qrFile?: string;
}

const FILE_VERSION = 1;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The file is ours, but it is read back from disk: every field is checked, and a file that fails is treated as absent. */
function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The QR PNG path a raw pending file names, even when the file is not a readable grant. */
function qrFileIn(raw: string): string | undefined {
  return str(parseObject(raw)?.qr_file);
}

function parsePending(raw: string): PendingPairGrant | null {
  const data = parseObject(raw);
  if (!data || data.v !== FILE_VERSION) return null;
  const deviceCode = str(data.device_code);
  const privateKey = str(data.pair_private_key);
  const publicKey = str(data.pair_public_key);
  const userCode = str(data.user_code);
  const deviceLink = str(data.device_link);
  const apiUrl = str(data.api_url);
  const purpose = str(data.purpose);
  const expiresAt = str(data.expires_at);
  const interval = data.interval_seconds;
  const expectedEmail = str(data.expected_email);
  const qrFile = str(data.qr_file);
  const nextPollAt = typeof data.next_poll_at === 'number' && Number.isFinite(data.next_poll_at) ? data.next_poll_at : undefined;
  if (!deviceCode || !privateKey || !publicKey || !userCode || !deviceLink || !apiUrl || !purpose || !expiresAt) return null;
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) return null;
  if (Number.isNaN(Date.parse(expiresAt))) return null;
  if (!expectedEmail) return null;
  const keyPair = (() => {
    try {
      return importPairKeyPair({ privateKey, publicKey });
    } catch {
      return null;
    }
  })();
  if (!keyPair) return null;
  return {
    deviceCode,
    keyPair,
    userCode,
    deviceLink,
    expectedEmail,
    force: data.force === true,
    apiUrl,
    purpose,
    expiresAt,
    intervalSeconds: interval,
    ...(nextPollAt !== undefined ? { nextPollAt } : {}),
    ...(qrFile !== undefined ? { qrFile } : {}),
  };
}

/** Saves the grant (mode 0600), replacing any pending one. */
export function savePendingPairGrant(grant: PendingPairGrant): void {
  const key = exportPairKeyPair(grant.keyPair);
  savePairPendingRaw(JSON.stringify({
    v: FILE_VERSION,
    device_code: grant.deviceCode,
    pair_private_key: key.privateKey,
    pair_public_key: key.publicKey,
    user_code: grant.userCode,
    device_link: grant.deviceLink,
    expected_email: grant.expectedEmail,
    force: grant.force,
    api_url: grant.apiUrl,
    purpose: grant.purpose,
    expires_at: grant.expiresAt,
    interval_seconds: grant.intervalSeconds,
    ...(grant.nextPollAt !== undefined ? { next_poll_at: grant.nextPollAt } : {}),
    ...(grant.qrFile !== undefined ? { qr_file: grant.qrFile } : {}),
  }));
}

/** The pending grant, or null when there is none or the file cannot be read as one (an unreadable file is removed). */
export function readPendingPairGrant(): PendingPairGrant | null {
  const raw = readPairPendingRaw();
  if (raw === null) return null;
  const grant = parsePending(raw);
  if (!grant) {
    const qrFile = qrFileIn(raw);
    if (qrFile !== undefined) removePairingQrImage(qrFile);
    deletePairPending();
  }
  return grant;
}

/** Removes the pending grant. Returns whether there was one. */
export function removePendingPairGrant(): boolean {
  const raw = readPairPendingRaw();
  const qrFile = raw === null ? undefined : qrFileIn(raw);
  if (qrFile !== undefined) removePairingQrImage(qrFile);
  deletePairPending();
  return raw !== null;
}

/** Removes the pending grant when its expiry has passed (or it cannot be read). Returns whether one was removed. */
export function sweepExpiredPendingPairGrant(nowMs: number): boolean {
  const grant = readPendingPairGrant();
  if (!grant || nowMs < Date.parse(grant.expiresAt)) return false;
  if (grant.qrFile !== undefined) removePairingQrImage(grant.qrFile);
  deletePairPending();
  return true;
}
