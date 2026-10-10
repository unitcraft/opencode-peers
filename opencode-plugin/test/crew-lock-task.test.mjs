// Self-test: the merge lock knows its task (task 006; node >= 24):  node test/crew-lock-task.test.mjs
// LT-1..3: merge_precheck: off, one reviewer with two tasks: by default the second merge swaps the task in the lock as before; with the
// project flag merge_lock_per_task: on it is refused with a reason. LT-4..5: rework/cancel of another task does not release the lock of
// the held one (always). LT-6..7: a broken settings file in the legacy mode is reported (log, doctor line) and does not silently turn
// the protection keys off (the last good settings are kept).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { harness, reporter } from "./landing-harness.mjs"

const { cell, done } = reporter("crew-lock-task.test")
const H = await harness("crew-lock-task", { settings: { merge_precheck: "off" } })
const { call, review } = H
const REV = "sesREV1"
const holder = () => review.mergeHolder("proj")
const clear = () => review.releaseMergeLock("proj", holder()?.session ?? "")

{
  const a = H.reviewing()
  const b = H.reviewing()
  await call("crew_task", REV, { action: "merge", n: a.n })
  const m = await call("crew_task", REV, { action: "merge", n: b.n })
  cell("LT-1 default: the second merge of the same holder swaps the task as before", holder()?.n === b.n && /твой/.test(m), m + JSON.stringify(holder()))
  clear()
  H.settings({ merge_lock_per_task: "on" })
  await call("crew_task", REV, { action: "merge", n: a.n })
  const m2 = await call("crew_task", REV, { action: "merge", n: b.n })
  cell("LT-2 flag on: merge of another task by the holder is refused with the reason", holder()?.n === a.n && new RegExp(`#${a.n}`).test(m2) && /accept|rework|unlock/.test(m2), m2 + JSON.stringify(holder()))
  const m3 = await call("crew_task", REV, { action: "merge", n: a.n })
  cell("LT-3 flag on: repeat merge of the same task is fine", holder()?.n === a.n && /твой/.test(m3), m3)
  // LT-4: rework of b does not release the lock of a
  await call("crew_task", REV, { action: "rework", n: b.n, text: "fix" })
  cell("LT-4 rework of another task keeps the lock of the held one", holder()?.n === a.n, JSON.stringify(holder()))
  // LT-5: cancel of b (reviewer REV) does not release it either
  const c = H.reviewing()
  await call("crew_task", "sesINTEG1", { action: "cancel", n: c.n })
  cell("LT-5 cancel of another task keeps the lock of the held one", holder()?.n === a.n, JSON.stringify(holder()))
  await call("crew_task", REV, { action: "rework", n: a.n, text: "fix" })
  cell("LT-5b rework of the held task releases its lock", !holder(), JSON.stringify(holder()))
  H.settings({})
}

// ---- legacyWalk: a broken file
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "lt-legacy-"))
  const f = path.join(dir, ".opencode", "crew-harness.json")
  mkdirSync(path.dirname(f), { recursive: true })
  const settings = await import("../settings.ts")
  writeFileSync(f, JSON.stringify({ merge_precheck: "required", rework_max: 7 }))
  const first = settings.rawSettingsFor(dir, [])
  writeFileSync(f, "{ not json")
  const broken = settings.rawSettingsFor(dir, [])
  cell("LT-6 broken legacy file: the last good settings are kept (protection keys stay)", first.rework_max === 7 && broken.rework_max === 7 && broken.merge_precheck === "required", JSON.stringify(broken))
  const probs = settings.settingsProblems([{ name: "leg", root: settings.normPath(dir), rootPath: dir }])
  cell("LT-7 broken legacy file: crew_doctor names the file", probs.some((p) => p.includes("crew-harness.json") && /не JSON/.test(p)), JSON.stringify(probs))
  rmSync(dir, { recursive: true, force: true })
}

done(H)
