import * as Effect from "effect/Effect";

import * as DesktopIpc from "./DesktopIpc.ts";
import {
  createCloudflareTunnel,
  connectCloudflare,
  disconnectCloudflare,
  deleteCloudflareTunnel,
  getCloudflareTunnelState,
  startCloudflareQuickTunnel,
  stopCloudflareQuickTunnel,
} from "./methods/cloudflareTunnel.ts";
import { getClientSettings, setClientSettings } from "./methods/clientSettings.ts";
import {
  clearConnectionCatalog,
  getConnectionCatalog,
  setConnectionCatalog,
} from "./methods/connectionCatalog.ts";
import {
  getAdvertisedEndpoints,
  getServerExposureState,
  setServerExposureMode,
  setTailscaleServeEnabled,
} from "./methods/serverExposure.ts";
import {
  bootstrapSshBearerSession,
  disconnectSshEnvironment,
  discoverSshHosts,
  ensureSshEnvironment,
  fetchSshEnvironmentDescriptor,
  fetchSshSessionState,
  issueSshWebSocketTicket,
  resolveSshPasswordPrompt,
} from "./methods/sshEnvironment.ts";
import {
  checkForUpdate,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  setAlphaUpdates,
  setUpdateChannel,
} from "./methods/updates.ts";
import {
  getAppBranding,
  getLocalEnvironmentBootstraps,
  getLocalEnvironmentBearerToken,
  getSystemLocale,
  getWindowFullscreenState,
  openExternal,
  probeRemoteEditors,
  pickFolder,
  pickProjectFavicon,
  pickThemeFiles,
  setTheme,
  showContextMenu,
} from "./methods/window.ts";
import * as PreviewIpc from "./methods/preview.ts";
import * as SpeechIpc from "./methods/speech.ts";
import { getWslState, setWslBackendEnabled, setWslDistro, setWslOnly } from "./methods/wsl.ts";

export const installDesktopIpcHandlers = Effect.fn("desktop.ipc.installHandlers")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* PreviewIpc.installPreviewEventForwarding();
  yield* SpeechIpc.installSpeechEventForwarding();

  yield* ipc.handleSync(getAppBranding);
  yield* ipc.handleSync(getSystemLocale);
  yield* ipc.handleSync(getWindowFullscreenState);
  yield* ipc.handleSync(getLocalEnvironmentBootstraps);
  yield* ipc.handle(getLocalEnvironmentBearerToken);

  yield* ipc.handle(getClientSettings);
  yield* ipc.handle(setClientSettings);
  yield* ipc.handle(getConnectionCatalog);
  yield* ipc.handle(setConnectionCatalog);
  yield* ipc.handle(clearConnectionCatalog);

  yield* ipc.handle(discoverSshHosts);
  yield* ipc.handle(ensureSshEnvironment);
  yield* ipc.handle(disconnectSshEnvironment);
  yield* ipc.handle(fetchSshEnvironmentDescriptor);
  yield* ipc.handle(bootstrapSshBearerSession);
  yield* ipc.handle(fetchSshSessionState);
  yield* ipc.handle(issueSshWebSocketTicket);
  yield* ipc.handle(resolveSshPasswordPrompt);

  yield* ipc.handle(getServerExposureState);
  yield* ipc.handle(setServerExposureMode);
  yield* ipc.handle(setTailscaleServeEnabled);
  yield* ipc.handle(getCloudflareTunnelState);
  yield* ipc.handle(startCloudflareQuickTunnel);
  yield* ipc.handle(stopCloudflareQuickTunnel);
  yield* ipc.handle(createCloudflareTunnel);
  yield* ipc.handle(connectCloudflare);
  yield* ipc.handle(disconnectCloudflare);
  yield* ipc.handle(deleteCloudflareTunnel);
  yield* ipc.handle(getAdvertisedEndpoints);

  yield* ipc.handle(getWslState);
  yield* ipc.handle(setWslBackendEnabled);
  yield* ipc.handle(setWslDistro);
  yield* ipc.handle(setWslOnly);

  yield* ipc.handle(pickFolder);
  yield* ipc.handle(pickProjectFavicon);
  yield* ipc.handle(pickThemeFiles);
  yield* ipc.handle(setTheme);
  yield* ipc.handle(showContextMenu);
  yield* ipc.handle(openExternal);
  yield* ipc.handle(probeRemoteEditors);
  yield* ipc.handle(getUpdateState);
  yield* ipc.handle(setUpdateChannel);
  yield* ipc.handle(setAlphaUpdates);
  yield* ipc.handle(downloadUpdate);
  yield* ipc.handle(installUpdate);
  yield* ipc.handle(checkForUpdate);
  yield* ipc.handle(SpeechIpc.getSpeechStatus);
  yield* ipc.handle(SpeechIpc.startSpeech);
  yield* ipc.handle(SpeechIpc.stopSpeech);
  yield* ipc.handle(SpeechIpc.cancelSpeech);
  yield* ipc.handle(SpeechIpc.removeSpeechModelMethod);
  for (const previewMethod of PreviewIpc.methods) {
    yield* ipc.handle(previewMethod);
  }
});
