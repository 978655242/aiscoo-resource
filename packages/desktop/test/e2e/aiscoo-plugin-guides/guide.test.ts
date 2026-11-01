import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PLUGIN_GUIDE_SECTIONS,
  pluginGuideDocumentSchema,
  type PluginGuideDocument,
} from "@zcode/shared/aiscoo-plugin-guides";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  waitForWorkspaceApp,
  readSettings,
} from "../helpers/desktop-app.js";
import { seedCustomOpenAIChatCompletionsProvider } from "../helpers/custom-openai-provider-store.js";
import { seedPersonalDefaultModelSelection } from "../helpers/model-provider-restart-config.js";
import {
  reloadElectronSessionPreservingBrowserProfile,
  reloadElectronSessionSafely,
} from "../helpers/e2e-electron-reload.js";
import {
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
  addLifecycleMarketplaceThroughUi,
  clickPluginControl,
  createPluginLifecycleFixture,
  getPluginList,
  openPluginCard,
  openPluginSettings,
  setPluginPresentation,
  type PluginLifecycleFixture,
} from "../helpers/plugin-management-lifecycle.js";
import {
  getV4ComposerText,
  getV4ConversationState,
  getV4ModelConfig,
  waitForV4ComposerSelectionReady,
  setV4ComposerText,
} from "../helpers/v4-conversation.js";
import { startPluginGuideProvider, type PluginGuideProvider } from "./provider.js";

const paths = getE2EAppDataPaths();
const cacheDirectory = join(paths.appDataDir, "plugin-guides", "documents");
const artifactDirectory = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR || join(process.cwd(), ".e2e-artifacts"),
  "aiscoo-plugin-guides",
);
const providerId = "e2e-plugin-guide-provider";
const modelId = "e2e-plugin-guide-model";
const selectedProviderId = "e2e-plugin-guide-selected-provider";
const selectedModelId = "e2e-plugin-guide-selected-model";
const reasoningLevel = { values: ["low", "high"], map: '{"reasoning_effort":reasoningLevel}' };
const question =
  "GUIDE_QUESTION: Add a concrete finance team example and simplify the first-use steps.";
const cancelledQuestion = "GUIDE_CANCELLED_QUESTION: Explain how to check the lifecycle output.";
const selector = (id: string) => `[data-testid="plugin-guide-${id}"]`;

describe("Aiscoo plugin guide: real Desktop stream and Host persistence", () => {
  let provider: PluginGuideProvider | undefined;
  let marketplace: PluginLifecycleFixture | undefined;
  const observations: Record<string, unknown> = {};

  after(async () => {
    try {
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        join(artifactDirectory, "observations.json"),
        JSON.stringify({ ...observations, requests: provider?.requests ?? [] }, null, 2),
      );
    } finally {
      try {
        await provider?.close();
      } finally {
        try {
          await clearAppData();
        } finally {
          if (marketplace) await rm(marketplace.marketplaceRoot, { recursive: true, force: true });
        }
      }
    }
  });

  it("PG-01/02/03/04/06/09/10: uses guide-only model and effort, previews, revises, cancels and restores", async function () {
    this.timeout(300_000);
    // This spec uses only a loopback fixture and the runner's synthetic replay credential.
    expect(process.env.E2E_PROVIDER_CAPTURE_MODE).not.toBe("capture");
    expect(process.env.E2E_PROVIDER_HTTP_MODE).not.toBe("capture");
    const runtimeHome = await browser.electron.execute(() => process.env.HOME);
    expect(runtimeHome).toBe(paths.homeDir);
    await mkdir(artifactDirectory, { recursive: true });
    provider = await startPluginGuideProvider();
    const fixtureProvider = provider;
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: async () => {
        await seedCustomOpenAIChatCompletionsProvider({
          baseURL: fixtureProvider.baseURL,
          providerId,
          providerName: "Plugin Guide Loopback E2E",
          modelId,
          reasoningLevel,
        });
        await seedCustomOpenAIChatCompletionsProvider({
          baseURL: fixtureProvider.baseURL,
          providerId: selectedProviderId,
          providerName: "Plugin Guide Selected E2E",
          modelId: selectedModelId,
          reasoningLevel,
        });
        await seedPersonalDefaultModelSelection(paths.configFile, {
          providerId,
          modelId,
          options: { reasoningLevel: "high" },
        });
      },
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
    await waitForV4ComposerSelectionReady();
    await setV4ComposerText("UNSENT_ORDINARY_DRAFT: keep this text and ordinary high effort.");
    const normalBefore = await normalTaskContext();
    observations.normalBefore = normalBefore;
    expect(normalBefore.defaultModelSelection).toEqual({
      providerId,
      modelId,
      options: { reasoningLevel: "high" },
    });
    expect(fixtureProvider.requests).toHaveLength(0);

    marketplace = await createPluginLifecycleFixture();
    await openPluginSettings();
    await setPluginPresentation({ locale: "en-US", theme: "zai-light", width: 1440, height: 800 });
    await addLifecycleMarketplaceThroughUi(marketplace);
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await assertUninstalled();
    await clickPluginControl("plugin-guide-open");
    await $(selector("reader")).waitForDisplayed({ timeout: 30_000 });
    await waitForRequestCount(1);
    expect(fixtureProvider.requests[0]!.body.reasoning_effort).toBe("low");
    await waitForText("preview", "GUIDE_INITIAL");
    expect(fixtureProvider.requests[0]!.completed).toBe(false);
    expect(await $(selector("document")).isExisting()).toBe(false);
    expect(await cacheDocuments()).toHaveLength(0);
    await screenshot("01-real-stream-preview");

    await clickPluginControl("plugin-guide-back");
    await $(selector("open")).waitForDisplayed();
    await clickPluginControl("plugin-guide-open");
    await waitForText("preview", "GUIDE_INITIAL");
    expect(fixtureProvider.requests).toHaveLength(1);
    expect(fixtureProvider.requests[0]!.completed).toBe(false);
    fixtureProvider.release();
    await waitForSaved("GUIDE_INITIAL");
    const initial = await savedDocument();
    expect(initial.providerId).toBe(providerId);
    expect(initial.modelId).toBe(modelId);
    expect(initial.sourcePaths.length).toBeGreaterThan(0);
    expect(initial.markdown).toContain("GUIDE_INITIAL");
    expect(fixtureProvider.requests[0]!.completed).toBe(true);
    expect(fixtureProvider.requests[0]!.aborted).toBe(false);
    expect(JSON.stringify(fixtureProvider.requests[0]!.body)).toContain(
      PLUGIN_LIFECYCLE_RUNTIME_MARKER,
    );
    await assertSevenHeadings();
    await assertUninstalled();
    observations.initial = initial;
    await screenshot("02-saved-initial-light-wide");

    fixtureProvider.setMode("complete");
    await selectGuideModelAndEffort();
    expect(fixtureProvider.requests).toHaveLength(1);
    await screenshot("02-guide-model-high-effort");
    await ask(question);
    await waitForRequestCount(2);
    await waitForSaved("GUIDE_REVISED");
    const revised = await savedDocument();
    expect(fixtureProvider.requests[1]!.body.reasoning_effort).toBe("high");
    expect(revised.selection).toEqual({
      providerId: selectedProviderId,
      modelId: selectedModelId,
      options: { reasoningLevel: "high" },
    });
    expect(revised.revision).not.toBe(initial.revision);
    expect(
      revised.messages.some((message) => message.role === "user" && message.content === question),
    ).toBe(true);
    expect(revised.messages.at(-1)?.role).toBe("assistant");
    const revisionWire = JSON.stringify(fixtureProvider.requests[1]!.body);
    expect(revisionWire).toContain(question);
    expect(revisionWire).toContain("GUIDE_INITIAL");
    expect(revisionWire).toContain(PLUGIN_LIFECYCLE_RUNTIME_MARKER);
    await assertSevenHeadings();
    await reopenGuide("GUIDE_REVISED");
    expect(fixtureProvider.requests).toHaveLength(2);
    observations.revised = revised;
    await screenshot("03-revised-question-history");

    fixtureProvider.setMode("held");
    await ask(cancelledQuestion, true);
    await waitForRequestCount(3);
    await waitForText("preview", "GUIDE_REVISED");
    expect(fixtureProvider.requests[2]!.completed).toBe(false);
    expect(await $(selector("document")).getText()).toContain("GUIDE_REVISED");
    await clickPluginControl("plugin-guide-stop");
    await waitForText("status", "Generation stopped");
    await browser.waitUntil(() => fixtureProvider.requests[2]!.aborted, {
      timeout: 15_000,
      timeoutMsg: "Stopping the real model stream did not close the held HTTP response",
    });
    expect(fixtureProvider.requests[2]!.completed).toBe(false);
    expect(await savedDocument()).toEqual(revised);
    expect(await $(selector("document")).getText()).toContain("GUIDE_REVISED");
    await $(selector("retry")).waitForDisplayed();
    await screenshot("04-cancel-preserves-saved-revision");

    fixtureProvider.setMode("complete");
    await clickPluginControl("plugin-guide-retry");
    await waitForRequestCount(4);
    await waitForSaved("GUIDE_REVISED");
    const retried = await savedDocument();
    expect(retried.revision).not.toBe(revised.revision);
    expect(retried.messages.filter((message) => message.content === question)).toHaveLength(1);
    expect(
      retried.messages.filter((message) => message.content === cancelledQuestion),
    ).toHaveLength(1);
    const retryWire = JSON.stringify(fixtureProvider.requests[3]!.body);
    expect(retryWire).toContain(cancelledQuestion);
    expect(retryWire).toContain(question);
    expect(retryWire).toContain("GUIDE_REVISED");
    await assertSevenHeadings();
    await assertUninstalled();

    const windowMinimum = await browser.electron.execute(
      (electron, rendererUrl) => {
        const window = electron.BrowserWindow.getAllWindows().find(
          (item) => item.webContents.getURL() === rendererUrl,
        );
        if (!window) throw new Error("Guide renderer window was not found");
        const minimum = window.getMinimumSize();
        window.setMinimumSize(320, 400);
        return { id: window.id, minimum };
      },
      await browser.getUrl(),
    );
    for (const theme of ["zai-light", "zai-dark"] as const) {
      await setPluginPresentation({ locale: "en-US", theme, width: 393, height: 852 });
      const sidebarVisible = await browser.execute(() => {
        const sidebar = document.querySelector<HTMLElement>('[data-testid="sidebar"]');
        return Boolean(
          sidebar &&
          !sidebar.closest('[aria-hidden="true"]') &&
          sidebar.getBoundingClientRect().right > 0,
        );
      });
      if (sidebarVisible) await browser.$('button[aria-label="Toggle sidebar"]').click();
      await browser.waitUntil(
        async () =>
          browser.execute((readerSelector) => {
            const rect = document.querySelector(readerSelector)?.getBoundingClientRect();
            return Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth + 1);
          }, selector("reader")),
        { timeout: 10_000, timeoutMsg: "The narrow guide reader is clipped outside the viewport" },
      );
      await waitForSaved("GUIDE_REVISED");
      await $(selector("question")).scrollIntoView({ block: "center" });
      const layout = await browser.execute((readerSelector) => {
        const reader = document.querySelector<HTMLElement>(readerSelector);
        const input = reader?.querySelector<HTMLElement>('[data-testid="plugin-guide-question"]');
        return {
          viewportWidth: window.innerWidth,
          left: reader?.getBoundingClientRect().left ?? -1,
          right: reader?.getBoundingClientRect().right ?? 0,
          width: reader?.clientWidth ?? 0,
          scrollWidth: reader?.scrollWidth ?? 0,
          inputWidth: input?.getBoundingClientRect().width ?? 0,
          inputLeft: input?.getBoundingClientRect().left ?? -1,
          inputRight: input?.getBoundingClientRect().right ?? 0,
        };
      }, selector("reader"));
      expect(layout.viewportWidth).toBe(393);
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(393);
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
      expect(layout.inputWidth).toBeGreaterThan(0);
      expect(layout.inputWidth).toBeLessThanOrEqual(393);
      expect(layout.inputLeft).toBeGreaterThanOrEqual(0);
      expect(layout.inputRight).toBeLessThanOrEqual(393);
      observations[theme] = layout;
      await screenshot(`05-${theme}-393px`);
    }
    await setPluginPresentation({ locale: "en-US", theme: "zai-light", width: 1440, height: 800 });
    await browser.electron.execute((electron, previous) => {
      electron.BrowserWindow.fromId(previous.id)?.setMinimumSize(
        previous.minimum[0]!,
        previous.minimum[1]!,
      );
    }, windowMinimum);
    await clickPluginControl("desktop-top-nav-back");
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    await waitForV4ComposerSelectionReady();
    const normalAfter = await normalTaskContext();
    observations.normalAfter = normalAfter;
    expect(normalAfter).toEqual(normalBefore);

    // Any accidental cache miss after restart must fail visibly and increment the request count.
    fixtureProvider.setMode("failure");
    const oldPid = await browser.electron.execute(() => process.pid);
    await reloadElectronSessionPreservingBrowserProfile(browser);
    const newPid = await browser.electron.execute(() => process.pid);
    expect(newPid).not.toBe(oldPid);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await clickPluginControl("plugin-guide-open");
    await waitForSaved("GUIDE_REVISED");
    await assertSevenHeadings();
    expect(await savedDocument()).toEqual(retried);
    await waitForText("reader", question);
    await waitForText("reader", cancelledQuestion);
    expect(fixtureProvider.requests).toHaveLength(4);
    await reopenGuide("GUIDE_REVISED");
    expect(fixtureProvider.requests).toHaveLength(4);
    await assertUninstalled();
    expect(
      fixtureProvider.requests.map(({ completed, aborted }) => ({ completed, aborted })),
    ).toEqual([
      { completed: true, aborted: false },
      { completed: true, aborted: false },
      { completed: false, aborted: true },
      { completed: true, aborted: false },
    ]);
    observations.restored = {
      oldPid,
      newPid,
      document: retried,
      requestCount: fixtureProvider.requests.length,
    };
    await screenshot("06-full-restart-cached-guide-and-questions");
  });

  it("PG-11: automatically continues a length-limited stream and saves one complete guide", async function () {
    this.timeout(90_000);
    if (!provider) throw new Error("The isolated guide provider is unavailable");
    const before = await savedDocument();
    const requestCount = provider.requests.length;
    provider.setMode("continuation");
    await ask("GUIDE_CONTINUATION: Finish the guide after the provider output limit.");
    await waitForRequestCount(requestCount + 2);
    await browser.waitUntil(async () => (await savedDocument()).revision !== before.revision, {
      timeout: 30_000,
    });
    await waitForSaved("GUIDE_REVISED");
    const continued = await savedDocument();
    expect(continued.markdown).toContain("GUIDE_REVISED");
    expect(continued.markdown.match(/GUIDE_REVISED/g)).toHaveLength(1);
    expect(continued.messages).toHaveLength(before.messages.length + 2);
    expect(
      continued.messages.some((message) => message.content.startsWith("Output token limit hit.")),
    ).toBe(false);
    const resumedMessages = provider.requests[requestCount + 1]!.body.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(resumedMessages.at(-2)).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("<guide>"),
    });
    expect(resumedMessages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("Resume directly"),
    });
    expect(provider.requests.slice(requestCount).map((request) => request.completed)).toEqual([
      true,
      true,
    ]);
    await assertSevenHeadings();
    observations.continuation = {
      beforeRevision: before.revision,
      document: continued,
      requestCount: provider.requests.length,
    };
    await screenshot("07-output-limit-automatic-continuation");
  });

  async function waitForRequestCount(count: number) {
    await browser.waitUntil(() => (provider?.requests.length ?? 0) >= count, {
      timeout: 30_000,
      timeoutMsg: `The actual model provider did not receive guide request ${count}`,
    });
    expect(provider!.requests).toHaveLength(count);
    expect(provider!.requests[count - 1]!.body.model).toBe(count === 1 ? modelId : selectedModelId);
    expect(provider!.requests[count - 1]!.body.stream).toBe(true);
  }

  async function selectGuideModelAndEffort() {
    const picker = $(selector("model-select"));
    await picker.waitForClickable();
    await picker.click();
    const providerTrigger = $('[data-testid="composer-provider-trigger"]');
    await providerTrigger.waitForDisplayed();
    await providerTrigger.moveTo();
    const group = $(`[data-model-provider-key="registry-provider:${selectedProviderId}"]`);
    await group.waitForDisplayed();
    await group.click();
    const effort = $('input[type="range"][data-testid="composer-thought-slider"]');
    await effort.waitForDisplayed();
    await effort.click();
    await browser.keys("End");
    await browser.waitUntil(async () => (await effort.getValue()) === "1", {
      timeout: 10_000,
      timeoutMsg: "Guide effort did not select the public high reasoning level",
    });
    await screenshot("02-guide-model-menu");
    await browser.keys("Escape");
    await browser.waitUntil(
      () =>
        browser.execute((pickerSelector) => {
          const element = document.querySelector(pickerSelector);
          return (
            element &&
            element
              .getAnimations({ subtree: true })
              .every((animation) => animation.playState !== "running")
          );
        }, selector("model-select")),
      { timeout: 5_000, timeoutMsg: "Guide model label did not settle after closing the menu" },
    );
    expect(await picker.getText()).toContain(selectedModelId);
  }
});

async function normalTaskContext() {
  return {
    conversation: await getV4ConversationState(),
    model: await getV4ModelConfig(),
    draft: await getV4ComposerText(),
    modelPreferences: Object.fromEntries(
      Object.entries(await readSettings()).filter(([key]) => /model|provider|thought/iu.test(key)),
    ),
    modelStorage: await browser.execute(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([key]) => /model|recent/iu.test(key)),
      ),
    ),
    defaultModelSelection: (
      JSON.parse(await readFile(paths.configFile, "utf8")) as {
        config: { defaultModelSelection?: unknown };
      }
    ).config.defaultModelSelection,
  };
}

async function assertUninstalled() {
  expect((await getPluginList()).plugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID)).toBe(
    false,
  );
}

async function waitForText(id: string, text: string) {
  await browser.waitUntil(
    async () => {
      const element = $(selector(id));
      return (await element.isExisting()) && (await element.getText()).includes(text);
    },
    { timeout: 30_000, timeoutMsg: `plugin-guide-${id} did not contain ${text}` },
  );
}

async function waitForSaved(marker: string) {
  await waitForText("document", marker);
  await waitForText("status", "Saved locally");
  await browser.waitUntil(
    async () => (await cacheDocuments()).some((document) => document.markdown.includes(marker)),
    {
      timeout: 15_000,
      timeoutMsg: "The guide was not persisted by the real Host service",
    },
  );
}

async function reopenGuide(marker: string) {
  await clickPluginControl("plugin-guide-back");
  await $(selector("open")).waitForDisplayed();
  await clickPluginControl("plugin-guide-open");
  await waitForSaved(marker);
}

async function ask(text: string, enter = false) {
  const input = $(selector("question"));
  await input.waitForDisplayed();
  expect(await input.getAttribute("contenteditable")).toBe("true");
  await input.click();
  await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
  await browser.keys("Backspace");
  await browser.keys(text);
  if (enter) await browser.keys("Enter");
  else await $(selector("send")).click();
}

async function assertSevenHeadings() {
  const headings = await browser.execute(
    (documentSelector) =>
      Array.from(document.querySelectorAll(`${documentSelector} h2`), (node) =>
        node.textContent?.trim(),
      ),
    selector("document"),
  );
  expect(headings).toEqual(PLUGIN_GUIDE_SECTIONS.map((section) => section.title["en-US"]));
}

async function cacheDocuments(): Promise<PluginGuideDocument[]> {
  let files: string[];
  try {
    files = await readdir(cacheDirectory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) =>
        pluginGuideDocumentSchema.parse(
          JSON.parse(await readFile(join(cacheDirectory, file), "utf8")),
        ),
      ),
  );
}

async function savedDocument() {
  const documents = (await cacheDocuments()).filter(
    (document) => document.pluginId === PLUGIN_LIFECYCLE_ID && document.locale === "en-US",
  );
  expect(documents).toHaveLength(1);
  return documents[0]!;
}

async function screenshot(name: string) {
  await browser.saveScreenshot(join(artifactDirectory, `${name}.png`));
}
