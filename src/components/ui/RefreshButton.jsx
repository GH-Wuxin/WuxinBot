import React, { useRef, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';

// 统一的刷新按钮：转圈 → 打勾 → 失败复位，配一次薄荷色波纹。
// 页面自己的 onClick 返回 Promise 时会等它完成；同步的也至少转 450ms，避免闪一下看不出来。
export function RefreshButton({ onClick, label = '刷新', className = 'btn', iconSize = 14, disabled = false }) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);
  const mounted = useRef(true);

  React.useEffect(() => () => {
    mounted.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const run = async (event) => {
    if (state === 'busy' || disabled) return;
    setState('busy');
    const started = Date.now();
    let ok = true;
    try {
      await onClick?.(event);
    } catch {
      ok = false;
    }
    const wait = Math.max(0, 450 - (Date.now() - started));
    timer.current = setTimeout(() => {
      if (!mounted.current) return;
      if (!ok) { setState('idle'); return; }
      setState('done');
      // 成功后放一次薄荷色波纹；失败就不放，避免误导。
      import('../../lib/ripple.js')
        .then(({ rippleFrom }) => rippleFrom(event?.currentTarget, 'mint'))
        .catch(() => {});
      timer.current = setTimeout(() => { if (mounted.current) setState('idle'); }, 1300);
    }, wait);
  };

  return <button
    type="button"
    className={`${className}${state === 'done' ? ' is-refreshed' : ''}`}
    disabled={disabled || state === 'busy'}
    onClick={run}
    aria-live="polite"
  >
    {state === 'busy'
      ? <RefreshCw size={iconSize} className="refresh-spin" />
      : state === 'done'
        ? <Check size={iconSize} />
        : <RefreshCw size={iconSize} />}
    <span style={{ marginLeft: 6 }}>{state === 'done' ? '已刷新' : state === 'busy' ? '刷新中…' : label}</span>
  </button>;
}
