import { Component, type ReactNode } from 'react';
import { Alert } from '../../shared/ui/Alert.tsx';

/**
 * A drawing failure leaves a visible explanation and the rest of the page (data tables,
 * provenance) instead of an empty or black area.
 */
export class MapErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <Alert tone="error">
        No se pudo dibujar el mapa en este navegador. Las coordenadas y los vértices siguen
        disponibles en las tablas de esta página y en «Exportar coordenadas CSV».
      </Alert>
    ) : (
      this.props.children
    );
  }
}
