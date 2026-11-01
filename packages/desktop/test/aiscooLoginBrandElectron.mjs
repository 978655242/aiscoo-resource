// Isolated real-component regression: no application main process, protocol registration,
// account credentials, external OAuth or user profile is used.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkUpstreamLoginControls,
  loginRenderer,
  logoutRenderer,
  waitForLogoutWelcome,
} from "./aiscooLogoutFixtureRenderer.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireRoot = createRequire(new URL("../../../package.json", import.meta.url));
const requireDesktop = createRequire(new URL("../package.json", import.meta.url));
const requireServices = createRequire(new URL("../../services/package.json", import.meta.url));
const { build } = requireServices("esbuild");
const { chromium, _electron: electron } = requireDesktop("playwright-core");
const { createServer } = await import(requireDesktop.resolve("vite"));
const { default: tailwindcss } = await import(requireDesktop.resolve("@tailwindcss/vite"));
const recoveryOnly = process.argv.includes("--recovery-only");
const logoutOnly = process.argv.includes("--logout-only");
const temporary = await mkdtemp(join(logoutOnly ? "/tmp" : tmpdir(), "aiscoo-login-ui-"));
assert.ok(!(recoveryOnly && logoutOnly), "Choose one isolated acceptance mode");
const evidence =
  recoveryOnly || logoutOnly
    ? await mkdtemp(
        join(
          logoutOnly ? "/tmp" : tmpdir(),
          logoutOnly ? "aiscoo-logout-evidence-" : "aiscoo-login-recovery-evidence-",
        ),
      )
    : resolve(root, "packages/desktop/out/aiscoo-login-brand");
let server;
let browser;
let electronApp;

try {
  const renderer = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: logoutOnly ? logoutRenderer : loginRenderer,
    },
    absWorkingDir: root,
    nodePaths: [resolve(root, "packages/desktop/node_modules")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    tsconfig: resolve(root, "packages/ui/tsconfig.json"),
    alias: {
      "@": resolve(root, "packages/ui/src"),
      react: dirname(requireRoot.resolve("react/package.json")),
      "react-dom": dirname(requireRoot.resolve("react-dom/package.json")),
    },
    loader: { ".svg": "dataurl", ".png": "dataurl", ".css": "empty" },
    define: { "process.env.NODE_ENV": JSON.stringify("test"), "import.meta.env": "{}" },
  });
  await writeFile(join(temporary, "renderer.js"), renderer.outputFiles[0].text);
  await writeFile(
    join(temporary, "index.html"),
    `<!doctype html><html><head><link rel="stylesheet" href="/@fs${root}/packages/ui/src/styles.css"><link rel="stylesheet" href="/@fs${root}/packages/ui/src/aiscoo/brand/brand.css"></head><body><div id="root"></div><script type="module" src="/renderer.js"></script></body></html>`,
  );
  server = await createServer({
    configFile: false,
    root: temporary,
    plugins: [tailwindcss()],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temporary] } },
  });
  await server.listen();
  await mkdir(evidence, { recursive: true });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const blockOutside = (route) =>
    route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort();

  async function openLoginPage(page, query) {
    // 原因：Vite/HMR 不保证网络静默；完成条件是 effect 就绪及调用方断言的真实可见控件。
    await page.goto(`${origin}/?${new URLSearchParams(query)}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.loginFixture?.ready === true);
  }

  async function checkPage(page, { locale, theme, width, engine }) {
    const productLogin = locale === "zh-CN" ? "登录" : "Sign in";
    const apiKey = locale === "zh-CN" ? "使用 API key" : "Use API key";
    const cancel = locale === "zh-CN" ? "取消" : "Cancel";
    const retry = locale === "zh-CN" ? "重新登录" : "Retry login";
    const errors = [];
    const onError = (error) => errors.push(error.message);
    const onResponse = (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    };
    page.on("pageerror", onError);
    page.on("response", onResponse);
    const button = page.getByRole("button", { name: productLogin, exact: true });
    try {
      await openLoginPage(page, { locale, theme, desktop: engine === "electron" ? "1" : "0" });
      await button.waitFor({ state: "visible", timeout: 10000 });
    } catch (error) {
      throw new Error(
        `登录夹具未渲染: ${JSON.stringify({ locale, theme, width, errors, text: await page.locator("body").innerText() })}`,
        { cause: error },
      );
    } finally {
      page.off("pageerror", onError);
      page.off("response", onResponse);
    }
    assert.equal(await page.getByRole("button", { name: apiKey, exact: true }).count(), 0);
    assert.equal(await page.getByText(/New API/).count(), 0);
    const logo = page.getByRole("img", { name: "Aiscoo" });
    assert.equal(await logo.count(), 1);
    const animatedLogo = logo.locator('[data-aiscoo-brand="wordmark-animated"]');
    assert.equal(await animatedLogo.isVisible(), true);
    assert.equal(
      await page.evaluate(() =>
        Boolean(
          getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim(),
        ),
      ),
      true,
      "application stylesheet must be loaded",
    );
    const tone = await animatedLogo.evaluate((element) => ({
      light: getComputedStyle(element.querySelector(".aiscoo-brand-tone-light")).display,
      dark: getComputedStyle(element.querySelector(".aiscoo-brand-tone-dark")).display,
    }));
    assert.deepEqual(
      tone,
      theme === "zai-dark" ? { light: "none", dark: "block" } : { light: "block", dark: "none" },
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const buttonBox = await button.boundingBox();
    assert.ok(buttonBox && buttonBox.x >= 0 && buttonBox.x + buttonBox.width <= width + 1);
    if ((width === 390 && engine === "chrome") || engine === "electron") {
      await page.screenshot({ path: join(evidence, `${engine}-${width}-${locale}-${theme}.png`) });
    }
    await button.click();
    await page.getByRole("button", { name: cancel, exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.getByText(/New API/u).count(), 0);
    await page.getByRole("button", { name: cancel, exact: true }).click();
    assert.deepEqual(
      await page.evaluate(() => window.loginFixture.events.filter((e) => e[0] === "cancel")),
      [["cancel", "new-api"]],
    );
    await page.evaluate(() => window.loginFixture.failNext());
    await button.click();
    await page.getByRole("button", { name: retry, exact: true }).click();
    await page.getByRole("button", { name: cancel, exact: true }).waitFor();
    assert.deepEqual(
      await page.evaluate(() => window.loginFixture.events.filter((e) => e[0] === "start")),
      [
        ["start", "new-api"],
        ["start", "new-api"],
        ["start", "new-api"],
      ],
    );
    assert.equal(
      await page.evaluate(() => window.loginFixture.events.some((e) => e[0] === "complete")),
      false,
    );
  }

  if (!recoveryOnly && !logoutOnly) {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    for (const width of [320, 390, 1280]) {
      for (const locale of ["zh-CN", "en-US"]) {
        for (const theme of ["zai-light", "zai-dark"]) {
          const context = await browser.newContext({ viewport: { width, height: 844 }, locale });
          await context.route("**/*", blockOutside);
          try {
            await checkPage(await context.newPage(), { locale, theme, width, engine: "chrome" });
          } finally {
            await context.close();
          }
        }
      }
    }
    for (const providerMode of ["empty", "official", "mixed", "disabled"]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.route("**/*", blockOutside);
      try {
        const page = await context.newPage();
        await openLoginPage(page, { locale: "zh-CN", providers: providerMode });
        const ready =
          providerMode === "mixed"
            ? page.getByRole("button", { name: "登录", exact: true })
            : page.getByTestId("oauth-error");
        await ready.waitFor({ state: "visible" });
        assert.equal(await page.getByRole("button", { name: /Z\.ai|BigModel/u }).count(), 0);
        assert.equal(
          await page.getByRole("button", { name: "使用 API key", exact: true }).count(),
          0,
        );
        assert.equal(
          await page.getByRole("img", { name: "Aiscoo", exact: true }).isVisible(),
          true,
        );
        if (providerMode === "mixed") {
          await ready.click();
          await page.getByRole("button", { name: "取消", exact: true }).waitFor();
          assert.deepEqual(
            await page.evaluate(() =>
              window.loginFixture.events.filter((event) => event[0] === "start"),
            ),
            [["start", "new-api"]],
          );
        } else {
          assert.equal(await page.getByRole("button", { name: "登录", exact: true }).count(), 0);
          const error = page.getByTestId("oauth-error");
          await error.waitFor();
          assert.match(await error.innerText(), /Aiscoo/u);
          assert.doesNotMatch(await error.innerText(), /https?:|example\.|New API/u);
          assert.deepEqual(await page.evaluate(() => window.loginFixture.events), []);
        }
      } finally {
        await context.close();
      }
    }
    const defaultContext = await browser.newContext();
    await defaultContext.route("**/*", blockOutside);
    try {
      const page = await defaultContext.newPage();
      await checkUpstreamLoginControls(page, openLoginPage);
    } finally {
      await defaultContext.close();
    }
  }

  const profile = join(temporary, "electron-profile");
  await mkdir(profile);
  const electronMain = join(temporary, "main.cjs");
  await writeFile(
    electronMain,
    `
const { app, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(profile)});
app.setPath("sessionData", ${JSON.stringify(profile)});
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1280, height: 844, show: false });
  window.loadURL(${JSON.stringify(origin)});
});
`,
  );
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  electronApp = await electron.launch({
    executablePath: requireDesktop("electron"),
    args: [electronMain],
    env: electronEnv,
  });
  const electronPage = await electronApp.firstWindow();
  await electronPage.context().route("**/*", blockOutside);
  if (logoutOnly) {
    const page = electronPage;
    page.setDefaultTimeout(5000);
    const results = [];
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    const order = [
      "confirmed",
      "settings.get",
      "logout",
      "settings.update",
      "domain.clear",
      "oauthError.clear",
      "user.clear",
      "provider",
      "webview",
      "relaunch",
    ];
    const transition = page.getByTestId("aiscoo-logout-transition");
    const login = page.getByTestId("oauth-login-button-new-api");
    const events = () => page.evaluate(() => [...window.logoutFixture.events]);
    const waitStep = (step) =>
      page.waitForFunction((name) => window.logoutFixture.events.includes(name), step);
    const release = (step) => page.evaluate((name) => window.logoutFixture.release(name), step);
    async function stableParentRerender(expectedMounts = 1) {
      const target = await page.evaluate(() => window.logoutFixture.rerender());
      await page.waitForFunction(
        (revision) => window.logoutFixture.state().parentRevision === revision,
        target,
      );
      const state = await page.evaluate(() => window.logoutFixture.state());
      assert.equal(state.contextsMatch, true);
      assert.equal(state.adaptersStable, true);
      assert.equal(state.mounts, expectedMounts);
      assert.equal(state.unmounts, expectedMounts - 1);
      assert.equal(state.effectMounts, expectedMounts);
      assert.equal(state.effectUnmounts, expectedMounts - 1);
    }
    async function open(options = {}) {
      await page.goto(
        `${origin}/?${new URLSearchParams({ locale: "zh-CN", theme: "zai-light", ...options })}`,
        { waitUntil: "domcontentloaded" },
      );
      // 远控夹具同样等待 hook effect 与真实退出按钮，不依赖 Vite/HMR 进入网络静默。
      await page.waitForFunction(() => window.logoutFixture?.ready === true);
      await page.getByTestId("fixture-logout").waitFor({ state: "visible" });
      const state = await page.evaluate(() => window.logoutFixture.state());
      assert.equal(state.contextsMatch, true);
      assert.equal(state.adaptersStable, true);
      assert.equal(
        state.presentationAttached,
        !["web", "remote", "generic"].includes(options.mode),
      );
      await stableParentRerender();
      await page.getByTestId("fixture-logout").click();
      await page.getByTestId("confirm-dialog-confirm").waitFor();
      assert.equal(
        await transition.count(),
        0,
        "Confirmation itself must not start the transition",
      );
      assert.deepEqual(await events(), []);
    }
    async function confirm() {
      await page.getByTestId("confirm-dialog-confirm").click();
    }
    async function covered() {
      await stableParentRerender();
      await transition.waitFor();
      assert.equal(await page.getByTestId("old-root").isVisible(), false);
      assert.equal(
        await page
          .getByTestId("old-root")
          .evaluate((element) => Boolean(element.closest("[inert]"))),
        true,
      );
      const state = await page.evaluate(() => window.logoutFixture.state());
      assert.equal(state.mounts, 1);
      assert.equal(state.unmounts, 0);
      assert.equal(state.presentationAttached, true);
      assert.equal(state.contextsMatch, true);
      assert.equal(state.adaptersStable, true);
      assert.equal(await page.getByRole("button", { name: /^(登录|Sign in)$/ }).count(), 0);
      assert.equal(
        await page.evaluate(() => window.logoutFixture.repeat()),
        true,
        "All duplicate entry calls share the original flight",
      );
    }
    for (const [locale, theme, os] of [
      ["zh-CN", "zai-light", "mac"],
      ["zh-CN", "zai-dark", "windows"],
      ["en-US", "zai-light", "linux"],
      ["en-US", "zai-dark", "mac"],
    ]) {
      const name = `${locale}-${theme}-${os}`;
      await open({
        locale,
        theme,
        os,
        hold: "settings.get,logout,provider,webview,relaunch",
        duplicate: "1",
      });
      await confirm();
      for (const step of ["settings.get", "logout", "provider", "webview", "relaunch"]) {
        await waitStep(step);
        await covered();
        assert.deepEqual(await events(), order.slice(0, order.indexOf(step) + 1));
        if (step === "settings.get") {
          const synchronous = await page.evaluate(() => window.logoutFixture.snapshots);
          assert.ok(
            synchronous.every((entry) => entry.overlay && entry.inert && entry.hidden === "hidden"),
            "Opaque isolation must commit before any service call",
          );
          await page.keyboard.press("Escape");
          await page.keyboard.press("Tab");
          assert.equal(await transition.isVisible(), true);
          assert.equal(
            await page.evaluate(() =>
              Boolean(document.activeElement?.closest('[data-testid="aiscoo-logout-transition"]')),
            ),
            true,
            "Keyboard focus stays inside the transition",
          );
          const surface = await transition.evaluate((element) => {
            const style = getComputedStyle(element),
              box = element.getBoundingClientRect();
            return {
              opacity: style.opacity,
              background: style.backgroundColor,
              fillsViewport:
                box.x <= 1 &&
                box.y <= 1 &&
                box.right >= innerWidth - 1 &&
                box.bottom >= innerHeight - 1,
            };
          });
          assert.equal(surface.opacity, "1");
          assert.doesNotMatch(surface.background, /transparent|rgba\([^)]*,\s*0\s*\)/);
          assert.equal(surface.fillsViewport, true);
          assert.match(
            await transition.innerText(),
            locale === "zh-CN" ? /正在退出/ : /Signing out/,
          );
          if (os !== "mac") {
            for (const control of ["minimize", "close"]) {
              assert.equal(
                await transition
                  .getByTestId(`window-control-${control}`)
                  .locator("svg")
                  .getAttribute("stroke-width"),
                "1.5",
                `${os} ${control} must retain the production Lucide stroke width`,
              );
            }
            for (const control of ["minimize", "maximize", "close"])
              await transition.getByTestId(`window-control-${control}`).click();
            assert.deepEqual(await page.evaluate(() => window.logoutFixture.controls), [
              "minimizeWindow",
              "toggleMaximizeWindow",
              "closeWindow",
            ]);
          }
        }
        if (step === "provider") {
          await login.waitFor({ state: "attached" });
          assert.equal(await login.isVisible(), false);
          assert.equal(
            (
              await login.evaluate((element) => ({
                pointer: getComputedStyle(element).visibility,
                inert: Boolean(element.closest("[inert]")),
              }))
            ).inert,
            true,
          );
        }
        await release(step);
      }
      await waitStep("resolved");
      await covered();
      assert.deepEqual(await events(), [...order, "resolved"]);
      assert.deepEqual(await page.evaluate(() => window.logoutFixture.errors), []);
      const patch = await page.evaluate(() => window.logoutFixture.patch);
      assert.equal(patch.providerFamilyDomain, "");
      assert.equal(patch.providerFamilyDomainMigrated, true);
      assert.equal(typeof patch.providerFamilyDomainUpdatedAt, "number");
      await page.screenshot({ path: join(evidence, `${name}-resolved.png`) });
      await page.evaluate(() => window.logoutFixture.newRoot());
      await transition.waitFor({ state: "detached" });
      await page
        .getByRole("button", { name: locale === "zh-CN" ? "登录" : "Sign in", exact: true })
        .waitFor();
      await stableParentRerender(2);
      assert.deepEqual(
        await page.evaluate(() => {
          const { mounts, unmounts } = window.logoutFixture.state();
          return { mounts, unmounts };
        }),
        { mounts: 2, unmounts: 1 },
      );
      results.push({ name, status: "passed", order: await events() });
    }
    await open({ hold: "none", duplicate: "1" });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /取消/ })
      .click();
    await waitStep("resolved");
    assert.equal(await transition.count(), 0);
    assert.equal(await page.getByTestId("fixture-logout").isVisible(), true);
    assert.deepEqual(await events(), ["resolved"]);
    // 取消后再次真实点击应能发起新确认；flight 不能永久占用。
    await page.getByTestId("fixture-logout").click();
    await page.getByTestId("confirm-dialog-confirm").waitFor();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /取消/ })
      .click();
    await page.waitForFunction(() => window.logoutFixture.events.length === 2);
    results.push({ name: "cancel-and-retry", status: "passed" });
    for (const fail of [
      "settings.get",
      "logout",
      "settings.update",
      "provider",
      "webview",
      "relaunch",
    ]) {
      await open({ fail, hold: "none" });
      await confirm();
      await waitStep("rejected");
      await transition.waitFor({ state: "detached" });
      assert.equal(await page.getByTestId("old-root").isVisible(), true);
      assert.equal(await page.evaluate(() => window.logoutFixture.state().adaptersStable), true);
      assert.equal(await page.evaluate(() => window.logoutFixture.state().contextsMatch), true);
      await stableParentRerender();
      assert.equal(
        await page
          .getByTestId("old-root")
          .evaluate((element) => Boolean(element.closest("[inert]"))),
        false,
      );
      assert.deepEqual(await events(), [...order.slice(0, order.indexOf(fail) + 1), "rejected"]);
      assert.deepEqual(await page.evaluate(() => window.logoutFixture.errors), [
        { same: true, message: `synthetic-${fail}` },
      ]);
      assert.equal(await page.evaluate(() => window.logoutFixture.state().unmounts), 0);
      if (["provider", "webview", "relaunch"].includes(fail)) await login.waitFor();
      else await page.getByTestId("fixture-logout").waitFor();
      results.push({ name: `failure-${fail}`, status: "passed" });
    }
    for (const mode of ["web", "remote", "generic"]) {
      await open({ mode, hold: "provider,webview" });
      await confirm();
      await waitStep("provider");
      assert.equal(await transition.count(), 0);
      await login.waitFor({ state: "visible" });
      const welcomeReadiness = await waitForLogoutWelcome(page, mode);
      assert.equal(
        await page.getByRole("button", { name: "使用 API key", exact: true }).isVisible(),
        mode === "generic",
      );
      assert.equal(
        await page.getByRole("img", { name: "Aiscoo", exact: true }).isVisible(),
        mode !== "generic",
      );
      assert.equal(
        await page.evaluate(() => window.logoutFixture.state().presentationAttached),
        false,
      );
      assert.equal(
        await page
          .getByTestId("old-root")
          .evaluate((element) => Boolean(element.closest("[inert]"))),
        false,
      );
      await release("provider");
      await waitStep("webview");
      await release("webview");
      await waitStep("resolved");
      assert.deepEqual(await events(), [...order.slice(1), "resolved"]);
      if (mode === "generic")
        await page.screenshot({ path: join(evidence, "generic-uninjected-login-visible.png") });
      results.push({
        name: `no-boundary-${mode}`,
        status: "passed",
        loginVisibleAtProviderHold: true,
        welcomeReadiness,
      });
    }
    assert.equal(results.length, 14, "The complete logout matrix must reach all 14 cases");
    assert.deepEqual(runtimeErrors, []);
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(
        {
          status: "passed",
          cases: results.length,
          results,
          runtimeErrors,
          component:
            "public createAiscooAccountLoginRoot + real useRootWorkspaceActions + ConfirmDialogHost + WelcomeScreen",
          limitations:
            "Lightweight FixtureRoot using production product assembly; synthetic platform ports; Windows/Linux controls rendered on macOS Electron; no OS relaunch or credentials",
        },
        null,
        2,
      ),
    );
    console.log(`PASS: ${results.length} isolated Electron logout scenarios; evidence ${evidence}`);
  } else if (recoveryOnly) {
    // 原因：真实恢复验收只替换传输与后端，持久化/PKCE/Me 校验继续使用产品实现。
    const hostBundle = join(temporary, "recovery-host.cjs");
    await build({
      stdin: {
        resolveDir: root,
        contents: `
export { NewApiAccountService } from "./packages/services/src/new-api/newApiAccountService.ts";
export { NewApiSessionRepo } from "./packages/services/src/new-api/newApiSessionRepo.ts";
export { NewApiClient } from "./packages/services/src/new-api/newApiClient.ts";
export { NewApiProviderAdapter } from "./packages/services/src/oauth/providers/newApiProviderAdapter.ts";
export { createCredentialCipherProvider } from "./packages/services/src/credential/providers/credentialCipherProvider.ts";
export { setDataBaseDir } from "./packages/services/src/paths.ts";
`,
      },
      outfile: hostBundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      banner: {
        js: `require = require("node:module").createRequire(${JSON.stringify(resolve(root, "packages/services/package.json"))});`,
      },
      absWorkingDir: root,
      nodePaths: [join(root, "node_modules"), join(root, "packages/services/node_modules")],
    });
    const host = createRequire(import.meta.url)(hostBundle);
    host.setDataBaseDir(join(temporary, "service-data"));
    const { createHash, randomBytes } = await import("node:crypto");
    const { readFile, readdir, stat } = await import("node:fs/promises");
    const backendOrigin = "https://recovery.example";
    const now = 1_800_000_000_000;
    const sid = "electron-recovered-sid";
    const claims = {
      iss: "new-api",
      aud: ["new-api-xcode"],
      token_use: "xcode_access",
      sub: "2",
      sid,
      exp: (now + 60_000) / 1000,
      uv: 1,
      sv: 1,
      nbf: now / 1000 - 5,
      iat: now / 1000,
      scopes: ["profile:read", "wallet:read", "usage:read"],
      jti: "synthetic-electron",
    };
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const user = {
      id: "2",
      username: "fixture-user",
      display_name: "Fixture User",
      avatar_url: null,
    };
    const bundle = {
      schema_version: 1,
      server_time: now,
      access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.${Buffer.alloc(32, 1).toString("base64url")}`,
      access_expires_at: now + 60_000,
      refresh_token: "synthetic-refresh",
      refresh_expires_at: now + 600_000,
      token_type: "Bearer",
      session_id: sid,
      user,
      relay_credential: { token: "sk-synthetic-relay", expires_at: now + 600_000 },
    };
    const calls = [];
    const client = new host.NewApiClient(backendOrigin, {
      now: () => now,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, backendOrigin);
        calls.push(url.pathname);
        let data;
        if (url.pathname.endsWith("/auth/token")) {
          const body = JSON.parse(String(init.body));
          assert.equal(body.code, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
          assert.ok(body.code_verifier);
          data = bundle;
        } else if (url.pathname.endsWith("/me")) {
          assert.equal(
            new Headers(init.headers).get("authorization"),
            `Bearer ${bundle.access_token}`,
          );
          data = {
            schema_version: 1,
            server_time: now,
            session_id: sid,
            user,
            authorization_revision: "0",
          };
        } else throw new Error("Unexpected synthetic backend endpoint");
        return new Response(JSON.stringify({ success: true, data }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const credentialsFile = join(temporary, "credentials.json");
    const cipherProvider = host.createCredentialCipherProvider({
      env: { ZCODE_CREDENTIAL_SECRET: randomBytes(32).toString("hex") },
    });
    const activeKey = `new-api:${createHash("sha256").update(backendOrigin).digest("hex")}:active`;
    const unrelated = "enc:v1:synthetic-untouched";
    const before = JSON.stringify({
      [activeKey]: "enc:v1:invalid",
      "new-api:unrelated:active": unrelated,
    });
    await writeFile(credentialsFile, before, { mode: 0o600 });
    const newRepo = () =>
      new host.NewApiSessionRepo(backendOrigin, { credentialsFile, cipherProvider });
    const newService = () =>
      new host.NewApiAccountService({
        adapter: new host.NewApiProviderAdapter(client),
        repo: newRepo(),
        now: () => now,
      });
    const service = newService();
    const coldBefore = await service.oauth.restoreCachedSessionState();
    assert.equal(coldBefore.status, "unavailable");
    assert.equal(coldBefore.reason, "credential-recovery-required");
    let started;
    const rpcCalls = [];
    await electronPage.exposeFunction("recoveryRpc", async (method, args) => {
      assert.ok(
        [
          "getProviders",
          "getActiveProvider",
          "startOAuth",
          "cancelPending",
          "handleCallback",
        ].includes(method),
      );
      rpcCalls.push(method);
      const result = await service.oauth[method](...args);
      if (method === "startOAuth") started = result;
      return result;
    });
    await openLoginPage(electronPage, { locale: "zh-CN", recovery: "1", desktop: "1" });
    await electronPage
      .getByRole("button", { name: "登录", exact: true })
      .waitFor({ state: "visible" });
    await electronPage.getByRole("button", { name: "登录", exact: true }).click();
    await electronPage.getByRole("button", { name: "取消", exact: true }).waitFor();
    await electronPage.waitForFunction(() =>
      window.loginFixture.events.some((event) => event[0] === "open-synthetic"),
    );
    assert.ok(started?.state);
    const callback = new URL(new URL(started.authorizeUrl).searchParams.get("redirect_uri"));
    callback.search = new URLSearchParams({
      provider: "new-api",
      state: started.state,
      code: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    }).toString();
    await electronPage.evaluate((url) => window.acceptRecoveryCallback(url), callback.href);
    await electronPage.waitForFunction(() =>
      window.loginFixture.events.some((event) => event[0] === "complete"),
    );
    assert.equal(service.getOwner()?.userId, "2");
    assert.equal((await newRepo().loadActive())?.bundle.session_id, sid);
    const coldAfter = await newService().oauth.restoreCachedSessionState();
    assert.equal(coldAfter.status, "authenticated");
    assert.equal(coldAfter.userInfo?.id, "2");
    const after = JSON.parse(await readFile(credentialsFile, "utf8"));
    assert.equal(after["new-api:unrelated:active"], unrelated);
    const backups = (await readdir(temporary)).filter(
      (name) => name.includes(".corrupt-") && name.endsWith(".bak"),
    );
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(temporary, backups[0]), "utf8"), before);
    assert.equal((await stat(join(temporary, backups[0]))).mode & 0o777, 0o600);
    assert.deepEqual(calls, ["/api/xcode/v1/auth/token", "/api/xcode/v1/me", "/api/xcode/v1/me"]);
    await electronPage.screenshot({ path: join(evidence, "electron-verified-recovery.png") });
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(
        {
          status: "passed",
          coldBefore: coldBefore.status,
          coldAfter: coldAfter.status,
          callback: "real-service",
          component: "WelcomeScreen",
          rpcCalls,
          calls,
          backup: "exact-bytes-0600",
          unrelated: "unchanged",
          uiComplete: true,
        },
        null,
        2,
      ),
    );
    console.log(
      `PASS: isolated Electron WelcomeScreen -> real verified login -> encrypted recovery -> cold restore; evidence ${evidence}`,
    );
  } else {
    await checkPage(electronPage, {
      locale: "zh-CN",
      theme: "zai-light",
      width: 1280,
      engine: "electron",
    });
    await checkPage(electronPage, {
      locale: "en-US",
      theme: "zai-dark",
      width: 1280,
      engine: "electron",
    });
    console.log(
      "PASS: 12 Chrome viewport/theme/locale cases, 4 provider admission cases, upstream New API copy and official polling/API key controls, 2 isolated Electron cases; public product assembly, synthetic OAuth only",
    );
  }
} finally {
  await electronApp?.close();
  await browser?.close();
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}
