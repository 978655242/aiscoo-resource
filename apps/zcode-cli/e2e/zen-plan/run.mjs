// Aiscoo Zen Plan 完整端到端验收：真实 Go New API（隔离实例）+ 真实 Chrome + 真实 CLI 构建产物 + 真实 PTY TUI。
// 用法：node run.mjs --backend <new-api binary> [--case=<name>]...
import { access, constants, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { authorizeInBrowser, enableTotp, launchBrowser, nativeLogin, newSession, registerPasskey, switchAccountAndAuthorize } from "./browser.mjs";
import { CLI_BUNDLE, assertNoSecrets, createDevice, redact, runCli, sleep, startJsonLogin, startTui } from "./cli.mjs";
import {
  ACCEPTANCE_MARKER, ACCEPTANCE_MODEL_ID, assignPlan, createAcceptanceRoot, initializeAccounts, removeAcceptanceRoot,
  revokePlan, seedCatalog, sessionsFor, setOptionsAndRestart, startDelayingProxy, startIsolatedBackend, startSyntheticUpstream,
} from "./environment.mjs";
import { cleanupKeychainEntries } from "./keychain.mjs";

const { values } = parseArgs({ options: { backend: { type: "string" }, case: { type: "string", multiple: true }, keep: { type: "boolean" } } });
if (!values.backend) throw new Error("--backend <path to isolated new-api binary> is required");

const results = [];
const CASE_TIMEOUT_MS = 240_000;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const activeSessions = (backend, user, client) => sessionsFor(backend, user).filter((session) => session.client_id === client && !session.revoked_at);

async function jsonLogin(context, device, account, method = "password", session) {
  const login = startJsonLogin(device);
  const url = await login.authorizeUrl;
  const authorizeUrl = new URL(url);
  check(authorizeUrl.origin === context.backend.origin, "authorize URL uses the configured origin");
  check(authorizeUrl.searchParams.get("client_id") === "xwork-cli", "authorize URL uses the CLI client id");
  check(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/.test(authorizeUrl.searchParams.get("redirect_uri")), "redirect is the literal loopback callback");
  check(authorizeUrl.searchParams.get("code_challenge_method") === "S256", "PKCE S256");
  const browserSession = session ?? (await newSession(context.browser));
  const browserResult = await authorizeInBrowser(browserSession, url, { account, method });
  const result = await login.exited;
  if (!session) await browserSession.close();
  check(result.code === 0, `login zen exits 0 (got ${result.code}: ${redact(result.stderr)})`);
  const output = JSON.parse(result.stdout);
  check(output.status === "ready" && output.provider === "zen", "login JSON reports ready zen");
  assertNoSecrets("login stdout", result.stdout);
  assertNoSecrets("login stderr", result.stderr.replace(/"url":"[^"]+"/, ""));
  return { output, browserResult, stderr: result.stderr };
}

async function prompt(device, text, extra = []) {
  const result = await runCli(device, ["--prompt", text, "--json", "--mode", "yolo", ...extra]).exited;
  assertNoSecrets("prompt stdout", result.stdout);
  return result;
}

async function selectZenModel(device) {
  // 与用户用 /model 选择后的持久结果一致：只把非秘密选择写入 Personal Config。
  const { writeFile } = await import("node:fs/promises");
  await writeFile(device.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, JSON.stringify({ schemaVersion: 1, config: { defaultModelSelection: { providerId: "account:aiscoo-openai-chat-completions", modelId: ACCEPTANCE_MODEL_ID, options: { reasoningLevel: "none" } } } }));
}

const cases = {
  // 1. 原生密码登录 → 浏览器主动授权 → CLI 回环；凭据仅以加密形式落盘。
  async "password-login-and-secure-storage"(context) {
    const device = await createDevice(context.root, "password", context.backend.origin);
    const { browserResult } = await jsonLogin(context, device, context.accounts.alice);
    check(browserResult.loginRequired, "browser required native login");
    check(/aiscoo zen(?:（CLI）| \(CLI\))/.test(browserResult.pageText), "authorization page identifies aiscoo zen CLI");
    check(activeSessions(context.backend, "alice", "xwork-cli").length === 1, "exactly one active xwork-cli SID for alice");
    const files = await readdir(device.credentialDirectory);
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const content = await readFile(join(device.credentialDirectory, file), "utf8");
      // 修复：原先对整份文件做 /sk-|eyJ|refresh/ 匹配，base64url 密文随机命中率约 10%，导致偶发失败并连锁拖垮后续用例。
      // 改为校验结构：只有加密信封字段，明文 JSON 字段名不得出现，data 是不可解析为 JSON 的密文。
      const record = JSON.parse(content);
      check(JSON.stringify(Object.keys(record).sort()) === JSON.stringify(["data", "iv", "revision", "tag", "version"]), "credential file holds only the encrypted envelope");
      check(!/access_token|refresh_token|relay_credential|session_id/.test(content), "credential file contains no plaintext bundle fields");
      let decodesAsJson = true;
      try { JSON.parse(Buffer.from(record.data, "base64url").toString("utf8")); } catch { decodesAsJson = false; }
      check(!decodesAsJson, "credential payload is ciphertext, not encoded JSON");
      const mode = (await import("node:fs")).statSync(join(device.credentialDirectory, file)).mode & 0o777;
      check(mode === 0o600, `credential file is 0600 (got ${mode.toString(8)})`);
    }
    context.devices.password = device;
  },

  // 2. 冷恢复 + 真实 prompt + 真实工具调用往返。
  async "cold-restore-prompt-and-tool-call"(context) {
    const device = context.devices.password;
    await selectZenModel(device);
    const plain = await prompt(device, "Reply with the acceptance marker only.");
    check(plain.code === 0 && plain.stdout.includes(ACCEPTANCE_MARKER), `cold-restored prompt succeeds (${plain.code}: ${redact(plain.stderr.slice(-400))})`);
    const before = context.upstream.requests.length;
    const tool = await prompt(device, "ZEN_TOOL_CALL run the probe.");
    check(tool.code === 0, `tool prompt exits 0 (${redact(tool.stderr.slice(-400))})`);
    check(tool.stdout.includes("tool-ok"), "model received the real Bash tool result and answered");
    const followUp = context.upstream.requests.slice(before).find((request) => JSON.stringify(request.messages).includes("ZEN_TOOL_RESULT_42"));
    check(followUp, "upstream received the tool result produced by the real Bash tool");
  },

  // 3. 模型请求执行中取消：SIGINT 后进程退出，上游连接关闭，账号会话保持可用。
  async "cancel-model-request"(context) {
    const device = context.devices.password;
    const controller = new AbortController();
    const run = runCli(device, ["--prompt", "ZEN_SLOW_STREAM please", "--json"], { signal: controller.signal });
    const deadline = Date.now() + 30_000;
    while (!context.upstream.requests.some((request) => JSON.stringify(request.messages).includes("ZEN_SLOW_STREAM")) && Date.now() < deadline) await sleep(100);
    await sleep(500);
    controller.abort();
    const result = await run.exited;
    check(result.code !== 0 || result.signal, "canceled prompt does not report success");
    const after = await prompt(device, "Reply with the acceptance marker only.");
    check(after.code === 0 && after.stdout.includes(ACCEPTANCE_MARKER), "account still usable after cancel");
  },

  // 4. TUI（真实 PTY）：/login 首项 Zen → 等待态 → 浏览器授权 → 模型可选 → /model 选 Zen → 对话 → /logout zen。
  async "tui-login-model-and-logout"(context) {
    const device = await createDevice(context.root, "tui", context.backend.origin);
    const tui = startTui(device);
    try {
      await tui.waitFor("Type a prompt", 60_000);
      await tui.type("/login");
      await tui.waitFor("Set up a Coding Plan provider");
      await tui.key("enter");
      await tui.waitFor("> Aiscoo Zen Plan");
      await tui.key("enter");
      await tui.waitFor("Waiting for Aiscoo Zen Plan authorization");
      // 屏幕折行随端口/state 长度变化；以 TUI 交给平台浏览器命令的原始 URL 为准，并核对屏幕也展示了同一 URL。
      const url = await device.waitForOpenedUrl();
      const shown = await tui.authorizeUrl();
      const firstDiff = [...url].findIndex((char, index) => shown[index] !== char);
      check(shown === url, `TUI shows the same authorize URL it opened (opened ${url.length} chars, shown ${shown.length}, first diff at ${firstDiff})`);
      const session = await newSession(context.browser);
      const authorization = await authorizeInBrowser(session, url, { account: context.accounts.bob });
      await session.close();
      check(authorization.callbackStatus === 200, `browser delivered the loopback callback (status ${authorization.callbackStatus})`);
      await tui.waitFor(/Signed in to Aiscoo Zen Plan as \S+\. Select a Zen model with \/model\./, 30_000, { inHistory: true });
      await tui.type("/model");
      await tui.key("enter");
      await tui.waitFor(ACCEPTANCE_MODEL_ID, 20_000);
      await tui.type(ACCEPTANCE_MODEL_ID);
      await sleep(300);
      await tui.key("enter");
      await tui.waitFor(/Type a prompt|Build/, 20_000);
      await tui.type("Reply with the acceptance marker only.");
      await tui.key("enter");
      await tui.waitFor(ACCEPTANCE_MARKER, 60_000, { inHistory: true });
      await tui.type("/logout zen");
      await tui.key("enter");
      await tui.waitFor("Signed out of Aiscoo Zen Plan.", 30_000, { inHistory: true });
      check(activeSessions(context.backend, "bob", "xwork-cli").length === 0, "TUI logout revoked bob's CLI SID");
    } finally {
      await tui.close();
    }
  },

  // 5. TUI 等待授权时按 Esc 取消：迟到的浏览器授权不得激活账号，签发的 SID 不残留。
  async "tui-cancel-during-authorization"(context) {
    const device = await createDevice(context.root, "tui-cancel", context.backend.origin);
    const tui = startTui(device);
    try {
      await tui.waitFor("Type a prompt", 60_000);
      await tui.type("/login");
      await tui.waitFor("Set up a Coding Plan provider");
      await tui.key("enter");
      await tui.waitFor("> Aiscoo Zen Plan");
      await tui.key("enter");
      await tui.waitFor("Waiting for Aiscoo Zen Plan authorization");
      const url = await device.waitForOpenedUrl();
      await tui.key("escape");
      await tui.waitFor("Choose a login or API key setup method.");
      const session = await newSession(context.browser);
      await authorizeInBrowser(session, url, { account: context.accounts.carol }).catch(() => undefined);
      await sleep(3000);
      await session.close();
      check(activeSessions(context.backend, "carol", "xwork-cli").length === 0, "late authorization after Esc leaves no active CLI SID");
      check(!(await tui.screen()).includes("Signed in to Aiscoo Zen Plan"), "TUI does not report success after cancel");
    } finally {
      await tui.close();
    }
  },

  // 6. 顶层 login 进程被 SIGINT 中断：监听释放，不留下可用 SID，也不写凭据。
  async "headless-login-interrupted"(context) {
    const device = await createDevice(context.root, "interrupted", context.backend.origin);
    const controller = new AbortController();
    const login = runCli(device, ["login", "zen", "--no-browser", "--json"], { signal: controller.signal, onStderrLine() {} });
    await sleep(2500);
    controller.abort();
    const result = await login.exited;
    check(result.code !== 0, "interrupted login exits non-zero");
    const restore = await runCli(device, ["logout", "zen", "--json"]).exited;
    check(restore.code === 0 && JSON.parse(restore.stdout).localCleared, "no stored session left after interrupt");
  },

  // 6b. 服务端已签发 SID、CLI 尚未提交时收到 SIGINT：必须精确撤销该 SID，不留下孤儿会话。
  async "headless-login-interrupted-after-exchange"(context) {
    const proxy = await startDelayingProxy(context.backend.origin, "/api/xcode/v1/auth/token", 4000);
    try {
      const device = await createDevice(context.root, "interrupted-exchange", proxy.origin);
      const login = startJsonLogin(device);
      const url = await login.authorizeUrl;
      const session = await newSession(context.browser);
      const pending = authorizeInBrowser(session, url, { account: context.accounts.carol });
      await proxy.forwarded;
      check(activeSessions(context.backend, "carol", "xwork-cli").length === 1, "server issued a CLI SID before the interrupt");
      login.child.kill("SIGINT");
      const result = await login.exited;
      await pending.catch(() => undefined);
      await session.close();
      check(result.code !== 0, "interrupted login does not report success");
      await sleep(1500);
      check(activeSessions(context.backend, "carol", "xwork-cli").length === 0, "interrupted login revoked the issued SID");
    } finally {
      await proxy.close();
    }
  },

  // 7. 原生 2FA：TOTP 登录后才可授权 CLI。
  async "two-factor-login"(context) {
    const account = context.accounts.dave;
    const setup = await newSession(context.browser);
    await nativeLogin(setup.page, context.backend.origin, account);
    await enableTotp(setup.page, account);
    await setup.close();
    const device = await createDevice(context.root, "twofa", context.backend.origin);
    const { browserResult } = await jsonLogin(context, device, account);
    check(browserResult.usedTotp, "authorization required the TOTP step");
    check(activeSessions(context.backend, "dave", "xwork-cli").length === 1, "2FA login issued one CLI SID");
  },

  // 8. 原生 Passkey（Chrome 虚拟认证器，localhost RP）。
  async "passkey-login"(context) {
    if (!context.passkeyBackend) throw new Error("passkey backend unavailable");
    const backend = context.passkeyBackend;
    const accounts = context.passkeyAccounts;
    const registration = await newSession(context.browser, { passkeyCredentials: [] });
    await nativeLogin(registration.page, backend.origin, accounts.erin);
    const credentials = await registerPasskey(registration, accounts.erin);
    await registration.close();
    check(credentials.length === 1, "virtual authenticator holds the registered passkey");
    const device = await createDevice(context.root, "passkey", backend.origin);
    const signIn = await newSession(context.browser, { passkeyCredentials: credentials });
    const passkeyContext = { ...context, backend };
    const { browserResult } = await jsonLogin(passkeyContext, device, accounts.erin, "passkey", signIn);
    await signIn.close();
    check(browserResult.loginRequired, "fresh browser required native sign-in");
    check(activeSessions(backend, "erin", "xwork-cli").length === 1, "passkey login issued one CLI SID");
  },

  // 9. 授权页“使用其他账户”：最终授权账号是切换后的账号。
  async "browser-account-switch"(context) {
    const device = await createDevice(context.root, "switch", context.backend.origin);
    const session = await newSession(context.browser);
    await nativeLogin(session.page, context.backend.origin, context.accounts.alice);
    const login = startJsonLogin(device);
    await switchAccountAndAuthorize(session, await login.authorizeUrl, context.accounts.frank);
    const result = await login.exited;
    await session.close();
    check(result.code === 0, `switched login exits 0 (${redact(result.stderr)})`);
    check(JSON.parse(result.stdout).user.username === "frank", "CLI is signed in as the switched account");
  },

  // 10. 两个 CLI 进程：同一设备并发 refresh 单飞；不同设备各自 SID，退出互不影响；换号隔离。
  async "multi-process-and-account-switch"(context) {
    const device = context.devices.password;
    // 让 access token 过期：直接改加密存储不可行，改用服务端立即过期 → 用 refresh 路径；
    // 这里通过两进程同时冷启动 prompt 验证并发恢复/刷新不互相覆盖。
    const results = await Promise.all([prompt(device, "Reply with the acceptance marker only."), prompt(device, "Reply with the acceptance marker only.")]);
    check(results.every((result) => result.code === 0 && result.stdout.includes(ACCEPTANCE_MARKER)), "two concurrent processes on one device both succeed");
    check(activeSessions(context.backend, "alice", "xwork-cli").length === 1, "concurrency did not mint extra SIDs");
    const second = await createDevice(context.root, "second-device", context.backend.origin);
    await jsonLogin(context, second, context.accounts.alice);
    check(activeSessions(context.backend, "alice", "xwork-cli").length === 2, "second device has its own SID");
    const logout = await runCli(second, ["logout", "zen", "--json"]).exited;
    check(logout.code === 0 && JSON.parse(logout.stdout).serverRevoked, "second device logout revoked on server");
    check(activeSessions(context.backend, "alice", "xwork-cli").length === 1, "first device SID untouched");
    const still = await prompt(device, "Reply with the acceptance marker only.");
    check(still.code === 0 && still.stdout.includes(ACCEPTANCE_MARKER), "first device still works");
    // 同一设备换号：被替换的 alice SID 在服务端撤销，新账号生效
    await jsonLogin(context, device, context.accounts.frank);
    check(activeSessions(context.backend, "alice", "xwork-cli").length === 0, "account switch revoked the replaced alice SID");
    const status = await prompt(device, "Reply with the acceptance marker only.");
    check(status.code === 0, "new account usable after switch");
  },

  // 11. 桌面会话（xcode-desktop）与 CLI 共存，各自退出互不影响。
  async "desktop-cli-coexistence"(context) {
    // 前序用例换号时会撤销被替换的 SID；本用例自建 alice 的 CLI 会话，不依赖用例顺序。
    const cliDevice = await createDevice(context.root, "coexistence", context.backend.origin);
    await jsonLogin(context, cliDevice, context.accounts.alice);
    const desktop = await context.desktopLogin(context.accounts.alice);
    const cliBefore = activeSessions(context.backend, "alice", "xwork-cli").length;
    check(cliBefore >= 1, "alice has a CLI session");
    const desktopSessions = () => sessionsFor(context.backend, "alice").filter((session) => (session.client_id === "xcode-desktop" || session.client_id === "") && session.client_purpose === "xcode" && !session.revoked_at);
    check(desktopSessions().length === 1, "desktop SID exists alongside CLI");
    // CLI 不能以桌面客户端身份刷新或退出
    const wrong = await fetch(`${context.backend.origin}/api/xcode/v1/auth/logout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: "xwork-cli", session_id: desktop.session_id, refresh_token: desktop.refresh_token }) });
    check(!wrong.ok, "CLI client id cannot revoke a desktop SID");
    check(desktopSessions().length === 1, "desktop SID survived the wrong-client logout");
    await context.desktopLogout(desktop);
    check(desktopSessions().length === 0, "desktop logout revoked desktop SID");
    check(activeSessions(context.backend, "alice", "xwork-cli").length === cliBefore, "desktop logout did not touch CLI SIDs");
  },

  // 12. 套餐撤销：已登录 CLI 的下一次请求被拒绝且不泄露凭据；重新授予后恢复。
  async "plan-revocation-and-restore"(context) {
    const device = context.devices.password;
    revokePlan(context.backend, "frank");
    const denied = await prompt(device, "Reply with the acceptance marker only.");
    check(denied.code !== 0 && !denied.stdout.includes(ACCEPTANCE_MARKER), "request denied after plan revocation");
    assertNoSecrets("revoked prompt stderr", denied.stderr);
    assignPlan(context.backend, "frank");
    const restored = await prompt(device, "Reply with the acceptance marker only.");
    check(restored.code === 0 && restored.stdout.includes(ACCEPTANCE_MARKER), "request succeeds after plan is reassigned");
  },

  // 13. 服务端撤销 SID（如在网页“登录会话”中退出该设备）：CLI 停止可执行，不伪装成功。
  async "server-side-session-revocation"(context) {
    const device = context.devices.password;
    const db = context.backend.db();
    try {
      db.prepare("UPDATE user_sessions SET status='revoked', revoked_at=?, revoked_reason='e2e' WHERE client_id='xwork-cli' AND user_id=(SELECT id FROM users WHERE username='frank')").run(Math.floor(Date.now() / 1000));
    } finally {
      db.close();
    }
    const denied = await prompt(device, "Reply with the acceptance marker only.");
    check(denied.code !== 0 && !denied.stdout.includes(ACCEPTANCE_MARKER), "revoked SID cannot run model requests");
  },

  // 14. 后端不可用：冷启动不删除凭据；后端恢复后继续可用（不伪装退出）。
  async "backend-outage-recovery"(context) {
    const device = await createDevice(context.root, "outage", context.backend.origin);
    await jsonLogin(context, device, context.accounts.alice);
    await selectZenModel(device);
    await context.backend.stop();
    try {
      const started = Date.now();
      const offline = await prompt(device, "Reply with the acceptance marker only.");
      check(offline.code !== 0, "prompt fails while backend is down");
      check(Date.now() - started < 60_000, `offline prompt fails promptly (${Date.now() - started}ms)`);
    } finally {
      await context.backend.restart();
    }
    const recovered = await prompt(device, "Reply with the acceptance marker only.");
    check(recovered.code === 0 && recovered.stdout.includes(ACCEPTANCE_MARKER), "stored session recovers after outage");
  },

  // 15. 缺少 AISCOO_ADMIN_BASE_URL：不发起授权，给出可操作提示。
  async "missing-origin"(context) {
    const device = await createDevice(context.root, "no-origin", context.backend.origin);
    delete device.env.AISCOO_ADMIN_BASE_URL;
    const result = await runCli(device, ["login", "zen", "--no-browser", "--json"]).exited;
    check(result.code !== 0 && /AISCOO_ADMIN_BASE_URL/.test(result.stderr), "missing origin is rejected with guidance");
    check(!/authorize/.test(result.stderr), "no authorization URL was emitted");
  },

  // 16. Aiscoo 唯一账号策略已取代旧官方退出语义；默认与别名均须精确退出当前 Zen owner。
  async "logout-default-and-aliases"(context) {
    const peer = await createDevice(context.root, "logout-peer", context.backend.origin);
    await jsonLogin(context, peer, context.accounts.alice);
    for (const target of [undefined, "zen", "aiscoo"]) {
      const label = target ?? "default";
      const device = await createDevice(context.root, `logout-${label}`, context.backend.origin);
      const existingSids = new Set(activeSessions(context.backend, "alice", "xwork-cli").map((session) => session.sid));
      await jsonLogin(context, device, context.accounts.alice);
      const owned = activeSessions(context.backend, "alice", "xwork-cli").filter((session) => !existingSids.has(session.sid));
      check(owned.length === 1, `${label} logout fixture owns exactly one new CLI SID`);
      const sid = owned[0].sid;
      const before = sessionsFor(context.backend, "alice");
      const othersBefore = before.filter((session) => session.sid !== sid).map((session) => JSON.stringify(session)).sort();
      check((await readdir(device.credentialDirectory)).filter((name) => name.endsWith(".json")).length === 1, `${label} login persisted one encrypted credential record`);

      const result = await runCli(device, target ? ["logout", target, "--json"] : ["logout", "--json"]).exited;
      check(result.code === 0, `${label} logout succeeds`);
      assertNoSecrets(`${label} logout stdout`, result.stdout);
      assertNoSecrets(`${label} logout stderr`, result.stderr);
      const output = JSON.parse(result.stdout);
      check(output.provider === "zen" && output.localCleared === true && output.serverRevoked === true, `${label} logout confirms local cleanup and server revocation`);
      const after = sessionsFor(context.backend, "alice");
      const revoked = after.find((session) => session.sid === sid);
      check(revoked?.status === "revoked" && revoked.revoked_at > 0, `${label} logout revoked the exact device SID`);
      const othersAfter = after.filter((session) => session.sid !== sid).map((session) => JSON.stringify(session)).sort();
      check(JSON.stringify(othersAfter) === JSON.stringify(othersBefore), `${label} logout preserved every unrelated session`);
      check(!(await readdir(device.credentialDirectory)).some((name) => name.endsWith(".json")), `${label} logout removed the local credential record`);

      const repeated = await runCli(device, ["logout", "zen", "--json"]).exited;
      check(repeated.code === 0, `${label} repeated logout succeeds`);
      assertNoSecrets(`${label} repeated logout stdout`, repeated.stdout);
      assertNoSecrets(`${label} repeated logout stderr`, repeated.stderr);
      const repeatedOutput = JSON.parse(repeated.stdout);
      check(repeatedOutput.provider === "zen" && repeatedOutput.localCleared === true && repeatedOutput.serverRevoked === true, `${label} repeated logout confirms cleanup`);
      check(JSON.stringify(sessionsFor(context.backend, "alice")) === JSON.stringify(after), `${label} repeated logout changes no SID`);
      check(!(await readdir(device.credentialDirectory)).some((name) => name.endsWith(".json")), `${label} repeated logout does not restore credentials`);
    }
    const peerLogout = await runCli(peer, ["logout", "zen", "--json"]).exited;
    check(peerLogout.code === 0 && JSON.parse(peerLogout.stdout).serverRevoked === true, "unrelated device can still revoke its own session");
    assertNoSecrets("peer logout stdout", peerLogout.stdout);
    assertNoSecrets("peer logout stderr", peerLogout.stderr);
  },
};

async function ensurePtyHelper() {
  const helper = join(process.cwd(), "node_modules/node-pty/prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  try {
    await access(helper, constants.X_OK);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error(`node-pty spawn-helper is not executable: chmod +x ${helper}`);
  }
}

async function main() {
  await access(CLI_BUNDLE).catch(() => { throw new Error(`build the CLI first: ${CLI_BUNDLE}`); });
  await ensurePtyHelper();
  const root = await createAcceptanceRoot();
  const upstream = await startSyntheticUpstream();
  const backend = await startIsolatedBackend({ binary: values.backend, root: join(root) });
  const passkeyRoot = join(root, "passkey");
  await (await import("node:fs/promises")).mkdir(passkeyRoot);
  const passkeyBackend = await startIsolatedBackend({ binary: values.backend, root: passkeyRoot, host: "localhost" });
  const browser = await launchBrowser();
  const context = { root, upstream, backend, passkeyBackend, browser, devices: {} };
  try {
    context.accounts = await initializeAccounts(backend, ["alice", "bob", "carol", "dave", "frank"]);
    await seedCatalog(backend, upstream.url);
    for (const user of ["alice", "bob", "carol", "dave", "frank"]) assignPlan(backend, user);
    context.passkeyAccounts = await initializeAccounts(passkeyBackend, ["erin"]);
    await setOptionsAndRestart(passkeyBackend, {
      "passkey.enabled": "true", "passkey.rp_id": "localhost", "passkey.rp_display_name": "Zen E2E",
      "passkey.origins": passkeyBackend.origin, "passkey.allow_insecure_origin": "true", "passkey.user_verification": "preferred",
    });
    context.desktopLogin = (await import("./desktop.mjs")).desktopLoginFactory(context);
    context.desktopLogout = (await import("./desktop.mjs")).desktopLogout(context);
    const selected = values.case?.length ? values.case : Object.keys(cases);
    for (const name of selected) {
      const started = Date.now();
      try {
        let timer;
        await Promise.race([
          cases[name](context),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`case exceeded ${CASE_TIMEOUT_MS}ms`)), CASE_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
        results.push({ name, status: "pass", ms: Date.now() - started });
        console.log(`PASS ${name} (${Date.now() - started}ms)`);
      } catch (error) {
        results.push({ name, status: "fail", ms: Date.now() - started, error: redact(error.message) });
        console.log(`FAIL ${name}: ${redact(error.message)}`);
      }
    }
  } finally {
    await browser.close();
    await backend.dispose().catch(() => undefined);
    await passkeyBackend.dispose().catch(() => undefined);
    await upstream.close();
    await cleanupKeychainEntries(root);
    if (!values.keep) await removeAcceptanceRoot(root);
  }
  const failed = results.filter((result) => result.status === "fail");
  console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  if (failed.length) process.exitCode = 1;
}

await main();
