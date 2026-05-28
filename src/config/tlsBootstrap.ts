/**
 * Install a process-wide undici dispatcher that trusts the CA bundle of the
 * active profile, if any. Used to make `fetch()` accept self-signed BYOC
 * certs (Caddy's local CA on `capy.internal`) without forcing operators to
 * set NODE_EXTRA_CA_CERTS by hand.
 *
 * Idempotent — ServiceClient calls this on construction. No-op when there's
 * no active profile or the profile has no caBundle.
 */

import { readFileSync } from 'fs';
import { resolveActiveCaBundle } from './profileConfig';

let installed = false;

export function installProfileTlsTrust(): void {
  if (installed) return;
  installed = true;

  const caPath = resolveActiveCaBundle();
  if (!caPath) return;

  let ca: string;
  try {
    ca = readFileSync(caPath, 'utf-8');
  } catch (err) {
    console.error(`[capy] Could not read CA bundle at ${caPath}: ${(err as Error).message}`);
    return;
  }

  try {
    // undici ships with Node 18+; the global fetch implementation uses it
    // under the hood, so installing a global dispatcher affects every fetch
    // in the process. require() (not import) keeps this synchronous so the
    // dispatcher is in place before ServiceClient's first request. undici
    // has no ambient typings in @types/node, hence the local require.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const undici = require('undici') as { Agent: new (opts: any) => any; setGlobalDispatcher: (d: any) => void };
    undici.setGlobalDispatcher(new undici.Agent({ connect: { ca } }));
  } catch (err) {
    console.error(`[capy] Could not install profile TLS trust: ${(err as Error).message}`);
  }
}

/** Test hook — reset the install guard between cases. Not used in production. */
export function _resetTlsTrustForTests(): void {
  installed = false;
}
