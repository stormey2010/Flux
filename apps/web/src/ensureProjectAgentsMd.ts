import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "./rpc/atomRegistry";
import {
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  getProjectFileQueryAtom,
  setProjectFileQueryData,
} from "./components/files/projectFilesQueryState";
import { buildDefaultProjectAgentsMd, PROJECT_AGENTS_MD_PATH } from "./projectAgentsMd";

type WriteProjectFile = (input: {
  environmentId: EnvironmentId;
  input: {
    cwd: string;
    relativePath: string;
    contents: string;
  };
}) => Promise<AtomCommandResult<{ relativePath: string }>>;

export type EnsureProjectAgentsMdResult =
  | { readonly status: "created" | "already-exists" }
  | { readonly status: "failure"; readonly error: unknown };

/**
 * Creates AGENTS.md with a starter template when missing; leaves an existing
 * file untouched.
 */
export async function ensureProjectAgentsMd(input: {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  writeFile: WriteProjectFile;
}): Promise<EnsureProjectAgentsMdResult> {
  const existingOptimistic = getOptimisticProjectFileQueryData(
    input.environmentId,
    input.cwd,
    PROJECT_AGENTS_MD_PATH,
  );
  if (existingOptimistic) {
    return { status: "already-exists" };
  }

  const readResult = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(input.environmentId, input.cwd, PROJECT_AGENTS_MD_PATH),
    { reportDefect: false, reportFailure: false },
  );
  if (readResult._tag === "Success") {
    return { status: "already-exists" };
  }
  if (isAtomCommandInterrupted(readResult)) {
    return { status: "failure", error: squashAtomCommandFailure(readResult) };
  }

  const contents = buildDefaultProjectAgentsMd(input.projectName);
  setProjectFileQueryData(input.environmentId, input.cwd, PROJECT_AGENTS_MD_PATH, contents);
  const writeResult = await input.writeFile({
    environmentId: input.environmentId,
    input: {
      cwd: input.cwd,
      relativePath: PROJECT_AGENTS_MD_PATH,
      contents,
    },
  });
  if (writeResult._tag === "Success") {
    confirmProjectFileQueryData(input.environmentId, input.cwd, PROJECT_AGENTS_MD_PATH, contents);
    return { status: "created" };
  }
  return { status: "failure", error: squashAtomCommandFailure(writeResult) };
}
