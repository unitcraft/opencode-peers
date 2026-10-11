# CrewHarness — the OpenCode plugin

*ИИ-команда в упряжке — обвязка для команды ИИ-агентов.*

**Your AI dev team, harnessed.** An OpenCode V2 plugin that turns Claude Code tabs into a crew that carries work
from a plan to a merge, while the owner only approves and watches:

- **plans** — a plan task writes a plan document; it is rechecked in rounds by fresh sessions with graded remarks,
  approved by the owner in the window (`/plans`), and its steps become tasks by dependencies and priorities;
- **tasks** — each in its own session, worktree and branch; priorities, limits, a queue;
- **acceptance** — a separate reviewer goes through the project's steps, merges under a lock (one at a time) and
  confirms the cleanup;
- **letters** — between tabs and projects, addressed by `project.role`; questions with an awaited answer;
- **flow control** — reminders, a stall watchdog, recovery after a service restart, a stale-window check;
- **the machine** — long waits that outlive a turn (`crew_watch`) and a queue for heavy runs;
- **for the owner** — a side panel in the window, `/crew`, "waiting for you" notices, acceptance reports;
- **everything is a setting** — plan form, acceptance steps, grades, limits, who approves.

A *window* is the OpenCode program in a terminal; a *tab* is a session inside it (one on screen, the rest in the
background); a task session may run with no window at all. Formerly `opencode-peers` (renamed 2026-10-07, plan 005).

- tools `crew_list`, `crew_send`, `crew_wait`, `crew_watch`, `crew_role`, `crew_inbox`, `crew_spawn`,
  `crew_task`, `crew_config`, `crew_doctor`, `crew_help` (also `/crew-help`);
- **projects**: every tab belongs to a project and its address is `project.role`
  (`nova.integrator`). A plain role means the sender's own project; `project.role` reaches another
  project; `all` is every open tab of the own project, `project.all` of another one; a session id
  (`ses_...`) reaches exactly that tab. A tab belongs to the project with the longest matching
  root, a tab outside every root to the project named after its repository;
- **project settings live in a settings repository**, not in the tab's working copy (a project can
  be a folder of many repositories, like `C:/work/nova`). The plugin options list settings
  folders — any folder inside a git repository; the file `.opencode/crew-harness.json` there
  names the project and its root (relative to the folder) and is read **committed** from the
  default branch (`git show`; another branch: its `"branch"` field), never from the working copy:

  ```jsonc
  "plugins": [
    { "package": "C:/work/crew-harness/opencode-plugin",
      "options": { "projects": ["C:/work/nova/nova-settings", "C:/work/tools"],
                   "local": { "nova": { "spawn_models": { "light": "kimi/k3" } } } } }
  ]
  ```

  ```json
  { "project": "nova", "root": "..", "task_fields": ["goal", "criteria", "boundaries"],
    "worktrees": "worktrees", "branch_name": "p{n}-{slug}", "spawn_limits": { "worker": 3 } }
  ```

  The plugin option `retention_days` (default 7, `0` is off; formerly `keep_days`) makes a once-a-day pass remove delivered letters, empty mailbox folders and the cards and statuses of closed tabs older than that; open questions, undelivered letters, open tabs and task records are never touched.

  `local` holds machine-specific values on top of the file. The old options form
  `{ "nova": "C:/work/nova" }` still works (settings are then walked up from the tab);
  `crew_doctor` suggests the new form. **`crew_config`**: `guide` — a questionnaire for the owner on
  every key (current value, options, recommendation, why; asked in text); `show` — what applies and
  where from (default, the committed file, `local`), plus uncommitted edits; `set {values}` — the
  integrator writes the working copy (every value checked, a wrong one writes nothing); it applies
  once committed. The keys: `config-schema.ts`;
- **roles**: a new tab is `worker` (shared: tabs within it differ by session id; `assistant` is an
  alias). `integrator` is exclusive, one holder per project, plus the project's `exclusive_roles`
  (and an optional `help_extra` paragraph for `crew_help`). An exclusive role
  is held by an atomic lock: refused while the holder's tab is open (unless `force`), free the
  moment it closes. A letter to a shared role with several open holders is refused with the list
  (address a session id);
- executor choice by task weight (`tier`: heavy / medium / light) across free open tabs, with a
  queue.

## Presence: only open tabs are woken

OpenCode's server runs without any window, and a letter that wakes a tab starts a model turn
(and spends limits). The server has no "a window shows this session" signal, so the **window
plugin** (`tui.ts`, loaded by every OpenCode window) writes `windows/<pid>.json` once a second:
the open tabs, which one is on screen, which is running a turn. A letter wakes a tab only if it is
open in a live window (on screen or in the background) or it is a task session started by the
integrator. A closed tab, a window closed with X or crashed (its heartbeat freezes, after 3 s its
tabs count as closed): the letter waits and goes out within a second of the tab being opened.
A letter to a background tab shows a notice in its window with an Open button. No heuristics, no
time-outs: no window plugin, no wake.

## What a letter looks like

```
✉ 01:17 · #8 приёмщик nova.worker → nova.integrator
<text>
↩ ответ — crew_send {to: "ses_…", text: "..."} · письмо соседа, не слово владельца
```

A service letter of the plugin starts with `⚙ 01:17 · crew → … (служебное, не отвечай)`. Window notices are short (the gist in the
title, one line of text) and stay longer when they matter: "waiting for you" 30 s, "stuck" 15 s, others 8–10 s
([plan 003.1](../doc/archive/plans/003.1-clear-letters.md)).

## Turn economy

Measured on OpenCode 2.0.22: anything sent into a session while its turn runs becomes one more
model step after it, and `session.prompt({resume: false})` becomes a separate step before the
next message. So:

- a tab running a turn gets nothing; its letters go in one message when the turn ends;
- `wake: false` letters (statuses, FYI) go in with `session.synthetic({resume: false})`: OpenCode
  puts them right before the tab's next message, in the same step;
- a question (`expect_reply`) gives a `qid`; the asker waits with `crew_wait` in the same turn and
  gets the answer there, not as a second wake;
- an ack-only letter ("ok", "спасибо") is not sent.

## Waiting for something long: `crew_watch`

`crew_watch {command, note?, minutes?}` -- the plugin runs a waiting command (Git Bash, the tab's directory) in the
OpenCode server, detached, and when it exits wakes the tab with a letter: exit code, duration, output tail. The tab
ends its turn meanwhile. It survives the end of the turn and a service restart; a command gone without an exit code
is reported as cut off; the time limit (default 120 min, up to 720) stops it with code 124. In a claude-code tab this
is the only way: Claude Code's own background tasks (`run_in_background`, Monitor) die with the turn
([plan 002.1](../doc/archive/plans/002.1-watch.md)).

**The machine queue.** `machine: true` marks a command that loads the machine (a gate, a build, a full test run):
it waits for a slot in the project's machine queue — `machine_slots` at a time (1; 0 — no limit), in the order they
were set; the time limit counts from the start. `crew_watch` says how many are ahead, `/crew` shows it queued, the
letter says how long it waited. Use it only for heavy commands: waiting for a remote CI (a `gh` or `check-push-proven-by-ci` polling loop with a pause)
and anything else that does not load the machine goes with `machine: false`, or it holds the slot while other windows'
heavy runs stand idle. Ordinary watches and other projects do not wait ([plan 002.2](../doc/archive/plans/002.2-machine-queue.md)).

**The project's deny rules.** The command runs outside the window's permissions, so `crew_watch` checks it against
`permissions.deny` of the project's `.claude/settings.json` (from the tab's directory up to the git root; no file — no
check, an unreadable one — refusal): a command matching `Bash(…)` / `PowerShell(…)` (`prefix:*`, `*` as a wildcard),
whole or in any subcommand (`&&`, `||`, `;`, `|`, a newline, the body of `bash -c '…'`, `$(…)`; `git -C <dir>` and
`VAR=1 timeout N` prefixes do not hide it), or naming a file under a `Read(…)` glob is refused, naming the rule.
**Who started it:** the command's environment carries `CREW_SESSION_ID`, `CREW_ROLE`, `CREW_PROJECT`, and
`CREW_REVIEW_N` for the reviewer of an open task, `CREW_TASK_N` for its executor — fixed when the watch is put and
kept in its record, so a restart or a later role change does not alter them ([plan 002.7](../doc/archive/plans/002.7-acceptor-role.md)).

## Who waits for what: `/crew` and "waiting for you"

The window's right panel shows a "Crew" block under "Context": the sessions of the project of the tab on screen —
the ones waiting for you first, who is working and how long, who waits for what — refreshed every 2 s
([plan 003.2](../doc/archive/plans/003.2-sidebar.md)). The window closes the tab of a task or review session two minutes after its task was merged (accepted — before the cleanup: an open tab keeps the server watching the task's folder, and Windows will not remove it) or cancelled, unless its turn is going or
the tab is on screen (the owner's own tabs are left alone; the session stays in the history). `/crew-config` shows the project's settings in effect, each with where it comes from (default, the committed file,
`local`), like `crew_config show`. `/crew-doctor` shows the service's last self-check (made at start and every 10 minutes), like `crew_doctor`. `/crew` in any window (also in the Ctrl+P palette) shows, without a model turn, every session of the projects:
working, **waiting for you** (its last answer ends with a question and you have not written since), waiting for a
watch, for an answer to its question, for its task's review or rework, for its own tasks, or idle — your project
first, the ones waiting for you on top. A session that starts waiting for you puts a notice into every live window
(with Open; a system notification when the window is not focused, if OpenCode's `attention.notifications` is on)
and repeats it every `owner_reminder_min` minutes (15; 0 — once) until you answer ([plan 003](../doc/archive/plans/003-status.md)).

### Session status

The service plugin keeps `<mailbox>/status/<session id>.json` for open tabs, task sessions and sessions with watches
or open tasks of their own — an open contract for outside checks (e.g. a project's Stop hook; the claude-code
provider puts `OPENCODE_SESSION_ID` into Claude Code's environment). `<mailbox>` is
`$XDG_DATA_HOME/opencode/crew-harness` (OpenCode's data directory; an earlier mailbox — `opencode-peers`, `nova-peers` — stays in place and the new name links to it on the first
so old paths keep working):

```jsonc
{ "session": "ses_…", "project": "nova", "role": "integrator", "title": "…", "model": "claude-code/opus",
  "state": "working" | "owner" | "question" | "watch" | "reply" | "task" | "tasks" | "idle",
  "since": 1791200000000, "detail": "a line for people", "question": "… (state owner)",
  "watches": [{ "id", "note", "started", "minutes" }],          // running crew_watch
  "asked": [{ "qid", "to", "at" }],                              // its questions without an answer
  "task": { "n", "status", "as": "executor" | "reviewer", "title" },
  "tasks": [{ "n", "status", "priority", "title" }],             // open tasks it set
  "updated": 1791200000000 }
```

## Progress of background sessions (progress.log)

The sessions of the development method (analysis, plan, implementation, review — see
[`doc/canon/process.md`](../doc/canon/process.md)) work in the background, not in tabs. Each of them writes its progress
into `doc/tasks/<NNN-name>/progress.log`, one line per finished unit: `<code> <k>/<N> [HH:MM] <what was done>` (the format
and the guard that checks it are in the Canon item "Журнал хода `progress.log`"). The window reads these journals itself —
no service, no setting, no process — and shows them. The texts of the window are Russian, like the rest of the window.

### 1. The "Ход работ" block and `/crew-progress`

Under the "Crew" block of the right panel the window draws a "Ход работ" block (nothing is drawn while no task is running):
at most 3 tasks, 4 rows each — the mark and "NNN title", the session in words and "k/N", `↳` the last line, the state — and a bottom
row: `ещё N · все: /crew-progress` when N tasks did not fit, `все: /crew-progress` when all fit. Marks: `!` needs attention (silent for
too long, stopped, a launch with no news past the threshold), `•` runs, launched, "no units" or "all steps done, no result", `✓` done. The states, as the panel prints them: "идёт HH:MM · Nм назад", "⚠ нет вестей Nм" (with
"· ветка Mм" when the task's branch moved after the last line), "остановилась: <kind>", "готово HH:MM", "запущена HH:MM" (the row
before says "шагов нет"), "без единиц HH:MM", "все шаги сделаны, итога нет". `HH:MM` is the time of the last line; a leading `≈` marks a
time taken from the file (the line has no time field); `≠` after "k/N" marks a session whose lines differ between two copies
of the journal; `+N` — other running sessions of the task. The block refreshes every 2 s from a cache; the files are walked
at most every 5 s, so a new line is on the panel within 10 s. The command `/crew-progress` (also in the Ctrl+P palette, "Crew: что сейчас идёт")
shows the same in a dialog, without a model turn: every running task of the repository of the tab on screen, every running session of it with the
last three lines of its journal, "вытеснено N" for the past sessions, and a stopped, launched or silent session with no news for
24 hours marked "давно брошена" ("all steps done, no result" is never marked so). The repository is
the one of the tab: found without any process by climbing from the tab's folder to `.git` (a folder — the main copy; a file
`gitdir: …` — a linked working tree, the common `.git` by `commondir`; relative paths are resolved from the folder of the file),
and every working tree of it is read from git's own registry `.git/worktrees/*/gitdir`, wherever the tree lies. For each session the copy of the
journal with more lines of that session is taken (the main copy when they are equal).

### 2. Thresholds and environment variables

Constants of the module, the same for all projects: silence is "давно нет вестей" after 10 minutes, "done" and "no units" stay in the panel
for 15 minutes, a stopped, launched or silent unfinished session leaves the panel after 24 hours and the command marks it "давно брошена";
a session in "все шаги сделаны, итога нет" leaves the panel and the command after 24 hours with no mark. They are counted
from the clock at every show, not from a change of the file. The window process can override them, in milliseconds (a value that is not
a positive number is ignored): `CREW_HARNESS_PROGRESS_STALE_MS` (10 minutes), `CREW_HARNESS_PROGRESS_DONE_MS` (15 minutes),
`CREW_HARNESS_PROGRESS_ABANDON_MS` (24 hours). No project setting, no schema and no `crew_help` text is involved.

### 3. Open contract: `ProgressTask`

`progress.ts` is pure (no file, no window, no OpenCode, no `status.ts`): `parseJournal(bytes)` gives the lines of a journal and
`summarizeTasks(scan, now, thresholds)` gives the state of every task; `progress-scan.ts` walks the trees and caches the parsed journals
(`createScanner().scan(dir)` and `.scanAll(dir)`), a future service can use both. The input is
`{ tasks: [{ folder, title, copies: [{ kind: "main" | "tree", tree?, lines, mtimeMs, branchMs? }] }] }`; the output is an array of

```jsonc
{ "number": "002", "folder": "002-guards", "title": "…",            // ProgressTask = ProgressSession + the fields of the task
  "others": 0, "displaced": 69,                                     // other running sessions ("+N"); past sessions displaced
  "candidates": [ /* ProgressSession of every running session, the shown one first */ ],
  // ProgressSession:
  "session": "С5", "sessionName": "С5 реализация", "k": 13, "n": 14, "signature": "…",
  "at": 1791200000000, "byFile": false,                              // the time of the last news; true — taken from the file time
  "state": 5, "stateWord": "идёт", "kind": "ворота",                 // state 1…7 of the table; kind — only for state 1 (empty: no kind named)
  "stale": false, "divergent": false, "source": "main" | "tree",     // silent past the threshold; the copies differ (≠); the copy it was taken from
  "branchAt": 1791200000000,                                         // the last move of the branch of that copy (logs/HEAD), if known
  "visible": true, "abandoned": false,                               // shown in the panel; state 1, 3 or 6 with no news for 24 hours
  "tail": ["12/14 …", "13/14 …"] }                                   // up to three last lines of the session
```

States: 1 stopped, 2 done, 3 launched (no steps yet), 4 no units, 5 running, 6 silent, 7 all steps done with no "готово". The field names are
the contract; they change only by changing this section.

### 4. A session with no lines is invisible

A session that wrote no line at all and has no launch line `<code> 0/0 [HH:MM] запуск` in a journal cannot be seen: nothing in the files says it began.
Sessions are told apart by a start line (`k = 0`), by a change of the code or by a fall of `k`; a session is shown only after its first line.

### 5. Caveats of the launch line and of the copies

A session that wrote only a launch line and ended silently stays in the panel as "запущена" (and then "⚠ нет вестей") until it is abandoned
after 24 hours. The launch line of the first implementation session goes into the task's worktree, not into the main copy:
otherwise `progress.log` of the main copy and of the branch diverge, a `--ff-only` merge refuses and a rebase conflicts (the panel itself loses
nothing: the same session is recognized in both copies). A repeated launch of the same code is written into the copy where the lines of the
previous session of that code are; a launch in one copy while a finished session of the same code is in another copy does not start a new session.
An interrupted session of the common beginning of both copies, written with time fields, may leave a "+1" next to a running session of the task
(the state of the task itself stays right); without time fields the stale one is dropped. When the shown record of a task is hidden
("итога нет" after 24 hours, "готово" or "без единиц" after 15 minutes), the command still names an older session of another copy that
is stopped, launched or silent and has had no news for 24 hours, marked "давно брошена", and counts the task among the abandoned ones;
such a session younger than 24 hours is not listed until that time has passed.

### 6. The file time is only a hint

A line with no time field is dated by the change time of the file (marked `≈`), and for equal copies the earlier one. A merge, a switch of branches
and a clone refresh that time, so a journal brought by a merge may look newer than its last line; lines written with `[HH:MM]` do not have this
limit. The date of such a line is the day of the file (the previous day when the time is later than the file by more than 5 minutes). The field may also be `[YYYY-MM-DD HH:MM]` (new lines since 2026-10-09; the owner's word): then the named day is used (a moment later than now by more than 5 minutes falls back to the file time, marked `≈`); both forms are accepted, earlier lines are not rewritten.

### 7. The transitional period

Until the Canon item about the journal is in `main`, sessions write the earlier form with no "готово" line, so a finished session shows as
"все шаги сделаны, итога нет" until it leaves the panel after 24 hours; a line written after "готово" in the same session brings the same
state back. Later the sessions write `<code> N/N [HH:MM] готово …` last and the panel shows "готово" for 15 minutes.

## Task journals: `progress_line` and `usage_line`

Two tools of the plugin write the journals of a task folder (Canon item "Три журнала сессии"). They are registered by a
separate `ctx.tool.transform` call (`journal.ts`), are not in the MCP server and not among the twelve `crew_*` tools; a
failure to register them does not break the plugin. Both are narrow: no shell, append only, a fixed file name, the path must
stay inside the project folder of the window, the refusal of the file system comes back as a refusal, earlier lines are never
rewritten. A refusal is the answer `Не записано: <reason>`, nothing is written.

`progress_line` `{file, code, unit, text}`: appends ONE line `<code> k/N [YYYY-MM-DD HH:MM] <text>` with the machine date and time to a file
named `progress.log`, which must already exist. `code` is 1-8 letters or digits, `unit` is `k/N` or `?/?`, `text` is one line
of up to 120 characters. Example: `progress_line {file: "doc/tasks/007-x/progress.log", code: "С5д", unit: "4/13", text: "..."}`.
Commands that only ask the clock (`date +%H:%M`, `Get-Date -Format HH:mm`) are refused by the `opencode-windows-env` plugin;
this tool is the allowed way to put the time into the journal.

`usage_line` `{file, code, result}`: appends ONE JSON line (format version `"v":1`) to a file named `usage.log`; the file may
be created only when a `progress.log` lies in the same folder. The agent passes the file, the session code and the result
(one line, up to 200 characters); the plugin fills the rest: `at` (ISO time with the local offset, e.g. `2026-10-09T04:12:00+03:00`), `session`, `model` (`provider/id`), `variant`,
`tokens` `{input, output, reasoning, cache_read, cache_write}`, `cost`, `started` (the same ISO form) and `seconds` (from the session card of
`ctx.session.get`), `max_loop_lag_ms` (the largest delay of the plugin's own loop timer, the one that writes the "loop lag"
lines, since the session was created or the plugin started, whichever is later), `commit` (`git rev-parse HEAD` of the file
folder, empty outside a repository). A value the plugin cannot read is `null`, never guessed; `limits`, `tool_calls` and
`test_runs` are `null` for now. Call it once, when the session is finished:
`usage_line {file: "doc/tasks/007-x/usage.log", code: "С5д", result: "готово: 13 из 13"}`.

## Answering session questions (`answer_mode`)

By default every question of a session waits for the owner. A project can hand some of them to the session's own
recommendation with two keys of `.opencode/crew-harness.json`, which only a person sets (edit the file and commit; `crew_config set`
refuses them) — [ADR-0010](../doc/canon/decisions/ADR-0010-question-answering-modes.md):

- `answer_mode` — a map "type of the question → mode". Types: `requirements`, `plan`, `implementation` and `default` (for a type
  without its own entry); modes: `owner` (the owner answers, the default) and `recommendations` (the recommendation of the
  question closes it). The type `gate` is not accepted in the map, and the mode `agent` (another agent answers) is moved to a
  separate future task. The value that fits most projects: `{"implementation": "recommendations"}` — for `requirements` and `plan` the owner stays
  (для `requirements` и `plan` — `owner`: there the method leaves the decision to a person).
- `answer_max` — how many answers in a row one session may get (3); the owner's word in the tab resets the count.

**The form of a question.** A session asks in text: a block `В-01 …?` with the lines `Тип: requirements|plan|implementation|gate`,
`Рекомендация: …` and `Автоответ: допустим`, and «?» в конце строки with the question: the recommendation is one paragraph without blank lines (a blank line ends the value), the question ends the line and the fields stand on separate lines below it. In the words of the Canon: вопрос заканчивай знаком «?» в конце строки, поля — отдельными строками ниже. A question is closed only when all of this
holds at once: the type is declared and is not `gate`, the mode of the type is `recommendations`, the recommendation is not empty, the
permission `Автоответ: допустим` stands, no word of the gates is in its text, the session is not a review session, the limit is not
spent, and the parse went through. Anything else — and any doubt — stays with the owner, who gets one notice with what is left.
A question about the gates is declared `gate`: approval of `spec.md` and `plan.md` and of a plan, push, merge, deletion, restart or
switch of the service, publication, money, shared environments, giving up a requirement, the ceiling of rounds and handing over.
The list of the words of the gates is open and errs towards the owner (`answer-parse.ts`); on the blocks of the question packs of
earlier specifications it lets pass about a fifth of the questions that are fit by meaning.

**What the session gets.** A service letter "Ответ по настройке проекта (answer_mode: recommendations, тип <тип>), не слово владельца"
with the recommendation, the list of the gates "только слово владельца", the rule "вышел за рекомендацию — вопрос владельцу" and the
numbers of the questions that are left. It is not the owner's word: слово владельца старше автоответа.

**Where to look and how to take it back.** Every answer is a file in `answers/` of the mailbox (kept 30 days from the answer, then removed) and a note in the
history of the task (`crew_task show`); the section "Автоответы" of `/crew` and the line "авто 24ч: N · вмеш. M" of the side panel
show the answers of the last 24 hours and the questions that wait for the owner's word. There is no command to take an answer back: write
in the tab — the record becomes "владелец вмешался" and the count of answers in a row starts over. Without the keys nothing changes.

## Obligations instead of a push controller

A question or a task is the recipient's obligation until it answers (`reply_to: qid`). Windows on
Claude often stop mid-task after writing a status; the plugin keeps them going — by the end of a
turn, not by a timer. The turn's facts come from OpenCode's database (messages between the turn's
start and its `idle` row): a turn with a tool call is a working one, a turn without one is empty.

- a turn ended without the answer → a reminder right away; a working turn resets the empty counter;
- `push_empty_turns` (3) empty turns in a row or `push_max` (20) reminders → the tab is stuck: no
  more reminders, the asker gets a call (a letter and a notice in its window), the task's history
  records it; `crew_task {action: "push"}` wakes it again and clears "stuck";
- a turn with the owner's own message gets no reminder (the owner leads the tab) and resets the count;
- a turn cut off by an OpenCode restart (the session keeps `time_suspended`, no `idle` row, OpenCode
  does not resume it) is picked up by one letter that lists what is open and how to report;
- a task session whose turn ends with a question is not told "continue": the question goes to whoever set the
  task (a letter that wakes it), who answers or asks the owner; a merge lock held longer than `stall_minutes` (30)
  and a submitted task waiting for a reviewer that long are raised to the task's author, and so are the leftovers of a
  closed task (branches here and on origin, worktrees by the project's name templates) ([plan 002.4](../doc/archive/plans/002.4-flow-watch.md));
- service letters of the plugin say "do not answer"; a letter to `crew-harness` itself is refused.

## Tasks

A task has a number `#N` (per project, only grows, kept through rework and reassignment) — the
owner, the integrator and `crew_list` call it by that; a task session's title is `#N title`. The
journal is `tasks/<project>/<N>.json` in the mailbox.

- `crew_spawn {title?, goal, criteria, boundaries?, open_questions?, extra?, tier?, priority?, role?, parent?}` (the
  integrator only) starts task `#N` in a new session, with or without a window. No task without a
  goal and acceptance criteria (the project may require more: `task_fields`); model by tier
  (by default `claude-code/opus` / `sonnet` / `haiku`, `spawn_models` overrides; an enabled set of model profiles overrides both for the stages it describes — see [Model profiles](#model-profiles-sets-of-models-and-windows-by-stage)); a limit of running tasks per
  role (`spawn_limits`, 3); priority `P0` (emergency) … `P3`, default `P2`. With `worktrees` set the
  plugin creates the task's worktree and branch (from the target branch) and starts the session in it, so the
  project's hooks see the task's branch, not the main copy ([plan 002.3](../doc/archive/plans/002.3-task-worktree.md)).
- The start is repeatable: the session id is chosen and written to the journal **before**
  `session.create` (OpenCode accepts an own id starting with `ses` and returns the existing session
  on a repeat), the task letter's id comes from the number — a start cut off at any step is
  finished by the next pass without a second session or letter.
- `crew_task {action}`: `list`, `show {n}`; for the integrator `assign {session, goal, criteria…}`
  (an owner's tab takes the task; it is woken while the task is open, even when closed), `push
  {n, text?}` (wake a stalled executor now), `reassign {n}` (a new session, the same number, a
  summary of what was done), `cancel {n}`, `priority {n, priority}`.
- The executor reports as the answer to the task's qid; the task is submitted (title `#N ✓`) — the
  report does **not** wake the integrator; a second report is refused. The executor's session
  stays open for rework until the task is cleaned.

## Review and merge

The integrator stays free for the owner and does not re-check accepted work:

- a submitted task gets a reviewer by priority (`P0` first): with `reviewer: "integrator"` the
  integrator itself, otherwise a free open `worker` tab (never the author or the executor), or a
  new review session (`spawn_limits.reviewer`, 2); the reviewer gets the task, the report and the
  project's `acceptance` steps;
- the reviewer: `crew_task {action: "review"}` (started; the executor learns it quietly), `rework
  {text}` (back to the executor with the remarks; the resubmission wakes the same reviewer;
  over `rework_max` the integrator gets a call), `merge` (the project's merge lock: one merging
  reviewer at a time), `accept {checks, commit?}` — the plugin requires a report for every
  required acceptance step and checks that the task branch (or a squash commit) is in the target
  branch; then the cleanup steps by `cleanup` (`git worktree remove`, `git branch -D`, `git push
  origin --delete`), and `cleaned` — the plugin checks the worktree and the branch are gone;
  to keep a worktree as evidence call `cleaned {n, keep: [path, ...]}` (up to 8 paths, absolute, or relative to the repository root as `git rev-parse --show-toplevel` gives it from the task directory;
  each must be a worktree of the repository or an existing folder inside the project's worktree folder, never the main tree
  or a branch): the check skips those trees, the answer says `Сохранено: <path> (не проверялось уборкой)`, the task record
  keeps them in `kept` and the history says `улики сохранены: <path>`; the task branch must still be deleted (if it is checked out in a kept tree, run `git checkout --detach` there first, then `git branch -D`; the answer of `cleaned` says so); a repeated
  `cleaned` without `keep` keeps skipping them while they exist;
- cleaned → the sessions of the task close with a line in their history, titles `#N ✓✓ готово`, the
  integrator gets a quiet summary. Titles on the way (a mark and a word): `#N ✓ сдана`, `#N ✓◐ приёмка`, `#N ↻ доработка`, `#N ✓✓◐ влита`
  accepted;
- a task on rework does not hold a review session's place (`spawn_limits.reviewer`): the next submitted task gets
  it; the resubmission goes back to the same reviewer at once;
- `reviewer: "acceptor"` — a separate acceptor role with its own rights ([plan 002.7](../doc/archive/plans/002.7-acceptor-role.md)):
  only a free open tab of role `acceptor` becomes a reviewer (never a `worker` tab), a new review session is born
  with role `acceptor`, review sessions are bounded by `spawn_limits.acceptor` (without it `spawn_limits.reviewer`,
  then 2) and take no `worker` place; `merge`, `accept` and `cleaned` need the task's reviewer AND the `acceptor`
  (or `integrator`) role — a reviewer who changed role loses them; the executor of a task is refused by name. The
  role is shared. The default stays `worker`;
- `inflight_limit` (6) bounds the tasks running and in review; `P0` passes every limit;
- `accepted_slot: "free"` (the default since the owner's decision of 2026-10-09; the explicit `hold` returns the previous
  behaviour: the accepted task holds its place until `cleaned`): an accepted task that is not cleaned yet waits for cleanup and
  no longer counts in `inflight_limit` (`crew_spawn` and the steps of an auto plan count it separately); `cleanup_limit`
  (10, `0` — no limit) stops new work (not `P0`) when that many accepted tasks wait for cleanup, naming them. The tab of an
  accepted task is still woken and reminded (`accepted_reminder_min`), `crew_task list` and `show` mark it "ждёт уборки";
  `OPEN_STATUSES` and `isOpen` are not changed;
- `merge_precheck: "required"` (the default since the owner's decision of 2026-10-09; the explicit `off` returns the previous
  behaviour: `merge` takes the lock at once): `merge` without a green precheck is refused with text that names the next step
  (`precheck {n}` without a lock, then `merge` on the checked tip, and the key that restores the old order), so reviewers
  move to the new order by themselves. **Do not take or hold the merge lock while building the candidate or waiting for CI.**
  Build the integrated candidate from the reported target tip, include the task changes, and run the full project CI before
  recording the green precheck. Save the exact candidate commit that CI checked. Only then call `merge`; it acquires the lock
  for the short landing step. Fast-forward the target branch from that exact checked candidate, not from a rebuilt candidate
  or the task branch alone, then push and call `accept`. If the target tip moved, do not land the old candidate: build and
  check a new one, record a new precheck, and retry. `accept` releases the task's inflight/worker slot when
  `accepted_slot: "free"`; perform its returned cleanup steps separately and call `cleaned` when done. The cleanup queue is
  bounded by `cleanup_limit` (10 by default). The merge lock is released by `accept` (and by `rework` and `cancel`): after the
  merge and the push call `accept` at once, the cleanup runs without the lock; if the merge is abandoned before `accept`,
  call `unlock {n}`; `cleaned` does not release the lock (there is none by then). The answers say it at the moment of the action: `accept`, `rework` and `cancel` report that they released the lock (only when it was held), and `cleaned` warns when the session still holds it. While it is held, only the merge and the
  push happen under it. The service pass releases the lock by itself when the held task's checked candidate (the green
  record) is already an ancestor of the target tip on `origin` (`git ls-remote` with the 20 s term and `merge-base`
  on local objects, no fetch, nothing written but the history note "замок отпущен: слияние на вершине" and a log line);
  it does nothing when the tip cannot be read, the record is not green, or the lock is held for another task; `accept`
  The lock knows its task: `accept`, `rework`, `cancel`, `unlock` release it only for the task they act on. With
  `merge_lock_per_task: on` (default `off`, the previous behaviour) a `merge` of another task by the holder is refused until `accept`, `rework`
  or `unlock` of the first one (with `merge_precheck: required` the gate always does this). A reviewer refused with "lock busy" is
  recorded in its own card (`lock_wait`, gone with the tab); when the lock is released (or found abandoned) every such live reviewer of the
  project gets a letter "lock is free" (no queue, no reservation; the lock is still taken atomically by whoever calls `merge` first), and
  `/crew` and the panel show one line "ждут замок: #N (мин)". A broken settings file of the old (no settings repository) form keeps the last good
  settings and is named by `crew_doctor`.
  then does not ask for the lock (only while the record is still green and of this round: a record marked stale by `rework`, `unlock`,
  a new review or `reassign` loses the mark). The release does not depend on `stall_minutes`. It counts the merge as done once the
  candidate is in the target tip: a mark that the plan step needs in the same merge must be inside the candidate, not pushed after it. The plugin still merges and pushes nothing. The lock is issued only on the
  tip of the target branch where the candidate was already built and checked. The reviewer calls `precheck {n}` (the plugin
  reads the tip of `origin/<target_branch>` with `git ls-remote`, nothing is fetched or written, and names it), merges that tip
  into a candidate (for example `integrate/tN`), runs the project's CI on it, then `precheck {n, candidate, result}` — the
  record becomes green (the candidate must exist locally and contain the tip; the task branch not being in it is only a
  warning). `merge` then reads the tip again **under the lock**: moved — the lock is released and `merge` is refused naming both
  tips (a new precheck is needed); the same — the lock is issued on that tip. `unlock {n}` releases a lock you hold for the
  task. The record becomes stale on `rework`, `reassign`, `cancel`, `unlock` and a new review after a re-submit. The plugin never
  merges, pushes or runs CI: the plugin only reads. A reviewer who already holds the lock for one task cannot take it for
  another. If the tip cannot be read (network, 20 s term, no such branch on `origin`) `merge` is refused with the cause and
  the lock is not issued; a repeat of `merge` by the holder keeps the lock in that case. Without `origin` the tip of the
  local branch is used;
- `task_extra_fields` (default empty): up to 8 project fields `{id, label, hint?}`; `crew_spawn` and `crew_task assign`
  take `extra {id: one line up to 300 characters}`, the values go into the executor letter, the reviewer letter (with the path
  of the task record, field `extra`) and `show` under "ДОПОЛНИТЕЛЬНО (поля проекта)". An unknown id is refused naming the
  declared ones; `order` takes no `extra`.

**After the landing.** The reply "already merged, call `accept`" to a repeated `merge` relies on the same local check as
`accept` (the task branch is an ancestor of the target branch, no `fetch`): it works when the landing was made from the
task's repository. A landing from another clone before `fetch`, or a squash, shows as a shifted tip: start a new precheck.
After the lock is lost the landing is confirmed by a new precheck as well. Between the last check of the lock and the reply
a few milliseconds remain in which another process may take it; the consequence is that `accept` refuses ("lock first"), the
reply issues nothing.

**If something goes wrong.** The lock may be lost at any time (`cancel` or `rework` of another task by the same reviewer,
a takeover of a stale lock, a restart); `accept` always checks it again. A stuck or unwanted lock: `unlock {n}`; a moved tip:
a new `precheck`; the work is returned: `rework`. The state lives in the task record and the lock file only (no timers): a
restart letter gives the state of the precheck and of the lock. The lock is not the last line of defence: `git` refuses a
non-fast-forward push and the project's own landing script checks again.

## Plans

New work starts with a plan: a document in the project's repository (`plans_dir`, default `docs/plans`,
named `{n}-{slug}.md`). The integrator sets a plan task: `crew_spawn {kind: "plan", title, goal}`.
`goal` is the original task the plan must solve. The plugin picks the plan number: the next one after
the files in the plans folder and the open plan tasks. A sub-plan gets `N.k`.

**Writing the plan.** The executor writes the plan from the template in its letter:
- header: `Статус`, `Источник`, `Зависимости`;
- sections: «Зачем», «Что уже есть», «Режим выполнения», «Фазы», «Не делаем», «Открытые вопросы»,
  «Решения владельца»;
- phases `### Ф.N`, and in them steps `#### Ф.N.M` with `[P1] [после: …] [где: …]`;
- each step has a «Что:» line and an «**Приёмка:**» block.

The report is refused while the file is missing or its form is wrong. The form check covers the
header, the sections, «Что» and «Приёмка» of every step, open questions as a quadruple with
«Блокирует», and `после:` pointing at real steps with no cycles.

**Recheck in rounds.** Each round is run by a new session: not the plan's author and not a previous
reviewer. The reviewer goes through two groups of steps:
- **A — against the original task:** goal, coverage table "requirement → step → criterion",
  assumptions, scope, what already exists, the mode question;
- **B — how the plan is composed:** machine-checkable criteria with a red probe, criterion tools
  tried before and after, one step = one task, explicit dependencies, existing paths, form.

The round ends with `crew_task {action: "round", n, blocking, significant, cosmetic, text}`. The grade
of a remark is set by what fixing it changes:

| Grade | What fixing it changes |
|---|---|
| blocking | the plan does not solve the task |
| significant | the content: a step, a criterion, the order, a dependency, the boundaries |
| cosmetic | only the text |

When in doubt, the higher grade applies. A blocking or significant remark sends the plan back to its
author. The plan is ready when `plan_clean_rounds` (2) rounds in a row find only cosmetic remarks.
After `plan_rounds_max` (4) rounds the owner decides.

**Approval by the owner.** A ready plan notifies every window. The owner types `/plans` in a window
and chooses one of:
- approve without shortcuts;
- approve with the shortcuts named in the plan;
- return it with remarks.

The decision is written by the window, so an agent cannot fake it. A new session writes the decision
into the plan («Режим выполнения», «Решения владельца») and merges it. `accept` reads the plan in the
target branch and requires its form and the owner's answer.

**Steps become tasks.** Once the plan is merged, each step becomes a task. The task gets the step's
«Что» as its goal, the step's «Приёмка» as its criteria, and the plan's «Не делаем» and mode as its
boundaries. A step starts when:
- everything in its own `после:` and its phase's `после:` is closed;
- no running step shares its `где:`;
- the project's limits allow it.

Order is by priority (the step's, else the phase's), then by plan order. A `[подплан]` step becomes a
plan task. A step task is accepted only with «✅ СДЕЛАНО <date>, commit» in its heading in the target
branch. When every step is closed, the author is asked to close the plan. `/crew` shows each plan:
written, rechecked (round, clean rounds), waiting for approval, or in progress (steps closed/total,
which are running).

Marks: plan `🔴 ОТКРЫТ / 🟡 В РАБОТЕ / ✅ ЗАКРЫТ / ❌ ОТМЕНЁН`, step `⏳ В РАБОТЕ / ✅ СДЕЛАНО`, criterion
`✅ ВЫПОЛНЕНО / ⬜`, question `❔ / ✅`.

**Acceptance steps from the project canon.** `acceptance_file` is a path inside the project repository; the plugin reads it from the target branch (`origin/<target>`, then the local branch; cached for a few seconds) and takes the steps from a markdown table with the columns `id | text | required`:

```
| id    | text                       | required |
|-------|----------------------------|----------|
| ci    | Run the project's full CI  | yes      |
| notes | Update the changelog       | no       |
```

`id` is lowercase Latin letters, digits, `_`, `-`, unique; `required` is `yes` unless the cell says `no` / `нет` / `false` / `0` / `-` (an empty cell means required). Rows without an id (or with a bad or repeated one, or without text) are skipped with a warning in the log. If both `acceptance_file` and a non-empty `acceptance` are set, `crew_doctor` reports an error and the file wins; if the file cannot be read (not in the branch, no table), the plugin falls back to `acceptance` and logs a warning. Without `acceptance_file` nothing changes. The order of acceptance is not written in the table: the plugin sets it (`crew_help`, ACCEPTANCE). `plan_acceptance` and `plan_merge_acceptance` are separate and unchanged.

**Everything is a setting.** The plan's form and process are project settings with nova's form as the default: `plan_sections`, `plan_header`, `plan_prefix`, `plan_labels`, `plan_marks`, `plan_mode_question`, `plan_acceptance`, `plan_merge_acceptance`, `plan_grades` (`{id, name, text, clean}`), `plan_approver` (owner / integrator — `crew_task plan_decide`), `plan_steps` (auto / manual), `plan_template` (a template file in the repository). `crew_config guide` asks about each.

**Heavy runs.** `heavy_commands` lists substrings of commands that load the machine (full gate,
full build, full test run, benchmarks). `crew_watch` with such a command goes to the machine queue
by itself. Full design: [plan 004](../doc/archive/plans/004-plans.md).

## Model profiles: sets of models and windows by stage

Which model runs a stage of work and how big its context window is are two settings of the project, kept as plain
JSON in `.opencode/crew-harness.json` (any reader sees them without this plugin; the decision is
[ADR-0008](../doc/canon/decisions/ADR-0008-model-profiles-layer-and-window-files.md)). Without these keys nothing changes:
`spawn_models`, `tiers`, `reviewer` and the texts of the tools work as before.

- **The table of profiles** — `model_profiles`: a family (`claude`, `kimi`, `codex` — any short name from lowercase Latin
  letters, digits and dashes, not `all`, `context`, `output`, `input`) and a tier (`heavy`, `medium`, `light`) give a
  model `provider/model` and its **window whole**: `context`, `output` (both required: OpenCode drops a `limit` without
  `output` together with the provider record) and, for models whose compaction is driven by `input`, `input`. An empty
  record `{"model": ""}` means «fill in»; a set that refers to it is not enabled.
- **Sets** — `profile_sets`: a named layout «stage → family and tier». A phase of the cycle includes stages (the table
  «Этапы и модели» of the Canon, [process.md](../doc/canon/process.md)). The four you set yourself are `develop` (the
  executor of a task), `develop_accept` (the reviewer; the old name `accept` is read as an alias and replaced when you
  set the stage), `plan` (a plan task) and `plan_accept` (the rounds of a plan review and the
  merge of an approved plan). Four more stages inherit when you do not set them: `spec` as `plan`, `spec_accept` as
  `plan_accept`, `delivery` as `develop` and `delivery_accept` as `develop_accept`, the last two one tier lower (a `task` cell:
  the tier of the task, then one lower); the plugin stores and shows them, the sessions of the specification and delivery are
  still run by the orchestrator. A cell is `{"family": "claude", "tier": "heavy"}`; the tier `task` means «the tier of the
  task» (the default behaviour). A stage without a cell (and nothing to inherit) keeps the model of `spawn_models`.
  A check stage without a cell goes by `spawn_models` (the owner's decision of task 003). The old name `accept` stays a readable alias of `develop_accept` (the settings file of this repository still uses it; nothing rewrites it). A check on the same family as its author while another family exists is only noted by `/crew-sets show` (the rule «the
  reviewer is on another model family», ADR-0013). Names of sets: lowercase Latin
  letters, digits, dashes, up to 40 characters, not a word of the commands or a word kept from the removed ones (`use`, `reset`, `all`, `list`, `show`, `set`,
  `unset`, `new`, `rename`, `delete`, `check`, `save`, `from`).
- **The enabled set** — `profile_set`: the name, set by a person (`/crew-sets use`, or editing the file);
  `crew_config set` refuses this key whatever the value. `use` writes the name into the file of the project, takes effect
  at once and needs no commit and no restart of the service.
- **Tier bounds** — `tier_min` and `tier_max` (`light`, `medium`, `heavy`; no key — no bound), project settings in the same
  file. Any tier of any stage (explicit, inherited, `task`, the `tier` of `crew_spawn`) is clamped into them, so there is no
  need for a separate set with explicit tiers to cap the cost. The clamp holds on every path that picks a model, with a set
  and without one: `crew_spawn`, the steps of an auto-plan, the review session started without a cell of the set (the tier of
  the task record is clamped when the session starts) and `reassign` (without a set the model of the record stays while its
  tier is inside the bounds). The `tier` of `crew_send` picks a tab, not a model, and is not clamped. A clamp is written to the
  log of the plugin and to the task event, and into the task record (`profiles`: `clamped_from`; without a set the set is
  «(без набора)»), and `/crew-sets show` prints the tier of the set and the tier after the clamp. If the clamp lands on a family
  that has no profile of that tier, the session is refused and the text names the clamp as the cause (the nearest tier is not
  searched). `tier_min` above `tier_max` is a settings error: `crew_config set` refuses such a write (also against the other key
  already in the file), and if it comes into the file by hand `crew_doctor` says so and the bounds are not applied.

The window is a property of the model **in a folder**, not of a stage or a session. The plugin writes the windows of the
models of the enabled set (all three tiers of every family named in the set, because `tier` on the input of `crew_spawn`
moves a session along the tiers of its family) as `.opencode/opencode.json` **into the worktree of each task**, before
the first turn of the session; OpenCode and the `claude-code` provider read it within seconds, without a restart. The
file holds only `limit` of the models (`context` and `output` together, `input` when the profile has it) and the key
`_crew_harness` (the mark: a file without it is never overwritten or removed); it never holds `compaction` — the
thresholds stay the owner's. It is excluded from git through `info/exclude` of the common git directory and removed when
the set is switched off, the task is accepted or cancelled, or its folder is gone.

**The window of a profile applies only to sessions in the worktree of a task (development, planning).** The review
sessions (`develop_accept`, `plan_accept`) run in the main folder: their model comes from the set, but their window comes from the
owner's general hand-written settings for that model; `use`, `check` and `/crew-sets show` say so and print the number
and the file. The root of the project and the main folders get no file, and a task without a worktree gets none. A
hand-written `.opencode/opencode.jsonc` in the same folder is stronger than the file of the plugin there (the plugin
names such a case, with the file and the value, in `use`, `check` and `crew_doctor`); an explicit `autoCompactWindow` of
the `claude-code` provider is stronger than the window for Claude Code and is never rewritten — only named. For a model
with `input` the compaction is driven by `input` (the threshold is `input` minus `compaction.reserved`), otherwise by
`context`; a **smaller window compacts** the tabs whose context is above the new threshold on their next turn.

Reviewers on another family. With a cell that has an explicit tier (`develop_accept: kimi/heavy`) an open tab of the reviewer role
is taken only if its model is a model of that family (any of its three tiers; `openai/gpt-5.5#high` fits the profile
`openai/gpt-5.5`, `openai/gpt-5.5-fast` does not); otherwise a new review session starts in the main folder on the model
of the cell — when there is no free open tab of the role. With a `task` cell the model of an open tab is not checked, as
without a set. With `reviewer: integrator` the reviewer is the integrator's tab on its own model and the set does not
change that (the plugin never switches the model of an open tab). A reviewer on Kimi or Codex works with the same
`crew_*` tools; the rules of the repository's `.claude` act in a tab of another family only in part (the PreToolUse
hooks of the shell, `permissions.deny` and `.claude/commands` through the guards plugin; `Write`, `Stop`,
`SessionStart` and `PostToolUse` hooks do not).

Commands of the window (answers are shown in a dialog at once, no turn of the model; a window opens the commands after its restart). In the window `/crew-sets` and `/crew-profiles` open a menu: the table and every verb below with its arguments; a verb with arguments opens an input with the format and an example of that verb. The catalog of models for `check` and `use` comes from the window, otherwise from a snapshot that the plugin of the service writes (`model-catalog.json` in the mailbox, every 10 minutes); an old or absent snapshot is named in the answer. Sizes in the answers are written as «контекст 720K · вывод до 64K» (with a separate input limit: «контекст 525K · ввод 461K · вывод до 128K»); «контекст» is the OpenCode `limit.context`, the word «окно» is kept for the terminal window:

| Command | What it does |
|---|---|
| `/crew-sets` | a table of all sets, the enabled one marked |
| `/crew-sets show [name]` | a set in detail: model, tier and effective window per stage; the enabled one if no name |
| `/crew-sets use <name>` | enable a set (writes `profile_set` into the file of the project): what changed, the windows «was → became», the compaction of smaller windows |
| `/crew-sets set <name> <stage> <family>/<tier>` | change a cell (stages: `develop`, `develop_accept` (also `accept`), `plan`, `plan_accept`, `spec`, `spec_accept`, `delivery`, `delivery_accept` or Russian words) |
| `/crew-sets unset <name> <stage>` | remove a cell: the stage goes back to `spawn_models` |
| `/crew-sets new <name> [from <other>]`, `rename <a> <b>`, `delete <name>` | create (empty or a copy), rename (the enabled name follows), delete (not the enabled one) |
| `/crew-profiles` | a table «family, tier → model, window» |
| `/crew-profiles show [<family>]` | the table in detail or one family with the sets that refer to it |
| `/crew-profiles set <family> <tier\|all> <model> <context> output=<n> [input=<n>]` | create or change a record; `all` changes the three tiers in one check |
| `/crew-profiles new <family> [from <other>]`, `rename <a> <b>`, `delete <family> [<tier>]` | three empty records or a copy; rename updates every set; delete is refused while a set refers to the record |
| `check` (both commands) | the whole table and the sets against the catalog of OpenCode («not checked» when the catalog is unavailable), hand-written windows, the explicit threshold, empty records, links; changes nothing |

Edits act at once, without a commit and without any layer between: every command rewrites the three keys (`model_profiles`,
`profile_sets`, `profile_set`) of the file `.opencode/crew-harness.json` in the working copy of the settings folder, in one
atomic write; the data in force are those keys of the working copy (the plugin does not commit — commit the file when you
want the change to travel). An edit that would make the enabled set invalid or leave a dangling reference is refused whole
and the file stays as it was. There is no `save` and no `reset`: the earlier local layer
(`profiles/<project>.layer.json` in the mailbox of the plugin) is switched off — see [ADR-0014](../doc/canon/decisions/ADR-0008-model-profiles-layer-and-window-files.md);
an old layer file is not read, the service and `check` name it once, and it can be deleted by hand. An invalid state that came not through the commands (a commit removed a profile) does not stop the running tabs:
sessions go by the last valid state (the snapshot) with a warning in `/crew-sets`, `crew_doctor` and a notice in the
window; a set that is gone and has no snapshot gives a refusal that names the set. Every edit leaves one line
`profile edit: …` in the log of the plugin; a task keeps, per launched session, the stage, the set, the family, the tier
and the model.

An example of the two keys (invented numbers; `crew_config set` takes it in one call, or copy it into the file; the default
name is not part of it):

```json
{
  "model_profiles": {
    "claude": {
      "heavy": { "model": "claude-code/opus", "context": 720000, "output": 64000 },
      "medium": { "model": "claude-code/sonnet", "context": 720000, "output": 64000 },
      "light": { "model": "claude-code/haiku", "context": 220000, "output": 32000 }
    },
    "kimi": {
      "heavy": { "model": "kimi-code-plan-global/k3-256k", "context": 220000, "output": 131072 },
      "medium": { "model": "kimi-code-plan-global/k3-256k", "context": 220000, "output": 131072 },
      "light": { "model": "kimi-code-plan-global/k3-256k", "context": 220000, "output": 131072 }
    },
    "codex": {
      "heavy": { "model": "openai/gpt-5.5", "context": 525000, "input": 461000, "output": 128000 },
      "medium": { "model": "openai/gpt-5.6-terra", "context": 525000, "input": 461000, "output": 128000 },
      "light": { "model": "openai/gpt-6-luna", "context": 525000, "input": 461000, "output": 128000 }
    }
  },
  "profile_sets": {
    "default": {
      "develop": { "family": "claude", "tier": "task" },
      "plan": { "family": "claude", "tier": "task" },
      "develop_accept": { "family": "claude", "tier": "task" },
      "plan_accept": { "family": "claude", "tier": "task" }
    },
    "cross-kimi": {
      "develop": { "family": "claude", "tier": "task" },
      "plan": { "family": "claude", "tier": "task" },
      "develop_accept": { "family": "kimi", "tier": "heavy" },
      "plan_accept": { "family": "kimi", "tier": "heavy" }
    },
    "cross-codex": {
      "develop": { "family": "claude", "tier": "medium" },
      "plan": { "family": "claude", "tier": "heavy" },
      "develop_accept": { "family": "codex", "tier": "heavy" },
      "plan_accept": { "family": "codex", "tier": "heavy" }
    },
    "kimi-only": {
      "develop": { "family": "kimi", "tier": "heavy" },
      "plan": { "family": "kimi", "tier": "heavy" },
      "develop_accept": { "family": "kimi", "tier": "heavy" },
      "plan_accept": { "family": "kimi", "tier": "heavy" }
    }
  }
}
```

`default` keeps the choice of models and of open reviewer tabs as it was **while the models of the `claude` profiles equal
`spawn_models`** of the project (`check` warns when they differ); the file of windows in the worktree is still written with
the values of the table. A set with an explicit tier of `develop_accept` narrows the open reviewer tabs to its family. The other
sets show what is possible. The windows of the models of one family may repeat a model on several tiers (Kimi has one model
on all three) only with equal fields; two profiles of a set with different windows for the same model make `use` refuse,
because the window in OpenCode is one per model and folder. The window of a hand-written
`.opencode/opencode.jsonc` of the repository (for example 520000 for a model that the owner's global settings give 720000)
is what the tabs in the main folder use — the plugin only names it.

## Other projects

- **inbound** of the receiving project limits letters from other projects: `integrator` (default:
  only to its integrator), `any`, `none`; a refused letter names the address to use;
- **an order**: `crew_task {action: "order", to: "beta.integrator", goal, criteria, …}` records task
  `#N` of kind order in the orderer's journal (no session, no title marks) and sends it to beta's
  integrator, who does it with its own tasks: `crew_spawn {…, parent: "alpha#N"}`. The order follows
  that task: cleaned → the order is done (a quiet summary to the orderer), cancelled → a call.

## Other machines (prototype)

Letters to projects on other machines (`remote.ts`). Each machine has
`<data>/crew-harness/remote.json` — not in a repository. Two transports:

**Tailscale** (`tailnet.ts`, recommended): bridges talk HTTP directly inside your Tailscale network.
The network names the sender (`tailscale whois`), so there is no shared secret, and each machine has
its own rights:

```json
{ "node": "home", "transport": "tailnet",
  "nodes": { "vps-1": { "projects": ["site"], "may_write": ["nova.integrator"] } } }
```

- `nodes` — the machines this one talks to, by their Tailscale name (`host`/`port` if not the
  MagicDNS name and port 7647); a machine not listed gets 403;
- `projects` — that machine's projects: `crew_send {to: "site.lead"}` goes to `vps-1`;
- `may_write` — where that machine may write here: `project.role`, `project.*` or `*`;
- the bridge listens only on the Tailscale address (`tailscale ip -4`), so on a VPS with a public
  address the port is not open to the internet. Let only the bridge port through in the tailnet ACL;
- a refusal there comes back to the sender as a note; an unreachable machine keeps the letter and
  retries (1, 2, 4… up to 60 s) for 24 h.

**ntfy** (`ntfy.ts`): a shared encrypted channel on [ntfy](https://ntfy.sh) for machines outside a
tailnet. All machines of the channel are equal — the secret is its only protection:

```json
{ "node": "home", "secret": "<the same on every machine>", "projects": ["site"] }
```

The topic and the AES-256-GCM key come from `secret` (a new one: `ntfySecret()` from `ntfy.ts`);
optional `server` and `token` for your own ntfy server. The channel is shared, so a refusal stays in the
receiver's log. A letter takes about 1–3 s on ntfy.sh (`node test/ntfy-latency.mjs`); anonymous
ntfy.sh limits requests and messages per day, so pending letters leave together.

Both:

- a session of another machine you got a letter from is remembered with its machine, so a reply to
  its `from_session` goes back there. `tier` and `project.all` do not work across machines;
- one process per machine holds the bridge (`remote/bridge.lock`); it takes only letters for its own
  projects, by the project's `inbound`; a session gets letters only from a machine it wrote to itself.
  A letter that cannot be sent goes to `remote/failed/`, and its sender gets a note.

### Status (2026-10-07)

A prototype. Checked by self-tests only: fake ntfy and GitHub servers, two real HTTP bridges on
`127.0.0.1` with a faked `whois`, the bridge with a fake transport. One live run: 5 pings over ntfy.sh,
median about 2 s, most of it the publish request. Not yet run inside a live OpenCode, not across real
machines, and not against a real Tailscale: the parsing of `tailscale whois --json` (`Node.Name`) is
written from memory. No type check (no TypeScript in the project). `github.ts` is a transport kept for
comparison; nothing uses it.

Known gaps:

- **the ntfy cursor lives in memory**: after a restart the bridge reads the channel from its start, so
  letters sent while no OpenCode process ran on the machine are lost, though ntfy.sh keeps them ~12 h;
- **ntfy has no sender identity**: one shared secret, every machine of the channel is equal, a refusal
  stays in the receiver's log, and the sender is told "sent" even if no machine took the letter;
- **Tailscale keeps the outgoing queue in memory**: retries survive a pause, not a restart of the bridge
  process (the letter stays in `remote/outbox/` and is sent again — the receiver drops the repeat by id);
- **only letters cross machines**: no `tier`, no `project.all`, no tasks or orders (`crew_task`,
  `crew_spawn`), no `crew_watch` or status; `crew_list` does not show tabs of other machines;
- **remote.json is edited by hand**: `crew_config` does not touch it, and a broken file is only logged;
- **the queue and back-off code is repeated** in `github.ts`, `ntfy.ts` and `tailnet.ts`.

Next:

1. Check on a real tailnet: `tailscale ip -4` and `whois` output on Windows and Linux, a letter between
   this machine and a VPS, the ACL that leaves a worker only the bridge port.
2. Orders across machines: `crew_task order` to the integrator of a project on another machine, which
   runs it with its own tasks; the order's status comes back. Code moves through git: the worker pulls a
   branch from a shared remote and pushes its result to its own branch; review and merge stay at home.
3. OpenCode without windows on a VPS (`opencode serve`): today a wake needs an open tab or a
   `crew_spawn` task — check what a headless worker needs.
4. Smaller: keep the ntfy cursor in a file; `crew_list` with remote machines (reachable or not); edit
   `remote.json` through `crew_config`; one shared queue module for the transports; drop `github.ts` if
   nothing needs it.

## Self-check

`crew_doctor` (and once at load, as a notice): the OpenCode features the plugin relies on, the
mailbox, whether any window plugin is beating, whether the caller's tab is visible to a window.

The system hint the plugin adds to each request is **constant** within a session (it sits before
the whole history, and anything changing there re-bills the history with Claude's prefix prompt
cache); neighbours and their models come from `crew_list`.

## Windows on the `claude-code` provider (MCP)

The [`claude-code` provider](https://github.com/unitcraft/opencode-claude-code-provider) hands
every turn to the official Claude Code and drops OpenCode's tool list, so the plugin's `crew_*`
tools do not reach those tabs. `mcp.ts` is a stdio MCP server with the same tools
(`mcp__crew__crew_list`, ... in Claude Code), built on the same core (`core.ts`) as the plugin:

```sh
OPENCODE_CREW_SESSION=<opencode session id> node mcp.ts   # node >= 24
```

- it acts for the one OpenCode session in `OPENCODE_CREW_SESSION` (the provider sets it per
  request) and writes to the same mailbox (`XDG_DATA_HOME` as for OpenCode);
- the project list is not repeated: the plugin writes its `projects` and `local` options to
  `<mailbox>/projects.json` at load (`OPENCODE_CREW_PROJECTS`, JSON of the `projects` value,
  overrides);
- delivery stays with the plugin (the letter goes into the OpenCode session); a task started from
  MCP is written to the journal and the plugin starts it on its next pass; a `crew_watch` from MCP is
  a request file the plugin runs (the MCP server lives only as long as Claude Code's turn).

## Install

```sh
git clone https://github.com/unitcraft/crew-harness C:/work/crew-harness
```

`~/.config/opencode/opencode.jsonc` (the server plugin):

```jsonc
"plugins": ["C:/work/crew-harness/opencode-plugin"]
```

`~/.config/opencode/cli.json` (the window plugin; the plugin folder, not a file — OpenCode loads `tui.ts`
from it):

```json
{ "plugins": ["C:/work/crew-harness/opencode-plugin"] }
```

Windows opened before the window plugin was added do not report their tabs: reopen them.

## Related

Other OpenCode plugins of the same set (they work independently; together they are tested on one machine):

- [opencode-windows-env](https://github.com/unitcraft/opencode-windows-env) — a sane command environment on Windows and a time stamp on agent messages
- [opencode-claude-guards](https://github.com/unitcraft/opencode-claude-guards) — the repository's Claude Code rules (hooks, permissions) in OpenCode windows
- [opencode-claude-code-provider](https://github.com/unitcraft/opencode-claude-code-provider) — OpenCode provider `claude-code` on top of the official Claude Code

## Test

```sh
npm test   # node >= 24
```

What each test checks, the manual latency checks and what the tests do not cover — [test/README.md](test/README.md).

History: moved with its commits from a private plugins repository of the nova project (`plugins/nova-peers`).
Renamed 2026-10-07 (plan 005): `nova-peers` → `opencode-peers` → CrewHarness (`crew-harness`); the plugin id is
`crew-harness`; the mailbox `crew-harness` is a junction to the folder of the earliest one (nothing moves, nothing is
lost); the settings file is `.opencode/crew-harness.json` (`.opencode/opencode-peers.json` is still read, with a
`crew_doctor` note to rename it).

License: MIT OR Apache-2.0 (see [LICENSE](../LICENSE)).
