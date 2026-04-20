import type { Metadata } from "next";

// Base URL for Next.js `metadataBase` and OG / Twitter image URLs.
// Precedence:
//   1. NEXT_PUBLIC_SITE_URL          (explicit — devnet / VPS / custom domain sets this)
//   2. VERCEL_PROJECT_PRODUCTION_URL (Vercel auto-provides this at build time)
//   3. http://localhost:PORT         (local dev fallback)
// Without (1) on the devnet VPS, previews leak `http://localhost:3000` into og:image
// and twitter:image.
const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
  ? process.env.NEXT_PUBLIC_SITE_URL
  : process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `http://localhost:${process.env.PORT || 3000}`;
const titleTemplate = "%s - EFS";

// Root layout passes `isRoot: true` so the template applies to descendants.
// Child pages pass a plain title; Next.js formats it as "<title> - EFS" via the root template.
export const getMetadata = ({
  title,
  description,
  imageRelativePath = "/thumbnail.jpg",
  isRoot = false,
}: {
  title: string;
  description: string;
  imageRelativePath?: string;
  isRoot?: boolean;
}): Metadata => {
  const imageUrl = `${baseUrl}${imageRelativePath}`;
  const titleField = isRoot ? { default: title, template: titleTemplate } : title;

  return {
    metadataBase: new URL(baseUrl),
    title: titleField,
    description: description,
    openGraph: {
      title: titleField,
      description: description,
      images: [
        {
          url: imageUrl,
        },
      ],
    },
    twitter: {
      title: titleField,
      description: description,
      images: [imageUrl],
    },
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "48x48" },
        { url: "/favicon.svg", type: "image/svg+xml" },
        { url: "/favicon-96x96.png", sizes: "96x96", type: "image/png" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    manifest: "/manifest.json",
  };
};
