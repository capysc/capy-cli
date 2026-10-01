/**
 * CAP-659 — pure unit tests for the shared dry-run result type, exit-code
 * rule and printers. No Commander, no filesystem, no process spawn.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { EXIT_NEEDS_INPUT } from '../../src/ui/interactive';
import {
  dryRunOk,
  dryRunRefused,
  dryRunExitCode,
  formatDryRunResultHuman,
  printDryRunResultJson,
  printDryRunResultHuman,
  DRY_RUN_EXIT_PROCEED,
  DRY_RUN_EXIT_REFUSE,
  DRY_RUN_EXIT_NEEDS_INPUT,
  type DryRunChange,
} from '../../src/core/dryRun';

describe('dryRunOk / dryRunRefused — shape', () => {
  test('dryRunOk defaults to no changes and no unanswered', () => {
    const result = dryRunOk('status');
    expect(result).toEqual({ ok: true, dry_run: true, command: 'status', changes: [], unanswered: [] });
  });

  test('dryRunOk carries changes and unanswered through unmodified', () => {
    const change: DryRunChange = { where: 'capy_service', action: 'remove_member', target: 'bob@example.com', reversible: false };
    const result = dryRunOk('kick', [change], [{ id: 'role', flag: '--role' }]);
    expect(result.changes).toEqual([change]);
    expect(result.unanswered).toEqual([{ id: 'role', flag: '--role' }]);
  });

  test('dryRunRefused carries the command and code', () => {
    expect(dryRunRefused('cleanup', 'DRY_RUN_UNSUPPORTED')).toEqual({
      ok: false,
      dry_run: true,
      command: 'cleanup',
      code: 'DRY_RUN_UNSUPPORTED',
    });
  });
});

describe('dryRunExitCode', () => {
  test('refused -> 1', () => {
    expect(dryRunExitCode(dryRunRefused('cleanup', 'DRY_RUN_UNSUPPORTED'))).toBe(DRY_RUN_EXIT_REFUSE);
    expect(DRY_RUN_EXIT_REFUSE).toBe(1);
  });

  test('ok with no unanswered choices -> 0 (the real run would proceed)', () => {
    expect(dryRunExitCode(dryRunOk('status'))).toBe(DRY_RUN_EXIT_PROCEED);
    expect(DRY_RUN_EXIT_PROCEED).toBe(0);
  });

  test('ok with an unanswered choice -> 3, matching EXIT_NEEDS_INPUT', () => {
    const result = dryRunOk('invite', [], [{ id: 'role', flag: '--role' }]);
    expect(dryRunExitCode(result)).toBe(DRY_RUN_EXIT_NEEDS_INPUT);
    expect(DRY_RUN_EXIT_NEEDS_INPUT).toBe(EXIT_NEEDS_INPUT);
    expect(DRY_RUN_EXIT_NEEDS_INPUT).toBe(3);
  });
});

describe('formatDryRunResultHuman — minimal, neutral (COPY-FLAG)', () => {
  test('refusal names the code', () => {
    const text = formatDryRunResultHuman(dryRunRefused('cleanup', 'DRY_RUN_UNSUPPORTED'));
    expect(text).toContain('DRY_RUN_UNSUPPORTED');
  });

  test('no changes and nothing unanswered reads as "no changes"', () => {
    expect(formatDryRunResultHuman(dryRunOk('status'))).toBe('Dry run: no changes.');
  });

  test('lists each change, marking irreversible ones', () => {
    const change: DryRunChange = { where: 'capy_service', action: 'remove_member', target: 'bob@example.com', reversible: false };
    const text = formatDryRunResultHuman(dryRunOk('kick', [change]));
    expect(text).toContain('remove_member');
    expect(text).toContain('bob@example.com');
    expect(text).toContain('not reversible');
  });

  test('lists unanswered choices with the flag that would settle each', () => {
    const text = formatDryRunResultHuman(dryRunOk('invite', [], [{ id: 'role', flag: '--role' }]));
    expect(text).toContain('--role');
  });

  test('never prints a secret value — only structured fields reach the text', () => {
    const change: DryRunChange = { where: 'local_file', action: 'write', target: 'STRIPE_SECRET_KEY', reversible: true };
    const text = formatDryRunResultHuman(dryRunOk('add', [change]));
    expect(text).not.toContain('sk_test_');
    expect(text).not.toContain('sk_live_');
  });
});

describe('printers — correct stream, exactly one line of output', () => {
  test('printDryRunResultJson writes exactly one parseable JSON line to stdout', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      printDryRunResultJson(dryRunRefused('cleanup', 'DRY_RUN_UNSUPPORTED'));
      expect(log).toHaveBeenCalledTimes(1);
      const printed = log.mock.calls[0][0] as string;
      expect(JSON.parse(printed)).toEqual({
        ok: false,
        dry_run: true,
        command: 'cleanup',
        code: 'DRY_RUN_UNSUPPORTED',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('printDryRunResultHuman sends a refusal to stderr, never stdout', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      printDryRunResultHuman(dryRunRefused('cleanup', 'DRY_RUN_UNSUPPORTED'));
      expect(error).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test('printDryRunResultHuman sends an ok preview to stdout, never stderr', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      printDryRunResultHuman(dryRunOk('status'));
      expect(log).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
