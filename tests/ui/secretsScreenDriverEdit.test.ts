/**
 * The `capy secrets` driver with the edit flow wired in (CAP-698): real
 * keystrokes on stdin, the pure reducer, and the two effects (`loadRepos`,
 * `runSet`) performed by injected actions. Nothing real: no TTY, no service, no gh.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { runSecretsScreen, type CopyText, type SecretsEditActions } from '../../src/ui/secretsScreenDriver';
import type { SecretIndexRow } from '../../src/service/serviceClient';
import { hashValue } from '../../src/commands/statusCommand';
import type { LocationDecryptor } from '../../src/ui/secretsScreen';

const ESC = '\x1b';
const VALUE = 'SENTINEL-driver-value-55';
const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

const rows: readonly SecretIndexRow[] = [
  {
    name: 'API_KEY',
    value_hash: 'h1',
    locations: [
      { project_id: 'p1', project_name: 'web', branch: 'production', protected: true, service: null },
      { project_id: 'p2', project_name: 'api', branch: 'development', protected: false, service: null },
    ],
    users: [],
  },
];

async function drive(
  actions: SecretsEditActions | undefined,
  keys: ReadonlyArray<string | number>,
  inRows: readonly SecretIndexRow[] = rows,
  decrypt: LocationDecryptor = async () => ({ ok: false, code: 'NO' }),
  copy?: CopyText,
) {
  const outSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const done = runSecretsScreen(inRows, decrypt, actions, false, undefined, copy);
  await wait();
  for (const k of keys) {
    if (typeof k === 'number') await wait(k);
    else {
      process.stdin.emit('data', Buffer.from(k));
      await wait();
    }
  }
  await done;
  const screen = outSpy.mock.calls.map((c) => String(c[0])).join('');
  const logged = logSpy.mock.calls.map((c) => c.map(String).join(' '));
  outSpy.mockRestore();
  logSpy.mockRestore();
  return { screen, logged };
}

describe('runSecretsScreen with the edit flow', () => {
  test('type, pick locations, load repos, run: the effects are performed and the confirmation is printed after the screen is left', async () => {
    const loadRepos = async (ids: readonly string[]) => ({
      ok: true as const,
      links: ids.map((id) => ({
        project_id: id,
        project_name: id,
        host: 'github.com',
        owner: 'Acme',
        name: `repo-${id}`,
        path: '.',
        github_repo_id: 1,
        last_seen_at: '',
      })),
    });
    const loadBases = async () => ({ 'github.com/acme/repo-p1': 'main', 'github.com/acme/repo-p2': 'main' });
    const run = mock(async (request: Parameters<SecretsEditActions['run']>[0]): ReturnType<SecretsEditActions['run']> => {
      return {
        ok: true,
        result: {
          name: request.name,
          updated: request.locations.map((l) => ({ project: l.project_name, branch: l.branch, protected: l.protected })),
          unchanged: [],
          prs: [{ repo: 'Acme/repo-p1', url: 'https://github.com/Acme/repo-p1/pull/3', base: 'main', keep_lock_paths: ['keep.lock'], keep_lock_diverged: false, locations: [] }],
          no_pr: [],
          failed: [],
        },
      };
    });

    // Ctrl+E, the value as one bracketed paste, Enter, Enter (all locations), wait for repos, Enter (run), wait, Esc.
    const { screen, logged } = await drive({ loadRepos, loadBases, run }, ['\x05', `${ESC}[200~${VALUE}${ESC}[201~`, '\r', '\r', 40, '\r', 40, ESC]);

    const requests = run.mock.calls.map((c) => c[0]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ name: 'API_KEY', value: VALUE });
    expect(requests[0].locations).toHaveLength(2);
    expect(requests[0].repos).toHaveLength(2);
    // The value was never drawn.
    expect(screen).not.toContain(VALUE);
    // Bracketed paste was switched on for the screen and off again.
    expect(screen).toContain(`${ESC}[?2004h`);
    expect(screen).toContain(`${ESC}[?2004l`);
    // The confirmation reaches stdout after the alt screen is gone.
    expect(logged.join('\n')).toContain('✓ API_KEY updated in 2 locations.');
    expect(logged.join('\n')).toContain('https://github.com/Acme/repo-p1/pull/3');
    expect(logged.join('\n')).not.toContain(VALUE);
  });

  test('Esc backs out of the dialog; Ctrl-C quits; with no actions wired the flow ends in a code, not a crash', async () => {
    const cancelled = await drive(undefined, ['\x05', 'ab', ESC, 20, '\x03']);
    expect(cancelled.logged).toEqual([]);

    const unwired = await drive(undefined, ['\x05', 'v', '\r', '\r', 30, '\r', 30, ESC]);
    expect(unwired.logged.join('\n')).toContain('(UNAVAILABLE)');
  });
});

describe('`c` on the result screen, through the real driver', () => {
  const URL = 'https://github.com/Acme/repo-p1/pull/3';
  const actions: SecretsEditActions = {
    loadRepos: async (ids) => ({
      ok: true as const,
      links: ids.map((id) => ({ project_id: id, project_name: id, host: 'github.com', owner: 'Acme', name: `repo-${id}`, path: '.', github_repo_id: 1, last_seen_at: '' })),
    }),
    loadBases: async () => ({ 'github.com/acme/repo-p1': 'main', 'github.com/acme/repo-p2': 'main' }),
    run: async (request) => ({
      ok: true,
      result: {
        name: request.name,
        updated: request.locations.map((l) => ({ project: l.project_name, branch: l.branch, protected: l.protected })),
        unchanged: [],
        prs: [{ repo: 'Acme/repo-p1', url: URL, base: 'main', keep_lock_paths: ['keep.lock'], keep_lock_diverged: false, locations: [] }],
        no_pr: [],
        failed: [],
      },
    }),
  };
  // Ctrl+E, the value, Enter, Enter (all locations), wait for repos, Enter (run), wait, `c`, wait, Esc.
  const keys = ['\x05', 'v', '\r', '\r', 40, '\r', 40, 'c', 30, ESC] as const;

  test('the effect calls the injected clipboard function with the PR urls; the screen stays open and draws the outcome', async () => {
    const copy = mock(async (_text: string) => true);
    const { screen } = await drive(actions, keys, rows, undefined, copy);
    expect(copy.mock.calls.map((c) => c[0])).toEqual([URL]);
    expect(screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).toContain('Copied 1 PR link');
  });

  test('a clipboard that fails (or throws) is shown as could-not-copy, never a crash', async () => {
    const failing = mock(async (_text: string) => false);
    const failed = await drive(actions, keys, rows, undefined, failing);
    expect(failing.mock.calls).toHaveLength(1);
    expect(failed.screen).toContain('Could not copy to clipboard');
    const throwing = mock(async (_text: string): Promise<boolean> => {
      throw new Error('boom');
    });
    expect((await drive(actions, keys, rows, undefined, throwing)).screen).toContain('Could not copy to clipboard');
  });
});

describe('Ctrl+R in the dialog, through the real driver', () => {
  const OLD = 'SENTINEL-driver-old-value-77';
  const oldRows: readonly SecretIndexRow[] = [{ ...rows[0], value_hash: hashValue(OLD) }];
  const decrypt: LocationDecryptor = async () => ({ ok: true, plaintext: OLD });

  test('the old AND the typed value are revealed in the frame (alt screen) and nowhere else: not after the screen is left, not in any log', async () => {
    const actions: SecretsEditActions = {
      loadRepos: async () => ({ ok: true, links: [] }),
      loadBases: async () => ({}),
      run: async (request) => ({
        ok: true,
        result: { name: request.name, updated: [], unchanged: [], prs: [], no_pr: [], failed: [] },
      }),
    };
    // Ctrl+E, wait for the value to be read, Ctrl+R, type, Enter, Enter, wait, Enter (run), wait, Esc.
    const { screen, logged } = await drive(actions, ['\x05', 40, '\x12', VALUE, '\r', '\r', 40, '\r', 40, ESC], oldRows, decrypt);
    expect(screen).toContain(OLD); // visible while the dialog is open
    expect(screen).toContain(VALUE); // revealed by the same Ctrl+R, typed after it
    const exitAt = screen.lastIndexOf(`${ESC}[?1049l`);
    expect(exitAt).toBeGreaterThan(-1);
    expect(screen.slice(exitAt)).not.toContain(OLD);
    expect(screen.slice(exitAt)).not.toContain(VALUE);
    // Past the dialog (locations step onwards) neither value is drawn again.
    const afterDialog = screen.slice(screen.indexOf('locations'));
    expect(afterDialog).not.toContain(OLD);
    expect(afterDialog).not.toContain(VALUE);
    expect(logged.join('\n')).not.toContain(OLD);
    expect(logged.join('\n')).not.toContain(VALUE);
  });

  test('cancelling with Esc and quitting leaves nothing revealed behind', async () => {
    const { screen, logged } = await drive(undefined, ['\x05', 40, '\x12', ESC, 20, '\x03'], oldRows, decrypt);
    expect(screen.slice(screen.lastIndexOf(`${ESC}[?1049l`))).not.toContain(OLD);
    expect(logged).toEqual([]);
  });
});
