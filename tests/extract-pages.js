// Extrae las páginas HTML embebidas del Worker (template literals) a archivos,
// para poder validarlas con un navegador real en CI. Falla si alguna no aparece.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "worker", "src", "index.js");
const OUT = process.env.PAGES_OUT || path.join(__dirname, "out");
const PAGES = ["ADMIN_HTML", "PANEL_HTML", "PORTAL_HTML", "FAQ_HTML"];

const src = fs.readFileSync(SRC, "utf8");
fs.mkdirSync(OUT, { recursive: true });

function grab(name) {
  const start = src.indexOf("const " + name + " = `");
  if (start < 0) throw new Error("no encontrado: " + name);
  const open = src.indexOf("`", start);
  let i = open + 1;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === "`") break;
    i++;
  }
  const lit = src.slice(open, i + 1);
  // los HTML embebidos no usan interpolación ${}; si alguien la introduce,
  // este eval la detectaría (ReferenceError) y el test fallaría: es a propósito
  return eval(lit);
}

for (const name of PAGES) {
  const html = grab(name);
  if (!/^<!doctype html>/i.test(html.trim())) throw new Error(name + ": no empieza por <!doctype html>");
  if (html.length < 5000) throw new Error(name + ": sospechosamente corta (" + html.length + " bytes)");
  const file = path.join(OUT, name.replace("_HTML", "").toLowerCase() + ".html");
  fs.writeFileSync(file, html);
  console.log("extraída", name, "→", path.basename(file), "(" + html.length + " bytes)");
}
console.log("OK: " + PAGES.length + " páginas extraídas en " + OUT);
