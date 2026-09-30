/**
 * Renders the `capy help --json` document (see `./cliHelpDoc.ts`) into the
 * generated `docs/cli-reference.md`. Pure (doc in, markdown string out) so
 * `scripts/gen-cli-reference.ts` and the staleness test both call the exact
 * same renderer — there is nowhere for the two to drift apart.
 */
import type { CliCommandDoc, CliHelpDoc, CliOptionDoc } from './cliHelpDoc';

function usageLine(cmd: CliCommandDoc): string {
  const args = cmd.arguments
    .map((a) => {
      const name = a.variadic ? `${a.name}...` : a.name;
      return a.required ? `<${name}>` : `[${name}]`;
    })
    .join(' ');
  const optsHint = cmd.options.length > 0 ? ' [options]' : '';
  return `capy ${cmd.path}${args ? ` ${args}` : ''}${optsHint}`;
}

function optionsTable(options: CliOptionDoc[]): string {
  if (options.length === 0) return '_No options._';
  const rows = options.map((o) => {
    const flags = `\`${o.flags}\``;
    const defaultCell = o.default !== undefined ? `\`${JSON.stringify(o.default)}\`` : '';
    return `| ${flags} | ${o.description} | ${defaultCell} |`;
  });
  return ['| Option | Description | Default |', '|---|---|---|', ...rows].join('\n');
}

function renderCommand(cmd: CliCommandDoc, depth: number): string {
  const heading = '#'.repeat(Math.min(depth + 2, 6));
  const lines = [
    `${heading} \`capy ${cmd.path}\``,
    '',
    cmd.description || '_No description._',
    '',
    '```',
    usageLine(cmd),
    '```',
    '',
    optionsTable(cmd.options),
    '',
    `JSON support: ${cmd.supportsJson ? 'yes (`--json`)' : 'no'}`,
    '',
  ];
  for (const sub of cmd.subcommands) {
    lines.push(renderCommand(sub, depth + 1));
  }
  return lines.join('\n');
}

/** Pure: the same doc always renders the same markdown, byte for byte. */
export function renderCliReferenceMarkdown(doc: CliHelpDoc): string {
  const lines = [
    '<!-- GENERATED FILE — do not hand-edit. Run `bun run docs:cli` to regenerate. -->',
    '',
    `# ${doc.name} CLI reference`,
    '',
    `Version \`${doc.version}\`. Generated from \`capy help --json\`.`,
    '',
    '## Commands',
    '',
  ];
  for (const cmd of doc.commands) {
    lines.push(renderCommand(cmd, 0));
  }
  lines.push('## Error codes', '');
  lines.push('Every refusal carries a stable `code` — branch on it, never on message text.', '');
  lines.push(...doc.errorCodes.map((code) => `- \`${code}\``));
  lines.push('');
  lines.push('## Conventions', '');
  lines.push(`- **JSON**: ${doc.conventions.json}`);
  lines.push(`- **Codes**: ${doc.conventions.codes}`);
  lines.push('');
  return lines.join('\n');
}
