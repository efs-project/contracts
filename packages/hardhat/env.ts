export function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return value;
}

export function positiveIntEnvOr(name: string, fallback: number): number {
  const raw = envOr(name, String(fallback));
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer; got ${JSON.stringify(raw)}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer; got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function boolEnv(name: string): boolean {
  return process.env[name] === "true";
}

export function oneOfEnvOr<const T extends readonly [string, ...string[]]>(
  name: string,
  fallback: T[number],
  allowed: T,
): T[number] {
  const raw = envOr(name, fallback);
  if ((allowed as readonly string[]).includes(raw)) {
    return raw as T[number];
  }
  throw new Error(`${name} must be ${allowed.join(", ")}; got ${JSON.stringify(raw)}`);
}
