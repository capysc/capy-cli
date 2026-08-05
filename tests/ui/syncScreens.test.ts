/**
 * The two reports of the sync pair: `capy status` and the end of a `capy` run.
 *
 * Neither asks anything, so what is pinned here is what they SAY. Three things
 * the terminal decides and then throws away into prose are values in these
 * payloads instead — which side of a comparison moved, why the remote could
 * not be read, and whether the .env on disk was rewritten — because a screen
 * that had to recover them would be recovering them by matching sentences.
 *
 * And the thing neither may ever carry: a value. The comparison itself runs on
 * 16-hex sha256 prefixes and not even those cross.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildSyncStatusData,
  buildSyncResultData,
  showSyncStatusInBrowser,
  showSyncResultInBrowser,
} from '../../src/ui/syncScreens';

const BASE = {
  projectName: 'mikes-market',
  branch: 'development',
  totalSecrets: 14,
  localMatchesPinned: false,
  remoteMatchesPinned: true,
  hasRemote: true,
  expiring: [],
  json: '{}',
  diffs: [] as any[],
  open: false,
};

// The hashes `compareSecrets` produces: 16 hex characters, never a value.
const H = { pinned: 'a1b2c3d4e5f60718', local: '0718f6e5d4c3b2a1', remote: 'ffeeddccbbaa9988' };

describe('buildSyncStatusData', () => {
  test('says which side moved, which the terminal only says in prose', () => {
    const d = buildSyncStatusData({
      ...BASE,
      diffs: [
        // Local edited, remote still agrees with the pin.
        { variable: 'STRIPE_SECRET_KEY', type: 'changed', pinned: H.pinned, local: H.local, remote: H.pinned },
        // A teammate pushed; this directory has not moved.
        { variable: 'DATABASE_URL', type: 'changed', pinned: H.pinned, local: H.pinned, remote: H.remote },
        // Both moved — the case the terminal writes as a bare "(changed)".
        { variable: 'API_TOKEN', type: 'changed', pinned: H.pinned, local: H.local, remote: H.remote },
      ],
    });
    expect(d.diffs.map((x) => x.side)).toEqual(['local', 'remote', 'both']);
    expect(d.diffs.map((x) => x.variable)).toEqual(['STRIPE_SECRET_KEY', 'DATABASE_URL', 'API_TOKEN']);
  });

  test('the remote is a state, not three booleans to be reassembled', () => {
    expect(buildSyncStatusData({ ...BASE, hasRemote: true, remoteMatchesPinned: true }).remoteState)
      .toBe('up_to_date');
    expect(buildSyncStatusData({ ...BASE, hasRemote: true, remoteMatchesPinned: false }).remoteState)
      .toBe('has_changes');
    expect(buildSyncStatusData({ ...BASE, hasRemote: false }).remoteState).toBe('empty');

    // A failure is its own state, carrying the CODE the CLI classified it as —
    // never the message it happened to be classified FROM.
    const failed = buildSyncStatusData({ ...BASE, hasRemote: false, remoteFailure: 'access_denied' });
    expect(failed.remoteState).toBe('failed');
    expect(failed.remoteFailure).toBe('access_denied');
  });

  test('hands over the CLI\'s own next command, and the reason it differs', () => {
    // Nothing to do: there is no next command to offer.
    expect(buildSyncStatusData(BASE).nextCommand).toBeUndefined();
    expect(
      buildSyncStatusData({ ...BASE, diffs: [{ variable: 'A', type: 'changed', pinned: H.pinned, local: H.local }] })
        .nextCommand,
    ).toBe('capy');
    // A caller who cannot read the remote is told to redeem rather than to
    // sync — syncing would fail in exactly the same way.
    expect(
      buildSyncStatusData({
        ...BASE,
        hasRemote: false,
        remoteFailure: 'access_denied',
        diffs: [{ variable: 'A', type: 'changed', pinned: H.pinned, local: H.local }],
      }).nextCommand,
    ).toBe('capy redeem [invite-code]');
  });

  test('carries the --json payload verbatim rather than rebuilding it', () => {
    const json = JSON.stringify({ projectName: 'mikes-market', inSync: true }, null, 2);
    expect(buildSyncStatusData({ ...BASE, json }).json).toBe(json);
  });

  test('renders no value, and not even the hashes it compared', () => {
    const d = buildSyncStatusData({
      ...BASE,
      diffs: [{ variable: 'STRIPE_SECRET_KEY', type: 'changed', pinned: H.pinned, local: H.local, remote: H.remote }],
      json: '{"diffs":[]}',
    });
    const payload = JSON.stringify(d);
    expect(payload).not.toContain('sk_live');
    // The hashes are an implementation detail of the comparison; the page is
    // given the verdict, not the arithmetic.
    expect(payload).not.toContain(H.pinned);
    expect(payload).not.toContain(H.local);
    expect(Object.keys(d.diffs[0])).toEqual(['variable', 'type', 'side']);
  });

  test('strips the terminal colour codes off the names it also prints', () => {
    const d = buildSyncStatusData({ ...BASE, projectName: '\x1b[1mmikes-market\x1b[0m' });
    expect(d.projectName).toBe('mikes-market');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });

  test('a branch the CLI could not derive is null, not an empty string', () => {
    expect(buildSyncStatusData({ ...BASE, branch: null }).branch).toBeNull();
  });
});

describe('buildSyncResultData', () => {
  test('direction is which list a variable is in, not a field on the row', () => {
    const d = buildSyncResultData({
      projectName: 'mikes-market',
      branch: 'development',
      outcome: 'synced',
      pulled: [{ variable: 'DATABASE_URL', type: 'changed' }],
      pushed: [{ variable: 'STRIPE_SECRET_KEY', type: 'new' }],
      envRewritten: true,
      open: false,
    });
    expect(d.pulled).toEqual([{ variable: 'DATABASE_URL', type: 'changed' }]);
    expect(d.pushed).toEqual([{ variable: 'STRIPE_SECRET_KEY', type: 'new' }]);
    expect(JSON.stringify(d)).not.toContain('sk_live');
  });

  test('whether the file changed is carried, never inferred from the lists', () => {
    // `capy` rewrites the whole .env even when nothing differed at all…
    const upToDate = buildSyncResultData({
      projectName: 'mikes-market',
      branch: 'development',
      outcome: 'nothing-to-do',
      pulled: [],
      pushed: [],
      envRewritten: true,
      open: false,
    });
    expect(upToDate.envRewritten).toBe(true);

    // …and rewrites nothing when the run was skipped or the window closed.
    // Both are `nothing-to-do` and only this field tells them apart.
    const skipped = buildSyncResultData({
      projectName: 'mikes-market',
      branch: 'development',
      outcome: 'nothing-to-do',
      pulled: [],
      pushed: [],
      envRewritten: false,
      open: false,
    });
    expect(skipped.envRewritten).toBe(false);
  });
});

describe('serving a report', () => {
  test('the status page is served whole, and once', async () => {
    const url = await showSyncStatusInBrowser({
      ...BASE,
      diffs: [{ variable: 'STRIPE_SECRET_KEY', type: 'changed', pinned: H.pinned, local: H.local }],
      json: '{"inSync":false}',
      timeoutMs: 4_000,
    });

    const res = await fetch(url);
    expect(res.status).toBe(200);
    // A page that only reports is given no way to speak at all.
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'");
    const html = await res.text();
    expect(html).toContain('window.__CAPY_DATA__');
    expect(html).toContain('STRIPE_SECRET_KEY');
    expect(html).not.toContain('sk_live');

    // Single-use: the token is spent, and the server is on its way down.
    expect((await fetch(url)).status).toBe(404);
  });

  test('the result page is served the same way', async () => {
    const url = await showSyncResultInBrowser({
      projectName: 'mikes-market',
      branch: 'development',
      outcome: 'synced',
      pulled: [{ variable: 'DATABASE_URL', type: 'changed' }],
      pushed: [],
      envRewritten: true,
      open: false,
      timeoutMs: 4_000,
    });

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(await res.text()).toContain('DATABASE_URL');
  });
});
