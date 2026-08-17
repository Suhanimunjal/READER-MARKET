/**
 * Where a quoted move came from, in five parts that add back up to it.
 *
 * The corporate-action card answers "was this mechanical?" with one number.
 * It does not answer "then where did the rest of it go?", and the subtraction
 * a user does in their head to check us comes out wrong in a way that looks
 * like our arithmetic is broken.
 *
 * Nestle India's 10:1 on 2024-01-05, measured off the recorded history in
 * data/history rather than asserted here: the tape printed -90.17% and the
 * position was down 1.67%. Take the split off and you expect
 * -90% + -1.67% = -91.67%. The tape says -90.17%. That 1.50% gap is not
 * rounding and it is not a defect. It is a term, and this module's whole
 * reason to exist is to print it.
 *
 * Those three numbers are pinned by "prints the five parts of Nestle India's
 * 10:1, measured rather than asserted" in server/test/golden.test.ts, which
 * recomputes them from the recorded bars on every run. An earlier version of this paragraph carried
 * -89.84% / +1.6% / -1.44%, which were invented and which no test measured --
 * the hand-built case in core.test.ts was reverse-engineered to agree with
 * them. The sign of the holder's return was the giveaway: Nestle fell that
 * session.
 *
 *   raw      = (P1 - P0) / P0
 *   adjusted = (P1 + div - P0*sf) / (P0*sf)                    [corporate.ts]
 *
 * Rearranging the second for P1 and substituting into the first is exact —
 * no approximation, no small-move assumption, nothing dropped:
 *
 *   raw = (sf - 1)                 split mechanics
 *       + (-div / P0)              dividend
 *       + beta * marketReturn      the tape
 *       + residual                 the stock itself
 *       + (sf - 1) * adjusted      the interaction
 *
 * The last two lines are one line split in two: `adjusted` is exactly
 * `beta*marketReturn + residual`, because that is the definition of residual
 * in detect.ts and not an approximation of it.
 *
 * WHAT THE INTERACTION TERM IS. On Nestle it is -0.9 * -0.0167 = +1.50%. The
 * -1.67% the holder took was taken on shares the split had already multiplied
 * by ten, so it reaches the quoted price shrunk by the same factor the price
 * itself was shrunk by. The term is not slippage, not a correction and not an
 * error bar: it is the part of the real move that the split mechanics scaled
 * away before the tape ever saw it. It is zero whenever sf = 1, which is every
 * day a stock does not split, which is why nobody notices it is missing until
 * the one day it is 1.50%.
 *
 * It carries the sign of `(sf - 1) * adjusted`, so on a forward split it
 * opposes the holder's move: Nestle's holder lost 1.67% and the term is
 * *positive*, because a tenth of a loss is a smaller loss. Reading the sign
 * off the split alone gets it backwards half the time.
 *
 * WHY IT IS PRINTED RATHER THAN FOLDED. Folding it into the residual is
 * tidier and gives four rows instead of five. It also makes the stock's own
 * row read -1.67% + 1.50% = -0.17% on a day the stock did -1.67% — so the single
 * row a reader would check us against is the single row that is false, and
 * the four rows still sum to the tape, so nothing complains. A row that needs
 * a sentence of explanation beats a row that is quietly wrong.
 *
 * WHERE IT IS PRINTED. detect.ts calls this once, above both cards, and
 * attaches the one object it builds to CORPORATE_ACTION and to MOVE — the two
 * kinds whose headline *is* a return; the workspace renders the five rows
 * under either. SUSPECTED_STRUCTURAL is refused on purpose and pinned by a
 * test, because a breakdown that closes to 1e-12 under a card admitting it
 * does not believe the number would answer the question that card declines.
 *
 * That paragraph has now been wrong twice. It used to say this module was
 * called by nothing at all while claiming printing the interaction term was
 * the whole reason the module existed; then it said the corporate-action card
 * carried the rows "and nowhere else", which 82a701e made false the day it
 * put them on the move card too and left this header behind. Both are the
 * same defect — a sentence true of the intent and false of the codebase — and
 * it is the one this project keeps catching itself in. The doc comment on
 * `Signal.attribution` in detect.ts is the scope's home, beside the push
 * sites that decide it; if these two ever disagree again, that one is right.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not compute beta, the market return
 * or the residual; it consumes the ones its caller already measured. So it
 * cannot promise the five parts close — it reports `closureError` and lets
 * the caller and the tests look. The closure is exact when the residual
 * handed in was measured against the same beta and market return handed in
 * alongside it (detect.ts's `r - beta*marketReturn`), and the tests in
 * server/test/core.test.ts pin that at 1e-12 over a grid and a few hundred
 * pseudo-random cases.
 */
import type { ReturnDecomposition } from "./corporate.js";

/** Who moved the price: the share count, the tape, or the company. */
export type PartSource = "MECHANICAL" | "MARKET" | "STOCK";

export type PartKey = "SPLIT" | "DIVIDEND" | "MARKET" | "STOCK" | "INTERACTION";

export interface AttributionPart {
  key: PartKey;
  /** Renderable on its own, without the caller knowing what `key` means. */
  label: string;
  /**
   * Signed fraction of the *raw* move this part accounts for, or null when it
   * could not be computed. Never a zero standing in for "we don't know": a
   * zero here is a measurement that the part contributed nothing.
   */
  value: number | null;
  source: PartSource;
  /** Set only when `value` is null: what was missing. */
  missing: string | null;
}

export interface Attribution {
  /** The quoted move, straight from the decomposition. */
  raw: number | null;
  /** The move the holder actually experienced. */
  adjusted: number | null;
  /** Always five entries, in reading order, nulls included. */
  parts: AttributionPart[];
  /** Sum of the parts; null when a part the identity needs is missing. */
  reconstructed: number | null;
  /**
   * raw - reconstructed. Reported rather than asserted: this module is handed
   * its beta and residual and cannot verify they were measured against each
   * other, so it publishes the discrepancy instead of claiming there is none.
   */
  closureError: number | null;
  /**
   * False when there was no beta or no market return, in which case the whole
   * adjusted move sits on STOCK and is labelled as unseparated. Refusing to
   * split it is the honest option; splitting it against an assumed beta of 1
   * is a guess wearing a number's clothes.
   */
  marketAttributed: boolean;
}

export interface AttributionInput {
  /**
   * Straight from decomposeReturn. The split factor, the dividend and the
   * opening price are all read off this object rather than recomputed or
   * passed alongside it, so the parts are built from the exact numbers that
   * produced `adjusted` — see ReturnDecomposition's note on why a second route
   * to the same dividend is not the same dividend.
   *
   * The opening price used to arrive as a second field on this interface, and
   * a doc comment asking the caller to pass the unrestated one was the whole
   * of the enforcement. Nothing here could check it, and there was no
   * production caller yet, so the first one written would have been the one to
   * get it wrong. It is `decomposition.fromPriceUsed` now, and there is
   * nothing left to disagree with.
   */
  decomposition: ReturnDecomposition;
  beta: number | null;
  marketReturn: number | null;
  /**
   * `adjusted - beta*marketReturn`, as detect.ts measures it. Required
   * whenever `beta` and `marketReturn` are both present: this module will not
   * re-derive it, so a null here refuses the STOCK row rather than filling it
   * in with a number measured by a second route. Note that detect.ts's own
   * `hasMarket` additionally requires `baseline.residualVol`, so a caller
   * copying its residual line can hand us a beta and a market return with no
   * residual beside them — that is the case this refuses.
   */
  residual: number | null;
}

/**
 * Normalise -0 to 0. IEEE-754 gives -0 for `-0/P0` on a window with no
 * dividend and for `(sf-1)*adjusted` on a falling day with no split; the sums
 * are unaffected, but Object.is(-0, 0) is false and a caller comparing a part
 * against 0 has no business losing to the sign bit of a zero.
 */
function unsignZero(x: number): number {
  return x === 0 ? 0 : x;
}

export function attribute(input: AttributionInput): Attribution {
  const { decomposition: dec, beta, marketReturn, residual } = input;
  const sf = dec.splitFactorApplied;
  const div = dec.dividendPerShare;
  const adjusted = dec.adjusted;

  // Always computable: sf is a property of the action feed, not of any price.
  // Zero here means "no split in this window", which is a measurement.
  const splitValue = unsignZero(sf - 1);

  // The ORIGINAL P0, matching corporate.ts's own `-d.amount / fromPrice`, and
  // taken off the decomposition so it is that same P0 by construction rather
  // than by a caller's good intentions. Restating it by the split instead
  // inflates this row by the split ratio AND breaks the sum by
  // (div/P0)(1/sf - 1), so the closure tests do catch it: that mutation was
  // run, and "dividend before the split" fails at 3.33e-4, the 300-window
  // property test at 0.2397. What they cannot catch is a window with no
  // dividend or no split — div = 0 or sf = 1 makes the two bases coincide, and
  // then nothing anywhere complains. Which is why the base is now carried
  // rather than passed: the case the tests are blind to is the case where a
  // second route is free to be wrong.
  const base = dec.fromPriceUsed != null && dec.fromPriceUsed > 0 ? dec.fromPriceUsed : null;
  const dividendValue = base != null ? unsignZero(0 - div / base) : null;

  const hasMarket = beta != null && marketReturn != null;
  const marketValue = hasMarket ? unsignZero(beta * marketReturn) : null;

  // The label names the beta because the card face already quotes the index's
  // own return, and this row is not that number. detect.ts's MOVE because-line
  // prints `marketReturn` itself -- "a market that went M" -- and a few lines
  // below it this row printed `beta*M` under the words "moved with the market".
  // Two adjacent numbers, both described as the market, differing by
  // (beta - 1)*M, which on a high-beta name against a market move of a couple
  // of percent is more than a whole percentage point. The seeded demo surfaces
  // that pairing routinely: every `buckedTheMarket` MOVE card puts that
  // sentence directly above this row, and the beta between them is a measured
  // number that has no reason to be 1. Nothing on the face said the row was
  // scaled, or by what.
  //
  // The parts-note under the ledger already spends a sentence closing the
  // raw-vs-adjusted gap on the same card and had nothing to say about this one,
  // because that note is built from the three mechanical rows, which are all
  // zero on exactly the cards where this gap is widest.
  //
  // Three decimals rather than two: that is what the MOVE card's
  // `evidence.beta` is rounded to (detect.ts's `round(i.baseline.beta, 3)`), so
  // the face and the audit panel quote one beta instead of two roundings of it.
  // The row itself is multiplied by the unrounded beta, so multiplying the
  // sentence's market return by this label recovers the row to about the
  // hundredth the ledger prints rather than exactly; the parts to six decimals
  // are under "Why this surfaced", which is four places more than the face and
  // still a rounding, as that panel says of itself.
  //
  // The null branch keeps the bare label: with no beta there is no scaling to
  // name, and the row prints `missing` rather than a number anyway.
  const marketLabel = hasMarket
    ? "moved with the market, scaled by a beta of " + beta.toFixed(3)
    : "moved with the market";

  // With no market to subtract, the entire adjusted move is the stock's, and
  // says so in its label. With one, this row is the caller's residual and
  // nothing else: that residual is the number the z-score was taken against,
  // and a card quoting a differently-measured one would disagree with the
  // alert it sits next to.
  //
  // There used to be a fallback here — `adjusted - marketValue` when no
  // residual arrived — and it was worse than useless. It recomputes the same
  // quantity detect.ts measures its residual with, so a test handing in a
  // residual built that way cannot tell the pass-through from the
  // recomputation, and the paragraph above was pinned by nothing.
  // Meanwhile the one caller it would actually fire for is the one whose
  // residual came from somewhere else — exactly the case the paragraph says
  // must not be silently overwritten. Missing is now refused, the same way the
  // MARKET row above refuses a missing beta, and both halves are pinned by
  // "prints the residual it was handed" and "refuses the stock's row when a
  // beta arrives without the residual".
  let stockValue: number | null = null;
  let stockMissing: string | null = null;
  if (adjusted == null) {
    stockMissing = "no adjusted return to attribute";
  } else if (!hasMarket) {
    stockValue = unsignZero(adjusted);
  } else if (residual != null) {
    stockValue = unsignZero(residual);
  } else {
    stockMissing = "no residual measured against this beta and market return";
  }

  const interactionValue = adjusted != null ? unsignZero((sf - 1) * adjusted) : null;

  const parts: AttributionPart[] = [
    {
      key: "SPLIT",
      label: "split mechanics",
      value: splitValue,
      source: "MECHANICAL",
      missing: null,
    },
    {
      key: "DIVIDEND",
      label: "dividend paid out",
      value: dividendValue,
      source: "MECHANICAL",
      missing: dividendValue == null ? "no opening price to divide the dividend by" : null,
    },
    {
      key: "MARKET",
      label: marketLabel,
      value: marketValue,
      source: "MARKET",
      missing:
        marketValue != null
          ? null
          : beta == null && marketReturn == null
            ? "no beta and no market return for this window"
            : beta == null
              ? "no beta for this instrument yet"
              : "no market return for this window",
    },
    {
      key: "STOCK",
      label: hasMarket ? "the stock itself" : "the stock itself, market not separated out",
      value: stockValue,
      source: "STOCK",
      missing: stockMissing,
    },
    {
      key: "INTERACTION",
      label: "the move, scaled by the split",
      value: interactionValue,
      source: "MECHANICAL",
      missing: interactionValue == null ? "no adjusted return to scale" : null,
    },
  ];

  // A null MARKET is not a zero contribution and is not treated as one: when
  // it is null, STOCK already carries the whole of `adjusted`, so there is no
  // market term left to add and skipping it is what makes the sum close. The
  // parts that genuinely cannot be computed refuse the sum outright.
  const reconstructed =
    dividendValue != null && stockValue != null && interactionValue != null
      ? unsignZero(
          splitValue + dividendValue + (marketValue ?? 0) + stockValue + interactionValue,
        )
      : null;

  return {
    raw: dec.raw,
    adjusted,
    parts,
    reconstructed,
    closureError: dec.raw != null && reconstructed != null ? dec.raw - reconstructed : null,
    marketAttributed: hasMarket,
  };
}
