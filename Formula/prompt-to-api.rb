# typed: false
# frozen_string_literal: true

class PromptToApi < Formula
  desc "OpenAI-compatible REST gateway for local single-prompt / print-mode AI CLIs"
  homepage "https://github.com/tariqwest/prompt-to-api"
  url "https://github.com/tariqwest/prompt-to-api/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"
  head "https://github.com/tariqwest/prompt-to-api.git", branch: "main"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  service do
    run [opt_bin/"prompt-to-api"]
    keep_alive true
    working_dir var/"prompt-to-api"
    environment_variables PROMPT_TO_API_HOST: "127.0.0.1", PROMPT_TO_API_PORT: "8788"
    log_path var/"log/prompt-to-api.log"
    error_log_path var/"log/prompt-to-api.error.log"
  end

  test do
    assert_match "prompt-to-api", shell_output("#{bin}/prompt-to-api help")
  end
end
