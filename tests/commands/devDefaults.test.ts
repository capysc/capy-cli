import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dir, '../../src/index-dev.ts'), 'utf8');

test('capy-dev defaults to the canonical local API and Keep origins', () => {
  expect(source).toContain("process.env.CAPY_API_URL = 'http://localhost:3001'");
  expect(source).toContain("process.env.CAPY_KEEP_ORIGIN = 'http://keep.localhost:3002'");
});

test('capy-dev local defaults never replace explicit overrides', () => {
  expect(source).toContain('if (!process.env.CAPY_API_URL)');
  expect(source).toContain('if (!process.env.CAPY_KEEP_ORIGIN)');
});
