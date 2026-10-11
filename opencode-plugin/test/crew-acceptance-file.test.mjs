// Self-test (node >= 24):  node test/crew-acceptance-file.test.mjs
// acceptance_file: the acceptance steps come from a markdown table in a file of the project repository (read from the target
// branch); both sources set -> doctor error and the file wins; file missing -> fallback to `acceptance` with a log warning;
// no acceptance_file -> as before.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "crew-acc-file-")))
process.env.XDG_DATA_HOME = path.join(tmp, "data")
process.env.CREW_HARNESS_POLL_MS = "100"
process.env.CREW_HARNESS_DB = path.join(tmp, "absent.db")
process.env.CREW_HARNESS_SETTINGS_TTL_MS = "1"
process.env.CREW_HARNESS_ACCEPTANCE_TTL_MS = "1"
process.env.CREW_HARNESS_PRESENCE = "all"
const plugin = process.env.CREW_PLUGIN_DIR ? path.resolve(process.env.CREW_PLUGIN_DIR) : path.join(import.meta.dirname, "..")
const load = (f) => import(pathToFileURL(path.join(plugin, f)).href)
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
const root = path.join(tmp, "proj")
const cfgDir = path.join(root, "proj-settings")
const work = path.join(root, "repo")
mkdirSync(path.join(cfgDir, ".opencode"), { recursive: true })
mkdirSync(path.join(work, "doc"), { recursive: true })
git(cfgDir, "init", "-q", "-b", "main")
git(work, "init", "-q", "-b", "main")
const setSettings = (obj) => {
  writeFileSync(path.join(cfgDir, ".opencode", "crew-harness.json"), JSON.stringify({ project: "proj", root: "..", ...obj }, null, 2))
  git(cfgDir, "add", "-A")
  git(cfgDir, "commit", "-q", "--allow-empty", "-m", "s")
}
const table = [
  "# Acceptance",
  "",
  "| id | текст | обязателен |",
  "|----|-------|------------|",
  "| ci | Прогони CI проекта | да |",
  "| docs | Обнови документы | нет |",
  "| tests | Тесты зелёные |  |",
  "|  | строка без id |  да |",
  "| ci | повтор id | да |",
].join("\n")
writeFileSync(path.join(work, "doc", "acceptance.md"), table)
git(work, "add", "-A")
git(work, "commit", "-q", "-m", "doc")

const core = await load("core.ts")
const settings = await load("settings.ts")
let fail = 0
const cell = (n, ok, d) => { console.log(`${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : " :: " + d}`); if (!ok) fail++ }
const ids = () => JSON.stringify(core.loadConfig(work).acceptance.map((a) => `${a.id}:${a.required ? 1 : 0}`))
const problems = () => settings.settingsProblems(settings.parseProjects({ projects: [cfgDir] }))
const logText = () => { try { return readFileSync(path.join(os.tmpdir(), "opencode-plugins.log"), "utf8") } catch { return "" } }
const texts = [{ id: "old", text: "старый шаг" }]

setSettings({ acceptance: texts })
core.setProjects(settings.parseProjects({ projects: [cfgDir] }))
cell("no acceptance_file: texts as before", ids() === '["old:1"]', ids())
setSettings({ acceptance_file: "doc/acceptance.md" })
cell("file: steps from the table, default required, dup and idless skipped", ids() === '["ci:1","docs:0","tests:1"]', ids())
cell("file: text is read", core.loadConfig(work).acceptance[0]?.text === "Прогони CI проекта", JSON.stringify(core.loadConfig(work).acceptance[0]))
setSettings({ acceptance_file: "doc/acceptance.md", acceptance: texts })
cell("both: file wins", ids() === '["ci:1","docs:0","tests:1"]', ids())
cell("both: doctor error", problems().some((p) => p.includes("проект proj") && p.includes("acceptance_file") && p.includes("оставь один источник")), JSON.stringify(problems()))
setSettings({ acceptance_file: "doc/acceptance.md" })
cell("file only: no doctor error", !problems().some((p) => p.includes("оставь один источник")), JSON.stringify(problems()))
setSettings({ acceptance_file: "doc/missing.md", acceptance: texts })
cell("file missing: fallback to texts", ids() === '["old:1"]', ids())
cell("file missing: warning in log", logText().includes("acceptance_file") && logText().includes("doc/missing.md"), "no line")
setSettings({ acceptance_file: "doc/missing.md" })
cell("file missing, no texts: no steps", ids() === "[]", ids())
console.log(fail ? `${fail} FAIL` : "all ok")
process.exit(fail ? 1 : 0)
