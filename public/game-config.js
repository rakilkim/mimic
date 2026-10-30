// Shared balance and feel settings for the game server and browser client.
// Keep playtest values here so the rules stay in sync across every screen.
export const TUNING = Object.freeze({
  playersMin: 2,
  playersMax: 8,

  hideSeconds: 120,
  searchSeconds: 50,
  revealSeconds: 15,
  missCooldownMs: 750,

  hitRadiusX: 0.023,
  hitRadiusY: 0.058,
  hitPaddingX: 0.008,
  hitPaddingY: 0.009,
  placementMinX: 0.032,
  placementMaxX: 0.968,
  placementMinY: 0.08,
  placementMaxY: 0.949,
  panThresholdPx: 9,
  defaultPaintColor: '#969d99',
  paintOpacity: 0.99,
  paintBrushSizes: [4, 8, 18, 32],
  paintAnalysisResolution: 8,
  paintMaxPoints: 160,
  paintMaxStrokes: 80,

  minZoom: 1,
  maxZoom: 6,
  zoomInStep: 1.25,
  zoomOutStep: 0.8,
  wheelSensitivity: 0.0015,

  seekerPlacePoints: [100, 80, 70, 60, 50, 40, 30],
  mimiSizes: [
    { scale: 0.80, label: 'S', hiderMultiplier: 0.8, paintThreshold: 0.08 },
    { scale: 1.00, label: 'M', hiderMultiplier: 1.0, paintThreshold: 0.06 },
    { scale: 1.20, label: 'L', hiderMultiplier: 1.5, paintThreshold: 0.04 },
  ],

  targetColor: '#969d99',
  targetShade: '#909792',
  faceColor: '#888f8a',
  outlineColor: '#f3f4ef',
  outlineOpacity: 0.11,
  outlineWidth: 0.65,
});
