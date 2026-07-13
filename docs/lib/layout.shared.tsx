import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { AppIcon } from "@/components/app-icon";

export const gitConfig = {
  user: "wavyrai",
  repo: "tmux-ide",
  branch: "main",
};

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2">
          <AppIcon size={22} priority />
          <span className="font-pixel text-lg">tmux-ide</span>
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
