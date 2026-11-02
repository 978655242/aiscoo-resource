import assert from "node:assert/strict";
import test from "node:test";
import { createAiscooCommandCenter, runAiscoo } from "../src/aiscoo/index.js";
import { createCommandCenter } from "../src/command-center.js";
import type { CommandCenterDeps } from "../src/command-center/types.js";

function capture() {
  let output = "";
  const stream = {
    write: (text: string) => {
      output += text;
      return true;
    },
  };
  return { stream, read: () => output, reset: () => (output = "") };
}

test("Zen CLI login and default, alias, headless logout route to the isolated account", async () => {
  const out = capture();
  const ctx = (argv: string[]) => ({ argv, stdout: out.stream, stderr: out.stream }) as never;
  let logoutCalls = 0;
  const deps = {
    env: {},
    loadDotenv: () => ({}),
    loginZenCli: async () => ({ providerId: "zen", user: { id: "1", display_name: "Test" } }),
    logoutZenCli: async () => {
      logoutCalls++;
      return { localCleared: true, serverRevoked: true };
    },
  };
  assert.equal(await runAiscoo(ctx(["login", "zen", "--json", "--no-browser"]), deps as never), 0);
  assert.match(out.read(), /"provider": "zen"/);
  // XCODE: 唯一 Aiscoo 账号策略下，默认退出与别名必须使用同一 Zen owner，不能恢复旧官方退出预期。
  const logoutCommands = [
    ["logout", "--json"],
    ["logout", "zen", "--json"],
    ["logout", "aiscoo", "--json"],
    ["--prompt", "/logout", "--json"],
    ["--prompt", "/logout zen", "--json"],
    ["--prompt", "/logout aiscoo", "--json"],
  ];
  for (const argv of logoutCommands) {
    out.reset();
    const before = logoutCalls;
    assert.equal(await runAiscoo(ctx(argv), deps as never), 0);
    assert.equal(logoutCalls, before + 1);
    assert.deepEqual(JSON.parse(out.read()), { provider: "zen", localCleared: true, serverRevoked: true });
  }
});

test("Zen CLI reports failure with exit code 1 and no stack", async () => {
  const out = capture();
  const deps = {
    env: {},
    loadDotenv: () => ({}),
    logoutZenCli: async () => {
      throw new Error("XCODE_STALE_OWNER");
    },
  };
  const code = await runAiscoo(
    { argv: ["logout", "zen"], stdout: out.stream, stderr: out.stream } as never,
    deps as never,
  );
  assert.equal(code, 1);
  assert.equal(out.read(), "Error: XCODE_STALE_OWNER\n");
});

test("Aiscoo help exposes only product account login", async () => {
  const out = capture();
  const code = await runAiscoo(
    { argv: ["--help", "--locale", "zh-CN"], stdout: out.stream, stderr: out.stream } as never,
    { env: {} } as never,
  );
  assert.equal(code, 0);
  assert.doesNotMatch(out.read(), /login \[zai\|bigmodel\]/);
  assert.match(out.read(), /login \[zen\|aiscoo\]/);
  assert.match(out.read(), /退出 Aiscoo Zen Plan/);
});

const zenDeps = (status = { available: false, reason: "unavailable" }) => ({
  loginZen: async () => ({ user: { username: "test", display_name: "Test" }, modelStatus: status }),
  logoutZen: async () => ({ localCleared: true, serverRevoked: false }),
  refreshAccountModels: async () => {},
});
const baseDeps = (locale: "zh-CN" | "en-US"): CommandCenterDeps => ({
  getApp: async () => {
    throw new Error("unused");
  },
  getLocale: () => locale,
  resumeApp: async () => {
    throw new Error("unused");
  },
});

test("Aiscoo login choices retain manual keys and exclude official OAuth", async () => {
  const upstream = await createCommandCenter(baseDeps("zh-CN"))("/login", {} as never);
  const center = createAiscooCommandCenter(baseDeps("zh-CN"), zenDeps());
  const items = (await center("/login", {} as never)).selection?.items ?? [];
  assert.equal(items[0]?.command, "/login zen");
  // TUI 只为带 pending 的选项保留可取消的等待态；缺失时浏览器授权期间无法 Esc 取消。
  assert.equal(items[0]?.pending?.primary, "等待 Aiscoo Zen Plan 授权");
  assert.ok(items[0]?.pending?.cancelStatus);
  assert.deepEqual(
    items.slice(1).map((item) => item.id),
    upstream.selection?.items.filter((item) => item.id.endsWith("-api-key")).map((item) => item.id),
  );
});

test("without Zen configured the command center cannot fall back to official login", async () => {
  const center = createAiscooCommandCenter(baseDeps("en-US"), undefined);
  const items = (await center("/login", {} as never)).selection?.items ?? [];
  assert.equal(items[0]?.id, "zen");
  assert.equal(items.some((item) => ["zai-coding-plan", "bigmodel-coding-plan"].includes(item.id)), false);
  assert.match((await center("/login zen", {} as never)).response, /AISCOO_ADMIN_BASE_URL/);
});

test("default and headless product login use Zen; legacy targets never call official login", async () => {
  const out = capture();
  let zenCalls = 0;
  let officialCalls = 0;
  const deps = {
    env: {},
    loadDotenv: () => ({}),
    loginZenCli: async () => { zenCalls++; return { user: { display_name: "Test" } }; },
    loginZCodeCli: async () => { officialCalls++; throw new Error("official login called"); },
  };
  for (const argv of [["login"], ["login", "aiscoo"], ["--prompt", "/login"], ["--prompt", "/login zen"]]) {
    assert.equal(await runAiscoo({ argv, stdout: out.stream, stderr: out.stream } as never, deps as never), 0);
  }
  for (const argv of [["login", "zai"], ["login", "bigmodel"], ["--prompt", "/login zai-coding-plan"]]) {
    assert.equal(await runAiscoo({ argv, stdout: out.stream, stderr: out.stream } as never, deps as never), 1);
  }
  assert.equal(zenCalls, 4);
  assert.equal(officialCalls, 0);
});

test("slash login rejects explicit official OAuth and preserves manual API key setup", async () => {
  let officialCalls = 0;
  const center = createAiscooCommandCenter({
    ...baseDeps("en-US"),
    login: async () => { officialCalls++; throw new Error("official login called"); },
    loginBigmodel: async () => { officialCalls++; throw new Error("official login called"); },
    configureApiKey: async () => ({ configPath: "isolated", model: "custom", providerId: "bigmodel" }),
  }, zenDeps());
  for (const provider of ["zai", "bigmodel", "zai-coding-plan", "bigmodel-coding-plan", "authpoll"]) {
    assert.match((await center(`/login ${provider}`, {} as never)).response, /Aiscoo/);
  }
  assert.equal(officialCalls, 0);
  assert.match((await center("/login bigmodel-coding-plan-api-key fake-test-key", {} as never)).response, /Configured BigModel/);
});

test("Zen login explains an unavailable catalog without promising a model", async () => {
  const center = createAiscooCommandCenter(baseDeps("zh-CN"), zenDeps());
  const result = await center("/login zen", {} as never);
  assert.match(result.response, /没有可用的 Zen 套餐模型/);
  assert.doesNotMatch(result.response, /使用 \/model/);
});

test("default and alias TUI logout use the Zen owner and report unconfirmed revocation", async () => {
  let logoutCalls = 0;
  const center = createAiscooCommandCenter(baseDeps("en-US"), {
    ...zenDeps(),
    logoutZen: async () => {
      logoutCalls++;
      return { localCleared: true, serverRevoked: false };
    },
  });
  for (const command of ["/logout", "/logout zen", "/logout aiscoo"]) {
    const before = logoutCalls;
    const result = await center(command, {} as never);
    assert.equal(logoutCalls, before + 1);
    assert.match(result.response, /could not be confirmed/);
    assert.doesNotMatch(result.response, /Signed out/);
  }
});

test("slash /help projects product account help without changing other commands", async () => {
  const upstream = await createCommandCenter(baseDeps("en-US"))("/help", {} as never);
  const center = createAiscooCommandCenter(baseDeps("en-US"), zenDeps());
  const result = await center("/help", {} as never);
  assert.match(result.response, /\/login zen/);
  assert.doesNotMatch(result.response, /login \[zai-coding-plan\||shared Z\.ai/);
  assert.equal(result.response.includes("/compact"), upstream.response.includes("/compact"));
  for (const target of ["login", "logout"]) {
    assert.match((await center(`/help ${target}`, {} as never)).response, /Aiscoo/);
  }
});

// 回归：顶层 login 曾不处理 SIGINT，服务端已签发 SID 后被 Ctrl+C 直接杀死，补偿撤销无机会执行。
test("SIGINT during Zen login aborts the flow and waits for compensation before exiting", async () => {
  const listeners = new Map<string, () => void>();
  const shutdownProcess = {
    platform: "darwin" as NodeJS.Platform,
    once(signal: NodeJS.Signals, listener: () => void) {
      listeners.set(signal, listener);
    },
    off(signal: NodeJS.Signals) {
      listeners.delete(signal);
    },
  };
  let compensated = false;
  const exited = Promise.withResolvers<number>();
  const loginStarted = Promise.withResolvers<void>();
  const compensation = Promise.withResolvers<void>();
  const out = capture();
  // 模拟 bootstrap finally 中对已签发 SID 的异步撤销：由测试控制何时完成。
  const loginZenCli = async (options: { signal?: AbortSignal }) => {
    loginStarted.resolve();
    const { promise, reject } = Promise.withResolvers<never>();
    options.signal?.addEventListener(
      "abort",
      () =>
        void compensation.promise.then(() => {
          compensated = true;
          reject(options.signal?.reason);
        }),
      { once: true },
    );
    return promise;
  };
  const deps = {
    env: {},
    loadDotenv: () => ({}),
    shutdownProcess,
    exitProcess: (code: number) => exited.resolve(code),
    loginZenCli,
  };
  const pending = runAiscoo(
    { argv: ["login", "zen", "--json", "--no-browser"], stdout: out.stream, stderr: out.stream } as never,
    deps as never,
  );
  await loginStarted.promise;
  listeners.get("SIGINT")?.();
  let exitedEarly = false;
  void exited.promise.then(() => (exitedEarly = !compensated));
  compensation.resolve();
  assert.notEqual(await pending, 0);
  assert.equal(await exited.promise, 130);
  assert.equal(compensated, true, "compensation ran");
  assert.equal(exitedEarly, false, "process did not exit before compensation finished");
  assert.equal(listeners.size, 0, "signal handlers are removed afterwards");
});

// XCODE: 上游 tui-prompt-handler 只读取可选的 createTuiCommandCenter；下面两条回归证明产品入口真的注入了它。
test("runAiscoo injects the Aiscoo TUI command center through the optional run dependency", async () => {
  const { withAiscooTuiCommandCenter } = await import("../src/aiscoo/tui-zen.js");
  const refreshReasons: string[] = [];
  let authorizeShown = "";
  const runtime = {
    zenAccount: {
      async login(options: { onAuthorizeUrl?: (url: string) => Promise<void> }) {
        await options.onAuthorizeUrl?.("https://login.example.test/authorize?state=zen");
        return { user: { display_name: "Test User", username: "test-account" } };
      },
      async logout() {
        return { localCleared: true, serverRevoked: true };
      },
    },
    async refreshStandaloneAccount(reason: string) {
      refreshReasons.push(reason);
    },
    async readZenModelStatus() {
      return { available: true, reason: null };
    },
  };
  const deps = withAiscooTuiCommandCenter({
    startProcessProviderRegistryRuntime: (async () => runtime) as never,
  });
  assert.ok(deps.createTuiCommandCenter, "product entry must inject a TUI command center");
  // TUI 启动时由上游 runtime 准备逻辑调用一次；包装后的启动函数必须记下同一 runtime。
  await deps.startProcessProviderRegistryRuntime!({} as never, {} as never);
  const center = deps.createTuiCommandCenter!({
    ...baseDeps("en-US"),
    getApp: async () => ({ sessionId: "zen-session" }) as never,
  });
  const picker = await center("/login", {} as never);
  assert.equal(picker.response, "Sign in to Aiscoo, or configure your own API key.");
  assert.equal(picker.selection?.items[0]?.command, "/login zen");
  const login = await center("/login zen", {
    onEvent: async (event: { payload?: { content?: string } }) => {
      authorizeShown += JSON.stringify(event);
    },
  } as never);
  assert.match(authorizeShown, /login\.example\.test\/authorize/);
  assert.deepEqual(refreshReasons, ["zen-login"]);
  assert.match(login.response, /Signed in to Aiscoo Zen Plan as Test User/);
});

test("without injection the upstream TUI keeps its own command center", async () => {
  const { withAiscooTuiCommandCenter } = await import("../src/aiscoo/tui-zen.js");
  // 上游默认依赖不含工厂；只有经过 runAiscoo 的产品依赖才有。
  assert.equal(({} as import("../src/cli-types.js").RunDependencies).createTuiCommandCenter, undefined);
  assert.equal(typeof withAiscooTuiCommandCenter({}).createTuiCommandCenter, "function");
});
