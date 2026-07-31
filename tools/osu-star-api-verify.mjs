import 'dotenv/config';
import { getBeatmapAttributes, getUser, getUserBestScores } from '../server/osu/api.js';

const username = process.argv.slice(2).join(' ') || '[SHK]Wuxin';
const user = await getUser(username, 'osu');
const scores = await getUserBestScores(user.id, 'osu', 100);

const groups = [
  ['DT/NC', score => score.mods?.some(mod => mod === 'DT' || mod === 'NC')],
  ['HR', score => score.mods?.includes('HR')],
  ['HD without HR/DT', score =>
    score.mods?.includes('HD') &&
    !score.mods.some(mod => ['HR', 'DT', 'NC', 'HT', 'EZ', 'DA'].includes(mod))
  ],
  ['NF/SO', score => score.mods?.some(mod => mod === 'NF' || mod === 'SO')],
];

console.log(`Player: ${user.username} (${user.id})`);
for (const [label, predicate] of groups) {
  const score = scores.find(predicate);
  if (!score) {
    console.log(`${label}: no BP sample`);
    continue;
  }
  const result = await getBeatmapAttributes(score.beatmap.id, 'osu', score.mods);
  console.log(
    `${label}: beatmap=${score.beatmap.id} mods=${score.mods.join('') || 'NM'} ` +
    `base=${Number(score.beatmap.difficulty_rating).toFixed(2)}★ ` +
    `official_modded=${Number(result.attributes.star_rating).toFixed(2)}★`
  );
}
