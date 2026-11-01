import { PRODUCT_NAME } from "@zcode/i18n";

const loginUsage = `/login zen: Sign in to ${PRODUCT_NAME}; /login keeps manual API key setup available.`;
const logoutUsage = `/logout zen: Sign out of ${PRODUCT_NAME}.`;

/** 仅投影产品账号两行，其他上游 slash help 完整保留。 */
export function projectAiscooSlashHelp(text: string): string {
  return text.split("\n").map((line) => {
    if (line.startsWith("- /login ")) return `- ${loginUsage}`;
    if (line.startsWith("- /logout:")) return `- ${logoutUsage}`;
    return line;
  }).join("\n");
}

export function aiscooAccountCommandHelp(target: string): string | undefined {
  const name = target.replace(/^\//, "").toLowerCase();
  return name === "login" ? loginUsage : name === "logout" ? logoutUsage : undefined;
}
