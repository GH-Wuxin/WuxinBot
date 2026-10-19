// 与原型 app.js 的 rippleFrom() 等价：从按钮中心扩散一圈径向渐变，
// 用 clip-path 圆形展开，结束即移除节点。
const PALETTES = {
  pink: 'radial-gradient(circle at center, rgba(255, 102, 170, 0.26), rgba(255, 102, 170, 0.08) 55%, transparent 75%)',
  amber: 'radial-gradient(circle at center, rgba(255, 204, 34, 0.28), rgba(255, 204, 34, 0.10) 55%, transparent 75%)',
  mint: 'radial-gradient(circle at center, rgba(92, 214, 180, 0.24), rgba(92, 214, 180, 0.08) 55%, transparent 75%)',
  danger: 'radial-gradient(circle at center, rgba(255, 92, 92, 0.26), rgba(255, 92, 92, 0.08) 55%, transparent 75%)',
};

export function rippleFrom(target, palette = 'amber') {
  if (typeof document === 'undefined' || !document.body) return;
  const rect = target && typeof target.getBoundingClientRect === 'function'
    ? target.getBoundingClientRect()
    : null;
  if (!rect || rect.width <= 0 || rect.height <= 0) return;

  // 只在按钮自身范围内扩散，不再铺满整页。
  const pad = 10;
  const left = rect.left - pad;
  const top = rect.top - pad;
  const width = rect.width + pad * 2;
  const height = rect.height + pad * 2;

  const element = document.createElement('div');
  element.className = 'ripple is-local';
  const background = PALETTES[palette];
  if (background) element.style.background = background;
  element.style.position = 'fixed';
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  element.style.inset = 'auto';
  element.style.borderRadius = '999px';
element.style.zIndex = '9999';
element.style.pointerEvents = 'none';
element.style.overflow = 'hidden';
  document.body.appendChild(element);

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.hypot(width, height) / 2 + 6;
  const animation = element.animate([
    { clipPath: `circle(0px at ${cx}px ${cy}px)`, opacity: 0.95 },
    { clipPath: `circle(${radius}px at ${cx}px ${cy}px)`, opacity: 0.35, offset: 0.75 },
    { clipPath: `circle(${radius}px at ${cx}px ${cy}px)`, opacity: 0 },
  ], { duration: 1100, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'forwards' });
  animation.onfinish = () => element.remove();
}

// 原型里这几类按钮点击时也有波纹：全部停止=红，一键启动/启动=薄荷绿。
export function paletteForButton(text) {
  if (text === '全部停止') return 'danger';
  if (text === '一键启动' || text === '启动') return 'mint';
  if (text === '重启' || text === '重启中…') return 'amber';
  return null;
}

// 比 rippleFrom 稳：不往 body 插节点、不用 WAAPI、不依赖 clip-path，
// 直接给按钮加一个 class，由 CSS 伪元素画扩散环。
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
