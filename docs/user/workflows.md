# Workflows

A workflow chains agent steps and questions into a durable run that survives server restarts. Each successful step is saved so the run can pick up where it left off. Define a workflow in YAML, or use TypeScript for plain code, schedules, webhooks, and issue or pull request triggers.

For one prompt on a timer or webhook, use a scheduled task. Use a workflow when work has stages — such as triage, a fix, your approval, and a release.

## Start from chat

Choose a workflow in the composer's Mode menu and send a text prompt. The run appears in the conversation. Expand it to follow its steps or open a child agent's thread. Answer questions, resume paused runs, or stop a run from the same conversation. A YAML workflow can also pause before its next stage starts. Choose Build or another portable mode to return to ordinary chat.

Workflows are enabled by default. You can turn them off for a server in **Settings → Scheduled tasks**, or set `"workflowsEnabled": false` in `userdata/settings.json` in its T3 home. Stored runs continue when workflows are enabled again.

## Create a workflow

Workflow files live in `~/.t3/workflows/` (or wherever `T3CODE_WORKFLOWS` points — a folder or a single file). The server watches the folder and reloads changes without a restart.

- **Ask an agent (recommended):** copy the [`t3-workflows` skill](https://github.com/pingdotgg/t3code/blob/main/skills/t3-workflows/SKILL.md) into your agent's skills folder (such as `~/.claude/skills/` or `~/.agents/skills/`) and describe what you want.
- **Edit directly:** edit files in `~/.t3/workflows/`, or use **Definitions** on the Workflows page (saving and deleting in the app require terminal access). Before anything has run, open the page with **Open workflows** in the command palette.

On web or desktop, open **Automations → Workflows** to validate and save YAML. An `in-thread` step continues the conversation that started the run, a `child` step starts its own thread, and an `ask` step waits for one of its listed choices. Use `dependsOn` to pass earlier step results or answers to later agent steps.

```yaml
name: plan-review
version: 1
steps:
  - id: plan
    kind: in-thread
    modeId: plan
    prompt: Draft a plan for the request.
  - id: priority
    kind: ask
    dependsOn: [plan]
    prompt: What should the review prioritize?
    choices: [Correctness, Simplicity]
  - id: review
    kind: child
    modeId: review
    dependsOn: [plan, priority]
    prompt: Review the plan with the chosen priority in mind.
```

A TypeScript workflow can opt into chat with `chat: { description: "…" }` in its `T3.workflow` options. Its payload schema must accept `input` and `project` strings and a `thread` object with a `threadId` string.

A small workflow, saved as `~/.t3/workflows/release.ts`:

```ts
const { workflow, step, ask, stop, title } = T3;

export default workflow(
  "release",
  { version: 1, payload: Schema.Struct({ name: Schema.String }) },
  Effect.fn(function* (payload) {
    yield* title(`Release ${payload.name}`);
    const notes = yield* step("notes", { returns: Schema.String }, Effect.succeed("3 fixes"));
    const answer = yield* ask("ship", {
      title: `Ship ${payload.name}? ${notes}`,
      choices: ["Ship", "Hold"],
    });
    if (Option.isNone(answer) || answer.value.choice !== "Ship") return yield* stop("held back");
    return { shipped: payload.name };
  }),
);
```

Start it with `t3 workflow start release --input '{"name":"v1.4"}' --key v1.4`, then answer its question in the app. `T3`, `Effect`, `Schema` and `Option` are provided; a workflow file imports nothing from T3 or Effect. Name files with letters, digits, `-`, `_` and `.`; other names are skipped with a warning.

Saving checks that the file loads, does not duplicate a workflow name and version, and does not remove a version with unfinished runs. A file that fails these checks keeps its last working version while the Workflows page (and the server log) shows why; other files are not affected. A change held back by unfinished runs goes in by itself once those runs end or are cancelled. Mistakes inside a workflow body surface when a run hits them and pauses. To change steps while runs are unfinished, add the new body under a higher `version` and keep the old one until those runs end.

Dot-files and subfolders are ignored. Keep shared helpers in a subfolder and restart the server after editing an imported file.

## Start and steer

```sh
t3 workflow start <name> --input '<json>' --key <key>
t3 workflow list [--status paused]
t3 workflow show <run>
t3 workflow resume <run>
t3 workflow cancel <run> [--reason '<why>']
t3 workflow questions
t3 workflow signal '{"choice":"yes"}' --run <run> --wait <name>
t3 workflow signal '<json>' --workflow <name> --channel <channel>
t3 workflow hooks
t3 workflow store list
t3 workflow store set <key> '<json>'
```

Every start needs a `--key`: starting twice with the same key returns the same run — even after a version bump — so retries do not duplicate work. Use `signal` with `--run` and `--wait` to answer a question or wake a run, or with `--workflow` and `--channel` to wake whichever run waits on that channel. A signal for a question that is no longer open is kept for a later wait rather than refused, so check `t3 workflow questions` first. Use `store` to read or change state kept between runs.

## Triggers

- **Schedules:** `every` runs on an interval, starting one interval after the workflow loads; `daily` runs at a local time of day (a time missed by more than 10 minutes while the server is down is skipped).
- **Webhooks:** `t3 workflow hooks` prints each hook's path; prepend your server's address. The path contains the hook's secret, so share it only with the sender. A sender's retry that repeats its delivery header (such as GitHub's `X-GitHub-Delivery`) starts no second run, and bodies over 1 MiB are refused. Organization policies blocking webhook tasks block workflow webhooks too.
- **Issues and pull requests:** workflows can start on new issues or pull requests and read, comment on, or update them via **Settings → Source control & issues** — no webhook needed. T3 Code checks roughly once a minute, and only items opened after the workflow was first loaded start runs.

## Follow runs in the app

Open the Workflows page with **Open workflows** in the command palette of the web or desktop app; the entry shows once a connected server has workflows on. Filter by **Needs you**, **Running**, or **All** (skipped runs stay hidden unless toggled on), open child runs from their parent, and answer questions, resume paused runs, or cancel active runs (requires permission to operate threads). The issues and pull requests a run touched show as chips under its title and on the steps that touched them; a chip opens the item beside the run, in a tab next to any agent transcripts you opened.

### Agent threads

Each `agent` step runs in an ordinary thread, left out of thread lists (including `t3 thread list`). Open it from the run to watch it live, read its transcript, or send follow-up messages; the thread links back to the run.

An `agent` step can launch a new thread with its own `workspace` (such as a worktree), `runtimeMode`, `interactionMode`, `title`, and typed `returns`, or continue an earlier step's thread. Runs can set their display name with `title(text)`. An `agent` step can also target a project on a [linked environment](remote-access.md#link-another-environment) (requires **Settings → Labs → Linked environments**); the run itself stays on the server that started it.

### Failures, pause, and cancel

A plain code step runs once unless it asks for retries. When a step fails, the run pauses there instead of losing earlier work:

- **Code step failures** retry automatically after 5, 20, and 80 minutes by default, or immediately when you resume; only that step runs again.
- **Agent failures** — when an agent ran and gave up or timed out — pause and wait for you to resume rather than retrying automatically. An agent that could not be started at all, for example because its environment was offline, retries on its own like a failed step.

Cancelling a run stops its active agent turns and cancels child runs it invoked. A cancelled run cannot be resumed.

## Limits

- Runs live on the server that started them and only advance while it is running; use an always-on machine for schedules or webhooks you cannot miss.
- Keep older workflow versions defined until their unfinished runs end or are cancelled.
- Signals sent to a `channel` before a run waits on it are kept for 7 days by default.
