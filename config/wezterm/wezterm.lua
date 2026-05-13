-- Pull in the wezterm API
local wezterm = require("wezterm")

local config = wezterm.config_builder()

-- TODO break out configs into files.
config.initial_cols = 120
config.initial_rows = 28

config.color_scheme = "Catppuccin Mocha"

config.hide_tab_bar_if_only_one_tab = true

config.native_macos_fullscreen_mode = true

config.window_padding = {
	left = 5,
	right = 5,
	top = 5,
	bottom = 5,
}

config.font = wezterm.font("JetBrainsMono Nerd Font Mono")
config.font_size = 14

config.notification_handling = "AlwaysShow"

-- Finally, return the configuration to wezterm:
return config
