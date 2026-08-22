// ==UserScript==
// Salty's Casino — DOUBLE DOWN MADNESS MODULE (Solo)
// Loaded via @require, after salty-core.js and salty-jackpot.js, by the
// main salty-casino.user.js loader. Registers itself into
// window.SaltyCore.GAME_MODULES.doubledownmadness so it shows up
// automatically on the home grid, next to Blackjack and Free Bet
// Blackjack.
//
// Solo play only: up to 5 hands at once vs one dealer, one standard
// 6-deck shoe.
//
// House rules match the standard commercial Double Down Madness paytable
// (Wizard of Odds reference rules — this is a Light & Wonder game found
// at many commercial casinos):
//   - Six decks, dealer hits soft 17.
//   - Player is dealt only ONE card to start (dealer gets the usual two,
//     one up, one down). You can see the dealer's up card before acting.
//   - No splitting.
//   - HIT OR DOUBLE, ANY TIME: unlike normal blackjack, you may double
//     down on any total, with any number of cards, as many times as you
//     like in a single hand — hitting after doubling is explicitly
//     allowed. Each re-double's ADDITIONAL wager is always double the
//     previous additional double-down wager (bet $10, double for +$10,
//     re-double for +$20, re-double again for +$40, etc.).
//   - THE ACE EXCEPTION: if your very first card is an Ace, you only
//     ever get ONE more card total, whether you hit or double — same
//     one-card cap either way.
//   - A two-card 21 (only possible as Ace + a 10-value card, since no
//     two ordinary cards can total 21) is a Blackjack and pays out
//     immediately — 3:2 unsuited, 2:1 if both cards share a suit — on
//     whatever your current total wager on that hand is, even if you
//     got there via a double. This settles before the dealer's turn and
//     is NOT affected by the Push-22 rule below.
//   - PUSH-22: this is what pays for all that free-wheeling doubling —
//     if the dealer's final total is exactly 22, every surviving
//     (non-busted, non-blackjack) wager pushes instead of winning.
//   - Wins (other than blackjack) pay even money (1:1), no matter how
//     many cards or doubles built the hand.
//   - Optional PUSH 22 side bet: pays 11:1 if the dealer's final total
//     is exactly 22, and loses on anything else. The dealer always
//     plays their hand out to a final total — even if every player hand
//     has already busted — so this side bet always resolves.
//   - Insurance is offered when the dealer's up card is an Ace, same as
//     standard blackjack (2:1 if the dealer has a natural).
// ==/UserScript==
(function () {
  "use strict";

  const {
    MIN_BET, MAX_BET, GAME_MODULES, OVERLAY_ID,
    Balance, Shoe, freshDeck, bjHandValue, isBlackjack,
    cardColor, SUIT_GLYPH, clamp, delay, fmt, chipColor, chipStyle,
    renderBetControls, wireBetControls, toast,
  } = window.SaltyCore;

  const DEALER_STANDS_SOFT_17 = false; // dealer HITS soft 17 (standard rule)
  const MAX_HANDS = 5; // up to 5 seats at once, same as Blackjack/Spanish 21
  const PUSH22_PAYOUT = 11; // Push 22 side bet pays 11:1
  const BLACKJACK_SUITED_PAYOUT = 2;   // 2:1 if both cards share a suit
  const BLACKJACK_UNSUITED_PAYOUT = 1.5; // 3:2 otherwise

  function rulesButtonRowHtml() {
    return `<div class="row" style="justify-content:flex-end;gap:6px;margin-bottom:6px"><button class="btn small" id="saltys-ddm-rules-btn">📖 House Rules</button></div>`;
  }
  function wireRulesButton(root) {
    const btn = root && root.querySelector("#saltys-ddm-rules-btn");
    if (btn) btn.addEventListener("click", showRulesModal);
  }

  function showRulesModal() {
    if (document.getElementById("saltys-ddm-rules")) return;
    const el = document.createElement("div");
    el.id = "saltys-ddm-rules";
    el.innerHTML = `
      <div class="box">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2>House Rules</h2>
          <button class="btn small" id="saltys-ddm-rules-close-x">✕</button>
        </div>
        <div class="rules-body">
          <h3>How it's different from regular Blackjack</h3>
          <p>You start with just <b>one card</b> instead of two — the dealer still gets their usual two, one face up. From there you can hit or double down, and keep doing either as many times as you want on the same hand. There's no splitting.</p>

          <h3>Doubling, over and over</h3>
          <p>Unlike standard blackjack, doubling down doesn't end your turn — you can keep hitting or doubling again afterward. Each time you re-double, the extra amount you add doubles too: bet 100, double for +100 (200 total), double again for +200 (400 total), again for +400 (800 total), and so on.</p>

          <h3>The Ace exception</h3>
          <p>If your very first card is an <b>Ace</b>, you only ever get exactly one more card, whether you hit or double — the same one-card cap either way.</p>

          <h3>Blackjack</h3>
          <p>Since a two-card total of 21 can only ever be Ace + a 10-value card, landing exactly two cards on 21 (however you got your second card) is a Blackjack. It pays immediately on your full current wager — <b>3 to 2</b> normally, or <b>2 to 1</b> if both cards share a suit — and settles before the dealer even plays, completely unaffected by the Push-22 rule below.</p>

          <h3>The Push-22 rule</h3>
          <p>This is what pays for all that free doubling: if the dealer's final total is exactly <b>22</b>, every surviving (non-busted) wager pushes instead of winning. Any other winning hand pays even money (1:1), no matter how large it grew from doubling.</p>

          <h3>Push 22 side bet</h3>
          <p>An optional side bet that pays <b>11 to 1</b> if the dealer's final total is exactly 22, and loses on anything else. The dealer always plays their hand all the way out — even if every player hand has already busted — so this side bet always gets a result.</p>

          <h3>Insurance</h3>
          <p>Offered whenever the dealer's up card is an Ace, same as standard blackjack — costs half your hand's current wager and pays <b>2 to 1</b> if the dealer turns over a natural blackjack.</p>

          <h3>Dealer rules</h3>
          <p>Six decks. The dealer hits soft 17 and stands on hard 17 or higher. This is fixed; the dealer never chooses.</p>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:16px">
          <button class="btn primary" id="saltys-ddm-rules-close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.querySelector("#saltys-ddm-rules-close").addEventListener("click", close);
    el.querySelector("#saltys-ddm-rules-close-x").addEventListener("click", close);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
  }

  function ensureDoubleDownMadnessSharedStyle() {
    if (document.getElementById("saltys-ddm-shared-style")) return;
    const s = document.createElement("style");
    s.id = "saltys-ddm-shared-style";
    s.textContent = `
      #${OVERLAY_ID} .ddm-card-deal{ animation: ddmDealIn .35s ease-out; }
      @keyframes ddmDealIn{ from { transform: translateY(-30px) rotate(-8deg); opacity:0; } to { transform:none; opacity:1; } }

      #${OVERLAY_ID} .ddm-push22-banner{
        text-align:center; font:800 13px/1.3 Oswald,sans-serif; color:var(--gold-bright);
        text-shadow:0 0 10px rgba(244,207,101,.4); margin:4px 0 8px;
      }
      #${OVERLAY_ID} .ddm-wager-badge{
        display:inline-block; margin-top:2px; padding:1px 6px; border-radius:8px;
        background:rgba(0,0,0,.5); color:#f4f1ea; font:700 9px/1.4 "JetBrains Mono",monospace;
      }

      #saltys-ddm-rules{
        position:fixed; inset:0; z-index:100002; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.75); font:14px/1.6 Inter,system-ui,sans-serif;
      }
      #saltys-ddm-rules .box{
        max-width:560px; max-height:82vh; overflow-y:auto; margin:20px; background:#12161d;
        border:1px solid #3a2c0f; border-radius:16px; padding:26px 24px; color:#f4f1ea;
      }
      #saltys-ddm-rules h2{ margin:0; font:800 20px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; }
      #saltys-ddm-rules h3{ margin:18px 0 6px; font:700 13px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; text-transform:uppercase; letter-spacing:.5px; }
      #saltys-ddm-rules h3:first-of-type{ margin-top:6px; }
      #saltys-ddm-rules p{ margin:0 0 8px; color:#c7cdd6; font-size:13px; }
      #saltys-ddm-rules b{ color:#f4f1ea; }
    `;
    document.head.appendChild(s);
  }

  function tableBannerHtml() {
    return `
      <svg class="ov-banner" viewBox="0 0 440 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path id="ov-banner-arc-ddm" d="M 15,52 Q 220,8 425,52" fill="none"/>
        <text class="ov-banner-main"><textPath href="#ov-banner-arc-ddm" startOffset="50%" text-anchor="middle">DOUBLE DOWN MADNESS</textPath></text>
      </svg>
      <div class="ov-banner-sub">Hit or double as many times as you like — one card to start</div>
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

  // Same bet-spot markup Blackjack and Spanish 21 use for their side
  // bets — a clickable felt circle showing a real chip pile once money's
  // on it, rather than a plain toggle button.
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
  const SoloDoubleDownMadness = (function () {
    const SOLO_DEAL_CARD_MS = 450;
    let root = null, shoe = null, state = null, busy = false;
    const dealtAnimated = new Set();

    function freshState() {
      return {
        phase: "betting", selectedSeats: [], betPerHand: Math.min(0, MAX_BET),
        push22PerHand: 0, activeBetTarget: "main", selectedChip: 100,
        hands: [], dealer: [], dealerHoleHidden: true,
        activeHandIndex: 0, insuranceOffered: false, insuranceBet: 0, insuranceProfit: 0,
        insuranceResolved: false, lastResults: null, lastOpeningBet: null,
      };
    }
    function getBetFor(target) { return target === "push22" ? state.push22PerHand : state.betPerHand; }
    function setBetFor(target, v) {
      if (target === "push22") state.push22PerHand = v;
      else state.betPerHand = v;
    }

    function newHand(cards, bet, push22, seatIdx) {
      return {
        cards, wager: bet, nextDoubleIncrement: bet, isAceStart: cards[0] && cards[0].r === "A",
        status: "active", result: null, profit: null, push22, seatIdx,
      };
    }

    async function startDeal() {
      if (busy) return;
      if (!state.selectedSeats.length) { toast("Select at least one seat to play."); return; }
      const bet = clamp(Math.round(state.betPerHand), MIN_BET, MAX_BET);
      const push22 = clamp(Math.round(state.push22PerHand || 0), 0, MAX_BET);
      const numHands = state.selectedSeats.length;
      const total = (bet + push22) * numHands;
      if (total > Balance.current) { toast("Not enough balance for that many seats at this bet."); return; }
      busy = true; render();
      try {
        await Balance.applyDelta(-total, "solo_ddm_deal_multi", { logLedger: false });
        state.lastOpeningBet = { selectedSeats: [...state.selectedSeats], betPerHand: bet, push22PerHand: push22 };
      }
      catch (e) { toast("Bet failed."); busy = false; render(); return; }
      if (!shoe) shoe = new Shoe(6, 0.25, freshDeck);
      dealtAnimated.clear();
      const seatOrder = [...state.selectedSeats].sort((a, b) => a - b);
      state.dealer = [];
      state.phase = "player";
      state.dealerHoleHidden = true;
      state.activeHandIndex = 0;
      state.lastResults = null;
      state.insuranceOffered = false;
      state.insuranceBet = 0;
      state.insuranceProfit = 0;
      state.insuranceResolved = false;

      // Dealer's first card, then one card to each player, then the
      // dealer's hole card — same physical dealing order real Double
      // Down Madness tables use.
      state.dealer.push(shoe.draw());
      render();
      await delay(SOLO_DEAL_CARD_MS);
      state.hands = seatOrder.map((seatIdx) => newHand([], bet, push22, seatIdx));
      for (const hand of state.hands) {
        hand.cards.push(shoe.draw());
        hand.isAceStart = hand.cards[0].r === "A";
        checkHandAfterDraw(hand);
        render();
        await delay(SOLO_DEAL_CARD_MS);
      }
      state.dealer.push(shoe.draw());
      render();
      await delay(SOLO_DEAL_CARD_MS);

      const upCard = state.dealer[0];
      if (upCard.r === "A") {
        state.insuranceOffered = true;
        render();
        return; // wait for the player's insurance decision before peeking
      }
      await resolveDealerPeek();
      busy = false;
      render();
    }

    async function declineInsurance() {
      if (!state.insuranceOffered || state.insuranceResolved) return;
      state.insuranceOffered = false;
      await resolveDealerPeek();
      busy = false;
      render();
    }

    async function takeInsurance() {
      if (!state.insuranceOffered || state.insuranceResolved) return;
      const totalBet = state.hands.reduce((s, h) => s + h.wager, 0);
      const cost = Math.round(totalBet / 2);
      if (Balance.current < cost) { toast("Not enough balance for insurance."); return; }
      await Balance.applyDelta(-cost, "solo_ddm_insurance", { logLedger: false });
      state.insuranceBet = cost;
      state.insuranceOffered = false;
      render();
      await resolveDealerPeek();
      busy = false;
      render();
    }

    // The dealer peek: resolves any natural blackjack (and insurance)
    // immediately. Players only have one card each at this point, so no
    // player hand can possibly be a natural itself.
    async function resolveDealerPeek() {
      const upCard = state.dealer[0];
      const canHaveBJ = upCard.r === "A" || ["10", "J", "Q", "K"].includes(upCard.r);
      if (canHaveBJ && isBlackjack(state.dealer)) {
        state.dealerHoleHidden = false;
        if (state.insuranceBet > 0) {
          state.insuranceProfit = state.insuranceBet * 2;
          await Balance.applyDelta(state.insuranceBet + state.insuranceProfit, "solo_ddm_insurance_win", { logLedger: false });
        }
        state.insuranceResolved = true;
        for (const hand of state.hands) {
          if (hand.status === "blackjack") continue; // already paid, can't lose to this
          hand.status = "settled_early";
          hand.result = "lose";
          hand.profit = -hand.wager;
        }
        state.phase = "settled";
        await finalizeRoundSummary();
        return;
      }
      if (state.insuranceBet > 0) {
        state.insuranceProfit = -state.insuranceBet;
        state.insuranceResolved = true;
      }
      advanceIfResolved();
      if (state.phase === "player") saveMidRoundState();
    }

    function buildRoundSnapshot() {
      return {
        hands: state.hands,
        dealer: state.dealer,
        dealerHoleHidden: state.dealerHoleHidden,
        activeHandIndex: state.activeHandIndex,
        insuranceOffered: state.insuranceOffered,
        insuranceBet: state.insuranceBet,
        insuranceProfit: state.insuranceProfit,
        insuranceResolved: state.insuranceResolved,
      };
    }
    function saveMidRoundState() {
      Balance.saveRoundState("doubledownmadness", buildRoundSnapshot()).catch(() => {});
    }

    function currentHand() { return state.hands[state.activeHandIndex]; }
    function advanceIfResolved() {
      while (state.activeHandIndex < state.hands.length && state.hands[state.activeHandIndex].status !== "active") state.activeHandIndex++;
      if (state.activeHandIndex >= state.hands.length) runDealer();
    }

    // Shared post-draw evaluation used after both hit and double: checks
    // for an immediate two-card Blackjack, a bust, an automatic stand at
    // 21, or the Ace-start one-card cap.
    function checkHandAfterDraw(hand) {
      const total = bjHandValue(hand.cards).total;
      if (hand.cards.length === 2 && total === 21) {
        hand.status = "blackjack";
        hand.result = "blackjack";
        const suited = hand.cards[0].s === hand.cards[1].s;
        const mult = suited ? BLACKJACK_SUITED_PAYOUT : BLACKJACK_UNSUITED_PAYOUT;
        hand.profit = Math.round(hand.wager * mult);
        Balance.applyDelta(hand.wager + hand.profit, "solo_ddm_blackjack", { logLedger: false }).catch(() => {});
      } else if (total > 21) {
        hand.status = "bust";
      } else if (total === 21) {
        hand.status = "stood";
      } else if (hand.isAceStart && hand.cards.length === 2) {
        hand.status = "stood";
      }
    }

    async function act(action) {
      if (busy || state.phase !== "player") return;
      const hand = currentHand();
      if (!hand || hand.status !== "active") return;
      busy = true;
      if (action === "stand") {
        hand.status = "stood";
      } else if (action === "hit") {
        hand.cards.push(shoe.draw());
        render();
        await delay(SOLO_DEAL_CARD_MS);
        checkHandAfterDraw(hand);
      } else if (action === "double") {
        const increment = hand.nextDoubleIncrement;
        if (Balance.current < increment) { toast("Not enough balance to double."); busy = false; render(); return; }
        await Balance.applyDelta(-increment, "solo_ddm_double_multi", { logLedger: false });
        hand.wager += increment;
        hand.nextDoubleIncrement = increment * 2;
        hand.cards.push(shoe.draw());
        render();
        await delay(SOLO_DEAL_CARD_MS);
        checkHandAfterDraw(hand);
      }
      advanceIfResolved();
      if (state.phase === "player") saveMidRoundState();
      busy = false;
      render();
    }

    async function runDealer() {
      state.phase = "dealer";
      state.dealerHoleHidden = false;
      render();
      await delay(SOLO_DEAL_CARD_MS);
      // The dealer ALWAYS plays out fully — even if every hand has
      // already busted or resolved — because the Push 22 side bet needs
      // a real final dealer total to settle against every round.
      while (true) {
        const { total, soft } = bjHandValue(state.dealer);
        if (total > 21 || total > 17 || (total === 17 && (!soft || DEALER_STANDS_SOFT_17))) break;
        state.dealer.push(shoe.draw());
        render();
        await delay(SOLO_DEAL_CARD_MS);
      }
      await settle();
    }

    async function settle() {
      state.phase = "settled";
      const dealerVal = bjHandValue(state.dealer).total;
      const dealerBust = dealerVal > 21;
      const push22 = dealerBust && dealerVal === 22;

      let totalPayout = 0;
      for (const hand of state.hands) {
        let payout = 0;
        if (hand.result != null) {
          // Already resolved (Blackjack, paid the instant it happened —
          // exempt from Push-22, per the real game's rules).
        } else if (hand.status === "bust") {
          hand.result = "lose";
          hand.profit = -hand.wager;
        } else {
          const val = bjHandValue(hand.cards).total;
          if (push22) {
            hand.result = "push";
            payout = hand.wager;
            hand.profit = 0;
          } else if (dealerBust || val > dealerVal) {
            hand.result = "win";
            payout = hand.wager * 2;
            hand.profit = hand.wager;
          } else if (val === dealerVal) {
            hand.result = "push";
            payout = hand.wager;
            hand.profit = 0;
          } else {
            hand.result = "lose";
            hand.profit = -hand.wager;
          }
        }
        totalPayout += payout;
      }

      // Push 22 side bet resolves off the dealer's real final total,
      // independent of every hand's own outcome.
      for (const hand of state.hands) {
        if (!hand.push22) continue;
        if (push22) {
          hand.push22Profit = hand.push22 * PUSH22_PAYOUT;
          totalPayout += hand.push22 + hand.push22Profit;
        } else {
          hand.push22Profit = -hand.push22;
        }
      }

      await finalizeRoundSummary(totalPayout);
    }

    async function finalizeRoundSummary(totalPayout = 0) {
      let totalProfit = state.insuranceProfit || 0;
      for (const hand of state.hands) {
        totalProfit += (hand.profit || 0) + (hand.push22Profit || 0);
      }
      state.lastResults = { totalProfit, sawPush22: state.dealer.length > 0 && bjHandValue(state.dealer).total === 22 };
      // Every hand's result/profit above is computed in pure synchronous
      // JS — no await between hands — so a write failure can't strand
      // later hands unresolved. This one call pays out everything
      // computed here and flushes the round's ledger/round-state.
      await Balance.settleRound("doubledownmadness", totalPayout, "solo_ddm_round_complete");
      render();
    }

    function cardEl(c, hidden) {
      if (hidden) return `<div class="card back" data-key="hidden"></div>`;
      const isNew = c._key != null && !dealtAnimated.has(c._key);
      if (isNew) dealtAnimated.add(c._key);
      return `<div class="card ${cardColor(c)} ${isNew ? "ddm-card-deal" : ""}" data-key="${c._key ?? ""}"><span>${c.r}</span><span class="br">${SUIT_GLYPH[c.s]}</span></div>`;
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
        const hand = state.hands.find((h) => h.seatIdx === i);
        if (!hand) {
          return `<div class="ov-seat" style="left:${pos.left}%;top:${pos.top}%">
            <div class="ov-cardslot empty" style="transform:rotate(${pos.rotate})"></div>
            <div class="ov-chipmark empty"></div>
          </div>`;
        }
        const active = state.phase === "player" && state.hands[state.activeHandIndex] === hand;
        const v = bjHandValue(hand.cards);
        const label = hand.status === "bust" ? `${v.total} Bust` : `${v.total}${v.soft ? "s" : ""}`;
        const profitLabel = state.phase === "settled" && hand.profit != null
          ? `<div class="ov-profit ${hand.profit > 0 ? "win" : hand.profit < 0 ? "lose" : ""}">${hand.profit >= 0 ? "+" : ""}${fmt(hand.profit)}</div>` : "";
        const push22Label = state.phase === "settled" && hand.push22Profit != null
          ? `<div class="ov-profit ${hand.push22Profit > 0 ? "win" : "lose"}">Push22: ${hand.push22Profit >= 0 ? "+" : ""}${fmt(hand.push22Profit)}</div>` : "";
        const resultOverlay = hand.status === "bust" ? `<div class="ov-result-overlay">${v.total} – Bust</div>`
          : hand.result === "blackjack" ? `<div class="ov-result-overlay">Blackjack!</div>` : "";
        const winBadge = hand.result ? `<div class="ov-win-badge ${hand.profit > 0 ? "win" : hand.profit < 0 ? "lose" : "push"}">
            ${hand.profit > 0 ? "Win" : hand.profit < 0 ? "Lose" : "Push"}
          </div>` : "";
        return `<div class="ov-seat" style="left:${pos.left}%;top:${pos.top}%">
          <div class="ov-subhand ${active ? "active" : ""}" style="opacity:${state.phase === "player" && !active ? 0.6 : 1}">
            <div class="ov-hand-ring"><div class="ov-hand">${hand.cards.map((c) => cardEl(c, false)).join("")}</div>${resultOverlay}</div>
            ${chipStackHtml(hand.wager, { size: 20 })}
            <div class="ov-betlabel">${label}${hand.result ? " · " + hand.result : ""}</div>
            <div class="ddm-wager-badge">Wager ${fmt(hand.wager)}</div>
            ${winBadge}${profitLabel}${push22Label}
          </div>
        </div>`;
      }).join("");

      const push22Banner = state.phase === "settled" && state.lastResults && state.lastResults.sawPush22
        ? `<div class="ddm-push22-banner">Dealer hit 22 — surviving hands push!</div>` : "";

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
          ${state.phase === "player" && !state.insuranceOffered ? `<div class="ov-hint">Playing hand ${state.activeHandIndex + 1} of ${state.hands.length}</div>` : ""}
          ${seatHtml}
          ${push22Banner}
          ${roundSummaryHtml}
        </div></div>`;
    }

    function render() {
      if (!root) return;
      ensureDoubleDownMadnessSharedStyle();

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
          ${betSpotHtml("push22", state.push22PerHand, target === "push22", "Push 22", true)}
        </div>`;
        const totalWager = (state.betPerHand + (state.push22PerHand || 0)) * state.selectedSeats.length;
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
              "ddm",
              getBetFor(state.activeBetTarget || "main"),
              busy,
              { selectedChip: state.selectedChip }
            )}
            <div class="row center" style="gap:10px;flex-wrap:wrap">
              <span class="muted">${state.selectedSeats.length} seat${state.selectedSeats.length === 1 ? "" : "s"} · Total wager: ${fmt(totalWager)}</span>
              <button class="btn primary" id="ddm-deal" ${busy || !state.selectedSeats.length || !state.betPerHand ? "disabled" : ""}>Deal</button>
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
          "ddm",
          () => getBetFor(state.activeBetTarget || "main"),
          (value) => { setBetFor(state.activeBetTarget || "main", value); render(); },
          {
            getSelectedChip: () => state.selectedChip,
            setSelectedChip: (value) => { state.selectedChip = value; },
            onClear: () => { state.betPerHand = 0; state.push22PerHand = 0; render(); },
            minBet: 0,
            maxBet: MAX_BET,
          }
        );
        root.querySelector("#ddm-deal").addEventListener("click", startDeal);
        return;
      }

      let controls;
      if (state.insuranceOffered) {
        const totalBet = state.hands.reduce((s, h) => s + h.wager, 0);
        const cost = Math.round(totalBet / 2);
        controls = `<div class="row" style="justify-content:center;gap:10px;flex-wrap:wrap">
          <div class="center muted" style="width:100%">Dealer shows an Ace — Insurance costs ${fmt(cost)}, pays 2:1</div>
          <button class="btn gold" id="ddm-insure-yes">Take Insurance</button>
          <button class="btn" id="ddm-insure-no">No Insurance</button>
        </div>`;
      } else if (state.phase === "player") {
        const hand = currentHand();
        controls = `<div class="row" style="justify-content:center;gap:10px;flex-wrap:wrap">
          <button class="btn green" id="ddm-hit" ${busy ? "disabled" : ""}>Hit</button>
          <button class="btn red" id="ddm-stand" ${busy ? "disabled" : ""}>Stand</button>
          <button class="btn gold" id="ddm-double" ${busy || !hand || Balance.current < hand.nextDoubleIncrement ? "disabled" : ""} title="${hand && Balance.current < hand.nextDoubleIncrement ? "Not enough balance to double" : ""}">Double (+${hand ? fmt(hand.nextDoubleIncrement) : ""})</button>
        </div>`;
      } else if (state.phase === "settled") {
        const prior = state.lastOpeningBet;
        const rebetAmount = prior ? prior.betPerHand : state.betPerHand;
        const hasSides = prior ? prior.push22PerHand : state.push22PerHand;
        controls = `<div class="row" style="justify-content:center">
          <button class="btn primary" id="ddm-rebet">Rebet ${fmt(rebetAmount)}${hasSides ? " + sides" : ""}</button>
          <button class="btn gold" id="ddm-double-rebet">2× Bet & Rebet</button>
          <button class="btn" id="ddm-again">Change Bet</button>
        </div>`;
      } else {
        controls = `<div class="center muted">Dealer playing…</div>`;
      }
      root.innerHTML = rulesButtonRowHtml() + renderSoloOvalTable() + `<div class="mt16">${controls}</div>`;
      wireRulesButton(root);
      if (state.insuranceOffered) {
        root.querySelector("#ddm-insure-yes").addEventListener("click", takeInsurance);
        root.querySelector("#ddm-insure-no").addEventListener("click", declineInsurance);
      } else if (state.phase === "player") {
        root.querySelector("#ddm-hit").addEventListener("click", () => act("hit"));
        root.querySelector("#ddm-stand").addEventListener("click", () => act("stand"));
        root.querySelector("#ddm-double").addEventListener("click", () => act("double"));
      } else if (state.phase === "settled") {
        root.querySelector("#ddm-again").addEventListener("click", () => {
          const seats = state.selectedSeats, b = state.betPerHand, p = state.push22PerHand;
          state = freshState();
          state.selectedSeats = seats;
          state.betPerHand = b;
          state.push22PerHand = p;
          render();
        });
        root.querySelector("#ddm-rebet").addEventListener("click", () => {
          const prior = state.lastOpeningBet;
          const seats = prior ? prior.selectedSeats : state.selectedSeats;
          const b = prior ? prior.betPerHand : state.betPerHand;
          const p = prior ? prior.push22PerHand : state.push22PerHand;
          const seatTotal = (b + p) * seats.length;
          if (seatTotal > Balance.current) { toast("Not enough balance to rebet."); return; }
          state = freshState();
          state.selectedSeats = seats;
          state.betPerHand = b;
          state.push22PerHand = p;
          startDeal();
        });
        const doubleRebetBtn = root.querySelector("#ddm-double-rebet");
        if (doubleRebetBtn) doubleRebetBtn.addEventListener("click", () => {
          const prior = state.lastOpeningBet;
          const seats = prior ? prior.selectedSeats : state.selectedSeats;
          const b = clamp(Math.round((prior ? prior.betPerHand : state.betPerHand) * 2), MIN_BET, MAX_BET);
          const p = clamp(Math.round((prior ? prior.push22PerHand : state.push22PerHand) * 2), 0, MAX_BET);
          const seatTotal = (b + p) * seats.length;
          if (seatTotal > Balance.current) { toast("Not enough balance to double and rebet."); return; }
          state = freshState();
          state.selectedSeats = seats;
          state.betPerHand = b;
          state.push22PerHand = p;
          startDeal();
        });
      }
    }

    return {
      label: "Double Down Madness",
      icon: "🎰",
      order: 8,
      mount(el) {
        root = el;
        state = freshState();
        render();

        Balance.loadRoundState("doubledownmadness").then((saved) => {
          if (!saved || root !== el) return;
          if (!shoe) shoe = new Shoe(6, 0.25, freshDeck);
          state.hands = saved.hands;
          state.dealer = saved.dealer;
          state.dealerHoleHidden = saved.dealerHoleHidden;
          state.activeHandIndex = saved.activeHandIndex;
          state.insuranceOffered = saved.insuranceOffered;
          state.insuranceBet = saved.insuranceBet;
          state.insuranceProfit = saved.insuranceProfit;
          state.insuranceResolved = saved.insuranceResolved;
          state.phase = "player";
          render();
        }).catch(() => {});

        return () => { root = null; };
      },
    };
  })();

  window.SaltyCore.GAME_MODULES.doubledownmadness = SoloDoubleDownMadness;
})();