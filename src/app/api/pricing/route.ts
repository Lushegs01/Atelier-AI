import { getAdminClient, hasSupabaseConfig } from "@/lib/supabase/admin";
import { route, assertDatabaseResult } from "@/server/services/http";

export async function GET(request: Request) {
  return route(request, async () => {
    if (!hasSupabaseConfig() || !process.env.SUPABASE_SERVICE_ROLE_KEY)
      return {
        configured: false,
        packages: [],
        rules: [],
        message: "Credit packages and generation prices will be available after pricing review.",
      };
    const admin = getAdminClient();
    const [packages, rules] = await Promise.all([
      admin
        .from("credit_packages")
        .select("id,name,credits,amount_kobo,currency,enabled")
        .eq("enabled", true)
        .order("sort_order"),
      admin
        .from("generation_price_rules")
        .select("id,operation,option_key,credits,enabled,reviewed_at")
        .order("operation")
        .order("credits"),
    ]);
    assertDatabaseResult(packages.error || rules.error);
    return {
      configured: true,
      packages: packages.data || [],
      rules: (rules.data || []).map((rule) => ({
        id: rule.id,
        operation: rule.operation,
        optionKey: rule.option_key,
        credits: rule.credits,
        available: rule.enabled && Boolean(rule.reviewed_at),
        provisional: !rule.enabled || !rule.reviewed_at,
      })),
    };
  });
}
