/** Apply qualified-release defaults before loading native code or the renderer. */
export function configureNativeScrollRuntime({ release, platform, glibc, env }) {
  const fallback = release && platform === "linux" && !glibc;
  if (release && !fallback) {
    env.TMUX_IDE_NATIVE_SCROLL_PROTOTYPE ??= "1";
    env.TMUX_IDE_FRAME_OUTPUT ??= "1";
  }
  return Object.freeze({
    useNative: !fallback,
    renderer: fallback
      ? "stock-musl-fallback"
      : release
        ? "qualified-native-scroll"
        : "experimental-native-scroll",
  });
}
