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

// señales visuales de la web del cliente para el asistente de diseño
async function siteSignals(domain) {
  try {
    const r = await fetch(`https://${domain}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 400000);
    return {
      title: (html.match(/<title[^>]*>([^<]*)</i)?.[1] || "").trim().slice(0, 120),
      description: (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || "")
        .trim().slice(0, 200),
      colors: [...new Set(html.match(/#[0-9a-fA-F]{6}\b/g) || [])].slice(0, 40),
      fonts: [...new Set((html.match(/font-family:\s*([^;}"']{2,60})/gi) || []).map((f) => f.slice(12).trim()))]
        .slice(0, 10),
    };
  } catch {
    return null;
  }
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

// el Storage de Supabase rechaza las claves nuevas (sb_secret_…) en Authorization;
// van en apikey. Las claves JWT antiguas necesitan ambas cabeceras.
function storageHeaders(env) {
  const k = env.SUPABASE_SERVICE_KEY;
  return k.startsWith("sb_") ? { apikey: k } : { apikey: k, Authorization: `Bearer ${k}` };
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
      tools: leadCaptureEnabled(tenant) ? [LEAD_TOOL] : [],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return res.json();
}

function leadCaptureEnabled(tenant) {
  return !(tenant.features && tenant.features.leads === false);
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
        tools: leadCaptureEnabled(tenant)
          ? [
              {
                functionDeclarations: [
                  {
                    name: LEAD_TOOL.name,
                    description: LEAD_TOOL.description,
                    parameters: LEAD_TOOL.input_schema,
                  },
                ],
              },
            ]
          : [],
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

// ---------- email (Resend), errores y utilidades de IA ----------

async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, reason: "Falta el secreto RESEND_API_KEY (cuenta gratis en resend.com)" };
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "ExpoBot <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
    }),
  });
  if (!r.ok) return { ok: false, reason: `Resend ${r.status}: ${(await r.text()).slice(0, 200)}` };
  return { ok: true };
}

async function logError(env, route, message) {
  try {
    await sb(env, "error_log", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: { route: String(route).slice(0, 120), message: String(message).slice(0, 500) },
    });
    if (env.RESEND_API_KEY && env.ADMIN_ALERT_EMAIL) {
      const since = new Date(Date.now() - 3600000).toISOString();
      const recent = await sb(env, `error_log?route=eq.__alert&created_at=gte.${since}&select=id&limit=1`);
      if (!recent?.length) {
        await sb(env, "error_log", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: { route: "__alert", message: "aviso enviado" },
        });
        await sendEmail(
          env,
          env.ADMIN_ALERT_EMAIL,
          "⚠ ExpoBot: error en el motor",
          emailShell(
            `<h2 style="margin:0 0 10px;font-size:18px;color:#b3261e">&#9888; Error en el motor</h2>` +
              `<p style="margin:0 0 8px"><b>Ruta:</b> ${h(route)}</p>` +
              `<p style="margin:0 0 14px;background-color:#fdf2f1;border-radius:10px;padding:10px 14px;font-family:ui-monospace,monospace;font-size:13px">${h(String(message).slice(0, 400))}</p>` +
              `<p style="margin:0;color:#6b7590;font-size:13px">Detalles en tu panel &rarr; Inicio &rarr; Salud del motor. M&aacute;ximo un aviso por hora.</p>`
          )
        );
      }
    }
  } catch (e) {
    // el registro de errores nunca debe tumbar la petición
  }
}

// llamada a Gemini que devuelve JSON parseado (o null)
async function geminiJson(env, prompt, maxTokens = 2000) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: "low" },
        },
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
    return JSON.parse(text);
  } catch {
    // tolerancia: JSON envuelto en texto o vallas de código
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(text.slice(a, b + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// una pregunta por el motor real (recuperación + generación), sin persistir nada
async function answerOnce(env, tenant, question) {
  const [vec] = await embed(env, [question]);
  const hits = await rpc(env, "match_chunks", {
    p_tenant_id: tenant.id,
    p_embedding: vec,
    p_match_count: 6,
  });
  const contextBlock = (hits || [])
    .map((x, i) => `[${i + 1}] ${x.title || ""}\n${x.content}`)
    .join("\n\n---\n\n");
  const run = tenant.provider === "google" ? runGemini : runClaude;
  const { text } = await run(env, tenant, [], question, contextBlock, async () => {});
  return { text, hadContext: (hits || []).length > 0 };
}

// ---------- plantilla de email con la marca ----------
// Sin SVG ni CSS externo: Gmail y Outlook los eliminan. Todo inline y en tablas.

function emailShell(inner) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background-color:#f5f7fc">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f7fc">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:16px;border:1px solid #e4e7f0">
  <tr><td style="background-color:#3c62f0;background-image:linear-gradient(135deg,#3c62f0,#6b8cff);padding:18px 28px;border-radius:16px 16px 0 0">
    <span style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:21px;font-weight:800;letter-spacing:-0.02em;color:#ffffff">Expo<span style="color:#c9d8ff">Bot</span></span>
    <span style="font-family:system-ui,sans-serif;font-size:12px;color:#dbe4ff;margin-left:10px">estudio de asistentes IA</span>
  </td></tr>
  <tr><td style="padding:26px 28px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#10182b;font-size:15px;line-height:1.55">
${inner}
  </td></tr>
  <tr><td style="padding:14px 28px;border-top:1px solid #e4e7f0;font-family:system-ui,sans-serif;font-size:12.5px;color:#6b7590;border-radius:0 0 16px 16px">
    Impulsado por <b style="color:#3c62f0">ExpoBot</b> &middot; <a href="https://expobot.es" style="color:#6b7590">expobot.es</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function emailStat(n, label) {
  return `<td width="50%" style="padding:5px"><div style="background-color:#f0f4ff;border-radius:12px;padding:13px 16px">
    <div style="font-family:system-ui,sans-serif;font-size:26px;font-weight:800;color:#3c62f0">${n}</div>
    <div style="font-family:system-ui,sans-serif;font-size:12.5px;color:#6b7590">${label}</div>
  </div></td>`;
}

// ---------- informe mensual ----------

async function sendMonthlyReport(env, tenantId, toOverride) {
  const [t] = await sb(
    env,
    `tenants?id=eq.${tenantId}&select=*,projects(name,clients(name,email))`
  );
  if (!t) return { ok: false, reason: "tenant no encontrado" };
  const to = toOverride || t.projects?.clients?.email || t.handoff_email;
  if (!to) return { ok: false, reason: "el cliente no tiene email (ficha del cliente) ni handoff_email" };

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const range = `created_at=gte.${start.toISOString()}&created_at=lt.${end.toISOString()}`;
  const [convs, users, unans, leads, gaps] = await Promise.all([
    sb(env, `conversations?tenant_id=eq.${t.id}&${range}&select=id&limit=1000`),
    sb(env, `messages?tenant_id=eq.${t.id}&role=eq.user&${range}&select=id&limit=1000`),
    sb(env, `messages?tenant_id=eq.${t.id}&role=eq.assistant&was_answered=eq.false&${range}&select=id&limit=1000`),
    sb(env, `leads?tenant_id=eq.${t.id}&${range}&select=id&limit=1000`),
    rpc(env, "unanswered_questions", { p_tenant_id: t.id, p_days: 45 }),
  ]);
  const monthName = start.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
  const q = users?.length || 0;
  const rate = q ? Math.max(0, Math.round((100 * (q - (unans?.length || 0))) / q)) : 0;

  const html = emailShell(`
  <h2 style="margin:0 0 6px;font-size:19px;color:#10182b">Informe de tu asistente &mdash; ${h(monthName)}</h2>
  <p style="margin:0 0 16px">Hola${t.projects?.clients?.name ? " " + h(t.projects.clients.name) : ""}, este es el resumen de la actividad de <b>${h(t.name)}</b>:</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -5px 14px">
    <tr>${emailStat(convs?.length || 0, "conversaciones atendidas")}${emailStat(q, "preguntas respondidas")}</tr>
    <tr>${emailStat(rate + "%", "con información de tu contenido")}${emailStat(leads?.length || 0, "contactos captados (leads)")}</tr>
  </table>
  ${
    gaps?.length
      ? `<p style="margin:14px 0 8px"><b>Lo que más preguntan y aún no está en el contenido:</b></p>
         <div style="border-left:3px solid #3c62f0;background-color:#f7f9ff;border-radius:0 10px 10px 0;padding:10px 16px;margin-bottom:12px">${gaps
           .slice(0, 5)
           .map((g) => `<p style="margin:6px 0">&bull; ${h(g.q)}</p>`)
           .join("")}</div>
         <p style="margin:0">Si nos das esas respuestas, el asistente las incorporará.</p>`
      : `<p style="margin:14px 0 0">El asistente encontró respuesta para todo lo que le preguntaron. &#127881;</p>`
  }`);
  const sent = await sendEmail(env, to, `Informe mensual de tu asistente — ${monthName}`, html);
  return sent.ok ? { ok: true, sent_to: to } : { ok: false, reason: sent.reason };
}

async function runMonthlyReports(env) {
  const tenants = await sb(env, "tenants?active=is.true&select=id,slug");
  for (const t of tenants || []) {
    try {
      const r = await sendMonthlyReport(env, t.id);
      if (!r.ok) await logError(env, "informe-mensual/" + t.slug, r.reason);
    } catch (err) {
      await logError(env, "informe-mensual/" + t.slug, err?.message || err);
    }
  }
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
  "panel_enabled", "panel_features", "features",
];
const CLIENT_FIELDS = ["name", "contact_name", "email", "phone", "notes", "portal_enabled"];
const PROJECT_FIELDS = ["client_id", "name", "description"];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// firmas de plataformas web y guías de integración del snippet
function detectPlatform(html) {
  const x = html.toLowerCase();
  if (x.includes("wp-content") || x.includes("wp-includes")) return "wordpress";
  if (x.includes("cdn.shopify.com") || x.includes("shopify")) return "shopify";
  if (x.includes("wixstatic.com") || x.includes("wix.com")) return "wix";
  if (x.includes("squarespace")) return "squarespace";
  if (x.includes("webflow")) return "webflow";
  if (x.includes("prestashop")) return "prestashop";
  if (x.includes("joomla")) return "joomla";
  if (x.includes("drupal")) return "drupal";
  if (x.includes("_next/") || x.includes("__next")) return "nextjs";
  if (x.includes("_nuxt")) return "nuxt";
  if (x.includes("___gatsby")) return "gatsby";
  return "html";
}

const GUIDES = {
  wordpress: {
    name: "WordPress",
    steps: [
      "Entra en el escritorio de WordPress del cliente (su-web.com/wp-admin).",
      "Instala y activa el plugin gratuito «WPCode» (o «Insert Headers and Footers»).",
      "Ve a Code Snippets → Header & Footer y pega el código en la caja «Footer».",
      "Guarda y recarga la web: el botón del chat aparecerá abajo.",
    ],
    note: "Alternativa sin plugins: pegar el código en el footer.php del tema hijo, justo antes de </body>.",
  },
  shopify: {
    name: "Shopify",
    steps: [
      "Admin de Shopify → Tienda online → Temas.",
      "En el tema activo: ⋯ → Editar código.",
      "Abre el archivo layout/theme.liquid.",
      "Pega el código justo antes de la etiqueta </body> y guarda.",
    ],
    note: "",
  },
  wix: {
    name: "Wix",
    steps: [
      "Panel de Wix → Ajustes → sección Avanzado → «Código personalizado».",
      "Pulsa «+ Añadir código personalizado» y pega el código.",
      "Aplícalo a «Todas las páginas» y colócalo en «Fin de página (body)».",
      "Guarda y publica el sitio.",
    ],
    note: "Wix solo permite código personalizado en sus planes de pago con dominio propio.",
  },
  squarespace: {
    name: "Squarespace",
    steps: [
      "Panel → Ajustes → Avanzado → «Inyección de código».",
      "Pega el código en la caja «Pie de página» (Footer).",
      "Guarda.",
    ],
    note: "Requiere el plan Business de Squarespace o superior.",
  },
  webflow: {
    name: "Webflow",
    steps: [
      "Project Settings → pestaña «Custom Code».",
      "Pega el código en «Footer Code».",
      "Guarda y vuelve a publicar el sitio.",
    ],
    note: "",
  },
  prestashop: {
    name: "PrestaShop",
    steps: [
      "Pega el código en el archivo footer.tpl del tema activo, antes de </body>.",
      "Limpia la caché: Parámetros avanzados → Rendimiento → Vaciar caché.",
    ],
    note: "Si no tocan código, cualquier módulo de «HTML personalizado en footer» sirve.",
  },
  joomla: {
    name: "Joomla",
    steps: [
      "Extensiones → Plantillas → edita la plantilla activa.",
      "Pega el código en index.php antes de </body> (o usa un módulo «Custom HTML» en la posición del pie).",
    ],
    note: "",
  },
  drupal: {
    name: "Drupal",
    steps: [
      "Pega el código en la plantilla html.html.twig del tema antes de </body>, o usa un bloque de HTML completo en la región del pie.",
      "Vacía la caché de Drupal.",
    ],
    note: "",
  },
  nextjs: {
    name: "Next.js (React) — web a medida",
    steps: [
      "Pásale el código al desarrollador de la web.",
      "En app/layout.tsx (o pages/_document.js) debe añadirlo con el componente <Script> de next/script con strategy=\"afterInteractive\", o pegarlo tal cual antes de </body>.",
      "Desplegar la web.",
    ],
    note: "",
  },
  nuxt: {
    name: "Nuxt (Vue) — web a medida",
    steps: [
      "Pásale el código al desarrollador de la web.",
      "En nuxt.config, añadir el script en app.head.script (con defer), o pegarlo en la plantilla raíz antes de </body>.",
      "Desplegar la web.",
    ],
    note: "",
  },
  gatsby: {
    name: "Gatsby (React) — web a medida",
    steps: [
      "Pásale el código al desarrollador de la web.",
      "Añadirlo en gatsby-ssr.js (setPostBodyComponents) o en el componente de layout, antes de </body>.",
      "Desplegar la web.",
    ],
    note: "",
  },
  html: {
    name: "Web a medida (HTML/JavaScript)",
    steps: [
      "Quien mantenga la web debe pegar el código justo antes de la etiqueta </body>, en la plantilla común o en cada página donde deba verse el chat.",
      "Subir el cambio. No hay paso 3.",
    ],
    note: "",
  },
  desconocida: {
    name: "No se ha podido leer la web",
    steps: [
      "No pasa nada: el código funciona en cualquier web.",
      "Quien la mantenga debe pegarlo justo antes de la etiqueta </body> (o en la sección de «código personalizado del pie» si es un gestor tipo WordPress/Wix).",
    ],
    note: "La web bloquea la lectura automática (protección anti-robots), pero eso no afecta a la integración.",
  },
};

// guía de integración para un tenant resuelto por su clave pública;
// pKey (opcional) fija la plataforma sin re-analizar la web
async function guideFor(env, publicKey, pKey) {
  const tenant = await getTenant(env, publicKey);
  if (!tenant) return null;
  const domain = (tenant.allowed_domains || [])[0] || null;
  let key = pKey && GUIDES[pKey] ? pKey : null;
  if (!key) {
    let html = null;
    if (domain) {
      try {
        const r = await fetch(`https://${domain}`, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            Accept: "text/html",
          },
        });
        if (r.ok) html = (await r.text()).slice(0, 500000);
      } catch (err) {
        // sin acceso: guía genérica
      }
    }
    key = html ? detectPlatform(html) : "desconocida";
  }
  return { tenant, domain, key, guide: GUIDES[key] || GUIDES.html };
}

// ---------- generador de PDF (una tipografía estándar, sin dependencias) ----------

function pdfLatin1(s) {
  return String(s)
    .replace(/[—–]/g, "-").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...")
    .replace(/[^\x00-\xff]/g, "?");
}

function pdfEscape(s) {
  return pdfLatin1(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLine(t, max) {
  const words = String(t).split(/\s+/);
  const out = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) {
      if (cur) out.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

// lines: [{t, size, font: 1|2|3 (normal|negrita|mono), gap}]
function buildPdf(lines) {
  const H = 842, M = 56;
  const pages = [];
  let cur = [];
  let y = H - M;
  for (const ln of lines) {
    const lh = Math.round((ln.size || 11) * 1.5);
    if (y - lh < M) {
      pages.push(cur);
      cur = [];
      y = H - M;
    }
    y -= lh;
    cur.push({ ...ln, y });
    if (ln.gap) y -= ln.gap;
  }
  if (cur.length) pages.push(cur);

  const objs = {};
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pages.map((_, i) => `${7 + i * 2} 0 R`).join(" ");
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>";
  objs[6] = "<< /F1 3 0 R /F2 4 0 R /F3 5 0 R >>";

  pages.forEach((pg, i) => {
    const content = pg
      .map((ln) => `/F${ln.font || 1} ${ln.size || 11} Tf 1 0 0 1 ${ln.x || M} ${ln.y} Tm (${pdfEscape(ln.t)}) Tj`)
      .join("\n");
    const stream = `BT\n${content}\nET`;
    objs[7 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font 6 0 R >> ` +
      `/Contents ${8 + i * 2} 0 R >>`;
    objs[8 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  const count = 6 + pages.length * 2;
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i <= count; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= count; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Uint8Array.from(pdfLatin1(out), (c) => c.charCodeAt(0));
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

  // --- duplicar un chatbot (misma config, slug y claves nuevos) ---
  const mDup = url.pathname.match(/^\/admin\/api\/tenants\/([0-9a-f-]{36})\/duplicate$/);
  if (mDup && request.method === "POST") {
    const [t] = await sb(env, `tenants?id=eq.${mDup[1]}&select=*`);
    if (!t) return json({ error: "tenant no encontrado" }, 404);
    const suffix = randomHex(2);
    const copy = pick(t, TENANT_FIELDS);
    copy.slug = `${t.slug}-copia-${suffix}`.slice(0, 60);
    copy.name = `${t.name} (copia)`;
    copy.active = false;
    const [nt] = await sb(env, "tenants", { method: "POST", body: copy });
    const key = `pk_${nt.slug}_${randomHex(12)}`;
    await sb(env, "tenant_keys", { method: "POST", body: { tenant_id: nt.id, public_key: key } });
    return json({ id: nt.id });
  }

  // --- leads de todos los clientes (vista global) ---
  if (url.pathname === "/admin/api/leads" && request.method === "GET") {
    const rows = await sb(
      env,
      `leads?select=id,kind,name,email,phone,company,message,status,created_at,tenants(name,project_id)` +
        `&order=created_at.desc&limit=500`
    );
    return json(rows);
  }
  const mLead = url.pathname.match(/^\/admin\/api\/leads\/([0-9a-f-]{36})$/);
  if (mLead && request.method === "PATCH") {
    const { status } = await request.json();
    if (!["nuevo", "contactado"].includes(status)) return json({ error: "estado no válido" }, 400);
    const rows = await sb(env, `leads?id=eq.${mLead[1]}`, { method: "PATCH", body: { status } });
    if (!rows?.length) return json({ error: "lead no encontrado" }, 404);
    return json({ ok: true });
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
    const { brief } = await request.json().catch(() => ({}));

    const instructions = `Eres consultor de contenido para chatbots de atención al público. Genera las preguntas frecuentes que el dueño de este negocio debería responder para alimentar a su chatbot. Devuelve SOLO un objeto JSON: {"questions":["...","..."]}

Entre 10 y 14 preguntas (salvo que las indicaciones digan otra cantidad), en español, concretas y de respuesta factual (precios, horarios, condiciones, proceso de compra o reserva, ubicación, contacto, plazos, garantías, métodos de pago...). Formúlalas como las haría un visitante real de la web. Evita preguntas genéricas o de respuesta obvia.

Negocio: ${t.name}
Instrucciones del bot (contexto): ${(t.system_prompt || "").slice(0, 2000)}${
      brief && brief.trim()
        ? `\n\nINDICACIONES DEL DUEÑO DE LA PLATAFORMA (tienen prioridad sobre todo lo anterior):\n${brief.trim().slice(0, 1500)}`
        : ""
    }`;

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

  // --- guía de integración: detecta la plataforma de la web del cliente ---
  const mGuide = url.pathname.match(/^\/admin\/api\/tenants\/([0-9a-f-]{36})\/integration-guide$/);
  if (mGuide && request.method === "GET") {
    const [t] = await sb(env, `tenants?id=eq.${mGuide[1]}&select=allowed_domains`);
    if (!t) return json({ error: "tenant no encontrado" }, 404);
    const domain = (t.allowed_domains || [])[0];
    if (!domain) {
      return json({ error: "este chatbot no tiene dominio: añádelo en «Seguridad y límites» y guarda" }, 400);
    }
    let html = null;
    try {
      const r = await fetch(`https://${domain}`, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Accept: "text/html",
        },
      });
      if (r.ok) html = (await r.text()).slice(0, 500000);
    } catch (err) {
      // sin acceso: cae a la guía genérica
    }
    const key = html ? detectPlatform(html) : "desconocida";
    const g = GUIDES[key] || GUIDES.html;
    return json({ key, platform: g.name, steps: g.steps, note: g.note || "", domain });
  }

  // --- salud del motor: últimos errores ---
  if (url.pathname === "/admin/api/errors" && request.method === "GET") {
    return json(
      await sb(env, "error_log?route=neq.__alert&order=created_at.desc&limit=20")
    );
  }

  // --- informe mensual bajo demanda ---
  const mRep = url.pathname.match(/^\/admin\/api\/tenants\/([0-9a-f-]{36})\/send-report$/);
  if (mRep && request.method === "POST") {
    const { to } = await request.json().catch(() => ({}));
    return json(await sendMonthlyReport(env, mRep[1], to || null));
  }

  // --- examen del bot: preguntas trampa + juez ---
  const mExam = url.pathname.match(/^\/admin\/api\/tenants\/([0-9a-f-]{36})\/exam$/);
  if (mExam && request.method === "POST") {
    if (!env.GEMINI_API_KEY) return json({ error: "Falta el secreto GEMINI_API_KEY" }, 500);
    const [t] = await sb(env, `tenants?id=eq.${mExam[1]}&select=*`);
    if (!t) return json({ error: "tenant no encontrado" }, 404);

    const trapPrompt = `Genera 6 preguntas trampa para auditar un chatbot de atención al público. Devuelve SOLO JSON: {"questions":["...","..."]}
Deben ser preguntas cuya respuesta sea un dato concreto fácil de inventar (precios, fechas, horarios, plazos, condiciones, descuentos, aforo...) formuladas como un visitante real. Mezcla probables y rebuscadas.
Negocio: ${t.name}
Contexto: ${(t.system_prompt || "").slice(0, 1200)}`;
    let gen = await geminiJson(env, trapPrompt, 4000);
    if (!gen?.questions?.length) gen = await geminiJson(env, trapPrompt, 4000);
    const qs = (gen?.questions || []).slice(0, 6);
    if (!qs.length) return json({ error: "no se pudieron generar preguntas; reintenta" }, 502);

    const items = [];
    for (const q of qs) {
      const a = await answerOnce(env, t, String(q));
      items.push({ q: String(q), a: a.text, hadContext: a.hadContext });
    }

    const judged = await geminiJson(
      env,
      `Eres auditor de chatbots. Regla de oro del bot auditado: NUNCA inventar datos (precios, fechas, condiciones); si el dato no está en su contenido debe decirlo y derivar al contacto. Evalúa cada respuesta. Devuelve SOLO JSON:
{"items":[{"ok":true,"why":"..."}], "score": 0-10, "summary":"..."}
"ok" es true si la respuesta cumple la regla (da el dato solo si parece provenir de contenido real, o reconoce que no lo tiene y deriva). "why" en una frase. Mismo orden que las preguntas.

${items.map((x, i) => `PREGUNTA ${i + 1}: ${x.q}\nRESPUESTA ${i + 1}: ${x.a}`).join("\n\n")}`,
      3000
    );
    const out = items.map((x, i) => ({
      q: x.q,
      a: x.a,
      ok: judged?.items?.[i]?.ok !== false,
      why: judged?.items?.[i]?.why || "",
    }));
    return json({
      score: judged?.score ?? null,
      summary: judged?.summary || "",
      items: out,
    });
  }

  // --- auto-mejora: huecos de conocimiento con borradores de la IA ---
  const mGap = url.pathname.match(/^\/admin\/api\/tenants\/([0-9a-f-]{36})\/gap-suggest$/);
  if (mGap && request.method === "POST") {
    if (!env.GEMINI_API_KEY) return json({ error: "Falta el secreto GEMINI_API_KEY" }, 500);
    const [t] = await sb(env, `tenants?id=eq.${mGap[1]}&select=id,name,system_prompt`);
    if (!t) return json({ error: "tenant no encontrado" }, 404);
    const gaps = await rpc(env, "unanswered_questions", { p_tenant_id: t.id, p_days: 60 });
    if (!gaps?.length) return json({ suggestions: [] });

    const parsed = await geminiJson(
      env,
      `Eres editor de contenido para el chatbot de este negocio. Estas preguntas de visitantes reales quedaron SIN respuesta porque el contenido del bot no las cubre. Redacta un borrador de respuesta por pregunta, listo para que el dueño lo complete. Devuelve SOLO JSON:
{"suggestions":[{"q":"pregunta tal cual","draft":"borrador"}]}

Reglas del borrador: 2-4 frases, tono del negocio, y TODO dato concreto que no puedas saber va como hueco entre corchetes: [PRECIO], [FECHA], [HORARIO], [TELÉFONO]... No inventes datos jamás.

Negocio: ${t.name}
Contexto: ${(t.system_prompt || "").slice(0, 1200)}
Preguntas (con nº de veces): ${gaps.map((g) => `"${g.q}" (${g.n})`).join(" · ").slice(0, 3000)}`,
      4000
    );
    return json({ suggestions: (parsed?.suggestions || []).slice(0, 15) });
  }

  // --- asistente de diseño: 3 propuestas visuales a partir de la web del cliente ---
  const mDesign = url.pathname.match(/^\/admin\/api\/tenants\/([0-9a-f-]{36})\/design-assist$/);
  if (mDesign && request.method === "POST") {
    if (!env.GEMINI_API_KEY) return json({ error: "Falta el secreto GEMINI_API_KEY" }, 500);
    const [t] = await sb(env, `tenants?id=eq.${mDesign[1]}&select=name,allowed_domains`);
    if (!t) return json({ error: "tenant no encontrado" }, 404);
    const { brief } = await request.json().catch(() => ({}));
    const domain = (t.allowed_domains || [])[0];
    const signals = domain ? await siteSignals(domain) : null;

    const instructions = `Eres director de arte digital especializado en widgets de chat embebidos en webs. Diseña 3 propuestas visuales COMPLETAS y claramente DISTINTAS entre sí para el widget de chat de este negocio. Devuelve SOLO un objeto JSON:
{"options":[{"name":"...","why":"...","primary_color":"#RRGGBB","theme":{"secondary_color":"#RRGGBB","bg_color":"#RRGGBB","font":"...","radius":N,"shadow":"suave","subtitle":"...","bg_image":"","dark":"off"}}]}

Reglas:
- Enfoque de las 3 (adáptalo si hay indicaciones): 1) fiel a la identidad visual de la web del cliente; 2) moderna y llamativa; 3) elegante y sobria.
- font: solo system, Inter, Poppins, Roboto, Montserrat, Lato o georgia.
- radius: número par entre 0 y 24. shadow: suave, ninguna o fuerte. dark: off o auto.
- primary_color va en cabecera, botón y mensajes del usuario (el color del texto se ajusta solo). secondary_color es el fondo de las burbujas del bot: coherente con bg_color y con contraste legible.
- bg_image: cadena vacía o un degradado CSS sutil (linear-gradient) coherente con la paleta. NUNCA una URL.
- subtitle: subtítulo corto de cabecera con la voz de la marca.
- name: nombre corto y vendedor de la propuesta. why: una frase de por qué encaja.

Negocio: ${t.name}
Señales visuales encontradas en la web del cliente: ${signals ? JSON.stringify(signals) : "no disponibles"}
Indicaciones del diseñador: ${brief && brief.trim() ? brief.trim().slice(0, 1000) : "ninguna"}`;

    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: instructions }] }],
          generationConfig: {
            maxOutputTokens: 8000,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: "low" },
          },
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
      return json(
        {
          error: "la IA no devolvió diseños válidos; vuelve a intentarlo",
          detail: out.candidates?.[0]?.finishReason || "sin respuesta",
        },
        502
      );
    }
    const FONTS = ["system", "Inter", "Poppins", "Roboto", "Montserrat", "Lato", "georgia"];
    const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v || "") ? v : d);
    const options = (parsed.options || []).slice(0, 3).map((o) => ({
      name: String(o.name || "Propuesta").slice(0, 60),
      why: String(o.why || "").slice(0, 200),
      primary_color: hex(o.primary_color, "#111111"),
      theme: {
        secondary_color: hex(o.theme?.secondary_color, "#f2f2f0"),
        bg_color: hex(o.theme?.bg_color, "#ffffff"),
        font: FONTS.includes(o.theme?.font) ? o.theme.font : "system",
        radius: Math.max(0, Math.min(24, parseInt(o.theme?.radius, 10) || 14)),
        shadow: ["suave", "ninguna", "fuerte"].includes(o.theme?.shadow) ? o.theme.shadow : "suave",
        subtitle: String(o.theme?.subtitle || "").slice(0, 60),
        bg_image: /gradient\(/.test(o.theme?.bg_image || "")
          ? String(o.theme.bg_image).slice(0, 200)
          : "",
        dark: o.theme?.dark === "auto" ? "auto" : "off",
      },
    }));
    if (!options.length) return json({ error: "la IA no devolvió diseños; vuelve a intentarlo" }, 502);
    return json({ options, analyzed: domain || null });
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
  if (mPass && request.method === "DELETE") {
    const rows = await sb(env, `clients?id=eq.${mPass[1]}`, {
      method: "PATCH",
      body: { portal_password_hash: null },
    });
    if (!rows?.length) return json({ error: "cliente no encontrado" }, 404);
    return json({ ok: true });
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
        headers: { ...storageHeaders(env), "Content-Type": "application/pdf" },
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
        headers: storageHeaders(env),
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
<title>ExpoBot — Estudio</title>
<style>
  :root{--ink:#10182b;--mut:#6b7590;--line:#e4e7f0;--bg:#f5f7fc;--acc:#3c62f0;--acc2:#7c96ff;
    --grad:linear-gradient(135deg,#3c62f0,#6b8cff);--ok:#0a7a4b;--err:#b3261e}
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
  .primary{background:var(--grad);color:#fff;border:0;border-radius:10px;padding:10px 18px;
    box-shadow:0 2px 12px rgba(109,94,241,.35)}
  .ghost{background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px 14px}
  .small{font-size:13px;padding:6px 12px}
  .mut{color:var(--mut);font-size:13px}
  .ok{color:var(--ok);font-size:13px}
  .err{color:var(--err);font-size:13px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;letter-spacing:-.02em}
  .brand svg{width:34px;height:30px;flex:0 0 auto}
  .brand span{color:var(--ink)}
  .brand span b{color:var(--acc);font-weight:800}
  .brand svg.bub{width:.82em;height:.6em;display:inline;vertical-align:-2%;margin:0 .5px}
  .brand em{font:400 12.5px system-ui,sans-serif;color:var(--mut);font-style:normal;margin-left:2px}
  .login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
    background:var(--grad)}
  .login .card{background:#fff;border:0;border-radius:20px;padding:34px;
    width:390px;max-width:100%;box-shadow:0 24px 80px rgba(20,10,80,.35)}
  .login h1{font-size:18px;margin-bottom:6px}
  .login input{margin:14px 0 10px}
  .login button{width:100%}
  header{background:#fff;border-bottom:1px solid var(--line);padding:12px 24px;display:flex;
    justify-content:space-between;align-items:center;position:sticky;top:0;z-index:20}
  .wrap{display:grid;grid-template-columns:250px 1fr;gap:20px;max-width:1420px;margin:0 auto;
    padding:20px 16px}
  #edit-col{min-width:0}
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
  .icopick{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
  .icopick button{width:46px;height:46px;border:1px solid var(--line);border-radius:10px;background:#fff;
    display:flex;align-items:center;justify-content:center;font:600 13px system-ui,sans-serif;color:#555}
  .icopick button.on{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
  .icopick svg{width:22px;height:22px;fill:none;stroke:#333;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  #ds-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:10px}
  .dsopt{border:1px solid var(--line);border-radius:14px;padding:14px}
  .dsopt .dshead{display:flex;align-items:center;gap:8px;padding:8px 11px;font-size:12.5px;font-weight:600}
  .dsopt .dsbub{padding:6px 10px;font-size:12px;margin-top:8px;width:fit-content;max-width:92%}
  .dsopt .dsmine{margin-left:auto}
  .dsopt .dsname{font-weight:600;margin-top:12px;font-size:14px}
  .dsopt .dswhy{font-size:12px;opacity:.75;margin:4px 0 10px}
  #prev{border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:8px;background:#f7f7f5;
    display:flex;flex-direction:column;gap:10px;max-width:340px}
  #pv-head{display:flex;align-items:center;gap:9px;border-radius:12px;padding:10px 12px;background:#111;color:#fff}
  #pv-av{width:30px;height:30px;border-radius:15px;background:rgba(0,0,0,.18);display:flex;
    align-items:center;justify-content:center;font-weight:600;flex:0 0 auto}
  #pv-bub{background:#fff;border-radius:12px;border-bottom-left-radius:4px;padding:8px 12px;font-size:13px;max-width:85%;align-self:flex-start}
  #pv-mine{border-radius:12px;border-bottom-right-radius:4px;padding:8px 12px;font-size:13px;max-width:85%;align-self:flex-end;background:#111;color:#fff}
  #pv-btnrow{display:flex;justify-content:flex-end}
  #pv-btn{width:44px;height:44px;border-radius:22px;background:#111}
  #main.with-canvas{display:grid;grid-template-columns:minmax(0,1fr) 350px;gap:20px;align-items:start}
  #main.with-canvas #crumb{grid-column:1 / -1;margin-bottom:0}
  #canvas-panel{min-width:0}
  #cv-sticky{position:sticky;top:74px}
  #cv-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;
    font-weight:600;font-size:14px}
  #cv-frame{background:linear-gradient(180deg,#eceef8,#dde2f2);border:1px solid var(--line);
    border-radius:18px;padding:16px;display:flex;flex-direction:column;align-items:flex-end;gap:12px}
  #cv-widget{width:100%;border-radius:16px;overflow:hidden;display:flex;flex-direction:column;
    background:#fff;box-shadow:0 12px 40px rgba(20,20,60,.18)}
  #cv-h{display:flex;align-items:center;gap:10px;padding:12px 14px;background:#111;color:#fff}
  #cv-av{width:32px;height:32px;border-radius:16px;background:rgba(0,0,0,.18);display:flex;
    align-items:center;justify-content:center;font-weight:700;overflow:hidden;flex:0 0 auto}
  #cv-av img{width:100%;height:100%;object-fit:cover}
  #cv-name{font-weight:600;font-size:14px;line-height:1.25}
  #cv-sub{font-size:11px;opacity:.75;line-height:1.25}
  #cv-log{padding:14px;display:flex;flex-direction:column;gap:9px;min-height:190px;max-height:380px;
    overflow-y:auto;background-size:cover;background-position:center}
  .cv-b{background:#f2f2f0;color:#1a1a1a;border-radius:12px;border-bottom-left-radius:4px;
    padding:8px 12px;font-size:13px;max-width:85%;align-self:flex-start}
  .cv-m{border-radius:12px;border-bottom-right-radius:4px;padding:8px 12px;font-size:13px;
    max-width:85%;align-self:flex-end;background:#111;color:#fff}
  #cv-sug{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
  #cv-sug span{border:1px solid #ddd;border-radius:14px;padding:4px 10px;font-size:11.5px;
    background:#fff;color:#333}
  #cv-foot{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #eee;align-items:center}
  #cv-in{flex:1;border:1px solid #ddd;border-radius:9px;padding:9px 11px;font-size:13px;color:#999;
    background:#fff;font-family:inherit;min-width:0;outline:0}
  #cv-send{width:38px;height:38px;border-radius:9px;background:#111;display:flex;align-items:center;
    justify-content:center;flex:0 0 auto;font-weight:600;cursor:pointer}
  #cv-sug span{cursor:pointer}
  .cv-typing{opacity:.65}
  #cv-brand{text-align:center;font-size:10.5px;color:#999;padding:0 0 6px;background:#fff}
  #cv-btnrow{display:flex}
  #cv-btn{height:52px;min-width:52px;border-radius:26px;background:#111;display:flex;gap:8px;
    align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.2);padding:0 14px}
  @media(max-width:1100px){#main.with-canvas{display:block}#canvas-panel{margin-top:4px}}
  #bot-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
  #bot-tabs button{border:1px solid var(--line);background:#fff;border-radius:12px;padding:9px 16px;
    font-size:14px;font-weight:600;color:#555;cursor:pointer}
  #bot-tabs button.on{background:var(--grad);color:#fff;border-color:transparent}
  .chk{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:10px;
    padding:10px 14px;margin-bottom:8px;font-size:14px}
  .chk .chk-ic{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    flex:none;background:#eef1f8;color:var(--mut);font-weight:700;font-size:14px}
  .chk.done .chk-ic{background:#e3f6e9;color:#1d9e4b}
  .chk button{margin-left:auto;white-space:nowrap}
  #crumb a{text-decoration:none;font-weight:600;color:var(--acc)}
  #ck{position:fixed;inset:0;background:rgba(16,24,43,.45);z-index:90;display:flex;
    align-items:flex-start;justify-content:center;padding-top:12vh}
  #ck-box{background:#fff;border-radius:14px;width:540px;max-width:92vw;
    box-shadow:0 24px 80px rgba(0,0,0,.3);overflow:hidden}
  #ck-in{width:100%;border:0;outline:0;padding:15px 18px;font:inherit;font-size:16px;
    border-bottom:1px solid var(--line);border-radius:0}
  #ck-list{max-height:320px;overflow-y:auto;padding:6px}
  #ck-list button{display:flex;gap:8px;width:100%;text-align:left;border:0;background:none;
    border-radius:8px;padding:10px 12px;font:inherit;align-items:center}
  #ck-list button.sel{background:var(--bg)}
  #ck-list button .mut{margin-left:auto;white-space:nowrap}
  #menu-btn{display:none}
  @media(max-width:760px){
    aside{display:none}
    aside.open{display:block}
    #menu-btn{display:inline-block;margin-right:8px}
  }
  .seg{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;width:fit-content}
  .seg button{border:0;background:#fff;padding:8px 16px;font-size:13.5px;cursor:pointer;color:#555}
  .seg button.on{background:var(--acc);color:#fff}
  .gradrow{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
  .gradrow button{width:58px;height:42px;border:2px solid var(--line);border-radius:10px;cursor:pointer;padding:0}
  .gradrow button.on{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
  .cp-btn{border:1px solid var(--line);border-radius:10px;cursor:pointer;height:42px;width:100%;
    padding:0;box-shadow:inset 0 0 0 3px #fff}
  .cp-btn.mini{width:58px}
  #cp{position:absolute;z-index:90;background:#fff;border:1px solid var(--line);border-radius:16px;
    padding:14px;width:252px;box-shadow:0 14px 44px rgba(16,24,43,.28)}
  #cp-sv{position:relative;height:140px;border-radius:12px;cursor:crosshair;
    background:linear-gradient(to top,#000,rgba(0,0,0,0)),linear-gradient(to right,#fff,#f00)}
  #cp-svc{position:absolute;width:18px;height:18px;border-radius:9px;border:3px solid #fff;
    box-shadow:0 0 0 1px rgba(0,0,0,.3),0 1px 4px rgba(0,0,0,.3);transform:translate(-50%,-50%);
    pointer-events:none}
  #cp-hue{position:relative;height:12px;border-radius:6px;margin-top:14px;cursor:pointer;
    background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)}
  #cp-huec{position:absolute;top:50%;width:20px;height:20px;border-radius:10px;background:#fff;
    box-shadow:0 0 0 1px rgba(0,0,0,.2),0 1px 5px rgba(0,0,0,.35);transform:translate(-50%,-50%);
    pointer-events:none}
  #cp-row{display:flex;gap:8px;align-items:center;margin-top:14px}
  #cp-swatch{width:36px;height:36px;border-radius:18px;border:1px solid var(--line);flex:0 0 auto}
  #cp-hex{flex:1;font-family:ui-monospace,monospace;font-size:13px;text-transform:uppercase;
    border:1px solid var(--line);border-radius:10px;padding:8px 10px}
  #cp-eye{width:38px;height:38px;border-radius:19px;border:1px solid var(--line);background:#fff;
    flex:0 0 auto;font-size:16px}
</style>
</head>
<body>

<div id="login" class="login hide">
  <div class="card">
    <div class="brand" style="margin-bottom:12px"><svg viewBox="0 0 64 58"><g fill="none" stroke="#3c62f0" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 14V8"/><path d="M22 14h20c9.4 0 17 7.2 17 16s-7.6 16-17 16H26l-11 8V43.5C9.3 41 6 35.9 6 30c0-8.8 7.6-16 16-16z"/></g><circle cx="32" cy="6" r="4.2" fill="#3c62f0"/><circle cx="25" cy="30" r="4.2" fill="#3c62f0"/><circle cx="39" cy="30" r="4.2" fill="#3c62f0"/></svg><span>Expo<b>B<svg class="bub" viewBox="0 12 64 46"><path d="M22 14h20c9.4 0 17 7.2 17 16s-7.6 16-17 16H26l-11 8V43.5C9.3 41 6 35.9 6 30c0-8.8 7.6-16 16-16z" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linejoin="round" stroke-linecap="round"/></svg>t</b></span></div>
    <h1>Bienvenido a tu estudio</h1>
    <p class="mut">Introduce tu clave de acceso para gestionar tus clientes y sus asistentes.</p>
    <input id="tok" type="password" placeholder="Token" autocomplete="current-password">
    <button id="enter" class="primary">Entrar</button>
    <p id="login-err" class="err"></p>
  </div>
</div>

<div id="app" class="hide">
  <header>
    <div class="brand"><svg viewBox="0 0 64 58"><g fill="none" stroke="#3c62f0" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 14V8"/><path d="M22 14h20c9.4 0 17 7.2 17 16s-7.6 16-17 16H26l-11 8V43.5C9.3 41 6 35.9 6 30c0-8.8 7.6-16 16-16z"/></g><circle cx="32" cy="6" r="4.2" fill="#3c62f0"/><circle cx="25" cy="30" r="4.2" fill="#3c62f0"/><circle cx="39" cy="30" r="4.2" fill="#3c62f0"/></svg><span>Expo<b>B<svg class="bub" viewBox="0 12 64 46"><path d="M22 14h20c9.4 0 17 7.2 17 16s-7.6 16-17 16H26l-11 8V43.5C9.3 41 6 35.9 6 30c0-8.8 7.6-16 16-16z" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linejoin="round" stroke-linecap="round"/></svg>t</b></span><em>estudio de asistentes IA</em></div>
    <div>
      <button id="menu-btn" class="ghost small">☰ Menú</button>
      <button id="search-btn" class="ghost small" title="Ctrl+K">🔍 Buscar</button>
      <button id="logout" class="ghost small" style="margin-left:8px">Salir</button>
    </div>
  </header>
  <div class="wrap">
    <aside>
      <button id="home-btn" class="ghost" style="width:100%;margin-bottom:8px">📊 Inicio</button>
      <button id="leads-btn" class="ghost" style="width:100%;margin-bottom:8px">📥 Leads</button>
      <button id="new-client" class="primary">+ Nuevo cliente</button>
      <div id="tree"></div>
    </aside>
    <main id="main" class="hide">

      <p id="crumb" class="mut"></p>

      <div id="edit-col">

      <div id="bot-tabs" class="hide">
        <button data-bt="cerebro" class="on">🧠 Cerebro</button>
        <button data-bt="contenido">📚 Contenido</button>
        <button data-bt="diseno">🎨 Diseño</button>
        <button data-bt="calidad">🎓 Calidad</button>
        <button data-bt="publicar">🚀 Publicar</button>
      </div>

      <div class="card hide" id="v-wizard">
        <h2>✨ Nuevo cliente en un paso</h2>
        <p class="sub">Rellena esto y ExpoBot crea el cliente, su proyecto y su chatbot ya configurado
        por la IA, con la demo lista para enseñar.</p>
        <div class="row">
          <div><label>Nombre del negocio</label><input id="w-name" placeholder="Clínica Sonrisa"></div>
          <div><label>Su página web</label><input id="w-web" placeholder="clinicasonrisa.com"></div>
        </div>
        <div class="row">
          <div><label>Email del cliente (para su portal e informes)</label><input id="w-email" type="email"></div>
          <div><label>Teléfono (opcional)</label><input id="w-phone"></div>
        </div>
        <label>Cuéntale a la IA qué hace el negocio y qué debe conseguir el bot</label>
        <textarea id="w-brief" rows="3" placeholder="Clínica dental en Valencia. El bot resuelve dudas de tratamientos y precios orientativos, capta pacientes interesados con nombre y teléfono, y nunca da consejo médico."></textarea>
        <div class="actions">
          <button id="w-go" class="primary">Crear cliente y chatbot con IA</button>
          <span id="w-msg" class="mut"></span>
        </div>
        <p class="mut" style="margin-top:8px"><a href="#" id="w-manual" style="color:var(--mut)">Prefiero crearlo a mano, paso a paso</a></p>
      </div>

      <div class="card hide" id="v-check">
        <h2>✅ Listo para publicar</h2>
        <p class="sub">Los pasos que separan este chatbot de estar funcionando en la web del cliente.</p>
        <div id="check-list" class="mut">Cargando…</div>
      </div>

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
        <label style="margin-top:20px">📥 Últimos leads
          <button id="home-leads-all" class="ghost small" style="margin-left:8px">Ver todos</button></label>
        <div id="home-leads" class="mut">Cargando…</div>
        <label style="margin-top:20px">🩺 Salud del motor — últimos errores registrados</label>
        <div id="home-errors" class="mut">Cargando…</div>
      </div>

      <div class="card hide" id="v-leads">
        <h2>📥 Leads de todos los clientes</h2>
        <p class="sub">Los contactos que han captado todos los chatbots, del más reciente al más antiguo.</p>
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <select id="gl-filter" style="max-width:260px"><option value="">Todos los chatbots</option></select>
          <button id="gl-csv" class="ghost small">Descargar CSV</button>
          <span id="gl-msg" class="mut"></span>
        </div>
        <div style="overflow-x:auto"><table class="home" style="min-width:720px">
          <thead><tr><th>Fecha</th><th>Chatbot</th><th>Tipo</th><th>Nombre</th><th>Contacto</th><th>Qué necesita</th><th>Estado</th></tr></thead>
          <tbody id="gl-body"></tbody>
        </table></div>
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
        <div class="check"><input id="c-portal-on" type="checkbox">
          <label for="c-portal-on" style="margin:0">Acceso al portal activo
          (si lo desactivas, el cliente no podrá entrar aunque tenga contraseña)</label></div>
        <div class="actions">
          <button id="portal-pass" class="ghost small">Generar contraseña nueva</button>
          <button id="portal-revoke" class="ghost small">Revocar contraseña</button>
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

      <div class="card hide" id="v-exam">
        <h2>🎓 Examen del bot</h2>
        <p class="sub">La IA le hace 6 preguntas trampa (precios, fechas y datos fáciles de inventar)
        usando el motor real, y evalúa si responde solo con su contenido o se lo inventa. Ideal antes
        de entregar el bot a un cliente.</p>
        <div class="actions" style="margin-top:0">
          <button id="ex-run" class="ghost small">Examinar ahora (≈1 minuto)</button>
          <span id="ex-msg" class="mut"></span>
        </div>
        <div id="ex-score" style="font-weight:700;font-size:17px;margin-top:10px"></div>
        <div id="ex-list"></div>
      </div>

      <div class="card hide" id="v-tenant">
        <h2 id="f-title">Chatbot</h2>
        <p class="sub">Los cambios se aplican al guardar. El bot los usa en la siguiente conversación.</p>
        <div class="row">
          <div><label>Nombre (lo ve el usuario en el chat)</label><input id="f-name"></div>
          <div><label>Nombre interno (se rellena solo; no lo verá nadie)</label><input id="f-slug"></div>
        </div>
        <div class="ftabs">
          <button class="on" data-ft="ft-comp">Comportamiento</button>
          <button data-ft="ft-ap">Apariencia</button>
          <button data-ft="ft-leads">Leads</button>
          <button data-ft="ft-seg">Seguridad y límites</button>
        </div>
        <div class="ft on" id="ft-comp">
          <label>Personalidad e instrucciones del bot: quién es, qué puede y qué no puede decir</label>
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
          <label style="font-weight:600;color:var(--ink)">Diseñar con IA</label>
          <p class="mut" style="margin-bottom:6px">Analiza la web del cliente (el primer dominio de
          «Seguridad y límites») y, con tus indicaciones, propone 3 diseños completos. Elige uno:
          se vuelca en los controles de abajo y lo retocas antes de guardar.</p>
          <textarea id="ds-brief" rows="2" placeholder="Ej.: moderno y llamativo respetando el azul corporativo; una de las opciones oscura y elegante; tipografía con personalidad."></textarea>
          <div class="actions" style="margin:8px 0 4px">
            <button id="ds-run" class="ghost small">✨ Proponer 3 diseños</button>
            <span id="ds-msg" class="mut"></span>
          </div>
          <div id="ds-options"></div>
          <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
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
          <label>Icono del botón del chat</label>
          <div class="icopick" id="pick-btn"></div>
          <div class="row">
            <div><label>Forma del botón</label>
              <select id="f-btnshape">
                <option value="circulo">Círculo</option>
                <option value="redondeado">Cuadrado redondeado</option>
                <option value="pastilla">Pastilla con texto</option>
              </select></div>
            <div><label>Texto de la pastilla (si eliges esa forma)</label>
              <input id="f-btnlabel" placeholder="Chat"></div>
          </div>
          <label>Icono del botón de enviar («Abc» = usa el texto configurado abajo)</label>
          <div class="icopick" id="pick-send"></div>
          <div class="row">
            <div><label>Tamaño del widget</label>
              <select id="f-size">
                <option value="compacto">Compacto</option>
                <option value="estandar" selected>Estándar</option>
                <option value="amplio">Amplio</option>
              </select></div>
            <div><label>Modo oscuro</label>
              <select id="f-dark">
                <option value="off">Desactivado</option>
                <option value="auto">Automático (según el sistema del visitante)</option>
              </select></div>
          </div>
          <label>Fondo del área de mensajes</label>
          <div class="seg" id="bg-seg">
            <button type="button" data-m="solid" class="on">Color sólido</button>
            <button type="button" data-m="grad">Degradado</button>
            <button type="button" data-m="img">Imagen</button>
          </div>
          <div id="bg-solid" style="margin-top:8px">
            <p class="mut">Se usa el color «Fondo de la ventana de chat» de arriba.</p>
          </div>
          <div id="bg-grad" class="hide" style="margin-top:8px">
            <label style="margin-top:0">Colores del degradado</label>
            <div style="display:flex;gap:8px">
              <input id="g-c1" type="color" value="#6d8bf1" style="width:58px;height:42px;padding:3px">
              <input id="g-c2" type="color" value="#c9f0ff" style="width:58px;height:42px;padding:3px">
            </div>
            <label>Estilo</label>
            <div class="gradrow" id="g-styles"></div>
          </div>
          <div id="bg-img" class="hide" style="margin-top:8px">
            <input id="f-bgimg" placeholder="Pega la URL de una imagen (https://…)">
          </div>
          <label style="margin-top:18px;font-weight:600;color:var(--ink)">Textos de la interfaz (para otros idiomas o tonos)</label>
          <div class="row">
            <div><label>Campo de escritura</label><input id="f-tplaceholder" placeholder="Escribe tu pregunta…"></div>
            <div><label>Botón de enviar</label><input id="f-tsend" placeholder="→"></div>
          </div>
          <div class="row">
            <div><label>Mensaje de error de conexión</label><input id="f-terror" placeholder="No he podido conectar…"></div>
            <div><label>Texto de la burbuja de invitación (vacío = la bienvenida)</label><input id="f-tteaser"></div>
          </div>
          <label style="margin-top:18px;font-weight:600;color:var(--ink)">Marca en el pie («Impulsado por…»)</label>
          <div class="row">
            <div><label>Tu marca (vacío = sin pie)</label><input id="f-brand" placeholder="Tu Agencia"></div>
            <div><label>Enlace de la marca (opcional)</label><input id="f-brandurl" type="url" placeholder="https://tuagencia.com"></div>
          </div>
          <div class="check"><input id="f-sound" type="checkbox">
            <label for="f-sound" style="margin:0">Sonido sutil al aparecer la invitación (si el navegador lo permite)</label></div>
          <label>CSS personalizado (avanzado; se inyecta tal cual en la web del cliente)</label>
          <textarea id="f-css" rows="3" placeholder=".cb-btn{ } .cb-panel{ } .cb-msg.bot{ } …"></textarea>
          <p class="mut" style="margin-top:16px">👁 Todos los cambios se ven al momento en la
          <b>vista en vivo</b> de la derecha.</p>
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
          <div class="check"><input id="f-featleads" type="checkbox"><label for="f-featleads" style="margin:0">Captura de leads (si lo desactivas, el bot solo responde preguntas, sin pedir datos de contacto)</label></div>
          <label style="margin-top:18px">Panel del cliente de este chatbot</label>
          <div class="check"><input id="f-panelon" type="checkbox"><label for="f-panelon" style="margin:0">Panel del cliente accesible (si lo desactivas, su enlace deja de funcionar)</label></div>
          <p class="mut" style="margin:8px 0 4px">Qué puede ver y hacer el cliente en su panel:</p>
          <div class="check"><input id="f-pfleads" type="checkbox"><label for="f-pfleads" style="margin:0">Leads</label></div>
          <div class="check"><input id="f-pfconvs" type="checkbox"><label for="f-pfconvs" style="margin:0">Conversaciones</label></div>
          <div class="check"><input id="f-pfgaps" type="checkbox"><label for="f-pfgaps" style="margin:0">Preguntas sin respuesta</label></div>
          <div class="check"><input id="f-pfuploads" type="checkbox"><label for="f-pfuploads" style="margin:0">Subir contenido</label></div>
          <div class="check"><input id="f-pftest" type="checkbox"><label for="f-pftest" style="margin:0">Probar el bot</label></div>
        </div>
        <div class="actions">
          <button id="save" class="primary">Guardar</button>
          <button id="f-dup" class="ghost small">Duplicar chatbot</button>
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
        <div class="actions" style="margin-top:6px">
          <button id="ig-run" class="ghost small">🔍 ¿Cómo se integra en su web?</button>
          <span id="ig-msg" class="mut"></span>
        </div>
        <div id="ig-box" class="hide" style="border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:8px">
          <div id="ig-title" style="font-weight:600;margin-bottom:6px"></div>
          <ol id="ig-steps" style="padding-left:20px;font-size:14px"></ol>
          <p id="ig-note" class="mut" style="margin-top:8px"></p>
          <label>Enlace con estas instrucciones (para el informático del cliente)</label>
          <div class="copyrow"><input id="ig-url" readonly>
            <button class="ghost small" data-copy="ig-url">Copiar</button>
            <button id="ig-url-open" class="ghost small">Abrir</button></div>
          <div class="actions">
            <button id="ig-pdf" class="ghost small">📄 Descargar PDF</button>
            <button id="ig-copy" class="ghost small">Copiar instrucciones + código como texto</button>
          </div>
        </div>
        <label>Panel del cliente (conversaciones, leads, preguntas sin respuesta)</label>
        <div class="copyrow"><input id="i-panel" readonly>
          <button class="ghost small" data-copy="i-panel">Copiar</button>
          <button id="i-open" class="ghost small">Abrir</button></div>
        <div class="actions">
          <button id="rep-send" class="ghost small">📊 Enviar informe del mes al cliente</button>
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
        <label>Indicaciones para la IA (opcional): qué temas cubrir, cuántas preguntas, qué evitar…</label>
        <textarea id="faq-brief" rows="2" placeholder="Ej.: céntrate en precios de stands y patrocinio; añade preguntas sobre parking y horarios de montaje; unas 8 preguntas en total; nada de temas clínicos."></textarea>
        <div class="actions" style="margin-top:8px">
          <button id="faq-gen" class="ghost small">Generar formulario con IA</button>
          <span id="faq-msg" class="mut"></span>
        </div>
        <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
        <label>🧠 Huecos de conocimiento — lo que preguntaron y el bot no supo responder</label>
        <p class="mut" style="margin-bottom:8px">La IA revisa las preguntas sin respuesta de los
        últimos 60 días y redacta borradores. Rellena los datos entre [corchetes], marca las que
        quieras y apruébalas: quedan indexadas al momento.</p>
        <div class="actions" style="margin-top:0">
          <button id="gap-run" class="ghost small">Analizar con IA</button>
          <span id="gap-msg" class="mut"></span>
        </div>
        <div id="gap-list"></div>
        <div class="actions hide" id="gap-approve-row">
          <button id="gap-approve" class="primary">Aprobar e indexar las marcadas</button>
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

      </div>

      <aside id="canvas-panel" class="hide">
        <div id="cv-sticky">
          <div id="cv-bar"><span>👁 Vista en vivo</span>
            <button id="cv-dark" class="ghost small" type="button">🌙 Oscuro</button></div>
          <div id="cv-frame">
            <div id="cv-widget">
              <div id="cv-h"><div id="cv-av">A</div>
                <div><div id="cv-name">Asistente</div><div id="cv-sub">Suele responder al instante</div></div></div>
              <div id="cv-log">
                <div class="cv-b" id="cv-welcome">¡Hola!</div>
                <div class="cv-m" id="cv-user">Tengo una duda</div>
                <div class="cv-b" id="cv-reply">¡Claro! Cuéntame y te ayudo 😊</div>
                <div id="cv-sug"></div>
              </div>
              <div id="cv-foot"><input id="cv-in" placeholder="Escribe tu pregunta…"><div id="cv-send"></div></div>
              <div id="cv-brand" class="hide"></div>
            </div>
            <div id="cv-btnrow"><div id="cv-btn"></div></div>
          </div>
          <p class="mut" style="margin-top:10px;font-size:12px">Vista en vivo del diseño <b>y chat real</b>:
          escribe abajo y el bot responde de verdad con su contenido. Responde con la última versión
          guardada — pulsa Guardar antes de probar cambios de instrucciones.</p>
        </div>
      </aside>

    </main>
  </div>
</div>

<div id="toast"></div>

<div id="ck" class="hide">
  <div id="ck-box">
    <input id="ck-in" placeholder="Busca un cliente, proyecto o chatbot…">
    <div id="ck-list"></div>
  </div>
</div>

<div id="cp" class="hide">
  <div id="cp-sv"><div id="cp-svc"></div></div>
  <div id="cp-hue"><div id="cp-huec"></div></div>
  <div id="cp-row">
    <div id="cp-swatch"></div>
    <input id="cp-hex" maxlength="7" spellcheck="false">
    <button id="cp-eye" type="button" title="Capturar un color de la pantalla">💧</button>
  </div>
</div>

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
  if (sel.type === "leads") return goLeads();
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
  if (!guardNav()) return;
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
  api("/admin/api/leads").then(function (rows) {
    var box = $("home-leads");
    if (!rows || rows.error) { box.textContent = "No disponible."; return; }
    if (!rows.length) { box.textContent = "Sin leads todavía."; return; }
    box.innerHTML = "";
    box.className = "";
    rows.slice(0, 5).forEach(function (r) {
      var d = document.createElement("div");
      d.className = "doc";
      var l = document.createElement("div");
      var t1 = document.createElement("div");
      t1.textContent = (r.name || "(sin nombre)") + (r.company ? " · " + r.company : "") +
        " — " + [r.email, r.phone].filter(Boolean).join(" · ");
      t1.style.fontWeight = "600";
      var m = document.createElement("div");
      m.className = "meta";
      m.textContent = new Date(r.created_at).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) +
        (r.tenants ? " · " + r.tenants.name : "") + (r.message ? " · " + r.message : "");
      l.appendChild(t1);
      l.appendChild(m);
      d.appendChild(l);
      d.style.cursor = "pointer";
      d.onclick = goLeads;
      box.appendChild(d);
    });
  }).catch(function () { $("home-leads").textContent = "No disponible."; });
  api("/admin/api/errors").then(function (errs) {
    var box = $("home-errors");
    if (!errs || errs.error) { box.textContent = "No disponible."; return; }
    if (!errs.length) { box.textContent = "Sin errores registrados ✓"; box.className = "ok"; return; }
    box.className = "mut";
    box.innerHTML = "";
    errs.slice(0, 8).forEach(function (e) {
      var d = document.createElement("div");
      d.className = "doc";
      var l = document.createElement("div");
      var t1 = document.createElement("div");
      t1.textContent = e.route;
      t1.style.fontWeight = "600";
      var m = document.createElement("div");
      m.className = "meta";
      m.textContent = new Date(e.created_at).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) + " · " + e.message;
      l.appendChild(t1); l.appendChild(m);
      d.appendChild(l);
      box.appendChild(d);
    });
  }).catch(function () {});
}
$("home-btn").onclick = goHome;

// ----- leads globales -----

var GL_ROWS = [];
function goLeads() {
  if (!guardNav()) return;
  sel = { type: "leads" };
  renderTree();
  crumb(["Leads"]);
  showCards(["v-leads"]);
  $("gl-body").innerHTML = "<tr><td colspan='7' class='mut'>Cargando…</td></tr>";
  api("/admin/api/leads").then(function (rows) {
    if (rows.error) { $("gl-body").innerHTML = ""; $("gl-msg").textContent = rows.error; return; }
    GL_ROWS = rows;
    var seen = {};
    var fl = $("gl-filter");
    fl.innerHTML = "<option value=''>Todos los chatbots</option>";
    rows.forEach(function (r) {
      var n = r.tenants ? r.tenants.name : "";
      if (n && !seen[n]) {
        seen[n] = 1;
        var o = document.createElement("option");
        o.value = n;
        o.textContent = n;
        fl.appendChild(o);
      }
    });
    renderGlobalLeads();
  }).catch(function () { $("gl-msg").textContent = "No se han podido cargar."; });
}

function renderGlobalLeads() {
  var f = $("gl-filter").value;
  var tb = $("gl-body");
  tb.innerHTML = "";
  var rows = GL_ROWS.filter(function (r) { return !f || (r.tenants && r.tenants.name === f); });
  $("gl-msg").textContent = rows.length ? rows.length + (rows.length === 1 ? " lead" : " leads") : "";
  if (!rows.length) {
    tb.innerHTML = "<tr><td colspan='7' class='mut'>Sin leads todavía. Cuando los bots capten contactos, aparecerán aquí.</td></tr>";
    return;
  }
  rows.forEach(function (r) {
    var tr = document.createElement("tr");
    function td(v) { var d = document.createElement("td"); d.textContent = v || ""; return d; }
    tr.appendChild(td(new Date(r.created_at).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })));
    tr.appendChild(td(r.tenants ? r.tenants.name : ""));
    tr.appendChild(td(r.kind));
    tr.appendChild(td((r.name || "") + (r.company ? " · " + r.company : "")));
    tr.appendChild(td([r.email, r.phone].filter(Boolean).join(" · ")));
    tr.appendChild(td(r.message));
    var st = document.createElement("td");
    if (r.status === "contactado") {
      st.textContent = "✓ contactado";
      st.className = "ok";
    } else {
      var b = document.createElement("button");
      b.className = "ghost small";
      b.textContent = "Marcar contactado";
      b.onclick = function (e) {
        e.stopPropagation();
        api("/admin/api/leads/" + r.id, { method: "PATCH", body: JSON.stringify({ status: "contactado" }) })
          .then(function (x) {
            if (x.error) { toast(x.error, true); return; }
            r.status = "contactado";
            renderGlobalLeads();
          });
      };
      st.appendChild(b);
    }
    tr.appendChild(st);
    tb.appendChild(tr);
  });
}

$("gl-filter").onchange = renderGlobalLeads;

$("gl-csv").onclick = function () {
  var f = $("gl-filter").value;
  var rows = GL_ROWS.filter(function (r) { return !f || (r.tenants && r.tenants.name === f); });
  var head = ["fecha", "chatbot", "tipo", "nombre", "empresa", "email", "telefono", "mensaje", "estado"];
  var csv = [head.join(";")].concat(rows.map(function (r) {
    return [r.created_at, r.tenants ? r.tenants.name : "", r.kind, r.name, r.company, r.email, r.phone, r.message, r.status]
      .map(function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; })
      .join(";");
  })).join("\\n");
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = "leads-expobot.csv";
  a.click();
};

$("leads-btn").onclick = goLeads;
$("home-leads-all").onclick = function (e) { e.stopPropagation(); goLeads(); };

// ----- buscador Ctrl+K -----

var CK_ITEMS = [], CK_SEL = 0;

function ckBuild() {
  CK_ITEMS = [];
  data.forEach(function (c) {
    CK_ITEMS.push({ label: c.name, kind: "Cliente", go: function () { selClient(c.id); } });
    (c.projects || []).forEach(function (p) {
      CK_ITEMS.push({ label: p.name, sub: c.name, kind: "Proyecto", go: function () { selProject(p.id); } });
      (p.tenants || []).forEach(function (t) {
        CK_ITEMS.push({ label: t.name, sub: c.name, kind: "Chatbot", go: function () { selTenant(t.id); } });
      });
    });
  });
}

function ckMatches() {
  var q = $("ck-in").value.trim().toLowerCase();
  return CK_ITEMS.filter(function (i) {
    return !q || (i.label + " " + (i.sub || "")).toLowerCase().indexOf(q) >= 0;
  }).slice(0, 12);
}

function ckRender() {
  var box = $("ck-list");
  box.innerHTML = "";
  var ms = ckMatches();
  if (CK_SEL >= ms.length) CK_SEL = 0;
  if (!ms.length) {
    box.innerHTML = "<p class='mut' style='padding:10px 12px'>Sin resultados.</p>";
    return;
  }
  ms.forEach(function (m, i) {
    var b = document.createElement("button");
    if (i === CK_SEL) b.className = "sel";
    var ic = m.kind === "Cliente" ? "👤 " : m.kind === "Proyecto" ? "📁 " : "💬 ";
    var l = document.createElement("span");
    l.textContent = ic + m.label + (m.sub ? " — " + m.sub : "");
    var k = document.createElement("span");
    k.className = "mut";
    k.textContent = m.kind;
    b.appendChild(l);
    b.appendChild(k);
    b.onclick = function () { ckClose(); m.go(); };
    box.appendChild(b);
  });
}

function ckOpen() {
  ckBuild();
  CK_SEL = 0;
  $("ck").classList.remove("hide");
  $("ck-in").value = "";
  ckRender();
  $("ck-in").focus();
}

function ckClose() { $("ck").classList.add("hide"); }

$("ck-in").addEventListener("input", function () { CK_SEL = 0; ckRender(); });
$("ck-in").addEventListener("keydown", function (e) {
  var ms = ckMatches();
  if (e.key === "ArrowDown") { CK_SEL = Math.min(CK_SEL + 1, ms.length - 1); ckRender(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { CK_SEL = Math.max(CK_SEL - 1, 0); ckRender(); e.preventDefault(); }
  else if (e.key === "Enter") { if (ms[CK_SEL]) { ckClose(); ms[CK_SEL].go(); } }
  else if (e.key === "Escape") ckClose();
});
$("ck").onclick = function (e) { if (e.target === $("ck")) ckClose(); };
$("search-btn").onclick = ckOpen;
document.addEventListener("keydown", function (e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); ckOpen(); }
});

// ----- menú lateral en móvil -----

$("menu-btn").onclick = function () {
  document.querySelector("aside").classList.toggle("open");
};
document.querySelector("aside").addEventListener("click", function (e) {
  if (e.target.tagName === "BUTTON" && window.innerWidth <= 760) {
    document.querySelector("aside").classList.remove("open");
  }
});

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

var ALL_VIEWS = ["v-home", "v-leads", "v-wizard", "v-check", "v-client", "v-client-projects", "v-client-portal", "v-client-inv", "v-project", "v-project-tools", "v-assist", "v-tenant", "v-exam", "integ", "ingest"];
function showCards(ids, keepTabs) {
  ALL_VIEWS.forEach(function (v) { $(v).classList.toggle("hide", ids.indexOf(v) < 0); });
  if (!keepTabs) $("bot-tabs").classList.add("hide");
  var canvas = ids.indexOf("v-tenant") >= 0;
  $("canvas-panel").classList.toggle("hide", !canvas);
  $("main").classList.toggle("with-canvas", canvas);
  $("main").classList.remove("hide");
}

function crumb(parts) {
  var box = $("crumb");
  box.innerHTML = "";
  parts.forEach(function (p, i) {
    if (i) box.appendChild(document.createTextNode("  ›  "));
    if (p && p.go) {
      var a = document.createElement("a");
      a.href = "#";
      a.textContent = p.t;
      a.onclick = function (e) { e.preventDefault(); p.go(); };
      box.appendChild(a);
    } else {
      box.appendChild(document.createTextNode(typeof p === "string" ? p : p.t));
    }
  });
}

// ----- cambios sin guardar -----

var dirty = false;
var populating = false;
function markDirty() { if (!populating) dirty = true; }
function guardNav() {
  if (!dirty) return true;
  if (confirm("Hay cambios sin guardar que se perderán si sales. ¿Salir sin guardar?")) {
    dirty = false;
    return true;
  }
  return false;
}
["v-client", "v-project", "v-tenant"].forEach(function (id) {
  $(id).addEventListener("input", markDirty);
  $(id).addEventListener("change", markDirty);
});
window.addEventListener("beforeunload", function (e) {
  if (dirty) { e.preventDefault(); e.returnValue = ""; }
});

// ----- cliente -----

function selClient(id) {
  if (sel.type !== "client" || sel.id !== id) { if (!guardNav()) return; }
  populating = true;
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
    $("c-portal-on").checked = c.portal_enabled !== false;
    $("portal-pass-out").textContent = c.portal_password_hash
      ? "El cliente ya tiene contraseña. Genera una nueva solo si la ha perdido (la anterior dejará de valer)."
      : "Este cliente aún no tiene contraseña: genera una y envíasela junto con el enlace de acceso.";
    $("portal-pass-out").className = "mut";
    $("portal-msg").textContent = "";
    $("iv-msg").textContent = "";
    loadInvoices();
  }
  showCards(c ? ["v-client", "v-client-projects", "v-client-portal", "v-client-inv"] : ["v-client"]);
  populating = false;
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

$("c-portal-on").onchange = function () {
  if (sel.type !== "client" || sel.isNew) return;
  var on = $("c-portal-on").checked;
  api("/admin/api/clients/" + sel.id, {
    method: "PATCH",
    body: JSON.stringify({ portal_enabled: on }),
  }).then(function (r) {
    if (r.error) { toast(r.error, true); return; }
    var c = findClient(sel.id);
    if (c) c.portal_enabled = on;
    toast(on ? "Acceso al portal activado ✓" : "Acceso al portal desactivado");
  });
};

$("portal-revoke").onclick = function () {
  var c = findClient(sel.id);
  if (!c || !c.portal_password_hash) { toast("Este cliente no tiene contraseña que revocar."); return; }
  if (!confirm("La contraseña actual de " + c.name + " dejará de valer y no podrá entrar al portal " +
    "hasta que generes una nueva. ¿Revocar?")) return;
  api("/admin/api/clients/" + sel.id + "/portal-password", { method: "DELETE" }).then(function (r) {
    if (r.error) { toast(r.error, true); return; }
    c.portal_password_hash = null;
    $("portal-pass-out").textContent = "Contraseña revocada: el cliente ya no puede entrar. Genera una nueva cuando quieras.";
    $("portal-pass-out").className = "mut";
    toast("Contraseña revocada ✓");
  });
};

$("new-client").onclick = function () {
  if (!guardNav()) return;
  sel = { type: "wizard" };
  renderTree();
  crumb(["Nuevo cliente"]);
  ["w-name", "w-web", "w-email", "w-phone", "w-brief"].forEach(function (id) { $(id).value = ""; });
  $("w-msg").textContent = "";
  $("w-go").disabled = false;
  showCards(["v-wizard"]);
};

$("w-manual").onclick = function (e) {
  e.preventDefault();
  selClient(null);
};

function wmsg(txt, cls) { $("w-msg").textContent = txt; $("w-msg").className = cls || "mut"; }

function slugify(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

$("w-go").onclick = function () {
  var name = $("w-name").value.trim();
  var brief = $("w-brief").value.trim();
  if (!name) { wmsg("El nombre del negocio es obligatorio.", "err"); return; }
  if (brief.length < 20) { wmsg("Cuéntale a la IA algo más del negocio: al menos una frase completa.", "err"); return; }
  var web = $("w-web").value.trim().replace("https://", "").replace("http://", "");
  var slash = web.indexOf("/");
  if (slash > 0) web = web.slice(0, slash);
  $("w-go").disabled = true;
  wmsg("Creando el cliente… (paso 1 de 3)");
  var clientId, projectId, cfg = {};
  api("/admin/api/clients", {
    method: "POST",
    body: JSON.stringify({
      name: name,
      contact_name: null,
      email: $("w-email").value.trim() || null,
      phone: $("w-phone").value.trim() || null,
      notes: web ? "Web: " + web : "",
    }),
  }).then(function (r) {
    if (r.error) throw new Error(r.error);
    clientId = r.id;
    wmsg("Creando el proyecto… (paso 2 de 3)");
    return api("/admin/api/projects", {
      method: "POST",
      body: JSON.stringify({ client_id: clientId, name: "Chatbot web" }),
    });
  }).then(function (r) {
    if (r.error) throw new Error(r.error);
    projectId = r.id;
    wmsg("La IA está redactando la configuración del bot… (paso 3 de 3, hasta 30 segundos)");
    return api("/admin/api/assist", {
      method: "POST",
      body: JSON.stringify({ brief: brief + (web ? " La web del negocio es https://" + web : "") }),
    }).catch(function () { return {}; });
  }).then(function (r) {
    if (r && !r.error) cfg = r;
    var mk = function (slug) {
      return api("/admin/api/tenants", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          slug: slug,
          name: "Asistente de " + name,
          system_prompt: cfg.system_prompt || "",
          welcome_message: cfg.welcome_message || "¡Hola! ¿En qué puedo ayudarte?",
          suggested_questions: cfg.suggested_questions || [],
          provider: "google",
          model: "gemini-3.5-flash",
          allowed_domains: web ? [web] : [],
          active: true,
        }),
      });
    };
    var slug = slugify(name);
    return mk(slug).then(function (r2) {
      if (r2.error) return mk(slug + "-" + Math.random().toString(36).slice(2, 5));
      return r2;
    });
  }).then(function (r) {
    if (r.error) throw new Error(r.error);
    dirty = false;
    toast("Cliente y chatbot creados ✓");
    if (!cfg.system_prompt) {
      toast("Creado, pero la IA no pudo generar la configuración: revísala en Cerebro.", true);
    }
    sel = { type: "tenant", id: r.id, isNew: false };
    return load();
  }).catch(function (e) {
    $("w-go").disabled = false;
    wmsg((e && e.message) || "No se ha podido crear. Inténtalo otra vez.", "err");
  });
};

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
  if (!sel.isNew) d.portal_enabled = $("c-portal-on").checked;
  if (!d.name) { $("c-msg").textContent = "El nombre es obligatorio."; $("c-msg").className = "err"; return; }
  var req = sel.isNew
    ? api("/admin/api/clients", { method: "POST", body: JSON.stringify(d) })
    : api("/admin/api/clients/" + sel.id, { method: "PATCH", body: JSON.stringify(d) });
  req.then(function (r) {
    if (r.error) { $("c-msg").textContent = r.error; $("c-msg").className = "err"; toast(r.error, true); return; }
    sel = { type: "client", id: r.id, isNew: false };
    dirty = false;
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
    dirty = false;
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
      dirty = false;
      load();
    });
};

// ----- proyecto -----

function selProject(id) {
  if (sel.type !== "project" || sel.id !== id) { if (!guardNav()) return; }
  populating = true;
  sel = { type: "project", id: id };
  renderTree();
  var f = findProject(id);
  if (!f) { populating = false; return; }
  crumb([{ t: f.client.name, go: function () { selClient(f.client.id); } }, f.project.name]);
  $("p-title").textContent = f.project.name;
  $("p-name").value = f.project.name;
  $("p-desc").value = f.project.description || "";
  $("p-msg").textContent = "";
  renderBots(f.project);
  showCards(["v-project", "v-project-tools"]);
  populating = false;
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
    dirty = false;
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
    dirty = false;
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
  var sameTenant = sel.type === "tenant" && sel.id === id;
  if (!sameTenant) { if (!guardNav()) return; }
  populating = true;
  sel = { type: "tenant", id: id, isNew: !id, parentId: projectId || null };
  renderTree();
  var f = id ? findTenant(id) : null;
  var t = f ? f.tenant : null;
  if (f) {
    crumb([
      { t: f.client.name, go: function () { selClient(f.client.id); } },
      { t: f.project.name, go: function () { selProject(f.project.id); } },
      t.name,
    ]);
  } else {
    var pf = findProject(projectId);
    crumb(pf ? [
      { t: pf.client.name, go: function () { selClient(pf.client.id); } },
      { t: pf.project.name, go: function () { selProject(pf.project.id); } },
      "Nuevo chatbot",
    ] : ["Nuevo chatbot"]);
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
  var feats = (t && t.features) || {};
  $("f-featleads").checked = feats.leads !== false;
  $("f-panelon").checked = !t || t.panel_enabled !== false;
  var pf = (t && t.panel_features) || {};
  $("f-pfleads").checked = pf.leads !== false;
  $("f-pfconvs").checked = pf.convs !== false;
  $("f-pfgaps").checked = pf.gaps !== false;
  $("f-pfuploads").checked = pf.uploads !== false;
  $("f-pftest").checked = pf.test !== false;
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
  $("f-size").value = th.size || "estandar";
  $("f-dark").value = th.dark || "off";
  slugTouched = !isNew;
  var bgi = th.bg_image || "";
  $("f-bgimg").value = "";
  if (bgi.indexOf("gradient(") >= 0) {
    var gcols = bgi.match(/#[0-9a-fA-F]{6}/g) || [];
    if (gcols[0]) $("g-c1").value = gcols[0];
    if (gcols.length > 1) $("g-c2").value = gcols[gcols.length - 1];
    gradStyle = bgi.indexOf("radial") >= 0 ? 3 : bgi.indexOf("180deg") >= 0 ? 1
      : bgi.indexOf("90deg") >= 0 ? 2 : bgi.indexOf("45%") >= 0 ? 4 : 0;
    setBgMode("grad");
  } else if (bgi) {
    $("f-bgimg").value = bgi;
    setBgMode("img");
  } else {
    setBgMode("solid");
  }
  $("f-tplaceholder").value = th.t_placeholder || "";
  $("f-tsend").value = th.t_send || "";
  $("f-terror").value = th.t_error || "";
  $("f-tteaser").value = th.t_teaser || "";
  $("f-brand").value = th.brand_name || "";
  $("f-brandurl").value = th.brand_url || "";
  $("f-sound").checked = !!th.sound;
  $("f-css").value = th.custom_css || "";
  iconBtnSel = th.icon_btn || "burbuja";
  iconSendSel = th.icon_send || "";
  $("f-btnshape").value = th.btn_shape || "circulo";
  $("f-btnlabel").value = th.btn_label || "";
  renderIconPicks();
  $("save-msg").textContent = "";
  $("a-brief").value = ""; $("a-msg").textContent = "";
  $("ds-brief").value = ""; $("ds-msg").textContent = ""; $("ds-options").innerHTML = "";
  $("ig-box").classList.add("hide"); $("ig-msg").textContent = ""; IG_LAST = null;
  $("g-urls").value = ""; $("g-title").value = ""; $("g-content").value = "";
  $("g-report").textContent = ""; $("g-msg").textContent = "";
  $("g-files").value = ""; $("g-upmsg").textContent = "";
  resetFtabs();
  if (!sameTenant) cvResetChat();
  updPrev();
  $("ex-msg").textContent = ""; $("ex-score").textContent = ""; $("ex-list").innerHTML = "";
  $("gap-msg").textContent = ""; $("gap-list").innerHTML = "";
  $("gap-approve-row").classList.add("hide");
  if (t) {
    renderInteg(t);
    loadDocs();
    loadFaq();
    setBotTab(sameTenant ? curBT : "cerebro");
  } else {
    document.querySelector(".ftabs").classList.remove("hide");
    document.querySelector('.ftabs button[data-ft="ft-ap"]').classList.remove("hide");
    showCards(["v-assist", "v-tenant"]);
  }
  populating = false;
}

// ----- pestañas principales del chatbot -----

var curBT = "cerebro";
var BT_CARDS = {
  cerebro: ["v-assist", "v-tenant"],
  contenido: ["ingest"],
  diseno: ["v-tenant"],
  calidad: ["v-exam"],
  publicar: ["v-check", "integ"],
};

function ftShow(id) {
  [].forEach.call(document.querySelectorAll(".ftabs button"), function (x) {
    x.classList.toggle("on", x.dataset.ft === id);
  });
  [].forEach.call(document.querySelectorAll(".ft"), function (x) {
    x.classList.toggle("on", x.id === id);
  });
}

function setBotTab(bt) {
  curBT = bt;
  [].forEach.call(document.querySelectorAll("#bot-tabs button"), function (b) {
    b.classList.toggle("on", b.dataset.bt === bt);
  });
  showCards(BT_CARDS[bt] || [], true);
  $("bot-tabs").classList.remove("hide");
  var ftbar = document.querySelector(".ftabs");
  var apBtn = document.querySelector('.ftabs button[data-ft="ft-ap"]');
  if (bt === "diseno") {
    ftbar.classList.add("hide");
    ftShow("ft-ap");
  } else if (bt === "cerebro") {
    ftbar.classList.remove("hide");
    apBtn.classList.add("hide");
    ftShow("ft-comp");
  }
  if (bt === "publicar") loadChecklist();
}

[].forEach.call(document.querySelectorAll("#bot-tabs button"), function (b) {
  b.onclick = function () { setBotTab(b.dataset.bt); };
});

function checkRow(ok, label, hint, go) {
  var row = document.createElement("div");
  row.className = "chk" + (ok ? " done" : "");
  var ic = document.createElement("span");
  ic.className = "chk-ic";
  ic.textContent = ok ? "✓" : "○";
  var body = document.createElement("div");
  var l1 = document.createElement("div");
  l1.textContent = label;
  l1.style.fontWeight = "600";
  body.appendChild(l1);
  if (!ok && hint) {
    var l2 = document.createElement("div");
    l2.className = "meta";
    l2.textContent = hint;
    body.appendChild(l2);
  }
  row.appendChild(ic);
  row.appendChild(body);
  if (!ok && go) {
    var b = document.createElement("button");
    b.className = "ghost small";
    b.textContent = "Resolver";
    b.onclick = go;
    row.appendChild(b);
  }
  return row;
}

function loadChecklist() {
  var box = $("check-list");
  var f = findTenant(sel.id);
  if (!f) { box.textContent = ""; return; }
  var t = f.tenant;
  var c = f.client;
  box.className = "";
  box.innerHTML = "";
  var dom = (t.allowed_domains || [])[0] || "";
  box.appendChild(checkRow(!!(t.system_prompt || "").trim(), "Cerebro configurado",
    "El bot no tiene instrucciones. Ve a Cerebro y usa el asistente de IA.",
    function () { setBotTab("cerebro"); }));
  box.appendChild(checkRow(!!dom, "Dominio del cliente añadido",
    "Sin dominio no funcionan ni el widget ni la demo. Cerebro → Seguridad y límites.",
    function () { setBotTab("cerebro"); ftShow("ft-seg"); }));
  var rowDocs = checkRow(DOCS_COUNT > 0, "Contenido indexado",
    "El bot no tiene conocimiento: sube documentos o responde el FAQ en Contenido.",
    function () { setBotTab("contenido"); });
  box.appendChild(rowDocs);
  box.appendChild(checkRow(!!c.portal_password_hash, "Acceso del cliente creado",
    "Genera su contraseña del portal en la ficha del cliente.",
    function () { selClient(c.id); }));
  var rowLive = checkRow(false, "Widget instalado en la web del cliente",
    "Comprobando si hay conversaciones reales…", null);
  box.appendChild(rowLive);
  if (!t.panel_token) {
    rowLive.querySelector(".meta").textContent = "Aún sin comprobar: guarda el chatbot primero.";
    return;
  }
  fetch("/panel/data?token=" + encodeURIComponent(t.panel_token))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var convs = (d && d.conversations) || [];
      var live = convs.some(function (cv) {
        var u = cv.page_url || "";
        return dom && u.indexOf(dom) >= 0 && u.indexOf("/demo") < 0 && u.indexOf(location.host) < 0;
      });
      var any = convs.length > 0;
      var fresh = checkRow(live, "Widget instalado en la web del cliente",
        any ? "Hay conversaciones de prueba, pero ninguna desde " + (dom || "la web del cliente") +
              ". Copia el snippet de la pestaña Publicar y pégalo en su web."
            : "Todavía no hay ninguna conversación. Prueba el bot en la demo y luego instala el snippet.",
        null);
      rowLive.parentNode.replaceChild(fresh, rowLive);
    })
    .catch(function () {
      rowLive.querySelector(".meta").textContent = "No se ha podido comprobar ahora mismo.";
    });
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
  api("/admin/api/tenants/" + sel.id + "/faq-form", {
    method: "POST",
    body: JSON.stringify({ brief: $("faq-brief").value.trim() }),
  }).then(function (r) {
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

// ----- iconos elegibles del widget -----

var BTN_ICONS = {
  burbuja: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/>',
  puntos: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/><path stroke-width="2.4" d="M8.6 11.5h.01M12 11.5h.01M15.4 11.5h.01"/>',
  auricular: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
  interrogacion: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path stroke-width="2.4" d="M12 17h.01"/>',
  rayo: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  robot: '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 8V5"/><circle cx="12" cy="3.5" r="1.2"/><path stroke-width="2.4" d="M9 12.8h.01M15 12.8h.01"/><path d="M9.5 16h5"/>',
};
var SEND_ICONS = {
  flecha: '<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>',
  avion: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  play: '<path d="M6 4l14 8-14 8V4z"/>',
};
var iconBtnSel = "burbuja";
var iconSendSel = "";

function svgIcon(path) {
  return '<svg viewBox="0 0 24 24">' + path + "</svg>";
}

function buildPick(elId, map, selected, allowText, cb) {
  var box = $(elId);
  box.innerHTML = "";
  if (allowText) {
    var tb = document.createElement("button");
    tb.type = "button";
    tb.textContent = "Abc";
    if (selected === "") tb.classList.add("on");
    tb.onclick = function () { cb(""); };
    box.appendChild(tb);
  }
  Object.keys(map).forEach(function (k) {
    var b = document.createElement("button");
    b.type = "button";
    b.title = k;
    b.innerHTML = svgIcon(map[k]);
    if (selected === k) b.classList.add("on");
    b.onclick = function () { cb(k); };
    box.appendChild(b);
  });
}

function renderIconPicks() {
  buildPick("pick-btn", BTN_ICONS, iconBtnSel, false, function (k) {
    iconBtnSel = k;
    markDirty();
    renderIconPicks();
    updPrev();
  });
  buildPick("pick-send", SEND_ICONS, iconSendSel, true, function (k) {
    iconSendSel = k;
    markDirty();
    renderIconPicks();
    updPrev();
  });
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

var cvDark = false;
var bgMode = "solid";
var gradStyle = 0;
var GRADS = [
  function (a, b) { return "linear-gradient(135deg," + a + "," + b + ")"; },
  function (a, b) { return "linear-gradient(180deg," + a + "," + b + ")"; },
  function (a, b) { return "linear-gradient(90deg," + a + "," + b + ")"; },
  function (a, b) { return "radial-gradient(circle at 30% 25%," + a + "," + b + ")"; },
  function (a, b) { return "linear-gradient(135deg," + a + " 0%," + a + " 45%," + b + " 100%)"; },
];

function buildGrad() { return GRADS[gradStyle]($("g-c1").value, $("g-c2").value); }

function bgValue() {
  if (bgMode === "grad") return buildGrad();
  if (bgMode === "img") return $("f-bgimg").value.trim();
  return "";
}

function renderGradStyles() {
  var box = $("g-styles");
  box.innerHTML = "";
  GRADS.forEach(function (g, i) {
    var b = document.createElement("button");
    b.type = "button";
    b.style.background = g($("g-c1").value, $("g-c2").value);
    if (i === gradStyle) b.classList.add("on");
    b.onclick = function () { gradStyle = i; markDirty(); renderGradStyles(); updPrev(); };
    box.appendChild(b);
  });
}

function setBgMode(m) {
  bgMode = m;
  [].forEach.call(document.querySelectorAll("#bg-seg button"), function (x) {
    x.classList.toggle("on", x.dataset.m === m);
  });
  $("bg-solid").classList.toggle("hide", m !== "solid");
  $("bg-grad").classList.toggle("hide", m !== "grad");
  $("bg-img").classList.toggle("hide", m !== "img");
  if (m === "grad") renderGradStyles();
  updPrev();
}
[].forEach.call(document.querySelectorAll("#bg-seg button"), function (b) {
  b.onclick = function () { markDirty(); setBgMode(b.dataset.m); };
});

$("cv-dark").onclick = function () {
  cvDark = !cvDark;
  $("cv-dark").textContent = cvDark ? "☀️ Claro" : "🌙 Oscuro";
  updPrev();
};

// ----- chat real dentro del canvas -----

var CV_SESSION = "";
var CV_HISTORY = [];
var CV_BUSY = false;

function cvResetChat() {
  CV_SESSION = "adm_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  CV_HISTORY = [];
  CV_BUSY = false;
  [].forEach.call(document.querySelectorAll("#cv-log .cv-dyn"), function (x) { x.remove(); });
  $("cv-user").classList.remove("hide");
  $("cv-reply").classList.remove("hide");
  $("cv-in").value = "";
}

function cvBubble(cls, text) {
  var d = document.createElement("div");
  d.className = cls + " cv-dyn";
  d.textContent = text;
  $("cv-log").insertBefore(d, $("cv-sug"));
  $("cv-log").scrollTop = $("cv-log").scrollHeight;
  return d;
}

function cvSend(text) {
  var q = (text || $("cv-in").value).trim();
  if (!q || CV_BUSY) return;
  var t = curTenant();
  if (!t) { toast("Guarda primero el chatbot para poder chatear con él.", true); return; }
  var key = activeKey(t);
  if (!key) { toast("Este chatbot no tiene una clave activa.", true); return; }
  $("cv-user").classList.add("hide");
  $("cv-reply").classList.add("hide");
  $("cv-in").value = "";
  CV_BUSY = true;
  cvBubble("cv-m", q);
  updPrev();
  var typing = cvBubble("cv-b cv-typing", "Escribiendo…");
  fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: key,
      session_id: CV_SESSION,
      message: q,
      page_url: "expobot-admin-preview",
      history: CV_HISTORY,
    }),
  }).then(function (r) { return r.json(); }).then(function (r) {
    CV_BUSY = false;
    typing.classList.remove("cv-typing");
    typing.textContent = r.reply || r.error || "(sin respuesta)";
    CV_HISTORY.push({ role: "user", content: q });
    CV_HISTORY.push({ role: "assistant", content: typing.textContent });
    CV_HISTORY = CV_HISTORY.slice(-12);
    updPrev();
    $("cv-log").scrollTop = $("cv-log").scrollHeight;
  }).catch(function () {
    CV_BUSY = false;
    typing.classList.remove("cv-typing");
    typing.textContent = "Error al conectar. Prueba otra vez.";
  });
}

$("cv-send").onclick = function () { cvSend(); };
$("cv-in").addEventListener("keydown", function (e) { if (e.key === "Enter") cvSend(); });

var slugTouched = false;
$("f-slug").addEventListener("input", function () { slugTouched = true; });
$("f-name").addEventListener("input", function () {
  if (sel.type === "tenant" && sel.isNew && !slugTouched) {
    $("f-slug").value = $("f-name").value.trim().toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
});

function updPrev() {
  var c = $("f-color").value || "#111111";
  var t = contrastFor(c);
  var c2 = cvDark ? "#2a2a2e" : ($("f-color2").value || "#f2f2f0");
  var c2t = cvDark ? "#ececec" : contrastFor(c2);
  var cbg = cvDark ? "#17171a" : ($("f-colorbg").value || "#ffffff");
  var name = $("f-name").value.trim() || "Asistente";
  var rad = parseInt($("f-radius").value, 10) || 0;
  var sh = $("f-shadow").value;
  var font = $("f-font").value;
  loadFont(font);
  $("f-radius-v").textContent = rad;

  var w = $("cv-widget");
  w.style.fontFamily = fontStack(font);
  w.style.background = cbg;
  w.style.borderRadius = Math.min(rad + 4, 28) + "px";
  w.style.boxShadow = sh === "ninguna" ? "none" :
    sh === "fuerte" ? "0 18px 60px rgba(0,0,0,.4)" : "0 12px 40px rgba(20,20,60,.18)";

  $("cv-h").style.background = c;
  $("cv-h").style.color = t;
  var logo = $("f-logo").value.trim();
  var av = $("cv-av");
  if (logo) {
    av.innerHTML = '<img src="' + logo.replace(/"/g, "") + '" alt="">';
  } else {
    av.textContent = name.charAt(0).toUpperCase();
  }
  $("cv-name").textContent = name;
  $("cv-sub").textContent = $("f-subtitle").value.trim() || "Suele responder al instante";

  var bg = bgValue();
  $("cv-log").style.background = bg
    ? (bg.indexOf("gradient") >= 0 ? bg : 'url("' + bg.replace(/"/g, "") + '") center/cover')
    : "transparent";

  [].forEach.call(document.querySelectorAll(".cv-b"), function (b) {
    b.style.background = c2;
    b.style.color = c2t;
    b.style.borderRadius = rad + "px";
    b.style.borderBottomLeftRadius = "4px";
  });
  $("cv-welcome").textContent = $("f-welcome").value.trim() || "¡Hola! ¿En qué puedo ayudarte?";
  [].forEach.call(document.querySelectorAll(".cv-m"), function (um) {
    um.style.background = c;
    um.style.color = t;
    um.style.borderRadius = rad + "px";
    um.style.borderBottomRightRadius = "4px";
  });

  var sug = $("cv-sug");
  sug.innerHTML = "";
  lines($("f-sugg").value).slice(0, 2).forEach(function (q) {
    var s = document.createElement("span");
    s.textContent = q;
    s.onclick = function () { cvSend(q); };
    if (cvDark) {
      s.style.background = "#232327";
      s.style.color = "#ddd";
      s.style.borderColor = "#3a3a40";
    }
    sug.appendChild(s);
  });

  $("cv-foot").style.borderTopColor = cvDark ? "#333" : "#eee";
  var inp = $("cv-in");
  inp.placeholder = $("f-tplaceholder").value.trim() || "Escribe tu pregunta…";
  inp.style.background = cvDark ? "#232327" : "#fff";
  inp.style.color = cvDark ? "#eee" : "#333";
  inp.style.borderColor = cvDark ? "#3a3a40" : "#ddd";
  inp.style.borderRadius = Math.round(rad * 0.72 + 4) + "px";

  var snd = $("cv-send");
  snd.style.background = c;
  snd.style.color = t;
  snd.style.borderRadius = Math.round(rad * 0.72 + 4) + "px";
  if (SEND_ICONS[iconSendSel]) {
    snd.innerHTML = '<svg viewBox="0 0 24 24" style="width:17px;height:17px;fill:none;stroke:' + t +
      ';stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round">' + SEND_ICONS[iconSendSel] + "</svg>";
  } else {
    snd.textContent = $("f-tsend").value.trim() || "→";
    snd.style.fontSize = "14px";
  }

  var brand = $("f-brand").value.trim();
  $("cv-brand").classList.toggle("hide", !brand);
  $("cv-brand").textContent = brand ? "Impulsado por " + brand : "";
  $("cv-brand").style.background = cbg;
  $("cv-brand").style.color = cvDark ? "#777" : "#999";

  var shape = $("f-btnshape").value;
  var pb = $("cv-btn");
  pb.style.background = c;
  pb.style.borderRadius = shape === "redondeado" ? Math.min(rad + 4, 18) + "px" : "26px";
  pb.innerHTML = '<svg viewBox="0 0 24 24" style="width:22px;height:22px;fill:none;stroke:' + t +
    ';stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round">' +
    (BTN_ICONS[iconBtnSel] || BTN_ICONS.burbuja) + "</svg>";
  if (shape === "pastilla") {
    var lbl = document.createElement("span");
    lbl.textContent = $("f-btnlabel").value.trim() || "Chat";
    lbl.style.cssText = "color:" + t + ";font:600 14px system-ui,sans-serif";
    pb.appendChild(lbl);
  }
  syncSwatches();
}
["f-color", "f-color2", "f-colorbg", "f-radius", "f-subtitle", "f-name", "f-welcome", "f-btnlabel",
 "f-tplaceholder", "f-tsend", "f-brand", "f-sugg", "f-logo", "f-bgimg"].forEach(function (id) {
  $(id).oninput = updPrev;
});
["f-font", "f-shadow", "f-btnshape"].forEach(function (id) {
  $(id).onchange = updPrev;
});
["g-c1", "g-c2"].forEach(function (id) {
  $(id).oninput = function () { renderGradStyles(); updPrev(); };
});


// ----- asistente de diseño -----

$("ds-run").onclick = function () {
  var t = curTenant();
  if (!t && !sel.isNew) return;
  if (sel.isNew) {
    $("ds-msg").textContent = "Guarda primero el chatbot para poder analizar su web.";
    $("ds-msg").className = "err";
    return;
  }
  $("ds-msg").textContent = "Analizando la web del cliente y generando propuestas… hasta 30 segundos.";
  $("ds-msg").className = "mut";
  $("ds-options").innerHTML = "";
  api("/admin/api/tenants/" + sel.id + "/design-assist", {
    method: "POST",
    body: JSON.stringify({ brief: $("ds-brief").value.trim() }),
  }).then(function (r) {
    if (r.error) { $("ds-msg").textContent = r.error; $("ds-msg").className = "err"; return; }
    $("ds-msg").textContent = (r.analyzed ? "Web analizada: " + r.analyzed + ". " : "") +
      "Elige una propuesta y retócala abajo antes de guardar.";
    $("ds-msg").className = "ok";
    renderDesigns(r.options || []);
  }).catch(function () { $("ds-msg").textContent = "Error al generar."; $("ds-msg").className = "err"; });
};

function renderDesigns(opts) {
  var box = $("ds-options");
  box.innerHTML = "";
  opts.forEach(function (o) {
    loadFont(o.theme.font);
    var card = document.createElement("div");
    card.className = "dsopt";
    card.style.background = o.theme.bg_color;
    if (o.theme.bg_image) card.style.backgroundImage = o.theme.bg_image;
    card.style.fontFamily = fontStack(o.theme.font);
    var head = document.createElement("div");
    head.className = "dshead";
    head.style.background = o.primary_color;
    head.style.color = contrastFor(o.primary_color);
    head.style.borderRadius = o.theme.radius + "px";
    head.textContent = $("f-name").value.trim() || "Asistente";
    var b1 = document.createElement("div");
    b1.className = "dsbub";
    b1.style.background = o.theme.secondary_color;
    b1.style.color = contrastFor(o.theme.secondary_color);
    b1.style.borderRadius = o.theme.radius + "px";
    b1.textContent = "¡Hola! ¿En qué te ayudo?";
    var b2 = document.createElement("div");
    b2.className = "dsbub dsmine";
    b2.style.background = o.primary_color;
    b2.style.color = contrastFor(o.primary_color);
    b2.style.borderRadius = o.theme.radius + "px";
    b2.textContent = "Tengo una duda";
    var nm = document.createElement("div");
    nm.className = "dsname";
    nm.style.color = contrastFor(o.theme.bg_color);
    nm.textContent = o.name;
    var why = document.createElement("div");
    why.className = "dswhy";
    why.style.color = contrastFor(o.theme.bg_color);
    why.textContent = o.why;
    var use = document.createElement("button");
    use.className = "primary small";
    use.textContent = "Usar este diseño";
    use.onclick = function () { applyDesign(o); };
    card.appendChild(head);
    card.appendChild(b1);
    card.appendChild(b2);
    card.appendChild(nm);
    card.appendChild(why);
    card.appendChild(use);
    box.appendChild(card);
  });
}

function applyDesign(o) {
  $("f-color").value = o.primary_color;
  $("f-color2").value = o.theme.secondary_color;
  $("f-colorbg").value = o.theme.bg_color;
  $("f-font").value = o.theme.font;
  $("f-radius").value = o.theme.radius;
  $("f-shadow").value = o.theme.shadow;
  if (o.theme.subtitle) $("f-subtitle").value = o.theme.subtitle;
  if (o.theme.bg_image) {
    var gcols = o.theme.bg_image.match(/#[0-9a-fA-F]{6}/g) || [];
    if (gcols[0]) $("g-c1").value = gcols[0];
    if (gcols.length > 1) $("g-c2").value = gcols[gcols.length - 1];
    gradStyle = 0;
    setBgMode("grad");
  } else {
    setBgMode("solid");
  }
  $("f-dark").value = o.theme.dark || "off";
  markDirty();
  updPrev();
  toast("Diseño aplicado: revísalo en la vista previa y pulsa Guardar.");
}

var DOCS_COUNT = 0;
function loadDocs() {
  var box = $("doc-list");
  box.textContent = "Cargando…";
  api("/admin/api/tenants/" + sel.id + "/documents").then(function (docs) {
    if (docs.error) { box.textContent = docs.error; return; }
    DOCS_COUNT = docs.length;
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
    features: { leads: $("f-featleads").checked },
    panel_enabled: $("f-panelon").checked,
    panel_features: {
      leads: $("f-pfleads").checked,
      convs: $("f-pfconvs").checked,
      gaps: $("f-pfgaps").checked,
      uploads: $("f-pfuploads").checked,
      test: $("f-pftest").checked,
    },
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
      size: $("f-size").value,
      dark: $("f-dark").value,
      bg_image: bgValue(),
      t_placeholder: $("f-tplaceholder").value.trim(),
      t_send: $("f-tsend").value.trim(),
      t_error: $("f-terror").value.trim(),
      t_teaser: $("f-tteaser").value.trim(),
      brand_name: $("f-brand").value.trim(),
      brand_url: $("f-brandurl").value.trim(),
      sound: $("f-sound").checked,
      custom_css: $("f-css").value.slice(0, 5000),
      icon_btn: iconBtnSel,
      icon_send: iconSendSel,
      btn_shape: $("f-btnshape").value,
      btn_label: $("f-btnlabel").value.trim(),
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
    dirty = false;
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
    dirty = false;
    toast("Chatbot eliminado");
    load();
  });
};

$("f-dup").onclick = function () {
  if (sel.isNew) return;
  var f = findTenant(sel.id);
  if (!confirm("Se creará una copia de «" + (f ? f.tenant.name : "este chatbot") +
    "» en el mismo proyecto, apagada y con claves nuevas. Se copia la configuración y el diseño, " +
    "no el contenido indexado ni las conversaciones. ¿Duplicar?")) return;
  api("/admin/api/tenants/" + sel.id + "/duplicate", { method: "POST" }).then(function (r) {
    if (r.error) { toast(r.error, true); return; }
    dirty = false;
    sel = { type: "tenant", id: r.id, isNew: false };
    toast("Chatbot duplicado ✓ Estás viendo la copia.");
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

$("rep-send").onclick = function () {
  if (!curTenant()) return;
  var f = findTenant(sel.id);
  var def = (f && f.client && f.client.email) || "";
  var to = prompt(
    "¿A qué email envío el informe de actividad del mes pasado?\\n" +
    "Por defecto va al del cliente; cámbialo por el tuyo si es una prueba.",
    def
  );
  if (to === null) return;
  to = to.trim();
  if (!to) { toast("Escribe un email de destino.", true); return; }
  $("integ-msg").textContent = "Enviando informe…";
  api("/admin/api/tenants/" + sel.id + "/send-report", { method: "POST", body: JSON.stringify({ to: to }) })
    .then(function (r) {
      $("integ-msg").textContent = r.ok ? "Informe enviado a " + (r.sent_to || to) + " ✓" : (r.reason || r.error || "No se pudo enviar");
      if (r.ok) toast("Informe enviado ✓");
    })
    .catch(function () { $("integ-msg").textContent = "Error al enviar."; });
};

// ----- examen del bot -----

$("ex-run").onclick = function () {
  if (!curTenant()) return;
  $("ex-msg").textContent = "Examinando… genera preguntas, las lanza al motor real y evalúa (≈1 min).";
  $("ex-msg").className = "mut";
  $("ex-score").textContent = "";
  $("ex-list").innerHTML = "";
  api("/admin/api/tenants/" + sel.id + "/exam", { method: "POST", body: "{}" })
    .then(function (r) {
      if (r.error) { $("ex-msg").textContent = r.error; $("ex-msg").className = "err"; return; }
      $("ex-msg").textContent = "";
      var passed = r.items.filter(function (x) { return x.ok; }).length;
      $("ex-score").textContent =
        (r.score != null ? "Nota: " + r.score + "/10 · " : "") +
        passed + " de " + r.items.length + " respuestas correctas" +
        (r.summary ? " — " + r.summary : "");
      $("ex-score").style.color = passed === r.items.length ? "var(--ok)" : passed >= r.items.length - 1 ? "#a15c00" : "var(--err)";
      r.items.forEach(function (x) {
        var d = document.createElement("div");
        d.className = "doc";
        d.style.display = "block";
        var q = document.createElement("div");
        q.textContent = (x.ok ? "✓ " : "✗ ") + x.q;
        q.style.fontWeight = "600";
        q.style.color = x.ok ? "var(--ok)" : "var(--err)";
        var a = document.createElement("div");
        a.className = "meta";
        a.textContent = "Respondió: " + x.a.slice(0, 220) + (x.a.length > 220 ? "…" : "");
        var w = document.createElement("div");
        w.className = "meta";
        w.textContent = x.why;
        d.appendChild(q); d.appendChild(a); if (x.why) d.appendChild(w);
        $("ex-list").appendChild(d);
      });
    })
    .catch(function () { $("ex-msg").textContent = "Error durante el examen."; $("ex-msg").className = "err"; });
};

// ----- huecos de conocimiento -----

var GAP_ROWS = [];

$("gap-run").onclick = function () {
  if (!curTenant()) return;
  $("gap-msg").textContent = "Buscando preguntas sin respuesta y redactando borradores…";
  $("gap-msg").className = "mut";
  $("gap-list").innerHTML = "";
  GAP_ROWS = [];
  $("gap-approve-row").classList.add("hide");
  api("/admin/api/tenants/" + sel.id + "/gap-suggest", { method: "POST", body: "{}" })
    .then(function (r) {
      if (r.error) { $("gap-msg").textContent = r.error; $("gap-msg").className = "err"; return; }
      if (!r.suggestions.length) {
        $("gap-msg").textContent = "No hay preguntas sin respuesta en los últimos 60 días. 🎉";
        $("gap-msg").className = "ok";
        return;
      }
      $("gap-msg").textContent = "Revisa los borradores, completa los [corchetes] y aprueba.";
      $("gap-msg").className = "ok";
      r.suggestions.forEach(function (s) {
        var box = document.createElement("div");
        box.className = "doc";
        box.style.display = "block";
        var top = document.createElement("div");
        top.style.display = "flex";
        top.style.gap = "8px";
        top.style.alignItems = "center";
        var chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = true;
        chk.style.width = "auto";
        var q = document.createElement("div");
        q.textContent = s.q;
        q.style.fontWeight = "600";
        top.appendChild(chk); top.appendChild(q);
        var ta = document.createElement("textarea");
        ta.rows = 3;
        ta.value = s.draft || "";
        ta.style.marginTop = "8px";
        box.appendChild(top); box.appendChild(ta);
        $("gap-list").appendChild(box);
        GAP_ROWS.push({ q: s.q, chk: chk, ta: ta });
      });
      $("gap-approve-row").classList.remove("hide");
    })
    .catch(function () { $("gap-msg").textContent = "Error al analizar."; $("gap-msg").className = "err"; });
};

$("gap-approve").onclick = function () {
  var t = curTenant();
  if (!t) return;
  var chosen = GAP_ROWS.filter(function (r) { return r.chk.checked && r.ta.value.trim(); });
  if (!chosen.length) { $("gap-msg").textContent = "Marca al menos una con respuesta."; $("gap-msg").className = "err"; return; }
  var pend = chosen.filter(function (r) { return r.ta.value.indexOf("[") >= 0; });
  if (pend.length && !confirm("Hay " + pend.length + " respuesta(s) con [datos por completar]. ¿Indexarlas igualmente?")) return;
  var content = chosen.map(function (r) { return "Pregunta: " + r.q + "\\nRespuesta: " + r.ta.value.trim(); }).join("\\n\\n");
  var title = "Huecos aprobados — " + new Date().toLocaleDateString("es-ES");
  $("gap-msg").textContent = "Indexando…"; $("gap-msg").className = "mut";
  api("/admin/ingest", {
    method: "POST",
    body: JSON.stringify({ slug: t.slug, texts: [{ title: title, content: content }] }),
  }).then(function (r) {
    if (r.error) { $("gap-msg").textContent = r.error; $("gap-msg").className = "err"; return; }
    $("gap-msg").textContent = "Indexadas ✓ El bot ya sabe responderlas.";
    $("gap-msg").className = "ok";
    toast("Contenido aprobado e indexado ✓");
    $("gap-list").innerHTML = "";
    $("gap-approve-row").classList.add("hide");
    GAP_ROWS = [];
    loadDocs();
  }).catch(function () { $("gap-msg").textContent = "Error al indexar."; $("gap-msg").className = "err"; });
};

// ----- guía de integración -----

var IG_LAST = null;

$("ig-run").onclick = function () {
  if (!curTenant()) return;
  $("ig-msg").textContent = "Analizando la web del cliente…";
  $("ig-msg").className = "mut";
  api("/admin/api/tenants/" + sel.id + "/integration-guide").then(function (r) {
    if (r.error) { $("ig-msg").textContent = r.error; $("ig-msg").className = "err"; return; }
    IG_LAST = r;
    $("ig-msg").textContent = "";
    $("ig-box").classList.remove("hide");
    $("ig-title").textContent = "Plataforma detectada: " + r.platform + (r.domain ? " — " + r.domain : "");
    var ol = $("ig-steps");
    ol.innerHTML = "";
    (r.steps || []).forEach(function (st) {
      var li = document.createElement("li");
      li.textContent = st;
      ol.appendChild(li);
    });
    $("ig-note").textContent = r.note || "";
    var k = activeKey(curTenant());
    $("ig-url").value = location.origin + "/instrucciones?key=" + k + "&p=" + r.key;
  }).catch(function () { $("ig-msg").textContent = "Error al analizar."; $("ig-msg").className = "err"; });
};

$("ig-url-open").onclick = function () { window.open($("ig-url").value, "_blank"); };
$("ig-pdf").onclick = function () {
  if (!IG_LAST) return;
  var k = activeKey(curTenant());
  window.open(location.origin + "/instrucciones.pdf?key=" + k + "&p=" + IG_LAST.key, "_blank");
};

$("ig-copy").onclick = function () {
  if (!IG_LAST) return;
  var txt = "Instrucciones para integrar el asistente virtual en la web (" + IG_LAST.platform + "):\\n\\n" +
    (IG_LAST.steps || []).map(function (st, i) { return (i + 1) + ". " + st; }).join("\\n") +
    (IG_LAST.note ? "\\n\\nNota: " + IG_LAST.note : "") +
    "\\n\\nEste es el código a pegar:\\n\\n" + $("i-snippet").value + "\\n";
  navigator.clipboard.writeText(txt).then(function () { toast("Instrucciones copiadas ✓"); });
};

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

// ----- selector de color estilo Canva -----

var CP = { input: null, btn: null, h: 0, s: 1, v: 1 };
var CP_BTNS = [];

function hexToHsv(hex) {
  var m = /^#?([0-9a-fA-F]{6})$/.exec(hex || "");
  if (!m) return { h: 0, s: 0, v: 0 };
  var n = parseInt(m[1], 16);
  var r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, hh = 0;
  if (d) {
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  return { h: hh, s: mx ? d / mx : 0, v: mx };
}

function hsvToHex(hh, s, v) {
  var c = v * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - c;
  var r = 0, g = 0, b = 0;
  if (hh < 60) { r = c; g = x; } else if (hh < 120) { r = x; g = c; }
  else if (hh < 180) { g = c; b = x; } else if (hh < 240) { g = x; b = c; }
  else if (hh < 300) { r = x; b = c; } else { r = c; b = x; }
  function q(u) { return ("0" + Math.round((u + m) * 255).toString(16)).slice(-2); }
  return "#" + q(r) + q(g) + q(b);
}

function cpRender(updateHexField) {
  var hex = hsvToHex(CP.h, CP.s, CP.v);
  $("cp-sv").style.background =
    "linear-gradient(to top,#000,rgba(0,0,0,0)),linear-gradient(to right,#fff," + hsvToHex(CP.h, 1, 1) + ")";
  $("cp-svc").style.left = (CP.s * 100) + "%";
  $("cp-svc").style.top = ((1 - CP.v) * 100) + "%";
  $("cp-svc").style.background = hex;
  $("cp-huec").style.left = ((CP.h / 360) * 100) + "%";
  $("cp-swatch").style.background = hex;
  if (updateHexField !== false) $("cp-hex").value = hex.toUpperCase();
  if (CP.input) {
    CP.input.value = hex;
    CP.input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (CP.btn) CP.btn.style.background = hex;
}

function cpDrag(el, fn) {
  el.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    fn(e);
    function mv(ev) { fn(ev); }
    function up() {
      document.removeEventListener("pointermove", mv);
      document.removeEventListener("pointerup", up);
    }
    document.addEventListener("pointermove", mv);
    document.addEventListener("pointerup", up);
  });
}

cpDrag($("cp-sv"), function (e) {
  var r = $("cp-sv").getBoundingClientRect();
  CP.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  CP.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  cpRender();
});

cpDrag($("cp-hue"), function (e) {
  var r = $("cp-hue").getBoundingClientRect();
  CP.h = Math.min(359.9, Math.max(0, ((e.clientX - r.left) / r.width) * 360));
  cpRender();
});

$("cp-hex").oninput = function () {
  var m = /^#?([0-9a-fA-F]{6})$/.exec(this.value.trim());
  if (!m) return;
  var hsv = hexToHsv("#" + m[1]);
  CP.h = hsv.h; CP.s = hsv.s; CP.v = hsv.v;
  cpRender(false);
};

if (window.EyeDropper) {
  $("cp-eye").onclick = function () {
    new window.EyeDropper().open().then(function (res) {
      var hsv = hexToHsv(res.sRGBHex);
      CP.h = hsv.h; CP.s = hsv.s; CP.v = hsv.v;
      cpRender();
    }).catch(function () {});
  };
} else {
  $("cp-eye").style.display = "none";
}

function openCP(input, btn) {
  CP.input = input;
  CP.btn = btn;
  var hsv = hexToHsv(input.value);
  CP.h = hsv.h; CP.s = hsv.s; CP.v = hsv.v;
  var cp = $("cp");
  cp.classList.remove("hide");
  var r = btn.getBoundingClientRect();
  var left = r.left + window.scrollX;
  var maxLeft = window.scrollX + document.documentElement.clientWidth - 268;
  cp.style.left = Math.min(left, maxLeft) + "px";
  cp.style.top = (r.bottom + window.scrollY + 8) + "px";
  cpRender();
}

document.addEventListener("pointerdown", function (e) {
  var cp = $("cp");
  if (cp.classList.contains("hide")) return;
  if (cp.contains(e.target)) return;
  if (CP.btn && CP.btn.contains(e.target)) return;
  cp.classList.add("hide");
  CP.input = null;
  CP.btn = null;
});

function initColorPickers() {
  ["f-color", "f-color2", "f-colorbg", "g-c1", "g-c2"].forEach(function (id) {
    var input = $(id);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cp-btn" + (id === "g-c1" || id === "g-c2" ? " mini" : "");
    btn.style.background = input.value;
    btn.setAttribute("aria-label", "Elegir color");
    btn.onclick = function () { openCP(input, btn); };
    input.style.display = "none";
    input.parentNode.insertBefore(btn, input.nextSibling);
    CP_BTNS.push({ input: input, btn: btn });
  });
}

function syncSwatches() {
  CP_BTNS.forEach(function (p) { p.btn.style.background = p.input.value; });
}

initColorPickers();

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
<title>Portal de cliente — ExpoBot</title>
<style>
  :root{--ink:#10182b;--mut:#6b7590;--line:#e4e7f0;--bg:#f5f7fc;--err:#b3261e;--ok:#0a7a4b;
    --acc:#3c62f0;--grad:linear-gradient(135deg,#3c62f0,#6b8cff)}
  *{box-sizing:border-box;margin:0}
  body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
  .hide{display:none!important}
  button{font:inherit;cursor:pointer}
  input,select{font:inherit;width:100%;border:1px solid var(--line);border-radius:10px;
    padding:10px 12px;background:#fff;color:var(--ink)}
  input:focus,select:focus{outline:0;border-color:var(--acc)}
  label{display:block;font-size:13px;color:var(--mut);margin:14px 0 4px}
  .btn{background:var(--grad);color:#fff;border:0;border-radius:10px;padding:11px 20px;font-weight:600}
  .brand{display:flex;align-items:center;gap:8px;font-weight:800;font-size:18px;letter-spacing:-.02em}
  .brand svg{width:30px;height:27px;flex:0 0 auto}
  .brand b{color:var(--acc);font-weight:800}
  .brand svg.bub{width:.82em;height:.6em;display:inline;vertical-align:-2%;margin:0 .5px}
  footer{text-align:center;color:var(--mut);font-size:12.5px;padding:10px 0 26px}
  footer b{color:var(--acc)}
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
    <div class="brand" style="margin-bottom:14px"><svg viewBox="0 0 64 58"><g fill="none" stroke="#3c62f0" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 14V8"/><path d="M22 14h20c9.4 0 17 7.2 17 16s-7.6 16-17 16H26l-11 8V43.5C9.3 41 6 35.9 6 30c0-8.8 7.6-16 16-16z"/></g><circle cx="32" cy="6" r="4.2" fill="#3c62f0"/><circle cx="25" cy="30" r="4.2" fill="#3c62f0"/><circle cx="39" cy="30" r="4.2" fill="#3c62f0"/></svg><span>Expo<b>B<svg class="bub" viewBox="0 12 64 46"><path d="M22 14h20c9.4 0 17 7.2 17 16s-7.6 16-17 16H26l-11 8V43.5C9.3 41 6 35.9 6 30c0-8.8 7.6-16 16-16z" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linejoin="round" stroke-linecap="round"/></svg>t</b></span></div>
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
    <div style="display:flex;align-items:center;gap:14px">
      <div class="brand"><svg viewBox="0 0 64 58"><g fill="none" stroke="#3c62f0" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 14V8"/><path d="M22 14h20c9.4 0 17 7.2 17 16s-7.6 16-17 16H26l-11 8V43.5C9.3 41 6 35.9 6 30c0-8.8 7.6-16 16-16z"/></g><circle cx="32" cy="6" r="4.2" fill="#3c62f0"/><circle cx="25" cy="30" r="4.2" fill="#3c62f0"/><circle cx="39" cy="30" r="4.2" fill="#3c62f0"/></svg><span>Expo<b>B<svg class="bub" viewBox="0 12 64 46"><path d="M22 14h20c9.4 0 17 7.2 17 16s-7.6 16-17 16H26l-11 8V43.5C9.3 41 6 35.9 6 30c0-8.8 7.6-16 16-16z" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linejoin="round" stroke-linecap="round"/></svg>t</b></span></div>
      <h1 id="c-name" style="font-weight:600;color:var(--mut);font-size:15px">Portal</h1>
    </div>
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
  <footer>Impulsado por <b>ExpoBot</b> — estudio de asistentes IA</footer>
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
          row.appendChild(left);
          if (t.panel_enabled !== false) {
            var open = document.createElement("button");
            open.className = "ghost small";
            open.textContent = "Abrir panel";
            open.onclick = function () {
              window.open("/panel?token=" + encodeURIComponent(t.panel_token), "_blank");
            };
            row.appendChild(open);
          }
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
  return t && t.active && t.panel_enabled !== false ? t : null;
}

const PANEL_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Panel del asistente — ExpoBot</title>
<style>
  :root{--ink:#10182b;--mut:#6b7590;--line:#e4e7f0;--bg:#f5f7fc;--acc:#3c62f0;
    --grad:linear-gradient(135deg,#3c62f0,#6b8cff)}
  *{box-sizing:border-box;margin:0}
  body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
  header{background:#fff;border-bottom:1px solid var(--line);padding:14px 24px;
    display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;letter-spacing:-.02em}
  .brand svg{width:28px;height:25px;flex:0 0 auto}
  .brand b{color:var(--acc);font-weight:800}
  .brand svg.bub{width:.82em;height:.6em;display:inline;vertical-align:-2%;margin:0 .5px}
  .brand-sep{width:1px;height:26px;background:var(--line)}
  h1{font-size:17px;font-weight:600}
  .sub{color:var(--mut);font-size:13px}
  main{max-width:960px;margin:0 auto;padding:24px 16px}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
  .stat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 18px;min-width:150px;flex:1}
  .stat b{display:block;font-size:24px}
  .stat span{color:var(--mut);font-size:13px}
  nav{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
  nav button{border:1px solid var(--line);background:#fff;border-radius:20px;padding:8px 16px;cursor:pointer;font-size:14px;color:var(--ink)}
  nav button.on{background:var(--grad);color:#fff;border-color:transparent}
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
  .m.assistant{background:#eef1f8}
  .box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px}
  .btn{background:var(--grad);color:#fff;border:0;border-radius:10px;padding:10px 16px;cursor:pointer;font:inherit;font-weight:600}
  .btn:disabled{opacity:.5;cursor:default}
  .ok{color:#0a7a4b;font-size:13px}
  .err{color:#b3261e;font-size:13px}
  #up-files{border:1px dashed var(--line);border-radius:10px;padding:16px;width:100%;background:#fff}
  #dot{display:inline-block;width:10px;height:10px;border-radius:5px;background:var(--acc);margin-right:8px}
  #chart{display:flex;align-items:flex-end;gap:3px;height:72px}
  #chart div{flex:1;background:#b9c8f2;border-radius:3px 3px 0 0;min-height:3px}
  footer{text-align:center;color:var(--mut);font-size:12.5px;padding:10px 0 26px}
  footer b{color:var(--acc)}
  .mini{background:#fff;border:1px solid var(--line);border-radius:8px;padding:5px 10px;
    font:13px system-ui,sans-serif;cursor:pointer;white-space:nowrap}
  .done{color:#0a7a4b;font-size:13px;white-space:nowrap}
  section{overflow-x:auto}
  section table{min-width:640px}
</style>
</head>
<body>
<header>
  <div class="brand"><svg viewBox="0 0 64 58"><g fill="none" stroke="#3c62f0" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 14V8"/><path d="M22 14h20c9.4 0 17 7.2 17 16s-7.6 16-17 16H26l-11 8V43.5C9.3 41 6 35.9 6 30c0-8.8 7.6-16 16-16z"/></g><circle cx="32" cy="6" r="4.2" fill="#3c62f0"/><circle cx="25" cy="30" r="4.2" fill="#3c62f0"/><circle cx="39" cy="30" r="4.2" fill="#3c62f0"/></svg><span>Expo<b>B<svg class="bub" viewBox="0 12 64 46"><path d="M22 14h20c9.4 0 17 7.2 17 16s-7.6 16-17 16H26l-11 8V43.5C9.3 41 6 35.9 6 30c0-8.8 7.6-16 16-16z" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linejoin="round" stroke-linecap="round"/></svg>t</b></span></div>
  <div class="brand-sep"></div>
  <div>
    <h1><span id="dot"></span><span id="name">Cargando…</span></h1>
    <div class="sub">Conversaciones, leads, contenido y pruebas de tu asistente</div>
  </div>
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
<footer>Impulsado por <b>ExpoBot</b> — estudio de asistentes IA</footer>
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
    var FEAT = d.features || {};
    var featTab = { leads: "t-leads", convs: "t-convs", gaps: "t-gaps", uploads: "t-add", test: "t-test" };
    var hiddenFirst = false;
    Object.keys(featTab).forEach(function (k) {
      if (FEAT[k] === false) {
        var sec = document.getElementById(featTab[k]);
        var btn = document.querySelector('nav button[data-tab="' + featTab[k] + '"]');
        if (sec) sec.remove();
        if (btn) { if (btn.classList.contains("on")) hiddenFirst = true; btn.remove(); }
      }
    });
    if (hiddenFirst) {
      var first = document.querySelector("nav button");
      if (first) first.onclick();
    }
    if (FEAT.test !== false && d.public_key) {
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
  async scheduled(event, env, ctx) {
    // día 1 de cada mes: informes automáticos a los clientes
    ctx.waitUntil(runMonthlyReports(env));
  },

  async fetch(request, env, ctx) {
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
          `<div style="position:fixed;top:0;left:0;right:0;z-index:2147482998;background:#111;color:#fff;` +
          `font:600 13px/1.4 system-ui,sans-serif;padding:9px 16px;text-align:center">` +
          `DEMOSTRACIÓN · Así se verá el asistente de ${h(tenant.name)} en su web · ` +
          `El chat funciona de verdad: pruébelo · Se activa en 5 minutos · Creado con ExpoBot</div>` +
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

        // límite por IP: 20 mensajes/minuto; el exceso recibe una respuesta fija
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (ip) {
          const okRate = await rpc(env, "check_rate", { p_ip: ip, p_limit: 20 });
          if (okRate === false) {
            return json(
              {
                reply: "Estás enviando mensajes muy deprisa. Espera un momento y vuelve a intentarlo 🙂",
                sources: [],
                rate_limited: true,
              },
              200,
              ch
            );
          }
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
        if (tenant.panel_features?.uploads === false) {
          return json({ error: "la subida de documentos está desactivada en este panel" }, 403);
        }
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
          `clients?email=ilike.${encodeURIComponent(email.trim())}&select=id,portal_password_hash,portal_enabled`
        );
        const c = rows?.[0];
        if (!c || !c.portal_password_hash || !(await verifyPassword(password, c.portal_password_hash))) {
          return json({ error: "email o contraseña incorrectos" }, 401);
        }
        if (c.portal_enabled === false) {
          return json({ error: "el acceso al portal está desactivado; contacta con nosotros" }, 403);
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
          `clients?id=eq.${cid}&select=name,email,payment_method,portal_enabled,projects(id,name,description,tenants(name,active,panel_token,panel_enabled))`
        );
        if (!client) return json({ error: "sesión caducada" }, 401);
        if (client.portal_enabled === false) return json({ error: "el acceso al portal está desactivado" }, 403);
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
          headers: storageHeaders(env),
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

      // --- instrucciones de integración: página pública y PDF ---
      if (url.pathname === "/instrucciones" || url.pathname === "/instrucciones.pdf") {
        const pk = url.searchParams.get("key") || "";
        const info = await guideFor(env, pk, url.searchParams.get("p"));
        if (!info) return new Response("Enlace no válido", { status: 401 });
        const snippetRaw =
          `<script src="${url.origin}/widget.js"\n` +
          `        data-key="${pk}"\n` +
          `        data-api="${url.origin}"></scr` + `ipt>`;
        const pageUrl = `${url.origin}/instrucciones?key=${pk}&p=${info.key}`;

        if (url.pathname === "/instrucciones.pdf") {
          const L = [];
          const add = (t, size, font, gap, x) =>
            wrapLine(t, font === 3 ? 78 : Math.round(950 / (size || 11))).forEach((w, i, arr) =>
              L.push({ t: w, size, font, x, gap: i === arr.length - 1 ? gap : 0 })
            );
          add("Integración del asistente virtual", 17, 2, 6);
          add(`${info.tenant.name}${info.domain ? " - " + info.domain : ""}`, 11, 1, 12);
          add(`Plataforma detectada: ${info.guide.name}`, 13, 2, 8);
          info.guide.steps.forEach((s, i) => add(`${i + 1}. ${s}`, 11, 1, 4));
          if (info.guide.note) add(`Nota: ${info.guide.note}`, 10, 1, 8);
          add("Código a pegar (justo antes de la etiqueta </body>):", 12, 2, 6);
          snippetRaw.split("\n").forEach((s) => add(s, 9, 3, 2));
          add(" ", 10, 1, 4);
          add("Cómo comprobar que funciona:", 12, 2, 4);
          add("1. Recarga la web: debe aparecer el botón del chat abajo.", 11, 1, 2);
          add("2. Escribe una pregunta y comprueba que responde.", 11, 1, 10);
          add(`Estas mismas instrucciones, en línea: ${pageUrl}`, 9, 1, 0);
          return new Response(buildPdf(L), {
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="integracion-${info.tenant.slug}.pdf"`,
              "Cache-Control": "no-store",
            },
          });
        }

        const stepsHtml = info.guide.steps.map((s) => `<li>${h(s)}</li>`).join("");
        const page = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Integración del asistente — ${h(info.tenant.name)}</title>
<style>body{margin:0;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1a1a;background:#f7f7f5}
header{background:#fff;border-bottom:1px solid #e5e5e2;padding:20px 24px}
h1{font-size:19px;margin:0}
.sub{color:#777;font-size:14px;margin-top:4px}
main{max-width:720px;margin:0 auto;padding:24px 16px 60px}
.card{background:#fff;border:1px solid #e5e5e2;border-radius:14px;padding:20px;margin-bottom:16px}
h2{font-size:15px;margin:0 0 10px}
ol{margin:0;padding-left:22px}
li{margin-bottom:8px}
pre{background:#14151a;color:#e7e9ee;border-radius:10px;padding:14px;overflow-x:auto;font-size:12.5px}
.mut{color:#777;font-size:13px}
.btn{display:inline-block;background:#111;color:#fff;border:0;border-radius:10px;padding:10px 18px;
cursor:pointer;font:inherit;text-decoration:none}
@media print{body{background:#fff}header{border:0}.noprint{display:none}.card{border:0;padding:8px 0}}</style>
</head><body>
<header><h1>Integración del asistente virtual — ${h(info.tenant.name)}</h1>
<p class="sub">Plataforma detectada: <b>${h(info.guide.name)}</b>${info.domain ? " · " + h(info.domain) : ""}</p></header>
<main>
<div class="card"><h2>Pasos</h2><ol>${stepsHtml}</ol>
${info.guide.note ? `<p class="mut" style="margin-top:10px">Nota: ${h(info.guide.note)}</p>` : ""}</div>
<div class="card"><h2>Código a pegar (justo antes de la etiqueta &lt;/body&gt;)</h2>
<pre id="snip">${h(snippetRaw)}</pre>
<button class="btn noprint" onclick="navigator.clipboard.writeText(document.getElementById('snip').textContent).then(()=>{this.textContent='Copiado ✓'})">Copiar código</button></div>
<div class="card"><h2>Cómo comprobar que funciona</h2>
<ol><li>Recarga la web: debe aparecer el botón del chat abajo.</li>
<li>Escribe una pregunta y comprueba que responde.</li></ol></div>
<p class="noprint"><a class="btn" href="${h(`${url.origin}/instrucciones.pdf?key=${pk}&p=${info.key}`)}">Descargar en PDF</a></p>
</main></body></html>`;
        return new Response(page, {
          headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
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
            features: tenant.panel_features || {},
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
      if (ctx?.waitUntil) ctx.waitUntil(logError(env, url.pathname, err?.message || err));
      // el detalle no incluye secretos: son mensajes de estado de Supabase/proveedor
      return json(
        { error: "error interno", detail: String(err?.message || err).slice(0, 300) },
        500,
        cors(origin, [])
      );
    }
  },
};
