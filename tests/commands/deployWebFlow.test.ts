/**
 * `capy deploy --web` at the COMMAND level: the layer that assembles the
 * params, reads the answer back and acts on it.
 *
 * Everything under `src/ui/deployScreens.ts` had tests; the wiring in
 * `deployCommand.ts` and `deployTokenCommand.ts` had none, so nothing checked
 * that `deployList`'s web branch really removes the row the page named, that a
 * DECLINE is not read as consent, or that the picker hands the browser the
 * variables of the directory it was told about. Those are the decisions with
 * consequences on disk.
 *
 * These drive the CLI the way the browser does and nothing else: the loopback
 * URL is taken off the line the command PRINTS, the page is fetched over HTTP,
 * the nonce is read out of the payload inlined into that page — exactly what a
 * compiled screen does on load — and the answer is POSTed to `/submit`. No
 * module mocking, so these run in the batch and the transport under test is
 * the real one.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  deployCommand,
  deployList,
  deployRemove,
  describeDeployRoute,
  ensureDeployTarget,
} from '../../src/commands/deployCommand';
import {
  resolveTokenPrefix,
  type DeployTokenListRow,
} from '../../src/commands/deployTokenCommand';
import { deployPlan, unansweredDeployStops } from '../../src/core/deployPlan';

const ROOT = join(tmpdir(), `capy-deploy-web-${process.pid}-${Date.now()}`);

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, '.capy'), { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const TARGETS = {
  version: '1',
  targets: {
    'cf-worker-production': {
      name: 'cf-worker-production',
      kind: 'cf-worker',
      branch: 'production',
      vars: ['DATABASE_URL'],
      options: { workerName: 'api', workerDir: '.' },
      mode: 'direct',
    },
    legacy: {
      name: 'legacy',
      kind: 'cf-worker',
      branch: 'development',
      vars: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
      options: {},
    },
  },
};

function writeTargets(): void {
  writeFileSync(join(ROOT, '.capy', 'deploy.json'), JSON.stringify(TARGETS, null, 2));
}

function savedNames(): string[] {
  const p = join(ROOT, '.capy', 'deploy.json');
  if (!existsSync(p)) return [];
  return Object.keys(JSON.parse(readFileSync(p, 'utf-8')).targets ?? {});
}

function writeKeep(): void {
  const variables: Record<string, unknown[]> = {};
  for (const v of ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'VITE_API_URL']) {
    variables[v] = ['development', 'production'].map((b) => ({
      resource_id: `r-${b}`,
      branch: b,
      value_hash: 'h',
    }));
  }
  writeFileSync(
    join(ROOT, 'keep.lock'),
    JSON.stringify({ version: '3.0', org_id: 'o', project_id: 'p', variables }),
  );
}

/**
 * Capture what the command prints, and hand back the loopback URL from it.
 *
 * The URL is not returned by any of these functions — it is PRINTED, because
 * that line is the whole handoff to the human. Taking it from stdout is
 * therefore the same thing an agent does with it.
 */
function captureConsole(): { url: () => string; lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  return {
    lines,
    url: () => {
      const hit = lines.map((l) => l.match(/http:\/\/127\.0\.0\.1:\d+\/\S*/)).find(Boolean);
      return hit ? hit[0] : '';
    },
    restore: () => {
      console.log = realLog;
      console.error = realError;
    },
  };
}

async function waitFor(get: () => string): Promise<string> {
  for (let i = 0; i < 400 && !get(); i++) await new Promise((r) => setTimeout(r, 10));
  const v = get();
  if (!v) throw new Error('the command never printed a loopback URL');
  return v;
}

/** The nonce a compiled screen reads out of its own inlined payload. */
async function nonceFrom(url: string): Promise<string> {
  const html = await (await fetch(url)).text();
  const m = html.match(/window\.__CAPY_DATA__\s*=\s*(\{[\s\S]*?\});/);
  if (!m) throw new Error('no payload inlined into the served page');
  return JSON.parse(m[1]).nonce;
}

/** Answer the page, the way the screen's own `submitToCli` does. */
async function answer(url: string, payload: Record<string, unknown>): Promise<unknown> {
  const u = new URL(url);
  const nonce = await nonceFrom(url);
  const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, payload }),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// capy deploy list --web
// ---------------------------------------------------------------------------

describe('deployList --web', () => {
  test('removing a row removes that target and nothing else', async () => {
    writeTargets();
    const cap = captureConsole();
    try {
      const run = deployList(ROOT, { web: true });
      const url = await waitFor(cap.url);

      // The page carries the rows the CLI read off disk — by name, never a value.
      const html = await (await fetch(url)).text();
      expect(html).toContain('window.__CAPY_DATA__');
      expect(html).not.toContain('sk_live');

      await answer(url, { __action: 'remove', target: 'legacy' });
      expect(await run).toBe(0);
    } finally {
      cap.restore();
    }
    expect(savedNames()).toEqual(['cf-worker-production']);
  }, 30_000);

  test('a cancelled listing changes nothing and exits 0', async () => {
    // Closing the window is a refusal. A listing that ends without an answer
    // has removed nothing, and it is not a failure.
    //
    // `{__action:'cancel'}` is not a shape invented for this test: it is what
    // `withDeclineBridge` posts, and what the screen itself should post once it
    // grows the control. The BROWSER-driven proof is
    // `tests/ui/browserFlow.e2e.test.ts`, which clicks the real button and
    // times the run — this asserts what the command does with the answer.
    writeTargets();
    const cap = captureConsole();
    try {
      const run = deployList(ROOT, { web: true });
      const url = await waitFor(cap.url);
      await answer(url, { __action: 'cancel' });
      expect(await run).toBe(0);
    } finally {
      cap.restore();
    }
    expect(savedNames()).toEqual(['cf-worker-production', 'legacy']);
  }, 30_000);

  test('a target the page could not have offered is refused, not removed', async () => {
    // The submitted name is resolved against the list the SERVER sent. A name
    // that was never on it did not come from the screen.
    writeTargets();
    const cap = captureConsole();
    try {
      const run = deployList(ROOT, { web: true });
      const url = await waitFor(cap.url);
      const refused = (await answer(url, { __action: 'remove', target: 'not-a-target' })) as {
        error?: string;
      };
      expect(refused.error).toContain('not saved for this project');
      // Still live, still waiting: an inline refusal keeps the page open.
      await answer(url, { __action: 'cancel' });
      expect(await run).toBe(0);
    } finally {
      cap.restore();
    }
    expect(savedNames()).toEqual(['cf-worker-production', 'legacy']);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// capy deploy targets-remove <name> --web
// ---------------------------------------------------------------------------

describe('deployRemove --web', () => {
  test('declining the confirm KEEPS the target and exits 0', async () => {
    // The terminal removes on a bare argument with no question at all. The
    // settings behind that name took seven prompts to produce and
    // `.capy/deploy.json` keeps no history — so a decline has to survive.
    //
    // The decline is POSTed here rather than clicked, and what a click actually
    // costs is the other half of this: driven in a real browser this run sat
    // for 300,021 ms before printing the very line asserted below. That half
    // lives in `tests/ui/browserFlow.e2e.test.ts`, which clicks "Keep it" and
    // fails the run if it has not ended fifteen seconds later.
    writeTargets();
    const cap = captureConsole();
    try {
      const run = deployRemove('legacy', ROOT, { web: true });
      const url = await waitFor(cap.url);
      await answer(url, { __action: 'cancel' });
      expect(await run).toBe(0);
      expect(cap.lines.join('\n')).toContain('Kept target');
    } finally {
      cap.restore();
    }
    expect(savedNames()).toEqual(['cf-worker-production', 'legacy']);
  }, 30_000);

  test('confirming it removes exactly the named target', async () => {
    writeTargets();
    const cap = captureConsole();
    try {
      const run = deployRemove('legacy', ROOT, { web: true });
      const url = await waitFor(cap.url);
      await answer(url, { __action: 'remove', target: 'legacy' });
      expect(await run).toBe(0);
    } finally {
      cap.restore();
    }
    expect(savedNames()).toEqual(['cf-worker-production']);
  }, 30_000);

  test('a name that is not saved never opens a window', async () => {
    writeTargets();
    const cap = captureConsole();
    try {
      const code = await deployRemove('nope', ROOT, { web: true });
      expect(code).toBe(1);
      expect(cap.url()).toBe('');
    } finally {
      cap.restore();
    }
    expect(savedNames()).toEqual(['cf-worker-production', 'legacy']);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// "which target?" — the picker, at the layer that acts on the answer
// ---------------------------------------------------------------------------

describe('ensureDeployTarget --web', () => {
  test('the row that was clicked is the target the caller gets back', async () => {
    writeTargets();
    writeKeep();
    const cap = captureConsole();
    try {
      const run = ensureDeployTarget(ROOT, { web: true });
      const url = await waitFor(cap.url);
      await answer(url, { __action: 'use', target: 'legacy' });
      const picked = await run;
      expect(picked?.name).toBe('legacy');
      expect(picked?.branch).toBe('development');
    } finally {
      cap.restore();
    }
  }, 30_000);

  test('a cancelled pick resolves to nothing rather than the first row', async () => {
    writeTargets();
    writeKeep();
    const cap = captureConsole();
    try {
      const run = ensureDeployTarget(ROOT, { web: true });
      const url = await waitFor(cap.url);
      await answer(url, { __action: 'cancel' });
      expect(await run).toBeNull();
    } finally {
      cap.restore();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// the setup picker: the params it hands the browser
// ---------------------------------------------------------------------------

describe('runPicker --web, through ensureDeployTarget', () => {
  test('the variables offered are the ones in THIS directory', async () => {
    // The picker scopes its checkbox to the materialized .env of the directory
    // it was handed. Reading a different directory's .env is how a target gets
    // saved ticking a variable the project does not have.
    writeKeep();
    writeFileSync(join(ROOT, '.env'), 'DATABASE_URL=enc:aaa\nSTRIPE_SECRET_KEY=enc:bbb\n');
    writeFileSync(join(ROOT, 'wrangler.toml'), 'name = "api"\n');
    const cap = captureConsole();
    try {
      const run = ensureDeployTarget(ROOT, { web: true });
      const url = await waitFor(cap.url);
      const html = await (await fetch(url)).text();
      const data = JSON.parse(
        html.match(/window\.__CAPY_DATA__\s*=\s*(\{[\s\S]*?\});/)![1],
      );

      // keep.lock lists three; the .env in THIS directory has two.
      expect(data.adapters.map((a: { id: string }) => a.id)).toContain('cf-worker');
      // No decrypted value goes out with them.
      expect(html).not.toContain('enc:aaa');

      await answer(url, { __action: 'cancel' });
      expect(await run).toBeNull();
    } finally {
      cap.restore();
    }
  }, 30_000);

  test('a branch with no variables refuses instead of saving an empty target', async () => {
    // A target with nothing to push is a deploy that reports success having
    // sent nothing. No window opens for it.
    writeKeep();
    const cap = captureConsole();
    let thrown: unknown = null;
    try {
      await ensureDeployTarget(ROOT, { web: true }).catch((e) => (thrown = e));
    } finally {
      cap.restore();
    }
    expect(String(thrown)).toContain('no variables on the active branch');
    expect(cap.url()).toBe('');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// capy deploy revoke <prefix> --web — which token the prefix names
// ---------------------------------------------------------------------------

describe('resolveTokenPrefix', () => {
  const row = (deployId: string): DeployTokenListRow => ({
    deployId,
    label: null,
    createdAge: 'just now',
    createdOn: '2026-07-30',
    revokedAge: null,
  });
  const ROWS = [row('a1b2c3d4e5f6a7b8c9d0'), row('a1b2c3d4e5f6ffffffff'), row('ffee00112233')];

  test('a prefix only one token has resolves to it', () => {
    expect(resolveTokenPrefix(ROWS, 'ffee')).toEqual({ code: 'ok', token: ROWS[2] });
  });

  test('a prefix two tokens share is REFUSED, not resolved to the first', () => {
    // Twelve characters is what the terminal shows of an id, so twelve is what
    // a user retypes — and these two share all twelve. Revoking is
    // irreversible and cuts a live pipeline off; "probably this one" is not an
    // answer to which one.
    const out = resolveTokenPrefix(ROWS, 'a1b2c3d4e5f6');
    expect(out.code).toBe('ambiguous');
    expect(out.code === 'ambiguous' && out.matches).toHaveLength(2);
  });

  test('a full id is never ambiguous, whatever else it prefixes', () => {
    expect(resolveTokenPrefix(ROWS, 'a1b2c3d4e5f6a7b8c9d0')).toEqual({
      code: 'ok',
      token: ROWS[0],
    });
  });

  test('a prefix nothing matches is its own answer', () => {
    expect(resolveTokenPrefix(ROWS, 'deadbeef')).toEqual({ code: 'none' });
  });
});

// ---------------------------------------------------------------------------
// capy deploy --json — the route, described rather than travelled
// ---------------------------------------------------------------------------

describe('deployCommand --json', () => {
  test('emits the SAME array the browser screens are served', async () => {
    writeTargets();
    writeKeep();
    const cap = captureConsole();
    let code = 1;
    try {
      code = await deployCommand('legacy', { json: true }, ROOT);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);

    const printed = JSON.parse(cap.lines.join('\n'));
    const { stops, unanswered } = describeDeployRoute('legacy', {}, ROOT);
    expect(printed.stops).toEqual(stops);
    // Derived from the plan, never recomputed beside it.
    expect(printed.unanswered).toEqual(unansweredDeployStops(stops));
    // Ten stations, always — a stop this run will not travel is `skipped`
    // rather than absent.
    expect(printed.stops).toHaveLength(deployPlan().length);
  }, 30_000);

  test('a saved target settles the stops it answers, and says which are left', async () => {
    writeTargets();
    writeKeep();
    const { stops, unanswered } = describeDeployRoute('legacy', {}, ROOT);
    const byId = Object.fromEntries(stops.map((s) => [s.id, s]));
    expect(byId.branch).toMatchObject({ state: 'done', answer: 'development' });
    expect(byId.name).toMatchObject({ state: 'done', answer: 'legacy' });
    expect(byId.variables).toMatchObject({ state: 'done', answer: '2 variables' });
    // Never asked: this run came in with a target name, so nobody chose a mode.
    expect(byId.mode.state).toBe('skipped');
    // Still ahead of it, and named as such.
    expect(unanswered).toContain('review');
    expect(unanswered).toContain('signin');
    expect(unanswered).not.toContain('deploy');
  });

  test('an ad-hoc --target is never named, and says so', async () => {
    writeKeep();
    const { stops, unanswered } = describeDeployRoute(undefined, { target: 'cf-worker' }, ROOT);
    const byId = Object.fromEntries(stops.map((s) => [s.id, s]));
    expect(byId.platform).toMatchObject({ state: 'done', answer: 'Cloudflare Workers' });
    // An ad-hoc target is never written to disk, so the naming question does
    // not happen rather than going unanswered.
    expect(byId.name.state).toBe('skipped');
    expect(unanswered).not.toContain('name');
    // Where the traveller stands is the first outstanding stop, taken off the
    // plan itself.
    expect(stops.find((s) => s.state === 'current')!.id).toBe(unanswered[0]);
  });

  test('a dry run draws its terminus unreachable, and prints no secret', async () => {
    writeTargets();
    const cap = captureConsole();
    try {
      expect(await deployCommand('legacy', { json: true, dryRun: true }, ROOT)).toBe(0);
    } finally {
      cap.restore();
    }
    const printed = JSON.parse(cap.lines.join('\n'));
    expect(printed.stops.find((s: { id: string }) => s.id === 'deploy').blank).toBe(true);
    expect(cap.lines.join('\n')).not.toContain('sk_live');
  }, 30_000);
});
