# Locate a bun binary. Hooks can run with a trimmed PATH that misses the
# shell-profile additions where bun usually installs itself.
find_bun() {
  if [ -n "${CLAUC_BUN:-}" ] && [ -x "${CLAUC_BUN}" ]; then
    echo "${CLAUC_BUN}"
    return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  for candidate in "$HOME/.bun/bin/bun" "/usr/local/bin/bun" "/opt/homebrew/bin/bun"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}
