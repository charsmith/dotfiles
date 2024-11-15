return {
	{
		"williamboman/mason.nvim",
		config = function()
			require("mason").setup()
		end,
	},
	{
		"neovim/nvim-lspconfig",
		dependencies = {
			"williamboman/mason-lspconfig.nvim",
			{ "VonHeikemen/lsp-zero.nvim", branch = "v3.x" },
		},
		config = function()
			local lsp_zero = require("lsp-zero")
			lsp_zero.extend_lspconfig()

			lsp_zero.on_attach(function(client, bufnr)
				-- see :help lsp-zero-keybindings
				-- to learn the available actions
				lsp_zero.default_keymaps({ buffer = bufnr })
			end)
			vim.keymap.set({ "n", "v" }, "<leader>ca", vim.lsp.buf.code_action, {})

			require("mason-lspconfig").setup({
				ensure_installed = { "lua_ls", "pyright", "ruff", "biome" },
				handlers = {
					function(server_name)
						require("lspconfig")[server_name].setup({})
					end,
					pyright = function()
						require("lspconfig").pyright.setup({
							settings = {
								pyright = {
									-- Using Ruff's import organizer
									disableOrganizeImports = true,
								},

								python = {
									analysis = {
										-- Ignore all files for analysis to exclusively use Ruff for linting
										ignore = { "*" },
									},
								},
							},
						})
					end,
				},
			})
		end,
	},
	{
		"nvimtools/none-ls.nvim",
		config = function()
			local null_ls = require("null-ls")

			null_ls.setup({
				sources = {
					null_ls.builtins.formatting.stylua,
				},
			})

			vim.keymap.set("n", "<leader>gf", vim.lsp.buf.format, {})
		end,
	},
}
