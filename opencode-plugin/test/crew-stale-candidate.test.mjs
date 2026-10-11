// Self-test: a task branch that moved ahead of the precheck candidate makes the candidate stale (task 030; node >= 24):
//   node test/crew-stale-candidate.test.mjs
// stale: the branch got a commit after precheck and the candidate neither contains it nor has its tree -> merge refused, lock free,
// record stale, text names both short SHAs; same tree (squash) passes; candidate containing the branch passes; no local branch passes.
import { writeFileSync } from "node:fs"
import path from "node:path"
import { harness, reporter } from "./landing-harness.mjs"

const { cell, done } = reporter("crew-stale-candidate.test")
const H = await harness("crew-stale-candidate", { settings: { merge_precheck: "required" } })
const { call, git, proj } = H
const REV = "sesREV1"
const merge = (t) => call("crew_task", REV, { action: "merge", n: t.n })
const clear = () => H.review.releaseMergeLock("proj", H.review.mergeHolder("proj")?.session ?? "")
const prep = async (build) => {
  const t = H.reviewing()
  await call("crew_task", REV, { action: "precheck", n: t.n })
  git(proj, "fetch", "-q", "origin")
  const name = `integrate/t${t.n}`
  build(t, name)
  await call("crew_task", REV, { action: "precheck", n: t.n, candidate: name, result: "CI зелёный" })
  return t
}
const advance = (t, real) => {
  const cur = git(proj, "rev-parse", "--abbrev-ref", "HEAD")
  git(proj, "switch", "-q", t.branch)
  if (real) { writeFileSync(path.join(proj, `late${t.n}.txt`), "late"); git(proj, "add", "--", `late${t.n}.txt`) }
  git(proj, "commit", "-q", "--allow-empty", "-m", "more work")
  git(proj, "switch", "-q", cur)
  return git(proj, "rev-parse", t.branch)
}

{
  const t = await prep((t) => H.candidate(`integrate/t${t.n}`, { merge: t.branch }))
  const cand = git(proj, "rev-parse", `integrate/t${t.n}`)
  const tip = advance(t, true)
  const m = await merge(t)
  cell("branch ahead: refused, lock free, record stale, two SHAs", /Замок не выдан/.test(m) && m.includes(tip.slice(0, 7)) && m.includes(cand.slice(0, 7)) && /Пересобери/.test(m) && !H.holder() && H.task(t.n).precheck.state === "stale" && /ушла вперёд/.test(H.task(t.n).precheck.stale.reason), m)
}
{
  const t = await prep((t, name) => {
    const cur = git(proj, "rev-parse", "--abbrev-ref", "HEAD")
    git(proj, "switch", "-q", "-C", name, "origin/main")
    git(proj, "checkout", "-q", t.branch, "--", ".")
    git(proj, "commit", "-q", "-m", "squash")
    git(proj, "switch", "-q", cur)
  })
  advance(t) // an empty commit: same tree as the candidate's contribution
  const m = await merge(t)
  cell("squash with the same tree: passes", /fast-forward/.test(m) && !!H.holder(), m)
  clear()
}
{
  const t = await prep((t, name) => H.candidate(name, { merge: t.branch }))
  const m = await merge(t)
  cell("candidate contains the branch: passes", /fast-forward/.test(m) && !!H.holder(), m)
  clear()
}
{
  const t = await prep((t, name) => H.candidate(name, { merge: t.branch }))
  const rec = H.task(t.n)
  rec.branch = "t-missing"
  H.tasks.saveTask(rec)
  const m = await merge(t)
  cell("no local branch: passes silently", /fast-forward/.test(m) && !!H.holder(), m)
  clear()
}
done(H)
