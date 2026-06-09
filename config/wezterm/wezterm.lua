-- Pull in the wezterm API
local wezterm = require("wezterm")

local config = wezterm.config_builder()

-- Window
config.initial_cols = 120
config.initial_rows = 28
config.hide_tab_bar_if_only_one_tab = true
config.native_macos_fullscreen_mode = true
config.notification_handling = "AlwaysShow"

config.window_padding = {
	left = 5,
	right = 5,
	top = 5,
	bottom = 5,
}

-- Colours
config.color_scheme = "Catppuccin Mocha"
config.colors = { background = "#000000" }

-- Font
-- Subpixel AA + Full hinting produces sharper strokes, closer to how Electron
-- apps (Obsidian, VS Code) render the same font via CoreText/Skia.
config.font = wezterm.font("JetBrainsMono Nerd Font Mono", { weight = "Regular" })
config.font_size = 14
config.line_height = 1.1
config.cell_width = 1.0
-- HorizontalLcd = subpixel AA with full hinting (sharpest on LCD/Retina).
-- If text looks colour-fringed, swap both to "Normal" for greyscale AA.
config.freetype_load_target = "HorizontalLcd"
config.freetype_render_target = "HorizontalLcd"
-- Disable the calt (contextual alternates / ligatures) and liga features if you
-- want plain characters; remove these lines to re-enable ligatures.
config.harfbuzz_features = { "calt=0", "clig=0", "liga=0" }

-- Finally, return the configuration to wezterm:
return config
