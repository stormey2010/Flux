import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "../files/projectFilesQueryState";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectEnvironment } from "../../state/projects";
import {
  buildDefaultProjectAgentsMd,
  PROJECT_AGENTS_MD_PATH,
  PROJECT_AGENTS_MD_SETTINGS_HASH,
} from "../../projectAgentsMd";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsSection } from "./settingsLayout";

export function ProjectAgentsMdSection({
  environmentId,
  cwd,
  projectName,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
}) {
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const fileQuery = useProjectFileQuery(environmentId, cwd, PROJECT_AGENTS_MD_PATH);
  const remoteContents = fileQuery.data?.contents ?? null;
  const missing = !fileQuery.isPending && remoteContents === null && fileQuery.error !== null;

  const [draft, setDraft] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setDraft(null);
  }, [environmentId, cwd]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash.replace(/^#/, "") !== PROJECT_AGENTS_MD_SETTINGS_HASH) return;
    const node = document.getElementById(PROJECT_AGENTS_MD_SETTINGS_HASH);
    node?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [fileQuery.isPending]);

  const displayValue = draft ?? remoteContents ?? "";
  const dirty = useMemo(() => {
    if (draft === null) return false;
    return draft !== (remoteContents ?? "");
  }, [draft, remoteContents]);

  const saveContents = async (contents: string, created: boolean) => {
    setIsSaving(true);
    setProjectFileQueryData(environmentId, cwd, PROJECT_AGENTS_MD_PATH, contents);
    const result = await writeProjectFile({
      environmentId,
      input: {
        cwd,
        relativePath: PROJECT_AGENTS_MD_PATH,
        contents,
      },
    });
    setIsSaving(false);
    if (result._tag === "Success") {
      confirmProjectFileQueryData(environmentId, cwd, PROJECT_AGENTS_MD_PATH, contents);
      setDraft(null);
      fileQuery.refresh();
      toastManager.add({
        type: "success",
        title: created ? "Created AGENTS.md" : "Saved AGENTS.md",
        description: PROJECT_AGENTS_MD_PATH,
      });
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: created ? "Could not create AGENTS.md" : "Could not save AGENTS.md",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    return false;
  };

  return (
    <SettingsSection
      id={PROJECT_AGENTS_MD_SETTINGS_HASH}
      title="Agent prompt"
      headerAction={
        missing && draft === null ? (
          <Button
            size="xs"
            variant="outline"
            disabled={isSaving || fileQuery.isPending}
            onClick={() => {
              setDraft(buildDefaultProjectAgentsMd(projectName));
            }}
          >
            Create prompt
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={isSaving || fileQuery.isPending || !dirty}
            onClick={() => {
              void saveContents(displayValue, missing && remoteContents === null);
            }}
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        )
      }
    >
      <div className="space-y-3 px-3 pb-4 sm:px-4">
        <p className="text-pretty text-sm text-muted-foreground">
          Full <span className="font-mono">AGENTS.md</span> at the project root. Coding agents load
          this as the standing prompt for this checkout.
        </p>
        {fileQuery.isPending && draft === null ? (
          <p className="text-sm text-muted-foreground">Loading AGENTS.md…</p>
        ) : missing && draft === null ? (
          <p className="text-sm text-muted-foreground">
            No AGENTS.md in this checkout yet. Create a prompt to give agents standing instructions
            for this project.
          </p>
        ) : (
          <Textarea
            aria-label="AGENTS.md"
            className="min-h-72 font-mono text-sm"
            value={displayValue}
            disabled={isSaving}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
          />
        )}
      </div>
    </SettingsSection>
  );
}
