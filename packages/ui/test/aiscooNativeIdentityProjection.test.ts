// @vitest-environment jsdom
// XCODE: 保留退役 App 测试中的 Native 身份隔离回归，使用 Aiscoo 独立入口。
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { applyCachedOAuthSessionRestoreResult } from "@/root/oauthCachedSessionRestore.js";

afterEach(cleanup);

describe("Aiscoo Native identity projection", () => {
  it.each(["before-alert", "during-alert"])(
    "does not reopen Native credential recovery after a new login %s",
    async (timing) => {
      let signedOut = timing !== "before-alert";
      const setUser = vi.fn();
      const onReauthenticationRequired = vi.fn();
      const requestAlert = vi.fn(async () => {
        signedOut = false;
        return true;
      });

      await applyCachedOAuthSessionRestoreResult({
        result: {
          status: "unavailable",
          reason: "credential-recovery-required",
        },
        setUser,
        requestAlert,
        onReauthenticationRequired,
        shouldReauthenticate: async () => signedOut,
        copy: { title: "Private credentials need recovery" },
      });

      expect(requestAlert).toHaveBeenCalledTimes(timing === "before-alert" ? 0 : 1);
      expect(setUser).toHaveBeenCalledTimes(timing === "before-alert" ? 0 : 1);
      expect(onReauthenticationRequired).not.toHaveBeenCalled();
    },
  );

  it("Native 退出广播立即清空旧目录，重读失败不能恢复前一个账号候选", async () => {
    let listener: ((next: ModelSelectionView) => void) | undefined;
    let rejectRead: ((error: Error) => void) | undefined;
    const selection = {
      providerId: "account:aiscoo-openai-chat-completions",
      modelId: "m1",
    };
    const nativeView: ModelSelectionView = {
      revision: 1,
      providers: [
        {
          providerId: selection.providerId,
          config: {
            access: {
              type: "new-api-account",
              accountType: "new-api",
              mode: "private-subscription",
              entitled: true,
            },
          },
          models: [{ modelId: selection.modelId, config: {} }],
        },
      ],
    };
    const getView = vi
      .fn()
      .mockResolvedValueOnce(nativeView)
      .mockImplementation(
        () => new Promise<ModelSelectionView>((_resolve, reject) => (rejectRead = reject)),
      );
    const service: IModelSelectionService = {
      getView,
      onDidChange: (callback) => {
        listener = callback;
        return { dispose: vi.fn() };
      },
    };
    const hook = renderHook(() =>
      useModelSelectionServiceView(service, true, "remote-waiting", {
        selection,
      }),
    );
    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
    act(() => listener?.({ revision: 2, providers: [] }));
    expect(hook.result.current.state).toEqual({ status: "loading" });
    await act(async () => rejectRead?.(new Error("signed out")));
    expect(hook.result.current.state).toMatchObject({ status: "error" });
    expect(hook.result.current.state).not.toHaveProperty("catalog");
    hook.unmount();
  });
});
