/**
 * Buttons that drive the twin keep focus off themselves on mouse clicks, so
 * Space afterwards still plays or pauses instead of re-firing the button
 * (Run again, Swap); Tab focus and keyboard activation are unaffected. Put on
 * the button's wrapper's onMouseDown, never on a row that holds text inputs,
 * since preventDefault on mousedown would also stop them taking the caret.
 */
export function keepFocus(e: { preventDefault(): void }): void {
  e.preventDefault();
}
