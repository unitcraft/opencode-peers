// ШАГИ ПРИЁМКИ ИЗ ДОКУМЕНТА КАНОНА ПРОЕКТА (задача 027). Ключ настроек acceptance_file — путь внутри репозитория проекта;
// файл читается с целевой ветки (origin/<ветка>, затем локальная), в нём markdown-таблица `| id | текст | обязателен |`.
// Чтение — короткий git show с кешем на несколько секунд: loadConfig зовут часто, git на каждый вызов не запускается.
import { execFileSync } from "node:child_process"

export type FileStep = { id: string; text: string; required: boolean }
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/
const NO = new Set(["нет", "no", "false", "0", "-", "н", "n"])

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())

/** Разбор таблицы: строки без id, с негодным или повторным id пропускаются (причина — в warnings). */
export function parseAcceptanceTable(text: string): { steps: FileStep[]; warnings: string[] } {
  const steps: FileStep[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  let header = true
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue
    const c = cells(line)
    if (c.every((x) => /^:?-{2,}:?$/.test(x))) continue
    if (header && c[0].toLowerCase() === "id") { header = false; continue }
    header = false
    const [id = "", stepText = "", req = ""] = c
    if (!id) { warnings.push(`строка без id пропущена: ${line.trim().slice(0, 60)}`); continue }
    if (!ID_RE.test(id)) { warnings.push(`id «${id}» не годится (строчные латинские, цифры, _ и -), строка пропущена`); continue }
    if (seen.has(id)) { warnings.push(`id «${id}» повторён, вторая строка пропущена`); continue }
    if (!stepText) { warnings.push(`у шага ${id} нет текста, строка пропущена`); continue }
    seen.add(id)
    steps.push({ id, text: stepText, required: !NO.has(req.toLowerCase()) })
  }
  return { steps, warnings }
}

const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
const cache = new Map<string, { at: number; value: { steps: FileStep[]; warnings: string[]; ref?: string } | undefined }>()
const ttl = () => (process.env.CREW_HARNESS_ACCEPTANCE_TTL_MS !== undefined ? Number(process.env.CREW_HARNESS_ACCEPTANCE_TTL_MS) : 15_000)

/** Шаги из файла целевой ветки или undefined (нет файла, нет шагов). Результат кешируется на проход. */
export function acceptanceFromFile(dir: string, targetBranch: string, file: string): { steps: FileStep[]; warnings: string[]; ref?: string } | undefined {
  const key = `${dir}\0${targetBranch}\0${file}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttl()) return hit.value
  let value: { steps: FileStep[]; warnings: string[]; ref?: string } | undefined
  for (const ref of [`origin/${targetBranch}`, targetBranch]) {
    try {
      const text = git(dir, ["show", `${ref}:${file}`])
      const parsed = parseAcceptanceTable(text)
      if (parsed.steps.length) { value = { ...parsed, ref }; break }
    } catch {}
  }
  cache.set(key, { at: Date.now(), value })
  return value
}
