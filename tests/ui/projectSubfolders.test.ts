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

  test('every project subfolder, with no cap; one with a .env before ones with only a package file (run 17)', () => {
    make('atlas-analytics', 'package.json');
    make('beacon-ci', 'package.json');
    make('northwind-commerce', '.env');
    make('orion-api', 'pyproject.toml');
    mkdirSync(join(root, 'docs'));
    expect(projectSubfolders(root)).toEqual([
      { name: 'northwind-commerce', marker: '.env' },
      { name: 'atlas-analytics', marker: 'package.json' },
      { name: 'beacon-ci', marker: 'package.json' },
      { name: 'orion-api', marker: 'pyproject.toml' },
    ]);
  });

  test('within each group, by name; a folder with both is a .env folder', () => {
    make('web', '.env');
    make('api', '.env');
    make('api', 'package.json');
    make('tools', 'go.mod');
    expect(projectSubfolders(root)).toEqual([
      { name: 'api', marker: '.env' },
      { name: 'web', marker: '.env' },
      { name: 'tools', marker: 'go.mod' },
    ]);
  });
});
