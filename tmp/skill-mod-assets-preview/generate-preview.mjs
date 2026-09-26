import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromYumu = createRequire('file:///G:/My%20pack/Agent%20Work/codex_work/napcat-local-bots/sources/yumu-image/package.json');
const sharp = requireFromYumu('sharp');

const outputRoot = 'G:/QQ-AI-ChatBot/tmp/skill-mod-assets-preview';
const iconRoot = 'G:/My pack/Agent Work/codex_work/napcat-local-bots/data/yumu/img/ExportFileV3/Mods';

const mods = [
  { id: 'NM', name: 'No Mod', category: 'BASE', colors: ['#34465d', '#1b293a', '#7ddce8'], ink: '#f2f7ff' },
  { id: 'NF', name: 'No Fail', category: 'SAFETY', colors: ['#1686d9', '#074b91', '#6bd5ff'], ink: '#f7fcff' },
  { id: 'EZ', name: 'Easy', category: 'DIFFICULTY', colors: ['#46c86b', '#16783c', '#9affb1'], ink: '#f4fff6' },
  { id: 'HD', name: 'Hidden', category: 'VISIBILITY', colors: ['#ffd84d', '#d39800', '#fff2a1'], ink: '#3b2d00' },
  { id: 'HR', name: 'Hard Rock', category: 'DIFFICULTY', colors: ['#ff5d63', '#b71932', '#ffabb0'], ink: '#fff7f8' },
  { id: 'SD', name: 'Sudden Death', category: 'FAILURE', colors: ['#ff9e38', '#c84a16', '#ffd187'], ink: '#3e1600' },
  { id: 'PF', name: 'Perfect', category: 'FAILURE', colors: ['#fff03b', '#e39b00', '#fff9a5'], ink: '#392900' },
  { id: 'HT', name: 'Half Time', category: 'SPEED', colors: ['#9eb7ce', '#526a86', '#deefff'], ink: '#102033' },
  { id: 'DT', name: 'Double Time', category: 'SPEED', colors: ['#24d5f4', '#087eaf', '#8af2ff'], ink: '#052837' },
  { id: 'NC', name: 'Nightcore', category: 'SPEED', colors: ['#c262ff', '#6f20bd', '#e4a7ff'], ink: '#fff8ff' },
  { id: 'DC', name: 'Daycore', category: 'SPEED', colors: ['#74d8ff', '#277ba8', '#c0f1ff'], ink: '#09283a' },
  { id: 'FL', name: 'Flashlight', category: 'VISIBILITY', colors: ['#4b4f59', '#10131a', '#ffd84d'], ink: '#fff1a1' },
];

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function iconData(id) {
  const bytes = await readFile(path.join(iconRoot, `${id.toLowerCase()}.png`));
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function badgeSvg(mod, icon) {
  const [bright, deep, accent] = mod.colors;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="248" height="80" viewBox="0 0 248 80">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${bright}"/><stop offset="0.58" stop-color="${deep}"/><stop offset="1" stop-color="#07101d"/></linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#ffffff" stop-opacity="0.48"/><stop offset="0.48" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="1" stop-color="#000000" stop-opacity="0.18"/></linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0"><stop stop-color="${accent}"/><stop offset="0.52" stop-color="#ffffff" stop-opacity="0.34"/><stop offset="1" stop-color="${accent}"/></linearGradient>
    <pattern id="lines" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(24)"><rect width="4" height="18" fill="#ffffff" fill-opacity="0.055"/></pattern>
    <filter id="shadow" x="-20%" y="-40%" width="140%" height="180%"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#00050c" flood-opacity="0.72"/></filter>
    <filter id="iconGlow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="${accent}" flood-opacity="0.55"/></filter>
    <clipPath id="badge"><path d="M20 4H219L244 25V55L219 76H20C11 76 4 69 4 60V20C4 11 11 4 20 4Z"/></clipPath>
  </defs>
  <g filter="url(#shadow)">
    <path d="M20 4H219L244 25V55L219 76H20C11 76 4 69 4 60V20C4 11 11 4 20 4Z" fill="url(#body)" stroke="url(#edge)" stroke-width="2"/>
    <g clip-path="url(#badge)">
      <rect x="4" y="4" width="240" height="72" fill="url(#lines)"/>
      <path d="M4 4H244V34C192 25 132 24 4 39Z" fill="url(#shine)"/>
      <path d="M83 7L106 73" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2"/>
      <path d="M87 7L110 73" stroke="#000000" stroke-opacity="0.24" stroke-width="2"/>
    </g>
    <image x="11" y="11" width="76" height="54" xlink:href="${icon}" preserveAspectRatio="xMidYMid meet" filter="url(#iconGlow)" opacity="0.96"/>
    <text x="112" y="56" fill="${mod.ink}" font-family="Segoe UI,Arial,sans-serif" font-size="43" font-weight="900" letter-spacing="2">${mod.id}</text>
    <text x="114" y="23" fill="${mod.ink}" fill-opacity="0.76" font-family="Segoe UI,Arial,sans-serif" font-size="9" font-weight="800" letter-spacing="2.1">${mod.category}</text>
    <path d="M18 72H218" stroke="${accent}" stroke-width="2" stroke-linecap="round" opacity="0.68"/>
  </g>
</svg>`;
}

await mkdir(outputRoot, { recursive: true });
const rendered = [];
for (const mod of mods) {
  const icon = await iconData(mod.id);
  const svg = badgeSvg(mod, icon);
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const file = path.join(outputRoot, `mod-${mod.id.toLowerCase()}.png`);
  await sharp(png).toFile(file);
  rendered.push({ ...mod, png });
}

const cells = rendered.map((mod, index) => {
  const column = index % 4;
  const row = Math.floor(index / 4);
  const x = 58 + column * 385;
  const y = 155 + row * 225;
  const data = `data:image/png;base64,${mod.png.toString('base64')}`;
  return `<g>
    <rect x="${x}" y="${y}" width="330" height="174" rx="22" fill="#07111f" fill-opacity="0.82" stroke="#7fe8f0" stroke-opacity="0.10"/>
    <image x="${x + 41}" y="${y + 31}" width="248" height="80" xlink:href="${data}"/>
    <text x="${x + 42}" y="${y + 143}" fill="#eef6ff" font-family="Segoe UI,Arial,sans-serif" font-size="18" font-weight="650">${escapeXml(mod.name)}</text>
    <text x="${x + 42}" y="${y + 163}" fill="#7890aa" font-family="Segoe UI,Arial,sans-serif" font-size="11" font-weight="700" letter-spacing="1.5">248 × 80 · TRANSPARENT PNG</text>
  </g>`;
}).join('');

const sheet = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1600" height="900" viewBox="0 0 1600 900">
  <defs>
    <radialGradient id="bg" cx="0.18" cy="0.05" r="1.2"><stop stop-color="#17314b"/><stop offset="0.48" stop-color="#071421"/><stop offset="1" stop-color="#030811"/></radialGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#8de9ef" stroke-opacity="0.035"/></pattern>
  </defs>
  <rect width="1600" height="900" fill="url(#bg)"/>
  <rect width="1600" height="900" fill="url(#grid)"/>
  <text x="58" y="66" fill="#f4f8ff" font-family="Segoe UI,Arial,sans-serif" font-size="36" font-weight="750">Skill Profiler · Mod Badges</text>
  <text x="59" y="102" fill="#82dfe8" font-family="Segoe UI,Arial,sans-serif" font-size="15" font-weight="750" letter-spacing="2.2">MATERIAL STUDY V1 · 248 × 80 · INDIVIDUAL TRANSPARENT PNG</text>
  ${cells}
  <text x="1542" y="856" text-anchor="end" fill="#6f839b" font-family="Segoe UI,Arial,sans-serif" font-size="13" font-weight="700" letter-spacing="1.6">NOT YET INTEGRATED</text>
</svg>`;

await sharp(Buffer.from(sheet)).jpeg({ quality: 93 }).toFile(path.join(outputRoot, 'mod-badges-preview-v1.jpg'));
console.log(JSON.stringify({ outputRoot, count: rendered.length, preview: path.join(outputRoot, 'mod-badges-preview-v1.jpg') }));
