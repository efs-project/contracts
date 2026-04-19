import type { Metadata } from "next";

const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
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
      icon: [{ url: "/favicon.png", sizes: "32x32", type: "image/png" }],
    },
  };
};
