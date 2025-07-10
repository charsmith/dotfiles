-- Pull in the wezterm API
local wezterm = require("wezterm")

local config = wezterm.config_builder()

-- TODO break out configs into files.
config.initial_cols = 120
config.initial_rows = 28

config.font_size = 10
config.color_scheme = "Catppuccin Mocha"

config.hide_tab_bar_if_only_one_tab = true

config.native_macos_fullscreen_mode = true

config.window_padding = {
	left = 0,
	right = 0,
	top = 0,
	bottom = 0,
}

config.font = wezterm.font("RobotoMono Nerd Font")
config.font_size = 14

-- Finally, return the configuration to wezterm:
return config
