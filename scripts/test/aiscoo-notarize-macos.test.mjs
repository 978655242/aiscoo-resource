import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const script = join(repoRoot, "scripts/aiscoo/notarize-macos.sh");
const submissionId = "00000000-1111-2222-3333-444444444444";
const identity = "Developer ID Application: Synthetic Fixture (TESTONLY)";
const unixOnly = { skip: process.platform === "win32" ? "需要 Bash，Windows 跳过" : false };
const canReadPlist =
  process.platform === "darwin" &&
  (await access("/usr/libexec/PlistBuddy", constants.X_OK).then(
    () => true,
    () => false,
  ));
const newOnly = {
  skip: canReadPlist ? false : "新打包用例需要 macOS /usr/libexec/PlistBuddy；续跑用例仍执行",
};

// 只放行文件处理工具；所有 Apple 工具由显式 fake 接管，PATH/HOME 不继承用户环境。
const localTools = [
  "bash",
  "dirname",
  "basename",
  "mkdir",
  "cat",
  "grep",
  "mktemp",
  "find",
  "tr",
  "awk",
  "sort",
  "cut",
  "rm",
  "tail",
  "head",
  "ln",
];
const fakeTools = [
  "security",
  "codesign",
  "xcodebuild",
  "xcrun",
  "lipo",
  "file",
  "hdiutil",
  "ditto",
  "spctl",
  "sleep",
];
const fakeSource = String.raw`
import assert from "node:assert/strict";
import { appendFileSync, cpSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
const [tool, ...args] = process.argv.slice(2);
const env = process.env;
appendFileSync(env.FAKE_CALLS, JSON.stringify({ tool, args }) + "\n");
const fail = (code) => { process.stderr.write("synthetic failure: " + tool + " " + args.join(" ") + "\n"); process.exit(code); };
if (env.FAKE_FORBID_BUILD === "1" && (["codesign", "lipo", "file", "hdiutil", "ditto"].includes(tool) || (tool === "security" && args[0] !== "unlock-keychain"))) fail(90);
const checkDmg = (path) => assert.equal(realpathSync(path), realpathSync(env.FAKE_DMG));
switch (tool) {
  case "security":
    assert.equal(args.at(-1), env.FAKE_KEYCHAIN);
    if (args[0] === "unlock-keychain") {
      assert.equal(args[2], "synthetic-password");
    } else {
      assert.equal(args[0], "find-identity");
      process.stdout.write(env.FAKE_IDENTITY + "\n");
    }
    break;
  case "xcodebuild": break;
  case "lipo": process.stdout.write("arm64\n"); break;
  case "file": process.stdout.write("Mach-O 64-bit arm64\n"); break;
  case "codesign":
    if (args[0] === "-dvv") process.stderr.write("Authority=" + env.FAKE_IDENTITY + "\nTimestamp=synthetic\n");
    break;
  case "ditto": cpSync(args[0], args[1], { recursive: true }); break;
  case "hdiutil":
    assert.equal(args[0], "create");
    assert.equal(args.at(-1), env.FAKE_DMG);
    writeFileSync(args.at(-1), "synthetic original DMG bytes\n");
    break;
  case "xcrun":
    if (args[0] === "notarytool") {
      assert.equal(args[args.indexOf("--keychain") + 1], env.FAKE_KEYCHAIN);
      assert.equal(args[args.indexOf("--keychain-profile") + 1], "synthetic-profile");
      switch (args[1]) {
        case "submit":
          checkDmg(args[2]);
          process.stdout.write(JSON.stringify({ id: env.FAKE_SUBMISSION_ID, path: args[2], message: "synthetic upload" }, null, 2) + "\n");
          break;
        case "info":
          assert.equal(args[2], env.FAKE_SUBMISSION_ID);
          process.stdout.write(JSON.stringify({ id: args[2], status: env.FAKE_STATUS || "Accepted" }));
          break;
        case "log":
          assert.equal(args[2], env.FAKE_SUBMISSION_ID);
          writeFileSync(args.at(-1), JSON.stringify({ status: env.FAKE_STATUS, synthetic: true }));
          break;
        default: fail(91);
      }
    } else {
      assert.equal(args[0], "stapler");
      assert.ok(["staple", "validate"].includes(args[1]));
      checkDmg(args[2]);
      if (env.FAKE_FAIL === args[1]) fail(args[1] === "staple" ? 43 : 44);
      process.stdout.write("synthetic " + args[1] + " succeeded\n");
    }
    break;
  case "spctl":
    checkDmg(args.at(-1));
    if (env.FAKE_FAIL === "spctl") fail(45);
    break;
  case "sleep": break;
  default: fail(92);
}
`;
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function toolPath(name) {
  const dirs =
    name === "python3"
      ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
      : ["/usr/bin", "/bin"];
  for (const dir of dirs) {
    const path = join(dir, name);
    if (
      await access(path, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return path;
  }
  throw new Error(`离线回归需要本地工具 ${name}`);
}

async function fixture(t, { app = false } = {}) {
  // 临时文件也留在当前 worktree，避免其他 checkout 或真实签名目录被写入。
  const root = await mkdtemp(join(repoRoot, ".aiscoo notary test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const out = join(root, "original output");
  const sign = join(root, "synthetic signing");
  const tmp = join(root, "tmp");
  const appPath = join(root, "app parent", "Synthetic App.app");
  const dmg = join(out, "Synthetic App-1.2.3-mac-arm64.dmg");
  const record = join(out, "notary-submit.json");
  const callsPath = join(root, "calls.jsonl");
  const keychain = join(sign, "aiscoo-signing.keychain-db");
  const entitlements = join(root, "synthetic-entitlements.plist");
  await Promise.all([bin, home, out, sign, tmp].map((path) => mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(keychain, "synthetic keychain, never opened by security"),
    writeFile(join(sign, "keychain.pass"), "synthetic-password\n"),
    writeFile(entitlements, "<plist><dict/></plist>"),
    writeFile(callsPath, ""),
    writeFile(join(bin, "fake-tools.mjs"), fakeSource),
  ]);
  await Promise.all(
    [...localTools, "python3"].map(async (name) => symlink(await toolPath(name), join(bin, name))),
  );
  const fakeWrapper = `#!/bin/bash\nexec ${shellQuote(process.execPath)} ${shellQuote(join(bin, "fake-tools.mjs"))} "\${0##*/}" "$@"\n`;
  await Promise.all(
    fakeTools.map((name) => writeFile(join(bin, name), fakeWrapper, { mode: 0o755 })),
  );
  if (app) {
    await Promise.all(
      ["MacOS", "Frameworks", "Resources"].map((dir) =>
        mkdir(join(appPath, "Contents", dir), { recursive: true }),
      ),
    );
    await writeFile(
      join(appPath, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Synthetic App</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
<key>CFBundleExecutable</key><string>synthetic</string>
</dict></plist>`,
    );
    await writeFile(join(appPath, "Contents", "MacOS", "synthetic"), "synthetic executable");
    await writeFile(
      join(appPath, "Contents", "Resources", "synthetic.node"),
      "synthetic native module",
    );
  }
  const env = {
    PATH: bin,
    HOME: home,
    TMPDIR: tmp,
    LANG: "C",
    AISCOO_SIGN_DIR: sign,
    AISCOO_SIGN_IDENTITY: identity,
    AISCOO_NOTARY_PROFILE: "synthetic-profile",
    AISCOO_ENTITLEMENTS: entitlements,
    AISCOO_ENTITLEMENTS_INHERIT: entitlements,
    AISCOO_DMG_TEMPLATE: join(root, "absent-template.dmg"),
    AISCOO_NOTARY_TIMEOUT_MIN: "0",
    AISCOO_NOTARY_POLL_SEC: "60",
    FAKE_CALLS: callsPath,
    FAKE_DMG: dmg,
    FAKE_KEYCHAIN: keychain,
    FAKE_IDENTITY: identity,
    FAKE_SUBMISSION_ID: submissionId,
  };
  const run = async ({ resume = true, extraEnv = {}, outPath = out, flags = [], command } = {}) => {
    const childEnv = {
      ...env,
      ...(resume ? { AISCOO_NOTARY_SUBMISSION_ID: submissionId, FAKE_FORBID_BUILD: "1" } : {}),
      ...extraEnv,
    };
    const args = command ? ["-c", command] : [script, appPath, outPath, ...flags];
    try {
      const result = await exec("/bin/bash", args, { cwd: root, env: childEnv, timeout: 15000 });
      return { code: 0, output: result.stdout + result.stderr };
    } catch (error) {
      assert.equal(error.killed, false, "脚本不应卡住或超时被测试强杀");
      return { code: error.code, output: error.stdout + error.stderr };
    }
  };
  const seed = async (fields = {}) => {
    await writeFile(dmg, "synthetic original DMG bytes\n");
    const raw =
      JSON.stringify(
        { id: submissionId, path: dmg, message: "keep this original record", ...fields },
        null,
        2,
      ) + "\n";
    await writeFile(record, raw);
    return raw;
  };
  const calls = async () =>
    (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { root, appPath, out, dmg, record, keychain, entitlements, run, seed, calls };
}

const notaryCalls = (calls, action) =>
  calls.filter(
    ({ tool, args }) => tool === "xcrun" && args[0] === "notarytool" && args[1] === action,
  );
const finalCalls = (calls) =>
  calls
    .filter(({ tool, args }) => tool === "spctl" || (tool === "xcrun" && args[0] === "stapler"))
    .map(({ tool, args }) => (tool === "spctl" ? tool : args[1]));

function assertFailed(result, pattern) {
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, pattern);
  assert.doesNotMatch(result.output, /完成：/);
}

async function assertRejectedBeforeApple(f, result, pattern) {
  assertFailed(result, pattern);
  assert.deepEqual(
    (await f.calls()).filter(({ tool }) => tool !== "xcodebuild"),
    [],
  );
}

test("new 超时后按输出命令同目录续跑 Accepted，累计只提交一次并保留原记录", newOnly, async (t) => {
  const f = await fixture(t, { app: true });
  const first = await f.run({ resume: false, extraEnv: { FAKE_STATUS: "In Progress" } });
  assertFailed(first, /等待超过.*Apple/);
  const originalRecord = await readFile(f.record, "utf8");
  const originalDmg = await readFile(f.dmg);
  assert.equal(notaryCalls(await f.calls(), "submit").length, 1);
  assert.deepEqual(finalCalls(await f.calls()), []);
  const command = first.output.match(/续跑命令：(.+)/)?.[1];
  assert.ok(command, first.output);
  await rm(dirname(f.appPath), { recursive: true });
  await rm(f.entitlements);
  const resumed = await f.run({ command });
  assert.equal(resumed.code, 0, resumed.output);
  assert.equal(notaryCalls(await f.calls(), "submit").length, 1);
  assert.deepEqual(finalCalls(await f.calls()), ["staple", "validate", "spctl"]);
  assert.equal(await readFile(f.record, "utf8"), originalRecord);
  assert.deepEqual(await readFile(f.dmg), originalDmg);
});

test("resume 不要求 APP 父目录、plist、entitlements 或签名身份", unixOnly, async (t) => {
  const f = await fixture(t);
  const original = await f.seed();
  await rm(f.entitlements);
  const result = await f.run({ extraEnv: { AISCOO_SIGN_IDENTITY: "does-not-exist" } });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /完成：/);
  const calls = await f.calls();
  assert.equal(notaryCalls(calls, "submit").length, 0);
  assert.deepEqual(
    calls.filter(({ tool }) => tool === "security").map(({ args }) => args[0]),
    ["unlock-keychain"],
  );
  assert.deepEqual(finalCalls(calls), ["staple", "validate", "spctl"]);
  assert.equal(await readFile(f.record, "utf8"), original);
});

test("resume 不读取已有但无 Info.plist 的 APP", unixOnly, async (t) => {
  const f = await fixture(t);
  await f.seed();
  await mkdir(f.appPath, { recursive: true });
  const result = await f.run();
  assert.equal(result.code, 0, result.output);
});

for (const aliasSide of ["OUT_DIR", "record.path"]) {
  test(`resume 规范化空格和目录别名（${aliasSide}），不改写提交记录`, unixOnly, async (t) => {
    const f = await fixture(t);
    const alias = join(f.root, "output alias");
    await symlink(await realpath(f.out), alias);
    const original = await f.seed(
      aliasSide === "record.path" ? { path: join(alias, "Synthetic App-1.2.3-mac-arm64.dmg") } : {},
    );
    const result = await f.run({ outPath: aliasSide === "OUT_DIR" ? alias : f.out });
    assert.equal(result.code, 0, result.output);
    assert.equal(await readFile(f.record, "utf8"), original);
  });
}

const invalidRecords = [
  ["缺记录", undefined, /找不到.*notary-submit\.json/],
  ["坏 JSON", "{broken", /提交记录.*JSON/],
  ["非对象 JSON", "[]", /提交记录.*JSON 对象/],
  ["缺 id", { id: undefined }, /提交记录.*id/],
  ["错误 id 类型", { id: 123 }, /提交记录.*id/],
  ["id 不同", { id: "different-submission" }, /id.*不匹配/],
  ["缺 path", { path: undefined }, /提交记录.*path/],
  ["空 path", { path: "" }, /提交记录.*path/],
  ["错误 path 类型", { path: 123 }, /提交记录.*path/],
  ["相对 path", { path: "Synthetic App-1.2.3-mac-arm64.dmg" }, /path.*绝对/],
];
for (const [name, record, pattern] of invalidRecords) {
  test(`resume 拒绝${name}，不猜测现有 DMG`, unixOnly, async (t) => {
    const f = await fixture(t);
    await f.seed(typeof record === "object" ? record : {});
    if (record === undefined) await rm(f.record);
    else if (typeof record === "string") await writeFile(f.record, record);
    const before = await readFile(f.record, "utf8").catch(() => null);
    await assertRejectedBeforeApple(f, await f.run(), pattern);
    assert.equal(await readFile(f.record, "utf8").catch(() => null), before);
  });
}

for (const kind of [
  "缺输出目录",
  "DMG 不存在",
  "DMG 是目录",
  "外部路径",
  "父目录穿越",
  "DMG 链接到外部",
]) {
  test(`resume 拒绝${kind}`, unixOnly, async (t) => {
    const f = await fixture(t);
    await f.seed();
    let pattern = /DMG.*输出目录/;
    if (kind === "缺输出目录") {
      await rm(f.out, { recursive: true });
      pattern = /原输出目录/;
    } else if (kind === "DMG 不存在") {
      await rm(f.dmg);
      pattern = /DMG.*不存在/;
    } else if (kind === "DMG 是目录") {
      await rm(f.dmg);
      await mkdir(f.dmg);
      pattern = /DMG.*文件/;
    } else {
      const outsideDir = `${f.out}-outside`;
      await mkdir(outsideDir);
      const outside = join(outsideDir, "outside.dmg");
      await writeFile(outside, "untouched outside DMG");
      if (kind === "DMG 链接到外部") {
        await rm(f.dmg);
        await symlink(outside, f.dmg);
      } else {
        const path =
          kind === "父目录穿越" ? `${f.out}/../original output-outside/outside.dmg` : outside;
        await f.seed({ path });
      }
    }
    await assertRejectedBeforeApple(f, await f.run(), pattern);
  });
}

test("new 已有同名 DMG 仍在解锁、签名或提交前拒绝覆盖", newOnly, async (t) => {
  const f = await fixture(t, { app: true });
  const original = await f.seed();
  const dmg = await readFile(f.dmg);
  assertFailed(await f.run({ resume: false }), /输出文件已存在，拒绝覆盖/);
  assert.deepEqual(
    (await f.calls()).filter(({ tool }) => !["xcodebuild", "lipo"].includes(tool)),
    [],
  );
  assert.equal(await readFile(f.record, "utf8"), original);
  assert.deepEqual(await readFile(f.dmg), dmg);
});

test("new --no-notarize 仍签名制盘且不提交", newOnly, async (t) => {
  const f = await fixture(t, { app: true });
  const result = await f.run({ resume: false, flags: ["--no-notarize"] });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /已按要求跳过公证/);
  assert.equal(notaryCalls(await f.calls(), "submit").length, 0);
  assert.deepEqual(finalCalls(await f.calls()), []);
  assert.ok((await readFile(f.dmg)).length > 0);
});

test("submission id 与 --no-notarize 冲突在读取路径和凭据之前拒绝", unixOnly, async (t) => {
  const f = await fixture(t);
  await rm(f.out, { recursive: true });
  await rm(f.keychain);
  await assertRejectedBeforeApple(
    f,
    await f.run({ flags: ["--no-notarize"] }),
    /AISCOO_NOTARY_SUBMISSION_ID.*--no-notarize.*冲突/,
  );
  assert.deepEqual(await f.calls(), []);
});

for (const status of ["Invalid", "Rejected"]) {
  test(`resume ${status} 获取失败日志并非零退出，不 staple`, unixOnly, async (t) => {
    const f = await fixture(t);
    const original = await f.seed();
    await assertFailed(await f.run({ extraEnv: { FAKE_STATUS: status } }), /公证未通过/);
    assert.equal(notaryCalls(await f.calls(), "submit").length, 0);
    assert.equal(notaryCalls(await f.calls(), "log").length, 1);
    assert.deepEqual(finalCalls(await f.calls()), []);
    assert.deepEqual(JSON.parse(await readFile(join(f.out, "notary-log.json"), "utf8")), {
      status,
      synthetic: true,
    });
    assert.equal(await readFile(f.record, "utf8"), original);
  });
}

for (const [stage, code, expectedCalls] of [
  ["staple", 43, ["staple"]],
  ["validate", 44, ["staple", "validate"]],
  ["spctl", 45, ["staple", "validate", "spctl"]],
]) {
  test(`resume ${stage} 失败正确传播，不报告完成`, unixOnly, async (t) => {
    const f = await fixture(t);
    const original = await f.seed();
    const result = await f.run({ extraEnv: { FAKE_FAIL: stage } });
    assertFailed(result, /synthetic failure/);
    assert.equal(result.code, code, result.output);
    assert.deepEqual(finalCalls(await f.calls()), expectedCalls);
    assert.equal(notaryCalls(await f.calls(), "submit").length, 0);
    assert.equal(await readFile(f.record, "utf8"), original);
  });
}
