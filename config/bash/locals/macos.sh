# Store secrets in macOS Keychain with:
#   security add-generic-password -a "$USER" -s "MY_SECRET_NAME" -w "mysecretvalue"
# Then load them at shell startup with set_secret_env.
set_secret_env() {
  local name="$1"
  local value
  if value="$(security find-generic-password -a "$USER" -s "$name" -w 2>/dev/null)"; then
    export "$name=$value"
  else
    echo "set_secret_env: no keychain entry for '$name', skipping." >&2
  fi
}
set_secret_env SLACK_TOKEN

# WezTerm CLI (lives inside the macOS app bundle)
[[ -d "/Applications/WezTerm.app/Contents/MacOS" ]] && export PATH="/Applications/WezTerm.app/Contents/MacOS:$PATH"
