// ПРИЁМКА (план 002, Ф.3). Исполнитель сдал задачу — её проверяет и вливает приёмщик (воркер, не автор задачи; по
// настройке проекта — сам интегратор), интегратор принятое не перепроверяет. Здесь — то, что плагин проверяет сам,
// и тексты писем: замок вливания проекта, «ветка или коммит действительно в целевой ветке», «worktree и ветка
// удалены», письмо приёмщику, письмо на доработку, шаги очистки.

import { execFile, execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { type Card, type CrewConfig, ROLES, cardFile, extraBlock, mayWakeCard, readJson, safeKey } from "./core.ts"
import { type Task, isOpen, listTasks, loadTask, taskFile, waitingCleanup } from "./tasks.ts"
import { roundRules } from "./plans.ts"

const git = (cwd: string, args: string[], timeout = 15_000) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout, stdio: ["ignore", "pipe", "ignore"] })
const gitOk = (cwd: string, args: string[], timeout?: number) => {
  try {
    git(cwd, args, timeout)
    return true
  } catch {
    return false
  }
}

// ЗАМОК ВЛИВАНИЯ проекта: один вливающий за раз (иначе CI одного проверит не то, что окажется в целевой ветке).
// roles/<проект>_merge.json {session, n, at}; взять — атомарно создать файл (wx). Замок брошен (держатель закрыт и
// не сессия задачи, его приёмка уже не идёт, или замку больше 2 ч) — забирается переименованием-перехватом.
type MergeLock = { session: string; n: number; at: number }
const MERGE_STALE_MS = 2 * 3600_000
const mergeFile = (project: string) => path.join(ROLES, `${safeKey(project)}_merge.json`)
export const mergeHolder = (project: string) => readJson<MergeLock>(mergeFile(project))

export function takeMergeLock(project: string, session: string, n: number): { ok: true } | { ok: false; holder: MergeLock } {
  mkdirSync(ROLES, { recursive: true })
  const file = mergeFile(project)
  const mine = JSON.stringify({ session, n, at: Date.now() })
  try {
    writeFileSync(file, mine, { flag: "wx" })
    return { ok: true }
  } catch {}
  const cur = readJson<MergeLock>(file)
  if (cur?.session === session) {
    writeFileSync(file, mine) // тот же держатель — обновить время и номер
    return { ok: true }
  }
  if (cur && !mergeLockAbandoned(project, cur)) return { ok: false, holder: cur }
  const tomb = `${file}.${process.pid}.${Date.now()}.old`
  try {
    renameSync(file, tomb)
  } catch {
    const now = readJson<MergeLock>(file)
    return now ? { ok: false, holder: now } : takeMergeLock(project, session, n)
  }
  rmSync(tomb, { force: true })
  try {
    writeFileSync(file, mine, { flag: "wx" })
    return { ok: true }
  } catch {
    return { ok: false, holder: readJson<MergeLock>(file)! }
  }
}

function mergeLockAbandoned(project: string, lock: MergeLock): boolean {
  if (Date.now() - lock.at > MERGE_STALE_MS) return true
  const t = loadTask(project, lock.n)
  if (!t || !isOpen(t) || t.reviewer !== lock.session) return true
  const holder = readJson<Card>(cardFile(lock.session))
  return !holder || !mayWakeCard(holder)
}

export function releaseMergeLock(project: string, session: string) {
  const file = mergeFile(project)
  if (readJson<MergeLock>(file)?.session === session) rmSync(file, { force: true })
}
export const holdsMergeLock = (project: string, session: string) => mergeHolder(project)?.session === session

/** Каталог репозитория задачи: worktree (если ещё есть) или каталог, где задачу ставили. */
export const repoDir = (t: Task) => (t.worktree && existsSync(t.worktree) ? t.worktree : t.directory)

/** Влито ли: коммит (squash-слияние) или ветка задачи — предок целевой ветки (локальной или origin/). */
export function isMerged(t: Task, target: string, commit?: string): { ok: boolean; how?: string; head?: string } {
  const dir = repoDir(t)
  const targets = [target, `origin/${target}`].filter((x) => gitOk(dir, ["rev-parse", "--verify", "--quiet", x]))
  if (!targets.length) return { ok: false, how: `целевой ветки ${target} в ${dir} нет` }
  const heads = commit ? [commit] : [t.branch, t.branch && `origin/${t.branch}`].filter(Boolean) as string[]
  for (const h of heads) {
    if (!gitOk(dir, ["rev-parse", "--verify", "--quiet", `${h}^{commit}`])) continue
    for (const tg of targets)
      if (gitOk(dir, ["merge-base", "--is-ancestor", h, tg])) {
        let head: string | undefined
        try {
          head = git(dir, ["rev-parse", `${h}^{commit}`]).trim()
        } catch {}
        return { ok: true, how: `${h} в ${tg}`, head }
      }
  }
  return { ok: false, how: commit ? `коммита ${commit} нет в ${targets.join(" / ")}` : `ветка ${t.branch ?? "?"} не влита в ${targets.join(" / ")} (squash-слияние — передай commit: <хэш коммита в ${target}>)` }
}

/** Файл в ветке (git show ветка:путь) или undefined. */
export function fileAt(dir: string, ref: string, file: string): string | undefined {
  try {
    return git(dir, ["show", `${ref}:${file}`])
  } catch {
    return undefined
  }
}

/** Шаги очистки по настройке проекта — текстом для приёмщика. */
export function cleanupSteps(t: Task, cfg: CrewConfig): string[] {
  if (cfg.cleanup === "none") return []
  const out: string[] = []
  if (t.worktree) out.push(`git worktree remove "${t.worktree}"`)
  if (t.branch) out.push(`git branch -D ${t.branch}`)
  if (t.branch && cfg.cleanup === "local+remote") out.push(`git push origin --delete ${t.branch}`)
  return out
}

/** Очистка сделана: ни одного артефакта задачи (ownership) — локально, а при local+remote и на origin (если доступен). */
export function cleanupDone(t: Task, cfg: CrewConfig, extraKept: string[] = []): { ok: boolean; left: string[] } {
  const left: string[] = []
  if (cfg.cleanup === "none") return { ok: true, left }
  // деревья, сохранённые приёмщиком как улики (cleaned {keep}), уборка не проверяет; ветка задачи проверяется по-прежнему
  const kept = keptPaths(t, extraKept)
  const isKept = (p?: string) => !!p && kept.some((k) => sameFs(k, p))
  if (t.worktree && existsSync(t.worktree) && !isKept(t.worktree)) left.push(`worktree ${t.worktree} ещё есть`)
  const dir = existsSync(t.directory) ? t.directory : undefined
  if (!dir) return { ok: !left.length, left }
  let top = dir
  try {
    top = git(dir, ["rev-parse", "--show-toplevel"]).trim()
  } catch {}
  const own = ownership(t, cfg, path.basename(top))
  try {
    for (const b of names(git(top, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))) if (own.isBranch(b)) left.push(`локальная ветка ${b} ещё есть`)
    for (const w of worktreesOf(git(top, ["worktree", "list", "--porcelain"])))
      if (!samePath(w.path, top) && !samePath(w.path, t.worktree) && !isKept(w.path) && own.isWorktree(w.path, w.branch)) left.push(`worktree ${w.path} ещё есть`)
  } catch {}
  if (cfg.cleanup === "local+remote") {
    try {
      for (const b of remoteHeads(git(top, ["ls-remote", "--heads", "origin"], 20_000))) if (own.isBranch(b)) left.push(`ветка ${b} на origin ещё есть`)
    } catch {} // origin недоступен — проверку remote пропускаем (не держим задачу из-за сети)
  }
  return { ok: !left.length, left }
}

/** Пути деревьев, сохранённых как улики (запись задачи) и новые из текущего вызова. */
/** Тот же путь на диске: и по записи, и по настоящему имени (короткие имена 8.3, регистр, ссылки). */
const canon = (p?: string) => {
  if (!p) return p
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}
export const sameFs = (a?: string, b?: string) => samePath(a, b) || samePath(canon(a), canon(b))
/** Сохранённые деревья, на которых стоит ветка: git branch -D такой ветки откажет, пока в дереве она выбрана. */
export function keptOnBranch(t: Task, branches: string[]): { path: string; branch: string }[] {
  const dir = existsSync(t.directory) ? t.directory : undefined
  if (!dir) return []
  try {
    const top = git(dir, ["rev-parse", "--show-toplevel"]).trim()
    return worktreesOf(git(top, ["worktree", "list", "--porcelain"]))
      .filter((w) => w.branch && branches.includes(w.branch) && keptPaths(t).some((k) => sameFs(k, w.path)))
      .map((w) => ({ path: w.path.replace(/\\/g, "/"), branch: w.branch! }))
  } catch {
    return []
  }
}
export const keptPaths = (t: Task, extra: string[] = []): string[] => [...(t.kept ?? []).map((k) => k.path), ...extra]

/**
 * Проверка keep у cleaned (задача 005, REQ-29): каждый путь — существующее worktree репозитория из `git worktree list` или
 * существующая папка внутри папки деревьев проекта; основное дерево, ветка, несуществующий путь — отказ с причиной.
 * Относительный путь считается от корня репозитория. Возвращает нормализованные пути (через /) без повторов.
 */
export function resolveKeep(t: Task, cfg: CrewConfig, keep: unknown): { ok: true; paths: string[] } | { ok: false; why: string } {
  if (!Array.isArray(keep) || !keep.length) return { ok: false, why: "keep — непустой массив путей деревьев (до 8)" }
  if (keep.length > 8) return { ok: false, why: `в keep не больше 8 путей (передано ${keep.length})` }
  if (keep.some((k) => typeof k !== "string" || !k.trim())) return { ok: false, why: "каждый путь в keep — непустая строка" }
  const dir = existsSync(t.directory) ? t.directory : undefined
  if (!dir) return { ok: false, why: `папки проекта ${t.directory} нет — сохранять нечего` }
  let top = dir
  let trees: { path: string; branch?: string }[] = []
  let branches: string[] = []
  try {
    top = git(dir, ["rev-parse", "--show-toplevel"]).trim()
    trees = worktreesOf(git(top, ["worktree", "list", "--porcelain"]))
    branches = names(git(top, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
  } catch {}
  const main = trees[0]?.path
  const out: string[] = []
  for (const raw of keep as string[]) {
    const p = path.resolve(top, raw.trim())
    const shown = raw.trim()
    if (sameFs(p, top) || sameFs(p, main)) return { ok: false, why: `${shown}: это основное дерево проекта, в keep его нельзя` }
    const tree = trees.find((w) => sameFs(w.path, p))
    const isTree = !!tree
    let inTrees = false
    if (!isTree && cfg.worktrees) {
      try {
        inTrees = normP(canon(p)).startsWith(`${normP(canon(cfg.worktrees))}/`) && statSync(p).isDirectory()
      } catch {}
    }
    if (!isTree && !inTrees) {
      const hint = branches.includes(shown) ? " (это ветка: keep сохраняет только дерево, ветку задачи уборка требует удалить)" : ""
      return { ok: false, why: `${shown}: нет такого worktree репозитория и такой папки в папке деревьев проекта${hint}` }
    }
    if (isTree && !existsSync(p)) return { ok: false, why: `${shown}: папки дерева на диске нет` }
    const n = (tree ? tree.path : (canon(p) ?? p)).replace(/\\/g, "/")
    if (!out.some((x) => sameFs(x, n))) out.push(n)
  }
  return { ok: true, paths: out }
}

/** Жизнь замка слияния в письмах приёмщика при merge_precheck: required (решение владельца 2026-10-09; то же в crew_help и README). */
export const LOCK_LIFECYCLE =
  "ЗАМОК СЛИЯНИЯ: его отпускает accept (а также rework и cancel); после слияния и пуша сразу accept, уборка идёт без замка; слияние прервано до accept — crew_task {action: \"unlock\", n}; cleaned замок не отпускает (замка к нему уже нет). Если проверенный кандидат уже в главной ветке на origin, служба сама отпустит замок («замок отпущен: слияние на вершине»), и тогда accept замка не требует."

/** Фраза для письма приёмщику при accepted_slot: free (по умолчанию) — принятая задача ждёт уборки и место в inflight_limit не занимает. */
function slotSentence(t: Task, cfg: CrewConfig): string {
  const waiting = waitingCleanup(listTasks(t.project)).length
  return `ПОСЛЕ ПРИНЯТИЯ (accepted_slot: free): принятая задача ждёт уборки и место в inflight_limit не занимает; ждущих уборки ${cfg.cleanupLimit > 0 ? `${waiting} из ${cfg.cleanupLimit}` : `${waiting}, предела нет`}. Всё равно доведи до cleaned: пока уборки ждут, новая работа может не ставиться.`
}

/** Письмо приёмщику. */
export function reviewLetter(t: Task, cfg: CrewConfig): string {
  if (t.plan?.approval && t.plan.approval.decision !== "no") return planMergeLetter(t, cfg)
  if (t.plan) return planReviewLetter(t, cfg)
  const steps = cfg.acceptance.length
    ? cfg.acceptance.map((a) => `  ${a.id}${a.required ? " (обязательно)" : ""}: ${a.text}`).join("\n")
    : "  (шаги приёмки в настройках проекта не заданы — проверь критерии задачи)"
  const pre = cfg.mergePrecheck === "required" ? 1 : 0 // merge_precheck: required — перед merge шаг предпроверки
  return [
    `ПРИЁМКА задачи #${t.n} «${t.title}» (приоритет ${t.priority}). Ты — приёмщик: проверяешь и вливаешь сам; интегратор принятое не перепроверяет. Автор задачи — ${t.author_role}, исполнитель — сессия ${t.executor}.`,
    `ЦЕЛЬ: ${t.goal}`,
    t.criteria ? `КРИТЕРИИ ПРИЁМКИ: ${t.criteria}` : "",
    t.boundaries ? `ГРАНИЦЫ: ${t.boundaries}` : "",
    extraBlock(t),
    extraBlock(t) ? `ЗАПИСЬ ЗАДАЧИ: ${taskFile(t.project, t.n)}, поле extra ({id: значение}) — скрипт проекта читает значения оттуда.` : "",
    t.worktree ? `WORKTREE ИСПОЛНИТЕЛЯ: ${t.worktree}, ветка ${t.branch}; целевая ветка ${cfg.targetBranch}.` : t.branch ? `ВЕТКА: ${t.branch}; целевая ${cfg.targetBranch}.` : `Целевая ветка ${cfg.targetBranch}.`,
    t.report ? `ОТЧЁТ ИСПОЛНИТЕЛЯ:\n${t.report.slice(0, 3000)}` : "",
    `ШАГИ ПРИЁМКИ:\n${steps}`,
    `ПОРЯДОК:`,
    `  1) crew_task {action: "review", n: ${t.n}} — начал приёмку (исполнитель узнает без пробуждения);`,
    cfg.acceptance.length
      ? `  2) КАЖДЫЙ ШАГ — по очереди, владелец видит ход в окне: crew_task {action: "check", n: ${t.n}, step: "<шаг>"} перед проверкой шага, после — {action: "check", n: ${t.n}, step: "<шаг>", result: "чем подтверждено"};`
      : "",
    pre
      ? `  ${cfg.acceptance.length ? "3" : "2"}) ПРЕДПРОВЕРКА (merge_precheck: required; замок до CI не брать и merge не вызывать): crew_task {action: "precheck", n: ${t.n}} назовёт вершину ${cfg.targetBranch}; влей её вместе с веткой задачи в интеграционный candidate (например, integrate/t${t.n}), прогони полный CI проекта на этом кандидате и заверши: crew_task {action: "precheck", n: ${t.n}, candidate: "<точная ветка или хеш проверенного кандидата>", result: "<зелёный полный CI>"}. Запиши точный проверенный commit кандидата; если основа сдвинулась — собери и проверь новый кандидат заново, старый не вливай;`
      : "",
    `  ${(cfg.acceptance.length ? 3 : 2) + pre}) нашёл ошибки — crew_task {action: "rework", n: ${t.n}, text: "что исправить"} (вернётся тебе на повторную приёмку);`,
    pre
      ? `  ${(cfg.acceptance.length ? 4 : 3) + pre}) только после зелёного precheck — crew_task {action: "merge", n: ${t.n}} (теперь берётся замок); fast-forward влей в ${cfg.targetBranch} ИМЕННО сохранённый проверенный candidate, не пересобирай и не подменяй его веткой задачи, затем запушь;`
      : `  ${(cfg.acceptance.length ? 4 : 3) + pre}) всё зелёное — crew_task {action: "merge", n: ${t.n}} (замок вливания проекта), влей в ${cfg.targetBranch} и запушь, затем`,
    pre
      ? `     crew_task {action: "accept", n: ${t.n}${cfg.acceptance.length ? "" : ", checks: {\"<критерий>\": \"чем подтверждено\"}"}, commit: "<хэш в ${cfg.targetBranch}, если squash>"};`
      : `     crew_task {action: "accept", n: ${t.n}${cfg.acceptance.length ? "" : ", checks: {\"<критерий>\": \"чем подтверждено\"}"}, commit: "<хэш в ${cfg.targetBranch}, если squash>"} (отмеченные шаги засчитаны);`,
    pre
      ? `  ${(cfg.acceptance.length ? 5 : 4) + pre}) отдельно выполни выданные шаги очистки, затем crew_task {action: "cleaned", n: ${t.n}}.${cfg.acceptedSlot === "free" ? " При accepted_slot: free accept освобождает inflight/worker slot; до cleaned задача учитывается отдельно в cleanup_limit." : ""} Улики сохранить — cleaned {n, keep:[путь]}; удалять их не нужно.`
      : `  ${(cfg.acceptance.length ? 5 : 4) + pre}) плагин сам проверит, что влито, и выдаст шаги очистки; сделал — crew_task {action: "cleaned", n: ${t.n}}.${cfg.acceptedSlot === "free" ? " При accepted_slot: free accept освобождает inflight/worker slot; до cleaned задача учитывается отдельно в cleanup_limit." : ""}`,
    pre ? LOCK_LIFECYCLE : "",
    cfg.acceptedSlot === "free" ? slotSentence(t, cfg) : "",
  ]
    .filter(Boolean)
    .join("\n")
}

/** Письмо проверяющему раунда перепроверки плана (план 004). */
export function planReviewLetter(t: Task, cfg: CrewConfig): string {
  const p = t.plan!
  const no = p.rounds.length + 1
  const f = cfg.planForm
  const past = p.rounds.map((r, i) => `  ${r.line ?? `раунд ${i + 1}: блокирующих ${r.blocking}, существенных ${r.significant}, косметических ${r.cosmetic}`}${r.notes ? `\n    ${r.notes.replace(/\n/g, "\n    ")}` : ""}`)
  return [
    `ПЕРЕПРОВЕРКА ПЛАНА ${p.n} (задача #${t.n} «${t.title}»), раунд ${no}. Ты — проверяющий этого раунда: не автор плана и не прошлые проверяющие. План не правь — замечания идут автору.`,
    `ИСХОДНАЯ ЗАДАЧА (против неё проверяешь план):\n${p.source}`,
    `ФАЙЛ ПЛАНА: ${p.file}${t.worktree ? ` в worktree ${t.worktree}, ветка ${t.branch}` : ` в ${t.directory}`}.`,
    t.report ? `ОТЧЁТ АВТОРА:\n${t.report.slice(0, 2000)}` : "",
    past.length ? `ПРОШЛЫЕ РАУНДЫ (проверь и их градации: косметическое, оказавшееся содержательным, — замечание этого раунда):\n${past.join("\n")}` : "",
    `ЧТО ПРОВЕРИТЬ — по каждому шагу check:\n${cfg.planAcceptance.map((a) => `  ${a.id}: ${a.text}`).join("\n")}`,
    roundRules(f.grades),
    "ПОРЯДОК:",
    `  1) crew_task {action: "review", n: ${t.n}};`,
    `  2) по каждому шагу: crew_task {action: "check", n: ${t.n}, step} перед проверкой, {action: "check", n: ${t.n}, step, result: "что нашёл"} после (у a2-coverage в result — таблица «требование → шаг → критерий»);`,
    `  3) вердикт: crew_task {action: "round", n: ${t.n}, grades: {${f.grades.map((g) => `${g.id}: <число>`).join(", ")}}, text: "замечания: [градация] что не так → что исправить"}.`,
    `Готов — ${cfg.planCleanRounds} раунда подряд только с косметическими; тогда план уйдёт владельцу. merge и accept в раунде не нужны: план вливается после согласования.`,
  ]
    .filter(Boolean)
    .join("\n")
}

/** Письмо приёмщику согласованного плана: записать решение владельца и влить (план 004, шаг 3). */
export function planMergeLetter(t: Task, cfg: CrewConfig): string {
  const p = t.plan!
  const a = p.approval!
  const yes = a.decision === "ok"
  const day = new Date(a.at).toISOString().slice(0, 10)
  return [
    `ВЛИТЬ СОГЛАСОВАННЫЙ ПЛАН ${p.n} (задача #${t.n} «${t.title}»). ${cfg.planApprover === "owner" ? "Владелец" : "Интегратор"} ${day}: ${yes ? "согласован без упрощений" : "согласован, упрощения — как в плане"}.`,
    `ФАЙЛ: ${p.file}${t.worktree ? ` в worktree ${t.worktree}, ветка ${t.branch}` : ""}.`,
    "ВПИШИ В ПЛАН (коммитом в ветку задачи):",
    cfg.planForm.modeQuestion ? `  — в «${cfg.planForm.sections.mode}»: «${cfg.planForm.modeLabel}: ${yes ? "ДА" : "НЕТ"} — ${cfg.planApprover === "owner" ? "владелец" : "интегратор"}, ${day}»;` : "",
    `  — в «${cfg.planForm.sections.decisions}»: строку «план согласован${yes ? " без упрощений" : ", упрощения — как в плане"} | ${day}»;`,
    `  — в шапке: «**Статус:** ${cfg.planForm.marks.plan_work}».`,
    "ПОРЯДОК:",
    `  1) crew_task {action: "review", n: ${t.n}}; шаги approval-written и form — check по каждому;`,
    cfg.mergePrecheck === "required"
      ? `  2) ПРЕДПРОВЕРКА (merge_precheck: required; замок до CI не брать и merge не вызывать): crew_task {action: "precheck", n: ${t.n}} назовёт вершину ${cfg.targetBranch}; влей её вместе с веткой плана в интеграционный candidate, прогони полный CI проекта на нём и заверши: crew_task {action: "precheck", n: ${t.n}, candidate: "<точная ветка или хеш проверенного кандидата>", result: "<зелёный полный CI>"}. Запиши точный commit кандидата; если основа сдвинулась — собери и проверь новый кандидат заново, старый не вливай;`
      : "",
    cfg.mergePrecheck === "required"
      ? `  3) только после зелёного precheck вызови crew_task {action: "merge", n: ${t.n}} (теперь берётся замок); fast-forward влей в ${cfg.targetBranch} именно сохранённый проверенный candidate, не пересобирай и не подменяй его веткой плана, затем push;`
      : `  2) crew_task {action: "merge", n: ${t.n}} (замок вливания), влей ветку в ${cfg.targetBranch} и запушь;`,
    cfg.mergePrecheck === "required"
      ? `  4) crew_task {action: "accept", n: ${t.n}} — плагин прочтёт план в ${cfg.targetBranch}: форма${cfg.planForm.modeQuestion ? ` и ответ «${cfg.planForm.modeLabel}»` : ""} должны сойтись с решением владельца;`
      : `  3) crew_task {action: "accept", n: ${t.n}} — плагин прочтёт план в ${cfg.targetBranch}: форма${cfg.planForm.modeQuestion ? ` и ответ «${cfg.planForm.modeLabel}»` : ""} должны сойтись с решением владельца; затем очистка и cleaned.`,
    ...(cfg.mergePrecheck === "required" ? [`  5) отдельно выполни выданные шаги очистки и вызови crew_task {action: "cleaned", n: ${t.n}}.${cfg.acceptedSlot === "free" ? " При accepted_slot: free accept освобождает inflight/worker slot; cleanup учитывается отдельно до cleaned." : ""} Улики сохранить — cleaned {n, keep:[путь]}; удалять их не нужно.`] : []),
    ...(cfg.mergePrecheck === "required" ? [LOCK_LIFECYCLE] : []),
    cfg.planSteps === "auto" ? "После cleaned плагин сам поставит задачи по шагам плана." : "После cleaned автор получит список шагов: задачи по ним ставит он сам (plan_steps: manual).",
  ]
    .filter(Boolean)
    .join("\n")
}

/** Письмо исполнителю: на доработку. */
export function reworkLetter(t: Task, text: string, by: string): string {
  return [
    t.plan ? `ЗАМЕЧАНИЯ ПЕРЕПРОВЕРКИ ПЛАНА ${t.plan.n} (задача #${t.n}) от ${by}:` : t.rework_sync ? `СИНХРОНИЗАЦИЯ задачи #${t.n} «${t.title}» с целевой веткой (не доработка) от приёмщика ${by}:` : `ДОРАБОТКА задачи #${t.n} «${t.title}» (круг ${t.rework ?? 1}) от приёмщика ${by}:`,
    text,
    `Исправь в том же worktree${t.branch ? ` (ветка ${t.branch})` : ""} и сдай снова тем же отчётом: crew_send {to: "${t.author}", reply_to: "${t.qid}", text: "что исправлено, как проверено"}.`,
  ].join("\n")
}

// WORKTREE ЗАДАЧИ СОЗДАЁТ ПЛАГИН (план 002.3, 2026-10-05). Сессия воркера запускалась в главной копии проекта, а в свой
// worktree воркер переходил командами: хуки и стражи проекта видели ветку main и принимали воркера за интегратора
// (хук Stop nova требовал от него слияний), строка внизу вкладки показывала main. Теперь плагин до запуска сессии
// создаёт worktree и ветку задачи (от целевой ветки) и запускает сессию в нём. Повторный запуск переиспользует готовый
// worktree; не вышло — прежний порядок (сессия в папке проекта, worktree создаёт воркер), задача не падает.
// Асинхронно (2026-10-06): `git worktree add` на репозитории nova идёт 6–30 с, синхронный вызов держал главный поток
// сервера — окна теряли связь («Event stream stalled»).
// БАЗА — ОПУБЛИКОВАННАЯ ВЕТКА (задача 022, 2026-10-11): до создания ветки плагин делает `git fetch origin <база>` (асинхронно,
// с пределом времени) и строит ветку от origin/<база>; нет remote или fetch не вышел — прежняя локальная база и warn.
// Локальная ветка отличается от опубликованной — note с числами (чужие коммиты и локальную ветку плагин не двигает).
export async function ensureWorktree(repoDir: string, worktree: string, branch: string, base: string): Promise<{ ok: boolean; created: boolean; error?: string; warn?: string; note?: string }> {
  try {
    if (existsSync(worktree)) {
      const head = (await gitA(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
      return head === branch ? { ok: true, created: false } : { ok: false, created: false, error: `в ${worktree} ветка ${head}, а не ${branch}` }
    }
    const top = (await gitA(repoDir, ["rev-parse", "--show-toplevel"])).trim()
    mkdirSync(path.dirname(worktree), { recursive: true })
    let exists = true
    try {
      await gitA(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    } catch {
      exists = false
    }
    let start = base
    let warn: string | undefined
    let note: string | undefined
    if (!exists) {
      try {
        await gitA(top, ["fetch", "--quiet", "origin", base], 60_000)
        await gitA(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`])
        start = `origin/${base}`
        try {
          await gitA(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`])
          const [ahead, behind] = (await gitA(top, ["rev-list", "--left-right", "--count", `${base}...origin/${base}`])).trim().split(/\s+/).map(Number)
          // left = только в локальной (впереди), right = только в опубликованной (позади)
          if (behind || ahead) note = `локальный ${base} позади на ${behind}, впереди на ${ahead} относительно origin/${base}; ветка задачи построена от origin/${base}${behind && ahead ? "; расхождение — решает человек" : ""}`
        } catch {
          // локальной целевой ветки нет — сравнивать не с чем
        }
      } catch (e: any) {
        warn = `не удалось обновить origin/${base} (${String(e?.message ?? e).split(String.fromCharCode(10))[0].slice(0, 120)}) — ветка задачи построена от локальной ${base}`
      }
    }
    await gitA(top, exists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, start], 120_000)
    return { ok: true, created: true, ...(warn ? { warn } : {}), ...(note ? { note } : {}) }
  } catch (e: any) {
    return { ok: false, created: false, error: String(e?.message ?? e).split("\n")[0].slice(0, 300) }
  }
}

// ХВОСТЫ ЗАКРЫТЫХ ЗАДАЧ (план 002.4, 2026-10-05): у принятой задачи #6 nova остались ветка задачи (локально и на
// origin), её worktree и две диагностические ветки t6-diag* — приёмка их не увидела (журнал задачи остался без
// worktree и ветки из-за сбоя чтения настроек). Ищем по шаблонам настроек с номером задачи и любым slug: ветки
// branch_name (локальные; на origin — при cleanup local+remote) и worktree worktree_name (ownership ниже).
// Плагин сам не удаляет (это действие наружу): список уходит автору задачи.
const templateRe = (tpl: string, v: { repo: string; n: number; project: string }) =>
  new RegExp(
    "^" +
      tpl
        .split(/(\{repo\}|\{n\}|\{project\}|\{slug\})/)
        .map((p) => (p === "{slug}" ? ".+" : (p === "{repo}" ? v.repo : p === "{n}" ? String(v.n) : p === "{project}" ? v.project : p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("") +
      "$",
  )
// одна запись на одно и то же: «ветка B (на влитом коммите)» — локальная ветка B; пути worktree — через /
const normLeft = (x: string) =>
  x
    .replace(/ ещё есть$/, "")
    .replace(/^ветка (\S+) \(на влитом коммите\)$/, "локальная ветка $1")
    .replace(/ \(на влитом коммите\)$/, "")
    .replace(/^(worktree )(.+)$/, (_m: string, w: string, p: string) => w + p.replace(/\\/g, "/"))
// ХВОСТЫ ЗАДАЧИ — ТОЛЬКО ЕЁ АРТЕФАКТЫ (план 002.6, дефект 1; 2026-10-06). Раньше хвостом считалось и всё, что стоит на
// влитом коммите: новая задача рождается от свежего main, то есть ровно на нём, и её ветку с деревом записывали в хвосты
// только что принятой (#9, #10, #14, #15, #19 nova — ни одного настоящего хвоста; #9 провисела в «принята» 11,5 ч).
// Теперь: дерево и ветка из записи задачи, ветки по шаблону с её номером (t<N>-…, в т. ч. отростки t<N>-diag),
// integrate/t<N> и integrate/t<N>-*, деревья по шаблону имени или на таких ветках. Ветка или дерево ДРУГОЙ задачи
// проекта (из её записи) хвостом не бывает никогда.
const normP = (p?: string) => (p ? path.resolve(p).replace(/\\/g, "/").toLowerCase() : "")
export const samePath = (a?: string, b?: string) => !!a && !!b && normP(a) === normP(b)
const names = (out: string) => out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
const remoteHeads = (out: string) => names(out).map((l) => l.split("refs/heads/")[1]?.trim()).filter(Boolean) as string[]
/** блоки «worktree <путь> / HEAD <sha> / branch <ref>», разделённые пустой строкой */
function worktreesOf(porcelain: string): { path: string; branch?: string }[] {
  const out: { path: string; branch?: string }[] = []
  for (const blk of porcelain.split(/\r?\n\r?\n/)) {
    const get = (k: string) => blk.split(/\r?\n/).find((l) => l.startsWith(`${k} `))?.slice(k.length + 1)
    const wt = get("worktree")
    if (wt) out.push({ path: wt, branch: get("branch")?.replace("refs/heads/", "") })
  }
  return out
}
export function ownership(t: Task, cfg: CrewConfig, repo: string) {
  const v = { repo, n: t.n, project: t.project }
  const branchRe = templateRe(cfg.branchName, v)
  // ветки, начатые по шаблону, и их «отростки» (t6-…-cand, t6-diag): номер задачи в начале имени ветки
  const prefix = cfg.branchName.split("{slug}")[0]
  const prefixRe = prefix.includes("{n}") ? templateRe(`${prefix}{slug}`, v) : branchRe
  const integRe = new RegExp(`^integrate/t${t.n}(-.+)?$`)
  const wtRe = cfg.worktrees ? templateRe(cfg.worktreeName, v) : undefined
  let others: Task[] = []
  try {
    others = listTasks(t.project).filter((x) => x.n !== t.n)
  } catch {}
  const otherBranches = new Set(others.map((x) => x.branch).filter(Boolean) as string[])
  const otherTrees = new Set(others.map((x) => normP(x.worktree)).filter(Boolean))
  const isBranch = (b: string) => b !== cfg.targetBranch && !otherBranches.has(b) && (b === t.branch || branchRe.test(b) || prefixRe.test(b) || integRe.test(b))
  const isWorktree = (wt: string, branch?: string) =>
    !otherTrees.has(normP(wt)) && !(branch && otherBranches.has(branch)) && (samePath(wt, t.worktree) || (!!branch && isBranch(branch)) || (!!wtRe && wtRe.test(path.basename(wt))))
  return { isBranch, isWorktree }
}

// асинхронно: проверка идёт в цикле сервера раз в несколько минут, синхронный git (тем более ls-remote по сети)
// держал бы главный поток сервера
const gitA = (cwd: string, args: string[], timeout = 20_000) =>
  new Promise<string>((res, rej) => execFile("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout }, (e, out) => (e ? rej(e) : res(String(out)))))
export async function leftoversOf(t: Task, cfg: CrewConfig, remote: boolean): Promise<string[]> {
  const dir = existsSync(t.directory) ? t.directory : undefined
  if (!dir) return []
  const left = new Set<string>()
  try {
    const top = (await gitA(dir, ["rev-parse", "--show-toplevel"])).trim()
    const own = ownership(t, cfg, path.basename(top))
    for (const b of names(await gitA(top, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))) if (own.isBranch(b)) left.add(`локальная ветка ${b}`)
    const kept = keptPaths(t)
    for (const w of worktreesOf(await gitA(top, ["worktree", "list", "--porcelain"]))) if (!samePath(w.path, top) && !kept.some((k) => sameFs(k, w.path)) && own.isWorktree(w.path, w.branch)) left.add(normLeft(`worktree ${w.path}`))
    if (remote && cfg.cleanup === "local+remote") for (const b of remoteHeads(await gitA(top, ["ls-remote", "--heads", "origin"]))) if (own.isBranch(b)) left.add(`ветка ${b} на origin`)
  } catch {}
  return [...left]
}

// СЛЕДЫ ОБОРВАННОЙ ОПЕРАЦИИ GIT (2026-10-06): ход оборвали посреди git (перезапуск сервиса) — в дереве может остаться
// брошенный index.lock (любая команда git отказывает), незаконченное слияние, rebase или cherry-pick. Письмо «прервана
// перезапуском» называет их конкретно — только по наличию файлов в git-каталоге, без запуска git.
export function gitTraces(dir: string, now = Date.now()): string[] {
  const out: string[] = []
  try {
    let gitDir = path.join(dir, ".git")
    if (!existsSync(gitDir)) return out
    if (!lstatSync(gitDir).isDirectory()) {
      const m = /gitdir:\s*(.+)/.exec(readFileSync(gitDir, "utf8"))
      if (!m) return out
      gitDir = path.resolve(dir, m[1].trim())
    }
    const lock = path.join(gitDir, "index.lock")
    if (existsSync(lock)) out.push(`брошенный ${lock} (${Math.round((now - statSync(lock).mtimeMs) / 60_000)} мин): если git сейчас не работает — удали его`)
    if (existsSync(path.join(gitDir, "MERGE_HEAD"))) out.push(`незаконченное слияние в ${dir}: доведи (разреши конфликты, коммит) или git merge --abort`)
    if (existsSync(path.join(gitDir, "rebase-merge")) || existsSync(path.join(gitDir, "rebase-apply"))) out.push(`незаконченный rebase в ${dir}: git rebase --continue или --abort`)
    if (existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) out.push(`незаконченный cherry-pick в ${dir}: --continue или --abort`)
    if (existsSync(path.join(gitDir, "REVERT_HEAD"))) out.push(`незаконченный revert в ${dir}: --continue или --abort`)
  } catch {}
  return out
}
