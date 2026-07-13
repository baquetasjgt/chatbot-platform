(function () {
  var s = document.currentScript;
  var KEY = s.getAttribute("data-key");
  var API = s.getAttribute("data-api");
  if (!KEY || !API) return console.error("[chatbot] faltan data-key o data-api");

  var sid = sessionStorage.getItem("cb_sid");
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem("cb_sid", sid);
  }

  var history = [];
  var open = false;
  var busy = false;
  var cfg = { primary_color: "#111", name: "Asistente", welcome_message: "¡Hola!", suggested_questions: [] };

  var css = `
  .cb-btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:28px;border:0;
    background:var(--cb);color:#fff;cursor:pointer;z-index:2147483000;display:flex;align-items:center;
    justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:transform .18s}
  .cb-btn:hover{transform:scale(1.06)}
  .cb-btn svg{width:26px;height:26px;fill:none;stroke:#fff;stroke-width:1.8;stroke-linecap:round}
  .cb-panel{position:fixed;bottom:92px;right:24px;width:380px;max-width:calc(100vw - 32px);
    height:560px;max-height:calc(100vh - 130px);background:#fff;border-radius:16px;z-index:2147483000;
    display:none;flex-direction:column;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.2);
    font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1a1a}
  .cb-panel.on{display:flex}
  .cb-head{background:var(--cb);color:#fff;padding:16px 18px;font-weight:500;display:flex;
    justify-content:space-between;align-items:center;flex:0 0 auto}
  .cb-close{background:0;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1;opacity:.8}
  .cb-close:hover{opacity:1}
  .cb-log{flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:12px}
  .cb-msg{max-width:85%;padding:10px 14px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}
  .cb-msg.bot{background:#f2f2f0;align-self:flex-start;border-bottom-left-radius:4px}
  .cb-msg.me{background:var(--cb);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
  .cb-src{font-size:12px;color:#888;align-self:flex-start;margin-top:-6px}
  .cb-src a{color:#888}
  .cb-sug{display:flex;flex-wrap:wrap;gap:8px;padding:0 18px 12px}
  .cb-sug button{background:#fff;border:1px solid #ddd;border-radius:16px;padding:7px 12px;
    font-size:13px;cursor:pointer;color:#333}
  .cb-sug button:hover{border-color:var(--cb)}
  .cb-foot{display:flex;gap:8px;padding:12px;border-top:1px solid #eee;flex:0 0 auto}
  .cb-foot input{flex:1;border:1px solid #ddd;border-radius:10px;padding:11px 13px;font-size:15px;outline:0}
  .cb-foot input:focus{border-color:var(--cb)}
  .cb-foot button{background:var(--cb);color:#fff;border:0;border-radius:10px;padding:0 16px;cursor:pointer}
  .cb-foot button:disabled{opacity:.45;cursor:default}
  .cb-dots span{display:inline-block;width:6px;height:6px;margin-right:3px;border-radius:3px;
    background:#bbb;animation:cbd 1.2s infinite}
  .cb-dots span:nth-child(2){animation-delay:.18s}
  .cb-dots span:nth-child(3){animation-delay:.36s}
  @keyframes cbd{0%,60%,100%{opacity:.3}30%{opacity:1}}
  @media(max-width:480px){.cb-panel{bottom:0;right:0;width:100%;max-width:100%;height:100%;
    max-height:100%;border-radius:0}}
  @media(prefers-reduced-motion:reduce){.cb-btn,.cb-dots span{transition:none;animation:none}}`;

  var st = document.createElement("style");
  st.textContent = css;
  document.head.appendChild(st);

  var btn = document.createElement("button");
  btn.className = "cb-btn";
  btn.setAttribute("aria-label", "Abrir chat de ayuda");
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/></svg>';

  var panel = document.createElement("div");
  panel.className = "cb-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Chat de ayuda");

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  function esc(t) {
    var d = document.createElement("div");
    d.textContent = t;
    return d.innerHTML;
  }

  function render() {
    panel.innerHTML =
      '<div class="cb-head"><span>' + esc(cfg.name) + '</span>' +
      '<button class="cb-close" aria-label="Cerrar chat">&times;</button></div>' +
      '<div class="cb-log" id="cb-log"></div>' +
      '<div class="cb-sug" id="cb-sug"></div>' +
      '<div class="cb-foot"><input id="cb-in" placeholder="Escribe tu pregunta…" ' +
      'aria-label="Tu pregunta" autocomplete="off"><button id="cb-send" aria-label="Enviar">→</button></div>';

    panel.querySelector(".cb-close").onclick = toggle;
    panel.querySelector("#cb-send").onclick = send;
    panel.querySelector("#cb-in").onkeydown = function (e) {
      if (e.key === "Enter") send();
    };

    add("bot", cfg.welcome_message);

    var sug = panel.querySelector("#cb-sug");
    (cfg.suggested_questions || []).forEach(function (q) {
      var b = document.createElement("button");
      b.textContent = q;
      b.onclick = function () {
        panel.querySelector("#cb-in").value = q;
        send();
      };
      sug.appendChild(b);
    });
  }

  function add(who, text, sources) {
    var log = panel.querySelector("#cb-log");
    var d = document.createElement("div");
    d.className = "cb-msg " + (who === "me" ? "me" : "bot");
    d.textContent = text;
    log.appendChild(d);

    if (sources && sources.length) {
      var s2 = document.createElement("div");
      s2.className = "cb-src";
      s2.innerHTML = "Fuente: " + sources.map(function (u) {
        return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' +
          esc(u.replace(/^https?:\/\/[^/]+\//, "").slice(0, 34) || "web") + "</a>";
      }).join(" · ");
      log.appendChild(s2);
    }
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function send() {
    var input = panel.querySelector("#cb-in");
    var text = input.value.trim();
    if (!text || busy) return;

    busy = true;
    input.value = "";
    panel.querySelector("#cb-sug").innerHTML = "";
    panel.querySelector("#cb-send").disabled = true;
    add("me", text);

    var wait = add("bot", "");
    wait.className = "cb-msg bot cb-dots";
    wait.innerHTML = "<span></span><span></span><span></span>";

    fetch(API + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: KEY,
        session_id: sid,
        message: text,
        page_url: location.href,
        history: history,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        wait.remove();
        if (d.error) throw new Error(d.error);
        add("bot", d.reply, d.sources);
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: d.reply });
      })
      .catch(function () {
        wait.remove();
        add("bot", "No he podido conectar. Vuelve a intentarlo o escríbenos por email.");
      })
      .finally(function () {
        busy = false;
        panel.querySelector("#cb-send").disabled = false;
        input.focus();
      });
  }

  function toggle() {
    open = !open;
    panel.classList.toggle("on", open);
    if (open) panel.querySelector("#cb-in").focus();
  }

  btn.onclick = function () {
    if (!panel.innerHTML) render();
    toggle();
  };

  fetch(API + "/api/config?key=" + encodeURIComponent(KEY))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) return;
      cfg = d;
      document.documentElement.style.setProperty("--cb", cfg.primary_color);
    })
    .catch(function () {});

  document.documentElement.style.setProperty("--cb", cfg.primary_color);
})();
