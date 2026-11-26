import { version } from '../package.json';
import { id } from './build-info.json';

export const cliVersion = id ? `${version}+${id}` : version;

/** The package version alone, e.g. `0.9.18`. */
export const cliReleaseVersion: string = version;

/** A test or dev build's id (`20261126175046657.04f69f67`), or null for a release build. */
export const cliBuildId: string | null = id || null;
