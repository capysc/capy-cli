/**
 * planComposeForwardDetailed says WHY argv is left unchanged:
 *  - not-compose: not a compose command at all
 *  - nothing-to-forward: a compose command, but no service reads the Capy .env
 *  - undetermined: a compose command whose setup could not be worked out
 * The older planComposeForward keeps returning plan-or-undefined.
 */
import { describe, test, expect } from 'bun:test';
import {
  planComposeForward,
  planComposeForwardDetailed,
  resolveComposeFilesDetailed,
  type ComposeDeps,
} from '../../src/commands/composeForward';

const ENV = '/app/.env';

function deps(over: Partial<ComposeDeps> = {}): ComposeDeps {
  return {
    cwd: '/app',
    env: {},
    platform: 'darwin',
    exists: (p) => p === '/app/docker-compose.yml',
    readEnvFiles: () => ({ app: ['/app/.env'] }),
    ...over,
  };
}

describe('planComposeForwardDetailed', () => {
  test('(a) not a compose command: not-compose', () => {
    expect(planComposeForwardDetailed(['node', 'app.js'], ENV, ['K'], deps())).toEqual({ kind: 'not-compose' });
  });

  test('(b) compose, but no service reads the Capy .env: nothing-to-forward', () => {
    const result = planComposeForwardDetailed(['docker', 'compose', 'up'], ENV, ['K'], deps({ readEnvFiles: () => ({ db: [], web: ['/app/web.env'] }) }));
    expect(result).toEqual({ kind: 'nothing-to-forward' });
  });

  test('(b) compose subcommands that never read the project do not count as undetermined', () => {
    const noFiles = deps({ exists: () => false });
    expect(planComposeForwardDetailed(['docker', 'compose', 'version'], ENV, ['K'], noFiles)).toEqual({ kind: 'nothing-to-forward' });
    expect(planComposeForwardDetailed(['docker', 'compose', 'ls'], ENV, ['K'], noFiles)).toEqual({ kind: 'nothing-to-forward' });
  });

  test('(c) --project-directory: undetermined, with the gap', () => {
    const result = planComposeForwardDetailed(['docker', 'compose', '--project-directory', 'api', 'up'], ENV, ['K'], deps());
    expect(result).toEqual({ kind: 'undetermined', gap: 'project-directory' });
  });

  test('(c) no compose file to be found: undetermined, with the gap', () => {
    const result = planComposeForwardDetailed(['docker', 'compose', 'up'], ENV, ['K'], deps({ exists: () => false }));
    expect(result).toEqual({ kind: 'undetermined', gap: 'no-compose-file' });
  });

  test('(c) docker compose config failed: undetermined, with the gap', () => {
    const result = planComposeForwardDetailed(['docker', 'compose', 'up'], ENV, ['K'], deps({ readEnvFiles: () => undefined }));
    expect(result).toEqual({ kind: 'undetermined', gap: 'config-failed' });
  });

  test('success: forward, with the same plan planComposeForward returns', () => {
    const result = planComposeForwardDetailed(['docker', 'compose', 'up', '-d'], ENV, ['K'], deps());
    const plan = planComposeForward(['docker', 'compose', 'up', '-d'], ENV, ['K'], deps());
    expect(result.kind).toBe('forward');
    expect(result.kind === 'forward' ? result.plan.args : undefined).toEqual(plan?.args);
    expect(plan?.pipe).toBeDefined();
  });
});

describe('resolveComposeFilesDetailed', () => {
  test('agrees with resolveComposeFiles on success and says why on failure', () => {
    expect(resolveComposeFilesDetailed(['-f', 'a.yml'], '/app', {})).toEqual({ ok: true, files: ['a.yml'] });
    expect(resolveComposeFilesDetailed([], '/app', {}, () => false)).toEqual({ ok: false, gap: 'no-compose-file' });
  });
});
