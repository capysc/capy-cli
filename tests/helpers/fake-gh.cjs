#!/usr/bin/env node
// A fake `gh` for tests: answers the handful of `gh api` calls the CLI makes from
// canned fixtures and logs every call (arguments and stdin) to a file, so a test
// can see exactly what would have gone to GitHub. It never touches the network.
//
//   FAKE_GH_DIR   directory holding gh-config.json (the fixtures) and gh-log.jsonl (the log)
//
// gh-config.json: { "repos": { "owner/name": { "id": 42, "default_branch": "main", "files": { "path": "text" } } } }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
const stdin = (() => {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
})();
fs.appendFileSync(path.join(dir, 'gh-log.jsonl'), `${JSON.stringify({ args, stdin })}\n`);

const config = JSON.parse(fs.readFileSync(path.join(dir, 'gh-config.json'), 'utf8'));
const answer = (status, body) => {
  process.stdout.write(`HTTP/2.0 ${status} X\r\n\r\n${JSON.stringify(body)}`);
  process.exit(0);
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

if (args.includes('--jq')) {
  const endpoint = args.find((a) => a.startsWith('repos/')) || '';
  const repo = config.repos[endpoint.slice('repos/'.length).toLowerCase()];
  if (!repo) process.exit(1);
  process.stdout.write(`${repo.id}\n`);
  process.exit(0);
}

const method = args[args.indexOf('--method') + 1] || 'GET';
const endpoint = args[args.length - 1].split('?')[0];

// The batched default-branch read: one GraphQL query, an aliased repository(...) per repo.
if (method === 'POST' && endpoint === 'graphql') {
  const { variables } = JSON.parse(stdin);
  const count = Object.keys(variables).length / 2;
  const data = Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const found = config.repos[`${variables['o' + i]}/${variables['n' + i]}`.toLowerCase()];
      return ['r' + i, found ? { defaultBranchRef: { name: found.default_branch } } : null];
    }),
  );
  answer(200, { data });
}
const m = /^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(endpoint);
if (!m) answer(404, {});
const key = `${m[1]}/${m[2]}`.toLowerCase();
const repo = config.repos[key];
if (!repo) answer(404, {});
const rest = m[3] || '';
const body = stdin ? JSON.parse(stdin) : {};

if (method === 'GET') {
  if (rest === '') answer(200, { default_branch: repo.default_branch });
  if (rest.startsWith('git/ref/heads/')) answer(200, { object: { sha: `head-${m[2]}` } });
  if (rest.startsWith('git/commits/')) answer(200, { tree: { sha: `tree-${m[2]}` } });
  if (rest.startsWith('contents/')) {
    const file = repo.files[decodeURIComponent(rest.slice('contents/'.length))];
    if (file === undefined) answer(404, {});
    answer(200, { encoding: 'base64', content: Buffer.from(file).toString('base64') });
  }
}
if (method === 'POST') {
  if (rest === 'git/blobs') answer(201, { sha: `blob-${sha(body.content)}` });
  if (rest === 'git/trees') answer(201, { sha: `tree-new-${m[2]}` });
  if (rest === 'git/commits') answer(201, { sha: `commit-${m[2]}` });
  if (rest === 'git/refs') answer(201, { ref: body.ref });
  if (rest === 'pulls') answer(201, { html_url: `https://github.com/${m[1]}/${m[2]}/pull/7` });
}
answer(404, {});
