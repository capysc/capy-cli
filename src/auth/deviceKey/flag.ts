/**
 * The device-key wiring fork (CAP-382) — permanently ON.
 *
 * This began as the rollout flag `CAPY_DEVICE_KEYS=1`, letting the
 * device-key rail (pair, device-key grant, `capy run`'s grant consumption,
 * and the onboarding forks in init / redeem / recover) land incrementally
 * without exposing a half-built custody path in released builds. As of
 * onboarding v2 (2026-08-30, Vince's ruling) the rail IS the product —
 * `capy pair` is the only pairing path — so the fork is on no matter what:
 * the env var is no longer consulted anywhere. The function remains so the
 * many call sites read as the deliberate fork points they are; deleting the
 * gates outright is follow-up cleanup, not behavior.
 */
export function deviceKeysEnabled(): boolean {
  return true;
}
