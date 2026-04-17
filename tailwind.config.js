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
  theme: {
    extend: {
      fontFamily: {
        geist: ['Geist', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
