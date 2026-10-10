// Self-test of the profile keys in crew_config and crew_doctor (task 003; node >= 24):  node test/crew-profiles-config.test.mjs
// The three keys are checked by crew_config set (forms, links between keys on the working copy plus the new values),
// profile_set is refused always (a person sets the name), guide / show describe them, crew_doctor names the problems.
// A real git repository of settings. A state read costs several git processes, so the settings cache is long and is
// dropped by hand after a commit.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = mkdtempSync(path.join(os.tmpdir(), "crew-profiles-config-"))
process.env.XDG_DATA_HOME = path.join(tmp, "data")
process.env.CREW_HARNESS_POLL_MS = "100"
process.env.CREW_HARNESS_DB = path.join(tmp, "absent.db")
process.env.CREW_HARNESS_SETTINGS_TTL_MS = "600000"
process.env.CREW_HARNESS_PRESENCE = "all"
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
const root = path.join(tmp, "proj")
const cfgDir = path.join(root, "proj-settings")
const work = path.join(root, "repo")
mkdirSync(path.join(cfgDir, ".opencode"), { recursive: true })
mkdirSync(work, { recursive: true })
const file = path.join(cfgDir, ".opencode", "crew-harness.json")
git(cfgDir, "init", "-q", "-b", "main")
writeFileSync(file, JSON.stringify({ project: "proj", root: "..", cleanup: "local" }, null, 2))
git(cfgDir, "add", "-A")
git(cfgDir, "commit", "-q", "-m", "settings")

const prof = (model, context, output, input) => ({ model, context, output, ...(input ? { input } : {}) })
const c = (family, tier) => ({ family, tier })
// the example of the README (task 003): three families, nine records, four sets, no profile_set
const TABLE = {
  claude: { heavy: prof("claude-code/opus", 720000, 64000), medium: prof("claude-code/sonnet", 720000, 64000), light: prof("claude-code/haiku", 220000, 32000) },
  kimi: { heavy: prof("kimi-code-plan-global/k3-256k", 220000, 131072), medium: prof("kimi-code-plan-global/k3-256k", 220000, 131072), light: prof("kimi-code-plan-global/k3-256k", 220000, 131072) },
  codex: { heavy: prof("openai/gpt-5.5", 525000, 128000, 461000), medium: prof("openai/gpt-5.6-terra", 525000, 128000, 461000), light: prof("openai/gpt-6-luna", 525000, 128000, 461000) },
}
const SETS = {
  default: { develop: c("claude", "task"), plan: c("claude", "task"), accept: c("claude", "task"), plan_accept: c("claude", "task") },
  "cross-kimi": { develop: c("claude", "task"), plan: c("claude", "task"), accept: c("kimi", "heavy"), plan_accept: c("kimi", "heavy") },
  "cross-codex": { develop: c("claude", "medium"), plan: c("claude", "heavy"), accept: c("codex", "heavy"), plan_accept: c("codex", "heavy") },
  "kimi-only": { develop: c("kimi", "heavy"), plan: c("kimi", "heavy"), accept: c("kimi", "heavy"), plan_accept: c("kimi", "heavy") },
}

const mod = await import("../index.ts")
const core = await import("../core.ts")
const { writeSettings } = await import("../settings.ts")
const hooks = {}
const tools = {}
const ctx = {
  location: { directory: work },
  options: { projects: [cfgDir] },
  session: {
    get: async ({ sessionID }) => ({ id: sessionID, title: sessionID, location: { directory: work }, time: {} }),
    prompt: async () => {},
    hook: async (name, cb) => (hooks[name] = cb),
  },
  tool: { transform: async (fn) => fn({ add: (t) => (tools[t.name] = t) }) },
}
const stop = await mod.default.setup(ctx)
let fail = 0
const cell = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " :: " + detail}`)
  if (!ok) fail++
}
const call = async (sid, input) => (await tools.crew_config.execute(input, { sessionID: sid })).content
const doctor = async (sid) => (await tools.crew_doctor.execute({}, { sessionID: sid })).content
const set = (values) => call("sesINT", { action: "set", values })
const read = () => JSON.parse(readFileSync(file, "utf8"))
const commit = (msg) => {
  git(cfgDir, "add", "-A")
  git(cfgDir, "commit", "-q", "-m", msg)
  writeSettings(cfgDir, {}) // drops the settings cache of the folder (rewrites the same working file)
}
for (const s of ["sesINT", "sesWRK"]) await hooks.context({ sessionID: s, system: [], model: { id: "x", providerID: "y" } })
await tools.crew_role.execute({ role: "integrator" }, { sessionID: "sesINT" })

// AC-13: guide has the keys with the recommendation; profile_set is for a person
const guide = await call("sesWRK", { action: "guide" })
cell("AC-13 guide covers the three new keys", ["model_profiles", "profile_sets", "profile_set"].every((k) => guide.includes(`- ${k}:`)), guide.split("\n").filter((l) => /profile/.test(l)).join("|").slice(0, 300))
cell("AC-13 guide says profile_set is set by a person and gives a recommendation to every new key", /- profile_set: .*Ставит человек.*вызовом set не записывать/.test(guide) && ["model_profiles", "profile_sets", "profile_set"].every((k) => new RegExp(`- ${k}: .*Рекомендация: .+Зачем:`).test(guide)), "no")

// AC-23: profile_set is refused always, with one reason
const before = readFileSync(file, "utf8")
const r1 = await set({ profile_set: "default" })
const r2 = await set({ profile_set: "nonexistent" })
const reasonOf = (t) => t.split("\n").filter((l) => l.startsWith("- ")).join("|")
cell("AC-23 profile_set is refused with one reason, an existing and a missing set alike", reasonOf(r1) === reasonOf(r2) && /имя набора меняет человек/.test(r1) && r1.split("\n").filter((l) => l.startsWith("- ")).length === 1, r1 + "||" + r2)
cell("AC-23 a refused set leaves the file as it was; other values in the same call are not written either", readFileSync(file, "utf8") === before && /имя набора меняет человек/.test(await set({ profile_set: "x", inflight_limit: 3 })) && readFileSync(file, "utf8") === before, "changed")
// the two journal tools (progress_line, usage_line) are not crew_* by design: they write a line of the task journal, nothing of the profiles
const JOURNAL_TOOLS = ["progress_line", "usage_line"]
cell("AC-23 no tool changes the profile name: no use / reset / save tool, every tool is crew_* except the two journal tools", !Object.keys(tools).some((n) => /(^|_)(use|reset|save)$/.test(n)) && Object.keys(tools).filter((n) => !JOURNAL_TOOLS.includes(n)).every((n) => n.startsWith("crew_")), Object.keys(tools).join())

// the README example is accepted by crew_config set: table first, then the sets, with no commit between
const t1 = await set({ model_profiles: TABLE })
cell("AC-23/AC-39 the table is written", /Записано/.test(t1) && read().model_profiles.codex.heavy.input === 461000, t1)
const t2 = await set({ profile_sets: SETS })
cell("AC-39 the sets are written right after the table without a commit (the working copy plus the new values)", /Записано/.test(t2) && Object.keys(read().profile_sets).length === 4 && !("profile_set" in read()), t2)
cell("AC-23 the example holds the two keys and no name", read().model_profiles && read().profile_sets && read().profile_set === undefined, "wrong")

// AC-12: forms, through the tool; the file is untouched after each refusal
const fileText = readFileSync(file, "utf8")
const badCases = [
  ["unknown tier of a record", { model_profiles: { claude: { ultra: TABLE.claude.heavy } } }, /ultra/],
  ["a family with a capital", { model_profiles: { Claude: TABLE.claude } }, /Claude/],
  ["family all", { model_profiles: { all: TABLE.claude } }, /all/],
  ["a model without a slash", { model_profiles: { claude: { heavy: { model: "opus", context: 1, output: 1 } } } }, /провайдер\/модель/],
  ["context zero", { model_profiles: { claude: { heavy: { ...TABLE.claude.heavy, context: 0 } } } }, /context/],
  ["output missing", { model_profiles: { claude: { heavy: { model: "a/b", context: 5 } } } }, /output/],
  ["input above context", { model_profiles: { claude: { heavy: { ...TABLE.claude.heavy, input: 999999999 } } } }, /input/],
  ["a set name with a capital", { profile_sets: { Cross: {} } }, /Cross/],
  ["a reserved set name", { profile_sets: { use: {} } }, /\buse\b/],
  ["an unknown stage", { profile_sets: { x: { coordination: c("claude", "heavy") } } }, /coordination/],
  ["a cell tier out of the list", { profile_sets: { x: { develop: c("claude", "huge") } } }, /tier/],
]
for (const [label, values, re] of badCases) {
  const r = await set(values)
  cell(`AC-12 red: ${label}`, /Не записано/.test(r) && re.test(r) && readFileSync(file, "utf8") === fileText, r.slice(0, 240))
}
cell("AC-12 green: a correct change in the same file is written after the refusals", /Записано/.test(await set({ inflight_limit: 4 })) && read().inflight_limit === 4, "not written")

// AC-39: links
const sets0 = readFileSync(file, "utf8")
const dangling = await set({ profile_sets: { ...SETS, ghost: { develop: c("nofamily", "heavy") } } })
cell("AC-39 a set with a family that is not in the table (same call or working copy) is refused naming the place", /Не записано/.test(dangling) && /ghost/.test(dangling) && /nofamily/.test(dangling) && readFileSync(file, "utf8") === sets0, dangling)
const noTier = await set({ model_profiles: { ...TABLE, claude: { heavy: TABLE.claude.heavy, medium: TABLE.claude.medium } } })
cell("AC-37(б′) removing a record that a set references is refused, the state (б) is not created", /Не записано/.test(noTier) && /claude/.test(noTier) && /ступени «light»/.test(noTier) && readFileSync(file, "utf8") === sets0, noTier)
cell("AC-37(б′) removing the whole table while sets stay is refused too", /Не записано/.test(await set({ model_profiles: null })) && readFileSync(file, "utf8") === sets0, "written")
const conflict = await set({ model_profiles: { ...TABLE, kimi: { heavy: { ...TABLE.kimi.heavy, context: 150000 }, medium: TABLE.kimi.medium, light: TABLE.kimi.light } } })
cell("AC-39 one model with different windows in a not enabled set is written (use refuses later)", /Записано/.test(conflict) && read().model_profiles.kimi.heavy.context === 150000, conflict)
cell("AC-39 removing the sets together with the table in one call is accepted (no dangling links remain)", /Записано/.test(await set({ model_profiles: null, profile_sets: null })) && read().model_profiles === undefined && read().profile_sets === undefined, "refused")
cell("AC-39 the table back, then the sets: two calls in a row", /Записано/.test(await set({ model_profiles: TABLE })) && /Записано/.test(await set({ profile_sets: SETS })), "refused")

// show and doctor
commit("profiles")
const show = await call("sesWRK", { action: "show" })
cell("task 010 show: the first line is the summary (sets in the file, none enabled), no JSON dumps, tables and the hint how to enable", show.split("\n")[0] === "Профили моделей — наборов в файле: 4: default, cross-kimi, cross-codex, kimi-only; включён: нет (наборы есть, но ни один не включён (модели новых сессий — по spawn_models))." && !/model_profiles = \{|profile_sets = \{/.test(show) && /model_profiles = .* — файл, ветка main/.test(show) && /profile_set = \(не включён\) — по умолчанию/.test(show) && /Справочник \(семья/.test(show) && /claude\s+heavy\s+claude-code\/opus/.test(show) && /cross-kimi: develop claude\/task/.test(show) && /\/crew-sets use <имя>/.test(show) && !/наборов нет/i.test(show), show.slice(0, 900))
{
  // "no sets" and "not enabled" are different words
  const saved = read().profile_sets
  await set({ profile_sets: null })
  commit("no sets")
  const none = await call("sesWRK", { action: "show" })
  cell("task 010 show: no sets in the file says so in other words than 'not enabled'", /наборов в файле: 0; включён: нет \(наборов в файле нет вообще\)/.test(none.split("\n")[0]) && !/ни один не включён/.test(none), none.slice(0, 300))
  await set({ profile_sets: saved })
  commit("sets back")
}
cell("crew_doctor: nothing to say while no set is enabled and the data is valid", !/профил|набор/i.test(await doctor("sesINT")), (await doctor("sesINT")).slice(0, 300))
// the name comes by a commit of a person (an agent cannot set it): a set missing from the data -> row 6 reported
const f = read()
f.profile_set = "ghost-set"
writeFileSync(file, JSON.stringify(f, null, 2))
commit("name of a missing set")
const d1 = await doctor("sesINT")
cell("AC-24/AC-37 crew_doctor names a missing set and what to do", /ghost-set/.test(d1) && /нет в данных проекта/.test(d1), d1.slice(0, 400))
// the name of a valid set, the table lost a record by a commit of a person (not through crew_config): the place is named
f.profile_set = "cross-kimi"
delete f.model_profiles.kimi
writeFileSync(file, JSON.stringify(f, null, 2))
commit("kimi removed")
const d2 = await doctor("sesINT")
cell("AC-37(б) crew_doctor names the place of a data break that came by a commit", /кими|kimi/.test(d2) && /недопустим/.test(d2), d2.slice(0, 500))
// task 016, review 1 items 5, 7, 11: the text of the guide, the bounds are checked against each other on a write
{
  const line = (k) => guide.split("\n").find((l) => l.startsWith(`- ${k}:`)) ?? ""
  cell("015 review-1 #5: the guide does not promise another family for a check without a cell: it goes by spawn_models, the family rule is a note", !/берёт другую семью/.test(line("profile_sets")) && /проверки без клетки идёт по spawn_models/.test(line("profile_sets")) && /accept читается как develop_accept/.test(line("profile_sets")), line("profile_sets"))
  cell("016 review-1 #11: the guide says tier of crew_send picks a tab, is not clamped; the bound applies to crew_spawn", /tier у crew_spawn/.test(line("tier_max")) && /crew_send/.test(line("tier_max")) && /не срезается/.test(line("tier_max")), line("tier_max"))
  const f0 = readFileSync(file, "utf8")
  const bad1 = await set({ tier_min: "heavy", tier_max: "light" })
  cell("016 review-1 #7: tier_min above tier_max in one call is refused and the file is untouched", /Не записано/.test(bad1) && /tier_min \(heavy\) выше tier_max \(light\)/.test(bad1) && readFileSync(file, "utf8") === f0, bad1)
  const ok1 = await set({ tier_max: "light" })
  cell("016 review-1 #7: one bound alone is written", /Записано/.test(ok1) && read().tier_max === "light", ok1)
  const f1 = readFileSync(file, "utf8")
  const bad2 = await set({ tier_min: "medium" })
  cell("016 review-1 #7: tier_min medium against the written tier_max light is refused (checked against the other key), file untouched", /Не записано/.test(bad2) && /выше tier_max/.test(bad2) && readFileSync(file, "utf8") === f1, bad2)
  const ok2 = await set({ tier_min: "light", tier_max: "medium" })
  cell("016 review-1 #7: a consistent pair is written", /Записано/.test(ok2) && read().tier_min === "light" && read().tier_max === "medium", ok2)
  const ok3 = await set({ tier_min: null, tier_max: null })
  cell("016 review-1 #7: removing both keys is allowed", /Записано/.test(ok3) && read().tier_min === undefined && read().tier_max === undefined, ok3)
}
// the data of a project without profiles: nothing about profiles
const g = read()
delete g.profile_set
delete g.model_profiles
delete g.profile_sets
writeFileSync(file, JSON.stringify(g, null, 2))
commit("no profiles")
cell("AC-24 a project without profiles is not touched: no word about profiles in the doctor or show", !/профил|набор/i.test(await doctor("sesINT")) && !/Профили моделей/.test(await call("sesWRK", { action: "show" })), (await doctor("sesINT")).slice(0, 300))

stop?.()
rmSync(tmp, { recursive: true, force: true })
console.log(fail ? `crew-profiles-config.test: FAIL ${fail}` : "crew-profiles-config.test ok")
process.exit(fail ? 1 : 0)
