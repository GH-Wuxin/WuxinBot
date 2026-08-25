import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildPlayerSkillProfilePayload } from '../server/bots/playerSkillProfile.ts';

const osuId = Number(process.argv[2] || 19244792);
const output = resolve(process.argv[3] || 'tmp/player-skill-profile.json');
if (!Number.isSafeInteger(osuId) || osuId <= 0) throw new Error('Invalid osu! user ID');

const payload = await buildPlayerSkillProfilePayload(osuId, 20);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, ...payload.sample, player: payload.player }, null, 2));
