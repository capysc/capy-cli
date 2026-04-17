// Used only to regenerate src/ui/deployPage/generatedAssets.ts via
// `npm run build:deploy-assets` (invokes `npx --yes tailwindcss@3.4`).
// Tailwind is not an installed dep — npx pulls it on demand at regen time.
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/commands/deployTokenCommand.ts',
    './src/ui/deployPage/**/*.ts',
  ],
  darkMode: 'media',
  // Layout utilities are safelisted in bulk so design iteration on the
  // deploy page doesn't require regenerating CSS every time a class is
  // added. Colours/typography/borders/etc. still come from content scan.
  safelist: [
    // Layout
    { pattern: /^-?(p|m)(t|r|b|l|x|y|s|e)?-/ },                     // padding, margin (incl. negative)
    { pattern: /^(space|gap)(-x|-y)?-/ },                           // space-between children, flex/grid gaps
    { pattern: /^(w|h|min-w|min-h|max-w|max-h|size)-/ },            // width/height
    { pattern: /^-?(top|right|bottom|left|start|end|inset)(-x|-y)?-/ },
    { pattern: /^z-/ },                                             // z-index
    { pattern: /^(order|basis)-/ },
    { pattern: /^flex-/ },                                          // flex-row, flex-col, flex-1, flex-wrap, …
    { pattern: /^(items|justify|content|self|place)-/ },
    { pattern: /^(grid-cols|grid-rows|col-span|row-span|col-start|col-end|row-start|row-end|auto-cols|auto-rows|grid-flow)-/ },
    { pattern: /^(overflow|overscroll)-/ },
    'flex', 'inline-flex', 'grid', 'inline-grid', 'block', 'inline-block', 'inline', 'hidden', 'contents', 'table',
    'static', 'fixed', 'absolute', 'relative', 'sticky',

    // Borders (widths + sides + radius)
    { pattern: /^border(-[xytrbls|e])?(-\d+)?$/ },
    { pattern: /^rounded(-[a-z]+)?(-[a-z0-9]+)?$/ },
    { pattern: /^divide-(x|y)(-\d+)?$/ },

    // Colors for every tint-aware utility, across the default palette + base tokens.
    // `variants: ['dark', 'hover', 'focus']` emits the corresponding `dark:*`, `hover:*`,
    // and `focus:*` forms so you can style interactions and dark mode without regenerating.
    { pattern: /^(bg|text|border|ring|divide|outline|placeholder|accent|caret|fill|stroke|decoration|from|via|to)-(black|white|transparent|current|inherit)$/, variants: ['dark', 'hover', 'focus', 'dark:hover'] },
    { pattern: /^(bg|text|border|ring|divide|outline|placeholder|accent|caret|fill|stroke|decoration|from|via|to)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)$/, variants: ['dark', 'hover', 'focus', 'dark:hover'] },
  ],
  plugins: [],
};
