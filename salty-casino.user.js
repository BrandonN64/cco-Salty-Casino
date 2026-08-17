// ==UserScript==
// @name         Salty's Casino
// @namespace    saltys-casino
// @version      1.7.1
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
// NOT loaded via @require. Instead, this script:
//
//   1. Asks GitHub's API for the latest commit SHA on `main`
//      (api.github.com/repos/.../commits/main — this is the live API,
//      NOT behind the same caching layer as raw file downloads, so it's
//      always accurate).
//   2. Builds every raw.githubusercontent.com URL against that SHA
//      instead of the branch name "main".
//   3. Compares that SHA to the last one cached in localStorage — if
//      unchanged, replays the cached module source (one tiny API call
//      total, no re-downloading ~350KB of JS every page load). If
//      changed (or nothing cached yet), fetches every module fresh,
//      executes them in order, and caches the new source + SHA.
//
// WHY A COMMIT SHA INSTEAD OF A MANUALLY-BUMPED VERSION NUMBER: an
// earlier version of this loader compared a version string in
// version.json instead. That broke in practice — raw.githubusercontent.com
// is served through GitHub's Fastly CDN, which caches file content by
// path and does NOT include query strings in its cache key for this
// host. A cache-busting "?t=..." query param only defeats the *browser's*
// cache, not Fastly's edge cache — so pushing a new salty-core.js could
// still serve stale bytes for a while even with a fresh fetch, and the
// version-string approach required remembering to manually bump
// version.json on every single push (easy to forget, and we did).
//
// A specific commit SHA, by contrast, is IMMUTABLE — that exact URL's
// content can never change once committed, so Fastly can cache it
// forever with zero staleness risk. Resolving the SHA fresh via the API
// on every load, then treating a NEW sha as an automatic "something
// changed" signal, means there's no version number to remember to bump
// at all — every push is automatically detected.
//
// Adding a new game later is just editing version.json on GitHub (add
// the filename to "modules") and pushing — nothing in this loader script
// needs to change, and there's no version field to remember to touch.
//
// RATE LIMITS: the commit-SHA lookup hits GitHub's REST API, which caps
// unauthenticated requests at 60/hour per IP. That's one extra request
// per page load beyond the module downloads themselves — comfortably
// fine for normal personal use, but worth knowing if you're testing by
// reloading dozens of times in a short window.
//
// CSP NOTE: this uses plain fetch(), which — like Tampermonkey's own
// @require mechanism — has generally run outside the page's own CSP in
// every browser/Tampermonkey version this was tested against, since
// content-script-injected code typically isn't subject to the page's
// connect-src/script-src rules. If you ever see CSP-looking errors in the
// console specifically pointing at these fetch() calls, switch @grant
// none to @grant GM_xmlhttpRequest above and swap fetch() for
// GM_xmlhttpRequest() in the functions below — that call explicitly
// routes through the extension's own network layer, fully bypassing page
// CSP.
//
// Firebase's SDKs stay on @require above since Google hosts and versions
// those, not us — no freshness problem to solve there.

(function () {
  "use strict";

  const REPO = "BrandonN64/cco-Salty-Casino";
  const BRANCH = "main";
  const LS_SHA = "saltys-casino:module-sha";
  const LS_SOURCE = "saltys-casino:module-source";

  function rawBaseFor(sha) {
    return `https://raw.githubusercontent.com/${REPO}/${sha}/`;
  }

  async function fetchLatestSha() {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`commit lookup failed: ${res.status}`);
    const data = await res.json();
    if (!data.sha) throw new Error("commit lookup response had no sha");
    return data.sha;
  }

  async function fetchManifest(sha) {
    const res = await fetch(`${rawBaseFor(sha)}version.json`);
    if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
    return res.json();
  }

  async function fetchModules(sha, files) {
    const base = rawBaseFor(sha);
    const sources = await Promise.all(files.map(async (name) => {
      const res = await fetch(`${base}${name}`);
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
    let sha = null;
    try {
      sha = await fetchLatestSha();
    } catch (e) {
      console.warn("[Salty's Casino] Could not resolve latest commit SHA:", e);
    }

    const cachedSha = localStorage.getItem(LS_SHA);
    const cachedSourceRaw = localStorage.getItem(LS_SOURCE);

    // Fast path: SHA resolved and unchanged since last load — replay the
    // cached copy, no module re-downloads needed. Safe to trust
    // indefinitely, since a given SHA's content is permanent.
    if (sha && sha === cachedSha && cachedSourceRaw) {
      try {
        executeModules(JSON.parse(cachedSourceRaw));
        return;
      } catch (e) {
        console.warn("[Salty's Casino] Cached module source was corrupt, re-fetching:", e);
      }
    }

    // SHA changed, or no cache yet, or the cache was corrupt — fetch
    // everything fresh against the newly-resolved SHA.
    if (sha) {
      try {
        const manifest = await fetchManifest(sha);
        const modules = await fetchModules(sha, manifest.modules);
        executeModules(modules);
        localStorage.setItem(LS_SHA, sha);
        localStorage.setItem(LS_SOURCE, JSON.stringify(modules));
        return;
      } catch (e) {
        console.error("[Salty's Casino] Fresh module fetch failed:", e);
      }
    }

    // Last resort: GitHub's API is unreachable right now (offline, rate-
    // limited, etc.), but we do have some previously cached copy from an
    // earlier session — better to run stale code than nothing at all.
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
    if (typeof SaltyCore.ensureIconLauncher !== "function") {
      console.error("[Salty's Casino] SaltyCore loaded but ensureIconLauncher is missing — the fetched salty-core.js may be an outdated copy. Try clearing localStorage['saltys-casino:module-sha'] and localStorage['saltys-casino:module-source'], then reload.");
      return;
    }

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
