#!/usr/bin/env node
// 发布 macOS 应用内更新：上传 build-macos-update-feed.sh 的产物到 OSS，再到 aiscoo-admin 登记版本。
// 规则见 docs/aiscoo/specs/aiscoo-auto-update.md 第 4、5 节。
//
// 默认只预演：读取产物、校验 sha512/size、打印将上传的对象与登记载荷，不联网、不写入。
// 加 --execute 才会真正上传与登记。新版本只能以灰度（status=3）或下线（status=0）登记，
// 全量需要之后单独调用管理接口改 status=1。
//
// 用法：
//   node scripts/aiscoo/publish-macos-update.mjs <产物目录> --build-id <构建标识>
//        [--rollout <0-100>] [--allow-device <device_mid>]... [--withdrawn] [--execute]
// 环境变量：
//   AISCOO_RELEASE_OSS_BUCKET   OSS 桶名，例如 aiscoo-releases（必填）
//   AISCOO_RELEASE_OSS_HOST     HTTPS 下载 host，可含端口（必填）
//   AISCOO_RELEASE_OSS_REGION   OSS region，默认 cn-hangzhou
//   AISCOO_RELEASE_OSS_ENDPOINT OSS 服务 endpoint，默认 oss-cn-hangzhou.aliyuncs.com
//   AISCOO_RELEASE_OSS_PROFILE  显式传给 ossutil 的 profile，可选；不设置则沿用当前配置
//   AISCOO_ADMIN_BASE_URL       aiscoo-admin origin（必填，与桌面包编译的账号源一致）
//   AISCOO_ADMIN_ACCESS_TOKEN   root 的个人访问令牌（--execute 时必填，需 ops:write，不写入日志）
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const run = promisify(execFile);

function fail(message) {
  console.error(`[aiscoo-publish] ERROR: ${message}`);
  process.exit(1);
}

function validHost(host) {
  if (!host || !/^[a-z0-9.-]+(?::[0-9]+)?$/.test(host)) return false;
  try {
    return new URL(`https://${host}`).host === host;
  } catch {
    return false;
  }
}

function validZipBasename(value) {
  // feed 文件名既用于本地路径也用于 OSS URL：仅允许无转义的 basename，防止目录穿越。
  return (
    typeof value === "string" &&
    value.endsWith(".zip") &&
    /^[0-9A-Za-z][0-9A-Za-z._-]*\.zip$/.test(value)
  );
}

async function hashStream(stream, expectedSize) {
  const hash = createHash("sha512");
  let size = 0;
  // zip 可能超过 1 GB，本地与 HTTPS 下载复用逐块哈希，避免把整个安装包读进内存。
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > expectedSize) throw new Error("size exceeds manifest");
    hash.update(chunk);
  }
  return { sha512: hash.digest("base64"), size };
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "build-id": { type: "string" },
    rollout: { type: "string", default: "0" },
    "allow-device": { type: "string", multiple: true, default: [] },
    withdrawn: { type: "boolean", default: false },
    execute: { type: "boolean", default: false },
  },
});
const [artifactDirArg] = positionals;
if (!artifactDirArg) fail("缺少产物目录参数");
const artifactDir = resolve(artifactDirArg);
const buildId = values["build-id"]?.trim();
if (!buildId || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(buildId)) {
  fail("--build-id 必填，只允许字母、数字、点、下划线与连字符");
}
const rolloutPercentage = Number(values.rollout);
if (!Number.isInteger(rolloutPercentage) || rolloutPercentage < 0 || rolloutPercentage > 100) {
  fail("--rollout 必须是 0 到 100 的整数");
}

const bucket = process.env.AISCOO_RELEASE_OSS_BUCKET?.trim();
const downloadHost = process.env.AISCOO_RELEASE_OSS_HOST?.trim().toLowerCase();
const region = process.env.AISCOO_RELEASE_OSS_REGION?.trim() || "cn-hangzhou";
const endpoint = process.env.AISCOO_RELEASE_OSS_ENDPOINT?.trim() || "oss-cn-hangzhou.aliyuncs.com";
const adminOrigin = process.env.AISCOO_ADMIN_BASE_URL?.trim();
if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
  fail("AISCOO_RELEASE_OSS_BUCKET 缺失或非法");
if (!validHost(downloadHost)) fail("AISCOO_RELEASE_OSS_HOST 缺失或非法");
if (!/^[a-z0-9-]+$/.test(region)) fail("AISCOO_RELEASE_OSS_REGION 非法");
if (!validHost(endpoint)) fail("AISCOO_RELEASE_OSS_ENDPOINT 必须是 OSS 服务 host");
let adminUrl;
try {
  adminUrl = new URL("/api/v1/admin/releases", adminOrigin);
  if (new URL(adminOrigin).origin !== adminOrigin.replace(/\/$/, ""))
    throw new Error("not an origin");
} catch {
  fail("AISCOO_ADMIN_BASE_URL 缺失或不是 origin（形如 https://host:port）");
}
if (
  adminUrl.protocol !== "https:" &&
  !["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname)
) {
  fail("AISCOO_ADMIN_BASE_URL 必须是 https（本机回环地址除外）");
}

const feed = parseYaml(await readFile(join(artifactDir, "latest-mac.yml"), "utf8"));
if (typeof feed?.version !== "string" || !Array.isArray(feed.files) || feed.files.length !== 1) {
  fail("latest-mac.yml 格式不符：需要 version 与恰好一个 files 条目");
}
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
if (!versionPattern.test(feed.version) || /\s/.test(feed.version)) {
  fail("latest-mac.yml version 必须是合法语义化版本");
}
const [file] = feed.files;
if (!validZipBasename(file?.url)) fail("files[0].url 必须是安全的 zip basename");
if (feed.path !== undefined && (!validZipBasename(feed.path) || feed.path !== file.url)) {
  fail("latest-mac.yml path 必须与 files[0].url 的 zip basename 一致");
}
if (
  typeof file.sha512 !== "string" ||
  !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
  Buffer.from(file.sha512, "base64").toString("base64") !== file.sha512 ||
  !Number.isSafeInteger(file.size) ||
  file.size <= 0
) {
  fail("latest-mac.yml 的 sha512 或 size 非法");
}
const zipPath = join(artifactDir, file.url);
let localFile;
try {
  const zipStat = await stat(zipPath);
  if (!zipStat.isFile() || zipStat.size !== file.size) throw new Error("size mismatch");
  localFile = await hashStream(createReadStream(zipPath), file.size);
} catch {
  fail("zip 读取失败或 size 不符；请检查本地产物与 latest-mac.yml");
}
const { sha512, size } = localFile;
if (sha512 !== file.sha512 || size !== file.size) {
  fail("zip 的 sha512 或大小与 latest-mac.yml 不一致；请重新运行 build-macos-update-feed.sh");
}

// 与官网 DMG 相同的版本化目录；版本内对象不可覆盖。
const objectKey = `releases/aiscoo/${feed.version}/macos/arm64/${buildId}/${file.url}`;
const downloadUrl = `https://${downloadHost}/${objectKey}`;
const payload = {
  version: feed.version,
  platform: "darwin-aarch64",
  status: values.withdrawn ? 0 : 3,
  rollout_percentage: rolloutPercentage,
  device_mid_allowlist: values["allow-device"],
  minimum_system_version: feed.minimumSystemVersion ?? "",
  release_date: Math.floor(Date.parse(feed.releaseDate) / 1000) || 0,
  release_notes_by_locale: feed.releaseNotesByLocale ?? {},
  files: [{ url: downloadUrl, sha512, size }],
};

console.log(`[aiscoo-publish] 上传：${zipPath} -> oss://${bucket}/${objectKey}`);
console.log(`[aiscoo-publish] 下载地址：${downloadUrl}`);
console.log(`[aiscoo-publish] 登记：POST ${adminUrl.origin}${adminUrl.pathname}`);
console.log(JSON.stringify(payload, null, 2));
console.log(
  `[aiscoo-publish] 前置条件：aiscoo-admin 的 DESKTOP_RELEASE_ALLOWED_HOSTS 必须包含 ${downloadHost}`,
);
if (!values.execute) {
  console.log("[aiscoo-publish] 预演结束，未上传、未登记。确认无误后加 --execute。");
  process.exit(0);
}

const accessToken = process.env.AISCOO_ADMIN_ACCESS_TOKEN?.trim();
if (!accessToken) fail("--execute 需要 AISCOO_ADMIN_ACCESS_TOKEN");
const profileArgs = process.env.AISCOO_RELEASE_OSS_PROFILE?.trim()
  ? ["--profile", process.env.AISCOO_RELEASE_OSS_PROFILE.trim()]
  : [];
const ossTarget = `oss://${bucket}/${objectKey}`;

// stat 预检存在竞争且会把权限/网络错误误判为不存在；交给 OSS 原子拒绝覆盖，任何失败都停止。
try {
  await run("aliyun", [
    "--auto-plugin-install",
    "false",
    "ossutil",
    "api",
    "put-object",
    "--bucket",
    bucket,
    "--key",
    objectKey,
    "--body",
    `file://${zipPath}`,
    "--region",
    region,
    "--endpoint",
    endpoint,
    "--forbid-overwrite=true",
    // 发布对象需公开下载；显式对象 ACL 避免继承 private 桶权限，不修改桶 ACL。
    "--object-acl",
    "public-read",
    "--cache-control",
    "public, max-age=31536000, immutable",
    ...profileArgs,
  ]);
} catch {
  // 不回显云 CLI 的原始错误，以免外部工具输出凭据；服务端冲突、403 与网络失败一律不登记。
  fail(`OSS 上传失败：${ossTarget}；拒绝覆盖或权限/网络异常，请检查 CLI 配置后重试`);
}
console.log("[aiscoo-publish] 已上传，开始校验公开下载");
try {
  // HEAD 只能证明长度；逐字节 GET 校验后才允许登记，且拒绝重定向到另一下载源。
  const download = await fetch(downloadUrl, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (download.status !== 200 || !download.body) {
    await download.body?.cancel();
    throw new Error("download failed");
  }
  const contentLength = download.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== size) {
    await download.body.cancel();
    throw new Error("content-length mismatch");
  }
  const downloaded = await hashStream(download.body, size);
  if (downloaded.sha512 !== sha512 || downloaded.size !== size) {
    throw new Error("sha512 or size mismatch");
  }
} catch {
  fail("公开下载校验失败：HTTPS GET 未完成或 sha512/size 不符，未登记版本");
}

let response;
try {
  response = await fetch(adminUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(payload),
  });
} catch {
  fail("登记失败：管理接口网络异常或重定向，请检查后重试");
}
const body = await response.json().catch(() => ({}));
if (!response.ok || body?.success !== true) {
  // 管理端错误正文可能反射请求头，不写入日志，保留 HTTP 状态用于诊断。
  fail(`登记失败：HTTP ${response.status}`);
}
console.log(
  `[aiscoo-publish] 已登记 id=${body.data?.id} status=${body.data?.status} rollout=${body.data?.rollout_percentage}%`,
);
console.log(
  '[aiscoo-publish] 全量发布：PATCH /api/v1/admin/releases/<id>，正文 {"status":1}（单独确认后执行）',
);
