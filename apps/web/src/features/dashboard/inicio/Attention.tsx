import type { IrsaSummary } from '@sipges/contracts';
import { Fragment, useId } from 'react';
import { formatIndex } from '../../../shared/lib/format.ts';
import { InternalLink } from '../../../shared/lib/navigation.tsx';
import { LevelPill } from '../../../shared/ui/Badges.tsx';
import { EmptyState } from '../../../shared/ui/EmptyState.tsx';
import { QueryState } from '../../../shared/ui/QueryState.tsx';
import { hasNoEvidence } from '../IrsaStatus.tsx';
import type { AttentionItem } from './attention.ts';
import styles from './Attention.module.css';

/** The attention list with its loading and error states, as Inicio assembles it. */
export type AttentionQuery = {
  isPending: boolean;
  error: unknown;
  data: AttentionItem[] | undefined;
  isFetching: boolean;
  refetch: () => unknown;
};

/** At most this many cards in the empty state; the rest wait in Bandeja (T19). */
const MAX_CARDS = 3;
export const LABEL = 'lo que necesita tu atención';

export const calm = (
  <EmptyState icon="check" title="Nada necesita tu atención ahora.">
    Las alertas y decisiones nuevas aparecerán aquí.
  </EmptyState>
);

/** Each item as one link: what it is, a line of context and the next step. */
export const Cards = ({ items }: { items: readonly AttentionItem[] }) => (
  <ul className={styles.cards}>
    {items.map((item) => (
      <li key={item.key}>
        <InternalLink href={item.href} className={styles.card}>
          <b>{item.title}</b>
          <small>
            {item.level ? (
              <span className={styles.level}>
                <LevelPill level={item.level} />
              </span>
            ) : null}
            {item.meta}
          </small>
          <span className={styles.action}>{item.action}</span>
        </InternalLink>
      </li>
    ))}
  </ul>
);

export const Head = ({
  id,
  count,
  more,
}: {
  id: string;
  count?: number | undefined;
  more: boolean;
}) => (
  <div className={styles.head}>
    <h2 id={id}>Necesita tu atención</h2>
    {count ? <span className={styles.muted}>{count}</span> : null}
    <InternalLink href="/bandeja" className={styles.headLink}>
      {more ? 'Ver todo en Bandeja' : 'Abrir Bandeja'}
    </InternalLink>
  </div>
);

/**
 * The empty state's «Necesita tu atención» (direction 01): at most three compact cards just above
 * the composer, each one link as a whole, and «Ver todo en Bandeja» when there are more.
 */
export const AttentionCards = ({ query }: { query: AttentionQuery }) => {
  const id = useId();
  const count = query.data?.length;
  return (
    <section className={styles.attention} aria-labelledby={id}>
      <Head id={id} count={count} more={(count ?? 0) > MAX_CARDS} />
      <QueryState query={query} label={LABEL}>
        {(items) => (items.length ? <Cards items={items.slice(0, MAX_CARDS)} /> : calm)}
      </QueryState>
    </section>
  );
};

/**
 * «Esta semana» as one line of links (direction 01): the week's events, the current IRSA and the
 * conflict risk by locality. A link whose source has not loaded is left out, never invented.
 */
export const WeekLine = ({
  events,
  irsa,
}: {
  events: number | undefined;
  irsa: IrsaSummary | undefined;
}) => {
  const id = useId();
  const links: (readonly [href: string, text: string])[] = [];
  if (events !== undefined)
    links.push(['/registros', `${events} ${events === 1 ? 'evento' : 'eventos'}`]);
  if (irsa)
    links.push([
      '/analisis',
      hasNoEvidence(irsa)
        ? 'IRSA sin datos suficientes'
        : `IRSA ${formatIndex(irsa.irsa)} · ${irsa.level}`,
    ]);
  links.push(['/analisis?vista=riesgo', 'Riesgo por localidad']);
  return (
    <section className={styles.week} aria-labelledby={id}>
      <p>
        <span id={id}>Esta semana</span>:{' '}
        {/* Links straight in the sentence: a link wrapped alone would read as a standalone
            control, which a phone must make 44 px tall (WCAG 2.5.5 exempts links in a line of text). */}
        {links.map(([href, text], index) => (
          <Fragment key={href}>
            {index ? <span aria-hidden="true"> · </span> : null}
            <InternalLink href={href}>{text}</InternalLink>
          </Fragment>
        ))}
      </p>
    </section>
  );
};
