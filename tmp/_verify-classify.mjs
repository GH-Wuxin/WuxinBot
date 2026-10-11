import { failureStickerFor } from '../server/bots/executor.ts';
// 下面这些串全部抄自仓库里的实际抛错点，不是编的。
const CASES = [
  ['osu! 资源不存在 /users/abc', 'no_data', 'api.ts:144 (404)'],
  ['beatmap_score_not_found:12345', 'no_data', 'api.ts:245'],
  ['SHK 没有可用的 BP 数据。', 'no_data', 'collector.ts:55'],
  ['osu! OAuth 凭据未配置。请在环境变量 OSU_CLIENT_ID/OSU_CLIENT_SECRET 中设置，或在 GUI 中填写。', null, 'auth.ts:47 配置缺失'],
  ['PP+ 凭据未配置。', null, 'pplus.ts:32 配置缺失'],
  ['osu! API 请求超时（已自动重试 1 次）', 'service_down', 'api.ts:111'],
  ['osu! API 网络请求失败（已自动重试 1 次）：ECONNRESET', 'service_down', 'api.ts:113'],
  ['osu! API 429 after retries (user 123)', 'service_down', 'recommender.ts:177'],
  ['osu! API 500 /users/abc', 'service_down', 'api.ts:145'],
  ['osu! OAuth token 请求失败 502: bad gateway', 'service_down', 'auth.ts:81'],
  ['PP+ 认证 HTTP 503', 'service_down', 'pplus.ts:34'],
  ['pp 计算服务暂不可用（超时），稍后再试。', 'service_down', 'beatmapCapabilities.ts:84'],
  ['yumu-image 渲染服务不可用（服务端未启动）', 'service_down', 'renderServer.ts:212'],
  ['筛选翻译服务暂时不可用：ECONNREFUSED', 'service_down', 'recommendFilters.ts:377'],
  ['这是一条无关的内部错误', null, '对照：不该挂图'],
];
let pass = 0; const fail = [];
for (const [msg, want, src] of CASES) {
  const got = failureStickerFor(msg);
  const ok = got === want;
  if (ok) pass++; else fail.push(msg.slice(0, 50) + ' -> 得到 ' + got + '，应为 ' + want);
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + String(got ?? 'null').padEnd(13) + src);
}
console.log('');
console.log('  通过 ' + pass + '/' + CASES.length);
for (const f of fail) console.log('    ' + f);