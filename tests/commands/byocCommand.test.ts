import { mock, describe, it, expect, beforeEach, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-byoc-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

// Stub inquirer.prompt — each test queues responses by setting `nextResponses`.
let nextResponses: any[] = [];
mock.module('inquirer', () => ({
  default: {
    prompt: async (_questions: any) => {
      if (nextResponses.length === 0) {
        throw new Error('test: inquirer.prompt called with no queued response');
      }
      return nextResponses.shift();
    },
  },
}));

let byocCommand: typeof import('../../src/commands/byocCommand').byocCommand;
let profileConfig: typeof import('../../src/config/profileConfig');

beforeEach(async () => {
  // Wipe state between tests.
  const capyDir = join(tempHome, '.capy');
  if (existsSync(capyDir)) rmSync(capyDir, { recursive: true, force: true });
  delete process.env.CAPY_API_URL;
  delete process.env.CAPY_PROFILE;
  nextResponses = [];

  // Fresh import per test — bun mock.module is module-cached.
  byocCommand = (await import('../../src/commands/byocCommand')).byocCommand;
  profileConfig = await import('../../src/config/profileConfig');
});

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
  mock.restore();
});

// Tiny fetch stubber. Tests set `fetchHandler` to a function that takes the
// URL and returns a Response (or throws). Reset between tests by beforeEach.
const realFetch = global.fetch;
let fetchHandler: (url: string) => Response | Promise<Response>;
function stubFetch() {
  global.fetch = ((url: string) => Promise.resolve(fetchHandler(url))) as any;
}
function restoreFetch() {
  global.fetch = realFetch;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('byocCommand', () => {
  describe('happy path — default URL probe succeeds', () => {
    it('probes capy.internal, derives profile name, saves and switches', async () => {
      fetchHandler = (url) => {
        expect(url).toBe('https://capy.internal/health');
        return ok({ status: 'ok', service: 'capy' });
      };
      stubFetch();
      // Profile name prompt — accept the suggested default.
      nextResponses = [{ name: 'internal' }];

      const code = await byocCommand();
      restoreFetch();

      expect(code).toBe(0);
      const config = profileConfig.readProfileConfig();
      expect(config?.default).toBe('internal');
      expect(config?.profiles.internal.url).toBe('https://capy.internal');
    });
  });

  describe('happy path — explicit URL arg', () => {
    it('skips the default probe and probes the given URL', async () => {
      fetchHandler = (url) => {
        expect(url).toBe('https://capy.acme.com/health');
        return ok({ status: 'ok', service: 'capy' });
      };
      stubFetch();
      nextResponses = [{ name: 'acme' }];

      const code = await byocCommand('https://capy.acme.com');
      restoreFetch();

      expect(code).toBe(0);
      expect(profileConfig.readProfileConfig()?.profiles.acme.url).toBe('https://capy.acme.com');
    });

    it('normalizes bare hostnames to https://', async () => {
      let probedUrl = '';
      fetchHandler = (url) => {
        probedUrl = url;
        return ok({ status: 'ok', service: 'capy' });
      };
      stubFetch();
      nextResponses = [{ name: 'acme' }];

      await byocCommand('capy.acme.com');
      restoreFetch();

      expect(probedUrl).toBe('https://capy.acme.com/health');
    });

    it('strips trailing slashes', async () => {
      fetchHandler = () => ok({ status: 'ok', service: 'capy' });
      stubFetch();
      nextResponses = [{ name: 'acme' }];

      await byocCommand('https://capy.acme.com///');
      restoreFetch();

      expect(profileConfig.readProfileConfig()?.profiles.acme.url).toBe('https://capy.acme.com');
    });
  });

  describe('validation', () => {
    it('rejects responses without service: "capy"', async () => {
      let calls = 0;
      fetchHandler = (url) => {
        calls += 1;
        if (calls === 1) return ok({ status: 'ok' }); // not capy
        return ok({ status: 'ok', service: 'capy' });
      };
      stubFetch();
      // After rejection, prompt asks for URL, then for profile name.
      nextResponses = [{ url: 'https://retry.example.com' }, { name: 'retry' }];

      const code = await byocCommand();
      restoreFetch();

      expect(code).toBe(0);
      expect(profileConfig.readProfileConfig()?.profiles.retry.url).toBe('https://retry.example.com');
    });

    it('rejects non-200 health status and loops', async () => {
      let calls = 0;
      fetchHandler = (url) => {
        calls += 1;
        if (calls === 1) return new Response('', { status: 503 });
        return ok({ status: 'ok', service: 'capy' });
      };
      stubFetch();
      nextResponses = [{ url: 'https://retry.example.com' }, { name: 'retry' }];

      const code = await byocCommand();
      restoreFetch();

      expect(code).toBe(0);
    });
  });

  describe('connection failure prompts for URL', () => {
    it('loops on connection refused', async () => {
      let calls = 0;
      fetchHandler = (url) => {
        calls += 1;
        if (calls === 1) {
          const err: any = new Error('connect failed');
          err.cause = { code: 'ECONNREFUSED' };
          throw err;
        }
        return ok({ status: 'ok', service: 'capy' });
      };
      // Override stubFetch to actually throw — Promise.resolve(throws) coerces wrong.
      global.fetch = ((url: string) => {
        try {
          return Promise.resolve(fetchHandler(url));
        } catch (err) {
          return Promise.reject(err);
        }
      }) as any;
      nextResponses = [{ url: 'https://retry.example.com' }, { name: 'retry' }];

      const code = await byocCommand();
      restoreFetch();

      expect(code).toBe(0);
      expect(profileConfig.readProfileConfig()?.profiles.retry.url).toBe('https://retry.example.com');
    });
  });

  describe('overwrite confirmation', () => {
    it('prompts and skips when user declines overwrite', async () => {
      // Existing profile "acme" with a different URL.
      profileConfig.saveAndActivateProfile('acme', { url: 'https://old.example.com' });

      fetchHandler = () => ok({ status: 'ok', service: 'capy' });
      stubFetch();
      // 1st name prompt: choose "acme" (already exists)
      // 2nd confirm prompt: decline overwrite
      // 3rd name prompt: choose a different name
      nextResponses = [{ name: 'acme' }, { confirm: false }, { name: 'acme2' }];

      const code = await byocCommand('https://capy.acme.com');
      restoreFetch();

      expect(code).toBe(0);
      const config = profileConfig.readProfileConfig();
      expect(config?.profiles.acme.url).toBe('https://old.example.com');
      expect(config?.profiles.acme2.url).toBe('https://capy.acme.com');
      expect(config?.default).toBe('acme2');
    });
  });
});
