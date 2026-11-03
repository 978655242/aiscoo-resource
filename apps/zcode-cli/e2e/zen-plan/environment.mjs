// 隔离 Aiscoo 测试环境：独立 SQLite、随机服务密钥、合成账号与不计费的本机上游。
// 不连接、不读取、不修改任何正式实例；结束时只清理本 harness 创建的进程和目录。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ACCEPTANCE_MODEL_ID = "zen-acceptance";
export const ACCEPTANCE_MARKER = "ZEN_ACCEPTANCE_OK";
const READY_TIMEOUT_MS = 30_000;

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`backend exited early (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`backend did not become ready: ${url}`);
}

/**
 * 受控 OpenAI 兼容上游。按请求内容返回：普通文本标记、工具调用（首轮）、
 * 或长时间流式输出（用于取消）。记录请求以便断言模型真正收到工具结果。
 */
export async function startSyntheticUpstream() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push(body);
    const last = JSON.stringify(body.messages?.at(-1) ?? {});
    const all = JSON.stringify(body.messages ?? []);
    const base = { id: `synthetic-${requests.length}`, created: Math.floor(Date.now() / 1000), model: ACCEPTANCE_MODEL_ID };
    const send = (delta, finish) =>
      response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    response.setHeader("Content-Type", "text/event-stream");
    if (all.includes("ZEN_SLOW_STREAM") && !all.includes('"role":"tool"')) {
      // 取消场景：持续输出直到客户端断开，不自行结束。
      send({ role: "assistant", content: "streaming" }, null);
      const timer = setInterval(() => send({ content: "." }, null), 100);
      request.on("close", () => clearInterval(timer));
      response.on("close", () => clearInterval(timer));
      return;
    }
    if (all.includes("ZEN_TOOL_CALL") && !all.includes('"role":"tool"')) {
      send({ role: "assistant", tool_calls: [{ index: 0, id: "call_zen_1", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "echo ZEN_TOOL_RESULT_42", description: "acceptance probe" }) } }] }, null);
      send({}, "tool_calls");
    } else if (last.includes("ZEN_TOOL_RESULT_42")) {
      send({ role: "assistant", content: `${ACCEPTANCE_MARKER} tool-ok` }, null);
      send({}, "stop");
    } else {
      send({ role: "assistant", content: ACCEPTANCE_MARKER }, null);
      send({}, "stop");
    }
    response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/** 启动隔离 Go 后端。passkeyOrigin 存在时在启动前写入隔离库，测试用 localhost RP。 */
export async function startIsolatedBackend({ binary, root, host = "127.0.0.1" }) {
  const port = await freePort();
  const origin = `http://${host}:${port}`;
  const dbPath = join(root, "new-api.db");
  const log = await open(join(root, "backend.log"), "w", 0o600);
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), SQLITE_PATH: dbPath,
    SESSION_SECRET: randomBytes(32).toString("hex"), CRYPTO_SECRET: randomBytes(32).toString("hex"),
    XCODE_INTEGRATION_ENABLED: "true", XCODE_PUBLIC_ORIGIN: origin,
    // 隔离实例会被同一 harness 多次快速授权，避免全局限流制造伪失败。
    GLOBAL_API_RATE_LIMIT_ENABLE: "false", GLOBAL_WEB_RATE_LIMIT_ENABLE: "false",
    CRITICAL_RATE_LIMIT_ENABLE: "false",
  };
  const start = () => spawn(binary, ["--log-dir", join(root, "logs")], { cwd: root, env, stdio: ["ignore", log.fd, log.fd] });
  let child = start();
  await waitForHttp(`${origin}/api/status`, child);
  return {
    origin, dbPath, root,
    db: () => new DatabaseSync(dbPath),
    /** 修改需要启动时加载的设置后重启同一数据库。 */
    async restart() {
      // 进程可能已被 stop()；对已退出进程等待 exit 事件会永久挂起。
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
      child = start();
      await waitForHttp(`${origin}/api/status`, child);
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    },
    async dispose() {
      await this.stop();
      await log.close();
    },
  };
}

export async function createAcceptanceRoot() {
  return mkdtemp(join(tmpdir(), "zen-plan-e2e-"));
}

export async function removeAcceptanceRoot(root) {
  await rm(root, { recursive: true, force: true });
}

export function randomPassword() {
  return `${randomBytes(18).toString("base64url")}Aa1!`;
}

/** 通过原生 setup 创建 root，再用原生注册接口创建普通合成账号。 */
export async function initializeAccounts(backend, usernames) {
  const rootPassword = randomPassword();
  const setup = await fetch(`${backend.origin}/api/setup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "zenroot", password: rootPassword, confirmPassword: rootPassword, SelfUseModeEnabled: false, DemoSiteEnabled: false }),
  }).then((response) => response.json());
  if (!setup.success) throw new Error("isolated setup failed");
  const accounts = {};
  for (const username of usernames) {
    const password = randomPassword();
    const result = await fetch(`${backend.origin}/api/user/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, password2: password }),
    }).then((response) => response.json());
    if (!result.success) throw new Error(`native register failed for ${username}: ${result.message}`);
    accounts[username] = { username, password };
  }
  return accounts;
}

function insert(db, table, values) {
  const row = { ...values };
  for (const column of db.prepare(`PRAGMA table_info(${table})`).all()) {
    if (column.notnull && column.dflt_value === null && !column.pk && !(column.name in row)) {
      row[column.name] = /int|real|decimal|numeric/i.test(column.type) ? 0 : "";
    }
  }
  const keys = Object.keys(row);
  return db
    .prepare(`INSERT INTO ${table}(${keys.map((key) => `"${key}"`).join(",")}) VALUES(${keys.map(() => "?").join(",")})`)
    .run(...keys.map((key) => row[key])).lastInsertRowid;
}

/** 管理员指定套餐是服务端事实；直接在隔离库写入，等价于管理员授权结果，不经过管理 UI。 */
export async function seedCatalog(backend, upstreamUrl) {
  const db = backend.db();
  const config = {
    schema_version: 1, api_type: "openai-chat-completions",
    model_config: {
      enabled: true,
      properties: {
        contextWindow: 32768, requiresMfjsToolSchema: false,
        inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
        outputFormat: { supportsText: true }, supportsToolCall: true, supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false, supportsMidConversationSystem: true,
      },
      optionSpecs: { reasoningLevel: { values: ["none"], map: "{}" }, maxOutputTokens: { max: 4096, map: '{"max_tokens": maxOutputTokens}' } },
    },
  };
  db.exec("BEGIN");
  try {
    const channel = insert(db, "channels", { type: 1, key: "synthetic-only", status: 1, name: "zen acceptance", base_url: upstreamUrl, models: ACCEPTANCE_MODEL_ID, group: "default", weight: 1, priority: 1 });
    insert(db, "abilities", { group: "default", model: ACCEPTANCE_MODEL_ID, channel_id: channel, enabled: 1, priority: 1, weight: 1 });
    insert(db, "models", { model_name: ACCEPTANCE_MODEL_ID, status: 1, x_code_config: JSON.stringify(config), name_rule: 0 });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  // 非自用模式下网关要求模型已定价；与运营在后台设置倍率等价，启动时加载。
  await setOptionsAndRestart(backend, { ModelRatio: JSON.stringify({ [ACCEPTANCE_MODEL_ID]: 1 }), CompletionRatio: JSON.stringify({ [ACCEPTANCE_MODEL_ID]: 1 }) });
}

export function assignPlan(backend, username) {
  const db = backend.db();
  const now = Math.floor(Date.now() / 1000);
  db.exec("BEGIN");
  try {
    const userId = db.prepare("SELECT id FROM users WHERE username=?").get(username).id;
    const plan = insert(db, "subscription_plans", { title: `Synthetic ${username}`, price_amount: 0, enabled: 1, total_amount: 0, quota_reset_period: "never", duration_unit: "month", duration_value: 1, currency: "USD" });
    const subscription = insert(db, "user_subscriptions", { user_id: userId, plan_id: plan, amount_total: 0, amount_used: 0, start_time: now, end_time: now + 86_400, status: "active", source: "admin", usage_scope: "zen", quota_reset_period_snapshot: "never", quota_reset_generation: 1, last_reset_time: now, next_reset_time: 0, created_at: now, updated_at: now });
    const existing = db.prepare("SELECT revision FROM x_code_authorizations WHERE user_id=?").get(userId);
    if (existing) db.prepare("UPDATE x_code_authorizations SET subscription_id=?, revision=?, updated_at=? WHERE user_id=?").run(subscription, Number(existing.revision) + 1, now, userId);
    else insert(db, "x_code_authorizations", { user_id: userId, subscription_id: subscription, revision: 1, updated_at: now });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

/** 撤销指定套餐：清除 designation，等价于管理员撤销授权。 */
export function revokePlan(backend, username) {
  const db = backend.db();
  try {
    const userId = db.prepare("SELECT id FROM users WHERE username=?").get(username).id;
    db.prepare("DELETE FROM x_code_authorizations WHERE user_id=?").run(userId);
  } finally {
    db.close();
  }
}

export function sessionsFor(backend, username) {
  const db = backend.db();
  try {
    return db
      .prepare("SELECT s.sid, s.client_id, s.client_purpose, s.status, s.revoked_at FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE u.username=? ORDER BY s.created_at")
      .all(username)
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

/** 写入启动时加载的 Option 后重启；仅用于隔离库，例如启用 localhost Passkey。 */
export async function setOptionsAndRestart(backend, options) {
  const db = backend.db();
  try {
    for (const [key, value] of Object.entries(options)) {
      db.prepare('INSERT INTO options("key","value") VALUES(?,?) ON CONFLICT("key") DO UPDATE SET "value"=excluded."value"').run(key, value);
    }
  } finally {
    db.close();
  }
  await backend.restart();
}

export async function writePrivateJson(path, value) {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

/**
 * 透明代理：把指定路径的上游响应延迟返回，制造“服务端已处理、客户端未收到”的窗口。
 * forwarded 在上游已完成处理（响应已收到）时 resolve。
 */
export async function startDelayingProxy(targetOrigin, delayedPath, delayMs) {
  let markForwarded;
  const forwarded = new Promise((resolveForwarded) => { markForwarded = resolveForwarded; });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const headers = { ...request.headers };
    delete headers.host;
    delete headers["content-length"];
    const upstream = await fetch(new URL(request.url, targetOrigin), { method: request.method, headers, body: body || undefined, redirect: "manual" });
    const payload = Buffer.from(await upstream.arrayBuffer());
    if (request.url.startsWith(delayedPath)) {
      markForwarded();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    const outHeaders = Object.fromEntries([...upstream.headers].filter(([name]) => !["content-encoding", "transfer-encoding", "content-length"].includes(name)));
    response.writeHead(upstream.status, outHeaders);
    response.end(payload);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    forwarded,
    close: () => new Promise((resolveClose) => { server.closeAllConnections(); server.close(resolveClose); }),
  };
}
