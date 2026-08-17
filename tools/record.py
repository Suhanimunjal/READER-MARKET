"""
Live NSE tick recorder. Captures a real trading session to disk so the whole
system can be developed and demoed deterministically over the weekend, when
the market is closed. This file is a dev tool, not part of the product.

It used to open data/ticks.jsonl in append mode with no way to name another
file, so running it a second time would have silently welded a second session
onto the end of the recording that every number in the README, the golden tests
and the seeded demo accounts is measured from. Nothing would have crashed. The
numbers would just have moved. It now writes one file per IST day, and refuses
to open the canonical recording: any path that resolves to that file, and any
path whose name is that name.
"""
import argparse, json, os, sys, time, urllib.request, urllib.parse, urllib.error, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
BARS = os.path.join(DATA, "bars")
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

# The one file this tool will not write. data/ticks.jsonl is the session
# recorded on 4 September 2026, pinned by line count and sha256 in
# server/test/regressions.test.ts, and there is no legitimate reason to append
# to it -- so there is no override flag either. A flag would be the thing
# someone reaches for at 2am. Held lowercase because the refusal below
# lowercases the name it is given; see is_canonical for why.
CANONICAL = "ticks.jsonl"

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

SYMBOLS = [
    "^NSEI", "^NSEBANK",
    "RELIANCE", "HDFCBANK", "TCS", "INFY", "ICICIBANK", "SBIN", "ITC", "LT",
    "AXISBANK", "BHARTIARTL", "HINDUNILVR", "KOTAKBANK", "BAJFINANCE", "MARUTI",
    "SUNPHARMA", "TITAN", "ASIANPAINT", "NESTLEIND", "ULTRACEMCO", "WIPRO",
    "HCLTECH", "TECHM", "ONGC", "COALINDIA", "NTPC", "POWERGRID", "GRASIM",
    "TATAMOTORS", "TATASTEEL", "JSWSTEEL", "HINDALCO", "VEDL", "ADANIENT",
    "ADANIPORTS", "ETERNAL", "PAYTM", "IRFC", "SUZLON", "YESBANK", "IDEA",
    "JIOFIN", "TATAPOWER", "BEL", "RVNL", "IREDA", "HAL", "DLF", "BANKBARODA",
    "PNB", "CANBK",
]

def yurl(sym):
    y = sym if sym.startswith("^") else sym + ".NS"
    return f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(y)}?interval=1m&range=1d"

def fetch(url, timeout=12):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def snapshot(sym, res):
    m = res.get("meta", {}) or {}
    return {
        "sym": sym,
        "poll_ts": round(time.time(), 3),
        "mkt_ts": m.get("regularMarketTime"),
        "state": m.get("currentTradingPeriod", {}).get("regular") and "REGULAR" or None,
        "ltp": m.get("regularMarketPrice"),
        "prev_close": m.get("chartPreviousClose") or m.get("previousClose"),
        "day_high": m.get("regularMarketDayHigh"),
        "day_low": m.get("regularMarketDayLow"),
        "vol": m.get("regularMarketVolume"),
        "w52_high": m.get("fiftyTwoWeekHigh"),
        "w52_low": m.get("fiftyTwoWeekLow"),
        "ccy": m.get("currency"),
        "exch": m.get("exchangeName"),
        "tz_off": m.get("gmtoffset"),
    }

def in_regular_session(res):
    """
    Whether this response is a print from an open market.

    Deliberately not the `state` field the snapshot writes. That field is truthy
    whenever the provider ships a `currentTradingPeriod.regular` block, which it
    does at every hour of every day -- it reads "REGULAR" in all 7,038 lines of
    the canonical recording, so a closed-market check built on it would never
    fire once, which is worse than not having one. The window itself can be
    false: this compares the exchange's own last trade stamp against the regular
    period's start and end. The schema is left alone because ReplayProvider
    parses these files and the canonical recording is byte-pinned.
    """
    m = res.get("meta", {}) or {}
    reg = (m.get("currentTradingPeriod", {}) or {}).get("regular") or {}
    start, end, t = reg.get("start"), reg.get("end"), m.get("regularMarketTime")
    if start is None or end is None or t is None:
        return False
    return start <= t < end

def default_out():
    """One file per IST trading day. The date is the exchange's, not the host's."""
    return os.path.join(DATA, "ticks-" + datetime.datetime.now(IST).strftime("%Y-%m-%d") + ".jsonl")

def is_canonical(out):
    """
    Whether --out would open the canonical recording. Identity, not spelling.

    The first version of this guard was `os.path.basename(out) == CANONICAL`,
    which is a case-sensitive comparison on a case-insensitive filesystem. On
    Windows -- the machine this was written on and the one it will be run on --
    `--out data/Ticks.jsonl`, `data/TICKS.JSONL`, `data/ticks.jsonl.` and
    `data/ticks.jsonl ` all passed that guard and every one of them opens the
    canonical file: NTFS folds case, and Win32 strips trailing dots and spaces
    off a path component. Shell completion produces the capitalised one. So a
    refusal that is documented as absolute was four keystrokes from being a
    suggestion.

    Two checks, because neither covers the other. samefile/realpath resolves
    case, `..`, symlinks and junctions, and is the truth when the file is on
    disk. The normalised basename covers the file being absent -- a clone
    without the recording still must not have one written for it -- and refuses
    the name in any directory, which is the spelling someone reaches for when
    they have copied the tree somewhere else.
    """
    target = os.path.join(DATA, CANONICAL)
    try:
        if os.path.exists(out) and os.path.samefile(out, target):
            return True
    except OSError:
        pass
    if os.path.normcase(os.path.realpath(out)) == os.path.normcase(os.path.realpath(target)):
        return True
    return os.path.basename(os.path.abspath(out)).rstrip(" .").lower() == CANONICAL

def resolve_out(argv=None):
    ap = argparse.ArgumentParser(description="Record a live NSE session to a JSONL tick file.")
    ap.add_argument(
        "--out", metavar="PATH", default=None,
        help="tick file to append to (default: data/ticks-<IST date>.jsonl)",
    )
    out = ap.parse_args(argv).out or default_out()
    if is_canonical(out):
        print(
            f"refusing to write {out}\n"
            f"  {CANONICAL} is the canonical recorded session of 4 September 2026.\n"
            "  Its line count and sha256 are pinned by server/test/regressions.test.ts,\n"
            "  and the golden tests, the seeded demo accounts and the numbers in\n"
            "  README.md are all measured from it. This tool appends, so one run\n"
            "  against that file would move every one of them without an error.\n"
            "  Record to another path -- the default is data/ticks-<IST date>.jsonl.",
            file=sys.stderr, flush=True,
        )
        sys.exit(2)
    return out

def main():
    out = resolve_out()
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    os.makedirs(BARS, exist_ok=True)
    print(f"recording to {out}", flush=True)
    cycle = 0
    while True:
        cycle += 1
        ok = fail = regular = 0
        # Append, not truncate: a recording interrupted by a dropped connection
        # is resumed by re-running against the same path, and each cycle's ticks
        # belong after the last. The danger was never the mode, it was which
        # file the mode was pointed at.
        with open(out, "a", encoding="utf-8") as tf:
            for sym in SYMBOLS:
                try:
                    d = fetch(yurl(sym))
                    res = (d.get("chart", {}).get("result") or [None])[0]
                    if not res:
                        fail += 1; continue
                    tf.write(json.dumps(snapshot(sym, res), separators=(",", ":")) + "\n")
                    if in_regular_session(res):
                        regular += 1
                    # full 1m series, overwritten each cycle -> last write is the complete day
                    with open(os.path.join(BARS, sym.replace("^", "_") + ".json"), "w", encoding="utf-8") as bf:
                        json.dump(res, bf, separators=(",", ":"))
                    ok += 1
                except Exception as e:
                    fail += 1
                    print(f"  !{sym}: {type(e).__name__}", file=sys.stderr, flush=True)
                time.sleep(0.18)
        print(f"[{datetime.datetime.now():%H:%M:%S}] cycle {cycle}  ok={ok} fail={fail}", flush=True)
        if cycle == 1 and regular == 0:
            # Said once, after the first cycle, because a recording made against
            # a shut exchange is 51 identical rows repeated until you stop it and
            # you find out hours later. The holiday calendar in the product
            # deliberately does not carry 2026's lunar-calendar dates, so "is it
            # actually open today" is a question this tool cannot answer from the
            # calendar -- but it can answer it from the feed, for free.
            print(
                "  WARNING: no symbol reported a trade inside the regular session this cycle.\n"
                "  The market appears to be closed; this recording will be flat. Check the date.",
                file=sys.stderr, flush=True,
            )
        time.sleep(8)

if __name__ == "__main__":
    main()
