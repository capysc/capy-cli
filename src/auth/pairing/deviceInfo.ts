/**
 * What `capy pair` says about the machine asking to be paired (CAP-892 and
 * CAP-905, spec section 3i). Keep shows it on its "Unlock Device" screen,
 * badged as reported by the device, so the person can tell the request is
 * theirs, and whether an AI agent or a cloud session asked. It is display
 * only: unauthenticated, never branched on by the service or Keep, and never
 * a secret. Only names leave the machine: never a username, repo, session id
 * or token from the environment. The service caps each field's length.
 */
import { existsSync } from 'node:fs';
import { arch, hostname, platform } from 'node:os';
import { cliVersion } from '../../cliVersion';

export interface PairingDeviceInfo {
  /** The machine's hostname. */
  readonly name?: string;
  /** Operating system and architecture, e.g. `macOS (arm64)`. */
  readonly system: string;
  /** e.g. `Capy CLI 0.9.18`. */
  readonly client: string;
  /** e.g. `Claude Code 2.1.332 (AI agent)`, `A person`, `A program (not interactive)`. */
  readonly requested_by: string;
  /** e.g. `Claude Code cloud session`, `GitHub Actions`, `Local machine`. */
  readonly environment: string;
}

/** What the detection reads, so tests can pass their own. */
export interface DetectionInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly interactive: boolean;
  readonly inContainer: boolean;
}

/** Cut by code point, so no surrogate pair is split. */
const cap = (value: string): string => Array.from(value).slice(0, 64).join('');

const PLATFORM_NAMES: Readonly<Record<string, string>> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows', freebsd: 'FreeBSD' };

/** Names for the `AI_AGENT` slugs agents set; any other slug is title-cased. */
const AGENT_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code', cursor: 'Cursor', 'cursor-agent': 'Cursor', codex: 'Codex', 'gemini-cli': 'Gemini CLI',
  copilot: 'GitHub Copilot', 'github-copilot': 'GitHub Copilot', amp: 'Amp', goose: 'Goose', aider: 'Aider', opencode: 'OpenCode',
};

const set = (value: string | undefined): boolean => Boolean(value && value !== '0' && value.toLowerCase() !== 'false');

/** `claude-code_2-1-332_agent` → `Claude Code 2.1.332`. Only letters, digits and separators survive. */
function agentFromConvention(raw: string): string | null {
  const [slug = '', version = ''] = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '').split('_');
  if (!slug) return null;
  const name = AGENT_NAMES[slug] ?? slug.split('-').filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ');
  const shown = /^\d+([.-]\d+)*$/.test(version) ? ` ${version.replace(/-/g, '.')}` : '';
  return name ? `${name}${shown}` : null;
}

/** Which AI agent started this CLI, from the variables agents set in their shells. */
export function detectAgent(env: DetectionInput['env']): string | null {
  if (env.AI_AGENT) {
    const named = agentFromConvention(env.AI_AGENT);
    if (named) return named;
  }
  if (set(env.CLAUDECODE)) return 'Claude Code';
  if (set(env.CURSOR_AGENT)) return 'Cursor';
  if (env.CODEX_SANDBOX || env.CODEX_MANAGED_BY_NPM) return 'Codex';
  if (set(env.GEMINI_CLI)) return 'Gemini CLI';
  return null;
}

export function requestedBy(input: DetectionInput): string {
  const agent = detectAgent(input.env);
  if (agent) return `${agent} (AI agent)`;
  return input.interactive ? 'A person' : 'A program (not interactive)';
}

/** Where this CLI runs: a cloud session, CI, a container, over SSH, or the local machine. */
export function runsIn({ env, inContainer }: DetectionInput): string {
  if (set(env.CLAUDE_CODE_REMOTE)) return 'Claude Code cloud session';
  if (set(env.CODESPACES)) return 'GitHub Codespaces';
  if (env.GITPOD_WORKSPACE_ID) return 'Gitpod';
  if (env.REPL_ID) return 'Replit';
  if (set(env.CLOUD_SHELL)) return 'Google Cloud Shell';
  if (env.AWS_EXECUTION_ENV === 'CloudShell') return 'AWS CloudShell';
  if (set(env.GITHUB_ACTIONS)) return 'GitHub Actions';
  if (set(env.GITLAB_CI)) return 'GitLab CI';
  if (set(env.CI)) return 'CI';
  if (env.WSL_DISTRO_NAME) return 'WSL';
  if (inContainer) return 'A container';
  if (env.SSH_CONNECTION || env.SSH_TTY) return 'Over SSH';
  return 'Local machine';
}

function currentInput(): DetectionInput {
  let inContainer = false;
  try {
    inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  } catch {
    inContainer = false;
  }
  return { env: process.env, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), inContainer };
}

export function pairingDeviceInfo(input: DetectionInput = currentInput()): PairingDeviceInfo {
  const name = (() => {
    try {
      return cap(hostname().trim());
    } catch {
      return '';
    }
  })();
  const os = platform();
  return {
    ...(name ? { name } : {}),
    system: `${PLATFORM_NAMES[os] ?? os} (${arch()})`,
    client: cap(`Capy CLI ${cliVersion}`),
    requested_by: cap(requestedBy(input)),
    environment: cap(runsIn(input)),
  };
}
