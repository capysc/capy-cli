import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function buildInfo() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const time = epoch === undefined ? new Date() : new Date(Number(epoch) * 1000);
  const number = time.toISOString().replace(/\D/g, '');
  // Only the build machine needs Git. Source archives still get a build number.
  const revision = (() => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: new URL('../', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().slice(0, 8);
    } catch {
      return undefined;
    }
  })();
  return { id: revision ? number + '.' + revision : number };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(new URL('../dist/build-info.json', import.meta.url), JSON.stringify(buildInfo()) + '\n');
}
