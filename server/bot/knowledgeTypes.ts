// Knowledge base v4.1 — shared types.
// The knowledge base is an optional, bypassable incremental layer. These
// types separate internal retrieval results (with document ids/scores, for
// logs and debugging) from prompt-facing blocks (only generic source class,
// title and text — never internal identifiers).

export type KnowledgeCollection = 'wuxin_self' | 'osu_domain' | 'community_style';

export type KbRouteKind =
  | 'none'
  | 'wuxin_self'
  | 'osu_domain'
  | 'community_style'
  | 'self_and_domain'
  | 'osu_casual_with_domain';

export type CollectionStatus = 'disabled' | 'not_loaded' | 'loading' | 'ready' | 'failed';

export type KbEnableSource =
  | 'env'
  | 'sentinel'
  | 'db'
  | 'db_unavailable'
  | 'collection'
  | 'rollout'
  | 'scene';

export interface KbEnableDecision {
  enabled: boolean;
  source: KbEnableSource;
}

export interface KnowledgeBaseCollectionSettings {
  wuxinSelf: boolean;
  osuDomain: boolean;
  communityStyle: boolean;
}

export interface KnowledgeBaseRolloutSettings {
  mode: 'off' | 'allowlist' | 'all';
  groupIds: string[];
  privateMessagesEnabled: boolean;
}

export interface KnowledgeBaseSettings {
  enabled: boolean;
  collections: KnowledgeBaseCollectionSettings;
  rollout: KnowledgeBaseRolloutSettings;
}

export const DEFAULT_KB_SETTINGS: KnowledgeBaseSettings = {
  enabled: false,
  collections: { wuxinSelf: true, osuDomain: true, communityStyle: true },
  rollout: { mode: 'off', groupIds: [], privateMessagesEnabled: false },
};

export interface KbRoute {
  kind: KbRouteKind;
  reason: string;
}

export interface KbDocument {
  id: string;
  title?: string;
  tags: string[];
  content: string;
  source?: string;
  authority?: string;
  commandExamples?: { command: string; verifier: string }[];
  implementationRefs?: { path: string; symbol: string }[];
}

export interface RetrievedKnowledgeBlock {
  collection: KnowledgeCollection;
  documentId: string;
  title?: string;
  text: string;
  score: number;
}

export interface PromptKnowledgeBlock {
  sourceClass: '功能说明' | 'osu! 领域知识' | '社区表达参考';
  title?: string;
  text: string;
}

export interface KbDrop {
  documentId: string;
  reason: string;
}

export interface KbRetrievalResult {
  route: KbRoute;
  decision: KbEnableDecision;
  blocks: RetrievedKnowledgeBlock[];
  dropped: KbDrop[];
  elapsedMs: number;
}

export interface KbRuntimeInput {
  scene: string;
  text: string;
  groupId?: string;
  messageType?: 'group' | 'private';
  contextMessages?: { role?: string; userId?: string | number; content?: string }[];
  settings?: KnowledgeBaseSettings;
}

export interface KbCollectionHealth {
  status: CollectionStatus;
  docCount: number;
  errorCode?: string;
}

export interface KbHealth {
  decision: KbEnableDecision | null;
  collections: Record<KnowledgeCollection, KbCollectionHealth>;
  contentSha: string | null;
  loadedAt: string | null;
  buildGeneratedAt: string | null;
  retrievalConfigVersion: number | null;
}
