import { Link } from '@tanstack/react-router';
import { NotFoundNotice } from '../shared/ui/NotFoundNotice.tsx';
import { HOME_PATH } from './navigation.ts';
import styles from './NotFoundPage.module.css';

/** An address no route answers (functional-10 T6, F17): an h1 and a way back to Inicio. */
export const NotFoundPage = () => (
  <main id="contenido" className={styles.page}>
    <NotFoundNotice
      level={1}
      title="Página no encontrada"
      action={<Link to={HOME_PATH}>Volver al inicio</Link>}
    >
      La dirección no corresponde a ninguna pantalla de SIPGES. Revise el enlace o vuelva al inicio.
    </NotFoundNotice>
  </main>
);
