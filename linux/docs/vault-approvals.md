# Vault approvals: how pi, T3 Code and Capri connect

Worked out 2026-10-26 from the sources (pi 1.4.0 `dist/modes/rpc/rpc-mode.js`, T3 Code's
`apps/server/dist/binCli-*.mjs` pi driver), Capri's log, the vault audit logs and pi's session
logs. Read this before changing anything in the approval path.

## The path

```
ipod_vault_use / vault_use  (pi extension, runs inside the pi process)
  └─ approve()  (capri-approval.ts, copied into both vault extensions)
       ├─ ctx.ui.select(title, [deny, allow], {signal})
       │    ├─ pi in a terminal (tmux): the TUI dialog
       │    └─ pi under T3: RPC mode → stdout `extension_ui_request` → T3 → question card
       │         answer: T3 → stdin `extension_ui_response {id, value}` → select resolves
       └─ Capri: POST 127.0.0.1:47823/approval  → her panel (Deny / Release it)
            answer: real click → WebKit → capri-shell.py → fd 3 pipe → daemon
            (never HTTP: an agent can't approve itself with curl)
            pi side long-polls GET /approval/<id>
```

First answer wins.

## What went wrong ("accept works only sometimes")

1. **Dead T3 cards.** Aborting `select` under RPC only drops the request on pi's side. pi sends
   no cancel to T3, and T3 has no handler for one anyway. T3 only clears a card when you answer
   it, when it times out, or at the end of the turn. So after a Capri click, T3 kept showing the
   question. Clicking it there did nothing (pi had forgotten the id), but T3 showed it as
   answered. **Fix:** under T3, the Capri answer is submitted *through T3*
   (on the own thread, via `T3_MCP_URL` + `T3_MCP_BEARER_TOKEN` that T3 gives every pi it
   starts). T3 closes the card properly, and pi gets the value through the normal path. If that
   fails, we abort the dialog and post a notice into the T3 thread saying the card is stale.
   **Tool rename (seen 2026-11-11):** T3 folded `t3_pending_request_{list,read,respond}` into one
   `t3_pending_request` tool taking `action: list|read|respond`; the old names now return
   "Tool not found". That silently broke the close-the-card path (the card then sat there until
   the turn ended and T3 cancelled it). `capri-approval.ts` now tries the new single-tool shape
   first and falls back to the three old names, so it works on both. If stale cards ever come
   back, check the tool names first: `tools/list` on `$T3_MCP_URL`.
2. **"Released" then 20–35 s of silence, then a failure.** Every Capri approval on 2026-10-26
   went through, but the command after it (`browser-login`) failed in 4 of 6 runs: exit 127
   (broken symlink) twice, then `selector never appeared` (15 s wait plus 3.5 s settle). From
   the desk this looked like the approval hadn't worked. **Fix:** after the run, the extension
   reports the exit code (`POST /approval/<id>/result`). Capri says "Running it…" until then,
   then either "done" or "failed (exit N), details in pi".
3. **Old sessions.** pi loads extensions at start. Sessions started before an extension change
   keep the old code (the 13:16–13:20 UTC approvals had no `via` and never reached Capri).
   Restart pi sessions after changing the vault extensions.
4. **Capri restarting mid-question** (old code): the request 404'd and the poll loop spun with
   no delay. **Fix:** on 404 or a lost connection, ask again (with a pause), so the question
   reappears on the restarted Capri.

## Known gap (T3, not Capri)

`t3_pending_request_respond` answers any `user_input` card, and T3 files pi's `select` dialogs
as `user_input` (only `confirm` counts as a permission request). T3's write check also skips
the caller's own thread, and T3 explicitly tells parent agents to answer their child threads'
questions with this tool. So **an orchestrating agent can approve a delegated child's vault
use**, with no human involved. The approve() helper uses the same tool, but only to pass on
*your* Capri click.

## Where to look

- Capri: `~/.local/state/capri/capri.log` (`approval asked / allow via capri / outcome`)
- Vaults: `~/.local/state/{ipod-vault,pi-vault}/audit.log` (`via`: terminal | t3 | capri)
- T3: `~/.t3/userdata/statev2.sqlite`, table `orchestration_v2_projection_runtime_requests`
