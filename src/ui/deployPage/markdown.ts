// Renders the instruction markdown shown on the deploy page using the
// vendored `marked` parser, with a custom renderer that applies the same
// Tailwind classes used everywhere else on the page.
//
// Only the subset of tags we actually emit is overridden; marked falls back
// to its defaults for anything else.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { marked, Marked } = require('../../vendor/marked/marked') as {
  marked: any;
  Marked: any;
};

const instance = new Marked({
  gfm: true,
  breaks: false,
});

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

instance.use({
  renderer: {
    heading(this: any, { tokens, depth }: any) {
      const text = this.parser.parseInline(tokens);
      const size = depth === 1 ? 'text-xl' : 'text-lg';
      return `<h${depth} class="${size} font-semibold mt-6 mb-3 text-neutral-900 dark:text-white">${text}</h${depth}>\n`;
    },
    paragraph(this: any, { tokens }: any) {
      const text = this.parser.parseInline(tokens);
      return `<p class="my-2 text-neutral-700 dark:text-neutral-300">${text}</p>\n`;
    },
    strong(this: any, { tokens }: any) {
      const text = this.parser.parseInline(tokens);
      return `<strong class="font-semibold text-neutral-900 dark:text-white">${text}</strong>`;
    },
    em(this: any, { tokens }: any) {
      const text = this.parser.parseInline(tokens);
      return `<em class="italic">${text}</em>`;
    },
    codespan(_: any, token?: any) {
      const raw = token ? token.text : _.text;
      return `<code class="bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded text-sm font-mono">${escapeHtml(raw)}</code>`;
    },
    code({ text }: any) {
      return `<pre class="bg-neutral-100 dark:bg-neutral-800 p-3 rounded-md overflow-x-auto my-2 text-sm"><code class="font-mono">${escapeHtml(text)}</code></pre>\n`;
    },
    list(this: any, token: any) {
      const tag = token.ordered ? 'ol' : 'ul';
      const cls = token.ordered ? 'list-decimal' : 'list-disc';
      const body = token.items.map((item: any) => this.listitem(item)).join('');
      return `<${tag} class="${cls} pl-6 my-2 text-neutral-700 dark:text-neutral-300 space-y-1">${body}</${tag}>\n`;
    },
    listitem(this: any, item: any) {
      // Render tight list items (single-token text) without the default <p>
      // wrapper marked injects for "loose" lists, so the line sits next to
      // its marker rather than forming its own paragraph block.
      if (!item.loose && item.tokens.every((t: any) => t.type !== 'space')) {
        const inline = item.tokens
          .map((t: any) =>
            t.type === 'text' ? this.parser.parseInline(t.tokens) : this.parser.parse([t]),
          )
          .join('');
        return `<li class="my-0.5">${inline}</li>`;
      }
      const body = this.parser.parse(item.tokens);
      return `<li class="my-1">${body}</li>`;
    },
    link(this: any, { href, tokens }: any) {
      const text = this.parser.parseInline(tokens);
      return `<a href="${href}" class="underline hover:text-neutral-900 dark:hover:text-white">${text}</a>`;
    },
    hr() {
      // Tailwind preflight zeroes out <hr> borders; re-apply an explicit one.
      return `<hr class="my-6 border-t border-neutral-200 dark:border-neutral-800">\n`;
    },
  },
});

export function renderInstructionMarkdown(md: string): string {
  return instance.parse(md) as string;
}
