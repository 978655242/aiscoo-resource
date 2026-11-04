import assert from "node:assert/strict";

// XCODE: 共用真实 Session 检查，覆盖 prepare 与实际套餐页，不用 mock Cookie 属性。
export async function assertNativeDisplayCookie(partitionSession, cookieOrigin, displayContext) {
  const cookies = await partitionSession.cookies.get({ url: `${cookieOrigin}/xcode/plans` });
  const displayCookies = cookies.filter((cookie) => cookie.name === "xcode_plan_display_v1");
  assert.equal(displayCookies.length, 1, "prepare must await its real display Cookie");
  const cookie = displayCookies[0];
  assert.deepEqual(
    {
      hostOnly: cookie.hostOnly,
      domain: cookie.domain,
      session: cookie.session,
      path: cookie.path,
      sameSite: cookie.sameSite,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      expirationDate: cookie.expirationDate,
    },
    {
      hostOnly: true,
      domain: new URL(cookieOrigin).hostname,
      session: true,
      path: "/xcode/plans",
      sameSite: "strict",
      httpOnly: false,
      secure: cookieOrigin.startsWith("https:"),
      expirationDate: undefined,
    },
  );
  assert.deepEqual(JSON.parse(decodeURIComponent(cookie.value)), displayContext);
  assert.equal(
    (await partitionSession.cookies.get({ url: `${cookieOrigin}/api/xcode/v1/web/view` })).some(
      (value) => value.name === "xcode_plan_display_v1",
    ),
    false,
    "display Cookie must not widen into the authentication API path",
  );
}

// XCODE: 非法/伪造展示上下文必须在消费真实准入前整体拒绝，不能只测字段默认值。
export async function assertInvalidDisplayContexts(win, request, displayContext) {
  for (const invalidContext of [
    null,
    { ...displayContext, version: 2 },
    { ...displayContext, uiFontSizePx: 11 },
    { ...displayContext, uiFontSizePx: 21 },
    { ...displayContext, uiFontSizePx: 14.5 },
    { ...displayContext, uiFontSizePx: "14" },
    { ...displayContext, sid: "not-a-page-identity" },
  ]) {
    await assert.rejects(
      win.webContents.executeJavaScript(
        `window.nativeHandoffTest.prepare(${JSON.stringify({ ...request, displayContext: invalidContext })})`,
      ),
      /XCODE_INVALID_PLAN_DISPLAY_CONTEXT/,
    );
  }
}
