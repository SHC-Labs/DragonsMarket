import type { Metadata } from "next";
import { DocsShell } from "@/components/DocsShell";
import { docsPages } from "./pages";

export const metadata: Metadata = {
  title: "Docs | Dragons Market",
  description: docsPages[0].description,
};

export default function DocsPage() {
  return <DocsShell area="Docs" base="/docs" pages={docsPages} slug="" />;
}
