/**
 * A stand-in `vercel` program for the `--create-token` tests: a small shell
 * script in a temp directory that appends every call's argv to a log file and
 * answers from canned files. Nothing here is a real token — every value is a
 * fake sentinel.
 *
 * Files in the stub directory (all optional):
 *   whoami.exit  exit status for `vercel whoami`       (default 0)
 *   logout.exit  exit status for `vercel logout`       (default 0)
 *   rm.exit      exit status for `vercel tokens rm`    (default 0)
 *   create.exit  exit status for the token POST        (default 0)
 *   teams.json   stdout for `vercel api /v2/teams…`
 *   create.json  stdout for `vercel api /v3/user/tokens`
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from './testSandbox';

const SCRIPT = `#!/bin/sh
d="$STUB_DIR"
printf '%s\\037' "$@" >> "$d/argv.log"
printf '\\n' >> "$d/argv.log"
printf '[%s]\\n' "\${VERCEL_TOKEN:-}" >> "$d/env.log"
status() { if [ -f "$d/$1.exit" ]; then exit "$(cat "$d/$1.exit")"; fi; exit 0; }
case "$1" in
  whoami) status whoami ;;
  logout) status logout ;;
  tokens) status rm ;;
  api)
    case "$2" in
      /v2/teams*) cat "$d/teams.json"; exit 0 ;;
      /v3/user/tokens)
        if [ -f "$d/create.exit" ] && [ "$(cat "$d/create.exit")" != "0" ]; then exit "$(cat "$d/create.exit")"; fi
        cat "$d/create.json"; exit 0 ;;
    esac ;;
esac
exit 64
`;

export interface StubFiles {
  readonly [name: string]: string;
}

export interface Stub {
  /** An environment whose PATH finds the stub `vercel`. */
  env: Record<string, string>;
  /** Every call so far, as its argv. */
  calls(): readonly (readonly string[])[];
  /** Every call so far, as one raw string — for "this value appears nowhere". */
  rawLog(): string;
  /** What `$VERCEL_TOKEN` was in each call's environment (empty brackets = unset). */
  tokenEnvSeen(): readonly string[];
}

/** Runs `fn` with a stub `vercel` on PATH (and the stub's directory removed afterwards). */
export async function withStubVercel<T>(files: StubFiles, fn: (stub: Stub) => Promise<T>): Promise<T> {
  return withTempDir('stub-vercel', async (dir) => {
    const bin = join(dir, 'bin');
    const data = join(dir, 'data');
    mkdirSync(bin);
    mkdirSync(data);
    writeFileSync(join(bin, 'vercel'), SCRIPT);
    chmodSync(join(bin, 'vercel'), 0o755);
    Object.entries(files).forEach(([name, content]) => writeFileSync(join(data, name), content));
    const log = join(data, 'argv.log');
    const rawLog = (): string => (existsSync(log) ? readFileSync(log, 'utf-8') : '');
    const envLog = join(data, 'env.log');
    return fn({
      tokenEnvSeen: () => (existsSync(envLog) ? readFileSync(envLog, 'utf-8').split('\n').filter((l) => l !== '') : []),
      env: { PATH: `${bin}:/usr/bin:/bin`, STUB_DIR: data },
      rawLog,
      calls: () =>
        rawLog()
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => l.split('\u001f').filter((a) => a !== '')),
    });
  });
}

/** A fake bearer value; tests assert it appears on no output surface. */
export const FAKE_BEARER = 'vcp_FAKE_BEARER_SENTINEL_9f3a71c2';

export const teamsJson = (teams: ReadonlyArray<{ id: string; slug: string }>): string => JSON.stringify({ teams, pagination: null });

export const createdJson = (over: { id?: string; scopes?: readonly unknown[]; expiresAt?: number } = {}): string =>
  JSON.stringify({
    bearerToken: FAKE_BEARER,
    token: {
      id: over.id ?? 'tok_new_1',
      name: 'capy-acme-import',
      type: 'oauth2-token',
      scopes: over.scopes ?? [{ type: 'team', teamId: 'team_acme' }],
      ...(over.expiresAt === undefined ? {} : { expiresAt: over.expiresAt }),
    },
  });
