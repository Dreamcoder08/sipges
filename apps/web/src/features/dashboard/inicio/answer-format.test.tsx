import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AnalystAnswer } from './AnalystAnswer.tsx';

/*
 * The answer's safe formatter (odd/tasks/chat-first-ui.md T8): paragraphs, bold, bullet and
 * numbered lists and [n] citations, built from React elements and text only. Anything else the
 * model writes stays literal text, and nothing executable or link-like is ever produced.
 */

const SOURCES = [
  { n: 1, module: 'eventos', id: 'EV-1', title: 'Corte de vía' },
  { n: 2, module: 'actores', id: 'A-7', title: 'Comunidad' },
];

/** The answer's text, outside its sources and blocks. */
const show = (answer: string) => {
  render(
    <AnalystAnswer
      question="¿Qué pasa?"
      data={{ answer, sources: SOURCES }}
      onSearch={() => undefined}
    />,
  );
  const region = screen.getByRole('region', { name: 'Respuesta del analista' });
  const text = region.querySelector('[data-answer-text]');
  if (!(text instanceof HTMLElement)) throw new Error('no answer text');
  return text;
};

/** Every element the formatter may produce, and nothing else. */
const ALLOWED = new Set(['P', 'STRONG', 'UL', 'OL', 'LI', 'A', 'SPAN']);

const assertInert = (text: HTMLElement) => {
  for (const element of text.querySelectorAll('*')) {
    expect(ALLOWED.has(element.tagName), element.tagName).toBe(true);
    for (const attribute of element.getAttributeNames()) {
      expect(attribute.startsWith('on'), attribute).toBe(false);
      expect(['src', 'srcset', 'style', 'formaction', 'action'], attribute).not.toContain(
        attribute,
      );
    }
  }
  // The only links are citations to this answer's own sources.
  for (const link of text.querySelectorAll('a')) {
    expect(link.getAttribute('href')).toMatch(/^#[^:]*fuente-\d+$/);
    expect(link.textContent).toMatch(/^\[\d+\]$/);
  }
};

it('splits paragraphs on a blank line and keeps a single line break inside one', () => {
  const text = show('Primer párrafo [1].\nsigue aquí.\n\nSegundo párrafo.');
  const paragraphs = text.querySelectorAll(':scope > p');
  expect([...paragraphs].map((p) => p.textContent)).toEqual([
    'Primer párrafo [1].\nsigue aquí.',
    'Segundo párrafo.',
  ]);
  expect(
    within(paragraphs[0] as HTMLElement).getByRole('link', { name: 'Fuente 1: Corte de vía' }),
  ).toBeTruthy();
});

it('makes **text** bold, with citations inside it still linked', () => {
  const text = show('El corte es **grave [1]** hoy.');
  const bold = text.querySelector('strong');
  expect(bold?.textContent).toBe('grave [1]');
  expect(
    within(bold as HTMLElement).getByRole('link', { name: 'Fuente 1: Corte de vía' }),
  ).toBeTruthy();
  expect(text.textContent).toBe('El corte es grave [1] hoy.');
});

it('draws «- » and «* » lines as a bullet list', () => {
  const text = show('Pendientes:\n- Mesa de diálogo [2]\n* Canal de riego');
  expect(text.querySelector('p')?.textContent).toBe('Pendientes:');
  const list = within(text).getByRole('list');
  expect(list.tagName).toBe('UL');
  expect(
    within(list)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['Mesa de diálogo [2]', 'Canal de riego']);
  expect(within(list).getByRole('link', { name: 'Fuente 2: Comunidad' })).toBeTruthy();
});

it('draws «1. » lines as a numbered list that keeps its first number', () => {
  const text = show('1. Primero **ya**\n2. Segundo\n\n3. Tercero');
  const lists = within(text).getAllByRole('list');
  expect(lists.map((list) => list.tagName)).toEqual(['OL', 'OL']);
  expect(lists[0]?.hasAttribute('start')).toBe(false);
  expect(lists[1]?.getAttribute('start')).toBe('3');
  expect(
    within(lists[0] as HTMLElement)
      .getAllByRole('listitem')[0]
      ?.querySelector('strong'),
  ).toHaveTextContent('ya');
});

it('leaves unknown markup as literal text: headings, links, code, images', () => {
  const answer =
    '# Título\n[enlace](https://example.test) `code` ![img](x.png) <b>negrita</b> _cursiva_';
  const text = show(answer);
  expect(text.textContent).toBe(answer);
  expect(text.querySelector('h1, b, em, code, img')).toBeNull();
  expect(text.querySelectorAll('a')).toHaveLength(0);
});

it('keeps a [n] that no source resolves as text', () => {
  const text = show('Dato sin fuente [9].');
  expect(text.textContent).toBe('Dato sin fuente [9].');
  expect(text.querySelectorAll('a')).toHaveLength(0);
});

it('renders hostile HTML as text and produces nothing executable', () => {
  const answer = [
    '<script>window.__pwned = true</script>',
    '<img src=x onerror="window.__pwned = true">',
    '<a href="javascript:alert(1)">clic</a> [x](javascript:alert(1)) javascript:alert(1)',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe> <svg onload=alert(1)>',
    '- <style>body{display:none}</style>',
    '1. **<img src=x onerror=alert(1)>** [1]',
  ].join('\n\n');
  const text = show(answer);
  assertInert(text);
  expect(text.querySelector('script, img, iframe, svg, style')).toBeNull();
  expect(text.textContent).toContain('<script>window.__pwned = true</script>');
  expect(text.textContent).toContain('<img src=x onerror="window.__pwned = true">');
  // Serialised, the markup holds those tags only as escaped text.
  expect(new XMLSerializer().serializeToString(text)).not.toMatch(/<(script|img|iframe|svg|style)/);
  expect((window as { __pwned?: boolean }).__pwned).toBeUndefined();
  // The one link is the citation.
  expect(text.querySelectorAll('a')).toHaveLength(1);
});

it('leaves nested or unclosed ** as text without breaking the answer', () => {
  const text = show('**a **b** c\n\nabierto ** sin cerrar\n\n****\n\n**[1]');
  assertInert(text);
  expect(text.textContent).toBe('a b** c' + 'abierto ** sin cerrar' + '****' + '**[1]');
  expect([...text.querySelectorAll('strong')].map((s) => s.textContent)).toEqual(['a ']);
});

it('handles very long lines and long runs of markers in linear time', () => {
  const long = `${'palabra '.repeat(20_000)}${'*'.repeat(50_001)}${'- '.repeat(10_000)}[1]`;
  const started = performance.now();
  const text = show(long);
  expect(performance.now() - started).toBeLessThan(1_000);
  assertInert(text);
  expect(text.textContent?.length).toBeGreaterThan(100_000);
});
