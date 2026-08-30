import type { GeminiSettings } from "@t3tools/contracts";

/** Resolve Google's default per-user Windows install even before a parent process reloads PATH. */
export function resolveGeminiBinaryPath(
  settings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = settings.binaryPath.trim() || "agy";
  if (configured !== "agy" || platform !== "win32") return configured;
  const localAppData = environment.LOCALAPPDATA?.trim();
  return localAppData ? `${localAppData}\\agy\\bin\\agy.exe` : configured;
}
