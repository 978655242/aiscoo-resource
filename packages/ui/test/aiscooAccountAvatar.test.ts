// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NEW_API_PROVIDER_ID } from "@zcode/shared";

vi.mock("@/aiscoo/account-avatar/generator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/aiscoo/account-avatar/generator.js")>();
  return {
    ...actual,
    getAccountAvatarDataUri: (id: string) =>
      id.startsWith("collision-") ? "data:image/svg+xml,same" : actual.getAccountAvatarDataUri(id),
  };
});
import { useProfileAvatarFallback } from "@/profile-avatar/index.js";
import {
  AiscooAccountAvatar,
  AiscooAccountAvatarProvider,
  createAiscooAccountAvatarRoot,
  getAccountAvatarDataUri,
} from "@/aiscoo/account-avatar/index.js";

afterEach(cleanup);

function makeOAuthService(providers: string[], activeProvider: string | null) {
  let listener: ((state: "signed-in" | "signed-out") => void) | undefined;
  return {
    getProviders: vi.fn().mockResolvedValue(providers.map((id) => ({ id }))),
    getActiveProvider: vi.fn().mockResolvedValue(activeProvider),
    onDidChangeSession: (next: typeof listener) => {
      listener = next;
      return {
        dispose() {
          listener = undefined;
        },
      };
    },
    emit: (state: "signed-in" | "signed-out") => listener?.(state),
  };
}

describe("XWork account avatar rendering", () => {
  it("falls back to a neutral icon when the generated image cannot decode", () => {
    render(createElement(AiscooAccountAvatar, { userId: "42", label: "Ada" }));
    fireEvent.error(screen.getByRole("img", { name: "Ada" }));
    const fallback = screen.getByRole("img", { name: "Ada" });
    expect(fallback.tagName.toLowerCase()).toBe("svg");
    expect(fallback.getAttribute("src")).toBeNull();
  });

  it("retries the correct image after switching identities and returning to the first user", () => {
    const view = render(createElement(AiscooAccountAvatar, { userId: "42", label: "Ada" }));
    fireEvent.error(screen.getByRole("img", { name: "Ada" }));
    view.rerender(createElement(AiscooAccountAvatar, { userId: "43", label: "Grace" }));
    expect(screen.getByRole("img", { name: "Grace" }).getAttribute("src")).toBe(
      getAccountAvatarDataUri("43"),
    );
    view.rerender(createElement(AiscooAccountAvatar, { userId: "42", label: "Ada renamed" }));
    expect(screen.getByRole("img", { name: "Ada renamed" }).getAttribute("src")).toBe(
      getAccountAvatarDataUri("42"),
    );
  });

  it("retries after switching users whose generated images collide", () => {
    const view = render(
      createElement(AiscooAccountAvatar, { userId: "collision-a", label: "Ada" }),
    );
    fireEvent.error(screen.getByRole("img", { name: "Ada" }));
    view.rerender(createElement(AiscooAccountAvatar, { userId: "collision-b", label: "Grace" }));
    expect(screen.getByRole("img", { name: "Grace" }).tagName.toLowerCase()).toBe("img");
  });

  it("injects the default avatar only after the root service confirms New API", async () => {
    const user = Object.freeze({ id: "42", username: "ada", displayName: "Ada" });
    const oauthService = makeOAuthService([NEW_API_PROVIDER_ID], NEW_API_PROVIDER_ID);
    function Root(_props: { services: { oauthService: typeof oauthService } }) {
      return createElement("div", null, useProfileAvatarFallback(user, "A"));
    }
    const WrappedRoot = createAiscooAccountAvatarRoot(Root);
    render(createElement(WrappedRoot, { services: { oauthService } }));
    expect(screen.getByText("A")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("img", { name: "Ada" }).getAttribute("src")).toBe(
        getAccountAvatarDataUri("42"),
      );
    });
    expect(user).toEqual({ id: "42", username: "ada", displayName: "Ada" });
  });

  it.each(["zai", "bigmodel"])(
    "keeps numeric %s accounts on their original fallback",
    async (id) => {
      const oauthService = makeOAuthService([id], id);
      const user = { id: "42", username: id, displayName: id };
      function Root(_props: { services: { oauthService: typeof oauthService } }) {
        return createElement("div", null, useProfileAvatarFallback(user, "original fallback"));
      }
      const WrappedRoot = createAiscooAccountAvatarRoot(Root);
      render(createElement(WrappedRoot, { services: { oauthService } }));
      await waitFor(() => expect(oauthService.getProviders).toHaveBeenCalled());
      expect(screen.getByText("original fallback")).toBeTruthy();
      expect(screen.queryByRole("img")).toBeNull();
    },
  );

  it("fails closed for mixed provider metadata and invalidates pending active reads", async () => {
    let resolveActive!: (provider: string | null) => void;
    const pending = new Promise<string | null>((resolve) => {
      resolveActive = resolve;
    });
    const oauthService = makeOAuthService([NEW_API_PROVIDER_ID], NEW_API_PROVIDER_ID);
    oauthService.getActiveProvider.mockImplementationOnce(() => pending);
    const user = { id: "42", username: "ada", displayName: "Ada" };
    function Root(_props: { services: { oauthService: typeof oauthService } }) {
      return createElement("div", null, useProfileAvatarFallback(user, "original fallback"));
    }
    const WrappedRoot = createAiscooAccountAvatarRoot(Root);
    render(createElement(WrappedRoot, { services: { oauthService } }));
    await waitFor(() => expect(oauthService.getActiveProvider).toHaveBeenCalledTimes(1));
    oauthService.getProviders.mockResolvedValue([{ id: NEW_API_PROVIDER_ID }, { id: "zai" }]);
    await act(async () => {
      oauthService.emit("signed-out");
      resolveActive(NEW_API_PROVIDER_ID);
      await pending;
    });
    expect(oauthService.getProviders).toHaveBeenCalledTimes(1);
    expect(screen.getByText("original fallback")).toBeTruthy();
    act(() => oauthService.emit("signed-in"));
    await waitFor(() => expect(oauthService.getProviders).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it.each([
    { id: "bigmodel-customer", username: "bigmodel", displayName: "BigModel" },
    { id: "zai-user", username: "zai", displayName: "Zai" },
    { id: "unknown", username: "user", displayName: "User" },
    { id: "042", username: "legacy", displayName: "Legacy" },
  ])("preserves the caller fallback for an unproven identity $id", (user) => {
    function Consumer() {
      return createElement("span", null, useProfileAvatarFallback(user, "original fallback"));
    }
    render(createElement(AiscooAccountAvatarProvider, { children: createElement(Consumer) }));
    expect(screen.getByText("original fallback")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it.each(["", "   "])("uses a neutral icon for missing identity %j", (id) => {
    const user = { id, username: "user", displayName: "User" };
    function Consumer() {
      return createElement("span", null, useProfileAvatarFallback(user, "original fallback"));
    }
    render(createElement(AiscooAccountAvatarProvider, { children: createElement(Consumer) }));
    expect(screen.getByRole("img", { name: "User" }).tagName.toLowerCase()).toBe("svg");
    expect(screen.queryByText("original fallback")).toBeNull();
  });

  it("keeps the wrapped root mounted while the avatar projection changes", async () => {
    const oauthService = makeOAuthService([NEW_API_PROVIDER_ID], NEW_API_PROVIDER_ID);
    const user = { id: "42", username: "ada", displayName: "Ada" };
    function Root(_props: { services: { oauthService: typeof oauthService } }) {
      const [count, setCount] = useState(0);
      return createElement(
        "div",
        null,
        createElement("button", { onClick: () => setCount(count + 1) }, String(count)),
        useProfileAvatarFallback(user, "original fallback"),
      );
    }
    const WrappedRoot = createAiscooAccountAvatarRoot(Root);
    render(createElement(WrappedRoot, { services: { oauthService } }));
    fireEvent.click(screen.getByRole("button", { name: "0" }));
    await waitFor(() => expect(screen.getByRole("img", { name: "Ada" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "1" })).toBeTruthy();
    oauthService.getActiveProvider.mockResolvedValue(null);
    act(() => oauthService.emit("signed-out"));
    expect(screen.getByRole("button", { name: "1" })).toBeTruthy();
  });

  it("drops confirmed New API presentation immediately on sign-out and restores it on sign-in", async () => {
    const oauthService = makeOAuthService([NEW_API_PROVIDER_ID], NEW_API_PROVIDER_ID);
    const user = { id: "42", username: "ada", displayName: "Ada" };
    function Root(_props: { services: { oauthService: typeof oauthService } }) {
      return createElement("div", null, useProfileAvatarFallback(user, "original fallback"));
    }
    const WrappedRoot = createAiscooAccountAvatarRoot(Root);
    render(createElement(WrappedRoot, { services: { oauthService } }));
    await waitFor(() => expect(screen.getByRole("img", { name: "Ada" })).toBeTruthy());
    oauthService.getActiveProvider.mockResolvedValue(null);
    act(() => oauthService.emit("signed-out"));
    expect(screen.getByText("original fallback")).toBeTruthy();
    oauthService.getActiveProvider.mockResolvedValue(NEW_API_PROVIDER_ID);
    act(() => oauthService.emit("signed-in"));
    await waitFor(() => expect(screen.getByRole("img", { name: "Ada" })).toBeTruthy());
  });

  it("keeps the fallback when session events cannot be observed", async () => {
    const oauthService = makeOAuthService([NEW_API_PROVIDER_ID], NEW_API_PROVIDER_ID);
    oauthService.onDidChangeSession = () => {
      throw new Error("subscription unavailable");
    };
    const user = { id: "42", username: "ada", displayName: "Ada" };
    function Root(_props: { services: { oauthService: typeof oauthService } }) {
      return createElement("div", null, useProfileAvatarFallback(user, "original fallback"));
    }
    const WrappedRoot = createAiscooAccountAvatarRoot(Root);
    render(createElement(WrappedRoot, { services: { oauthService } }));
    expect(screen.getByText("original fallback")).toBeTruthy();
    expect(oauthService.getProviders).not.toHaveBeenCalled();
  });

  it("keeps the fallback on provider errors and replaces an old service projection", async () => {
    const first = makeOAuthService([NEW_API_PROVIDER_ID], NEW_API_PROVIDER_ID);
    const second = makeOAuthService(["zai"], "zai");
    const user = { id: "42", username: "ada", displayName: "Ada" };
    function Root(_props: { services: { oauthService: typeof first } }) {
      return createElement("div", null, useProfileAvatarFallback(user, "original fallback"));
    }
    const WrappedRoot = createAiscooAccountAvatarRoot(Root);
    const view = render(createElement(WrappedRoot, { services: { oauthService: first } }));
    await waitFor(() => expect(screen.getByRole("img", { name: "Ada" })).toBeTruthy());
    view.rerender(createElement(WrappedRoot, { services: { oauthService: second } }));
    expect(screen.getByText("original fallback")).toBeTruthy();
    second.getProviders.mockRejectedValueOnce(new Error("unavailable"));
    act(() => second.emit("signed-in"));
    await waitFor(() => expect(second.getProviders).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps the fallback when the active provider read fails or reports no owner", async () => {
    for (const outcome of [new Error("active unavailable"), null] as const) {
      const oauthService = makeOAuthService([NEW_API_PROVIDER_ID], NEW_API_PROVIDER_ID);
      if (outcome instanceof Error) oauthService.getActiveProvider.mockRejectedValue(outcome);
      else oauthService.getActiveProvider.mockResolvedValue(outcome);
      const user = { id: "42", username: "ada", displayName: "Ada" };
      function Root(_props: { services: { oauthService: typeof oauthService } }) {
        return createElement("div", null, useProfileAvatarFallback(user, "original fallback"));
      }
      const WrappedRoot = createAiscooAccountAvatarRoot(Root);
      const view = render(createElement(WrappedRoot, { services: { oauthService } }));
      await waitFor(() => expect(oauthService.getActiveProvider).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(screen.getByText("original fallback")).toBeTruthy();
      expect(screen.queryByRole("img")).toBeNull();
      view.unmount();
    }
  });

  it("does not let an older slow read re-enable the projection after a newer read says no owner", async () => {
    let resolveOld!: (provider: string | null) => void;
    const oldRead = new Promise<string | null>((resolve) => {
      resolveOld = resolve;
    });
    const oauthService = makeOAuthService([NEW_API_PROVIDER_ID], NEW_API_PROVIDER_ID);
    oauthService.getActiveProvider.mockImplementationOnce(() => oldRead);
    const user = { id: "42", username: "ada", displayName: "Ada" };
    function Root(_props: { services: { oauthService: typeof oauthService } }) {
      return createElement("div", null, useProfileAvatarFallback(user, "original fallback"));
    }
    const WrappedRoot = createAiscooAccountAvatarRoot(Root);
    render(createElement(WrappedRoot, { services: { oauthService } }));
    await waitFor(() => expect(oauthService.getActiveProvider).toHaveBeenCalledTimes(1));
    oauthService.getActiveProvider.mockResolvedValue(null);
    act(() => oauthService.emit("signed-in"));
    await waitFor(() => expect(oauthService.getActiveProvider).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveOld(NEW_API_PROVIDER_ID);
      await oldRead;
    });
    expect(screen.getByText("original fallback")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("follows an account switch through sign-out and sign-in without showing the old projection", async () => {
    const oauthService = makeOAuthService([NEW_API_PROVIDER_ID], NEW_API_PROVIDER_ID);
    let currentUser = { id: "42", username: "ada", displayName: "Ada" };
    function Root(_props: { services: { oauthService: typeof oauthService } }) {
      return createElement("div", null, useProfileAvatarFallback(currentUser, "original fallback"));
    }
    const WrappedRoot = createAiscooAccountAvatarRoot(Root);
    const view = render(createElement(WrappedRoot, { services: { oauthService } }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Ada" }).getAttribute("src")).toBe(
        getAccountAvatarDataUri("42"),
      ),
    );
    // 退出事件同步关闭投影；此时即使 UI 仍持有旧用户，也不能继续展示默认头像。
    act(() => oauthService.emit("signed-out"));
    expect(screen.queryByRole("img")).toBeNull();
    currentUser = { id: "43", username: "grace", displayName: "Grace" };
    act(() => oauthService.emit("signed-in"));
    view.rerender(createElement(WrappedRoot, { services: { oauthService } }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Grace" }).getAttribute("src")).toBe(
        getAccountAvatarDataUri("43"),
      ),
    );
    expect(getAccountAvatarDataUri("43")).not.toBe(getAccountAvatarDataUri("42"));
  });

  it("does not commit a late read after unmount", async () => {
    let resolveActive!: (provider: string | null) => void;
    const pending = new Promise<string | null>((resolve) => {
      resolveActive = resolve;
    });
    const oauthService = makeOAuthService([NEW_API_PROVIDER_ID], NEW_API_PROVIDER_ID);
    oauthService.getActiveProvider.mockImplementationOnce(() => pending);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = { id: "42", username: "ada", displayName: "Ada" };
    function Root(_props: { services: { oauthService: typeof oauthService } }) {
      return createElement("div", null, useProfileAvatarFallback(user, "original fallback"));
    }
    const WrappedRoot = createAiscooAccountAvatarRoot(Root);
    const view = render(createElement(WrappedRoot, { services: { oauthService } }));
    await waitFor(() => expect(oauthService.getActiveProvider).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      resolveActive(NEW_API_PROVIDER_ID);
      await pending;
    });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("leaves a caller's anonymous fallback intact even with the product provider", () => {
    function Guest() {
      return createElement("span", null, useProfileAvatarFallback(null, "Signed out"));
    }
    const view = render(
      createElement(AiscooAccountAvatarProvider, { children: createElement(Guest) }),
    );
    expect(view.container.textContent).toBe("Signed out");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
