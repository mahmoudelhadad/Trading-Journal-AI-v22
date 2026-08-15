import { useEffect, useRef } from 'react';
import { CandlestickSeries, ColorType, createChart, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import { formatReplayChartTime } from '@calculations/displayTime.js';
import type { HistoricalBar } from '@apptypes/marketData.js';

export function ReplayChart({ bars }: { bars: readonly HistoricalBar[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart: IChartApi = createChart(container, {
      height: 520,
      layout: { background: { type: ColorType.Solid, color: '#0D1421' }, textColor: '#C8D6E8' },
      grid: { vertLines: { color: '#1A2535' }, horzLines: { color: '#1A2535' } },
      localization: { timeFormatter: (time: Time) => typeof time === 'number' ? formatReplayChartTime(time) : '' },
      timeScale: { timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: Time) => typeof time === 'number' ? formatReplayChartTime(time) : '' },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22C55E', downColor: '#EF4444', borderVisible: false,
      wickUpColor: '#22C55E', wickDownColor: '#EF4444',
    });
    seriesRef.current = series;
    const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
    observer.observe(container);
    return () => { observer.disconnect(); chart.remove(); seriesRef.current = null; };
  }, []);
  useEffect(() => {
    seriesRef.current?.setData(bars.map((bar) => ({
      time: (bar.t / 1000) as UTCTimestamp, open: bar.o, high: bar.h, low: bar.l, close: bar.c,
    })));
  }, [bars]);
  return <div ref={containerRef} style={{ width: '100%', minHeight: 520 }} aria-label="Historical replay candlestick chart" />;
}
