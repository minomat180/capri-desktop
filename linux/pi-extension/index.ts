import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Capri bridge for Pi: reports this session's activity to the Capri desktop companion
 * (~/Projects/capri-desktop), the same event shape the Claude Code hook sends
 * (hooks/capri-hook.js) so the one brain on Capri's side (src/renderer/js/brain.js)
 * understands both agents. Fire-and-forget: never slows Pi down, never throws, does
 * nothing when Capri isn't running.
 *
 * Pi events run in-process, unlike Claude Code's hook (a separate process whose parent
 * pid is Claude Code's). So `process.pid` here IS the agent's pid, and Capri's service
 * finds this window by walking up from it (linux/daemon/agents.js) — no extra plumbing
 * needed, including through tmux.
 */

const PORT = Number(process.env.CAPRI_PORT) || 47823;
const AGENT_PID = process.pid;
const IS_SUBAGENT = process.env.PI_SUBAGENT_CHILD === "1";

type Json = Record<string, unknown>;

let reachable = true; // stop hammering a Capri that isn't running; one try is enough

function post(evt: Json) {
  if (!reachable) return;
  const body = JSON.stringify({ agent: "pi", agent_pid: AGENT_PID, subagent: IS_SUBAGENT, ...evt });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 800);
  fetch(`http://127.0.0.1:${PORT}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: ac.signal,
  })
    .catch(() => {
      reachable = false;
      setTimeout(() => { reachable = true; }, 15000); // retry occasionally, Capri might start later
    })
    .finally(() => clearTimeout(timer));
}

function textOf(message: unknown): string {
  const m = message as { role?: string; content?: unknown };
  if (m?.role !== "assistant" || !Array.isArray(m.content)) return "";
  return m.content
    .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("");
}

export default function capriBridge(pi: ExtensionAPI) {
  const sessionId = (ctx: ExtensionContext) => {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return "pi-session";
    }
  };

  let lastAssistantText = "";

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "reload") return; // the runtime restarting, not a new session
    post({
      hook_event_name: "SessionStart",
      session_id: sessionId(ctx),
      cwd: ctx.cwd,
      source: event.reason === "resume" || event.reason === "fork" ? "resume" : "startup",
    });
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return; // injected by an extension (maybe this one), not you
    post({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId(ctx),
      cwd: ctx.cwd,
      prompt: event.text,
    });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    post({
      hook_event_name: "PreToolUse",
      session_id: sessionId(ctx),
      cwd: ctx.cwd,
      tool_name: event.toolName,
      tool_input: event.args,
      tool_use_id: event.toolCallId,
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.isError) {
      const text = Array.isArray((event.result as any)?.content)
        ? (event.result as any).content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
        : String(event.result ?? "");
      post({
        hook_event_name: "PostToolUseFailure",
        session_id: sessionId(ctx),
        cwd: ctx.cwd,
        tool_name: event.toolName,
        tool_input: {},
        tool_use_id: event.toolCallId,
        error: text,
      });
      return;
    }
    post({
      hook_event_name: "PostToolUse",
      session_id: sessionId(ctx),
      cwd: ctx.cwd,
      tool_name: event.toolName,
      tool_input: {},
      tool_use_id: event.toolCallId,
      duration_ms: event.durationMs,
    });
  });

  // the terminal-UI approval dialog (tool confirmation, a select/input prompt): Capri reacts
  // like Claude Code's permission_prompt notification. Non-blocking kinds (e.g. a plain info
  // toast) don't reach here; this event only fires while Pi is actually waiting on the user.
  pi.on("ui_prompt_start", (event, ctx) => {
    if (event.kind !== "confirm" && event.kind !== "select") return;
    post({
      hook_event_name: "Notification",
      session_id: sessionId(ctx),
      cwd: ctx.cwd,
      notification_type: "permission_prompt",
      title: event.title || "Pi needs your input",
      message: event.title || "",
    });
  });

  pi.on("turn_end", (event) => {
    const text = textOf(event.message);
    if (text) lastAssistantText = text;
  });

  pi.on("session_before_compact", (event, ctx) => {
    post({ hook_event_name: "PreCompact", session_id: sessionId(ctx), cwd: ctx.cwd });
  });

  pi.on("agent_settled", (event, ctx) => {
    post({
      hook_event_name: "Stop",
      session_id: sessionId(ctx),
      cwd: ctx.cwd,
      last_assistant_message: lastAssistantText,
      is_interrupt: event.aborted,
    });
    lastAssistantText = "";
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason === "reload") return;
    post({ hook_event_name: "SessionEnd", session_id: sessionId(ctx), cwd: ctx.cwd, reason: event.reason });
  });
}
