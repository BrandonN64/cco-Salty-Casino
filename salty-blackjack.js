// ==UserScript==
// Salty's Casino — BLACKJACK MODULE (Solo)
// Loaded via @require, after salty-core.js and salty-jackpot.js, by the
// main salty-casino.user.js loader. Registers itself into
// window.SaltyCore.GAME_MODULES.blackjack so it shows up automatically on
// the home grid.
//
// Solo play only for now: up to 5 hands at once vs. one dealer, no waiting
// on anyone. Live Tables have been removed for the time being — get solo
// fully working first, add live back later.
//
// Feeds the shared cross-game progressive jackpot (window.SaltyJackpot)
// with 0.05% of every wager placed here, and pays out of that same pool on
// a suited three-of-a-kind (your two cards + the dealer's up card, all
// matching rank AND suit — the same "suitedTrips" condition the 21+3 side
// bet already pays its top rate on) — but only for hands that placed the
// flat "Jackpot" side bet that round, same convention as Baccarat and
// every real casino progressive (Caribbean Stud, Casino Hold'em,
// progressive Blackjack side bets like Blazing 7s): the pool grows from
// everyone's play, only collectible by whoever bought a shot at it that
// hand.
//
// A suited NATURAL BLACKJACK was the first draft of this trigger, but at
// ~1 in 84 hands it's far too common for a jackpot (that's ordinary
// side-bet rarity, not jackpot rarity) — a suited three-of-a-kind is
// roughly 1 in 4,800 hands, which actually earns the name.
//
// NOTE (CSS): the shared casino-chrome classes this file used to define
// (.chip-stack-*, .ov-bet-rail, .ov-bet-spot*, .ov-chip-rail, .ov-banner*,
// .ov-corner-deco*, .ov-mini-card, .ov-discard-tray) have been moved into
// salty-core.js's ensureStyle(), since Baccarat and Mines render markup
// using those exact classnames too but never defined them themselves —
// they only worked after visiting Blackjack once, which is what injected
// this style block. Only genuinely Blackjack-only classes (lbj-*, sbj-*,
// the House Rules modal) remain here now.
// ==/UserScript==
(function () {
  "use strict";

  const {
    MIN_BET, MAX_BET, GAME_MODULES, OVERLAY_ID,
    Balance, Shoe, bjHandValue, isBlackjack, isSplittablePair, cardColor, RANK_ORDER, SUIT_GLYPH,
    clamp, delay, fmt, chipColor, chipStyle, chipLabel, CHIP_DENOMS, toast,
  } = window.SaltyCore;

  const SIDE_BET_PAYTABLES = {
    perfectPairs: { mixed: 5, colored: 12, perfect: 25 },
    twentyPlusThree: { flush: 5, straight: 10, threeKind: 30, straightFlush: 40, suitedTrips: 100 },
  };
  const DEALER_STANDS_SOFT_17 = true;
  const SURRENDER_RETURN_FRACTION = 0.5; // late surrender: forfeit half the bet, hand ends immediately
  const SOLO_MAX_HANDS_PER_SEAT = 15; // original hand + up to 14 splits

  // Flat, non-scaling qualifying bet for the shared progressive jackpot —
  // matches Baccarat's convention exactly. Placed per hand, since each seat
  // here is its own independent hand with its own bet/side-bets already.
  const JACKPOT_SIDE_BET = 250_000;
  // Suited three-of-a-kind (~1-in-4,800 hands) is far rarer than a suited
  // natural blackjack (~1-in-84) — rare enough to earn the bigger tier.
  const JACKPOT_TIER = "major";

  // The jackpot pool grows in tiny fractions of a token per round (0.05%
  // of the wager), so rounding it to a whole number for display would
  // make it look completely static for dozens of rounds. Two decimals
  // makes the growth actually visible round to round.
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
    return `<div class="sbj-jackpot-spot ${active ? "active" : ""}" id="sbj-jackpot-toggle" title="Flat ${fmt(JACKPOT_SIDE_BET)} bet per hand — required to collect the progressive jackpot this round">
      <div class="ov-bet-spot-label">💰 Jackpot</div>
      <div class="sbj-jackpot-sub">${fmt(JACKPOT_SIDE_BET)} flat / hand</div>
      ${active ? `<div class="ov-bet-spot-amt">ON</div>` : `<div class="ov-bet-spot-amt" style="color:var(--text-dim)">OFF</div>`}
    </div>`;
  }

  function tableBannerHtml() {
    const insurancePayoutRatio = "2 TO 1";
    const blackjackPayoutRatio = "3 TO 2";
    return `
      <svg class="ov-banner" viewBox="0 0 440 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path id="ov-banner-arc" d="M 15,52 Q 220,8 425,52" fill="none"/>
        <text class="ov-banner-main"><textPath href="#ov-banner-arc" startOffset="50%" text-anchor="middle">BLACKJACK PAYS ${blackjackPayoutRatio}</textPath></text>
      </svg>
      <div class="ov-banner-sub">Dealer must draw to 16 and stand on all 17s</div>
      <div class="ov-banner-sub2">Insurance pays ${insurancePayoutRatio}</div>
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
    return `<div class="row" style="justify-content:flex-end;gap:6px;margin-bottom:6px">${soundToggleHtml()}<button class="btn small" id="saltys-bj-rules-btn">📖 House Rules</button></div>`;
  }
  function wireRulesButton(root) {
    const btn = root && root.querySelector("#saltys-bj-rules-btn");
    if (btn) btn.addEventListener("click", showRulesModal);
  }

  function showRulesModal() {
    if (document.getElementById("saltys-bj-rules")) return;
    const el = document.createElement("div");
    el.id = "saltys-bj-rules";
    const surrenderPct = Math.round(SURRENDER_RETURN_FRACTION * 100);
    el.innerHTML = `
      <div class="box">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2>House Rules</h2>
          <button class="btn small" id="saltys-bj-rules-close-x">✕</button>
        </div>
        <div class="rules-body">
          <h3>How a round works</h3>
          <p>Place a bet, then you and the dealer each get two cards. Yours are dealt face up; one of the dealer's is dealt face down until every player has finished acting. You then choose to hit, stand, double down, split, or surrender. Once everyone's done, the dealer reveals their hidden card and plays out their hand by a fixed set of rules — no decisions, just the rules below — and bets are paid or collected.</p>

          <h3>Card values</h3>
          <p>Number cards are worth their number, face cards (J/Q/K) are worth 10, and an Ace is worth 11 or 1 — whichever keeps your hand at 21 or under.</p>

          <h3>Blackjack</h3>
          <p>An Ace plus any 10-value card as your first two cards is a natural blackjack. It pays <b>3 to 2</b> and settles immediately — unless the dealer also has blackjack, in which case it's a push (your bet back, no profit). A 21 reached any other way (after a hit, or on a split hand) is just a strong 21, paid at the normal 1:1 win rate, not the blackjack bonus.</p>

          <h3>Dealer rules</h3>
          <p>The dealer must draw to 16 and stand on all 17s${DEALER_STANDS_SOFT_17 ? ", including a <b>soft 17</b> (a hand with an Ace counted as 11, like Ace+6)" : " — except a soft 17, which the dealer is required to hit"}. This is fixed; the dealer never chooses.</p>

          <h3>Doubling down</h3>
          <p>On your first two cards, you can double your bet in exchange for exactly one more card, then your turn ends automatically.</p>

          <h3>Splitting</h3>
          <p>If your first two cards match in value (like two 8s, or a 10 and a King), you can split them into two separate hands, each getting its own additional card and its own bet equal to your original. Splitting Aces deals exactly one more card to each and ends your turn immediately on both.</p>

          <h3>Surrender</h3>
          <p>Before taking any other action on a hand — no hits, no double, no split — you can surrender it: the hand ends immediately and you get <b>${surrenderPct}%</b> of that bet back. Not available on a hand created by splitting.</p>

          <h3>Insurance</h3>
          <p>If the dealer's face-up card is an Ace, you're offered insurance for up to half your original bet. It pays <b>2 to 1</b> if the dealer does have blackjack, covering the loss on your main hand; if the dealer doesn't, the insurance bet is simply lost.</p>

          <h3>Side bets</h3>
          <p>Placed before the deal, alongside your main bet:</p>
          <p><b>Perfect Pairs</b> — pays out if your first two cards are a pair (same rank), scaling up for a same-color pair or an exact suited match.</p>
          <p><b>21+3</b> — pays out if your two cards plus the dealer's face-up card form a poker hand: a flush, straight, three of a kind, straight flush, or suited trips — suited trips (three matching cards, same rank AND suit) is the rarest and pays the most.</p>

          <h3>Progressive jackpot</h3>
          <p>0.05% of every wager placed here (and at Baccarat) feeds one shared jackpot pool, whether or not you bet on it. <b>Collecting it is separate</b> — place the flat <b>Jackpot</b> bet (${fmt(JACKPOT_SIDE_BET)} per hand) to be eligible that round. With it down, a <b>suited three-of-a-kind</b> — your two cards plus the dealer's up card, all the same rank AND suit, the same rare "suited trips" condition 21+3 already pays its top rate on — pays out a share of the pool. Without the Jackpot bet, that hand still resolves normally; you just don't collect the extra. Like any other side bet, the Jackpot bet is lost on hands that don't qualify. This is deliberately a much rarer trigger than a plain suited natural blackjack (roughly 1 in 4,800 hands vs. 1 in 84) so it actually feels like a jackpot instead of a frequent bonus. The pool itself grows slowly by design (a fraction of a token per round on typical bets) — the banner shows two decimal places so that growth is actually visible.</p>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:16px">
          <button class="btn primary" id="saltys-bj-rules-close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.querySelector("#saltys-bj-rules-close").addEventListener("click", close);
    el.querySelector("#saltys-bj-rules-close-x").addEventListener("click", close);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
  }

  const LS_SOUND_ENABLED = "saltys_bj_sound_enabled";
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
    return `<button class="btn small" id="saltys-bj-sound-btn" title="Toggle dealing sound">${soundEnabled() ? "🔊" : "🔇"}</button>`;
  }
  function wireSoundToggle(root, renderFn) {
    const btn = root && root.querySelector("#saltys-bj-sound-btn");
    if (btn) btn.addEventListener("click", () => { setSoundEnabled(!soundEnabled()); renderFn(); });
  }

  // -----------------------------------------------------------------------
  // Only genuinely Blackjack-only classes live here now: lbj-* (side-bet
  // chips, deal animation, timer), sbj-* (this module's own jackpot spot/
  // banner naming), and the #saltys-bj-rules modal. Everything shared with
  // Baccarat/Mines (chip-stack-*, ov-bet-rail, ov-bet-spot*, ov-chip-rail,
  // ov-banner*, ov-corner-deco*, ov-mini-card, ov-discard-tray) moved to
  // salty-core.js's ensureStyle() — see the NOTE at the top of this file.
  // -----------------------------------------------------------------------
  function ensureBlackjackSharedStyle() {
    if (document.getElementById("saltys-bj-shared-style")) return;
    const s = document.createElement("style");
    s.id = "saltys-bj-shared-style";
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700;800&family=JetBrains+Mono:wght@600;700;800&display=swap');

      #${OVERLAY_ID} .lbj-card-deal{ animation: lbjDealIn .35s ease-out; }
      @keyframes lbjDealIn{ from { transform: translateY(-30px) rotate(-8deg); opacity:0; } to { transform:none; opacity:1; } }
      #${OVERLAY_ID} .lbj-timer{ font-family: "JetBrains Mono", monospace; font-weight:700; color:var(--gold-bright); }

      #${OVERLAY_ID} .lbj-sidebet-row{ display:flex; gap:8px; margin-top:6px; }
      #${OVERLAY_ID} .lbj-sidebet-row input{ width:70px; }
      #${OVERLAY_ID} .lbj-sidebet-strip{ display:flex; gap:6px; margin-top:4px; justify-content:center; }
      #${OVERLAY_ID} .lbj-sidebet-chip{
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        width:40px; height:40px; border-radius:50%; border:2px solid #1a1400; position:relative;
        background:
          radial-gradient(circle at 32% 28%, rgba(255,255,255,.5), rgba(255,255,255,0) 42%),
          repeating-conic-gradient(from 0deg, #7c3aed 0deg 16deg, #ffffff26 16deg 20deg, #7c3aed 20deg 36deg);
        box-shadow:0 2px 5px rgba(0,0,0,.5);
      }
      #${OVERLAY_ID} .lbj-sidebet-chip.hit{ box-shadow:0 0 0 2px var(--success), 0 2px 8px rgba(47,191,113,.5); }
      #${OVERLAY_ID} .lbj-sidebet-label{ font-size:8px; font-weight:800; color:#fff; text-transform:uppercase; letter-spacing:.3px; text-shadow:0 1px 2px rgba(0,0,0,.7); }
      #${OVERLAY_ID} .lbj-sidebet-amt{ font:700 8px/1.2 "JetBrains Mono",monospace; color:#fff; text-shadow:0 1px 2px rgba(0,0,0,.7); }

      #${OVERLAY_ID} .sbj-jackpot-spot{
        position:relative; width:92px; height:92px; border-radius:50%; cursor:pointer;
        background:radial-gradient(circle at 50% 35%, rgba(124,58,237,.3), #10261c 75%);
        border:2px dashed var(--purple); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
        transition:box-shadow .15s ease, border-color .15s ease, transform .15s ease;
      }
      #${OVERLAY_ID} .sbj-jackpot-spot.active{ border-style:solid; border-color:var(--purple-bright); transform:translateY(-3px); box-shadow:0 0 0 3px rgba(124,58,237,.4); }
      #${OVERLAY_ID} .sbj-jackpot-spot .ov-bet-spot-label{ color:var(--purple-bright); }
      #${OVERLAY_ID} .sbj-jackpot-sub{ font:600 8px/1.2 "JetBrains Mono",monospace; color:var(--text-dim); text-align:center; padding:0 6px; }
      #${OVERLAY_ID} .sbj-jackpot-banner{
        text-align:center; font:800 20px/1 "Oswald",sans-serif; letter-spacing:1px; color:var(--gold-bright);
        text-shadow:0 0 14px rgba(244,207,101,.5); margin-bottom:8px; transition:transform .15s ease;
      }
      #${OVERLAY_ID} .sbj-jackpot-banner.pulse{ transform:scale(1.06); }

      #saltys-bj-rules{
        position:fixed; inset:0; z-index:100002; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.75); font:14px/1.6 Inter,system-ui,sans-serif;
      }
      #saltys-bj-rules .box{
        max-width:560px; max-height:82vh; overflow-y:auto; margin:20px; background:#12161d;
        border:1px solid #3a2c0f; border-radius:16px; padding:26px 24px; color:#f4f1ea;
      }
      #saltys-bj-rules h2{ margin:0; font:800 20px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; }
      #saltys-bj-rules h3{ margin:18px 0 6px; font:700 13px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; text-transform:uppercase; letter-spacing:.5px; }
      #saltys-bj-rules h3:first-of-type{ margin-top:6px; }
      #saltys-bj-rules p{ margin:0 0 8px; color:#c7cdd6; font-size:13px; }
      #saltys-bj-rules b{ color:#f4f1ea; }
    `;
    document.head.appendChild(s);
  }

  function evalPerfectPairs(cards) {
    const [a, b] = cards;
    if (a.r !== b.r) return null;
    if (a.s === b.s) return "perfect";
    const red = new Set(["h", "d"]);
    return red.has(a.s) === red.has(b.s) ? "colored" : "mixed";
  }
  function evalTwentyPlusThree(playerCards, dealerUp) {
    const three = [...playerCards, dealerUp];
    const suits = three.map((c) => c.s);
    const isFlush = suits.every((s) => s === suits[0]);
    const ranks = three.map((c) => RANK_ORDER[c.r]).sort((a, b) => a - b);
    const isStraight = (ranks[2] - ranks[0] === 2 && new Set(ranks).size === 3) || JSON.stringify(ranks) === JSON.stringify([2, 3, 14]);
    const isTrips = three[0].r === three[1].r && three[1].r === three[2].r;
    if (isTrips && isFlush) return "suitedTrips";
    if (isStraight && isFlush) return "straightFlush";
    if (isTrips) return "threeKind";
    if (isStraight) return "straight";
    if (isFlush) return "flush";
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
  const SoloBlackjackMulti = (function () {
    const MAX_HANDS = 5;
    const SOLO_DEAL_CARD_MS = 450;
    let root = null, shoe = null, state = null, busy = false, chipScrollPos = 0;
    let jackpotUnsub = null, jackpotAmount = 0;
    const dealtAnimated = new Set();

    function freshState() {
      return {
        phase: "betting", selectedSeats: [], betPerHand: Math.min(100, MAX_BET),
        sidePPPerHand: 0, side21PerHand: 0, jackpotBetPerHand: false, activeBetTarget: "main",
        hands: [], dealer: [], dealerHoleHidden: true,
        activeHandIndex: 0, insuranceOffered: false, insuranceBet: 0, insuranceResolved: false, lastResults: null,
      };
    }
    function getBetFor(target) {
      if (target === "pp") return state.sidePPPerHand;
      if (target === "213") return state.side21PerHand;
      return state.betPerHand;
    }
    function setBetFor(target, v) {
      if (target === "pp") state.sidePPPerHand = v;
      else if (target === "213") state.side21PerHand = v;
      else state.betPerHand = v;
    }
    function newHand(cards, bet, sidePP = 0, side21 = 0, sideJackpot = 0, seatIdx) {
      return {
        cards, bet, status: "active", result: null, acted: false, isSplitAces: false,
        sideBets: { perfectPairs: sidePP, twentyPlusThree: side21, jackpot: sideJackpot },
        sideBetResults: {}, seatIdx,
      };
    }

    async function startDeal() {
      if (busy) return;
      if (!state.selectedSeats.length) { toast("Select at least one seat to play."); return; }
      const bet = clamp(Math.round(state.betPerHand), MIN_BET, MAX_BET);
      const pp = clamp(Math.round(state.sidePPPerHand || 0), 0, MAX_BET);
      const t21 = clamp(Math.round(state.side21PerHand || 0), 0, MAX_BET);
      const jp = state.jackpotBetPerHand ? JACKPOT_SIDE_BET : 0;
      const numHands = state.selectedSeats.length;
      const total = (bet + pp + t21 + jp) * numHands;
      if (total > Balance.current) { toast("Not enough balance for that many seats at this bet."); return; }
      busy = true; render();
      try {
        await Balance.applyDelta(-total, "solo_bj_deal_multi");
        if (window.SaltyJackpot) window.SaltyJackpot.contribute(total, "blackjack");
      }
      catch (e) { toast("Bet failed."); busy = false; render(); return; }
      if (!shoe) shoe = new Shoe(6, 0.25);
      dealtAnimated.clear();
      const seatOrder = [...state.selectedSeats].sort((a, b) => a - b);
      state.hands = seatOrder.map((seatIdx) => newHand([], bet, pp, t21, jp, seatIdx));
      state.dealer = [];
      state.phase = "player";
      state.dealerHoleHidden = true;
      state.activeHandIndex = 0;
      state.insuranceOffered = false;
      state.insuranceBet = 0;
      state.insuranceResolved = false;
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
      for (const hand of state.hands) {
        if (hand.sideBets.perfectPairs > 0) hand.sideBetResults.perfectPairs = evalPerfectPairs(hand.cards);
        if (hand.sideBets.twentyPlusThree > 0) hand.sideBetResults.twentyPlusThree = evalTwentyPlusThree(hand.cards, state.dealer[0]);
        // The jackpot trigger only depends on the player's two cards and
        // the dealer's visible up card — both already known here — so it
        // resolves immediately, before insurance or the dealer's hole card
        // even come into play.
        await resolveJackpotSideBet(hand, state.dealer[0]);
      }
      state.insuranceOffered = state.dealer[0].r === "A";

      // If the dealer's up-card is an Ace, real tables offer insurance and
      // wait for a decision BEFORE checking the hole card — insurance would
      // be meaningless if the peek already happened first. So only peek
      // immediately when there's no insurance decision in the way; when
      // there is, takeInsurance()/declineInsurance() call resolveDealerPeek()
      // themselves once the player has decided.
      if (!state.insuranceOffered) await resolveDealerPeek();

      busy = false;
      render();
    }

    // Resolves the jackpot side bet for one hand: a suited three-of-a-kind
    // across the player's two cards and the dealer's up card — the same
    // "suitedTrips" condition 21+3 already pays its top rate on, and, at
    // roughly 1 in 4,800 hands, actually rare enough to be a jackpot (a
    // suited natural blackjack, by contrast, is ~1 in 84 — too common).
    // Like any other side bet, a hand with the jackpot bet down that
    // doesn't hit this condition simply loses that stake.
    async function resolveJackpotSideBet(hand, dealerUpCard) {
      if (!hand.sideBets || !hand.sideBets.jackpot) return;
      const stake = hand.sideBets.jackpot;
      const suitedTrips = evalTwentyPlusThree(hand.cards, dealerUpCard) === "suitedTrips";
      let payout = 0;
      if (suitedTrips && window.SaltyJackpot) {
        payout = await window.SaltyJackpot.award(JACKPOT_TIER, "blackjack", "Suited three of a kind (your two cards + dealer's up card)", true);
      }
      if (payout > 0) {
        await Balance.applyDelta(stake + payout, "solo_bj_jackpot_win");
        hand.sideBetResults.jackpot = "win";
        hand.jackpotProfit = payout;
      } else {
        hand.sideBetResults.jackpot = "lose";
        hand.jackpotProfit = -stake;
      }
    }

    // The "dealer peek": checks the hole card, resolves any blackjacks
    // (yours, the dealer's, or both), and pays out insurance if it was
    // taken. A natural blackjack — yours or the dealer's — is never played
    // out with hit/stand; it's locked in and settled the moment it's known,
    // exactly like a real table. If the dealer does have blackjack, every
    // other hand loses right here too — there's nothing left to play for
    // once the dealer's already unbeatable.
    async function resolveDealerPeek() {
      const dealerBJ = isBlackjack(state.dealer);
      if (state.insuranceBet > 0 && !state.insuranceResolved) {
        if (dealerBJ) await Balance.applyDelta(state.insuranceBet * 3, "solo_bj_insurance_win");
        state.insuranceResolved = true;
      }
      for (const hand of state.hands) {
        const handBJ = isBlackjack(hand.cards);
        if (dealerBJ) {
          hand.acted = true;
          if (handBJ) {
            hand.status = "push"; hand.result = "push"; hand.profit = 0;
            await Balance.applyDelta(hand.bet, "solo_bj_instant_push");
          } else {
            hand.status = "push"; hand.result = "lose"; hand.profit = -hand.bet;
          }
        } else if (handBJ) {
          hand.acted = true;
          hand.status = "blackjack"; hand.result = "blackjack"; hand.profit = Math.round(hand.bet * 1.5);
          await Balance.applyDelta(hand.bet + hand.profit, "solo_bj_instant_blackjack");
        }
      }
      advanceIfResolved();
    }

    function currentHand() { return state.hands[state.activeHandIndex]; }
    function advanceIfResolved() {
      while (state.activeHandIndex < state.hands.length && state.hands[state.activeHandIndex].status !== "active") state.activeHandIndex++;
      if (state.activeHandIndex >= state.hands.length) runDealer();
    }

    async function takeInsurance() {
      if (busy || !state.insuranceOffered) { state.insuranceResolved = true; state.insuranceBet = 0; return; }
      const totalBet = state.hands.reduce((s, h) => s + h.bet, 0);
      const amount = clamp(Math.round(totalBet / 2), MIN_BET, MAX_BET);
      if (amount > Balance.current) { toast("Not enough balance for insurance."); return; }
      busy = true; render();
      await Balance.applyDelta(-amount, "solo_bj_insurance_bet");
      state.insuranceBet = amount;
      state.insuranceOffered = false;
      await resolveDealerPeek();
      busy = false; render();
    }
    async function declineInsurance() {
      state.insuranceOffered = false;
      busy = true; render();
      await resolveDealerPeek();
      busy = false; render();
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
        await Balance.applyDelta(-hand.bet, "solo_bj_double_multi");
        hand.bet *= 2;
        hand.cards.push(shoe.draw());
        render();
        playDealSound();
        await delay(SOLO_DEAL_CARD_MS);
        hand.status = bjHandValue(hand.cards).total > 21 ? "bust" : "stood";
      } else if (action === "split") {
        const [c0, c1] = hand.cards;
        if (Balance.current < hand.bet) { toast("Not enough balance to split."); busy = false; render(); return; }
        await Balance.applyDelta(-hand.bet, "solo_bj_split_multi");
        const isAces = c0.r === "A";
        const newH = newHand([c1], hand.bet, 0, 0, 0, hand.seatIdx);
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
        if (isAces) { hand.status = "stood"; newH.status = "stood"; }
      } else if (action === "surrender") {
        if (hand.acted || hand.cards.length !== 2 || hand.fromSplit) { busy = false; render(); return; }
        await Balance.applyDelta(Math.round(hand.bet * SURRENDER_RETURN_FRACTION), "solo_bj_surrender");
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
      let totalProfit = 0;
      let handProfitTotal = 0;
      let sideBetProfitTotal = 0;
      let jackpotProfitTotal = 0;
      for (const hand of state.hands) {
        let payout = 0;
        if (hand.result != null) {
          // Already resolved and paid instantly at deal time (natural
          // blackjack or a push against a dealer blackjack) — don't
          // re-settle or re-pay it here.
        } else if (hand.status === "bust") { hand.result = "lose"; }
        else {
          const val = bjHandValue(hand.cards).total;
          if (dealerBJ) { hand.result = "lose"; }
          else if (dealerBust || val > dealerVal) { hand.result = "win"; payout = hand.bet * 2; }
          else if (val === dealerVal) { hand.result = "push"; payout = hand.bet; }
          else { hand.result = "lose"; }
        }
        if (payout > 0) await Balance.applyDelta(payout, "solo_bj_settle_multi");
        const mainProfit = hand.profit != null ? hand.profit : payout - hand.bet;
        if (hand.profit == null) hand.profit = mainProfit;
        handProfitTotal += mainProfit;
        let sbProfit = 0;
        const pp = hand.sideBets && hand.sideBets.perfectPairs;
        const tw = hand.sideBets && hand.sideBets.twentyPlusThree;
        if (pp > 0) {
          const r = hand.sideBetResults.perfectPairs;
          if (r) { const win = pp * SIDE_BET_PAYTABLES.perfectPairs[r] + pp; await Balance.applyDelta(win, "solo_bj_pp_win"); sbProfit += win - pp; }
          else sbProfit -= pp;
        }
        if (tw > 0) {
          const r = hand.sideBetResults.twentyPlusThree;
          if (r) { const win = tw * SIDE_BET_PAYTABLES.twentyPlusThree[r] + tw; await Balance.applyDelta(win, "solo_bj_213_win"); sbProfit += win - tw; }
          else sbProfit -= tw;
        }
        if (hand.sideBets && hand.sideBets.jackpot > 0 && hand.jackpotProfit != null) {
          sbProfit += hand.jackpotProfit;
          jackpotProfitTotal += hand.jackpotProfit;
        }
        hand.profit += sbProfit;
        sideBetProfitTotal += sbProfit;
        totalProfit += mainProfit + sbProfit;
      }
      let insuranceProfit = 0;
      if (state.insuranceBet > 0 && !state.insuranceResolved) {
        if (dealerBJ) { await Balance.applyDelta(state.insuranceBet * 3, "solo_bj_insurance_win"); insuranceProfit = state.insuranceBet * 2; }
        else insuranceProfit = -state.insuranceBet;
        state.insuranceResolved = true;
        totalProfit += insuranceProfit;
      }
      state.lastResults = { totalProfit, handProfitTotal, sideBetProfitTotal, insuranceProfit, jackpotProfitTotal };
      render();
    }

    function cardEl(c, hidden) {
      if (hidden) return `<div class="card back" data-key="hidden"></div>`;
      const isNew = c._key != null && !dealtAnimated.has(c._key);
      if (isNew) dealtAnimated.add(c._key);
      return `<div class="card ${cardColor(c)} ${isNew ? "lbj-card-deal" : ""}" data-key="${c._key ?? ""}"><span>${c.r}</span><span class="br">${SUIT_GLYPH[c.s]}</span></div>`;
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
          const soloSideChips = [];
          if (hand.sideBets && hand.sideBets.perfectPairs > 0) {
            const r = hand.sideBetResults && hand.sideBetResults.perfectPairs;
            soloSideChips.push(`<div class="lbj-sidebet-chip ${r ? "hit" : ""}" title="Perfect Pairs: ${fmt(hand.sideBets.perfectPairs)}${r ? " · " + r : ""}"><span class="lbj-sidebet-label">PP</span><span class="lbj-sidebet-amt">${fmt(hand.sideBets.perfectPairs)}</span></div>`);
          }
          if (hand.sideBets && hand.sideBets.twentyPlusThree > 0) {
            const r = hand.sideBetResults && hand.sideBetResults.twentyPlusThree;
            soloSideChips.push(`<div class="lbj-sidebet-chip ${r ? "hit" : ""}" title="21+3: ${fmt(hand.sideBets.twentyPlusThree)}${r ? " · " + r : ""}"><span class="lbj-sidebet-label">21+3</span><span class="lbj-sidebet-amt">${fmt(hand.sideBets.twentyPlusThree)}</span></div>`);
          }
          if (hand.sideBets && hand.sideBets.jackpot > 0) {
            const r = hand.sideBetResults && hand.sideBetResults.jackpot;
            soloSideChips.push(`<div class="lbj-sidebet-chip ${r === "win" ? "hit" : ""}" title="Jackpot: ${fmt(hand.sideBets.jackpot)}${r ? " · " + r : ""}"><span class="lbj-sidebet-label">JP</span><span class="lbj-sidebet-amt">${fmt(hand.sideBets.jackpot)}</span></div>`);
          }
          const soloSideBetHtml = soloSideChips.length ? `<div class="lbj-sidebet-strip">${soloSideChips.join("")}</div>` : "";
          const jackpotWinTag = hand.sideBetResults && hand.sideBetResults.jackpot === "win" ? ` 💰 JACKPOT!` : "";
          const resultOverlay = hand.status === "bust" ? `<div class="ov-result-overlay">${v.total} – Bust${jackpotWinTag}</div>`
            : hand.result === "blackjack" ? `<div class="ov-result-overlay">Blackjack!${jackpotWinTag}</div>`
            : jackpotWinTag ? `<div class="ov-result-overlay">${jackpotWinTag.trim()}</div>` : "";
          const winBadge = hand.result ? `<div class="ov-win-badge ${hand.profit > 0 ? "win" : hand.profit < 0 ? "lose" : "push"}">
              ${hand.profit > 0 ? "Win" : hand.profit < 0 ? "Lose" : "Push"}
            </div>` : "";
          return `<div class="ov-subhand ${active ? "active" : ""}" style="opacity:${state.phase === "player" && !active ? 0.6 : 1}">
            <div class="ov-hand-ring"><div class="ov-hand">${hand.cards.map((c) => cardEl(c, false)).join("")}</div>${resultOverlay}</div>
            ${chipStackHtml(hand.bet, { size: 20 })}
            <div class="ov-betlabel">${label}${hand.result ? " · " + hand.result : ""}</div>
            ${soloSideBetHtml}${winBadge}${profitLabel}
          </div>`;
        }).join("");
        return `<div class="ov-seat" style="left:${pos.left}%;top:${pos.top}%">
          <div class="row" style="gap:6px">${subHandsHtml}</div>
        </div>`;
      }).join("");

      const insuranceHtml = state.insuranceOffered && state.insuranceBet === 0 && state.phase === "player" ? `
        <div class="ov-insurance-prompt">
          <div class="muted">Dealer shows an Ace — insurance?</div>
          <div class="row" style="justify-content:center;gap:8px;margin-top:6px">
            <button class="btn small gold" id="sbj-insurance-yes">Insure ${fmt(clamp(Math.round(state.hands.reduce((s, h) => s + h.bet, 0) / 2), MIN_BET, MAX_BET))}</button>
            <button class="btn small" id="sbj-insurance-no">No thanks</button>
          </div>
        </div>` : "";
      const insuredBadge = state.insuranceBet > 0 ? `<div class="muted center" style="margin-top:6px">Insured for ${fmt(state.insuranceBet)}</div>` : "";

      const roundSummaryHtml = state.phase === "settled" && state.lastResults ? (() => {
        const r = state.lastResults;
        const cls = r.totalProfit > 0 ? "win" : r.totalProfit < 0 ? "lose" : "push";
        const headline = r.totalProfit > 0 ? "You Win" : r.totalProfit < 0 ? "You Lose" : "Push";
        const line = (label, amt) => `<div class="ov-summary-line"><span>${label}</span><span class="${amt > 0 ? "win" : amt < 0 ? "lose" : ""}">${amt >= 0 ? "+" : ""}${fmt(amt)}</span></div>`;
        return `<div class="ov-round-summary ${cls}">
          <div class="ov-round-summary-headline">${headline}</div>
          <div class="ov-round-summary-lines">
            ${line("Hands", r.handProfitTotal)}
            ${r.sideBetProfitTotal !== 0 ? line("Side Bets", r.sideBetProfitTotal) : ""}
            ${r.jackpotProfitTotal ? line("Jackpot", r.jackpotProfitTotal) : ""}
            ${r.insuranceProfit ? line("Insurance", r.insuranceProfit) : ""}
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
        </div>${insuranceHtml}${insuredBadge}</div>`;
    }

    function render() {
      if (!root) return;
      ensureBlackjackSharedStyle();
      const jackpotBanner = `<div class="sbj-jackpot-banner" id="sbj-jackpot-banner">PROGRESSIVE JACKPOT: ${fmtJackpot(jackpotAmount)}</div>`;
      if (state.phase === "betting") {
        const seatPickHtml = SEAT_POS.map((pos, i) => {
          const picked = state.selectedSeats.includes(i);
          return `<div class="ov-seat" data-seat="${i}" style="left:${pos.left}%;top:${pos.top}%;cursor:pointer">
            <div class="ov-cardslot ${picked ? "" : "empty"}" style="transform:rotate(${pos.rotate});${picked ? "border-color:var(--gold)" : ""}"></div>
          </div>`;
        }).join("");
        const target = state.activeBetTarget || "main";
        const betRailHtml = `<div class="ov-bet-rail">
          ${betSpotHtml("pp", state.sidePPPerHand, target === "pp", "Pairs", true)}
          ${betSpotHtml("main", state.betPerHand, target === "main", "Bet", false)}
          ${betSpotHtml("213", state.side21PerHand, target === "213", "21+3", true)}
          ${jackpotSpotHtml(state.jackpotBetPerHand)}
        </div>`;
        const totalWager = (state.betPerHand + (state.sidePPPerHand || 0) + (state.side21PerHand || 0) + (state.jackpotBetPerHand ? JACKPOT_SIDE_BET : 0)) * state.selectedSeats.length;
        root.innerHTML = jackpotBanner + rulesButtonRowHtml() + `<div class="ov-wrap"><div class="ov-table">
            ${tableBannerHtml()}
            ${shoeDecorHtml()}
            <div class="ov-dealer"><div class="ov-dealer-hand"></div><div class="ov-dealer-label">Dealer's Cards</div></div>
            <div class="ov-hint">Click a seat, then place chips below</div>
            ${seatPickHtml}
          </div>
          <div class="ov-bet-rail">${betRailHtml}</div>
          <div class="ov-chip-rail">
            <div class="chip-select">
              ${CHIP_DENOMS.map((v) => `
                <div class="chip-btn" data-chip="${v}" ${busy ? "" : 'draggable="true"'} style="${chipStyle(v)}">
                  <span class="chip-face">${chipLabel(v)}</span>
                </div>
              `).join("")}
            </div>
            <div class="row center" style="gap:10px;flex-wrap:wrap">
              <button class="btn small gold" id="sbj-bet-max" ${busy ? "disabled" : ""}>Max</button>
              <button class="btn small" id="sbj-bet-clear" ${busy ? "disabled" : ""}>Clear</button>
              <span class="muted">${state.selectedSeats.length} seat${state.selectedSeats.length === 1 ? "" : "s"} · Total wager: ${fmt(totalWager)}</span>
              <button class="btn primary" id="sbj-deal" ${busy || !state.selectedSeats.length || !state.betPerHand ? "disabled" : ""}>Deal</button>
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

        const jackpotToggle = root.querySelector("#sbj-jackpot-toggle");
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
        root.querySelectorAll("[data-chip]").forEach((chip) => {
          const addChip = () => { const t = state.activeBetTarget || "main"; setBetFor(t, clamp(getBetFor(t) + parseInt(chip.dataset.chip, 10), 0, MAX_BET)); render(); };
          chip.addEventListener("click", addChip);
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
        const maxBtn = root.querySelector("#sbj-bet-max");
        if (maxBtn) maxBtn.addEventListener("click", () => {
          const t = state.activeBetTarget || "main";
          setBetFor(t, clamp(Math.floor(Balance.current), 0, MAX_BET));
          render();
        });
        const clearBtn = root.querySelector("#sbj-bet-clear");
        if (clearBtn) clearBtn.addEventListener("click", () => {
          state.betPerHand = 0;
          state.sidePPPerHand = 0;
          state.side21PerHand = 0;
          state.jackpotBetPerHand = false;
          render();
        });
        root.querySelector("#sbj-deal").addEventListener("click", startDeal);
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
          <button class="btn primary" id="sbj-hit" ${busy ? "disabled" : ""}>Hit</button>
          <button class="btn" id="sbj-stand" ${busy ? "disabled" : ""}>Stand</button>
          <button class="btn" id="sbj-double" ${busy || !canDouble ? "disabled" : ""} title="${!canDouble && hand && Balance.current < hand.bet ? "Not enough balance to double" : ""}">Double</button>
          <button class="btn" id="sbj-split" ${busy || !canSplit ? "disabled" : ""}>Split</button>
          <button class="btn" id="sbj-surrender" ${busy || !canSurrender ? "disabled" : ""} title="Forfeit the hand, get half your bet back">Surrender</button>
        </div>`;
      } else if (state.phase === "settled") {
        controls = `<div class="row center">
          <button class="btn primary" id="sbj-rebet">Rebet ${fmt(state.betPerHand)}${state.sidePPPerHand || state.side21PerHand || state.jackpotBetPerHand ? " + sides" : ""}</button>
          <button class="btn" id="sbj-again">Change Bet</button>
        </div>`;
      } else {
        controls = `<div class="center muted">Dealer playing…</div>`;
      }
      root.innerHTML = jackpotBanner + rulesButtonRowHtml() + renderSoloOvalTable() + `<div class="mt16">${controls}</div>`;
      wireRulesButton(root);
      wireSoundToggle(root, render);
      if (state.phase === "player") {
        root.querySelector("#sbj-hit").addEventListener("click", () => act("hit"));
        root.querySelector("#sbj-stand").addEventListener("click", () => act("stand"));
        root.querySelector("#sbj-double").addEventListener("click", () => act("double"));
        root.querySelector("#sbj-split").addEventListener("click", () => act("split"));
        root.querySelector("#sbj-surrender").addEventListener("click", () => act("surrender"));
        const insYes = root.querySelector("#sbj-insurance-yes");
        if (insYes) insYes.addEventListener("click", takeInsurance);
        const insNo = root.querySelector("#sbj-insurance-no");
        if (insNo) insNo.addEventListener("click", declineInsurance);
      } else if (state.phase === "settled") {
        root.querySelector("#sbj-again").addEventListener("click", () => {
          const seats = state.selectedSeats, b = state.betPerHand, pp = state.sidePPPerHand, t21 = state.side21PerHand, jp = state.jackpotBetPerHand;
          state = freshState();
          state.selectedSeats = seats;
          state.betPerHand = b;
          state.sidePPPerHand = pp;
          state.side21PerHand = t21;
          state.jackpotBetPerHand = jp;
          render();
        });
        root.querySelector("#sbj-rebet").addEventListener("click", () => {
          const seats = state.selectedSeats, b = state.betPerHand, pp = state.sidePPPerHand, t21 = state.side21PerHand, jp = state.jackpotBetPerHand;
          state = freshState();
          state.selectedSeats = seats;
          state.betPerHand = b;
          state.sidePPPerHand = pp;
          state.side21PerHand = t21;
          state.jackpotBetPerHand = jp;
          startDeal();
        });
      }
    }

    return {
      label: "Blackjack",
      icon: "🃏",
      order: 1,
      mount(el) {
        root = el;
        state = freshState();
        if (window.SaltyJackpot) {
          jackpotUnsub = window.SaltyJackpot.subscribe((pool) => {
            jackpotAmount = pool.amount;
            const el2 = document.getElementById("sbj-jackpot-banner");
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

  window.SaltyCore.GAME_MODULES.blackjack = SoloBlackjackMulti;
})();
