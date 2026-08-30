import { describe, expect, it } from "vitest";

import { buildDefaultProjectAgentsMd, PROJECT_AGENTS_MD_PATH } from "./projectAgentsMd";

describe("projectAgentsMd", () => {
  it("uses a stable project-root path", () => {
    expect(PROJECT_AGENTS_MD_PATH).toBe("AGENTS.md");
  });

  it("builds a named starter prompt", () => {
    const contents = buildDefaultProjectAgentsMd("Acme App");
    expect(contents).toContain("# Acme App");
    expect(contents).toContain("## How to work here");
    expect(contents).toContain("## Do not");
  });
});
