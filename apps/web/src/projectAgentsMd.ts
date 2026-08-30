/**
 * Project-root AGENTS.md is the shared agent prompt file coding agents
 * (Codex, Claude Code, Cursor CLI, etc.) load for a workspace.
 */
export const PROJECT_AGENTS_MD_PATH = "AGENTS.md";
export const PROJECT_AGENTS_MD_SETTINGS_HASH = "agents-md";

export function buildDefaultProjectAgentsMd(projectName: string): string {
  const name = projectName.trim() || "this project";
  return `# ${name}

## What this project is

Briefly describe what ${name} does and who it is for.

## How to work here

- Prefer the smallest change that solves the request.
- Match existing patterns in the repo before inventing new ones.
- Do not expand scope beyond what was asked.

## Commands

Document the usual install, test, lint, and run commands for this repo.

\`\`\`bash
# example
pnpm install
pnpm test
\`\`\`

## Do not

- Commit secrets or local env files.
- Rewrite unrelated files while fixing a narrow bug.
`;
}

export function projectAgentsMdSettingsPath(projectKey: string): string {
  return `/projects/${encodeURIComponent(projectKey)}#${PROJECT_AGENTS_MD_SETTINGS_HASH}`;
}
