// Structured JSON logs (docs/conventions.md -> Code style): no
// console.log/print outside this module.
type Level = "info" | "error";

function write(level: Level, msg: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields });
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  info: (msg: string, fields: Record<string, unknown> = {}) => write("info", msg, fields),
  error: (msg: string, fields: Record<string, unknown> = {}) => write("error", msg, fields),
};
