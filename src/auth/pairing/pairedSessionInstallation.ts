/** Freeze device sign-in authority before the provider can issue a replacement. */
import { readdirSync } from 'fs';
import { join } from 'path';
import { getGlobalCapyDir } from '../../config/globalConfig';
import type { SessionStore } from '../../types/index';
import { refreshTokenAuthorityDigest } from '../initRunSessionInstaller';
import { FileSessionStorageBackend } from '../session/fileBackend';

export interface PairedSessionInstallationBaseline {
  readonly expectedUserId: string | null;
  readonly authorities: readonly Readonly<{ userId: string; refreshAuthoritySha256: string | null; unavailable?: true }>[];
}

const refuse = (): never => { throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE'); };
const validUser = (userId: string): boolean => /^user_[A-Za-z0-9_-]+$/u.test(userId);

function existingSessionSubjects(): readonly string[] {
  const names = (() => {
    try { return readdirSync(join(getGlobalCapyDir(), 'auth', 'sessions')); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      return refuse();
    }
  })();
  return [...new Set(names.flatMap((name) => {
    const suffix = name.endsWith('.json.refresh-in-flight') ? '.json.refresh-in-flight'
      : name.endsWith('.json') ? '.json' : null;
    if (suffix === null) return [];
    const userId = name.slice(0, -suffix.length);
    if (!validUser(userId)) return refuse();
    return [userId];
  }))];
}

export function capturePairedSessionInstallationBaseline(
  expectedUserId: string | null = null,
): PairedSessionInstallationBaseline {
  try {
    const backend = new FileSessionStorageBackend();
    // A legacy session is an identity constraint, never a substitute for the
    // authority stored at the eventual per-user destination.
    const legacy = backend.load(undefined);
    if (legacy && (!validUser(legacy.user_id)
      || (expectedUserId !== null && legacy.user_id !== expectedUserId))) return refuse();
    const subject = expectedUserId ?? legacy?.user_id ?? null;
    if (subject !== null && !validUser(subject)) return refuse();
    const subjects = [...new Set([...existingSessionSubjects(), ...(subject === null ? [] : [subject])])];
    const authorities = subjects.map((userId) => {
      // Preserve unreadable authority per account rather than blocking unrelated accounts.
      try {
        const session = backend.load(userId);
        if (session && (session.user_id !== userId || !session.refresh_token)) return refuse();
        return { userId, refreshAuthoritySha256: refreshTokenAuthorityDigest(session) };
      } catch {
        // An unrelated account's unresolved refresh cannot block fresh pairing.
        // Retain the fence: installing into THIS account must still fail closed.
        return { userId, refreshAuthoritySha256: null, unavailable: true as const };
      }
    });
    return { expectedUserId: subject, authorities };
  } catch { return refuse(); }
}

export async function installDeviceAuthenticatedSession(
  session: SessionStore,
  baseline?: PairedSessionInstallationBaseline,
): Promise<void> {
  try {
    if (!validUser(session.user_id) || !session.refresh_token
      || (baseline?.expectedUserId != null && baseline.expectedUserId !== session.user_id)) return refuse();
    // A caller without a pre-provider baseline may only install into an empty
    // destination. It cannot replace authority learned after authentication.
    const authority = baseline?.authorities.find(({ userId }) => userId === session.user_id);
    if (authority?.unavailable) return refuse();
    const expected = authority?.refreshAuthoritySha256 ?? null;
    const backend = new FileSessionStorageBackend();
    await backend.withVerifiedAuthInstallation(session.user_id, expected, async () => {
      backend.save(session, session.user_id);
    });
  } catch { return refuse(); }
}
