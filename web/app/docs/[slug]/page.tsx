import type { Metadata } from "next";
import { DocsShell } from "@/components/DocsShell";
import { docsPages } from "../pages";

export const dynamicParams = false;

export function generateStaticParams() {
  return docsPages.filter(page => page.slug).map(page => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = docsPages.find(p => p.slug === slug)!;
  return { title: `${page.title} | Docs | Dragons Market`, description: page.description };
}

export default async function DocsArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  return <DocsShell area="Docs" base="/docs" pages={docsPages} slug={(await params).slug} />;
}
