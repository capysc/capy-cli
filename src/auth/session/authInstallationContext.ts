import { AsyncLocalStorage } from 'async_hooks';

type InstallationOutcome = Readonly<{ ok: true }> | Readonly<{ ok: false }>;

export type VerifiedAuthInstallationContext = Readonly<{
  userId: string;
  expectedRefreshAuthoritySha256: string | null;
  settle: (outcome: InstallationOutcome) => void;
}>;

const verifiedAuthInstallationContext = new AsyncLocalStorage<VerifiedAuthInstallationContext>();

export const currentVerifiedAuthInstallationContext = (): VerifiedAuthInstallationContext | undefined =>
  verifiedAuthInstallationContext.getStore();

export const runWithVerifiedAuthInstallation = async <T>(input: Readonly<{
  userId: string;
  expectedRefreshAuthoritySha256: string | null;
  run: () => Promise<T>;
}>): Promise<T> => {
  const completion = Promise.withResolvers<InstallationOutcome>();
  const value = await verifiedAuthInstallationContext.run({
    userId: input.userId,
    expectedRefreshAuthoritySha256: input.expectedRefreshAuthoritySha256,
    settle: completion.resolve,
  }, input.run);
  const outcome = await Promise.race([
    completion.promise,
    Promise.resolve({ ok: false } as const),
  ]);
  if (!outcome.ok) throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
  return value;
};
