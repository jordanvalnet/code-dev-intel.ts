// Fixture for findSymbol exact-vs-fuzzy preference: `kiliWidget` is a strict prefix of
// `kiliWidgetFactory`, so getNavigateToItems('kiliWidget') fuzzily returns both.
export function kiliWidget(): number {
  return 1;
}

export function kiliWidgetFactory(): number {
  return kiliWidget();
}
