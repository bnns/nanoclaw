/**
 * Agent-to-agent module — inter-agent messaging.
 *
 * The `channel_type === 'agent'`
 * routing path is NOT a system action — core `delivery.ts` dispatches into
 * `./agent-route.js` via a dynamic import when it sees `msg.channel_type === 'agent'`.
 *
 * Host integration points:
 *   - `src/container-runner.ts::spawnContainer` dynamically imports
 *     `./write-destinations.js` on every wake (guarded by `hasTable('agent_destinations')`).
 *   - `src/delivery.ts::deliverMessage` dynamically imports `./agent-route.js`
 *     when `msg.channel_type === 'agent'`.
 *
 * Without this module: `agent_destinations` table absent ⇒ container-runner
 * skips destination projection, ACL check in delivery skips, `create_agent`
 * system action logs "Unknown system action", `channel_type='agent'` messages
 * throw because the module isn't installed.
 */
// create_agent is removed in this deployment: the host handler had no
// authorization, so any prompt-injected turn could create agent groups.
// Without a registered handler the system action logs "Unknown system
// action" and is dropped. Agent-to-agent routing below stays.
export {};
