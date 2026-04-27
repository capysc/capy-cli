// Standalone reproduction of displayHeader. Set MODE=light or MODE=dark.
const mode = process.env.MODE === 'light' ? 'light' : 'dark';

const fg = mode === 'light'
  ? (s) => `\x1b[38;2;0;0;0m${s}\x1b[0m`         // pure black
  : (s) => `\x1b[38;2;255;255;255m${s}\x1b[0m`;  // pure white

const grey = (s) => mode === 'light'
  ? `\x1b[38;2;140;140;140m${s}\x1b[0m`
  : `\x1b[38;2;140;140;140m${s}\x1b[0m`;

const bold = (s) => mode === 'light'
  ? `\x1b[1m\x1b[38;2;0;0;0m${s}\x1b[0m`
  : `\x1b[1m\x1b[38;2;255;255;255m${s}\x1b[0m`;

const shimmer = (s) => {
  const stops = [
    [58, 85, 85],
    [104, 135, 149],
    [160, 107, 107],
    [177, 170, 146],
    [58, 85, 85],
  ];
  const len = s.replace(/ /g, '').length;
  let charIdx = 0;
  return s.split('').map((ch) => {
    if (ch === ' ') return ch;
    const t = len > 1 ? charIdx / (len - 1) : 0;
    const segment = t * (stops.length - 1);
    const i = Math.floor(segment);
    const f = segment - i;
    const a = stops[Math.min(i, stops.length - 1)];
    const b = stops[Math.min(i + 1, stops.length - 1)];
    const r = Math.round(a[0] + (b[0] - a[0]) * f);
    const g = Math.round(a[1] + (b[1] - a[1]) * f);
    const bl = Math.round(a[2] + (b[2] - a[2]) * f);
    charIdx++;
    return `\x1b[38;2;${r};${g};${bl}m${ch}\x1b[0m`;
  }).join('');
};

let seed = 42;
const rand = () => {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
};

const capy = [
  '   █▄▄▅▅▅▄▄█',
  '   ▅▅█████▅▅',
  '  ▟█████████▙',
  ' ▟█████ █████▙',
  '▐█████▄█▄█████▌',
];

const info = [
  `${fg('Project:')}      ${bold('capy')}`,
  `${fg('Organization:')} ${fg('Capy')}`,
  `${fg('Branch:')}       ${fg('development')}`,
  '',
  shimmer('Welcome!'),
];

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const capyWidth = Math.max(...capy.map(l => l.length));
const infoWidth = Math.max(...info.map(l => stripAnsi(l).length));
const gap = 3;
const maxLen = infoWidth + gap + capyWidth + 2;

console.log('');
console.log(grey('Capy CLI'));
console.log(grey('┌' + '─'.repeat(maxLen) + '┐'));

const totalRows = Math.max(info.length, capy.length);
for (let i = 0; i < totalRows; i++) {
  const left = i < info.length ? info[i] : '';
  const right = i < capy.length ? capy[i] : '';
  const leftPad = infoWidth - stripAnsi(left).length;
  const rightPad = capyWidth - right.length;
  const blackBg = {
    1: new Set([3, 4, 10, 11]),
    4: new Set([6, 8]),
  };
  const nose = {
    3: new Set([7]),
  };
  const furry = (s, row) => s.split('').map((ch, col) => {
    if (nose[row]?.has(col)) return `\x1b[38;2;0;0;0m█\x1b[0m`;
    if (ch === ' ') return ch;
    const v = rand() * 40 - 20;
    const r = Math.round(150 + v);
    const g = Math.round(115 + v * 0.7);
    const b = Math.round(80 + v * 0.5);
    const bg = blackBg[row]?.has(col) ? '\x1b[48;2;0;0;0m' : '';
    return `${bg}\x1b[38;2;${r};${g};${b}m${ch}\x1b[0m`;
  }).join('');
  console.log(`${grey('│')} ${left}${' '.repeat(leftPad)}${' '.repeat(gap)}${furry(right, i)}${' '.repeat(rightPad + 1)}${grey('│')}`);
}

console.log(grey('└' + '─'.repeat(maxLen) + '┘'));
console.log('');
