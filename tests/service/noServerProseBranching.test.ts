/**
 * No decision in this CLI is made by reading the service's prose.
 *
 * Cardinal rule, and it earned its place: a human-readable message is not a
 * contract. It gets reworded, localised, wrapped, or lint-fixed upstream, and
 * every branch keyed on it breaks with NO compile-time and NO runtime signal.
 * The three that existed here would each have failed silently and in a way
 * that looked like a different bug — a user sent to fix a well-formed file, a
 * first run reported as a deleted project, a person told to run the command
 * that had just failed.
 *
 * `classifyResponse` is the one place a message may still be read, and only
 * for 404s from a service too old to send a code. It is quarantined there so
 * there is one bridge to delete rather than three to find.
 *
 * This is a source-level assertion because the property is about the source:
 * "nowhere reads the sentence" cannot be observed from inside a process that
 * is not currently failing.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '../../src');

/** The quarantine. See the module comment. */
const BRIDGE = 'service/serviceClient.ts';

/**
 * A branch taken on the TEXT of an error, message, reason or response body.
 *
 * Deliberately narrow: `value.startsWith('capy:')` is parsing a ciphertext
 * marker in our own file format, which is a contract we own and publish. What
 * this looks for is a decision keyed on something written for a human.
 */
const PROSE_BRANCH =
  /\b(?:err|error|e|msg|message|serverMsg|serverMessage|reason|detail|stderr|body|data)(?:(?:\?\.|\.)(?:message|error|reason|detail))?(?:\?\.|\.)(?:includes|startsWith|endsWith|match|search)\s*\(\s*['"`]/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * `generated.ts` is three megabytes of compiled screen HTML, and the Svelte
 * runtime inside it contains `Array.prototype.includes`. Nobody wrote a branch
 * there and nobody can fix one.
 */
const isGenerated = (src: string): boolean => src.startsWith('// AUTO-GENERATED');

/**
 * A comment is allowed to quote the pattern — this file does it, and so does
 * the payload contract, which documents the hazard for whoever reads it next.
 * A guard that cannot tell code from a note about code makes describing the
 * problem impossible.
 */
const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

describe('nothing branches on what the service said', () => {
  test('only the quarantined classifier reads an error message', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel === BRIDGE) continue;
      const src = readFileSync(file, 'utf8');
      if (isGenerated(src)) continue;
      src.split('\n').forEach((line, i) => {
        if (!isComment(line) && PROSE_BRANCH.test(line)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `A decision is being made by matching human-readable text. That text is not a ` +
        `contract — it gets reworded upstream and this branch will start taking the ` +
        `wrong path with nothing failing. Branch on a typed code instead: read ` +
        `\`err.code\`, \`instanceof\`, or \`details.status\`. If the code you need does ` +
        `not exist, mint it where the condition is first known (see ` +
        `\`classifyResponse\` in ${BRIDGE}) rather than sniffing the sentence here.\n\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  test('the detector recognises the three branches this replaced', () => {
    // A guard whose detector is wrong reports clean, which is worse than no
    // guard. These are the real lines that used to be in the tree.
    for (const line of [
      `if (status === 404 && serverMsg?.includes('Project not found')) {`,
      `if (msg.includes('not found') && !msg.includes('No secrets')) {`,
      `if (reason.includes('do not have access')) return 'access_denied';`,
      `if (err.message?.startsWith('Unsupported deploy.json')) throw err;`,
      `if (error.message.match('denied')) return true;`,
    ]) {
      expect(PROSE_BRANCH.test(line), line).toBe(true);
    }
  });

  test('the detector leaves our own formats and typed checks alone', () => {
    for (const line of [
      `if (value.startsWith('capy:')) {`, // our ciphertext marker, a published format
      `if (!line.startsWith('# capy:')) break;`, // our .env header
      `if (err.code === ERROR_CODES.PERMISSION_DENIED) return 'access_denied';`,
      `if (err instanceof UnsupportedDeployConfigVersion) throw err;`,
      `if (error.details?.status === 404) {`,
      `console.log(\`Could not reach remote: \${reason}\`);`, // display, not a branch
    ]) {
      expect(PROSE_BRANCH.test(line), line).toBe(false);
    }
  });
});
