import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireFromYumu = createRequire('file:///G:/My%20pack/Agent%20Work/codex_work/napcat-local-bots/sources/yumu-image/package.json');
const sharp = requireFromYumu('sharp');
const outputRoot = 'G:/QQ-AI-ChatBot/tmp/skill-mod-assets-preview';
const iconRoot = 'G:/My pack/Agent Work/codex_work/napcat-local-bots/data/yumu/img/ExportFileV3/Mods';

const mods = [
  { id: 'NM', name: 'No Mod', colors: ['#536b83', '#263649'], edge: '#9edbea', ink: '#f5f9ff' },
  { id: 'NF', name: 'No Fail', colors: ['#40aef5', '#126db3'], edge: '#9ee7ff', ink: '#ffffff' },
  { id: 'EZ', name: 'Easy', colors: ['#67df82', '#259b50'], edge: '#bbffc8', ink: '#08391a' },
  { id: 'HD', name: 'Hidden', colors: ['#ffe65a', '#eeb000'], edge: '#fff3a4', ink: '#443100' },
  { id: 'HR', name: 'Hard Rock', colors: ['#ff7379', '#c82c43'], edge: '#ffb7bb', ink: '#fff9fa' },
  { id: 'SD', name: 'Sudden Death', colors: ['#ffad54', '#d65c1d'], edge: '#ffd4a4', ink: '#4a1b00' },
  { id: 'PF', name: 'Perfect', colors: ['#fff15b', '#e9a800'], edge: '#fff8ad', ink: '#473300' },
  { id: 'HT', name: 'Half Time', colors: ['#c7d6e4', '#7890a8'], edge: '#f0f7ff', ink: '#203246' },
  { id: 'DT', name: 'Double Time', colors: ['#46e4f7', '#1296c7'], edge: '#a9f7ff', ink: '#073347' },
  { id: 'NC', name: 'Nightcore', colors: ['#ca6cff', '#7c2ac4'], edge: '#eab5ff', ink: '#fffaff' },
  { id: 'DC', name: 'Daycore', colors: ['#8be4ff', '#3a9cc8'], edge: '#c9f5ff', ink: '#0a3548' },
  { id: 'FL', name: 'Flashlight', colors: ['#4a4f59', '#151922'], edge: '#ffe36b', ink: '#fff0a4' },
];

async function iconData(id) {
  const bytes = await readFile(path.join(iconRoot, `${id.toLowerCase()}.png`));
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function badgeSvg(mod, icon) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="68" viewBox="0 0 200 68">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${mod.colors[0]}"/><stop offset="1" stop-color="${mod.colors[1]}"/></linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff" stop-opacity="0.34"/><stop offset="0.48" stop-color="#fff" stop-opacity="0.04"/><stop offset="1" stop-color="#000" stop-opacity="0.08"/></linearGradient>
    <filter id="shadow" x="-20%" y="-45%" width="140%" height="190%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000611" flood-opacity="0.62"/></filter>
    <clipPath id="pill"><rect x="3" y="4" width="194" height="60" rx="18"/></clipPath>
  </defs>
  <g filter="url(#shadow)">
    <rect x="3" y="4" width="194" height="60" rx="18" fill="url(#body)" stroke="${mod.edge}" stroke-width="1.5"/>
    <g clip-path="url(#pill)">
      <image x="5" y="7" width="78" height="55" xlink:href="${icon}" preserveAspectRatio="xMidYMid meet" opacity="0.25"/>
      <path d="M3 4H197V31C149 22 84 22 3 34Z" fill="url(#gloss)"/>
      <circle cx="174" cy="15" r="18" fill="#fff" opacity="0.055"/>
    </g>
    <path d="M77 13V55" stroke="#fff" stroke-opacity="0.20" stroke-width="1"/>
    <text x="136" y="47" text-anchor="middle" fill="${mod.ink}" font-family="Segoe UI,Arial,sans-serif" font-size="34" font-weight="850" letter-spacing="1">+${mod.id}</text>
  </g>
</svg>`;
}

await mkdir(outputRoot, { recursive: true });
const rendered = [];
for (const mod of mods) {
  const svg = badgeSvg(mod, await iconData(mod.id));
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  await sharp(png).toFile(path.join(outputRoot, `mod-v2-${mod.id.toLowerCase()}.png`));
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
    <image x="${x + 35}" y="${y + 28}" width="260" height="88" xlink:href="${data}"/>
    <text x="${x + 42}" y="${y + 146}" fill="#eef6ff" font-family="Segoe UI,Arial,sans-serif" font-size="18" font-weight="650">${mod.name}</text>
    <text x="${x + 42}" y="${y + 165}" fill="#7890aa" font-family="Segoe UI,Arial,sans-serif" font-size="11" font-weight="700" letter-spacing="1.5">200 × 68 · TRANSPARENT PNG</text>
  </g>`;
}).join('');

const sheet = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1600" height="900" viewBox="0 0 1600 900">
  <defs><radialGradient id="bg" cx="0.18" cy="0.05" r="1.2"><stop stop-color="#17314b"/><stop offset="0.48" stop-color="#071421"/><stop offset="1" stop-color="#030811"/></radialGradient><pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#8de9ef" stroke-opacity="0.035"/></pattern></defs>
  <rect width="1600" height="900" fill="url(#bg)"/><rect width="1600" height="900" fill="url(#grid)"/>
  <text x="58" y="66" fill="#f4f8ff" font-family="Segoe UI,Arial,sans-serif" font-size="36" font-weight="750">Skill Profiler · Mod Badges V2</text>
  <text x="59" y="102" fill="#82dfe8" font-family="Segoe UI,Arial,sans-serif" font-size="15" font-weight="750" letter-spacing="2.2">MINIMAL PILL · ICON WATERMARK · +ACRONYM ONLY</text>
  ${cells}
  <text x="1542" y="856" text-anchor="end" fill="#6f839b" font-family="Segoe UI,Arial,sans-serif" font-size="13" font-weight="700" letter-spacing="1.6">REVIEW ONLY · NOT INTEGRATED</text>
</svg>`;

await sharp(Buffer.from(sheet)).jpeg({ quality: 93 }).toFile(path.join(outputRoot, 'mod-badges-preview-v2.jpg'));
console.log(JSON.stringify({ count: rendered.length, preview: path.join(outputRoot, 'mod-badges-preview-v2.jpg') }));
