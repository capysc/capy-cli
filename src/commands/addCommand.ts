import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import type { Socket } from 'net';
import { CapyError, ERROR_CODES } from '../types';
import { resolveContext, writeAndSync } from './connectors/shared';
import { generateIntakeForm } from '../ui/intakePage';
import { nonceEqual, isLoopbackHost, isAllowedOrigin } from './intakeSecurity';

export interface AddOpts {
  web?: boolean;
  reason?: string;
  helpUrl?: string;
  /** false when --no-open was passed (commander negation). */
  open?: boolean;
  noPush?: boolean;
  force?: boolean;
  nonTty?: boolean;
}

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTAKE_TIMEOUT_MS = 5 * 60 * 1000;

interface IntakeParams {
  varName: string;
  reason?: string;
  helpUrl?: string;
  exists: boolean;
  open: boolean;
}

/**
 * Open a local browser form and run `onSubmit` with the value the user enters.
 * The save runs INSIDE the request, so the browser learns whether it actually
 * succeeded: on success the page shows "Saved" and this resolves; on failure the
 * server returns 500 with the error message and the user can fix it and retry in
 * the form. The value is handled in-process — never printed, logged, or returned.
 */
function runWebIntake(params: IntakeParams, onSubmit: (value: string) => Promise<void>): Promise<void> {
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
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(generateIntakeForm({ varName: params.varName, nonce, reason: params.reason, helpUrl: params.helpUrl, exists: params.exists }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/submit') {
        // Anti DNS-rebinding: the request must target the loopback host we bound.
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
          if (body.length > 1_000_000) {
            aborted = true;
            res.writeHead(413).end('too large');
            req.destroy();
          }
        });
        req.on('end', async () => {
          if (aborted) return;
          let parsed: { nonce?: unknown; value?: unknown };
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
          if (typeof parsed.value !== 'string') {
            res.writeHead(400).end('missing value');
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
          // Perform the actual save BEFORE responding, so the browser learns
          // whether it really succeeded. On failure: 500 + the message, and
          // leave the server open so the user can fix it and retry in the form.
          busy = true;
          try {
            await onSubmit(parsed.value);
            done = true;
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
            setTimeout(() => {
              cleanup();
              resolve();
            }, 250);
          } catch (err) {
            busy = false;
            const message = err instanceof Error ? err.message : 'Failed to save the secret.';
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
      reject(new CapyError('Timed out waiting for the value (5 minutes).', ERROR_CODES.SERVICE_ERROR));
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
      console.log('');
      console.log(`  Enter ${params.varName} in your browser (the value never touches this terminal or the AI):`);
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

  async execute(varName: string, opts: AddOpts): Promise<void> {
    const name = varName.trim();
    if (!VAR_RE.test(name)) {
      throw new CapyError(`"${varName}" is not a valid environment variable name.`, ERROR_CODES.INVALID_FORMAT);
    }

    const ctx = await resolveContext({ devMode: this.devMode });
    const exists = name in ctx.localPlaintext;

    if (exists && !opts.force && !opts.web && !opts.nonTty) {
      const inquirer = (await import('inquirer')).default;
      const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message: `${name} already exists. Overwrite?`, default: false }]);
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    const push = opts.noPush !== true;

    if (opts.web) {
      // The save runs inside the intake server, so the browser reflects success
      // or failure of the actual encrypt+sync.
      await runWebIntake(
        { varName: name, reason: opts.reason, helpUrl: opts.helpUrl, exists, open: opts.open !== false },
        (value) => writeAndSync(ctx, name, value, { push }),
      );
    } else {
      if (opts.nonTty) {
        throw new CapyError(
          'Non-interactive add requires --web (browser intake). Re-run with --web.',
          ERROR_CODES.INVALID_FORMAT,
        );
      }
      const inquirer = (await import('inquirer')).default;
      const { value: entered } = await inquirer.prompt([{ type: 'password', name: 'value', message: `Value for ${name}:`, mask: '*' }]);
      if (!entered) throw new CapyError('No value entered.', ERROR_CODES.INVALID_FORMAT);
      await writeAndSync(ctx, name, entered, { push });
    }

    const verb = exists ? 'Updated' : 'Added';
    const where = push ? ` and synced to ${ctx.branch}` : ' (.env only — not pushed)';
    console.log(`✓ ${verb} ${name}${where}.`);
  }
}
