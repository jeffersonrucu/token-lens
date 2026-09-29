import {
  Chart,
  Filler,
  Interaction,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartType,
  type InteractionModeFunction,
  type TooltipPositionerFunction,
} from "chart.js";
import zoomPlugin from "chartjs-plugin-zoom";

Chart.register(LineController, LineElement, PointElement, LinearScale, Filler, Tooltip, zoomPlugin);

declare module "chart.js" {
  interface TooltipPositionerMap {
    opposite: TooltipPositionerFunction<ChartType>;
  }
  interface InteractionModeMap {
    step: InteractionModeFunction;
  }
}

const MARKER_HIT_PX = 10;
// A stepped line holds each value until the next point, so the hovered value is the last point left of the cursor.
// Points flagged `marker` only answer when the cursor is on them, not across the whole step they start.
Interaction.modes.step = (chart, event) => {
  const points = (chart.data.datasets[0]?.data ?? []) as { x: number; marker?: boolean }[];
  if (!points.length || event.x === null || event.y === null) return [];
  const top = chart.getDatasetMeta(chart.data.datasets.length - 1).data;
  let index = points.findIndex(
    (point, at) => point.marker && Math.hypot(top[at].x - event.x!, top[at].y - event.y!) <= MARKER_HIT_PX,
  );
  if (index < 0) {
    const x = chart.scales.x.getValueForPixel(event.x);
    index = points.findLastIndex((point) => !point.marker && x !== undefined && point.x <= x);
  }
  if (index < 0) return [];
  return chart.data.datasets.map((_, datasetIndex) => ({ element: chart.getDatasetMeta(datasetIndex).data[index], datasetIndex, index }));
};
// Pins the tooltip to the top corner away from the cursor, so it never covers the hovered point.
Tooltip.positioners.opposite = function (items, cursor) {
  if (!items.length) return false;
  const { left, right, top } = this.chart.chartArea;
  const onLeft = (cursor.x ?? items[0].element.x) < (left + right) / 2;
  return { x: onLeft ? right : left, y: top, xAlign: onLeft ? "right" : "left", yAlign: "top" };
};

export { Chart };
