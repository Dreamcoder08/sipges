import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { initialValues } from './model.ts';
import { MODULES, type RecordModule } from './modules.ts';
import { RecordEditor } from './RecordEditor.tsx';

/**
 * In-page form errors (odd/archive/functional-10.md T7, F22): a failed save marks each invalid
 * field with aria-invalid, ties a message to it with aria-describedby, lists the errors in a
 * summary above the fields and moves focus to the first invalid field. The native constraints
 * (`required`, `min`, `max`) stay on the fields and decide what is invalid.
 */
const open = (module: RecordModule, onSave = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RecordEditor
        module={module}
        scope="A/B"
        pending={false}
        error={null}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return onSave;
};
const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Guardar registro' }));
const summary = () => screen.getByRole('group', { name: /^No se pudo guardar/ });

/** Required fields that a new record leaves empty, in form order. */
const emptyRequired = (module: RecordModule) => {
  const values = initialValues(module);
  return MODULES[module].fields.filter((field) => field.required && !values[field.key]);
};
const modules = (Object.keys(MODULES) as RecordModule[]).filter(
  (module) => emptyRequired(module).length > 0,
);

describe('RecordEditor form errors', () => {
  it.each(modules)(
    '%s: an empty save flags every required field in the page and focuses the first',
    async (module) => {
      const onSave = open(module);
      const user = userEvent.setup();
      await save(user);
      expect(onSave).not.toHaveBeenCalled();
      const invalid = emptyRequired(module);
      for (const field of invalid) {
        const control = screen.getByLabelText(field.label);
        expect(control).toBeRequired();
        expect(control).toHaveAttribute('aria-invalid', 'true');
        expect(control).toHaveAccessibleDescription('Completa este campo.');
      }
      for (const field of MODULES[module].fields.filter((item) => !invalid.includes(item)))
        expect(screen.getByLabelText(field.label)).toHaveAttribute('aria-invalid', 'false');
      const box = summary();
      expect(box).toHaveAccessibleName(
        `No se pudo guardar: revisa ${invalid.length} ${invalid.length === 1 ? 'campo' : 'campos'}.`,
      );
      expect(
        within(box)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(invalid.map((field) => `${field.label}: Completa este campo.`));
      // The summary sits above the fields, so it is read before them.
      const first = screen.getByLabelText(invalid[0]?.label ?? '');
      expect(box.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(first).toHaveFocus();
    },
  );

  it('explains a number out of range and clears an error once the field is fixed', async () => {
    const onSave = open('compromisos');
    const user = userEvent.setup();
    const progress = screen.getByLabelText('Avance (%)');
    await user.clear(progress);
    await user.type(progress, '150');
    await save(user);
    expect(onSave).not.toHaveBeenCalled();
    expect(progress).toHaveAttribute('aria-invalid', 'true');
    expect(progress).toHaveAccessibleDescription('Debe ser 100 o menos.');
    await user.clear(progress);
    await user.type(progress, '40');
    expect(progress).toHaveAttribute('aria-invalid', 'false');
    expect(progress).not.toHaveAccessibleDescription('Debe ser 100 o menos.');
    expect(
      within(summary())
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).not.toContain('Avance (%): Debe ser 100 o menos.');
  });

  it('moves focus to a field from its summary link', async () => {
    open('buzon');
    const user = userEvent.setup();
    await save(user);
    const [, second] = emptyRequired('buzon');
    await user.click(
      within(summary()).getByRole('link', { name: new RegExp(`^${second?.label}`) }),
    );
    expect(screen.getByLabelText(second?.label ?? '')).toHaveFocus();
  });

  it('saves a valid form without a summary or flagged field', async () => {
    const onSave = open('eventos');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Descripción del hecho'), 'Reunión sintética');
    await save(user);
    expect(onSave).toHaveBeenCalledOnce();
    expect(screen.queryByRole('group', { name: /^No se pudo guardar/ })).toBeNull();
    expect(screen.getByLabelText('Descripción del hecho')).toHaveAttribute('aria-invalid', 'false');
  });
});
