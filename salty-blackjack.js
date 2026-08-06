// ==UserScript==
// Salty's Casino — BLACKJACK MODULE
// Loaded via @require, after salty-core.js, by the main salty-casino.user.js
// loader. Registers itself into window.SaltyCore.GAME_MODULES.blackjack so
// it shows up automatically on the home grid.
//
// Two ways to play:
//   - Solo: up to 5 hands at once vs. one dealer, no waiting on anyone.
//   - Live Tables: three stakes tiers (Low / Mid / High Roller), each its
//     own real-time Firestore table with 5 seats, synced betting/turn
//     timers, side bets, bet-behind, and kick-after-2-missed-bets.
// ==/UserScript==
(function () {
  "use strict";

  const {
    MIN_BET, MAX_BET, GAME_MODULES, OVERLAY_ID, LS_HANDLE,
    Balance, Shoe, bjHandValue, isBlackjack, isSplittablePair, cardColor, RANK_ORDER, SUIT_GLYPH,
    clamp, delay, fmt, parseAmount, chipColor, chipStyle, CHIP_DENOMS, renderBetControls, wireBetControls, toast,
    getDb, getAuthReady, getUid, isFirebaseConfigured,
  } = window.SaltyCore;

  // -----------------------------------------------------------------------
  // Stakes tiers. Each is its own Firestore table doc (same schema,
  // different id/limits). Add a fourth tier by adding one more entry here.
  // -----------------------------------------------------------------------
  const LIVE_BJ_TIERS = [
    { key: "low", tableId: "table-low", label: "Low Roller", minBet: MIN_BET, maxBet: 100_000 },
    { key: "mid", tableId: "table-mid", label: "Mid Roller", minBet: 100_000, maxBet: 10_000_000 },
    { key: "high", tableId: "table-high", label: "High Roller", minBet: 10_000_000, maxBet: MAX_BET },
  ];
  const LIVE_BJ_TABLE_IDS = LIVE_BJ_TIERS.map((t) => t.tableId);
  function tierForTable(tableId) { return LIVE_BJ_TIERS.find((t) => t.tableId === tableId) || LIVE_BJ_TIERS[0]; }
  function myUid() { return getUid(); }

  const LIVE_BJ_SEATS = 5;
  const LIVE_BJ_MAX_ACTIVE = 2;
  const LIVE_BJ_DEAL_CARD_MS = 550;
  const LIVE_BJ_MAX_SPLITS = 3; // up to 4 hands per seat
  const LIVE_BJ_BETTING_MS = 25000;
  const LIVE_BJ_TURN_MS = 25000;
  const LIVE_BJ_KICK_AFTER_MISSES = 2;
  const LIVE_BJ_DEAL_TIMEOUT_MS = 15000;
  const LIVE_BJ_INSURANCE_MS = 10000;

  const SIDE_BET_PAYTABLES = {
    perfectPairs: { mixed: 5, colored: 12, perfect: 25 },
    twentyPlusThree: { flush: 5, straight: 10, threeKind: 30, straightFlush: 40, suitedTrips: 100 },
  };
  const DEALER_STANDS_SOFT_17 = true;
  const SURRENDER_RETURN_FRACTION = 0.5; // late surrender: forfeit half the bet, hand ends immediately
  const SOLO_MAX_HANDS_PER_SEAT = 4; // original hand + up to 3 splits, same cap as live's LIVE_BJ_MAX_SPLITS

  // A small fan of casino chips representing a locked-in bet, sized by
  // magnitude (more chips for a bigger bet) and colored via chipColor()
  // (core.js) — the same scale the pickable chip tray uses, so a chip is
  // the same color in your tray and sitting on the felt. Fanned
  // horizontally rather than stacked vertically — a vertical stack built
  // from negative top-margins can creep upward with no fixed ceiling and
  // end up overlapping whatever sits above it (the cards); a horizontal
  // fan only ever grows sideways in its own row, so it can't intrude on
  // the hand above it. Shared by solo and live so a bet looks the same
  // whichever mode you're in.
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

  // The curved felt rules text every real table has printed on it — a
  // gentle arc over the dealer's spot plus the two rule lines beneath.
  // Purely decorative/informational (no click targets), and the actual
  // numbers here are pulled from real constants so they can't drift out of
  // sync with the real payouts/rules if those ever change.
  function tableBannerHtml() {
    const insurancePayoutRatio = "2 TO 1"; // seat.insuranceBet * 3 returned = stake + 2x profit
    const blackjackPayoutRatio = "3 TO 2"; // hand.bet * 2.5 returned = stake + 1.5x profit
    return `
      <svg class="ov-banner" viewBox="0 0 440 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path id="ov-banner-arc" d="M 15,52 Q 220,8 425,52" fill="none"/>
        <text class="ov-banner-main"><textPath href="#ov-banner-arc" startOffset="50%" text-anchor="middle">BLACKJACK PAYS ${blackjackPayoutRatio}</textPath></text>
      </svg>
      <div class="ov-banner-sub">Dealer must draw to 16 and stand on all 17s</div>
      <div class="ov-banner-sub2">Insurance pays ${insurancePayoutRatio}</div>
    `;
  }

  // The shoe (stack of face-down cards) and discard tray in the corners —
  // purely atmospheric, reusing the existing card-back pattern so it
  // matches the actual cards on the table.
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

  // A small "Rules" button, meant to sit right above the table in both
  // modes. Rendered fresh every time (same as everything else here), so
  // callers need to re-wire its click handler after each render — same
  // pattern as every other button in this file.
  function rulesButtonRowHtml() {
    return `<div class="row" style="justify-content:flex-end;margin-bottom:6px"><button class="btn small" id="saltys-bj-rules-btn">📖 House Rules</button></div>`;
  }
  function wireRulesButton(root) {
    const btn = root && root.querySelector("#saltys-bj-rules-btn");
    if (btn) btn.addEventListener("click", showRulesModal);
  }

  // The rules explainer. Wording is generated from the real constants
  // (DEALER_STANDS_SOFT_17, SURRENDER_RETURN_FRACTION, SIDE_BET_PAYTABLES)
  // instead of being hand-typed, so if those ever change the printed rules
  // can't quietly fall out of sync with what the game actually does.
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
          <p><b>21+3</b> — pays out if your two cards plus the dealer's face-up card form a poker hand: a flush, straight, three of a kind, straight flush, or suited trips.</p>
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

  // Shared visual CSS for anything both solo and live use: side-bet chip
  // badges, the card deal-in animation, the live timer text, the new
  // chip-stack bet visuals, the felt rules banner, and the corner shoe/
  // discard decorations. Previously the side-bet chip styling only lived in
  // ensureLiveStyle() (called only by the live table), so solo's side-bet
  // indicators rendered with no styling at all — this fixes that by giving
  // both modes one shared style tag to inject.
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

      /* --- chip stack: a bet sitting on the felt --- */
      #${OVERLAY_ID} .chip-stack-wrap{ display:flex; flex-direction:column; align-items:center; gap:4px; }
      #${OVERLAY_ID} .chip-stack-discs{ display:flex; flex-direction:row; align-items:center; }
      #${OVERLAY_ID} .chip-stack-disc{ border-radius:50%; border:2px solid #1a1400; flex-shrink:0; box-shadow:0 2px 4px rgba(0,0,0,.5), inset 0 0 0 2px rgba(255,255,255,.12); }
      #${OVERLAY_ID} .chip-stack-label{ font:700 11px/1 "JetBrains Mono",monospace; color:var(--gold-bright); text-shadow:0 1px 3px rgba(0,0,0,.8); white-space:nowrap; }

      /* --- felt rules banner (the curved "BLACKJACK PAYS 3 TO 2" text) --- */
      #${OVERLAY_ID} .ov-banner{ position:absolute; top:0.5%; left:50%; transform:translateX(-50%); width:46%; max-width:360px; pointer-events:none; z-index:0; }
      #${OVERLAY_ID} .ov-banner-main{ font:800 18px/1 "Oswald",sans-serif; letter-spacing:1.5px; fill:rgba(244,207,101,.5); }
      #${OVERLAY_ID} .ov-banner-sub, #${OVERLAY_ID} .ov-banner-sub2{
        position:absolute; left:50%; transform:translateX(-50%); width:70%; text-align:center;
        font:700 8px/1.3 "Oswald",sans-serif; letter-spacing:.6px; text-transform:uppercase;
        color:rgba(244,207,101,.4); pointer-events:none; z-index:0; white-space:nowrap;
      }
      #${OVERLAY_ID} .ov-banner-sub{ top:8.5%; }
      #${OVERLAY_ID} .ov-banner-sub2{ top:10.8%; }

      /* --- corner shoe / discard tray decoration --- */
      #${OVERLAY_ID} .ov-corner-deco{ position:absolute; top:3%; display:flex; align-items:center; z-index:0; opacity:.9; }
      #${OVERLAY_ID} .ov-corner-left{ left:3%; }
      #${OVERLAY_ID} .ov-corner-right{ right:3%; }
      #${OVERLAY_ID} .ov-mini-card{ width:34px; height:48px; border-radius:4px; box-shadow:0 2px 5px rgba(0,0,0,.5); }
      #${OVERLAY_ID} .ov-discard-tray{
        width:52px; height:38px; border-radius:6px; border:2px solid rgba(74,47,20,.9);
        background:linear-gradient(180deg, rgba(0,0,0,.25), rgba(0,0,0,.1));
        box-shadow:inset 0 2px 6px rgba(0,0,0,.5);
      }

      /* --- rules modal (appended to document.body, like the disclaimer) --- */
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

  function emptyHand() {
    return { cards: [], bet: 0, status: "active", result: null, acted: false, isSplitAces: false, paid: false, fromSplit: false };
  }
  function emptySeat() {
    return {
      uid: null, name: null, status: "empty", hands: [], activeHandIndex: 0,
      sideBets: { perfectPairs: 0, twentyPlusThree: 0 }, sideBetResults: {}, sideBetsPaid: false,
      behindBets: [], joinedAt: null, missedRounds: 0,
      insuranceBet: 0, insuranceDeclined: false, insurancePaid: false,
    };
  }
  function freshLiveTable(tableId) {
    return {
      tableId, seats: Array.from({ length: LIVE_BJ_SEATS }, emptySeat),
      dealer: [], dealerHoleHidden: true, phase: "idle",
      turnSeatIndex: -1, turnHandIndex: 0, roundId: 0,
      phaseDeadline: null,
    };
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

  // -----------------------------------------------------------------------
  // Lobby styling: hero banner, mode cards, tier cards. Injected lazily.
  // -----------------------------------------------------------------------
  function ensureBlackjackLobbyStyle() {
    if (document.getElementById("saltys-bj-lobby-style")) return;
    const s = document.createElement("style");
    s.id = "saltys-bj-lobby-style";
    s.textContent = `
      #${OVERLAY_ID} .bj-lobby{ display:flex; flex-direction:column; gap:22px; }
      #${OVERLAY_ID} .bj-lobby-hero{
        text-align:center; padding:28px 20px; border-radius:16px;
        background:radial-gradient(ellipse at 50% -20%, rgba(212,175,55,.12), transparent 60%), var(--panel);
        border:1px solid var(--border);
      }
      #${OVERLAY_ID} .bj-lobby-eyebrow{ font-size:11px; letter-spacing:2px; text-transform:uppercase; color:var(--gold); font-weight:700; margin-bottom:6px; }
      #${OVERLAY_ID} .bj-lobby-title{ font:800 32px/1 "Oswald",sans-serif; letter-spacing:.5px; }
      #${OVERLAY_ID} .bj-lobby-sub{ color:var(--text-dim); font-size:13px; margin-top:8px; }
      #${OVERLAY_ID} .bj-mode-grid{ display:grid; grid-template-columns:repeat(2,1fr); gap:18px; }
      @media (max-width:720px){ #${OVERLAY_ID} .bj-mode-grid{ grid-template-columns:1fr; } }
      #${OVERLAY_ID} .bj-mode-card{
        position:relative; background:var(--panel); border:1px solid var(--border); border-radius:16px;
        padding:26px 22px; display:flex; flex-direction:column; align-items:center; text-align:center; gap:10px;
        transition:border-color .15s ease, transform .15s ease;
      }
      #${OVERLAY_ID} .bj-mode-card:hover{ border-color:var(--gold); transform:translateY(-2px); }
      #${OVERLAY_ID} .bj-mode-card.featured{ border-color:rgba(212,175,55,.4); background:linear-gradient(180deg, rgba(212,175,55,.06), var(--panel) 60%); }
      #${OVERLAY_ID} .bj-mode-badge{ position:absolute; top:14px; right:14px; background:var(--gold); color:#1a1400; font-weight:800; font-size:10px; text-transform:uppercase; letter-spacing:.5px; padding:3px 8px; border-radius:999px; }
      #${OVERLAY_ID} .bj-mode-icon{ font-size:38px; }
      #${OVERLAY_ID} .bj-mode-name{ font:700 18px/1 "Oswald",sans-serif; }
      #${OVERLAY_ID} .bj-mode-desc{ color:var(--text-dim); font-size:12.5px; line-height:1.5; max-width:280px; }
      #${OVERLAY_ID} .bj-tier-grid{ display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
      @media (max-width:820px){ #${OVERLAY_ID} .bj-tier-grid{ grid-template-columns:1fr; } }
      #${OVERLAY_ID} .bj-tier-card{
        background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:20px 16px;
        display:flex; flex-direction:column; align-items:center; gap:8px; text-align:center;
      }
      #${OVERLAY_ID} .bj-tier-card.low{ border-top:3px solid var(--success); }
      #${OVERLAY_ID} .bj-tier-card.mid{ border-top:3px solid var(--gold); }
      #${OVERLAY_ID} .bj-tier-card.high{ border-top:3px solid var(--purple); }
      #${OVERLAY_ID} .bj-tier-name{ font:700 17px/1 "Oswald",sans-serif; }
      #${OVERLAY_ID} .bj-tier-limits{ font-size:12px; color:var(--gold-bright); font-weight:700; font-family:"JetBrains Mono",monospace; }
      #${OVERLAY_ID} .pill.tier-low{ color:var(--success); border-color:var(--success); }
      #${OVERLAY_ID} .pill.tier-mid{ color:var(--gold-bright); border-color:var(--gold); }
      #${OVERLAY_ID} .pill.tier-high{ color:var(--purple-bright); border-color:var(--purple); }
    `;
    document.head.appendChild(s);
  }

  // =====================================================================
  // HUB — mode select (Solo vs Live), then live tier select.
  // =====================================================================
  const BlackjackHub = (function () {
    let root = null;
    let mode = null;
    let childUnmount = null;

    function renderModeSelect() {
      ensureBlackjackLobbyStyle();
      root.innerHTML = `
        <div class="bj-lobby">
          <div class="bj-lobby-hero">
            <div class="bj-lobby-eyebrow">Table Games</div>
            <div class="bj-lobby-title">Blackjack</div>
            <div class="bj-lobby-sub">Classic 6-deck shoe &middot; dealer stands on soft 17 &middot; blackjack pays 3:2</div>
          </div>
          <div class="bj-mode-grid">
            <div class="bj-mode-card" data-mode="solo">
              <div class="bj-mode-icon">🃏</div>
              <div class="bj-mode-name">Solo Play</div>
              <div class="bj-mode-desc">Play at your own pace against the dealer. Spread your action across up to 5 hands at once — no waiting on anyone.</div>
              <button class="btn primary" data-mode="solo">Sit Down</button>
            </div>
            <div class="bj-mode-card featured" data-mode="live">
              <div class="bj-mode-badge">Live</div>
              <div class="bj-mode-icon">🎩</div>
              <div class="bj-mode-name">Live Tables</div>
              <div class="bj-mode-desc">Join other players at a real-time table. Choose your stakes — Low, Mid, or High Roller — then take a seat.</div>
              <button class="btn primary gold" data-mode="live">Choose a Table</button>
            </div>
          </div>
        </div>`;
      root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
        mode = b.dataset.mode;
        if (mode === "solo") mountSolo();
        else renderTableSelect();
      }));
    }

    function renderTableSelect() {
      ensureBlackjackLobbyStyle();
      root.innerHTML = `<div class="bj-lobby">
        <div class="row" style="justify-content:space-between;align-items:center">
          <div class="bj-lobby-title" style="font-size:22px">Choose Your Stakes</div>
          <button class="btn small" id="lbj-back-mode">&larr; Back</button>
        </div>
        <div class="bj-tier-grid" id="lbj-table-cards">
          ${LIVE_BJ_TIERS.map((tier) => `
            <div class="bj-tier-card ${tier.key}" data-table-card="${tier.tableId}">
              <div class="bj-tier-name">${tier.label}</div>
              <div class="bj-tier-limits">${fmt(tier.minBet)} &ndash; ${fmt(tier.maxBet)} tokens</div>
              <div class="muted" id="lbj-meta-${tier.tableId}" style="min-height:18px">Loading…</div>
              <button class="btn primary small" data-choose="${tier.tableId}">Join Table</button>
            </div>`).join("")}
        </div>
      </div>`;
      LIVE_BJ_TIERS.forEach(async (tier) => {
        const el = root.querySelector(`#lbj-meta-${tier.tableId}`);
        if (!isFirebaseConfigured()) { if (el) el.textContent = "Firebase not configured"; return; }
        try {
          const u = await getAuthReady();
          if (!u || !isFirebaseConfigured()) { if (el) el.textContent = "Offline — Firebase auth unavailable"; return; }
          const ensureRef = getDb().collection("blackjacktables").doc(tier.tableId);
          const snap = await ensureRef.get();
          const t = snap.exists ? snap.data() : freshLiveTable(tier.tableId);
          const occ = t.seats.filter((s) => s.status !== "empty").length;
          if (el) el.textContent = `${occ}/${LIVE_BJ_SEATS} seated · ${t.phase === "idle" ? "idle" : t.phase}`;
        } catch (e) {
          if (el) el.textContent = "Could not load table.";
        }
      });
      root.querySelector("#lbj-back-mode").addEventListener("click", () => { mode = null; renderModeSelect(); });
      root.querySelectorAll("[data-choose]").forEach((b) => b.addEventListener("click", () => mountLive(b.dataset.choose)));
    }

    function unmountChild() {
      if (childUnmount) { try { childUnmount(); } catch (e) {} childUnmount = null; }
    }

    function mountSolo() {
      unmountChild();
      const wrap = document.createElement("div");
      root.innerHTML = "";
      root.appendChild(wrap);
      const backBtn = document.createElement("button");
      backBtn.className = "btn small mt8";
      backBtn.textContent = "← Back to mode select";
      backBtn.addEventListener("click", () => { unmountChild(); mode = null; renderModeSelect(); });
      root.appendChild(backBtn);
      childUnmount = SoloBlackjackMulti.mount(wrap);
    }

    function mountLive(tableId) {
      unmountChild();
      const wrap = document.createElement("div");
      root.innerHTML = "";
      root.appendChild(wrap);
      const backBtn = document.createElement("button");
      backBtn.className = "btn small mt8";
      backBtn.textContent = "← Choose a different table";
      backBtn.addEventListener("click", () => { unmountChild(); renderTableSelect(); });
      root.appendChild(backBtn);
      LiveBlackjack.setTable(tableId);
      const mountResult = LiveBlackjack.mount(wrap);
      if (mountResult && typeof mountResult.then === "function") {
        mountResult.then((u) => { childUnmount = u; });
      } else {
        childUnmount = mountResult;
      }
    }

    return {
      label: "Blackjack",
      icon: "🃏",
      order: 1,
      mount(el) {
        root = el; mode = null;
        renderModeSelect();
        return () => { unmountChild(); root = null; };
      },
    };
  })();

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
    let root = null, shoe = null, state = null, busy = false;
    const dealtAnimated = new Set();

    function freshState() {
      return {
        phase: "betting", selectedSeats: [], betPerHand: Math.min(100, MAX_BET),
        sidePPPerHand: 0, side21PerHand: 0, hands: [], dealer: [], dealerHoleHidden: true,
        activeHandIndex: 0, insuranceOffered: false, insuranceBet: 0, insuranceResolved: false, lastResults: null,
      };
    }
    function newHand(cards, bet, sidePP = 0, side21 = 0, seatIdx) {
      return {
        cards, bet, status: "active", result: null, acted: false, isSplitAces: false,
        sideBets: { perfectPairs: sidePP, twentyPlusThree: side21 }, sideBetResults: {}, seatIdx,
      };
    }

    async function startDeal() {
      if (busy) return;
      if (!state.selectedSeats.length) { toast("Select at least one seat to play."); return; }
      const bet = clamp(Math.round(state.betPerHand), MIN_BET, MAX_BET);
      const pp = clamp(Math.round(state.sidePPPerHand || 0), 0, MAX_BET);
      const t21 = clamp(Math.round(state.side21PerHand || 0), 0, MAX_BET);
      const numHands = state.selectedSeats.length;
      const total = (bet + pp + t21) * numHands;
      if (total > Balance.current) { toast("Not enough balance for that many seats at this bet."); return; }
      busy = true; render();
      try { await Balance.applyDelta(-total, "solo_bj_deal_multi"); }
      catch (e) { toast("Bet failed."); busy = false; render(); return; }
      if (!shoe) shoe = new Shoe(6, 0.25);
      dealtAnimated.clear();
      const seatOrder = [...state.selectedSeats].sort((a, b) => a - b);
      state.hands = seatOrder.map((seatIdx) => newHand([], bet, pp, t21, seatIdx));
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
          await delay(SOLO_DEAL_CARD_MS);
        }
        state.dealer.push(shoe.draw());
        render();
        await delay(SOLO_DEAL_CARD_MS);
      }
      for (const hand of state.hands) {
        if (hand.sideBets.perfectPairs > 0) hand.sideBetResults.perfectPairs = evalPerfectPairs(hand.cards);
        if (hand.sideBets.twentyPlusThree > 0) hand.sideBetResults.twentyPlusThree = evalTwentyPlusThree(hand.cards, state.dealer[0]);
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
      // One insurance decision covers the whole round, so it's sized to
      // your total exposure across every hand you're playing this round —
      // not just the first seat's bet — since it's the only chance you get
      // to insure any of them.
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
        await delay(SOLO_DEAL_CARD_MS);
        const v = bjHandValue(hand.cards).total;
        if (v > 21) hand.status = "bust";
        else if (hand.isSplitAces) hand.status = "stood";
      } else if (action === "stand") {
        hand.status = "stood";
      } else if (action === "double") {
        if (Balance.current < hand.bet) { toast("Not enough balance to double."); busy = false; render(); return; }
        await Balance.applyDelta(-hand.bet, "solo_bj_double_multi");
        hand.bet *= 2;
        hand.cards.push(shoe.draw());
        render();
        await delay(SOLO_DEAL_CARD_MS);
        hand.status = bjHandValue(hand.cards).total > 21 ? "bust" : "stood";
      } else if (action === "split") {
        const [c0, c1] = hand.cards;
        if (Balance.current < hand.bet) { toast("Not enough balance to split."); busy = false; render(); return; }
        await Balance.applyDelta(-hand.bet, "solo_bj_split_multi");
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
        await delay(SOLO_DEAL_CARD_MS);
        newH.cards.push(shoe.draw());
        render();
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
      state.lastResults = { totalProfit, handProfitTotal, sideBetProfitTotal, insuranceProfit };
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
          const soloSideBetHtml = soloSideChips.length ? `<div class="lbj-sidebet-strip">${soloSideChips.join("")}</div>` : "";
          const resultOverlay = hand.status === "bust" ? `<div class="ov-result-overlay">${v.total} – Bust</div>`
            : hand.result === "blackjack" ? `<div class="ov-result-overlay">Blackjack!</div>` : "";
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

      // One clear, prominent result — centered on the felt instead of a
      // small line tucked below the table — with a real breakdown instead
      // of a single lumped number, since hand and side-bet results are
      // often opposite signs and a single total can hide what actually
      // happened.
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
      if (state.phase === "betting") {
        const seatPickHtml = SEAT_POS.map((pos, i) => {
          const picked = state.selectedSeats.includes(i);
          return `<div class="ov-seat" data-seat="${i}" style="left:${pos.left}%;top:${pos.top}%;cursor:pointer">
            <div class="ov-cardslot ${picked ? "" : "empty"}" style="transform:rotate(${pos.rotate});${picked ? "border-color:var(--gold)" : ""}"></div>
            <div style="min-height:34px;display:flex;align-items:flex-end;justify-content:center">${picked ? chipStackHtml(state.betPerHand, { size: 18 }) : ""}</div>
          </div>`;
        }).join("");
        root.innerHTML = rulesButtonRowHtml() + `<div class="ov-wrap"><div class="ov-table">
            ${tableBannerHtml()}
            ${shoeDecorHtml()}
            <div class="ov-dealer"><div class="ov-dealer-hand"></div><div class="ov-dealer-label">Dealer's Cards</div></div>
            <div class="ov-hint">Click a seat to play that hand</div>
            ${seatPickHtml}
          </div></div>
          <div class="panel col" style="max-width:420px;margin:16px auto 0;gap:10px">
            <div class="muted center">${state.selectedSeats.length} seat${state.selectedSeats.length === 1 ? "" : "s"} selected</div>
            <div class="row"><span class="muted">Bet per hand</span></div>
            ${renderBetControls("sbj", state.betPerHand, busy)}
            <div class="lbj-sidebet-row">
              <input type="text" id="sbj-pp" placeholder="Pairs (e.g. 100k)" value="${state.sidePPPerHand ? fmt(state.sidePPPerHand) : ""}" ${busy ? "disabled" : ""}>
              <input type="text" id="sbj-213" placeholder="21+3 (e.g. 1m)" value="${state.side21PerHand ? fmt(state.side21PerHand) : ""}" ${busy ? "disabled" : ""}>
            </div>
            <div class="muted">Total wager: ${fmt((state.betPerHand + (state.sidePPPerHand || 0) + (state.side21PerHand || 0)) * state.selectedSeats.length)}</div>
            <button class="btn primary" id="sbj-deal" ${busy || !state.selectedSeats.length ? "disabled" : ""}>Deal</button>
          </div>`;
        wireRulesButton(root);
        root.querySelectorAll("[data-seat]").forEach((el) => el.addEventListener("click", () => {
          const i = parseInt(el.dataset.seat, 10);
          const idx = state.selectedSeats.indexOf(i);
          if (idx >= 0) state.selectedSeats.splice(idx, 1);
          else if (state.selectedSeats.length < MAX_HANDS) state.selectedSeats.push(i);
          else toast(`You can only play up to ${MAX_HANDS} seats at once.`);
          render();
        }));
        wireBetControls(root, "sbj", () => state.betPerHand, (v) => { state.betPerHand = v; render(); });
        const ppInput = root.querySelector("#sbj-pp");
        if (ppInput) ppInput.addEventListener("change", (e) => {
          const parsed = parseAmount(e.target.value);
          state.sidePPPerHand = !isNaN(parsed) ? clamp(parsed, 0, MAX_BET) : 0;
          render();
        });
        const t213Input = root.querySelector("#sbj-213");
        if (t213Input) t213Input.addEventListener("change", (e) => {
          const parsed = parseAmount(e.target.value);
          state.side21PerHand = !isNaN(parsed) ? clamp(parsed, 0, MAX_BET) : 0;
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
          <button class="btn primary" id="sbj-rebet">Rebet ${fmt(state.betPerHand)}${state.sidePPPerHand || state.side21PerHand ? " + sides" : ""}</button>
          <button class="btn" id="sbj-again">Change Bet</button>
        </div>`;
      } else {
        controls = `<div class="center muted">Dealer playing…</div>`;
      }
      root.innerHTML = rulesButtonRowHtml() + renderSoloOvalTable() + `<div class="mt16">${controls}</div>`;
      wireRulesButton(root);
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
          const seats = state.selectedSeats, b = state.betPerHand, pp = state.sidePPPerHand, t21 = state.side21PerHand;
          state = freshState();
          state.selectedSeats = seats;
          state.betPerHand = b;
          state.sidePPPerHand = pp;
          state.side21PerHand = t21;
          render();
        });
        root.querySelector("#sbj-rebet").addEventListener("click", () => {
          const seats = state.selectedSeats, b = state.betPerHand, pp = state.sidePPPerHand, t21 = state.side21PerHand;
          state = freshState();
          state.selectedSeats = seats;
          state.betPerHand = b;
          state.sidePPPerHand = pp;
          state.side21PerHand = t21;
          startDeal();
        });
      }
    }

    return {
      mount(el) {
        root = el;
        state = freshState();
        render();
        return () => { root = null; };
      },
    };
  })();

  // =====================================================================
  // LIVE TABLES — idle until seated, tier-based bet limits, 25s betting,
  // 25s per-decision timer, split up to 4 hands, bet-behind, side bets,
  // kick after 2 unbet misses.
  // =====================================================================
  const LiveBlackjack = (function () {
    let root = null, tableId = "table-mid", unsubTable = null, unsubChat = null, tickTimer = null;
    let mySeatIndex = -1, tableDoc = null, chatMessages = [], shoe = null, busy = false;
    let myPendingBet = 100, myPendingPP = 0, myPending213 = 0, myPendingBehind = 50;
    const dealtAnimated = new Set();

    function tref() { return getDb().collection("blackjacktables").doc(tableId); }
    function chatRef() { return tref().collection("chat"); }
    function setTable(id) { tableId = id; mySeatIndex = -1; }

    async function ensureTableDoc() {
      const snap = await tref().get();
      if (!snap.exists) await tref().set(freshLiveTable(tableId));
    }
    function occupiedSeats(t) { return t.seats.filter((s) => s.status !== "empty"); }
    function activeRoster(t) {
      return t.seats.map((s, i) => ({ ...s, i })).filter((s) => s.status === "waiting" || s.status === "active")
        .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0)).slice(0, LIVE_BJ_MAX_ACTIVE).map((s) => s.i);
    }

    async function joinSeat(idx) {
      if (!isFirebaseConfigured()) { toast("Live tables require Firebase to be configured."); return; }
      await getAuthReady();
      try {
        await getDb().runTransaction(async (tx) => {
          const t = (await tx.get(tref())).data();
          if (t.seats[idx].status !== "empty") throw new Error("taken");
          if (t.seats.some((s) => s.uid === myUid())) throw new Error("already-seated");
          t.seats[idx] = { ...emptySeat(), uid: myUid(), name: localStorage.getItem(LS_HANDLE) || "Player", status: "waiting", joinedAt: Date.now() };
          if (t.phase === "idle") { t.phase = "betting"; t.phaseDeadline = Date.now() + LIVE_BJ_BETTING_MS; }
          tx.set(tref(), t);
        });
        mySeatIndex = idx;
        const tier = tierForTable(tableId);
        myPendingBet = clamp(myPendingBet, tier.minBet, tier.maxBet);
      } catch (e) { toast("Could not join that seat."); }
    }

    async function leaveSeat() {
      if (mySeatIndex < 0) return;
      await getDb().runTransaction(async (tx) => {
        const t = (await tx.get(tref())).data();
        if (t.seats[mySeatIndex].uid === myUid()) t.seats[mySeatIndex] = emptySeat();
        if (occupiedSeats(t).length === 0) { t.phase = "idle"; t.phaseDeadline = null; }
        tx.set(tref(), t);
      });
      mySeatIndex = -1;
    }

    async function placeBet(amount, sidePP, side21) {
      if (mySeatIndex < 0) { toast("Take a seat first."); return; }
      const tier = tierForTable(tableId);
      amount = clamp(Math.round(amount), tier.minBet, tier.maxBet);
      const totalDebit = amount + (sidePP || 0) + (side21 || 0);
      if (totalDebit > Balance.current) { toast("Not enough balance."); return; }
      try {
        await getDb().runTransaction(async (tx) => {
          const t = (await tx.get(tref())).data();
          if (t.phase !== "betting") throw new Error("betting-closed");
          const seat = t.seats[mySeatIndex];
          seat.hands = [{ ...emptyHand(), bet: amount }];
          seat.sideBets = { perfectPairs: sidePP || 0, twentyPlusThree: side21 || 0 };
          seat.missedRounds = 0;
          tx.set(tref(), t);
        });
        await Balance.applyDelta(-totalDebit, "live_bj_bet");
      } catch (e) { toast("Bet failed: " + e.message); }
    }

    async function betBehind(seatIdx, amount) {
      amount = clamp(Math.round(amount), MIN_BET, MAX_BET);
      if (amount > Balance.current) { toast("Not enough balance."); return; }
      try {
        await getDb().runTransaction(async (tx) => {
          const t = (await tx.get(tref())).data();
          if (t.phase !== "betting") throw new Error("betting-closed");
          const seat = t.seats[seatIdx];
          if (!seat || seat.status === "empty") throw new Error("no-seat");
          if (seat.behindBets.some((b) => b.uid === myUid())) throw new Error("already-behind");
          seat.behindBets.push({ uid: myUid(), name: localStorage.getItem(LS_HANDLE) || "Player", amount, result: null, paid: false });
          tx.set(tref(), t);
        });
        await Balance.applyDelta(-amount, "live_bj_behind");
        toast(`Bet placed behind seat ${seatIdx + 1}.`);
      } catch (e) { toast("Behind bet failed: " + e.message); }
    }

    async function tick() {
      const t = (await tref().get()).data();
      if (!t) return;
      const occ = occupiedSeats(t);
      if (occ.length === 0) {
        if (t.phase !== "idle") { try { await tref().set({ ...t, phase: "idle", phaseDeadline: null }); } catch (e) {} }
        return;
      }
      const now = Date.now();
      if (t.phase === "betting" && t.phaseDeadline && now >= t.phaseDeadline) {
        try {
          await getDb().runTransaction(async (tx) => {
            const t2 = (await tx.get(tref())).data();
            if (t2.phase !== "betting") throw new Error("advanced");
            t2.seats.forEach((seat, i) => {
              if (seat.status === "empty") return;
              const bet = seat.hands[0] && seat.hands[0].bet > 0;
              if (bet) seat.missedRounds = 0;
              else { seat.missedRounds = (seat.missedRounds || 0) + 1; if (seat.missedRounds >= LIVE_BJ_KICK_AFTER_MISSES) t2.seats[i] = emptySeat(); }
            });
            const roster = t2.seats.map((s, i) => ({ ...s, i }))
              .filter((s) => s.status === "waiting" || s.status === "active")
              .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0)).slice(0, LIVE_BJ_MAX_ACTIVE).map((s) => s.i);
            const withBets = roster.filter((i) => t2.seats[i].hands[0] && t2.seats[i].hands[0].bet > 0);
            if (withBets.length === 0) {
              const stillOccupied = t2.seats.some((s) => s.status !== "empty");
              if (!stillOccupied) { t2.phase = "idle"; t2.phaseDeadline = null; }
              else { t2.phaseDeadline = Date.now() + LIVE_BJ_BETTING_MS; }
              tx.set(tref(), t2);
              return;
            }
            withBets.forEach((i) => { t2.seats[i].status = "active"; t2.seats[i].insuranceBet = 0; t2.seats[i].insuranceDeclined = false; });
            t2.phase = "dealing";
            t2.dealer = [];
            t2.dealerHoleHidden = true;
            t2.roundId = (t2.roundId || 0) + 1;
            t2.phaseDeadline = Date.now() + LIVE_BJ_DEAL_TIMEOUT_MS;
            tx.set(tref(), t2);
          });
          const after = (await tref().get()).data();
          if (after.phase === "dealing") await dealSequence();
        } catch (e) { /* another client already advanced this round */ }
        return;
      }
      if (t.phase === "dealing" && t.phaseDeadline && now >= t.phaseDeadline) {
        try {
          let shouldDeal = false;
          await getDb().runTransaction(async (tx) => {
            const t2 = (await tx.get(tref())).data();
            if (t2.phase !== "dealing" || !(t2.phaseDeadline && Date.now() >= t2.phaseDeadline)) throw new Error("already-progressed");
            t2.phaseDeadline = Date.now() + LIVE_BJ_DEAL_TIMEOUT_MS;
            tx.set(tref(), t2);
            shouldDeal = true;
          });
          if (shouldDeal) await dealSequence();
        } catch (e) { /* another client already resumed or finished it */ }
        return;
      }
      if (t.phase === "insurance") {
        const expired = t.phaseDeadline && now >= t.phaseDeadline;
        const allDecided = t.seats.every((s) => s.status !== "active" || s.insuranceBet > 0 || s.insuranceDeclined);
        if (!expired && !allDecided) return;
        try {
          let shouldResolve = false;
          let committedT = null;
          await getDb().runTransaction(async (tx) => {
            const t2 = (await tx.get(tref())).data();
            if (t2.phase !== "insurance") throw new Error("already-progressed");
            for (const seat of t2.seats) {
              if (seat.status === "active" && seat.insuranceBet === 0 && !seat.insuranceDeclined) seat.insuranceDeclined = true;
            }
            tx.set(tref(), t2);
            shouldResolve = true;
            committedT = t2;
          });
          if (shouldResolve && committedT) await resolveDealerPeekLive(committedT);
        } catch (e) { /* another client already resolved this round's insurance */ }
        return;
      }
      if (t.phase === "player-turns") {
        const expired = t.phaseDeadline && now >= t.phaseDeadline;
        if (!expired) return;
        // Normal case: nobody acted before the timer ran out — auto-stand.
        // Fallback case: the hand was already resolved (bust/stand/double/
        // split-aces) but, for whatever reason (e.g. the acting client lost
        // its connection right after committing), the turn never advanced.
        // Either way, once the deadline is up there's nothing left to wait
        // on, so move play along.
        const seat = t.seats[t.turnSeatIndex];
        const hand = seat && seat.hands[t.turnHandIndex];
        if (hand && hand.status === "active") hand.status = "stood";
        await advanceTurn(t);
      }
    }

    async function dealSequence() {
      if (!shoe) shoe = new Shoe(6, 0.25);
      const t = (await tref().get()).data();
      if (t.phase !== "dealing") return;
      const startRound = t.dealer.length;
      for (let round = startRound; round < 2; round++) {
        for (const seat of t.seats) {
          if (seat.status === "active" && seat.hands[0].cards.length === round) seat.hands[0].cards.push(shoe.draw());
        }
        if (t.dealer.length === round) t.dealer.push(shoe.draw());
      }
      await tref().set(t);
      await delay(LIVE_BJ_DEAL_CARD_MS);

      for (const seat of t.seats) {
        if (seat.status !== "active") continue;
        const cards = seat.hands[0].cards;
        if (seat.sideBets.perfectPairs > 0) seat.sideBetResults.perfectPairs = evalPerfectPairs(cards);
        if (seat.sideBets.twentyPlusThree > 0) seat.sideBetResults.twentyPlusThree = evalTwentyPlusThree(cards, t.dealer[0]);
      }

      // Real tables offer insurance and wait for every player to decide
      // BEFORE the dealer checks their hole card — peeking first would make
      // the decision meaningless. So when the up-card is an Ace, pause here
      // in a dedicated "insurance" phase instead of resolving immediately;
      // tick() (or takeInsurance/declineInsurance, once everyone's decided)
      // carries the peek out from there.
      if (t.dealer[0].r === "A") {
        t.phase = "insurance";
        t.phaseDeadline = Date.now() + LIVE_BJ_INSURANCE_MS;
        await tref().set(t);
        return;
      }

      await resolveDealerPeekLive(t);
    }

    // The "dealer peek": checks the hole card, resolves any blackjacks
    // (a player's, the dealer's, or both), and — since insurance decisions
    // are already settled by the time this runs — leaves insurance payout
    // to reconcileMyPayouts once the round reaches "settled". If the
    // dealer does have blackjack, every hand is done right here; nobody
    // plays a hand out against a dealer that already can't lose.
    async function resolveDealerPeekLive(t) {
      const dealerBJ = isBlackjack(t.dealer);
      for (const seat of t.seats) {
        if (seat.status !== "active") continue;
        const hand = seat.hands[0];
        const handBJ = isBlackjack(hand.cards);
        if (dealerBJ) {
          hand.acted = true;
          if (handBJ) { hand.status = "push"; hand.result = "push"; hand.profit = 0; }
          else { hand.status = "push"; hand.result = "lose"; hand.profit = -hand.bet; }
        } else if (handBJ) {
          hand.status = "blackjack"; hand.result = "blackjack"; hand.acted = true; hand.profit = Math.round(hand.bet * 1.5);
        }
      }
      t.phase = "player-turns";
      t.turnSeatIndex = t.seats.findIndex((s) => s.status === "active" && s.hands[0].status === "active");
      t.turnHandIndex = 0;
      t.phaseDeadline = Date.now() + LIVE_BJ_TURN_MS;
      await tref().set(t);

      if (t.turnSeatIndex < 0) await advanceTurn(t);
    }

    async function takeInsurance(seatIdx) {
      if (busy) return;
      busy = true;
      try {
        let amount = 0;
        let allDecided = false;
        let committedT = null;
        await getDb().runTransaction(async (tx) => {
          const t = (await tx.get(tref())).data();
          if (t.phase !== "insurance") throw new Error("insurance-closed");
          const seat = t.seats[seatIdx];
          if (!seat || seat.uid !== myUid() || seat.insuranceBet > 0) throw new Error("cannot-insure");
          amount = clamp(Math.round((seat.hands[0]?.bet || 0) / 2), MIN_BET, MAX_BET);
          if (Balance.current < amount) throw new Error("insufficient-balance");
          seat.insuranceBet = amount;
          allDecided = t.seats.every((s) => s.status !== "active" || s.insuranceBet > 0 || s.insuranceDeclined);
          tx.set(tref(), t);
          committedT = t;
        });
        if (amount > 0) await Balance.applyDelta(-amount, "live_bj_insurance_bet");
        if (allDecided && committedT) await resolveDealerPeekLive(committedT);
      } catch (e) { toast("Insurance failed: " + e.message); }
      busy = false;
    }
    async function declineInsurance(seatIdx) {
      if (busy) return;
      busy = true;
      try {
        let allDecided = false;
        let committedT = null;
        await getDb().runTransaction(async (tx) => {
          const t = (await tx.get(tref())).data();
          if (t.phase !== "insurance") throw new Error("insurance-closed");
          const seat = t.seats[seatIdx];
          if (!seat || seat.uid !== myUid()) throw new Error("not-your-seat");
          seat.insuranceDeclined = true;
          allDecided = t.seats.every((s) => s.status !== "active" || s.insuranceBet > 0 || s.insuranceDeclined);
          tx.set(tref(), t);
          committedT = t;
        });
        if (allDecided && committedT) await resolveDealerPeekLive(committedT);
      } catch (e) { /* ignore */ }
      busy = false;
    }

    async function act(action) {
      if (mySeatIndex < 0 || busy) return;
      busy = true;
      let debit = 0;
      let committedT = null;
      let needsAdvance = false;
      try {
        await getDb().runTransaction(async (tx) => {
          const t = (await tx.get(tref())).data();
          if (t.phase !== "player-turns" || t.turnSeatIndex !== mySeatIndex) throw new Error("not-your-turn");
          const seat = t.seats[mySeatIndex];
          const hi = t.turnHandIndex;
          const hand = seat.hands[hi];
          if (action === "hit") {
            hand.cards.push(shoe.draw());
            hand.acted = true;
            const v = bjHandValue(hand.cards).total;
            if (v > 21) hand.status = "bust";
            else if (hand.isSplitAces) hand.status = "stood";
          } else if (action === "stand") {
            hand.status = "stood"; hand.acted = true;
          } else if (action === "double") {
            if (Balance.current < hand.bet) throw new Error("insufficient-balance");
            debit = hand.bet;
            hand.bet *= 2;
            hand.cards.push(shoe.draw());
            hand.status = bjHandValue(hand.cards).total > 21 ? "bust" : "stood";
            hand.acted = true;
          } else if (action === "split") {
            if (seat.hands.length > LIVE_BJ_MAX_SPLITS) throw new Error("max-splits");
            const c0 = hand.cards[0], c1 = hand.cards[1];
            if (!isSplittablePair(c0, c1)) throw new Error("not-pair");
            if (Balance.current < hand.bet) throw new Error("insufficient-balance");
            debit = hand.bet;
            const isAces = c0.r === "A";
            hand.cards = [c0, shoe.draw()];
            hand.isSplitAces = isAces;
            hand.fromSplit = true;
            if (isAces) hand.status = "stood";
            const newHand2 = { ...emptyHand(), cards: [c1, shoe.draw()], bet: hand.bet, isSplitAces: isAces, fromSplit: true };
            if (isAces) newHand2.status = "stood";
            seat.hands.splice(hi + 1, 0, newHand2);
          } else if (action === "surrender") {
            if (hand.acted || hand.cards.length !== 2 || hand.fromSplit) throw new Error("cannot-surrender");
            hand.status = "surrender"; hand.result = "surrender"; hand.acted = true;
            hand.profit = -Math.round(hand.bet * (1 - SURRENDER_RETURN_FRACTION));
          }
          needsAdvance = hand.status !== "active";
          t.phaseDeadline = Date.now() + LIVE_BJ_TURN_MS;
          tx.set(tref(), t);
          committedT = t;
        });
        if (debit > 0) await Balance.applyDelta(-debit, action === "double" ? "live_bj_double" : "live_bj_split");
        // Standing, busting, doubling, or auto-resolved split aces all end this
        // hand's turn — move play on to the next hand/seat (or to the dealer if
        // that was the last one). A plain hit that doesn't bust leaves the hand
        // active, so needsAdvance stays false and the same player keeps acting.
        if (needsAdvance && committedT) await advanceTurn(committedT);
      } catch (e) { toast("Action failed: " + e.message); }
      busy = false;
    }


    function seatHasPlayableHand(seat) { return seat && seat.status === "active" && seat.hands.some((h) => h.status === "active"); }

    async function advanceTurn(t) {
      const seat = t.seats[t.turnSeatIndex];
      if (seat) {
        let hi = t.turnHandIndex + 1;
        while (hi < seat.hands.length && seat.hands[hi].status !== "active") hi++;
        if (hi < seat.hands.length) {
          t.turnHandIndex = hi;
          t.phaseDeadline = Date.now() + LIVE_BJ_TURN_MS;
          await tref().set(t);
          return;
        }
      }
      let next = t.turnSeatIndex + 1;
      while (next < LIVE_BJ_SEATS && !seatHasPlayableHand(t.seats[next])) next++;
      if (next >= LIVE_BJ_SEATS) {
        await runDealerAndSettle(t);
      } else {
        const nextHi = t.seats[next].hands.findIndex((h) => h.status === "active");
        t.turnSeatIndex = next;
        t.turnHandIndex = nextHi;
        t.phaseDeadline = Date.now() + LIVE_BJ_TURN_MS;
        await tref().set(t);
      }
    }

    async function runDealerAndSettle(t) {
      t.phase = "dealer";
      t.dealerHoleHidden = false;
      t.phaseDeadline = null;
      const anyLive = t.seats.some((s) => s.hands && s.hands.some((h) => h.status === "stood"));
      if (anyLive) {
        while (true) {
          const { total, soft } = bjHandValue(t.dealer);
          if (total > 21 || total > 17 || (total === 17 && (!soft || DEALER_STANDS_SOFT_17))) break;
          t.dealer.push(shoe.draw());
          await tref().set(t);
          await delay(LIVE_BJ_DEAL_CARD_MS);
        }
      }
      const dealerVal = bjHandValue(t.dealer).total;
      const dealerBust = dealerVal > 21;
      for (const seat of t.seats) {
        if (seat.status !== "active") continue;
        for (const hand of seat.hands) {
          if (hand.result === "blackjack" || hand.result === "push" || hand.result === "surrender") { hand.status = "push"; continue; }
          const val = bjHandValue(hand.cards).total;
          let payout = 0;
          if (hand.status === "bust") hand.result = "lose";
          else if (dealerBust || val > dealerVal) { hand.result = "win"; payout = hand.bet * 2; }
          else if (val === dealerVal) { hand.result = "push"; payout = hand.bet; }
          else hand.result = "lose";
          hand.profit = payout - hand.bet;
        }
        const mainResult = seat.hands[0].result;
        for (const bb of seat.behindBets) {
          bb.result = mainResult;
          let bbPayout = 0;
          if (mainResult === "win") bbPayout = bb.amount * 2;
          else if (mainResult === "blackjack") bbPayout = Math.round(bb.amount * 2.5);
          else if (mainResult === "push") bbPayout = bb.amount;
          bb.profit = bbPayout - bb.amount;
        }
      }
      t.phase = "settled";
      await tref().set(t);
      setTimeout(resetForNextRound, 4500);
    }

    // Deal/settlement math above runs on whichever single client's tick()
    // happens to win the race — but Balance is a local, per-client thing
    // (each player can only credit their own balance document), so that
    // one client crediting payouts directly would only ever pay itself.
    // Instead, every connected client runs this on every table update and
    // claims only its own unpaid stake: its own hand(s), its own side
    // bets, its own insurance, and any bets it placed behind other seats.
    // The `paid`/`sideBetsPaid`/`insurancePaid` flags (claimed inside a
    // transaction) make each unit payable exactly once no matter how many
    // clients race to reconcile at the same time.
    let reconcileBusy = false;
    async function reconcileMyPayouts(t) {
      if (reconcileBusy || !t) return;
      const uid = myUid();
      if (!uid) return;
      const sideBetsReady = t.phase !== "betting" && t.phase !== "dealing" && t.phase !== "idle";
      const insuranceReady = t.phase === "settled";
      const looksUnpaid = t.seats.some((seat) => {
        if (seat.uid === uid) {
          if (seat.hands.some((h) => h.result != null && !h.paid)) return true;
          if (sideBetsReady && !seat.sideBetsPaid && (seat.sideBets.perfectPairs > 0 || seat.sideBets.twentyPlusThree > 0)) return true;
          if (insuranceReady && seat.insuranceBet > 0 && !seat.insurancePaid) return true;
        }
        return (seat.behindBets || []).some((bb) => bb.uid === uid && bb.result != null && !bb.paid);
      });
      if (!looksUnpaid) return;

      reconcileBusy = true;
      let totalPayout = 0;
      try {
        await getDb().runTransaction(async (tx) => {
          totalPayout = 0;
          const fresh = (await tx.get(tref())).data();
          const freshSideBetsReady = fresh.phase !== "betting" && fresh.phase !== "dealing" && fresh.phase !== "idle";
          const freshInsuranceReady = fresh.phase === "settled";
          const dealerBJ = freshInsuranceReady && isBlackjack(fresh.dealer);
          for (const seat of fresh.seats) {
            if (seat.uid === uid) {
              for (const h of seat.hands) {
                if (h.result != null && !h.paid) {
                  totalPayout += h.bet + (h.profit || 0);
                  h.paid = true;
                }
              }
              if (freshSideBetsReady && !seat.sideBetsPaid && (seat.sideBets.perfectPairs > 0 || seat.sideBets.twentyPlusThree > 0)) {
                const pp = seat.sideBets.perfectPairs, tw = seat.sideBets.twentyPlusThree;
                if (pp > 0 && seat.sideBetResults.perfectPairs) totalPayout += pp * SIDE_BET_PAYTABLES.perfectPairs[seat.sideBetResults.perfectPairs] + pp;
                if (tw > 0 && seat.sideBetResults.twentyPlusThree) totalPayout += tw * SIDE_BET_PAYTABLES.twentyPlusThree[seat.sideBetResults.twentyPlusThree] + tw;
                seat.sideBetsPaid = true;
              }
              if (freshInsuranceReady && seat.insuranceBet > 0 && !seat.insurancePaid) {
                if (dealerBJ) totalPayout += seat.insuranceBet * 3;
                seat.insurancePaid = true;
              }
            }
            for (const bb of seat.behindBets || []) {
              if (bb.uid === uid && bb.result != null && !bb.paid) {
                totalPayout += bb.amount + (bb.profit || 0);
                bb.paid = true;
              }
            }
          }
          tx.set(tref(), fresh);
        });
        if (totalPayout > 0) await Balance.applyDelta(totalPayout, "live_bj_payout");
      } catch (e) { /* another write raced this one — the next snapshot will retry */ }
      reconcileBusy = false;
    }

    async function resetForNextRound() {
      await getDb().runTransaction(async (tx) => {
        const t = (await tx.get(tref())).data();
        if (t.phase !== "settled") return;
        t.seats = t.seats.map((s) => s.uid ? { ...emptySeat(), uid: s.uid, name: s.name, status: "waiting", joinedAt: s.joinedAt, missedRounds: s.missedRounds || 0 } : s);
        t.dealer = [];
        t.dealerHoleHidden = true;
        const stillOccupied = t.seats.some((s) => s.status !== "empty");
        t.phase = stillOccupied ? "betting" : "idle";
        t.phaseDeadline = stillOccupied ? Date.now() + LIVE_BJ_BETTING_MS : null;
        t.turnSeatIndex = -1;
        t.turnHandIndex = 0;
        tx.set(tref(), t);
      });
    }

    async function sendChat(text) {
      text = (text || "").trim().slice(0, 240);
      if (!text) return;
      await chatRef().add({ uid: myUid(), name: localStorage.getItem(LS_HANDLE) || "Player", text, at: firebase.firestore.FieldValue.serverTimestamp() });
    }

    function ensureLiveStyle() {
      if (document.getElementById("saltys-live-bj-style")) return;
      const s = document.createElement("style");
      s.id = "saltys-live-bj-style";
      s.textContent = `
        #${OVERLAY_ID} .lbj-oval-wrap{ position:relative; }
        #${OVERLAY_ID} .lbj-oval-table{
          position:relative; width:100%; max-width:900px; margin:0 auto; aspect-ratio:16/9;
          background:
            radial-gradient(ellipse at 50% 12%, rgba(255,255,255,.07), rgba(255,255,255,0) 32%),
            radial-gradient(ellipse at 50% 100%, rgba(0,0,0,.35), rgba(0,0,0,0) 55%),
            radial-gradient(ellipse at 50% 15%, var(--felt-line, #1c5c46), var(--felt, #0e3b2c) 72%);
          border-radius:50%/45%; border:10px solid #2a1608;
          outline:2px solid #4a2f14; outline-offset:-6px;
          box-shadow:
            inset 0 0 70px rgba(0,0,0,.55), inset 0 0 0 3px rgba(212,175,55,.12),
            inset 0 0 0 13px rgba(74,47,20,.45), inset 0 0 0 15px rgba(0,0,0,.3),
            0 10px 30px rgba(0,0,0,.35), 0 0 0 4px #1a0f05, 0 0 0 6px #3d2410;
        }
        #${OVERLAY_ID} .lbj-oval-dealer{ position:absolute; top:16%; left:50%; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; gap:4px; z-index:1; }
        #${OVERLAY_ID} .lbj-oval-seats{ position:relative; margin-top:-40px; display:grid; grid-template-columns:repeat(5,1fr); gap:16px; padding:0 14px; }
        #${OVERLAY_ID} .lbj-seat{
          background:linear-gradient(180deg, rgba(28,34,44,.92), rgba(15,18,24,.92));
          border:1px solid var(--border); border-radius:16px; padding:10px;
          box-shadow:0 3px 10px rgba(0,0,0,.3);
          transition:box-shadow .3s, transform .3s, border-color .15s;
        }
        #${OVERLAY_ID} .lbj-seat.drag-over{ border-color:var(--gold); box-shadow:0 0 0 2px rgba(212,175,55,.4); }
        #${OVERLAY_ID} .lbj-seat.turn{ box-shadow:0 0 0 2px #d4af37, 0 0 18px rgba(212,175,55,.5); transform:translateY(-4px); }
        #${OVERLAY_ID} .lbj-seat.win{ box-shadow:0 0 0 2px #2fbf71; }
        #${OVERLAY_ID} .lbj-seat.lose{ opacity:.6; }
        #${OVERLAY_ID} .lbj-behind-row{ display:flex; align-items:center; gap:4px; margin-top:6px; flex-wrap:wrap; }
        #${OVERLAY_ID} .lbj-behind-avatar{ width:20px; height:20px; border-radius:50%; background:#7c3aed; color:#fff; font-size:10px; display:flex; align-items:center; justify-content:center; font-weight:700; border:1px solid #1a1400; }
      `;
      document.head.appendChild(s);
    }

    function cardEl(c, hidden) {
      if (hidden) return `<div class="card back" data-key="hidden"></div>`;
      const isNew = c._key != null && !dealtAnimated.has(c._key);
      if (isNew) dealtAnimated.add(c._key);
      return `<div class="card ${cardColor(c)} ${isNew ? "lbj-card-deal" : ""}" data-key="${c._key ?? ""}"><span>${c.r}</span><span class="br">${SUIT_GLYPH[c.s]}</span></div>`;
    }
    function secondsLeft() {
      if (!tableDoc || !tableDoc.phaseDeadline) return null;
      return Math.max(0, Math.ceil((tableDoc.phaseDeadline - Date.now()) / 1000));
    }
    // renderInner() only runs when Firestore actually pushes a new snapshot,
    // so without this the on-screen "Xs" text just sits frozen between
    // writes instead of counting down. This runs every second regardless,
    // updating only the timer spans' text (by class, renderInner() already
    // tags them "lbj-timer") so it doesn't disturb anything else — an
    // in-progress chat message or bet amount the player is mid-typing.
    function updateTimerDisplay() {
      if (!root || !tableDoc) return;
      const secs = secondsLeft();
      const text = secs !== null ? `${secs}s` : "";
      root.querySelectorAll(".lbj-timer").forEach((el) => { el.textContent = text; });
    }
    function missedWarningBadge(seat) {
      if (!seat.missedRounds) return "";
      const left = LIVE_BJ_KICK_AFTER_MISSES - seat.missedRounds;
      if (left <= 0) return "";
      return `<span class="pill lose" title="Kicked if you miss betting again">No bet: ${left} left</span>`;
    }

    function seatHtml(seat, i) {
      if (seat.status === "empty") {
        return `<div class="lbj-seat center col" data-drop-seat="${i}"><div class="muted">Seat ${i + 1}</div><button class="btn small primary" data-join="${i}">Sit here</button></div>`;
      }
      const mine = seat.uid === myUid();
      const isTurn = tableDoc.turnSeatIndex === i;
      const mainResult = seat.hands[0] && seat.hands[0].result;
      const stateClass = isTurn ? "turn" : mainResult === "win" || mainResult === "blackjack" ? "win" : mainResult === "lose" ? "lose" : "";
      const sideChips = [];
      if (seat.sideBets && seat.sideBets.perfectPairs > 0) {
        const r = seat.sideBetResults && seat.sideBetResults.perfectPairs;
        sideChips.push(`<div class="lbj-sidebet-chip ${r ? "hit" : ""}" title="Perfect Pairs: ${fmt(seat.sideBets.perfectPairs)}${r ? " · " + r : ""}"><span class="lbj-sidebet-label">PP</span><span class="lbj-sidebet-amt">${fmt(seat.sideBets.perfectPairs)}</span></div>`);
      }
      if (seat.sideBets && seat.sideBets.twentyPlusThree > 0) {
        const r = seat.sideBetResults && seat.sideBetResults.twentyPlusThree;
        sideChips.push(`<div class="lbj-sidebet-chip ${r ? "hit" : ""}" title="21+3: ${fmt(seat.sideBets.twentyPlusThree)}${r ? " · " + r : ""}"><span class="lbj-sidebet-label">21+3</span><span class="lbj-sidebet-amt">${fmt(seat.sideBets.twentyPlusThree)}</span></div>`);
      }
      const sideBetHtml = sideChips.length ? `<div class="lbj-sidebet-strip">${sideChips.join("")}</div>` : "";
      const handsHtml = seat.hands.length ? seat.hands.map((hand, hi) => {
        const active = tableDoc.phase === "player-turns" && i === tableDoc.turnSeatIndex && hi === tableDoc.turnHandIndex;
        const v = bjHandValue(hand.cards);
        const label = hand.status === "bust" ? `${v.total} Bust` : hand.cards.length ? `${v.total}${v.soft ? "s" : ""}` : "";
        const resultBadge = hand.result ? `<span class="pill ${hand.profit > 0 ? "win" : hand.profit < 0 ? "lose" : ""}">${hand.result}${hand.profit != null ? " " + (hand.profit >= 0 ? "+" : "") + fmt(hand.profit) : ""}</span>` : "";
        return `<div class="col" style="opacity:${active ? 1 : 0.75}">
          <div class="hand">${hand.cards.map((c) => cardEl(c, false)).join("")}</div>
          <div class="row" style="justify-content:space-between;align-items:center">
            <div class="row" style="align-items:center;gap:8px">${chipStackHtml(hand.bet, { size: 18 })}<span class="muted" style="font-size:11px">${label}</span></div>
            ${resultBadge}
          </div>
        </div>`;
      }).join("") : "";
      const behindTotal = seat.behindBets.reduce((s, b) => s + b.amount, 0);
      const behindHtml = seat.behindBets.length ? `<div class="lbj-behind-row">${seat.behindBets.map((b) => `<div class="lbj-behind-avatar" title="${b.name}: ${fmt(b.amount)}${b.result ? " · " + b.result : ""}">${b.name[0]}</div>`).join("")}<span class="muted" style="font-size:11px">${fmt(behindTotal)} behind</span></div>` : "";
      const canBetBehind = !mine && seat.status !== "empty" && tableDoc.phase === "betting" && !seat.behindBets.some((b) => b.uid === myUid());
      const betTooHigh = (myPendingBet + myPendingPP + myPending213) > Balance.current;
      const dealerShowsAce = tableDoc.dealer && tableDoc.dealer[0] && tableDoc.dealer[0].r === "A";
      const canInsure = mine && dealerShowsAce && tableDoc.phase === "insurance" && (seat.insuranceBet || 0) === 0 && !seat.insuranceDeclined;
      const tier = tierForTable(tableId);
      return `<div class="lbj-seat col ${stateClass}" data-drop-seat="${i}">
        <div class="row" style="justify-content:space-between"><span class="muted">Seat ${i + 1} · ${seat.name || ""}</span>${mine ? '<span class="pill">You</span>' : ""}${missedWarningBadge(seat)}</div>
        ${handsHtml || `<div class="muted center">Waiting to bet</div>`}
        ${sideBetHtml}
        ${behindHtml}
        ${canInsure ? `<div class="row mt8" style="justify-content:center;gap:6px"><span class="muted">Insurance?</span><button class="btn small gold" data-insure="${i}">Insure ${fmt(Math.round((seat.hands[0]?.bet || 0) / 2))}</button><button class="btn small" data-decline-insure="${i}">No</button></div>` : ""}
        ${seat.insuranceBet > 0 ? `<div class="muted center" style="font-size:11px">Insured ${fmt(seat.insuranceBet)}</div>` : ""}
        ${mine && seat.status === "waiting" ? `
          <div class="col mt8">
            <div class="row" style="justify-content:space-between;align-items:center">
              <span class="muted">Main bet</span>
              ${myPendingBet > 0 ? chipStackHtml(myPendingBet, { size: 16 }) : ""}
            </div>
            <div class="muted" style="font-size:11px;margin-bottom:2px">Table limits: ${fmt(tier.minBet)}&ndash;${fmt(tier.maxBet)}</div>
            ${renderBetControls(`lbj-main-${i}`, myPendingBet, false)}
            <div class="lbj-sidebet-row">
              <input type="text" id="lbj-pp-${i}" placeholder="Pairs (e.g. 100k)" value="${myPendingPP ? fmt(myPendingPP) : ""}">
              <input type="text" id="lbj-213-${i}" placeholder="21+3 (e.g. 1m)" value="${myPending213 ? fmt(myPending213) : ""}">
            </div>
            <div class="row">
              <button class="btn small primary" data-bet="${i}" ${betTooHigh || myPendingBet < MIN_BET ? "disabled" : ""} title="${betTooHigh ? "Not enough balance for that bet" : ""}">Bet</button>
              <button class="btn small" data-leave="${i}">Leave</button>
            </div>
          </div>` : ""}
        ${canBetBehind ? `
          <div class="col mt8">
            ${renderBetControls(`lbj-behind-${i}`, myPendingBehind, false)}
            <button class="btn small gold" data-behind="${i}" ${myPendingBehind > Balance.current ? "disabled" : ""} title="${myPendingBehind > Balance.current ? "Not enough balance" : ""}">Bet behind</button>
          </div>` : ""}
      </div>`;
    }

    function renderInner() {
      if (!root || !tableDoc) return;
      ensureLiveStyle();
      ensureBlackjackSharedStyle();
      const dealerHtml = tableDoc.dealer.map((c, i) => cardEl(c, i > 0 && tableDoc.dealerHoleHidden)).join("");
      const seatsHtml = tableDoc.seats.map((s, i) => seatHtml(s, i)).join("");
      const seat = tableDoc.seats[mySeatIndex];
      const hand = seat && seat.hands && seat.hands[tableDoc.turnHandIndex];
      const myTurn = tableDoc.phase === "player-turns" && tableDoc.turnSeatIndex === mySeatIndex;
      const canDouble = myTurn && hand && hand.cards.length === 2 && Balance.current >= hand.bet;
      const canSplit = myTurn && hand && hand.cards.length === 2 && isSplittablePair(hand.cards[0], hand.cards[1]) && seat.hands.length <= LIVE_BJ_MAX_SPLITS;
      const canSurrender = myTurn && hand && hand.cards.length === 2 && !hand.acted && !hand.fromSplit;
      const secs = secondsLeft();
      const timerHtml = secs !== null ? `<span class="lbj-timer">${secs}s</span>` : "";
      let statusLine;
      if (tableDoc.phase === "idle") statusLine = "Table idle — sit down to start a round";
      else if (tableDoc.phase === "betting") statusLine = `Betting closes in ${timerHtml}`;
      else if (tableDoc.phase === "insurance") statusLine = `Dealer shows an Ace — insurance? ${timerHtml}`;
      else if (tableDoc.phase === "player-turns") statusLine = myTurn ? `Your move — ${timerHtml}` : `Waiting on seat ${tableDoc.turnSeatIndex + 1} — ${timerHtml}`;
      else statusLine = tableDoc.phase;

      const controls = myTurn ? `<div class="row center">
        <button class="btn primary" data-act="hit">Hit</button>
        <button class="btn" data-act="stand">Stand</button>
        <button class="btn" ${!canDouble ? "disabled" : ""} data-act="double" title="${!canDouble && hand && Balance.current < hand.bet ? "Not enough balance to double" : ""}">Double</button>
        <button class="btn" ${!canSplit ? "disabled" : ""} data-act="split">Split</button>
        <button class="btn" ${!canSurrender ? "disabled" : ""} data-act="surrender" title="Forfeit the hand, get half your bet back">Surrender</button>
      </div>` : `<div class="center muted">${statusLine}</div>`;

      const chatHtml = chatMessages.map((m) => `<div class="muted"><b>${m.name}</b>: ${m.text}</div>`).join("");

      const tier = tierForTable(tableId);
      root.innerHTML = `
        <div class="row" style="justify-content:space-between;align-items:center">
          <div class="row" style="gap:8px;align-items:center">
            <span class="pill tier-${tier.key}">${tier.label}</span>
            <span class="muted" style="font-size:12px">Limits: ${fmt(tier.minBet)} &ndash; ${fmt(tier.maxBet)}</span>
          </div>
          <div class="row" style="gap:10px;align-items:center">
            <span class="muted">${statusLine}</span>
            <button class="btn small" id="saltys-bj-rules-btn">📖 House Rules</button>
          </div>
        </div>
        <div class="lbj-oval-wrap mt8">
          <div class="lbj-oval-table">
            ${tableBannerHtml()}
            ${shoeDecorHtml()}
            <div class="lbj-oval-dealer">
              <div class="ov-dealer-hand" style="justify-content:center">${dealerHtml}</div>
              <div class="ov-dealer-label">Dealer's Cards</div>
            </div>
            ${tableDoc.phase === "idle" ? '<div class="ov-hint">Click a seat to play that hand</div>' : ""}
          </div>
          <div class="lbj-oval-seats">${seatsHtml}</div>
        </div>
        <div class="mt16">${myTurn ? controls : ""}</div>
        <div class="panel mt16 col" style="max-height:140px;overflow:auto">${chatHtml}</div>
        <div class="row mt8"><input type="text" id="lbj-chat-input" placeholder="Say something…" style="flex:1"><button class="btn small" id="lbj-chat-send">Send</button></div>
      `;

      root.querySelectorAll("[data-join]").forEach((b) => b.addEventListener("click", () => joinSeat(parseInt(b.dataset.join, 10))));
      root.querySelectorAll("[data-leave]").forEach((b) => b.addEventListener("click", leaveSeat));
      root.querySelectorAll("[data-bet]").forEach((b) => b.addEventListener("click", () => placeBet(myPendingBet, myPendingPP, myPending213)));
      root.querySelectorAll("[data-behind]").forEach((b) => b.addEventListener("click", () => betBehind(parseInt(b.dataset.behind, 10), myPendingBehind)));
      root.querySelectorAll("[data-insure]").forEach((b) => b.addEventListener("click", () => takeInsurance(parseInt(b.dataset.insure, 10))));
      root.querySelectorAll("[data-decline-insure]").forEach((b) => b.addEventListener("click", () => declineInsurance(parseInt(b.dataset.declineInsure, 10))));
      wireRulesButton(root);
      if (myTurn) root.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act)));

      tableDoc.seats.forEach((seatX, i) => {
        if (seatX.status === "waiting" && seatX.uid === myUid()) {
          wireBetControls(root, `lbj-main-${i}`, () => myPendingBet, (v) => { myPendingBet = v; renderInner(); });
          const ppInput = root.querySelector(`#lbj-pp-${i}`);
          if (ppInput) ppInput.addEventListener("change", (e) => {
            const parsed = parseAmount(e.target.value);
            myPendingPP = !isNaN(parsed) ? clamp(parsed, 0, MAX_BET) : 0;
            renderInner();
          });
          const t213Input = root.querySelector(`#lbj-213-${i}`);
          if (t213Input) t213Input.addEventListener("change", (e) => {
            const parsed = parseAmount(e.target.value);
            myPending213 = !isNaN(parsed) ? clamp(parsed, 0, MAX_BET) : 0;
            renderInner();
          });
        }
        if (seatX.status !== "empty" && seatX.uid !== myUid()) {
          wireBetControls(root, `lbj-behind-${i}`, () => myPendingBehind, (v) => { myPendingBehind = v; renderInner(); });
        }
      });

      const sendBtn = root.querySelector("#lbj-chat-send");
      const chatInput = root.querySelector("#lbj-chat-input");
      if (sendBtn && chatInput) {
        sendBtn.addEventListener("click", () => { sendChat(chatInput.value); chatInput.value = ""; });
        chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { sendChat(chatInput.value); chatInput.value = ""; } });
      }
    }

    return {
      setTable,
      async mount(el) {
        root = el;
        if (!isFirebaseConfigured()) { root.innerHTML = `<div class="table-surface center muted">Live tables require Firebase to be configured.</div>`; return () => {}; }
        root.innerHTML = `<div class="table-surface center muted">Connecting…</div>`;
        const u = await getAuthReady();
        if (!u || !isFirebaseConfigured()) {
          root.innerHTML = `<div class="table-surface center muted">Couldn't connect to live tables (Firebase auth unavailable). Check the console for details, or play Solo instead.</div>`;
          return () => { root = null; };
        }
        try { await ensureTableDoc(); }
        catch (e) {
          root.innerHTML = `<div class="table-surface center muted">Failed to load table: ${e.message || e}</div>`;
          return () => { root = null; };
        }
        unsubTable = tref().onSnapshot((snap) => {
          tableDoc = snap.data();
          renderInner();
          reconcileMyPayouts(tableDoc).catch(() => {});
        });
        unsubChat = chatRef().orderBy("at", "desc").limit(30).onSnapshot((qs) => { chatMessages = qs.docs.map((d) => d.data()).reverse(); renderInner(); });
        tickTimer = setInterval(() => { tick(); updateTimerDisplay(); }, 1000);
        return () => { if (unsubTable) unsubTable(); if (unsubChat) unsubChat(); if (tickTimer) clearInterval(tickTimer); root = null; };
      },
    };
  })();

  GAME_MODULES.blackjack = BlackjackHub;
})();
