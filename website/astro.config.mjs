// Docs site for @komaa/livekit-msteams-bridge, published to GitHub Pages by .github/workflows/docs.yml.
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";

export default defineConfig({
  site: "https://komaa-com.github.io",
  base: "/livekit-msteams-bridge",
  integrations: [
    // Client-side Mermaid rendering (theme-aware, offline). Must come BEFORE starlight.
    mermaid({ theme: "default", autoTheme: true }),
    starlight({
      head: [
        // Google Analytics 4 (shared StandIn property; filter by hostname in GA).
        { tag: "script", attrs: { async: true, src: "https://www.googletagmanager.com/gtag/js?id=G-M02N9C42XH" } },
        {
          tag: "script",
          content:
            "window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-M02N9C42XH');",
        },
        // Cloudflare Web Analytics beacon (privacy-friendly pageviews; complements GA above).
        { tag: "script", attrs: { type: "module", src: "https://static.cloudflareinsights.com/beacon.min.js", "data-cf-beacon": '{"token": "49de4fe6d4e64fb6a5b18bbc7d133e88"}' } },
      ],
      title: "Microsoft Teams Bridge for LiveKit Agents",
      description:
        "Put a LiveKit Agent - including avatar agents - on a real Microsoft Teams call: one room per call with explicit agent dispatch, 16 kHz PCM audio relay, and call governors, connected through the StandIn media bridge.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/komaa-com/livekit-msteams-bridge",
        },
      ],
      sidebar: [
        { label: "Overview", link: "/" },
        { label: "Getting Started", link: "/getting-started/" },
        { label: "Connecting to StandIn", link: "/connecting-to-standin/" },
        { label: "Architecture", link: "/architecture/" },
        { label: "Agents and Dispatch", link: "/agents-and-dispatch/" },
        { label: "Configuration Reference", link: "/configuration-reference/" },
        { label: "Library API", link: "/library-api/" },
        { label: "Wire Protocol", link: "/wire-protocol/" },
        { label: "Governors and Privacy", link: "/governors-and-privacy/" },
        { label: "Troubleshooting", link: "/troubleshooting/" },
        { label: "Contributing", link: "/contributing/" },
      ],
    }),
  ],
});
