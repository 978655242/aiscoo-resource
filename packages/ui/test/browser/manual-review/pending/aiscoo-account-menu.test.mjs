import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/aiscoo-account-menu.fixture.tsx";
let server, browser, origin, cacheDir;

before(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "aiscoo-account-menu-vite-"));
  server = await createServer({
    root,
    cacheDir,
    configFile: false,
    plugins: [
      {
        name: "account-menu-fixture-boundaries",
        load(id) {
          if (id.endsWith("/rewards/RewardsWebview.tsx"))
            return "export const RewardsWebview=()=>null;";
          if (id.endsWith("/shortcuts/useShortcutBindings.ts"))
            return 'export const useShortcutCommandLabel=()=>"";';
          if (id.endsWith("/store/StoreProvider.tsx"))
            return 'import {createContext} from "react"; export const StoreContext=createContext(null); export const useZCodeStore=(select)=>select({interfaceMode:"coding",setInterfaceMode:()=>{},isRestoringOAuthSession:false,theme:"zai-light",user:{id:"42"},loginEntryAttempt:null,requestLoginEntry:()=>1});';
          if (id.endsWith("/WorkspaceWebRemoteControlTrigger.tsx"))
            return "export const WorkspaceWebRemoteControlTrigger=()=>null;";
          if (id.endsWith("/WorkspaceSidebarFooterUsageSummary.tsx"))
            return 'import React from "react"; export const useWorkspaceSidebarFooterUsageSummaryState=()=>({}); export const WorkspaceSidebarFooterPlanBadge=()=>React.createElement("span",null,"Pro"); export const WorkspaceSidebarFooterUsageSummaryContent=()=>React.createElement("div",{"data-testid":"fixture-upgrade"},"Upgrade");';
        },
      },
      react(),
      tailwindcss(),
      {
        name: "account-menu-fixture-page",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url === "/favicon.ico") {
              res.statusCode = 204;
              res.end();
              return;
            }
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/.zcode/worktrees/**"] } },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: "chrome" });
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

async function open(params, width = 960) {
  const page = await browser.newPage({ viewport: { width, height: 680 } });
  page.on("pageerror", (error) => console.error("Fixture page error:", error));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Fixture browser error:", message.text());
  });
  await page.addInitScript(() => {
    window.rewardsCalls = 0;
  });
  await page.goto(`${origin}fixture?${new URLSearchParams(params)}`);
  await page.getByTestId("login-trigger").click({ timeout: 10000 });
  await page.getByRole("menu").waitFor();
  return page;
}

for (const locale of ["zh-CN", "en-US"]) {
  for (const theme of ["light", "dark"]) {
    for (const mobile of ["0", "1"]) {
      test(`Aiscoo 账户菜单隐藏邀请 ${locale} ${theme} mobile=${mobile}`, async () => {
        const page = await open(
          { product: "1", locale, theme, mobile },
          mobile === "1" ? 390 : 960,
        );
        try {
          assert.equal(await page.getByTestId("rewards-menu-item").count(), 0);
          assert.equal(await page.getByTestId("rewards-reward-badge").count(), 0);
          assert.equal(await page.getByTestId("profile-menu-name").innerText(), "Alex");
          assert.equal(await page.getByTestId("profile-menu-id").innerText(), "ID: 42");
          assert.equal(await page.getByTestId("fixture-upgrade").count(), 1);
          assert.equal(await page.getByTestId("logout-button").count(), 1);
          await page.keyboard.press("Escape");
          await page.getByTestId("independent-rewards-action").click();
          assert.equal(await page.evaluate(() => window.rewardsCalls), 1);
        } finally {
          await page.close();
        }
      });
    }
  }
}

for (const product of ["0", "1"]) {
  test(`未登录账户菜单隐藏邀请 product=${product}`, async () => {
    const page = await open({ product, guest: "1", locale: "zh-CN", theme: "light" });
    try {
      assert.equal(await page.getByTestId("rewards-menu-item").count(), 0);
      assert.equal(await page.getByTestId("login-menu-item").count(), 1);
    } finally {
      await page.close();
    }
  });
}

test("未注入产品策略时保留上游已登录邀请入口", async () => {
  const page = await open({ product: "0", locale: "en-US", theme: "light" });
  try {
    const entry = page.getByTestId("rewards-menu-item");
    assert.equal(await entry.count(), 1);
    assert.match(await entry.innerText(), /Refer a friend\s*Rewards/);
    await entry.click();
    assert.equal(await page.evaluate(() => window.rewardsCalls), 1);
  } finally {
    await page.close();
  }
});
