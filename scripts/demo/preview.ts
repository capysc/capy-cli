/**
 * Render each `capy --web` screen to a standalone HTML file (no server needed) so
 * they can be screenshotted for review. Pure presentation — uses the same screen
 * builders the live wizard uses. The recovery phrase shown here is a throwaway
 * generated just for the preview; it is not used as a key.
 *
 *   bun scripts/demo/preview.ts <outDir>
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { DEPLOY_PAGE_CSS } from '../../src/ui/deployPage/generatedAssets';
import { chooseSourceScreen, phraseDisplayScreen, passphraseScreen } from '../../src/ui/onboardingWeb';
import { buildScreenHtml } from '../../src/ui/conflictWeb';
import { generateSeedPhrase } from '../../src/crypto/keyManager';

const outDir = process.argv[2] || '/tmp/capy-preview';
mkdirSync(outDir, { recursive: true });

function page(title: string, screenHtml: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>${DEPLOY_PAGE_CSS}</style></head>
<body class="min-h-screen bg-white font-sans text-neutral-900">
  <div class="max-w-xl mx-auto px-5 py-12">
    <h1 class="text-xl font-semibold mb-6">${title}</h1>
    <div id="screen">${screenHtml}</div>
  </div>
</body></html>`;
}

const previewPhrase = generateSeedPhrase();

const screens: Array<[string, string, string]> = [
  ['1-onboard-choose.html', 'Set up Capy — local mode', chooseSourceScreen().html],
  ['2-onboard-phrase.html', 'Set up Capy — local mode', phraseDisplayScreen(previewPhrase).html],
  ['3-onboard-passphrase.html', 'Set up Capy — local mode', passphraseScreen().html],
  [
    '4-conflict-resolver.html',
    'Resolve 2 conflicts — demo/development',
    buildScreenHtml({
      rows: [
        { variable: 'API_KEY', pinned: 'sk_...001', local: 'sk_...999', remote: null },
        { variable: 'DATABASE_URL', pinned: 'pos...dev', local: 'pos...ing', remote: null },
      ],
      showLocal: true,
      showRemote: false,
      projectName: 'demo',
      branch: 'development',
    }),
  ],
  [
    '5-conflict-resolver-3way.html',
    'Resolve 2 conflicts — demo/development',
    // 3-way conflict (a teammate also pushed) → the Remote column appears too.
    buildScreenHtml({
      rows: [
        { variable: 'API_KEY', pinned: 'sk_...001', local: 'sk_...999', remote: 'sk_...777' },
        { variable: 'DATABASE_URL', pinned: 'pos...dev', local: 'pos...ing', remote: 'pos...prd' },
      ],
      showLocal: true,
      showRemote: true,
      projectName: 'demo',
      branch: 'development',
    }),
  ],
];

for (const [file, title, html] of screens) {
  writeFileSync(join(outDir, file), page(title, html));
  console.log(join(outDir, file));
}
