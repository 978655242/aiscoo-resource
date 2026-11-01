import { describe, expect, it } from "vitest";
import {
  createPluginGuideService,
  response,
  selection,
  setup,
  source,
  target,
} from "../src/aiscoo-plugin-guides/test-fixtures.js";

describe("plugin guide isolated model selection", () => {
  it("defaults to the preferred identity's lowest reasoning and persists actual selection", async () => {
    const fixture = await setup();
    const ordinary = await fixture.dependencies.readModelSelectionView(target);
    const generated = await fixture.service.generate({ target, operationId: "default-selection" });
    expect(generated.phase).toBe("ready");
    expect(fixture.requests[0]?.selection).toEqual({
      ...selection,
      options: { reasoningLevel: "low" },
    });
    expect(generated.document?.selection).toEqual({
      ...selection,
      options: { reasoningLevel: "low" },
    });
    expect((await fixture.repository.read(source, "en-US"))?.selection).toEqual(
      generated.document?.selection,
    );
    expect(ordinary.preferredSelection?.options?.reasoningLevel).toBe("max");
    expect((await fixture.dependencies.readModelSelectionView(target)).preferredSelection).toEqual(
      ordinary.preferredSelection,
    );
  });

  it("pins an explicit alternate model and reasoning and reopens its persisted selection", async () => {
    const fixture = await setup();
    const chosen = {
      providerId: "alternate-provider",
      modelId: "alternate-model",
      options: { reasoningLevel: "high" },
    };
    const generated = await fixture.service.generate({
      target,
      operationId: "chosen-model",
      selection: chosen,
    });
    expect(generated.phase).toBe("ready");
    expect(fixture.requests[0]?.selection).toEqual(chosen);
    expect(generated.document).toMatchObject({
      providerId: "alternate-provider",
      modelId: "alternate-model",
      selection: chosen,
    });
    const reopened = await createPluginGuideService(fixture.dependencies).read(target);
    expect(reopened.document?.selection).toEqual(chosen);
  });

  it.each([
    { providerId: "missing-provider", modelId: "guide-model", options: { reasoningLevel: "low" } },
    { ...selection, modelId: "removed-model", options: { reasoningLevel: "low" } },
    { ...selection, options: { reasoningLevel: "unsupported" } },
    { ...selection },
  ])("rejects an unavailable choice %j without replacing the saved guide", async (chosen) => {
    const fixture = await setup();
    await fixture.service.generate({ target, operationId: "saved" });
    const rejected = await fixture.service.generate({
      target,
      operationId: "unavailable",
      question: "Explain the example.",
      selection: chosen,
    });
    expect(rejected.phase).toBe("error");
    expect(rejected.error).toBeTruthy();
    expect(rejected.document?.revision).toBe("saved");
    expect(rejected.messages.at(-1)?.content).toBe("Explain the example.");
    expect(fixture.requests).toHaveLength(1);
    expect((await fixture.repository.read(source, "en-US"))?.revision).toBe("saved");
  });

  it.each([
    { providerId: "different-account" },
    { modelId: "different-model" },
    { options: { reasoningLevel: "low" } },
  ])("rejects facade normalization %j rather than executing a different choice", async (change) => {
    const fixture = await setup();
    await fixture.service.generate({ target, operationId: "saved" });
    const readView = fixture.dependencies.readModelSelectionView;
    fixture.dependencies.readModelSelectionView = async (route, chosen) => ({
      ...(await readView(route, chosen)),
      ...(chosen ? { effectiveSelection: { ...chosen, ...change } } : {}),
    });
    const rejected = await fixture.service.generate({
      target,
      operationId: "normalized",
      regenerate: true,
      selection: { ...selection, options: { reasoningLevel: "max" } },
    });
    expect(rejected.phase).toBe("error");
    expect(rejected.document?.revision).toBe("saved");
    expect(fixture.requests).toHaveLength(1);
    expect((await fixture.repository.read(source, "en-US"))?.revision).toBe("saved");
  });

  it("saves the actual executor selection rather than reconstructing requested metadata", async () => {
    const fixture = await setup(async () => ({
      text: response(),
      selection: { ...selection, options: { reasoningLevel: "high" } },
      finishReason: "stop",
    }));
    const generated = await fixture.service.generate({ target, operationId: "actual-selection" });
    expect(generated.document?.selection).toEqual({
      ...selection,
      options: { reasoningLevel: "high" },
    });
  });

  it.each(["issue", "missing-effective"] as const)(
    "rejects facade %s even when the requested identity still exists in the catalog",
    async (failure) => {
      const fixture = await setup();
      await fixture.service.generate({ target, operationId: "saved" });
      const readView = fixture.dependencies.readModelSelectionView;
      fixture.dependencies.readModelSelectionView = async (route, chosen) => ({
        ...(await readView(route, chosen)),
        ...(chosen
          ? failure === "issue"
            ? { selectionIssue: "account-connection-unavailable" as const }
            : { effectiveSelection: null }
          : {}),
      });
      const rejected = await fixture.service.generate({
        target,
        operationId: "invalid-view",
        regenerate: true,
        selection: { ...selection, options: { reasoningLevel: "high" } },
      });
      expect(rejected.phase).toBe("error");
      expect(fixture.requests).toHaveLength(1);
      expect((await fixture.repository.read(source, "en-US"))?.revision).toBe("saved");
    },
  );

  it("reads legacy cached guides without selection metadata or an available model", async () => {
    const fixture = await setup();
    const generated = await fixture.service.generate({ target, operationId: "legacy" });
    expect(generated.document).toBeTruthy();
    await fixture.repository.withLock(source, target.locale, () =>
      fixture.repository.save(target, { ...generated.document!, selection: undefined }),
    );
    const offline = createPluginGuideService({
      ...fixture.dependencies,
      readModelSelectionView: async () => {
        throw new Error("No model configured");
      },
    });
    const cached = await offline.read(target);
    expect(cached.phase).toBe("ready");
    expect(cached.document?.revision).toBe("legacy");
    expect(cached.document?.selection).toBeUndefined();
    expect(fixture.requests).toHaveLength(1);
  });
});
