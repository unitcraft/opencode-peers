// Self-test of the data retention pass (node >= 24):  node test/crew-retention.test.mjs
// Old delivered letters, empty session folders, cards and statuses of closed tabs are removed once a day; open questions,
// undelivered letters (inbox/), live tabs, tabs with open obligations and tasks/ records stay; retention_days=0 removes nothing.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = mkdtempSync(path.join(os.tmpdir(), "crew-retention-"))
process.env.XDG_DATA_HOME = tmp
const core = await import("../core.ts")
const ret = await import("../retention.ts")
let fail = 0
const cell = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " :: " + detail}`)
  if (!ok) fail++
}
const DAY = 86_400_000
const age = (f, days) => {
  const t = (Date.now() - days * DAY) / 1000
  utimesSync(f, t, t)
}
const put = (dir, name, body, days) => {
  mkdirSync(dir, { recursive: true })
  const f = path.join(dir, name)
  writeFileSync(f, JSON.stringify(body))
  age(f, days)
  return f
}
const card = (session, days) => put(core.CARDS, `${session}.json`, { session, role: "worker", auto: false, title: "", directory: "x", repo: "x", pid: 1, updated: Date.now() - days * DAY }, days)
const status = (session, days) => put(path.join(core.BASE, "status"), `${session}.json`, { session, role: "worker", state: "idle", detail: "", watches: [], asked: [], tasks: [], updated: Date.now() - days * DAY }, days)

const boxA = path.join(core.READ, "sesA")
const oldLetter = put(boxA, "old-1.json", { id: "old-1", text: "x" }, 10)
const freshLetter = put(boxA, "fresh-2.json", { id: "fresh-2", text: "x" }, 1)
const openQ = put(boxA, "q-3.json", { id: "q-3", qid: "qOPEN", text: "?" }, 10)
const answeredQ = put(boxA, "q-4.json", { id: "q-4", qid: "qDONE", text: "?" }, 10)
put(path.join(core.READ, "sesIds"), "old-5.json", { id: "old-5" }, 10)
mkdirSync(path.join(core.READ, "sesEmpty"), { recursive: true })
mkdirSync(path.join(core.INBOX, "sesEmptyInbox"), { recursive: true })
const undelivered = put(path.join(core.INBOX, "sesB"), "wait-6.json", { id: "wait-6" }, 30)
core.saveObligations("sesA", [{ qid: "qOPEN", from_session: "sesZ", from_role: "worker", at: Date.now(), nudges: 0 }])

const deadOld = card("sesDead", 10)
const deadFresh = card("sesFresh", 1)
const liveOld = card("sesLive", 10)
const oblOld = card("sesA", 10)
const deadStatus = status("sesDead", 10)
const liveStatus = status("sesLive", 10)
mkdirSync(path.join(core.BASE, "windows"), { recursive: true })
writeFileSync(path.join(core.BASE, "windows", "1.json"), JSON.stringify({ pid: 1, beat: Date.now(), tabs: [{ sessionID: "sesLive" }] }))

// 0: nothing is removed
cell("retention_days=0 does nothing", ret.runRetention(0) === undefined && existsSync(oldLetter) && existsSync(deadOld), "removed")
const r = ret.runRetention(7)
cell("old delivered letter removed, fresh stays", !existsSync(oldLetter) && existsSync(freshLetter), JSON.stringify(r))
cell("letter with an open question stays, answered one goes", existsSync(openQ) && !existsSync(answeredQ), "wrong")
cell("empty session folders removed (read/ and inbox/); a folder with ids stays", !existsSync(path.join(core.READ, "sesEmpty")) && !existsSync(path.join(core.INBOX, "sesEmptyInbox")) && existsSync(path.join(core.READ, "sesIds")), readdirSync(core.READ) + " " + readdirSync(core.INBOX))
cell("undelivered letters in inbox/ stay", existsSync(undelivered), "removed")
cell("old card of a closed tab removed; fresh, live and obligated stay", !existsSync(deadOld) && existsSync(deadFresh) && existsSync(liveOld) && existsSync(oblOld), "wrong")
cell("status of a closed tab removed, of a live one stays", !existsSync(deadStatus) && existsSync(liveStatus), "wrong")
cell("the pass reports counts", r && r.letters === 3 && r.dirs === 2 && r.cards === 1, JSON.stringify(r))
// removing a letter keeps its id (no repeat)
cell("removed letter still counts as sent", (await import("../tasks.ts")).letterExists("sesA", "old-1"), "lost")
const old2 = put(boxA, "old-7.json", { id: "old-7" }, 10)
cell("a second run within a day does nothing", ret.runRetention(7) === undefined && existsSync(old2), "ran again")

try {
  rmSync(tmp, { recursive: true, force: true })
} catch {}
console.log(fail ? `crew-retention.test: FAIL ${fail}` : "crew-retention.test ok")
process.exit(fail ? 1 : 0)
