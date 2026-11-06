import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { login, pollApproval, publish, validateApproval } from '../../scripts/npm-remote.mjs';

const authUrl = 'https://www.npmjs.com/auth/cli/test';
const doneUrl = 'https://registry.npmjs.org/-/v1/done/test';
const challenge = { ok: false, stdout: JSON.stringify({ error: { code: 'EOTP', authUrl, doneUrl } }) };

test('login streams the remote approval URL without a TTY or local browser', async () => {
  const child = new class extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
  }();
  const emit = mock.fn();
  const spawnImpl = mock.fn(() => {
    setImmediate(() => {
      child.stdout.end('Login at:\nhttps://www.npmjs.com/login?next=/login/cli/test\n');
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  });
  await login({ emit, spawnImpl });
  assert.deepEqual(spawnImpl.mock.calls[0].arguments[2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(spawnImpl.mock.calls[0].arguments[1].includes('--browser=false'));
  assert.equal(emit.mock.calls[1].arguments[0].url, 'https://www.npmjs.com/login?next=/login/cli/test');
  assert.equal(emit.mock.calls[2].arguments[0].type, 'authenticated');
});

test('rejects approval URLs that could disclose credentials to another origin', () => {
  assert.throws(() => validateApproval('https://evil.example/auth', doneUrl));
  assert.throws(() => validateApproval(authUrl, 'https://evil.example/token'));
  assert.throws(() => validateApproval(authUrl, 'http://registry.npmjs.org/token'));
  assert.throws(() => validateApproval('https://user:pass@www.npmjs.com/auth', doneUrl));
});

test('polls pending approval, respects retry-after, and returns the token only to its caller', async () => {
  const fetchImpl = mock.fn(async () => fetchImpl.mock.callCount() === 0
    ? new Response('{}', { status: 202, headers: { 'retry-after': '3' } })
    : new Response('{"token":"one-time-secret"}'));
  const sleep = mock.fn(async () => {});
  assert.equal(await pollApproval(doneUrl, { fetchImpl, sleep }), 'one-time-secret');
  assert.equal(sleep.mock.calls[0].arguments[0], 3000);
  assert.equal(fetchImpl.mock.calls[0].arguments[1].redirect, 'error');
});

test('expires an unfinished approval and rejects expired or malformed results', async () => {
  await assert.rejects(pollApproval(doneUrl, { timeoutMs: 0 }), /expired/);
  await assert.rejects(pollApproval(doneUrl, { fetchImpl: async () => new Response('{}', { status: 410 }) }), /HTTP 410/);
  await assert.rejects(pollApproval(doneUrl, { fetchImpl: async () => new Response('{}') }), /without a token/);
});

test('non-TTY publishing relays approval and retries the same artifact exactly once', async () => {
  const run = mock.fn(async () => run.mock.callCount() === 1 ? challenge : { ok: true, stdout: '{}' });
  const emit = mock.fn();
  const poll = mock.fn(async () => 'one-time-secret');
  await publish('release.tgz', { run, emit, poll });
  assert.equal(run.mock.callCount(), 3);
  assert.deepEqual(run.mock.calls[1].arguments[0], run.mock.calls[2].arguments[0]);
  assert.equal(run.mock.calls[2].arguments[1], 'one-time-secret');
  assert.deepEqual(emit.mock.calls[0].arguments[0], { type: 'approval', purpose: 'publish', url: authUrl });
  assert.equal(emit.mock.calls[1].arguments[0].type, 'published');
  assert.doesNotMatch(JSON.stringify(emit.mock.calls), /one-time-secret|done\/test/);
});

test('requests login before publishing when the stored npm session is expired', async () => {
  const run = mock.fn(async () => ({ ok: run.mock.callCount() !== 0, stdout: '{}' }));
  const signIn = mock.fn(async () => {});
  await publish('release.tgz', { run, signIn, emit: () => {} });
  assert.equal(signIn.mock.callCount(), 1);
  assert.equal(run.mock.callCount(), 2);
});

test('does not retry ordinary publish errors or poll an untrusted challenge', async () => {
  const denied = mock.fn(async () => denied.mock.callCount() === 0 ? { ok: true } : { ok: false, stdout: '{"error":{"code":"E403"}}' });
  await assert.rejects(publish('release.tgz', { run: denied, emit: () => {} }), /E403/);
  assert.equal(denied.mock.callCount(), 2);
  const run = mock.fn(async () => run.mock.callCount() === 0 ? { ok: true } : {
    ok: false, stdout: JSON.stringify({ error: { code: 'EOTP', authUrl, doneUrl: 'https://evil.example/token' } }),
  });
  const poll = mock.fn();
  await assert.rejects(publish('release.tgz', { run, poll, emit: () => {} }), /official npm/);
  assert.equal(poll.mock.callCount(), 0);
});

test('does not announce success or repeat approval when the approved publish fails', async () => {
  const run = mock.fn(async () => run.mock.callCount() === 0 ? { ok: true } : challenge);
  const emit = mock.fn();
  await assert.rejects(publish('release.tgz', { run, emit, poll: async () => 'secret' }), /failed after approval/);
  assert.equal(run.mock.callCount(), 3);
  assert.equal(emit.mock.callCount(), 1);
});
