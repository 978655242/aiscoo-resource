import { describe, expect, it } from "vitest";
import { parseZenAuthorizationCallback } from "../src/aiscoo-admin.js";

describe("CLI Zen authorization callback", () => {
  const redirect = "http://127.0.0.1:49152/oauth/callback";
  const state = "s".repeat(43);
  const code = "a".repeat(43);
  it("accepts only the bound redirect, state and one authorization code", () => {
    expect(
      parseZenAuthorizationCallback(
        `${redirect}?provider=new-api&state=${state}&code=${code}`,
        redirect,
        state,
      ),
    ).toEqual({ code, state });
    for (const raw of [
      `${redirect}?provider=new-api&state=wrong&code=${code}`,
      `${redirect}?provider=new-api&state=${state}&code=${code}&code=${code}`,
      `${redirect}?provider=other&state=${state}&code=${code}`,
      `${redirect}/?provider=new-api&state=${state}&code=${code}`,
      `${redirect}?provider=new-api&state=${state}&code=${code}#fragment`,
      `http://127.0.0.1:49153/oauth/callback?provider=new-api&state=${state}&code=${code}`,
    ])
      expect(parseZenAuthorizationCallback(raw, redirect, state)).toBeNull();
  });
});
