vim.api.nvim_create_autocmd({ "BufRead", "BufNewFile" }, {
  pattern = "*config/bash/*",
  command = "setfiletype bash",
})
