import type { EnvironmentId, ProviderInstanceId, ProviderMcpServer } from "@t3tools/contracts";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

export interface ProviderMcpServersTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string | null;
}

const NO_MCP_SERVERS: ReadonlyArray<ProviderMcpServer> = [];

export function providerMcpServersTarget(
  environmentId: EnvironmentId | null,
  instanceId: ProviderInstanceId | null | undefined,
  cwd: string | null,
): ProviderMcpServersTarget | null {
  return environmentId && instanceId ? { environmentId, instanceId, cwd } : null;
}

export function useProviderMcpServers(
  target: ProviderMcpServersTarget | null,
): ReadonlyArray<ProviderMcpServer> {
  const { data } = useEnvironmentQuery(
    target === null
      ? null
      : serverEnvironment.providerMcpServers({
          environmentId: target.environmentId,
          input: {
            instanceId: target.instanceId,
            ...(target.cwd ? { cwd: target.cwd } : {}),
          },
        }),
  );
  return data?.servers ?? NO_MCP_SERVERS;
}
