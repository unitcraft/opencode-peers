// РАСХОЖДЕНИЕ НАСТРОЕК (задача 029, 2026-10-11): плагин читает .opencode/crew-harness.json с целевой ветки, а файл в рабочей
// копии до коммита не действует. Здесь файл рабочей копии сравнивается с веткой по верхнеуровневым ключам; результат
// кешируется на несколько секунд (git не на каждый вызов), как в acceptance-file.ts. «Рабочая копия» — папка настроек
// проекта из реестра проектов (Project.repo + Project.file): та, что правит crew_config set.
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { BASE } from "./paths.ts"

export type Divergence = { kind: "same" } | { kind: "differ"; keys: string[]; ref: string } | { kind: "note"; text: string }

const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
const parse = (t: string): any => {
  try {
    const j = JSON.parse(t.replace(/^\uFEFF/, ""))
    return j && typeof j === "object" && !Array.isArray(j) ? j : null
  } catch {
    return null
  }
}

/** Различающиеся верхнеуровневые ключи двух настроек (по глубокому равенству значений), по алфавиту. */
export function differingKeys(a: Record<string, any>, b: Record<string, any>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort()
}

const cache = new Map<string, { at: number; value: Divergence }>()
const ttl = () => (process.env.CREW_HARNESS_DIVERGE_TTL_MS !== undefined ? Number(process.env.CREW_HARNESS_DIVERGE_TTL_MS) : 5_000)

/** Сравнить файл рабочей копии (repo/file) с файлом целевой ветки (origin/<ветка>, затем локальная). Не падает. */
export function configDivergence(repo: string | undefined, file: string | undefined, branch: string | undefined): Divergence {
  if (!repo || !file || !branch) return { kind: "note", text: "рабочая копия не в git-репозитории: расхождение с веткой не проверено" }
  const key = `${repo}\0${file}\0${branch}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttl()) return hit.value
  const value = compute(repo, file, branch)
  cache.set(key, { at: Date.now(), value })
  return value
}

function compute(repo: string, file: string, branch: string): Divergence {
  const abs = path.join(repo, file)
  if (!existsSync(abs)) return { kind: "note", text: `файла ${file} нет в рабочей копии: сравнивать не с чем` }
  const work = parse(readFileSync(abs, "utf8"))
  if (!work) return { kind: "note", text: `${file} в рабочей копии не JSON: расхождение с веткой не проверено` }
  for (const ref of [`origin/${branch}`, branch]) {
    let text: string
    try {
      text = git(repo, ["show", `${ref}:${file}`])
    } catch {
      continue
    }
    const there = parse(text)
    if (!there) return { kind: "note", text: `${file} на ${ref} не JSON: расхождение не проверено` }
    const keys = differingKeys(work, there)
    return keys.length ? { kind: "differ", keys, ref } : { kind: "same" }
  }
  return { kind: "note", text: `файла ${file} нет на ветке ${branch} (или ветки нет): действуют настройки по умолчанию; расхождение не проверено` }
}

/** Предупреждение crew_doctor по проекту; нет расхождения — undefined. */
export function divergenceProblem(name: string, d: Divergence): string | undefined {
  if (d.kind === "differ") return `проект ${name}: настройки в рабочей копии отличаются от целевой ветки: действуют те, что на ветке (${d.ref}); ключи: ${d.keys.join(", ")} (предупреждение, не ошибка; закоммить и влей правку или откати файл)`
  if (d.kind === "note") return `проект ${name}: ${d.text}`
  return undefined
}

/** Короткая строка для /crew и боковой панели: только при расхождении (note в постоянный показ не идёт). */
export function divergenceLine(d: Divergence): string | undefined {
  if (d.kind !== "differ") return undefined
  const k = d.keys.join(", ")
  return `⚠ настройки не на ветке: ${k}`
}

/** Строка для проекта по имени: папку берём из последнего хорошего чтения настроек (settings-good), плагин окна реестра не держит. */
export function divergenceLineFor(project: string): string | undefined {
  try {
    const dir = path.join(BASE, "settings-good")
    for (const f of readdirSync(dir)) {
      const p = JSON.parse(readFileSync(path.join(dir, f), "utf8"))?.project
      if (p?.name === project) return divergenceLine(configDivergence(p.repo, p.file, p.branch))
    }
  } catch {}
  return undefined
}
