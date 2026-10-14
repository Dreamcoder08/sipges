import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useReveal } from './reveal.ts';

const Panel = ({ selected }: { selected: string }) => {
  const heading = useReveal(selected);
  return selected ? (
    <h4 ref={heading} tabIndex={-1}>
      Detalle {selected}
    </h4>
  ) : (
    <p>Sin selección</p>
  );
};

describe('useReveal', () => {
  it('focuses and scrolls to the panel each time a new item is selected', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { rerender } = render(<Panel selected="" />);
    expect(scroll).not.toHaveBeenCalled();
    rerender(<Panel selected="A-1" />);
    expect(screen.getByRole('heading', { name: 'Detalle A-1' })).toHaveFocus();
    rerender(<Panel selected="A-2" />);
    expect(screen.getByRole('heading', { name: 'Detalle A-2' })).toHaveFocus();
    expect(scroll).toHaveBeenCalledTimes(2);
  });
});
