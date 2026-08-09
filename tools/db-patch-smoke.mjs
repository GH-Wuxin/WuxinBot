// One-off smoke-test helper: toggles quick-router config for owner private chat.
// WARNING: store.ts 的生产库守卫会拦截本工具（入口不是 server/index.ts）。
// 除非确属有意改生产库，请先设置 DATA_DIR 指向测试目录；
// 有意操作时设置 ALLOW_PRODUCTION_WRITE=1。
// Usage: tsx tools/db-patch-smoke.mjs enable-private|disable-private
import { ensureStore, updateDb } from '../server/store.ts';

ensureStore();
const patch = process.argv[2];
if (!patch) {
  console.error('usage: db-patch-smoke.mjs enable-private|disable-private');
  process.exit(1);
}

updateDb((db) => {
  if (patch === 'enable-private') {
    // Restore 900000007 to its pre-smoke state (pippi is no longer a member there).
    db.groupBotConfig = db.groupBotConfig || {};
    // Test group: quick router on (delivery may fail — pippi is not a member,
    // but the routing path is what the smoke verifies).
    db.groupBotConfig['900000007'] = { yumu: true, kanon: true, hydrant: true, lazybot: true, quick: true };
    db.groupBotConfig['private'] = { quick: true };
    const testGroup = db.groups?.find((g) => String(g.groupId) === '900000007');
    if (testGroup) testGroup.enabled = true;
    console.log('patched: 900000007 quick on, private quick on');
  } else if (patch === 'disable-private') {
    db.groupBotConfig = db.groupBotConfig || {};
    delete db.groupBotConfig['private'];
    console.log('patched: private quick off');
  } else {
    console.error('unknown patch:', patch);
    process.exit(1);
  }
});
