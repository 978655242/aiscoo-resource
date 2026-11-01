import { enUS } from "../locales/en-US.js";
import { zhCN } from "../locales/zh-CN.js";
import { brandCliCopy } from "./index.js";

/** 由 CLI 的下游 Vitest 测试执行，避免将测试框架带入发布声明闭包。 */
export function verifyCliBrandContract(): void {
  const userValue = "XWork ZCode XCode /tmp/XWork https://zcode.z.ai";
  for (const source of [enUS, zhCN]) {
    const branded = brandCliCopy(source);
    if (!branded.cli.help(userValue).startsWith(`Aiscoo ${userValue}\n`)) {
      throw new Error("CLI help must brand the static template before inserting version");
    }
    if (branded.cli.errors.localeUnsupported(userValue) !== source.cli.errors.localeUnsupported(userValue)) {
      throw new Error("CLI error interpolation must preserve user values");
    }
    if (!branded.tui.terminal.starting.includes("Aiscoo")) {
      throw new Error("CLI startup copy must use the shared product brand");
    }
    if (!source.cli.help("").startsWith("XWork ")) {
      throw new Error("Brand assembly must leave the source locale catalog unchanged");
    }
  }
}
