"""
Read a tick file written by record.py and say whether it is worth keeping.

A recording is cheap to make and expensive to discover is bad, because you find
out from a demo rather than from an error: a session recorded against a closed
exchange parses perfectly, replays perfectly, and is 51 flat lines. This reads
the file and reports what it actually contains, then exits nonzero if the
recording is too thin to build anything on.

Standard library only, like the rest of tools/.
"""
import argparse, collections, datetime, json, os, sys

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

# Thresholds. The canonical 4 September 2026 session -- 51 symbols, 71.6 minutes,
# zero null prices -- clears all three with room, which is the point: these mark
# "unusable", not "as good as the one we have".
MIN_SYMBOLS = 45
MIN_SPAN_MINUTES = 45.0
MAX_NULL_PRICE_FRACTION = 0.05

def ist(ts):
    return datetime.datetime.fromtimestamp(ts, IST).strftime("%Y-%m-%d %H:%M:%S IST")

def read(path):
    """Ticks, plus the lines that were not ticks. A truncated final line is
    normal while the recorder is still running -- ReplayProvider skips it too --
    so it is counted and reported rather than raised."""
    ticks, bad = [], 0
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                t = json.loads(line)
            except ValueError:
                bad += 1
                continue
            if isinstance(t, dict) and t.get("sym") and isinstance(t.get("poll_ts"), (int, float)):
                ticks.append(t)
            else:
                bad += 1
    return ticks, bad

def main(argv=None):
    ap = argparse.ArgumentParser(description="Report on a recorded tick file and judge whether it is usable.")
    ap.add_argument("path", help="path to a JSONL tick file, e.g. data/ticks.jsonl")
    args = ap.parse_args(argv)

    if not os.path.exists(args.path):
        print(f"no such file: {args.path}", file=sys.stderr)
        return 2

    ticks, bad = read(args.path)
    if not ticks:
        print(f"{args.path}: no parseable ticks ({bad} unparseable lines)", file=sys.stderr)
        return 1

    per_symbol = collections.Counter(t["sym"] for t in ticks)
    nulls = sum(1 for t in ticks if t.get("ltp") is None)
    null_fraction = nulls / len(ticks)

    polls = sorted({round(t["poll_ts"], 3) for t in ticks})
    lo, hi = min(t["poll_ts"] for t in ticks), max(t["poll_ts"] for t in ticks)
    span_minutes = (hi - lo) / 60.0

    # Monotonicity is checked per symbol, because that is the order
    # ReplayProvider sorts and binary-searches in. The file interleaves symbols,
    # so a global scan would flag the interleaving and not a real problem.
    violations = 0
    worst_symbol = None
    by_symbol = collections.defaultdict(list)
    for t in ticks:
        by_symbol[t["sym"]].append(t["poll_ts"])
    for sym, seq in by_symbol.items():
        v = sum(1 for a, b in zip(seq, seq[1:]) if b < a)
        violations += v
        if v and (worst_symbol is None or v > worst_symbol[1]):
            worst_symbol = (sym, v)

    # The session state as the provider reported it at record time. Worth
    # printing and not worth gating on: the field is "REGULAR" whenever the
    # provider ships a regular-period block, which it does around the clock, so
    # a closed-market recording scores 100% here. record.py checks openness
    # against the trade stamp instead, live, where the answer can be no.
    regular_polls = sorted({round(t["poll_ts"], 3) for t in ticks if t.get("state") == "REGULAR"})
    regular_span = (max(regular_polls) - min(regular_polls)) / 60.0 if len(regular_polls) > 1 else 0.0
    regular_share = (regular_span / span_minutes * 100.0) if span_minutes > 0 else 0.0

    print(f"{args.path}")
    print(f"  ticks          {len(ticks)} over {len(polls)} distinct poll instants"
          + (f"  ({bad} unparseable line{'' if bad == 1 else 's'})" if bad else ""))
    print(f"  symbols        {len(per_symbol)}")
    print(f"  IST span       {ist(lo)}  ->  {ist(hi)}   ({span_minutes:.1f} min)")
    print(f"  REGULAR span   {regular_span:.1f} min, {regular_share:.1f}% of the recording"
          f"  ({len(ticks) - sum(1 for t in ticks if t.get('state') == 'REGULAR')} ticks not marked REGULAR)")
    print(f"  null prices    {nulls} of {len(ticks)} ({null_fraction * 100:.2f}%)")
    print(f"  poll_ts order  {violations} backwards step(s) within a symbol"
          + (f", worst {worst_symbol[0]} x{worst_symbol[1]}" if worst_symbol else ""))
    print("  per symbol:")
    for sym, n in sorted(per_symbol.items(), key=lambda kv: (kv[1], kv[0])):
        print(f"    {sym:12s} {n}")

    problems = []
    if len(per_symbol) < MIN_SYMBOLS:
        problems.append(f"only {len(per_symbol)} symbols, need {MIN_SYMBOLS}")
    if span_minutes < MIN_SPAN_MINUTES:
        problems.append(f"span is {span_minutes:.1f} min, need {MIN_SPAN_MINUTES:.0f}")
    if null_fraction > MAX_NULL_PRICE_FRACTION:
        problems.append(f"{null_fraction * 100:.2f}% null prices, limit {MAX_NULL_PRICE_FRACTION * 100:.0f}%")

    if problems:
        print("\nUNUSABLE: " + "; ".join(problems))
        return 1
    print("\nusable.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
