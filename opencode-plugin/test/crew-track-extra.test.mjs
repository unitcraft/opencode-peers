// Self-test: side branches and trees in the task record (task 023; node >= 24):
//   node test/crew-track-extra.test.mjs
// The record field is `side` (`extra` is taken by the project's extra task fields). cleaned removes what is recorded (a tree on
// integrate/t<N>-precheck by the auto-record, a branch with a foreign name by track), except trees in keep; track adds without
// duplicates; an old record without the field reads as empty and cleans as before; an unrecorded foreign name is still refused
// with a text that offers track.
import { existsSync } from "node:fs"
import path from "node:path"
import { harness, reporter } from "./landing-harness.mjs"

const { cell, done } = reporter("crew-track-extra.test")
const H = await harness("crew-track-extra", { settings: { worktrees: "wt", cleanup: "local" } })
const { call, git, proj } = H
const REV = "sesREV1"
const rec = (n) => H.task(n)
const branches = () => git(proj, "branch", "--format=%(refname:short)").split(/\r?\n/).filter(Boolean)
const accepted = () => {
  const t = H.reviewing()
  const x = H.task(t.n)
  x.status = "accepted"
  H.tasks.saveTask(x)
  git(proj, "branch", "-D", x.branch)
  return t.n
}

// old record: no field
{
  const n = accepted()
  cell("TR-1 an old record has no side and reads as empty", rec(n).side === undefined)
  const shown = await call("crew_task", REV, { action: "view", n })
  cell("TR-1b view works without the field and has no side line", !/побочные ветки/.test(shown), shown)
  const r = await call("crew_task", REV, { action: "cleaned", n })
  cell("TR-1c cleaned of an old record works as before", rec(n).status === "cleaned", r)
}
// auto: integrate/tN-precheck with its tree
{
  const n = accepted()
  const tree = path.join(proj, "wt", `proj-${n}-precheck`)
  git(proj, "worktree", "add", "-q", "-b", `integrate/t${n}-precheck`, tree, "origin/main")
  git(proj, "branch", `integrate/t${n}-precheck-main`, "origin/main")
  const r = await call("crew_task", REV, { action: "cleaned", n })
  cell("TR-2 cleaned removes the auto-seen branches and the tree", rec(n).status === "cleaned" && !existsSync(tree) && !branches().some((b) => b.startsWith(`integrate/t${n}`)), r)
  cell("TR-2b the record lists them as written by the plugin", (rec(n).side ?? []).length === 3 && rec(n).side.every((i) => i.auto), JSON.stringify(rec(n).side))
}
// track: no duplicates, foreign name, view
{
  const n = accepted()
  git(proj, "branch", `old-name-${n}-final`, "origin/main")
  const a = await call("crew_task", REV, { action: "track", n, branch: `old-name-${n}-final` })
  const b = await call("crew_task", REV, { action: "track", n, branch: `old-name-${n}-final` })
  cell("TR-3 track adds once, the second call says already recorded", rec(n).side?.length === 1 && /Записано/.test(a) && /Уже записано/.test(b), a + b)
  const shown = await call("crew_task", REV, { action: "view", n })
  cell("TR-3b view shows the side list", /побочные ветки.*old-name-/.test(shown), shown)
  const bad = await call("crew_task", REV, { action: "track", n })
  cell("TR-3c track without branch and worktree is refused", /нужна branch/.test(bad) && rec(n).side.length === 1, bad)
  const outsider = await call("crew_task", "sesOTHER", { action: "track", n, branch: "x" })
  cell("TR-3d a stranger cannot track", rec(n).side.length === 1, outsider)
  const r = await call("crew_task", REV, { action: "cleaned", n })
  cell("TR-3e cleaned removes the tracked foreign-named branch", rec(n).status === "cleaned" && !branches().includes(`old-name-${n}-final`), r)
}
// keep wins over the record
{
  const n = accepted()
  const tree = path.join(proj, "wt", `proj-${n}-ev`)
  git(proj, "worktree", "add", "-q", "--detach", tree, "origin/main")
  await call("crew_task", REV, { action: "track", n, worktree: tree })
  const r = await call("crew_task", REV, { action: "cleaned", n, keep: [`wt/proj-${n}-ev`] })
  cell("TR-4 a tracked tree in keep stays", rec(n).status === "cleaned" && existsSync(tree) && /Сохранено/.test(r), r)
}
// unrecorded name matching the project template: old refusal, now with the hint
{
  const n = accepted()
  const tree = path.join(proj, "wt", `proj-${n}-stray`)
  git(proj, "worktree", "add", "-q", "--detach", tree, "origin/main")
  const r = await call("crew_task", REV, { action: "cleaned", n })
  cell("TR-5 an unrecorded tree by template: refused, text offers track", rec(n).status === "accepted" && /ещё есть/.test(r) && /action: "track"/.test(r), r)
  await call("crew_task", REV, { action: "track", n, worktree: tree })
  const r2 = await call("crew_task", REV, { action: "cleaned", n })
  cell("TR-5b after track the same cleaned passes and removes it", rec(n).status === "cleaned" && !existsSync(tree), r2)
}
await done()
