import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeAiscooAdminOrigin } from "@zcode/shared";
import {
  AISCOO_ADMIN_BASE_URL_ENV,
  applyCompiledAiscooAccountOrigin,
  applyPackagedAiscooAccountOrigin,
  resolvePackagedAiscooAccountOrigin,
} from "../src/aiscoo-desktop-identity/index.js";
import {
  normalizeAiscooAccountOrigin,
  resolveBuildAiscooAccountOrigin,
} from "../scripts/aiscoo-account-origin.mjs";

const HTTPS_ORIGIN = "https://account.example.test";

function runtime(over: Partial<Parameters<typeof applyPackagedAiscooAccountOrigin>[0]> = {}) {
  return {
    compiledOrigin: HTTPS_ORIGIN,
    hasAiscooChannel: true,
    isPackaged: true,
    env: {} as Record<string, string | undefined>,
    ...over,
  };
}

describe("packaged Aiscoo account origin: runtime application", () => {
  it("packaged build overrides an inherited value, so a user's shell cannot redirect the account service", () => {
    const r = runtime({ env: { [AISCOO_ADMIN_BASE_URL_ENV]: "https://attacker.example.test" } });
    expect(applyPackagedAiscooAccountOrigin(r)).toBe(HTTPS_ORIGIN);
    expect(r.env[AISCOO_ADMIN_BASE_URL_ENV]).toBe(HTTPS_ORIGIN);
  });

  it("packaged build fills the value when nothing was inherited (the Finder launch case)", () => {
    const r = runtime();
    expect(applyPackagedAiscooAccountOrigin(r)).toBe(HTTPS_ORIGIN);
    expect(r.env[AISCOO_ADMIN_BASE_URL_ENV]).toBe(HTTPS_ORIGIN);
  });

  it("unpackaged development runs keep their own environment untouched", () => {
    const r = runtime({
      isPackaged: false,
      env: { [AISCOO_ADMIN_BASE_URL_ENV]: "http://127.0.0.1:3001" },
    });
    expect(applyPackagedAiscooAccountOrigin(r)).toBeUndefined();
    expect(r.env[AISCOO_ADMIN_BASE_URL_ENV]).toBe("http://127.0.0.1:3001");
  });

  it("builds without the Aiscoo channel (generic upstream) never touch the environment", () => {
    const r = runtime({ hasAiscooChannel: false, env: { [AISCOO_ADMIN_BASE_URL_ENV]: "keep" } });
    expect(applyPackagedAiscooAccountOrigin(r)).toBeUndefined();
    expect(r.env[AISCOO_ADMIN_BASE_URL_ENV]).toBe("keep");
  });

  it.each([undefined, "", "   "])(
    "an empty compiled value %j leaves the environment alone",
    (v) => {
      const r = runtime({ compiledOrigin: v, env: { [AISCOO_ADMIN_BASE_URL_ENV]: "keep" } });
      expect(applyPackagedAiscooAccountOrigin(r)).toBeUndefined();
      expect(r.env[AISCOO_ADMIN_BASE_URL_ENV]).toBe("keep");
    },
  );

  it("an invalid compiled value fails closed: it clears the inherited value instead of trusting it", () => {
    const r = runtime({
      compiledOrigin: "http://112.124.202.60:8080",
      env: { [AISCOO_ADMIN_BASE_URL_ENV]: "https://attacker.example.test" },
    });
    expect(applyPackagedAiscooAccountOrigin(r)).toBeUndefined();
    expect(r.env[AISCOO_ADMIN_BASE_URL_ENV]).toBeUndefined();
  });

  it("the resolver itself still reports the stable error code for an invalid compiled value", () => {
    expect(() => resolvePackagedAiscooAccountOrigin("http://112.124.202.60:8080", true)).toThrow(
      "XCODE_ORIGIN_INVALID",
    );
  });

  it("resolver ignores the compiled value without the Aiscoo channel", () => {
    expect(resolvePackagedAiscooAccountOrigin(HTTPS_ORIGIN, false)).toBeUndefined();
  });
});

describe("build-time validator stays identical to the runtime validator", () => {
  // tsup 先打包配置文件，不能导入 TypeScript 校验器，所以两份实现必须由矩阵钉死。
  const matrix = [
    "https://account.example.test",
    "https://account.example.test/",
    "https://Account.Example.test:8443",
    "https://112.124.202.60",
    "https://112.124.202.60:8443",
    "https://112.124.202.60:8443/",
    "https://112.124.202.60:0",
    "https://112.124.202.60:65536",
    "https://112.124.202.60:",
    "https://112.124.202.60:8443/api",
    "http://127.0.0.1:3001",
    "http://localhost:3001",
    "http://[::1]:3001",
    // 非回环 HTTP：服务器当前地址，必须被拒绝。
    "http://112.124.202.60:8080",
    "http://account.example.test",
    // 别名不能冒充回环。
    "http://127.1",
    "http://2130706433",
    "http://0x7f.0.0.1",
    // 凭据、路径、查询、片段、协议。
    "https://user:pass@account.example.test",
    "https://user@account.example.test",
    "https://account.example.test/api",
    "https://account.example.test/?x=1",
    "https://account.example.test/#frag",
    "ftp://account.example.test",
    "javascript:alert(1)",
    "account.example.test",
    "",
    "   ",
  ];

  function outcome(fn: (raw: string) => string) {
    return (raw: string) => {
      try {
        return { ok: true as const, value: fn(raw) };
      } catch {
        return { ok: false as const };
      }
    };
  }

  it.each(matrix)("accepts and rejects %j exactly like the runtime validator", (raw) => {
    expect(outcome(normalizeAiscooAccountOrigin)(raw)).toEqual(
      outcome(normalizeAiscooAdminOrigin)(raw),
    );
  });

  it("covers both outcomes, so the matrix cannot pass vacuously", () => {
    const results = matrix.map((raw) => outcome(normalizeAiscooAdminOrigin)(raw).ok);
    expect(results).toContain(true);
    expect(results).toContain(false);
  });
});

describe("build-time channel policy", () => {
  it("production requires an account origin: a package that cannot log in must not be produced", () => {
    expect(() => resolveBuildAiscooAccountOrigin({ env: {}, channel: "production" })).toThrow(
      /AISCOO_ADMIN_BASE_URL is required/,
    );
    expect(() =>
      resolveBuildAiscooAccountOrigin({
        env: { [AISCOO_ADMIN_BASE_URL_ENV]: "   " },
        channel: "production",
      }),
    ).toThrow(/is required/);
  });

  it("production rejects plain HTTP to the public server address", () => {
    expect(() =>
      resolveBuildAiscooAccountOrigin({
        env: { [AISCOO_ADMIN_BASE_URL_ENV]: "http://112.124.202.60:8080" },
        channel: "production",
      }),
    ).toThrow(/invalid/);
  });

  it("production normalizes a valid HTTPS origin", () => {
    expect(
      resolveBuildAiscooAccountOrigin({
        env: { [AISCOO_ADMIN_BASE_URL_ENV]: " https://Account.Example.test/ " },
        channel: "production",
      }),
    ).toBe("https://account.example.test");
  });

  it("preview is optional but still strictly validated when set", () => {
    expect(resolveBuildAiscooAccountOrigin({ env: {}, channel: "preview" })).toBe("");
    expect(() =>
      resolveBuildAiscooAccountOrigin({
        env: { [AISCOO_ADMIN_BASE_URL_ENV]: "http://example.test" },
        channel: "preview",
      }),
    ).toThrow(/invalid/);
  });

  it("development never compiles an origin, even when the environment has one", () => {
    expect(
      resolveBuildAiscooAccountOrigin({
        env: { [AISCOO_ADMIN_BASE_URL_ENV]: HTTPS_ORIGIN },
        channel: "development",
      }),
    ).toBe("");
  });

  it("an invalid value never leaks into the error message", () => {
    const secret = "https://user:hunter2@account.example.test";
    let message = "";
    try {
      resolveBuildAiscooAccountOrigin({
        env: { [AISCOO_ADMIN_BASE_URL_ENV]: secret },
        channel: "production",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/invalid/);
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("account.example.test");
  });
});

describe("compiled-constant wrapper used by the Main early bootstrap", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the injected constant and channel, then overrides the inherited value", () => {
    vi.stubGlobal("__AISCOO_DESKTOP_CHANNEL__", "production");
    vi.stubGlobal("__AISCOO_ADMIN_BASE_URL__", HTTPS_ORIGIN);
    const env: Record<string, string | undefined> = {
      [AISCOO_ADMIN_BASE_URL_ENV]: "https://attacker.example.test",
    };
    expect(applyCompiledAiscooAccountOrigin({ isPackaged: true, env })).toBe(HTTPS_ORIGIN);
    expect(env[AISCOO_ADMIN_BASE_URL_ENV]).toBe(HTTPS_ORIGIN);
  });

  it("does nothing when the constant was not injected (generic upstream build)", () => {
    vi.stubGlobal("__AISCOO_DESKTOP_CHANNEL__", "production");
    const env: Record<string, string | undefined> = { [AISCOO_ADMIN_BASE_URL_ENV]: "keep" };
    expect(applyCompiledAiscooAccountOrigin({ isPackaged: true, env })).toBeUndefined();
    expect(env[AISCOO_ADMIN_BASE_URL_ENV]).toBe("keep");
  });

  it("does nothing when the Aiscoo channel was not injected, even if a constant exists", () => {
    vi.stubGlobal("__AISCOO_ADMIN_BASE_URL__", HTTPS_ORIGIN);
    const env: Record<string, string | undefined> = { [AISCOO_ADMIN_BASE_URL_ENV]: "keep" };
    expect(applyCompiledAiscooAccountOrigin({ isPackaged: true, env })).toBeUndefined();
    expect(env[AISCOO_ADMIN_BASE_URL_ENV]).toBe("keep");
  });

  it("does nothing in an unpackaged development run", () => {
    vi.stubGlobal("__AISCOO_DESKTOP_CHANNEL__", "development");
    vi.stubGlobal("__AISCOO_ADMIN_BASE_URL__", HTTPS_ORIGIN);
    const env: Record<string, string | undefined> = {
      [AISCOO_ADMIN_BASE_URL_ENV]: "http://127.0.0.1:3001",
    };
    expect(applyCompiledAiscooAccountOrigin({ isPackaged: false, env })).toBeUndefined();
    expect(env[AISCOO_ADMIN_BASE_URL_ENV]).toBe("http://127.0.0.1:3001");
  });
});

describe("the account origin includes its port", () => {
  it("keeps an explicit port exactly as written, in both validators", () => {
    expect(normalizeAiscooAccountOrigin("https://112.124.202.60:8443")).toBe(
      "https://112.124.202.60:8443",
    );
    expect(normalizeAiscooAdminOrigin("https://112.124.202.60:8443")).toBe(
      "https://112.124.202.60:8443",
    );
    expect(normalizeAiscooAccountOrigin("https://112.124.202.60:8443/")).toBe(
      "https://112.124.202.60:8443",
    );
  });

  it("treats the same host on another port as a different origin", () => {
    // 回归依据：账号服务从 443 移到 8443 后，旧包仍指向 443 的官网。服务端 XCODE_PUBLIC_ORIGIN 按整串比较，
    // 所以带端口与不带端口必须是不同的值，不能被归一成同一个。
    expect(normalizeAiscooAccountOrigin("https://112.124.202.60:8443")).not.toBe(
      normalizeAiscooAccountOrigin("https://112.124.202.60"),
    );
  });

  it("compiles and applies the port-bearing origin end to end", () => {
    const origin = resolveBuildAiscooAccountOrigin({
      env: { [AISCOO_ADMIN_BASE_URL_ENV]: "https://112.124.202.60:8443" },
      channel: "production",
    });
    const env: Record<string, string | undefined> = {
      [AISCOO_ADMIN_BASE_URL_ENV]: "https://112.124.202.60",
    };
    expect(
      applyPackagedAiscooAccountOrigin({
        compiledOrigin: origin,
        hasAiscooChannel: true,
        isPackaged: true,
        env,
      }),
    ).toBe("https://112.124.202.60:8443");
    expect(env[AISCOO_ADMIN_BASE_URL_ENV]).toBe("https://112.124.202.60:8443");
  });
});
