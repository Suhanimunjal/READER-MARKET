# MarketReader

A watchlist built around one question: what actually changed since *you* last
looked?

Prices are the easy part, and they're all on `/watch/all` with today's move,
σ/day, beta, 52-week range and a quote-age badge. But you already knew the price.
A watchlist that doesn't know when you last checked can only answer for a period
it picked itself.

So the window is a per-user watermark. Same market, same instant, different
answer depending on whether you've been gone ten minutes or a month. And
"meaningful" is measured against what each stock normally does, with the index
move taken out: a 3% day is 3.7σ of HDFCBANK's market-adjusted volatility and
1.9σ of SUZLON's. One of those is news. The other is a Tuesday.

Built for Code, by Groww.

```bash
npm install
npm run serve          # build + run on http://localhost:8787
```

No API key and no network needed. A real NSE session recorded on 4 September 2026
ships in `data/` and replays through a virtual clock, so it works at 3am on a
Sunday.

<!-- Screenshots: capture instructions in docs/SCREENSHOTS.md -->
<!-- ![The overview](docs/00-landing.png) -->

**Ninety seconds:** open `/` and drag the away-slider. Ten minutes gives one
card, an hour gives five, a week gives two — still cards, with a note saying the
window was summarised rather than replayed and a drawdown line under the card
that has one — and three months surfaces five corporate-action cards that exist
only because the window now contains their ex-dates. All computed live by
`/api/preview` against the recorded prices, none mocked. (The counts are what
the API returns; the hero lists at most four of them and counts the rest.) Then `/watch/held-back` for what it decided *not* to show you, and
`/lab` to break the feed.

If you read two sections, read [what counts as
meaningful](#what-counts-as-meaningful), which I measured after claiming it, and
[what review found](#what-review-found), which is what I got wrong.

---

## Setup

```bash
npm install
npm run serve                    # build + run, http://localhost:8787
MODE=live npm run serve          # network provider instead of the recording
TICKS=data/other-day.jsonl npm run serve   # replay a different recorded session
npm test                         # 146 tests in 5 files; ~8s, ~18s from cold
npm run dev                      # two processes: web :5173, API :8787
npm run demo:fresh               # delete the demo database, then build + run
```

`demo:fresh` exists because the demo is live and the database is the one piece of
state a rehearsal leaves behind: `/lab`'s rewind writes watermarks, and no reset
button undoes that. It removes `data/marketreader.db` and its `-wal`/`-shm`
sidecars — nothing else in `data/` — and boots. Measured at 16 seconds from the
command to a `200` on `/api/health`. The presenter's version of this, with the
per-beat fallbacks, is `docs/DEMO-CHECKLIST.md`.

Node `>=20.9 <23`. That range is declared in all three `package.json` files but
nothing enforces it, since there's no `.npmrc`. SQLite gets created on first boot
and there's nothing else to install.

If port 8787 is taken the server tells you and prints the override for your
shell. `PORT=8080 npm run serve` in bash or zsh, `$env:PORT=8080; npm run serve`
in PowerShell, `set PORT=8080 && npm run serve` in cmd.

Two gotchas worth knowing:

`PORT` only applies to `serve`. The dev proxy in `web/vite.config.ts` is pinned
to 8787, so moving the port under `npm run dev` gets you a UI talking to whatever
else happens to be on 8787 instead of the API it just started.

`npm test` needs to run from the repo root or from `server/`. Four of the test
files find `data/` relative to the working directory and quietly `describe.skip`
if they can't, which would leave you with a green suite that measured nothing.

Four accounts come seeded with a past, so a fresh clone opens onto a working
digest instead of a first-visit screen:

| Account | Policy | Away | Symbols |
| --- | --- | --- | --- |
| `demo` | balanced | 7 days | 15 |
| `asha` | signal | 3 days | 12 |
| `ravi` | everything | 30 days | 10 |
| `meera` | balanced | 240 days | 7 |

Switch between them in the header. One market seen through three short absences
is the fastest way to get the idea.

`meera` is there for one row rather than for the idea. The five-part breakdown's
interaction term is `(split factor − 1) × the holder's move`, so it is exactly
zero on any window without a split in it — and with the replay clock at
2026-09-04 and the three lists above looking back 7, 3 and 30 days, that was
every window in the product. Her list carries KOTAKBANK, whose 5:1 on 2026-01-14
is 233 days back, and her digest opens on it: a corporate-action card naming the
5:1, `SPLIT −0.80000`, and a small non-zero interaction term under it. The
quoted price moved about −80% across that window, which is what a 5:1 does to a
price; the holder moved about −1%.

Two of those are re-derivable and the rest are not: `SPLIT` is `sf − 1` and
comes from the action feed alone, while everything downstream of the live replay
quote drifts between fetches. This paragraph used to print −315.7% for the
interaction term, which was a figure from a card that had applied the split
twice — see [what review found](#what-review-found).

`TICKS` answers the obvious question about a recorded demo: does it only work on
the day you recorded? Point it at another recording — comma-separate several,
resolved against the repo root — and the same binary boots against that session,
landing its clock inside the last sitting in the files. Two days loaded together
are split into two segments at the overnight gap, printed in the boot banner and
published on `/api/status`, and the workspace header carries a badge whenever
the tape is anything other than `data/ticks.jsonl` alone — because every figure
in this README is measured from that file and nothing else. The badge names the
day the clock is in, which is not always the day the extra recording is from:
every loaded file feeds one pooled provider, so an extra day moves the numbers
even on a boot whose clock lands in the canonical session. Both of those used to
be wrong together — the badge keyed off the last segment rather than the clock,
which suppressed it entirely when the extra recording was the *older* one, and
named the wrong day once the lab moved the clock.

The landing page's colophon is read off `/api/status` for the same reason: it
used to have the canonical date and tick count typed into it, and printed them
unchanged under a two-day boot holding twice the ticks.

With `TICKS` set and `DB_PATH` unset, the database path is derived from the
requested filenames plus a hash of their resolved paths — the hash because the
basename alone is not an identity, and two recordings both named `ticks.jsonl`
shared one database until it was added. The path is not the only defence, since
a re-recorded file or a second path that only exists on the second boot leaves
the string unchanged: the database stores the **landing instant of the recording
it was seeded against**, and a boot whose recording lands somewhere else re-lays
the seeded accounts' watermarks and says so on stderr, naming the measured gap.
A database whose stored value cannot be compared — none at all, from before the
key existed, or a fractional one written by the version that stored the boot
clock — is re-laid once, announced, for the same reason.

That value is the landing instant and not `clock.now()`, and the difference is
the whole guard. The virtual clock is seeked to the landing instant in the App
constructor and then runs in real time while the history loads, so `clock.now()`
is the landing instant plus however long boot took: measured across three
consecutive boots of one untouched recording and one database, 92 ms apart, then
42 ms apart and backwards. Comparing that fired the re-lay on **every** restart
of the default path, which discarded any acknowledgement made through
`/api/ack` on a seeded account. The landing instant is arithmetic over the
pooled poll times and nothing else, so it is identical across boots of the same
recording and different the moment the tape changes.

There is deliberately no button that switches recordings in a running process:
restarting it is what rebuilds the per-process state — the quote store, the
clock, and the seeded accounts' watermarks, which are re-laid whenever the
landing instant moves and say so on stderr. It is not a demonstration that
*nothing* carries over between the two days, which is what this sentence used to
claim, directly above the paragraph that contradicts it. `data/history` does
carry: neither boot reloads it, and the 90-day stop of the `demo` preview
returns the same five dividend cards — same symbols, same order — on the
canonical recording and on a copy of it re-stamped one day later.

What `TICKS` moves is the tape, and only the tape. `data/history` is not
reloaded, so the split and dividend feed, the watermark anchor prices and the
bars behind every volatility band, beta and 52-week range stay fitted to bars
ending **2026-09-04** in this checkout. That does *not* make those figures the
same across recordings, and this paragraph used to claim it did. The baselines
are fitted to bars filtered at `asOf: clock.now()`, so the bars stay put while
the window of them in the fit moves with the recording. Two recordings agree to
the last digit when both clocks land past the last bar, and diverge when they
straddle it — which is the canonical day against the day after it:

| clock | TATASTEEL daily vol | beta | 52-week low |
| --- | --- | --- | --- |
| `2026-09-04T09:18Z` (canonical) | 0.010788587120524835 | 1.1608005604324536 | 15840 |
| `2026-09-05T03:46Z` (+1 session) | 0.011680768335515770 | 1.1631847809804152 | 16006 |
| `2026-09-07T03:46Z` (+3 sessions) | *identical to the +1 row* | | |

An 8.3% move in the band that is the denominator of every σ on every card. The
+1 and +3 boots agree because both sit past the last bar, not because the inputs
are fixed. Both directions are asserted in `server/test/multiday.test.ts`; the
test that used to stand behind the old claim compared only `historyAsOf` and had
both fixtures on the same side of the boundary. The gap is reported rather than
left to be discovered: `/api/status` publishes `historyAsOf`, the Health page
prints it under "Baselines", and boot writes a `[history]` warning to stderr once
the clock is more than one session past the last bar.

That boundary also decides what a *short* window measures against, which is the
part a second-day demo walks into. A window that opens before the tape does
takes its anchor price from `data/history` rather than off a print — and once
the clock is past the last bar, the anchor is that last bar's close, whichever
session it belongs to. On a copy of `data/ticks.jsonl` re-stamped one day later
it belongs to the session being replayed, so the window measures that session
against its own close. Measured: TATASTEEL's one-hour anchor is 18420, the
3 Sept close, on the canonical boot, and 18909, the 4 Sept close — the session
the shifted tape is holding — on the shifted one. So the same prints that read
+2.5% at 6.1σ on one boot read about -0.2% on the other, and `demo`'s 1-hour
stop goes from 5 cards to 1: all five are held back as `NOTHING_UNUSUAL` under
the 1.0% floor, and the one card left is TATAMOTORS "has no data", not a move.
The 10-minute stop shows one card on both days, but on the second day it is that
same lifecycle card. Both anchors are pinned in `server/test/multiday.test.ts`.

The 1-week stop also thins out, from 2 cards to 1, and for a different and less
structural reason worth not conflating with the above: ADANIENT's move over that
window is the same to a rounding error (-7.19% against -7.17%), but sliding the
window one day puts it at 1.9σ against the 2.0σ bar instead of 2.1σ. That is the
threshold doing its job on a marginal card, not an anchor problem.

So demo a second day on `/api/digest?user=meera`, which fills either way and
whose figures do move with the tape. The 90-day stop fills too, but with the
`data/history` dividends above, which read the same on both days. The durable
fix is recording a second day together with a `data/history` refresh, which is
the only thing that puts the last bar back behind the recording, where a short
window's anchor belongs.

A recording named in `TICKS` that exists but yields no parseable tick is refused
at boot when it is the only recording named, with each path and its tick count on
stderr. When another recording did load, the boot continues and each contributing
nothing gets its own `[ticks]` line with the same wording — per path, not per
set, because gating the report on "nothing loaded at all" left the multi-file
case silent, which is the one configuration the feature exists for. Before either
check, such a file fell through to the live provider and the only difference on
screen was one word in the banner.

Replay mode also turns on `/lab`. Under `MODE=live` its five routes aren't
registered at all, the sidebar link hides, and the route itself checks, so a
bookmark gets an explanation instead of a page where every button 404s. `LAB=1`
turns it back on.

---

## What counts as meaningful

This design used to rest on one sentence: *the threshold is a constant
false-positive rate rather than a constant percentage.* Nice sentence. Nobody had
checked it against the five years of prices sitting in this repo.

I checked. It's false.

| Measured, out of sample | Value |
| --- | --- |
| Median volatility reduction from the market adjustment | **13.9%** (implied R² 0.26) |
| Symbols where the adjustment made things worse | **0 of 49** |
| Alert rate at \|z\| ≥ 2.0, pooled | **8.7%** (a normal distribution implies 4.6%) |
| Alert rate at \|z\| ≥ 2.5, pooled | **4.9%** (normal implies 1.2%) |
| Alert rate at \|z\| ≥ 2.0, across instruments | **0.8% to 15.0%** |
| Expected cards per visit, 20-symbol list | **1.7** |

49 symbols, 34,732 held-out sessions. `server/test/calibration.test.ts` runs all
of it.

Two things fell out of that, and both changed the design.

The rate isn't constant across instruments, and dividing by sigma can't make it
so. Sigma equalises scale, not shape. Equity returns are fat-tailed and the
kurtosis differs by name, so TCS fires 15.0% of the time and SUZLON 0.8% against
the same threshold. That's an 18× spread. It's why the system also caps cards,
holds a cooldown per event, and collapses market-wide moves instead of asking one
threshold to do all the work.

The rate is also higher than Gaussian everywhere, which is a fact about returns
and not a bug in my code. The row that matters for the product is the last one: a
typical visit shows fewer than two cards, against a cap of five.

That calibration test replaced one that asserted `residualVol < stdev(returns)`.
Which is an identity. Regressing on any factor can't increase residual variance
in sample, so it passed by construction and measured nothing at all.

The mechanism itself, per symbol: fit beta against NIFTY 50 over 500 sessions
(betas here run 0.498 to 1.710), subtract `beta × market return`, then divide
what's left by an EWMA volatility scaled to how long you were away. That's what
catches a stock that went *up* on a day everything else fell, and what turns a
market-wide selloff into one line instead of twenty cards.

---

## What review found

I reviewed the build against its own documentation and its own data before
submitting. Seven defects had survived a green test suite. What they have in
common is more interesting than any one of them: none threw, none produced a
number that looked wrong, and three passed *because of the way I'd built the
fixtures*.

**The estimator I documented wasn't the one I shipped.** `detect()` divided by a
flat equal-weighted standard deviation. The EWMA that every design note argues
for was only reached by symbols with no beta, which is almost none of them. Every
parameter discussion in `DECISIONS.md` was about a quantity the detector never
touched.

**Volatility was scaled over the wrong clock.** Close-to-close sigma, but elapsed
*trading* time as the horizon. Across a weekend that horizon is zero, so a 1.5%
Infosys gap came out at seventeen sigma.

**The structural guard was eating real crashes.** Its relative arm fired at 12σ.
A genuine 28% single-session fall is about 23σ at the median symbol here, so
there's no z-cutoff anywhere that separates a crash from a split. Measured
against the shipped baselines, 47 of 49 equities would have had a real crash
reported as "we cannot tell you what happened" — the product refusing to work on
the one day it exists for. The arm is gone. Magnitude does that job now.

**The price oracle answered with the future.** Yahoo stamps daily bars at the
session open while the row carries the close, so a lookup at 09:20 got back the
15:30 price labelled 09:20. "Since you last looked" collapsed to roughly zero for
every intraday absence, while the ordinary "today" figure next to it stayed
right. Bars get re-stamped at load now.

**Acknowledgement never worked.** Adding a symbol seeds a watermark at wall-clock
time. Acknowledging wrote the exchange timestamp, which is always older, so the
monotonic guard threw it out. The main interaction in the product did nothing at
all on the first click.

**Comments claimed things the code didn't do.** A chart comment denying a
normalisation it was performing. "Not interpolated across a Sunday" sitting above
a continuous polyline.

**The frontend had never been opened in a browser.** Not once. `.btn` and
`.btnrow` were used by twenty-one elements and defined in neither stylesheet, so
the lab rendered as plain text. Every landing section shipped at `opacity: 0`,
revealed only by an IntersectionObserver that hadn't fired, which meant a black
page on first paint. That one rule explained a whole session of screenshots I'd
blamed on the capture tooling.

A third UI bug turned up later, and it's my favourite of the lot. The sparkline
lifts its pen across closed sessions, which is right: drawing a diagonal through
a weekend invents a journey the price never took. But a session that printed only
once became a subpath containing a single `moveto`, and SVG strokes nothing when
there's no length to stroke. So across a five-session absence, where each session
contributes one close, the entire price path was invisible. Intraday windows have
plenty of prints per session, so only the long-absence case broke — which is the
case this whole product is for. Typechecks passed the whole time.

**And one more, in the newest thing in the tree.** The account added so the
five-part breakdown would have a split to print — `meera`, above — opened on
`KOTAKBANK +394.78%` for a holding that was down about 1%. The recorded closes
are back-adjusted to the end of their series, so the stored January close of
₹429.28 was already in post-5:1 terms for a session that quoted ₹2,146.40; the
oracle handed that over as the watermark price and `decomposeReturn()` restated
it by the same 5:1 again. +394.78% is `1/0.2 − 1`. The five rows printed
underneath it and closed to 1.7e-16 while doing it, which is exactly what the
refusal comment on the structural card says a closure is worth as evidence: it
is a property of the algebra, never evidence that the input was a real price.
The seam is where a recorded price becomes a quoted one, and the existing sweep
could not see it because it builds its own quoted prices. `PriceOracle.priceAt`
now undoes the adjustment at that boundary, and the card reads what the holder
lived: the tape moved −80%, the position −1%. Three tests pin it, one of them
over all 3,674,439 windows that straddle any of the recording's twelve splits.

### The two fixes I was proudest of were the two that were wrong

Worth its own heading, because it's the part that generalises.

The overnight-gap horizon was wrong twice. First it inflated by up to 19×. Then
my fix took the maximum of two terms and deflated by about 2×, in exactly the
window this product is named after. Measured at the time, overnight moves fired
several times less often than same-day moves of equal significance.
`calibration.test.ts` now pins the two rates to each other, so the assertion does
the work instead of my recollection. Variance is additive, so the horizon is too:
`gaps × 0.238 + elapsed × 0.762`, where 0.238 is the overnight share of
close-to-close variance measured across all 51 recorded histories (median
0.2385). The number that disproved my first fix was sitting in the comment
directly above the code I wrote.

The structural guard was the same story. My fix compared a *window*-level
explained fraction against a *session*-level magnitude, which reopened the hole it
was written to close and got worse the longer you'd been away. Over six months a
net return can be near zero, so a trivial dividend "explains" a large fraction of
it, and a 65% overnight collapse inside that window came out as "dividend in this
window; the adjusted move is −0.3%". It now weighs the actual price impact of the
known actions against the size of the worst single session. A rupee of dividend
can't account for two thirds of a share price at any window length.

Both times I fixed the direction of the error and not its size, and I checked the
fix against the case that prompted it instead of against the data.

Full account, with timestamps and the things I rejected, in `DECISIONS.md`.

---

## What you see

<!-- ![The digest](docs/01-digest.png) -->

Six routes behind the overview. Each one shows work the server was already doing
with nowhere to put it: the suppression ledger, the event log with read state
joined onto it, the ingestion counters. Two of them, `/watch/history` and
`/system`, had no UI at all until this pass. The endpoints existed, this README
argued from them, and nothing rendered them.

| Route | What it is |
| --- | --- |
| `/watch` | The digest. Headline, absence ruler, cards, each with a *why this surfaced* panel: raw return, corporate-action-adjusted return, index return, beta, residual (the move with the market taken out), sigma for the horizon, z, baseline observations. |
| `/watch/all` | Every symbol whether it surfaced or not: price, today's move, move since you last looked, σ/day, beta, 52-week range, quote age. Deliberately monochrome. Add and remove symbols here. |
| `/watch/held-back` | Every candidate it generated and didn't show, with the reason. |
| `/watch/history` | The append-only event log, and whether each row was acknowledged. |
| `/lab` | Fault injection. |
| `/system` | Ingestion, quality counters, replay state. |

<!-- ![Where the move came from](docs/05-attribution.png) -->

Corporate-action and move cards carry a ledger under the because-line, *where the
move came from*: the quoted move in five parts that add back up to it — the
split's mechanics, the dividend, the market's move scaled by this instrument's
beta (the row names the beta, because the because-line above it quotes the
index's own return and these are not the same number), the stock itself, and the term that
scales the holder's move by the split. That last one is the reason −90% plus a
holder's −1.67% does not make the −90.17% the tape printed on Nestlé's 10:1, and
it is printed rather than folded into the stock's row, where it would be
invisible and wrong. The ledger shows the difference between the five parts and
the tape rather than asserting there isn't one. `server/src/core/attribution.ts` carries the algebra;
the Nestlé figures in it are recomputed from `data/history` by
`server/test/golden.test.ts` on every run, because the version written from
memory had all three numbers wrong and the holder's sign inverted.

On a move card the three mechanical rows are zero, and they are shown rather
than hidden: that zero is the measurement saying the move was *not* mechanical.
The two rows left — the market's part and the stock's — are the split the card's
own sentence already asserts in words, printed as arithmetic you can check. The
same file's closure is swept over every consecutive-close window in the whole
recording: **62,093 windows across 51 histories, max |raw − Σparts| = 1.1e-16**,
printed on every run so the slack under the 1e-12 bound stays visible.

Closing to 1e-16 is not the same as adding up on screen. Five rows each rounded
to two decimals do not in general sum to a sixth rounded the same way, and a
reader checking us with their eyes checks the printed column, not the float. So
the stock's row is printed as the displayed tape move less the other four
displayed rows — the column reconciles exactly as shown, by construction — and
that row therefore carries their rounding and the measured closure error. Both
are named in the sentence under the ledger, and the same five to six decimals
sit one click away under *why this surfaced* — six decimals, which that panel
says of itself, because a column headed *unrounded* that is out by a unit in the
last place is the same over-claim one click deeper. It is the answer to "your card says
-1.05% and the JSON says -1.041187%" — Kotak's real 5:1, measured off the
recording and pinned by *pins the five parts the workspace ledger's worked
example quotes*, one of 15,109 windows in the 62,093-window sweep where the
substitution moves a hundredth. When a part cannot be measured the
substitution is refused and the note says the rows will not add up, because
forcing the column to reconcile there would invent a number for the stock out of
whatever was missing.

One card never carries the panel. `SUSPECTED_STRUCTURAL` — the card that says a
holding changed by more than trading explains and the action feed has nothing to
account for it — gets no breakdown, and that refusal is a test rather than an
omission. The five rows would close to 1e-12 over a Vedanta-shaped collapse just
as neatly as over a real move, because the closure is an identity in the algebra
and says nothing about whether the input was a real price. A confident
decomposition printed under a sentence admitting we do not trust the number
would contradict the one card whose entire purpose is refusal.

Above the cards, the digest answers the same question for the list as a whole:
of what this watchlist did, how much was simply the market. It is
**equal-weighted across symbols** — named that way in every field of the
response, because a share like that reads as cap-weighted by default — and it is
withheld, with a reason, under either of two rules. The first is a floor: when
the list's net move is under 0.2%, a ratio against a denominator that small is a
ratio against rounding. The second is a ceiling, and it is the one that fires on
a seeded account: when the tape's part of the list is more than **five times**
the list's own move, that move is the small difference between two larger
numbers and the quotient is measuring how nearly the names cancelled out rather
than how much of them was the market. Seeded `ravi` is exactly that case — his
thirty-day net clears the floor and the share is still withheld, with the
ceiling's reason printed in its place. The share is the quotient of the two
unrounded means, and the paragraph on screen says so, because it prints the
share to a whole percent and the two means to two decimals: dividing the figures
as printed need not give the headline back. It rides on
`/api/digest` and `/api/preview` rather than behind a new endpoint, so nothing
that already fetches a digest — the landing page's away-slider included — needs
a second call to get it. The workspace digest is the only screen that renders
it today; the slider receives it and prints the cards. It appears twice there,
as the paragraph above the cards and as a figure in the footer beside coverage
and the window — two renderings of one server field, neither of which computes
anything, so they cannot disagree on screen. When the share is withheld the
footer prints the server's reason where the note goes rather than a dash: a dash
in a row of figures reads as a zero or as a bug, and this is neither.

<!-- ![What was held back](docs/02-held-back.png) -->

The held-back ledger is the cheapest way to show nothing gets dropped silently.
A fresh clone of `demo` opens with 2 cards and 13 ledger rows, things like
`RELIANCE: 1.9σ against a bar of 2.0σ` and `HDFCBANK: 0.7σ against a bar of 2.0σ,
and below the 1.0% floor`. Symbols that stayed inside their range used to leave
no trace at all. They were counted, and the count was the whole record, which
quietly made a liar out of the loudest claim in the project.

<!-- ![Why this surfaced](docs/03-why.png) -->

The ruler and every sparkline share one time axis, so two moves at the same
horizontal position happened at the same moment. Usually that means the tape
rather than the company.

Colour has a noise budget. Green and red only appear on surfaced cards, and the
table at `/watch/all` is monochrome, because colour that's always on tells you
nothing. There's a third semantic most financial interfaces don't have: amber,
meaning *we can't tell you*. Corporate actions, stale feeds, structural moves
nobody can explain. Up is good, down is bad, amber is neither.

One control instead of a settings page: a three-stop slider over `signal`
(z 2.5, 3 cards, 6h cooldown), `balanced` (2.0, 5, 4h) and `everything`
(1.0, 25, 30m).

About `/`: no example on that page is remembered. The hero slider, the
two-instrument sigma comparison and the beta decomposition all read a live
`/api/preview`, because an earlier version had them typed in and a fact-check
found eight figures that were stale, wrong or impossible to reproduce. One was a
flagship "1.9σ" example card that the shipped detector would have suppressed at a
2.0 bar. What's still literal on that page is the historical material that can't
change: the Nestlé and Vedanta case studies, and the calibration table, which is
the same table as above and comes out of `calibration.test.ts`.

---

## The lab

<!-- ![A fault firing](docs/04-lab.png) -->

Resilience claims aren't worth much unless a stranger can check them in ninety
seconds. From a fresh boot on `demo`, whose 15 symbols include one that's
delisted on purpose:

| Do this | And this happens |
| --- | --- |
| Kill the feed | 14 symbols `STALE`, 1 `UNAVAILABLE` |
| Rate limit us | the same 14 `STALE` |
| Freeze one symbol | 1 `ILLIQUID`, 13 still `LIVE`. The feed is fine, this stock stopped printing |
| Delist a symbol | `UNAVAILABLE` plus a lifecycle card |
| Send garbage (85× the previous close) | `SUSPECT`, never displayed |
| Undocumented 10:1 | `SUSPECTED_STRUCTURAL`, not a −90% crash |
| Move it 47% | `SUSPECTED_STRUCTURAL` |
| Replay an old print | `REJECTED_OUT_OF_ORDER`. Prices don't walk backwards |

"Come back later" rewinds your watermark anywhere from ten minutes to a month.
Faults that need time to become visible advance the clock themselves and tell you
by how much.

---

## Architecture, and the rest of the brief

6,794 lines of TypeScript in `server/src`, 3,890 in `web/src` plus 2,446 of CSS,
4,354 of tests, 18 HTTP endpoints. Everything in `core/` is pure: `detect`,
`rank`, `digest`, `baseline`, `stats`, `calendar`, `clock`, `corporate`,
`attribution`, `quality`, `money`. No I/O, no network, and nothing outside
`clock.ts` calls `Date.now()`. `app.ts` is the single place where that meets the
database.

Those four counts are `wc -l` over the `.ts`/`.tsx` and `.css` files in each
directory, stated so they can be re-derived rather than trusted. They have gone
stale five times, four of them during the change that moved the lines. First the
frontend pass updated the web and CSS figures and left `server/src` reading
5,065 and the test line at 1,542. Then the attribution work moved three of the
four again, and the line read 5,568 / 2,971 / 2,578 against the 5,906 / 3,119 /
3,230 measured at the time. Then the split fix moved two of them: 5,906 and
3,230 against the 6,032 and 3,476 it was corrected to. Then the attribution-UI
review pass moved `web/src` and the tests once more, and re-deriving all four
found the CSS figure had been wrong since the second correction as well — 2,345
against a measured 2,420 — so the sentence that used to sit here, claiming the
CSS figure had been exact throughout, was itself the fourth stale number. The
review of that pass then moved all four again — the beta on the ledger's market
row, the footer's alignment fix, and the tests pinning both — and they were
re-derived inside that change rather than in the one after it, which is the
break in the pattern the two sentences above describe — and the break did not
hold. The two `TICKS` commits and the working tree on top of them moved all four
a fifth time and re-derived none of them: 6,063 / 3,518 / 2,433 / 3,630 stood
here against a measured 6,794 / 3,890 / 2,446 / 4,354, the largest gap any of
these has carried. So the honest version of the sentence above is that the
pattern is the rule and the one exception was the exception.

And then a sixth time, in the sentence that claimed the habit was finally
broken. The pass that corrected the figures above wrote "the counts above were
re-derived by `wc -l` in this tree after the last edit to it" and put 4,351 next
to a `server/test` that measured 4,354 — so the confession in the paragraph
above was itself the stale number, which is about as neat a demonstration
as it is possible to arrange. The test figure is now 4,354: 283 + 804 + 855 +
673 + 1,739 over `calibration`, `core`, `golden`, `multiday` and `regressions`.
All four counts were re-derived by `wc -l` in this tree at the end of the pass
that wrote this paragraph, which is a claim about one measurement and not about
a habit. The endpoint count
is 18: seventeen plain `fastify.get`/`post`/`put` registrations plus the
`fastify.delete<{ Params }>` that a naive grep for `fastify.delete(` misses.

### State across sessions and devices

One watermark per user per symbol, merged by taking the maximum, and the guard
lives in the `WHERE` clause of the upsert rather than in application code.

Why maximum: someone reads on their phone, then opens a laptop that's been asleep
since yesterday. Last-write-wins lets the stale watermark clobber the fresh one,
so everything they already read comes back. Flip the ordering and it swallows
news they never saw. No clock can arbitrate. Maximum makes the merge commutative
and idempotent, so the answer doesn't depend on which device syncs first.

The event log is immutable, and whether a row has been *seen* lives in a separate
table. A `seen` boolean on the event itself would destroy the record that it ever
happened, killing history views and any hope of debugging a bad alert later.

Reading doesn't acknowledge. Fetching the digest marks nothing, because a
background refresh or a phone restoring a tab in someone's pocket would otherwise
eat news nobody read. Acknowledgement is its own endpoint and its own button, and
`/watch/history` puts the join on screen so you can check it.

### Stale, delayed and conflicting data

Seven quote states: `LIVE`, `DELAYED`, `ILLIQUID`, `STALE`, `CLOSED`, `SUSPECT`,
`UNAVAILABLE`. "No trade in six minutes" and "the feed is down" are different
facts that look identical in a price field, and an 18-hour-old price is correct
at 6am on a Sunday and a fault at 11am on a Tuesday.

Out-of-order prints get rejected at the store. A price 85× the previous close
isn't a price.

A single-session move past 35% that the corporate-action feed can't account for
gets reported as *something structural happened and we can't tell you what*, never
as a crash. That's because the feed is provably incomplete, and I can show you:
Vedanta fell 64.9% in one session on its 2026 demerger, and the feed carries no
split for it, ever. It carries 17 dividends. So it isn't a sparse feed, it's a
feed that's wrong about the one event that mattered. Nestlé India is the mirror
image, a real 10:1 on 5 January 2024: ₹27,116.40 at the previous close, ₹2,666.40
at the next one. Naively that's −90.17%. For whoever held it, it was −1.67% — a
quiet down day, not a crash. Those figures are measured off `data/history` by
`golden.test.ts` on every run, not remembered here.

### Scale

Ingestion fans in. One fetch per distinct symbol across all users, not one per
watchlist row. On a fresh clone `/api/status` reports 44 watchlist rows served by
30 fetches, 14 saved per cycle, fan-in 1.47. That's a number `/system` prints, not
a sentence I'm asking you to believe. All four figures moved when the fourth
seeded account was added and were left behind at 37 / 28 / 9 / 1.32 — the ratio
rises with every overlapping list, which is the claim, so a stale one here was
understating the only thing this paragraph argues.

The union of watched symbols grows much slower than the user count, so cost is
bounded by the size of the exchange rather than by how many people show up. The
shape is right. The implementation isn't there yet: the Yahoo provider loops
symbols serially at 5 req/s, so two thousand symbols would take about 400
seconds. Its batch quote endpoint is the fix and I haven't written it.

### Where I didn't add complexity

**No authentication.** The user is a query parameter threaded through every layer
as a first-class value, so real auth is a middleware that sets it. Deliberate,
and the source says so.

**No router dependency.** `router.tsx` is 81 lines for seven static paths, and a
library would be more code than that, not less. Middle-click still opens a new
tab because the `href` is real. The trade-off is no route params, no data
loaders, no lazy boundaries. If I needed any of those, this becomes a dependency
rather than growing into one. The frontend depends on `react` and `react-dom`,
nothing else.

**No push notifications.** The digest *is* the notification, and adding push
before solving the ranking just moves the noise somewhere more annoying.

**No LLM summariser, no ML ranker.** Narrative sentences are templates filled
with computed numbers, so I can tell you why any of them said what it said. And
there's no labelled ground truth for "was this alert useful". No portfolio, no
news feed, no indicators either. Different products.

---

## Data

`tools/record.py` captured a live NSE session on 4 September 2026: 7,038 ticks
across 51 symbols over 72 minutes, running into the close. `tools/history.py`
pulled five years of daily bars with dividend and split events, 51 files and
62,153 bars going back to 2021-09-06. Both are committed, which is what lets a
fresh clone work offline.

The universe was picked for edge cases rather than market caps:

- a real 10:1 split (NESTLEIND, which also carries a later 2:1)
- an undocumented demerger (VEDL)
- a −28.2% session (ADANIENT, 1 February 2023)
- a recent listing with 688 daily bars where 48 of the 51 files have 1,240 (IREDA)
- a high- and a low-volatility pair (SUZLON, HINDUNILVR)
- one symbol the recorder asked for and got nothing back for (TATAMOTORS)

That last one stays on `demo`'s watchlist precisely *because* it has no data.
It's the only watched symbol with no history file and no ticks, so every run
exercises the unavailable path for real instead of through an injected fault.

Market data is Yahoo's public endpoints: delayed, unofficial, and fine for a
build about how you reason over market data. The provider interface is one file.

---

## Known limits

- The provider fetches serially. The fan-in argument is about shape, not
  throughput.
- No frontend tests, and no documented command typechecks `web/src` — `vite
  build` doesn't. All 146 tests are in `server/test`. The three UI defects above
  were found by opening a browser, and that's still the only check there is. Two
  of the 146 do read `web/src/landing/Landing.tsx`, but as text: they check the
  Nestlé figures printed there against the recording. Nothing renders a
  component.
- `GET /api/digest` and the SSE stream both run the write path, so an open reader
  appends to the event log every three seconds. The log doesn't actually grow,
  because `recordEvent` is idempotent on its dedupe key. But that's why it's
  safe, not the design. The pure `computeDigest` exists and `/api/preview` uses
  it; these two should too.
- The holiday list is 21 dates: 2025 in full, and only 2026's fixed-date
  holidays. Ganesh Chaturthi, Diwali and the rest of 2026's lunar dates aren't
  there. So `CALENDAR_VERIFIED_UNTIL` is `2025-12-31`, and the demo replays
  4 September 2026, which is past it. `/api/health` says
  `holiday calendar is unverified past 2025-12-31` on a fresh boot.

  That took two attempts. The constant was exported, documented as a safeguard,
  read by nothing, and then asserted as wired in this file. Once wired, I set it
  to `2026-12-31`, which is past the very gap it describes, so it could never
  fire. Two tests now pin that it fires and that it does *not* fail liveness,
  since a guess about a holiday isn't an outage. Past the horizon the real
  protection is `detectUnexpectedlyQuiet`: clock says open, nothing has printed,
  stop claiming the market is live.
- `/api/lab/rewind` writes watermarks with raw SQL and bypasses the monotonic
  guard, which makes that guard a convention rather than a schema invariant. A
  `CHECK` constraint would fix it and should.
- CORS is open (`origin: true`) and there's no rate limiting. In replay mode the
  five `/api/lab/*` routes are unauthenticated writes to global process state:
  any origin can move the clock, inject a fault, or rewind another named
  account's watermarks. That's exactly why they're unregistered under
  `MODE=live`.
- Circuit bands are assumed at 20%, the most permissive standard tier. In
  production they come per-scrip from the exchange's daily band file.
- Beta is a single OLS fit with outlier pairs dropped, no shrinkage. Adequate for
  noise reduction, wrong to trade on.
- Volume z-scores compare cumulative intraday volume against a full-day baseline,
  so that rule reads low in the morning.
- `GLANCE` and `SESSION` produce identical output. `NARRATIVE` is the real second
  shape, adding drawdown and worst-session facts past three sessions.
- Acknowledgement is all-or-nothing rather than per-card. A weaker version of the
  same argument, and a genuine gap.
- On a fresh database the held-back ledger only ever shows `NOTHING_UNUSUAL`. The
  other four suppression reasons need a busier market than 72 minutes.
- A watchlist row carries a holding size that weights ranking by up to 1.5×, and
  the four seeded accounts use it, but the add form has no field for it. It can
  only be set through `POST /api/watchlist`.
- The recording is 72 minutes and boot seeks 35% into it, so an instance left
  running crosses the recorded close and everything reads `CLOSED`. Measured
  rather than estimated, because this line said "about 45 minutes" and then said
  "+40 minutes" — both of which named the end of the slide rather than the
  start of it. The landing instant is 41.6 minutes before the recorded 15:30
  close, but the exchange timestamps thin out before the close does: resetting
  and advancing the clock a row at a time, `demo`'s quotes read `LIVE` through
  **+27.8 minutes**, take their first `DELAYED` badges at **+28**, are entirely
  `DELAYED` by **+29**, entirely `ILLIQUID` from **+30.8**, and `CLOSED` from
  **+41.8**, where the session badge flips too. It degrades honestly rather than
  breaking, and `/lab` → **Reset everything** seeks back to the landing instant.
  `docs/DEMO-CHECKLIST.md` is the version of this for someone about to present,
  and says boot within 25 minutes for that reason.
- Which account you're viewing is kept in `localStorage`, which is per-browser.
  It stands in for the session a real login would establish. It isn't a claim
  that identity syncs across devices — though the watermarks behind it do.
