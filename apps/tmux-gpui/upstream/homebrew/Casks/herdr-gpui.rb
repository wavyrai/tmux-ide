cask "herdr-gpui" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/penso/herdr-gpui/releases/download/v#{version}/Herdr-#{version}-universal-apple-darwin.dmg"
  name "Herdr"
  desc "Native GUI client for an existing local Herdr daemon"
  homepage "https://github.com/penso/herdr-gpui"

  depends_on macos: :sonoma

  app "Herdr.app"
end
