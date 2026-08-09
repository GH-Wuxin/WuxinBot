export const OSU_KNOWLEDGE_SOURCES = {
  wiki: 'https://github.com/ppy/osu-wiki',
  api: 'https://osu.ppy.sh/docs/',
  lazer: 'https://github.com/ppy/osu',
  web: 'https://github.com/ppy/osu-web',
  performance: 'https://github.com/ppy/osu-performance',
} as const;

export const WIKI_SOURCE = {
  mods: `${OSU_KNOWLEDGE_SOURCES.wiki}/tree/master/wiki/Gameplay/Game_modifier`,
  pp: `${OSU_KNOWLEDGE_SOURCES.wiki}/blob/master/wiki/Performance_points/en.md`,
  ar: `${OSU_KNOWLEDGE_SOURCES.wiki}/blob/master/wiki/Beatmap/Approach_rate/en.md`,
  od: `${OSU_KNOWLEDGE_SOURCES.wiki}/blob/master/wiki/Beatmap/Overall_difficulty/en.md`,
  cs: `${OSU_KNOWLEDGE_SOURCES.wiki}/blob/master/wiki/Beatmap/Circle_size/en.md`,
  hp: `${OSU_KNOWLEDGE_SOURCES.wiki}/blob/master/wiki/Beatmap/HP_drain_rate/en.md`,
  grades: `${OSU_KNOWLEDGE_SOURCES.wiki}/blob/master/wiki/Gameplay/Grade/en.md`,
  status: `${OSU_KNOWLEDGE_SOURCES.wiki}/blob/master/wiki/Beatmap/Category/en.md`,
} as const;
