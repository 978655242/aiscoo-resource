// XCODE: XWork Zen Plan 的 slash 命令组合层；上游 createCommandCenter 保持原样，其余输入原样委托。
import type { TuiSelectionItem, TuiSubmitPrompt } from "@zcode/tui";
import { PRODUCT_NAME, brandProductText, getZCodeCopy } from "@zcode/i18n";
import { normalizeTuiPromptInput } from "../command-center/metadata.js";
import { createCommandCenter } from "../command-center/create.js";
import { recordSlashCommandInHistory } from "../command-center/history.js";
import { buildLoginSelection, emitLoginAuthorizeMessage, parseApiKeyLoginArgs } from "../command-center/login-flow.js";
import { parseSlashCommand } from "../command-center/slash-commands.js";
import type { CommandCenterDeps } from "../command-center/types.js";
import type { AiscooZenCommandDeps } from "./contract.js";
import { aiscooAccountCommandHelp, projectAiscooSlashHelp } from "./help.js";


export function buildZenLoginItem(locale?: string): TuiSelectionItem {
  const copy = getZCodeCopy(locale).tui.loginSetup;
  const zh = locale === "zh-CN";
  return {
    command: "/login zen",
    id: "zen",
    keywords: ["zen", "xwork", PRODUCT_NAME.toLowerCase(), "plan"],
    // 带 pending 才会进入可 Esc 取消的等待态，并把 abortSignal 传给 Zen 登录。
    pending: {
      cancelStatus: copy.pending.cancelStatus,
      help: copy.pending.help,
      primary: zh ? `等待 ${PRODUCT_NAME} Zen Plan 授权` : `Waiting for ${PRODUCT_NAME} Zen Plan authorization`,
      secondary: zh
        ? "请在本机浏览器完成登录和授权，完成后会自动刷新模型。"
        : "Finish sign-in and authorization in a browser on this computer; models refresh automatically.",
      status: copy.pending.status,
    },
    primary: `${PRODUCT_NAME} Zen Plan`,
    secondary: zh ? "在本机浏览器登录套餐账号" : "Sign in through a browser on this computer",
  };
}

/** 产品登录入口固定只有 Aiscoo；未配置不能恢复为上游账号入口。 */
export function createAiscooCommandCenter(
  deps: CommandCenterDeps,
  zen: AiscooZenCommandDeps | undefined,
): TuiSubmitPrompt {
  // 旧官方 login/logout 即使从别的命令分支触发，也不能绕过产品门禁。
  const rejectOfficial = async (): Promise<never> => { throw new Error(`Use /login zen to sign in to ${PRODUCT_NAME}.`); };
  const upstream = createCommandCenter({ ...deps, login: rejectOfficial, loginBigmodel: rejectOfficial, logout: rejectOfficial });
  return async (input, options) => {
    const promptInput = normalizeTuiPromptInput(input);
    const command = parseSlashCommand(promptInput.text);
    const hasAttachments = (promptInput.attachments?.length ?? 0) > 0;
    if (command?.type !== "known" || hasAttachments) return upstream(input, options);
    const mode = deps.getMode?.();
    const zh = deps.getLocale?.() === "zh-CN";
    if (command.name === "model") {
      await zen?.refreshAccountModels();
      return upstream(input, options);
    }
    if (command.name === "help" && command.args.length > 0) {
      const response = aiscooAccountCommandHelp(command.args);
      if (response) return { mode, response };
    }
    if (command.name === "help" && command.args.length === 0) {
      // 只在上游帮助后追加，不改写上游文案。
      const result = await upstream(input, options);
      return {
        ...result,
        response: `${projectAiscooSlashHelp(result.response)}\n\n${brandProductText(zh ? "XWork Zen Plan：/login zen 登录，/logout zen 退出。" : "XWork Zen Plan: /login zen to sign in, /logout zen to sign out.")}`,
      };
    }
    if (command.name === "login" && command.args.length === 0) {
      const selection = buildLoginSelection(deps.getLocale?.());
      return {
        mode,
        response: zh ? `登录 ${PRODUCT_NAME}，或配置自有 API Key。` : `Sign in to ${PRODUCT_NAME}, or configure your own API key.`,
        selection: { ...selection, items: [buildZenLoginItem(deps.getLocale?.()), ...selection.items.filter((item) => item.id.endsWith("-api-key"))] },
      };
    }
    if (command.name === "login" && !["zen", "aiscoo"].includes(command.args) && !parseApiKeyLoginArgs(command.args)) {
      return { mode, response: zh ? `请使用 /login zen 登录 ${PRODUCT_NAME}。` : `Use /login zen to sign in to ${PRODUCT_NAME}.` };
    }
    if ((command.name === "logout" || (command.name === "login" && !parseApiKeyLoginArgs(command.args))) && !zen) {
      return { mode, response: `Configure AISCOO_ADMIN_BASE_URL to use ${PRODUCT_NAME} account login.` };
    }
    if (command.name === "login" && ["zen", "aiscoo"].includes(command.args)) {
      const result = await zen!.loginZen({
        signal: options.abortSignal,
        onAuthorizeUrl: async (url) =>
          emitLoginAuthorizeMessage(options, url, `${PRODUCT_NAME} Zen Plan`, await deps.getApp()),
      });
      const accountName = result.user.display_name || result.user.username;
      await recordSlashCommandInHistory(deps, promptInput.text, command);
      return {
        loginRequired: false,
        mode,
        response: zh
          ? `已登录 ${PRODUCT_NAME} Zen Plan：${accountName}。${result.modelStatus.available ? "使用 /model 选择 Zen 模型。" : "当前没有可用的 Zen 套餐模型，请检查指定套餐和模型权限。"}`
          : `Signed in to ${PRODUCT_NAME} Zen Plan as ${accountName}. ${result.modelStatus.available ? "Select a Zen model with /model." : result.modelStatus.reason}`,
      };
    }
    if (command.name === "logout" && !["", "zen", "aiscoo"].includes(command.args)) {
      return { mode, response: `Use /logout zen to sign out of ${PRODUCT_NAME}.` };
    }
    if (command.name === "logout") {
      const result = await zen!.logoutZen();
      await recordSlashCommandInHistory(deps, promptInput.text, command);
      return {
        mode,
        response: result.serverRevoked
          ? `Signed out of ${PRODUCT_NAME} Zen Plan.`
          : "Local Zen credentials cleared; server revocation could not be confirmed.",
      };
    }
    return upstream(input, options);
  };
}
