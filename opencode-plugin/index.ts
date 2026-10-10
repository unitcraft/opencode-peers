// plugins/nova-peers — переписка между окнами (сессиями) OpenCode во ВСЕХ репозиториях.
//
// ЗАЧЕМ. В Claude Code окна говорили через `/crew` и `SendMessage` по ИМЕНИ сессии,
// а имя менялось при каждом перезапуске, поэтому держались ещё визитки
// (`scripts/tools/session-card.sh`). В OpenCode ни того, ни другого нет; плагин
// команд Ensemble на V2 не работает (hueyexe/opencode-ensemble#40). Решение
// владельца 2026-10-03: свой плагин, адресат — РОЛЬ, а не имя.
//
// УСТРОЙСТВО. Ящик — в каталоге данных OpenCode (`$XDG_DATA_HOME/opencode/nova-peers`,
// иначе `~/.local/share/opencode/nova-peers`): он один на машину, его видят окна
// любого репозитория, и он не лежит ни в одном из них (не попадает ни в индекс, ни
// под грепы стражей). Первая версия держала ящик в общем `.git` одного репозитория —
// окна разных репозиториев друг друга не видели (замер 2026-10-03).
//   cards/<сессия>.json   — визитка: роль, заголовок, каталог, процесс, отметка жизни;
//   inbox/<адрес>/*.json  — непрочитанные письма; адрес — роль или id сессии;
//   read/<адрес>/*.json   — доставленные (история для `crew_inbox`).
// Доставка — переносом файла из inbox в read (rename атомарен): письмо уходит
// ровно одной сессии, даже если плагин загружен в нескольких процессах.
//
// РОЛЬ. Окно без назначенной роли получает её САМО: `assistant-<6 знаков id>`
// (слово владельца 2026-10-03). Назначенная (`crew_role`) хранится в визитке и
// переживает перезапуск сессии с тем же id. Занятая живой сессией роль не
// отбирается без `force`. Субагенты (сессии с родителем) визиток не получают.
//
// ДОСТАВКА. Раз в POLL_MS процесс проверяет ящики СВОИХ сессий и кладёт письмо в
// сессию очередным сообщением (`delivery: "queue"`): простаивающее окно
// просыпается, занятое прочтёт после текущего хода. Отправка своей же сессии в том
// же процессе доставляется сразу, без ожидания опроса.

//
// ОКНА claude-code. Провайдер claude-code отбрасывает инструменты OpenCode; им те же инструменты даёт
// MCP-сервер mcp.ts поверх того же ядра (core.ts). Получение писем у них работает и так — через
// session.prompt этого плагина.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from "node:fs"
import path from "node:path"
import {
  type Card,
  type Letter,
  POLL_MS,
  QUEUE,
  INBOX,
  READ,
  BASE,
  DEFAULT_ROLE,
  normalizeRole,
  reviewerRole,
  reviewSessionLimit,
  holdsOpenTask,
  DEFAULT_SPAWN_MODELS,
  lastTurn,
  turnEnd,
  idleAt,
  openTurn,
  staleBusy,
  insideDir,
  taskPlace,
  PROCESS_START,
  userAfter,
  hhmm,
  MODEL_TTL_MS,
  log,
  repoLabel,
  parseProjects,
  projectOf,
  roleKey,
  loadConfig,
  tierOf,
  pickHolder,
  fmtModel,
  modelFromDb,
  idleAfter,
  safeKey,
  readJson,
  cardFile,
  allCards,
  asksOpen,
  saveCard,
  pidAlive,
  postLetter,
  claimLetters,
  confirmLetters,
  releaseLetters,
  recoverClaims,
  formatLetters,
  waitingIn,
  hasQuietIn,
  waitingFor,
  liveWindows,
  tabOf,
  isBusy,
  mayWakeCard,
  postNotice,
  short,
  sessionLabel,
  addObligation,
  obligationsOf,
  saveObligations,
  commonDoctor,
  DOCTOR_FILE,
  settingsProblems,
  helpFor,
  saveProjects,
  setProjects,
  makeTools,
  sessionFromDb,
  formatTaskLetter,
  postExpected,
  propagateToParent,
  PLUGIN_SENDER,
  stampClamp,
  stampProfile,
  ownerWordAfter,
  lastUserAt,
} from "./core.ts"
import { answerTurn, markInterventions } from "./answer.ts"
import { answerModesOn } from "./answer-parse.ts"
import { DECISION_RU, readApprovals, removeApproval } from "./approvals.ts"
import { runRetention } from "./retention.ts"
import { allSteps, nextPlanNumber, parsePlan, stepDeps } from "./plans.ts"
import { dropWatch, openWatchesBySession, pollWatches, requestWatch, watchesOf } from "./watch.ts"
import { endsWithQuestion, markNotified, removeStatus, saveStatus, statusOf } from "./status.ts"
import { type Task, taskRef, acceptedAt, ago, byPriority, createTask, rounds, slugify, isOpen, letterExists, listTasks, loadTask, plannedSessionId, saveTask, statusRu, taskEvent, taskLetterId, tasksChanged } from "./tasks.ts"
import { countedOpen, waitingCleanup } from "./tasks.ts"
import { createRemoteBridge } from "./remote.ts"
import { profileProblems, profileState, stateSignature, syncProjectFiles, syncSnapshot, syncTaskFile } from "./profile-layer.ts"
import { cellOfState, clampTier, resolveStageProfile, splitLaunchModel, stageOfLaunch, tabFitsCell } from "./profiles.ts"
import { catalogModels, writeCatalog } from "./model-catalog.ts"
import { ensureWorktree, fileAt, gitTraces, leftoversOf, mergeHolder, reviewLetter } from "./review.ts"
import { precheckLines, releaseLandedLock } from "./precheck.ts"
import { noteLoopLag, registerJournalTools } from "./journal.ts"

export { parseProjects, projectOf, parseAddr, HELP, helpFor } from "./core.ts"

export default {
  id: "crew-harness",
  async setup(ctx: any) {
    const mine = new Map<string, Card>() // сессии этого процесса
    const children = new Set<string>()
    const projects = parseProjects(ctx?.options)
    setProjects(projects, ctx?.options?.local)
    saveProjects(ctx?.options) // для MCP-сервера вкладок claude-code: список проектов один
    // Проект визитки: записанный в ней (вкладка сама ставит его при каждом обращении) или вычисленный по каталогу.
    const projOf = (c: Card) => c.project ?? projectOf(c.directory, projects)
    const keyOf = (c: Card) => roleKey(projOf(c), normalizeRole(c.role)) // старые визитки с assistant — это worker
    const now = () => Date.now()

    async function sessionInfo(sessionID: string): Promise<any> {
      try {
        const r = await ctx.session.get({ sessionID })
        return r?.data ?? r
      } catch {
        return undefined
      }
    }

    // Визитка сессии: создаётся при первом обращении, отметка жизни — при каждом.
    async function touch(sessionID: string, ev?: any): Promise<Card | undefined> {
      if (!sessionID || children.has(sessionID)) return undefined
      // ФАЙЛ ПЕРВЫМ, память — только запасом. Визитку правят и ДРУГИЕ сессии (crew_role force переписывает роль
      // прежнего владельца); память процесса записала бы старую роль поверх (замер 2026-10-03).
      let card = readJson<Card>(cardFile(sessionID)) ?? mine.get(sessionID)
      if (!card) {
        const info = await sessionInfo(sessionID)
        if (info?.parentID) {
          children.add(sessionID)
          return undefined
        }
        const directory = String(info?.location?.directory ?? info?.directory ?? ctx?.location?.directory ?? "")
        card = { session: sessionID, role: DEFAULT_ROLE, auto: true, title: String(info?.title ?? ""), directory, repo: repoLabel(directory), pid: process.pid, updated: now() }
        log(`card new ${sessionID} role=${card.role} repo=${card.repo}`)
      }
      if (!card.repo) card.repo = repoLabel(card.directory)
      // каждый раз: список проектов мог поменяться. Вкладка задачи или приёмки — проект своей задачи, где бы ни лежал
      // её worktree (worktree claude-limits в nv-lang/worktrees — под корнем nova; 2026-10-06)
      card.project = card.task?.project ?? card.review?.project ?? projectOf(card.directory, projects)
      // МОДЕЛЬ. Запрос (ev.model из хука запроса) главнее; запас — база (модель прошлого хода).
      const fromRequest = fmtModel(ev?.model)
      if (fromRequest) {
        card.model = fromRequest
        card.modelAt = now()
        card.modelFrom = "request"
      } else if (card.modelFrom !== "request" && (!card.model || now() - (card.modelCheckedAt ?? 0) > MODEL_TTL_MS)) {
        const db = await modelFromDb(sessionID)
        if (db) {
          card.model = db.model
          card.modelAt = db.at
          card.modelFrom = "db"
        }
        card.modelCheckedAt = now()
      }
      card.pid = process.pid
      card.updated = now()
      saveCard(card)
      mine.set(sessionID, card)
      return card
    }

    // ДОСТАВКА — без лишних ходов модели. Замеры 2026-10-05 на OpenCode 2.0.22:
    //  - session.prompt({resume: false}) кладёт письмо в очередь, но при следующем сообщении оно становится
    //    ОТДЕЛЬНЫМ шагом модели (лишний вызов);
    //  - session.synthetic({resume: false}) у свободной вкладки ждёт и встаёт перед следующим сообщением В ТОМ ЖЕ
    //    шаге (провайдер claude-code отдаёт Claude Code все такие сообщения); у занятой — становится шагом после
    //    текущего, поэтому занятой вкладке ничего не отправляем, письма ждут конца хода.
    // Отсюда: вкладка свободна — будящие письма (с ними и ждущие тихие) одним session.prompt, только вкладке, открытой
    // в живом окне, или сессии под задачу (core.ts, «ПРИСУТСТВИЕ»); одни тихие — session.synthetic без хода.
    // Ответ, которого получатель ждёт в crew_wait, не трогается: его заберёт сам crew_wait в тот же ход.
    const held = new Set<string>()
    const delivering = new Set<string>()
    const keysOf = (card: Card) => [keyOf(card), card.role, card.session]
    // Идёт ли ход: у открытой вкладки это знает её окно (плагин окна, раз в секунду); у сессии под задачу окна нет —
    // флаг визитки (хук запроса ставит, событие или строка простоя в базе снимает).
    const turnRunning = (card: Card, windows: ReturnType<typeof liveWindows>) => {
      const t = card.spawned ? undefined : tabOf(card.session, windows)
      return t ? !!t.tab.busy : !!card.busy
    }
    const staleLogged = new Set<string>()
    function delivered(card: Card, letters: Letter[], windows: ReturnType<typeof liveWindows>) {
      for (const l of letters) if (l.qid) addObligation(card.session, { qid: l.qid, from_session: l.from_session, from_role: l.from_role, at: l.time, nudges: 0 })
      // будящее письмо в фоновую вкладку — уведомление её окну (кнопка Open)
      const loud = letters.find((l) => l.wake !== false)
      const t = tabOf(card.session, windows)
      if (loud && t && !t.tab.active && t.window.pid) postNotice(t.window.pid, { sessionID: card.session, title: `✉ ${short(sessionLabel(loud.from_session, loud.from_role), 40)}`, message: short(loud.text.split(/\r?\n/)[0], 80), duration: 10_000 })
    }
    async function deliver(card: Card) {
      if (delivering.has(card.session)) return
      const keys = keysOf(card)
      if (!waitingIn(keys)) return
      const windows = liveWindows()
      const fresh = readJson<Card>(cardFile(card.session)) ?? card
      if (turnRunning(fresh, windows)) {
        // ход идёт: письма ждут его конца. Но если «идёт» только по окну, а сервер свободен дольше 10 мин (сообщение
        // потерялось при перезапуске сервиса) — не ждать вечно: доставить, сервер примет письмо новым ходом
        const tab = fresh.spawned ? undefined : tabOf(fresh.session, windows)
        const stale = tab?.tab.busy && !fresh.busy ? await staleBusy(fresh.session, now()) : 0
        if (!stale) return
        if (!staleLogged.has(fresh.session)) log(`window says ${fresh.session} is busy, the database is idle since ${stale}: delivering`)
        staleLogged.add(fresh.session)
      } else staleLogged.delete(fresh.session)
      // сессия задачи: ход, начатый не плагином (продолженный OpenCode после перезапуска), виден только по базе
      if (fresh.spawned && (await openTurn(fresh.session, now()))) return
      const open = mayWakeCard(fresh, windows)
      if (!open && !hasQuietIn(keys)) {
        if (!held.has(card.session)) log(`hold letters for ${card.session} (${keyOf(card)}): tab not open`)
        held.add(card.session)
        return
      }
      if (open) held.delete(card.session)
      delivering.add(card.session)
      try {
        let claimed = keys.flatMap((k) => claimLetters(k, `${process.pid}-${now()}`))
        const awaited = waitingFor(card.session)
        const back = claimed.filter((c) => awaited && c.letter.reply_to === awaited)
        if (back.length) releaseLetters(back)
        claimed = claimed.filter((c) => !back.includes(c))
        if (!claimed.length) return
        const loud = claimed.some((c) => c.letter.wake !== false)
        if (loud && !open) {
          // вкладка закрыта: будящие ждут, тихие можно положить в историю без хода
          const wait = claimed.filter((c) => c.letter.wake !== false)
          releaseLetters(wait)
          claimed = claimed.filter((c) => !wait.includes(c))
          if (!claimed.length) return
        }
        const letters = claimed.map((c) => c.letter)
        const text = formatLetters(letters, card)
        const wake = loud && open
        try {
          // будящее письмо начинает ход: метка wokeAt. Занятость ставит хук запроса к модели, а ход, упавший ДО запроса
          // (модель недоступна — замер Ф.7: приёмщик на claude-code/sonnet, которой нет на сервере), его не вызывает:
          // без метки конца такого хода не видно — ни напоминания, ни вызова, обязательство висит молча. Доставку
          // метка не держит (в отличие от busy).
          if (wake) markWoke(card, now())
          // предел времени: зависшая отправка держала бы вкладку в delivering навсегда (письма ей больше не шли бы)
          const capped = (p: Promise<any>) => {
            let timer: any
            return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("delivery took too long")), Number(process.env.CREW_HARNESS_STEP_MS) || 60_000)))]).finally(() => clearTimeout(timer))
          }
          if (wake) await capped(ctx.session.prompt({ sessionID: card.session, text, delivery: "queue" }))
          else if (typeof ctx.session.synthetic === "function") await capped(ctx.session.synthetic({ sessionID: card.session, text, resume: false }))
          else await ctx.session.prompt({ sessionID: card.session, text, resume: false }) // OpenCode без synthetic: лишний шаг, но без хода
          confirmLetters(claimed)
          delivered(card, letters, windows)
          log(`delivered${wake ? "" : " quietly"} ${letters.map((l) => l.id).join(",")} -> ${card.session} (${keyOf(card)})`)
        } catch (e) {
          releaseLetters(claimed)
          log(`deliver failed ${card.session}: ${e}`)
        }
      } finally {
        delivering.delete(card.session)
      }
    }

    // ЗАНЯТОСТЬ: busy ставится в хуке запроса (context), снимается строкой `idle` в базе после busySince (таймер).
    function setBusy(card: Card, busy: boolean) {
      const fresh = readJson<Card>(cardFile(card.session)) ?? card
      fresh.busy = busy
      fresh.busySince = busy ? now() : undefined
      if (!busy) fresh.wokeAt = undefined // конец хода увиден обычным путём
      saveCard(fresh)
      mine.set(fresh.session, fresh)
    }
    function markWoke(card: Card, at: number | undefined) {
      const fresh = readJson<Card>(cardFile(card.session)) ?? card
      fresh.wokeAt = at
      saveCard(fresh)
      mine.set(fresh.session, fresh)
    }

    // ПОДТАЛКИВАНИЕ (план 002, Ф.2; core.ts, «ОБЯЗАТЕЛЬСТВА»). Ход вкладки кончился, а ответа по вопросу или задаче
    // нет — напоминание сразу. Различаем рабочий ход и пустой (lastTurn: были ли вызовы инструментов): рабочий
    // обнуляет счётчик пустых, пустой его растит. push_empty_turns пустых подряд или push_max напоминаний всего —
    // вкладка застряла: напоминаний больше нет, спросившему вызов (письмо и уведомление в окне). Ход, в котором писал
    // владелец, — без напоминания (владелец ведёт вкладку сам), счётчик с нуля. Снимает застревание crew_task push.
    async function nudge(card: Card) {
      // РЕЖИМЫ ОТВЕТА НА ВОПРОСЫ (задача 007, ADR-0010): решение — первой строкой, до проверки обязательств (сессия задачи, сдавшая
      // отчёт, тоже получает ответ) и до пересылки вопроса и условия !turn?.owner (ход, начатый словом владельца, тоже). Режимы
      // выключены — ход не читается, дальше всё как раньше. handled — ни пересылки, ни «Не завершено», счётчики не растут.
      const cfgA = loadConfig(card.directory)
      if (answerModesOn(cfgA.answerMode)) {
        const endA = await turnEnd(card.session)
        if (endA) {
          const r = await answerTurn({ card, key: keyOf(card), end: endA, cfg: cfgA, now: now(), channel: "nudge", deps: { ownerWordAfter, lastUserAt } })
          if (r.handled) return
        }
      }
      const list = obligationsOf(card.session)
      if (!list.length) return
      const cfg = cfgA
      const turn = await lastTurn(card.session, card.busySince ?? 0)
      const t = now()
      // СТОРОЖ ПОТОКА (план 002.4): ход сессии задачи кончился вопросом — это не «остановилась», а «упёрлась». Вместо
      // «продолжай» (приёмщики #1 и #3 nova 2026-10-05 получили по 5–6 таких и стояли часами: вливать им было нельзя)
      // вопрос уходит тому, кто поставил задачу или спросил, письмом с побудкой. Тот решает сам или спрашивает владельца
      // («ждёт вас» у владельца) — цепочка доходит до владельца, только когда без него нельзя.
      if (card.spawned && !turn?.owner) {
        const end = await turnEnd(card.session)
        const q = end && !end.ownerAfter ? endsWithQuestion(end.text) : undefined
        if (q && end) {
          const askers = [...new Set(list.filter((o) => !o.stuck).map((o) => o.from_session))]
          const tail = end.text.replace(/\r/g, "").trim().slice(-700)
          for (const to of askers) {
            const id = `ask-${safeKey(card.session)}-${end.at}`
            if (letterExists(to, id)) continue
            const ref = card.task ?? card.review
            const what = ref ? `${card.review && !card.task ? "приёмка задачи" : "задача"} ${taskRef(ref)}` : "вопрос"
            postLetter(to, { id, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to, time: t, text: `${what}: вкладка ${keyOf(card)} (сессия ${card.session}) остановилась с вопросом, работа стоит до ответа:\n«${q}»\n\nКонец её ответа:\n${tail}\n\nОтветь ей сам: crew_send {to: "${card.session}", text: "..."}. Решить без владельца нельзя — спроси владельца (вопросом в конце своего хода).` })
            log(`question of ${card.session} forwarded to ${to}`)
          }
          if (askers.length) return // не «продолжай»: ждёт ответа
        }
      }
      // ЖДЁТ ПО-ЧЕСТНОМУ (2026-10-06, дополнение к плану 002.4): у вкладки открыто наблюдение crew_watch или её вопрос ждёт
      // ответа (expect_reply) — её разбудят концом наблюдения или ответом. Раньше «Не завершено» шло на каждый конец хода:
      // исполнитель #17 nova, ждавший чужой коммит в main, получал его раз в минуту (ход ~220 тыс. токенов) и в ответ стал
      // ждать опросом в Bash, держа ход по 9 минут.
      if (!turn?.owner) {
        const watching = watchesOf(card.session).length > 0
        const asking = !watching && asksOpen(card.session)
        if (watching || asking) {
          log(`nudge skipped ${card.session}: waits for ${watching ? "a watch" : "a reply"}`)
          return
        }
      }
      let changed = false
      for (const o of list) {
        if (o.stuck) continue
        changed = true
        if (turn?.owner) {
          o.empty = 0
          continue
        }
        // базы нет — ход считается рабочим (лишнее напоминание дешевле ложного «застряла»)
        o.empty = turn && !turn.tools ? (o.empty ?? 0) + 1 : 0
        const rv = card.review ? loadTask(card.review.project, card.review.n) : undefined
        const isReview = !!rv && rv.review_qid === o.qid
        const task = isReview ? rv : card.task ? loadTask(card.task.project, card.task.n) : undefined
        const what = isReview ? `приёмка задачи #${rv!.n} «${rv!.title}» (${statusRu(rv!.status)})` : task && task.qid === o.qid ? `задача #${task.n} «${task.title}»` : `вопрос ${o.qid}${o.task ? ` («${o.task.slice(0, 200)}»)` : ""}`
        const howTo = isReview
          ? `Продолжай приёмку: crew_task {action: "review" | "rework" | "merge" | "accept" | "cleaned", n: ${rv!.n}} (что дальше — в письме с приёмкой).`
          : `Закончил — отчёт: crew_send {to: "${o.from_session}", reply_to: "${o.qid}", text: "..."}. Упёрся — тем же ответом напиши, что мешает.`
        if (o.empty >= cfg.pushEmptyTurns || o.nudges >= cfg.pushMax) {
          o.stuck = true
          const failing = turn?.outcome === "failed" ? " (ход падает с ошибкой — посмотри модель и журнал сервера)" : ""
        const why = (o.empty >= cfg.pushEmptyTurns ? `${o.empty} хода подряд остановилась без работы и без ответа` : `${o.nudges} напоминаний остались без ответа`) + failing
          postLetter(o.from_session, {
            id: `${t}-stuck-${safeKey(o.qid)}`,
            from_role: PLUGIN_SENDER,
            from_session: PLUGIN_SENDER,
            to: o.from_session,
            time: t,
            text: `Вкладка ${keyOf(card)} (сессия ${card.session}) застряла: ${what} — ${why}. Напоминаний больше не будет. Подтолкни (crew_task {action: "push"${task ? `, n: ${task.n}` : ""}, text: "..."}), передай другой сессии (reassign) или загляни в неё сам.`,
          })
          const w = tabOf(o.from_session)
          if (w?.window.pid) postNotice(w.window.pid, { sessionID: card.session, title: task ? `#${task.n} застряла` : `${keyOf(card)} застряла`, message: short(task ? `«${task.title}» · ${why}` : why, 80), duration: 15_000 })
          if (task && task.qid === o.qid) taskEvent(task, PLUGIN_SENDER, undefined, `застряла: ${why}`)
          log(`stuck ${card.session} for ${o.qid} (empty ${o.empty}, pushes ${o.nudges})`)
          continue
        }
        o.nudges++
        postLetter(card.session, {
          id: `${t}-nudge-${safeKey(o.qid)}`,
          from_role: PLUGIN_SENDER,
          from_session: PLUGIN_SENDER,
          to: card.session,
          time: t,
          text:
            `Не завершено: ${what} от ${o.from_role} (сессия ${o.from_session}). Ты остановился, не закончив. Продолжай работу. ` +
            howTo +
            ` Ждёшь внешнего (коммит в main, чужую задачу, сборку) — crew_watch {command: "<ждёт и выходит>", note} или вопрос с expect_reply: пока они открыты, напоминаний нет, разбудят по итогу. Опросом в Bash не жди — он держит ход.` +
            (o.empty ? ` Ход без работы ${o.empty} из ${cfg.pushEmptyTurns}: дальше спросивший узнает, что вкладка стоит.` : ""),
        })
        log(`nudge ${card.session} for ${o.qid} (#${o.nudges}, empty ${o.empty})`)
      }
      if (!changed) return
      saveObligations(card.session, list)
      void deliver(readJson<Card>(cardFile(card.session)) ?? card)
    }

    // ПРЕРВАННЫЙ ХОД (замер Ф.0, п. 3): сервер оборвали посреди хода — строки `idle` нет, у сессии осталась метка
    // time_suspended, и сама OpenCode ход не продолжает. После старта плагин будит такие сессии, если у них есть
    // невыполненный вопрос или задача, одним письмом (id письма — из сессии и метки: второго не будет).
    // Граница — СТАРТ ПРОЦЕССА сервера, а не загрузка плагина: OpenCode грузит плагин заново в том же процессе на
    // каждую новую папку (замер 2026-10-05: десять загрузок за день в одном процессе). Новый экземпляр иначе считал
    // оборванными ходы, которые идут прямо сейчас (time_suspended стоит и у идущего хода), и слал работающим
    // приёмщикам «работа прервана перезапуском».
    const setupAt = PROCESS_START
    let interruptedChecked = 0
    async function resumeInterrupted() {
      if (now() - interruptedChecked < 30_000) return
      interruptedChecked = now()
      for (const c of allCards()) {
        if (children.has(c.session) || !obligationsOf(c.session).some((o) => !o.stuck)) continue
        const row = await sessionFromDb(c.session)
        if (!row?.suspended || row.suspended >= setupAt || (row.idle ?? 0) >= row.suspended) {
          await retryFailed(c)
          continue
        }
        if (!(await sessionInfo(c.session))) continue // сессия другого сервера
        // оборванный ход уже не кончится: отметку «занята» (её снимает только конец хода) снять, иначе письмо ниже
        // ждало бы конца хода вечно (замер в песочнице 2026-10-05)
        if (c.busy) setBusy(c, false)
        const id = `resume-${safeKey(c.session)}-${row.suspended}`
        if (letterExists(c.session, id)) continue
        const task = c.task ? loadTask(c.task.project, c.task.n) : undefined
        const open = obligationsOf(c.session)
          .filter((o) => !o.stuck)
          .map((o) => `— ${task && task.qid === o.qid ? `задача #${task.n} «${task.title}»` : `вопрос${o.task ? ` «${o.task.slice(0, 200)}»` : ""}`} от ${o.from_role}: отчёт — crew_send {to: "${o.from_session}", reply_to: "${o.qid}", text: "..."}`)
          .join("\n")
        // следы оборванной операции git в деревьях задачи (worktree исполнителя и главная копия) и замок вливания
        const ref = c.task ?? c.review
        const t = ref ? loadTask(ref.project, ref.n) : undefined
        const dirs = [...new Set([t?.worktree, t?.directory, c.directory].filter((d): d is string => !!d && existsSync(d)))]
        const traces = dirs.flatMap((d) => gitTraces(d))
        const lock = t && mergeHolder(t.project)?.session === c.session ? `\nЗамок вливания проекта ${t.project} всё ещё твой (приёмка ${taskRef(t)}): доведи вливание или отпусти его.` : ""
        const gitNote = traces.length ? `\nВ git осталось от оборванного хода:\n${traces.map((x) => `— ${x}`).join("\n")}` : ""
        const pre = t ? precheckLines(t, c.session).map((x) => `\n${x}`).join("") : "" // предпроверка вливания и замок (задача 005, REQ-15)
        postLetter(c.session, {
          id,
          from_role: PLUGIN_SENDER,
          from_session: PLUGIN_SENDER,
          to: c.session,
          time: now(),
          text: `Работа прервана перезапуском OpenCode (ход оборвался в ${hhmm(row.suspended)}). Продолжай с того места, где остановился: сначала проверь, что успело сделаться (файлы, коммиты, запущенные команды; git status в деревьях задачи).${gitNote}${lock}${pre}\nОткрыто:\n${open}`,
        })
        log(`resume interrupted ${c.session} (suspended ${row.suspended})`)
      }
    }

    // УПАВШИЙ ХОД ДО СТАРТА ПЛАГИНА (замер Ф.7): последний ход вкладки с открытым обязательством кончился ошибкой
    // (модель недоступна и т. п.), а плагина тогда не было или он ещё не видел такие ходы — никто её больше не будит.
    // Одно письмо «продолжай»; упадёт снова — напоминания и вызов спросившему, как у любого хода без работы.
    async function retryFailed(c: Card) {
      if (c.busy) return
      const turn = await lastTurn(c.session, 0)
      if (turn?.outcome !== "failed" || turn.at >= setupAt) return
      if (!(await sessionInfo(c.session))) return // сессия другого сервера
      const id = `retry-${safeKey(c.session)}-${turn.at}`
      if (letterExists(c.session, id)) return
      const open = obligationsOf(c.session).filter((o) => !o.stuck).map((o) => `— ${o.task ?? `вопрос ${o.qid}`} от ${o.from_role}`).join("\n")
      postLetter(c.session, {
        id,
        from_role: PLUGIN_SENDER,
        from_session: PLUGIN_SENDER,
        to: c.session,
        time: now(),
        text: `Прошлый ход (${hhmm(turn.at)}) кончился ошибкой, не дойдя до дела. Продолжай работу. Открыто:\n${open}`,
      })
      log(`retry failed turn ${c.session} (${turn.at})`)
    }

    // КОНЕЦ ЗАДАЧИ (план 002, Ф.3). Задача очищена или отменена — сессии задачи (исполнитель, приёмщик, прежние)
    // закрываются: строка в историю без хода, уведомление интегратору. Только когда ход сессии не идёт: строка,
    // записанная посреди хода, стала бы ещё одним шагом модели (замер 2026-10-05).
    async function finishTasks() {
      // НАБЛЮДЕНИЕ ДЕРЖИТ ДЕРЕВО (2026-10-07, #26 nova): наблюдение идёт с рабочей папкой сессии, у приёмщика и
      // исполнителя это дерево задачи; на Windows папку, в которой стоит процесс, не удалить — уборка принятой задачи
      // кончалась «Permission denied», а держало её как раз наблюдение «жду, пока дерево исчезнет». Задача влита
      // (accepted) или отменена — наблюдения (любой сессии) из её дерева переезжают в основную копию: тот же процесс
      // снимается, та же команда ставится заново с папкой проекта, вкладке — письмо с новым id.
      const moving = openWatchesBySession()
      if (moving.size)
        for (const t of listTasks()) {
          if ((t.status !== "accepted" && t.status !== "cancelled") || !t.worktree || !t.directory) continue
          const tree = t.worktree
          const inTree = (p: string) => path.resolve(p).toLowerCase() === path.resolve(tree).toLowerCase() || insideDir(p, tree)
          for (const ws of moving.values())
            for (const w of ws) {
              if (!w.cwd || !inTree(w.cwd) || inTree(t.directory)) continue
              dropWatch(w, log, now(), { moved: true })
              const nw = requestWatch({ session: w.session, command: w.command, cwd: t.directory, note: w.note, minutes: w.minutes, machine: w.machine, project: w.project, env: w.env })
              postLetter(w.session, {
                id: `watch-moved-${w.id}`,
                from_role: PLUGIN_SENDER,
                from_session: PLUGIN_SENDER,
                to: w.session,
                time: now(),
                text: `Наблюдение ${w.note ? `«${w.note}» ` : ""}${w.id} стояло в дереве задачи ${taskRef(t)}, а задача ${t.status === "accepted" ? "влита и дерево убирается" : "отменена"}: Windows не даёт удалить папку, в которой идёт процесс. Перенёс его в основную копию (${t.directory}) — та же команда, новый id ${nw.id}; ждать его так же.`,
              })
              log(`watch ${w.id} moved out of ${tree} as ${nw.id}`)
            }
        }
      // наблюдения сессий закрытой задачи больше не нужны: снять (иначе висят до предела, до 12 ч, и держат очередь машины)
      const open = openWatchesBySession()
      if (open.size)
        for (const t of listTasks()) {
          if (t.status !== "cleaned" && t.status !== "cancelled") continue
          for (const sid of new Set([t.executor, t.reviewer, ...t.executors, ...(t.reviewers ?? [])].filter(Boolean) as string[])) {
            const ws = open.get(sid)
            if (!ws) continue
            const c = readJson<Card>(cardFile(sid))
            const other = [c?.task, c?.review].some((r) => r && (r.project !== t.project || r.n !== t.n) && isOpen(loadTask(r.project, r.n) ?? ({ status: "closed" } as Task)))
            if (other) continue // сессия уже на другой открытой задаче
            for (const w of ws) dropWatch(w, log)
          }
        }
      for (const t of listTasks()) {
        if (t.status !== "cleaned" && t.status !== "cancelled") continue
        const sessions = [t.executor, t.reviewer, ...t.executors, ...(t.reviewers ?? [])].filter(Boolean) as string[]
        for (const sid of new Set(sessions)) {
          const c = readJson<Card>(cardFile(sid))
          if (!c?.spawned || c.spawned.status === "closed" || c.busy) continue
          if (c.pid !== process.pid && pidAlive(c.pid)) continue
          c.spawned.status = "closed"
          saveCard(c)
          const done = t.status === "cleaned"
          // отчёт приёмки по шагам — в конце истории вкладки (владелец: «+ отчёт в конце»)
          const ids = t.steps?.length ? t.steps.map((a) => a.id) : Object.keys(t.checks ?? {})
          const passed = ids.filter((id) => t.checks?.[id]).length
          const report = ids.length ? `\nОтчёт приёмки — шаги ${passed}/${ids.length}:\n${ids.map((id) => `${t.checks?.[id] ? "✓" : "–"} ${id}: ${t.checks?.[id] ?? "не отмечен (необязательный)"}`).join("\n")}` : ""
          try {
            const note = { sessionID: sid, text: done ? `✓✓ Задача ${taskRef(t)} принята и влита. Сессия закрыта — письма больше не приходят.${report}` : `✗ Задача #${t.n} отменена. Сессия закрыта — письма больше не приходят.`, resume: false }
            await (typeof ctx.session.synthetic === "function" ? ctx.session.synthetic(note) : ctx.session.prompt(note)) // строка в историю, без хода
          } catch (e) {
            log(`final note failed ${sid}: ${e}`)
          }
          if (sid === t.executor) {
            const w = tabOf(t.author)
            if (w?.window.pid) postNotice(w.window.pid, { sessionID: sid, title: done ? `#${t.n} ✓✓ готово${ids.length ? ` · шаги ${passed}/${ids.length}` : ""}` : `#${t.n} ✗ отменена`, message: done && ids.length ? `${short(t.title, 60)} · отчёт — /crew` : short(t.title, 80), duration: 10_000 })
          }
          log(`task #${t.n} (${t.project}) ${t.status}: session ${sid} closed`)
        }
      }
      // прежний путь (сессия под задачу без журнала): закрыть по отчёту
      for (const c of allCards()) {
        if (c.task || c.review || c.spawned?.status !== "done" || c.busy || (c.pid !== process.pid && pidAlive(c.pid))) continue
        c.spawned.status = "closed"
        saveCard(c)
      }
    }

    // ПРИЁМЩИК (план 002, Ф.3). Сданная задача без приёмщика получает его по приоритету (P0 первым): при reviewer
    // "integrator" — сам интегратор; иначе свободная открытая вкладка роли worker (не исполнитель, не автор, без своей
    // задачи), а нет такой — новая сессия под приёмку (лимит spawn_limits.reviewer, по умолчанию 2). Сессия приёмки
    // запускается так же повторяемо, как задача: id пишется в журнал до session.create. При reviewer "acceptor"
    // (план 002.7) — то же с ролью acceptor: вкладка годится только этой роли, сессия рождается с ней, лимит —
    // spawn_limits.acceptor (без него — reviewer).
    const reviewStarting = new Set<string>()
    async function startReviewer(t0: Task): Promise<void> {
      const key = `${t0.project}#${t0.n}`
      if (reviewStarting.has(key)) return
      reviewStarting.add(key)
      try {
        const t = loadTask(t0.project, t0.n) ?? t0
        if (!t.reviewer || t.review_kind !== "spawn" || readJson<Card>(cardFile(t.reviewer))) return
        const cfg = loadConfig(t.directory)
        // без модели от набора — spawn_models по ступени задачи, срезанной границами проекта (задача 016)
        const tierCut = clampTier(t.tier, cfg.tierBounds)
        const model = t.review_model ?? cfg.spawnModels[tierCut.tier] ?? DEFAULT_SPAWN_MODELS[tierCut.tier]
        await ctx.session.create({ id: t.reviewer, title: `#${t.n} приёмка ${t.title}`, location: { directory: t.directory }, metadata: { crewReview: { project: t.project, n: t.n } }, model: splitLaunchModel(model) })
        const now = Date.now()
        // роль сессии приёмки — по настройке reviewer (план 002.7): acceptor несёт права вливания и принятия
        const card: Card = { session: t.reviewer, role: reviewerRole(cfg), auto: false, title: `#${t.n} приёмка ${t.title}`, directory: t.directory, repo: repoLabel(t.directory), project: t.project, model, modelAt: now, modelFrom: "request", pid: process.pid, updated: now, spawned: { by: t.author, task: `приёмка #${t.n}`, tier: t.review_model ? t.tier : tierCut.tier, status: "running", at: now, qid: t.review_qid ?? "" }, review: { project: t.project, n: t.n } }
        saveCard(card)
        mine.set(card.session, card)
        // след профиля приёмки (задача 003): набор, этап, семья, ступень; окно у приёмки — общие настройки (general)
        const rch = t.review_model ? resolveStageProfile(profileState(t.directory).state, stageOfLaunch(t, "reviewer"), { taskTier: t.tier }) : undefined
        if (rch && !("refuse" in rch) && rch.model === model) stampProfile(t, "reviewer", t.reviewer, rch, false)
        else if (!t.review_model) stampClamp(t, "reviewer", t.reviewer, stageOfLaunch(t, "reviewer"), model, tierCut.tier, tierCut.from)
        await reviewerAssigned(t, card)
        log(`task #${t.n} (${t.project}): reviewer session ${t.reviewer} started`)
      } catch (e) {
        log(`reviewer start #${t0.n} failed: ${e}`)
      } finally {
        reviewStarting.delete(key)
      }
    }
    // Приёмщик назначен (вкладка или сессия): обязательство и письмо с приёмкой (id письма — из номера и попытки).
    async function reviewerAssigned(t: Task, card: Card) {
      const cfg = loadConfig(t.directory)
      if (!obligationsOf(card.session).some((o) => o.qid === t.review_qid)) addObligation(card.session, { qid: t.review_qid!, from_session: t.author, from_role: t.author_role, at: Date.now(), nudges: 0, task: `приёмка #${t.n}` })
      const id = t.review_letter ?? `review-${safeKey(t.project)}-${t.n}-${(t.reviewers ?? []).length + 1}`
      if (t.review_letter !== id) {
        t.review_letter = id
        saveTask(t)
      }
      if (!letterExists(card.session, id)) postLetter(card.session, { id, from_role: t.author_role, from_session: t.author, to: card.session, time: Date.now(), text: reviewLetter(t, cfg) })
      void deliver(card)
    }

    // СВЕРКА ЖУРНАЛА (план 002, Ф.4). OpenCode могут закрыть посреди любого действия: статус записан, а письмо, отметка
    // приёмщика или обязательство — нет. Каждые 2 с проход приводит всё к журналу: недостающие письма (постоянные id —
    // без повторов), отметка приёмщика на его визитке, письмо с приёмкой, обязательства исполнителя и приёмщика (только
    // если их нет совсем — счётчики напоминаний не сбрасываются).
    let reconciledAt = 0
    async function reconcile() {
      if (now() - reconciledAt < 2_000) return
      reconciledAt = now()
      for (const t of listTasks()) {
        if (t.parent && now() - t.updated < 24 * 3600_000) propagateToParent(t) // заказ другого проекта идёт за этой задачей
        const recent = t.status === "cleaned" && now() - t.updated < 24 * 3600_000
        if (!isOpen(t) && !recent) continue
        const author = readJson<Card>(cardFile(t.author))
        if (author && author.pid !== process.pid && pidAlive(author.pid)) continue // сверяет процесс автора
        postExpected(t)
        if (t.status === "starting") continue // запуск доделает resumeTasks
        const need = (session: string | undefined, qid: string | undefined, what: string) => {
          if (session && qid && !obligationsOf(session).some((o) => o.qid === qid)) addObligation(session, { qid, from_session: t.author, from_role: t.author_role, at: now(), nudges: 0, task: what })
        }
        if (t.status === "running" || t.status === "rework") need(t.executor, t.qid, t.title)
        if (t.reviewer && ["submitted", "reviewing", "accepted"].includes(t.status)) {
          const rc = readJson<Card>(cardFile(t.reviewer))
          if (!rc) continue // сессия приёмки ещё не создана — её запустит assignReviewers
          if (!rc.review || rc.review.n !== t.n || rc.review.project !== t.project) {
            rc.review = { project: t.project, n: t.n }
            saveCard(rc)
          }
          if (!t.review_letter || !letterExists(t.reviewer, t.review_letter)) await reviewerAssigned(t, rc)
          if (!(t.status === "submitted" && rounds(t) > 0)) need(t.reviewer, t.review_qid, `приёмка ${taskRef(t)}`)
        }
      }
    }
    async function assignReviewers() {
      const windows = liveWindows()
      const queue = listTasks().filter((t) => t.status === "submitted" && !t.reviewer).sort(byPriority)
      for (const t0 of queue) {
        const t = loadTask(t0.project, t0.n)
        if (!t || t.status !== "submitted" || t.reviewer) continue
        const author = readJson<Card>(cardFile(t.author))
        if (author && author.pid !== process.pid && pidAlive(author.pid)) continue // назначает процесс автора
        const cfg = loadConfig(t.directory)
        t.review_qid = `r${t.qid}`
        if (cfg.reviewer === "integrator") {
          t.reviewer = t.author
          t.review_kind = "integrator"
          taskEvent(t, PLUGIN_SENDER, undefined, "приёмщик — интегратор (настройка reviewer)")
          const ac = author ?? (readJson<Card>(cardFile(t.author)) as Card)
          if (ac) {
            ac.review = { project: t.project, n: t.n }
            saveCard(ac)
            await reviewerAssigned(t, ac)
          }
          continue
        }
        // ПРОФИЛЬ ПРИЁМКИ ПО ВКЛЮЧЁННОМУ НАБОРУ (задача 003). Ветка reviewer: integrator выше от набора не зависит. Этап описан, а
        // профиль не находится — приёмщика нет: задача остаётся «сдана», интегратору одно письмо (постоянный id), строка в crew_doctor.
        const pstate = profileState(t.directory).state
        const rstage = stageOfLaunch(t, "reviewer")
        const chosen = resolveStageProfile(pstate, rstage, { taskTier: t.tier })
        if (chosen && "refuse" in chosen) {
          const id = `review-refused-${safeKey(t.project)}-${t.n}-${safeKey(chosen.refuse).slice(0, 60)}`
          if (!letterExists(t.author, id)) {
            postLetter(t.author, { id, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: t.author, time: now(), text: `Задача ${taskRef(t)} сдана, но приёмщик не назначен: ${chosen.refuse}. Исправь профили или переключи набор (/crew-sets, /crew-profiles); приёмщик назначится сам.` })
            taskEvent(t, PLUGIN_SENDER, undefined, `приёмщик не назначен: ${chosen.refuse}`)
          }
          continue
        }
        const rcell = cellOfState(pstate, rstage)
        const rprofiles = pstate.usable?.data.profiles
        const tab = allCards().find(
          (c) =>
            !c.spawned &&
            tabFitsCell(rcell, c.model, rprofiles) && // явная ступень клетки — только вкладка семьи клетки (REQ-07)
            (c.project ?? projectOf(c.directory, projects)) === t.project &&
            normalizeRole(c.role) === reviewerRole(cfg) &&
            c.session !== t.executor &&
            c.session !== t.author &&
            !(t.reviewers ?? []).includes(c.session) && // перепроверка плана: каждый раунд — новая сессия (план 004)
            !holdsOpenTask(c) &&
            !!tabOf(c.session, windows)?.window.pid &&
            !tabOf(c.session, windows)?.tab.busy,
        )
        if (tab) {
          t.reviewer = tab.session
          t.review_kind = "tab"
          taskEvent(t, PLUGIN_SENDER, undefined, `приёмщик — открытая вкладка ${tab.session}`)
          tab.review = { project: t.project, n: t.n }
          saveCard(tab)
          await reviewerAssigned(t, tab)
          continue
        }
        const limit = reviewSessionLimit(cfg)
        // задача на доработке места не держит: следующий шаг — исполнителя, приёмщик ждёт без хода (правило «блокирует ли
        // незакрытая задача новую» методологии: ждём чужого хода — не блокирует). Досданную будит прежний приёмщик сразу.
        const reviewing = listTasks(t.project).filter((x) => isOpen(x) && x.review_kind === "spawn" && x.reviewer && x.status !== "accepted" && x.status !== "rework").length
        if (t.priority !== "P0" && reviewing >= limit) continue // ждёт: приёмщиков-сессий уже limit
        if (chosen) t.review_model = chosen.model
        else delete t.review_model
        t.reviewer = plannedSessionId()
        t.review_kind = "spawn"
        taskEvent(t, PLUGIN_SENDER, undefined, `приёмщик — новая сессия ${t.reviewer}`)
        await startReviewer(t)
      }
      // сессия приёмки записана, но не создана (оборвался запуск) — повторить тем же id
      for (const t of listTasks()) if (isOpen(t) && t.review_kind === "spawn" && t.reviewer && !readJson<Card>(cardFile(t.reviewer))) await startReviewer(t)
    }

    // ПРОФИЛИ МОДЕЛЕЙ (задача 003). Раз в проход, но тяжёлое — только когда сменилась подпись входных данных (три ключа
    // файла, снимок): снимок допустимого состояния (создаётся на первом допустимом проходе, обновляется, отбрасывается на
    // строках 1 и 7 таблицы исходов), уведомление окнам о новых проблемах профилей.
    const profileSigs = new Map<string, string>()
    let profilesSaid = ""
    let profilesAt = 0
    let profilesRunAt = 0
    const PROFILES_MS = Number(process.env.CREW_HARNESS_PROFILES_MS) || 10_000 // чтение настроек — процессы git: не чаще раза в 10 с
    async function profilesStep() {
      if (now() - profilesRunAt < PROFILES_MS) return
      profilesRunAt = now()
      let changed = false
      for (const p of projects) {
        const dir = p.dir ?? p.rootPath
        if (!dir) continue
        try {
          const ps = profileState(dir)
          const sig = stateSignature(ps)
          if (profileSigs.get(p.name) !== sig) {
            changed = true
            profileSigs.set(p.name, sig)
            const after = syncSnapshot(dir)
            profileSigs.set(p.name, stateSignature(after))
          }
          // файлы окон в деревьях задач: первый проход после старта безусловно, дальше — сверка с набором и задачами (задача 003, REQ-09)
          const rep = syncProjectFiles(dir)
          if (rep.written.length || rep.removed.length) log(`profile windows of ${p.name}: written ${rep.written.length}, removed ${rep.removed.length}`)
          for (const e of rep.errors) log(`profile windows of ${p.name}: ${e}`)
        } catch (e) {
          log(`profiles step of ${p.name} failed: ${e}`)
        }
      }
      if (!changed && now() - profilesAt < 30_000) return
      profilesAt = now()
      const problems = profileProblems(true)
      const said = problems.join(" | ")
      if (said === profilesSaid) return
      profilesSaid = said
      if (!problems.length) return
      log(`profiles: ${said}`)
      for (const w of liveWindows()) postNotice(w.pid, { title: "crew: профили моделей — /crew-sets check", message: short(problems.join("; "), 100), duration: 15_000 })
    }

    // ЗАГОЛОВКИ СЕССИЙ ЗАДАЧ — из журнала: «#N название», сдана/закрыта «#N ✓», отменена «#N ✗», передана другой
    // сессии «#N ↷». Сверяются каждый проход (то, что поменял MCP-сервер или другой процесс, тоже доходит), меняются
    // через session.update — без хода модели. Вкладки владельца (assign) не переименовываются.
    // СОСТОЯНИЕ СЕССИЙ (план 003, status.ts). Раз в STATUS_EVERY_MS — status/<сессия>.json (сводка /crew окна и внешние
    // проверки, например хук проекта). Сессия закончила ход вопросом владельцу — уведомление во все живые окна (с
    // кнопкой Open и системным уведомлением, когда окно не в фокусе); не ответил — повтор через owner_reminder_min.
    // В сводке — открытые вкладки, сессии задач и те, у кого есть наблюдения или свои открытые задачи.
    const STATUS_EVERY_MS = Number(process.env.CREW_HARNESS_STATUS_MS) || 15_000
    // конец хода — из базы (5 ГБ у владельца) только когда появилась новая строка idle: сначала дешёвое время
    // последнего idle (idleAt), тяжёлое чтение сообщений — при его изменении (замер: ~0,1 с на вкладку, в главном потоке)
    const ends = new Map<string, { at: number; end: Awaited<ReturnType<typeof turnEnd>> }>()
    let statusAt = 0
    async function syncStatus() {
      if (!tasksChanged() && now() - statusAt < STATUS_EVERY_MS) return
      statusAt = now()
      const windows = liveWindows()
      const t = now()
      const cards = allCards()
      // вопросы с ответом (expect_reply) — обязательства получателя перед спросившим; задачи и приёмки — не вопросы
      const asked = new Map<string, { qid: string; to: string; at: number }[]>()
      for (const c of cards) for (const o of obligationsOf(c.session)) if (!o.task && !o.stuck) asked.set(o.from_session, [...(asked.get(o.from_session) ?? []), { qid: o.qid, to: keyOf(c), at: o.at }])
      const watchesBy = openWatchesBySession() // одно чтение папки наблюдений на проход (их сотни: завершённые хранятся сутки)
      for (const c of cards) {
        if (c.pid !== process.pid && pidAlive(c.pid)) continue // вкладка другого живого сервера
        const tab = tabOf(c.session, windows)
        const ws = watchesBy.get(c.session) ?? []
        const live = !!tab || (!!c.spawned && c.spawned.status !== "closed") || ws.length > 0 || listTasks(c.project).some((x) => x.author === c.session && isOpen(x))
        if (!live) {
          removeStatus(c.session)
          continue
        }
        // «работает» — ещё и по базе: ход открыт и обновляется (ход, продолженный самим OpenCode после перезапуска,
        // плагин не доставлял — признака busy у карточки нет; сводка писала «стоит», а сессия работала, 2026-10-05)
        const staleSince = tab?.tab.busy ? await staleBusy(c.session, t) : 0
        const busy = !staleSince && (!!tab?.tab.busy || !!c.busy || (await openTurn(c.session, t)))
        let end: Awaited<ReturnType<typeof turnEnd>> = undefined
        if (!busy) {
          const at = await idleAt(c.session)
          const hit = ends.get(c.session)
          if (hit && hit.at === at && at) end = hit.end
          else {
            end = await turnEnd(c.session)
            ends.set(c.session, { at, end })
          }
          // владелец написал после конца хода — это видно только в сообщениях: перечитать, если стоял вопрос
          if (end && !end.ownerAfter && hit && hit.at === at && (await userAfter(c.session, at))) {
            end = { ...end, ownerAfter: true }
            ends.set(c.session, { at, end })
          }
        }
        const s = statusOf({ card: c, busy, busySince: c.busySince, end, asked: asked.get(c.session) ?? [], now: t, watches: ws, ...(staleSince ? { staleSince } : {}) })
        const prev = saveStatus(s)
        // РЕЖИМЫ ОТВЕТА НА ВОПРОСЫ (задача 007, ADR-0010): решение принимается раньше блока уведомлений. Режимы выключены —
        // ничего не читается и прежний путь идёт как был. handled — «ждёт вас» по этому ходу подавлено целиком; остаток вопросов
        // на вкладке владельца уходит одним уведомлением (повтор по owner_reminder_min), markNotified не вызывается.
        const cfgA = loadConfig(c.directory)
        if (answerModesOn(cfgA.answerMode)) {
          // слово владельца после автоответа или остатка — каждый проход, даже если ход уже идёт (отзыв не ждёт конца хода)
          try {
            await markInterventions(c.session, t, { ownerWordAfter, lastUserAt })
          } catch (e) {
            log(`answer: marks of ${c.session} failed: ${e}`)
          }
          if (end && !busy) {
            const r = await answerTurn({ card: c, key: keyOf(c), end, cfg: cfgA, now: t, channel: "status", deps: { ownerWordAfter, lastUserAt } })
            if (r.handled) {
              if (r.notice) for (const w of windows) postNotice(w.pid, { sessionID: c.session, title: `${short(sessionLabel(c.session, keyOf(c)), 40)} ждёт вас`, message: r.notice.message, attention: true, duration: 30_000 })
              if (r.notice) log(`owner wanted by ${c.session}: the rest of the questions`)
              continue
            }
          }
        }
        if (s.state !== "owner") continue
        const fresh = !(prev?.state === "owner" && prev.since === s.since)
        const every = loadConfig(c.directory).ownerReminderMin * 60_000
        if (!fresh && !(every > 0 && t - (prev?.notified ?? 0) >= every)) continue
        for (const w of windows) postNotice(w.pid, { sessionID: c.session, title: `${short(sessionLabel(c.session, keyOf(c)), 40)} ждёт вас`, message: short(s.question ?? "", 100), attention: true, duration: 30_000 })
        markNotified(c.session, t)
        log(`owner wanted by ${c.session}${fresh ? "" : " (reminder)"}`)
      }
    }

    // СТОРОЖ ПОТОКА (план 002.4): раз в минуту — затянувшееся. Замок вливания держат дольше stall_minutes; сданная задача
    // ждёт приёмщика дольше stall_minutes (места заняты) — письмо с побудкой поставившему задачу (интегратору): что
    // стоит, кто держит, что можно сделать. Одно письмо на случай (id из проекта, номера и времени начала).
    let flowAt = 0
    // СОГЛАСОВАНИЕ ПЛАНОВ (план 004, шаг 3). Решение владельца приходит файлом из окна (/plans, approvals.ts):
    // «вернуть» — план автору с замечаниями владельца, перепроверка заново; «согласовать» — план уходит приёмщику
    // вливания (новая сессия): вписать решение в план, влить, accept. План на согласовании — уведомление во все окна,
    // повтор через owner_reminder_min.
    function applyApprovals() {
      for (const a of readApprovals()) {
        const t = loadTask(a.project, a.n)
        removeApproval(a.project, a.n)
        if (!t?.plan || t.status !== "approval") continue
        const p = t.plan
        p.approval = { decision: a.decision, ...(a.text ? { text: a.text } : {}), at: a.at }
        p.notifiedAt = undefined
        const day = new Date(a.at).toISOString().slice(0, 10)
        if (a.decision === "no") {
          p.clean = 0
          p.stuck = false
          t.rework = (t.rework ?? 0) + 1
          t.rework_sync = false
          t.rework_note = `ЗАМЕЧАНИЯ ВЛАДЕЛЬЦА к плану ${p.n} (${day}):\n${a.text ?? ""}\nИсправь в файле плана и сдай снова тем же отчётом — перепроверка начнётся заново (новыми сессиями).`
          if (t.executor) addObligation(t.executor, { qid: t.qid, from_session: t.author, from_role: t.author_role, at: now(), nudges: 0, task: t.title })
          taskEvent(t, "owner", "rework", `владелец вернул план: ${(a.text ?? "").slice(0, 300)}`)
        } else {
          taskEvent(t, "owner", "submitted", `владелец: план ${DECISION_RU[a.decision]} (${day}) — приёмщик впишет решение и вольёт`)
        }
        postLetter(t.author, { id: `plan-decision-${safeKey(t.project)}-${t.n}-${a.at}`, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: t.author, time: now(), wake: false, text: `План ${p.n} (задача #${t.n}): владелец — ${DECISION_RU[a.decision]}${a.text ? `: ${a.text}` : ""}.` })
        log(`plan ${p.n} (${t.project} #${t.n}): owner ${a.decision}`)
      }
      for (const t of listTasks()) {
        if (t.status !== "approval" || !t.plan) continue
        const acfg = loadConfig(t.directory)
        const every = Math.max(1, acfg.ownerReminderMin) * 60_000
        if (t.plan.notifiedAt && now() - t.plan.notifiedAt < every) continue
        if (acfg.planApprover === "integrator") {
          // согласует интегратор (plan_approver): письмо автору с побудкой; владелец видит план в /crew и может решить сам (/plans)
          postLetter(t.author, { id: `plan-approve-${safeKey(t.project)}-${t.n}-${t.plan.rounds.length}`, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: t.author, time: now(), text: `План ${t.plan.n} (${t.plan.file}, задача #${t.n}) прошёл перепроверку${t.plan.stuck ? " (раунды кончились — решай по последним замечаниям)" : ""} и ждёт твоего согласования: crew_task {action: "plan_decide", n: ${t.n}, decision: "ok" | "ok-shortcuts" | "no", text: "замечания, если no"}.` })
        } else {
          const message = `${t.title.replace(/^план \S+: /, "")}${t.plan.stuck ? " — раунды кончились, решаете по последним замечаниям" : ""} · /plans`
          const wins = liveWindows()
          if (!wins.length) continue // окон нет — уведомить некого: не отмечать, повторить на следующем проходе
          for (const w of wins) postNotice(w.pid, { title: `План ${t.plan.n} ждёт согласования`, message: short(message, 100), attention: true, duration: 30_000 })
        }
        t.plan.notifiedAt = now()
        saveTask(t)
      }
    }

    // ШАГИ ПЛАНА — ЗАДАЧИ (план 004, шаг 4). Согласованный и влитый план (задача-план очищена) читается из целевой
    // ветки; каждый шаг — задача с его «Что» и «Приёмкой», границами плана и режимом выполнения. Шаг стартует, когда
    // закрыто всё из его «после:» (и «после:» его фазы) и не идёт шаг с пересекающимся «где:»; внутри лимитов проекта;
    // по приоритету шага, иначе фазы, затем по порядку в плане. Шаг-подплан — задача-план. Все шаги закрыты —
    // письмо автору: закрыть план. Раз в PLAN_STEPS_MS: файл плана читается из git.
    const PLAN_STEPS_MS = Number(process.env.CREW_HARNESS_PLANSTEPS_MS) || 10_000
    let planStepsAt = 0
    async function planSteps() {
      if (now() - planStepsAt < PLAN_STEPS_MS) return
      planStepsAt = now()
      for (const pt of listTasks()) {
        if (!pt.plan || pt.status !== "cleaned" || pt.plan.finished || !pt.plan.approval || pt.plan.approval.decision === "no") continue
        const author = readJson<Card>(cardFile(pt.author))
        if (author && author.pid !== process.pid && pidAlive(author.pid)) continue // ставит процесс автора
        const cfg = loadConfig(pt.directory)
        const text = fileAt(pt.directory, cfg.targetBranch, pt.plan.file)
        if (!text) continue
        const plan = parsePlan(text, cfg.planForm)
        const steps = allSteps(plan)
        pt.plan.spawned ??= {}
        if (cfg.planSteps === "manual") {
          // задачи по шагам ставит автор сам (plan_steps: manual): одно письмо со списком шагов
          if (!pt.plan.listed) {
            pt.plan.listed = true
            pt.plan.total = steps.length
            saveTask(pt)
            postLetter(pt.author, { id: `plan-steps-${safeKey(pt.project)}-${pt.n}`, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: pt.author, time: now(), text: `План ${pt.plan.n} влит. Шаги (plan_steps: manual — задачи ставишь сам, crew_spawn):\n${steps.map((x) => `— ${x.id} ${x.title}${x.after.length ? ` [после: ${x.after.join(", ")}]` : ""}: ${x.what}\n  приёмка: ${x.criteria.join("; ")}`).join("\n")}` })
          }
          continue
        }
        if (pt.plan.total !== steps.length) {
          pt.plan.total = steps.length // для /crew: «шаги закрыто/всего»
          saveTask(pt)
        }
        // модель шагов — этап разработки набора (задача 003): отказ — шаги в этот проход не ставятся, автору одно письмо
        const stepChoice = resolveStageProfile(profileState(pt.directory).state, "develop", { autoPlan: true })
        if (stepChoice && "refuse" in stepChoice) {
          const rid = `plan-steps-refused-${safeKey(pt.project)}-${pt.n}-${safeKey(stepChoice.refuse).slice(0, 60)}`
          if (!letterExists(pt.author, rid)) postLetter(pt.author, { id: rid, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: pt.author, time: now(), text: `План ${pt.plan.n}: шаги не ставятся — ${stepChoice.refuse}. Исправь профили или переключи набор (/crew-sets, /crew-profiles); шаги встанут сами.` })
          continue
        }
        const taskOf = (id: string) => (pt.plan!.spawned![id] ? loadTask(pt.project, pt.plan!.spawned![id]) : undefined)
        const done = (id: string) => !!steps.find((s) => s.id === id)?.done || ["cleaned", "closed"].includes(taskOf(id)?.status ?? "")
        const running = steps.filter((s) => isOpen(taskOf(s.id)))
        const order = new Map(steps.map((s, i) => [s.id, i]))
        const prio = (s: (typeof steps)[number]) => s.priority ?? plan.phases.find((f) => f.id === s.phase)?.priority ?? cfg.defaultPriority
        const ready = steps
          .filter((s) => !s.done && !pt.plan!.spawned![s.id] && stepDeps(plan, s).every(done))
          .sort((a, b) => prio(a).localeCompare(prio(b)) || order.get(a.id)! - order.get(b.id)!)
        let changed = false
        for (const s of ready) {
          const busyWhere = running.find((r) => r.where.some((w) => s.where.includes(w)))
          if (busyWhere) continue // пересекается по «где:» с идущим шагом — ждёт его
          const open = listTasks(pt.project).filter(isOpen)
          const workers = open.filter((x) => x.kind === "spawn" && x.role === DEFAULT_ROLE && (x.status === "starting" || x.status === "running"))
          const p = prio(s)
          if (p !== "P0" && (countedOpen(open, cfg.acceptedSlot).length >= cfg.inflightLimit || workers.length >= (cfg.spawnLimits[DEFAULT_ROLE] ?? cfg.spawnLimits["*"] ?? 3))) break // лимиты — ждать
          if (p !== "P0" && cfg.acceptedSlot === "free" && cfg.cleanupLimit > 0 && waitingCleanup(open).length >= cfg.cleanupLimit) break // cleanup_limit: ждущих уборки слишком много — ждать
          const boundaries = [plan.bodies["Не делаем"]?.trim(), `Режим выполнения: ${pt.plan.approval.decision === "ok" ? "без упрощений — ни заглушек, ни TODO, ни «временно»" : "упрощения — только перечисленные в плане"}.`].filter(Boolean).join("\n")
          // без набора шаг идёт на medium, срезанной границами проекта (задача 016)
          const stepCut = clampTier("medium", cfg.tierBounds)
          const model = stepChoice ? stepChoice.model : (cfg.spawnModels[stepCut.tier] ?? DEFAULT_SPAWN_MODELS[stepCut.tier])
          const base = {
            project: pt.project, goal: s.subplan ? `${s.what}\n(подплан шага ${s.id} плана ${pt.plan.n})` : s.what, criteria: s.criteria.join("\n"), boundaries,
            priority: p, tier: (stepChoice ? stepChoice.tier : stepCut.tier) as "heavy" | "medium" | "light", role: DEFAULT_ROLE, model, author: pt.author, author_role: pt.author_role, qid: `q${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            status: "starting" as const, kind: "spawn" as const, executor: plannedSessionId(), directory: pt.directory,
            plan_step: { project: pt.project, task: pt.n, plan: pt.plan.n, step: s.id, file: pt.plan.file },
          }
          let t: Task
          if (s.subplan) {
            let names: string[] = []
            try {
              names = readdirSync(path.join(pt.worktree && existsSync(pt.worktree) ? pt.worktree : pt.directory, cfg.plansDir))
            } catch {}
            const n = nextPlanNumber(names, listTasks(pt.project).filter((x) => x.plan).map((x) => x.plan!.n), pt.plan.n)
            t = createTask({ ...base, title: `план ${n}: ${s.title}`, plan: { n, file: path.posix.join(cfg.plansDir.replace(/\\/g, "/"), cfg.planName.replace(/\{n\}/g, n).replace(/\{slug\}/g, slugify(s.title))), source: `${s.what}\nКритерии шага ${s.id} плана ${pt.plan.n}:\n${s.criteria.join("\n")}`, parent: pt.plan.n, rounds: [], clean: 0 } }, (n2, slug) => taskPlace(pt.directory, cfg, n2, slug, pt.project))
          } else t = createTask({ ...base, title: `${pt.plan.n} ${s.id} ${s.title}` }, (n2, slug) => taskPlace(pt.directory, cfg, n2, slug, pt.project))
          if (stepChoice) stampProfile(t, "executor", t.executor!, stepChoice, !!t.worktree)
          else stampClamp(t, "executor", t.executor!, stageOfLaunch(t, "executor"), model, stepCut.tier, stepCut.from)
          pt.plan.spawned[s.id] = t.n
          running.push(s)
          changed = true
          taskEvent(pt, PLUGIN_SENDER, undefined, `шаг ${s.id} плана ${pt.plan.n} — задача #${t.n}`)
          log(`plan ${pt.plan.n} (${pt.project}): step ${s.id} -> task #${t.n}`)
          await startTask(t)
        }
        if (steps.length && steps.every((s) => done(s.id))) {
          pt.plan.finished = true
          changed = true
          postLetter(pt.author, { id: `plan-finished-${safeKey(pt.project)}-${pt.n}`, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: pt.author, time: now(), text: `План ${pt.plan.n} «${plan.title}»: все шаги закрыты (${steps.length}). Закрой план: в шапке «**Статус:** ✅ ЗАКРЫТ <дата> (фазы; коммиты)», влей.` })
        }
        if (changed) saveTask(pt)
      }
    }

    // УБОРКА (retention.ts): раз в сутки, по retention_days (опция плагина; прежнее имя keep_days; умолчание 7, 0 — не
    // убирать); проверка — раз в HOUSEKEEP_MS, проход ограничен числом удалений за вызов и дозавершается со следующей проверки.
    const RETENTION_DAYS = ctx?.options?.retention_days !== undefined ? Number(ctx.options.retention_days) : Number(ctx?.options?.keep_days ?? 7)
    const HOUSEKEEP_MS = Number(process.env.CREW_HARNESS_HOUSEKEEP_MS) || 3_600_000
    let housekeptAt = 0
    function housekeep() {
      if (now() - housekeptAt < HOUSEKEEP_MS) return
      housekeptAt = now()
      const r = runRetention(RETENTION_DAYS, now())
      if (r?.done) log(`уборка: убрано писем ${r.letters}, папок ${r.dirs}, карточек ${r.cards}`)
    }

    const landedBusy = new Set<string>()
    function flowWatch() {
      if (now() - flowAt < (Number(process.env.CREW_HARNESS_FLOW_MS) || 60_000)) return
      flowAt = now()
      const t = now()
      const byProject = new Map<string, Task[]>()
      for (const x of listTasks()) byProject.set(x.project, [...(byProject.get(x.project) ?? []), x])
      for (const [project, list] of byProject) {
        const any = list.find((x) => x.directory)
        if (!any) continue
        const lock0 = mergeHolder(project)
        // замок слияния держит задача, чей проверенный кандидат уже в главной ветке на origin: отпустить (только чтение, 20 с)
        if (lock0 && list.some((x) => x.n === lock0.n) && !landedBusy.has(project)) {
          landedBusy.add(project)
          releaseLandedLock(project, loadConfig(any.directory).targetBranch)
            .then((m) => m && log(m))
            .catch((e) => log(`merge lock auto-release of ${project} failed: ${e}`))
            .finally(() => landedBusy.delete(project))
        }
        const stall = loadConfig(any.directory).stallMin * 60_000
        if (!(stall > 0)) continue
        const lock = mergeHolder(project)
        const lockTask = lock ? list.find((x) => x.n === lock.n) : undefined
        if (lock && lockTask && t - lock.at > stall) {
          const id = `stall-lock-${safeKey(project)}-${lock.n}-${lock.at}`
          if (!letterExists(lockTask.author, id)) {
            postLetter(lockTask.author, { id, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: lockTask.author, time: t, text: `Замок слияния проекта ${project} держит приёмка #${lock.n} «${lockTask.title}» (сессия ${lock.session}) с ${hhmm(lock.at)} — ${Math.round((t - lock.at) / 60_000)} мин; остальные слияния ждут. Держателю: вызвать accept ${lock.n} после успешного слияния и пуша или unlock ${lock.n}, если слияние прервано; при merge_precheck: required плагин сам отпускает замок, когда проверенный кандидат уже на вершине origin. Узнай у приёмщика, что мешает (crew_send {to: "${lock.session}", text: "..."}), и помоги или реши; без владельца не решить — спроси владельца.` })
            log(`stall: merge lock of ${project} #${lock.n} held since ${lock.at}`)
          }
        }
        // ПРИНЯТА, НО НЕ ОЧИЩЕНА (план 002.6, дефект 2): держит место в inflight_limit. Через accepted_reminder_min —
        // одно письмо приёмщику с побудкой («повтори cleaned») и одно автору; отказ crew_spawn называет такие поимённо.
        const accCfg = loadConfig(any.directory)
        const accMin = accCfg.acceptedReminderMin
        // accepted_slot: free — принятая место не занимает, письма говорят «ждёт уборки N из M» (cleanup_limit 0 — «N, предела нет»)
        const waitingN = waitingCleanup(list).length
        const waitingOf = accCfg.cleanupLimit > 0 ? `ждёт уборки ${waitingN} из ${accCfg.cleanupLimit}` : `ждёт уборки ${waitingN}, предела нет`
        if (accMin > 0)
          for (const x of list.filter((y) => y.status === "accepted")) {
            const at = acceptedAt(x)
            if (t - at < accMin * 60_000) continue
            const id = `stale-accepted-${safeKey(project)}-${x.n}-${at}`
            const toReviewer = accCfg.acceptedSlot === "free"
              ? `Задача #${x.n} «${x.title}» принята ${ago(at, t)}, но не очищена — ждёт уборки, место в inflight_limit не занимает (${waitingOf}). Убери её дерево и ветки и повтори crew_task {action: "cleaned", n: ${x.n}}: отказ назовёт, что осталось. Не убирается — напиши автору (${x.author_role}), что мешает.`
              : `Задача #${x.n} «${x.title}» принята ${ago(at, t)}, но не очищена — держит место в лимите задач проекта (inflight_limit). Убери её дерево и ветки и повтори crew_task {action: "cleaned", n: ${x.n}}: отказ назовёт, что осталось. Не убирается — напиши автору (${x.author_role}), что мешает.`
            const toAuthor = accCfg.acceptedSlot === "free"
              ? `Задача #${x.n} «${x.title}» принята ${ago(at, t)}, но не очищена${x.reviewer ? ` (приёмщик ${x.reviewer}, ему написано)` : ""} — ждёт уборки, место не занимает; ${waitingOf}, пока не будет crew_task cleaned.`
              : `Задача #${x.n} «${x.title}» принята ${ago(at, t)}, но не очищена${x.reviewer ? ` (приёмщик ${x.reviewer}, ему написано)` : ""} — держит место в inflight_limit, пока не будет crew_task cleaned.`
            if (x.reviewer && !letterExists(x.reviewer, id))
              postLetter(x.reviewer, { id, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: x.reviewer, time: t, text: toReviewer })
            if (!letterExists(x.author, id))
              postLetter(x.author, { id, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: x.author, time: t, text: toAuthor })
            log(`stall: #${x.n} of ${project} accepted ${at}, not cleaned`)
          }
        for (const x of list.filter((y) => y.status === "submitted" && !y.reviewer)) {
          const since = [...(x.history ?? [])].reverse().find((h) => h.status === "submitted")?.at ?? 0
          if (!since || t - since <= stall) continue
          const id = `stall-review-${safeKey(project)}-${x.n}-${since}`
          if (letterExists(x.author, id)) continue
          const busy = list.filter((y) => y.review_kind === "spawn" && y.reviewer && isOpen(y) && y.status !== "rework" && y.n !== x.n)
          postLetter(x.author, { id, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: x.author, time: t, text: `Задача #${x.n} «${x.title}» сдана в ${hhmm(since)} и ${Math.round((t - since) / 60_000)} мин ждёт приёмщика: места приёмщиков (spawn_limits.${loadConfig(x.directory).reviewer === "acceptor" ? "acceptor" : "reviewer"}) заняты — ${busy.map((y) => `#${y.n} ${statusRu(y.status)}`).join(", ") || "?"}. Разберись, почему те приёмки стоят (письмо приёмщику), или подними предел приёмщиков (crew_config).` })
          log(`stall: #${x.n} of ${project} waits for a reviewer since ${since}`)
        }
      }
    }

    // ХВОСТЫ ЗАКРЫТЫХ ЗАДАЧ (план 002.4): раз в LEFT_EVERY_MS у задач, закрытых за последние трое суток, ищем оставшиеся
    // ветки (локальные и на origin) и worktree по шаблонам настроек (review.ts leftoversOf, асинхронный git). Нашлись —
    // письмо автору задачи со списком; одно письмо на один набор хвостов. Отменённая задача — убрать или сохранить
    // работу решает автор. Сам плагин не удаляет: удаление веток на origin — действие наружу.
    const LEFT_EVERY_MS = Number(process.env.CREW_HARNESS_LEFT_MS) || 600_000
    // НЕ ПРИ ЗАПУСКЕ (2026-10-07): первый проход шёл сразу при подъёме сервиса, да ещё с ls-remote, — 32 с прохода
    // в минуту, когда сервер и так загружает сессии и окна переподключаются. Первый проход — через LEFT_EVERY_MS,
    // первый взгляд на origin — через LEFT_REMOTE_FIRST_MS.
    let leftAt = Date.now()
    const leftClean = new Set<string>()
    const LEFT_PER_RUN = Number(process.env.CREW_HARNESS_LEFT_PER_RUN) || 3
    const LEFT_REMOTE_MS = Number(process.env.CREW_HARNESS_LEFT_REMOTE_MS) || 6 * 3_600_000
    const LEFT_REMOTE_FIRST_MS = Number(process.env.CREW_HARNESS_LEFT_REMOTE_FIRST_MS) || 30 * 60_000
    let leftRemoteAt = Date.now() - LEFT_REMOTE_MS + LEFT_REMOTE_FIRST_MS
    async function leftWatch() {
      if (now() - leftAt < LEFT_EVERY_MS) return
      leftAt = now()
      // ЛЕГЧЕ (2026-10-07): проход гонял git по каждой задаче, закрытой за трое суток (ls-remote, for-each-ref, worktree
      // list на репозитории nova), — десятки процессов git каждые 10 мин на перегруженной гейтами машине; задержки потока
      // сервера 8–17 с пришлись на этот шаг. Теперь: задача, у которой хвостов не нашлось, больше не проверяется (до
      // перезапуска); за проход — не больше LEFT_PER_RUN задач; origin (ls-remote, сеть) — раз в LEFT_REMOTE_MS.
      const remote = now() - leftRemoteAt >= LEFT_REMOTE_MS
      if (remote) leftRemoteAt = now()
      let checked = 0
      for (const t of listTasks()) {
        if ((t.status !== "cleaned" && t.status !== "cancelled") || now() - (t.updated ?? 0) > 3 * 86_400_000) continue
        const key0 = `${t.project}#${t.n}`
        if (leftClean.has(key0)) continue
        if (++checked > LEFT_PER_RUN) break
        const left = await leftoversOf(t, loadConfig(t.directory), remote)
        if (!left.length) {
          if (remote) leftClean.add(key0) // чисто и локально, и на origin — больше не смотреть
          continue
        }
        const key = left.slice().sort().join("|")
        let h = 0
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
        const id = `stall-left-${safeKey(t.project)}-${t.n}-${(h >>> 0).toString(36)}`
        if (letterExists(t.author, id)) continue
        const what = t.status === "cleaned" ? `принятой задачи #${t.n} «${t.title}» остались хвосты — убери их` : `отменённой задачи #${t.n} «${t.title}» осталась работа — убери её или сохрани, решаешь ты`
        postLetter(t.author, { id, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: t.author, time: now(), text: `У ${what}:\n${left.map((x) => `— ${x}`).join("\n")}\n(git worktree remove, git branch -D, git push origin --delete — по правилам проекта.)` })
        log(`leftovers of ${t.project} #${t.n}: ${left.length}`)
      }
    }

    async function syncTitles() {
      if (typeof ctx.session.update !== "function") return
      for (const c of allCards()) {
        // карточки умершего процесса (сервер перезапущен посреди задачи) — тоже наши; чужой живой процесс — нет
        if (!c.spawned || (!c.task && !c.review) || (c.pid !== process.pid && pidAlive(c.pid))) continue
        const asReviewer = !c.task && !!c.review
        const ref = (c.task ?? c.review)!
        const t = loadTask(ref.project, ref.n)
        if (!t) continue
        const MARK: Record<string, string> = { submitted: "✓", reviewing: "✓◐", rework: "↻", approval: "◇", accepted: "✓✓◐", cleaned: "✓✓", closed: "✓", cancelled: "✗" }
        const replaced = asReviewer ? t.reviewer !== c.session : t.executor !== c.session
        const mark = replaced ? "↷" : asReviewer ? (t.status === "cleaned" ? "✓✓" : t.status === "cancelled" ? "✗" : "") : (MARK[t.status] ?? "")
        // значок и слово (план 003.1; владелец: «что значат две галочки и луна?» — значки оставить, слово рядом)
        const WORD: Record<string, string> = { "✓": "сдана", "✓◐": "приёмка", "↻": "доработка", "◇": "согласование", "✓✓◐": "влита", "✓✓": "готово", "✗": "отменена", "↷": "передана" }
        const title = `#${t.n}${mark ? ` ${mark} ${WORD[mark]}` : ""} ${asReviewer ? "приёмка " : ""}${t.title}`
        if (c.titleShown === title) continue
        try {
          await ctx.session.update({ sessionID: c.session, title })
          const fresh = readJson<Card>(cardFile(c.session)) ?? c
          fresh.titleShown = title
          fresh.title = title
          saveCard(fresh)
        } catch (e) {
          log(`title ${c.session} failed: ${e}`)
        }
      }
    }

    // ЗАПУСК ЗАДАЧИ (план 002, Ф.1). Журнал уже записан (статус starting, id сессии выбран заранее). Шаги повторяемы:
    // session.create с тем же id возвращает уже созданную сессию (замер 2026-10-05), визитка перезаписывается тем же,
    // письмо с задачей кладётся, только если его ещё нет (id письма — из номера и попытки). Оборвался процесс на
    // любом шаге — следующий проход (resumeTasks) повторит запуск, второй сессии и второго письма не будет.
    const startingNow = new Set<string>()
    const startBlocked = new Map<string, number>() // задача → когда повторить запуск, отложенный из-за дерева
    const START_RETRY_MS = Number(process.env.CREW_HARNESS_START_RETRY_MS) || 120_000
    async function startTask(t0: Task): Promise<{ session?: string; error?: string }> {
      const key = `${t0.project}#${t0.n}`
      if (startingNow.has(key)) return { error: "запуск уже идёт" }
      startingNow.add(key)
      try {
        const t = loadTask(t0.project, t0.n) ?? t0
        if (t.status !== "starting") return { session: t.executor }
        const sid = t.executor ?? plannedSessionId()
        if (t.executor !== sid) {
          t.executor = sid
          saveTask(t)
        }
        // план 002.3: worktree и ветку задачи создаёт плагин, сессия работает в нём (хуки видят ветку задачи, не main).
        // План 002.6, дефект 3: сессия задачи с деревом по настройкам НИКОГДА не открывается в главной копии — там
        // исполнитель заводил дерево сам, не в той папке и со своим слагом (#19, #22 nova). Места нет в записи (её
        // записали прежним путём) — достроить по шаблону; дерево вне папки деревьев или не создалось — не запускать.
        let dir = t.directory
        if (t.kind === "spawn") {
          if ((startBlocked.get(key) ?? 0) > Date.now()) return { error: "запуск отложен: дерево задачи не готово" }
          const cfg = loadConfig(t.directory)
          if (cfg.worktrees && (!t.worktree || !t.branch)) {
            Object.assign(t, taskPlace(t.directory, cfg, t.n, t.slug, t.project))
            taskEvent(t, PLUGIN_SENDER, undefined, `место задачи достроено по настройкам: worktree ${t.worktree}, ветка ${t.branch}`)
          }
          if (t.worktree && t.branch) {
            const refuse = (why: string) => {
              startBlocked.set(key, Date.now() + START_RETRY_MS)
              const id = `start-refused-${safeKey(t.project)}-${t.n}-${safeKey(why).slice(0, 60)}`
              if (!letterExists(t.author, id)) {
                postLetter(t.author, { id, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: t.author, time: Date.now(), text: `Задача #${t.n} «${t.title}» не запущена: ${why}. Сессию в главной копии плагин не открывает. Повтор — сам, раз в ${START_RETRY_MS / 60_000} мин; поправь причину или отмени задачу (crew_task {action: "cancel", n: ${t.n}}).` })
                taskEvent(t, PLUGIN_SENDER, undefined, `не запущена: ${why}`)
              }
              log(`task #${t.n} (${t.project}) not started: ${why}`)
              return { error: why }
            }
            if (cfg.worktrees && !insideDir(t.worktree, cfg.worktrees)) return refuse(`worktree ${t.worktree} вне папки деревьев проекта ${cfg.worktrees}`)
            const w = await ensureWorktree(t.directory, t.worktree, t.branch, cfg.targetBranch)
            if (!w.ok) return refuse(`worktree ${t.worktree} не создан: ${w.error}`)
            dir = t.worktree
            if (w.warn) log(`task #${t.n} (${t.project}): ${w.warn}`)
            if (w.note) {
              log(`task #${t.n} (${t.project}): ${w.note}`)
              taskEvent(t, PLUGIN_SENDER, undefined, w.note)
            }
            if (!t.worktree_ready) {
              t.worktree_ready = true
              saveTask(t)
              taskEvent(t, PLUGIN_SENDER, undefined, `worktree ${t.worktree}, ветка ${t.branch}${w.created ? " — создан плагином" : " — уже был"}`)
            }
            // файл окон профилей включённого набора — в дерево задачи ДО первого хода сессии (задача 003, REQ-22); сбой записи запуск не срывает
            try {
              const rep = syncTaskFile(t)
              if (rep.foreign.length) log(`task #${t.n}: в ${t.worktree} уже есть .opencode/opencode.json без пометки плагина — файл окон профиля не записан`)
              for (const e of rep.errors) log(`task #${t.n}: файл окон профиля: ${e}`)
            } catch (e) {
              log(`task #${t.n}: файл окон профиля не записан: ${e}`)
            }
          }
        }
        await ctx.session.create({ id: sid, title: `#${t.n} ${t.title}`, location: { directory: dir }, metadata: { crewTask: { project: t.project, n: t.n, attempt: t.attempt } }, ...(t.model ? { model: splitLaunchModel(String(t.model)) } : {}) })
        const now = Date.now()
        const prev = readJson<Card>(cardFile(sid))
        const card: Card = { ...(prev ?? {}), session: sid, role: t.role, auto: false, title: `#${t.n} ${t.title}`, directory: dir, repo: repoLabel(dir), project: t.project, model: t.model, modelAt: now, modelFrom: "request", pid: process.pid, updated: now, spawned: { by: t.author, task: t.goal.slice(0, 300), tier: t.tier, status: "running", at: now, qid: t.qid }, task: { project: t.project, n: t.n } }
        saveCard(card)
        mine.set(sid, card)
        addObligation(sid, { qid: t.qid, from_session: t.author, from_role: t.author_role, at: now, nudges: 0, task: t.title })
        const lid = taskLetterId(t)
        if (!letterExists(sid, lid)) postLetter(sid, { id: lid, from_role: t.author_role, from_session: t.author, to: sid, time: now, qid: t.qid, text: formatTaskLetter(t) })
        taskEvent(t, PLUGIN_SENDER, "running", `сессия ${sid}`)
        void deliver(card)
        const w = tabOf(t.author)
        if (w?.window.pid) postNotice(w.window.pid, { sessionID: sid, title: `#${t.n} запущена`, message: short(t.title, 80), duration: 8_000 })
        log(`task #${t.n} (${t.project}) started: ${sid} model=${t.model}`)
        return { session: sid }
      } catch (e) {
        log(`task #${t0.n} start failed: ${e}`)
        return { error: String((e as any)?.message ?? e) }
      } finally {
        startingNow.delete(key)
      }
    }
    // Задачи в статусе starting (запуск оборвался или задачу поставил MCP-сервер): запускает процесс, где живёт
    // вкладка автора (её визитка), или любой, если процесса автора уже нет.
    async function resumeTasks() {
      for (const t of listTasks()) {
        if (t.status !== "starting") continue
        const author = readJson<Card>(cardFile(t.author))
        if (author && author.pid !== process.pid && pidAlive(author.pid)) continue
        await startTask(t)
      }
    }

    // ОЧЕРЕДЬ роли+ступени: письмо с tier ждёт свободной открытой вкладки нужной ступени.
    let queueBusy = false
    async function processQueue() {
      if (queueBusy) return
      queueBusy = true
      try {
        const windows = liveWindows()
        for (const roleDir of readdirSync(QUEUE)) {
          const dir = path.join(QUEUE, roleDir)
          for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
            const letter = readJson<Letter>(path.join(dir, f))
            if (!letter?.tier) continue
            const holders = allCards().filter((c) => safeKey(keyOf(c)) === roleDir && !children.has(c.session) && mayWakeCard(c, windows))
            const free = holders.filter((c) => !isBusy(c, windows)).map((c) => ({ ...c, busy: false }))
            if (!free.length) continue
            const cfg = loadConfig(free[0].directory)
            const pick = pickHolder(free, letter.tier, cfg)
            if (!pick) continue
            const claim = path.join(dir, `.${f}.claim`)
            try {
              renameSync(path.join(dir, f), claim)
            } catch {
              continue
            }
            postLetter(pick.session, { ...letter, to: pick.session })
            rmSync(claim, { force: true })
            setBusy(pick, true) // письмо займёт вкладку: следующее с tier не должно уйти туда же
            log(`queue ${f} -> ${pick.session} (${pick.role}, ${tierOf(pick.model, cfg)})`)
          }
        }
      } finally {
        queueBusy = false
      }
    }

    const clearIdle = (sessionID: string) => {
      const c = readJson<Card>(cardFile(sessionID))
      if (!c?.busy) return
      setBusy(c, false)
      void nudge(c) // ход закончился: если есть невыполненное обязательство — напоминание
    }

    // Событие простоя сессии (если контекст плагина его даёт); запас — строка `idle` в базе (таймер).
    try {
      const bus = (ctx as any).events ?? (ctx as any).event
      const on = bus?.on?.bind(bus)
      if (on) await on("session.idle", (ev: any) => clearIdle(String(ev?.properties?.sessionID ?? ev?.data?.sessionID ?? ev?.sessionID ?? "")))
    } catch (e) {
      log(`session.idle subscribe failed: ${e}`)
    }

    // ДРУГИЕ МАШИНЫ (remote.ts): мост держит один процесс машины; входящие — в ящики, как обычные письма.
    const projectRoot = (p: string) => {
      const x = projects.find((y) => y.name === p)
      return x ? (x.rootPath ?? x.root) : allCards().find((c) => projOf(c) === p)?.directory
    }
    const remoteBridge = createRemoteBridge({
      deliver: postLetter,
      exists: letterExists,
      isLocalSession: (s) => existsSync(cardFile(s)),
      isLocalProject: (p) => !!projectRoot(p),
      inboundOf: (p) => loadConfig(projectRoot(p) ?? "").inbound,
      notify: (s, text) => postLetter(s, { id: `remote-failed-${Date.now()}`, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: s, time: Date.now(), text }),
      log,
    })

    // Один проход доставки: зовут таймер (страховка, раз в POLL_MS = 1 с) и fs.watch ящиков (сразу).
    let passBusy = false
    // ПРОХОД НЕ ЗАВИСАЕТ (2026-10-05): у владельца цикл встал на 47 мин (21:27–22:14) — один вызов OpenCode внутри
    // прохода не вернулся, passBusy остался true, следующие проходы выходили сразу: ни доставки, ни подталкивания, ни
    // сторожа, и всё молча. Теперь каждый шаг — с пределом времени (зависший или упавший шаг в журнал, остальные
    // идут), а проход, висящий дольше PASS_STUCK_MS, следующий не ждёт (в журнале — шаг, на котором висит).
    const STEP_MS = Number(process.env.CREW_HARNESS_STEP_MS) || 60_000
    const PASS_STUCK_MS = Number(process.env.CREW_HARNESS_PASS_STUCK_MS) || 120_000
    let passStage = ""
    let passStartedAt = 0
    let passId = 0
    const step = async (name: string, fn: () => any) => {
      passStage = name
      let timer: any
      try {
        await Promise.race([Promise.resolve().then(fn), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`step ${name} took over ${STEP_MS} ms`)), STEP_MS)))])
      } catch (e) {
        log(`pass step ${name} failed: ${e}`)
      } finally {
        clearTimeout(timer)
      }
    }
    async function pass() {
      if (passBusy) {
        if (now() - passStartedAt < PASS_STUCK_MS) return
        log(`pass stuck at ${passStage} for ${Math.round((now() - passStartedAt) / 1000)} s -- the next pass does not wait`)
      }
      passBusy = true
      passStartedAt = now()
      const id = ++passId
      try {
        recoverClaims()
        for (const c of allCards()) {
          if (c.busy && c.pid === process.pid && !children.has(c.session))
            void idleAfter(c.session, c.busySince ?? 0).then((done) => {
              if (done) clearIdle(c.session)
            })
          // разбудили, а запроса к модели не было (ход упал раньше): конец хода — строка idle после побудки
          else if (!c.busy && c.wokeAt && c.pid === process.pid)
            void idleAfter(c.session, c.wokeAt).then((done) => {
              if (!done) return
              const fresh = readJson<Card>(cardFile(c.session))
              if (!fresh?.wokeAt || fresh.busy) return
              markWoke(fresh, undefined)
              void nudge({ ...fresh, busySince: c.wokeAt })
            })
        }
        // Вкладка открыта в окне, но ещё не делала запросов (визитки нет), а письмо по её id ждёт — завести визитку.
        // Чужая сессия (другого сервера) не найдётся в ctx.session.get — touch вернёт пусто.
        await step("cards", async () => {
          for (const w of liveWindows())
            for (const t of w.tabs ?? []) if (!existsSync(cardFile(t.sessionID)) && waitingIn([t.sessionID]) && (await sessionInfo(t.sessionID))) await touch(t.sessionID)
        })
        await step("resumeTasks", resumeTasks)
        await step("applyApprovals", applyApprovals)
        await step("assignReviewers", assignReviewers)
        await step("planSteps", planSteps)
        await step("profilesStep", profilesStep)
        await step("reconcile", reconcile)
        await step("resumeInterrupted", resumeInterrupted)
        await step("finishTasks", finishTasks)
        await step("syncTitles", syncTitles)
        await step("syncStatus", syncStatus)
        await step("flowWatch", flowWatch)
        await step("leftWatch", leftWatch)
        await step("housekeep", housekeep)
        await step("processQueue", processQueue)
        // наблюдения crew_watch (watch.ts): запустить новые, по концу — письмо окну с побудкой
        await step("watches", () => pollWatches((w, text) => postLetter(w.session, { id: `watch-${w.id}`, from_role: PLUGIN_SENDER, from_session: PLUGIN_SENDER, to: w.session, time: Date.now(), text }), log, now(), (w) => loadConfig(w.cwd).machineSlots))
        await step("remote", remoteBridge.step)
        passStage = "deliver"
        // АДРЕСАТЫ — ИЗ ВИЗИТОК НА ДИСКЕ (после перезагрузки плагина память пуста). Визитки этого процесса и умершего;
        // двойной доставки нет: письмо забирает тот, чей rename в claimLetters прошёл первым.
        for (const card of allCards()) {
          if (children.has(card.session) || card.spawned?.status === "closed") continue
          if (card.pid !== process.pid && pidAlive(card.pid)) continue // вкладка живого чужого процесса (частный сервер)
          void deliver(card)
        }
      } finally {
        if (id === passId) passBusy = false // зависший прежний проход, вернувшись, не снимает флаг идущего
      }
    }
    // Таймеры цикла создаёт start() в конце setup, снимает stop(): цикл можно перенести на другой экземпляр (см. «ОДИН ЦИКЛ»).
    let timer: any
    let watcher: any
    let soon: any
    const startPass = () => {
      timer = setInterval(() => void pass(), POLL_MS)
      try {
        watcher = watch(INBOX, { recursive: true }, () => {
          clearTimeout(soon)
          soon = setTimeout(() => void pass(), 100)
        })
      } catch (e) {
        log(`inbox watch unavailable (the ${POLL_MS} ms tick delivers): ${e}`)
      }
    }

    await ctx.session.hook("context", async (ev: any) => {
      try {
        const card = await touch(String(ev.sessionID ?? ""), ev)
        if (!card) return
        setBusy(card, true) // запрос вкладки: она занята ходом до строки простоя
        // ПОДСКАЗКА — НЕИЗМЕННАЯ, пока не сменилась роль: системная часть стоит перед всей историей, и любое её
        // изменение заново оплачивает историю (замер 2026-10-04). Соседи — crew_list.
        ev.system.push({
          type: "text",
          text:
            `crew-harness: ты — вкладка с ролью «${card.role}» в проекте ${projOf(card)} (адрес ${keyOf(card)}), репозиторий ${card.repo || "?"}, ` +
            `сессия ${card.session}. Соседи — crew_list, письмо — crew_send, вопрос с ответом — crew_send {expect_reply} + crew_wait, справка — crew_help. ` +
            `Задачу называй с названием: «#31 «замок вливания»» при первом упоминании в ответе, дальше можно «#31».`,
        })
      } catch (e) {
        log(`context failed: ${e}`)
      }
    })

    // ЗАПРОС ВКЛАДКИ — источник модели (хук model.request V2: {sessionID, agent, model, kind}).
    try {
      await ctx.session.hook("model.request", async (ev: any) => {
        try {
          if (ev?.kind && ev.kind !== "primary") return
          if (ev?.sessionID && ev?.model) await touch(String(ev.sessionID), { model: ev.model })
        } catch (e) {
          log(`model.request failed: ${e}`)
        }
      })
    } catch (e) {
      log(`model.request hook unavailable: ${e}`)
    }

    // САМОПРОВЕРКА: то, что умеет только процесс OpenCode.
    async function doctor(): Promise<string[]> {
      const out: string[] = []
      for (const [name, f] of [["session.prompt", ctx?.session?.prompt], ["session.create", ctx?.session?.create], ["session.get", ctx?.session?.get], ["session.hook", ctx?.session?.hook]] as const)
        if (typeof f !== "function") out.push(`в этой версии OpenCode у плагина нет ${name} — доставка или задачи не работают`)
      const probe = allCards()[0]
      if (probe) {
        const row = await sessionFromDb(probe.session)
        if (!row) out.push("база OpenCode (opencode.db) не читается или в ней нет session_v2 — модель и простой вкладок не видны")
      }
      return out
    }

    const tools = makeTools({
      projects,
      defaultDir: String(ctx?.location?.directory ?? ""),
      touch: (sessionID) => touch(sessionID),
      isChild: (s) => children.has(s),
      posted: () => void pass(),
      picked: (pick) => {
        setBusy(pick, true)
        void pass()
      },
      roleTaken: (me) => {
        mine.set(me.session, me)
        void deliver(me)
      },
      startTask,
      doctor,
    })
    const toEditor = (t: (typeof tools)[number]) => ({ name: t.name, description: t.description, input: t.input, execute: (input: any, context: any) => t.execute(input, context?.sessionID) })
    await ctx.tool.transform((editor: any) => {
      for (const t of tools) editor.add(toEditor(t))
    })
    // Журналы задачи (journal.ts): progress_line и usage_line. Отдельным вызовом и вне списка tools / MCP-сервера; сбой не ломает плагин.
    try {
      await registerJournalTools(ctx, log)
    } catch (e) {
      log(`journal tools failed: ${e}`)
    }

    // Слэш-команды /crew-help, /crew-sets и /crew-profiles — команды окна (tui.ts, диалог с текстом сразу). Здесь они не
    // регистрируются: служебное сообщение (ctx.session.synthetic) окно 2.0.23 не показывает (проба 2026-10-08: execute вызван, сообщений
    // в сессии нет), а одноимённая серверная команда стояла бы вторым пунктом списка.

    // Самопроверка при загрузке (через 10 с: окна успевают отметиться) и раз в DOCTOR_EVERY_MS. Итог — в DOCTOR_FILE
    // (его показывает /crew-doctor окна), проблемы — в журнал; уведомление окнам — только когда набор проблем сменился.
    const DOCTOR_EVERY_MS = Number(process.env.CREW_HARNESS_DOCTOR_MS) || 10 * 60_000
    let doctorSaid = ""
    const runDoctor = async () => {
      const problems = [...(await doctor()), ...commonDoctor(), ...settingsProblems(projects), ...profileProblems()]
      try {
        writeFileSync(DOCTOR_FILE, JSON.stringify({ at: Date.now(), problems }))
      } catch {}
      const said = problems.join(" | ")
      if (said === doctorSaid) return
      doctorSaid = said
      if (!problems.length) return log("doctor: ok")
      log(`doctor: ${said}`)
      for (const w of liveWindows()) postNotice(w.pid, { title: "crew: проблемы — /crew-doctor", message: short(problems.join("; "), 100), duration: 15_000 })
    }
    let doctorTimer: any
    let doctorAgain: any
    let catalogFirst: any
    let catalogTimer: any
    let doctorEvery: any
    let lagTimer: any
    // снимок каталога моделей для окна (model-catalog.ts): при загрузке (после 3 с) и раз в 10 минут
    const snapCatalog = async () => {
      try {
        if (!writeCatalog(catalogModels(await ctx.model.list()))) log("model catalog snapshot: empty reply, not written")
      } catch (e) {
        log(`model catalog snapshot failed: ${e}`)
      }
    }

    // ЗАМЕР ЗАДЕРЖКИ ГЛАВНОГО ПОТОКА (2026-10-06). Сервер дважды за вечер терял окна («Event stream stalled»), и было
    // не понять, держал ли поток плагин. Таймер раз в LAG_EVERY_MS замечает, насколько опоздал: опоздание от
    // LAG_LOG_MS — строка в журнал с шагом прохода плагина, который в это время шёл («—» — плагин был свободен: держал
    // кто-то другой в процессе сервера), и памятью процесса.
    const LAG_EVERY_MS = 500
    const LAG_LOG_MS = Number(process.env.CREW_HARNESS_LAG_MS) || 1_000
    let lagExpected = Date.now() + LAG_EVERY_MS
    const lagTick = () => {
      const t = Date.now()
      const lag = t - lagExpected
      lagExpected = t + LAG_EVERY_MS
      noteLoopLag(lag, t) // для usage_line: наибольшая задержка за время сессии
      if (lag < LAG_LOG_MS) return
      const inPass = passBusy ? `шаг прохода ${passStage}, проход идёт ${Math.round((t - passStartedAt) / 1000)} с` : "плагин свободен"
      log(`loop lag ${lag} ms (${inPass}; память ${Math.round(process.memoryUsage().rss / 1048576)} МБ)`)
    }

    let running = false
    const start = () => {
      if (running) return
      running = true
      startPass()
      doctorTimer = setTimeout(() => void runDoctor(), 10_000)
      // и ещё раз через минуту: при подъёме сервиса окна переподключаются позже 10 с, и первая проверка видит «ни одно
      // окно не отмечается» (2026-10-07) — без повтора ложное замечание висело в /crew-doctor до плановой проверки
      doctorAgain = setTimeout(() => void runDoctor(), 70_000)
      doctorAgain.unref?.()
      catalogFirst = setTimeout(() => void snapCatalog(), 3_000)
      catalogTimer = setInterval(() => void snapCatalog(), 10 * 60_000)
      catalogFirst.unref?.()
      catalogTimer.unref?.()
      doctorEvery = setInterval(() => void runDoctor(), DOCTOR_EVERY_MS)
      doctorEvery.unref?.()
      lagExpected = Date.now() + LAG_EVERY_MS
      lagTimer = setInterval(lagTick, LAG_EVERY_MS)
      lagTimer.unref?.()
    }
    const stop = () => {
      if (!running) return
      running = false
      clearInterval(timer)
      clearTimeout(soon)
      clearInterval(lagTimer)
      clearTimeout(doctorTimer)
      clearTimeout(doctorAgain)
      clearTimeout(catalogFirst)
      clearInterval(catalogTimer)
      clearInterval(doctorEvery)
      remoteBridge.stop()
      try {
        watcher?.close()
      } catch {}
    }

    log(`setup pid=${process.pid} base=${BASE}`)
    // ОДИН ЦИКЛ НА ПРОЦЕСС (2026-10-05). OpenCode перегружает плагин при изменении его файлов, не всегда закрывая
    // прежний экземпляр: циклы прежних экземпляров жили дальше, каждый со своим проходом раз в секунду. Вместе с
    // чтением базы (5 ГБ) это клало сервер — «Event stream stalled», окно перезапускало сервис (18:19, 18:42).
    // Новый экземпляр останавливает цикл прежнего.
    // ЦИКЛ ПЕРЕХОДИТ К ЖИВОМУ СОСЕДУ (2026-10-10). Экземпляр плагина — на каталог (OpenCode создаёт и снимает их
    // по одному), а цикл один на процесс и принадлежит последнему созданному. Когда OpenCode снял именно его, а
    // экземпляры других каталогов живы, цикл вставал насовсем: письма не доставлялись, пока что-нибудь не создало
    // новый экземпляр (замер: 15:16–15:48, письмо открытой вкладке nova.integrator ждало 10 минут). Теперь снятый
    // хозяин цикла отдаёт его последнему из оставшихся. Новый экземпляр того же каталога заменяет прежний (перезагрузка
    // плагина): оставшийся от перезагрузки прежний экземпляр цикл не получит.
    const g = globalThis as any
    type Loop = { directory: string; running: () => boolean; start: () => void; stop: () => void }
    const loops: Loop[] = (g.__crewHarnessLoops ??= [])
    const directory = String(ctx?.location?.directory ?? "")
    const me: Loop = { directory, running: () => running, start, stop }
    try {
      g.__crewHarnessDispose?.() // экземпляр плагина прежней версии
    } catch {}
    for (const l of [...loops]) {
      l.stop()
      if (l.directory === directory) loops.splice(loops.indexOf(l), 1)
    }
    loops.push(me)
    const legacyDispose = () => stop()
    g.__crewHarnessDispose = legacyDispose
    start()
    return () => {
      const owned = running
      stop()
      const i = loops.indexOf(me)
      if (i >= 0) loops.splice(i, 1)
      if (g.__crewHarnessDispose === legacyDispose) g.__crewHarnessDispose = undefined
      const next = owned ? loops[loops.length - 1] : undefined
      if (next) {
        log(`loop of ${directory || "?"} released, handed over to ${next.directory || "?"}`)
        next.start()
      }
    }
  },
}
