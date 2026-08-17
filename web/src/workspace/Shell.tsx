/**
 * The workspace frame.
 *
 * Six surfaces, and each one exists because the server already does that work
 * and had nowhere to show it. The event log and the ingestion status in
 * particular carry two of the load-bearing arguments in this project — an
 * immutable log with read state held separately, and a fan-in design whose cost
 * is bounded by the exchange rather than the user count — and both were
 * invisible, which makes an argument into a claim.
 *
 * Nothing here is a page invented to fill a sidebar. If a route were removed,
 * a real capability would stop being reachable.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, isActive, useRouter } from "../router.js";
import { day } from "../format.js";
import type { ReplaySegment, ReplayStatus } from "../types.js";

interface NavItem {
  to: string;
  label: string;
  hint: string;
  exact?: boolean;
}

/** Which sidebar group a route belongs to. The breadcrumb reads from this. */
function groupOf(path: string): string {
  for (const g of GROUPS) {
    if (g.items.some((i) => isActive(path, i.to, i.exact))) return g.title;
  }
  return "Watchlist";
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Watchlist",
    items: [
      { to: "/watch", label: "Digest", hint: "What changed since you last looked", exact: true },
      { to: "/watch/all", label: "All symbols", hint: "The full list, and adding to it" },
      { to: "/watch/held-back", label: "Held back", hint: "What was not shown, and why" },
      { to: "/watch/history", label: "History", hint: "Every event, and whether you saw it" },
    ],
  },
  {
    title: "The system",
    items: [
      { to: "/lab", label: "Lab", hint: "Move time, break the feed" },
      { to: "/system", label: "Health", hint: "Ingestion, provider, data checks" },
    ],
  },
];

/**
 * The two things the frame itself needs off /api/status.
 *
 * `lab`: its routes are not registered in live mode, so offering the page there
 * gives a reviewer a screen whose every button fails against a 404 in silence.
 * The status endpoint already publishes the flag; not reading it was the same
 * mistake as exporting a constant nothing consults.
 *
 * `replay`: which recordings are in play, for the badge below. One fetch for
 * both, because they arrive in one response and two hooks would have made two
 * requests for it.
 *
 * `now`: where the clock is, which the badge needs and which moves. Polled on
 * the same five-second cadence the Health page already uses against the same
 * endpoint, rather than read once at mount: the lab seeks the clock, and a
 * badge that only re-reads on a full page load names the day the process
 * happened to boot into for the rest of the session.
 */
interface ServerFrame {
  lab: boolean;
  replay: ReplayStatus | null;
  now: number | null;
  ready: boolean;
}

function useServerFrame(): ServerFrame {
  // `ready` distinguishes "the server says there is no replay" from "the fetch
  // has not landed yet". Both are `replay: null`, and the sidebar foot below
  // states which mode the process is in, so telling a reader "live market data"
  // for one frame of a replay boot would be a wrong sentence rather than a
  // late one.
  const [s, setS] = useState<ServerFrame>({ lab: true, replay: null, now: null, ready: false });
  useEffect(() => {
    const load = () =>
      void fetch("/api/status")
        .then((r) => r.json())
        .then((v: { lab?: boolean; replay?: ReplayStatus | null; now?: number }) =>
          setS({
            lab: v.lab !== false,
            replay: v.replay ?? null,
            now: typeof v.now === "number" ? v.now : null,
            ready: true,
          }),
        )
        // Keep the last good frame rather than tearing the badge and the
        // sidebar foot off over one failed poll.
        .catch(() => setS((p) => (p.ready ? p : { ...p, ready: false })));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  return s;
}

/**
 * The sitting the clock is sitting in.
 *
 * Falls back to the nearest preceding sitting, because between two recorded
 * days the clock is in an overnight gap belonging to neither, and the prints
 * still being served there are the previous sitting's. Falls back again to the
 * first sitting when the clock is before every recording, and to the last one
 * when there is no clock to read yet.
 */
function segmentAt(segments: ReplaySegment[], now: number | null): ReplaySegment | undefined {
  const last = segments[segments.length - 1];
  if (now == null) return last;
  const inside = segments.find((s) => s.from <= now && now <= s.to);
  if (inside) return inside;
  let before: ReplaySegment | undefined;
  for (const s of segments) if (s.to <= now && (!before || s.to > before.to)) before = s;
  return before ?? segments[0] ?? last;
}

/**
 * Said once, in the header, whenever the tape is not `data/ticks.jsonl` alone.
 *
 * Not "when the day on screen is not the recorded one", which is what this said
 * and what the code tried to implement. Those are different conditions, and the
 * gap between them is a boot that loads an extra day, lands the clock on the
 * canonical one, moves every figure on screen, and shows no badge. Both halves
 * are spelled out on ReplayBadge itself.
 *
 * The sidebar foot says whether a recording is being replayed at all; this says
 * *which*, and only when that answer is not the obvious one. (The foot was
 * unconditional when this sentence was first written and claimed to be "true on
 * every boot" while printing the replay wording under MODE=live -- it is gated
 * on the same status response now.) Every number in the README, in DECISIONS.md and in the fixtures is
 * measured from data/ticks.jsonl, so a reader comparing a figure on screen
 * against a figure in the docs needs to know when they are not looking at the
 * same session -- and a reviewer who asked whether this works on any other day
 * needs to see the answer without being told where to look.
 *
 * Absent on the canonical recording rather than reading "canonical": a badge
 * that is always there is furniture and stops being read.
 *
 * There is deliberately no control here for changing the recording. Swapping
 * the provider under a running process would mean seeking a live clock, a quote
 * store holding the other day's prints, and baselines and watermarks anchored
 * to a session no longer loaded: unreviewed surface a week before the finals,
 * on the one path whose failure mode is a wrong number rather than an error.
 * Restarting the process against TICKS= is also the better demo, because it
 * rebuilds all of the per-process state: the quote store, the clock, and the
 * seeded watermarks, which the server re-lays whenever the recording's landing
 * instant moves.
 *
 * Not "it shows that nothing at all is carried between the two days", which is
 * what this sentence claimed. data/history is reloaded by neither boot, and the
 * 90-day stop of the demo preview returns the same five dividend cards -- same
 * symbols, same order -- on the canonical recording and on a copy re-stamped a
 * day later. That wrong half was written three times -- here, in README.md and
 * in the TICKS block in server/src/index.ts -- and in both of those it sat a
 * few lines from a paragraph saying data/history stays put. This copy had no
 * such paragraph next to it; it is the client, and the tape is not its subject.
 */
function ReplayBadge({ replay, now }: { replay: ReplayStatus | null; now: number | null }) {
  if (!replay || replay.recordings.length === 0) return null;
  /**
   * Two questions, and this used to conflate them into one wrong answer.
   *
   * Whether to show the badge is "is the tape something other than
   * data/ticks.jsonl", and that is a property of the whole pooled set. It used
   * to be asked of the last segment alone -- which recordings overlap it --
   * and the measured consequence was no badge at all on a boot of
   * `TICKS=<a day before the canonical one>,data/ticks.jsonl`: the last segment
   * is the canonical sitting, only the canonical file overlaps it, badge
   * suppressed. The extra day's ticks reach the oracle regardless, because
   * ReplayProvider pools every file: the same demo card read -7.32% and "2.1σ"
   * on that boot against -7.23% and "2.0σ" on a canonical-only one, with the
   * tape's equal-weighted move at -0.010776 against -0.010490. A reader
   * checking a screen figure against a README figure was shown two different
   * sessions and told nothing.
   *
   * What day to name is "where is the clock", and the old code never read the
   * clock at all while its comment claimed it did -- it read the last segment,
   * which is only a proxy for the clock until something moves one. Measured:
   * two recordings loaded, one POST to /api/lab/clock seeking back into the
   * first, /api/status reporting `now` inside the 4 Sept sitting, the ruler
   * reading "now · 4 Sept 14:48" -- and the badge still reading "replaying
   * 5 Sept". Exactly the wrong-day badge that comment said it was designed to
   * avoid.
   */
  const extras = replay.recordings.filter((r) => !r.canonical);
  if (extras.length === 0) return null;
  const seg = segmentAt(replay.segments, now);
  if (!seg) return null;
  // Which recordings that sitting's prints came from, for the tooltip. The
  // badge names one day; the title names the whole pooled set, because every
  // file in it is feeding the oracle whatever day is on screen.
  const here = replay.recordings.filter((r) => r.from <= seg.to && r.to >= seg.from);
  const canonicalDay = here.length > 0 && here.every((r) => r.canonical);
  return (
    <span
      className="ws-session is-replay"
      title={replay.recordings.map((r) => `${r.file}${r.canonical ? " (canonical)" : ""}`).join(", ")}
    >
      {canonicalDay
        ? // The clock is in the recorded session, but it is not the only tape
          // loaded, so the figures are still not the README's.
          `replaying ${day(seg.from)} · pooled with ${extras.length} other recording${
            extras.length === 1 ? "" : "s"
          }`
        : `replaying ${day(seg.from)} · not the recorded session`}
    </span>
  );
}

export function Shell({
  children,
  title,
  lede,
  actions,
  session,
  wide,
}: {
  children: ReactNode;
  title: string;
  lede: string;
  actions?: ReactNode;
  session?: { session: string; isLive: boolean } | undefined;
  wide?: boolean;
}) {
  const { path } = useRouter();
  const { lab: labAvailable, replay, now, ready } = useServerFrame();
  const groups = labAvailable
    ? GROUPS
    : GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.to !== "/lab") }));

  return (
    <div className="ws">
      <nav className="ws-side" aria-label="Sections">
        <Link to="/" className="ws-brand">
          <span className="wordmark">MarketReader</span>
          <span className="ws-brand-back">← overview</span>
        </Link>

        {groups.map((g) => (
          <div className="ws-group" key={g.title}>
            <h2>{g.title}</h2>
            <ul>
              {g.items.map((i) => (
                <li key={i.to}>
                  <Link
                    to={i.to}
                    className={"ws-nav" + (isActive(path, i.to, i.exact) ? " is-active" : "")}
                  >
                    <span className="ws-nav-label">{i.label}</span>
                    <span className="ws-nav-hint">{i.hint}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {/* Gated, because it was not. An unconditional foot consulting neither
            mode nor the status response said "Replaying a recorded NSE session"
            under MODE=live with the provider on yahoo and the header reading
            "closed" -- seen on a live boot at 2026-09-14T16:37Z. The sibling
            Lab link already branched on the same response two lines up, which
            is what made the untruth look deliberate. */}
        {ready && (
          <p className="ws-foot">
            {replay
              ? "Replaying a recorded NSE session. Prices are real; the clock is ours."
              : "Live market data. The clock is the exchange's."}
          </p>
        )}
      </nav>

      <main className={"ws-main" + (wide ? " is-wide" : "")}>
        <header className="ws-head">
          <div>
            <p className="ws-crumb">
              {groupOf(path)} <span aria-hidden="true">/</span> {title}
            </p>
            <h1>{title}</h1>
            <p className="ws-lede">{lede}</p>
          </div>
          <div className="ws-head-actions">
            <ReplayBadge replay={replay} now={now} />
            {session && (
              <span className={"ws-session" + (session.isLive ? " is-live" : "")}>
                {session.isLive ? "market open" : session.session.toLowerCase().replace("_", " ")}
              </span>
            )}
            {actions}
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

/** A labelled figure. Used wherever a number needs a name more than a chart. */
export function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "up" | "down" | "attn";
}) {
  return (
    <div className="stat" data-tone={tone}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
