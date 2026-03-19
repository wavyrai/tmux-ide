import { execSync } from "node:child_process";

export async function ls({ json }: { json?: boolean } = {}): Promise<void> {
  let raw: string;
  try {
    raw = execSync(
      'tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}"',
      { encoding: "utf-8" },
    ).trim();
  } catch {
    if (json) {
      console.log(JSON.stringify({ sessions: [] }));
    } else {
      console.log("No tmux sessions running.");
    }
    return;
  }

  const sessions = raw.split("\n").map((line) => {
    const [name, created, attached] = line.split("|");
    return {
      name,
      created: new Date(parseInt(created!) * 1000).toISOString(),
      attached: attached !== "0",
    };
  });

  if (json) {
    console.log(JSON.stringify({ sessions }, null, 2));
    return;
  }

  // Table output
  console.log("SESSION".padEnd(24) + "CREATED".padEnd(22) + "ATTACHED");
  console.log("─".repeat(54));
  for (const s of sessions) {
    const date = new Date(s.created).toLocaleString();
    console.log(s.name!.padEnd(24) + date.padEnd(22) + (s.attached ? "yes" : "no"));
  }
}
