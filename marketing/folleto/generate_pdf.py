#!/usr/bin/env python3
"""Genera el folleto comercial de ExpoBOT (A4, 6 páginas) a partir de folleto.html.

Uso:
    pip install weasyprint
    python3 generate_pdf.py

Si no existe la carpeta fonts/, descarga las Inter (TTF) desde Google Fonts.
"""
import re
import sys
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
FONTS = BASE / "fonts"
OUT = BASE / "expobot-folleto-comercial.pdf"
WEIGHTS = (400, 500, 600, 700, 800, 900)
GFONTS_CSS = (
    "https://fonts.googleapis.com/css2?family=Inter:wght@"
    + ";".join(str(w) for w in WEIGHTS)
    + "&display=swap"
)


def fetch_fonts() -> None:
    if all((FONTS / f"inter-{w}.ttf").exists() for w in WEIGHTS):
        return
    FONTS.mkdir(exist_ok=True)
    # Un user-agent antiguo hace que Google Fonts sirva TTF en lugar de woff2
    req = urllib.request.Request(GFONTS_CSS, headers={"User-Agent": "Mozilla/4.0"})
    css = urllib.request.urlopen(req).read().decode()
    for block in css.split("@font-face")[1:]:
        weight = re.search(r"font-weight:\s*(\d+)", block).group(1)
        url = re.search(r"url\((https://[^)]+\.ttf)\)", block).group(1)
        dest = FONTS / f"inter-{weight}.ttf"
        if not dest.exists():
            print(f"Descargando Inter {weight}…")
            urllib.request.urlretrieve(url, dest)


def main() -> None:
    from weasyprint import HTML

    fetch_fonts()
    HTML(filename=str(BASE / "folleto.html"), base_url=str(BASE) + "/").write_pdf(str(OUT))
    print(f"OK -> {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    sys.exit(main())
