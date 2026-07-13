# Plataforma de chatbots multi-tenant

## Qué es esto

Motor propio de chatbots RAG para vender integraciones a clientes (alternativa a
revender Voiceflow/Chatbase). Un solo Worker sirve a todos los clientes; cada cliente
es una fila en `tenants`, no un despliegue nuevo. El objetivo del diseño: **dar de alta
un cliente nuevo debe ser dos inserts y un curl, sin tocar código.**

Cliente cero: FISIOEXPO (salón profesional de fisioterapia, IFEMA Madrid).

## Stack

- **Cloudflare Worker** — motor: recuperación + generación + captura de leads
- **Supabase + pgvector** — conocimiento, conversaciones, leads (proyecto `chatbot-platform`, ref `xgkmddmnxikgeonbfxch`, eu-west-1)
- **Claude API o Gemini API** — generación. Proveedor y modelo se eligen por tenant
  (`tenants.provider` + `tenants.model`; default `anthropic` + `claude-sonnet-4-6`)
- **Workers AI `@cf/baai/bge-m3`** — embeddings, 1024 dims, multilingüe (es/en/pt)

Los embeddings son de Cloudflare y no de OpenAI a propósito: multilingüe de serie,
mismo proveedor que el Worker, un tercero menos en la factura.

## Estructura

```
worker/src/index.js   Motor. Endpoints: /api/config, /api/chat, /admin/ingest, /panel
worker/wrangler.toml  Binding AI. Los secretos van con `wrangler secret put`
widget/widget.js      Widget embebible, vanilla JS, sin dependencias
README.md             Despliegue, indexación, alta de clientes, consultas SQL
```

## Esquema

`tenants` (config del bot: prompt, proveedor+modelo, colores, dominios permitidos, webhook de leads)
→ `tenant_keys` (claves públicas del widget, rotables)
→ `documents` → `chunks` (embedding vector(1024), índice HNSW coseno)
→ `conversations` → `messages` (con `was_answered`, clave para detectar huecos)
→ `leads` (el producto real)

Función `match_chunks(p_tenant_id, p_embedding, ...)`: **siempre filtra por tenant antes
de buscar.** Nunca se cruzan datos entre clientes.

## Seguridad

- RLS activado en todas las tablas y **sin políticas, a propósito**. Nadie accede desde el
  navegador; solo el Worker con la service key. Sin políticas = nadie entra.
- La service_role key vive solo como secreto del Worker. Nunca en el widget ni en el repo.
- La clave pública del widget es visible en el HTML y no importa: `allowed_domains` del
  tenant restringe desde qué dominios funciona.

## Reglas del bot (van en `tenants.system_prompt`)

1. No inventar nunca fechas, precios ni condiciones. Si no está en el contexto, derivar a contacto.
2. Nada de consejo clínico (es una feria, no una consulta).
3. Si es una empresa interesada en stand → capturar lead con la tool `guardar_lead`.

## Estado

Hecho: esquema aplicado, tenant `fisioexpo` creado con clave
`pk_fisioexpo_739c231e7180a38646bdf491` y configurado con `provider = 'google'` +
`model = 'gemini-3.1-flash-lite'`, código del Worker y del widget escrito.

Pendiente inmediato:
1. `wrangler deploy` + los 5 secretos (SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY,
   ADMIN_TOKEN, GEMINI_API_KEY — este último ya es necesario: fisioexpo usa Gemini)
2. Indexar contenido. **Ojo: fisioexpo.es bloquea el scraping por robots.txt** — la
   indexación por URL puede fallar. Usar el campo `texts` del endpoint de ingest.
3. Escribir a mano el FAQ con los datos duros (fechas, precios, tipos de stand, contacto).
   Esto importa más que cualquier ajuste del prompt.
4. Probar el circuito de punta a punta.

Backlog: aplicar `monthly_message_limit`, rate limiting por IP, reindexado con Cron
Trigger, streaming de respuestas, panel de admin (el de cliente ya existe: `/panel`
con `tenants.panel_token`).

## Dato sin resolver

Las fechas de FISIOEXPO/26 están en conflicto: IFEMA dice 25–27 de septiembre, el
Facebook del evento dice 24–26 de octubre. Hay que confirmarlo con el cliente antes de
indexar nada — es la primera pregunta que va a recibir el bot.
