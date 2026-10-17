import { defineConfig } from "vitepress";

export default defineConfig({
  title: "uvp",
  description:
    "Build, run, and verify libuvcpp-powered C++ web services from your terminal or agent.",
  lang: "en-US",
  base: "/uvp/",
  srcExclude: ["readme/**"],
  themeConfig: {
    nav: [
      { text: "Get started", link: "/installation" },
      { text: "Reference", link: "/mcp-contracts" },
      { text: "Roadmap", link: "/roadmap" },
    ],
    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Installation and setup", link: "/installation" },
          { text: "CLI and evidence", link: "/cli" },
          { text: "Roadmap", link: "/roadmap" },
        ],
      },
      {
        text: "Concepts",
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "Evidence model", link: "/evidence" },
          { text: "Tool design", link: "/tool-design" },
        ],
      },
      {
        text: "Reference",
        collapsed: true,
        items: [
          { text: "MCP contracts", link: "/mcp-contracts" },
          { text: "libuvcpp feature mapping", link: "/libuvcpp-features" },
          { text: "First-release support matrix", link: "/support-matrix" },
        ],
      },
      {
        text: "Development",
        collapsed: true,
        items: [
          { text: "Testing", link: "/testing" },
          { text: "Releasing", link: "/releasing" },
          { text: "AI development workflow", link: "/agent-workflow" },
          { text: "AI engineer operations", link: "/ai-engineer-operations" },
          { text: "Current development plan", link: "/work-plan" },
        ],
      },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/Antruly/uvp" }],
    editLink: {
      pattern: "https://github.com/Antruly/uvp/edit/main/docs/:path",
    },
    footer: {
      message: "Released under the MIT License.",
    },
  },
});
