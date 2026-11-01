import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateContext, loadPolicy } from "../architecture/index.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
// 旧 xwork 模块 ID、路径与别名已清理；这里锁定现行 aiscoo 模块的 owner 与公开边界。
const modules = {
  "cli-aiscoo": { owner: "cli", roots: ["apps/zcode-cli/packages/cli/src/aiscoo"] },
  "cli-aiscoo-brand": {
    owner: "product",
    roots: ["apps/zcode-cli/packages/i18n/src/aiscoo-brand"],
  },
  "aiscoo-startup-context": {
    owner: "conversation",
    roots: ["packages/ui/src/aiscoo/startup-context"],
  },
  "aiscoo-plugin-guides-protocol": {
    owner: "plugin",
    roots: ["packages/shared/src/aiscoo-plugin-guides"],
  },
  "aiscoo-plugin-guides-cli": {
    owner: "plugin",
    roots: [
      "apps/zcode-cli/packages/adapters/src/aiscoo-plugin-guides",
      "apps/zcode-cli/packages/bootstrap/src/aiscoo-plugin-guides",
      "apps/zcode-cli/packages/core/src/aiscoo-plugin-guides",
    ],
  },
  "aiscoo-plugin-guides-service": {
    owner: "plugin",
    roots: ["packages/services/src/aiscoo-plugin-guides"],
  },
  "aiscoo-plugin-guides-ui": { owner: "plugin", roots: ["packages/ui/src/aiscoo/plugin-guides"] },
  "aiscoo-brand": { owner: "product", roots: ["packages/shared/src/aiscoo-brand"] },
  "aiscoo-brand-ui": { owner: "product", roots: ["packages/ui/src/aiscoo/brand"] },
  "aiscoo-account-avatar": { owner: "account", roots: ["packages/ui/src/aiscoo/account-avatar"] },
};

test("aiscoo architecture modules own their roots and public boundaries without legacy aliases", async () => {
  const policy = await loadPolicy(root);
  assert.deepEqual(Object.keys(policy.aliases), []);
  for (const [id, expected] of Object.entries(modules)) {
    const module = policy.modules.find((item) => item.id === id);
    assert.ok(module, id);
    assert.equal(module.owner, expected.owner, id);
    assert.deepEqual(
      module.roots.map((entry) => path.relative(root, entry)),
      expected.roots,
      id,
    );
    for (const rootPath of module.roots) {
      for (const entry of ["index.ts", "contract.ts"]) {
        assert.ok(
          module.publicEntrypoints.some(
            (publicEntry) => path.resolve(root, publicEntry) === path.join(rootPath, entry),
          ),
          `${id}: ${entry}`,
        );
      }
    }
    assert.match(
      await generateContext({ cwd: root, moduleId: id }),
      new RegExp(`owner: ${expected.owner}`),
    );
  }
  const retired = policy.modules.filter(
    (module) =>
      /(^|-)xwork(-|$)/.test(module.id) ||
      module.roots.some((entry) => /\/xwork(\/|-)/.test(entry)),
  );
  assert.deepEqual(
    retired.map((module) => module.id),
    [],
  );
});

test("CLI runs its Aiscoo posttest without the retired xwork script alias", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(root, "apps/zcode-cli/packages/cli/package.json")),
  );
  assert.equal(pkg.scripts.posttest, "pnpm run test:aiscoo");
  assert.match(pkg.scripts["test:aiscoo"], /zen-login\.test\.ts/);
  assert.equal(pkg.scripts["test:xwork"], undefined);
});

test("brand sources, sync log and pre-push path remain intact", async () => {
  for (const relative of [
    "packages/shared/src/aiscoo-brand/brand.json",
    "packages/ui/src/aiscoo/brand/assets/mark-dark.svg",
    "scripts/xcode/start-local.py",
    "scripts/xcode/启动 XCode.command",
    "scripts/aiscoo/start-local.py",
    "scripts/aiscoo/启动 Aiscoo.command",
    "docs/xcode/upstream-sync-log.md",
  ])
    await readFile(path.join(root, relative));
  const current = await readFile(path.join(root, "docs/xcode/upstream-sync-log.md"), "utf8");
  const baseline = execFileSync("git", ["show", "origin/release:docs/xcode/upstream-sync-log.md"], {
    cwd: root,
    encoding: "utf8",
  });
  // XCODE: 同步 PR 可追加记录，但品牌兼容必须保留原有全部历史条目。
  const historicalHeading = "## 2026-10-21 同步 upstream v3.16.2";
  assert.ok(current.includes(historicalHeading));
  assert.equal(
    current.slice(current.indexOf(historicalHeading)),
    baseline.slice(baseline.indexOf(historicalHeading)),
  );
  assert.ok(current.startsWith("# 上游同步记录\n"));
  const historicalLinks = [...current.matchAll(/\]\((\.\.?\/[^)#]+)(?:#[^)]*)?\)/g)];
  assert.ok(historicalLinks.length > 0);
  for (const [, relative] of historicalLinks) {
    await readFile(path.resolve(root, "docs/xcode", relative));
  }
  assert.match(
    await readFile(path.join(root, ".husky/pre-push"), "utf8"),
    /scripts\/xcode\/branch-policy\.mjs push/,
  );
});

test("legacy desktop symlink resolves the script path and preserves its exit code", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "aiscoo-launch-"));
  try {
    const oldDir = path.join(temp, "xcode");
    const newDir = path.join(temp, "aiscoo");
    await mkdir(oldDir);
    await mkdir(newDir);
    const oldLauncher = path.join(oldDir, "启动 XCode.command");
    const newLauncher = path.join(newDir, "启动 Aiscoo.command");
    await writeFile(
      oldLauncher,
      await readFile(path.join(root, "scripts/xcode/启动 XCode.command")),
      { mode: 0o755 },
    );
    await writeFile(
      newLauncher,
      await readFile(path.join(root, "scripts/aiscoo/启动 Aiscoo.command")),
      { mode: 0o755 },
    );
    await writeFile(path.join(oldDir, "start-local.py"), "import sys\nsys.exit(37)\n");
    await writeFile(
      path.join(newDir, "start-local.py"),
      await readFile(path.join(root, "scripts/aiscoo/start-local.py")),
    );
    for (const [name, launcher] of [
      ["old", oldLauncher],
      ["new", newLauncher],
    ]) {
      const link = path.join(temp, `${name}-desktop.command`);
      await symlink(launcher, link);
      const result = spawnSync("/bin/zsh", [link], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(result.status, 37, result.stderr);
    }
    const python = spawnSync("/opt/homebrew/bin/python3", [path.join(newDir, "start-local.py")], {
      encoding: "utf8",
    });
    assert.equal(python.status, 37, python.stderr);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
