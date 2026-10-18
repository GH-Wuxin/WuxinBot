import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Square } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Card } from '../../components/ui/index.jsx';

function elapsedText(ms) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (seconds < 60) return seconds + ' 秒';
  const minutes = Math.floor(seconds / 60);
  return minutes + ' 分 ' + (seconds % 60) + ' 秒';
}

/**
 * 正在生成中的回复列表。每两秒拉一次，可以掐断其中任意一轮 ——
 * 掐断后这一轮不会再发任何东西（正文、贴纸、失败提示都不发）。
 */
export function ReplyProcesses() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api('/api/reply-processes', { timeoutMs: 8000 });
      if (!mounted.current) return;
      setRows(Array.isArray(data?.processes) ? data.processes : []);
      setError('');
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause?.message || String(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = window.setInterval(() => void refresh(), 2000);
    const clock = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => {
      mounted.current = false;
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [refresh]);

  const abort = async (row) => {
    setBusy(row.id);
    try {
      await api('/api/reply-processes/' + encodeURIComponent(row.id) + '/abort', { method: 'POST', timeoutMs: 8000 });
      await refresh();
    } catch (cause) {
      setError(cause?.message || String(cause));
    } finally {
      setBusy('');
    }
  };

  const active = rows.filter((row) => !row.aborted);
  if (!active.length && !error) {
    return <Card className="reply-processes"><header className="reply-processes__head"><h2>正在回复</h2><span className="osu-muted">空闲</span></header></Card>;
  }

  return <Card className="reply-processes">
    <header className="reply-processes__head">
      <h2>正在回复</h2>
      <span className="osu-muted">{active.length ? active.length + ' 轮进行中' : '空闲'}</span>
    </header>
    {error && <p className="osu-inline-warning" role="status">读取失败：{error}</p>}
    {!active.length && <p className="osu-muted">现在没有正在生成的回复。</p>}
    {active.length > 0 && <ul className="reply-processes__list">
      {active.map((row) => <li key={row.id} className="reply-processes__row">
        <div className="reply-processes__who">
          <strong>{row.nickname || row.userId || '未知'}</strong>
          <span className="osu-muted">群 {row.groupId || '私聊'}{row.userId ? ' · QQ ' + row.userId : ''}</span>
        </div>
        <div className="reply-processes__stage">{row.stage}<span className="osu-muted"> · {elapsedText(Number(row.elapsedMs) + (tick % 2) * 2000)}</span></div>
        <Button variant="secondary" size="sm" icon={Square} loading={busy === row.id} onClick={() => abort(row)}>掐断</Button>
      </li>)}
    </ul>}
  </Card>;
}
