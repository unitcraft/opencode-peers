// Self-test of the task worktree base (task 022; node >= 24):  node test/crew-worktree-base.test.mjs
// The task branch starts from the published target branch (origin/<target>), not from a stale local one; no remote ->
// the local base with a warning; a local branch that differs from the published one -> one line with the numbers,
// the local branch is never moved.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ensureWorktree } from "../review.ts"

const tmp = mkdtempSync(path.join(os.tmpdir(), "crew-wtbase-"))
let fail = 0
const cell = (name, ok, extra = "") => {
  if (!ok) fail++
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " :: " + extra}`)
}
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
const commit = (dir, name) => {
  writeFileSync(path.join(dir, name), name)
  git(dir, "add", "--", name)
  git(dir, "commit", "-q", "-m", name)
}
const mk = (name) => {
  const d = path.join(tmp, name)
  mkdirSync(d, { recursive: true })
  git(d, "init", "-q", "-b", "main")
  commit(d, "a")
  return d
}
const origin = path.join(tmp, "origin.git")
execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin])

// 1. local behind origin
const p1 = mk("p1")
git(p1, "remote", "add", "origin", origin)
git(p1, "push", "-q", "origin", "main")
const p1b = path.join(tmp, "p1b")
execFileSync("git", ["clone", "-q", origin, p1b])
commit(p1b, "b")
git(p1b, "push", "-q", "origin", "main")
const pub = git(p1b, "rev-parse", "HEAD")
const r1 = await ensureWorktree(p1, path.join(tmp, "wt1"), "t1", "main")
cell("behind: branch starts from origin/main", r1.ok && git(path.join(tmp, "wt1"), "rev-parse", "HEAD") === pub, JSON.stringify(r1))
cell("behind: the line says behind 1, ahead 0", /позади на 1, впереди на 0 относительно origin\/main/.test(r1.note ?? ""), JSON.stringify(r1))
cell("behind: local main is not moved", git(p1, "rev-parse", "main") !== pub)

// 2. diverged
commit(p1, "local")
const r2 = await ensureWorktree(p1, path.join(tmp, "wt2"), "t2", "main")
cell("diverged: from origin/main, note with numbers and the human", r2.ok && git(path.join(tmp, "wt2"), "rev-parse", "HEAD") === pub && /позади на 1, впереди на 1/.test(r2.note ?? "") && /решает человек/.test(r2.note ?? ""), JSON.stringify(r2))

// 3. equal: no note
const p3 = path.join(tmp, "p3")
execFileSync("git", ["clone", "-q", origin, p3])
const r3 = await ensureWorktree(p3, path.join(tmp, "wt3"), "t3", "main")
cell("equal: no note, no warning", r3.ok && !r3.note && !r3.warn, JSON.stringify(r3))

// 4. no remote
const p4 = mk("p4")
const r4 = await ensureWorktree(p4, path.join(tmp, "wt4"), "t4", "main")
cell("no remote: local base with a warning", r4.ok && git(path.join(tmp, "wt4"), "rev-parse", "HEAD") === git(p4, "rev-parse", "main") && !!r4.warn && !r4.note, JSON.stringify(r4))

rmSync(tmp, { recursive: true, force: true })
console.log(fail ? `crew-worktree-base.test: FAIL ${fail}` : "crew-worktree-base.test ok")
process.exit(fail ? 1 : 0)
