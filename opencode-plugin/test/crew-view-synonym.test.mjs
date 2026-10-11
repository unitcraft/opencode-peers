// Self-test: action "view" is a synonym of "show" in crew_task and crew_config (node >= 24):  node test/crew-view-synonym.test.mjs
// VS-1: crew_task view = show for one task. VS-2: crew_config view = show. VS-3: an unknown action is still refused.
import { harness, reporter } from "./landing-harness.mjs"

const { cell, done } = reporter("crew-view-synonym.test")
const H = await harness("crew-view-synonym", { settings: { merge_precheck: "off" } })
const { call } = H
const INTEG = "sesINTEG1"
const t = H.reviewing()

const a = await call("crew_task", INTEG, { action: "show", n: t.n })
const b = await call("crew_task", INTEG, { action: "view", n: t.n })
cell("VS-1 crew_task view equals show", a.length > 20 && a === b, a + "\n---\n" + b)

const c = await call("crew_config", INTEG, { action: "show" })
const d = await call("crew_config", INTEG, { action: "view" })
cell("VS-2 crew_config view equals show", c.length > 20 && c === d, c + "\n---\n" + d)

const u1 = await call("crew_task", INTEG, { action: "bogus", n: t.n })
const u2 = await call("crew_config", INTEG, { action: "bogus" })
cell("VS-3 unknown action is still refused", /Неизвестное действие «bogus»/.test(u1) && /Неизвестное действие «bogus»/.test(u2), u1 + "\n---\n" + u2)

done(H)
