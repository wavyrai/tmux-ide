import ProjectPage from "./ProjectPage";

// Required for Next.js static export — generates a placeholder HTML shell.
// At runtime, the client-side router reads the real project name from the URL.
export function generateStaticParams() {
  return [{ name: "__fallback" }];
}

export default function Page() {
  return <ProjectPage />;
}
