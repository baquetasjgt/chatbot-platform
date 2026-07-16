# Plataforma de chatbots — fase 1

Motor multi-tenant: un Worker de Cloudflare, una base Supabase con pgvector, Claude o
Gemini para generar (elegible por cliente) y bge-m3 (Workers AI) para los embeddings.
Cliente cero: FISIOEXPO.

## Estado

- Proyecto Supabase: `chatbot-platform` (`xgkmddmnxikgeonbfxch`, eu-west-1)
- Esquema aplicado: tenants, tenant_keys, documents, chunks, conversations, messages, leads
- Tenant `fisioexpo` creado, con clave pública `pk_fisioexpo_739c231e7180a38646bdf491`
- Pendiente: desplegar el Worker, indexar el contenido, pegar el widget

## 1. Desplegar el Worker

```bash
cd worker
npm install -g wrangler
wrangler login

wrangler secret put SUPABASE_URL           # https://xgkmddmnxikgeonbfxch.supabase.co
wrangler secret put SUPABASE_SERVICE_KEY   # Supabase > Settings > API > service_role
wrangler secret put ANTHROPIC_API_KEY      # console.anthropic.com
wrangler secret put ADMIN_TOKEN            # mínimo 32 caracteres aleatorios
wrangler secret put GEMINI_API_KEY         # aistudio.google.com — solo si algún tenant usa Gemini
wrangler secret put PORTAL_SECRET          # mínimo 32 caracteres; firma sesiones del portal
wrangler secret put RESEND_API_KEY         # envío de correos
wrangler secret put EMAIL_FROM             # remitente verificado

# Obligatorios para generar facturas PDF (no se usan valores ficticios):
wrangler secret put INVOICE_ISSUER_NAME
wrangler secret put INVOICE_ISSUER_NIF
wrangler secret put INVOICE_ISSUER_ADDRESS
wrangler secret put INVOICE_ISSUER_EMAIL
wrangler secret put INVOICE_ISSUER_PHONE
# Opcional: INVOICE_IVA_RATE (por defecto 0.21)

wrangler deploy
```


### WhatsApp heredado

Las conexiones nuevas requieren el `App Secret` de Meta y validan `X-Hub-Signature-256`.
Después de completar ese dato en todas las conexiones existentes, configura
`REQUIRE_WHATSAPP_SIGNATURE=true` para rechazar cualquier webhook no firmado.

### Migraciones

La migración `current_repo_security_hardening` revoca privilegios directos de los roles
`anon` y `authenticated`. Debe aplicarse de forma controlada después de confirmar que
ningún cliente accede a Supabase directamente; el Worker utiliza `service_role`.
Te devuelve una URL tipo `https://chatbot-engine.<tu-cuenta>.workers.dev`.

La service_role key da acceso total a la base de datos. Vive solo como secreto del Worker.
Nunca en el widget, nunca en el repo, nunca en el front.

## 2. Indexar el contenido de FisioExpo

```bash
curl -X POST https://TU-WORKER.workers.dev/admin/ingest \
  -H "Authorization: Bearer TU_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "fisioexpo",
    "urls": [
      "https://fisioexpo.es/",
      "https://fisioexpo.es/programa/",
      "https://fisioexpo.es/masterclasses/",
      "https://fisioexpo.es/casos-clinicos/"
    ],
    "texts": [
      {
        "title": "FAQ oficial y tarifas",
        "content": "Fechas: ... Horarios: ... Precios de entrada: ... Tipos de stand y precios: ... Contacto comercial: ..."
      }
    ]
  }'
```

El campo `texts` es el importante. Las webs de eventos rara vez tienen los precios y las
condiciones en texto plano indexable — suelen estar en imágenes o en PDFs. Escribe un FAQ
a mano con los datos duros (fechas, horarios, precios, qué incluye cada pase, tipos de
stand, teléfono y email de contacto) y mételo ahí. Es lo que más va a mejorar las
respuestas del bot, muy por encima de cualquier ajuste del prompt.

Re-lanza el mismo comando cada vez que cambie la información. Reemplaza el documento
anterior de cada URL, no duplica.

## 3. Pegar el widget

En el `<footer>` del tema de WordPress, o con un plugin de "insertar código":

```html
<script src="https://chatbot-engine.baquetasjgt.workers.dev/widget.js"
        data-key="pk_fisioexpo_739c231e7180a38646bdf491"
        data-api="https://chatbot-engine.baquetasjgt.workers.dev"></script>
```

El widget lo sirve el propio Worker en `/widget.js` (su código fuente vive en
`worker/src/widget.txt`) — no hay que subir nada a ningún CDN. La clave pública es
visible en el HTML, y no pasa nada: solo funciona desde los dominios de la lista
`allowed_domains` del tenant. El snippet exacto de cada cliente se copia desde el
panel de administración.

### Demo para el cliente

Antes de tocar la web real, cada chatbot tiene un enlace de demostración que clona
la web del cliente (copia estática, con aviso de demo) y le incrusta el bot
funcionando de verdad:

```
https://chatbot-engine.baquetasjgt.workers.dev/demo?key=CLAVE_PUBLICA
```

Solo clona dominios de la lista `allowed_domains` del tenant. Si la web no se deja
clonar (bloqueos anti-bot), muestra una maqueta genérica con los colores del bot.
El enlace está listo para copiar en el panel de administración.

## 4. Dar de alta un cliente nuevo (esto es el negocio)

```sql
insert into tenants (slug, name, system_prompt, welcome_message, allowed_domains, handoff_email, provider, model)
values ('cliente-b', 'Cliente B', '...', '¡Hola!', array['clienteb.com'], 'info@clienteb.com',
        'google', 'gemini-3.5-flash');

insert into tenant_keys (tenant_id, public_key)
select id, 'pk_clienteb_' || encode(gen_random_bytes(12), 'hex')
from tenants where slug = 'cliente-b';
```

Luego indexas sus URLs y le pasas el snippet. Sin desplegar nada. Ese es el objetivo:
un cliente nuevo son dos inserts y un curl.

### Proveedor y modelo por cliente

Cada tenant elige proveedor de generación (`provider`) y modelo (`model`). Si no
indicas nada, el default es `anthropic` + `claude-sonnet-4-6`. Para cambiarlo después:

```sql
update tenants set provider = 'google', model = 'gemini-3.5-flash' where slug = 'cliente-b';
```

| `provider`  | `model` (opciones razonables) | Cuándo |
|-------------|-------------------------------|--------|
| `anthropic` | `claude-sonnet-4-6` (default), `claude-sonnet-5`, `claude-haiku-4-5` | Prima la fiabilidad (no inventar precios ni fechas) |
| `google`    | `gemini-3.5-flash` (GA, recomendado), `gemini-3.1-flash-lite` (el más barato), `gemini-flash-latest`, `gemini-flash-lite-latest` | Prima el coste por mensaje |

Notas sobre Gemini:

- Usa modelos de la familia 3.x: los Gemini 2.0 se apagaron en junio de 2026, los 2.5
  (incluido `gemini-2.5-flash-lite`) devuelven 404 desde julio de 2026, y el Worker
  pide `thinkingLevel: "low"`, que es un parámetro de la familia 3. El sustituto de
  `gemini-2.5-flash-lite` es `gemini-3.1-flash-lite`.
- La lista de modelos cambia rápido; la referencia viva es
  <https://ai.google.dev/gemini-api/docs/models>.
- Antes de poner Gemini a un cliente real, pruébalo con preguntas trampa (precios y
  fechas que no estén en el contexto): la regla "no inventar" es la número 1 del bot
  y los modelos más baratos son más propensos a saltársela.

## 5. Panel del cliente

Cada tenant tiene un panel de solo lectura con sus conversaciones, sus leads y las
preguntas que el bot no supo responder (las últimas 100 conversaciones y 200 leads):

```
https://TU-WORKER.workers.dev/panel?token=PANEL_TOKEN
```

El token sale de la base de datos:

```sql
select panel_token from tenants where slug = 'fisioexpo';
```

Ese enlace es lo único que le pasas al cliente. Solo ve sus datos: el token resuelve
el tenant y todas las consultas filtran por él, igual que en el chat. Si el enlace se
filtra, se rota y listo:

```sql
update tenants set panel_token = 'pt_' || encode(gen_random_bytes(16), 'hex')
where slug = 'fisioexpo';
```

## 6. Panel de administración (el tuyo)

Todo lo de los puntos 2 y 4 sin escribir SQL ni curl:

```
https://TU-WORKER.workers.dev/admin
```

Se entra con el `ADMIN_TOKEN` (el mismo secreto del Worker). Está organizado en
**clientes → proyectos → herramientas**: cada cliente tiene sus datos y sus
proyectos, y cada proyecto sus chatbots (puede haber varios). Desde ahí puedes:

- Dar de alta clientes (nombre, contacto, notas) y proyectos
- Crear chatbots dentro de un proyecto, con ayuda de la IA: describes el negocio
  en dos frases y te redacta el system prompt profesional, la bienvenida y las
  preguntas sugeridas (endpoint `/admin/api/assist`, usa `gemini-3.5-flash`)
- Generar el enlace de demo de cada chatbot para enseñárselo al cliente

- Dar de alta clientes y editar toda su configuración: prompt, proveedor y modelo,
  mensaje de bienvenida, preguntas sugeridas, color, dominios permitidos, límite
  mensual, email de leads y webhook
- Apagar el bot de un cliente (checkbox "Activo")
- Copiar el snippet del widget y el enlace del panel de cada cliente, y rotar
  ambos si se filtran
- Indexar contenido y ver el resultado: URLs, texto pegado a mano o **archivos
  subidos** (PDF, TXT, MD, CSV, HTML e imágenes; máx. 10 MB por archivo). Los PDF
  y demás formatos se convierten a texto con la conversión a Markdown de Workers AI
  (`env.AI.toMarkdown`); subir un archivo con el mismo nombre reemplaza al anterior

El alta por SQL sigue funcionando igual; el panel hace lo mismo por debajo.

### Asistente privado de administración

El panel de administración incorpora un copiloto privado de solo lectura. Puede consultar la estructura de clientes, proyectos, asistentes, integraciones y métricas operativas, además de buscar fragmentos relevantes en las bases de conocimiento de todos los bots. Nunca ejecuta cambios ni devuelve secretos de integraciones.

El endpoint es POST /admin/api/copilot, requiere el token de administración y aplica validación de entrada, límite de peticiones y tiempos máximos para los proveedores de IA.

### Gestión de proyectos y leads

- Para cambiar el nombre de un proyecto, abre el proyecto y usa Renombrar o entra en Configuración, edita Nombre del proyecto y guarda.
- En Administración > Leads, cada fila ofrece la acción Eliminar con confirmación.
- En el panel de cliente, los leads también pueden eliminarse desde su tabla. La API valida el tenant del usuario para impedir accesos cruzados.
## Consultas útiles

```sql
-- Qué le preguntan y qué no sabe responder
select content, was_answered, created_at from messages
where tenant_id = (select id from tenants where slug='fisioexpo') and role='user'
order by created_at desc limit 50;

-- Preguntas sin respuesta: tu lista de tareas para mejorar el FAQ
select m.content from messages m
join messages r on r.conversation_id = m.conversation_id and r.role='assistant'
where m.role='user' and r.was_answered = false
order by m.created_at desc;

-- Leads
select kind, name, company, email, phone, message, created_at
from leads order by created_at desc;
```

La segunda consulta es la más valiosa. Las preguntas que el bot no supo responder son
exactamente el contenido que le falta a la base de conocimiento, y también un informe
que puedes enseñarle al cliente cada mes para justificar la cuota.

El panel del cliente incluye además: **probar el bot** (el widget vive dentro del propio
panel), y **subir documentos** (`/panel/upload`, mismo pipeline que el admin) para que el
cliente mantenga el contenido al día sin pasar por ti.

## Lo que falta (fases siguientes)

- Rate limiting por IP en el Worker
- Reindexado automático con un Cron Trigger
- Streaming de la respuesta (ahora llega de golpe)
- Enviar los leads por email a `handoff_email` (hoy solo webhook; el campo ya existe)
