// Plays scripts/demo-sequence.js into the spike page through its /js test hook.
const steps = require('../../scripts/demo-sequence.js');
const PORT = process.env.CAPRI_SPIKE_PORT || 47824;
const send = (js) => fetch(`http://127.0.0.1:${PORT}/js`, { method: 'POST', body: js });
(async () => {
  for (const [delay, evt] of steps) {
    await new Promise((r) => setTimeout(r, delay));
    await send(`window.__capriEmit('claude:event', ${JSON.stringify(evt)})`);
    console.log(evt.hook_event_name, evt.tool_name || '');
  }
})();
