/**
 * Motor de chatbots multi-tenant.
 * Un solo Worker sirve a todos los clientes. El tenant se resuelve por clave pública.
 */

const EMBED_MODEL = "@cf/baai/bge-m3";

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
  return res.status === 204 ? null : res.json();
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
</style>
</head>
<body>
<header>
  <h1 id="name">Cargando…</h1>
  <div class="sub">Conversaciones, leads y huecos de contenido del asistente</div>
</header>
<main>
  <div class="stats">
    <div class="stat"><b id="s-convs">–</b><span>conversaciones</span></div>
    <div class="stat"><b id="s-msgs">–</b><span>preguntas recibidas</span></div>
    <div class="stat"><b id="s-rate">–</b><span>respondidas con contexto</span></div>
    <div class="stat"><b id="s-leads">–</b><span>leads</span></div>
  </div>
  <nav>
    <button class="on" data-tab="t-leads">Leads</button>
    <button data-tab="t-convs">Conversaciones</button>
    <button data-tab="t-gaps">Preguntas sin respuesta</button>
  </nav>
  <section id="t-leads" class="on">
    <table>
      <thead><tr><th>Fecha</th><th>Tipo</th><th>Nombre</th><th>Contacto</th><th>Qué necesita</th></tr></thead>
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
</main>
<script>
var token = new URLSearchParams(location.search).get("token") || "";

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

    document.getElementById("leads-body").innerHTML = leads.length
      ? leads.map(function (l) {
          return "<tr><td>" + fmt(l.created_at) + "</td><td>" + esc(l.kind) + "</td><td>" + esc(l.name) +
            (l.company ? "<div class='mut'>" + esc(l.company) + "</div>" : "") + "</td><td>" + esc(l.email) +
            (l.phone ? "<div class='mut'>" + esc(l.phone) + "</div>" : "") + "</td><td>" + esc(l.message) + "</td></tr>";
        }).join("")
      : "<tr><td colspan='5' class='mut'>Todavía no hay leads.</td></tr>";

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
          },
          200,
          cors(origin, tenant.allowed_domains)
        );
      }

      // --- chat ---
      if (url.pathname === "/api/chat" && request.method === "POST") {
        const { key, session_id, message, page_url, history = [] } = await request.json();
        const tenant = await getTenant(env, key);
        if (!tenant) return json({ error: "clave no válida" }, 401);

        const ch = cors(origin, tenant.allowed_domains);
        if (ch["Access-Control-Allow-Origin"] === "null") {
          return json({ error: "dominio no autorizado" }, 403, ch);
        }
        if (!message || message.length > 2000) {
          return json({ error: "mensaje no válido" }, 400, ch);
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
            { tenant_id: tenant.id, conversation_id: conv.id, role: "user", content: message },
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
          if (d.error || !d.content || d.content.length < 100) {
            report.push({ source: d.url || d.title, ok: false, reason: d.error || "sin contenido" });
            continue;
          }

          // reemplaza el documento anterior de esa fuente (los chunks caen en cascada)
          if (d.url) {
            await sb(env, `documents?tenant_id=eq.${tenant.id}&source_url=eq.${encodeURIComponent(d.url)}`, {
              method: "DELETE",
            });
          }

          const doc = (
            await sb(env, "documents", {
              method: "POST",
              body: {
                tenant_id: tenant.id,
                source_url: d.url,
                source_type: d.url ? "url" : "text",
                title: d.title,
                content: d.content,
                indexed_at: new Date().toISOString(),
              },
            })
          )[0];

          const pieces = chunkText(d.content);
          for (let i = 0; i < pieces.length; i += 20) {
            const batch = pieces.slice(i, i + 20);
            const vecs = await embed(env, batch);
            await sb(env, "chunks", {
              method: "POST",
              headers: { Prefer: "return=minimal" },
              body: batch.map((content, j) => ({
                tenant_id: tenant.id,
                document_id: doc.id,
                content,
                embedding: vecs[j],
                position: i + j,
              })),
            });
          }
          report.push({ source: d.url || d.title, ok: true, chunks: pieces.length });
        }

        return json({ indexed: report });
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
        const [conversations, leads] = await Promise.all([
          sb(
            env,
            `conversations?tenant_id=eq.${tenant.id}` +
              `&select=id,page_url,created_at,last_message_at,messages(role,content,was_answered,created_at)` +
              `&order=last_message_at.desc&messages.order=created_at.asc&limit=100`
          ),
          sb(
            env,
            `leads?tenant_id=eq.${tenant.id}` +
              `&select=kind,name,email,phone,company,message,status,created_at` +
              `&order=created_at.desc&limit=200`
          ),
        ]);
        return json({ name: tenant.name, conversations, leads }, 200, {
          "Cache-Control": "no-store",
        });
      }

      return json({ error: "no encontrado" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "error interno" }, 500, cors(origin, []));
    }
  },
};
