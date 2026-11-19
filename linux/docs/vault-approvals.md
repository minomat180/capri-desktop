# Vault approvals: Capri's side

Capri can show a secret request ("an agent wants X") with Deny / Release it, and pass the
answer back to whoever asked. Until 2026-11-19 the askers were two vault extensions of the pi
coding agent (`vault_use`, `ipod_vault_use`). mino now uses only Claude Code, and those
extensions were removed, so **nothing calls this API at the moment**. The service side is kept
because it is small, safe, and the natural place for a Claude Code secret tool to ask later.
Read this before wiring anything to it.

## The API (127.0.0.1:47823, `linux/daemon/main.js`)

```
POST /approval {label, vault, reason, command, cwd, agent, session} -> { id }   her panel asks
                                                       (503 when the overlay is not up)
GET  /approval/<id>          long poll                -> the decision (allow | deny | expired)
DELETE /approval/<id>        withdraw: answered elsewhere
POST /approval/<id>/result   {exitCode, error}        she says "done" or "failed (exit N)"
```

The answer only ever comes from a real click: WebKit -> `capri-shell.py` -> the overlay's
private fd 3 pipe -> the service. Never over HTTP, so an agent cannot approve itself with curl.
Requests expire after 10 minutes. Requests and results with an `Origin` header (browsers) are refused. First answer wins when the asker also shows its own dialog.

## Lessons from the T3 Code wiring (2026-10-26 to 2026-11-12)

These came from the pi version but apply to any asker running under T3 Code:

1. **Dead T3 cards.** If the asker also shows a T3 question card and the answer comes from Capri,
   the card stays open until the turn ends unless the asker closes it through T3 (its MCP
   server, `t3_pending_request` with `action: respond`). Match the card on its option values:
   T3 rewrites every card's header to "Question".
2. **"Released" then silence.** Report the command's exit code back
   (`POST /approval/<id>/result`), or a failure after a successful approval looks like the
   approval did not work.
3. **Capri restarting mid-question.** On a 404 or a lost connection, ask again after a pause, so
   the question reappears on the restarted Capri.

## Known gap (T3, not Capri)

T3's `t3_pending_request` answers any `user_input` card, its write check skips the caller's own
thread, and T3 tells parent agents to answer their child threads' questions. So an orchestrating
agent could approve a delegated child's secret request in T3 with no human involved. Capri's
click-only path does not have this gap.

## Where to look

- Capri: `~/.local/state/capri/capri.log` (`approval asked / allow via capri / outcome`)
- T3: `~/.t3/userdata/statev2.sqlite`, table `orchestration_v2_projection_runtime_requests`
