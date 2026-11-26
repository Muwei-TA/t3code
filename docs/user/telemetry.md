# Product usage data

When product usage data is on, the T3 Code server sends events to `ingest.t3.codes`. T3 Code keeps
a copy and forwards the events to PostHog with person profiles disabled. Each event has a name,
timestamp, and unique ID for deduplication. It also includes the server's operating system and
architecture, a Windows Subsystem for Linux (WSL) flag, the T3 Code server version and release
channel, and whether the server runs as part of the desktop app or on its own. The WSL flag records
whether the host reports a non-blank distro name. The distro name itself is excluded.

- **Installation and ownership.** A stable hash of a random ID identifies the installation.
  The event's usage identifier (`distinct_id`) is hashed with a key stored on that server.
  Ownership events report the identifier's source and whether it was observed by the server or
  reported by a client. OpenAI, Claude, and device identifiers are hashed with the server's key.
  The T3 Connect account hash is shared across installations so T3 Code can count installations
  per connected account.
- **Client and feature usage.** When available, thread and turn requests include the connecting
  app's T3 Code version, surface (web, desktop, mobile, or CLI), OS and device type. Web clients
  report hosted or server-hosted deployment and a browser family from a fixed list: Edge, Opera,
  Samsung Internet, Firefox, Chrome, Safari, other, or unknown. Connection method is direct, SSH,
  T3 Connect relay, or unknown. Thread starts include the workspace strategy. Feature events
  include the feature name, its variant when applicable, and the client surface when available.
  Startup events include project and thread counts.
- **Provider usage.** Turn and request reports include provider and public model names, reasoning
  effort, service tier, permission and interaction modes, request origin, turn or request outcome,
  and duration when known. They include the usage report version, lifecycle and token usage
  coverage, turn segment and child-agent type when applicable, whether the turn ran a local
  command, whether work continued after a restart, and observed public models. Counts
  can include provider turns, continuations, steering restarts, subagent turns, input, cached
  input, cache creation, output, and reasoning tokens. Child-agent and other usage totals are
  reported separately when available, along with whether child agents were still running.
  Delegated task events include the caller and target providers and public models, whether
  providers differ, outcome, duration, and completion wake-up metadata when available.

Prompts, responses, file paths and contents, authentication tokens, conversation IDs, raw provider
events, and child-agent output are excluded from product usage events. An approved
[agent feedback](#agent-feedback) report can include the text shown on its approval card.

Product usage data is off by default. In the web or desktop app, **Settings > General > Privacy**
controls product usage data on the selected machines. In the mobile app, each machine's switch is
under **Settings > About T3 Code > Diagnostics**. Turning off product usage data discards queued
events and pending retries. An explicit `T3CODE_TELEMETRY_ENABLED` value on the server takes
precedence. An administrator can disable telemetry using a [managed policy](./managed-policy.md#other-capabilities).

## Agent feedback

Agent feedback lets agents tell the T3 team about T3 Code: a T3 tool or `t3` command that did not
do what they expected, a confusing instruction, or a missing capability. Choose a mode in
**Agent feedback** in **Settings > Labs**:

- **Off**, the default: agents do not see the feedback tools, and `t3 feedback` stops with a
  message pointing to Labs.
- **When I ask**: agents send a report only when you ask them to, about anything in T3 Code.
- **Automatic**: agents also report T3 Code problems they hit on their own, such as a T3 tool that
  failed and made them find another way. Each automatic event records one report and includes
  the kind of problem, the normalized subject (the T3 tool or command involved), and provider and
  public model information when available. Agent-written details and conversation text require
  approval. `t3 feedback --kind bug --subject "t3 thread send" --expected "…" --actual "…"`
  sends one the same way, so it works only in this mode.

When you ask your agent for a report, in either mode, T3 Code shows it in the thread as a card
with exactly what would leave your machine, and sends it only if you press **Send**. The agent
carries on without waiting and never learns your answer. The card stays open until you answer it,
even after the turn ends or the server restarts; **Don't send** sends nothing, and the agent is
told not to send it another way. Only someone who can run agents on that machine can answer the
card; people on a guest link cannot.

An approved report also records that it was requested by a user and how it was submitted. The
approval card includes up to 300 characters each of expected behavior, actual behavior, and
workaround. The agent is instructed to omit your messages and code. The agent also says how many
recent turns the problem spans. A report you approved carries an outline of those turns, and of at least the last 5,
from when the agent asked: who spoke, how long each message was, and which tools ran, whether they
worked, and how long they took. The outline has no text. Tools from your other MCP servers appear
only as `mcp`. Turn on **Include the conversation** in the card to attach the text of your
messages and the agent's replies in the turns the problem spans, up to 1,000 characters per
message and 16 KB in all, oldest text dropped first; the card shows that text before you send it.
To change a report, such as the turns it covers, ask the agent in the chat: it shows a new card,
and you can decline the old one. Tool inputs and outputs, files, and attachments are never sent. An agent can
show you at most 3 report cards and send 3 reports on its own per turn, and `t3 feedback` can
send at most 10 an hour.

Before anything is saved, T3 Code removes file paths (when text mentions one, the rest of that line
goes with it), your user name, machine name, project title, branch, and git remote, and anything
that looks like a key, token, email address, or URL with a password. It cannot recognise your code
or a name written in a sentence, so only include the conversation when it holds nothing you would
not send. Reports from agents also name the provider, and the model when it is from the provider's
public model list. No thread IDs or project IDs are sent.

Reports are saved on your machine first, and a declined one is not saved at all; its card keeps
only what you would have sent without the conversation. When product usage
data is turned off, saved reports stay there and are not sent. `t3 feedback list` shows recent
reports, the thread each came from, and a line for each outline; `t3 feedback list --json` shows
exactly what each one holds.

## Relay connection diagnostics

When enabled, T3 Code sends relay connection traces to Axiom to diagnose T3 Connect connectivity.
Traces include operation timings and outcomes, T3 Code service and client information, and an
app or server process identifier. Depending on the operation, they can include environment
identifiers, relay client IDs, request methods and URLs, authorization scope names, and
token-cache results. Failed spans can include error names and stack frames. Server traces also
include the name and version of the Node.js runtime. The machine's display name is excluded.

**Send T3 Connect diagnostics** in **Settings > General > Privacy** controls traces from the web
or desktop app when the build has relay tracing configured. In a browser it starts off. On desktop,
the switch is available after the host confirms `T3CODE_TELEMETRY_ENABLED=true` and any managed
policy permits telemetry. The desktop app reads the setting from the login shell on macOS and
Linux and from the environment on Windows. When the host permits tracing, the desktop switch
starts on unless you previously turned it off. Turning the switch off also stops delivery of
queued traces while it is off. Server-side relay tracing requires `T3CODE_TELEMETRY_ENABLED=true`
and honors managed policy, `T3CODE_OTEL_SDK_DISABLED`, and `OTEL_SDK_DISABLED`.

## Mobile app diagnostics

When the iOS or Android app crashes or hits an error, it sends a report to T3 Code: the error
message, the stack trace, the app version, and the device model and OS version. Each launch also
sends startup timings, and every report carries a random ID for the install. Reports go through
the T3 Connect relay to Axiom. They do not include your threads, prompts, or connection details,
but an error message can quote a value the app was handling.

To stop sending them, turn off **Send crash reports** in **Settings > About T3 Code > Diagnostics**.

When the mobile build has relay tracing configured, **Send T3 Connect diagnostics** under
**Settings > About T3 Code > Diagnostics** controls relay traces from that device. It starts off.
Relay traces include an identifier for the current app session. Crash reporting has its own
switch.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the T3 Connect relay for
[mobile notifications and live activities](./mobile-notifications.md). This is separate from
product events and relay diagnostics. The telemetry setting does not disable it.

To stop publishing, turn off **Publish agent activity** under **Settings > Sharing & access** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
