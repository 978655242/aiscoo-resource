// XWork 策略扩展：architecture-policy.xwork.yaml 的模块追加到上游策略后统一校验。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { adoptModule } from "../architecture/adopt.mjs";
import { checkArchitecture, generateContext, loadPolicy } from "../architecture/index.mjs";

const UPSTREAM = `version: 1
modules:
  - id: upstream
    roots: [src/upstream]
global:
  maxFileLines: 20
`;

async function withPolicy(extension, fn) {
  const cwd = await mkdtemp(join(tmpdir(), "xwork-policy-"));
  try {
    await writeFile(join(cwd, "architecture-policy.yaml"), UPSTREAM);
    if (extension !== undefined)
      await writeFile(join(cwd, "architecture-policy.xwork.yaml"), extension);
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("without an extension file the upstream policy loads unchanged", async () => {
  await withPolicy(undefined, async (cwd) => {
    const policy = await loadPolicy(cwd);
    assert.deepEqual(
      policy.modules.map((module) => module.id),
      ["upstream"],
    );
    assert.equal(policy.global.maxFileLines, 20);
  });
});

test("extension modules are appended and may depend on upstream modules", async () => {
  const extension = `modules:
  - id: downstream
    roots: [src/downstream]
    managed: true
    requires: [upstream]
`;
  await withPolicy(extension, async (cwd) => {
    const policy = await loadPolicy(cwd);
    assert.deepEqual(
      policy.modules.map((module) => module.id),
      ["upstream", "downstream"],
    );
    assert.deepEqual(policy.modules[1].requires, ["upstream"]);
    assert.equal(policy.global.maxFileLines, 20);
  });
});

test("extension modules go through the same validation as upstream modules", async () => {
  await withPolicy("modules:\n  - id: upstream\n    roots: [src/other]\n", (cwd) =>
    assert.rejects(loadPolicy(cwd), /模块 id 重复/),
  );
  await withPolicy(
    "modules:\n  - id: downstream\n    roots: [src/d]\n    requires: [missing]\n",
    (cwd) => assert.rejects(loadPolicy(cwd), /依赖未知模块 missing/),
  );
  await withPolicy("version: 1\n", (cwd) =>
    assert.rejects(loadPolicy(cwd), /必须包含 modules 数组/),
  );
});

test("aliases resolve one owner and preserve dependency and public-entry checks", async () => {
  const policyYaml = `version: 1
modules:
  - id: consumer
    roots: [packages/consumer/src]
    managed: true
    requires: [aiscoo-brand]
  - id: stranger
    roots: [packages/stranger/src]
    managed: true
    requires: []
`;
  const extension = `aliases:
  aiscoo-brand: legacy-brand
modules:
  - id: legacy-brand
    roots: [packages/brand/src]
    managed: true
    owner: product
    requires: []
    publicEntrypoints: [packages/brand/src/index.ts, packages/brand/src/contract.ts]
`;
  await withPolicy(extension, async (cwd) => {
    await writeFile(join(cwd, "architecture-policy.yaml"), policyYaml);
    await writeFile(join(cwd, "pnpm-workspace.yaml"), "packages: [packages/*]\n");
    for (const id of ["consumer", "stranger", "brand"]) {
      const dir = join(cwd, "packages", id, "src");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(cwd, "packages", id, "package.json"),
        JSON.stringify({ name: `@fixture/${id}`, exports: { ".": "./src/index.ts" } }),
      );
      await writeFile(
        join(dir, "module.ts"),
        `export const module = { requires: ${id === "consumer" ? '["aiscoo-brand"]' : "[]"} };\n`,
      );
      await writeFile(join(dir, "contract.ts"), "export type Contract = string;\n");
      await writeFile(join(dir, "contract.example.ts"), "export {};\n");
      await writeFile(join(dir, "contract.test.ts"), "export {};\n");
      await writeFile(join(dir, "CONTRACT.md"), "# contract\n");
      await writeFile(
        join(dir, "index.ts"),
        id === "consumer" ? 'import "@fixture/brand";\n' : "export const value = 1;\n",
      );
    }
    const result = await checkArchitecture({ cwd });
    assert.deepEqual(result.violations, []);
    assert.equal(
      await generateContext({ cwd, moduleId: "legacy-brand" }),
      await generateContext({ cwd, moduleId: "aiscoo-brand" }),
    );
    assert.match(await generateContext({ cwd, moduleId: "aiscoo-brand" }), /owner: product/);
    await writeFile(
      join(cwd, "architecture-policy.yaml"),
      policyYaml.replace("requires: [aiscoo-brand]", "requires: [legacy-brand]"),
    );
    await writeFile(
      join(cwd, "packages/consumer/src/module.ts"),
      'export const module = { requires: ["legacy-brand"] };\n',
    );
    assert.deepEqual((await checkArchitecture({ cwd })).violations, []);
    await writeFile(join(cwd, "architecture-policy.yaml"), policyYaml);
    await writeFile(
      join(cwd, "packages/consumer/src/module.ts"),
      'export const module = { requires: ["aiscoo-brand"] };\n',
    );
    await writeFile(join(cwd, "packages/stranger/src/index.ts"), 'import "@fixture/brand";\n');
    await writeFile(join(cwd, "packages/brand/src/private.ts"), "export const secret = 1;\n");
    await writeFile(
      join(cwd, "packages/consumer/src/private.ts"),
      'import "@fixture/brand/src/private.js";\n',
    );
    const failures = await checkArchitecture({ cwd });
    assert.equal(failures.violations.filter((item) => item.rule === "module-dependency").length, 1);
    assert.equal(failures.violations.filter((item) => item.rule === "deep-import").length, 1);
    await writeFile(
      join(cwd, "packages/consumer/src/module.ts"),
      'export const module = { requires: ["legacy-brand"] };\n',
    );
    const mismatch = await checkArchitecture({
      cwd,
      changedFiles: ["architecture-policy.xwork.yaml"],
    });
    assert.equal(
      mismatch.violations.filter((item) => item.rule === "manifest-policy-mismatch").length,
      1,
    );
    assert.equal(mismatch.changedClosure, null);
    await assert.rejects(
      adoptModule({ cwd, id: "aiscoo-brand", roots: ["packages/brand/src"] }),
      /别名/,
    );
  });
});

test("invalid and conflicting aliases are rejected", async () => {
  for (const aliases of [
    "aiscoo: missing",
    "upstream: downstream",
    '"": downstream',
    "aiscoo: [downstream]",
  ]) {
    const extension = `aliases:\n  ${aliases}\nmodules:\n  - id: downstream\n    roots: [src/downstream]\n`;
    await withPolicy(extension, (cwd) => assert.rejects(loadPolicy(cwd), /别名|alias/i));
  }
});

test("adopt registers and re-adopts XWork modules in the extension file only", async () => {
  await withPolicy("modules:\n  - id: downstream\n    roots: [src/downstream]\n", async (cwd) => {
    await mkdir(join(cwd, "src/downstream"), { recursive: true });
    await mkdir(join(cwd, "src/fresh"), { recursive: true });
    // 已登记在扩展文件中的模块：更新扩展条目，不在上游 YAML 重复登记。
    await adoptModule({ cwd, id: "downstream", roots: ["src/downstream"] });
    // 新模块：登记到扩展文件。
    await adoptModule({ cwd, id: "fresh", roots: ["src/fresh"] });
    // 上游已有模块：仍写上游 YAML。
    await mkdir(join(cwd, "src/upstream"), { recursive: true });
    await adoptModule({ cwd, id: "upstream", roots: ["src/upstream"] });

    const upstreamYaml = await readFile(join(cwd, "architecture-policy.yaml"), "utf8");
    assert.doesNotMatch(upstreamYaml, /downstream|fresh/);
    const policy = await loadPolicy(cwd);
    assert.deepEqual(
      policy.modules.map((module) => [module.id, module.managed]),
      [
        ["upstream", true],
        ["downstream", true],
        ["fresh", true],
      ],
    );
  });
});
