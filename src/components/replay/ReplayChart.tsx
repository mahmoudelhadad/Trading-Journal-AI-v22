import { useEffect, useRef } from 'react';
import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type LineWidth,
  type MouseEventParams, type SeriesMarker, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { formatReplayChartTime } from '@calculations/displayTime.js';
import type { MarkerClass, OverlayLine, ReplayOverlay } from '@calculations/replayOverlay.js';
import type { HistoricalBar } from '@apptypes/marketData.js';

/**
 * B2d Phase 3 — the Replay chart renders bars plus a DERIVED overlay.
 *
 * This component is a renderer, not a decision maker. It receives an already
 * derived `ReplayOverlay` and never sees a session, a projection, the runtime or
 * the repository: it cannot classify an execution, cannot compute a basis or a
 * stop, and cannot decide whether the overlay is eligible. Every one of those
 * lives in `@calculations/replayOverlay.js` behind the composition boundary in
 * `pages/Replay.tsx`, so there is exactly one authority for each.
 *
 * `overlay` is therefore reconciled declaratively: an empty overlay is not a
 * special teardown path, it is simply the state in which no primitive is wanted.
 */
const PALETTE = {
  background: '#0D1421', grid: '#1A2535',
  /** Released candle colours, reused as the long / short-and-risk semantics. */
  long: '#22C55E', short: '#EF4444',
  /** Released chart foreground, reused as the neutral exit / basis tone. */
  neutral: '#C8D6E8',
} as const;

interface MarkerPresentation {
  shape: SeriesMarker<Time>['shape'];
  position: 'aboveBar' | 'belowBar';
  color: string;
  label: (quantity: number) => string;
}

/** Frozen minimal presentation. Side lives in the class, never re-derived here. */
const MARKER_PRESENTATION: Record<MarkerClass, MarkerPresentation> = {
  entry_long:    { shape: 'arrowUp',   position: 'belowBar', color: PALETTE.long,    label: (q) => `B ${q}` },
  entry_short:   { shape: 'arrowDown', position: 'aboveBar', color: PALETTE.short,   label: (q) => `S ${q}` },
  scale_long:    { shape: 'arrowUp',   position: 'belowBar', color: PALETTE.long,    label: (q) => `+${q}` },
  scale_short:   { shape: 'arrowDown', position: 'aboveBar', color: PALETTE.short,   label: (q) => `+${q}` },
  partial_long:  { shape: 'circle',    position: 'aboveBar', color: PALETTE.neutral, label: (q) => `-${q}` },
  partial_short: { shape: 'circle',    position: 'belowBar', color: PALETTE.neutral, label: (q) => `-${q}` },
  final_long:    { shape: 'square',    position: 'aboveBar', color: PALETTE.neutral, label: (q) => `X ${q}` },
  final_short:   { shape: 'square',    position: 'belowBar', color: PALETTE.neutral, label: (q) => `X ${q}` },
};

interface PriceLineStyle {
  title: string;
  color: string;
  lineWidth: LineWidth;
  lineStyle: LineStyle;
  lineVisible: boolean;
  axisLabelVisible: boolean;
}

const BASIS_STYLE: PriceLineStyle = {
  title: 'AVG', color: PALETTE.neutral, lineWidth: 1,
  lineStyle: LineStyle.Solid, lineVisible: true, axisLabelVisible: true,
};

const STOP_STYLE: PriceLineStyle = {
  title: 'STOP', color: PALETTE.short, lineWidth: 1,
  lineStyle: LineStyle.Dashed, lineVisible: true, axisLabelVisible: true,
};

/** Coordinates of one right-click, resolved by the chart's own scales. */
export interface ReplayChartContextRequest {
  clientX: number;
  clientY: number;
  /** `null` outside the plot area or when the price scale cannot answer. */
  price: number | null;
  /** `null` outside the plot area or when the time scale cannot answer. */
  barStartUtcMs: number | null;
}

export interface ReplayChartProps {
  bars: readonly HistoricalBar[];
  overlay: ReplayOverlay;
  /**
   * Optional consumer for a right-click. While absent the chart leaves the
   * browser's own context menu completely alone — Phase 3 installs plumbing, not
   * behaviour, so it must not swallow a right-click that nothing consumes.
   */
  onContextRequest?: (request: ReplayChartContextRequest) => void;
  /**
   * B2d Phase 6A — Select Bar mode. While true a LEFT click on a rendered bar
   * reports that bar's start; right-click continues to open the context menu, so
   * the two gestures never collide.
   */
  selectBarActive?: boolean;
  onSelectBar?: (barStartUtcMs: number) => void;
  /**
   * B2d Phase 6A — Focus Mode sizing. Normal keeps the released fixed 520 px
   * chart; fill lets the chart follow its container's measured height. This is
   * presentation only: it never participates in price or time conversion.
   */
  fillHeight?: boolean;
}

const NORMAL_CHART_HEIGHT = 520;

/**
 * One deterministic reconcile step for one price line. Four cases, no other
 * path, so the primitive count can never drift above one line per kind.
 */
function reconcilePriceLine(
  series: ISeriesApi<'Candlestick'>,
  existing: IPriceLine | null,
  desired: OverlayLine | undefined,
  style: PriceLineStyle,
): IPriceLine | null {
  if (desired === undefined) {
    if (existing !== null) series.removePriceLine(existing);
    return null;
  }
  if (existing === null) return series.createPriceLine({ ...style, price: desired.price });
  existing.applyOptions({ price: desired.price });   // never recreated on a price change
  return existing;
}

export function ReplayChart({
  bars, overlay, onContextRequest, selectBarActive = false, onSelectBar, fillHeight = false,
}: ReplayChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const basisLineRef = useRef<IPriceLine | null>(null);
  const stopLineRef = useRef<IPriceLine | null>(null);
  // Refs, so a new callback identity or a mode toggle never rebuilds the chart
  // or re-subscribes. These are LATEST-CONSUMER refs; none of them is, or may
  // become, a cached crosshair or mouse-position cache — the native event and
  // the chart's own scales remain the only coordinate authorities.
  const contextRef = useRef(onContextRequest);
  useEffect(() => { contextRef.current = onContextRequest; }, [onContextRequest]);
  const selectActiveRef = useRef(selectBarActive);
  useEffect(() => { selectActiveRef.current = selectBarActive; }, [selectBarActive]);
  const selectBarRef = useRef(onSelectBar);
  useEffect(() => { selectBarRef.current = onSelectBar; }, [onSelectBar]);
  const fillHeightRef = useRef(fillHeight);
  const applySizeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    fillHeightRef.current = fillHeight;
    applySizeRef.current?.();     // resize in place; the chart is never recreated
  }, [fillHeight]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart: IChartApi = createChart(container, {
      height: NORMAL_CHART_HEIGHT,
      layout: { background: { type: ColorType.Solid, color: PALETTE.background }, textColor: PALETTE.neutral },
      grid: { vertLines: { color: PALETTE.grid }, horzLines: { color: PALETTE.grid } },
      localization: { timeFormatter: (time: Time) => typeof time === 'number' ? formatReplayChartTime(time) : '' },
      timeScale: { timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: Time) => typeof time === 'number' ? formatReplayChartTime(time) : '' },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: PALETTE.long, downColor: PALETTE.short, borderVisible: false,
      wickUpColor: PALETTE.long, wickDownColor: PALETTE.short,
    });
    seriesRef.current = series;
    // Created ONCE for the chart's lifetime; overlay updates go through setMarkers.
    markersRef.current = createSeriesMarkers(series, [], { zOrder: 'aboveSeries' });
    // Width is reconciled exactly as released. Height joins it ONLY in fill mode,
    // where the chart follows its container instead of the fixed 520 px.
    const applySize = () => {
      const measuredHeight = container.clientHeight;
      chart.applyOptions(fillHeightRef.current && measuredHeight > 0
        ? { width: container.clientWidth, height: measuredHeight }
        : { width: container.clientWidth });
    };
    applySizeRef.current = applySize;
    const observer = new ResizeObserver(applySize);
    observer.observe(container);

    const chartElement = chart.chartElement();
    const onContextMenu = (event: MouseEvent) => {
      const consumer = contextRef.current;
      if (consumer === undefined) return;            // browser default left intact
      event.preventDefault();
      const rect = chartElement.getBoundingClientRect();
      // DOM geometry converts viewport CSS coordinates to chart-local CSS
      // coordinates and nothing else. Price and time come from the chart's own
      // scales; no ratio, no visible-range interpolation, no devicePixelRatio.
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const timeScale = chart.timeScale();
      // `timeScale().width()` is the plot width (the price scale is outside it)
      // and `timeScale().height()` is the time-axis strip, so the plot area ends
      // that far above the element's bottom edge.
      const withinPlot = localX >= 0 && localX <= timeScale.width()
        && localY >= 0 && localY <= rect.height - timeScale.height();
      if (!withinPlot) {
        consumer({ clientX: event.clientX, clientY: event.clientY, price: null, barStartUtcMs: null });
        return;
      }
      const price = series.coordinateToPrice(localY);
      const time = timeScale.coordinateToTime(localX);
      consumer({
        clientX: event.clientX, clientY: event.clientY,
        price: price === null ? null : price,
        // Chart time is seconds; the canonical domain is milliseconds. A
        // non-numeric or absent chart time yields null rather than a guess.
        barStartUtcMs: typeof time === 'number' ? time * 1000 : null,
      });
    };
    chartElement.addEventListener('contextmenu', onContextMenu);

    /*
     * Select Bar. Subscribed exactly ONCE for the chart's lifetime and gated by
     * refs, so toggling the mode or swapping the callback never re-subscribes.
     * The chart's own click event carries the bar time; there is no coordinate
     * interpolation, no DOM x→time conversion and no display-string parsing. A
     * click that resolves no numeric time selects nothing and leaves the mode on.
     */
    const onChartClick = (params: MouseEventParams<Time>) => {
      if (!selectActiveRef.current) return;
      const consumer = selectBarRef.current;
      const time = params.time;
      if (consumer === undefined || typeof time !== 'number') return;
      consumer(time * 1000);       // chart seconds -> canonical milliseconds
    };
    chart.subscribeClick(onChartClick);

    return () => {
      chart.unsubscribeClick(onChartClick);
      chartElement.removeEventListener('contextmenu', onContextMenu);
      applySizeRef.current = null;
      // Primitives are released before the chart itself, and each ref is cleared
      // so a later reconcile can never remove an already-removed line.
      if (basisLineRef.current !== null) { series.removePriceLine(basisLineRef.current); basisLineRef.current = null; }
      if (stopLineRef.current !== null) { series.removePriceLine(stopLineRef.current); stopLineRef.current = null; }
      markersRef.current?.detach();
      markersRef.current = null;
      observer.disconnect();
      chart.remove();
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.setData(bars.map((bar) => ({
      time: (bar.t / 1000) as UTCTimestamp, open: bar.o, high: bar.h, low: bar.l, close: bar.c,
    })));
  }, [bars]);

  useEffect(() => {
    // The overlay order (anchor ascending, then canonical sequence) is already
    // frozen upstream and is passed through untouched — no second ordering.
    markersRef.current?.setMarkers(overlay.markers.map((marker): SeriesMarker<Time> => {
      const presentation = MARKER_PRESENTATION[marker.klass];
      return {
        time: (marker.anchorUtcMs / 1000) as UTCTimestamp,
        position: presentation.position,
        shape: presentation.shape,
        color: presentation.color,
        id: marker.actionId,
        text: presentation.label(marker.quantity),
      };
    }));
  }, [overlay.markers]);

  useEffect(() => {
    const series = seriesRef.current;
    if (series === null) return;
    basisLineRef.current = reconcilePriceLine(series, basisLineRef.current,
      overlay.lines.find((line) => line.kind === 'basis'), BASIS_STYLE);
    stopLineRef.current = reconcilePriceLine(series, stopLineRef.current,
      overlay.lines.find((line) => line.kind === 'stop'), STOP_STYLE);
  }, [overlay.lines]);

  return <div ref={containerRef}
    style={fillHeight ? { width: '100%', height: '100%' } : { width: '100%', minHeight: NORMAL_CHART_HEIGHT }}
    aria-label="Historical replay candlestick chart" />;
}
