import { Component, type ReactNode } from 'react';
import { Alert } from '../../shared/ui/Alert.tsx';

/**
 * A drawing failure leaves a visible explanation and the rest of the page (data tables,
 * provenance) instead of an empty or black area. With `fallback`, that map is drawn instead
 * (the SVG renderer when the WebGL engine fails) and `onError` is told once.
 */
export class MapErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; onError?: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onError?.();
  }
  override render() {
    if (this.state.failed && this.props.fallback) return this.props.fallback;
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
