// ==UserScript==
// Salty's Casino — MINES MODULE (Solo)
// Loaded via @require, after salty-core.js and salty-jackpot.js, by the
// main salty-casino.user.js loader. Registers itself into
// window.SaltyCore.GAME_MODULES.mines so it shows up automatically on
// the home grid.
//
// Structurally the simplest table here — no cards, no dealer, no deck.
// Pick how many mines (1-24) go on a 5x5 grid of 25 tiles, place a bet,
// then reveal tiles one at a time. Each safe tile bumps your current
// cash-out multiplier up; hit a mine and the round ends with the whole
// bet lost. You can cash out after any safe reveal to lock in whatever
// multiplier you're currently sitting at, or keep pushing your luck.
//
// The multiplier curve is FAIR-ODDS-BASED, not eyeballed: at every step,
// the payout for surviving is exactly what a 0% house edge would pay
// (1 / probability of having survived this many picks), scaled down by
// a small fixed house edge. This is the same math real Mines-style
// games use, and it's what keeps the risk/reward honest regardless of
// how many mines you choose — more mines means a much steeper
// multiplier curve because surviving each pick is rarer, not because
// the house is taking a bigger cut on hard settings.
//
// AUTOPLAY: during betting, toggle "Autoplay" to stage tiles instead of
// starting a round immediately — the staged tiles are then auto-revealed
// every round, back to back, until a mine is hit (round lost, same as
// manual play), all staged tiles clear safely (auto-cashes out at that
// multiplier), a round-count limit is reached, or a stop-on-profit/
// stop-on-loss threshold is crossed — whichever comes first.
// ==/UserScript==
(function () {
  "use strict";

  const {
    MIN_BET, MAX_BET, GAME_MODULES, OVERLAY_ID,
    Balance, clamp, delay, fmt, chipColor, renderBetControls, wireBetControls, toast,
  } = window.SaltyCore;

  const GRID_SIZE = 25; // 5x5
  const GRID_COLS = 5;
  const MIN_MINES = 1;
  const MAX_MINES = 24;
  const DEFAULT_MINES = 5;
  const HOUSE_EDGE = 0.02; // 2% — same house-edge convention as a real Mines game

  const JACKPOT_SIDE_BET = 250_000; // same flat stake as every other table's qualifying bet
  const JACKPOT_TIER = "major"; // clearing every safe tile on a 24-mine board is astronomically rare

  const AUTO_REVEAL_DELAY_MS = 380; // pace between each staged tile auto-revealing
  const AUTO_ROUND_GAP_MS = 550; // pause between autoplay rounds so results are readable
  const AUTO_DEFAULT_ROUNDS = 10;

  function fmtJackpot(n) {
    return (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // The multiplier for having safely revealed `picks` tiles out of
  // `safeTiles` total safe tiles (GRID_SIZE - mines), on a board with
  // `mines` mines. This is the exact inverse of the hypergeometric
  // probability of surviving that many picks in a row, scaled by
  // (1 - HOUSE_EDGE) — i.e. the fair payout for that risk, minus the
  // house's cut. Grows faster with more mines because each safe tile is
  // rarer to hit, not because the edge itself changes.
  function multiplierFor(mines, picks) {
    let fairMultiplier = 1;
    for (let i = 0; i < picks; i++) {
      fairMultiplier *= (GRID_SIZE - i) / (GRID_SIZE - mines - i);
    }
    return fairMultiplier * (1 - HOUSE_EDGE);
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
    return `<div class="mines-jackpot-spot ${active ? "active" : ""}" id="mines-jackpot-toggle" title="Flat ${fmt(JACKPOT_SIDE_BET)} bet — required to collect the progressive jackpot, and only pays out on a full clear (every safe tile revealed)">
      <div class="ov-bet-spot-label">💰 Jackpot</div>
      <div class="mines-jackpot-sub">${fmt(JACKPOT_SIDE_BET)} flat</div>
      ${active ? `<div class="ov-bet-spot-amt">ON</div>` : `<div class="ov-bet-spot-amt" style="color:var(--text-dim)">OFF</div>`}
    </div>`;
  }

  function rulesButtonRowHtml() {
    return `<div class="row" style="justify-content:flex-end;gap:6px;margin-bottom:6px"><button class="btn small" id="saltys-mines-rules-btn">📖 House Rules</button></div>`;
  }
  function wireRulesButton(root) {
    const btn = root && root.querySelector("#saltys-mines-rules-btn");
    if (btn) btn.addEventListener("click", showRulesModal);
  }

  function showRulesModal() {
    if (document.getElementById("saltys-mines-rules")) return;
    const el = document.createElement("div");
    el.id = "saltys-mines-rules";
    const sampleRows = [1, 3, 5, 10, 15, 20].filter((m) => m <= MAX_MINES).map((m) => {
      const safe = GRID_SIZE - m;
      const steps = [1, 3, 5].filter((k) => k <= safe);
      const cells = steps.map((k) => `<span>${k} pick${k > 1 ? "s" : ""}: <b>${multiplierFor(m, k).toFixed(2)}x</b></span>`).join(" &middot; ");
      return `<div class="mines-rules-row"><span class="mines-rules-mines">${m} mine${m > 1 ? "s" : ""}</span><span class="mines-rules-mults">${cells}</span></div>`;
    }).join("");
    el.innerHTML = `
      <div class="box">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2>House Rules</h2>
          <button class="btn small" id="saltys-mines-rules-close-x">✕</button>
        </div>
        <div class="rules-body">
          <h3>How a round works</h3>
          <p>Choose how many mines (${MIN_MINES}&ndash;${MAX_MINES}) are hidden somewhere on the ${GRID_COLS}&times;${GRID_COLS} grid, then place your bet. Reveal tiles one at a time — every safe tile you find raises your current cash-out multiplier. Hit a mine and the round ends immediately with your entire bet lost. You can <b>Cash Out</b> after any safe reveal to lock in whatever multiplier you're currently at, or keep going for a bigger one.</p>

          <h3>How the multiplier is calculated</h3>
          <p>The payout for surviving each pick is the mathematically fair value for that exact risk — the inverse of the real probability of having safely revealed that many tiles in a row on your chosen mine count — minus a small fixed ${(HOUSE_EDGE * 100).toFixed(0)}% house edge. More mines means a much steeper multiplier curve, because each safe tile becomes genuinely rarer to hit, not because the house is taking a bigger cut on harder settings. The edge stays the same ${(HOUSE_EDGE * 100).toFixed(0)}% no matter how many mines you pick.</p>

          <h3>Sample multipliers</h3>
          <div class="mines-rules-table">${sampleRows}</div>

          <h3>Full clear</h3>
          <p>If you reveal every single safe tile without hitting a mine, the round ends automatically as a full clear at the maximum multiplier for your chosen mine count — there's nothing left to reveal, so there's nothing left to risk.</p>

          <p>Toggle <b>Autoplay</b> during betting to stage tiles instead of playing manually — click the tiles you want auto-revealed each round. Autoplay then repeats: bet, reveal your staged tiles in order, cash out automatically if they all clear safely, and start the next round. It continues after wins and losses until your round limit is reached, you press <b>Stop Autoplay</b>, a stop-on-profit/stop-on-loss threshold is crossed, or there is not enough balance for the next wager.</p>

          <h3>Progressive jackpot</h3>
          <p>0.05% of every wager placed at any table feeds one shared jackpot pool, whether or not you bet on it. <b>Collecting it is separate</b> — place the flat <b>Jackpot</b> bet (${fmt(JACKPOT_SIDE_BET)}) to be eligible that round. With it down, a <b>full clear</b> (every safe tile revealed, on any mine count) pays out a share of the shared pool, on top of your normal full-clear multiplier payout. Without the Jackpot bet, a full clear still pays its normal amount — you just don't collect the extra. Like any other side bet, the Jackpot bet is lost if you don't full-clear the board that round.</p>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:16px">
          <button class="btn primary" id="saltys-mines-rules-close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.querySelector("#saltys-mines-rules-close").addEventListener("click", close);
    el.querySelector("#saltys-mines-rules-close-x").addEventListener("click", close);
    el.addEventListener("click", (e) => { if (e.target === el) close(); });
  }

  function ensureMinesSharedStyle() {
    if (document.getElementById("saltys-mines-shared-style")) return;
    const s = document.createElement("style");
    s.id = "saltys-mines-shared-style";
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700;800&family=JetBrains+Mono:wght@600;700;800&display=swap');

      #${OVERLAY_ID} .mines-board{
        display:grid; grid-template-columns:repeat(${GRID_COLS}, 1fr); gap:10px;
        max-width:420px; margin:0 auto; padding:18px;
        background:radial-gradient(ellipse at 50% 0%, var(--felt-line), var(--felt) 75%);
        border:8px solid #1a120a; border-radius:18px; box-shadow:inset 0 0 50px rgba(0,0,0,.4);
      }
      #${OVERLAY_ID} .mines-tile{
        aspect-ratio:1; border-radius:10px; border:2px solid rgba(212,175,55,.35);
        background:linear-gradient(145deg, #1e2530, #12161d);
        display:flex; align-items:center; justify-content:center;
        font:800 20px/1 "JetBrains Mono",monospace; cursor:pointer;
        transition:transform .1s ease, box-shadow .1s ease, border-color .1s ease;
        user-select:none;
      }
      #${OVERLAY_ID} .mines-tile:hover:not(.revealed):not(.disabled){ border-color:var(--gold); transform:translateY(-2px); box-shadow:0 4px 10px rgba(0,0,0,.4); }
      #${OVERLAY_ID} .mines-tile.disabled{ cursor:default; }
      #${OVERLAY_ID} .mines-tile.revealed.safe{ background:linear-gradient(145deg, #1f4a34, #0e3b2c); border-color:var(--success); color:var(--success); animation:minesTileIn .25s ease-out; }
      #${OVERLAY_ID} .mines-tile.revealed.mine{ background:linear-gradient(145deg, #4a1414, #2b0808); border-color:var(--danger); color:var(--danger); animation:minesTileIn .25s ease-out; }
      #${OVERLAY_ID} .mines-tile.ghost-mine{ background:linear-gradient(145deg, #3a1414, #200808); border-color:rgba(229,72,77,.4); color:rgba(229,72,77,.6); opacity:.6; }
      #${OVERLAY_ID} .mines-tile.staged{ border-color:var(--purple-bright); box-shadow:0 0 0 2px rgba(124,58,237,.5); background:linear-gradient(145deg, #241a3d, #1a1230); }
      @keyframes minesTileIn{ from { transform:scale(.7) rotate(-8deg); opacity:0; } to { transform:none; opacity:1; } }

      #${OVERLAY_ID} .mines-panel{
        max-width:420px; margin:14px auto 0; display:flex; flex-direction:column; gap:10px;
        padding:14px 16px; background:var(--panel); border:1px solid var(--border); border-radius:12px;
      }
      #${OVERLAY_ID} .mines-mine-picker{ display:flex; align-items:center; gap:10px; }
      #${OVERLAY_ID} .mines-mine-picker input[type=range]{ flex:1; accent-color:var(--gold); }
      #${OVERLAY_ID} .mines-mine-count{ font:800 16px/1 "JetBrains Mono",monospace; color:var(--gold-bright); min-width:32px; text-align:center; }
      #${OVERLAY_ID} .mines-live-mult{
        text-align:center; font:800 26px/1 "Oswald",sans-serif; color:var(--gold-bright);
        text-shadow:0 0 12px rgba(244,207,101,.4); padding:8px 0;
      }
      #${OVERLAY_ID} .mines-live-mult .muted{ font:600 11px/1.4 Inter,sans-serif; display:block; margin-top:4px; text-transform:uppercase; letter-spacing:.5px; }

      #${OVERLAY_ID} .mines-jackpot-spot{
        position:relative; width:78px; height:78px; border-radius:50%; cursor:pointer;
        background:radial-gradient(circle at 50% 35%, rgba(124,58,237,.3), #10261c 75%);
        border:2px dashed var(--purple); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
        transition:box-shadow .15s ease, border-color .15s ease, transform .15s ease;
      }
      #${OVERLAY_ID} .mines-jackpot-spot.active{ border-style:solid; border-color:var(--purple-bright); transform:translateY(-3px); box-shadow:0 0 0 3px rgba(124,58,237,.4); }
      #${OVERLAY_ID} .mines-jackpot-spot .ov-bet-spot-label{ color:var(--purple-bright); }
      #${OVERLAY_ID} .mines-jackpot-sub{ font:600 8px/1.2 "JetBrains Mono",monospace; color:var(--text-dim); text-align:center; padding:0 4px; }

      #${OVERLAY_ID} .mines-jackpot-banner{
        text-align:center; font:800 20px/1 "Oswald",sans-serif; letter-spacing:1px; color:var(--gold-bright);
        text-shadow:0 0 14px rgba(244,207,101,.5); margin-bottom:8px; transition:transform .15s ease;
      }
      #${OVERLAY_ID} .mines-jackpot-banner.pulse{ transform:scale(1.06); }

      #${OVERLAY_ID} .mines-round-summary{
        max-width:420px; margin:14px auto 0; background:rgba(10,14,10,.88); border:2px solid var(--gold);
        border-radius:16px; padding:14px 24px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,.6);
      }
      #${OVERLAY_ID} .mines-round-summary-headline{ font:800 24px/1 "Oswald",sans-serif; letter-spacing:1px; margin-bottom:8px; }
      #${OVERLAY_ID} .mines-round-summary.win .mines-round-summary-headline{ color:var(--success); }
      #${OVERLAY_ID} .mines-round-summary.lose .mines-round-summary-headline{ color:var(--danger); }

      /* --- autoplay --- */
      #${OVERLAY_ID} .mines-auto-toggle-row{ display:flex; align-items:center; justify-content:space-between; gap:10px; }
      #${OVERLAY_ID} .mines-auto-panel{
        display:flex; flex-direction:column; gap:8px; padding:10px 12px; margin-top:6px;
        background:rgba(124,58,237,.08); border:1px solid rgba(124,58,237,.35); border-radius:10px;
      }
      #${OVERLAY_ID} .mines-auto-row{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      #${OVERLAY_ID} .mines-auto-row label{ font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.4px; min-width:110px; }
      #${OVERLAY_ID} .mines-auto-row input[type=number]{ width:100px; }
      #${OVERLAY_ID} .mines-auto-status{
        text-align:center; font:700 13px/1.4 "JetBrains Mono",monospace; color:var(--purple-bright);
        padding:8px; background:rgba(124,58,237,.12); border-radius:8px; margin-top:6px;
      }
      #${OVERLAY_ID} .mines-auto-status .muted{ color:var(--text-dim); font-family:Inter,sans-serif; font-weight:600; font-size:11px; display:block; margin-top:2px; }

      #saltys-mines-rules{
        position:fixed; inset:0; z-index:100002; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,.75); font:14px/1.6 Inter,system-ui,sans-serif;
      }
      #saltys-mines-rules .box{
        max-width:560px; max-height:82vh; overflow-y:auto; margin:20px; background:#12161d;
        border:1px solid #3a2c0f; border-radius:16px; padding:26px 24px; color:#f4f1ea;
      }
      #saltys-mines-rules h2{ margin:0; font:800 20px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; }
      #saltys-mines-rules h3{ margin:18px 0 6px; font:700 13px/1.2 Oswald,Inter,sans-serif; color:#f4cf65; text-transform:uppercase; letter-spacing:.5px; }
      #saltys-mines-rules h3:first-of-type{ margin-top:6px; }
      #saltys-mines-rules p{ margin:0 0 8px; color:#c7cdd6; font-size:13px; }
      #saltys-mines-rules b{ color:#f4f1ea; }
      #saltys-mines-rules .mines-rules-table{ display:flex; flex-direction:column; gap:6px; }
      #saltys-mines-rules .mines-rules-row{ display:flex; justify-content:space-between; gap:12px; background:#161b22; border:1px solid #232a35; border-radius:8px; padding:6px 10px; font-size:12px; }
      #saltys-mines-rules .mines-rules-mines{ font-weight:700; color:#f4cf65; white-space:nowrap; }
      #saltys-mines-rules .mines-rules-mults{ color:#c7cdd6; text-align:right; }
      #saltys-mines-rules .mines-rules-mults b{ color:#f4cf65; }
    `;
    document.head.appendChild(s);
  }

  // =====================================================================
  // SOLO — one board per round.
  // =====================================================================
  const SoloMines = (function () {
    let root = null, state = null, busy = false, chipScrollPos = 0;
    let jackpotUnsub = null, jackpotAmount = 0;

    function freshState() {
      return {
        phase: "betting", mines: DEFAULT_MINES, bet: Math.min(100, MAX_BET), selectedChip: 100, jackpotOn: false,
        minePositions: null, revealed: [], picks: 0, lastResult: null,
        // Autoplay
        autoMode: false, autoStagedTiles: [], autoRunning: false,
        autoRoundsTotal: AUTO_DEFAULT_ROUNDS, autoRoundsPlayed: 0,
        autoStopOnProfit: 0, autoStopOnLoss: 0, autoCumulativeProfit: 0,
      };
    }

    function layMines(count) {
      const positions = new Set();
      while (positions.size < count) {
        positions.add((Math.random() * GRID_SIZE) | 0);
      }
      return positions;
    }

    async function startRound() {
      if (busy) return;
      if (!state.bet) { toast("Place a bet to play."); return; }
      const bet = clamp(Math.round(state.bet), MIN_BET, MAX_BET);
      const jp = state.jackpotOn ? JACKPOT_SIDE_BET : 0;
      const total = bet + jp;
      if (total > Balance.current) { toast("Not enough balance for that bet."); return; }
      busy = true; render();
      try {
        await Balance.applyDelta(-total, "solo_mines_bet");
        if (window.SaltyJackpot) window.SaltyJackpot.contribute(total, "mines");
      }
      catch (e) { toast("Bet failed."); busy = false; render(); return; }

      state.minePositions = layMines(state.mines);
      state.revealed = [];
      state.picks = 0;
      state.phase = "playing";
      state.currentBet = bet;
      state.currentJackpotStake = jp;
      busy = false;
      render();
    }

    async function revealTile(idx) {
      if (busy || state.phase !== "playing") return;
      if (state.revealed.includes(idx)) return;
      busy = true;
      state.revealed.push(idx);
      if (state.minePositions.has(idx)) {
        await settle("mine", 0);
      } else {
        state.picks++;
        const safeTiles = GRID_SIZE - state.mines;
        if (state.picks >= safeTiles) {
          // Full clear — nothing left to reveal, round ends automatically.
          await settle("clear", multiplierFor(state.mines, state.picks));
        } else {
          render();
        }
      }
      busy = false;
      render();
    }

    async function cashOut() {
      if (busy || state.phase !== "playing" || state.picks === 0) return;
      busy = true;
      await settle("cashout", multiplierFor(state.mines, state.picks));
      busy = false;
      render();
    }

    async function settle(outcome, mult) {
      state.phase = "settled";
      const bet = state.currentBet;
      const jackpotStake = state.currentJackpotStake;
      const mainWin = outcome === "mine" ? 0 : Math.round(bet * mult);

      let jackpotProfit = 0;
      let jackpotPayout = 0;
      if (jackpotStake > 0) {
        if (outcome === "clear" && window.SaltyJackpot) {
          const jpPayout = await window.SaltyJackpot.award(JACKPOT_TIER, "mines", `Full clear: ${state.picks} of ${state.picks} safe tiles (${state.mines} mines)`, true);
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
      if (roundPayout > 0) await Balance.applyDelta(roundPayout, "solo_mines_settle");

      const mainProfit = mainWin - bet;
      state.lastResult = {
        outcome, mult, picks: state.picks, mines: state.mines,
        mainProfit, jackpotProfit, totalProfit: mainProfit + jackpotProfit,
      };
      render();
    }

    // ---------------------------------------------------------------------
    // AUTOPLAY — repeats full rounds using the staged tile pattern, back
    // to back, until a stop condition hits. Reuses startRound()/
    // revealTile()/cashOut() exactly as manual play does, so settlement,
    // jackpot contribution, and Balance transactions all go through the
    // same paths — autoplay is just a scripted sequence of the same
    // actions a player would click manually.
    // ---------------------------------------------------------------------
    function toggleAutoTile(idx) {
      if (state.phase !== "betting") return;
      const i = state.autoStagedTiles.indexOf(idx);
      if (i >= 0) state.autoStagedTiles.splice(i, 1);
      else state.autoStagedTiles.push(idx);
      render();
    }

    async function runAutoplay() {
      if (state.autoRunning) return;

      if (!state.autoStagedTiles.length) {
        toast("Select at least one tile to auto-reveal each round.");
        return;
      }

      state.autoRunning = true;
      state.autoRoundsPlayed = 0;
      state.autoCumulativeProfit = 0;
      render();

      while (
        state.autoRunning &&
        state.autoRoundsPlayed < state.autoRoundsTotal
      ) {
        await startRound();

        // Bet failure, such as insufficient balance.
        if (state.phase !== "playing") {
          state.autoRunning = false;
          break;
        }

        for (const idx of state.autoStagedTiles) {
          if (!state.autoRunning || state.phase !== "playing") break;

          await revealTile(idx);

          if (state.phase === "playing") {
            await delay(AUTO_REVEAL_DELAY_MS);
          }
        }

        // A successful staged sequence automatically locks in its result.
        if (state.phase === "playing" && state.picks > 0) {
          await cashOut();
        }

        state.autoRoundsPlayed++;
        state.autoCumulativeProfit += state.lastResult
          ? state.lastResult.totalProfit
          : 0;

        render();

        // Only configured profit/loss limits, manual stop, max rounds,
        // or an inability to start the next wager stop autoplay.
        if (
          state.autoStopOnProfit > 0 &&
          state.autoCumulativeProfit >= state.autoStopOnProfit
        ) {
          state.autoRunning = false;
          break;
        }

        if (
          state.autoStopOnLoss > 0 &&
          state.autoCumulativeProfit <= -state.autoStopOnLoss
        ) {
          state.autoRunning = false;
          break;
        }

        if (!state.autoRunning) break;

        // Preserve the bet, mine count, jackpot choice, and staged tiles.
        // Only reset the board-specific state for the next round.
        state.phase = "betting";
        state.minePositions = null;
        state.revealed = [];
        state.picks = 0;
        state.lastResult = null;

        render();
        await delay(AUTO_ROUND_GAP_MS);
      }

      state.autoRunning = false;
      render();
    }


    function stopAutoplay() {
      state.autoRunning = false;
      render();
    }

    function render() {
      if (!root) return;
      ensureMinesSharedStyle();
      const jackpotBanner = `<div class="mines-jackpot-banner" id="mines-jackpot-banner">PROGRESSIVE JACKPOT: ${fmtJackpot(jackpotAmount)}</div>`;
      const inRound = state.phase === "playing" || state.phase === "settled";
      const showMines = state.phase === "settled" && state.lastResult && state.lastResult.outcome === "mine";
      const staging = state.phase === "betting" && state.autoMode;

      const boardHtml = `<div class="mines-board">
        ${Array.from({ length: GRID_SIZE }, (_, i) => i).map((i) => {
        const isRevealed = state.revealed.includes(i);
        const isMine = inRound && state.minePositions && state.minePositions.has(i);
        const isStaged = staging && state.autoStagedTiles.includes(i);
        const cls = ["mines-tile"];
        let content = "";
        if (isRevealed && isMine) { cls.push("revealed", "mine"); content = "💥"; }
        else if (isRevealed) { cls.push("revealed", "safe"); content = "💎"; }
        else if (showMines && isMine) { cls.push("ghost-mine"); content = "💣"; }
        else if (isStaged) { cls.push("staged"); content = "🎯"; }
        if ((state.phase !== "playing" && !staging) || isRevealed) cls.push("disabled");
        return `<div class="${cls.join(" ")}" data-tile="${i}">${content}</div>`;
      }).join("")}
      </div>`;

      const liveMultHtml = state.phase === "playing" ? `<div class="mines-live-mult">
        ${multiplierFor(state.mines, state.picks).toFixed(2)}x
        <span class="muted">${state.picks} safe tile${state.picks === 1 ? "" : "s"} revealed · next pays ${multiplierFor(state.mines, state.picks + 1).toFixed(2)}x</span>
      </div>` : "";

      const summaryHtml = state.phase === "settled" && state.lastResult ? (() => {
        const r = state.lastResult;
        const cls = r.totalProfit > 0 ? "win" : r.totalProfit < 0 ? "lose" : "push";
        const headline = r.outcome === "mine" ? "Boom — You Lose" : r.outcome === "clear" ? "Full Clear!" : "Cashed Out";
        return `<div class="mines-round-summary ${cls}">
          <div class="mines-round-summary-headline">${headline}</div>
          <div class="muted" style="margin-bottom:6px">${r.picks} of ${GRID_SIZE - r.mines} safe tiles · ${r.mult.toFixed(2)}x</div>
          <div class="ov-summary-line total"><span>Total</span><span>${r.totalProfit >= 0 ? "+" : ""}${fmt(r.totalProfit)}</span></div>
        </div>`;
      })() : "";

      const autoStatusHtml = state.autoRunning ? `<div class="mines-auto-status">
        Autoplay running — round ${state.autoRoundsPlayed + 1} of ${state.autoRoundsTotal}
        <span class="muted">Cumulative: ${state.autoCumulativeProfit >= 0 ? "+" : ""}${fmt(state.autoCumulativeProfit)}</span>
      </div>` : (state.autoRoundsPlayed > 0 && !state.autoRunning && state.phase === "betting" ? `<div class="mines-auto-status">
        Autoplay stopped after ${state.autoRoundsPlayed} round${state.autoRoundsPlayed === 1 ? "" : "s"}
        <span class="muted">Cumulative: ${state.autoCumulativeProfit >= 0 ? "+" : ""}${fmt(state.autoCumulativeProfit)}</span>
      </div>` : "");

      let controlsHtml;
      if (state.phase === "betting") {
        const autoPanelHtml = state.autoMode ? `<div class="mines-auto-panel">
          <div class="muted" style="font-size:12px">Click tiles on the board above to stage them — they'll auto-reveal in that order every round.</div>
          <div class="mines-auto-row">
            <label>Rounds to play</label>
            <input type="number" id="mines-auto-rounds" min="1" max="500" value="${state.autoRoundsTotal}" ${state.autoRunning ? "disabled" : ""}>
          </div>
          <div class="mines-auto-row">
            <label>Stop if profit ≥</label>
            <input type="number" id="mines-auto-stop-profit" min="0" value="${state.autoStopOnProfit}" placeholder="0 = off" ${state.autoRunning ? "disabled" : ""}>
          </div>
          <div class="mines-auto-row">
            <label>Stop if loss ≥</label>
            <input type="number" id="mines-auto-stop-loss" min="0" value="${state.autoStopOnLoss}" placeholder="0 = off" ${state.autoRunning ? "disabled" : ""}>
          </div>
          <div class="row center" style="gap:8px">
            ${state.autoRunning
            ? `<button class="btn primary" id="mines-auto-stop">Stop Autoplay</button>`
            : `<button class="btn primary" id="mines-auto-start" ${!state.autoStagedTiles.length || !state.bet ? "disabled" : ""}>Start Autoplay</button>`}
          </div>
        </div>` : "";
        controlsHtml = `
          <div class="mines-panel">
            <div class="mines-mine-picker">
              <span class="muted">Mines</span>
              <input type="range" id="mines-count-slider" min="${MIN_MINES}" max="${MAX_MINES}" value="${state.mines}" ${state.autoRunning ? "disabled" : ""} />
              <span class="mines-mine-count">${state.mines}</span>
            </div>
            <div class="row" style="justify-content:space-between;align-items:center">
              ${chipStackHtml(state.bet)}
              ${jackpotSpotHtml(state.jackpotOn)}
            </div>
            <div class="mines-auto-toggle-row">
              <span class="muted">Autoplay mode</span>
              <button class="btn small ${state.autoMode ? "gold" : ""}" id="mines-auto-toggle" ${state.autoRunning ? "disabled" : ""}>${state.autoMode ? "On" : "Off"}</button>
            </div>
            ${autoPanelHtml}
          </div>
          <div class="ov-chip-rail">
            ${renderBetControls(
          "mines",
          state.bet,
          busy || state.autoRunning,
          { selectedChip: state.selectedChip }
        )}

          <div class="row center" style="gap:10px;flex-wrap:wrap;margin-top:10px">
            ${!state.autoMode
            ? `<button class="btn primary" id="mines-start" ${busy || !state.bet ? "disabled" : ""}>Start</button>`
            : ""}
          </div>
        </div>`;
      } else if (state.phase === "playing") {
        controlsHtml = `<div class="row center mt16">
          <button class="btn primary" id="mines-cashout" ${busy || state.picks === 0 ? "disabled" : ""} title="${state.picks === 0 ? "Reveal at least one safe tile first" : ""}">Cash Out ${multiplierFor(state.mines, state.picks).toFixed(2)}x</button>
        </div>`;
      } else {
        controlsHtml = state.autoRunning ? "" : `<div class="row center mt16">
          <button class="btn primary" id="mines-rebet">Rebet ${fmt(state.bet)}${state.jackpotOn ? " + jackpot" : ""}</button>
          <button class="btn" id="mines-again">Change Bet</button>
        </div>`;
      }

      root.innerHTML = jackpotBanner + rulesButtonRowHtml() + boardHtml + liveMultHtml + summaryHtml + autoStatusHtml + controlsHtml;
      wireRulesButton(root);

      if (state.phase === "playing") {
        root.querySelectorAll("[data-tile]").forEach((tile) => {
          tile.addEventListener("click", () => revealTile(parseInt(tile.dataset.tile, 10)));
        });
        const cashoutBtn = root.querySelector("#mines-cashout");
        if (cashoutBtn) cashoutBtn.addEventListener("click", cashOut);
      }

      if (state.phase === "betting") {
        if (staging) {
          root.querySelectorAll("[data-tile]").forEach((tile) => {
            tile.addEventListener("click", () => toggleAutoTile(parseInt(tile.dataset.tile, 10)));
          });
        }
        const autoToggle = root.querySelector("#mines-auto-toggle");
        if (autoToggle) autoToggle.addEventListener("click", () => { state.autoMode = !state.autoMode; render(); });
        const autoRoundsInput = root.querySelector("#mines-auto-rounds");
        if (autoRoundsInput) autoRoundsInput.addEventListener("change", (e) => {
          state.autoRoundsTotal = clamp(parseInt(e.target.value, 10) || AUTO_DEFAULT_ROUNDS, 1, 500);
          render();
        });
        const autoStopProfitInput = root.querySelector("#mines-auto-stop-profit");
        if (autoStopProfitInput) autoStopProfitInput.addEventListener("change", (e) => {
          state.autoStopOnProfit = Math.max(0, parseInt(e.target.value, 10) || 0);
          render();
        });
        const autoStopLossInput = root.querySelector("#mines-auto-stop-loss");
        if (autoStopLossInput) autoStopLossInput.addEventListener("change", (e) => {
          state.autoStopOnLoss = Math.max(0, parseInt(e.target.value, 10) || 0);
          render();
        });
        const autoStartBtn = root.querySelector("#mines-auto-start");
        if (autoStartBtn) autoStartBtn.addEventListener("click", runAutoplay);
        const autoStopBtn = root.querySelector("#mines-auto-stop");
        if (autoStopBtn) autoStopBtn.addEventListener("click", stopAutoplay);

        const slider = root.querySelector("#mines-count-slider");
        if (slider) slider.addEventListener("input", (e) => {
          state.mines = clamp(parseInt(e.target.value, 10), MIN_MINES, MAX_MINES);
          render();
        });
        const jackpotToggle = root.querySelector("#mines-jackpot-toggle");
        if (jackpotToggle) jackpotToggle.addEventListener("click", () => {
          if (!state.jackpotOn && JACKPOT_SIDE_BET > Balance.current) {
            toast("Not enough balance for the jackpot bet.");
            return;
          }
          state.jackpotOn = !state.jackpotOn;
          render();
        });
        wireBetControls(
          root,
          "mines",
          () => state.bet,
          (value) => {
            state.bet = value;
            render();
          },
          {
            getSelectedChip: () => state.selectedChip,
            setSelectedChip: (value) => {
              state.selectedChip = value;
            },
            onClear: () => {
              state.bet = 0;
              render();
            },
            minBet: 0,
            maxBet: MAX_BET,
          }
        );
        const startBtn = root.querySelector("#mines-start");
        if (startBtn) startBtn.addEventListener("click", startRound);
      } else if (state.phase === "settled" && !state.autoRunning) {
        const againBtn = root.querySelector("#mines-again");
        if (againBtn) againBtn.addEventListener("click", () => {
          const mines = state.mines, bet = state.bet, jp = state.jackpotOn;
          state = freshState();
          state.mines = mines;
          state.bet = bet;
          state.jackpotOn = jp;
          render();
        });
        const rebetBtn = root.querySelector("#mines-rebet");
        if (rebetBtn) rebetBtn.addEventListener("click", () => {
          const mines = state.mines, bet = state.bet, jp = state.jackpotOn;
          state = freshState();
          state.mines = mines;
          state.bet = bet;
          state.jackpotOn = jp;
          startRound();
        });
      }
    }

    // Closing the tab mid-round shouldn't let the player escape a bad
    // spot on the board, but it also can't retroactively force a
    // "decision" the way Blackjack/Three Card Poker can (there's no
    // fixed action like Stand/Fold to fall back on here — the entire
    // game IS the decision of whether to keep revealing). The fair
    // resolution: settle the round as a cash-out at whatever multiplier
    // was already locked in from safe tiles already revealed, exactly
    // as if the player had clicked Cash Out right before closing. If no
    // tiles were revealed yet, that's a 0x cash-out — a full loss of the
    // bet, same as if you'd walked away from a real table with your
    // chips still on a board you never touched.
    async function resolveAbandonedRound() {
      state.autoRunning = false; // stop any scripted loop first
      if (!state || state.phase !== "playing") return;
      if (state.picks > 0) {
        await settle("cashout", multiplierFor(state.mines, state.picks));
      } else {
        await settle("mine", 0);
      }
    }

    return {
      label: "Mines",
      icon: "💣",
      order: 6,
      mount(el) {
        root = el;
        state = freshState();
        if (window.SaltyJackpot) {
          jackpotUnsub = window.SaltyJackpot.subscribe((pool) => {
            jackpotAmount = pool.amount;
            const el2 = document.getElementById("mines-jackpot-banner");
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
  })();

  window.SaltyCore.GAME_MODULES.mines = SoloMines;
})();
