import { fuzzyMatch } from '@shared/fuzzy';
import type { QuickItem } from './quick-input-controller';

/** A description match ranks below any label match. */
const DESCRIPTION_PENALTY = 1000;

/**
 * Filter and rank pick items by fuzzy match on the label, then the description. With an empty
 * query the items are returned as they were given. Items keep their group order: when items
 * carry group headings, ranking happens inside each group.
 */
export function filterPickItems(items: readonly QuickItem[], query: string): QuickItem[] {
  const q = query.trim();
  if (q === '') return [...items];

  const groupOrder = new Map<string, number>();
  const scored: { item: QuickItem; score: number; index: number; group: number }[] = [];

  items.forEach((item, index) => {
    const groupKey = item.group ?? '';
    if (!groupOrder.has(groupKey)) groupOrder.set(groupKey, groupOrder.size);
    const group = groupOrder.get(groupKey) as number;

    const onLabel = fuzzyMatch(q, item.label);
    if (onLabel) {
      scored.push({
        item: { ...item, highlights: onLabel.positions },
        score: onLabel.score,
        index,
        group,
      });
      return;
    }
    const onDescription = item.description ? fuzzyMatch(q, item.description) : null;
    if (onDescription) {
      scored.push({
        item: { ...item, highlights: undefined, descriptionHighlights: onDescription.positions },
        score: onDescription.score - DESCRIPTION_PENALTY,
        index,
        group,
      });
    }
  });

  scored.sort((a, b) => a.group - b.group || b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}
