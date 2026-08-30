// @effect-diagnostics nodeBuiltinImport:off - packaged native library resolution needs real filesystem probes.
import type { TranscribeModel } from "transcribe-cpp";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

function resolvePackagedTranscribeLibrary(): string | null {
  const resourcesPath = process.resourcesPath;
  const platformTuple =
    process.platform === "win32" && process.arch === "x64"
      ? { directory: "win32-x64-cpu-vulkan", filename: "transcribe.dll" }
      : process.platform === "linux" && process.arch === "x64"
        ? { directory: "linux-x64-cpu-vulkan", filename: "libtranscribe.so" }
        : process.platform === "linux" && process.arch === "arm64"
          ? { directory: "linux-arm64-cpu-vulkan", filename: "libtranscribe.so" }
          : process.platform === "darwin" && process.arch === "arm64"
            ? { directory: "darwin-arm64-metal", filename: "libtranscribe.dylib" }
            : process.platform === "darwin" && process.arch === "x64"
              ? { directory: "darwin-x64-cpu", filename: "libtranscribe.dylib" }
              : null;
  if (!platformTuple || !resourcesPath) return null;

  const candidate = NodePath.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@transcribe-cpp",
    platformTuple.directory,
    platformTuple.filename,
  );
  return NodeFS.existsSync(candidate) ? candidate : null;
}

export class DesktopTranscriptionBackend {
  private readonly modelPath: string;
  private model: TranscribeModel | undefined;
  private loading: Promise<TranscribeModel> | undefined;

  constructor(modelPath: string) {
    this.modelPath = modelPath;
  }

  async prepare(): Promise<void> {
    if (this.model) return;
    this.loading ??= (async () => {
      // Electron unpacks the native DLLs into app.asar.unpacked, but the
      // dependency's package resolver can still return the virtual app.asar
      // path. Give it the real filesystem path so koffi can load the DLL and
      // its sibling ggml backends.
      const packagedLibrary = resolvePackagedTranscribeLibrary();
      const previousLibrary = process.env.TRANSCRIBE_LIBRARY;
      if (packagedLibrary) process.env.TRANSCRIBE_LIBRARY = packagedLibrary;
      try {
        const { TranscribeModel } = await import("transcribe-cpp");
        return await TranscribeModel.load(this.modelPath);
      } finally {
        if (previousLibrary === undefined) delete process.env.TRANSCRIBE_LIBRARY;
        else process.env.TRANSCRIBE_LIBRARY = previousLibrary;
      }
    })().then((model) => {
      this.model = model;
      return model;
    });
    await this.loading;
  }

  async transcribe(pcm: Float32Array): Promise<string> {
    if (pcm.length === 0) throw new Error("no audio samples were provided");
    await this.prepare();
    const result = await this.model!.transcribe(pcm, {
      timestamps: "none",
      language: "en",
    });
    return result.text.trim();
  }

  async dispose(): Promise<void> {
    await this.loading?.catch(() => undefined);
    this.model?.dispose();
    this.model = undefined;
    this.loading = undefined;
  }
}
