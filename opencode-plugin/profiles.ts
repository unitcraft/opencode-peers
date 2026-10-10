// ПРОФИЛИ МОДЕЛЕЙ И НАБОРЫ (задача 003). Чистые данные без файлов и без обращений к ядру: этапы, словари, проверка
// значений трёх ключей настроек проекта (model_profiles, profile_sets, profile_set), семья модели вкладки.
// Файл настроек читается любым JSON-читателем (в том числе сервисом задачи 001), поэтому формат — обычный JSON:
//   model_profiles: { "<семья>": { "heavy"|"medium"|"light": { "model": "провайдер/модель", "context": N, "output": N[, "input": N] } } }
//   profile_sets:   { "<имя набора>": { "<этап>": { "family": "<семья>", "tier": "heavy"|"medium"|"light"|"task" } } }
//   этапы (задача 015, раздел «Этапы и модели» Канона): develop, develop_accept, plan, plan_accept — явные; spec, spec_accept,
//   delivery, delivery_accept — по умолчанию наследуют; прежнее имя accept читается как develop_accept (псевдоним)
//   tier_min, tier_max: границы ступеней проекта (задача 016); любая ступень любого этапа срезается в них
//   profile_set:    "<имя набора по умолчанию>" (ставит человек)
// Пустая запись («заполнить») — { "model": "" }. Окно — свойство профиля (модели), а не этапа.

import { limitsText } from "./core.ts" // единственное форматирование чисел ответов (core.ts); вызывается при показе, не при загрузке

/** Этапы, которые владелец задаёт явно, и этапы, которые по умолчанию наследуют (таблица «Этапы и модели» Канона). */
export const CORE_STAGES = ["develop", "develop_accept", "plan", "plan_accept"] as const
export const EXTRA_STAGES = ["spec", "spec_accept", "delivery", "delivery_accept"] as const
export const STAGES = [...CORE_STAGES, ...EXTRA_STAGES] as const
export type Stage = (typeof STAGES)[number]
export const isStage = (s: any): s is Stage => (STAGES as readonly string[]).includes(s)
/** Прежние имена этапов в файле и в командах: читаются как новые, в наборе новая запись вытесняет прежнюю. */
export const LEGACY_STAGES: Record<string, Stage> = { accept: "develop_accept" }
export const canonStage = (s: any): Stage | undefined => (isStage(s) ? s : LEGACY_STAGES[String(s)])
/** Названия этапов в командах: латиница и русский (в файле — латиница; accept — псевдоним develop_accept). */
export const STAGE_WORDS: Record<string, Stage> = {
  develop: "develop",
  develop_accept: "develop_accept",
  accept: "develop_accept",
  plan: "plan",
  plan_accept: "plan_accept",
  spec: "spec",
  spec_accept: "spec_accept",
  delivery: "delivery",
  delivery_accept: "delivery_accept",
  разработка: "develop",
  приёмка: "develop_accept",
  приемка: "develop_accept",
  планирование: "plan",
  "приёмка-плана": "plan_accept",
  "приемка-плана": "plan_accept",
  разбор: "spec",
  "приёмка-разбора": "spec_accept",
  "приемка-разбора": "spec_accept",
  сдача: "delivery",
  "приёмка-сдачи": "delivery_accept",
  "приемка-сдачи": "delivery_accept",
}
export const STAGE_RU: Record<Stage, string> = {
  develop: "разработка",
  develop_accept: "приёмка",
  plan: "планирование",
  plan_accept: "приёмка плана",
  spec: "разбор",
  spec_accept: "приёмка разбора",
  delivery: "сдача",
  delivery_accept: "приёмка сдачи",
}
/** Список этапов для сообщений об ошибке. */
export const STAGES_TEXT = `${STAGES.join(", ")} (прежнее accept — то же, что develop_accept)`
export const stageOfWord = (w: string): Stage | undefined => STAGE_WORDS[String(w).toLowerCase()]

export const PROFILE_TIERS = ["heavy", "medium", "light"] as const
export type PTier = (typeof PROFILE_TIERS)[number]
export const isPTier = (t: any): t is PTier => PROFILE_TIERS.includes(t)
export const CELL_TIERS = ["heavy", "medium", "light", "task"] as const
export type CellTier = (typeof CELL_TIERS)[number]
export const isCellTier = (t: any): t is CellTier => CELL_TIERS.includes(t)

export const RESERVED_WORDS = ["use", "reset", "all", "list", "show", "set", "unset", "new", "rename", "delete", "check", "save", "from", "off"]
export const SET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
export const FAMILY_RE = /^[a-z0-9-]+$/
export const FAMILY_BAD = ["all", "context", "output", "input"]
export const MODEL_RE = /^[^/\s]+\/\S+$/
const PROFILE_FIELDS = ["model", "context", "output", "input", "variant"]
export const VARIANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type Profile = { model: string; context?: number; output?: number; input?: number; variant?: string }

/** Модель ячейки без варианта: «провайдер/id» (суффикс «#вариант» отброшен). */
export const baseModel = (p: any): string => String(isObj(p) ? p.model ?? "" : p ?? "").split("#")[0]
/** Вариант модели (усилие) ячейки: суффикс «#вариант» в model или поле variant; пусто — варианта нет. */
export const variantOf = (p: any): string | undefined => {
  const m = String(isObj(p) ? p.model ?? "" : p ?? "")
  const i = m.indexOf("#")
  const v = i >= 0 ? m.slice(i + 1) : isObj(p) && typeof p.variant === "string" ? p.variant : ""
  return v || undefined
}
/** Строка для запуска и показа: «провайдер/id» или «провайдер/id#вариант». */
export const modelWithVariant = (p: any): string => baseModel(p) + (variantOf(p) ? `#${variantOf(p)}` : "")
/** Показ в таблицах: «провайдер/id · вариант». */
export const modelText = (p: any): string => baseModel(p) + (variantOf(p) ? ` · ${variantOf(p)}` : "")
/** Разбор строки «провайдер/id[#вариант]» для ctx.session.create. */
export function splitLaunchModel(model: string): { providerID: string; id: string; variant?: string } {
  const [m, ...v] = String(model ?? "").split("#")
  const [providerID, ...rest] = m.split("/")
  const variant = v.join("#")
  return { providerID, id: rest.join("/"), ...(variant ? { variant } : {}) }
}
export type Cell = { family: string; tier: CellTier }
export type Families = Record<string, Partial<Record<PTier, Profile>>>
export type Sets = Record<string, Partial<Record<Stage, Cell>>>
/** Данные профилей: справочник, наборы (три ключа файла проекта). */
export type Data = { profiles?: Families; sets?: Sets }

const isObj = (v: any): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)
const isPosInt = (v: any) => Number.isInteger(v) && v > 0
const isNonNegInt = (v: any) => Number.isInteger(v) && v >= 0

/** Пустая запись справочника («заполнить»): нет модели и нет окна. */
export const isEmptyProfile = (p: any): boolean => !isObj(p) || (String(p.model ?? "") === "" && !(Number(p.context) > 0))

/** Текст клетки: «семья/ступень». */
export const cellText = (c: Cell): string => `${c.family}/${c.tier}`
/** «семья/ступень» → клетка или текст ошибки. */
export function parseCell(text: string): Cell | string {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(text).trim())
  if (!m) return `клетка — «семья/ступень», например claude/heavy или kimi/task; получено «${text}»`
  if (!FAMILY_RE.test(m[1]) || FAMILY_BAD.includes(m[1])) return `имя семьи «${m[1]}» не годится: строчные латинские буквы, цифры, дефис, не ${FAMILY_BAD.join("/")}`
  if (!isCellTier(m[2])) return `ступень «${m[2]}» не годится: ${CELL_TIERS.join(", ")}`
  return { family: m[1], tier: m[2] }
}

/** Ошибка имени набора или undefined. */
export function invalidSetName(name: string): string | undefined {
  if (RESERVED_WORDS.includes(name)) return `имя набора «${name}» занято словом команд (${RESERVED_WORDS.join(", ")})`
  if (!SET_NAME_RE.test(name)) return `имя набора «${name}» не годится: строчные латинские буквы, цифры, дефис, с буквы или цифры, до 40 знаков`
  return undefined
}
/** Ошибка имени семьи или undefined. */
export function invalidFamilyName(name: string): string | undefined {
  if (!FAMILY_RE.test(name)) return `имя семьи «${name}» не годится: строчные латинские буквы, цифры, дефис`
  if (FAMILY_BAD.includes(name)) return `имя семьи «${name}» занято словом команд (${FAMILY_BAD.join(", ")})`
  return undefined
}

/** Форма одного профиля (место — путь для сообщения). */
export function invalidProfile(p: any, where: string): string | undefined {
  if (!isObj(p)) return `${where}: запись {"model": "провайдер/модель", "context": число, "output": число[, "input": число]}`
  for (const k of Object.keys(p)) if (!PROFILE_FIELDS.includes(k)) return `${where}.${k}: неизвестное поле; поля — ${PROFILE_FIELDS.join(", ")}`
  if (typeof p.model !== "string") return `${where}.model: строка «провайдер/модель» (пустая строка — запись «заполнить»)`
  if (p.model === "") {
    for (const k of ["context", "output", "input"]) if (p[k] !== undefined && !isNonNegInt(p[k])) return `${where}.${k}: целое число (в пустой записи можно не задавать)`
    return undefined
  }
  const suffix = p.model.includes("#") ? p.model.slice(p.model.indexOf("#") + 1) : undefined
  if (!MODEL_RE.test(baseModel(p))) return `${where}.model: «${p.model}» — нужно «провайдер/модель» или «провайдер/модель#вариант»`
  if (suffix !== undefined && !VARIANT_RE.test(suffix)) return `${where}.model: вариант после «#» — буквы, цифры, точка, дефис («${p.model}»)`
  if (p.variant !== undefined) {
    if (typeof p.variant !== "string" || !VARIANT_RE.test(p.variant)) return `${where}.variant: строка (буквы, цифры, точка, дефис), например "low"`
    if (suffix !== undefined && suffix !== p.variant) return `${where}: вариант задан дважды и по-разному (model «#${suffix}», variant «${p.variant}»); оставьте один способ или сделайте их равными`
  }
  if (!isPosInt(p.context)) return `${where}.context: целое положительное число (контекст, токены)`
  if (!isPosInt(p.output)) return `${where}.output: целое положительное число (предел вывода; без него OpenCode отбросит запись окна целиком)`
  if (p.input !== undefined && !isPosInt(p.input)) return `${where}.input: целое положительное число`
  if (p.input !== undefined && p.input > p.context) return `${where}.input (${p.input}) больше context (${p.context})`
  return undefined
}

/** Форма клетки набора. */
export function invalidCell(c: any, where: string): string | undefined {
  if (!isObj(c)) return `${where}: клетка {"family": "семья", "tier": "heavy"|"medium"|"light"|"task"}`
  for (const k of Object.keys(c)) if (k !== "family" && k !== "tier") return `${where}.${k}: неизвестный ключ клетки (только family и tier)`
  if (typeof c.family !== "string" || invalidFamilyName(c.family)) return `${where}.family: ${typeof c.family === "string" ? invalidFamilyName(c.family) : "имя семьи — строка"}`
  if (!isCellTier(c.tier)) return `${where}.tier: одно из ${CELL_TIERS.join(" / ")}`
  return undefined
}

/**
 * Значение ключа профилей: текст ошибки или undefined. lenientStages — незнакомый ключ-этап читатель игнорирует (файл
 * из будущей версии), а не отвергает; команды и crew_config set проверяют строго.
 */
export function invalidProfileKey(key: string, v: any, opts: { lenientStages?: boolean } = {}): string | undefined {
  if (key === "model_profiles") {
    if (!isObj(v)) return `${key}: {"семья": {"heavy"|"medium"|"light": {"model": "провайдер/модель", "context": число, "output": число}}}`
    for (const [fam, tiers] of Object.entries(v)) {
      const bad = invalidFamilyName(fam)
      if (bad) return `${key}: ${bad}`
      if (!isObj(tiers)) return `${key}.${fam}: {"heavy"|"medium"|"light": запись}`
      for (const [t, p] of Object.entries(tiers)) {
        if (!isPTier(t)) return `${key}.${fam}.${t}: ступень — одно из ${PROFILE_TIERS.join(", ")}`
        const e = invalidProfile(p, `${key}.${fam}.${t}`)
        if (e) return e
      }
    }
    return undefined
  }
  if (key === "profile_sets") {
    if (!isObj(v)) return `${key}: {"имя набора": {"develop"|"develop_accept"|"plan"|"plan_accept"|…: {"family": "семья", "tier": "heavy"|"medium"|"light"|"task"}}}`
    for (const [name, stages] of Object.entries(v)) {
      const bad = invalidSetName(name)
      if (bad) return `${key}: ${bad}`
      if (!isObj(stages)) return `${key}.${name}: {этап: клетка}`
      for (const [st, cell] of Object.entries(stages)) {
        if (!canonStage(st)) {
          if (opts.lenientStages) continue
          return `${key}.${name}.${st}: неизвестный этап; этапы — ${STAGES_TEXT}`
        }
        const e = invalidCell(cell, `${key}.${name}.${st}`)
        if (e) return e
      }
    }
    return undefined
  }
  if (key === "profile_set") {
    if (typeof v !== "string") return `${key}: имя набора — строка`
    return invalidSetName(v)
  }
  return `неизвестный ключ профилей «${key}»`
}
export const PROFILE_KEYS = ["model_profiles", "profile_sets", "profile_set"]

/** Модель в виде «провайдер/id» без варианта после «#», в нижнем регистре. */
export const normModel = (m: any): string => String(m ?? "").split("#")[0].trim().toLowerCase()

/**
 * Семья вкладки по справочнику: строка модели приводится к «провайдер/id» и сравнивается целиком с моделью профилей на
 * любой ступени; gpt-5.5 и gpt-5.5-fast — разные модели. Вне справочника — undefined.
 */
export function familyOfModel(model: any, profiles: Families | undefined): string | undefined {
  const m = normModel(model)
  if (!m || !isObj(profiles)) return undefined
  for (const fam of Object.keys(profiles).sort()) {
    const tiers = profiles[fam]
    if (!isObj(tiers)) continue
    for (const p of Object.values(tiers)) if (isObj(p) && p.model && normModel(p.model) === m) return fam
  }
  return undefined
}

/** Этап сессии по виду запуска: задача-план — планирование и приёмка плана, остальное — разработка и приёмка. */
export function stageOfLaunch(t: { plan?: unknown }, role: "executor" | "reviewer"): Stage {
  if (role === "executor") return t.plan ? "plan" : "develop"
  return t.plan ? "plan_accept" : "develop_accept"
}

// ---------------------------------------------------------------------------------------------------------------------
// Связи между ключами, окна набора, проверка данных, таблица состояний, выбор профиля (шаг 3 плана; без файлов).

export type Problem = { kind: "form" | "link" | "empty" | "conflict"; set?: string; text: string }
export type Win = { context: number; output: number; input?: number }
const sameWin = (a: Win, b: Win) => a.context === b.context && a.output === b.output && a.input === b.input

/** Запись этапа в наборе: своё имя, а у develop_accept — ещё и прежнее accept (новое имя главнее). */
export const rawCell = (set: any, st: Stage): any => (isObj(set) ? (set[st] ?? (st === "develop_accept" ? set.accept : undefined)) : undefined)
const validCell = (c: any): c is Cell => isObj(c) && typeof c.family === "string" && isCellTier(c.tier)

/** Описанные в наборе (явно) клетки известных этапов (незнакомые этапы читатель игнорирует). */
export function cellsOf(set: any): [Stage, Cell][] {
  if (!isObj(set)) return []
  const out: [Stage, Cell][] = []
  for (const st of STAGES) {
    const c = rawCell(set, st)
    if (validCell(c)) out.push([st, c])
  }
  return out
}

// ---- наследование этапов и семья проверяющего (задача 015) ----------------------------------------------------------------

/** Ступенью ниже: heavy → medium → light; light и task остаются (task разрешается по задаче, потом берётся ступень ниже — lower). */
export const lowerTier = (t: CellTier): CellTier => (t === "heavy" ? "medium" : t === "medium" ? "light" : t)
/** Наследование пустых этапов: от какого этапа берётся клетка и берётся ли она на ступень ниже (сдача идёт на классе B). */
export const INHERIT: Partial<Record<Stage, { from: Stage; lower: boolean }>> = {
  spec: { from: "plan", lower: false },
  spec_accept: { from: "plan_accept", lower: false },
  delivery: { from: "develop", lower: true },
  delivery_accept: { from: "develop_accept", lower: true },
}
/** Этап проверки → этап, чей артефакт он проверяет (семья проверяющего отличается от семьи автора). */
export const AUTHOR_OF: Partial<Record<Stage, Stage>> = { develop_accept: "develop", plan_accept: "plan", spec_accept: "spec", delivery_accept: "delivery" }

export type Effective = {
  cell: Cell
  how: "explicit" | "inherited"
  /** этап, от которого унаследована клетка */
  from?: Stage
  /** клетка `task`: после выбора ступени по задаче берётся ступень ниже */
  lower?: boolean
}

/** Другая семья со всеми профилями, нужными клетке автора: первая по алфавиту; нет — undefined. */
export function otherFamily(profiles: Families | undefined, author: Cell): string | undefined {
  if (!isObj(profiles)) return undefined
  return Object.keys(profiles)
    .sort()
    .find((fam) => fam !== author.family && referencedProfiles({ family: fam, tier: author.tier }).every((r) => isObj(profiles[fam]?.[r.tier]) && !isEmptyProfile(profiles[fam][r.tier])))
}

/**
 * Клетка этапа по набору: явная; иначе унаследованная (spec ← plan, spec_accept ← plan_accept, delivery и delivery_accept — от
 * develop и develop_accept ступенью ниже); иначе undefined (модель по spawn_models, как прежде: требование 003 «этап без клетки
 * идёт по spawn_models» не меняется). Семью проверяющего, совпавшую с семьёй автора, показывает sameFamilyNotes.
 */
export function effectiveCell(set: any, stage: Stage, profiles?: Families): Effective | undefined {
  const raw = rawCell(set, stage)
  if (validCell(raw)) return { cell: raw, how: "explicit" }
  const inh = INHERIT[stage]
  if (inh) {
    const base = effectiveCell(set, inh.from, profiles)
    if (!base) return undefined
    const tier = inh.lower ? lowerTier(base.cell.tier) : base.cell.tier
    return { cell: { family: base.cell.family, tier }, how: "inherited", from: inh.from, ...(inh.lower && base.cell.tier === "task" ? { lower: true } : {}) }
  }
  return undefined
}

/**
 * Правило «проверяющий ≠ семья автора» (ADR-0013, раздел «Этапы и модели» Канона): пары этапов набора, где проверка идёт на той
 * же семье, что автор, хотя в справочнике есть другая. Только заметка: модель по набору не меняется (запись «семья та же:
 * причина» делает владелец, плагин причины не знает).
 */
export function sameFamilyNotes(set: any, profiles?: Families): string[] {
  const out: string[] = []
  for (const [check, author] of Object.entries(AUTHOR_OF) as [Stage, Stage][]) {
    const c = effectiveCell(set, check, profiles)
    const a = effectiveCell(set, author, profiles)
    if (!c || !a || c.cell.family !== a.cell.family) continue
    const other = otherFamily(profiles, a.cell)
    if (other) out.push(`«${STAGE_RU[check]}» идёт на той же семье ${c.cell.family}, что «${STAGE_RU[author]}»; в справочнике есть другая (${other}) — правило проверки на другой семье моделей`)
  }
  return out
}

// ---- границы ступеней проекта (задача 016) --------------------------------------------------------------------------------

const TIER_RANK: Record<PTier, number> = { light: 0, medium: 1, heavy: 2 }
export type Bounds = { min?: PTier; max?: PTier; error?: string }
/** Границы из настроек проекта (tier_min, tier_max); ошибка — текст, и тогда границы не применяются. */
export function boundsOf(raw: any): Bounds {
  const min = isObj(raw) ? raw.tier_min : undefined
  const max = isObj(raw) ? raw.tier_max : undefined
  for (const [k, v] of [["tier_min", min], ["tier_max", max]] as const) {
    if (v !== undefined && !isPTier(v)) return { error: `${k}: «${String(v)}» не годится; ступень — одно из ${PROFILE_TIERS.join(", ")}` }
  }
  if (isPTier(min) && isPTier(max) && TIER_RANK[min] > TIER_RANK[max]) return { error: `tier_min (${min}) выше tier_max (${max}): границы ступеней не применяются` }
  return { ...(isPTier(min) ? { min } : {}), ...(isPTier(max) ? { max } : {}) }
}
/** Ступень в границах; from — исходная ступень, если её срезали. */
export function clampTier(t: PTier, b?: Bounds): { tier: PTier; from?: PTier } {
  if (!b || b.error) return { tier: t }
  let r = t
  if (b.max && TIER_RANK[r] > TIER_RANK[b.max]) r = b.max
  if (b.min && TIER_RANK[r] < TIER_RANK[b.min]) r = b.min
  return r === t ? { tier: t } : { tier: r, from: t }
}

/** Профили, на которые ссылается клетка: явная ступень — одна, `task` — все три (ступень берётся из входа или записи задачи). */
export function referencedProfiles(cell: Cell): { family: string; tier: PTier }[] {
  return cell.tier === "task" ? PROFILE_TIERS.map((tier) => ({ family: cell.family, tier })) : [{ family: cell.family, tier: cell.tier }]
}

/** Повисшие ссылки наборов (всех или одного) на семью и ступень справочника. */
export function linkProblems(data: Data, setName?: string): Problem[] {
  const out: Problem[] = []
  const sets = isObj(data.sets) ? data.sets : {}
  for (const name of setName ? [setName] : Object.keys(sets)) {
    for (const [st, cell] of cellsOf(sets[name])) {
      const fam = isObj(data.profiles) ? data.profiles[cell.family] : undefined
      if (!isObj(fam)) {
        out.push({ kind: "link", set: name, text: `набор «${name}», этап «${STAGE_RU[st]}»: семьи «${cell.family}» нет в справочнике профилей` })
        continue
      }
      for (const ref of referencedProfiles(cell)) if (!isObj(fam[ref.tier])) out.push({ kind: "link", set: name, text: `набор «${name}», этап «${STAGE_RU[st]}»: у семьи «${cell.family}» нет ступени «${ref.tier}» в справочнике` })
    }
  }
  return out
}

/** Ссылки набора на пустые записи («заполнить», REQ-30). */
export function emptyRefs(data: Data, setName: string): Problem[] {
  const out: Problem[] = []
  for (const [st, cell] of cellsOf(data.sets?.[setName])) {
    const fam = isObj(data.profiles) ? data.profiles[cell.family] : undefined
    if (!isObj(fam)) continue
    for (const ref of referencedProfiles(cell)) if (isObj(fam[ref.tier]) && isEmptyProfile(fam[ref.tier])) out.push({ kind: "empty", set: setName, text: `набор «${setName}», этап «${STAGE_RU[st]}»: профиль ${ref.family}/${ref.tier} пуст («заполнить»)` })
  }
  return out
}

/**
 * Окна набора: для каждой модели профилей всех трёх ступеней каждой семьи, названной в этапах набора (tier на входе
 * меняет ступень внутри семьи). Одна модель в двух профилях с разными полями окна — конфликт: окно одно на модель.
 */
export function windowsOfSet(data: Data, setName: string): { models: Map<string, Win>; conflicts: Problem[]; families: string[] } {
  const models = new Map<string, Win>()
  const conflicts: Problem[] = []
  const families = [...new Set(cellsOf(data.sets?.[setName]).map(([, c]) => c.family))].sort()
  const groups = new Map<string, { at: string; win: Win }[]>()
  for (const fam of families) {
    const tiers = isObj(data.profiles) ? data.profiles[fam] : undefined
    if (!isObj(tiers)) continue
    for (const tier of PROFILE_TIERS) {
      const p = tiers[tier]
      if (!isObj(p) || isEmptyProfile(p) || !p.model) continue
      const win: Win = { context: Number(p.context), output: Number(p.output), ...(p.input !== undefined ? { input: Number(p.input) } : {}) }
      groups.set(baseModel(p), [...(groups.get(baseModel(p)) ?? []), { at: `${fam}/${tier}`, win }])
    }
  }
  for (const [model, list] of groups) {
    if (list.every((x) => sameWin(x.win, list[0].win))) models.set(model, list[0].win)
    else conflicts.push({ kind: "conflict", set: setName, text: `набор «${setName}»: модель ${model} стоит в профилях с разными контекстами (контекст в OpenCode один на модель): ${list.map((x) => `${x.at} — ${limitsText(x.win)}`).join("; ")}` })
  }
  return { models, conflicts, families }
}

/** Проверка данных: ошибки (недопустимо) и предупреждения. Включённый набор строже остальных. */
export function checkData(data: Data, enabled?: string): { errors: Problem[]; warnings: Problem[] } {
  const errors: Problem[] = []
  const warnings: Problem[] = []
  if (data.profiles !== undefined) {
    const e = invalidProfileKey("model_profiles", data.profiles)
    if (e) errors.push({ kind: "form", text: e })
  }
  if (data.sets !== undefined) {
    const e = invalidProfileKey("profile_sets", data.sets, { lenientStages: true })
    if (e) errors.push({ kind: "form", text: e })
  }
  if (errors.length) return { errors, warnings }
  for (const p of linkProblems(data)) (p.set === enabled ? errors : warnings).push(p)
  if (enabled && isObj(data.sets?.[enabled])) {
    errors.push(...emptyRefs(data, enabled))
    errors.push(...windowsOfSet(data, enabled).conflicts)
  }
  return { errors, warnings }
}

/** Снимок: последнее допустимое состояние трёх ключей (остальные настройки проекта в него не входят). */
export type Snapshot = { name: string; profiles: Families; sets: Sets }
export const snapshotOf = (data: Data, name: string): Snapshot => JSON.parse(JSON.stringify({ name, profiles: data.profiles ?? {}, sets: data.sets ?? {} }))

export type StateRow = 1 | 2 | 3 | 4 | 5 | 6 | 7
export type State = {
  /** строка таблицы исходов (REQ-33) */
  row: StateRow
  name?: string
  /** по каким данным идут сессии: действующим или снимку; нет — набор не применяется (строки 1, 6, 7) */
  usable?: { data: Data; name: string; viaSnapshot: boolean }
  /** строка 4: набор недопустим, снимка нет — профили ищутся в действующих данных, окно профиля не пишется */
  degraded?: boolean
  errors: Problem[]
  warnings: Problem[]
  /** сообщение владельцу и самопроверке (пусто, если сказать нечего) */
  message: string
  /** границы ступеней проекта (tier_min, tier_max); ставит читатель настроек */
  bounds?: Bounds
}
const nonEmpty = (v: any) => isObj(v) && Object.keys(v).length > 0

/**
 * Единая таблица исходов (REQ-33): имя набора, наличие набора, ключей профилей, допустимость и снимок → строка 1…7.
 * Сессии, файлы окон и сообщения берут исход отсюда, никто не пересчитывает таблицу сам.
 */
export function stateRow(name: string | undefined, eff: Data, snapshot?: Snapshot): State {
  const nothing = { errors: [] as Problem[], warnings: [] as Problem[] }
  if (!name) return { row: 1, ...nothing, message: "" }
  if (!nonEmpty(eff.profiles) && !nonEmpty(eff.sets)) return { row: 7, name, ...nothing, message: `имя набора «${name}» игнорируется: в проекте нет ни справочника профилей, ни наборов` }
  const check = checkData(eff, name)
  const bySnap = snapshot && isObj(snapshot.sets) ? { data: { profiles: snapshot.profiles, sets: snapshot.sets }, name: snapshot.name || name, viaSnapshot: true } : undefined
  const list = (ps: Problem[]) => ps.map((p) => p.text).join("; ")
  if (isObj(eff.sets) && isObj(eff.sets[name])) {
    if (!check.errors.length) return { row: 2, name, usable: { data: eff, name, viaSnapshot: false }, ...check, message: "" }
    if (bySnap) return { row: 3, name, usable: bySnap, ...check, message: `набор «${name}» недопустим: ${list(check.errors)}. Сессии идут по последнему допустимому состоянию (набор «${bySnap.name}»); исправь данные` }
    return { row: 4, name, usable: { data: eff, name, viaSnapshot: false }, degraded: true, ...check, message: `набор «${name}» недопустим, а допустимого состояния нет: ${list(check.errors)}. Этап без клетки идёт по spawn_models; профиль, который не находится, — отказ; окна профиля не пишутся` }
  }
  if (bySnap) return { row: 5, name, usable: bySnap, ...check, message: `набора «${name}» нет в данных проекта (удалён или переименован). Сессии идут по последнему допустимому состоянию (набор «${bySnap.name}»); верни набор или смени имя` }
  return { row: 6, name, ...check, message: `набора «${name}» нет в данных проекта, допустимого состояния нет: этапы, которым нужен профиль, отказываются; верни набор или убери profile_set из файла проекта` }
}

export type Resolved = { model: string; family: string; tier: PTier; set: string; viaSnapshot: boolean; window: boolean; stage: Stage; clampedFrom?: PTier; how?: "inherited" }
export type ResolveOpts = {
  /** ступень из входа инструмента (ключ присутствует и значение — ступень) либо ступень записи задачи при reassign */
  inputTier?: any
  /** ступень записи задачи — для клетки `task` приёмки */
  taskTier?: any
  /** шаг авто-плана: ступень этапа разработки, tier на входе нет */
  autoPlan?: boolean
}

/**
 * Профиль этапа по состоянию (REQ-06, REQ-15, REQ-33): undefined — набора нет или этап не описан (берётся spawn_models);
 * { refuse } — набор включён, этап описан, а профиль не находится: молчаливой подмены семьи нет.
 */
export function resolveStageProfile(state: State | undefined, stage: Stage, opts: ResolveOpts = {}): Resolved | { refuse: string } | undefined {
  if (!state || state.row === 1 || state.row === 7) return undefined
  if (state.row === 6) return { refuse: `включён набор «${state.name}», но его нет в данных проекта, допустимого состояния нет; этап «${STAGE_RU[stage]}» не запущен (верни набор или убери profile_set из файла проекта)` }
  const u = state.usable
  if (!u) return undefined
  const set = u.data.sets?.[u.name]
  const eff = effectiveCell(set, stage, u.data.profiles)
  if (!eff) return undefined
  const cell = eff.cell
  const front = stage === "develop" || stage === "plan"
  let tier: PTier
  if (front) tier = (!opts.autoPlan && isPTier(opts.inputTier) ? opts.inputTier : cell.tier === "task" ? "medium" : cell.tier) as PTier
  else tier = (cell.tier === "task" ? (isPTier(opts.taskTier) ? opts.taskTier : "medium") : cell.tier) as PTier
  if (eff.lower) tier = lowerTier(tier) as PTier
  const cl = clampTier(tier, state.bounds)
  tier = cl.tier
  const p: any = isObj(u.data.profiles) ? (u.data.profiles as any)[cell.family]?.[tier] : undefined
  const cause = cl.from ? ` (ступень ${cl.from} срезана границами проекта tier_min/tier_max до ${tier}: добавь профиль ${cell.family}/${tier} или поправь границы)` : ""
  if (!isObj(p)) return { refuse: `набор «${u.name}», этап «${STAGE_RU[stage]}»: профиля ${cell.family}/${tier} нет в справочнике${cause}; сессия не запущена` }
  if (isEmptyProfile(p)) return { refuse: `набор «${u.name}», этап «${STAGE_RU[stage]}»: профиль ${cell.family}/${tier} пуст («заполнить»)${cause}; сессия не запущена` }
  return { model: modelWithVariant(p), family: cell.family, tier, set: u.name, viaSnapshot: u.viaSnapshot, window: front && !state.degraded, stage, ...(cl.from ? { clampedFrom: cl.from } : {}), ...(eff.how === "inherited" ? { how: "inherited" as const } : {}) }
}

/** Годится ли открытая вкладка в приёмщики по клетке: явная ступень — только семья клетки; `task` модель вкладки не проверяет. */
export function tabFitsCell(cell: Cell | undefined, tabModel: string | undefined, profiles: Families | undefined): boolean {
  if (!cell || cell.tier === "task") return true
  return familyOfModel(tabModel, profiles) === cell.family
}

/** Клетка этапа в наборе, по которому идут сессии (действующие данные или снимок); undefined — набора или клетки нет. */
export function cellOfState(state: State | undefined, stage: Stage): Cell | undefined {
  const u = state && state.row !== 6 ? state.usable : undefined
  const set = u ? u.data.sets?.[u.name] : undefined
  return u ? effectiveCell(set, stage, u.data.profiles)?.cell : undefined
}
