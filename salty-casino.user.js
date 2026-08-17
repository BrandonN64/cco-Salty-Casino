// ==UserScript==
// @name         Salty's Casino
// @namespace    saltys-casino
// @version      1.7.0
// @description  Adds a play-money casino (Blackjack, Baccarat, and a shared cross-game progressive jackpot) to the /games page — solo multi-hand Blackjack, Punto Banco Baccarat with squeeze dealing, and a jackpot pool fed by every table.
// @author       you
// @match        https://case-clicker.com/*
// @match        https://www.case-clicker.com/*
// @icon         https://case-clicker.com/favicon.ico
// @run-at       document-idle
// @grant        none
// @require      https://www.gstatic.com/firebasejs/12.16.0/firebase-app-compat.js
// @require      https://www.gstatic.com/firebasejs/12.16.0/firebase-auth-compat.js
// @require      https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore-compat.js
// ==/UserScript==
//
// MODULE LOADING — the actual game modules (core, jackpot, account,
// blackjack, baccarat, spanish21, three-card poker, mines, keno, ...) are
// NOT loaded via @require anymore. Instead, this script fetches a small
// version.json manifest from GitHub on every page load, compares it to
// the last-seen version cached in localStorage, and:
//   - if unchanged: replays the cached module source from localStorage —
//     one small network request total (the version.json check itself),
//     no re-downloading everything on every page load.
//   - if changed (or nothing cached yet): fetches every module listed in
//     the manifest fresh, executes them in order, and caches the new
//     source + version marker for next time.
//   - if GitHub is unreachable and nothing is cached yet: fails loudly
//     with a console error, since there's genuinely nothing to run.
//   - if GitHub is unreachable but something WAS cached from an earlier
//     session: runs that stale copy rather than breaking entirely.
//
// WHY: Tampermonkey's own @require caching runs on a completely separate
// lifecycle from its @version-based update checker. It only reliably
// re-fetches @require'd content when you resave this script in the
// dashboard, click "Update" in its Externals panel, or its periodic
// checker reinstalls the whole script from @updateURL — a plain page
// reload does NOT force any of that. Fetching our own small manifest on
// every load and deciding for ourselves whether to re-download sidesteps
// all of that uncertainty.
//
// Adding a new game later is now just editing version.json on GitHub
// (add the filename to "modules", bump "version") — nothing in this
// loader script needs to change for that.
//
// CSP NOTE: this uses plain fetch(), which — like Tampermonkey's own
// @require mechanism — has generally run outside the page's own CSP in
// every browser/Tampermonkey version this was tested against, since
// content-script-injected code typically isn't subject to the page's
// connect-src/script-src rules. If you ever see CSP-looking errors in the
// console specifically pointing at these fetch() calls (as opposed to
// Firebase's own network calls, which have a separate note below),
// switch @grant none to @grant GM_xmlhttpRequest above and swap fetch()
// for GM_xmlhttpRequest() in fetchManifest()/fetchModules() below — that
// call explicitly routes through the extension's own network layer,
// fully bypassing page CSP.
//
// Firebase's SDKs stay on @require above since Google hosts and versions
// those, not us — no freshness problem to solve there, and @require's
// caching is completely fine for a dependency that basically never
// changes. If you ever DO see CSP-looking errors from Firebase specifically
// (not from the module loader below), that's the same known issue —
// switching @grant none to @grant GM_xmlhttpRequest is the usual fix,
// since Tampermonkey then runs the script in an isolated world that's
// typically exempt from the page's CSP for its own requests, while still
// sharing the same DOM.
//
// If you'd rather test purely local copies while iterating, point
// REPO_BASE below at a file:// path instead (Firefox/Chrome both support
// this for fetch() from a userscript context, though Chrome needs "Allow
// access to file URLs" enabled for the Tampermonkey extension).

(function () {
  "use strict";

  const REPO_BASE = "https://raw.githubusercontent.com/BrandonN64/cco-Salty-Casino/main/";
  const LS_VERSION = "saltys-casino:module-version";
  const LS_SOURCE = "saltys-casino:module-source";

  async function fetchManifest() {
    const res = await fetch(`${REPO_BASE}version.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
    return res.json();
  }

  async function fetchModules(files) {
    const sources = await Promise.all(files.map(async (name) => {
      const res = await fetch(`${REPO_BASE}${name}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`${name} fetch failed: ${res.status}`);
      return res.text();
    }));
    return files.map((name, i) => ({ name, source: sources[i] }));
  }

  // Modules must execute in the exact order given (core before jackpot
  // before account/blackjack/baccarat/...), the same dependency ordering
  // @require used to guarantee. A freshly-appended, non-async inline
  // <script> executes synchronously the moment it's inserted into the
  // DOM — so a plain for-loop here preserves that ordering exactly the
  // same way a stack of @require lines did.
  function executeModules(modules) {
    for (const { name, source } of modules) {
      try {
        const script = document.createElement("script");
        script.textContent = source;
        script.dataset.saltysModule = name;
        document.head.appendChild(script);
        script.remove(); // already executed synchronously above; DOM node isn't needed after
      } catch (e) {
        console.error(`[Salty's Casino] Failed to execute ${name}:`, e);
      }
    }
  }

  async function loadModules() {
    let manifest = null;
    try {
      manifest = await fetchManifest();
    } catch (e) {
      console.warn("[Salty's Casino] Could not reach version manifest:", e);
    }

    const cachedVersion = localStorage.getItem(LS_VERSION);
    const cachedSourceRaw = localStorage.getItem(LS_SOURCE);

    // Fast path: manifest reachable and version unchanged — replay the
    // cached copy, no module re-downloads needed.
    if (manifest && manifest.version === cachedVersion && cachedSourceRaw) {
      try {
        executeModules(JSON.parse(cachedSourceRaw));
        return;
      } catch (e) {
        console.warn("[Salty's Casino] Cached module source was corrupt, re-fetching:", e);
      }
    }

    // Version changed, or no cache yet, or the cache was corrupt — fetch
    // everything fresh.
    if (manifest) {
      try {
        const modules = await fetchModules(manifest.modules);
        executeModules(modules);
        localStorage.setItem(LS_VERSION, manifest.version);
        localStorage.setItem(LS_SOURCE, JSON.stringify(modules));
        return;
      } catch (e) {
        console.error("[Salty's Casino] Fresh module fetch failed:", e);
      }
    }

    // Last resort: GitHub is unreachable right now (offline, rate-limited,
    // etc.) AND/OR the manifest fetch itself failed, but we do have some
    // previously cached copy from an earlier session — better to run
    // stale code than nothing at all.
    if (cachedSourceRaw) {
      console.warn("[Salty's Casino] Running last known cached modules (GitHub unreachable this load).");
      try { executeModules(JSON.parse(cachedSourceRaw)); }
      catch (e) { console.error("[Salty's Casino] Cached module source is corrupt and GitHub is unreachable — nothing to run.", e); }
    } else {
      console.error("[Salty's Casino] No modules available on this first load — check your network connection and try reloading.");
    }
  }

  // ---------------------------------------------------------------------
  // BOOTSTRAP — neither salty-core.js nor any game module calls itself.
  // Something has to load the modules, call initFirebase()/Balance.init()
  // once, create the overlay, and make sure the icon launcher is on the
  // page. That's this section's whole job.
  // ---------------------------------------------------------------------
  async function boot() {
    await loadModules();

    const SaltyCore = window.SaltyCore;
    if (!SaltyCore) { console.error("[Salty's Casino] SaltyCore failed to load — see any earlier [Salty's Casino] errors above for why."); return; }

    SaltyCore.initFirebase();
    SaltyCore.Balance.init();
    SaltyCore.updateView(); // builds the (hidden) overlay + wires the hashchange listener

    function tryInject() {
      SaltyCore.ensureIconLauncher();
    }
    tryInject();

    // case-clicker.com is client-rendered, so a one-time check on page load
    // isn't enough: SPA navigation via history.pushState/replaceState/
    // popstate doesn't trigger a full page (re)load at all. Cover both
    // that and general DOM churn, and just re-check on each — cheap since
    // ensureIconLauncher()/updateView() are both idempotent.
    function onNav() { tryInject(); SaltyCore.updateView(); }

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...args) { const r = origPush.apply(this, args); onNav(); return r; };
    history.replaceState = function (...args) { const r = origReplace.apply(this, args); onNav(); return r; };
    window.addEventListener("popstate", onNav);

    let debounceId = null;
    new window.MutationObserver(() => {
      clearTimeout(debounceId);
      debounceId = setTimeout(tryInject, 300);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
