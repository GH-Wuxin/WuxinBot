import React, { useEffect, useState } from 'react';
import { Save, Sparkles } from 'lucide-react';
import { Button, Card, InlineHelp, Input, SectionHeader, Textarea } from '../../components/ui/index.jsx';

export function PersonaPage({ db, saveSettings }) {
  const [draft, setDraft] = useState(db.settings);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(db.settings);
  }, [db.settings, dirty]);

  const updateDraft = (patch) => {
    setDirty(true);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const save = async () => {
    await saveSettings({ botNames: draft.botNames, personalityPrompt: draft.personalityPrompt });
    setDirty(false);
  };

  return <div className="console-page persona-page">
    <SectionHeader eyebrow="Context / Persona" title="人设与说话方式" description="配置默认 persona 的名字和核心提示词；persona 影响表达方式，不改变 Agent runtime 的执行边界。" />
    <Card className="console-section persona-editor">
      <div className="console-section__title"><Sparkles size={18} /><div><h3>默认人格</h3><p>多个机器人名字使用英文逗号分隔。</p></div></div>
      <Input label="机器人名字" value={draft.botNames || ''} onChange={(event) => updateDraft({ botNames: event.target.value })} />
      <Textarea label="人设 Prompt" rows={18} value={draft.personalityPrompt || ''} onChange={(event) => updateDraft({ personalityPrompt: event.target.value })} />
      <InlineHelp>这里是机器人的性格核心。建议保留“像群友、少长篇、不过度解释自己是 AI”等基础约束。</InlineHelp>
      <div className="console-actions console-actions--end"><Button variant="primary" icon={Save} onClick={save}>保存人设</Button></div>
    </Card>
  </div>;
}
