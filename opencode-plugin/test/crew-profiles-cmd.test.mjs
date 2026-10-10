// Self-test of the window commands /crew-sets and /crew-profiles (task 003, ADR-0014: edits go straight into the file; node >= 24):
//   node test/crew-profiles-cmd.test.mjs
// The commands are called as the window calls them (the registered slash command with prompt.text): tables, show, use with
// its report, the edit verbs of both commands with their refusals, check, the removed save / reset, an old layer file, one line
// of the plugin log per edit. The answer is a service message, never a turn of the model. A real git repository of
// settings; a state read is cached for long and the cache is dropped by hand after a commit.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = mkdtempSync(path.join(os.tmpdir(), "crew-profiles-cmd-"))
process.env.TEMP = tmp // the plugin log lives in os.tmpdir(): this keeps the lines of this test apart from the live service
process.env.TMP = tmp
process.env.XDG_DATA_HOME = path.join(tmp, "data")
process.env.XDG_CONFIG_HOME = path.join(tmp, "xdgcfg")
process.env.CREW_HARNESS_POLL_MS = "100"
process.env.CREW_HARNESS_PROFILES_MS = "100000"
process.env.CREW_HARNESS_DB = path.join(tmp, "absent.db")
process.env.CREW_HARNESS_SETTINGS_TTL_MS = "600000"
process.env.CREW_HARNESS_PRESENCE = "all"

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex")
const prof = (model, context, output, input) => ({ model, context, output, ...(input ? { input } : {}) })
const c = (family, tier) => ({ family, tier })
const KIMI = "kimi-code-plan-global/k3-256k"
const TABLE = {
  claude: { heavy: prof("claude-code/opus", 720000, 64000), medium: prof("claude-code/sonnet", 720000, 64000), light: prof("claude-code/haiku", 220000, 32000) },
  kimi: { heavy: prof(KIMI, 220000, 131072), medium: prof(KIMI, 220000, 131072), light: prof(KIMI, 220000, 131072) },
  codex: { heavy: prof("openai/gpt-5.5", 525000, 128000, 461000), medium: prof("openai/gpt-5.6-terra", 525000, 128000, 461000), light: prof("openai/gpt-6-luna", 525000, 128000, 461000) },
}
const SETS = {
  default: { develop: c("claude", "task"), plan: c("claude", "task"), accept: c("claude", "task"), plan_accept: c("claude", "task") },
  "cross-kimi": { develop: c("claude", "task"), plan: c("claude", "task"), accept: c("kimi", "heavy"), plan_accept: c("kimi", "heavy") },
  "cross-codex": { develop: c("claude", "medium"), plan: c("claude", "heavy"), accept: c("codex", "heavy"), plan_accept: c("codex", "heavy") },
  "kimi-only": { develop: c("kimi", "heavy"), plan: c("kimi", "heavy"), accept: c("kimi", "heavy"), plan_accept: c("kimi", "heavy") },
}
const root = path.join(tmp, "proj")
const cfgDir = path.join(root, "proj-settings")
mkdirSync(path.join(cfgDir, ".opencode"), { recursive: true })
const file = path.join(cfgDir, ".opencode", "crew-harness.json")
const base = { project: "cmdproj", root: ".." }
git(cfgDir, "init", "-q", "-b", "main")
const writeFileJson = (obj) => writeFileSync(file, JSON.stringify(obj, null, 2))
const readFileJson = () => JSON.parse(readFileSync(file, "utf8"))
writeFileJson({ ...base, model_profiles: TABLE, profile_sets: SETS })
git(cfgDir, "add", "-A")
git(cfgDir, "commit", "-q", "-m", "settings")
const commits = () => Number(git(cfgDir, "rev-list", "--count", "HEAD"))
// hand-written files: the global one (a window of Kimi above the profile, a reserved), nothing in the project yet
mkdirSync(path.join(process.env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
const globalCfg = path.join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc")
writeFileSync(globalCfg, `{ // hand-written, machine-wide\n  "compaction": { "reserved": 20000 },\n  "provider": { "kimi-code-plan-global": { "models": { "k3-256k": { "limit": { "context": 262144, "output": 131072 } } } } } }\n`)

const mod = await import("../index.ts")
const core = await import("../core.ts")
const L = await import("../profile-layer.ts")
const { writeSettings } = await import("../settings.ts")
const commands = {}
const replies = []
const prompts = []
let catalog = [
  { providerID: "claude-code", modelID: "opus" }, { providerID: "claude-code", modelID: "sonnet" }, { providerID: "claude-code", modelID: "haiku" },
  { providerID: "kimi-code-plan-global", modelID: "k3-256k" },
  { providerID: "openai", modelID: "gpt-5.5", limit: { context: 1050000, input: 922000, output: 128000 } }, { providerID: "openai", modelID: "gpt-5.6-terra" }, { providerID: "openai", modelID: "gpt-6-luna" },
]
let catalogFails = false
const ctx = {
  location: { directory: root },
  app: { name: "opencode", version: "2.0.23-test" },
  options: { projects: [cfgDir] },
  command: { list: async () => ({ data: [] }), transform: async (fn) => fn({ add: (cmd) => (commands[cmd.name] = cmd) }) },
  model: { list: async () => { if (catalogFails) throw new Error("catalog down"); return { data: catalog } } },
  session: {
    get: async ({ sessionID }) => ({ id: sessionID, title: sessionID, location: { directory: root }, time: {} }),
    prompt: async (p) => prompts.push(p),
    synthetic: async ({ sessionID, text }) => replies.push({ sessionID, text }),
    hook: async () => {},
  },
  tool: { transform: async (fn) => fn({ add: () => {} }) },
}
const stop = await mod.default.setup(ctx)
let fail = 0
const cell = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " :: " + detail}`)
  if (!ok) fail++
}
const allReplies = []
// the window runs the same functions with the catalog of the window (tui.ts); here the catalog is the test one
const Cmd = await import("../profile-cmd.ts")
const deps = { version: "2.0.23-test", catalog: async () => { if (catalogFails) throw new Error("catalog down"); return catalog } }
const run = async (name, text) => {
  const n = replies.length
  let t
  try { t = await (name === "crew-sets" ? Cmd.runSetsCommand : Cmd.runProfilesCommand)(root, text, deps) } catch (e) { t = `Команда не выполнена: ${e?.message ?? e}` }
  replies.push({ sessionID: "sesOWNER", text: t })
  const r = replies.slice(n).map((x) => x.text).join("\n")
  allReplies.push(r)
  return r
}
const sets = (t) => run("crew-sets", t)
const profs = (t) => run("crew-profiles", t)
const bump = () => writeSettings(cfgDir, {}) // drops the settings cache of the folder (rewrites the same working file)
const commit = (msg) => {
  git(cfgDir, "add", "-A")
  git(cfgDir, "commit", "-q", "-m", msg)
  bump()
}
const logPath = path.join(tmp, "opencode-plugins.log")
const editLines = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter((l) => / profile edit: cmdproj /.test(l)) : [])
const refusedLines = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter((l) => / profile edit refused: cmdproj /.test(l)) : [])
const st = () => L.profileState(root)
bump() // normalises the working file once

// ---- AC-07: tables, show, use, reset; no turn of the model ----
cell("the plugin of the server registers no /crew-sets and /crew-profiles (they are window commands, see crew-instant-commands.test)", !commands["crew-sets"] && !commands["crew-profiles"], Object.keys(commands).join())
let r = await sets("")
cell("AC-07 /crew-sets without an argument: a table of all sets with the four stages, none enabled", ["default", "cross-kimi", "cross-codex", "kimi-only", "разработка", "приёмка", "планирование", "приёмка плана", "claude/task", "kimi/heavy"].every((w) => r.includes(w)) && /Включён: нет/.test(r) && !r.includes("●  ") , r)
r = await profs("")
cell("AC-07 /crew-profiles without an argument: the table family, tier -> model, window", /claude\s+heavy\s+claude-code\/opus\s+контекст 720K · вывод до 64K/.test(r) && /codex\s+heavy\s+openai\/gpt-5\.5\s+контекст 525K · ввод 461K · вывод до 128K/.test(r), r)
r = await profs("show")
cell("AC-07 /crew-profiles show without a name: the whole table in detail", /kimi\s+light/.test(r), r)
r = await profs("show codex")
cell("limits wording: the answers of both commands carry no bare number pairs and no English field names (контекст, ввод, вывод до)", !/\d{6}\/\d{4,6}/.test(r) && (await sets("show cross-kimi")).includes("контекст") && !/context \d/.test(await profs("")) && !/output \d/.test(await profs("")), r)
cell("AC-07 /crew-profiles show <family>: the three tiers with the references of the sets", /heavy: openai\/gpt-5\.5 — контекст 525K · ввод 461K · вывод до 128K/.test(r) && /cross-codex/.test(r), r)
r = await sets("show")
cell("AC-07 show without a name and without an enabled set says so", /Набор не включён/.test(r), r)
const hashFile0 = sha(file)
const commits0 = commits()
r = await sets("use no-such-set")
cell("AC-07 use with an unknown name: refusal with the list of the names; nothing changed", /Не сделано/.test(r) && /no-such-set/.test(r) && /cross-kimi/.test(r) && sha(file) === hashFile0, r)
cell("AC-17 a refused edit leaves one `profile edit refused` line and no `profile edit:` line", refusedLines().length === 1 && editLines().length === 0, JSON.stringify([refusedLines().length, editLines().length]))
r = await sets("use cross-kimi")
cell("AC-07 use: what changed, restart is not needed, the windows of the reviewers are said to be general", /Включён набор «cross-kimi»/.test(r) && /Перезапуск не нужен/.test(r) && /Приёмка и приёмка плана: контекст профиля здесь не применяется/.test(r) && /модель kimi-code-plan-global\/k3-256k берёт контекст из рукописных и глобальных настроек: контекст 262144 · вывод до 131072/.test(r), r)
cell("AC-21 use writes profile_set into the working copy of the file at once, atomically, without a commit; the data in force are the file", sha(file) !== hashFile0 && readFileJson().profile_set === "cross-kimi" && st().name === "cross-kimi" && commits() === commits0 && JSON.parse(git(cfgDir, "show", "HEAD:.opencode/crew-harness.json")).profile_set === undefined, st().name)
cell("AC-21 the write left no temporary file and no layer file", !existsSync(`${file}.${process.pid}.tmp`) && !existsSync(L.layerFile("cmdproj")), "left")
cell("AC-17 use leaves exactly one line of the log", editLines().length === 1 && /crew-sets use include|crew-sets use/.test(editLines()[0]), JSON.stringify(editLines()))
r = await sets("")
cell("AC-07 the table marks the enabled set", /● cross-kimi/.test(r) && !/локальн/.test(r), r)
r = await sets("show")
cell("AC-07 show of the enabled set: model, tier, window per stage; for the reviewers `the profile window is not applied here` with the number", /Набор «cross-kimi» — включён \(имя в файле проекта\)/.test(r) && /приёмка: kimi\/heavy → kimi-code-plan-global\/k3-256k/.test(r) && /контекст профиля здесь не применяется/.test(r) && /контекст профиля в рабочем дереве задачи \(heavy\): контекст 720K · вывод до 64K/.test(r), r)
r = await sets("show kimi-only")
cell("AC-07 show <name>: any set", /Набор «kimi-only» — не включён/.test(r), r)
const hashBeforeGone = sha(file)
r = await sets("reset")
cell("reset is gone with the layer: a plain answer, the file and the name are as they were, no log line", /Команды reset больше нет/.test(r) && sha(file) === hashBeforeGone && st().name === "cross-kimi" && editLines().length === 1, r)
r = await profs("reset all")
cell("reset of /crew-profiles is gone the same way", /Команды reset больше нет/.test(r) && sha(file) === hashBeforeGone, r)
r = await sets("save")
cell("save is gone: nothing to save, the file is untouched", /Команды save больше нет/.test(r) && /сохранять и сбрасывать нечего/.test(r) && sha(file) === hashBeforeGone, r)
// a person takes the name out of the file by hand: the set is not applied (row 1), as before
writeFileJson({ ...readFileJson(), profile_set: undefined })
bump()
cell("the name taken out of the file by hand: no set enabled", st().name === undefined && st().state.row === 1, String(st().name))
cell("AC-07 no turn of the model: every answer is a service message", prompts.length === 0 && replies.length > 0, String(prompts.length))

// ---- AC-09: the text about a smaller window ----
r = await sets("use kimi-only")
cell("AC-09 use names the smaller window and the new threshold; the tabs above it are compacted on their next turn", /Контекст уменьшен/.test(r) && /порог сжатия 242144 → 200K/.test(r) && /сожмутся на следующем ходе/.test(r) && /контекст 262144 · вывод до 131072 → контекст 220K · вывод до 131072/.test(r), r)
cell("AC-22 use kimi-only passes without the refusal of equal windows: one model, one window in the answer", !/Не сделано/.test(r) && (r.match(new RegExp(KIMI.replace(/[/-]/g, "\\$&") + ":", "g")) ?? []).length === 1, r)

// ---- AC-25: an explicit threshold of Claude Code is named and not touched ----
const explicitFile = path.join(root, ".opencode", "opencode-claude-code-provider.json")
mkdirSync(path.dirname(explicitFile), { recursive: true })
writeFileSync(explicitFile, JSON.stringify({ autoCompactWindow: { opus: 500000 } }))
const explicitHash = sha(explicitFile)
r = await sets("use cross-codex")
const chk = await sets("check")
cell("AC-25 use names the model, the explicit value and the window of OpenCode; the threshold stays explicit", /порог Claude Code для модели claude-code\/opus задан явно \(500000/.test(r) && /от набора не меняется; контекст OpenCode станет 720K/.test(r), r)
cell("AC-25 check says it too, the explicit file is byte for byte the same", /порог Claude Code для модели claude-code\/opus задан явно \(500000/.test(chk) && sha(explicitFile) === explicitHash, chk)
rmSync(explicitFile)

// ---- AC-26: one model through two profiles with different windows ----
{
  const f = readFileJson()
  f.model_profiles.kimi.heavy.context = 150000
  writeFileJson(f)
  commit("kimi heavy 150000")
  await sets("use default")
  r = await sets("use kimi-only")
  cell("AC-26 use refuses naming the model, the profiles and the windows", /Не сделано/.test(r) && r.includes(KIMI) && /kimi\/heavy — контекст 150K/.test(r) && /kimi\/medium — контекст 220K/.test(r), r)
  cell("AC-26 and the state stays on the previous set", st().name === "default", String(st().name))
  f.model_profiles.kimi.heavy.context = 220000
  writeFileJson(f)
  commit("kimi heavy back")
  r = await sets("use kimi-only")
  cell("AC-26 with equal windows the set is enabled", !/Не сделано/.test(r) && st().name === "kimi-only", r)
  await sets("use default")
}

// ---- task 015: the legacy accept is read and replaced, the new stages are accepted and shown with inheritance ----
{
  const raw = readFileJson()
  raw.profile_sets.legacy = { develop: c("claude", "heavy"), accept: c("kimi", "heavy"), plan: c("claude", "heavy") }
  writeFileJson(raw)
  const rLegacy = await sets("show legacy")
  cell("015 a set with the legacy accept: it is read as develop_accept and the delivery inherits one tier lower", /приёмка: kimi\/heavy → /.test(rLegacy) && /сдача: claude\/medium \(унаследован от «разработка», ступенью ниже\)/.test(rLegacy) && /разбор: claude\/heavy \(унаследован от «планирование»\)/.test(rLegacy), rLegacy)
  const rSet = await sets("set legacy develop_accept codex/heavy")
  cell("015 set with the new name replaces the legacy accept of the set", /Готово/.test(rSet) && st().data.sets.legacy.develop_accept?.family === "codex" && !("accept" in st().data.sets.legacy), JSON.stringify(st().data.sets.legacy))
  const rNew = await sets("set legacy сдача kimi/light")
  cell("015 the Russian word of a new stage works: delivery is explicit now", /Готово/.test(rNew) && st().data.sets.legacy.delivery?.family === "kimi", rNew + JSON.stringify(st().data.sets.legacy))
  const rBad = await sets("set legacy coordination kimi/light")
  cell("015 an unknown stage is refused and the message lists the eight", /не годится/.test(rBad) && /delivery_accept/.test(rBad), rBad)
  cell("015 show: a cross set is not noted for the family rule", !/заметка/.test(await sets("show cross-kimi")), "noted")
  raw.profile_sets.same = { develop: c("claude", "heavy"), develop_accept: c("claude", "heavy") }
  delete raw.profile_sets.legacy
  writeFileJson(raw)
  const rSameNote = await sets("show same")
  cell("015 show: the same family for the author and the check is noted while another family exists", /заметка: «приёмка» идёт на той же семье claude/.test(rSameNote), rSameNote)
  delete raw.profile_sets.same
  writeFileJson(raw)
}
// ---- task 016: tier bounds are an ordinary committed setting: shown and clamp; min above max is a problem and is not applied ----
{
  const raw = readFileJson()
  raw.tier_max = "medium"
  writeFileJson(raw)
  git(cfgDir, "add", "-A")
  git(cfgDir, "commit", "-q", "-m", "tier bounds")
  writeSettings(cfgDir, {})
  const rClamp = await sets("show cross-codex")
  cell("016 show: an explicit heavy cell is shown with the clamp to the bound", /планирование: claude\/heavy → claude-code\/sonnet — срез границами ступеней: heavy → medium/.test(rClamp), rClamp)
  // review 1 item 4: a `task` cell inherited one tier lower (delivery) is shown the way the choice makes it: lower first, then the cut
  const rDef = await sets("show default")
  const deliveryLine = rDef.split("\n").find((l) => /^ {2}сдача:/.test(l)) ?? ""
  cell("016 review-1 #4: show of the delivery cell inherited from a task cell (one tier lower, tier_max medium): heavy -> sonnet with no cut, medium -> haiku", /heavy → claude-code\/sonnet, medium → claude-code\/haiku, light → claude-code\/haiku/.test(deliveryLine) && !/срез/.test(deliveryLine), deliveryLine)
  cell("016 review-1 #9: show of a task cell lists the windows of the reachable tiers only (heavy is cut away by tier_max medium)", !/\(heavy\)/.test(rDef) && /\(medium\)/.test(rDef), rDef)
  // review 1 item 9: the reviewer windows of use: only the two stages the plugin starts, and the cut tier
  const prevName = raw.profile_set
  raw.profile_sets.bx = { develop: c("claude", "heavy"), develop_accept: c("claude", "heavy"), plan: c("claude", "heavy"), plan_accept: c("claude", "heavy"), spec_accept: c("codex", "heavy"), delivery_accept: c("kimi", "light") }
  writeFileJson(raw)
  const rUseBx = await sets("use bx")
  const revLines = rUseBx.split("\n").filter((l) => l.startsWith("Приёмка и приёмка плана:"))
  cell("016 review-1 #9: use lists the reviewer window of the cut model only (sonnet), not spec_accept / delivery_accept and not the cut heavy", revLines.length === 1 && /claude-code\/sonnet/.test(revLines[0]) && !/opus|gpt-5\.5|k3-256k/.test(revLines.join()), revLines.join("|"))
  const raw2 = readFileJson()
  delete raw2.profile_sets.bx
  if (prevName === undefined) delete raw2.profile_set
  else raw2.profile_set = prevName
  writeFileJson(raw2)
  raw.tier_min = "heavy"
  writeFileJson(raw)
  git(cfgDir, "add", "-A")
  git(cfgDir, "commit", "-q", "-m", "tier bounds")
  writeSettings(cfgDir, {})
  const rBadB = L.problemsOf(st())
  const rNoClamp = await sets("show cross-codex")
  cell("016 min above max is a problem line and the bounds are not applied", rBadB.some((x) => /tier_min \(heavy\) выше tier_max \(medium\)/.test(x)) && /планирование: claude\/heavy → claude-code\/opus/.test(rNoClamp) && !/срез границами/.test(rNoClamp), JSON.stringify(rBadB) + rNoClamp)
  delete raw.tier_min
  delete raw.tier_max
  writeFileJson(raw)
  git(cfgDir, "add", "-A")
  git(cfgDir, "commit", "-q", "-m", "tier bounds")
  writeSettings(cfgDir, {})
}

// ---- AC-27: edit verbs of /crew-sets ----
const before27 = editLines().length
const commits27 = commits()
r = await sets("new mine")
cell("AC-27 new <name>: an empty set at once, without a commit", /Готово/.test(r) && !!st().data.sets.mine && Object.keys(st().data.sets.mine).length === 0 && commits() === commits27, r)
r = await sets("set mine develop kimi/heavy")
r += await sets("set mine приёмка codex/task")
cell("AC-27 set <name> <stage> <family>/<tier>: the cell (also with the Russian stage word and tier task)", st().data.sets.mine.develop.family === "kimi" && st().data.sets.mine.develop_accept.tier === "task" && st().data.sets.mine.develop_accept.family === "codex", JSON.stringify(st().data.sets.mine))
r = await sets("unset mine приёмка")
cell("AC-27 unset removes the cell: the stage becomes `not described`", !st().data.sets.mine.develop_accept && !st().data.sets.mine.accept && /не описан|убран/.test(r), r)
r = await sets("new copy from mine")
cell("AC-27 new <name> from <other>: a copy", st().data.sets.copy.develop.family === "kimi", JSON.stringify(st().data.sets.copy))
r = await sets("rename copy copy2")
cell("AC-27 rename: the old name is gone, the new one holds the cells", !st().data.sets.copy && st().data.sets.copy2.develop.tier === "heavy", JSON.stringify(Object.keys(st().data.sets)))
r = await sets("delete copy2")
cell("AC-27 delete removes the set", !st().data.sets.copy2, JSON.stringify(Object.keys(st().data.sets)))
await sets("use mine")
cell("AC-27 the set `mine` is enabled in a state where it has only the develop stage", st().name === "mine" && st().state.row === 2, String(st().state.row))
r = await sets("delete mine")
cell("AC-27 delete of the enabled set is refused", /Не сделано/.test(r) && /включён/.test(r) && !!st().data.sets.mine, r)
r = await sets("rename mine mine2")
cell("AC-27 rename of the enabled set moves the name to the new one (profile_set of the file)", /Готово/.test(r) && st().name === "mine2" && readFileJson().profile_set === "mine2" && !st().data.sets.mine && !!st().data.sets.mine2, JSON.stringify([st().name, Object.keys(st().data.sets)]))
const fileBefore27 = sha(file)
r = await sets("set mine2 develop nofamily/heavy")
cell("AC-27/AC-28 an edit that breaks the enabled set (a dangling link) is refused whole; the file is byte for byte the same", /Не сделано/.test(r) && /nofamily/.test(r) && sha(file) === fileBefore27, r)
await sets("use default")
r = await sets("delete mine2")
cell("AC-27 once another set is enabled the set is deleted from the file at once", /Готово/.test(r) && !st().data.sets.mine2 && !readFileJson().profile_sets.mine2, r)
cell("AC-17 every successful edit verb left exactly one line, a refusal left a `refused` line", editLines().length - before27 === 11, String(editLines().length - before27))

// ---- AC-28: edit verbs of /crew-profiles ----
r = await profs("new fresh")
cell("AC-28 new <family>: three empty records, allowed in the data", /Готово/.test(r) && ["heavy", "medium", "light"].every((t) => P_empty(st().data.profiles.fresh[t])), JSON.stringify(st().data.profiles.fresh))
function P_empty(p) {
  return p && p.model === ""
}
await sets("new tmpset")
await sets("set tmpset develop fresh/heavy")
r = await sets("use tmpset")
cell("AC-28/AC-13 a set that references an empty record is not enabled; the profile is named", /Не сделано/.test(r) && /fresh\/heavy/.test(r) && /пуст/.test(r), r)
r = await sets("check")
cell("AC-29 check names the empty record that a set references and not the empty tiers nobody references", /профиль fresh\/heavy пуст/.test(r) && !/профиль fresh\/light пуст/.test(r) && !/профиль fresh\/medium пуст/.test(r), r)
r = await profs("set fresh all openai/gpt-x 100000 output=8000")
cell("AC-28 set <family> all: the three tiers at once", /Готово/.test(r) && ["heavy", "medium", "light"].every((t) => st().data.profiles.fresh[t].context === 100000 && st().data.profiles.fresh[t].output === 8000), r)
r = await profs("set fresh heavy openai/gpt-x 120000 output=8000 input=100000")
cell("AC-28 set <family> <tier> with input", st().data.profiles.fresh.heavy.input === 100000 && st().data.profiles.fresh.heavy.context === 120000, JSON.stringify(st().data.profiles.fresh.heavy))
r = await profs("set fresh heavy openai/gpt-x 120000")
cell("AC-28 a profile without output is refused with the reason", /Не сделано/.test(r) && /output/.test(r), r)
r = await profs("new k2 from kimi")
await sets("set tmpset develop k2/medium")
r = await profs("rename k2 k3x")
cell("AC-28 rename changes the references in all sets at once", /ссылок в наборах обновлено: 1/.test(r) && st().data.sets.tmpset.develop.family === "k3x" && !st().data.profiles.k2 && !!st().data.profiles.k3x, r)
r = await profs("delete k3x medium")
cell("AC-28 delete of a record that a set references is refused naming the set", /Не сделано/.test(r) && /tmpset/.test(r) && !!st().data.profiles.k3x.medium, r)
r = await profs("delete kimi")
cell("AC-28 delete of a family that sets reference is refused naming the sets", /Не сделано/.test(r) && /kimi-only/.test(r) && /cross-kimi/.test(r), r)
r = await profs("delete fresh light")
cell("AC-28 delete of a record nobody references passes", /Готово/.test(r) && !st().data.profiles.fresh.light, r)
// with kimi-only enabled: one tier alone is refused, all three at once pass
await sets("use kimi-only")
const lay1 = sha(file)
r = await profs(`set kimi heavy ${KIMI} 150000 output=131072`)
cell("AC-28/AC-37(а) with kimi-only enabled a window of one tier alone is refused whole (one model, two windows); the data is untouched", /Не сделано/.test(r) && /kimi\/heavy — контекст 150K/.test(r) && sha(file) === lay1, r)
r = await profs(`set kimi all ${KIMI} 150000 output=131072`)
cell("AC-28 the same window on all three tiers at once passes and is the active window at once (no use needed)", /Готово/.test(r) && st().state.row === 2 && L.profileState(root).data.profiles.kimi.light.context === 150000, r)
await sets("use default")
r = await profs(`set kimi heavy ${KIMI} 170000 output=131072`)
cell("AC-28 with kimi-only not enabled the same single-tier command passes (the conflict is checked at use)", /Готово/.test(r), r)
r = await sets("use kimi-only")
cell("AC-26/AC-28 and use of that set then refuses with the windows", /Не сделано/.test(r) && /kimi\/heavy — контекст 170K/.test(r), r)

// ---- an invalid edit or a broken file changes nothing ----
{
  const keepF = readFileSync(file, "utf8")
  writeFileSync(file, "{ broken")
  r = await sets("new zzz")
  cell("a working file that is not JSON: the command is refused whole, the file is not overwritten", /Не сделано/.test(r) && /не JSON/.test(r) && readFileSync(file, "utf8") === "{ broken", r)
  writeFileSync(file, keepF)
  bump()
}
const hashNoOutput = sha(file)
r = await profs("set kimi heavy " + KIMI + " 99999")
cell("an edit with a missing output is refused whole: the file is the same", /Не сделано/.test(r) && sha(file) === hashNoOutput, r)

// ---- AC-29: check; an old layer file ----
const commitsA = commits()
await profs("set kimi all " + KIMI + " 220000 output=131072") // the windows of kimi are equal again: use of the sets with kimi passes
await sets("use cross-kimi")
await profs(`set claude heavy claude-code/opus 650000 output=64000`)
await sets("new saved")
await sets("set saved develop claude/heavy")
{
  const wc = readFileJson()
  cell("AC-29 the edits are in the working copy at once: the name, the profile, the new set; git log did not grow, the file is modified", wc.profile_set === "cross-kimi" && wc.model_profiles.claude.heavy.context === 650000 && !!wc.profile_sets.saved && commits() === commitsA && git(cfgDir, "status", "--porcelain").includes("crew-harness.json"), JSON.stringify(Object.keys(wc)))
}
const fileBeforeCheck = sha(file)
catalogFails = false
catalog = catalog.filter((m) => m.modelID !== "k3-256k")
mkdirSync(path.join(root, ".opencode"), { recursive: true })
const handRoot = path.join(root, ".opencode", "opencode.jsonc")
writeFileSync(handRoot, `{ "provider": { "claude-code": { "models": { "opus": { "limit": { "context": 520000, "output": 64000 } } } } } }\n`)
r = await sets("check")
cell("AC-29 check: the model of the set that is not in the catalog of OpenCode is named", /модели kimi-code-plan-global\/k3-256k нет в каталоге OpenCode/.test(r), r)
cell("AC-29 check: the hand-written window of the same model in the main folder is named with the file and the value", /в основной папке проекта у модели claude-code\/opus контекст 520K/.test(r), r)
cell("AC-29 check: no talk of local records, layer or save (there is no layer)", !/Локальные правки|локальн|save/.test(r), r)
cell("AC-29 check: the window line of the reviewers (the profile window is not applied)", /Приёмка и приёмка плана: контекст профиля здесь не применяется/.test(r), r)
cell("AC-29 check changes nothing: the file is byte for byte the same", sha(file) === fileBeforeCheck, "changed")
{
  // an old layer file: not applied, named by check, not deleted
  const lf = L.layerFile("cmdproj")
  mkdirSync(path.dirname(lf), { recursive: true })
  writeFileSync(lf, JSON.stringify({ name: { value: "kimi-only", base: null } }))
  const nameBefore = st().name
  r = await sets("check")
  cell("an old *.layer.json is not applied (the name is that of the file) and check names it: disabled, can be deleted", st().name === nameBefore && /слой отключён/.test(r) && /не применяются/.test(r) && /можно удалить/.test(r) && existsSync(lf), r)
  rmSync(lf, { force: true })
}
catalogFails = true
r = await sets("check")
cell("AC-29 check: the catalog is down -> `not checked`, the work does not depend on it", /не проверено \(каталог недоступен\)/.test(r), r)
catalogFails = false
{
  const f = readFileJson()
  f.spawn_models = { heavy: "claude-code/opus", medium: "other/mid", light: "claude-code/haiku" }
  writeFileJson(f)
  commit("spawn_models differs")
  r = await sets("check")
  cell("AC-38/AC-29 check warns when a claude profile is not equal to spawn_models of the same tier", /модель профиля claude\/medium \(claude-code\/sonnet\) не равна spawn_models\.medium \(other\/mid\)/.test(r), r)
  delete f.spawn_models
  writeFileJson(f)
  commit("spawn_models back")
}
rmSync(handRoot)
commit("committed by the owner")
cell("after the owner's commit the state is the same (nothing in between)", st().data.profiles.claude.heavy.context === 650000 && st().name === "cross-kimi", String(st().name))
const linesBeforeGone = editLines().length
await sets("save force")
cell("save force is gone too: no log line", editLines().length === linesBeforeGone, "line")

{
  // task 010: the menu item "off" removes profile_set (the working copy of the file); the sets stay
  const prevName = st().name
  if (!prevName) await sets("use cross-kimi")
  const linesBefore = editLines().length
  r = await sets("off")
  cell("task 010 off: the enabled set is switched off, profile_set is gone from the file, sets and table stay, one log line", /Набор «[a-z-]+» выключен/.test(r) && readFileJson().profile_set === undefined && st().name === undefined && !!readFileJson().profile_sets && editLines().length === linesBefore + 1, r)
  r = await sets("off")
  cell("task 010 off with nothing enabled: says so, no change, no log line", /и так не включён/.test(r) && editLines().length === linesBefore + 1, r)
  r = await sets("off now")
  cell("task 010 off takes no arguments", /off без аргументов/.test(r), r)
  cell("task 010 the menu verbs of /crew-sets name off", /off/.test((await sets("frobnicate"))), "no off")
  if (prevName) await sets(`use ${prevName}`)
}
// ---- grammar ----
r = await sets("frobnicate")
cell("an unknown verb: the list of the verbs, the data is untouched", /Неизвестный глагол «frobnicate»/.test(r) && /Глаголы \/crew-sets/.test(r), r)
r = await sets("use a b")
cell("an extra argument: the list of the verbs", r.includes("use принимает ровно одно имя"), r)
r = await profs("use default")
cell("use is not a verb of /crew-profiles", /Неизвестный глагол «use»/.test(r), r)
r = await profs("reset")
cell("reset of /crew-profiles without an argument: the plain answer that the command is gone", /Команды reset больше нет/.test(r), r)

// ---- the answers speak in words, not codes of the requirements ----
const codes = allReplies.filter((t) => /\b(REQ|AC|DNC)-\d+/.test(t))
cell("the answers to the owner have no bare codes of the requirements", codes.length === 0, codes.slice(0, 2).join("|"))
cell("no answer is a turn of the model: the host got no prompt", prompts.length === 0, String(prompts.length))

stop?.()
rmSync(tmp, { recursive: true, force: true })
console.log(fail ? `crew-profiles-cmd.test: FAIL ${fail}` : "crew-profiles-cmd.test ok")
process.exit(fail ? 1 : 0)
