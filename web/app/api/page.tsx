import type { Metadata } from "next";
import { DocsShell } from "@/components/DocsShell";
import { apiPages } from "./pages";

export const metadata: Metadata = {
  title: "API | Dragons Market",
  description: apiPages[0].description,
};

export default function ApiPage() {
  return <DocsShell area="API" base="/api" pages={apiPages} slug="" />;
}
