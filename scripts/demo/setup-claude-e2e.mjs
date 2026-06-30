/**
 * Scaffold a ready-to-use E2E test project for verifying the capy MCP in Claude
 * Code: a seeded local-only project with a planted sync conflict + a project-local
 * `.mcp.json` that registers the capy MCP pointed at the local --web-capable capy
 * build and an isolated HOME. Open the project in Claude Code, say "sync my
 * secrets", and the browser conflict resolver opens for you to click through.
 *
 *   CAPY_MCP_BIN=/path/to/capy-mcp/bin/capy-mcp \
 *     node scripts/demo/setup-claude-e2e.mjs [rootDir]
 *
 * CAPY_MCP_BIN (required) points at your capy-mcp server entry. The fixture root
 * defaults to a temp dir (override with the [rootDir] arg or CAPY_E2E_ROOT).
 *
 * Re-run any time to refresh (re-seeds the conflict + the unlocked local session).
 * Touches only the scaffold dir — never your real ~/.capy.
 */
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CAPY_CLI = new URL('../..', import.meta.url).pathname;
const CAPY_BIN = process.env.CAPY_BIN || join(CAPY_CLI, 'bin', 'capy'); // local --web-capable build
// Path to the capy-mcp server entry (its bin/capy-mcp). Required — set it to wherever
// your capy-mcp checkout lives.
const MCP_BIN = process.env.CAPY_MCP_BIN;

// Where to build the throwaway fixture + test project (override via arg or env).
const ROOT = process.argv[2] || process.env.CAPY_E2E_ROOT || join(tmpdir(), 'capy-claude-e2e');
const HOME = join(ROOT, 'capy-demo-home'); // name matches seed.ts's throwaway-dir safety rail
const PROJECT = join(ROOT, 'project');

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, { cwd: CAPY_CLI, env: { ...process.env, ...env }, stdio: 'inherit' });
    cp.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

async function main() {
  if (!MCP_BIN) {
    console.error('Set CAPY_MCP_BIN to your capy-mcp server entry (its bin/capy-mcp). Example:');
    console.error('  CAPY_MCP_BIN=/path/to/capy-mcp/bin/capy-mcp node scripts/demo/setup-claude-e2e.mjs');
    process.exit(2);
  }

  // 1. Seed the deterministic offline conflict into an isolated HOME + project dir.
  await run('bun', ['scripts/demo/seed.ts'], { HOME, CAPY_DEMO_PROJECT: PROJECT });

  // 2. Drop a project-local .mcp.json so Claude Code launches the capy MCP with the
  //    local capy binary and the fixture HOME (capy runs in this project's cwd).
  const mcp = {
    mcpServers: {
      capy: { command: 'node', args: [MCP_BIN], env: { CAPY_BIN, HOME } },
    },
  };
  writeFileSync(join(PROJECT, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');

  console.log('\n✓ E2E test project ready.\n');
  console.log('Verify in Claude Code:');
  console.log(`  1. cd ${PROJECT}`);
  console.log('  2. claude            (approve the "capy" MCP server when prompted)');
  console.log('  3. say: "sync my secrets"');
  console.log('     → the agent calls capy_sync → capy --web → the conflict resolver opens');
  console.log('       in YOUR browser. Pick values, Apply, and it commits to this fixture.\n');
  console.log('Re-run this script to refresh if the local session has expired.\n');
}

main().catch((e) => {
  console.error('\n✗ setup failed:', e.message);
  process.exit(1);
});
