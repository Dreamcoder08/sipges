import type { Role } from '@sipges/contracts';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { InternalLink } from '../../../shared/lib/navigation.tsx';
import { Icon } from '../../../shared/ui/Icon.tsx';
import { accountsQuery, recordCountsQuery } from '../api.ts';
import { firstSteps, loadsRecords, managesAccounts } from './first-steps.ts';
import styles from './FirstSteps.module.css';

/** Per person and project: a convenience of this browser, never sent to the server. */
const storageKey = (username: string, scope: string) =>
  `sipges:first-steps-hidden:${username}:${scope}`;

const storedHidden = (key: string) => {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

const storeHidden = (key: string) => {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Without storage the list stays hidden until the page reloads.
  }
};

/**
 * Inicio's «Primeros pasos» for a new project (world-class-local T7): only the steps this role
 * can act on and the app can tell are done, with «N de M». It waits for its sources and shows
 * nothing when one fails, rather than guessing. It shows nothing once every step is done, and
 * «Ocultar» keeps it away for this person and project: the only thing it ever stores, because the
 * app keeps nothing in the browser the person did not choose.
 */
export const FirstSteps = ({
  scope,
  username,
  role,
}: {
  scope: string;
  username: string;
  role: Role;
}) => {
  const headingId = useId();
  const key = storageKey(username, scope);
  const [hiddenNow, setHiddenNow] = useState<readonly string[]>([]);
  const hidden = hiddenNow.includes(key) || storedHidden(key);
  const records = useQuery({ ...recordCountsQuery(scope), enabled: !hidden && loadsRecords(role) });
  const accounts = useQuery({ ...accountsQuery(scope), enabled: !hidden && managesAccounts(role) });
  const sources = [
    ...(loadsRecords(role) ? [records] : []),
    ...(managesAccounts(role) ? [accounts] : []),
  ];
  const ready = sources.length > 0 && sources.every((query) => query.isSuccess);
  const steps = ready
    ? firstSteps({ role, username, counts: records.data, accounts: accounts.data })
    : [];
  const done = steps.filter((step) => step.done).length;
  const complete = steps.length > 0 && done === steps.length;

  if (hidden || !steps.length || complete) return null;

  const hide = () => {
    storeHidden(key);
    setHiddenNow((keys) => [...keys, key]);
  };

  return (
    <section className={styles.steps} aria-labelledby={headingId}>
      <div className={styles.head}>
        <h2 id={headingId}>Primeros pasos</h2>
        <span className={styles.count}>{`${done} de ${steps.length}`}</span>
        <progress
          className={styles.progress}
          value={done}
          max={steps.length}
          aria-labelledby={headingId}
        />
        <button type="button" className={styles.hide} onClick={hide}>
          Ocultar
        </button>
      </div>
      <ol className={styles.list}>
        {steps.map((step) => (
          <li key={step.key} className={styles.step} data-done={step.done || undefined}>
            <span className={styles.mark} aria-hidden="true">
              {step.done ? <Icon name="check" /> : null}
            </span>
            <span className="visually-hidden">{step.done ? 'Hecho: ' : 'Pendiente: '}</span>
            <b className={styles.title}>{step.title}</b>
            {step.done ? null : (
              <>
                <span className={styles.line}>{step.line}</span>
                <InternalLink href={step.href} className={styles.action}>
                  {step.action}
                </InternalLink>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};
