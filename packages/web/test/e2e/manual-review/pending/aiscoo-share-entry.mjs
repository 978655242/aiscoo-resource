// Aiscoo 分享入口：匿名公开只读保留；受保护/不存在的分享明确不可用，不接受旧 cookie/JWT。
// 上游 share-oauth-callback.mjs 保持原样，Aiscoo 产品断言独立放在本文件，避免同步时冲突。
// 启动：pnpm --filter @zcode/web exec vite --host 127.0.0.1 --port 5178 --strictPort
// 运行：node packages/web/test/e2e/manual-review/pending/aiscoo-share-entry.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { setup } from "./remote-login-v2.helpers.mjs";

const origin = process.env.SHARE_OAUTH_E2E_ORIGIN || "http://127.0.0.1:5178";
const artifacts = resolve(".tmp/aiscoo-share-entry-e2e");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const prefix of ["/share", "/cn/share"])
    for (const status of [200, 401, 404]) {
      const locale = prefix === "/cn/share" ? "zh-CN" : "en-US";
      const h = await setup(browser, { locale, signedIn: true });
      try {
        await h.context.addCookies([{ name: "legacy-session", value: "e2e-old", url: origin }]);
        const requests = [];
        await h.page.route("**/api/v1/shares/*/preview", async (route) => {
          requests.push(route.request().headers());
          await route.fulfill({
            status,
            json:
              status === 200
                ? {
                    code: 0,
                    msg: "",
                    data: {
                      schema_version: 1,
                      share: {
                        title: "AISCOO_PUBLIC_READONLY",
                        access_mode: "public_readonly",
                        created_at: 1,
                        expires_at: 9999999999999,
                      },
                      rows: [],
                      artifacts: [],
                      integrity: {
                        projection_sha256: "a".repeat(64),
                        artifact_set_sha256: "b".repeat(64),
                      },
                    },
                  }
                : { code: 3211, msg: "not_found" },
          });
        });
        await h.page.goto(`${origin}${prefix}/E2E_AISCOO_SHARE`);
        if (status === 200)
          await h.page.getByText("AISCOO_PUBLIC_READONLY", { exact: true }).first().waitFor();
        else
          await h.page
            .getByRole("heading", {
              name: locale === "zh-CN" ? "Aiscoo 登录不可用" : "Aiscoo sign-in unavailable",
            })
            .waitFor();
        assert.equal(requests.length, 1);
        assert.equal(requests[0].authorization, undefined);
        assert.equal(requests[0].cookie, undefined);
        assert.doesNotMatch(await h.page.locator("body").innerText(), /Z\.ai|BigModel/);
        assert.equal(await h.page.locator("[data-share-login-provider]").count(), 0);
        assert.equal(h.traffic.authorize, undefined);
        assert.equal(h.traffic.exchange, undefined);
        assert.equal(await h.page.evaluate(() => localStorage.getItem("zcodejwttoken")), "e2e-jwt");
        assert.deepEqual(h.errors, []);
        results.push({ prefix, status, result: "passed" });
      } finally {
        await h.context.close();
      }
    }
} finally {
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(`Passed ${results.length} Aiscoo anonymous share checks`);
