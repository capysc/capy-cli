/**
 * `capy org --web`, served as the compiled `switch-organization` screen.
 *
 * The behaviour worth pinning is the one the terminal picker cannot have: the
 * list carries `hasLocalKey` per organization, so a row this device holds no
 * key for is refused in the row. The CLI re-scopes the session and prints
 * `Organization: {name}` BEFORE it checks, which means today you are
 * congratulated on a switch and then handed an error about a key you cannot
 * produce.
 *
 * The work between the two questions — re-scoping, listing projects — runs
 * inside the reducer, so a failure there is a refusal the user can answer by
 * picking a different row rather than a dead page behind a command that has
 * already given up.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildSwitchOrganizationData,
  nameFirstProjectInBrowser,
  switchOrganizationInBrowser,
} from '../../src/ui/selectWeb';
import { ORG_CREATE_STOP_IDS } from '../../src/core/onboardingPlan';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

function driver(pageUrl: string) {
  const u = new URL(pageUrl);
  const base = `http://127.0.0.1:${u.port}`;
  const nonce = u.searchParams.get('n') ?? '';
  return {
    page: async (): Promise<string> => (await fetch(pageUrl)).text(),
    post: async (payload: Record<string, unknown>) =>
      (
        await fetch(`${base}/submit`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ nonce, payload }),
        })
      ).json() as Promise<Record<string, unknown>>,
  };
}

const ORGS = [
  { id: 'o1', name: 'mikes-market', hasLocalKey: true },
  { id: 'o2', name: 'northwind', hasLocalKey: true },
  { id: 'o3', name: 'acme', hasLocalKey: false },
];

const FACTS = {
  signedInAs: 'mike@example.com',
  currentOrgId: 'o1',
  orgs: ORGS,
  hasKeepLock: true,
  defaultProjectName: 'storefront',
  firstBranchName: 'development',
};

const BASE = { ...FACTS, open: false };

describe('buildSwitchOrganizationData', () => {
  test('ships whether this device holds each organization\'s key', () => {
    const d = buildSwitchOrganizationData(FACTS, 'n');
    expect(d.mode).toBe('switch');
    expect(d.orgs.find((o) => o.id === 'o3')!.hasLocalKey).toBe(false);
    expect(d.currentOrgId).toBe('o1');
    expect(d.signedInAs).toBe('mike@example.com');
    expect(d.allowCreate).toBe(true);
  });

  test('declares the create branch and names which stops belong to it', () => {
    const d = buildSwitchOrganizationData(FACTS, 'n');
    expect(d.stops!.map((s) => s.id)).toEqual(['org', 'name', 'phrase', 'create', 'project']);
    expect(d.createStopIds).toEqual(ORG_CREATE_STOP_IDS);
    // Struck through until the create row is the one selected.
    for (const id of ORG_CREATE_STOP_IDS) {
      expect(d.stops!.find((s) => s.id === id)!.state).toBe('skipped');
    }
  });

  test('the project list only travels on the step that asks about it', () => {
    const projects = [{ id: 'p1', name: 'storefront' }];
    expect(buildSwitchOrganizationData(FACTS, 'n').projects).toBeUndefined();
    const asking = buildSwitchOrganizationData(
      { ...FACTS, state: { orgId: 'o2', projects } },
      'n',
    );
    expect(asking.view).toBe('project');
    expect(asking.projects).toEqual(projects);
    expect(asking.subjectOrgName).toBe('northwind');
  });

  test('an organization with no projects gets the first-project step', () => {
    const d = buildSwitchOrganizationData({ ...FACTS, state: { orgId: 'o2', projects: [] } }, 'n');
    expect(d.view).toBe('first-project');
    expect(d.defaultProjectName).toBe('storefront');
    // The CLI hardcodes this branch and never mentions it until a spinner line
    // has already scrolled past.
    expect(d.firstBranchName).toBe('development');
  });

  test('hasKeepLock describes the directory, not the route', () => {
    expect(buildSwitchOrganizationData(FACTS, 'n').hasKeepLock).toBe(true);
    expect(
      buildSwitchOrganizationData({ ...FACTS, hasKeepLock: false }, 'n').hasKeepLock,
    ).toBe(false);
  });

  test('renders no secret material — names and ids only', () => {
    const json = JSON.stringify(
      buildSwitchOrganizationData({ ...FACTS, state: { orgId: 'o2', projects: [] } }, 'n'),
    );
    expect(json).not.toContain('sk_');
    expect(json).not.toContain('capy:');
  });
});

describe('switchOrganizationInBrowser', () => {
  const listing = (projects: Array<{ id: string; name: string }>) => async () => ({
    ok: true as const,
    projects,
  });

  test('walks both stops: the organization, then the project', async () => {
    let url = '';
    const chosen: string[] = [];
    const done = switchOrganizationInBrowser({
      ...BASE,
      onOrgChosen: async (orgId) => {
        chosen.push(orgId);
        return { ok: true, projects: [{ id: 'p1', name: 'storefront' }] };
      },
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    // The rail is drawn whole before anything is answered.
    expect(await d.page()).toContain('"createStopIds"');

    expect(await d.post({ __action: 'switch', orgId: 'o2' })).toEqual({ next: true });
    expect(chosen).toEqual(['o2']);
    // Stop two arrives by navigation, at the same address.
    expect(await d.page()).toContain('"view":"project"');

    await d.post({ __action: 'select-project', projectId: 'p1' });
    expect(await done).toEqual({
      action: 'select-project',
      orgId: 'o2',
      projectId: 'p1',
      cancelled: false,
    });
  });

  test('an organization with no projects lands on naming the first one', async () => {
    let url = '';
    const done = switchOrganizationInBrowser({
      ...BASE,
      onOrgChosen: listing([]),
      onListen: (u) => (url = u),
    });
    const d = driver(await waitForUrl(() => url));
    await d.post({ __action: 'switch', orgId: 'o2' });
    expect(await d.page()).toContain('"view":"first-project"');

    await d.post({ __action: 'create-project', name: '  storefront  ' });
    expect(await done).toEqual({
      action: 'create-project',
      orgId: 'o2',
      projectName: 'storefront',
      cancelled: false,
    });
  });

  test('the create row resolves out rather than continuing here', async () => {
    // Naming an organization and writing down its recovery phrase is another
    // screen's job, and the CLI has to create the org before there is a project
    // list to ask about.
    let url = '';
    let listed = 0;
    const done = switchOrganizationInBrowser({
      ...BASE,
      onOrgChosen: async () => {
        listed++;
        return { ok: true, projects: [] };
      },
      onListen: (u) => (url = u),
    });
    const d = driver(await waitForUrl(() => url));
    await d.post({ __action: 'create' });
    expect(await done).toEqual({ action: 'create', cancelled: false });
    expect(listed).toBe(0);
  });

  test('the organization this directory is already on cannot be switched to', async () => {
    let url = '';
    let listed = 0;
    const done = switchOrganizationInBrowser({
      ...BASE,
      timeoutMs: 4_000,
      onOrgChosen: async () => {
        listed++;
        return { ok: true, projects: [] };
      },
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    const refused = await d.post({ __action: 'switch', orgId: 'o1' });
    expect(refused.error).toContain('already on mikes-market');
    expect(listed).toBe(0);
    await d.post({ __action: 'cancel' });
    await done;
  });

  test('an organization this device has no key for is refused, not switched into', async () => {
    // The screen disables the row. This is the same refusal on the CLI side,
    // and it is what stops the terminal's own sequence — announce the switch,
    // then fail on the key — from being reachable through the browser.
    let url = '';
    let listed = 0;
    const done = switchOrganizationInBrowser({
      ...BASE,
      timeoutMs: 4_000,
      onOrgChosen: async () => {
        listed++;
        return { ok: true, projects: [] };
      },
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    expect((await d.post({ __action: 'switch', orgId: 'o3' })).error).toContain(
      'no encryption key for acme',
    );
    expect(listed).toBe(0);
    await d.post({ __action: 'cancel' });
    await done;
  });

  test('a failed re-scope keeps the list on screen with the reason', async () => {
    let url = '';
    let calls = 0;
    const done = switchOrganizationInBrowser({
      ...BASE,
      onOrgChosen: async () =>
        ++calls === 1
          ? { ok: false, reason: 'Organization switch failed' }
          : { ok: true, projects: [{ id: 'p1', name: 'storefront' }] },
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    const refused = await d.post({ __action: 'switch', orgId: 'o2' });
    expect(refused.error).toBe('Organization switch failed');
    expect(refused.next).toBeUndefined();
    // Still the organization step, so another row is one click away.
    expect(await d.page()).toContain('"view":"org"');

    await d.post({ __action: 'switch', orgId: 'o2' });
    await d.post({ __action: 'select-project', projectId: 'p1' });
    expect((await done).action).toBe('select-project');
  });

  test('a project outside the chosen organization is refused', async () => {
    let url = '';
    const done = switchOrganizationInBrowser({
      ...BASE,
      timeoutMs: 4_000,
      onOrgChosen: listing([{ id: 'p1', name: 'storefront' }]),
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    await d.post({ __action: 'switch', orgId: 'o2' });
    expect((await d.post({ __action: 'select-project', projectId: 'p9' })).error).toContain(
      'not in this organization',
    );
    await d.post({ __action: 'cancel' });
    await done;
  });

  test('an organization outside the membership list is refused', async () => {
    let url = '';
    const done = switchOrganizationInBrowser({
      ...BASE,
      timeoutMs: 4_000,
      onOrgChosen: listing([]),
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    expect((await d.post({ __action: 'switch', orgId: 'o9' })).error).toContain(
      'not one you belong to',
    );
    await d.post({ __action: 'cancel' });
    await done;
  });

  test('cancelling switches nothing', async () => {
    let url = '';
    const done = switchOrganizationInBrowser({
      ...BASE,
      onOrgChosen: listing([]),
      onListen: (u) => (url = u),
    });
    const d = driver(await waitForUrl(() => url));
    await d.post({ __action: 'cancel' });
    expect(await done).toEqual({ action: 'cancel', cancelled: true });
  });
});

describe('nameFirstProjectInBrowser', () => {
  test('asks only for the name, on the organization that was just created', async () => {
    let url = '';
    const done = nameFirstProjectInBrowser({
      ...BASE,
      orgs: [{ id: 'new', name: 'northwind', hasLocalKey: true }],
      currentOrgId: undefined,
      orgId: 'new',
      onListen: (u) => (url = u),
    });
    const d = driver(await waitForUrl(() => url));
    expect(await d.page()).toContain('"view":"first-project"');
    await d.post({ __action: 'create-project', name: ' storefront ' });
    expect(await done).toBe('storefront');
  });

  test('cancelling is the browser\'s version of answering no', async () => {
    let url = '';
    const done = nameFirstProjectInBrowser({
      ...BASE,
      orgs: [{ id: 'new', name: 'northwind', hasLocalKey: true }],
      orgId: 'new',
      onListen: (u) => (url = u),
    });
    const d = driver(await waitForUrl(() => url));
    await d.post({ __action: 'cancel' });
    expect(await done).toBeNull();
  });

  test('an empty name is refused rather than sent to POST /projects', async () => {
    let url = '';
    const done = nameFirstProjectInBrowser({
      ...BASE,
      orgs: [{ id: 'new', name: 'northwind', hasLocalKey: true }],
      orgId: 'new',
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    const d = driver(await waitForUrl(() => url));
    expect((await d.post({ __action: 'create-project', name: '  ' })).error).toContain(
      'cannot be empty',
    );
    await d.post({ __action: 'cancel' });
    expect(await done).toBeNull();
  });
});
