#!/usr/bin/env bash
# Coloured echo helpers for the scripts/wsl-*.sh sync scripts (sourced, not run).

set +o histexpand

echo_red() { /bin/echo -e "\e[1;31m$*\e[0m"; }
echo_blue() { /bin/echo -e "\e[1;34m$*\e[0m"; }
echo_yellow() { /bin/echo -e "\e[1;33m$*\e[0m"; }
echo_green() { /bin/echo -e "\e[1;32m$*\e[0m"; }
echo_stderr_red() { >&2 echo_red "$@"; }
echo_stderr_yellow() { >&2 echo_yellow "$@"; }
