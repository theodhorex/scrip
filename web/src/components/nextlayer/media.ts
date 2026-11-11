/**
 * Media for the Scrip landing lab (/hero-lab). The only place these URLs live.
 *
 * The hero video is Theo's own choice ("The Next Layer of Intelligence" prompt, 3 Nov 2026).
 * LICENCE: UNKNOWN. It is served from a third-party CDN (CloudFront) whose terms are not
 * documented. Theo must confirm the licence, or self-host the file in web/public, before any
 * production publish. See web/docs/ASSETS.md.
 *
 * Checked on 3 Nov 2026: HEAD 200, video/mp4, 5,361,462 bytes, accept-ranges: bytes.
 * ffprobe: h264, 1664x1248, 24 fps, 10.04 s, no audio needed (played muted).
 * The poster is frame 3.0 s of that file (23 KB webp) written to web/public/herolab-still.webp
 * for local testing and as the LCP/fallback image.
 */
export const HERO_VIDEO_URL =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260808_112712_da9d53df-6d27-4b12-bdf6-aa9dc2622bdf.mp4";

export const HERO_POSTER = "/herolab-still.webp";
