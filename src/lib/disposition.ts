/**
 * The header that names the file, for any filename.
 *
 * A header value is bytes, and setting one with a character past U+00FF
 * throws, which took the whole response down: a clip whose name had macOS's
 * full-width "？" in it (U+FF1F, what Finder writes in place of "?") uploaded
 * fine and then failed to play back, which the clip control reports as the
 * file being gone. So the plain `filename` is an ASCII stand-in, and the real
 * name goes in `filename*` (RFC 6266), which browsers prefer when present.
 */
export function inlineDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
