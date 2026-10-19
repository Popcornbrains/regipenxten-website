/* Regi-site: gedeelde verzendhulp voor de homepage, /nieuws en /meetandgreet.
   - één id per klik ("w-" + uuid), hergebruikt bij elke poging, de beacon en de outbox-pogingen:
     de server bewaart zo één rij per klik;
   - snelle fase (eerste 3 minuten): wachten willekeurig tussen 0 en min(30 s, 1 s × 2^n);
     daarna een trage fase, elke 45 à 75 s, zolang de pagina open is: nooit "opgegeven";
   - meteen opnieuw als het netwerk of het scherm terug is; één beacon met hetzelfde id als de
     pagina verborgen wordt terwijl het nog loopt (iOS bevriest een pagina achter een vergrendeld scherm);
   - outbox in localStorage tot ok, bad of closed; bij een volgend bezoek opnieuw (poging o1, o2, ...).
     Vervalt: wedstrijd na 6 uur of na het einde van haar avond, nieuwsbrief na 7 dagen;
   - enkel het exacte token telt: Apps Script geeft een quotafout als HTML-pagina met status 200.
   Zonder dit bestand bewaart het formulier toch: action + method="post" naar dezelfde /exec-URL
   (de bezoeker ziet dan enkel een kaal antwoord). De /exec-URL staat daarom in de action van elk formulier.
   Velden: type, email, voornaam + achternaam (mg), at, source (news: home | nieuws), id, poging, test, hp_x.
   Antwoorden: <type>-ok | <type>-bad | <type>-busy | <type>-err | mg-closed | news-dup (oud, = ok). */
(function () {
  "use strict";

  /* Heel oude browsers (zonder fetch of Promise): geen hulp, het formulier doet de gewone POST naar
     zijn action. Een tik die al wachtte (de wachter in de kop van de pagina), vertrekt nu zo. */
  if (typeof fetch !== "function" || typeof Promise !== "function") {
    window.RegiSignupUnavailable = true;
    var waiting = document.querySelector("form[data-pending]");
    if (waiting) { waiting.removeAttribute("data-pending"); try { waiting.submit(); } catch (e) {} }
    return;
  }

  /* De wedstrijdavonden, enkel voor wat de pagina toont: de server beslist (met dezelfde vensters).
     Belgische tijd is +02:00 tot zo 25/10 03:00. */
  var EVENINGS = [
    { bron: "meetandgreet-2026-10-23", day: "vrijdag 23 oktober",
      open: "2026-10-23T18:30:00+02:00", close: "2026-10-24T02:00:00+02:00" },
    { bron: "meetandgreet-2026-10-24", day: "zaterdag 24 oktober",
      open: "2026-10-24T18:30:00+02:00", close: "2026-10-25T02:00:00+02:00" }
  ];

  var TIMEOUT = 45000;                       /* per poging; de server wacht hoogstens 20 s op zijn slot */
  var BASE = 1000, CAP = 30000, FAST = 180000;   /* snelle fase: full jitter, 3 minuten lang */
  var SLOW = 45000, SLOW_SPREAD = 30000;     /* trage fase: elke 45 à 75 s */
  var PATIENCE = 4000;                       /* zo lang zonder antwoord: "nog even geduld" */
  var TTL = { mg: 6 * 3600e3, news: 7 * 864e5 };
  var KEY = "regi_outbox_v2";
  var EXEC = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

  var q = location.search;
  var host = location.hostname;
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) || /^(10|192\.168)\./.test(host);
  /* Voorbeeldhosts: lokaal en via Tailscale. */
  var PREVIEW = LOCAL || /\.ts\.net$/.test(host);

  var ENDPOINT = "", mockServer = false;
  if (LOCAL) {                               /* enkel lokaal, voor tests tegen een nepserver */
    var ep = /[?&]endpoint=([^&]+)/.exec(q);
    if (ep) { ENDPOINT = decodeURIComponent(ep[1]); mockServer = true; }
  }

  /* Op een voorbeeldhost vertrekt standaard niets (demo), zodat een test nooit een rij in de echte
     Sheet zet. ?demo=traag (drie keer druk, dan binnen), ?demo=fout (nooit binnen: de trage fase),
     ?demo=dicht (de server zegt dat de wedstrijd dicht is). ?live gebruikt toch de echte server. */
  var DEMO = "";
  if (PREVIEW && !mockServer && !/[?&]live\b/.test(q)) DEMO = (/[?&]demo=([a-z]+)/.exec(q) || [])[1] || "ok";
  /* Demo en nepserver hebben hun eigen opslag: een gespeelde inzending kan zo nooit later, in de echte
     modus, uit de outbox naar de echte server vertrekken. */
  var SUFFIX = DEMO ? "-demo" : mockServer ? "-mock" : "";
  KEY += SUFFIX;

  /* ?now=<ISO> op een voorbeeldhost: doen alsof het dat moment is. Enkel in de demo of tegen de
     nepserver: een nagespeeld klikmoment mag nooit als toestemming in de echte Sheet belanden. */
  var skew = 0;
  if (DEMO || mockServer) {
    var nw = /[?&]now=([^&]+)/.exec(q), nt = nw ? Date.parse(decodeURIComponent(nw[1])) : NaN;
    if (!isNaN(nt)) skew = nt - Date.now();
  }
  function now() { return Date.now() + skew; }

  if (DEMO) { FAST = 20000; SLOW = 5000; SLOW_SPREAD = 2000; }
  if (mockServer && /[?&]fast\b/.test(q)) {
    TIMEOUT = 1500; BASE = 100; CAP = 1000; FAST = 4000; SLOW = 1000; SLOW_SPREAD = 500; PATIENCE = 500;
  }

  /* ---- Opslag: localStorage, met geheugen als terugval (privévenster, vol, geblokkeerd) ---- */
  var mem = {};
  function get(k) {
    try { var v = localStorage.getItem(k); if (v !== null) return v; } catch (e) {}
    return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
  }
  function set(k, v) {
    mem[k] = v;
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function outbox() {
    try {
      var l = JSON.parse(get(KEY) || "[]");
      return Object.prototype.toString.call(l) === "[object Array]" ? l.filter(function (x) { return x && x.f && x.f.id; }) : [];
    } catch (e) { return []; }
  }
  function saveOutbox(l) { set(KEY, JSON.stringify(l)); }
  function put(item) {
    var l = outbox().filter(function (x) { return x.f.id !== item.f.id; });
    l.push(item);
    saveOutbox(l);
  }
  function drop(id) { saveOutbox(outbox().filter(function (x) { return x.f.id !== id; })); }

  /* ---- Id, schoonmaak, vensters ------------------------------------------------- */
  function newId() {
    var c = window.crypto, h = "";
    try { if (c && typeof c.randomUUID === "function") return "w-" + c.randomUUID(); } catch (e) {}   /* enkel op https */
    try {
      var b = c.getRandomValues(new Uint8Array(16));
      for (var i = 0; i < 16; i++) h += (b[i] + 256).toString(16).slice(1);
      return "w-" + h;
    } catch (e) {}
    return "w-" + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  /* Dezelfde schoonmaak als de server: stuurtekens worden spaties, onzichtbare tekens weg. */
  function clean(v) {
    var s = String(v == null ? "" : v);
    try { s = s.normalize("NFC"); } catch (e) {}
    return s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
  }

  var WINDOWS = EVENINGS.map(function (e) {
    return { bron: e.bron, day: e.day, open: Date.parse(e.open), close: Date.parse(e.close) };
  });
  function windowAt(t) {
    for (var i = 0; i < WINDOWS.length; i++) if (t >= WINDOWS[i].open && t < WINDOWS[i].close) return WINDOWS[i];
    return null;
  }
  /* voor (vóór vrijdag) | open | tussen (tussen de avonden) | afgelopen */
  function contest(t) {
    var w = windowAt(t);
    if (w) return { phase: "open", evening: w };
    if (t < WINDOWS[0].open) return { phase: "voor", next: WINDOWS[0] };
    for (var i = 1; i < WINDOWS.length; i++) {
      if (t < WINDOWS[i].open) return { phase: "tussen", next: WINDOWS[i], last: WINDOWS[i - 1] };
    }
    return { phase: "afgelopen" };
  }

  /* Mag dit item nog vertrekken? Een wedstrijdinzending hoort bij de avond van haar klik: wie vrijdag
     meedeed en pas zaterdag weer online komt, belandt nooit in de trekking van zaterdag. */
  function valid(item, t) {
    if (!item || !item.f || !item.f.id) return false;
    var age = Date.now() - (item.t || 0);
    if (item.f.type === "news") return age < TTL.news;
    if (age >= TTL.mg) return false;
    if (item.f.test === "1") return true;
    var w = windowAt(Date.parse(item.f.at));
    return !!w && t < w.close;
  }

  /* ---- Eén poging ------------------------------------------------------------------ */
  function verdict(type, t) {
    t = String(t == null ? "" : t).trim();
    if (t === type + "-ok" || t === type + "-dup") return "ok";
    if (t === type + "-bad") return "bad";
    if (type === "mg" && t === "mg-closed") return "closed";
    return "retry";                          /* -busy, -err, een Google-foutpagina, netwerk, time-out */
  }
  function encode(f) {
    var out = [];
    for (var k in f) {
      if (Object.prototype.hasOwnProperty.call(f, k) && f[k] != null) out.push(encodeURIComponent(k) + "=" + encodeURIComponent(f[k]));
    }
    return out.join("&");
  }
  function playDemo(f) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var n = parseInt(String(f.poging).replace(/\D/g, ""), 10) || 1;
        if (DEMO === "fout") resolve("retry");
        else if (DEMO === "traag" && n < 4) resolve("retry");
        else if (DEMO === "dicht" && f.type === "mg") resolve("closed");
        else resolve("ok");
      }, 900);
    });
  }
  function send(f) {
    if (DEMO) return playDemo(f);
    if (!ENDPOINT) return Promise.resolve("broken");   /* nooit een valse "gelukt" */
    if (typeof fetch !== "function") return Promise.resolve("retry");
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    return new Promise(function (resolve) {
      var settled = false, timer;
      function end(v) { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } }
      /* een afgebroken poging kan toch bewaard hebben: daarom hetzelfde id bij de volgende */
      timer = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) {} } end("retry"); }, TIMEOUT);
      try {
        /* form-urlencoded = "simple request": geen CORS-preflight tegen Apps Script */
        fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: encode(f),
          credentials: "omit",
          signal: ctrl ? ctrl.signal : undefined
        })
          .then(function (r) { return r.text(); })
          .then(function (t) { end(verdict(f.type, t)); }, function () { end("retry"); });
      } catch (e) { end("retry"); }
    });
  }

  /* ---- De lus: proberen tot ok, bad of closed, zolang de pagina open is ---------------- */
  var loops = {};   /* id -> lus */

  function run(item, ui, fromBox) {
    var L = loops[item.f.id];
    if (L) { if (ui) L.ui = ui; return; }
    /* n telt de pogingen (voor het veld poging), e de stappen van de snelle fase (begint opnieuw bij wake) */
    L = loops[item.f.id] = { item: item, ui: ui, fromBox: !!fromBox, start: now(), n: 0, e: 0, timer: 0,
                             busy: false, kick: false, beacon: false, done: false };
    put(item);
    if (L.ui) L.ui("sending", item);
    attempt(L);
  }
  function fields(L, poging) {
    var f = {}, k;
    for (k in L.item.f) if (Object.prototype.hasOwnProperty.call(L.item.f, k)) f[k] = L.item.f[k];
    f.poging = poging;
    return f;
  }
  function attempt(L) {
    if (L.done || L.busy) return;
    clearTimeout(L.timer); L.timer = 0;
    if (!valid(L.item, now())) { drop(L.item.f.id); finish(L, "closed"); return; }
    L.busy = true; L.n++;
    send(fields(L, (L.fromBox ? "o" : "") + Math.min(L.n, 99))).then(function (v) {
      L.busy = false;
      if (L.done) return;
      if (v === "ok" || v === "bad" || v === "closed") { drop(L.item.f.id); finish(L, v); return; }
      if (v === "broken") { finish(L, "broken"); return; }   /* blijft in de outbox voor een volgend bezoek */
      var fast = now() - L.start < FAST;
      L.e++;
      var wait = L.kick ? Math.random() * 1500                                  /* wake tijdens een poging */
        : fast ? Math.random() * Math.min(CAP, BASE * Math.pow(2, L.e))         /* full jitter */
        : SLOW + Math.random() * SLOW_SPREAD;                                    /* trage fase */
      L.kick = false;
      if (L.ui) L.ui(fast ? "waiting" : "slow", L.item);
      L.timer = setTimeout(function () { attempt(L); }, wait);
    });
  }
  function finish(L, v) {
    L.done = true; clearTimeout(L.timer);
    delete loops[L.item.f.id];
    if (L.ui) L.ui(v === "ok" ? "done" : v, L.item);
  }
  function beacon(L) {
    if (L.beacon || DEMO || !ENDPOINT || !navigator.sendBeacon) return;
    L.beacon = true;
    try { navigator.sendBeacon(ENDPOINT, new URLSearchParams(encode(fields(L, "b")))); } catch (e) {}
  }

  /* Verborgen: één beacon per lopende inzending. Terug zichtbaar, netwerk terug of een herstelde
     pagina: opnieuw de snelle fase en meteen een poging (loopt er net een, dan meteen daarna), met wat
     spreiding, zodat niet de hele zaal in dezelfde seconde vertrekt. */
  function wake() {
    var hidden = document.visibilityState === "hidden";
    Object.keys(loops).forEach(function (id) {
      var L = loops[id];
      if (!L || L.done) return;
      if (hidden) { beacon(L); return; }
      L.start = now(); L.e = 0;
      if (L.busy) { L.kick = true; return; }
      clearTimeout(L.timer);
      L.timer = setTimeout(function () { attempt(L); }, Math.random() * 1500);
    });
    if (!hidden) flush();
  }

  /* Alles in de outbox dat nog mag en niet al loopt, gaat opnieuw de deur uit; vervallen items eruit. */
  function flush() {
    var t = now(), l = outbox(), keep = l.filter(function (x) { return valid(x, t); });
    if (keep.length !== l.length) saveOutbox(keep);
    if (!ENDPOINT && !DEMO) return;
    keep.forEach(function (x) { if (!loops[x.f.id]) run(x, null, true); });
  }

  /* ---- Een formulier koppelen ---------------------------------------------------------
     o.type, o.page, o.source (news), o.test, o.fields (namen), o.check(waarden) -> {field, text} | null,
     o.text (per toestand), o.busyLabel, o.onDone(item), o.onClosed(item). */
  function bind(form, o) {
    var action = form.getAttribute("action") || "";
    if (!mockServer && EXEC.test(action)) ENDPOINT = action;
    if (mockServer && ENDPOINT === action) ENDPOINT = "";   /* de echte /exec is nooit een nepserver */
    var btn = form.querySelector('button[type="submit"]');
    /* data-label: het oorspronkelijke label, als de wachter in de kop het al op "Even geduld…" zette */
    var label = btn ? (btn.getAttribute("data-label") || btn.textContent) : "";
    var status = form.querySelector("[data-status]");
    var sid = status ? (status.id || (status.id = (form.id || "form") + "-status")) : "";
    var current = null, patience = 0;

    function field(n) { return form.elements[n]; }
    function value(n) {
      var el = field(n), v = el ? clean(el.value) : "";
      return n === "email" ? v : v.replace(/\s+/g, " ");
    }
    function say(t) { if (status) status.textContent = t || ""; }
    /* het foute veld krijgt aria-invalid en de foutzin als beschrijving; de andere velden niet */
    function mark(name) {
      form.classList.toggle("is-invalid", !!name);
      o.fields.forEach(function (n) {
        var el = field(n);
        if (!el) return;
        var d = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(function (x) { return x && x !== sid; });
        if (n === name) { el.setAttribute("aria-invalid", "true"); if (sid) d.push(sid); }
        else el.removeAttribute("aria-invalid");
        if (d.length) el.setAttribute("aria-describedby", d.join(" ")); else el.removeAttribute("aria-describedby");
      });
    }
    function state(s, item) {
      clearTimeout(patience);
      form.setAttribute("data-state", s);
      var busy = s === "sending" || s === "waiting" || s === "slow";
      if (btn) { btn.disabled = busy; btn.textContent = busy ? o.busyLabel : label; }
      o.fields.forEach(function (n) { var el = field(n); if (el) el.readOnly = busy; });
      say(o.text[s]);
      if (s === "sending") patience = setTimeout(function () { if (form.getAttribute("data-state") === "sending") say(o.text.patience); }, PATIENCE);
      if (s === "bad" && o.fields.length === 1) mark(o.fields[0]);
      if (s === "done" && o.onDone) o.onDone(item);
      if (s === "closed" && o.onClosed) o.onClosed(item);
    }
    function ui(s, item) {
      if (!current || item.f.id !== current.f.id) return;
      if (s === "done" || s === "bad" || s === "closed") current = null;
      state(s, item);
    }
    function same(item, v) {
      for (var i = 0; i < o.fields.length; i++) if (item.f[o.fields[i]] !== v[o.fields[i]]) return false;
      return true;
    }
    function start(item, fromBox) { current = item; run(item, ui, fromBox); }

    o.fields.forEach(function (n) {
      var el = field(n);
      if (el) el.addEventListener("input", function () {
        if (el.getAttribute("aria-invalid")) { mark(null); say(""); }
      });
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var s = form.getAttribute("data-state");
      if (s === "sending" || s === "waiting" || s === "slow") return;
      var v = {};
      o.fields.forEach(function (n) { v[n] = value(n); });
      var bad = o.check(v);
      mark(bad && bad.field);
      if (bad) { say(bad.text); var el = field(bad.field); if (el) el.focus(); return; }
      /* dezelfde gegevens opnieuw (na een fout) = dezelfde inzending: zelfde id, zelfde klikmoment */
      var item = current && same(current, v) ? current : null;
      if (!item) {
        if (current) drop(current.f.id);
        var f = { type: o.type, email: v.email, at: new Date(now()).toISOString(), id: newId(),
                  hp_x: clean((field("hp_x") || {}).value || "") };
        if (o.type === "mg") { f.voornaam = v.voornaam; f.achternaam = v.achternaam; }
        if (o.source) f.source = o.source;
        if (o.test) f.test = "1";
        item = { t: Date.now(), page: o.page, f: f };
      }
      if (!ENDPOINT && !DEMO) { current = item; put(item); state("broken", item); return; }
      /* het toetsenbord zakt, zodat de statusregel in beeld blijft */
      if (document.activeElement && form.contains(document.activeElement) && document.activeElement.blur) document.activeElement.blur();
      start(item, false);
    });

    /* Herstel: staat er voor deze pagina nog een onbevestigde inzending in de outbox, dan komen de
       gegevens terug in het formulier en loopt ze verder (poging o1, o2, ...). */
    var t = now();
    var mine = outbox().filter(function (x) { return x.page === o.page && (x.f.test === "1") === !!o.test && valid(x, t); });
    if (mine.length && (ENDPOINT || DEMO)) {
      var item = mine[mine.length - 1];
      o.fields.forEach(function (n) { var el = field(n); if (el && item.f[n] != null) el.value = item.f[n]; });
      form.removeAttribute("data-pending");
      start(item, true);
    } else if (form.hasAttribute("data-pending")) {
      /* iemand tikte al vóór dit bestand geladen was (de wachter in de kop hield het tegen): nu verzenden */
      form.removeAttribute("data-pending");
      if (btn) { btn.disabled = false; btn.textContent = label; }
      setTimeout(function () {
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { cancelable: true }));
      }, 0);
    }

    return {
      reset: function () { current = null; form.reset(); mark(null); state("idle"); }
    };
  }

  /* Op een voorbeeldhost zegt een klein label dat er niets vertrekt. */
  function demoBadge() {
    if (!DEMO || document.getElementById("regi-demo")) return;
    var b = document.createElement("p");
    b.id = "regi-demo";
    b.textContent = "Voorbeeld: er wordt niets verstuurd" + (DEMO !== "ok" ? " (" + DEMO + ")" : "");
    b.setAttribute("style", "position:fixed;left:10px;top:max(10px, env(safe-area-inset-top));z-index:9;margin:0;padding:.25em .75em;" +
      "border-radius:999px;background:#fff;color:#000;font:700 11px/1.4 'Helvetica Neue',Helvetica,Arial,sans-serif;pointer-events:none");
    document.body.appendChild(b);
  }

  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", function (e) { if (e.persisted) wake(); });
  /* na de inline scripts van de pagina, zodat een gekoppeld formulier zijn eigen inzending neemt */
  function ready() { demoBadge(); flush(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else setTimeout(ready, 0);

  window.RegiSignup = {
    bind: bind,
    contest: function () { return contest(now()); },
    eveningAt: function (iso) { return windowAt(Date.parse(iso)); },
    now: now,
    get: get,
    set: set,
    demo: DEMO,
    suffix: SUFFIX,      /* eigen opslagsleutels per modus, ook voor de pagina's */
    EMAIL: /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/
  };
})();
