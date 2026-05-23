# Neovim: asset/dir name is arch-specific since v0.10.4
case "$(uname -m)" in
  x86_64)  _nvim_dir="/opt/nvim-linux-x86_64" ;;
  aarch64) _nvim_dir="/opt/nvim-linux-arm64"  ;;
  *)       _nvim_dir="/opt/nvim-linux64"       ;; # legacy fallback
esac
[[ -d "$_nvim_dir/bin" ]] && export PATH="$_nvim_dir/bin:$PATH"
unset _nvim_dir

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
