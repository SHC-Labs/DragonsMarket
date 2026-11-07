import type { Metadata } from "next";
import { DocsShell } from "@/components/DocsShell";
import { apiPages } from "../pages";

export const dynamicParams = false;

export function generateStaticParams() {
  return apiPages.filter(page => page.slug).map(page => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = apiPages.find(p => p.slug === slug)!;
  return { title: `${page.title} | API | Dragons Market`, description: page.description };
}

export default async function ApiDocPage({ params }: { params: Promise<{ slug: string }> }) {
  return <DocsShell area="API" base="/api" pages={apiPages} slug={(await params).slug} />;
}
