import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Configure only the caller's throwaway HOME, through the production profile path. */
export function configureCliFixture(home: string, serviceUrl: string): void {
  const directory = join(home, '.capy');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({
    default: 'fixture', profiles: { fixture: { url: serviceUrl } },
  }));
}
