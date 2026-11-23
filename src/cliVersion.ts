import { version } from '../package.json';
import { id } from './build-info.json';

export const cliVersion = id ? `${version}+${id}` : version;
