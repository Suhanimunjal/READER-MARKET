/**
 * Delete the replay demo's database, so the next boot re-seeds the four
 * accounts from scratch.
 *
 * Why this is a file and not a line in package.json: there is no delete-if-present
 * one-liner that is correct on every shell this repo is run from, and adding
 * `rimraf` to get one would be a dependency bought for a demo convenience. npm
 * runs scripts through `cmd.exe` on Windows and `sh` elsewhere, so `rm -f`
 * fails on Windows ("'rm' is not recognized") and `del /q` fails everywhere
 * else -- and `del` on a missing file still writes "Could Not Find" to the
 * console, which is exactly the line you do not want scrolling past ninety
 * seconds before a demo. Node is already the runtime, so this is a short script
 * in it rather than a dependency.
 *
 * Which file: the one `dbPathFor([])` in server/src/index.ts returns when TICKS
 * is unset and DB_PATH is unset -- `<root>/data/marketreader.db`. That is the
 * database `npm run serve` opens. The TICKS-derived databases beside it
 * (`marketreader-<stem>-<hash>.db`) are deliberately left alone: they belong to
 * other recordings, and a script that swept the directory would take them with
 * it. So is everything else in data/ -- ticks.jsonl above all, which every
 * number in this repository is measured from and which regressions.test.ts
 * pins by sha256.
 *
 * The -wal and -shm sidecars go too. Removing the database and leaving a write-ahead
 * log next to it is the one combination that is worse than doing nothing:
 * SQLite recovers from the WAL on open, so the "fresh" boot comes up holding
 * the watermarks the delete was supposed to remove.
 *
 * Why the try/catch: `rmSync(path, { force: true })` suppresses ENOENT and only
 * ENOENT. On Windows a running server holds all three files, and every one of
 * them throws EBUSY -- measured on a server pointed at a scratch database, all
 * three unlinks threw `EBUSY: resource busy or locked`. Uncaught, that is a
 * twenty-line node:internal stack trace and exit 1, which also means the
 * `&& npm run serve` half of `npm run demo:fresh` never runs and the presenter
 * is left with no server at all. A stack trace is worse than the "Could Not
 * Find" line this file exists to avoid, and it arrives in the commonest demo
 * mistake there is: forgetting to Ctrl-C the previous instance. So catch it and
 * say the one thing that fixes it. A second PORT does not help -- the port and
 * the database are independent, and the other process still holds the file.
 */
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, not from process.cwd(), so it deletes the same
// database whether npm invoked it from the repo root or a person ran
// `node tools/fresh-db.mjs` from somewhere else.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "data", "marketreader.db");

// Sidecars first, database last. The catch below exits mid-loop, and the one
// partial state that would be worse than doing nothing is a -wal with no .db
// beside it -- the paragraph above is about the reverse of that, and the same
// argument forbids this order being flipped back. Failing on the -wal leaves
// the database intact, which is just the state the script started in.
let removed = 0;
for (const path of [DB + "-wal", DB + "-shm", DB]) {
  if (!existsSync(path)) continue;
  try {
    rmSync(path, { force: true });
  } catch (err) {
    // EBUSY on Windows, EPERM on some mounts: another process has the file
    // open. There is nothing this script can do about that, so print the fix
    // rather than the trace and stop before `npm run serve` starts a second
    // server against a database that was never cleared.
    if (err?.code === "EBUSY" || err?.code === "EPERM") {
      process.stderr.write(
        `[fresh] something still has ${path} open -- stop the running server first (Ctrl-C), then re-run. A second PORT does not release it.\n`,
      );
      process.exit(1);
    }
    throw err;
  }
  removed++;
}

process.stdout.write(
  removed === 0
    ? `[fresh] no database at ${DB}; the next boot seeds one\n`
    : `[fresh] removed ${removed} file(s) for ${DB}\n`,
);
