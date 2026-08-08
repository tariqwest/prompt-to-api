# typed: false
# frozen_string_literal: true

class PromptToApi < Formula
  desc "OpenAI-compatible REST gateway for local single-prompt / print-mode AI CLIs"
  homepage "https://github.com/tariqwest/prompt-to-api#readme"
  url "https://github.com/tariqwest/prompt-to-api/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "0dec3989ea4028fbd5454b67088b1f3936327dd8d4d9a20b45eefde088aacd68"
  license "MIT"
  head "https://github.com/tariqwest/prompt-to-api.git", branch: "main"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
  end

  service do
    run [opt_bin/"prompt-to-api"]
    keep_alive true
    require_root false
    log_path var/"log/prompt-to-api.log"
    error_log_path var/"log/prompt-to-api.error.log"
    working_dir HOMEBREW_PREFIX
    environment_variables PROMPT_TO_API_HOST: "127.0.0.1", PROMPT_TO_API_PORT: "8788"
  end

  def caveats
    <<~EOS
      prompt-to-api is an OpenAI-compatible REST gateway for local single-prompt AI CLIs.

      Start the server:

        #{bin}/prompt-to-api

      Or run it as a managed service with Homebrew services:

        brew services start prompt-to-api
        brew services stop prompt-to-api
        brew services restart prompt-to-api

      Defaults to http://127.0.0.1:8788. Useful env vars:

        PROMPT_TO_API_HOST
        PROMPT_TO_API_PORT
        PROMPT_TO_API_TOKEN
        PROMPT_TO_API_CWD
        PROMPT_TO_API_TRUSTED
        PROMPT_TO_API_TIMEOUT_MS

      Install one or more supported CLIs on PATH (claude, codex, opencode, fm, ...).
      Prefer Bun when available; Node uses the bundled tsx loader.
    EOS
  end

  test do
    assert_path_exists bin/"prompt-to-api"
    pkg_json = libexec/"lib/node_modules/prompt-to-api/package.json"
    assert_path_exists pkg_json
    assert_match version.to_s, pkg_json.read
  end
end
