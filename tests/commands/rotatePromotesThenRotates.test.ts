/**
 * `capy rotate <unmanaged-var>` links the variable AND THEN ROTATES IT.
 *
 * The rotation used to happen by accident. `connect` fetched a key from the
 * provider and wrote it over the variable, so promoting an unmanaged variable
 * looked like a rotation without ever being one. When `connect` correctly
 * stopped writing values — it records a link; replacing a credential is
 * `rotate`'s job and nobody else's — the promote path silently stopped
 * changing anything at all: it recorded the link, printed connect's own
 * sign-off ("run `capy rotate DATABASE_URL` to replace it", the command
 * already running), and returned with the credential untouched.
 *
 * Nothing failed. No test went red, because every test on that path checks
 * either the connector's describers or connect's own invariant, and both were
 * correct. The only thing that disagreed was the rail: `rotationPlan` draws
 * Rotate, Push and Deploy as stops still ahead of this route, and has all
 * along. They were drawn and never travelled — the same shape as every other
 * defect in this parcel, a built and tested destination with nobody driving
 * there.
 *
 * So these tests are about the JOIN, and they mock everything either side of
 * it: what `connect` was asked for, and whether a rotation followed.
 */
import { mock, describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConnectorMetadata, KeepFile } from '../../src/types/index';
// Imported for real, BEFORE the mock below is registered, so the partial mock
// can spread it. Resolving it from inside the factory instead hands back the
// mock that is being defined, and every untouched export comes out missing.
import * as realShared from '../../src/commands/connectors/shared';

const TEST_DIR = join(tmpdir(), `capy-rotate-promote-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

const CONNECTOR: ConnectorMetadata = {
  provider: 'stripe',
  source: 'cli',
  mode: 'test',
  account_id: 'acct_1234',
  created_at: 1700000000,
  fingerprint: 'rk_…tst',
};

/** What each mocked collaborator saw, reset before every test. */
const seen = {
  connect: [] as Array<{ provider: string; opts: Record<string, unknown> }>,
  rotated: [] as string[],
  written: [] as Array<{ varName: string; value: string | undefined }>,
};

/** Flipped per test: whether the mocked `connect` reports a recorded link. */
let linkSucceeds = true;

function readKeep(): KeepFile {
  return JSON.parse(readFileSync(join(TEST_DIR, 'keep.lock'), 'utf-8'));
}

function writeKeep(keep: KeepFile): void {
  writeFileSync(join(TEST_DIR, 'keep.lock'), JSON.stringify(keep), 'utf-8');
}

// ── The two collaborators either side of the join ────────────────────────────
//
// `connect` is stubbed rather than driven: the real one needs a paired Stripe
// CLI, an authenticated service and a project key, none of which says anything
// about whether rotate carries on afterwards. What it DOES do is the one thing
// the rest of the flow depends on — record the connector in keep.lock — so the
// stub does exactly that and nothing else.
mock.module(join(import.meta.dir, '../../src/commands/connectCommand.ts'), () => ({
  ConnectCommand: class {
    constructor(_devMode?: boolean) {}
    async list(): Promise<void> {}
    async execute(provider: string, opts: Record<string, unknown>): Promise<{ linked: boolean }> {
      seen.connect.push({ provider, opts });
      if (!linkSucceeds) return { linked: false };
      const keep = readKeep();
      const entries = keep.variables[opts.var as string] ?? [];
      const idx = entries.findIndex((e) => e.branch === 'development');
      if (idx >= 0) entries[idx] = { ...entries[idx], connector: CONNECTOR };
      keep.variables[opts.var as string] = entries;
      writeKeep(keep);
      return { linked: true };
    }
  },
  confirmLiveAction: async () => true,
  rotateLiveGateStops: () => [],
}));

mock.module(join(import.meta.dir, '../../src/commands/connectors/registry.ts'), () => ({
  listProviders: () => [{ name: 'stripe', description: 'Stripe' }],
  loadProvider: async () => ({
    name: 'stripe',
    description: 'Stripe',
    requiresAuth: true,
    rotate: async (_ctx: unknown, varName: string) => {
      seen.rotated.push(varName);
      return { value: 'example-rotated-value-123456-not-a-secret', entry: { ...CONNECTOR, rotated_at: 1 } };
    },
  }),
}));

// Everything except the two functions that would reach the network. The list
// helpers are pure keep.lock reads and this test depends on them being real —
// a stubbed `findManagedConnector` would assert nothing about whether the link
// the stub recorded is the one rotate picks up.
mock.module(join(import.meta.dir, '../../src/commands/connectors/shared.ts'), () => ({
  ...realShared,
  resolveContext: async () => ({
    keep: readKeep(),
    branch: 'development',
    localPlaintext: {},
  }),
  writeAndSync: async (_ctx: unknown, varName: string, value: string | undefined) => {
    seen.written.push({ varName, value });
  },
}));

function writeFixture(vars: Array<{ name: string; managed?: boolean }>): void {
  const variables: KeepFile['variables'] = {};
  for (const v of vars) {
    variables[v.name] = [
      {
        resource_id: `r-${v.name}`,
        branch: 'development',
        value_hash: `h-${v.name}`,
        ...(v.managed ? { connector: CONNECTOR } : {}),
      },
    ];
  }
  writeKeep({
    version: '3.0',
    org_id: 'o',
    project_id: 'p',
    project_name: 'demo',
    variables,
  });
  mkdirSync(join(TEST_DIR, '.capy'), { recursive: true });
  writeFileSync(join(TEST_DIR, '.capy', 'branch'), 'development', 'utf-8');
}

let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
  seen.connect = [];
  seen.rotated = [];
  seen.written = [];
  linkSucceeds = true;
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  process.chdir(ORIGINAL_CWD);
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

async function rotate(varName: string, opts: Record<string, unknown> = {}): Promise<void> {
  const { RotateCommand } = await import('../../src/commands/rotateCommand');
  await new RotateCommand(false).execute(varName, { nonTty: true, ...opts } as never);
}

describe('promoting an unmanaged variable', () => {
  test('links it, then rotates it — the stops the rail already promised', async () => {
    writeFixture([{ name: 'DATABASE_URL' }]);

    await rotate('DATABASE_URL', { provider: 'stripe' });

    // The link happened, through connect.
    expect(seen.connect).toHaveLength(1);
    expect(seen.connect[0].provider).toBe('stripe');
    expect(seen.connect[0].opts.var).toBe('DATABASE_URL');

    // And so did the rotation, which is the whole point of the command that
    // was typed. This was the assertion nothing made.
    expect(seen.rotated).toEqual(['DATABASE_URL']);
    expect(seen.written).toEqual([
      { varName: 'DATABASE_URL', value: 'example-rotated-value-123456-not-a-secret' },
    ]);
  });

  test('the link is a step, not an ending', async () => {
    // `subStep` is what suppresses connect's success page and its "run `capy
    // rotate DATABASE_URL` to replace it" sign-off — the command already
    // running. Without it the user is shown a finished run in the middle of
    // one, and pointed back at the start of the flow they are inside.
    writeFixture([{ name: 'DATABASE_URL' }]);
    await rotate('DATABASE_URL', { provider: 'stripe' });
    expect(seen.connect[0].opts.subStep).toBe(true);
  });

  test('no `force` is asked for, because there is no overwrite to force', async () => {
    // `force: true` used to ride along to skip connect's overwrite guard. The
    // guard went when the overwrite did, so passing it was a request nothing
    // reads — and a standing suggestion that connect still writes values.
    writeFixture([{ name: 'DATABASE_URL' }]);
    await rotate('DATABASE_URL', { provider: 'stripe' });
    expect(seen.connect[0].opts.force).toBeUndefined();
  });

  test('a link that did not land stops the run rather than rotating anyway', async () => {
    // A declined live gate, or a push that failed after the local write. Both
    // have already served their own ending; carrying on would rotate a
    // credential against a link the user just refused.
    linkSucceeds = false;
    writeFixture([{ name: 'DATABASE_URL' }]);

    await rotate('DATABASE_URL', { provider: 'stripe' });

    expect(seen.connect).toHaveLength(1);
    expect(seen.rotated).toEqual([]);
    expect(seen.written).toEqual([]);
  });

  test('an already-managed variable never diverts through connect', async () => {
    // The other half: promotion is for variables with no connector, and a
    // managed one goes straight to the rotation.
    writeFixture([{ name: 'STRIPE_SECRET_KEY', managed: true }]);

    await rotate('STRIPE_SECRET_KEY');

    expect(seen.connect).toEqual([]);
    expect(seen.rotated).toEqual(['STRIPE_SECRET_KEY']);
  });
});
