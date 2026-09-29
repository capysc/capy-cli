/**
 * Upsert values into an existing `.env` text WITHOUT destroying its layout.
 *
 * People group and annotate their `.env` files (`# --- Infra ---` dividers,
 * comments, blank-line groups, a deliberate order). Capy only ever changes
 * what it has to:
 *   - a variable that is still wanted keeps its line (and its position);
 *     only the value is replaced — an `export ` prefix, leading indentation
 *     and a trailing inline `# note` are kept;
 *   - a variable that is no longer wanted loses only its own line(s);
 *   - a new variable is appended at the end, in the order given;
 *   - Capy's own header lines (`# capy:org_id=…`, `# capy:project_id=…`,
 *     `# capy:branch=…`) are updated in place, or added at the top when absent;
 *   - every other line — comments, dividers, blank lines — is returned
 *     byte-identical, with its own line ending.
 *
 * Layout is purely local: nothing here feeds a hash or anything sent to the
 * server (the pushed blob and keep.lock are built from parsed values).
 */

export interface EnvHeader {
  org_id?: string;
  project_id?: string;
  branch?: string;
}

interface RawLine {
  content: string;
  eol: string;
}

interface Definition {
  key: string;
  /** First and last physical line of this definition (a quoted value can span lines). */
  start: number;
  end: number;
  /** Everything before the key on the first line: indentation + optional `export `. */
  prefix: string;
  /** A trailing inline comment on the last line, including its leading space, or ''. */
  inlineComment: string;
}

const HEADER_KEYS = ['org_id', 'project_id', 'branch'] as const;
const DEFINITION = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;

function splitLines(text: string): readonly RawLine[] {
  const parts = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
  return parts
    .filter((p, i) => p.length > 0 || i < parts.length - 1)
    .map((p) => {
      const eol = p.endsWith('\r\n') ? '\r\n' : p.endsWith('\n') || p.endsWith('\r') ? p.slice(-1) : '';
      return { content: p.slice(0, p.length - eol.length), eol };
    })
    .filter((l, i, all) => !(i === all.length - 1 && l.content === '' && l.eol === ''));
}

function dominantEol(lines: readonly RawLine[]): string {
  const crlf = lines.filter((l) => l.eol === '\r\n').length;
  const lf = lines.filter((l) => l.eol === '\n').length;
  return crlf > lf ? '\r\n' : '\n';
}

/** The index of the line that closes a quoted value opened on line `start`, or `start` itself. */
function closingLine(lines: readonly RawLine[], start: number, rest: string): number {
  const quote = rest[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') return start;
  const closesOnFirstLine = rest.slice(1).includes(quote);
  if (closesOnFirstLine) return start;
  const found = lines.findIndex((l, i) => i > start && l.content.includes(quote));
  return found === -1 ? start : found;
}

function inlineCommentOf(valuePart: string): string {
  const trimmed = valuePart.trimEnd();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    const close = trimmed.lastIndexOf(quote);
    if (close <= 0) return '';
    const after = trimmed.slice(close + 1);
    return after.trimStart().startsWith('#') ? after : '';
  }
  const match = trimmed.match(/\s+#.*$/);
  return match ? match[0] : '';
}

function findDefinitions(lines: readonly RawLine[]): readonly Definition[] {
  const walk = (i: number, acc: readonly Definition[]): readonly Definition[] => {
    if (i >= lines.length) return acc;
    const m = lines[i].content.match(DEFINITION);
    if (!m) return walk(i + 1, acc);
    const end = closingLine(lines, i, m[3]);
    const lastValuePart = end === i ? m[3] : lines[end].content;
    return walk(end + 1, [...acc, { key: m[2], start: i, end, prefix: m[1], inlineComment: inlineCommentOf(lastValuePart) }]);
  };
  return walk(0, []);
}

function headerLineKey(content: string): (typeof HEADER_KEYS)[number] | null {
  const m = content.match(/^# capy:(org_id|project_id|branch)=/);
  return m ? (m[1] as (typeof HEADER_KEYS)[number]) : null;
}

/**
 * `entries` is the complete desired set, in order, with each value already
 * rendered as it should appear after `=`.
 */
export function upsertEnvText(existing: string, header: EnvHeader, entries: ReadonlyArray<readonly [string, string]>): string {
  const lines = splitLines(existing);
  const wanted = new Map(entries);
  const headerValues = HEADER_KEYS.flatMap((k) => (header[k] ? [[k, header[k] as string] as const] : []));

  if (lines.length === 0) {
    const headerText = headerValues.map(([k, v]) => `# capy:${k}=${v}`).join('\n');
    const body = entries.map(([k, v]) => `${k}=${v}`).join('\n');
    const joined = headerText ? `${headerText}\n\n${body}` : body;
    return joined + '\n';
  }

  const eol = dominantEol(lines);
  const definitions = findDefinitions(lines);
  const defByStart = new Map(definitions.map((d) => [d.start, d]));
  const coveredByDefinition = new Set(definitions.flatMap((d) => Array.from({ length: d.end - d.start + 1 }, (_, k) => d.start + k)));
  const presentKeys = new Set(definitions.map((d) => d.key));
  const presentHeaderKeys = new Set(lines.map((l) => headerLineKey(l.content)).filter((k): k is (typeof HEADER_KEYS)[number] => k !== null));
  const headerMap = new Map(headerValues);

  const kept = lines.flatMap((line, i): readonly string[] => {
    const hk = headerLineKey(line.content);
    if (hk && headerMap.has(hk)) return [`# capy:${hk}=${headerMap.get(hk)}${line.eol}`];
    const def = defByStart.get(i);
    if (def) {
      if (!wanted.has(def.key)) return [];
      const lastEol = lines[def.end].eol;
      return [`${def.prefix}${def.key}=${wanted.get(def.key)}${def.inlineComment}${lastEol || (i === lines.length - 1 ? '' : eol)}`];
    }
    if (coveredByDefinition.has(i)) return [];
    return [line.content + line.eol];
  });

  const missingHeader = headerValues.filter(([k]) => !presentHeaderKeys.has(k)).map(([k, v]) => `# capy:${k}=${v}${eol}`);
  const newEntries = entries.filter(([k]) => !presentKeys.has(k)).map(([k, v]) => `${k}=${v}${eol}`);
  const body = kept.join('');
  const bodyWithTerminator = body.length > 0 && !/(\r\n|\n|\r)$/.test(body) && newEntries.length > 0 ? body + eol : body;
  const headerBlock = missingHeader.length > 0
    ? missingHeader.join('') + (kept.length === 0 || headerLineKey(kept[0]) !== null ? '' : eol)
    : '';
  return headerBlock + bodyWithTerminator + newEntries.join('');
}
