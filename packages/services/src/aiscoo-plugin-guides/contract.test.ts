import { describe, expect, it } from "vitest";
import type { PluginGuideRepository } from "./contract.js";
import { response, selection, setup, source, target } from "./test-fixtures.js";
import { createPluginGuideService } from "./app/service.js";
import { createPluginGuideFileRepository } from "./adapters/repository.js";

describe("plugin guide Host ownership and persistence", () => {
  it("reopens a complete guide and questions after owner recreation without another model request", async () => {
    const fixture = await setup();
    const generated = await fixture.service.generate({ target, operationId: "first" });
    expect(generated.phase).toBe("ready");
    const reopened = await createPluginGuideService({
      ...fixture.dependencies,
      repository: createPluginGuideFileRepository(fixture.root),
    }).read(target);
    expect(reopened.document?.markdown).toContain("Summarize monthly sales");
    expect(reopened.document?.revision).toBe("first");
    expect(fixture.requests).toHaveLength(1);
  });

  it("answers a follow-up and durably replaces all seven chapters without ordinary session state", async () => {
    let turn = 0;
    const fixture = await setup(async (request) => {
      const text = response(
        ++turn === 1
          ? undefined
          : "Budget scenario: compare planned and actual spend, then check the variance total.",
      );
      request.onDelta(text);
      return { text, selection, finishReason: "stop" };
    });
    await fixture.service.generate({ target, operationId: "first" });
    const changed = await fixture.service.generate({
      target,
      operationId: "question",
      question: "Add a budget example and explain variance.",
    });
    expect(changed.document?.markdown).toContain("Budget scenario");
    expect(changed.document?.messages.find((message) => message.role === "user")?.content).toBe(
      "Add a budget example and explain variance.",
    );
    expect(
      fixture.requests[1]?.messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("Summarize monthly sales"),
      ),
    ).toBe(true);
    const reopened = await createPluginGuideService(fixture.dependencies).read(target);
    expect(reopened.document?.revision).toBe("question");
    expect(reopened.document?.messages).toEqual(changed.document?.messages);
  });

  it("shares a first generation and keeps a failed replacement from overwriting saved content", async () => {
    const { promise: waiting, resolve: finish } = Promise.withResolvers<void>();
    let fail = false;
    const fixture = await setup(async () => {
      await waiting;
      if (fail) throw new Error("Provider unavailable");
      return { text: response(), selection, finishReason: "stop" };
    });
    const first = fixture.service.generate({ target, operationId: "first" });
    const duplicate = fixture.service.generate({ target, operationId: "another-open" });
    finish();
    await Promise.all([first, duplicate]);
    expect(fixture.requests).toHaveLength(1);
    fail = true;
    const failed = await fixture.service.generate({
      target,
      operationId: "failed",
      regenerate: true,
    });
    expect(failed.phase).toBe("error");
    expect(failed.document?.revision).toBe("first");
    expect((await fixture.repository.read(source, "en-US"))?.revision).toBe("first");
  });

  it("retains the previous guide after an incomplete or length-limited answer", async () => {
    const fixture = await setup();
    await fixture.service.generate({ target, operationId: "first" });
    fixture.dependencies.streamText = async () => ({
      text: response("Partial new instructions"),
      selection,
      finishReason: "length",
    });
    const failed = await fixture.service.generate({
      target,
      operationId: "cut-short",
      question: "Expand the examples.",
    });
    expect(failed.phase).toBe("error");
    expect((await fixture.repository.read(source, "en-US"))?.revision).toBe("first");
  });

  it("retries only the disk write after a save failure", async () => {
    const fixture = await setup();
    let writes = 0;
    const repository: PluginGuideRepository = {
      ...fixture.repository,
      save: async (inputTarget, document) => {
        if (writes++ === 0) throw new Error("Disk full");
        return fixture.repository.save(inputTarget, document);
      },
    };
    const service = createPluginGuideService({ ...fixture.dependencies, repository });
    const unsaved = await service.generate({ target, operationId: "first" });
    expect(unsaved.phase).toBe("unsaved");
    expect(unsaved.previewMarkdown).toContain("Summarize monthly sales");
    await expect(
      service.generate({ target, operationId: "replace-unsaved", regenerate: true }),
    ).rejects.toThrow("Save the completed guide");
    const saved = await service.retrySave(target);
    expect(saved.phase).toBe("ready");
    expect(saved.document?.revision).toBe("first");
    expect(fixture.requests).toHaveLength(1);
  });

  it("keeps source identities and locales in separate files and marks updated content stale", async () => {
    const fixture = await setup();
    await fixture.service.generate({ target, operationId: "first" });
    expect(
      await fixture.repository.read({ ...source, sourceIdentity: "source-b" }, "en-US"),
    ).toBeNull();
    expect(await fixture.repository.read(source, "zh-CN")).toBeNull();
    const changed = createPluginGuideService({
      ...fixture.dependencies,
      readSource: async () => ({ ...source, fingerprint: "content-v2" }),
    });
    const state = await changed.read(target);
    expect(state.stale).toBe(true);
    expect(state.document?.revision).toBe("first");
    expect(fixture.requests).toHaveLength(1);
  });

  it("cancels only the matching active operation and preserves its saved predecessor", async () => {
    const fixture = await setup();
    await fixture.service.generate({ target, operationId: "first" });
    const { promise: admitted, resolve: started } = Promise.withResolvers<void>();
    fixture.dependencies.streamText = async (request) => {
      started();
      const { promise: cancelled, reject } = Promise.withResolvers<void>();
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      await cancelled;
      throw new Error("unreachable");
    };
    const generation = fixture.service.generate({
      target,
      operationId: "cancelled",
      question: "Add more detail.",
    });
    await admitted;
    await fixture.service.cancel({ target, operationId: "unrelated" });
    await fixture.service.cancel({ target, operationId: "cancelled" });
    const cancelled = await generation;
    expect(cancelled.phase).toBe("cancelled");
    expect((await fixture.repository.read(source, "en-US"))?.revision).toBe("first");
  });

  it.each([
    { version: "2.0.0" },
    { remoteSessionId: "new-attachment" },
    { workspacePath: "/relocated-workspace" },
  ])("isolates an in-flight guide from a changed route %j", async (change) => {
    const { promise: admitted, resolve: started } = Promise.withResolvers<void>();
    const { promise: waiting, resolve: finish } = Promise.withResolvers<void>();
    const fixture = await setup(async () => {
      started();
      await waiting;
      return { text: response(), selection, finishReason: "stop" };
    });
    const original = { ...target, workspaceIdentity: "remote-workspace" };
    const next = { ...original, ...change };
    const running = fixture.service.generate({ target: original, operationId: "original" });
    await admitted;
    const switched = await fixture.service.read(next);
    await fixture.service.cancel({ target: next, operationId: "original" });
    finish();
    const completed = await running;
    expect(switched.target).toEqual(next);
    expect(switched.phase).toBe("idle");
    expect(completed.phase).toBe("ready");
    expect((await fixture.service.read(next)).target).toEqual(next);
  });

  it("retains a failed question and error across leaving and reopening the reader", async () => {
    const fixture = await setup();
    await fixture.service.generate({ target, operationId: "first" });
    const stream = fixture.dependencies.streamText;
    fixture.dependencies.streamText = async () => {
      throw new Error("Provider offline");
    };
    await fixture.service.generate({
      target,
      operationId: "failed-question",
      question: "Add a budget example.",
    });
    const reopened = await fixture.service.read(target);
    expect(reopened.phase).toBe("error");
    expect(reopened.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Add a budget example.",
    });
    fixture.dependencies.streamText = stream;
    const retried = await fixture.service.generate({
      target,
      operationId: "retried",
      question: reopened.messages.at(-1)?.content,
    });
    expect(retried.phase).toBe("ready");
    expect(retried.document?.messages.filter((message) => message.role === "user")).toEqual([
      { id: "retried:user", role: "user", content: "Add a budget example." },
    ]);
  });

  it("reads the saved guide offline without making a model request", async () => {
    const fixture = await setup();
    await fixture.service.generate({ target, operationId: "first" });
    const offline = createPluginGuideService({
      ...fixture.dependencies,
      readSource: async () => {
        throw new Error("Source offline");
      },
    });
    const cached = await offline.read(target);
    expect(cached.phase).toBe("ready");
    expect(cached.document?.revision).toBe("first");
    expect(cached.stale).toBe(true);
    expect(fixture.requests).toHaveLength(1);
  });

  it("reuses the committed first guide across two Host owners sharing the disk lock", async () => {
    const { promise: admitted, resolve: started } = Promise.withResolvers<void>();
    const { promise: waiting, resolve: finish } = Promise.withResolvers<void>();
    const fixture = await setup(async () => {
      started();
      await waiting;
      return { text: response(), selection, finishReason: "stop" };
    });
    const secondOwner = createPluginGuideService({
      ...fixture.dependencies,
      repository: createPluginGuideFileRepository(fixture.root),
    });
    const first = fixture.service.generate({ target, operationId: "first" });
    await admitted;
    const second = secondOwner.generate({ target, operationId: "second-opener" });
    finish();
    const results = await Promise.all([first, second]);
    expect(results.map((state) => state.document?.revision)).toEqual(["first", "first"]);
    expect(fixture.requests).toHaveLength(1);
  });

  it("loads another window's newer guide instead of trapping a conflicting save retry", async () => {
    const fixture = await setup();
    await fixture.service.generate({ target, operationId: "first" });
    const service = createPluginGuideService({
      ...fixture.dependencies,
      repository: {
        ...fixture.repository,
        save: async (inputTarget, document) => {
          if (document.revision === "pending") throw new Error("Disk full");
          await fixture.repository.save(inputTarget, document);
        },
      },
    });
    const pending = await service.generate({
      target,
      operationId: "pending",
      question: "Add a budget example.",
    });
    expect(pending.phase).toBe("unsaved");
    await fixture.service.generate({
      target,
      operationId: "newer",
      question: "Explain verification.",
    });
    const recovered = await service.retrySave(target);
    expect(recovered.phase).toBe("ready");
    expect(recovered.document?.revision).toBe("newer");
    expect(recovered.error).toContain("another window");
    expect((await fixture.repository.read(source, "en-US"))?.revision).toBe("newer");
    expect(fixture.requests).toHaveLength(3);
  });
});
