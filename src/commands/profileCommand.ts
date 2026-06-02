/**
 * Profile management commands:
 *   - capy use <name>          — set the active profile
 *   - capy profile list        — show all configured profiles
 *   - capy profile show [name] — show details of one profile (active by default)
 *   - capy profile remove <name> — delete a profile
 *
 * `capy byoc` (see byocCommand.ts) is the typical way profiles are created.
 * These commands are for managing what byoc produced.
 */

import {
  listProfiles,
  readProfileConfig,
  removeProfile,
  setActiveProfile,
} from '../config/profileConfig';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;

export async function useCommand(name: string): Promise<number> {
  try {
    setActiveProfile(name);
  } catch (err: any) {
    console.error(err.message);
    return 1;
  }
  console.log(`${GREEN('✓')} Switched to profile ${B(name)}`);
  return 0;
}

export async function profileListCommand(): Promise<number> {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log('');
    console.log(`  No profiles configured.`);
    console.log(`  Run ${B('capy byoc')} to add a self-hosted instance.`);
    console.log('');
    return 0;
  }

  console.log('');
  for (const { name, profile, active } of profiles) {
    const marker = active ? GREEN('●') : ' ';
    const label = profile.displayName ? ` ${DIM(profile.displayName)}` : '';
    console.log(`  ${marker} ${B(name)}${label}`);
    console.log(`     ${DIM(profile.url)}`);
    if (profile.caBundle) {
      console.log(`     ${DIM('CA: ' + profile.caBundle)}`);
    }
  }
  console.log('');
  return 0;
}

export async function profileShowCommand(name?: string): Promise<number> {
  const config = readProfileConfig();
  if (!config) {
    console.log('No profiles configured.');
    return 1;
  }
  const target = name || config.default;
  const profile = config.profiles[target];
  if (!profile) {
    console.error(`Profile "${target}" does not exist.`);
    return 1;
  }
  console.log('');
  console.log(`  ${B(target)}${target === config.default ? ` ${DIM('(active)')}` : ''}`);
  console.log(`  url:        ${profile.url}`);
  if (profile.displayName) console.log(`  displayName: ${profile.displayName}`);
  if (profile.caBundle) console.log(`  caBundle:    ${profile.caBundle}`);
  console.log('');
  return 0;
}

export async function profileRemoveCommand(name: string): Promise<number> {
  try {
    removeProfile(name);
  } catch (err: any) {
    console.error(err.message);
    return 1;
  }
  console.log(`${GREEN('✓')} Removed profile ${B(name)}`);
  return 0;
}
