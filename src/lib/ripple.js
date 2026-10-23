// 原型里这几类按钮点击时也有波纹：全部停止=红，一键启动/启动=薄荷绿。
export function paletteForButton(text) {
  if (text === '全部停止') return 'danger';
  if (text === '一键启动' || text === '启动') return 'mint';
  if (text === '重启' || text === '重启中…') return 'amber';
  return null;
}

// 给按钮加 class，由 CSS 伪元素画扩散环。
const PULSE_COLORS = {
  pink: 'var(--pink)',
  amber: 'var(--amber)',
  mint: 'var(--mint)',
  danger: 'var(--red)',
};

export function pulseButton(target, palette = 'amber') {
  if (!target || typeof target.classList === 'undefined') return;
  const color = PULSE_COLORS[palette] || PULSE_COLORS.amber;
  target.style.setProperty('--ripple-color', color);
  target.classList.remove('is-rippling');
  // 强制重排，保证连续点击也能重新播放
  void target.offsetWidth;
  target.classList.add('is-rippling');
  window.setTimeout(() => target.classList.remove('is-rippling'), 900);
}
