import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = 'G:\\QQ-AI-ChatBot\\tmp\\osu-bp100-corpus';
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const attrs = JSON.parse(fs.readFileSync(path.join(DIR, 'mod_difficulty_attributes.json'), 'utf8'));
const attrByKey = new Map(attrs.records.filter((r) => r.attributes).map((r) => [r.beatmap_id, r]));

const files = fs.readdirSync(path.join(DIR, 'osu')).filter((f) => f.endsWith('.osu'));
let reverified = 0, bad = 0, missing = 0, totalBytes = 0;
const rows = [];
const statusCounts = {};
const modCounts = {};
const arCounts = {};

for (const rec of manifest.beatmaps) {
  const p = path.join(DIR, rec.file.replace('/', path.sep));
  if (!fs.existsSync(p)) { missing++; continue; }
  const buf = fs.readFileSync(p);
  totalBytes += buf.length;
  const digest = crypto.createHash('md5').update(buf).digest('hex');
  if (digest === rec.expected_md5) reverified++; else { bad++; console.log('MD5 MISMATCH', rec.beatmap_id); }

  const text = buf.toString('utf8');
  const header = (key) => (text.match(new RegExp('^' + key + ':(.*)$', 'm')) || [, ''])[1].trim();
  statusCounts[rec.beatmap.status] = (statusCounts[rec.beatmap.status] || 0) + 1;
  modCounts[rec.bp_entries[0].mods] = (modCounts[rec.bp_entries[0].mods] || 0) + 1;
  const ar = Number(header('ApproachRate')) || rec.beatmap.ar;
  arCounts[Math.floor(ar)] = (arCounts[Math.floor(ar)] || 0) + 1;

  const a = attrByKey.get(rec.beatmap_id);
  rows.push({
    bp: rec.bp_entries[0].bp,
    beatmap_id: rec.beatmap_id,
    beatmapset_id: rec.beatmap.beatmapset_id,
    artist: rec.beatmap.artist,
    title: rec.beatmap.title,
    version: rec.beatmap.version,
    mods: rec.bp_entries[0].mods,
    pp: rec.bp_entries[0].pp,
    accuracy: rec.bp_entries[0].accuracy,
    star_rating_api: rec.beatmap.difficulty_rating,
    od: rec.beatmap.od, ar: rec.beatmap.ar, cs: rec.beatmap.cs, hp: rec.beatmap.hp,
    bpm: rec.beatmap.bpm, length_s: rec.beatmap.total_length,
    objects: rec.beatmap.count_circles + rec.beatmap.count_sliders + rec.beatmap.count_spinners,
    osu_file: rec.file,
    osu_md5: rec.expected_md5,
    file_has_beatmapid_header: /^BeatmapID:/m.test(text),
    official_star_rating: a ? a.attributes.star_rating : null,
    official_aim_difficulty: a ? a.attributes.aim_difficulty : null,
    official_speed_difficulty: a ? a.attributes.speed_difficulty : null,
    official_slider_factor: a ? a.attributes.slider_factor : null,
    official_speed_note_count: a ? a.attributes.speed_note_count : null,
    official_max_combo: a ? a.attributes.max_combo : null,
    official_aim_slider_count: a ? a.attributes.aim_difficult_slider_count : null,
    official_aim_strain_count: a ? a.attributes.aim_difficult_strain_count : null,
    official_speed_strain_count: a ? a.attributes.speed_difficult_strain_count : null,
  });
}
rows.sort((x, y) => x.bp - y.bp);

console.log('=== independent re-verification of files on disk ===');
console.log('files on disk        :', files.length);
console.log('md5 re-verified OK   :', reverified);
console.log('md5 mismatch         :', bad);
console.log('missing files        :', missing);
console.log('total size           :', (totalBytes / 1024 / 1024).toFixed(2), 'MB');
console.log('map beatmap statuses :', JSON.stringify(statusCounts));
console.log('mod sets (1:1 BP)    :', JSON.stringify(modCounts));
console.log('AR buckets           :', JSON.stringify(arCounts));
console.log('attr records w/ data :', attrByKey.size, '/', attrs.records.length);

// flat join index for the Skill Profiler pipeline
const cols = Object.keys(rows[0]);
const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => {
  const v = r[c];
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}).join(','))).join('\n');
fs.writeFileSync(path.join(DIR, 'join_index.csv'), csv, 'utf8');
fs.writeFileSync(path.join(DIR, 'join_index.json'), JSON.stringify({ meta: { generatedAt: new Date().toISOString(), rows: rows.length }, rows }, null, 2), 'utf8');
console.log('join index rows      :', rows.length);

console.log('\n=== sample official attributes (exact mod set) ===');
for (const r of [rows[0], rows.find((x) => x.mods === 'HDDT'), rows[rows.length - 1]]) {
  if (!r) continue;
  console.log('BP' + r.bp + ' ' + r.artist + ' - ' + r.title + ' [' + r.version + '] ' + r.mods);
  console.log('   api SR=' + r.star_rating_api + '  official(SR=' + r.official_star_rating + ' aim=' + r.official_aim_difficulty + ' speed=' + r.official_speed_difficulty + ' slider_factor=' + r.official_slider_factor + ' speed_notes=' + r.official_speed_note_count + ')');
}
