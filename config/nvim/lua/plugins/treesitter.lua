return {
  "nvim-treesitter/nvim-treesitter",
  build = ":TSUpdate",
  config = function()
    local configs = require("nvim-treesitter.configs")

    configs.setup({
      ensure_installed = {
        "bash",
        "c",
        "elixir",
        "html",
        "javascript",
        "lua",
        "markdown",
        "markdown_inline",
        "python",
        "query",
        "toml",
        "typescript",
        "vim",
        "vimdoc",
        "json",
        "regex",
        "yaml",
      },
      sync_install = false,
      highlight = { enable = true },
      indent = { enable = true },
    })
  end,
}
