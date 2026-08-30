import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { FolderIcon, FolderPlusIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useProjects } from "~/state/entities";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";

interface ProjectContextSelectorProps {
  readonly activeProjectRef: ScopedProjectRef;
  readonly activeProjectTitle: string;
  readonly onProjectChange: (projectRef: ScopedProjectRef) => void;
}

/** The composer project picker intentionally mirrors the sidebar's Add Project action. */
export const ProjectContextSelector = memo(function ProjectContextSelector({
  activeProjectRef,
  activeProjectTitle,
  onProjectChange,
}: ProjectContextSelectorProps) {
  const projects = useProjects();
  const activeProjectKey = scopedProjectKey(activeProjectRef);
  const projectEntries = useMemo(
    () =>
      [...projects]
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((project) => ({
          key: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          ref: scopeProjectRef(project.environmentId, project.id),
          title: project.title,
        })),
    [projects],
  );
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  return (
    <Menu>
      <MenuTrigger
        className="inline-flex h-7 min-w-0 shrink items-center gap-1 rounded-md border border-transparent px-[calc(--spacing(2)-1px)] text-sm font-medium text-secondary-label transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:text-xs"
        aria-label="Choose project"
        data-composer-context-control
      >
        <FolderIcon className="size-3 shrink-0" />
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
          >
            {activeProjectTitle}
          </span>
        </span>
      </MenuTrigger>
      <MenuPopup className="max-h-80 min-w-48 max-w-72 overflow-y-auto">
        <MenuGroup>
          <MenuGroupLabel>Projects</MenuGroupLabel>
          <MenuRadioGroup
            value={activeProjectKey}
            onValueChange={(value) => {
              const project = projectEntries.find((entry) => entry.key === value);
              if (project && project.key !== activeProjectKey) onProjectChange(project.ref);
            }}
          >
            {projectEntries.map((project) => (
              <MenuRadioItem key={project.key} value={project.key} closeOnClick>
                <span className="min-w-0 truncate">{project.title}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          Add project
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
