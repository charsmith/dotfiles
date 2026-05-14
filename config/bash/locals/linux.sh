export PATH="/opt/nvim-linux64/bin:$PATH"

# WezTerm CLI — only add if not already on PATH
if ! command -v wezterm &>/dev/null; then
  for _wez_dir in /usr/local/bin /usr/bin /opt/wezterm/bin "$HOME/.local/bin"; do
    if [[ -x "$_wez_dir/wezterm" ]]; then
      export PATH="$_wez_dir:$PATH"
      break
    fi
  done
  unset _wez_dir
fi
