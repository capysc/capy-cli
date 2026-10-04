/**
 * Renders the `capy help --json` document (see `./cliHelpDoc.ts`) into the
 * generated `docs/cli-reference.md`. Pure (doc in, markdown string out) so
 * `scripts/gen-cli-reference.ts` and the staleness test both call the exact
 * same renderer — there is nowhere for the two to drift apart.
 */
import type { CliCommandDoc, CliHelpDoc, CliModeDoc, CliOptionDoc } from './cliHelpDoc';

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

function renderMode(mode: CliModeDoc): string[] {
  // COPY-FLAG: minimal and neutral wording.
  return [
    `Mode: \`${mode.invocation}\``,
    '',
    mode.description,
    '',
    `- Flags: ${mode.flags.map((f) => `\`${f}\``).join(', ')}`,
    `- Always prints JSON: ${mode.alwaysJson ? 'yes' : 'no'}`,
    `- Dry run: ${mode.supportsDryRun ? 'yes' : 'no'}`,
    ...(mode.planSchema === undefined ? [] : [`- Plan schema: \`schemas.${mode.planSchema}\` in \`capy help --json\``]),
    '',
  ];
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
    ...(cmd.supportsDryRun === true ? ['Dry run: yes (`--dry-run`)', ''] : []), // COPY-FLAG
    ...(cmd.modes ?? []).flatMap((mode) => renderMode(mode)),
    ...cmd.subcommands.map((sub) => renderCommand(sub, depth + 1)),
  ];
  return lines.join('\n');
}

/** The schemas section; a doc with no schemas (an older one) has none. */
function renderSchemas(doc: CliHelpDoc): string[] {
  const entries = Object.entries(doc.schemas ?? {});
  return entries.length === 0
    ? []
    : [
        '## Schemas',
        '',
        'JSON Schemas of the files commands read, as published under `schemas` in `capy help --json`.', // COPY-FLAG
        '',
        ...entries.flatMap(([name, schema]) => [`### \`${name}\``, '', '```json', JSON.stringify(schema, null, 2), '```', '']),
      ];
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
    ...doc.commands.map((cmd) => renderCommand(cmd, 0)),
    ...renderSchemas(doc),
    '## Error codes',
    '',
    'Every refusal carries a stable `code` — branch on it, never on message text.',
    '',
    ...doc.errorCodes.map((code) => `- \`${code}\``),
    '',
    '## Conventions',
    '',
    `- **JSON**: ${doc.conventions.json}`,
    `- **Codes**: ${doc.conventions.codes}`,
    '',
  ];
  return lines.join('\n');
}
