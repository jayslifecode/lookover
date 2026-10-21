export type { Rgba } from './interaction/contrast.js';
export {
  blendOver,
  contrastRatio,
  isLargeText,
  parseCssColor,
  RATIO_DECIMALS,
  relativeLuminance,
  requiredRatio,
  roundedContrastRatio,
} from './interaction/contrast.js';
export type {
  BackgroundUncertainty,
  ClippedText,
  EffectiveBackground,
  OverflowMeasure,
  OverflowOffender,
  PositiveTabindex,
  StateStyleProperty,
  StyleSnapshot,
  StyleValues,
  TextSample,
} from './interaction/in-page.js';
export {
  COMPONENT_NAME_SOURCE,
  EFFECTIVE_BACKGROUND_SOURCE,
  IN_ACTIVEDESCENDANT_WIDGET_SOURCE,
  IS_INLINE_IN_TEXT_SOURCE,
  MEASURE_OVERFLOW_SOURCE,
  POSITIVE_TABINDEX_SOURCE,
  STATE_STYLE_PROPERTIES,
  STYLE_SNAPSHOT_SOURCE,
  TEXT_SAMPLE_SOURCE,
} from './interaction/in-page.js';
export { INTERACTION_RULES, InteractionLens } from './interaction/lens.js';
export { evaluateSource, measureOn } from './interaction/measure.js';
export type {
  FocusLook,
  FocusMarkOn,
  FocusStop,
  GalleryEntry,
  GalleryState,
  StateGallery,
  StatesResult,
} from './interaction/states.js';
export {
  CROP_PADDING_PX,
  captureStates,
  focusIndicatorColor,
  focusMarkOf,
  MAX_FOCUS_WITHIN_DEPTH,
  MAX_GALLERY_ELEMENTS,
  MAX_STATE_ELEMENTS,
  stateDiffers,
} from './interaction/states.js';
export type { StaticResult } from './interaction/static.js';
export { MAX_CONTRAST_ELEMENTS, MUST_BE_FOCUSABLE_ROLES, measureStatic } from './interaction/static.js';
export type { ActiveElement, FocusHiddenReason } from './interaction/tab-in-page.js';
export { ACTIVE_ELEMENT_SOURCE, DEV_OVERLAY_TAGS } from './interaction/tab-in-page.js';
export type { TabWalkResult } from './interaction/tab-walk.js';
export { MAX_TAB_PRESSES, TRAP_REPEATS, tabWalk } from './interaction/tab-walk.js';
export type { TargetSizeResult } from './interaction/target-size.js';
export { MIN_TARGET_PX, passesTargetSize } from './interaction/target-size.js';
export type { SweepResult } from './interaction/viewports.js';
export { sweepViewports } from './interaction/viewports.js';
