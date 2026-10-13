import { Card } from '../../shared/ui/Card.tsx';

/** Placeholder for a screen whose rebuild lands in a later T11 step. */
export const PendingScreen = ({ title }: { title: string }) => (
  <Card eyebrow="En migración" title={title}>
    <p>
      Esta pantalla se está reconstruyendo sobre la nueva API. Sus datos siguen disponibles y
      protegidos en el servidor.
    </p>
  </Card>
);
