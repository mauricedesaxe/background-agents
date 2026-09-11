import type { AutomationListItem } from "@open-inspect/shared/types/automations";

/** Label for the bucket holding multi-repository and repository-less automations. */
export const MULTIPLE_REPOSITORIES_GROUP_LABEL = "Multiple repositories";

export interface AutomationsRepositoryGroup {
  label: string;
  automations: AutomationListItem[];
}

function repositoryLabel(automation: AutomationListItem): string | null {
  if (automation.repositories.length !== 1) return null;
  const repository = automation.repositories[0];
  return `${repository.repoOwner}/${repository.repoName}`;
}

/**
 * Group automations by repository for the list view. Single-repository
 * automations land under their `owner/name` heading; multi-repository and
 * repository-less automations share one "Multiple repositories" bucket sorted
 * last. Headings are alphabetical; order within a group preserves the input
 * order the server returned. Pure presentation over the loaded page set — no
 * server re-sort (card 22).
 */
export function groupAutomationsByRepository(
  automations: AutomationListItem[]
): AutomationsRepositoryGroup[] {
  const byLabel = new Map<string, AutomationListItem[]>();
  const shared: AutomationListItem[] = [];

  for (const automation of automations) {
    const label = repositoryLabel(automation);
    if (label === null) {
      shared.push(automation);
      continue;
    }
    const bucket = byLabel.get(label);
    if (bucket) {
      bucket.push(automation);
    } else {
      byLabel.set(label, [automation]);
    }
  }

  const groups: AutomationsRepositoryGroup[] = [...byLabel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, groupAutomations]) => ({ label, automations: groupAutomations }));

  if (shared.length > 0) {
    groups.push({ label: MULTIPLE_REPOSITORIES_GROUP_LABEL, automations: shared });
  }
  return groups;
}
