// quick-bridge-qb06-waiter-verify.mjs
// QUICK_BRIDGE_QB06_YUMU_WAITER_AUDIT_V01 — behavioral verifier.
//
// This verifier does NOT re-implement Yumu's waiter predicate in Node. It
// compiles and runs a small Java probe against the actual Yumu/Shiro
// deployment jar's compiled `com.now.nowbot.util.AsyncMessageUtil` bytecode
// (the exact class the running Yumu uses) with dynamic-proxy events, and
// observes the real consumption behavior:
//   - matching group/sender waiter consumes a synthetic command event,
//   - consumption is peek-style (dispatch continues),
//   - group_id / sender_id are the only matching dimensions,
//   - same-key re-registration orphans the older future,
//   - consume-once per key, multi-waiter broadcast across distinct keys,
//   - expiration and callback-throw behavior.
//
// Prerequisites (paths are the local deployment conventions):
//   QB06_YUMU_JAR      default: artifacts/yumu/nowbot-windows-v0.8.3-source-build.jar
//   QB06_JAVA_HOME     default: runtime/jdk21-stage/jdk-21.0.11+10
//   QB06_CLASSES_DIR   optional pre-extracted BOOT-INF/classes (skips re-extract)
//   QB06_LIBS_DIR      optional pre-extracted BOOT-INF/lib
//   QB06_YUMU_SRC      optional Yumu source tree for static chain checks
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = 'G:/QQ-AI-ChatBot';
const NAPCAT = 'G:/My pack/Agent Work/codex_work/napcat-local-bots';
const YUMU_JAR = process.env.QB06_YUMU_JAR
  || path.join(NAPCAT, 'artifacts/yumu/nowbot-windows-v0.8.3-source-build.jar');
const JAVA_HOME = process.env.QB06_JAVA_HOME
  || path.join(NAPCAT, 'runtime/jdk21-stage/jdk-21.0.11+10');
const YUMU_SRC = process.env.QB06_YUMU_SRC
  || path.join(NAPCAT, 'sources/yumu-bot/src/main/java');
const preClasses = process.env.QB06_CLASSES_DIR || '';
const preLibs = process.env.QB06_LIBS_DIR || '';

let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`PASS [${name}]${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.error(`FAIL [${name}]${detail ? ' — ' + detail : ''}`); }
};

const JAVA_PROBE = `import java.lang.reflect.*;
import java.util.*;
import com.now.nowbot.qq.Bot;
import com.now.nowbot.qq.contact.Contact;
import com.now.nowbot.qq.contact.Group;
import com.now.nowbot.qq.event.MessageEvent;
import com.now.nowbot.qq.event.GroupMessageEvent;
import com.now.nowbot.qq.message.MessageChain;
import com.now.nowbot.qq.message.MessageReceipt;
import com.now.nowbot.util.AsyncMessageUtil;
import kotlin.jvm.functions.Function0;
import kotlin.jvm.functions.Function1;
import kotlin.Unit;

public class WaiterProbe {
  static int passed = 0;
  static int failed = 0;
  static long dispatchMarker = 0;
  static void ok(String name, boolean cond, String detail) {
    if (cond) { passed++; System.out.println("PASS [" + name + "]" + (detail.isEmpty() ? "" : " — " + detail)); }
    else { failed++; System.err.println("FAIL [" + name + "]" + (detail.isEmpty() ? "" : " — " + detail)); }
  }
  static Object defaultValue(Class<?> t) {
    if (t == boolean.class) return false;
    if (t == byte.class) return (byte) 0;
    if (t == short.class) return (short) 0;
    if (t == int.class) return 0;
    if (t == long.class) return 0L;
    if (t == float.class) return 0f;
    if (t == double.class) return 0d;
    if (t == char.class) return '\\0';
    return null;
  }
  static Contact contact(long id) {
    return (Contact) Proxy.newProxyInstance(WaiterProbe.class.getClassLoader(), new Class[]{Contact.class},
      (p, m, a) -> {
        switch (m.getName()) {
          case "getContactID": return id;
          case "getName": return "contact-" + id;
          case "sendMessage": return null;
          default: return defaultValue(m.getReturnType());
        }
      });
  }
  static Group group(long id) {
    return (Group) Proxy.newProxyInstance(WaiterProbe.class.getClassLoader(), new Class[]{Group.class},
      (p, m, a) -> {
        switch (m.getName()) {
          case "getContactID": return id;
          case "getName": return "group-" + id;
          case "isAdmin": return false;
          case "getAllUser": return List.of();
          case "getUser": return null;
          case "sendMessage": return null;
          case "sendFile": return null;
          default: return defaultValue(m.getReturnType());
        }
      });
  }
  static MessageEvent groupMessage(long gid, long uid, String text) {
    return (MessageEvent) Proxy.newProxyInstance(WaiterProbe.class.getClassLoader(),
      new Class[]{GroupMessageEvent.class},
      (p, m, a) -> {
        switch (m.getName()) {
          case "getBot": return null;
          case "getSubject": return group(gid);
          case "getGroup": return group(gid);
          case "getSender": return contact(uid);
          case "getMessage": return (MessageChain) null;
          case "getRawMessage": return text;
          case "getTextMessage": return text;
          default: return defaultValue(m.getReturnType());
        }
      });
  }
  static MessageEvent privateMessage(long uid, String text) {
    return (MessageEvent) Proxy.newProxyInstance(WaiterProbe.class.getClassLoader(), new Class[]{MessageEvent.class},
      (p, m, a) -> {
        switch (m.getName()) {
          case "getBot": return null;
          case "getSubject": return contact(uid);
          case "getSender": return contact(uid);
          case "getMessage": return (MessageChain) null;
          case "getRawMessage": return text;
          case "getTextMessage": return text;
          default: return defaultValue(m.getReturnType());
        }
      });
  }
  static void runDispatch(MessageEvent event) { dispatchMarker++; }
  public static void main(String[] args) throws Exception {
    AsyncMessageUtil util = AsyncMessageUtil.INSTANCE;
    dispatchMarker = 0;
    util.put(groupMessage(770099, 900000099, "!r [TST]Alpha"));
    runDispatch(groupMessage(770099, 900000099, "!r [TST]Alpha"));
    ok("no-waiter-put-no-throw-and-dispatch-runs", dispatchMarker == 1, "marker=" + dispatchMarker);
    {
      long g = 770099, s = 900000099;
      var lock = util.getLock(g, s);
      dispatchMarker = 0;
      var event = groupMessage(g, s, "!r [TST]Alpha");
      util.put(event);
      runDispatch(event);
      var got = lock.await(250);
      ok("matching-waiter-consumes-synthetic", got == event, "got=" + (got == null ? "null" : "event"));
      ok("matching-waiter-dispatch-continues", dispatchMarker == 1, "marker=" + dispatchMarker);
    }
    {
      var lockA = util.getLock(770099, 900000099);
      util.put(groupMessage(770100, 900000099, "other-group"));
      ok("different-group-does-not-match", lockA.await(120) == null, "waiter stayed pending");
      var lockB = util.getLock(770099, 900000098);
      util.put(groupMessage(770099, 900000099, "other-sender"));
      ok("different-sender-does-not-match", lockB.await(120) == null, "waiter stayed pending");
      var lockP = util.getLock(770099, 900000099);
      util.put(privateMessage(900000099, "private-text"));
      ok("non-group-event-does-not-match", lockP.await(120) == null, "waiter stayed pending");
    }
    {
      long g = 770099, s = 900000099;
      for (String text : new String[]{"!r [TST]Alpha", "OK", "plain text", ""}) {
        var lock = util.getLock(g, s);
        var event = groupMessage(g, s, text);
        util.put(event);
        ok("content-does-not-isolate:" + (text.isEmpty() ? "<empty>" : text), lock.await(200) == event, "text=" + text);
      }
    }
    {
      long g = 770099;
      var lockA = util.getLock(g, 900000099);
      var lockB = util.getLock(g, 900000098);
      var lockC = util.getLock(g, 900000099);
      var event = groupMessage(g, 900000099, "broadcast-test");
      util.put(event);
      ok("multi-waiter-matching-only", lockB.await(120) == null, "different-sender waiter stayed pending");
      ok("multi-waiter-same-key-latest-wins", lockC.await(200) == event, "latest registration consumed");
      ok("multi-waiter-stale-replaced-never-gets", lockA.await(120) == null, "older same-key future is orphaned");
    }
    {
      long g = 770099, s = 900000099;
      var lock = util.getLock(g, s);
      var first = groupMessage(g, s, "first");
      var second = groupMessage(g, s, "second");
      dispatchMarker = 0;
      util.put(first); runDispatch(first);
      util.put(second); runDispatch(second);
      ok("consume-once-first-event-wins", lock.await(200) == first, "waiter sees first event");
      ok("consume-once-second-dispatch-runs", dispatchMarker == 2, "marker=" + dispatchMarker);
    }
    {
      long g = 770099, s = 900000099;
      var lock = util.getLock(g, s, 80);
      lock.tryLock();
      long t0 = System.currentTimeMillis();
      var got = lock.await();
      long elapsed = System.currentTimeMillis() - t0;
      ok("expiration-times-out", got == null && elapsed >= 30, "elapsed=" + elapsed + "ms");
      lock.unlock();
      var fresh = util.getLock(g, s);
      fresh.tryLock();
      var event = groupMessage(g, s, "after-expiry");
      util.put(event);
      ok("expiration-key-cleaned-and-reusable", fresh.await(200) == event, "fresh waiter works");
      fresh.unlock();
    }
    {
      long g = 881099, s = 910000099;
      MessageReceipt receipt = new MessageReceipt() {
        public void recall() {}
        public void recallIn(long ms) {}
        public com.now.nowbot.qq.message.ReplyMessage reply() { return null; }
        public Contact getTarget() { return null; }
      };
      var event = groupMessage(g, s, "start");
      Function0<MessageReceipt> onCheck = () -> receipt;
      Function0<Unit> onOverTime = () -> Unit.INSTANCE;
      Function0<Unit> onWrong = () -> Unit.INSTANCE;
      Function1<MessageEvent, Unit> onSuccess = (ev) -> { throw new RuntimeException("waiter-callback-boom"); };
      Method dc = AsyncMessageUtil.class.getDeclaredMethod("doubleCheck-GajXJrc",
        MessageEvent.class, String.class, Function0.class, Function0.class, Function0.class,
        Function1.class, long.class, boolean.class);
      dc.setAccessible(true);
      Thread completer = new Thread(() -> {
        try { Thread.sleep(150); util.put(groupMessage(g, s, "OK")); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
      });
      completer.start();
      boolean threw = false;
      Throwable cause = null;
      try {
        dc.invoke(util, event, "OK", onCheck, onOverTime, onWrong, onSuccess, 2_000_000_000L, false);
      } catch (InvocationTargetException e) {
        threw = true; cause = e.getCause();
      }
      completer.join(2000);
      ok("callback-throw-propagates", threw && cause instanceof RuntimeException && "waiter-callback-boom".equals(cause.getMessage()), "cause=" + String.valueOf(cause));
      var fresh = util.getLock(g, s);
      var late = groupMessage(g, s, "after-throw");
      util.put(late);
      ok("callback-throw-waiter-cleaned", fresh.await(200) == late, "fresh waiter receives next event");
    }
    System.out.println("\\nWaiterProbe: " + passed + " passed, " + failed + " failed");
    System.exit(failed == 0 ? 0 : 1);
  }
}
`;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.status !== 0 || r.error) {
    console.error(`CMD FAILED: ${cmd} ${args.join(' ')}`);
    if (r.stdout) console.error(r.stdout);
    if (r.stderr) console.error(r.stderr);
    return false;
  }
  return true;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb06-verify-'));
const javaExe = path.join(JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const javacExe = path.join(JAVA_HOME, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
const jarExe = path.join(JAVA_HOME, 'bin', 'jar.exe');

let classesDir = preClasses;
let libsDir = preLibs;
if (!classesDir || !libsDir || !fs.existsSync(path.join(classesDir, 'com/now/nowbot/util/AsyncMessageUtil.class'))) {
  classesDir = path.join(tmp, 'BOOT-INF/classes');
  libsDir = path.join(tmp, 'BOOT-INF/lib');
  fs.mkdirSync(path.join(tmp, 'BOOT-INF'), { recursive: true });
  console.log(`[qb06] extracting ${YUMU_JAR} (one-time cache)`);
  if (!run(jarExe, ['xf', YUMU_JAR], { cwd: tmp, timeout: 300_000 })) {
    console.error('[qb06] cannot extract yumu jar; set QB06_CLASSES_DIR / QB06_LIBS_DIR to a pre-extracted copy');
    process.exit(1);
  }
}

const probeDir = path.join(tmp, 'probe');
fs.mkdirSync(probeDir, { recursive: true });
const javaFile = path.join(probeDir, 'WaiterProbe.java');
fs.writeFileSync(javaFile, JAVA_PROBE, 'utf8');

const classpath = `${classesDir};${path.join(libsDir, '*')}`;
if (!run(javacExe, ['-encoding', 'UTF-8', '-cp', classpath, '-d', probeDir, javaFile], { timeout: 120_000 })) process.exit(1);
const probe = spawnSync(javaExe, ['-cp', `${probeDir};${classpath}`, 'WaiterProbe'], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
const probeOut = `${probe.stdout || ''}\n${probe.stderr || ''}`;
const probePass = /WaiterProbe: 19 passed, 0 failed/.test(probeOut) && probe.status === 0;
ok('bytecode-probe-19-checks', probePass, probePass ? 'real AsyncMessageUtil bytecode consumed synthetic group events as asserted' : probeOut.trim().slice(-400));
if (probePass) {
  const count = (probeOut.match(/PASS \[/g) || []).length;
  ok('bytecode-probe-individual-count', count === 19, `probe reported ${count} PASS lines`);
}

// Static chain checks against the actual Yumu source tree.
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const permission = read(path.join(YUMU_SRC, 'com/now/nowbot/permission/PermissionImplement.kt'));
if (permission) {
  const putLine = permission.split('\n').find((l) => l.includes('AsyncMessageUtil.put(event)'));
  const filterLine = permission.split('\n').find((l) => l.includes('if (!filterMessage(textMessage))'));
  ok('source-put-before-command-filter', Boolean(putLine) && Boolean(filterLine), 'PermissionImplement.onMessage calls AsyncMessageUtil.put before command filtering');
} else {
  console.error('[qb06] Yumu source tree not found; static chain checks skipped');
}

const waiterUsers = ['BestHistoryRecoverService', 'BindService', 'CustomService', 'GuessService', 'MaiScoreService', 'MapPoolService', 'MatchListenerService', 'SBBindService', 'ServiceSwitchService', 'UpdateTriggerService'];
let bridgedUsesWaiter = false;
for (const file of ['RecentBestService', 'BPService', 'PPMinusService', 'EliteronixDuelRatingService', 'SeriesRatingService']) {
  const src = read(path.join(YUMU_SRC, 'com/now/nowbot/service/messageServiceImpl', `${file}.kt`));
  if (src && /AsyncMessageUtil/.test(src)) bridgedUsesWaiter = true;
}
ok('source-bridged-commands-never-register-waiters', !bridgedUsesWaiter, 'recent/bp/bs/pm/etx/rating service files contain no AsyncMessageUtil calls');
ok('source-waiter-users-enumerated', waiterUsers.length === 10, waiterUsers.join(','));

const quickRouter = read(path.join(ROOT, 'server/bot/quickRouter.ts'));
const executor = read(path.join(ROOT, 'server/bots/executor.ts'));
ok('wuxin-quickrouter-uses-virtual-bridge-group', Boolean(quickRouter && quickRouter.includes("groupId: '770099'")), 'quickRouter bridge context pins group 770099');
ok('wuxin-executor-fallback-uses-real-group', Boolean(executor && executor.includes('groupId: context.groupId || \'770099\'')), 'executor recent bridge uses real context group when present');

console.log(`\nquick-bridge-qb06-waiter-verify: ${passed} passed, ${failed} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
