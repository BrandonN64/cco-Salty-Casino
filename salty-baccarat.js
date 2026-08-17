// ==UserScript==
// Salty's Casino — BACCARAT MODULE
// Loaded via @require, after salty-core.js and salty-jackpot.js, by the
// main salty-casino.user.js loader. Registers itself into
// window.SaltyCore.GAME_MODULES.baccarat so it shows up automatically on
// the home grid, next to Blackjack.
//
// Punto Banco baccarat, solo vs the house shoe:
//   - Standard Player / Banker / Tie betting circle (mutually exclusive —
//     placing on one clears the other two, since only one of them can
//     actually win a given round), plus a side-bet strip (Player Pair,
//     Perfect Pair, Banker Pair, Big, Small, and the Jackpot qualifying
//     bet, all in one row).
//   - Optional face-down dealing that actually feels like a live table:
//     one card is dealt face-down, YOU drag it open, THEN the next card
//     is dealt — not all cards dumped on the table at once with squeezing
//     as an afterthought. A "Reveal All" button skips the ritual and
//     fast-forwards the rest of the round for anyone who just wants the
//     result. The full round outcome is computed up front either way, so
//     settlement never depends on reveal order or timing — squeezing is
//     purely cosmetic pacing, never a real wait state.
//   - Feeds the shared cross-game progressive jackpot (window.SaltyJackpot)
//     with 0.05% of every wager placed here (main bets AND side bets,
//     including the jackpot bet itself). Collecting it, though, requires
//     placing a separate flat "Jackpot" side bet each round — exactly
//     like a real Caribbean Stud/Casino Hold'em progressive: everyone's
//     play grows the pool, only players who bought a shot at it that
//     round can win it.
// ==/UserScript==
(function () {
  "use strict";

  const {
    MIN_BET, MAX_BET, GAME_MODULES, OVERLAY_ID,
    Balance, Shoe, cardColor, SUIT_GLYPH, bacHandTotal,
    clamp, delay, fmt, chipColor, chipStyle, renderBetControls, wireBetControls, toast,
  } = window.SaltyCore;

  const DECK_COUNT = 8;
  const PENETRATION = 0.2;
  const BAC_DEAL_CARD_MS = 500; // pacing when face-down/squeeze mode is OFF

  const BANKER_COMMISSION = 0.05;

  // Flat, non-scaling qualifying bet for the progressive. Real tables use
  // a fixed amount rather than a percentage of your main wager, so it's
  // cheap to opt into every round regardless of bet size — but it still
  // has to feel like something. With chip denominations running up to
  // 1B and a typical wager around 10M, MIN_BET*5 (50) was invisible.
  // 250,000 lines up with one of the actual chip denominations (the pink
  // chip) so the flat stake reads as "a real chip," not a rounding error.
  const JACKPOT_SIDE_BET = 250_000;

  // The three main outcomes are mutually exclusive in this UI — only one
  // of Player/Banker/Tie can actually happen each round, so placing chips
  // on one clears any pending amount on the other two rather than letting
  // all three build up at once.
  const MAIN_BET_KEYS = ["player", "banker", "tie"];

  const PAYOUTS = {
    player: 1,
    banker: 1 - BANKER_COMMISSION,
    tie: 8,
    playerPair: 11,
    bankerPair: 11,
    perfectPair: 25,
    big: 0.54,
    small: 1.5,
  };

  function playerDraws(playerTotal) { return playerTotal <= 5; }
  function bankerDraws(bankerTotal, playerThirdValue) {
    if (playerThirdValue === null) return bankerTotal <= 5;
    if (bankerTotal <= 2) return true;
    if (bankerTotal === 7) return false;
    if (bankerTotal === 3) return playerThirdValue !== 8;
    if (bankerTotal === 4) return [2, 3, 4, 5, 6, 7].includes(playerThirdValue);
    if (bankerTotal === 5) return [4, 5, 6, 7].includes(playerThirdValue);
    if (bankerTotal === 6) return [6, 7].includes(playerThirdValue);
    return false;
  }
  function bacCardValue(c) { return c.r === "A" ? 1 : ["10", "J", "Q", "K"].includes(c.r) ? 0 : parseInt(c.r, 10); }
  function isPair(cards) { return cards.length >= 2 && cards[0].r === cards[1].r; }
  function isPerfectPair(cards) { return cards.length >= 2 && cards[0].r === cards[1].r && cards[0].s === cards[1].s; }

  function checkJackpot(result) {
    const playerPerfect = isPerfectPair(result.player);
    const bankerPerfect = isPerfectPair(result.banker);
    if (playerPerfect && bankerPerfect) {
      return { tier: "mega", detail: "Perfect Pair dealt to both Player and Banker" };
    }
    if (result.playerNatural && result.bankerNatural && result.playerTotal === 9 && result.bankerTotal === 9) {
      return { tier: "major", detail: "Natural 9-9 tie" };
    }
    if ((playerPerfect && result.playerNatural) || (bankerPerfect && result.bankerNatural)) {
      return { tier: "minor", detail: "Perfect Pair on the natural-winning hand" };
    }
    return null;
  }

  function fmtJackpot(n) {
    return (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    return `<div class="chip-stack-wrap"><div class="chip-stack-discs">${discs}</div>${opts.hideLabel ? "" : `<div class="chip-stack-label">${fmt(amount)}</div>`}</div>`;
  }

  function betSpotHtml(key, amount, active, label, small) {
    const size = small ? 62 : 92;
    const chipSize = small ? 15 : 22;
    const n = amount > 0 ? Math.min(4, Math.max(1, Math.round(Math.log10(Math.max(amount, 1)) - 0.5))) : 0;
    const pileHtml = Array.from({ length: n }, (_, i) => `
      <div class="bet-spot-chip" style="width:${chipSize}px;height:${chipSize}px;${i > 0 ? `margin-left:-${Math.round(chipSize * 0.5)}px;` : ""}${chipStyle(amount)}"></div>`).join("");
    return `<div class="ov-bet-spot ${active ? "active" : ""}" data-target="${key}" style="width:${size}px;height:${size}px" title="Click to select, then click or drag a chip here">
      <div class="ov-bet-spot-ring"></div>
      <div class="ov-bet-spot-label">${label}</div>
      ${amount > 0
        ? `<div class="bet-spot-pile">${pileHtml}</div><div class="ov-bet-spot-amt">${fmt(amount)}</div>`
        : ""}
    </div>`;
  }

  function tableBannerHtml() {
    const bankerPct = Math.round(PAYOUTS.banker * 100) / 100;
    return `
      <svg class="ov-banner" viewBox="0 0 440 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path id="ov-banner-arc-bac" d="M 15,52 Q 220,8 425,52" fill="none"/>
        <text class="ov-banner-main"><textPath href="#ov-banner-arc-bac" startOffset="50%" text-anchor="middle">BACCARAT — TIE PAYS ${PAYOUTS.tie} TO 1</textPath></text>
      </svg>
      <div class="ov-banner-sub">Banker wins pay ${bankerPct} to 1 (${Math.round(BANKER_COMMISSION * 100)}% commission)</div>
      <div class="ov-banner-sub2">Jackpot side bet required to collect the progressive</div>
    `;
  }

  function shoeDecorHtml() {
    return `
      <div class="ov-corner-deco ov-corner-left" aria-hidden="true">
        <div class="card back ov-mini-card" style="transform:rotate(-8deg)"></div>
        <div class="card back ov-mini-card" style="transform:rotate(-3deg);margin-left:-34px"></div>
        <div class="card back ov-mini-card" style="margin-left:-34px"></div>
      </div>
      <div class="ov-corner-deco ov-corner-right" aria-hidden="true">
        <div class="ov-discard-tray"></div>
      </div>
    `;
  }

  function rulesButtonRowHtml() {
    return `<div class="row" style="justify-content:flex-end;gap:6px;margin-bottom:6px">${soundToggleHtml()}${faceDownToggleHtml()}<button class="btn small" id="saltys-bac-rules-btn">📖 House Rules</button></div>`;
  }
  function wireRulesButton(root) {
    const btn = root && root.querySelector("#saltys-bac-rules-btn");
    if (btn) btn.addEventListener("click", showRulesModal);
  }

  function showRulesModal() {
    if (document.getElementById("saltys-bac-rules")) return;
    const el = document.createElement("div");
    el.id = "saltys-bac-rules";
    el.innerHTML = `
      <div class="box">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2>House Rules</h2>
          <button class="btn small" id="saltys-bac-rules-close-x">✕</button>
        </div>
        <div class="rules-body">
          <h3>How a round works</h3>
          <p>Place a bet on Player, Banker, or Tie (only one of the three at a time — side bets are separate and can be placed alongside it), then Player and Banker are each dealt two cards. Whichever hand is closer to 9 wins. A third card is drawn for one or both hands under a fixed set of rules — no decisions, just the tableau below.</p>

          <h3>Card values</h3>
          <p>Aces count as 1, number cards count as their number, and 10/J/Q/K all count as 0. A hand's total is the sum of its cards' values, keeping only the last digit (so 7+8=15 counts as 5).</p>

          <h3>Naturals</h3>
          <p>If either hand's first two cards total 8 or 9, that's a natural — both hands stand immediately with no further cards drawn.</p>

          <h3>Player's third card</h3>
          <p>If neither hand has a natural, Player draws a third card on a total of 0–5, and stands on 6 or 7.</p>

          <h3>Banker's third card</h3>
          <p>If Player stood, Banker draws on 0–5 and stands on 6–7, same as Player. If Player drew a third card, Banker's draw depends on Banker's own total and the value of Player's third card, per the standard tableau — Banker always draws on 0–2, always stands on 7, and follows a fixed table for 3 through 6.</p>

          <h3>Payouts</h3>
          <p><b>Player</b> pays ${PAYOUTS.player}:1. <b>Banker</b> pays ${PAYOUTS.banker}:1 (a ${Math.round(BANKER_COMMISSION * 100)}% commission is baked into the price). <b>Tie</b> pays ${PAYOUTS.tie}:1; if you bet Player or Banker and the hand ties, that bet pushes (returned, no profit) instead of losing.</p>

          <h3>Side bets</h3>
          <p><b>Player Pair / Banker Pair</b> — pays ${PAYOUTS.playerPair}:1 if that hand's first two cards share a rank.</p>
          <p><b>Perfect Pair</b> — pays ${PAYOUTS.perfectPair}:1 if either hand's first two cards are an exact suited pair (same rank and suit).</p>
          <p><b>Big</b> — pays ${PAYOUTS.big}:1 if the round deals 5 or 6 cards total (and isn't a tie). <b>Small</b> — pays ${PAYOUTS.small}:1 if the round deals exactly 4 cards total.</p>

          <h3>Face-down dealing</h3>
          <p>Turn on "Face-Down" and cards come out one at a time, back-up — drag from a card's top-left corner to peel it open before the next one is dealt, just like a real table's squeeze. The whole round's outcome is already decided the instant Deal is pressed; revealing a card only controls when you personally see it, so there's never a real wait — and "Reveal All" fast-forwards through the rest of the ritual any time you want.</p>

          <h3>Progressive jackpot</h3>
          <p>0.05% of every wager placed here (and at the Blackjack tables) feeds one shared jackpot pool, whether or not you bet on it. <b>Collecting it is a separate matter</b> — just like a real casino progressive (Caribbean Stud, Casino Hold'em, progressive Blackjack side bets), you must place the flat <b>Jackpot</b> bet (${fmt(JACKPOT_SIDE_BET)}) on a given round to be eligible to win it that round. Without it, hitting a jackpot-tier hand pays nothing extra — the same way missing a side bet you didn't place doesn't pay you.</p>
          <p>With the Jackpot bet down, the pool pays out on baccarat's rarest hands: a Perfect Pair dealt to <b>both</b> Player and Banker (Mega — the full pool), a natural 9-9 tie (Major — 25% of the pool), or a Perfect Pair on the hand that wins with a natural (Minor — 5% of the pool). Like any other side bet, the Jackpot bet itself is lost on rounds where none of these hit.</p>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:16px">
          <button class="btn primary" id="saltys-bac-rules-close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.querySelector("#saltys-bac-rules-close").addEventListener("click", close);
    el.querySelector("#saltys-bac-rules-close-x").addEventListener("click", close);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
  }

  const LS_SOUND_ENABLED = "saltys_bac_sound_enabled";
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
  function playDealSound() {
    if (!soundEnabled()) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => { });
    const now = ctx.currentTime;
    function noiseBuffer(durSec) {
      const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * durSec)), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    }
    function fireLayer(startAt, durSec, filterType, freqStart, freqEnd, peakGain, attackSec) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(durSec);
      const filter = ctx.createBiquadFilter();
      filter.type = filterType;
      filter.Q.value = 1.1;
      filter.frequency.setValueAtTime(freqStart, startAt);
      if (freqEnd !== freqStart) filter.frequency.exponentialRampToValueAtTime(freqEnd, startAt + durSec);
      const gain = ctx.createGain();
      if (attackSec) {
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.linearRampToValueAtTime(peakGain, startAt + attackSec);
      } else {
        gain.gain.setValueAtTime(peakGain, startAt);
      }
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durSec);
      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start(startAt);
      src.stop(startAt + durSec + 0.01);
    }
    fireLayer(now, 0.012, "highpass", 4500, 4500, 0.4, 0);
    fireLayer(now + 0.006, 0.05, "bandpass", 3200, 1400, 0.22, 0.008);
    fireLayer(now + 0.04, 0.02, "lowpass", 900, 900, 0.18, 0);
  }
  function soundToggleHtml() {
    return `<button class="btn small" id="saltys-bac-sound-btn" title="Toggle dealing sound">${soundEnabled() ? "🔊" : "🔇"}</button>`;
  }
  function wireSoundToggle(root, renderFn) {
    const btn = root && root.querySelector("#saltys-bac-sound-btn");
    if (btn) btn.addEventListener("click", () => { setSoundEnabled(!soundEnabled()); renderFn(); });
  }

  const LS_FACEDOWN_ENABLED = "saltys_bac_facedown_enabled";
  function faceDownEnabled() { return localStorage.getItem(LS_FACEDOWN_ENABLED) === "1"; }
  function setFaceDownEnabled(on) { localStorage.setItem(LS_FACEDOWN_ENABLED, on ? "1" : "0"); }
  function faceDownToggleHtml() {
    return `<button class="btn small" id="saltys-bac-facedown-btn" title="Toggle face-down dealing">${faceDownEnabled() ? "🂠 Face-Down: On" : "🂠 Face-Down: Off"}</button>`;
  }
  function wireFaceDownToggle(root, renderFn) {
    const btn = root && root.querySelector("#saltys-bac-facedown-btn");
    if (btn) btn.addEventListener("click", () => { setFaceDownEnabled(!faceDownEnabled()); renderFn(); });
  }

  function ensureBaccaratSharedStyle() {
    if (document.getElementById("saltys-bac-shared-style")) return;
    const s = document.createElement("style");
    s.id = "saltys-bac-shared-style";
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700;800&family=JetBrains+Mono:wght@600;700;800&display=swap');

      #${OVERLAY_ID} .bac-card-deal{ animation: bacDealIn .35s ease-out; }
      @keyframes bacDealIn{ from { transform: translateY(-30px) rotate(-8deg); opacity:0; } to { transform:none; opacity:1; } }

      #${OVERLAY_ID} .bac-hands{ display:flex; justify-content:space-around; align-items:flex-start; margin-top:10%; gap:24px; }
      #${OVERLAY_ID} .bac-hand{ display:flex; flex-direction:column; align-items:center; gap:6px; }
      #${OVERLAY_ID} .bac-hand-label{ font:700 13px/1 "Oswald",sans-serif; letter-spacing:1px; text-transform:uppercase; color:var(--text-dim); }
      #${OVERLAY_ID} .bac-hand-total{
        width:44px; height:44px; border-radius:50%; border:3px solid var(--gold);
        display:flex; align-items:center; justify-content:center; font-weight:800; font-size:16px; margin-top:4px;
      }
      #${OVERLAY_ID} .bac-hand-total.hidden-total{ border-color:var(--border); color:var(--text-dim); font-size:11px; }
      #${OVERLAY_ID} .bac-hand-cards{ display:flex; gap:6px; min-height:96px; }
      #${OVERLAY_ID} .bac-hand-cards .card{ position:relative; }
      #${OVERLAY_ID} .bac-win-badge{
        font:700 11px/1 "Oswald",sans-serif; text-transform:uppercase; letter-spacing:.5px;
        padding:2px 10px; border-radius:5px; margin-top:2px; background:var(--panel-2);
      }
      #${OVERLAY_ID} .bac-win-badge.win{ color:var(--success); }
      #${OVERLAY_ID} .bac-win-badge.lose{ color:var(--danger); }
      #${OVERLAY_ID} .bac-win-badge.push{ color:var(--text-dim); }

      /* --- corner-drag face-down reveal --- */
      #${OVERLAY_ID} .bac-squeeze-wrap{ width:68px; height:96px; perspective:700px; touch-action:none; }
      #${OVERLAY_ID} .bac-squeeze-inner{ position:relative; width:100%; height:100%; transform-style:preserve-3d; transition:transform .3s cubic-bezier(.2,.8,.2,1); }
      #${OVERLAY_ID} .bac-squeeze-face{ position:absolute; inset:0; border-radius:9px; backface-visibility:hidden; box-shadow:0 3px 8px rgba(0,0,0,.4); }
      #${OVERLAY_ID} .bac-squeeze-front{ background:#fdfbf5; color:#111; display:flex; flex-direction:column; justify-content:space-between; padding:6px 7px; font:800 17px/1 "JetBrains Mono",ui-monospace,monospace; }
      #${OVERLAY_ID} .bac-squeeze-front.red{ color:var(--red); }
      #${OVERLAY_ID} .bac-squeeze-back{
        background:repeating-linear-gradient(135deg, var(--purple), var(--purple) 6px, #241a3d 6px, #241a3d 12px);
        border:1px solid #0006;
      }
      #${OVERLAY_ID} .bac-squeeze-corner{
        position:absolute; top:0; left:0; width:26px; height:26px; cursor:grab; z-index:5;
        border-top-left-radius:9px; background:radial-gradient(circle at 20% 20%, rgba(244,207,101,.35), transparent 70%);
      }
      #${OVERLAY_ID} .bac-squeeze-corner:active{ cursor:grabbing; }
      #${OVERLAY_ID} .bac-squeeze-wrap.revealed .bac-squeeze-corner{ pointer-events:none; opacity:0; }

      #${OVERLAY_ID} .bac-sidebet-strip{ display:flex; gap:10px; justify-content:center; flex-wrap:wrap; margin:10px 0; }
      #${OVERLAY_ID} .bac-side-spot{
        position:relative; width:100px; height:70px; border-radius:12px; cursor:pointer;
        background:radial-gradient(circle at 50% 40%, #10261c, #0b1a13 75%);
        border:2px dashed var(--gold); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
        transition:box-shadow .15s ease, border-color .15s ease, transform .15s ease;
      }
      #${OVERLAY_ID} .bac-side-spot.active{ border-style:solid; border-color:var(--gold-bright); transform:translateY(-2px); box-shadow:0 0 0 3px rgba(212,175,55,.3); }
      #${OVERLAY_ID} .bac-side-label{ font:700 10px/1.2 "Oswald",sans-serif; text-transform:uppercase; letter-spacing:.4px; color:var(--text-dim); text-align:center; }
      #${OVERLAY_ID} .bac-side-pay{ font:600 9px/1 "JetBrains Mono",monospace; color:var(--text-dim); }
      #${OVERLAY_ID} .bac-side-amt{ font:700 11px/1.2 "JetBrains Mono",monospace; color:var(--gold-bright); }

      /* --- jackpot qualifying bet: lives inside the same side-bet strip
             now (rather than a separate row below it) so the whole betting
             area reads as one cohesive block; purple accent keeps it
             visually distinct from the payout side bets next to it since
             it buys eligibility rather than paying on its own condition --- */
      #${OVERLAY_ID} .bac-jackpot-spot{
        position:relative; width:110px; height:74px; border-radius:12px; cursor:pointer;
        background:radial-gradient(circle at 50% 35%, rgba(124,58,237,.28), #10261c 75%);
        border:2px dashed var(--purple); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
        transition:box-shadow .15s ease, border-color .15s ease, transform .15s ease;
      }
      #${OVERLAY_ID} .bac-jackpot-spot.active{ border-style:solid; border-color:var(--purple-bright); transform:translateY(-2px); box-shadow:0 0 0 3px rgba(124,58,237,.4); }
      #${OVERLAY_ID} .bac-jackpot-spot .bac-side-label{ color:var(--purple-bright); }

      #${OVERLAY_ID} .bac-jackpot-banner{
        text-align:center; font:800 20px/1 "Oswald",sans-serif; letter-spacing:1px; color:var(--gold-bright);
        text-shadow:0 0 14px rgba(244,207,101,.5); margin-bottom:8px; transition:transform .15s ease;
      }
      #${OVERLAY_ID} .bac-jackpot-banner.pulse{ transform:scale(1.06); }

      #saltys-bac-rules{
        position:fixed; inset:0; z-index:100002; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.75); font:14px/1.6 Inter,system-ui,sans-serif;
      }
      #saltys-bac-rules .box{
        max-width:560px; max-height:82vh; overflow-y:auto; margin:20px; background:#12161d;
        border:1px solid #3a2c0f; border-radius:16px; padding:26px 24px; color:#f4f1ea;
      }
      #saltys-bac-rules h2{ margin:0; font:800 20px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; }
      #saltys-bac-rules h3{ margin:18px 0 6px; font:700 13px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; text-transform:uppercase; letter-spacing:.5px; }
      #saltys-bac-rules h3:first-of-type{ margin-top:6px; }
      #saltys-bac-rules p{ margin:0 0 8px; color:#c7cdd6; font-size:13px; }
      #saltys-bac-rules b{ color:#f4f1ea; }
    `;
    document.head.appendChild(s);
  }

  const BaccaratSolo = (function () {
    let root = null, shoe = null, state = null, busy = false, jackpotUnsub = null, jackpotAmount = 0;
    let chipScrollPos = 0; // survives the innerHTML rebuild that would otherwise reset it to 0 on every bet
    let skipSqueeze = false; // set by "Reveal All" mid-round to fast-forward remaining cards
    const dealtAnimated = new Set();
    const revealWaiters = new Map(); // card._key -> resolve fn, only populated while a live-style deal is blocked on that card

    function freshState() {
      return {
        phase: "betting",
        bets: { player: 0, banker: 0, tie: 0, playerPair: 0, bankerPair: 0, perfectPair: 0, big: 0, small: 0 },
        jackpotBet: false,
        activeBetTarget: "player",
        selectedChip: 100,
        player: [], banker: [], playerTotal: 0, bankerTotal: 0,
        playerNatural: false, bankerNatural: false, winner: null,
        revealedKeys: new Set(),
        lastResult: null,
        lastOpeningBet: null,
      };
    }

    function totalWager() {
      return Object.values(state.bets).reduce((a, b) => a + b, 0) + (state.jackpotBet ? JACKPOT_SIDE_BET : 0);
    }

    function clearOtherMainBets(keptKey) {
      MAIN_BET_KEYS.forEach((k) => { if (k !== keptKey) state.bets[k] = 0; });
    }

    function waitForReveal(cardKey) {
      return new Promise((resolve) => { revealWaiters.set(cardKey, resolve); });
    }

    async function startDeal() {
      if (busy) return;
      const wager = totalWager();
      if (wager <= 0) { toast("Place a bet first."); return; }
      if (wager > Balance.current) { toast("Not enough balance for that bet."); return; }
      busy = true; render();
      try {
        await Balance.applyDelta(-wager, "solo_bac_deal");

        // Snapshot the opening layout only after the debit succeeds.
        // Never derive rebet from settled results or final card state.
        state.lastOpeningBet = {
          bets: { ...state.bets },
          jackpotBet: state.jackpotBet,
        };
      } catch (e) {
        toast("Bet failed.");
        busy = false;
        render();
        return;
      }

      if (window.SaltyJackpot) window.SaltyJackpot.contribute(wager, "baccarat");

      if (!shoe) shoe = new Shoe(DECK_COUNT, PENETRATION);
      dealtAnimated.clear();
      revealWaiters.clear();
      skipSqueeze = false;
      state.player = []; state.banker = [];
      state.revealedKeys = new Set();
      state.lastResult = null;

      const liveStyle = faceDownEnabled();
      state.phase = liveStyle ? "revealing" : "dealing";
      render();

      // Dealing pace: normal mode just animates in with a short delay
      // between cards, same as before. Live/face-down mode deals exactly
      // one card, waits for YOU to drag it open, then deals the next —
      // the whole point of turning the setting on — unless "Reveal All"
      // has been clicked, at which point skipSqueeze fast-forwards
      // everything still left in this round.
      const draw = async (hand) => {
        const card = shoe.draw();
        state[hand].push(card);
        render();
        playDealSound();
        if (liveStyle && !skipSqueeze) {
          await waitForReveal(card._key);
        } else {
          await delay(BAC_DEAL_CARD_MS);
        }
        return card;
      };

      await draw("player");
      await draw("banker");
      await draw("player");
      await draw("banker");

      let playerThirdValue = null;
      const playerNatural = bacHandTotal(state.player) >= 8;
      const bankerNatural = bacHandTotal(state.banker) >= 8;
      if (!playerNatural && !bankerNatural) {
        if (playerDraws(bacHandTotal(state.player))) {
          const card = await draw("player");
          playerThirdValue = bacCardValue(card);
        }
        if (bankerDraws(bacHandTotal(state.banker), playerThirdValue)) {
          await draw("banker");
        }
      }

      const playerTotal = bacHandTotal(state.player);
      const bankerTotal = bacHandTotal(state.banker);
      let winner = "tie";
      if (playerTotal > bankerTotal) winner = "player";
      else if (bankerTotal > playerTotal) winner = "banker";

      state.playerTotal = playerTotal;
      state.bankerTotal = bankerTotal;
      state.playerNatural = playerNatural;
      state.bankerNatural = bankerNatural;
      state.winner = winner;

      await settle();

      if (!liveStyle) {
        state.player.forEach((c) => state.revealedKeys.add(c._key));
        state.banker.forEach((c) => state.revealedKeys.add(c._key));
      }
      state.phase = "settled";
      busy = false;
      render();
    }

    function restoreOpeningBet(snapshot, multiplier = 1) {
      if (!snapshot) return false;

      Object.keys(state.bets).forEach((key) => {
        state.bets[key] = clamp(
          Math.round((snapshot.bets[key] || 0) * multiplier),
          0,
          MAX_BET
        );
      });

      // Jackpot is a fixed qualifying stake, not a variable wager.
      // Preserve whether it was enabled, but do not double its amount.
      state.jackpotBet = snapshot.jackpotBet;
      state.activeBetTarget = "player";
      return true;
    }

    async function rebet(multiplier = 1) {
      if (busy || !state.lastOpeningBet) return;

      if (!restoreOpeningBet(state.lastOpeningBet, multiplier)) return;

      const wager = totalWager();
      if (wager > Balance.current) {
        toast(`Not enough balance to ${multiplier === 2 ? "double and rebet" : "rebet"}.`);
        return;
      }

      await startDeal();
    }

    async function settle() {
      const result = {
        player: state.player, banker: state.banker,
        playerTotal: state.playerTotal, bankerTotal: state.bankerTotal,
        playerNatural: state.playerNatural, bankerNatural: state.bankerNatural,
        winner: state.winner, cardCount: state.player.length + state.banker.length,
      };
      const bets = state.bets;
      let winnings = 0;
      const lines = [];

      if (result.winner === "player") {
        if (bets.player) { const w = bets.player * (1 + PAYOUTS.player); winnings += w; lines.push(["Player", w - bets.player]); }
        if (bets.banker) lines.push(["Banker", -bets.banker]);
      } else if (result.winner === "banker") {
        if (bets.banker) { const w = bets.banker * (1 + PAYOUTS.banker); winnings += w; lines.push(["Banker", w - bets.banker]); }
        if (bets.player) lines.push(["Player", -bets.player]);
      } else {
        if (bets.player) { winnings += bets.player; lines.push(["Player (push)", 0]); }
        if (bets.banker) { winnings += bets.banker; lines.push(["Banker (push)", 0]); }
        if (bets.tie) { const w = bets.tie * (1 + PAYOUTS.tie); winnings += w; lines.push(["Tie", w - bets.tie]); }
      }
      if (bets.tie && result.winner !== "tie") lines.push(["Tie", -bets.tie]);

      if (bets.playerPair) {
        if (isPair(result.player)) { const w = bets.playerPair * (1 + PAYOUTS.playerPair); winnings += w; lines.push(["Player Pair", w - bets.playerPair]); }
        else lines.push(["Player Pair", -bets.playerPair]);
      }
      if (bets.bankerPair) {
        if (isPair(result.banker)) { const w = bets.bankerPair * (1 + PAYOUTS.bankerPair); winnings += w; lines.push(["Banker Pair", w - bets.bankerPair]); }
        else lines.push(["Banker Pair", -bets.bankerPair]);
      }
      if (bets.perfectPair) {
        if (isPerfectPair(result.player) || isPerfectPair(result.banker)) { const w = bets.perfectPair * (1 + PAYOUTS.perfectPair); winnings += w; lines.push(["Perfect Pair", w - bets.perfectPair]); }
        else lines.push(["Perfect Pair", -bets.perfectPair]);
      }
      if (bets.big) {
        if (result.winner !== "tie" && result.cardCount >= 5) { const w = bets.big * (1 + PAYOUTS.big); winnings += w; lines.push(["Big", w - bets.big]); }
        else lines.push(["Big", -bets.big]);
      }
      if (bets.small) {
        if (result.winner !== "tie" && result.cardCount === 4) { const w = bets.small * (1 + PAYOUTS.small); winnings += w; lines.push(["Small", w - bets.small]); }
        else lines.push(["Small", -bets.small]);
      }

      const hit = checkJackpot(result);
      let jackpotPayout = 0, jackpotTier = null;
      if (state.jackpotBet) {
        if (hit && window.SaltyJackpot) {
          jackpotPayout = await window.SaltyJackpot.award(hit.tier, "baccarat", hit.detail, true);
          jackpotTier = hit.tier;
          if (jackpotPayout > 0) {
            winnings += JACKPOT_SIDE_BET;
            lines.push(["Jackpot bet", JACKPOT_SIDE_BET]);
          } else {
            lines.push(["Jackpot bet", -JACKPOT_SIDE_BET]);
          }
        } else {
          lines.push(["Jackpot bet", -JACKPOT_SIDE_BET]);
        }
      } else if (hit) {
        lines.push([`Jackpot hand (${hit.tier}) — no Jackpot bet placed`, 0]);
      }

      if (winnings > 0) await Balance.applyDelta(winnings, "solo_bac_settle");

      const totalProfit = lines.reduce((a, [, p]) => a + p, 0);
      state.lastResult = { lines, totalProfit, jackpotPayout, jackpotTier };
    }

    function cardEl(c, hidden, faceDown) {
      if (hidden) return `<div class="card back" data-key="hidden"></div>`;
      const isNew = c._key != null && !dealtAnimated.has(c._key);
      if (isNew) dealtAnimated.add(c._key);
      const animClass = isNew ? "bac-card-deal" : "";

      if (!faceDown) {
        return `<div class="card ${cardColor(c)} ${animClass}" data-key="${c._key ?? ""}"><span>${c.r}</span><span class="br">${SUIT_GLYPH[c.s]}</span></div>`;
      }
      const revealed = state.revealedKeys.has(c._key);
      return `<div class="bac-squeeze-wrap ${animClass} ${revealed ? "revealed" : ""}" data-squeeze-key="${c._key}">
        <div class="bac-squeeze-inner" style="${revealed ? "transform:rotateY(180deg)" : ""}">
          <div class="bac-squeeze-face bac-squeeze-back"></div>
          <div class="bac-squeeze-face bac-squeeze-front ${cardColor(c) === "red" ? "red" : ""}" style="transform:rotateY(180deg)">
            <span>${c.r}</span><span class="br">${SUIT_GLYPH[c.s]}</span>
          </div>
        </div>
        ${revealed ? "" : `<div class="bac-squeeze-corner" data-squeeze-key="${c._key}"></div>`}
      </div>`;
    }

    function wireSqueezeCorners(root) {
      root.querySelectorAll(".bac-squeeze-corner").forEach((corner) => {
        const key = Number(corner.dataset.squeezeKey);
        const wrap = corner.closest(".bac-squeeze-wrap");
        const inner = wrap.querySelector(".bac-squeeze-inner");
        let dragging = false, startX = 0;
        const maxDragPx = 80;
        const setAngle = (deg) => { inner.style.transition = "none"; inner.style.transform = `rotateY(${deg}deg)`; };
        const commit = (open) => {
          inner.style.transition = "";
          inner.style.transform = open ? "rotateY(180deg)" : "rotateY(0deg)";
          if (open) {
            state.revealedKeys.add(key);
            const waiter = revealWaiters.get(key);
            if (waiter) { revealWaiters.delete(key); waiter(); }
            render();
          }
        };
        wrap.addEventListener("pointerdown", (e) => { dragging = true; startX = e.clientX; wrap.setPointerCapture(e.pointerId); });
        wrap.addEventListener("pointermove", (e) => {
          if (!dragging) return;
          const pct = Math.min(1, Math.max(0, e.clientX - startX) / maxDragPx);
          setAngle(pct * 180);
        });
        const endDrag = (e) => {
          if (!dragging) return;
          dragging = false;
          const pct = Math.min(1, Math.max(0, e.clientX - startX) / maxDragPx);
          commit(pct >= 0.55);
        };
        wrap.addEventListener("pointerup", endDrag);
        wrap.addEventListener("pointercancel", endDrag);
        wrap.addEventListener("dblclick", () => commit(true));
        wrap.addEventListener("click", () => { if (!dragging) commit(true); });
      });
    }

    // Reveals everything dealt so far immediately, and fast-forwards any
    // cards still left to come this round (third-card draws, etc.) rather
    // than making you squeeze the rest one by one.
    function revealAll() {
      skipSqueeze = true;
      [...state.player, ...state.banker].forEach((c) => state.revealedKeys.add(c._key));
      revealWaiters.forEach((resolve) => resolve());
      revealWaiters.clear();
      render();
    }

    function renderTable() {
      const faceDown = (state.phase === "revealing" || state.phase === "dealing") ? faceDownEnabled() : false;
      const playerRevealed = state.player.filter((c) => state.revealedKeys.has(c.key));
      const bankerRevealed = state.banker.filter((c) => state.revealedKeys.has(c.key));
      const playerLabel = playerRevealed.length
        ? `${bacHandTotal(playerRevealed)}${state.phase === "settled" && state.playerNatural ? " ★" : ""}`
        : "?";
      const bankerLabel = bankerRevealed.length
        ? `${bacHandTotal(bankerRevealed)}${state.phase === "settled" && state.bankerNatural ? " ★" : ""}`
        : "?";

      const resultHtml = state.phase === "settled" && state.lastResult ? (() => {
        const r = state.lastResult;
        const cls = r.totalProfit > 0 ? "win" : r.totalProfit < 0 ? "lose" : "push";
        const headline = r.totalProfit > 0 ? "You Win" : r.totalProfit < 0 ? "You Lose" : "Push";
        const line = (label, amt) => `<div class="ov-summary-line"><span>${label}</span><span class="${amt > 0 ? "win" : amt < 0 ? "lose" : ""}">${amt >= 0 ? "+" : ""}${fmt(amt)}</span></div>`;
        return `<div class="ov-round-summary ${cls}">
      <div class="ov-round-summary-headline">${headline} — ${state.winner.toUpperCase()}</div>
      <div class="ov-round-summary-lines">
        ${r.lines.map(([label, amt]) => line(label, amt)).join("")}
        ${r.jackpotPayout > 0 ? line(`Progressive Jackpot (${r.jackpotTier})`, r.jackpotPayout) : ""}
        <div class="ov-summary-line total"><span>Total</span><span>${r.totalProfit >= 0 ? "+" : ""}${fmt(r.totalProfit)}</span></div>
      </div>
    </div>`;
      })() : "";

      const revealBtn = state.phase === "revealing" ? `<div class="row center mt8"><button class="btn small gold" id="bac-reveal-all">Reveal All</button></div>` : "";

      return `<div class="ov-wrap"><div class="ov-table">
          ${tableBannerHtml()}
          ${shoeDecorHtml()}
          <div class="bac-hands">
            <div class="bac-hand">
              <div class="bac-hand-label">Player</div>
              <div class="bac-hand-cards">${state.player.map((c) => cardEl(c, false, faceDown)).join("")}</div>
              <div class="bac-hand-total ${playerRevealed.length ? "" : "hidden-total"}">${playerLabel}</div>
            </div>
            <div class="bac-hand">
              <div class="bac-hand-label">Banker</div>
              <div class="bac-hand-cards">${state.banker.map((c) => cardEl(c, false, faceDown)).join("")}</div>
              <div class="bac-hand-total ${bankerRevealed.length ? "" : "hidden-total"}">${bankerLabel}</div>
            </div>
          </div>
          ${revealBtn}
          ${resultHtml}
        </div></div>`;
    }

    function renderBettingSpots() {
      const t = state.activeBetTarget;
      return `<div class="ov-bet-rail">
        ${betSpotHtml("player", state.bets.player, t === "player", "Player", false)}
        ${betSpotHtml("tie", state.bets.tie, t === "tie", "Tie", true)}
        ${betSpotHtml("banker", state.bets.banker, t === "banker", "Banker", false)}
      </div>
      <div class="bac-sidebet-strip">
        ${sideSpotHtml("playerPair", "Player Pair", PAYOUTS.playerPair)}
        ${sideSpotHtml("perfectPair", "Perfect Pair", PAYOUTS.perfectPair)}
        ${sideSpotHtml("bankerPair", "Banker Pair", PAYOUTS.bankerPair)}
        ${sideSpotHtml("big", "Big", PAYOUTS.big)}
        ${sideSpotHtml("small", "Small", PAYOUTS.small)}
        ${jackpotSpotHtml()}
      </div>`;
    }
    function sideSpotHtml(key, label, payout) {
      const active = state.activeBetTarget === key;
      const amt = state.bets[key];
      return `<div class="bac-side-spot ${active ? "active" : ""}" data-target="${key}">
        <div class="bac-side-label">${label}</div>
        <div class="bac-side-pay">${payout}:1</div>
        ${amt > 0 ? `<div class="bac-side-amt">${fmt(amt)}</div>` : ""}
      </div>`;
    }
    function jackpotSpotHtml() {
      return `<div class="bac-jackpot-spot ${state.jackpotBet ? "active" : ""}" id="bac-jackpot-toggle" title="Flat ${fmt(JACKPOT_SIDE_BET)} bet — required to collect the progressive jackpot this round">
        <div class="bac-side-label">💰 Jackpot</div>
        <div class="bac-side-pay">${fmt(JACKPOT_SIDE_BET)} flat</div>
        ${state.jackpotBet ? `<div class="bac-side-amt">ON</div>` : `<div class="bac-side-amt" style="color:var(--text-dim)">OFF</div>`}
      </div>`;
    }

    function render() {
      if (!root) return;
      ensureBaccaratSharedStyle();

      const jackpotBanner = `<div class="bac-jackpot-banner" id="bac-jackpot-banner">PROGRESSIVE JACKPOT: ${fmtJackpot(jackpotAmount)}</div>`;

      if (state.phase === "betting") {
        const wager = totalWager();
        root.innerHTML = jackpotBanner + rulesButtonRowHtml() + `<div class="ov-wrap"><div class="ov-table">
              ${tableBannerHtml()}
              ${shoeDecorHtml()}
              <div class="bac-hands">
                <div class="bac-hand"><div class="bac-hand-label">Player</div><div class="bac-hand-cards"></div></div>
                <div class="bac-hand"><div class="bac-hand-label">Banker</div><div class="bac-hand-cards"></div></div>
              </div>
            </div>
            ${renderBettingSpots()}
            <div class="ov-chip-rail">
              ${renderBetControls(
          "bac",
          state.bets[state.activeBetTarget] || 0,
          busy,
          { selectedChip: state.selectedChip }
        )}

            <div class="row center" style="gap:10px;flex-wrap:wrap;margin-top:10px">
              <span class="muted">Total wager: ${fmt(wager)}</span>
              <button class="btn primary" id="bac-deal" ${busy || !wager ? "disabled" : ""}>
              Deal
              </button>
            </div>
          </div></div>`;
        wireRulesButton(root);
        wireSoundToggle(root, render);
        wireFaceDownToggle(root, render);

        const jackpotToggle = root.querySelector("#bac-jackpot-toggle");
        if (jackpotToggle) jackpotToggle.addEventListener("click", () => {
          if (!state.jackpotBet && JACKPOT_SIDE_BET > Balance.current) { toast("Not enough balance for the jackpot bet."); return; }
          state.jackpotBet = !state.jackpotBet;
          render();
        });

        root.querySelectorAll(".ov-bet-spot, .bac-side-spot").forEach((spot) => {
          spot.addEventListener("click", () => { state.activeBetTarget = spot.dataset.target; render(); });
          spot.addEventListener("dragover", (e) => { e.preventDefault(); spot.classList.add("drag-over"); });
          spot.addEventListener("dragleave", () => spot.classList.remove("drag-over"));
          spot.addEventListener("drop", (e) => {
            e.preventDefault();
            spot.classList.remove("drag-over");
            const key = spot.dataset.target;
            const amt = parseInt(e.dataTransfer.getData("text/plain"), 10);
            if (!isNaN(amt)) {
              state, activeBetTarget = key;
              state.selectedChip = amt;
              if (MAIN_BET_KEYS.includes(key)) clearOtherMainBets(key);
              state.bets[key] = clamp(state.bets[key] + amt, 0, MAX_BET);
              render();
            }
          });
        });
        wireBetControls(
          root,
          "bac",
          () => state.bets[state.activeBetTarget] || 0,
          (value) => {
            const target = state.activeBetTarget;

            // Player, Banker, and Tie are mutually exclusive on this table.
            if (MAIN_BET_KEYS.includes(target) && value > 0) {
              clearOtherMainBets(target);
            }

            state.bets[target] = value;
            render();
          },
          {
            getSelectedChip: () => state.selectedChip,
            setSelectedChip: (value) => {
              state.selectedChip = value;
            },
            onClear: () => {
              Object.keys(state.bets).forEach((key) => {
                state.bets[key] = 0;
              });
              state.jackpotBet = false;
              render();
            },
            minBet: 0,
            maxBet: MAX_BET,
          }
        );
        const dealBtn = root.querySelector("#bac-deal");
        if (dealBtn) dealBtn.addEventListener("click", startDeal);
        return;
      }

      let controls = "";
      if (state.phase === "settled") {
        const prior = state.lastOpeningBet;
        const rebetAmount = prior
          ? Object.values(prior.bets).reduce((sum, amount) => sum + amount, 0)
          + (prior.jackpotBet ? JACKPOT_SIDE_BET : 0)
          : totalWager();

        controls = `<div class="row center">
  <button class="btn primary" id="bac-rebet">Rebet ${fmt(rebetAmount)}</button>
  <button class="btn gold" id="bac-double-rebet">2× Bet & Rebet</button>
  <button class="btn" id="bac-again">Change Bet</button>
</div>`;
      } else {
        controls = `<div class="center muted">${state.phase === "dealing" ? "Dealing…" : "Squeeze the card to reveal it…"}</div>`;
      }

      root.innerHTML = jackpotBanner + rulesButtonRowHtml() + renderTable() + `<div class="mt16">${controls}</div>`;
      wireRulesButton(root);
      wireSoundToggle(root, render);
      wireFaceDownToggle(root, render);
      wireSqueezeCorners(root);

      const revealBtn = root.querySelector("#bac-reveal-all");
      if (revealBtn) revealBtn.addEventListener("click", revealAll);

      if (state.phase === "settled") {
        root.querySelector("#bac-again").addEventListener("click", () => {
          const bets = state.bets, jackpotBet = state.jackpotBet;
          state = freshState();
          state.bets = bets;
          state.jackpotBet = jackpotBet;
          render();
        });
        root.querySelector("#bac-rebet").addEventListener("click", () => rebet(1));

        const doubleRebetBtn = root.querySelector("#bac-double-rebet");
        if (doubleRebetBtn) {
          doubleRebetBtn.addEventListener("click", () => rebet(2));
        }
      }
    }

    return {
      label: "Baccarat",
      icon: "🎴",
      order: 2,
      mount(el) {
        root = el;
        state = freshState();
        if (window.SaltyJackpot) {
          jackpotUnsub = window.SaltyJackpot.subscribe((pool) => {
            jackpotAmount = pool.amount;
            const el2 = document.getElementById("bac-jackpot-banner");
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

  window.SaltyCore.GAME_MODULES.baccarat = BaccaratSolo;
})();
