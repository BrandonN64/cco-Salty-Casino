// ==UserScript==
// Salty's Casino — FREE BET BLACKJACK MODULE (Solo)
// Loaded via @require, after salty-core.js and salty-jackpot.js, by the
// main salty-casino.user.js loader. Registers itself into
// window.SaltyCore.GAME_MODULES.freebetblackjack so it shows up
// automatically on the home grid, next to Blackjack and Spanish 21.
//
// Solo play only: up to 5 hands at once vs one dealer, one standard
// 52-card shoe (unlike Spanish 21, nothing is removed from this deck).
//
// House rules match the standard commercial Free Bet Blackjack paytable
// (Wizard of Odds reference rules):
//   - Six decks, dealer hits soft 17.
//   - Blackjack pays 3:2.
//   - Double on any two-card total. Double after split allowed.
//   - Re-split pairs (including Aces) up to four hands total.
//   - No surrender.
//   - FREE DOUBLES: doubling on a hard two-card total of 9, 10, or 11
//     costs nothing extra — the dealer places a "Free Bet" marker next
//     to your original wager instead of you covering it yourself.
//   - FREE SPLITS: splitting any pair EXCEPT a 10-value pair (10/J/Q/K)
//     is free the same way — the new hand from the split gets a Free
//     Bet marker instead of a real wager. 10-value pairs can still be
//     split, but cost real money like a normal split.
//   - On any hand carrying a Free Bet marker: if you win, the marker
//     pays out just like a real bet would. If you lose, the marker is
//     simply taken back — you never risked real money on it, so a loss
//     only costs your original real wager. On a push, the marker is
//     also simply returned/removed with no effect either way.
//   - PUSH-22: if the dealer's final total is exactly 22, every
//     remaining (non-busted) player hand pushes instead of winning —
//     this is what pays for the free doubles/splits above. A dealer 22
//     is the ONLY dealer total that doesn't just lose outright to any
//     surviving player hand.
// ==/UserScript==
(function () {
  "use strict";

  const {
    MIN_BET, MAX_BET, GAME_MODULES, OVERLAY_ID,
    Balance, Shoe, freshDeck, bjHandValue, isBlackjack, isSplittablePair,
    cardColor, SUIT_GLYPH, clamp, delay, fmt, chipColor, chipStyle,
    renderBetControls, wireBetControls, toast,
  } = window.SaltyCore;

  const DEALER_STANDS_SOFT_17 = false; // dealer HITS soft 17 (standard Free Bet Blackjack rule)
  const SOLO_MAX_HANDS_PER_SEAT = 4; // original + up to 3 splits (aces included)
  const MAX_HANDS = 5; // up to 5 seats at once, same as Blackjack/Spanish 21

  // Local card-value helper (Ace=11, face=10, else numeric) — kept local
  // rather than relying on a core export, since only bjHandValue (which
  // handles Ace soft/hard adjustment across a whole hand) is guaranteed
  // exported by salty-core.js.
  function cardValue(r) {
    if (r === "A") return 11;
    if (r === "J" || r === "Q" || r === "K") return 10;
    return parseInt(r, 10);
  }

  function rulesButtonRowHtml() {
    return `<div class="row" style="justify-content:flex-end;gap:6px;margin-bottom:6px"><button class="btn small" id="saltys-fbb-rules-btn">📖 House Rules</button></div>`;
  }
  function wireRulesButton(root) {
    const btn = root && root.querySelector("#saltys-fbb-rules-btn");
    if (btn) btn.addEventListener("click", showRulesModal);
  }

  function showRulesModal() {
    if (document.getElementById("saltys-fbb-rules")) return;
    const el = document.createElement("div");
    el.id = "saltys-fbb-rules";
    el.innerHTML = `
      <div class="box">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2>House Rules</h2>
          <button class="btn small" id="saltys-fbb-rules-close-x">✕</button>
        </div>
        <div class="rules-body">
          <h3>How it's different from regular Blackjack</h3>
          <p>Free Bet Blackjack plays exactly like standard blackjack, with one twist: certain doubles and splits don't cost you anything extra. Instead of covering the additional wager yourself, the dealer places a <b>Free Bet</b> marker next to your hand. If that hand wins, the marker pays out just like a real bet would. If it loses, the dealer simply takes the marker back — you never risked real money on it, so you only ever lose your original wager.</p>

          <h3>Free Doubles</h3>
          <p>Doubling down is free whenever your first two cards make a <b>hard 9, 10, or 11</b> (no Ace involved). Doubling on any other two-card total is still allowed, but costs you real money like a normal double.</p>

          <h3>Free Splits</h3>
          <p>Splitting is free for every pair <b>except a 10-value pair</b> (10, J, Q, or K paired together). You can still split 10-value pairs, but it costs real money like a normal split. Pairs — including Aces — can be re-split up to four hands total, and doubling after a split is allowed.</p>

          <h3>The Push-22 rule</h3>
          <p>If the dealer's final total is exactly <b>22</b>, every remaining hand that hasn't busted pushes instead of winning — bets and any Free Bet markers are simply returned. This is what pays for all those free doubles and splits above; without it, the house edge would be far too generous to the player.</p>

          <h3>Dealer rules</h3>
          <p>Six decks. The dealer hits soft 17 and stands on hard 17 or higher. This is fixed; the dealer never chooses.</p>

          <h3>Blackjack &amp; card values</h3>
          <p>A natural blackjack (Ace + 10-value card as your first two cards) pays <b>3 to 2</b> and settles immediately. Number cards are worth their number, face cards are worth 10, and an Ace is worth 11 or 1 — whichever keeps your hand at 21 or under.</p>

          <h3>No surrender</h3>
          <p>Unlike some blackjack variants, Free Bet Blackjack doesn't offer surrender — once you're dealt in, you play the hand out or double/split it.</p>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:16px">
          <button class="btn primary" id="saltys-fbb-rules-close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.querySelector("#saltys-fbb-rules-close").addEventListener("click", close);
    el.querySelector("#saltys-fbb-rules-close-x").addEventListener("click", close);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
  }

  function ensureFreeBetBlackjackSharedStyle() {
    if (document.getElementById("saltys-fbb-shared-style")) return;
    const s = document.createElement("style");
    s.id = "saltys-fbb-shared-style";
    s.textContent = `
      #${OVERLAY_ID} .fbb-card-deal{ animation: fbbDealIn .35s ease-out; }
      @keyframes fbbDealIn{ from { transform: translateY(-30px) rotate(-8deg); opacity:0; } to { transform:none; opacity:1; } }

      #${OVERLAY_ID} .fbb-free-badge{
        display:inline-block; margin-top:2px; padding:1px 6px; border-radius:8px;
        background:linear-gradient(145deg, var(--purple-bright), var(--purple));
        color:#fff; font:800 8px/1.4 "JetBrains Mono",monospace; letter-spacing:.4px;
        text-transform:uppercase; box-shadow:0 1px 4px rgba(0,0,0,.5);
      }
      #${OVERLAY_ID} .fbb-push22-banner{
        text-align:center; font:800 13px/1.3 Oswald,sans-serif; color:var(--gold-bright);
        text-shadow:0 0 10px rgba(244,207,101,.4); margin:4px 0 8px;
      }

      /* The actual gold "Free Bet" token — a physical lammer graphic that
         stacks up at a seat every time a free double/split happens,
         mirroring the real casino chip the dealer drops on the felt. */
      #${OVERLAY_ID} .fbb-token-stack{ display:flex; align-items:center; justify-content:center; margin-top:4px; }
      #${OVERLAY_ID} .fbb-token{
        width:22px; height:22px; border-radius:50%; position:relative; flex:none;
        background:
          radial-gradient(circle at 32% 28%, rgba(255,255,255,.65), rgba(255,255,255,0) 45%),
          repeating-conic-gradient(from 0deg, #f4cf65 0deg 20deg, #d4af37 20deg 40deg);
        border:2px solid #7a5c12; box-shadow:0 2px 5px rgba(0,0,0,.55);
        display:flex; align-items:center; justify-content:center;
      }
      #${OVERLAY_ID} .fbb-token:not(:first-child){ margin-left:-11px; }
      #${OVERLAY_ID} .fbb-token::after{
        content:"F"; font:800 10px/1 "JetBrains Mono",monospace; color:#4a3608; text-shadow:0 1px 0 rgba(255,255,255,.4);
      }
      #${OVERLAY_ID} .fbb-token-count{
        margin-left:6px; font:700 11px/1.4 "JetBrains Mono",monospace; color:var(--gold-bright);
      }

      /* Long two-word bet-spot labels (e.g. "Pot of Gold") were left-
         aligning inside the round felt spot instead of centering under
         it — the shared .ov-bet-spot-label class had no text-align set,
         so a wrapped label defaulted to left. */
      #${OVERLAY_ID} .ov-bet-spot-label{ text-align:center; }

      #saltys-fbb-rules{
        position:fixed; inset:0; z-index:100002; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.75); font:14px/1.6 Inter,system-ui,sans-serif;
      }
      #saltys-fbb-rules .box{
        max-width:560px; max-height:82vh; overflow-y:auto; margin:20px; background:#12161d;
        border:1px solid #3a2c0f; border-radius:16px; padding:26px 24px; color:#f4f1ea;
      }
      #saltys-fbb-rules h2{ margin:0; font:800 20px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; }
      #saltys-fbb-rules h3{ margin:18px 0 6px; font:700 13px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; text-transform:uppercase; letter-spacing:.5px; }
      #saltys-fbb-rules h3:first-of-type{ margin-top:6px; }
      #saltys-fbb-rules p{ margin:0 0 8px; color:#c7cdd6; font-size:13px; }
      #saltys-fbb-rules b{ color:#f4f1ea; }
    `;
    document.head.appendChild(s);
  }

  function tableBannerHtml() {
    return `
      <svg class="ov-banner" viewBox="0 0 440 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path id="ov-banner-arc-fbb" d="M 15,52 Q 220,8 425,52" fill="none"/>
        <text class="ov-banner-main"><textPath href="#ov-banner-arc-fbb" startOffset="50%" text-anchor="middle">FREE BET BLACKJACK</textPath></text>
      </svg>
      <div class="ov-banner-sub">Free doubles on hard 9/10/11 — free splits on any non-10 pair</div>
      <div class="ov-banner-sub2">Dealer hits soft 17 — dealer 22 pushes</div>
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

  function tokenStackHtml(count) {
    if (!count) return "";
    const shown = Math.min(count, 5);
    const tokens = Array.from({ length: shown }, () => `<div class="fbb-token"></div>`).join("");
    return `<div class="fbb-token-stack">${tokens}<span class="fbb-token-count">×${count} Free Bet token${count === 1 ? "" : "s"}</span></div>`;
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
  const SoloFreeBetBlackjack = (function () {
    const SOLO_DEAL_CARD_MS = 450;
    let root = null, shoe = null, state = null, busy = false;
    const dealtAnimated = new Set();

    function freshState() {
      return {
        phase: "betting", selectedSeats: [], betPerHand: Math.min(0, MAX_BET),
        potOfGoldPerHand: 0, activeBetTarget: "main", selectedChip: 100,
        hands: [], dealer: [], dealerHoleHidden: true, seatTokens: {},
        activeHandIndex: 0, lastResults: null, lastOpeningBet: null,
      };
    }
    function getBetFor(target) { return target === "potOfGold" ? state.potOfGoldPerHand : state.betPerHand; }
    function setBetFor(target, v) {
      if (target === "potOfGold") state.potOfGoldPerHand = v;
      else state.betPerHand = v;
    }

    function newHand(cards, realBet, freeBet, seatIdx) {
      return {
        cards, realBet, freeBet: freeBet || 0, status: "active", result: null,
        acted: false, isSplitAces: false, fromSplit: false, doubled: false,
        seatIdx, profit: null,
      };
    }

    // Hard total 9/10/11 on an un-acted two-card hand with no Ace — the
    // "Free Double" condition. An Ace-holding two-card hand is always
    // soft (or a natural, which never reaches here), so simply excluding
    // any Ace is sufficient to guarantee "hard".
    function doubleInfo(hand) {
      if (hand.cards.length !== 2) return null;
      const hasAce = hand.cards.some((c) => c.r === "A");
      if (hasAce) return { isFree: false };
      const sum = hand.cards.reduce((s, c) => s + cardValue(c.r), 0);
      return { isFree: sum === 9 || sum === 10 || sum === 11 };
    }
    // Any splittable pair EXCEPT a 10-value pair (10/J/Q/K together) is a
    // free split.
    function splitInfo(hand) {
      if (hand.cards.length !== 2 || !isSplittablePair(hand.cards[0], hand.cards[1])) return null;
      const isTenValue = cardValue(hand.cards[0].r) === 10;
      return { isFree: !isTenValue };
    }

    function addToken(seatIdx) {
      state.seatTokens[seatIdx] = (state.seatTokens[seatIdx] || 0) + 1;
    }

    async function startDeal() {
      if (busy) return;
      if (!state.selectedSeats.length) { toast("Select at least one seat to play."); return; }
      const bet = clamp(Math.round(state.betPerHand), MIN_BET, MAX_BET);
      const potOfGold = clamp(Math.round(state.potOfGoldPerHand || 0), 0, MAX_BET);
      const numHands = state.selectedSeats.length;
      const total = (bet + potOfGold) * numHands;
      if (total > Balance.current) { toast("Not enough balance for that many seats at this bet."); return; }
      busy = true; render();
      try {
        await Balance.applyDelta(-total, "solo_fbb_deal_multi");
        state.lastOpeningBet = { selectedSeats: [...state.selectedSeats], betPerHand: bet, potOfGoldPerHand: potOfGold };
      }
      catch (e) { toast("Bet failed."); busy = false; render(); return; }
      if (!shoe) shoe = new Shoe(6, 0.25, freshDeck);
      dealtAnimated.clear();
      const seatOrder = [...state.selectedSeats].sort((a, b) => a - b);
      state.hands = seatOrder.map((seatIdx) => newHand([], bet, 0, seatIdx));
      state.dealer = [];
      state.phase = "player";
      state.dealerHoleHidden = true;
      state.activeHandIndex = 0;
      state.lastResults = null;
      state.seatTokens = {};
      state.potOfGoldBetBySeat = potOfGold > 0 ? Object.fromEntries(seatOrder.map((s) => [s, potOfGold])) : {};
      render();
      for (let round = 0; round < 2; round++) {
        for (const hand of state.hands) {
          hand.cards.push(shoe.draw());
          render();
          await delay(SOLO_DEAL_CARD_MS);
        }
        state.dealer.push(shoe.draw());
        render();
        await delay(SOLO_DEAL_CARD_MS);
      }
      await resolveDealerPeek();
      busy = false;
      render();
    }

    function restoreOpeningBet(snapshot, multiplier = 1) {
      if (!snapshot) return false;
      state.selectedSeats = [...snapshot.selectedSeats];
      state.betPerHand = clamp(Math.round(snapshot.betPerHand * multiplier), MIN_BET, MAX_BET);
      state.potOfGoldPerHand = clamp(Math.round((snapshot.potOfGoldPerHand || 0) * multiplier), 0, MAX_BET);
      return true;
    }

    async function rebet(multiplier = 1) {
      if (busy || !state.lastOpeningBet) return;
      if (!restoreOpeningBet(state.lastOpeningBet, multiplier)) return;
      const openingTotal = (state.betPerHand + state.potOfGoldPerHand) * state.selectedSeats.length;
      if (openingTotal > Balance.current) {
        toast(`Not enough balance to ${multiplier === 2 ? "double and rebet" : "rebet"}.`);
        return;
      }
      await startDeal();
    }

    // The dealer peek: resolves any natural blackjacks immediately,
    // exactly like standard blackjack. Also settles the Pot of Gold side
    // bet as an instant loss on a dealer blackjack, per the real rule.
    async function resolveDealerPeek() {
      const dealerBJ = isBlackjack(state.dealer);
      for (const hand of state.hands) {
        const handBJ = isBlackjack(hand.cards);
        if (dealerBJ) {
          hand.acted = true;
          if (handBJ) {
            hand.status = "push"; hand.result = "push"; hand.profit = 0;
            await Balance.applyDelta(hand.realBet, "solo_fbb_instant_push");
          } else {
            hand.status = "lose"; hand.result = "lose"; hand.profit = -hand.realBet;
          }
        } else if (handBJ) {
          hand.acted = true;
          hand.status = "blackjack"; hand.result = "blackjack"; hand.profit = Math.round(hand.realBet * 1.5);
          await Balance.applyDelta(hand.realBet + hand.profit, "solo_fbb_instant_blackjack");
        }
      }
      if (dealerBJ) {
        state.potOfGoldResults = {};
        for (const seatIdx of Object.keys(state.potOfGoldBetBySeat || {})) {
          state.potOfGoldResults[seatIdx] = { stake: state.potOfGoldBetBySeat[seatIdx], profit: -state.potOfGoldBetBySeat[seatIdx], tokens: 0 };
        }
      }
      await advanceIfResolved();
    }

    function currentHand() { return state.hands[state.activeHandIndex]; }
    async function advanceIfResolved() {
      while (state.activeHandIndex < state.hands.length && state.hands[state.activeHandIndex].status !== "active") state.activeHandIndex++;
      if (state.activeHandIndex >= state.hands.length) {
        await runDealer();
      }
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
        await delay(SOLO_DEAL_CARD_MS);
        const v = bjHandValue(hand.cards).total;
        if (v > 21) hand.status = "bust";
        else if (v === 21 || hand.isSplitAces) hand.status = "stood";
      } else if (action === "stand") {
        hand.status = "stood";
      } else if (action === "double") {
        const info = doubleInfo(hand);
        if (!info) { busy = false; render(); return; }
        if (info.isFree) {
          hand.freeBet = hand.realBet;
          addToken(hand.seatIdx);
        } else {
          if (Balance.current < hand.realBet) { toast("Not enough balance to double."); busy = false; render(); return; }
          await Balance.applyDelta(-hand.realBet, "solo_fbb_double_multi");
          hand.realBet *= 2;
        }
        hand.doubled = true;
        hand.acted = true;
        hand.cards.push(shoe.draw());
        render();
        await delay(SOLO_DEAL_CARD_MS);
        hand.status = bjHandValue(hand.cards).total > 21 ? "bust" : "stood";
      } else if (action === "split") {
        const info = splitInfo(hand);
        if (!info) { busy = false; render(); return; }
        const [c0, c1] = hand.cards;
        let newRealBet, newFreeBet = 0;
        if (info.isFree) {
          newRealBet = 0;
          newFreeBet = hand.realBet;
          addToken(hand.seatIdx);
        } else {
          if (Balance.current < hand.realBet) { toast("Not enough balance to split."); busy = false; render(); return; }
          await Balance.applyDelta(-hand.realBet, "solo_fbb_split_multi");
          newRealBet = hand.realBet;
        }
        const isAces = c0.r === "A";
        const newH = newHand([c1], newRealBet, newFreeBet, hand.seatIdx);
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
        await delay(SOLO_DEAL_CARD_MS);
        newH.cards.push(shoe.draw());
        render();
        await delay(SOLO_DEAL_CARD_MS);
        // Split Aces get exactly one card each and are forced to stand,
        // same as standard blackjack — this variant's liberal rules only
        // extend to re-splitting Aces up to four hands, not to hitting
        // or doubling after the split.
        if (isAces) {
          hand.status = "stood";
          newH.status = "stood";
        }
      }
      await advanceIfResolved();
      busy = false;
      render();
    }

    async function runDealer() {
      if (state.phase === "dealer" || state.phase === "settled") return;
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
          await delay(SOLO_DEAL_CARD_MS);
        }
      }
      await settle();
    }

    async function settle() {
      state.phase = "settled";
      const dealerVal = bjHandValue(state.dealer).total;
      const dealerBust = dealerVal > 21;
      const push22 = dealerBust && dealerVal === 22;
      let totalProfit = 0;

      for (const hand of state.hands) {
        let payout = 0;
        if (hand.result != null) {
          // Already resolved at deal time (natural blackjack, or a push
          // against a dealer blackjack) — don't re-settle here.
        } else if (hand.status === "bust") {
          hand.result = "lose";
          hand.profit = -hand.realBet;
        } else {
          const val = bjHandValue(hand.cards).total;
          if (push22) {
            hand.result = "push";
            payout = hand.realBet;
            hand.profit = 0;
          } else if (dealerBust || val > dealerVal) {
            hand.result = "win";
            payout = hand.realBet + hand.freeBet + hand.realBet;
            hand.profit = hand.realBet + hand.freeBet;
          } else if (val === dealerVal) {
            hand.result = "push";
            payout = hand.realBet;
            hand.profit = 0;
          } else {
            hand.result = "lose";
            hand.profit = -hand.realBet;
          }
        }
        if (payout > 0) await Balance.applyDelta(payout, "solo_fbb_settle_multi");
        totalProfit += hand.profit;
      }

      // Pot of Gold: resolves purely off the number of Free Bet tokens
      // collected at each seat this round — already an instant loss
      // above if the dealer had a natural blackjack.
      if (!state.potOfGoldResults) {
        state.potOfGoldResults = {};
        for (const seatIdx of Object.keys(state.potOfGoldBetBySeat || {})) {
          const stake = state.potOfGoldBetBySeat[seatIdx];
          const tokens = state.seatTokens[seatIdx] || 0;
          const mult = potOfGoldPayoutMultiplier(tokens);
          let profit;
          if (mult > 0) {
            const win = stake * mult;
            await Balance.applyDelta(stake + win, "solo_fbb_pot_of_gold_win");
            profit = win;
          } else {
            profit = -stake;
          }
          state.potOfGoldResults[seatIdx] = { stake, profit, tokens };
        }
      }
      for (const r of Object.values(state.potOfGoldResults)) totalProfit += r.profit;

      state.lastResults = { totalProfit, sawPush22: push22 };
      render();
    }

    function cardEl(c, hidden) {
      if (hidden) return `<div class="card back" data-key="hidden"></div>`;
      const isNew = c._key != null && !dealtAnimated.has(c._key);
      if (isNew) dealtAnimated.add(c._key);
      return `<div class="card ${cardColor(c)} ${isNew ? "fbb-card-deal" : ""}" data-key="${c._key ?? ""}"><span>${c.r}</span><span class="br">${SUIT_GLYPH[c.s]}</span></div>`;
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
          const freeBadge = hand.freeBet > 0 ? `<div class="fbb-free-badge">Free Bet ${fmt(hand.freeBet)}</div>` : "";
          const resultOverlay = hand.status === "bust" ? `<div class="ov-result-overlay">${v.total} – Bust</div>`
            : hand.result === "blackjack" ? `<div class="ov-result-overlay">Blackjack!</div>` : "";
          const winBadge = hand.result ? `<div class="ov-win-badge ${hand.profit > 0 ? "win" : hand.profit < 0 ? "lose" : "push"}">
              ${hand.profit > 0 ? "Win" : hand.profit < 0 ? "Lose" : "Push"}
            </div>` : "";
          return `<div class="ov-subhand ${active ? "active" : ""}" style="opacity:${state.phase === "player" && !active ? 0.6 : 1}">
            <div class="ov-hand-ring"><div class="ov-hand">${hand.cards.map((c) => cardEl(c, false)).join("")}</div>${resultOverlay}</div>
            ${chipStackHtml(hand.realBet, { size: 20 })}
            <div class="ov-betlabel">${label}${hand.result ? " · " + hand.result : ""}</div>
            ${freeBadge}${winBadge}${profitLabel}
          </div>`;
        }).join("");
        const tokenCount = state.seatTokens[i] || 0;
        const potOfGoldResult = state.potOfGoldResults && state.potOfGoldResults[i];
        const potOfGoldLabel = potOfGoldResult
          ? `<div class="ov-profit ${potOfGoldResult.profit > 0 ? "win" : "lose"}">Pot of Gold: ${potOfGoldResult.profit >= 0 ? "+" : ""}${fmt(potOfGoldResult.profit)}</div>` : "";
        return `<div class="ov-seat" style="left:${pos.left}%;top:${pos.top}%">
          <div class="row" style="gap:6px">${subHandsHtml}</div>
          ${tokenStackHtml(tokenCount)}
          ${potOfGoldLabel}
        </div>`;
      }).join("");

      const roundSummaryHtml = state.phase === "settled" && state.lastResults ? (() => {
        const r = state.lastResults;
        const cls = r.totalProfit > 0 ? "win" : r.totalProfit < 0 ? "lose" : "push";
        const headline = r.totalProfit > 0 ? "You Win" : r.totalProfit < 0 ? "You Lose" : "Push";
        return `<div class="ov-round-summary ${cls}">
          <div class="ov-round-summary-headline">${headline}</div>
          <div class="ov-round-summary-lines">
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
      ensureFreeBetBlackjackSharedStyle();

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
          ${betSpotHtml("potOfGold", state.potOfGoldPerHand, target === "potOfGold", "Pot of Gold", true)}
        </div>`;
        const totalWager = (state.betPerHand + (state.potOfGoldPerHand || 0)) * state.selectedSeats.length;
        root.innerHTML = rulesButtonRowHtml() + `<div class="ov-wrap"><div class="ov-table">
            ${tableBannerHtml()}
            ${shoeDecorHtml()}
            <div class="ov-dealer"><div class="ov-dealer-hand"></div><div class="ov-dealer-label">Dealer's Cards</div></div>
            <div class="ov-hint">Click a seat, then place chips below</div>
            ${seatPickHtml}
          </div>
          <div class="ov-bet-rail">${betRailHtml}</div>
          <div class="ov-chip-rail">
            ${renderBetControls(
          "fbb",
          getBetFor(state.activeBetTarget || "main"),
          busy,
          { selectedChip: state.selectedChip }
        )}
            <div class="row center" style="gap:10px;flex-wrap:wrap">
              <span class="muted">${state.selectedSeats.length} seat${state.selectedSeats.length === 1 ? "" : "s"} · Total wager: ${fmt(totalWager)}</span>
              <button class="btn primary" id="fbb-deal" ${busy || !state.selectedSeats.length || !state.betPerHand ? "disabled" : ""}>Deal</button>
            </div>
          </div></div>`;
        wireRulesButton(root);
        root.querySelectorAll("[data-seat]").forEach((el) => el.addEventListener("click", () => {
          const i = parseInt(el.dataset.seat, 10);
          const idx = state.selectedSeats.indexOf(i);
          if (idx >= 0) state.selectedSeats.splice(idx, 1);
          else if (state.selectedSeats.length < MAX_HANDS) state.selectedSeats.push(i);
          else toast(`You can only play up to ${MAX_HANDS} seats at once.`);
          render();
        }));
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
          "fbb",
          () => getBetFor(state.activeBetTarget || "main"),
          (value) => { setBetFor(state.activeBetTarget || "main", value); render(); },
          {
            getSelectedChip: () => state.selectedChip,
            setSelectedChip: (value) => { state.selectedChip = value; },
            onClear: () => { state.betPerHand = 0; state.potOfGoldPerHand = 0; render(); },
            minBet: 0,
            maxBet: MAX_BET,
          }
        );
        root.querySelector("#fbb-deal").addEventListener("click", startDeal);
        return;
      }

      let controls;
      if (state.phase === "player") {
        const hand = currentHand();
        const dInfo = hand ? doubleInfo(hand) : null;
        const sInfo = hand ? splitInfo(hand) : null;
        const canDouble = hand && dInfo && (dInfo.isFree || Balance.current >= hand.realBet);
        const canSplit = hand && sInfo && (sInfo.isFree || Balance.current >= hand.realBet) &&
          state.hands.filter((h) => h.seatIdx === hand.seatIdx).length < SOLO_MAX_HANDS_PER_SEAT;
        const doubleLabel = dInfo && dInfo.isFree ? "Free Double" : "Double";
        const splitLabel = sInfo && sInfo.isFree ? "Free Split" : "Split";
        controls = `<div class="row" style="justify-content:center;gap:10px;flex-wrap:wrap">
          <button class="btn green" id="fbb-hit" ${busy ? "disabled" : ""}>Hit</button>
          <button class="btn red" id="fbb-stand" ${busy ? "disabled" : ""}>Stand</button>
          <button class="btn gold" id="fbb-double" ${busy || !canDouble ? "disabled" : ""} title="${!canDouble && hand && dInfo && !dInfo.isFree && Balance.current < hand.realBet ? "Not enough balance to double" : ""}">${doubleLabel}</button>
          <button class="btn blue" id="fbb-split" ${busy || !canSplit ? "disabled" : ""}>${splitLabel}</button>
        </div>`;
      } else if (state.phase === "settled") {
        const prior = state.lastOpeningBet;
        const rebetAmount = prior ? prior.betPerHand : state.betPerHand;
        const hasSides = prior ? prior.potOfGoldPerHand : state.potOfGoldPerHand;
        controls = `<div class="row" style="justify-content:center">
          <button class="btn primary" id="fbb-rebet">Rebet ${fmt(rebetAmount)}${hasSides ? " + sides" : ""}</button>
          <button class="btn gold" id="fbb-double-rebet">2× Bet & Rebet</button>
          <button class="btn" id="fbb-again">Change Bet</button>
        </div>`;
      } else {
        controls = `<div class="center muted">Dealer playing…</div>`;
      }
      root.innerHTML = rulesButtonRowHtml() + renderSoloOvalTable() + `<div class="mt16">${controls}</div>`;
      wireRulesButton(root);
      if (state.phase === "player") {
        root.querySelector("#fbb-hit").addEventListener("click", () => act("hit"));
        root.querySelector("#fbb-stand").addEventListener("click", () => act("stand"));
        root.querySelector("#fbb-double").addEventListener("click", () => act("double"));
        root.querySelector("#fbb-split").addEventListener("click", () => act("split"));
      } else if (state.phase === "settled") {
        root.querySelector("#fbb-again").addEventListener("click", () => {
          const seats = state.selectedSeats, b = state.betPerHand, p = state.potOfGoldPerHand;
          state = freshState();
          state.selectedSeats = seats;
          state.betPerHand = b;
          state.potOfGoldPerHand = p;
          render();
        });
        root.querySelector("#fbb-rebet").addEventListener("click", () => rebet(1));
        const doubleRebetBtn = root.querySelector("#fbb-double-rebet");
        if (doubleRebetBtn) doubleRebetBtn.addEventListener("click", () => rebet(2));
      }
    }

    return {
      label: "Free Bet Blackjack",
      icon: "🎫",
      order: 7,
      mount(el) {
        root = el;
        state = freshState();
        render();
        return () => { root = null; };
      },
    };
  })();

  window.SaltyCore.GAME_MODULES.freebetblackjack = SoloFreeBetBlackjack;
})();