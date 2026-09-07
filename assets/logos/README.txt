Provider logo assets used by the offline renderer.

All five providers ship a crisp SVG glyph (renderer tries .svg, then .png/.ico,
then falls back to the provider text glyph). Sources / treatment:

- claude.svg: Claude favicon (https://claude.ai/favicon.svg), kept terracotta
- codex.svg: OpenAI / Codex mark — recoloured to light (#E9EAEC) so it is
  visible on the dark card (no invert filter needed)
- deepseek.svg: DeepSeek whale mark in DeepSeek blue (#4C6FFF)
- openrouter.svg: OpenRouter glyph (https://openrouter.ai/brand/v2/…), purple
- antigravity.svg: Gemini four-point sparkle in blue (#4C8BF5)

Added 2026-09-07: replaced the raster deepseek.ico / antigravity.png (which
rendered blurry) with clean SVGs, and recoloured Codex so all five logos read
consistently on the dark notch.
