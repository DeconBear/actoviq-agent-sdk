export interface TuiSelectionItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
}

export function filterTuiSelectionItems(
  items: readonly TuiSelectionItem[],
  query: string,
): TuiSelectionItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [...items];
  }
  return items.filter(item =>
    [item.id, item.label, item.description, item.detail]
      .filter((value): value is string => typeof value === 'string')
      .some(value => value.toLowerCase().includes(normalized)),
  );
}

export function moveTuiSelection(
  selected: number,
  itemCount: number,
  delta: number,
): number {
  if (itemCount <= 0) {
    return 0;
  }
  return (selected + delta + itemCount) % itemCount;
}
