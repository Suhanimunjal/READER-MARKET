/**
 * Composition root and the digest pipeline.
 *
 * Everything above this file is pure: given a quote, a baseline and a
 * watermark, `detect` returns signals and cannot do anything else. Everything
 * below it is I/O. This is the one place where the two meet, and it is
 * deliberately the only place that knows about both.
 */
import { basename, join, resolve } from "node:path";
import { VirtualClock, type Clock } from "./core/clock.js";
import { sessionAt, detectUnexpectedlyQuiet, lastRegularClose, sessionBands, sessionOpensBetween, type SessionBand } from "./core/calendar.js";
import { assess, SANITY_BAND, DEFAULT_CIRCUIT_BAND, INDEX_CIRCUIT_BAND } from "./core/quality.js";
import { computeBaseline, emptyBaseline, type Baseline } from "./core/baseline.js";
import { detect, PRESETS, type Policy, type Signal } from "./core/detect.js";
import { rank, type RankedSignal, type Suppressed, type MarketContext } from "./core/rank.js";
import { buildDigest, describeAbsence, narrate, type Digest, type PathPoint } from "./core/digest.js";
import { decomposeReturn, NO_ACTIONS, type CorporateActions } from "./core/corporate.js";
import { ret, type Paise } from "./core/money.js";
import { loadHistoryDir, adjustmentMismatches, type SymbolHistory, type AdjustmentMismatch } from "./data/history.js";
import { PriceOracle } from "./data/oracle.js";
import { ReplayProvider, NO_FAULT, type Fault } from "./data/replay.js";
import { YahooProvider, type MarketDataProvider } from "./data/provider.js";
import { QuoteStore } from "./store/quotes.js";
import { IngestWorker } from "./ingest/worker.js";
import * as store from "./store/db.js";
import { readFileSync, existsSync } from "node:fs";

export const INDEX_SYMBOL = "^NSEI";
export const INDEX_LABEL = "NIFTY 50";

export interface SymbolRow {
  symbol: string;
  name: string;
  price: Paise | null;
  prevClose: Paise | null;
  /** Move since the previous session close. The conventional number. */
  changeToday: number | null;
  /** Move since THIS user last acknowledged the symbol. The one that matters. */
  changeSinceSeen: number | null;
  /** Same window, uncorrected. Shown in the audit view to expose the difference. */
  rawSinceSeen: number | null;
  watermarkTs: number;
  watermarkPrice: Paise | null;
  quality: string;
  qualityReason: string;
  ageMs: number | null;
  displayable: boolean;
  week52High: Paise | null;
  week52Low: Paise | null;
  dailyVol: number | null;
  beta: number | null;
  observations: number;
  corporateActions: number;
}

/**
 * Below this, the share is refused rather than reported.
 *
 * The share is a ratio, and its denominator is a net move that is free to be
 * arbitrarily close to zero: a list where half the names rose a percent and
 * half fell a percent nets out near nothing while every symbol in it moved.
 * Divide a perfectly ordinary tape contribution by that and the answer is
 * whatever the rounding happened to leave in the denominator -- 40, -1200, any
 * number at all, printed with the same confidence as a real one.
 *
 * 0.2% is a fifth of a percent on an equal-weighted basket, which is inside
 * the range a quiet session produces from rounding to the paise across a few
 * dozen names. Above it the denominator is a move; below it, it is a residue.
 *
 * That is the whole of what this constant knows, and it is less than the
 * sentence above was read as claiming. "The denominator is a move" is not "the
 * ratio is usable", and the counterexample is the shape the seeded demo ships:
 * a thirty-day list that nets a few tenths of a percent against a tape
 * contribution near -3.8% clears this floor comfortably and still divides to a
 * share in the hundreds of percent.
 *
 * THE DIGITS BELOW ARE THE FIXTURE'S, not a reading off a running server. The
 * case is pinned by "refuses the share when the tape dwarfs the move it would
 * be divided by" in server/test/regressions.test.ts, whose two contributions
 * net -0.27% against a tape mean of -3.85%: a ratio of 14.26, which without
 * TAPE_RATIO_CEILING would print "1426% of what this list did was the tape".
 * Seeded `ravi` is that shape and is where it was found, but his own means
 * move with every tick of the replay, so any figure quoted from one boot is
 * true of that boot alone -- the provenance failure server/src/index.ts
 * records itself having shipped, and the earlier version of this paragraph
 * quoted "-0.27% / -3.85% / 1408%" as his, of which only the arithmetic-free
 * shape survived a second boot and even the 1408% disagreed with the fixture.
 *
 * The size of the denominator and its size next to the numerator are two
 * different questions; this asks the first and TAPE_RATIO_CEILING asks the
 * second.
 */
export const NET_MOVE_FLOOR = 0.002;

/**
 * And above this multiple, the share is refused rather than reported.
 *
 * The floor guards the denominator's magnitude. This guards its magnitude
 * relative to the numerator, which is a different failure and the one that
 * actually reached a screen: when the tape's part of a list is many times the
 * list's own move, that move is the small difference between two larger
 * numbers, and the quotient is reporting how nearly they cancelled rather than
 * how much of the list was the market. No floor on the denominator alone
 * catches it, because the denominator is a perfectly ordinary size -- the
 * fixture's -0.27% is 1.4x the floor and is a real 30-day move.
 *
 * 5 is judgement, not a fitted parameter, and it is stated with both of the
 * readings it was chosen between. It keeps every share this project already
 * calls real: shares above 1 and below 0 are meaningful here and are pinned as
 * such by "reports a share above 1 rather than clamping it into a proportion",
 * which asserts a share of exactly 3. It refuses the 14.26 of the fixture in
 * "refuses the share when the tape dwarfs the move it would be divided by" --
 * the fixture's figure and not a live one, for the reason NET_MOVE_FLOOR
 * spells out above. Between 5 and 14 there is nothing measured to appeal to,
 * so the constant is set at the edge of what is pinned rather than at the edge
 * of what is broken, and a share of 500% still prints.
 */
export const TAPE_RATIO_CEILING = 5;

/**
 * How much of what this list did was simply the market doing it.
 *
 * EQUAL-WEIGHTED, and named that way in every field rather than in a comment,
 * because the default assumption for a number like this is cap-weighting --
 * that is what an index attribution means everywhere else a reader will have
 * seen one. This is the mean across symbols, so a small holding counts exactly
 * as much as a large one and a list of thirty smallcaps and one bluechip
 * reports what those thirty did. That is a defensible thing to show a person
 * looking at a watchlist, where "what did the things I am watching do" is the
 * question and position size is often zero. It is not the same number as the
 * portfolio's, and a reader who assumes otherwise has been misled by us.
 *
 * Hence `weighting`, `weightingLabel` and the `EqualWeighted` suffix on all
 * three numbers: the field name travels with the number into the client, the
 * log and the audit view, and none of those carry this comment with them.
 */
export interface TapeShare {
  /** Machine-readable, and the only value it currently takes. */
  weighting: "EQUAL";
  /** UI-facing, and the string the client is expected to render verbatim. */
  weightingLabel: string;
  /** Equal-weighted mean adjusted move across the symbols counted below. */
  netMoveEqualWeighted: number | null;
  /** Equal-weighted mean of `beta * marketReturn` over those same symbols. */
  tapeMoveEqualWeighted: number | null;
  /**
   * `tapeMove / netMove`. Signed, and deliberately not clamped to 0..1.
   *
   * A value above 1 means the tape moved the list further than it actually
   * went, so the stocks themselves pushed back; a negative value means the
   * list moved one way while the market moved it the other. Both are real
   * readings and both are worth seeing. Clamping would make the number look
   * like a proportion of something, which is a property it does not have.
   *
   * Unclamped, but not unbounded: past TAPE_RATIO_CEILING this is withheld
   * along with a reason rather than clipped to the ceiling. A clip would print
   * a number the arithmetic never produced; the refusal says the quotient
   * stopped meaning anything, which is what actually happened.
   */
  shareFromTapeEqualWeighted: number | null;
  /**
   * How many symbols the three numbers above were measured over. Both means
   * run over this same set: a symbol with no beta or no market return for the
   * window contributes to neither, because a basket whose numerator and
   * denominator are taken over different names is not a ratio of anything.
   */
  symbolsCounted: number;
  /** Watched, but missing a price, a beta or a market return for this window. */
  symbolsExcluded: number;
  /** Set exactly when the share is null: what stopped us reporting one. */
  refusedReason: string | null;
}

export interface DigestResponse {
  digest: Digest;
  rows: SymbolRow[];
  /** Sparkline over each surfaced card's own window, keyed by symbol. */
  paths: Record<string, PathPoint[]>;
  /** Narrative facts, present only when the absence was long enough to need them. */
  narratives: Record<string, ReturnType<typeof narrate>>;
  /**
   * The list-level version of the question every card answers individually.
   * Carried on the existing digest shape rather than behind a new endpoint, so
   * a client that already fetches a digest -- the landing page's away-slider
   * included -- needs no second call to get it. Rendered by the workspace
   * digest above the cards; the slider takes the same response and prints the
   * cards out of it.
   */
  tape: TapeShare;
  session: ReturnType<typeof sessionAt> & { unexpectedlyQuiet: boolean };
  /** Open-market windows inside the absence, for shading the ruler. */
  sessionBands: SessionBand[];
  policy: Policy & { name: string };
}

/** One recording in play, as /api/status publishes it. */
export interface Recording {
  /** Basename, e.g. "ticks-2026-09-15.jsonl". */
  file: string;
  /** Whether this is `<dataDir>/ticks.jsonl`, the session every figure in the
   *  docs and the fixtures is measured from. */
  canonical: boolean;
  /** This file's own first and last poll instant, epoch ms. */
  from: number;
  to: number;
  ticks: number;
}

export interface AppOptions {
  dataDir: string;
  dbPath: string;
  mode: "replay" | "live";
  intervalMs?: number;
  /**
   * Recordings to replay, in any order. Defaults to the single canonical
   * `<dataDir>/ticks.jsonl`, so every existing caller -- the tests included --
   * boots exactly the session it booted before this option existed.
   */
  ticksPaths?: string[];
}

/**
 * Whether two paths name the same file.
 *
 * Case-folded on win32 only, because that is the platform where two spellings
 * of one filename open one file. Doing it everywhere would call TICKS.jsonl the
 * canonical recording on a Linux box where it is a different file.
 */
/**
 * The most recent daily bar across every loaded symbol.
 *
 * Max across symbols rather than off any one series, because the universe is
 * not refreshed atomically: a symbol the provider 404s stops getting bars while
 * the rest keep arriving, and taking that symbol's last bar would report the
 * history as older than it is.
 */
function lastHistoryBar(all: Map<string, SymbolHistory>): number | null {
  let last: number | null = null;
  for (const h of all.values()) {
    const b = h.bars[h.bars.length - 1];
    if (b && (last == null || b.ts > last)) last = b.ts;
  }
  return last;
}

function samePath(a: string, b: string): boolean {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Roll the per-symbol split between the tape and the stock up to the list.
 *
 * Pure arithmetic over numbers the caller already measured, kept as a free
 * function so it can be read and tested without an App, a database or a clock.
 * It is in app.ts rather than core/ because it is a property of a *watchlist*,
 * which is a composition-root concept: core/ knows about instruments and
 * windows and has never heard of a user's list.
 *
 * `contributions` must carry, for each symbol, the adjusted move over the
 * window and the tape's part of it -- `beta * marketReturn`, the same product
 * the MARKET row of that symbol's attribution prints. A symbol missing either
 * belongs in `excluded`, never in here with a zero: a zero in the tape column
 * asserts that the market did nothing to that name, and "we could not measure
 * it" is a different statement that would drag the mean toward zero while
 * looking like data.
 */
export function rollUpTape(
  contributions: readonly { adjusted: number; tape: number }[],
  excluded: number,
): TapeShare {
  const n = contributions.length;
  const label = `equal-weighted across ${n} symbol${n === 1 ? "" : "s"}`;
  const base: TapeShare = {
    weighting: "EQUAL",
    weightingLabel: label,
    netMoveEqualWeighted: null,
    tapeMoveEqualWeighted: null,
    shareFromTapeEqualWeighted: null,
    symbolsCounted: n,
    symbolsExcluded: excluded,
    refusedReason: null,
  };

  if (n === 0) {
    return {
      ...base,
      weightingLabel: "equal-weighted across no symbols",
      refusedReason:
        "no symbol in this list has both a measurable move and a market return for this window",
    };
  }

  const net = contributions.reduce((s, c) => s + c.adjusted, 0) / n;
  const tape = contributions.reduce((s, c) => s + c.tape, 0) / n;

  // The two means are reported whatever the ratio does. They are measurements
  // and they stand on their own; it is only their quotient that stops meaning
  // anything as the denominator vanishes.
  if (Math.abs(net) < NET_MOVE_FLOOR) {
    return {
      ...base,
      netMoveEqualWeighted: net,
      tapeMoveEqualWeighted: tape,
      refusedReason:
        `the list moved ${(net * 100).toFixed(2)}% on average, which is under the ` +
        `${(NET_MOVE_FLOOR * 100).toFixed(1)}% floor: a share of a move this small is ` +
        `a ratio against rounding, not a measurement`,
    };
  }

  // Multiplied rather than divided, so the comparison is the same one the
  // constant's name makes and does not depend on a division that the floor
  // above has only just made safe.
  if (Math.abs(tape) > TAPE_RATIO_CEILING * Math.abs(net)) {
    return {
      ...base,
      netMoveEqualWeighted: net,
      tapeMoveEqualWeighted: tape,
      refusedReason:
        `the tape's part of this list, ${(tape * 100).toFixed(2)}%, is more than ` +
        `${TAPE_RATIO_CEILING} times the ${(net * 100).toFixed(2)}% the list itself moved: ` +
        `a share against a denominator that small is measuring how nearly these names ` +
        `cancelled each other out, not how much of them was the market`,
    };
  }

  return {
    ...base,
    netMoveEqualWeighted: net,
    tapeMoveEqualWeighted: tape,
    shareFromTapeEqualWeighted: tape / net,
  };
}

export class App {
  readonly db: store.DB;
  readonly quotes = new QuoteStore();
  readonly clock: VirtualClock;
  readonly provider: MarketDataProvider;
  readonly replay: ReplayProvider | null;
  readonly worker: IngestWorker;
  readonly oracle: PriceOracle;
  readonly history: Map<string, SymbolHistory>;
  private readonly baselines = new Map<string, Baseline>();
  readonly mode: "replay" | "live";
  /**
   * Symbols whose recorded data contradicts the declared price-adjustment
   * semantics. Checked at boot and surfaced on /api/status: a silent
   * disagreement here corrupts every volatility estimate downstream, which is
   * the one bug in this project that cost the most to find.
   */
  readonly adjustmentMismatches: AdjustmentMismatch[];
  /**
   * The last daily bar anywhere in `data/history`, epoch ms, or null if there
   * are no bars at all.
   *
   * Published because it is the one input TICKS= does *not* move. Every figure
   * that is not a live quote -- the volatility band a "2.0σ" is measured
   * against, beta, the 52-week range, the split and dividend feed -- is fitted
   * to these bars, so a reader comparing a number on screen against the day the
   * clock claims to be in needs to know where the baselines were measured from.
   */
  readonly historyAsOf: number | null;
  /**
   * The recordings in play, by basename.
   *
   * Basename and not the path: which directory this process was started from is
   * a property of the machine, and /api/status is served to a browser.
   */
  readonly recordings: Recording[];

  constructor(opts: AppOptions) {
    this.mode = opts.mode;
    this.db = store.openDb(opts.dbPath);
    this.history = loadHistoryDir(join(opts.dataDir, "history"));
    this.oracle = new PriceOracle(this.history);

    // The clock is virtual even in live mode, sitting at zero offset. Making it
    // the same object in both modes means the time-travel path is exercised by
    // ordinary use rather than only in the demo.
    this.clock = new VirtualClock(Date.now(), 1);

    const canonicalPath = join(opts.dataDir, "ticks.jsonl");
    const tickPaths = opts.ticksPaths?.length ? opts.ticksPaths : [canonicalPath];
    this.replay = opts.mode === "replay" ? ReplayProvider.fromFiles(this.clock, tickPaths) : null;
    this.recordings = (this.replay?.sources ?? []).map((s) => ({
      file: basename(s.path),
      canonical: samePath(s.path, canonicalPath),
      from: s.from,
      to: s.to,
      ticks: s.ticks,
    }));

    if (this.replay?.hasData()) {
      this.clock.seek(App.landingInstant(this.replay));
      for (const p of tickPaths) this.loadIntradayFromTicks(p);
    }

    this.provider = this.replay?.hasData() ? this.replay : new YahooProvider();

    this.historyAsOf = lastHistoryBar(this.history);
    // The stale-history tell. TICKS= reloads the tape and nothing else, so a
    // recording captured well after data/history was last refreshed gets
    // volatility bands, betas, 52-week highs and corporate actions fitted to
    // bars that end days or weeks before the session on screen -- and every one
    // of those numbers still renders, with nothing anywhere saying how old its
    // inputs are. One session of slack, because the session the clock is
    // sitting inside is open and has no daily bar yet by definition.
    if (this.historyAsOf != null && sessionOpensBetween(this.historyAsOf, this.clock.now()) > 1) {
      const n = sessionOpensBetween(this.historyAsOf, this.clock.now());
      process.stderr.write(
        `[history] the clock is at ${new Date(this.clock.now()).toISOString()} but the last daily ` +
          `bar in ${join(opts.dataDir, "history")} is ${new Date(this.historyAsOf).toISOString()}, ` +
          `${n} session opens back. Baselines, volatility, betas, 52-week bands and corporate ` +
          `actions are measured from those bars; TICKS does not reload them.\n`,
      );
    }

    this.adjustmentMismatches = adjustmentMismatches(this.history);
    if (this.adjustmentMismatches.length > 0) {
      // Loud, at boot, on stderr. Not a throw: refusing to start would take the
      // whole product down over a handful of symbols, and every other symbol's
      // numbers are still correct. But it must never be silent.
      for (const m of this.adjustmentMismatches) {
        process.stderr.write(
          `[adjustment] ${m.symbol}: provider declares ${m.declared} but the data shows ` +
            `${m.observed}. Volatility for this symbol will be wrong until this is resolved.\n`,
        );
      }
    }

    for (const h of this.history.values()) {
      store.upsertSymbol(this.db, h.symbol, h.displayName, h.symbol.startsWith("^"));
      this.baselines.set(
        h.symbol,
        computeBaseline(h.symbol, h.bars, h.actions, this.history.get(INDEX_SYMBOL)?.bars ?? null, {
          // No session the clock says is still open.
          asOf: this.clock.now(),
          // The declaration that belongs to *these bars*, not to whichever live
          // quote provider happens to be wired in. Using the provider's was
          // correct only by coincidence: both say SPLIT_ADJUSTED today, and a
          // second provider declaring RAW would have silently double-adjusted
          // the historical series -- reintroducing, through a different seam,
          // the exact bug this field was added to prevent.
          closeAdjustment: h.closeAdjustment,
        }),
      );
    }

    this.worker = new IngestWorker({
      provider: this.provider,
      store: this.quotes,
      clock: this.clock,
      universe: () => {
        // The index is always ingested: without it there is no market-relative
        // view, and market-relative is what keeps a red day readable.
        const watched = store.watchedUniverse(this.db);
        return [...new Set([INDEX_SYMBOL, ...watched])];
      },
      naiveDemand: () =>
        (this.db.prepare(`SELECT COUNT(*) AS n FROM watchlist_items`).get() as { n: number }).n,
      intervalMs: opts.intervalMs ?? 15_000,
    });
  }

  /**
   * Where the clock lands at boot, and where /api/lab/reset puts it back.
   *
   * Relative to the LAST segment, not to the pooled recording. With two days
   * loaded, `from .. to` spans the overnight gap, and 35% of that span falls
   * inside the gap rather than inside either sitting: the product would boot
   * onto a shut market with the previous day's prices going stale, which is the
   * screen replay mode exists to avoid. The last segment is also the right one
   * to land in on its own terms -- a second recording is loaded to watch the
   * product read that day.
   *
   * With one file there is exactly one segment, whose from/to are the pooled
   * minimum and maximum poll instant, which is what `replay.from`/`replay.to`
   * already were. So this is the same arithmetic on the same two numbers as the
   * single-file formula it replaces, and that is asserted rather than claimed:
   * "lands a single synthetic file exactly where the single-file formula did"
   * and "is still one sitting, and is still what boots by default", both in
   * server/test/multiday.test.ts, recompute the old expression and compare --
   * the second of them against the canonical recording itself.
   *
   * A little after the segment's start, so there is history behind the opening
   * view.
   */
  static landingInstant(replay: ReplayProvider): number {
    const segs = replay.segments();
    const last = segs[segs.length - 1];
    const from = last?.from ?? replay.from;
    const to = last?.to ?? replay.to;
    const span = to - from;
    return from + Math.min(span * 0.35, span);
  }

  /** Index recorded ticks so intraday windows resolve at tick resolution. */
  private loadIntradayFromTicks(path: string): void {
    if (!existsSync(path)) return;
    const bySymbol = new Map<string, { ts: number; price: Paise }[]>();
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        if (t?.ltp == null || typeof t.poll_ts !== "number") continue;
        const arr = bySymbol.get(t.sym) ?? [];
        arr.push({ ts: t.poll_ts * 1000, price: Math.round(t.ltp * 100) });
        bySymbol.set(t.sym, arr);
      } catch {
        // Truncated trailing line while the recorder is still running.
      }
    }
    for (const [sym, pts] of bySymbol) this.oracle.loadIntraday(sym, pts);
  }

  baselineFor(symbol: string): Baseline {
    return this.baselines.get(symbol) ?? emptyBaseline(symbol);
  }

  actionsFor(symbol: string): CorporateActions {
    return this.history.get(symbol)?.actions ?? NO_ACTIONS(symbol);
  }

  nameFor(symbol: string): string {
    return this.history.get(symbol)?.displayName ?? symbol;
  }

  policyFor(userId: string): Policy & { name: string } {
    const u = store.getUser(this.db, userId);
    const name = (u?.policy ?? "balanced") as keyof typeof PRESETS;
    const p = PRESETS[name] ?? PRESETS.balanced;
    return { ...p, name };
  }

  // ------------------------------------------------------------- digest --

  /**
   * Compute a digest. Pure with respect to the database: reads, never writes.
   *
   * Splitting this out fixed a real problem and enabled a feature. GET
   * /api/digest used to append to the event log, so a query-named endpoint was
   * a command -- and the SSE stream calls it every three seconds per connected
   * reader, which meant the "immutable event log" was being appended to on a
   * timer by anyone with a browser tab open.
   *
   * `awayOverrideMs` answers "what would I see if I had last looked N ago?"
   * without touching anyone's watermark. The landing page is built on it: a
   * reader drags one slider and the digest rewrites itself from real recorded
   * prices, which is the entire thesis demonstrated rather than described.
   */
  computeDigest(userId: string, awayOverrideMs?: number): DigestResponse {
    const now = this.clock.now();
    const session = sessionAt(now);
    const policy = this.policyFor(userId);
    const items = store.listWatch(this.db, userId);
    const marks = store.getWatermarks(this.db, userId);
    const freshest = this.quotes.freshestExchangeTs();

    const rows: SymbolRow[] = [];
    const signals: Signal[] = [];
    let degraded = 0;
    let unavailable = 0;

    // The list-level tape split, accumulated as we go rather than recomputed
    // from `rows` afterwards: the beta and the market return are both in hand
    // here, and reading them back off a row would need `rows` to carry a tape
    // column it has no other use for.
    const tapeContributions: { adjusted: number; tape: number }[] = [];
    let tapeExcluded = 0;

    // The absence window shown at the top is the oldest acknowledgement across
    // the list: the user's real gap, not a per-symbol average.
    let oldestSeen = now;
    let anyRealWatermark = false;

    for (const item of items) {
      const symbol = item.symbol;
      const wm = marks.get(symbol);
      const watermarkTs =
        awayOverrideMs != null ? now - awayOverrideMs : (wm?.seen_ts ?? item.added_at);
      if (awayOverrideMs != null || (wm && wm.is_seed === 0)) {
        anyRealWatermark = true;
        oldestSeen = Math.min(oldestSeen, watermarkTs);
      }

      const q = this.quotes.get(symbol);
      const isIndex = symbol.startsWith("^");
      const assessment = assess(
        {
          symbol,
          ltp: q?.ltp ?? null,
          prevClose: q?.prevClose ?? null,
          exchangeTs: q?.exchangeTs ?? null,
          ingestTs: q?.ingestTs ?? null,
        },
        {
          now,
          session,
          cadenceMs: this.provider.cadenceMs,
          universeFreshestTs: freshest,
          providerFailure: this.quotes.failureFor(symbol),
          // A wide sanity band, not the regulatory one. Its job is to reject
          // values that are not prices; genuine large moves are the detector's
          // problem, and it has better language for them than "suspect".
          circuitBand: SANITY_BAND,
        },
      );

      if (assessment.quality === "UNAVAILABLE") unavailable++;
      else if (!assessment.usableForSignals) degraded++;

      const baseline = this.baselineFor(symbol);
      const actions = this.actionsFor(symbol);

      // Prefer the price recorded at acknowledgement, because the number the
      // user actually saw cannot be re-adjusted underneath us and a recorded
      // series can.
      //
      // This comment used to rate the oracle fallback "correct but weaker",
      // which was an R6: it named the mechanism and then misreported the
      // consequence. The fallback was not weaker, it was wrong by 1/sf across
      // any split. The oracle serves daily closes back-adjusted to the end of
      // their series, decomposeReturn() restates the from price by the split
      // again, and the seeded `meera` account's rank-1 card read
      // "KOTAKBANK +394.78%" on a holding that was down 1.2% over the window.
      // That is fixed where the terms are known -- PriceOracle.priceAt now
      // returns the quote of the day and carries the measurement -- and the
      // sentence is corrected here rather than deleted, because the next reader
      // of this fallback is the person the old sentence would have reassured.
      //
      // Both branches below therefore hand decomposeReturn() a real quoted
      // price, and the preference above is now what it always claimed to be: a
      // choice between two correct numbers, one of which is the one the user
      // was shown.
      const watermarkPrice =
        awayOverrideMs != null
          ? (this.oracle.priceAt(symbol, watermarkTs)?.price ?? null)
          : (wm?.seen_price ?? this.oracle.priceAt(symbol, watermarkTs)?.price ?? null);

      const marketReturn =
        symbol === INDEX_SYMBOL ? null : this.oracle.returnBetween(INDEX_SYMBOL, watermarkTs, now);

      const found = detect({
        symbol,
        now,
        watermarkTs,
        watermarkPrice,
        price: q?.ltp ?? null,
        prevClose: q?.prevClose ?? null,
        exchangeTs: q?.exchangeTs ?? null,
        dayVolume: q?.volume ?? null,
        // The worst single session inside the window, which is what tells a
        // demerger apart from a long decline. Falls back inside detect() to the
        // move against the previous close when no path is known.
        maxSessionMove: this.oracle.maxSessionMove(symbol, watermarkTs, now),
        assessment,
        baseline,
        actions,
        marketReturn,
        circuitBand: isIndex ? INDEX_CIRCUIT_BAND : DEFAULT_CIRCUIT_BAND,
        policy,
      });
      signals.push(...found);

      const dec = decomposeReturn(watermarkPrice, watermarkTs, q?.ltp ?? null, q?.exchangeTs ?? now, actions);

      // The index is not a constituent of its own average. It is the tape, so
      // counting it as a symbol whose move the tape explains would put a
      // guaranteed share of 1.0 into the mean and pull the answer toward
      // "it was all the market" by exactly one name's worth, on every list.
      if (isIndex) {
        // Not counted as excluded either: excluding the index is a property of
        // what the number means, not a gap in the data, and folding it into the
        // "we could not measure these" count would misreport a deliberate
        // choice as a measurement failure.
      } else if (dec.adjusted != null && baseline.beta != null && marketReturn != null) {
        // `beta * marketReturn` -- the same product the MARKET row of this
        // symbol's own attribution prints on its card, so the rollup and the
        // cards under it cannot tell the reader two different stories about
        // what the tape did to this name.
        tapeContributions.push({ adjusted: dec.adjusted, tape: baseline.beta * marketReturn });
      } else {
        tapeExcluded++;
      }

      rows.push({
        symbol,
        name: this.nameFor(symbol),
        price: q?.ltp ?? null,
        prevClose: q?.prevClose ?? null,
        changeToday: ret(q?.prevClose ?? null, q?.ltp ?? null),
        changeSinceSeen: dec.adjusted,
        rawSinceSeen: dec.raw,
        watermarkTs,
        watermarkPrice,
        quality: assessment.quality,
        qualityReason: assessment.reason,
        ageMs: assessment.ageMs,
        displayable: assessment.displayable,
        week52High: baseline.week52High,
        week52Low: baseline.week52Low,
        dailyVol: baseline.dailyVol,
        beta: baseline.beta,
        observations: baseline.observations,
        corporateActions: dec.actions.length,
      });
    }

    const windowFrom = anyRealWatermark ? oldestSeen : lastRegularClose(now);
    const absence = describeAbsence(windowFrom, now, !anyRealWatermark);
    const marketReturn = this.oracle.returnBetween(INDEX_SYMBOL, windowFrom, now);

    const qty = new Map(items.map((i) => [i.symbol, i.quantity]));
    const ranked = rank({
      signals,
      policy,
      lastShownAt: store.lastShownMap(this.db, userId),
      now,
      marketReturn,
      marketSymbol: INDEX_SYMBOL,
      marketLabel: INDEX_LABEL,
      // A move in something you actually hold outranks the same move in
      // something you are only curious about. Capped, so one large position
      // cannot monopolise the digest.
      weightOf: (s) => {
        const q = qty.get(s);
        return q && q > 0 ? Math.min(1.5, 1 + Math.log10(1 + q) / 6) : 1;
      },
    });

    const digest = buildDigest({
      now,
      absence,
      cards: ranked.surfaced,
      suppressed: ranked.suppressed,
      market: ranked.market,
      coverage: {
        symbolsWatched: items.length,
        evaluated: items.length - unavailable,
        degraded,
        unavailable,
      },
    });

    const paths: Record<string, PathPoint[]> = {};
    const narratives: Record<string, ReturnType<typeof narrate>> = {};
    for (const c of ranked.surfaced) {
      const p = this.oracle.pathBetween(c.symbol, c.windowFrom, c.windowTo);
      paths[c.symbol] = p;
      if (digest.mode === "NARRATIVE") narratives[c.symbol] = narrate(p);
    }

    return {
      digest,
      rows,
      paths,
      narratives,
      tape: rollUpTape(tapeContributions, tapeExcluded),
      session: {
        ...session,
        unexpectedlyQuiet: detectUnexpectedlyQuiet(session, freshest, now),
      },
      sessionBands: sessionBands(windowFrom, now),
      policy,
    };
  }

  /**
   * Compute, then record. The write path.
   *
   * Events are the durable record of what the system decided; whether this user
   * has been shown them is tracked separately in `event_reads`, and only
   * advances when the client acknowledges.
   */
  buildDigestFor(userId: string): DigestResponse {
    const result = this.computeDigest(userId);
    const now = this.clock.now();
    for (const c of result.digest.cards) {
      store.recordEvent(this.db, {
        user_id: userId,
        symbol: c.symbol,
        kind: c.kind,
        dedupe_key: c.dedupeKey,
        window_from: c.windowFrom,
        window_to: c.windowTo,
        strength: c.strength,
        payload: JSON.stringify(c),
        created_at: now,
      });
    }
    return result;
  }

  /**
   * Acknowledge that a user has seen the current state of these symbols.
   *
   * Separate from reading the digest on purpose. Fetching a page is not the
   * same as a person having looked at it: a background refresh, a preload, or a
   * tab restored on a phone in a pocket would all silently swallow news if the
   * read itself advanced the watermark.
   */
  acknowledge(userId: string, symbols: string[], device: string): { advanced: string[]; alreadyAhead: string[] } {
    const now = this.clock.now();
    const advanced: string[] = [];
    const alreadyAhead: string[] = [];
    for (const symbol of symbols) {
      const q = this.quotes.get(symbol);
      // Acknowledge at the later of the last trade and now.
      //
      // Using the exchange timestamp alone looks more principled and is wrong:
      // a watchlist entry is seeded with a watermark at wall-clock time, every
      // exchange timestamp is older than that by construction, and the
      // monotonic guard then rejects the write. The result was that the primary
      // interaction in the product -- the button that says you have looked at
      // this -- silently did nothing on the first click, and did nothing at all
      // while the market was shut, which is when the app is most often opened.
      const seenTs = Math.max(q?.exchangeTs ?? 0, now);
      const ok = store.advanceWatermark(this.db, userId, symbol, seenTs, q?.ltp ?? null, device, now);
      (ok ? advanced : alreadyAhead).push(symbol);
    }
    const keys = store
      .recentEvents(this.db, userId, 200)
      .filter((e) => symbols.includes(e.symbol))
      .map((e) => e.dedupe_key);
    if (keys.length) store.markShown(this.db, userId, keys, now);
    return { advanced, alreadyAhead };
  }

  /**
   * Drop the hot quotes when the lab moves the clock backwards.
   *
   * The store rejects any print older than the one it holds, which is correct
   * for a real feed and exactly wrong for time travel: after a rewind every
   * cached quote carries an exchange timestamp in the future, and the quality
   * layer dutifully reports clock skew across the whole watchlist. Rather than
   * weaken the monotonic guard — which exists precisely so a re-delivered old
   * print cannot walk a price backwards — the lab discards the cache and lets
   * it refill from the new position. Time only runs backwards here.
   */
  rewindQuotesIfClockWentBack(previousNow: number): void {
    if (this.clock.now() < previousNow - 1000) this.quotes.clear();
  }

  setFault(f: Fault): void {
    this.replay?.setFault(f);
  }

  currentFault(): Fault {
    return this.replay?.currentFault() ?? NO_FAULT;
  }

  status() {
    const now = this.clock.now();
    return {
      mode: this.mode,
      now,
      clock: this.clock.state(),
      session: sessionAt(now),
      ingest: this.worker.stats(),
      replay: this.replay?.hasData()
        ? {
            from: this.replay.from,
            to: this.replay.to,
            symbols: this.replay.symbolsAvailable().length,
            // What is being replayed, and in how many sittings. A reader who
            // asks whether this works on any day other than the recorded one
            // gets the answer off the status endpoint and the header badge,
            // rather than from a claim in a README.
            recordings: this.recordings,
            segments: this.replay.segments(),
          }
        : null,
      fault: this.currentFault(),
      universe: this.history.size,
      // The day the baselines were measured from, beside the day the clock is
      // in. They are the same on the canonical recording and they are not the
      // same the moment TICKS= points at a session captured later, because
      // TICKS= reloads the tape and not data/history.
      historyAsOf: this.historyAsOf,
      baselines: this.baselines.size,
      adjustmentMismatches: this.adjustmentMismatches,
    };
  }

  close(): void {
    this.worker.stop();
    this.db.close();
  }
}

export { store };
export type { Clock, RankedSignal, Suppressed, MarketContext };
