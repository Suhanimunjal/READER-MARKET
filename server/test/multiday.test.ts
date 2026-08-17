/**
 * A second recorded day.
 *
 * The question these pin is the one the finals will ask out loud: does this
 * only work on the day you recorded? The answer is supposed to be that the
 * product boots against any recording, so the plumbing that makes that true has
 * to be tested -- and it has to be testable before a second capture exists,
 * because the market is shut and the finals are not waiting for it.
 *
 * So the fixture is synthetic and lives in a temp directory: two files, two
 * sittings a day apart, two symbols, arithmetic prices. It is not pretending to
 * be a market. Every claim below is about the plumbing -- how files pool, where
 * the gap falls, which print is served across it, and where the clock lands --
 * and none of them is about a price, so invented prices cost nothing here.
 *
 * data/ticks.jsonl is read but never written: the single-file assertions at the
 * bottom are the ones that say today's behaviour is unchanged, and they have to
 * run against the real recording to say it.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, store } from "../src/app.js";
import { ReplayProvider, SEGMENT_GAP_MS } from "../src/data/replay.js";
import { istAt } from "../src/core/calendar.js";
import { toPaise } from "../src/core/money.js";
import type { Clock } from "../src/core/clock.js";

const ROOT = join(process.cwd(), "..");
const CANONICAL = join(ROOT, "data", "ticks.jsonl");

const DAY_ONE = "2026-09-10";
const DAY_TWO = "2026-09-11";
const OPEN = 9 * 60 + 15;
const CADENCE_S = 40;
const POLLS = 6;
const SYMBOLS = ["AAA", "BBB"];

/** Epoch seconds of poll `i` of the sitting recorded on `date`. */
const pollTs = (date: string, i: number) => istAt(date, OPEN) / 1000 + i * CADENCE_S;

/**
 * One sitting, in the recorder's own line format.
 *
 * Symbols are written interleaved within a poll, which is what the recorder
 * does and which is the shape the per-symbol sort in ReplayProvider has to cope
 * with when two files are concatenated.
 *
 * One simplification, stated because a segment's `points` is asserted below:
 * both symbols here share a poll's timestamp, where tools/record.py stamps each
 * snapshot with its own `time.time()`. segments() works off de-duplicated
 * instants, so the two shapes give the same boundaries; only the `points` count
 * differs, and it is the count of instants in either case.
 */
function sitting(date: string, base: number): string {
  const lines: string[] = [];
  for (let i = 0; i < POLLS; i++) {
    const ts = pollTs(date, i);
    SYMBOLS.forEach((sym, j) => {
      const ltp = base + j * 100 + i;
      lines.push(
        JSON.stringify({
          sym,
          poll_ts: ts,
          // Two seconds behind the poll, as a real print is: this is the
          // timestamp the staleness assertion below is about, and it has to be
          // distinguishable from the poll instant to mean anything.
          mkt_ts: ts - 2,
          ltp,
          prev_close: base + j * 100,
          day_high: ltp + 1,
          day_low: base + j * 100 - 1,
          vol: 1000 + i,
          w52_high: ltp + 50,
          w52_low: ltp - 50,
        }),
      );
    });
  }
  return lines.join("\n") + "\n";
}

const DIR = mkdtempSync(join(tmpdir(), "marketreader-multiday-"));
const FILE_ONE = join(DIR, "ticks-2026-09-10.jsonl");
const FILE_TWO = join(DIR, "ticks-2026-09-11.jsonl");
writeFileSync(FILE_ONE, sitting(DAY_ONE, 100));
writeFileSync(FILE_TWO, sitting(DAY_TWO, 200));

/** Exists, holds bytes, yields nothing. The shape of a typo that survives
 *  existsSync: an empty capture, a half-written line, the wrong format. */
/**
 * A sitting recorded BEFORE the last daily bar in data/history.
 *
 * The two above are both dated after it, which is why the pair of them agreeing
 * on volatility and beta was mistaken for the figures being fixed. This one is
 * the other side of that boundary, and it is what makes the divergence
 * assertable rather than only the agreement.
 */
const FILE_EARLY = join(DIR, "ticks-2026-09-02.jsonl");
writeFileSync(FILE_EARLY, sitting("2026-09-02", 300));

const FILE_EMPTY = join(DIR, "ticks-empty.jsonl");
const FILE_UNPARSEABLE = join(DIR, "ticks-unparseable.jsonl");
writeFileSync(FILE_EMPTY, "");
writeFileSync(FILE_UNPARSEABLE, "sym,poll_ts,ltp\r\nAAA,1788000000,100\r\n");

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const FIRST_POLL_ONE = pollTs(DAY_ONE, 0) * 1000;
const LAST_POLL_ONE = pollTs(DAY_ONE, POLLS - 1) * 1000;
const FIRST_POLL_TWO = pollTs(DAY_TWO, 0) * 1000;
const LAST_POLL_TWO = pollTs(DAY_TWO, POLLS - 1) * 1000;

/** A clock that stands where it is put. The provider only ever reads it. */
function fixedClock(at: number): Clock & { at: number } {
  const c: Clock & { at: number } = { at, now: () => c.at };
  return c;
}

/** The landing formula as app.ts computed it when there was one file, written
 *  out here rather than imported, so the comparison is against the old
 *  expression and not against the new one renamed. */
const oldLanding = (from: number, to: number) => from + Math.min((to - from) * 0.35, to - from);

// ---------------------------------------------------------------------------

describe("two recordings, pooled into one provider", () => {
  it("splits them into a sitting each, at the overnight gap rather than at the file boundary", () => {
    const p = ReplayProvider.fromFiles(fixedClock(FIRST_POLL_TWO), [FILE_ONE, FILE_TWO]);
    const segs = p.segments();

    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ from: FIRST_POLL_ONE, to: LAST_POLL_ONE, points: POLLS });
    expect(segs[1]).toEqual({ from: FIRST_POLL_TWO, to: LAST_POLL_TWO, points: POLLS });

    // The gap they were split on is the overnight one, and it is the only gap
    // in the fixture over the threshold: the polls inside a sitting are 40s
    // apart. Asserted rather than assumed, because a segments() that split on
    // every poll would also have produced "more than one segment".
    expect(FIRST_POLL_TWO - LAST_POLL_ONE).toBeGreaterThan(SEGMENT_GAP_MS);
    expect(CADENCE_S * 1000).toBeLessThan(SEGMENT_GAP_MS);
  });

  it("does not care what order the files were read in", () => {
    // The constructor sorts each symbol's ticks by poll_ts and nothing reads
    // the order it was handed, so the newer file arriving first is the same
    // recording. This is the property fromFiles() relies on for interleaving.
    const forward = ReplayProvider.fromFiles(fixedClock(FIRST_POLL_TWO), [FILE_ONE, FILE_TWO]);
    const backward = ReplayProvider.fromFiles(fixedClock(FIRST_POLL_TWO), [FILE_TWO, FILE_ONE]);

    expect(backward.segments()).toEqual(forward.segments());
    expect(backward.from).toBe(forward.from);
    expect(backward.to).toBe(forward.to);
  });

  it("counts one segment for a single file, whichever one", () => {
    expect(ReplayProvider.fromFiles(fixedClock(LAST_POLL_ONE), [FILE_ONE]).segments()).toEqual([
      { from: FIRST_POLL_ONE, to: LAST_POLL_ONE, points: POLLS },
    ]);
    // And fromFile is the same code path now, not a second one that agrees.
    expect(ReplayProvider.fromFile(fixedClock(LAST_POLL_ONE), FILE_ONE).segments()).toEqual([
      { from: FIRST_POLL_ONE, to: LAST_POLL_ONE, points: POLLS },
    ]);
  });

  it("skips a named recording that is not there rather than refusing to boot", () => {
    const p = ReplayProvider.fromFiles(fixedClock(FIRST_POLL_TWO), [
      join(DIR, "ticks-2026-09-09.jsonl"),
      FILE_ONE,
    ]);
    expect(p.hasData()).toBe(true);
    expect(p.sources.map((s) => s.path)).toEqual([FILE_ONE]);
  });

  it("treats a file that exists but holds no parseable tick the same as one that is missing", () => {
    // The condition index.ts refuses to boot on, pinned here because the check
    // itself lives in an entry point that cannot be imported without starting a
    // server. Both files are on disk, so existsSync -- the only guard there used
    // to be -- says yes to both, and the measured consequence of carrying on was
    // a live-provider boot whose sole tell was one word in the banner.
    for (const path of [FILE_EMPTY, FILE_UNPARSEABLE]) {
      expect(existsSync(path)).toBe(true);
      const p = ReplayProvider.fromFiles(fixedClock(FIRST_POLL_ONE), [path]);
      expect(p.hasData()).toBe(false);
      expect(p.sources).toEqual([]);
    }

    // And with something real beside it, the pair is still a working boot: the
    // empty file drops out of `sources` and the recording that loaded carries
    // on. That is the case the refusal must not catch.
    const mixed = ReplayProvider.fromFiles(fixedClock(FIRST_POLL_ONE), [FILE_EMPTY, FILE_ONE]);
    expect(mixed.hasData()).toBe(true);
    expect(mixed.sources.map((s) => s.path)).toEqual([FILE_ONE]);
  });

  it("keeps each file's own span, so an instant can be traced to a recording", () => {
    const p = ReplayProvider.fromFiles(fixedClock(FIRST_POLL_TWO), [FILE_ONE, FILE_TWO]);
    expect(p.sources).toEqual([
      { path: FILE_ONE, from: FIRST_POLL_ONE, to: LAST_POLL_ONE, ticks: POLLS * SYMBOLS.length },
      { path: FILE_TWO, from: FIRST_POLL_TWO, to: LAST_POLL_TWO, ticks: POLLS * SYMBOLS.length },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("a quote asked for in the middle of the night between two sittings", () => {
  it("serves the previous sitting's last print, stamped when it printed", async () => {
    // 02:00 on the second day: the first sitting closed hours ago and the
    // second has not opened. tickAt's binary search is what answers this, and
    // what it answers with is the last print at or before the instant asked
    // about -- unchanged by pooling two days behind it.
    const clock = fixedClock(istAt(DAY_TWO, 2 * 60));
    const p = ReplayProvider.fromFiles(clock, [FILE_ONE, FILE_TWO]);

    const r = await p.fetchQuotes(["AAA"]);
    const q = r.quotes.get("AAA")!;

    expect(q).toBeDefined();
    expect(q.ltp).toBe(toPaise(100 + (POLLS - 1))); // the first day's final print
    // Its own timestamp, not the instant it was asked for and not the poll
    // instant: two seconds behind the last poll of the first sitting, which is
    // what the fixture wrote. A quote served across the gap is therefore hours
    // old and the quality layer can say so.
    expect(q.exchangeTs).toBe(LAST_POLL_ONE - 2000);
    expect(clock.now() - q.exchangeTs!).toBeGreaterThan(9 * 3600_000);
  });

  it("moves on to the second sitting's prints once the clock is inside it", async () => {
    // The other half of the claim above: a search that always answered with the
    // first day's close would pass the previous test and be useless.
    const clock = fixedClock(pollTs(DAY_TWO, 3) * 1000);
    const p = ReplayProvider.fromFiles(clock, [FILE_ONE, FILE_TWO]);

    const q = (await p.fetchQuotes(["AAA"])).quotes.get("AAA")!;
    expect(q.ltp).toBe(toPaise(200 + 3));
    expect(q.exchangeTs).toBe(pollTs(DAY_TWO, 3) * 1000 - 2000);
  });
});

// ---------------------------------------------------------------------------

describe("the clock the product boots onto", () => {
  /** The virtual clock runs at speed 1, so it has moved by the time it is read.
   *  Everything below allows for that and nothing below allows for more. */
  const SLACK_MS = 5_000;

  it("lands in the last sitting, not in the night in the middle of the pool", () => {
    const app = new App({
      dataDir: DIR,
      dbPath: ":memory:",
      mode: "replay",
      ticksPaths: [FILE_ONE, FILE_TWO],
    });
    const now = app.clock.now();

    expect(now).toBeGreaterThanOrEqual(FIRST_POLL_TWO);
    expect(now).toBeLessThanOrEqual(LAST_POLL_TWO);
    // And at the same relative position inside that sitting as the single-file
    // formula put it inside its one sitting.
    expect(Math.abs(now - oldLanding(FIRST_POLL_TWO, LAST_POLL_TWO))).toBeLessThan(SLACK_MS);

    // Pooling the whole recording instead would have landed in the gap between
    // the two sittings: a shut market, with the first day's prices ageing on
    // screen. Named, so the test says what it is defending against and not only
    // what it wants.
    const pooledLanding = oldLanding(FIRST_POLL_ONE, LAST_POLL_TWO);
    expect(pooledLanding).toBeLessThan(FIRST_POLL_TWO);
    expect(Math.abs(now - pooledLanding)).toBeGreaterThan(SLACK_MS);

    app.close();
  });

  it("publishes the recordings in play and their sittings", () => {
    const app = new App({
      dataDir: DIR,
      dbPath: ":memory:",
      mode: "replay",
      ticksPaths: [FILE_ONE, FILE_TWO],
    });
    const s = app.status();

    expect(s.replay).not.toBeNull();
    expect(s.replay!.recordings.map((r) => r.file)).toEqual([
      "ticks-2026-09-10.jsonl",
      "ticks-2026-09-11.jsonl",
    ]);
    // Neither is data/ticks.jsonl, which is what the header badge keys on.
    expect(s.replay!.recordings.some((r) => r.canonical)).toBe(false);
    expect(s.replay!.segments).toHaveLength(2);
    // Basenames only: the absolute path is a property of the machine serving
    // and this response goes to a browser.
    expect(JSON.stringify(s.replay!.recordings)).not.toContain(DIR);

    app.close();
  });

  it("lands a single synthetic file exactly where the single-file formula did", () => {
    const app = new App({
      dataDir: DIR,
      dbPath: ":memory:",
      mode: "replay",
      ticksPaths: [FILE_ONE],
    });

    expect(app.replay!.segments()).toHaveLength(1);
    expect(
      Math.abs(app.clock.now() - oldLanding(app.replay!.from, app.replay!.to)),
    ).toBeLessThan(SLACK_MS);

    app.close();
  });
});

// ---------------------------------------------------------------------------

describe("re-laying the demo accounts when the recording underneath changes", () => {
  it("remembers which clock a database was seeded against", () => {
    // Stored rather than inferred from the watermarks, because those sit 3 to
    // 240 days before the seeding clock by design: "is this watermark inside
    // the loaded recording" answers no on every correct boot too.
    const db = store.openDb(":memory:");
    expect(store.getMeta(db, "seed_clock_ms")).toBeNull();
    store.setMeta(db, "seed_clock_ms", String(FIRST_POLL_ONE));
    expect(store.getMeta(db, "seed_clock_ms")).toBe(String(FIRST_POLL_ONE));
    store.setMeta(db, "seed_clock_ms", String(FIRST_POLL_TWO));
    expect(store.getMeta(db, "seed_clock_ms")).toBe(String(FIRST_POLL_TWO));
    db.close();
  });

  it("puts a demo watermark back to an earlier day, where advancing one refuses", () => {
    // Booting yesterday's recording after today's has to move these backwards.
    // advanceWatermark is monotonic on purpose -- it represents a person
    // acknowledging something -- so routing the re-lay through it would write
    // nothing, report nothing, and leave an anchor from a session the provider
    // is no longer holding. Same wrong number, different route.
    const db = store.openDb(":memory:");
    store.upsertUser(db, { id: "demo", name: "Demo", policy: "balanced", created_at: 0 });
    store.addWatch(db, "demo", "AAA", 0, null);

    store.layDemoWatermark(db, "demo", "AAA", FIRST_POLL_TWO, 20_000, "seed-demo", FIRST_POLL_TWO);
    expect(store.getWatermarks(db, "demo").get("AAA")!.seen_ts).toBe(FIRST_POLL_TWO);

    expect(
      store.advanceWatermark(db, "demo", "AAA", FIRST_POLL_ONE, 10_000, "seed-demo", FIRST_POLL_ONE),
    ).toBe(false);
    expect(store.getWatermarks(db, "demo").get("AAA")!.seen_ts).toBe(FIRST_POLL_TWO);

    store.layDemoWatermark(db, "demo", "AAA", FIRST_POLL_ONE, 10_000, "seed-demo", FIRST_POLL_ONE);
    const w = store.getWatermarks(db, "demo").get("AAA")!;
    expect(w.seen_ts).toBe(FIRST_POLL_ONE);
    expect(w.seen_price).toBe(10_000);
    db.close();
  });

  /**
   * What index.ts stores and compares, and why it cannot be `clock.now()`.
   *
   * The guard compared the stored value against `app.clock.now()`. VirtualClock
   * is seeked to App.landingInstant in App's constructor and then runs in real
   * time while the history loads and the baselines are fitted, so `now` is
   * landingInstant plus however long boot took -- never the same twice.
   * Measured on three consecutive boots of one untouched recording and one
   * database: 92 ms apart, then 42 ms apart and backwards. Every restart
   * therefore counted as a different recording and re-laid the seeded
   * watermarks, which discarded any acknowledgement made through /api/ack on
   * those accounts, on the default path with no TICKS involved.
   *
   * This is the property that makes the fix work, so it is asserted directly:
   * the landing instant is a pure function of the pooled poll times, equal
   * across boots of the same recording and different across recordings, while
   * `clock.now()` is neither.
   */
  it("anchors the seeded accounts to the tape, which is the same number on every boot", () => {
    const a = new App({ dataDir: DIR, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_ONE] });
    const b = new App({ dataDir: DIR, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_ONE] });
    const other = new App({ dataDir: DIR, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_TWO] });

    // Exactly equal, not nearly: this value is stored as text and compared with
    // ===, so "close enough" is what the bug was.
    expect(App.landingInstant(b.replay!)).toBe(App.landingInstant(a.replay!));
    // And the clock the guard used to compare is not, which is the defect in
    // one line. Two boots of one file, and the two numbers differ.
    expect(b.clock.now()).not.toBe(a.clock.now());
    // Still discriminating, which is the half that has to survive the fix.
    expect(App.landingInstant(other.replay!)).not.toBe(App.landingInstant(a.replay!));

    a.close();
    b.close();
    other.close();
  });
});

// ---------------------------------------------------------------------------

describe("a named recording that exists and yields nothing", () => {
  /**
   * The state index.ts reads to warn per path.
   *
   * `sources` is the list of files that actually contributed, and a file
   * yielding no tick is kept out of it by the `n > 0` guard in fromFiles. That
   * absence is what index.ts diffs TICKS against, so it is pinned here: before
   * the warning existed, a set of two where one file was empty booted on the
   * other one and wrote nothing at all to stderr, which is verbatim the harm
   * the missing-file loop in index.ts was added to prevent.
   */
  it("is kept out of sources while the recording beside it still loads", () => {
    for (const bad of [FILE_EMPTY, FILE_UNPARSEABLE]) {
      const p = ReplayProvider.fromFiles(fixedClock(FIRST_POLL_ONE), [FILE_ONE, bad]);
      expect(p.hasData()).toBe(true);
      expect(p.sources.map((s) => s.path)).toEqual([FILE_ONE]);
      // So the diff index.ts does finds exactly the one path that contributed
      // nothing, rather than nothing at all.
      expect([FILE_ONE, bad].filter((x) => !p.sources.some((s) => s.path === x))).toEqual([bad]);
    }
  });
});

// ---------------------------------------------------------------------------

const canonical = existsSync(CANONICAL) ? describe : describe.skip;
const withHistory = existsSync(join(ROOT, "data", "history")) ? describe : describe.skip;

withHistory("what TICKS does not move", () => {
  /**
   * The honest scope of "boots against another day".
   *
   * TICKS reloads the tape. It does not reload data/history, and the baselines
   * live there -- volatility, beta, the 52-week band and the corporate-action
   * feed are all fitted to those daily bars. Two sentences in this repo used to
   * say every number was measured again from that day's prices, and measured,
   * two synthetic days produced per-symbol volatility and beta agreeing to the
   * last digit. These pin the true statement in both directions: the clock
   * moves, the history does not, and the process says so.
   */
  const dataDir = join(ROOT, "data");

  it("leaves the baseline bars where they are however far the clock travels", () => {
    const one = new App({ dataDir, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_ONE] });
    const two = new App({ dataDir, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_TWO] });

    // A day apart on the clock.
    expect(two.clock.now() - one.clock.now()).toBeGreaterThan(20 * 3600_000);
    // And identical underneath, because the bars behind them did not move.
    expect(one.historyAsOf).toBe(two.historyAsOf);
    expect(one.status().historyAsOf).toBe(one.historyAsOf);
    expect(one.historyAsOf).not.toBeNull();

    one.close();
    two.close();
  });

  /**
   * The assertion the doc blocks claimed to be making, and were not.
   *
   * Three sentences in this repo -- README.md, the TICKS comment in index.ts,
   * and ReplayProvider.fromFiles -- said per-symbol vol and beta came out
   * identical across two recordings "because the bars behind them did not
   * move". The observation was real; the reason was not, and the test standing
   * behind it ("leaves the baseline bars where they are...", above) compared
   * only `historyAsOf`. It never read a vol or a beta, and both its fixtures
   * are dated after the last bar, so it could not have caught the case it was
   * cited for.
   *
   * The mechanism is that computeBaseline filters bars at `asOf`
   * (core/baseline.ts) and app.ts passes `asOf: this.clock.now()`. The bars are
   * fixed; the window of them in the fit is not. So the two recordings agree
   * exactly when both clocks sit past the last bar, and diverge when they
   * straddle it -- which is the canonical day against the day after it, the
   * first comparison anyone makes.
   */
  const SAMPLE = ["TATASTEEL", "RELIANCE", "INFY"] as const;

  it("fits the baselines to the bars the clock can see, so straddling the last one moves them", () => {
    const early = new App({ dataDir, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_EARLY] });
    const late = new App({ dataDir, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_TWO] });

    // The fixture is on the near side of the last bar and FILE_TWO is past it,
    // which is the whole construction. Asserted, because a data/history refresh
    // that moved the last bar past both would turn every assertion below into a
    // comparison of two identical things that passes for the wrong reason.
    expect(early.historyAsOf).not.toBeNull();
    expect(early.clock.now()).toBeLessThan(early.historyAsOf!);
    expect(late.clock.now()).toBeGreaterThan(late.historyAsOf!);
    // And the bars themselves did not move, so nothing below can be blamed on
    // the history having been reloaded.
    expect(early.historyAsOf).toBe(late.historyAsOf);

    for (const sym of SAMPLE) {
      const a = early.baselineFor(sym);
      const b = late.baselineFor(sym);
      expect(a.observations, `${sym} has no history to fit`).toBeGreaterThan(0);
      // The cut-off the fit actually used, which is the quantity that moved.
      expect(a.asOf, `${sym} baseline asOf did not move with the clock`).not.toBe(b.asOf);
      expect(a.dailyVol, `${sym} daily vol is invariant to the recording`).not.toBe(b.dailyVol);
    }

    early.close();
    late.close();
  });

  it("leaves them identical to the last digit when both clocks land past that bar", () => {
    const one = new App({ dataDir, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_ONE] });
    const two = new App({ dataDir, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_TWO] });

    expect(one.clock.now()).toBeGreaterThan(one.historyAsOf!);
    expect(two.clock.now()).toBeGreaterThan(two.historyAsOf!);
    expect(two.clock.now() - one.clock.now()).toBeGreaterThan(20 * 3600_000);

    for (const sym of SAMPLE) {
      const a = one.baselineFor(sym);
      const b = two.baselineFor(sym);
      expect(a.observations).toBeGreaterThan(0);
      expect(a.asOf).toBe(b.asOf);
      expect(a.dailyVol, `${sym} daily vol`).toBe(b.dailyVol);
      expect(a.beta, `${sym} beta`).toBe(b.beta);
    }

    one.close();
    two.close();
  });

  it("says so on stderr once the clock is more than a session past the last bar", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    // The synthetic sittings are days after the last bar in data/history, which
    // is the situation a genuine second capture puts the product in.
    const app = new App({ dataDir, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_TWO] });
    spy.mockRestore();

    const warning = lines.find((l) => l.startsWith("[history]"));
    expect(warning).toBeDefined();
    expect(warning).toContain(new Date(app.historyAsOf!).toISOString());
    expect(warning).toContain("TICKS does not reload them");
    app.close();
  });

  /**
   * The feed behind the cards a second-day demo actually gets.
   *
   * Three doc blocks -- README.md, the TICKS comment in index.ts and
   * ReplayBadge in web/src/workspace/Shell.tsx -- used to say that restarting
   * against another recording shows "nothing carries over between the two
   * days". Measured against two boots holding separate databases, the 90-day
   * preview for `demo` returns the same five CORPORATE_ACTION cards, in the same
   * order, each reading "dividend in this window": they come from the split and
   * dividend feed in data/history, which TICKS does not touch and neither boot
   * reloads. What a restart rebuilds is process state -- the quote store, the
   * clock, the seeded watermarks -- and that is all those three now claim.
   *
   * Asserted on the feed rather than on a digest because the feed is the input
   * the cards are built from; the sentences were wrong about the input.
   */
  const ACTION_SAMPLE = ["TATASTEEL", "HDFCBANK", "NESTLEIND", "KOTAKBANK"] as const;

  it("hands both recordings the same split and dividend feed, a day apart on the clock", () => {
    const one = new App({ dataDir, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_ONE] });
    const two = new App({ dataDir, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_TWO] });

    expect(two.clock.now() - one.clock.now()).toBeGreaterThan(20 * 3600_000);

    let dividends = 0;
    let splits = 0;
    for (const sym of ACTION_SAMPLE) {
      const a = one.actionsFor(sym);
      const b = two.actionsFor(sym);
      // Guarded: an empty feed on both sides would satisfy the equality below
      // while pinning nothing at all.
      expect(a.dividends.length + a.splits.length, `${sym} has no actions to compare`).toBeGreaterThan(0);
      expect(b, `${sym} corporate actions moved with the recording`).toEqual(a);
      dividends += a.dividends.length;
      splits += a.splits.length;
    }
    expect(dividends, "no dividends in the sample").toBeGreaterThan(0);
    expect(splits, "no splits in the sample").toBeGreaterThan(0);

    one.close();
    two.close();
  });
});

const withBoth =
  existsSync(CANONICAL) && existsSync(join(ROOT, "data", "history")) ? describe : describe.skip;

withBoth("what a window shorter than the sitting measures against", () => {
  /**
   * Why the second day goes quiet at exactly the slider stops the README
   * advertises.
   *
   * A preview window shorter than the recorded sitting starts before the tape
   * does, so its anchor price comes from data/history rather than off a print.
   * Which bar that is depends on which side of the last one the clock sits, and
   * the two cases below are the two demos: the canonical recording, whose clock
   * is inside the last bar's session, anchors to the session before it; a
   * recording dated after the last bar -- which is every second capture until
   * data/history is refreshed -- anchors to the last bar itself.
   *
   * That is the collapse, measured before these were written. On the canonical
   * tape TATASTEEL's one-hour anchor is 18420, the 3 Sept close, and the card
   * reads +2.5% at 6.1 sigma. On the same recording re-stamped one day later
   * the anchor is 18909 -- the 4 Sept close, which is the session those very
   * prints are from -- so the window measures the session against its own close,
   * reads about -0.2%, and is held back under the 1.0% floor. demo's 1-hour
   * preview goes from 5 cards to 1, and the one is TATAMOTORS "has no data".
   *
   * Pinned on the anchor and not on a card count: the count is a property of
   * the policy thresholds and would move with a tuning change that leaves this
   * mechanism exactly where it is.
   */
  const dataDir = join(ROOT, "data");
  const HOUR = 3600_000;

  it("anchors an hour-long window before the last bar while the clock is inside that session", () => {
    const app = new App({ dataDir, dbPath: ":memory:", mode: "replay" });

    expect(app.historyAsOf).not.toBeNull();
    // The construction: the canonical clock has not reached the close of the
    // session it is replaying, so that session's bar is not visible yet.
    expect(app.clock.now()).toBeLessThan(app.historyAsOf!);

    const anchor = app.oracle.priceAt("TATASTEEL", app.clock.now() - HOUR);
    expect(anchor).not.toBeNull();
    expect(anchor!.observedAt).toBeLessThan(app.historyAsOf!);

    app.close();
  });

  it("anchors it to the last bar itself once the clock is past that session", () => {
    const app = new App({ dataDir, dbPath: ":memory:", mode: "replay", ticksPaths: [FILE_TWO] });

    expect(app.historyAsOf).not.toBeNull();
    expect(app.clock.now()).toBeGreaterThan(app.historyAsOf! + HOUR);

    // TATASTEEL is not in the synthetic fixture, so this is the history lookup
    // in isolation -- which is the lookup a real second capture gets too, for a
    // window that opens before its first print.
    const anchor = app.oracle.priceAt("TATASTEEL", app.clock.now() - HOUR);
    expect(anchor).not.toBeNull();
    expect(anchor!.observedAt).toBe(app.historyAsOf!);

    app.close();
  });
});

canonical("the canonical recording, after all of the above", () => {
  it("is still one sitting, and is still what boots by default", () => {
    // No ticksPaths at all: the default path every existing caller takes.
    const app = new App({ dataDir: join(ROOT, "data"), dbPath: ":memory:", mode: "replay" });

    expect(app.replay!.hasData()).toBe(true);
    expect(app.replay!.segments()).toHaveLength(1);
    expect(app.recordings).toHaveLength(1);
    expect(app.recordings[0]!.file).toBe("ticks.jsonl");
    expect(app.recordings[0]!.canonical).toBe(true);

    // The clock lands where the single-file formula put it, to within the few
    // milliseconds the virtual clock has run for since the constructor.
    expect(
      Math.abs(app.clock.now() - oldLanding(app.replay!.from, app.replay!.to)),
    ).toBeLessThan(5_000);

    // And the one segment covers the whole recording, which is the identity the
    // landing formula now goes through.
    expect(app.replay!.segments()[0]!.from).toBe(app.replay!.from);
    expect(app.replay!.segments()[0]!.to).toBe(app.replay!.to);

    app.close();
  });
});
