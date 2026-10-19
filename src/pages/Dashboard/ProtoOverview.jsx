import React from 'react';
import { card, pageHead, grid4 } from '../../lib/protoRender.js';

// 原型的总览上半部分：页头 + hero + 四张数字卡。
// 目前只渲染结构，尚未接进 Dashboard；接入时把 props 换成真实数据即可。
export function ProtoOverview({ repliesToday, groupsRunning, latency, cacheHit, tokensWan, members, model }) {
  const html = pageHead(
    '总览',
    '这台机器人现在在做什么，今天花了多少。',
    '<button class="btn btn-ghost">刷新状态</button><button class="btn">更多操作</button>'
  )
    + '<div class="hero"><div><span class="hero-eyebrow">WuxinBot · 在线</span>'
    + '<h2>今天已经回了 <em>' + repliesToday + '</em> 句话</h2>'
    + '<p>' + groupsRunning + ' 个群在跑 · 平均延迟 ' + latency + ' 秒 · 缓存命中 ' + cacheHit + '%</p></div>'
    + '<div class="hero-side"><div><span>今日 Token</span><b>' + tokensWan + '</b></div>'
    + '<div><span>经验成员</span><b>' + members + '</b></div>'
    + '<div><span>模型</span><b>' + (model || '—') + '</b></div></div></div>'
    + grid4([
      '机器人|运行中|OneBot 已连接',
      '今日消息|' + repliesToday + '|00:00 至今',
      '今日 Token|' + tokensWan + '|24 小时滚动',
      '经验成员|' + members + '|累计回复'
    ]);

  return <div className="proto-shell" dangerouslySetInnerHTML={{ __html: html }} />;
}
