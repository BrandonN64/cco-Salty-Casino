// ==UserScript==
// Salty's Casino — CORE MODULE
// Loaded via @require by the main salty-casino.user.js loader.
// Provides: config constants, Firebase init, Balance manager, shared card/
// deck/hand-eval utilities, chip/bet-control UI helpers, the dark-shell
// style + home-grid shell, the one-time disclaimer, and the games-tab card
// injection. Every other module (blackjack, roulette, baccarat, spanish21,
// poker, casebattle) depends on window.SaltyCore existing before it runs,
// so this file MUST be the first @require in the main script.
//
// Adding a new game: a module just needs to do
//   window.SaltyCore.GAME_MODULES.mygame = { label: "My Game", icon: "🎲", mount(el) {...}, order: 6 };
// and it will automatically appear as a card on the home grid — no edits
// needed here.
//
// Firebase's db/uid/authReady/firebaseConfigured are only known AFTER
// initFirebase()+Balance.init() run (done once, by the loader). Other
// modules must read them via SaltyCore.getDb() / getUid() / getAuthReady()
// / isFirebaseConfigured() — NOT by destructuring them at load time —
// since destructuring would freeze in the pre-init null/false values.
//
// NOTE (CSS): the shared casino-chrome classes below (.chip-stack-*,
// .ov-bet-rail, .ov-bet-spot*, .ov-chip-rail, .ov-banner*, .ov-corner-deco*,
// .ov-mini-card, .ov-discard-tray) used to live inside salty-blackjack.js's
// own style injector. Baccarat and Mines both render markup using those
// exact classnames too, but never defined them themselves — they only
// rendered correctly after visiting Blackjack once, which is what injected
// that style block. They now live here instead, so they're guaranteed
// present regardless of which tab loads first.
//
// NOTE (STATS): Balance.applyDelta() now also maintains a lightweight
// running `stats` aggregate on the same players/{uid} doc, updated in the
// exact same Firestore transaction that already writes the balance and
// the ledger entry — no extra reads, and no changes needed in any game
// file (they all already call applyDelta(delta, reason)). See
// classifyLedgerReason()/computeUpdatedStats() below. This powers the P/L
// tracker on the Account page (salty-account.js). One deliberate honesty
// note: loss settlements never call applyDelta() at all in these games
// (`if (payout > 0) await Balance.applyDelta(...)` skips the call when
// you lose, since there's nothing to credit), so a "biggest single loss"
// stat can't be honestly derived from this data — we track "biggest single
// bet" instead, which IS cleanly derivable.
// ==/UserScript==
(function () {
  "use strict";

  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyA4edJ9nVJAAShxeHaaJL8colvX5-d8UXM",
    authDomain: "cco-salty-casino.firebaseapp.com",
    projectId: "cco-salty-casino",
    storageBucket: "cco-salty-casino.firebasestorage.app",
    messagingSenderId: "259113213721",
    appId: "1:259113213721:web:fad31911a15486e4a32f88",
  };

  const STARTING_BALANCE = 10000;
  const MAX_BET = 1_000_000_000; // 1 billion tokens, per spec
  const MIN_BET = 10;

  const ROULETTE_BETTING_MS = 45_000;
  const ROULETTE_SPIN_MS = 10_000;
  const ROULETTE_PAYOUT_MS = 5_000;
  const ROULETTE_ROUND_MS = ROULETTE_BETTING_MS + ROULETTE_SPIN_MS + ROULETTE_PAYOUT_MS; // 60s
  const ROULETTE_WHEEL = "european"; // single-zero. Set to "american" for double-zero.

  const HASH = "saltys-casino";
  const CARD_ID = "saltys-casino-card";
  const OVERLAY_ID = "saltys-casino-overlay";
  const LAUNCH_ID = "saltys-casino-launch";
  const LS_DISCLAIMER_SEEN = "saltys-casino:disclaimer-seen-v1";
  const LS_HANDLE = "saltys-casino:handle";

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const fmt = (n) =>
    Math.round(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

  // Accepts shorthand amounts like "1.5m" -> 1500000, "1b" -> 1000000000,
  // "100k" -> 100000, plain numbers, and comma-formatted numbers.
  function parseAmount(raw) {
    if (raw == null) return NaN;
    const s = String(raw).trim().toLowerCase().replace(/,/g, "");
    if (s === "") return NaN;
    const mult = { k: 1e3, m: 1e6, b: 1e9 };
    const match = s.match(/^([0-9]*\.?[0-9]+)\s*([kmb])?$/);
    if (!match) return NaN;
    const num = parseFloat(match[1]);
    if (isNaN(num)) return NaN;
    const suffix = match[2];
    return Math.round(suffix ? num * mult[suffix] : num);
  }

  // Scaled to the actual economy (STARTING_BALANCE 10,000, MIN_BET 10,
  // MAX_BET 1,000,000,000) — the low end (10 through 25,000) keeps real
  // chip-color conventions (white, red, blue, green, black, purple, gold);
  // above that, solid colors continue for the mid tiers, and from 25M up
  // every chip switches to a black base with colored stripes instead of a
  // solid color, so the high-roller tier reads as visually distinct at a
  // glance rather than "the same chip but bigger". The 1B chip is black
  // with a teal/gold striped edge and a large "7" centered on its face,
  // matching the casino's own icon (see chipStyle() below for how the
  // denomination badge gets moved out of the way so the "7" stays visible).
  const CHIP_DENOMS = [
    10, 25, 100, 500, 1_000, 5_000, 25_000,
    100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000,
    25_000_000, 100_000_000, 250_000_000, 500_000_000, 1_000_000_000,
  ];
  function chipLabel(v) {
    if (v >= 1_000_000_000) return `${v / 1_000_000_000}B`;
    if (v >= 1_000_000) return `${v / 1_000_000}M`;
    if (v >= 1_000) return `${v / 1_000}K`;
    return `${v}`;
  }
  function chipColor(v) {
    if (v >= 25_000_000) return "#0d0d0d"; // black base — the striped tier, see chipStripeColor()
    if (v >= 10_000_000) return "#6b4423"; // brown
    if (v >= 5_000_000) return "#9aa4b2"; // silver
    if (v >= 2_500_000) return "#1a3a8f"; // navy
    if (v >= 1_000_000) return "#8b1a2b"; // maroon
    if (v >= 500_000) return "#1ca7a0"; // teal
    if (v >= 250_000) return "#e0439e"; // pink
    if (v >= 100_000) return "#e0722f"; // orange
    if (v >= 25_000) return "#d4af37"; // gold
    if (v >= 5_000) return "#7c3aed"; // purple
    if (v >= 1_000) return "#1a1a1a"; // black
    if (v >= 500) return "#2fbf71"; // green
    if (v >= 100) return "#1d6fd6"; // blue
    if (v >= 25) return "#c0392b"; // red
    return "#e8e4d8"; // white/cream
  }
  // The stripe accent for the black-base tier (25M+) — null below that,
  // meaning "use the normal solid-color chip style" in chipStyle().
  function chipStripeColor(v) {
    if (v >= 1_000_000_000) return "#d4af37"; // gold — the 1B chip (paired with teal in chipStyle())
    if (v >= 500_000_000) return "#7c3aed"; // purple
    if (v >= 250_000_000) return "#2fbf71"; // green
    if (v >= 100_000_000) return "#1d6fd6"; // blue
    if (v >= 25_000_000) return "#c0392b"; // red
    return null;
  }
  // Builds an inline style for a realistic casino chip: a solid base color,
  // a dashed edge-spot ring (the little stripes real chips have), and a
  // radial highlight so it looks embossed/glossy instead of a flat circle.
  function chipStyle(v) {
    const c = chipColor(v);
    const stripe = chipStripeColor(v);

    if (v >= 1_000_000_000) {
      const teal = "#14b8a6";
      const gold = "#d4af37";
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>
      <defs>
        <radialGradient id='bg' cx='35%' cy='30%' r='75%'>
          <stop offset='0%' stop-color='#1b2f22'/>
          <stop offset='55%' stop-color='#0c0f0d'/>
          <stop offset='100%' stop-color='#040504'/>
        </radialGradient>
      </defs>
      <circle cx='50' cy='50' r='48' fill='url(#bg)'/>
      <circle cx='50' cy='50' r='47' fill='none' stroke='${teal}' stroke-width='2'/>
      <circle cx='50' cy='50' r='41' fill='none' stroke='${gold}' stroke-width='3.5' stroke-dasharray='7 5'/>
      <text x='50' y='67' font-family='Georgia, Times New Roman, serif' font-weight='700' font-size='56' text-anchor='middle' fill='#08110d' opacity='0.55'>7</text>
      <text x='49' y='65' font-family='Georgia, Times New Roman, serif' font-weight='700' font-size='56' text-anchor='middle' fill='#f4cf65'>7</text>
      <g fill='#e8c76a'>
        <path d='M23,19 l2.1,5.1 l5.1,2.1 l-5.1,2.1 l-2.1,5.1 l-2.1,-5.1 l-5.1,-2.1 l5.1,-2.1 z'/>
        <path d='M79,23 l1.6,4 l4,1.6 l-4,1.6 l-1.6,4 l-1.6,-4 l-4,-1.6 l4,-1.6 z'/>
        <path d='M79,79 l1.6,4 l4,1.6 l-4,1.6 l-1.6,4 l-1.6,-4 l-4,-1.6 l4,-1.6 z'/>
        <path d='M22,80 l1.8,4.4 l4.4,1.8 l-4.4,1.8 l-1.8,4.4 l-1.8,-4.4 l-4.4,-1.8 l4.4,-1.8 z'/>
      </g>
    </svg>`;
      // The .replace(/'/g, "%27") is the actual fix — without it, the raw
      // single quotes surviving encodeURIComponent() break the outer
      // url('...') wrapper the moment the CSS parser hits the SVG's own
      // xmlns='...' attribute.
      const encoded = encodeURIComponent(svg).replace(/'/g, "%27");
      return `
      background: url('data:image/svg+xml,${encoded}') center/100% no-repeat;
      border-color:${gold};
    `;
    }

    if (stripe) {
      return `
      background:
        radial-gradient(circle at 32% 28%, rgba(255,255,255,.35), rgba(255,255,255,0) 42%),
        repeating-conic-gradient(from 0deg, ${stripe} 0deg 14deg, ${c} 14deg 26deg, ${stripe} 26deg 40deg),
        ${c};
      border-color:${stripe};
    `;
    }
    return `
    background:
      radial-gradient(circle at 32% 28%, rgba(255,255,255,.55), rgba(255,255,255,0) 42%),
      repeating-conic-gradient(from 0deg, ${c} 0deg 18deg, #ffffff22 18deg 22deg, ${c} 22deg 40deg),
      ${c};
    border-color:#1a1400;
  `;
  }
  // Renders a bet-amount text input (accepting shorthand) + a row of chip
  // buttons. `idPrefix` namespaces the element ids so multiple instances
  // (solo vs live) don't collide.
  function renderBetControls(idPrefix, currentBet, disabled, opts = {}) {
    const {
      selectedChip = CHIP_DENOMS[0],
      showDouble = true,
      showDecrement = true,
      showBetSpot = true,
      showInput = true,
    } = opts;

    const pileN = currentBet > 0
      ? Math.min(4, Math.max(1, Math.round(Math.log10(Math.max(currentBet, 1)) - 0.5)))
      : 0;

    const pileHtml = Array.from({ length: pileN }, (_, i) => `
    <div class="bet-spot-chip" style="${i > 0 ? "margin-left:-16px;" : ""}${chipStyle(currentBet)}"></div>
  `).join("");

    return `
    <div class="col" style="gap:10px">
      ${showBetSpot || showInput ? `
        <div class="row" style="align-items:center;gap:12px">
          ${showBetSpot ? `
            <div class="bet-spot" id="${idPrefix}-bet-spot" title="Click or drag chips here">
              <div class="bet-spot-ring"></div>
              ${currentBet > 0
                ? `<div class="bet-spot-pile">${pileHtml}</div><span class="bet-spot-amt">${fmt(currentBet)}</span>`
                : `<span class="bet-spot-amt empty">Place<br>Bet</span>`}
            </div>
          ` : ""}

          ${showInput ? `
            <div class="col grow" style="gap:6px">
              <div class="row">
                <input type="text" id="${idPrefix}-bet-text" value="${fmt(currentBet)}"
                   placeholder="e.g. 1.5m, 100k, 1b" ${disabled ? "disabled" : ""} />
                <span class="muted">tokens · max ${fmt(MAX_BET)}</span>
              </div>
            </div>
          ` : ""}
        </div>
      ` : ""}

      <div class="chip-select" id="${idPrefix}-chip-select">
        ${CHIP_DENOMS.map((v) => `
          <div class="chip-btn ${v === selectedChip ? "selected" : ""}"
               data-chip="${v}"
               ${disabled ? "" : 'draggable="true"'}
               style="${chipStyle(v)}">
            <span class="chip-face">${chipLabel(v)}</span>
          </div>
        `).join("")}
      </div>

      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn small gold" id="${idPrefix}-bet-max" ${disabled ? "disabled" : ""}>Max</button>
        <button class="btn small" id="${idPrefix}-bet-clear" ${disabled ? "disabled" : ""}>Clear</button>
        ${showDecrement
        ? `<button class="btn small" id="${idPrefix}-bet-minus" ${disabled ? "disabled" : ""}>− ${chipLabel(selectedChip)}</button>`
        : ""}
        ${showDouble
        ? `<button class="btn small gold" id="${idPrefix}-bet-double" ${disabled ? "disabled" : ""}>2× Selected Bet</button>`
        : ""}
      </div>
    </div>`;
  }

  // Wires up the markup from renderBetControls(). `getBet`/`setBet` should
  // read/write your bet state and `setBet` should trigger a re-render.
  // Chips are both clickable and draggable (HTML5 drag-and-drop) onto the
  // bet-spot — dropping one adds its denomination to the current bet, same
  // as clicking it.
  // Chip trays are rebuilt from scratch (root.innerHTML = ...) on every bet
  // change, which resets a fresh element's scrollLeft to 0 — losing your
  // place in a 19-chip tray every single click. This survives the rebuild
  // by living outside the DOM entirely, keyed per bet-control instance
  // since more than one can be on screen at once (e.g. live mode's main
  // bet and behind-bet panels).
  const chipScrollPositions = {};
  function wireBetControls(root, idPrefix, getBet, setBet, opts = {}) {
    const {
      getSelectedChip = () => CHIP_DENOMS[0],
      setSelectedChip = () => { },
      onClear = null,
      minBet = MIN_BET,
      maxBet = MAX_BET,
      enableBetSpotDrop = true,
    } = opts;

    const input = root.querySelector(`#${idPrefix}-bet-text`);
    if (input) {
      input.addEventListener("change", (e) => {
        const parsed = parseAmount(e.target.value);
        setBet(!isNaN(parsed) ? clamp(parsed, minBet, maxBet) : getBet());
      });
    }

    const betSpot = root.querySelector(`#${idPrefix}-bet-spot`);

    root.querySelectorAll(`#${idPrefix}-chip-select [data-chip]`).forEach((chip) => {
      const chipValue = parseInt(chip.dataset.chip, 10);

      const addChip = () => {
        setSelectedChip(chipValue);
        setBet(clamp(getBet() + chipValue, 0, maxBet));
      };

      chip.addEventListener("click", addChip);

      chip.addEventListener("dragstart", (e) => {
        setSelectedChip(chipValue);
        e.dataTransfer.setData("text/plain", chip.dataset.chip);
        e.dataTransfer.effectAllowed = "copy";

        const ghost = chip.cloneNode(true);
        ghost.style.position = "absolute";
        ghost.style.top = "-1000px";
        ghost.style.left = "-1000px";
        ghost.style.pointerEvents = "none";
        document.body.appendChild(ghost);

        e.dataTransfer.setDragImage(
          ghost,
          ghost.offsetWidth / 2,
          ghost.offsetHeight / 2
        );

        setTimeout(() => ghost.remove(), 0);
        chip.classList.add("dragging");
      });

      chip.addEventListener("dragend", () => {
        chip.classList.remove("dragging");
      });
    });

    if (betSpot && enableBetSpotDrop) {
      betSpot.addEventListener("dragover", (e) => {
        e.preventDefault();
        betSpot.classList.add("drag-over");
      });

      betSpot.addEventListener("dragleave", () => {
        betSpot.classList.remove("drag-over");
      });

      betSpot.addEventListener("drop", (e) => {
        e.preventDefault();
        betSpot.classList.remove("drag-over");

        const amount = parseInt(e.dataTransfer.getData("text/plain"), 10);
        if (!isNaN(amount)) {
          setSelectedChip(amount);
          setBet(clamp(getBet() + amount, 0, maxBet));
        }
      });
    }

    const maxBtn = root.querySelector(`#${idPrefix}-bet-max`);
    if (maxBtn) {
      maxBtn.addEventListener("click", () => {
        setBet(clamp(Math.floor(Balance.current), minBet, maxBet));
      });
    }

    const clearBtn = root.querySelector(`#${idPrefix}-bet-clear`);
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        if (onClear) onClear();
        else setBet(0);
      });
    }

    const minusBtn = root.querySelector(`#${idPrefix}-bet-minus`);
    if (minusBtn) {
      minusBtn.addEventListener("click", () => {
        setBet(Math.max(0, getBet() - getSelectedChip()));
      });
    }

    const doubleBtn = root.querySelector(`#${idPrefix}-bet-double`);
    if (doubleBtn) {
      doubleBtn.addEventListener("click", () => {
        setBet(clamp(getBet() * 2, 0, maxBet));
      });
    }

    const chipSelect = root.querySelector(`#${idPrefix}-chip-select`);
    if (chipSelect) {
      chipSelect.scrollLeft = chipScrollPositions[idPrefix] || 0;

      chipSelect.addEventListener("wheel", (e) => {
        if (chipSelect.scrollWidth <= chipSelect.clientWidth) return;
        e.preventDefault();
        chipSelect.scrollLeft += e.deltaY;
      }, { passive: false });

      chipSelect.addEventListener("scroll", () => {
        chipScrollPositions[idPrefix] = chipSelect.scrollLeft;
      });
    }
  }

  // ---------------------------------------------------------------------
  // 1. CARD / DECK / HAND-EVAL UTILITIES (shared by Blackjack, Baccarat,
  //    Spanish 21, Poker)
  // ---------------------------------------------------------------------
  const SUITS = ["s", "h", "d", "c"];
  const SUIT_GLYPH = { s: "♠", h: "♥", d: "♦", c: "♣" };
  const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

  function freshDeck() {
    const deck = [];
    for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
    return deck;
  }

  // A Spanish deck is a standard 52-card deck with every numerical "10"
  // removed (J/Q/K remain and still count as 10 in hand values) — 48
  // cards per deck instead of 52. Used by Spanish 21.
  function freshSpanishDeck() {
    return freshDeck().filter((c) => c.r !== "10");
  }

  function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  // A reshuffling multi-deck shoe, used by Blackjack and Baccarat. Pass
  // `deckFactory` (defaults to freshDeck) to build a shoe out of a
  // different card set — e.g. freshSpanishDeck for Spanish 21.
  class Shoe {
    constructor(numDecks, penetration = 0.25, deckFactory = freshDeck) {
      this.numDecks = numDecks;
      this.penetration = penetration; // reshuffle when this fraction remains
      this.deckFactory = deckFactory;
      this._refill();
    }
    _refill() {
      let cards = [];
      for (let i = 0; i < this.numDecks; i++) cards = cards.concat(this.deckFactory());
      this.cards = shuffle(cards);
      this.total = this.cards.length;
    }
    draw() {
      if (this.cards.length / this.total <= this.penetration) this._refill();
      return tagCard(this.cards.pop());
    }
  }

  // Stable per-card identity assigned once at draw time, so re-renders can
  // tell already-on-the-table cards apart from freshly dealt ones and skip
  // replaying the deal-in animation on them. Shared across every game
  // module that deals cards.
  let cardSeq = 0;
  function tagCard(card) {
    if (card && card._key == null) card._key = cardSeq++;
    return card;
  }

  function cardLabel(c) {
    return `${c.r}${SUIT_GLYPH[c.s]}`;
  }
  function cardColor(c) {
    return c.s === "h" || c.s === "d" ? "red" : "black";
  }

  // --- Blackjack / Spanish 21 value helpers (shared — both are "ace 11/1,
  //     faces worth 10" hand-value systems; Spanish 21 just uses a deck
  //     with no numerical 10s, which freshSpanishDeck() handles) ---
  function bjCardValue(r) {
    if (r === "A") return 11;
    if (r === "J" || r === "Q" || r === "K") return 10;
    return parseInt(r, 10);
  }
  // Standard casino rule: any two 10-value cards can be split (10/J/Q/K in
  // any combination), not just an identical rank. Aces and everything else
  // still require a matching rank.
  function isSplittablePair(c0, c1) {
    if (c0.r === c1.r) return true;
    const tenRanks = ["10", "J", "Q", "K"];
    return tenRanks.includes(c0.r) && tenRanks.includes(c1.r);
  }
  function bjHandValue(cards) {
    let total = 0, aces = 0;
    for (const c of cards) {
      total += bjCardValue(c.r);
      if (c.r === "A") aces++;
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    const soft = aces > 0 && total <= 21;
    return { total, soft };
  }
  function isBlackjack(cards) {
    return cards.length === 2 && bjHandValue(cards).total === 21;
  }

  // --- Baccarat value helpers ---
  function bacCardValue(r) {
    if (r === "A") return 1;
    if (["10", "J", "Q", "K"].includes(r)) return 0;
    return parseInt(r, 10);
  }
  function bacHandTotal(cards) {
    return cards.reduce((sum, c) => sum + bacCardValue(c.r), 0) % 10;
  }

  // --- 5/7-card poker hand evaluator (used by Poker: Casino Hold'em) ---
  const RANK_ORDER = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14 };
  // HAND_NAMES index = rank tier, higher is better
  const HAND_NAMES = [
    "High Card", "Pair", "Two Pair", "Three of a Kind", "Straight",
    "Flush", "Full House", "Four of a Kind", "Straight Flush", "Royal Flush"
  ];

  function evaluate5(cards) {
    const ranks = cards.map((c) => RANK_ORDER[c.r]).sort((a, b) => b - a);
    const suits = cards.map((c) => c.s);
    const isFlush = suits.every((s) => s === suits[0]);

    const counts = {};
    for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
    const groups = Object.entries(counts)
      .map(([r, n]) => [parseInt(r, 10), n])
      .sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));

    // straight detection (handles wheel A-2-3-4-5)
    const uniq = [...new Set(ranks)];
    let straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      else if (JSON.stringify(uniq) === JSON.stringify([14, 5, 4, 3, 2])) straightHigh = 5; // wheel
    }
    const isStraight = straightHigh > 0;

    const tiebreak = groups.map((g) => g[0]).concat(
      isStraight ? [] : ranks.filter((r) => !groups.some((g) => g[0] === r && g[1] > 1))
    );

    if (isStraight && isFlush) {
      const tier = straightHigh === 14 ? 9 : 8; // royal vs straight flush
      return { tier, tb: [straightHigh] };
    }
    if (groups[0][1] === 4) return { tier: 7, tb: [groups[0][0], groups[1][0]] };
    if (groups[0][1] === 3 && groups[1][1] === 2) return { tier: 6, tb: [groups[0][0], groups[1][0]] };
    if (isFlush) return { tier: 5, tb: ranks };
    if (isStraight) return { tier: 4, tb: [straightHigh] };
    if (groups[0][1] === 3) return { tier: 3, tb: [groups[0][0], ...ranks.filter((r) => r !== groups[0][0]).slice(0, 2)] };
    if (groups[0][1] === 2 && groups[1][1] === 2) {
      const kicker = ranks.find((r) => r !== groups[0][0] && r !== groups[1][0]);
      return { tier: 2, tb: [groups[0][0], groups[1][0], kicker] };
    }
    if (groups[0][1] === 2) return { tier: 1, tb: [groups[0][0], ...ranks.filter((r) => r !== groups[0][0]).slice(0, 3)] };
    return { tier: 0, tb: ranks };
  }

  function combinations(arr, k) {
    const out = [];
    const rec = (start, chosen) => {
      if (chosen.length === k) { out.push(chosen.slice()); return; }
      for (let i = start; i < arr.length; i++) {
        chosen.push(arr[i]);
        rec(i + 1, chosen);
        chosen.pop();
      }
    };
    rec(0, []);
    return out;
  }

  function compareEval(a, b) {
    if (a.tier !== b.tier) return a.tier - b.tier;
    for (let i = 0; i < Math.max(a.tb.length, b.tb.length); i++) {
      const d = (a.tb[i] || 0) - (b.tb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  function bestOf(cards7) {
    const combos = cards7.length <= 5 ? [cards7] : combinations(cards7, 5);
    let best = null;
    for (const c of combos) {
      const ev = evaluate5(c);
      if (!best || compareEval(ev, best) > 0) best = ev;
    }
    return best;
  }

  // ---------------------------------------------------------------------
  // 2. FIREBASE INIT
  // ---------------------------------------------------------------------
  let db = null;
  let authReady = null;
  let uid = null;
  let firebaseConfigured = FIREBASE_CONFIG.apiKey !== "PASTE_YOUR_API_KEY";
  // These four are reassigned during init (db/authReady get set, uid
  // resolves once auth completes, firebaseConfigured can flip to false on
  // failure) — plain destructuring `const { db } = SaltyCore` in another
  // module would freeze it at its initial null/false value, so modules
  // that need the live value call these getters instead, or just read
  // off SaltyCore.db() etc. at the point of use.
  function getDb() { return db; }
  function getAuthReady() { return authReady; }
  function getUid() { return uid; }
  function isFirebaseConfigured() { return firebaseConfigured; }

  function initFirebase() {
    if (!firebaseConfigured) return;
    if (!window.firebase) {
      console.error("[Salty's Casino] Firebase SDK failed to load.");
      firebaseConfigured = false;
      return;
    }
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    authReady = new Promise((resolve) => {
      // If Anonymous auth isn't enabled in the Firebase console (or the
      // sign-in request otherwise never completes), onAuthStateChanged
      // never fires and every `await authReady` call in the app hangs
      // forever -- this is what makes live tables get stuck on
      // "Loading..." permanently. Time out after 8s and fall back to
      // offline/local mode instead of hanging.
      const authTimeout = setTimeout(() => {
        console.error("[Salty's Casino] Firebase auth timed out after 8s — check that Anonymous sign-in is enabled in your Firebase console (Authentication > Sign-in method > Anonymous).");
        firebaseConfigured = false;
        resolve(null);
      }, 8000);
      firebase.auth().onAuthStateChanged((user) => {
        if (user) { clearTimeout(authTimeout); uid = user.uid; resolve(uid); }
      });
      firebase.auth().signInAnonymously().catch((err) => {
        clearTimeout(authTimeout);
        console.error("[Salty's Casino] Anonymous sign-in failed:", err);
        firebaseConfigured = false;
        resolve(null);
      });
    });
  }

  // ---------------------------------------------------------------------
  // 3. BALANCE MANAGER — closed-loop points, stored per-browser-profile
  //    via Firebase Anonymous Auth. Never touches real case-clicker data.
  //
  //    Also maintains a running `stats` aggregate (P/L, biggest win,
  //    biggest bet, per-game breakdown) on the same player doc, updated
  //    atomically alongside every balance change — see the NOTE (STATS)
  //    comment at the top of this file for why, and the honesty note
  //    about "biggest loss" not being derivable from this data.
  // ---------------------------------------------------------------------
  function emptyStats() {
    return {
      totalWagered: 0, totalReturned: 0, netProfit: 0, roundsPlayed: 0,
      biggestWin: null, biggestBet: null, perGame: {},
    };
  }
  // Reasons follow the convention `solo_<game>_<action>` or
  // `live_<game>_<action>` (e.g. "solo_bj_settle_multi", "solo_mines_bet"),
  // or `jackpot_<tier>_<gameId>` for shared progressive jackpot payouts
  // (attributed to the underlying game, not lumped into a generic
  // "jackpot" bucket, since it's really a side-bet win on that table).
  // Anything that doesn't match either shape falls into "other" so a
  // future game with a slightly different naming convention still gets
  // counted somewhere instead of throwing.
  function classifyLedgerReason(reason, delta) {
    const kind = delta < 0 ? "wager" : delta > 0 ? "win" : "other";
    if (!reason) return { game: "other", kind };
    if (reason.startsWith("jackpot_")) {
      const parts = reason.split("_");
      return { game: parts[parts.length - 1] || "other", kind };
    }
    let m = reason.match(/^(?:solo|live)_([a-z0-9]+)_(.+)$/);
    if (!m) m = reason.match(/^([a-z0-9]+)_(.+)$/);
    return { game: m ? m[1] : "other", kind };
  }
  function computeUpdatedStats(prev, delta, reason, atMs) {
    const stats = {
      totalWagered: prev.totalWagered || 0,
      totalReturned: prev.totalReturned || 0,
      netProfit: prev.netProfit || 0,
      roundsPlayed: prev.roundsPlayed || 0,
      biggestWin: prev.biggestWin || null,
      biggestBet: prev.biggestBet || null,
      perGame: { ...(prev.perGame || {}) },
    };
    const { game, kind } = classifyLedgerReason(reason, delta);
    const g = { ...(stats.perGame[game] || { totalWagered: 0, totalReturned: 0, netProfit: 0, roundsPlayed: 0, biggestWin: null, biggestBet: null }) };

    if (kind === "wager") {
      const amt = Math.abs(delta);
      stats.totalWagered += amt;
      stats.roundsPlayed += 1;
      if (!stats.biggestBet || amt > stats.biggestBet.amount) stats.biggestBet = { amount: amt, reason, game, at: atMs };
      g.totalWagered += amt;
      g.roundsPlayed += 1;
      if (!g.biggestBet || amt > g.biggestBet.amount) g.biggestBet = { amount: amt, reason, at: atMs };
    } else if (kind === "win" && delta > 0) {
      stats.totalReturned += delta;
      if (!stats.biggestWin || delta > stats.biggestWin.amount) stats.biggestWin = { amount: delta, reason, game, at: atMs };
      g.totalReturned += delta;
      if (!g.biggestWin || delta > g.biggestWin.amount) g.biggestWin = { amount: delta, reason, at: atMs };
    }
    g.netProfit = g.totalReturned - g.totalWagered;
    stats.perGame[game] = g;
    stats.netProfit = stats.totalReturned - stats.totalWagered;
    return stats;
  }

  const Balance = {
    current: null,
    statsCurrent: null,
    _listeners: new Set(),
    _statsListeners: new Set(),
    _unsub: null,

    async init() {
      if (!firebaseConfigured) {
        // Offline / not-configured fallback so games are still playable
        // locally (balance won't sync or persist across sessions).
        this.current = STARTING_BALANCE;
        this.statsCurrent = emptyStats();
        this._emit();
        this._emitStats();
        return;
      }
      await authReady;
      const ref = db.collection("players").doc(uid);
      const snap = await ref.get();
      if (!snap.exists) {
        await ref.set({
          balance: STARTING_BALANCE,
          handle: localStorage.getItem(LS_HANDLE) || "Player",
          stats: emptyStats(),
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
      this._unsub = ref.onSnapshot((doc) => {
        if (doc.exists) {
          const data = doc.data();
          this.current = data.balance;
          this.statsCurrent = data.stats || emptyStats();
          this._emit();
          this._emitStats();
        }
      });
    },

    subscribe(fn) {
      this._listeners.add(fn);
      if (this.current !== null) fn(this.current);
      return () => this._listeners.delete(fn);
    },
    _emit() {
      for (const fn of this._listeners) fn(this.current);
    },

    // Live updates of the P/L stats aggregate — see NOTE (STATS) above.
    // Fires immediately with the current cached value on subscribe, same
    // pattern as subscribe() for the balance itself.
    subscribeStats(fn) {
      this._statsListeners.add(fn);
      if (this.statsCurrent !== null) fn(this.statsCurrent);
      return () => this._statsListeners.delete(fn);
    },
    _emitStats() {
      for (const fn of this._statsListeners) fn(this.statsCurrent);
    },

    // Atomically apply a delta (positive = credit, negative = debit).
    // Rejects if it would take balance below zero. Returns the new balance.
    // Also updates the `stats` aggregate in the same transaction — see
    // NOTE (STATS) at the top of this file.
    // delta: amount to add (negative for a debit). reason: ledger/stats tag.
    // opts.logLedger (default true): false rolls this delta into
    //   pendingRoundDelta instead of writing a new ledger document — use
    //   this for every mid-round action, then call settleRound() once at
    //   the end to flush it as a single entry.
    // opts.roundState ({gameKey, snapshot}): piggyback a round-persistence
    //   snapshot onto this same document write, at no extra write cost.
    //   snapshot: null clears that game's saved round.
    async applyDelta(delta, reason, opts = {}) {
      const { logLedger = true, roundState = null } = opts;
      const atMs = Date.now();
      if (!firebaseConfigured) {
        this.current = Math.max(0, this.current + delta);
        this.statsCurrent = computeUpdatedStats(this.statsCurrent || emptyStats(), delta, reason, atMs);
        this._emit();
        this._emitStats();
        return this.current;
      }
      await authReady;
      const ref = db.collection("players").doc(uid);
      const newBal = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.data();
        const bal = data.balance;
        const next = bal + delta;
        if (next < 0) throw new Error("insufficient-balance");
        const nextStats = computeUpdatedStats(data.stats || emptyStats(), delta, reason, atMs);

        const payload = { balance: next, stats: nextStats, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
        if (roundState) {
          payload[`activeRounds.${roundState.gameKey}`] =
            roundState.snapshot === null ? firebase.firestore.FieldValue.delete() : roundState.snapshot;
        }

        if (logLedger) {
          tx.update(ref, payload);
          const ledgerRef = ref.collection("ledger").doc();
          tx.set(ledgerRef, {
            delta, reason, balanceAfter: next,
            at: firebase.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          payload.pendingRoundDelta = (data.pendingRoundDelta || 0) + delta;
          tx.update(ref, payload);
        }
        return next;
      });
      return newBal;
    },

    // Call once, right when a round is fully settled. Applies the final
    // delta (pass 0 if the last mid-round action already covered
    // everything), clears the round's persisted state, and flushes every
    // pendingRoundDelta accumulated via applyDelta(..., {logLedger:false})
    // into ONE ledger entry — costs exactly 2 writes total for the whole
    // round, regardless of how many actions happened along the way.
    async settleRound(gameKey, finalDelta, reason) {
      const atMs = Date.now();
      if (!firebaseConfigured) {
        this.current = Math.max(0, this.current + finalDelta);
        this.statsCurrent = computeUpdatedStats(this.statsCurrent || emptyStats(), finalDelta, reason, atMs);
        this._emit();
        this._emitStats();
        return this.current;
      }
      await authReady;
      const ref = db.collection("players").doc(uid);
      const newBal = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.data();
        const bal = data.balance;
        const next = bal + finalDelta;
        if (next < 0) throw new Error("insufficient-balance");
        const nextStats = computeUpdatedStats(data.stats || emptyStats(), finalDelta, reason, atMs);
        const totalForLedger = (data.pendingRoundDelta || 0) + finalDelta;

        tx.update(ref, {
          balance: next,
          stats: nextStats,
          pendingRoundDelta: 0,
          [`activeRounds.${gameKey}`]: firebase.firestore.FieldValue.delete(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        if (totalForLedger !== 0) {
          const ledgerRef = ref.collection("ledger").doc();
          tx.set(ledgerRef, {
            delta: totalForLedger, reason, balanceAfter: next,
            at: firebase.firestore.FieldValue.serverTimestamp(),
          });
        }
        return next;
      });
      return newBal;
    },

    // Persist a mid-round snapshot without changing balance — for actions
    // like a plain hit/stand or a mines tile-reveal with no payout, where
    // there's no other write to piggyback on. Use sparingly (this is a
    // genuinely new write each time); prefer applyDelta's roundState opt
    // wherever an action already changes the balance.
    async saveRoundState(gameKey, snapshot) {
      if (!firebaseConfigured) return;
      await authReady;
      const ref = db.collection("players").doc(uid);
      await ref.set({ [`activeRounds.${gameKey}`]: snapshot }, { merge: true });
    },

    async loadRoundState(gameKey) {
      if (!firebaseConfigured) return null;
      await authReady;
      const ref = db.collection("players").doc(uid);
      const snap = await ref.get();
      const rounds = snap.exists ? snap.data().activeRounds : null;
      return (rounds && rounds[gameKey]) || null;
    },

    async setHandle(name) {
      localStorage.setItem(LS_HANDLE, name);
      if (!firebaseConfigured) return;
      await authReady;
      await db.collection("players").doc(uid).update({ handle: name });
    },
  };

  // ---------------------------------------------------------------------
  // 4. STYLE — dark shell + felt table surface + gold accent + tabular
  //    "split-flap" balance readout as the one signature element.
  // ---------------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById("saltys-casino-style")) return;
    const s = document.createElement("style");
    s.id = "saltys-casino-style";
    s.textContent = `
      #${OVERLAY_ID}, #${OVERLAY_ID} * { box-sizing:border-box; }
      #${OVERLAY_ID}{
        --bg:#0a0c10; --panel:#12161d; --panel-2:#161b22; --border:#232a35;
        --felt:#0e3b2c; --felt-line:#1c5c46;
        --gold:#d4af37; --gold-bright:#f4cf65;
        --purple:#7c3aed; --purple-bright:#9666f7;
        --blue:#2f6fd6;
        --red:#c0392b; --danger:#e5484d; --success:#2fbf71;
        --text:#f4f1ea; --text-dim:#9aa4b2;
        position:fixed; inset:0; z-index:99999; display:none;
        background:var(--bg); color:var(--text); overflow:auto;
        font:15px/1.55 Inter,system-ui,Segoe UI,sans-serif;
      }
      #${OVERLAY_ID} .wrap{ max-width:1360px; margin:0 auto; padding:28px 20px 90px; }
      #${OVERLAY_ID} .head{ display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:18px; flex-wrap:wrap; }
      #${OVERLAY_ID} .title{ font:800 30px/1 "Oswald",Inter,sans-serif; letter-spacing:.5px; }
      #${OVERLAY_ID} .title span{ color:var(--gold-bright); }
      #${OVERLAY_ID} .sub{ color:var(--text-dim); font-size:12.5px; margin-top:4px; }
      #${OVERLAY_ID} .btn{
        background:var(--panel-2); color:var(--text); border:1px solid var(--border);
        border-radius:10px; padding:9px 14px; cursor:pointer; font-size:13px; font-weight:600;
      }
      #${OVERLAY_ID} .btn:hover{ border-color:var(--purple); }
      #${OVERLAY_ID} .btn.primary{ background:var(--purple); border-color:var(--purple); }
      #${OVERLAY_ID} .btn.primary:hover{ background:var(--purple-bright); }
      #${OVERLAY_ID} .btn.gold{ background:var(--gold); border-color:var(--gold); color:#1a1400; font-weight:800; }
      #${OVERLAY_ID} .btn.green{ background:var(--success); border-color:var(--success); color:#06210f; font-weight:800; }
      #${OVERLAY_ID} .btn.green:hover{ filter:brightness(1.1); }
      #${OVERLAY_ID} .btn.red{ background:var(--danger); border-color:var(--danger); color:#2a0505; font-weight:800; }
      #${OVERLAY_ID} .btn.red:hover{ filter:brightness(1.1); }
      #${OVERLAY_ID} .btn.blue{ background:var(--blue); border-color:var(--blue); color:#f4f8ff; font-weight:800; }
      #${OVERLAY_ID} .btn.blue:hover{ filter:brightness(1.15); }
      #${OVERLAY_ID} .btn:disabled{ opacity:.4; cursor:not-allowed; }
      #${OVERLAY_ID} .btn.small{ padding:6px 10px; font-size:12px; border-radius:8px; }

      /* --- balance readout (signature element) --- */
      #${OVERLAY_ID} .balance{
        display:flex; align-items:center; gap:10px; background:var(--panel);
        border:1px solid var(--border); border-radius:12px; padding:8px 14px;
      }
      #${OVERLAY_ID} .balance .chip{
        width:22px; height:22px; border-radius:50%; flex:none;
        background:repeating-conic-gradient(var(--gold) 0 45deg, #7a611b 45deg 90deg);
        border:2px solid #1a1400;
      }
      #${OVERLAY_ID} .balance .amt{
        font:700 19px/1 "JetBrains Mono","IBM Plex Mono",ui-monospace,monospace;
        font-variant-numeric: tabular-nums; letter-spacing:.5px; color:var(--gold-bright);
      }
      #${OVERLAY_ID} .balance .lbl{ font-size:10px; color:var(--text-dim); text-transform:uppercase; letter-spacing:1px; }

      /* --- tab bar --- */
      #${OVERLAY_ID} .tabs{ display:flex; gap:6px; margin-bottom:20px; flex-wrap:wrap; border-bottom:1px solid var(--border); padding-bottom:0; }
      #${OVERLAY_ID} .tab{
        background:transparent; border:none; color:var(--text-dim); font-weight:700;
        font-size:13px; padding:10px 16px; cursor:pointer; border-bottom:2px solid transparent;
        text-transform:uppercase; letter-spacing:.5px;
      }
      #${OVERLAY_ID} .tab:hover{ color:var(--text); }
      #${OVERLAY_ID} .tab.active{ color:var(--gold-bright); border-bottom-color:var(--gold); }

      /* --- generic table/game surface --- */
      #${OVERLAY_ID} .table-surface{
        background:radial-gradient(ellipse at 50% 0%, var(--felt-line), var(--felt) 70%);
        border:10px solid #1a120a; border-radius:22px; padding:28px 20px; min-height:340px;
        box-shadow:inset 0 0 60px rgba(0,0,0,.45);
      }
      #${OVERLAY_ID} .panel{ background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px; }
      #${OVERLAY_ID} .row{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
      #${OVERLAY_ID} .col{ display:flex; flex-direction:column; gap:10px; }
      #${OVERLAY_ID} .grow{ flex:1; }
      #${OVERLAY_ID} .muted{ color:var(--text-dim); }
      #${OVERLAY_ID} .center{ text-align:center; }
      #${OVERLAY_ID} .mt8{ margin-top:8px;} #${OVERLAY_ID} .mt16{ margin-top:16px;} #${OVERLAY_ID} .mt24{ margin-top:24px;}

      #${OVERLAY_ID} input[type=number], #${OVERLAY_ID} input[type=text]{
        background:var(--bg); border:1px solid var(--border); color:var(--text);
        border-radius:8px; padding:8px 10px; font:600 14px/1 "JetBrains Mono",ui-monospace,monospace;
        width:150px;
      }

      /* --- playing cards --- */
      #${OVERLAY_ID} .hand{ display:flex; gap:8px; min-height:92px; align-items:flex-start; }
      #${OVERLAY_ID} .card{
        width:68px; height:96px; border-radius:9px; background:#fdfbf5; color:#111;
        display:flex; flex-direction:column; justify-content:space-between; padding:6px 7px;
        font:800 17px/1 "JetBrains Mono",ui-monospace,monospace; box-shadow:0 3px 8px rgba(0,0,0,.4);
        border:1px solid #0002;
      }
      #${OVERLAY_ID} .card.red{ color:var(--red); }
      #${OVERLAY_ID} .card.back{
        background:repeating-linear-gradient(135deg, var(--purple), var(--purple) 6px, #241a3d 6px, #241a3d 12px);
        border:1px solid #0006;
      }
      #${OVERLAY_ID} .card .br{ align-self:flex-end; transform:rotate(180deg); }

      /* --- chips / bet grid --- */
      #${OVERLAY_ID} .chip-select{
        display:flex; gap:10px; flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden;
        scroll-snap-type:x proximity; padding:4px 2px 10px; scrollbar-width:thin;
      }
      #${OVERLAY_ID} .chip-select::-webkit-scrollbar{ height:6px; }
      #${OVERLAY_ID} .chip-select::-webkit-scrollbar-thumb{ background:var(--border); border-radius:3px; }
      #${OVERLAY_ID} .chip-select .chip-btn{ scroll-snap-align:center; flex-shrink:0; }
      #${OVERLAY_ID} .chip-btn{
        width:54px; height:54px; border-radius:50%; border:3px solid #1a1400; cursor:grab;
        display:flex; align-items:center; justify-content:center; text-align:center;
        box-shadow:0 3px 6px rgba(0,0,0,.5), inset 0 0 0 3px rgba(255,255,255,.12);
        transition:transform .12s ease, box-shadow .12s ease; position:relative;
        -webkit-user-drag:element; user-select:none; -webkit-user-select:none; touch-action:none;
      }
      #${OVERLAY_ID} .chip-btn:hover{ transform:translateY(-3px); box-shadow:0 6px 12px rgba(0,0,0,.55), inset 0 0 0 3px rgba(255,255,255,.18); }
      #${OVERLAY_ID} .chip-btn.selected{
        transform:translateY(-3px);
        border-color:var(--gold-bright);
        box-shadow:
          0 0 0 3px rgba(244,207,101,.48),
          0 0 16px rgba(244,207,101,.42),
          0 6px 12px rgba(0,0,0,.55);
      }
      #${OVERLAY_ID} .chip-btn:active, #${OVERLAY_ID} .chip-btn.dragging{ cursor:grabbing; transform:scale(.94); opacity:.85; }
      #${OVERLAY_ID} .chip-btn .chip-face{
        width:36px; height:36px; border-radius:50%; background:rgba(0,0,0,.28); border:1px dashed rgba(255,255,255,.5);
        display:flex; align-items:center; justify-content:center; pointer-events:none;
        font:800 11px/1 "JetBrains Mono",monospace; color:#fff; text-shadow:0 1px 2px rgba(0,0,0,.6);
      }
      /* The $1B chip's big centered "7" (drawn via chipStyle()'s background
         image) would otherwise be hidden behind the normal opaque
         denomination badge above — shrink that one badge down to a small
         corner marker instead, only for this specific chip, so the "7"
         actually reads as the chip's design. */
      #${OVERLAY_ID} .chip-btn[data-chip="1000000000"] .chip-face{
        position:absolute; bottom:2px; right:2px; width:20px; height:20px;
        font-size:7px; background:rgba(0,0,0,.65); border-color:#d4af37;
      }
      /* --- bet spot: the felt circle chips get dragged onto --- */
      #${OVERLAY_ID} .bet-spot{
        position:relative; width:88px; height:88px; border-radius:50%; flex:none; cursor:default;
        background:radial-gradient(circle at 50% 40%, #10261c, #0b1a13 75%);
        border:2px dashed var(--gold); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
        transition:box-shadow .15s ease, border-color .15s ease;
      }
      #${OVERLAY_ID} .bet-spot.drag-over{ box-shadow:0 0 0 4px rgba(212,175,55,.35); border-color:var(--gold-bright); }
      #${OVERLAY_ID} .bet-spot-ring{ position:absolute; inset:6px; border-radius:50%; border:1px solid rgba(212,175,55,.3); pointer-events:none; }
      #${OVERLAY_ID} .bet-spot-pile{ display:flex; align-items:center; pointer-events:none; }
      #${OVERLAY_ID} .bet-spot-chip{
        width:32px; height:32px; border-radius:50%; border:2px solid #1a1400; flex-shrink:0;
        box-shadow:0 2px 5px rgba(0,0,0,.5), inset 0 0 0 2px rgba(255,255,255,.12);
      }
      #${OVERLAY_ID} .bet-spot-amt{ font:700 11px/1.2 "JetBrains Mono",monospace; color:var(--gold-bright); text-align:center; padding:0 4px; word-break:break-word; pointer-events:none; }
      #${OVERLAY_ID} .bet-spot-amt.empty{ font:600 9.5px/1.3 Inter,sans-serif; color:var(--text-dim); text-transform:uppercase; letter-spacing:.4px; }
      #${OVERLAY_ID} .betgrid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:8px; }
      #${OVERLAY_ID} .betcell{
        background:var(--panel-2); border:1px solid var(--border); border-radius:10px; padding:12px 6px;
        text-align:center; cursor:pointer; font-weight:700; font-size:13px;
      }
      #${OVERLAY_ID} .betcell:hover{ border-color:var(--gold); }
      #${OVERLAY_ID} .betcell.selected{ border-color:var(--gold); box-shadow:0 0 0 1px var(--gold) inset; }
      #${OVERLAY_ID} .betcell .odds{ display:block; color:var(--text-dim); font-size:10.5px; font-weight:500; margin-top:2px; }

      #${OVERLAY_ID} .pill{ display:inline-block; padding:3px 9px; border-radius:999px; background:var(--panel-2); border:1px solid var(--border); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; }
      #${OVERLAY_ID} .pill.win{ color:var(--success); border-color:var(--success); }
      #${OVERLAY_ID} .pill.lose{ color:var(--danger); border-color:var(--danger); }
      #${OVERLAY_ID} .pill.push{ color:var(--text-dim); }

      #${OVERLAY_ID} .toast{
        position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
        background:var(--panel); border:1px solid var(--gold); color:var(--gold-bright);
        padding:10px 18px; border-radius:10px; font-weight:700; z-index:100001;
        box-shadow:0 6px 20px rgba(0,0,0,.5);
      }

      #${OVERLAY_ID} .games-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:16px; }
      @media (max-width:900px){ #${OVERLAY_ID} .games-grid{ grid-template-columns:repeat(2,1fr); } }
      #${OVERLAY_ID} .game-card{
        background:var(--panel-2); border:1px solid var(--border); border-radius:14px; padding:24px 16px;
        display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px;
        min-height:150px; cursor:pointer; transition:border-color .15s ease, transform .15s ease, box-shadow .15s ease;
      }
      #${OVERLAY_ID} .game-card:hover{ border-color:var(--gold); transform:translateY(-2px); box-shadow:0 8px 20px rgba(0,0,0,.35); }
      #${OVERLAY_ID} .game-card-icon{ width:64px; height:64px; display:flex; align-items:center; justify-content:center; font-size:34px; }
      #${OVERLAY_ID} .game-card-icon img, #${OVERLAY_ID} .game-card-icon svg{ width:100%; height:100%; object-fit:contain; }
      #${OVERLAY_ID} .game-card-label{ font-weight:700; font-size:15px; text-align:center; color:var(--text); }

      /* --- disclaimer modal --- */
      #saltys-disclaimer{
        position:fixed; inset:0; z-index:100002; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.75); font:14px/1.6 Inter,system-ui,sans-serif;
      }
      #saltys-disclaimer .box{
        max-width:440px; margin:20px; background:#12161d; border:1px solid #3a2c0f; border-radius:16px;
        padding:26px 24px; color:#f4f1ea;
      }
      #saltys-disclaimer h2{ margin:0 0 10px; font:800 20px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; }
      #saltys-disclaimer p{ margin:0 0 12px; color:#c7cdd6; font-size:13.5px; }
      #saltys-disclaimer .fine{ font-size:11.5px; color:#8a94a3; }

      /* --- oval blackjack table (solo + live) --- */
      #${OVERLAY_ID} .ov-wrap{ position:relative; padding:32px 0 56px; }
      #${OVERLAY_ID} .ov-table{
        position:relative; width:100%; max-width:1260px; margin:0 auto;
        aspect-ratio: 16/9;
        background:
          radial-gradient(ellipse at 50% 12%, rgba(255,255,255,.08), rgba(255,255,255,0) 32%),
          radial-gradient(ellipse at 50% 100%, rgba(0,0,0,.35), rgba(0,0,0,0) 55%),
          radial-gradient(ellipse at 50% 15%, var(--felt-line), var(--felt) 72%);
        border-radius:50%/45%;
        border:16px solid #2a1608;
        outline:3px solid #4a2f14;
        outline-offset:-10px;
        box-shadow:
          inset 0 0 90px rgba(0,0,0,.55), inset 0 0 0 4px rgba(212,175,55,.15),
          inset 0 0 0 18px rgba(74,47,20,.4), inset 0 0 0 20px rgba(0,0,0,.3),
          0 14px 40px rgba(0,0,0,.4), 0 0 0 6px #1a0f05, 0 0 0 9px #3d2410;
      }
      #${OVERLAY_ID} .ov-dealer{
        position:absolute; top:16%; left:50%; transform:translateX(-50%);
        display:flex; flex-direction:column; align-items:center; gap:6px;
      }
      #${OVERLAY_ID} .ov-dealer-hand{ display:flex; gap:6px; }
      #${OVERLAY_ID} .ov-dealer-total{
        width:44px; height:44px; border-radius:50%; border:3px solid var(--gold);
        display:flex; align-items:center; justify-content:center; font-weight:800; font-size:16px;
        position:absolute; left:-58px; top:10px;
      }
      #${OVERLAY_ID} .ov-dealer-label{ font-size:14px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.6px; margin-top:6px; }
      #${OVERLAY_ID} .ov-hint{
        position:absolute; top:36%; left:6%; max-width:220px; font-size:16px; color:var(--text); font-weight:600; line-height:1.35;
      }
      #${OVERLAY_ID} .ov-seat{
        position:absolute; transform:translate(-50%,-50%); display:flex; flex-direction:column;
        align-items:center; gap:6px; cursor:pointer; min-width:84px;
      }
      #${OVERLAY_ID} .ov-seat.active .ov-cardslot,
      #${OVERLAY_ID} .ov-seat.active .ov-hand{ box-shadow:0 0 0 3px var(--gold); border-color: var(--gold); }
      #${OVERLAY_ID} .ov-seat .ov-hand{ display:flex; gap:4px; min-height:68px; }
      #${OVERLAY_ID} .ov-seat .ov-hand .card{ width:50px; height:70px; font-size:14px; padding:4px 6px; }
      #${OVERLAY_ID} .ov-cardslot{
        width:48px; height:66px; border:4px solid #e8d34a; border-radius:6px; background:transparent;
      }
      #${OVERLAY_ID} .ov-cardslot.dealer{ border-color:#111; width:54px; height:76px; }
      #${OVERLAY_ID} .ov-cardslot.empty{ opacity:.35; }
      #${OVERLAY_ID} .ov-chipmark{
        width:14px; height:14px; background:#7a1010; border:2px solid #300; transform:rotate(45deg);
      }
      #${OVERLAY_ID} .ov-chipmark.empty{ opacity:.3; }
      #${OVERLAY_ID} .ov-betlabel{ font-size:13px; color:var(--gold-bright); font-weight:700; }
      #${OVERLAY_ID} .ov-subhand{ display:flex; flex-direction:column; align-items:center; gap:2px; }
      #${OVERLAY_ID} .ov-profit{ font:800 12px/1 "JetBrains Mono",monospace; margin-top:2px; padding:2px 6px; border-radius:6px; background:var(--panel-2); }
      #${OVERLAY_ID} .ov-profit.win{ color:var(--success); }
      #${OVERLAY_ID} .ov-profit.lose{ color:var(--danger); }
      #${OVERLAY_ID} .ov-win-badge{
        font:700 11px/1 "Oswald",sans-serif; text-transform:uppercase; letter-spacing:.5px;
        padding:2px 8px; border-radius:5px; margin-top:2px; background:var(--panel-2);
      }
      #${OVERLAY_ID} .ov-win-badge.win{ color:var(--success); }
      #${OVERLAY_ID} .ov-win-badge.lose{ color:var(--danger); }
      #${OVERLAY_ID} .ov-win-badge.push{ color:var(--text-dim); }

      /* --- round summary: one clear result, centered on the table --- */
      #${OVERLAY_ID} .ov-round-summary{
        position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); z-index:2;
        background:rgba(10,14,10,.88); border:2px solid var(--gold); border-radius:16px;
        padding:16px 28px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,.6); min-width:220px;
      }
      #${OVERLAY_ID} .ov-round-summary-headline{ font:800 26px/1 "Oswald",sans-serif; letter-spacing:1px; margin-bottom:10px; }
      #${OVERLAY_ID} .ov-round-summary.win .ov-round-summary-headline{ color:var(--success); }
      #${OVERLAY_ID} .ov-round-summary.lose .ov-round-summary-headline{ color:var(--danger); }
      #${OVERLAY_ID} .ov-round-summary.push .ov-round-summary-headline{ color:var(--gold-bright); }
      #${OVERLAY_ID} .ov-round-summary-lines{ display:flex; flex-direction:column; gap:4px; min-width:180px; }
      #${OVERLAY_ID} .ov-summary-line{ display:flex; justify-content:space-between; gap:20px; font:600 13px/1.4 Inter,sans-serif; color:var(--text-dim); }
      #${OVERLAY_ID} .ov-summary-line span:last-child{ font-family:"JetBrains Mono",monospace; font-weight:700; color:var(--text); }
      #${OVERLAY_ID} .ov-summary-line span.win{ color:var(--success) !important; }
      #${OVERLAY_ID} .ov-summary-line span.lose{ color:var(--danger) !important; }
      #${OVERLAY_ID} .ov-summary-line.total{
        margin-top:6px; padding-top:8px; border-top:1px solid rgba(244,207,101,.25);
        font:800 15px/1.4 "Oswald",sans-serif; color:var(--gold-bright); text-transform:uppercase; letter-spacing:.5px;
      }
      #${OVERLAY_ID} .ov-summary-line.total span:last-child{ font-family:"JetBrains Mono",monospace; color:inherit; }
      #${OVERLAY_ID} .ov-insurance-prompt{
        text-align:center; margin-top:16px; padding:12px; background:var(--panel); border:1px solid var(--gold);
        border-radius:12px; max-width:320px; margin-left:auto; margin-right:auto;
      }

      /* --- shared casino chrome (moved here from salty-blackjack.js —
         Baccarat and Mines both render markup using these same classes but
         never defined them themselves, so they only worked after visiting
         Blackjack once) --- */
      #${OVERLAY_ID} .chip-stack-wrap{ display:flex; flex-direction:column; align-items:center; gap:4px; }
      #${OVERLAY_ID} .chip-stack-discs{ display:flex; flex-direction:row; align-items:center; }
      #${OVERLAY_ID} .chip-stack-disc{ border-radius:50%; border:2px solid #1a1400; flex-shrink:0; box-shadow:0 2px 4px rgba(0,0,0,.5), inset 0 0 0 2px rgba(255,255,255,.12); }
      #${OVERLAY_ID} .chip-stack-label{ font:700 11px/1 "JetBrains Mono",monospace; color:var(--gold-bright); text-shadow:0 1px 3px rgba(0,0,0,.8); white-space:nowrap; }

      #${OVERLAY_ID} .ov-bet-rail{
        display:flex; justify-content:center; align-items:flex-end; gap:22px; flex-wrap:wrap;
        margin:-22px auto 0; padding:16px 20px 10px; max-width:640px; position:relative; z-index:1;
        background:radial-gradient(ellipse at 50% 0%, rgba(20,60,44,.92), rgba(9,30,22,.88) 75%);
        border:1px solid rgba(212,175,55,.18); border-top:none; border-radius:0 0 32px 32px;
        box-shadow:inset 0 8px 16px -8px rgba(0,0,0,.5);
      }
      #${OVERLAY_ID} .ov-bet-spot{
        position:relative; border-radius:50%; flex:none; cursor:pointer;
        background:radial-gradient(circle at 50% 40%, #10261c, #0b1a13 75%);
        border:2px dashed var(--gold); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
        transition:box-shadow .15s ease, border-color .15s ease, transform .15s ease;
      }
      #${OVERLAY_ID} .ov-bet-spot.active{
        border-style:solid; border-color:var(--gold-bright); transform:translateY(-3px);
        box-shadow:0 0 0 3px rgba(212,175,55,.3), 0 0 18px rgba(212,175,55,.4);
      }
      #${OVERLAY_ID} .ov-bet-spot.drag-over{ box-shadow:0 0 0 4px rgba(212,175,55,.55); }
      #${OVERLAY_ID} .ov-bet-spot-ring{ position:absolute; inset:6px; border-radius:50%; border:1px solid rgba(212,175,55,.25); pointer-events:none; }
      #${OVERLAY_ID} .ov-bet-spot-label{ font:700 9px/1 "Oswald",sans-serif; text-transform:uppercase; letter-spacing:.5px; color:var(--text-dim); pointer-events:none; }
      #${OVERLAY_ID} .ov-bet-spot-amt{ font:700 11px/1.2 "JetBrains Mono",monospace; color:var(--gold-bright); pointer-events:none; }
      #${OVERLAY_ID} .ov-chip-rail{
        margin:10px auto 0; padding:14px 16px; max-width:640px; border-radius:14px;
        background:linear-gradient(180deg, #2a1608, #1a0f05); border:1px solid #4a2f14;
        box-shadow:inset 0 2px 8px rgba(0,0,0,.4), 0 4px 14px rgba(0,0,0,.3);
      }

      #${OVERLAY_ID} .ov-banner{ position:absolute; top:0.5%; left:50%; transform:translateX(-50%); width:46%; max-width:360px; pointer-events:none; z-index:0; }
      #${OVERLAY_ID} .ov-banner-main{ font:800 18px/1 "Oswald",sans-serif; letter-spacing:1.5px; fill:rgba(244,207,101,.5); }
      #${OVERLAY_ID} .ov-banner-sub, #${OVERLAY_ID} .ov-banner-sub2{
        position:absolute; left:50%; transform:translateX(-50%); width:70%; text-align:center;
        font:700 8px/1.3 "Oswald",sans-serif; letter-spacing:.6px; text-transform:uppercase;
        color:rgba(244,207,101,.4); pointer-events:none; z-index:0; white-space:nowrap;
      }
      #${OVERLAY_ID} .ov-banner-sub{ top:8.5%; }
      #${OVERLAY_ID} .ov-banner-sub2{ top:10.8%; }

      #${OVERLAY_ID} .ov-corner-deco{ position:absolute; top:3%; display:flex; align-items:center; z-index:0; opacity:.9; }
      #${OVERLAY_ID} .ov-corner-left{ left:3%; }
      #${OVERLAY_ID} .ov-corner-right{ right:3%; }
      #${OVERLAY_ID} .ov-mini-card{ width:34px; height:48px; border-radius:4px; box-shadow:0 2px 5px rgba(0,0,0,.5); }
      #${OVERLAY_ID} .ov-discard-tray{
        width:52px; height:38px; border-radius:6px; border:2px solid rgba(74,47,20,.9);
        background:linear-gradient(180deg, rgba(0,0,0,.25), rgba(0,0,0,.1));
        box-shadow:inset 0 2px 6px rgba(0,0,0,.5);
      }

      /* --- account page (P/L tracker + Case-Clicker profile) --- */
      #${OVERLAY_ID} .acct-header{ display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
      #${OVERLAY_ID} .acct-avatar{ width:64px; height:64px; border-radius:50%; border:2px solid var(--gold); object-fit:cover; background:var(--panel-2); }
      #${OVERLAY_ID} .acct-stat-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-top:14px; }
      #${OVERLAY_ID} .acct-stat-card{ background:var(--panel-2); border:1px solid var(--border); border-radius:12px; padding:14px 16px; text-align:center; }
      #${OVERLAY_ID} .acct-stat-label{ font-size:10.5px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px; }
      #${OVERLAY_ID} .acct-stat-value{ font:800 20px/1 "JetBrains Mono",monospace; color:var(--text); }
      #${OVERLAY_ID} .acct-stat-value.win{ color:var(--success); }
      #${OVERLAY_ID} .acct-stat-value.lose{ color:var(--danger); }
      #${OVERLAY_ID} .acct-game-table{ width:100%; border-collapse:collapse; margin-top:10px; }
      #${OVERLAY_ID} .acct-game-table th{ text-align:left; font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.4px; padding:6px 10px; border-bottom:1px solid var(--border); }
      #${OVERLAY_ID} .acct-game-table td{ padding:8px 10px; font:600 13px/1.3 "JetBrains Mono",monospace; border-bottom:1px solid var(--border); }
      #${OVERLAY_ID} .acct-game-table td.game-name{ font-family:Inter,sans-serif; font-weight:700; }

      #${LAUNCH_ID} .saltys-icon-btn{
        width:100%; height:100%; border:none; background:transparent; cursor:pointer;
        display:flex; align-items:center; justify-content:center; padding:4px;
      }
      #${LAUNCH_ID} .saltys-icon-btn img{
        width:100%; height:100%; object-fit:cover; border-radius:10px;
        border:2px solid var(--gold, #d4af37); transition:transform .15s ease;
      }
      #${LAUNCH_ID} .saltys-icon-btn:hover img{ transform:scale(1.02); }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------
  // 5. DISCLAIMER — shown once per browser before any game is playable.
  // ---------------------------------------------------------------------
  function showDisclaimer() {
    return new Promise((resolve) => {
      if (localStorage.getItem(LS_DISCLAIMER_SEEN) === "1") return resolve();
      ensureStyle();
      const el = document.createElement("div");
      el.id = "saltys-disclaimer";
      el.innerHTML = `
        <div class="box">
          <h2>Before you play</h2>
          <p><b>Salty's Casino is an unofficial fan mod.</b> It is not part of case-clicker.com, has no connection to your real tokens, money, or items, and cannot move anything from your real account.</p>
          <p>Everything you wager here is a separate, made-up points balance that exists only inside this mod, for fun.</p>
          <p>The house always wins in the long run — that's how every casino game, real or fake, is built. Gambling with real money is not recommended, and if it's ever not fun, stop.</p>
          <div class="row" style="justify-content:flex-end; margin-top:16px;">
            <button class="btn primary" id="saltys-disclaimer-ok">Got it, let's play</button>
          </div>
          <p class="fine mt16">This notice only appears once per browser.</p>
        </div>
      `;
      document.body.appendChild(el);
      el.querySelector("#saltys-disclaimer-ok").addEventListener("click", () => {
        localStorage.setItem(LS_DISCLAIMER_SEEN, "1");
        el.remove();
        resolve();
      });
    });
  }

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ---------------------------------------------------------------------
  // 6. SHELL — tab bar, balance readout, per-game mount points.
  //    (Games/{Blackjack,Roulette,...} objects are defined further below
  //    and register themselves into GAME_MODULES.)
  // ---------------------------------------------------------------------
  // Each entry: { label, icon, mount(el), unmount(), order }. `icon` can be
  // an emoji, a raw <svg>...</svg> string, or an <img src="..."> string —
  // whatever renderHome() gets handed is dropped straight into the card's
  // icon slot as innerHTML. `order` is optional; modules without one are
  // sorted after ordered ones, in registration order, so simply adding a
  // new `GAME_MODULES.foo = {...}` line in a new @require'd file is enough
  // for it to appear on the home grid automatically — nothing else to wire.
  const GAME_MODULES = {};
  const DEFAULT_ICON = `<div style="width:56px;height:56px;border-radius:50%;background:var(--panel-2);display:flex;align-items:center;justify-content:center;font-size:24px;">?</div>`;
  let activeTab = null; // null = home grid
  let activeUnmount = null;

  function registeredGameKeys() {
    return Object.keys(GAME_MODULES).sort((a, b) => {
      const oa = GAME_MODULES[a].order, ob = GAME_MODULES[b].order;
      if (oa != null && ob != null) return oa - ob;
      if (oa != null) return -1;
      if (ob != null) return 1;
      return 0;
    });
  }

  function ensureOverlay() {
    let ov = document.getElementById(OVERLAY_ID);
    if (ov) return ov;

    ensureStyle();
    ov = document.createElement("div");
    ov.id = OVERLAY_ID;
    ov.innerHTML = `
      <div class="wrap">
        <div class="head">
          <div class="row" style="gap:14px;align-items:center">
            <button class="btn" id="saltys-casino-home" title="Back to games" style="display:none">&larr; Games</button>
            <div>
              <div class="title">Salty's <span>Casino</span></div>
              <div class="sub">Unofficial fan mod &middot; play-money only &middot; not affiliated with case-clicker.com</div>
            </div>
          </div>
          <div class="row">
            <div class="balance">
              <div class="chip"></div>
              <div>
                <div class="lbl">Balance</div>
                <div class="amt" id="saltys-balance-amt">&mdash;</div>
              </div>
            </div>
            <button class="btn" id="saltys-casino-close">Close</button>
          </div>
        </div>
        <div id="saltys-tab-panel"></div>
      </div>
    `;
    document.body.appendChild(ov);

    ov.querySelector("#saltys-casino-home").addEventListener("click", goHome);

    ov.querySelector("#saltys-casino-close").addEventListener("click", () => {
      if (location.hash === "#" + HASH) {
        history.replaceState(null, "", location.pathname + location.search);
      }
      updateView();
    });

    Balance.subscribe((bal) => {
      const el = document.getElementById("saltys-balance-amt");
      if (el) el.textContent = fmt(bal);
    });

    return ov;
  }

  // The case-clicker-style games grid: one card per registered module,
  // icon on top, name underneath. Re-rendered fresh every time you land
  // on it, so newly @require'd modules that register themselves after
  // the overlay was first built still show up correctly.
  function renderHome() {
    const panel = document.getElementById("saltys-tab-panel");
    const keys = registeredGameKeys();
    document.getElementById("saltys-casino-home").style.display = "none";
    if (!keys.length) {
      panel.innerHTML = `<div class="table-surface center muted">No games loaded yet.</div>`;
      return;
    }
    panel.innerHTML = `
      <div class="games-grid">
        ${keys.map((key) => `
          <div class="game-card" data-game="${key}">
            <div class="game-card-icon">${GAME_MODULES[key].icon || DEFAULT_ICON}</div>
            <div class="game-card-label">${GAME_MODULES[key].label || key}</div>
          </div>
        `).join("")}
      </div>
    `;
    panel.querySelectorAll(".game-card").forEach((card) => {
      card.addEventListener("click", () => switchTab(card.dataset.game));
    });
  }

  function goHome() {
    activeTab = null;

    if (activeUnmount) {
      try { activeUnmount(); } catch { }
      activeUnmount = null;
    }

    const panel = document.getElementById("saltys-tab-panel");
    if (panel) delete panel.dataset.activeGame;

    renderHome();
  }


  function switchTab(key) {
    if (!GAME_MODULES[key]) return;

    const panel = document.getElementById("saltys-tab-panel");
    if (!panel) return;

    // updateView() can run repeatedly during SPA navigation, DOM changes,
    // or hash checks. If this game is already mounted, don't destroy and
    // recreate it — doing so interrupts active rounds and autoplay.
    if (panel.dataset.activeGame === key) return;

    activeTab = key;

    if (activeUnmount) {
      try { activeUnmount(); } catch { }
      activeUnmount = null;
    }

    document.getElementById("saltys-casino-home").style.display = "inline-block";

    panel.innerHTML = "";
    panel.dataset.activeGame = key;

    const result = GAME_MODULES[key].mount(panel);
    if (typeof result === "function") activeUnmount = result;
  }


  function overlayShouldShow() {
    return location.hash === "#" + HASH && location.pathname === "/games";
  }


  async function updateView() {
    const ov = ensureOverlay();
    const show = overlayShouldShow();

    if (show) {
      await showDisclaimer();
      ov.style.display = "block";

      const panel = document.getElementById("saltys-tab-panel");
      const alreadyMounted = panel && panel.dataset.activeGame === activeTab;

      // Do not re-mount the active game every time updateView() runs.
      // Re-mounting triggers activeUnmount(), which settles/resets active
      // rounds and was sending users back to the Account/home page.
      if (activeTab && GAME_MODULES[activeTab]) {
        if (!alreadyMounted) switchTab(activeTab);
      } else if (!panel || !panel.dataset.activeGame) {
        goHome();
      }
    } else {
      ov.style.display = "none";

      // This is a genuine casino close, so let the active module run its
      // normal cleanup handler once.
      if (activeUnmount) {
        try { activeUnmount(); } catch { }
        activeUnmount = null;
      }

      const panel = document.getElementById("saltys-tab-panel");
      if (panel) delete panel.dataset.activeGame;
    }
  }

  // ---------------------------------------------------------------------
  // 7. Original games-tab card injection (unchanged behavior), now opens
  //    the tabbed shell instead of a static placeholder list.
  // ---------------------------------------------------------------------
  const SLOT_ICON = `<img src="https://raw.githubusercontent.com/BrandonN64/cco-Salty-Casino/39d4354e067ea8d066796a48d2aa582eb1376a86/Salty's%20Casino.png" alt="Salty's Casino">`;

  function ensureIconLauncher() {
    if (window.location.pathname !== "/games") return;
    if (document.getElementById(LAUNCH_ID)) return;
    ensureStyle();

    const known = ["Casebattle", "Coinflip", "Jackpot", "Dice", "Blackjack", "Plinko"];
    let sample = null, grid = null;
    for (const h of document.querySelectorAll(".mantine-Grid-col .mantine-Title-root")) {
      if (known.includes(h.textContent.trim())) {
        sample = h.closest(".mantine-Grid-col");
        grid = sample && sample.closest(".mantine-Grid-inner");
        if (grid) break;
      }
    }
    if (!sample || !grid) return; // grid hasn't rendered yet — the loader's MutationObserver will retry

    // Shallow-clone the outer grid column (correct grid sizing/placement),
    // then shallow-clone the actual Card element inside it too — keeping
    // its own classes means its OWN stylesheet keeps sizing/padding/
    // border/background exactly like every other tile, instead of us
    // having to guess and reimplement those values ourselves.
    const col = sample.cloneNode(false);
    col.id = LAUNCH_ID;

    const sampleCard = sample.querySelector(".mantine-Card-root");
    if (sampleCard) {
      const card = sampleCard.cloneNode(false);
      card.style.cursor = "pointer";
      card.innerHTML = `<button class="saltys-icon-btn" title="Salty's Casino">${SLOT_ICON}</button>`;
      card.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        location.hash = HASH;
      });
      col.appendChild(card);
    } else {
      // Fallback if their card structure ever changes shape — still
      // works, just without inheriting their exact card chrome.
      col.innerHTML = `<button class="saltys-icon-btn" title="Salty's Casino">${SLOT_ICON}</button>`;
      col.querySelector("button").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        location.hash = HASH;
      });
    }

    grid.appendChild(col);
  }

  // ---------------------------------------------------------------------

  window.SaltyCore = {
    STARTING_BALANCE,
    MAX_BET,
    MIN_BET,
    ROULETTE_BETTING_MS,
    ROULETTE_SPIN_MS,
    ROULETTE_PAYOUT_MS,
    ROULETTE_ROUND_MS,
    ROULETTE_WHEEL,
    HASH,
    CARD_ID,
    OVERLAY_ID,
    LAUNCH_ID,
    LS_DISCLAIMER_SEEN,
    LS_HANDLE,
    delay,
    clamp,
    fmt,
    parseAmount,
    CHIP_DENOMS,
    chipLabel,
    chipColor,
    chipStyle,
    renderBetControls,
    wireBetControls,
    SUITS,
    SUIT_GLYPH,
    RANKS,
    freshDeck,
    freshSpanishDeck,
    shuffle,
    Shoe,
    tagCard,
    cardLabel,
    cardColor,
    bjCardValue,
    isSplittablePair,
    bjHandValue,
    isBlackjack,
    bacCardValue,
    bacHandTotal,
    RANK_ORDER,
    HAND_NAMES,
    evaluate5,
    combinations,
    compareEval,
    bestOf,
    initFirebase,
    Balance,
    ensureStyle,
    showDisclaimer,
    toast,
    GAME_MODULES,
    ensureOverlay,
    switchTab,
    overlayShouldShow,
    updateView,
    ensureIconLauncher,
    goHome,
    renderHome,
    registeredGameKeys,
    DEFAULT_ICON,
    getDb,
    getAuthReady,
    getUid,
    isFirebaseConfigured
  };
})();
