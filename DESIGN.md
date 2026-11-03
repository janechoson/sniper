# BOT B palette reference

Source: [PaperDAO homepage](https://www.paperdao.xyz/), captured 2026-10-28 through Firecrawl branding and screenshot. The reference screenshot was downloaded and visually inspected: `data/paperdao-reference.png`.

Observed source tokens from branding extraction:

| Role | Value |
| --- | --- |
| Background | `#F4ECD8` |
| Primary/accent/link | `#8B2020` |
| Main text | `#2B2924` |
| Secondary button border | `#CEC7B6` |
| Body font | Inter with system fallbacks |

The inspected screenshot shows warm paper surfaces, dark text, restrained burgundy buttons and thin neutral borders. It is a desktop capture; mobile behavior and dark-theme tokens were not inspected. No source logo, illustration or imagery is copied into BOT B.

BOT B implementation uses the four observed color tokens above in `public/style.css`. Proposed companion colors are cream panels `#FAF5E9`, raised panels `#FFFAF0`, input/sidebar `#F1E8D3` and muted text `#746D61`. Trading state colors are adapted for readable text on light surfaces: green `#247453`, danger red `#B73737`, amber `#89661A`, purple `#795F9C`. These companion and state colors are implementation choices, not extracted PaperDAO values. The existing compact dashboard typography, layout and flow components remain; no external font dependency is introduced.

The top Scanned-to-Traded counter row and wallet-address subtitle are removed from markup and rendering. Queue counts remain on their own panels. Static files are served directly, so browser reload applies the change without restarting the running trading engine.
