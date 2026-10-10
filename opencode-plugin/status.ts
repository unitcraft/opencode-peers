// СОСТОЯНИЕ СЕССИЙ (план 003, 2026-10-05): кто чего ждёт — для владельца (сводка /crew, уведомление «ждёт вас») и
// для внешних проверок (хук проекта читает status/<сессия>.json — открытый контракт, README «Session status»).
//
// Случай владельца 2026-10-05: вопрос интегратора дважды висел незамеченным (окно прокручено вверх), а что работают
// три воркера, владелец узнал случайно. Состояние выводится из данных плагина, без проектного текста: идёт ход;
// ждёт наблюдения (crew_watch); ждёт ответа на свой вопрос; своя задача сдана / на доработке; ждёт своих задач;
// ход кончился вопросом — ждёт владельца. Последнее — общий признак любой модели: ответ кончается вопросом (строка
// с «?» в конце среди последних строк ответа), владелец после этого не писал, и это вкладка владельца, а не сессия
// задачи (её ведёт интегратор).

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { type Card, readJson, safeKey } from "./core.ts"
import { BASE } from "./paths.ts"
import { answerLines, answerSideRow } from "./answer.ts"
import { lockWaitLine } from "./review.ts"
import { type Task, isOpen, listTasks, loadTask } from "./tasks.ts"
import { type Watch, watchesOf } from "./watch.ts"

export const STATUS = path.join(BASE, "status")

export type State = "working" | "owner" | "question" | "watch" | "reply" | "task" | "tasks" | "idle"
export type Status = {
  session: string
  project?: string
  role: string
  title: string
  model?: string
  state: State
  since?: number
  /** Одна строка по-русски: что делает или чего ждёт. */
  detail: string
  /** Вопрос владельцу (state owner): последние строки ответа. */
  question?: string
  watches: { id: string; note?: string; started?: number; minutes: number }[]
  asked: { qid: string; to: string; at: number }[]
  /** Своя задача (исполнитель или приёмщик). */
  task?: { n: number; status: string; as: "executor" | "reviewer"; title: string; steps?: StepView[]; checking?: string }
  /** Открытые задачи, поставленные этой сессией. */
  tasks: { n: number; status: string; priority: string; title: string }[]
  /** Когда владельцу последний раз показали «ждёт вас» (повтор по owner_reminder_min). */
  notified?: number
  updated: number
}

/** Шаг приёмки задачи в окне: result — итог (шаг пройден), без него — ещё нет. */
export type StepView = { id: string; text: string; result?: string }
const stepsOf = (t: Task): StepView[] | undefined => t.steps?.length ? t.steps.map((a) => ({ id: a.id, text: a.text, ...(t.checks?.[a.id] ? { result: t.checks[a.id] } : {}) })) : undefined
/** «проверка 3/13: fixture» — шаг, который приёмщик проверяет сейчас, или «шаги 5/13», когда между шагами. */
export function stepProgress(task: Status["task"]): string | undefined {
  if (!task?.steps?.length || !["reviewing", "accepted"].includes(task.status)) return undefined
  const total = task.steps.length
  const i = task.checking ? task.steps.findIndex((a) => a.id === task.checking) : -1
  if (i >= 0 && !task.steps[i].result) return `проверка ${i + 1}/${total}: ${task.checking}`
  return `шаги ${task.steps.filter((a) => a.result).length}/${total}`
}

/**
 * Фразы ожидания слова владельца без знака «?» («жду вашего разрешения», «awaiting your GO»). ЕДИНЫЙ перечень: расширяется по
 * реальным примерам. Форма: глагол ожидания, рядом (до 60 знаков, в пределах предложения) слово о владельце или решении.
 * Отрицание перед глаголом («не жду», «ни», «not», «no need for») не срабатывает; прошедшее («ждал») глаголом не считается.
 */
export const WAITING_PHRASES: RegExp[] = [
  /(?<![а-яё])(?<!не\s)(?<!ни\s)(?:жду|ждёт|ждем|ждём|ожидаю|ожидает|ожидаем)(?![а-яё])(?:(?!\sбез\s)[^.!?\n,;:]){0,60}?(?<![а-яё])(?:вашего|владельц|разрешени|слова|решени|согласи|подтвержден|GO(?![а-яё\w]))/i,
  /(?<![a-z])(?<!not\s)(?<!n't\s)(?<!no\s)(?:awaiting|waiting for|needs?)(?![a-z])(?:(?!\swithout\s)[^.!?\n,;:]){0,60}?(?<![a-z])(?:your|owner)(?![a-z])[^.!?\n,;:]{0,40}?(?<![a-z])(?:GO|approval|decision|confirmation|permission)(?![a-z])/i,
  /(?<![а-яё])пока не получу(?![а-яё])[^.!?\n]{0,60}?(?<![а-яё])(?:разрешени|слов|решени|подтвержден|GO(?![а-яё\w]))/i,
  /(?<![а-яё])(?<!не\s)(?:просит|просим|запрашивает)(?![а-яё])[^.!?\n,;:]{0,60}?(?<![а-яё])(?:разрешени|согласи|GO(?![а-яё\w]))/i,
]

/** Ответ кончается вопросом или фразой ожидания слова владельца: такая строка среди последних трёх непустых (за ней бывает подпись). */
export function endsWithQuestion(text: string): string | undefined {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean)
  const tail = lines.slice(-3)
  const i = tail.map((l) => /\?[)»"*_`]*$/.test(l) || WAITING_PHRASES.some((r) => r.test(l))).lastIndexOf(true)
  if (i < 0) return undefined
  return tail[i].length > 300 ? `${tail[i].slice(0, 300)}…` : tail[i]
}

const hm = (t?: number) => (t ? new Date(t).toTimeString().slice(0, 5) : "?")
const minutes = (from: number | undefined, now: number) => (from ? `${Math.max(0, Math.round((now - from) / 60_000))} мин` : "")
const STATUS_RU: Record<string, string> = { starting: "запускается", running: "в работе", submitted: "сдана", reviewing: "на приёмке", rework: "на доработке", accepted: "принята", cleaned: "влита", closed: "закрыта", cancelled: "отменена" }

export type StatusInput = {
  card: Card
  busy: boolean
  busySince?: number
  end?: { at: number; text: string; ownerAfter: boolean }
  /** Вопросы этой сессии, на которые ещё нет ответа (обязательства других перед ней). */
  asked: { qid: string; to: string; at: number }[]
  now: number
  /** наблюдения сессии, прочитанные проходом один раз на всех (иначе — читаются здесь) */
  watches?: Watch[]
  /** окно считает ход идущим, а сервер свободен с этого времени (core.ts staleBusy) */
  staleSince?: number
}

/** Состояние одной сессии из её данных. Порядок важности: ход > вопрос владельцу > наблюдение > ответ > задачи. */
export function statusOf(x: StatusInput): Status {
  const { card, now } = x
  const watches: Watch[] = x.watches ?? watchesOf(card.session)
  const ref = card.task ?? card.review
  const own: Task | undefined = ref ? loadTask(ref.project, ref.n) : undefined
  const authored = listTasks(card.project).filter((t) => t.author === card.session && isOpen(t))
  const base: Status = {
    session: card.session,
    project: card.project,
    role: card.role,
    title: card.titleShown ?? card.title,
    model: card.model,
    state: "idle",
    detail: "свободна",
    watches: watches.map((w) => ({ id: w.id, note: w.note, started: w.started, minutes: w.minutes })),
    asked: x.asked,
    ...(own ? { task: { n: own.n, status: own.status, as: card.task ? ("executor" as const) : ("reviewer" as const), title: own.title, ...(stepsOf(own) ? { steps: stepsOf(own) } : {}), ...(own.checking ? { checking: own.checking.step } : {}) } } : {}),
    tasks: authored.map((t) => ({ n: t.n, status: t.status, priority: t.priority, title: t.title })),
    updated: now,
  }
  if (x.staleSince) {
    const q = `окно считает ход идущим, а сервер свободен с ${hm(x.staleSince)}: сообщение, видимо, не дошло — нажмите Esc в окне и отправьте его снова`
    return { ...base, state: "owner", since: x.staleSince, question: q, detail: q }
  }
  if (x.busy) return { ...base, state: "working", since: x.busySince, detail: `работает${x.busySince ? ` (${minutes(x.busySince, now)})` : ""}` }
  // сессию задачи ведёт интегратор, и её вопрос в конце хода бывает ему (сдавший воркер спросил интегратора), а бывает
  // владельцу (приёмщик просил «вливай?»): кому — по тексту не определить. Поэтому у сессии задачи — «question»: видно
  // в /crew, но без уведомления; «owner» с уведомлением — только у вкладок владельца.
  const q = x.end && !x.end.ownerAfter ? endsWithQuestion(x.end.text) : undefined
  if (q && !card.spawned) return { ...base, state: "owner", since: x.end!.at, question: q, detail: `ждёт вас с ${hm(x.end!.at)}: ${q}` }
  if (q) return { ...base, state: "question", since: x.end!.at, question: q, detail: `ждёт ответа (интегратора или вас) с ${hm(x.end!.at)}: ${q}` }
  if (watches.length) {
    const w = watches[0]
    const queued = w.status === "requested" && w.machine ? `в очереди машины с ${hm(w.created)}` : `с ${hm(w.started ?? w.created)}, предел ${w.minutes} мин`
    return { ...base, state: "watch", since: w.started ?? w.created, detail: `ждёт наблюдения${w.note ? ` «${w.note}»` : ""} (${queued})${watches.length > 1 ? ` и ещё ${watches.length - 1}` : ""}` }
  }
  if (x.asked.length) return { ...base, state: "reply", since: x.asked[0].at, detail: `ждёт ответа от ${x.asked.map((a) => a.to).join(", ")} (с ${hm(x.asked[0].at)})` }
  if (own && isOpen(own)) {
    const s = own.status
    const what = card.task
      ? s === "submitted" || s === "reviewing" || s === "accepted"
        ? `#${own.n} сдана, ${STATUS_RU[s]}`
        : s === "rework"
          ? `#${own.n} на доработке — стоит`
          : `#${own.n} ${STATUS_RU[s] ?? s} — стоит между ходами`
      : s === "rework"
        ? `приёмка #${own.n}: ждёт доработки`
        : `приёмка #${own.n}: ${STATUS_RU[s] ?? s}`
    return { ...base, state: "task", detail: what }
  }
  if (authored.length) {
    const by = (st: string[]) => authored.filter((t) => st.includes(t.status)).map((t) => `#${t.n}`)
    const parts = [
      [by(["starting", "running"]), "в работе"],
      [by(["rework"]), "на доработке"],
      [by(["submitted", "reviewing", "accepted"]), "на приёмке"],
    ]
      .filter(([l]) => (l as string[]).length)
      .map(([l, w]) => `${(l as string[]).join(" ")} ${w}`)
    return { ...base, state: "tasks", detail: `ждёт своих задач: ${parts.join("; ")}` }
  }
  return base
}

const comparable = (s: Status) => JSON.stringify({ ...s, updated: 0 })

/** Записать состояние, если оно изменилось; notified переносится из прежнего. Возвращает прежнее. */
export function saveStatus(s: Status): Status | undefined {
  mkdirSync(STATUS, { recursive: true })
  const file = path.join(STATUS, `${safeKey(s.session)}.json`)
  const prev = readJson<Status>(file)
  const next: Status = prev?.notified && s.state === "owner" && prev.state === "owner" && prev.since === s.since ? { ...s, notified: prev.notified } : s
  if (prev && comparable(prev) === comparable(next)) return prev
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 1))
  renameSync(`${file}.tmp`, file)
  return prev
}

export function removeStatus(session: string) {
  rmSync(path.join(STATUS, `${safeKey(session)}.json`), { force: true })
}

export function markNotified(session: string, at: number) {
  const file = path.join(STATUS, `${safeKey(session)}.json`)
  const s = readJson<Status>(file)
  if (!s) return
  s.notified = at
  writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 1))
  renameSync(`${file}.tmp`, file)
}

export function readStatuses(): Status[] {
  if (!existsSync(STATUS)) return []
  return readdirSync(STATUS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Status>(path.join(STATUS, f)))
    .filter((s): s is Status => !!s)
}

const ORDER: Record<State, number> = { owner: 0, question: 1, working: 2, watch: 3, reply: 4, task: 5, tasks: 6, idle: 7 }

/** Ширина строки окна /crew (диалог OpenCode ~74 знака): длиннее — перенос, и список рвётся (владелец 2026-10-07:
 *  «выглядит некрасиво»). Строка обрезается с «…». */
export const DIALOG_WIDTH = 72
const fit = (line: string, n = DIALOG_WIDTH) => (line.length > n ? `${line.slice(0, n - 1)}…` : line)
/** Шаги приёмки одной строкой: ✓ отмечен, ▶ идёт, · впереди (– не отмечен в отчёте). */
export const stepBar = (steps: { id: string; result?: string }[], checking?: string) => steps.map((a) => (a.result ? "✓" : a.id === checking ? "▶" : "·")).join("")

/** Текст сводки /crew: проекты (свой первым), в проекте — сначала ждущие владельца. */
export function formatStatuses(list: Status[], now = Date.now(), first?: string): string {
  if (!list.length) return "Сессий проекта не видно: плагин сервиса ещё не записал состояние (status/)."
  const byProject = new Map<string, Status[]>()
  for (const s of list) byProject.set(s.project ?? "?", [...(byProject.get(s.project ?? "?") ?? []), s])
  const names = [...byProject.keys()].sort((a, b) => (a === first ? -1 : b === first ? 1 : a.localeCompare(b)))
  const out: string[] = []
  for (const p of names) {
    const items = byProject.get(p)!.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.title.localeCompare(b.title))
    const waiting = items.filter((s) => s.state === "owner").length
    out.push(`${p}${waiting ? ` — ВАС ЖДУТ: ${waiting}` : ""}`)
    for (const s of items) {
      const who = s.task ? s.title : `${s.role}${s.title && s.title !== s.session ? ` · ${s.title}` : ""}`
      const model = s.model ? ` [${s.model.replace(/^.*\//, "")}]` : ""
      const prog = s.task?.as === "reviewer" ? stepProgress(s.task) : undefined
      // вопрос владельцу — целиком (его и читают), остальное — строкой по ширине окна
      const row = `  ${s.state === "owner" ? "▶ " : ""}${short(who, 40)}${model} — ${s.detail}`
      out.push(s.state === "owner" ? row : fit(row))
      if (prog) {
        const steps = s.task!.steps!
        const cur = steps.find((a) => a.id === s.task!.checking && !a.result)
        out.push(fit(`      шаги ${steps.filter((a) => a.result).length}/${steps.length} ${stepBar(steps, s.task!.checking)}`))
        if (cur) out.push(fit(`      ▶ ${cur.id}: ${short(cur.text, 120)}`))
      }
    }
    out.push(...planLines(p))
    out.push(...acceptanceReports(p, now))
    out.push(...answerLines(p, now))
    const lw = lockWaitLine(p, now)
    if (lw) out.push(`  ${lw}`)
  }
  out.push(`(${hm(now)}; обновляется раз в несколько секунд)`)
  return out.join("\n")
}

const short = (x: string, n: number) => {
  const one = x.replace(/\s+/g, " ").trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}
/** Планы проекта для /crew (план 004): на перепроверке, на согласовании, в работе — с ходом шагов. */
export function planLines(project: string): string[] {
  let list: Task[] = []
  try {
    list = listTasks(project).filter((t) => t.plan && !(t.status === "cleaned" && t.plan.finished) && t.status !== "cancelled")
  } catch {}
  const out: string[] = []
  for (const t of list) {
    const p = t.plan!
    const last = p.rounds.at(-1)
    const r = p.rounds.length
    const state =
      t.status === "starting" || t.status === "running"
        ? `пишется (задача #${t.n})`
        : t.status === "submitted" || t.status === "reviewing"
          ? p.approval && p.approval.decision !== "no"
            ? "согласован владельцем — вливается"
            : `перепроверка: раунд ${r + 1}, чистых подряд ${p.clean}`
          : t.status === "rework"
            ? `доработка после ${p.approval?.decision === "no" ? "замечаний владельца" : `раунда ${r}${last ? ` (${last.line?.replace(/^раунд \d+, [\d-]+ — /, "") ?? `блокирующих ${last.blocking}, существенных ${last.significant}`})` : ""}`}`
            : t.status === "approval"
              ? `◇ ждёт вашего согласования${p.stuck ? " (раунды кончились)" : ""} — /plans`
              : t.status === "accepted"
                ? "влит, очистка"
                : (() => {
                    const ids = Object.entries(p.spawned ?? {})
                    const closed = ids.filter(([, n]) => ["cleaned", "closed"].includes(loadTask(project, n)?.status ?? "")).length
                    const going = ids.filter(([, n]) => { const x = loadTask(project, n); return !!x && isOpen(x) }).map(([id]) => id)
                    return `в работе: шаги ${closed}/${p.total ?? "?"}${going.length ? `, идут ${going.join(", ")}` : ""}`
                  })()
    out.push(fit(`  план ${p.n} «${short(t.title.replace(/^план \S+: /, ""), 30)}» — ${state}`, DIALOG_WIDTH - 2))
  }
  return out.length ? ["  планы:", ...out.map((l) => `  ${l}`)] : []
}

const REPORT_MS = 24 * 3_600_000
/** Отчёты приёмки за сутки: задачи, принятые с шагами, — каждый шаг с тем, чем подтверждён (владелец: «+ отчёт в конце»). */
export function acceptanceReports(project: string, now = Date.now()): string[] {
  let done: Task[] = []
  try {
    done = listTasks(project).filter((t) => ["accepted", "cleaned"].includes(t.status) && t.checks && now - t.updated < REPORT_MS)
  } catch {}
  const out: string[] = []
  for (const t of done.sort((a, b) => b.updated - a.updated).slice(0, 3)) {
    const ids = t.steps?.length ? t.steps.map((a) => a.id) : Object.keys(t.checks!)
    const ok = ids.filter((id) => t.checks![id]).length
    out.push(fit(`  отчёт приёмки #${t.n} «${short(t.title, 30)}» — ${t.status === "cleaned" ? "влита" : "принята"} ${hm(t.updated)}`))
    out.push(fit(`      шаги ${ok}/${ids.length} ${ids.map((id) => (t.checks![id] ? "✓" : "–")).join("")}`))
    const skipped = ids.filter((id) => !t.checks![id])
    if (skipped.length) out.push(fit(`      – не отмечены (необязательные): ${skipped.join(", ")}`))
  }
  return out
}

// БОКОВАЯ ПАНЕЛЬ ОКНА (план 003.2, 2026-10-06; владелец: «в этой области можно выводить активные сессии и обновлять в
// реальном времени?»). Строки блока «Crew» под «Context»: кто чего ждёт в проекте вкладки на экране, ждущие владельца
// первыми. Чистая функция — рисует sidebar.tsx, проверяет тест.
export type SideRow = { mark: string; who: string; what: string; tone: "accent" | "base" | "muted" }
/** Строка панели как она печатается (ширина панели ~32 знака: длиннее — перенос, и список выглядит разрезанным).
 *  Подстрока (who пустой) — с отступом под «что», без колонки «кто». */
export const SIDE_WIDTH = 32
export const sideText = (r: SideRow) => (r.who ? `${r.mark} ${r.who.padEnd(9).slice(0, 9)} ${r.what}` : `    ${r.what}`).slice(0, SIDE_WIDTH)
const WORD_OF_TASK: Record<string, string> = { submitted: "✓ сдана", reviewing: "✓◐ приёмка", rework: "↻ доработка", approval: "◇ согласование", accepted: "✓✓◐ влита", running: "в работе", starting: "запуск" }
const SIDE_MAX = 9
/** «что» ждущей вкладки с длительностью ожидания: «⧗ CI t34 40м» (длительность — в конце, обрезается текст перед ней). */
export function waitText(text: string, since: number | undefined, now: number): string {
  if (!since) return text
  const dur = ` ${Math.max(0, Math.round((now - since) / 60_000))}м`
  return `${short(text, 20 - dur.length)}${dur}`
}
export function sidebarLines(list: Status[], now = Date.now(), project?: string): { title: string; rows: SideRow[]; foot: string } {
  const mine = project ? list.filter((s) => (s.project ?? "?") === project) : list
  // панель узкая (~32 знака): кто — до 9 знаков, что — до 20, иначе строка переносится
  const who = (s: Status) => (s.task ? `#${s.task.n} ${s.task.as === "reviewer" ? "прм" : "исп"}` : s.role === "integrator" ? "интегр." : s.role.slice(0, 9))
  const what = (s: Status): string => {
    switch (s.state) {
      case "owner":
        return `ждёт вас ${hm(s.since)}`
      case "question":
        return "вопрос — ждёт ответа"
      case "working":
        return s.since ? `работает ${minutes(s.since, now)}` : "работает"
      case "watch":
        return s.watches[0] && !s.watches[0].started ? `⧗ очередь: ${s.watches[0].note ?? "машина"}` : `⧗ ${s.watches[0]?.note ?? "наблюдение"}`
      case "reply":
        return `ждёт ответа от ${s.asked[0]?.to ?? "?"}`
      case "task":
        return s.task ? (WORD_OF_TASK[s.task.status] ?? s.task.status) : "задача"
      case "tasks":
        return `ждёт задач (${s.tasks.length})`
      default:
        return "свободна"
    }
  }
  const sorted = mine.slice().sort((a, b) => ORDER[a.state] - ORDER[b.state] || who(a).localeCompare(who(b)))
  const rows: SideRow[] = []
  for (const s of sorted.slice(0, SIDE_MAX)) {
    // приёмка по шагам: «проверка 3/13: fixture» вместо «работает», под строкой — что проверяет шаг
    // ждущая вкладка (наблюдение, очередь машины, ответ) показывает, чего ждёт, и сколько; шаги — строкой под ней
    const stepsLine = s.state !== "owner" && s.state !== "question" ? stepProgress(s.task) : undefined
    const waiting = s.state === "watch" || s.state === "reply"
    const prog = waiting ? undefined : stepsLine
    const waitFor = waiting ? waitText(what(s), s.since, now) : undefined
    rows.push({
      mark: s.state === "owner" ? "▶" : s.state === "question" ? "?" : s.state === "working" ? "•" : " ",
      who: who(s),
      what: short(prog ?? waitFor ?? what(s), 20),
      tone: (s.state === "owner" || s.state === "question" ? "accent" : s.state === "idle" ? "muted" : "base") as SideRow["tone"],
    })
    const cur = s.task?.as === "reviewer" && prog?.startsWith("проверка") ? s.task.steps!.find((a) => a.id === s.task!.checking) : undefined
    if (cur) rows.push({ mark: " ", who: "", what: `↳ ${short(cur.text.replace(/[`*_]/g, ""), 26)}`, tone: "muted" })
    if (waiting && stepsLine) rows.push({ mark: " ", who: "", what: `↳ ${stepsLine}`, tone: "muted" })
    // название задачи — по номеру не вспомнить, о чём она (владелец, 2026-10-07); последней подстрокой, чтобы строки шагов остались на своих местах
    if (s.task?.title) rows.push({ mark: " ", who: "", what: `↳ ${short(s.task.title.replace(/[`*_«»]/g, ""), 26)}`, tone: "muted" })
  }
  const auto = answerSideRow(project, now)
  if (auto) rows.push(auto)
  const lw = project ? lockWaitLine(project, now) : undefined
  if (lw) rows.push({ mark: " ", who: "", what: lw.replace(/ мин\)/g, "м)"), tone: "accent" })
  const waiting = mine.filter((s) => s.state === "owner").length
  // «ход» — модель думает сейчас; «ждут» — наблюдения (гейты, коммит в main), из них в очереди машины — ещё не запущены
  const working = mine.filter((s) => s.state === "working").length
  const watching = mine.filter((s) => s.state === "watch").length
  const queued = mine.filter((s) => s.state === "watch" && s.watches[0] && !s.watches[0].started).length
  const more = sorted.length > SIDE_MAX ? ` · +${sorted.length - SIDE_MAX}` : ""
  return { title: `Crew${project ? ` · ${project}` : ""}${waiting ? ` — ждут вас: ${waiting}` : ""}`, rows, foot: `ход ${working} · ждут ${watching}${queued ? ` (очередь ${queued})` : ""}${more} · /crew` }
}

/** Текст /crew-doctor: последняя самопроверка сервиса (DOCTOR_FILE) и её время. */
export function doctorText(d: { at: number; problems: string[] } | undefined, now = Date.now()): string {
  if (!d?.at) return "Самопроверки ещё не было: сервис делает её через 10 с после запуска плагина и раз в 10 минут."
  const when = `проверено в ${hm(d.at)} (${minutes(d.at, now) || "0 мин"} назад)`
  if (!d.problems?.length) return `Всё в порядке: окна отмечаются, ящик пишется, настройки проектов читаются, нужные возможности OpenCode на месте.\n\n${when}`
  return `Есть проблемы:\n${d.problems.map((p) => `- ${p}`).join("\n")}\n\n${when}`
}
