// Used only to regenerate src/ui/deployPage/generatedAssets.ts via
// `npm run build:deploy-assets` (invokes `npx --yes tailwindcss@3.4`).
// Tailwind is not an installed dep — npx pulls it on demand at regen time.
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/commands/deployTokenCommand.ts',
    './src/ui/deployPage/html.ts',
    './src/ui/deployPage/markdown.ts',
    './src/ui/deployPage/platformLogos.ts',
    // NOTE: deliberately excluding generatedAssets.ts — it's the script's own
    // output file. Scanning it makes CSS self-feeding: yesterday's classes get
    // re-emitted every run, so safelist removals never shrink the output.
  ],
  darkMode: 'media',
  // Design iteration on the deploy page should mostly not require a CSS
  // regen. Layout is safelisted in bulk. Colours are scoped to the
  // palettes we actually use (neutral for greys, plus a few accents for
  // semantic states). Exotic tint-aware prefixes (ring/divide/gradients/
  // stroke/etc.) and the `focus` variant are intentionally excluded — add
  // them back here if a real use case comes up.
  safelist: [
    // Layout — padding, margin, space, gap, sizing, position, flex, grid
    { pattern: /^-?(p|m)(t|r|b|l|x|y|s|e)?-/ },
    { pattern: /^(space|gap)(-x|-y)?-/ },
    { pattern: /^(w|h|min-w|min-h|max-w|max-h|size)-/ },
    { pattern: /^-?(top|right|bottom|left|start|end|inset)(-x|-y)?-/ },
    { pattern: /^z-/ },
    { pattern: /^(order|basis)-/ },
    { pattern: /^flex-/ },
    { pattern: /^(items|justify|content|self|place)-/ },
    { pattern: /^(grid-cols|grid-rows|col-span|row-span|col-start|col-end|row-start|row-end|auto-cols|auto-rows|grid-flow)-/ },
    { pattern: /^(overflow|overscroll)-/ },
    'flex', 'inline-flex', 'grid', 'inline-grid', 'block', 'inline-block', 'inline', 'hidden', 'contents', 'table',
    'static', 'fixed', 'absolute', 'relative', 'sticky',

    // Borders — widths, sides, radius
    { pattern: /^border(-[xytrbls|e])?(-\d+)?$/ },
    { pattern: /^rounded(-[a-z]+)?(-[a-z0-9]+)?$/ },

    // Colours — only bg/text/border (all others unused on this page).
    // Base tokens + a few semantic palettes, with dark/hover variants.
    { pattern: /^(bg|text|border)-(black|white|transparent|current|inherit)$/, variants: ['dark', 'hover', 'dark:hover'] },
    { pattern: /^(bg|text|border)-(neutral|red|green|blue|amber)-(50|100|200|300|400|500|600|700|800|900|950)$/, variants: ['dark', 'hover', 'dark:hover'] },
  ],
  plugins: [],
};
