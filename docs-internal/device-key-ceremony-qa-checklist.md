# Device-key ceremony QA checklist (manual, per-release)

CAP-383 item 5. Real WebAuthn hardware — a genuine platform authenticator
prompt, a real Google Password Manager passkey, a real phone doing hybrid
transport — cannot be automated in this repo's test suite or any CI runner:
the RP ID is pinned to `keep.capy.sc` permanently (`keep-app/src/lib/security/rp.ts`,
no env override reaches production — invariant 6), so the live ceremony
**only runs on `https://keep.capy.sc`**. `next dev`/localhost throws
`SecurityError` and is coded `webauthn_unavailable` by design (see
`keep-app/docs/flows.md`, "What is testable where"). Everything around the
ceremony (envelope crypto, KEK isolation, wire parsing, every UI state) is
already pinned by automated tests without a browser — this checklist covers
only what genuinely needs a human, real hardware, and the real deployed
origin.

**Run this before every release that touches** `src/auth/deviceKey/`,
`keep-app/src/lib/webauthn/`, `keep-app/src/app/flow/device-key/`, or
`packages/ui/screens/device-key`. Use a real `capy` build pointed at
`keep.capy.sc` (never `--dev`, never a local override of `CAPY_API_URL`
for the CLI side, unless the row explicitly says otherwise).

For every row: run the flow, watch the ceremony page AND the CLI terminal,
and record the CODED outcome — never paraphrase what the browser showed.
The coded vocabulary is fixed (`src/auth/deviceKey/ceremonyTransport.ts`):
`cancelled | no_credential | prf_unsupported | webauthn_unavailable | transport_error`
for a declined/failed ceremony; a success additionally reports
`backupEligible`/`backupState` (enroll) or just unlocks (unlock).

## Setup (once per test pass)

1. A real account with a verified email (unverified-email accounts are
   covered by the automated `EMAIL_NOT_VERIFIED` coded-rejection test —
   this checklist assumes a verified account throughout, since that's what
   real ceremonies need).
2. Three physical surfaces:
   - **A: Mac with Touch ID or an iPhone/iPad signed into the same iCloud
     account as B** (for Safari/iCloud Keychain passkeys).
   - **B: a machine running Chrome, signed into a Google account with
     Google Password Manager passkey sync enabled**.
   - **C: any machine's Chrome/Safari with NO passkey provider configured
     locally**, plus **a phone with a camera** (for hybrid/QR transport).
3. Know how to fully remove a passkey from each provider (iCloud Keychain
   settings, Google Password Manager passkeys page) — several rows below
   end by deleting the credential you just created, to leave the account
   ready for the next pass.

## Row 1 — Safari / iCloud Keychain (platform authenticator, synced)

| Step | Action | Expected coded outcome |
|---|---|---|
| 1.1 | On surface A, run `capy` as a brand-new user (no orgs). Let it create an org, reach the device-key ceremony. | Ceremony page opens in Safari at `https://keep.capy.sc/flow/device-key?c=...`. |
| 1.2 | Complete the Touch ID / Face ID prompt. | Enroll succeeds. CLI prints "Device key enrolled". `capy device-key list` shows one door, `backupEligible: true` (iCloud Keychain syncs). |
| 1.3 | On the SAME surface, run `capy device-key list --json`. | One row, `is_seed: true` or `verified_at` non-null. No ciphertext in the output (metadata-only — automated `deviceKeyCommand.test.ts` already pins this shape; confirm the real server response matches). |
| 1.4 | On surface A's OTHER device (the iPhone, same iCloud account, fresh `capy` install / fresh `~/.capy`), run `capy`. Reach the unlock ceremony. Approve with Face ID. | Unlock succeeds — this device is now provisioned. `capy run` in a project with a secret decrypts correctly (this is the CAP-372 headline: new surface, one gesture, under a minute — time it). |
| 1.5 | Decline the Face ID prompt (cancel) on a THIRD attempt. | CLI falls back to its existing "no encryption key on this device, run `capy redeem`" message — never a crash, never a hang past the ceremony's own timeout. |

## Row 2 — Chrome / Google Password Manager (platform authenticator, synced)

| Step | Action | Expected coded outcome |
|---|---|---|
| 2.1 | On surface B, an ALREADY-enrolled-elsewhere account (reuse Row 1's account, or a fresh one enrolled first on B itself), run `capy device-key enroll` explicitly (`CAPY_DEVICE_KEYS=1 capy device-key enroll` if the flag isn't already default). | If already enrolled: coded "already enrolled" message (`already_enrolled`), no ceremony offered. If first enrollment on this machine (Case B — existing user, existing machine): ceremony runs. |
| 2.2 | Complete the Chrome/GPM passkey creation prompt (may include a GPM PIN/biometric step depending on OS). | Enroll succeeds, `backupEligible: true` (GPM syncs). |
| 2.3 | On a SECOND machine with Chrome signed into the SAME Google account, run `capy` fresh. | Unlock ceremony offers the GPM passkey; approving completes Case C exactly like Row 1.4. |
| 2.4 | On surface B, run `capy device-key remove <id>` for the ONLY verified door on the account (skip if the account has ≥2 doors from earlier rows). | Coded refusal: 409 `WRAPPER_INVARIANT_VIOLATION`, CLI prints the "this is your only verified device key" message (never a raw HTTP error, never a stack trace) — confirms invariant 7 holds against the REAL server, not just the mocked one in `deviceKeyCommand.test.ts`. |

## Row 3 — Hybrid / QR (cross-device transport, phone as authenticator)

| Step | Action | Expected coded outcome |
|---|---|---|
| 3.1 | On surface C (no local passkey provider), run `capy` to reach the device-key ceremony (enroll or unlock, whichever this account's state routes to). | Chrome/Safari on C shows the "Use a phone" / QR option. |
| 3.2 | Scan the QR with the phone's camera app (NOT a passkey-manager app — this is the point of the hybrid-transport test: the phone is acting as a roaming/caBLE authenticator, not a synced platform one). Approve on the phone. | Ceremony completes — same coded success shape as Rows 1/2 from the CLI's perspective (C and C′ are indistinguishable to the CLI by design; see `src/auth/deviceKey/detect.ts`'s header comment). Confirm `backupEligible` reads however the phone's own authenticator reports it (varies by phone OS — record what you saw, this is informational, not a pass/fail). |
| 3.3 | Start the hybrid flow, then close the QR prompt on the phone without approving (or let it time out). | CLI's long-poll runs out cleanly into the pre-existing "no encryption key on this device, run `capy redeem`" fallback — same as Row 1.5, no special-cased hang. |

## Cross-cutting checks (run once, any row)

- **Seed-phrase nudge on a device-locked credential.** If any authenticator
  in your test pool reports `backupEligible: false` (rare on real hardware
  in 2026, but some enterprise-managed security keys still do), confirm
  the CLI's seed-phrase warning fires (`reportEnrollmentOutcome` in
  `src/auth/deviceKey/wiring.ts`) — this is the one CLI-observable behavior
  that depends on a REAL authenticator's actual backup posture rather than
  a scripted value, so a fake ceremony transport can never exercise it
  honestly.
- **Vocabulary.** Read every string the CLI and the keep-app page print
  during a full pass of Rows 1–3. None should say "passkey" anywhere a
  user reads it (invariant 9) — confirm this on the REAL rendered pages,
  not just via the automated `grep -rn passkey` source check CAP-382's
  report already ran.
- **Timing.** At least one full enroll-then-unlock-on-a-new-device round
  trip (Row 1.1 → 1.4 or 2.1 → 2.3) should be timed end-to-end. CAP-372's
  purpose bar is "under a minute, one gesture" — if it isn't, that's a
  product regression this checklist exists to catch, not a test failure
  any automated suite can detect.

## Recording results

File one line per row in the release notes: row id, date, surface
(OS/browser/version), coded outcome observed, and PASS/FAIL against the
"Expected coded outcome" column above. A FAIL blocks the release the same
as a failing automated test — this checklist is the gate for the parts of
CAP-372 no automated suite can reach, not an optional nice-to-have.
