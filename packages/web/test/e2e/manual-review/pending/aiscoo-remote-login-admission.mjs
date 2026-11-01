// Aiscoo 产品入口回归：旧 OAuth、JWT、cookie 不得启动 remote 登录或配对。
// 现有 relay transport/owner 验收另由对应 remote 场景覆盖；本场景只检查产品 admission。
// 上游 remote-login-v2.mjs 保持原样，Aiscoo 产品断言独立放在本文件，避免同步时冲突。
// 启动：VITE_WEB_REMOTE_CONTROL_ROUTE_PATH=/remote/__test__ pnpm --filter @zcode/web exec vite --host 127.0.0.1 --port 5178 --strictPort
// 运行：node packages/web/test/e2e/manual-review/pending/aiscoo-remote-login-admission.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { setup } from "./remote-login-v2.helpers.mjs";

const origin = process.env.REMOTE_LOGIN_E2E_ORIGIN || "http://127.0.0.1:5178";
const artifacts = resolve(".tmp/aiscoo-remote-login-admission-e2e");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const locale of ["zh-CN", "en-US"])
    for (const signedIn of [false, true]) {
      const h = await setup(browser, { locale, signedIn });
      try {
        await h.context.addCookies([{ name: "legacy-session", value: "e2e-old", url: origin }]);
        for (const path of [
          // XCODE: 缺配置首页与旧官方回调同样拒绝，不消费历史浏览器身份。
          "/",
          "/oauth/callback?state=secret-state&code=secret-code&provider=zai",
          "/?remote=secret-device",
          "/remote/v4?sid=secret-device&mid=secret-mid",
          "/remote/__test__",
          "/remote/v4?state=secret-state&authCode=secret-code",
          "/share/callback?state=secret-state&code=secret-code",
          "/cn/share/callback?state=secret-state&authCode=secret-code",
        ]) {
          await h.page.goto(`${origin}${path}`);
          await h.page
            .getByRole("heading", {
              name: locale === "zh-CN" ? "Aiscoo 登录不可用" : "Aiscoo sign-in unavailable",
            })
            .waitFor();
          assert.doesNotMatch(await h.page.locator("body").innerText(), /Z\.ai|BigModel|secret-/);
          assert.equal(await h.page.getByRole("button").count(), 0);
          assert.equal(h.traffic.tokens + h.traffic.sockets + h.traffic.lists, 0);
          assert.equal(h.traffic.exchange, undefined);
          assert.equal(h.traffic.authorize, undefined);
          if (signedIn)
            assert.equal(
              await h.page.evaluate(() => localStorage.getItem("zcodejwttoken")),
              "e2e-jwt",
            );
          assert.deepEqual(h.errors, []);
          results.push({ locale, signedIn, path: path.split("?")[0], result: "passed" });
        }
      } finally {
        await h.context.close();
      }
    }
} finally {
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(`Passed ${results.length} Aiscoo remote admission checks`);
