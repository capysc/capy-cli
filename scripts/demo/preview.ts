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
import { buildConflictData } from '../../src/ui/syncConflictScreen';
import { renderScreen } from '../../src/ui/screens/serve';
import { CAPY_LOGO_SVG } from '../../src/ui/browserWizard';
import { generateSeedPhrase } from '../../src/crypto/keyManager';

const outDir = process.argv[2] || '/tmp/capy-preview';
mkdirSync(outDir, { recursive: true });

function page(title: string, screenHtml: string, theme: 'light' | 'dark' = 'light'): string {
  // Force the theme for the preview: set color-scheme on <html> and, for dark,
  // flip the screen's own wrapper (which declares `light dark`) to `dark` so its
  // light-dark() colours resolve dark even without OS emulation.
  const dark = theme === 'dark';
  // Force the screen's wrapper to the chosen scheme so light-dark() resolves
  // deterministically in headless (which otherwise follows the host's preference).
  const inner = screenHtml.replaceAll('color-scheme:light dark', `color-scheme:${theme}`);
  const bodyBg = dark ? 'background:#000;color:#fff;' : 'background:#fff;color:#171717;';
  return `<!DOCTYPE html><html lang="en" style="color-scheme:${theme}"><head><meta charset="UTF-8"><style>${DEPLOY_PAGE_CSS}</style></head>
<body class="min-h-screen font-sans" style="${bodyBg}">
  <div class="max-w-xl mx-auto px-0 py-12">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;">
      <div style="${dark ? 'filter:invert(1);' : ''}">${CAPY_LOGO_SVG}</div>
      <h1 class="text-xl font-semibold">${title}</h1>
    </div>
    <div id="screen">${inner}</div>
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
    renderScreen(
      'sync-conflict',
      buildConflictData(
        {
          rows: [
            { variable: 'API_KEY', pinned: 'sk_...001', local: 'sk_...999', remote: null },
            { variable: 'DATABASE_URL', pinned: 'pos...dev', local: 'pos...ing', remote: null },
          ],
          unresolvable: new Set<string>(),
          showLocal: true,
          showRemote: false,
          localMode: false,
          isOnboarding: false,
          isBehind: false,
          remoteState: 'empty',
          actions: [
            { value: 'commit_local', label: 'Commit and push all local values' },
            { value: 'retrieve_pinned', label: 'Retrieve all pinned values' },
            { value: 'individual', label: 'Individually resolve' },
            { value: 'skip', label: 'Continue working' },
          ],
          projectName: 'demo',
          branch: 'development',
        },
        'preview-nonce',
      ),
    ),
  ],
  [
    '5-conflict-resolver-3way.html',
    'Resolve 2 conflicts — demo/development',
    // 3-way conflict (a teammate also pushed) → the Remote column appears too.
    renderScreen(
      'sync-conflict',
      buildConflictData(
        {
          rows: [
            { variable: 'API_KEY', pinned: 'sk_...001', local: 'sk_...999', remote: 'sk_...777' },
            { variable: 'DATABASE_URL', pinned: 'pos...dev', local: 'pos...ing', remote: 'pos...prd' },
          ],
          unresolvable: new Set<string>(),
          showLocal: true,
          showRemote: true,
          localMode: false,
          isOnboarding: false,
          isBehind: false,
          remoteState: 'ok',
          actions: [
            { value: 'commit_local', label: 'Commit and push all local values' },
            { value: 'retrieve_pinned', label: 'Retrieve all pinned values' },
            { value: 'individual', label: 'Individually resolve' },
            { value: 'skip', label: 'Continue working' },
          ],
          projectName: 'demo',
          branch: 'development',
        },
        'preview-nonce',
      ),
    ),
  ],
];

for (const [file, title, html] of screens) {
  writeFileSync(join(outDir, file), page(title, html, 'light'));
  console.log(join(outDir, file));
  const darkFile = file.replace(/\.html$/, '-dark.html');
  writeFileSync(join(outDir, darkFile), page(title, html, 'dark'));
  console.log(join(outDir, darkFile));
}
