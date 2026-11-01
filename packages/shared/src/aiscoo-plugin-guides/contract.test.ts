import { describe, expect, it } from "vitest";
import {
  PLUGIN_GUIDE_SECTIONS,
  parsePluginGuideResponse,
  pluginGuideDocumentSchema,
  pluginGuideTextDeltaSchema,
} from "./contract.js";

function guide(locale: "zh-CN" | "en-US" = "zh-CN") {
  return `# Plugin\n\n${PLUGIN_GUIDE_SECTIONS.map((section) => `## ${section.title[locale]}\n\n${section.id === "scenarios" ? "背景：销售月报。材料：sales.csv。示例：按地区汇总。产出：Excel。检查：总额一致。" : "A concrete, documented instruction."}`).join("\n\n")}`;
}

describe("plugin usage guide completion contract", () => {
  it.each(["zh-CN", "en-US"] as const)(
    "keeps the answer separate from the complete %s guide",
    (locale) => {
      const markdown = guide(locale);
      expect(
        parsePluginGuideResponse(
          `<reply>Added a sales example.</reply>\n<guide>\n${markdown}\n</guide>`,
          locale,
        ),
      ).toEqual({
        reply: "Added a sales example.",
        markdown,
      });
    },
  );

  it("rejects a truncated replacement instead of accepting a partial guide", () => {
    expect(() =>
      parsePluginGuideResponse(`<reply>Updating.</reply><guide>${guide()}`, "zh-CN"),
    ).toThrow();
  });

  it("rejects a replacement missing its preparation chapter", () => {
    const markdown = guide().replace(/## 使用前的准备[^]*?(?=## 快速上手)/u, "");
    expect(() =>
      parsePluginGuideResponse(`<reply>Updated.</reply><guide>${markdown}</guide>`, "zh-CN"),
    ).toThrow();
  });

  it("rejects chapter titles that exist only inside a code example", () => {
    expect(() =>
      parsePluginGuideResponse(
        `<reply>Updated.</reply><guide>\`\`\`markdown\n${guide()}\n\`\`\`</guide>`,
        "zh-CN",
      ),
    ).toThrow();
  });

  it("rejects duplicate chapters instead of saving an ambiguous template", () => {
    expect(() =>
      parsePluginGuideResponse(
        `<reply>Updated.</reply><guide>${guide()}\n\n## 快速上手\nDifferent instructions.</guide>`,
        "zh-CN",
      ),
    ).toThrow();
  });

  it("accepts fenced prompt examples inside the seven actual chapters", () => {
    const markdown = guide().replace(
      "A concrete, documented instruction.",
      "```text\n## An example input, not a chapter\n```",
    );
    expect(
      parsePluginGuideResponse(`<reply>Updated.</reply><guide>${markdown}</guide>`, "zh-CN")
        .markdown,
    ).toBe(markdown);
  });

  it("rejects a revision record with no source identity", () => {
    expect(
      pluginGuideDocumentSchema.safeParse({
        schemaVersion: 1,
        templateVersion: 1,
        pluginId: "tables@market",
        sourceIdentity: "",
        sourceRevision: "revision",
        fingerprint: "digest",
        locale: "en-US",
        markdown: guide("en-US"),
        messages: [],
        updatedAt: new Date(0).toISOString(),
        revision: "revision-1",
        sourcePaths: ["skills/xlsx/SKILL.md"],
        diagnostics: [],
      }).success,
    ).toBe(false);
  });

  it("rejects progress without an operation or with an invalid sequence", () => {
    expect(
      pluginGuideTextDeltaSchema.safeParse({ operationId: "", sequence: 1, text: "text" }).success,
    ).toBe(false);
    expect(
      pluginGuideTextDeltaSchema.safeParse({ operationId: "request-a", sequence: -1, text: "text" })
        .success,
    ).toBe(false);
  });
});
