/**
 * Motor de chatbots multi-tenant.
 * Un solo Worker sirve a todos los clientes. El tenant se resuelve por clave pública.
 */

import WIDGET_JS from "./widget.txt";

const EMBED_MODEL = "@cf/baai/bge-m3";

function hostOf(u) {
  try { return new URL(u).hostname; } catch { return null; }
}

function h(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

// ---------- utilidades Supabase (REST con service key) ----------

async function sb(env, path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  // con Prefer: return=minimal el cuerpo llega vacío aunque el estado sea 201
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function rpc(env, fn, args) {
  return sb(env, `rpc/${fn}`, { method: "POST", body: args });
}

// ---------- CORS ----------

function cors(origin, allowed) {
  const ok = allowed.length === 0 || allowed.some((d) => origin?.endsWith(d));
  return {
    "Access-Control-Allow-Origin": ok ? origin : "null",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

// ---------- resolución de tenant ----------

async function getTenant(env, publicKey) {
  if (!publicKey) return null;
  const rows = await sb(
    env,
    `tenant_keys?public_key=eq.${encodeURIComponent(publicKey)}&revoked_at=is.null&select=tenant_id,tenants(*)`
  );
  const t = rows?.[0]?.tenants;
  return t && t.active ? t : null;
}

// ---------- embeddings ----------

async function embed(env, texts) {
  const out = await env.AI.run(EMBED_MODEL, { text: texts });
  return out.data;
}

// ---------- troceado ----------

function chunkText(text, size = 1200, overlap = 200) {
  const clean = text.replace(/\s+/g, " ").trim();
  const chunks = [];
  for (let i = 0; i < clean.length; i += size - overlap) {
    const piece = clean.slice(i, i + size);
    if (piece.trim().length > 80) chunks.push(piece);
    if (i + size >= clean.length) break;
  }
  return chunks;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- indexación común (URLs, textos y archivos) ----------

async function indexDocument(env, tenantId, { source_url = null, source_type, title, content }) {
  const clean = (content || "").trim();
  if (clean.length < 100) return { ok: false, reason: "sin contenido (menos de 100 caracteres)" };

  // reemplaza el documento anterior de la misma fuente (los chunks caen en cascada)
  if (source_url) {
    await sb(env, `documents?tenant_id=eq.${tenantId}&source_url=eq.${encodeURIComponent(source_url)}`, {
      method: "DELETE",
    });
  } else if (title) {
    await sb(env, `documents?tenant_id=eq.${tenantId}&source_url=is.null&title=eq.${encodeURIComponent(title)}`, {
      method: "DELETE",
    });
  }

  const doc = (
    await sb(env, "documents", {
      method: "POST",
      body: {
        tenant_id: tenantId,
        source_url,
        source_type,
        title,
        content: clean,
        indexed_at: new Date().toISOString(),
      },
    })
  )[0];

  const pieces = chunkText(clean);
  for (let i = 0; i < pieces.length; i += 20) {
    const batch = pieces.slice(i, i + 20);
    const vecs = await embed(env, batch);
    await sb(env, "chunks", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: batch.map((chunk, j) => ({
        tenant_id: tenantId,
        document_id: doc.id,
        content: chunk,
        embedding: vecs[j],
        position: i + j,
      })),
    });
  }
  return { ok: true, chunks: pieces.length };
}

// archivos en base64 → texto (TXT/MD directo; el resto vía env.AI.toMarkdown) → índice
async function indexUploadedFiles(env, tenantId, files) {
  const report = [];
  for (const f of files) {
    try {
      const bytes = Uint8Array.from(atob(f.data || ""), (c) => c.charCodeAt(0));
      const ext = (f.name?.split(".").pop() || "").toLowerCase();
      let content;
      if (ext === "txt" || ext === "md") {
        content = new TextDecoder().decode(bytes);
      } else {
        const [md] = await env.AI.toMarkdown([
          { name: f.name, blob: new Blob([bytes], { type: "application/octet-stream" }) },
        ]);
        content = md?.data || "";
      }
      const res = await indexDocument(env, tenantId, {
        source_type: "file",
        title: f.name,
        content,
      });
      report.push({ source: f.name, ...res });
    } catch (err) {
      report.push({ source: f.name, ok: false, reason: String(err?.message || err).slice(0, 200) });
    }
  }
  return report;
}

// ---------- herramienta de captura de lead ----------

const LEAD_TOOL = {
  name: "guardar_lead",
  description:
    "Guarda los datos de contacto de una persona interesada para que el equipo comercial le contacte. " +
    "Úsala SOLO cuando el usuario ya te haya dado, como mínimo, su nombre y su email. " +
    "No la uses para preguntas informativas normales.",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["expositor", "visitante", "prensa", "general"],
        description: "Tipo de interés del contacto",
      },
      name: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
      company: { type: "string" },
      message: {
        type: "string",
        description: "Resumen en una frase de lo que necesita esta persona",
      },
    },
    required: ["kind", "name", "email"],
  },
};

// ---------- llamada a Claude ----------

async function callClaude(env, tenant, messages, contextBlock) {
  const system = [
    { type: "text", text: tenant.system_prompt },
    {
      type: "text",
      text:
        "CONTEXTO (única fuente de verdad; si la respuesta no está aquí, dilo y ofrece el contacto):\n\n" +
        (contextBlock || "[No se ha encontrado información relevante para esta pregunta.]"),
    },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: tenant.model,
      max_tokens: 800,
      system,
      messages,
      tools: [LEAD_TOOL],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return res.json();
}

async function runClaude(env, tenant, history, message, contextBlock, saveLead) {
  const msgs = [...history, { role: "user", content: message }];
  let reply = await callClaude(env, tenant, msgs, contextBlock);

  const toolUse = reply.content.find((b) => b.type === "tool_use");
  if (toolUse) {
    await saveLead(toolUse.input);
    msgs.push({ role: "assistant", content: reply.content });
    msgs.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Lead guardado. Confirma al usuario que el equipo le contactará pronto.",
        },
      ],
    });
    reply = await callClaude(env, tenant, msgs, contextBlock);
  }

  const text = reply.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    text,
    usage: {
      input_tokens: reply.usage?.input_tokens,
      output_tokens: reply.usage?.output_tokens,
    },
  };
}

// ---------- llamada a Gemini ----------

async function callGemini(env, tenant, contents, contextBlock) {
  if (!env.GEMINI_API_KEY) throw new Error("Falta el secreto GEMINI_API_KEY");

  const system =
    tenant.system_prompt +
    "\n\nCONTEXTO (única fuente de verdad; si la respuesta no está aquí, dilo y ofrece el contacto):\n\n" +
    (contextBlock || "[No se ha encontrado información relevante para esta pregunta.]");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${tenant.model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [
          {
            functionDeclarations: [
              {
                name: LEAD_TOOL.name,
                description: LEAD_TOOL.description,
                parameters: LEAD_TOOL.input_schema,
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 2000,
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
    }
  );

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  return res.json();
}

async function runGemini(env, tenant, history, message, contextBlock, saveLead) {
  const contents = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];
  let reply = await callGemini(env, tenant, contents, contextBlock);
  let cand = reply.candidates?.[0];

  const call = cand?.content?.parts?.find((p) => p.functionCall);
  if (call) {
    await saveLead(call.functionCall.args);
    // el content vuelve tal cual: Gemini 3 exige conservar las thought signatures
    contents.push(cand.content);
    contents.push({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: call.functionCall.name,
            response: { result: "Lead guardado. Confirma al usuario que el equipo le contactará pronto." },
          },
        },
      ],
    });
    reply = await callGemini(env, tenant, contents, contextBlock);
    cand = reply.candidates?.[0];
  }

  const text = (cand?.content?.parts || [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("\n")
    .trim();

  return {
    text,
    usage: {
      input_tokens: reply.usageMetadata?.promptTokenCount,
      output_tokens: reply.usageMetadata?.candidatesTokenCount,
    },
  };
}

// ---------- portal de clientes: sesiones y contraseñas ----------

function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makePortalToken(env, clientId) {
  const exp = Date.now() + 30 * 24 * 3600 * 1000; // 30 días
  const body = `${clientId}.${exp}`;
  return `${body}.${await hmacSign(body, env.ADMIN_TOKEN)}`;
}

async function portalClientId(env, token) {
  if (!token) return null;
  const p = token.split(".");
  if (p.length !== 3) return null;
  const body = `${p[0]}.${p[1]}`;
  if ((await hmacSign(body, env.ADMIN_TOKEN)) !== p[2]) return null;
  if (Date.now() > parseInt(p[1], 10)) return null;
  return p[0];
}

async function hashPassword(pw, saltB64) {
  const salt = saltB64
    ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256
  );
  return `pbkdf2$100000$${b64(salt)}$${b64(bits)}`;
}

async function verifyPassword(pw, stored) {
  const p = (stored || "").split("$");
  if (p.length !== 4) return false;
  return (await hashPassword(pw, p[2])) === stored;
}

// ---------- administración (para el dueño de la plataforma) ----------

function isAdmin(request, env) {
  return request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// campos que el panel de admin puede escribir
const TENANT_FIELDS = [
  "slug", "name", "active", "system_prompt", "provider", "model",
  "welcome_message", "suggested_questions", "primary_color", "allowed_domains",
  "handoff_email", "lead_webhook_url", "monthly_message_limit", "project_id", "theme",
];
const CLIENT_FIELDS = ["name", "contact_name", "email", "phone", "notes"];
const PROJECT_FIELDS = ["client_id", "name", "description"];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

async function handleAdminApi(request, env, url) {
  if (url.pathname === "/admin/api/tenants" && request.method === "GET") {
    const tenants = await sb(
      env,
      "tenants?select=*,tenant_keys(public_key,revoked_at)&order=created_at.asc"
    );
    return json(tenants);
  }

  if (url.pathname === "/admin/api/tenants" && request.method === "POST") {
    const data = pick(await request.json(), TENANT_FIELDS);
    if (!data.slug || !data.name) return json({ error: "slug y nombre son obligatorios" }, 400);
    const [tenant] = await sb(env, "tenants", { method: "POST", body: data });
    const key = `pk_${tenant.slug}_${randomHex(12)}`;
    await sb(env, "tenant_keys", {
      method: "POST",
      body: { tenant_id: tenant.id, public_key: key },
    });
    return json({ ...tenant, tenant_keys: [{ public_key: key, revoked_at: null }] });
  }

  const edit = url.pathname.match(/^\/admin\/api\/tenants\/([0-9a-f-]{36})$/);
  if (edit && request.method === "PATCH") {
    const data = pick(await request.json(), TENANT_FIELDS);
    const rows = await sb(env, `tenants?id=eq.${edit[1]}`, { method: "PATCH", body: data });
    if (!rows?.length) return json({ error: "tenant no encontrado" }, 404);
    return json(rows[0]);
  }

  if (edit && request.method === "DELETE") {
    await sb(env, `tenants?id=eq.${edit[1]}`, { method: "DELETE" });
    return json({ ok: true });
  }

  const rot = url.pathname.match(/^\/admin\/api\/tenants\/([0-9a-f-]{36})\/(rotate-key|rotate-panel)$/);
  if (rot && request.method === "POST") {
    const id = rot[1];
    if (rot[2] === "rotate-key") {
      const [t] = await sb(env, `tenants?id=eq.${id}&select=slug`);
      if (!t) return json({ error: "tenant no encontrado" }, 404);
      await sb(env, `tenant_keys?tenant_id=eq.${id}&revoked_at=is.null`, {
        method: "PATCH",
        body: { revoked_at: new Date().toISOString() },
      });
      const key = `pk_${t.slug}_${randomHex(12)}`;
      await sb(env, "tenant_keys", { method: "POST", body: { tenant_id: id, public_key: key } });
      return json({ public_key: key });
    }
    const token = `pt_${randomHex(16)}`;
    const rows = await sb(env, `tenants?id=eq.${id}`, {
      method: "PATCH",
      body: { panel_token: token },
    });
    if (!rows?.length) return json({ error: "tenant no encontrado" }, 404);
    return json({ panel_token: token });
  }

  // --- métricas globales del mes (pantalla de inicio) ---
  if (url.pathname === "/admin/api/metrics" && request.method === "GET") {
    return json(await rpc(env, "admin_metrics", {}));
  }

  // --- documentos indexados de un chatbot ---
  const mDocs = url.pathname.match(/^\/admin\/api\/tenants\/([0-9a-f-]{36})\/documents$/);
  if (mDocs && request.method === "GET") {
    const rows = await sb(
      env,
      `documents?tenant_id=eq.${mDocs[1]}` +
        `&select=id,title,source_type,source_url,indexed_at,created_at,chunks(count)` +
        `&order=created_at.desc`
    );
    return json(rows);
  }
  const mDoc = url.pathname.match(/^\/admin\/api\/documents\/([0-9a-f-]{36})$/);
  if (mDoc && request.method === "DELETE") {
    await sb(env, `documents?id=eq.${mDoc[1]}`, { method: "DELETE" });
    return json({ ok: true });
  }

  // --- formulario de FAQ para el cliente ---
  const mFaq = url.pathname.match(/^\/admin\/api\/tenants\/([0-9a-f-]{36})\/faq-form$/);
  if (mFaq && request.method === "GET") {
    const rows = await sb(
      env,
      `faq_forms?tenant_id=eq.${mFaq[1]}&select=token,status,created_at,submitted_at`
    );
    return json(rows?.[0] || {});
  }
  if (mFaq && request.method === "POST") {
    if (!env.GEMINI_API_KEY) return json({ error: "Falta el secreto GEMINI_API_KEY" }, 500);
    const [t] = await sb(env, `tenants?id=eq.${mFaq[1]}&select=name,system_prompt`);
    if (!t) return json({ error: "tenant no encontrado" }, 404);

    const instructions = `Eres consultor de contenido para chatbots de atención al público. Genera las preguntas frecuentes que el dueño de este negocio debería responder para alimentar a su chatbot. Devuelve SOLO un objeto JSON: {"questions":["...","..."]}

Entre 10 y 14 preguntas, en español, concretas y de respuesta factual (precios, horarios, condiciones, proceso de compra o reserva, ubicación, contacto, plazos, garantías, métodos de pago...). Formúlalas como las haría un visitante real de la web. Evita preguntas genéricas o de respuesta obvia.

Negocio: ${t.name}
Instrucciones del bot (contexto): ${(t.system_prompt || "").slice(0, 2000)}`;

    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: instructions }] }],
          generationConfig: { maxOutputTokens: 2000, responseMimeType: "application/json" },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const out = await res.json();
    const text = (out.candidates?.[0]?.content?.parts || [])
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: "la IA no devolvió preguntas válidas; vuelve a intentarlo" }, 502);
    }
    const questions = (parsed.questions || []).slice(0, 20).map((q) => ({ q: String(q), a: "" }));
    if (!questions.length) return json({ error: "la IA no devolvió preguntas; vuelve a intentarlo" }, 502);

    // un formulario por chatbot: regenerar sustituye al anterior (enlace nuevo)
    await sb(env, `faq_forms?tenant_id=eq.${mFaq[1]}`, { method: "DELETE" });
    const [row] = await sb(env, "faq_forms", {
      method: "POST",
      body: { tenant_id: mFaq[1], questions },
    });
    return json({ token: row.token, status: row.status, created_at: row.created_at });
  }

  // --- clientes ---
  if (url.pathname === "/admin/api/clients" && request.method === "GET") {
    const rows = await sb(
      env,
      "clients?select=*,projects(*,tenants(*,tenant_keys(public_key,revoked_at)))&order=created_at.asc"
    );
    return json(rows);
  }
  if (url.pathname === "/admin/api/clients" && request.method === "POST") {
    const data = pick(await request.json(), CLIENT_FIELDS);
    if (!data.name) return json({ error: "el nombre es obligatorio" }, 400);
    const [row] = await sb(env, "clients", { method: "POST", body: data });
    return json(row);
  }
  const mClient = url.pathname.match(/^\/admin\/api\/clients\/([0-9a-f-]{36})$/);
  if (mClient && request.method === "PATCH") {
    const data = pick(await request.json(), CLIENT_FIELDS);
    const rows = await sb(env, `clients?id=eq.${mClient[1]}`, { method: "PATCH", body: data });
    if (!rows?.length) return json({ error: "cliente no encontrado" }, 404);
    return json(rows[0]);
  }
  if (mClient && request.method === "DELETE") {
    // en cascada: primero los chatbots de sus proyectos (arrastran conversaciones,
    // leads, claves y contenido), luego el cliente (los proyectos caen por FK)
    const projs = await sb(env, `projects?client_id=eq.${mClient[1]}&select=id`);
    if (projs?.length) {
      const ids = projs.map((p) => p.id).join(",");
      await sb(env, `tenants?project_id=in.(${ids})`, { method: "DELETE" });
    }
    await sb(env, `clients?id=eq.${mClient[1]}`, { method: "DELETE" });
    return json({ ok: true });
  }

  // --- acceso al portal del cliente: generar contraseña ---
  const mPass = url.pathname.match(/^\/admin\/api\/clients\/([0-9a-f-]{36})\/portal-password$/);
  if (mPass && request.method === "POST") {
    const [c] = await sb(env, `clients?id=eq.${mPass[1]}&select=id,email`);
    if (!c) return json({ error: "cliente no encontrado" }, 404);
    if (!c.email) return json({ error: "ponle primero un email al cliente y guarda" }, 400);
    const pw = randomHex(5) + "-" + randomHex(5);
    const hash = await hashPassword(pw);
    await sb(env, `clients?id=eq.${mPass[1]}`, {
      method: "PATCH",
      body: { portal_password_hash: hash },
    });
    return json({ password: pw, email: c.email });
  }

  // --- facturas del cliente (admin) ---
  const mInv = url.pathname.match(/^\/admin\/api\/clients\/([0-9a-f-]{36})\/invoices$/);
  if (mInv && request.method === "GET") {
    return json(
      await sb(env, `invoices?client_id=eq.${mInv[1]}&order=issued_at.desc,created_at.desc`)
    );
  }
  if (mInv && request.method === "POST") {
    const { number, concept, amount_cents, issued_at, status, pdf_base64 } = await request.json();
    if (!number || !amount_cents) return json({ error: "faltan el número o el importe" }, 400);
    const [inv] = await sb(env, "invoices", {
      method: "POST",
      body: {
        client_id: mInv[1],
        number: String(number).slice(0, 60),
        concept: String(concept || "").slice(0, 300),
        amount_cents: Math.round(amount_cents),
        issued_at: issued_at || undefined,
        status: status === "pagada" ? "pagada" : "pendiente",
      },
    });
    if (pdf_base64) {
      const bytes = Uint8Array.from(atob(pdf_base64), (c) => c.charCodeAt(0));
      const path = `${mInv[1]}/${inv.id}.pdf`;
      const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/facturas/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/pdf",
        },
        body: bytes,
      });
      if (up.ok) {
        await sb(env, `invoices?id=eq.${inv.id}`, { method: "PATCH", body: { pdf_path: path } });
        inv.pdf_path = path;
      } else {
        inv.pdf_error = `Storage ${up.status}: ${(await up.text()).slice(0, 200)}`;
      }
    }
    return json(inv);
  }
  const mInvOne = url.pathname.match(/^\/admin\/api\/invoices\/([0-9a-f-]{36})$/);
  if (mInvOne && request.method === "PATCH") {
    const { status } = await request.json();
    if (!["pendiente", "pagada"].includes(status)) return json({ error: "estado no válido" }, 400);
    const rows = await sb(env, `invoices?id=eq.${mInvOne[1]}`, { method: "PATCH", body: { status } });
    return json(rows?.[0] || { error: "factura no encontrada" });
  }
  if (mInvOne && request.method === "DELETE") {
    const [inv] = await sb(env, `invoices?id=eq.${mInvOne[1]}&select=pdf_path`);
    if (inv?.pdf_path) {
      await fetch(`${env.SUPABASE_URL}/storage/v1/object/facturas/${inv.pdf_path}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
      }).catch(() => {});
    }
    await sb(env, `invoices?id=eq.${mInvOne[1]}`, { method: "DELETE" });
    return json({ ok: true });
  }

  // --- proyectos ---
  if (url.pathname === "/admin/api/projects" && request.method === "POST") {
    const data = pick(await request.json(), PROJECT_FIELDS);
    if (!data.client_id || !data.name) return json({ error: "faltan el cliente o el nombre" }, 400);
    const [row] = await sb(env, "projects", { method: "POST", body: data });
    return json(row);
  }
  const mProj = url.pathname.match(/^\/admin\/api\/projects\/([0-9a-f-]{36})$/);
  if (mProj && request.method === "PATCH") {
    const data = pick(await request.json(), PROJECT_FIELDS);
    const rows = await sb(env, `projects?id=eq.${mProj[1]}`, { method: "PATCH", body: data });
    if (!rows?.length) return json({ error: "proyecto no encontrado" }, 404);
    return json(rows[0]);
  }
  if (mProj && request.method === "DELETE") {
    // en cascada: los chatbots del proyecto y después el proyecto
    await sb(env, `tenants?project_id=eq.${mProj[1]}`, { method: "DELETE" });
    await sb(env, `projects?id=eq.${mProj[1]}`, { method: "DELETE" });
    return json({ ok: true });
  }

  // --- asistente de configuración con IA ---
  if (url.pathname === "/admin/api/assist" && request.method === "POST") {
    if (!env.GEMINI_API_KEY) return json({ error: "Falta el secreto GEMINI_API_KEY" }, 500);
    const { brief } = await request.json();
    if (!brief || brief.trim().length < 20) {
      return json({ error: "describe el negocio con algo más de detalle" }, 400);
    }
    const instructions = `Eres consultor senior de chatbots de atención al público. A partir del encargo, redacta la configuración de un chatbot RAG para la web de un negocio, en español. Devuelve SOLO un objeto JSON con esta forma exacta:
{"system_prompt":"...","welcome_message":"...","suggested_questions":["...","...","...","..."]}

Requisitos del system_prompt (400-700 palabras, listo para producción):
- Identidad, tono y ámbito del asistente, adaptados al negocio del encargo.
- Regla innegociable: nunca inventar datos (fechas, precios, condiciones, disponibilidad); si no está en el contexto proporcionado, decirlo con naturalidad y derivar al canal de contacto.
- Prohibir consejo profesional sensible cuando aplique (médico, legal, financiero).
- Cuándo y cómo capturar leads con la herramienta guardar_lead: solo cuando el usuario haya dado como mínimo nombre y email, pidiendo con naturalidad lo que falte si muestra interés comercial.
- Cómo manejar preguntas fuera de ámbito y usuarios difíciles, sin discutir.

welcome_message: 1-2 frases cercanas y útiles. suggested_questions: las 4 preguntas que más hará un visitante real.

Encargo del dueño de la plataforma:
${brief}`;
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: instructions }] }],
          generationConfig: { maxOutputTokens: 4000, responseMimeType: "application/json" },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const out = await res.json();
    const text = (out.candidates?.[0]?.content?.parts || [])
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    try {
      return json(JSON.parse(text));
    } catch {
      return json({ error: "la IA no devolvió una configuración válida; vuelve a intentarlo" }, 502);
    }
  }

  return json({ error: "no encontrado" }, 404);
}

const ADMIN_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Administración — chatbots</title>
<style>
  :root{--ink:#1a1a1a;--mut:#777;--line:#e5e5e2;--bg:#f7f7f5;--acc:#111;--ok:#0a7a4b;--err:#b3261e}
  *{box-sizing:border-box;margin:0}
  body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
  .hide{display:none!important}
  button{font:inherit;cursor:pointer}
  input,textarea,select{font:inherit;width:100%;border:1px solid var(--line);border-radius:10px;
    padding:9px 12px;background:#fff;color:var(--ink)}
  input:focus,textarea:focus,select:focus{outline:0;border-color:#999}
  textarea{resize:vertical}
  label{display:block;font-size:13px;color:var(--mut);margin:14px 0 4px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
  @media(max-width:640px){.row{grid-template-columns:1fr}}
  .primary{background:var(--acc);color:#fff;border:0;border-radius:10px;padding:10px 18px}
  .ghost{background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px 14px}
  .small{font-size:13px;padding:6px 12px}
  .mut{color:var(--mut);font-size:13px}
  .ok{color:var(--ok);font-size:13px}
  .err{color:var(--err);font-size:13px}
  .login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .login .card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:32px;
    width:380px;max-width:100%}
  .login h1{font-size:18px;margin-bottom:6px}
  .login input{margin:14px 0 10px}
  .login button{width:100%}
  header{background:#fff;border-bottom:1px solid var(--line);padding:14px 24px;display:flex;
    justify-content:space-between;align-items:center}
  header h1{font-size:17px}
  .wrap{display:grid;grid-template-columns:260px 1fr;gap:20px;max-width:1120px;margin:0 auto;
    padding:20px 16px}
  @media(max-width:760px){.wrap{grid-template-columns:1fr}}
  aside .primary{width:100%;margin-bottom:12px}
  #tree button,#proj-list button,#bot-list button{display:block;width:100%;text-align:left;
    background:#fff;border:1px solid var(--line);border-radius:10px;padding:9px 14px;margin-bottom:7px}
  #tree button.on{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
  #tree button.lvl1{width:calc(100% - 14px);margin-left:14px}
  #tree button.lvl2{width:calc(100% - 28px);margin-left:28px;font-size:14px}
  #tree button.off,#bot-list button.off{color:var(--mut)}
  .card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:22px;margin-bottom:16px}
  .card h2{font-size:15px;margin-bottom:4px}
  .card .sub{color:var(--mut);font-size:13px;margin-bottom:8px}
  .actions{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap}
  .check{display:flex;gap:8px;align-items:center;margin-top:14px}
  .check input{width:auto}
  .copyrow{display:flex;gap:8px;margin-top:6px}
  .copyrow input,.copyrow textarea{font-family:ui-monospace,monospace;font-size:12.5px;background:#fafaf8}
  #crumb{margin-bottom:12px}
  .doc{display:flex;justify-content:space-between;align-items:center;gap:10px;
    border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin-bottom:7px;font-size:14px}
  .doc .meta{color:var(--mut);font-size:12.5px}
  .ftabs{display:flex;gap:8px;margin:18px 0 4px;flex-wrap:wrap}
  .ftabs button{border:1px solid var(--line);background:#fafaf8;border-radius:8px;padding:6px 12px;
    font-size:13px;cursor:pointer}
  .ftabs button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
  .ft{display:none}
  .ft.on{display:block}
  #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#111;color:#fff;
    padding:10px 18px;border-radius:10px;font-size:14px;opacity:0;transition:opacity .25s;
    z-index:60;pointer-events:none;max-width:90vw}
  #toast.on{opacity:1}
  #toast.on.errt{background:var(--err)}
  .kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
  .kpi{background:#fafaf8;border:1px solid var(--line);border-radius:12px;padding:14px 18px;
    min-width:140px;flex:1}
  .kpi b{display:block;font-size:24px}
  .kpi span{color:var(--mut);font-size:13px}
  table.home{width:100%;border-collapse:collapse}
  table.home th,table.home td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:14px}
  table.home th{color:var(--mut);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  table.home tbody tr{cursor:pointer}
  table.home tbody tr:hover td{background:#fafaf8}
  #prev{border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:8px;background:#f7f7f5;
    display:flex;flex-direction:column;gap:10px;max-width:340px}
  #pv-head{display:flex;align-items:center;gap:9px;border-radius:12px;padding:10px 12px;background:#111;color:#fff}
  #pv-av{width:30px;height:30px;border-radius:15px;background:rgba(0,0,0,.18);display:flex;
    align-items:center;justify-content:center;font-weight:600;flex:0 0 auto}
  #pv-bub{background:#fff;border-radius:12px;border-bottom-left-radius:4px;padding:8px 12px;font-size:13px;max-width:85%;align-self:flex-start}
  #pv-mine{border-radius:12px;border-bottom-right-radius:4px;padding:8px 12px;font-size:13px;max-width:85%;align-self:flex-end;background:#111;color:#fff}
  #pv-btnrow{display:flex;justify-content:flex-end}
  #pv-btn{width:44px;height:44px;border-radius:22px;background:#111}
</style>
</head>
<body>

<div id="login" class="login hide">
  <div class="card">
    <h1>Administración de chatbots</h1>
    <p class="mut">Introduce el token de administración (el secreto ADMIN_TOKEN del Worker).</p>
    <input id="tok" type="password" placeholder="Token" autocomplete="current-password">
    <button id="enter" class="primary">Entrar</button>
    <p id="login-err" class="err"></p>
  </div>
</div>

<div id="app" class="hide">
  <header>
    <h1>Plataforma de chatbots</h1>
    <button id="logout" class="ghost small">Salir</button>
  </header>
  <div class="wrap">
    <aside>
      <button id="home-btn" class="ghost" style="width:100%;margin-bottom:8px">📊 Inicio</button>
      <button id="new-client" class="primary">+ Nuevo cliente</button>
      <div id="tree"></div>
    </aside>
    <main id="main" class="hide">

      <p id="crumb" class="mut"></p>

      <div class="card hide" id="v-home">
        <h2>Resumen del mes</h2>
        <p class="sub">Actividad de todos los chatbots en el mes en curso. Pulsa una fila para ir al chatbot.</p>
        <div class="kpis">
          <div class="kpi"><b id="k-q">–</b><span>preguntas</span></div>
          <div class="kpi"><b id="k-r">–</b><span>respondidas con contexto</span></div>
          <div class="kpi"><b id="k-l">–</b><span>leads</span></div>
          <div class="kpi"><b id="k-b">–</b><span>chatbots activos</span></div>
        </div>
        <table class="home">
          <thead><tr><th>Chatbot</th><th>Cliente</th><th>Preguntas</th><th>Leads</th><th>Sin respuesta</th><th>Estado</th></tr></thead>
          <tbody id="home-body"></tbody>
        </table>
      </div>

      <div class="card hide" id="v-client">
        <h2 id="c-title">Cliente</h2>
        <p class="sub">Datos del cliente. Dentro tiene proyectos, y cada proyecto sus herramientas.</p>
        <div class="row">
          <div><label>Nombre del cliente / empresa</label><input id="c-name"></div>
          <div><label>Persona de contacto</label><input id="c-contact"></div>
        </div>
        <div class="row">
          <div><label>Email</label><input id="c-email" type="email"></div>
          <div><label>Teléfono</label><input id="c-phone"></div>
        </div>
        <label>Notas internas (solo las ves tú)</label>
        <textarea id="c-notes" rows="3"></textarea>
        <div class="actions">
          <button id="c-save" class="primary">Guardar</button>
          <button id="c-del" class="ghost small">Eliminar cliente</button>
          <span id="c-msg"></span>
        </div>
      </div>

      <div class="card hide" id="v-client-projects">
        <h2>Proyectos</h2>
        <p class="sub">Cada proyecto agrupa las herramientas que le vendes a este cliente.</p>
        <div id="proj-list"></div>
        <div class="copyrow" style="margin-top:10px">
          <input id="proj-new-name" placeholder="Nombre del proyecto nuevo (p. ej. Chatbot web)">
          <button id="proj-create" class="ghost small">Crear&nbsp;proyecto</button>
        </div>
        <p id="proj-msg" class="mut"></p>
      </div>

      <div class="card hide" id="v-client-portal">
        <h2>Acceso al portal del cliente</h2>
        <p class="sub">El cliente entra con su email (el de su ficha) y una contraseña que generas aquí.
        En su portal ve todos sus proyectos, sus herramientas y su facturación.</p>
        <div class="copyrow"><input id="portal-url" readonly>
          <button class="ghost small" data-copy="portal-url">Copiar</button></div>
        <div class="actions">
          <button id="portal-pass" class="ghost small">Generar contraseña nueva</button>
          <span id="portal-msg" class="mut"></span>
        </div>
        <p id="portal-pass-out" class="mut" style="margin-top:8px"></p>
      </div>

      <div class="card hide" id="v-client-inv">
        <h2>Facturación</h2>
        <p class="sub">Las facturas de este cliente; él las ve y descarga desde su portal.</p>
        <div id="inv-list" class="mut">Cargando…</div>
        <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
        <div class="row">
          <div><label>Número</label><input id="iv-num" placeholder="2026-001"></div>
          <div><label>Importe (€)</label><input id="iv-amt" type="number" step="0.01" min="0"></div>
        </div>
        <div class="row">
          <div><label>Fecha de emisión</label><input id="iv-date" type="date"></div>
          <div><label>Estado</label>
            <select id="iv-status">
              <option value="pendiente">Pendiente</option>
              <option value="pagada">Pagada</option>
            </select></div>
        </div>
        <label>Concepto</label>
        <input id="iv-concept" placeholder="Cuota mensual chatbot — julio 2026">
        <label>PDF de la factura (opcional, máx. 8 MB)</label>
        <input id="iv-pdf" type="file" accept=".pdf">
        <div class="actions">
          <button id="iv-add" class="primary">Añadir factura</button>
          <span id="iv-msg" class="mut"></span>
        </div>
      </div>

      <div class="card hide" id="v-project">
        <h2 id="p-title">Proyecto</h2>
        <div class="row">
          <div><label>Nombre</label><input id="p-name"></div>
          <div><label>Descripción</label><input id="p-desc"></div>
        </div>
        <div class="actions">
          <button id="p-save" class="primary">Guardar</button>
          <button id="p-del" class="ghost small">Eliminar proyecto</button>
          <span id="p-msg"></span>
        </div>
      </div>

      <div class="card hide" id="v-project-tools">
        <h2>Herramientas del proyecto</h2>
        <p class="sub">De momento la herramienta disponible es el chatbot; un proyecto puede tener varios.</p>
        <div id="bot-list"></div>
        <div class="actions"><button id="bot-create" class="primary">+ Añadir chatbot</button></div>
      </div>

      <div class="card hide" id="v-assist">
        <h2>Configurar con IA</h2>
        <p class="sub">Describe el negocio y qué debe conseguir el bot. La IA redacta unas instrucciones
        profesionales, la bienvenida y las preguntas sugeridas; tú las revisas abajo y guardas.</p>
        <textarea id="a-brief" rows="4" placeholder="Ej.: Feria profesional de fisioterapia en IFEMA Madrid. El bot resuelve dudas de entradas, programa y stands, capta como leads a las empresas interesadas en exponer, y jamás inventa fechas ni precios."></textarea>
        <div class="actions">
          <button id="a-run" class="primary">Generar configuración</button>
          <span id="a-msg" class="mut"></span>
        </div>
      </div>

      <div class="card hide" id="v-tenant">
        <h2 id="f-title">Chatbot</h2>
        <p class="sub">Los cambios se aplican al guardar. El bot los usa en la siguiente conversación.</p>
        <div class="row">
          <div><label>Nombre (lo ve el usuario en el chat)</label><input id="f-name"></div>
          <div><label>Slug (identificador interno, sin espacios)</label><input id="f-slug"></div>
        </div>
        <div class="ftabs">
          <button class="on" data-ft="ft-comp">Comportamiento</button>
          <button data-ft="ft-ap">Apariencia</button>
          <button data-ft="ft-leads">Leads</button>
          <button data-ft="ft-seg">Seguridad y límites</button>
        </div>
        <div class="ft on" id="ft-comp">
          <label>Instrucciones del bot (system prompt): quién es, qué puede y qué no puede decir</label>
          <textarea id="f-prompt" rows="8"></textarea>
          <label>Mensaje de bienvenida</label>
          <input id="f-welcome">
          <label>Preguntas sugeridas (una por línea)</label>
          <textarea id="f-sugg" rows="3"></textarea>
          <div class="row">
            <div>
              <label>Proveedor de IA</label>
              <select id="f-provider">
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="google">Google (Gemini)</option>
              </select>
            </div>
            <div>
              <label>Modelo</label>
              <input id="f-model" list="models">
              <datalist id="models">
                <option value="claude-sonnet-4-6"><option value="claude-sonnet-5">
                <option value="claude-haiku-4-5"><option value="gemini-3.5-flash">
                <option value="gemini-3.1-flash-lite"><option value="gemini-flash-latest">
                <option value="gemini-flash-lite-latest">
              </datalist>
            </div>
          </div>
        </div>
        <div class="ft" id="ft-ap">
          <div class="row">
            <div><label>Color principal (cabecera, botón, mensajes del usuario)</label>
              <input id="f-color" type="color" style="width:100%;height:42px;padding:4px"></div>
            <div><label>Color de las respuestas del bot</label>
              <input id="f-color2" type="color" value="#f2f2f0" style="width:100%;height:42px;padding:4px"></div>
          </div>
          <div class="row">
            <div><label>Fondo de la ventana de chat</label>
              <input id="f-colorbg" type="color" value="#ffffff" style="width:100%;height:42px;padding:4px"></div>
            <div><label>Tipografía</label>
              <select id="f-font">
                <option value="system">Sistema (por defecto)</option>
                <option value="Inter">Inter</option>
                <option value="Poppins">Poppins</option>
                <option value="Roboto">Roboto</option>
                <option value="Montserrat">Montserrat</option>
                <option value="Lato">Lato</option>
                <option value="georgia">Georgia (serif clásica)</option>
              </select></div>
          </div>
          <div class="row">
            <div><label>Redondez de bordes: <span id="f-radius-v">14</span> px</label>
              <input id="f-radius" type="range" min="0" max="24" step="2" value="14"></div>
            <div><label>Sombras</label>
              <select id="f-shadow">
                <option value="suave">Suaves</option>
                <option value="ninguna">Sin sombra</option>
                <option value="fuerte">Marcadas</option>
              </select></div>
          </div>
          <div class="row">
            <div><label>Posición en la web</label>
              <select id="f-side">
                <option value="derecha">Abajo a la derecha</option>
                <option value="izquierda">Abajo a la izquierda</option>
              </select></div>
            <div><label>Subtítulo de la cabecera</label>
              <input id="f-subtitle" placeholder="Suele responder al instante"></div>
          </div>
          <label>Logo del cliente (URL de una imagen cuadrada; vacío = inicial del nombre)</label>
          <input id="f-logo" type="url" placeholder="https://cliente.com/logo.png">
          <div class="row">
            <div class="check" style="margin-top:18px"><input id="f-teaser" type="checkbox" checked>
              <label for="f-teaser" style="margin:0">Burbuja de invitación automática</label></div>
            <div><label>Segundos hasta la invitación</label>
              <input id="f-tdelay" type="number" min="1" max="60" value="4" style="max-width:120px"></div>
          </div>
          <label>Vista previa en vivo</label>
          <div id="prev">
            <div id="pv-head">
              <div id="pv-av">A</div>
              <div>
                <div id="pv-name" style="font-weight:600;font-size:14px">Asistente</div>
                <div id="pv-sub" style="font-size:11px;opacity:.75">Suele responder al instante</div>
              </div>
            </div>
            <div id="pv-bub">¡Hola!</div>
            <div id="pv-mine">Tengo una duda</div>
            <div id="pv-btnrow"><div id="pv-btn"></div></div>
          </div>
        </div>
        <div class="ft" id="ft-leads">
          <div class="row">
            <div><label>Email para leads / handoff</label><input id="f-email" type="email"></div>
            <div><label>Webhook de leads (Zapier, Make, CRM…)</label><input id="f-webhook" type="url"></div>
          </div>
          <p class="mut" style="margin-top:10px">El webhook recibe cada lead al momento; con Zapier o Make
          puedes reenviarlo a email, hoja de cálculo o CRM sin programar.</p>
        </div>
        <div class="ft" id="ft-seg">
          <label>Dominios permitidos (uno por línea; el widget solo funciona desde estos)</label>
          <textarea id="f-domains" rows="2"></textarea>
          <label>Límite de mensajes al mes (al alcanzarlo, el bot responde un aviso fijo sin gastar IA)</label>
          <input id="f-limit" type="number" min="0" style="max-width:200px">
          <div class="check"><input id="f-active" type="checkbox"><label for="f-active" style="margin:0">Activo (desmárcalo para apagar este chatbot)</label></div>
        </div>
        <div class="actions">
          <button id="save" class="primary">Guardar</button>
          <button id="f-del" class="ghost small">Eliminar chatbot</button>
          <span id="save-msg"></span>
        </div>
      </div>

      <div class="card hide" id="integ">
        <h2>Integración y demo</h2>
        <p class="sub">El snippet para la web del cliente, su panel de datos y la demo para enseñárselo
        antes de desplegar.</p>
        <label>Demo para el cliente: copia de su web con el bot funcionando de verdad</label>
        <div class="copyrow"><input id="i-demo" readonly>
          <button class="ghost small" data-copy="i-demo">Copiar</button>
          <button id="i-demo-open" class="ghost small">Abrir</button></div>
        <p id="i-demo-hint" class="mut" style="margin-top:6px"></p>
        <label>Snippet del widget (pegar en la web del cliente cuando dé el visto bueno)</label>
        <div class="copyrow"><textarea id="i-snippet" rows="3" readonly></textarea>
          <button class="ghost small" data-copy="i-snippet">Copiar</button></div>
        <label>Panel del cliente (conversaciones, leads, preguntas sin respuesta)</label>
        <div class="copyrow"><input id="i-panel" readonly>
          <button class="ghost small" data-copy="i-panel">Copiar</button>
          <button id="i-open" class="ghost small">Abrir</button></div>
        <div class="actions">
          <button id="rot-key" class="ghost small">Rotar clave del widget</button>
          <button id="rot-panel" class="ghost small">Rotar enlace del panel</button>
          <span id="integ-msg" class="mut"></span>
        </div>
        <p class="mut" style="margin-top:10px">Rotar invalida lo anterior al momento: tendrás que
        actualizar el snippet en la web del cliente o reenviarle el enlace nuevo.</p>
      </div>

      <div class="card hide" id="ingest">
        <h2>Contenido del bot</h2>
        <p class="sub">Lo que el bot sabe. Reindexar la misma fuente (URL o archivo con el mismo nombre)
        reemplaza la versión anterior, no duplica.</p>
        <label>Documentos indexados — incluye los que suba el cliente desde su panel</label>
        <div id="doc-list" class="mut">Cargando…</div>
        <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
        <label>Formulario de preguntas frecuentes para el cliente</label>
        <p id="faq-box" class="mut" style="margin-bottom:8px">La IA propone las preguntas típicas del
        negocio; le envías el enlace al cliente, las responde (puede añadir o quitar) y al enviar
        quedan indexadas en el bot automáticamente.</p>
        <div class="copyrow hide" id="faq-linkrow"><input id="faq-link" readonly>
          <button class="ghost small" data-copy="faq-link">Copiar</button>
          <button id="faq-open" class="ghost small">Abrir</button></div>
        <div class="actions" style="margin-top:8px">
          <button id="faq-gen" class="ghost small">Generar formulario con IA</button>
          <span id="faq-msg" class="mut"></span>
        </div>
        <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
        <label>Subir archivos (PDF, TXT, MD, CSV, HTML, imágenes…)</label>
        <input id="g-files" type="file" multiple
          accept=".pdf,.txt,.md,.csv,.html,.htm,.jpg,.jpeg,.png,.webp,.svg">
        <div class="actions">
          <button id="g-upload" class="primary">Subir e indexar archivos</button>
          <span id="g-upmsg" class="mut"></span>
        </div>
        <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
        <label>URLs a indexar (una por línea)</label>
        <textarea id="g-urls" rows="3"></textarea>
        <label>O texto pegado a mano — título</label>
        <input id="g-title" placeholder="FAQ oficial y tarifas">
        <label>Contenido</label>
        <textarea id="g-content" rows="6" placeholder="Fechas: … Horarios: … Precios: … Contacto: …"></textarea>
        <div class="actions">
          <button id="g-run" class="primary">Indexar</button>
          <span id="g-msg" class="mut"></span>
        </div>
        <div id="g-report" class="mut" style="margin-top:10px"></div>
      </div>

    </main>
  </div>
</div>

<div id="toast"></div>

<script>
var TOKEN = localStorage.getItem("cb_admin") || "";
var data = [];
var sel = { type: null, id: null, isNew: false, parentId: null };

function $(id) { return document.getElementById(id); }

function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign(
    { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    opts.headers || {}
  );
  return fetch(path, opts).then(function (r) {
    if (r.status === 401) { showLogin("Token no válido o caducado."); throw new Error("401"); }
    return r.json();
  });
}

function showLogin(msg) {
  $("app").classList.add("hide");
  $("login").classList.remove("hide");
  $("login-err").textContent = msg || "";
  $("tok").focus();
}

function showApp() {
  $("login").classList.add("hide");
  $("app").classList.remove("hide");
}

$("enter").onclick = function () {
  TOKEN = $("tok").value.trim();
  if (!TOKEN) return;
  localStorage.setItem("cb_admin", TOKEN);
  load();
};
$("tok").addEventListener("keydown", function (e) { if (e.key === "Enter") $("enter").click(); });
$("logout").onclick = function () {
  localStorage.removeItem("cb_admin");
  TOKEN = "";
  showLogin();
};

function load() {
  return api("/admin/api/clients").then(function (d) {
    if (d.error) { showLogin(d.error); return; }
    data = d;
    showApp();
    renderTree();
    refreshSelection();
  }).catch(function () {});
}

function findClient(id) { return data.find(function (c) { return c.id === id; }); }
function findProject(id) {
  for (var i = 0; i < data.length; i++) {
    var p = (data[i].projects || []).find(function (x) { return x.id === id; });
    if (p) return { client: data[i], project: p };
  }
  return null;
}
function findTenant(id) {
  for (var i = 0; i < data.length; i++) {
    var ps = data[i].projects || [];
    for (var j = 0; j < ps.length; j++) {
      var t = (ps[j].tenants || []).find(function (x) { return x.id === id; });
      if (t) return { client: data[i], project: ps[j], tenant: t };
    }
  }
  return null;
}

function refreshSelection() {
  if (sel.type === "client" && !sel.isNew && findClient(sel.id)) return selClient(sel.id);
  if (sel.type === "project" && findProject(sel.id)) return selProject(sel.id);
  if (sel.type === "tenant" && !sel.isNew && findTenant(sel.id)) return selTenant(sel.id);
  return goHome();
}

function toast(msg, isErr) {
  var t = $("toast");
  t.textContent = msg;
  t.className = isErr ? "on errt" : "on";
  clearTimeout(t._h);
  t._h = setTimeout(function () { t.className = ""; }, 2600);
}

function goHome() {
  sel = { type: "home" };
  renderTree();
  crumb(["Inicio"]);
  showCards(["v-home"]);
  api("/admin/api/metrics").then(function (ms) {
    if (!ms || ms.error) return;
    var byId = {};
    ms.forEach(function (m) { byId[m.tenant_id] = m; });
    var q = 0, l = 0, un = 0, bots = 0, rows = [];
    data.forEach(function (c) {
      (c.projects || []).forEach(function (p) {
        (p.tenants || []).forEach(function (t) {
          var m = byId[t.id] || { questions: 0, leads: 0, unanswered: 0 };
          q += m.questions; l += m.leads; un += m.unanswered;
          if (t.active) bots++;
          rows.push({ t: t, c: c, m: m });
        });
      });
    });
    $("k-q").textContent = q;
    $("k-l").textContent = l;
    $("k-r").textContent = q ? Math.max(0, Math.round((100 * (q - un)) / q)) + "%" : "–";
    $("k-b").textContent = bots;
    var tb = $("home-body");
    tb.innerHTML = "";
    if (!rows.length) {
      tb.innerHTML = "<tr><td colspan='6' class='mut'>Todavía no hay chatbots. Crea tu primer cliente en el menú de la izquierda.</td></tr>";
      return;
    }
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      [r.t.name, r.c.name, r.m.questions, r.m.leads, r.m.unanswered, r.t.active ? "Activo" : "Apagado"]
        .forEach(function (v) {
          var td = document.createElement("td");
          td.textContent = v;
          tr.appendChild(td);
        });
      tr.onclick = function () { selTenant(r.t.id); };
      tb.appendChild(tr);
    });
  });
}
$("home-btn").onclick = goHome;

function treeBtn(label, cls, on, click) {
  var b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  if (on) b.classList.add("on");
  b.onclick = click;
  return b;
}

function renderTree() {
  var box = $("tree");
  box.innerHTML = "";
  data.forEach(function (c) {
    box.appendChild(treeBtn(c.name, "", sel.type === "client" && sel.id === c.id, function () { selClient(c.id); }));
    (c.projects || []).forEach(function (p) {
      box.appendChild(treeBtn("▸ " + p.name, "lvl1", sel.type === "project" && sel.id === p.id, function () { selProject(p.id); }));
      (p.tenants || []).forEach(function (t) {
        var cls = "lvl2" + (t.active ? "" : " off");
        box.appendChild(treeBtn("💬 " + t.name + (t.active ? "" : " (apagado)"), cls, sel.type === "tenant" && sel.id === t.id, function () { selTenant(t.id); }));
      });
    });
  });
}

var ALL_VIEWS = ["v-home", "v-client", "v-client-projects", "v-client-portal", "v-client-inv", "v-project", "v-project-tools", "v-assist", "v-tenant", "integ", "ingest"];
function showCards(ids) {
  ALL_VIEWS.forEach(function (v) { $(v).classList.toggle("hide", ids.indexOf(v) < 0); });
  $("main").classList.remove("hide");
}

function crumb(parts) { $("crumb").textContent = parts.join("  ›  "); }

// ----- cliente -----

function selClient(id) {
  sel = { type: "client", id: id, isNew: !id };
  renderTree();
  var c = id ? findClient(id) : null;
  crumb(c ? [c.name] : ["Nuevo cliente"]);
  $("c-title").textContent = c ? c.name : "Nuevo cliente";
  $("c-name").value = c ? c.name : "";
  $("c-contact").value = c ? c.contact_name || "" : "";
  $("c-email").value = c ? c.email || "" : "";
  $("c-phone").value = c ? c.phone || "" : "";
  $("c-notes").value = c ? c.notes || "" : "";
  $("c-msg").textContent = "";
  $("proj-msg").textContent = "";
  $("proj-new-name").value = "";
  if (c) {
    renderProjects(c);
    $("portal-url").value = location.origin + "/acceso";
    $("portal-pass-out").textContent = c.portal_password_hash
      ? "El cliente ya tiene contraseña. Genera una nueva solo si la ha perdido (la anterior dejará de valer)."
      : "Este cliente aún no tiene contraseña: genera una y envíasela junto con el enlace de acceso.";
    $("portal-pass-out").className = "mut";
    $("portal-msg").textContent = "";
    $("iv-msg").textContent = "";
    loadInvoices();
  }
  showCards(c ? ["v-client", "v-client-projects", "v-client-portal", "v-client-inv"] : ["v-client"]);
}

function loadInvoices() {
  var box = $("inv-list");
  box.textContent = "Cargando…";
  api("/admin/api/clients/" + sel.id + "/invoices").then(function (list) {
    if (list.error) { box.textContent = list.error; return; }
    box.innerHTML = "";
    if (!list.length) { box.textContent = "Sin facturas todavía. Añade la primera abajo."; return; }
    list.forEach(function (v) {
      var row = document.createElement("div");
      row.className = "doc";
      var left = document.createElement("div");
      var t1 = document.createElement("div");
      t1.textContent = v.number + " — " +
        (v.amount_cents / 100).toLocaleString("es-ES", { minimumFractionDigits: 2 }) + " € · " +
        (v.status === "pagada" ? "✓ pagada" : "pendiente");
      var meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = (v.issued_at || "") + (v.concept ? " · " + v.concept : "") +
        (v.pdf_path ? " · con PDF" : " · sin PDF");
      left.appendChild(t1);
      left.appendChild(meta);
      var btns = document.createElement("div");
      btns.style.whiteSpace = "nowrap";
      if (v.status !== "pagada") {
        var pay = document.createElement("button");
        pay.className = "ghost small";
        pay.textContent = "Marcar pagada";
        pay.onclick = function () {
          api("/admin/api/invoices/" + v.id, { method: "PATCH", body: JSON.stringify({ status: "pagada" }) })
            .then(loadInvoices);
        };
        btns.appendChild(pay);
      }
      var del = document.createElement("button");
      del.className = "ghost small";
      del.style.marginLeft = "6px";
      del.textContent = "Eliminar";
      del.onclick = function () {
        if (!confirm("¿Eliminar la factura " + v.number + "?")) return;
        api("/admin/api/invoices/" + v.id, { method: "DELETE" }).then(loadInvoices);
      };
      btns.appendChild(del);
      row.appendChild(left);
      row.appendChild(btns);
      box.appendChild(row);
    });
  }).catch(function () { box.textContent = "No se ha podido cargar."; });
}

$("iv-add").onclick = function () {
  var amt = Math.round(parseFloat(($("iv-amt").value || "0").replace(",", ".")) * 100);
  var num = $("iv-num").value.trim();
  if (!num || !amt) {
    $("iv-msg").textContent = "El número y el importe son obligatorios."; $("iv-msg").className = "err";
    return;
  }
  var send = function (pdf64) {
    $("iv-msg").textContent = "Guardando…"; $("iv-msg").className = "mut";
    api("/admin/api/clients/" + sel.id + "/invoices", {
      method: "POST",
      body: JSON.stringify({
        number: num,
        concept: $("iv-concept").value.trim(),
        amount_cents: amt,
        issued_at: $("iv-date").value || null,
        status: $("iv-status").value,
        pdf_base64: pdf64 || null,
      }),
    }).then(function (r) {
      if (r.error) { $("iv-msg").textContent = r.error; $("iv-msg").className = "err"; return; }
      $("iv-msg").textContent = "Factura añadida ✓"; $("iv-msg").className = "ok";
      $("iv-num").value = ""; $("iv-amt").value = ""; $("iv-concept").value = ""; $("iv-pdf").value = "";
      toast("Factura añadida ✓");
      loadInvoices();
    }).catch(function () { $("iv-msg").textContent = "Error al guardar."; $("iv-msg").className = "err"; });
  };
  var f = $("iv-pdf").files[0];
  if (f) {
    if (f.size > 8 * 1024 * 1024) {
      $("iv-msg").textContent = "El PDF supera los 8 MB."; $("iv-msg").className = "err";
      return;
    }
    var rd = new FileReader();
    rd.onload = function () { send(String(rd.result).split(",")[1]); };
    rd.readAsDataURL(f);
  } else {
    send(null);
  }
};

$("portal-pass").onclick = function () {
  var c = findClient(sel.id);
  if (!confirm("Se generará una contraseña nueva para " + (c ? c.name : "este cliente") +
    " y la anterior dejará de valer. ¿Seguir?")) return;
  api("/admin/api/clients/" + sel.id + "/portal-password", { method: "POST" }).then(function (r) {
    if (r.error) { $("portal-msg").textContent = r.error; $("portal-msg").className = "err"; return; }
    $("portal-msg").textContent = "";
    $("portal-pass-out").textContent =
      "Envíale estos datos (la contraseña solo se muestra ahora): " + r.email + "  /  " + r.password;
    $("portal-pass-out").className = "ok";
    toast("Contraseña generada ✓");
  });
};

$("new-client").onclick = function () { selClient(null); };

function renderProjects(c) {
  var box = $("proj-list");
  box.innerHTML = "";
  if (!(c.projects || []).length) {
    box.innerHTML = "<p class='mut'>Este cliente aún no tiene proyectos. Crea el primero abajo.</p>";
    return;
  }
  c.projects.forEach(function (p) {
    var n = (p.tenants || []).length;
    box.appendChild(treeBtn(p.name + " — " + n + (n === 1 ? " chatbot" : " chatbots"), "", false, function () { selProject(p.id); }));
  });
}

$("c-save").onclick = function () {
  var d = {
    name: $("c-name").value.trim(),
    contact_name: $("c-contact").value.trim() || null,
    email: $("c-email").value.trim() || null,
    phone: $("c-phone").value.trim() || null,
    notes: $("c-notes").value,
  };
  if (!d.name) { $("c-msg").textContent = "El nombre es obligatorio."; $("c-msg").className = "err"; return; }
  var req = sel.isNew
    ? api("/admin/api/clients", { method: "POST", body: JSON.stringify(d) })
    : api("/admin/api/clients/" + sel.id, { method: "PATCH", body: JSON.stringify(d) });
  req.then(function (r) {
    if (r.error) { $("c-msg").textContent = r.error; $("c-msg").className = "err"; toast(r.error, true); return; }
    sel = { type: "client", id: r.id, isNew: false };
    toast("Cliente guardado ✓");
    load();
  });
};

$("c-del").onclick = function () {
  if (sel.isNew) return;
  var c = findClient(sel.id);
  var bots = 0;
  (c.projects || []).forEach(function (p) { bots += (p.tenants || []).length; });
  var w = prompt(
    "Vas a eliminar el cliente «" + c.name + "» con " + (c.projects || []).length +
    " proyecto(s) y " + bots + " chatbot(s), incluidas todas sus conversaciones, leads, claves y contenido. " +
    "No se puede deshacer.\\n\\nEscribe ELIMINAR para confirmar:"
  );
  if (w !== "ELIMINAR") return;
  api("/admin/api/clients/" + sel.id, { method: "DELETE" }).then(function (r) {
    if (r.error) { $("c-msg").textContent = r.error; $("c-msg").className = "err"; toast(r.error, true); return; }
    sel = { type: null };
    toast("Cliente eliminado");
    load();
  });
};

$("proj-create").onclick = function () {
  var name = $("proj-new-name").value.trim();
  if (!name) { $("proj-msg").textContent = "Ponle nombre al proyecto."; $("proj-msg").className = "err"; return; }
  api("/admin/api/projects", { method: "POST", body: JSON.stringify({ client_id: sel.id, name: name }) })
    .then(function (r) {
      if (r.error) { $("proj-msg").textContent = r.error; $("proj-msg").className = "err"; return; }
      sel = { type: "project", id: r.id };
      load();
    });
};

// ----- proyecto -----

function selProject(id) {
  sel = { type: "project", id: id };
  renderTree();
  var f = findProject(id);
  if (!f) return;
  crumb([f.client.name, f.project.name]);
  $("p-title").textContent = f.project.name;
  $("p-name").value = f.project.name;
  $("p-desc").value = f.project.description || "";
  $("p-msg").textContent = "";
  renderBots(f.project);
  showCards(["v-project", "v-project-tools"]);
}

function renderBots(p) {
  var box = $("bot-list");
  box.innerHTML = "";
  if (!(p.tenants || []).length) {
    box.innerHTML = "<p class='mut'>Este proyecto aún no tiene chatbots.</p>";
    return;
  }
  p.tenants.forEach(function (t) {
    box.appendChild(treeBtn("💬 " + t.name + (t.active ? "" : " (apagado)"), t.active ? "" : "off", false, function () { selTenant(t.id); }));
  });
}

$("p-save").onclick = function () {
  var d = { name: $("p-name").value.trim(), description: $("p-desc").value.trim() };
  if (!d.name) { $("p-msg").textContent = "El nombre es obligatorio."; $("p-msg").className = "err"; return; }
  api("/admin/api/projects/" + sel.id, { method: "PATCH", body: JSON.stringify(d) }).then(function (r) {
    if (r.error) { $("p-msg").textContent = r.error; $("p-msg").className = "err"; toast(r.error, true); return; }
    toast("Proyecto guardado ✓");
    load();
  });
};

$("p-del").onclick = function () {
  var f = findProject(sel.id);
  var bots = f ? (f.project.tenants || []).length : 0;
  var w = prompt(
    "Vas a eliminar el proyecto «" + (f ? f.project.name : "") + "» y sus " + bots +
    " chatbot(s), con todas sus conversaciones, leads y contenido. No se puede deshacer." +
    "\\n\\nEscribe ELIMINAR para confirmar:"
  );
  if (w !== "ELIMINAR") return;
  api("/admin/api/projects/" + sel.id, { method: "DELETE" }).then(function (r) {
    if (r.error) { $("p-msg").textContent = r.error; $("p-msg").className = "err"; toast(r.error, true); return; }
    sel = f ? { type: "client", id: f.client.id } : { type: null };
    toast("Proyecto eliminado");
    load();
  });
};

$("bot-create").onclick = function () { selTenant(null, sel.id); };

// ----- chatbot -----

function curTenant() {
  if (sel.type !== "tenant" || sel.isNew) return null;
  var f = findTenant(sel.id);
  return f ? f.tenant : null;
}

function activeKey(t) {
  var ks = (t.tenant_keys || []).filter(function (k) { return !k.revoked_at; });
  return ks.length ? ks[ks.length - 1].public_key : "";
}

function lines(v) {
  return v.split("\\n").map(function (s) { return s.trim(); }).filter(Boolean);
}

function selTenant(id, projectId) {
  sel = { type: "tenant", id: id, isNew: !id, parentId: projectId || null };
  renderTree();
  var f = id ? findTenant(id) : null;
  var t = f ? f.tenant : null;
  if (f) {
    crumb([f.client.name, f.project.name, t.name]);
  } else {
    var pf = findProject(projectId);
    crumb(pf ? [pf.client.name, pf.project.name, "Nuevo chatbot"] : ["Nuevo chatbot"]);
  }
  var isNew = !t;
  $("f-title").textContent = isNew ? "Nuevo chatbot" : t.name;
  $("f-name").value = isNew ? "" : t.name;
  $("f-slug").value = isNew ? "" : t.slug;
  $("f-slug").readOnly = !isNew;
  $("f-prompt").value = isNew ? "" : t.system_prompt || "";
  $("f-welcome").value = isNew ? "¡Hola! ¿En qué puedo ayudarte?" : t.welcome_message || "";
  $("f-sugg").value = isNew ? "" : (t.suggested_questions || []).join("\\n");
  $("f-provider").value = isNew ? "google" : t.provider || "anthropic";
  $("f-model").value = isNew ? "gemini-3.5-flash" : t.model || "";
  $("f-color").value = isNew ? "#111111" : t.primary_color || "#111111";
  $("f-limit").value = isNew ? 5000 : t.monthly_message_limit;
  $("f-domains").value = isNew ? "" : (t.allowed_domains || []).join("\\n");
  $("f-email").value = isNew ? "" : t.handoff_email || "";
  $("f-webhook").value = isNew ? "" : t.lead_webhook_url || "";
  $("f-active").checked = isNew ? true : !!t.active;
  var th = (t && t.theme) || {};
  $("f-color2").value = th.secondary_color || "#f2f2f0";
  $("f-colorbg").value = th.bg_color || "#ffffff";
  $("f-font").value = th.font || "system";
  $("f-radius").value = th.radius == null ? 14 : th.radius;
  $("f-radius-v").textContent = $("f-radius").value;
  $("f-shadow").value = th.shadow || "suave";
  $("f-side").value = th.position || "derecha";
  $("f-subtitle").value = th.subtitle || "";
  $("f-logo").value = th.logo_url || "";
  $("f-teaser").checked = th.teaser !== false;
  $("f-tdelay").value = th.teaser_delay || 4;
  $("save-msg").textContent = "";
  $("a-brief").value = ""; $("a-msg").textContent = "";
  $("g-urls").value = ""; $("g-title").value = ""; $("g-content").value = "";
  $("g-report").textContent = ""; $("g-msg").textContent = "";
  $("g-files").value = ""; $("g-upmsg").textContent = "";
  resetFtabs();
  updPrev();
  if (t) { renderInteg(t); loadDocs(); loadFaq(); }
  showCards(t ? ["v-assist", "v-tenant", "integ", "ingest"] : ["v-assist", "v-tenant"]);
}

function loadFaq() {
  $("faq-msg").textContent = "";
  api("/admin/api/tenants/" + sel.id + "/faq-form").then(function (f) {
    var has = f && f.token;
    $("faq-linkrow").classList.toggle("hide", !has);
    if (!has) {
      $("faq-box").textContent = "La IA propone las preguntas típicas del negocio; le envías el enlace al cliente, las responde (puede añadir o quitar) y al enviar quedan indexadas en el bot automáticamente.";
      return;
    }
    $("faq-link").value = location.origin + "/faq?token=" + f.token;
    var when = function (iso) {
      return new Date(iso).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    };
    $("faq-box").textContent = f.status === "enviado"
      ? "✓ Enviado por el cliente el " + when(f.submitted_at) + ". Sus respuestas están indexadas (mira la lista de documentos); con el mismo enlace puede actualizarlas."
      : "Pendiente: enlace creado el " + when(f.created_at) + " — el cliente aún no lo ha enviado.";
  }).catch(function () {});
}

$("faq-gen").onclick = function () {
  var t = curTenant();
  if (!t) return;
  if (!$("faq-linkrow").classList.contains("hide") &&
      !confirm("Ya hay un formulario para este chatbot. ¿Generar uno nuevo? El enlace anterior dejará de funcionar.")) return;
  $("faq-msg").textContent = "Generando preguntas con IA… unos segundos.";
  $("faq-msg").className = "mut";
  api("/admin/api/tenants/" + sel.id + "/faq-form", { method: "POST" }).then(function (r) {
    if (r.error) { $("faq-msg").textContent = r.error; $("faq-msg").className = "err"; return; }
    $("faq-msg").textContent = "Formulario creado ✓ Copia el enlace y envíaselo al cliente.";
    $("faq-msg").className = "ok";
    toast("Formulario de FAQ creado ✓");
    loadFaq();
  }).catch(function () {
    $("faq-msg").textContent = "Error al generar."; $("faq-msg").className = "err";
  });
};

$("faq-open").onclick = function () { window.open($("faq-link").value, "_blank"); };

[].forEach.call(document.querySelectorAll(".ftabs button"), function (b) {
  b.onclick = function () {
    [].forEach.call(document.querySelectorAll(".ftabs button"), function (x) { x.classList.remove("on"); });
    [].forEach.call(document.querySelectorAll(".ft"), function (x) { x.classList.remove("on"); });
    b.classList.add("on");
    $(b.dataset.ft).classList.add("on");
  };
});

function resetFtabs() {
  [].forEach.call(document.querySelectorAll(".ftabs button"), function (x, i) {
    x.classList.toggle("on", i === 0);
  });
  [].forEach.call(document.querySelectorAll(".ft"), function (x) {
    x.classList.toggle("on", x.id === "ft-comp");
  });
}

function contrastFor(hex) {
  var m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#fff";
  var n = parseInt(m[1], 16);
  var l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.6 ? "#1a1a1a" : "#fff";
}

function fontStack(f) {
  if (f === "georgia") return 'Georgia,"Times New Roman",serif';
  if (!f || f === "system") return 'system-ui,-apple-system,"Segoe UI",sans-serif';
  return "'" + f + "',system-ui,sans-serif";
}

function loadFont(f) {
  if (["Inter", "Poppins", "Roboto", "Montserrat", "Lato"].indexOf(f) < 0) return;
  if (document.getElementById("gf-" + f)) return;
  var lk = document.createElement("link");
  lk.id = "gf-" + f;
  lk.rel = "stylesheet";
  lk.href = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(f) + ":wght@400;600&display=swap";
  document.head.appendChild(lk);
}

function updPrev() {
  var c = $("f-color").value || "#111111";
  var t = contrastFor(c);
  var c2 = $("f-color2").value || "#f2f2f0";
  var name = $("f-name").value.trim() || "Asistente";
  var rad = $("f-radius").value;
  var sh = $("f-shadow").value;
  var font = $("f-font").value;
  loadFont(font);
  $("f-radius-v").textContent = rad;
  var prev = $("prev");
  prev.style.background = $("f-colorbg").value || "#ffffff";
  prev.style.fontFamily = fontStack(font);
  prev.style.boxShadow = sh === "ninguna" ? "none" : sh === "fuerte" ? "0 18px 60px rgba(0,0,0,.35)" : "0 12px 48px rgba(0,0,0,.15)";
  $("pv-head").style.background = c;
  $("pv-head").style.color = t;
  $("pv-head").style.borderRadius = rad + "px";
  $("pv-av").textContent = name.charAt(0).toUpperCase();
  $("pv-name").textContent = name;
  $("pv-sub").textContent = $("f-subtitle").value.trim() || "Suele responder al instante";
  $("pv-bub").textContent = $("f-welcome").value.trim() || "¡Hola!";
  $("pv-bub").style.background = c2;
  $("pv-bub").style.color = contrastFor(c2);
  $("pv-bub").style.borderRadius = rad + "px";
  $("pv-mine").style.background = c;
  $("pv-mine").style.color = t;
  $("pv-mine").style.borderRadius = rad + "px";
  $("pv-btn").style.background = c;
}
["f-color", "f-color2", "f-colorbg", "f-radius", "f-subtitle", "f-name", "f-welcome"].forEach(function (id) {
  $(id).oninput = updPrev;
});
["f-font", "f-shadow"].forEach(function (id) {
  $(id).onchange = updPrev;
});

function loadDocs() {
  var box = $("doc-list");
  box.textContent = "Cargando…";
  api("/admin/api/tenants/" + sel.id + "/documents").then(function (docs) {
    if (docs.error) { box.textContent = docs.error; return; }
    box.innerHTML = "";
    if (!docs.length) { box.textContent = "Aún no hay contenido indexado. Súbelo abajo."; return; }
    docs.forEach(function (d) {
      var row = document.createElement("div");
      row.className = "doc";
      var left = document.createElement("div");
      var title = document.createElement("div");
      var icon = d.source_type === "url" ? "🌐 " : d.source_type === "file" ? "📄 " : "✍️ ";
      title.textContent = icon + (d.title || d.source_url || "(sin título)");
      var meta = document.createElement("div");
      meta.className = "meta";
      var n = d.chunks && d.chunks.length ? d.chunks[0].count : null;
      var when = d.indexed_at || d.created_at;
      meta.textContent =
        (when ? new Date(when).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "") +
        (n != null ? " · " + n + " fragmentos" : "");
      left.appendChild(title);
      left.appendChild(meta);
      var del = document.createElement("button");
      del.className = "ghost small";
      del.textContent = "Eliminar";
      del.onclick = function () {
        if (!confirm("¿Eliminar «" + (d.title || d.source_url || "este documento") + "» del conocimiento del bot?")) return;
        del.disabled = true;
        api("/admin/api/documents/" + d.id, { method: "DELETE" }).then(loadDocs);
      };
      row.appendChild(left);
      row.appendChild(del);
      box.appendChild(row);
    });
  }).catch(function () { box.textContent = "No se ha podido cargar la lista."; });
}

function renderInteg(t) {
  var key = activeKey(t);
  $("i-snippet").value =
    '<script src="' + location.origin + '/widget.js"\\n' +
    '        data-key="' + key + '"\\n' +
    '        data-api="' + location.origin + '"><\\/script>';
  $("i-panel").value = location.origin + "/panel?token=" + (t.panel_token || "");
  $("i-demo").value = location.origin + "/demo?key=" + key;
  var dom = (t.allowed_domains || [])[0];
  var hint = $("i-demo-hint");
  if (dom) {
    hint.textContent = "La demo clona https://" + dom + " — se toma del primer dominio de la pestaña «Seguridad y límites».";
    hint.className = "mut";
  } else {
    hint.textContent = "⚠ Este chatbot no tiene dominio: la demo mostrará una maqueta genérica. Escribe la web del cliente en «Seguridad y límites» → Dominios permitidos y guarda.";
    hint.className = "err";
  }
  $("integ-msg").textContent = "";
}

$("f-provider").onchange = function () {
  $("f-model").value = this.value === "google" ? "gemini-3.5-flash" : "claude-sonnet-4-6";
};

function collect() {
  var d = {
    name: $("f-name").value.trim(),
    system_prompt: $("f-prompt").value,
    welcome_message: $("f-welcome").value.trim(),
    suggested_questions: lines($("f-sugg").value),
    provider: $("f-provider").value,
    model: $("f-model").value.trim(),
    primary_color: $("f-color").value,
    allowed_domains: lines($("f-domains").value),
    handoff_email: $("f-email").value.trim() || null,
    lead_webhook_url: $("f-webhook").value.trim() || null,
    active: $("f-active").checked,
    theme: {
      secondary_color: $("f-color2").value,
      bg_color: $("f-colorbg").value,
      font: $("f-font").value,
      radius: parseInt($("f-radius").value, 10),
      shadow: $("f-shadow").value,
      position: $("f-side").value,
      subtitle: $("f-subtitle").value.trim(),
      logo_url: $("f-logo").value.trim(),
      teaser: $("f-teaser").checked,
      teaser_delay: parseInt($("f-tdelay").value, 10) || 4,
    },
  };
  var lim = parseInt($("f-limit").value, 10);
  if (!isNaN(lim)) d.monthly_message_limit = lim;
  if (sel.isNew) d.slug = $("f-slug").value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return d;
}

$("save").onclick = function () {
  var d = collect();
  if (!d.name || (sel.isNew && !d.slug)) {
    $("save-msg").textContent = "El nombre y el slug son obligatorios.";
    $("save-msg").className = "err";
    return;
  }
  if (sel.isNew) d.project_id = sel.parentId;
  $("save-msg").textContent = "Guardando…"; $("save-msg").className = "mut";
  var req = sel.isNew
    ? api("/admin/api/tenants", { method: "POST", body: JSON.stringify(d) })
    : api("/admin/api/tenants/" + sel.id, { method: "PATCH", body: JSON.stringify(d) });
  req.then(function (r) {
    if (r.error) { $("save-msg").textContent = r.error; $("save-msg").className = "err"; toast(r.error, true); return; }
    sel = { type: "tenant", id: r.id, isNew: false };
    toast("Chatbot guardado ✓");
    load();
  }).catch(function () {
    $("save-msg").textContent = "No se ha podido guardar."; $("save-msg").className = "err";
  });
};

$("f-del").onclick = function () {
  if (sel.isNew) return;
  var f = findTenant(sel.id);
  var w = prompt(
    "Vas a eliminar el chatbot «" + (f ? f.tenant.name : "") + "» y TODOS sus datos: " +
    "conversaciones, leads, claves y contenido indexado. El widget dejará de funcionar al momento. " +
    "No se puede deshacer.\\n\\nEscribe ELIMINAR para confirmar:"
  );
  if (w !== "ELIMINAR") return;
  api("/admin/api/tenants/" + sel.id, { method: "DELETE" }).then(function (r) {
    if (r.error) { $("save-msg").textContent = r.error; $("save-msg").className = "err"; toast(r.error, true); return; }
    sel = f ? { type: "project", id: f.project.id } : { type: null };
    toast("Chatbot eliminado");
    load();
  });
};

$("rot-key").onclick = function () {
  if (!confirm("La clave actual dejará de funcionar y habrá que actualizar el snippet en la web del cliente. ¿Seguir?")) return;
  api("/admin/api/tenants/" + sel.id + "/rotate-key", { method: "POST" }).then(function (r) {
    $("integ-msg").textContent = r.error || "Clave rotada. Copia el snippet nuevo.";
    load();
  });
};

$("rot-panel").onclick = function () {
  if (!confirm("El enlace actual del panel dejará de funcionar. ¿Seguir?")) return;
  api("/admin/api/tenants/" + sel.id + "/rotate-panel", { method: "POST" }).then(function (r) {
    $("integ-msg").textContent = r.error || "Enlace rotado. Reenvíaselo al cliente.";
    load();
  });
};

$("i-open").onclick = function () { window.open($("i-panel").value, "_blank"); };
$("i-demo-open").onclick = function () { window.open($("i-demo").value, "_blank"); };

document.querySelectorAll("[data-copy]").forEach(function (b) {
  b.onclick = function () {
    navigator.clipboard.writeText($(b.dataset.copy).value).then(function () {
      b.textContent = "Copiado";
      setTimeout(function () { b.textContent = "Copiar"; }, 1500);
    });
  };
});

// ----- asistente IA -----

$("a-run").onclick = function () {
  var brief = $("a-brief").value.trim();
  if (brief.length < 20) {
    $("a-msg").textContent = "Describe el negocio con algo más de detalle."; $("a-msg").className = "err";
    return;
  }
  $("a-msg").textContent = "Generando… suele tardar unos segundos."; $("a-msg").className = "mut";
  api("/admin/api/assist", { method: "POST", body: JSON.stringify({ brief: brief }) })
    .then(function (r) {
      if (r.error) { $("a-msg").textContent = r.error; $("a-msg").className = "err"; return; }
      if (r.system_prompt) $("f-prompt").value = r.system_prompt;
      if (r.welcome_message) $("f-welcome").value = r.welcome_message;
      if (r.suggested_questions) $("f-sugg").value = r.suggested_questions.join("\\n");
      $("a-msg").textContent = "Configuración generada: revísala abajo y pulsa Guardar.";
      $("a-msg").className = "ok";
    })
    .catch(function () { $("a-msg").textContent = "Error al generar."; $("a-msg").className = "err"; });
};

// ----- contenido -----

function showReport(r) {
  $("g-report").innerHTML = (r.indexed || []).map(function (x) {
    var d = document.createElement("div");
    d.textContent = (x.ok ? "✓ " : "✗ ") + x.source +
      (x.ok ? " — " + x.chunks + " fragmentos" : " — " + (x.reason || "error"));
    return d.outerHTML;
  }).join("");
}

$("g-run").onclick = function () {
  var t = curTenant();
  if (!t) return;
  var urls = lines($("g-urls").value);
  var texts = [];
  if ($("g-content").value.trim()) {
    texts.push({ title: $("g-title").value.trim() || "Texto pegado", content: $("g-content").value });
  }
  if (!urls.length && !texts.length) {
    $("g-msg").textContent = "Añade URLs o pega texto."; $("g-msg").className = "err";
    return;
  }
  $("g-msg").textContent = "Indexando… puede tardar un poco."; $("g-msg").className = "mut";
  $("g-report").textContent = "";
  api("/admin/ingest", {
    method: "POST",
    body: JSON.stringify({ slug: t.slug, urls: urls, texts: texts }),
  }).then(function (r) {
    if (r.error) { $("g-msg").textContent = r.error; $("g-msg").className = "err"; return; }
    $("g-msg").textContent = "Hecho."; $("g-msg").className = "ok";
    showReport(r);
    loadDocs();
  }).catch(function () {
    $("g-msg").textContent = "Error al indexar."; $("g-msg").className = "err";
  });
};

$("g-upload").onclick = function () {
  var t = curTenant();
  if (!t) return;
  var files = $("g-files").files;
  if (!files.length) {
    $("g-upmsg").textContent = "Elige uno o varios archivos primero."; $("g-upmsg").className = "err";
    return;
  }
  var big = [].find.call(files, function (f) { return f.size > 10 * 1024 * 1024; });
  if (big) {
    $("g-upmsg").textContent = big.name + " pesa más de 10 MB; divídelo o reduce el PDF.";
    $("g-upmsg").className = "err";
    return;
  }
  $("g-upmsg").textContent = "Subiendo e indexando… puede tardar un poco."; $("g-upmsg").className = "mut";
  Promise.all([].map.call(files, function (f) {
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onload = function () { resolve({ name: f.name, data: String(rd.result).split(",")[1] }); };
      rd.onerror = reject;
      rd.readAsDataURL(f);
    });
  })).then(function (payload) {
    return api("/admin/upload", {
      method: "POST",
      body: JSON.stringify({ slug: t.slug, files: payload }),
    });
  }).then(function (r) {
    if (r.error) { $("g-upmsg").textContent = r.error; $("g-upmsg").className = "err"; return; }
    $("g-upmsg").textContent = "Hecho."; $("g-upmsg").className = "ok";
    showReport(r);
    $("g-files").value = "";
    loadDocs();
  }).catch(function () {
    $("g-upmsg").textContent = "Error al subir."; $("g-upmsg").className = "err";
  });
};

if (TOKEN) load(); else showLogin();
</script>
</body>
</html>`;

// ---------- portal de clientes (acceso con usuario y contraseña) ----------

const PORTAL_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Portal de cliente</title>
<style>
  :root{--ink:#1a1a1a;--mut:#777;--line:#e5e5e2;--bg:#f7f7f5;--err:#b3261e;--ok:#0a7a4b}
  *{box-sizing:border-box;margin:0}
  body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
  .hide{display:none!important}
  button{font:inherit;cursor:pointer}
  input,select{font:inherit;width:100%;border:1px solid var(--line);border-radius:10px;
    padding:10px 12px;background:#fff;color:var(--ink)}
  input:focus,select:focus{outline:0;border-color:#999}
  label{display:block;font-size:13px;color:var(--mut);margin:14px 0 4px}
  .btn{background:#111;color:#fff;border:0;border-radius:10px;padding:11px 20px}
  .ghost{background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px 14px}
  .small{font-size:13px;padding:6px 12px}
  .mut{color:var(--mut);font-size:13px}
  .err{color:var(--err);font-size:13px}
  .ok{color:var(--ok);font-size:13px}
  .login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .login .card{width:390px;max-width:100%}
  .card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:26px;margin-bottom:16px}
  .card h2{font-size:16px;margin-bottom:4px}
  .card .sub{color:var(--mut);font-size:13px;margin-bottom:10px}
  header{background:#fff;border-bottom:1px solid var(--line);padding:16px 24px;display:flex;
    justify-content:space-between;align-items:center}
  header h1{font-size:17px}
  main{max-width:880px;margin:0 auto;padding:22px 16px}
  .tool{display:flex;justify-content:space-between;align-items:center;gap:10px;
    border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-top:10px}
  .tool .name{font-weight:600}
  .tool .mut{font-size:12.5px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:14px}
  th{color:var(--mut);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .paid{color:var(--ok);font-size:13px;white-space:nowrap}
  .pend{color:#a15c00;font-size:13px;white-space:nowrap}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
  @media(max-width:640px){.row2{grid-template-columns:1fr}}
  .twrap{overflow-x:auto}
  .twrap table{min-width:560px}
</style>
</head>
<body>

<div id="login" class="login hide">
  <div class="card">
    <h2>Portal de cliente</h2>
    <p class="sub">Accede con el email y la contraseña que te hemos facilitado.</p>
    <label>Email</label>
    <input id="l-email" type="email" autocomplete="username">
    <label>Contraseña</label>
    <input id="l-pass" type="password" autocomplete="current-password">
    <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
      <button id="l-go" class="btn">Entrar</button>
      <span id="l-msg" class="err"></span>
    </div>
  </div>
</div>

<div id="app" class="hide">
  <header>
    <h1 id="c-name">Portal</h1>
    <button id="logout" class="ghost small">Salir</button>
  </header>
  <main>
    <div id="projects"></div>

    <div class="card">
      <h2>Facturación</h2>
      <p class="sub">Tu histórico de facturas. Pulsa una factura para descargar el PDF.</p>
      <div class="twrap"><table>
        <thead><tr><th>Fecha</th><th>Número</th><th>Concepto</th><th>Importe</th><th>Estado</th><th></th></tr></thead>
        <tbody id="inv-body"></tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>Método de pago</h2>
      <p class="sub">Cómo prefieres pagar las cuotas. Si cambias de cuenta o de método, actualízalo aquí.</p>
      <div class="row2">
        <div>
          <label>Método</label>
          <select id="pm-type">
            <option value="transferencia">Transferencia bancaria</option>
            <option value="domiciliacion">Domiciliación (recibo)</option>
            <option value="tarjeta">Tarjeta (próximamente pago online)</option>
            <option value="otro">Otro</option>
          </select>
        </div>
        <div><label>Titular</label><input id="pm-holder"></div>
      </div>
      <label>Detalles (IBAN, referencia, observaciones…)</label>
      <input id="pm-details" placeholder="ES12 3456 …">
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
        <button id="pm-save" class="btn">Guardar</button>
        <span id="pm-msg" class="mut"></span>
      </div>
    </div>
  </main>
</div>

<script>
var TOKEN = localStorage.getItem("cb_portal") || "";

function $(id) { return document.getElementById(id); }

function showLogin(msg) {
  $("app").classList.add("hide");
  $("login").classList.remove("hide");
  $("l-msg").textContent = msg || "";
}

function euros(cents, cur) {
  return (cents / 100).toLocaleString("es-ES", { minimumFractionDigits: 2 }) + " " + (cur === "EUR" ? "€" : cur);
}

function fmtd(iso) {
  return iso ? new Date(iso + "T00:00:00").toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" }) : "";
}

$("l-go").onclick = function () {
  var email = $("l-email").value.trim(), pass = $("l-pass").value;
  if (!email || !pass) return;
  $("l-msg").textContent = "";
  fetch("/portal/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email, password: pass }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.error) { $("l-msg").textContent = d.error; return; }
    TOKEN = d.token;
    localStorage.setItem("cb_portal", TOKEN);
    load();
  }).catch(function () { $("l-msg").textContent = "No se ha podido conectar."; });
};
$("l-pass").addEventListener("keydown", function (e) { if (e.key === "Enter") $("l-go").click(); });
$("logout").onclick = function () {
  localStorage.removeItem("cb_portal");
  TOKEN = "";
  showLogin();
};

function load() {
  fetch("/portal/data", { headers: { Authorization: "Bearer " + TOKEN } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { showLogin(TOKEN ? "" : undefined); return; }
      $("login").classList.add("hide");
      $("app").classList.remove("hide");
      $("c-name").textContent = d.name;

      var box = $("projects");
      box.innerHTML = "";
      (d.projects || []).forEach(function (p) {
        var card = document.createElement("div");
        card.className = "card";
        var h = document.createElement("h2");
        h.textContent = p.name;
        var sub = document.createElement("p");
        sub.className = "sub";
        sub.textContent = p.description || "Herramientas contratadas en este proyecto";
        card.appendChild(h);
        card.appendChild(sub);
        var ts = p.tenants || [];
        if (!ts.length) {
          var e = document.createElement("p");
          e.className = "mut";
          e.textContent = "Sin herramientas activas todavía.";
          card.appendChild(e);
        }
        ts.forEach(function (t) {
          var row = document.createElement("div");
          row.className = "tool";
          var left = document.createElement("div");
          var nm = document.createElement("div");
          nm.className = "name";
          nm.textContent = "💬 " + t.name;
          var st = document.createElement("div");
          st.className = "mut";
          st.textContent = t.active ? "Chatbot · activo" : "Chatbot · apagado";
          left.appendChild(nm);
          left.appendChild(st);
          var open = document.createElement("button");
          open.className = "ghost small";
          open.textContent = "Abrir panel";
          open.onclick = function () {
            window.open("/panel?token=" + encodeURIComponent(t.panel_token), "_blank");
          };
          row.appendChild(left);
          row.appendChild(open);
          card.appendChild(row);
        });
        box.appendChild(card);
      });
      if (!(d.projects || []).length) {
        box.innerHTML = "<div class='card'><p class='mut'>Todavía no tienes proyectos activos.</p></div>";
      }

      var tb = $("inv-body");
      tb.innerHTML = "";
      var invs = d.invoices || [];
      if (!invs.length) {
        tb.innerHTML = "<tr><td colspan='6' class='mut'>Todavía no hay facturas.</td></tr>";
      }
      invs.forEach(function (v) {
        var tr = document.createElement("tr");
        function td(x) { var c = document.createElement("td"); c.textContent = x; return c; }
        tr.appendChild(td(fmtd(v.issued_at)));
        tr.appendChild(td(v.number));
        tr.appendChild(td(v.concept));
        tr.appendChild(td(euros(v.amount_cents, v.currency)));
        var st = document.createElement("td");
        var sp = document.createElement("span");
        sp.className = v.status === "pagada" ? "paid" : "pend";
        sp.textContent = v.status === "pagada" ? "✓ pagada" : "pendiente";
        st.appendChild(sp);
        tr.appendChild(st);
        var dl = document.createElement("td");
        if (v.pdf_path) {
          var b = document.createElement("button");
          b.className = "ghost small";
          b.textContent = "PDF";
          b.onclick = function () {
            window.open("/portal/invoice?id=" + v.id + "&pt=" + encodeURIComponent(TOKEN), "_blank");
          };
          dl.appendChild(b);
        }
        tr.appendChild(dl);
        tb.appendChild(tr);
      });

      var pm = d.payment_method || {};
      $("pm-type").value = pm.type || "transferencia";
      $("pm-holder").value = pm.holder || "";
      $("pm-details").value = pm.details || "";
    })
    .catch(function () { showLogin("No se ha podido conectar."); });
}

$("pm-save").onclick = function () {
  $("pm-msg").textContent = "Guardando…"; $("pm-msg").className = "mut";
  fetch("/portal/payment-method", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
    body: JSON.stringify({
      type: $("pm-type").value,
      holder: $("pm-holder").value.trim(),
      details: $("pm-details").value.trim(),
    }),
  }).then(function (r) { return r.json(); }).then(function (r) {
    if (r.error) { $("pm-msg").textContent = r.error; $("pm-msg").className = "err"; return; }
    $("pm-msg").textContent = "Guardado ✓"; $("pm-msg").className = "ok";
  }).catch(function () { $("pm-msg").textContent = "Error al guardar."; $("pm-msg").className = "err"; });
};

if (TOKEN) load(); else showLogin();
</script>
</body>
</html>`;

// ---------- formulario de preguntas frecuentes (lo rellena el cliente) ----------

const FAQ_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Preguntas frecuentes de tu asistente</title>
<style>
  :root{--ink:#1a1a1a;--mut:#777;--line:#e5e5e2;--bg:#f7f7f5;--err:#b3261e;--ok:#0a7a4b}
  *{box-sizing:border-box;margin:0}
  body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
  header{background:#fff;border-bottom:1px solid var(--line);padding:20px 24px}
  h1{font-size:19px}
  .sub{color:var(--mut);font-size:14px;margin-top:4px;max-width:640px}
  main{max-width:720px;margin:0 auto;padding:24px 16px 60px}
  .banner{background:#eef6f0;border:1px solid #cde5d4;color:#0a5c39;border-radius:12px;
    padding:12px 16px;margin-bottom:18px;font-size:14px}
  .item{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
  label{display:block;font-size:12.5px;color:var(--mut);margin-bottom:4px}
  input,textarea{font:inherit;width:100%;border:1px solid var(--line);border-radius:10px;
    padding:9px 12px;background:#fff;color:var(--ink)}
  input:focus,textarea:focus{outline:0;border-color:#999}
  textarea{resize:vertical}
  .item input{font-weight:600;border:0;padding:0 0 8px;border-radius:0;border-bottom:1px dashed transparent}
  .item input:focus{border-bottom-color:#ccc}
  .del{background:none;border:0;color:#b3261e;font-size:13px;cursor:pointer;padding:6px 0 0;opacity:.8}
  .del:hover{opacity:1}
  .btn{background:#111;color:#fff;border:0;border-radius:10px;padding:12px 22px;cursor:pointer;font:inherit;font-size:15px}
  .ghost{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 16px;cursor:pointer;font:inherit}
  .foot{display:flex;gap:12px;align-items:center;margin-top:20px;flex-wrap:wrap}
  .mut{color:var(--mut);font-size:13px}
  .err{color:var(--err);font-size:14px}
  .ok{color:var(--ok);font-size:14px}
  .done{background:#fff;border:1px solid var(--line);border-radius:16px;padding:44px 28px;text-align:center}
  .done h2{margin-bottom:8px}
</style>
</head>
<body>
<header>
  <h1 id="title">Preguntas frecuentes</h1>
  <p class="sub">Tu asistente virtual responderá a los visitantes con lo que escribas aquí.
  Contesta las preguntas que apliquen, borra las que no, y añade las que falten.
  Cuanto más concreto (precios, horarios, plazos, contacto), mejor responderá.</p>
</header>
<main>
  <div id="banner" class="banner" style="display:none"></div>
  <div id="list"></div>
  <div class="foot">
    <button id="addq" class="ghost">+ Añadir otra pregunta</button>
  </div>
  <div class="foot">
    <button id="send" class="btn">Enviar respuestas</button>
    <span id="msg" class="mut"></span>
  </div>
</main>
<script>
var token = new URLSearchParams(location.search).get("token") || "";
var items = [];

function rowFor(item) {
  var box = document.createElement("div");
  box.className = "item";
  var lq = document.createElement("label");
  lq.textContent = "Pregunta";
  var q = document.createElement("input");
  q.value = item.q || "";
  q.placeholder = "Escribe la pregunta…";
  q.oninput = function () { item.q = q.value; };
  var la = document.createElement("label");
  la.textContent = "Respuesta";
  la.style.marginTop = "6px";
  var a = document.createElement("textarea");
  a.rows = 3;
  a.value = item.a || "";
  a.placeholder = "Escribe aquí la respuesta… (si no aplica, borra la pregunta)";
  a.oninput = function () { item.a = a.value; };
  var del = document.createElement("button");
  del.className = "del";
  del.textContent = "Eliminar esta pregunta";
  del.onclick = function () {
    items.splice(items.indexOf(item), 1);
    box.remove();
  };
  box.appendChild(lq); box.appendChild(q); box.appendChild(la); box.appendChild(a); box.appendChild(del);
  return box;
}

function renderAll() {
  var list = document.getElementById("list");
  list.innerHTML = "";
  items.forEach(function (i) { list.appendChild(rowFor(i)); });
}

document.getElementById("addq").onclick = function () {
  var item = { q: "", a: "" };
  items.push(item);
  var r = rowFor(item);
  document.getElementById("list").appendChild(r);
  r.querySelector("input").focus();
  r.scrollIntoView({ block: "center" });
};

document.getElementById("send").onclick = function () {
  var ready = items.filter(function (i) { return i.q.trim() && i.a.trim(); });
  var msg = document.getElementById("msg");
  if (!ready.length) {
    msg.textContent = "Responde al menos una pregunta antes de enviar.";
    msg.className = "err";
    return;
  }
  msg.textContent = "Enviando…"; msg.className = "mut";
  document.getElementById("send").disabled = true;
  fetch("/faq/submit?token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: items }),
  }).then(function (r) { return r.json(); }).then(function (r) {
    if (r.error) {
      msg.textContent = r.error; msg.className = "err";
      document.getElementById("send").disabled = false;
      return;
    }
    document.querySelector("main").innerHTML =
      '<div class="done"><h2>¡Gracias!</h2><p>Tus respuestas ya forman parte del asistente.</p>' +
      '<p class="mut" style="margin-top:8px">Puedes volver a este enlace cuando quieras para actualizarlas.</p></div>';
  }).catch(function () {
    msg.textContent = "No se ha podido enviar. Inténtalo de nuevo."; msg.className = "err";
    document.getElementById("send").disabled = false;
  });
};

fetch("/faq/data?token=" + encodeURIComponent(token))
  .then(function (r) { return r.json(); })
  .then(function (d) {
    if (d.error) {
      document.querySelector("main").innerHTML = '<p class="err">Enlace no válido o caducado.</p>';
      return;
    }
    document.getElementById("title").textContent = "Preguntas frecuentes — " + d.name;
    items = (d.questions || []).map(function (x) { return { q: x.q || "", a: x.a || "" }; });
    if (!items.length) items = [{ q: "", a: "" }];
    if (d.status === "enviado") {
      var b = document.getElementById("banner");
      b.style.display = "block";
      b.textContent = "Ya enviaste este formulario. Puedes revisar o cambiar las respuestas y volver a enviarlo: se actualizará el asistente.";
    }
    renderAll();
  })
  .catch(function () {
    document.querySelector("main").innerHTML = '<p class="err">No se ha podido cargar el formulario.</p>';
  });
</script>
</body>
</html>`;

// ---------- panel del cliente (solo lectura) ----------

async function getTenantByPanelToken(env, token) {
  if (!token || !token.startsWith("pt_")) return null;
  const rows = await sb(env, `tenants?panel_token=eq.${encodeURIComponent(token)}&select=*`);
  const t = rows?.[0];
  return t && t.active ? t : null;
}

const PANEL_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Panel del asistente</title>
<style>
  :root{--ink:#1a1a1a;--mut:#777;--line:#e5e5e2;--bg:#f7f7f5}
  *{box-sizing:border-box;margin:0}
  body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
  header{background:#fff;border-bottom:1px solid var(--line);padding:18px 24px}
  h1{font-size:18px;font-weight:600}
  .sub{color:var(--mut);font-size:13px}
  main{max-width:960px;margin:0 auto;padding:24px 16px}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
  .stat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 18px;min-width:150px;flex:1}
  .stat b{display:block;font-size:24px}
  .stat span{color:var(--mut);font-size:13px}
  nav{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
  nav button{border:1px solid var(--line);background:#fff;border-radius:20px;padding:8px 16px;cursor:pointer;font-size:14px}
  nav button.on{background:#111;color:#fff;border-color:#111}
  section{display:none}
  section.on{display:block}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
  th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}
  th{background:#fafaf8;color:var(--mut);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  tr:last-child td{border-bottom:0}
  .mut{color:var(--mut);font-size:13px}
  .conv{background:#fff;border:1px solid var(--line);border-radius:12px;margin-bottom:12px;overflow:hidden}
  .conv>button{width:100%;text-align:left;background:none;border:0;padding:12px 16px;cursor:pointer;font:inherit;display:flex;justify-content:space-between;gap:12px}
  .conv .meta{color:var(--mut);font-size:13px;white-space:nowrap}
  .msgs{display:none;border-top:1px solid var(--line);padding:14px 16px}
  .conv.open .msgs{display:block}
  .m{width:fit-content;max-width:80%;padding:8px 12px;border-radius:12px;margin-bottom:8px;white-space:pre-wrap;font-size:14px}
  .m.user{background:#e8eefc;margin-left:auto}
  .m.assistant{background:#f2f2f0}
  .box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px}
  .btn{background:#111;color:#fff;border:0;border-radius:10px;padding:10px 16px;cursor:pointer;font:inherit}
  .btn:disabled{opacity:.5;cursor:default}
  .ok{color:#0a7a4b;font-size:13px}
  .err{color:#b3261e;font-size:13px}
  #up-files{border:1px dashed var(--line);border-radius:10px;padding:16px;width:100%;background:#fff}
  #dot{display:inline-block;width:10px;height:10px;border-radius:5px;background:#111;margin-right:8px}
  #chart{display:flex;align-items:flex-end;gap:3px;height:72px}
  #chart div{flex:1;background:#c9d4e8;border-radius:3px 3px 0 0;min-height:3px}
  .mini{background:#fff;border:1px solid var(--line);border-radius:8px;padding:5px 10px;
    font:13px system-ui,sans-serif;cursor:pointer;white-space:nowrap}
  .done{color:#0a7a4b;font-size:13px;white-space:nowrap}
  section{overflow-x:auto}
  section table{min-width:640px}
</style>
</head>
<body>
<header>
  <h1><span id="dot"></span><span id="name">Cargando…</span></h1>
  <div class="sub">Conversaciones, leads, contenido y pruebas de tu asistente</div>
</header>
<main>
  <div class="stats">
    <div class="stat"><b id="s-convs">–</b><span>conversaciones</span></div>
    <div class="stat"><b id="s-msgs">–</b><span>preguntas recibidas</span></div>
    <div class="stat"><b id="s-rate">–</b><span>respondidas con contexto</span></div>
    <div class="stat"><b id="s-leads">–</b><span>leads</span></div>
  </div>
  <div class="box" style="margin-bottom:20px">
    <div class="mut" style="margin-bottom:10px">Actividad — preguntas por día, últimos 30 días</div>
    <div id="chart"></div>
  </div>
  <nav>
    <button class="on" data-tab="t-leads">Leads</button>
    <button data-tab="t-convs">Conversaciones</button>
    <button data-tab="t-gaps">Preguntas sin respuesta</button>
    <button data-tab="t-add">Añadir contenido</button>
    <button data-tab="t-test">Probar el bot</button>
  </nav>
  <section id="t-leads" class="on">
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button id="csv" class="btn" style="padding:8px 14px;font-size:13px">Descargar CSV</button>
    </div>
    <table>
      <thead><tr><th>Fecha</th><th>Tipo</th><th>Nombre</th><th>Contacto</th><th>Qué necesita</th><th>Estado</th></tr></thead>
      <tbody id="leads-body"></tbody>
    </table>
  </section>
  <section id="t-convs"><div id="convs"></div></section>
  <section id="t-gaps">
    <p class="mut" style="margin-bottom:10px">Preguntas para las que el asistente no encontró información.
    Son la lista de tareas para ampliar el contenido.</p>
    <table>
      <thead><tr><th>Fecha</th><th>Pregunta</th></tr></thead>
      <tbody id="gaps-body"></tbody>
    </table>
  </section>
  <section id="t-add">
    <div class="box">
      <p style="margin-bottom:10px">Sube documentos con información que el asistente deba conocer:
      tarifas, horarios, catálogos, preguntas frecuentes… <span class="mut">(PDF, TXT, CSV o imágenes;
      máx. 10 MB por archivo. Subir un archivo con el mismo nombre sustituye al anterior.)</span></p>
      <input id="up-files" type="file" multiple
        accept=".pdf,.txt,.md,.csv,.html,.htm,.jpg,.jpeg,.png,.webp,.svg">
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
        <button id="up-run" class="btn">Subir e indexar</button>
        <span id="up-msg" class="mut"></span>
      </div>
      <div id="up-report" class="mut" style="margin-top:10px"></div>
    </div>
  </section>
  <section id="t-test">
    <div class="box">
      <p><b>Tu asistente está en la esquina inferior derecha</b> — el botón redondo de chat.
      Pruébalo exactamente igual que lo verán tus visitantes.</p>
      <p class="mut" style="margin-top:8px">Las conversaciones de prueba también quedan registradas en
      la pestaña Conversaciones. Si acabas de subir contenido nuevo, pregúntale sobre ello para
      comprobar que lo ha aprendido.</p>
    </div>
  </section>
</main>
<script>
var token = new URLSearchParams(location.search).get("token") || "";
var LEADS = [];

function esc(t) { var d = document.createElement("div"); d.textContent = t == null ? "" : t; return d.innerHTML; }
function fmt(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

document.querySelectorAll("nav button").forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll("nav button").forEach(function (x) { x.classList.remove("on"); });
    document.querySelectorAll("section").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on");
    document.getElementById(b.dataset.tab).classList.add("on");
  };
});

fetch("/panel/data?token=" + encodeURIComponent(token))
  .then(function (r) { return r.json(); })
  .then(function (d) {
    if (d.error) { document.getElementById("name").textContent = "Enlace no válido"; return; }
    var convs = d.conversations || [], leads = d.leads || [];
    document.getElementById("name").textContent = d.name;
    if (d.primary_color) document.getElementById("dot").style.background = d.primary_color;
    if (d.public_key) {
      var ws = document.createElement("script");
      ws.id = "cb-widget-script";
      ws.src = "/widget.js?v=" + Date.now();
      ws.setAttribute("data-key", d.public_key);
      ws.setAttribute("data-api", location.origin);
      document.body.appendChild(ws);
    }

    var act = d.activity || [];
    var mx = 1;
    act.forEach(function (a) { if (a.n > mx) mx = a.n; });
    var ch = document.getElementById("chart");
    ch.innerHTML = "";
    act.forEach(function (a) {
      var bar = document.createElement("div");
      bar.style.height = Math.max(4, Math.round((a.n / mx) * 100)) + "%";
      bar.style.background = a.n ? (d.primary_color || "#111") : "#e8e8e5";
      bar.title = a.day + ": " + a.n + (a.n === 1 ? " pregunta" : " preguntas");
      ch.appendChild(bar);
    });

    var gaps = [], userMsgs = 0, answered = 0, assistantMsgs = 0;
    convs.forEach(function (c) {
      var ms = c.messages || [];
      ms.forEach(function (m, i) {
        if (m.role === "user") userMsgs++;
        if (m.role === "assistant") {
          assistantMsgs++;
          if (m.was_answered !== false) answered++;
          else {
            var q = null;
            for (var j = i - 1; j >= 0; j--) if (ms[j].role === "user") { q = ms[j]; break; }
            gaps.push({ q: q ? q.content : "(pregunta no registrada)", at: m.created_at });
          }
        }
      });
    });

    document.getElementById("s-convs").textContent = convs.length;
    document.getElementById("s-msgs").textContent = userMsgs;
    document.getElementById("s-leads").textContent = leads.length;
    document.getElementById("s-rate").textContent =
      assistantMsgs ? Math.round((100 * answered) / assistantMsgs) + "%" : "–";

    LEADS = leads;
    document.getElementById("leads-body").innerHTML = leads.length
      ? leads.map(function (l) {
          return "<tr><td>" + fmt(l.created_at) + "</td><td>" + esc(l.kind) + "</td><td>" + esc(l.name) +
            (l.company ? "<div class='mut'>" + esc(l.company) + "</div>" : "") + "</td><td>" + esc(l.email) +
            (l.phone ? "<div class='mut'>" + esc(l.phone) + "</div>" : "") + "</td><td>" + esc(l.message) + "</td><td>" +
            (l.status === "contactado"
              ? "<span class='done'>✓ contactado</span>"
              : "<button class='mini' data-lead='" + l.id + "'>Marcar contactado</button>") +
            "</td></tr>";
        }).join("")
      : "<tr><td colspan='6' class='mut'>Todavía no hay leads. Cuando un visitante deje sus datos de contacto en el chat, aparecerán aquí y podrás descargarlos.</td></tr>";

    [].forEach.call(document.querySelectorAll("[data-lead]"), function (b) {
      b.onclick = function () {
        b.disabled = true;
        fetch("/panel/lead-status?token=" + encodeURIComponent(token), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: b.getAttribute("data-lead"), status: "contactado" }),
        }).then(function (r) { return r.json(); }).then(function (r) {
          if (r.ok) {
            var sp = document.createElement("span");
            sp.className = "done";
            sp.textContent = "✓ contactado";
            b.replaceWith(sp);
          } else { b.disabled = false; }
        }).catch(function () { b.disabled = false; });
      };
    });

    var cv = document.getElementById("convs");
    if (!convs.length) cv.innerHTML = "<p class='mut'>Todavía no hay conversaciones.</p>";
    convs.forEach(function (c) {
      var ms = c.messages || [];
      var first = "";
      for (var i = 0; i < ms.length; i++) if (ms[i].role === "user") { first = ms[i].content; break; }
      var box = document.createElement("div");
      box.className = "conv";
      box.innerHTML =
        "<button><span>" + esc(first.slice(0, 90) || "(sin mensajes)") + "</span>" +
        "<span class='meta'>" + ms.length + " mensajes · " + fmt(c.last_message_at) + "</span></button>" +
        "<div class='msgs'>" + ms.map(function (m) {
          return "<div class='m " + (m.role === "user" ? "user" : "assistant") + "'>" + esc(m.content) + "</div>";
        }).join("") + "</div>";
      box.querySelector("button").onclick = function () { box.classList.toggle("open"); };
      cv.appendChild(box);
    });

    document.getElementById("gaps-body").innerHTML = gaps.length
      ? gaps.map(function (g) {
          return "<tr><td>" + fmt(g.at) + "</td><td>" + esc(g.q) + "</td></tr>";
        }).join("")
      : "<tr><td colspan='2' class='mut'>Ninguna: el asistente ha encontrado contexto para todo lo que le han preguntado.</td></tr>";
  })
  .catch(function () {
    document.getElementById("name").textContent = "No se ha podido cargar el panel";
  });

document.getElementById("csv").onclick = function () {
  var rows = [["Fecha", "Tipo", "Nombre", "Email", "Telefono", "Empresa", "Mensaje", "Estado"]].concat(
    LEADS.map(function (l) {
      return [l.created_at, l.kind, l.name, l.email, l.phone, l.company, l.message, l.status];
    })
  );
  var csv = rows.map(function (r) {
    return r.map(function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }).join(";");
  }).join("\\n");
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = "leads.csv";
  a.click();
};

document.getElementById("up-run").onclick = function () {
  var files = document.getElementById("up-files").files;
  var msg = document.getElementById("up-msg");
  if (!files.length) { msg.textContent = "Elige uno o varios archivos primero."; msg.className = "err"; return; }
  for (var i = 0; i < files.length; i++) {
    if (files[i].size > 10 * 1024 * 1024) {
      msg.textContent = files[i].name + " pesa más de 10 MB; divídelo o reduce el PDF.";
      msg.className = "err";
      return;
    }
  }
  msg.textContent = "Subiendo e indexando… puede tardar un poco."; msg.className = "mut";
  Promise.all([].map.call(files, function (f) {
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onload = function () { resolve({ name: f.name, data: String(rd.result).split(",")[1] }); };
      rd.onerror = reject;
      rd.readAsDataURL(f);
    });
  })).then(function (payload) {
    return fetch("/panel/upload?token=" + encodeURIComponent(token), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: payload }),
    }).then(function (r) { return r.json(); });
  }).then(function (r) {
    if (r.error) { msg.textContent = r.error; msg.className = "err"; return; }
    msg.textContent = "Hecho. El asistente ya conoce este contenido: pruébalo en la pestaña «Probar el bot».";
    msg.className = "ok";
    document.getElementById("up-report").innerHTML = (r.indexed || []).map(function (x) {
      var dv = document.createElement("div");
      dv.textContent = (x.ok ? "✓ " : "✗ ") + x.source + (x.ok ? "" : " — " + (x.reason || "error"));
      return dv.outerHTML;
    }).join("");
    document.getElementById("up-files").value = "";
  }).catch(function () { msg.textContent = "Error al subir."; msg.className = "err"; });
};
</script>
</body>
</html>`;

// ---------- handler principal ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(origin, []) });
    }

    try {
      // --- widget servido por el propio Worker ---
      if (url.pathname === "/widget.js") {
        return new Response(WIDGET_JS, {
          headers: {
            "Content-Type": "application/javascript;charset=utf-8",
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // --- demo: clon estático de la web del cliente con el bot funcionando ---
      if (url.pathname === "/demo") {
        const key = url.searchParams.get("key") || "";
        const tenant = await getTenant(env, key);
        if (!tenant) return new Response("Enlace de demo no válido", { status: 401 });

        const domains = tenant.allowed_domains || [];
        let target = url.searchParams.get("url");
        const th = target ? hostOf(target) : null;
        if (!th || !domains.some((d) => th === d || th.endsWith("." + d))) target = null;
        if (!target && domains.length) target = `https://${domains[0]}`;

        let page = null;
        if (target) {
          try {
            const r = await fetch(target, {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                Accept: "text/html,application/xhtml+xml",
              },
            });
            if (r.ok && (r.headers.get("Content-Type") || "").includes("html")) page = await r.text();
          } catch (err) {
            // sin acceso a la web real: cae a la maqueta genérica de abajo
          }
        }

        const inject =
          `<div style="position:fixed;top:0;left:0;right:0;z-index:2147483001;background:#111;color:#fff;` +
          `font:600 13px/1.4 system-ui,sans-serif;padding:9px 16px;text-align:center">` +
          `DEMOSTRACIÓN · Así se verá el asistente de ${h(tenant.name)} en su web · ` +
          `El chat funciona de verdad: pruébelo · ¿Le gusta? Se activa en su web en 5 minutos</div>` +
          `<script src="${url.origin}/widget.js?v=${Date.now()}" data-key="${h(key)}" data-api="${url.origin}" data-open="2500"></script>`;

        if (page) {
          // copia estática: fuera scripts y CSP; base para que css/imágenes carguen del sitio real
          page = page
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<script[^>]*>/gi, "")
            .replace(/<meta[^>]+content-security-policy[^>]*>/gi, "")
            .replace(/<head([^>]*)>/i, `<head$1><base href="${h(target)}">`);
          page = page.includes("</body>") ? page.replace("</body>", inject + "</body>") : page + inject;
        } else {
          page = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Demo — ${h(tenant.name)}</title>
<style>body{margin:0;font:16px/1.65 system-ui,sans-serif;color:#1a1a1a}
.hero{background:${h(tenant.primary_color || "#111111")};color:#fff;padding:110px 24px 90px;text-align:center}
.hero h1{margin:0 0 10px;font-size:34px}.hero p{margin:0;opacity:.85}
.sec{max-width:820px;margin:0 auto;padding:48px 24px}
.ph{background:#f2f2f0;border-radius:12px;height:16px;margin:12px 0}
.ph.w60{width:60%}.ph.w80{width:80%}</style></head><body>
<div class="hero"><h1>${h(tenant.name)}</h1><p>Página de demostración del asistente virtual</p></div>
<div class="sec"><div class="ph w60"></div><div class="ph"></div><div class="ph w80"></div>
<div class="ph"></div><div class="ph w60"></div></div>
${inject}</body></html>`;
        }

        return new Response(page, {
          headers: {
            "Content-Type": "text/html;charset=utf-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex",
          },
        });
      }

      // --- config del widget ---
      if (url.pathname === "/api/config") {
        const tenant = await getTenant(env, url.searchParams.get("key"));
        if (!tenant) return json({ error: "clave no válida" }, 401);
        return json(
          {
            name: tenant.name,
            welcome_message: tenant.welcome_message,
            suggested_questions: tenant.suggested_questions,
            primary_color: tenant.primary_color,
            theme: tenant.theme || {},
          },
          200,
          // el host propio se permite siempre: las páginas /demo viven en él
          cors(origin, [...tenant.allowed_domains, url.hostname])
        );
      }

      // --- chat ---
      if (url.pathname === "/api/chat" && request.method === "POST") {
        const { key, session_id, message, page_url, history = [] } = await request.json();
        const tenant = await getTenant(env, key);
        if (!tenant) return json({ error: "clave no válida" }, 401);

        const ch = cors(origin, [...tenant.allowed_domains, url.hostname]);
        if (ch["Access-Control-Allow-Origin"] === "null") {
          return json({ error: "dominio no autorizado" }, 403, ch);
        }
        if (!message || message.length > 2000) {
          return json({ error: "mensaje no válido" }, 400, ch);
        }

        // límite mensual del tenant: al alcanzarlo, respuesta fija sin gastar modelo
        if (tenant.monthly_message_limit) {
          const used = await rpc(env, "monthly_messages", { p_tenant_id: tenant.id });
          if (used >= tenant.monthly_message_limit) {
            return json(
              {
                reply:
                  "Hemos alcanzado el máximo de consultas de este mes. Escríbenos directamente y te atenderemos encantados.",
                sources: [],
                limit_reached: true,
              },
              200,
              ch
            );
          }
        }

        // conversación (se crea en el primer mensaje de la sesión)
        let conv = (
          await sb(
            env,
            `conversations?tenant_id=eq.${tenant.id}&session_id=eq.${encodeURIComponent(session_id)}&select=id&limit=1`
          )
        )[0];
        if (!conv) {
          conv = (
            await sb(env, "conversations", {
              method: "POST",
              body: { tenant_id: tenant.id, session_id, page_url },
            })
          )[0];
        }

        // recuperación
        const [vec] = await embed(env, [message]);
        const hits = await rpc(env, "match_chunks", {
          p_tenant_id: tenant.id,
          p_embedding: vec,
          p_match_count: 6,
        });

        const contextBlock = (hits || [])
          .map((h, i) => `[${i + 1}] ${h.title || ""} (${h.source_url || ""})\n${h.content}`)
          .join("\n\n---\n\n");

        // si el modelo decide guardar un lead, lo persistimos y le devolvemos el resultado
        const saveLead = async (l) => {
          await sb(env, "leads", {
            method: "POST",
            body: {
              tenant_id: tenant.id,
              conversation_id: conv.id,
              kind: l.kind,
              name: l.name,
              email: l.email,
              phone: l.phone,
              company: l.company,
              message: l.message,
            },
          });

          if (tenant.lead_webhook_url) {
            await fetch(tenant.lead_webhook_url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenant: tenant.slug, ...l }),
            }).catch(() => {});
          }
        };

        // generación (proveedor y modelo configurables por tenant)
        const run = tenant.provider === "google" ? runGemini : runClaude;
        const { text, usage } = await run(
          env,
          tenant,
          history.slice(-8),
          message,
          contextBlock,
          saveLead
        );

        const sources = [
          ...new Set((hits || []).map((h) => h.source_url).filter(Boolean)),
        ].slice(0, 3);

        await sb(env, "messages", {
          method: "POST",
          body: [
            // ambas filas con las mismas claves: PostgREST lo exige en inserts múltiples
            {
              tenant_id: tenant.id,
              conversation_id: conv.id,
              role: "user",
              content: message,
              sources: [],
              input_tokens: null,
              output_tokens: null,
              was_answered: null,
            },
            {
              tenant_id: tenant.id,
              conversation_id: conv.id,
              role: "assistant",
              content: text,
              sources,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              was_answered: (hits || []).length > 0,
            },
          ],
        });

        await sb(env, `conversations?id=eq.${conv.id}`, {
          method: "PATCH",
          body: { last_message_at: new Date().toISOString() },
        });

        return json({ reply: text, sources }, 200, ch);
      }

      // --- panel de administración ---
      if (url.pathname === "/admin") {
        return new Response(ADMIN_HTML, {
          headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if (url.pathname.startsWith("/admin/api/")) {
        if (!isAdmin(request, env)) return json({ error: "no autorizado" }, 401);
        return await handleAdminApi(request, env, url);
      }

      // --- indexación (admin) ---
      if (url.pathname === "/admin/ingest" && request.method === "POST") {
        if (request.headers.get("Authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
          return json({ error: "no autorizado" }, 401);
        }
        const { slug, urls = [], texts = [] } = await request.json();
        const tenant = (await sb(env, `tenants?slug=eq.${slug}&select=id`))[0];
        if (!tenant) return json({ error: "tenant no encontrado" }, 404);

        const docs = [];
        for (const u of urls) {
          const r = await fetch(u, { headers: { "User-Agent": "ChatbotIndexer/1.0" } });
          if (!r.ok) {
            docs.push({ url: u, error: `HTTP ${r.status}` });
            continue;
          }
          const html = await r.text();
          const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || u).trim();
          docs.push({ url: u, title, content: htmlToText(html) });
        }
        for (const t of texts) {
          docs.push({ url: null, title: t.title, content: t.content });
        }

        const report = [];
        for (const d of docs) {
          if (d.error) {
            report.push({ source: d.url || d.title, ok: false, reason: d.error });
            continue;
          }
          const res = await indexDocument(env, tenant.id, {
            source_url: d.url,
            source_type: d.url ? "url" : "text",
            title: d.title,
            content: d.content,
          });
          report.push({ source: d.url || d.title, ...res });
        }

        return json({ indexed: report });
      }

      // --- subida de archivos (admin): PDF, TXT, MD, CSV, imágenes… ---
      if (url.pathname === "/admin/upload" && request.method === "POST") {
        if (!isAdmin(request, env)) return json({ error: "no autorizado" }, 401);
        const { slug, files = [] } = await request.json();
        const tenant = (await sb(env, `tenants?slug=eq.${slug}&select=id`))[0];
        if (!tenant) return json({ error: "tenant no encontrado" }, 404);

        return json({ indexed: await indexUploadedFiles(env, tenant.id, files) });
      }

      // --- subida de archivos desde el panel del cliente ---
      if (url.pathname === "/panel/upload" && request.method === "POST") {
        const tenant = await getTenantByPanelToken(env, url.searchParams.get("token"));
        if (!tenant) return json({ error: "token no válido" }, 401);
        const { files = [] } = await request.json();
        if (!files.length || files.length > 10) {
          return json({ error: "envía entre 1 y 10 archivos" }, 400);
        }
        return json({ indexed: await indexUploadedFiles(env, tenant.id, files) });
      }

      // --- portal de clientes ---
      if (url.pathname === "/acceso" || url.pathname === "/portal") {
        return new Response(PORTAL_HTML, {
          headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if (url.pathname === "/portal/login" && request.method === "POST") {
        const { email, password } = await request.json();
        if (!email || !password) return json({ error: "faltan el email o la contraseña" }, 400);
        const rows = await sb(
          env,
          `clients?email=ilike.${encodeURIComponent(email.trim())}&select=id,portal_password_hash`
        );
        const c = rows?.[0];
        if (!c || !c.portal_password_hash || !(await verifyPassword(password, c.portal_password_hash))) {
          return json({ error: "email o contraseña incorrectos" }, 401);
        }
        return json({ token: await makePortalToken(env, c.id) });
      }

      const portalAuth = async () => {
        const auth = (request.headers.get("Authorization") || "").replace(/^Bearer /, "") ||
          url.searchParams.get("pt") || "";
        return portalClientId(env, auth);
      };

      if (url.pathname === "/portal/data") {
        const cid = await portalAuth();
        if (!cid) return json({ error: "sesión caducada" }, 401);
        const [client] = await sb(
          env,
          `clients?id=eq.${cid}&select=name,email,payment_method,projects(id,name,description,tenants(name,active,panel_token))`
        );
        if (!client) return json({ error: "sesión caducada" }, 401);
        const invoices = await sb(
          env,
          `invoices?client_id=eq.${cid}&select=id,number,concept,amount_cents,currency,issued_at,status,pdf_path&order=issued_at.desc,created_at.desc`
        );
        return json({ ...client, invoices }, 200, { "Cache-Control": "no-store" });
      }

      if (url.pathname === "/portal/payment-method" && request.method === "POST") {
        const cid = await portalAuth();
        if (!cid) return json({ error: "sesión caducada" }, 401);
        const { type, holder, details } = await request.json();
        await sb(env, `clients?id=eq.${cid}`, {
          method: "PATCH",
          body: {
            payment_method: {
              type: String(type || "").slice(0, 40),
              holder: String(holder || "").slice(0, 120),
              details: String(details || "").slice(0, 200),
            },
          },
        });
        return json({ ok: true });
      }

      if (url.pathname === "/portal/invoice") {
        const cid = await portalAuth();
        if (!cid) return new Response("Sesión caducada", { status: 401 });
        const [inv] = await sb(
          env,
          `invoices?id=eq.${encodeURIComponent(url.searchParams.get("id") || "")}&client_id=eq.${cid}&select=pdf_path,number`
        );
        if (!inv?.pdf_path) return new Response("Factura no encontrada", { status: 404 });
        const pdf = await fetch(`${env.SUPABASE_URL}/storage/v1/object/facturas/${inv.pdf_path}`, {
          headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
        });
        if (!pdf.ok) return new Response("PDF no disponible", { status: 404 });
        return new Response(pdf.body, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="factura-${inv.number.replace(/[^\w.-]/g, "_")}.pdf"`,
            "Cache-Control": "no-store",
          },
        });
      }

      // --- formulario de FAQ: página, datos y envío ---
      if (url.pathname === "/faq") {
        const tk = url.searchParams.get("token") || "";
        const rows = await sb(env, `faq_forms?token=eq.${encodeURIComponent(tk)}&select=id`);
        if (!rows?.length) return new Response("Enlace no válido", { status: 401 });
        return new Response(FAQ_HTML, {
          headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if (url.pathname === "/faq/data") {
        const tk = url.searchParams.get("token") || "";
        const rows = await sb(
          env,
          `faq_forms?token=eq.${encodeURIComponent(tk)}&select=questions,status,tenants(name)`
        );
        if (!rows?.length) return json({ error: "enlace no válido" }, 401);
        return json(
          { name: rows[0].tenants?.name, questions: rows[0].questions, status: rows[0].status },
          200,
          { "Cache-Control": "no-store" }
        );
      }

      if (url.pathname === "/faq/submit" && request.method === "POST") {
        const tk = url.searchParams.get("token") || "";
        const rows = await sb(env, `faq_forms?token=eq.${encodeURIComponent(tk)}&select=id,tenant_id`);
        if (!rows?.length) return json({ error: "enlace no válido" }, 401);
        const { items = [] } = await request.json();
        const clean = items
          .map((i) => ({
            q: String(i.q || "").trim().slice(0, 300),
            a: String(i.a || "").trim().slice(0, 2000),
          }))
          .filter((i) => i.q && i.a)
          .slice(0, 60);
        if (!clean.length) return json({ error: "responde al menos una pregunta" }, 400);

        const content = clean.map((i) => `Pregunta: ${i.q}\nRespuesta: ${i.a}`).join("\n\n");
        const res = await indexDocument(env, rows[0].tenant_id, {
          source_type: "text",
          title: "Preguntas frecuentes (formulario del cliente)",
          content,
        });
        if (!res.ok) return json({ error: res.reason }, 400);

        await sb(env, `faq_forms?id=eq.${rows[0].id}`, {
          method: "PATCH",
          body: { questions: clean, status: "enviado", submitted_at: new Date().toISOString() },
        });
        return json({ ok: true, chunks: res.chunks });
      }

      // --- marcar estado de un lead desde el panel del cliente ---
      if (url.pathname === "/panel/lead-status" && request.method === "POST") {
        const tenant = await getTenantByPanelToken(env, url.searchParams.get("token"));
        if (!tenant) return json({ error: "token no válido" }, 401);
        const { id, status } = await request.json();
        if (!["nuevo", "contactado"].includes(status) || !/^[0-9a-f-]{36}$/.test(id || "")) {
          return json({ error: "datos no válidos" }, 400);
        }
        const rows = await sb(env, `leads?id=eq.${id}&tenant_id=eq.${tenant.id}`, {
          method: "PATCH",
          body: { status },
        });
        return json({ ok: !!rows?.length });
      }

      // --- panel del cliente ---
      if (url.pathname === "/panel") {
        const tenant = await getTenantByPanelToken(env, url.searchParams.get("token"));
        if (!tenant) return new Response("Enlace no válido", { status: 401 });
        return new Response(PANEL_HTML, {
          headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if (url.pathname === "/panel/data") {
        const tenant = await getTenantByPanelToken(env, url.searchParams.get("token"));
        if (!tenant) return json({ error: "token no válido" }, 401);
        const [conversations, leads, keys, activity] = await Promise.all([
          sb(
            env,
            `conversations?tenant_id=eq.${tenant.id}` +
              `&select=id,page_url,created_at,last_message_at,messages(role,content,was_answered,created_at)` +
              `&order=last_message_at.desc&messages.order=created_at.asc&limit=100`
          ),
          sb(
            env,
            `leads?tenant_id=eq.${tenant.id}` +
              `&select=id,kind,name,email,phone,company,message,status,created_at` +
              `&order=created_at.desc&limit=200`
          ),
          sb(env, `tenant_keys?tenant_id=eq.${tenant.id}&revoked_at=is.null&select=public_key`),
          rpc(env, "daily_activity", { p_tenant_id: tenant.id, p_days: 30 }),
        ]);
        return json(
          {
            name: tenant.name,
            primary_color: tenant.primary_color,
            public_key: keys?.[keys.length - 1]?.public_key || null,
            conversations,
            leads,
            activity,
          },
          200,
          { "Cache-Control": "no-store" }
        );
      }

      return json({ error: "no encontrado" }, 404);
    } catch (err) {
      console.error(err);
      // el detalle no incluye secretos: son mensajes de estado de Supabase/proveedor
      return json(
        { error: "error interno", detail: String(err?.message || err).slice(0, 300) },
        500,
        cors(origin, [])
      );
    }
  },
};
