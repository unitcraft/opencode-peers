// Event probe (task 026, step 1): shows whether the plugin subscription gets OpenCode bus events (form.*, permission.*)
// and in what shape. Off by default; on with CREW_HARNESS_EVENT_PROBE=1. Writes lines to the plugin log, changes nothing.
const KEEP = ["form.", "permission.", "question.", "session.idle", "session.status", "tool."]

export const probeEnabled = (env: Record<string, string | undefined> = process.env) => env.CREW_HARNESS_EVENT_PROBE === "1"

export function describeEvent(ev: any): string | undefined {
  const type = String(ev?.type ?? ev?.event?.type ?? "")
  if (!KEEP.some((k) => type.startsWith(k))) return undefined
  const body = ev?.data ?? ev?.properties ?? ev?.event?.data ?? ev?.event?.properties ?? {}
  const form = body?.form ?? body
  const sid = body?.sessionID ?? form?.sessionID
  const fid = form?.id ?? body?.id
  const kind = form?.metadata?.kind
  let rest = ""
  try {
    rest = JSON.stringify(body) ?? ""
  } catch {
    rest = "[unserializable]"
  }
  return `event probe: ${type}${sid ? ` session=${sid}` : ""}${fid ? ` id=${fid}` : ""}${kind ? ` kind=${kind}` : ""} ${rest.slice(0, 200)}`
}

export async function startEventProbe(ctx: any, log: (line: string) => void): Promise<void> {
  const handler = (ev: any) => {
    try {
      const line = describeEvent(ev)
      if (line) log(line)
    } catch {}
  }
  const tries: [string, () => Promise<void> | void][] = [
    ["session.hook(event)", async () => {
      if (typeof ctx?.session?.hook !== "function") throw new Error("no ctx.session.hook")
      await ctx.session.hook("event", (ev: any) => handler(ev?.event ?? ev))
    }],
    ["event.subscribe", async () => {
      if (typeof ctx?.event?.subscribe !== "function") throw new Error("no ctx.event.subscribe")
      const r = await ctx.event.subscribe((ev: any) => handler(ev))
      const it = r?.stream ?? r
      if (it && typeof it[Symbol.asyncIterator] === "function") {
        void (async () => {
          try {
            for await (const ev of it) handler(ev)
          } catch (e) {
            log(`event probe: iterator ended: ${e}`)
          }
        })()
      }
    }],
  ]
  const why: string[] = []
  let ok = 0
  for (const [name, fn] of tries) {
    try {
      await fn()
      log(`event probe: подписка оформлена способом ${name}`)
      ok++ // пробуем оба способа: оформленный вызов ещё не значит, что события доходят
    } catch (e) {
      why.push(`${name}: ${e}`)
    }
  }
  if (!ok) log(`event probe: подписка не удалась (${why.join("; ")})`)
  else if (why.length) log(`event probe: не оформлены: ${why.join("; ")}`)
}
