// Self-test: endsWithQuestion also fires on phrases that wait for the owner's word without a question mark (task 024; node >= 24):
//   node test/crew-waiting-phrases.test.mjs
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = mkdtempSync(path.join(os.tmpdir(), "crew-phrases-"))
process.env.XDG_DATA_HOME = tmp
const status = await import("../status.ts")
let fail = 0
const cell = (name, ok, extra = "") => { if (!ok) { fail++; console.log(`FAIL ${name} ${extra}`) } }

const yes = [
  "жду вашего отдельного разрешения на вливание",
  "Итог.\nПриёмщик ждёт слова владельца.",
  "Ожидаю вашего решения по ветке",
  "Мы ждём вашего подтверждения",
  "Ожидает согласия владельца на пуш.",
  "Awaiting your distinct landing GO",
  "Waiting for your approval to merge.",
  "I need your decision on this.",
  "Ready.\nAwaiting owner confirmation\nSignature",
  "Всё сделано.\nЖду вашего GO.\nСТОП: ожидание",
]
const no = [
  "не жду разрешения",
  "Не требуется ваше разрешение.",
  "разрешение получено",
  "ждал вашего слова, получил",
  "awaiting nothing",
  "no approval needed",
  "Готово. Ничего не жду, продолжаю.",
  "Не ожидаю вашего решения, делаю сам.",
  "not waiting for your approval",
  "Жду результата тестов.",
  "Awaiting CI results.",
  "Старая строка: жду вашего слова\nА1\nА2\nА3",
]
for (const t of yes) { const r = status.endsWithQuestion(t); cell(`yes: ${t}`, typeof r === "string" && r.length > 0, String(r)) }
for (const t of no) { const r = status.endsWithQuestion(t); cell(`no: ${t}`, r === undefined, String(r)) }
const long = "жду вашего слова " + "я".repeat(400)
cell("long text cut to 300", (status.endsWithQuestion(long) ?? "").length === 301, String(status.endsWithQuestion(long)?.length))
cell("question still wins as before", status.endsWithQuestion("Итог.\n\nПушить main?\n\nСТОП: вопрос") === "Пушить main?")

rmSync(tmp, { recursive: true, force: true })
console.log(fail ? `crew-waiting-phrases.test: FAIL ${fail}` : "crew-waiting-phrases.test ok")
process.exit(fail ? 1 : 0)
