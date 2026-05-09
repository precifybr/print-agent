import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-print-agent-token",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const validJobTypes = new Set(["order", "teste", "reprint"]);

type PrinterPayload = {
  agent_id?: string;
  host?: string;
  printers?: Array<{
    agent_id?: string;
    host?: string;
    printer_name?: string;
    name?: string;
    display_name?: string;
    displayName?: string;
    driver?: string;
    is_default?: boolean;
    isDefault?: boolean;
    status?: string;
  }>;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  try {
    const supabase = getServiceClient();
    const token = request.headers.get("x-print-agent-token") || "";
    const agent = await authenticateAgent(supabase, token);
    const route = getRoute(request.url);

    if (request.method === "POST" && route === "/printers") {
      return registerPrinters(request, supabase, agent);
    }

    if (request.method === "POST" && route === "/heartbeat") {
      return heartbeat(request, supabase, agent);
    }

    if (request.method === "GET" && route === "/pending") {
      return pendingJobs(request, supabase, agent);
    }

    const doneMatch = route.match(/^\/([^/]+)\/done$/);
    if (request.method === "POST" && doneMatch) {
      return markDone(request, supabase, doneMatch[1]);
    }

    const errorMatch = route.match(/^\/([^/]+)\/error$/);
    if (request.method === "POST" && errorMatch) {
      return markError(request, supabase, errorMatch[1]);
    }

    return jsonResponse({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
    return jsonResponse({ error: message }, status);
  }
});

function getServiceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new HttpError(500, "EDGE_ENV_MISSING");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function authenticateAgent(supabase: ReturnType<typeof createClient>, token: string) {
  if (!token) {
    throw new HttpError(401, "PRINT_AGENT_TOKEN_MISSING");
  }

  const { data, error } = await supabase
    .from("developer_settings")
    .select("setting_key, setting_value")
    .in("setting_key", ["print_agent_token", "print_agent_token_version", "print_agent_id"]);

  if (error) {
    throw new HttpError(500, "TOKEN_LOOKUP_FAILED");
  }

  const settings = new Map((data || []).map((row: any) => [row.setting_key, row.setting_value]));
  const expectedToken = String(settings.get("print_agent_token") || "");

  if (!expectedToken || token !== expectedToken) {
    throw new HttpError(401, "PRINT_AGENT_TOKEN_INVALID");
  }

  return {
    agent_id: String(settings.get("print_agent_id") || "default-agent"),
    token_version: Number(settings.get("print_agent_token_version") || 1),
  };
}

async function registerPrinters(
  request: Request,
  supabase: ReturnType<typeof createClient>,
  agent: { agent_id: string; token_version: number },
) {
  const payload = (await readJson(request)) as PrinterPayload;
  const host = sanitizeText(payload.host || "unknown-host");
  const agentId = sanitizeText(payload.agent_id || agent.agent_id);
  const printers = Array.isArray(payload.printers) ? payload.printers : [];
  const seenNames = new Set<string>();

  for (const printer of printers) {
    const printerName = sanitizeText(printer.printer_name || printer.name || "");
    if (!printerName) continue;
    seenNames.add(printerName);

    const { error } = await supabase.from("printer_devices").upsert({
      agent_id: agentId,
      host,
      printer_name: printerName,
      display_name: sanitizeText(printer.display_name || printer.displayName || printerName),
      driver: sanitizeText(printer.driver || ""),
      is_default: Boolean(printer.is_default ?? printer.isDefault),
      status: "online",
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "agent_id,printer_name" });

    if (error) {
      throw new HttpError(500, "PRINTER_UPSERT_FAILED");
    }
  }

  const { data: currentDevices, error: listError } = await supabase
    .from("printer_devices")
    .select("id, printer_name")
    .eq("agent_id", agentId);

  if (listError) {
    throw new HttpError(500, "PRINTER_LIST_FAILED");
  }

  const staleIds = (currentDevices || [])
    .filter((device: any) => !seenNames.has(device.printer_name))
    .map((device: any) => device.id);

  if (staleIds.length) {
    const { error } = await supabase
      .from("printer_devices")
      .update({ status: "offline", updated_at: new Date().toISOString() })
      .in("id", staleIds);

    if (error) {
      throw new HttpError(500, "PRINTER_OFFLINE_UPDATE_FAILED");
    }
  }

  const { data: syncedPrinters } = await supabase
    .from("printer_devices")
    .select("*")
    .eq("agent_id", agentId)
    .order("is_default", { ascending: false })
    .order("printer_name", { ascending: true });

  return jsonResponse({
    ok: true,
    agent_id: agentId,
    tokenVersion: agent.token_version,
    printers: syncedPrinters || [],
    registered: seenNames.size,
    offline: staleIds.length,
  });
}

async function heartbeat(
  request: Request,
  supabase: ReturnType<typeof createClient>,
  agent: { agent_id: string; token_version: number },
) {
  const payload = await readJson(request) as Record<string, unknown>;
  const agentId = sanitizeText(payload.agent_id || agent.agent_id);
  const host = sanitizeText(payload.host || "unknown-host");

  const { error } = await supabase
    .from("printer_devices")
    .update({
      host,
      status: "online",
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("agent_id", agentId);

  if (error) {
    throw new HttpError(500, "HEARTBEAT_FAILED");
  }

  return jsonResponse({ ok: true, agent_id: agentId, tokenVersion: agent.token_version });
}

async function pendingJobs(
  request: Request,
  supabase: ReturnType<typeof createClient>,
  agent: { agent_id: string; token_version: number },
) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 10), 50);

  const { data, error } = await supabase
    .from("print_jobs")
    .select("*, printer:printer_devices(*)")
    .eq("status", "pending")
    .lt("attempts", 3)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new HttpError(500, "PENDING_LOOKUP_FAILED");
  }

  const jobs = (data || []).filter((job: any) => validJobTypes.has(String(job.type || "")));

  if (jobs.length) {
    for (const job of jobs as any[]) {
      await supabase
        .from("print_jobs")
        .update({
        status: "processing",
        attempts: Number(job.attempts || 0) + 1,
        locked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
        .eq("id", job.id);
    }
  }

  return jsonResponse({ jobs, tokenVersion: agent.token_version });
}

async function markDone(
  request: Request,
  supabase: ReturnType<typeof createClient>,
  jobId: string,
) {
  await readJson(request);
  const { error } = await supabase
    .from("print_jobs")
    .update({
      status: "done",
      printed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  if (error) {
    throw new HttpError(500, "MARK_DONE_FAILED");
  }

  return jsonResponse({ ok: true });
}

async function markError(
  request: Request,
  supabase: ReturnType<typeof createClient>,
  jobId: string,
) {
  const payload = await readJson(request) as Record<string, unknown>;
  const { error } = await supabase
    .from("print_jobs")
    .update({
      status: "error",
      last_error: sanitizeText(payload.message || "PRINT_FAILED"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  if (error) {
    throw new HttpError(500, "MARK_ERROR_FAILED");
  }

  return jsonResponse({ ok: true });
}

function getRoute(url: string) {
  const pathname = new URL(url).pathname;
  const marker = "/print-agent";
  const index = pathname.indexOf(marker);
  return index >= 0 ? pathname.slice(index + marker.length) || "/" : pathname || "/";
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function sanitizeText(value: unknown) {
  return String(value || "").trim().slice(0, 500);
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

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
