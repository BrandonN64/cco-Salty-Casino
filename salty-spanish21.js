// ==UserScript==
// Salty's Casino — SPANISH 21 MODULE (Solo)
// Loaded via @require, after salty-core.js and salty-jackpot.js, by the
// main salty-casino.user.js loader. Registers itself into
// window.SaltyCore.GAME_MODULES.spanish21 so it shows up automatically on
// the home grid, next to Blackjack and Baccarat.
//
// Solo play only: up to 5 hands at once vs one dealer, one Spanish shoe
// (48 cards per deck — every numerical "10" removed, J/Q/K remain and
// still count as 10 — see freshSpanishDeck() in salty-core.js).
//
// House rules match the standard commercial Spanish 21 paytable:
//   - Dealer hits soft 17.
//   - Player blackjack always pays 3:2 and always beats a dealer 21
//     reached in more than two cards.
//   - Player 21 always beats dealer 21 (Spanish 21's signature rule),
//     UNLESS the dealer has a natural blackjack — nothing beats a dealer
//     natural except your own natural (which pushes it).
//   - Double any two cards, double after split, re-split up to 4 hands,
//     split aces may be hit/doubled (this is more liberal than plain
//     blackjack — it's part of what offsets the missing 10s).
//   - Late surrender before any other action.
//   - Automatic Bonus 21 payouts (5-card 21, 6-card 21, 7+-card 21,
//     6-7-8, 7-7-7) — no side bet required, paid the instant a
//     qualifying hand resolves. Bonuses are voided on split/doubled hands.
//   - Super Bonus: suited 7-7-7 against a dealer up-card of any 7. Also
//     requires no side bet on real tables; the flat progressive Jackpot
//     bet here only controls whether THIS specific hand can additionally
//     collect a share of the shared cross-game pool on top of its normal
//     Super Bonus payout — same "buy eligibility separately" convention
//     Blackjack and Baccarat already use.
//   - Match the Dealer side bet: pays if either/both of your first two
//     cards match the dealer's up card by rank (and more if by rank AND
//     suit).
// ==/UserScript==
(function () {
  "use strict";

  const {
    MIN_BET, MAX_BET, GAME_MODULES, OVERLAY_ID,
    Balance, Shoe, freshSpanishDeck, bjHandValue, isBlackjack, isSplittablePair,
    cardColor, SUIT_GLYPH, clamp, delay, fmt, chipColor, chipStyle,
    renderBetControls, wireBetControls, toast,
  } = window.SaltyCore;

  const DEALER_STANDS_SOFT_17 = false; // Spanish 21 dealer HITS soft 17 (standard)
  const SURRENDER_RETURN_FRACTION = 0.5;
  const SOLO_MAX_HANDS_PER_SEAT = 4; // original + up to 3 splits
  const MAX_HANDS = 5; // up to 5 seats at once, same as Blackjack

  // Automatic Bonus 21 payouts — no side bet required, paid the instant a
  // qualifying hand resolves with a natural 21 (never on split/doubled
  // hands, matching every commercial Spanish 21 table).
  const BONUS_21 = {
    fiveCard: 1.5,   // 5-card 21: 3:2
    sixCard: 2,      // 6-card 21: 2:1
    sevenPlusCard: 3, // 7+-card 21: 3:1
    // 6-7-8 and 7-7-7 (3 cards exactly, totaling 21):
    mixed: 1.5,   // 3:2
    suited: 2,    // 2:1
    spades: 3,    // 3:1
  };

  // Match the Dealer side bet paytable — compares the player's first two
  // cards against the dealer's visible up card by rank/suit.
  const MATCH_DEALER_PAYOUTS = {
    oneMatch: 4,        // one card matches rank only: 4:1
    twoMatch: 11,       // both cards match rank only: 11:1
    oneSuitedMatch: 8,  // one card matches rank AND suit: 8:1
    mixedMatch: 15,     // one suited match + one plain rank match: 15:1
    twoSuitedMatch: 24, // both cards match rank AND suit: 24:1
  };

  const JACKPOT_SIDE_BET = 250_000; // same flat stake as Baccarat's qualifying bet
  const JACKPOT_TIER = "major"; // Super Bonus (suited 7-7-7 vs dealer 7) is the trigger — rare enough to earn the bigger share

  // The jackpot pool grows in tiny fractions of a token per round (0.05%
  // of the wager), so rounding it to a whole number for display would
  // make it look completely static for dozens of rounds — same fix
  // already applied to Blackjack's and Baccarat's jackpot banners.
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

  function jackpotSpotHtml(active) {
    return `<div class="sp21-jackpot-spot ${active ? "active" : ""}" id="sp21-jackpot-toggle" title="Flat ${fmt(JACKPOT_SIDE_BET)} bet per hand — required to collect the progressive jackpot this round">
      <div class="ov-bet-spot-label">💰 Jackpot</div>
      <div class="sp21-jackpot-sub">${fmt(JACKPOT_SIDE_BET)} flat / hand</div>
      ${active ? `<div class="ov-bet-spot-amt">ON</div>` : `<div class="ov-bet-spot-amt" style="color:var(--text-dim)">OFF</div>`}
    </div>`;
  }

  function tableBannerHtml() {
    return `
      <svg class="ov-banner" viewBox="0 0 440 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path id="ov-banner-arc-sp21" d="M 15,52 Q 220,8 425,52" fill="none"/>
        <text class="ov-banner-main"><textPath href="#ov-banner-arc-sp21" startOffset="50%" text-anchor="middle">SPANISH 21 — PLAYER 21 ALWAYS WINS</textPath></text>
      </svg>
      <div class="ov-banner-sub">No 10s in the deck — Blackjack pays 3 to 2</div>
      <div class="ov-banner-sub2">Dealer hits soft 17</div>
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
    return `<div class="row" style="justify-content:flex-end;gap:6px;margin-bottom:6px">${soundToggleHtml()}<button class="btn small" id="saltys-sp21-rules-btn">📖 House Rules</button></div>`;
  }
  function wireRulesButton(root) {
    const btn = root && root.querySelector("#saltys-sp21-rules-btn");
    if (btn) btn.addEventListener("click", showRulesModal);
  }

  function showRulesModal() {
    if (document.getElementById("saltys-sp21-rules")) return;
    const el = document.createElement("div");
    el.id = "saltys-sp21-rules";
    const surrenderPct = Math.round(SURRENDER_RETURN_FRACTION * 100);
    el.innerHTML = `
      <div class="box">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2>House Rules</h2>
          <button class="btn small" id="saltys-sp21-rules-close-x">✕</button>
        </div>
        <div class="rules-body">
          <h3>The deck</h3>
          <p>A Spanish deck is a standard 52-card deck with every numerical <b>10</b> removed — 48 cards per deck. Jacks, Queens, and Kings remain and still count as 10. Removing the 10s raises the house edge versus plain blackjack, which is why Spanish 21 offsets it with friendlier rules below.</p>

          <h3>How a round works</h3>
          <p>Place a bet, then you and the dealer each get two cards. Yours are dealt face up; one of the dealer's is dealt face down until every player has finished acting. You then choose to hit, stand, double down, split, or surrender. Once everyone's done, the dealer reveals their hidden card and plays out their hand by a fixed set of rules, and bets are paid or collected.</p>

          <h3>Card values</h3>
          <p>Number cards are worth their number, face cards (J/Q/K) are worth 10, and an Ace is worth 11 or 1 — whichever keeps your hand at 21 or under.</p>

          <h3>Blackjack &amp; the signature Spanish 21 rule</h3>
          <p>A natural blackjack (Ace + 10-value card as your first two cards) pays <b>3 to 2</b> and settles immediately. <b>Player 21 always beats dealer 21</b> — even a dealer 21 reached in more cards — unless the dealer's 21 is itself a natural blackjack, which only pushes against your own natural and beats every other hand outright.</p>

          <h3>Dealer rules</h3>
          <p>The dealer hits soft 17 (a hand with an Ace counted as 11, like Ace+6) and stands on hard 17 or higher. This is fixed; the dealer never chooses.</p>

          <h3>Doubling, splitting, surrender</h3>
          <p>You may double on any two-card total, and double again after splitting. Pairs can be re-split up to four hands total, and split Aces may still be hit or doubled — more liberal than standard blackjack. Before taking any other action on a hand, you can surrender it for <b>${surrenderPct}%</b> of that bet back.</p>

          <h3>Automatic Bonus 21 payouts</h3>
          <p>No side bet needed — these pay automatically whenever your hand qualifies, as long as it wasn't split or doubled:</p>
          <p><b>5-card 21</b> pays ${BONUS_21.fiveCard}:1. <b>6-card 21</b> pays ${BONUS_21.sixCard}:1. <b>7+-card 21</b> pays ${BONUS_21.sevenPlusCard}:1.</p>
          <p><b>6-7-8</b> or <b>7-7-7</b> (exactly three cards totaling 21) pays ${BONUS_21.mixed}:1 mixed suits, ${BONUS_21.suited}:1 same suit, or ${BONUS_21.spades}:1 if all three are spades.</p>

          <h3>Super Bonus</h3>
          <p>If you hold a <b>suited 7-7-7</b> and the dealer's up card is <b>any 7</b>, you win the Super Bonus — the biggest automatic payout on the table, on top of replacing the normal 7-7-7 bonus above.</p>

          <h3>Match the Dealer (side bet)</h3>
          <p>Placed before the deal. Compares your first two cards to the dealer's up card by rank:</p>
          <p>One card matches rank only: ${MATCH_DEALER_PAYOUTS.oneMatch}:1. Both cards match rank only: ${MATCH_DEALER_PAYOUTS.twoMatch}:1. One card matches rank <b>and</b> suit: ${MATCH_DEALER_PAYOUTS.oneSuitedMatch}:1. One suited match plus one plain match: ${MATCH_DEALER_PAYOUTS.mixedMatch}:1. Both cards match rank and suit: ${MATCH_DEALER_PAYOUTS.twoSuitedMatch}:1.</p>

          <h3>Progressive jackpot</h3>
          <p>0.05% of every wager placed here (and at Blackjack and Baccarat) feeds one shared jackpot pool, whether or not you bet on it. <b>Collecting it is separate</b> — place the flat <b>Jackpot</b> bet (${fmt(JACKPOT_SIDE_BET)} per hand) to be eligible that round. With it down, hitting the <b>Super Bonus</b> (suited 7-7-7 vs. a dealer 7) also pays a share of the shared pool, on top of its normal Super Bonus payout. Without the Jackpot bet, the Super Bonus still pays its normal amount — you just don't collect the extra. Like any other side bet, the Jackpot bet is lost on hands that don't qualify.</p>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:16px">
          <button class="btn primary" id="saltys-sp21-rules-close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.querySelector("#saltys-sp21-rules-close").addEventListener("click", close);
    el.querySelector("#saltys-sp21-rules-close-x").addEventListener("click", close);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
  }

  const LS_SOUND_ENABLED = "saltys_sp21_sound_enabled";
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
    return `<button class="btn small" id="saltys-sp21-sound-btn" title="Toggle dealing sound">${soundEnabled() ? "🔊" : "🔇"}</button>`;
  }
  function wireSoundToggle(root, renderFn) {
    const btn = root && root.querySelector("#saltys-sp21-sound-btn");
    if (btn) btn.addEventListener("click", () => { setSoundEnabled(!soundEnabled()); renderFn(); });
  }

  function ensureSpanish21SharedStyle() {
    if (document.getElementById("saltys-sp21-shared-style")) return;
    const s = document.createElement("style");
    s.id = "saltys-sp21-shared-style";
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700;800&family=JetBrains+Mono:wght@600;700;800&display=swap');

      #${OVERLAY_ID} .sp21-card-deal{ animation: sp21DealIn .35s ease-out; }
      @keyframes sp21DealIn{ from { transform: translateY(-30px) rotate(-8deg); opacity:0; } to { transform:none; opacity:1; } }

      #${OVERLAY_ID} .sp21-sidebet-strip{ display:flex; gap:6px; margin-top:4px; justify-content:center; flex-wrap:wrap; }
      #${OVERLAY_ID} .sp21-sidebet-chip{
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        width:40px; height:40px; border-radius:50%; border:2px solid #1a1400; position:relative;
        background:
          radial-gradient(circle at 32% 28%, rgba(255,255,255,.5), rgba(255,255,255,0) 42%),
          repeating-conic-gradient(from 0deg, #7c3aed 0deg 16deg, #ffffff26 16deg 20deg, #7c3aed 20deg 36deg);
        box-shadow:0 2px 5px rgba(0,0,0,.5);
      }
      #${OVERLAY_ID} .sp21-sidebet-chip.hit{ box-shadow:0 0 0 2px var(--success), 0 2px 8px rgba(47,191,113,.5); }
      #${OVERLAY_ID} .sp21-sidebet-label{ font-size:8px; font-weight:800; color:#fff; text-transform:uppercase; letter-spacing:.3px; text-shadow:0 1px 2px rgba(0,0,0,.7); }
      #${OVERLAY_ID} .sp21-sidebet-amt{ font:700 8px/1.2 "JetBrains Mono",monospace; color:#fff; text-shadow:0 1px 2px rgba(0,0,0,.7); }

      #${OVERLAY_ID} .sp21-jackpot-spot{
        position:relative; width:92px; height:92px; border-radius:50%; cursor:pointer;
        background:radial-gradient(circle at 50% 35%, rgba(124,58,237,.3), #10261c 75%);
        border:2px dashed var(--purple); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
        transition:box-shadow .15s ease, border-color .15s ease, transform .15s ease;
      }
      #${OVERLAY_ID} .sp21-jackpot-spot.active{ border-style:solid; border-color:var(--purple-bright); transform:translateY(-3px); box-shadow:0 0 0 3px rgba(124,58,237,.4); }
      #${OVERLAY_ID} .sp21-jackpot-spot .ov-bet-spot-label{ color:var(--purple-bright); }
      #${OVERLAY_ID} .sp21-jackpot-sub{ font:600 8px/1.2 "JetBrains Mono",monospace; color:var(--text-dim); text-align:center; padding:0 6px; }

      #${OVERLAY_ID} .sp21-jackpot-banner{
        text-align:center; font:800 20px/1 "Oswald",sans-serif; letter-spacing:1px; color:var(--gold-bright);
        text-shadow:0 0 14px rgba(244,207,101,.5); margin-bottom:8px; transition:transform .15s ease;
      }
      #${OVERLAY_ID} .sp21-jackpot-banner.pulse{ transform:scale(1.06); }

      #saltys-sp21-rules{
        position:fixed; inset:0; z-index:100002; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.75); font:14px/1.6 Inter,system-ui,sans-serif;
      }
      #saltys-sp21-rules .box{
        max-width:560px; max-height:82vh; overflow-y:auto; margin:20px; background:#12161d;
        border:1px solid #3a2c0f; border-radius:16px; padding:26px 24px; color:#f4f1ea;
      }
      #saltys-sp21-rules h2{ margin:0; font:800 20px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; }
      #saltys-sp21-rules h3{ margin:18px 0 6px; font:700 13px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; text-transform:uppercase; letter-spacing:.5px; }
      #saltys-sp21-rules h3:first-of-type{ margin-top:6px; }
      #saltys-sp21-rules p{ margin:0 0 8px; color:#c7cdd6; font-size:13px; }
      #saltys-sp21-rules b{ color:#f4f1ea; }
    `;
    document.head.appendChild(s);
  }

  // Evaluates the Match the Dealer side bet outcome for one hand's two
  // cards against the dealer's up card. Returns null (no match) or a key
  // into MATCH_DEALER_PAYOUTS.
  function evalMatchTheDealer(playerCards, dealerUp) {
    const matches = playerCards.map((c) => {
      if (c.r !== dealerUp.r) return null;
      return c.s === dealerUp.s ? "suited" : "plain";
    }).filter(Boolean);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0] === "suited" ? "oneSuitedMatch" : "oneMatch";
    // both matched
    if (matches[0] === "suited" && matches[1] === "suited") return "twoSuitedMatch";
    if (matches[0] === "plain" && matches[1] === "plain") return "twoMatch";
    return "mixedMatch";
  }

  // Evaluates the automatic Bonus 21 / Super Bonus payout multiplier for a
  // finished, unsplit, undoubled hand that totals exactly 21. `dealerUp`
  // is passed in to check the Super Bonus condition. Returns
  // { multiplier, isSuperBonus } or null if no bonus applies.
  function evalBonus21(cards, dealerUp) {
    const total = bjHandValue(cards).total;
    if (total !== 21) return null;

    if (cards.length === 3) {
      const ranks = cards.map((c) => c.r).sort();
      const is678 = JSON.stringify(ranks) === JSON.stringify(["6", "7", "8"]);
      const is777 = cards.every((c) => c.r === "7");
      if (is678 || is777) {
        const allSpades = cards.every((c) => c.s === "s");
        const allSameSuit = cards.every((c) => c.s === cards[0].s);
        // Super Bonus: suited 7-7-7 specifically, AND dealer up card is any 7.
        if (is777 && allSameSuit && dealerUp && dealerUp.r === "7") {
          return { multiplier: BONUS_21.spades, isSuperBonus: true };
        }
        if (allSpades) return { multiplier: BONUS_21.spades, isSuperBonus: false };
        if (allSameSuit) return { multiplier: BONUS_21.suited, isSuperBonus: false };
        return { multiplier: BONUS_21.mixed, isSuperBonus: false };
      }
    }
    if (cards.length === 5) return { multiplier: BONUS_21.fiveCard, isSuperBonus: false };
    if (cards.length === 6) return { multiplier: BONUS_21.sixCard, isSuperBonus: false };
    if (cards.length >= 7) return { multiplier: BONUS_21.sevenPlusCard, isSuperBonus: false };
    return null;
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
  const SoloSpanish21 = (function () {
    const SOLO_DEAL_CARD_MS = 450;
    let root = null, shoe = null, state = null, busy = false, chipScrollPos = 0;
    let jackpotUnsub = null, jackpotAmount = 0;
    const dealtAnimated = new Set();

    function freshState() {
      return {
        phase: "betting", selectedSeats: [], betPerHand: Math.min(100, MAX_BET),
        sideMatchPerHand: 0, jackpotBetPerHand: false, activeBetTarget: "main", selectedChip: 100,
        hands: [], dealer: [], dealerHoleHidden: true,
        activeHandIndex: 0, lastResults: null,
        lastOpeningBet: null,
      };
    }
    function getBetFor(target) {
      if (target === "match") return state.sideMatchPerHand;
      return state.betPerHand;
    }
    function setBetFor(target, v) {
      if (target === "match") state.sideMatchPerHand = v;
      else state.betPerHand = v;
    }
    function newHand(cards, bet, sideMatch = 0, sideJackpot = 0, seatIdx) {
      return {
        cards, bet, status: "active", result: null, acted: false, isSplitAces: false,
        fromSplit: false, doubled: false,
        sideBets: { match: sideMatch, jackpot: sideJackpot }, sideBetResults: {}, seatIdx,
        bonusProfit: 0, jackpotProfit: 0,
      };
    }

    async function startDeal() {
      if (busy) return;
      if (!state.selectedSeats.length) { toast("Select at least one seat to play."); return; }
      const bet = clamp(Math.round(state.betPerHand), MIN_BET, MAX_BET);
      const match = clamp(Math.round(state.sideMatchPerHand || 0), 0, MAX_BET);
      const jp = state.jackpotBetPerHand ? JACKPOT_SIDE_BET : 0;
      const numHands = state.selectedSeats.length;
      const total = (bet + match + jp) * numHands;
      if (total > Balance.current) { toast("Not enough balance for that many seats at this bet."); return; }
      busy = true; render();
      try {
        await Balance.applyDelta(-total, "solo_sp21_deal_multi");
        state.lastOpeningBet = {
          selectedSeats: [...state.selectedSeats],
          betPerHand: bet,
          sideMatchPerHand: match,
          jackpotBetPerHand: state.jackpotBetPerHand,
        };
        if (window.SaltyJackpot) window.SaltyJackpot.contribute(total, "spanish21");
      }
      catch (e) { toast("Bet failed."); busy = false; render(); return; }
      if (!shoe) shoe = new Shoe(6, 0.25, freshSpanishDeck);
      dealtAnimated.clear();
      const seatOrder = [...state.selectedSeats].sort((a, b) => a - b);
      state.hands = seatOrder.map((seatIdx) => newHand([], bet, match, jp, seatIdx));
      state.dealer = [];
      state.phase = "player";
      state.dealerHoleHidden = true;
      state.activeHandIndex = 0;
      state.lastResults = null;
      render();
      for (let round = 0; round < 2; round++) {
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
      // Match the Dealer resolves immediately — it only depends on the
      // player's first two cards and the dealer's up card, both already
      // known here, same timing Baccarat/Blackjack use for their own
      // immediate side bets.
      for (const hand of state.hands) {
        if (hand.sideBets.match > 0) {
          hand.sideBetResults.match = evalMatchTheDealer(hand.cards, state.dealer[0]);
        }
      }
      await resolveDealerPeek();
      busy = false;
      render();
    }
    function restoreOpeningBet(snapshot, multiplier = 1) {
      if (!snapshot) return false;

      state.selectedSeats = [...snapshot.selectedSeats];
      state.betPerHand = clamp(
        Math.round(snapshot.betPerHand * multiplier),
        MIN_BET,
        MAX_BET
      );
      state.sideMatchPerHand = clamp(
        Math.round(snapshot.sideMatchPerHand * multiplier),
        0,
        MAX_BET
      );

      // Jackpot is a fixed qualifying stake, not a variable wager.
      state.jackpotBetPerHand = snapshot.jackpotBetPerHand;
      state.activeBetTarget = "main";
      return true;
    }

    async function rebet(multiplier = 1) {
      if (busy || !state.lastOpeningBet) return;

      const restored = restoreOpeningBet(state.lastOpeningBet, multiplier);
      if (!restored) return;

      const seatCount = state.selectedSeats.length;
      const jackpotPerHand = state.jackpotBetPerHand ? JACKPOT_SIDE_BET : 0;
      const openingTotal =
        (state.betPerHand + state.sideMatchPerHand + jackpotPerHand) *
        seatCount;

      if (openingTotal > Balance.current) {
        toast(`Not enough balance to ${multiplier === 2 ? "double and rebet" : "rebet"}.`);
        return;
      }

      await startDeal();
    }

    // The dealer peek: checks the hole card, resolves any natural
    // blackjacks (yours, the dealer's, or both) immediately, exactly like
    // standard blackjack. Spanish 21's "player 21 always wins" rule only
    // applies to 21s reached with MORE than two cards, and is settled
    // later in settle() once every hand has finished acting — a two-card
    // 21 is always a natural and is handled right here, the same instant
    // it's known.
    async function resolveDealerPeek() {
      const dealerBJ = isBlackjack(state.dealer);
      for (const hand of state.hands) {
        const handBJ = isBlackjack(hand.cards);
        if (dealerBJ) {
          hand.acted = true;
          if (handBJ) {
            hand.status = "push"; hand.result = "push"; hand.profit = 0;
            await Balance.applyDelta(hand.bet, "solo_sp21_instant_push");
          } else {
            hand.status = "push"; hand.result = "lose"; hand.profit = -hand.bet;
          }
        } else if (handBJ) {
          hand.acted = true;
          hand.status = "blackjack"; hand.result = "blackjack"; hand.profit = Math.round(hand.bet * 1.5);
          await Balance.applyDelta(hand.bet + hand.profit, "solo_sp21_instant_blackjack");
        }
      }
      advanceIfResolved();
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
      if (action === "hit") {
        hand.cards.push(shoe.draw());
        hand.acted = true;
        render();
        playDealSound();
        await delay(SOLO_DEAL_CARD_MS);
        const v = bjHandValue(hand.cards).total;
        if (v > 21) hand.status = "bust";
        else if (v === 21 || hand.isSplitAces) hand.status = "stood";
      } else if (action === "stand") {
        hand.status = "stood";
      } else if (action === "double") {
        if (Balance.current < hand.bet) { toast("Not enough balance to double."); busy = false; render(); return; }
        await Balance.applyDelta(-hand.bet, "solo_sp21_double_multi");
        hand.bet *= 2;
        hand.doubled = true;
        hand.cards.push(shoe.draw());
        render();
        playDealSound();
        await delay(SOLO_DEAL_CARD_MS);
        hand.status = bjHandValue(hand.cards).total > 21 ? "bust" : "stood";
      } else if (action === "split") {
        const [c0, c1] = hand.cards;
        if (Balance.current < hand.bet) { toast("Not enough balance to split."); busy = false; render(); return; }
        await Balance.applyDelta(-hand.bet, "solo_sp21_split_multi");
        const isAces = c0.r === "A";
        const newH = newHand([c1], hand.bet, 0, 0, hand.seatIdx);
        newH.isSplitAces = isAces;
        newH.fromSplit = true;
        hand.cards = [c0];
        hand.isSplitAces = isAces;
        hand.fromSplit = true;
        state.hands.splice(state.activeHandIndex + 1, 0, newH);
        render();
        await delay(SOLO_DEAL_CARD_MS);
        hand.cards.push(shoe.draw());
        render();
        playDealSound();
        await delay(SOLO_DEAL_CARD_MS);
        newH.cards.push(shoe.draw());
        render();
        playDealSound();
        await delay(SOLO_DEAL_CARD_MS);
        // Spanish 21 allows hitting/doubling split Aces (unlike standard
        // blackjack, which locks a split-Ace hand after exactly one more
        // card) — so, unlike Blackjack's module, we do NOT force these to
        // "stood" here; they just continue like any other hand.
      } else if (action === "surrender") {
        if (hand.acted || hand.cards.length !== 2 || hand.fromSplit) { busy = false; render(); return; }
        await Balance.applyDelta(Math.round(hand.bet * SURRENDER_RETURN_FRACTION), "solo_sp21_surrender");
        hand.status = "surrender"; hand.result = "surrender"; hand.acted = true;
        hand.profit = -Math.round(hand.bet * (1 - SURRENDER_RETURN_FRACTION));
      }
      advanceIfResolved();
      busy = false;
      render();
    }

    async function runDealer() {
      state.phase = "dealer";
      state.dealerHoleHidden = false;
      render();
      await delay(SOLO_DEAL_CARD_MS);
      const anyLive = state.hands.some((h) => h.status === "stood");
      if (anyLive) {
        while (true) {
          const { total, soft } = bjHandValue(state.dealer);
          if (total > 21 || total > 17 || (total === 17 && (!soft || DEALER_STANDS_SOFT_17))) break;
          state.dealer.push(shoe.draw());
          render();
          playDealSound();
          await delay(SOLO_DEAL_CARD_MS);
        }
      }
      await settle();
    }

    async function settle() {
      state.phase = "settled";
      const dealerVal = bjHandValue(state.dealer).total;
      const dealerBJ = isBlackjack(state.dealer);
      const dealerBust = dealerVal > 21;
      const dealerUp = state.dealer[0];
      let totalProfit = 0, handProfitTotal = 0, sideBetProfitTotal = 0, bonusProfitTotal = 0, jackpotProfitTotal = 0;

      for (const hand of state.hands) {
        let payout = 0;
        if (hand.result != null) {
          // Already resolved at deal time (natural blackjack, or a push
          // against a dealer blackjack) — don't re-settle here.
        } else if (hand.status === "bust") {
          hand.result = "lose";
        } else {
          const val = bjHandValue(hand.cards).total;
          if (dealerBJ) {
            hand.result = "lose";
          } else if (val === 21 && dealerVal === 21) {
            // Spanish 21's signature rule: player 21 always beats dealer
            // 21, no matter how many cards either side used to get there
            // (dealer blackjack is handled above, before this branch, so
            // it can't reach here).
            hand.result = "win"; payout = hand.bet * 2;
          } else if (dealerBust || val > dealerVal) {
            hand.result = "win"; payout = hand.bet * 2;
          } else if (val === dealerVal) {
            hand.result = "push"; payout = hand.bet;
          } else {
            hand.result = "lose";
          }
        }
        if (payout > 0) await Balance.applyDelta(payout, "solo_sp21_settle_multi");
        const mainProfit = hand.profit != null ? hand.profit : payout - hand.bet;
        if (hand.profit == null) hand.profit = mainProfit;
        handProfitTotal += mainProfit;

        // Automatic Bonus 21 / Super Bonus — never on split or doubled
        // hands, and only on a hand that actually reached exactly 21
        // (busted/lost hands never qualify).
        let bonusProfit = 0;
        if (!hand.fromSplit && !hand.doubled && hand.result !== "lose" && hand.result !== "surrender") {
          const bonus = evalBonus21(hand.cards, dealerUp);
          if (bonus) {
            const win = Math.round(hand.bet * bonus.multiplier);
            await Balance.applyDelta(win, "solo_sp21_bonus21");
            bonusProfit += win;
            hand.bonusHit = bonus.isSuperBonus ? "Super Bonus!" : "Bonus 21";

            if (bonus.isSuperBonus && hand.sideBets.jackpot > 0 && window.SaltyJackpot) {
              const jpPayout = await window.SaltyJackpot.award(JACKPOT_TIER, "spanish21", "Super Bonus: suited 7-7-7 vs dealer 7", true);
              if (jpPayout > 0) {
                await Balance.applyDelta(hand.sideBets.jackpot + jpPayout, "solo_sp21_jackpot_win");
                hand.jackpotProfit = jpPayout;
                jackpotProfitTotal += jpPayout;
              } else {
                hand.jackpotProfit = -hand.sideBets.jackpot;
                jackpotProfitTotal -= hand.sideBets.jackpot;
              }
            } else if (hand.sideBets.jackpot > 0) {
              hand.jackpotProfit = -hand.sideBets.jackpot;
              jackpotProfitTotal -= hand.sideBets.jackpot;
            }
          } else if (hand.sideBets.jackpot > 0) {
            hand.jackpotProfit = -hand.sideBets.jackpot;
            jackpotProfitTotal -= hand.sideBets.jackpot;
          }
        } else if (hand.sideBets.jackpot > 0) {
          hand.jackpotProfit = -hand.sideBets.jackpot;
          jackpotProfitTotal -= hand.sideBets.jackpot;
        }
        hand.bonusProfit = bonusProfit;
        bonusProfitTotal += bonusProfit;

        // Match the Dealer side bet.
        let sbProfit = 0;
        const matchStake = hand.sideBets.match;
        if (matchStake > 0) {
          const r = hand.sideBetResults.match;
          if (r) {
            const win = matchStake * MATCH_DEALER_PAYOUTS[r] + matchStake;
            await Balance.applyDelta(win, "solo_sp21_match_win");
            sbProfit += win - matchStake;
          } else {
            sbProfit -= matchStake;
          }
        }
        hand.profit += sbProfit + bonusProfit + (hand.jackpotProfit || 0);
        sideBetProfitTotal += sbProfit;
        totalProfit += mainProfit + sbProfit + bonusProfit + (hand.jackpotProfit || 0);
      }

      state.lastResults = { totalProfit, handProfitTotal, sideBetProfitTotal, bonusProfitTotal, jackpotProfitTotal };
      render();
    }

    function cardEl(c, hidden) {
      if (hidden) return `<div class="card back" data-key="hidden"></div>`;
      const isNew = c._key != null && !dealtAnimated.has(c._key);
      if (isNew) dealtAnimated.add(c._key);
      return `<div class="card ${cardColor(c)} ${isNew ? "sp21-card-deal" : ""}" data-key="${c._key ?? ""}"><span>${c.r}</span><span class="br">${SUIT_GLYPH[c.s]}</span></div>`;
    }

    function renderSoloOvalTable() {
      const dealerVal = bjHandValue(state.dealer);
      const dealerShown = state.dealerHoleHidden ? null : dealerVal;
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
          const v = bjHandValue(hand.cards);
          const label = hand.status === "bust" ? `${v.total} Bust` : `${v.total}${v.soft ? "s" : ""}`;
          const profitLabel = state.phase === "settled" && hand.profit != null
            ? `<div class="ov-profit ${hand.profit > 0 ? "win" : hand.profit < 0 ? "lose" : ""}">${hand.profit >= 0 ? "+" : ""}${fmt(hand.profit)}</div>` : "";
          const sideChips = [];
          if (hand.sideBets && hand.sideBets.match > 0) {
            const r = hand.sideBetResults && hand.sideBetResults.match;
            sideChips.push(`<div class="sp21-sidebet-chip ${r ? "hit" : ""}" title="Match the Dealer: ${fmt(hand.sideBets.match)}${r ? " · " + r : ""}"><span class="sp21-sidebet-label">MTD</span><span class="sp21-sidebet-amt">${fmt(hand.sideBets.match)}</span></div>`);
          }
          if (hand.sideBets && hand.sideBets.jackpot > 0) {
            const won = hand.jackpotProfit > 0;
            sideChips.push(`<div class="sp21-sidebet-chip ${won ? "hit" : ""}" title="Jackpot: ${fmt(hand.sideBets.jackpot)}"><span class="sp21-sidebet-label">JP</span><span class="sp21-sidebet-amt">${fmt(hand.sideBets.jackpot)}</span></div>`);
          }
          const sideBetHtml = sideChips.length ? `<div class="sp21-sidebet-strip">${sideChips.join("")}</div>` : "";
          const bonusTag = hand.bonusHit ? ` 🎉 ${hand.bonusHit}` : "";
          const resultOverlay = hand.status === "bust" ? `<div class="ov-result-overlay">${v.total} – Bust</div>`
            : hand.result === "blackjack" ? `<div class="ov-result-overlay">Blackjack!</div>`
            : bonusTag ? `<div class="ov-result-overlay">${bonusTag.trim()}</div>` : "";
          const winBadge = hand.result ? `<div class="ov-win-badge ${hand.profit > 0 ? "win" : hand.profit < 0 ? "lose" : "push"}">
              ${hand.profit > 0 ? "Win" : hand.profit < 0 ? "Lose" : "Push"}
            </div>` : "";
          return `<div class="ov-subhand ${active ? "active" : ""}" style="opacity:${state.phase === "player" && !active ? 0.6 : 1}">
            <div class="ov-hand-ring"><div class="ov-hand">${hand.cards.map((c) => cardEl(c, false)).join("")}</div>${resultOverlay}</div>
            ${chipStackHtml(hand.bet, { size: 20 })}
            <div class="ov-betlabel">${label}${hand.result ? " · " + hand.result : ""}</div>
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
            ${line("Hands", r.handProfitTotal)}
            ${r.sideBetProfitTotal !== 0 ? line("Match the Dealer", r.sideBetProfitTotal) : ""}
            ${r.bonusProfitTotal !== 0 ? line("Bonus 21", r.bonusProfitTotal) : ""}
            ${r.jackpotProfitTotal !== 0 ? line("Jackpot", r.jackpotProfitTotal) : ""}
            <div class="ov-summary-line total"><span>Total</span><span>${r.totalProfit >= 0 ? "+" : ""}${fmt(r.totalProfit)}</span></div>
          </div>
        </div>`;
      })() : "";

      return `<div class="ov-wrap"><div class="ov-table">
          ${tableBannerHtml()}
          ${shoeDecorHtml()}
          <div class="ov-dealer">
            ${dealerShown ? `<div class="ov-dealer-total">${dealerShown.total}${dealerShown.soft ? "s" : ""}</div>` : ""}
            <div class="ov-dealer-hand">${state.dealer.map((c, i) => cardEl(c, state.dealerHoleHidden && i === 1)).join("")}</div>
            <div class="ov-dealer-label">Dealer's Cards</div>
          </div>
          ${state.phase === "player" ? `<div class="ov-hint">Playing hand ${state.activeHandIndex + 1} of ${state.hands.length}</div>` : ""}
          ${seatHtml}
          ${roundSummaryHtml}
        </div></div>`;
    }

    function render() {
      if (!root) return;
      ensureSpanish21SharedStyle();
      const jackpotBanner = `<div class="sp21-jackpot-banner" id="sp21-jackpot-banner">PROGRESSIVE JACKPOT: ${fmtJackpot(jackpotAmount)}</div>`;

      if (state.phase === "betting") {
        const seatPickHtml = SEAT_POS.map((pos, i) => {
          const picked = state.selectedSeats.includes(i);
          return `<div class="ov-seat" data-seat="${i}" style="left:${pos.left}%;top:${pos.top}%;cursor:pointer">
            <div class="ov-cardslot ${picked ? "" : "empty"}" style="transform:rotate(${pos.rotate});${picked ? "border-color:var(--gold)" : ""}"></div>
          </div>`;
        }).join("");
        const target = state.activeBetTarget || "main";
        const betRailHtml = `<div class="ov-bet-rail">
          ${betSpotHtml("main", state.betPerHand, target === "main", "Bet", false)}
          ${betSpotHtml("match", state.sideMatchPerHand, target === "match", "Match Dealer", true)}
          ${jackpotSpotHtml(state.jackpotBetPerHand)}
        </div>`;
        const totalWager = (state.betPerHand + (state.sideMatchPerHand || 0) + (state.jackpotBetPerHand ? JACKPOT_SIDE_BET : 0)) * state.selectedSeats.length;
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
              "sp21",
              getBetFor(state.activeBetTarget || "main"),
              busy,
              { selectedChip: state.selectedChip }
            )}
            <div class="row center" style="gap:10px;flex-wrap:wrap">
              <span class="muted">${state.selectedSeats.length} seat${state.selectedSeats.length === 1 ? "" : "s"} · Total wager: ${fmt(totalWager)}</span>
              <button class="btn primary" id="sp21-deal" ${busy || !state.selectedSeats.length || !state.betPerHand ? "disabled" : ""}>Deal</button>
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

        const jackpotToggle = root.querySelector("#sp21-jackpot-toggle");
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
          "sp21",
          () => getBetFor(state.activeBetTarget || "main"),
          (value) => {
            setBetFor(state.activeBetTarget || "main", value);
            render();
          },
          {
            getSelectedChip: () => state.selectedChip,
            setSelectedChip: (value) => {
              state.selectedChip = value;
            },
            onClear: () => {
              state.betPerHand = 0;
              state.sideMatchPerHand = 0;
              state.jackpotBetPerHand = false;
              render();
            },
            minBet: 0,
            maxBet: MAX_BET,
          }
        );
        root.querySelector("#sp21-deal").addEventListener("click", startDeal);
        return;
      }

      let controls;
      if (state.phase === "player") {
        const hand = currentHand();
        const canDouble = hand && hand.cards.length === 2 && Balance.current >= hand.bet;
        const canSplit = hand && hand.cards.length === 2 && isSplittablePair(hand.cards[0], hand.cards[1]) && Balance.current >= hand.bet &&
          state.hands.filter((h) => h.seatIdx === hand.seatIdx).length < SOLO_MAX_HANDS_PER_SEAT;
        const canSurrender = hand && hand.cards.length === 2 && !hand.acted && !hand.fromSplit;
        controls = `<div class="row center">
          <button class="btn primary" id="sp21-hit" ${busy ? "disabled" : ""}>Hit</button>
          <button class="btn" id="sp21-stand" ${busy ? "disabled" : ""}>Stand</button>
          <button class="btn" id="sp21-double" ${busy || !canDouble ? "disabled" : ""} title="${!canDouble && hand && Balance.current < hand.bet ? "Not enough balance to double" : ""}">Double</button>
          <button class="btn" id="sp21-split" ${busy || !canSplit ? "disabled" : ""}>Split</button>
          <button class="btn" id="sp21-surrender" ${busy || !canSurrender ? "disabled" : ""} title="Forfeit the hand, get half your bet back">Surrender</button>
        </div>`;
      } else if (state.phase === "settled") {
        const prior = state.lastOpeningBet;
        const rebetAmount = prior ? prior.betPerHand : state.betPerHand;
        const hasSides = prior ? (prior.sideMatchPerHand || prior.jackpotBetPerHand) : (state.sideMatchPerHand || state.jackpotBetPerHand);
        controls = `<div class="row center">
          <button class="btn primary" id="sp21-rebet">Rebet ${fmt(rebetAmount)}${hasSides ? " + sides" : ""}</button>
          <button class="btn gold" id="sp21-double-rebet">2× Bet & Rebet</button>
          <button class="btn" id="sp21-again">Change Bet</button>
        </div>`;
      } else {
        controls = `<div class="center muted">Dealer playing…</div>`;
      }
      root.innerHTML = jackpotBanner + rulesButtonRowHtml() + renderSoloOvalTable() + `<div class="mt16">${controls}</div>`;
      wireRulesButton(root);
      wireSoundToggle(root, render);
      if (state.phase === "player") {
        root.querySelector("#sp21-hit").addEventListener("click", () => act("hit"));
        root.querySelector("#sp21-stand").addEventListener("click", () => act("stand"));
        root.querySelector("#sp21-double").addEventListener("click", () => act("double"));
        root.querySelector("#sp21-split").addEventListener("click", () => act("split"));
        root.querySelector("#sp21-surrender").addEventListener("click", () => act("surrender"));
      } else if (state.phase === "settled") {
        root.querySelector("#sp21-again").addEventListener("click", () => {
          const seats = state.selectedSeats, b = state.betPerHand, m = state.sideMatchPerHand, jp = state.jackpotBetPerHand;
          state = freshState();
          state.selectedSeats = seats;
          state.betPerHand = b;
          state.sideMatchPerHand = m;
          state.jackpotBetPerHand = jp;
          render();
        });
        root.querySelector("#sp21-rebet").addEventListener("click", () => rebet(1));

        const doubleRebetBtn = root.querySelector("#sp21-double-rebet");
        if (doubleRebetBtn) doubleRebetBtn.addEventListener("click", () => rebet(2));
      }
    }

    return {
      label: "Spanish 21",
      icon: "♠️",
      order: 3,
      mount(el) {
        root = el;
        state = freshState();
        if (window.SaltyJackpot) {
          jackpotUnsub = window.SaltyJackpot.subscribe((pool) => {
            jackpotAmount = pool.amount;
            const el2 = document.getElementById("sp21-jackpot-banner");
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

  window.SaltyCore.GAME_MODULES.spanish21 = SoloSpanish21;
})();
