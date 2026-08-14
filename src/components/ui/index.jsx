import React, { useEffect } from 'react';
import { AlertTriangle, ChevronDown, HelpCircle, LoaderCircle, Minus, Plus, UsersRound, X } from 'lucide-react';

const cx = (...values) => values.filter(Boolean).join(' ');

export function Button({ variant = 'secondary', size = 'md', loading = false, icon: Icon, className, children, disabled, ...props }) {
  return <button className={cx('ui-button', `ui-button--${variant}`, `ui-button--${size}`, className)} disabled={disabled || loading} {...props}>
    {loading ? <LoaderCircle className="ui-spin" size={16} /> : Icon ? <Icon size={16} /> : null}<span>{children}</span>
  </button>;
}

export function IconButton({ label, icon: Icon, variant = 'ghost', className, ...props }) {
  return <button className={cx('ui-icon-button', `ui-button--${variant}`, className)} aria-label={label} title={label} {...props}><Icon size={17} /></button>;
}

export function Card({ as: Component = 'section', className, children, ...props }) {
  return <Component className={cx('ui-card', className)} {...props}>{children}</Component>;
}

export function MetricCard({ label, value, detail, tone = 'neutral', icon: Icon }) {
  return <Card className={cx('metric-card', `metric-card--${tone}`)}><div className="metric-card__label">{Icon && <Icon size={16} />}{label}</div><strong>{value}</strong>{detail && <span>{detail}</span>}</Card>;
}

export function StatusDot({ tone = 'neutral' }) {
  return <span className={cx('status-dot', `status-dot--${tone}`)} aria-hidden="true" />;
}

export function StatusBadge({ tone = 'neutral', children }) {
  return <span className={cx('status-badge', `status-badge--${tone}`)}><StatusDot tone={tone} />{children}</span>;
}

export function Pill({ tone = 'neutral', children, className }) {
  return <span className={cx('ui-pill', `ui-pill--${tone}`, className)}>{children}</span>;
}

function Field({ label, hint, error, children, className }) {
  return <label className={cx('ui-field', className)}>{label && <span className="ui-field__label">{label}</span>}{children}{hint && <span className="ui-field__hint">{hint}</span>}{error && <span className="ui-field__error">{error}</span>}</label>;
}

export function Input({ label, hint, error, className, ...props }) {
  return <Field label={label} hint={hint} error={error} className={className}><input className="ui-input" {...props} /></Field>;
}

export function Select({ label, hint, error, options = [], className, ...props }) {
  return <Field label={label} hint={hint} error={error} className={className}><span className="ui-select-shell"><select className="ui-select" {...props}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={15} aria-hidden="true" /></span></Field>;
}

export function Textarea({ label, hint, error, className, ...props }) {
  return <Field label={label} hint={hint} error={error} className={className}><textarea className="ui-textarea" {...props} /></Field>;
}

export function Switch({ checked, onChange, label, description, disabled = false }) {
  return <label className={cx('ui-switch', disabled && 'ui-switch--disabled')}><input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} /><span className="ui-switch__track"><span /></span><span className="ui-switch__copy"><strong>{label}</strong>{description && <small>{description}</small>}</span></label>;
}

export function NumberInput({ label, hint, error, className, min, max, step = 1, value, onChange, suffix, ...props }) {
  const update = (next) => {
    const parsed = Number(next);
    const bounded = Math.min(max ?? parsed, Math.max(min ?? parsed, parsed));
    onChange?.(Number.isFinite(bounded) ? bounded : value);
  };
  return <Field label={label} hint={hint} error={error} className={className}><span className="ui-number"><button type="button" aria-label={`${label || '数值'}减小`} onClick={() => update(Number(value || 0) - Number(step))} disabled={props.disabled || (min !== undefined && Number(value) <= Number(min))}><Minus size={13} /></button><input className="ui-input" type="number" min={min} max={max} step={step} value={value} onChange={(event) => update(event.target.value)} {...props} />{suffix && <span className="ui-number__suffix">{suffix}</span>}<button type="button" aria-label={`${label || '数值'}增大`} onClick={() => update(Number(value || 0) + Number(step))} disabled={props.disabled || (max !== undefined && Number(value) >= Number(max))}><Plus size={13} /></button></span></Field>;
}

export function Slider({ label, value, min, max, step = 1, onChange, hint, className }) {
  return <label className={cx('ui-slider', className)}><span className="ui-slider__heading"><strong>{label}</strong><output>{value}</output></span><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />{hint && <small>{hint}</small>}</label>;
}

export function SettingGroup({ title, description, actions, children, className }) {
  return <section className={cx('ui-setting-group', className)}><header><div><h3>{title}</h3>{description && <p>{description}</p>}</div>{actions && <div className="ui-setting-group__actions">{actions}</div>}</header><div className="ui-setting-group__body">{children}</div></section>;
}

export function SettingRow({ title, description, control, tone = 'normal', children, className }) {
  return <div className={cx('ui-setting-row', `ui-setting-row--${tone}`, className)}><div className="ui-setting-row__copy"><strong>{title}</strong>{description && <small>{description}</small>}</div><div className="ui-setting-row__control">{control || children}</div></div>;
}

export function InlineHelp({ children, tone = 'normal' }) {
  return <p className={cx('ui-inline-help', `ui-inline-help--${tone}`)}><HelpCircle size={14} aria-hidden="true" /><span>{children}</span></p>;
}

export function GroupAvatar({ src, name, size = 36, className }) {
  const [failed, setFailed] = React.useState(false);
  const initial = String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
  React.useEffect(() => setFailed(false), [src]);
  return <span className={cx('ui-group-avatar', className)} style={{ '--avatar-size': `${size}px` }} aria-label={`${name || '群聊'}头像`}>
    {src && !failed ? <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} /> : <><UsersRound className="ui-group-avatar__icon" size={Math.round(size * 0.48)} aria-hidden="true" /><span className="ui-group-avatar__initial" aria-hidden="true">{initial}</span></>}
  </span>;
}

export function SegmentedControl({ value, onChange, options, label }) {
  return <div className="ui-segments" role="group" aria-label={label}>{options.map((option) => <button key={option.value} className={value === option.value ? 'is-selected' : ''} onClick={() => onChange(option.value)} type="button">{option.label}</button>)}</div>;
}

export function ListRow({ selected = false, onClick, title, subtitle, leading, trailing, children }) {
  return <button type="button" className={cx('ui-list-row', selected && 'is-selected')} onClick={onClick}>{leading && <span className="ui-list-row__leading">{leading}</span>}<span className="ui-list-row__content"><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}{children}</span>{trailing && <span className="ui-list-row__trailing">{trailing}</span>}</button>;
}

export function SectionHeader({ eyebrow, title, description, actions }) {
  return <header className="section-header"><div>{eyebrow && <span className="section-header__eyebrow">{eyebrow}</span>}<h2>{title}</h2>{description && <p>{description}</p>}</div>{actions && <div className="section-header__actions">{actions}</div>}</header>;
}

export function EmptyState({ title, description, action }) {
  return <div className="ui-state"><strong>{title}</strong>{description && <p>{description}</p>}{action}</div>;
}

export function LoadingState({ label = '正在加载…' }) {
  return <div className="ui-state ui-state--loading"><LoaderCircle className="ui-spin" size={20} /><span>{label}</span></div>;
}

export function ErrorState({ title = '加载失败', message, onRetry }) {
  return <div className="ui-state ui-state--error"><AlertTriangle size={20} /><strong>{title}</strong>{message && <p>{message}</p>}{onRetry && <Button size="sm" onClick={onRetry}>重试</Button>}</div>;
}

export function ConfirmDialog({ open, title, description, confirmLabel = '确认', tone = 'danger', busy = false, onConfirm, onCancel }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onCancel]);
  if (!open) return null;
  return <div className="ui-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}><section className="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title"><div className="ui-dialog__icon"><AlertTriangle size={20} /></div><div className="ui-dialog__body"><div className="ui-dialog__heading"><h2 id="confirm-dialog-title">{title}</h2><IconButton label="关闭" icon={X} onClick={onCancel} disabled={busy} /></div><p>{description}</p><div className="ui-dialog__actions"><Button onClick={onCancel} disabled={busy}>取消</Button><Button variant={tone} loading={busy} onClick={onConfirm}>{confirmLabel}</Button></div></div></section></div>;
}
