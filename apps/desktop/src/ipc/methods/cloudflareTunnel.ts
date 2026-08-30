// @effect-diagnostics anyUnknownInErrorContext:off
import {
  DesktopCloudflareTunnelCreateInputSchema,
  DesktopCloudflareTunnelStateSchema,
  type DesktopCloudflareTunnelState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopCloudflareTunnel from "../../network/DesktopCloudflareTunnel.ts";
import * as DesktopServerExposure from "../../backend/DesktopServerExposure.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getCloudflareTunnelState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLOUDFLARE_TUNNEL_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopCloudflareTunnelStateSchema,
  handler: Effect.fn("desktop.ipc.cloudflareTunnel.getState")(function* () {
    const tunnel = yield* DesktopCloudflareTunnel.DesktopCloudflareTunnel;
    return yield* tunnel.getState;
  }),
});

export const startCloudflareQuickTunnel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.START_CLOUDFLARE_QUICK_TUNNEL_CHANNEL,
  payload: Schema.Void,
  result: DesktopCloudflareTunnelStateSchema,
  handler: Effect.fn("desktop.ipc.cloudflareTunnel.startQuickTunnel")(function* () {
    const tunnel = yield* DesktopCloudflareTunnel.DesktopCloudflareTunnel;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const config = yield* serverExposure.backendConfig;
    return yield* tunnel.startQuickTunnel(config.httpBaseUrl.toString());
  }),
});

export const stopCloudflareQuickTunnel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STOP_CLOUDFLARE_QUICK_TUNNEL_CHANNEL,
  payload: Schema.Void,
  result: DesktopCloudflareTunnelStateSchema,
  handler: Effect.fn("desktop.ipc.cloudflareTunnel.stopQuickTunnel")(function* () {
    const tunnel = yield* DesktopCloudflareTunnel.DesktopCloudflareTunnel;
    return yield* tunnel.stopQuickTunnel;
  }),
});

export const createCloudflareTunnel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CREATE_CLOUDFLARE_TUNNEL_CHANNEL,
  payload: Schema.NullOr(DesktopCloudflareTunnelCreateInputSchema),
  result: DesktopCloudflareTunnelStateSchema,
  handler: Effect.fn("desktop.ipc.cloudflareTunnel.createManaged")(function* (input) {
    const tunnel = yield* DesktopCloudflareTunnel.DesktopCloudflareTunnel;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const config = yield* serverExposure.backendConfig;
    return yield* tunnel
      .createManagedTunnel(config.httpBaseUrl.toString(), input ?? undefined)
      .pipe(Effect.catch(() => tunnel.getState));
  }),
});

export const connectCloudflare = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONNECT_CLOUDFLARE_CHANNEL,
  payload: Schema.Void,
  result: DesktopCloudflareTunnelStateSchema,
  handler: Effect.fn("desktop.ipc.cloudflareTunnel.connect")(function* () {
    const tunnel = yield* DesktopCloudflareTunnel.DesktopCloudflareTunnel;
    return yield* tunnel.connectCloudflare;
  }),
});

export const disconnectCloudflare = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCONNECT_CLOUDFLARE_CHANNEL,
  payload: Schema.Void,
  result: DesktopCloudflareTunnelStateSchema,
  handler: Effect.fn("desktop.ipc.cloudflareTunnel.disconnect")(function* () {
    const tunnel = yield* DesktopCloudflareTunnel.DesktopCloudflareTunnel;
    return yield* tunnel.disconnectCloudflare;
  }),
});

export const deleteCloudflareTunnel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DELETE_CLOUDFLARE_TUNNEL_CHANNEL,
  payload: Schema.Void,
  result: DesktopCloudflareTunnelStateSchema,
  handler: Effect.fn("desktop.ipc.cloudflareTunnel.delete")(function* () {
    const tunnel = yield* DesktopCloudflareTunnel.DesktopCloudflareTunnel;
    return yield* tunnel.deleteCloudflareTunnel;
  }),
});

export type CloudflareTunnelState = DesktopCloudflareTunnelState;
