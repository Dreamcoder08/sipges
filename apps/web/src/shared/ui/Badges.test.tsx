import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './Badges.tsx';

/** One status family (closure-roadmap T31): a shape plus the word, never colour alone. */
describe('StatusBadge', () => {
  it('reads as its word and carries the tone that picks colour and shape', () => {
    render(<StatusBadge tone="positive">Validado</StatusBadge>);
    const badge = screen.getByText('Validado');
    expect(badge).toHaveAttribute('data-tone', 'positive');
    // The shape is drawn by CSS, so the word is the whole text a reader hears.
    expect(badge.textContent).toBe('Validado');
  });

  it('defaults to the neutral tone', () => {
    render(<StatusBadge>Preliminar</StatusBadge>);
    expect(screen.getByText('Preliminar')).toHaveAttribute('data-tone', 'neutral');
  });
});
