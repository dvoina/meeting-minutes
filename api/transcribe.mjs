const MISTRAL_TRANSCRIBE_URL = "https://api.mistral.ai/v1/audio/transcriptions";

export const config = {
  runtime: "edge",
};

export default async function handler(request) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Expected multipart/form-data" }, 400);
  }

  const inboundAuth = request.headers.get("authorization");
  const keyFromHeader = request.headers.get("x-mistral-api-key");
  const envKey = process.env.MISTRAL_API_KEY;
  const bearer = inboundAuth || buildBearerFromKey(keyFromHeader) || buildBearerFromKey(envKey);
  if (!bearer) {
    return json({ error: "Missing Mistral API key" }, 400);
  }

  const incomingForm = await request.formData();
  const file = incomingForm.get("file");
  const model = incomingForm.get("model");

  if (!(file instanceof File)) {
    return json({ error: "Missing file field" }, 400);
  }
  if (typeof model !== "string" || !model.trim()) {
    return json({ error: "Missing model field" }, 400);
  }

  const outboundForm = new FormData();
  outboundForm.append("file", file, file.name || "audio.webm");
  outboundForm.append("model", model.trim());

  const upstream = await fetch(MISTRAL_TRANSCRIBE_URL, {
    method: "POST",
    headers: {
      Authorization: bearer,
    },
    body: outboundForm,
  });

  const responseText = await upstream.text();
  return new Response(responseText, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
}

function buildBearerFromKey(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.toLowerCase().startsWith("bearer ")) return trimmed;
  return `Bearer ${trimmed}`;
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
