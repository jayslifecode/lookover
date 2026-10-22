import type { RefObject } from 'react';

/*
 * The screen's full-page screenshot at the column's width. annotated-screenshot.tsx measures it and
 * pins findings over it; it renders it through `memo`, so a choice of finding never renders it again.
 */

export interface ScreenshotImageProps {
  readonly url: string;
  readonly alt: string;
  readonly imageRef: RefObject<HTMLImageElement | null>;
  readonly onLoad: () => void;
  readonly onError: () => void;
}

export function ScreenshotImage({ url, alt, imageRef, onLoad, onError }: ScreenshotImageProps) {
  return (
    <img
      ref={imageRef}
      src={url}
      alt={alt}
      decoding="async"
      onLoad={onLoad}
      onError={onError}
      className="block h-auto w-full"
    />
  );
}
