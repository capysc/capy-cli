import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { releaseVersion, waitForNpmRelease } from '../../scripts/wait-for-npm-release.mjs';

const version = '0.9.17';
const tarball = `https://registry.npmjs.org/@capysc/cli/-/cli-${version}.tgz`;
const metadata = () => Response.json({ name: '@capysc/cli', version, dist: { tarball } });
const options = (responses) => {
  const iterator = responses.values();
  return {
    fetchImpl: mock.fn(async () => iterator.next().value),
    sleep: mock.fn(async () => {}),
    log: () => {},
    attempts: 3,
  };
};

test('stable release tags are normalized; missing, prerelease, and shell-like tags fail before network access', async () => {
  assert.equal(releaseVersion('v0.9.17'), version);
  assert.equal(releaseVersion('0.9.17'), version);
  for (const tag of [undefined, '', 'v0.9.17-rc.1', 'v0.9.17; echo bad', 'v01.2.3']) {
    const config = options([]);
    await assert.rejects(waitForNpmRelease(tag, config), /stable release tag/);
    assert.equal(config.fetchImpl.mock.callCount(), 0);
  }
});

test('published metadata and its actual tarball must both be available', async () => {
  const config = options([metadata(), new Response(null)]);
  assert.deepEqual(await waitForNpmRelease('v0.9.17', config), { tag: 'v0.9.17', version, tarball });
  assert.equal(config.fetchImpl.mock.calls[0].arguments[0], 'https://registry.npmjs.org/@capysc%2Fcli/0.9.17');
  assert.equal(config.fetchImpl.mock.calls[1].arguments[0], tarball);
  assert.equal(config.fetchImpl.mock.calls[1].arguments[1].method, 'HEAD');
  assert.equal(config.sleep.mock.callCount(), 0);
});

test('retries npm propagation, throttling, and transient errors', async () => {
  for (const status of [404, 429, 503]) {
    const config = options([new Response(null, { status }), metadata(), new Response(null)]);
    await waitForNpmRelease('v0.9.17', config);
    assert.equal(config.sleep.mock.callCount(), 1);
    assert.equal(config.fetchImpl.mock.callCount(), 3);
  }
});

test('waits when metadata is published before the tarball', async () => {
  const config = options([metadata(), new Response(null, { status: 404 }), metadata(), new Response(null)]);
  await waitForNpmRelease('v0.9.17', config);
  assert.equal(config.sleep.mock.callCount(), 1);
  assert.equal(config.fetchImpl.mock.callCount(), 4);
});

test('exhausted publication checks fail instead of opening a broken formula PR', async () => {
  const config = options(Array.from({ length: 3 }, () => new Response(null, { status: 404 })));
  await assert.rejects(waitForNpmRelease('v0.9.17', config), /not available after 3 checks/);
  assert.equal(config.fetchImpl.mock.callCount(), 3);
  assert.equal(config.sleep.mock.callCount(), 2);
});

test('unexpected metadata and permanent HTTP errors stop immediately', async () => {
  const config = options([Response.json({ name: '@capysc/cli', version, dist: { tarball: 'https://other.example/capy.tgz' } })]);
  await assert.rejects(waitForNpmRelease('v0.9.17', config), /unexpected package metadata/);
  assert.equal(config.fetchImpl.mock.callCount(), 1);
  for (const status of [401, 403]) {
    const denied = options([new Response(null, { status })]);
    await assert.rejects(waitForNpmRelease('v0.9.17', denied), /publication check failed/);
    assert.equal(denied.sleep.mock.callCount(), 0);
  }
});
