return {
  "folke/which-key.nvim",
  event = "VeryLazy",
  opts = {
    preset = "modern",
    delay = 300,
    -- Group names for leader-prefixed keys. which-key picks up `desc` on
    -- individual mappings; these just label the prefix categories.
    spec = {
      { "<leader>f", group = "find" },
      { "<leader>g", group = "git / format" },
      { "<leader>c", group = "code" },
      { "<leader>t", group = "test" },
      { "<leader>w", group = "worktree" },
      { "<leader>x", group = "diagnostics / trouble" },
      { "<leader><leader>", group = "extras" },
    },
  },
  keys = {
    {
      "<leader>?",
      function()
        require("which-key").show({ global = false })
      end,
      desc = "Buffer keymaps (which-key)",
    },
  },
}
