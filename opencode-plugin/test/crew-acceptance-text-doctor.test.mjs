// Self-test (node >= 24):  node test/crew-acceptance-text-doctor.test.mjs
// The doctor warns when, with merge_precheck: required, an acceptance step text describes the acceptance order itself
// (the order belongs to the plugin). It only warns; no sign in the text, or merge_precheck: off, means no warning.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const tmp = mkdtempSync(path.join(os.tmpdir(), "crew-acc-doctor-"))
process.env.XDG_DATA_HOME = path.join(tmp, "data")
process.env.CREW_HARNESS_SETTINGS_TTL_MS = "1"
const plugin = process.env.CREW_PLUGIN_DIR ? path.resolve(process.env.CREW_PLUGIN_DIR) : path.join(import.meta.dirname, "..")
const settings = await import(pathToFileURL(path.join(plugin, "settings.ts")).href)
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" })
const cfgDir = path.join(tmp, "proj", "proj-settings")
mkdirSync(path.join(cfgDir, ".opencode"), { recursive: true })
git(cfgDir, "init", "-q", "-b", "main")
const set = (obj) => {
  writeFileSync(path.join(cfgDir, ".opencode", "crew-harness.json"), JSON.stringify({ project: "proj", root: "..", ...obj }, null, 2))
  git(cfgDir, "add", "-A")
  git(cfgDir, "commit", "-q", "--allow-empty", "-m", "s")
  return settings.settingsProblems(settings.parseProjects({ projects: [cfgDir] }))
}
let fail = 0
const cell = (n, ok, d) => { console.log(`${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : " :: " + d}`); if (!ok) fail++ }
const has = (ps, id) => ps.some((p) => p.includes(`шаг ${id} описывает порядок приёмки`) && p.includes("crew_help"))
const old = [{ id: "ci", text: "CI под замком: crew_watch … land-task" }, { id: "gate", text: "Запусти гейт проекта и приложи вердикт" }]

let p = set({ acceptance: old })
cell("default (required): ci step warns", has(p, "ci"), JSON.stringify(p))
cell("step without signs: no warning", !has(p, "gate"), JSON.stringify(p))
p = set({ merge_precheck: "required", acceptance: [{ id: "x", text: "замок вливания держит CI" }] })
cell("merge lock near CI warns", has(p, "x"), JSON.stringify(p))
p = set({ merge_precheck: "off", acceptance: old })
cell("merge_precheck off: no warning", !has(p, "ci"), JSON.stringify(p))
p = set({ acceptance: [{ id: "ci", text: "Прогони npm test, зелёный набор" }] })
cell("clean text: no warning", !has(p, "ci"), JSON.stringify(p))
console.log(fail ? `${fail} FAIL` : "all ok")
process.exit(fail ? 1 : 0)
