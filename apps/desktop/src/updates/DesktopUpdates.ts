import {
  DesktopUpdateChannelSchema,
  type DesktopRuntimeInfo,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";
const DEFAULT_UPDATE_REPOSITORY = "stormey2010/Flux";
const DEFAULT_UPDATE_BRANCH = "master";
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;

type UpdateAction = "check" | "download" | "install" | "channel" | "alpha";

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
  // Left unvalidated on purpose: a malformed release-notes payload must never
  // fail the decode and block the update state transition. The shape is
  // validated defensively in normalizeDesktopUpdateReleaseNotes.
  releaseNotes: Schema.optional(Schema.Unknown),
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

const GitHubMainCommitSchema = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    committer: Schema.NullOr(
      Schema.Struct({
        date: Schema.NullOr(Schema.String),
      }),
    ),
  }),
});
type GitHubMainCommit = typeof GitHubMainCommitSchema.Type;
const decodeGitHubMainCommit = Schema.decodeUnknownEffect(GitHubMainCommitSchema);
const DesktopPackageMetadataSchema = Schema.Struct({
  fluxCommitHash: Schema.optional(Schema.String),
});
const decodeDesktopPackageMetadata = Schema.decodeEffect(
  Schema.fromJsonString(DesktopPackageMetadataSchema),
);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Schema.TaggedErrorClass<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install", "channel", "alpha"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedErrorClass<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} desktop update channel.`;
  }
}

export class DesktopUpdateAlphaPersistenceError extends Schema.TaggedErrorClass<DesktopUpdateAlphaPersistenceError>()(
  "DesktopUpdateAlphaPersistenceError",
  {
    enabled: Schema.Boolean,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist Alpha updates ${this.enabled ? "enablement" : "disablement"}.`;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedErrorClass<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedErrorClass<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle desktop update ${this.event} event.`;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedErrorClass<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "channel", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop updater ${this.operation} operation reported an error.`;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedErrorClass<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.action} action failed unexpectedly.`;
  }
}

export type DesktopUpdateConfigureError = never;

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;
export const isDesktopUpdateSetChannelError = Schema.is(DesktopUpdateSetChannelError);

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, DesktopUpdateConfigureError, Scope.Scope>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    readonly setAlphaUpdates: (
      enabled: boolean,
    ) => Effect.Effect<
      DesktopUpdateState,
      DesktopUpdateAlphaPersistenceError | DesktopUpdateActionInProgressError
    >;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  currentCommitHash: string | null,
  alphaUpdates: boolean,
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      channel,
      alphaUpdates,
    ),
    enabled,
    status: enabled ? "idle" : "disabled",
    currentCommitHash,
  };
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return COMMIT_HASH_PATTERN.test(trimmed)
    ? trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase()
    : null;
}

function resolveMainBranchUrl(repository: string, branch: string): string | null {
  const normalized = repository
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  return /^[^/]+\/[^/]+$/.test(normalized)
    ? `https://api.github.com/repos/${normalized}/commits/${branch}`
    : null;
}

function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the Flux desktop update setting.";
  }
  if (args.platform === "linux" && !args.appImage) {
    return "Automatic updates on Linux require running the AppImage build.";
  }
  return null;
}

function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopState = yield* DesktopState.DesktopState;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;

  const currentCommitHash = yield* Effect.gen(function* () {
    const override = Option.flatMap(environment.commitHashOverride, (value) =>
      Option.fromNullishOr(normalizeCommitHash(value)),
    );
    if (Option.isSome(override)) return override.value;
    if (!environment.isPackaged) return null;

    const packageJsonPath = environment.path.join(environment.appRoot, "package.json");
    const raw = yield* fileSystem.readFileString(packageJsonPath).pipe(Effect.option);
    if (Option.isNone(raw)) return null;
    const parsed = yield* decodeDesktopPackageMetadata(raw.value).pipe(Effect.option);
    return Option.isSome(parsed) ? normalizeCommitHash(parsed.value.fluxCommitHash) : null;
  });
  const githubHttpClient = yield* Effect.serviceOption(HttpClient.HttpClient);
  const mainBranchUrl = resolveMainBranchUrl(
    Option.getOrElse(config.desktopUpdateRepository, () => DEFAULT_UPDATE_REPOSITORY),
    DEFAULT_UPDATE_BRANCH,
  );

  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const activeUpdateActionRef = yield* Ref.make<Option.Option<UpdateAction>>(Option.none());
  const updaterConfiguredRef = yield* Ref.make(false);
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const updateStateRef = yield* Ref.make<DesktopUpdateState>({
    ...createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
      environment.defaultDesktopSettings.alphaUpdates,
    ),
    currentCommitHash,
  });

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    Ref.set(updateStateRef, state).pipe(Effect.andThen(emitState));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  const checkMainBranch = Effect.gen(function* () {
    if (Option.isNone(githubHttpClient) || mainBranchUrl === null) return;

    const commit = yield* githubHttpClient.value
      .execute(
        HttpClientRequest.get(mainBranchUrl).pipe(
          HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("user-agent", "Flux-desktop-updater"),
        ),
      )
      .pipe(
        Effect.flatMap((response) => {
          if (response.status < 200 || response.status >= 300) return Effect.succeed(null);
          return response.json.pipe(Effect.map((body) => body as unknown));
        }),
        Effect.flatMap((body) =>
          body === null
            ? Effect.succeed<GitHubMainCommit | null>(null)
            : decodeGitHubMainCommit(body),
        ),
        Effect.map((parsed) => {
          if (parsed === null) return null;
          const hash = normalizeCommitHash(parsed.sha);
          if (hash === null) return null;
          return {
            hash,
            message: parsed.commit.message.split("\n", 1)[0] ?? null,
            date: parsed.commit.committer?.date ?? null,
          };
        }),
        Effect.catchCause(() => Effect.succeed(null)),
      );

    if (!commit) return;
    yield* updateState((state) => ({
      ...state,
      mainCommitHash: commit.hash,
      mainCommitMessage: commit.message,
      mainCommitDate: commit.date,
      ...(state.alphaUpdates && currentCommitHash !== null && currentCommitHash !== commit.hash
        ? {
            status: "available" as const,
            availableVersion: `master-${commit.hash}`,
            downloadedVersion: null,
            releaseNotes: [],
            downloadPercent: null,
            message: null,
            errorContext: null,
            canRetry: false,
          }
        : {}),
    }));
    if (currentCommitHash !== null && currentCommitHash !== commit.hash) {
      yield* logUpdaterInfo("main branch has a newer commit", {
        currentCommitHash,
        mainCommitHash: commit.hash,
        message: commit.message,
      });
    }
  }).pipe(Effect.withSpan("desktop.updates.checkMainBranch"));

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map((appUpdateYmlConfig) => Option.isSome(appUpdateYmlConfig) || config.mockUpdates),
  );

  const resolveDisabledReason = Effect.gen(function* () {
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(config.appImagePath),
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
      }),
    );
  });

  const activeUpdateAction = Ref.get(activeUpdateActionRef);

  const tryStartUpdateAction = (action: UpdateAction): Effect.Effect<boolean> =>
    Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) ? [false, activeAction] : [true, Option.some(action)],
    );

  const tryStartChannelChange = Ref.modify(activeUpdateActionRef, (activeAction) =>
    Option.isSome(activeAction)
      ? [activeAction, activeAction]
      : [Option.none<UpdateAction>(), Option.some<UpdateAction>("channel")],
  );

  const finishUpdateAction = (action: UpdateAction): Effect.Effect<void> =>
    Ref.update(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) && activeAction.value === action ? Option.none() : activeAction,
    );

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
    alphaUpdates: boolean,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    // Alpha builds are packaged as rolling nightly builds. Keep the user's
    // stable/nightly preference visible in state, but use the nightly feed for
    // the opt-in master-build path.
    const updaterChannel = alphaUpdates ? "nightly" : channel;
    const allowsPrerelease = updaterChannel === "nightly";
    yield* electronUpdater.setChannel(updaterChannel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    yield* electronUpdater.setAllowDowngrade(allowsPrerelease);
    yield* electronUpdater.setFullChangelog(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      updaterChannel,
      allowPrerelease: allowsPrerelease,
      allowDowngrade: allowsPrerelease,
      fullChangelog: allowsPrerelease,
    });
  });

  const shouldEnableAutoUpdates = resolveDisabledReason.pipe(Effect.map(Option.isNone));

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (
    reason: string,
    actionReservation: "acquire" | "held" = "acquire",
  ) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;

    const state = yield* Ref.get(updateStateRef);
    if (state.status === "downloading") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    if (actionReservation === "acquire" && !(yield* tryStartUpdateAction("check"))) return false;

    const check = Effect.gen(function* () {
      const checkedAt = yield* currentIsoTimestamp;
      yield* setState(reduceDesktopUpdateStateOnCheckStart(state, checkedAt));
      yield* logUpdaterInfo("checking for updates", { reason });
      yield* checkMainBranch;

      return yield* electronUpdater.checkForUpdates.pipe(
        Effect.as(true),
        Effect.catchTags({
          ElectronUpdaterCheckForUpdatesError: Effect.fn(
            "desktop.updates.handleCheckForUpdatesFailure",
          )(function* (error) {
            const failedAt = yield* currentIsoTimestamp;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
            });
            return true;
          }),
        }),
      );
    });

    return yield* actionReservation === "held"
      ? check
      : check.pipe(Effect.ensuring(finishUpdateAction("check")));
  });

  const downloadAvailableUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (!(yield* Ref.get(updaterConfiguredRef)) || state.status !== "available") {
      return { accepted: false, completed: false };
    }

    if (!(yield* tryStartUpdateAction("download"))) {
      return { accepted: false, completed: false };
    }

    return yield* Effect.gen(function* () {
      yield* setState(reduceDesktopUpdateStateOnDownloadStart(state));
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logUpdaterInfo("downloading update");
      yield* electronUpdater.downloadUpdate;
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterDownloadUpdateError: Effect.fn("desktop.updates.handleDownloadFailure")(
          function* (error) {
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() =>
        updateState((current) => (current.status === "downloading" ? state : current)).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdateUnexpectedActionError({ action: "download", cause });
        return Effect.gen(function* () {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            action: error.action,
          });
          return { accepted: true, completed: false };
        });
      }),
      Effect.ensuring(finishUpdateAction("download")),
    );
  }).pipe(Effect.withSpan("desktop.updates.downloadAvailableUpdate"));

  const resetInstallAction = Effect.all(
    [finishUpdateAction("install"), Ref.set(desktopState.quitting, false)],
    { discard: true },
  );

  const installDownloadedUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    const hasInstallableDownload =
      state.downloadedVersion !== null &&
      (state.status === "downloaded" ||
        (state.status === "error" &&
          (state.errorContext === null || state.errorContext === "install")));
    if (
      (yield* Ref.get(desktopState.quitting)) ||
      !(yield* Ref.get(updaterConfiguredRef)) ||
      !hasInstallableDownload
    ) {
      return { accepted: false, completed: false };
    }

    if (!(yield* tryStartUpdateAction("install"))) {
      return { accepted: false, completed: false };
    }

    yield* Ref.set(desktopState.quitting, true);

    return yield* Effect.gen(function* () {
      // Stop every backend in the pool, not just the primary. With
      // parallel WSL + Windows backends, leaving the WSL instance up
      // means quitAndInstall's app.quit() exits before the pool's
      // scope cascade has a chance to run its stop finalizer, so the
      // WSL child gets hard-killed by the OS instead of receiving
      // SIGTERM + grace. Stops run concurrently with the same 5s
      // budget the primary had on its own.
      const instances = yield* pool.list;
      yield* Effect.forEach(
        instances,
        (instance) => instance.stop({ timeout: Duration.seconds(5) }),
        { concurrency: "unbounded" },
      );
      yield* electronWindow.destroyAll;
      yield* electronUpdater.quitAndInstall({
        isSilent: true,
        isForceRunAfter: true,
      });
      return { accepted: true, completed: false };
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterQuitAndInstallError: Effect.fn("desktop.updates.handleInstallFailure")(
          function* (error) {
            yield* resetInstallAction;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnInstallFailure(current, error.message),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
              isSilent: error.isSilent,
              isForceRunAfter: error.isForceRunAfter,
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() => resetInstallAction),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) {
            return yield* Effect.failCause(cause);
          }
          yield* resetInstallAction;
          const error = new DesktopUpdateUnexpectedActionError({ action: "install", cause });
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnInstallFailure(current, error.message),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            action: error.action,
          });
          return { accepted: true, completed: false };
        }),
      ),
    );
  }).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "startup", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.forever,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "poll", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          const expectedChannel = state.alphaUpdates ? "nightly" : state.channel;
          if (resolveDefaultDesktopUpdateChannel(info.version) !== expectedChannel) {
            yield* logUpdaterInfo("ignoring update that does not match selected channel", {
              version: info.version,
              channel: expectedChannel,
            });
            const checkedAt = yield* currentIsoTimestamp;
            yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }

          const checkedAt = yield* currentIsoTimestamp;
          const releaseNotes = normalizeDesktopUpdateReleaseNotes(info.releaseNotes, info.version);
          yield* setState(
            reduceDesktopUpdateStateOnUpdateAvailable(state, info.version, checkedAt, releaseNotes),
          );
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logUpdaterInfo("update available", {
            version: info.version,
            releaseNoteGroups: releaseNotes.length,
          });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-available", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    const checkedAt = yield* currentIsoTimestamp;
    const state = yield* Ref.get(updateStateRef);
    yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logUpdaterInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

  const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
    cause: unknown,
  ) {
    const activeAction = yield* activeUpdateAction;
    const error = new DesktopUpdaterReportedError({
      operation: Option.getOrElse(activeAction, () => "background" as const),
      cause,
    });
    if (Option.isSome(activeAction) && activeAction.value === "install") {
      yield* finishUpdateAction("install");
      yield* Ref.set(desktopState.quitting, false);
      yield* updateState((current) =>
        reduceDesktopUpdateStateOnInstallFailure(current, error.message),
      );
      yield* logUpdaterError(error.message, {
        errorTag: error._tag,
        operation: error.operation,
      });
      return;
    }

    if (Option.isNone(activeAction)) {
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((current) => ({
        ...current,
        status: "error",
        message: error.message,
        checkedAt,
        downloadPercent: null,
        errorContext: current.errorContext,
        canRetry: getCanRetryFromState(current),
      }));
    }

    yield* logUpdaterError(error.message, {
      errorTag: error._tag,
      operation: error.operation,
    });
  });

  const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
          const state = yield* Ref.get(updateStateRef);
          const percent = Math.floor(progress.percent);
          if (shouldBroadcastDownloadProgress(state, progress.percent) || state.message !== null) {
            yield* setState(reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent));
          }
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logUpdaterInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "download-progress", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          yield* setState(reduceDesktopUpdateStateOnDownloadComplete(state, info.version));
          yield* logUpdaterInfo("update downloaded", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-downloaded", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    emitState,
    disabledReason: resolveDisabledReason,
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);

      if (config.mockUpdates) {
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: `http://localhost:${config.mockUpdateServerPort}`,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      }

      const settings = yield* desktopSettings.get;
      const enabled = yield* shouldEnableAutoUpdates;
      yield* setState(
        createBaseUpdateState(
          settings.updateChannel,
          enabled,
          environment,
          currentCommitHash,
          settings.alphaUpdates,
        ),
      );
      if (!enabled) {
        return;
      }
      yield* Ref.set(updaterConfiguredRef, true);

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(settings.updateChannel, settings.alphaUpdates);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      const activeAction = yield* tryStartChannelChange;
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      return yield* Effect.gen(function* () {
        const state = yield* Ref.get(updateStateRef);
        if (nextChannel === state.channel) {
          return state;
        }

        yield* desktopSettings
          .setUpdateChannel(nextChannel)
          .pipe(
            Effect.mapError(
              (cause) => new DesktopUpdateChannelPersistenceError({ channel: nextChannel, cause }),
            ),
          );

        const enabled = yield* shouldEnableAutoUpdates;
        yield* setState(
          createBaseUpdateState(
            nextChannel,
            enabled,
            environment,
            currentCommitHash,
            state.alphaUpdates === true,
          ),
        );

        if (!enabled || !(yield* Ref.get(updaterConfiguredRef))) {
          return yield* Ref.get(updateStateRef);
        }

        yield* applyAutoUpdaterChannel(nextChannel, state.alphaUpdates === true);
        const allowDowngrade = yield* electronUpdater.allowDowngrade;
        yield* electronUpdater.setAllowDowngrade(true);
        yield* checkForUpdates("channel-change", "held").pipe(
          Effect.ensuring(electronUpdater.setAllowDowngrade(allowDowngrade).pipe(Effect.ignore)),
        );
        return yield* Ref.get(updateStateRef);
      }).pipe(Effect.ensuring(finishUpdateAction("channel")));
    }),
    setAlphaUpdates: Effect.fn("desktop.updates.setAlphaUpdates")(function* (enabled: boolean) {
      const activeAction = yield* Ref.modify(activeUpdateActionRef, (active) =>
        Option.isSome(active)
          ? [active, active]
          : [Option.none<UpdateAction>(), Option.some("alpha")],
      );
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value,
          requestedChannel: "latest",
        });
      }

      return yield* Effect.gen(function* () {
        const state = yield* Ref.get(updateStateRef);
        if (state.alphaUpdates === enabled) return state;

        yield* desktopSettings
          .setAlphaUpdates(enabled)
          .pipe(
            Effect.mapError((cause) => new DesktopUpdateAlphaPersistenceError({ enabled, cause })),
          );
        const isSyntheticMainUpdate = state.availableVersion?.startsWith("master-") === true;
        yield* setState({
          ...state,
          alphaUpdates: enabled,
          ...(isSyntheticMainUpdate && !enabled
            ? {
                status: "idle" as const,
                availableVersion: null,
                releaseNotes: [],
                downloadPercent: null,
                message: null,
                errorContext: null,
                canRetry: false,
              }
            : {}),
        });

        if (yield* Ref.get(updaterConfiguredRef)) {
          yield* applyAutoUpdaterChannel(state.channel, enabled);
          yield* checkForUpdates("alpha-toggle", "held");
        }
        return yield* Ref.get(updateStateRef);
      }).pipe(Effect.ensuring(finishUpdateAction("alpha")));
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: Effect.gen(function* () {
      if (yield* Ref.get(desktopState.quitting)) {
        return {
          accepted: false,
          completed: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const result = yield* installDownloadedUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.install")),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
