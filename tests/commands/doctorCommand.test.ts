import { mock, describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// Mock homedir to use a temp directory — must come before any import that
// reaches os.homedir() (getGlobalCapyDir does, transitively, on every call).
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-doctor-cmd-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

let doctorCommand: typeof import('../../src/commands/doctorCommand');
const pkgVersion: string = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')).version;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['CAPY_API_URL', 'CAPY_KEEP_ORIGIN', 'CAPY_PROFILE', 'CAPY_GLOBAL_DIR_NAME', 'CAPY_BIN_NAME'];

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const capyDir = join(tempHome, '.capy');
  if (existsSync(capyDir)) rmSync(capyDir, { recursive: true, force: true });

  doctorCommand = await import('../../src/commands/doctorCommand');
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tempHome, { recursive: true, force: true });
  mock.restore();
});

describe('collectDoctorReport', () => {
  it('has the full report shape', async () => {
    const report = await doctorCommand.collectDoctorReport();

    expect(report.cli).toBeDefined();
    expect(typeof report.cli.bin).toBe('string');
    expect(typeof report.cli.version).toBe('string');
    expect(typeof report.cli.node).toBe('string');
    expect(typeof report.cli.platform).toBe('string');
    expect(typeof report.cli.arch).toBe('string');

    expect(typeof report.stateDir).toBe('string');

    expect(report.origins).toBeDefined();
    expect(typeof report.origins.api).toBe('string');
    expect(typeof report.origins.keep).toBe('string');
    expect(typeof report.origins.apiFromEnv).toBe('boolean');
    expect(typeof report.origins.keepFromEnv).toBe('boolean');

    expect(report.session).toBeDefined();
    expect(typeof report.session.present).toBe('boolean');
    expect(report.session.dir).toBeDefined();

    expect(report.project).toBeDefined();
    expect(typeof report.project.cwd).toBe('string');
    expect(typeof report.project.initialized).toBe('boolean');
    expect(typeof report.project.hasKeepFile).toBe('boolean');
  });

  it('reports cli.version matching package.json', async () => {
    const report = await doctorCommand.collectDoctorReport();
    expect(report.cli.version).toBe(pkgVersion);
  });

  it('session absent → present:false, userId:null, dir ends with auth/sessions', async () => {
    const report = await doctorCommand.collectDoctorReport();
    expect(report.session.present).toBe(false);
    expect(report.session.userId).toBeNull();
    expect(report.session.error).toBeNull();
    expect(report.session.dir.endsWith(join('auth', 'sessions'))).toBe(true);
  });

  it('session present → present:true, userId matches, and secrets never leak into the report', async () => {
    const userId = 'user_abc123';
    const sessionsDir = join(tempHome, '.capy', 'auth', 'sessions');
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    const sessionRecord = {
      version: 2,
      user_id: userId,
      access_token: 'SECRET_ACCESS_TOKEN_X',
      refresh_token: 'SECRET_REFRESH_Y',
      expires_at: Date.now() + 3600_000,
    };
    writeFileSync(join(sessionsDir, `${userId}.json`), JSON.stringify(sessionRecord, null, 2), { mode: 0o600 });

    const report = await doctorCommand.collectDoctorReport();

    expect(report.session.present).toBe(true);
    expect(report.session.userId).toBe(userId);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('SECRET_ACCESS_TOKEN_X');
    expect(serialized).not.toContain('SECRET_REFRESH_Y');
  });

  it('env overrides: CAPY_API_URL / CAPY_KEEP_ORIGIN reflected with *FromEnv true', async () => {
    process.env.CAPY_API_URL = 'https://custom-api.example.com';
    process.env.CAPY_KEEP_ORIGIN = 'https://custom-keep.example.com';

    const report = await doctorCommand.collectDoctorReport();

    expect(report.origins.api).toBe('https://custom-api.example.com');
    expect(report.origins.keep).toBe('https://custom-keep.example.com');
    expect(report.origins.apiFromEnv).toBe(true);
    expect(report.origins.keepFromEnv).toBe(true);
  });

  it('no env overrides → *FromEnv false', async () => {
    const report = await doctorCommand.collectDoctorReport();
    expect(report.origins.apiFromEnv).toBe(false);
    expect(report.origins.keepFromEnv).toBe(false);
  });
});

describe('DoctorCommand --json', () => {
  it('emits exactly one console.log call whose text parses as JSON with the expected keys', async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await new doctorCommand.DoctorCommand().execute({ json: true });
    } finally {
      console.log = original;
    }

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed).toHaveProperty('cli');
    expect(parsed).toHaveProperty('stateDir');
    expect(parsed).toHaveProperty('origins');
    expect(parsed).toHaveProperty('profile');
    expect(parsed).toHaveProperty('session');
    expect(parsed).toHaveProperty('project');
    // Pretty-printed with 2-space indent, per JSON.stringify(obj, null, 2).
    expect(logs[0]).toContain('\n  "cli"');
  });

  it('does not throw and needs no captured process.exit call', async () => {
    await expect(new doctorCommand.DoctorCommand().execute({ json: true })).resolves.toBeUndefined();
  });
});
