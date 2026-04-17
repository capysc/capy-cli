import { DEPLOY_PAGE_CSS } from './generatedAssets';
import { platformLogoSvg } from './platformLogos';
import { renderInstructionMarkdown } from './markdown';

const CAPY_LOGO_SVG = `<svg width="40" height="40" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M50 0L93.3013 25V75L50 100L6.69873 75V25L50 0Z" fill="url(#d0)"/><path d="M50 49.5V100L93.5 75V25L50 49.5Z" fill="black"/><path d="M74.5044 54V64.8832L81 67.8489L80.5617 68.8437L74.1859 65.9328L68.9222 75L68 74.4451L73.4332 65.0866V54.5453L74.5044 54Z" fill="white" stroke="white" stroke-width="2"/><path d="M29.375 53.5L10.875 33.4862L10.875 48.5L29.375 59L29.375 53.5Z" fill="black"/><defs><linearGradient id="d0" x1="50" y1="0" x2="50" y2="100" gradientUnits="userSpaceOnUse"><stop stop-opacity="0.15"/><stop offset="1" stop-opacity="0.5"/></linearGradient></defs></svg>`;

const escHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function generateDeployHtml(
  secretsBlob: string,
  projectKey: string,
  platformName: string,
  platformKey: string,
  instructionMarkdown: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Capy Deploy — ${escHtml(platformName)}</title>
  <style>${DEPLOY_PAGE_CSS}</style>
</head>
<body class="min-h-screen bg-white dark:bg-black font-sans text-neutral-900 dark:text-white">
  <div class="max-w-2xl mx-auto px-5 py-12">

    <div class="flex items-center gap-3 mb-8">
      <div class="dark:invert">${CAPY_LOGO_SVG}</div>
      <svg width="20" height="20" viewBox="0 0 24 24" class="text-neutral-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      ${platformLogoSvg(platformKey) ? `<div class="text-black dark:text-white">${platformLogoSvg(platformKey)}</div>` : ''}
      <h1 class="text-xl font-semibold">${escHtml(platformName)}</h1>
    </div>

    <div class="space-y-3 mb-8 border border-black dark:border-white">
      <div class="grid grid-cols-3 p-3">
        <label class="text-sm font-mono">SECRETS_BLOB</label>
        <div class="flex gap-2 col-span-2 items-start">
          <textarea id="secrets-blob" readonly rows="3" class="flex-grow font-mono text-sm dark:bg-black">${escHtml(secretsBlob)}</textarea>
          <button onclick="copyValue('secrets-blob', this)" class="bg-black text-white dark:bg-white dark:text-black w-16 text-xs uppercase -mt-3 -mr-3">Copy</button>
        </div>
      </div>

      <div class="grid grid-cols-3 border-t border-t-black p-3">
        <label class="text-sm font-mono">PROJECT_KEY</label>
        <div class="flex gap-2 col-span-2 items-start">
          <textarea id="project-key" readonly rows="1" class="flex-grow font-mono text-sm dark:bg-black">${escHtml(projectKey)}</textarea>
          <button onclick="copyValue('project-key', this)" class="bg-black text-white dark:bg-white dark:text-black w-16 text-xs uppercase -mt-3 -mr-3">Copy</button>
        </div>
      </div>
    </div>

    <div class="border border-neutral-200 dark:border-neutral-800 px-6 pb-6">
      ${renderInstructionMarkdown(instructionMarkdown)}
    </div>
  </div>

  <script>
    async function copyValue(id, btn) {
      const el = document.getElementById(id);
      const original = btn.textContent;
      try {
        await navigator.clipboard.writeText(el.value);
        btn.textContent = 'Copied!';
        btn.classList.add('bg-green-600', 'dark:bg-green-500');
        btn.classList.remove('bg-neutral-900', 'dark:bg-white', 'dark:text-neutral-900');
        btn.classList.add('text-white', 'dark:text-white');
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove('bg-green-600', 'dark:bg-green-500', 'dark:text-white');
          btn.classList.add('bg-neutral-900', 'dark:bg-white', 'dark:text-neutral-900');
        }, 2000);
      } catch {
        el.select();
      }
    }
  </script>
</body>
</html>`;
}
