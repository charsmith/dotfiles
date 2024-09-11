return {
  "nvim-neo-tree/neo-tree.nvim",
  branch = "v3.x",
  dependencies = {
    "nvim-lua/plenary.nvim",
    "nvim-tree/nvim-web-devicons", -- not strictly required, but recommended
    "MunifTanjim/nui.nvim",
  },
  config = function()
    vim.keymap.set("n", "<leader>E", "<cmd>Neotree toggle<CR>", { silent = true })
    vim.keymap.set("n", "<leader>e", "<cmd>Neotree toggle reveal<CR>", { silent = true })
    vim.keymap.set("n", "<leader>r", "<cmd>Neotree reveal<CR>", { silent = true })
    require("neo-tree").setup({
      auto_clean_after_session_restore = true,
    })
  end,
}
