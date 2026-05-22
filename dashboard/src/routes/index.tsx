/**
 * `/` — the projects home / welcome screen. Replaces the previous
 * widgets-gallery alias; the gallery now lives at `/widgets` only.
 */

import type { JSX } from "solid-js";
import { ProjectsHome } from "@/components/projects/ProjectsHome";

export default function ProjectsHomeRoute(): JSX.Element {
  return <ProjectsHome />;
}
