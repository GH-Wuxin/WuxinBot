import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

function elapsedText(ms) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (seconds < 60) return seconds + ' 秒';
  const minutes = Math.floor(seconds / 60);
  return minutes + ' 分 ' + (seconds % 60) + ' 秒';
}

/**
 * 正在生成中的回复列表。每两秒拉一次，可以掐断其中任意一轮 ——
 * 掐断后这一轮不会再发任何东西（正文、贴纸、失败提示都不发）。
 * 空闲时不占版面（原型里没有这一块）。
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
  if (!active.length) return null;

  return <div className="card" style={{ marginBottom: 16 }}>
    <div className="card-head">
      <span className="card-title">正在回复</span>
      <span className="muted" style={{ fontSize: 12 }}>{active.length} 轮进行中</span>
    </div>
    {error && <div className="note" style={{ color: 'var(--red)' }}>读取失败：{error}</div>}
    <div className="rows">
      {active.map((row) => <div className="row" key={row.id}>
        <div className="row-main">
          <div className="row-title">{row.nickname || row.userId || '未知'}</div>
          <div className="row-sub">群 {row.groupId || '私聊'} · {row.stage} · {elapsedText(Number(row.elapsedMs) + (tick % 2) * 2000)}</div>
        </div>
        <button type="button" className="btn btn-sm" disabled={busy === row.id} onClick={() => abort(row)}>掐断</button>
      </div>)}
    </div>
  </div>;
}
