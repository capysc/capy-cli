// A `.env` is the user's file: comments, `# --- Infra ---` dividers, blank-line
// groups and variable order must survive every Capy write. Only values change.
// Layout is local only — it never reaches keep.lock, hashes or the server.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { upsertEnvText } from '../../src/files/envUpsert';
import { FileManager } from '../../src/files/fileManager';

const KEY = 'a'.repeat(64);

describe('upsertEnvText', () => {
  it('fresh file keeps the old header + list format', () => {
    expect(upsertEnvText('', { org_id: 'o', project_id: 'p', branch: 'main' }, [['A', '1'], ['B', '2']]))
      .toBe('# capy:org_id=o\n# capy:project_id=p\n# capy:branch=main\n\nA=1\nB=2\n');
    expect(upsertEnvText('', {}, [['A', '1']])).toBe('A=1\n');
  });

  it('keeps comments, dividers, blank groups and order; replaces only values', () => {
    const before = [
      '# capy:org_id=o',
      '# capy:project_id=p',
      '# capy:branch=main',
      '',
      '# --- Infra ---',
      'DB_URL=old-db',
      'REDIS=old-redis',
      '',
      '# --- Payments ---',
      '# live key, rotate quarterly',
      'STRIPE=old-stripe',
      '',
    ].join('\n');
    const after = upsertEnvText(before, { branch: 'main' }, [['STRIPE', 's2'], ['DB_URL', 'd2'], ['REDIS', 'r2']]);
    expect(after).toBe(before.replace('old-db', 'd2').replace('old-redis', 'r2').replace('old-stripe', 's2'));
  });

  it('removes only the line of a dropped key and appends new keys at the end', () => {
    const before = '# --- A ---\nX=1\nY=2\n\n# --- B ---\nZ=3\n';
    expect(upsertEnvText(before, {}, [['X', '1'], ['Z', '3'], ['NEW', '4']]))
      .toBe('# --- A ---\nX=1\n\n# --- B ---\nZ=3\nNEW=4\n');
  });

  it('keeps export prefix, indentation and inline comments', () => {
    const before = 'export A=1 # note\n  B="x" # quoted note\nC=\'y\'\n';
    expect(upsertEnvText(before, {}, [['A', 'n1'], ['B', 'n2'], ['C', 'n3']]))
      .toBe('export A=n1 # note\n  B=n2 # quoted note\nC=n3\n');
  });

  it('keeps an inline comment after an empty value', () => {
    expect(upsertEnvText('C= # note\nD=  # another\n', {}, [['C', 'z'], ['D', 'y']])).toBe('C=z # note\nD=y # another\n');
  });

  it('does not treat # inside a quoted value as a comment', () => {
    expect(upsertEnvText('A="a # b"\n', {}, [['A', 'z']])).toBe('A=z\n');
  });

  it('replaces a multi-line quoted value as one definition', () => {
    const before = '# pem\nKEY="-----BEGIN-----\nabc\n-----END-----"\nAFTER=1\n';
    expect(upsertEnvText(before, {}, [['KEY', 'enc'], ['AFTER', '1']])).toBe('# pem\nKEY=enc\nAFTER=1\n');
  });

  it('preserves CRLF line endings', () => {
    const before = '# c\r\nA=1\r\n\r\nB=2\r\n';
    expect(upsertEnvText(before, {}, [['A', 'x'], ['B', 'y'], ['C', 'z']])).toBe('# c\r\nA=x\r\n\r\nB=y\r\nC=z\r\n');
  });

  it('updates header lines in place and adds missing ones at the top', () => {
    expect(upsertEnvText('# capy:branch=old\n# mine\nA=1\n', { branch: 'new' }, [['A', '1']]))
      .toBe('# capy:branch=new\n# mine\nA=1\n');
    expect(upsertEnvText('# mine\nA=1\n', { org_id: 'o', project_id: 'p' }, [['A', '1']]))
      .toBe('# capy:org_id=o\n# capy:project_id=p\n\n# mine\nA=1\n');
  });

  it('leaves header lines alone when the caller does not provide them', () => {
    const before = '# capy:org_id=o\n# capy:branch=main\n\nA=1\n';
    expect(upsertEnvText(before, {}, [['A', '2']])).toBe('# capy:org_id=o\n# capy:branch=main\n\nA=2\n');
  });

  it('adds a line break before appending when the file has no trailing newline', () => {
    expect(upsertEnvText('# c\nA=1', {}, [['A', '1'], ['B', '2']])).toBe('# c\nA=1\nB=2\n');
    expect(upsertEnvText('# c\nA=1', {}, [['A', '9']])).toBe('# c\nA=9');
  });
});

describe('FileManager.writeEncryptedEnvFile keeps the layout', () => {
  const withDir = (run: (ctx: { envPath: string; fm: FileManager }) => void) => (): void => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-env-layout-'));
    try {
      run({ envPath: join(dir, '.env'), fm: new FileManager(dir) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('encrypts values in place and round-trips them', withDir(({ envPath, fm }) => {
    writeFileSync(envPath, '# --- Infra ---\nDB_URL=postgres://x # primary\n\n# --- Keys ---\nAPI=abc\n');
    fm.writeEncryptedEnvFile({ DB_URL: 'postgres://x', API: 'abc' }, KEY, envPath, null, 'main');
    const text = readFileSync(envPath, 'utf-8');
    const lines = text.split('\n');
    expect(lines[0]).toBe('# capy:branch=main');
    expect(lines).toContain('# --- Infra ---');
    expect(lines).toContain('# --- Keys ---');
    expect(lines.find((l) => l.startsWith('DB_URL='))).toMatch(/^DB_URL=capy:\S+ # primary$/);
    expect(lines.indexOf('# --- Infra ---')).toBeLessThan(lines.findIndex((l) => l.startsWith('DB_URL=')));
    expect(lines.findIndex((l) => l.startsWith('DB_URL='))).toBeLessThan(lines.indexOf('# --- Keys ---'));
    expect(fm.readEncryptedEnvFile(KEY, envPath)).toEqual({ DB_URL: 'postgres://x', API: 'abc' });
  }));

  it('a second write leaves the layout identical', withDir(({ envPath, fm }) => {
    writeFileSync(envPath, '# notes\nA=1\n\n# --- B ---\nB=2\n');
    fm.writeEncryptedEnvFile({ A: '1', B: '2' }, KEY, envPath, null, 'main');
    const first = readFileSync(envPath, 'utf-8');
    fm.writeEncryptedEnvFile(fm.readEncryptedEnvFile(KEY, envPath), KEY, envPath, null, 'main');
    const decryptedAgain = fm.readEncryptedEnvFile(KEY, envPath);
    expect(decryptedAgain).toEqual({ A: '1', B: '2' });
    // Plaintext re-encrypts with a fresh IV, so compare with values masked.
    const mask = (t: string) => t.replace(/=capy:\S+/g, '=<enc>');
    expect(mask(readFileSync(envPath, 'utf-8'))).toBe(mask(first));
  }));

  it('parsed values never include comment text (what gets pushed)', withDir(({ envPath, fm }) => {
    writeFileSync(envPath, '# secret-looking comment\nA=1 # inline\n');
    fm.writeEncryptedEnvFile({ A: '1' }, KEY, envPath, null, 'main');
    const values = fm.readEncryptedEnvFile(KEY, envPath);
    expect(values).toEqual({ A: '1' });
    expect(JSON.stringify(values)).not.toContain('comment');
    expect(JSON.stringify(values)).not.toContain('inline');
  }));
});
