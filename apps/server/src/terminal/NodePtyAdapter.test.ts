import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

const spawn = vi.fn(
  () =>
    ({
      pid: 42,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    }) as unknown as import("node-pty").IPty,
);

const { taskkillSpawn } = vi.hoisted(() => ({
  taskkillSpawn: vi.fn(() => ({ once: vi.fn(), unref: vi.fn() })),
}));

vi.mock("node-pty", () => ({ spawn }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (args[0] === "taskkill") {
        return taskkillSpawn(...args) as ReturnType<typeof actual.spawn>;
      }
      return actual.spawn(...args);
    },
  };
});

const testLayer = NodePtyAdapter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HostProcessPlatform, "win32"),
      Layer.succeed(HostProcessArchitecture, "x64"),
    ),
  ),
);

const flushMicrotasks = () =>
  Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));

const windowsSpawnInput = {
  shell: "powershell.exe",
  args: ["-NoLogo"],
  cwd: "C:\\workspace",
  cols: 120,
  rows: 40,
  env: {},
};

it.effect("spawns through the public adapter with the provided host references", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "powershell.exe",
      args: ["-NoLogo"],
      cwd: "C:\\workspace",
      cols: 120,
      rows: 40,
      env: {},
    });

    assert.equal(process.pid, 42);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      ["-NoLogo"],
      {
        cwd: "C:\\workspace",
        cols: 120,
        rows: 40,
        env: { TERM: "xterm-256color" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves a caller-provided TERM in the spawn env on win32", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-direct" },
    });

    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      [],
      {
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: { TERM: "xterm-direct" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports native module load failures as structured startup defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native binding could not be loaded");
    const exit = yield* NodePtyAdapter.make(() => Promise.reject(cause)).pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasDies(exit.cause));
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, NodePtyAdapter.NodePtyModuleLoadError);
      assert.deepInclude(error, {
        _tag: "NodePtyModuleLoadError",
        platform: "win32",
        architecture: "x64",
      });
      assert.equal(error.message, "Failed to load node-pty for win32-x64.");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(HostProcessArchitecture, "x64"),
      ),
    ),
  ),
);

it.effect("replays a prior exit after the current setup stack completes", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    let nativeOnExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    spawn.mockImplementationOnce(
      () =>
        ({
          pid: 42,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => ({ dispose: vi.fn() })),
          onExit: vi.fn((callback: (event: { exitCode: number; signal?: number }) => void) => {
            nativeOnExit = callback;
            return { dispose: vi.fn() };
          }),
        }) as unknown as import("node-pty").IPty,
    );

    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn(windowsSpawnInput);
    nativeOnExit?.({ exitCode: 0 });

    let seen: PtyAdapter.PtyExitEvent | undefined;
    process.onExit((event) => {
      seen = event;
    });
    assert.equal(seen, undefined);

    yield* flushMicrotasks();
    assert.deepEqual(seen, { exitCode: 0, signal: null });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not replay a prior exit after the listener unsubscribes", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    let nativeOnExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    spawn.mockImplementationOnce(
      () =>
        ({
          pid: 42,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => ({ dispose: vi.fn() })),
          onExit: vi.fn((callback: (event: { exitCode: number; signal?: number }) => void) => {
            nativeOnExit = callback;
            return { dispose: vi.fn() };
          }),
        }) as unknown as import("node-pty").IPty,
    );

    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn(windowsSpawnInput);
    nativeOnExit?.({ exitCode: 1, signal: 9 });

    let called = false;
    const unsubscribe = process.onExit(() => {
      called = true;
    });
    unsubscribe();
    yield* flushMicrotasks();
    assert.equal(called, false);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("kills the Windows process tree with taskkill", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    taskkillSpawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn(windowsSpawnInput);
    process.kill();

    assert.equal(taskkillSpawn.mock.calls.length, 1);
    assert.deepEqual(taskkillSpawn.mock.calls[0], [
      "taskkill",
      ["/PID", "42", "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    ]);
    assert.equal(taskkillSpawn.mock.results[0]?.value.unref.mock.calls.length, 1);
  }).pipe(Effect.provide(testLayer)),
);
