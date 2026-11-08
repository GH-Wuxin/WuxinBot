import type { BotEvent } from '../../types.js';
import type { PippiSelf, SelfProposal, PippiActivityState } from './self.js';

export type SocialAction = 'pass' | 'wait' | 'react' | 'reply';
export type SocialEngagement = 'direct' | 'continuation' | 'ambient';
export type Affinity = { kind: 'ordinary'; score: number } | { kind: 'owner'; label: '特殊' };
export interface SocialPerson {
  userId: string;
  affinity: Affinity;
  familiarity: number;
  revision: number;
  updatedAt: string;
}
export interface SocialMood {
  label: string;
  reason: string;
  updatedAt: string;
}
export interface SocialView {
  lastEvaluatedAt?: string;
  lastReason?: string;
  summary: string;
  preferredNames: string[];
  style: string;
  mood: SocialMood;
  revision: number;
  updatedAt: string;
}
export interface SocialAssessment {
  self?: SelfProposal | null;
  action: SocialAction;
  addressee: 'bot' | 'member' | 'group' | 'unclear';
  reason: string;
  evidenceIds: string[];
  affinityDelta: number;
  familiarityDelta: number;
  summary: string | null;
  preferredNames: string[] | null;
  style: string | null;
  mood: { label: string; reason: string } | null;
}
export interface SocialTransition {
  id: string;
  userId: string;
  scope: string;
  messageIds: string[];
  source: 'llm' | 'console-revert' | 'console-correction';
  reason: string;
  before: { person: SocialPerson | null; view: SocialView | null };
  after: { person: SocialPerson; view: SocialView };
  createdAt: string;
}
export interface SocialDecision {
  id: string;
  userId: string;
  scope: string;
  messageIds: string[];
  action: SocialAction;
  reason: string;
  evidenceIds: string[];
  durationMs: number;
  totalTokens: number;
  stage: 'assessment' | 'wait' | 'revalidation' | 'guard' | 'failure' | 'delivery';
  engagement?: SocialEngagement;
  phase?: 'initial' | 'resumed' | 'revalidation';
  createdAt: string;
}
export interface OwnerDirective {
  id: string;
  key: string;
  text: string;
  scope: string;
  authorId: string;
  sourceMessageId: string;
  version: number;
  active: boolean;
  createdAt: string;
}
export interface PresenceSelf {
  mood: { label: string; reason: string; updatedAt: string };
  valence: number;
  energy: number;
  interest: number;
  focus: string[];
  updatedAt: string;
}

export interface PresencePerson {
  userId: string;
  impression: string;
  warmth: number;
  familiarity: number;
  lastSeenAt: string;
  evidenceIds: string[];
}

export interface PresenceObservation {
  id: string;
  messageIds: string[];
  topic: string;
  sentiment: string;
  salience: number;
  noticed: string;
  createdAt: string;
}

export interface PresenceThread {
  id: string;
  topic: string;
  participants: string[];
  status: 'open' | 'closed';
  note: string;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PresenceCulture {
  phrase: string;
  meaning: string;
  strength: number;
  evidenceIds: string[];
  updatedAt: string;
}

export interface PresenceGroup {
  groupId: string;
  people: Record<string, PresencePerson>;
  threads: PresenceThread[];
  culture: PresenceCulture[];
  observations: PresenceObservation[];
  noticing: string[];
  updatedAt: string;
}

export interface PresenceState {
  version: 1;
  self: PresenceSelf;
  groups: Record<string, PresenceGroup>;
  updatedAt: string;
}

export interface SocialState {
  reflectionQueue?: {
    key:string;event:SocialEvent;scope:string;account:string;ids:string[];timelineIds:string[];
    outcome:{action:SocialAction;replied:boolean};queuedAt:string;attempts:number;lastAttemptAt?:string;
  }[];
  self?: PippiSelf;
  activity?: PippiActivityState;
  presence?: PresenceState;
  schemaVersion: 1;
  revision: number;
  people: Record<string, SocialPerson>;
  views: Record<string, SocialView>;
  transitions: SocialTransition[];
  decisions: SocialDecision[];
  processed: string[];
  feedback: { id: string; decisionId: string; verdict: 'should-reply' | 'should-pass'; note: string; createdAt: string }[];
}
export interface SocialEvent extends BotEvent {
  socialMessageIds?: string[];
  socialAction?: SocialAction;
  socialDirect?: boolean;
  socialNamed?: boolean;
  socialContextIds?: string[];
  socialEngagement?: SocialEngagement;
  socialMessages?: { messageId: string; userId: string; text: string; atTargets: string[]; replyMessageId: string }[];
}
