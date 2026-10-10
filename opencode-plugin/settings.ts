// ПРОЕКТЫ И ИХ НАСТРОЙКИ (план 002, решение №12, 2026-10-05).
//
// Проект бывает виртуальным: C:/work/nova — папка с многими репозиториями, сама не репозиторий. Поэтому
// настройки проекта живут в РЕПОЗИТОРИИ НАСТРОЕК, а не в рабочей папке вкладки:
//   opencode.jsonc:  "options": { "projects": ["C:/work/nova/nova-settings", "C:/work/tools"] }
//   <папка>/.opencode/crew-harness.json:  { "project": "nova", "root": "..", ... }
// Папка — любая внутри git-репозитория. Имя проекта — поле "project" (нет — имя папки); корень — "root" от папки
// (нет — сама папка). Файл читается ЗАКОММИЧЕННЫМ из ветки по умолчанию (`git show <ветка>:<путь>`; другая ветка —
// поле "branch"): незакоммиченная правка не действует, worktree и ветки кода на настройки не влияют.
//
// Прежняя форма опций `{ "nova": "C:/work/nova" }` читается дальше: имя → корень, а настройки — по-старому
// из `.opencode/crew-harness.json` вверх от каталога вкладки (рабочая копия). Старое имя nova-peers.json больше не
// читается (решение №16 плана 002 выполнено: nv-lang перешёл на репозиторий настроек 2026-10-05).
//
// Машинно-зависимое (модели по ступеням) — необязательная поправка в опциях плагина:
//   "options": { "projects": [...], "local": { "nova": { "spawn_models": { "light": "kimi/k3" } } } }

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { log, safeKey } from "./core.ts"
import { answerNotes } from "./answer-parse.ts"
import { BASE } from "./paths.ts"

export const SETTINGS_FILE = path.join(".opencode", "crew-harness.json")
/** прежнее имя файла настроек (до плана 005, 2026-10-06) */
export const LEGACY_SETTINGS_NAME = ".opencode/opencode-peers.json"
export const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
// Канонический путь: короткие имена Windows (8.3, `ABCD~1`) раскрываются, чтобы корень проекта и каталог вкладки
// совпадали, в каком бы виде путь ни пришёл; у несуществующего пути — его ближайший существующий предок.
export const canon = (p: string): string => {
  const abs = path.resolve(p)
  try {
    return realpathSync.native(abs)
  } catch {
    const up = path.dirname(abs)
    return up === abs ? abs : path.join(canon(up), path.basename(abs))
  }
}
export const normPath = (p: string) => canon(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

/** Проект: имя, корень (нормализованный), откуда настройки. */
export type Project = {
  name: string
  /** корень, нормализованный для сравнения (канонический, нижний регистр) */
  root: string
  /** корень как путь (канонический, регистр сохранён) */
  rootPath?: string
  /** папка настроек (новая форма опций); нет — прежняя форма */
  dir?: string
  /** вершина репозитория настроек и путь файла в нём */
  repo?: string
  file?: string
  branch?: string
  /** что не так с этим проектом (для crew_doctor) */
  problems?: string[]
  /** настройки прочитаны из файла с прежним именем — переименовать */
  legacy?: string
}
export type Projects = Project[]

const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 })

function defaultBranch(repo: string): string {
  try {
    const head = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim() // origin/main
    if (head) return head.replace(/^[^/]+\//, "")
  } catch {}
  for (const b of ["main", "master"])
    try {
      git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])
      return b
    } catch {}
  return "main"
}

/** Закоммиченный файл настроек: текст из ветки или undefined. */
function showCommitted(repo: string, branch: string, file: string): string | undefined {
  try {
    return git(repo, ["show", `${branch}:${file}`])
  } catch {
    return undefined
  }
}

const parseJson = (text: string | undefined): any => {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch {
    return null // файл есть, но не JSON
  }
}

// Прочитанные файлы настроек — на несколько секунд (инструменты зовут настройки на каждое письмо, git — процесс).
const CACHE_MS = Number(process.env.CREW_HARNESS_SETTINGS_TTL_MS) || 5_000
const cache = new Map<string, { at: number; value: any }>()
const good = new Map<string, any>() // последние настройки без проблем, по папке

/** Папка настроек → проект (имя, корень, сырые настройки). */
export function readSettingsFolder(folder: string, now = Date.now()): { project: Project; raw: any } {
  const dir = path.resolve(folder)
  const hit = cache.get(dir)
  if (hit && now - hit.at < CACHE_MS) return hit.value
  const problems: string[] = []
  let repo: string | undefined
  let file: string | undefined
  let branch: string | undefined
  let legacy: string | undefined
  let raw: any = {}
  try {
    repo = git(dir, ["rev-parse", "--show-toplevel"]).trim()
  } catch {
    problems.push(`папка настроек ${dir} не внутри git-репозитория`)
  }
  if (repo) {
    const prefix = git(dir, ["rev-parse", "--show-prefix"]).trim()
    file = prefix + ".opencode/crew-harness.json" // путь в репозитории
    branch = defaultBranch(repo)
    let j = parseJson(showCommitted(repo, branch, file))
    // прежнее имя файла (до плана 005): читается, crew_doctor просит переименовать
    if (j === undefined) {
      const oldFile = prefix + LEGACY_SETTINGS_NAME
      const o = parseJson(showCommitted(repo, branch, oldFile))
      if (o !== undefined) {
        j = o
        file = oldFile
        legacy = oldFile
      }
    }
    if (j && typeof j.branch === "string" && j.branch && j.branch !== branch) {
      branch = j.branch
      j = parseJson(showCommitted(repo, branch, file))
    }
    if (j === undefined) {
      // файл в рабочей копии есть, а в ветке нет — его просто не закоммитили (claude-limits, 2026-10-07: приёмка
      // проекта сутки не действовала, а самопроверка говорила только «нет файла»)
      const local = [prefix + ".opencode/crew-harness.json", prefix + LEGACY_SETTINGS_NAME].find((f) => existsSync(path.join(repo!, f)))
      problems.push(
        local
          ? `${local} лежит в рабочей копии ${repo}, но не закоммичен в ${branch} — плагин его не читает, настройки по умолчанию; закоммить его в ${branch}${local.endsWith(LEGACY_SETTINGS_NAME) ? ` под именем .opencode/crew-harness.json` : ""}`
          : `в ветке ${branch} репозитория ${repo} нет ${file} — настройки по умолчанию`,
      )
    }
    else if (j === null) problems.push(`${file} в ветке ${branch} — не JSON; настройки по умолчанию`)
    else raw = j
  }
  const name = String(raw.project ?? path.basename(dir)).toLowerCase()
  if (!PROJECT_RE.test(name)) problems.push(`имя проекта «${name}» не годится: строчные латинские буквы, цифры, дефис`)
  const rootAbs = path.resolve(dir, typeof raw.root === "string" && raw.root ? raw.root : ".")
  if (!existsSync(rootAbs)) problems.push(`корень проекта ${name} (${rootAbs}) не существует`)
  let value = { project: { name, root: normPath(rootAbs), rootPath: canon(rootAbs), dir, repo, file, branch, problems, ...(legacy ? { legacy } : {}) }, raw }
  // ПОСЛЕДНИЕ ХОРОШИЕ НАСТРОЙКИ (2026-10-05): под нагрузкой git не ответил — и плагин молча взял умолчания: задача #6
  // nova пошла без worktree и ветки по настройкам, а приёмка решила «очистка не нужна» — ветки и worktree остались.
  // Чтение с проблемой при прежнем чтении без проблем — сбой, а не правка: берём последние хорошие (память, затем
  // диск — для MCP-процессов, они живут один ход) и пишем о сбое в журнал. Чтение без проблем их обновляет.
  const goodFile = path.join(BASE, "settings-good", `${safeKey(dir)}.json`)
  if (!problems.length) {
    good.set(dir, value)
    try {
      mkdirSync(path.dirname(goodFile), { recursive: true })
      writeFileSync(`${goodFile}.tmp`, JSON.stringify(value))
      renameSync(`${goodFile}.tmp`, goodFile)
    } catch {}
  } else {
    let last = good.get(dir)
    if (!last)
      try {
        last = JSON.parse(readFileSync(goodFile, "utf8"))
      } catch {}
    if (last && !last.project?.problems?.length) {
      log(`settings of ${dir}: ${problems.join("; ")} -- using the last good ones`)
      value = last
    }
  }
  cache.set(dir, { at: now, value })
  return value
}

/** Опции плагина → проекты. Новая форма — массив папок настроек; прежняя — объект имя → корень. */
export function parseProjects(opt: any, log: (s: string) => void = () => {}): Projects {
  const out: Projects = []
  const list = opt?.projects
  if (Array.isArray(list)) {
    for (const folder of list) {
      if (typeof folder !== "string" || !folder) continue
      out.push(readSettingsFolder(folder).project)
    }
  } else
    for (const [name, root] of Object.entries(list ?? {})) {
      const n = String(name).toLowerCase()
      if (!PROJECT_RE.test(n) || typeof root !== "string" || !root) {
        log(`project ignored: ${name} -> ${root}`)
        continue
      }
      out.push({ name: n, root: normPath(root), rootPath: canon(root) })
    }
  // проверки, которые видны только по всему списку
  const byName = new Map<string, Project[]>()
  for (const p of out) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
  for (const [n, ps] of byName) if (ps.length > 1) for (const p of ps) (p.problems ??= []).push(`два проекта с именем «${n}»: ${ps.map((x) => x.dir ?? x.root).join(", ")}`)
  return out.sort((a, b) => b.root.length - a.root.length)
}

/** Проект каталога: самый длинный подходящий корень. */
export function projectFor(dir: string, projects: Projects): Project | undefined {
  if (!dir) return undefined
  const d = normPath(dir)
  return projects.find((p) => d === p.root || d.startsWith(p.root + "/"))
}

/** Сырые настройки проекта: файл из репозитория настроек (+ локальная поправка) или прежний поиск вверх от каталога. */
export function rawSettingsFor(dir: string, projects: Projects, local: Record<string, any> = {}): any {
  const p = projectFor(dir, projects)
  let raw: any
  if (p?.dir) raw = readSettingsFolder(p.dir).raw
  else raw = legacyWalk(dir)
  const over = p ? local[p.name] : undefined
  return over && typeof over === "object" ? { ...raw, ...over } : raw
}

// Прежняя форма: `.opencode/crew-harness.json` вверх от каталога вкладки, рабочая копия.
// Битый файл (не JSON) молча давал пустые настройки, и защитные ключи (merge_precheck: required и др.) выключались без
// сообщения (задача 006): теперь берутся последние хорошие настройки этого файла, а о файле пишется в журнал и в crew_doctor.
const legacyGood = new Map<string, any>()
const legacyBroken = new Map<string, string>() // файл → когда замечен битым
function legacyFile(dir: string): string | undefined {
  let d = dir ? path.resolve(dir) : ""
  for (let i = 0; d && i < 32; i++) {
    const f = path.join(d, SETTINGS_FILE)
    if (existsSync(f)) return f
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  return undefined
}
function legacyWalk(dir: string): any {
  const f = legacyFile(dir)
  if (!f) return {}
  try {
    const raw = JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, ""))
    legacyGood.set(f, raw)
    legacyBroken.delete(f)
    return raw
  } catch {
    const last = legacyGood.get(f)
    if (!legacyBroken.has(f)) log(`settings file ${f} is not valid JSON -- ${last ? "using the last good settings" : "defaults"}`)
    legacyBroken.set(f, new Date().toISOString())
    return last ?? {}
  }
}
/** Битые файлы настроек прежней формы (проекты без репозитория настроек): проверка на месте, для crew_doctor. */
function legacyProblems(projects: Projects): string[] {
  const out: string[] = []
  for (const p of projects) {
    if (p.dir) continue
    const f = legacyFile(p.rootPath ?? p.root)
    if (!f) continue
    try {
      JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, ""))
    } catch {
      out.push(`проект ${p.name}: ${f} — не JSON; ${legacyGood.has(f) ? "действуют последние хорошие настройки" : "настройки по умолчанию, защитные ключи (merge_precheck и др.) не заданы"}; исправь файл`)
    }
  }
  return out
}

/** Файл настроек в рабочей копии папки настроек (то, что правит crew_config set; действует после коммита). */
export function workingSettings(folder: string): { file: string; raw: any } {
  const file = path.join(path.resolve(folder), SETTINGS_FILE)
  let raw: any = {}
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
  } catch {}
  return { file, raw: raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {} }
}

/** Записать ключи в рабочую копию (null — удалить ключ); остальное в файле не трогается. Без BOM, атомарно. */
export function writeSettings(folder: string, values: Record<string, any>): string {
  const { file, raw } = workingSettings(folder)
  for (const [k, v] of Object.entries(values)) {
    if (v === null) delete raw[k]
    else raw[k] = v
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n")
  renameSync(tmp, file)
  cache.delete(path.resolve(folder))
  return file
}

/** Проблемы настроек всех проектов (crew_doctor). Вложенные корни — не проблема: вложенный проект побеждает. */
/** Текст шага приёмки пересказывает порядок приёмки: «под замком» рядом с CI/land/посадка/гейт или «замок вливания» рядом с CI. */
const describesAcceptanceOrder = (text: unknown) => {
  const t = typeof text === "string" ? text : ""
  return /под замком[^.]{0,80}(ci|land|посадк|гейт)|(ci|land|посадк|гейт)[^.]{0,80}под замком|замок вливания[^.]{0,80}ci|ci[^.]{0,80}замок вливания/i.test(t)
}

export function settingsProblems(projects: Projects): string[] {
  const out = projects.flatMap((p) => p.problems ?? [])
  for (const p of projects) if (p.legacy) out.push(`проект ${p.name}: настройки в файле с прежним именем ${p.legacy} — переименуй в .opencode/crew-harness.json (git mv) и закоммить`)
  // настройка, которая не может сработать: ключ gate в answer_mode, режим agent, неверный answer_max (задача 007)
  for (const p of projects) {
    if (!p.dir) continue
    const raw = readSettingsFolder(p.dir).raw
    for (const n of answerNotes(raw?.answer_mode, raw?.answer_max)) out.push(`проект ${p.name}: ${n}`)
    // порядок приёмки задаёт плагин (merge_precheck); текст шага, пересказывающий старый порядок, устареет — только предупреждение
    if (raw?.merge_precheck !== "off" && Array.isArray(raw?.acceptance))
      for (const a of raw.acceptance) if (a && typeof a.id === "string" && describesAcceptanceOrder(a.text)) out.push(`проект ${p.name}: шаг ${a.id} описывает порядок приёмки, он задаётся плагином (crew_help, ПРИЁМКА): оставь в шаге только проектные команды и критерии`)
  }
  out.push(...legacyProblems(projects))
  const old = projects.filter((p) => !p.dir).map((p) => p.name)
  if (old.length) out.push(`проекты ${old.join(", ")} заданы прежней формой опций (имя → корень); новая — список папок настроек: "projects": ["<папка с .opencode/crew-harness.json>"], файл называет проект и root (doc/archive/plans/002-tasks.md, «Где живут настройки проекта»)`)
  return [...new Set(out)]
}
