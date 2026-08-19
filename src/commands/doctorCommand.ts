import { join } from 'path';
import { version as CLI_VERSION } from '../../package.json';
import { getGlobalCapyDir } from '../config/globalConfig';
import { resolveActiveUrl, getActiveProfile, DEFAULT_CLOUD_URL } from '../config/profileConfig';
import { keepOrigin } from '../ui/screens/keepScreens';
import { FileSessionStorageBackend } from '../auth/session/fileBackend';
import { ProjectManager } from '../core/projectManager';

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export interface DoctorReport {
  cli: {
    bin: string;
    binPath: string | null;
    version: string;
    node: string;
    platform: string;
    arch: string;
  };
  stateDir: string;
  origins: {
    api: string;
    keep: string;
    apiFromEnv: boolean;
    keepFromEnv: boolean;
  };
  profile: { name: string; localOnly: boolean } | null;
  session: {
    present: boolean;
    userId: string | null;
    dir: string;
    error: string | null;
  };
  project: {
    cwd: string;
    initialized: boolean;
    hasKeepFile: boolean;
    organizationId: string | null;
    projectId: string | null;
    projectName: string | null;
    branch: string | null;
  };
}

/** resolveActiveUrl() throws on an unresolvable CAPY_PROFILE; doctor must not. */
function safeResolveActiveUrl(): string {
  try {
    return resolveActiveUrl();
  } catch {
    if (process.env.CAPY_API_URL) return process.env.CAPY_API_URL;
    return DEFAULT_CLOUD_URL;
  }
}

/**
 * Pure, read-only collector for `capy doctor`'s facts. No network calls, no
 * prompts, never spawns a process — every field comes from local filesystem
 * reads and env/argv introspection. Exported separately from DoctorCommand
 * so tests can assert on the report shape without capturing console output.
 */
export async function collectDoctorReport(): Promise<DoctorReport> {
  const stateDir = getGlobalCapyDir();

  // getActiveProfile() throws when CAPY_PROFILE names a profile that isn't
  // configured — a fact worth reporting, not a reason for `doctor` to crash.
  let profile: DoctorReport['profile'] = null;
  try {
    const activeProfile = getActiveProfile();
    profile = activeProfile
      ? { name: activeProfile.name, localOnly: activeProfile.profile.localOnly === true }
      : null;
  } catch {
    profile = null;
  }

  const sessionDir = join(stateDir, 'auth', 'sessions');
  let sessionPresent = false;
  let sessionUserId: string | null = null;
  let sessionError: string | null = null;
  try {
    const discovered = new FileSessionStorageBackend().discover();
    if (discovered) {
      sessionPresent = true;
      sessionUserId = discovered.userId;
    }
  } catch (err: any) {
    sessionError = err?.message || String(err);
  }

  let project: DoctorReport['project'] = {
    cwd: process.cwd(),
    initialized: false,
    hasKeepFile: false,
    organizationId: null,
    projectId: null,
    projectName: null,
    branch: null,
  };
  try {
    const state = await new ProjectManager().detectProjectState();
    project = {
      cwd: process.cwd(),
      initialized: state.initialized,
      hasKeepFile: state.hasKeepFile,
      organizationId: state.organizationId ?? null,
      projectId: state.projectId ?? null,
      projectName: state.projectName ?? null,
      branch: state.activeBranch,
    };
  } catch {
    // Local-only, best-effort: leave the uninitialized defaults above.
  }

  return {
    cli: {
      bin: process.env.CAPY_BIN_NAME || 'capy',
      binPath: process.argv[1] ?? null,
      version: CLI_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    stateDir,
    origins: {
      // resolveActiveUrl() can throw the same "unknown CAPY_PROFILE" error as
      // getActiveProfile() above; fall back to the env/config-less default
      // rather than let a bad profile name crash a read-only diagnostic.
      api: safeResolveActiveUrl(),
      keep: keepOrigin(),
      apiFromEnv: !!process.env.CAPY_API_URL,
      keepFromEnv: !!process.env.CAPY_KEEP_ORIGIN,
    },
    profile,
    session: {
      present: sessionPresent,
      userId: sessionUserId,
      dir: sessionDir,
      error: sessionError,
    },
    project,
  };
}

export class DoctorCommand {
  async execute(opts: { json?: boolean } = {}): Promise<void> {
    const report = await collectDoctorReport();

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const rows: [string, string][] = [
      ['CLI', `${report.cli.bin} ${DIM}(${report.cli.node}, ${report.cli.platform}/${report.cli.arch})${RESET}`],
      ['Version', report.cli.version],
      ['State dir', report.stateDir],
      ['API origin', `${report.origins.api}${report.origins.apiFromEnv ? ` ${DIM}(from CAPY_API_URL)${RESET}` : ''}`],
      ['Keep origin', `${report.origins.keep}${report.origins.keepFromEnv ? ` ${DIM}(from CAPY_KEEP_ORIGIN)${RESET}` : ''}`],
      ['Profile', report.profile ? `${report.profile.name}${report.profile.localOnly ? ' (local-only)' : ''}` : `${DIM}none${RESET}`],
      ['Session', report.session.present ? `present ${DIM}(${report.session.userId})${RESET}` : `${DIM}none${RESET}`],
      ['Project', report.project.initialized ? (report.project.projectName || report.project.projectId || '—') : `${DIM}not initialized${RESET}`],
      ['Branch', report.project.branch || '—'],
    ];

    const labelWidth = Math.max(...rows.map(([label]) => label.length));

    console.log('');
    console.log(`  ${GREEN}Capy doctor${RESET}`);
    console.log('  ' + '─'.repeat(labelWidth + 3 + 40));
    for (const [label, value] of rows) {
      console.log(`  ${DIM}${label.padEnd(labelWidth)}${RESET}   ${value}`);
    }
    if (!report.session.present) {
      console.log('');
      console.log(`  ${DIM}Run ${B(report.cli.bin)} in a project to sign in.${RESET}`);
    }
    console.log('');
  }
}
