return {
  "ziontee113/icon-picker.nvim",
  config = function()
    require("icon-picker").setup({ disable_legacy_commands = true })

    vim.keymap.set("n", "<Leader><Leader>i", "<cmd>IconPickerNormal<cr>", {
      noremap = true,
      silent = true,
      desc = "Insert icon",
    })
    vim.keymap.set("n", "<Leader><Leader>y", "<cmd>IconPickerYank<cr>", {
      noremap = true,
      silent = true,
      desc = "Yank icon",
    })
  end,
}
