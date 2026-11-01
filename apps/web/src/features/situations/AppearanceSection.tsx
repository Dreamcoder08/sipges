import { THEME_OPTIONS, setTheme, useThemePreference } from '../../shared/lib/theme.ts';
import { Card } from '../../shared/ui/Card.tsx';
import { SegmentedControl } from '../../shared/ui/SegmentedControl.tsx';
import styles from './AppearanceSection.module.css';

/**
 * Theme choice at the top of Configuración (docs/adr/0018). It is a per-device preference, so
 * unlike the project settings below it is open to every role.
 */
export const AppearanceSection = () => {
  const theme = useThemePreference();
  return (
    <Card eyebrow="Dispositivo" title="Apariencia">
      <p className={styles.note}>
        «Sistema» sigue el modo claro u oscuro de su dispositivo. La elección se guarda solo en este
        dispositivo y no cambia lo que ven otras personas.
      </p>
      <SegmentedControl legend="Tema" options={THEME_OPTIONS} value={theme} onChange={setTheme} />
    </Card>
  );
};
