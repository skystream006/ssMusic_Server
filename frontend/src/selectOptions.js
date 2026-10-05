const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortSelectOptions(options, getLabel = (option) => option.label) {
  return [...(options ?? [])].sort((left, right) => collator.compare(getLabel(left) ?? '', getLabel(right) ?? ''));
}