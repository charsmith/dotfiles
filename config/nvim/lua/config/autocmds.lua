vim.api.nvim_create_autocmd({ "BufRead", "BufNewFile" }, {
  pattern = "*config/bash/*",
  command = "setfiletype bash",
})

vim.api.nvim_create_autocmd("LspAttach", {
  group = vim.api.nvim_create_augroup("lsp", { clear = true }),
  callback = function(args)
    vim.api.nvim_create_autocmd("BufWritePre", {
      buffer = args.buf,
      callback = function()
        vim.lsp.buf.format({ async = false })
      end,
    })
  end,
})
