import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const authHeader = request.headers.get("authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!jwt) {
      return jsonResponse({ error: "JWT_MISSING" }, 401);
    }

    const supabase = getServiceClient();
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt);

    if (userError || !userData.user) {
      return jsonResponse({ error: "JWT_INVALID" }, 401);
    }

    const settings = await getSettings(supabase);
    const printAgentToken = getSetting(settings, "print_agent_token");

    if (!printAgentToken) {
      return jsonResponse({ error: "PRINT_AGENT_TOKEN_NOT_CONFIGURED" }, 500);
    }

    const agentId = getSetting(settings, "print_agent_id") || "default-agent";
    const tokenVersion = Number(getSetting(settings, "print_agent_token_version") || 1);
    const pollingInterval = Number(getSetting(settings, "print_agent_polling_interval") || 5000);
    const store = parseJsonSetting(settings, "print_agent_store") || {
      id: getSetting(settings, "store_id") || "default-store",
      name: getSetting(settings, "store_name") || "DALMAGO",
    };

    const { data: printers, error: printersError } = await supabase
      .from("printer_devices")
      .select("*")
      .eq("agent_id", agentId)
      .order("is_default", { ascending: false })
      .order("printer_name", { ascending: true });

    if (printersError) {
      return jsonResponse({ error: "PRINTER_LOOKUP_FAILED" }, 500);
    }

    return jsonResponse({
      store,
      printAgent: {
        id: agentId,
        token: printAgentToken,
        tokenVersion,
        pollingInterval,
      },
      printers: printers || [],
      pollingInterval,
    });
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "BOOTSTRAP_FAILED",
    }, 500);
  }
});

function getServiceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("EDGE_ENV_MISSING");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function getSettings(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("developer_settings")
    .select("setting_key, setting_value")
    .in("setting_key", [
      "print_agent_id",
      "print_agent_token",
      "print_agent_token_version",
      "print_agent_polling_interval",
      "print_agent_store",
      "store_id",
      "store_name",
    ]);

  if (error) {
    throw new Error("SETTINGS_LOOKUP_FAILED");
  }

  return new Map((data || []).map((row: any) => [row.setting_key, row.setting_value]));
}

function getSetting(settings: Map<string, unknown>, key: string) {
  const value = settings.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function parseJsonSetting(settings: Map<string, unknown>, key: string) {
  try {
    const value = getSetting(settings, key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
