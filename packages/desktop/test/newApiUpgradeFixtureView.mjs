// XCODE: deterministic UI fixtures exercise the production dialog/viewer, not live billing or provider rights.
export function fixtureView() {
  const items = [];
  const presentations = [];
  for (const [tier, title] of ["体验套餐", "Lite", "Pro", "Max"].entries()) {
    for (const months of tier === 0 ? [0] : [1, 3, 12]) {
      const id = String(items.length + 1);
      const metadata = {
        group_key: "tier-" + tier,
        group_title: title,
        offer_kind: tier ? "standard" : "trial",
        highlights: tier ? ["适合持续开发与仓库迭代", "每月独立重置额度"] : ["适合快速上手体验"],
        features: [
          "真实原生套餐展示样本",
          "管理员配置模型与访问范围",
          "额度用量以指定实例为准",
          "官方云服务需独立连接",
        ],
      };
      items.push({
        id,
        title: title + (months ? " " + months + " months" : ""),
        subtitle: "Deterministic UI fixture",
        price_amount: String(tier ? [10, 24, 96][[1, 3, 12].indexOf(months)] * tier : 0),
        currency: "USD",
        duration_unit: months ? "month" : "day",
        duration_value: String(months || 5),
        duration_custom_seconds: "0",
        total_quota: String(500000 * (tier || 1)),
        reset_period: tier ? "monthly" : "never",
        reset_custom_seconds: "0",
        enabled: true,
      });
      presentations.push({
        plan_id: id,
        metadata,
        assignable: true,
        assignment_reason: null,
        display_issue: null,
      });
    }
  }
  const now = Date.now();
  return {
    schema_version: 1,
    server_time: now,
    plans: {
      schema_version: 1,
      server_time: now,
      purchase_mode: "manual_admin",
      self_service_purchase: false,
      items,
    },
    plan_presentations: presentations,
    entitlements: {
      schema_version: 1,
      server_time: now,
      status: "active",
      authorization_revision: "1",
      subscription: {
        id: "100",
        plan_id: "6",
        plan_title: "Pro assigned snapshot",
        source: "admin",
        usage_scope: "zen",
        start_time: now - 1000,
        end_time: now + 86400000,
      },
      quota: {
        scope: "zen-subscription",
        unit: "quota",
        unlimited: false,
        total: "1000000",
        used: "0",
        remaining: "1000000",
        used_percentage: 0,
        reset_period: "monthly",
        reset_custom_seconds: "0",
        last_reset_time: now,
        next_reset_time: now + 86400000,
        reset_time_zone: "server-local",
        reset_utc_offset_seconds: 0,
      },
      funding_policy: {
        subscription_only: true,
        wallet_fallback: false,
        other_subscription_fallback: false,
      },
      self_service_reset: false,
      purchase_mode: "manual_admin",
    },
    display: {
      quota_per_unit: "500000",
      display_type: "USD",
      currency: "USD",
      currency_symbol: "$",
      usd_to_currency_rate: "1",
    },
  };
}
