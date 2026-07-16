# Folleto comercial de ExpoBOT

Catálogo de producto en PDF (A4, 6 páginas) para la venta del servicio ExpoBOT.
El archivo final es `expobot-folleto-comercial.pdf`.

## Estructura

- **Página 1 — Portada.** Gancho + subtítulo + CTA (demo de 20 min).
- **Páginas 2–3 — Problema y solución.** Fórmula PAS: consultas sin atender
  (con la feria tipo de la calculadora de expobot.es) → recorrido pregunta→lead
  y garantías («Respuestas útiles. Límites claros.»).
- **Páginas 4–5 — Beneficios y plataforma.** Beneficio > característica,
  autoridad (especialización ferial, IA, Cloudflare, sin riesgo reputacional),
  caso de uso FISIOEXPO y huecos reservados para testimonios reales.
- **Página 6 — Contraportada.** Urgencia (plazas por temporada), CTA con QR a
  `expobot.es/#demo` y los 3 pasos siguientes.

## Regenerar el PDF

```bash
pip install weasyprint
python3 generate_pdf.py
```

El script descarga las tipografías Inter (TTF) a `fonts/` la primera vez.
Los SVG de `assets/` son copias de `worker/src/web/assets/` (sin los atributos
`width`/`height` para que escalen por su `viewBox`) más el QR generado con la
librería `qrcode` apuntando a `https://expobot.es/#demo`.

## Pendiente antes de imprimir/enviar

- Sustituir los dos huecos de testimonio/resultados de la página 5 por citas
  y cifras reales cuando exista la primera edición con cliente.
- Añadir email/teléfono comercial en la contraportada cuando estén operativos
  (hoy el CTA es la web y su formulario de demo).
