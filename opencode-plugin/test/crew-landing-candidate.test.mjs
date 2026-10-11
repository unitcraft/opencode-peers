// Self-test: merge names the fixed candidate to land (task 028; node >= 24):
//   node test/crew-landing-candidate.test.mjs
// merge_precheck: required: the answer of merge names the SHA of the candidate of the precheck record and says to fast-forward the target to it;
// the task branch is not told to be landed; a differing branch gets the one-line "this is normal" note; a candidate that is not a
// fast-forward of the tip under the lock is refused with the lock released; merge_precheck: off keeps the old text.
import { harness, reporter } from "./landing-harness.mjs"

const { cell, done } = reporter("crew-landing-candidate.test")
const H = await harness("crew-landing-candidate", { settings: { merge_precheck: "required" } })
const { call, git, proj } = H
const REV = "sesREV1"
const merge = (t) => call("crew_task", REV, { action: "merge", n: t.n })
const prep = async (kind) => {
  const t = H.reviewing()
  await call("crew_task", REV, { action: "precheck", n: t.n })
  git(proj, "fetch", "-q", "origin")
  let sha
  if (kind === "same") {
    git(proj, "branch", "-f", `integrate/t${t.n}`, t.branch)
    sha = git(proj, "rev-parse", t.branch)
  } else sha = H.candidate(`integrate/t${t.n}`)
  await call("crew_task", REV, { action: "precheck", n: t.n, candidate: `integrate/t${t.n}`, result: "CI зелёный" })
  return { t, sha }
}
const clear = () => H.review.releaseMergeLock("proj", H.review.mergeHolder("proj")?.session ?? "")

{
  const { t, sha } = await prep("differs")
  const m = await merge(t)
  cell("differs: names candidate SHA, fast-forward + push of the candidate, branch not to be landed, one-line note", m.includes(sha) && /fast-forward/.test(m) && /push/.test(m) && /отличается от проверенного кандидата, это нормально/.test(m) && !m.includes(`Влей ветку ${t.branch}`), m)
  clear()
}
{
  const { t, sha } = await prep("same")
  const m = await merge(t)
  cell("same: names candidate SHA, no 'differs' note", m.includes(sha) && !/отличается от проверенного/.test(m) && /fast-forward/.test(m), m)
  clear()
}
{
  const { t } = await prep("differs")
  // candidate not built on the current tip: a rival commit on the origin is the tip, the record base is forged to it
  const moved = H.moveOrigin("other.txt")
  git(proj, "fetch", "-q", "origin")
  const rec = H.task(t.n)
  rec.precheck.base = moved
  H.tasks.saveTask(rec)
  const m = await merge(t)
  cell("not fast-forward: refused, lock free", /Замок не выдан/.test(m) && /fast-forward/.test(m) && !H.holder(), m)
}
{
  H.settings({ merge_precheck: "off" })
  const t = H.reviewing()
  const m = await merge(t)
  cell("off: old text, branch named", m.includes(`ветку ${t.branch}`) && !/кандидат/.test(m), m)
  clear()
}
done(H)
