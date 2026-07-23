/**
 * Seed a deterministic, offline, local-only fixture that makes the REAL bare
 * `capy` sync flow detect a conflict every time — no live service, no mock
 * server, no network. Used to demo / rehearse the `capy --web` browser
 * conflict resolver and onboarding trainstops (CAP-274).
 *
 * It is a genuine end-to-end seed: real crypto, a real `capy push` to commit a
 * baseline into the local keep cache, then a real edit to `.env` so the next
 * `capy` sees local != pinned (State 2) and opens the resolver.
 *
 * MUST be run with HOME pointed at a throwaway fixture dir so it never touches
 * the developer's real ~/.capy:
 *
 *   HOME=/tmp/capy-demo-home bun scripts/demo/seed.ts
 *
 * Prints the seeded project dir on the last line (stdout) so a demo runner can
 * `cd` there and launch `capy --web`.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Safety rail: refuse to seed into a real home dir ──────────────────────────
const home = homedir();
if (!process.env.HOME || !/capy[-_]?demo|capy[-_]?fixture|tmp/i.test(home)) {
  console.error(
    `Refusing to seed: HOME (${home}) does not look like a throwaway fixture dir.\n` +
      `Run with e.g.  HOME=/tmp/capy-demo-home bun scripts/demo/seed.ts`,
  );
  process.exit(2);
}

const projectDir = process.env.CAPY_DEMO_PROJECT || join(home, 'demo-project');
const BRANCH = 'development';

// Baseline secrets (what gets committed/pinned) and the post-edit local values.
// Two of three diverge → a 2-row conflict table; STRIPE_KEY stays to show the
// resolver only surfaces what actually changed.
const BASELINE: Record<string, string> = {
  API_KEY: 'sk_baseline_0001',
  DATABASE_URL: 'postgres://localhost:5432/app_dev',
  STRIPE_KEY: 'pk_test_unchanged',
};
const EDITED: Record<string, string> = {
  API_KEY: 'sk_locally_edited_9999',
  DATABASE_URL: 'postgres://localhost:5432/app_staging',
  STRIPE_KEY: 'pk_test_unchanged',
};

const toEnv = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';

async function main() {
  // Clean any prior fixture so the seed is deterministic.
  for (const p of [join(home, '.capy'), projectDir]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  const gc = await import('../../src/config/globalConfig');
  const km = await import('../../src/crypto/keyManager');
  const kr = await import('../../src/crypto/keyResolver');
  const { saveAndActivateProfile } = await import('../../src/config/profileConfig');

  // 1. Local-only profile + an unlocked passphrase session (no auth, no server).
  saveAndActivateProfile('local', { url: 'local://', localOnly: true });
  const masterKey = km.seedPhraseToMasterKey(km.generateSeedPhrase());
  kr.saveLocalKey(masterKey, 'demo-passphrase');
  gc.saveLocalSession(masterKey.toString('hex'));

  // 2. A project dir with an empty keep.lock + a baseline .env.
  mkdirSync(join(projectDir, '.capy'), { recursive: true });
  writeFileSync(join(projectDir, '.capy', 'branch'), BRANCH);
  writeFileSync(
    join(projectDir, 'keep.lock'),
    JSON.stringify(
      {
        version: '3.0',
        org_id: gc.LOCAL_ORG_ID,
        project_id: 'proj-demo',
        project_name: 'demo',
        variables: {},
      },
      null,
      2,
    ),
  );
  writeFileSync(join(projectDir, '.env'), toEnv(BASELINE));

  // 3. Commit the baseline with a REAL push (writes pinned hashes into keep.lock
  //    and the encrypted blob into the local keep cache — the "pinned" side).
  process.chdir(projectDir);
  const { PushCommand } = await import('../../src/commands/pushCommand');
  await new PushCommand().execute();

  // 4. Diverge: edit .env so local != pinned. Next `capy` → State 2 resolver.
  writeFileSync(join(projectDir, '.env'), toEnv(EDITED));

  console.error('\n✓ Seeded. Conflict will fire on next `capy` in:');
  // Last stdout line = the project dir, for a demo runner to consume.
  console.log(projectDir);
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
