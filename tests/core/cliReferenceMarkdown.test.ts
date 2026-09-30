/**
 * `renderCliReferenceMarkdown` (CAP-681) — pure doc -> markdown renderer
 * behind `bun run docs:cli` / `docs/cli-reference.md`. Pinned against a small
 * hand-built doc; tests/docs/cliReferenceStaleness.test.ts checks the
 * committed file against the real, built CLI's doc.
 */
import { describe, test, expect } from 'bun:test';
import { renderCliReferenceMarkdown } from '../../src/core/cliReferenceMarkdown';
import type { CliHelpDoc } from '../../src/core/cliHelpDoc';

function doc(overrides: Partial<CliHelpDoc> = {}): CliHelpDoc {
  return {
    ok: true,
    name: 'capy',
    version: '1.2.3',
    commands: [
      {
        name: 'status',
        path: 'status',
        description: 'Show status',
        arguments: [],
        options: [{ flags: '--json', long: '--json', description: 'emit JSON', negatable: false }],
        supportsJson: true,
        subcommands: [],
      },
      {
        name: 'deploy',
        path: 'deploy',
        description: 'Deploy things',
        arguments: [],
        options: [],
        supportsJson: false,
        subcommands: [
          {
            name: 'targets-remove',
            path: 'deploy targets-remove',
            description: 'Remove a target',
            arguments: [{ name: 'name', required: true, variadic: false }],
            options: [],
            supportsJson: false,
            subcommands: [],
          },
        ],
      },
    ],
    errorCodes: ['AUTH_FAILED', 'NETWORK_ERROR'],
    conventions: { json: 'Pass --json.', codes: 'Branch on code.' },
    ...overrides,
  };
}

describe('renderCliReferenceMarkdown', () => {
  test('is deterministic: the same doc renders byte-identical markdown', () => {
    const d = doc();
    expect(renderCliReferenceMarkdown(d)).toBe(renderCliReferenceMarkdown(d));
  });

  test('includes name, version, every command path, and nested subcommands', () => {
    const md = renderCliReferenceMarkdown(doc());
    expect(md).toContain('capy CLI reference');
    expect(md).toContain('1.2.3');
    expect(md).toContain('`capy status`');
    expect(md).toContain('`capy deploy`');
    expect(md).toContain('`capy deploy targets-remove`');
  });

  test('lists every error code', () => {
    const md = renderCliReferenceMarkdown(doc());
    expect(md).toContain('AUTH_FAILED');
    expect(md).toContain('NETWORK_ERROR');
  });

  test('marks JSON support per command', () => {
    const md = renderCliReferenceMarkdown(doc());
    const statusSection = md.slice(md.indexOf('`capy status`'), md.indexOf('`capy deploy`'));
    expect(statusSection).toContain('yes (`--json`)');
  });
});
