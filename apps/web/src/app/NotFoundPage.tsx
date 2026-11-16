import { Link } from '@tanstack/react-router';
import { NotFoundNotice } from '../shared/ui/NotFoundNotice.tsx';
import { HOME_PATH } from './navigation.ts';
import styles from './NotFoundPage.module.css';

export const MISSING_PAGE_TITLE = 'Página no encontrada';

/**
 * An address no route answers (functional-10 T6, F17): a heading and a way back to Inicio.
 * Signed in it sits inside the app shell, whose h1 already names the page, so the notice heading
 * is an h2 (T13, F31); on its own it is the page's h1 and main region.
 */
export const NotFoundPage = ({ inShell = false }: { inShell?: boolean }) => {
  const notice = (
    <NotFoundNotice
      level={inShell ? 2 : 1}
      title={MISSING_PAGE_TITLE}
      action={<Link to={HOME_PATH}>Volver al inicio</Link>}
    >
      La dirección no corresponde a ninguna pantalla de SIPGES. Revise el enlace o vuelva al inicio.
    </NotFoundNotice>
  );
  return inShell ? (
    <div className={styles.page}>{notice}</div>
  ) : (
    <main id="contenido" className={styles.page}>
      {notice}
    </main>
  );
};
