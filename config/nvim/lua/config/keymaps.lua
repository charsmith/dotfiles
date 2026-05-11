-- Global keymaps. Plugin-specific keymaps live alongside their plugin spec.

local map = vim.keymap.set

-- Clear search highlights
map("n", "<leader>h", '<cmd>let @/ = ""<CR>', { silent = true, desc = "Clear search highlight" })

-- Diagnostics navigation
map("n", "[d", vim.diagnostic.goto_prev, { desc = "Previous diagnostic" })
map("n", "]d", vim.diagnostic.goto_next, { desc = "Next diagnostic" })
map("n", "<leader>cd", vim.diagnostic.open_float, { desc = "Line diagnostics" })
map("n", "<leader>cq", vim.diagnostic.setloclist, { desc = "Diagnostics to loclist" })

-- Quick save / quit. Avoid <leader>w (used by worktree).
map("n", "<leader>s", "<cmd>w<CR>", { desc = "Save buffer" })
map("n", "<leader>q", "<cmd>confirm q<CR>", { desc = "Quit window" })

-- Better up/down on wrapped lines
map({ "n", "x" }, "j", "v:count == 0 ? 'gj' : 'j'", { expr = true, silent = true })
map({ "n", "x" }, "k", "v:count == 0 ? 'gk' : 'k'", { expr = true, silent = true })
