// Self-test of model variants in profiles (task 009; node >= 24):  node test/crew-profiles-variant.test.mjs
// A cell holds the variant (effort) as the suffix "#variant" of model or as the field variant; both only when equal.
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = mkdtempSync(path.join(os.tmpdir(), "crew-profiles-variant-"))
process.env.XDG_DATA_HOME = tmp
process.env.CREW_HARNESS_POLL_MS = "100"
const P = await import("../profiles.ts")
const Cmd = await import("../profile-cmd.ts")

let fail = 0
const cell = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " :: " + detail}`)
  if (!ok) fail++
}
const K = "kimi-code-plan-global/k3-256k"
const base = { context: 100, output: 10 }
const inv = (p) => P.invalidProfile({ ...base, ...p }, "x")
cell("suffix form passes", inv({ model: `${K}#low` }) === undefined, String(inv({ model: `${K}#low` })))
cell("field form passes", inv({ model: K, variant: "low" }) === undefined, String(inv({ model: K, variant: "low" })))
cell("both equal pass", inv({ model: `${K}#low`, variant: "low" }) === undefined, String(inv({ model: `${K}#low`, variant: "low" })))
cell("both different are refused", /дважды/.test(inv({ model: `${K}#low`, variant: "high" }) ?? ""), String(inv({ model: `${K}#low`, variant: "high" })))
cell("an empty suffix is refused", inv({ model: `${K}#` }) !== undefined, "accepted")
cell("a bad variant field is refused", inv({ model: K, variant: "a b" }) !== undefined && inv({ model: K, variant: 5 }) !== undefined, "accepted")
cell("no variant works as before", inv({ model: K }) === undefined && P.variantOf({ model: K }) === undefined && P.modelWithVariant({ model: K }) === K, "wrong")
cell("variantOf/modelWithVariant/modelText unify both forms", [{ model: `${K}#low` }, { model: K, variant: "low" }].every((p) => P.variantOf(p) === "low" && P.baseModel(p) === K && P.modelWithVariant(p) === `${K}#low` && P.modelText(p) === `${K} · low`), "wrong")
const sp = P.splitLaunchModel(`${K}#low`)
cell("launch split gives providerID, id, variant", sp.providerID === "kimi-code-plan-global" && sp.id === "k3-256k" && sp.variant === "low", JSON.stringify(sp))
const sp2 = P.splitLaunchModel("openai/gpt-5.5")
cell("launch split without a variant has no variant key", JSON.stringify(sp2) === JSON.stringify({ providerID: "openai", id: "gpt-5.5" }), JSON.stringify(sp2))
// resolve passes the variant on, windows ignore it
const profiles = { kimi: { heavy: { model: `${K}#low`, ...base }, medium: { model: K, variant: "high", ...base }, light: { model: K, ...base } } }
const data = { profiles, sets: { s: { develop: { family: "kimi", tier: "heavy" } } } }
const st = P.stateRow("s", data)
const r = P.resolveStageProfile(st, "develop")
cell("resolveStageProfile carries the variant", r?.model === `${K}#low` && P.splitLaunchModel(r.model).variant === "low", JSON.stringify(r))
const st2 = P.stateRow("s", { ...data, sets: { s: { develop: { family: "kimi", tier: "medium" } } } })
cell("field variant is carried too", P.resolveStageProfile(st2, "develop")?.model === `${K}#high`, JSON.stringify(P.resolveStageProfile(st2, "develop")))
const w = P.windowsOfSet({ profiles, sets: { s: { develop: { family: "kimi", tier: "heavy" }, plan: { family: "kimi", tier: "light" } } } }, "s")
cell("one window per base model: variants do not split or conflict", w.conflicts.length === 0 && [...w.models.keys()].join() === K, JSON.stringify([w.conflicts, [...w.models.keys()]]))
cell("a tab with a variant matches the family", P.familyOfModel(`${K}#low`, profiles) === "kimi", "no")
// tables show the variant
const ps = { project: "p", data, raw: {}, state: { warnings: [] }, name: "s" }
const t = Cmd.profilesTable(ps)
cell("/crew-profiles table shows 'model · variant'", t.includes(`${K} · low`) && t.includes(`${K} · high`), t)
const f = Cmd.showFamily(ps, "kimi")
cell("/crew-profiles show <family> shows the variant", f.includes(`${K} · low`), f)
rmSync(tmp, { recursive: true, force: true })
console.log(fail ? `${fail} FAILED` : "all ok")
process.exit(fail ? 1 : 0)
