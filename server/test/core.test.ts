import { describe, it, expect } from "vitest";
import { toPaise, ret, formatPct, formatPaise } from "../src/core/money.js";
import { ewmaVol, betaAndResidualVol, toReturns, stdev, scaleVol } from "../src/core/stats.js";
import {
  sessionAt,
  sessionsBetween,
  istAt,
  istDate,
  isTradingDay,
  lastRegularClose,
  detectUnexpectedlyQuiet,
} from "../src/core/calendar.js";
import {
  splitFactor,
  dividendPerCurrentShare,
  decomposeReturn,
  backAdjustCloses,
  NO_ACTIONS,
  type CorporateActions,
  type Split,
  type Dividend,
} from "../src/core/corporate.js";
import { attribute, type Attribution, type PartKey } from "../src/core/attribution.js";
import { assess, DEFAULT_CIRCUIT_BAND, SANITY_BAND } from "../src/core/quality.js";
import { narrate, pickMode, describeAbsence, buildDigest } from "../src/core/digest.js";

// ---------------------------------------------------------------- money ----

describe("money", () => {
  it("stores prices as integer paise", () => {
    expect(toPaise(1328.0)).toBe(132800);
    expect(toPaise(2456.35)).toBe(245635);
  });

  it("rejects values that are not prices instead of propagating them", () => {
    expect(toPaise(NaN)).toBeNull();
    expect(toPaise(Infinity)).toBeNull();
    expect(toPaise(-5)).toBeNull();
    expect(toPaise(null)).toBeNull();
  });

  it("survives the accumulation that breaks float thresholds", () => {
    // 0.1 + 0.2 !== 0.3 in float. In paise it is exact, which matters because
    // every threshold in this system is a comparison.
    let acc = 0;
    for (let i = 0; i < 1000; i++) acc += toPaise(0.1)!;
    expect(acc).toBe(100_00);
  });

  it("returns null rather than Infinity on a zero base", () => {
    expect(ret(0, 100)).toBeNull();
    expect(ret(null, 100)).toBeNull();
    expect(ret(100, 110)).toBeCloseTo(0.1, 10);
  });

  it("formats with Indian digit grouping", () => {
    expect(formatPaise(12345678)).toBe("1,23,456.78");
    expect(formatPct(0.0421)).toBe("+4.21%");
    expect(formatPct(-0.0421)).toBe("-4.21%");
  });
});

// ---------------------------------------------------------------- stats ----

describe("stats", () => {
  it("refuses to produce a volatility from thin data", () => {
    expect(ewmaVol([0.01, -0.02, 0.005], 20, 30)).toBeNull();
  });

  it("weights recent observations more than old ones", () => {
    const calm = new Array(120).fill(0.001);
    const recentShock = [...calm, 0.08, -0.07, 0.09];
    const a = ewmaVol(calm, 20)!;
    const b = ewmaVol(recentShock, 20)!;
    expect(b).toBeGreaterThan(a * 3);

    // The same shock, long ago, must matter much less.
    const oldShock = [0.08, -0.07, 0.09, ...calm];
    expect(ewmaVol(oldShock, 20)!).toBeLessThan(b);
  });

  it("recovers a known beta and separates idiosyncratic movement", () => {
    const market: number[] = [];
    const asset: number[] = [];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);
    for (let i = 0; i < 400; i++) {
      const m = rnd() * 0.02;
      market.push(m);
      asset.push(1.5 * m + rnd() * 0.004); // beta 1.5 plus small private noise
    }
    const r = betaAndResidualVol(asset, market)!;
    expect(r.beta).toBeGreaterThan(1.35);
    expect(r.beta).toBeLessThan(1.65);
    // Residual vol must be far below the asset's total vol: that gap is exactly
    // the noise reduction the market adjustment buys us.
    expect(r.residualVol).toBeLessThan(stdev(asset)! * 0.5);
  });

  it("returns null when there is not enough paired history for a beta", () => {
    expect(betaAndResidualVol([0.01, 0.02], [0.01, 0.02])).toBeNull();
  });

  it("scales daily volatility by root-time", () => {
    expect(scaleVol(0.02, 4)).toBeCloseTo(0.04, 10);
  });

  it("drops non-finite gaps when converting prices to returns", () => {
    expect(toReturns([100, null, 110, 121])).toEqual([0.1]);
  });
});

// -------------------------------------------------------------- calendar ----

describe("NSE calendar", () => {
  const on = (d: string, hhmm: string) =>
    istAt(d, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

  it("classifies the sessions of a normal trading day", () => {
    // 2026-09-08 is a Tuesday.
    expect(sessionAt(on("2026-09-08", "08:30")).session).toBe("CLOSED");
    expect(sessionAt(on("2026-09-08", "09:05")).session).toBe("PRE_OPEN");
    expect(sessionAt(on("2026-09-08", "11:00")).session).toBe("REGULAR");
    expect(sessionAt(on("2026-09-08", "15:45")).session).toBe("POST_CLOSE");
    expect(sessionAt(on("2026-09-08", "20:00")).session).toBe("CLOSED");
  });

  it("treats only the continuous session as live", () => {
    expect(sessionAt(on("2026-09-08", "09:05")).isLive).toBe(false);
    expect(sessionAt(on("2026-09-08", "11:00")).isLive).toBe(true);
  });

  it("knows weekends and holidays are not trading days", () => {
    expect(isTradingDay(on("2026-09-05", "11:00"))).toBe(false); // Saturday
    expect(isTradingDay(on("2026-09-06", "11:00"))).toBe(false); // Sunday
    expect(isTradingDay(on("2026-08-15", "11:00"))).toBe(false); // Independence Day
    expect(isTradingDay(on("2026-09-08", "11:00"))).toBe(true);
  });

  it("counts zero sessions across a weekend, however many hours elapsed", () => {
    // Friday 16:00 -> Monday 09:00 is 65 wall-clock hours and zero sessions.
    // Telling a user "you were away 3 days" here would be true and misleading.
    const fri = on("2026-09-04", "16:00");
    const mon = on("2026-09-07", "09:00");
    expect(mon - fri).toBeGreaterThan(64 * 3600_000);
    expect(sessionsBetween(fri, mon)).toBe(0);
  });

  it("counts a partial session as a fraction", () => {
    const open = on("2026-09-08", "09:15");
    const mid = on("2026-09-08", "12:22"); // ~half of the 375-minute session
    const s = sessionsBetween(open, mid);
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(0.6);
  });

  it("walks back over a weekend to find the real last close", () => {
    const sun = on("2026-09-06", "10:00");
    expect(istDate(lastRegularClose(sun))).toBe("2026-09-04");
  });

  it("stops claiming the market is live when the whole universe goes quiet", () => {
    const now = on("2026-09-08", "11:00");
    const state = sessionAt(now);
    expect(detectUnexpectedlyQuiet(state, now - 60_000, now)).toBe(false);
    expect(detectUnexpectedlyQuiet(state, now - 20 * 60_000, now)).toBe(true);
    expect(detectUnexpectedlyQuiet(state, null, now)).toBe(true);
    // ...but silence outside market hours is expected, not an incident.
    const night = on("2026-09-08", "23:00");
    expect(detectUnexpectedlyQuiet(sessionAt(night), null, night)).toBe(false);
  });
});

// ---------------------------------------------------- corporate actions ----

const DAY = 24 * 3600_000;

function withSplit(exDateTs: number, num: number, den: number): CorporateActions {
  return {
    symbol: "TEST",
    splits: [{ exDateTs, numerator: num, denominator: den, ratio: `${num}:${den}` }],
    dividends: [],
  };
}

describe("corporate actions", () => {
  const t0 = istAt("2026-01-01", 0);

  it("applies a split on the half-open interval, never twice", () => {
    const ca = withSplit(t0 + 5 * DAY, 10, 1);
    expect(splitFactor(ca, t0, t0 + 10 * DAY)).toBeCloseTo(0.1, 12);
    // Ex-date equal to the window start is already in the price at the start.
    expect(splitFactor(ca, t0 + 5 * DAY, t0 + 10 * DAY)).toBe(1);
    // Entirely before or after the window: no effect.
    expect(splitFactor(ca, t0 + 6 * DAY, t0 + 10 * DAY)).toBe(1);
  });

  it("turns a 10:1 split from a 90% crash into a flat position", () => {
    // The Nestle India case: 27,000 -> 2,700 overnight.
    const ca = withSplit(t0 + 1 * DAY, 10, 1);
    const d = decomposeReturn(toPaise(27000), t0, toPaise(2700), t0 + 2 * DAY, ca);
    expect(d.raw!).toBeCloseTo(-0.9, 3); // what a naive watchlist shows
    expect(d.adjusted!).toBeCloseTo(0, 6); // what actually happened
    expect(d.isArtifact).toBe(true);
    expect(d.explainedFraction).toBeGreaterThan(0.99);
  });

  it("still reports the real move inside a split window", () => {
    const ca = withSplit(t0 + 1 * DAY, 10, 1);
    // 10:1 split AND a genuine 5% gain: 27,000 -> 2,835.
    const d = decomposeReturn(toPaise(27000), t0, toPaise(2835), t0 + 2 * DAY, ca);
    expect(d.adjusted!).toBeCloseTo(0.05, 6);
    // Explained fraction is high, so the corporate-action card leads, but the
    // adjusted number carried on it is the true 5%.
    expect(d.actions[0]!.kind).toBe("SPLIT");
  });

  it("credits a dividend back to the holder", () => {
    const ca: CorporateActions = {
      symbol: "TEST",
      splits: [],
      dividends: [{ exDateTs: t0 + DAY, amount: toPaise(10)! }],
    };
    // Price fell exactly by the dividend: the holder is flat, not down.
    const d = decomposeReturn(toPaise(1000), t0, toPaise(990), t0 + 2 * DAY, ca);
    expect(d.raw!).toBeCloseTo(-0.01, 6);
    expect(d.adjusted!).toBeCloseTo(0, 6);
  });

  it("scales a dividend paid before a later split", () => {
    // Rs 10 per old share, then a 10:1 split, is Rs 1 per share as counted now.
    const ca: CorporateActions = {
      symbol: "TEST",
      splits: [{ exDateTs: t0 + 5 * DAY, numerator: 10, denominator: 1, ratio: "10:1" }],
      dividends: [{ exDateTs: t0 + DAY, amount: toPaise(10)! }],
    };
    expect(dividendPerCurrentShare(ca, t0, t0 + 10 * DAY)).toBe(toPaise(1));
  });

  it("does not label an ordinary move as a corporate-action artifact", () => {
    const d = decomposeReturn(toPaise(100), t0, toPaise(93), t0 + DAY, NO_ACTIONS("TEST"));
    expect(d.isArtifact).toBe(false);
    expect(d.adjusted!).toBeCloseTo(-0.07, 6);
  });

  it("back-adjusts a series so the split stops looking like a return", () => {
    const ts = [t0, t0 + DAY, t0 + 2 * DAY, t0 + 3 * DAY];
    const closes = [toPaise(27000), toPaise(27100), toPaise(2700), toPaise(2710)];
    const ca = withSplit(t0 + 2 * DAY, 10, 1);
    const adj = backAdjustCloses(closes, ts, ca);
    const rs = toReturns(adj);
    expect(Math.max(...rs.map(Math.abs))).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------- return attribution ----

/**
 * How far the five parts are allowed to miss the tape. Not "close enough for
 * display": the identity is algebraic, so anything above float noise means a
 * part is wrong, and a wrong part is a card that names the wrong cause.
 */
const CLOSURE = 1e-12;

describe("return attribution", () => {
  const t0 = istAt("2026-01-01", 0);

  const sp = (days: number, num: number, den: number): Split => ({
    exDateTs: t0 + days * DAY,
    numerator: num,
    denominator: den,
    ratio: `${num}:${den}`,
  });
  const dvRs = (days: number, rupees: number): Dividend => ({
    exDateTs: t0 + days * DAY,
    amount: toPaise(rupees)!,
  });
  const acts = (splits: Split[], dividends: Dividend[]): CorporateActions => ({
    symbol: "TEST",
    splits,
    dividends,
  });

  /**
   * The shape of the call detect.ts makes on its corporate-action card, so
   * these exercise that wiring rather than a convenient one. The residual line
   * is copied from detect.ts verbatim: it is measured against the same beta and
   * market return that attribute() is then handed, which is the precondition
   * the closure depends on.
   *
   * It is a copy and not the thing itself, which is worth saying plainly: what
   * detect.ts actually does is pinned by "prints the five parts on the
   * corporate-action card" in server/test/regressions.test.ts. This helper
   * would go on passing if that call were deleted tomorrow.
   */
  function attributed(
    fromPaise: number | null,
    toPaise_: number | null,
    ca: CorporateActions,
    days: number,
    beta: number | null = null,
    marketReturn: number | null = null,
  ): Attribution {
    const dec = decomposeReturn(fromPaise, t0, toPaise_, t0 + days * DAY, ca);
    const residual =
      beta != null && marketReturn != null && dec.adjusted != null
        ? dec.adjusted - beta * marketReturn
        : null;
    return attribute({ decomposition: dec, beta, marketReturn, residual });
  }

  const part = (a: Attribution, key: PartKey) => a.parts.find((p) => p.key === key)!;

  it("reconstructs the quoted move from its five parts on every shape of action", () => {
    const R = toPaise;
    const cases: Array<[string, Attribution]> = [
      ["dividend only", attributed(R(1000), R(990), acts([], [dvRs(1, 10)]), 2, 1.1, 0.004)],
      ["split only", attributed(R(27000), R(2700), acts([sp(1, 10, 1)], []), 2, 0.9, -0.006)],
      [
        "dividend before the split",
        attributed(R(27000), R(2800), acts([sp(5, 10, 1)], [dvRs(1, 10)]), 10, 1.3, 0.011),
      ],
      [
        "dividend after the split",
        attributed(R(27000), R(2750), acts([sp(1, 10, 1)], [dvRs(5, 2)]), 10, 1.3, 0.011),
      ],
      [
        "two splits in one window",
        attributed(R(27000), R(1400), acts([sp(2, 10, 1), sp(6, 2, 1)], []), 10, 0.75, 0.02),
      ],
      [
        "a reverse split, which moves the factor the other way",
        attributed(R(50), R(505), acts([sp(3, 1, 10)], []), 6, 1.0, 0.003),
      ],
      ["no action at all", attributed(R(100), R(107), NO_ACTIONS("TEST"), 1, 1.05, 0.012)],
      ["a negative move", attributed(R(2456.35), R(2201.1), NO_ACTIONS("TEST"), 4, 1.2, -0.018)],
      ["a move of exactly zero", attributed(R(1000), R(1000), NO_ACTIONS("TEST"), 3, 1.1, 0.0)],
      [
        "a move of exactly zero underneath a split",
        // 27,000 -> 2,700 on a 10:1 is zero for the holder and -90% on the tape.
        attributed(R(27000), R(2700), acts([sp(1, 10, 1)], []), 2, 1.0, 0.0),
      ],
      [
        "everything at once",
        attributed(
          R(27000),
          R(1385.5),
          acts([sp(2, 10, 1), sp(6, 2, 1)], [dvRs(1, 15), dvRs(8, 1.25)]),
          10,
          1.42,
          -0.0075,
        ),
      ],
    ];

    for (const [name, a] of cases) {
      expect(a.raw, name).not.toBeNull();
      expect(a.reconstructed, name).not.toBeNull();
      expect(Math.abs(a.closureError!), name).toBeLessThan(CLOSURE);
      // Every part is present and measured, not merely absent-and-summing.
      for (const p of a.parts) expect(p.value, `${name}/${p.key}`).not.toBeNull();
    }
  });

  it("prints the interaction term rather than folding it into the stock", () => {
    // A constructed 10:1 on round numbers — 27,000 -> 2,743.20, a genuine
    // +1.6% for the holder — chosen so every quantity below is legible by
    // hand. It is NOT Nestle: it used to be labelled as Nestle's arithmetic,
    // and the closing price was reverse-engineered to produce the +1.6% and
    // -1.44% the module header asserted, so the suite endorsed those numbers
    // instead of checking them. What Nestle's 10:1 actually did is measured
    // from the recording in golden.test.ts, and the header now quotes that.
    const a = attributed(toPaise(27000), toPaise(2743.2), acts([sp(1, 10, 1)], []), 2);
    expect(a.adjusted!).toBeCloseTo(0.016, 12);
    expect(a.raw!).toBeCloseTo(-0.8984, 12);

    expect(part(a, "SPLIT").value!).toBeCloseTo(-0.9, 12);
    expect(part(a, "STOCK").value!).toBeCloseTo(0.016, 12);
    expect(part(a, "INTERACTION").value!).toBeCloseTo(-0.0144, 12);
    expect(part(a, "INTERACTION").source).toBe("MECHANICAL");

    // The subtraction a user does in their head, and why it disagrees: without
    // the interaction term the parts land 1.44% away from the tape.
    const folded = part(a, "SPLIT").value! + part(a, "STOCK").value!;
    expect(folded).toBeCloseTo(-0.884, 12);
    expect(Math.abs(folded - a.raw!)).toBeCloseTo(0.0144, 12);

    // With it, they land on the tape.
    expect(Math.abs(a.closureError!)).toBeLessThan(CLOSURE);
  });

  it("still closes when the prices are the integer paise the boundary delivers", () => {
    const R = toPaise;
    // Prices carried to the paise, ratios that are not exact in binary, and
    // dividends that dividendPerCurrentShare has to round. Each of these is a
    // place a second route to the same number would drift.
    const cases: Array<[string, Attribution]> = [
      ["3:2 split, sf is 0.666...", attributed(245635, 165742, acts([sp(2, 3, 2)], []), 5, 1.1, 0.007)],
      [
        "7:3 split with a dividend rounded across it",
        attributed(198877, 85433, acts([sp(4, 7, 3)], [dvRs(2, 3.33)]), 9, 0.88, -0.013),
      ],
      [
        "a one-paise stock",
        attributed(1, 1, acts([], [{ exDateTs: t0 + DAY, amount: 0 }]), 2, 1.0, 0.001),
      ],
      ["a one-paise move", attributed(245635, 245636, NO_ACTIONS("TEST"), 1, 1.4, 0.0004)],
      [
        "a dividend that is a third of a paise per current share",
        attributed(R(1234.56), R(1201.03), acts([sp(6, 3, 1)], [dvRs(1, 1)]), 8, 1.05, 0.002),
      ],
    ];
    for (const [name, a] of cases) {
      expect(a.reconstructed, name).not.toBeNull();
      expect(Math.abs(a.closureError!), name).toBeLessThan(CLOSURE);
    }
  });

  it("returns nulls for the parts it cannot compute, never zeros", () => {
    // No opening price. Two of the five parts survive it and three do not,
    // and which is which is the point: the split factor and beta*marketReturn
    // are facts about the feed and the tape, neither of which needs to know
    // what this stock opened at. Everything that divides by P0, or that reads
    // the adjusted return, is refused.
    const noPrice = attributed(null, toPaise(2700), acts([sp(1, 10, 1)], [dvRs(1, 5)]), 2, 1.1, 0.01);
    expect(noPrice.raw).toBeNull();
    expect(part(noPrice, "SPLIT").value!).toBeCloseTo(-0.9, 12);
    expect(part(noPrice, "MARKET").value!).toBeCloseTo(0.011, 12);
    for (const key of ["DIVIDEND", "STOCK", "INTERACTION"] as PartKey[]) {
      expect(part(noPrice, key).value, key).toBeNull();
      expect(part(noPrice, key).missing, key).toBeTruthy();
    }
    // Two knowable parts are not four fifths of an answer: with the rest
    // missing there is nothing to reconstruct and no error to report.
    expect(noPrice.reconstructed).toBeNull();
    expect(noPrice.closureError).toBeNull();

    // A zero opening price is a division we refuse, not one we do.
    expect(part(attributed(0, toPaise(100), NO_ACTIONS("TEST"), 1), "DIVIDEND").value).toBeNull();

    // No closing price either: no throw, and nothing invented.
    const noClose = attributed(toPaise(100), null, NO_ACTIONS("TEST"), 1, 1.1, 0.01);
    expect(noClose.raw).toBeNull();
    expect(noClose.reconstructed).toBeNull();
  });

  it("gives the whole adjusted move to the stock when there is no market to subtract", () => {
    const ca = NO_ACTIONS("TEST");
    for (const [beta, mkt] of [
      [null, null],
      [null, 0.01],
      [1.2, null],
    ] as Array<[number | null, number | null]>) {
      const a = attributed(toPaise(100), toPaise(107), ca, 1, beta, mkt);
      expect(a.marketAttributed).toBe(false);
      expect(part(a, "MARKET").value).toBeNull();
      expect(part(a, "MARKET").missing).toBeTruthy();
      // Labelled as unseparated, so a reader is never told the market did
      // nothing when the truth is that we could not look.
      expect(part(a, "STOCK").label).toMatch(/not separated/);
      expect(part(a, "STOCK").value!).toBeCloseTo(a.adjusted!, 12);
      expect(Math.abs(a.closureError!)).toBeLessThan(CLOSURE);
    }

    // And with a market, the two do separate — and still sum to `adjusted`.
    const withMkt = attributed(toPaise(100), toPaise(107), ca, 1, 1.2, 0.01);
    expect(withMkt.marketAttributed).toBe(true);
    expect(part(withMkt, "MARKET").value!).toBeCloseTo(0.012, 12);
    expect(part(withMkt, "MARKET").value! + part(withMkt, "STOCK").value!).toBeCloseTo(
      withMkt.adjusted!,
      12,
    );
  });

  it("prints the residual it was handed rather than one of its own, and lets the gap show", () => {
    // Every other case in this file is blind to this. The `attributed` helper
    // builds the residual as `dec.adjusted - beta*marketReturn`, which is
    // bit-identical to the fallback attribute() used to apply when none
    // arrived, so deleting the pass-through was invisible to the whole suite.
    // Here the caller's residual is deliberately a shade off the recomputation
    // — the shade a differently-measured number would be — and the module must
    // carry it through and report the shortfall instead of papering over it.
    const dec = decomposeReturn(
      toPaise(27000),
      t0,
      toPaise(2743.2),
      t0 + 2 * DAY,
      acts([sp(1, 10, 1)], []),
    );
    const beta = 1.1;
    const marketReturn = 0.004;
    const offset = 1e-6;
    const handed = dec.adjusted! - beta * marketReturn + offset;
    const a = attribute({
      decomposition: dec,
      beta,
      marketReturn,
      residual: handed,
    });

    // Verbatim, to the bit — not merely close to it.
    expect(part(a, "STOCK").value).toBe(handed);
    expect(part(a, "STOCK").value).not.toBe(dec.adjusted! - beta * marketReturn);
    // The parts now overshoot the tape by exactly the offset, so the error the
    // module publishes is the offset, negated. Reported, never absorbed.
    expect(Math.abs(a.closureError! + offset)).toBeLessThan(CLOSURE);
  });

  it("refuses the stock's row when a beta arrives without the residual measured against it", () => {
    // Reachable from detect.ts's own wiring: its `hasMarket` also requires
    // baseline.residualVol, so beta and marketReturn can both be present while
    // the residual beside them is null. Recomputing one here would be a second
    // measurement wearing the first one's label.
    const dec = decomposeReturn(toPaise(100), t0, toPaise(107), t0 + DAY, NO_ACTIONS("TEST"));
    const a = attribute({
      decomposition: dec,
      beta: 1.2,
      marketReturn: 0.01,
      residual: null,
    });

    // What was measured survives; only the row that needs the missing number
    // is refused, and it says which number.
    expect(a.marketAttributed).toBe(true);
    expect(part(a, "MARKET").value!).toBeCloseTo(0.012, 12);
    expect(part(a, "SPLIT").value!).toBe(0);
    expect(part(a, "STOCK").value).toBeNull();
    expect(part(a, "STOCK").missing).toMatch(/residual/);
    // Four fifths of an identity is not an identity: nothing to reconstruct,
    // and so no closure error to quote either.
    expect(a.reconstructed).toBeNull();
    expect(a.closureError).toBeNull();
  });

  it("takes the dividend's base off the decomposition, so there is no second price to get wrong", () => {
    // attribute() used to accept the opening price as its own parameter, with
    // a doc comment asking for the unrestated one and nothing able to check
    // that it got it. The base is carried on ReturnDecomposition now, beside
    // the split factor and the dividend, for the reason corporate.ts gives:
    // one route, so a caller cannot supply a second.
    const ca = acts([sp(1, 10, 1)], [dvRs(1, 20)]);
    const dec = decomposeReturn(toPaise(27000), t0, toPaise(2700), t0 + 2 * DAY, ca);

    // The price as quoted, not the price restated into post-split shares. On
    // this window those differ by the factor of ten that the whole discipline
    // exists to prevent.
    expect(dec.fromPriceUsed).toBe(toPaise(27000));
    expect(dec.fromPriceUsed).not.toBe(toPaise(27000)! * dec.splitFactorApplied);

    const a = attribute({ decomposition: dec, beta: null, marketReturn: null, residual: null });
    // Bit-identical to the division corporate.ts itself does in `priceImpact`,
    // not merely close to it.
    expect(part(a, "DIVIDEND").value).toBe(-dec.dividendPerShare / toPaise(27000)!);
    expect(Math.abs(a.closureError!)).toBeLessThan(CLOSURE);

    // Knowable without a closing price: the window refuses the return and
    // still carries the base, because what the dividend is divided by does not
    // depend on how the window ended.
    const noClose = decomposeReturn(toPaise(27000), t0, null, t0 + 2 * DAY, ca);
    expect(noClose.adjusted).toBeNull();
    expect(noClose.fromPriceUsed).toBe(toPaise(27000));

    // And a price nobody may divide by is null rather than zero-or-worse, on
    // both branches, so the DIVIDEND row is refused with a reason instead of
    // returning Infinity.
    for (const bad of [null, 0, -1]) {
      const d = decomposeReturn(bad, t0, toPaise(2700), t0 + 2 * DAY, ca);
      expect(d.fromPriceUsed, String(bad)).toBeNull();
      const at = attribute({ decomposition: d, beta: null, marketReturn: null, residual: null });
      expect(part(at, "DIVIDEND").value, String(bad)).toBeNull();
      expect(part(at, "DIVIDEND").missing, String(bad)).toBeTruthy();
    }
  });

  it("closes on three hundred pseudo-random windows, not only the ones I thought of", () => {
    // MINSTD, seeded and written out here because Math.random is banned in
    // this repo's pure code and a property test that cannot be re-run on the
    // case that failed is not evidence of anything. The multiply stays under
    // 2^53, so the recurrence is exact rather than merely reproducible.
    let seed = 20240105; // Nestle's ex-date, chosen only to be a fixed number
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;

    const ratios: Array<[number, number]> = [
      [10, 1], [5, 1], [2, 1], [3, 2], [7, 3], [1, 2], [1, 5],
    ];

    let worst = 0;
    let worstCase = "";
    let closed = 0;
    for (let i = 0; i < 300; i++) {
      const p0 = Math.max(1, Math.round((5 + rnd() * 29_995) * 100)); // Rs 5 .. 30,000
      const splits: Split[] = [];
      if (rnd() < 0.45) {
        const [n, d] = pick(ratios);
        splits.push(sp(1 + Math.floor(rnd() * 20), n, d));
      }
      if (rnd() < 0.12) {
        const [n, d] = pick(ratios);
        splits.push(sp(1 + Math.floor(rnd() * 20), n, d));
      }
      const dividends: Dividend[] = [];
      if (rnd() < 0.5) {
        dividends.push({
          exDateTs: t0 + (1 + Math.floor(rnd() * 20)) * DAY,
          amount: Math.round(p0 * (0.001 + rnd() * 0.03)),
        });
      }
      const ca = acts(splits, dividends);

      const sf = splitFactor(ca, t0, t0 + 21 * DAY);
      const move = rnd() * 0.5 - 0.25; // +/- 25% for the holder
      const p1 = Math.max(1, Math.round(p0 * sf * (1 + move)));

      const beta = rnd() < 0.7 ? 0.3 + rnd() * 1.6 : null;
      const mkt = rnd() < 0.8 ? rnd() * 0.06 - 0.03 : null;

      const a = attributed(p0, p1, ca, 21, beta, mkt);
      expect(a.reconstructed).not.toBeNull();
      const err = Math.abs(a.closureError!);
      closed++;
      if (err > worst) {
        worst = err;
        worstCase = `p0=${p0} p1=${p1} sf=${sf} splits=${splits.length} divs=${dividends.length}`;
      }
    }

    expect(closed).toBe(300);
    // Reported, not just asserted: if this ever trips, the worst case is
    // printed with the inputs needed to reproduce it.
    expect(worst, `worst closure error at ${worstCase}`).toBeLessThan(CLOSURE);
  });
});

// -------------------------------------------------------------- quality ----

describe("quote quality", () => {
  const openNow = istAt("2026-09-08", 11 * 60);
  const session = sessionAt(openNow);
  const base = {
    now: openNow,
    session,
    cadenceMs: 30_000,
    universeFreshestTs: openNow - 5_000,
    circuitBand: DEFAULT_CIRCUIT_BAND,
  };
  const q = (over: Partial<Parameters<typeof assess>[0]> = {}) => ({
    symbol: "TEST",
    ltp: toPaise(100),
    prevClose: toPaise(100),
    exchangeTs: openNow - 5_000,
    ingestTs: openNow,
    ...over,
  });

  it("is LIVE inside the provider cadence", () => {
    expect(assess(q(), base).quality).toBe("LIVE");
  });

  it("separates a thin stock from a broken feed", () => {
    const old = { exchangeTs: openNow - 25 * 60_000 };
    // Everything else is printing: this stock is simply illiquid.
    expect(assess(q(old), base).quality).toBe("ILLIQUID");
    // Nothing is printing: the feed is the problem, and we stop trusting it.
    const dead = { ...base, universeFreshestTs: openNow - 25 * 60_000 };
    const a = assess(q(old), dead);
    expect(a.quality).toBe("STALE");
    expect(a.usableForSignals).toBe(false);
  });

  it("treats an old price as correct when the market is shut", () => {
    const sun = istAt("2026-09-06", 10 * 60);
    const a = assess(q({ exchangeTs: sun - 40 * 3600_000 }), {
      ...base,
      now: sun,
      session: sessionAt(sun),
      universeFreshestTs: null,
    });
    expect(a.quality).toBe("CLOSED");
    expect(a.displayable).toBe(true);
    expect(a.usableForSignals).toBe(true);
  });

  it("refuses to score signals off a value it does not believe", () => {
    // The threshold itself is configurable; what matters is that a rejected
    // value is never shown and never reaches detection.
    const a = assess(q({ ltp: toPaise(140) }), base); // 40%, band here is 20%
    expect(a.quality).toBe("SUSPECT");
    expect(a.usableForSignals).toBe(false);
    expect(a.displayable).toBe(false);
  });

  it("rejects non-positive prices and future timestamps", () => {
    expect(assess(q({ ltp: 0 }), base).quality).toBe("SUSPECT");
    expect(assess(q({ ltp: toPaise(-1) }), base).quality).toBe("UNAVAILABLE");
    expect(assess(q({ exchangeTs: openNow + 5 * 60_000 }), base).quality).toBe("SUSPECT");
  });

  it("lets a corporate-action-sized move through to the detector", () => {
    // A 10:1 split prints at exactly a tenth of the previous close, and a real
    // demerger printed at -65%. Neither is corrupt, and calling them corrupt
    // costs the user the one explanation that would have helped. This layer
    // passes them on; detect() decides what they are.
    const production = { ...base, circuitBand: SANITY_BAND };
    expect(assess(q({ ltp: toPaise(10) }), production).quality).toBe("LIVE"); // 10:1 split
    expect(assess(q({ ltp: toPaise(35) }), production).quality).toBe("LIVE"); // demerger
    expect(assess(q({ ltp: toPaise(147) }), production).quality).toBe("LIVE"); // +47%
  });

  it("still rejects a magnitude that cannot be a price under any reading", () => {
    const production = { ...base, circuitBand: SANITY_BAND };
    // Paise reported where rupees were expected.
    const a = assess(q({ ltp: toPaise(8500) }), production);
    expect(a.quality).toBe("SUSPECT");
    expect(a.displayable).toBe(false);
    expect(a.reason).toMatch(/units or encoding/);
  });

  it("reports a missing symbol as unavailable, not as a zero price", () => {
    const a = assess(q({ ltp: null, exchangeTs: null }), base);
    expect(a.quality).toBe("UNAVAILABLE");
    expect(a.displayable).toBe(false);
  });
});


// --------------------------------------------------------------- digest ----

describe("narrative facts", () => {
  const t0 = istAt("2026-08-03", 9 * 60 + 15); // a Monday
  const day = (n: number) => t0 + n * 24 * 3600_000;

  it("finds the biggest session close to close, not within a date", () => {
    // The shape a long window actually has: one closing price per session.
    // Measuring inside each date would score every day at zero.
    const path = [
      { ts: day(0), price: toPaise(100)! },
      { ts: day(1), price: toPaise(102)! },
      { ts: day(2), price: toPaise(93)! }, // the day that mattered
      { ts: day(3), price: toPaise(95)! },
    ];
    const n = narrate(path);
    expect(n.biggestSession).not.toBeNull();
    expect(n.biggestSession!.ret).toBeCloseTo(-0.0882, 3);
    expect(n.biggestSession!.date).toBe("2026-08-05");
  });

  it("reports the drawdown a round trip hides", () => {
    // Ends where it started, having been down 12% in between. An endpoint diff
    // reports "nothing changed", which is true and useless.
    const path = [
      { ts: day(0), price: toPaise(100)! },
      { ts: day(1), price: toPaise(94)! },
      { ts: day(2), price: toPaise(88)! },
      { ts: day(3), price: toPaise(100)! },
    ];
    const n = narrate(path);
    expect(n.netReturn).toBeCloseTo(0, 6);
    expect(n.maxDrawdown!).toBeCloseTo(-0.12, 6);
    expect(n.roundTripped).toBe(true);
  });

  it("says nothing rather than guessing from a single point", () => {
    expect(narrate([{ ts: day(0), price: toPaise(100)! }]).netReturn).toBeNull();
    expect(narrate([]).biggestSession).toBeNull();
  });

  it("chooses the answer shape from sessions, not from elapsed days", () => {
    expect(pickMode(0.4)).toBe("GLANCE");
    expect(pickMode(2)).toBe("SESSION");
    expect(pickMode(6)).toBe("NARRATIVE");
    // A weekend is three days and zero sessions: it must not become a summary.
    const fri = istAt("2026-09-04", 16 * 60);
    const mon = istAt("2026-09-07", 9 * 60);
    expect(pickMode(sessionsBetween(fri, mon))).toBe("GLANCE");
  });

  it("does not claim news on a first visit", () => {
    const absence = describeAbsence(t0, day(5), true);
    const d = buildDigest({
      now: day(5),
      absence,
      cards: [],
      suppressed: [],
      market: null,
      coverage: { symbolsWatched: 8, evaluated: 8, degraded: 0, unavailable: 0 },
    });
    expect(d.headline).toMatch(/baseline/i);
    expect(d.cards).toHaveLength(0);
  });

  it("states plainly when nothing happened", () => {
    const d = buildDigest({
      now: day(5),
      absence: describeAbsence(t0, day(5), false),
      cards: [],
      suppressed: [],
      market: null,
      coverage: { symbolsWatched: 14, evaluated: 14, degraded: 0, unavailable: 0 },
    });
    expect(d.headline).toMatch(/Nothing meaningful/);
    expect(d.subhead).toMatch(/14 symbols checked/);
  });
});
