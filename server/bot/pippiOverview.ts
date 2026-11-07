/**
 * Read-only aggregate for the console's Pippi page.
 *
 * The page must show one coherent picture: presence (what she noticed and how
 * she feels), social V2 (who she is close to and what she decided), and self
 * experiences (what she remembers). Keep this module read-only; corrections
 * remain on their existing endpoints.
 */
import { presenceSnapshot } from './presence.js';
import { activeOwnerDirectives, readSocialPerson, readSocialView } from './social/state.js';
import { readAffinityRanking, socialMemberNames } from './social/ranking.js';
import { participationStatus } from './social/policy.js';
import { pippiActivityStatus } from './activity.js';
import { readPippiSelf, selfScopeVisible } from './social/self.js';

export function buildPippiOverview(db: any, options: { groupId?: string; userId?: string } = {}) {
  const presence = presenceSnapshot(db);
  const self = readPippiSelf(db);
  const groups = (db.groups || []).map((group: any) => ({
    groupId: String(group.groupId),
    name: String(group.name || group.groupId),
    enabled: group.enabled === true,
    mode: String(group.mode || ''),
    presence: presence.groups[String(group.groupId)] || null,
  }));
  const selectedGroup = groups.find((group) => group.groupId === String(options.groupId || ''))
    || groups[0] || null;
  const scope = selectedGroup ? `group:${selectedGroup.groupId}` : '';
  const selectedUserId = String(options.userId || '');
  const state = db.socialV2 || {};
  const names = scope ? socialMemberNames(db, scope) : new Map<string, string>();
  const ids = [...new Set([String(db.settings?.ownerQq || ''), ...Object.keys(state.people || {})])].filter(Boolean);
  const people = ids.flatMap((userId) => {
    const person = readSocialPerson(db, userId);
    if (!person) return [];
    return [{
      ...person,
      nickname: names.get(userId) || userId,
      view: scope ? readSocialView(db, scope, userId) : null,
    }];
  });
  const selectedPerson = people.find((person) => String(person.userId) === selectedUserId) || null;
  const decisions = (state.decisions || [])
    .filter((decision: any) => decision.scope === scope && (!selectedUserId || String(decision.userId) === selectedUserId))
    .slice(-60).reverse();
  const transitions = (state.transitions || [])
    .filter((transition: any) => transition.scope === scope && (!selectedUserId || String(transition.userId) === selectedUserId))
    .slice(-40).reverse();
  const feedback = (state.feedback || []).filter((item: any) =>
    decisions.some((decision: any) => decision.id === item.decisionId));
  const experiences = self.experiences
    .filter((experience) => selfScopeVisible(experience.scope, scope || 'public'))
    .slice().reverse();
  const selectedDbGroup = selectedGroup
    ? (db.groups || []).find((group: any) => String(group.groupId) === selectedGroup.groupId)
    : null;
  return {
    ok: true,
    revision: {
      social: Number(state.revision || 0),
      self: self.revision,
      presence: presence.updatedAt,
    },
    identity: {
      name: 'Pippi',
      selfQq: String(db.settings?.selfQq || ''),
      model: String(db.settings?.model || ''),
      provider: String(db.settings?.llmProvider || ''),
      presenceEnabled: db.settings?.presenceEnabled === true,
      socialV2Enabled: db.settings?.socialV2Enabled === true,
      globalPaused: db.settings?.globalPaused === true,
    },
    self: {
      mood: presence.self.mood,
      valence: presence.self.valence,
      energy: presence.self.energy,
      interest: presence.self.interest,
      focus: presence.self.focus,
      socialMood: self.mood,
      socialFocus: self.focus,
      activity: pippiActivityStatus(db),
    },
    groups,
    selected: selectedGroup ? {
      groupId: selectedGroup.groupId,
      scope,
      group: selectedGroup,
      presence: selectedGroup.presence,
      context: selectedGroup.presence ? {
        topics: selectedGroup.presence.openThreads.map((thread: any) => thread.topic),
        noticing: selectedGroup.presence.noticing,
        culture: selectedGroup.presence.cultureDetails,
        activePeople: selectedGroup.presence.peopleDetails,
        updatedAt: presence.updatedAt,
      } : null,
      participation: selectedDbGroup ? participationStatus(db, selectedDbGroup) : null,
      person: selectedPerson,
      people,
      names: Object.fromEntries(names),
      ranking: scope ? readAffinityRanking(db, scope, 200) : { scope: 'global', total: 0, entries: [], owner: null },
      decisions,
      transitions,
      feedback,
      experiences: experiences.slice(0, 30),
      experienceTotal: experiences.length,
      directives: scope ? activeOwnerDirectives(db, scope) : [],
    } : null,
  };
}
