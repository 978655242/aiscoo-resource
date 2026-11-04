import assert from "node:assert/strict";
import test from "node:test";
import { AiscooAdminPlanWebviewPolicy } from "../../desktop/src/main/aiscooAdminPlanWebviewPolicy.js";

const origin = "http://127.0.0.1:3001";
const handoff = (ownerGeneration: number, url = `${origin}/xcode/plans?handoff=short-code`) => ({
  url,
  ownerGeneration,
});

test("Native handoff rejects foreign origins, userinfo and non-plan paths", () => {
  const policy = new AiscooAdminPlanWebviewPolicy();
  policy.setOwner({ origin, ownerGeneration: 1 });
  for (const url of [
    "https://evil.test/xcode/plans?handoff=x",
    "http://attacker@127.0.0.1:3001/xcode/plans?handoff=x",
    `${origin}/xcode/plans/evil?handoff=x`,
    `${origin}/xcode/plans?control_token=secret`,
  ]) {
    assert.throws(() => policy.prepare(handoff(1, url)));
  }
});

test("Native plan partitions cannot be reused across owner generations or closed views", () => {
  const policy = new AiscooAdminPlanWebviewPolicy();
  policy.setOwner({ origin, ownerGeneration: 1 });
  assert.equal(policy.authorize(handoff(1)), true);
  const a = policy.prepare(handoff(1));
  assert.equal(policy.canAttach(a.partition, handoff(1).url), true);
  policy.setOwner({ origin, ownerGeneration: 2 });
  assert.equal(policy.canAttach(a.partition, handoff(1).url), false);
  assert.throws(() => policy.prepare(handoff(1)));
  assert.equal(policy.authorize(handoff(2)), true);
  const b = policy.prepare(handoff(2));
  assert.notEqual(a.partition, b.partition);
  policy.close(b.partition);
  assert.equal(policy.canAttach(b.partition, handoff(2).url), false);
});

test("Native guest navigation never exports handoff query or admits cross-origin redirects", () => {
  const policy = new AiscooAdminPlanWebviewPolicy();
  policy.setOwner({ origin, ownerGeneration: 1 });
  assert.equal(policy.authorize(handoff(1)), true);
  const { partition } = policy.prepare(handoff(1));
  assert.equal(policy.canNavigate(partition, handoff(1).url), true);
  assert.equal(policy.canNavigate(partition, `${origin}/xcode/plans`), true);
  assert.equal(policy.canNavigate(partition, "https://evil.test/?handoff=short-code"), false);
  assert.equal(policy.canNavigate(partition, `${origin}/other?handoff=short-code`), false);
  assert.equal(policy.canNavigate(partition, `${origin}/xcode/plans?sk-key=secret`), false);
  policy.setOwner(null);
  assert.equal(policy.canNavigate(partition, `${origin}/xcode/plans`), false);
});

test("An admitted partition accepts one guest only and cannot attach after an owner switch", () => {
  const policy = new AiscooAdminPlanWebviewPolicy();
  policy.setOwner({ origin, ownerGeneration: 1 });
  assert.equal(policy.authorize(handoff(1)), true);
  const { partition } = policy.prepare(handoff(1));
  assert.equal(policy.claim(partition, handoff(1).url), true);
  assert.equal(policy.claim(partition, handoff(1).url), false);
  assert.equal(policy.canAttach(partition, handoff(1).url), false);
  assert.equal(policy.authorize(handoff(1)), true);
  const waiting = policy.prepare(handoff(1));
  policy.setOwner({ origin, ownerGeneration: 2 });
  assert.equal(policy.claim(waiting.partition, handoff(1).url), false);
});

test("Renderer cannot relabel an old handoff URL with a new owner generation", () => {
  const policy = new AiscooAdminPlanWebviewPolicy();
  policy.setOwner({ origin, ownerGeneration: 1 });
  assert.equal(policy.authorize(handoff(1)), true);
  policy.setOwner({ origin, ownerGeneration: 2 });
  assert.throws(() => policy.prepare(handoff(2)));
  const fresh = handoff(2, `${origin}/xcode/plans?handoff=new-owner-code`);
  assert.equal(policy.authorize(fresh), true);
  assert.throws(() => policy.prepare(handoff(2)));
  assert.ok(policy.prepare(fresh).partition);
  assert.throws(() => policy.prepare(fresh), /XCODE_STALE_WEB_HANDOFF/);
});

test("Native requests require a claimed current owner and keep resources same-origin", () => {
  const policy = new AiscooAdminPlanWebviewPolicy();
  policy.setOwner({ origin, ownerGeneration: 1 });
  assert.equal(policy.authorize(handoff(1)), true);
  const { partition } = policy.prepare(handoff(1));
  assert.equal(policy.canRequest(partition, `${origin}/assets/plan.css`, false), false);
  assert.equal(policy.claim(partition, handoff(1).url), true);
  assert.equal(policy.canRequest(partition, handoff(1).url, true), true);
  assert.equal(policy.canRequest(partition, `${origin}/xcode/plans`, true), true);
  assert.equal(policy.canRequest(partition, `${origin}/assets/plan.css`, false), true);
  assert.equal(policy.canRequest(partition, `${origin}/xcode-plan-display.js`, false), true);
  assert.equal(policy.canRequest(partition, `${origin}/static/js/index.hash.js`, false), true);
  assert.equal(policy.canRequest(partition, `${origin}/static/font/ui.woff2`, false), true);
  assert.equal(policy.canRequest(partition, `${origin}/other-root-script.js`, false), false);
  assert.equal(
    policy.canRequest(partition, `${origin}/xcode-plan-display.js?handoff=other`, false),
    false,
  );
  assert.equal(policy.canRequest(partition, `${origin}/xcode-plan-display.js/other`, false), false);
  assert.equal(policy.canRequest(partition, `${origin}/api/xcode/v1/web/view`, false), true);
  assert.equal(
    policy.canRequest(partition, `${origin}/xcode/plans?handoff=other-owner`, false),
    false,
  );
  assert.equal(
    policy.canRequest(partition, `${origin}/xcode/%70lans?handoff=other-owner`, false),
    false,
  );
  assert.equal(policy.canRequest(partition, `${origin}/other`, true), false);
  assert.equal(policy.canRequest(partition, "https://evil.test/asset", false), false);
  assert.equal(policy.canRequest(partition, "http://attacker@127.0.0.1:3001/asset", false), false);
  assert.equal(policy.canRequest(partition, "invalid", false), false);
  policy.setOwner({ origin, ownerGeneration: 2 });
  assert.equal(policy.canRequest(partition, `${origin}/assets/plan.css`, false), false);
  assert.equal(policy.canRequest(partition, `${origin}/xcode/plans`, true), false);
});
