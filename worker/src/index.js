/**
 * Motor de chatbots multi-tenant.
 * Un solo Worker sirve a todos los clientes. El tenant se resuelve por clave pública.
 */

import WIDGET_JS from "./widget.txt";
import WEB_HOME_NEW from "./web/home-new.txt";
import WEB_LEGAL_PAGE from "./web/legal-page.txt";
import WEB_STYLES from "./web/styles.txt";
import WEB_SCRIPT from "./web/script.txt";
import WEB_COOKIE_CONSENT from "./web/cookie-consent.txt";
import APP_BRAND_CSS from "./web/app-brand.txt";
import BRAND_LOGO from "./web/assets/expobot-logo.txt";
import BRAND_ISOTYPE from "./web/assets/expobot-isotipo.txt";
import BRAND_LOGO_HEADER from "./web/assets/expobot-logo-header.txt";
import BRAND_WORDMARK_MUSTARD from "./web/assets/expobot-wordmark-mustard.txt";
import BRAND_WORDMARK_DARK from "./web/assets/expobot-wordmark-dark.txt";
import BRAND_WORDMARK_LIGHT from "./web/assets/expobot-wordmark-light.txt";

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

async function sb(env, path, { method = "GET", body, headers = {} } = {}, _retry = true) {
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
  if (!res.ok) {
    const errText = await res.text();
    // PGRST303 «JWT issued at future»: desfase puntual de reloj en la pasarela
    // de Supabase al canjear la clave sb_secret. Un reintento corto lo resuelve.
    if (_retry && res.status === 401 && errText.includes("PGRST303")) {
      await new Promise((r) => setTimeout(r, 800));
      return sb(env, path, { method, body, headers }, false);
    }
    throw new Error(`Supabase ${res.status}: ${errText}`);
  }
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

// comparación en tiempo constante para secretos/HMAC (evita fugas por tiempo)
function safeEqual(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- CORS ----------

// ¿el Origin de la petición está entre los dominios permitidos?
// Compara por HOST con frontera de etiqueta: "fisioexpo.com" permite
// "fisioexpo.com" y "www.fisioexpo.com", pero NO "malfisioexpo.com".
function originAllowed(origin, allowed) {
  if (!allowed || allowed.length === 0) return true;
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false; // sin Origin válido no se autoriza el cruce de origen
  }
  return allowed.some((d) => {
    const dom = String(d || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!dom) return false;
    return host === dom || host.endsWith("." + dom);
  });
}

function cors(origin, allowed) {
  const ok = originAllowed(origin, allowed);
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

// segunda herramienta: en vez de pedir los datos por mensajes, el bot muestra
// un formulario dentro del chat (el widget lo pinta al recibir lead_form)
const FORM_TOOL = {
  name: "pedir_datos_contacto",
  description:
    "Muestra al visitante un formulario dentro del chat para que deje sus datos de contacto. " +
    "Úsala ÚNICAMENTE en dos casos: (1) el visitante pide expresamente hablar con una persona, " +
    "que le contacten o que le llame la organización; (2) el visitante necesita una respuesta que NO está " +
    "en el contexto y no puedes dársela. " +
    "NUNCA la uses solo porque el visitante diga quién es (expositor, visitante, prensa...), ni al saludar, " +
    "ni ante preguntas que puedas responder con el contexto: en esos casos responde con normalidad. " +
    "Antes de usarla, responde primero lo que sepas. Acompáñala siempre de una frase breve invitando a rellenarlo. " +
    "No la uses si el visitante ya envió el formulario en esta conversación.",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["expositor", "visitante", "prensa", "general"],
        description: "Tipo de interés del contacto, si ya se deduce de la conversación",
      },
    },
    required: [],
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
      tools: leadCaptureEnabled(tenant) ? [LEAD_TOOL, FORM_TOOL] : [],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return res.json();
}

function leadCaptureEnabled(tenant) {
  return !(tenant.features && tenant.features.leads === false);
}

// el modelo manda sobre el proveedor guardado: una combinación incoherente
// (p. ej. provider=google con un modelo claude-*) no debe tumbar el chat
function pickRunner(tenant) {
  const m = (tenant.model || "").toLowerCase();
  if (m.startsWith("claude")) return runClaude;
  if (m.startsWith("gemini")) return runGemini;
  return tenant.provider === "google" ? runGemini : runClaude;
}

async function runClaude(env, tenant, history, message, contextBlock, saveLead) {
  const msgs = [...history, { role: "user", content: message }];
  let reply = await callClaude(env, tenant, msgs, contextBlock);
  let leadForm = null;

  const toolUse = reply.content.find((b) => b.type === "tool_use");
  if (toolUse && toolUse.name === FORM_TOOL.name) {
    // el widget pinta el formulario; el texto que acompañe a la llamada es la invitación
    leadForm = { kind: toolUse.input?.kind || null };
  } else if (toolUse) {
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

  let text = reply.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text && leadForm) text = "¡Genial! Déjame tus datos y el equipo te contactará muy pronto 👇";

  return {
    text,
    leadForm,
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
                  {
                    name: FORM_TOOL.name,
                    description: FORM_TOOL.description,
                    parameters: FORM_TOOL.input_schema,
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
  let leadForm = null;

  const call = cand?.content?.parts?.find((p) => p.functionCall);
  if (call && call.functionCall.name === FORM_TOOL.name) {
    // el widget pinta el formulario; el texto que acompañe a la llamada es la invitación
    leadForm = { kind: call.functionCall.args?.kind || null };
  } else if (call) {
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

  let text = (cand?.content?.parts || [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("\n")
    .trim();
  if (!text && leadForm) text = "¡Genial! Déjame tus datos y el equipo te contactará muy pronto 👇";

  return {
    text,
    leadForm,
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
  const run = pickRunner(tenant);
  const { text } = await run(env, tenant, [], question, contextBlock, async () => {});
  return { text, hadContext: (hits || []).length > 0 };
}

// ---------- marca: logo para emails (PNG) y favicon (SVG) ----------

const BRAND_ISO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 58"><g fill="none" stroke="#f5be10" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 14V8"/><path d="M22 14h20c9.4 0 17 7.2 17 16s-7.6 16-17 16H26l-11 8V43.5C9.3 41 6 35.9 6 30c0-8.8 7.6-16 16-16z"/></g><circle cx="32" cy="6" r="4.2" fill="#f5be10"/><circle cx="25" cy="30" r="4.2" fill="#f5be10"/><circle cx="39" cy="30" r="4.2" fill="#f5be10"/></svg>';
const BRAND_EMAIL_LOGO_DARK_B64 = "iVBORw0KGgoAAAANSUhEUgAAAUEAAAC0CAYAAAAKJp4vAAAQAElEQVR4nOydC3gkVZXHz63Os5NMN4y8fPD0hYKi4IjMwEzSg4riIqMCwq6yKrsCPkH5ZEdW9jGIrvot+AAXRFZXUHcBEUSUSTJPXsL4wgUFZWAXUZ7pJN1JJt11PSddM2Qm3XVvVVclldT/93011dN161Z1p++/zr333HNaCAAAUkwLAQBAioEIAgBSDUQQAJBqIIIAgFQDEQQApBqIIAAg1UAEAQCpBiIIAEg1EEEAQKqBCAIAUg1EEACQaiCCAIBUAxEEAKQaiCAAINVABAEAqQYiCABINRBBAECqgQgCAFINRBAAkGogggCAVAMRBACkGoggACDVQAQBAKkGIggASDUQQQBAqoEIAgBSDUQQAJBqIIIAgFQDEQQApBqIIAAg1UAEAQCpBiIIAEg1EEEAQKqBCAIAUg1EEACQaiCCAIBUAxEEAKQaiCAAINVABAEAqQYiCABINRBBAECqgQgCAFINRBCAeUBpU/b5arJl3wzpoTYa2ap6aZxAJCgCACSWUn/uTG6mq7mlvmCnA5pudqjyb52F0Q0EmgIiCEACmVjfdehkpeU6pdRLGpfSmsXw77sKxSsIhAYiCEDCGOvP9blK9VufoPVZLISXEQgFRBCABKHvpEXlcv4BfrlPgLMq/M+RXX3FewkExiEAQGIYK+dWUyABFFQLd4thCYYEIghAgtBanUZhUOp1ekP3HgQCAxEEICGMrc8dMGMWOMj5k36TKKAREEEAEoJ23dACWCOzF4HAQAQBSAqu2kZNobH4IQQQQQASQmf78P3UDEo/SiAwEEEAEoJaRiM8M3IHhUCTfjbbN3wXgcBABAFIEI6jv0ohUKS+TCAUcJYGIGGUBvI38+6t1ido/bOuQnEJgVDAEgQgYWSzQ6dOrR2xQGvamHXctxAIDSxBABJKaSB3ETfR8xscHtVar+kuFC8m0BQQQQASjKwlHh/NH1519JFKq3ZSrqvIua9zcugn6k1UItA0EEEAQKqBcyUAINVABAFIMKWBRWdxh+0wfrmYJ0F2I6WmJjMV6d909RXPJtA0EEEAEozWzgeVokPltdp58KqbQCTARQaAJKN0W723tVatBCIBliAACYaNv7b6RzREMCIgggAkGlW3jXLXGCIYEegOA5BoGlh8WrURiASIIAAJhmeE64sdLMHIQHcYgCSj6k+AaIwJRgZWjIAFydhArlBVulVp3abIaeVZ1lbXpValaq+VyyKinDZ3+2tyrA0CrXRJkfqdo6io3eq2ztzIL9QRVKYmGF3btRff0OJqRu2uKLPjXlxNg41O4eu/jULg6MqT7X2jv6EmGRvMr9Cue6gmZzFFheK/klJV7VKV1anqkKrwt1DV/JpcVeUS1anj/P8MuRVN3vvy3tSxKu/5nKrir5KqnYXigPGSBMACpDSQ1zSr6Ct4u7Grb/hHFJDSQO46boqraC7QegsLyGYWmid5cOzWrhXDP7M5bXRw0ZuVdn5MCSerhjpVL437lTGKoNZ6N969mpLB00qpXxMABmZfBLejf88zt6uzvcXv2Z5R6s//kEJadVHD7f1+vperuzr0leqo4Wf8ypb6c3dLqk9KMCyCPSyCo35lbERwJe9uo2TwYxZBxE4Dvuj7qK38RH6C5hR9fXa8eCr/Wo33wZbgrdwU30RJQlNZKf2Vzg79uUZiOL42d2DFoTt5aCCx+Y6zrXp3dXTxWb8ymB0GIBbUqlJH/lYRZFNJncQJSkVZHls7rzyuHhsdyNWNadixsviHloxeyh/gMUoqumr8biGCYMGhDqEmU1dGA3ezVpT/nPsvi5IJ9tJQHWzpXTQ6kB8s93fOyIvcsXz4wYzWx0iiJ0ogZXIhggDMKUq9qzSw6ALfIkQZSjgi6K5qv6882LNs12NiEWZ09e2UQJTWEEEA5h7nn8WdpPHx+ZE0nYUwr3VmY2kwP0PwOgujG3j3fkoYitoggiB92IzDzTZVrS9reFAn73590XTDaH/+9F3f7uobuootr89RglAESxCkkKSMCU6Hx9VeXh7I1/UF1IkeE6wPi8s3yv35E3d9v9Mpfponepp2xI4KNekaV9Zg2RxYkDiKeikixJqYWoXAuG61h8f5XqTJeRl3Dw/nt5ba1uOSPpN319c5NP/aoVIOT4ZcU17X05ddMXLHjrd7qVIenHizovYXm6pwNfXx7gJTOX5K3KSUu5Yv+SsKSFt19BFTGfgJAtAEpf6et/G8xrXckrpsymc73MUmJ+S40Wt7Fo8r/UpFmceqjjpUu/osblfHUghYH55x2iZekz16/FEKSHlw0SlaO9eayvFD6ORsX/H7FBPGJxB/OWsJy+sAqEtXYeQmnv09iW1Pq+VyYxP0Rt59l+YQtXLkad5t8P77e95+oDd371neljmDXHW+raBP1aXU7u5k+zeIxkOJqA1aqViHNzAmCECTdPUN38LjYOttyrquOpwSiFo6+kRXb3GNdiZfzN3cQFYXj3eurDdREhnanaQYgQgCEAFKV79oWfSFlGC6e0t/6u4rnqw1/S0F4xJ9+6LdKQYySsW6BBIiCEAEZNtH1tmU4+5jD80DugtDVztO9Ri2cEdsyitFi8oTzocpBrRWsVqCC2Z2mAdoc7x7jaFYmX+Ed9McwveZ591hDQ5v4/u7vcF5e/Lupbwt5+0Y3tqnHS7xdj9vG3m7jetoKrZdWPgeO3l3NG+yquBIei5JkETxkHEomRB4mLcb+R6Ns3bzCbWMRkoDNMYvO/3K8XdkJSpJoHPFyMbR/tw7WeF+YlOeP9tH9e30eXXU1PcQGVpVqxQjC8lFZm/ebubNd1CX/1Bv5AYYerabz38X70xjJt/ja5zS4JgIYKNAmX+m2ueYfj3xLVvN22vJH5k1P5e3Mp9zOe8v5nt4kmYBvh5PDNCHqCaANlzC5/yC9xJu6tK5Eu0okRnXskEAp1DqCZpHdBeKPy0N5D7LN36+qSyPDe42Np4/k2joSxQlMVuCC6Y7zA3pt7z7iEXRb3oxEgPD571MzjcUkx/5OdQkfK2X83YXv7yOzAI4nax3/d/y+bEuY+L6j+PtIaqJma0AbkceBty46EGu4900zympjFU8QG5wW2mekX2qeAFPlvzWpqyu+UJGCs8Ox2oJLqgxQRbCq3j3DUMxiYRxFQWEG6pYmD8gMroPvJvv44/UBHwt6e7ey9sSCo8I/ZVc1wYRVIoQ6ZrzJsJ3C28HUXM8n7druL5B3hIbl86Cj1uVUu4dNM9QJ1HV0e77LEu/eHRt16soQrY7qsfFgpsYYQH6AO/WGoq9nRtc0CfWlbyZxOTTfH1TTgM/n0vF9yVWnLhbZCkaxELbIsMAFAFcj7h4/Jy3kyhaVlDtPoNYvYmAu4tf44kBq4af7R2+k+Yh2cIIj1Xr62zKOqolUsu+lSoQwRDIH8E09vIlbnCHkAVc7mzenWIodg0L4BqyqM7nmEx+2LpaBEHGqn7Cn+NEagI+/wTe3UM16y0OxH3kXr5OIkLN21Duz13Mzy7LB6qdiCQVFovLbMq5pP6KIiVeS3BBrh1mMXqKG5L4Ofl58XfwdhOXe52Ub1SIj8ss51fIH8l78gFKPtfL+Bt/3sArFvi8AtWGA2aD7/H1lvF9bqGQjK3rOdp1naNjS1LOswA8/nUyd9VeZntKRtHlFIKJ9d0HT1YyJ/D38QZF+gHuUt+U7R3ZRAEp9efO4MZxPP812x1Nn7fJxDadzr5iP1u9PLuvDvArx1bxK/QgdZtye9iinXjHBBf0cjhuSBfy7jOGYuv5x7Wiwfli8cgspt9Y1TBvr+E6/kB297SCGs8Om3iQajPTcr78MMQ5VWaTZVzuNN72sqhD3BdezvdrvdbTs5ilG2eznEpCrUvjkgeDLHiXmb0DvHuUeiSwQbdFPY/zdkSY8VV92265ckYPUYJg8/++7r6hQykgo2tzxypH/XRGfZre110YMk3S1creSYtK5dzdahfBZrH6WLZ36BIKQGkgLwbB2caCjrvElLnOdu2wk9EHdi4vPkwxYWUJjg3kl8uTj+YSt+J2uK2/VMc+W7Q9hRvQhdyAZXLhOJ9iy7nM57nseXWOyeC/abD+vbYCGBJ5mn6dat1tP8voXP4c76DajOtLfMpJ11i6NW8le75DZgEUsVrD9/g1v0LezPzHqObO41fnPrzdwNvrKSATLdU92HygJKGUDroCo3aeM/Vd1amP/pHMngpTlMfyH+fGO8Ni1S5dxLtAIsiW6Aa2fo0iqNwpa9EqfaeRinIpRowiKKZ4pUrraI4SGO5AtRA/3aV7e3ywE6csJLFKXuBT5pPcOH/ODXjHU4n//ymqOf36cQmfE2cX8Xe8STfoAZvCXO46vm/5jkQ03+NT9C1c7p1c/n/IgGdNmwb9Jf/syVyf0RGYy0guis9wvZfy/kbyD0W1hMv9NZ9jkadj2jWcaqek7U4MWq/p6iveQ+Fo1N3eXw/m86p3yGzxuvTGuiaMouzY+twBQaws7kbfW7Uwh9hSjWwJnXYm5tZFxp1s2ZsSgw5sjXqNzma26ipucFNWhzf+9VlD+bu47o9RfMiYzxJbAdwOlx/n7b1Us2L9+ILh+Har7ZOGYl+X8GY2AjgdLi8rSCTN5GZD0X+hgEy6rUnK2fGLrkLx0xQSFpN8o2PjLuXIBkX7NjrkUMVmaGIH7bmi1TAKG+J292aDG68JZhTBquPOr9DfdeAGJ8vJTB7v2ydKZMzqh4ayshIjbGIZGyEXB+Tj+b6tu/4zLlJbseIX4Xc//qym8EfS7fFz1dnE1/kghYTPleV+MhPs54i7f1B3plZnMlbLIQh87+16EzWxXlg1jIzstFSs3Kj4HhqWq1Yy5lUu0+/mCJpkRTJan9wdDlSvH67jzLGz9FyPBe6ECv1E4AZ3Me+uMRST8T8Z1Df9uN7B9f2J4uPkZgRwGn9jOH664bif+Ixa1G/Es9RN42XvpCC4aq4Hb3bAn+/g8rb8tyk8DT9LpZqxEkHlE4VFOU5gf1RJuGQs5ERnvamMjlWDzCJYVYl5qobpDk+HfwwyPvhzao4PepZlXHylGdeQ6XA98lm/7FNklRfQYQbehJKfP6BMJm2lCOB6ZBWFX/f9DTS/OaHcvyhkhBXduP1pS6HReqzpOrYX35izWnLKv5/I1oOryXhnuYyVt2TmfEokamQGNWwkjyu4wX6d4iXqbF1+DtwyBNBo5tzP4VV+4H7iGoZ/9znWyY0q6NrkRKGVc+nEYE/g5Ys8C9wwqnKLqlrF2dNKNRRB13EDidW2yaqdo3yUgSIcmmNLcIHBIiYzYadTcO7gc/+O4uUhvsb/U4RwfRKZ5l6fIo1mH/182n7A9Ubqh8f1iR+i3xDDfLcGqaKdwKuBeGJkuNGxtmqr1W9F+QQ/cKpOILGq6MwxNuUyrv4/ioqWeC3BebZiJJqxHm5wsnLiP/ilrahJg49qrazfZ4hrnFGi0TQK6/7SBu/vR425j+JB7vOEBscWaFGhOwAAC8VJREFUkyVt20YfdtvykWWbm452aTfl0LOa3L21dsSFyuw4vAP1Fu4WL8kWhq1jWrIlKO5dM/5G3IsdUMcO2Y4bSzzAmek+NT3SWRgKGtfRakmj2z4ZyKvBD1XpYBEcp7hIc8rNj1LNRWM/i7KfiNBC8zPt4xp//bPPsUaO1X7dnsh+4LsgDb6RCFq7cqg3SZDZoXUUP98tbciuoUrbFWTpfO6ScyrvrEUw20pnlCb1BM9Pnrr9PRbAB5zMttOt6+gofrs0njuJ6yg8VwcNtbZMBlqjLUvhylodZyxH+tnuZeWmIintVF/MfoJmEazSH7jZ/hM1g5K5Ir0H7/fgLz/H39JTbNQ9rrQzHKga5f6OIkL86dgalGgzNjH3wjq61sPPEozLv81v3KeRKMu4aaPVMiWKB7+F8oH82WaLrmPKj/PXe3xpIH81//e9pvLcNT2KAqCOLsrs+WkT67surlZbj1W6ck9nYXRDoDqmIj0XV46vzR1YzWgWMf1Id+/IzRSQks6daTM4p7SySjplTcx+gkYR7FhZlCVhF9ICw1vDaxt0VNZLzsbAfFwDwM/zOdZokkicmQ9scCyuuH+tPscS7a/a1Td0emkgt1Ti6fmV06ReSiFoX14SK/nX1AReW/4qhUDfTp2lcTrPqqwTcaCNuXaWXoh4KyGCBFZd5i3zihvrfK8B8Vsy2CjSx1ZqzJ4UD36hzfy69IlAW/ymeIwvx5Md867dlSZyH+Hu9PNsyna1aNNig0DMvbP0wkRCSR0Q8JwPhwjEWg8/a89mfDIMfpMEDzV4/5eNT6GI48XtwM/a3koJJ6O0XWSeTbnolpTNAuXBnmXcxb3Ypiy3kdu8LnxkdLXFG0AhdSLIfyQJrRU2yvLX+PxXU3zsFrU/HNcnGfj8LMFGcen83GpWcL1+kWoC463X9lt073c/iUBrZTWFOVbZFpfFHzljg/n9Xe1YW3bKcaPvMY0hx0hkeLk7LqTmkHwYceaOvYii5ULD8UarX0yD21bjQwHwDUYR8yqdiFD72pRyqLWD5gHljR37VrW+VbLI2ZTnbv6vukJMuBjJZCCCUcDCJQFHjQEcyZyo6RVUi3MX+lYMx5dFlX3Nyyvi13Xdohp49qvaKoObfM79gER/pgjgeiSXsl+INGPIryTAnyPQzG+SKfXnXutua9+iAkTOdkj/KwXC0u+3dQgiGBHSkExLfj7lJWq6wFCuwD/4qJe3TeeSZjPEed1gU04L0xLAqw3Hv8nXaSpuHJ8veUVMImdKbzDniPsJPzmCBXpIIDJpM9qf+xSPXG/mtmDtoM4n3t3ZVwz2sLJdt9xBEMFm4Yb2D2QOkHo5/9GnhI338kQzRcU9j+tdSvEgLigbwo4/8nmyxExCsvv51olrzHd8jk+trCH/WVlxB9nI19uHQiCpO6l2n36zjnfzfUTrdxYDVUWBAr8mkdJgz/Hlwbz0DiTZeqAue0a57+GZ72CuLIqsJjzUERRZMIZ6LPgVI56QmLLASVy8XWd+ZZmc5Bfxm8n7llhcfG4gp29LRAg3cf2ncf3WA9NeZjwby+kKL56fCVMIdhkeuJOve4oXDcYKLi/jZ7fydrCh6GpKMOXBzhdq3XbDVFO1QdMjHX3DD9EcM7G2+xVupmVPl/RBpNWJWiJ8a4sQWXXRqzv6RqySsyeRBS2CXjDJ7xuKSaa5GeuCJUyUNGyqhY5vhDgTizUVV4pIseRu5PsQK+M/+Z4a5lPmMjKmJlGYDyMzW8nc5Z+Cr3kp1/0h8s9bIoJ2O5cTwfyCFyOw0X2K6El+ERtH9Rv9PrMfYwO5QlXpVuXypjKtJK9Jt1Zdh/+va//n1+7U+8T/V62SK9L6AmpqJvvt2qXFEqbe9jRdZ6KqPJA/R8eTarUhFe9mtntsNeGlf2NXXzHcZJ6O1/XFFuNn5x/tSt7dRsngR2oqZaAdnnicZihW8EuYznV8hMzJaFZzHVY/hCazzUm3QDK4yfJBWcv8It72p+CrWVYE6WJ6aQeCJA3v5+0WqvkaynjOIqolTJKHhW3GNVnYf1iYaDWyuqE8no+1CxUG/h4f7C4UZ6wYKfXnH+OWGFcu5/jQdHt2r6FedUjjcF9+sPiv0qZxa62rXYVirMbagrUEPevFJIBr/ARQ8CyhJYa61nCZzbMwdiUWx5HeFpbzg94nl7+LP5+E0bfNm1vwtmY4KXS4Lsd3+d2ckSGakYpgdGCRJMSafwLID7hs+9CbwwqgoJXFgjg1lbI1VubbxIjV/XrjgKbuxTqy7BIyZ1At568f1zaK0rwLc5kE6BNemoHAeMFkZdw07iC74nB8HF/POtLKDMZ6ErfOmH8b1+6a7Fx/XxaZKFNe7MQh/oDZDrdPLQsdnNiryOa3pCoUM/NNBI1fGv/YZBxNTGy/hiCJvcXSsGrQns/cKkMxmSH9FpnxGwcpW9YRhrP5czQ17sTniyUobiBR5D+ph4wlHsPXuZWaoNxaTZQITiUmcirn7Pp+eY/c6fylHkjzCa0v73KGlqqjhp+hZtFV45ig9o8sFAkLTgSplkzpIEMZEcAnKQBcXgKJmoKwvo1F+BxDGb/PMOmly5RMdoHuzwcZW3u9KSm6LZ7bjExuRJ1vWYTvcK6/6YTdceekCIJEhlZaF7p7SzsFzNX38NCGpoDOxXPKmFLuu3l87kzV2zDoRjCskjFpiGAQWIBkKZdppvZcbmibKAR8ngTPNE0SfdFzVA4NX0eSkr+St/+m8IhVeRlvr26qa1kHru9x3k6kWn6S/6XmkKADq7i+47zUB02jqD0RY91iAfKMdC8Lx4zEWaVinifSVIJyevug9Q1KT7wk2zv8XYoS17wmmIcLrPKoNMOCEUEWHpl1NAV/ldwYX6LmEEvNFNxV3FoWUXB2dA/EUuVNXHfEIVmSEP3esg4JNCCZzfbm88+KKHVnXaTbypuItcxOX032wVZF+GTG/Vg+fz/emlmGmFQ2t7qVpXUFcDD3fqWmIpsnGh6yu6aFKofwZ1iVLYw9RhGjtcV4n9LxxdX3WEizwzKTaAr93XQkErGCWOBkdta0mkM87oM6Ubt1rifi93HZvMANr6Kaa4xYEdMnYsQi6+fyT9Ms41nWmzxHbVmZcxA9574jq0Fk1YkInzifb/E+U3zInOMcZctm4XiSW/e53YXhurmGy+t63qBddSUlFO6+/5q/uuu1M3n5rl34qMk4aptpUJD/kBDBXWhouXLDkuxW0WW48sFzBl5H4fCbHXYM15XZuM2UUPj+pAv+U5pjqnpyXHyfZw3N466KfqiVe0t377DvpI52nVgSQNnAAv0UafVHvtdnvTfkUfGoo4it1erdnR0jW2qh+GeHqXSfrn9nlIcTIs2+WP8aBvjpLrNX76Fk8CA3tO/QPIa/zz6qORPX42n+fFbRe4E/kiRcgntOrO8+uH356P3b3x/rz/W5Su3P3ax9eExqZ6VUrkuSotTVjzqOYxQD7brlIJnjwExKm7LPdybbphzItXbHOtvdh9XS0ehyFlswR52G9OIFD220FAwiCMAsk+aUm0kkbkdkAMAuQAQBAKkGIjj7+E2IxRo8EgAwE4jg7OM3HYbuMACzDERw9vETOliCAMwyEMHZx29GPhFBJgFIExDBZAFLEIBZBiI4+/hZe7FHzAAA7AxEMFlABAGYZSCCySL2UOIAgJ3Bsrk5Qmt9OO96tv+Xt61KqUcIADCrQAQBAKkG3WEAQKqBCAIAUg1EEACQaiCCAIBUAxEEAKQaiCAAINVABAEAqQYiCABINRBBAECqgQgCAFINRBAAkGogggCAVAMRBACkGoggACDVQAQBAKkGIggASDUQQQBAqoEIAgBSDUQQAJBqIIIAgFQDEQQApBqIIAAg1UAEAQCpBiIIAEg1EEEAQKqBCAIAUg1EEACQaiCCAIBUAxEEAKQaiCAAINVABAEAqQYiCABINRBBAECqgQgCAFINRBAAkGogggCAVAMRBACkGoggACDVQAQBAKkGIggASDUQQQBAqoEIAgBSzV8AAAD//2Ih/twAAAAGSURBVAMAgY2Nt9FC8soAAAAASUVORK5CYII=";
const BRAND_EMAIL_LOGO_LIGHT_B64 = "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";

const BRAND_BASE = "https://expobot.es";

const BRAND_LOGO_PNG_B64 = "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NpFE6CduVqUjAZGTn8LIi1buihU+tB8g2/pvYxr/au3oldY0P2dN4xOWhz/BPPKpim19nivDXzVZ86pGY9n/fqT40781fnffz264845fXL/suhtv+OZVv7r+61f9+rqvfuM3v7zimzf/8hsA5H99ecZNP/v6dTf87OsLb/jp1xbe+F9fm3HTwiun33DtN2ZE/eexbMfrfwG71L3+69/49ULg51+96lc//+rXI8R2/RXf+HUvFiIv5QuvuCL6S/7ar878tUjBT2H/2Te//ivBT79+xa+7WCg66l77pa/8pvT7xq+v/dJM4Cu/EZvguq9O/fUvr5ga89ehTMYzhp66Yvs5+rgO/V6H9q776ld+IxD79V/f+VfS/rXgQ7DwCoztazveIPP/+dd2uPm6r+/42y4WfnPHWybi59/a9eaffXPnX/30setu/Nni624Qfn4Ojq9b8stfjtK9P3Er7vq/CS//+wEa/o7pX/71pMaX92fuM1m99YkkbX0SAZ1Ls9RdkVbc92zir2UT7vDeP+pcGA7eedwUxPKrKQB374so5TYq7w/RxiEfr3Xdax3/joh1RAeQpCsKHhqiGh7SF4588Ck5uyfEGygZeu9umT9izvxH+2NdPW0uBuQCdy90dwxdm9gtjF0ka9F7bV0/kWJfG6SsF9LHxkZv++vSu2NbV7lwgOlqUgaUAWVAGdiCGJC1uRcytIl5sSmUAWVAGdhqGJAX4S1vsPN/YA89YNKBBU+6oJlX3oIgwg5sc7w4e8Ymj0P8RluGjYBD3POFuPkLUYcdstxnioK8pLhcx5PkInpKy3xwFAK+ffc5YhmQwQU5sJeUQIZzrmh5UzyYpKMLs3TpFWm65AOGHnn38Ogj5z585z2f/M0fF33tV9+97u9+/f3d/uPm7+92243f2/XB/75678d+9909lt9+zYHD93z3qOYttxyS08KjCrrmVHzFvwATWBuwYyYp70LyvRB7N7+2+htik1+n2BD/ru/EepIXSHlXir46iLr5tflMtHXnGCUul5Q/IXzkNvIr9dAf9FuuPCS/8ZrDGtd/Z79VC3E9brly38W/umrmI//17Z3u/cU3dv7vX1555b/eYB/81sP3NL64lOgiE4bfW81WndvfP7Kgr2/079O6v53YD7dzLorckAumMx7caQGxDo97Jwba5B4zxCQgHJKHQJL7E4JQIwL3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";

const BRAND_ISO_PNG_B64 = "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";

// ---------- plantilla de email con la marca ----------
// Sin SVG ni CSS externo: Gmail y Outlook los eliminan. Todo inline y en tablas.

const EMAIL_FONT = "'Segoe UI',Arial,Helvetica,sans-serif";

function emailShell(inner) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background-color:#f3f3f0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f3f0">
<tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border:1px solid #d9d9d4;border-radius:6px;overflow:hidden">
  <tr><td style="background-color:#050505;padding:20px 28px">
    <img src="${BRAND_BASE}/brand/email-logo.png" alt="ExpoBot" height="30" style="display:block;height:30px;width:auto;border:0">
  </td></tr>
  <tr><td style="background-color:#f5be10;height:3px;font-size:0;line-height:0">&nbsp;</td></tr>
  <tr><td style="padding:28px 28px;font-family:${EMAIL_FONT};color:#101010;font-size:15px;line-height:1.55">
${inner}
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #d9d9d4;font-family:${EMAIL_FONT};font-size:12.5px;color:#686868">
    Impulsado por <b style="color:#101010">Expo<span style="color:#f5be10">Bot</span></b> &middot; <a href="https://expobot.es" style="color:#686868">expobot.es</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function emailStat(n, label) {
  return `<td width="50%" style="padding:5px"><div style="background-color:#f7f1dd;border-radius:6px;padding:14px 16px">
    <div style="font-family:${EMAIL_FONT};font-size:26px;font-weight:800;color:#101010">${n}</div>
    <div style="font-family:${EMAIL_FONT};font-size:12.5px;color:#686868">${label}</div>
  </div></td>`;
}

// ---------- informe mensual ----------

async function monthlyReportData(env, t) {
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
  const q = users?.length || 0;
  return {
    monthName: start.toLocaleDateString("es-ES", { month: "long", year: "numeric" }),
    convs: convs?.length || 0,
    questions: q,
    rate: q ? Math.max(0, Math.round((100 * (q - (unans?.length || 0))) / q)) : 0,
    leads: leads?.length || 0,
    gaps: gaps || [],
  };
}

async function sendMonthlyReport(env, tenantId, toOverride) {
  const [t] = await sb(
    env,
    `tenants?id=eq.${tenantId}&select=*,projects(name,clients(name,email))`
  );
  if (!t) return { ok: false, reason: "tenant no encontrado" };
  const to = toOverride || t.projects?.clients?.email || t.handoff_email;
  if (!to) return { ok: false, reason: "el cliente no tiene email (ficha del cliente) ni handoff_email" };

  const rep = await monthlyReportData(env, t);
  const monthName = rep.monthName;
  const convs = { length: rep.convs };
  const leads = { length: rep.leads };
  const gaps = rep.gaps;
  const q = rep.questions;
  const rate = rep.rate;

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
         <div style="border-left:3px solid #f5be10;background-color:#f7f1dd;border-radius:0 4px 4px 0;padding:11px 16px;margin-bottom:12px">${gaps
           .slice(0, 5)
           .map((g) => `<p style="margin:6px 0">&bull; ${h(g.q)}</p>`)
           .join("")}</div>
         <p style="margin:0">Si nos das esas respuestas, el asistente las incorporará.</p>`
      : `<p style="margin:14px 0 0">El asistente encontró respuesta para todo lo que le preguntaron. &#127881;</p>`
  }`);
  const sent = await sendEmail(env, to, `Informe mensual de tu asistente — ${monthName}`, html);
  return sent.ok ? { ok: true, sent_to: to } : { ok: false, reason: sent.reason };
}

// aviso de lead nuevo (según tenants.features.lead_notify: off | instant | daily)

async function leadNotifyEmail(env, tenant) {
  if (tenant.projects?.clients?.email) return tenant.projects.clients.email;
  if (tenant.project_id) {
    const [p] = await sb(env, `projects?id=eq.${tenant.project_id}&select=clients(email)`);
    if (p?.clients?.email) return p.clients.email;
  }
  return tenant.handoff_email || null;
}

function leadRowsHtml(list) {
  return list
    .map(
      (l) =>
        `<div style="border-left:3px solid #f5be10;background-color:#f7f1dd;border-radius:0 4px 4px 0;padding:11px 16px;margin-bottom:10px">` +
        `<p style="margin:0;font-weight:600">${h(l.name || "(sin nombre)")}${l.company ? " · " + h(l.company) : ""} <span style="color:#6b7590;font-weight:400">— ${h(l.kind || "")}</span></p>` +
        `<p style="margin:4px 0 0;color:#101010;font-weight:600">${h([l.email, l.phone].filter(Boolean).join(" · "))}</p>` +
        (l.message ? `<p style="margin:4px 0 0;color:#6b7590">${h(l.message)}</p>` : "") +
        `</div>`
    )
    .join("");
}

async function notifyLeadInstant(env, tenant, l) {
  try {
    if (tenant.features?.lead_notify !== "instant") return;
    const to = await leadNotifyEmail(env, tenant);
    if (!to) return;
    await sendEmail(
      env,
      to,
      `🎉 Nuevo contacto captado por ${tenant.name}`,
      emailShell(
        `<h2 style="margin:0 0 10px;font-size:18px">Tu asistente ha captado un contacto</h2>` +
          `<p style="margin:0 0 14px">Acaba de dejar sus datos en el chat de <b>${h(tenant.name)}</b>:</p>` +
          leadRowsHtml([l]) +
          `<p style="margin:10px 0 0;color:#6b7590;font-size:13px">Tienes todos los detalles y el historial en tu panel.</p>`
      )
    );
  } catch (e) {
    await logError(env, "lead-notify/" + tenant.slug, e?.message || e).catch(() => {});
  }
}

async function runDailyLeadDigests(env) {
  const tenants = await sb(
    env,
    "tenants?active=is.true&select=id,slug,name,handoff_email,project_id,features,projects(clients(email))"
  );
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  for (const t of tenants || []) {
    try {
      if (t.features?.lead_notify !== "daily") continue;
      const leads = await sb(
        env,
        `leads?tenant_id=eq.${t.id}&created_at=gte.${since}` +
          `&select=kind,name,email,phone,company,message&order=created_at.desc&limit=50`
      );
      if (!leads?.length) continue;
      const to = await leadNotifyEmail(env, t);
      if (!to) continue;
      await sendEmail(
        env,
        to,
        `${leads.length === 1 ? "1 contacto nuevo" : leads.length + " contactos nuevos"} — ${t.name}`,
        emailShell(
          `<h2 style="margin:0 0 10px;font-size:18px">Contactos captados en las últimas 24 horas</h2>` +
            `<p style="margin:0 0 14px">Resumen diario de <b>${h(t.name)}</b>:</p>` +
            leadRowsHtml(leads) +
            `<p style="margin:10px 0 0;color:#6b7590;font-size:13px">Tienes todos los detalles y el historial en tu panel.</p>`
        )
      );
    } catch (err) {
      await logError(env, "lead-digest/" + t.slug, err?.message || err);
    }
  }
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

// clave de firma del portal de clientes, separada del ADMIN_TOKEN de administración:
// si un secreto se filtra no compromete al otro, y rotar el de admin no echa a los
// clientes. Si aún no está configurado PORTAL_SECRET, cae al ADMIN_TOKEN (sin cortes).
function portalSecret(env) {
  return env.PORTAL_SECRET || env.ADMIN_TOKEN;
}

// huella de la contraseña incluida en el token: si el cliente la cambia, los
// tokens antiguos dejan de valer (revocación de sesiones al cambiar contraseña)
function pwFingerprint(hash) {
  return (hash || "none").slice(-16);
}

async function makePortalToken(env, clientId, pwHash) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000; // 7 días
  const body = `${clientId}.${exp}.${pwFingerprint(pwHash)}`;
  return `${body}.${await hmacSign(body, portalSecret(env))}`;
}

async function portalClientId(env, token) {
  if (!token) return null;
  const p = token.split(".");
  if (p.length !== 4) return null;
  const body = `${p[0]}.${p[1]}.${p[2]}`;
  if (!safeEqual(await hmacSign(body, portalSecret(env)), p[3])) return null;
  if (Date.now() > parseInt(p[1], 10)) return null;
  // revocación: comprueba que la huella de contraseña sigue vigente
  const [c] = await sb(env, `clients?id=eq.${encodeURIComponent(p[0])}&select=portal_password_hash`);
  if (!c || pwFingerprint(c.portal_password_hash) !== p[2]) return null;
  return p[0];
}

// tokens firmados de un solo propósito (restablecer contraseña, confirmar email nuevo)
function b64url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  try {
    return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
  } catch {
    return null;
  }
}

async function makeActionToken(env, kind, clientId, extra, ttlMs) {
  const body = `${kind}.${clientId}.${extra ? b64url(extra) : "-"}.${Date.now() + ttlMs}`;
  return `${body}.${await hmacSign(body, portalSecret(env))}`;
}

async function readActionToken(env, kind, token) {
  const p = String(token || "").split(".");
  if (p.length !== 5 || p[0] !== kind) return null;
  const body = p.slice(0, 4).join(".");
  if (!safeEqual(await hmacSign(body, portalSecret(env)), p[4])) return null;
  if (Date.now() > parseInt(p[3], 10)) return null;
  return { clientId: p[1], extra: p[2] === "-" ? null : b64urlDecode(p[2]) };
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
  return safeEqual(await hashPassword(pw, p[2]), stored);
}

// email normalizado y seguro para consultar por ilike: minúsculas, sin comodines.
// PostgREST interpreta `*` y `%` como comodín de ilike; un email con esos caracteres
// podría hacer que `ilike.${email}` cazara a varios (o todos) los clientes. Devuelve
// null si no es un email con forma válida, lo que ya excluye esos caracteres.
function normEmail(s) {
  const e = String(s || "").trim().toLowerCase();
  if (e.length > 160) return null;
  if (e.includes("*") || e.includes("%") || e.includes(",")) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

// ---------- administración (para el dueño de la plataforma) ----------

function isAdmin(request, env) {
  return safeEqual(request.headers.get("Authorization") || "", `Bearer ${env.ADMIN_TOKEN}`);
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
const INTEGRATION_FIELDS = [
  "project_id", "provider", "category", "name", "status", "settings",
  "assigned_tenant_ids", "last_checked_at", "last_synced_at", "error_message",
];

const INTEGRATION_CATEGORIES = {
  web: "channel",
  whatsapp: "channel",
  telegram: "channel",
  google_drive: "knowledge",
  email: "communication",
  webhook: "sales",
  crm: "sales",
  calendar: "calendar",
  zapier_make: "sales",
};

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

// paleta de marca en espacio de color PDF (0..1)
const PDF_INK = [0.06, 0.06, 0.06];
const PDF_MUSTARD = [0.961, 0.745, 0.063];
const PDF_MUT = [0.41, 0.41, 0.41];

// cabecera de marca ExpoBot para los PDF (wordmark bicolor + filete mostaza)
function pdfBrandHeader() {
  return [
    { t: "Expo", size: 24, font: 2, color: PDF_INK, keepY: true },
    { t: "Bot", size: 24, font: 2, color: PDF_MUSTARD, dx: 58, sameLine: true },
    { rule: true, h: 3, color: PDF_MUSTARD, gap: 18 },
  ];
}

// lines: [{t, size, font: 1|2|3 (normal|negrita|mono), gap, x, dx, color:[r,g,b], sameLine, rule, h, w}]
function buildPdf(lines) {
  const H = 842, M = 56, RIGHT = 595 - M;
  const pages = [];
  let cur = [];
  let y = H - M;
  let lastY = y;
  for (const ln of lines) {
    if (ln.sameLine) { cur.push({ ...ln, y: lastY }); continue; }
    const lh = ln.rule ? (ln.h || 2) + 6 : Math.round((ln.size || 11) * 1.5);
    if (y - lh < M) {
      pages.push(cur);
      cur = [];
      y = H - M;
    }
    y -= lh;
    lastY = y;
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
    const stream = pg
      .map((ln) => {
        if (ln.rule) {
          const c = ln.color || PDF_MUSTARD;
          const x = ln.x || M;
          const w = ln.w || RIGHT - x;
          return `${c[0]} ${c[1]} ${c[2]} rg ${x} ${ln.y} ${w} ${ln.h || 2} re f 0 0 0 rg`;
        }
        const c = ln.color || PDF_INK;
        const x = (ln.x || M) + (ln.dx || 0);
        return `BT ${c[0]} ${c[1]} ${c[2]} rg /F${ln.font || 1} ${ln.size || 11} Tf 1 0 0 1 ${x} ${ln.y} Tm (${pdfEscape(ln.t)}) Tj ET`;
      })
      .join("\n");
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

// ---------- generador de facturas con la marca ----------
// DATOS FISCALES: placeholders provisionales. Reemplázalos por los reales
// (razón social, NIF, domicilio) cuando los tengas; el IVA es configurable.
const INVOICE_ISSUER = {
  name: "ExpoBot S.L.",
  nif: "B00000000",
  address: "Calle Ejemplo 1, 3.o A - 28001 Madrid, Espana",
  email: "facturacion@expobot.es",
  iva_rate: 0.21,
};

function eurPdf(cents) {
  const parts = (Math.round(cents) / 100).toFixed(2).split(".");
  const int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${int},${parts[1]} EUR`;
}

function buildInvoicePdf(inv, client) {
  const M = 56, RIGHT = 595 - M;
  const total = Math.round(inv.amount_cents || 0);
  const rate = INVOICE_ISSUER.iva_rate || 0;
  const base = rate > 0 ? Math.round(total / (1 + rate)) : total;
  const iva = total - base;
  const fmtDate = (d) => {
    try {
      return new Date(String(d || new Date().toISOString()).slice(0, 10) + "T00:00:00")
        .toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" });
    } catch { return ""; }
  };
  const L = [];
  pdfBrandHeader().forEach((x) => L.push(x));
  L.push({ t: "FACTURA", size: 22, font: 2, color: PDF_INK, gap: 2 });
  L.push({ t: `N.o ${inv.number || ""}   ·   Emitida: ${fmtDate(inv.issued_at)}`, size: 10.5, font: 1, color: PDF_MUT, gap: inv.period_start || inv.period_end ? 2 : 14 });
  if (inv.period_start || inv.period_end) {
    const pi = inv.period_start ? fmtDate(inv.period_start) : "—";
    const pf = inv.period_end ? fmtDate(inv.period_end) : "—";
    L.push({ t: `Periodo de facturación: ${pi} a ${pf}`, size: 10.5, font: 1, color: PDF_MUT, gap: 14 });
  }
  L.push({ rule: true, h: 1, color: [0.85, 0.85, 0.83], gap: 14 });
  // emisor
  L.push({ t: "EMISOR", size: 9, font: 2, color: PDF_MUSTARD, gap: 3 });
  L.push({ t: INVOICE_ISSUER.name, size: 12, font: 2, gap: 1 });
  L.push({ t: `NIF ${INVOICE_ISSUER.nif}`, size: 10.5, font: 1, color: PDF_MUT, gap: 1 });
  L.push({ t: INVOICE_ISSUER.address, size: 10.5, font: 1, color: PDF_MUT, gap: 1 });
  L.push({ t: INVOICE_ISSUER.email, size: 10.5, font: 1, color: PDF_MUT, gap: 16 });
  // cliente
  L.push({ t: "FACTURAR A", size: 9, font: 2, color: PDF_MUSTARD, gap: 3 });
  L.push({ t: (client && client.name) || "Cliente", size: 12, font: 2, gap: 1 });
  if (client && client.email) L.push({ t: client.email, size: 10.5, font: 1, color: PDF_MUT, gap: 1 });
  if (client && client.phone) L.push({ t: client.phone, size: 10.5, font: 1, color: PDF_MUT, gap: 1 });
  L.push({ t: " ", size: 6, gap: 12 });
  L.push({ rule: true, h: 1, color: [0.85, 0.85, 0.83], gap: 10 });
  // concepto
  L.push({ t: "CONCEPTO", size: 9, font: 2, color: PDF_MUT, gap: 3 });
  wrapLine(inv.concept || "Servicio ExpoBot", 62).forEach((w) => L.push({ t: w, size: 12, font: 1, gap: 2 }));
  L.push({ t: " ", size: 6, gap: 10 });
  L.push({ rule: true, h: 1, color: [0.85, 0.85, 0.83], gap: 12 });
  // totales (etiqueta a la izquierda, valor a la derecha, misma linea)
  const row = (label, value, o) => {
    o = o || {};
    L.push({ t: label, size: o.big ? 12.5 : 10.5, font: o.big ? 2 : 1, color: o.lc || PDF_MUT, x: 320, gap: o.gap == null ? 4 : o.gap });
    L.push({ t: value, size: o.big ? 12.5 : 10.5, font: o.big ? 2 : 1, color: o.vc || PDF_INK, x: 440, sameLine: true });
  };
  row("Base imponible", eurPdf(base));
  if (rate > 0) row(`IVA (${Math.round(rate * 100)}%)`, eurPdf(iva));
  L.push({ rule: true, h: 2, color: PDF_MUSTARD, x: 320, w: RIGHT - 320, gap: 8 });
  row("TOTAL", eurPdf(total), { big: true, lc: PDF_INK, gap: 20 });
  L.push({
    t: inv.status === "pagada" ? "Estado: PAGADA" : "Estado: PENDIENTE DE PAGO",
    size: 11, font: 2, color: inv.status === "pagada" ? [0.04, 0.5, 0.28] : PDF_INK, gap: 24,
  });
  L.push({ t: "Gracias por confiar en ExpoBot. Datos fiscales del emisor pendientes de completar.", size: 8.5, font: 1, color: PDF_MUT, gap: 0 });
  return buildPdf(L);
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
      `leads?hidden_admin=is.false&select=id,kind,name,email,phone,company,message,status,created_at,tenants(name,project_id)` +
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
  // borrado suave desde el admin: lo oculta aquí pero lo deja en el panel del cliente
  if (mLead && request.method === "DELETE") {
    await sb(env, `leads?id=eq.${mLead[1]}`, { method: "PATCH", body: { hidden_admin: true } });
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
    const { number, concept, amount_cents, issued_at, status, pdf_base64, period_start, period_end } = await request.json();
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
        period_start: period_start || null,
        period_end: period_end || null,
      },
    });
    // PDF: el que suba el admin, o si no, se genera una factura con la marca
    let bytes = null;
    if (pdf_base64) {
      bytes = Uint8Array.from(atob(pdf_base64), (c) => c.charCodeAt(0));
    } else {
      const [client] = await sb(env, `clients?id=eq.${mInv[1]}&select=name,email,phone`);
      bytes = buildInvoicePdf(inv, client);
    }
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
    return json(inv);
  }
  const mInvOne = url.pathname.match(/^\/admin\/api\/invoices\/([0-9a-f-]{36})$/);
  if (mInvOne && request.method === "PATCH") {
    const { status } = await request.json();
    if (!["pendiente", "pagada"].includes(status)) return json({ error: "estado no válido" }, 400);
    const rows = await sb(env, `invoices?id=eq.${mInvOne[1]}`, { method: "PATCH", body: { status } });
    if (!rows?.[0]) return json({ error: "factura no encontrada" }, 404);
    return json(rows[0]);
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

  // --- integraciones del proyecto ---
  const mProjectIntegrations = url.pathname.match(/^\/admin\/api\/projects\/([0-9a-f-]{36})\/integrations$/);
  if (mProjectIntegrations && request.method === "GET") {
    return json(await sb(
      env,
      `project_integrations?project_id=eq.${mProjectIntegrations[1]}&order=category.asc,created_at.asc`
    ));
  }
  if (mProjectIntegrations && request.method === "POST") {
    const input = pick(await request.json(), INTEGRATION_FIELDS);
    if (!INTEGRATION_CATEGORIES[input.provider]) return json({ error: "proveedor no válido" }, 400);
    if (!input.name?.trim()) return json({ error: "el nombre es obligatorio" }, 400);
    const projectId = mProjectIntegrations[1];
    const [project] = await sb(env, `projects?id=eq.${projectId}&select=id`);
    if (!project) return json({ error: "proyecto no encontrado" }, 404);
    const tenants = await sb(env, `tenants?project_id=eq.${projectId}&select=id`);
    const allowed = new Set((tenants || []).map((t) => t.id));
    const assigned = (input.assigned_tenant_ids || []).filter((id) => allowed.has(id));
    const [row] = await sb(env, "project_integrations", {
      method: "POST",
      body: {
        project_id: projectId,
        provider: input.provider,
        category: INTEGRATION_CATEGORIES[input.provider],
        name: input.name.trim().slice(0, 100),
        status: ["pending", "connected", "paused", "error"].includes(input.status) ? input.status : "pending",
        settings: input.settings && typeof input.settings === "object" ? input.settings : {},
        assigned_tenant_ids: assigned,
      },
    });
    return json(row);
  }

  const mIntegration = url.pathname.match(/^\/admin\/api\/integrations\/([0-9a-f-]{36})$/);
  if (mIntegration && request.method === "PATCH") {
    const input = pick(await request.json(), INTEGRATION_FIELDS);
    delete input.project_id;
    delete input.provider;
    delete input.category;
    if (input.name !== undefined) input.name = String(input.name).trim().slice(0, 100);
    if (input.status !== undefined && !["pending", "connected", "paused", "error"].includes(input.status)) {
      return json({ error: "estado no valido" }, 400);
    }
    if (input.settings !== undefined && (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings))) {
      return json({ error: "configuracion no valida" }, 400);
    }
    if (input.assigned_tenant_ids !== undefined) {
      const [current] = await sb(env, "project_integrations?id=eq." + mIntegration[1] + "&select=project_id");
      if (!current) return json({ error: "integracion no encontrada" }, 404);
      const tenants = await sb(env, "tenants?project_id=eq." + current.project_id + "&select=id");
      const allowed = new Set((tenants || []).map((t) => t.id));
      input.assigned_tenant_ids = (Array.isArray(input.assigned_tenant_ids) ? input.assigned_tenant_ids : [])
        .filter((id) => allowed.has(id));
    }
    input.updated_at = new Date().toISOString();
    const rows = await sb(env, `project_integrations?id=eq.${mIntegration[1]}`, { method: "PATCH", body: input });
    if (!rows?.length) return json({ error: "integración no encontrada" }, 404);
    return json(rows[0]);
  }
  if (mIntegration && request.method === "DELETE") {
    await sb(env, `project_integrations?id=eq.${mIntegration[1]}`, { method: "DELETE" });
    return json({ ok: true });
  }

  const mIntegrationCheck = url.pathname.match(/^\/admin\/api\/integrations\/([0-9a-f-]{36})\/check$/);
  if (mIntegrationCheck && request.method === "POST") {
    const [integration] = await sb(env, `project_integrations?id=eq.${mIntegrationCheck[1]}`);
    if (!integration) return json({ error: "integración no encontrada" }, 404);
    const required = {
      web: ["domain"], whatsapp: ["phone_number"], telegram: ["bot_username"],
      google_drive: ["folder_name"], email: ["sender"], webhook: ["endpoint"],
      crm: ["workspace"], calendar: ["calendar_name"], zapier_make: ["endpoint"],
    }[integration.provider] || [];
    const missing = required.filter((key) => !integration.settings?.[key]);
    const status = missing.length ? "error" : "connected";
    const errorMessage = missing.length ? `Falta configurar: ${missing.join(", ")}` : null;
    const now = new Date().toISOString();
    const [row] = await sb(env, `project_integrations?id=eq.${integration.id}`, {
      method: "PATCH",
      body: { status, error_message: errorMessage, last_checked_at: now, updated_at: now },
    });
    return json(row);
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

function brandAppHtml(html) {
  return html
    .replace("</style>", APP_BRAND_CSS + "</style>")
    .replaceAll("/brand/logo.png", "/brand/wordmark-light.svg");
}
const ADMIN_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
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
  #main{min-width:0}
  aside{min-width:0}
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
  /* ===== Estudio: skin de controles de configuración ===== */
  .card label,.ft label{font-weight:600;color:var(--ink);font-size:12.5px;margin:15px 0 5px}
  .card label .lh,.ft label .lh{display:block;font-weight:400;color:var(--mut);font-size:11.5px;margin-top:2px}
  .card input,.card select,.card textarea{border-radius:9px;padding:10px 12px}
  .card input:focus,.card select:focus,.card textarea:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(245,190,16,.16)}
  .card input[type=color]{width:54px!important;height:36px!important;padding:3px!important;border-radius:9px!important;
    border:1px solid var(--line)!important;cursor:pointer;flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(0,0,0,.04)}
  .card input[type=range]{-webkit-appearance:none;appearance:none;height:5px;border-radius:99px;background:var(--line);padding:0;border:0}
  .card input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;
    background:var(--ink);border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.28);cursor:pointer}
  .card input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--ink);border:3px solid #fff}
  .check{margin-top:12px;gap:11px}
  .check input[type=checkbox]{appearance:none;-webkit-appearance:none;width:44px;height:26px;border-radius:99px;
    background-color:#cfcfc9;background-image:radial-gradient(circle 9px at center,#fff 96%,transparent);
    background-repeat:no-repeat;background-size:26px 26px;background-position:left center;
    transition:background-color .2s,background-position .2s;cursor:pointer;border:0;flex:0 0 auto}
  .check input[type=checkbox]:checked{background-color:var(--acc);background-position:right center}
  .check input[type=checkbox]:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
  .check label{margin:0!important;font-weight:500;color:var(--ink);font-size:13.5px}
  .seg{border-radius:9px}
  .seg button.on{background:var(--ink);color:#fff}
  .ftabs button{border-radius:99px;padding:7px 15px;font-weight:600;background:#fff}
  .ftabs button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
  /* secciones plegables de configuración */
  details.cfg{border:1px solid var(--line);border-radius:13px;background:#fff;margin:12px 0;overflow:hidden}
  details.cfg>summary{list-style:none;cursor:pointer;padding:14px 16px;display:flex;align-items:center;gap:12px;user-select:none}
  details.cfg>summary::-webkit-details-marker{display:none}
  details.cfg>summary .ci{width:32px;height:32px;border-radius:9px;background:var(--soft,#f7f1dd);display:grid;place-items:center;flex:0 0 auto;color:var(--ink)}
  details.cfg>summary .ci svg{width:17px;height:17px}
  details.cfg>summary .ct{font-weight:700;font-size:14px;color:var(--ink)}
  details.cfg>summary .cs{font-size:11.5px;color:var(--mut);font-weight:400;margin-top:1px}
  details.cfg>summary .cv{margin-left:auto;color:var(--mut);transition:transform .2s;flex:0 0 auto}
  details.cfg[open]>summary .cv{transform:rotate(90deg)}
  details.cfg>.cfgb{padding:2px 16px 18px;border-top:1px solid var(--line)}
  .cfgrow{display:flex;align-items:center;gap:14px;justify-content:space-between;margin-top:14px}
  .cfgrow .cfgl{font-size:12.5px;font-weight:600;color:var(--ink)}
  .cfgrow .cfgl small{display:block;font-weight:400;color:var(--mut);font-size:11px;margin-top:1px}
  .cfgrow input[type=range]{max-width:180px}
  .cfgval{font:600 12px ui-monospace,monospace;color:var(--mut);min-width:56px;text-align:right;flex:0 0 auto}
  .cfg-ai{background:linear-gradient(180deg,var(--soft,#f7f1dd),#fff);border:1px solid var(--acc);border-radius:13px;padding:14px 16px;margin:4px 0 14px}
  .cfg-ai-h{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink)}
  .cfg-ai .actions{margin-top:8px}
  /* color: popover-btn como chip (igual que la plantilla) */
  .cp-btn{width:54px!important;height:36px!important;border-radius:9px!important;padding:0!important;flex:0 0 auto}
  .cp-btn.mini{width:46px!important}
  /* fila de swatches + hex del color principal (plantilla) */
  #ft-ap .swatches{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px}
  #ft-ap .swatches .sw{width:30px;height:30px;border-radius:8px;border:2px solid transparent;
    box-shadow:inset 0 0 0 1px rgba(0,0,0,.12);cursor:pointer;padding:0}
  #ft-ap .swatches .sw.on{border-color:var(--ink)}
  #ft-ap .hexbox{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:8px;
    padding:6px 10px;width:132px;background:#fff}
  #ft-ap .hexbox span{width:16px;height:16px;border-radius:4px;flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}
  #ft-ap .hexbox input{border:0!important;outline:0;font-family:ui-monospace,monospace;font-size:12.5px;
    width:100%;background:transparent!important;padding:0!important;text-transform:uppercase;box-shadow:none!important}
  /* galería de iconos estilo plantilla */
  #ft-ap .icopick{display:grid;grid-template-columns:repeat(6,1fr);gap:7px}
  #ft-ap .icopick button{width:auto;height:auto;aspect-ratio:1;border-radius:8px}
  /* segmentados (Forma/Modo/Posición/Tamaño) como la plantilla */
  #ft-ap .segfull{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;border:1px solid var(--line);
    border-radius:8px;overflow:hidden;margin-top:2px}
  #ft-ap .segfull button{border:0;background:#fff;padding:9px 6px;font-size:12.5px;font-weight:600;
    color:var(--mut);border-right:1px solid var(--line);cursor:pointer}
  #ft-ap .segfull button:last-child{border-right:0}
  #ft-ap .segfull button.on{background:var(--ink);color:#fff}
  /* en Diseño ocultamos cabecera nombre/slug: empieza en las secciones */
  #v-tenant.dsn-only .tenant-head{display:none}
  #v-tenant.dsn-only{padding-top:16px}
  /* interruptor exacto de la plantilla (riel + bolita) */
  #ft-ap .swrow{display:flex;align-items:center;gap:14px;justify-content:space-between;margin-top:4px}
  #ft-ap .swrow .swlab{font-size:12.5px;font-weight:600;color:var(--ink)}
  #ft-ap .swrow .swlab small{display:block;font-weight:400;color:var(--mut);font-size:11px;margin-top:1px}
  #ft-ap .switch{position:relative;width:44px;height:26px;flex:0 0 auto;margin:0;display:inline-block}
  #ft-ap .switch input{opacity:0;width:100%;height:100%;margin:0;cursor:pointer;position:absolute;inset:0;z-index:2}
  #ft-ap .switch .track{position:absolute;inset:0;border-radius:99px;background:#cfcfc9;transition:.2s;pointer-events:none}
  #ft-ap .switch .knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.25);pointer-events:none}
  #ft-ap .switch input:checked ~ .track{background:var(--acc)}
  #ft-ap .switch input:checked ~ .knob{left:21px}
  /* chips de color un poco mas compactos, redondeados como la plantilla */
  #ft-ap input[type=color]{width:44px!important;height:34px!important;border-radius:8px!important}
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
  #main.with-canvas{display:grid;grid-template-columns:minmax(0,1fr) 440px;gap:22px;align-items:start}
  #main.with-canvas>#crumb{grid-column:1 / -1;margin-bottom:0;order:1}
  #main.with-canvas>#bot-tabs{grid-column:1 / -1;order:2}
  #main.with-canvas>#canvas-panel{order:3}
  #main.with-canvas>#edit-col{order:4}
  @media(max-width:1100px){#main.with-canvas>#canvas-panel{order:5}}
  #canvas-panel{min-width:0}
  #cv-sticky{position:sticky;top:74px}
  #cv-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:10px;flex-wrap:wrap}
  .cv-eyebrow{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}
  .cv-tools{display:flex;align-items:center;gap:8px}
  .cv-vp{display:inline-flex;background:#fff;border:1px solid var(--line);border-radius:99px;padding:3px}
  .cv-vp button{border:0;background:transparent;border-radius:99px;padding:5px 12px;font-size:12px;font-weight:600;color:var(--mut);cursor:pointer}
  .cv-vp button.on{background:var(--ink);color:#fff}
  #cv-frame.cv-mobile{align-items:center}
  #cv-frame.cv-mobile #cv-widget{width:320px}
  #cv-frame.cv-mobile #cv-btnrow{justify-content:center;width:320px}
  #cv-frame{background:
      radial-gradient(120% 80% at 80% 0%,rgba(245,190,16,.10),transparent 55%),
      repeating-linear-gradient(90deg,rgba(10,16,46,.028) 0 1px,transparent 1px 108px),
      var(--bg);
    border:1px solid var(--line);border-radius:8px;padding:22px;min-height:520px;
    display:flex;flex-direction:column;align-items:flex-end;justify-content:flex-end;gap:14px}
  #cv-widget{width:334px;max-width:100%;border-radius:16px;overflow:hidden;display:flex;flex-direction:column;
    background:#fff;box-shadow:0 18px 50px rgba(10,10,10,.22)}
  #cv-h{display:flex;align-items:center;gap:11px;padding:13px 15px;background:#f5be10;color:#0a0a0a}
  #cv-av{width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,.16);display:grid;
    place-items:center;font-weight:700;overflow:hidden;flex:0 0 auto}
  #cv-av img{width:100%;height:100%;object-fit:cover}
  #cv-av svg{width:20px;height:20px}
  #cv-name{font-weight:700;font-size:14px;line-height:1.15}
  #cv-sub{font-size:11.5px;opacity:.8;line-height:1.25}
  #cv-log{padding:14px;display:flex;flex-direction:column;gap:9px;min-height:150px;max-height:340px;
    overflow-y:auto;background-size:cover;background-position:center}
  .cv-b{background:#f1f1ee;color:#141414;border-radius:14px;border-bottom-left-radius:4px;
    padding:9px 12px;font-size:13px;line-height:1.45;max-width:82%;align-self:flex-start}
  .cv-m{border-radius:14px;border-bottom-right-radius:4px;padding:9px 12px;font-size:13px;line-height:1.45;
    max-width:82%;align-self:flex-end;background:#f5be10;color:#0a0a0a}
  #cv-sug{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0 6px}
  #cv-sug span{border:1px solid var(--line);border-radius:14px;padding:6px 11px;font-size:12px;
    background:transparent;color:#333;cursor:pointer}
  #cv-foot{display:flex;gap:8px;padding:11px 12px;border-top:1px solid rgba(0,0,0,.08);align-items:center}
  #cv-in{flex:1;border:1px solid var(--line);border-radius:11px;padding:9px 12px;font-size:13px;color:#999;
    background:#fff;font-family:inherit;min-width:0;outline:0}
  #cv-send{width:38px;height:38px;border-radius:11px;background:#f5be10;display:flex;align-items:center;
    justify-content:center;flex:0 0 auto;font-weight:600;cursor:pointer}
  .cv-typing{opacity:.65}
  #cv-brand{text-align:center;font-size:11px;color:#8a8a86;padding:8px 10px;background:#fff;
    border-top:1px solid rgba(0,0,0,.05)}
  #cv-btnrow{display:flex;justify-content:flex-end}
  #cv-btn{width:58px;height:58px;min-width:58px;border-radius:50%;background:#f5be10;display:flex;gap:8px;position:relative;
    align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(0,0,0,.22);padding:0}
  #cv-btn.radar:before,#cv-btn.radar:after{content:"";position:absolute;inset:-1px;border:1px solid var(--preview-radar,#f5be10);
    border-radius:inherit;animation:preview-radar 2.4s ease-out infinite;pointer-events:none}
  #cv-btn.radar:after{animation-delay:1.2s}@keyframes preview-radar{to{opacity:0;transform:scale(1.65)}}
  #cv-btn.beat{animation:cv-beat 1.5s ease-in-out infinite}@keyframes cv-beat{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
  #cv-btn.bounce{animation:cv-bounce 1.7s ease infinite}@keyframes cv-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
  #cv-btn.glow{animation:cv-glow 1.9s ease-in-out infinite}@keyframes cv-glow{0%,100%{box-shadow:0 4px 14px rgba(0,0,0,.2)}50%{box-shadow:0 4px 14px rgba(0,0,0,.2),0 0 0 5px rgba(245,190,16,.16),0 0 20px 4px var(--preview-radar,#f5be10)}}
  #cv-btn.shake{animation:cv-shake 3.2s ease infinite}@keyframes cv-shake{0%,90%,100%{transform:rotate(0)}92%{transform:rotate(-9deg)}94%{transform:rotate(9deg)}96%{transform:rotate(-6deg)}98%{transform:rotate(4deg)}}
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
  .twrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .twrap table.home{min-width:600px}
  @media(max-width:760px){
    body{overflow-x:hidden}
    aside{display:none}
    aside.open{display:block}
    #menu-btn{display:inline-block}
    header{padding:10px 12px;gap:6px}
    header>div:last-child{display:flex;gap:6px;align-items:center;flex:none}
    header .ghost.small{padding:6px 9px;font-size:12.5px}
    #logout{margin-left:0!important}
    .brand{font-size:16px;gap:7px;min-width:0}
    .brand svg{width:24px;height:21px}
    .brand em{display:none}
    .wrap{padding:12px 10px;gap:12px}
    .card{padding:16px 14px;border-radius:14px}
    .kpi{min-width:calc(50% - 6px)}
    .kpi b{font-size:20px}
    #crumb{font-size:12.5px}
    #bot-tabs button{padding:8px 11px;font-size:13px}
    #cv-frame{padding:10px}
    .copyrow{flex-wrap:wrap}
    .copyrow input,.copyrow textarea{min-width:0}
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
    <div class="brand" style="margin-bottom:12px"><img src="/brand/logo.png" alt="ExpoBot" style="height:34px;width:auto;display:block"></div>
    <h1>Bienvenido a tu estudio</h1>
    <p class="mut">Introduce tu clave de acceso para gestionar tus clientes y sus asistentes.</p>
    <input id="tok" type="password" placeholder="Token" autocomplete="current-password"
      autocapitalize="off" autocorrect="off" spellcheck="false">
    <button id="enter" class="primary">Entrar</button>
    <button id="paste-tok" class="ghost" type="button" style="width:100%;margin-top:10px"><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2.5" width="8" height="4" rx="1"/></svg> Pegar el token y entrar</button>
    <p id="login-err" class="err"></p>
  </div>
</div>

<div id="app" class="hide">
  <header>
    <div class="brand"><img src="/brand/logo.png" alt="ExpoBot" style="height:34px;width:auto;display:block"><em>estudio de asistentes IA</em></div>
    <div>
      <button id="menu-btn" class="ghost small"><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg> Menú</button>
      <button id="search-btn" class="ghost small" title="Ctrl+K"><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg> Buscar</button>
      <button id="logout" class="ghost small" style="margin-left:8px">Salir</button>
    </div>
  </header>
  <div class="wrap">
    <aside class="admin-sidebar">
      <div class="side-caption">PLATAFORMA</div>
      <nav class="admin-nav" aria-label="Navegación principal">
        <button id="home-btn" data-global="home"><span>⌂</span>Inicio</button>
        <button id="clients-btn" data-global="clients"><span>◎</span>Clientes</button>
        <button id="projects-btn" data-global="projects"><span>□</span>Proyectos</button>
        <button id="leads-btn" data-global="leads"><span>↗</span>Leads</button>
        <button id="ops-btn" data-global="ops"><span>!</span>Operaciones</button>
        <button id="templates-btn" data-global="templates"><span>◇</span>Plantillas</button>
      </nav>
      <button id="new-client" class="primary side-create">+ Nuevo cliente</button>
      <div class="side-caption side-recent">CLIENTES RECIENTES</div>
      <div id="tree" aria-label="Clientes recientes"></div>
      <button id="settings-btn" class="side-settings"><span><svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l1.7-1.3-1.7-3-2 .8a7.6 7.6 0 0 0-1.8-1L15 4H9l-.6 2.5a7.6 7.6 0 0 0-1.8 1l-2-.8-1.7 3L4.6 11a7.6 7.6 0 0 0 0 2l-1.7 1.3 1.7 3 2-.8a7.6 7.6 0 0 0 1.8 1L9 20h6l.6-2.5a7.6 7.6 0 0 0 1.8-1l2 .8 1.7-3z"/></svg></span>Administración</button>
    </aside>
    <main id="main" class="hide">

      <p id="crumb" class="mut"></p>

      <div id="bot-tabs" class="hide context-tabs" aria-label="Secciones del asistente">
        <button data-bt="resumen" class="on">Resumen</button>
        <button data-bt="cerebro">Objetivo y comportamiento</button>
        <button data-bt="contenido">Conocimiento</button>
        <button data-bt="diseno">Diseño</button>
        <button data-bt="captacion">Captación</button>
        <button data-bt="canales">Canales</button>
        <button data-bt="calidad">Pruebas</button>
        <button data-bt="publicar">Publicar</button>
      </div>

      <div id="edit-col">

      <div class="card hide" id="v-wizard">
        <h2><svg class="ic" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16l-1.7-4.8L5.5 9.5l4.8-1.7z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg> Nuevo cliente en un paso</h2>
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
        <h2><svg class="ic" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg> Listo para publicar</h2>
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
        <div class="twrap"><table class="home">
          <thead><tr><th>Chatbot</th><th>Cliente</th><th>Preguntas</th><th>Leads</th><th>Sin respuesta</th><th>Estado</th></tr></thead>
          <tbody id="home-body"></tbody>
        </table></div>
        <label style="margin-top:20px"><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/></svg> Últimos leads
          <button id="home-leads-all" class="ghost small" style="margin-left:8px">Ver todos</button></label>
        <div id="home-leads" class="mut">Cargando…</div>
        <label style="margin-top:20px"><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M3 12h4l2.5 7 5-14L17 12h4"/></svg> Salud del motor — últimos errores registrados</label>
        <div id="home-errors" class="mut">Cargando…</div>
      </div>

      <div class="card hide" id="v-leads">
        <h2><svg class="ic" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/></svg> Leads de todos los clientes</h2>
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

      <section class="workspace-view hide" id="v-clients">
        <div class="page-heading"><div><p class="section-kicker">CARTERA</p><h1>Clientes</h1><p>Organizaciones, responsables, proyectos y accesos.</p></div><button id="clients-new-inline" class="primary">+ Nuevo cliente</button></div>
        <div class="list-toolbar"><input id="clients-search" type="search" placeholder="Buscar cliente, contacto o email"><span id="clients-count" class="mut"></span></div>
        <div class="data-surface"><table class="home"><thead><tr><th>Cliente</th><th>Contacto</th><th>Proyectos</th><th>Asistentes</th><th>Portal</th><th></th></tr></thead><tbody id="clients-body"></tbody></table></div>
      </section>

      <section class="workspace-view hide" id="v-projects">
        <div class="page-heading"><div><p class="section-kicker">ENTREGA</p><h1>Proyectos</h1><p>Todos los espacios de trabajo y su estado operativo.</p></div></div>
        <div class="list-toolbar"><input id="projects-search" type="search" placeholder="Buscar proyecto o cliente"><select id="projects-status"><option value="">Todos</option><option value="active">Con asistentes activos</option><option value="empty">Sin asistentes</option></select><span id="projects-count" class="mut"></span></div>
        <div class="data-surface"><table class="home"><thead><tr><th>Proyecto</th><th>Cliente</th><th>Asistentes</th><th>Integraciones</th><th>Estado</th><th></th></tr></thead><tbody id="projects-body"></tbody></table></div>
      </section>

      <section class="workspace-view hide" id="v-ops">
        <div class="page-heading"><div><p class="section-kicker">CONTROL</p><h1>Operaciones</h1><p>Lo que necesita atención en toda la plataforma.</p></div><button id="ops-refresh" class="ghost">Actualizar</button></div>
        <div class="ops-grid">
          <div class="ops-stat"><span>Asistentes apagados</span><strong id="ops-off">0</strong></div>
          <div class="ops-stat"><span>Proyectos sin asistente</span><strong id="ops-empty">0</strong></div>
          <div class="ops-stat"><span>Integraciones con error</span><strong id="ops-integration-errors">0</strong></div>
          <div class="ops-stat"><span>Errores recientes</span><strong id="ops-error-count">0</strong></div>
        </div>
        <div class="data-surface ops-list"><div class="surface-head"><h2>Incidencias recientes</h2><span>Últimos registros del motor</span></div><div id="ops-errors" class="mut">Cargando…</div></div>
      </section>

      <section class="workspace-view hide" id="v-templates">
        <div class="page-heading"><div><p class="section-kicker">REUTILIZAR</p><h1>Plantillas</h1><p>Puntos de partida consistentes para nuevos asistentes.</p></div></div>
        <div class="template-grid">
          <article class="template-card"><span>RECINTO FERIAL</span><h2>Información del recinto</h2><p>Accesos, pabellones, aparcamiento, servicios y derivación humana.</p><button class="ghost" data-template="venue">Usar plantilla</button></article>
          <article class="template-card"><span>ORGANIZADOR</span><h2>Atención y captación</h2><p>Programa, entradas, expositores y solicitudes comerciales.</p><button class="ghost" data-template="organizer">Usar plantilla</button></article>
          <article class="template-card"><span>CORPORATIVO</span><h2>Asistente de empresa</h2><p>Atención general, preguntas frecuentes y captación de contactos.</p><button class="ghost" data-template="business">Usar plantilla</button></article>
        </div>
      </section>

      <section class="workspace-view hide" id="v-settings">
        <div class="page-heading"><div><p class="section-kicker">SISTEMA</p><h1>Administración</h1><p>Accesos, seguridad y estado de la plataforma.</p></div></div>
        <div class="settings-grid"><div><h2>Sesión administrativa</h2><p>La sesión está protegida y utiliza credenciales privadas del Worker.</p><button id="settings-logout" class="ghost">Cerrar sesión</button></div><div><h2>Despliegue</h2><p>Cloudflare Worker, Supabase y repositorio conectados.</p><a class="ghost link-button" href="https://github.com/baquetasjgt/chatbot-platform" target="_blank" rel="noopener">Abrir repositorio</a></div></div>
      </section>

      <div class="context-shell hide" id="v-client-nav">
        <div class="context-heading"><div><p class="section-kicker">CLIENTE</p><h1 id="client-context-title">Cliente</h1><p id="client-context-meta"></p></div><button id="client-add-project" class="primary">+ Proyecto</button></div>
        <div class="context-tabs"><button data-client-section="profile" class="on">Ficha</button><button data-client-section="projects">Proyectos</button><button data-client-section="access">Accesos</button><button data-client-section="billing">Facturación</button></div>
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
        <p class="sub">Las facturas de este cliente; él las ve y descarga desde su portal.
        Emite <b>una factura por cada producto facturable</b>, con su periodo correspondiente.</p>
        <div id="inv-list" class="mut">Cargando…</div>
        <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
        <div class="row">
          <div><label>Número</label><input id="iv-num" placeholder="2026-001"></div>
          <div><label>Importe total (€, IVA incl.)</label><input id="iv-amt" type="number" step="0.01" min="0"></div>
        </div>
        <div class="row">
          <div><label>Fecha de emisión</label><input id="iv-date" type="date"></div>
          <div><label>Estado</label>
            <select id="iv-status">
              <option value="pendiente">Pendiente</option>
              <option value="pagada">Pagada</option>
            </select></div>
        </div>
        <div class="row">
          <div><label>Periodo de facturación · desde</label><input id="iv-pstart" type="date"></div>
          <div><label>Periodo · hasta</label><input id="iv-pend" type="date"></div>
        </div>
        <label>Producto / concepto facturable</label>
        <input id="iv-concept" placeholder="Chatbot FISIOEXPO — cuota mensual">
        <label>PDF de la factura (opcional)</label>
        <input id="iv-pdf" type="file" accept=".pdf">
        <p class="mut" style="margin:6px 0 0">Si no adjuntas un PDF, se genera automáticamente una factura con la imagen de marca de ExpoBot.</p>
        <div class="actions">
          <button id="iv-add" class="primary">Añadir factura</button>
          <span id="iv-msg" class="mut"></span>
        </div>
      </div>

      <div class="context-shell hide" id="v-project-nav">
        <div class="context-heading"><div><p class="section-kicker">PROYECTO</p><h1 id="project-context-title">Proyecto</h1><p id="project-context-meta"></p></div><button id="project-add-bot" class="primary">+ Asistente</button></div>
        <div class="context-tabs"><button data-project-section="overview" class="on">Resumen</button><button data-project-section="assistants">Asistentes</button><button data-project-section="integrations">Integraciones</button><button data-project-section="knowledge">Conocimiento</button><button data-project-section="settings">Configuración</button></div>
      </div>

      <section class="workspace-view hide" id="v-project-overview">
        <div class="project-summary-grid"><div><span>Asistentes</span><strong id="project-bot-count">0</strong><small id="project-bot-status">Sin asistentes</small></div><div><span>Integraciones</span><strong id="project-integration-count">0</strong><small id="project-integration-status">Sin conexiones</small></div><div><span>Conocimiento</span><strong id="project-doc-count">—</strong><small>Fuentes del proyecto</small></div></div>
        <div class="data-surface"><div class="surface-head"><div><h2>Actividad del proyecto</h2><span>Estado de asistentes y conexiones</span></div></div><div id="project-activity" class="empty-state">Selecciona una sección para configurar el proyecto.</div></div>
      </section>

      <section class="workspace-view hide" id="v-project-integrations">
        <div class="section-heading-row"><div><h2>Integraciones</h2><p>Conecta una vez en el proyecto y asigna la conexión a los asistentes que la necesiten.</p></div><button id="integration-add" class="primary">+ Añadir integración</button></div>
        <div class="integration-catalog" id="integration-catalog">
          <button data-provider="web"><b>WWW</b><span>Web</span><small>Canal</small></button>
          <button data-provider="whatsapp"><b>WA</b><span>WhatsApp</span><small>Canal</small></button>
          <button data-provider="telegram"><b>TG</b><span>Telegram</span><small>Canal</small></button>
          <button data-provider="google_drive"><b>GD</b><span>Google Drive</span><small>Conocimiento</small></button>
          <button data-provider="webhook"><b>WH</b><span>Webhook</span><small>Ventas</small></button>
          <button data-provider="crm"><b>CRM</b><span>CRM</span><small>Ventas</small></button>
          <button data-provider="email"><b>@</b><span>Email</span><small>Comunicación</small></button>
          <button data-provider="calendar"><b>CAL</b><span>Calendar</span><small>Agenda</small></button>
        </div>
        <div id="project-integrations-list" class="integration-list"></div>
        <div id="integration-editor" class="integration-editor hide">
          <div class="surface-head"><div><p class="section-kicker">CONFIGURAR</p><h2 id="pi-title">Integración</h2></div><button id="pi-close" class="icon-close" aria-label="Cerrar">×</button></div>
          <input id="pi-id" type="hidden"><input id="pi-provider" type="hidden">
          <div class="row"><div><label>Nombre de la conexión</label><input id="pi-name"></div><div><label>Estado</label><select id="pi-status"><option value="pending">Pendiente</option><option value="connected">Conectada</option><option value="paused">Pausada</option><option value="error">Error</option></select></div></div>
          <div id="pi-settings"></div>
          <label>Asistentes que utilizan esta conexión</label><div id="pi-bots" class="assignment-list"></div>
          <div class="actions"><button id="pi-save" class="primary">Guardar conexión</button><button id="pi-check" class="ghost">Comprobar</button><button id="pi-delete" class="ghost danger">Eliminar</button><span id="pi-msg" class="mut"></span></div>
        </div>
      </section>

      <section class="workspace-view hide" id="v-project-knowledge">
        <div class="section-heading-row"><div><h2>Conocimiento compartido</h2><p>Fuentes que pueden reutilizar varios asistentes del proyecto.</p></div></div><div class="empty-state">Conecta Google Drive o crea un asistente para incorporar documentos y URLs.</div>
      </section>
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

      <section class="workspace-view hide" id="v-bot-overview">
        <div class="bot-overview-head"><div><p class="section-kicker">ASISTENTE</p><h1 id="bot-overview-title">Asistente</h1><p id="bot-overview-meta"></p></div><span id="bot-overview-status" class="status-pill">Borrador</span></div>
        <div class="project-summary-grid"><div><span>Conocimiento</span><strong id="bot-doc-count">0</strong><small>Fuentes indexadas</small></div><div><span>Canales</span><strong id="bot-channel-count">0</strong><small>Integraciones asignadas</small></div><div><span>Estado</span><strong id="bot-ready-score">0%</strong><small>Preparación para publicar</small></div></div>
        <div class="data-surface"><div class="surface-head"><div><h2>Siguientes pasos</h2><span>Completa lo esencial antes de publicar</span></div></div><div id="bot-next-steps"></div></div>
      </section>

      <section class="workspace-view hide" id="v-bot-channels">
        <div class="section-heading-row"><div><h2>Canales e integraciones</h2><p>Conexiones disponibles en el proyecto y asignadas a este asistente.</p></div><button id="bot-manage-integrations" class="ghost">Gestionar en el proyecto</button></div><div id="bot-integration-list" class="integration-list"></div>
      </section>
      <div class="card hide" id="v-assist">
        <div id="bot-creation-progress" class="creation-progress hide" aria-label="Proceso de creacion">
          <span class="on"><b>1</b> Objetivo</span><span><b>2</b> Configuracion</span><span><b>3</b> Revisar y guardar</span>
        </div>
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
        <h2><svg class="ic" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.8 3 3 6 3s6-1.2 6-3v-5"/></svg> Examen del bot</h2>
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
        <div class="tenant-head">
        <h2 id="f-title">Chatbot</h2>
        <p class="sub">Los cambios se aplican al guardar. El bot los usa en la siguiente conversación.</p>
        <div class="row">
          <div><label>Nombre (lo ve el usuario en el chat)</label><input id="f-name"></div>
          <div><label>Nombre interno (se rellena solo; no lo verá nadie)</label><input id="f-slug"></div>
        </div>
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
          <label>Pregunta de clasificación al abrir el chat (opcional)</label>
          <input id="f-qualq" placeholder="Para ayudarte mejor, cuéntame quién eres:">
          <label>Opciones de respuesta (una por línea, máx. 4; vacío = sin pregunta)</label>
          <textarea id="f-qualopts" rows="2" placeholder="Soy expositor&#10;Soy visitante"></textarea>
          <p class="mut" style="margin-top:4px">El visitante elige con un botón antes de empezar; su elección
          clasifica el lead (si la opción contiene «expositor», «visitante» o «prensa») y el bot la conoce.</p>
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
          <div class="cfg-ai">
            <div class="cfg-ai-h"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16l-1.7-4.8L5.5 9.5l4.8-1.7z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg> <b>Diseñar con IA</b></div>
            <p class="mut" style="margin:4px 0 8px">Analiza la web del cliente (el primer dominio de «Seguridad y límites») y propone 3 diseños completos. Elige uno: se vuelca en los controles y lo retocas antes de guardar.</p>
            <textarea id="ds-brief" rows="2" placeholder="Ej.: moderno y llamativo respetando el azul corporativo; una opción oscura y elegante; tipografía con personalidad."></textarea>
            <div class="actions" style="margin:8px 0 4px">
              <button id="ds-run" class="ghost small"><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16l-1.7-4.8L5.5 9.5l4.8-1.7z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg> Proponer 3 diseños</button>
              <span id="ds-msg" class="mut"></span>
            </div>
            <div id="ds-options"></div>
          </div>

          <details class="cfg" open>
            <summary><span class="ci"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 4v5c0 4-3 7-7 9-4-2-7-5-7-9V7z"/></svg></span>
              <div><div class="ct">Identidad y colores</div><div class="cs">Colores, tipografía, logo, cabecera</div></div>
              <span class="cv"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span></summary>
            <div class="cfgb">
              <label>Color principal <span class="lh">cabecera, botón, mensajes del usuario</span></label>
              <div class="swatches" id="prim-sw">
                <button type="button" class="sw" data-c="#f5be10" style="background:#f5be10"></button>
                <button type="button" class="sw" data-c="#1e9e5c" style="background:#1e9e5c"></button>
                <button type="button" class="sw" data-c="#2e8fe6" style="background:#2e8fe6"></button>
                <button type="button" class="sw" data-c="#e0533d" style="background:#e0533d"></button>
                <button type="button" class="sw" data-c="#6b4eff" style="background:#6b4eff"></button>
                <button type="button" class="sw" data-c="#0a0a0a" style="background:#0a0a0a"></button>
                <input id="f-color" type="color">
                <div class="hexbox"><span id="prim-hexdot"></span><input id="prim-hex" spellcheck="false" maxlength="7" placeholder="#000000"></div>
              </div>
              <div class="row">
                <div><label>Color de las respuestas del bot</label>
                  <input id="f-color2" type="color" value="#f2f2f0"></div>
                <div><label>Color de la cabecera</label>
                  <input id="f-colorhead" type="color" value="#111111"></div>
              </div>
              <div><label>Color de bordes y controles</label>
                <input id="f-controlborder" type="color" value="#d9d9d4"></div>
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
              <label>Isotipo o avatar <span class="lh">URL de una imagen cuadrada; vacío = inicial del nombre</span></label>
              <input id="f-logo" type="url" placeholder="https://cliente.com/isotipo.svg">
              <label>Logotipo de cabecera <span class="lh">opcional; sustituye el nombre escrito</span></label>
              <input id="f-wordmark" type="url" placeholder="https://cliente.com/logotipo.svg">
              <label>Subtítulo de la cabecera</label>
              <input id="f-subtitle" placeholder="Suele responder al instante">
            </div>
          </details>

          <details class="cfg">
            <summary><span class="ci"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/></svg></span>
              <div><div class="ct">Botón flotante</div><div class="cs">Icono, tamaño, borde, efecto, posición</div></div>
              <span class="cv"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span></summary>
            <div class="cfgb">
              <label>Icono del botón del chat</label>
              <div class="icopick" id="pick-btn"></div>
              <div class="cfgrow"><div class="cfgl">Tamaño del icono <small>dentro del botón</small></div>
                <input id="f-iconsize" type="range" min="28" max="72" step="2" value="46"><span class="cfgval"><span id="f-iconsize-v">46</span> %</span></div>
              <label>Isotipo personalizado del botón <span class="lh">URL; sustituye el icono elegido</span></label>
              <input id="f-btnicon" type="url" placeholder="https://cliente.com/isotipo.svg">
              <div class="row">
                <div><label>Fondo del botón</label><input id="f-btnbg" type="color" value="#111111"></div>
                <div><label>Color del borde</label><input id="f-btnborder" type="color" value="#f5be10"></div>
              </div>
              <div class="swrow"><span class="swlab">Mostrar borde en el botón</span><label class="switch"><input id="f-btnborderon" type="checkbox"><span class="track"></span><span class="knob"></span></label></div>
              <div class="cfgrow"><div class="cfgl">Grosor del borde</div>
                <input id="f-btnborderw" type="range" min="1" max="8" value="2"><span class="cfgval"><span id="f-btnborderw-v">2</span> px</span></div>
              <div class="row">
                <div><label>Efecto de llamada de atención</label>
                  <select id="f-effect">
                    <option value="ninguno">Ninguno</option>
                    <option value="radar">Radar (ondas)</option>
                    <option value="latido">Latido</option>
                    <option value="rebote">Rebote</option>
                    <option value="brillo">Brillo</option>
                    <option value="sacudida">Sacudida</option>
                  </select></div>
                <div><label>Color del efecto</label><input id="f-radarcolor" type="color" value="#f5be10"></div>
              </div>
              <div class="row">
                <div><label>Forma del botón</label>
                  <select id="f-btnshape">
                    <option value="circulo">Círculo</option>
                    <option value="redondeado">Cuadrado redondeado</option>
                    <option value="pastilla">Pastilla con texto</option>
                  </select></div>
                <div><label>Texto de la pastilla <span class="lh">si eliges esa forma</span></label>
                  <input id="f-btnlabel" placeholder="Chat"></div>
              </div>
              <label>Posición en la web</label>
              <select id="f-side">
                <option value="derecha">Abajo a la derecha</option>
                <option value="izquierda">Abajo a la izquierda</option>
              </select>
            </div>
          </details>

          <details class="cfg">
            <summary><span class="ci"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg></span>
              <div><div class="ct">Ventana de chat</div><div class="cs">Esquinas, sombra, borde, fondo, modo</div></div>
              <span class="cv"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span></summary>
            <div class="cfgb">
              <div class="cfgrow"><div class="cfgl">Redondez de bordes</div>
                <input id="f-radius" type="range" min="0" max="24" step="2" value="14"><span class="cfgval"><span id="f-radius-v">14</span> px</span></div>
              <div class="row">
                <div><label>Sombras</label>
                  <select id="f-shadow">
                    <option value="suave">Suaves</option>
                    <option value="ninguna">Sin sombra</option>
                    <option value="fuerte">Marcadas</option>
                  </select></div>
                <div><label>Modo oscuro</label>
                  <select id="f-dark">
                    <option value="off">Desactivado</option>
                    <option value="auto">Automático (según el visitante)</option>
                  </select></div>
              </div>
              <div><label>Fondo de la ventana de chat</label>
                <input id="f-colorbg" type="color" value="#ffffff"></div>
              <div class="swrow"><span class="swlab">Borde en la ventana de chat</span><label class="switch"><input id="f-winborderon" type="checkbox"><span class="track"></span><span class="knob"></span></label></div>
              <div class="row">
                <div><label>Color del borde de la ventana</label><input id="f-winborder" type="color" value="#d9d9d4"></div>
                <div><label>Grosor del borde: <span id="f-winborderw-v">1</span> px</label>
                  <input id="f-winborderw" type="range" min="1" max="6" value="1"></div>
              </div>
              <div class="row">
                <div><label>Tamaño del widget</label>
                  <select id="f-size">
                    <option value="compacto">Compacto</option>
                    <option value="estandar" selected>Estándar</option>
                    <option value="amplio">Amplio</option>
                  </select></div>
                <div></div>
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
                  <input id="g-c1" type="color" value="#6d8bf1" style="width:58px">
                  <input id="g-c2" type="color" value="#c9f0ff" style="width:58px">
                </div>
                <label>Estilo</label>
                <div class="gradrow" id="g-styles"></div>
              </div>
              <div id="bg-img" class="hide" style="margin-top:8px">
                <input id="f-bgimg" placeholder="Pega la URL de una imagen (https://…)">
              </div>
            </div>
          </details>

          <details class="cfg">
            <summary><span class="ci"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg></span>
              <div><div class="ct">Textos y burbuja de invitación</div><div class="cs">Campo de escritura, invitación, mensajes</div></div>
              <span class="cv"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span></summary>
            <div class="cfgb">
              <div class="swrow"><span class="swlab">Burbuja de invitación automática</span><label class="switch"><input id="f-teaser" type="checkbox" checked><span class="track"></span><span class="knob"></span></label></div>
              <div class="row">
                <div><label>Segundos hasta la invitación</label>
                  <input id="f-tdelay" type="number" min="1" max="60" value="4"></div>
                <div><label>Texto de la invitación <span class="lh">vacío = la bienvenida</span></label>
                  <input id="f-tteaser"></div>
              </div>
              <div class="row">
                <div><label>Campo de escritura</label><input id="f-tplaceholder" placeholder="Escribe tu pregunta…"></div>
                <div><label>Botón de enviar (texto)</label><input id="f-tsend" placeholder="→"></div>
              </div>
              <label>Icono del botón de enviar <span class="lh">«Abc» = usa el texto de arriba</span></label>
              <div class="icopick" id="pick-send"></div>
              <label>Mensaje de error de conexión</label>
              <input id="f-terror" placeholder="No he podido conectar…">
            </div>
          </details>

          <details class="cfg">
            <summary><span class="ci"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 8V5"/><circle cx="12" cy="3.6" r="1.1" fill="currentColor"/></svg></span>
              <div><div class="ct">Marca y avanzado</div><div class="cs">Pie del chat, tu firma, sonido, CSS</div></div>
              <span class="cv"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span></summary>
            <div class="cfgb">
              <div class="swrow"><span class="swlab">Mostrar «Con tecnología de ExpoBot» <small>+ enlace a expobot.es; solo si no defines una marca propia debajo</small></span><label class="switch"><input id="f-expobot" type="checkbox" checked><span class="track"></span><span class="knob"></span></label></div>
              <label style="margin-top:16px">Marca propia en el pie <span class="lh">«Impulsado por…» — vacío = sin pie propio</span></label>
              <div class="row">
                <div><label>Nombre de tu marca</label><input id="f-brand" placeholder="Tu Agencia"></div>
                <div><label>Enlace de la marca</label><input id="f-brandurl" type="url" placeholder="https://tuagencia.com"></div>
              </div>
              <label>Logotipo del pie <span class="lh">opcional; sustituye el nombre</span></label>
              <input id="f-brandlogo" type="url" placeholder="https://tuagencia.com/logotipo.svg">
              <div class="swrow"><span class="swlab">Sonido sutil al aparecer la invitación</span><label class="switch"><input id="f-sound" type="checkbox"><span class="track"></span><span class="knob"></span></label></div>
              <label style="margin-top:16px">CSS personalizado <span class="lh">avanzado; se inyecta tal cual en la web del cliente</span></label>
              <textarea id="f-css" rows="3" placeholder=".cb-btn{ } .cb-panel{ } .cb-msg.bot{ } …"></textarea>
            </div>
          </details>

          <p class="mut" style="margin-top:14px"><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg> Todos los cambios se ven al momento en la
          <b>vista en vivo</b> de la derecha.</p>
        </div>
        <div class="ft" id="ft-leads">
          <div class="row">
            <div><label>Email para leads / handoff</label><input id="f-email" type="email"></div>
            <div><label>Webhook de leads (Zapier, Make, CRM…)</label><input id="f-webhook" type="url"></div>
          </div>
          <label>Aviso al cliente por email cuando el bot capte un lead</label>
          <select id="f-leadnotify" style="max-width:340px">
            <option value="off">Sin aviso (solo panel y webhook)</option>
            <option value="instant">Al momento — un email por cada lead</option>
            <option value="daily">Resumen diario — un email a las 07:00 con los del día</option>
          </select>
          <p class="mut" style="margin-top:4px">Se envía al email de la ficha del cliente (o al de leads
          si no tiene). Necesita Resend configurado.</p>
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
          <button id="ig-run" class="ghost small"><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg> ¿Cómo se integra en su web?</button>
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
            <button id="ig-pdf" class="ghost small"><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg> Descargar PDF</button>
            <button id="ig-copy" class="ghost small">Copiar instrucciones + código como texto</button>
          </div>
        </div>
        <label>Panel del cliente (conversaciones, leads, preguntas sin respuesta)</label>
        <div class="copyrow"><input id="i-panel" readonly>
          <button class="ghost small" data-copy="i-panel">Copiar</button>
          <button id="i-open" class="ghost small">Abrir</button></div>
        <div class="actions">
          <button id="rep-send" class="ghost small"><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 14v4M12 9v9M17 5v13"/></svg> Enviar informe del mes al cliente</button>
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
        <label><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M9.5 3A3 3 0 0 0 7 8a3 3 0 0 0-1 5.5A3 3 0 0 0 9 19a2.5 2.5 0 0 0 3-2.5V4.5A1.5 1.5 0 0 0 9.5 3zM14.5 3A3 3 0 0 1 17 8a3 3 0 0 1 1 5.5A3 3 0 0 1 15 19a2.5 2.5 0 0 1-3-2.5"/></svg> Huecos de conocimiento — lo que preguntaron y el bot no supo responder</label>
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
          <div id="cv-bar"><span class="cv-eyebrow">Vista en vivo · así lo verá el visitante</span>
            <div class="cv-tools">
              <div class="cv-vp" id="cv-vp"><button type="button" class="on" data-vp="desktop">Escritorio</button><button type="button" data-vp="mobile">Móvil</button></div>
              <button id="cv-dark" class="ghost small" type="button" title="Previsualizar en oscuro"><svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg></button>
            </div></div>
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
    <button id="cp-eye" type="button" title="Capturar un color de la pantalla"><svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true"><path d="M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3z"/></svg></button>
  </div>
</div>

<script>
var TOKEN = localStorage.getItem("cb_admin") || "";
// dominio público para los enlaces que se entregan a clientes (demo, panel, portal, FAQ, widget)
var PUB = "https://expobot.es";
var data = [];
var sel = { type: null, id: null, isNew: false, parentId: null };

// ---- iconos de línea (monocromos, coherentes con la marca) ----
var IC = {
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14M10 11v6M14 11v6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M17.9 17.9A10 10 0 0 1 12 20C5 20 2 12 2 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.2 3.2m-6.7-1.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l1.7-1.3-1.7-3-2 .8a7.6 7.6 0 0 0-1.8-1L15 4H9l-.6 2.5a7.6 7.6 0 0 0-1.8 1l-2-.8-1.7 3L4.6 11a7.6 7.6 0 0 0 0 2l-1.7 1.3 1.7 3 2-.8a7.6 7.6 0 0 0 1.8 1L9 20h6l.6-2.5a7.6 7.6 0 0 0 1.8-1l2 .8 1.7-3z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M15 13H9M15 17H9"/>',
  edit: '<path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  warning: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  sparkles: '<path d="M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16l-1.7-4.8L5.5 9.5l4.8-1.7z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  chat: '<path d="M21 11.5a8 8 0 0 1-8.5 8 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8 8 0 0 1 4 11.5a8 8 0 0 1 8.5-8 8 8 0 0 1 8.5 8z"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v2.5M12 20v2.5M4 4l1.8 1.8M18.2 18.2L20 20M1.5 12h2.5M20 12h2.5M4 20l1.8-1.8M18.2 5.8L20 4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 14v4M12 9v9M17 5v13"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  building: '<path d="M3 21h18M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2.5" width="8" height="4" rx="1"/>',
  brain: '<path d="M9.5 3A3 3 0 0 0 7 8a3 3 0 0 0-1 5.5A3 3 0 0 0 9 19a2.5 2.5 0 0 0 3-2.5V4.5A1.5 1.5 0 0 0 9.5 3zM14.5 3A3 3 0 0 1 17 8a3 3 0 0 1 1 5.5A3 3 0 0 1 15 19a2.5 2.5 0 0 1-3-2.5"/>',
  rocket: '<path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2a2.8 2.8 0 0 0-3-3z"/><path d="M9 12a15 15 0 0 1 8-8c2 0 3 1 3 3a15 15 0 0 1-8 8zM15 9h.01"/><path d="M9 12L7 10a10 10 0 0 1 4-1M12 15l2 2a10 10 0 0 0 1-4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  drop: '<path d="M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  party: '<path d="M4 20l5-14 9 9-14 5zM14 6a3 3 0 0 0-3-3M17 9a3 3 0 0 0 3-3M13 2h.01M21 10h.01M20 14h.01"/>',
  activity: '<path d="M3 12h4l2.5 7 5-14L17 12h4"/>',
  cap: '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.8 3 3 6 3s6-1.2 6-3v-5"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.3a3 3 0 0 1 5.6 1c0 2-3 2.5-3 4M12 17.5h.01"/>',
};
function svgIco(n, s) {
  return '<svg class="ic" viewBox="0 0 24 24" width="' + (s || 16) + '" height="' + (s || 16) +
    '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true">' +
    (IC[n] || "") + "</svg>";
}

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
$("paste-tok").onclick = function () {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    $("login-err").textContent = "Tu navegador no deja leer el portapapeles: mantén pulsado el campo y elige Pegar.";
    return;
  }
  navigator.clipboard.readText().then(function (t) {
    t = (t || "").trim();
    if (!t) { $("login-err").textContent = "El portapapeles está vacío. Copia el token primero."; return; }
    $("tok").value = t;
    $("enter").click();
  }).catch(function () {
    $("login-err").textContent = "No se ha podido leer el portapapeles: mantén pulsado el campo y elige Pegar.";
  });
};
[].forEach.call(document.querySelectorAll('input[type="password"]'), function (inp) {
  var w = document.createElement("span");
  w.className = "password-wrap";
  inp.parentNode.insertBefore(w, inp);
  w.appendChild(inp);
  inp.style.paddingRight = "42px";
  var b = document.createElement("button");
  b.type = "button";
  b.className = "password-toggle";
  b.innerHTML = svgIco("eye");
  b.title = "Mostrar u ocultar";
  b.setAttribute("aria-label", "Mostrar u ocultar la clave");
  b.onclick = function () {
    var show = inp.type === "password";
    inp.type = show ? "text" : "password";
    b.style.opacity = show ? "1" : ".55";
    inp.focus();
  };
  w.appendChild(b);
});
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
  setGlobalNav("home");
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
  setGlobalNav("leads");
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
      var oks = document.createElement("span");
      oks.className = "ok";
      oks.innerHTML = svgIco("check", 14) + " contactado";
      st.appendChild(oks);
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
    var del = document.createElement("button");
    del.className = "ghost small icon-btn";
    del.style.marginLeft = "6px";
    del.title = "Quitar de tu vista (seguirá en el panel del cliente)";
    del.innerHTML = svgIco("trash", 15);
    del.onclick = function (e) {
      e.stopPropagation();
      if (!confirm("¿Quitar este lead de tu panel de administración?\\nSeguirá visible en el panel del cliente.")) return;
      api("/admin/api/leads/" + r.id, { method: "DELETE" }).then(function (x) {
        if (x.error) { toast(x.error, true); return; }
        GL_ROWS = GL_ROWS.filter(function (z) { return z.id !== r.id; });
        renderGlobalLeads();
      });
    };
    st.appendChild(del);
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
$("clients-btn").onclick = goClients;
$("projects-btn").onclick = goProjects;
$("ops-btn").onclick = goOps;
$("templates-btn").onclick = goTemplates;
[].forEach.call(document.querySelectorAll("[data-template]"), function (b) {
  b.onclick = function () {
    var projects = allProjects();
    if (!projects.length) { toast("Crea primero un cliente y un proyecto.", true); return; }
    var chosen = projects[0];
    if (projects.length > 1) {
      var list = projects.map(function (f, i) { return (i + 1) + ". " + f.client.name + " / " + f.project.name; }).join("\\n");
      var n = parseInt(prompt("Elige el proyecto para el nuevo asistente:\\n\\n" + list), 10);
      if (!n || !projects[n - 1]) return;
      chosen = projects[n - 1];
    }    var presets = {
      venue: { name: "Asistente del recinto", brief: "Asistente para un recinto ferial. Responde sobre accesos, aparcamiento, pabellones, horarios, servicios y eventos activos. Debe usar solo informacion validada, detectar consultas que requieren una persona y captar datos cuando exista interes comercial." },
      organizer: { name: "Asistente de la feria", brief: "Asistente para una feria o congreso. Informa sobre programa, entradas, expositores, ubicaciones y servicios. Detecta empresas interesadas en exponer, clasifica su intencion y registra el lead para el equipo comercial." },
      business: { name: "Asistente de atencion", brief: "Asistente corporativo de atencion al cliente. Responde preguntas frecuentes con informacion de la empresa, ofrece derivacion humana cuando corresponde y capta contactos con consentimiento cuando detecta una oportunidad." }
    };
    var preset = presets[b.dataset.template] || presets.business;
    selTenant(null, chosen.project.id);
    $("f-name").value = preset.name;
    $("a-brief").value = preset.brief;
    $("f-slug").value = slugify(chosen.client.name + "-" + preset.name);
    markDirty();
    toast("Plantilla aplicada. Revisa el objetivo y genera la configuracion.");
  };
});
$("settings-btn").onclick = goSettings;
$("settings-logout").onclick = function () { $("logout").click(); };
$("clients-new-inline").onclick = function () { $("new-client").click(); };
$("clients-search").oninput = renderClientsTable;
$("projects-search").oninput = renderProjectsTable;
$("projects-status").onchange = renderProjectsTable;
$("ops-refresh").onclick = goOps;
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
    var icoName = m.kind === "Cliente" ? "user" : m.kind === "Proyecto" ? "folder" : "chat";
    var l = document.createElement("span");
    l.innerHTML = svgIco(icoName) + " "; l.appendChild(document.createTextNode(m.label + (m.sub ? " — " + m.sub : "")));
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
  data.slice(0, 8).forEach(function (c) {
    box.appendChild(treeBtn(c.name, "", sel.type === "client" && sel.id === c.id, function () { selClient(c.id); }));
  });
}

var ALL_VIEWS = [
  "v-home", "v-leads", "v-wizard", "v-check", "v-clients", "v-projects", "v-ops",
  "v-templates", "v-settings", "v-client-nav", "v-client", "v-client-projects",
  "v-client-portal", "v-client-inv", "v-project-nav", "v-project-overview",
  "v-project-integrations", "v-project-knowledge", "v-project", "v-project-tools",
  "v-bot-overview", "v-bot-channels", "v-assist", "v-tenant", "v-exam", "integ", "ingest"
];
function showCards(ids, keepTabs) {
  ALL_VIEWS.forEach(function (v) { $(v).classList.toggle("hide", ids.indexOf(v) < 0); });
  if (!keepTabs) $("bot-tabs").classList.add("hide");
  var canvas = ids.indexOf("v-tenant") >= 0;
  $("canvas-panel").classList.toggle("hide", !canvas);
  $("main").classList.toggle("with-canvas", canvas);
  $("main").classList.remove("hide");
}

function setGlobalNav(name) {
  [].forEach.call(document.querySelectorAll(".admin-nav button"), function (b) {
    b.classList.toggle("on", b.dataset.global === name);
  });
}

function statusPill(label, status) {
  return "<span class='status-pill " + (status || "") + "'>" + label + "</span>";
}

function allProjects() {
  var rows = [];
  data.forEach(function (c) {
    (c.projects || []).forEach(function (p) { rows.push({ client: c, project: p }); });
  });
  return rows;
}

function goClients() {
  if (!guardNav()) return;
  sel = { type: "clients" };
  setGlobalNav("clients"); renderTree(); crumb(["Clientes"]); showCards(["v-clients"]);
  renderClientsTable();
}

function renderClientsTable() {
  var q = ($("clients-search").value || "").trim().toLowerCase();
  var rows = data.filter(function (c) {
    return !q || [c.name, c.contact_name, c.email].join(" ").toLowerCase().indexOf(q) >= 0;
  });
  $("clients-count").textContent = rows.length + (rows.length === 1 ? " cliente" : " clientes");
  var tb = $("clients-body"); tb.innerHTML = "";
  rows.forEach(function (c) {
    var projects = c.projects || [], bots = 0;
    projects.forEach(function (p) { bots += (p.tenants || []).length; });
    var tr = document.createElement("tr");
    tr.innerHTML = "<td><strong></strong><small></small></td><td></td><td>" + projects.length +
      "</td><td>" + bots + "</td><td>" + statusPill(c.portal_enabled !== false ? "Activo" : "Desactivado", c.portal_enabled !== false ? "connected" : "paused") +
      "</td><td><button class='ghost small'>Abrir</button></td>";
    tr.querySelector("strong").textContent = c.name;
    tr.querySelector("small").textContent = c.email || "Sin email";
    tr.children[1].textContent = c.contact_name || "Sin responsable";
    tr.onclick = function () { selClient(c.id); };
    tb.appendChild(tr);
  });
  if (!rows.length) tb.innerHTML = "<tr><td colspan='6' class='mut'>No hay clientes que coincidan.</td></tr>";
}

function goProjects() {
  if (!guardNav()) return;
  sel = { type: "projects" };
  setGlobalNav("projects"); renderTree(); crumb(["Proyectos"]); showCards(["v-projects"]);
  renderProjectsTable();
}

function renderProjectsTable() {
  var q = ($("projects-search").value || "").trim().toLowerCase();
  var status = $("projects-status").value;
  var rows = allProjects().filter(function (f) {
    var bots = f.project.tenants || [];
    return (!q || (f.project.name + " " + f.client.name).toLowerCase().indexOf(q) >= 0) &&
      (!status || (status === "empty" ? !bots.length : bots.some(function (t) { return t.active; })));
  });
  $("projects-count").textContent = rows.length + (rows.length === 1 ? " proyecto" : " proyectos");
  var tb = $("projects-body"); tb.innerHTML = "";
  rows.forEach(function (f) {
    var bots = f.project.tenants || [], active = bots.filter(function (t) { return t.active; }).length;
    var tr = document.createElement("tr");
    tr.innerHTML = "<td><strong></strong><small></small></td><td></td><td>" + bots.length + "</td><td class='mut'>Ver proyecto</td><td>" +
      statusPill(!bots.length ? "Sin asistente" : active + " activos", !bots.length ? "pending" : "connected") +
      "</td><td><button class='ghost small'>Abrir</button></td>";
    tr.querySelector("strong").textContent = f.project.name;
    tr.querySelector("small").textContent = f.project.description || "Sin descripcion";
    tr.children[1].textContent = f.client.name;
    tr.onclick = function () { selProject(f.project.id); };
    tb.appendChild(tr);
  });
  if (!rows.length) tb.innerHTML = "<tr><td colspan='6' class='mut'>No hay proyectos que coincidan.</td></tr>";
}

function goOps() {
  if (!guardNav()) return;
  sel = { type: "ops" }; setGlobalNav("ops"); renderTree(); crumb(["Operaciones"]); showCards(["v-ops"]);
  var projects = allProjects(), bots = [];
  projects.forEach(function (f) { bots = bots.concat(f.project.tenants || []); });
  $("ops-off").textContent = bots.filter(function (t) { return !t.active; }).length;
  $("ops-empty").textContent = projects.filter(function (f) { return !(f.project.tenants || []).length; }).length;
  $("ops-integration-errors").textContent = "-";
  api("/admin/api/errors").then(function (errs) {
    if (!errs || errs.error) return;
    $("ops-error-count").textContent = errs.length;
    var box = $("ops-errors"); box.innerHTML = "";
    if (!errs.length) { box.textContent = "Sin incidencias recientes."; return; }
    errs.slice(0, 12).forEach(function (e) {
      var d = document.createElement("div"); d.className = "doc";
      d.innerHTML = "<div><strong></strong><div class='meta'></div></div>";
      d.querySelector("strong").textContent = e.route || "Motor";
      d.querySelector(".meta").textContent = e.message || "Error registrado";
      box.appendChild(d);
    });
  });
}

function goTemplates() { if (!guardNav()) return; sel = { type: "templates" }; setGlobalNav("templates"); renderTree(); crumb(["Plantillas"]); showCards(["v-templates"]); }
function goSettings() { if (!guardNav()) return; sel = { type: "settings" }; setGlobalNav(""); renderTree(); crumb(["Administracion"]); showCards(["v-settings"]); }
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

function showClientSection(section) {
  var map = { profile: "v-client", projects: "v-client-projects", access: "v-client-portal", billing: "v-client-inv" };
  [].forEach.call(document.querySelectorAll("[data-client-section]"), function (b) {
    b.classList.toggle("on", b.dataset.clientSection === section);
  });
  showCards(["v-client-nav", map[section] || "v-client"]);
}

[].forEach.call(document.querySelectorAll("[data-client-section]"), function (b) {
  b.onclick = function () { showClientSection(b.dataset.clientSection); };
});

function selClient(id) {
  if (sel.type !== "client" || sel.id !== id) { if (!guardNav()) return; }
  populating = true;
  sel = { type: "client", id: id, isNew: !id };
  setGlobalNav("clients");
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
    $("portal-url").value = PUB + "/acceso";
    $("c-portal-on").checked = c.portal_enabled !== false;
    $("portal-pass-out").textContent = c.portal_password_hash
      ? "El cliente ya tiene contraseña. Genera una nueva solo si la ha perdido (la anterior dejará de valer)."
      : "Este cliente aún no tiene contraseña: genera una y envíasela junto con el enlace de acceso.";
    $("portal-pass-out").className = "mut";
    $("portal-msg").textContent = "";
    $("iv-msg").textContent = "";
    loadInvoices();
  }
  if (c) {
    $("client-context-title").textContent = c.name;
    $("client-context-meta").textContent = (c.contact_name || "Sin responsable") + (c.email ? " · " + c.email : "");
    showClientSection("profile");
  } else {
    showCards(["v-client"]);
  }
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
      var per = (v.period_start || v.period_end) ? "Periodo " + (v.period_start || "—") + " a " + (v.period_end || "—") : "";
      meta.textContent = [v.issued_at || "", v.concept || "", per, v.pdf_path ? "con PDF" : "sin PDF"]
        .filter(Boolean).join(" · ");
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
        period_start: $("iv-pstart").value || null,
        period_end: $("iv-pend").value || null,
        pdf_base64: pdf64 || null,
      }),
    }).then(function (r) {
      if (r.error) { $("iv-msg").textContent = r.error; $("iv-msg").className = "err"; return; }
      $("iv-msg").textContent = "Factura añadida ✓"; $("iv-msg").className = "ok";
      $("iv-num").value = ""; $("iv-amt").value = ""; $("iv-concept").value = "";
      $("iv-pstart").value = ""; $("iv-pend").value = ""; $("iv-pdf").value = "";
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

$("client-add-project").onclick = function () {
  showClientSection("projects");
  $("proj-new-name").focus();
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

var PROJECT_INTEGRATIONS = {};
var INTEGRATION_META = {
  web: { label: "Web", category: "Canal", key: "domain", field: "Dominio permitido", placeholder: "feriaejemplo.com" },
  whatsapp: { label: "WhatsApp", category: "Canal", key: "phone_number", field: "Numero conectado", placeholder: "+34 600 000 000" },
  telegram: { label: "Telegram", category: "Canal", key: "bot_username", field: "Usuario del bot", placeholder: "@expobot_demo" },
  google_drive: { label: "Google Drive", category: "Conocimiento", key: "folder_name", field: "Carpeta compartida", placeholder: "Documentacion feria" },
  webhook: { label: "Webhook", category: "Ventas", key: "endpoint", field: "URL de destino", placeholder: "https://..." },
  crm: { label: "CRM", category: "Ventas", key: "workspace", field: "Espacio o cuenta", placeholder: "Equipo comercial" },
  email: { label: "Email", category: "Comunicacion", key: "sender", field: "Remitente", placeholder: "atencion@empresa.es" },
  calendar: { label: "Calendar", category: "Agenda", key: "calendar_name", field: "Calendario", placeholder: "Citas comerciales" },
  zapier_make: { label: "Zapier / Make", category: "Ventas", key: "endpoint", field: "Webhook del flujo", placeholder: "https://..." }
};

function integrationStatusLabel(status) {
  return { connected: "Conectada", pending: "Pendiente", paused: "Pausada", error: "Revisar" }[status] || status;
}

function loadProjectIntegrations(projectId, done) {
  $("project-integrations-list").innerHTML = "<p class='mut'>Cargando conexiones...</p>";
  api("/admin/api/projects/" + projectId + "/integrations").then(function (rows) {
    if (!rows || rows.error) {
      PROJECT_INTEGRATIONS[projectId] = [];
      $("project-integrations-list").innerHTML = "<p class='err'>No se han podido cargar las integraciones.</p>";
    } else {
      PROJECT_INTEGRATIONS[projectId] = rows;
      renderProjectIntegrations(projectId);
    }
    if (done) done(PROJECT_INTEGRATIONS[projectId]);
  });
}

function renderProjectIntegrations(projectId) {
  var rows = PROJECT_INTEGRATIONS[projectId] || [];
  var box = $("project-integrations-list"); box.innerHTML = "";
  $("project-integration-count").textContent = rows.length;
  $("project-integration-status").textContent = rows.length ?
    rows.filter(function (x) { return x.status === "connected"; }).length + " conectadas" : "Sin conexiones";
  if (!rows.length) {
    box.innerHTML = "<div class='empty-state'>Todavia no hay conexiones. Elige un servicio para configurarlo.</div>";
    return;
  }
  rows.forEach(function (row) {
    var meta = INTEGRATION_META[row.provider] || { label: row.provider, category: row.category };
    var item = document.createElement("button"); item.className = "integration-row";
    var assigned = (row.assigned_tenant_ids || []).length;
    item.innerHTML = "<span class='integration-mark'></span><span class='integration-copy'><strong></strong><small></small></span>" +
      statusPill(integrationStatusLabel(row.status), row.status) + "<span class='integration-arrow'>›</span>";
    item.querySelector(".integration-mark").textContent = meta.label.slice(0, 2).toUpperCase();
    item.querySelector("strong").textContent = row.name;
    item.querySelector("small").textContent = meta.label + " · " + assigned + (assigned === 1 ? " asistente" : " asistentes");
    item.onclick = function () { openIntegrationEditor(row.provider, row); };
    box.appendChild(item);
  });
}

function openIntegrationEditor(provider, row) {
  var f = findProject(sel.id); if (!f) return;
  var meta = INTEGRATION_META[provider]; if (!meta) return;
  $("integration-editor").classList.remove("hide");
  $("pi-id").value = row ? row.id : "";
  $("pi-provider").value = provider;
  $("pi-title").textContent = row ? row.name : "Nueva conexion de " + meta.label;
  $("pi-name").value = row ? row.name : meta.label;
  $("pi-status").value = row ? row.status : "pending";
  $("pi-msg").textContent = "";
  $("pi-delete").classList.toggle("hide", !row);
  $("pi-check").classList.toggle("hide", !row);
  var settings = row && row.settings || {};
  $("pi-settings").innerHTML = "<label>" + meta.field + "</label><input id='pi-setting-value' placeholder='" +
    meta.placeholder + "'><p class='mut'>Las claves privadas y credenciales OAuth se autorizan en el proveedor; no se guardan en este campo.</p>";
  $("pi-setting-value").value = settings[meta.key] || "";
  var bots = $("pi-bots"); bots.innerHTML = "";
  (f.project.tenants || []).forEach(function (t) {
    var label = document.createElement("label"); label.className = "assignment-item";
    var checked = row && (row.assigned_tenant_ids || []).indexOf(t.id) >= 0;
    label.innerHTML = "<input type='checkbox' value='" + t.id + "'" + (checked ? " checked" : "") + "><span></span>";
    label.querySelector("span").textContent = t.name + (t.active ? "" : " · apagado");
    bots.appendChild(label);
  });
  if (!(f.project.tenants || []).length) bots.innerHTML = "<p class='mut'>Crea un asistente para poder asignarle esta conexion.</p>";
  $("integration-editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function integrationPayload() {
  var provider = $("pi-provider").value, meta = INTEGRATION_META[provider], settings = {};
  settings[meta.key] = $("pi-setting-value").value.trim();
  return {
    provider: provider,
    name: $("pi-name").value.trim(),
    status: $("pi-status").value,
    settings: settings,
    assigned_tenant_ids: [].map.call(document.querySelectorAll("#pi-bots input:checked"), function (x) { return x.value; })
  };
}

function closeIntegrationEditor() {
  $("integration-editor").classList.add("hide");
  $("pi-msg").textContent = "";
}

$("pi-close").onclick = closeIntegrationEditor;
$("integration-add").onclick = function () { openIntegrationEditor("web"); };
[].forEach.call(document.querySelectorAll("#integration-catalog [data-provider]"), function (b) {
  b.onclick = function () { openIntegrationEditor(b.dataset.provider); };
});

$("pi-save").onclick = function () {
  var id = $("pi-id").value, payload = integrationPayload();
  if (!payload.name) { $("pi-msg").textContent = "Pon un nombre a la conexion."; $("pi-msg").className = "err"; return; }
  var path = id ? "/admin/api/integrations/" + id : "/admin/api/projects/" + sel.id + "/integrations";
  api(path, { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) }).then(function (r) {
    if (r.error) { $("pi-msg").textContent = r.error; $("pi-msg").className = "err"; return; }
    toast("Integracion guardada");
    closeIntegrationEditor();
    loadProjectIntegrations(sel.id);
  });
};

$("pi-check").onclick = function () {
  var id = $("pi-id").value; if (!id) return;
  $("pi-msg").textContent = "Comprobando configuracion...";
  api("/admin/api/integrations/" + id + "/check", { method: "POST" }).then(function (r) {
    if (r.error) { $("pi-msg").textContent = r.error; $("pi-msg").className = "err"; return; }
    $("pi-msg").textContent = r.status === "connected" ? "Configuracion completa." : (r.error_message || "Revisa la configuracion.");
    $("pi-msg").className = r.status === "connected" ? "ok" : "err";
    loadProjectIntegrations(sel.id);
  });
};

$("pi-delete").onclick = function () {
  var id = $("pi-id").value; if (!id || !confirm("Eliminar esta integracion del proyecto?")) return;
  api("/admin/api/integrations/" + id, { method: "DELETE" }).then(function (r) {
    if (r.error) { toast(r.error, true); return; }
    closeIntegrationEditor(); toast("Integracion eliminada"); loadProjectIntegrations(sel.id);
  });
};

function showProjectSection(section) {
  var map = {
    overview: "v-project-overview", assistants: "v-project-tools", integrations: "v-project-integrations",
    knowledge: "v-project-knowledge", settings: "v-project"
  };
  [].forEach.call(document.querySelectorAll("[data-project-section]"), function (b) {
    b.classList.toggle("on", b.dataset.projectSection === section);
  });
  showCards(["v-project-nav", map[section] || "v-project-overview"]);
  if (section === "integrations" && sel.type === "project") loadProjectIntegrations(sel.id);
}

[].forEach.call(document.querySelectorAll("[data-project-section]"), function (b) {
  b.onclick = function () { showProjectSection(b.dataset.projectSection); };
});


function selProject(id) {
  if (sel.type !== "project" || sel.id !== id) { if (!guardNav()) return; }
  populating = true;
  sel = { type: "project", id: id };
  setGlobalNav("projects");
  renderTree();
  var f = findProject(id);
  if (!f) { populating = false; return; }
  crumb([{ t: f.client.name, go: function () { selClient(f.client.id); } }, f.project.name]);
  $("p-title").textContent = f.project.name;
  $("p-name").value = f.project.name;
  $("p-desc").value = f.project.description || "";
  $("p-msg").textContent = "";
  renderBots(f.project);
  $("project-context-title").textContent = f.project.name;
  $("project-context-meta").textContent = f.client.name + (f.project.description ? " · " + f.project.description : "");
  var bots = f.project.tenants || [], active = bots.filter(function (t) { return t.active; }).length;
  $("project-bot-count").textContent = bots.length;
  $("project-bot-status").textContent = bots.length ? active + " activos" : "Sin asistentes";
  $("project-activity").textContent = bots.length ?
    "El proyecto tiene " + bots.length + (bots.length === 1 ? " asistente" : " asistentes") + " y " + active + " en produccion." :
    "Crea el primer asistente para empezar a configurar el proyecto.";
  showProjectSection("overview");
  loadProjectIntegrations(id);
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
    box.appendChild(treeBtn(t.name + (t.active ? "" : " (apagado)"), t.active ? "" : "off", false, function () { selTenant(t.id); }));
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
$("project-add-bot").onclick = function () { selTenant(null, sel.id); };

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
  $("bot-creation-progress").classList.toggle("hide", !isNew);
  $("f-title").textContent = isNew ? "Nuevo chatbot" : t.name;
  $("f-name").value = isNew ? "" : t.name;
  $("f-slug").value = isNew ? "" : t.slug;
  $("f-slug").readOnly = !isNew;
  $("f-prompt").value = isNew ? "" : t.system_prompt || "";
  $("f-welcome").value = isNew ? "¡Hola! ¿En qué puedo ayudarte?" : t.welcome_message || "";
  $("f-sugg").value = isNew ? "" : (t.suggested_questions || []).join("\\n");
  $("f-qualq").value = (t && t.theme && t.theme.qualify_q) || "";
  $("f-qualopts").value = ((t && t.theme && t.theme.qualify_opts) || []).join("\\n");
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
  $("f-leadnotify").value = feats.lead_notify || "off";
  $("f-panelon").checked = !t || t.panel_enabled !== false;
  var pf = (t && t.panel_features) || {};
  $("f-pfleads").checked = pf.leads !== false;
  $("f-pfconvs").checked = pf.convs !== false;
  $("f-pfgaps").checked = pf.gaps !== false;
  $("f-pfuploads").checked = pf.uploads !== false;
  $("f-pftest").checked = pf.test !== false;
  var th = (t && t.theme) || {};
  $("f-color2").value = th.secondary_color || "#f2f2f0";
  $("f-colorhead").value = th.header_color || (t && t.primary_color) || "#111111";
  $("f-controlborder").value = th.control_border_color || "#d9d9d4";
  $("f-colorbg").value = th.bg_color || "#ffffff";
  $("f-font").value = th.font || "system";
  $("f-radius").value = th.radius == null ? 14 : th.radius;
  $("f-radius-v").textContent = $("f-radius").value;
  $("f-shadow").value = th.shadow || "suave";
  $("f-side").value = th.position || "derecha";
  $("f-subtitle").value = th.subtitle || "";
  $("f-logo").value = th.logo_url || "";
  $("f-wordmark").value = th.wordmark_url || "";
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
  $("f-brandlogo").value = th.brand_logo_url || "";
  $("f-btnicon").value = th.btn_icon_url || "";
  $("f-btnbg").value = th.btn_bg || (t && t.primary_color) || "#111111";
  $("f-btnborder").value = th.btn_border_color || "#f5be10";
  $("f-btnborderon").checked = !!(th.btn_border_color || th.btn_border);
  $("f-btnborderw").value = th.btn_border_width || 2;
  $("f-btnborderw-v").textContent = $("f-btnborderw").value;
  $("f-iconsize").value = th.icon_size || 46;
  $("f-iconsize-v").textContent = $("f-iconsize").value;
  $("f-effect").value = th.effect || (th.radar ? "radar" : "ninguno");
  $("f-radarcolor").value = th.radar_color || th.btn_border_color || "#f5be10";
  $("f-winborderon").checked = !!th.panel_border_color;
  $("f-winborder").value = th.panel_border_color || "#d9d9d4";
  $("f-winborderw").value = th.panel_border_width || 1;
  $("f-winborderw-v").textContent = $("f-winborderw").value;
  $("f-expobot").checked = th.expobot_branding !== false;
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
    setBotTab(sameTenant ? curBT : "resumen");
  } else {
    document.querySelector(".ftabs").classList.remove("hide");
    document.querySelector('.ftabs button[data-ft="ft-ap"]').classList.remove("hide");
    showCards(["v-assist", "v-tenant"]);
  }
  populating = false;
}

// ----- pestañas principales del chatbot -----

var curBT = "resumen";
var BT_CARDS = {
  resumen: ["v-bot-overview"],
  cerebro: ["v-assist", "v-tenant"],
  contenido: ["ingest"],
  diseno: ["v-tenant"],
  captacion: ["v-tenant"],
  canales: ["v-bot-channels"],
  calidad: ["v-exam"],
  publicar: ["v-check", "integ"],
};

function renderBotOverview() {
  var f = findTenant(sel.id); if (!f) return;
  var t = f.tenant, integrations = PROJECT_INTEGRATIONS[f.project.id] || [];
  var assigned = integrations.filter(function (x) { return (x.assigned_tenant_ids || []).indexOf(t.id) >= 0; });
  var essentials = [!!(t.system_prompt || "").trim(), !!(t.welcome_message || "").trim(), (t.allowed_domains || []).length > 0, t.active];
  var score = Math.round(100 * essentials.filter(Boolean).length / essentials.length);
  $("bot-overview-title").textContent = t.name;
  $("bot-overview-meta").textContent = f.client.name + " · " + f.project.name;
  $("bot-overview-status").textContent = t.active ? "Activo" : "Borrador";
  $("bot-overview-status").className = "status-pill " + (t.active ? "connected" : "pending");
  $("bot-doc-count").textContent = typeof DOCS_COUNT === "number" ? DOCS_COUNT : 0;
  $("bot-channel-count").textContent = assigned.length;
  $("bot-ready-score").textContent = score + "%";
  var box = $("bot-next-steps"); box.innerHTML = "";
  [
    { ok: essentials[0], text: "Definir objetivo y limites", tab: "cerebro" },
    { ok: essentials[2], text: "Configurar dominio y seguridad", tab: "cerebro" },
    { ok: assigned.length > 0, text: "Asignar al menos un canal", tab: "canales" },
    { ok: essentials[3], text: "Activar el asistente", tab: "publicar" }
  ].forEach(function (step) {
    var b = document.createElement("button"); b.className = "next-step" + (step.ok ? " done" : "");
    b.innerHTML = "<span>" + (step.ok ? svgIco("check") : svgIco("circle")) + "</span><strong></strong><small></small>";
    b.querySelector("strong").textContent = step.text;
    b.querySelector("small").textContent = step.ok ? "Completado" : "Pendiente";
    b.onclick = function () { setBotTab(step.tab); };
    box.appendChild(b);
  });
  if (!PROJECT_INTEGRATIONS[f.project.id]) loadProjectIntegrations(f.project.id, renderBotOverview);
}

function renderBotChannels() {
  var f = findTenant(sel.id); if (!f) return;
  var integrations = PROJECT_INTEGRATIONS[f.project.id] || [], box = $("bot-integration-list");
  box.innerHTML = "";
  var assigned = integrations.filter(function (x) { return (x.assigned_tenant_ids || []).indexOf(f.tenant.id) >= 0; });
  if (!assigned.length) {
    box.innerHTML = "<div class='empty-state'>Este asistente no tiene canales asignados. Gestiona las conexiones desde el proyecto.</div>";
  } else {
    assigned.forEach(function (x) {
      var meta = INTEGRATION_META[x.provider] || { label: x.provider };
      var row = document.createElement("div"); row.className = "integration-row";
      row.innerHTML = "<span class='integration-mark'></span><span class='integration-copy'><strong></strong><small></small></span>" +
        statusPill(integrationStatusLabel(x.status), x.status);
      row.querySelector(".integration-mark").textContent = meta.label.slice(0, 2).toUpperCase();
      row.querySelector("strong").textContent = x.name;
      row.querySelector("small").textContent = meta.label;
      box.appendChild(row);
    });
  }
  if (!PROJECT_INTEGRATIONS[f.project.id]) loadProjectIntegrations(f.project.id, renderBotChannels);
}

$("bot-manage-integrations").onclick = function () {
  var f = findTenant(sel.id); if (!f) return;
  selProject(f.project.id);
  showProjectSection("integrations");
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
  } else if (bt === "captacion") {
    ftbar.classList.add("hide");
    ftShow("ft-leads");
  } else if (bt === "cerebro") {
    ftbar.classList.remove("hide");
    apBtn.classList.add("hide");
    ftShow("ft-comp");
  }
  var vt = document.getElementById("v-tenant");
  if (vt) vt.classList.toggle("dsn-only", bt === "diseno");
  if (bt === "resumen") renderBotOverview();
  if (bt === "canales") renderBotChannels();
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
  ic.innerHTML = ok ? svgIco("check") : svgIco("circle");
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
    $("faq-link").value = PUB + "/faq?token=" + f.token;
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
  $("cv-dark").innerHTML = cvDark ? svgIco("sun") : svgIco("moon");
  $("cv-dark").title = cvDark ? "Previsualizar en claro" : "Previsualizar en oscuro";
  updPrev();
};
[].forEach.call(document.querySelectorAll("#cv-vp button"), function (b) {
  b.onclick = function () {
    [].forEach.call(document.querySelectorAll("#cv-vp button"), function (x) { x.classList.remove("on"); });
    b.classList.add("on");
    $("cv-frame").classList.toggle("cv-mobile", b.dataset.vp === "mobile");
  };
});

// ----- chat real dentro del canvas -----

var CV_SESSION = "";
var CV_HISTORY = [];
var CV_BUSY = false;

function cvResetChat() {
  CV_SESSION = "adm_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  CV_HISTORY = [];
  CV_BUSY = false;
  // el modo oscuro de la vista previa es por-bot: no arrastrarlo al cambiar de bot
  cvDark = false;
  if ($("cv-dark")) $("cv-dark").innerHTML = svgIco("moon") + " Oscuro";
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
    if (r.lead_form) {
      cvBubble("cv-b", "Aquí el visitante vería el formulario de contacto (nombre, email, teléfono…) dentro del chat.");
    }
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
  var head = $("f-colorhead").value || c;
  var headText = contrastFor(head);
  var controlBorder = $("f-controlborder").value || "#d9d9d4";
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
  $("f-winborderw-v").textContent = $("f-winborderw").value;
  w.style.border = $("f-winborderon").checked
    ? (($("f-winborderw").value || 1) + "px solid " + $("f-winborder").value)
    : "1px solid " + controlBorder;

  $("cv-h").style.background = head;
  $("cv-h").style.color = headText;
  var logo = $("f-logo").value.trim();
  var av = $("cv-av");
  if (logo) {
    av.innerHTML = '<img src="' + logo.replace(/"/g, "") + '" alt="">';
  } else {
    av.textContent = name.charAt(0).toUpperCase();
  }
  var wordmark = $("f-wordmark").value.trim();
  $("cv-name").innerHTML = wordmark
    ? '<img src="' + wordmark.replace(/"/g, "") + '" alt="' + name.replace(/"/g, "") + '" style="display:block;max-width:100px;max-height:22px;object-fit:contain">'
    : name;
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
    s.style.borderColor = controlBorder;
    sug.appendChild(s);
  });

  $("cv-foot").style.borderTopColor = cvDark ? "#333" : "#eee";
  var inp = $("cv-in");
  inp.placeholder = $("f-tplaceholder").value.trim() || "Escribe tu pregunta…";
  inp.style.background = cvDark ? "#232327" : "#fff";
  inp.style.color = cvDark ? "#eee" : "#333";
  inp.style.borderColor = cvDark ? "#3a3a40" : controlBorder;
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
  var brandLogo = $("f-brandlogo").value.trim();
  var expobotOn = $("f-expobot").checked;
  $("cv-brand").classList.toggle("hide", !brand && !brandLogo && !expobotOn);
  $("cv-brand").innerHTML = brandLogo
    ? 'Impulsado por <img src="' + brandLogo.replace(/"/g, "") + '" alt="' + (brand || "Marca") + '" style="max-width:62px;max-height:14px;vertical-align:middle;margin-left:4px">'
    : brand ? "Impulsado por " + brand
    : (expobotOn ? "Con tecnología de ExpoBot" : "");
  $("cv-brand").style.background = cbg;
  $("cv-brand").style.color = cvDark ? "#777" : "#999";

  var shape = $("f-btnshape").value;
  var pb = $("cv-btn");
  var btnBg = $("f-btnbg").value || c;
  var btnText = contrastFor(btnBg);
  pb.style.background = btnBg;
  $("f-btnborderw-v").textContent = $("f-btnborderw").value;
  pb.style.border = $("f-btnborderon").checked ? (($("f-btnborderw").value || 2) + "px solid " + $("f-btnborder").value) : "0";
  var fx = $("f-effect").value;
  ["radar", "beat", "bounce", "glow", "shake"].forEach(function (k) { pb.classList.remove(k); });
  var fxMap = { radar: "radar", latido: "beat", rebote: "bounce", brillo: "glow", sacudida: "shake" };
  if (fxMap[fx]) pb.classList.add(fxMap[fx]);
  pb.style.setProperty("--preview-radar", $("f-radarcolor").value);
  pb.style.borderRadius = shape === "redondeado" ? Math.min(rad + 4, 18) + "px" : "26px";
  var isz = parseInt($("f-iconsize").value, 10) || 46;
  $("f-iconsize-v").textContent = isz;
  var svgPx = Math.round(52 * isz / 100), imgPx = Math.round(52 * Math.min(isz + 24, 95) / 100);
  var btnIconUrl = $("f-btnicon").value.trim();
  pb.innerHTML = btnIconUrl
    ? '<img src="' + btnIconUrl.replace(/"/g, "") + '" alt="" style="width:' + imgPx + 'px;height:' + imgPx + 'px;object-fit:contain">'
    : '<svg viewBox="0 0 24 24" style="width:' + svgPx + 'px;height:' + svgPx + 'px;fill:none;stroke:' + btnText +
      ';stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round">' +
      (BTN_ICONS[iconBtnSel] || BTN_ICONS.burbuja) + "</svg>";
  if (shape === "pastilla") {
    var lbl = document.createElement("span");
    lbl.textContent = $("f-btnlabel").value.trim() || "Chat";
    lbl.style.cssText = "color:" + btnText + ";font:600 14px system-ui,sans-serif";
    pb.appendChild(lbl);
  }
  syncSwatches();
  if (typeof syncPrimary === "function") syncPrimary();
  if (typeof syncSegs === "function") syncSegs();
}
["f-color", "f-colorhead", "f-color2", "f-colorbg", "f-controlborder", "f-radius", "f-subtitle", "f-name", "f-welcome", "f-btnlabel",
 "f-tplaceholder", "f-tsend", "f-brand", "f-brandlogo", "f-sugg", "f-logo", "f-wordmark", "f-btnicon", "f-btnbg", "f-btnborder", "f-radarcolor", "f-bgimg",
 "f-iconsize", "f-btnborderw", "f-winborder", "f-winborderw"].forEach(function (id) {
  $(id).oninput = updPrev;
});
["f-font", "f-shadow", "f-btnshape", "f-btnborderon", "f-effect", "f-winborderon", "f-expobot"].forEach(function (id) {
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
      var iconName = d.source_type === "url" ? "globe" : d.source_type === "file" ? "doc" : "edit";
      title.innerHTML = svgIco(iconName) + " "; title.appendChild(document.createTextNode(d.title || d.source_url || "(sin título)"));
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
    '<script src="' + PUB + '/widget.js"\\n' +
    '        data-key="' + key + '"\\n' +
    '        data-api="' + PUB + '"><\\/script>';
  $("i-panel").value = PUB + "/panel?token=" + (t.panel_token || "");
  $("i-demo").value = PUB + "/demo?key=" + key;
  var dom = (t.allowed_domains || [])[0];
  var hint = $("i-demo-hint");
  if (dom) {
    hint.textContent = "La demo clona https://" + dom + " — se toma del primer dominio de la pestaña «Seguridad y límites».";
    hint.className = "mut";
  } else {
    hint.innerHTML = svgIco("warning") + " Este chatbot no tiene dominio: la demo mostrará una maqueta genérica. Escribe la web del cliente en «Seguridad y límites» → Dominios permitidos y guarda.";
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
    features: { leads: $("f-featleads").checked, lead_notify: $("f-leadnotify").value },
    panel_enabled: $("f-panelon").checked,
    panel_features: {
      leads: $("f-pfleads").checked,
      convs: $("f-pfconvs").checked,
      gaps: $("f-pfgaps").checked,
      uploads: $("f-pfuploads").checked,
      test: $("f-pftest").checked,
    },
    theme: {
      header_color: $("f-colorhead").value,
      secondary_color: $("f-color2").value,
      control_border_color: $("f-controlborder").value,
      panel_border_color: $("f-winborderon").checked ? $("f-winborder").value : "",
      panel_border_width: parseInt($("f-winborderw").value, 10) || 1,
      bg_color: $("f-colorbg").value,
      font: $("f-font").value,
      radius: parseInt($("f-radius").value, 10),
      shadow: $("f-shadow").value,
      position: $("f-side").value,
      subtitle: $("f-subtitle").value.trim(),
      logo_url: $("f-logo").value.trim(),
      wordmark_url: $("f-wordmark").value.trim(),
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
      brand_logo_url: $("f-brandlogo").value.trim(),
      btn_icon_url: $("f-btnicon").value.trim(),
      btn_bg: $("f-btnbg").value,
      btn_border_color: $("f-btnborderon").checked ? $("f-btnborder").value : "",
      btn_border_width: parseInt($("f-btnborderw").value, 10) || 2,
      icon_size: parseInt($("f-iconsize").value, 10) || 46,
      effect: $("f-effect").value === "ninguno" ? "" : $("f-effect").value,
      radar: $("f-effect").value === "radar",
      radar_color: $("f-radarcolor").value,
      expobot_branding: $("f-expobot").checked,
      sound: $("f-sound").checked,
      custom_css: $("f-css").value.slice(0, 5000),
      icon_btn: iconBtnSel,
      icon_send: iconSendSel,
      btn_shape: $("f-btnshape").value,
      btn_label: $("f-btnlabel").value.trim(),
      qualify_q: $("f-qualq").value.trim(),
      qualify_opts: lines($("f-qualopts").value).slice(0, 4),
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
  var mdl = (d.model || "").toLowerCase();
  if (d.provider === "google" && mdl.indexOf("claude") === 0) {
    $("save-msg").textContent = "«" + d.model + "» es un modelo de Anthropic: cambia el proveedor a Anthropic (Claude) o elige un modelo Gemini.";
    $("save-msg").className = "err";
    return;
  }
  if (d.provider === "anthropic" && mdl.indexOf("gemini") === 0) {
    $("save-msg").textContent = "«" + d.model + "» es un modelo de Google: cambia el proveedor a Google (Gemini) o elige un modelo Claude.";
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
        q.innerHTML = (x.ok ? svgIco("check") : svgIco("x")) + " "; q.appendChild(document.createTextNode(x.q));
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
        $("gap-msg").textContent = "No hay preguntas sin respuesta en los últimos 60 días.";
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
    $("ig-url").value = PUB + "/instrucciones?key=" + k + "&p=" + r.key;
  }).catch(function () { $("ig-msg").textContent = "Error al analizar."; $("ig-msg").className = "err"; });
};

$("ig-url-open").onclick = function () { window.open($("ig-url").value, "_blank"); };
$("ig-pdf").onclick = function () {
  if (!IG_LAST) return;
  var k = activeKey(curTenant());
  window.open(PUB + "/instrucciones.pdf?key=" + k + "&p=" + IG_LAST.key, "_blank");
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
    d.innerHTML = (x.ok ? svgIco("check") : svgIco("x")) + " ";
    d.appendChild(document.createTextNode(x.source + (x.ok ? " — " + x.chunks + " fragmentos" : " — " + (x.reason || "error"))));
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

function setPrimaryColor(hex) {
  var f = $("f-color");
  f.value = hex;
  f.dispatchEvent(new Event("input", { bubbles: true }));
  syncPrimary();
}
function syncPrimary() {
  var f = $("f-color");
  if (!f) return;
  var hex = f.value || "#000000";
  var dot = $("prim-hexdot"); if (dot) dot.style.background = hex;
  var hx = $("prim-hex"); if (hx && document.activeElement !== hx) hx.value = hex.toUpperCase();
  [].forEach.call(document.querySelectorAll("#prim-sw .sw"), function (b) {
    b.classList.toggle("on", b.dataset.c.toLowerCase() === hex.toLowerCase());
  });
}
function initPrimarySwatches() {
  [].forEach.call(document.querySelectorAll("#prim-sw .sw"), function (b) {
    b.onclick = function () { setPrimaryColor(b.dataset.c); };
  });
  var hx = $("prim-hex");
  if (hx) hx.addEventListener("input", function () {
    var v = this.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setPrimaryColor(v);
  });
}
initPrimarySwatches();

var SEGS = [];
function segify(id, labels) {
  var sel = $(id);
  if (!sel || sel.dataset.segified) return;
  sel.dataset.segified = "1";
  var box = document.createElement("div");
  box.className = "segfull";
  [].forEach.call(sel.options, function (o) {
    var b = document.createElement("button");
    b.type = "button";
    b.dataset.v = o.value;
    b.textContent = (labels && labels[o.value]) || o.textContent;
    b.onclick = function () {
      sel.value = o.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
    };
    box.appendChild(b);
  });
  sel.style.display = "none";
  sel.parentNode.insertBefore(box, sel.nextSibling);
  function sync() {
    [].forEach.call(box.children, function (b) { b.classList.toggle("on", b.dataset.v === sel.value); });
  }
  sel.addEventListener("change", sync);
  SEGS.push(sync);
  sync();
}
function syncSegs() { SEGS.forEach(function (f) { f(); }); }
segify("f-btnshape", { circulo: "Círculo", redondeado: "Redondeado", pastilla: "Píldora" });
segify("f-side", { derecha: "Derecha", izquierda: "Izquierda" });
segify("f-dark", { off: "Claro", auto: "Automático" });
segify("f-size", { compacto: "Compacto", estandar: "Estándar", amplio: "Amplio" });

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
<link rel="icon" type="image/png" href="/favicon.png">
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
    <div class="brand" style="margin-bottom:14px"><img src="/brand/logo.png" alt="ExpoBot" style="height:34px;width:auto;display:block"></div>
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
    <p style="margin-top:14px"><a href="#" id="l-forgot" style="color:var(--mut);font-size:13px">¿Has olvidado tu contraseña?</a></p>
  </div>
</div>

<div id="forgot" class="login hide">
  <div class="card">
    <h2>Recuperar el acceso</h2>
    <p class="sub">Dinos tu email y te enviaremos un enlace para crear una contraseña nueva.</p>
    <label>Email</label>
    <input id="fg-email" type="email" autocomplete="username">
    <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
      <button id="fg-go" class="btn">Enviarme el enlace</button>
      <span id="fg-msg" class="mut"></span>
    </div>
    <p style="margin-top:14px"><a href="#" id="fg-back" style="color:var(--mut);font-size:13px">← Volver al acceso</a></p>
  </div>
</div>

<div id="resetv" class="login hide">
  <div class="card">
    <h2>Crea tu contraseña nueva</h2>
    <p class="sub">Mínimo 8 caracteres. Al guardarla podrás entrar con ella.</p>
    <label>Contraseña nueva</label>
    <input id="rs-p1" type="password" autocomplete="new-password">
    <label>Repítela</label>
    <input id="rs-p2" type="password" autocomplete="new-password">
    <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
      <button id="rs-go" class="btn">Guardar contraseña</button>
      <span id="rs-msg" class="err"></span>
    </div>
  </div>
</div>

<div id="app" class="hide">
  <header>
    <div style="display:flex;align-items:center;gap:14px">
      <div class="brand"><img src="/brand/logo.png" alt="ExpoBot" style="height:34px;width:auto;display:block"></div>
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

    <div class="card">
      <h2>Mi cuenta</h2>
      <p class="sub">Tu email de acceso (donde recibes también los informes) y tu contraseña.
      Para guardar cualquier cambio necesitas tu contraseña actual.</p>
      <div class="row2">
        <div><label>Email de acceso</label><input id="ac-email" type="email" autocomplete="username"></div>
        <div><label>Contraseña actual</label><input id="ac-cur" type="password" autocomplete="current-password"></div>
      </div>
      <div class="row2">
        <div><label>Nueva contraseña (opcional, mínimo 8 caracteres)</label><input id="ac-new" type="password" autocomplete="new-password"></div>
        <div><label>Repite la nueva contraseña</label><input id="ac-new2" type="password" autocomplete="new-password"></div>
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
        <button id="ac-save" class="btn">Guardar cambios</button>
        <span id="ac-msg" class="mut"></span>
      </div>
    </div>
  </main>
  <footer>Impulsado por <b>ExpoBot</b> — estudio de asistentes IA</footer>
</div>

<script>
var TOKEN = localStorage.getItem("cb_portal") || "";
// ---- iconos de línea ----
var IC = {
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14M10 11v6M14 11v6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M17.9 17.9A10 10 0 0 1 12 20C5 20 2 12 2 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.2 3.2m-6.7-1.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l1.7-1.3-1.7-3-2 .8a7.6 7.6 0 0 0-1.8-1L15 4H9l-.6 2.5a7.6 7.6 0 0 0-1.8 1l-2-.8-1.7 3L4.6 11a7.6 7.6 0 0 0 0 2l-1.7 1.3 1.7 3 2-.8a7.6 7.6 0 0 0 1.8 1L9 20h6l.6-2.5a7.6 7.6 0 0 0 1.8-1l2 .8 1.7-3z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M15 13H9M15 17H9"/>',
  edit: '<path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  warning: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  sparkles: '<path d="M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16l-1.7-4.8L5.5 9.5l4.8-1.7z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  chat: '<path d="M21 11.5a8 8 0 0 1-8.5 8 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8 8 0 0 1 4 11.5a8 8 0 0 1 8.5-8 8 8 0 0 1 8.5 8z"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v2.5M12 20v2.5M4 4l1.8 1.8M18.2 18.2L20 20M1.5 12h2.5M20 12h2.5M4 20l1.8-1.8M18.2 5.8L20 4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 14v4M12 9v9M17 5v13"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  building: '<path d="M3 21h18M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2.5" width="8" height="4" rx="1"/>',
  brain: '<path d="M9.5 3A3 3 0 0 0 7 8a3 3 0 0 0-1 5.5A3 3 0 0 0 9 19a2.5 2.5 0 0 0 3-2.5V4.5A1.5 1.5 0 0 0 9.5 3zM14.5 3A3 3 0 0 1 17 8a3 3 0 0 1 1 5.5A3 3 0 0 1 15 19a2.5 2.5 0 0 1-3-2.5"/>',
  rocket: '<path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2a2.8 2.8 0 0 0-3-3z"/><path d="M9 12a15 15 0 0 1 8-8c2 0 3 1 3 3a15 15 0 0 1-8 8zM15 9h.01"/><path d="M9 12L7 10a10 10 0 0 1 4-1M12 15l2 2a10 10 0 0 0 1-4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  drop: '<path d="M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  party: '<path d="M4 20l5-14 9 9-14 5zM14 6a3 3 0 0 0-3-3M17 9a3 3 0 0 0 3-3M13 2h.01M21 10h.01M20 14h.01"/>',
  activity: '<path d="M3 12h4l2.5 7 5-14L17 12h4"/>',
  cap: '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.8 3 3 6 3s6-1.2 6-3v-5"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.3a3 3 0 0 1 5.6 1c0 2-3 2.5-3 4M12 17.5h.01"/>'
};
function svgIco(n, s) {
  return '<svg class="ic" viewBox="0 0 24 24" width="' + (s || 16) + '" height="' + (s || 16) +
    '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true">' +
    (IC[n] || "") + "</svg>";
}


function $(id) { return document.getElementById(id); }

function showLogin(msg) {
  $("app").classList.add("hide");
  $("forgot").classList.add("hide");
  $("resetv").classList.add("hide");
  $("login").classList.remove("hide");
  $("l-msg").textContent = msg || "";
}

function euros(cents, cur) {
  return (cents / 100).toLocaleString("es-ES", { minimumFractionDigits: 2 }) + " " + (!cur || cur === "EUR" ? "€" : cur);
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

// ----- olvido y restablecimiento de contraseña -----

var RESET_TOKEN = new URLSearchParams(location.search).get("reset") || "";

$("l-forgot").onclick = function (e) {
  e.preventDefault();
  $("login").classList.add("hide");
  $("forgot").classList.remove("hide");
  $("fg-msg").textContent = "";
  $("fg-email").value = $("l-email").value;
  $("fg-email").focus();
};
$("fg-back").onclick = function (e) { e.preventDefault(); showLogin(); };

$("fg-go").onclick = function () {
  var em = $("fg-email").value.trim();
  if (em.indexOf("@") < 1) { $("fg-msg").textContent = "Escribe tu email."; $("fg-msg").className = "err"; return; }
  $("fg-go").disabled = true;
  $("fg-msg").textContent = "Enviando…"; $("fg-msg").className = "mut";
  fetch("/portal/forgot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: em }),
  }).then(function (r) { return r.json(); }).then(function () {
    $("fg-msg").textContent = "Hecho: si ese email está registrado, te llegará un enlace en unos minutos (mira también en spam).";
    $("fg-msg").className = "ok";
  }).catch(function () {
    $("fg-go").disabled = false;
    $("fg-msg").textContent = "No se ha podido conectar."; $("fg-msg").className = "err";
  });
};

$("rs-go").onclick = function () {
  var p1 = $("rs-p1").value, p2 = $("rs-p2").value;
  if (p1.length < 8) { $("rs-msg").textContent = "Mínimo 8 caracteres."; return; }
  if (p1 !== p2) { $("rs-msg").textContent = "No coinciden."; return; }
  $("rs-msg").textContent = "";
  fetch("/portal/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: RESET_TOKEN, new_password: p1 }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.error) { $("rs-msg").textContent = d.error; return; }
    history.replaceState(null, "", "/acceso");
    RESET_TOKEN = "";
    showLogin();
    $("l-msg").textContent = "Contraseña guardada ✓ Entra con ella.";
    $("l-msg").className = "ok";
  }).catch(function () { $("rs-msg").textContent = "No se ha podido conectar."; });
};

// ----- ojo para mostrar/ocultar contraseñas -----

function addEyes() {
  [].forEach.call(document.querySelectorAll('input[type="password"]'), function (inp) {
    if (inp.dataset.eye) return;
    inp.dataset.eye = "1";
    var w = document.createElement("span");
    w.style.cssText = "position:relative;display:block";
    inp.parentNode.insertBefore(w, inp);
    w.appendChild(inp);
    inp.style.paddingRight = "42px";
    var b = document.createElement("button");
    b.type = "button";
    b.innerHTML = svgIco("eye");
    b.title = "Mostrar u ocultar";
    b.setAttribute("aria-label", "Mostrar u ocultar la contraseña");
    b.style.cssText = "position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;" +
      "background:none;cursor:pointer;font-size:16px;padding:4px 6px;opacity:.55;line-height:1";
    b.onclick = function () {
      var show = inp.type === "password";
      inp.type = show ? "text" : "password";
      b.style.opacity = show ? "1" : ".55";
      inp.focus();
    };
    w.appendChild(b);
  });
}
addEyes();

function load() {
  fetch("/portal/data", { headers: { Authorization: "Bearer " + TOKEN } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { showLogin(TOKEN ? "" : undefined); return; }
      $("login").classList.add("hide");
      $("app").classList.remove("hide");
      $("c-name").textContent = d.name;
      $("ac-email").value = d.email || "";

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
          nm.innerHTML = svgIco("chat") + " "; nm.appendChild(document.createTextNode(t.name));
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
        var cc = document.createElement("td");
        cc.textContent = v.concept || "";
        if (v.period_start || v.period_end) {
          var pd = document.createElement("div");
          pd.className = "mut"; pd.style.fontSize = "12px";
          pd.textContent = "Periodo: " + (v.period_start || "—") + " a " + (v.period_end || "—");
          cc.appendChild(pd);
        }
        tr.appendChild(cc);
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
            // se abre la pestaña ya (gesto del usuario) y se navega tras pedir el enlace
            var w = window.open("", "_blank");
            fetch("/portal/invoice-link", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
              body: JSON.stringify({ id: v.id }),
            }).then(function (r) { return r.json(); }).then(function (d) {
              if (d.token && w) { w.location = "/portal/invoice?dl=" + encodeURIComponent(d.token); }
              else if (w) { w.close(); }
            }).catch(function () { if (w) w.close(); });
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

$("ac-save").onclick = function () {
  var cur = $("ac-cur").value;
  var np = $("ac-new").value;
  var np2 = $("ac-new2").value;
  var em = $("ac-email").value.trim();
  if (!cur) { $("ac-msg").textContent = "Escribe tu contraseña actual."; $("ac-msg").className = "err"; return; }
  if (np || np2) {
    if (np !== np2) { $("ac-msg").textContent = "Las contraseñas nuevas no coinciden."; $("ac-msg").className = "err"; return; }
    if (np.length < 8) { $("ac-msg").textContent = "La contraseña nueva debe tener al menos 8 caracteres."; $("ac-msg").className = "err"; return; }
  }
  if (em.indexOf("@") < 1) { $("ac-msg").textContent = "El email no parece válido."; $("ac-msg").className = "err"; return; }
  $("ac-msg").textContent = "Guardando…"; $("ac-msg").className = "mut";
  fetch("/portal/account", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ current: cur, email: em, new_password: np || null }),
  }).then(function (r) { return r.json(); }).then(function (r) {
    if (r.error) { $("ac-msg").textContent = r.error; $("ac-msg").className = "err"; return; }
    // al cambiar la contraseña el servidor entrega un token nuevo (el anterior se revoca)
    if (r.token) { TOKEN = r.token; localStorage.setItem("cb_portal", TOKEN); }
    var did = r.changed || [];
    $("ac-msg").textContent = did.length
      ? "Guardado ✓" + (did.indexOf("email") >= 0 ? " A partir de ahora entra con " + em + "." : "")
      : "No había nada que cambiar.";
    $("ac-msg").className = "ok";
    $("ac-cur").value = ""; $("ac-new").value = ""; $("ac-new2").value = "";
  }).catch(function () { $("ac-msg").textContent = "Error al guardar."; $("ac-msg").className = "err"; });
};

if (RESET_TOKEN) {
  $("login").classList.add("hide");
  $("resetv").classList.remove("hide");
} else if (TOKEN) {
  load();
} else {
  showLogin();
}
</script>
</body>
</html>`;

// ---------- formulario de preguntas frecuentes (lo rellena el cliente) ----------

const FAQ_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
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
// ---- iconos de línea ----
var IC = {
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14M10 11v6M14 11v6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M17.9 17.9A10 10 0 0 1 12 20C5 20 2 12 2 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.2 3.2m-6.7-1.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l1.7-1.3-1.7-3-2 .8a7.6 7.6 0 0 0-1.8-1L15 4H9l-.6 2.5a7.6 7.6 0 0 0-1.8 1l-2-.8-1.7 3L4.6 11a7.6 7.6 0 0 0 0 2l-1.7 1.3 1.7 3 2-.8a7.6 7.6 0 0 0 1.8 1L9 20h6l.6-2.5a7.6 7.6 0 0 0 1.8-1l2 .8 1.7-3z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M15 13H9M15 17H9"/>',
  edit: '<path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  warning: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  sparkles: '<path d="M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16l-1.7-4.8L5.5 9.5l4.8-1.7z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  chat: '<path d="M21 11.5a8 8 0 0 1-8.5 8 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8 8 0 0 1 4 11.5a8 8 0 0 1 8.5-8 8 8 0 0 1 8.5 8z"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v2.5M12 20v2.5M4 4l1.8 1.8M18.2 18.2L20 20M1.5 12h2.5M20 12h2.5M4 20l1.8-1.8M18.2 5.8L20 4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 14v4M12 9v9M17 5v13"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  building: '<path d="M3 21h18M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2.5" width="8" height="4" rx="1"/>',
  brain: '<path d="M9.5 3A3 3 0 0 0 7 8a3 3 0 0 0-1 5.5A3 3 0 0 0 9 19a2.5 2.5 0 0 0 3-2.5V4.5A1.5 1.5 0 0 0 9.5 3zM14.5 3A3 3 0 0 1 17 8a3 3 0 0 1 1 5.5A3 3 0 0 1 15 19a2.5 2.5 0 0 1-3-2.5"/>',
  rocket: '<path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2a2.8 2.8 0 0 0-3-3z"/><path d="M9 12a15 15 0 0 1 8-8c2 0 3 1 3 3a15 15 0 0 1-8 8zM15 9h.01"/><path d="M9 12L7 10a10 10 0 0 1 4-1M12 15l2 2a10 10 0 0 0 1-4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  drop: '<path d="M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  party: '<path d="M4 20l5-14 9 9-14 5zM14 6a3 3 0 0 0-3-3M17 9a3 3 0 0 0 3-3M13 2h.01M21 10h.01M20 14h.01"/>',
  activity: '<path d="M3 12h4l2.5 7 5-14L17 12h4"/>',
  cap: '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.8 3 3 6 3s6-1.2 6-3v-5"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.3a3 3 0 0 1 5.6 1c0 2-3 2.5-3 4M12 17.5h.01"/>'
};
function svgIco(n, s) {
  return '<svg class="ic" viewBox="0 0 24 24" width="' + (s || 16) + '" height="' + (s || 16) +
    '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true">' +
    (IC[n] || "") + "</svg>";
}

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
    body: JSON.stringify({ items: ready }),
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
<link rel="icon" type="image/png" href="/favicon.png">
<meta name="robots" content="noindex">
<title>Panel del asistente — ExpoBot</title>
<style>
  :root{--ink:#111;--mut:#6b6b67;--line:#deded9;--bg:#f3f3f0;--card:#fff;--soft:#f6f6f2;
    --acc:#f9be00;--ok:#238a57;--err:#b3261e;--chip:#eeeeea;--userbub:#f9be00;--botbub:#eeeeea}
  *{box-sizing:border-box;margin:0}
  html{background:var(--bg)}
  body.panel-client{font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    color:var(--ink);background:var(--bg);min-height:100vh}
  .hide{display:none!important}
  button,input,select,textarea{font:inherit}
  button{cursor:pointer}
  input,select,textarea{border:1px solid var(--line);border-radius:3px;padding:9px 11px;background:#fff;color:var(--ink)}
  input:focus,select:focus,textarea:focus{outline:0;border-color:#111;box-shadow:0 0 0 2px rgba(249,190,0,.42)}
  .panel-shell{display:grid;grid-template-columns:108px minmax(0,1fr);min-height:100vh}
  #client-sidebar{position:sticky;top:0;height:100vh;background:#111;padding:25px 14px 20px!important;
    display:flex;flex-direction:column;align-items:center;z-index:20;min-height:0!important}
  .side-logo{width:66px;height:auto;display:block;margin:10px auto 58px}
  #client-nav{display:flex;flex-direction:column;gap:12px;width:100%;margin:0}
  body.panel-client #client-nav button{width:52px;height:52px;margin:0 auto;border:1px solid #4d4d4d;background:transparent!important;
    color:#bdbdb7!important;border-radius:5px!important;display:grid;place-items:center;padding:0;position:relative}
  body.panel-client #client-nav button:hover{border-color:var(--acc);color:#fff!important}
  body.panel-client #client-nav button.on{background:var(--acc)!important;border-color:var(--acc)!important;color:#111!important}
  .nav-ico{font-size:20px;line-height:1;font-weight:700}
  .nav-label{position:absolute;left:66px;top:50%;transform:translateY(-50%);background:#111;color:#fff;
    border:1px solid #3a3a3a;padding:6px 9px;white-space:nowrap;font-size:12px;opacity:0;pointer-events:none;z-index:3}
  #client-nav button:hover .nav-label,#client-nav button:focus-visible .nav-label{opacity:1}
  #client-nav .badge{position:absolute;right:-6px;top:-6px;background:var(--err);color:#fff;border-radius:10px;
    min-width:19px;padding:1px 5px;font-size:10px;font-weight:800}
  .side-bottom{margin-top:auto;display:grid;gap:12px;justify-items:center}
  .side-link{width:44px;height:44px;border:1px solid #4d4d4d;color:#ddd;text-decoration:none;display:grid;place-items:center;border-radius:50%}
  #cdot,#clogo{width:44px;height:44px;border-radius:50%;border:1px solid #666;object-fit:cover}
  #clogo{display:none}
  #cdot{display:grid;place-items:center;background:#3d3d3d;color:#fff;font-weight:750}
  .panel-page{min-width:0}
  body.panel-client #main{max-width:1600px;margin:0 auto;padding:44px 48px 54px!important}
  .client-top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:28px}
  .eyebrow{font-size:11px;text-transform:uppercase;font-weight:800;color:#8a8a84;letter-spacing:0}
  .live-tag{display:inline-flex;background:#111;color:#fff;padding:9px 14px;font-size:10px;font-weight:800;
    text-transform:uppercase;margin-bottom:16px}
  h1{font-size:32px;line-height:1.08;letter-spacing:0;font-weight:790;margin-top:4px}
  .top-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap;justify-content:flex-end}
  .period-control{display:flex;background:#fff;border:1px solid var(--line);padding:3px}
  .period-control button{border:0;background:transparent;padding:8px 11px;color:var(--mut);font-size:12px}
  .period-control button.on{background:#111!important;color:#fff!important}
  .ghost,.mini{background:#fff;border:1px solid var(--line);color:var(--ink);border-radius:3px;padding:8px 12px;font-size:13px}
  .ghost:hover,.mini:hover{border-color:#111}
  .kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:18px}
  .kpi{background:#fff;border:1px solid var(--line);min-height:126px;padding:24px 26px;display:flex;flex-direction:column;
    align-items:flex-start;justify-content:space-between}
  .kpi.accent{background:var(--acc);border-color:var(--acc)}
  .kpi-label{font-size:13px;color:var(--mut)}
  .kpi.accent .kpi-label{color:#4b3900}
  .kpi-line{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
  .kpi b{font-size:42px;line-height:1;font-weight:780;font-variant-numeric:tabular-nums}
  .trend{font-size:12px;font-weight:700;color:#777}
  .trend.up{color:var(--ok)}.trend.down{color:var(--err)}.kpi.accent .trend{color:#5c4700}
  section{display:none}section.on{display:block}
  .overview-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(300px,1fr);gap:16px;margin-bottom:16px}
  .box{background:#fff;border:1px solid var(--line);padding:22px}
  .panel-title{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:18px}
  .panel-title h2{font-size:15px}.panel-title span{font-size:12px;color:var(--mut)}
  #chart{height:174px;display:flex;align-items:flex-end;gap:10px;padding-top:8px;border-bottom:1px solid var(--line)}
  body.panel-client #chart div{flex:1;background:#d7d7d2!important;min-height:3px;transition:opacity .15s;position:relative}
  body.panel-client #chart div.hot{background:var(--acc)!important}
  #chart div:hover{opacity:.68}
  .axis{display:flex;justify-content:space-between;color:#8a8a84;font-size:10px;margin-top:8px;text-transform:uppercase}
  #topics{display:grid;gap:0}
  .topic{display:grid;grid-template-columns:minmax(0,1fr) 46px;gap:12px;padding:11px 0;border-bottom:1px solid var(--line);font-size:13px}
  .topic:last-child{border-bottom:0}.topic strong{text-align:right;color:#9a7400;font-size:12px}
  .recent-box{margin-bottom:18px}
  .recent-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
  .recent-head h2{font-size:15px}
  .text-link{background:none;border:0;padding:4px;color:#222;font-size:13px}
  .recent-lead{display:grid;grid-template-columns:minmax(220px,1.2fr) minmax(240px,1.4fr) 86px;
    gap:14px;align-items:center;padding:10px 8px;border-top:1px solid var(--line);font-size:12px}
  .recent-lead.is-new{background:#fff8dc}
  .lead-person{display:flex;align-items:center;gap:10px;min-width:0}.lead-avatar{width:32px;height:32px;border-radius:50%;
    background:#e6e6e2;display:grid;place-items:center;font-weight:750;flex:none}
  .lead-person b,.lead-person span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lead-person span,.lead-time{color:var(--mut)}.lead-intent{background:#fff4c8;padding:7px 9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .section-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-end;margin-bottom:18px}
  .section-head h2{font-size:25px;line-height:1.1}.section-head p{color:var(--mut);font-size:13px;margin-top:6px}
  .filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
  .filters input[type="search"]{flex:1;min-width:210px}.filters .count{color:var(--mut);font-size:13px;white-space:nowrap}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);overflow:hidden}
  th,td{text-align:left;padding:11px 13px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
  th{background:#111!important;color:#fff!important;font-weight:650;font-size:10px;text-transform:uppercase;letter-spacing:0}
  tr:last-child td{border-bottom:0}.mut{color:var(--mut);font-size:13px}.ok{color:var(--ok);font-size:13px}.err{color:var(--err);font-size:13px}
  .twrap{overflow-x:auto}.twrap table{min-width:760px}
  .conv{background:#fff;border:1px solid var(--line);margin-bottom:9px;overflow:hidden}
  .conv>button{width:100%;text-align:left;background:none;border:0;padding:14px 16px;color:var(--ink);display:flex;
    justify-content:space-between;gap:12px;align-items:center}.conv .meta{color:var(--mut);font-size:12px;white-space:nowrap}
  .msgs{display:none;border-top:1px solid var(--line);padding:16px}.conv.open .msgs{display:block}
  .m{width:fit-content;max-width:80%;padding:9px 12px;margin-bottom:8px;white-space:pre-wrap;font-size:14px}
  .m.user{background:var(--userbub);margin-left:auto}.m.assistant{background:var(--botbub)}.convdel{margin-top:8px;text-align:right}
  .btn{background:#111;color:#fff;border:.75px solid var(--acc);border-radius:3px;padding:10px 15px;font-weight:650}
  .btn:disabled{opacity:.5;cursor:default}.mini{padding:5px 9px}.del{background:none;border:0;font-size:15px;opacity:.55;padding:3px 6px}.del:hover{opacity:1}
  .done{color:var(--ok);font-size:12px;white-space:nowrap}
  .gapcard{background:#fff;border:1px solid var(--line);padding:16px;margin-bottom:9px}.gapcard .q{font-weight:650;margin-bottom:2px}
  .gapcard textarea{width:100%;margin-top:10px;resize:vertical}.garow{display:flex;gap:10px;align-items:center;margin-top:8px}
  .doc{display:flex;justify-content:space-between;align-items:center;gap:10px;background:#fff;border:1px solid var(--line);
    padding:11px 14px;margin-bottom:8px;font-size:14px}.doc .meta{color:var(--mut);font-size:12px}
  #up-files{border:1px dashed #aaa;padding:18px;width:100%;background:var(--soft)}
  .empty{background:#fff;border:1px dashed #aaa;padding:28px;text-align:center;color:var(--mut)}.empty b{color:var(--ink);display:block;margin-bottom:6px}
  .panel-footer{color:var(--mut);font-size:12px;padding:28px 0 4px;border-top:1px solid var(--line);margin-top:26px}
  @media(max-width:980px){.panel-shell{grid-template-columns:82px minmax(0,1fr)}body.panel-client #main{padding:30px 24px 42px!important}
    .overview-grid{grid-template-columns:1fr}.nav-label{display:none}.side-logo{width:54px}.kpi b{font-size:35px}}
  @media(max-width:720px){.panel-shell{display:block}#client-sidebar{height:auto;position:sticky;top:0;display:flex;flex-direction:row;
      overflow-x:auto;padding:9px 12px!important;gap:10px;align-items:center}.side-logo{width:78px;margin:0 10px 0 0;flex:none}
    #client-nav{flex-direction:row;gap:7px;width:auto;margin:0}body.panel-client #client-nav button{width:42px;height:42px;flex:none}
    .nav-ico{font-size:17px}.side-bottom{margin:0 0 0 auto;display:flex}.side-link{display:none}#cdot,#clogo{width:38px;height:38px;flex:none}
    body.panel-client #main{padding:24px 14px 38px!important}.client-top{display:block}.top-actions{justify-content:flex-start;margin-top:18px}
    h1{font-size:27px}.kpis{grid-template-columns:1fr}.kpi{min-height:105px}.overview-grid{grid-template-columns:1fr}
    #chart{height:140px;gap:5px}.recent-lead{grid-template-columns:minmax(0,1fr) 62px}.lead-intent{display:none}
    .section-head{display:block}.filters>*{flex:1 1 140px}.filters .count{flex-basis:100%}.m{max-width:92%}}
  @media(prefers-reduced-motion:reduce){*,*:before,*:after{transition:none!important;animation:none!important}}
</style>
</head>
<body class="panel-client">
<div class="panel-shell">
  <aside id="client-sidebar" aria-label="Navegación del panel">
    <img class="side-logo" src="/brand/logo.png" alt="ExpoBot">
    <nav id="client-nav">
      <button class="on" data-tab="t-overview" aria-label="Resumen"><span class="nav-ico" aria-hidden="true">⌂</span><span class="nav-label">Resumen</span></button>
      <button data-tab="t-leads" aria-label="Leads"><span class="nav-ico" aria-hidden="true">◎</span><span class="nav-label">Leads</span><span class="badge hide" id="bg-leads"></span></button>
      <button data-tab="t-convs" aria-label="Conversaciones"><span class="nav-ico" aria-hidden="true">□</span><span class="nav-label">Conversaciones</span><span class="badge hide" id="bg-convs"></span></button>
      <button data-tab="t-gaps" aria-label="Preguntas pendientes"><span class="nav-ico" aria-hidden="true">?</span><span class="nav-label">Preguntas pendientes</span></button>
      <button data-tab="t-add" aria-label="Conocimiento"><span class="nav-ico" aria-hidden="true">+</span><span class="nav-label">Conocimiento</span></button>
      <button data-tab="t-test" aria-label="Probar asistente"><span class="nav-ico" aria-hidden="true">▷</span><span class="nav-label">Probar asistente</span></button>
    </nav>
    <div class="side-bottom">
      <a class="side-link" href="/acceso" target="_blank" rel="noopener" aria-label="Facturación" title="Facturación">€</a>
      <img id="clogo" alt=""><div id="cdot" aria-label="Cuenta del asistente">·</div>
    </div>
  </aside>
  <div class="panel-page">
    <main id="main">
      <div class="client-top">
        <div>
          <div class="live-tag">Actividad en tiempo real</div>
          <div class="eyebrow" id="greeting">Buenos días</div>
          <h1>Panel de actividad</h1>
          <div class="mut" id="name">Cargando…</div>
        </div>
        <div class="top-actions">
          <div class="period-control" id="period" aria-label="Periodo analizado">
            <button data-d="7">7 días</button><button data-d="30" class="on">30 días</button><button data-d="90">90 días</button>
          </div>
          <button id="pdf" class="ghost">Informe PDF</button>
        </div>
      </div>

      <div class="kpis">
        <div class="kpi"><span class="kpi-label">Conversaciones</span><div class="kpi-line"><b id="s-convs">–</b><span class="trend" id="tr-convs"></span></div></div>
        <div class="kpi accent"><span class="kpi-label">Leads captados</span><div class="kpi-line"><b id="s-leads">–</b><span class="trend" id="tr-leads"></span></div></div>
        <div class="kpi"><span class="kpi-label">Tasa de resolución</span><div class="kpi-line"><b id="s-rate">–</b><span class="trend" id="tr-rate"></span></div></div>
      </div>

      <section id="t-overview" class="on">
        <div class="overview-grid">
          <div class="box chartbox">
            <div class="panel-title"><h2>Actividad</h2><span><b id="s-msgs">–</b> preguntas recibidas</span></div>
            <div id="chart"></div><div class="axis"><span id="ax-from"></span><span id="ax-to"></span></div>
          </div>
          <div class="box"><div class="panel-title"><h2>Temas más consultados</h2><span id="topics-total"></span></div><div id="topics"></div></div>
        </div>
        <div class="box recent-box">
          <div class="recent-head"><h2>Últimos leads</h2><button class="text-link" id="recent-all">Ver todos →</button></div>
          <div id="recent-leads"></div>
        </div>
      </section>

      <section id="t-leads">
        <div class="section-head"><div><h2>Leads</h2><p>Contactos captados y estado de seguimiento comercial.</p></div></div>
        <div class="filters"><input id="lf-q" type="search" placeholder="Buscar por nombre, email o empresa">
          <select id="lf-status"><option value="">Todos</option><option value="nuevo">Nuevos</option><option value="contactado">Contactados</option></select>
          <input id="lf-from" type="date" title="Desde"><input id="lf-to" type="date" title="Hasta"><span class="count" id="lf-count"></span><button id="csv" class="ghost">Descargar CSV</button></div>
        <div class="twrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Nombre</th><th>Contacto</th><th>Qué necesita</th><th>Estado</th><th></th></tr></thead><tbody id="leads-body"></tbody></table></div>
        <div id="leads-empty" class="empty hide"><b>Todavía no hay leads</b>Cuando un visitante deje sus datos en el chat aparecerá aquí al momento.</div>
      </section>

      <section id="t-convs">
        <div class="section-head"><div><h2>Conversaciones</h2><p>Historial completo de consultas y respuestas del asistente.</p></div></div>
        <div class="filters"><input id="cf-q" type="search" placeholder="Buscar en las conversaciones"><input id="cf-from" type="date" title="Desde"><input id="cf-to" type="date" title="Hasta"><span class="count" id="cf-count"></span><button id="ccsv" class="ghost">Descargar CSV</button></div>
        <div id="convs"></div><div id="convs-empty" class="empty hide"><b>Todavía no hay conversaciones</b>En cuanto alguien hable con tu asistente verás aquí cada conversación completa.</div>
      </section>

      <section id="t-gaps">
        <div class="section-head"><div><h2>Preguntas pendientes</h2><p>Responde las consultas para las que el asistente todavía no encontró información.</p></div></div>
        <div id="gaps-list"></div><div id="gaps-empty" class="empty hide"><b>Ninguna pendiente</b>El asistente ha encontrado respuesta para todo lo que le han preguntado últimamente.</div>
      </section>

      <section id="t-add">
        <div class="section-head"><div><h2>Conocimiento</h2><p>Documentos e información que utiliza el asistente para responder.</p></div></div>
        <div class="box" style="margin-bottom:14px"><p style="margin-bottom:10px"><b>Subir documentos</b> <span class="mut">PDF, TXT, CSV o imágenes; máximo 10 MB por archivo.</span></p>
          <input id="up-files" type="file" multiple accept=".pdf,.txt,.md,.csv,.html,.htm,.jpg,.jpeg,.png,.webp,.svg">
          <div style="margin-top:12px;display:flex;gap:10px;align-items:center"><button id="up-run" class="btn">Subir e indexar</button><span id="up-msg" class="mut"></span></div><div id="up-report" class="mut" style="margin-top:10px"></div></div>
        <p class="mut" style="margin-bottom:10px"><b>Contenido indexado.</b> Puedes retirar la información obsoleta; dejará de utilizarse al momento.</p><div id="docs-list"></div>
      </section>

      <section id="t-test">
        <div class="section-head"><div><h2>Probar el asistente</h2><p>Comprueba la experiencia exactamente como la verá un visitante.</p></div></div>
        <div class="box"><p><b>El botón del asistente está en la esquina inferior derecha.</b></p><p class="mut" style="margin-top:8px">Las conversaciones de prueba también quedan registradas. Si acabas de subir contenido, pregúntale sobre ello para comprobarlo.</p></div>
      </section>

      <footer class="panel-footer">© 2026 · Panel privado del cliente.</footer>
    </main>
  </div>
</div><script>
var token = new URLSearchParams(location.search).get("token") || "";
// ---- iconos de línea ----
var IC = {
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14M10 11v6M14 11v6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M17.9 17.9A10 10 0 0 1 12 20C5 20 2 12 2 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.2 3.2m-6.7-1.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l1.7-1.3-1.7-3-2 .8a7.6 7.6 0 0 0-1.8-1L15 4H9l-.6 2.5a7.6 7.6 0 0 0-1.8 1l-2-.8-1.7 3L4.6 11a7.6 7.6 0 0 0 0 2l-1.7 1.3 1.7 3 2-.8a7.6 7.6 0 0 0 1.8 1L9 20h6l.6-2.5a7.6 7.6 0 0 0 1.8-1l2 .8 1.7-3z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M15 13H9M15 17H9"/>',
  edit: '<path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  warning: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  sparkles: '<path d="M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16l-1.7-4.8L5.5 9.5l4.8-1.7z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  chat: '<path d="M21 11.5a8 8 0 0 1-8.5 8 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8 8 0 0 1 4 11.5a8 8 0 0 1 8.5-8 8 8 0 0 1 8.5 8z"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v2.5M12 20v2.5M4 4l1.8 1.8M18.2 18.2L20 20M1.5 12h2.5M20 12h2.5M4 20l1.8-1.8M18.2 5.8L20 4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 14v4M12 9v9M17 5v13"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  building: '<path d="M3 21h18M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2.5" width="8" height="4" rx="1"/>',
  brain: '<path d="M9.5 3A3 3 0 0 0 7 8a3 3 0 0 0-1 5.5A3 3 0 0 0 9 19a2.5 2.5 0 0 0 3-2.5V4.5A1.5 1.5 0 0 0 9.5 3zM14.5 3A3 3 0 0 1 17 8a3 3 0 0 1 1 5.5A3 3 0 0 1 15 19a2.5 2.5 0 0 1-3-2.5"/>',
  rocket: '<path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2a2.8 2.8 0 0 0-3-3z"/><path d="M9 12a15 15 0 0 1 8-8c2 0 3 1 3 3a15 15 0 0 1-8 8zM15 9h.01"/><path d="M9 12L7 10a10 10 0 0 1 4-1M12 15l2 2a10 10 0 0 0 1-4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  drop: '<path d="M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  party: '<path d="M4 20l5-14 9 9-14 5zM14 6a3 3 0 0 0-3-3M17 9a3 3 0 0 0 3-3M13 2h.01M21 10h.01M20 14h.01"/>',
  activity: '<path d="M3 12h4l2.5 7 5-14L17 12h4"/>',
  cap: '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.8 3 3 6 3s6-1.2 6-3v-5"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.3a3 3 0 0 1 5.6 1c0 2-3 2.5-3 4M12 17.5h.01"/>'
};
function svgIco(n, s) {
  return '<svg class="ic" viewBox="0 0 24 24" width="' + (s || 16) + '" height="' + (s || 16) +
    '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-.18em;flex:none" aria-hidden="true">' +
    (IC[n] || "") + "</svg>";
}

var LEADS = [], CONVS = [], GAPS = [], DOCS = [], ACT = [];
var PERIOD = 30;
var PRIMARY = "#3c62f0";
var SEEN_KEY = "cb_seen_" + token.slice(-10);
var LAST_VISIT = localStorage.getItem(SEEN_KEY) || "";
var hourNow = new Date().getHours();
$("greeting").textContent = hourNow < 12 ? "Buenos días" : hourNow < 20 ? "Buenas tardes" : "Buenas noches";

function $(id) { return document.getElementById(id); }
function esc(t) { var d = document.createElement("div"); d.textContent = t == null ? "" : t; return d.innerHTML; }
function fmt(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function day(iso) { return (iso || "").slice(0, 10); }
function sinceDate() {
  return new Date(Date.now() - PERIOD * 24 * 3600 * 1000).toISOString();
}

document.querySelectorAll("nav button").forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll("nav button").forEach(function (x) { x.classList.remove("on"); });
    document.querySelectorAll("section").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on");
    $(b.dataset.tab).classList.add("on");
  };
});

[].forEach.call(document.querySelectorAll("#period button"), function (b) {
  b.onclick = function () {
    PERIOD = parseInt(b.dataset.d, 10);
    [].forEach.call(document.querySelectorAll("#period button"), function (x) {
      x.classList.toggle("on", x === b);
    });
    renderStats();
    renderChart();
  };
});

$("recent-all").onclick = function () { var b = document.querySelector('nav button[data-tab="t-leads"]'); if (b) b.onclick(); };

$("pdf").onclick = function () {
  window.open("/panel/report.pdf?token=" + encodeURIComponent(token), "_blank");
};

function pctTrend(current, previous, id, suffix) {
  var el = $(id);
  if (!el) return;
  el.className = "trend";
  if (!previous && !current) { el.textContent = "sin cambios"; return; }
  var diff = previous ? Math.round(((current - previous) / previous) * 1000) / 10 : 100;
  el.textContent = (diff > 0 ? "↑ " : diff < 0 ? "↓ " : "") + Math.abs(diff).toLocaleString("es-ES") + (suffix || "%");
  el.classList.add(diff > 0 ? "up" : diff < 0 ? "down" : "flat");
}

function periodSnapshot(fromMs, toMs) {
  var convs = CONVS.filter(function (c) {
    var at = new Date(c.last_message_at || c.created_at).getTime();
    return at >= fromMs && at < toMs;
  });
  var leads = LEADS.filter(function (l) {
    var at = new Date(l.created_at).getTime();
    return at >= fromMs && at < toMs;
  });
  var userMsgs = 0, answered = 0, assistantMsgs = 0;
  convs.forEach(function (c) {
    (c.messages || []).forEach(function (m) {
      var at = m.created_at ? new Date(m.created_at).getTime() : toMs - 1;
      if (at < fromMs || at >= toMs) return;
      if (m.role === "user") userMsgs++;
      if (m.role === "assistant") {
        assistantMsgs++;
        if (m.was_answered !== false) answered++;
      }
    });
  });
  return { convs: convs.length, leads: leads.length, userMsgs: userMsgs,
    rate: assistantMsgs ? Math.round((100 * answered) / assistantMsgs) : 0, assistantMsgs: assistantMsgs };
}

function renderStats() {
  var now = Date.now();
  var span = PERIOD * 24 * 3600 * 1000;
  var current = periodSnapshot(now - span, now + 1000);
  var previous = periodSnapshot(now - span * 2, now - span);
  $("s-convs").textContent = current.convs;
  $("s-msgs").textContent = current.userMsgs;
  $("s-leads").textContent = current.leads;
  $("s-rate").textContent = current.assistantMsgs ? current.rate + "%" : "–";
  pctTrend(current.convs, previous.convs, "tr-convs");
  pctTrend(current.leads, previous.leads, "tr-leads");
  var rateDiff = current.rate - previous.rate;
  var rateEl = $("tr-rate");
  rateEl.className = "trend " + (rateDiff > 0 ? "up" : rateDiff < 0 ? "down" : "flat");
  rateEl.textContent = previous.assistantMsgs ? (rateDiff > 0 ? "↑ " : rateDiff < 0 ? "↓ " : "") + Math.abs(rateDiff) + " pt" : "periodo inicial";
  renderTopics();
  renderRecentLeads();
}

function renderChart() {
  var act = ACT.slice(-PERIOD);
  var mx = 1, hot = -1;
  act.forEach(function (a, i) { if (a.n >= mx) { mx = a.n; hot = i; } });
  var ch = $("chart");
  ch.innerHTML = "";
  act.forEach(function (a, i) {
    var bar = document.createElement("div");
    bar.style.height = Math.max(4, Math.round((a.n / mx) * 100)) + "%";
    if (i === hot && a.n) bar.className = "hot";
    bar.title = a.day + ": " + a.n + (a.n === 1 ? " pregunta" : " preguntas");
    ch.appendChild(bar);
  });
  if (act.length) {
    $("ax-from").textContent = new Date(act[0].day + "T12:00:00").toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
    $("ax-to").textContent = new Date(act[act.length - 1].day + "T12:00:00").toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
  }
}

function normalizedText(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function renderTopics() {
  var since = Date.now() - PERIOD * 24 * 3600 * 1000;
  var groups = [
    { name: "Entradas y acceso", words: ["entrada", "acceso", "acredit", "registro", "ticket"] },
    { name: "Programa y horarios", words: ["programa", "horario", "agenda", "ponencia", "actividad", "evento"] },
    { name: "Expositores y espacios", words: ["expositor", "stand", "pabellon", "espacio", "exponer", "marca"] },
    { name: "Cómo llegar", words: ["llegar", "aparc", "parking", "metro", "tren", "ubicacion", "direccion"] },
    { name: "Precios y contratación", words: ["precio", "coste", "tarifa", "contrat", "presupuesto"] },
    { name: "Otros", words: [] }
  ];
  var total = 0;
  CONVS.forEach(function (c) {
    (c.messages || []).forEach(function (m) {
      if (m.role !== "user" || (m.created_at && new Date(m.created_at).getTime() < since)) return;
      total++;
      var text = normalizedText(m.content), picked = groups.length - 1;
      for (var i = 0; i < groups.length - 1; i++) {
        if (groups[i].words.some(function (w) { return text.indexOf(w) >= 0; })) { picked = i; break; }
      }
      groups[picked].count = (groups[picked].count || 0) + 1;
    });
  });
  $("topics-total").textContent = total ? total + " consultas" : "";
  var box = $("topics"); box.innerHTML = "";
  var shown = groups.filter(function (g) { return g.count; }).sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
  if (!shown.length) { box.innerHTML = '<p class="mut">Aún no hay suficientes consultas para detectar temas.</p>'; return; }
  shown.forEach(function (g) {
    var row = document.createElement("div"); row.className = "topic";
    row.innerHTML = "<span>" + esc(g.name) + "</span><strong>" + Math.round((g.count / total) * 100) + "%</strong>";
    box.appendChild(row);
  });
}

function renderRecentLeads() {
  var box = $("recent-leads"); if (!box) return;
  box.innerHTML = "";
  if (!LEADS.length) { box.innerHTML = '<p class="mut" style="padding:12px 0">Aún no hay leads captados.</p>'; return; }
  LEADS.slice(0, 5).forEach(function (l) {
    var initials = (l.name || l.company || "L").trim().split(/ +/).slice(0, 2).map(function (x) { return x.charAt(0); }).join("").toUpperCase();
    var row = document.createElement("div"); row.className = "recent-lead" + ((l.status || "nuevo") === "nuevo" ? " is-new" : "");
    row.innerHTML = '<div class="lead-person"><span class="lead-avatar">' + esc(initials) + '</span><span><b>' + esc(l.name || "Contacto sin nombre") + '</b><span>' + esc(l.company || l.email || l.phone || "") + '</span></span></div>' +
      '<div class="lead-intent">' + esc((l.kind || l.message || "Interés comercial").toUpperCase()) + '</div><div class="lead-time">' + esc(fmt(l.created_at)) + '</div>';
    box.appendChild(row);
  });
}
function leadMatches(l) {
  var q = $("lf-q").value.trim().toLowerCase();
  var st = $("lf-status").value;
  var from = $("lf-from").value, to = $("lf-to").value;
  if (st && (l.status || "nuevo") !== st) return false;
  if (from && day(l.created_at) < from) return false;
  if (to && day(l.created_at) > to) return false;
  if (q) {
    var blob = [l.name, l.email, l.phone, l.company, l.message, l.kind].join(" ").toLowerCase();
    if (blob.indexOf(q) < 0) return false;
  }
  return true;
}

function renderLeads() {
  if (!$("leads-body")) return; // la pestaña puede estar desactivada (sección quitada del DOM)
  var rows = LEADS.filter(leadMatches);
  var anyAtAll = LEADS.length > 0;
  $("leads-empty").classList.toggle("hide", anyAtAll);
  $("lf-count").textContent = anyAtAll
    ? rows.length + (rows.length === 1 ? " lead" : " leads")
    : "";
  var tb = $("leads-body");
  tb.innerHTML = "";
  if (anyAtAll && !rows.length) {
    tb.innerHTML = "<tr><td colspan='7' class='mut'>Nada coincide con esos filtros.</td></tr>";
  }
  rows.forEach(function (l) {
    var tr = document.createElement("tr");
    function td(html) { var c = document.createElement("td"); c.innerHTML = html; return c; }
    tr.appendChild(td(esc(fmt(l.created_at))));
    tr.appendChild(td(esc(l.kind)));
    tr.appendChild(td(esc(l.name) + (l.company ? "<div class='mut'>" + esc(l.company) + "</div>" : "")));
    tr.appendChild(td(esc(l.email) + (l.phone ? "<div class='mut'>" + esc(l.phone) + "</div>" : "")));
    tr.appendChild(td(esc(l.message)));
    var st = document.createElement("td");
    if (l.status === "contactado") {
      st.innerHTML = "<span class='done'>" + svgIco("check") + " contactado</span>";
    } else {
      var b = document.createElement("button");
      b.className = "mini";
      b.textContent = "Marcar contactado";
      b.onclick = function () {
        b.disabled = true;
        fetch("/panel/lead-status?token=" + encodeURIComponent(token), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: l.id, status: "contactado" }),
        }).then(function (r) { return r.json(); }).then(function (r) {
          if (r.ok) { l.status = "contactado"; renderLeads(); }
          else b.disabled = false;
        }).catch(function () { b.disabled = false; });
      };
      st.appendChild(b);
    }
    tr.appendChild(st);
    var delTd = document.createElement("td");
    var del = document.createElement("button");
    del.className = "del";
    del.innerHTML = svgIco("trash");
    del.title = "Eliminar este lead";
    del.onclick = function () {
      if (!confirm("¿Eliminar este lead? No se puede deshacer.")) return;
      del.disabled = true;
      fetch("/panel/delete?token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "lead", id: l.id }),
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (r.ok) {
          LEADS = LEADS.filter(function (x) { return x.id !== l.id; });
          renderLeads();
          renderStats();
        } else del.disabled = false;
      }).catch(function () { del.disabled = false; });
    };
    delTd.appendChild(del);
    tr.appendChild(delTd);
    tb.appendChild(tr);
  });
}

function convMatches(c) {
  var q = $("cf-q").value.trim().toLowerCase();
  var from = $("cf-from").value, to = $("cf-to").value;
  var when = c.last_message_at || c.created_at;
  if (from && day(when) < from) return false;
  if (to && day(when) > to) return false;
  if (q) {
    var blob = (c.messages || []).map(function (m) { return m.content; }).join(" ").toLowerCase();
    if (blob.indexOf(q) < 0) return false;
  }
  return true;
}

function renderConvs() {
  if (!$("convs-empty")) return; // pestaña desactivada
  var rows = CONVS.filter(convMatches);
  var anyAtAll = CONVS.length > 0;
  $("convs-empty").classList.toggle("hide", anyAtAll);
  $("cf-count").textContent = anyAtAll
    ? rows.length + (rows.length === 1 ? " conversación" : " conversaciones")
    : "";
  var cv = $("convs");
  cv.innerHTML = "";
  if (anyAtAll && !rows.length) {
    cv.innerHTML = "<p class='mut'>Nada coincide con esos filtros.</p>";
  }
  rows.forEach(function (c) {
    var ms = c.messages || [];
    var first = "";
    for (var i = 0; i < ms.length; i++) if (ms[i].role === "user") { first = ms[i].content; break; }
    var box = document.createElement("div");
    box.className = "conv";
    var head = document.createElement("button");
    head.innerHTML = "<span>" + esc(first.slice(0, 90) || "(sin mensajes)") + "</span>" +
      "<span class='meta'>" + ms.length + " mensajes · " + esc(fmt(c.last_message_at)) + "</span>";
    head.onclick = function () { box.classList.toggle("open"); };
    var body = document.createElement("div");
    body.className = "msgs";
    body.innerHTML = ms.map(function (m) {
      return "<div class='m " + (m.role === "user" ? "user" : "assistant") + "'>" + esc(m.content) + "</div>";
    }).join("");
    var delRow = document.createElement("div");
    delRow.className = "convdel";
    var del = document.createElement("button");
    del.className = "mini";
    del.innerHTML = svgIco("trash") + " Eliminar esta conversación";
    del.onclick = function () {
      if (!confirm("¿Eliminar esta conversación entera? No se puede deshacer.")) return;
      del.disabled = true;
      fetch("/panel/delete?token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "conversation", id: c.id }),
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (r.ok) {
          CONVS = CONVS.filter(function (x) { return x.id !== c.id; });
          computeGaps();
          renderConvs();
          renderGaps();
          renderStats();
          renderChart();
        } else del.disabled = false;
      }).catch(function () { del.disabled = false; });
    };
    delRow.appendChild(del);
    body.appendChild(delRow);
    box.appendChild(head);
    box.appendChild(body);
    cv.appendChild(box);
  });
}

function computeGaps() {
  GAPS = [];
  CONVS.forEach(function (c) {
    var ms = c.messages || [];
    ms.forEach(function (m, i) {
      if (m.role === "assistant" && m.was_answered === false) {
        var q = null;
        for (var j = i - 1; j >= 0; j--) if (ms[j].role === "user") { q = ms[j]; break; }
        if (q) GAPS.push({ q: q.content, at: m.created_at });
      }
    });
  });
}

function renderGaps() {
  var box = $("gaps-list");
  if (!box) return; // pestaña desactivada
  box.innerHTML = "";
  $("gaps-empty").classList.toggle("hide", GAPS.length > 0);
  GAPS.forEach(function (g) {
    var card = document.createElement("div");
    card.className = "gapcard";
    var q = document.createElement("div");
    q.className = "q";
    q.innerHTML = svgIco("question") + " " + esc(g.q);
    var when = document.createElement("div");
    when.className = "mut";
    when.textContent = "Preguntado el " + fmt(g.at);
    var ta = document.createElement("textarea");
    ta.rows = 2;
    ta.placeholder = "Escribe aquí la respuesta oficial (precios, horarios, condiciones…) y el asistente la aprenderá al momento.";
    var row = document.createElement("div");
    row.className = "garow";
    var send = document.createElement("button");
    send.className = "btn";
    send.textContent = "Enseñar al asistente";
    var msg = document.createElement("span");
    msg.className = "mut";
    send.onclick = function () {
      var a = ta.value.trim();
      if (a.length < 10) { msg.textContent = "Escribe la respuesta con algo más de detalle."; msg.className = "err"; return; }
      send.disabled = true;
      msg.textContent = "Guardando…"; msg.className = "mut";
      fetch("/panel/gap-answer?token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: g.q, answer: a }),
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (r.error) { msg.textContent = r.error; msg.className = "err"; send.disabled = false; return; }
        card.innerHTML = "<div class='q'>" + svgIco("check") + " " + esc(g.q) + "</div>" +
          "<p class='ok' style='margin-top:6px'>El asistente ya conoce esta respuesta. Pruébalo en «Probar el bot».</p>";
      }).catch(function () { msg.textContent = "Error al guardar."; msg.className = "err"; send.disabled = false; });
    };
    row.appendChild(send);
    row.appendChild(msg);
    card.appendChild(q);
    card.appendChild(when);
    card.appendChild(ta);
    card.appendChild(row);
    box.appendChild(card);
  });
}

function renderDocs() {
  var box = $("docs-list");
  if (!box) return; // pestaña desactivada
  box.innerHTML = "";
  if (!DOCS.length) {
    box.innerHTML = "<p class='mut'>Aún no hay contenido indexado. Sube el primero arriba.</p>";
    return;
  }
  DOCS.forEach(function (d) {
    var row = document.createElement("div");
    row.className = "doc";
    var left = document.createElement("div");
    var iconName = d.source_type === "url" ? "globe" : d.source_type === "file" ? "doc" : "edit";
    var t1 = document.createElement("div");
    t1.innerHTML = svgIco(iconName) + " "; t1.appendChild(document.createTextNode(d.title || d.source_url || "(sin título)"));
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = fmt(d.indexed_at || d.created_at);
    left.appendChild(t1);
    left.appendChild(meta);
    var del = document.createElement("button");
    del.className = "del";
    del.innerHTML = svgIco("trash");
    del.title = "Eliminar del conocimiento del asistente";
    del.onclick = function () {
      if (!confirm("¿Eliminar «" + (d.title || "este documento") + "» del conocimiento del asistente?")) return;
      del.disabled = true;
      fetch("/panel/doc-delete?token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id }),
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (r.ok) {
          DOCS = DOCS.filter(function (x) { return x.id !== d.id; });
          renderDocs();
        } else del.disabled = false;
      }).catch(function () { del.disabled = false; });
    };
    row.appendChild(left);
    row.appendChild(del);
    box.appendChild(row);
  });
}

function renderBadges() {
  if (!LAST_VISIT) return;
  var nl = LEADS.filter(function (l) { return l.created_at > LAST_VISIT; }).length;
  var nc = CONVS.filter(function (c) { return (c.last_message_at || c.created_at) > LAST_VISIT; }).length;
  if (nl) { $("bg-leads").textContent = nl; $("bg-leads").classList.remove("hide"); }
  if (nc) { $("bg-convs").textContent = nc; $("bg-convs").classList.remove("hide"); }
}

["lf-q", "lf-from", "lf-to"].forEach(function (id) { $(id).oninput = renderLeads; });
$("lf-status").onchange = renderLeads;
["cf-q", "cf-from", "cf-to"].forEach(function (id) { $(id).oninput = renderConvs; });

fetch("/panel/data?token=" + encodeURIComponent(token))
  .then(function (r) { return r.json(); })
  .then(function (d) {
    if (d.error) { $("name").textContent = "Enlace no válido"; return; }
    CONVS = d.conversations || [];
    LEADS = d.leads || [];
    DOCS = d.documents || [];
    ACT = d.activity || [];
    PRIMARY = d.primary_color || "#3c62f0";
    $("name").textContent = d.name;
    if (d.logo_url) {
      $("clogo").src = d.logo_url;
      $("clogo").style.display = "block";
      $("cdot").style.display = "none";
    } else {
      $("cdot").textContent = (d.name || "A").charAt(0).toUpperCase();
    }
    var FEAT = d.features || {};
    var featTab = { leads: "t-leads", convs: "t-convs", gaps: "t-gaps", uploads: "t-add", test: "t-test" };
    var hiddenFirst = false;
    Object.keys(featTab).forEach(function (k) {
      if (FEAT[k] === false) {
        var sec = $(featTab[k]);
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
      ws.setAttribute("data-fresh", "1");
      document.body.appendChild(ws);
    }
    computeGaps();
    renderStats();
    renderChart();
    renderLeads();
    renderConvs();
    renderGaps();
    renderDocs();
    renderBadges();
    localStorage.setItem(SEEN_KEY, new Date().toISOString());
  })
  .catch(function () {
    $("name").textContent = "No se ha podido cargar el panel";
  });

$("csv").onclick = function () {
  var rows = [["Fecha", "Tipo", "Nombre", "Email", "Telefono", "Empresa", "Mensaje", "Estado"]].concat(
    LEADS.filter(leadMatches).map(function (l) {
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

$("ccsv").onclick = function () {
  var rows = [["Fecha", "Rol", "Mensaje"]];
  CONVS.filter(convMatches).forEach(function (c) {
    (c.messages || []).forEach(function (m) {
      rows.push([m.created_at, m.role === "user" ? "visitante" : "asistente", m.content]);
    });
    rows.push(["", "", ""]);
  });
  var csv = rows.map(function (r) {
    return r.map(function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }).join(";");
  }).join("\\n");
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = "conversaciones.csv";
  a.click();
};

$("up-run").onclick = function () {
  var files = $("up-files").files;
  var msg = $("up-msg");
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
    $("up-report").innerHTML = (r.indexed || []).map(function (x) {
      var dv = document.createElement("div");
      dv.innerHTML = (x.ok ? svgIco("check") : svgIco("x")) + " "; dv.appendChild(document.createTextNode(x.source + (x.ok ? "" : " — " + (x.reason || "error"))));
      return dv.outerHTML;
    }).join("");
    $("up-files").value = "";
    fetch("/panel/data?token=" + encodeURIComponent(token))
      .then(function (r2) { return r2.json(); })
      .then(function (d2) { DOCS = d2.documents || DOCS; renderDocs(); })
      .catch(function () {});
  }).catch(function () { msg.textContent = "Error al subir."; msg.className = "err"; });
};
</script>
</body>
</html>`;

// ---------- web pública de ExpoBot ----------
// expobot.es se sirve desde este mismo Worker (home + interiores + legales).
// En cualquier otro host la web vive bajo /web (vista previa antes del dominio).
// Los contenidos van en src/web/*.txt con un bloque JSON entre <!--DATA … DATA-->.

const WEB_BOT_KEY = "pk_expobotweb_f8939cf0846f1142efcf3d4e";
const WEB_HOSTS = ["expobot.es", "www.expobot.es"];

function webHtml(body) {
  return new Response(body, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

function serveWeb(url) {
  let base = null;
  let path = null;
  if (url.pathname === "/web" || url.pathname.startsWith("/web/")) {
    base = "/web";
    path = url.pathname.slice(4) || "/";
  } else if (WEB_HOSTS.includes(url.hostname)) {
    if (url.hostname === "www.expobot.es") {
      return Response.redirect("https://expobot.es" + url.pathname + url.search, 301);
    }
    base = "";
    path = url.pathname;
  }
  if (path === null) return null;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  const fill = (tpl) =>
    tpl
      .replaceAll("%%BASE%%", base)
      .replaceAll("%%WEBKEY%%", WEB_BOT_KEY)
      .replaceAll("%%ORIGIN%%", url.origin);

  const textAsset = (body, type, cache = "public, max-age=3600") =>
    new Response(body, { headers: { "Content-Type": type, "Cache-Control": cache } });
  const assets = {
    "/assets/expobot-logo.svg": BRAND_LOGO,
    "/assets/expobot-isotipo.svg": BRAND_ISOTYPE,
    "/assets/expobot-logo-header.svg": BRAND_LOGO_HEADER,
    "/assets/expobot-wordmark-mustard.svg": BRAND_WORDMARK_MUSTARD,
    "/assets/expobot-wordmark-dark.svg": BRAND_WORDMARK_DARK,
    "/assets/expobot-wordmark-light.svg": BRAND_WORDMARK_LIGHT,
  };
  if (path === "/styles.css") return textAsset(WEB_STYLES, "text/css;charset=utf-8");
  if (path === "/script.js") return textAsset(fill(WEB_SCRIPT), "application/javascript;charset=utf-8");
  if (path === "/cookie-consent.js") return textAsset(WEB_COOKIE_CONSENT, "application/javascript;charset=utf-8");
  if (assets[path]) return textAsset(assets[path], "image/svg+xml;charset=utf-8", "public, max-age=86400");
  if (path === "/legal.html") return webHtml(fill(WEB_LEGAL_PAGE));
  if (path === "/") return webHtml(fill(WEB_HOME_NEW));

  if (path === "/robots.txt") {
    const body =
      base === ""
        ? "User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: https://expobot.es/sitemap.xml\n"
        : "User-agent: *\nDisallow: /\n";
    return new Response(body, { headers: { "Content-Type": "text/plain;charset=utf-8" } });
  }

  if (path === "/sitemap.xml") {
    const urls = ["", "legal.html"]
      .map((p) => `<url><loc>https://expobot.es/${p}</loc></url>`)
      .join("");
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
      { headers: { "Content-Type": "application/xml;charset=utf-8" } }
    );
  }

  const legacyRoutes = {
    "/producto": "/#soluciones",
    "/ferias": "/#sectores",
    "/whatsapp": "/#integraciones",
    "/telegram": "/#integraciones",
    "/chatbot-web": "/#integraciones",
    "/integraciones": "/#integraciones",
    "/precios": "/#demo",
    "/contacto": "/#demo",
    "/aviso-legal": "/legal.html#aviso-legal",
    "/privacidad": "/legal.html#privacidad",
    "/cookies": "/legal.html#cookies",
    "/condiciones": "/legal.html#condiciones-accesibilidad",
    "/accesibilidad": "/legal.html#condiciones-accesibilidad",
  };
  if (legacyRoutes[path]) {
    return Response.redirect(new URL(`${base}${legacyRoutes[path]}`, url.origin), 301);
  }

  return null;
}

// ---------- handler principal ----------

export default {
  async scheduled(event, env, ctx) {
    // día 1 de cada mes: informes a los clientes; a diario: resumen de leads (si está activado)
    if (event.cron === "0 7 1 * *") ctx.waitUntil(runMonthlyReports(env));
    else ctx.waitUntil(runDailyLeadDigests(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(origin, []) });
    }

    try {
      // --- widget servido por el propio Worker ---
      if (url.pathname === "/favicon.svg" || url.pathname === "/brand/isotipo.svg") {
        return new Response(BRAND_ISO_SVG, {
          headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
        });
      }

      if (url.pathname === "/favicon.png" || url.pathname === "/brand/isotipo.png") {
        const bytes = Uint8Array.from(atob(BRAND_ISO_PNG_B64), (c) => c.charCodeAt(0));
        return new Response(bytes, {
          headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
        });
      }

      if (url.pathname === "/brand/logo.png") {
        const bytes = Uint8Array.from(atob(BRAND_LOGO_PNG_B64), (c) => c.charCodeAt(0));
        return new Response(bytes, {
          headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
        });
      }

      if (url.pathname === "/brand/email-logo.png" || url.pathname === "/brand/email-logo-light.png") {
        const b64 = url.pathname.endsWith("light.png") ? BRAND_EMAIL_LOGO_LIGHT_B64 : BRAND_EMAIL_LOGO_DARK_B64;
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return new Response(bytes, {
          headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
        });
      }

      if (url.pathname === "/brand/logo.svg" || url.pathname === "/brand/wordmark-light.svg") {
        return new Response(BRAND_WORDMARK_LIGHT, {
          headers: { "Content-Type": "image/svg+xml;charset=utf-8", "Cache-Control": "public, max-age=86400" },
        });
      }
      if (url.pathname === "/widget.js") {
        return new Response(WIDGET_JS, {
          headers: {
            "Content-Type": "application/javascript;charset=utf-8",
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // --- web pública de ExpoBot (expobot.es; vista previa en /web) ---
      const webResp = serveWeb(url);
      if (webResp) return webResp;

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
          `<script src="${url.origin}/widget.js?v=${Date.now()}" data-key="${h(key)}" data-api="${url.origin}" data-open="2500" data-fresh="1"></script>`;

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
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png"><meta name="robots" content="noindex">
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
          cors(origin, [...(tenant.allowed_domains || []), url.hostname])
        );
      }

      // --- chat ---
      if (url.pathname === "/api/chat" && request.method === "POST") {
        const { key, session_id, message, page_url, history = [] } = await request.json();
        const tenant = await getTenant(env, key);
        if (!tenant) return json({ error: "clave no válida" }, 401);

        const ch = cors(origin, [...(tenant.allowed_domains || []), url.hostname]);
        if (ch["Access-Control-Allow-Origin"] === "null") {
          return json({ error: "dominio no autorizado" }, 403, ch);
        }
        if (typeof message !== "string" || !message || message.length > 2000) {
          return json({ error: "mensaje no válido" }, 400, ch);
        }
        // id de sesión acotado y obligatorio: sin él, cada mensaje abriría una
        // conversación nueva (encodeURIComponent(undefined) === "undefined")
        const sid = String(session_id || "").slice(0, 80);
        if (!sid) return json({ error: "sesión no válida" }, 400, ch);
        // historial del cliente: acotado en número y tamaño para no inflar el
        // contexto del modelo (el mensaje ya está topado, el historial no lo estaba)
        const safeHistory = (Array.isArray(history) ? history : [])
          .slice(-8)
          .filter((m) => m && (m.role === "user" || m.role === "assistant"))
          .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 2000) }));

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
            `conversations?tenant_id=eq.${tenant.id}&session_id=eq.${encodeURIComponent(sid)}&select=id&limit=1`
          )
        )[0];
        if (!conv) {
          conv = (
            await sb(env, "conversations", {
              method: "POST",
              body: { tenant_id: tenant.id, session_id: sid, page_url },
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
        const saveLead = async (raw) => {
          // mismas cotas que /api/lead: un modelo desbocado no debe guardar filas gigantes
          const l = {
            kind: ["expositor", "visitante", "prensa", "general"].includes(raw.kind) ? raw.kind : "general",
            name: String(raw.name || "").trim().slice(0, 120),
            email: String(raw.email || "").trim().slice(0, 160),
            phone: String(raw.phone || "").trim().slice(0, 60) || null,
            company: String(raw.company || "").trim().slice(0, 160) || null,
            message: String(raw.message || "").trim().slice(0, 500) || null,
          };
          await sb(env, "leads", {
            method: "POST",
            body: { tenant_id: tenant.id, conversation_id: conv.id, ...l },
          });

          if (tenant.lead_webhook_url) {
            await fetch(tenant.lead_webhook_url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenant: tenant.slug, ...l }),
            }).catch(() => {});
          }

          // aviso por email al cliente sin retrasar la respuesta del chat
          ctx.waitUntil(notifyLeadInstant(env, tenant, l));
        };

        // generación (proveedor y modelo configurables por tenant)
        const run = pickRunner(tenant);
        const { text, usage, leadForm } = await run(
          env,
          tenant,
          safeHistory,
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
              // ?? null: si el proveedor no devuelve uso (p. ej. bloqueo de Gemini),
              // JSON.stringify omitiría la clave y PostgREST rechazaría el insert múltiple
              input_tokens: usage.input_tokens ?? null,
              output_tokens: usage.output_tokens ?? null,
              was_answered: (hits || []).length > 0,
            },
          ],
        });

        await sb(env, `conversations?id=eq.${conv.id}`, {
          method: "PATCH",
          body: { last_message_at: new Date().toISOString() },
        });

        return json({ reply: text, sources, lead_form: leadForm || undefined }, 200, ch);
      }

      // --- lead enviado desde el formulario del widget ---
      if (url.pathname === "/api/lead" && request.method === "POST") {
        const { key, session_id, name, email, phone, company, message, kind } = await request.json();
        const tenant = await getTenant(env, key);
        if (!tenant) return json({ error: "clave no válida" }, 401);
        const ch = cors(origin, [...(tenant.allowed_domains || []), url.hostname]);
        if (ch["Access-Control-Allow-Origin"] === "null") {
          return json({ error: "dominio no autorizado" }, 403, ch);
        }
        if (!leadCaptureEnabled(tenant)) return json({ error: "no disponible" }, 403, ch);
        // límite por IP: evita inundar leads/webhook/emails con la clave pública
        const leadIp = request.headers.get("CF-Connecting-IP") || "";
        if (leadIp) {
          const okRate = await rpc(env, "check_rate", { p_ip: "lead:" + leadIp, p_limit: 8 });
          if (okRate === false) {
            return json({ error: "demasiadas solicitudes; espera un momento" }, 429, ch);
          }
        }
        const nm = String(name || "").trim().slice(0, 120);
        const em = String(email || "").trim().slice(0, 160);
        if (!nm || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
          return json({ error: "pon al menos tu nombre y un email válido" }, 400, ch);
        }
        let convId = null;
        if (session_id) {
          const rows = await sb(
            env,
            `conversations?tenant_id=eq.${tenant.id}&session_id=eq.${encodeURIComponent(String(session_id).slice(0, 80))}&select=id&limit=1`
          );
          convId = rows?.[0]?.id || null;
        }
        const l = {
          kind: ["expositor", "visitante", "prensa", "general"].includes(kind) ? kind : "general",
          name: nm,
          email: em,
          phone: String(phone || "").trim().slice(0, 60) || null,
          company: String(company || "").trim().slice(0, 160) || null,
          message: String(message || "").trim().slice(0, 500) || null,
        };
        await sb(env, "leads", {
          method: "POST",
          body: { tenant_id: tenant.id, conversation_id: convId, ...l },
        });
        if (tenant.lead_webhook_url) {
          ctx.waitUntil(
            fetch(tenant.lead_webhook_url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenant: tenant.slug, ...l }),
            }).catch(() => {})
          );
        }
        ctx.waitUntil(notifyLeadInstant(env, tenant, l));
        return json({ ok: true }, 200, ch);
      }

      // --- panel de administración ---
      if (url.pathname === "/admin") {
        return new Response(brandAppHtml(ADMIN_HTML), {
          headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if (url.pathname.startsWith("/admin/api/")) {
        if (!isAdmin(request, env)) return json({ error: "no autorizado" }, 401);
        return await handleAdminApi(request, env, url);
      }

      // --- indexación (admin) ---
      if (url.pathname === "/admin/ingest" && request.method === "POST") {
        if (!isAdmin(request, env)) return json({ error: "no autorizado" }, 401);
        const { slug, urls = [], texts = [] } = await request.json();
        const tenant = (await sb(env, `tenants?slug=eq.${encodeURIComponent(String(slug || ""))}&select=id`))[0];
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
        const tenant = (await sb(env, `tenants?slug=eq.${encodeURIComponent(String(slug || ""))}&select=id`))[0];
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
        return new Response(brandAppHtml(PORTAL_HTML), {
          headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if (url.pathname === "/portal/login" && request.method === "POST") {
        const { email, password } = await request.json();
        if (!email || !password) return json({ error: "faltan el email o la contraseña" }, 400);
        const loginIp = request.headers.get("CF-Connecting-IP") || "";
        if (loginIp) {
          const okRate = await rpc(env, "check_rate", { p_ip: "login:" + loginIp, p_limit: 10 });
          if (okRate === false) {
            return json({ error: "demasiados intentos; espera un minuto y vuelve a probar" }, 429);
          }
        }
        const loginEmail = normEmail(email);
        if (!loginEmail) return json({ error: "email o contraseña incorrectos" }, 401);
        const rows = await sb(
          env,
          `clients?email=ilike.${encodeURIComponent(loginEmail)}&select=id,portal_password_hash,portal_enabled`
        );
        const c = rows?.[0];
        if (!c || !c.portal_password_hash || !(await verifyPassword(password, c.portal_password_hash))) {
          return json({ error: "email o contraseña incorrectos" }, 401);
        }
        if (c.portal_enabled === false) {
          return json({ error: "el acceso al portal está desactivado; contacta con nosotros" }, 403);
        }
        return json({ token: await makePortalToken(env, c.id, c.portal_password_hash) });
      }

      if (url.pathname === "/portal/forgot" && request.method === "POST") {
        // respuesta idéntica exista o no el email: no se filtra quién es cliente
        const generic = { ok: true };
        const { email } = await request.json().catch(() => ({}));
        const em = normEmail(email);
        if (!em) return json(generic);
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (ip) {
          const okRate = await rpc(env, "check_rate", { p_ip: "pw:" + ip, p_limit: 5 });
          if (okRate === false) return json(generic);
        }
        const rows = await sb(
          env,
          `clients?email=ilike.${encodeURIComponent(em)}&select=id,name,email,portal_enabled,portal_password_hash`
        );
        const c = rows?.[0];
        if (c && c.portal_enabled !== false) {
          // ligado a la contraseña actual: al cambiarla, el enlace deja de valer
          const bind = (c.portal_password_hash || "none").slice(-16);
          const tok = await makeActionToken(env, "pwreset", c.id, bind, 3600 * 1000);
          const link = `${url.origin}/acceso?reset=${encodeURIComponent(tok)}`;
          const sent = await sendEmail(
            env,
            c.email,
            "Restablece tu contraseña — ExpoBot",
            emailShell(
              `<h2 style="margin:0 0 10px;font-size:18px">Restablecer tu contraseña</h2>` +
                `<p style="margin:0 0 16px">Hola${c.name ? " " + h(c.name) : ""}, hemos recibido una solicitud para restablecer la contraseña de tu portal de cliente. Si no has sido tú, ignora este email.</p>` +
                `<p style="margin:0 0 18px"><a href="${link}" style="background-color:#f5be10;color:#090909;text-decoration:none;padding:13px 24px;border-radius:4px;font-weight:700;display:inline-block">Crear contraseña nueva</a></p>` +
                `<p style="margin:0;color:#6b7590;font-size:13px">El enlace caduca en 1 hora y solo puede usarse una vez.</p>`
            )
          );
          if (!sent.ok) await logError(env, "portal/forgot", sent.reason || "fallo al enviar");
        }
        return json(generic);
      }

      if (url.pathname === "/portal/reset" && request.method === "POST") {
        const { token, new_password } = await request.json().catch(() => ({}));
        const t = await readActionToken(env, "pwreset", token);
        if (!t) return json({ error: "el enlace no es válido o ha caducado; pide uno nuevo desde «¿Has olvidado tu contraseña?»" }, 400);
        if (!new_password || String(new_password).length < 8) {
          return json({ error: "la contraseña debe tener al menos 8 caracteres" }, 400);
        }
        const [c] = await sb(env, `clients?id=eq.${t.clientId}&select=id,portal_password_hash,portal_enabled`);
        if (!c || c.portal_enabled === false) return json({ error: "el acceso está desactivado; contacta con nosotros" }, 403);
        if ((c.portal_password_hash || "none").slice(-16) !== t.extra) {
          return json({ error: "este enlace ya se usó; pide uno nuevo si lo necesitas" }, 400);
        }
        await sb(env, `clients?id=eq.${t.clientId}`, {
          method: "PATCH",
          body: { portal_password_hash: await hashPassword(String(new_password)) },
        });
        return json({ ok: true });
      }

      if (url.pathname === "/portal/confirm-email") {
        const t = await readActionToken(env, "chmail", url.searchParams.get("token"));
        const page = (title, body) =>
          new Response(
            `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/favicon.png"><title>${title} — ExpoBot</title></head>` +
              `<body style="margin:0;font:16px/1.6 'Segoe UI',Arial,sans-serif;background:#f3f3f0;color:#101010;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">` +
              `<div style="background:#fff;border:1px solid #d9d9d4;border-radius:6px;padding:34px;max-width:420px;text-align:center;border-top:3px solid #f5be10">` +
              `<img src="/brand/email-logo-light.png" alt="ExpoBot" style="height:30px;margin-bottom:16px"><h1 style="font-size:19px;margin:0 0 10px">${title}</h1><p style="margin:0;color:#6b7590">${body}</p></div></body></html>`,
            { headers: { "Content-Type": "text/html;charset=utf-8" } }
          );
        if (!t || !t.extra) {
          return page("Enlace no válido", "El enlace ha caducado o ya se usó. Vuelve a solicitar el cambio de email desde tu portal.");
        }
        const newEmail = normEmail(t.extra);
        if (!newEmail) return page("Enlace no válido", "El email no es válido. Vuelve a solicitar el cambio desde tu portal.");
        const dup = await sb(
          env,
          `clients?email=ilike.${encodeURIComponent(newEmail)}&id=neq.${encodeURIComponent(t.clientId)}&select=id&limit=1`
        );
        if (dup?.length) return page("Email en uso", "Ese email ya pertenece a otra cuenta. Contacta con nosotros.");
        const rows = await sb(env, `clients?id=eq.${t.clientId}`, { method: "PATCH", body: { email: newEmail } });
        if (!rows?.length) return page("Enlace no válido", "No hemos encontrado la cuenta. Contacta con nosotros.");
        return page(
          "Email confirmado ✓",
          `A partir de ahora entras al portal con <b>${h(newEmail)}</b>, y ahí recibirás también los informes. <a href="/acceso" style="color:#101010;font-weight:600">Ir al portal</a>`
        );
      }

      const portalAuth = async () => {
        // solo por cabecera: el token de sesión ya no viaja en la URL
        const auth = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
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
          `invoices?client_id=eq.${cid}&select=id,number,concept,amount_cents,currency,issued_at,status,pdf_path,period_start,period_end&order=issued_at.desc,created_at.desc`
        );
        return json({ ...client, invoices }, 200, { "Cache-Control": "no-store" });
      }

      if (url.pathname === "/portal/account" && request.method === "POST") {
        const cid = await portalAuth();
        if (!cid) return json({ error: "sesión caducada" }, 401);
        const { current, email, new_password } = await request.json();
        const [c] = await sb(env, `clients?id=eq.${cid}&select=id,email,portal_password_hash`);
        if (!c) return json({ error: "sesión caducada" }, 401);
        if (!current || !(await verifyPassword(String(current), c.portal_password_hash))) {
          return json({ error: "la contraseña actual no es correcta" }, 403);
        }
        const changes = {};
        let emailPending = null;
        const newEmail = normEmail(email);
        if (email && String(email).trim() && !newEmail) {
          return json({ error: "el email nuevo no parece válido" }, 400);
        }
        if (newEmail && newEmail !== (c.email || "").toLowerCase()) {
          const dup = await sb(
            env,
            `clients?email=ilike.${encodeURIComponent(newEmail)}&id=neq.${encodeURIComponent(cid)}&select=id&limit=1`
          );
          if (dup?.length) return json({ error: "ese email ya está en uso por otra cuenta" }, 400);
          // el cambio no se aplica hasta que el dueño del email nuevo lo confirme
          const tok = await makeActionToken(env, "chmail", cid, newEmail, 24 * 3600 * 1000);
          const link = `${url.origin}/portal/confirm-email?token=${encodeURIComponent(tok)}`;
          const sent = await sendEmail(
            env,
            newEmail,
            "Confirma tu nuevo email — ExpoBot",
            emailShell(
              `<h2 style="margin:0 0 10px;font-size:18px">Confirma tu nuevo email</h2>` +
                `<p style="margin:0 0 16px">Has pedido usar esta dirección para entrar a tu portal de cliente y recibir los informes. Confírmalo con el botón; si no has sido tú, ignora este email y no cambiará nada.</p>` +
                `<p style="margin:0 0 18px"><a href="${link}" style="background-color:#f5be10;color:#090909;text-decoration:none;padding:13px 24px;border-radius:4px;font-weight:700;display:inline-block">Confirmar este email</a></p>` +
                `<p style="margin:0;color:#6b7590;font-size:13px">El enlace caduca en 24 horas. Hasta entonces sigues entrando con tu email actual.</p>`
            )
          );
          if (!sent.ok) {
            return json({ error: "no se ha podido enviar el email de confirmación; inténtalo más tarde" }, 502);
          }
          emailPending = newEmail;
        }
        if (new_password) {
          if (String(new_password).length < 8) {
            return json({ error: "la contraseña nueva debe tener al menos 8 caracteres" }, 400);
          }
          changes.portal_password_hash = await hashPassword(String(new_password));
        }
        if (Object.keys(changes).length) {
          await sb(env, `clients?id=eq.${cid}`, { method: "PATCH", body: changes });
        }
        // al cambiar la contraseña se revocan las demás sesiones; a la actual se le
        // entrega un token nuevo para que el propio cliente no se quede fuera
        const freshToken = changes.portal_password_hash
          ? await makePortalToken(env, cid, changes.portal_password_hash)
          : null;
        return json({
          ok: true,
          changed: Object.keys(changes),
          email_pending: emailPending,
          token: freshToken,
        });
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

      // enlace de descarga de un solo uso y corta duración para el PDF de factura:
      // así el token de sesión no viaja en la URL (ni acaba en el historial/logs)
      if (url.pathname === "/portal/invoice-link" && request.method === "POST") {
        const cid = await portalAuth();
        if (!cid) return json({ error: "sesión caducada" }, 401);
        const { id } = await request.json();
        if (!/^[0-9a-f-]{36}$/.test(id || "")) return json({ error: "id no válido" }, 400);
        const [inv] = await sb(env, `invoices?id=eq.${id}&client_id=eq.${cid}&select=id`);
        if (!inv) return json({ error: "factura no encontrada" }, 404);
        return json({ token: await makeActionToken(env, "invpdf", cid, id, 120 * 1000) });
      }

      if (url.pathname === "/portal/invoice") {
        const t = await readActionToken(env, "invpdf", url.searchParams.get("dl"));
        if (!t || !/^[0-9a-f-]{36}$/.test(t.extra || "")) {
          return new Response("Enlace caducado o no válido", { status: 401 });
        }
        const [inv] = await sb(
          env,
          `invoices?id=eq.${encodeURIComponent(t.extra)}&client_id=eq.${encodeURIComponent(t.clientId)}&select=pdf_path,number`
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
          pdfBrandHeader().forEach((x) => L.push(x));
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
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png"><meta name="robots" content="noindex">
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
        return new Response(brandAppHtml(FAQ_HTML), {
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
        return new Response(brandAppHtml(PANEL_HTML), {
          headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if (url.pathname === "/panel/delete" && request.method === "POST") {
        const tenant = await getTenantByPanelToken(env, url.searchParams.get("token"));
        if (!tenant) return json({ error: "token no válido" }, 401);
        const { kind, id } = await request.json();
        if (!/^[0-9a-f-]{36}$/.test(id || "")) return json({ error: "id no válido" }, 400);
        // borrado suave por lado: ocultar en el panel del cliente no borra la fila
        // ni la quita del admin (y viceversa)
        if (kind === "lead") {
          if (tenant.panel_features?.leads === false) return json({ error: "no disponible" }, 403);
          await sb(env, `leads?id=eq.${id}&tenant_id=eq.${tenant.id}`, { method: "PATCH", body: { hidden_client: true } });
        } else if (kind === "conversation") {
          if (tenant.panel_features?.convs === false) return json({ error: "no disponible" }, 403);
          await sb(env, `conversations?id=eq.${id}&tenant_id=eq.${tenant.id}`, { method: "PATCH", body: { hidden_client: true } });
        } else {
          return json({ error: "tipo no válido" }, 400);
        }
        return json({ ok: true });
      }

      if (url.pathname === "/panel/gap-answer" && request.method === "POST") {
        const tenant = await getTenantByPanelToken(env, url.searchParams.get("token"));
        if (!tenant) return json({ error: "token no válido" }, 401);
        if (tenant.panel_features?.gaps === false) return json({ error: "no disponible" }, 403);
        const { question, answer } = await request.json();
        const q = String(question || "").trim().slice(0, 300);
        const a = String(answer || "").trim().slice(0, 4000);
        if (!q || a.length < 10) return json({ error: "escribe una respuesta con algo más de detalle" }, 400);
        const res = await indexDocument(env, tenant.id, {
          source_type: "text",
          title: `Respuesta del cliente: ${q.slice(0, 90)}`,
          content:
            `Pregunta frecuente de los visitantes: ${q}\n\n` +
            `Respuesta oficial del negocio (fuente fiable, actualizada por el propio negocio): ${a}`,
        });
        if (!res.ok) return json({ error: res.reason || "no se ha podido indexar" }, 400);
        return json({ ok: true, chunks: res.chunks });
      }

      if (url.pathname === "/panel/doc-delete" && request.method === "POST") {
        const tenant = await getTenantByPanelToken(env, url.searchParams.get("token"));
        if (!tenant) return json({ error: "token no válido" }, 401);
        if (tenant.panel_features?.uploads === false) return json({ error: "no disponible" }, 403);
        const { id } = await request.json();
        if (!/^[0-9a-f-]{36}$/.test(id || "")) return json({ error: "id no válido" }, 400);
        await sb(env, `documents?id=eq.${id}&tenant_id=eq.${tenant.id}`, { method: "DELETE" });
        return json({ ok: true });
      }

      if (url.pathname === "/panel/report.pdf") {
        const tenant = await getTenantByPanelToken(env, url.searchParams.get("token"));
        if (!tenant) return new Response("Enlace no válido", { status: 401 });
        const rep = await monthlyReportData(env, tenant);
        const L = [];
        const add = (t, size, font, gap, x) =>
          wrapLine(t, font === 3 ? 78 : Math.round(950 / (size || 11))).forEach((w, i, arr) =>
            L.push({ t: w, size, font, x, gap: i === arr.length - 1 ? gap : 0 })
          );
        pdfBrandHeader().forEach((x) => L.push(x));
        add("Informe mensual del asistente", 17, 2, 4);
        add(`${tenant.name} - ${rep.monthName}`, 12, 1, 14);
        add("Resumen de actividad", 13, 2, 6);
        add(`Conversaciones atendidas: ${rep.convs}`, 11, 1, 3);
        add(`Preguntas respondidas: ${rep.questions}`, 11, 1, 3);
        add(`Respondidas con información del contenido: ${rep.rate}%`, 11, 1, 3);
        // las secciones desactivadas en el panel tampoco salen en el PDF
        const pf = tenant.panel_features || {};
        if (pf.leads !== false) {
          add(`Contactos captados (leads): ${rep.leads}`, 11, 1, 12);
        }
        if (pf.gaps !== false && rep.gaps.length) {
          add("Lo que más preguntan y aún no está en el contenido:", 13, 2, 6);
          rep.gaps.slice(0, 10).forEach((g) => add(`- ${g.q}`, 11, 1, 3));
          add(" ", 10, 1, 4);
          add("Responder estas preguntas desde el panel mejora el asistente al momento.", 10, 1, 8);
        } else if (pf.gaps !== false) {
          add("El asistente encontró respuesta para todo lo que le preguntaron.", 11, 1, 8);
        }
        add("Generado por ExpoBot - expobot.es", 9, 1, 0);
        return new Response(buildPdf(L), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="informe-${tenant.slug}.pdf"`,
            "Cache-Control": "no-store",
          },
        });
      }

      if (url.pathname === "/panel/data") {
        const tenant = await getTenantByPanelToken(env, url.searchParams.get("token"));
        if (!tenant) return json({ error: "token no válido" }, 401);
        const [conversations, leads, keys, activity] = await Promise.all([
          sb(
            env,
            `conversations?tenant_id=eq.${tenant.id}&hidden_client=is.false` +
              `&select=id,page_url,created_at,last_message_at,messages(role,content,was_answered,created_at)` +
              `&order=last_message_at.desc&messages.order=created_at.asc&limit=100`
          ),
          sb(
            env,
            `leads?tenant_id=eq.${tenant.id}&hidden_client=is.false` +
              `&select=id,kind,name,email,phone,company,message,status,created_at` +
              `&order=created_at.desc&limit=200`
          ),
          sb(env, `tenant_keys?tenant_id=eq.${tenant.id}&revoked_at=is.null&select=public_key`),
          rpc(env, "daily_activity", { p_tenant_id: tenant.id, p_days: 90 }),
        ]);
        const documents = await sb(
          env,
          `documents?tenant_id=eq.${tenant.id}` +
            `&select=id,title,source_type,source_url,created_at,indexed_at&order=created_at.desc&limit=100`
        );
        // las pestañas desactivadas no solo se ocultan en la interfaz: no se envían
        // los datos, para que no se puedan leer directamente desde la respuesta JSON.
        const feat = tenant.panel_features || {};
        return json(
          {
            name: tenant.name,
            primary_color: tenant.primary_color,
            logo_url: tenant.theme?.logo_url || null,
            public_key: keys?.[keys.length - 1]?.public_key || null,
            features: feat,
            conversations: feat.convs === false ? [] : conversations,
            leads: feat.leads === false ? [] : leads,
            activity,
            documents: feat.uploads === false ? [] : documents,
          },
          200,
          { "Cache-Control": "no-store" }
        );
      }

      return json({ error: "no encontrado" }, 404);
    } catch (err) {
      console.error(err);
      // el detalle se registra en el servidor (error_log) pero no se devuelve al
      // cliente: los mensajes de Supabase/proveedor pueden filtrar pistas internas
      if (ctx?.waitUntil) ctx.waitUntil(logError(env, url.pathname, err?.message || err));
      return json({ error: "error interno" }, 500, cors(origin, []));
    }
  },
};
