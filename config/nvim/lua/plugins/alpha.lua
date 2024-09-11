return {
  "goolord/alpha-nvim",
  config = function()
    local alpha = require("alpha")
    local dashboard = require("alpha.themes.dashboard")
    dashboard.section.buttons.val = {
      dashboard.button("e", "  New file", ":ene <BAR> startinsert <CR>"),
      dashboard.button("f", "  Find files", ':lua require("telescope.builtin").find_files() <CR>'),
      dashboard.button("g", "󰱼  Grep files", ':lua require("telescope.builtin").live_grep() <CR>'),
      dashboard.button("q", "󰅚  Quit NVIM", ":qa<CR>"),
    }

    dashboard.config.opts.noautocmd = true

    vim.cmd([[autocmd User AlphaReady echo 'ready']])

    alpha.setup(dashboard.config)
  end,
}
