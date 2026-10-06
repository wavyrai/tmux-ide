import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { AsciiWordmark } from "@/components/ascii-wordmark";

export const gitConfig = {
  user: "wavyrai",
  repo: "tmux-ide",
  branch: "main",
};

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // Wordmark only; the app icon stays for the favicon and social cards.
      // The link's accessible name reads "tmux-ide home".
      title: (
        <span className="flex items-center">
          <AsciiWordmark size="nav" />
          <span className="sr-only"> home</span>
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
