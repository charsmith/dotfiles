return {
  "nvim-treesitter/nvim-treesitter",
  branch = "main",
  lazy = false,
  build = ":TSUpdate",
  config = function()
    require("nvim-treesitter").install({
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
    })
  end,
}
