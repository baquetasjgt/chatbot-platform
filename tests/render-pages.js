// Renderiza las páginas extraídas con Chromium headless y falla si alguna
// lanza errores de página (JS roto dentro de los template literals embebidos).
// Requiere: node tests/extract-pages.js antes, y playwright instalado.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const OUT = process.env.PAGES_OUT || path.join(__dirname, "out");
// comprobaciones mínimas de estructura por página: si un refactor rompe un id
// clave, el test lo dice aquí y no en producción
const EXPECT = {
  "admin.html": ["#app", "#login", "#v-tenant"],
  "panel.html": ["#client-nav", "#t-overview", "#t-leads"],
  "portal.html": ["body"],
  "faq.html": ["body"],
};

(async () => {
  const exe = process.env.CHROMIUM_PATH; // opcional: binario concreto (entorno local)
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  let failed = false;

  for (const [file, selectors] of Object.entries(EXPECT)) {
    const full = path.join(OUT, file);
    if (!fs.existsSync(full)) { console.error("FALTA", file, "(¿corrió extract-pages?)"); failed = true; continue; }
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("file://" + full, { waitUntil: "networkidle" });
    await new Promise((r) => setTimeout(r, 400));
    const missing = [];
    for (const sel of selectors) {
      if (!(await page.$(sel))) missing.push(sel);
    }
    if (errors.length || missing.length) {
      failed = true;
      console.error("FALLO", file, errors.length ? "| pageerrors: " + errors.join(" · ") : "", missing.length ? "| faltan: " + missing.join(", ") : "");
    } else {
      console.log("OK", file);
    }
    await page.close();
  }
  await browser.close();
  if (failed) process.exit(1);
  console.log("OK: todas las páginas renderizan sin errores");
})();
