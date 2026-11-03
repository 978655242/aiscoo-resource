import assert from "node:assert/strict";
import test from "node:test";
import type { NativeCodingPlanReadSnapshot } from "@zcode/shared";
import {
  formatNativePlanPrice,
  getNativePlanReferenceOffers,
} from "../../ui/src/settings/model-provider-section/nativePlanSettingsPresentation.js";
import { formatModelContextWindowLabel } from "../../ui/src/lib/tokenNumberFormat.js";

type Plan = NativeCodingPlanReadSnapshot["plans"][number];
const plan: Plan = {
  id: "1",
  title: "Personal",
  subtitle: "For individuals",
  priceAmount: "118.00",
  currency: "CNY",
  durationUnit: "month",
  durationValue: "1",
  durationCustomSeconds: "0",
  totalQuota: "500000",
  resetPeriod: "monthly",
  resetCustomSeconds: "0",
  enabled: true,
};

test("reference offers show only the first enabled template in catalog order", () => {
  const plans = [
    { ...plan, id: "disabled", priceAmount: "0.01", enabled: false },
    plan,
    { ...plan, id: "2", priceAmount: "98.00", subtitle: "Another personal plan" },
    { ...plan, id: "3", priceAmount: "18.00", currency: "USD" },
    { ...plan, id: "4", priceAmount: "258.00", durationValue: "3" },
    { ...plan, id: "5", durationUnit: "day" as const, durationValue: "31" },
  ];
  assert.deepEqual(getNativePlanReferenceOffers(plans), [plan]);
  assert.deepEqual(getNativePlanReferenceOffers([...plans].reverse()), [plans.at(-1)]);
});

test("reference offers stay empty when no template is enabled", () => {
  assert.deepEqual(getNativePlanReferenceOffers([]), []);
  assert.deepEqual(getNativePlanReferenceOffers([{ ...plan, enabled: false }]), []);
});

test("displaying Native reference prices preserves exact decimals and unknown currency labels", () => {
  assert.equal(
    formatNativePlanPrice("9007199254740992.01", "USD", "en-US"),
    "$9,007,199,254,740,992.01",
  );
  assert.equal(formatNativePlanPrice("0.123456", "CNY", "zh-CN"), "¥0.123456");
  assert.equal(formatNativePlanPrice("98.00", "PRIVATE_CREDIT", "en-US"), "98.00 PRIVATE_CREDIT");
});

test("model context badges preserve exact published token capacities", () => {
  const capacities = [
    [1_050_000, "1.05M"],
    [1_048_576, "1.048576M"],
    [202_752, "202.752K"],
    [204_800, "204.8K"],
    [200_000, "200K"],
    [1_000_000, "1M"],
  ] as const;
  for (const [tokens, label] of capacities) {
    assert.equal(formatModelContextWindowLabel(tokens, "zh-CN"), label);
    assert.equal(formatModelContextWindowLabel(tokens, "en-US"), label);
  }
});
