// What jsdom lacks and Radix needs to mount: without these a rendered Slider or Switch throws
// before the test can press anything.

class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Call it once per test file that renders components, before the first render. */
export function installDomStubs(): void {
  globalThis.ResizeObserver ??= NoopResizeObserver;
  // Radix measures the slider's track to turn a click into a value; jsdom reports every box as 0.
  Element.prototype.getBoundingClientRect ??= function rect(this: Element): DOMRect {
    return new DOMRect(0, 0, 100, 10);
  };
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
}
