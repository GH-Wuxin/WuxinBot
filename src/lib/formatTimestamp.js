export const formatTimestamp = (value) => {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : '—';
};
