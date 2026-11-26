import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { HarnessPluginId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as PluginHost from "../harness/PluginHost.ts";
import WorkflowsMigration from "../persistence/Migrations/110_Workflows.ts";
import WorkflowHostThreadMigration from "../persistence/Migrations/112_WorkflowHostThread.ts";
import { WorkflowAgents } from "./WorkflowAgents.ts";
import * as WorkflowEngine from "./WorkflowEngine.ts";
import * as WorkflowRuntime from "./WorkflowRuntime.ts";
import * as WorkflowStore from "./WorkflowStore.ts";
import { engineTag, type WorkflowDefinition } from "./workflow.ts";
import * as Workflows from "./Workflows.ts";

/** Waits to be let go. */
const hold = `T3.workflow("hold", { version: 1, payload: Schema.Struct({}), returns: Schema.String }, () =>
  Effect.map(T3.wait("go", { returns: Schema.String }), (said) => Option.getOrElse(said, () => "nobody")),
);
`;
const greet = (says: string) => `const { workflow } = T3;
workflow("greet", { version: 1, payload: Schema.Struct({}), returns: Schema.String }, () =>
  Effect.succeed(${JSON.stringify(says)}),
);
`;

/**
 * A folder holding `hold.ts`, and the workflow runtime over it on a fresh database. `engine`
 * stands in for the real one, which needs the clock to run for as long as it is up.
 */
const setup = Effect.fn("setup")(function* (
  wrap: (fileSystem: FileSystem.FileSystem) => FileSystem.FileSystem = (fileSystem) => fileSystem,
  engine?: (definitions: ReadonlyArray<WorkflowDefinition>) => Layer.Layer<Workflows.Workflows>,
  agents: Layer.Layer<WorkflowAgents> = Layer.mock(WorkflowAgents)({}),
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-defs-" });
  const directory = path.join(home, "workflows");
  const at = (name: string) => path.join(directory, name);
  yield* fileSystem.makeDirectory(directory);
  yield* fileSystem.writeFileString(at("hold.ts"), hold);
  const database = NodeSqliteClient.layer({ filename: path.join(home, "state.sqlite") });
  yield* Effect.provide(Effect.andThen(WorkflowsMigration, WorkflowHostThreadMigration), database);
  const made = WorkflowRuntime.make(
    Effect.succeed(
      (definitions: ReadonlyArray<WorkflowDefinition>) =>
        engine?.(definitions) ??
        WorkflowEngine.layer(definitions).pipe(
          Layer.provide(agents),
          Layer.provide(database),
          Layer.provide(NodeCrypto.layer),
        ),
    ),
    directory,
    Effect.succeed(true),
  ).pipe(Effect.provideService(FileSystem.FileSystem, wrap(fileSystem)));
  return { fileSystem, at, directory, database, made, runtime: Layer.effectContext(made) };
});

it.effect("recovers chat questions and interrupted stage resumes on restart", () =>
  Effect.gen(function* () {
    const starts: Array<Parameters<WorkflowAgents["Service"]["start"]>[0]> = [];
    const agents = Layer.mock(WorkflowAgents)({
      start: (input) =>
        Effect.sync(() => {
          starts.push(input);
          return { threadId: input.thread ?? "new-child", turnId: input.origin.step };
        }),
      result: () => Effect.succeed({ ending: "completed", detail: "", reply: "Done" }),
    });
    const { database, runtime } = yield* setup(undefined, undefined, agents);
    const threadId = ThreadId.make("existing-thread");
    const launch = {
      workflow: "mode-flow",
      version: 1,
      prompt: "Review the proposed change",
      threadId,
      projectId: ProjectId.make("project-1"),
      idempotencyKey: "mode-flow",
    };
    const started = yield* Effect.gen(function* () {
      const definitions = yield* WorkflowRuntime.WorkflowDefinitions;
      const workflows = yield* Workflows.Workflows;
      const saved = yield* definitions.save(
        "mode-flow.yaml",
        `name: mode-flow
steps:
  - id: review
    kind: in-thread
    modeId: review
    prompt: Review this change
  - id: priority
    kind: ask
    prompt: Choose the priority
    choices: [Correctness, Simplicity]
    dependsOn: [review]
  - id: audit
    kind: child
    modeId: custom-audit
    prompt: Audit the result
    dependsOn: [review, priority]
`,
      );
      assert.deepStrictEqual(saved.problems, []);
      const catalog = Option.getOrThrow(yield* Stream.runHead(workflows.watchChat()));
      assert.deepStrictEqual(
        catalog.workflows.find((workflow) => workflow.name === launch.workflow),
        {
          name: launch.workflow,
          version: 1,
          source: "yaml",
          triggers: [],
          chatModeCompatible: true,
        },
      );

      const run = yield* workflows.startFromChat(launch);
      const duplicate = yield* workflows.startFromChat({
        ...launch,
        prompt: "Different retry text",
      });
      assert.equal(duplicate.runId, run.runId);
      yield* workflows.waitFor(run.runId, (current) => current.detail === "priority");
      const snapshot = Option.getOrThrow(
        yield* workflows.watchChat(threadId).pipe(
          Stream.filter((current) => current.questions.length === 1),
          Stream.runHead,
        ),
      );
      assert.equal(snapshot.runs[0]?.hostThreadId, threadId);
      assert.equal(snapshot.questions[0]?.name, "priority");
      const other = Option.getOrThrow(
        yield* Stream.runHead(workflows.watchChat(ThreadId.make("other-thread"))),
      );
      assert.deepStrictEqual(other.runs, []);
      assert.deepStrictEqual(other.questions, []);
      return run.runId;
    }).pipe(Effect.provide(runtime), Effect.scoped);

    yield* Effect.gen(function* () {
      const workflows = yield* Workflows.Workflows;
      const waiting = Option.getOrThrow(yield* Stream.runHead(workflows.watchChat(threadId)));
      assert.equal(waiting.runs[0]?.runId, started);
      assert.equal(waiting.questions[0]?.name, "priority");
      yield* workflows.pause(started);
      assert.isTrue((yield* workflows.get(started)).run.pauseRequested);
      yield* workflows.resume(started);
      assert.isFalse((yield* workflows.get(started)).run.pauseRequested);
      yield* workflows.pause(started);
      yield* workflows.answer(started, "priority", { choice: "Correctness" });
      const paused = yield* workflows.waitFor(started, (current) => current.status === "paused");
      assert.equal(paused.detail, "Paused before audit");
      assert.equal(starts.length, 1);
    }).pipe(Effect.provide(runtime), Effect.scoped);

    // Simulate a shutdown after the resume updated the run but before it reached the engine.
    yield* Effect.gen(function* () {
      const store = yield* WorkflowStore.make;
      assert.isTrue(yield* store.runUnpaused(started));
    }).pipe(Effect.provide(database), Effect.scoped);

    yield* Effect.gen(function* () {
      const workflows = yield* Workflows.Workflows;
      const finished = yield* workflows.waitFor(
        started,
        (current) => current.status === "completed",
      );
      assert.equal(finished.hostThreadId, threadId);
      const detail = yield* workflows.get(started);
      assert.deepStrictEqual(
        detail.stages?.map(({ id, kind }) => [id, kind]),
        [
          ["review", "in-thread"],
          ["priority", "ask"],
          ["audit", "child"],
        ],
      );
      assert.deepStrictEqual(
        starts.map(({ thread, project, launch }) => ({
          thread,
          project,
          modeId: launch?.modeId,
        })),
        [
          { thread: "existing-thread", project: undefined, modeId: "review" },
          { thread: undefined, project: "project-1", modeId: "custom-audit" },
        ],
      );
      assert.include(starts[0]?.prompt ?? "", launch.prompt);
      assert.include(starts[1]?.prompt ?? "", "Correctness");
    }).pipe(
      Effect.provide(runtime),
      Effect.scoped,
      Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("loads active plugin workflows and drops them when their contribution is removed", () =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<number>();
    const contribution = {
      pluginId: HarnessPluginId.make("audit"),
      skills: [],
      rules: [],
      commands: [],
      modes: [],
      hooks: [],
      workflows: [
        {
          relativePath: "workflows/review.yaml",
          source:
            "name: plugin-review\nsteps:\n  - id: review\n    modeId: review\n    prompt: Review the change\n",
        },
      ],
    } satisfies PluginHost.PluginActiveContribution;
    let active = true;
    const plugin = Layer.mock(PluginHost.PluginHost)({
      getActiveContributions: () => (active ? [contribution] : []),
      activeContributionChanges: Stream.fromQueue(changes),
      listActiveSdkTools: () => [],
    });
    const { runtime } = yield* setup();
    yield* Effect.gen(function* () {
      const workflows = yield* Workflows.Workflows;
      const first = yield* Stream.runHead(workflows.watch).pipe(Effect.map(Option.getOrThrow));
      assert.include(
        first.workflows.map(({ name }) => name),
        "plugin-review",
      );
      active = false;
      yield* Queue.offer(changes, 1);
      yield* TestClock.adjust("1 second");
      const next = yield* workflows.watch.pipe(
        Stream.filter(
          (snapshot) => (snapshot.definition?.revision ?? 0) > (first.definition?.revision ?? 0),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.notInclude(
        next.workflows.map(({ name }) => name),
        "plugin-review",
      );
    }).pipe(Effect.provide(runtime.pipe(Layer.provide(plugin))), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "every file in the folder defines workflows, and a saved file is verified before it runs",
  () =>
    Effect.gen(function* () {
      const { fileSystem, at, runtime } = yield* setup();

      yield* Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const definitions = yield* WorkflowRuntime.WorkflowDefinitions;
        const held = yield* workflows.start("hold", {}, { idempotencyKey: "h" });
        yield* workflows.waitFor(held.runId, (run) => run.status === "waiting");

        // A file that does not parse is not written, and says where it breaks.
        const broken = yield* definitions.save("greet.ts", "T3.workflow(\n  'x',\n];\n");
        assert.isFalse(broken.changed);
        assert.deepStrictEqual(
          broken.problems.map((problem) => [problem.file, problem.line]),
          [["greet.ts", 3]],
        );
        // Nor is one that defines what another file already does, or drops what a run needs.
        const twice = yield* definitions.save("again.ts", hold);
        assert.include(
          twice.problems[0]?.message ?? "",
          "hold@1 is defined twice, in again.ts and hold.ts",
        );
        const dropped = yield* definitions.save("hold.ts", greet("hello"));
        assert.include(
          dropped.problems[0]?.message ?? "",
          "hold@1 is no longer defined, and 1 of its runs",
        );
        // Nor one that exports something shaped like a workflow without what the engine walks.
        const shaped = yield* definitions.save(
          "shaped.ts",
          'export default [{ name: "shaped", version: 1, body: () => Effect.void }];\n',
        );
        assert.include(shaped.problems[0]?.message ?? "", "is not a workflow");
        // Nor one with an option nothing reads, or a time a schedule cannot fire at.
        const misspelt = yield* definitions.save(
          "misspelt.ts",
          'T3.workflow("misspelt", { version: 1, payload: Schema.Struct({}), retries: 2 }, () => Effect.void);\n',
        );
        assert.include(misspelt.problems[0]?.message ?? "", "does not take `retries`");
        const late = yield* definitions.save(
          "late.ts",
          'T3.workflow("late", { version: 1, payload: T3.Tick, triggers: [T3.daily("9am")] }, () => Effect.void);\n',
        );
        assert.include(late.problems[0]?.message ?? "", "24-hour time");
        const banana = yield* definitions.save(
          "banana.ts",
          'T3.workflow("banana", { version: 1, payload: T3.Tick, triggers: [T3.every("banana")] }, () => Effect.void);\n',
        );
        assert.include(banana.problems[0]?.message ?? "", 'Write one such as "5 minutes"');
        const twoHooks = yield* definitions.save(
          "hooks.ts",
          'T3.workflow("hooks", { version: 1, payload: T3.WebhookRequest, triggers: [T3.webhook("in"), T3.webhook("in")] }, () => Effect.void);\n',
        );
        assert.include(twoHooks.problems[0]?.message ?? "", 'two hooks named "in"');
        assert.include((yield* definitions.remove("hold.ts")).problems[0]?.message ?? "", "hold@1");
        assert.deepStrictEqual(
          (yield* definitions.read).files.map((file) => file.name),
          ["hold.ts"],
        );
        // The same change made outside the app is refused as a whole: the file still reads as the
        // version that runs, until it is put back.
        const told = (wanted: boolean) =>
          workflows.watch.pipe(
            Stream.filter((snapshot) => (snapshot.definition?.problem != null) === wanted),
            Stream.runHead,
          );
        yield* fileSystem.writeFileString(at("hold.ts"), greet("hello"));
        yield* told(true);
        assert.deepStrictEqual(
          (yield* definitions.read).files.map((file) => file.workflows),
          [["hold@1"]],
        );
        // Only that file is held back: another file's change still runs, and the held one says why.
        const other =
          'T3.workflow("other", { version: 1, payload: Schema.Struct({}) }, () => Effect.void);\n';
        // A file the folder's naming leaves out says so, instead of never running without a word.
        yield* fileSystem.writeFileString(at("my flow.ts"), other);
        assert.deepStrictEqual(yield* definitions.save("other.ts", other), {
          changed: true,
          problems: [],
        });
        yield* workflows.start("other", {}, { idempotencyKey: "o" });
        assert.deepStrictEqual(
          (yield* definitions.read).files.map((file) => [file.name, file.problems.length]),
          [
            ["hold.ts", 1],
            ["other.ts", 0],
          ],
        );
        assert.deepStrictEqual(
          (yield* definitions.read).problems.map((problem) => problem.file),
          ["my flow.ts"],
        );
        yield* fileSystem.remove(at("my flow.ts"));
        assert.deepStrictEqual(yield* definitions.remove("other.ts"), {
          changed: true,
          problems: [],
        });
        yield* fileSystem.writeFileString(at("hold.ts"), hold);
        yield* told(false);

        // A new file that passes is there from now on, and what it defines can be started.
        const saved = { changed: true, problems: [] };
        assert.deepStrictEqual(yield* definitions.save("greet.ts", greet("hello")), saved);
        assert.equal(yield* fileSystem.readFileString(at("greet.ts")), greet("hello"));
        const greeted = yield* workflows.start("greet", {}, { idempotencyKey: "g" });
        const done = yield* workflows.waitFor(greeted.runId, (run) => run.status === "completed");
        assert.equal(done.result, "hello");
        // The run that was waiting came through the reload and can still be let go.
        yield* workflows.signal({ runId: held.runId, wait: "go" }, "go on", { id: "s1" });
        const freed = yield* workflows.waitFor(held.runId, (run) => run.status === "completed");
        assert.equal(freed.result, "go on");

        // Someone breaks a file outside the app: its last good version keeps running, and the
        // other files go on changing.
        const problem = (wanted: boolean) =>
          workflows.watch.pipe(
            Stream.filter((snapshot) => (snapshot.definition?.problem != null) === wanted),
            Stream.runHead,
          );
        yield* fileSystem.writeFileString(at("greet.ts"), "T3.workflow(");
        yield* problem(true);
        const read = yield* definitions.read;
        assert.deepStrictEqual(
          read.files.map((file) => [file.name, file.problems.length]),
          [
            ["greet.ts", 1],
            ["hold.ts", 0],
          ],
        );
        const still = yield* workflows.start("greet", {}, { idempotencyKey: "g2" });
        assert.equal(
          (yield* workflows.waitFor(still.runId, (run) => run.status === "completed")).result,
          "hello",
        );
        // And fixes it, saying something else, this time as the file's one default export.
        yield* fileSystem.writeFileString(
          at("greet.ts"),
          greet("hi").replace("\nworkflow(", "\nexport default workflow("),
        );
        yield* problem(false);
        const fixed = yield* workflows.start("greet", {}, { idempotencyKey: "g3" });
        assert.equal(
          (yield* workflows.waitFor(fixed.runId, (run) => run.status === "completed")).result,
          "hi",
        );
        // A file taken away takes its workflows with it.
        assert.deepStrictEqual(yield* definitions.remove("greet.ts"), saved);
        const gone = yield* workflows
          .start("greet", {}, { idempotencyKey: "g4" })
          .pipe(Effect.flip);
        assert.equal(gone._tag, "WorkflowNotRegisteredError");
        // With no file left, nothing runs, and the runs that ended can still be read.
        assert.deepStrictEqual(yield* definitions.remove("hold.ts"), saved);
        assert.equal((yield* workflows.get(held.runId)).run.status, "completed");
        assert.includeMembers(
          (yield* workflows.list()).map((run) => run.runId),
          [held.runId, greeted.runId],
        );
      }).pipe(
        Effect.provide(runtime),
        Effect.scoped,
        Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "a folder that cannot be listed keeps its workflows and is looked at again, and an engine that cannot start leaves the last one running",
  () =>
    Effect.gen(function* () {
      let refuse = false;
      // What each engine was built to run. One that registers `broken` does not come up.
      const builds: Array<ReadonlyArray<string>> = [];
      // No file events: only the runtime's own retry can pick up what changed.
      const { at, fileSystem, runtime } = yield* setup(
        (real) => ({
          ...real,
          exists: (target) =>
            refuse
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "exists",
                    pathOrDescriptor: target,
                  }),
                )
              : real.exists(target),
          watch: () => Stream.never,
        }),
        (definitions) =>
          definitions.some((definition) => definition.name === "broken")
            ? Layer.effect(Workflows.Workflows, Effect.die(new Error("broken took it down")))
            : Layer.sync(Workflows.Workflows, () => {
                builds.push(definitions.map(engineTag));
                return Workflows.disabled;
              }),
      );

      yield* Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const definitions = yield* WorkflowRuntime.WorkflowDefinitions;
        const revision = Effect.map(
          Stream.runHead(workflows.watch),
          (snapshot) => Option.getOrThrow(snapshot).definition?.revision ?? 0,
        );
        refuse = true;
        // Written, but the folder could not be listed, so it is not said to run.
        const unlisted = yield* definitions.save("greet.ts", greet("hi"));
        assert.isTrue(unlisted.changed);
        assert.include(unlisted.problems[0]?.message ?? "", "could not be read");
        // What was loaded stays, and greet is not taken in yet.
        assert.deepStrictEqual(builds, [["hold@1"]]);
        const before = yield* revision;
        refuse = false;
        yield* TestClock.adjust("30 seconds");
        yield* workflows.watch.pipe(
          Stream.filter((snapshot) => (snapshot.definition?.revision ?? 0) > before),
          Stream.runHead,
        );
        assert.deepStrictEqual(builds.at(-1), ["greet@1", "hold@1"]);

        // A definition that passes the checks but takes the engine down at start changes nothing.
        yield* fileSystem.writeFileString(
          at("broken.ts"),
          'T3.workflow("broken", { version: 1, payload: Schema.Struct({}) }, () => Effect.void);\n',
        );
        const fellBack = yield* definitions.save("greet.ts", greet("hello"));
        assert.isTrue(fellBack.changed);
        assert.include(fellBack.problems[0]?.message ?? "", "did not start");
        assert.deepStrictEqual(builds.slice(1), [
          ["greet@1", "hold@1"],
          ["greet@1", "hold@1"],
        ]);
        assert.include(
          (yield* Stream.runHead(workflows.watch)).pipe(Option.getOrThrow).definition?.problem ??
            "",
          "did not start",
        );
      }).pipe(Effect.provide(runtime), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a file that never finishes loading is given up on, and later files still load", () =>
  Effect.gen(function* () {
    const { at, fileSystem } = yield* setup();
    yield* fileSystem.writeFileString(at("stuck.ts"), "await new Promise(() => {});\n");
    yield* fileSystem.writeFileString(at("greet.ts"), greet("hi"));
    const stuck = yield* WorkflowRuntime.loadDefinitions(at("stuck.ts"), 0, 50).pipe(Effect.flip);
    assert.include(String(stuck.cause), "did not finish loading");
    const loaded = yield* WorkflowRuntime.loadDefinitions(at("greet.ts"));
    assert.deepStrictEqual(
      loaded.map((definition) => definition.name),
      ["greet"],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a file given up on registers nothing into the file that loads after it", () =>
  Effect.gen(function* () {
    const { at, fileSystem } = yield* setup();
    yield* fileSystem.writeFileString(
      at("slow.ts"),
      'await new Promise((resolve) => { globalThis.t3TestResume = resolve; });\nT3.workflow("slow", { version: 1, payload: Schema.Struct({}) }, () => Effect.void);\n',
    );
    // The second file goes on loading until the first one's top level has run to its end.
    yield* fileSystem.writeFileString(
      at("next.ts"),
      `${greet("hi")}globalThis.t3TestResume();\nawait new Promise((resolve) => setImmediate(resolve));\n`,
    );
    yield* WorkflowRuntime.loadDefinitions(at("slow.ts"), 0, 50).pipe(Effect.flip);
    const loaded = yield* WorkflowRuntime.loadDefinitions(at("next.ts"));
    assert.deepStrictEqual(
      loaded.map((definition) => definition.name),
      ["greet"],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

// Vitest's module runner loads a file its own way; only Node keeps a CommonJS file by its path.
it.live("a file without imports or exports loads again after it changes", () =>
  Effect.gen(function* () {
    const { at, fileSystem } = yield* setup();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* fileSystem.writeFileString(at("greet.ts"), greet("hi"));
    const twice = `
      import * as NodeFS from "node:fs";
      import * as NodeServices from "@effect/platform-node/NodeServices";
      import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
      import { loadDefinitions } from ${JSON.stringify(new URL("./WorkflowRuntime.ts", import.meta.url).href)};
      const file = process.argv.at(-1);
      const program = Effect.gen(function* () {
        const first = yield* loadDefinitions(file, 1);
        NodeFS.writeFileSync(file, NodeFS.readFileSync(file, "utf8").replace('"hi"', '"hello"'));
        const second = yield* loadDefinitions(file, 2);
        return [first.length, second.length];
      });
      console.log(JSON.stringify(await Effect.runPromise(Effect.provide(program, NodeServices.layer))));
    `;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        ["--input-type=module", "--eval", twice, at("greet.ts")],
        { cwd: import.meta.dirname },
      ),
    );
    const [stdout, stderr] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(stdout.trim(), "[1,1]", stderr);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a change held back by a run goes in once that run ends, with no further edit", () =>
  Effect.gen(function* () {
    // The folder's changes are told by hand, so the test does not hang on a watcher starting.
    const changed = yield* Queue.unbounded<FileSystem.WatchEvent>();
    const { fileSystem, at, runtime } = yield* setup((fileSystem) => ({
      ...fileSystem,
      watch: () => Stream.fromQueue(changed),
    }));
    yield* Effect.gen(function* () {
      const workflows = yield* Workflows.Workflows;
      const definitions = yield* WorkflowRuntime.WorkflowDefinitions;
      const held = yield* workflows.start("hold", {}, { idempotencyKey: "h" });
      yield* workflows.waitFor(held.runId, (run) => run.status === "waiting");
      const problem = (wanted: boolean) =>
        workflows.watch.pipe(
          Stream.filter((snapshot) => (snapshot.definition?.problem != null) === wanted),
          Stream.runHead,
        );
      yield* fileSystem.writeFileString(at("hold.ts"), greet("hello"));
      yield* Queue.offer(changed, { _tag: "Update", path: at("hold.ts") });
      yield* problem(true);
      yield* workflows.signal({ runId: held.runId, wait: "go" }, "go on", { id: "s1" });
      yield* workflows.waitFor(held.runId, (run) => run.status === "completed");
      // Nothing is told of the folder now: the held change goes in on its own.
      yield* problem(false);
      assert.deepStrictEqual(
        (yield* definitions.read).files.map((file) => file.workflows),
        [["greet@1"]],
      );
    }).pipe(
      Effect.provide(runtime),
      Effect.scoped,
      Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "workflows are off until turned on, and a run left waiting when they are turned off goes on once they are on again",
  () =>
    Effect.gen(function* () {
      const { fileSystem, at, directory, made } = yield* setup();
      // Its top level counts the times it was loaded.
      yield* fileSystem.writeFileString(
        at("counted.ts"),
        "globalThis.t3GatedLoads = (globalThis.t3GatedLoads ?? 0) + 1;\nexport default [];\n",
      );
      const loads = () => (globalThis as { t3GatedLoads?: number }).t3GatedLoads ?? 0;
      yield* Effect.gen(function* () {
        const { turn, context } = yield* WorkflowRuntime.gate(made, directory);
        const workflows = Context.get(context, Workflows.Workflows);
        const definitions = Context.get(context, WorkflowRuntime.WorkflowDefinitions);
        const start = workflows.start("hold", {}, { idempotencyKey: "h" });

        assert.equal((yield* Effect.flip(start)).message, Workflows.OFF);
        assert.equal((yield* Effect.flip(workflows.list())).message, Workflows.OFF);
        assert.deepStrictEqual((yield* definitions.read).files, []);
        assert.equal(loads(), 0);

        yield* turn(true);
        assert.equal(loads(), 1);
        const held = yield* start;
        yield* workflows.waitFor(held.runId, (run) => run.status === "waiting");

        yield* turn(false);
        const signal = workflows.signal({ runId: held.runId, wait: "go" }, "go on", { id: "s1" });
        assert.equal((yield* Effect.flip(signal)).message, Workflows.OFF);

        yield* turn(true);
        yield* signal;
        const freed = yield* workflows.waitFor(held.runId, (run) => run.status === "completed");
        assert.equal(freed.result, "go on");
      }).pipe(Effect.scoped, Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
