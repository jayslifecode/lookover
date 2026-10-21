export type { Rgba } from './interaction/contrast.js';
export {
  blendOver,
  contrastRatio,
  isLargeText,
  parseCssColor,
  relativeLuminance,
  requiredRatio,
} from './interaction/contrast.js';
export type {
  ActiveElement,
  BackgroundUncertainty,
  ClippedText,
  EffectiveBackground,
  FocusHiddenReason,
  OverflowMeasure,
  OverflowOffender,
  PositiveTabindex,
  StateStyleProperty,
  StyleSnapshot,
  StyleValues,
  TextSample,
} from './interaction/in-page.js';
export {
  ACTIVE_ELEMENT_SOURCE,
  COMPONENT_NAME_SOURCE,
  EFFECTIVE_BACKGROUND_SOURCE,
  IS_INLINE_IN_TEXT_SOURCE,
  MEASURE_OVERFLOW_SOURCE,
  POSITIVE_TABINDEX_SOURCE,
  STATE_STYLE_PROPERTIES,
  STYLE_SNAPSHOT_SOURCE,
  TEXT_SAMPLE_SOURCE,
} from './interaction/in-page.js';
export { evaluateSource, measureOn } from './interaction/measure.js';
