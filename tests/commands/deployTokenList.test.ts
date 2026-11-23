import { describe, test, expect } from 'bun:test';
import { renderDeployTokenList, withCredentialGeneration } from '../../src/commands/deployTokenCommand';
import type { DeployTokenInfo } from '../../src/service/serviceClient';

const base = {
  label: null,
  created_by: 'user_1',
  created_at: '2026-01-02T00:00:00.000Z',
  revoked_at: null,
};

const NEW: DeployTokenInfo = { ...base, deploy_id: 'a'.repeat(64), credential_generation: 'deploy_key' };
const LEGACY: DeployTokenInfo = { ...base, deploy_id: 'b'.repeat(64), credential_generation: 'project_key' };
// An older service omits the field entirely.
const OMITTED: DeployTokenInfo = { ...base, deploy_id: 'c'.repeat(64) };

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('capy deploy list — credential generation', () => {
  test('a missing credential_generation is treated as project_key', () => {
    expect(withCredentialGeneration(OMITTED).credential_generation).toBe('project_key');
    expect(withCredentialGeneration(NEW).credential_generation).toBe('deploy_key');
    expect(withCredentialGeneration(LEGACY).credential_generation).toBe('project_key');
  });

  test('--json carries the service credential_generation on every token, defaulting an omitted one', () => {
    const lines = renderDeployTokenList([NEW, LEGACY, OMITTED], 'my-project', true);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { tokens: Array<Record<string, unknown>> };
    expect(parsed.tokens.map((t) => [t.deploy_id, t.credential_generation])).toEqual([
      ['a'.repeat(64), 'deploy_key'],
      ['b'.repeat(64), 'project_key'],
      ['c'.repeat(64), 'project_key'],
    ]);
    // The rest of the service row passes through untouched.
    expect(parsed.tokens[0]).toMatchObject({ label: null, created_by: 'user_1', revoked_at: null });
  });

  test('--json with no tokens is still one JSON document', () => {
    expect(JSON.parse(renderDeployTokenList([], 'p', true)[0])).toEqual({ tokens: [] });
  });

  test('the human list shows each generation and marks a project_key token as legacy', () => {
    const lines = renderDeployTokenList([NEW, LEGACY, OMITTED], 'my-project', false).map(stripAnsi);
    const rowOf = (idPrefix: string) => lines.find((l) => l.includes(idPrefix.slice(0, 12))) ?? '';
    expect(rowOf('a'.repeat(12))).toContain('deploy key');
    expect(rowOf('a'.repeat(12))).not.toContain('legacy');
    expect(rowOf('b'.repeat(12))).toContain('project key (legacy)');
    expect(rowOf('c'.repeat(12))).toContain('project key (legacy)');
  });

  test('the human list with no tokens says so and prints no JSON', () => {
    expect(renderDeployTokenList([], 'p', false).map(stripAnsi)).toEqual(['  No deploy tokens for this project.']);
  });
});
