/**
 * Golden tests: corporate-action handling checked against five years of real
 * recorded NSE history rather than against fixtures we invented.
 *
 * These earned their keep on the first run. They caught that this system was
 * double-adjusting for splits: Yahoo's chart endpoint already back-adjusts
 * `close`, and applying our own adjustment on top fabricated a -90% return on
 * Nestle India's split date, which inflated its volatility estimate by more
 * than twenty times. Nothing threw. The symbol would simply have stopped
 * producing signals, for months, and no synthetic test would have noticed.
 *
 * The dataset holds twelve genuine splits across eleven symbols, including
 * Nestle India's 10:1 in January 2024 and a second 2:1 in August 2025 -- which
 * is why the count is one higher than the number of names. It read "eleven
 * splits" until the sweep below started counting them and the two numbers
 * disagreed.
 *
 * If the recorded data is absent (a fresh clone that has not run the fetcher),
 * these skip rather than fail: a missing dataset is a setup state, not a defect.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadHistoryDir } from "../src/data/history.js";
import {
  backAdjustCloses,
  decomposeReturn,
  dividendPerCurrentShare,
  splitFactor,
} from "../src/core/corporate.js";
import { PriceOracle } from "../src/data/oracle.js";
import { attribute, type PartKey } from "../src/core/attribution.js";
import { toReturns, stdev } from "../src/core/stats.js";
import { computeBaseline } from "../src/core/baseline.js";
import { toRupees, type Paise } from "../src/core/money.js";
import { detect, PRESETS, STRUCTURAL_ABS } from "../src/core/detect.js";
import { sessionAt } from "../src/core/calendar.js";
import { assess, DEFAULT_CIRCUIT_BAND, SANITY_BAND } from "../src/core/quality.js";

const DIR = join(process.cwd(), "..", "data", "history");
const HAVE = existsSync(DIR);
const d = HAVE ? describe : describe.skip;

/** NSE's most permissive scrip-level price band. */
const CIRCUIT = 0.2;

d("recorded NSE history", () => {
  const all = loadHistoryDir(DIR);

  it("loaded the recorded universe", () => {
    expect(all.size).toBeGreaterThan(40);
    expect(all.has("^NSEI")).toBe(true);
  });

  it("found real corporate actions to test against", () => {
    const withSplits = [...all.values()].filter((h) => h.actions.splits.length > 0);
    expect(withSplits.length).toBeGreaterThanOrEqual(8);
  });

  /**
   * The regression guard. If the provider ever changes what `close` means, this
   * fails loudly on the next run instead of silently corrupting every
   * volatility estimate in the system.
   */
  it("the provider's declared adjustment matches what the data actually shows", () => {
    const disagreements: string[] = [];
    for (const h of all.values()) {
      if (h.observedAdjustment === "UNKNOWN") continue; // no split to test against
      if (h.observedAdjustment !== h.closeAdjustment) {
        disagreements.push(`${h.symbol}: declared ${h.closeAdjustment}, observed ${h.observedAdjustment}`);
      }
    }
    expect(disagreements).toEqual([]);
    // And the check must actually be exercising something.
    const tested = [...all.values()].filter((h) => h.observedAdjustment !== "UNKNOWN");
    expect(tested.length).toBeGreaterThanOrEqual(8);
  });

  it("contains real single-session moves no fixed circuit band would allow", () => {
    // Worth stating plainly, because it is the assumption most naive
    // implementations make and it is false. Stocks in the F&O segment have no
    // fixed price band, and this dataset holds several genuine moves past 20%:
    // Adani Enterprises during the January 2023 short-seller report, and Adani
    // Ports on the June 2024 election result.
    const extremes = new Map<string, number>();
    for (const h of all.values()) {
      if (h.symbol.startsWith("^")) continue;
      const rs = toReturns(h.bars.map((b) => b.close));
      if (rs.length === 0) continue;
      const worst = Math.max(...rs.map(Math.abs));
      if (worst > 0.2) extremes.set(h.symbol, worst);
    }
    expect(extremes.has("ADANIENT")).toBe(true);
    expect(extremes.get("ADANIENT")!).toBeGreaterThan(0.25);
    // ...and none of them is a split we failed to apply.
    for (const sym of extremes.keys()) {
      const worstIsSplit = all.get(sym)!.actions.splits.length > 0;
      expect(worstIsSplit, sym + " extreme move should not come from a split").toBe(false);
    }
  });

  it("proves the corporate-action feed is incomplete", () => {
    // Vedanta fell 65% in one session on its demerger. The provider reports no
    // split and no dividend for that date. This is the case that justifies
    // having a statistical guard at all: a feed-only defence cannot see it.
    const h = all.get("VEDL")!;
    const rs = toReturns(h.bars.map((b) => b.close));
    const worst = Math.min(...rs);
    expect(worst).toBeLessThan(-0.6);
    expect(h.actions.splits.length).toBe(0);
  });

  it("demonstrates the damage a wrong adjustment assumption does", () => {
    // Treating this already-adjusted series as raw is the mistake this codebase
    // originally made. Reproduced here so the cost stays visible.
    const h = all.get("NESTLEIND")!;
    const ts = h.bars.map((b) => b.ts);
    const doubled = backAdjustCloses(h.bars.map((b) => b.close), ts, h.actions);

    const correctVol = stdev(toReturns(h.bars.map((b) => b.close)))!;
    const corruptedVol = stdev(toReturns(doubled))!;

    expect(Math.max(...toReturns(doubled).map(Math.abs))).toBeGreaterThan(0.85);
    expect(corruptedVol).toBeGreaterThan(correctVol * 10);
  });

  it("carries Nestle India's 10:1 split as an event, not as a price crash", () => {
    const h = all.get("NESTLEIND");
    expect(h, "NESTLEIND history missing").toBeDefined();

    const tenForOne = h!.actions.splits.find((s) => s.numerator === 10);
    expect(tenForOne, "expected a 10:1 split in the recorded events").toBeDefined();

    const ex = tenForOne!.exDateTs;
    const before = [...h!.bars].reverse().find((b) => b.ts < ex && b.close != null)!;
    const after = h!.bars.find((b) => b.ts >= ex && b.close != null)!;

    // The split is knowable from the events feed...
    expect(tenForOne!.ratio).toBe("10:1");
    // ...but is not visible as a return, because the series is adjusted.
    const across = (after.close! - before.close!) / before.close!;
    expect(Math.abs(across)).toBeLessThan(0.1);
  });

  it("separates split adjustment from dividend adjustment", () => {
    // adjclose removes dividends as well as splits, so the ratio between them
    // is a pure dividend factor: flat across a split date, stepping only on
    // ex-dividend dates. This is what proves `close` is split-adjusted only.
    const h = all.get("NESTLEIND")!;
    const ex = h.actions.splits.find((s) => s.numerator === 10)!.exDateTs;
    const idx = h.bars.findIndex((b) => b.ts >= ex && b.close != null && b.adjClose != null);
    const ratioAt = (i: number) => h.bars[i]!.adjClose! / h.bars[i]!.close!;
    expect(ratioAt(idx)).toBeCloseTo(ratioAt(idx - 1), 3);
    // ...and by the end of the series every dividend has been passed, so the
    // two converge.
    const last = h.bars.length - 1;
    expect(ratioAt(last)).toBeCloseTo(1, 3);
  });

  it("prints the five parts of Nestle India's 10:1, measured rather than asserted", () => {
    // This is the case attribution.ts's header describes, and the header used
    // to describe it from memory: -89.84% on the tape, +1.6% for the holder,
    // a -1.44% interaction term. All three were invented, and the sign of the
    // holder's return was inverted — Nestle *fell* that session. The only
    // test that claimed to pin them built the pair by hand from a closing
    // price reverse-engineered to agree with them, so the suite endorsed the
    // invention. These numbers now come out of the recording on every run.
    const h = all.get("NESTLEIND")!;
    const ex = h.actions.splits.find((s) => s.numerator === 10)!.exDateTs;
    const before = [...h.bars].reverse().find((b) => b.ts < ex && b.close != null)!;
    const after = h.bars.find((b) => b.ts >= ex && b.close != null)!;

    // The recorded closes are split-adjusted to the end of the series, so both
    // bars are also carrying the later 2:1 from August 2025. Undoing every
    // split at or after a bar recovers what the tape actually printed that
    // morning, which is the only series a user's memory can be checked
    // against. Both bars precede the 2:1, so it scales both by the same half
    // and cancels out of every return below; it is undone anyway, because the
    // decomposition is handed real quoted prices or it is testing nothing.
    const endTs = h.bars[h.bars.length - 1]!.ts;
    const quoted = (ts: number, close: Paise) =>
      Math.round(close / splitFactor(h.actions, ts, endTs));
    const P0 = quoted(before.ts, before.close!);
    const P1 = quoted(after.ts, after.close!);
    expect(toRupees(P0)).toBeCloseTo(27116.4, 1);
    expect(toRupees(P1)).toBeCloseTo(2666.4, 1);

    const dec = decomposeReturn(P0, before.ts, P1, after.ts, h.actions);
    // No beta and no market return on purpose: this pins the three mechanical
    // numbers the header quotes, and a baseline fitted here would put a fourth
    // moving part between the recording and the assertion. The whole adjusted
    // move therefore sits on STOCK, labelled as unseparated.
    const a = attribute({
      decomposition: dec,
      beta: null,
      marketReturn: null,
      residual: null,
    });
    const part = (key: PartKey) => a.parts.find((p) => p.key === key)!;

    // Nothing else in the window to muddy it: a pure 10:1, no cash dividend.
    expect(dec.splitFactorApplied).toBeCloseTo(0.1, 12);
    expect(dec.dividendPerShare).toBe(0);

    // The three numbers attribution.ts's header quotes, to the two decimals it
    // quotes them at.
    expect(dec.raw! * 100).toBeCloseTo(-90.17, 2);
    expect(dec.adjusted! * 100).toBeCloseTo(-1.67, 2);
    expect(part("INTERACTION").value! * 100).toBeCloseTo(1.5, 2);

    // The split row is the ratio and nothing else -- exactly, not to within a
    // tolerance. `toBe` rather than `toBeCloseTo` is the point: the row is
    // `denominator/numerator - 1` and this is that same expression, so any
    // difference at all means a second route to the split factor got in
    // somewhere. A tolerance here would let that route be wrong in the last
    // few bits and still pass.
    expect(part("SPLIT").value).toBe(1 / 10 - 1);
    expect(part("SPLIT").value).toBe(-0.9);

    // The interaction term is present, and is a measurement rather than a
    // null standing in for one -- on the one day in this recording where it
    // is not zero. Its magnitude is the whole reason the row exists.
    expect(part("INTERACTION").value).not.toBeNull();
    expect(Math.abs(part("INTERACTION").value!)).toBeGreaterThan(1e-3);

    // And the rebuild lands on the tape. 1e-12 is a floating-point tolerance,
    // not a modelling one: the identity is exact, so anything looser would be
    // hiding a real disagreement in the noise floor.
    expect(a.reconstructed).not.toBeNull();
    expect(Math.abs(a.reconstructed! - dec.raw!)).toBeLessThan(1e-12);

    // The term is positive while the holder's move is negative. That is the
    // half of it the invented version got backwards, and it is the half worth
    // seeing: a tenth of a loss is a smaller loss, so the correction runs
    // against the move rather than with it.
    expect(part("INTERACTION").value!).toBeGreaterThan(0);
    expect(dec.adjusted!).toBeLessThan(0);

    // And the subtraction a reader does in their head — split plus holder —
    // misses the tape by exactly that term.
    const folded = part("SPLIT").value! + part("STOCK").value!;
    expect(Math.abs(folded - dec.raw!) * 100).toBeCloseTo(1.5, 2);
    expect(Math.abs(a.closureError!)).toBeLessThan(1e-12);
  });

  it("still knows the pre-split price was a five-figure number", () => {
    // A detail worth keeping: the adjusted series is convenient for statistics
    // and wrong for anything a user remembers. Nestle traded near Rs 27,000
    // before the split, and a user who checked in December 2023 saw that.
    const h = all.get("NESTLEIND")!;
    const ex = h.actions.splits.find((s) => s.numerator === 10)!.exDateTs;
    const before = [...h.bars].reverse().find((b) => b.ts < ex && b.close != null)!;
    const trueQuotedPrice = toRupees(before.close!) * 10;
    expect(trueQuotedPrice).toBeGreaterThan(10_000);
  });
});

d("the five parts, swept over the whole recording", () => {
  const all = loadHistoryDir(DIR);
  const nifty = all.get("^NSEI")!;
  const ADJ = { closeAdjustment: "SPLIT_ADJUSTED" } as const;

  /**
   * The closure is an algebraic identity, so the interesting question is not
   * whether it holds on paper -- it does, and the derivation is in
   * attribution.ts's header -- but whether the code still computes the same
   * five quantities the derivation assumes, over inputs nobody chose.
   *
   * A fixture proves a point about a case its author already understood. The
   * two property tests in core.test.ts widen that to a grid and a few hundred
   * pseudo-random draws, which is better and is still a distribution someone
   * picked. This runs the real thing: every consecutive-close window in every
   * recorded history, with the real splits, the real dividends, the real
   * betas and the real index move over the same two dates. Whatever shapes
   * five years of NSE prices actually contain -- the ex-dates that land on a
   * gap, the prices that round to the same paise, the sessions the index did
   * not trade -- are in here whether or not anyone thought of them.
   *
   * One shape is not in here, and this paragraph used to claim it was: "the
   * dividend a day before a split". No window in this sweep carries both.
   * Measured over data/history, of the 62,093 windows below 12 span a split and
   * 363 a dividend, and no dividend ex-date in the whole recording falls within
   * ten days of any split ex-date -- so the count of windows carrying both is
   * zero, and the printed line agrees by never having a combined count to
   * print. That is the one case the two dividend bases differ in, and the case
   * `fromPriceUsed` exists to protect; the note on the dividend base in
   * attribution.ts is already honest about the sweep being blind to it. It is covered instead by "closes on
   * three hundred pseudo-random windows" in core.test.ts, which draws a split
   * in 45% of its windows and a dividend in 50%, independently, and so carries
   * the combination by construction. Widening these windows would not help: the
   * recording does not contain the shape at any window length.
   */
  it("reconstructs the quoted move to within 1e-12 in every window of every history", () => {
    // The index's own closes, by date, so a window's market return is the
    // index's real move across the same two sessions rather than a stand-in.
    const marketByTs = new Map<number, Paise>();
    for (const b of nifty.bars) if (b.close != null) marketByTs.set(b.ts, b.close);

    let windows = 0;
    let withSplit = 0;
    let withDividend = 0;
    let withMarket = 0;
    let refused = 0;
    let maxErr = 0;
    let worst = "none";

    /**
     * How often the workspace ledger's substituted stock row lands on a
     * different hundredth from the stock's own measurement.
     *
     * Counted here rather than argued about in a comment. The ledger in
     * web/src/workspace/Digest.tsx prints the stock's row as the displayed
     * tape move less the other displayed rows, so the column adds up exactly
     * as shown; the price of that is a row that can sit a hundredth off its
     * own value, and the audit panel under "Why this surfaced" exists to
     * answer for it. The docstring above `AttributionRows` quotes this count
     * and the sweep's window count in the same sentence, and an unpinned
     * number in a comment is how that docstring went wrong the first time.
     *
     * The two rounding rules are restated here rather than imported: this is
     * a server test and the client is not on its module path. That makes this
     * a second route to the same arithmetic, which is a real cost -- if the
     * client's formatter changes, this counter keeps reporting the old
     * behaviour under the old name. It is accepted because the alternative
     * was a figure nothing measured at all, and because what is asserted
     * below is only that the phenomenon happens, not how often.
     */
    let roundsDifferently = 0;
    const SCALE = 10_000;

    /**
     * And how often the audit panel's six-decimal column does not add to the
     * six-decimal total printed under it.
     *
     * The panel inside "Why this surfaced" prints each part as pct(v, 6) and
     * prints "the five rows add to" from the server's `reconstructed`, which
     * was summed before any of them was rounded. Five roundings against one
     * makes the last place disagree, exactly as it does two panels up at two
     * decimals -- the difference being that this one was headed "The five
     * parts, unrounded", which made a rounding into an over-claim. The heading
     * now says six decimals and the note under it says the column need not
     * reconcile; this counts how often that note earns its place. The
     * docstring above `AttributionExact` and the note it renders both quote
     * this count, for the reason the first version of that docstring did not:
     * it quoted a sweep of a running replay server, and those figures are true
     * of one boot.
     *
     * The rounding is modelled through `toFixed(6)` itself rather than through
     * Math.round, because it is the string on screen that is being counted and
     * the two disagree on exact ties. It carries the same cost the counter
     * above admits: it is a second route to the client's formatter, and if
     * `EXACT_DIGITS` moves this keeps reporting the old behaviour. Accepted
     * for the same reason, and what is asserted below is only that the
     * phenomenon is real, not how often.
     */
    let auditColumnDiffers = 0;
    const asPrintedAtSix = (v: number) => Math.round(Number((v * 100).toFixed(6)) * 1e6);

    for (const h of all.values()) {
      const bars = h.bars.filter((b) => b.close != null);
      if (bars.length < 2) continue;
      const endTs = bars[bars.length - 1]!.ts;

      // The recorded closes are split-adjusted to the end of the series. Undo
      // that, so a split day reaches decomposeReturn() as the -90% the tape
      // actually printed instead of as an ordinary session. Without it the
      // whole sweep would run at sf = 1 and never once exercise the two terms
      // it exists to check -- it would report a clean max error and mean
      // nothing, which is the failure mode this file was written after.
      const quoted = (b: { ts: number; close: Paise | null }) =>
        Math.round(b.close! / splitFactor(h.actions, b.ts, endTs));

      const beta = computeBaseline(h.symbol, h.bars, h.actions, nifty.bars, ADJ).beta;

      for (let i = 1; i < bars.length; i++) {
        const prev = bars[i - 1]!;
        const now = bars[i]!;
        const dec = decomposeReturn(quoted(prev), prev.ts, quoted(now), now.ts, h.actions);

        const m0 = marketByTs.get(prev.ts) ?? null;
        const m1 = marketByTs.get(now.ts) ?? null;
        const marketReturn = m0 != null && m1 != null && m0 > 0 ? (m1 - m0) / m0 : null;

        // detect.ts's own residual line, character for character in intent.
        // The identity closes only while the residual was measured against
        // the same beta and the same market return that are handed in beside
        // it; re-deriving it here by any other route would be testing a
        // different system than the one that ships.
        const hasMarket = beta != null && marketReturn != null;
        const residual =
          hasMarket && dec.adjusted != null ? dec.adjusted - beta * marketReturn : null;

        const a = attribute({ decomposition: dec, beta, marketReturn, residual });

        windows++;
        if (dec.splitFactorApplied !== 1) withSplit++;
        if (dec.dividendPerShare !== 0) withDividend++;
        if (hasMarket) withMarket++;

        if (a.closureError == null) {
          refused++;
          continue;
        }
        const e = Math.abs(a.closureError);
        if (e > maxErr) {
          maxErr = e;
          worst = `${h.symbol} ${new Date(now.ts).toISOString().slice(0, 10)}`;
        }

        const rawUnits = Math.round(a.raw! * SCALE);
        const othersUnits = a.parts
          .filter((p) => p.key !== "STOCK")
          .reduce((s, p) => s + (p.value == null ? 0 : Math.round(p.value * SCALE)), 0);
        const stock = a.parts.find((p) => p.key === "STOCK")!.value;
        if (stock != null && rawUnits - othersUnits !== Math.round(stock * SCALE)) {
          roundsDifferently++;
        }

        // A null MARKET contributes nothing here for the same reason it
        // contributes nothing to `reconstructed`: STOCK already carries the
        // whole of the adjusted move, and the panel prints "not measured" in
        // that row rather than a zero. Every other null makes `reconstructed`
        // null, and the `continue` above has already skipped those.
        const rowsAtSix = a.parts.reduce(
          (s, p) => s + (p.value == null ? 0 : asPrintedAtSix(p.value)),
          0,
        );
        if (rowsAtSix !== asPrintedAtSix(a.reconstructed!)) auditColumnDiffers++;
      }
    }

    // On the terminal, because a bound nobody can see the slack under is a
    // bound nobody can tell has started to tighten. If this number ever
    // climbs from 1e-16 to 1e-13 the test still passes, and the printed line
    // is the only warning anyone gets.
    console.warn(
      `[sweep] ${windows} windows across ${all.size} histories: ` +
        `max |raw - sum(parts)| = ${maxErr.toExponential(3)} (worst: ${worst}); ` +
        `${withSplit} spanned a split, ${withDividend} a dividend, ` +
        `${withMarket} had a beta and a market return; ${refused} refused the sum; ` +
        `${roundsDifferently} would print the stock's row a hundredth off its own value; ` +
        `${auditColumnDiffers} would print a six-decimal audit column that does not add ` +
        `to its own stated total`,
    );

    expect(maxErr).toBeLessThan(1e-12);

    // The sweep has to have swept something. Each of these counts a branch
    // the identity runs through differently, and a zero in any of them means
    // the max error above was measured over a narrower thing than the
    // sentence above it claims.
    expect(windows).toBeGreaterThan(40_000);
    expect(all.size).toBeGreaterThan(40);
    expect(withSplit).toBeGreaterThan(0);
    expect(withDividend).toBeGreaterThan(0);
    expect(withMarket).toBeGreaterThan(1_000);
    // Every window in this sweep has two usable prices by construction, so
    // none of them has any business refusing the sum. If this ever trips, the
    // max error above was computed over fewer windows than it claims.
    expect(refused).toBe(0);
    // The substitution the ledger makes is not a theoretical concern, and the
    // bound is deliberately loose: the count itself is printed above and
    // quoted in the client's docstring, but pinning it to an exact value here
    // would make every future addition to data/history a test failure in a
    // file that is supposed to tolerate the recording growing.
    expect(roundsDifferently).toBeGreaterThan(1_000);
    // And the audit panel's own rounding is not theoretical either, which is
    // the whole reason its note exists. Loose for the same reason.
    expect(auditColumnDiffers).toBeGreaterThan(1_000);
  });

  /**
   * The worked example in `AttributionRows`'s docstring, measured here so the
   * comment cannot drift away from the code it describes.
   *
   * That paragraph has been wrong once already, and instructively: it quoted a
   * Nestle window "read in a browser" at a 1000-day absence, which
   * /api/preview refuses outright (routes.ts caps `awayMs` at 400 days) and
   * which no seeded account comes near -- the longest watermark is meera's
   * 240. The figures themselves were arithmetically consistent; nothing in the
   * repo measured them, and the sentence saying where they came from was
   * false. That is the same R6 defect index.ts records having shipped against
   * the KOTAKBANK card, and the remedy is the same one: put the numbers in a
   * test that recomputes them from the recording every run.
   *
   * This window is Kotak's real 5:1, the one seeded `meera` was built to
   * surface. It is taken across the two consecutive closes the ex-date sits
   * between, not across meera's 240-day absence: an absence window ends at a
   * live replay quote that moves while the demo runs, and a figure quoted to
   * six decimals off one of those is true of one boot and no other.
   */
  it("pins the five parts the workspace ledger's worked example quotes", () => {
    const marketByTs = new Map<number, Paise>();
    for (const b of nifty.bars) if (b.close != null) marketByTs.set(b.ts, b.close);

    const h = all.get("KOTAKBANK")!;
    const bars = h.bars.filter((b) => b.close != null);
    const endTs = bars[bars.length - 1]!.ts;
    const quoted = (b: { ts: number; close: Paise | null }) =>
      Math.round(b.close! / splitFactor(h.actions, b.ts, endTs));

    const five = h.actions.splits.find((s) => s.numerator === 5);
    expect(five, "expected Kotak's 5:1 in the recorded events").toBeDefined();
    expect(five!.ratio).toBe("5:1");
    const i = bars.findIndex((b) => b.ts >= five!.exDateTs);
    expect(i).toBeGreaterThan(0);
    const prev = bars[i - 1]!;
    const now = bars[i]!;

    // The prices a holder was actually quoted on those two mornings, which is
    // the only pair the split is visible in.
    expect(toRupees(quoted(prev))).toBeCloseTo(2132.6, 1);
    expect(toRupees(quoted(now))).toBeCloseTo(421.0, 1);

    const dec = decomposeReturn(quoted(prev), prev.ts, quoted(now), now.ts, h.actions);
    const m0 = marketByTs.get(prev.ts)!;
    const m1 = marketByTs.get(now.ts)!;
    const marketReturn = (m1 - m0) / m0;
    const beta = computeBaseline(h.symbol, h.bars, h.actions, nifty.bars, ADJ).beta!;
    // detect.ts's residual line, for the same reason the sweep above copies it.
    const a = attribute({
      decomposition: dec,
      beta,
      marketReturn,
      residual: dec.adjusted! - beta * marketReturn,
    });
    const part = (key: PartKey) => a.parts.find((p) => p.key === key)!.value!;

    expect(dec.splitFactorApplied).toBeCloseTo(0.2, 12);
    expect(dec.dividendPerShare).toBe(0);

    // The six figures the docstring prints in its left-hand column, at the
    // precision it prints them.
    expect(part("SPLIT")).toBe(1 / 5 - 1);
    expect(part("DIVIDEND")).toBe(0);
    expect(part("MARKET") * 100).toBeCloseTo(-0.253008, 6);
    expect(part("STOCK") * 100).toBeCloseTo(-1.041187, 6);
    expect(part("INTERACTION") * 100).toBeCloseTo(1.035356, 6);
    expect(a.raw! * 100).toBeCloseTo(-80.258839, 6);
    expect(Math.abs(a.closureError!)).toBeLessThan(1e-12);

    // And the right-hand column: the integer hundredths the ledger prints, the
    // substitution it makes for the stock's row, and the hundredth that
    // substitution moves. Restating the client's two rounding rules is the
    // same second route the sweep above accepts and for the same reason --
    // without it the docstring's column is a claim nothing checks.
    const SCALE = 10_000;
    const units = (x: number) => Math.round(x * SCALE);
    const rawUnits = units(a.raw!);
    const othersUnits = a.parts
      .filter((p) => p.key !== "STOCK")
      .reduce((s, p) => s + units(p.value!), 0);
    expect(rawUnits).toBe(-8026);
    expect(othersUnits).toBe(-7921);
    expect(rawUnits - othersUnits).toBe(-105);
    expect(units(part("STOCK"))).toBe(-104);
    // The printed column adds up exactly as printed, which is the whole claim
    // the substitution exists to make good on.
    expect(othersUnits + (rawUnits - othersUnits)).toBe(rawUnits);

    // And the left-hand column's labels, which are the server's and are printed
    // verbatim. The MARKET one now carries the beta it was scaled by, so it
    // drifts whenever the baseline moves -- which is exactly what this test is
    // for. Written out rather than recomposed from `beta` so the docstring's
    // line and this line are one claim and not two.
    expect(a.parts.find((p) => p.key === "MARKET")!.label).toBe(
      "moved with the market, scaled by a beta of 0.976",
    );
  });
});

d("the split, taken back out of the holder's return", () => {
  const all = loadHistoryDir(DIR);
  // No intraday loaded on purpose: every lookup below resolves to a daily bar,
  // which is the branch that carries the back-adjustment and the branch the
  // digest's watermark price actually lands on for any absence longer than the
  // recorded session.
  const oracle = new PriceOracle(all);

  /**
   * The seam the sweep above cannot see: a price coming *out of the recording*
   * and going *into* decomposeReturn().
   *
   * That sweep builds its own quoted prices with a local `quoted()` helper, so
   * it proves the algebra and never touches the boundary where the terms are
   * decided. The boundary was wrong. The oracle served the recorded close --
   * back-adjusted to the end of its series -- decomposeReturn() restated it by
   * the split a second time, and the digest's rank-1 card for the seeded
   * `meera` account read "KOTAKBANK +394.78%" over a window in which the
   * holder was down about 1%. The five parts printed underneath it and closed
   * to 1.7e-16 while doing it.
   *
   * What is asserted here is an identity that cannot hold unless the split
   * cancels exactly once. Writing `q` for the quote of the day, `c` for the
   * recorded close, `f` for the factor that restated it and `sf` for the split
   * factor across the window, `q = c/f` and `f(from) = sf * f(to)`, so
   *
   *   adjusted = (q1 + div - q0*sf) / (q0*sf) = (c1 - c0 + div*f1) / c0
   *
   * -- an expression with no `sf` left in it, built from the stored closes the
   * recording actually carries. Apply the split twice and it misses by the
   * split ratio. Measured, by putting the defect back: max error over the same
   * windows goes from 5.9e-5 to 3.7e+1, worst at NESTLEIND over a window
   * carrying both of its splits.
   */
  it("cancels out of every window that straddles one, over every split in the recording", () => {
    let windows = 0;
    let splitsCovered = 0;
    let maxErr = 0;
    let worst = "none";

    for (const h of all.values()) {
      if (h.actions.splits.length === 0) continue;
      const bars = h.bars.filter((b) => b.close != null);
      if (bars.length < 2) continue;
      const endTs = bars[bars.length - 1]!.ts;

      // One lookup per bar rather than per pair: the answer depends only on the
      // bar, and the pair count below is in the millions.
      const quoted = bars.map((b) => oracle.priceAt(h.symbol, b.ts)!.price);

      for (const sp of h.actions.splits) {
        const first = bars.findIndex((b) => b.ts >= sp.exDateTs);
        if (first <= 0) continue; // the split predates the recording
        splitsCovered++;

        // Every (watermark, now) pair that straddles this ex-date, not a
        // sample of them: the shipped defect's size depends on the split alone
        // and not on the window, so a sample would have caught it too -- but a
        // future one that depends on how far apart the two ends are would not.
        for (let i = 0; i < first; i++) {
          for (let j = first; j < bars.length; j++) {
            const a = bars[i]!;
            const b = bars[j]!;
            const dec = decomposeReturn(quoted[i]!, a.ts, quoted[j]!, b.ts, h.actions);
            const div = dividendPerCurrentShare(h.actions, a.ts, b.ts);
            const f1 = splitFactor(h.actions, b.ts, endTs);
            const ref = (b.close! - a.close! + div * f1) / a.close!;

            windows++;
            const e = Math.abs(dec.adjusted! - ref);
            if (e > maxErr) {
              maxErr = e;
              worst =
                `${h.symbol} ${new Date(a.ts).toISOString().slice(0, 10)}` +
                `..${new Date(b.ts).toISOString().slice(0, 10)} ` +
                `adjusted=${dec.adjusted!.toFixed(6)} vs ${ref.toFixed(6)}`;
            }
          }
        }
      }
    }

    console.warn(
      `[splits] ${windows} straddling windows across ${splitsCovered} recorded splits: ` +
        `max |adjusted - closes| = ${maxErr.toExponential(3)} (worst: ${worst})`,
    );

    // Not 1e-12, and the gap is a measurement rather than slack. Undoing the
    // back-adjustment re-quantises to whole paise -- `Math.round(close / f)` --
    // so the base decomposeReturn() divides by is up to half a paise off the
    // price that really printed. The bound is that rounding and nothing else:
    // it is largest on POWERGRID's 4:3, the one ratio in the recording whose
    // reciprocal is not exact in binary, over the windows with the largest
    // returns to scale it up. The five-part closure is unaffected and still
    // holds at 1e-16, because every part is built from the same integer.
    expect(maxErr).toBeLessThan(1e-4);

    // The recording holds twelve splits across eleven symbols; all twelve have
    // bars on both sides of them. A drop here means a history was truncated and
    // the bound above was measured over less than it claims.
    expect(splitsCovered).toBe(12);
    expect(windows).toBeGreaterThan(3_000_000);
  });
});

d("baselines from recorded history", () => {
  const all = loadHistoryDir(DIR);
  const nifty = all.get("^NSEI")!;
  const ADJ = { closeAdjustment: "SPLIT_ADJUSTED" } as const;

  it("produces sane volatility and beta for a large cap", () => {
    const h = all.get("HDFCBANK")!;
    const b = computeBaseline("HDFCBANK", h.bars, h.actions, nifty.bars, ADJ);

    expect(b.observations).toBeGreaterThan(400);
    // Indian large-cap daily vol sits roughly in the 0.5%-3.5% band.
    expect(b.dailyVol!).toBeGreaterThan(0.005);
    expect(b.dailyVol!).toBeLessThan(0.035);
    // A bank heavyweight in the index tracks it closely.
    expect(b.beta!).toBeGreaterThan(0.5);
    expect(b.beta!).toBeLessThan(1.8);
    // The whole point of the market adjustment: less noise to threshold against.
    // Compared over the same 500-session window the baseline itself used;
    // comparing against the full series would be measuring two different things.
    const sameWindow = stdev(toReturns(h.bars.slice(-500).map((x) => x.close)))!;
    expect(b.residualVol!).toBeLessThan(sameWindow);
  });

  // The test that used to sit here asserted residualVol < stdev(returns) for
  // every symbol and read as evidence that the market adjustment worked. It is
  // an algebraic identity -- regressing on any factor cannot increase residual
  // variance in sample -- so it passed by construction and measured nothing.
  // The real measurement, out of sample, is in calibration.test.ts.

  it("gives a high-beta name a higher beta than a defensive one", () => {
    const beta = (sym: string) => {
      const h = all.get(sym)!;
      return computeBaseline(sym, h.bars, h.actions, nifty.bars, ADJ).beta!;
    };
    // Public-sector banks are famously more index-sensitive than staples.
    expect(beta("PNB")).toBeGreaterThan(beta("HINDUNILVR"));
  });

  it("computes 52-week levels that bracket the last traded price", () => {
    for (const sym of ["RELIANCE", "TCS", "ITC"]) {
      const h = all.get(sym)!;
      const b = computeBaseline(sym, h.bars, h.actions, nifty.bars, ADJ);
      const last = [...h.bars].reverse().find((x) => x.close != null)!.close!;
      expect(b.week52Low!, sym).toBeLessThanOrEqual(last);
      expect(b.week52High!, sym).toBeGreaterThanOrEqual(last);
    }
  });

  it("models volume in log space, where a typical day sits near the middle", () => {
    const h = all.get("RELIANCE")!;
    const b = computeBaseline("RELIANCE", h.bars, h.actions, nifty.bars, ADJ);
    expect(b.logVolumeStdev!).toBeGreaterThan(0);

    // On a raw scale the arithmetic mean sits well above the median for skewed
    // turnover, so a normal day would score negative. The geometric mean this
    // baseline uses should land close to the median instead.
    const vols = h.bars.map((x) => x.volume).filter((v): v is number => v != null && v > 0).slice(-90);
    const sorted = [...vols].sort((a, b2) => a - b2);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const arithmetic = vols.reduce((s, v) => s + v, 0) / vols.length;

    expect(b.avgVolume!).toBeGreaterThan(median * 0.7);
    expect(b.avgVolume!).toBeLessThan(median * 1.4);
    expect(arithmetic).toBeGreaterThan(b.avgVolume!); // the skew we are avoiding
  });

  it("returns an empty baseline rather than guessing when history is absent", () => {
    const b = computeBaseline("NEWLISTING", [], { symbol: "NEWLISTING", splits: [], dividends: [] }, null);
    expect(b.dailyVol).toBeNull();
    expect(b.beta).toBeNull();
    expect(b.observations).toBe(0);
  });

  it("still produces a usable baseline for a recently listed stock", () => {
    // IREDA listed in late 2023: ~690 sessions, enough for vol, enough for beta.
    const h = all.get("IREDA")!;
    const b = computeBaseline("IREDA", h.bars, h.actions, nifty.bars, ADJ);
    expect(b.observations).toBeGreaterThan(300);
    expect(b.dailyVol).not.toBeNull();
    // ...and a newly listed name should be more volatile than a bluechip.
    const rel = all.get("RELIANCE")!;
    const relB = computeBaseline("RELIANCE", rel.bars, rel.actions, nifty.bars, ADJ);
    expect(b.dailyVol!).toBeGreaterThan(relB.dailyVol!);
  });
});

d("the structural guard, on real events", () => {
  const all = loadHistoryDir(DIR);
  const nifty = all.get("^NSEI")!;
  const ADJ = { closeAdjustment: "SPLIT_ADJUSTED" } as const;

  /** Replay one real session transition through the detector. */
  function detectAcross(symbol: string, findWorst: "min" | "max") {
    const h = all.get(symbol)!;
    const bars = h.bars.filter((b) => b.close != null);
    let idx = -1;
    let best = 0;
    for (let i = 1; i < bars.length; i++) {
      const r = (bars[i]!.close! - bars[i - 1]!.close!) / bars[i - 1]!.close!;
      if (idx === -1 || (findWorst === "min" ? r < best : r > best)) { best = r; idx = i; }
    }
    const prev = bars[idx - 1]!;
    const now = bars[idx]!;
    const nowTs = now.ts + 6 * 3600_000; // mid-session on the day in question
    const baseline = computeBaseline(symbol, bars.slice(0, idx), h.actions, nifty.bars, ADJ);
    const session = sessionAt(nowTs);
    const q = {
      symbol,
      ltp: now.close,
      prevClose: prev.close,
      exchangeTs: nowTs - 1000,
      ingestTs: nowTs,
    };
    const assessment = assess(q, {
      now: nowTs,
      session,
      cadenceMs: 30_000,
      universeFreshestTs: nowTs - 1000,
      // The real production value. An earlier version of this test widened the
      // band to stop the quality layer pre-empting the detector, which quietly
      // meant the test proved something the running system did not do: in
      // production a -65% print was being labelled "bad data" before detect()
      // ever saw it. The band moved instead.
      circuitBand: SANITY_BAND,
    });
    const signals = detect({
      symbol,
      now: nowTs,
      watermarkTs: prev.ts + 6 * 3600_000,
      watermarkPrice: prev.close,
      price: now.close,
      prevClose: prev.close,
      exchangeTs: nowTs - 1000,
      dayVolume: now.volume,
      maxSessionMove: null,
      assessment,
      baseline,
      actions: h.actions,
      marketReturn: null,
      circuitBand: DEFAULT_CIRCUIT_BAND,
      policy: PRESETS.balanced,
    });
    return { signals, move: best };
  }

  it("flags Vedanta's undocumented demerger instead of reporting a 65% loss", () => {
    const { signals, move } = detectAcross("VEDL", "min");
    expect(move).toBeLessThan(-0.6);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("SUSPECTED_STRUCTURAL");
    // Crucially, it must not ALSO be reported as a price move.
    expect(kinds).not.toContain("MOVE");
    const s = signals.find((x) => x.kind === "SUSPECTED_STRUCTURAL")!;
    expect(s.because).toMatch(/demerger|spin-off|restatement/);
  });

  it("lets Adani's genuine 28% crash through as real news", () => {
    // The guard must not swallow real events. This is the whole difficulty:
    // a threshold loose enough to catch structure and tight enough to keep news.
    const { signals, move } = detectAcross("ADANIENT", "min");
    expect(move).toBeLessThan(-0.25);
    expect(Math.abs(move)).toBeLessThan(STRUCTURAL_ABS);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("MOVE");
    expect(kinds).not.toContain("SUSPECTED_STRUCTURAL");
  });

  it("keeps volatility estimates honest despite the demerger in the sample", () => {
    // Vedanta's -65% is still in the series. Winsorising must stop it from
    // redefining normal, or every real signal from VEDL afterwards is lost.
    const h = all.get("VEDL")!;
    const b = computeBaseline("VEDL", h.bars, h.actions, nifty.bars, ADJ);
    const naive = stdev(toReturns(h.bars.slice(-500).map((x) => x.close)))!;
    expect(b.dailyVol!).toBeLessThan(naive);
    // ...and still lands in a plausible range for a volatile metals name.
    expect(b.dailyVol!).toBeGreaterThan(0.008);
    expect(b.dailyVol!).toBeLessThan(0.06);
  });
});
