// 真实 Web main/Root + Server 同会话多标签回归；不替换 Root、错误边界或账号服务。
// 运行：PATH=/Users/timo/.nvm/versions/node/v24.14.0/bin:$PATH pnpm exec tsx packages/web/test/e2e/manual-review/pending/aiscoo-browser-connection.mjs
// 可选：--case=same-session|concurrent|pkce|refresh-logout；CHROME_PATH 指定现有 Chrome，不下载浏览器。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertEventually } from "./remote-login-v2.helpers.mjs";

const root = resolve(import.meta.dirname, "../../../../../..");
const chromePath = process.env.CHROME_PATH;
const selectedCase = process.argv.find((value) => value.startsWith("--case="))?.slice(7) ?? "all";
assert.ok(["all", "same-session", "concurrent", "pkce", "refresh-logout"].includes(selectedCase));
const artifacts = await mkdtemp(join(tmpdir(), "aiscoo-browser-connection-"));
const home = join(artifacts, "home");
await mkdir(home);
// 加载 Node 服务与 Vite 前隔离账号、代理与配置路径；仅 Chrome 的公开可执行路径在上面读取。
const isolatedEnv = {
  PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home,
  USERPROFILE: home,
  ZCODE_DATA_BASE_DIR: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_CACHE_HOME: join(home, "cache"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"),
  TMPDIR: artifacts,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  ZCODE_ENV: "test",
};
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, isolatedEnv);
const baselineEntry = process.argv.includes("--baseline-entry")
  ? (await promisify(execFile)("git", ["show", "HEAD:packages/web/src/main.tsx"], { cwd: root }))
      .stdout
  : undefined;
const { createServer: createViteServer } = await import("vite");
const { chromium } = await import("playwright-core");
const { createNativeFixture } = await import("./aiscoo-browser-connection.fixture.mjs");
async function freePort() {
  const listener = createNetServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  assert.ok(![5177, 3030, 3001].includes(port));
  return port;
}
const serverPort = await freePort();
const webPort = await freePort();
const origin = `http://127.0.0.1:${webPort}`;
const native = await createNativeFixture(origin);
const storageKey = `aiscoo:browser-new-api:${encodeURIComponent(native.origin)}:session`;
const pendingKey = `aiscoo:browser-new-api:${encodeURIComponent(native.origin)}:pending`;
Object.assign(process.env, {
  AISCOO_BROWSER_NEW_API: "1",
  AISCOO_ADMIN_BASE_URL: native.origin,
  AISCOO_BROWSER_ORIGIN: origin,
  PORT: String(serverPort),
  ZCODE_BASE_URL: native.origin,
});
let server;
let serverOwner = null;
let nextRequest = 0;
let serverLog = "";
let vite;
let browser;
let activePage;
let phase = "startup";
const results = [];
const pageErrors = [];
const fixtureErrors = [];
const ownerEvents = [];
const reverseEvents = [];
const pendingEvents = [];
const forbiddenRequests = [];
const contexts = new Set();
const pages = new Map();
const replies = new Map();
function host(command = "status") {
  const id = ++nextRequest;
  return new Promise((done, fail) => {
    const timeout = setTimeout(() => {
      replies.delete(id);
      fail(new Error(`Host fixture command timed out: ${command}`));
    }, 10_000);
    replies.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) fail(new Error(message.error));
      else done(message.value);
    });
    server.send({ id, command });
  });
}
async function hostWithModel(modelId) {
  let status;
  for (let attempt = 0; attempt < 150; attempt++) {
    status = await host();
    if (status.catalog.some((model) => model.endsWith(`/${modelId}`))) return status;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(`Native model did not reach the existing Registry: ${JSON.stringify(status)}`);
}
async function startServer() {
  serverOwner = null;
  server = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve(import.meta.dirname, "aiscoo-browser-connection.fixture.mjs"),
      "--host",
    ],
    {
      cwd: root,
      env: {
        ...isolatedEnv,
        AISCOO_BROWSER_NEW_API: "1",
        AISCOO_ADMIN_BASE_URL: native.origin,
        AISCOO_BROWSER_ORIGIN: origin,
        PORT: String(serverPort),
        ZCODE_BASE_URL: native.origin,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
    },
  );
  server.on("error", (error) => fixtureErrors.push(error.message));
  server.on("message", (message) => {
    if (message.type === "reply") {
      replies.get(message.id)?.(message);
      replies.delete(message.id);
    }
    if (message.type === "owner") {
      serverOwner = message.owner;
      ownerEvents.push(message.owner);
    }
    if (message.type === "reverse-rpc") reverseEvents.push(message);
  });
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (data) => {
      serverLog = (serverLog + data).slice(-48_000);
    });
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    assert.equal(server.exitCode, null, "isolated Host exited during startup");
    try {
      ready = (await fetch(`http://127.0.0.1:${serverPort}/api/server-info`)).ok;
    } catch {}
    if (!ready) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, "isolated Host did not become ready");
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, "exit");
  // 只结束本测试新建的进程组，包含 Host 按需派生的 CLI/构建辅助进程。
  if (process.platform === "win32") server.kill("SIGTERM");
  else process.kill(-server.pid, "SIGTERM");
  await exited;
  serverOwner = null;
}
const composer = (page) =>
  page
    .getByTestId("v4-composer-input")
    .locator('[contenteditable="true"]')
    .or(page.locator('[data-testid="v4-composer-input"][contenteditable="true"]'))
    .first();
async function contextFor(config, { seed, userId = "42", probe = false } = {}) {
  const context = await browser.newContext({
    locale: config.locale,
    viewport: { width: config.width, height: config.height },
  });
  contexts.add(context);
  await context.addCookies([{ name: "aiscoo-e2e-user", value: userId, url: native.origin }]);
  await context.exposeBinding("__aiscooE2EPendingChanged", ({ page }, entry) => {
    pendingEvents.push({ ...entry, label: pages.get(page)?.label, locale: config.locale });
  });
  await context.addInitScript(
    ({ theme, seed, storageKey, pendingKey, probe }) => {
      localStorage.setItem("zcode-theme", theme);
      if (seed && !localStorage.getItem("aiscoo-e2e-seeded")) {
        localStorage.setItem(storageKey, JSON.stringify(seed));
        localStorage.setItem("aiscoo-e2e-seeded", "1");
      }
      const setItem = Storage.prototype.setItem;
      const removeItem = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (key, value) {
        setItem.call(this, key, value);
        if (this === sessionStorage && key === pendingKey) {
          const pending = JSON.parse(value);
          void window
            .__aiscooE2EPendingChanged({
              operation: "set",
              state: pending.state,
              verifierLength: pending.codeVerifier.length,
            })
            .catch(() => {});
        }
      };
      Storage.prototype.removeItem = function (key) {
        removeItem.call(this, key);
        if (this === sessionStorage && key === pendingKey)
          void window.__aiscooE2EPendingChanged({ operation: "remove" }).catch(() => {});
      };
      window.__aiscooE2EDocument = crypto.randomUUID();
      window.__aiscooE2ESocketCloses = [];
      window.__aiscooE2EStorageEvents = 0;
      window.__aiscooE2EProbeRequested = probe;
      window.__aiscooE2ELockRequests = 0;
      const requestLock = navigator.locks.request.bind(navigator.locks);
      navigator.locks.request = (...args) => {
        window.__aiscooE2ELockRequests++;
        return requestLock(...args);
      };
      window.addEventListener("storage", () => {
        window.__aiscooE2EStorageEvents++;
      });
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(...args) {
          super(...args);
          this.addEventListener("close", ({ code, reason }) =>
            window.__aiscooE2ESocketCloses.push({ code, reason }),
          );
        }
      };
    },
    { theme: config.theme, seed, storageKey, pendingKey, probe },
  );
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["http:", "https:"].includes(url.protocol) || [origin, native.origin].includes(url.origin))
      return route.continue();
    forbiddenRequests.push(`${url.origin}${url.pathname}`);
    await route.abort();
  });
  return context;
}
async function pageFor(context, label) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(120_000);
  const stats = { label, documents: 0 };
  pages.set(page, stats);
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) stats.documents++;
  });
  page.on("pageerror", (error) => pageErrors.push({ label, message: error.message }));
  activePage = page;
  return page;
}
async function rootUsable(page, draft) {
  activePage = page;
  await page.bringToFront();
  const input = composer(page);
  const onboarding = page.getByTestId("onboarding-page");
  await input.or(onboarding).first().waitFor();
  if (await onboarding.isVisible()) await page.keyboard.press("Escape");
  await input.waitFor();
  await input.fill(draft);
  assert.equal(await input.innerText(), draft);
  assert.equal(await page.getByTestId("aiscoo-web-connection-page").count(), 0);
}
const documentId = (page) => page.evaluate(() => window.__aiscooE2EDocument);
async function unchanged(page, id, draft) {
  activePage = page;
  await page.bringToFront();
  // 两次绘制只作为已收到 storage/WS 事件后的渲染屏障，不用延时猜测握手。
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  assert.equal(await documentId(page), id, "an unrelated tab must not reload this document");
  // 现有 Root 的 workspace preparation 可暂时令 Lexical 只读；草稿保留检查不要求 contenteditable=true。
  assert.equal(
    await page.getByTestId("v4-composer-input").first().innerText(),
    draft,
    "an unrelated tab must not clear this draft",
  );
}
function passed(name, config) {
  results.push({ case: name, ...config, result: "passed" });
  console.log(`PASS ${config.locale} ${name}`);
}
async function loginButton(page) {
  const trigger = page.getByTestId("login-trigger");
  const button = page.getByTestId("oauth-login-button-new-api");
  await button.or(trigger).first().waitFor();
  if (!(await button.isVisible())) {
    await trigger.click();
    await page.getByTestId("login-menu-item").click();
  }
  return button;
}
async function login(page) {
  const before = native.counts.exchange;
  await (await loginButton(page)).click({ noWaitAfter: true });
  await assertEventually(() => native.counts.exchange === before + 1);
  await page.waitForURL((url) => url.origin === origin && url.pathname === "/", {
    waitUntil: "domcontentloaded",
  });
}
async function failureVisible(page, state, config) {
  const failure = page.locator(`[data-testid="aiscoo-web-connection-page"][data-state="${state}"]`);
  await failure.waitFor();
  assert.match(
    await failure.innerText(),
    state === "account-mismatch"
      ? config.locale === "zh-CN"
        ? /账号连接不匹配/
        : /Account connection mismatch/
      : config.locale === "zh-CN"
        ? /与 Aiscoo 的连接已断开/
        : /Connection lost/,
  );
  assert.doesNotMatch(
    await failure.innerText(),
    /synthetic-|Browser account|XCODE_|https?:|ws:\/\//,
  );
  const retry = failure.getByRole("button", {
    name: config.locale === "zh-CN" ? "重试" : "Retry",
    exact: true,
  });
  assert.ok(await retry.isEnabled());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, `${config.locale}-${state}.png`), fullPage: true });
  return retry;
}
async function oauth(page, method, args = [], local = false) {
  return page.evaluate(
    async ({ method, args, local }) => {
      const service = local
        ? window.__aiscooE2EAccount.oauth
        : window.__aiscooE2EServices.oauthService;
      return service[method](...args);
    },
    { method, args, local },
  );
}
const recordFor = (bundle, authGeneration = 1) => ({ schemaVersion: 1, authGeneration, bundle });
async function seedPair(config, label, probe = false) {
  const bundle = native.issue();
  const context = await contextFor(config, { seed: recordFor(bundle), probe });
  const a = await pageFor(context, `${label}-A`);
  const b = await pageFor(context, `${label}-B`);
  await a.goto(origin, { waitUntil: "domcontentloaded" });
  await rootUsable(a, `${label} A draft`);
  await b.goto(origin, { waitUntil: "domcontentloaded" });
  await rootUsable(b, `${label} B draft`);
  return { context, a, b, bundle };
}
async function sameSession(config) {
  const context = await contextFor(config);
  const a = await pageFor(context, "same-A");
  await a.goto(origin, { waitUntil: "domcontentloaded" });
  await login(a);
  await rootUsable(a, "A draft survives B admission");
  const aDoc = await documentId(a);
  const accepted = await hostWithModel("real-model");
  assert.equal(accepted.owner.userId, "42");
  assert.ok(accepted.catalog.some((model) => model.endsWith("/real-model")));
  passed("OAuth callback enters real Root", config);
  const exchanges = native.counts.exchange;
  const b = await pageFor(context, "same-B");
  await b.goto(origin, { waitUntil: "domcontentloaded" });
  await rootUsable(b, "B draft survives A close");
  await unchanged(a, aDoc, "A draft survives B admission");
  assert.equal(native.counts.exchange, exchanges, "same-session B must not exchange another token");
  assert.deepEqual((await host()).owner, accepted.owner);
  assert.equal(
    (await host()).hookEvents.filter(Boolean).length,
    accepted.hookEvents.filter(Boolean).length,
  );
  await a.screenshot({
    path: join(artifacts, `${config.locale}-same-session-A.png`),
    fullPage: true,
  });
  await b.screenshot({
    path: join(artifacts, `${config.locale}-same-session-B.png`),
    fullPage: true,
  });
  passed("same-session A/B both enter real Root without another exchange or owner hook", config);
  const traces = () =>
    reverseEvents.filter((event) => event.command === "oauth" && event.method === "cancelPending");
  let before = traces().length;
  await oauth(a, "cancelPending", ["new-api"]);
  await assertEventually(() => traces().length > before);
  const aSource = traces().at(-1).connectionId;
  before = traces().length;
  await oauth(b, "cancelPending", ["new-api"]);
  await assertEventually(() => traces().length > before);
  assert.notEqual(traces().at(-1).connectionId, aSource, "per-WS OAuth must return to its caller");
  passed("forward OAuth uses each tab's own reverse channel", config);
  await b.reload({ waitUntil: "domcontentloaded" });
  await rootUsable(b, "B draft survives A close");
  await unchanged(a, aDoc, "A draft survives B admission");
  const afterReload = await host();
  assert.deepEqual(afterReload.owner, accepted.owner);
  assert.deepEqual(afterReload.catalog, accepted.catalog);
  assert.equal(
    afterReload.hookEvents.filter(Boolean).length,
    accepted.hookEvents.filter(Boolean).length,
  );
  assert.equal(native.counts.exchange, exchanges);
  passed("ordinary B reload preserves admitted A document, draft, owner and catalog", config);

  const cContext = await contextFor(config, { userId: "84", probe: true });
  const c = await pageFor(cContext, "mismatch-C");
  await c.goto(origin, { waitUntil: "domcontentloaded" });
  const cExchanges = native.counts.exchange;
  await login(c);
  assert.equal(
    native.counts.exchange,
    cExchanges + 1,
    "C must finish its own real authorization callback",
  );
  const retry = await failureVisible(c, "account-mismatch", config);
  await c.waitForFunction(() => window.__aiscooE2EBusinessProbe === "rejected");
  assert.equal(await composer(c).count(), 0);
  assert.ok(
    await c.evaluate(() =>
      window.__aiscooE2ESocketCloses.some(
        ({ code, reason }) => code === 1008 && reason === "Browser account does not match",
      ),
    ),
  );
  assert.deepEqual((await host()).owner, accepted.owner);
  assert.deepEqual((await host()).catalog, accepted.catalog);
  const rejectedDoc = await documentId(c);
  passed(
    "different user finishes local PKCE but cannot borrow existing Root or business RPC",
    config,
  );

  const originalBundle = native.sessions.get(accepted.owner.sid).bundle;
  for (const [label, seed] of [
    ["different-SID", recordFor(native.issue(), accepted.owner.authGeneration)],
    [
      "different-generation",
      recordFor(
        originalBundle,
        accepted.owner.authGeneration === Number.MAX_SAFE_INTEGER
          ? 1
          : accepted.owner.authGeneration + 1,
      ),
    ],
  ]) {
    const otherContext = await contextFor(config, { seed, probe: true });
    const other = await pageFor(otherContext, label);
    await other.goto(origin, { waitUntil: "domcontentloaded" });
    await failureVisible(other, "account-mismatch", config);
    await other.waitForFunction(() => window.__aiscooE2EBusinessProbe === "rejected");
    assert.deepEqual((await host()).owner, accepted.owner);
    assert.deepEqual((await host()).catalog, accepted.catalog);
    await otherContext.close();
    contexts.delete(otherContext);
  }
  passed("same user with different SID or generation is rejected without changing owner", config);
  const bDoc = await documentId(b);
  await a.close();
  await unchanged(b, bDoc, "B draft survives A close");
  assert.deepEqual((await host()).owner, accepted.owner);
  assert.deepEqual((await host()).catalog, accepted.catalog);
  assert.equal(
    (await host()).hookEvents.filter(Boolean).length,
    accepted.hookEvents.filter(Boolean).length,
    "closing A must not repeat the owner hook",
  );
  passed("closing A preserves B document, draft, Host owner and catalog", config);
  await b.reload({ waitUntil: "domcontentloaded" });
  await rootUsable(b, "B restores after ordinary reload");
  assert.deepEqual((await host()).owner, accepted.owner);
  assert.equal(await documentId(c), rejectedDoc, "a rejected account never retries automatically");
  passed("B reload recovers without accepting or reloading rejected C", config);
  await context.close();
  contexts.delete(context);
  await assertEventually(() => serverOwner === null);
  await retry.click();
  await rootUsable(c, "C Retry restores its own Root after final owner release");
  const cStatus = await hostWithModel("c-model");
  assert.equal(cStatus.owner.userId, "84");
  assert.ok(cStatus.catalog.some((model) => model.endsWith("/c-model")));
  assert.ok(!cStatus.catalog.some((model) => model.endsWith("/real-model")));
  passed("explicit Retry admits C with its own catalog only after the last A/B release", config);
  await stopServer();
  const reconnect = await failureVisible(c, "disconnected", config);
  await startServer();
  await reconnect.click();
  await rootUsable(c, "C restores after Host restart");
  assert.equal((await host()).owner.userId, "84");
  passed("disconnect and Host restart retain visible Retry and restore real Root", config);
  await c.screenshot({ path: join(artifacts, `${config.locale}-root.png`), fullPage: true });
}
async function concurrent(config) {
  const bundle = native.issue();
  const context = await contextFor(config, { seed: recordFor(bundle), probe: true });
  const a = await pageFor(context, "concurrent-A");
  const b = await pageFor(context, "concurrent-B");
  native.gates.me.hold((entry) => entry.sessionId === bundle.session_id);
  const beforeMe = native.gates.me.entered.length;
  await host("hold-owner-hook");
  await Promise.all([
    a.goto(origin, { waitUntil: "domcontentloaded" }),
    b.goto(origin, { waitUntil: "domcontentloaded" }),
  ]);
  await assertEventually(
    () =>
      native.gates.me.entered
        .slice(beforeMe)
        .filter((entry) => entry.sessionId === bundle.session_id).length >= 2,
  );
  native.gates.me.release();
  let state;
  for (let attempt = 0; attempt < 150; attempt++) {
    state = await host();
    if (
      state.attachments.filter((entry) => entry.status === "pending").length >= 2 &&
      state.hookEvents.some((owner) => owner?.sid === bundle.session_id)
    )
      break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(
    state.hookEvents.filter((owner) => owner?.sid === bundle.session_id).length,
    1,
    "first concurrent restore must share exactly one owner hook",
  );
  await a.waitForFunction(() => window.__aiscooE2EBusinessProbe === "pending");
  await b.waitForFunction(() => window.__aiscooE2EBusinessProbe === "pending");
  assert.equal(await a.evaluate(() => window.__aiscooE2EBusinessProbe), "pending");
  assert.equal(await b.evaluate(() => window.__aiscooE2EBusinessProbe), "pending");
  await host("release-owner-hook");
  await rootUsable(a, "concurrent A Root");
  await rootUsable(b, "concurrent B Root");
  assert.equal(
    (await host()).hookEvents.filter((owner) => owner?.sid === bundle.session_id).length,
    1,
  );
  await a.waitForFunction(() => window.__aiscooE2EBusinessProbe === "resolved");
  await b.waitForFunction(() => window.__aiscooE2EBusinessProbe === "resolved");
  passed(
    "initial concurrent restores share one hook and expose business RPC only after acceptance",
    config,
  );
}
async function pkce(config) {
  const context = await contextFor(config);
  const a = await pageFor(context, "pkce-A");
  const b = await pageFor(context, "pkce-B");
  await Promise.all([
    a.goto(origin, { waitUntil: "domcontentloaded" }),
    b.goto(origin, { waitUntil: "domcontentloaded" }),
  ]);
  await loginButton(a);
  const button = await loginButton(b);
  const before = native.gates.authorize.entered.length;
  const beforePending = pendingEvents.length;
  native.gates.authorize.hold();
  await button.click({ noWaitAfter: true });
  await assertEventually(() => native.gates.authorize.entered.length > before);
  const bPending = () =>
    pendingEvents
      .slice(beforePending)
      .filter((entry) => entry.label === "pkce-B" && entry.locale === config.locale);
  await assertEventually(() => bPending().some((entry) => entry.operation === "set"));
  const pending = bPending().find((entry) => entry.operation === "set");
  assert.equal(pending.verifierLength, 43);
  assert.equal(pending.state, native.authorizations.at(-1).state);
  assert.equal(await a.evaluate((key) => sessionStorage.getItem(key), pendingKey), null);
  await oauth(a, "cancelPending", ["new-api"], true);
  await a.close();
  // B 正在等待导航响应，不能 page.evaluate 等新 document；从真实存储调用观测其 proof 未被 A 消费。
  assert.equal(bPending().filter((entry) => entry.operation === "set").length, 1);
  const beforeCallbackRemovals = bPending().filter((entry) => entry.operation === "remove");
  assert.ok(
    beforeCallbackRemovals.length <= 1,
    "B's initial start may clear an earlier empty pending slot only",
  );
  native.gates.authorize.release();
  await rootUsable(b, "B callback survives another tab's cancellation and close");
  assert.equal(await b.evaluate((key) => sessionStorage.getItem(key), pendingKey), null);
  assert.equal((await host()).owner.userId, "42");
  passed("B owns PKCE proof; cancelling and closing A cannot consume B's callback", config);
}
async function refreshLogout(config) {
  const { a, b, bundle } = await seedPair(config, "rotation");
  const initial = await hostWithModel("real-model");
  const aDoc = await documentId(a);
  const bDoc = await documentId(b);
  const refreshBefore = native.counts.refresh;
  native.gates.refresh.hold((entry) => entry.sessionId === bundle.session_id);
  const rotatingA = oauth(a, "refreshToken", ["new-api"]);
  await assertEventually(() => native.counts.refresh === refreshBefore + 1);
  const bLockRequests = await b.evaluate(() => window.__aiscooE2ELockRequests);
  const rotatingB = oauth(b, "refreshToken", ["new-api"]);
  await b.waitForFunction((before) => window.__aiscooE2ELockRequests > before, bLockRequests);
  native.gates.refresh.release();
  await Promise.all([rotatingA, rotatingB]);
  assert.equal(
    native.counts.refresh,
    refreshBefore + 1,
    "the existing Web Lock serializes one shared rotation",
  );
  await unchanged(a, aDoc, "rotation A draft");
  await unchanged(b, bDoc, "rotation B draft");
  assert.deepEqual((await host()).owner, initial.owner);
  assert.deepEqual((await host()).catalog, initial.catalog);
  assert.equal(
    (await host()).hookEvents.filter(Boolean).length,
    initial.hookEvents.filter(Boolean).length,
  );
  passed("normal token rotation preserves complete owner and both documents and drafts", config);

  native.gates.me.hold((entry) => entry.sessionId === bundle.session_id);
  const readsBefore = native.gates.me.entered.length;
  const lateRestore = oauth(b, "restoreCachedSessionState").then(
    () => "resolved",
    () => "cancelled",
  );
  await assertEventually(() => native.gates.me.entered.length > readsBefore);
  native.gates.logout.hold((entry) => entry.sessionId === bundle.session_id);
  const logoutBefore = native.counts.logout;
  const bNavigations = pages.get(b).documents;
  const logout = oauth(a, "logout", ["new-api"]).then(
    () => "resolved",
    () => "cancelled",
  );
  await assertEventually(() => native.counts.logout === logoutBefore + 1 && serverOwner === null);
  await loginButton(b);
  assert.notEqual(await documentId(b), bDoc);
  assert.equal(
    pages.get(b).documents - bNavigations,
    1,
    "owner-changed reloads an admitted page exactly once",
  );
  const cContext = await contextFor(config, { userId: "84" });
  const c = await pageFor(cContext, "after-logout-C");
  await c.goto(origin, { waitUntil: "domcontentloaded" });
  await login(c);
  await rootUsable(c, "new C owner cannot be overwritten by a late old restore");
  const next = await hostWithModel("c-model");
  assert.equal(next.owner.userId, "84");
  native.gates.me.release();
  native.gates.logout.release();
  assert.equal(await lateRestore, "cancelled");
  await logout;
  assert.deepEqual((await host()).owner, next.owner);
  assert.deepEqual((await host()).catalog, next.catalog);
  passed(
    "logout revokes old pages once; a delayed old restore cannot revive or clear the new C owner",
    config,
  );
}

try {
  await startServer();
  vite = await createViteServer({
    root: resolve(root, "packages/web"),
    configFile: resolve(root, "packages/web/vite.config.ts"),
    cacheDir: join(artifacts, "vite-cache"),
    logLevel: "error",
    plugins: [
      {
        name: "aiscoo-browser-e2e-observers",
        enforce: "pre",
        load(id) {
          if (baselineEntry && id === resolve(root, "packages/web/src/main.tsx"))
            return baselineEntry;
        },
        transform(code, id) {
          const file = id.split("?")[0];
          // 只暴露真实对象供测试调用公开操作，保留完整生产实现和返回值；不替换 Root/服务。
          if (file === resolve(root, "packages/client/src/websocket.ts")) {
            const target = "return new RemoteServiceAccess(client, options);";
            assert.ok(code.includes(target), "forward service observation point moved");
            return code.replace(
              target,
              `const services = new RemoteServiceAccess(client, options);
            globalThis.__aiscooE2EServices = services;
            if (globalThis.__aiscooE2EProbeRequested) {
              globalThis.__aiscooE2EBusinessProbe = 'pending';
              void services.modelSelectionService.getView().then(
                () => { globalThis.__aiscooE2EBusinessProbe = 'resolved'; },
                () => { globalThis.__aiscooE2EBusinessProbe = 'rejected'; });
            }
            return services;`,
            );
          }
          if (file === resolve(root, "packages/web/src/aiscoo-browser-account/account.ts")) {
            const target = "export function createBrowserAiscooAdminAccount(";
            assert.ok(code.includes(target), "browser account observation point moved");
            return (
              code.replace(target, "function createObservedBrowserAiscooAdminAccount(") +
              `
            export function createBrowserAiscooAdminAccount(options) {
              const account = createObservedBrowserAiscooAdminAccount(options);
              globalThis.__aiscooE2EAccount = account;
              return account;
            }`
            );
          }
        },
      },
    ],
    server: { host: "127.0.0.1", port: webPort, strictPort: true, hmr: false },
    optimizeDeps: { include: ["@pierre/diffs/worker/worker.js"] },
  });
  await vite.listen();
  browser = await chromium.launch({
    ...(chromePath ? { executablePath: chromePath } : { channel: "chrome" }),
    headless: true,
  });
  for (const config of [
    { locale: "zh-CN", theme: "zai-light", width: 1440, height: 960 },
    { locale: "en-US", theme: "zai-dark", width: 390, height: 844 },
  ]) {
    for (const [name, run] of [
      ["same-session", sameSession],
      ["concurrent", concurrent],
      ["pkce", pkce],
      ["refresh-logout", refreshLogout],
    ]) {
      if (selectedCase !== "all" && selectedCase !== name) continue;
      phase = `${config.locale}/${name}`;
      try {
        await run(config);
      } catch (error) {
        if (activePage && !activePage.isClosed()) {
          await activePage
            .screenshot({ path: join(artifacts, "failure.png"), fullPage: true })
            .catch(() => {});
          console.error(
            "Visible page:",
            (
              await activePage
                .locator("body")
                .innerText()
                .catch(() => "unavailable")
            ).slice(0, 4000),
          );
        }
        throw error;
      } finally {
        for (const item of Object.values(native.gates)) item.release();
        await host("release-owner-hook").catch(() => {});
        for (const context of contexts) await context.close();
        contexts.clear();
        await assertEventually(() => serverOwner === null);
      }
    }
  }
  assert.equal(native.counts.inference, 0);
  assert.deepEqual(native.errors, []);
  assert.deepEqual(fixtureErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(forbiddenRequests, []);
  console.log(`Passed ${results.length} real Root/browser connection checks`);
} catch (error) {
  console.error(`Failed phase: ${phase}`, error);
  process.exitCode = 1;
} finally {
  for (const item of Object.values(native.gates)) item.release();
  await browser?.close();
  await vite?.close();
  await stopServer();
  await native.close();
  await writeFile(join(artifacts, "server.log"), serverLog);
  await writeFile(
    join(artifacts, "results.json"),
    JSON.stringify(
      {
        selectedCase,
        phase,
        results,
        counts: native.counts,
        ownerEvents,
        reverseEvents,
        pendingStorageEvents: pendingEvents.map(({ state: _state, ...entry }) => entry),
        nativeRequests: native.requests,
        fixtureErrors: [...fixtureErrors, ...native.errors],
        pageErrors,
        forbiddenRequests,
      },
      null,
      2,
    ),
  );
  console.log(`Evidence: ${artifacts}`);
}
