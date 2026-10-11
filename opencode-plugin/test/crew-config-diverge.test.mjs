// Self-test (node >= 24):  node test/crew-config-diverge.test.mjs
// Task 029: the plugin reads project settings from the target branch; a key that lives only in the working copy file
// does not act. The doctor warns (names the keys, says the branch wins) and /crew plus the side panel keep one line
// on screen while the files differ; no divergence means silence; a missing branch file gets its own plain line.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const tmp = mkdtempSync(path.join(os.tmpdir(), "crew-diverge-"))
process.env.XDG_DATA_HOME = path.join(tmp, "data")
process.env.CREW_HARNESS_SETTINGS_TTL_MS = "1"
process.env.CREW_HARNESS_DIVERGE_TTL_MS = "0"
const plugin = process.env.CREW_PLUGIN_DIR ? path.resolve(process.env.CREW_PLUGIN_DIR) : path.join(import.meta.dirname, "..")
const settings = await import(pathToFileURL(path.join(plugin, "settings.ts")).href)
const status = await import(pathToFileURL(path.join(plugin, "status.ts")).href)
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" })
const cfgDir = path.join(tmp, "proj", "proj-settings")
const file = path.join(cfgDir, ".opencode", "crew-harness.json")
mkdirSync(path.dirname(file), { recursive: true })
git(cfgDir, "init", "-q", "-b", "main")
const write = (obj) => writeFileSync(file, JSON.stringify({ project: "proj", root: "..", ...obj }, null, 2))
const commit = (obj) => { write(obj); git(cfgDir, "add", "-A"); git(cfgDir, "commit", "-q", "--allow-empty", "-m", "s") }
const doctor = () => settings.settingsProblems(settings.parseProjects({ projects: [cfgDir] }))
const diverge = (ps) => ps.filter((p) => p.includes("отличаются от целевой ветки"))
const sum = () => status.formatStatuses([{ session: "s1", project: "proj", role: "worker", title: "t", state: "idle", detail: "свободна", watches: [], asked: [], tasks: [] }])
const side = () => status.sidebarLines([], Date.now(), "proj").rows.map((r) => status.sideText(r)).join("\n")
let fail = 0
const cell = (n, ok, d) => { console.log(`${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : " :: " + d}`); if (!ok) fail++ }

commit({ answer_max: 1 })
let p = doctor()
cell("same files: doctor silent", diverge(p).length === 0, JSON.stringify(p))
cell("same files: /crew silent", !sum().includes("не на ветке"), sum())
cell("same files: panel silent", !side().includes("не на ветке"), side())

write({ answer_max: 1, tier_max: "light" })
p = doctor()
cell("key only in working copy: doctor warns with key", diverge(p).length === 1 && diverge(p)[0].includes("tier_max") && diverge(p)[0].includes("действуют те, что на ветке"), JSON.stringify(p))
cell("warning names only the differing key", !diverge(p)[0]?.includes("answer_max"), JSON.stringify(p))
cell("key only in working copy: /crew line", sum().includes("не на ветке: tier_max"), sum())
cell("key only in working copy: panel line", side().includes("не на ветке: tier_max"), side())

commit({ answer_max: 1, tier_max: "light" })
cell("after commit: warning gone", diverge(doctor()).length === 0 && !sum().includes("не на ветке"), sum())

const bare = path.join(tmp, "proj2", "s2")
mkdirSync(path.join(bare, ".opencode"), { recursive: true })
git(bare, "init", "-q", "-b", "main")
git(bare, "commit", "-q", "--allow-empty", "-m", "i")
writeFileSync(path.join(bare, ".opencode", "crew-harness.json"), JSON.stringify({ project: "proj2", root: ".." }))
let q
try { q = settings.settingsProblems(settings.parseProjects({ projects: [bare] })) } catch (e) { q = ["THROW " + e] }
cell("no file on branch: plain line, no crash", q.some((x) => x.includes("proj2") && x.includes("не закоммичен")) && !q.some((x) => x.startsWith("THROW")), JSON.stringify(q))
console.log(fail ? `${fail} FAIL` : "all ok")
process.exit(fail ? 1 : 0)
