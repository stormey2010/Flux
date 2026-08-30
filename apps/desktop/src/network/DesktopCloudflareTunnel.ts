// @effect-diagnostics globalDateInEffect:off
import type {
  DesktopCloudflareTunnelState,
  DesktopCloudflareTunnelCreateInput,
} from "@t3tools/contracts";
import { RelayClient } from "@t3tools/shared/relayClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Path from "effect/Path";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

/** Public OAuth client id for the official Flux desktop application. */
export const OFFICIAL_FLUX_CLOUDFLARE_CLIENT_ID = "df6d2280a50a8adb0edd5cd8027a00f3";
const INITIAL_STATE: DesktopCloudflareTunnelState = {
  status: "idle",
  localHttpUrl: null,
  publicUrl: null,
  hostname: null,
  error: null,
  cloudflareConnected: false,
  cloudflareAccounts: [],
  cloudflareZones: [],
  cloudflareAccountId: null,
  cloudflareZoneId: null,
  tunnelId: null,
};
const API_BASE = "https://api.cloudflare.com/client/v4";
const OAUTH_REDIRECT = "http://127.0.0.1:8976/oauth/callback";
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu;
class CloudflareTunnelSetupError extends Schema.TaggedErrorClass<CloudflareTunnelSetupError>()(
  "CloudflareTunnelSetupError",
  { message: Schema.String },
) {}
const isSetupError = Schema.is(CloudflareTunnelSetupError);
interface ActiveTunnel {
  readonly localHttpUrl: string;
  readonly hostname: string | null;
  readonly publicUrl: string | null;
  readonly scope: Scope.Scope;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
}
interface CloudflareResource {
  readonly tunnelId: string;
  readonly accountId: string;
  readonly zoneId: string;
  readonly dnsRecordId: string | null;
  readonly hostname: string;
}
interface PersistedCloudflareTunnel extends CloudflareResource {
  readonly connectorToken: string;
  readonly localHttpUrl: string;
}
const PersistedCloudflareTunnelSchema = Schema.Struct({
  tunnelId: Schema.String,
  accountId: Schema.String,
  zoneId: Schema.String,
  dnsRecordId: Schema.NullOr(Schema.String),
  hostname: Schema.String,
  connectorToken: Schema.String,
  localHttpUrl: Schema.String,
});
const decodePersistedCloudflareTunnel = Schema.decodeEffect(
  Schema.fromJsonString(PersistedCloudflareTunnelSchema),
);
const encodePersistedCloudflareTunnel = Schema.encodeEffect(
  Schema.fromJsonString(PersistedCloudflareTunnelSchema),
);
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const arrayValue = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const normalizeLocalUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
};

// Cloudflare ingress rules proxy the request path through to the origin. The
// origin service therefore must be just an origin, not a URL with `/` or any
// other path attached to it.
const localOriginForTunnel = (value: string): string => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
};

export class DesktopCloudflareTunnel extends Context.Service<
  DesktopCloudflareTunnel,
  {
    readonly getState: Effect.Effect<DesktopCloudflareTunnelState>;
    readonly connectCloudflare: Effect.Effect<DesktopCloudflareTunnelState>;
    readonly disconnectCloudflare: Effect.Effect<DesktopCloudflareTunnelState>;
    readonly deleteCloudflareTunnel: Effect.Effect<DesktopCloudflareTunnelState>;
    readonly startQuickTunnel: (
      localHttpUrl: string,
    ) => Effect.Effect<DesktopCloudflareTunnelState>;
    readonly createManagedTunnel: (
      localHttpUrl: string,
      input?: DesktopCloudflareTunnelCreateInput,
    ) => Effect.Effect<DesktopCloudflareTunnelState, unknown>;
    readonly stopQuickTunnel: Effect.Effect<DesktopCloudflareTunnelState>;
  }
>()("@t3tools/desktop/network/DesktopCloudflareTunnel") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const relayClient = yield* RelayClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const shell = yield* ElectronShell.ElectronShell;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateRef = yield* Ref.make<DesktopCloudflareTunnelState>(INITIAL_STATE);
  const activeRef = yield* Ref.make<ActiveTunnel | null>(null);
  const resourceRef = yield* Ref.make<CloudflareResource | null>(null);
  const tokenRef = yield* Ref.make<string | null>(null);
  // Keep tunnel credentials outside the dev/release-specific state folders.
  // A local rebuild can switch between those folders, while the user's
  // managed Cloudflare tunnel should remain attached to the same machine.
  const persistedTunnelPath = path.join(environment.baseDir, "cloudflare-tunnel.json");
  const legacyPersistedTunnelPath = path.join(environment.stateDir, "cloudflare-tunnel.json");
  const getState = Ref.get(stateRef);
  const setError = (message: string) =>
    Ref.update(stateRef, (state) => ({ ...state, status: "error" as const, error: message }));
  const readPersistedTunnel = Effect.gen(function* () {
    if (!(yield* safeStorage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false))))
      return null;
    const primary = yield* fileSystem.readFileString(persistedTunnelPath).pipe(Effect.option);
    const encrypted =
      primary._tag === "Some"
        ? primary
        : yield* fileSystem.readFileString(legacyPersistedTunnelPath).pipe(Effect.option);
    if (encrypted._tag === "None") return null;
    const plaintext = yield* safeStorage
      .decryptString(Buffer.from(encrypted.value, "base64"))
      .pipe(Effect.option);
    if (plaintext._tag === "None") return null;
    const decoded = yield* decodePersistedCloudflareTunnel(plaintext.value).pipe(Effect.option);
    return decoded._tag === "Some" ? decoded.value : null;
  });
  const persistTunnel = (tunnel: PersistedCloudflareTunnel) =>
    Effect.gen(function* () {
      if (!(yield* safeStorage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false))))
        return;
      const document = yield* encodePersistedCloudflareTunnel(tunnel);
      const encrypted = yield* safeStorage.encryptString(document);
      yield* fileSystem.makeDirectory(path.dirname(persistedTunnelPath), { recursive: true });
      yield* fileSystem.writeFileString(
        persistedTunnelPath,
        Buffer.from(encrypted).toString("base64"),
      );
    }).pipe(Effect.catch(() => Effect.void));
  const clearPersistedTunnel = Effect.all(
    [persistedTunnelPath, legacyPersistedTunnelPath].map((target) =>
      fileSystem.remove(target, { force: true }).pipe(Effect.catch(() => Effect.void)),
    ),
  ).pipe(Effect.asVoid);
  const apiJson = Effect.fn("desktop.cloudflare.apiJson")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const response = yield* httpClient.execute(request);
    const body = yield* response.json.pipe(
      Effect.mapError(
        () => new CloudflareTunnelSetupError({ message: "Cloudflare returned invalid JSON." }),
      ),
    );
    const responseRecord = asRecord(body);
    if (response.status < 200 || response.status >= 300 || responseRecord.success === false) {
      const first = arrayValue(responseRecord.errors)[0];
      return yield* new CloudflareTunnelSetupError({
        message:
          stringValue(asRecord(first).message) ?? `Cloudflare returned HTTP ${response.status}.`,
      });
    }
    return body;
  });
  const authorized = (request: HttpClientRequest.HttpClientRequest, token: string) =>
    request.pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      HttpClientRequest.setHeader("Accept", "application/json"),
    );
  const oauthCode = Effect.gen(function* () {
    const clientId =
      process.env.T3CODE_CLOUDFLARE_OAUTH_CLIENT_ID?.trim() || OFFICIAL_FLUX_CLOUDFLARE_CLIENT_ID;
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(16).toString("base64url");
    const callbackFiber = yield* Effect.promise(
      () =>
        new Promise<{ code?: string; error?: string; errorDescription?: string }>(
          (resolve, reject) => {
            const server = require("node:http").createServer(
              (
                request: { url?: string },
                response: {
                  writeHead: (status: number, headers?: Record<string, string>) => void;
                  end: (body?: string) => void;
                },
              ) => {
                try {
                  const url = new URL(request.url ?? "/", OAUTH_REDIRECT);
                  if (url.pathname !== "/oauth/callback") return response.end();
                  if (url.searchParams.get("state") !== state) {
                    response.writeHead(400);
                    response.end("Invalid OAuth state");
                    resolve({ error: "Cloudflare OAuth state validation failed." });
                    server.close();
                    return;
                  }
                  const code = url.searchParams.get("code");
                  const error = url.searchParams.get("error");
                  const errorDescription = url.searchParams.get("error_description");
                  response.writeHead(error ? 400 : 200, { "content-type": "text/html" });
                  response.end(
                    error
                      ? "<h2>Flux could not connect to Cloudflare.</h2><p>Return to Flux for details.</p>"
                      : "<h2>Flux is connected to Cloudflare.</h2><p>You can close this window.</p>",
                  );
                  resolve(
                    error
                      ? { error, ...(errorDescription ? { errorDescription } : {}) }
                      : code
                        ? { code }
                        : { error: "Cloudflare did not return an authorization code." },
                  );
                  server.close();
                } catch {
                  resolve({ error: "Cloudflare OAuth callback was invalid." });
                  server.close();
                }
              },
            );
            server.once("error", reject);
            server.listen(8976, "127.0.0.1");
          },
        ),
    ).pipe(Effect.forkChild);
    const auth = new URL("https://dash.cloudflare.com/oauth2/auth");
    auth.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: OAUTH_REDIRECT,
      response_type: "code",
      scope: "argotunnel.write dns.write zone.read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();
    if (!(yield* shell.openExternal(auth.toString())))
      return yield* new CloudflareTunnelSetupError({
        message: "Could not open the Cloudflare sign-in page.",
      });
    const callback = yield* Fiber.join(callbackFiber);
    if (callback.error || !callback.code)
      return yield* new CloudflareTunnelSetupError({
        message: callback.errorDescription ?? callback.error ?? "Cloudflare sign-in was cancelled.",
      });
    const tokenResponse = yield* apiJson(
      HttpClientRequest.post("https://dash.cloudflare.com/oauth2/token").pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: callback.code,
          redirect_uri: OAUTH_REDIRECT,
          code_verifier: verifier,
        }),
      ),
    );
    const token =
      stringValue(asRecord(tokenResponse).access_token) ??
      stringValue(asRecord(asRecord(tokenResponse).result).access_token);
    if (!token)
      return yield* new CloudflareTunnelSetupError({
        message: "Cloudflare did not return an access token.",
      });
    return token;
  });
  const loadResources = (token: string) =>
    Effect.gen(function* () {
      const zonesBody = yield* apiJson(
        authorized(HttpClientRequest.get(`${API_BASE}/zones?per_page=100&status=active`), token),
      );
      const discoveredZones = arrayValue(asRecord(zonesBody).result).flatMap((item) => {
        const r = asRecord(item);
        const id = stringValue(r.id);
        const name = stringValue(r.name);
        const account = asRecord(r.account);
        const accountId = stringValue(account.id);
        const accountName = stringValue(account.name);
        return id && name && accountId && accountName ? [{ id, name, accountId, accountName }] : [];
      });
      if (!discoveredZones.length)
        return yield* new CloudflareTunnelSetupError({
          message: "No active Cloudflare domains are available for this login.",
        });
      const accounts = Array.from(
        new Map(
          discoveredZones.map((zone) => [
            zone.accountId,
            { id: zone.accountId, name: zone.accountName },
          ]),
        ).values(),
      );
      const zones = discoveredZones.map(({ id, name }) => ({ id, name }));
      const accountId = discoveredZones[0]!.accountId;
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        cloudflareConnected: true,
        cloudflareAccounts: accounts,
        cloudflareZones: zones,
        cloudflareAccountId: accountId,
        cloudflareZoneId: zones[0]?.id ?? null,
        error: null,
      }));
      return yield* Ref.get(stateRef);
    });
  const connectCloudflare = oauthCode.pipe(
    Effect.tap((token) => Ref.set(tokenRef, token)),
    Effect.flatMap(loadResources),
    Effect.catch((cause) =>
      setError(isSetupError(cause) ? cause.message : "Could not connect to Cloudflare.").pipe(
        Effect.map(() => ({
          ...INITIAL_STATE,
          status: "error" as const,
          error: isSetupError(cause) ? cause.message : "Could not connect to Cloudflare.",
        })),
      ),
    ),
  );
  const stopQuickTunnel = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    if (active) yield* Scope.close(active.scope, Exit.void).pipe(Effect.ignore);
    const current = yield* Ref.get(stateRef);
    const next = {
      ...current,
      status: "idle" as const,
      localHttpUrl: null,
      publicUrl: null,
      hostname: null,
      error: null,
    };
    yield* Ref.set(stateRef, next);
    return next;
  });
  const observeOutput = (active: ActiveTunnel) =>
    active.child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => line.trim()),
      Stream.filter((line) => line.length > 0),
      Stream.runForEach((line) => {
        const match = line.match(QUICK_TUNNEL_URL);
        return match?.[0]
          ? Ref.update(stateRef, (state) => ({
              ...state,
              status: "running" as const,
              publicUrl: match[0],
              error: null,
            }))
          : Effect.void;
      }),
      Effect.catchCause(() => Effect.void),
    );
  const observeExit = (active: ActiveTunnel) =>
    active.child.exitCode.pipe(
      Effect.flatMap(() =>
        Ref.get(activeRef).pipe(
          Effect.flatMap((current) =>
            current === active
              ? Ref.set(stateRef, {
                  ...INITIAL_STATE,
                  status: "error",
                  localHttpUrl: active.localHttpUrl,
                  publicUrl: active.publicUrl,
                  hostname: active.hostname,
                  error: "The Flux tunnel exited unexpectedly.",
                })
              : Effect.void,
          ),
        ),
      ),
      Effect.catchCause(() => Effect.void),
    );
  const spawnConnector = (
    executablePath: string,
    args: ReadonlyArray<string>,
    localHttpUrl: string,
    hostname: string | null,
    publicUrl: string | null,
  ) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const spawned = yield* spawner
        .spawn(
          ChildProcess.make(executablePath, args, {
            detached: false,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            shell: false,
            killSignal: "SIGTERM",
            forceKillAfter: "5 seconds",
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope), Effect.result);
      if (Result.isFailure(spawned)) {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        return false;
      }
      const active: ActiveTunnel = {
        localHttpUrl,
        hostname,
        publicUrl,
        scope,
        child: spawned.success,
      };
      yield* Ref.set(activeRef, active);
      yield* Effect.forkIn(observeOutput(active), scope);
      yield* Effect.forkIn(observeExit(active), scope);
      return true;
    });
  const restoreManagedTunnel = Effect.gen(function* () {
    const persisted = yield* readPersistedTunnel;
    if (!persisted) return;
    let executable = yield* relayClient.resolve;
    if (executable.status !== "available") return;
    const started = yield* spawnConnector(
      executable.executablePath,
      ["tunnel", "--no-autoupdate", "run", "--token", persisted.connectorToken],
      persisted.localHttpUrl,
      persisted.hostname,
      `https://${persisted.hostname}`,
    );
    if (!started) return;
    yield* Ref.set(resourceRef, {
      tunnelId: persisted.tunnelId,
      accountId: persisted.accountId,
      zoneId: persisted.zoneId,
      dnsRecordId: persisted.dnsRecordId,
      hostname: persisted.hostname,
    });
    yield* Ref.set(stateRef, {
      ...INITIAL_STATE,
      status: "running",
      localHttpUrl: persisted.localHttpUrl,
      publicUrl: `https://${persisted.hostname}`,
      hostname: persisted.hostname,
      tunnelId: persisted.tunnelId,
    });
    // If this came from the pre-upgrade state location, copy it to the
    // stable path now so the next restart does not depend on the old layout.
    yield* persistTunnel(persisted);
  }).pipe(Effect.catch(() => Effect.void));
  const startQuickTunnel = Effect.fn("desktop.cloudflare.startQuickTunnel")(function* (
    localHttpUrl: string,
  ) {
    const normalized = normalizeLocalUrl(localHttpUrl);
    if (!normalized)
      return yield* setError("Flux did not provide a valid local web URL.").pipe(
        Effect.map(() => ({
          ...INITIAL_STATE,
          status: "error" as const,
          error: "Flux did not provide a valid local web URL.",
        })),
      );
    yield* stopQuickTunnel;
    let executable = yield* relayClient.resolve;
    if (executable.status !== "available")
      executable = yield* relayClient.install.pipe(Effect.orElseSucceed(() => executable));
    if (executable.status !== "available")
      return yield* setError("Could not install cloudflared on this machine.").pipe(
        Effect.map(() => ({
          ...INITIAL_STATE,
          status: "error" as const,
          error: "Could not install cloudflared on this machine.",
        })),
      );
    yield* Ref.set(stateRef, { ...INITIAL_STATE, status: "starting", localHttpUrl: normalized });
    const started = yield* spawnConnector(
      executable.executablePath,
      ["tunnel", "--no-autoupdate", "--url", normalized],
      normalized,
      null,
      null,
    );
    if (!started)
      return yield* setError("Could not start cloudflared.").pipe(
        Effect.map(() => ({
          ...INITIAL_STATE,
          status: "error" as const,
          localHttpUrl: normalized,
          error: "Could not start cloudflared.",
        })),
      );
    return yield* Ref.get(stateRef);
  });
  const createManagedTunnel = (localHttpUrl: string, input?: DesktopCloudflareTunnelCreateInput) =>
    Effect.gen(function* () {
      const normalized = normalizeLocalUrl(localHttpUrl);
      if (!normalized)
        return yield* setError("Flux did not provide a valid local web URL.").pipe(
          Effect.map(() => ({
            ...INITIAL_STATE,
            status: "error" as const,
            error: "Flux did not provide a valid local web URL.",
          })),
        );
      const token = yield* Ref.get(tokenRef);
      if (!token)
        return yield* setError("Connect Cloudflare first.").pipe(
          Effect.map(() => ({
            ...INITIAL_STATE,
            status: "error" as const,
            localHttpUrl: normalized,
            error: "Connect Cloudflare first.",
          })),
        );
      const current = yield* Ref.get(stateRef);
      const zoneId = input?.zoneId ?? current.cloudflareZoneId;
      const zone = current.cloudflareZones?.find((item) => item.id === zoneId);
      if (!zoneId || !zone)
        return yield* setError("Choose a Cloudflare account and domain first.").pipe(
          Effect.map(() => ({
            ...current,
            status: "error" as const,
            error: "Choose a Cloudflare account and domain first.",
          })),
        );
      const zoneDetails = yield* apiJson(
        authorized(HttpClientRequest.get(`${API_BASE}/zones/${zoneId}`), token),
      );
      const accountId =
        stringValue(asRecord(asRecord(asRecord(zoneDetails).result).account).id) ??
        input?.accountId ??
        current.cloudflareAccountId;
      if (!accountId)
        return yield* setError("Cloudflare did not return the account for that domain.").pipe(
          Effect.map(() => ({
            ...current,
            status: "error" as const,
            error: "Cloudflare did not return the account for that domain.",
          })),
        );
      const requested = (input?.hostname ?? "flux").trim().toLowerCase();
      const hostname = requested.includes(".") ? requested : `${requested}.${zone.name}`;
      if (!hostname.endsWith(`.${zone.name}`) && hostname !== zone.name)
        return yield* setError(`Use a hostname under ${zone.name}.`).pipe(
          Effect.map(() => ({
            ...current,
            status: "error" as const,
            error: `Use a hostname under ${zone.name}.`,
          })),
        );
      yield* stopQuickTunnel;
      yield* Ref.set(stateRef, {
        ...current,
        status: "starting",
        localHttpUrl: normalized,
        hostname,
        // Do not advertise a public URL until Cloudflare confirms that the DNS
        // record exists. A 2xx response can still contain { success: false }.
        publicUrl: null,
        error: null,
      });
      const created = yield* apiJson(
        authorized(
          HttpClientRequest.post(`${API_BASE}/accounts/${accountId}/cfd_tunnel`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              name: `flux-${Date.now().toString(36)}`,
              config_src: "cloudflare",
            }),
          ),
          token,
        ),
      );
      const tunnel = asRecord(asRecord(created).result);
      const tunnelId = stringValue(tunnel.id);
      const connectorToken = stringValue(tunnel.token);
      if (!tunnelId || !connectorToken)
        return yield* setError("Cloudflare did not return a tunnel token.").pipe(
          Effect.map(() => ({
            ...current,
            status: "error" as const,
            hostname,
            error: "Cloudflare did not return a tunnel token.",
          })),
        );
      yield* apiJson(
        authorized(
          HttpClientRequest.put(
            `${API_BASE}/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              config: {
                ingress: [
                  { hostname, service: localOriginForTunnel(normalized), originRequest: {} },
                  { service: "http_status:404" },
                ],
              },
            }),
          ),
          token,
        ),
      );
      const dns = yield* apiJson(
        authorized(
          HttpClientRequest.get(
            `${API_BASE}/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
          ),
          token,
        ),
      );
      const existing = arrayValue(asRecord(dns).result)[0];
      let dnsRecordId = stringValue(asRecord(existing).id);
      const target = `${tunnelId}.cfargotunnel.com`;
      if (existing && stringValue(asRecord(existing).content) !== target)
        return yield* setError(
          "That hostname already has a DNS record. Choose another subdomain.",
        ).pipe(
          Effect.map(() => ({
            ...current,
            status: "error" as const,
            hostname,
            error: "That hostname already has a DNS record. Choose another subdomain.",
          })),
        );
      if (dnsRecordId)
        yield* apiJson(
          authorized(
            HttpClientRequest.put(`${API_BASE}/zones/${zoneId}/dns_records/${dnsRecordId}`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                type: "CNAME",
                name: hostname,
                content: target,
                proxied: true,
              }),
            ),
            token,
          ),
        );
      else {
        const createdDns = yield* apiJson(
          authorized(
            HttpClientRequest.post(`${API_BASE}/zones/${zoneId}/dns_records`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                type: "CNAME",
                name: hostname,
                content: target,
                proxied: true,
                ttl: 1,
              }),
            ),
            token,
          ),
        );
        dnsRecordId = stringValue(asRecord(asRecord(createdDns).result).id);
      }
      if (!dnsRecordId)
        return yield* setError("Cloudflare did not confirm creation of the DNS record.").pipe(
          Effect.map(() => ({
            ...current,
            status: "error" as const,
            hostname,
            error: "Cloudflare did not confirm creation of the DNS record.",
          })),
        );
      const verifiedDns = yield* apiJson(
        authorized(
          HttpClientRequest.get(
            `${API_BASE}/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
          ),
          token,
        ),
      );
      const verifiedRecord = arrayValue(asRecord(verifiedDns).result).find(
        (record) =>
          stringValue(asRecord(record).id) === dnsRecordId &&
          stringValue(asRecord(record).content) === target &&
          asRecord(record).proxied === true,
      );
      if (!verifiedRecord)
        return yield* setError(
          "Cloudflare did not verify the new tunnel DNS record. Choose another hostname and try again.",
        ).pipe(
          Effect.map(() => ({
            ...current,
            status: "error" as const,
            hostname,
            error:
              "Cloudflare did not verify the new tunnel DNS record. Choose another hostname and try again.",
          })),
        );
      yield* Ref.set(resourceRef, { tunnelId, accountId, zoneId, dnsRecordId, hostname });
      yield* Ref.set(stateRef, {
        ...current,
        status: "starting",
        localHttpUrl: normalized,
        publicUrl: `https://${hostname}`,
        hostname,
        tunnelId,
        error: null,
      });
      let executable = yield* relayClient.resolve;
      if (executable.status !== "available")
        executable = yield* relayClient.install.pipe(Effect.orElseSucceed(() => executable));
      if (executable.status !== "available")
        return yield* setError("Could not install cloudflared on this machine.").pipe(
          Effect.map(() => ({
            ...current,
            status: "error" as const,
            hostname,
            error: "Could not install cloudflared on this machine.",
          })),
        );
      const started = yield* spawnConnector(
        executable.executablePath,
        ["tunnel", "--no-autoupdate", "run", "--token", connectorToken],
        normalized,
        hostname,
        `https://${hostname}`,
      );
      if (!started)
        return yield* setError("Could not start the Flux connector.").pipe(
          Effect.map(() => ({
            ...current,
            status: "error" as const,
            hostname,
            error: "Could not start the Flux connector.",
          })),
        );
      yield* persistTunnel({
        tunnelId,
        accountId,
        zoneId,
        dnsRecordId,
        hostname,
        connectorToken,
        localHttpUrl: normalized,
      });
      yield* Ref.update(stateRef, (state) => ({ ...state, status: "running" as const }));
      return yield* Ref.get(stateRef);
    }).pipe(
      Effect.catch((cause) =>
        setError(
          isSetupError(cause)
            ? cause.message
            : "Cloudflare could not finish creating the Flux tunnel.",
        ).pipe(Effect.andThen(Ref.get(stateRef))),
      ),
    );
  const disconnectCloudflare = Ref.set(tokenRef, null).pipe(
    Effect.andThen(
      Ref.update(stateRef, (state) => ({
        ...state,
        cloudflareConnected: false,
        cloudflareAccounts: [],
        cloudflareZones: [],
        cloudflareAccountId: null,
        cloudflareZoneId: null,
      })),
    ),
    Effect.andThen(Ref.get(stateRef)),
  );
  const deleteCloudflareTunnel = Effect.gen(function* () {
    const resource = yield* Ref.get(resourceRef);
    const token = yield* Ref.get(tokenRef);
    if (resource && token) {
      if (resource.dnsRecordId)
        yield* apiJson(
          authorized(
            HttpClientRequest.delete(
              `${API_BASE}/zones/${resource.zoneId}/dns_records/${resource.dnsRecordId}`,
            ),
            token,
          ),
        ).pipe(Effect.ignore);
      yield* apiJson(
        authorized(
          HttpClientRequest.delete(
            `${API_BASE}/accounts/${resource.accountId}/cfd_tunnel/${resource.tunnelId}`,
          ),
          token,
        ),
      ).pipe(Effect.ignore);
    }
    yield* stopQuickTunnel;
    yield* Ref.set(resourceRef, null);
    yield* clearPersistedTunnel;
    return yield* Ref.get(stateRef);
  });
  yield* restoreManagedTunnel;
  yield* Effect.addFinalizer(() => stopQuickTunnel.pipe(Effect.ignore));
  return DesktopCloudflareTunnel.of({
    getState,
    connectCloudflare,
    disconnectCloudflare,
    deleteCloudflareTunnel,
    startQuickTunnel,
    createManagedTunnel,
    stopQuickTunnel,
  });
});
export const layer = Layer.effect(DesktopCloudflareTunnel, make);
