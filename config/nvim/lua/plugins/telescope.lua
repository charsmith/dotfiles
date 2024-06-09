return {
  {
    "nvim-telescope/telescope.nvim",
    tag = "0.1.6",
    dependencies = { "nvim-lua/plenary.nvim" },
    config = function()
      local builtin = require("telescope.builtin")
      vim.keymap.set("n", "<C-p>", builtin.find_files, {})
      vim.keymap.set("n", "<leader>ff", builtin.find_files, {})
      vim.keymap.set("n", "<leader>fg", builtin.live_grep, {})
    end,
  },
  {
    "nvim-telescope/telescope-ui-select.nvim",
    config = function()
      require("telescope").setup({
        extensions = {
          ["ui-select"] = {
            require("telescope.themes").get_dropdown({}),
          },
        },
      })
      require("telescope").load_extension("ui-select")
    end,
  },
  {
    "ThePrimeagen/git-worktree.nvim",
    config = function()
      require("git-worktree").setup()
      local telescope = require("telescope")
      telescope.load_extension("git_worktree")
      vim.keymap.set("n", "<leader>wt", "<CMD>lua require('telescope').extensions.git_worktree.git_worktrees()<CR>", {})
      vim.keymap.set("n", "<leader>ww", "<CMD>lua require('telescope').extensions.git_worktree.create_git_worktree()<CR>", {})
    end,
  },
}
