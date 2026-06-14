// Supabase Edge Function: nvidia-chat
// Deploy via Dashboard -> Edge Functions -> nvidia-chat -> Edit
//
// Proxies NVIDIA chat completions with streaming support.
// Logs usage (model, tokens, status) to nvidia_usage table.
// Auto-purges records older than 72 hours on each call.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function dbHeaders(serviceKey) {
  return {
    "apikey": serviceKey,
    "Authorization": `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}

async function logUsage(supabaseUrl, serviceKey, model, status, usage) {
  const headers = dbHeaders(serviceKey);
  await fetch(`${supabaseUrl}/rest/v1/nvidia_usage`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? 0,
      status,
    }),
  });
  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  await fetch(`${supabaseUrl}/rest/v1/nvidia_usage?created_at=lt.${cutoff}`, {
    method: "DELETE",
    headers,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { p_api_key, p_model, p_prompt, p_stream } = await req.json();

    if (!p_api_key || !p_model || !p_prompt) {
      return new Response(
        JSON.stringify({ status: 400, body: { error: "Missing p_api_key, p_model, or p_prompt" } }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const stream = p_stream === true;

    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${p_api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: p_model,
        messages: [{ role: "user", content: p_prompt }],
        max_tokens: 4096,
        stream,
      }),
    });

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // ── Streaming mode ──
    if (stream && response.ok && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let promptTokens = 0, completionTokens = 0, totalTokens = 0;

      const readable = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            // Log usage after stream completes
            if (supabaseUrl && serviceKey) {
              logUsage(supabaseUrl, serviceKey, p_model, response.status, {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: totalTokens,
              });
            }
            return;
          }
          // Parse SSE chunks for usage stats (last chunk has usage)
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const chunk = JSON.parse(line.slice(6));
                if (chunk.usage) {
                  promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
                  completionTokens = chunk.usage.completion_tokens ?? completionTokens;
                  totalTokens = chunk.usage.total_tokens ?? totalTokens;
                }
              } catch (_) {}
            }
          }
          controller.enqueue(value);
        },
        cancel() { reader.cancel(); },
      });

      return new Response(readable, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    // ── Non-streaming mode ──
    const body = await response.json();

    if (supabaseUrl && serviceKey) {
      await logUsage(supabaseUrl, serviceKey, p_model, response.status, body?.usage);
    }

    return new Response(
      JSON.stringify({ status: response.status, body }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ status: 500, body: { error: e.message } }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
