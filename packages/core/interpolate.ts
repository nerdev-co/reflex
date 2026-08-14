// Template interpolation — ADR-09: the trace stores *resolved* values, and
// replay is deterministic, because this resolver runs before every perform.
//
// Supported templates (see docs/04-execution-engine.md):
//   {{trigger.payload.title}}        → root = the run's trigger payload
//   {{steps.1.output.name}}          → root = step 1's recorded output
//   {{steps.1.config.foo}}           → root = step 1's config snapshot

export interface InterpolateContext {
  trigger: unknown;
  steps: Record<number, { output?: unknown; config?: unknown }>;
}

function dig(root: unknown, path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function resolveTemplate(template: string, ctx: InterpolateContext): unknown {
  const m = /^\{\{\s*(.*?)\s*\}\}$/.exec(template);
  if (!m) return template;

  const [scope, ...rest] = m[1]!.split(".");
  if (scope === "trigger") return dig(ctx.trigger, rest);
  if (scope === "steps") {
    const idx = Number(rest[0]);
    const step = ctx.steps[idx];
    if (!step) return undefined;
    return dig(step, rest.slice(1));
  }
  return undefined;
}

/** Deep-walk a config object, resolving every string template in place. */
export function interpolateConfig(config: unknown, ctx: InterpolateContext): unknown {
  if (typeof config === "string") {
    return resolveTemplate(config, ctx);
  }
  if (Array.isArray(config)) {
    return config.map((item) => interpolateConfig(item, ctx));
  }
  if (config && typeof config === "object") {
    return Object.fromEntries(
      Object.entries(config as Record<string, unknown>).map(([key, value]) => [key, interpolateConfig(value, ctx)]),
    );
  }
  return config;
}
