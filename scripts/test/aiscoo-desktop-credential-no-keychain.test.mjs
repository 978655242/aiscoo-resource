import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

// 2026-11-01：Aiscoo 桌面登录凭据与上游一致，不触发系统钥匙串授权，也不要求用户输入电脑密码。
// 这个门禁防止以后有人把 safeStorage 或私有密钥链路加回桌面 Main/Host。
// 只检查 TypeScript 语法树里的真实引用（import 与标识符），不扫描注释和字符串，避免被说明文字误伤。
const root = new URL("../../", import.meta.url);
const files = [
  "packages/desktop/src/main/index.ts",
  "packages/desktop/src/main/desktopHostProcess.ts",
  "packages/desktop/src/main/desktopRuntimeEnv.ts",
  "packages/services/src/credential/credentialService.ts",
  "packages/services/src/aiscoo-admin/aiscooAdminSessionRepo.ts",
  "packages/services/src/aiscoo-admin/aiscooAdminAccountService.ts",
  "packages/services/src/official-mcp/officialCloudConnectionService.ts",
];

async function identifiersAndImports(path) {
  const source = ts.createSourceFile(
    path,
    await readFile(new URL(path, root), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set();
  const specifiers = [];
  const visit = (node) => {
    if (ts.isIdentifier(node)) names.add(node.text);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { names, specifiers };
}

test("desktop credential path never references safeStorage or the retired private key chain", async () => {
  const retired = [
    "safeStorage",
    "loadPrivateCredentialSecret",
    "privateCredentialSecret",
    "createPrivateCredentialCipherProvider",
    "assertStorageAvailable",
    "XCODE_PRIVATE_CREDENTIAL_SECRET",
  ];
  for (const path of files) {
    const { names, specifiers } = await identifiersAndImports(path);
    for (const name of retired) assert.equal(names.has(name), false, `${path} still uses ${name}`);
    for (const specifier of specifiers) {
      assert.doesNotMatch(
        specifier,
        /privateCredentialKey|privateCredentialCipherProvider/,
        `${path} still imports ${specifier}`,
      );
    }
  }
});

test("the retired key loader and private cipher modules are gone", async () => {
  for (const path of [
    "packages/desktop/src/main/privateCredentialKey.ts",
    "packages/services/src/credential/providers/privateCredentialCipherProvider.ts",
  ]) {
    await assert.rejects(readFile(new URL(path, root)), { code: "ENOENT" });
  }
});

test("Main never forwards a credential key to the Host or the runtime env", async () => {
  const strings = [];
  for (const path of [
    "packages/desktop/src/main/desktopRuntimeEnv.ts",
    "packages/shared/src/runtimeEnv.ts",
  ]) {
    const source = ts.createSourceFile(
      path,
      await readFile(new URL(path, root), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (ts.isStringLiteralLike(node)) strings.push(`${path}: ${node.text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(
    strings.filter((entry) => entry.endsWith("XCODE_PRIVATE_CREDENTIAL_SECRET")),
    [],
  );
});
