/**
 * `capy deploy`'s twenty questions, served as compiled screens.
 *
 * Two things are checked here and they are different jobs. The `buildXData`
 * tests assert the SHAPE of each payload without standing a server up — that
 * the route is the CLI's, that the wording is the CLI's, and that no secret
 * value is in it. The reducer tests drive the real loopback and assert what the
 * CLI does with an answer, including every refusal: the screens hold their
 * buttons on all of these, so a submit that breaks one did not come from the
 * screen, and applying a guess would write a target that pushes somebody's
 * secrets somewhere.
 *
 * What must never appear: a decrypted value. Preflight runs before anything is
 * decrypted and these screens sit in the same window, so `sk_live_…` is used
 * throughout as a canary — if one ever reaches a payload these tests fail.
 */
import { describe, test, expect } from 'bun:test';
import { deployPlan } from '../../src/core/deployPlan';
import {
  buildDeployDestinationData,
  buildDeployPlanConfirmData,
  buildDeployRunResultData,
  buildDeployTargetSetupData,
  buildDeployTargetsData,
  buildDeployTokensData,
  chooseDeployDestinationInBrowser,
  chooseDeployTargetInBrowser,
  confirmDeployInBrowser,
  setUpDeployTargetInBrowser,
  showDeployTokensInBrowser,
  showScreenInBrowser,
  type WebDeployAdapterContext,
  type WebDeploySetupParams,
} from '../../src/ui/deployScreens';
import type { DeployPlanTarget, DeployTargetRow } from '../../src/ui/screens/contract';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

/**
 * Read a screen's payload back OUT of the document it was inlined into.
 *
 * Asserting that the HTML merely *contains* `window.__CAPY_DATA__` proves the
 * placeholder was replaced and nothing about what replaced it. This parses the
 * JSON the browser will actually parse, so a claim about what the page carries
 * is a claim about the page.
 */
function parseScreenData(html: string): any {
  const m = html.match(/window\.__CAPY_DATA__\s*=\s*(\{[\s\S]*?\});/);
  if (!m) throw new Error('no window.__CAPY_DATA__ assignment in the served document');
  // `<` is escaped on the way in so a payload string cannot close the script
  // element; JSON.parse reads `<` back as `<` on its own.
  return JSON.parse(m[1]);
}

/**
 * Serve one token screen and hand back the document a browser would get.
 *
 * The run is left as a refusal rather than answered: what is under test is the
 * markup, and the deadline is short enough that the server is gone before the
 * next test needs a port.
 */
async function fetchScreen(p: Record<string, unknown>): Promise<string> {
  let url = '';
  const done = showDeployTokensInBrowser({
    ...(p as any),
    timeoutMs: 1_500,
    onListen: (u: string) => (url = u),
  });
  const html = await (await fetch(await waitForUrl(() => url))).text();
  await done;
  return html;
}

/** Submit a payload to a running wizard and hand back the parsed answer. */
async function submit(u: URL, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ nonce: u.searchParams.get('n') ?? '', payload }),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// deploy-destination
// ---------------------------------------------------------------------------

const PLATFORMS = [
  {
    id: 'cloudflare-workers',
    name: 'Cloudflare Workers',
    hasConnector: true,
    connectorId: 'cf-worker',
    connectorLabel: 'Cloudflare Workers',
    connectorDetail: ['Server-side, runtime secrets pushed via wrangler secret bulk'],
  },
  {
    id: 'aws-ecs',
    name: 'AWS ECS',
    hasConnector: true,
    connectorId: 'aws-ssm',
    connectorLabel: 'AWS SSM Parameter Store',
    connectorDetail: ['One SecureString per var; ECS/task-def reads via valueFrom'],
  },
  { id: 'heroku', name: 'Heroku', hasConnector: false },
  { id: 'other', name: 'Other...', hasConnector: false },
];

describe('buildDeployDestinationData', () => {
  test('offers the CLI list verbatim, connector marker and all', () => {
    const d = buildDeployDestinationData({ platforms: PLATFORMS }, 'n');
    expect(d.step).toBe('platform');
    expect(d.platforms).toEqual(PLATFORMS);
    // `aws-ecs` deploys through an adapter that never says ECS again, and the
    // terminal picker never mentions that.
    expect(d.platforms.find((p) => p.id === 'aws-ecs')!.connectorLabel).toBe(
      'AWS SSM Parameter Store',
    );
  });

  test('a platform with no connector marks the mode question as skipped', () => {
    // The terminal skips it in silence, so a Heroku user never learns the
    // question exists and a Vercel user cannot tell if the flow is two stops
    // or nine.
    const d = buildDeployDestinationData({ platforms: PLATFORMS, platform: 'heroku' }, 'n');
    expect(d.stops.find((s) => s.id === 'mode')!.state).toBe('skipped');
    expect(d.stops.find((s) => s.id === 'platform')).toMatchObject({
      state: 'done',
      answer: 'Heroku',
    });
  });

  test('a connector platform stands on the mode question', () => {
    const d = buildDeployDestinationData(
      { platforms: PLATFORMS, platform: 'cloudflare-workers' },
      'n',
    );
    expect(d.step).toBe('mode');
    expect(d.stops.find((s) => s.id === 'mode')!.state).toBe('current');
    expect(d.platform!.connectorId).toBe('cf-worker');
  });

  test('a refused --platform is carried as argv, not as thirty-one ids', () => {
    const d = buildDeployDestinationData(
      {
        platforms: PLATFORMS,
        rejected: { argv: '--platform pancakes', message: 'is not a platform Capy knows.' },
      },
      'n',
    );
    expect(d.rejected!.argv).toBe('--platform pancakes');
    expect(d.step).toBe('platform');
  });

  test('the remembered answer is shown as one, and the route is whole', () => {
    const d = buildDeployDestinationData(
      { platforms: PLATFORMS, lastPlatform: 'aws-ecs' },
      'n',
    );
    expect(d.lastPlatform).toBe('aws-ecs');
    expect(d.stops).toHaveLength(10);
    expect(d.nonce).toBe('n');
  });
});

describe('chooseDeployDestinationInBrowser', () => {
  test('both stops are answered over one server', async () => {
    let url = '';
    const done = chooseDeployDestinationInBrowser({
      platforms: PLATFORMS,
      open: false,
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));

    // The page is the compiled screen itself, served whole.
    const page = await (await fetch(u.href)).text();
    expect(page).toContain('window.__CAPY_DATA__');
    expect(page).not.toContain('id="screen"');

    // …and the rail inside it is `deployPlan`'s, read back OUT of the served
    // document rather than out of the builder that made it. That is the only
    // form of this claim worth making: the array the browser gets and the
    // array `--json` emits are the same array.
    const served = parseScreenData(page);
    expect(served.stops).toEqual(deployPlan({ at: 'platform' }));
    expect((served.stops as Array<{ id: string }>).map((s) => s.id)).toEqual([
      'platform',
      'mode',
      'signin',
      'branch',
      'settings',
      'variables',
      'delivery',
      'name',
      'review',
      'deploy',
    ]);

    const first = await submit(u, { __action: 'submit', platform: 'cloudflare-workers' });
    // A continuing run answers `next`, and the browser reloads to receive it.
    expect(first.body.next).toBe(true);

    await submit(u, { __action: 'submit', mode: 'token' });
    expect(await done).toEqual({
      platform: 'cloudflare-workers',
      mode: 'token',
      cancelled: false,
    });
  });

  test('a platform with no connector finishes on the first stop', async () => {
    let url = '';
    const done = chooseDeployDestinationInBrowser({
      platforms: PLATFORMS,
      open: false,
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    await submit(u, { __action: 'submit', platform: 'heroku' });
    // `null`, not a mode nobody chose: that question does not exist for Heroku.
    expect(await done).toEqual({ platform: 'heroku', mode: null, cancelled: false });
  });

  test('a platform the run never offered is refused, not written to config', async () => {
    let url = '';
    let settled = false;
    const done = chooseDeployDestinationInBrowser({
      platforms: PLATFORMS,
      timeoutMs: 4_000,
      open: false,
      onListen: (u) => (url = u),
    });
    void done.then(() => (settled = true)).catch(() => undefined);

    const u = new URL(await waitForUrl(() => url));
    const res = await submit(u, { __action: 'submit', platform: 'pancakes' });
    expect(res.status).toBe(200);
    expect(res.body.error).toContain('not one this run offers');
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    await submit(u, { __action: 'cancel' });
    expect((await done).cancelled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deploy-target-setup
// ---------------------------------------------------------------------------

const VARS = [
  { name: 'DATABASE_URL', buildTime: false, checked: true },
  { name: 'STRIPE_SECRET_KEY', buildTime: false, checked: true },
  { name: 'VITE_API_URL', buildTime: true, checked: false },
];

const CF_WORKER: WebDeployAdapterContext = {
  id: 'cf-worker',
  label: 'Cloudflare Workers',
  detail: ['Server-side, runtime secrets pushed via wrangler secret bulk'],
  detected: 'wrangler.toml → api',
  defaults: { workerName: 'api', workerDir: '.' },
  vars: VARS,
  presetLabel: 'non-public-prefixed',
  delivery: { mode: 'direct', prBase: 'main' },
  gitBranches: ['main', 'develop'],
  regionDetected: false,
  exampleVar: 'DATABASE_URL',
};

const VERCEL: WebDeployAdapterContext = {
  ...CF_WORKER,
  id: 'vercel',
  label: 'Vercel',
  detail: ['Pushes plaintext env vars; opens a keep.lock PR Vercel CI deploys on merge'],
  defaults: { projectDir: '.', vercelEnv: 'preview', gitBranch: '' },
  delivery: { mode: 'ci', prBase: 'main', ciOnly: true },
};

const SETUP: WebDeploySetupParams = {
  intent: 'create',
  steps: ['branch', 'settings', 'variables', 'delivery', 'name'],
  adapterId: 'cf-worker',
  capyBranches: ['development', 'production'],
  branch: 'production',
  existingNames: ['cf-worker-development'],
  resolveAdapter: async () => CF_WORKER,
  open: false,
};

describe('buildDeployTargetSetupData', () => {
  test('the rail marks the stops this run never visits', () => {
    // A preselected adapter means the platform question did not happen on this
    // command, and the mode question did not happen at all.
    const d = buildDeployTargetSetupData(SETUP, 'n', 'branch', CF_WORKER, {});
    expect(d.stops.find((s) => s.id === 'mode')!.state).toBe('skipped');
    expect(d.stops.find((s) => s.id === 'branch')!.state).toBe('current');
    expect(d.stops.find((s) => s.id === 'platform')).toMatchObject({
      state: 'done',
      answer: 'Cloudflare Workers',
    });
  });

  test('the settings step is built from the CLI\'s own defaults', () => {
    const d = buildDeployTargetSetupData(SETUP, 'n', 'settings', CF_WORKER, {
      branch: 'production',
    });
    expect(d.settings).toEqual({ kind: 'cf-worker', workerName: 'api', workerDir: '.' });
    expect(d.detected).toBe('wrangler.toml → api');
  });

  test('a Vercel Preview target is handed the real git refs, not capy branches', () => {
    // The failure this screen exists to stop: a GIT branch asked one prompt
    // after a CAPY branch, in almost the same words.
    const d = buildDeployTargetSetupData(
      { ...SETUP, adapterId: 'vercel', resolveAdapter: async () => VERCEL },
      'n',
      'settings',
      VERCEL,
      { branch: 'production' },
    );
    expect(d.settings).toMatchObject({ kind: 'vercel', env: 'preview', gitBranches: ['main', 'develop'] });
    expect(d.capyBranches).toEqual(['development', 'production']);
  });

  test('variables travel by NAME, with the build-time boundary marked', () => {
    const d = buildDeployTargetSetupData(SETUP, 'n', 'variables', CF_WORKER, {});
    expect(d.vars!.map((v) => v.name)).toEqual([
      'DATABASE_URL',
      'STRIPE_SECRET_KEY',
      'VITE_API_URL',
    ]);
    expect(d.vars!.find((v) => v.name === 'VITE_API_URL')!.buildTime).toBe(true);
    expect(d.presetLabel).toBe('non-public-prefixed');
    // No value, anywhere in the payload.
    expect(JSON.stringify(d)).not.toContain('sk_live');
    for (const v of d.vars!) expect(Object.keys(v)).not.toContain('value');
  });

  test('the rail shows what earlier steps answered, in the CLI\'s words', () => {
    const d = buildDeployTargetSetupData(SETUP, 'n', 'name', CF_WORKER, {
      branch: 'production',
      options: { workerName: 'api', workerDir: 'worker' },
      vars: ['DATABASE_URL'],
      mode: 'ci',
      gitBaseBranch: 'main',
    });
    const at = (id: string) => d.stops.find((s) => s.id === id)!;
    expect(at('branch').answer).toBe('production');
    expect(at('settings').answer).toBe('api in worker');
    // Counts agree with their nouns — the terminal's own plan block prints
    // `(1 secrets)`.
    expect(at('variables').answer).toBe('1 variable');
    expect(at('delivery').answer).toBe('CI');
    expect(at('name').state).toBe('current');
  });

  test('a re-confirm stands on the variables stop, not a stop of its own', () => {
    const d = buildDeployTargetSetupData(
      { ...SETUP, intent: 'reconfirm', steps: ['drift'] },
      'n',
      'drift',
      CF_WORKER,
      {},
    );
    expect(d.intent).toBe('reconfirm');
    expect(d.stops.find((s) => s.id === 'variables')!.state).toBe('current');
    // The stops this pass does not ask are skipped rather than left pending.
    expect(d.stops.find((s) => s.id === 'settings')!.state).toBe('skipped');
  });

  test('saved names travel so a silent overwrite can be caught first', () => {
    // `upsertTarget` keys by name and replaces without asking.
    const d = buildDeployTargetSetupData(SETUP, 'n', 'name', CF_WORKER, { branch: 'production' });
    expect(d.existingNames).toEqual(['cf-worker-development']);
    expect(d.name).toBe('cf-worker-production');
  });
});

describe('setUpDeployTargetInBrowser', () => {
  async function walk(
    params: Partial<WebDeploySetupParams> = {},
  ): Promise<{ u: URL; done: Promise<any> }> {
    let url = '';
    const done = setUpDeployTargetInBrowser({
      ...SETUP,
      ...params,
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);
    return { u: new URL(await waitForUrl(() => url)), done };
  }

  test('every step folds forward into one target', async () => {
    const { u, done } = await walk();
    await submit(u, { __action: 'submit', branch: 'production' });
    await submit(u, { __action: 'submit', workerName: 'api', workerDir: 'worker' });
    await submit(u, { __action: 'submit', vars: ['DATABASE_URL', 'STRIPE_SECRET_KEY'] });
    await submit(u, { __action: 'submit', mode: 'ci', gitBaseBranch: 'main' });
    await submit(u, { __action: 'submit', name: 'cf-worker-production' });

    expect(await done).toEqual({
      adapterId: 'cf-worker',
      branch: 'production',
      options: { workerName: 'api', workerDir: 'worker' },
      vars: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
      mode: 'ci',
      gitBaseBranch: 'main',
      name: 'cf-worker-production',
      cancelled: false,
    });
  });

  test('a target with no variables is refused — it has nothing to push', async () => {
    const { u, done } = await walk({ timeoutMs: 4_000 });
    await submit(u, { __action: 'submit', branch: 'production' });
    await submit(u, { __action: 'submit', workerName: 'api', workerDir: '.' });
    const res = await submit(u, { __action: 'submit', vars: [] });
    expect(res.body.error).toContain('Select at least one variable');
    await submit(u, { __action: 'cancel' });
    expect((await done).cancelled).toBe(true);
  });

  test('a variable this branch does not have never reaches the target', async () => {
    // The list is the branch's. Anything else did not come from the screen,
    // and a target that carries it deploys a name with nothing behind it.
    const { u, done } = await walk({ timeoutMs: 4_000 });
    await submit(u, { __action: 'submit', branch: 'production' });
    await submit(u, { __action: 'submit', workerName: 'api', workerDir: '.' });
    const res = await submit(u, { __action: 'submit', vars: ['DATABASE_URL', 'SOMEONE_ELSES'] });
    expect(res.body.error).toContain('does not have');
    await submit(u, { __action: 'cancel' });
    await done;
  });

  test('an empty worker name is refused with the CLI\'s own rule', async () => {
    const { u, done } = await walk({ timeoutMs: 4_000 });
    await submit(u, { __action: 'submit', branch: 'production' });
    const res = await submit(u, { __action: 'submit', workerName: '  ', workerDir: '.' });
    expect(res.body.error).toContain('name field in wrangler.toml');
    await submit(u, { __action: 'cancel' });
    await done;
  });

  test('a target name outside the config\'s key shape is refused', async () => {
    const { u, done } = await walk({ timeoutMs: 4_000 });
    await submit(u, { __action: 'submit', branch: 'production' });
    await submit(u, { __action: 'submit', workerName: 'api', workerDir: '.' });
    await submit(u, { __action: 'submit', vars: ['DATABASE_URL'] });
    await submit(u, { __action: 'submit', mode: 'direct' });
    const res = await submit(u, { __action: 'submit', name: 'Prod Target' });
    expect(res.body.error).toContain('lowercase letters');
    await submit(u, { __action: 'submit', name: 'prod-target' });
    expect((await done).name).toBe('prod-target');
  });

  test('a CI-only adapter refuses a direct deploy rather than pushing and hoping', async () => {
    const { u, done } = await walk({
      adapterId: 'vercel',
      resolveAdapter: async () => VERCEL,
      timeoutMs: 4_000,
    });
    await submit(u, { __action: 'submit', branch: 'production' });
    await submit(u, { __action: 'submit', projectDir: '.', vercelEnv: 'preview', gitBranch: 'develop' });
    await submit(u, { __action: 'submit', vars: ['DATABASE_URL'] });
    const res = await submit(u, { __action: 'submit', mode: 'direct' });
    expect(res.body.error).toContain('always deploys through CI');
    await submit(u, { __action: 'cancel' });
    await done;
  });

  test('a Vercel Preview with no git branch is refused, not sent blank', async () => {
    // A Preview environment scoped to nothing means every variable lands
    // somewhere nothing reads them.
    const { u, done } = await walk({
      adapterId: 'vercel',
      resolveAdapter: async () => VERCEL,
      timeoutMs: 4_000,
    });
    await submit(u, { __action: 'submit', branch: 'production' });
    const res = await submit(u, { __action: 'submit', projectDir: '.', vercelEnv: 'preview' });
    expect(res.body.error).toContain('git branch, not a capy branch');

    // Production is not branch-scoped, so the field is dropped rather than
    // sent empty — the CLI deletes the key for the same reason.
    await submit(u, { __action: 'submit', projectDir: '.', vercelEnv: 'production' });
    await submit(u, { __action: 'submit', vars: ['DATABASE_URL'] });
    await submit(u, { __action: 'submit', mode: 'ci', gitBaseBranch: 'main' });
    await submit(u, { __action: 'submit', name: 'vercel-prod' });
    const out = await done;
    expect(out.options).toEqual({ projectDir: '.', vercelEnv: 'production' });
  });

  test('cancelling creates nothing', async () => {
    const { u, done } = await walk();
    await submit(u, { __action: 'cancel' });
    expect((await done).cancelled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deploy-plan-confirm
// ---------------------------------------------------------------------------

const PLAN: DeployPlanTarget = {
  name: 'cf-worker-production',
  adapterId: 'cf-worker',
  adapterLabel: 'Cloudflare Workers',
  branch: 'production',
  mode: 'direct',
  options: [
    { key: 'workerName', value: 'api' },
    { key: 'workerDir', value: '.' },
  ],
  vars: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
  saved: true,
};

const CONFIRM = {
  target: PLAN,
  action: 'direct' as const,
  dryRun: false,
  preflight: [
    { id: 'preflight', label: 'Cloudflare Workers preflight', state: 'ok' as const },
  ],
  signedIn: true,
  open: false,
};

describe('buildDeployPlanConfirmData', () => {
  test('renders variable names and no value — nothing is decrypted yet', () => {
    const d = buildDeployPlanConfirmData(CONFIRM, 'n');
    expect(d.target.vars).toEqual(['DATABASE_URL', 'STRIPE_SECRET_KEY']);
    const json = JSON.stringify(d);
    expect(json).not.toContain('sk_live');
    expect(json).not.toContain('postgres://');
  });

  test('the gate stands on review, with everything behind it answered', () => {
    const d = buildDeployPlanConfirmData(CONFIRM, 'n');
    const at = (id: string) => d.stops.find((s) => s.id === id)!;
    expect(at('review').state).toBe('current');
    expect(at('platform').answer).toBe('Cloudflare Workers');
    expect(at('branch').answer).toBe('production');
    expect(at('variables').answer).toBe('2 variables');
    expect(at('delivery').answer).toBe('Direct');
    expect(at('name').answer).toBe('cf-worker-production');
  });

  test('sign-in is only claimed once preflight has passed', () => {
    // Preflight is the only place Capy learns whether the vendor session the
    // user established by hand exists.
    const ok = buildDeployPlanConfirmData(CONFIRM, 'n');
    expect(ok.stops.find((s) => s.id === 'signin')).toMatchObject({
      state: 'done',
      answer: 'wrangler login',
      manual: true,
    });
    const failed = buildDeployPlanConfirmData(
      {
        ...CONFIRM,
        signedIn: false,
        preflight: [
          {
            id: 'preflight',
            label: 'Cloudflare Workers preflight',
            state: 'fail',
            detail: 'wrangler not found',
            fix: 'npm i -g wrangler',
          },
        ],
      },
      'n',
    );
    expect(failed.stops.find((s) => s.id === 'signin')!.state).toBe('upcoming');
    // Every check keeps its row, with the shell that fixes it.
    expect(failed.preflight[0].fix).toBe('npm i -g wrangler');
  });

  test('an ad-hoc target skips the naming stop it never visited', () => {
    // Built on the fly from `--target`, never written to disk, never named.
    const d = buildDeployPlanConfirmData(
      { ...CONFIRM, target: { ...PLAN, saved: false } },
      'n',
    );
    expect(d.stops.find((s) => s.id === 'name')!.state).toBe('skipped');
    expect(d.target.saved).toBe(false);
  });

  test('a dry run draws the terminus blank', () => {
    const d = buildDeployPlanConfirmData({ ...CONFIRM, dryRun: true }, 'n');
    expect(d.dryRun).toBe(true);
    expect(d.stops.find((s) => s.id === 'deploy')!.blank).toBe(true);
  });

  test('both headless escapes are named, including the destructive one', () => {
    // A view offering a destructive action with no headless equivalent leaves
    // an agent to reach for the one it can see, and the one it can see deploys.
    const d = buildDeployPlanConfirmData(CONFIRM, 'n');
    expect(d.nonTty!.command).toBe('capy deploy cf-worker-production --yes');
    expect(d.deleteNonTty!.command).toBe(
      'capy deploy targets-remove cf-worker-production',
    );
  });
});

describe('confirmDeployInBrowser', () => {
  test('confirming carries the change-gate switch back', async () => {
    let url = '';
    const done = confirmDeployInBrowser({
      ...CONFIRM,
      changeGate: { baseBranch: 'main', changed: false },
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    await submit(u, { __action: 'submit', decision: 'deploy', force: true });
    expect(await done).toEqual({ decision: 'deploy', force: true, cancelled: false });
  });

  test('edit is an answer the CLI acts on, not an exit', async () => {
    let url = '';
    const done = confirmDeployInBrowser({ ...CONFIRM, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    await submit(u, { __action: 'submit', decision: 'edit' });
    expect(await done).toEqual({ decision: 'edit', force: false, cancelled: false });
  });

  test('a delete naming a different target is refused', async () => {
    // The screen holds its button until the name has been typed back, so this
    // can only arrive from something that is not the screen — and the settings
    // behind that name took seven prompts to produce.
    let url = '';
    const done = confirmDeployInBrowser({
      ...CONFIRM,
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const res = await submit(u, {
      __action: 'submit',
      decision: 'delete',
      target: 'some-other-target',
    });
    expect(res.body.error).toContain('not the target this page is about');
    await submit(u, { __action: 'submit', decision: 'delete', target: PLAN.name });
    expect((await done).decision).toBe('delete');
  });

  test('the change gate takes a deploy and nothing else', async () => {
    // It is asked after the plan was approved and after the secrets were
    // decrypted: there is no picker left to re-enter.
    let url = '';
    const done = confirmDeployInBrowser({
      ...CONFIRM,
      changeGate: { baseBranch: 'main', changed: false },
      allow: ['deploy'],
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const res = await submit(u, { __action: 'submit', decision: 'edit' });
    expect(res.body.error).toContain('not available at this point');
    await submit(u, { __action: 'cancel' });
    // Cancelling the force question is the CLI's own default of false.
    expect(await done).toEqual({ decision: null, force: false, cancelled: true });
  });

  test('cancelling deploys nothing and says so', async () => {
    let url = '';
    const done = confirmDeployInBrowser({ ...CONFIRM, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    await submit(u, { __action: 'cancel' });
    expect(await done).toEqual({ decision: null, force: false, cancelled: true });
  });
});

// ---------------------------------------------------------------------------
// deploy-targets
// ---------------------------------------------------------------------------

const ROWS: DeployTargetRow[] = [
  {
    name: 'cf-worker-production',
    kind: 'cf-worker',
    adapterLabel: 'Cloudflare Workers',
    branch: 'production',
    mode: 'direct',
    options: [{ key: 'workerName', value: 'api' }],
    vars: ['DATABASE_URL'],
  },
  {
    name: 'legacy',
    kind: 'cf-worker',
    adapterLabel: 'Cloudflare Workers',
    branch: 'development',
    options: [],
    vars: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
    drift: { added: ['NEW_TOKEN'], removed: [] },
  },
];

const TARGETS = {
  projectName: 'mikes-market',
  configPath: '/repo/.capy/deploy.json',
  purpose: 'pick' as const,
  targets: ROWS,
  allow: ['use', 'new'] as const,
  open: false,
};

describe('buildDeployTargetsData', () => {
  test('carries mode and PR base, which the printed listing omits', () => {
    // A target saved before `mode` existed resolves to `direct` — the
    // irreversible one — with no marker anywhere in the terminal listing.
    const d = buildDeployTargetsData(TARGETS, 'n');
    expect(d.targets.find((t) => t.name === 'legacy')!.mode).toBeUndefined();
    expect(d.targets.find((t) => t.name === 'cf-worker-production')!.mode).toBe('direct');
    expect(d.configPath).toBe('/repo/.capy/deploy.json');
  });

  test('drift is surfaced in the listing, not only mid-deploy', () => {
    const d = buildDeployTargetsData(TARGETS, 'n');
    expect(d.targets.find((t) => t.name === 'legacy')!.drift).toEqual({
      added: ['NEW_TOKEN'],
      removed: [],
    });
  });

  test('names only — this file never holds a value', () => {
    const json = JSON.stringify(buildDeployTargetsData(TARGETS, 'n'));
    expect(json).not.toContain('sk_live');
    expect(json).toContain('DATABASE_URL');
  });

  test('the removal has its own headless escape', () => {
    const d = buildDeployTargetsData(TARGETS, 'n');
    expect(d.nonTtyRemove!.command).toBe('capy deploy targets-remove <name>');
  });
});

describe('chooseDeployTargetInBrowser', () => {
  test('a picked row is resolved against the list the server sent', async () => {
    let url = '';
    const done = chooseDeployTargetInBrowser({ ...TARGETS, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    await submit(u, { __action: 'use', target: 'legacy' });
    expect(await done).toEqual({ action: 'use', target: 'legacy', cancelled: false });
  });

  test('a target this project does not have is refused', async () => {
    let url = '';
    const done = chooseDeployTargetInBrowser({
      ...TARGETS,
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const res = await submit(u, { __action: 'use', target: 'ghost' });
    expect(res.body.error).toContain('not saved for this project');
    await submit(u, { __action: 'cancel' });
    await done;
  });

  test('an action this run cannot take is refused, not performed', async () => {
    // A pick is answering "which target?". Removing one from that page would
    // be a destructive act nothing on the run asked for.
    let url = '';
    const done = chooseDeployTargetInBrowser({
      ...TARGETS,
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const res = await submit(u, { __action: 'remove', target: 'legacy' });
    expect(res.body.error).toContain('not something this run can do');
    await submit(u, { __action: 'cancel' });
    await done;
  });

  test('an unanswered listing ENDS as a refusal — it does not reject', async () => {
    // The twin of the same test on `deploy-tokens`, and the half that was
    // missed. This screen has no control that posts a decline either, so
    // silence is the only signal a refusal ever produces — and silence used to
    // come out of here as a throw, five minutes later, at all three call
    // sites: `capy deploy targets --web`, `capy deploy targets-remove <name>
    // --web`, and the "which target?" pick inside `capy deploy --web`.
    const started = Date.now();
    const out = await chooseDeployTargetInBrowser({
      ...TARGETS,
      timeoutMs: 400,
      onListen: () => undefined,
    });
    expect(out).toEqual({ action: null, target: '', cancelled: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('the confirm-remove view carries the bridge, and the listing does not', async () => {
    // The bridge answers ONE question — "remove this target?" — so it is
    // fitted only where that question is the whole run. On the listing, backing
    // out of a remove leaves the user on a page they still have business with.
    let url = '';
    const confirm = chooseDeployTargetInBrowser({
      ...TARGETS,
      view: 'confirm-remove',
      subjectTarget: 'legacy',
      timeoutMs: 1_500,
      onListen: (u) => (url = u),
    });
    const withBridge = await (await fetch(await waitForUrl(() => url))).text();
    await confirm;
    expect(withBridge).toContain('.callout.danger');
    expect(withBridge).toContain('__action');
    // It names what survives the decline, and never a value.
    expect(withBridge).toContain('/repo/.capy/deploy.json');
    expect(withBridge).not.toContain('sk_live');

    url = '';
    const listing = chooseDeployTargetInBrowser({
      ...TARGETS,
      timeoutMs: 1_500,
      onListen: (u) => (url = u),
    });
    const plain = await (await fetch(await waitForUrl(() => url))).text();
    await listing;
    expect(plain).not.toContain('.callout.danger');
  });
});

// ---------------------------------------------------------------------------
// deploy-tokens
// ---------------------------------------------------------------------------

const TOKENS = {
  projectName: 'mikes-market',
  tokens: [
    {
      deployId: 'a1b2c3d4e5f6a7b8c9d0',
      label: 'ci',
      createdAge: '3 days ago',
      createdOn: '2026-07-27',
      revokedAge: null,
    },
    {
      deployId: 'ffeeddccbbaa99887766',
      label: null,
      createdAge: '2 months ago',
      createdOn: '2026-05-20',
      revokedAge: '1 month ago',
    },
  ],
  open: false,
};

describe('buildDeployTokensData', () => {
  test('a deploy id is an identifier, and no credential rides along', () => {
    // The token itself is never returned by the service after minting; what is
    // listed is its id.
    const d = buildDeployTokensData(TOKENS, 'n');
    expect(d.tokens[0].deployId).toBe('a1b2c3d4e5f6a7b8c9d0');
    const json = JSON.stringify(d);
    expect(json).not.toContain('SECRETS_BLOB');
    expect(json).not.toContain('sk_live');
  });

  test('a project with no name is null rather than the string "undefined"', () => {
    // The CLI interpolates the field unguarded and prints
    // `Deploy tokens for "undefined":`.
    expect(buildDeployTokensData({ ...TOKENS, projectName: null }, 'n').projectName).toBeNull();
  });

  test('revoking has its own headless escape', () => {
    expect(buildDeployTokensData(TOKENS, 'n').nonTtyRevoke!.command).toBe(
      'capy deploy revoke <deployId>',
    );
  });
});

describe('showDeployTokensInBrowser', () => {
  test('a revoke comes back as the full id, not the twelve-character prefix', async () => {
    // Two tokens can share twelve characters, and the service resolves a
    // prefix server-side.
    let url = '';
    const done = showDeployTokensInBrowser({ ...TOKENS, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    await submit(u, { action: 'revoke', deployId: 'a1b2c3d4e5f6a7b8c9d0' });
    expect(await done).toEqual({ deployId: 'a1b2c3d4e5f6a7b8c9d0', cancelled: false });
  });

  test('a token this project does not hold is refused', async () => {
    let url = '';
    let settled = false;
    const done = showDeployTokensInBrowser({
      ...TOKENS,
      timeoutMs: 1_500,
      onListen: (u) => (url = u),
    });
    void done.then(() => (settled = true)).catch(() => undefined);
    const u = new URL(await waitForUrl(() => url));
    const res = await submit(u, { action: 'revoke', deployId: 'deadbeef' });
    expect(res.body.error).toContain('not one this project has');
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    // The listing has no exit of its own: leaving it revokes nothing.
    await done.catch(() => undefined);
  });

  test('an unanswered listing ENDS as a refusal — it does not reject', async () => {
    // The screen has no control that posts a decline, so silence is the only
    // signal a refusal ever produces. Silence used to reject, which
    // `capy deploy revoke --web` turned into an error screen and a non-zero
    // exit for a user who had chosen not to revoke.
    const started = Date.now();
    const out = await showDeployTokensInBrowser({
      ...TOKENS,
      timeoutMs: 400,
      onListen: () => undefined,
    });
    expect(out).toEqual({ deployId: null, cancelled: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('the `cancel` vocabulary is the one the page actually sends', async () => {
    // Not a shape invented here. The confirm view's decline posts nothing of
    // its own, so `withDeclineBridge` posts this on its behalf the moment the
    // question leaves the document — and when the screen grows the control it
    // should have (packages/ui: "Leave it active", plus a "Done" on the
    // listing), it posts the same thing and the bridge becomes dead weight.
    // `tests/ui/browserFlow.e2e.test.ts` clicks the real button.
    let url = '';
    const done = showDeployTokensInBrowser({ ...TOKENS, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    await submit(u, { __action: 'cancel' });
    expect(await done).toEqual({ deployId: null, cancelled: true });
  });

  test('the confirm view carries the bridge, and the listing does not', async () => {
    // The bridge answers ONE question — "revoke this token?" — so it is fitted
    // only where that question is the whole run. On `capy deploy list --web`
    // the same click walks back to a listing the user may still want, and
    // ending the run there would be answering something nobody asked.
    const confirm = await fetchScreen({
      ...TOKENS,
      view: 'confirm-revoke' as const,
      subjectToken: 'a1b2c3d4e5f6a7b8c9d0',
    });
    expect(confirm).toContain('__action');
    expect(confirm).toContain('.callout.danger');

    const listing = await fetchScreen(TOKENS);
    expect(listing).not.toContain('.callout.danger');
  });
});

// ---------------------------------------------------------------------------
// deploy-run-result
// ---------------------------------------------------------------------------

describe('buildDeployRunResultData', () => {
  test('strips the terminal colours off the step log', () => {
    const d = buildDeployRunResultData({
      outcome: 'opened-pr',
      projectName: '\x1b[1mmikes-market\x1b[0m',
      target: {
        name: 'vercel-prod',
        adapterLabel: 'Vercel',
        branch: 'production',
        mode: 'ci',
        prBase: 'main',
      },
      steps: [
        {
          id: '0',
          label: 'set Vercel env',
          status: 'ok',
          detail: '\x1b[90m12 variables pushed\x1b[0m',
        },
      ],
    });
    expect(d.projectName).toBe('mikes-market');
    expect(d.steps[0].detail).toBe('12 variables pushed');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });

  test('a run that pushed secrets still reports no value', () => {
    const d = buildDeployRunResultData({
      outcome: 'deployed',
      projectName: 'mikes-market',
      target: { name: 'api', adapterLabel: 'Cloudflare Workers', branch: 'production', mode: 'direct' },
      steps: [{ id: '0', label: 'wrangler secret bulk', status: 'ok', detail: '6 pushed' }],
    });
    const json = JSON.stringify(d);
    expect(json).not.toContain('sk_live');
    expect(json).toContain('6 pushed');
  });

  test('the colours come off every field, not just the ones with a strip call', () => {
    // Each of these is a string the CLI also PRINTS, so each arrives coloured
    // and each renders as a literal `[1m` in the browser. The target NAME is
    // deliberately not rewritten — it is an identifier — so nothing here
    // colours it.
    const d = buildDeployRunResultData({
      outcome: 'failed',
      projectName: 'mikes-market',
      target: {
        name: 'vercel-prod',
        adapterLabel: '\x1b[1mVercel\x1b[0m',
        branch: 'production',
        mode: 'ci',
      },
      steps: [
        {
          id: '0',
          label: '\x1b[31mvercel env add\x1b[0m',
          status: 'fail',
          detail: '\x1b[90mexit 1\x1b[0m',
          output: '\x1b[31mError: not linked\x1b[0m',
        },
      ],
      epilogue: {
        title: '\x1b[1mNext steps\x1b[0m',
        snippet: '\x1b[90mvercel link\x1b[0m',
        note: '\x1b[90mrun it in this directory\x1b[0m',
      },
    });
    expect(d.target.adapterLabel).toBe('Vercel');
    expect(d.steps[0].output).toBe('Error: not linked');
    expect(d.epilogue).toEqual({
      title: 'Next steps',
      snippet: 'vercel link',
      note: 'run it in this directory',
    });
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });
});

// ---------------------------------------------------------------------------
// showScreenInBrowser — the display-only serve
// ---------------------------------------------------------------------------

const RUN_RESULT = {
  outcome: 'deployed' as const,
  projectName: 'mikes-market',
  target: {
    name: 'api',
    adapterLabel: 'Cloudflare Workers',
    branch: 'production',
    mode: 'direct' as const,
  },
  steps: [{ id: '0', label: 'wrangler secret bulk', status: 'ok' as const, detail: '6 pushed' }],
};

describe('showScreenInBrowser', () => {
  test('the run WAITS for the page: it is not served and abandoned', async () => {
    // The failure this exists to catch: a call site that starts a server and
    // returns has proved a socket was listening and nothing else. The process
    // goes on to exit and the page dies before a browser can fetch it — and
    // this is the LAST thing a deploy does, so that is exactly the window.
    let url = '';
    let finished = false;
    const done = showScreenInBrowser('deploy-run-result', RUN_RESULT, {
      open: false,
      timeoutMs: 20_000,
      onListen: (u) => (url = u),
    });
    void done.then(() => (finished = true));

    const u = await waitForUrl(() => url);
    await new Promise((r) => setTimeout(r, 50));
    expect(finished).toBe(false);

    const res = await fetch(u);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('window.__CAPY_DATA__');

    await done;
    expect(finished).toBe(true);
  });

  test('a page with nothing to say back is given no way to speak', async () => {
    // `connect-src 'none'`: a page that cannot open a socket cannot exfiltrate
    // what it renders, whatever ends up in its markup.
    let url = '';
    const done = showScreenInBrowser('deploy-run-result', RUN_RESULT, {
      open: false,
      timeoutMs: 20_000,
      onListen: (u) => (url = u),
    });
    const res = await fetch(await waitForUrl(() => url));
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    await done;
  });

  test('the address is single-use, and a guessed one is a 404', async () => {
    let url = '';
    const done = showScreenInBrowser('deploy-run-result', RUN_RESULT, {
      open: false,
      timeoutMs: 20_000,
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));

    // A token nobody was given.
    const wrong = await fetch(`http://127.0.0.1:${u.port}/s/aaaaaaaaaaaa`);
    expect(wrong.status).toBe(404);
    // The real one, once.
    expect((await fetch(u.href)).status).toBe(200);
    await done;

    // …and not twice. The server is gone by now, so either answer is a refusal.
    const again = await fetch(u.href).catch(() => null);
    expect(again === null || again.status === 404).toBe(true);
  });

  test('nobody coming is an ending, not a hang', async () => {
    // The deadline is what closes the socket AND settles the promise. A deploy
    // that already happened must not be held open by a page nobody opened.
    const started = Date.now();
    await showScreenInBrowser('deploy-run-result', RUN_RESULT, {
      open: false,
      timeoutMs: 300,
      onListen: () => undefined,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
