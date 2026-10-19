import React from 'react';
import { pageHead, grid4 } from '../../lib/protoRender.js';

// 原型的总览上半部分：页头 + hero + 四张数字卡。
// 结构与类名照抄 console/app.js 的 PAGES.overview，只把数字换成 props。
export function ProtoOverview({ repliesToday, groupsRunning, latency, cacheHit, tokensWan, members, model, online, statusText, onRefresh }) {
  const html = pageHead(
    '总览',
    '这台机器人现在在做什么，今天花了多少。',
    '<button class="btn btn-ghost" data-proto-action="refresh">刷新状态</button><button class="btn" data-proto-action="more">更多操作</button>'
  )
    + '<div class="hero"><div><span class="hero-eyebrow">WuxinBot · ' + (online ? '在线' : '未连接') + '</span>'
    + '<h2>今天已经回了 <em>' + repliesToday + '</em> 句话</h2>'
    + '<p>' + groupsRunning + ' 个群在跑 · 平均延迟 ' + latency + ' 秒 · 缓存命中 ' + cacheHit + '%</p></div>'
    + '<div class="hero-side"><div><span>今日 Token</span><b>' + tokensWan + '</b></div>'
    + '<div><span>经验成员</span><b>' + members + '</b></div>'
    + '<div><span>模型</span><b>' + (model || '—') + '</b></div></div></div>'
    + grid4([
      '机器人|' + (online ? '运行中' : '未连接') + '|' + (statusText || 'OneBot'),
      '今日消息|' + repliesToday + '|00:00 至今',
      '今日 Token|' + tokensWan + '|24 小时滚动',
      '经验成员|' + members + '|累计回复'
    ]);

  const onClick = (event) => {
    const action = event.target.closest('[data-proto-action]')?.dataset.protoAction;
    if (!action) return;
    event.preventDefault();
    if (action === 'refresh') onRefresh?.();
  };

  return <div className="proto-shell" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
