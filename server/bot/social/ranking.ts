import { isSystemOwner, readSocialPerson, socialScope, viewKey } from './state.js';

/** Names are display data only. A room never borrows another room's nickname. */
export function socialMemberNames(db: any, scope: string | null): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of db.messages || []) {
    if (message.role === 'user' && (!scope || socialScope(message) === scope) && message.nickname) {
      names.set(String(message.userId), String(message.nickname));
    }
  }
  for (const member of db.users || []) {
    const userId = String(member.userId);
    if (member.nickname && (scope ? `group:${member.groupId}` === scope : !names.has(userId))) {
      names.set(userId, String(member.nickname));
    }
  }
  return names;
}

/** Read-only global scores, optionally restricted to people with a view in this room. */
export function readAffinityRanking(db: any, scope: string | null, limit = 20) {
  const names = socialMemberNames(db, scope);
  const people = Object.keys(db.socialV2?.people || {}).filter((userId) => !scope || db.socialV2.views[viewKey(scope, userId)])
    .flatMap((userId) => {
      const person = readSocialPerson(db, userId);
      return person && !isSystemOwner(db, person) && person.affinity.kind === 'ordinary'
        ? [{ userId, nickname: names.get(userId) || userId, score: Number(person.affinity.score.toFixed(1)) }] : [];
    })
    .sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId, 'en', { numeric: true }));
  let rank = 0;
  const ranked = people.map((person, index) => {
    if (index === 0 || person.score !== people[index - 1].score) rank = index + 1;
    return { ...person, rank };
  });
  const ownerId = String(db.settings.ownerQq || '');
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 20;
  return { scope: scope || 'global', total: ranked.length, entries: ranked.slice(0, count),
    owner: ownerId ? { userId: ownerId, nickname: names.get(ownerId) || 'Owner', label: '特殊' } : null };
}
