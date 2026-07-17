// Detector de escapes perdidos en las páginas embebidas (ADMIN/PANEL/PORTAL/FAQ).
// Dentro de un template literal, "\d" se evalúa como "d" (la barra desaparece):
// una regex de página escrita /\d+/ llega al navegador como /d+/ SIN error de
// sintaxis — un bug silencioso. Regla: toda barra invertida de página debe ir
// doblada (\\). Este scanner marca cualquier \x simple dentro de los literals.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "worker", "src", "index.js");
const PAGES = ["ADMIN_HTML", "PANEL_HTML", "PORTAL_HTML", "FAQ_HTML"];
const src = fs.readFileSync(SRC, "utf8");

function literalRange(name) {
  const start = src.indexOf("const " + name + " = `");
  if (start < 0) throw new Error("no encontrado: " + name);
  const open = src.indexOf("`", start);
  let i = open + 1;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === "`") break;
    i++;
  }
  return { open: open + 1, close: i };
}

let bad = 0;
for (const name of PAGES) {
  const { open, close } = literalRange(name);
  const body = src.slice(open, close);
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "\\") { i++; continue; }
    const next = body[i + 1];
    if (next === "\\") { i += 2; continue; } // \\ correcto: barra real en la página
    if (next === "`" || next === "$") { i += 2; continue; } // escapes necesarios del literal
    // \uXXXX es un escape unicode VÁLIDO del template: produce el carácter
    // literal y en clases de regex funciona igual (p. ej. [̀-ͯ])
    if (next === "u" && /^[0-9a-f]{4}/i.test(body.slice(i + 2, i + 6))) { i += 6; continue; }
    // \x simple: la barra se pierde al evaluar — casi seguro un bug
    const lineNo = src.slice(0, open + i).split("\n").length;
    const ctx = body.slice(Math.max(0, i - 60), i + 20).replace(/\n/g, "⏎");
    console.log(`SOSPECHOSO ${name} línea ${lineNo}: \\${next}  …${ctx}…`);
    bad++;
    i += 2;
  }
}
if (bad) { console.log(bad + " escapes sospechosos"); process.exit(1); }
console.log("OK: sin escapes simples dentro de las páginas embebidas");
