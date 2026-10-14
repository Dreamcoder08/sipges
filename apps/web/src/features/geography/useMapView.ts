import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type Extent, svgX, svgY } from './BaseMap.tsx';
import type { LonLat } from './sechura-base.ts';

/** A drag shorter than this (px) is still a tap, so markers and concessions stay selectable. */
const TAP_SLOP = 6;
/** Arrow keys move the view by this fraction of its width. */
const KEY_STEP = 1 / 8;
/** A Ctrl + wheel (or trackpad pinch) gesture ends after this long without events (ms). */
export const WHEEL_SETTLE_MS = 180;

type State = { center: LonLat | null; zoom: number };
type View = { center: LonLat; zoom: number };

/**
 * SVG transform that shows content drawn for `drawn` as it looks in `target`: the target
 * centre lands on the drawn centre and distances scale by the zoom ratio.
 */
export const gestureTransform = (drawn: View, target: View) =>
  `translate(${svgX(drawn.center[0])} ${svgY(drawn.center[1])}) scale(${target.zoom / drawn.zoom}) translate(${-svgX(target.center[0])} ${-svgY(target.center[1])})`;

/**
 * View state of a geographic map: a square view of `homeSpan / zoom` degrees around a centre
 * (`null` follows `home`). `bind` attaches drag to pan, pinch and Ctrl + wheel (also trackpad
 * pinch) to zoom around the fingers or cursor, and arrow and +/− keys, to the element that
 * holds the map. A drag never fires the click it started with.
 *
 * While a finger, mouse or wheel gesture runs, the view lives in a ref and only a transform on
 * the map's `[data-map-content]` group changes, once per animation frame; React renders the
 * page once, when the gesture ends. Re-rendering markers, tiles and the rest of the page on
 * every pointer move made dragging and pinching stutter.
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
  /** `view` zoomed by `factor`, keeping `anchor` (default: the centre) in place on screen. */
  const zoomed = (view: View, factor: number, anchor?: LonLat): View => {
    const zoom = clamp(view.zoom * factor);
    if (!anchor || zoom === view.zoom) return { center: view.center, zoom };
    const k = view.zoom / zoom;
    return {
      zoom,
      center: [
        anchor[0] + (view.center[0] - anchor[0]) * k,
        anchor[1] + (view.center[1] - anchor[1]) * k,
      ],
    };
  };
  const panned = (view: View, dLon: number, dLat: number): View => ({
    zoom: view.zoom,
    center: [view.center[0] + dLon, view.center[1] + dLat],
  });
  const resolved = (s: State): View => ({ center: s.center ?? latest.current.home, zoom: s.zoom });

  /** Zooms by `factor`, keeping `anchor` (default: the centre) at the same place on screen. */
  const zoomBy = useCallback((factor: number, anchor?: LonLat) => {
    setState((s) =>
      anchor
        ? zoomed(resolved(s), factor, anchor)
        : { center: s.center, zoom: clamp(s.zoom * factor) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const panBy = useCallback((dLon: number, dLat: number) => {
    setState((s) => panned(resolved(s), dLon, dLat));
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
  /** The view as drawn by the last render. */
  const drawn = useRef<View>({ center, zoom: state.zoom });
  /** The view during a gesture, ahead of the drawn one; `null` when no gesture runs. */
  const live = useRef<View | null>(null);
  const frame = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Handlers read the latest values between renders.
  useLayoutEffect(() => {
    latest.current = { home, homeSpan, maxZoom };
    drawn.current = { center, zoom: state.zoom };
  });
  const content = () => node.current?.querySelector('svg[role="group"] [data-map-content]');
  // A render draws the committed view itself: drop the gesture transform in the same frame.
  useLayoutEffect(() => {
    if (!live.current) content()?.removeAttribute('transform');
  }, [state]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(wheelTimer.current);
    },
    [],
  );
  /** The view the reader sees now: the gesture's, or the drawn one. */
  const now = () => live.current ?? drawn.current;
  /** Moves the view during a gesture without rendering; painted on the next frame. */
  const glide = (change: (view: View) => View) => {
    live.current = change(now());
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (live.current)
        content()?.setAttribute('transform', gestureTransform(drawn.current, live.current));
    });
  };
  /** Ends a gesture: one render draws its final view. */
  const settle = () => {
    clearTimeout(wheelTimer.current);
    const view = live.current;
    if (!view) return;
    live.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    setState({ center: view.center, zoom: view.zoom });
  };

  /** Screen position to lon/lat (the SVG keeps a square view centred in its box). */
  const toLonLat = useCallback((x: number, y: number): LonLat | undefined => {
    const svg = node.current?.querySelector('svg[role="group"]');
    if (!svg) return undefined;
    const box = svg.getBoundingClientRect();
    const size = Math.min(box.width, box.height) || 1;
    const view = live.current ?? drawn.current;
    const perPixel = latest.current.homeSpan / view.zoom / size;
    const [cx, cy] = view.center;
    return [
      cx + (x - (box.left + box.width / 2)) * perPixel,
      cy - (y - (box.top + box.height / 2)) * perPixel,
    ];
  }, []);
  const degreesPerPixel = () => {
    const svg = node.current?.querySelector('svg[role="group"]');
    const box = svg?.getBoundingClientRect();
    return (
      latest.current.homeSpan / now().zoom / (Math.min(box?.width ?? 0, box?.height ?? 0) || 1)
    );
  };

  // Ctrl + wheel (and trackpad pinch, which arrives as one) zooms; a plain wheel scrolls the
  // page. React wheel listeners are passive, so this one is attached by hand.
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const anchor = toLonLat(event.clientX, event.clientY);
      glide((view) => zoomed(view, Math.exp(-event.deltaY * 0.004), anchor));
      clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(settle, WHEEL_SETTLE_MS);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toLonLat]);

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
        const anchor = toLonLat(mid.x, mid.y);
        glide((view) =>
          panned(
            before > 0 ? zoomed(view, after / before, anchor) : view,
            -(newMid.x - mid.x) * perPixel,
            (newMid.y - mid.y) * perPixel,
          ),
        );
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
          glide((view) =>
            panned(view, -(next.x - previous.x) * perPixel, (next.y - previous.y) * perPixel),
          );
        }
      }
      pointers.current.set(event.pointerId, next);
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
      if (gesture.current.dragged) gesture.current.suppressClick = true;
      if (!pointers.current.size) settle();
    },
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
      if (!pointers.current.size) settle();
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
      const step = (latest.current.homeSpan / now().zoom) * KEY_STEP;
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
      settle();
      move();
    },
  };

  return { view, span, zoom: state.zoom, maxZoom, zoomBy, panBy, reset, focus, bind };
};
