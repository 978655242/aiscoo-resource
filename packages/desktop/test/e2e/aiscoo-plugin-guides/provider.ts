import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  PLUGIN_GUIDE_DOCUMENT_END,
  PLUGIN_GUIDE_DOCUMENT_START,
  PLUGIN_GUIDE_REPLY_END,
  PLUGIN_GUIDE_REPLY_START,
  PLUGIN_GUIDE_SECTIONS,
  type PluginGuideLocale,
} from "@zcode/shared/aiscoo-plugin-guides";
import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";

type Mode = "held" | "complete" | "failure" | "continuation";
type RequestRecord = { body: Record<string, unknown>; completed: boolean; aborted: boolean };
export interface PluginGuideProvider {
  baseURL: string;
  requests: RequestRecord[];
  setMode(mode: Mode): void;
  release(): void;
  close(): Promise<void>;
}
const MAX_REQUEST_BYTES = 1024 * 1024;

function readBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown> | null>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const onData = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      request.off("data", onData);
      chunks.length = 0;
      response.writeHead(413).end("Fixture request exceeds its body limit");
      request.resume();
      resolve(null);
      return;
    }
    chunks.push(chunk);
  };
  request.on("data", onData);
  request.once("error", reject);
  request.once("aborted", () => reject(new Error("Fixture request aborted")));
  request.once("end", () => {
    if (bytes > MAX_REQUEST_BYTES) return;
    try {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Expected a JSON object");
      resolve(body as Record<string, unknown>);
    } catch (error) {
      reject(error);
    }
  });
  return promise;
}

function guideParts(
  locale: PluginGuideLocale,
  revised: boolean,
): { preview: string; remainder: string } {
  const zh = locale === "zh-CN";
  const marker = revised ? "GUIDE_REVISED" : "GUIDE_INITIAL";
  const bodies = zh
    ? [
        `${marker}\n\n这个测试插件帮助整理输入材料，产出可核对的说明。本文依据提供的插件资料编写；查看说明不会安装或运行插件。`,
        "适合第一次了解插件、准备输入材料及检查输出。资料不足以确认的能力应先查阅来源，不应依赖猜测。",
        "先阅读插件详情与资料，确认实际入口及依赖。这里没有确认任何额外账号或配置要求，不要提供密钥。",
        "1. 阅读插件资料，确认触发入口。\n2. 准备一段不含敏感信息的材料。\n3. 按资料描述的入口提出整理请求。\n4. 查看结果，逐项与原始材料核对。",
        `### 场景一：整理项目交接材料\n\n背景：同事需要快速了解交接内容。输入：下面这段示例材料。复制提示词：\n\n\`\`\`text\n请依据这份材料整理交接清单，列出负责人、下一步和待确认问题：界面已完成，测试由小林负责，发布时间待确认。不要补充材料中没有的事实。\n\`\`\`\n\n预期产出：交接清单和待确认项。检查：保留原负责人，并将发布时间标为待确认。\n\n### 场景二：准备首次试用\n\n背景：新同事准备尝试插件。输入：插件资料及一段示例材料。复制提示词：\n\n\`\`\`text\n请根据插件资料列出首次使用步骤，并把无法确认的前置条件单独列出。\n\`\`\`\n\n预期产出：可执行的步骤和资料缺口。检查：每个入口与条件均能回溯到来源。${revised ? "\n\n补充说明：按用户问题细化了场景与结果检查方式。" : ""}`,
        "输出需要人工核对；本文不代表已安装、启用或运行插件。资料没有确认的能力、费用和外部依赖保持未知。",
        "问：查看说明会执行插件吗？答：不会。问：如何确认实际能力？答：回到插件详情并核对随请求提供的来源文档；当前测试未提供可引用的具体文档路径。",
      ]
    : [
        `${marker}\n\nThis fixture plugin helps organize supplied material into a reviewable explanation. This guide uses the supplied plugin materials; reading it does not install or run the plugin.`,
        "Use it to understand the plugin, prepare inputs, and review outputs. Consult the sources before relying on any capability the materials do not establish.",
        "Read the plugin details and materials to confirm its entry point and dependencies. No additional account or configuration requirement is established here. Do not provide secrets.",
        "1. Read the materials and identify the actual entry point.\n2. Prepare a short input without sensitive information.\n3. Submit the request through the documented entry point.\n4. Compare the output with the original material.",
        `### Scenario one: organize a project handover\n\nContext: a colleague needs a concise handover. Input: the sample material below. Copyable prompt:\n\n\`\`\`text\nTurn this material into a handover checklist with owners, next steps, and open questions: the interface is complete, Alex owns testing, and the release date is unconfirmed. Do not add facts absent from the material.\n\`\`\`\n\nExpected output: a checklist and open questions. Check that the owner is preserved and the release date remains unconfirmed.\n\n### Scenario two: prepare a first trial\n\nContext: a new colleague wants to try the plugin. Inputs: the plugin materials and a short sample. Copyable prompt:\n\n\`\`\`text\nUse the plugin materials to list the first-use steps and separately identify prerequisites the sources do not confirm.\n\`\`\`\n\nExpected output: actionable steps and evidence gaps. Check that each entry point and prerequisite can be traced to a source.${revised ? "\n\nRevision: expanded the scenarios and output checks in response to the follow-up question." : ""}`,
        "Review the output manually. This guide does not indicate the plugin is installed, enabled, or running. Unconfirmed capabilities, costs, and external dependencies remain unknown.",
        "Does reading the guide execute the plugin? No. How can I verify its capabilities? Return to the plugin details and review the source documents supplied with the request; this fixture has no established source path to cite.",
      ];
  const sections = PLUGIN_GUIDE_SECTIONS.map(
    (section, index) => `## ${section.title[locale]}\n\n${bodies[index]}`,
  );
  const reply = zh
    ? revised
      ? "已根据你的问题调整说明，并补充场景与检查方法。"
      : "已整理首次使用说明，包含七个章节与可复制的场景示例。"
    : revised
      ? "I updated the guide with more detailed scenarios and result checks."
      : "The first guide includes seven sections and copyable scenario examples.";
  return {
    preview: `${PLUGIN_GUIDE_REPLY_START}${reply}${PLUGIN_GUIDE_REPLY_END}\n${PLUGIN_GUIDE_DOCUMENT_START}\n# Plugin\n\n${sections[0]}\n\n`,
    remainder: `${sections.slice(1).join("\n\n")}\n${PLUGIN_GUIDE_DOCUMENT_END}`,
  };
}

export async function startPluginGuideProvider(): Promise<PluginGuideProvider> {
  let mode: Mode = "held";
  let successfulGuides = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const requests: RequestRecord[] = [];
  const held = new Set<() => void>();
  const release = () => {
    for (const resume of held) resume();
  };
  const server = createServer((request, response) => {
    response.on("error", () => response.destroy());
    void handle(request, response).catch(() => {
      if (!response.destroyed && !response.headersSent)
        response.writeHead(400).end("Invalid fixture request");
      else response.destroy();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing || request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(closing ? 503 : 404).end("Unsupported fixture request");
      return;
    }
    const body = await readBody(request, response);
    if (!body || response.destroyed) return;
    const record: RequestRecord = { body, completed: false, aborted: false };
    requests.push(record);
    let successful = false;
    let resume: (() => void) | undefined;
    response.once("finish", () => {
      record.completed = true;
      if (successful) successfulGuides += 1;
    });
    response.once("close", () => {
      if (!record.completed) record.aborted = true;
      resume?.();
    });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages
      .filter(
        (message): message is { role: string; content: string } =>
          !!message &&
          typeof message === "object" &&
          message.role === "system" &&
          typeof message.content === "string",
      )
      .map((message) => message.content)
      .join("\n");
    if (
      body.stream !== true ||
      typeof body.model !== "string" ||
      !system.includes(`plugin usage guides for ${PRODUCT_NAME}`) ||
      !system.includes(PLUGIN_GUIDE_DOCUMENT_START)
    ) {
      response.writeHead(422).end("Expected a streamed plugin guide request");
      return;
    }
    if (mode === "failure") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Plugin guide fixture failure",
            type: "server_error",
            code: "fixture_failure",
          },
        }),
      );
      return;
    }
    let gate = Promise.resolve();
    if (mode === "held") {
      const pending = Promise.withResolvers<void>();
      const releaseGate = () => {
        held.delete(releaseGate);
        pending.resolve();
      };
      resume = releaseGate;
      held.add(releaseGate);
      gate = pending.promise;
    }
    const locale = system.includes("Simplified Chinese") ? "zh-CN" : "en-US";
    const parts = guideParts(locale, successfulGuides > 0);
    const id = `chatcmpl-plugin-guide-${requests.length}`;
    const created = Math.floor(Date.now() / 1000);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.flushHeaders();
    const event = (choices: unknown[], usage?: Record<string, number>) =>
      response.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices, ...(usage ? { usage } : {}) })}\n\n`,
      );
    const choice = (
      delta: Record<string, string>,
      finish_reason: "stop" | "length" | null = null,
    ) => ({
      index: 0,
      delta,
      finish_reason,
    });
    const stream = async (text: string) => {
      for (let offset = 0; offset < text.length; offset += 96) {
        if (response.destroyed) return;
        event([choice({ content: text.slice(offset, offset + 96) })]);
        await delay(5);
      }
    };
    event([choice({ role: "assistant", content: "" })]);
    const continuing =
      mode === "continuation" &&
      messages.at(-1)?.content ===
        "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";
    if (!continuing) await stream(parts.preview);
    await gate;
    if (response.destroyed) return;
    if (mode !== "continuation" || continuing) await stream(parts.remainder);
    if (response.destroyed) return;
    const truncated = mode === "continuation" && !continuing;
    event([choice({}, truncated ? "length" : "stop")]);
    event([], { prompt_tokens: 120, completion_tokens: 240, total_tokens: 360 });
    successful = !truncated;
    response.end("data: [DONE]\n\n");
  }

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Plugin guide fixture has no loopback address");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setMode(nextMode) {
      mode = nextMode;
    },
    release,
    close() {
      if (!closePromise) {
        const pending = Promise.withResolvers<void>();
        closePromise = pending.promise;
        closing = true;
        release();
        server.close((error) => (error ? pending.reject(error) : pending.resolve()));
        server.closeAllConnections();
      }
      return closePromise;
    },
  };
}
