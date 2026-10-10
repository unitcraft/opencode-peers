// УБОРКА ДАННЫХ ПЛАГИНА (задача 025, владелец 2026-10-11: «плагин генерит много файлов, количество которых постоянно растёт»).
// Раз в сутки, по retention_days (умолчание 7; 0 — не убирать): доставленные письма read/ старше срока (id остаётся в .ids,
// повторов нет), пустые папки сессий в read/ и inbox/, карточки cards/ и записи status/ закрытых вкладок. НИКОГДА не
// трогает: письмо с открытым вопросом (qid в обязательствах или открытых задачах), inbox/ (недоставленное), карточку и
// статус открытой вкладки, вкладки с обязательствами или открытой задачей, tasks/. Проход ограничен числом удалений за вызов
// (образец — purgeOld в answer.ts); не дошёл до конца — метка не пишется, следующий вызов продолжает.
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BASE, CARDS, INBOX, OBLIGATIONS, READ, liveWindows, mayWakeCard, readJson, safeKey, type Card, type Obligation } from "./core.ts"
import { IDS_FILE, sweepRead } from "./housekeeping.ts"
import { STATUS, type Status } from "./status.ts"
import { isOpen, listTasks } from "./tasks.ts"

const DAY = 86_400_000
const STAMP = path.join(BASE, "retention.stamp")
/** Сколько файлов проход удаляет за один вызов: первая уборка после долгого простоя не должна держать главный поток службы. */
export const RETENTION_BATCH = 200

export type RetentionResult = { letters: number; dirs: number; cards: number; done: boolean }

const ageOf = (file: string, now: number) => {
  try {
    return now - statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** Один проход; undefined — выключен (days не больше 0) или с прошлого прохода не прошли сутки. */
export function runRetention(days: number, now = Date.now(), batch = RETENTION_BATCH): RetentionResult | undefined {
  if (!(days > 0)) return undefined
  try {
    if (now - Number(readFileSync(STAMP, "utf8")) < DAY) return undefined
  } catch {}
  const keepMs = days * DAY
  const tasks = listTasks().filter((t) => isOpen(t))
  const openQids = new Set<string>()
  const busyKeys = new Set<string>()
  for (const t of tasks) {
    for (const q of [t.qid, t.review_qid]) if (q) openQids.add(q)
    for (const s of [t.author, t.executor, t.reviewer]) if (s) busyKeys.add(safeKey(s))
  }
  try {
    for (const f of readdirSync(OBLIGATIONS).filter((f) => f.endsWith(".json"))) {
      const list = readJson<Obligation[]>(path.join(OBLIGATIONS, f)) ?? []
      for (const o of list) openQids.add(o.qid)
      if (list.length) busyKeys.add(f.slice(0, -5)) // имя файла уже safeKey сессии
    }
  } catch {}
  const out: RetentionResult = { letters: 0, dirs: 0, cards: 0, done: true }
  let budget = batch

  // 1. письма read/: старые доставленные; письмо с открытым вопросом остаётся
  const keepLetter = (file: string) => {
    const q = readJson<{ qid?: string }>(file)?.qid
    return !!q && openQids.has(q)
  }
  out.letters = sweepRead(READ, keepMs, now, keepLetter, budget)
  budget -= out.letters
  if (budget <= 0) out.done = false

  // 2. пустые папки сессий: read/ (и с одним только давним .ids), inbox/
  for (const [root, isRead] of [[READ, true], [INBOX, false]] as const) {
    let names: string[] = []
    try {
      names = readdirSync(root)
    } catch {}
    for (const n of names) {
      if (budget <= 0) {
        out.done = false
        break
      }
      const dir = path.join(root, n)
      try {
        const left = readdirSync(dir)
        const idsOnly = isRead && left.length === 1 && left[0] === IDS_FILE && ageOf(path.join(dir, IDS_FILE), now) > 30 * DAY
        if (left.length && !idsOnly) continue
        if (idsOnly) rmSync(path.join(dir, IDS_FILE), { force: true })
        rmdirSync(dir)
        out.dirs++
        budget--
      } catch {}
    }
  }

  // 3. карточки и статусы закрытых вкладок: старше срока, не открыта, без обязательств и открытых задач
  const windows = liveWindows(now)
  const stale = (session: string, file: string, stamp: number) => now - (stamp || 0) > keepMs && ageOf(file, now) > keepMs && !busyKeys.has(safeKey(session))
  let cardFiles: string[] = []
  try {
    cardFiles = readdirSync(CARDS)
  } catch {}
  for (const f of cardFiles) {
    if (budget <= 0) {
      out.done = false
      break
    }
    const file = path.join(CARDS, f)
    const c = readJson<Card>(file)
    if (!c?.session || !stale(c.session, file, c.updated) || mayWakeCard(c, windows)) continue
    rmSync(file, { force: true })
    rmSync(path.join(STATUS, `${safeKey(c.session)}.json`), { force: true })
    out.cards++
    budget--
  }
  // статус без карточки (осиротевший) старше срока — тоже вон; пока карточка есть, статус держит она
  let statusFiles: string[] = []
  try {
    statusFiles = readdirSync(STATUS)
  } catch {}
  for (const f of statusFiles) {
    if (budget <= 0) {
      out.done = false
      break
    }
    const file = path.join(STATUS, f)
    const s = readJson<Status>(file)
    if (!s?.session || !stale(s.session, file, s.updated) || existsSync(path.join(CARDS, `${safeKey(s.session)}.json`))) continue
    rmSync(file, { force: true })
    budget--
  }
  if (out.done) {
    try {
      writeFileSync(STAMP, String(now))
    } catch {}
  }
  return out
}
