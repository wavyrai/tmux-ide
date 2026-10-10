// Preserve shipped dependency license texts; this is not a legal approval policy.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, parse, basename } from "node:path";

export async function bridgeNotices(inputs) {
  const packages = new Map();
  for (const input of inputs) {
    const absolute = resolve(input);
    if (!absolute.split(/[\\/]/).includes("node_modules")) continue;
    let directory = dirname(absolute);
    let owner;
    while (directory !== parse(directory).root && basename(directory) !== "node_modules") {
      try {
        const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (metadata.name && metadata.version) {
          owner = { directory, metadata };
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = dirname(directory);
    }
    if (!owner) throw new Error(`Dependency has no package identity: ${input}`);
    packages.set(owner.directory, owner);
  }
  const components = [];
  for (const { directory, metadata } of packages.values()) {
    const files = (await readdir(directory))
      .filter((name) => /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(name))
      .sort();
    if (!files.length)
      throw new Error(`Missing dependency notice: ${metadata.name}@${metadata.version}`);
    const texts = await Promise.all(
      files.map(async (name) => ({ name, text: await readFile(join(directory, name), "utf8") })),
    );
    if (texts.some((item) => !item.text.trim()))
      throw new Error(`Empty dependency notice: ${metadata.name}`);
    components.push({
      name: metadata.name,
      version: metadata.version,
      license: metadata.license ?? null,
      texts,
    });
  }
  components.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  return {
    packages: components.map(({ name, version, license }) => ({ name, version, license })),
    text:
      "Third-party notices for the bundled tmux-ide GPUI JavaScript bridge\n\n" +
      components
        .map(
          (p) =>
            `${p.name}@${p.version}\nDeclared license: ${JSON.stringify(p.license)}\n\n` +
            p.texts.map((t) => `--- ${t.name} ---\n${t.text}\n`).join("\n"),
        )
        .join("\n====================\n\n"),
  };
}
