# Plataforma de chatbots — fase 1

Motor multi-tenant: un Worker de Cloudflare, una base Supabase con pgvector, Claude para
generar y bge-m3 (Workers AI) para los embeddings. Cliente cero: FISIOEXPO.

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
wrangler secret put ADMIN_TOKEN            # inventa una cadena larga y aleatoria

wrangler deploy
```

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
<script src="https://TU-CDN/widget.js"
        data-key="pk_fisioexpo_739c231e7180a38646bdf491"
        data-api="https://TU-WORKER.workers.dev"></script>
```

Sube `widget.js` a Cloudflare Pages, R2 o al propio WordPress. La clave pública es
visible en el HTML, y no pasa nada: solo funciona desde los dominios de la lista
`allowed_domains` del tenant.

## 4. Dar de alta un cliente nuevo (esto es el negocio)

```sql
insert into tenants (slug, name, system_prompt, welcome_message, allowed_domains, handoff_email)
values ('cliente-b', 'Cliente B', '...', '¡Hola!', array['clienteb.com'], 'info@clienteb.com');

insert into tenant_keys (tenant_id, public_key)
select id, 'pk_clienteb_' || encode(gen_random_bytes(12), 'hex')
from tenants where slug = 'cliente-b';
```

Luego indexas sus URLs y le pasas el snippet. Sin desplegar nada. Ese es el objetivo:
un cliente nuevo son dos inserts y un curl.

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

## Lo que falta (fases siguientes)

- Límite de mensajes por tenant (el campo `monthly_message_limit` existe, no se aplica todavía)
- Rate limiting por IP en el Worker
- Reindexado automático con un Cron Trigger
- Streaming de la respuesta (ahora llega de golpe)
- Panel de admin
