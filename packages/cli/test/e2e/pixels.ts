import type { Page } from 'playwright';

/*
 * Compares two screenshots pixel by pixel, decoding them in a page of the browser (a canvas), so the
 * suite needs no image library: how many pixels differ, in any channel, by more than a tolerance.
 */

/** How many pixels of the PNGs `a` and `b` (the same size) differ by more than `tolerance` in a channel. */
export function differingPixels(page: Page, a: Buffer, b: Buffer, tolerance: number): Promise<number> {
  return page.evaluate(
    async ({ first, second, limit }) => {
      const pixelsOf = async (source: string) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('No 2D canvas to compare the screenshots on');
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data;
      };
      const [left, right] = await Promise.all([pixelsOf(first), pixelsOf(second)]);
      if (left.length !== right.length) throw new Error('The screenshots are not the same size');
      const channels = 4;
      let count = 0;
      for (let at = 0; at < left.length; at += channels) {
        const isDifferent = [0, 1, 2].some(
          (channel) => Math.abs((left[at + channel] ?? 0) - (right[at + channel] ?? 0)) > limit,
        );
        if (isDifferent) count += 1;
      }
      return count;
    },
    {
      first: `data:image/png;base64,${a.toString('base64')}`,
      second: `data:image/png;base64,${b.toString('base64')}`,
      limit: tolerance,
    },
  );
}
