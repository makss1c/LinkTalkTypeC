/* LinkTalk: переключатель языка EN | RU для веб-клиента и админки.
 * Тексты страницы остаются английскими в разметке; при выборе RU движок подменяет их по словарю
 * window.LINKTALK_RU (i18n-ru.js), в том числе строки, которые JS добавляет позже. */
(function () {
  "use strict";
  var KEY = "linktalk.lang";
  var RU = window.LINKTALK_RU || {};
  var RULES = window.LINKTALK_RU_RULES || [];
  var ATTRS = ["placeholder", "title", "aria-label", "alt"];
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 0 };

  function detect() {
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === "en" || saved === "ru") return saved;
    } catch (e) { /* localStorage недоступен */ }
    return String(navigator.language || "en").toLowerCase().indexOf("ru") === 0 ? "ru" : "en";
  }

  var lang = detect();
  var textRec = new WeakMap();
  var attrRec = new WeakMap();
  var observer = null;

  function norm(s) { return s.replace(/\s+/g, " ").trim(); }

  function translate(text) {
    if (lang !== "ru") return null;
    var key = norm(text);
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(RU, key)) return RU[key];
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i][0].test(key)) return key.replace(RULES[i][0], RULES[i][1]);
    }
    return null;
  }

  function skipNode(node) {
    var p = node.parentNode;
    while (p && p.nodeType === 1) {
      if (SKIP[p.nodeName] || p.hasAttribute("data-no-i18n")) return true;
      p = p.parentNode;
    }
    return false;
  }

  function processText(node) {
    var cur = node.nodeValue;
    var rec = textRec.get(node);
    if (rec && cur === rec.tr) {
      if (lang === "en") { node.nodeValue = rec.en; textRec.delete(node); }
      return;
    }
    if (rec) textRec.delete(node);
    if (lang !== "ru" || !cur || skipNode(node)) return;
    var t = translate(cur);
    if (t === null) return;
    var out = cur.match(/^\s*/)[0] + t + cur.match(/\s*$/)[0];
    textRec.set(node, { en: cur, tr: out });
    node.nodeValue = out;
  }

  function processAttrs(el) {
    var rec = attrRec.get(el);
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute(a)) continue;
      var cur = el.getAttribute(a);
      var r = rec && rec[a];
      if (r && cur === r.tr) {
        if (lang === "en") { el.setAttribute(a, r.en); delete rec[a]; }
        continue;
      }
      if (r) delete rec[a];
      if (lang !== "ru" || el.hasAttribute("data-no-i18n")) continue;
      var t = translate(cur);
      if (t === null) continue;
      rec = rec || {};
      rec[a] = { en: cur, tr: t };
      attrRec.set(el, rec);
      el.setAttribute(a, t);
    }
  }

  function walk(root) {
    if (root.nodeType === 3) { processText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) processAttrs(root);
    var child = root.firstChild;
    while (child) {
      if (child.nodeType === 3) processText(child);
      else if (child.nodeType === 1 && !SKIP[child.nodeName]) walk(child);
      child = child.nextSibling;
    }
  }

  function applyAll() {
    walk(document.documentElement);
    if (document.title) {
      // <title> — обычный текстовый узел, walk его уже обработал
    }
    if (observer) observer.takeRecords();
  }

  function onMutations(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === "characterData") processText(r.target);
      else if (r.type === "attributes") processAttrs(r.target);
      else for (var j = 0; j < r.addedNodes.length; j++) walk(r.addedNodes[j]);
    }
    observer.takeRecords();
  }

  function setLang(next) {
    if (next !== "en" && next !== "ru") return;
    lang = next;
    try { localStorage.setItem(KEY, lang); } catch (e) { /* ignore */ }
    document.documentElement.lang = lang;
    applyAll();
    syncSwitches();
    try { window.dispatchEvent(new CustomEvent("linktalk:lang", { detail: { lang: lang } })); } catch (e) { /* ignore */ }
  }

  // ---- переключатель EN | RU
  var switches = [];
  function makeSwitch(extraClass) {
    var wrap = document.createElement("div");
    wrap.className = "lt-lang" + (extraClass ? " " + extraClass : "");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Language / Язык");
    wrap.setAttribute("data-no-i18n", "");
    ["en", "ru"].forEach(function (code) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("data-lang", code);
      b.textContent = code.toUpperCase();
      b.addEventListener("click", function () { setLang(code); });
      wrap.appendChild(b);
    });
    switches.push(wrap);
    return wrap;
  }
  function syncSwitches() {
    switches.forEach(function (wrap) {
      Array.prototype.forEach.call(wrap.querySelectorAll("button"), function (b) {
        var on = b.getAttribute("data-lang") === lang;
        b.setAttribute("aria-pressed", on ? "true" : "false");
        b.classList.toggle("is-on", on);
      });
    });
  }
  function mountSwitches() {
    var placed = 0;
    var spots = [
      [".admin-bar__actions", "prepend", ""],
      [".login-card", "prepend", "lt-lang--float"],
      [".settings-actions", "prepend", ""],
      [".about-page .about-head", "append", ""]
    ];
    spots.forEach(function (spot) {
      Array.prototype.forEach.call(document.querySelectorAll(spot[0]), function (host) {
        if (host.querySelector(":scope > .lt-lang")) return;
        var sw = makeSwitch(spot[2]);
        if (spot[1] === "prepend") host.insertBefore(sw, host.firstChild); else host.appendChild(sw);
        placed++;
      });
    });
    if (!placed) {
      var sw = makeSwitch("lt-lang--float lt-lang--corner");
      document.body.appendChild(sw);
    }
    syncSwitches();
  }

  // alert / confirm / prompt тоже переводим
  ["alert", "confirm", "prompt"].forEach(function (name) {
    var orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function (message) {
      var t = typeof message === "string" ? translate(message) : null;
      var args = Array.prototype.slice.call(arguments);
      if (t !== null) args[0] = t;
      return orig.apply(window, args);
    };
  });

  window.LinkTalkI18n = {
    get lang() { return lang; },
    setLang: setLang,
    t: function (text) { var t = translate(text); return t === null ? text : t; }
  };

  function init() {
    document.documentElement.lang = lang;
    mountSwitches();
    applyAll();
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
