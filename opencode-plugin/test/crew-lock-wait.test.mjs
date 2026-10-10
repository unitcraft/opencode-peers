// Self-test: waking the acceptors that wait for the merge lock (task 011; node >= 24):  node test/crew-lock-wait.test.mjs
// LW-1: a refusal "lock busy" records the waiter in its card (lock_wait), not in a separate store. LW-2: /crew and the panel show one
// line "ждут замок: #N (мин)". LW-3: when the lock is released the waiters get a letter "замок свободен" and the record is cleared.
// LW-4: a waiter that takes the lock is not a waiter any more; a closed tab (no live window) is not woken.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { harness, reporter } from "./landing-harness.mjs"

const { cell, done } = reporter("crew-lock-wait.test")
const H = await harness("crew-lock-wait", { settings: { merge_precheck: "off" } })
const { call, review, core } = H
const A = "sesREV1"
const B = "sesREV2"
const card = (s) => core.readJson(core.cardFile(s))
const letters = (s) => {
  const d = path.join(core.INBOX, core.safeKey(s))
  try {
    return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(d, f), "utf8")))
  } catch {
    return []
  }
}
const readLetters = (s) => [...letters(s), ...H.delivered.filter((d) => d.sessionID === s)].map((l) => l.text ?? "").join("\n")
const status = await import("../status.ts")

const a = H.reviewing({ reviewer: A })
const b = H.reviewing({ reviewer: B })
await call("crew_task", A, { action: "merge", n: a.n })
const refused = await call("crew_task", B, { action: "merge", n: b.n })
cell("LW-1 refusal: the waiter is recorded in its card", /занят|у приёмщика/.test(refused) && card(B)?.lock_wait?.n === b.n && card(B).lock_wait.project === "proj", refused + JSON.stringify(card(B)))
const line = review.lockWaitLine("proj", Date.now() + 5 * 60_000)
cell("LW-2 the line 'ждут замок: #N (мин)'", line === `ждут замок: #${b.n} (5 мин)`, String(line))
cell("LW-2 /crew carries it", status.formatStatuses([{ session: "x", role: "worker", title: "x", state: "idle", detail: "d", project: "proj", watches: [], asked: [], tasks: [] }], Date.now()).includes("ждут замок: #" + b.n), "no line")
cell("LW-2 the panel carries it", status.sidebarLines([], Date.now(), "proj").rows.some((r) => r.what.includes("ждут замок")), "no row")
await call("crew_task", A, { action: "rework", n: a.n, text: "fix" })
await H.until(() => /proj свободен/.test(readLetters(B)), 10_000)
cell("LW-3 release: the waiter gets 'Замок вливания ... свободен' and the record is cleared", /proj свободен/.test(readLetters(B)) && !card(B)?.lock_wait && review.lockWaitLine("proj") === undefined, readLetters(B) + JSON.stringify(card(B)))
// LW-4: a waiter that takes the lock is cleared
const c = H.reviewing({ reviewer: A })
await call("crew_task", A, { action: "merge", n: c.n })
await call("crew_task", B, { action: "merge", n: b.n }) // refused again: recorded
const before = !!card(B)?.lock_wait
review.releaseMergeLock("proj", A)
await call("crew_task", B, { action: "merge", n: b.n })
cell("LW-4 the waiter that took the lock is not a waiter", before && !card(B)?.lock_wait && review.mergeHolder("proj")?.session === B, JSON.stringify(card(B)))
done(H)
