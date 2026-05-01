// notify.ts – desktop notification support (mirrors internal/notify/notify.go)
import { spawnSync } from "child_process";

const MAX_FIELD_BYTES = 1024;

/** Strip control chars and cap length so branch names cannot inject escape sequences. */
function sanitizeField(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || ch === "\t" || ch === " ") {
      out += " ";
    } else if (cp < 0x20 || cp === 0x7f) {
      out += "?";
    } else {
      out += ch;
    }
  }
  // Truncate to MAX_FIELD_BYTES on a valid UTF-8 boundary
  const buf = Buffer.from(out, "utf8");
  if (buf.length > MAX_FIELD_BYTES) {
    out = buf.slice(0, MAX_FIELD_BYTES).toString("utf8").replace(/\uFFFD$/, "");
  }
  return out;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function runCommand(cmd: string, args: string[]): boolean {
  const result = spawnSync(cmd, args, { stdio: "ignore" });
  return result.status === 0;
}

export function send(title: string, message: string): boolean {
  const t = sanitizeField(title);
  const m = sanitizeField(message);
  const platform = process.platform;

  if (platform === "darwin") {
    const script = `display notification ${JSON.stringify(m)} with title ${JSON.stringify(t)}`;
    return runCommand("osascript", ["-e", script]);
  } else if (platform === "linux") {
    return runCommand("notify-send", ["--", t, m]);
  }
  return false;
}
