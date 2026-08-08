/**
 * The device-key wiring fork (CAP-382).
 *
 * `CAPY_DEVICE_KEYS=1` wires CAP-380's onboarding fork (detection + case
 * engines) and CAP-382's broker-backed ceremony transport into the real
 * `capy` init / `capy redeem` / `capy recover` command paths. Everything
 * else about those flows is unchanged, and with the flag unset (the
 * default) their behavior is byte-identical to before this fork existed —
 * the flag stays off until it is deliberately flipped. Same pattern and
 * standing as `CAPY_KEEP_SCREENS` (`../../ui/screens/keepScreens.ts`).
 */
export function deviceKeysEnabled(): boolean {
  return process.env.CAPY_DEVICE_KEYS === '1';
}
