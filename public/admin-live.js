/* LinkTalk: живой «кто с кем говорит» и настройка подслушки в разделе Matrix.
 * Источник данных — события статуса админки (linktalk:status), настройки — /api/monitor.
 * Разработчик: makss1c */
(function () {
  "use strict";
  var host = document.getElementById("matrix-section-body");
  if (!host) return;

  var snapshot = null;
  var links = [];
  var linksSig = "";
  var prevTalk = new Map();
  var log = [];

  var root = document.createElement("div");
  root.className = "lt-live-wrap";
  root.innerHTML =
    '<section class="lt-panel" id="lt-live">' +
      '<h3 class="matrix-subheading">Live: who talks to whom</h3>' +
      '<div id="lt-live-graph" class="lt-live-graph"></div>' +
      '<div id="lt-live-listen" class="lt-live-listen"></div>' +
      '<ul id="lt-live-log" class="lt-live-log" aria-label="Talk history"></ul>' +
    '</section>' +
    '<section class="lt-panel" id="lt-monitor">' +
      '<h3 class="matrix-subheading">Monitoring (eavesdrop)</h3>' +
      '<div class="section-note">Row user can listen to column user at all times, whoever that person talks to. Click a cell: off, optional (user switches it on), always on.</div>' +
      '<div id="lt-monitor-grid" class="lt-monitor-grid"></div>' +
      '<div id="lt-monitor-msg" class="flash-message"></div>' +
    '</section>';
  host.insertBefore(root, host.firstChild);

  var graphEl = root.querySelector("#lt-live-graph");
  var listenEl = root.querySelector("#lt-live-listen");
  var logEl = root.querySelector("#lt-live-log");
  var gridEl = root.querySelector("#lt-monitor-grid");
  var msgEl = root.querySelector("#lt-monitor-msg");

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clip(text, n) { text = String(text || ""); return text.length > n ? text.slice(0, n - 1) + "…" : text; }
  function clock() { return new Date().toTimeString().slice(0, 8); }
  function users() { return (snapshot && Array.isArray(snapshot.users)) ? snapshot.users : []; }

  function targetKey(t) { return t.type + ":" + t.id; }
  function targetLabel(t) {
    var prefix = t.type === "conference" ? "◎ " : t.type === "feed" ? "≋ " : t.type === "guest" ? "◇ " : "";
    return prefix + (t.name || (t.type + " " + t.id));
  }

  /* ---------- живая схема ---------- */
  function renderGraph() {
    var talkers = users().filter(function (u) { return u.online && u.talking && Array.isArray(u.talkTargets) && u.talkTargets.length; });
    var targets = [];
    var index = {};
    talkers.forEach(function (u) {
      u.talkTargets.forEach(function (t) {
        var k = targetKey(t);
        if (!(k in index)) { index[k] = targets.length; targets.push(t); }
      });
    });
    if (!talkers.length) {
      graphEl.innerHTML = '<p class="lt-live-empty"><span class="lt-dot"></span>Nobody is talking right now</p>';
      return;
    }
    var rowH = 40;
    var H = Math.max(talkers.length, targets.length) * rowH + 16;
    var yL = function (i) { return 8 + i * rowH + rowH / 2 - 4 + (H - 16 - talkers.length * rowH) / 2; };
    var yR = function (i) { return 8 + i * rowH + rowH / 2 - 4 + (H - 16 - targets.length * rowH) / 2; };
    var svg = '<svg viewBox="0 0 760 ' + H + '" width="100%" role="img" aria-label="Live talk map">';
    talkers.forEach(function (u, i) {
      u.talkTargets.forEach(function (t) {
        var a = yL(i), b = yR(index[targetKey(t)]);
        svg += '<path class="lt-edge' + (u.talkLocked ? " is-locked" : "") + '" d="M250,' + a + " C370," + a + " 390," + b + ' 510,' + b + '"/>';
      });
    });
    talkers.forEach(function (u, i) {
      var y = yL(i) - 15;
      svg += '<g class="lt-node lt-node--src"><rect x="6" y="' + y + '" width="244" height="30" rx="6"/>' +
        '<circle cx="22" cy="' + (y + 15) + '" r="4"/>' +
        '<text x="36" y="' + (y + 20) + '">' + esc(clip(u.name, 26)) + (u.talkLocked ? " 🔒" : "") + "</text></g>";
    });
    targets.forEach(function (t, i) {
      var y = yR(i) - 15;
      svg += '<g class="lt-node lt-node--dst lt-node--' + esc(t.type) + '"><rect x="510" y="' + y + '" width="244" height="30" rx="6"/>' +
        '<text x="524" y="' + (y + 20) + '">' + esc(clip(targetLabel(t), 28)) + "</text></g>";
    });
    graphEl.innerHTML = svg + "</svg>";
  }

  function renderListening() {
    var chips = [];
    users().forEach(function (u) {
      (u.monitoring || []).forEach(function (m) {
        chips.push('<span class="lt-chip' + (m.forced ? " is-forced" : "") + '"><b>' + esc(u.name) + '</b> 👂 ' + esc(m.name || ("User " + m.id)) + (m.forced ? " · always" : "") + "</span>");
      });
    });
    listenEl.innerHTML = chips.length ? '<div class="lt-live-title">Listening in</div>' + chips.join("") : "";
  }

  function updateLog() {
    var current = new Map();
    users().forEach(function (u) {
      if (u.online && u.talking && Array.isArray(u.talkTargets) && u.talkTargets.length) {
        current.set(u.id, { name: u.name, label: u.talkTargets.map(targetLabel).join(", ") });
      }
    });
    current.forEach(function (now, id) {
      var before = prevTalk.get(id);
      if (!before || before.label !== now.label) log.unshift({ t: clock(), text: now.name + " → " + now.label, on: true });
    });
    prevTalk.forEach(function (before, id) {
      if (!current.has(id)) log.unshift({ t: clock(), text: before.name + " stopped talking", on: false });
    });
    prevTalk = current;
    if (log.length > 40) log.length = 40;
    logEl.innerHTML = log.map(function (e) {
      return '<li class="' + (e.on ? "is-on" : "is-off") + '"><time>' + e.t + "</time><span>" + esc(e.text) + "</span></li>";
    }).join("");
  }

  /* ---------- подслушка: сетка прав ---------- */
  function stateOf(userId, targetId) {
    for (var i = 0; i < links.length; i++) {
      if (links[i].userId === userId && links[i].targetUserId === targetId) return links[i];
    }
    return null;
  }
  function renderGrid() {
    var list = users().filter(function (u) { return !u.isGuest; });
    if (list.length < 2) { gridEl.innerHTML = '<p class="target-matrix-empty">Add at least two users to configure monitoring.</p>'; return; }
    var head = "<tr><th></th>" + list.map(function (u) { return "<th><span>" + esc(clip(u.name, 22)) + "</span></th>"; }).join("") + "</tr>";
    var rows = list.map(function (row) {
      return "<tr><th>" + esc(row.name) + "</th>" + list.map(function (col) {
        if (row.id === col.id) return '<td class="lt-self">·</td>';
        var link = stateOf(row.id, col.id);
        var state = !link ? "off" : link.forced ? "forced" : "optional";
        var label = state === "off" ? "—" : state === "forced" ? "ALWAYS" : (link.enabled ? "ON" : "OPT");
        return '<td><button type="button" class="lt-cell is-' + state + (link && link.enabled && !link.forced ? " is-enabled" : "") +
          '" data-u="' + row.id + '" data-t="' + col.id + '" data-s="' + state + '" title="' + esc(row.name + " → " + col.name) + '">' + label + "</button></td>";
      }).join("") + "</tr>";
    }).join("");
    gridEl.innerHTML = '<table class="lt-monitor-table">' + head + rows + "</table>";
  }

  gridEl.addEventListener("click", function (event) {
    var btn = event.target.closest(".lt-cell");
    if (!btn) return;
    var next = { off: { allowed: true, forced: false }, optional: { allowed: true, forced: true }, forced: { allowed: false, forced: false } }[btn.dataset.s];
    btn.disabled = true;
    fetch("/api/monitor", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: Number(btn.dataset.u), targetUserId: Number(btn.dataset.t), allowed: next.allowed, forced: next.forced })
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
      .then(function (j) { links = j.links || []; msgEl.textContent = ""; renderGrid(); })
      .catch(function (e) { msgEl.textContent = String(e.message || e); btn.disabled = false; });
  });

  function loadLinks() {
    fetch("/api/monitor", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : { links: [] }; })
      .then(function (j) { links = j.links || []; renderGrid(); })
      .catch(function () { /* сервер без подслушки — сетка останется пустой */ });
  }

  window.addEventListener("linktalk:status", function (event) {
    snapshot = event.detail || {};
    renderGraph(); renderListening(); updateLog();
    var sig = users().map(function (u) { return u.id + ":" + (u.monitoring || []).length; }).join("|") + "#" + users().length;
    if (sig !== linksSig) { linksSig = sig; loadLinks(); }
  });
  renderGraph();
})();
