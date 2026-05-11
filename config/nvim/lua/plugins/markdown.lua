-- In-buffer markdown rendering: heading backgrounds, framed code blocks,
-- bullets/checkboxes/tables. Auto-renders in normal mode; reverts to raw
-- text in insert/visual or when the cursor is on the line being styled.
return {
  "MeanderingProgrammer/render-markdown.nvim",
  dependencies = {
    "nvim-treesitter/nvim-treesitter",
    "nvim-tree/nvim-web-devicons",
  },
  ft = { "markdown" },
  opts = {
    completions = { lsp = { enabled = true } },
    code = {
      sign = false,
      width = "block",
      right_pad = 1,
    },
    heading = {
      sign = false,
      icons = { "󰲡 ", "󰲣 ", "󰲥 ", "󰲧 ", "󰲩 ", "󰲫 " },
    },
    checkbox = {
      unchecked = { icon = "󰄱 " },
      checked = { icon = "󰱒 " },
    },
  },
  keys = {
    { "<leader>cm", "<cmd>RenderMarkdown toggle<cr>", desc = "Toggle markdown render" },
  },
}
