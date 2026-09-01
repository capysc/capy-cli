import { spawnSync } from 'child_process';
import { existsSync } from 'fs';

/**
 * Locating the `gh` binary, without trusting the caller's PATH.
 *
 * Capy shelled out to a bare `gh` and detected it with a bare `which gh`, so
 * both the detection and the call depended on the same PATH — and a Homebrew
 * install lives in `/opt/homebrew/bin`, which is absent from the environment
 * of anything not launched from a login shell. The result was capy reporting
 * "gh CLI not installed" about a `gh` sitting right there, which sends the
 * user to reinstall something they already have.
 *
 * PATH is still consulted FIRST, so a custom install or a version manager
 * keeps winning. The fixed locations are a fallback for the case PATH cannot
 * answer, not an override of it.
 */
const FALLBACK_PATHS = [
  '/opt/homebrew/bin/gh', // Homebrew, Apple Silicon
  '/usr/local/bin/gh', // Homebrew, Intel macOS
  '/home/linuxbrew/.linuxbrew/bin/gh', // Homebrew, Linux
  '/usr/bin/gh', // apt/dnf
];

/** Where we looked, for an error message that can be acted on. */
export const GH_SEARCHED = ['PATH', ...FALLBACK_PATHS];

/**
 * Absolute path to `gh`, or null when it genuinely is not installed.
 *
 * Deliberately uncached. Resolution is a few `existsSync` calls plus at most
 * one `which`, it happens a handful of times per run, and a module-level cache
 * would have to be mutable — not worth trading immutability for microseconds.
 */
export function resolveGh(): string | null {
  const onPath = spawnSync('which', ['gh'], { encoding: 'utf-8' });
  if (onPath.status === 0) {
    const found = onPath.stdout.trim().split('\n')[0]?.trim();
    if (found) return found;
  }
  return FALLBACK_PATHS.find((p) => existsSync(p)) ?? null;
}

/** Is `gh` available at all? The boolean half of `resolveGh`. */
export function ghInstalled(): boolean {
  return resolveGh() !== null;
}
