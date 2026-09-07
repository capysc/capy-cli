import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyRepositoryEdits, composeRepositoryPlan, computeRepositoryEdits, inferRepositoryServices, prepareRepository } from '../../src/core/repositoryPreparation';

const discovery = { stack: ['Next.js', 'Node.js'], evidence_files: ['package.json'] } as const;
const source = JSON.stringify({ name: 'fixture', dependencies: { next: 'fixture-only' },
  scripts: { dev: 'next dev', start: 'next start', test: 'test-runner' } }, null, 2) + '\n';
const base = { ok: true, plan_hash: `sha256:${'a'.repeat(64)}`, will_write: ['.env'] } as const;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'capy-preparation-test-'));
  writeFileSync(join(root, 'package.json'), source);
  writeFileSync(join(root, '.env'), 'STRIPE_SECRET_KEY=disposable-value-not-public\nUNRECOGNIZED_KEY=another-private-value\n');
  writeFileSync(join(root, 'env.example'), 'SUPABASE_URL=example-not-public\n');
  return root;
}
describe('restored onboarding preparation', () => {
  test('uses agent stack, current connector registry and names-only service inference', () => {
    const result = prepareRepository(fixture(), discovery, 'capy-dev');
    expect(result.summary.stack).toEqual(discovery.stack);
    expect(result.summary.services).toEqual([
      { id: 'stripe', name: 'Stripe', connection: 'available', variable_names: ['STRIPE_SECRET_KEY'] },
      { id: 'supabase', name: 'Supabase', connection: 'manual', variable_names: ['SUPABASE_URL'] },
    ]);
    expect(JSON.stringify(result.summary)).not.toContain('disposable-value');
    expect(JSON.stringify(result.summary)).not.toContain('example-not-public');
    expect(result.summary.file_changes).toEqual([{ path: 'package.json', description: 'Run dev, start scripts through capy-dev run.' }]);
  });
  test('approved edit wraps only run scripts and is idempotent', () => {
    const root = fixture();
    const edits = computeRepositoryEdits(root, 'capy-dev');
    applyRepositoryEdits(root, edits);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts).toEqual({ dev: 'capy-dev run -- next dev', start: 'capy-dev run -- next start', test: 'test-runner' });
    expect(pkg.dependencies).toEqual({ next: 'fixture-only' });
    expect(computeRepositoryEdits(root, 'capy-dev')).toEqual([]);
    expect(computeRepositoryEdits(root, 'capy')).toEqual([]);
  });
  test('wraps Procfile processes without double wrapping', () => {
    const root = fixture();
    writeFileSync(join(root, 'Procfile'), '# comment\nweb: node server.js\nworker: capy run -- node worker.js\n');
    applyRepositoryEdits(root, computeRepositoryEdits(root, 'capy-dev'));
    expect(readFileSync(join(root, 'Procfile'), 'utf8')).toBe('# comment\nweb: capy-dev run -- node server.js\nworker: capy run -- node worker.js\n');
  });
  test('all-file preflight preserves every file when one approved input changed', () => {
    const root = fixture();
    writeFileSync(join(root, 'Procfile'), 'web: node server.js\n');
    const edits = computeRepositoryEdits(root, 'capy-dev');
    writeFileSync(join(root, 'Procfile'), 'web: node changed.js\n');
    expect(() => applyRepositoryEdits(root, edits)).toThrow('SETUP_FILES_CHANGED');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(source);
  });
  test('composed approval binds edits, stack, evidence and base encryption plan', () => {
    const root = fixture();
    const first = composeRepositoryPlan(base, prepareRepository(root, discovery, 'capy-dev'));
    expect(first.will_write).toEqual(['.env', 'package.json']);
    expect(first.summary).toMatchObject({ env_files: ['.env'] });
    expect(first.plan_hash).not.toBe(base.plan_hash);
    expect(composeRepositoryPlan(base, prepareRepository(root, discovery, 'capy-dev')).plan_hash).toBe(first.plan_hash);
    expect(composeRepositoryPlan(base, prepareRepository(root, { ...discovery, stack: ['Node.js'] }, 'capy-dev')).plan_hash).not.toBe(first.plan_hash);
    writeFileSync(join(root, 'package.json'), source.replace('next start', 'next start --port 4000'));
    expect(composeRepositoryPlan(base, prepareRepository(root, discovery, 'capy-dev')).plan_hash).not.toBe(first.plan_hash);
  });
  test('summary never exports actual script contents even if a manifest hardcodes a credential', () => {
    const root = fixture();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'TOKEN=never-export-this next dev' } }));
    const plan = composeRepositoryPlan(base, prepareRepository(root, discovery, 'capy-dev'));
    expect(JSON.stringify(plan)).not.toContain('never-export-this');
    expect(JSON.stringify(plan)).not.toContain('before');
    expect(JSON.stringify(plan)).not.toContain('after');
  });
  test('rich approval accounts for canonical project-binding writes as well as edits and encryption', () => {
    const plan = composeRepositoryPlan({ ...base, will_write: ['keep.lock', '.env'] }, prepareRepository(fixture(), discovery, 'capy-dev'));
    expect(plan.summary).toMatchObject({ env_files: ['.env'], file_changes: [
      { path: 'package.json', description: 'Run dev, start scripts through capy-dev run.' },
      { path: 'keep.lock', description: 'Save this repository’s project binding.' },
    ] });
  });
  test('rejects missing, secret, traversal and symlink evidence', () => {
    const root = fixture();
    for (const path of ['.env', '.env.local', 'env.example', '../package.json', '/package.json']) {
      expect(() => prepareRepository(root, { stack: ['Node.js'], evidence_files: [path] }, 'capy-dev')).toThrow();
    }
    expect(() => prepareRepository(root, { stack: ['Node.js'], evidence_files: [] }, 'capy-dev')).toThrow('SETUP_DISCOVERY_INVALID');
    symlinkSync(join(root, 'package.json'), join(root, 'linked.json'));
    expect(() => prepareRepository(root, { stack: ['Node.js'], evidence_files: ['linked.json'] }, 'capy-dev')).toThrow('SETUP_DISCOVERY_FILE_UNSAFE');
  });
  test('refuses invalid manifests and symlink edit targets without writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'capy-preparation-test-'));
    const elsewhere = fixture();
    symlinkSync(join(elsewhere, 'package.json'), join(root, 'package.json'));
    expect(() => computeRepositoryEdits(root, 'capy-dev')).toThrow('SETUP_DISCOVERY_FILE_UNSAFE');
    expect(readFileSync(join(elsewhere, 'package.json'), 'utf8')).toBe(source);
  });
  test('unknown services stay unclaimed and browser-prefixed names are recognized', () => {
    expect(inferRepositoryServices(['UNKNOWN_TOKEN'])).toEqual([]);
    expect(inferRepositoryServices(['NEXT_PUBLIC_SUPABASE_URL'])[0]?.connection).toBe('manual');
  });
});
