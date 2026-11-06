#!/usr/bin/env node
// Browser approval happens on npmjs.com; completion is polled from the registry.
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const registry = 'https://registry.npmjs.org/';
const exec = promisify(execFile);

export function validateApproval(authUrl, doneUrl) {
  const auth = new URL(authUrl);
  const done = new URL(doneUrl);
  if (auth.origin !== 'https://www.npmjs.com' || done.origin !== new URL(registry).origin
      || auth.username || auth.password || done.username || done.password) {
    throw new Error('Refusing an approval URL outside the official npm service.');
  }
  return Object.freeze({ authUrl: auth.href, doneUrl: done.href });
}

export async function pollApproval(doneUrl, {
  fetchImpl = fetch,
  sleep = delay,
  now = Date.now,
  timeoutMs = 5 * 60_000,
} = {}) {
  const deadline = now() + timeoutMs;
  const poll = async () => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('npm approval expired. Run the command again for a fresh link.');
    const response = await fetchImpl(doneUrl, {
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(remaining),
    });
    if (response.status === 200) {
      const result = await response.json();
      if (typeof result.token !== 'string' || result.token.length === 0) {
        throw new Error('npm approval completed without a token.');
      }
      return result.token;
    }
    if (response.status !== 202) {
      throw new Error(`npm approval failed (HTTP ${response.status}). Request a fresh approval link.`);
    }
    const retry = Number(response.headers.get('retry-after'));
    const wait = Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 30_000) : 2000;
    await sleep(Math.min(wait, Math.max(0, deadline - now())));
    return poll();
  };
  return poll();
}

export async function runNpm(args, otp) {
  try {
    const result = await exec('npm', [...args, `--registry=${registry}`], {
      env: { ...process.env, ...(otp ? { npm_config_otp: otp } : {}) },
      maxBuffer: 4 * 1024 * 1024,
    });
    return Object.freeze({ ok: true, stdout: result.stdout });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('npm is required.');
    return Object.freeze({ ok: false, stdout: error.stdout ?? '' });
  }
}

export async function login({ emit = defaultEmit, spawnImpl = spawn } = {}) {
  emit({ type: 'status', message: 'Waiting for npm login; no callback to this machine is needed.' });
  const child = spawnImpl('npm', ['login', '--auth-type=web', '--browser=false', `--registry=${registry}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completed = once(child, 'close');
  const forward = async (stream) => {
    for await (const line of createInterface({ input: stream })) {
      const url = line.match(/^https:\/\/www\.npmjs\.com\/\S+$/)?.[0];
      if (url) emit({ type: 'approval', purpose: 'login', url });
    }
  };
  const [[code]] = await Promise.all([completed, forward(child.stdout), forward(child.stderr)]);
  if (code !== 0) throw new Error('npm login did not complete. Run the login command again for a fresh link.');
  emit({ type: 'authenticated' });
}

export async function publish(tarball, {
  run = runNpm,
  signIn = login,
  poll = pollApproval,
  emit = defaultEmit,
} = {}) {
  if (!tarball.endsWith('.tgz')) throw new Error('Publish a reviewed npm pack .tgz artifact.');
  const identity = await run(['whoami', '--json']);
  if (!identity.ok) await signIn({ emit });
  const args = ['publish', resolve(tarball), '--access=public', '--tag=latest', '--ignore-scripts', '--browser=false', '--json'];
  const first = await run(args);
  if (first.ok) {
    emit({ type: 'published', artifact: resolve(tarball) });
    return;
  }
  const parsed = (() => {
    try { return JSON.parse(first.stdout); } catch { return {}; }
  })();
  const error = parsed.error ?? parsed;
  if (error.code !== 'EOTP' || !error.authUrl || !error.doneUrl) {
    throw new Error(`npm publish failed (${error.code ?? 'unknown error'}). No publish retry was attempted.`);
  }
  const approval = validateApproval(error.authUrl, error.doneUrl);
  emit({ type: 'approval', purpose: 'publish', url: approval.authUrl });
  const otp = await poll(approval.doneUrl);
  const approved = await run(args, otp);
  if (!approved.ok) throw new Error('npm publish failed after approval. Check the registry before retrying.');
  emit({ type: 'published', artifact: resolve(tarball) });
}

const defaultEmit = (event) => {
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } else {
    process.stdout.write(`${event.type === 'approval' ? `Approve npm ${event.purpose}: ${event.url}` : event.message ?? event.type}\n`);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(arg => arg !== '--json');
  const task = args[0] === 'login' && args.length === 1
    ? () => login()
    : args[0] === 'publish' && args.length === 2
      ? () => publish(args[1])
      : () => { throw new Error('Usage: node scripts/npm-remote.mjs login | publish <package.tgz> [--json]'); };
  Promise.resolve().then(task).catch(error => {
    defaultEmit({ type: 'error', message: error.message });
    process.exitCode = 1;
  });
}
