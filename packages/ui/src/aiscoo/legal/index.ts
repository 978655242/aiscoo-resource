import { createElement, type MouseEvent } from "react";
import { AISCOO_ADMIN_PROVIDER_ID, normalizeAiscooAdminOrigin } from "@zcode/shared";
import { PRODUCT_BRAND } from "@zcode/shared/aiscoo-brand";
import { Button } from "@/components/ui/button.js";
import { useOAuth } from "@/hooks/useOAuth.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import type { AiscooAdminLegalLinks, AiscooLegalLinksProps } from "./contract.js";

export type { AiscooLegalLinksProps } from "./contract.js";

/** 接受当前 Host 的完整公开页面对，拒绝任何授权参数、凭据或跨源链接。 */
function publicLegalLinks(
  providers: AiscooLegalLinksProps["providers"],
): AiscooAdminLegalLinks | null {
  const links = providers.find(
    (provider) => provider.id === AISCOO_ADMIN_PROVIDER_ID && provider.enabled,
  )?.legalLinks;
  if (!links) return null;
  try {
    const agreement = new URL(links.userAgreementUrl);
    const privacy = new URL(links.privacyPolicyUrl);
    const origin = normalizeAiscooAdminOrigin(agreement.origin);
    if (
      privacy.origin !== origin ||
      links.userAgreementUrl !== `${origin}/user-agreement` ||
      links.privacyPolicyUrl !== `${origin}/privacy-policy`
    )
      return null;
    return links;
  } catch {
    return null;
  }
}

/** 登录面板传已有 providers；点击只经平台端口打开公开页面。 */
export function AiscooLegalLinks({ providers, placement }: AiscooLegalLinksProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const links = publicLegalLinks(providers);
  if (!links) return null;

  const title = intl.formatMessage({ id: "aiscoo.legal.title" });
  const actions = createElement(
    "nav",
    {
      "aria-label": title,
      className: "flex min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1",
    },
    ...(
      [
        ["userAgreement", links.userAgreementUrl],
        ["privacyPolicy", links.privacyPolicyUrl],
      ] as const
    ).map(([key, url]) =>
      createElement(
        Button,
        {
          key,
          asChild: true,
          variant: "link",
          size: "sm",
          className: "h-auto max-w-full whitespace-normal px-0 text-ui-sm text-foreground-subtle",
        },
        createElement(
          "a",
          {
            href: url,
            target: "_blank",
            rel: "noopener noreferrer",
            onClick: (event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              platform.openExternal(url);
            },
          },
          intl.formatMessage({ id: `aiscoo.legal.${key}` }),
        ),
      ),
    ),
  );

  if (placement === "login") {
    return createElement(
      "div",
      { className: "space-y-1 text-center", "data-aiscoo-legal": "login" },
      actions,
      createElement(
        "p",
        { className: "break-words text-ui-sm text-foreground-subtle" },
        PRODUCT_BRAND.legalOperatorName,
      ),
    );
  }
  return createElement(
    "section",
    { "aria-label": title, "data-aiscoo-legal": "settings" },
    createElement(
      SettingsGroupCard,
      null,
      createElement(SettingsRow, {
        label: title,
        description: PRODUCT_BRAND.legalOperatorName,
        controlLayout: "wide",
        control: actions,
      }),
    ),
  );
}

function LegalSettingsContent() {
  const { providers } = useOAuth();
  return createElement(AiscooLegalLinks, { providers, placement: "settings" });
}

/** 远程工作区会覆盖当前 context；法律信息仍读取窗口本机 Host 的公开配置。 */
export function AiscooLegalSettings() {
  const services = useOptionalBaseWorkspaceServices();
  return services
    ? createElement(ServiceProvider, { services, children: createElement(LegalSettingsContent) })
    : null;
}
