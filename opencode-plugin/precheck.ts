// ПРЕДПРОВЕРКА ВЛИВАНИЯ (задача 005, ADR-0009). Замок вливания проекта выдаётся только на ту вершину целевой ветки, на которой
// приёмщик уже собрал и проверил кандидата. Здесь — вся логика этого пункта: чтение вершины главной ветки, запись предпроверки
// в задаче, ворота `merge`, подсказки. Модуль ничего не пишет в репозиторий проекта: он только читает (rev-parse, merge-base,
// cat-file, remote, ls-remote); вливает, пушит и чистит приёмщик, CI запускает проект (плагин о них не знает).
//
// Чтение вершины — `originTip`: `git ls-remote origin refs/heads/<цель>` с собственным сроком плагина (20 с). Срок встроенного
// запуска убивает только родителя: помощник git для https остаётся сиротой и держит соединение. Поэтому срок исполняет таймер
// плагина, и по его истечении плагин снимает ДЕРЕВО процессов своего запуска по номеру процесса (`killTree`). По имени и маске
// не убивается ничего.

import { spawn, execFileSync } from "node:child_process"
import { isMerged, mergeHolder, releaseMergeLock, repoDir, takeMergeLock } from "./review.ts"
import { type PrecheckRecord, type Task, acceptedAt, isOpen, listTasks, loadTask, rounds, taskEvent, taskRef } from "./tasks.ts"

/** срок чтения вершины на origin, мс */
export const TIP_TIMEOUT_MS = 20_000

/** Локальный вызов git только для чтения: код, вывод, первая строка stderr. Единственная точка вызова git (кроме `ls-remote` в originTip). */
export function runGit(dir: string, args: string[], timeout = 15_000): { ok: boolean; code: number | null; out: string; err: string } {
  try {
    const out = execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, timeout, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } })
    return { ok: true, code: 0, out, err: "" }
  } catch (e: any) {
    const err = String(e?.stderr ?? e?.message ?? e).trim().split(/\r?\n/)[0] ?? ""
    return { ok: false, code: typeof e?.status === "number" ? e.status : null, out: String(e?.stdout ?? ""), err }
  }
}

/** Снять дерево процессов своего запуска (только пока процесс жив), по номеру: не по имени и не по маске. Ошибки не бросает. */
export function killTree(child: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill: (s?: NodeJS.Signals) => boolean }): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  try {
    if (process.platform === "win32") {
      // код возврата taskkill не проверяется (бывает 255 при уже снятом дереве); запуск асинхронный, ошибка игнорируется
      const k = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" })
      k.on("error", () => {})
    } else {
      process.kill(-child.pid, "SIGKILL")
    }
  } catch {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
}

/** Вершина целевой ветки: из origin (ls-remote) или, если origin не настроен, из локальной ветки. */
export type Tip = { ok: true; tip: string; source: "origin" | "local" } | { ok: false; kind: "fail" | "missing"; error: string }

/** `origin` настроен? `git remote get-url origin`: код 0 — да, код 2 («No such remote») — нет, любой другой — сбой чтения настроек. */
export function hasOrigin(dir: string): { origin: true } | { origin: false } | { error: string } {
  const r = runGit(dir, ["remote", "get-url", "origin"], 10_000)
  if (r.ok) return { origin: true }
  if (r.code === 2) return { origin: false }
  return { error: `git remote get-url origin: ${r.err || `код ${r.code ?? "?"}`}` }
}

const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/**
 * Прочитать вершину ветки `target` (REQ-09). Только чтение: ни fetch, ни записи ссылок и объектов. Без кеша. Сбой, срок, пустой
 * вывод — отказ с текстом (kind "fail" — сбой чтения, "missing" — на origin ветки нет); «не сдвинулась» из него не выводится.
 */
export function originTip(dir: string, target: string, opts: { timeoutMs?: number } = {}): Promise<Tip> {
  const timeoutMs = opts.timeoutMs ?? TIP_TIMEOUT_MS
  const o = hasOrigin(dir)
  if ("error" in o) return Promise.resolve({ ok: false, kind: "fail", error: o.error })
  if (!o.origin) {
    // origin не настроен: вершина — локальная ветка (прежнее поведение проекта без удалённого репозитория)
    const l = runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${target}^{commit}`], 10_000)
    const tip = l.out.trim()
    return Promise.resolve(l.ok && HASH.test(tip) ? { ok: true, tip, source: "local" } : { ok: false, kind: "missing", error: `origin не настроен, а локальной ветки ${target} в ${dir} нет` })
  }
  return new Promise<Tip>((resolve) => {
    let done = false
    let out = ""
    let err = ""
    const finish = (r: Tip) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("git", ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=15", "ls-remote", "origin", `refs/heads/${target}`], {
        cwd: dir,
        windowsHide: true,
        detached: process.platform !== "win32", // своя группа процессов: по сроку снимается вся
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      })
    } catch (e: any) {
      return resolve({ ok: false, kind: "fail", error: `git ls-remote не запущен: ${e?.message ?? e}` })
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish({ ok: false, kind: "fail", error: `git ls-remote origin: срок ${Math.round(timeoutMs / 1000)} с истёк (ответа нет; процессы запуска сняты)` })
    }, timeoutMs)
    child.stdout?.on("data", (d) => (out += d))
    child.stderr?.on("data", (d) => (err += d))
    child.on("error", (e: any) => finish({ ok: false, kind: "fail", error: `git ls-remote не запущен: ${e?.message ?? e}` }))
    child.on("close", (code) => {
      if (done) return
      if (code !== 0) return finish({ ok: false, kind: "fail", error: `git ls-remote origin: ${err.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? `код ${code}`}` })
      for (const line of out.split(/\r?\n/)) {
        const [hash, ref] = line.split(/\s+/)
        if (ref === `refs/heads/${target}` && HASH.test(hash ?? "")) return finish({ ok: true, tip: hash, source: "origin" })
      }
      finish({ ok: false, kind: "missing", error: `ветки ${target} на origin нет` })
    })
  })
}

// ---- швы для тестов (РП-02): по умолчанию пусты, производственный путь их нигде не заполняет
export const seams: { readTip?: typeof originTip; afterTip?: () => void | Promise<void>; afterMerged?: () => void } = {}
const readTip = (dir: string, target: string) => (seams.readTip ?? originTip)(dir, target)

const short = (h: string) => h.slice(0, 7)
const hm = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}
/** круг задачи: запись прежнего круга зелёной не считается (РП-04) */
export const roundOf = (t: Task) => rounds(t) + t.attempt
/** Запись действует (не устарела). */
export const isLive = (rec?: PrecheckRecord): rec is PrecheckRecord => !!rec && rec.state !== "stale"
/**
 * Подсказки о соседних задачах проекта; только чтение журнала задач, ничего не хранится и не резервируется.
 * running — какие другие открытые задачи сейчас с записью «идёт» или «зелёная» (номер, на какой вершине, с какого времени);
 * moved — какие задачи проекта приняты после времени зелёной предпроверки этой задачи (из журнала, без git).
 * Возвращает строку, начинающуюся с пробела, или пустую.
 */
export function neighbourHints(t: Task, kind: "running" | "moved"): string {
  let all: Task[] = []
  try {
    all = listTasks(t.project).filter((x) => x.n !== t.n)
  } catch {
    return ""
  }
  if (kind === "running") {
    const busy = all.filter((x) => isOpen(x) && isLive(x.precheck) && x.status === "reviewing")
    if (!busy.length) return ""
    return ` Параллельно идут: ${busy.map((x) => `#${x.n} (${x.precheck!.state === "green" ? "зелёная" : "идёт"} на ${short(x.precheck!.base)} с ${hm(x.precheck!.state === "green" ? (x.precheck!.green_at ?? x.precheck!.at) : x.precheck!.at)})`).join(", ")}.`
  }
  const since = t.precheck?.green_at ?? t.precheck?.at ?? 0
  const landed = all.filter((x) => (x.status === "accepted" || x.status === "cleaned") && acceptedAt(x) > since)
  if (!landed.length) return ""
  return ` После зелёной приняты: ${landed.map((x) => `#${x.n} (${hm(acceptedAt(x))})`).join(", ")}.`
}

/**
 * Предупреждение `accept` (REQ-13): запись зелёная, а проверенный кандидат не входит в принимаемую вершину целевой ветки — влито
 * не то, что проверялось. Не отказ: при squash и перебазировании кандидат предком не будет. Пустая строка — предупреждать не о чем.
 */
export function acceptWarning(t: Task, target: string, head?: string): string {
  const rec = t.precheck
  if (!rec || rec.state !== "green" || !rec.candidate) return ""
  const dir = repoDir(t)
  const tip = acceptedTip(t, target, head)
  if (!tip) return ""
  if (!resolveCommit(dir, rec.candidate)) return ` Внимание: кандидата предпроверки ${short(rec.candidate)} в локальном репозитории нет — сверить, что влито именно проверенное, нельзя.`
  const r = runGit(dir, ["merge-base", "--is-ancestor", rec.candidate, tip], 10_000)
  if (r.code === 1) return ` Внимание: влито не то, что проверялось: кандидат предпроверки ${short(rec.candidate)} не входит в ${target} (${short(tip)}). Это предупреждение, не отказ (при squash и перебазировании так бывает); сверь содержимое.`
  return ""
}

/**
 * Строки состояния предпроверки и замка для `show` и письма «работа прервана» (REQ-15, REQ-19): пустой список, если записи нет.
 * Только чтение записи и файла замка; `session` — кому показываем («твой»).
 */
export function precheckLines(t: Task, session: string): string[] {
  const rec = t.precheck
  if (!rec) return []
  const out: string[] = []
  if (rec.state === "running") out.push(`предпроверка: идёт с ${hm(rec.at)} на ${short(rec.base)}`)
  else if (rec.state === "green") out.push(`предпроверка: зелёная на ${short(rec.base)} (кандидат ${short(rec.candidate ?? "")}, ${hm(rec.green_at ?? rec.at)})`)
  else out.push(`предпроверка: устарела (${rec.stale?.reason ?? "причина не записана"}), была на ${short(rec.base)}`)
  const h = mergeHolder(t.project)
  if (h && h.session === session && h.n === t.n) out.push(`замок вливания: твой с ${hm(h.at)}${rec.lock_on ? `, на вершине ${short(rec.lock_on.tip)}` : ""}`)
  else if (h && h.session === session) out.push(`замок вливания: твой, но для задачи #${h.n}, не для этой`)
  else if (h) out.push(`замок вливания: у другого приёмщика (задача #${h.n})`)
  else out.push("замок: нет")
  return out
}

/**
 * Запись предпроверки устаревает с причиной. Чистая функция над записью: сохраняет не она, а тот `taskEvent`/`saveTask`, который
 * вызывающий место и так делает (запись устаревает той же записью файла, что и смена статуса). Уже устаревшая запись не меняется.
 */
export function markPrecheckStale(t: Task, reason: string): void {
  if (!t.precheck || t.precheck.state === "stale") return
  const { landed: _landed, ...rest } = t.precheck // устаревшая запись «слияния» не даёт accept без замка
  t.precheck = { ...rest, state: "stale", stale: { reason, at: Date.now() } }
}

/**
 * Ветка задачи ушла вперёд кандидата (задача 030): вершина ветки изменилась после фиксации кандидата, и она не предок кандидата и не
 * равна ему по дереву (squash). Ветки локально нет, запись без `branch_tip` или git не ответил — не устарел (молча пропускаем).
 * Вершина, не менявшаяся с фиксации, не проверяется: кандидата могли собрать без ветки сознательно (предупреждение в finishPrecheck).
 */
export function branchAheadOfCandidate(dir: string, t: Task, rec: PrecheckRecord): { branch: string; candidate: string } | undefined {
  if (!t.branch || !rec.candidate || !rec.branch_tip) return undefined
  const b = resolveCommit(dir, t.branch)
  if (!b || b === rec.branch_tip) return undefined
  if (runGit(dir, ["merge-base", "--is-ancestor", b, rec.candidate], 10_000).code !== 1) return undefined
  const tb = runGit(dir, ["rev-parse", `${b}^{tree}`], 10_000), tc = runGit(dir, ["rev-parse", `${rec.candidate}^{tree}`], 10_000)
  if (tb.ok && tc.ok && tb.out.trim() === tc.out.trim()) return undefined
  return { branch: b, candidate: rec.candidate }
}

/** Замок отпущен службой, потому что проверенный кандидат уже в главной ветке: запись зелёная, этого круга и помечена `landed`. */
export const landedFresh = (t: Task): boolean => !!t.precheck?.landed && t.precheck.state === "green" && t.precheck.round === roundOf(t)

/** Перечитать задачу с диска и убедиться, что она по-прежнему на приёмке у этой сессии (после `await` чтения вершины). */
const fresh = (t: Task, session: string): Task | undefined => {
  const cur = loadTask(t.project, t.n)
  return cur && cur.status === "reviewing" && cur.reviewer === session ? cur : undefined
}
const REREAD = "за время чтения вершины задача изменилась (статус, приёмщик или запись); запись не тронута, повтори"

/** Начало предпроверки: прочитать вершину целевой ветки и записать «идёт» на ней (REQ-06). Замок не берётся. */
export async function beginPrecheck(t: Task, session: string, target: string): Promise<string> {
  const tip = await readTip(repoDir(t), target)
  await seams.afterTip?.()
  if (!tip.ok) return `Предпроверка не начата: вершину ${target} узнать не удалось (${tip.error}). Запись задачи не менялась; повтори позже.`
  const cur = fresh(t, session)
  if (!cur) return `Предпроверка не начата: ${REREAD}.`
  const rec = cur.precheck
  if (isLive(rec) && rec.base === tip.tip && rec.round === roundOf(cur)) {
    if (rec.state === "green") return `Предпроверка уже зелёная на ${short(rec.base)} (кандидат ${short(rec.candidate ?? "")}, ${hm(rec.green_at ?? rec.at)}); ${target} пока на той же вершине. Дальше — crew_task {action: "merge", n: ${t.n}}: замок выдастся на эту вершину.${neighbourHints(cur, "running")}`
    return `Предпроверка уже идёт с ${hm(rec.at)} на вершине ${rec.base} (${target}). Влей эту вершину в кандидата, прогони CI и заверши: crew_task {action: "precheck", n: ${t.n}, candidate: "<ветка или хеш>", result: "<чем подтверждено>"}.${neighbourHints(cur, "running")}`
  }
  const now = Date.now()
  cur.precheck = { state: "running", base: tip.tip, at: now, by: session, round: roundOf(cur) }
  const held = mergeHolder(cur.project)
  const note = isLive(rec) ? `предпроверка начата заново на ${short(tip.tip)} (прежняя на ${short(rec.base)}: ${rec.state === "green" ? "зелёная" : "шла"}, ${target} сдвинулась)` : `предпроверка начата на ${short(tip.tip)}`
  taskEvent(cur, session, undefined, note)
  const lockNote = held && held.session === session && held.n === cur.n ? ` Замок вливания у тебя уже есть для этой задачи и остаётся; если он не нужен — crew_task {action: "unlock", n: ${t.n}}.` : ""
  return `Предпроверка начата: ${target} на origin сейчас ${tip.tip}. Влей эту вершину в кандидата (например, в ветку integrate/t${t.n}; имя плагин не навязывает), прогони CI и заверши: crew_task {action: "precheck", n: ${t.n}, candidate: "<ветка или хеш>", result: "<чем подтверждено: строка CI>"}. Замок вливания этим действием не берётся: merge выдаст его только на эту же вершину.${lockNote}${neighbourHints(cur, "running")}`
}

/** Коммит по имени или хешу из локального репозитория задачи: полный хеш или undefined. */
function resolveCommit(dir: string, ref: string): string | undefined {
  const r = runGit(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 10_000)
  const h = r.out.trim()
  return r.ok && HASH.test(h) ? h : undefined
}
const FETCH_HINT = "подтяни объекты (git fetch) вручную и повтори, передав origin/<ветка> или хеш: короткое имя ветки, которая есть только на origin, после fetch не находится"

/** Завершение предпроверки: кандидат и результат (REQ-07). Любой отказ запись не меняет. */
export async function finishPrecheck(t: Task, session: string, target: string, input: { candidate?: string; result?: string }): Promise<string> {
  const rec0 = t.precheck
  const refuse = (why: string) => `Предпроверка не завершена: ${why}. Запись задачи не изменена${isLive(rec0) ? ` (остаётся ${rec0.state === "green" ? "зелёной" : "«идёт»"} на ${short(rec0.base)})` : ""}.`
  if (!isLive(rec0)) return `Предпроверка не завершена: записи «идёт» или «зелёная» нет${rec0 ? ` (прежняя устарела: ${rec0.stale?.reason ?? "?"})` : ""}. Начни: crew_task {action: "precheck", n: ${t.n}} (без candidate и result).`
  if (rec0.round !== roundOf(t)) return refuse(`запись прежнего круга, а задачу с тех пор возвращали; начни заново: crew_task {action: "precheck", n: ${t.n}}`)
  const result = String(input.result ?? "").trim()
  const candidate = String(input.candidate ?? "").trim()
  if (!result) return refuse("нужен result — чем подтверждено (строка CI), непустой")
  if (!candidate) return refuse("нужен candidate — ветка или хеш собранного кандидата")
  const held = mergeHolder(t.project)
  if (held && held.session === session && held.n === t.n) return refuse(`замок вливания уже у тебя для этой задачи; сначала crew_task {action: "unlock", n: ${t.n}}`)
  const dir = repoDir(t)
  if (!resolveCommit(dir, rec0.base)) return refuse(`основы ${short(rec0.base)} нет в локальном репозитории задачи (${dir}); ${FETCH_HINT}`)
  const cand = resolveCommit(dir, candidate)
  if (!cand) return refuse(`кандидата «${candidate}» нет в локальном репозитории задачи (${dir}); ${FETCH_HINT}`)
  const anc = runGit(dir, ["merge-base", "--is-ancestor", rec0.base, cand], 10_000)
  if (!anc.ok) return refuse(anc.code === 1 ? `кандидат ${short(cand)} не содержит основу ${short(rec0.base)}: влей ${target} на этой вершине (${rec0.base}) в кандидата и прогони CI заново` : `не удалось сверить кандидата с основой (git merge-base: ${anc.err || `код ${anc.code}`})`)
  const tip = await readTip(dir, target)
  await seams.afterTip?.()
  if (!tip.ok) return refuse(`вершину ${target} узнать не удалось (${tip.error})`)
  const cur = fresh(t, session)
  const rec = cur?.precheck
  if (!cur || !isLive(rec) || rec.base !== rec0.base || rec.at !== rec0.at || rec.round !== rec0.round) return refuse(REREAD)
  let warn = ""
  let branchTip: string | undefined
  if (t.branch) {
    const b = resolveCommit(dir, t.branch) ?? resolveCommit(dir, `origin/${t.branch}`)
    branchTip = b
    if (b && runGit(dir, ["merge-base", "--is-ancestor", b, cand], 10_000).code === 1)
      warn = ` Внимание: ветка задачи ${t.branch} не входит в кандидата (его могли собрать перебазированием или squash); приёмщик сверяет содержимое сам — это предупреждение, не отказ.`
  }
  const now = Date.now()
  const replaced = rec.state === "green"
  cur.precheck = { state: "green", base: rec.base, at: rec.at, by: rec.by, round: rec.round, candidate: cand, ...(branchTip ? { branch_tip: branchTip } : {}), result: result.slice(0, 500), green_at: now }
  taskEvent(cur, session, undefined, replaced ? `предпроверка: запись заменена на ${short(rec.base)} (кандидат ${short(rec.candidate ?? "")} → ${short(cand)}): ${result.slice(0, 200)}` : `предпроверка зелёная на ${short(rec.base)} (кандидат ${short(cand)}): ${result.slice(0, 200)}`)
  const moved = tip.tip !== rec.base
  return `Предпроверка зелёная на ${short(rec.base)} (кандидат ${short(cand)}, результат: ${result.slice(0, 200)}). ${
    moved ? `Но ${target} уже сдвинулась: сейчас ${short(tip.tip)} (проверено ${hm(now)}). Начни заново: crew_task {action: "precheck", n: ${t.n}} (эта запись остаётся, пока не начнёшь новую); замок на сдвинутую вершину не выдастся.` : `${target} пока не сдвинулась. Дальше — crew_task {action: "merge", n: ${t.n}}: замок выдастся на эту вершину.`
  }${warn}`
}

/** Отпустить замок вливания, который сессия держит для этой задачи (REQ-10). Запись устаревает («замок отпущен»). */
export function unlockMerge(t: Task, session: string): string {
  const h = mergeHolder(t.project)
  if (!h) return `Замка вливания проекта ${t.project} нет — отпускать нечего.`
  if (h.session !== session) return `Замок вливания проекта ${t.project} не твой (держит приёмщик задачи #${h.n}); чужой замок unlock не снимает.`
  if (h.n !== t.n) return `Твой замок вливания — для задачи #${h.n}, а не #${t.n}: unlock {n: ${h.n}}.`
  releaseMergeLock(t.project, session, t.n)
  markPrecheckStale(t, "замок отпущен")
  taskEvent(t, session, undefined, "замок вливания отпущен (unlock); предпроверка устарела")
  return `Замок вливания проекта ${t.project} отпущен. Предпроверка устарела (замок отпущен): чтобы вливать, начни заново — crew_task {action: "precheck", n: ${t.n}}.`
}

/**
 * Автоотпускание замка слияния (задача 005, решение владельца 2026-10-09). Замок держит приёмщик задачи, чей проверенный кандидат
 * (запись «зелёная») уже предок вершины главной ветки на origin: слияние сделано, ждёт только accept, а замок висит. Служба на
 * проходе отпускает его. Только чтение: вершина — `ls-remote` со сроком 20 с, предок — `merge-base --is-ancestor` по локальным
 * объектам, без fetch. Не отпускает: нет замка, задача другая или не на приёмке у держателя, запись не «зелёная», кандидат совпадает с основой, вершина не
 * прочитана или не с origin, кандидат не предок (в том числе объектов нет), замок за время чтения сменился. Плагин ничего не
 * вливает и не пушит. Возвращает строку для журнала или undefined.
 */
export async function releaseLandedLock(project: string, target: string): Promise<string | undefined> {
  const lock = mergeHolder(project)
  if (!lock) return undefined
  const t = loadTask(project, lock.n)
  const rec = t?.precheck
  if (!t || t.status !== "reviewing" || t.reviewer !== lock.session || !rec || rec.state !== "green" || rec.round !== roundOf(t) || !rec.candidate || rec.candidate === rec.base) return undefined // кандидат = основа: своего содержимого нет, «влитым» его считать нельзя
  const tip = await (seams.readTip ?? originTip)(repoDir(t), target)
  if (!tip.ok || tip.source !== "origin") return undefined
  if (runGit(repoDir(t), ["merge-base", "--is-ancestor", rec.candidate, tip.tip], 10_000).code !== 0) return undefined
  if (!holdsFor(project, lock.session, lock.n, lock.at)) return undefined // за время чтения замок сменился
  const cur = loadTask(project, lock.n)
  if (!cur || cur.status !== "reviewing" || !cur.precheck || cur.precheck.state !== "green" || cur.precheck.green_at !== rec.green_at) return undefined
  releaseMergeLock(project, lock.session, lock.n)
  cur.precheck = { ...cur.precheck, landed: { tip: tip.tip, at: Date.now() } }
  taskEvent(cur, "crew-harness", undefined, `замок отпущен: слияние на вершине ${short(tip.tip)} (проверенный кандидат ${short(rec.candidate)} уже в ${target}); дальше accept, уборка без замка`)
  return `merge lock of ${project} #${lock.n} released: landed on ${short(tip.tip)}`
}

// ---- ВОРОТА `merge` (REQ-08, REQ-12). Четыре сверки — однострочные функции с маркерами `GATE:*`: доказательство красного
// (test/landing-red.mjs) подменяет ровно одну такую строку заглушкой и смотрит, что нужные ячейки краснеют.
/** вершина целевой ветки совпала с основой записи */
const sameTip = (tip: string, base: string): boolean => tip === base // GATE:same-tip
/** запись зелёная и этого круга */
const isFresh = (rec: PrecheckRecord | undefined, t: Task): boolean => !!rec && rec.state === "green" && rec.round === roundOf(t) // GATE:green
/** запись, перечитанная с диска после чтения вершины, всё ещё та же зелёная */
const recordUnchanged = (cur: PrecheckRecord | undefined, rec: PrecheckRecord): boolean => !!cur && cur.state === "green" && cur.base === rec.base && cur.round === rec.round && cur.at === rec.at && cur.green_at === rec.green_at // GATE:recheck
/** замок вливания проекта держит именно эта сессия и именно для этой задачи (сессия одна, задач у приёмщика несколько); с `at` — ещё и тот же экземпляр замка (метка `at` записана при взятии в этом вызове) */
const holdsFor = (project: string, session: string, n: number, at?: number): boolean => {
  const h = mergeHolder(project)
  return !!h && h.session === session && h.n === n && (at === undefined || h.at === at)
}
const lockStillMine = (project: string, session: string, n: number, at?: number): boolean => holdsFor(project, session, n, at) // GATE:lock
/** можно ли отпустить замок: он этой сессии, этой задачи и (если дана метка) взят в этом же вызове */
const mayRelease = (project: string, session: string, n: number, at?: number): boolean => holdsFor(project, session, n, at) // GATE:release
/** Отпустить замок, только если он этого вызова: замок, взятый той же сессией для другой задачи или другим вызовом для той же, не трогаем. */
const releaseOwnLock = (project: string, session: string, n: number, at?: number): void => {
  if (mayRelease(project, session, n, at)) releaseMergeLock(project, session, n)
}

export type Gate = { text: string } | { granted: string }

/**
 * Замок вливания при merge_precheck: required (по умолчанию). Порядок (план 005, «Ворота merge»): запись зелёная и этого круга; держание замка
 * узнаётся по mergeHolder до takeMergeLock; повтор держателя — сначала «уже влито», затем чтение вершины; замок берётся, вершина
 * читается ПОД замком; не совпала с основой — замок отпускается и отказ называет обе вершины; затем запись перечитывается с диска
 * и сверяется, замок сверяется ещё раз и только тогда в запись пишется «замок на вершине». `await` стоит только в чтении
 * вершины, всё после него — один синхронный отрезок.
 */
export async function gateMerge(t: Task, session: string, target: string): Promise<Gate> {
  const project = t.project
  const dir = repoDir(t)
  const rec = t.precheck
  const base = rec?.base ?? ""
  const refuse = (why: string, next = "") => ({ text: `Замок не выдан: ${why}.${next ? ` ${next}` : ""}` })
  const start = `Начни с crew_task {action: "precheck", n: ${t.n}} без замка: назову вершину ${target}; влей её вместе с веткой задачи в candidate (например, integrate/t${t.n}), прогони полный CI проекта, сохрани точный проверенный commit и заверши precheck {candidate, result}. Замок бери только после зелёной записи; после merge fast-forward влей именно этот candidate. Если вершина сдвинулась — старый candidate не вливай, повтори интеграцию и CI.`
  // 2. запись предпроверки
  if (!isFresh(rec, t)) {
    if (!rec) return refuse(`merge без предпроверки отклоняется: у задачи ${taskRef(t)} нет зелёной предпроверки (в проекте merge_precheck: required)`, `${start} Затем снова вызови merge: замок выдаётся только на ту вершину, на которой проверен кандидат. Чужое вливание до замка не задерживается. Прежний порядок возвращает интегратор явным ключом merge_precheck: off.${mergeHolder(project)?.session === session ? ` Замок вливания у тебя уже есть: если предпроверку делать позже, отпусти его: crew_task {action: "unlock", n: ${t.n}}.` : ""}`)
    if (rec.state === "running") return refuse(`предпроверка задачи ${taskRef(t)} ещё идёт (кандидат не завершён)`, `Заверши её: crew_task {action: "precheck", n: ${t.n}, candidate, result}.`)
    if (rec.state === "stale") return refuse(`предпроверка задачи ${taskRef(t)} устарела (${rec.stale?.reason ?? "причина не записана"})`, start)
    return refuse(`запись предпроверки прежнего круга: задачу с тех пор возвращали или передавали`, start)
  }
  // 3. держание замка — до любого takeMergeLock
  const holder = mergeHolder(project)
  if (holder && holder.session === session && holder.n !== t.n) return refuse(`замок у тебя уже для #${holder.n}; сначала accept, rework или unlock по ней`)
  const hadLock = !!holder && holder.session === session && holder.n === t.n
  // 4. повтор держателя: ветка уже влита (вершина сдвинута самим вливанием)
  if (hadLock) {
    const m = isMerged(t, target)
    if (m.ok) {
      seams.afterMerged?.()
      if (lockStillMine(project, session, t.n)) {
        const cur = loadTask(project, t.n) ?? t
        taskEvent(cur, session, undefined, "повтор merge: уже влито")
        return { text: `Ветка уже влита в ${target} (${m.how}); замок остаётся у тебя. Вызови crew_task {action: "accept", n: ${t.n}, ...}: повтор merge не нужен.` }
      }
      return { text: `Ветка уже влита в ${target} (${m.how}), но замок вливания снят (cancel или rework по другой задаче, перехват). accept без замка откажет. Повтори merge: он увидит вершину, сдвинутую самим вливанием, и откажет «сдвинулась»; нужна новая предпроверка.` }
    }
  }
  // 5. замок
  const got = takeMergeLock(project, session, t.n)
  if (!got.ok) return { text: `Замок вливания проекта ${project} у приёмщика задачи #${got.holder.n} (сессия ${got.holder.session}) с ${hm(got.holder.at)}. Дождись (спроси позже ещё раз) — вливать одновременно нельзя. Твоя предпроверка остаётся действующей, пока ${target} не сдвинется.` }
  const stamp = mergeHolder(project)?.at // метка этого экземпляра замка: по ней шаги 6–9 узнают «мой» замок, а не взятый параллельным вызовом
  // 6. вершина — под замком
  const tip = await readTip(dir, target)
  await seams.afterTip?.()
  if (!tip.ok) {
    if (!hadLock) releaseOwnLock(project, session, t.n, stamp)
    return hadLock
      ? { text: `Вершину ${target} узнать не удалось (${tip.error}). Замок остаётся у тебя, как был; повтори merge позже или отпусти его: crew_task {action: "unlock", n: ${t.n}}.` }
      : refuse(`вершину ${target} на origin узнать не удалось (${tip.error})`, "Замок не взят; повтори merge через минуту. Влить без origin всё равно нельзя.")
  }
  // 7. вершина сдвинулась
  if (!sameTip(tip.tip, base)) {
    releaseOwnLock(project, session, t.n, stamp)
    const cur = loadTask(project, t.n)
    if (cur && hadLock) {
      markPrecheckStale(cur, "главная сдвинулась")
      taskEvent(cur, session, undefined, `merge отказан: ${target} сдвинулась (${short(base)} → ${short(tip.tip)})`)
    }
    return refuse(`${target} сдвинулась — предпроверка зелёная на ${short(base)}, сейчас на origin ${short(tip.tip)} (проверено ${hm(Date.now())})`, `Замок не взят${hadLock ? "; запись устарела" : ""}. Повтори предпроверку.${neighbourHints(cur ?? t, "moved")}`)
  }
  // 7b. кандидат должен быть fast-forward от вершины под замком (код 1 — не потомок; иное — не удалось узнать, не отказ)
  if (rec?.candidate && runGit(dir, ["merge-base", "--is-ancestor", tip.tip, rec.candidate], 10_000).code === 1) {
    releaseOwnLock(project, session, t.n, stamp)
    const cur = loadTask(project, t.n)
    if (cur && hadLock) markPrecheckStale(cur, "кандидат не от вершины")
    return refuse(`кандидат ${short(rec.candidate)} не fast-forward от вершины ${target} под замком (${short(tip.tip)})`, `Замок не взят${hadLock ? "; запись устарела" : ""}. Собери кандидата заново от этой вершины и повтори предпроверку.`)
  }
  // 7c. ветка задачи ушла вперёд кандидата после его фиксации (задача 030)
  const ahead = rec ? branchAheadOfCandidate(dir, t, rec) : undefined
  if (ahead) {
    releaseOwnLock(project, session, t.n, stamp)
    const cur = loadTask(project, t.n)
    if (cur) {
      markPrecheckStale(cur, "ветка задачи ушла вперёд кандидата")
      taskEvent(cur, session, undefined, `merge отказан: ветка задачи ${t.branch} (${short(ahead.branch)}) ушла вперёд кандидата ${short(ahead.candidate)}`)
    }
    return refuse(`ветка задачи ${t.branch} ушла вперёд кандидата: вершина ветки ${short(ahead.branch)}, кандидат ${short(ahead.candidate)}`, `Замок не взят; запись устарела. Пересобери кандидата от актуальной ветки задачи и повтори CI и precheck.`)
  }
  // 8. запись, перечитанная с диска: по-прежнему та же зелёная
  const cur = loadTask(project, t.n)
  if (!cur || !recordUnchanged(cur.precheck, rec ?? ({} as PrecheckRecord))) {
    releaseOwnLock(project, session, t.n, stamp)
    return refuse(`предпроверка задачи ${taskRef(t)} за время чтения вершины изменилась (устарела или заменена)`, `Замок отпущен. ${start}`)
  }
  // 9. замок всё ещё у этой сессии
  if (!lockStillMine(project, session, t.n, stamp)) return { text: `Замок потерян: за время чтения вершины его сняли (cancel или rework по другой задаче, перехват). Замок не выдан; повтори merge.` }
  // 10. запись «замок на вершине»; окно между сверкой и записью допустимо (README)
  cur.precheck = { ...cur.precheck!, lock_on: { tip: tip.tip, at: Date.now() } }
  taskEvent(cur, session, undefined, `замок вливания взят на вершине ${short(tip.tip)}`)
  return { granted: tip.tip }
}

/** Вершина целевой ветки, в которой принята задача: из `<цель>` и `origin/<цель>` первая существующая, где head — предок; иначе первая существующая. */
export function acceptedTip(t: Task, target: string, head?: string): string | undefined {
  const dir = repoDir(t)
  const tips = [target, `origin/${target}`].map((r) => resolveCommit(dir, r)).filter((x): x is string => !!x)
  if (!tips.length) return undefined
  if (head) for (const tp of tips) if (runGit(dir, ["merge-base", "--is-ancestor", head, tp], 10_000).ok) return tp
  return tips[0]
}

/** Что влить после merge при merge_precheck: required: ровно зафиксированный кандидат (SHA); отличие ветки задачи от него — не повод остановки. */
export function landingLine(t: Task, target: string): string {
  const cand = t.precheck?.candidate
  if (!cand) return ""
  const br = t.branch ? resolveCommit(repoDir(t), t.branch) : undefined
  const diff = t.branch && br && br !== cand ? ` Ветка задачи ${t.branch} (${short(br)}) отличается от проверенного кандидата, это нормально (squash/пересборка): влей кандидата.` : ""
  return `Вливается ровно проверенный кандидат ${cand} (${short(cand)}): fast-forward ${target} до него и push кандидата в ${target} (git push origin ${cand}:${target}); ветку задачи не вливай.${diff}`
}
