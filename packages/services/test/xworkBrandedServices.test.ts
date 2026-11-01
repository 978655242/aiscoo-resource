import { X509Certificate } from "node:crypto";
import * as yauzl from "yauzl";
import { createFeedbackDiagnosticArchive } from "../src/feedback/feedbackLogArchive.js";
import { ConversationShareHttpClient } from "../src/conversation-share/conversationShareHttpClient.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPluginGuideMessages } from "../src/aiscoo-plugin-guides/domain/prompt.js";
import { source, target } from "../src/aiscoo-plugin-guides/test-fixtures.js";
import { BigModelCodingPlanSubscriptionProvider } from "../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import { CREDENTIAL_DECRYPT_ERROR_CODE, ZCODE_PROTOCOL_NAME } from "@zcode/shared";
import {
  desktopMenuMessageIds,
  desktopMenuMessages,
  formatDesktopMenuMessage,
} from "../../shared/src/desktopMenu.js";
import {
  ZCODE_AGENT_PROVIDER,
  ZCODE_AGENT_PROVIDER_LABEL,
} from "../../shared/src/zcode-agent-policy.js";
import { ZCODE_AGENT_RUNTIME } from "../../shared/src/zcode-agent-runtime.js";
import { FEEDBACK_TICKET_FRAMEWORK_OPTIONS } from "../../shared/src/feedback.js";
import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES } from "../../shared/src/zcode-slash-command-help.js";
import {
  formatZCodeMainProcessName,
  formatZCodeRendererProcessName,
} from "../../shared/src/process-names.js";
import { formatBotMessage } from "../src/bots/messages.js";
import {
  buildWorkspaceFileSearchIgnoreTemplate,
  resetWorkspaceFileSearchIgnoreDefaults,
  WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
} from "../src/file/workspaceFileIgnore.js";
import { readHostCredentialRecords } from "../src/credential/credentialService.js";
import { buildCheckpointEnv } from "../src/git/repo/gitCheckpointHelpers.js";
import { setDataBaseDir } from "../src/paths.js";
import { ensureAppCaCert, getAppCaCertPaths } from "../src/runtime-tools/appCaCert.js";
import { BigModelProviderAdapter } from "../src/oauth/providers/bigmodelProviderAdapter.js";
import { BIGMODEL_OAUTH_PROVIDER_CONFIG } from "../src/oauth/providers/bigmodelProviderConfig.js";
import {
  ZCodeProtocolRequestTimeoutError,
  ZCodeProtocolClient,
} from "../src/zcode-agent/zcodeProtocolClient.js";
import {
  ZCodeAgentMcpStatusModeUnsupportedError,
  isZCodeAgentMcpStatusModeUnsupportedError,
} from "../src/zcode-agent/zcodeAgentErrors.js";

const tempDirectories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "aiscoo-branded-services-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  setDataBaseDir(null);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Aiscoo product display boundaries", () => {
  it("brands only the diagnostic archive title and preserves original log text", async () => {
    const directory = await temporaryDirectory();
    const original = "XWork / ZCode original diagnostic text\n";
    await writeFile(join(directory, "host.log"), original);
    const archive = await createFeedbackDiagnosticArchive({
      sources: [{ directory, archivePrefix: "host", onlyCurrentDay: false }],
      outputRootDir: join(directory, "archives"),
    });
    const entries = await new Promise<Map<string, string>>((resolve, reject) => {
      yauzl.open(archive.path, { lazyEntries: true }, (error, zip) => {
        if (error || !zip) {
          reject(error ?? new Error("archive unavailable"));
          return;
        }
        const found = new Map<string, string>();
        zip.on("error", reject);
        zip.on("entry", (entry) => {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              zip.close();
              reject(streamError ?? new Error("entry unavailable"));
              return;
            }
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("error", reject);
            stream.on("end", () => {
              found.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
              zip.readEntry();
            });
          });
        });
        zip.on("end", () => resolve(found));
        zip.readEntry();
      });
    });
    expect(entries.get("about.txt")).toContain("Aiscoo diagnostic logs");
    expect(entries.get("host/host.log")).toBe(original);
    expect(archive.path).toContain("zcode-diagnostic-logs.zip");
  });

  it("brands share upgrade guidance while preserving share titles and unsupported-version classification", async () => {
    const preview = (schemaVersion: number) =>
      Response.json({
        code: 0,
        msg: "",
        data: {
          schema_version: schemaVersion,
          share: {
            title: "XWork / ZCode project",
            access_mode: "public_readonly",
            created_at: 1,
            expires_at: 2,
          },
          rows: [],
          artifacts: [],
          integrity: { projection_sha256: "a".repeat(64), artifact_set_sha256: "a".repeat(64) },
        },
      });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(preview(1))
      .mockResolvedValueOnce(preview(999));
    const client = new ConversationShareHttpClient({
      apiClient: { request },
      baseUrl: "https://example.invalid/api/v1",
      tokenProvider: async () => null,
    });
    await expect(client.getPreview("XWork-ZCode")).resolves.toMatchObject({
      share: { title: "XWork / ZCode project" },
    });
    await expect(client.getPreview("XWork-ZCode")).rejects.toMatchObject({
      kind: "unsupported_schema_version",
      message: "Conversation share payload requires a newer Aiscoo version",
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      "https://example.invalid/api/v1/shares/XWork-ZCode/preview",
    );
  });

  it("loads endpoint configuration natively in Node with the existing service origins", async () => {
    const endpointUrl = new URL("../../shared/src/zcodeEndpoint.ts", import.meta.url).href;
    const code = `
      import assert from 'node:assert/strict';
      import { normalizeZCodeEndpointOrigin, DEFAULT_ZCODE_ENDPOINT_ORIGIN } from ${JSON.stringify(endpointUrl)};
      assert.equal(DEFAULT_ZCODE_ENDPOINT_ORIGIN, 'https://zcode.z.ai');
      assert.equal(normalizeZCodeEndpointOrigin('https://example.invalid/XWork/ZCode'), 'https://example.invalid');
      assert.throws(() => normalizeZCodeEndpointOrigin(''), { message: 'Aiscoo endpoint origin is empty' });
      assert.throws(() => normalizeZCodeEndpointOrigin('ftp://example.invalid'), { message: 'Aiscoo endpoint origin must use http or https' });
    `;
    await expect(
      promisify(execFile)(process.execPath, ["--input-type=module", "--eval", code]),
    ).resolves.toMatchObject({ stdout: "" });
  });

  it("brands the guide system prompt before adding external materials and user questions", () => {
    const material = "ZCode official plugin: preserve XWork documentation and https://zcode.z.ai";
    const question = "Explain XWork and ZCode as written in this plugin";
    const messages = buildPluginGuideMessages({
      target,
      source: { ...source, documents: [{ path: "XWork/ZCode/SKILL.md", text: material }] },
      document: null,
      question,
    });
    expect(messages[0]?.content).toContain("plugin usage guides for Aiscoo");
    expect(messages[1]?.content).toContain(material);
    expect(messages[1]?.content).toContain("XWork/ZCode/SKILL.md");
    expect(messages.at(-1)?.content).toBe(question);
  });

  it.each([
    ["getStaticProducts", "Aiscoo client config missing Coding Plan products"],
    ["getStaticTeamProducts", "Aiscoo client config missing Coding Plan team products"],
  ] as const)(
    "brands local %s errors and leaves server-authored messages untouched",
    async (method, message) => {
      const request = vi.fn<typeof fetch>();
      const createProvider = () =>
        new BigModelCodingPlanSubscriptionProvider({
          apiClient: { request },
          credentialService: { load: async () => null },
        });
      request.mockResolvedValueOnce(Response.json({ code: 0, data: { configs: {} } }));
      await expect(createProvider()[method]()).rejects.toThrow(message);
      request.mockResolvedValueOnce(
        Response.json({ code: 7, msg: "XWork / ZCode server response" }),
      );
      await expect(createProvider()[method]()).rejects.toThrow("XWork / ZCode server response");
    },
  );

  it.each(["zh-CN", "en-US"] as const)(
    "projects bot and native menu templates before %s interpolation",
    (locale) => {
      const userValue = "XWork / ZCode / /tmp/XWork/ZCode / https://zcode.z.ai";
      expect(formatBotMessage(locale, "helpTitle")).toContain("Aiscoo");
      expect(formatBotMessage(locale, "userNotBound")).toContain("Aiscoo UI");
      const remoteHint = formatBotMessage(locale, "remoteReconnectUnavailable", {
        workspacePath: userValue,
      });
      expect(remoteHint).toContain(userValue);
      expect(remoteHint).toContain("Aiscoo");
      expect(formatBotMessage(locale, "taskFailed", { message: userValue })).toContain(userValue);
      expect(desktopMenuMessages[locale][desktopMenuMessageIds.helpAbout]).toContain("Aiscoo");
      expect(desktopMenuMessages[locale][desktopMenuMessageIds.trayTooltip]).toBe("Aiscoo");
      expect(
        formatDesktopMenuMessage(locale, desktopMenuMessageIds.appHide, { appName: userValue }),
      ).toContain(userValue);
      expect(desktopMenuMessageIds.trayOpenZCode).toBe("tray.menu.openZCode");
    },
  );

  it("keeps workspace rules and stable section markers while branding only the generated header", () => {
    const template = buildWorkspaceFileSearchIgnoreTemplate(null);
    expect(template).toContain("# Aiscoo 工作区文件搜索忽略规则（.zcodeignore）");
    expect(template).toContain("# 语法与 .gitignore 一致，只影响 Aiscoo 的 @ 文件候选");
    expect(template).toContain(WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER);
    expect(WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER).toContain("ZCode");
    const userRules = "# XWork and ZCode are project names\nXWork/ZCode/\n";
    expect(buildWorkspaceFileSearchIgnoreTemplate(userRules)).toContain(userRules);
    const customized = `${template}\n# keep XWork\nZCode/\n`;
    expect(resetWorkspaceFileSearchIgnoreDefaults(customized, null)).toContain(
      "# keep XWork\nZCode/\n",
    );
  });

  it("brands shared Agent labels and slash help without changing runtime identity", () => {
    expect(ZCODE_AGENT_PROVIDER_LABEL).toBe("Aiscoo Agent");
    expect(FEEDBACK_TICKET_FRAMEWORK_OPTIONS).toContainEqual({
      value: "zcode-agent",
      label: "Aiscoo Agent",
    });
    expect(
      BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find((entry) => entry.name === "logout")?.details,
    ).toEqual(["Deletes Z.ai OAuth credentials from the shared Aiscoo credential store."]);
    expect(ZCODE_AGENT_RUNTIME.missingBinaryMessage).toContain("[Aiscoo Agent]");
    expect(ZCODE_AGENT_RUNTIME.binaryEnvVar).toBe("GLM_BINARY_PATH");
    expect(ZCODE_AGENT_RUNTIME.nativeConfigDir).toBe(".zcode/cli");
    expect(ZCODE_AGENT_PROVIDER).toBe("glm");
    expect(ZCODE_PROTOCOL_NAME).toBe("ZCode Protocol");
  });

  it("recognizes branded window titles while keeping technical process names compatible", () => {
    expect(formatZCodeMainProcessName()).toBe("zcode-main");
    for (const title of ["Aiscoo", "XWork", "XCode"]) {
      expect(formatZCodeRendererProcessName(title)).toBe("zcode-renderer-main");
      expect(formatZCodeRendererProcessName(`${title} - devbox`)).toBe(
        "zcode-renderer-remote-devbox",
      );
    }
  });

  it("brands credential recovery errors without rewriting the selected path or error code", async () => {
    const directory = await temporaryDirectory();
    const unreadable = join(directory, "XWork-ZCode-credentials");
    await writeFile(unreadable, "{broken");
    await expect(
      readHostCredentialRecords(() => null, { credentialsFile: unreadable }),
    ).rejects.toMatchObject({
      code: CREDENTIAL_DECRYPT_ERROR_CODE,
      message: "Aiscoo credentials require manual storage recovery",
    });
    await expect(
      readHostCredentialRecords(() => null, { credentialsFile: directory }),
    ).rejects.toThrow(`Unable to read Aiscoo credentials: ${directory}`);
    expect(await readFile(unreadable, "utf8")).toBe("{broken");
  });

  it("brands checkpoint authors but preserves ref storage, email and user paths", () => {
    const env = buildCheckpointEnv("/tmp/XWork/ZCode/index");
    expect(env).toEqual({
      GIT_INDEX_FILE: "/tmp/XWork/ZCode/index",
      GIT_AUTHOR_NAME: "Aiscoo Checkpoint",
      GIT_COMMITTER_NAME: "Aiscoo Checkpoint",
      GIT_AUTHOR_EMAIL: "checkpoint@zcode.local",
      GIT_COMMITTER_EMAIL: "checkpoint@zcode.local",
    });
  });

  it("brands newly generated CA subjects and reuses any existing certificate and key", async () => {
    setDataBaseDir(await temporaryDirectory());
    const certPath = ensureAppCaCert();
    const { keyPath } = getAppCaCertPaths();
    const cert = new X509Certificate(await readFile(certPath));
    expect(cert.subject).toContain("CN=Aiscoo Network CA");
    expect(cert.subject).toContain("O=Aiscoo");
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(certPath).toContain("zcode-network-ca.pem");
    await writeFile(certPath, "existing XWork certificate");
    await writeFile(keyPath, "existing ZCode key");
    expect(ensureAppCaCert()).toBe(certPath);
    expect(await readFile(certPath, "utf8")).toBe("existing XWork certificate");
    expect(await readFile(keyPath, "utf8")).toBe("existing ZCode key");
  });

  it("brands locally generated OAuth errors but preserves upstream messages and provider identity", async () => {
    const request = vi.fn<typeof fetch>();
    const adapter = new BigModelProviderAdapter(BIGMODEL_OAUTH_PROVIDER_CONFIG, { request });
    const context = {
      providerId: "bigmodel" as const,
      state: "state",
      redirectUri: "zcode://oauth/callback",
      now: () => 0,
    };
    request.mockResolvedValueOnce(Response.json({ code: 7 }));
    await expect(
      adapter.exchangeToken({ code: "test-code", state: "state" }, context),
    ).rejects.toThrow("BigModel Aiscoo token 交换失败（code: 7）");
    request.mockResolvedValueOnce(Response.json({ code: 0, data: {} }));
    await expect(
      adapter.exchangeToken({ code: "test-code", state: "state" }, context),
    ).rejects.toThrow("BigModel Aiscoo token 交换失败：响应缺少 data.token");
    request.mockResolvedValueOnce(Response.json({ code: 0, data: { token: "jwt" } }));
    await expect(
      adapter.exchangeToken({ code: "test-code", state: "state" }, context),
    ).rejects.toThrow("BigModel Aiscoo token 交换失败：响应缺少 data.bigmodel.access_token");
    request.mockResolvedValueOnce(Response.json({ code: 7, msg: "ZCode upstream: XWork account" }));
    await expect(
      adapter.exchangeToken({ code: "test-code", state: "state" }, context),
    ).rejects.toThrow("ZCode upstream: XWork account");
    expect(adapter.meta.displayName).toBe("BigModel");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      provider: "bigmodel",
      redirect_uri: "zcode://oauth/callback",
    });
  });

  it("retains typed errors and external transport reasons while branding protocol diagnostics", async () => {
    const timeout = new ZCodeProtocolRequestTimeoutError("session/read", 1, 10);
    expect(timeout).toMatchObject({
      message: "Aiscoo Protocol request timed out: session/read",
      method: "session/read",
      requestId: 1,
      timeoutMs: 10,
    });
    const unsupported = new ZCodeAgentMcpStatusModeUnsupportedError();
    expect(unsupported.message).toContain("Aiscoo Agent");
    expect(isZCodeAgentMcpStatusModeUnsupportedError(unsupported)).toBe(true);
    const messageEmitter = new Emitter<never>();
    const closeEmitter = new Emitter<{ reason?: string }>();
    const client = new ZCodeProtocolClient({
      kind: "memory",
      send: async () => {},
      onMessage: messageEmitter.event,
      onClose: closeEmitter.event,
      dispose() {},
    });
    try {
      const pending = client.request("session/read", { sessionId: "s" });
      closeEmitter.fire({ reason: "XWork / ZCode disconnected" });
      await expect(pending).rejects.toThrow(
        "Aiscoo agent transport closed: XWork / ZCode disconnected",
      );
    } finally {
      client.dispose();
      messageEmitter.dispose();
      closeEmitter.dispose();
    }
  });
});
