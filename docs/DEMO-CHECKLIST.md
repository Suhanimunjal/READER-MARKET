# Demo checklist

One presenter, one laptop, live. Everything below was run against this checkout
before it was written down; nothing here is a plan.

---

## T-minus 5 minutes

**Ctrl-C any MarketReader you already have running, first.** A live server holds
`data/marketreader.db` open, and on Windows all three files then refuse to be
unlinked. The script says so in one line and stops:

```
[fresh] something still has ...\data\marketreader.db-wal open -- stop the
running server first (Ctrl-C), then re-run. A second PORT does not release it.
```

(One line, wrapped here. It names whichever of the three files it reached first,
usually the `-wal`.) It exits 1 when it prints that, so the `&& npm run serve`
half never runs and you are left with no server at all, and nothing was deleted
— the database is exactly as it was. Stop the old instance and re-run.

```bash
npm run demo:fresh
```

From the **repo root**. It deletes the demo database, rebuilds, and boots.
Measured: **16 seconds** from the command to a `200` on `/api/health`.

Wait for the banner and read two lines of it:

```
  mode: replay   provider: replay   universe: 51 symbols
  clock at 2026-09-04T09:18:23.241Z  (REGULAR)
```

**`provider: replay` and `universe: 51 symbols` are the check.** Anything else —
`provider: yahoo`, `universe: 0 symbols` — means the process resolved its root
wrongly and fell back to the network, and every screen after that is either empty
or wrong. The cause is almost always running `node server/dist/index.js` by hand
instead of going through npm. Ctrl-C and use the script.

Then open <http://localhost:8787> and check one pair of numbers before anyone is
watching: **`/watch` on `demo` opens with 2 cards, and `/watch/held-back` has 13
rows.** That pair is the fingerprint of a correctly seeded fresh database. Any
other pair means the database is not fresh — go back to `demo:fresh`.

**That pair checks the database and not the build.** Check the build too, with
one curl — it is the only pre-flight that can see beat 3:

```bash
curl -s "http://localhost:8787/api/digest?user=meera" |
  grep -c '"key":"SPLIT","label":"split mechanics","value":-0.8,'
```

**It must print `1`.** That is `meera`'s `KOTAKBANK` card carrying its five-row
attribution ledger — beat 3, the strongest thing on screen — and `SPLIT
−0.80000` is one of the two digits beat 3 says hold still on every fetch, so it
is a gate and not a snapshot. Measured: with a `server/dist/core/detect.js` left
stale by a mutation run, this prints `0` and every `CORPORATE_ACTION` card is
served with no ledger at all — while `demo` still opens with exactly 2 cards and
13 held-back rows. The pair passes and beat 3 is dead, which is the whole reason
this line exists.

If it prints `0`: stop the server, run `npm -w server run build` (or `rm -rf
server/dist`), and boot again. `grep -c MUTATED server/dist/core/detect.js`
printing anything but `0` is the same fault seen from the other side. `npm test`
will not catch it — vitest compiles from `src/`, never `dist/` — and neither
will `git status`, because `server/dist/` is gitignored.

If 8787 is taken, the server says so and prints the override. `PORT=8080 npm run
demo:fresh` in bash, `$env:PORT=8080; npm run demo:fresh` in PowerShell.

**A second port does not get you out of the paragraph above.** If 8787 is taken
because your own previous instance is still running, that instance also still
holds the database, and `PORT=8080 npm run demo:fresh` stops on the same line.
Stop the running instance first, then `demo:fresh` — the port and the database
are independent, and only one of them is freed by choosing a different number.

---

## Restart shortly before you present

The replay clock lands **35% into a 71.6-minute recording**, at
`2026-09-04T09:18:22.760Z`. The recorded 15:30 IST close is **41.6 minutes**
after that — but the badges start going off well before the close, because the
exchange timestamps in the tape thin out first. Measured on a fresh database,
resetting and advancing the clock for each row, counting `quality` across
`demo`'s 15 rows:

| Clock | `demo`'s quote badges |
| --- | --- |
| +24 to +27.8 min | `live 14 · unavailable 1` — the state you want on camera |
| +28 min | first `delayed` badges: `delayed 11 · live 3 · unavailable 1` |
| +29 to +30.6 min | `delayed 14 · unavailable 1` |
| +30.8 min onward | `illiquid 14 · unavailable 1` |
| +41.8 min onward | `closed 14 · unavailable 1`, and the session badge flips to `CLOSED` |

So the "+40 minutes is illiquid, +42 is closed" figures are the *end* of the
slide, not the start of it. The first grey badge is at **+28 minutes**.

An instance you booted at breakfast is not the instance you want on screen, and
neither is one you booted half an hour ago. **Boot within 25 minutes of
presenting**, or re-seek it:

- `/lab` → **Reset everything**, or
- `curl -X POST http://localhost:8787/api/lab/reset`

Verified: reset seeks the clock back to `2026-09-04T09:18:22.760Z` — the same
instant boot lands on, from the same function — clears any armed fault, sets
speed back to 1, un-pauses, and drops the stale quote cache. `demo` goes from
14 `closed` back to 14 `live`.

---

## A clean database

The file is `data/marketreader.db`, with `data/marketreader.db-wal` and
`data/marketreader.db-shm` beside it. With no server holding them, `npm run
demo:fresh` removes all three and prints what it removed — `[fresh] removed 3
file(s) for ...`, or `[fresh] no database at ...; the next boot seeds one` if
there was nothing there. With a server holding them it removes none of them and
says so; see the T-minus-5 step. The WAL matters: delete the database and leave the
write-ahead log and SQLite recovers the old watermarks on the next open, so the
"fresh" boot is not fresh.

It touches nothing else in `data/`. The TICKS-derived databases
(`marketreader-<recording>-<hash>.db`) and `data/ticks.jsonl` are left alone.

**Reset is not a clean database.** This is the one that will catch you:

| You did this in rehearsal | `/lab` → Reset everything | `npm run demo:fresh` |
| --- | --- | --- |
| Armed a fault | undoes it | undoes it |
| Advanced the clock, or clicked **Past the close** | undoes it | undoes it |
| Clicked **Come back later** (any rewind) | **does not undo it** | undoes it |
| Acknowledged cards | **does not undo it** | undoes it |

Measured: rewind `demo` a month, then reset, and the digest still opens on
*"30 days, 22 sessions"* with **1 card** instead of the seeded **2 cards and 13
held-back rows**. `/lab/rewind` writes watermarks; reset only moves the clock
and the fault. If you rehearsed a rewind, stop the server and re-run
`demo:fresh`.

Read the *30 days* and the *1 card*, not the session number. Rewind anchors the
watermark to the clock as it stands, and reset puts the clock back, so straight
after a reset that label sits one session low for exactly as long as the clock
had been running when you rewound. Measured: reset, wait 5,009 ms, rewind a
month — the digest reads *"30 days, 22 sessions"*; reset again and it reads
*"30 days, 21 sessions"* until +5,210 ms, then 22 again. The card count is 1
throughout, which is the thing the row above is about.

**Compare card counts, not session counts.** Reset does move the session count by
itself on a clean database, with nothing wrong — but only for about a fifth of a
second, which makes it a thing to understand rather than a state to expect.
Seeding lays the watermark seven days before the clock *as it stands when the
seed runs*, which is the landing instant plus however much of the boot has
already happened; `/lab/reset` seeks the clock back to the landing instant
itself, which is that much earlier. So the absence comes out a hair under seven
days and `Math.floor` in `digest.ts` drops one session off the label — and then
the clock, still running at speed 1, erases the deficit in the same fraction of a
second that created it.

Measured on a fresh database booted the way this file says to boot it (landing
`09:18:22.760Z`, banner clock `09:18:23.124Z`), polling `/api/digest?user=demo`
after `POST /api/lab/reset`:

| After the reset | Label | `sessions` |
| --- | --- | --- |
| +5 ms, +57 ms, +105 ms, +151 ms | *"7 days, 4 sessions"* | 4.999991 → 4.999998 |
| +214 ms, and every read out to +15 s | *"7 days, 5 sessions"* | 5.000001 → 5.000658 |

The deficit was 202 ms of clock, and that window is shorter than the click from
`/lab` to `/watch`. **The label you arrive at after a reset is "7 days, 5
sessions", with 2 cards** — the 4 is real, and only a script fetching inside a
fifth of a second of the `POST` will see it. Do not quote a `sessions` figure
either: it is a running absence divided by a session length, so two fetches
seconds apart differ in the fourth decimal. The pair `2 cards / 13 rows` is the
number worth checking against a moving clock, because it is the one that does
not move — it was 2 and 13 on every row above. It says the database is seeded,
and nothing about the build; the `meera` curl at T-minus-5 is what covers that.

---

## If a fault is still armed

**The tell:** `/lab` carries an amber notice at the top naming the fault and the
symbol, and the quality counters above it say something other than
`live 14 · unavailable 1` for `demo`. `/system` shows the same counters.

**The fix, in order of how much you want to be doing this on camera:**

1. `/lab` → **Reset everything**. One click.
2. `curl -X POST http://localhost:8787/api/lab/reset` from a second terminal.
3. Restart. Faults live in process memory, not in the database, so any restart
   clears them — `npm run demo:fresh` and a plain `npm run serve` both do.

---

## The beats, and what to do when one of them does not work

Every fallback below was run against this checkout. The rule is the same for all
of them: **the fallback is another route to the same number, never an apology.**

### 1. `/` — the away-slider

Drag it. Ten minutes gives 1 card, an hour gives 5, a week gives 2 — still
cards, plus the narrative note *"Too long to replay, so it is summarised rather
than listed"* and a *down as much as …* line on the one card whose drawdown
clears 2% — and three months gives 5 corporate-action cards that exist only
because the window now contains their ex-dates.

Two things not to say. The week stop does **not** replace the cards with a
written summary; it keeps listing them and adds a sentence. And the counts above
are what `/api/preview` returns — the hero renders at most 4 of them and appends
*· 1 more surfaced*, so the hour and three-month stops read as four cards and a
count on screen.

*If the slider does not move or the page is blank:* go straight to `/watch`. The
slider is the argument, not the product. The same figures are one curl away and
worth reading aloud from a terminal if it comes to that:

```bash
curl -s "http://localhost:8787/api/preview?user=demo&awayMs=600000"    # 1 card
curl -s "http://localhost:8787/api/preview?user=demo&awayMs=3600000"   # 5 cards
curl -s "http://localhost:8787/api/preview?user=demo&awayMs=604800000"  # 2 cards, mode NARRATIVE
curl -s "http://localhost:8787/api/preview?user=demo&awayMs=7776000000" # 5 corporate actions
```

### 2. `/watch` — the digest on `demo`

2 cards, the absence ruler, the sparklines, the *you last saw ₹…* line.

*If it looks thin or an account has been rewound:* switch account in the header.
`meera` (240 days, 7 symbols) fills in every state — 5 cards, `KOTAKBANK` first.
`ravi` (30 days, 10 symbols) fills too and carries the withheld tape share.

### 3. **The attribution card** — *Where the move came from*

The strongest thing on screen, and the newest. Open the ledger under a card's
because-line: the quoted move in five parts that add back up to it — split,
dividend, the market's move scaled by this instrument's beta, the stock itself,
and the interaction term.

Use **`meera` → `KOTAKBANK`**, which is the only place a reader can reach a
non-zero interaction term. The card reads *"the quoted price moved about −80%,
but 5:1 split, dividend accounts for it. Your position changed about −1%"*, over
five rows: `SPLIT`, `DIVIDEND`, `MARKET`, `STOCK`, `INTERACTION`.

**Two of those five are fixed and three are not — read the screen, do not recite
this paragraph.** `SPLIT −0.80000` is `sf − 1` from the action feed, and
`DIVIDEND −0.00030` comes from the same place; both hold to five decimals on
every fetch. `MARKET`, `STOCK`, `INTERACTION` and the because-line percentage
are all downstream of a live replay quote and move while the clock runs.
Measured across one boot, same account, same card: `STOCK` ran `0.07282` →
`0.07305` → `0.07354`, `MARKET` `−0.08346` to `−0.08351`, `INTERACTION` `0.00854`
→ `0.00798`, the holder's move `−1.07%` → `−1.00%`, and the quoted move `−80.24%`
→ `−80.23%`. At +25 minutes on the clock the same card read `−80.22%` / `−0.93%`
with `STOCK 0.07443`. Say *"about −80% on the tape, about −1% for the holder"*
and point at the rows; the argument is that the five parts reconcile, not that
they are any particular digits. README's own note on this cites the −315.7%
incident, which came from reading a printed figure instead of the screen.

*If that account will not load:* `demo`'s `ADANIENT` card carries the same ledger
with the three mechanical rows at zero, which is the same argument stated in the
negative — the measurement saying the move was *not* mechanical. Say that out
loud rather than hunting for the split card.

*If the ledger is missing entirely on a `SUSPECTED_STRUCTURAL` card:* the
absence is deliberate and tested — the measurement refusing to attribute a move
it has just said it does not believe. That is a better story than the one you
were about to tell.

*If the ledger is missing on a `CORPORATE_ACTION` card* — `KOTAKBANK` is one,
and so is every card `meera` opens with — *it is a stale build, not a designed
absence.* Do not reach for the paragraph above; it is the wrong explanation for
this card, and a judge who knows the kinds will hear that. Stop the server, `npm
-w server run build`, boot again. This is exactly the failure the T-minus-5 curl
is there to catch, and the 2-cards/13-rows pair passes straight through it.

### 4. `/watch/held-back` — the restraint

13 rows on a fresh `demo`, each with the distance it fell short by:
`RELIANCE — 1.9σ against a bar of 2.0σ`, `HDFCBANK — 0.7σ against a bar of 2.0σ,
and below the 1.0% floor`.

*If it is empty:* the account has been acknowledged or rewound. `demo:fresh`.

### 5. `/watch/history` — the event log

Append-only rows with the read state joined on. On a fresh boot the two cards
from beat 2 are there with `shownAt` empty, because fetching a digest does not
acknowledge it. Click **Mark all as seen** on `/watch` and refresh this page to
make the join move.

*If it is empty:* nobody has opened the digest on this account yet. Load
`/watch` first; events are written when the digest surfaces something.

### 6. `/lab` — a fault firing

**Target** `SBIN` → **Freeze one symbol**. Counters go to `illiquid 1 · live 13 ·
unavailable 1`. That is the seven-state taxonomy earning its keep: this symbol
stopped printing, the feed is fine.

Then **Undocumented 10:1** on `RELIANCE` → a `SUSPECTED_STRUCTURAL` card, not a
−90% crash.

*If a button does nothing:* the same two faults from a terminal —

```bash
curl -X POST http://localhost:8787/api/lab/fault -H "Content-Type: application/json" \
  -d '{"kind":"FROZEN","symbol":"SBIN"}'
curl -X POST http://localhost:8787/api/lab/fault -H "Content-Type: application/json" \
  -d '{"kind":"PHANTOM_SPLIT","symbol":"RELIANCE"}'
```

— then show the result on `/watch/all`, where the per-row badges live.

*If `/lab` is missing from the sidebar:* the process is in live mode. The lab
routes are not registered under `MODE=live` on purpose. Restart with
`npm run demo:fresh`.

### 7. **Reset everything**

Last click of *this* demo. **The next one starts from `npm run demo:fresh`, not
from here** — beat 5 acknowledged the cards, and reset does not undo that, the
same way it does not undo a rewind.

Measured: acknowledge all 15 of `demo`'s symbols, then `POST /api/lab/reset`.
`/watch` reads *"Nothing new since you looked"* with **0 cards**,
`/watch/held-back` swells to **15 rows** (14 `NOTHING_UNUSUAL` and 1 `COOLDOWN`),
and beat 1 — the first thing the next audience sees — collapses to *"Nothing
meaningful in 10 minutes"*, 0 cards. The fresh-state fingerprint above (2 cards,
13 rows) fails, which is exactly what it is there to tell you.

---

## If the whole thing is on fire

`npm test` — **146 passed, 5 files**, about 9 seconds, no server and no network
required. The calibration numbers, the Nestlé decomposition, the 62,093-window
attribution sweep and the sha256 of the recording are all in there. A green suite
run live is a weaker demo than the product and a much stronger one than a broken
page.
