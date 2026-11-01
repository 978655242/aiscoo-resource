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
//   AISCOO_RELEASE_OSS_HOST     下载域名，例如 aiscoo-releases.oss-cn-hangzhou.aliyuncs.com（必填）
//   AISCOO_RELEASE_OSS_PROFILE  ossutil 配置文件里的 profile，可选
//   AISCOO_ADMIN_BASE_URL       aiscoo-admin origin（必填，与桌面包编译的账号源一致）
//   AISCOO_ADMIN_ACCESS_TOKEN   root 的个人访问令牌（--execute 时必填，需 ops:write，不写入日志）
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";

const run = promisify(execFile);

function fail(message) {
  console.error(`[aiscoo-publish] ERROR: ${message}`);
  process.exit(1);
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
const adminOrigin = process.env.AISCOO_ADMIN_BASE_URL?.trim();
if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
  fail("AISCOO_RELEASE_OSS_BUCKET 缺失或非法");
if (!downloadHost || !/^[a-z0-9.-]+$/.test(downloadHost))
  fail("AISCOO_RELEASE_OSS_HOST 缺失或非法");
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
const [file] = feed.files;
const zipPath = join(artifactDir, file.url);
const zipStat = await stat(zipPath).catch(() => fail(`找不到 zip：${zipPath}`));
const sha512 = createHash("sha512")
  .update(await readFile(zipPath))
  .digest("base64");
if (sha512 !== file.sha512 || zipStat.size !== file.size) {
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
  files: [{ url: downloadUrl, sha512, size: zipStat.size }],
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

// 已存在即停止：同一版本同一构建标识的对象不能被替换，换包必须换构建标识或版本。
const existing = await run("ossutil", ["stat", ossTarget, ...profileArgs]).then(
  () => true,
  () => false,
);
if (existing) fail(`OSS 上已存在 ${ossTarget}，拒绝覆盖`);
await run("ossutil", [
  "cp",
  zipPath,
  ossTarget,
  ...profileArgs,
  "--meta",
  "Cache-Control:public, max-age=31536000, immutable",
]);
console.log("[aiscoo-publish] 已上传，开始校验公开下载");
const head = await fetch(downloadUrl, { method: "HEAD" });
if (!head.ok || Number(head.headers.get("content-length")) !== zipStat.size) {
  fail(
    `公开下载校验失败：HTTP ${head.status}，content-length ${head.headers.get("content-length")}`,
  );
}

const response = await fetch(adminUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify(payload),
});
const body = await response.json().catch(() => ({}));
if (!response.ok || body.success !== true) {
  fail(`登记失败：HTTP ${response.status} ${body.message ?? ""}`.trim());
}
console.log(
  `[aiscoo-publish] 已登记 id=${body.data?.id} status=${body.data?.status} rollout=${body.data?.rollout_percentage}%`,
);
console.log(
  '[aiscoo-publish] 全量发布：PATCH /api/v1/admin/releases/<id>，正文 {"status":1}（单独确认后执行）',
);
