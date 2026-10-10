// ДЕЙСТВУЮЩИЕ ДАННЫЕ ПРОФИЛЕЙ, СНИМОК И ПРАВКА ФАЙЛА ПРОЕКТА (задача 003, ADR-0008, заменён ADR-0014: слоя нет).
//
// Команды окна правят три ключа файла проекта (model_profiles, profile_sets, profile_set) в рабочей копии папки настроек СРАЗУ
// и атомарно, без коммита и без промежуточного слоя. Действующие данные = эти три ключа рабочей копии (нет файла в рабочей
// копии или папки настроек — три ключа закоммиченного файла). Снимок — последнее допустимое состояние трёх ключей
// (profiles/<проект>.snapshot.json), пишется проходом сервиса; читатели его только читают: работающие вкладки не падают,
// если невалидное состояние пришло не через команды (коммит убрал профиль).
// Файл прежнего слоя profiles/<проект>.layer.json не читается и не применяется; о нём один раз сообщается (legacyLayerNote).

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BASE } from "./paths.ts"
import { SETTINGS_FILE, projectFor, rawSettingsFor, workingSettings, writeSettings } from "./settings.ts"
import { limitsText, log, projectOf, settingsContext } from "./core.ts"
import * as P from "./profiles.ts"
import { type Task, listTasks } from "./tasks.ts"
import { type SyncReport, type WindowPlan, qualifying, syncTaskWindow, syncWindows, windowNotes, windowPlanOf, windowProblems } from "./profile-windows.ts"

const isObj = (v: any): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const canonical = (v: any): string => JSON.stringify(v ?? null, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))
export const same = (a: any, b: any): boolean => canonical(a) === canonical(b)

const dir = () => path.join(BASE, "profiles")
const keyOfProject = (project: string) => project.replace(/[^A-Za-z0-9_-]/g, "_")
/** Файл прежнего локального слоя: не читается, только называется в сообщении об отключении. */
export const layerFile = (project: string) => path.join(dir(), `${keyOfProject(project)}.layer.json`)
export const snapshotFile = (project: string) => path.join(dir(), `${keyOfProject(project)}.snapshot.json`)

function writeAtomic(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
function readJsonFile(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""))
  } catch {
    return undefined
  }
}

// ---- прежний слой: только сообщение ----------------------------------------------------------------------------------

const noted = new Set<string>()
/** Текст про найденный файл прежнего слоя (null — файла нет). */
export function legacyLayerText(project: string): string | null {
  const f = layerFile(project)
  return existsSync(f) ? `проект ${project}: найден файл прежнего локального слоя ${f.replace(/\\/g, "/")} — слой отключён, его записи не применяются; файл можно удалить` : null
}
/** То же, но один раз за жизнь процесса (проход службы); повтор — undefined. */
export function legacyLayerNote(project: string): string | undefined {
  if (noted.has(project)) return undefined
  const t = legacyLayerText(project)
  if (!t) return undefined
  noted.add(project)
  log(`profiles: ${t}`)
  return t
}
/** Для тестов: забыть, что о слое уже сообщалось. */
export const resetLegacyNotes = () => noted.clear()

// ---- правка трёх ключей файла проекта -------------------------------------------------------------------------------

export type Draft = { profiles?: Record<string, any>; sets?: Record<string, any>; name?: string }
/** Черновик правки: копия действующих данных. */
export const draftOf = (ps: PState): Draft => ({ profiles: clone(ps.data.profiles) as any, sets: clone(ps.data.sets) as any, name: ps.name })

/** Профиль семьи/ступени в черновике (null — убрать запись; пустая семья уходит). */
export function dSetProfile(d: Draft, fam: string, tier: string, p: P.Profile | null) {
  if (p) ((d.profiles ??= {})[fam] ??= {})[tier] = clone(p)
  else if (d.profiles?.[fam]) {
    delete d.profiles[fam][tier]
    if (!Object.keys(d.profiles[fam]).length) delete d.profiles[fam]
  }
}
/** Клетка набора в черновике (набор должен быть; null — убрать клетку). */
export function dSetCell(d: Draft, set: string, stage: string, cell: P.Cell | null) {
  if (!d.sets || !isObj(d.sets[set])) return
  if (cell) d.sets[set][stage] = clone(cell)
  else delete d.sets[set][stage]
  // прежнее имя accept — псевдоним develop_accept: новая запись его вытесняет, снятие убирает обе
  if (stage === "develop_accept") delete d.sets[set].accept
}
export function dNewSet(d: Draft, name: string, cells: Partial<Record<string, P.Cell>>) {
  const set: Record<string, any> = {}
  for (const [st, c] of Object.entries(cells)) if (c) set[st] = clone(c)
  ;(d.sets ??= {})[name] = set
}
export function dDeleteSet(d: Draft, name: string) {
  if (d.sets) delete d.sets[name]
}

/** Прежняя форма опций: папка, в которой нашёлся файл настроек при подъёме вверх от каталога (его читает и сам файл настроек). */
function legacyFolder(dir0: string): string | undefined {
  let d = dir0 ? path.resolve(dir0) : ""
  for (let i = 0; d && i < 32; i++) {
    if (existsSync(path.join(d, SETTINGS_FILE))) return d
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  return undefined
}

/** Три ключа рабочей копии файла проекта: undefined — файла нет, "bad" — не JSON. */
function workingKeys(folder: string): Record<string, any> | "bad" | undefined {
  const file = path.join(path.resolve(folder), SETTINGS_FILE)
  if (!existsSync(file)) return undefined
  const v = readJsonFile(file)
  return isObj(v) ? v : "bad"
}

/** Записать черновик в рабочую копию файла проекта одной атомарной записью (три ключа; остальное не трогается). */
export function writeDraft(ps: PState, d: Draft): { ok: true; file: string } | { ok: false; error: string } {
  if (!ps.folder) return { ok: false, error: "проект задан прежней формой опций: писать некуда (переведи его на папку настроек)" }
  // ключ, заданный поправкой local в опциях плагина, сильнее файла: правка файла ничего бы не изменила
  const over = settingsContext().local[ps.project] ?? {}
  const shadowed = P.PROFILE_KEYS.filter((k) => k in over)
  if (shadowed.length) return { ok: false, error: `${shadowed.join(", ")} задан поправкой local в опциях плагина (opencode.jsonc) и перекрывает файл проекта: правка файла ничего не изменила бы — убери его оттуда` }
  if (workingKeys(ps.folder) === "bad") return { ok: false, error: `${SETTINGS_FILE} в рабочей копии — не JSON: правка не записана, чтобы не затереть файл` }
  const has = (v: any) => isObj(v) && Object.keys(v).length > 0
  const file = writeSettings(ps.folder, { model_profiles: has(d.profiles) ? d.profiles : null, profile_sets: has(d.sets) ? d.sets : null, profile_set: d.name ?? null })
  return { ok: true, file }
}

// ---- состояние проекта -----------------------------------------------------------------------------------------------

export type PState = {
  project: string
  /** папка настроек проекта (новая форма опций; прежняя — папка найденного файла) или undefined */
  folder?: string
  /** настройки проекта; три ключа профилей — из рабочей копии файла */
  raw: any
  data: P.Data
  name?: string
  snapshot?: P.Snapshot
  state: P.State
}

export function readSnapshot(project: string): P.Snapshot | undefined {
  const v = readJsonFile(snapshotFile(project))
  return isObj(v) && typeof v.name === "string" && isObj(v.sets) ? (v as P.Snapshot) : undefined
}
export function writeSnapshot(project: string, s: P.Snapshot) {
  const text = JSON.stringify(s, null, 1)
  try {
    if (readFileSync(snapshotFile(project), "utf8") === text) return
  } catch {}
  writeAtomic(snapshotFile(project), text)
}
export const dropSnapshot = (project: string) => void rmSync(snapshotFile(project), { force: true })

/** Состояние профилей проекта каталога dir: файл, действующие данные, снимок и строка таблицы исходов. */
export function profileState(dir0: string): PState {
  const { projects, local } = settingsContext()
  const project = projectOf(dir0, projects)
  const p = projectFor(dir0, projects)
  let raw = rawSettingsFor(dir0, projects, local) ?? {}
  const w = p?.dir ? workingKeys(p.dir) : undefined
  if (isObj(w)) {
    const over = (p && local[p.name]) || {}
    raw = { ...raw }
    for (const k of P.PROFILE_KEYS) {
      if (k in over) continue
      if (k in w) raw[k] = w[k]
      else delete raw[k]
    }
  }
  const data: P.Data = { profiles: isObj(raw.model_profiles) ? clone(raw.model_profiles) : undefined, sets: isObj(raw.profile_sets) ? clone(raw.profile_sets) : undefined }
  const name = typeof raw.profile_set === "string" && raw.profile_set ? raw.profile_set : undefined
  const snapshot = readSnapshot(project)
  const state = P.stateRow(name, data, snapshot)
  state.bounds = P.boundsOf(raw)
  return { project, folder: p?.dir ?? (p ? legacyFolder(dir0) : undefined), raw, data, name, snapshot, state }
}

/** Проход сервиса: снимок создаётся на первом допустимом проходе при включённом наборе и обновляется, отбрасывается на строках 1 и 7.
 *  Возвращает состояние. */
export function syncSnapshot(dir0: string): PState {
  const st = profileState(dir0)
  if (st.state.row === 2 && st.name) writeSnapshot(st.project, P.snapshotOf(st.data, st.name))
  else if (st.state.row === 1 || st.state.row === 7) dropSnapshot(st.project)
  return profileState(dir0)
}

/** Подпись входных данных: когда меняется, файлы окон и снимок пересчитываются. */
export function stateSignature(ps: PState): string {
  return createHash("md5").update(canonical({ f: [ps.raw?.model_profiles, ps.raw?.profile_sets, ps.raw?.profile_set], s: ps.snapshot })).digest("hex")
}

// ---- журнал правок и проблемы для самопроверки -----------------------------------------------------------------------

/** Строка журнала плагина на успешную правку (единственный вызывающий — commitEdit в profile-cmd.ts). */
export function logEdit(project: string, command: string, what: string, from: any, to: any) {
  const show = (v: any) => (v === undefined || v === null ? "—" : typeof v === "string" ? v : JSON.stringify(v))
  log(`profile edit: ${project} ${command} ${what} (${show(from)} -> ${show(to)})`)
}
/** Отказанная правка: одна строка с причиной. */
export function logRefused(project: string, command: string, why: string) {
  log(`profile edit refused: ${project} ${command}: ${why}`)
}

/** Проблемы профилей проекта словами — для crew_doctor, check и уведомления (окна файлов добавляет profile-windows). */
export function problemsOf(ps: PState): string[] {
  const out: string[] = []
  const row = ps.state.row
  if (ps.state.message) out.push(`проект ${ps.project}: ${ps.state.message}`)
  if (row !== 6 && row !== 7) for (const w of ps.state.warnings) out.push(`проект ${ps.project}: ${w.text}`)
  if (ps.state.bounds?.error) out.push(`проект ${ps.project}: ${ps.state.bounds.error}`)
  return out
}

// ---- показ и проверка связей для crew_config ---------------------------------------------------------------------------

/** Итог по профилям одной строкой: сколько наборов в файле и какой включён (два разных случая: наборов нет / набор не включён). */
export function profilesSummary(dir0: string): string {
  const ps = profileState(dir0)
  const names = Object.keys(isObj(ps.data.sets) ? ps.data.sets : {})
  const on = ps.name ? `включён: ${ps.name}` : "включён: нет"
  const tail = !names.length ? "наборов в файле нет вообще" : ps.name ? "" : "наборы есть, но ни один не включён (модели новых сессий — по spawn_models)"
  return `Профили моделей — наборов в файле: ${names.length}${names.length ? `: ${names.join(", ")}` : ""}; ${on}${tail ? ` (${tail})` : ""}.`
}

/** Блок «Профили моделей» для crew_config show и /crew-config (пусто, если у проекта нет профилей, наборов и имени). */
export function profilesShow(dir0: string): string {
  const ps = profileState(dir0)
  const has = (v: any) => isObj(v) && Object.keys(v).length > 0
  const b = ps.state.bounds
  if (!has(ps.data.profiles) && !has(ps.data.sets) && !ps.name && !b?.min && !b?.max && !b?.error) return ""
  const lines: string[] = []
  if (b?.min || b?.max) lines.push(`Границы ступеней: ${b.min ? `не ниже ${b.min}` : ""}${b.min && b.max ? ", " : ""}${b.max ? `не выше ${b.max}` : ""} (tier_min, tier_max).`)
  lines.push(profilesSummary(dir0))
  lines.push(`  состояние: ${ps.name ? `включён набор «${ps.name}» (файл проекта)` : "набор не включён"}${ps.state.row === 2 || ps.state.row === 1 ? "" : `; строка ${ps.state.row} таблицы исходов`}.`)
  if (has(ps.data.profiles)) {
    lines.push("Справочник (семья, ступень -> модель · вариант, окно):")
    for (const [f, t] of Object.entries(ps.data.profiles!).sort((a, b) => a[0].localeCompare(b[0])))
      for (const tier of P.PROFILE_TIERS) {
        const p = (t as any)[tier]
        if (!p) continue
        lines.push(`  ${f.padEnd(8)}${tier.padEnd(8)}${P.isEmptyProfile(p) ? "(пусто — заполнить)" : `${P.modelText(p)}, ${limitsText(p)}`}`)
      }
  }
  if (has(ps.data.sets)) {
    lines.push("Наборы (этап -> семья/ступень; * — включённый):")
    for (const [n, s] of Object.entries(ps.data.sets!)) lines.push(`  ${n === ps.name ? "*" : " "} ${n}: ${P.cellsOf(s).map(([st, c]) => `${st} ${P.cellText(c)}`).join(", ") || "(клеток нет)"}`)
  }
  lines.push(ps.name ? "Выключить набор может только человек: /crew-sets off; сменить — /crew-sets use <имя>." : "Включить набор может только человек: /crew-sets use <имя> (агент crew_config set набор не включает).")
  for (const p of problemsOf(ps)) lines.push(`  ! ${p}`)
  return lines.join("\n")
}

/** Новые повисшие ссылки, которые создала бы запись values в рабочую копию файла (REQ-34: рабочая копия плюс вносимое). */
export function linkErrorsOfWrite(folder: string, values: Record<string, any>): string[] {
  if (!("model_profiles" in values) && !("profile_sets" in values)) return []
  const work = workingSettings(folder).raw
  const merged: any = { ...work }
  for (const [k, v] of Object.entries(values)) if (v === null) delete merged[k]
  else merged[k] = v
  const before = P.linkProblems({ profiles: work.model_profiles, sets: work.profile_sets }).map((p) => p.text)
  return P.linkProblems({ profiles: merged.model_profiles, sets: merged.profile_sets }).map((p) => p.text).filter((t) => !before.includes(t))
}

// ---- файлы окон по состоянию ------------------------------------------------------------------------------------------

/** Файлы окон проекта привести к состоянию: записать, обновить, снять (проход сервиса, use, правка). */
export function syncProjectFiles(dir0: string): SyncReport & { plan: WindowPlan } {
  const ps = profileState(dir0)
  const plan = windowPlanOf(ps.state)
  return { ...syncWindows(ps.project, listTasks(ps.project), plan), plan }
}
/** Файл окон для одной задачи до первого хода её сессии (REQ-22); сбой записи не срывает запуск. */
export function syncTaskFile(t: Task): SyncReport {
  const ps = profileState(t.directory)
  return syncTaskWindow(ps.project, t, windowPlanOf(ps.state))
}

/** Проблемы профилей всех проектов процесса — для crew_doctor и уведомления. */
/** service — проход службы: о файле прежнего слоя сообщается один раз за процесс; иначе (crew_doctor) — каждый раз. */
export function profileProblems(service = false): string[] {
  const out: string[] = []
  for (const p of settingsContext().projects) {
    const dir0 = p.dir ?? p.rootPath
    if (!dir0) continue
    try {
      const ps = profileState(dir0)
      const lay = service ? legacyLayerNote(ps.project) : legacyLayerText(ps.project)
      if (lay) out.push(lay)
      out.push(...problemsOf(ps), ...windowProblems(ps.project, listTasks(ps.project), windowPlanOf(ps.state)))
      // рукописные окна, которые перекрывают окно профиля, и явный порог Claude Code — названы с файлом и значением (REQ-16, REQ-23)
      const u = ps.state.usable
      if (u && ps.state.row !== 6) out.push(...windowNotes(p.rootPath ?? dir0, qualifying(ps.project, listTasks(ps.project)), P.windowsOfSet(u.data, u.name).models).map((x) => `проект ${ps.project}: ${x}`))
      // сданные задачи, которым приёмщика не нашли из-за набора (REQ-15): причина — в самопроверке
      for (const t of listTasks(ps.project)) {
        if (t.status !== "submitted" || t.reviewer) continue
        const r = P.resolveStageProfile(ps.state, P.stageOfLaunch(t, "reviewer"), { taskTier: t.tier })
        if (r && "refuse" in r) out.push(`проект ${ps.project}: задача #${t.n} «${t.title}»: сдана, приёмщика нет — ${r.refuse}`)
      }
    } catch (e) {
      log(`profile problems of ${p.name} failed: ${e}`)
    }
  }
  return out
}
