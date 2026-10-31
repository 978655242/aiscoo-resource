import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";
import type { AiscooLogoutPresentation } from "./contract.js";

const LogoutPresentationContext = createContext<AiscooLogoutPresentation | null>(null);

export function useAiscooLogoutPresentation(): AiscooLogoutPresentation | null {
  return useContext(LogoutPresentationContext);
}

/** 只遮挡旧 Root 的展示，不卸载原退出动作依赖的 effects 或账号 owner。 */
export function AiscooLogoutPresentationBoundary({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const flight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 在子界面 passive effect 注册全局快捷键前建立 capture 门禁；只在已确认退出时生效。
  useLayoutEffect(() => {
    if (!enabled) return;
    const blockBackgroundShortcut = (event: KeyboardEvent) => {
      if (!busyRef.current || event.key === "Tab") return;
      // 过渡窗控仍支持 Enter/Space；其余按键不能落入旧 Root 的 window 快捷键分发。
      const windowControl =
        event.target instanceof Element &&
        event.target.closest('[data-testid="desktop-window-controls"]');
      if (windowControl && (event.key === "Enter" || event.key === " ")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", blockBackgroundShortcut, true);
    return () => window.removeEventListener("keydown", blockBackgroundShortcut, true);
  }, [enabled]);

  const confirmed = useCallback(() => {
    if (!mounted.current || busyRef.current) return;
    busyRef.current = true;
    // 原动作下一步会清空身份并打开登录页，必须在该次同步通知中先提交遮挡。
    flushSync(() => setBusy(true));
  }, []);
  const run = useCallback((action: () => Promise<void>): Promise<void> => {
    if (flight.current) return flight.current;
    const next = Promise.resolve()
      .then(action)
      .then(
        () => {
          // 重启命令返回不等于旧进程结束；成功后保留遮挡，取消则释放本次调用。
          if (!busyRef.current) flight.current = null;
        },
        (error: unknown) => {
          flight.current = null;
          busyRef.current = false;
          if (mounted.current) flushSync(() => setBusy(false));
          throw error;
        },
      );
    flight.current = next;
    return next;
  }, []);
  const isExiting = useCallback(() => busyRef.current, []);
  const presentation = useMemo(() => ({ run, confirmed, isExiting }), [run, confirmed, isExiting]);

  if (!enabled) return children;
  const title = intl.formatMessage({ id: "aiscoo.logout.exiting" });
  return (
    <LogoutPresentationContext.Provider value={presentation}>
      <div
        className="h-full"
        inert={busy ? true : undefined}
        aria-hidden={busy ? true : undefined}
        style={busy ? { visibility: "hidden" } : undefined}
        data-testid="aiscoo-logout-content"
      >
        {children}
      </div>
      <Dialog open={busy}>
        <DialogContent
          data-testid="aiscoo-logout-transition"
          showCloseButton={false}
          overlayClassName="bg-background opacity-100 duration-0 data-open:animate-none data-closed:animate-none"
          className="inset-0 top-0 left-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 bg-background p-0 duration-0 data-open:animate-none data-closed:animate-none"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-12 [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
          <DesktopOverlayWindowControls />
          <RootStartupLoading label={title}>
            <div className="space-y-2 px-6 text-center" aria-live="polite">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                {intl.formatMessage({ id: "aiscoo.logout.description" })}
              </DialogDescription>
            </div>
          </RootStartupLoading>
        </DialogContent>
      </Dialog>
    </LogoutPresentationContext.Provider>
  );
}
