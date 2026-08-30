// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off instanceOfSchema:off - detached installer handoff and semver build stamping use Node primitives.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

const LOCAL_UPDATE_PREFIX = "flux-alpha-update-";
const COMMAND_OUTPUT_LIMIT = 8_000;

export type LocalSourceUpdatePlatform = "win" | "mac" | "linux";
export type LocalSourceUpdateArch = "x64" | "arm64";

export interface LocalSourceUpdateArtifact {
  readonly version: string;
  readonly installerPath: string;
  readonly temporaryRoot: string;
}

export class LocalSourceUpdateError extends Schema.TaggedErrorClass<LocalSourceUpdateError>()(
  "LocalSourceUpdateError",
  {
    operation: Schema.Literals(["download", "extract", "install", "build", "handoff"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Could not prepare the local Nightly update (${this.operation}): ${this.detail}`;
  }
}

export class LocalSourceUpdate extends Context.Service<
  LocalSourceUpdate,
  {
    readonly build: (input: {
      readonly repository: string;
      readonly commit: string;
      readonly version: string;
      readonly platform: LocalSourceUpdatePlatform;
      readonly arch: LocalSourceUpdateArch;
    }) => Effect.Effect<LocalSourceUpdateArtifact, LocalSourceUpdateError>;
    readonly handoff: (
      artifact: LocalSourceUpdateArtifact,
    ) => Effect.Effect<void, LocalSourceUpdateError>;
    readonly cleanupStaleBuilds: Effect.Effect<void>;
  }
>()("@t3tools/desktop/updates/LocalSourceUpdate") {}

const keepOutputTail = (current: string, next: string): string =>
  `${current}${next}`.slice(-COMMAND_OUTPUT_LIMIT);

const runCommand = Effect.fn("desktop.localSourceUpdate.runCommand")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly operation: "extract" | "build";
}) {
  const resolved = yield* resolveSpawnCommand(input.command, input.args, { env: input.env });
  const result = yield* Effect.tryPromise({
    try: () =>
      new Promise<{ readonly exitCode: number; readonly output: string }>((resolve, reject) => {
        const child = NodeChildProcess.spawn(resolved.command, [...resolved.args], {
          cwd: input.cwd,
          env: input.env,
          shell: resolved.shell,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout?.on("data", (chunk: Buffer | string) => {
          output = keepOutputTail(output, String(chunk));
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          output = keepOutputTail(output, String(chunk));
        });
        child.once("error", reject);
        child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, output }));
      }),
    catch: (cause) =>
      new LocalSourceUpdateError({ operation: input.operation, detail: String(cause) }),
  });
  if (result.exitCode !== 0) {
    return yield* new LocalSourceUpdateError({
      operation: input.operation,
      detail: `command exited with code ${String(result.exitCode)}${result.output ? `: ${result.output}` : ""}`,
    });
  }
});

const localVersionParts = (version: string): { readonly base: string; readonly date: string } => {
  const base = /^\d+\.\d+\.\d+/.exec(version)?.[0] ?? "0.0.0";
  const now = new Date();
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  return { base, date };
};

const installerNameFor = (platform: LocalSourceUpdatePlatform): string =>
  platform === "win" ? ".exe" : platform === "mac" ? ".dmg" : ".AppImage";

const makeLocalVersion = (currentVersion: string): string => {
  const parts = localVersionParts(currentVersion);
  // The time component makes repeated local builds installable on the same day
  // while retaining the channel's semver-compatible nightly shape.
  return `${parts.base}-nightly.${parts.date}.${String(Date.now() % 100000)}`;
};

const makeArchiveUrl = (repository: string, commit: string): string =>
  `https://codeload.github.com/${repository.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}/tar.gz/${encodeURIComponent(commit)}`;

const isSafeRepository = (repository: string): boolean => /^[^/]+\/[^/]+$/.test(repository);

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;

  const cleanup = (root: string) =>
    fileSystem.remove(root, { recursive: true, force: true }).pipe(Effect.ignore);

  const cleanupStaleBuilds = Effect.gen(function* () {
    const tempRoot = NodeOS.tmpdir();
    const entries = yield* fileSystem.readDirectory(tempRoot).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      entries.filter((entry) => entry.startsWith(LOCAL_UPDATE_PREFIX)),
      (entry) => cleanup(environment.path.join(tempRoot, entry)),
      { discard: true, concurrency: "unbounded" },
    );
  });

  const build = Effect.fn("desktop.localSourceUpdate.build")(function* (input: {
    readonly repository: string;
    readonly commit: string;
    readonly version: string;
    readonly platform: LocalSourceUpdatePlatform;
    readonly arch: LocalSourceUpdateArch;
  }) {
    if (!isSafeRepository(input.repository)) {
      return yield* new LocalSourceUpdateError({
        operation: "download",
        detail: "the configured GitHub repository is invalid",
      });
    }

    const temporaryRoot = yield* fileSystem
      .makeTempDirectory({ prefix: LOCAL_UPDATE_PREFIX })
      .pipe(
        Effect.mapError(
          (cause) => new LocalSourceUpdateError({ operation: "build", detail: String(cause) }),
        ),
      );
    const archivePath = environment.path.join(temporaryRoot, "source.tar.gz");
    const sourceRoot = environment.path.join(temporaryRoot, "source");
    const outputRoot = environment.path.join(temporaryRoot, "output");
    const platformFlag = input.platform;
    const target =
      input.platform === "win" ? "nsis" : input.platform === "mac" ? "dmg" : "AppImage";
    const env = {
      ...process.env,
      T3CODE_DESKTOP_COMMIT_HASH: input.commit,
      T3CODE_DESKTOP_VERSION: input.version,
      T3CODE_DESKTOP_PLATFORM: platformFlag,
      T3CODE_DESKTOP_TARGET: target,
      T3CODE_DESKTOP_ARCH: input.arch,
      T3CODE_DESKTOP_OUTPUT_DIR: outputRoot,
      T3CODE_DESKTOP_SIGNED: "false",
      T3CODE_DESKTOP_VERBOSE: "false",
    };

    const failedBuild = (cause: unknown) => {
      const error =
        cause instanceof LocalSourceUpdateError
          ? cause
          : new LocalSourceUpdateError({ operation: "build", detail: String(cause) });
      return cleanup(temporaryRoot).pipe(Effect.andThen(Effect.fail(error)));
    };

    return yield* Effect.gen(function* () {
      const response = yield* httpClient.execute(
        HttpClientRequest.get(makeArchiveUrl(input.repository, input.commit)).pipe(
          HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("user-agent", "Flux-desktop-local-updater"),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new LocalSourceUpdateError({
          operation: "download",
          detail: `GitHub returned HTTP ${String(response.status)}`,
        });
      }
      yield* HttpClientResponse.stream(Effect.succeed(response)).pipe(
        Stream.run(fileSystem.sink(archivePath)),
        Effect.mapError(
          (cause) => new LocalSourceUpdateError({ operation: "download", detail: String(cause) }),
        ),
      );
      yield* fileSystem.makeDirectory(sourceRoot);
      const tar = yield* resolveSpawnCommand(
        "tar",
        ["-xzf", archivePath, "-C", sourceRoot, "--strip-components=1"],
        { env },
      );
      yield* runCommand({
        command: tar.command,
        args: tar.args,
        cwd: temporaryRoot,
        env,
        operation: "extract",
      });
      yield* fileSystem.makeDirectory(outputRoot);

      const pnpm = yield* resolveSpawnCommand("pnpm", ["install", "--frozen-lockfile"], { env });
      yield* runCommand({
        command: pnpm.command,
        args: pnpm.args,
        cwd: sourceRoot,
        env,
        operation: "build",
      });
      const builder = yield* resolveSpawnCommand("node", ["scripts/build-desktop-artifact.ts"], {
        env,
      });
      yield* runCommand({
        command: builder.command,
        args: builder.args,
        cwd: sourceRoot,
        env,
        operation: "build",
      });

      const entries = yield* fileSystem.readDirectory(outputRoot);
      const suffix = installerNameFor(input.platform);
      const installer = entries.find((entry) => entry.endsWith(suffix));
      if (!installer) {
        return yield* new LocalSourceUpdateError({
          operation: "build",
          detail: `the builder produced no ${suffix} installer`,
        });
      }
      return {
        version: input.version,
        installerPath: environment.path.join(outputRoot, installer),
        temporaryRoot,
      } satisfies LocalSourceUpdateArtifact;
    }).pipe(Effect.catchCause((cause) => failedBuild(cause)));
  });

  const handoff = Effect.fn("desktop.localSourceUpdate.handoff")(function* (
    artifact: LocalSourceUpdateArtifact,
  ) {
    const installer = environment.path.resolve(artifact.installerPath);
    const temporaryRoot = environment.path.resolve(artifact.temporaryRoot);
    if (!installer.startsWith(`${temporaryRoot}${environment.path.sep}`)) {
      return yield* new LocalSourceUpdateError({
        operation: "handoff",
        detail: "refusing to launch an installer outside the updater temporary directory",
      });
    }
    const script =
      "$ErrorActionPreference='SilentlyContinue'; " +
      "$installer=$args[0]; $root=$args[1]; Start-Sleep -Seconds 2; " +
      "if (Test-Path -LiteralPath $installer) { Start-Process -FilePath $installer -ArgumentList '/S' -Wait -WindowStyle Hidden }; " +
      "if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }";
    const escapedArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      script,
      installer,
      temporaryRoot,
    ];
    const child = NodeChildProcess.spawn("powershell.exe", escapedArgs, {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    yield* electronApp.quit;
  });

  return LocalSourceUpdate.of({ build, handoff, cleanupStaleBuilds });
});

export const layer = Layer.effect(LocalSourceUpdate, make);

export const makeLocalNightlyVersion = makeLocalVersion;
