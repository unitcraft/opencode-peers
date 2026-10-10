// УБОРКА (2026-10-06). Владелец: «разберись с количеством файлов, которые неограниченно генерит плагин». Прочитанные
// письма (read/) копились без предела — 1127 файлов за сутки; общий журнал рос без предела (6,8 МБ). Письма в read/
// нельзя просто стереть: по ним плагин узнаёт, что письмо с постоянным id уже было (иначе повтор). Поэтому старое
// письмо удаляется, а его id остаётся строкой в read/<ящик>/.ids — повторов нет, места почти не занимает.
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

export const IDS_FILE = ".ids"
const IDS_KEEP_MS = 30 * 24 * 3_600_000 // id старше 30 дней — из списка тоже вон (письма с такими id давно не ждут)
const IDS_TRIM_BYTES = 1_000_000

/** Прочитанные письма старше keepMs: id — в .ids ящика, файл — удалить. Возвращает число удалённых. keep — письмо оставить
 *  (неотвеченный вопрос); limit — не больше стольких удалений за вызов (остальное — со следующего). */
export function sweepRead(readDir: string, keepMs: number, now = Date.now(), keep?: (file: string) => boolean, limit = Infinity): number {
  if (!existsSync(readDir) || !(keepMs > 0)) return 0
  let removed = 0
  for (const key of readdirSync(readDir)) {
    if (removed >= limit) break
    const dir = path.join(readDir, key)
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"))
    } catch {
      continue
    }
    const old: string[] = []
    for (const f of files) {
      try {
        const file = path.join(dir, f)
        if (now - statSync(file).mtimeMs > keepMs && !keep?.(file)) old.push(f)
      } catch {}
    }
    if (old.length > limit - removed) old.length = limit - removed
    if (!old.length) continue
    const idsFile = path.join(dir, IDS_FILE)
    appendFileSync(idsFile, old.map((f) => `${f.slice(0, -5)}\t${now}\n`).join(""))
    for (const f of old) {
      try {
        rmSync(path.join(dir, f), { force: true })
        removed++
      } catch {}
    }
    trimIds(idsFile, now)
  }
  return removed
}

function trimIds(idsFile: string, now: number) {
  try {
    if (statSync(idsFile).size < IDS_TRIM_BYTES) return
    const keep = readFileSync(idsFile, "utf8")
      .split("\n")
      .filter((l) => l && now - Number(l.split("\t")[1] ?? 0) < IDS_KEEP_MS)
    writeFileSync(`${idsFile}.tmp`, keep.length ? `${keep.join("\n")}\n` : "")
    renameSync(`${idsFile}.tmp`, idsFile)
  } catch {}
}

// чтение .ids — с кэшем по времени изменения файла (letterExists зовут часто)
const idsCache = new Map<string, { mtime: number; ids: Set<string> }>()
/** Было ли письмо с этим id в ящике (удалённое уборкой). */
export function idsHas(readKeyDir: string, id: string): boolean {
  const f = path.join(readKeyDir, IDS_FILE)
  let mtime: number
  try {
    mtime = statSync(f).mtimeMs
  } catch {
    return false
  }
  let hit = idsCache.get(f)
  if (!hit || hit.mtime !== mtime) {
    const ids = new Set(readFileSync(f, "utf8").split("\n").map((l) => l.split("\t")[0]).filter(Boolean))
    hit = { mtime, ids }
    idsCache.set(f, hit)
  }
  return hit.ids.has(id)
}

/** Журнал больше maxBytes — в .1 (одна прежняя копия), пишется заново. */
export function rotateLog(file: string, maxBytes: number): boolean {
  try {
    if (statSync(file).size <= maxBytes) return false
    rmSync(`${file}.1`, { force: true })
    renameSync(file, `${file}.1`)
    return true
  } catch {
    return false
  }
}
