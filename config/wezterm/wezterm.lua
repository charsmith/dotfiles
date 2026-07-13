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

-- Key bindings
local act = wezterm.action
-- Cmd+Left/Right: jump to the prev/next tmux window with a running pi agent.
-- These send CSI modifier-9 (Super/Cmd) arrow sequences that tmux binds to
-- the jump-active-agent.sh script via bind-key -n in tmux.conf.
config.keys = {
  -- Jump to prev/next tmux window with a running pi agent (green pill).
  -- Sends Shift+Alt+Ctrl+Arrow (modifier 8, \e[1;8D/C) which tmux binds as
  -- C-M-S-Left / C-M-S-Right — a valid named key combo nothing else uses.
  { key = 'LeftArrow',  mods = 'CMD', action = act.SendString('\x1b[1;8D') },
  { key = 'RightArrow', mods = 'CMD', action = act.SendString('\x1b[1;8C') },
  -- Cmd+O: show active team's input in nvim popup, handled by pi team-viewer extension.
  -- Sends ESC+'o' (\x1bo) which pi sees as alt+o and routes to the registered shortcut.
  { key = 'o', mods = 'CMD', action = act.SendString('\x1bo') },

}

-- Finally, return the configuration to wezterm:
return config
