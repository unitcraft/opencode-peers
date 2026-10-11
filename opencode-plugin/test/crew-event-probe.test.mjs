// Self-test of the event probe (task 026; node >= 24):  node test/crew-event-probe.test.mjs
import { probeEnabled, startEventProbe, describeEvent } from "../event-probe.ts"

let fail = 0
const cell = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " :: " + detail}`)
  if (!ok) fail++
}
const lines = []
const log = (l) => lines.push(l)
const form = { type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_9", title: "Q", metadata: { kind: "question" } } } }

cell("off by default", !probeEnabled({}) && !probeEnabled({ CREW_HARNESS_EVENT_PROBE: "0" }) && probeEnabled({ CREW_HARNESS_EVENT_PROBE: "1" }), "flag")
cell("noise is dropped", describeEvent({ type: "message.part.delta", data: {} }) === undefined, "noise")

let subs = 0
await startEventProbe({ event: { subscribe: () => { subs++ } } }, log)
cell("subscribes via event.subscribe when no hook", subs === 1 && lines.some((l) => l.includes("event.subscribe")), lines.join("|"))

lines.length = 0
let hook
await startEventProbe({ session: { hook: async (n, cb) => (hook = [n, cb]) } }, log)
hook[1]({ event: form })
cell("hook: form.created logged with id and kind", hook[0] === "event" && lines.some((l) => l.includes("id=frm_1") && l.includes("kind=question") && l.includes("session=ses_9")), lines.join("|"))

lines.length = 0
async function* gen() { yield form }
await startEventProbe({ event: { subscribe: async () => gen() } }, log)
await new Promise((r) => setTimeout(r, 50))
cell("iterator is consumed", lines.some((l) => l.includes("id=frm_1")), lines.join("|"))

lines.length = 0
let threw = false
try {
  await startEventProbe({ session: { hook: async () => { throw new Error("boom") } }, event: { subscribe: () => { throw new Error("bang") } } }, log)
} catch { threw = true }
cell("errors do not escape, reason logged", !threw && lines.some((l) => l.includes("не удалась") && l.includes("boom") && l.includes("bang")), lines.join("|"))

process.exit(fail ? 1 : 0)
