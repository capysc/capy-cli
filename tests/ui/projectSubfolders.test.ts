import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSubfolders } from '../../src/ui/projectSetup';

describe('projectSubfolders', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'capy-subfolders-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const make = (name: string, file: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, file), '', 'utf-8');
  };

  test('a subfolder with a .env is offered before ones with only a package file, even past the limit by name (run 17)', () => {
    make('atlas-analytics', 'package.json');
    make('beacon-ci', 'package.json');
    make('northwind-commerce', '.env');
    expect(projectSubfolders(root, 2)).toEqual([
      { name: 'northwind-commerce', marker: '.env' },
      { name: 'atlas-analytics', marker: 'package.json' },
    ]);
  });

  test('within each group, by name; a folder with both is a .env folder', () => {
    make('web', '.env');
    make('api', '.env');
    make('api', 'package.json');
    make('tools', 'go.mod');
    expect(projectSubfolders(root, 5)).toEqual([
      { name: 'api', marker: '.env' },
      { name: 'web', marker: '.env' },
      { name: 'tools', marker: 'go.mod' },
    ]);
  });
});
