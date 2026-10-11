# Event probe (step 1 of task 026)

## What is checked

Whether the plugin subscription in the live service receives the OpenCode bus events about forms and permissions
(`form.created`, `form.replied`, `form.cancelled`, `permission.asked/replied/rejected`) and in what shape.

Scouting result (from the strings of the OpenCode 2.0.26 binary, not from documentation, nothing was run): the bus has
`form.created` (`data.form`: id, sessionID, title, metadata `{kind:"question", tool:{messageID,id}}`), `form.replied` and
`form.cancelled` (`data.id`), `permission.asked/replied/rejected`; the server plugin context has `event.subscribe`.
Not verified: whether the plugin subscription delivers these events and their exact format.

## How to enable

Set `CREW_HARNESS_EVENT_PROBE=1` in the environment of the OpenCode service and restart it (the owner does the restart).
The probe tries two ways in turn: the `event` hook via `ctx.session.hook("event", ...)`, then `ctx.event.subscribe(...)`
(an async iterator, if returned, is read in the background). Each in try/catch; plugin work is not affected.

## What to look for in `%TEMP%/opencode-plugins.log`

- `event probe: подписка оформлена способом <X>` or `event probe: подписка не удалась (<reasons>)` once per start.
- Then, while a question form is asked in a session: `event probe: form.created session=... id=... kind=question {...}`,
  later `form.replied` / `form.cancelled`; also `permission.*`, `session.idle|status`, `tool.*`.
- A subscription line with no event lines after a real question means the subscription is accepted but delivers nothing.

## How to disable

Remove the variable and restart the service. Default is off.
