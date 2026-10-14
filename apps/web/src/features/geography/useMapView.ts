import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Extent } from './BaseMap.tsx';
import type { LonLat } from './sechura-base.ts';

/** A drag shorter than this (px) is still a tap, so markers and concessions stay selectable. */
const TAP_SLOP = 6;
/** Arrow keys move the view by this fraction of its width. */
const KEY_STEP = 1 / 8;

type State = { center: LonLat | null; zoom: number };

/**
 * View state of a geographic map: a square view of `homeSpan / zoom` degrees around a centre
 * (`null` follows `home`). `bind` attaches drag to pan, pinch and Ctrl + wheel (also trackpad
 * pinch) to zoom around the fingers or cursor, and arrow and +/− keys, to the element that
 * holds the map. A drag never fires the click it started with.
 */
export const useMapView = ({
  home,
  homeSpan,
  maxZoom,
}: {
  home: LonLat;
  homeSpan: number;
  maxZoom: number;
}) => {
  const [state, setState] = useState<State>({ center: null, zoom: 1 });
  const latest = useRef({ home, homeSpan, maxZoom });

  const center = state.center ?? home;
  const span = homeSpan / state.zoom;
  const view: Extent = [
    center[0] - span / 2,
    center[1] - span / 2,
    center[0] + span / 2,
    center[1] + span / 2,
  ];

  const clamp = (zoom: number) => Math.min(Math.max(zoom, 1), latest.current.maxZoom);
  /** Zooms by `factor`, keeping `anchor` (default: the centre) at the same place on screen. */
  const zoomBy = useCallback((factor: number, anchor?: LonLat) => {
    setState((s) => {
      const zoom = clamp(s.zoom * factor);
      const c = s.center ?? latest.current.home;
      if (!anchor || zoom === s.zoom) return { center: s.center, zoom };
      const k = s.zoom / zoom;
      return {
        zoom,
        center: [anchor[0] + (c[0] - anchor[0]) * k, anchor[1] + (c[1] - anchor[1]) * k],
      };
    });
  }, []);
  const panBy = useCallback((dLon: number, dLat: number) => {
    setState((s) => {
      const c = s.center ?? latest.current.home;
      return { zoom: s.zoom, center: [c[0] + dLon, c[1] + dLat] };
    });
  }, []);
  const reset = useCallback(() => setState({ center: null, zoom: 1 }), []);
  /** Centres on a place; `zoom` is absolute, or kept when omitted. */
  const focus = useCallback((at: LonLat | null, zoom?: number) => {
    setState((s) => ({ center: at, zoom: clamp(zoom ?? s.zoom) }));
  }, []);

  // Gesture bookkeeping lives in refs: pointer moves arrive faster than renders.
  const node = useRef<HTMLDivElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: 0, dragged: false, suppressClick: false });
  const metrics = useRef({ span, center });
  // Handlers read the latest values between renders.
  useLayoutEffect(() => {
    latest.current = { home, homeSpan, maxZoom };
    metrics.current = { span, center };
  });

  /** Screen position to lon/lat (the SVG keeps a square view centred in its box). */
  const toLonLat = useCallback((x: number, y: number): LonLat | undefined => {
    const svg = node.current?.querySelector('svg[role="group"]');
    if (!svg) return undefined;
    const box = svg.getBoundingClientRect();
    const size = Math.min(box.width, box.height) || 1;
    const perPixel = metrics.current.span / size;
    const [cx, cy] = metrics.current.center;
    return [
      cx + (x - (box.left + box.width / 2)) * perPixel,
      cy - (y - (box.top + box.height / 2)) * perPixel,
    ];
  }, []);
  const degreesPerPixel = () => {
    const svg = node.current?.querySelector('svg[role="group"]');
    const box = svg?.getBoundingClientRect();
    return metrics.current.span / (Math.min(box?.width ?? 0, box?.height ?? 0) || 1);
  };

  // Ctrl + wheel (and trackpad pinch, which arrives as one) zooms; a plain wheel scrolls the
  // page. React wheel listeners are passive, so this one is attached by hand.
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(Math.exp(-event.deltaY * 0.004), toLonLat(event.clientX, event.clientY));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomBy, toLonLat]);

  const bind = {
    ref: node,
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if ((event.target as Element).closest('button, a, input, select')) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 1)
        gesture.current = { moved: 0, dragged: false, suppressClick: false };
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const previous = pointers.current.get(event.pointerId);
      if (!previous) return;
      const others = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId);
      const next = { x: event.clientX, y: event.clientY };
      if (others.length === 1) {
        // Pinch: scale by the change in finger distance around the old midpoint, then
        // follow the midpoint.
        const [, other] = others[0] as [number, { x: number; y: number }];
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(next.x - other.x, next.y - other.y);
        const mid = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
        const newMid = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };
        const perPixel = degreesPerPixel();
        if (before > 0) zoomBy(after / before, toLonLat(mid.x, mid.y));
        panBy(-(newMid.x - mid.x) * perPixel, (newMid.y - mid.y) * perPixel);
        gesture.current.dragged = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } else if (others.length === 0) {
        gesture.current.moved += Math.hypot(next.x - previous.x, next.y - previous.y);
        if (!gesture.current.dragged && gesture.current.moved > TAP_SLOP) {
          gesture.current.dragged = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
        if (gesture.current.dragged) {
          const perPixel = degreesPerPixel();
          panBy(-(next.x - previous.x) * perPixel, (next.y - previous.y) * perPixel);
        }
      }
      pointers.current.set(event.pointerId, next);
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
      if (gesture.current.dragged) gesture.current.suppressClick = true;
    },
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
    },
    // Map tiles are images; a native image drag would cancel the pointer and stop the pan.
    onDragStart: (event: React.DragEvent<HTMLDivElement>) => event.preventDefault(),
    onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
      if (!gesture.current.suppressClick) return;
      gesture.current.suppressClick = false;
      event.stopPropagation();
      event.preventDefault();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.target as Element).closest('button, a, input, select')) return;
      const step = metrics.current.span * KEY_STEP;
      const moves: Record<string, () => void> = {
        ArrowLeft: () => panBy(-step, 0),
        ArrowRight: () => panBy(step, 0),
        ArrowUp: () => panBy(0, step),
        ArrowDown: () => panBy(0, -step),
        '+': () => zoomBy(2),
        '=': () => zoomBy(2),
        '-': () => zoomBy(0.5),
        '0': reset,
      };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      move();
    },
  };

  return { view, span, zoom: state.zoom, maxZoom, zoomBy, panBy, reset, focus, bind };
};
