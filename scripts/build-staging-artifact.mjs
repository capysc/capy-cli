import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = (binary, args, cwd = source) => {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const files = async root => (await Promise.all((await readdir(root, {withFileTypes:true})).map(async entry =>
  entry.isDirectory() ? files(join(root,entry.name)) : [join(root,entry.name)]))).flat();

const revision = command('git', ['rev-parse', 'HEAD']);
if (command('git', ['status', '--porcelain'])) throw new Error('Commit the complete source before building a pinned artifact.');
command(process.execPath, ['node_modules/typescript/bin/tsc']);
const output = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(),'capy-staging-artifact-'));
if (process.argv[2]) await mkdir(output);
const root = join(output,'capy-staging');
await mkdir(join(root,'bin'), {recursive:true});
await cp(join(source,'dist'),join(root,'dist'),{recursive:true});
await cp(await realpath(join(source,'node_modules')),join(root,'node_modules'),{recursive:true,dereference:true});
await cp(join(source,'bin/capy-staging'),join(root,'bin/capy-staging'));
await cp(join(source,'THIRD-PARTY-NOTICES.md'),join(root,'THIRD-PARTY-NOTICES.md'));
await cp(join(source,'LICENSE'),join(root,'LICENSE'));
await cp(join(source,'scripts/validation'),join(root,'scripts/validation'),{recursive:true});
const original = JSON.parse(await readFile(join(source,'package.json'),'utf8'));
const {scripts,bin,files:publishedFiles,...metadata} = original;
await writeFile(join(root,'package.json'),JSON.stringify({...metadata,private:true,bin:{'capy-staging':'bin/capy-staging'}},null,2)+'\n');
const manifest = {
  component:'capy-staging',source_revision:revision,version:original.version,platform:process.platform,architecture:process.arch,
  prerequisites:{node:'>=22',synthetic_fixture:'Bun required only for the synthetic WorkOS provider preload'},
  commands:{version:'node bin/capy-staging --version',help:'node bin/capy-staging --help',onboard:'node bin/capy-staging onboard --json'},
  files:Object.fromEntries(await Promise.all((await files(root)).map(async path => [relative(root,path),await sha256(path)]))),
};
await writeFile(join(root,'validation-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const archive = join(output,'capy-staging.tar.gz');
command('tar',['-czf',archive,'-C',output,'capy-staging']);
await writeFile(join(output,'checksums.json'),JSON.stringify({source_revision:revision,archive:'capy-staging.tar.gz',sha256:await sha256(archive)},null,2)+'\n');
console.log(JSON.stringify({directory:output,archive,source_revision:revision,sha256:await sha256(archive)}));
