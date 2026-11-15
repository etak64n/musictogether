// The documentation site of Music Together, built with Starlight.
// .github/workflows/docs.yml publishes it to GitHub Pages at
// https://etak64n.github.io/musictogether/.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://etak64n.github.io",
  // GitHub Pages serves the site under the name of the repository.
  base: "/musictogether",
  integrations: [
    starlight({
      title: "Music Together",
      description: "Listen to YouTube Music with friends, at the same moment, through a room server of your own.",
      logo: { src: "./src/assets/logo.svg" },
      // favicon.svg shows the middle of the icon's tile and turns the tile lighter on
      // dark tabs; favicon.png is for browsers without SVG icons.
      favicon: "/favicon.svg",
      head: [{ tag: "link", attrs: { rel: "icon", type: "image/png", sizes: "128x128", href: "/musictogether/favicon.png" } }],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/etak64n/musictogether" }],
      editLink: { baseUrl: "https://github.com/etak64n/musictogether/edit/main/docs/" },
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        { label: "Getting started", items: ["getting-started/server", "getting-started/extension"] },
        { label: "Guides", items: ["guides/rooms", "guides/host"] },
        { label: "Settings", items: ["settings/server"] },
        { label: "Reference", items: ["reference/api"] },
        { label: "Internals", items: ["internals/architecture"] },
        { label: "Project", items: ["project/development"] },
      ],
    }),
  ],
});
