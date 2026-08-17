// Deterministic, idempotent computation for the "agent-docs" onboarding edit:
// a short, marker-delimited section telling a coding agent HOW to run
// commands that need this project's secrets, written into whichever agent
// instruction file already exists. Same shape as computeRunWrapEdits
// (edits.ts) — reads real files, writes nothing itself, returns Edit[] for
// the SAME plan+preview+apply flow (plan.ts / apply.ts), so this is never a
// silent write.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Edit } from './edits';

const MARKER_START = '<!-- capy:agent-instructions:start -->';
const MARKER_END = '<!-- capy:agent-instructions:end -->';

/**
 * Priority order: every one of these that ALREADY EXISTS gets its own edit
 * (a repo running more than one agent — say CLAUDE.md AND .cursorrules —
 * gets both updated, each with the content appropriate to what can read it).
 * AGENTS.md is the only file ever CREATED — when NONE of these exist, a repo
 * gets exactly one, rather than a guess at which agent the user runs.
 */
const CANDIDATES = ['CLAUDE.md', 'AGENTS.md', '.cursorrules', join('.github', 'copilot-instructions.md')];

/**
 * Vince's decision: lead with the MCP tool for the targets an agent reading
 * them is likely to have registered — Claude Code's own CLAUDE.md, and the
 * cross-agent AGENTS.md convention. `.cursorrules` and Copilot's
 * instructions file are read by agents that cannot call an MCP tool at all,
 * so those get the shell form as the PRIMARY instruction, not a fallback
 * clause buried in prose written for someone else.
 */
const MCP_AWARE = new Set(['CLAUDE.md', 'AGENTS.md']);

function section(mcpAware: boolean): string {
  const howToRun = mcpAware
    ? "run it with the `capy_run` MCP tool rather than shelling it out directly — it injects the secrets, reports " +
      'failures properly, and can relay a sign-in/ceremony link if one is needed. If the capy MCP tools are not ' +
      'available, fall back to `capy run -- <command>` in the terminal.'
    : 'run it as `capy run -- <command>` rather than running it directly — a raw shell-out has no secrets injected ' +
      'and fails opaquely.';

  const body = [
    "This project's secrets are managed by Capy. Package scripts (npm/yarn/pnpm) are already wrapped to run with " +
      'secrets injected — nothing to do for those.',
    '',
    'For any OTHER command that needs environment/secrets (a one-off script, a test run, anything not already a ' +
      `package script), ${howToRun}`,
    '',
    'Never create a `.env` file or paste secret values into code, chat, or config. If a value is missing, run ' +
      '`capy sync` rather than inventing one.',
  ];

  return [MARKER_START, '## Secrets (Capy)', '', ...body, MARKER_END].join('\n');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MARKER_BLOCK_RE = new RegExp(`${escapeRe(MARKER_START)}[\\s\\S]*?${escapeRe(MARKER_END)}`);

/** Insert or, if already present, replace the marker-delimited section — idempotent, in place, never duplicated. */
function withSection(before: string, newSection: string): string {
  if (MARKER_BLOCK_RE.test(before)) return before.replace(MARKER_BLOCK_RE, newSection);
  if (before.length === 0) return newSection + '\n';
  const sep = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  return before + sep + newSection + '\n';
}

/** Compute the agent-instructions edit(s) for an app directory. Idempotent; writes nothing. */
export function computeAgentDocsEdits(targetDir: string): Edit[] {
  const existing = CANDIDATES.filter((rel) => existsSync(join(targetDir, rel)));

  if (existing.length === 0) {
    const rel = 'AGENTS.md';
    return [
      {
        path: rel,
        action: 'create',
        kind: 'agent-docs',
        before: null,
        after: section(true) + '\n',
        summary: 'create AGENTS.md telling agents to run ad-hoc commands via capy_run / `capy run --`',
        noop: false,
      },
    ];
  }

  return existing.map((rel) => {
    const abs = join(targetDir, rel);
    const before = readFileSync(abs, 'utf8');
    const hadMarker = MARKER_BLOCK_RE.test(before);
    const after = withSection(before, section(MCP_AWARE.has(rel)));
    const noop = after === before;
    return {
      path: rel,
      action: 'modify',
      kind: 'agent-docs',
      before,
      after,
      summary: noop
        ? `${rel} already has the capy convention section`
        : hadMarker
          ? `update the capy convention section in ${rel}`
          : `append the capy convention section to ${rel}`,
      noop,
    };
  });
}
