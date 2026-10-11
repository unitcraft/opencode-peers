// Self-test of submission, the review queue and acceptance (plan 002, Ph.3; node >= 24):  node test/crew-review.test.mjs
// On a real git repository: the executor's report submits the task without waking the integrator; a reviewer is
// assigned by priority (a free open worker tab — never the author or the executor — or a new review session); the
// reviewer starts (review), takes the project's merge lock (merge), returns for rework or accepts: the plugin
// requires a report per required acceptance step and checks that the branch (or a squash commit) is in the target
// branch; then the cleanup steps, checked by the plugin (cleaned) -> sessions closed, a quiet summary to the
// integrator. rework_max exceeded -> a call to the integrator.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = mkdtempSync(path.join(os.tmpdir(), "crew-review-"))
process.env.XDG_DATA_HOME = tmp
process.env.CREW_HARNESS_POLL_MS = "100"
process.env.CREW_HARNESS_DB = path.join(tmp, "absent.db")
delete process.env.CREW_HARNESS_PRESENCE
const proj = path.join(tmp, "proj")
mkdirSync(path.join(proj, ".opencode"), { recursive: true })
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
const settings = (reviewers) =>
  writeFileSync(
    path.join(proj, ".opencode", "crew-harness.json"),
    JSON.stringify({
      worktrees: "wt",
      branch_name: "p{n}-{slug}",
      cleanup: "local",
      merge_precheck: "off", // these cells check the old order of the merge lock (the default is required since 2026-10-09)
      accepted_slot: "hold",
      rework_max: 1,
      spawn_limits: { worker: 5, reviewer: reviewers },
      acceptance: [
        { id: "tests", text: "тесты зелёные", required: true },
        { id: "guards", text: "стражи зелёные", required: true },
        { id: "notes", text: "заметки", required: false },
      ],
    }),
  )
settings(1)
git(proj, "init", "-q", "-b", "main")
writeFileSync(path.join(proj, "a.txt"), "a\n")
git(proj, "add", "-A")
git(proj, "commit", "-q", "-m", "init")

const mod = await import("../index.ts")
const core = await import("../core.ts")
const tasks = await import("../tasks.ts")
const review = await import("../review.ts")
const hooks = {}
const tools = {}
const events = {}
const delivered = []
const sessions = new Map()
const updates = []
const ctx = {
  location: { directory: proj },
  options: { projects: { proj } },
  session: {
    get: async ({ sessionID }) => ({ id: sessionID, title: sessionID, location: { directory: proj }, time: {} }),
    prompt: async ({ sessionID, text, resume }) => delivered.push({ sessionID, text, resume }),
    synthetic: async ({ sessionID, text, resume }) => delivered.push({ sessionID, text, resume, synthetic: true }),
    create: async (req) => {
      if (!sessions.has(req.id)) sessions.set(req.id, req)
      return { id: req.id }
    },
    update: async (req) => updates.push(req),
    hook: async (name, cb) => (hooks[name] = cb),
  },
  tool: { transform: async (fn) => fn({ add: (t) => (tools[t.name] = t) }) },
  events: { on: async (name, cb) => (events[name] = cb) },
}
const stop = await mod.default.setup(ctx)
let fail = 0
const cell = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " :: " + detail}`)
  if (!ok) fail++
}
const wait = (ms = 500) => new Promise((r) => setTimeout(r, ms))
const got = (s, t) => delivered.filter((d) => d.sessionID === s && d.text.includes(t))
const call = async (name, sid, input = {}) => (await tools[name].execute(input, { sessionID: sid })).content
const turnEnds = async (sid) => {
  await hooks.context({ sessionID: sid, system: [], model: { id: "x", providerID: "y" } })
  await events["session.idle"]({ properties: { sessionID: sid } })
}
const FIELDS = { criteria: "тест зелёный" }
const task = (n) => tasks.loadTask("proj", n)

const WPID = 818181
const tabs = ["sesINTEG1", "sesREVIEW1"].map((sessionID, i) => ({ sessionID, active: i === 0, busy: false }))
mkdirSync(core.WINDOWS, { recursive: true })
const beat = () => writeFileSync(path.join(core.WINDOWS, `${WPID}.json`), JSON.stringify({ pid: WPID, beat: Date.now(), tabs }))
beat()
const heart = setInterval(beat, 300)
for (const t of tabs) await turnEnds(t.sessionID)
await call("crew_role", "sesINTEG1", { role: "integrator" })

// 1. task #1: the executor works in its worktree and reports
const sp1 = await call("crew_spawn", "sesINTEG1", { title: "фича", goal: "сделать фичу", ...FIELDS })
const ex1 = task(1).executor
cell("task #1 started with worktree and branch from the settings", /wt.proj-1-ficha/.test(task(1).worktree ?? "") && task(1).branch === "p1-ficha", JSON.stringify({ wt: task(1).worktree, b: task(1).branch, sp1 }))
// plan 002.3: the plugin created the worktree and the branch, the executor's session runs there
await wait(300)
cell("the plugin created the task's worktree on its branch", existsSync(task(1).worktree) && git(task(1).worktree, "rev-parse", "--abbrev-ref", "HEAD") === "p1-ficha" && task(1).worktree_ready === true, JSON.stringify({ wt: task(1).worktree, ready: task(1).worktree_ready }))
cell("the executor's session is located in the worktree", sessions.get(ex1)?.location?.directory === task(1).worktree, JSON.stringify(sessions.get(ex1)?.location))
cell("the task letter says the worktree is ready", got(ex1, "WORKTREE ГОТОВ").length === 1 && got(ex1, "git worktree add").length === 0, JSON.stringify(got(ex1, "ЗАДАЧА").map((d) => d.text.slice(0, 300))))
cell("the task letter lists the project's acceptance steps for the executor", got(ex1, "ПРИЁМЩИК ПРОВЕРИТ").length === 1 && got(ex1, "tests: тесты зелёные").length === 1 && got(ex1, "notes (по желанию): заметки").length === 1, JSON.stringify(got(ex1, "ЗАДАЧА").map((d) => d.text.slice(-400))))
writeFileSync(path.join(task(1).worktree, "f.txt"), "feature\n")
git(task(1).worktree, "add", "-A")
git(task(1).worktree, "commit", "-q", "-m", "feature")
await wait()
const integBefore = delivered.filter((d) => d.sessionID === "sesINTEG1").length
await call("crew_send", ex1, { to: "sesINTEG1", text: "фича готова, тесты зелёные", reply_to: task(1).qid })
await wait(800)
const toInteg = delivered.filter((d) => d.sessionID === "sesINTEG1").slice(integBefore)
cell("the report does not wake the integrator", toInteg.every((d) => d.synthetic), JSON.stringify(toInteg.map((d) => d.text.slice(0, 80))))
cell("the free open worker tab becomes the reviewer", task(1).reviewer === "sesREVIEW1" && task(1).review_kind === "tab", JSON.stringify({ r: task(1).reviewer, k: task(1).review_kind }))
const rl = got("sesREVIEW1", "ПРИЁМКА задачи #1")
cell("the reviewer gets the review letter with the steps and the report", rl.length === 1 && rl[0].text.includes("tests (обязательно)") && rl[0].text.includes("фича готова"), rl[0]?.text.slice(0, 300))
cell("the executor session stays open", core.allCards().find((c) => c.session === ex1)?.spawned?.status === "running", "closed")

// 2. the reviewer's steps, each guarded
const early = await call("crew_task", "sesREVIEW1", { action: "accept", n: 1, checks: { tests: "ok", guards: "ok" } })
cell("accept before review is refused", /на приёмке/.test(early), early)
const notMine = await call("crew_task", "sesINTEG1", { action: "review", n: 1 })
cell("only the reviewer reviews (not the integrator)", /только его/.test(notMine), notMine)
await call("crew_task", "sesREVIEW1", { action: "review", n: 1 })
await wait()
cell("review starts; the executor learns it quietly", task(1).status === "reviewing" && got(ex1, "на приёмке у").some((d) => d.synthetic), JSON.stringify(got(ex1, "приёмке")))
const noLock = await call("crew_task", "sesREVIEW1", { action: "accept", n: 1, checks: { tests: "ok", guards: "ok" } })
cell("accept without the merge lock is refused", /Сначала замок вливания/.test(noLock), noLock)
const lock = await call("crew_task", "sesREVIEW1", { action: "merge", n: 1 })
cell("the reviewer takes the merge lock", /твой/.test(lock) && review.holdsMergeLock("proj", "sesREVIEW1"), lock)
// steps one by one (2026-10-06): the owner sees "проверка 1/3: tests" in the window; accept counts the marked steps
cell("the review steps are kept on the task", JSON.stringify(task(1).steps?.map((a) => a.id)) === '["tests","guards","notes"]', JSON.stringify(task(1).steps))
const unknown = await call("crew_task", "sesREVIEW1", { action: "check", n: 1, step: "nope" })
cell("check of an unknown step is refused, listing the steps", /нет/.test(unknown) && /tests, guards/.test(unknown), unknown)
const started = await call("crew_task", "sesREVIEW1", { action: "check", n: 1, step: "tests" })
cell("check without a result starts the step", task(1).checking?.step === "tests" && /1\/3/.test(started), started)
const st = await import("../status.ts")
const view = { n: 1, status: "reviewing", as: "reviewer", title: "x", steps: task(1).steps.map((a) => ({ id: a.id, text: a.text, ...(task(1).checks?.[a.id] ? { result: task(1).checks[a.id] } : {}) })), checking: task(1).checking.step }
cell("the window shows the step in progress", st.stepProgress(view) === "проверка 1/3: tests", st.stepProgress(view))
const marked = await call("crew_task", "sesREVIEW1", { action: "check", n: 1, step: "tests", result: "зелёные: 12/12" })
cell("check with a result marks the step and ends it", task(1).checks?.tests === "зелёные: 12/12" && !task(1).checking && /1\/3/.test(marked) && /guards/.test(marked), marked)
const noChecks = await call("crew_task", "sesREVIEW1", { action: "accept", n: 1 })
cell("accept without a required step is refused, naming it (the marked one counts)", /guards/.test(noChecks) && !/tests \(/.test(noChecks) && !/notes \(/.test(noChecks), noChecks)
const notMerged = await call("crew_task", "sesREVIEW1", { action: "accept", n: 1, checks: { tests: "12/12", guards: "ok" } })
cell("accept of an unmerged branch is refused", /не влита/.test(notMerged) && task(1).status === "reviewing", notMerged)
git(proj, "merge", "-q", "--no-edit", "p1-ficha")
const acc = await call("crew_task", "sesREVIEW1", { action: "accept", n: 1, checks: { guards: "ok" } })
cell("accept after the merge: accepted, cleanup steps given", task(1).status === "accepted" && /git worktree remove/.test(acc) && /git branch -D p1-ficha/.test(acc) && !/push origin --delete/.test(acc), acc)
cell("accept keeps the steps marked by check", task(1).checks?.tests === "зелёные: 12/12" && task(1).checks?.guards === "ok", JSON.stringify(task(1).checks))
cell("accept releases the merge lock", !review.mergeHolder("proj"), JSON.stringify(review.mergeHolder("proj")))
// leftovers are the task's OWN artifacts (plan 002.6, defect 1): its worktree and branch, sprouts p1-…, integrate/t1;
// a new task born from fresh main stands exactly on the merged commit -- its branch and worktree are never #1's
const mergedHead = git(proj, "rev-parse", "main")
git(proj, "branch", "p1-ficha-cand", "p1-ficha")
git(proj, "branch", "integrate/t1", "p1-ficha")
const newWt = path.join(proj, "wt", "proj-99-novaya")
git(proj, "worktree", "add", "-q", "-b", "p99-novaya", newWt, mergedHead)
git(proj, "branch", "zz-unrelated", mergedHead)
tasks.saveTask({ project: "proj", n: 99, title: "новая", slug: "novaya", goal: "g", priority: "P2", tier: "light", role: "worker", author: "sesINTEG1", author_role: "proj.integrator", qid: "q99", status: "cancelled", kind: "spawn", directory: proj, worktree: newWt, branch: "p99-novaya", executors: [], attempt: 1, history: [], created: Date.now(), updated: Date.now() })
const early2 = await call("crew_task", "sesREVIEW1", { action: "cleaned", n: 1 })
cell("cleaned before the cleanup is refused, naming its own leftovers", /worktree .* ещё есть/.test(early2) && /ветка p1-ficha ещё есть/.test(early2) && /p1-ficha-cand ещё есть/.test(early2) && /Убрано по записи задачи: ветка integrate\/t1/.test(early2) && /action: "track"/.test(early2), early2) // integrate/t1 (task 023): the plugin records and removes it itself
cell("another task on the merged commit is not a leftover of #1", !/p99-novaya/.test(early2) && !/proj-99-novaya/.test(early2) && !/zz-unrelated/.test(early2), early2)
const left1 = await review.leftoversOf(task(1), core.loadConfig(proj), false)
cell("the leftovers reminder of #1 does not name the new task's branch or worktree", left1.some((l) => /p1-ficha-cand/.test(l)) && !left1.some((l) => /p99|proj-99|zz-unrelated/.test(l)), JSON.stringify(left1))
git(proj, "worktree", "remove", task(1).worktree)
for (const b of ["p1-ficha", "p1-ficha-cand"]) git(proj, "branch", "-D", b)
const cl = await call("crew_task", "sesREVIEW1", { action: "cleaned", n: 1 })
await wait(800)
cell("cleaned: the task is cleaned while the new task's branch and worktree stay", task(1).status === "cleaned" && git(proj, "branch", "--list", "p99-novaya").includes("p99-novaya"), cl)
git(proj, "worktree", "remove", newWt)
git(proj, "branch", "-D", "p99-novaya", "zz-unrelated")
rmSync(path.join(core.BASE, "tasks", "proj", "99.json"), { force: true })
cell("the integrator gets a quiet summary", got("sesINTEG1", "принята и влита").some((d) => d.synthetic), JSON.stringify(got("sesINTEG1", "принята")))
cell("the executor session is closed with a final line", core.allCards().find((c) => c.session === ex1)?.spawned?.status === "closed" && got(ex1, "✓✓ Задача #1 «фича» принята").length === 1, JSON.stringify(got(ex1, "✓✓")))
cell("the final line carries the step report", /Отчёт приёмки — шаги 2\/3/.test(got(ex1, "✓✓ Задача #1 «фича» принята")[0]?.text ?? "") && /✓ tests: зелёные: 12\/12/.test(got(ex1, "✓✓ Задача #1 «фича» принята")[0]?.text ?? ""), got(ex1, "✓✓ Задача #1 «фича» принята")[0]?.text)
cell("/crew shows the acceptance report of the day", st.acceptanceReports("proj").some((l) => /отчёт приёмки #1/.test(l)) && st.acceptanceReports("proj").some((l) => /шаги 2\/3 [✓–]{3}/.test(l)), JSON.stringify(st.acceptanceReports("proj")))
cell("the executor session is titled #1 ✓✓", updates.some((u) => u.sessionID === ex1 && u.title === "#1 ✓✓ готово фича"), JSON.stringify(updates.filter((u) => u.sessionID === ex1)))

// 3. queue by priority: both tasks wait (the tab is busy, no review sessions allowed); the tab frees up -> the P1
// task gets it although the P3 one was submitted first; review sessions allowed again -> the P3 task gets one
await call("crew_spawn", "sesINTEG1", { title: "обычная", goal: "g2", ...FIELDS, priority: "P3" })
await call("crew_spawn", "sesINTEG1", { title: "срочная", goal: "g3", ...FIELDS, priority: "P1" })
const ex2 = task(2).executor
const ex3 = task(3).executor
settings(0)
tabs[1].busy = true
beat()
await wait(300)
await call("crew_send", ex2, { to: "sesINTEG1", text: "готово 2", reply_to: task(2).qid })
await wait(400)
await call("crew_send", ex3, { to: "sesINTEG1", text: "готово 3", reply_to: task(3).qid })
await wait(600)
cell("while nobody can review, both wait", !task(2).reviewer && !task(3).reviewer, JSON.stringify({ t2: task(2).reviewer, t3: task(3).reviewer }))
tabs[1].busy = false
beat()
await wait(800)
cell("the freed tab goes to P1, not to the earlier P3", task(3).reviewer === "sesREVIEW1" && !task(2).reviewer, JSON.stringify({ t2: task(2).reviewer, t3: task(3).reviewer }))
settings(1)
await wait(800)
const rv2 = task(2).reviewer
cell("the other task gets a new review session", task(2).review_kind === "spawn" && sessions.has(rv2) && sessions.get(rv2).title === "#2 приёмка обычная", JSON.stringify({ rv2, s: sessions.get(rv2) }))
// plan 002.7: with the default reviewer ("worker") the review session keeps role worker, as before the acceptor role
cell("the default reviewer: the review session's role is worker", core.loadConfig(proj).reviewer === "worker" && core.allCards().find((c) => c.session === rv2)?.role === "worker", JSON.stringify(core.allCards().find((c) => c.session === rv2)?.role))
cell("no reviewer is the author or the executor", [1, 2, 3].every((n) => task(n).reviewer !== task(n).author && task(n).reviewer !== task(n).executor), "same")
await wait()
cell("the review session gets the review letter", got(rv2, "ПРИЁМКА задачи #2").length === 1, JSON.stringify(delivered.filter((d) => d.sessionID === rv2).map((d) => d.text.slice(0, 60))))

// 4. rework, resubmission, rework_max
await call("crew_task", "sesREVIEW1", { action: "review", n: 3 })
await call("crew_task", "sesREVIEW1", { action: "rework", n: 3, text: "нет теста на пустой ввод" })
await wait()
cell("rework: the executor is woken with the remarks", task(3).status === "rework" && got(ex3, "нет теста на пустой ввод").some((d) => !d.synthetic), JSON.stringify(got(ex3, "ДОРАБОТКА")))
await turnEnds(ex3)
await call("crew_send", ex3, { to: "sesINTEG1", text: "добавил тест", reply_to: task(3).qid })
await wait()
await wait(800)
cell("resubmission wakes the same reviewer", task(3).status === "submitted" && task(3).reviewer === "sesREVIEW1" && got("sesREVIEW1", "Доработка задачи #3 «срочная» сдана").length === 1, JSON.stringify(delivered.filter((d) => d.sessionID === "sesREVIEW1").map((d) => d.text.slice(0, 160))))
// a return only to merge the fresh main (plan 002.6, defect 4): not a rework round, rework_max (1 here) is not hit
await call("crew_task", "sesREVIEW1", { action: "review", n: 3 })
const syncAns = await call("crew_task", "sesREVIEW1", { action: "rework", n: 3, sync: true })
await wait()
cell("rework {sync: true} wakes the executor to merge the fresh main", task(3).status === "rework" && got(ex3, "СИНХРОНИЗАЦИЯ задачи #3").some((d) => !d.synthetic) && got(ex3, "влей свежую main").length >= 1, JSON.stringify(got(ex3, "СИНХРОНИЗАЦИЯ").map((d) => d.text.slice(0, 200))))
cell("a sync return is not a rework round: no rework_max call", task(3).rework === 1 && task(3).syncs === 1 && !got("sesINTEG1", "уходит на доработку 2-й раз").length && /в rework_max не идёт/.test(syncAns), JSON.stringify({ r: task(3).rework, s: task(3).syncs, syncAns }))
await turnEnds(ex3)
await call("crew_send", ex3, { to: "sesINTEG1", text: "влил свежий main", reply_to: task(3).qid })
await wait(800)
cell("resubmission after a sync wakes the reviewer again", task(3).status === "submitted" && got("sesREVIEW1", "Доработка задачи #3 «срочная» сдана").length === 2, JSON.stringify(delivered.filter((d) => d.sessionID === "sesREVIEW1").map((d) => d.text.slice(0, 120))))
await call("crew_task", "sesREVIEW1", { action: "review", n: 3 })
await call("crew_task", "sesREVIEW1", { action: "rework", n: 3, text: "и ещё одно" })
await wait()
cell("over rework_max the integrator gets a call", got("sesINTEG1", "уходит на доработку 2-й раз").some((d) => !d.synthetic), JSON.stringify(got("sesINTEG1", "доработку")))

// 5. the merge lock is one per project
await call("crew_send", ex3, { to: "sesINTEG1", text: "исправил всё", reply_to: task(3).qid })
await call("crew_task", "sesREVIEW1", { action: "review", n: 3 })
await call("crew_task", "sesREVIEW1", { action: "merge", n: 3 })
await call("crew_task", rv2, { action: "review", n: 2 })
const busyLock = await call("crew_task", rv2, { action: "merge", n: 2 })
cell("a second reviewer cannot take the merge lock", /у приёмщика задачи #3/.test(busyLock), busyLock)

// 6. squash merge: accept with the commit in the target branch
writeFileSync(path.join(proj, "squash.txt"), "x\n")
git(proj, "add", "-A")
git(proj, "commit", "-q", "-m", "squash of #3")
const sha = git(proj, "rev-parse", "HEAD")
const sq = await call("crew_task", "sesREVIEW1", { action: "accept", n: 3, checks: { tests: "ok", guards: "ok" }, commit: sha })
cell("a squash commit in the target branch is accepted", task(3).status === "accepted" && task(3).commit === sha, sq)
const bad = await call("crew_task", rv2, { action: "merge", n: 2 })
const wrong = await call("crew_task", rv2, { action: "accept", n: 2, checks: { tests: "ok", guards: "ok" }, commit: "0000000000000000000000000000000000000000" })
cell("after the release the lock is free; a commit not in the target is refused", /твой/.test(bad) && /нет в main|не влита|коммита/.test(wrong), `${bad} | ${wrong}`)

// 7. a task given to an owner's worker tab: that tab never reviews its own task
tabs.push({ sessionID: "sesOWNTAB", active: false, busy: false })
beat()
await turnEnds("sesOWNTAB")
await call("crew_task", "sesINTEG1", { action: "assign", session: "sesOWNTAB", title: "своя", goal: "g4", ...FIELDS })
tabs[1].busy = true // the only other worker tab is busy; review sessions are at the limit (task #2's)
beat()
await wait(300)
await call("crew_send", "sesOWNTAB", { to: "sesINTEG1", text: "готово 4", reply_to: task(4).qid })
await wait(800)
cell("the executor's own tab does not become its reviewer", task(4).reviewer !== "sesOWNTAB", JSON.stringify({ r: task(4).reviewer }))
cell("the review sessions are at the limit: #4 waits for a reviewer", !task(4).reviewer, JSON.stringify({ r: task(4).reviewer }))

// 8. rework does not hold the reviewer's place (the methodology: waiting for someone else's step blocks nothing)
await call("crew_task", rv2, { action: "rework", n: 2, text: "добавь проверку" })
await wait(800)
cell("#2 on rework frees the place: #4 gets a review session", task(2).status === "rework" && task(4).review_kind === "spawn" && !!task(4).reviewer && task(4).reviewer !== rv2, JSON.stringify({ s2: task(2).status, r4: task(4).reviewer, k4: task(4).review_kind }))
await call("crew_send", ex2, { to: "sesINTEG1", text: "доработал 2", reply_to: task(2).qid })
await wait(800)
cell("the resubmission goes back to the same reviewer at once", task(2).reviewer === rv2 && task(2).status === "submitted" && got(rv2, "доработал 2").length >= 1, JSON.stringify({ r2: task(2).reviewer, s2: task(2).status, n: got(rv2, "доработал 2").length }))

clearInterval(heart)
stop?.()
rmSync(tmp, { recursive: true, force: true })
console.log(fail ? `crew-review.test: FAIL ${fail}` : "crew-review.test ok")
process.exit(fail ? 1 : 0)
