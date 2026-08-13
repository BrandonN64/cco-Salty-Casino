// ==UserScript==
// Salty's Casino — PROGRESSIVE JACKPOT MODULE
// Loaded via @require, after salty-core.js, before any game module that
// wants to feed or pay out the jackpot (blackjack, baccarat, ...).
// Registers window.SaltyJackpot so every table can call the same two
// functions: contribute(wagerAmount, gameId) on every bet placed, and
// award(tierId, gameId, meta, qualified) when that table's own rules
// detect one of its jackpot-worthy hands. The pool itself lives in one
// place — a single Firestore doc — so a bet on the Blackjack table and a
// bet on the Baccarat table are visibly feeding the exact same number,
// and a win on either table pays out of (and visibly drains) that same
// number for everyone watching, on both tables, in real time.
// ==/UserScript==
(function () {
  "use strict";

  const { getDb, getAuthReady, isFirebaseConfigured, Balance } = window.SaltyCore;

  const JACKPOT_DOC = "casino/jackpot";
  const SEED_AMOUNT = 5000;
  const CONTRIBUTION_RATE = 0.0005; // 0.05% of every wager, every game, all tables

  // Ordered rarest/highest first. `share` = fraction of the pool paid out
  // when that tier hits. The floor never drops below SEED_AMOUNT so the
  // jackpot can't be emptied down to zero and stall out.
  const TIERS = [
    { id: "mega", label: "Mega Jackpot", share: 1.00 },
    { id: "major", label: "Major Jackpot", share: 0.25 },
    { id: "minor", label: "Minor Jackpot", share: 0.05 },
  ];
  function getTier(tierId) { return TIERS.find((t) => t.id === tierId) || null; }

  function jref() {
    const [col, doc] = JACKPOT_DOC.split("/");
    return getDb().collection(col).doc(doc);
  }

  // Local-only fallback so the jackpot still functions (per-browser, not
  // shared across players) if Firebase isn't configured — same offline
  // fallback pattern core.js uses for Balance.
  const LS_KEY = "saltys_casino_jackpot_offline";
  function readLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { amount: SEED_AMOUNT };
  }
  function writeLocal(pool) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(pool)); } catch (e) {}
    listeners.forEach((fn) => { try { fn(pool); } catch (e) {} });
  }

  const listeners = new Set();
  let unsub = null;
  let current = { amount: SEED_AMOUNT };

  async function init() {
    if (!isFirebaseConfigured()) { current = readLocal(); listeners.forEach((fn) => fn(current)); return; }
    await getAuthReady();
    if (!isFirebaseConfigured()) { current = readLocal(); listeners.forEach((fn) => fn(current)); return; }
    const ref = jref();
    const snap = await ref.get();
    if (!snap.exists) await ref.set({ amount: SEED_AMOUNT, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    unsub = ref.onSnapshot((doc) => {
      if (doc.exists) { current = doc.data(); listeners.forEach((fn) => { try { fn(current); } catch (e) {} }); }
    });
  }
  const ready = init();

  function subscribe(fn) {
    listeners.add(fn);
    fn(current);
    return () => listeners.delete(fn);
  }
  function getAmount() { return current.amount || SEED_AMOUNT; }

  // Called on every wager, from every table. Skims CONTRIBUTION_RATE into
  // the shared pool. Fire-and-forget from the caller's perspective — it
  // doesn't touch the player's own Balance, only the shared pool doc.
  // Every wager funds the pool regardless of whether that player is
  // eligible to WIN it — same as a real slot floor, where every machine on
  // the linked network feeds the meter even though only max-bet players
  // (or, at a table game, only players with the jackpot side bet down)
  // can actually collect it. Eligibility is enforced separately in
  // award(), below.
  async function contribute(wagerAmount, gameId) {
    const amt = Number(wagerAmount);
    if (!amt || amt <= 0) return;
    const cut = +(amt * CONTRIBUTION_RATE).toFixed(4);
    if (!isFirebaseConfigured()) {
      const pool = readLocal();
      pool.amount = +((pool.amount || SEED_AMOUNT) + cut).toFixed(4);
      writeLocal(pool);
      return;
    }
    await ready;
    try {
      await getDb().runTransaction(async (tx) => {
        const snap = await tx.get(jref());
        const pool = snap.exists ? snap.data() : { amount: SEED_AMOUNT };
        tx.set(jref(), {
          amount: +(pool.amount + cut).toFixed(4),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          lastContributor: gameId || "unknown",
        });
      });
    } catch (e) { /* another write raced this one — negligible, next contribution catches up */ }
  }

  // Called by a table when ITS OWN rules detect a jackpot-worthy hand.
  //
  // `qualified` is REQUIRED and must be the caller's own check for whether
  // this particular player placed that table's flat jackpot side bet this
  // round — exactly like a real casino progressive (Caribbean Stud,
  // Casino Hold'em, progressive Blackjack, etc.): the pool is funded by
  // everyone's play, but only collectible by whoever paid for a shot at
  // it that hand. The gate lives here, in the shared module, rather than
  // being left to each game to remember, so a table can never accidentally
  // pay out a jackpot to someone who didn't buy in for it.
  //
  // Returns the payout amount actually awarded (0 if `qualified` is falsy
  // or the tier doesn't exist).
  async function award(tierId, gameId, meta, qualified) {
    const tier = getTier(tierId);
    if (!tier) return 0;
    if (!qualified) return 0;
    if (!isFirebaseConfigured()) {
      const pool = readLocal();
      const payout = +((pool.amount || SEED_AMOUNT) * tier.share).toFixed(2);
      pool.amount = Math.max(SEED_AMOUNT, +((pool.amount || SEED_AMOUNT) - payout).toFixed(2));
      writeLocal(pool);
      await Balance.applyDelta(payout, `jackpot_${tierId}_${gameId || "unknown"}`);
      return payout;
    }
    await ready;
    let payout = 0;
    try {
      await getDb().runTransaction(async (tx) => {
        const snap = await tx.get(jref());
        const pool = snap.exists ? snap.data() : { amount: SEED_AMOUNT };
        payout = +(pool.amount * tier.share).toFixed(2);
        const nextAmount = Math.max(SEED_AMOUNT, +(pool.amount - payout).toFixed(2));
        tx.set(jref(), {
          amount: nextAmount,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          lastWin: { tier: tierId, game: gameId || "unknown", payout, meta: meta || null, at: Date.now() },
        });
      });
    } catch (e) { payout = 0; }
    if (payout > 0) await Balance.applyDelta(payout, `jackpot_${tierId}_${gameId || "unknown"}`);
    return payout;
  }

  window.SaltyJackpot = { CONTRIBUTION_RATE, TIERS, getTier, contribute, award, getAmount, subscribe };
})();
