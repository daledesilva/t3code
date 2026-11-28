import { NodeServices } from "@effect/platform-node";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { discoverProviderMcpServers, parseTomlMcpServers } from "./ProviderMcpDiscovery.ts";

describe("ProviderMcpDiscovery", () => {
  it("parses Codex TOML mcp_servers tables including disabled entries and skips t3-code", () => {
    const toml = `
model = "gpt-6-astra"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"

[mcp_servers."my-local-tool"]
command = "npx"
args = ["-y", "my-tool"]

[mcp_servers.paused]
command = "node"
enabled = false

[mcp_servers.t3-code]
url = "http://127.0.0.1:9999/mcp"
`;
    const servers = parseTomlMcpServers(toml, "provider", "~/.codex/config.toml");
    expect(servers).toEqual([
      {
        name: "linear",
        scope: "provider",
        status: "configured",
        source: "~/.codex/config.toml",
        transport: "http",
        enabled: true,
      },
      {
        name: "my-local-tool",
        scope: "provider",
        status: "configured",
        source: "~/.codex/config.toml",
        transport: "stdio",
        enabled: true,
      },
      {
        name: "paused",
        scope: "provider",
        status: "disabled",
        source: "~/.codex/config.toml",
        transport: "stdio",
        enabled: false,
      },
    ]);
  });

  it.effect("separates provider MCPs from repo MCPs for Claude", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-discovery-" });
      const home = path.join(root, "home");
      const repo = path.join(root, "repo");
      yield* fs.makeDirectory(path.join(home, ".claude"), { recursive: true });
      yield* fs.makeDirectory(repo, { recursive: true });

      yield* fs.writeFileString(
        path.join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            github: { type: "http", url: "https://api.githubcopilot.com/mcp" },
            "t3-code": { type: "http", url: "http://127.0.0.1/mcp" },
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(repo, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"] },
          },
        }),
      );

      const envLayer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcess.HomeDirectory, home),
        Layer.succeed(HostProcess.Platform, "darwin"),
      );

      const servers = yield* discoverProviderMcpServers({
        provider: {
          driver: ProviderDriverKind.make("claudeAgent"),
          runtimePaths: { homePath: path.join(home, ".claude"), shadowHomePath: null },
        },
        cwd: repo,
      }).pipe(Effect.provide(envLayer));

      expect(servers).toEqual([
        {
          name: "github",
          scope: "provider",
          status: "configured",
          source: "~/.claude.json",
          transport: "http",
          enabled: true,
        },
        {
          name: "postgres",
          scope: "repo",
          status: "configured",
          source: ".mcp.json",
          transport: "stdio",
          enabled: true,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
