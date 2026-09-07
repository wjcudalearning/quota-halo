Provider logo assets used by the offline renderer.

Sources checked on 2026-09-07:
- claude.svg: https://claude.ai/favicon.svg
- codex.svg: https://openrouter.ai/images/icons/OpenAI.svg
- deepseek.ico: https://www.deepseek.com/favicon.ico
- openrouter.svg: https://openrouter.ai/brand/v2/openrouter-glyph-light.svg
- antigravity.png: https://antigravity.google/assets/image/antigravity-logo.png

The renderer tries SVG, PNG, and ICO in that order, then falls back to the
provider text glyph if an asset is unavailable.
