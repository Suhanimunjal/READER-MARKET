# Screenshots to capture before submitting

Six images and one short recording. Each has a fixed filename because
`README.md` already has a commented-out slot pointing at it — uncomment the
line once the file exists.

Everything below comes from a single run:

```bash
npm run demo:fresh
```

`serve` works too; `demo:fresh` is the same thing with the database deleted
first, which is what makes the counts below reproducible — a rehearsal that
rewound an account or acknowledged a card changes every frame in this set. See
`docs/DEMO-CHECKLIST.md` for why reset is not enough.

Stop any server you already have running before that command. A live one holds
the database open, and `demo:fresh` then prints one line saying so and exits
without deleting anything or starting a server.

Then `http://localhost:8787`. Take them at a **1280px-wide window** and stay in
one theme for the whole set, so it reads as one product rather than six
screenshots of six things.

The replay clock lands 41.6 minutes before the recorded close, so an instance
left running turns every quote `CLOSED` partway through a capture session — and
the badges start degrading well before that, measured: `DELAYED` from +28
minutes on the clock, `ILLIQUID` from +30.8, `CLOSED` from +41.8. **Reset
between frames rather than at the end**: `/lab` → **Reset everything** seeks the
clock back to the landing instant and `demo` goes back to `live 14 ·
unavailable 1`. If a frame came out with grey badges you did not want, reset and
retake it.

**If you only have time for three, take 01, 05 and 04.** The digest, the
attribution ledger, and a fault firing: the product, the proof, and the
resilience claim. `03` is the same proof one click deeper and is the one to add
fourth.

---

### `docs/00-landing.png` — the argument, above the fold

Load `/`. Capture the first screen, before any scrolling: the headline, the
away-slider, and the cards the slider produced.

Then **drag the slider to "a month"** and take a second frame if you want one
extra. The card count and the wording change, because the cards are computed
live by `/api/preview` against the real recording — nothing on that page is a
mockup, and that is the point worth showing.

### `docs/01-digest.png` — the product

Go to `/watch`. On a fresh database `demo` opens with 2 cards. Capture from the
headline down through the second card, so the frame contains:

- the headline and its subhead
- the absence ruler underneath, with its shaded session bands
- the first card, its sparkline, and the *you last saw ₹…* line

This is the one image that has to work alone. Someone who sees only this should
understand the thesis without reading a word.

### `docs/05-attribution.png` — where the move came from

**The strongest frame in the set, and the newest.** Switch the account in the
header to **`meera`** and go to `/watch`. Her digest opens on `KOTAKBANK`, a
corporate-action card for the real 5:1 of 14 January 2026. Capture the card whole,
so the frame holds the because-line and the ledger under it together:

> the quoted price moved −80.24%, but 5:1 split, dividend accounts for it.
> Your position changed −1.04%.

and under that, *Where the move came from*, five rows that add back up to the
tape's −80.24%: the split's mechanics, the dividend, the market's move scaled by
this instrument's beta, the stock itself, and the term that scales the holder's
move by the split. Only `SPLIT −0.80000` and `DIVIDEND −0.00030` hold still;
everything downstream of a live replay quote moves, and by more than a last
decimal. Measured across one boot: `STOCK` ran `0.07282` to `0.07443`, the
holder's move `−0.93%` to `−1.07%`, and even the quoted move `−80.24%` to
`−80.22%`. So capture what is on screen rather than matching this paragraph, and
do not read the figures above out loud as if they were the frame's.

`meera` is the only seeded account that reaches a non-zero interaction term, so
this is the one place in the product where all five rows are alive at once. That
is exactly what makes it worth a frame: a decomposition whose rows are all zero
is an assertion, and one that is not is a measurement.

Get the sentence under the ledger into the frame too. It says the stock's row
carries the rounding and the measured closure error, which is the difference
between a ledger that adds up and a ledger that claims to.

### `docs/02-held-back.png` — the restraint

Go to `/watch/held-back` on `demo`. Capture the list — 13 rows on a fresh
database.

Every row is a symbol the system considered and deliberately did not show, with
the distance it fell short by — *1.9σ against a bar of 2.0σ*. Most watchlists
cannot produce this page, because they never decided anything. It is the
cheapest way to prove the digest is a judgement rather than a filter.

### `docs/03-why.png` — the evidence

Back on `/watch`, click **why this surfaced** on any price card. Capture the
card with the panel open and the evidence grid legible: return adjusted, return
raw, market return, beta, residual, sigma for horizon, horizon sessions,
z-score, baseline observations, rank score.

This is the answer to *how do you know?*, and for an engineering audience it is
the most persuasive frame after `05` — the same five parts at six decimals,
beside the inputs that produced them.

### `docs/04-lab.png` — a fault firing

Go to `/lab`. Under **Break the feed**, set **Target** to `SBIN`, then click
**Freeze one symbol**. Capture the page with the quality counters at the top
visible.

`SBIN` reads `illiquid` while the other 13 read `live` and the delisted one reads
`unavailable`. That is the distinction the seven-state taxonomy exists for —
this symbol stopped printing, the feed is fine — and it is the hardest thing
here to explain in prose and the easiest to show.

Click **Reset everything** before the next frame.

---

### `docs/demo.gif` (or `.mp4`) — ninety seconds

One take, no narration needed:

1. Land on `/`. Drag the away-slider from ten minutes to a month. The answer
   changes shape: `/api/preview` returns 1 card at ten minutes, 5 at an hour,
   2 at a week and 1 at a month — and from a week on it adds the note that the
   window was summarised rather than replayed, plus a drawdown line under any
   card with a drawdown worth naming. It does not stop listing cards at any
   stop. The hero renders at most four and appends *· 1 more surfaced*, so the
   hour frame shows four cards and a count.
2. **Open the watchlist** → `/watch`. Pause on the headline.
3. Switch the account to **`meera`** and pause on the `KOTAKBANK` ledger — the
   tape down 80%, the holder down 1%, and the five rows that reconcile them.
4. Open a **why this surfaced** panel. Scroll the evidence.
5. `/watch/held-back` — what was considered and refused.
6. `/lab` → **Break the feed → Freeze one symbol** on `SBIN`. Point at
   `illiquid` sitting beside `live`.
7. `/lab` → **Undocumented 10:1** on `RELIANCE`. The card reads *"RELIANCE
   changed −89.80% with nothing on file to explain it"* rather than reporting a
   crash — the figure is off a live replay quote and moves between fetches, so
   it is roughly −90% and not exactly the one printed here. It is also the one
   card in the product with no ledger under it, deliberately: a decomposition
   that closes to 1e-16 would close just as neatly over a price nobody should
   trust, so the card that says *we cannot tell you what happened* does not then
   print five confident rows.
8. **Reset everything.**

Steps 3, 6 and 7 are the whole argument. If the recording has to be shorter,
keep those and the headline.

---

### Then

Uncomment the matching `![...](docs/...)` line in `README.md` for each file you
captured, and delete the slots you did not fill — an image reference that 404s
reads worse than no image at all.

An image above the fold is the difference between depth that exists and depth
that gets noticed.
