/**
 * CAP-657 "no trap" follow-up: `resolvePreflightWithRecovery`
 * (deployCommand.ts) — what `capy deploy <target>` does when
 * `adapter.preflight()` fails instead of just exiting: at a TTY it offers
 * edit/retry/cancel and loops until preflight passes or the human cancels;
 * everywhere else (non-TTY, `--yes`, `--json`, `--web`) it keeps EXACTLY
 * the old behavior — print the reason + hint, print the direct fix, exit
 * with the same coded refusal.
 *
 * Drives `resolvePreflightWithRecovery` directly with a SYNTHETIC adapter
 * (not looked up from the registry) and injected `promptMenu`/`editTarget`
 * dependencies — no real stdin, no real inquirer sequence, no network, no
 * installed vendor CLI. `promptMenu` is the one seam that can't be driven
 * through a faked TTY at all (see that function's own doc and
 * `deployDokploySystemStoreToken.test.ts`'s identical note about
 * `keypressConfirm`); `editTarget` stands in for the real `runPicker` so
 * the "edit fixes it" and "edit, still broken" cases don't need a
 * registered adapter or a scripted inquirer sequence either.
 *
 * No `mock.module()` here — everything is plain dependency injection — so
 * this file runs in the BATCH group, not isolated.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import {
  resolvePreflightWithRecovery,
  KeepInfo,
} from '../../src/commands/deployCommand';
import { AdapterCallContext, DeployAdapter, PreflightResult, TargetConfig } from '../../src/deploy/adapter';

const KEEP: KeepInfo = { orgId: 'org_1', projectId: 'proj_1', variables: ['A'], branches: ['production'] };
const CTX: AdapterCallContext = {};

function targetWith(options: Record<string, unknown>): TargetConfig {
  return {
    name: 'demo',
    kind: 'fake',
    branch: 'production',
    vars: ['A'],
    options,
    mode: 'direct',
  };
}

/** A minimal `DeployAdapter` whose `preflight` checks one option field — network-free, binary-free. */
function fakeAdapter(): DeployAdapter {
  return {
    id: 'fake',
    label: 'Fake',
    description: 'test-only adapter',
    varKind: 'runtime',
    defaultMode: 'direct',
    requires: { binaries: [] },
    async detect() {
      return {};
    },
    async preflight(config: TargetConfig): Promise<PreflightResult> {
      const opts = config.options as { broken?: boolean };
      return opts.broken
        ? { ok: false, reason: 'fake target is broken', hint: 'some adapter-provided hint' }
        : { ok: true };
    },
    async deploy() {
      return { ok: true, steps: [] };
    },
  };
}

describe('resolvePreflightWithRecovery (CAP-657 "no trap")', () => {
  test('preflight already passing: returns "ok" immediately, no menu, no console noise about failure', async () => {
    const promptMenu = mock(async (): Promise<'edit' | 'retry' | 'cancel'> => 'cancel');
    const outcome = await resolvePreflightWithRecovery(
      '/tmp',
      KEEP,
      fakeAdapter(),
      targetWith({ broken: false }),
      { ok: true },
      CTX,
      true,
      { promptMenu },
    );
    expect(outcome.kind).toBe('ok');
    expect(promptMenu.mock.calls.length).toBe(0);
  });

  test('non-interactive (the caller\'s call — non-TTY/--yes/--json/--web): refused immediately, no menu shown', async () => {
    const promptMenu = mock(async (): Promise<'edit' | 'retry' | 'cancel'> => {
      throw new Error('menu must never be shown when not interactive');
    });
    const adapter = fakeAdapter();
    const outcome = await resolvePreflightWithRecovery(
      '/tmp',
      KEEP,
      adapter,
      targetWith({ broken: true }),
      await adapter.preflight(targetWith({ broken: true }), { cwd: '/tmp', ...CTX }),
      CTX,
      /* interactive */ false,
      { promptMenu },
    );
    expect(outcome.kind).toBe('refused');
    expect(promptMenu.mock.calls.length).toBe(0);
  });

  test('non-interactive refusal prints the direct fix naming `capy deploy <name> --edit` (not whatever order the adapter\'s own hint used)', async () => {
    const errMock = mock((..._a: unknown[]) => {});
    const errSpy = spyOn(console, 'error').mockImplementation(errMock as never);
    try {
      const adapter = fakeAdapter();
      const target = targetWith({ broken: true });
      await resolvePreflightWithRecovery(
        '/tmp',
        KEEP,
        adapter,
        target,
        await adapter.preflight(target, { cwd: '/tmp', ...CTX }),
        CTX,
        false,
      );
    } finally {
      errSpy.mockRestore();
    }
    const lines = errMock.mock.calls.map((args) => args.map(String).join(' '));
    expect(lines.some((l) => l.includes('capy deploy demo --edit'))).toBe(true);
    // The adapter's own hint is still printed too — additive, not replaced.
    expect(lines.some((l) => l.includes('some adapter-provided hint'))).toBe(true);
  });

  test('interactive + retry: re-runs preflight against the SAME target, no edit invoked', async () => {
    const preflightMock = mock(async (): Promise<PreflightResult> => ({ ok: true }));
    const adapter: DeployAdapter = { ...fakeAdapter(), preflight: preflightMock };
    const promptMenu = mock(async (): Promise<'edit' | 'retry' | 'cancel'> => 'retry');
    const editTarget = mock(async (): Promise<TargetConfig | null> => {
      throw new Error('editTarget must never be called for a pure retry');
    });
    const target = targetWith({ broken: true });
    const outcome = await resolvePreflightWithRecovery(
      '/tmp',
      KEEP,
      adapter,
      target,
      { ok: false, reason: 'initial' },
      CTX,
      true,
      { promptMenu, editTarget },
    );
    expect(outcome.kind).toBe('ok');
    // The "same target" property: the retried preflight call's config is the
    // exact same object handed in — retry never substitutes a different one.
    expect(preflightMock.mock.calls[0][0]).toBe(target);
    expect(preflightMock.mock.calls.length).toBe(1);
    expect(promptMenu.mock.calls.length).toBe(1);
    expect(editTarget.mock.calls.length).toBe(0);
  });

  test('interactive + retry that fails again: prompts the menu a second time rather than giving up', async () => {
    const preflightMock = mock(async (): Promise<PreflightResult> => ({ ok: false, reason: 'still broken' }));
    const adapter: DeployAdapter = { ...fakeAdapter(), preflight: preflightMock };
    const promptMenu = mock(async (): Promise<'edit' | 'retry' | 'cancel'> => 'retry');
    promptMenu.mockImplementationOnce(async () => 'retry');
    promptMenu.mockImplementationOnce(async () => 'cancel');
    const outcome = await resolvePreflightWithRecovery(
      '/tmp',
      KEEP,
      adapter,
      targetWith({ broken: true }),
      { ok: false, reason: 'initial' },
      CTX,
      true,
      { promptMenu },
    );
    expect(outcome.kind).toBe('cancelled');
    expect(preflightMock.mock.calls.length).toBe(1);
    expect(promptMenu.mock.calls.length).toBe(2);
  });

  test('interactive + edit → fixed → passes: editTarget\'s returned target is what gets re-checked and returned', async () => {
    const adapter = fakeAdapter();
    const promptMenu = mock(async (): Promise<'edit' | 'retry' | 'cancel'> => 'edit');
    const fixed = targetWith({ broken: false });
    const editTarget = mock(async (_t: TargetConfig): Promise<TargetConfig | null> => fixed);
    const outcome = await resolvePreflightWithRecovery(
      '/tmp',
      KEEP,
      adapter,
      targetWith({ broken: true }),
      { ok: false, reason: 'initial' },
      CTX,
      true,
      { promptMenu, editTarget },
    );
    expect(outcome.kind).toBe('ok');
    expect(outcome.kind === 'ok' && outcome.target).toEqual(fixed);
    expect(editTarget.mock.calls.length).toBe(1);
  });

  test('interactive + edit → STILL broken: offers the menu again rather than exiting', async () => {
    const adapter = fakeAdapter();
    // edit, then decline the menu (after one failed edit attempt) — scripted
    // via `mockImplementationOnce` rather than an external counter, the same
    // sequencing seam the picker tests use for inquirer.
    const promptMenu = mock(async (): Promise<'edit' | 'retry' | 'cancel'> => 'cancel');
    promptMenu.mockImplementationOnce(async () => 'edit');
    promptMenu.mockImplementationOnce(async () => 'cancel');
    const stillBroken = targetWith({ broken: true });
    const editTarget = mock(async (): Promise<TargetConfig | null> => stillBroken);
    const outcome = await resolvePreflightWithRecovery(
      '/tmp',
      KEEP,
      adapter,
      targetWith({ broken: true }),
      { ok: false, reason: 'initial' },
      CTX,
      true,
      { promptMenu, editTarget },
    );
    expect(outcome.kind).toBe('cancelled');
    expect(editTarget.mock.calls.length).toBe(1);
    expect(promptMenu.mock.calls.length).toBe(2);
  });

  test('editTarget returning null (picker itself was cancelled) cancels the whole flow', async () => {
    const adapter = fakeAdapter();
    const promptMenu = mock(async (): Promise<'edit' | 'retry' | 'cancel'> => 'edit');
    const editTarget = mock(async (): Promise<TargetConfig | null> => null);
    const outcome = await resolvePreflightWithRecovery(
      '/tmp',
      KEEP,
      adapter,
      targetWith({ broken: true }),
      { ok: false, reason: 'initial' },
      CTX,
      true,
      { promptMenu, editTarget },
    );
    expect(outcome.kind).toBe('cancelled');
  });

  test('interactive + cancel: exits with "cancelled" — the caller maps this to the SAME exit code (1) as the non-interactive refusal, just reached via a human choice instead of an automatic one', async () => {
    const adapter = fakeAdapter();
    const promptMenu = mock(async (): Promise<'edit' | 'retry' | 'cancel'> => 'cancel');
    const outcome = await resolvePreflightWithRecovery(
      '/tmp',
      KEEP,
      adapter,
      targetWith({ broken: true }),
      { ok: false, reason: 'initial' },
      CTX,
      true,
      { promptMenu },
    );
    expect(outcome.kind).toBe('cancelled');
  });
});
