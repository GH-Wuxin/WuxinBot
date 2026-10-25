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
export interface SocialState {
  self?: PippiSelf;
  activity?: PippiActivityState;
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
