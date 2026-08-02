export type OsuKnowledgeAuthority = 'official' | 'community' | 'analysis_policy';

export interface OsuKnowledgeEntry {
  id: string;
  authority: OsuKnowledgeAuthority;
  tags: readonly string[];
  fact: string;
  source: string;
}

export function formatKnowledgeBlock(title: string, entries: readonly OsuKnowledgeEntry[]): string {
  if (entries.length === 0) return '';
  return [
    `【${title}】`,
    ...entries.map((entry) => `- ${entry.fact}`),
  ].join('\n');
}
