-- LSP progress notifications in the bottom-right corner.
return {
  "j-hui/fidget.nvim",
  event = "LspAttach",
  opts = {
    notification = {
      window = {
        winblend = 0,
      },
    },
    progress = {
      display = {
        done_icon = "✓",
      },
    },
  },
}
