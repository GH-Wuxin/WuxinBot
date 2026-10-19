import React, { useState } from 'react';

// QQ 头像走腾讯图床：群头像按群号，用户头像按 QQ 号；取不到就退回首字圆底。
export const groupAvatarUrl = (groupId, explicit) => {
  if (explicit) return explicit;
  const id = String(groupId || '').trim();
  return /^\d+$/.test(id) ? `https://p.qlogo.cn/gh/${id}/${id}/100` : '';
};

export const userAvatarUrl = (qq, explicit) => {
  if (explicit) return explicit;
  const id = String(qq || '').trim();
  return /^\d{5,12}$/.test(id) ? `https://q1.qlogo.cn/g?b=sdk&nk=${id}&s=100` : '';
};

export function Avatar({ name, src, size = 28, className = '' }) {
  const [failed, setFailed] = useState(false);
  const letter = String(name || '?').slice(0, 1);
  if (!src || failed) {
    return <span className={'avatar ' + className} style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) }}>{letter}</span>;
  }
  return <img
    className={'avatar ' + className}
    src={src}
    alt=""
    width={size}
    height={size}
    loading="lazy"
    referrerPolicy="no-referrer"
    onError={() => setFailed(true)}
    style={{ width: size, height: size, objectFit: 'cover', flex: '0 0 auto' }}
  />;
}
