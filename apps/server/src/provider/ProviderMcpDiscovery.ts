import type {
  ProviderMcpServer,
  ProviderMcpServerScope,
  ProviderMcpServerTransport,
  ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const INTERNAL_T3_MCP_NAMES = new Set(["t3-code", "t3-code-direct"]);
const MAX_MCP_CONFIG_BYTES = 512_000;

type RawMcpEntry = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferTransport(entry: RawMcpEntry): ProviderMcpServerTransport | undefined {
  const rawType = typeof entry.type === "string" ? entry.type.toLowerCase().trim() : "";
  if (rawType === "stdio") return "stdio";
  if (rawType === "sse") return "sse";
  if (rawType === "http" || rawType === "streamable-http" || rawType === "remote") return "http";
  if (typeof entry.command === "string" || Array.isArray(entry.command)) return "stdio";
  if (
    typeof entry.url === "string" ||
    typeof entry.serverUrl === "string" ||
    typeof entry.httpUrl === "string"
  ) {
    return "http";
  }
  return undefined;
}

function isEnabled(entry: RawMcpEntry): boolean {
  if (entry.disabled === true) return false;
  if (entry.enabled === false) return false;
  return true;
}

function collectJsonMap(
  raw: unknown,
  scope: ProviderMcpServerScope,
  source: string,
): ProviderMcpServer[] {
  if (!isRecord(raw)) return [];
  const servers: ProviderMcpServer[] = [];
  for (const [rawName, value] of Object.entries(raw)) {
    const name = rawName.trim();
    if (name.length === 0 || INTERNAL_T3_MCP_NAMES.has(name) || !isRecord(value)) continue;
    const enabled = isEnabled(value);
    const transport = inferTransport(value);
    servers.push({
      name,
      scope,
      status: enabled ? "configured" : "disabled",
      source,
      ...(transport !== undefined ? { transport } : {}),
      enabled,
    });
  }
  return servers;
}

/** Parses `[mcp_servers.<name>]` or `[mcp_servers."<name>"]` sections from Codex TOML configs. */
export function parseTomlMcpServers(
  content: string,
  scope: ProviderMcpServerScope,
  source: string,
): ProviderMcpServer[] {
  const entries = new Map<string, { enabled: boolean; transport?: ProviderMcpServerTransport }>();
  let currentName: string | null = null;
  let inSubtable = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;

    const headerMatch = /^\[([^\]]+)\]$/.exec(line);
    if (headerMatch) {
      const header = headerMatch[1]!.trim();
      const mcpMatch = /^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^.\s]+))(?:\.(.+))?$/.exec(header);
      if (mcpMatch) {
        const name = (mcpMatch[1] ?? mcpMatch[2] ?? mcpMatch[3] ?? "").trim();
        if (name.length > 0 && !INTERNAL_T3_MCP_NAMES.has(name)) {
          currentName = name;
          inSubtable = mcpMatch[4] !== undefined;
          if (!entries.has(name)) {
            entries.set(name, { enabled: true });
          }
          continue;
        }
      }
      currentName = null;
      inSubtable = false;
      continue;
    }

    if (currentName === null || inSubtable) continue;
    const entry = entries.get(currentName);
    if (!entry) continue;

    const kvMatch = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1]!;
    const value = kvMatch[2]!.trim();
    if (key === "enabled" && value === "false") {
      entry.enabled = false;
    } else if (key === "disabled" && value === "true") {
      entry.enabled = false;
    } else if (key === "command") {
      entry.transport = "stdio";
    } else if (key === "url" || key === "http_url") {
      entry.transport = "http";
    }
  }

  return Array.from(entries.entries()).map(([name, info]) => ({
    name,
    scope,
    status: info.enabled ? "configured" : "disabled",
    source,
    ...(info.transport !== undefined ? { transport: info.transport } : {}),
    enabled: info.enabled,
  }));
}

const readTextFileBounded = Effect.fnUntraced(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const stat = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (stat === null || stat.type !== "File" || Number(stat.size) > MAX_MCP_CONFIG_BYTES) {
    return null;
  }
  return yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));
});

const readJsonFile = Effect.fnUntraced(function* (filePath: string) {
  const text = yield* readTextFileBounded(filePath);
  if (text === null || text.trim().length === 0) return null;
  const parsed = decodeUnknownJson(text);
  return Option.isSome(parsed) && isRecord(parsed.value) ? parsed.value : null;
});

function claudeManagedMcpPath(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-mcp.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-mcp.json";
  return "/etc/claude-code/managed-mcp.json";
}

function dedupeAndSort(
  servers: ReadonlyArray<ProviderMcpServer>,
): ReadonlyArray<ProviderMcpServer> {
  const seen = new Map<string, ProviderMcpServer>();
  for (const server of servers) {
    const key = `${server.scope}:${server.name}`;
    if (!seen.has(key)) seen.set(key, server);
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "provider" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export const discoverProviderMcpServers = Effect.fn("ProviderMcpDiscovery.discover")(
  function* (input: {
    readonly provider: Pick<ServerProvider, "driver" | "runtimePaths"> | null;
    readonly cwd?: string | undefined;
  }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const collected: ProviderMcpServer[] = [];

    const provider = input.provider;
    const cwd = input.cwd?.trim() || undefined;

    if (provider !== null) {
      const providerHome = provider.runtimePaths?.homePath;

      switch (provider.driver) {
        case "claudeAgent": {
          const managed = yield* readJsonFile(claudeManagedMcpPath(platform));
          if (managed) {
            collected.push(...collectJsonMap(managed.mcpServers, "provider", "managed-mcp.json"));
          }

          const claudeHome = providerHome ?? path.join(home, ".claude");
          const settingsJson = yield* readJsonFile(path.join(claudeHome, "settings.json"));
          if (settingsJson) {
            collected.push(
              ...collectJsonMap(settingsJson.mcpServers, "provider", "~/.claude/settings.json"),
            );
          }

          const claudeJson = yield* readJsonFile(path.join(home, ".claude.json"));
          if (claudeJson) {
            collected.push(...collectJsonMap(claudeJson.mcpServers, "provider", "~/.claude.json"));
            if (cwd && isRecord(claudeJson.projects)) {
              const projectEntry = claudeJson.projects[cwd];
              if (isRecord(projectEntry)) {
                collected.push(
                  ...collectJsonMap(projectEntry.mcpServers, "repo", "~/.claude.json (project)"),
                );
              }
            }
          }
          break;
        }

        case "codex": {
          const codexHome = providerHome ?? path.join(home, ".codex");
          const toml = yield* readTextFileBounded(path.join(codexHome, "config.toml"));
          if (toml !== null) {
            collected.push(...parseTomlMcpServers(toml, "provider", "~/.codex/config.toml"));
          }
          break;
        }

        case "antigravity": {
          const candidates: Array<{ filePath: string; source: string }> = [];
          if (providerHome) {
            candidates.push({
              filePath: path.join(providerHome, "config", "mcp_config.json"),
              source: "mcp_config.json",
            });
          }
          candidates.push(
            {
              filePath: path.join(home, ".gemini", "antigravity", "mcp_config.json"),
              source: "~/.gemini/antigravity/mcp_config.json",
            },
            {
              filePath: path.join(home, ".gemini", "settings.json"),
              source: "~/.gemini/settings.json",
            },
          );
          for (const candidate of candidates) {
            const json = yield* readJsonFile(candidate.filePath);
            if (json) {
              collected.push(...collectJsonMap(json.mcpServers, "provider", candidate.source));
            }
          }
          break;
        }

        case "cursor": {
          const cursorJson = yield* readJsonFile(path.join(home, ".cursor", "mcp.json"));
          if (cursorJson) {
            collected.push(
              ...collectJsonMap(cursorJson.mcpServers, "provider", "~/.cursor/mcp.json"),
            );
          }
          break;
        }

        case "opencode": {
          const openCodeJson = yield* readJsonFile(
            path.join(home, ".config", "opencode", "opencode.json"),
          );
          if (openCodeJson) {
            collected.push(
              ...collectJsonMap(openCodeJson.mcp, "provider", "~/.config/opencode/opencode.json"),
            );
          }
          break;
        }

        case "kiro": {
          const kiroJson = yield* readJsonFile(path.join(home, ".kiro", "settings", "mcp.json"));
          if (kiroJson) {
            collected.push(
              ...collectJsonMap(kiroJson.mcpServers, "provider", "~/.kiro/settings/mcp.json"),
            );
          }
          break;
        }

        default:
          break;
      }
    }

    if (cwd) {
      const repoJsonConfigs: Array<{ rel: string; key: "mcpServers" | "mcp" }> = [
        { rel: ".mcp.json", key: "mcpServers" },
        { rel: ".cursor/mcp.json", key: "mcpServers" },
        { rel: "opencode.json", key: "mcp" },
        { rel: ".kiro/settings/mcp.json", key: "mcpServers" },
        { rel: ".gemini/settings.json", key: "mcpServers" },
      ];
      for (const cfg of repoJsonConfigs) {
        const json = yield* readJsonFile(path.join(cwd, cfg.rel));
        if (json) {
          collected.push(...collectJsonMap(json[cfg.key], "repo", cfg.rel));
        }
      }
      const repoCodexToml = yield* readTextFileBounded(path.join(cwd, ".codex", "config.toml"));
      if (repoCodexToml !== null) {
        collected.push(...parseTomlMcpServers(repoCodexToml, "repo", ".codex/config.toml"));
      }
    }

    return dedupeAndSort(collected);
  },
);
