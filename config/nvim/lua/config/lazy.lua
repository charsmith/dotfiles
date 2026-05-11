local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable", -- latest stable release
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

require("lazy").setup("plugins", {
  -- Default to eager load; plugins that should defer set `event`, `cmd`,
  -- `keys`, or `ft` in their own spec (which implicitly lazy-loads them).
  defaults = { lazy = false },
  ui = {
    border = "rounded",
  },
  checker = { enabled = false, notify = true },
  debug = false,
  change_detection = {
    notify = false,
  },
})
