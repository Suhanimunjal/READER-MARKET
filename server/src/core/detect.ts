/**
 * Change detection: deciding what counts as "meaningfully changed".
 *
 * The premise this system is built on:
 *
 *   A change is meaningful when it is (a) unusual for THAT instrument,
 *   (b) not explained by the market as a whole, and (c) new to THIS user.
 *
 * A fixed percentage threshold fails (a): 3% in HDFC Bank is an event, 3% in a
 * smallcap that swings 8% a day is Tuesday. So we normalise by each
 * instrument's own realised volatility instead, and the threshold is expressed
 * in units of what that instrument normally does.
 *
 * This used to end "so the threshold becomes a constant false-positive rate
 * rather than a constant percentage", which was the load-bearing sentence of
 * the whole design and was never measured against the five years of prices in
 * this repository. Measured out of sample -- 49 symbols, 34,732 held-out
 * sessions -- it is false. At the same |z| >= 2.0 bar the alert rate runs from
 * 0.8% in SUZLON to 15.0% in TCS, and pools at 8.7% where a Gaussian implies
 * 4.6%. Standardising equalises scale, not shape: returns are fat-tailed and
 * the kurtosis differs by name, so one threshold cuts different fractions of
 * different distributions.
 *
 * The normalisation stays, because the argument for it never depended on that
 * conclusion -- one number for HDFC Bank and a smallcap is still wrong, and the
 * market adjustment still removes a median 13.9% of volatility out of sample
 * and hurt none of the 49. What the retraction cost is the idea that one
 * threshold could do the job alone, which is why attention is also rationed by
 * the card cap, the per-event cooldown and the market-wide collapse in rank.ts.
 *
 * Be precise about what is measured, because this is a retraction and a
 * retraction that overstates its replacement is worth nothing.
 * `server/test/calibration.test.ts` measures the rates and the spread quoted
 * above, and four things besides: the out-of-sample volatility reduction, that
 * the estimator is the one the documentation describes, what the risk horizon
 * does to an overnight gap, and how the baseline responds to a regime change.
 * Of the three rationing devices, only the cap has any test behind it -- the
 * expected cards per visit is measured against it in calibration.test.ts, and
 * the BELOW_CAP path is pinned in regressions.test.ts. The per-event cooldown
 * and the market-wide collapse are code, not measurements: grep the test
 * directory for COOLDOWN or MARKET_WIDE and nothing comes back. Saying
 * "measures all of it" here would be the same unmeasured claim this paragraph
 * exists to retract, pointed at the replacement. DECISIONS.md records this as
 * R7.
 *
 * Failing (b) is what makes watchlists unreadable on red days: the index drops
 * 3% and twenty cards fire saying the same thing. We measure the part of the
 * move the market does not explain.
 *
 * (c) lives in the user's watermark, not the calendar. "Since you last checked"
 * is a different window for every user, so every number here is computed over
 * that window, never over a fixed 1D bucket.
 */
import type { Paise } from "./money.js";
import { formatPct } from "./money.js";
import { scaleVol, zScore } from "./stats.js";
import { riskHorizonSessions } from "./calendar.js";
import { decomposeReturn, type CorporateActions } from "./corporate.js";
import { attribute, type Attribution } from "./attribution.js";
import type { Assessment } from "./quality.js";
import type { Baseline } from "./baseline.js";
export type { Baseline };

export type SignalKind =
  | "MOVE"
  | "VOLUME"
  | "LEVEL_BREAK"
  | "CORPORATE_ACTION"
  | "CIRCUIT"
  | "DATA_QUALITY"
  | "SYMBOL_LIFECYCLE"
  | "SUSPECTED_STRUCTURAL"
  /**
   * Not news, and never rendered as a card.
   *
   * A symbol that was evaluated and stayed inside its own range used to leave no
   * trace at all: it was counted, and the count was the whole record. That made
   * the held-back ledger empty on arrival for every account and every window,
   * which quietly falsified the loudest claim in the project -- that nothing is
   * dropped silently. Emitting the near miss, with the distance it fell short
   * by, turns "14 symbols checked" into fourteen answerable rows. `rank()` moves
   * these straight to the ledger; they can never reach a card.
   */
  | "NOTHING_UNUSUAL";

export type Direction = "UP" | "DOWN" | "NEUTRAL";

export interface Signal {
  symbol: string;
  kind: SignalKind;
  direction: Direction;
  /**
   * Comparable across kinds, roughly in units of sigmas. ~1 = worth a glance,
   * ~3 = look now. Kept on one scale so ranking across different kinds of news
   * is a sort, not a pile of special cases.
   */
  strength: number;
  headline: string;
  because: string;
  /** Everything the decision was made from. Rendered in the audit view. */
  evidence: Record<string, number | string | boolean | null>;
  /**
   * Where the quoted move came from, in five parts that add back up to it.
   *
   * Present on CORPORATE_ACTION and MOVE, and on nothing else. Those are the
   * two kinds whose headline *is* a return, so they are the two that owe an
   * answer to "then where did the rest of it go?". The others quote a level, a
   * turnover or a band, and five rows of return decomposition under a
   * 52-week-high card would be answering a question the card never asked.
   *
   * This used to read "absent on every kind but CORPORATE_ACTION", on the
   * grounds that a MOVE card's mechanical rows are "four zeros and a repeat".
   * That was wrong on both halves. It is three zeros, not four -- and the two
   * rows left are MARKET and STOCK, which is precisely the split the MOVE
   * card's own sentence asserts in words ("beyond what the market move
   * explains", "this is the stock, not the tape"). The card was making the
   * claim and withholding the arithmetic behind it. A zero in the SPLIT row is
   * also not filler: it is a measurement that no split occurred, which is what
   * lets a reader confirm the move was not mechanical rather than take our
   * word for it.
   *
   * SUSPECTED_STRUCTURAL is excluded on purpose and not by omission -- see the
   * note on that card, and the regression that pins it.
   *
   * Not folded into `evidence` because that is a flat bag of scalars rendered
   * as a definition list, and these are ordered rows with their own labels and
   * their own reasons for being missing.
   */
  attribution?: Attribution;
  windowFrom: number;
  windowTo: number;
  /** Stable across re-evaluations of the same underlying event. */
  dedupeKey: string;
}

export interface Policy {
  /** Sigma threshold for a price move. */
  moveZ: number;
  /** Sigma threshold for unusual volume. */
  volumeZ: number;
  /**
   * Absolute floor. A very low-volatility instrument can produce a 3-sigma
   * event on a 0.3% move: statistically true, humanly irrelevant. Relative and
   * absolute thresholds must both be crossed.
   */
  minAbsMove: number;
  /** Hard cap on surfaced items. The scarce resource is attention, not screen. */
  maxCards: number;
  /** Do not re-surface the same (symbol, kind) inside this window. */
  cooldownMs: number;
}

export const PRESETS: Record<"signal" | "balanced" | "everything", Policy> = {
  signal: { moveZ: 2.5, volumeZ: 3.0, minAbsMove: 0.02, maxCards: 3, cooldownMs: 6 * 3600_000 },
  balanced: { moveZ: 2.0, volumeZ: 2.5, minAbsMove: 0.01, maxCards: 5, cooldownMs: 4 * 3600_000 },
  everything: { moveZ: 1.0, volumeZ: 1.5, minAbsMove: 0.002, maxCards: 25, cooldownMs: 30 * 60_000 },
};

export interface DetectInput {
  symbol: string;
  now: number;
  /** The user's last-acknowledged view of this symbol. */
  watermarkTs: number;
  watermarkPrice: Paise | null;
  price: Paise | null;
  prevClose: Paise | null;
  exchangeTs: number | null;
  dayVolume: number | null;
  /**
   * Largest single-session move inside the user's window, when the price path
   * is known. Null falls back to the move against the previous close.
   */
  maxSessionMove: number | null;
  assessment: Assessment;
  baseline: Baseline;
  actions: CorporateActions;
  /** Index return over the same window. Null when unavailable. */
  marketReturn: number | null;
  circuitBand: number;
  policy: Policy;
}

/**
 * The single-session move above which we stop believing the number is a price
 * move at all.
 *
 * Calibrated against the recorded history rather than picked. The largest
 * genuine single-session move in five years of this universe is Adani
 * Enterprises at -28% during the January 2023 short-seller report; the largest
 * structural one is Vedanta at -65% on its 2026 demerger. 35% sits between them
 * with room on both sides.
 *
 * Critically this is measured **per session**, not across the user's window.
 * An earlier version tested the window return, which forced a second and looser
 * threshold for long absences so that a bear market would not be called a data
 * fault. That opened a hole: the same real demerger, seen by a user who had
 * been away a month, arrived as a 58% window return, fell under the looser bar,
 * and was reported to them as an ordinary price move. The distinction that
 * matters is not how long the user was away. It is whether the change happened
 * between two consecutive closes.
 */
export const STRUCTURAL_ABS = 0.35;

/**
 * There is deliberately no z-score arm on this guard, and the reason is the
 * most useful thing the statistics in this project taught me.
 *
 * A relative test looks like the natural fit here, because everything else in
 * the system is relative: meaningful is measured per instrument, so surely
 * "impossible" should be too. It is not, and the arithmetic says why. A genuine
 * 28% single-session crash -- Adani Enterprises on the January 2023
 * short-seller report, the largest real move in five years of this universe --
 * is roughly 28 sigma for a typical NSE name. A split is 90%. Both are far
 * outside any threshold a person would call generous, so no z-cutoff separates
 * them.
 *
 * An earlier version set that cutoff at 12 sigma and reasoned about it by
 * comparing it against the ranking thresholds, which top out near 2.5. That is
 * a category error: comparing one z against another says nothing about what
 * *magnitude* reaches it. Measured against the shipped baselines, 12 sigma
 * lands at an 11.8% move in Reliance and 10.2% in HDFC Bank, and 47 of the 49
 * equities on the list would have had a real 28% crash reported to the user as
 * "we cannot tell you what happened here" -- the product refusing to do its job
 * on precisely the day it exists for.
 *
 * So the structural test is a magnitude test, because magnitude is what
 * actually distinguishes a corporate action from a crash, and the one arm
 * covers every case the two arms did: a corrupt print at +47% and an
 * undocumented split at -90% both clear 35%.
 */

/**
 * Fraction of a move that known corporate actions must account for before it
 * counts as explained.
 *
 * The predicate here used to be "no corporate actions in the window at all",
 * which meant a single unrelated dividend disabled the guard completely. On this
 * universe the chance of some action falling inside the window reaches 88% over
 * a year, so the defence against an incomplete action feed was itself switched
 * off by the action feed being complete about something trivial.
 */
export const STRUCTURAL_EXPLAINED = 0.6;

export function detect(i: DetectInput): Signal[] {
  const out: Signal[] = [];
  // Never let the window invert. Acknowledging sets the watermark to the later
  // of the last trade and now, so on a quiet market the watermark can sit ahead
  // of the most recent print -- which produced events whose `windowFrom` was
  // after their `windowTo`. Harmless on screen and wrong in the log.
  const from = i.watermarkTs;
  const to = Math.max(i.exchangeTs ?? i.now, from);
  const win = { windowFrom: from, windowTo: to };

  // --- Data quality comes first and can silence everything else. ---
  if (i.assessment.quality === "UNAVAILABLE") {
    out.push({
      symbol: i.symbol,
      kind: "SYMBOL_LIFECYCLE",
      direction: "NEUTRAL",
      strength: 1.5,
      headline: i.symbol + " has no data",
      because:
        "the provider is not returning this symbol; it may have been renamed, suspended or delisted",
      evidence: { quality: i.assessment.quality },
      ...win,
      dedupeKey: i.symbol + ":lifecycle",
    });
    return out;
  }

  if (!i.assessment.usableForSignals) {
    out.push({
      symbol: i.symbol,
      kind: "DATA_QUALITY",
      direction: "NEUTRAL",
      strength: 1.2,
      headline: i.symbol + " data " + i.assessment.quality.toLowerCase(),
      because: i.assessment.reason,
      evidence: { quality: i.assessment.quality, ageMs: i.assessment.ageMs },
      ...win,
      dedupeKey: i.symbol + ":quality:" + i.assessment.quality,
    });
    // Never derive price news from a quote we do not trust.
    return out;
  }

  // --- Corporate actions: a mechanical price change is not price news. ---
  const dec = decomposeReturn(i.watermarkPrice, from, i.price, to, i.actions);

  // --- How far outside normal is this, in the instrument's own units?
  //
  // These three sit above the corporate-action card rather than below it
  // because the card now carries the five-part attribution, and the STOCK row
  // of that attribution *is* this residual -- the same number the z-score is
  // taken against. Recomputing it for the card would put a second route to it
  // in the codebase, and the card would then be free to disagree with the
  // alert sitting next to it. `sigma` and `z` stay below, where the structural
  // guard needs them.
  const r = dec.adjusted;
  const hasMarket =
    i.marketReturn != null && i.baseline.beta != null && i.baseline.residualVol != null;
  const residual = hasMarket && r != null ? r - i.baseline.beta! * i.marketReturn! : null;

  // Built once, here, and handed to both cards that can carry it.
  //
  // Not called twice with the same arguments, which would be equivalent today
  // and is exactly the shape that stops being equivalent the moment someone
  // adjusts one call site. A CORPORATE_ACTION card and a MOVE card can both
  // fire for the same symbol and window -- an action in the window that does
  // not explain the move leaves `isArtifact` false and lets the MOVE arm run --
  // and the two are then rendered one above the other. Two objects would be two
  // opportunities to disagree on screen about a single measured move; this is
  // one object, referenced twice.
  //
  // Cheap enough to build unconditionally: attribute() is pure arithmetic over
  // numbers already in hand, and building it before we know which cards fire
  // keeps the decision about *where it is shown* at the push sites, where the
  // reasoning about each card lives.
  const attribution = attribute({
    decomposition: dec,
    beta: i.baseline.beta,
    marketReturn: i.marketReturn,
    // The residual measured three lines up, handed over rather than
    // recomputed: attribute() prints what it is given here, so the STOCK row is
    // the same number the MOVE card's z-score is taken against.
    //
    // It is null while beta and the market return are not whenever the baseline
    // has no residualVol -- `hasMarket` above demands all three. attribute()
    // then prints the market row and refuses the stock row, which is the
    // truthful pair: we can say what the tape did to this name, and we have not
    // measured what is left over.
    residual,
  });

  // Hoisted out of the block below because the volume card needs it too: on a
  // split day the volume card can outscore this one and survive alone, and what
  // it is then allowed to say about the price is the name of the action plus
  // the same measured adjusted return this card quotes -- nothing inferred from
  // the fact that an action exists.
  const actionLabels = dec.actions.map((a) => a.label).join(", ");
  if (dec.actions.length > 0) {
    out.push({
      symbol: i.symbol,
      kind: "CORPORATE_ACTION",
      direction: "NEUTRAL",
      strength: dec.isArtifact ? 2.6 : 1.4,
      headline: i.symbol + " " + actionLabels,
      because: dec.isArtifact
        ? "the quoted price moved " +
          formatPct(dec.raw ?? 0) +
          ", but " +
          actionLabels +
          " accounts for it. Your position changed " +
          formatPct(dec.adjusted ?? 0) +
          "."
        : actionLabels + " in this window; the adjusted move is " + formatPct(dec.adjusted ?? 0),
      evidence: {
        rawReturn: dec.raw,
        adjustedReturn: dec.adjusted,
        explainedFraction: round(dec.explainedFraction, 3),
        isArtifact: dec.isArtifact,
      },
      // The two numbers above answer "was this mechanical?" and leave "then
      // where did the rest of it go?" to the reader's subtraction, which comes
      // out wrong on a split day by the interaction term. This is the answer,
      // in five parts that rebuild `rawReturn` -- with the shortfall of that
      // rebuild reported rather than assumed away; see attribution.ts.
      attribution,
      ...win,
      dedupeKey: i.symbol + ":ca:" + dec.actions[0]!.exDateTs,
    });
  }

  // --- Structural guard: moves too large to have been trading.
  //
  // The corporate-action feed is incomplete, and we can prove it: Vedanta fell
  // 65% overnight on its demerger and the provider reports no event at all. A
  // system that trusts the feed alone tells the user their holding lost
  // two-thirds of its value, which is both terrifying and false.
  //
  // So there is a second, purely statistical line of defence. A single-session
  // move beyond what any Indian equity does by trading, with nothing in the
  // feed to explain it, is reported as an unexplained structural event rather
  // than as a price move. Saying "something happened here and we cannot tell
  // you what" is the only honest output; a confident wrong number is not.
  // Computed before the structural guard rather than after, because the guard
  // needs it. (`r`, `hasMarket` and `residual` moved further up still, to
  // above the corporate-action card that quotes the residual.)
  const horizon = Math.max(riskHorizonSessions(from, to), 1 / 375);
  const sigma = hasMarket
    ? scaleVol(i.baseline.residualVol!, horizon)
    : i.baseline.dailyVol != null
      ? scaleVol(i.baseline.dailyVol, horizon)
      : null;
  const z = r != null ? zScore(residual ?? r, sigma) : null;

  // --- Structural guard: changes too large to have been trading.
  //
  // The corporate-action feed is incomplete, and we can prove it: Vedanta fell
  // 65% overnight on its 2026 demerger and the provider reports no event at all.
  // A system that trusts the feed alone tells the user their holding lost
  // two-thirds of its value, which is both terrifying and false.
  //
  // Two conditions, and both were originally wrong in ways that mattered. The
  // magnitude is now measured per session rather than across the window, so a
  // demerger is caught however long the user was away. And "unexplained" now
  // means the known actions fail to account for the move, not that no actions
  // exist, because the latter let one unrelated dividend switch the whole
  // defence off.
  // The larger of the two, not one in preference to the other.
  //
  // Preferring the recorded path looked tidier and quietly disabled the guard
  // for anything happening right now: the path is built from settled daily
  // bars, so a corporate action in today's live quote is simply not in it, and
  // a non-null path value meant the live comparison never ran. Both are
  // single-session moves and the guard cares about whichever is worse.
  const liveSessionMove =
    i.price != null && i.prevClose != null && i.prevClose > 0
      ? (i.price - i.prevClose) / i.prevClose
      : null;
  const sessionMove = [i.maxSessionMove, liveSessionMove]
    .filter((x): x is number => x != null)
    .reduce<number | null>((worst, x) => (worst == null || Math.abs(x) > Math.abs(worst) ? x : worst), null);

  // Both conditions are measured over the same thing: the session.
  //
  // This compared a window-level `explainedFraction` against a session-level
  // magnitude, which reopened the hole it was written to close and made it
  // worse the longer the user was away. Over six months a net return can be
  // near zero, so a trivial dividend explains a large *fraction* of it -- and a
  // 65% overnight collapse inside that window was reported as "dividend in this
  // window; the adjusted move is -0.3%".
  //
  // Comparing the price impact the known actions actually carry against the
  // size of the session move makes the test scale-free: a rupee of dividend
  // cannot account for two thirds of a share price whatever the window is.
  const actionImpact = dec.actions.reduce((sum, a) => sum + Math.abs(a.priceImpact), 0);
  const absurdMagnitude = sessionMove != null && Math.abs(sessionMove) >= STRUCTURAL_ABS;
  const unexplained =
    sessionMove == null
      ? dec.explainedFraction < STRUCTURAL_EXPLAINED
      : actionImpact < Math.abs(sessionMove) * STRUCTURAL_EXPLAINED;

  if (unexplained && absurdMagnitude) {
    const shown = sessionMove!;
    out.push({
      symbol: i.symbol,
      kind: "SUSPECTED_STRUCTURAL",
      direction: "NEUTRAL",
      strength: 3.5,
      headline: i.symbol + " changed " + formatPct(shown) + " with nothing on file to explain it",
      because:
        "a move of this size between two consecutive closes is not something an Indian equity does by trading. " +
        "The likely causes are a demerger, spin-off or restatement that our corporate-action feed does not carry. " +
        "Verify against the exchange before acting on this number.",
      evidence: {
        sessionMove: sessionMove == null ? null : round(sessionMove, 5),
        windowReturn: dec.raw == null ? null : round(dec.raw, 5),
        knownActions: dec.actions.length,
        explainedFraction: round(dec.explainedFraction, 3),
        magnitudeThreshold: STRUCTURAL_ABS,
        z: z == null ? null : round(z, 1),
        horizonSessions: round(horizon, 3),
      },
      // No `attribution` here, and its absence is the deliberate part.
      //
      // `attribution` is in scope, it is already built, and adding the field
      // would be one word. It would also be the single most contradictory
      // thing this file could do. This card exists to say the system does not
      // believe its own inputs: the move is too large to have been trading,
      // the action feed carries nothing to explain it, and the honest output
      // is "something happened here and we cannot tell you what". A five-row
      // breakdown underneath that sentence would answer the exact question the
      // sentence just refused, in the confident register of a measurement --
      // and the rows would close to 1e-12 while doing it, because the identity
      // is arithmetic and closes just as tightly over a number that is wrong.
      // Vedanta's -65% would attribute neatly to MARKET and STOCK and read as
      // a well-understood day. The closure is a property of the algebra, never
      // evidence that the input was a real price.
      //
      // So the refusal is asserted behaviour rather than an accident of which
      // fields this push happens to list, and it is pinned by "refuses to
      // attribute a move it has just said it does not believe" in
      // server/test/regressions.test.ts. Attaching it here fails that test.
      ...win,
      dedupeKey: i.symbol + ":structural:" + bucketTs(to, 24 * 3600_000),
    });
    return out; // never also report this as an ordinary price move
  }

  // --- Price move, normalised over the user's actual absence. ---
  if (r != null && !dec.isArtifact) {
    const passesAbs = Math.abs(r) >= i.policy.minAbsMove;
    const passesZ = z != null && Math.abs(z) >= i.policy.moveZ;

    // The stock went one way while the market went the other. Qualitatively
    // different news and worth saying out loud, but it does NOT lower the bar.
    // An earlier version discounted the threshold to 0.7x whenever the raw signs
    // differed, which on this universe fired for 12.75% of symbol-sessions whose
    // residual was under one sigma. A defensive stock drifting up 0.3% on a down
    // day is not news, and calling it "the stock, not the tape" while quietly
    // relaxing the test moved the bar for a whole class of symbol-sessions to a
    // place nobody had measured. That matters more here than it would elsewhere:
    // the measured alert rate at this bar already spans 0.8% to 15.0% across
    // instruments (R7), so the threshold is not doing as much work as it looks
    // like it is, and discounting it is not a small adjustment to a known
    // quantity. The copy changes; the threshold does not.
    const bucked =
      residual != null &&
      i.marketReturn != null &&
      Math.sign(r) !== Math.sign(i.marketReturn) &&
      Math.abs(i.marketReturn) > 0.004;

    if (!(passesAbs && passesZ)) {
      // Evaluated, and quiet. Recorded so the ledger can say how close it came.
      out.push({
        symbol: i.symbol,
        kind: "NOTHING_UNUSUAL",
        direction: "NEUTRAL",
        strength: z == null ? 0 : Math.abs(z),
        headline: i.symbol + " " + formatPct(r),
        because:
          z == null
            ? "not enough history yet to say what is normal for this instrument"
            : Math.abs(z).toFixed(1) +
              "\u03c3 against a bar of " +
              i.policy.moveZ.toFixed(1) +
              "\u03c3" +
              (passesAbs ? "" : ", and below the " + (i.policy.minAbsMove * 100).toFixed(1) + "% floor"),
        evidence: {
          returnAdjusted: round(r, 5),
          z: z == null ? null : round(z, 2),
          threshold: i.policy.moveZ,
          minAbsMove: i.policy.minAbsMove,
        },
        ...win,
        dedupeKey: i.symbol + ":quiet:" + bucketTs(to, 3600_000),
      });
    }

    if (passesAbs && passesZ) {
      const dir: Direction = r > 0 ? "UP" : "DOWN";
      const zs = z != null ? Math.abs(z).toFixed(1) + "\u03c3" : "an unusual";
      out.push({
        symbol: i.symbol,
        kind: "MOVE",
        direction: dir,
        strength: z != null ? Math.abs(z) : 1,
        headline: i.symbol + " " + formatPct(r),
        because: bucked
          ? zs +
            " move against a market that went " +
            formatPct(i.marketReturn!) +
            ": this is the stock, not the tape"
          : hasMarket
            ? zs + " beyond what the market move explains"
            : zs + " versus its own recent volatility",
        evidence: {
          returnAdjusted: round(r, 5),
          returnRaw: round(dec.raw ?? 0, 5),
          marketReturn: i.marketReturn == null ? null : round(i.marketReturn, 5),
          beta: i.baseline.beta == null ? null : round(i.baseline.beta, 3),
          residual: residual == null ? null : round(residual, 5),
          sigmaForHorizon: sigma == null ? null : round(sigma, 5),
          horizonSessions: round(horizon, 3),
          z: z == null ? null : round(z, 2),
          buckedTheMarket: bucked,
          baselineObservations: hasMarket ? i.baseline.betaObservations : i.baseline.observations,
        },
        // The same object the corporate-action card gets, when that card also
        // fired for this window. The `because` line above claims a split
        // between the tape and the stock in words -- "beyond what the market
        // move explains", or "this is the stock, not the tape" -- and this is
        // that claim as arithmetic the reader can check. The MARKET row is
        // `beta * marketReturn` and the STOCK row is the residual quoted in
        // `evidence` directly above, so the card and its own audit trail are
        // the same numbers rather than two measurements of one thing.
        //
        // On the ordinary case -- no action in the window -- SPLIT, DIVIDEND
        // and INTERACTION are all exactly zero, and they are shown rather than
        // hidden. A reader checking whether a -4% day was mechanical gets an
        // answer here instead of an absence to interpret.
        attribution,
        ...win,
        dedupeKey: i.symbol + ":move:" + bucketTs(to, 3600_000),
      });
    }
  }

  // Did the price move actually surface as a card above? Both bars, exactly as
  // the MOVE arm applies them, hoisted so the volume card below cannot answer a
  // different question than the one the user's screen answered. Note that
  // `!dec.isArtifact` is inherited from the MOVE arm too, which makes this false
  // on a split day for a reason that has nothing to do with either bar -- the
  // volume card handles that case on its own branch rather than reading this
  // flag as "the price did not move".
  const priceMoveSurfaced =
    r != null &&
    !dec.isArtifact &&
    Math.abs(r) >= i.policy.minAbsMove &&
    z != null &&
    Math.abs(z) >= i.policy.moveZ;

  // --- Unusual volume. The market disagreeing about price is one signal;
  //     the market suddenly caring at all is a different one.
  //     Computed in log space: see the note on Baseline.logVolumeMean.
  if (
    i.dayVolume != null &&
    i.dayVolume > 0 &&
    i.baseline.logVolumeMean != null &&
    i.baseline.logVolumeStdev != null
  ) {
    const zv = zScore(Math.log(i.dayVolume) - i.baseline.logVolumeMean, i.baseline.logVolumeStdev);
    if (zv != null && zv >= i.policy.volumeZ) {
      const mult = i.baseline.avgVolume ? i.dayVolume / i.baseline.avgVolume : null;
      // This card used to assert "without a price move large enough to explain
      // it" whatever the price had done, while the predicate above tests volume
      // and nothing else. That is not a harmless flourish. The one-card-per-
      // symbol fold in rank.ts scores a 5.5σ volume at 5.5 x 0.7 = 3.85 and a
      // 2.1σ MOVE at 2.1, so on exactly the days where both fire, the surviving
      // card denied a move that was sitting suppressed underneath it.
      //
      // The first repair read the price z alone, which broke the rule on
      // Policy.minAbsMove sixty lines up: a 0.5% move on a very quiet
      // instrument is 2.9σ, the MOVE arm declines to call it a move, and this
      // card announced "alongside a 2.9σ price move" while the held-back ledger
      // row directly under it said that move was below the floor and not news.
      // So the clause reads `priceMoveSurfaced` -- both bars, the sigma and the
      // absolute floor, the same test the MOVE arm is judged on. A sub-floor
      // move falls into the honest branch, and truthfully: half a percent does
      // not explain five sigma of turnover.
      //
      // The no-z branch names what is missing and stops there, because this
      // block cannot tell which of the two causes it was. Either there is no
      // watermark price to measure from, or there is one and no volatility to
      // divide by -- and the gates do not coincide, so the second really
      // happens: volume statistics need 20 bars inside a 90-session window
      // (baseline.ts), while dailyVol needs 30 returns inside a 500-session one
      // (ewmaVol's minObs in stats.ts). A newly listed instrument can have the
      // first and not the second. Naming either cause would be a diagnosis the
      // code never made.
      //
      // The artifact branch exists because `priceMoveSurfaced` inherits
      // `!dec.isArtifact` from the MOVE arm, so on a documented split every
      // reading of the price is "no move" -- and this card can outscore the
      // CORPORATE_ACTION card that explains the day (5.5 x 0.7 = 3.85 against
      // 2.6 x 1.25 = 3.25) and fold it away, leaving the split day denied by
      // the only card the user sees. That is the same defect the paragraph
      // above describes, reached down a different arm.
      //
      // That arm's first wording was "and your position did not change", which
      // is R6 again in the fix for R6: `isArtifact` (corporate.ts) asks only
      // that the known actions explain 60% of the raw move, so the adjusted
      // return it permits runs up to 40% of it. On a 10:1 split from 270 to 30
      // the holder is up 11.11% and that sentence denied it, on the one card
      // the fold leaves standing. So the arm quotes the measured number
      // instead, in the same words the CORPORATE_ACTION card uses for it.
      const priceTail =
        z == null
          ? "; we cannot compute a price z over this window, so we say nothing about the price"
          : dec.isArtifact
            ? ", on a day when " +
              actionLabels +
              " accounts for the quoted price move; your position changed " +
              formatPct(dec.adjusted ?? 0)
            : priceMoveSurfaced
              ? ", alongside a " + Math.abs(z).toFixed(1) + "σ price move"
              : ", without a price move large enough to explain it";
      out.push({
        symbol: i.symbol,
        kind: "VOLUME",
        direction: "NEUTRAL",
        strength: Math.min(zv, 6),
        headline:
          i.symbol + (mult ? " " + mult.toFixed(1) + "× normal volume" : " unusual volume"),
        because: "turnover is " + zv.toFixed(1) + "σ above its own typical day" + priceTail,
        evidence: {
          dayVolume: i.dayVolume,
          typicalVolume: i.baseline.avgVolume == null ? null : Math.round(i.baseline.avgVolume),
          zLogVolume: round(zv, 2),
          // Both halves of the test the sentence above turns on, so a reader
          // can check it: the z against moveZ, and the return against the
          // floor. The third way it can be false -- a corporate action -- is
          // recorded as `isArtifact` on the CORPORATE_ACTION card for the same
          // symbol and window, and that card is the one the fold may have
          // taken away. So note that `priceReturn` is the corporate-action-
          // adjusted return (`r` is `dec.adjusted`, above): on a split day the
          // percentage the sentence quotes is this field times a hundred, and
          // needs no second copy here to be checkable.
          priceZ: z == null ? null : round(z, 2),
          priceReturn: r == null ? null : round(r, 5),
          priceMoveFloor: i.policy.minAbsMove,
          priceMoveSurfaced,
        },
        ...win,
        dedupeKey: i.symbol + ":vol:" + bucketTs(to, 6 * 3600_000),
      });
    }
  }

  // --- Level breaks. Yearly extremes are where humans actually act. ---
  if (i.price != null && i.watermarkPrice != null) {
    const hi = i.baseline.week52High;
    const lo = i.baseline.week52Low;
    if (hi != null && i.price > hi && i.watermarkPrice <= hi) {
      out.push({
        symbol: i.symbol,
        kind: "LEVEL_BREAK",
        direction: "UP",
        strength: 2.2,
        headline: i.symbol + " broke its 52-week high",
        because: "first print above " + (hi / 100).toFixed(2) + " in a year",
        evidence: { level: hi, price: i.price, side: "HIGH" },
        ...win,
        dedupeKey: i.symbol + ":break:HIGH:" + bucketTs(to, 24 * 3600_000),
      });
    }
    if (lo != null && i.price < lo && i.watermarkPrice >= lo) {
      out.push({
        symbol: i.symbol,
        kind: "LEVEL_BREAK",
        direction: "DOWN",
        strength: 2.2,
        headline: i.symbol + " broke its 52-week low",
        because: "first print below " + (lo / 100).toFixed(2) + " in a year",
        evidence: { level: lo, price: i.price, side: "LOW" },
        ...win,
        dedupeKey: i.symbol + ":break:LOW:" + bucketTs(to, 24 * 3600_000),
      });
    }
  }

  // --- Circuit. Not a big move: the absence of a market. ---
  if (i.price != null && i.prevClose != null && i.prevClose > 0) {
    const m = (i.price - i.prevClose) / i.prevClose;
    if (Math.abs(m) >= i.circuitBand * 0.985) {
      out.push({
        symbol: i.symbol,
        kind: "CIRCUIT",
        direction: m > 0 ? "UP" : "DOWN",
        strength: 3.2,
        headline: i.symbol + " is at its " + (m > 0 ? "upper" : "lower") + " circuit",
        because:
          "locked at the " +
          (i.circuitBand * 100).toFixed(0) +
          "% band: you may not be able to trade out of this at the quoted price",
        evidence: { moveFromPrevClose: round(m, 4), circuitBand: i.circuitBand },
        ...win,
        dedupeKey: i.symbol + ":circuit:" + bucketTs(to, 24 * 3600_000),
      });
    }
  }

  return out;
}

function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/** Floor a timestamp to a bucket so re-evaluations of one event share a key. */
function bucketTs(ts: number, size: number): number {
  return Math.floor(ts / size) * size;
}
