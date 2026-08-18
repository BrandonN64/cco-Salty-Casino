// ==UserScript==
// Salty's Casino — ACCOUNT MODULE
// Loaded via @require, after salty-core.js, by the main salty-casino.user.js
// loader. Registers itself into window.SaltyCore.GAME_MODULES.account so
// it shows up on the home grid like any other game.
//
// Two things live here:
//
// 1. P/L TRACKER — reads Balance.subscribeStats() (see salty-core.js's
//    NOTE (STATS) comment), which is a running aggregate maintained
//    atomically inside every Balance.applyDelta() call. No extra reads,
//    no changes needed in any game file. Shows net P/L, total wagered,
//    total returned, rounds played, biggest single win, biggest single
//    bet, and a per-game breakdown table.
//
//    Honesty note: loss settlements never call applyDelta() at all in
//    these games (payout === 0 skips the call, since there's nothing to
//    credit), so a "biggest single loss" figure can't be derived from
//    this data without guessing — "Biggest Bet" is shown instead, which
//    IS cleanly derivable and still an interesting number.
//
// 2. CASE-CLICKER PROFILE SYNC — fetches api/auth/get-session, api/me,
//    and api/serverstats from case-clicker.com using the browser's own
//    live session (same-origin, so cookies attach automatically) every
//    time this page mounts, merges the result into players/{uid} in
//    Firestore, and displays name/rank/membership/casebattle_package
//    status alongside the P/L stats.
//
//    SECURITY: this NEVER stores or logs session.token — only
//    session.user.id / session.user.name are read out of the
//    get-session response. The token itself is a live credential and
//    has no reason to leave the browser it came from.
//
// FIX (Item A, account-page bleed): root / stats / statsUnsub /
// ccProfile / ccLoading used to be module-level `let` variables shared
// across every mount() call. Any mount whose cleanup didn't run through
// the exact switchTab()/goHome() path, or any async profile-sync
// callback resolving after a LATER mount had already reassigned `root`,
// could end up rendering into whatever panel `root` currently pointed
// to — which could belong to a different game. Fixed by giving every
// mount() call its own isolated `instance` object; nothing is shared
// across mounts anymore, so cross-mount/cross-game bleed is now
// structurally impossible, not just unlikely.
// ==/UserScript==
(function () {
  "use strict";

  const {
    OVERLAY_ID, Balance, fmt, toast,
    getDb, getUid, getAuthReady, isFirebaseConfigured,
  } = window.SaltyCore;

  const GAME_LABELS = {
    bj: "Blackjack", bac: "Baccarat", mines: "Mines", keno: "Keno",
    roulette: "Roulette", poker: "Poker", spanish21: "Spanish 21",
    casebattle: "Case Battle", jackpot: "Jackpot (side wins)", other: "Other",
  };
  function gameLabel(key) {
    return GAME_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Other");
  }

  function fmtSigned(n) {
    const v = Math.round(n || 0);
    return `${v >= 0 ? "+" : ""}${fmt(v)}`;
  }

  function ensureAccountStyle() {
    if (document.getElementById("saltys-account-style")) return;
    const s = document.createElement("style");
    s.id = "saltys-account-style";
    s.textContent = `
      #${OVERLAY_ID} .acct-cc-card{
        display:flex; align-items:center; gap:14px; padding:14px 18px;
        background:var(--panel); border:1px solid var(--border); border-radius:14px; margin-bottom:16px;
      }
      #${OVERLAY_ID} .acct-cc-name{ font:800 18px/1.2 "Oswald",sans-serif; }
      #${OVERLAY_ID} .acct-cc-sub{ color:var(--text-dim); font-size:12px; margin-top:2px; }
      #${OVERLAY_ID} .acct-cc-pills{ display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
      #${OVERLAY_ID} .acct-refresh-btn{ margin-left:auto; }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------
  // CASE-CLICKER PROFILE SYNC
  // ---------------------------------------------------------------------
  const CC_ORIGIN = "https://case-clicker.com";

  async function fetchCaseClickerProfile() {
    try {
      const [sessionRes, meRes, statsRes] = await Promise.all([
        fetch(`${CC_ORIGIN}/api/auth/get-session`, { credentials: "same-origin" }),
        fetch(`${CC_ORIGIN}/api/me`, { credentials: "same-origin" }),
        fetch(`${CC_ORIGIN}/api/serverstats`, { credentials: "omit" }),
      ]);
      const session = sessionRes.ok ? await sessionRes.json() : null;
      const me = meRes.ok ? await meRes.json() : null;
      const serverStats = statsRes.ok ? await statsRes.json() : null;
      return { session, me, serverStats };
    } catch (e) {
      console.warn("[Salty's Casino] Case-Clicker profile fetch failed:", e);
      return null;
    }
  }

  async function syncCaseClickerProfile() {
    // New accounts race Firebase's anonymous sign-in against this sync
    // firing on mount — getUid() is null until sign-in resolves, so wait
    // for it here rather than silently skipping the write.
    if (isFirebaseConfigured()) await getAuthReady();

    const data = await fetchCaseClickerProfile();
    if (!data) return null;

    const sessionUser = data.session && data.session.user ? data.session.user : null;
    const me = data.me || null;
    const hasCasebattlePackage = Boolean(
      me && Array.isArray(me.boughtPackages) && me.boughtPackages.includes("casebattle_package")
    );

    const profile = {
      ccUserId: sessionUser ? sessionUser.id : null,
      ccName: sessionUser ? sessionUser.name : null,
      ccImage: sessionUser ? sessionUser.image : null,
      ccMembership: me ? me.membership : null,
      ccRank: me ? me.rank : null,
      ccMoney: me ? me.money : null,
      ccTokens: me ? me.tokens : null,
      ccXp: me ? me.xp : null,
      ccNetworth: me ? me.networth : null,
      ccPremierRank: me ? me.premierRank : null,
      ccPremierRating: me ? me.premierRating : null,
      ccHasCasebattlePackage: hasCasebattlePackage,
      ccServerStatsId: data.serverStats ? data.serverStats._id : null,
      ccServerStats: data.serverStats || null,
      ccSyncedAt: Date.now(),
    };

    if (isFirebaseConfigured() && getUid()) {
      try {
        await getDb().collection("players").doc(getUid()).set({ caseClicker: profile }, { merge: true });
      } catch (e) {
        console.warn("[Salty's Casino] Failed to persist Case-Clicker profile:", e);
      }
    }
    return profile;
  }

  function ccProfileCardHtml(profile, loading) {
    if (loading) {
      return `<div class="acct-cc-card"><div class="muted">Syncing Case-Clicker profile…</div></div>`;
    }
    if (!profile || !profile.ccName) {
      return `<div class="acct-cc-card">
        <div class="col">
          <div class="acct-cc-name">Case-Clicker profile unavailable</div>
          <div class="acct-cc-sub">Couldn't reach case-clicker.com's session — make sure you're logged in and on the site, then try refreshing.</div>
        </div>
        <button class="btn small acct-refresh-btn" id="acct-cc-refresh">Retry</button>
      </div>`;
    }
    const pills = [];
    if (profile.ccMembership) pills.push(`<span class="pill ${profile.ccMembership === "pro" ? "win" : ""}">${profile.ccMembership}</span>`);
    if (profile.ccRank && profile.ccRank.name) pills.push(`<span class="pill">${profile.ccRank.name}${profile.ccRank.short ? ` (${profile.ccRank.short})` : ""}</span>`);
    pills.push(`<span class="pill ${profile.ccHasCasebattlePackage ? "win" : ""}">${profile.ccHasCasebattlePackage ? "Has" : "No"} Casebattle Package</span>`);
    return `<div class="acct-cc-card">
      ${profile.ccImage ? `<img class="acct-avatar" src="${profile.ccImage}" alt="">` : `<div class="acct-avatar"></div>`}
      <div class="col">
        <div class="acct-cc-name">${profile.ccName}</div>
        <div class="acct-cc-sub">
          ${profile.ccNetworth != null ? `Net worth: ${fmt(profile.ccNetworth)}` : ""}
          ${profile.ccTokens != null ? ` &middot; Tokens: ${fmt(profile.ccTokens)}` : ""}
          ${profile.ccXp != null ? ` &middot; XP: ${fmt(profile.ccXp)}` : ""}
        </div>
        <div class="acct-cc-pills">${pills.join("")}</div>
      </div>
      <button class="btn small acct-refresh-btn" id="acct-cc-refresh">Refresh</button>
    </div>`;
  }

  // ---------------------------------------------------------------------
  // ACCOUNT PAGE
  // ---------------------------------------------------------------------
  const AccountPage = (function () {
    function statCardHtml(label, value, cls) {
      return `<div class="acct-stat-card">
        <div class="acct-stat-label">${label}</div>
        <div class="acct-stat-value ${cls || ""}">${value}</div>
      </div>`;
    }

    function gameTableHtml(stats) {
      if (!stats || !stats.perGame || !Object.keys(stats.perGame).length) {
        return `<div class="muted center mt16">No rounds played yet — your per-game breakdown will show up here once you place a bet.</div>`;
      }
      const rows = Object.entries(stats.perGame)
        .sort((a, b) => b[1].totalWagered - a[1].totalWagered)
        .map(([key, g]) => {
          const netCls = g.netProfit > 0 ? "win" : g.netProfit < 0 ? "lose" : "";
          return `<tr>
            <td class="game-name">${gameLabel(key)}</td>
            <td>${fmt(g.totalWagered)}</td>
            <td>${fmt(g.totalReturned)}</td>
            <td class="${netCls}">${fmtSigned(g.netProfit)}</td>
            <td>${g.roundsPlayed}</td>
            <td>${g.biggestWin ? fmt(g.biggestWin.amount) : "—"}</td>
          </tr>`;
        }).join("");
      return `<table class="acct-game-table">
        <thead><tr>
          <th>Game</th><th>Wagered</th><th>Returned</th><th>Net</th><th>Rounds</th><th>Biggest Win</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

    // render() takes the instance explicitly and bails immediately if
    // that instance has been disposed or its root detached — this is
    // the guard that makes bleed impossible even if a caller ever
    // forgets to honor the returned unmount function.
    function render(instance) {
      if (instance.disposed || !instance.root) return;
      ensureAccountStyle();
      const s = instance.stats || { totalWagered: 0, totalReturned: 0, netProfit: 0, roundsPlayed: 0, biggestWin: null, biggestBet: null, perGame: {} };
      const netCls = s.netProfit > 0 ? "win" : s.netProfit < 0 ? "lose" : "";

      instance.root.innerHTML = `
        <div class="panel">
          ${ccProfileCardHtml(instance.ccProfile, instance.ccLoading)}
          <div class="acct-header">
            <div>
              <div class="title" style="font-size:20px">Your Stats</div>
              <div class="sub">Play-money profit/loss across every table &middot; live, updates as you play</div>
            </div>
          </div>
          <div class="acct-stat-grid">
            ${statCardHtml("Net P/L (all-time)", fmtSigned(s.netProfit), netCls)}
            ${statCardHtml("Total Wagered", fmt(s.totalWagered))}
            ${statCardHtml("Total Returned", fmt(s.totalReturned))}
            ${statCardHtml("Rounds Played", fmt(s.roundsPlayed))}
            ${statCardHtml("Biggest Single Win", s.biggestWin ? fmt(s.biggestWin.amount) : "—", "win")}
            ${statCardHtml("Biggest Single Bet", s.biggestBet ? fmt(s.biggestBet.amount) : "—")}
          </div>
          ${s.biggestWin ? `<div class="muted mt8" style="font-size:12px">Biggest win was on <b>${gameLabel(s.biggestWin.game)}</b> (${new Date(s.biggestWin.at).toLocaleDateString()})</div>` : ""}
          <div class="mt24">
            <div class="row" style="justify-content:space-between;align-items:center">
              <div class="title" style="font-size:16px">Per-Game Breakdown</div>
            </div>
            ${gameTableHtml(s)}
          </div>
        </div>
      `;

      const refreshBtn = instance.root.querySelector("#acct-cc-refresh");
      if (refreshBtn) refreshBtn.addEventListener("click", async () => {
        if (instance.disposed) return;
        instance.ccLoading = true;
        render(instance);
        const profile = await syncCaseClickerProfile();
        if (instance.disposed) return; // guard: mount torn down while the fetch was in flight
        instance.ccProfile = profile;
        instance.ccLoading = false;
        render(instance);
        if (profile && profile.ccName) toast("Case-Clicker profile synced.");
        else toast("Could not sync Case-Clicker profile.");
      });
    }

    return {
      label: "Account",
      icon: "👤",
      order: 0, // shows first on the home grid
      mount(el) {
        // Every mount gets its own isolated instance — no module-level
        // shared state. A stale instance from a previous mount can, at
        // worst, keep rendering into its OWN detached root (invisible,
        // harmless); it can never write into a different instance's DOM.
        const instance = {
          root: el, stats: Balance.statsCurrent, ccProfile: null,
          ccLoading: true, statsUnsub: null, disposed: false,
        };

        render(instance);

        instance.statsUnsub = Balance.subscribeStats((s) => {
          if (instance.disposed) return;
          instance.stats = s;
          render(instance);
        });

        // Fire the Case-Clicker sync on mount, not blocking initial render.
        // Guarded by instance.disposed so a slow response arriving after
        // this instance was torn down never touches the DOM.
        syncCaseClickerProfile().then((profile) => {
          if (instance.disposed) return;
          instance.ccProfile = profile;
          instance.ccLoading = false;
          render(instance);
        });

        return () => {
          instance.disposed = true;
          if (instance.statsUnsub) { instance.statsUnsub(); instance.statsUnsub = null; }
          instance.root = null;
        };
      },
    };
  })();

  window.SaltyCore.GAME_MODULES.account = AccountPage;
})();
