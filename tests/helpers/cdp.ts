/**
 * Minimal Chrome DevTools Protocol driver — no npm dependencies.
 *
 * Test-only. Used by the browser end-to-end tests to drive a real page — fill
 * a field, click the button, watch what the CLI actually receives — which is
 * the only check that can catch a control wired to nothing.
 *
 * Deliberately drives a *downloaded* Chrome for Testing headless shell with a
 * throwaway profile; it must never attach to, launch, or read the developer's
 * real browser profile. Vendored here rather than imported from the monorepo
 * so a standalone clone still typechecks; the tests skip when no cached shell
 * is present.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/** Newest cached chrome-headless-shell, or null when none is installed. */
export function findHeadlessShell(): string | null {
  const root = resolve(homedir(), '.cache/puppeteer/chrome-headless-shell');
  if (!existsSync(root)) return null;
  const builds = readdirSync(root)
    .filter((d) => /^mac|^linux|^win/.test(d))
    // Directory names embed the version (mac_arm-148.0.7778.97); sort numerically.
    .sort((a, b) => compareVersions(versionOf(a), versionOf(b)));
  for (const build of builds.reverse()) {
    for (const inner of readdirSync(resolve(root, build))) {
      const bin = resolve(root, build, inner, 'chrome-headless-shell');
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

const versionOf = (dir: string): string => dir.split('-')[1] ?? '0';

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

/** One CDP session bound to one target (tab). */
export class CdpSession {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Array<(p: Record<string, unknown>) => void>>();

  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result ?? {});
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`CDP timeout: ${method}`));
      }, 30_000);
    });
  }

  on(method: string, fn: (p: Record<string, unknown>) => void): void {
    const arr = this.listeners.get(method) ?? [];
    arr.push(fn);
    this.listeners.set(method, arr);
  }

  once(method: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`CDP event timeout: ${method}`)), timeoutMs);
      this.on(method, (p) => {
        clearTimeout(timer);
        res(p);
      });
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate failed');
    return r.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

export class Browser {
  private constructor(
    private proc: ChildProcess,
    private endpoint: string,
  ) {}

  /**
   * Start a shell, retrying a startup that dies (up to three attempts).
   *
   * A shell that dies during startup is the one flaky failure this suite has:
   * a full batch run launches a couple of dozen of them against the same
   * machine, and an early exit surfaces as a test failing in ~150ms — before
   * it has driven anything. Retrying the LAUNCH cannot mask a product defect,
   * because at this point no page has been served and nothing has been
   * clicked; every assertion still has to pass on the browser that comes up.
   */
  static async launch(profileDir: string): Promise<Browser> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await Browser.spawnOnce(profileDir);
      } catch (err) {
        last = err;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  private static async spawnOnce(profileDir: string): Promise<Browser> {
    const bin = findHeadlessShell();
    if (!bin) {
      throw new Error(
        'No cached chrome-headless-shell found under ~/.cache/puppeteer. ' +
          'Install one with: bunx @puppeteer/browsers install chrome-headless-shell@stable',
      );
    }
    mkdirSync(profileDir, { recursive: true });
    const proc = spawn(
      bin,
      [
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        '--disable-lcd-text',
        '--font-render-hinting=none',
        '--allow-pre-commit-input',
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const endpoint = await new Promise<string>((res, rej) => {
      let buf = '';
      const timer = setTimeout(() => rej(new Error('browser did not report a devtools endpoint')), 20_000);
      proc.stderr?.on('data', (d: Buffer) => {
        buf += d.toString();
        const m = buf.match(/ws:\/\/[^\s]+/);
        if (m) {
          clearTimeout(timer);
          res(m[0]);
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        rej(new Error(`browser exited early (${code}): ${buf.slice(-400)}`));
      });
    }).catch((err) => {
      // Never leave a half-started shell behind for the retry to compete with.
      proc.kill('SIGKILL');
      throw err;
    });

    return new Browser(proc, endpoint);
  }

  /** Open a fresh tab and return a session attached to it. */
  async newPage(width: number, height: number): Promise<CdpSession> {
    const base = this.endpoint.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '');
    const r = await fetch(`${base}/json/new?about:blank`, { method: 'PUT' });
    const target = (await r.json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', () => rej(new Error('devtools socket failed')), { once: true });
    });
    const s = new CdpSession(ws);
    await s.send('Page.enable');
    await s.send('Runtime.enable');
    await s.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    return s;
  }

  close(): void {
    this.proc.kill('SIGTERM');
  }
}
