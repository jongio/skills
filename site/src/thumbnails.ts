import type { ImageMetadata } from "astro";

const thumbnails = import.meta.glob<ImageMetadata>("../../skills/*/thumbnail.png", {
  eager: true,
  import: "default",
});

export function thumbnailFor(thumb: string): ImageMetadata {
  const id = /^images\/thumb-([a-z0-9-]+)\.png$/.exec(thumb)?.[1];
  const image = id ? thumbnails[`../../skills/${id}/thumbnail.png`] : undefined;
  if (!image) throw new Error(`No source thumbnail for ${thumb}`);
  return image;
}
