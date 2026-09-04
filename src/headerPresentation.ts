export function hasVisibleDirectViewHeader(
  containerEl: HTMLElement,
  resolveStyle: (element: Element) => Pick<CSSStyleDeclaration, 'display'> = getComputedStyle,
): boolean {
  const header = containerEl.querySelector<HTMLElement>(':scope > .view-header');
  return Boolean(header && resolveStyle(header).display !== 'none');
}
