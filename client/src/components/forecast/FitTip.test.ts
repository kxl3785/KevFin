import { describe, it, expect } from 'vitest';
import { fitTipPlacement } from './FitTip.tsx';

// AU-5: a tip at the right end of a phone-width tile must not run off the screen.
describe('fitTipPlacement', () => {
  it('slides a tooltip left when a centred one would leave a 375 px screen', () => {
    // Button 310–325 (the right-hand tile's tip on a phone), 260 px tooltip:
    // centred would span 187.5–447.5; kept inside, it spans 107–367.
    const p = fitTipPlacement(310, 15, 260, 375);
    expect(p.width).toBe(260);
    expect(310 + p.left).toBe(107);
    expect(310 + p.left + p.width).toBe(367);
  });
  it('slides right near the left edge', () => {
    const p = fitTipPlacement(20, 15, 260, 375);
    expect(20 + p.left).toBe(8);
  });
  it('stays centred when there is room', () => {
    const p = fitTipPlacement(500, 15, 260, 1200);
    expect(500 + p.left).toBe(507.5 - 130);
  });
  it('never wider than the screen less the margins', () => {
    const p = fitTipPlacement(100, 15, 300, 250);
    expect(p.width).toBe(234);
    expect(100 + p.left).toBe(8);
  });
});
