/**
 * A fake Capy service that REMEMBERS what it was sent, for the tests that read a pushed location back.
 *
 * tests/helpers/secretsWorld.ts is stateless: a read always answers the fixture. That cannot show whether a pushed
 * value is held, so here what a read returns is derived from the log of pushes this service accepted for that branch
 * (the last one wins), the way the real service answers. Nothing is mutated: the log is the `mock` call record, and a
 * read folds over it.
 *
 * A push can be told to misbehave, by (location, push number counted from 0 for that location):
 *   - `loses`    answered 200 and not kept at all (the later write of another branch overwrote it);
 *   - `wipesPin` the blob is kept, the keep (the pin) is not;
 *   - `pushError` refused with this error.
 * `readError` makes a read fail (read number counted from 0 for that location).
 * Every call also logs `start` and `end` events (`+project/branch`, `-project/branch`) with an optional delay, so a test
 * can see which locations were in flight together.
 */
import { mock } from 'bun:test';
import { SyncEngine } from '../../src/sync/syncEngine';
import type { CapyError } from '../../src/types/index';
import type { KeepFile } from '../../src/types/index';
import { fakeService, type Loc } from './secretsWorld';

export interface StatefulOpts {
  readonly locs?: readonly Loc[];
  readonly loses?: (location: string, pushNumber: number) => boolean;
  readonly wipesPin?: (location: string, pushNumber: number) => boolean;
  readonly pushError?: (location: string, pushNumber: number) => CapyError | undefined;
  readonly readError?: (location: string, readNumber: number) => CapyError | undefined;
  readonly delayMs?: (location: string) => number;
}

interface Attempt {
  readonly location: string;
  readonly keepFile: string;
  readonly blob: string;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const locationKey = (projectId: string, branch: string | undefined): string => `${projectId}/${branch}`;

export function statefulService(opts: StatefulOpts = {}) {
  const base = fakeService({ locs: opts.locs });
  const log = mock((_event: string) => undefined);
  const readsOf = mock((_location: string) => undefined);
  const attempts = mock((_a: Attempt) => undefined);

  const attemptsAt = (location: string): readonly Attempt[] => attempts.mock.calls.map((c) => c[0]).filter((a) => a.location === location);

  /** What the service holds for a branch now: the blob and the keep, folded over the pushes it kept. */
  const stateAt = async (projectId: string, branch: string | undefined) => {
    const location = locationKey(projectId, branch);
    const fixture = await base.getDecryptData(projectId, branch);
    return attemptsAt(location).reduce(
      (held, a, n) => {
        if (opts.pushError?.(location, n) !== undefined || opts.loses?.(location, n) === true) return held;
        return { ...held, env_content: a.blob, keep_file: opts.wipesPin?.(location, n) === true ? held.keep_file : a.keepFile };
      },
      fixture,
    );
  };

  const getDecryptData = mock(async (projectId: string, branch?: string, _keepHash?: string, _latest?: boolean, _onRate?: unknown) => {
    const location = locationKey(projectId, branch);
    const readNumber = readsOf.mock.calls.filter((c) => c[0] === location).length;
    readsOf(location);
    log(`+${location}`);
    await sleepMs(opts.delayMs?.(location) ?? 0);
    const failure = opts.readError?.(location, readNumber);
    if (failure !== undefined) {
      log(`-${location}`);
      throw failure;
    }
    const held = await stateAt(projectId, branch);
    log(`-${location}`);
    return held;
  });

  const pushSecrets = mock(async (projectId: string, keepFile: string, blob: string, branch: string, _onRate?: unknown, _baseKeepHash?: string) => {
    const location = locationKey(projectId, branch);
    const pushNumber = attemptsAt(location).length;
    attempts({ location, keepFile, blob });
    log(`+${location}`);
    await sleepMs(opts.delayMs?.(location) ?? 0);
    log(`-${location}`);
    const failure = opts.pushError?.(location, pushNumber);
    if (failure !== undefined) throw failure;
    const keep = JSON.parse(keepFile) as KeepFile;
    return { keep_hash: SyncEngine.computeKeepHash(keep, branch), keep_file: keepFile };
  });

  return {
    getDecryptData,
    pushSecrets,
    events: (): readonly string[] => log.mock.calls.map((c) => c[0]),
    pushesTo: (location: string): number => attemptsAt(location).length,
    readsOf: (location: string): number => readsOf.mock.calls.filter((c) => c[0] === location).length,
  };
}

/** Each location's window in an event log: the position of its first and of its last event. */
export function windowsOf(events: readonly string[]): ReadonlyArray<{ readonly location: string; readonly first: number; readonly last: number }> {
  const locations = [...new Set(events.map((e) => e.slice(1)))];
  return locations.map((location) => ({
    location,
    first: events.findIndex((e) => e.slice(1) === location),
    last: events.map((e) => e.slice(1)).lastIndexOf(location),
  }));
}

/** Whether two windows share any moment. */
export const overlap = (a: { readonly first: number; readonly last: number }, b: { readonly first: number; readonly last: number }): boolean =>
  a.first < b.last && b.first < a.last;
