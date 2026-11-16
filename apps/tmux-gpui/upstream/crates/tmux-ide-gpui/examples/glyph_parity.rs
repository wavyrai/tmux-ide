//! Dev-only: the terminal painter's legacy and batched glyph paths must
//! render byte-identical screenshots. `cargo run -p tmux-ide-gpui --features
//! visual-capture --example glyph_parity -- <dir>`.
fn main() -> anyhow::Result<()> {
    let dir = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("usage: glyph_parity <dir>"))?;
    for line in tmux_ide_gpui::glyph_parity(&dir)? {
        println!("{line}");
    }
    Ok(())
}
