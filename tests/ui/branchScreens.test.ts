/**
 * `capy checkout`, served as compiled screens.
 *
 * Two things these pin that nothing else could:
 *
 *   - the rail the browser draws is `branchCreatePlan`'s array, not one this
 *     file rebuilt. `tests/core/branchCreatePlan.test.ts` already proves the
 *     plan and `--json` agree; these prove the payload is fed by the same
 *     call, which is what closes the loop.
 *   - the seed preview carries variable NAMES and never a value. `checkout -b`
 *     decrypts .env in-process to seed the new branch, so this payload is the
 *     one place in the flow where plaintext could escape.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildBranchCreateData,
  buildBranchListData,
  branchNameProblem,
  createBranchInBrowser,
  chooseBranchInBrowser,
} from '../../src/ui/branchScreens';
import { branchCreatePlan } from '../../src/core/branchCreatePlan';
import type { Branch } from '../../src/types/index';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

const EXISTING = [
  { name: 'development', isProtected: false },
  { name: 'production', isProtected: true },
];

const CREATE = {
  projectName: 'mikes-market',
  branchName: 'release',
  existingBranches: EXISTING,
  seedFrom: 'development',
  seedVarNames: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
  open: false,
};

const BRANCHES: Branch[] = [
  {
    id: 'b1',
    name: 'development',
    project_id: 'p1',
    is_protected: false,
    created_at: '2026-07-30T09:00:00.000Z',
  },
  // Deliberately named like a protected branch and NOT protected: the payload
  // must read `is_protected`, never the name.
  { id: 'b2', name: 'production', project_id: 'p1', is_protected: false },
  // …and the reverse, so neither direction can be passing by accident.
  { id: 'b3', name: 'spike', project_id: 'p1', is_protected: true },
];

const LIST = {
  projectName: 'mikes-market',
  activeBranch: 'development',
  branches: BRANCHES,
  canDelete: false,
  open: false,
};

describe('buildBranchCreateData', () => {
  test('the rail is the plan, not a second array built for the browser', () => {
    const d = buildBranchCreateData(CREATE, 'n');
    expect(d.stops).toEqual(branchCreatePlan({ branchName: 'release' }));
    expect(d.stops.map((s) => s.id)).toEqual(['name', 'protection', 'create']);
  });

  test('a name from argv arrives answered, so the run stands on protection', () => {
    const d = buildBranchCreateData(CREATE, 'n');
    expect(d.view).toBe('protection');
    expect(d.stops[0]).toMatchObject({ state: 'done', answer: 'release', flag: 'argument' });
    expect(d.stops[1].state).toBe('current');
  });

  test('a name that is only whitespace is no name, and the run asks for one', () => {
    const d = buildBranchCreateData({ ...CREATE, branchName: '   ' }, 'n');
    expect(d.view).toBe('name');
    expect(d.name).toBe('');
    expect(d.stops[0].state).toBe('current');
  });

  test('a flag-answered protection stop is marked, and nothing is left to ask', () => {
    const d = buildBranchCreateData({ ...CREATE, isProtected: true }, 'n');
    expect(d.isProtected).toBe(true);
    expect(d.stops[1]).toMatchObject({ state: 'done', answer: 'protected', flag: '--protected' });
    // No stop is `skipped`: a flag resolved this one, it did not fall away.
    expect(d.stops.some((s) => s.state === 'skipped')).toBe(false);
  });

  test('the seed preview is variable names and nothing else', () => {
    const d = buildBranchCreateData(
      { ...CREATE, seedVarNames: ['STRIPE_SECRET_KEY', 'DATABASE_URL'] },
      'n',
    );
    const json = JSON.stringify(d);
    // The values behind those names, had they been read, look like this.
    expect(json).not.toContain('sk_live');
    expect(json).not.toContain('postgres://');
    expect(d.seedVarNames).toEqual(['STRIPE_SECRET_KEY', 'DATABASE_URL']);
  });

  test('an unreadable .env is said out loud rather than seeded as empty', () => {
    const d = buildBranchCreateData(
      { ...CREATE, seedVarNames: [], seedUnreadable: true },
      'n',
    );
    expect(d.seedUnreadable).toBe(true);
    // Distinct from a directory whose .env simply has nothing in it.
    expect(buildBranchCreateData({ ...CREATE, seedVarNames: [] }, 'n').seedUnreadable).toBeUndefined();
  });

  test('both questions say how they are answered without a browser', () => {
    const d = buildBranchCreateData(CREATE, 'n');
    expect(d.nonTty?.name?.command).toBe('capy checkout -b release');
    // `--no-protected` exists and commander binds it to false, so an
    // unprotected branch IS reachable headlessly. The escape has to say the
    // flag that works, not the one that used to.
    expect(d.nonTty?.protection?.command).toBe('capy checkout -b release --no-protected');
    expect(d.nonTty?.protection?.why).toContain('--protected');
  });

  test('no terminal escape reaches the payload', () => {
    const d = buildBranchCreateData({ ...CREATE, projectName: '\x1b[1mmikes-market\x1b[0m' }, 'n');
    expect(d.projectName).toBe('mikes-market');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });
});

describe('branchNameProblem', () => {
  test('names the CLI and the screen both refuse', () => {
    expect(branchNameProblem('', EXISTING)).toBe('Branch name cannot be empty');
    expect(branchNameProblem('   ', EXISTING)).toBe('Branch name cannot be empty');
    expect(branchNameProblem('my branch', EXISTING)).toBe(
      'Branch names cannot contain spaces or line breaks',
    );
    // Commander reads a leading hyphen as an option, so `-wip` could never be
    // checked out from a command line again.
    expect(branchNameProblem('-wip', EXISTING)).toBe('Branch names cannot start with a hyphen');
  });

  test('a taken name says what kind of branch took it', () => {
    expect(branchNameProblem('development', EXISTING)).toBe(
      'development already exists in this project',
    );
    expect(branchNameProblem('production', EXISTING)).toBe(
      'production already exists in this project, as a protected branch',
    );
  });

  test('a usable name has no problem', () => {
    expect(branchNameProblem('release', EXISTING)).toBeUndefined();
    expect(branchNameProblem('  release  ', EXISTING)).toBeUndefined();
  });
});

describe('createBranchInBrowser', () => {
  test('the protection answer comes back and the page is the compiled screen', async () => {
    let url = '';
    const done = createBranchInBrowser({ ...CREATE, onListen: (u) => (url = u) });

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const page = await (await fetch(u.href)).text();
    expect(page).toContain('window.__CAPY_DATA__');
    expect(page).toContain('mikes-market');
    // Served whole: no wizard shell wrapped around it.
    expect(page).not.toContain('id="screen"');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', isProtected: true } }),
    });

    expect(await done).toEqual({ name: 'release', isProtected: true, cancelled: false });
  });

  test('an unnamed run asks both questions, in the order the plan declared', async () => {
    let url = '';
    const done = createBranchInBrowser({ ...CREATE, branchName: '  ', onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const first = await (await fetch(u.href)).text();
    expect(first).toContain('Name the branch');

    // Answering the name does not finish the run: it advances, and the browser
    // is told to come back for the next whole document.
    const advanced = await (
      await fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload: { __action: 'submit', name: 'release' } }),
      })
    ).json();
    expect(advanced).toEqual({ next: true });

    // The same URL now serves the SECOND stop, with the first one settled.
    const second = await (await fetch(u.href)).text();
    expect(second).toContain('Protect this branch?');
    expect(second).toContain('release');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', isProtected: false } }),
    });
    expect(await done).toEqual({ name: 'release', isProtected: false, cancelled: false });
  });

  test('a name the screen holds its button on is refused, not posted', async () => {
    // The screen already knows `development` is taken — it holds the branch
    // list — so this can only arrive from something that is not that screen.
    // Creating it anyway means the server's prose, after a round trip.
    let url = '';
    let resolved = false;
    const done = createBranchInBrowser({ ...CREATE, branchName: '', onListen: (u) => (url = u) });
    void done.then(() => (resolved = true));

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', name: 'development' } }),
    });
    // Inline refusal: 200 with an error keeps the user on the step.
    expect(res.status).toBe(200);
    expect((await res.json()).error).toBe('development already exists in this project');
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect((await done).cancelled).toBe(true);
  });

  test('a protection answer that is not a boolean is refused', async () => {
    // Guessing here would decide who can reach this branch, which is the one
    // security setting the flow exists to set.
    let url = '';
    const done = createBranchInBrowser({ ...CREATE, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', isProtected: 'protected' } }),
    });
    expect((await res.json()).error).toContain('not an answer');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', isProtected: false } }),
    });
    expect(await done).toEqual({ name: 'release', isProtected: false, cancelled: false });
  });

  test('cancelling creates nothing and says so', async () => {
    let url = '';
    const done = createBranchInBrowser({ ...CREATE, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });

    expect(await done).toEqual({ name: 'release', isProtected: false, cancelled: true });
  });
});

describe('buildBranchListData', () => {
  test('protection is read off is_protected, never off the name', () => {
    const d = buildBranchListData(LIST, 'n');
    expect(d.branches.find((b) => b.name === 'production')!.isProtected).toBe(false);
    expect(d.branches.find((b) => b.name === 'spike')!.isProtected).toBe(true);
  });

  test('the current row is the one this directory is on', () => {
    const d = buildBranchListData(LIST, 'n');
    expect(d.branches.filter((b) => b.isCurrent).map((b) => b.name)).toEqual(['development']);
    // Null means the CLI could not tell, so no row may claim to be current.
    const unknown = buildBranchListData({ ...LIST, activeBranch: null }, 'n');
    expect(unknown.branches.some((b) => b.isCurrent)).toBe(false);
  });

  test('a protected branch is still offered, because the grant is not knowable here', () => {
    // The server's branch list carries no per-caller grant. `false` would read
    // as knowledge this CLI does not have and would lock out a member who
    // holds one — the terminal picker offers every branch and lets the 403
    // say the accurate thing.
    const d = buildBranchListData(LIST, 'n');
    expect(d.branches.every((b) => b.canSwitch)).toBe(true);
  });

  test('counts come from keep.lock and are omitted where it has none', () => {
    const d = buildBranchListData({ ...LIST, variableCounts: { development: 14 } }, 'n');
    expect(d.branches.find((b) => b.name === 'development')!.variableCount).toBe(14);
    // Absent rather than zero: "no count" and "no variables" are different claims.
    expect(d.branches.find((b) => b.name === 'spike')!.variableCount).toBeUndefined();
  });

  test('age is the CLI\'s own wording, and absent without a timestamp', () => {
    const d = buildBranchListData({ ...LIST, now: new Date('2026-07-30T12:00:00.000Z') }, 'n');
    expect(d.branches.find((b) => b.name === 'development')!.age).toBe('created 3 hours ago');
    expect(d.branches.find((b) => b.name === 'production')!.age).toBeUndefined();
  });

  test('a checkout may not delete, and says how to switch without a browser', () => {
    const d = buildBranchListData(LIST, 'n');
    expect(d.canDelete).toBe(false);
    expect(d.nonTty?.command).toBe('capy checkout <branch>');
    // No drift count is claimed: checkout refuses to run with a dirty tree, so
    // by the time this is served there is nothing to count.
    expect(d.localChanges).toBeUndefined();
  });

  test('no terminal escape reaches the payload', () => {
    const d = buildBranchListData({ ...LIST, projectName: '\x1b[1mmikes-market\x1b[0m' }, 'n');
    expect(d.projectName).toBe('mikes-market');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });
});

describe('chooseBranchInBrowser', () => {
  test('picking a row hands the checkout a branch that exists', async () => {
    let url = '';
    const done = chooseBranchInBrowser({ ...LIST, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const page = await (await fetch(u.href)).text();
    expect(page).toContain('window.__CAPY_DATA__');
    expect(page).not.toContain('id="screen"');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'switch', branch: 'spike' } }),
    });

    expect(await done).toEqual({ branch: 'spike', cancelled: false });
  });

  test('a name the screen never offered is refused', async () => {
    // The answer is fed straight into a real checkout. A branch not in the
    // list the server sent did not come from the list the screen drew.
    let url = '';
    const done = chooseBranchInBrowser({ ...LIST, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'switch', branch: 'not-a-branch' } }),
    });
    expect((await res.json()).error).toContain('not in this project');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'switch', branch: 'spike' } }),
    });
    expect((await done).branch).toBe('spike');
  });

  test('deleting is refused: this run drew no delete control', async () => {
    // `capy checkout` has never deleted anything, so the screen renders no
    // such button. Acting on one would remove every secret on a branch off the
    // back of a submit the page could not have produced.
    let url = '';
    const done = chooseBranchInBrowser({ ...LIST, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'delete', branch: 'spike' } }),
    });
    expect((await res.json()).error).toContain('not part of capy checkout');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect((await done).cancelled).toBe(true);
  });

  test('switching to the branch this directory is already on is refused', async () => {
    let url = '';
    const done = chooseBranchInBrowser({ ...LIST, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'switch', branch: 'development' } }),
    });
    expect((await res.json()).error).toContain('already on that branch');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done;
  });

  test('cancelling switches nothing', async () => {
    let url = '';
    const done = chooseBranchInBrowser({ ...LIST, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });

    expect(await done).toEqual({ branch: '', cancelled: true });
  });
});
