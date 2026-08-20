import type { Automation, AutomationRepository } from "@open-inspect/shared/types/automations";

const MULTIPLE_REPOSITORIES_GROUP_KEY = "__multiple__";
export const MULTIPLE_REPOSITORIES_GROUP_LABEL = "Multiple repositories";

export interface AutomationRepositoryGroup {
  key: string;
  label: string;
  automations: Automation[];
}

function repositoryKey(repository: AutomationRepository): string {
  return `${repository.repoOwner}/${repository.repoName}`;
}

/** A repository-less (environment-only) automation shares the "Multiple repositories" bucket with multi-repo ones, despite targeting zero. */
export function groupAutomationsByRepository(
  automations: Automation[]
): AutomationRepositoryGroup[] {
  const singles = new Map<string, Automation[]>();
  const multiple: Automation[] = [];

  for (const automation of automations) {
    if (automation.repositories.length === 1) {
      const key = repositoryKey(automation.repositories[0]);
      const bucket = singles.get(key);
      if (bucket) bucket.push(automation);
      else singles.set(key, [automation]);
    } else {
      multiple.push(automation);
    }
  }

  const groups: AutomationRepositoryGroup[] = [...singles.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => ({ key, label: key, automations: group }));

  if (multiple.length > 0) {
    groups.push({
      key: MULTIPLE_REPOSITORIES_GROUP_KEY,
      label: MULTIPLE_REPOSITORIES_GROUP_LABEL,
      automations: multiple,
    });
  }

  return groups;
}
