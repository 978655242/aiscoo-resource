import { beforeEach, expect, it, vi } from "vitest";
import type { OnBeforeRequestListenerDetails, Session, WebRequest } from "electron";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  webRequest: { onBeforeRequest: vi.fn() },
  partitions: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: {},
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) => state.handlers.set(name, handler),
  },
  session: { defaultSession: { webRequest: state.webRequest }, fromPartition: state.partitions },
  webContents: { fromId: () => null },
}));

beforeEach(() => {
  vi.resetModules();
  state.webRequest.onBeforeRequest.mockReset();
  state.partitions.mockReset().mockReturnValue({ webRequest: state.webRequest });
});

import {
  subscribeBeforeRequest,
  subscribeBeforeRequestGuard,
} from "../src/main/observeBeforeRequest.js";

it("网络捕获开关前后保留实际 Native 私有路径 guard，正常请求仍进入捕获", async () => {
  // vi.resetModules 隔离每次捕获 owner/guard 生命周期，必须在重置后加载真实模块。
  const { guardPlanWebviewSession } = await import("../src/main/nativePlanWebviewManager.js");
  const capture = await import("../src/main/resourceManagerNetwork.js");
  const appSession = { webRequest: state.webRequest } as unknown as Session;
  guardPlanWebviewSession(appSession);
  capture.registerResourceManagerNetworkIpc();
  const get = state.handlers.get("zcode:get-network-capture-snapshot")!;
  const request = (url: string) => {
    const callback = vi.fn();
    const listener = state.webRequest.onBeforeRequest.mock.lastCall![1];
    expect(listener).toBeTypeOf("function");
    listener({ url, method: "GET" } as OnBeforeRequestListenerDetails, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    return callback.mock.calls[0]![0];
  };
  const assertPrivateDenied = () => {
    expect(request("https://example.test/xcode/plans?handoff=private")).toEqual({ cancel: true });
    expect(request("https://example.test/api/xcode/v1/web/view")).toEqual({ cancel: true });
  };
  try {
    assertPrivateDenied();
    for (let i = 0; i < 2; i++) {
      capture.startResourceManagerNetwork(7, () => []);
      assertPrivateDenied();
      expect(request("https://example.test/custom")).toEqual({});
      expect(get({ sender: { id: 7 } }).records).toEqual(
        expect.arrayContaining([expect.objectContaining({ url: "https://example.test/custom" })]),
      );
      capture.stopResourceManagerNetwork([]);
      assertPrivateDenied();
      expect(request("https://example.test/custom")).toEqual({});
    }
  } finally {
    capture.stopResourceManagerNetwork([]);
  }
});

it("安全 guard 拒绝优先且回调一次，观测者不能修改决定，停用观测不移除 guard", () => {
  let listener:
    | ((details: OnBeforeRequestListenerDetails, callback: (response: object) => void) => void)
    | null = null;
  const source = {
    onBeforeRequest: vi.fn((filter, next) => {
      listener = filter === null ? null : next;
    }),
  } as unknown as WebRequest;
  const removeDeny = subscribeBeforeRequestGuard(source, ["<all_urls>"], (details) => ({
    cancel: details.url.includes("/private"),
  }));
  const allow = vi.fn(() => ({ cancel: false }));
  const removeAllow = subscribeBeforeRequestGuard(source, ["https://*/*"], allow);
  const observed: string[] = [];
  const removeObserver = subscribeBeforeRequest(source, ["https://*/*"], (details) => {
    observed.push(details.url);
    return { cancel: !details.url.includes("/private") };
  });
  const request = (url: string) => {
    const callback = vi.fn();
    listener!({ url } as OnBeforeRequestListenerDetails, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    return callback.mock.calls[0]![0];
  };
  expect(request("https://example.test/private")).toEqual({ cancel: true });
  expect(allow).toHaveBeenCalledOnce();
  expect(request("https://example.test/public")).toEqual({});
  expect(observed).toEqual(["https://example.test/private", "https://example.test/public"]);
  removeObserver();
  removeObserver();
  expect(request("https://example.test/private")).toEqual({ cancel: true });
  removeDeny();
  expect(request("https://example.test/private")).toEqual({});
  removeAllow();
  expect(listener).toBeNull();
});

it("guard 异常必须 fail closed 且其他 guard/观测者仍运行，非匹配 guard 不阻断请求", () => {
  let listener:
    | ((details: OnBeforeRequestListenerDetails, callback: (response: object) => void) => void)
    | null = null;
  const source = {
    onBeforeRequest: vi.fn((filter, next) => {
      listener = filter === null ? null : next;
    }),
  } as unknown as WebRequest;
  const observer = vi.fn(() => {
    throw new Error("observer unavailable");
  });
  const removeObserver = subscribeBeforeRequest(source, ["<all_urls>"], observer);
  const removeThrowing = subscribeBeforeRequestGuard(source, ["https://private.test/*"], () => {
    throw new Error("policy unavailable");
  });
  const allow = vi.fn(() => ({ cancel: false }));
  const removeAllow = subscribeBeforeRequestGuard(source, ["<all_urls>"], allow);
  const denied = vi.fn();
  listener!({ url: "https://private.test/view" } as OnBeforeRequestListenerDetails, denied);
  expect(denied).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  expect(allow).toHaveBeenCalledOnce();
  expect(observer).toHaveBeenCalledOnce();
  const allowed = vi.fn();
  listener!({ url: "file:///public.txt" } as OnBeforeRequestListenerDetails, allowed);
  expect(allowed).toHaveBeenCalledExactlyOnceWith({});
  expect(observer).toHaveBeenCalledTimes(2);
  removeObserver();
  removeThrowing();
  removeAllow();
});
