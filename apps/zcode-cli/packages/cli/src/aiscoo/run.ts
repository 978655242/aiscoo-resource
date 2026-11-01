// XCODE: XWork 顶层命令组合层：`login zen` / `logout zen` / 帮助追加在此处理，其余参数原样委托上游 run。
import { formatJson } from "@zcode/core";
import { PRODUCT_NAME, brandProductText, resolveLocale } from "@zcode/i18n";
import type { RunContext } from "@zcode/shared-types";
import { parseGlobalArgs } from "../arguments.js";
import { loadBootstrapModule } from "../bootstrap-loader.js";
import type { BootstrapModule, RunDependencies } from "../cli-types.js";
import { resolveCliCwd } from "../cwd.js";
import { loadCliDotenv } from "../env.js";
import { detectCliLocale } from "../locale.js";
import { run } from "../run.js";
import { registerCliShutdownHandlers } from "../shutdown.js";
import { setZenKeyringModuleLoader } from "@zcode/adapters/auth";
import { loadCliKeyringModule } from "../sea-keyring/index.js";
import { parseSlashCommand } from "../command-center/slash-commands.js";
import { withAiscooTuiCommandCenter } from "./tui-zen.js";

// 撤销请求本身有 15 秒 HTTP 期限；给补偿留出完成时间，超时仍退出不挂起终端。
const ZEN_LOGIN_SHUTDOWN_TIMEOUT_MS = 16_000;

export interface AiscooRunDependencies extends RunDependencies {
  loginZenCli?: BootstrapModule["loginZenCli"];
  logoutZenCli?: BootstrapModule["logoutZenCli"];
}

const zenHelp = {
  "en-US": "\nXWork Zen Plan:\n  login zen [--no-browser]  Sign in to XWork Zen Plan\n  logout zen                Sign out of XWork Zen Plan\n",
  "zh-CN": "\nXWork Zen Plan：\n  login zen [--no-browser]  登录 XWork Zen Plan\n  logout zen                退出 XWork Zen Plan\n",
} as const;

function parseZenInvocation(argv: string[]) {
  let parsed: ReturnType<typeof parseGlobalArgs>;
  try {
    parsed = parseGlobalArgs(argv);
  } catch {
    return null; // 解析错误交给上游输出用法。
  }
  const [name, target, ...rest] = parsed.positionals;
  const isHelp = parsed.values.help === true || (name === "help" && target === undefined);
  if (isHelp) return { command: "help" as const, values: parsed.values };
  const slash = typeof parsed.values.prompt === "string" ? parseSlashCommand(parsed.values.prompt) : null;
  const command = slash?.type === "known" && (slash.name === "login" || slash.name === "logout") ? slash.name : name;
  const account = slash?.type === "known" && (slash.name === "login" || slash.name === "logout") ? slash.args : target;
  if (command === "login" || command === "logout") {
    if (rest.length > 0 || (account && !["zen", "aiscoo"].includes(account)))
      return { command: "unsupported" as const, values: parsed.values };
    return { command, values: parsed.values };
  }
  return null;
}

/** 覆盖 stdout.write 只追加帮助，不改上游帮助字符串。 */
function withHelpAppended(ctx: RunContext, text: string): RunContext {
  const stdout = Object.create(ctx.stdout) as NodeJS.WriteStream;
  let appended = false;
  stdout.write = ((chunk: string | Uint8Array, ...args: never[]) => {
    const projected = typeof chunk === "string" ? chunk.replaceAll("login [zai|bigmodel]", "login [zen|aiscoo]") : chunk;
    const result = ctx.stdout.write(projected, ...args);
    if (!appended) {
      appended = true;
      ctx.stdout.write(text);
    }
    return result;
  }) as NodeJS.WriteStream["write"];
  return { ...ctx, stdout };
}

export async function runAiscoo(ctx: RunContext, deps: AiscooRunDependencies = {}): Promise<number> {
  // Zen 安全存储在 SEA 中从内嵌资源加载原生钥匙串绑定；普通 bundle 仍走 node_modules。
  // 放在所有命令前：TUI、--prompt 与 login/logout zen 都可能读取 Zen 凭据。
  setZenKeyringModuleLoader(() => loadCliKeyringModule());
  const invocation = parseZenInvocation(ctx.argv);
  // 产品依赖固定拒绝官方 polling；通用 run 和第三方 MCP OAuth 实现保持原样。
  const rejectOfficial = async (): Promise<never> => { throw new Error(`Use login zen to sign in to ${PRODUCT_NAME}.`); };
  // TUI 命令中心经 RunDependencies 的可选工厂注入，上游 tui-prompt-handler 只做一次可选回退。
  const productDeps = withAiscooTuiCommandCenter({ ...deps, loginZCodeCli: rejectOfficial, loginBigmodelCodingPlan: rejectOfficial, logoutZCodeCli: rejectOfficial });
  if (!invocation) return run(ctx, productDeps);
  const env = deps.env ?? process.env;
  if (invocation.command === "help") {
    // 与上游帮助相同的语言判定：--locale 优先，缺省或 auto 时按环境检测。
    const requested = invocation.values.locale as string | undefined;
    const locale = resolveLocale(requested ?? "auto", detectCliLocale(env));
    return run(withHelpAppended(ctx, brandProductText(zenHelp[locale])), productDeps);
  }
  if (invocation.command === "unsupported") {
    ctx.stderr.write(`Use login zen to sign in to ${PRODUCT_NAME}.\n`);
    return 1;
  }
  const json = invocation.values.json === true;
  try {
    const cwd = resolveCliCwd({
      cwd: deps.cwd ?? process.cwd,
      requestedCwd: invocation.values.cwd as string | undefined,
    });
    const dotenv = (deps.loadDotenv ?? loadCliDotenv)({ cwd, env });
    if (dotenv.error)
      throw new Error(`Failed to load environment file: ${dotenv.path}`, { cause: dotenv.error });
    if (invocation.command === "login") {
      const login = deps.loginZenCli ?? (await loadBootstrapModule()).loginZenCli;
      // 修复：服务端已签发 SID 后 Ctrl+C 若直接终止进程，bootstrap finally 中的精确撤销没有机会执行。
      // 这里把信号转成 abort，并等待补偿完成再退出。
      const interrupt = new AbortController();
      let loginSettled: Promise<void> = Promise.resolve();
      const unregisterShutdown = registerCliShutdownHandlers({
        abort: () => interrupt.abort(new Error("ZEN_AUTH_CANCELED")),
        cleanup: () => loginSettled,
        cleanupTimeoutMs: deps.shutdownCleanupTimeoutMs ?? ZEN_LOGIN_SHUTDOWN_TIMEOUT_MS,
        ...(deps.exitProcess ? { exitProcess: deps.exitProcess } : {}),
        ...(deps.shutdownProcess ? { process: deps.shutdownProcess } : {}),
      });
      // Zen 授权拥有独立回环与 SID，结果不输出凭据路径或 token。
      const loginPromise = login({
        env,
        noBrowser: invocation.values["no-browser"] === true,
        signal: interrupt.signal,
        onAuthorizeUrl: (url) => {
          if (json)
            ctx.stderr.write(`${JSON.stringify({ event: "authorize", provider: "zen", url })}\n`);
          else ctx.stdout.write(`Open on this computer to sign in to ${PRODUCT_NAME} Zen Plan:\n${url}\n`);
        },
      });
      loginSettled = loginPromise.then(
        () => undefined,
        () => undefined,
      );
      let result: Awaited<typeof loginPromise>;
      try {
        result = await loginPromise;
      } finally {
        if (!interrupt.signal.aborted) unregisterShutdown();
      }
      ctx.stdout.write(
        json
          ? formatJson({ status: "ready", provider: "zen", user: result.user })
          : `Signed in to ${PRODUCT_NAME} Zen Plan as ${result.user.display_name || result.user.username}.\nSelect a Zen model with /model.\n`,
      );
      return 0;
    }
    const logout = deps.logoutZenCli ?? (await loadBootstrapModule()).logoutZenCli;
    const result = await logout({ env });
    ctx.stdout.write(
      json
        ? formatJson({ provider: "zen", ...result })
        : result.serverRevoked
          ? `Signed out of ${PRODUCT_NAME} Zen Plan.\n`
          : "Local Zen credentials cleared; server revocation could not be confirmed.\n",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(json ? formatJson({ status: "error", provider: "zen", message }) : `Error: ${message}\n`);
    return 1;
  }
}
