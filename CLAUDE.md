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
worker/src/index.js   Motor. Endpoints: /api/config, /api/chat, /widget.js, /demo (clon de
                      la web del cliente con el bot), /admin (panel de gestión), /admin/api/*
                      (clients, projects, tenants, assist), /admin/ingest, /admin/upload
                      (PDF/TXT/MD/CSV/imágenes vía env.AI.toMarkdown), /panel (cliente)
worker/src/widget.txt Widget embebible (vanilla JS); el Worker lo sirve en /widget.js
worker/wrangler.toml  Binding AI + regla Text para widget.txt. Secretos con `wrangler secret put`
README.md             Despliegue, indexación, alta de clientes, consultas SQL
```

Jerarquía de gestión: `clients` → `projects` → `tenants` (un chatbot = un tenant;
un proyecto puede tener varios). El alta y edición se hace desde /admin, con
asistente de configuración por IA (/admin/api/assist, gemini-3.5-flash).

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

## Estado (julio 2026)

Desplegado en producción vía GitHub → Workers Builds (cada push a la rama
`claude/project-creation-63klor` despliega en ~90 s). Marca: **ExpoBot**
(azul `#3c62f0`, degradado `--grad`, isotipo bocadillo-robot, la «o» de Bot
es un bocadillo). Hecho y verificado de punta a punta:

- Motor RAG multi-tenant con proveedor/modelo por tenant (fisioexpo: `google`
  + `gemini-3.1-flash-lite`), rate limiting por IP (20/min, SQL `check_rate`),
  límite mensual, captura de leads desactivable (`tenants.features.leads`).
- `/admin` (auth ADMIN_TOKEN): árbol clientes→proyectos→bots, wizard de alta en
  un paso (cliente+proyecto+bot por IA), pestañas del bot (Cerebro/Contenido/
  Diseño/Calidad/Publicar), checklist «Listo para publicar», canvas con vista en
  vivo **y chat real**, asistente de diseño IA (3 propuestas desde la web del
  cliente), selector de color estilo Canva, exámenes con preguntas trampa,
  huecos de contenido con auto-mejora IA, vista global de Leads (filtro+CSV),
  buscador Ctrl+K, breadcrumbs clicables, aviso de cambios sin guardar,
  duplicar bot, salud del motor (error_log + alertas), informes mensuales
  (cron día 1, Resend), formulario FAQ con enlace para el cliente, guía de
  integración por plataforma (PDF + URL), facturas con PDF (bucket `facturas`).
- `/panel?token=` (cliente, por bot): leads, conversaciones, huecos, subir
  contenido, probar el bot; pestañas activables por bot (`tenants.panel_features`)
  y panel apagable (`tenants.panel_enabled`).
- `/acceso` (portal del cliente): login email+contraseña (PBKDF2, token HMAC 30d),
  proyectos y herramientas, facturación, método de pago; acceso activable
  (`clients.portal_enabled`) y contraseña revocable desde /admin.

Pendiente del usuario: secretos RESEND_API_KEY + EMAIL_FROM + ADMIN_ALERT_EMAIL
(tiene ya el dominio expobot.es → verificar en Resend), contenido real de
FISIOEXPO (fechas en conflicto, ver abajo), Stripe (fase 2 de facturación).

Backlog: streaming de respuestas, leads por email a `handoff_email` (hoy solo
webhook), Telegram (primer canal recomendado), WhatsApp (Meta Cloud API), sync
de Google Drive, plantillas de bot, dominio expobot.es como custom domain del
Worker.

Cómo se prueba (el contenedor no puede llegar a *.workers.dev): HTTP vía
Supabase `pg_net` (`net.http_get` → poll `net._http_response`); las 4 páginas
embebidas (ADMIN/PANEL/PORTAL/FAQ_HTML) se extraen del template literal y se
comprueban con Playwright headless (scripts en el scratchpad de la sesión).
Ojo con las páginas embebidas: JS de página necesita `\\n`, `<\\/script>`, sin
backticks ni `${`, y las regex con barra invertida pierden el escape.

## Dato sin resolver

Las fechas de FISIOEXPO/26 están en conflicto: IFEMA dice 25–27 de septiembre, el
Facebook del evento dice 24–26 de octubre. Hay que confirmarlo con el cliente antes de
indexar nada — es la primera pregunta que va a recibir el bot.
