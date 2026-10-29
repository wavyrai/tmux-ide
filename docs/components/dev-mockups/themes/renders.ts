import type { StaticImageData } from "next/image";

import amber from "./renders/amber.webp";
import green from "./renders/green.webp";
import cyan from "./renders/cyan.webp";
import red from "./renders/red.webp";
import blue from "./renders/blue.webp";
import purple from "./renders/purple.webp";
import pink from "./renders/pink.webp";
import white from "./renders/white.webp";
import paper from "./renders/paper.webp";
import githubLight from "./renders/github-light.webp";
import solarizedLight from "./renders/solarized-light.webp";
import gruvboxLight from "./renders/gruvbox-light.webp";
import nordLight from "./renders/nord-light.webp";
import tokyo from "./renders/tokyo.webp";
import solarized from "./renders/solarized.webp";
import dracula from "./renders/dracula.webp";
import nord from "./renders/nord.webp";
import monokai from "./renders/monokai.webp";
import catppuccin from "./renders/catppuccin.webp";
import gruvbox from "./renders/gruvbox.webp";
import rosepine from "./renders/rosepine.webp";
import midnight from "./renders/midnight.webp";

/** One render of the app's Terminals view per preset id. */
export const THEME_RENDERS: Readonly<Record<string, StaticImageData>> = {
  amber: amber,
  green: green,
  cyan: cyan,
  red: red,
  blue: blue,
  purple: purple,
  pink: pink,
  white: white,
  paper: paper,
  "github-light": githubLight,
  "solarized-light": solarizedLight,
  "gruvbox-light": gruvboxLight,
  "nord-light": nordLight,
  tokyo: tokyo,
  solarized: solarized,
  dracula: dracula,
  nord: nord,
  monokai: monokai,
  catppuccin: catppuccin,
  gruvbox: gruvbox,
  rosepine: rosepine,
  midnight: midnight,
};
