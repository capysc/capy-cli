import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { devOrigins } from '../../src/config/devTarget';

const source = readFileSync(resolve(import.meta.dir, '../../src/index-dev.ts'), 'utf8');

test('the source entrypoint uses the shared hosted Development defaults', () => {
  expect(source).toContain('process.env.CAPY_API_URL = devOrigins().CAPY_API_URL');
  expect(source).toContain('process.env.CAPY_KEEP_ORIGIN = devOrigins().CAPY_KEEP_ORIGIN');
});

test('the source entrypoint preserves explicit overrides and saved API profiles', () => {
  expect(source).toContain('if (!process.env.CAPY_API_URL)');
  expect(source).toContain('if (!process.env.CAPY_KEEP_ORIGIN)');
  expect(source).toContain('if (!existsSync(configPath))');
});

const wrapper = readFileSync(resolve(import.meta.dir, '../../bin/capy-dev'), 'utf8');

function wrapperEnvironment(env: Readonly<NodeJS.ProcessEnv> = {}): Readonly<NodeJS.ProcessEnv> {
  const context = {
    process: { env: { ...env } },
    require: (path: string) => {
      if (path === '../dist/config/devTarget.js') return { devOrigins: () => devOrigins(env) };
      if (path === '../dist/index-dev.js') return {};
      throw new Error(`Unexpected wrapper dependency: ${path}`);
    },
  };
  runInNewContext(wrapper, context);
  return { ...context.process.env };
}

test('the wrapper defaults to HTTPS on the stable tailnet ports', () => {
  expect(wrapperEnvironment()).toMatchObject({
    CAPY_API_URL: 'https://mabels-mac-mini.tailcbfb49.ts.net:3444',
    CAPY_KEEP_ORIGIN: 'https://mabels-mac-mini.tailcbfb49.ts.net:3443',
  });
});

test('the wrapper retains explicit endpoint overrides', () => {
  const overrides = { CAPY_API_URL: 'http://localhost:9876', CAPY_KEEP_ORIGIN: 'http://localhost:9877' };
  expect(wrapperEnvironment(overrides)).toMatchObject(overrides);
});

test('custom Development host updates both defaults and empty overrides use defaults', () => {
  expect(wrapperEnvironment({ CAPY_DEV_HOST: 'another-rig.example', CAPY_API_URL: '', CAPY_KEEP_ORIGIN: '' }))
    .toMatchObject({
      CAPY_API_URL: 'https://another-rig.example:3444',
      CAPY_KEEP_ORIGIN: 'https://another-rig.example:3443',
    });
});
