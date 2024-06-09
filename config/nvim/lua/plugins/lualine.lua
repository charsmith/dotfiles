return {
  "nvim-lualine/lualine.nvim",
  config = function()
    require("lualine").setup({
      options = {
        theme = "dracula",
        ignore_focus = {
          "neo-tree",
        },
      },
    })
  end,
}
