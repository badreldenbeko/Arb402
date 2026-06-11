// minimal ANSI output helpers — no external dependency
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code: string, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  bold: (s: string) => wrap("1", s),
  dim: (s: string) => wrap("2", s),
  red: (s: string) => wrap("31", s),
  green: (s: string) => wrap("32", s),
  yellow: (s: string) => wrap("33", s),
  cyan: (s: string) => wrap("36", s),
};

export function ok(msg: string): void {
  console.log(`${c.green("✓")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${c.yellow("!")} ${msg}`);
}

export function fail(msg: string): void {
  console.error(`${c.red("✗")} ${msg}`);
}

export function info(msg: string): void {
  console.log(`${c.cyan("›")} ${msg}`);
}

export function heading(msg: string): void {
  console.log(`\n${c.bold(msg)}`);
}

// "  label  value" aligned on label width
export function row(label: string, value: string, width = 18): void {
  console.log(`  ${c.dim(label.padEnd(width))} ${value}`);
}

// abort the CLI with a red message and non-zero exit
export function die(msg: string): never {
  fail(msg);
  process.exit(1);
}
