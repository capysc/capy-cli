import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const registry = 'https://registry.npmjs.org';

export function releaseVersion(tag) {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('A stable release tag is required, for example v0.9.17.');
  }
  return tag.replace(/^v/, '');
}

export async function waitForNpmRelease(tag, {
  fetchImpl = fetch,
  sleep = setTimeout,
  attempts = 20,
  intervalMs = 15_000,
  log = console.log,
} = {}) {
  const version = releaseVersion(tag);
  const tarball = `${registry}/@capysc/cli/-/cli-${version}.tgz`;
  const request = async (url, method = 'GET') => {
    try {
      return await fetchImpl(url, { method, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if (error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name)) return null;
      throw error;
    }
  };
  const ready = (response) => {
    if (!response || response.status === 404 || response.status === 429 || response.status >= 500) return false;
    if (!response.ok) throw new Error(`npm publication check failed with HTTP ${response.status}.`);
    return true;
  };
  const poll = async (remaining) => {
    const metadataResponse = await request(`${registry}/@capysc%2Fcli/${version}`);
    if (ready(metadataResponse)) {
      const metadata = await metadataResponse.json();
      if (metadata.name !== '@capysc/cli' || metadata.version !== version || metadata.dist?.tarball !== tarball) {
        throw new Error('npm returned unexpected package metadata; refusing to update Homebrew.');
      }
      if (ready(await request(tarball, 'HEAD'))) return { tag: `v${version}`, version, tarball };
    }
    if (remaining <= 1) throw new Error(`npm release @capysc/cli@${version} is not available after ${attempts} checks.`);
    log(`Waiting for @capysc/cli@${version} metadata and tarball (${remaining - 1} checks left)...`);
    await sleep(intervalMs);
    return poll(remaining - 1);
  };
  return poll(attempts);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const release = await waitForNpmRelease(process.argv[2]);
    console.log(`npm release ready: ${release.tarball}`);
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `tag=${release.tag}\nversion=${release.version}\n`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
