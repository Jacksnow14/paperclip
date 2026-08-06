export const type = "antigravity_local";
export const label = "Antigravity (local)";

export const DEFAULT_ANTIGRAVITY_LOCAL_MODEL = "gemini-3.6-flash-high";

// From `agy models` (Antigravity CLI 1.1.x). Reasoning level is baked into the
// model id; the CLI additionally accepts --effort low|medium|high.
export const models = [
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (high)" },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (medium)" },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (low)" },
  { id: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (high)" },
  { id: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash (medium)" },
  { id: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (low)" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (high)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (low)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (via Antigravity)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 Thinking (via Antigravity)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (medium)" },
];

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to run Google's Antigravity CLI (\`agy\`) locally on the host machine
- You want access to Gemini models (and the other models Antigravity serves) through the
  Antigravity subscription instead of a separate API key
- You want resumable conversations across heartbeats via \`--conversation <id>\`

Don't use when:
- You need a webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- The Antigravity CLI is not installed or authenticated on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file. Paperclip stages it into the execution workspace as \`AGENTS.md\` when safe and always tells the agent to read it, because Antigravity does not auto-discover instruction files
- promptTemplate (string, optional): run prompt template
- model (string, optional): Antigravity model id (see \`agy models\`). Defaults to gemini-3.6-flash-high.
- effort (string, optional): reasoning effort passed via \`--effort\` (low|medium|high)
- command (string, optional): defaults to "agy"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`agy --print <prompt>\` with \`--output-format stream-json\` and
  \`--dangerously-skip-permissions\` for unattended execution. \`--print-timeout\` is
  set from the run timeout (120m when the run has no timeout) so the CLI's 5m
  default never cuts off long agent runs.
- Conversations resume with \`--conversation <conversationId>\` when the saved session cwd matches the current cwd.
- Use \`agy models\` to inspect authentication and available models on the host.
`;
