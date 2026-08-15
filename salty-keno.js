// ==UserScript==
// Salty's Casino — KENO MODULE (Solo)
// Loaded via @require, after salty-core.js and salty-jackpot.js, by the
// main salty-casino.user.js loader. Registers itself into
// window.SaltyCore.GAME_MODULES.keno so it shows up automatically on the
// home grid.
//
// Structurally different from every other table here — no cards, no
// dealer, no hands. Pick 1 to 10 numbers ("spots") from a field of 80,
// the house draws 20, and your payout depends on how many of your picks
// get caught, scaled by how many spots you played. Real keno paytables
// carry a notoriously high house edge (roughly 20-35% depending on the
// table) — the multipliers below are tuned to land in that same range
// on purpose (verified against the exact hypergeometric probabilities,
// not eyeballed), so this plays true to the actual game instead of
// secretly being an easy bet with a keno coat of paint on it.
// ==/UserScript==
(function () {
  "use strict";

  const {
    MIN_BET, MAX_BET, GAME_MODULES, OVERLAY_ID,
    Balance, clamp, delay, fmt, chipColor, chipStyle, chipLabel,
    CHIP_DENOMS, toast,
  } = window.SaltyCore;

  const TOTAL_NUMBERS = 80;
  const NUMBERS_DRAWN = 20;
  const MAX_SPOTS = 10;
  const DRAW_BALL_MS = 140; // per-ball reveal pace during the draw animation

  // Multiplier paytable, keyed by how many spots you picked, then by how
  // many of those you caught. Values are multiples of your bet (e.g. a
  // 4 under "5 spots" means a 5-spot ticket that catches exactly 4 pays
  // 4x your bet). Anything not listed pays 0. The 10-spot ticket's
  // "catch 0" entry is a real, deliberate keno quirk carried over from
  // actual casino paytables — missing everything on a 10-spot ticket is
  // almost as rare as catching a lot of them, so it gets a small
  // consolation payout instead of paying nothing.
  //
  // Every tier here was checked against the exact hypergeometric
  // probability of each catch (80 numbers, 20 drawn) and lands between a
  // 22% and 34% house edge, matching real keno's published range. An
  // earlier draft of the 10-spot tier actually had a NEGATIVE house edge
  // (paid out more than it took in on average) — worth remembering if
  // these numbers ever get tuned again: always check the expected value
  // against the real draw odds, don't just eyeball "does this payout
  // feel big enough for how rare it is."
  const PAYTABLE = {
    1: { 1: 3 },
    2: { 2: 12 },
    3: { 2: 1, 3: 42 },
    4: { 2: 1, 3: 4, 4: 100 },
    5: { 3: 1, 4: 15, 5: 800 },
    6: { 3: 1, 4: 4, 5: 90, 6: 1600 },
    7: { 4: 2, 5: 20, 6: 400, 7: 5000 },
    8: { 5: 10, 6: 80, 7: 1500, 8: 10000 },
    9: { 5: 3, 6: 40, 7: 400, 8: 3000, 9: 20000 },
    10: { 0: 2, 5: 1, 6: 15, 7: 150, 8: 1500, 9: 3000, 10: 10000 },
  };

  const JACKPOT_SIDE_BET = 250_000; // same flat stake as every other table's qualifying bet
  const JACKPOT_TIER = "major"; // a full 10-of-10 catch is astronomically rare — biggest tier

  function fmtJackpot(n) {
    return (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function drawTwenty() {
    const pool = Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, NUMBERS_DRAWN);
  }

  function chipStackHtml(amount, opts = {}) {
    if (!amount || amount <= 0) return "";
    const size = opts.size || 24;
    const n = Math.min(4, Math.max(1, Math.round(Math.log10(Math.max(amount, 1)) - 0.5)));
    const color = chipColor(amount);
    const discs = Array.from({ length: n }, (_, i) => `
      <div class="chip-stack-disc" style="width:${size}px;height:${size}px;${i > 0 ? `margin-left:-${Math.round(size * 0.55)}px;` : ""}
        background:
          radial-gradient(circle at 32% 28%, rgba(255,255,255,.55), rgba(255,255,255,0) 42%),
          repeating-conic-gradient(from 0deg, ${color} 0deg 18deg, #ffffff26 18deg 22deg, ${color} 22deg 40deg),
          ${color};"></div>`).join("");
    return `<div class="chip-stack-wrap"><div class="chip-stack-discs">${discs}</div><div class="chip-stack-label">${fmt(amount)}</div></div>`;
  }

  function jackpotSpotHtml(active) {
    return `<div class="keno-jackpot-spot ${active ? "active" : ""}" id="keno-jackpot-toggle" title="Flat ${fmt(JACKPOT_SIDE_BET)} bet — required to collect the progressive jackpot, and only pays out on a perfect 10-spot catch">
      <div class="ov-bet-spot-label">💰 Jackpot</div>
      <div class="keno-jackpot-sub">${fmt(JACKPOT_SIDE_BET)} flat</div>
      ${active ? `<div class="ov-bet-spot-amt">ON</div>` : `<div class="ov-bet-spot-amt" style="color:var(--text-dim)">OFF</div>`}
    </div>`;
  }

  function rulesButtonRowHtml() {
    return `<div class="row" style="justify-content:flex-end;gap:6px;margin-bottom:6px">${soundToggleHtml()}<button class="btn small" id="saltys-keno-rules-btn">📖 House Rules</button></div>`;
  }
  function wireRulesButton(root) {
    const btn = root && root.querySelector("#saltys-keno-rules-btn");
    if (btn) btn.addEventListener("click", showRulesModal);
  }

  function paytableRowsHtml(spots) {
    const table = PAYTABLE[spots];
    if (!table) return "";
    const catches = Object.keys(table).map(Number).sort((a, b) => a - b);
    return catches.map((c) => `<div class="keno-pay-row"><span>Catch ${c}</span><span>${table[c]}x</span></div>`).join("");
  }

  function showRulesModal() {
    if (document.getElementById("saltys-keno-rules")) return;
    const el = document.createElement("div");
    el.id = "saltys-keno-rules";
    const allSpotsRows = Array.from({ length: MAX_SPOTS }, (_, i) => i + 1).map((n) => `
      <div class="keno-rules-spot-block">
        <div class="keno-rules-spot-title">${n} Spot${n > 1 ? "s" : ""}</div>
        <div class="keno-rules-paytable">${paytableRowsHtml(n) || `<div class="keno-pay-row"><span class="muted">No payout tier</span></div>`}</div>
      </div>
    `).join("");
    el.innerHTML = `
      <div class="box">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2>House Rules</h2>
          <button class="btn small" id="saltys-keno-rules-close-x">✕</button>
        </div>
        <div class="rules-body">
          <h3>How a round works</h3>
          <p>Pick between 1 and ${MAX_SPOTS} numbers ("spots") out of a field of ${TOTAL_NUMBERS}, then place your bet. The house draws ${NUMBERS_DRAWN} numbers at random. Your payout depends on two things: how many spots you picked, and how many of those picks got drawn (your "catch"). Every payout below is a multiple of your bet.</p>
          <h3>Why the payouts look the way they do</h3>
          <p>Keno carries one of the highest house edges of any casino game, typically 20&ndash;35% at real tables — nowhere close to blackjack or baccarat's edge. The multipliers here are built to land in that same range on purpose, so this plays true to the actual game instead of secretly being an easy bet with a keno coat of paint on it.</p>
          <h3>Paytable by spot count</h3>
          <div class="keno-rules-spot-grid">${allSpotsRows}</div>
          <h3>Progressive jackpot</h3>
          <p>0.05% of every wager placed at any table feeds one shared jackpot pool, whether or not you bet on it. <b>Collecting it is separate</b> — place the flat <b>Jackpot</b> bet (${fmt(JACKPOT_SIDE_BET)}) to be eligible that round. With it down, playing a full ${MAX_SPOTS}-spot ticket and catching <b>all ${MAX_SPOTS}</b> pays out a share of the shared pool, on top of your normal ${PAYTABLE[10][10]}x paytable payout for that catch. Without the Jackpot bet, a perfect catch still pays its normal amount — you just don't collect the extra. Like any other side bet, the Jackpot bet is lost if you don't hit a perfect catch on a full 10-spot ticket that round.</p>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:16px">
          <button class="btn primary" id="saltys-keno-rules-close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.querySelector("#saltys-keno-rules-close").addEventListener("click", close);
    el.querySelector("#saltys-keno-rules-close-x").addEventListener("click", close);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
  }

  const LS_SOUND_ENABLED = "saltys_keno_sound_enabled";
  function soundEnabled() {
    const v = localStorage.getItem(LS_SOUND_ENABLED);
    return v === null ? true : v === "1";
  }
  function setSoundEnabled(on) { localStorage.setItem(LS_SOUND_ENABLED, on ? "1" : "0"); }

  let audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return null; }
    return audioCtx;
  }
  // A short synthesized "ball drop" blip for each number as it's drawn —
  // same reasoning as every other table's dealing sound: no hosted audio
  // file to fetch, no CORS/host-uptime dependency.
  function playBallSound(isHit) {
    if (!soundEnabled()) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(isHit ? 880 : 520, now);
    osc.frequency.exponentialRampToValueAtTime(isHit ? 1320 : 400, now + 0.09);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(isHit ? 0.25 : 0.12, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  }
  function soundToggleHtml() {
    return `<button class="btn small" id="saltys-keno-sound-btn" title="Toggle draw sound">${soundEnabled() ? "🔊" : "🔇"}</button>`;
  }
  function wireSoundToggle(root, renderFn) {
    const btn = root && root.querySelector("#saltys-keno-sound-btn");
    if (btn) btn.addEventListener("click", () => { setSoundEnabled(!soundEnabled()); renderFn(); });
  }

  function ensureKenoSharedStyle() {
    if (document.getElementById("saltys-keno-shared-style")) return;
    const s = document.createElement("style");
    s.id = "saltys-keno-shared-style";
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700;800&family=JetBrains+Mono:wght@600;700;800&display=swap');

      #${OVERLAY_ID} .keno-board{
        display:grid; grid-template-columns:repeat(10, 1fr); gap:8px;
        max-width:640px; margin:0 auto; padding:18px;
        background:radial-gradient(ellipse at 50% 0%, var(--felt-line), var(--felt) 75%);
        border:8px solid #1a120a; border-radius:18px; box-shadow:inset 0 0 50px rgba(0,0,0,.4);
      }
      #${OVERLAY_ID} .keno-cell{
        aspect-ratio:1; border-radius:50%; border:2px solid rgba(212,175,55,.35);
        background:rgba(0,0,0,.25); color:var(--text); display:flex; align-items:center; justify-content:center;
        font:700 13px/1 "JetBrains Mono",monospace; cursor:pointer; transition:all .12s ease; user-select:none;
      }
      #${OVERLAY_ID} .keno-cell:hover{ border-color:var(--gold); transform:scale(1.08); }
      #${OVERLAY_ID} .keno-cell.picked{ background:var(--gold); border-color:var(--gold-bright); color:#1a1400; font-weight:800; }
      #${OVERLAY_ID} .keno-cell.drawn:not(.picked){ background:rgba(124,58,237,.35); border-color:var(--purple); color:#fff; }
      #${OVERLAY_ID} .keno-cell.hit{ background:var(--success); border-color:#1a3d28; color:#04150c; font-weight:800; box-shadow:0 0 10px rgba(47,191,113,.6); }
      #${OVERLAY_ID} .keno-cell.disabled{ cursor:default; opacity:.9; }

      #${OVERLAY_ID} .keno-drawn-strip{
        display:flex; gap:6px; flex-wrap:wrap; justify-content:center; max-width:640px; margin:12px auto 0; min-height:34px;
      }
      #${OVERLAY_ID} .keno-drawn-chip{
        width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center;
        font:700 11px/1 "JetBrains Mono",monospace; background:rgba(124,58,237,.35); border:2px solid var(--purple); color:#fff;
      }
      #${OVERLAY_ID} .keno-drawn-chip.hit{ background:var(--success); border-color:#1a3d28; color:#04150c; }

      #${OVERLAY_ID} .keno-panel{
        max-width:640px; margin:14px auto 0; display:flex; justify-content:space-between; align-items:center;
        flex-wrap:wrap; gap:10px; padding:10px 16px; background:var(--panel); border:1px solid var(--border); border-radius:12px;
      }
      #${OVERLAY_ID} .keno-paytable-live{ display:flex; gap:6px; flex-wrap:wrap; justify-content:center; max-width:640px; margin:10px auto 0; }
      #${OVERLAY_ID} .keno-pay-pill{
        font:700 11px/1 "JetBrains Mono",monospace; padding:5px 9px; border-radius:8px; background:var(--panel-2); border:1px solid var(--border); color:var(--text-dim);
      }
      #${OVERLAY_ID} .keno-pay-pill.hit{ background:var(--success); border-color:#1a3d28; color:#04150c; font-weight:800; }

      #${OVERLAY_ID} .keno-jackpot-spot{
        position:relative; width:78px; height:78px; border-radius:50%; cursor:pointer;
        background:radial-gradient(circle at 50% 35%, rgba(124,58,237,.3), #10261c 75%);
        border:2px dashed var(--purple); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
        transition:box-shadow .15s ease, border-color .15s ease, transform .15s ease;
      }
      #${OVERLAY_ID} .keno-jackpot-spot.active{ border-style:solid; border-color:var(--purple-bright); transform:translateY(-3px); box-shadow:0 0 0 3px rgba(124,58,237,.4); }
      #${OVERLAY_ID} .keno-jackpot-spot .ov-bet-spot-label{ color:var(--purple-bright); }
      #${OVERLAY_ID} .keno-jackpot-sub{ font:600 8px/1.2 "JetBrains Mono",monospace; color:var(--text-dim); text-align:center; padding:0 4px; }

      #${OVERLAY_ID} .keno-jackpot-banner{
        text-align:center; font:800 20px/1 "Oswald",sans-serif; letter-spacing:1px; color:var(--gold-bright);
        text-shadow:0 0 14px rgba(244,207,101,.5); margin-bottom:8px; transition:transform .15s ease;
      }
      #${OVERLAY_ID} .keno-jackpot-banner.pulse{ transform:scale(1.06); }

      #${OVERLAY_ID} .keno-round-summary{
        max-width:420px; margin:14px auto 0; background:rgba(10,14,10,.88); border:2px solid var(--gold);
        border-radius:16px; padding:14px 24px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,.6);
      }
      #${OVERLAY_ID} .keno-round-summary-headline{ font:800 24px/1 "Oswald",sans-serif; letter-spacing:1px; margin-bottom:8px; }
      #${OVERLAY_ID} .keno-round-summary.win .keno-round-summary-headline{ color:var(--success); }
      #${OVERLAY_ID} .keno-round-summary.lose .keno-round-summary-headline{ color:var(--danger); }

      #saltys-keno-rules{
        position:fixed; inset:0; z-index:100002; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.75); font:14px/1.6 Inter,system-ui,sans-serif;
      }
      #saltys-keno-rules .box{
        max-width:640px; max-height:82vh; overflow-y:auto; margin:20px; background:#12161d;
        border:1px solid #3a2c0f; border-radius:16px; padding:26px 24px; color:#f4f1ea;
      }
      #saltys-keno-rules h2{ margin:0; font:800 20px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; }
      #saltys-keno-rules h3{ margin:18px 0 6px; font:700 13px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; text-transform:uppercase; letter-spacing:.5px; }
      #saltys-keno-rules h3:first-of-type{ margin-top:6px; }
      #saltys-keno-rules p{ margin:0 0 8px; color:#c7cdd6; font-size:13px; }
      #saltys-keno-rules b{ color:#f4f1ea; }
      #saltys-keno-rules .keno-rules-spot-grid{ display:grid; grid-template-columns:repeat(2, 1fr); gap:10px; }
      #saltys-keno-rules .keno-rules-spot-block{ background:#161b22; border:1px solid #232a35; border-radius:10px; padding:8px 10px; }
      #saltys-keno-rules .keno-rules-spot-title{ font:700 12px/1 Oswald,sans-serif; color:#f4cf65; text-transform:uppercase; letter-spacing:.4px; margin-bottom:6px; }
      #saltys-keno-rules .keno-pay-row{ display:flex; justify-content:space-between; font:600 12px/1.6 "JetBrains Mono",monospace; color:#c7cdd6; }
      #saltys-keno-rules .keno-pay-row span:last-child{ color:#f4cf65; font-weight:700; }
    `;
    document.head.appendChild(s);
  }

  // =====================================================================
  // SOLO — one ticket per round. Keno doesn't have "hands" or a dealer
  // the way card games do, so there's no multi-seat pattern here; you
  // just pick your numbers and play as many rounds as you like.
  // =====================================================================
  const SoloKeno = (function () {
    let root = null, state = null, busy = false, chipScrollPos = 0;
    let jackpotUnsub = null, jackpotAmount = 0;

    function freshState() {
      return {
        phase: "betting", picked: [], bet: Math.min(100, MAX_BET), jackpotOn: false,
        drawn: [], revealed: [], lastResult: null,
      };
    }

    function togglePick(n) {
      if (state.phase !== "betting") return;
      const idx = state.picked.indexOf(n);
      if (idx >= 0) { state.picked.splice(idx, 1); render(); return; }
      if (state.picked.length >= MAX_SPOTS) { toast(`You can only pick up to ${MAX_SPOTS} spots.`); return; }
      state.picked.push(n);
      render();
    }

    function quickPick() {
      state.picked = [];
      const pool = Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      state.picked = pool.slice(0, MAX_SPOTS).sort((a, b) => a - b);
      render();
    }

    async function startDraw() {
      if (busy) return;
      if (state.picked.length < 1) { toast("Pick at least 1 number to play."); return; }
      if (!state.bet) { toast("Place a bet to play."); return; }
      const bet = clamp(Math.round(state.bet), MIN_BET, MAX_BET);
      const jp = state.jackpotOn ? JACKPOT_SIDE_BET : 0;
      const total = bet + jp;
      if (total > Balance.current) { toast("Not enough balance for that bet."); return; }
      busy = true; render();
      try {
        await Balance.applyDelta(-total, "solo_keno_bet");
        if (window.SaltyJackpot) window.SaltyJackpot.contribute(total, "keno");
      }
      catch (e) { toast("Bet failed."); busy = false; render(); return; }

      state.drawn = drawTwenty();
      state.revealed = [];
      state.phase = "drawing";
      render();

      for (const n of state.drawn) {
        state.revealed.push(n);
        const isHit = state.picked.includes(n);
        playBallSound(isHit);
        render();
        await delay(DRAW_BALL_MS);
      }

      await settle(bet, jp);
      busy = false;
    }

    async function settle(bet, jackpotStake) {
      state.phase = "settled";
      const spots = state.picked.length;
      const catches = state.picked.filter((n) => state.drawn.includes(n)).length;
      const table = PAYTABLE[spots] || {};
      const mult = table[catches] || 0;
      const mainWin = Math.round(bet * mult);

      let jackpotProfit = 0;
      let jackpotPayout = 0;
      if (jackpotStake > 0) {
        if (spots === MAX_SPOTS && catches === MAX_SPOTS && window.SaltyJackpot) {
          const jpPayout = await window.SaltyJackpot.award(JACKPOT_TIER, "keno", "Perfect catch: 10 of 10 spots", true);
          if (jpPayout > 0) {
            jackpotPayout = jackpotStake + jpPayout;
            jackpotProfit = jpPayout;
          } else {
            jackpotProfit = -jackpotStake;
          }
        } else {
          jackpotProfit = -jackpotStake;
        }
      }

      const roundPayout = mainWin + jackpotPayout;
      if (roundPayout > 0) await Balance.applyDelta(roundPayout, "solo_keno_settle");

      const mainProfit = mainWin - bet;
      state.lastResult = {
        spots, catches, mult, mainProfit, jackpotProfit,
        totalProfit: mainProfit + jackpotProfit,
      };
      render();
    }

    function render() {
      if (!root) return;
      ensureKenoSharedStyle();
      const jackpotBanner = `<div class="keno-jackpot-banner" id="keno-jackpot-banner">PROGRESSIVE JACKPOT: ${fmtJackpot(jackpotAmount)}</div>`;

      const spots = state.picked.length;
      const boardHtml = `<div class="keno-board">
        ${Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1).map((n) => {
          const picked = state.picked.includes(n);
          const drawn = state.revealed.includes(n);
          const hit = picked && drawn;
          const cls = ["keno-cell"];
          if (picked) cls.push("picked");
          if (drawn) cls.push("drawn");
          if (hit) cls.push("hit");
          if (state.phase !== "betting") cls.push("disabled");
          return `<div class="${cls.join(" ")}" data-num="${n}">${n}</div>`;
        }).join("")}
      </div>`;

      const drawnStripHtml = state.revealed.length ? `<div class="keno-drawn-strip">
        ${state.revealed.map((n) => `<div class="keno-drawn-chip ${state.picked.includes(n) ? "hit" : ""}">${n}</div>`).join("")}
      </div>` : "";

      const liveSpots = spots > 0 ? spots : null;
      const paytableLiveHtml = liveSpots && PAYTABLE[liveSpots] ? `<div class="keno-paytable-live">
        ${Object.entries(PAYTABLE[liveSpots]).sort((a, b) => a[0] - b[0]).map(([c, m]) => {
          const catches = state.phase === "settled" ? state.lastResult.catches : null;
          const hit = catches === Number(c);
          return `<div class="keno-pay-pill ${hit ? "hit" : ""}">Catch ${c}: ${m}x</div>`;
        }).join("")}
      </div>` : "";

      const summaryHtml = state.phase === "settled" && state.lastResult ? (() => {
        const r = state.lastResult;
        const cls = r.totalProfit > 0 ? "win" : r.totalProfit < 0 ? "lose" : "push";
        const headline = r.totalProfit > 0 ? "You Win" : r.totalProfit < 0 ? "You Lose" : "Push";
        return `<div class="keno-round-summary ${cls}">
          <div class="keno-round-summary-headline">${headline}</div>
          <div class="muted" style="margin-bottom:6px">Caught ${r.catches} of ${r.spots} · ${r.mult}x</div>
          <div class="ov-summary-line total"><span>Total</span><span>${r.totalProfit >= 0 ? "+" : ""}${fmt(r.totalProfit)}</span></div>
        </div>`;
      })() : "";

      let controlsHtml;
      if (state.phase === "betting") {
        controlsHtml = `
          <div class="keno-panel">
            <div class="row" style="gap:10px;align-items:center">
              ${chipStackHtml(state.bet)}
              <span class="muted">${spots} spot${spots === 1 ? "" : "s"} picked · max ${MAX_SPOTS}</span>
            </div>
            <div class="row" style="gap:8px">
              <button class="btn small" id="keno-quickpick">Quick Pick</button>
              <button class="btn small" id="keno-clear-picks">Clear Numbers</button>
              ${jackpotSpotHtml(state.jackpotOn)}
            </div>
          </div>
          <div class="ov-chip-rail">
            <div class="chip-select">
              ${CHIP_DENOMS.map((v) => `
                <div class="chip-btn" data-chip="${v}" ${busy ? "" : 'draggable="true"'} style="${chipStyle(v)}">
                  <span class="chip-face">${chipLabel(v)}</span>
                </div>
              `).join("")}
            </div>
            <div class="row center" style="gap:10px;flex-wrap:wrap">
              <button class="btn small gold" id="keno-bet-max" ${busy ? "disabled" : ""}>Max</button>
              <button class="btn small" id="keno-bet-clear-amt" ${busy ? "disabled" : ""}>Clear Bet</button>
              <button class="btn primary" id="keno-draw" ${busy || !spots || !state.bet ? "disabled" : ""}>Draw</button>
            </div>
          </div>`;
      } else if (state.phase === "drawing") {
        controlsHtml = `<div class="center muted mt16">Drawing… (${state.revealed.length}/${NUMBERS_DRAWN})</div>`;
      } else {
        controlsHtml = `<div class="row center mt16">
          <button class="btn primary" id="keno-rebet">Rebet ${fmt(state.bet)}${state.jackpotOn ? " + jackpot" : ""}</button>
          <button class="btn" id="keno-again">Change Numbers</button>
        </div>`;
      }

      root.innerHTML = jackpotBanner + rulesButtonRowHtml() + boardHtml + drawnStripHtml + paytableLiveHtml + summaryHtml + controlsHtml;
      wireRulesButton(root);
      wireSoundToggle(root, render);

      if (state.phase === "betting") {
        root.querySelectorAll("[data-num]").forEach((cell) => {
          cell.addEventListener("click", () => togglePick(parseInt(cell.dataset.num, 10)));
        });
        root.querySelector("#keno-quickpick").addEventListener("click", quickPick);
        root.querySelector("#keno-clear-picks").addEventListener("click", () => { state.picked = []; render(); });
        const jackpotToggle = root.querySelector("#keno-jackpot-toggle");
        if (jackpotToggle) jackpotToggle.addEventListener("click", () => {
          if (!state.jackpotOn && JACKPOT_SIDE_BET > Balance.current) {
            toast("Not enough balance for the jackpot bet.");
            return;
          }
          state.jackpotOn = !state.jackpotOn;
          render();
        });
        root.querySelectorAll("[data-chip]").forEach((chip) => {
          chip.addEventListener("click", () => {
            state.bet = clamp(state.bet + parseInt(chip.dataset.chip, 10), MIN_BET, MAX_BET);
            render();
          });
          chip.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", chip.dataset.chip);
            e.dataTransfer.effectAllowed = "copy";
            const ghost = chip.cloneNode(true);
            ghost.style.position = "absolute"; ghost.style.top = "-1000px"; ghost.style.left = "-1000px"; ghost.style.pointerEvents = "none";
            document.body.appendChild(ghost);
            e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
            setTimeout(() => ghost.remove(), 0);
          });
        });
        const chipSelect = root.querySelector(".chip-select");
        if (chipSelect) {
          chipSelect.scrollLeft = chipScrollPos;
          chipSelect.addEventListener("wheel", (e) => {
            if (chipSelect.scrollWidth <= chipSelect.clientWidth) return;
            e.preventDefault();
            chipSelect.scrollLeft += e.deltaY;
          }, { passive: false });
          chipSelect.addEventListener("scroll", () => { chipScrollPos = chipSelect.scrollLeft; });
        }
        root.querySelector("#keno-bet-max").addEventListener("click", () => {
          state.bet = clamp(Math.floor(Balance.current), MIN_BET, MAX_BET);
          render();
        });
        root.querySelector("#keno-bet-clear-amt").addEventListener("click", () => {
          state.bet = 0;
          render();
        });
        root.querySelector("#keno-draw").addEventListener("click", startDraw);
      } else if (state.phase === "settled") {
        root.querySelector("#keno-again").addEventListener("click", () => {
          const bet = state.bet, jp = state.jackpotOn;
          state = freshState();
          state.bet = bet;
          state.jackpotOn = jp;
          render();
        });
        root.querySelector("#keno-rebet").addEventListener("click", () => {
          const picked = state.picked, bet = state.bet, jp = state.jackpotOn;
          state = freshState();
          state.picked = picked;
          state.bet = bet;
          state.jackpotOn = jp;
          startDraw();
        });
      }
    }

    // Keno has no mid-round decision point (you either haven't bet yet,
    // or the draw is already fully committed and running to completion),
    // so unlike the card tables there's no "abandon and auto-resolve"
    // case to handle here — closing the tab mid-draw just stops the
    // animation; the bet was already debited and settle() still runs to
    // pay out correctly the moment the draw loop finishes, even with
    // root === null (render() just no-ops via its `if (!root) return;`
    // guard at the top).

    return {
      label: "Keno",
      icon: "🎱",
      order: 5,
      mount(el) {
        root = el;
        state = freshState();
        if (window.SaltyJackpot) {
          jackpotUnsub = window.SaltyJackpot.subscribe((pool) => {
            jackpotAmount = pool.amount;
            const el2 = document.getElementById("keno-jackpot-banner");
            if (el2) {
              el2.textContent = `PROGRESSIVE JACKPOT: ${fmtJackpot(jackpotAmount)}`;
              el2.classList.add("pulse");
              setTimeout(() => el2.classList.remove("pulse"), 500);
            }
          });
        }
        render();
        return () => {
          if (jackpotUnsub) jackpotUnsub();
          root = null;
        };
      },
    };
  })();

  window.SaltyCore.GAME_MODULES.keno = SoloKeno;
})();
