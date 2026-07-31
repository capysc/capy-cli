import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import type { Socket } from 'net';
import { CapyError, ERROR_CODES } from '../types';
import { resolveContext, writeAndSync } from './connectors/shared';
import { generateIntakeForm, type IntakeVar } from '../ui/intakePage';
import { screenHeaders } from '../ui/screens/serve';
import { nonceEqual, isLoopbackHost, isAllowedOrigin } from './intakeSecurity';

export interface AddOpts {
  web?: boolean;
  reason?: string;
  /** Repeatable `--help-url NAME=URL` pairs: a per-variable "where to find this" link. */
  helpUrls?: string[];
  /** false when --no-open was passed (commander negation). */
  open?: boolean;
  noPush?: boolean;
  force?: boolean;
  nonTty?: boolean;
}

export interface SecretPair {
  name: string;
  value: string;
}

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTAKE_TIMEOUT_MS = 5 * 60 * 1000;

export interface IntakeParams {
  /** Suggested variables (name + optional per-variable help link) to pre-seed the form. */
  vars: IntakeVar[];
  reason?: string;
  open: boolean;
  /** Test-only hook: receives the loopback URL once the server is listening. Unset in production. */
  onListen?: (url: string) => void;
}

/** Parse repeatable `--help-url NAME=URL` flags into a name→url map (http(s) only). */
export function parseHelpUrls(pairs: string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const url = pair.slice(eq + 1).trim();
    if (VAR_RE.test(name) && /^https?:\/\//i.test(url)) map[name] = url;
  }
  return map;
}

/** Validate + normalize the submitted {name,value}[] payload. Names only — values pass through. */
export function parseVars(input: unknown): SecretPair[] | null {
  if (!Array.isArray(input)) return null;
  const out: SecretPair[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const value = rec.value;
    if (!VAR_RE.test(name) || typeof value !== 'string') return null;
    out.push({ name, value });
  }
  return out.length > 0 ? out : null;
}

/**
 * Open a local browser key/value form (pre-seeded with the suggested names) and
 * run `onSubmit` with the {name,value} pairs the user enters. The save runs INSIDE
 * the request, so the browser learns whether it succeeded (200) or not (500 + the
 * message, retryable). Values are handled in-process — never printed, logged, or returned.
 */
export function runWebIntake(params: IntakeParams, onSubmit: (pairs: SecretPair[]) => Promise<void>): Promise<void> {
  const nonce = randomBytes(32).toString('hex');
  const connections = new Set<Socket>();
  let busy = false;
  let done = false;

  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      const expectedHost = `127.0.0.1:${port}`;
      const url = new URL(req.url ?? '/', `http://${expectedHost}`);

      if (req.method === 'GET' && url.pathname === '/') {
        if (url.searchParams.get('n') !== nonce) {
          res.writeHead(403).end('forbidden');
          return;
        }
        // This page collects credentials, so it carries the same interactive
        // screen policy as the wizard. `intakePage` makes no external request by
        // construction — the policy is the browser enforcing that rather than
        // trusting it: no remote origins, no eval, no framing, no native form
        // post, and `connect-src` limited to the loopback origin the page came
        // from, which is the only place the typed values are supposed to go.
        res.writeHead(200, screenHeaders({ interactive: true }));
        res.end(generateIntakeForm({ vars: params.vars, nonce, reason: params.reason }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/submit') {
        if (!isLoopbackHost(req.headers.host, port)) {
          res.writeHead(403).end('bad host');
          return;
        }
        if (!isAllowedOrigin(req.headers.origin, port)) {
          res.writeHead(403).end('bad origin');
          return;
        }

        let body = '';
        let aborted = false;
        req.on('data', (c: Buffer) => {
          body += c.toString();
          if (body.length > 5_000_000) {
            aborted = true;
            res.writeHead(413).end('too large');
            req.destroy();
          }
        });
        req.on('end', async () => {
          if (aborted) return;
          let parsed: { nonce?: unknown; vars?: unknown };
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400).end('bad json');
            return;
          }
          if (!nonceEqual(parsed.nonce, nonce)) {
            res.writeHead(403).end('bad nonce');
            return;
          }
          const pairs = parseVars(parsed.vars);
          if (!pairs) {
            res
              .writeHead(400, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'each variable needs a valid NAME and a value' }));
            return;
          }
          if (done) {
            res.writeHead(409).end('already submitted');
            return;
          }
          if (busy) {
            res.writeHead(409).end('a submission is already in progress');
            return;
          }
          // Save BEFORE responding, so the browser reflects real success/failure.
          busy = true;
          try {
            await onSubmit(pairs);
            done = true;
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
            setTimeout(() => {
              cleanup();
              resolve();
            }, 250);
          } catch (err) {
            busy = false;
            const message = err instanceof Error ? err.message : 'Failed to save the secrets.';
            res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
          }
        });
        return;
      }

      res.writeHead(404).end('not found');
    });

    const cleanup = (): void => {
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        /* ignore */
      }
      for (const c of connections) {
        try {
          c.destroy();
        } catch {
          /* ignore */
        }
      }
      connections.clear();
    };

    server.on('connection', (c: Socket) => {
      connections.add(c);
      c.on('close', () => connections.delete(c));
    });
    server.on('error', (err) => {
      cleanup();
      reject(err);
    });

    timer = setTimeout(() => {
      cleanup();
      reject(new CapyError('Timed out waiting for the values (5 minutes).', ERROR_CODES.SERVICE_ERROR));
    }, INTAKE_TIMEOUT_MS);
    timer.unref();

    process.once('SIGINT', () => {
      cleanup();
      reject(new CapyError('Cancelled.', ERROR_CODES.SERVICE_ERROR));
    });

    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      const url = `http://127.0.0.1:${port}/?n=${nonce}`;
      params.onListen?.(url);
      const label = params.vars.length === 1 ? params.vars[0].name : `${params.vars.length} secret(s)`;
      console.log('');
      console.log(`  Enter ${label} in your browser (values never touch this terminal or the AI):`);
      console.log(`  ${url}`);
      console.log('');
      if (params.open) {
        try {
          const open = (await import('open')).default;
          await open(url);
        } catch {
          /* best-effort; the printed URL is the fallback */
        }
      }
    });
  });
}

export class AddCommand {
  constructor(private readonly devMode: boolean = false) {}

  async execute(varNames: string[], opts: AddOpts): Promise<void> {
    const names = varNames.map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) {
      throw new CapyError('No variable name given.', ERROR_CODES.INVALID_FORMAT);
    }
    for (const name of names) {
      if (!VAR_RE.test(name)) {
        throw new CapyError(`"${name}" is not a valid environment variable name.`, ERROR_CODES.INVALID_FORMAT);
      }
    }

    const ctx = await resolveContext({ devMode: this.devMode });
    const push = opts.noPush !== true;

    const existing = names.filter((n) => n in ctx.localPlaintext);
    if (existing.length > 0 && !opts.force && !opts.web && !opts.nonTty) {
      const inquirer = (await import('inquirer')).default;
      const { ok } = await inquirer.prompt([
        { type: 'confirm', name: 'ok', message: `${existing.join(', ')} already exist(s). Overwrite?`, default: false },
      ]);
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    // Write all pairs, pushing once at the end (each write accumulates into the
    // local env so the final push carries every variable).
    const writeMany = async (pairs: SecretPair[]): Promise<void> => {
      for (let i = 0; i < pairs.length; i++) {
        const { name, value } = pairs[i];
        await writeAndSync(ctx, name, value, { push: push && i === pairs.length - 1 });
        ctx.localPlaintext[name] = value;
      }
    };

    let savedNames: string[];
    if (opts.web) {
      const helpUrls = parseHelpUrls(opts.helpUrls);
      const vars: IntakeVar[] = names.map((name) => ({ name, helpUrl: helpUrls[name] }));
      let captured: string[] = [];
      await runWebIntake(
        { vars, reason: opts.reason, open: opts.open !== false },
        async (pairs) => {
          await writeMany(pairs);
          captured = pairs.map((p) => p.name);
        },
      );
      savedNames = captured;
    } else {
      if (opts.nonTty) {
        throw new CapyError(
          'Non-interactive add requires --web (browser intake). Re-run with --web.',
          ERROR_CODES.INVALID_FORMAT,
        );
      }
      const inquirer = (await import('inquirer')).default;
      const pairs: SecretPair[] = [];
      for (const name of names) {
        const { value } = await inquirer.prompt([{ type: 'password', name: 'value', message: `Value for ${name}:`, mask: '*' }]);
        if (!value) throw new CapyError(`No value entered for ${name}.`, ERROR_CODES.INVALID_FORMAT);
        pairs.push({ name, value });
      }
      await writeMany(pairs);
      savedNames = pairs.map((p) => p.name);
    }

    const where = push ? ` and synced to ${ctx.branch}` : ' (.env only — not pushed)';
    console.log(`✓ Saved ${savedNames.length} variable(s): ${savedNames.join(', ')}${where}.`);
  }
}
