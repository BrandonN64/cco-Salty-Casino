// ==UserScript==
// Salty's Casino — THREE CARD POKER MODULE (Solo)
// Loaded via @require, after salty-core.js and salty-jackpot.js, by the
// main salty-casino.user.js loader. Registers itself into
// window.SaltyCore.GAME_MODULES.threecardpoker so it shows up
// automatically on the home grid.
//
// Solo play only: up to 5 hands at once vs one dealer, one standard
// 52-card shoe (no Spanish-deck weirdness here — Three Card Poker uses a
// normal deck).
//
// House rules match the standard commercial Three Card Poker paytable:
//   - Ante is required to see cards; Pair Plus and the flat Jackpot side
//     bet are optional, placed before the deal alongside the Ante.
//   - After seeing your 3 cards, choose to Play (match your Ante with an
//     equal Play bet) or Fold (forfeit the Ante and any side bets).
//   - Dealer must have Queen-high or better to qualify. If the dealer
//     doesn't qualify, Ante pays even money and Play pushes (returned,
//     no win/loss) regardless of who'd have had the better hand.
//   - If the dealer qualifies, compare hands: better hand wins both Ante
//     and Play at even money; a tie pushes both.
//   - Three Card Poker hand ranking is NOT the same order as 5-card
//     poker — with only 3 cards a straight is harder to make than a
//     flush, so it outranks it: Straight Flush > Three of a Kind >
//     Straight > Flush > Pair > High Card.
//   - Pair Plus pays automatically on your own 3 cards regardless of the
//     dealer or whether you Play or Fold — well, real tables lose Pair
//     Plus on a fold too, so here Pair Plus resolves the instant it's
//     known (right after the deal), same timing as Blackjack's Perfect
//     Pairs and Spanish 21's Bonus 21.
//   - Progressive jackpot: rare trigger is a Mini Royal (A-K-Q suited),
//     same "buy eligibility separately" convention as every other table
//     — the flat Jackpot bet just controls whether this specific hand
//     can collect a share of the shared pool on top of its normal payout.
// ==/UserScript==
(function () {
  "use strict";

  const {
    MIN_BET, MAX_BET, GAME_MODULES, OVERLAY_ID,
    Balance, Shoe, RANK_ORDER, cardColor, SUIT_GLYPH, clamp, delay, fmt,
    chipColor, chipStyle, renderBetControls, wireBetControls, toast,
  } = window.SaltyCore;

  const MAX_HANDS = 5;
  const SOLO_DEAL_CARD_MS = 450;

  // Real commercial Pair Plus paytable (Ante & Play variant) — pays on
  // the player's own 3 cards regardless of the dealer or a fold.
  const PAIR_PLUS_PAYTABLE = {
    pair: 1,          // 1:1
    flush: 4,         // 4:1
    straight: 5,      // 5:1  (straight outranks flush in 3-card poker)
    threeKind: 30,    // 30:1
    straightFlush: 40, // 40:1
  };

  const JACKPOT_SIDE_BET = 250_000; // same flat stake as every other table's qualifying bet
  const JACKPOT_TIER = "major"; // Mini Royal (A-K-Q suited) — rare enough for the bigger share

  function fmtJackpot(n) {
    return (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---------------------------------------------------------------------
  // Three Card Poker hand evaluation. NOT the same rank order as 5-card
  // poker — a straight beats a flush here, since a 3-card straight is
  // statistically rarer than a 3-card flush (the reverse of 5-card odds).
  // Tiers: 5 straightFlush, 4 threeKind, 3 straight, 2 flush, 1 pair, 0 high card.
  // ---------------------------------------------------------------------
  function evalThreeCard(cards) {
    const ranks = cards.map((c) => RANK_ORDER[c.r]).sort((a, b) => b - a);
    const suits = cards.map((c) => c.s);
    const isFlush = suits.every((s) => s === suits[0]);
    const uniq = [...new Set(ranks)];
    // handles the wheel-style A-2-3 straight (ranks would be 14,3,2)
    let isStraight = false, straightHigh = ranks[0];
    if (uniq.length === 3) {
      if (ranks[0] - ranks[2] === 2) { isStraight = true; straightHigh = ranks[0]; }
      else if (JSON.stringify(ranks) === JSON.stringify([14, 3, 2])) { isStraight = true; straightHigh = 3; }
    }
    const isTrips = ranks[0] === ranks[1] && ranks[1] === ranks[2];
    const isPair = !isTrips && (ranks[0] === ranks[1] || ranks[1] === ranks[2]);
    const pairRank = isPair ? (ranks[0] === ranks[1] ? ranks[0] : ranks[1]) : null;
    const kicker = isPair ? ranks.find((r) => r !== pairRank) : null;

    if (isStraight && isFlush) return { tier: 5, tb: [straightHigh] };
    if (isTrips) return { tier: 4, tb: [ranks[0]] };
    if (isStraight) return { tier: 3, tb: [straightHigh] };
    if (isFlush) return { tier: 2, tb: ranks };
    if (isPair) return { tier: 1, tb: [pairRank, kicker] };
    return { tier: 0, tb: ranks };
  }

  function compareThreeCard(a, b) {
    if (a.tier !== b.tier) return a.tier - b.tier;
    for (let i = 0; i < Math.max(a.tb.length, b.tb.length); i++) {
      const d = (a.tb[i] || 0) - (b.tb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  // Queen-high or better: any pair/trips/straight/flush/straight-flush
  // qualifies outright; a high-card hand only qualifies if its best card
  // is a Queen or higher.
  function dealerQualifies(ev, cards) {
    if (ev.tier > 0) return true;
    const ranks = cards.map((c) => RANK_ORDER[c.r]).sort((a, b) => b - a);
    return ranks[0] >= RANK_ORDER["Q"];
  }

  function handName(ev) {
    return ["High Card", "Pair", "Flush", "Straight", "Three of a Kind", "Straight Flush"][ev.tier];
  }

  function isMiniRoyal(cards) {
    const ranks = cards.map((c) => c.r).sort();
    const suits = new Set(cards.map((c) => c.s));
    return suits.size === 1 && JSON.stringify(ranks) === JSON.stringify(["A", "K", "Q"]);
  }

  // ---------------------------------------------------------------------
  // Shared UI bits (chip stacks, bet spots, felt banner, shoe decor,
  // House Rules modal, dealing sound) — same conventions as every other
  // table, kept local to this file since Three Card Poker isn't sharing
  // a module with anything else.
  // ---------------------------------------------------------------------
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

  function jackpotSpotHtml(active) {
    return `<div class="tcp-jackpot-spot ${active ? "active" : ""}" id="tcp-jackpot-toggle" title="Flat ${fmt(JACKPOT_SIDE_BET)} bet per hand — required to collect the progressive jackpot this round">
      <div class="ov-bet-spot-label">💰 Jackpot</div>
      <div class="tcp-jackpot-sub">${fmt(JACKPOT_SIDE_BET)} flat / hand</div>
      ${active ? `<div class="ov-bet-spot-amt">ON</div>` : `<div class="ov-bet-spot-amt" style="color:var(--text-dim)">OFF</div>`}
    </div>`;
  }

  function tableBannerHtml() {
    return `
      <svg class="ov-banner" viewBox="0 0 440 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path id="ov-banner-arc-tcp" d="M 15,52 Q 220,8 425,52" fill="none"/>
        <text class="ov-banner-main"><textPath href="#ov-banner-arc-tcp" startOffset="50%" text-anchor="middle">THREE CARD POKER</textPath></text>
      </svg>
      <div class="ov-banner-sub">Dealer qualifies with Queen-high or better</div>
      <div class="ov-banner-sub2">Ante & Play both pay even money</div>
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
    return `<div class="row" style="justify-content:flex-end;gap:6px;margin-bottom:6px">${soundToggleHtml()}<button class="btn small" id="saltys-tcp-rules-btn">📖 House Rules</button></div>`;
  }
  function wireRulesButton(root) {
    const btn = root && root.querySelector("#saltys-tcp-rules-btn");
    if (btn) btn.addEventListener("click", showRulesModal);
  }

  function showRulesModal() {
    if (document.getElementById("saltys-tcp-rules")) return;
    const el = document.createElement("div");
    el.id = "saltys-tcp-rules";
    el.innerHTML = `
      <div class="box">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2>House Rules</h2>
          <button class="btn small" id="saltys-tcp-rules-close-x">✕</button>
        </div>
        <div class="rules-body">
          <h3>How a round works</h3>
          <p>Place an <b>Ante</b> to see cards — Pair Plus and the flat Jackpot bet are optional, placed alongside it. You and the dealer each get 3 cards, yours face up, the dealer's face down. After looking at your hand, choose to <b>Play</b> (add a bet equal to your Ante) or <b>Fold</b> (forfeit the Ante). Once every hand has decided, the dealer reveals their cards and hands are compared.</p>

          <h3>Hand ranking (this is NOT 5-card poker order)</h3>
          <p>With only 3 cards, a straight is harder to make than a flush — so the ranking flips from what you're used to: <b>Straight Flush</b> beats <b>Three of a Kind</b> beats <b>Straight</b> beats <b>Flush</b> beats <b>Pair</b> beats <b>High Card</b>.</p>

          <h3>Dealer qualifying</h3>
          <p>The dealer needs <b>Queen-high or better</b> to qualify — any pair or better always qualifies; a high-card hand only qualifies if its best card is a Queen or higher. If the dealer doesn't qualify, your Ante pays <b>even money</b> and your Play bet simply pushes (returned, no win or loss), regardless of whose hand was actually better.</p>

          <h3>When the dealer qualifies</h3>
          <p>Your hand is compared to the dealer's. If yours is better, both Ante and Play pay <b>even money</b>. If the dealer's is better, you lose both. A tie pushes both.</p>

          <h3>Pair Plus (side bet)</h3>
          <p>Placed before the deal. Pays automatically on your own 3 cards, whether you Play or Fold, regardless of the dealer's hand: Pair ${PAIR_PLUS_PAYTABLE.pair}:1, Flush ${PAIR_PLUS_PAYTABLE.flush}:1, Straight ${PAIR_PLUS_PAYTABLE.straight}:1, Three of a Kind ${PAIR_PLUS_PAYTABLE.threeKind}:1, Straight Flush ${PAIR_PLUS_PAYTABLE.straightFlush}:1.</p>

          <h3>Progressive jackpot</h3>
          <p>0.05% of every wager placed at any table feeds one shared jackpot pool, whether or not you bet on it. <b>Collecting it is separate</b> — place the flat <b>Jackpot</b> bet (${fmt(JACKPOT_SIDE_BET)} per hand) to be eligible that round. With it down, dealing a <b>Mini Royal</b> (A-K-Q, all one suit) pays out a share of the shared pool, on top of your normal Pair Plus payout for a straight flush. Without the Jackpot bet, that hand still resolves normally — you just don't collect the extra. Like any other side bet, the Jackpot bet is lost on hands that don't qualify.</p>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:16px">
          <button class="btn primary" id="saltys-tcp-rules-close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.querySelector("#saltys-tcp-rules-close").addEventListener("click", close);
    el.querySelector("#saltys-tcp-rules-close-x").addEventListener("click", close);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
  }

  const LS_SOUND_ENABLED = "saltys_tcp_sound_enabled";
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
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
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
    return `<button class="btn small" id="saltys-tcp-sound-btn" title="Toggle dealing sound">${soundEnabled() ? "🔊" : "🔇"}</button>`;
  }
  function wireSoundToggle(root, renderFn) {
    const btn = root && root.querySelector("#saltys-tcp-sound-btn");
    if (btn) btn.addEventListener("click", () => { setSoundEnabled(!soundEnabled()); renderFn(); });
  }

  function ensureThreeCardPokerSharedStyle() {
    if (document.getElementById("saltys-tcp-shared-style")) return;
    const s = document.createElement("style");
    s.id = "saltys-tcp-shared-style";
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700;800&family=JetBrains+Mono:wght@600;700;800&display=swap');

      #${OVERLAY_ID} .tcp-card-deal{ animation: tcpDealIn .35s ease-out; }
      @keyframes tcpDealIn{ from { transform: translateY(-30px) rotate(-8deg); opacity:0; } to { transform:none; opacity:1; } }

      #${OVERLAY_ID} .tcp-sidebet-strip{ display:flex; gap:6px; margin-top:4px; justify-content:center; flex-wrap:wrap; }
      #${OVERLAY_ID} .tcp-sidebet-chip{
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        width:40px; height:40px; border-radius:50%; border:2px solid #1a1400; position:relative;
        background:
          radial-gradient(circle at 32% 28%, rgba(255,255,255,.5), rgba(255,255,255,0) 42%),
          repeating-conic-gradient(from 0deg, #7c3aed 0deg 16deg, #ffffff26 16deg 20deg, #7c3aed 20deg 36deg);
        box-shadow:0 2px 5px rgba(0,0,0,.5);
      }
      #${OVERLAY_ID} .tcp-sidebet-chip.hit{ box-shadow:0 0 0 2px var(--success), 0 2px 8px rgba(47,191,113,.5); }
      #${OVERLAY_ID} .tcp-sidebet-label{ font-size:8px; font-weight:800; color:#fff; text-transform:uppercase; letter-spacing:.3px; text-shadow:0 1px 2px rgba(0,0,0,.7); }
      #${OVERLAY_ID} .tcp-sidebet-amt{ font:700 8px/1.2 "JetBrains Mono",monospace; color:#fff; text-shadow:0 1px 2px rgba(0,0,0,.7); }

      #${OVERLAY_ID} .tcp-jackpot-spot{
        position:relative; width:92px; height:92px; border-radius:50%; cursor:pointer;
        background:radial-gradient(circle at 50% 35%, rgba(124,58,237,.3), #10261c 75%);
        border:2px dashed var(--purple); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
        transition:box-shadow .15s ease, border-color .15s ease, transform .15s ease;
      }
      #${OVERLAY_ID} .tcp-jackpot-spot.active{ border-style:solid; border-color:var(--purple-bright); transform:translateY(-3px); box-shadow:0 0 0 3px rgba(124,58,237,.4); }
      #${OVERLAY_ID} .tcp-jackpot-spot .ov-bet-spot-label{ color:var(--purple-bright); }
      #${OVERLAY_ID} .tcp-jackpot-sub{ font:600 8px/1.2 "JetBrains Mono",monospace; color:var(--text-dim); text-align:center; padding:0 6px; }

      #${OVERLAY_ID} .tcp-jackpot-banner{
        text-align:center; font:800 20px/1 "Oswald",sans-serif; letter-spacing:1px; color:var(--gold-bright);
        text-shadow:0 0 14px rgba(244,207,101,.5); margin-bottom:8px; transition:transform .15s ease;
      }
      #${OVERLAY_ID} .tcp-jackpot-banner.pulse{ transform:scale(1.06); }

      #saltys-tcp-rules{
        position:fixed; inset:0; z-index:100002; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.75); font:14px/1.6 Inter,system-ui,sans-serif;
      }
      #saltys-tcp-rules .box{
        max-width:560px; max-height:82vh; overflow-y:auto; margin:20px; background:#12161d;
        border:1px solid #3a2c0f; border-radius:16px; padding:26px 24px; color:#f4f1ea;
      }
      #saltys-tcp-rules h2{ margin:0; font:800 20px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; }
      #saltys-tcp-rules h3{ margin:18px 0 6px; font:700 13px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; text-transform:uppercase; letter-spacing:.5px; }
      #saltys-tcp-rules h3:first-of-type{ margin-top:6px; }
      #saltys-tcp-rules p{ margin:0 0 8px; color:#c7cdd6; font-size:13px; }
      #saltys-tcp-rules b{ color:#f4f1ea; }
    `;
    document.head.appendChild(s);
  }

  // =====================================================================
  // SOLO MULTI-HAND — up to 5 simultaneous hands vs one dealer, one shoe.
  // =====================================================================
  const SEAT_POS = [
    { left: 10, top: 58, rotate: "-35deg" },
    { left: 27, top: 80, rotate: "0deg" },
    { left: 50, top: 90, rotate: "0deg" },
    { left: 73, top: 80, rotate: "0deg" },
    { left: 90, top: 58, rotate: "0deg" },
  ];
  const SoloThreeCardPoker = (function () {
    let root = null, shoe = null, state = null, busy = false, chipScrollPos = 0;
    let jackpotUnsub = null, jackpotAmount = 0;
    const dealtAnimated = new Set();

    function freshState() {
      return {
        phase: "betting", selectedSeats: [], antePerHand: Math.min(100, MAX_BET),
        pairPlusPerHand: 0, jackpotBetPerHand: false, activeBetTarget: "ante", selectedChip: 100,
        hands: [], dealer: [], dealerHidden: true,
        activeHandIndex: 0, lastResults: null,
        lastOpeningBet: null,
      };
    }
    function getBetFor(target) {
      if (target === "pairPlus") return state.pairPlusPerHand;
      return state.antePerHand;
    }
    function setBetFor(target, v) {
      if (target === "pairPlus") state.pairPlusPerHand = v;
      else state.antePerHand = v;
    }
    function newHand(ante, pairPlus, jackpotStake, seatIdx) {
      return {
        cards: [], ante, playBet: 0, status: "active", decision: null, result: null,
        sideBets: { pairPlus, jackpot: jackpotStake }, sideBetResults: {}, seatIdx,
        pairPlusProfit: 0, jackpotProfit: 0, profit: null,
      };
    }

    async function startDeal() {
      if (busy) return;
      if (!state.selectedSeats.length) { toast("Select at least one seat to play."); return; }
      if (!state.antePerHand) { toast("Place an Ante to deal."); return; }
      const ante = clamp(Math.round(state.antePerHand), MIN_BET, MAX_BET);
      const pp = clamp(Math.round(state.pairPlusPerHand || 0), 0, MAX_BET);
      const jp = state.jackpotBetPerHand ? JACKPOT_SIDE_BET : 0;
      const numHands = state.selectedSeats.length;
      const total = (ante + pp + jp) * numHands;
      if (total > Balance.current) { toast("Not enough balance for that many seats at this bet."); return; }
      busy = true; render();
      try {
        await Balance.applyDelta(-total, "solo_tcp_deal_multi");
        state.lastOpeningBet = {
          selectedSeats: [...state.selectedSeats],
          antePerHand: ante,
          pairPlusPerHand: pp,
          jackpotBetPerHand: state.jackpotBetPerHand,
        };
        if (window.SaltyJackpot) window.SaltyJackpot.contribute(total, "threecardpoker");
      }
      catch (e) { toast("Bet failed."); busy = false; render(); return; }
      if (!shoe) shoe = new Shoe(6, 0.25);
      dealtAnimated.clear();
      const seatOrder = [...state.selectedSeats].sort((a, b) => a - b);
      state.hands = seatOrder.map((seatIdx) => newHand(ante, pp, jp, seatIdx));
      state.dealer = [];
      state.phase = "player";
      state.dealerHidden = true;
      state.activeHandIndex = 0;
      state.lastResults = null;
      render();
      for (let round = 0; round < 3; round++) {
        for (const hand of state.hands) {
          hand.cards.push(shoe.draw());
          render();
          playDealSound();
          await delay(SOLO_DEAL_CARD_MS);
        }
        state.dealer.push(shoe.draw());
        render();
        playDealSound();
        await delay(SOLO_DEAL_CARD_MS);
      }
      // Pair Plus and the jackpot's Mini Royal trigger both depend only
      // on the player's own 3 cards, already fully known here — resolve
      // them immediately, same timing every other table's instant side
      // bets use, rather than waiting on the Play/Fold decision or the
      // dealer's hand.
      let sideBetPayout = 0;
      for (const hand of state.hands) {
        if (hand.sideBets.pairPlus > 0) {
          const ev = evalThreeCard(hand.cards);
          const key = ev.tier === 5 ? "straightFlush" : ev.tier === 4 ? "threeKind" : ev.tier === 3 ? "straight" : ev.tier === 2 ? "flush" : ev.tier === 1 ? "pair" : null;
          hand.sideBetResults.pairPlus = key;
          if (key) {
            const win = hand.sideBets.pairPlus * PAIR_PLUS_PAYTABLE[key] + hand.sideBets.pairPlus;
            sideBetPayout += win;
            hand.pairPlusProfit = win - hand.sideBets.pairPlus;
          } else {
            hand.pairPlusProfit = -hand.sideBets.pairPlus;
          }
        }
        if (hand.sideBets.jackpot > 0) {
          if (isMiniRoyal(hand.cards) && window.SaltyJackpot) {
            const jpPayout = await window.SaltyJackpot.award(JACKPOT_TIER, "threecardpoker", "Mini Royal: A-K-Q suited", true);
            if (jpPayout > 0) {
              sideBetPayout += hand.sideBets.jackpot + jpPayout;
              hand.jackpotProfit = jpPayout;
            } else {
              hand.jackpotProfit = -hand.sideBets.jackpot;
            }
          } else {
            hand.jackpotProfit = -hand.sideBets.jackpot;
          }
        }
      }
      if (sideBetPayout > 0) await Balance.applyDelta(sideBetPayout, "solo_tcp_sidebets_instant");
      render();
      advanceIfResolved();
      busy = false;
      render();
    }

    function restoreOpeningBet(snapshot, multiplier = 1) {
      if (!snapshot) return false;

      state.selectedSeats = [...snapshot.selectedSeats];
      state.antePerHand = clamp(
        Math.round(snapshot.antePerHand * multiplier),
        MIN_BET,
        MAX_BET
      );
      state.pairPlusPerHand = clamp(
        Math.round(snapshot.pairPlusPerHand * multiplier),
        0,
        MAX_BET
      );

      // Jackpot is a fixed qualifying stake, not a variable wager.
      state.jackpotBetPerHand = snapshot.jackpotBetPerHand;
      state.activeBetTarget = "ante";
      return true;
    }

    async function rebet(multiplier = 1) {
      if (busy || !state.lastOpeningBet) return;

      const restored = restoreOpeningBet(state.lastOpeningBet, multiplier);
      if (!restored) return;

      const seatCount = state.selectedSeats.length;
      const jackpotPerHand = state.jackpotBetPerHand ? JACKPOT_SIDE_BET : 0;
      const openingTotal =
        (state.antePerHand + state.pairPlusPerHand + jackpotPerHand) *
        seatCount;

      if (openingTotal > Balance.current) {
        toast(`Not enough balance to ${multiplier === 2 ? "double and rebet" : "rebet"}.`);
        return;
      }

      await startDeal();
    }

    function currentHand() { return state.hands[state.activeHandIndex]; }
    function advanceIfResolved() {
      while (state.activeHandIndex < state.hands.length && state.hands[state.activeHandIndex].status !== "active") state.activeHandIndex++;
      if (state.activeHandIndex >= state.hands.length) runDealer();
    }

    async function act(action) {
      if (busy || state.phase !== "player") return;
      const hand = currentHand();
      if (!hand || hand.status !== "active") return;
      busy = true;
      if (action === "play") {
        if (Balance.current < hand.ante) { toast("Not enough balance to play this hand."); busy = false; render(); return; }
        await Balance.applyDelta(-hand.ante, "solo_tcp_play_bet");
        hand.playBet = hand.ante;
        hand.decision = "play";
        hand.status = "played";
      } else if (action === "fold") {
        hand.decision = "fold";
        hand.status = "folded";
        hand.result = "lose";
        hand.profit = -hand.ante + (hand.pairPlusProfit || 0) + (hand.jackpotProfit || 0);
      }
      advanceIfResolved();
      busy = false;
      render();
    }

    async function runDealer() {
      state.phase = "dealer";
      state.dealerHidden = false;
      render();
      await delay(SOLO_DEAL_CARD_MS);
      await settle();
    }

    async function settle() {
      state.phase = "settled";
      const dealerEv = evalThreeCard(state.dealer);
      const qualifies = dealerQualifies(dealerEv, state.dealer);
      let totalProfit = 0, anteProfitTotal = 0, sideBetProfitTotal = 0, jackpotProfitTotal = 0;
      let roundPayout = 0;

      for (const hand of state.hands) {
        let handProfit;
        if (hand.decision === "fold") {
          handProfit = -hand.ante; // already applied at fold time in `act()`, but recomputed here for the summary math below
        } else {
          const playerEv = evalThreeCard(hand.cards);
          let anteResult, anteWin = 0, playWin = 0;
          if (!qualifies) {
            anteResult = "push-dealer-no-qualify";
            anteWin = hand.ante * 2; // even money on Ante
            playWin = hand.playBet; // Play just pushes back
          } else {
            const cmp = compareThreeCard(playerEv, dealerEv);
            if (cmp > 0) {
              anteResult = "win";
              anteWin = hand.ante * 2;
              playWin = hand.playBet * 2;
            } else if (cmp < 0) {
              anteResult = "lose";
              anteWin = 0;
              playWin = 0;
            } else {
              anteResult = "push";
              anteWin = hand.ante;
              playWin = hand.playBet;
            }
          }
          hand.result = anteResult === "lose" ? "lose" : anteResult === "win" ? "win" : "push";
          hand.dealerQualified = qualifies;
          hand.playerHandName = handName(playerEv);
          roundPayout += anteWin + playWin;
          handProfit = (anteWin + playWin) - hand.ante - hand.playBet;
        }
        hand.profit = handProfit + (hand.pairPlusProfit || 0) + (hand.jackpotProfit || 0);
        anteProfitTotal += handProfit;
        sideBetProfitTotal += (hand.pairPlusProfit || 0);
        jackpotProfitTotal += (hand.jackpotProfit || 0);
        totalProfit += hand.profit;
      }

      if (roundPayout > 0) await Balance.applyDelta(roundPayout, "solo_tcp_round_settle");

      state.lastResults = { totalProfit, anteProfitTotal, sideBetProfitTotal, jackpotProfitTotal, dealerQualified: qualifies, dealerHandName: handName(dealerEv) };
      render();
    }

    function cardEl(c, hidden) {
      if (hidden) return `<div class="card back" data-key="hidden"></div>`;
      const isNew = c._key != null && !dealtAnimated.has(c._key);
      if (isNew) dealtAnimated.add(c._key);
      return `<div class="card ${cardColor(c)} ${isNew ? "tcp-card-deal" : ""}" data-key="${c._key ?? ""}"><span>${c.r}</span><span class="br">${SUIT_GLYPH[c.s]}</span></div>`;
    }

    function renderSoloOvalTable() {
      const dealerShownName = state.dealerHidden ? null : handName(evalThreeCard(state.dealer));
      const seatHtml = SEAT_POS.map((pos, i) => {
        const seatHandIdxs = state.hands.reduce((acc, h, hi) => { if (h.seatIdx === i) acc.push(hi); return acc; }, []);
        if (!seatHandIdxs.length) {
          return `<div class="ov-seat" style="left:${pos.left}%;top:${pos.top}%">
            <div class="ov-cardslot empty" style="transform:rotate(${pos.rotate})"></div>
            <div class="ov-chipmark empty"></div>
          </div>`;
        }
        const subHandsHtml = seatHandIdxs.map((hi) => {
          const hand = state.hands[hi];
          const active = state.phase === "player" && hi === state.activeHandIndex;
          const label = hand.status === "folded" ? "Folded" : hand.playerHandName || (hand.status === "played" ? "Played" : "Deciding…");
          const profitLabel = state.phase === "settled" && hand.profit != null
            ? `<div class="ov-profit ${hand.profit > 0 ? "win" : hand.profit < 0 ? "lose" : ""}">${hand.profit >= 0 ? "+" : ""}${fmt(hand.profit)}</div>` : "";
          const sideChips = [];
          if (hand.sideBets && hand.sideBets.pairPlus > 0) {
            const r = hand.sideBetResults && hand.sideBetResults.pairPlus;
            sideChips.push(`<div class="tcp-sidebet-chip ${r ? "hit" : ""}" title="Pair Plus: ${fmt(hand.sideBets.pairPlus)}${r ? " · " + r : ""}"><span class="tcp-sidebet-label">PP</span><span class="tcp-sidebet-amt">${fmt(hand.sideBets.pairPlus)}</span></div>`);
          }
          if (hand.sideBets && hand.sideBets.jackpot > 0) {
            const won = hand.jackpotProfit > 0;
            sideChips.push(`<div class="tcp-sidebet-chip ${won ? "hit" : ""}" title="Jackpot: ${fmt(hand.sideBets.jackpot)}"><span class="tcp-sidebet-label">JP</span><span class="tcp-sidebet-amt">${fmt(hand.sideBets.jackpot)}</span></div>`);
          }
          const sideBetHtml = sideChips.length ? `<div class="tcp-sidebet-strip">${sideChips.join("")}</div>` : "";
          const winBadge = (state.phase === "settled" && hand.result) ? `<div class="ov-win-badge ${hand.profit > 0 ? "win" : hand.profit < 0 ? "lose" : "push"}">
              ${hand.profit > 0 ? "Win" : hand.profit < 0 ? "Lose" : "Push"}
            </div>` : "";
          const betShown = hand.playBet ? hand.ante + hand.playBet : hand.ante;
          return `<div class="ov-subhand ${active ? "active" : ""}" style="opacity:${state.phase === "player" && !active ? 0.6 : 1}">
            <div class="ov-hand-ring"><div class="ov-hand">${hand.cards.map((c) => cardEl(c, false)).join("")}</div></div>
            ${chipStackHtml(betShown, { size: 20 })}
            <div class="ov-betlabel">${label}</div>
            ${sideBetHtml}${winBadge}${profitLabel}
          </div>`;
        }).join("");
        return `<div class="ov-seat" style="left:${pos.left}%;top:${pos.top}%">
          <div class="row" style="gap:6px">${subHandsHtml}</div>
        </div>`;
      }).join("");

      const roundSummaryHtml = state.phase === "settled" && state.lastResults ? (() => {
        const r = state.lastResults;
        const cls = r.totalProfit > 0 ? "win" : r.totalProfit < 0 ? "lose" : "push";
        const headline = r.totalProfit > 0 ? "You Win" : r.totalProfit < 0 ? "You Lose" : "Push";
        const line = (label, amt) => `<div class="ov-summary-line"><span>${label}</span><span class="${amt > 0 ? "win" : amt < 0 ? "lose" : ""}">${amt >= 0 ? "+" : ""}${fmt(amt)}</span></div>`;
        return `<div class="ov-round-summary ${cls}">
          <div class="ov-round-summary-headline">${headline}</div>
          <div class="ov-round-summary-lines">
            <div class="ov-summary-line"><span>Dealer</span><span>${r.dealerQualified ? r.dealerHandName : "No Qualify"}</span></div>
            ${line("Ante/Play", r.anteProfitTotal)}
            ${r.sideBetProfitTotal !== 0 ? line("Pair Plus", r.sideBetProfitTotal) : ""}
            ${r.jackpotProfitTotal !== 0 ? line("Jackpot", r.jackpotProfitTotal) : ""}
            <div class="ov-summary-line total"><span>Total</span><span>${r.totalProfit >= 0 ? "+" : ""}${fmt(r.totalProfit)}</span></div>
          </div>
        </div>`;
      })() : "";

      return `<div class="ov-wrap"><div class="ov-table">
          ${tableBannerHtml()}
          ${shoeDecorHtml()}
          <div class="ov-dealer">
            ${dealerShownName ? `<div class="ov-dealer-total" style="width:auto;padding:0 8px;left:-90px">${dealerShownName}</div>` : ""}
            <div class="ov-dealer-hand">${state.dealer.map((c, i) => cardEl(c, state.dealerHidden)).join("")}</div>
            <div class="ov-dealer-label">Dealer's Cards</div>
          </div>
          ${state.phase === "player" ? `<div class="ov-hint">Playing hand ${state.activeHandIndex + 1} of ${state.hands.length}</div>` : ""}
          ${seatHtml}
          ${roundSummaryHtml}
        </div></div>`;
    }

    function render() {
      if (!root) return;
      ensureThreeCardPokerSharedStyle();
      const jackpotBanner = `<div class="tcp-jackpot-banner" id="tcp-jackpot-banner">PROGRESSIVE JACKPOT: ${fmtJackpot(jackpotAmount)}</div>`;

      if (state.phase === "betting") {
        const seatPickHtml = SEAT_POS.map((pos, i) => {
          const picked = state.selectedSeats.includes(i);
          return `<div class="ov-seat" data-seat="${i}" style="left:${pos.left}%;top:${pos.top}%;cursor:pointer">
            <div class="ov-cardslot ${picked ? "" : "empty"}" style="transform:rotate(${pos.rotate});${picked ? "border-color:var(--gold)" : ""}"></div>
          </div>`;
        }).join("");
        const target = state.activeBetTarget || "ante";
        const betRailHtml = `<div class="ov-bet-rail">
          ${betSpotHtml("ante", state.antePerHand, target === "ante", "Ante", false)}
          ${betSpotHtml("pairPlus", state.pairPlusPerHand, target === "pairPlus", "Pair Plus", true)}
          ${jackpotSpotHtml(state.jackpotBetPerHand)}
        </div>`;
        const totalWager = (state.antePerHand + (state.pairPlusPerHand || 0) + (state.jackpotBetPerHand ? JACKPOT_SIDE_BET : 0)) * state.selectedSeats.length;
        root.innerHTML = jackpotBanner + rulesButtonRowHtml() + `<div class="ov-wrap"><div class="ov-table">
            ${tableBannerHtml()}
            ${shoeDecorHtml()}
            <div class="ov-dealer"><div class="ov-dealer-hand"></div><div class="ov-dealer-label">Dealer's Cards</div></div>
            <div class="ov-hint">Click a seat, then place chips below</div>
            ${seatPickHtml}
          </div>
          <div class="ov-bet-rail">${betRailHtml}</div>
          <div class="ov-chip-rail">
            ${renderBetControls(
              "tcp",
              getBetFor(state.activeBetTarget || "ante"),
              busy,
              { selectedChip: state.selectedChip }
            )}
            <div class="row center" style="gap:10px;flex-wrap:wrap">
              <span class="muted">${state.selectedSeats.length} seat${state.selectedSeats.length === 1 ? "" : "s"} · Total wager: ${fmt(totalWager)}</span>
              <button class="btn primary" id="tcp-deal" ${busy || !state.selectedSeats.length || !state.antePerHand ? "disabled" : ""}>Deal</button>
            </div>
          </div></div>`;
        wireRulesButton(root);
        wireSoundToggle(root, render);
        root.querySelectorAll("[data-seat]").forEach((el) => el.addEventListener("click", () => {
          const i = parseInt(el.dataset.seat, 10);
          const idx = state.selectedSeats.indexOf(i);
          if (idx >= 0) state.selectedSeats.splice(idx, 1);
          else if (state.selectedSeats.length < MAX_HANDS) state.selectedSeats.push(i);
          else toast(`You can only play up to ${MAX_HANDS} seats at once.`);
          render();
        }));

        const jackpotToggle = root.querySelector("#tcp-jackpot-toggle");
        if (jackpotToggle) jackpotToggle.addEventListener("click", () => {
          if (!state.jackpotBetPerHand && JACKPOT_SIDE_BET * state.selectedSeats.length > Balance.current) {
            toast("Not enough balance for the jackpot bet on every selected seat.");
            return;
          }
          state.jackpotBetPerHand = !state.jackpotBetPerHand;
          render();
        });

        root.querySelectorAll(".ov-bet-spot").forEach((spot) => {
          spot.addEventListener("click", () => { state.activeBetTarget = spot.dataset.target; render(); });
          spot.addEventListener("dragover", (e) => { e.preventDefault(); spot.classList.add("drag-over"); });
          spot.addEventListener("dragleave", () => spot.classList.remove("drag-over"));
          spot.addEventListener("drop", (e) => {
            e.preventDefault();
            spot.classList.remove("drag-over");
            const amt = parseInt(e.dataTransfer.getData("text/plain"), 10);
            if (!isNaN(amt)) { setBetFor(spot.dataset.target, clamp(getBetFor(spot.dataset.target) + amt, 0, MAX_BET)); render(); }
          });
        });
        wireBetControls(
          root,
          "tcp",
          () => getBetFor(state.activeBetTarget || "ante"),
          (value) => {
            setBetFor(state.activeBetTarget || "ante", value);
            render();
          },
          {
            getSelectedChip: () => state.selectedChip,
            setSelectedChip: (value) => {
              state.selectedChip = value;
            },
            onClear: () => {
              state.antePerHand = 0;
              state.pairPlusPerHand = 0;
              state.jackpotBetPerHand = false;
              render();
            },
            minBet: 0,
            maxBet: MAX_BET,
          }
        );
        root.querySelector("#tcp-deal").addEventListener("click", startDeal);
        return;
      }

      let controls;
      if (state.phase === "player") {
        controls = `<div class="row center">
          <button class="btn primary" id="tcp-play" ${busy ? "disabled" : ""}>Play</button>
          <button class="btn" id="tcp-fold" ${busy ? "disabled" : ""}>Fold</button>
        </div>`;
      } else if (state.phase === "settled") {
        const prior = state.lastOpeningBet;
        const rebetAmount = prior ? prior.antePerHand : state.antePerHand;
        const hasSides = prior ? (prior.pairPlusPerHand || prior.jackpotBetPerHand) : (state.pairPlusPerHand || state.jackpotBetPerHand);
        controls = `<div class="row center">
          <button class="btn primary" id="tcp-rebet">Rebet ${fmt(rebetAmount)}${hasSides ? " + sides" : ""}</button>
          <button class="btn gold" id="tcp-double-rebet">2× Bet & Rebet</button>
          <button class="btn" id="tcp-again">Change Bet</button>
        </div>`;
      } else {
        controls = `<div class="center muted">Dealer revealing…</div>`;
      }
      root.innerHTML = jackpotBanner + rulesButtonRowHtml() + renderSoloOvalTable() + `<div class="mt16">${controls}</div>`;
      wireRulesButton(root);
      wireSoundToggle(root, render);
      if (state.phase === "player") {
        root.querySelector("#tcp-play").addEventListener("click", () => act("play"));
        root.querySelector("#tcp-fold").addEventListener("click", () => act("fold"));
      } else if (state.phase === "settled") {
        root.querySelector("#tcp-again").addEventListener("click", () => {
          const seats = state.selectedSeats, a = state.antePerHand, pp = state.pairPlusPerHand, jp = state.jackpotBetPerHand;
          state = freshState();
          state.selectedSeats = seats;
          state.antePerHand = a;
          state.pairPlusPerHand = pp;
          state.jackpotBetPerHand = jp;
          render();
        });
        root.querySelector("#tcp-rebet").addEventListener("click", () => rebet(1));

        const doubleRebetBtn = root.querySelector("#tcp-double-rebet");
        if (doubleRebetBtn) doubleRebetBtn.addEventListener("click", () => rebet(2));
      }
    }

    return {
      label: "Three Card Poker",
      icon: "♠️",
      order: 4,
      mount(el) {
        root = el;
        state = freshState();
        if (window.SaltyJackpot) {
          jackpotUnsub = window.SaltyJackpot.subscribe((pool) => {
            jackpotAmount = pool.amount;
            const el2 = document.getElementById("tcp-jackpot-banner");
            if (el2) {
              el2.textContent = `PROGRESSIVE JACKPOT: ${fmtJackpot(jackpotAmount)}`;
              el2.classList.add("pulse");
              setTimeout(() => el2.classList.remove("pulse"), 500);
            }
          });
        }
        render();
        return () => {
          resolveAbandonedRound();
          if (jackpotUnsub) jackpotUnsub();
          root = null;
        };
      },
    };

    // Closing the tab mid-round should NOT let the player escape a bad
    // position — same fix already applied to Blackjack and Spanish 21.
    // Force every hand still "active" (not yet decided) to fold, which
    // matches a real table's default outcome if you simply walk away
    // before deciding: your Ante is forfeited, same as choosing Fold.
    async function resolveAbandonedRound() {
      if (!state || state.phase === "betting" || state.phase === "settled") return;
      for (const hand of state.hands) {
        if (hand.status === "active") {
          hand.status = "folded";
          hand.decision = "fold";
        }
      }
      if (state.phase === "player") {
        await runDealer(); // plays out the reveal and calls settle() for the hands that were already Played
      } else if (state.phase === "dealer") {
        await settle();
      }
    }
  })();

  window.SaltyCore.GAME_MODULES.threecardpoker = SoloThreeCardPoker;
})();
