/**
 * Python's `round(x, digits)`: an exact half goes to the even neighbor. Inputs are scaled by
 * 10^digits first, so values whose binary form is just below a half can differ from Python;
 * callers use it on sums of small integers and halves, where the scaled value is exact.
 */
export const roundHalfEven = (value: number, digits = 0): number => {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const rounded = diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
  return rounded / factor;
};
