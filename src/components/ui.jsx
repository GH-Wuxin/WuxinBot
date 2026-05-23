// Shared UI components and API helper for the QQ AI ChatBot GUI.
import React from 'react';

export function api(path, options = {}) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || '请求失败');
    return data;
  });
}

export function Stat({ label, value }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong></div>;
}

export function Row({ label, value }) {
  return <div className="row"><span>{label}</span><strong>{String(value)}</strong></div>;
}

export function Text({ label, value, onChange }) {
  return <label className="field"><span>{label}</span><input value={value || ''} onChange={(e) => onChange(e.target.value)} /></label>;
}

export function Password({ label, value, onChange }) {
  return <label className="field"><span>{label}</span><input type="password" placeholder={value === '已填写' ? '已填写，留空不改' : ''} value={value === '已填写' ? '' : value || ''} onChange={(e) => onChange(e.target.value)} /></label>;
}

export function Select({ label, value, onChange, options }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {Object.entries(options).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </label>
  );
}

export function Slider({ label, min, max, step = 1, value, onChange }) {
  return (
    <label className="field">
      <span>{label}：{value}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
